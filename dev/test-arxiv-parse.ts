// Local validation of the arXiv LaTeXML parser against real downloaded samples.
//
// Run:  node dev/test-arxiv-parse.ts
//
// This is not a unit-test framework; it is a set of assertions about the two
// things that would silently ruin the product if wrong: (1) that the reader
// sees the authors' prose and nothing else, and (2) that section order and
// equation LaTeX survive intact. Samples live in dev/samples/ and are real
// arXiv responses, not fixtures invented to pass.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseLatexml, normalizeArxivId, latexToReadable, type ParsedPaper } from "../functions/arxiv-parse.ts";

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Text that must never reach a reader as if it were the paper's own prose. */
const CONTAMINANTS: Array<[string, string]> = [
  ["footnote body", "Equal contribution"],
  ["reproduction notice", "Provided proper attribution"],
  ["bibliography", "Advances in neural information processing"],
  ["figure caption", "Refer to caption"],
  ["navbar", "table of contents"],
  ["raw tag", "<"],
  ["undecoded entity", "&amp;"],
  ["LaTeX macro leak outside math", "\\mathrm"],
];

function auditContamination(paper: ParsedPaper, label: string) {
  console.log(`\n  contamination audit — ${label}`);
  const blob = [paper.title, paper.authors, paper.abstract, ...paper.units.map((u) => u.original)].join("\n");
  for (const [name, needle] of CONTAMINANTS) {
    // `\mathrm` legitimately appears inside `$…$`; only flag it outside math.
    const haystack = name === "LaTeX macro leak outside math" ? blob.replace(/\$[^$]*\$/g, " ") : blob;
    check(`no ${name}`, !haystack.toLowerCase().includes(needle.toLowerCase()));
  }
}

function report(paper: ParsedPaper) {
  console.log(`  title      : ${paper.title}`);
  console.log(`  id/version : ${paper.arxivId}${paper.version} [${paper.primaryCategory}] ${paper.dateText}`);
  console.log(`  authors    : ${paper.authors.slice(0, 110)}${paper.authors.length > 110 ? "…" : ""}`);
  console.log(`  abstract   : ${paper.abstract.length} chars`);
  console.log(`  units      : ${paper.units.length}   formulas: ${paper.formulas.length}   truncated: ${paper.truncated}`);
  const sections = [...new Map(paper.units.map((u) => [u.sectionOrder, u.section])).values()];
  console.log(`  sections   : ${sections.length}`);
  sections.forEach((s, i) => console.log(`     ${String(i + 1).padStart(2)}. ${s}`));
}

/* ------------------------------------------------------------------ */

