/**
 * Lazy resolution of the site's single Agent/Environment binding.
 *
 * Resolution is triggered only by an authorized `explain` POST — never by a GET,
 * a page load, or a status read, because it can create Cloud resources and GET
 * must not mutate state.
 *
 * The binding is fixed server-side configuration: name, model, system
 * instructions and scope all come from `ai-config.ts`. A visitor can influence
 * none of them, and the resolved ids are never returned to the browser.
 */

import { CloudAgentsError, createCloudAgentsClient, ensureCloudResources } from "./cloud-agents.mjs";
import {
  AGENT_METADATA,
  AGENT_MODEL,
  AGENT_NAME,
  AGENT_SYSTEM,
  APPLICATION_SCOPE,
  CLOUD_AGENTS_ORIGIN,
  ENVIRONMENT_METADATA,
  ENVIRONMENT_NAME,
} from "./ai-config.ts";

export interface Binding {
  agent: { type: "agent"; id: string; version: number };
  environment_id: string;
}

export type BindingState =
  | { kind: "unresolved" }
  | { kind: "resolving" }
  | { kind: "ready" }
  | { kind: "failed"; code: string };

/** Presence only. Never returns, logs, or hashes the token value. */
export function patPresent(): boolean {
  try {
    const token = Deno.env.get("QODER_PAT");
    return typeof token === "string" && token.trim().length > 0;
  } catch {
    // Reading env can fail when the permission is absent; that is "not present".
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Single-isolate coordinator                                          */
/* ------------------------------------------------------------------ */

/**
 * `ensureCloudResources` asks for a durable, cross-instance, fenced coordinator.
 * This is a process-local Map, which the platform docs correctly call "only a
 * cache". See the residual-risk note in `ai-config.ts`: the Agent is protected
 * by a deterministic Idempotency-Key, and a duplicate Environment is detected
 * and refused as `ai_initialization_conflict` rather than silently chosen.
 *
 * The single-flight promise in `resolveBinding` keeps concurrent requests inside
 * one isolate from entering this path more than once at all.
 */
function createCacheCoordinator() {
  const store = new Map<string, unknown>();
  const queues = new Map<string, Promise<unknown>>();

  interface Lease {
    read: () => Promise<unknown>;
    write: (value: unknown) => Promise<void>;
    assertHeld: () => Promise<void>;
  }

  return {
    async withLock(key: string, callback: (lease: Lease) => Promise<unknown>): Promise<unknown> {
      const previous = queues.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      queues.set(
        key,
        previous.then(
          () => gate,
          () => gate,
        ),
      );
      await previous.catch(() => {});

      let held = true;
      try {
        return await callback({
          read: async () => store.get(key),
          write: async (value: unknown) => {
            if (!held) throw new Error("lease_lost");
            store.set(key, value);
          },
          assertHeld: async () => {
            if (!held) throw new Error("lease_lost");
          },
        });
      } finally {
        held = false;
        release();
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

let inflight: Promise<Binding> | null = null;
let resolved: Binding | null = null;
let failure: string | null = null;

/** Pure read for the status route. Never triggers resolution. */
export function bindingState(): BindingState {
  if (resolved) return { kind: "ready" };
  if (failure) return { kind: "failed", code: failure };
  if (inflight) return { kind: "resolving" };
  return { kind: "unresolved" };
}

export class BindingError extends Error {
  readonly code: string;
  readonly status: number;
  readonly diagnosticId?: string;

  constructor(code: string, status = 503, diagnosticId?: string) {
    super(code);
    this.name = "BindingError";
    this.code = code;
    this.status = status;
    this.diagnosticId = diagnosticId;
  }
}

function classify(error: unknown): BindingError {
  if (error instanceof CloudAgentsError) {
    const failure = error as CloudAgentsError & { diagnosticId?: string };
    const status =
      Number.isInteger(failure.status) && failure.status >= 400 && failure.status <= 599 ? failure.status : 503;
    return new BindingError(failure.code, status, typeof failure.diagnosticId === "string" ? failure.diagnosticId : undefined);
  }
  // Unknown failures are classified locally; nothing upstream is leaked.
  return new BindingError("ai_initialization_failed", 503);
}

async function resolve(): Promise<Binding> {
  if (!patPresent()) {
    throw new BindingError("service_not_configured", 503);
  }

  let client: ReturnType<typeof createCloudAgentsClient>;
  try {
    client = createCloudAgentsClient({ origin: CLOUD_AGENTS_ORIGIN, timeoutMs: 20000 });
  } catch {
    // The origin constant is malformed. A configuration bug, not an upstream
    // problem; never echo the origin back.
    throw new BindingError("ai_configuration_invalid", 503);
  }

  const binding = (await ensureCloudResources({
    client,
    coordinator: createCacheCoordinator(),
    applicationScope: APPLICATION_SCOPE,
    agent: {
      name: AGENT_NAME,
      model: AGENT_MODEL,
      system: AGENT_SYSTEM,
      metadata: AGENT_METADATA,
    },
    environment: {
      name: ENVIRONMENT_NAME,
      config: { type: "cloud" },
      metadata: ENVIRONMENT_METADATA,
    },
  })) as Binding;

  if (
    !/^agent_[A-Za-z0-9_-]+$/.test(binding?.agent?.id ?? "") ||
    !/^env_[A-Za-z0-9_-]+$/.test(binding?.environment_id ?? "") ||
    !Number.isInteger(binding?.agent?.version) ||
    binding.agent.version < 1
  ) {
    throw new BindingError("ai_response_invalid", 502);
  }

  return binding;
}

/**
 * Returns the site's binding, resolving it at most once per isolate.
 * A failed resolution clears the cache so a later request may retry; it never
 * caches a failure as if it were an answer.
 */
export function resolveBinding(): Promise<Binding> {
  if (resolved) return Promise.resolve(resolved);
  if (inflight) return inflight;

  failure = null;
  inflight = resolve().then(
    (binding) => {
      resolved = binding;
      inflight = null;
      return binding;
    },
    (error: unknown) => {
      inflight = null;
      failure = error instanceof BindingError ? error.code : "ai_initialization_failed";
      throw error instanceof BindingError ? error : classify(error);
    },
  );
  return inflight;
}
