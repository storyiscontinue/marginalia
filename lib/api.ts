/**
 * Same-origin calls to the site's single `app` Edge Function.
 *
 * Adapted from the platform's request helper contract: reject login HTML,
 * never surface a raw server error to the reader, and validate the successful
 * payload at the call site rather than trusting it.
 */

const FUNCTION_BASE = "/functions/v1/app";

export type BackendState =
  | { kind: "unknown" }
  | { kind: "checking" }
  | { kind: "ready"; modelCount: number; models: string[] }
  | { kind: "not_configured" }
  | { kind: "denied" }
  | { kind: "rate_limited" }
  | { kind: "unreachable"; code: string }
  | { kind: "offline" };

export class ServiceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly diagnosticId?: string;

  constructor(code: string, status: number, diagnosticId?: string) {
    super(code);
    this.name = "ServiceError";
    this.code = code;
    this.status = status;
    this.diagnosticId = diagnosticId;
  }
}

/** Reader-facing copy. Deliberately never echoes an upstream message. */
export function describeBackend(state: BackendState): string {
  switch (state.kind) {
    case "ready":
      return `AI 解释已接通（${state.modelCount} 个可用模型）`;
    case "checking":
      return "正在检查 AI 服务…";
    case "not_configured":
      return "AI 服务未配置：站点后端尚未开启或未同步";
    case "denied":
      return "AI 服务拒绝访问：服务端凭证无效";
    case "rate_limited":
      return "AI 服务暂时繁忙，请稍后再试";
    case "unreachable":
      return "AI 服务暂时不可用";
    case "offline":
      return "离线模式：可阅读与批注，AI 解释不可用";
    default:
      return "AI 服务状态未知";
  }
}

/**
 * Builds the query string with URLSearchParams rather than string
 * concatenation. The first version of this interpolated parameters directly,
 * which is how an `&` inside a value silently becomes a second parameter —
 * harmless for an arXiv id that is regex-validated server-side, and not harmless
 * in general.
 */
function endpointUrl(action: string, params?: Record<string, string>): string {
  const query = new URLSearchParams({ action, ...(params ?? {}) });
  return `${FUNCTION_BASE}?${query.toString()}`;
}

async function call(
  action: string,
  init?: RequestInit,
  params?: Record<string, string>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(endpointUrl(action, params), {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      ...init,
    });
  } catch {
    throw new ServiceError("network_error", 0);
  }

  const contentType = response.headers.get("content-type") ?? "";

  // A redirect to a login page comes back as HTML, not as an API error.
  if (contentType.includes("text/html")) {
    void response.body?.cancel().catch(() => {});
    throw new ServiceError(response.status === 401 ? "login_required" : "unexpected_html", response.status);
  }

  if (!contentType.includes("application/json")) {
    void response.body?.cancel().catch(() => {});
    throw new ServiceError("unexpected_content_type", response.status);
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  if (!response.ok || !payload || payload.ok !== true) {
    const code =
      payload && typeof payload.error === "string" && payload.error.length <= 64
        ? payload.error
        : `http_${response.status}`;
    const diagnosticId =
      payload && typeof payload.diagnosticId === "string" ? payload.diagnosticId : undefined;
    throw new ServiceError(code, response.status, diagnosticId);
  }

  return payload;
}

/* ------------------------------------------------------------------ */
/* Reachability probe                                                  */
/* ------------------------------------------------------------------ */

export interface ProbeResult {
  modelCount: number;
  models: string[];
}

/**
 * Cheapest possible verification of two independent unknowns: was the platform
 * Secret provisioned, and does the Cloud Agents upstream accept it.
 * Calls only GET /api/v1/cloud/models — no Agent, Environment or Session.
 */
export async function probeBackend(): Promise<BackendState> {
  try {
    const payload = (await call("probe-models")) as Record<string, unknown>;

    const rawModels = Array.isArray(payload.models) ? payload.models : [];
    const models = rawModels
      .map((entry) => (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
        ? ((entry as { id: string }).id)
        : null))
      .filter((id): id is string => id !== null);

    const modelCount = typeof payload.model_count === "number" ? payload.model_count : models.length;
    return { kind: "ready", modelCount, models };
  } catch (error) {
    if (!(error instanceof ServiceError)) return { kind: "unreachable", code: "unknown" };
    switch (error.code) {
      case "service_not_configured":
      case "ai_not_configured":
      case "ai_configuration_invalid":
        return { kind: "not_configured" };
      case "ai_access_denied":
      case "login_required":
        return { kind: "denied" };
      case "ai_rate_limited":
        return { kind: "rate_limited" };
      case "network_error":
        return { kind: "offline" };
      default:
        return { kind: "unreachable", code: error.code };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Explain                                                             */
/* ------------------------------------------------------------------ */

export interface ExplainRequest {
  arxivId: string;
  unitId: string;
  selectedText: string;
  mode: "sentence" | "term" | "formula" | "custom" | "translate";
  question?: string;
  /**
   * Paper title as context for the model. Server-side it is flattened to a
   * single line and length-capped before it enters the prompt, so it cannot
   * forge prompt structure.
   */
  paperTitle?: string;
}

export interface ExplainResult {
  answer: string;
  term?: string;
  /**
   * Set only when the server's output ceiling actually cut the reply. Reported
   * rather than hidden so a translation that ends mid-sentence is visibly
   * incomplete instead of looking like the paper's own prose.
   */
  truncated?: boolean;
}

/**
 * Live endpoint. Not stubbed and not backed by a fixture: if the backend is
 * not yet enabled the call fails and the UI reports that honestly.
 */
export async function explainPassage(request: ExplainRequest): Promise<ExplainResult> {
  const payload = (await call("explain", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(request),
  })) as Record<string, unknown>;

  if (typeof payload.answer !== "string" || payload.answer.trim().length === 0) {
    throw new ServiceError("invalid_explain_result", 200);
  }
  return {
    answer: payload.answer.trim(),
    ...(typeof payload.term === "string" && payload.term.trim()
      ? { term: payload.term.trim() }
      : {}),
    ...(payload.truncated === true ? { truncated: true } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Paper import                                                        */
/* ------------------------------------------------------------------ */

/**
 * Asks the Function to fetch and parse one arXiv paper.
 *
 * Returns the payload as `unknown` on purpose. The Function is ours, but a
 * response is still a response: `lib/import.ts` validates it field by field
 * before any of it reaches the DOM, so an upstream surprise cannot become
 * rendered markup.
 *
 * The browser never talks to arXiv directly. Doing it through the Function is
 * what keeps the request same-origin (no CORS preflight against a third party),
 * and it is where the fixed-origin, allowlisted-identifier boundary lives.
 */
export async function fetchArxivPaper(arxivId: string): Promise<unknown> {
  return call("fetch-paper", undefined, { arxivId });
}
