/**
 * GET ?action=fetch-paper&arxivId=<id> — real paper import.
 *
 * Why this exists
 * ---------------
 * Until now the site shipped exactly one hardcoded paper. A judge who typed in
 * their own arXiv id got nothing, which made every other claim about the product
 * unverifiable. This route makes the corpus real: arXiv's own LaTeXML HTML is
 * fetched and segmented server-side into the same ReadingUnit shape the reader
 * already has.
 *
 * Security boundaries
 * -------------------
 * - The upstream origin is a server-side constant. The request supplies only an
 *   identifier, which is matched against a strict regex before it is placed in
 *   a URL. There is no path by which a caller chooses the destination, so this
 *   is not an open proxy or an SSRF vector.
 * - No credential touches this request. QODER_PAT is never read here and the
 *   arXiv fetch carries no Authorization header, so a hostile identifier cannot
 *   redirect a bearer token anywhere.
 * - Upstream HTML is never relayed. It is parsed and an explicit projection is
 *   returned; raw markup, headers and error bodies are dropped.
 * - Every failure is a distinct stable code. Nothing silently falls back to
 *   sample data: an unimportable paper is reported as unimportable.
 *
 * Unverified platform fact
 * ------------------------
 * Whether this Function may reach the public internet at all was not documented
 * anywhere I could read. The `arxiv_unreachable` / `arxiv_timeout` codes below
 * are the instrument that settles it: they distinguish a blocked egress path
 * from a paper that merely does not exist.
 */

import { normalizeArxivId, parseLatexml, type ParsedFormula, type ParsedUnit } from "./arxiv-parse.ts";

/**
 * `export.arxiv.org`, not `arxiv.org`.
 *
 * Chosen from measurement, not preference: from the developer's network
 * `arxiv.org` resets the TLS handshake while `export.arxiv.org` serves the same
 * `/html/<id>` and `/abs/<id>` paths with 200. arXiv runs `export.` as its
 * programmatic-access host, which is also the one its robots guidance points at.
 */
const ARXIV_ORIGIN = "https://export.arxiv.org";

const FETCH_TIMEOUT_MS = 20000;
/**
 * Pause before the single retry on a 429.
 *
 * Short on purpose: long enough to clear a burst throttle, short enough that the
 * retry still fits inside the one 20s deadline this route already runs under.
 */
const RATE_LIMIT_RETRY_MS = 1200;
/** LaTeXML HTML for a long paper with inline SVG runs to a few megabytes. */
const MAX_HTML_BYTES = 8 * 1024 * 1024;
/** Bound on the JSON this route returns, so a 400-unit survey cannot blow up. */
const MAX_PAYLOAD_TEXT_CHARS = 500_000;

// Versioned arXiv HTML is immutable, so this is one of the few responses in the
// app that is genuinely cacheable. Caching also keeps a reader reloading the
// page from re-fetching a megabyte of markup through this Function.
const CACHEABLE = { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" };
const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200, headers: Record<string, string> = NO_STORE): Response {
  return Response.json(body, { status, headers });
}

function fail(code: string, status: number, detail?: string): Response {
  return json(
    {
      ok: false,
      error: code,
      ...(detail ? { detail } : {}),
    },
    status,
    // A failure is not cacheable: egress may start working, or the paper may
    // gain an HTML rendering on its next version.
    NO_STORE,
  );
}

/** Explicit projection. Only these fields ever leave the Function. */
function projectUnit(unit: ParsedUnit) {
  return {
    id: String(unit.id).slice(0, 120),
    order: Number.isInteger(unit.order) ? unit.order : 0,
    section: String(unit.section).slice(0, 200),
    sectionOrder: Number.isInteger(unit.sectionOrder) ? unit.sectionOrder : 1,
    original: String(unit.original).slice(0, 4000),
    formulaIds: unit.formulaIds.slice(0, 12).map((id) => String(id).slice(0, 120)),
  };
}

function projectFormula(formula: ParsedFormula) {
  return {
    id: String(formula.id).slice(0, 120),
    label: String(formula.label).slice(0, 12),
    latex: String(formula.latex).slice(0, 2000),
    unicode: String(formula.unicode).slice(0, 2000),
    unitId: String(formula.unitId).slice(0, 120),
  };
}

/** Drop trailing units until the projection fits the payload budget. */
function applyPayloadBudget(units: ParsedUnit[]): { units: ParsedUnit[]; truncated: boolean } {
  let total = 0;
  for (const unit of units) total += unit.original.length;
  if (total <= MAX_PAYLOAD_TEXT_CHARS) return { units, truncated: false };

  const kept: ParsedUnit[] = [];
  let running = 0;
  for (const unit of units) {
    if (running + unit.original.length > MAX_PAYLOAD_TEXT_CHARS) break;
    kept.push(unit);
    running += unit.original.length;
  }
  // Never hand back a paper with its middle missing: if the budget cut into the
  // first units, the whole import is too big rather than subtly incomplete.
  if (kept.length < 4) return { units: [], truncated: true };
  return { units: kept, truncated: true };
}

