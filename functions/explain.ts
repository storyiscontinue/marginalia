/**
 * POST ?action=explain — the product's only AI route.
 *
 * Shape of the contract
 * ---------------------
 * Reader selects English text in the browser -> same-origin POST -> this
 * Function authenticates upstream with the platform's QODER_PAT -> Qoder Cloud
 * Agents -> a Chinese explanation projected back as `{ ok, answer, term? }`.
 *
 * Each request gets its OWN Session, used once and abandoned. Sessions are never
 * shared between readers and never reused across requests, which is what makes
 * per-reader isolation hold without a server-side conversation store. The
 * reader's annotation history lives in their own localStorage.
 *
 * What is deliberately NOT here
 * -----------------------------
 * - No generic proxy: the upstream origin is a fixed constant and the action set
 *   is a closed allowlist in `handler.ts`.
 * - No client-supplied model, system prompt, tools, URLs, or resource ids. The
 *   reader controls only the excerpt, the mode, and an optional question.
 * - No relay of upstream payloads. Only `text` content blocks are projected,
 *   then sanitized and length-capped. Errors surface as stable application codes
 *   plus a random correlation id.
 * - No automatic replay of the send. An ambiguous dispatch fails visibly; the
 *   reader retries, which creates a new Session rather than double-delivering
 *   into a shared one.
 */

import { CloudAgentsError, createCloudAgentsClient } from "./cloud-agents.mjs";
import { CLOUD_AGENTS_ORIGIN } from "./ai-config.ts";
import { BindingError, patPresent, resolveBinding } from "./binding.ts";
import {
  EXPLAIN_MODES,
  MAX_QUESTION_CHARS,
  MAX_SELECTED_CHARS,
  MAX_TITLE_CHARS,
  MAX_TRANSLATE_CHARS,
  buildExplainPrompt,
  sanitizeExcerpt,
  type ExplainMode,
} from "./prompt.ts";

const NO_STORE = { "Cache-Control": "no-store" };

/** Total upstream budget. Kept well under the gateway/Function limits. */
const POLL_DEADLINE_MS = 45000;
const POLL_INTERVAL_MS = 1500;
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Output ceilings, per mode.
 *
 * An explanation is meant to be short, so 1200 is a runaway guard, not a target.
 * A translation is different in kind: its length is determined by the input's
 * length, so it needs a ceiling that a faithful rendering can actually fit
 * under. Chinese prose runs roughly 40–55% of the English character count, so a
 * 2400-char input produces ~1300 chars of output — 2400 leaves real headroom.
 *
 * If a translation ever did hit this ceiling it would be cut mid-sentence, which
 * is the same silent-corruption failure the input cap refuses to allow. That is
 * why the input cap (MAX_TRANSLATE_CHARS) and this one are sized together rather
 * than independently.
 */
const MAX_ANSWER_CHARS = 1200;
const MAX_TRANSLATION_CHARS = 2400;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function fail(code: string, status: number, detail?: string, diagnosticId?: string): Response {
  return json(
    {
      ok: false,
      error: code,
      ...(detail ? { detail } : {}),
      ...(diagnosticId ? { diagnosticId } : {}),
    },
    status,
  );
}

/* ------------------------------------------------------------------ */
/* Input validation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Single-line, control-char-free, length-capped. Used inside the prompt.
 *
 * Absent (undefined or null) is legal and means "the reader added nothing".
 * A present non-string is a client bug and gets its own code: reporting it as
 * `question_too_long` told the reader to shorten a question they never sent,
 * which sent them looking in the wrong place.
 */
type InlineResult = { ok: true; value: string } | { ok: false; code: string };

function inlineText(value: unknown, max: number, tooLongCode: string): InlineResult {
  if (value === undefined || value === null) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, code: "invalid_field_type" };
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length > max) return { ok: false, code: tooLongCode };
  return { ok: true, value: cleaned };
}

interface ExplainInput {
  mode: ExplainMode;
  selectedText: string;
  question: string;
  paperTitle: string;
}

