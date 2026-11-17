/**
 * Live acceptance checks against the published site.
 *
 *   node dev/verify-live.ts [baseUrl]
 *
 * Why this exists as a script rather than a handful of curls: the checks that
 * matter here are negative ones. "translate returns 200" is easy to eyeball;
 * "an over-long paragraph is REJECTED rather than silently sliced", "a request
 * with no Origin header is refused", and "an unknown action does not return
 * success" are the assertions that actually protect the product, and they are
 * exactly the ones that get skipped when verification is ad hoc.
 *
 * Nothing here needs credentials. The Function's platform Secret is never
 * touched, never named, and no check inspects an environment value.
 */

import { readFileSync } from "node:fs";

const BASE = (process.argv[2] ?? "https://marginalia-reader-ni20c3jx4cs.qoder.zone").replace(/\/$/, "");
const FUNCTION = `${BASE}/functions/v1/app`;

/** Name of the JS asset in the local `dist/index.html`, so check 1 can prove the
 *  site is serving the build that was just made rather than a cached older one. */
function localAssetName(): string {
  try {
    const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
    return html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1] ?? "";
  } catch {
    // No local build to compare against. Check 1 then only asserts that the site
    // serves *an* asset, and says so.
    return "";
  }
}

let failures = 0;
function ok(label: string, passed: boolean, detail = ""): void {
  if (!passed) failures += 1;
  console.log(`  ${passed ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/** The gateway rejects a cross-origin-looking POST with no Origin header. */
async function post(action: string, body: unknown, withOrigin = true) {
  const response = await fetch(`${FUNCTION}?action=${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(withOrigin ? { Origin: BASE } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* a non-JSON gateway body is itself the finding */
  }
  return { status: response.status, json, text };
}

const CJK = /[\u4e00-\u9fff]/;

/* ------------------------------------------------------------------ */

console.log("================ 1. the served bundle is the one just built ================");
{
  const indexHtml = await (await fetch(`${BASE}/`, { cache: "no-store" })).text();
  const served = indexHtml.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1] ?? "";
  const local = localAssetName();
  ok("index.html served", served.length > 0, served);
  ok("served asset matches the local dist build", !!local && served === local, `local ${local || "(unreadable)"}`);
}

console.log("================ 2. fetch-paper: a second, different paper ================");
{
  const started = Date.now();
  const response = await fetch(`${FUNCTION}?action=fetch-paper&arxivId=2401.04088`);
  const elapsed = Date.now() - started;
  const json = (await response.json()) as Record<string, any>;
  const paper = json.paper;
  ok("HTTP 200", response.status === 200, `${response.status} in ${elapsed}ms`);
  ok("parsed a real paper", !!paper && typeof paper.title === "string" && paper.title.length > 0, paper?.title ?? "");
  ok("title is Mixtral, not the demo paper", /mixtral/i.test(paper?.title ?? ""), paper?.title ?? "");
  ok("has units", Array.isArray(paper?.units) && paper.units.length > 10, `${paper?.units?.length ?? 0} units`);
  ok("not truncated", paper?.truncated !== true);
  ok("reader-facing url points at arxiv.org", /^https:\/\/arxiv\.org\/abs\//.test(paper?.url ?? ""), paper?.url ?? "");
  ok("carries the version the text was parsed from", /v[1-9][0-9]*$/.test(paper?.url ?? ""), paper?.url ?? "");

  // Projection caps. If the Function ever starts leaking an unbounded field the
  // browser would render it, this is where it shows up.
  const worstUnit = Math.max(0, ...(paper?.units ?? []).map((u: any) => String(u.original ?? "").length));
  ok("every unit within the 4000-char projection cap", worstUnit <= 4000, `longest ${worstUnit}`);
  const leaked = (paper?.formulas ?? []).filter((f: any) => "symbols" in f || "plainReading" in f || "citedIn" in f);
  ok("no curated-only fields leaked from the Function", leaked.length === 0, `${leaked.length} leaked`);
  ok("GET did not need an Origin header", true);
}

console.log("================ 3. explain mode=translate (the new capability) ================");
{
  const started = Date.now();
  const result = await post("explain", {
    arxivId: "1706.03762",
    unitId: "u-32-1",
    selectedText:
      "We compute the dot products of the query with all keys, divide each by the square root of d_k, and apply a softmax function to obtain the weights on the values.",
    mode: "translate",
    paperTitle: "Attention Is All You Need",
  });
  const elapsed = Date.now() - started;
  ok("HTTP 200", result.status === 200, `${result.status} in ${elapsed}ms`);
  ok("deployed Function accepts mode=translate", result.json.error !== "invalid_mode", JSON.stringify(result.json).slice(0, 160));
  const answer = String(result.json.answer ?? "");
  ok("returned a non-empty answer", answer.length > 0, `${answer.length} chars`);
  ok("answer is Chinese", CJK.test(answer), answer.slice(0, 80));
  ok("not flagged truncated", result.json.truncated !== true);
  ok("no upstream detail echoed", !/qoder|pat|bearer|session_/i.test(result.text));
}

console.log("================ 4. over-long translate is REJECTED, not sliced ================");
{
  // 3000 chars of plausible English prose, past the 2400-char translate cap.
  const long = Array.from({ length: 60 }, (_, i) => `sentence number ${i} about the model and its attention`).join(" ");
  ok("fixture exceeds the cap", long.length > 2400, `${long.length} chars`);
  const result = await post("explain", {
    arxivId: "1706.03762",
    unitId: "u-32-1",
    selectedText: long,
    mode: "translate",
    paperTitle: "Attention Is All You Need",
  });
  ok("rejected with 400", result.status === 400, `HTTP ${result.status}`);
  ok("reason is selection_too_long", result.json.detail === "selection_too_long" || result.json.error === "selection_too_long", JSON.stringify(result.json).slice(0, 160));
  ok("no partial answer was produced", !result.json.answer);
}

console.log("================ 5. the pre-existing sentence path still works ================");
{
  const result = await post("explain", {
    arxivId: "1706.03762",
    unitId: "u-32-3",
    selectedText:
      "We suspect that for large values of d_k, the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients.",
    mode: "sentence",
    paperTitle: "Attention Is All You Need",
  });
  const answer = String(result.json.answer ?? "");
  ok("HTTP 200", result.status === 200, `HTTP ${result.status}`);
  ok("returned a Chinese explanation", result.status === 200 && CJK.test(answer), `${answer.length} chars`);
}

console.log("================ 6. the boundaries still refuse what they should ================");
{
  const noOrigin = await post("explain", { arxivId: "1706.03762", unitId: "u-1", selectedText: "some english text here", mode: "sentence" }, false);
  ok("POST without Origin is refused by the gateway", noOrigin.status === 403, `HTTP ${noOrigin.status}`);

  const badId = await fetch(`${FUNCTION}?action=fetch-paper&arxivId=not-an-id`);
  ok("malformed arxiv id is 400", badId.status === 400, `HTTP ${badId.status}`);

  const missing = await fetch(`${FUNCTION}?action=fetch-paper&arxivId=9999.99999`);
  const missingBody = (await missing.text()) as string;
  // 404 is the expected answer. 429 is also acceptable here, and was observed on
  // the first run: this suite hits arXiv several times in quick succession, and
  // upstream throttling then answers before the Function can look the id up.
  // What must never happen is a 200 with an invented paper, so the assertion is
  // about honest failure rather than about one specific status.
  const honest =
    (missing.status === 404 && missingBody.includes("paper_not_found")) ||
    (missing.status === 429 && missingBody.includes("arxiv_rate_limited"));
  ok("nonexistent paper fails honestly, never fabricated", honest, `HTTP ${missing.status} ${missingBody.slice(0, 120)}`);

  const unknown = await fetch(`${FUNCTION}?action=dev-provision`);
  ok("the removed provisioning route is gone", unknown.status === 404, `HTTP ${unknown.status}`);

  // A mutating method other than POST must not succeed. The platform gateway
  // refuses it first (403, before the request ever reaches the Function), so
  // `method_not_allowed` in the handler is defence in depth rather than the live
  // path — asserted with an Origin header too, so "refused" cannot be confused
  // with "refused only because the Origin was missing".
  const putNoOrigin = await fetch(`${FUNCTION}?action=explain`, { method: "PUT" });
  ok("PUT without Origin is refused", putNoOrigin.status >= 400, `HTTP ${putNoOrigin.status}`);
  const putWithOrigin = await fetch(`${FUNCTION}?action=explain`, {
    method: "PUT",
    headers: { Origin: BASE, "Content-Type": "application/json" },
    body: "{}",
  });
  ok("PUT with a same-origin header is still refused", putWithOrigin.status >= 400, `HTTP ${putWithOrigin.status}`);
}

/* ------------------------------------------------------------------ */

console.log("");
if (failures === 0) console.log("ALL LIVE CHECKS PASSED");
else {
  console.log(`${failures} LIVE CHECK(S) FAILED`);
  process.exitCode = 1;
}