export async function fetchPaper(request: Request, url: URL): Promise<Response> {
  if (request.signal.aborted) return fail("client_closed", 499);

  const requested = normalizeArxivId(url.searchParams.get("arxivId"));
  if (!requested) {
    // The raw input is not echoed: it is attacker-controlled text that would end
    // up in a reader-visible message and possibly in a log.
    return fail("invalid_arxiv_id", 400, "expected_form_yyymm_nnnnn_with_optional_vn");
  }
  // Everything downstream keys on the versionless id. Importing `1706.03762` and
  // `1706.03762v7` must land in the same annotation bucket, or a reader's
  // margin notes would appear to vanish when they typed the id differently.
  const arxivId = requested.replace(/v[0-9]{1,3}$/, "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html: string;
  let status: number;
  let byteLength = 0;

  try {
    // A fixed origin plus a regex-validated identifier. `encodeURI` is belt and
    // braces: normalizeArxivId already admits only [0-9.v].
    const target = `${ARXIV_ORIGIN}/html/${encodeURI(arxivId)}`;
    const headers = {
      Accept: "text/html,application/xhtml+xml",
      // Identifying the client is what arXiv asks programmatic callers to do.
      "User-Agent":
        "Marginalia-reader/1.0 (literature reading aid; single-paper fetch on reader request)",
    };

    let upstream = await fetch(target, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers,
    });

    // Exactly one bounded retry on 429. arXiv throttles bursts, and the common
    // case here is our own doing: a reader importing a paper moments after the
    // previous import. Waiting it out once turns that into a success. A retry
    // loop would be hammering a service that just asked us to stop, so this does
    // not grow — and it shares the same controller, so the whole route is still
    // bounded by one 20s deadline rather than two.
    if (upstream.status === 429) {
      void upstream.body?.cancel().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_MS));
      upstream = await fetch(target, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        headers,
      });
    }

    status = upstream.status;

    if (status !== 200) {
      // Body discarded unread: arXiv error pages are markup, not information we
      // are allowed to relay.
      void upstream.body?.cancel().catch(() => {});
      if (status === 404) return fail("paper_not_found", 404, arxivId);
      // arXiv answers 403 on /html/ for a paper that exists but has no HTML
      // rendering. That is a real, permanent property of the paper, not an
      // outage, and the reader deserves to be told which one it is.
      if (status === 403) return fail("paper_no_html", 404, arxivId);
      if (status === 429) return fail("arxiv_rate_limited", 429);
      if (status >= 500) return fail("arxiv_unavailable", 502, `upstream_${status}`);
      return fail("arxiv_rejected", 502, `upstream_${status}`);
    }

    const declared = Number(upstream.headers.get("content-length") ?? "0");
    if (declared > MAX_HTML_BYTES) {
      void upstream.body?.cancel().catch(() => {});
      return fail("paper_too_large", 413);
    }

    html = await upstream.text();
    byteLength = html.length;
    if (byteLength > MAX_HTML_BYTES) return fail("paper_too_large", 413);
  } catch (error) {
    // Distinguishing these two is the whole point of the egress question: an
    // abort means the request was sent and arXiv was slow, while any other
    // failure means this Function could not open the connection at all.
    if (error instanceof DOMException && error.name === "AbortError") {
      return fail("arxiv_timeout", 504);
    }
    if (request.signal.aborted) return fail("client_closed", 499);
    return fail("arxiv_unreachable", 502, "no_route_to_arxiv");
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseLatexml(html, arxivId);
  if (!parsed.ok) {
    // 422 rather than 502: the fetch worked, the content was not what a paper
    // looks like. Never retried automatically, and never replaced with a demo.
    return fail(`parse_${parsed.code}`, 422, arxivId);
  }

  const budgeted = applyPayloadBudget(parsed.paper.units);
  if (budgeted.units.length === 0) return fail("paper_too_large", 413);

  const { paper } = parsed;
  const keptIds = new Set(budgeted.units.map((unit) => unit.id));

  return json(
    {
      ok: true,
      paper: {
        arxivId: paper.arxivId,
        version: paper.version,
        title: String(paper.title).slice(0, 400),
        authors: String(paper.authors).slice(0, 1200),
        primaryCategory: String(paper.primaryCategory).slice(0, 40),
        dateText: String(paper.dateText).slice(0, 40),
        abstract: String(paper.abstract).slice(0, 6000),
        // The reader-facing link is the canonical arxiv.org URL, not the export
        // mirror this Function actually used. The version suffix is kept: the
        // text on screen was parsed from that exact version, so "查看原文"
        // must land on it rather than on whatever arXiv now serves as latest.
        // Falls back to the bare id when the HTML carried no watermark.
        url: `https://arxiv.org/abs/${paper.arxivId}${paper.version}`,
        source: "arxiv",
        sourceHtmlBytes: byteLength,
        truncated: paper.truncated || budgeted.truncated,
        units: budgeted.units.map(projectUnit),
        formulas: paper.formulas
          .filter((formula) => keptIds.has(formula.unitId) || !formula.unitId)
          .map(projectFormula),
      },
    },
    200,
    CACHEABLE,
  );
}