function validate(body: unknown): ExplainInput | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "invalid_body";
  const record = body as Record<string, unknown>;

  const mode = record.mode;
  if (typeof mode !== "string" || !(EXPLAIN_MODES as readonly string[]).includes(mode)) return "invalid_mode";
  const explainMode = mode as ExplainMode;

  // sanitizeExcerpt no longer truncates, so the cap is enforced by rejection.
  // See MAX_TRANSLATE_CHARS for why a partial translation is worse than none.
  const cap = explainMode === "translate" ? MAX_TRANSLATE_CHARS : MAX_SELECTED_CHARS;
  const selectedText = sanitizeExcerpt(
    typeof record.selectedText === "string" ? record.selectedText : "",
  );
  if (!selectedText) return "empty_selection";
  if (selectedText.length > cap) return "selection_too_long";
  // Reject selections with no Latin letter: nothing for an English-paper reader
  // to explain, and a cheap filter against junk traffic.
  if (!/[A-Za-z]/.test(selectedText)) return "selection_not_english";

  // `translate` takes no question; anything sent is dropped rather than fed into
  // a prompt where it could steer the rendering.
  //
  // The annotation matters: without it the literal branch is inferred as
  // `{ ok: boolean }`, the union loses its discriminant, and `question.code`
  // below stops typechecking.
  const question: InlineResult =
    explainMode === "translate"
      ? { ok: true, value: "" }
      : inlineText(record.question, MAX_QUESTION_CHARS, "question_too_long");
  if (!question.ok) return question.code;

  const paperTitle = inlineText(record.paperTitle, MAX_TITLE_CHARS, "title_too_long");
  if (!paperTitle.ok) return paperTitle.code;

  return { mode: explainMode, selectedText, question: question.value, paperTitle: paperTitle.value };
}

/* ------------------------------------------------------------------ */
/* Tolerant upstream projections                                       */
/* ------------------------------------------------------------------ */

function eventRows(listRaw: unknown): unknown[] {
  if (Array.isArray(listRaw)) return listRaw;
  const data = (listRaw as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    const typed = block as { type?: unknown; text?: unknown } | null;
    if (typed && typed.type === "text" && typeof typed.text === "string") out += typed.text;
  }
  return out;
}

/**
 * Collects the Agent's reply text from an ascending event page.
 *
 * Deliberately tolerant of the exact event vocabulary: it keys on
 * `agent.message` and falls back to any event carrying text content that is not
 * the reader's own `user.message`. It also gathers the distinct event type names
 * so a failure can be diagnosed from protocol identifiers alone, without
 * relaying any upstream payload.
 */
function harvest(events: unknown[]): { answer: string; types: string[]; sawTerminal: boolean; sawError: boolean } {
  let answer = "";
  const types = new Set<string>();
  let sawTerminal = false;
  let sawError = false;

  for (const event of events) {
    const record = event as { type?: unknown; content?: unknown; text?: unknown; status?: unknown } | null;
    if (!record || typeof record !== "object") continue;

    const type = typeof record.type === "string" ? record.type : "";
    if (type) types.add(type);

    const lower = type.toLowerCase();
    if (/error|failed|cancelled|canceled|interrupted/.test(lower)) sawError = true;
    if (/idle|completed|done|finished|succeeded/.test(lower)) sawTerminal = true;
    if (typeof record.status === "string") {
      const status = record.status.toLowerCase();
      if (/error|failed|cancelled|canceled|interrupted/.test(status)) sawError = true;
      if (/idle|completed|done|finished|succeeded/.test(status)) sawTerminal = true;
    }

    if (lower === "user.message") continue;

    const text = textFromContent(record.content) || (typeof record.text === "string" ? record.text : "");
    if (text && (lower === "agent.message" || lower.includes("agent"))) {
      if (text.length > answer.length) answer = text;
    }
  }

  return { answer, types: [...types].slice(0, 8), sawTerminal, sawError };
}

/** Bounded, filtered protocol identifiers. Never content, never a payload. */
function typeDetail(types: string[]): string | undefined {
  const safe = types.filter((t) => /^[A-Za-z0-9_.:-]{1,40}$/.test(t));
  return safe.length ? safe.join(",") : undefined;
}

function sanitizeAnswer(raw: string, maxChars: number): string {
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^```[a-zA-Z]*\n?/g, "")
    .replace(/\n?```$/g, "")
    .trim()
    .slice(0, maxChars);
}

