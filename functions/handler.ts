// Marginalia — Edge Function handler.
//
// Routing uses the `action` query parameter rather than pathname subroutes:
// the Sites Gateway replaces the function-name segment with the upstream name
// and only guarantees the suffix/query are preserved, so the pathname this
// handler receives must not be assumed to contain the logical name "app".
//
// Security boundaries enforced here:
//   - QODER_PAT is read only inside this Function and is never returned,
//     logged, or reduced to a digest. Only a boolean presence flag is exposed.
//   - Upstream Cloud Agents payloads are never relayed. Each endpoint projects
//     an explicit allowlist of fields it needs.
//   - On failure only the client's safe `error.code` and its random
//     `diagnosticId` are returned; raw exceptions and messages are dropped.
//   - This is not a generic authenticated proxy. There are exactly two upstream
//     destinations, both fixed server-side constants (Qoder Cloud Agents, and
//     export.arxiv.org for paper import), neither selectable by a caller, and
//     the set of actions is a closed allowlist. Only the QCA destination is ever
//     given a credential; the arXiv fetch carries none.

import { CloudAgentsError, createCloudAgentsClient } from "./cloud-agents.mjs";
import { CLOUD_AGENTS_ORIGIN } from "./ai-config.ts";
import { bindingState } from "./binding.ts";
import { explain } from "./explain.ts";
import { fetchPaper } from "./arxiv.ts";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extraHeaders } });
}

/** Presence only. Never returns, logs, or hashes the token value. */
function patPresent(): boolean {
  try {
    const token = Deno.env.get("QODER_PAT");
    return typeof token === "string" && token.trim().length > 0;
  } catch {
    // Reading env can fail when the permission is absent; that is "not present".
    return false;
  }
}

/**
 * Credential-free connectivity check. Preserves the starter's documented
 * smoke-test contract: GET /functions/v1/app?name=Visitor
 */
function ping(url: URL): Response {
  const name = url.searchParams.get("name")?.trim() ?? "Visitor";
  if (!name || name.length > 80) {
    return json({ ok: false, error: "invalid_name" }, 400);
  }
  return json({ ok: true, message: `Hello, ${name}!` });
}

/**
 * Minimal QCA reachability probe.
 *
 * Calls only GET /api/v1/cloud/models. This deliberately avoids creating an
 * Agent, Environment or Session, and avoids ensureCloudResources (which
 * requires an application-owned durable coordinator backed by private state).
 * It is therefore the cheapest possible test of two independent unknowns:
 *   1. was the platform Secret QODER_PAT actually provisioned?
 *   2. is the Cloud Agents upstream reachable and does it accept that token?
 *
 * The returned error codes discriminate the failure modes precisely:
 *   service_not_configured -> PAT absent (backend not enabled / not synced)
 *   ai_not_configured      -> client could not read a usable token
 *   ai_access_denied       -> token present but rejected (401/403)
 *   ai_rate_limited        -> token works, upstream throttling (429)
 *   ai_service_unavailable -> upstream/transport failure (5xx, dns, tls)
 */
async function probeModels(): Promise<Response> {
  if (!patPresent()) {
    return json(
      {
        ok: false,
        error: "service_not_configured",
        detail: "qoder_pat_absent",
        pat_present: false,
      },
      503,
    );
  }

  let client: ReturnType<typeof createCloudAgentsClient>;
  try {
    client = createCloudAgentsClient({ origin: CLOUD_AGENTS_ORIGIN });
  } catch {
    // ai_configuration_invalid: the origin constant is malformed. Config bug,
    // not an upstream problem. Do not echo the origin back.
    return json({ ok: false, error: "ai_configuration_invalid", pat_present: true }, 503);
  }

  try {
    const result = await client.request("/api/v1/cloud/models");

    // List responses are documented as { data, has_more, next_page }; tolerate a
    // bare array as well rather than failing on an unverified shape.
    const rows: unknown = Array.isArray(result)
      ? result
      : Array.isArray((result as { data?: unknown } | null)?.data)
        ? (result as { data: unknown[] }).data
        : null;

    if (!Array.isArray(rows)) {
      return json(
        { ok: false, error: "ai_response_invalid", detail: "unrecognized_list_shape", pat_present: true },
        502,
      );
    }

    // Project an explicit allowlist. Never forward arbitrary upstream fields.
    const models: Array<{ id: string }> = [];
    for (const row of rows.slice(0, 50)) {
      const record = row as { id?: unknown } | null;
      if (record && typeof record.id === "string" && record.id.length > 0 && record.id.length <= 120) {
        models.push({ id: record.id });
      }
    }

    return json({
      ok: true,
      probe: "models",
      pat_present: true,
      upstream_reachable: true,
      model_count: models.length,
      models,
    });
  } catch (error) {
    if (error instanceof CloudAgentsError) {
      const failure = error as CloudAgentsError & { diagnosticId?: string };
      const status = Number.isInteger(failure.status) && failure.status >= 400 && failure.status <= 599
        ? failure.status
        : 503;
      return json(
        {
          ok: false,
          error: failure.code,
          pat_present: true,
          // Correlation only. This does not authorize relaying the raw error.
          ...(typeof failure.diagnosticId === "string" ? { diagnosticId: failure.diagnosticId } : {}),
        },
        status,
      );
    }
    // Unknown failure: classify locally, leak nothing.
    return json({ ok: false, error: "probe_failed", pat_present: true }, 503);
  }
}

export async function handler(request: Request): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return json({ ok: false, error: "invalid_request" }, 400);
  }

  const action = url.searchParams.get("action")?.trim() ?? "";
  const method = request.method;

  const wrongMethod = (allow: string) =>
    json({ ok: false, error: "method_not_allowed" }, 405, { Allow: allow });

  // --- Read-only actions. GET must not mutate state: the models probe creates
  // --- no Cloud resource, and ai-status only reports the current cache without
  // --- triggering resolution (resolution can create resources, so it is
  // --- reachable only from the explain POST below).
  if (action === "" || action === "ping") {
    return method === "GET" ? ping(url) : wrongMethod("GET");
  }
  if (action === "probe-models") {
    return method === "GET" ? await probeModels() : wrongMethod("GET");
  }
  if (action === "ai-status") {
    if (method !== "GET") return wrongMethod("GET");
    // Booleans and a state keyword only. No resource ids, no upstream payload.
    const state = bindingState();
    return json({ ok: true, pat_present: patPresent(), binding: state.kind });
  }
  if (action === "fetch-paper") {
    // A pure read of public arXiv content. It creates no Cloud resource and
    // reads no Secret, so it belongs on GET and must not mutate anything.
    return method === "GET" ? await fetchPaper(request, url) : wrongMethod("GET");
  }

  // --- The product's only mutating route.
  if (action === "explain") {
    return method === "POST" ? await explain(request) : wrongMethod("POST");
  }

  // Unknown paths must not all return success.
  return json({ ok: false, error: "route_not_found" }, 404);
}