for (const [file, arxivId, minUnits, mustContain] of [
  ["attention.html", "1706.03762", 40, "scaled dot-product attention"] as const,
  ["mixtral.html", "2401.04088", 30, "mixture-of-experts"] as const,
]) {
  const html = readFileSync(join(here, "samples", file), "utf8");
  console.log(`\n================ ${file} ================`);
  const result = parseLatexml(html, arxivId);
  check("parse succeeded", result.ok, result.ok ? "" : result.code);
  if (!result.ok) continue;

  const paper = result.paper;
  report(paper);
  check(`unit count >= ${minUnits}`, paper.units.length >= minUnits, `got ${paper.units.length}`);
  check("title non-empty", paper.title.length > 3);
  check("authors non-empty", paper.authors.length > 3);
  check("abstract non-empty", paper.abstract.length > 200);
  check("primary category parsed", /^[a-z-]+\.[A-Z]{2}$/.test(paper.primaryCategory), paper.primaryCategory);
  check("at least one formula", paper.formulas.length > 0);

  const sections = [...new Set(paper.units.map((u) => u.section))];
  check("multiple distinct sections", sections.length >= 4, `${sections.length}`);
  check("no untitled fallback section", !sections.includes("正文"), sections.join(" | "));
  // LaTeXML `ltx_paragraph` run-in headings ("Encoder:", "Label Smoothing") are
  // real markup but are not navigable sections; if they reach the spine the
  // reader sees a table of contents the paper never had.
  const runIns = ["Encoder:", "Decoder:", "Residual Dropout", "Label Smoothing"];
  for (const runIn of runIns) {
    check(`spine excludes run-in heading "${runIn}"`, !sections.includes(runIn));
  }
  check(
    "every spine entry is numbered or a known back-matter heading",
    sections.every((s) => s === "Abstract" || s === "Acknowledgements" || /^[0-9A-Z]+(\.[0-9]+)*\s/.test(s)),
    sections.filter((s) => !(s === "Abstract" || s === "Acknowledgements" || /^[0-9A-Z]+(\.[0-9]+)*\s/.test(s))).join(" | "),
  );

  // The byline must be names, not names plus arXiv's thanks-notes.
  check("authors carry no footnote debris", !/footnotemark|Equal contribution/.test(paper.authors));
  check("authors carry no bare digits", !/[0-9]/.test(paper.authors.replace(/\b(?:Jr|III|IV|2nd)\b/g, "")), paper.authors.slice(0, 120));

  // The abstract is emitted once, from its own extraction.
  check(
    "abstract is not duplicated as a second unit",
    paper.units.filter((u) => u.original === paper.abstract).length <= 1,
  );
  check("unit 1 is the abstract", paper.units[0]?.original === paper.abstract.slice(0, 4000));

  // Proves the scan reached the end of the document rather than dying early on
  // some unbalanced tag halfway through.
  const last = paper.units[paper.units.length - 1];
  check(
    "scan reached the back of the paper",
    /conclusion|acknowledgement/i.test(last?.section ?? ""),
    `last section was "${last?.section}"`,
  );

  // Benchmark tables are dense digit grids; if figure stripping failed they
  // would arrive here disguised as paragraphs.
  const tabular = paper.units.filter((u) => {
    const digits = (u.original.match(/[0-9]/g) ?? []).length;
    return digits / Math.max(u.original.length, 1) > 0.18;
  });
  check("no unit is table debris", tabular.length === 0, tabular.map((u) => u.id).join(","));

  const lower = paper.units.map((u) => u.original.toLowerCase()).join("\n");
  check(`body mentions "${mustContain}"`, lower.includes(mustContain));

  check("orders are 1..n", paper.units.every((u, i) => u.order === i + 1));
  check("ids unique", new Set(paper.units.map((u) => u.id)).size === paper.units.length);
  check("every unit has >=40 chars", paper.units.every((u) => u.original.length >= 40));
  check("no unit exceeds 4000 chars", paper.units.every((u) => u.original.length <= 4000));
  check("every formula has latex", paper.formulas.every((f) => f.latex.length > 0));
  check("every formula has a readable rendering", paper.formulas.every((f) => f.unicode.length > 0));
  check(
    "numbered formulas keep the paper's own number",
    paper.formulas.filter((f) => f.label).every((f) => /^\([0-9]+[a-z]?\)$/.test(f.label)),
    paper.formulas.map((f) => f.label).join(","),
  );
  // The MultiHead display lives in an unnumbered `ltx_equationgroup` split across
  // two rows and four <td> halves. Missing it would quietly drop one of the two
  // formulas that matter most in this paper.
  if (arxivId === "1706.03762") {
    const mh = paper.formulas.find((f) => /MultiHead/.test(f.latex));
    check("captures the unnumbered MultiHead equation group", Boolean(mh));
    check("MultiHead group keeps both rows", /\n/.test(mh?.latex ?? ""), JSON.stringify(mh?.latex ?? ""));
    check("MultiHead group is not given a fake number", mh?.label === "", `label="${mh?.label}"`);
    check("MultiHead renders readably", /MultiHead\(Q,K,V\)\s*=\s*Concat/.test(mh?.unicode ?? ""), mh?.unicode ?? "");
    const att = paper.formulas.find((f) => f.label === "(1)");
    check("equation (1) number comes from the paper", Boolean(att));
    check(
      "equation (1) renders as Attention(Q,K,V) = softmax(QKᵀ ⁄ √d_k) V",
      /Attention\(Q,K,V\)\s*=\s*softmax\(.*QKᵀ\s*⁄\s*√dₖ.*\)V/.test(att?.unicode ?? ""),
      att?.unicode ?? "",
    );
  }

  // Tag removal must not leave "[ 13 ] ." style debris in the reading text.
  const debris = paper.units.filter((u) => /\s[,.;:!?]|\[\s|\s\]|\(\s/.test(u.original));
  check("no punctuation debris in reading text", debris.length === 0, debris[0]?.original.slice(0, 160) ?? "");

  auditContamination(paper, file);

  console.log(`\n  unit 2   : ${paper.units[1]?.original.slice(0, 200)}…`);
  console.log(`  unit ${paper.units.length}  : [${paper.units[paper.units.length - 1]?.section}] ${paper.units[paper.units.length - 1]?.original.slice(0, 200)}…`);
  console.log(`  formulas : ${paper.formulas.map((f) => `${f.label} ${f.latex.slice(0, 70)}`).join("\n             ")}`);
}

/* ------------------------------------------------------------------ */

console.log("\n================ normalizeArxivId ================");
// 4-digit suffixes are real: arXiv used them from 2007 to 2014, so "1706.0376"
// and "0704.0001" are valid identifiers, not typos to be rejected.
const accepted = ["1706.03762", "1706.03762v7", " 2401.04088 ", "2401.04088V3", "0704.0001", "0704.0001v2", "1706.0376", "1706.03762 ", "1706.03762\n"];
const rejected = [
  "", "abc", "1706.03762v", "1706.03762v0", "1706.037621",
  "https://arxiv.org/abs/1706.03762", "1706.03762/../../etc/passwd",
  "math/0211159", null, undefined, 42, {}, "1706.03762v7x",
  "%31%37%30%36", "1706.03762?v=1",
];
for (const id of accepted) {
  const out = normalizeArxivId(id);
  check(`accept ${JSON.stringify(id)} → ${out}`, typeof out === "string" && /^[0-9]{4}\.[0-9]{4,5}(v[0-9]{1,3})?$/.test(out));
}
for (const id of rejected) {
  check(`reject ${JSON.stringify(id)}`, normalizeArxivId(id) === null, String(normalizeArxivId(id)));
}

console.log("\n================ latexToReadable ================");
// Expected strings are written out longhand on purpose: a rendering regression
// here is invisible in a diff of the parser but obvious to a reader.
const latexCases: Array<[string, string]> = [
  ["\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}(\\frac{QK^{T}}{\\sqrt{d_{k}}})V", "Attention(Q,K,V) = softmax(QKᵀ ⁄ √dₖ)V"],
  ["d_{\\text{model}}", "d_model"],
  // Unicode has no modifier capital Q, so the marker survives rather than the
  // exponent being silently flattened into `WᵢQ`, which would read as a product.
  ["W_{i}^{Q}", "Wᵢ^Q"],
  ["\\sum_{i=0}^{n-1}G(x)_{i}\\cdot E_{i}(x)", "Σᵢ₌₀ⁿ⁻¹G(x)ᵢ·Eᵢ(x)"],
  ["\\displaystyle\\text{where}~\\mathrm{head_{i}}", "where headᵢ"],
  // A compound exponent must keep its parentheses or `10000^2i/d_model` would
  // read as a different expression from the paper's.
  ["PE_{(pos,2i)}=\\sin(pos/10000^{2i/d_{\\text{model}}})", "PE_(pos,2i) = sin(pos/10000^(2i/d_model))"],
  ["\\alpha+\\beta\\leq\\gamma\\times\\infty", "α+β≤γ×∞"],
  ["\\frac{1}{2}", "1 ⁄ 2"],
  ["\\frac{a+b}{c+d}", "(a+b) ⁄ (c+d)"],
  ["\\sqrt{2}", "√2"],
  ["\\sqrt{d_{k}}", "√dₖ"],
  ["x \\quad y", "x y"],
  ["\\max(0,xW_{1}+b_{1})W_{2}+b_{2}", "max(0,xW₁+b₁)W₂+b₂"],
];
for (const [latex, expected] of latexCases) {
  const got = latexToReadable(latex).replace(/\s+/g, " ").trim();
  const want = expected.replace(/\s+/g, " ").trim();
  check(`${latex.slice(0, 46)}…`, got === want, got === want ? "" : `got "${got}" want "${want}"`);
}
// Anything unrecognised must survive rather than vanish.
check("unknown macro passes through", latexToReadable("\\foobarbaz{x}").includes("foobarbaz"));
check("empty input is empty", latexToReadable("") === "");
check("non-string input does not throw", typeof latexToReadable(undefined as unknown as string) === "string");

console.log("\n================ degenerate inputs ================");
const degenerate: Array<[string, string]> = [
  ["empty", ""],
  ["plain text", "just some words with no markup at all, definitely not a paper"],
  ["foreign html", "<html><body><h1>Not LaTeXML</h1><p class='ltx_p'>x</p></body></html>"],
  ["latexml but no title", "<article class='ltx_document'><p class='ltx_p'>a paragraph long enough to count as a unit of text</p></article>"],
  ["latexml, title, no units", "<article class='ltx_document'><h1 class='ltx_title ltx_title_document'>T</h1></article>"],
  ["truncated mid-tag", "<article class='ltx_document'><h1 class='ltx_title ltx_title_document'>T</h1><p class='ltx_p'>long enough paragraph text here"],
];
for (const [label, html] of degenerate) {
  const out = parseLatexml(html, "1706.03762");
  console.log(`  ${label.padEnd(24)} → ${out.ok ? `ok, ${out.paper.units.length} units` : out.code}`);
  check(`${label}: did not throw and returned a code`, out.ok || typeof out.code === "string");
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