/* ------------------------------------------------------------------ */
/* The route                                                           */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function explain(request: Request): Promise<Response> {
  if (request.method !== "POST") return fail("method_not_allowed", 405, "POST");

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return fail("unsupported_media_type", 415);

  // Bound the body BEFORE parsing, so a large upload cannot be buffered.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return fail("invalid_body", 400);
  }
  if (rawBody.length === 0) return fail("empty_body", 400);
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) return fail("body_too_large", 413);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return fail("invalid_json", 400);
  }

  const input = validate(parsed);
  if (typeof input === "string") return fail("invalid_request", 400, input);

  if (!patPresent()) return fail("service_not_configured", 503, "qoder_pat_absent");

  /* 1. Binding ------------------------------------------------------- */
  let binding;
  try {
    binding = await resolveBinding();
  } catch (error) {
    if (error instanceof BindingError) return fail(error.code, error.status, undefined, error.diagnosticId);
    if (error instanceof CloudAgentsError) {
      const failure = error as CloudAgentsError & { diagnosticId?: string };
      const status = Number.isInteger(failure.status) && failure.status >= 400 && failure.status <= 599 ? failure.status : 503;
      return fail(failure.code, status, undefined, typeof failure.diagnosticId === "string" ? failure.diagnosticId : undefined);
    }
    return fail("ai_initialization_failed", 503);
  }

  let client: ReturnType<typeof createCloudAgentsClient>;
  try {
    client = createCloudAgentsClient({ origin: CLOUD_AGENTS_ORIGIN, timeoutMs: 20000 });
  } catch {
    return fail("ai_configuration_invalid", 503);
  }

  /* 2. One Session for this request only ------------------------------ */
  let sessionId: string;
  try {
    const created = await client.request("/api/v1/cloud/sessions", {
      method: "POST",
      body: {
        ...binding,
        // Fixed server-owned title. No reader content, no prompt text.
        title: "眉批解释",
        metadata: { app: "marginalia", purpose: "explain" },
      },
    });
    const id = (created as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !/^sess_[A-Za-z0-9_-]+$/.test(id)) {
      return fail("ai_response_invalid", 502, "session_id_shape");
    }
    sessionId = id;
  } catch (error) {
    return cloudFailure(error, "create_session");
  }

  /* 3. Send the prompt once ------------------------------------------- */
  const prompt = buildExplainPrompt({
    mode: input.mode,
    selectedText: input.selectedText,
    ...(input.question ? { question: input.question } : {}),
    ...(input.paperTitle ? { paperTitle: input.paperTitle } : {}),
  });

  try {
    await client.request(`/api/v1/cloud/sessions/${sessionId}/events`, {
      method: "POST",
      body: { events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }] },
    });
  } catch (error) {
    // Not replayed. An ambiguous outcome is reported, never retried into the
    // same Session; the reader's next attempt creates a fresh one.
    return cloudFailure(error, "send_event");
  }

  /* 4. Bounded poll for the reply -------------------------------------- */
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let lastAnswer = "";
  let stableHits = 0;
  let attempts = 0;
  let lastTypes: string[] = [];
  let sawError = false;

  while (Date.now() < deadline) {
    // Stop promptly if the reader navigated away or cancelled.
    if (request.signal.aborted) return fail("client_closed", 499);

    attempts += 1;
    let listRaw: unknown;
    try {
      listRaw = await client.request(`/api/v1/cloud/sessions/${sessionId}/events?order=asc&limit=100`);
    } catch (error) {
      return cloudFailure(error, "list_events");
    }

    const harvested = harvest(eventRows(listRaw));
    lastTypes = harvested.types;
    if (harvested.sawError) sawError = true;

    if (harvested.answer) {
      // A buffered agent.message is complete, but confirm once so a still-growing
      // reply is not truncated mid-sentence.
      if (harvested.answer === lastAnswer) {
        stableHits += 1;
        if (stableHits >= 1) {
          const cap = input.mode === "translate" ? MAX_TRANSLATION_CHARS : MAX_ANSWER_CHARS;
          const answer = sanitizeAnswer(harvested.answer, cap);
          if (!answer) return fail("empty_generation", 502, typeDetail(lastTypes));
          return json({
            ok: true,
            answer,
            // Reported rather than hidden. The ceiling should never be reached
            // (the input cap is sized so a faithful rendering fits under it), but
            // if a model runs long the reader must know the text was cut instead
            // of trusting a sentence that ends mid-thought.
            ...(answer.length >= cap ? { truncated: true } : {}),
            // Derived server-side and deterministically. Never asked of the
            // model, because a guessed term would poison the reader's glossary.
            ...(input.mode === "term"
              ? { term: input.selectedText.replace(/\s+/g, " ").trim().slice(0, 80) }
              : {}),
            meta: { attempts, mode: input.mode },
          });
        }
      } else {
        stableHits = 0;
        lastAnswer = harvested.answer;
      }
    } else if (sawError) {
      // Generation failed and produced no text. Do not convert that into a
      // success state or an empty answer.
      return fail("ai_generation_failed", 502, typeDetail(lastTypes));
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Budget exhausted. Idle alone never proves a reply was produced, so this is a
  // timeout, not an empty success.
  return fail("ai_generation_timeout", 504, typeDetail(lastTypes));
}

function cloudFailure(error: unknown, detail: string): Response {
  if (error instanceof CloudAgentsError) {
    const failure = error as CloudAgentsError & { diagnosticId?: string };
    const status =
      Number.isInteger(failure.status) && failure.status >= 400 && failure.status <= 599 ? failure.status : 503;
    return fail(failure.code, status, detail, typeof failure.diagnosticId === "string" ? failure.diagnosticId : undefined);
  }
  return fail("ai_request_unknown", 503, detail);
}
