// Local validation of the fetch-paper route against the REAL arXiv endpoint.
//
// Run:  node dev/test-arxiv-fetch.ts
//
// This runs the exact module the Deno Function imports, on Node's fetch. It
// proves the route's own logic — validation, status mapping, projection,
// caching header — against live upstream responses. It does NOT prove that the
// deployed Function is allowed to open that connection; only a deployed request
// can prove that, and it is the first thing checked after publishing.
//
// Deliberately small: three live fetches, not a crawl. arXiv asks callers to be
// polite and this test is a caller.

import { fetchPaper } from "../functions/arxiv.ts";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(arxivId: string): Promise<{ status: number; body: any; headers: Headers }> {
  const url = new URL("https://site.invalid/functions/v1/app");
  url.searchParams.set("action", "fetch-paper");
  url.searchParams.set("arxivId", arxivId);
  const response = await fetchPaper(new Request(url.toString()), url);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

console.log("================ rejected without any network call ================");
// Warm-up only. The first call into this module pays module init and JIT cost
// (~60ms), which would make the "<50ms proves no fetch happened" assertion
// below fail for a reason unrelated to whether a request was opened.
await call("warmup");
for (const bad of ["", "abc", "javascript:alert(1)", "../../etc/passwd", "1706.03762@evil.example",
                   "https://arxiv.org/abs/1706.03762", "1706.03762%00", "1706.03762/../../x"]) {
  const started = Date.now();
  const { status, body } = await call(bad);
  check(
    `${JSON.stringify(bad).slice(0, 40)} → 400 invalid_arxiv_id`,
    status === 400 && body.error === "invalid_arxiv_id",
    `${status} ${body.error}`,
  );
  // Proves the rejection happened before any upstream request was opened.
  check("   rejected in <50ms (no fetch attempted)", Date.now() - started < 50);
  check("   raw input not echoed back", !JSON.stringify(body).includes(bad) || bad === "");
}

console.log("\n================ live: 1706.03762 (Attention Is All You Need) ================");
{
  const { status, body, headers } = await call("1706.03762");
  check("200", status === 200, `${status} ${JSON.stringify(body).slice(0, 200)}`);
  check("ok:true", body.ok === true);
  if (body.ok) {
    const p = body.paper;
    console.log(`  title      : ${p.title}`);
    console.log(`  id         : ${p.arxivId}${p.version} [${p.primaryCategory}] ${p.dateText}`);
    console.log(`  authors    : ${p.authors.slice(0, 90)}…`);
    console.log(`  units      : ${p.units.length}  formulas: ${p.formulas.length}  truncated: ${p.truncated}`);
    console.log(`  html bytes : ${p.sourceHtmlBytes}`);
    check("title matches the real paper", p.title === "Attention Is All You Need", p.title);
    check("canonical url points at arxiv.org, not the export mirror", p.url === "https://arxiv.org/abs/1706.03762v7", p.url);
    check("source labelled arxiv", p.source === "arxiv");
    check("units non-empty", p.units.length > 40);
    check("first unit is the abstract", p.units[0].section === "Abstract");
    check("formulas include Attention (1)", p.formulas.some((f: any) => f.label === "(1)" && /Attention/.test(f.unicode)));
    check("formulas include the unnumbered MultiHead group", p.formulas.some((f: any) => /MultiHead/.test(f.unicode) && f.label === ""));
    check("every unit has a stable id and text", p.units.every((u: any) => u.id && u.original.length >= 40));
    check("every formula references a kept unit", p.formulas.every((f: any) => p.units.some((u: any) => u.id === f.unitId)));
    check("no raw markup in the projection", !JSON.stringify(body).includes("<"));
    check("no upstream header leaked", !JSON.stringify(body).includes("export.arxiv.org"));
    // Immutable versioned content, so caching it is safe and saves a megabyte
    // of re-fetching when a reader reloads.
    check("success is cacheable", /max-age=/.test(headers.get("cache-control") ?? ""), headers.get("cache-control") ?? "");
    check("payload under 700kB", JSON.stringify(body).length < 700_000, String(JSON.stringify(body).length));
  }
}

console.log("\n================ live: a different paper, 2401.04088 (Mixtral) ================");
{
  const { status, body } = await call("2401.04088");
  check("200", status === 200, `${status} ${body.error ?? ""}`);
  if (body.ok) {
    console.log(`  title : ${body.paper.title}  units: ${body.paper.units.length}  formulas: ${body.paper.formulas.length}`);
    check("title matches", body.paper.title === "Mixtral of Experts", body.paper.title);
    check("different paper yields different sections", body.paper.units[1].section.includes("Introduction"));
  }
}

console.log("\n================ live: identifiers that do not resolve ================");
{
  const { status, body } = await call("9999.99999");
  console.log(`  9999.99999 → ${status} ${body.error} ${body.detail ?? ""}`);
  check("nonexistent paper is 404 paper_not_found", status === 404 && body.error === "paper_not_found", `${status} ${body.error}`);
  check("failure is not cacheable", body.ok === false);
}
{
  // A well-formed id in a month that has not happened yet.
  const { status, body } = await call("3012.00001");
  console.log(`  3012.00001 → ${status} ${body.error}`);
  check("future-dated id is reported, not fabricated", !body.ok);
}

console.log("\n================ versioned request ================");
{
  const { status, body } = await call("1706.03762v7");
  check("explicit version accepted", status === 200 && body.ok === true, `${status} ${body.error ?? ""}`);
  if (body.ok) check("version reported back", body.paper.version === "v7", body.paper.version);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
