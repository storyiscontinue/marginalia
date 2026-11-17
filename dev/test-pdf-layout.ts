// Local validation of the PDF layout inference against real published papers.
//
// Run:  node dev/test-pdf-layout.ts
//
// Why this exists rather than a browser test
// ------------------------------------------
// The whole risk in "upload your own PDF" is that the reading order comes out
// wrong, and a wrong order is not a crash — it is a page of plausible-looking
// text that quietly misrepresents a paper. That is the failure mode this product
// cannot afford, so it is the one worth an automated check.
//
// The check runs under plain Node against real arXiv PDFs, driven through
// `pdfjs-dist/legacy` (the same extraction engine the site loads in the browser,
// without the DOM). That is possible because `lib/pdf-layout.ts` and
// `lib/pdf-text.ts` were built to have no browser dependency; `lib/pdf.ts`, which
// does, is deliberately not reachable from here.
//
// The fixtures are downloads, not invented strings:
//   1706.03762v7  Attention Is All You Need  — single column, arXiv front matter
//   1512.03385    ResNet (CVPR)              — two column, the case that must work
//   2005.14165    GPT-3 (75 pages)           — long document, page-cap behaviour
//   2012.12675    Motzkin numbers            — author's own LaTeX, heading = title size
//   2012.11542    SIR / econ working paper   — cover page, status line, footnotes
//   2012.13779    DAC-ML (Springer LNCS)     — 9pt affiliations under 10pt names
//   2012.11922    Gaussian processes (IEEE)  — 9pt front matter at 12pt body
//
// The last four are there because the first three are all computer science. They
// are the evidence for the risk register's R13, and each of them failed before
// the title-page rules were written; the comment on each entry says what leaked.
//
// Re-download with:
//   curl -A "Marginalia-reader/1.0" -o dev/samples/1512.03385.pdf \
//     https://arxiv.org/pdf/1512.03385

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { orderForReading, toLines, bodyFontSize, dropRunningFurniture } from "../lib/pdf-layout.ts";
import { buildPdfPaper, runsFromTextContent, MAX_PDF_PAGES } from "../lib/pdf-text.ts";

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

/* ------------------------------------------------------------------ */
/* Extraction, exactly as the browser does it                          */
/* ------------------------------------------------------------------ */

interface Extracted {
  runs: ReturnType<typeof runsFromTextContent>;
  families: Map<string, string>;
  /** pdf.js's own item order, flattened — the naive baseline the reconstruction
   *  is scored against. */
  stream: string[];
  pageCount: number;
  pagesParsed: number;
  metadataTitle: string;
}

async function extract(path: string): Promise<Extracted> {
  const task = getDocument({
    data: new Uint8Array(readFileSync(path)),
    verbosity: 0,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const doc = await task.promise;
  const pageCount = doc.numPages as number;
  const pagesParsed = Math.min(pageCount, MAX_PDF_PAGES);

  const runs: ReturnType<typeof runsFromTextContent> = [];
  const families = new Map<string, string>();
  const stream: string[] = [];

  for (let index = 1; index <= pagesParsed; index += 1) {
    const page = await doc.getPage(index);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    for (const [name, style] of Object.entries(content.styles ?? {})) {
      if (!families.has(name)) families.set(name, style?.fontFamily ?? "");
    }
    runs.push(...runsFromTextContent(content.items ?? [], index, viewport.width, viewport.height));
    for (const item of content.items ?? []) {
      if (typeof item.str === "string" && item.str.trim()) stream.push(item.str.trim());
    }
    page.cleanup();
  }

  let metadataTitle = "";
  try {
    const meta = await doc.getMetadata();
    if (typeof meta?.info?.Title === "string") metadataTitle = meta.info.Title;
  } catch {
    /* as in lib/pdf.ts: metadata is a nicety */
  }

  await task.destroy();
  return { runs, families, stream, pageCount, pagesParsed, metadataTitle };
}

/* ------------------------------------------------------------------ */
/* Scoring the reconstruction against the naive stream                 */
/* ------------------------------------------------------------------ */

/**
 * Word pieces of a string: maximal runs of letters, lowercased, short ones
 * discarded.
 *
 * Splitting on EVERY non-letter is what makes this comparison fair, and it took
 * a measurement to see why. Anything coarser glues words that the two sides
 * disagree about: the reconstruction joins a line-broken "transduc-" to "tion"
 * and may keep or drop the hyphen depending on where the break fell, so
 * hyphen-aware tokenising reported correct text as invented ("attentionq",
 * "sequencealigned", "layernormx"), and the one real bug it did catch — two
 * columns read across instead of down — was buried under the noise. Split on
 * non-letters and both sides agree by construction: "state-of-the-art" and
 * "transduc-tion" and "Attention(Q," all yield the same pieces whichever side
 * they came from, while a genuinely glued "RenJian" still stands out as a piece
 * that exists nowhere in the source.
 */
function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z]+/).filter((word) => word.length >= 4);
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Words long enough to be unique somewhere in a 60-page document. */
const SHINGLE = 6;

/**
 * Where in the content stream a paragraph comes from, or null.
 *
 * Anchored on a six-word phrase rather than on individual words, because a
 * paragraph is the unit the reader actually experiences: the product question is
 * "did the abstract come before section 1", not "is every adjective in its
 * original position". A phrase long enough to be unique identifies the paragraph
 * even when the same common words recur everywhere.
 *
 * UNIQUE is the operative word. `shingles` therefore records how many times each
 * phrase occurs, and an ambiguous one is skipped: ResNet says "we use a weight
 * decay of 0.0001 and" in §3.4 (page 4) and again, three words later, in §4.2
 * (page 7), and taking the first occurrence reported the §4.2 paragraph as
 * reaching 2400 words backwards — a correct reading order scored as a serious
 * inversion. A paragraph made only of repeated phrases is reported as
 * unlocatable rather than guessed at.
 */
function anchorOffset(
  paragraph: string,
  shingles: Map<string, { at: number; n: number }>,
): number | null {
  const words = normalise(paragraph).split(" ").filter(Boolean);
  for (let i = 0; i + SHINGLE <= words.length; i += 1) {
    const found = shingles.get(words.slice(i, i + SHINGLE).join(" "));
    if (found !== undefined && found.n === 1) return found.at;
  }
  return null;
}

/**
 * How much of the reconstruction's ordering disagrees with the stream order.
 *
 * For a PDF written by pdftex the content stream is already in reading order,
 * which makes it a usable reference: if the reconstruction preserves order, the
 * disagreements come only from the front matter, footnotes and the bibliography
 * being cut. If column detection or line grouping is broken, adjacent lines
 * interleave and the rate jumps.
 *
 * Two versions of this metric were measured and both were wrong, so the shape of
 * the question is recorded here rather than rediscovered. Indexing every token at
 * its FIRST stream occurrence and counting adjacent descents scored a parse that
 * was in fact correct at 39%, because a phrase recurring in the abstract and the
 * conclusion reports the abstract's index twice. Consuming rare tokens greedily
 * forward was worse: one token whose earliest occurrence sits inside a figure
 * advances the cursor past the whole document and every subsequent paragraph is
 * then "behind" it, which is how ResNet's correct two-column read scored 37%.
 * Anchoring each paragraph on a phrase unique in the stream has no cursor to
 * poison. It accepts one failure mode — the paragraph really is out of order —
 * and one abstention: a paragraph built only of repeated phrases is reported as
 * unlocatable, not as a backtrack, which is why `missing` is printed next to the
 * rate.
 */
function orderReport(reconstructed: string[], stream: string[]): {
  disorder: number;
  located: number;
  missing: number;
  backtracks: string[];
} {
  const streamWords = normalise(stream.join(" ")).split(" ").filter(Boolean);
  const shingles = new Map<string, { at: number; n: number }>();
  for (let i = 0; i + SHINGLE <= streamWords.length; i += 1) {
    const key = streamWords.slice(i, i + SHINGLE).join(" ");
    const seen = shingles.get(key);
    if (seen) seen.n += 1;
    else shingles.set(key, { at: i, n: 1 });
  }

  const located: Array<{ at: number; index: number }> = [];
  let missing = 0;
  reconstructed.forEach((paragraph, index) => {
    const at = anchorOffset(paragraph, shingles);
    if (at === null) missing += 1;
    else located.push({ at, index });
  });

  // Which paragraph starts the run, and how far back it reaches: a bare
  // percentage tells a reader nothing they can act on.
  let backwards = 0;
  const backtracks: string[] = [];
  for (let i = 1; i < located.length; i += 1) {
    if (located[i].at >= located[i - 1].at) continue;
    backwards += 1;
    if (backtracks.length < 6) {
      backtracks.push(
        `第${located[i].index + 1}段比上一段早 ${located[i - 1].at - located[i].at} 词：` +
          `${reconstructed[located[i].index]?.slice(0, 46)}…`,
      );
    }
  }

  return {
    disorder: located.length > 1 ? backwards / (located.length - 1) : 0,
    located: located.length,
    missing,
    backtracks,
  };
}

/**
 * The page each paragraph really starts on, measured from the runs rather than
 * read back out of the parser's own bookkeeping.
 *
 * A page label is the reader's only way to check a reconstructed order, so an
 * unverified one is worse than none. The anchoring rule is the one `orderReport`
 * already proved: a phrase unique in the stream, no cursor. `pageAt` is parallel
 * to the normalised stream text, one entry per character, filled from the run
 * that character came from, and the page reported is the page of the phrase's
 * FIRST character — which is where the paragraph begins even when the phrase
 * itself runs across a column or page break. A paragraph built only of repeated
 * phrases abstains rather than being charged with the abstract's page.
 */
function pageReport(
  units: ReadonlyArray<{ page?: number; original: string }>,
  runs: Extracted["runs"],
): { checked: number; wrong: number; detail: string[] } {
  let text = "";
  const pageAt: number[] = [];
  for (const run of runs) {
    const piece = normalise(run.str);
    if (!piece) continue;
    text += `${piece} `;
    for (let i = 0; i < piece.length + 1; i += 1) pageAt.push(run.page);
  }

  const detail: string[] = [];
  let checked = 0;
  let wrong = 0;
  for (const unit of units) {
    const words = normalise(unit.original).split(" ").filter(Boolean);
    if (words.length < SHINGLE) continue;
    const phrase = words.slice(0, SHINGLE).join(" ");
    const first = text.indexOf(phrase);
    if (first < 0 || text.indexOf(phrase, first + 1) >= 0) continue;
    checked += 1;
    const measured = pageAt[first];
    if (measured === unit.page) continue;
    wrong += 1;
    if (detail.length < 4) {
      detail.push(
        `标签第 ${unit.page} 页，实测第 ${measured} 页：${unit.original.slice(0, 44)}…`,
      );
    }
  }
  return { checked, wrong, detail };
}

/** Fraction of the document's stream vocabulary that survived into the paper. */
function coverage(reconstructed: string[], stream: string[]): number {
  const kept = new Map<string, number>();
  for (const paragraph of reconstructed) {
    for (const word of tokens(paragraph)) kept.set(word, (kept.get(word) ?? 0) + 1);
  }
  let hit = 0;
  let total = 0;
  for (const raw of stream) {
    for (const word of tokens(raw)) {
      total += 1;
      if ((kept.get(word) ?? 0) > 0) hit += 1;
    }
  }
  return total > 0 ? hit / total : 0;
}

/**
 * Fraction of reconstructed words that appear nowhere in the source.
 *
 * Must be zero. Anything else means the code invented text, which on a reading
 * aid is not a bug but a fabrication.
 *
 * One forgiveness, and it is the documented limit rather than a loophole: a word
 * formed by gluing a ONE-LETTER neighbour onto a real word is accepted when that
 * pair is adjacent in the source. This is the subscript case — `$d_{\mathrm{model}}$`
 * reaches pdf.js as the letter "d" and the word "model" at different sizes, and
 * this module extracts no mathematics, so "dmodel" is mangled text, not invented
 * text. Two multi-letter words glued together ("RenJian") is still reported,
 * because nothing but a lost space can produce that.
 */
function invented(reconstructed: string[], stream: string[]): string[] {
  const source = new Set<string>();
  const glued = new Set<string>();
  const words = stream
    .join(" ")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  words.forEach((word, i) => {
    source.add(word);
    const next = words[i + 1];
    if (!next) return;
    if (word.length === 1) glued.add(word + next);
    if (next.length === 1) glued.add(word + next);
  });

  const out = new Set<string>();
  for (const paragraph of reconstructed) {
    for (const word of tokens(paragraph)) {
      if (!source.has(word) && !glued.has(word)) out.add(word);
    }
  }
  return [...out];
}

/* ------------------------------------------------------------------ */
/* The fixtures                                                        */
/* ------------------------------------------------------------------ */

const SAMPLES: Array<{
  file: string;
  label: string;
  expectTwoColumn: boolean;
  title: string;
  mustContain: string[];
  mustNotContain: string[];
  /**
   * Names that must appear in `paper.authors`.
   *
   * Deliberately not part of `mustContain`: the title page is now consumed out of
   * the paragraph stream, so a name in the body would be the bug rather than the
   * requirement. Asserting it against `units` would have failed this test for
   * doing the right thing.
   */
  authorContains: string[];
  /**
   * Set for a document too long to fit the import budget, where stopping early
   * is correct behaviour rather than a defect.
   */
  capExpected?: boolean;
  /**
   * Asserts that the front-matter metadata rule FIRED on this paper — that a
   * "Keywords:" block was recognised and removed rather than never having been
   * there. Without it, `mustNotContain: ["keywords:"]` would pass equally well on
   * a parser that lost the abstract.
   */
  metadataDropped?: boolean;
  /**
   * Units that legitimately start mid-sentence, with the reason in the comment
   * below each entry.
   *
   * The invariant is the one a reader notices first, so it is not relaxed; these
   * four papers each carry at least one paragraph the text layer splits for a
   * reason the geometry cannot see, and pretending otherwise would either delete
   * the check or delete the paper. The number is asserted exactly, which means a
   * new mid-sentence start in one of these documents still fails.
   */
  knownTails?: number;
}> = [
  {
    file: "1706.03762.pdf",
    label: "Attention Is All You Need (单栏, 15 页)",
    expectTwoColumn: false,
    title: "Attention Is All You Need",
    mustContain: ["recurrent neural networks", "scaled dot-product attention"],
    authorContains: ["Ashish Vaswani", "Noam Shazeer", "Jakob Uszkoreit"],
    mustNotContain: [
      // arXiv's licence notice, set in a font LARGER than the body text at the
      // very top of page 1. The arXiv HTML path filters it by class name; here
      // only position can find it.
      "provided proper attribution",
      // The rotated margin watermark.
      "arxiv:1706.03762",
      // The footnote block under the abstract, which is an acknowledgement of
      // who did what, not a paragraph of the paper.
      "listing order is random",
    ],
  },
  {
    file: "1512.03385.pdf",
    label: "Deep Residual Learning (双栏 CVPR, 12 页)",
    expectTwoColumn: true,
    title: "Deep Residual Learning for Image Recognition",
    mustContain: ["degradation problem", "residual learning"],
    authorContains: ["Kaiming He", "Xiangyu Zhang", "Jian Sun"],
    mustNotContain: ["arxiv:1512.03385"],
  },
  {
    file: "2005.14165.pdf",
    label: "GPT-3 (单栏, 75 页, 触发容量上限)",
    expectTwoColumn: false,
    capExpected: true,
    title: "Language Models are Few-Shot Learners",
    mustContain: ["large language models", "few-shot"],
    // 31 authors; a list this long is not what this check is for.
    authorContains: [],
    mustNotContain: ["arxiv:2005.14165"],
  },
  /*
   * Four templates the three above do not cover, chosen on 11/16 for the risk
   * register's R13 — "the layout rules were tuned on computer-vision and NLP
   * papers" — and kept as fixtures rather than thrown away as a probe. All four
   * failed at first, and not in the paragraphs: in the title page. A Springer
   * LNCS paper handed back its affiliation block as the author list; an IEEE
   * geoscience paper handed back a Spanish postal address and a list of e-mail
   * aliases as its first paragraph; an economics working paper handed back
   * "(Preliminary version)" as paragraph one and "1University of Toronto." as
   * paragraph three; and a number-theory preprint folded "1 Introduction" into
   * its own title. What each entry asserts below is the fix, in the words that
   * were leaking.
   */
  {
    // A one-author preprint in author's LaTeX: no running header, no arXiv
    // banner, the title in 17pt over two lines, and the heading underneath it set
    // at exactly the same 17pt.
    file: "2012.12675.pdf",
    label: "Motzkin 数（数学预印本, 单栏, 17 页）",
    expectTwoColumn: false,
    title: "Arithmetization of well-formed parenthesis strings. Motzkin Numbers of the Second Kind",
    mustContain: ["motzkin numbers", "parenthesis strings"],
    authorContains: ["Gennady Eremin"],
    mustNotContain: ["keywords:", "1 introduction", "ergenns@"],
    metadataDropped: true,
    // Two units, both inside the abstract: the author's own LaTeX breaks the
    // abstract's first sentence across a page-height equation, and the text
    // layer shows no size change or gap for it — only the mid-sentence start.
    knownTails: 2,
  },
  {
    // A working-paper cover page: title block, two author names in 14pt, a
    // submission date, a status parenthetical, an acknowledgement at body size,
    // and a pair of affiliation footnotes in 10pt with superscripts welded on.
    // Page 1 has nothing else on it, which is what made its own line spacing
    // (24.9pt) useless as the yardstick for the footnote rule.
    file: "2012.11542.pdf",
    label: "SIR 模型再生数不确定性（经济工作论文, 单栏, 58 页）",
    expectTwoColumn: false,
    title: "Uncertainty on the Reproduction Ratio in the SIR Model",
    mustContain: ["reproduction ratio", "extreme variability"],
    // The extraction splits the forenames from the surnames across two 14pt rows,
    // so this asserts what survives, which is the surname pair — not that the
    // forenames came through, because they did not.
    authorContains: ["ELLIOTT", "GOURIEROUX"],
    mustNotContain: ["keywords", "(preliminary version)", "1university of toronto"],
    metadataDropped: true,
    // One unit in the middle of section 4, where a displayed equation is set on
    // its own line and the sentence resumes below it in lowercase.
    knownTails: 1,
  },
  {
    // Springer LNCS: the body is 10pt, the abstract 9.5pt with a run-in
    // "Abstract.", the affiliation block 9pt, and the most common size on page 1
    // is the affiliation block — which is how `bodyFontSize` used to call the
    // 10pt author line a heading and stop the title-page walk before it started.
    file: "2012.13779.pdf",
    label: "DAC-ML 样本效率（Springer LNCS, 单栏, 8 页）",
    expectTwoColumn: false,
    title: "Towards sample-efficient policy learning with DAC-ML",
    mustContain: ["sample-inefficiency", "deep reinforcement learning"],
    authorContains: ["Ismael T. Freire", "Verschure"],
    mustNotContain: ["keywords:", "universitat pompeu fabra"],
    metadataDropped: true,
  },
  {
    // IEEE two-column… except that this PDF's body is 12pt while its abstract,
    // keywords and page-foot note are all 9pt, so the front matter is not one
    // block: the walk stops at the abstract and the keywords are behind it.
    file: "2012.11922.pdf",
    label: "高斯过程遥感（IEEE 地学, 双栏? 实测单栏主文, 18 页）",
    expectTwoColumn: false,
    title: "Learning Structures in Earth Observation Data with Gaussian Processes",
    mustContain: ["gaussian processes", "bio-geophysical"],
    authorContains: ["Fernando Mateo", "Camps-Valls"],
    // The postal address and the citation line are the two blocks this paper
    // leaked as paragraphs 1 and 3; "@uv.es" is the alias list under the address.
    mustNotContain: ["keywords:", "@uv.es", "paper published in", "catedr"],
    metadataDropped: true,
  },
];

/** Pages where the column split actually fired, counted from the layout pass. */
function columnSplitPages(runs: readonly unknown[]): number {
  const lines = toLines(runs as never);
  const body = bodyFontSize(lines);
  const furniture = dropRunningFurniture(lines, 1);
  const byPage = new Map<number, number>();
  const ordered = orderForReading(furniture.kept as never);
  for (const line of ordered.lines) {
    if (line.column === 0) continue;
    // A page with only a stray two-character fragment in one column is not a
    // two-column page; require it to carry real text.
    if (line.text.length < 12) continue;
    byPage.set(line.page, (byPage.get(line.page) ?? 0) + 1);
  }
  void body;
  let pages = 0;
  for (const [, count] of byPage) if (count >= 4) pages += 1;
  return pages;
}

console.log("\nPDF 版面解析：对七篇真实论文的实测\n");

for (const sample of SAMPLES) {
  const path = join(here, "samples", sample.file);
  let extracted: Extracted;
  try {
    extracted = await extract(path);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${sample.file} 无法读取 — ${error instanceof Error ? error.message : error}`);
    continue;
  }

  const { paper, layout } = buildPdfPaper(extracted.runs, (name) => extracted.families.get(name) ?? "", {
    docId: `pdf-test-${sample.file}`,
    fileName: sample.file,
    pageCount: extracted.pageCount,
    pagesParsed: extracted.pagesParsed,
    metadataTitle: extracted.metadataTitle,
  });

  console.log(`— ${sample.label}`);
  if (!paper) {
    failures += 1;
    console.log(
      `  FAIL 未能组装出论文 — 段落 ${layout.paragraphs.length} · 标题「${layout.title ?? "无"}」· 正文字号 ${layout.bodyFontSize} · 空白页 ${layout.blankPages.length}`,
    );
    continue;
  }

  const body = paper.units.map((unit) => unit.original);
  const all = body.join("\n").toLowerCase();

  check("标题正确", paper.title === sample.title, `实际：${paper.title}`);
  check(
    "作者含人名且不含单位/邮箱/脚注标记",
    paper.authors.length > 3 &&
      !/@/.test(paper.authors) &&
      // The correspondence block under an IEEE title page ends in the lab's home
      // page, and "http://isp.uv.es/" was measured arriving as an author's name
      // because it opens lowercase and the row-continuation rule took it.
      !/https?:|www\./i.test(paper.authors) &&
      !/university|google brain|google research|laborator/i.test(paper.authors) &&
      !/[*†‡∗]/.test(paper.authors),
    `实际：${paper.authors.slice(0, 120)}`,
  );
  for (const needle of sample.authorContains) {
    check(`作者含「${needle}」`, paper.authors.toLowerCase().includes(needle.toLowerCase()));
  }
  for (const needle of sample.mustContain) {
    check(`含「${needle}」`, all.includes(needle));
  }
  for (const needle of sample.mustNotContain) {
    check(`不含「${needle}」`, !all.includes(needle));
  }

  const order = orderReport(body, extracted.stream);
  const covered = coverage(body, extracted.stream);
  const madeUp = invented(body, extracted.stream);

  check("没有发明原文里没有的词", madeUp.length === 0, madeUp.slice(0, 6).join(", "));
  check(
    "段落顺序与内容流一致（回溯 < 3%）",
    order.disorder < 0.03,
    `实测 ${(order.disorder * 100).toFixed(2)}%（${order.located}/${body.length} 段可定位，${order.missing} 段定位不到）` +
      (order.backtracks.length ? `\n     ${order.backtracks.join("\n     ")}` : ""),
  );
  check("正文覆盖率高（>= 80%）", covered >= 0.8, `实测 ${(covered * 100).toFixed(1)}%`);

  /*
   * The page number is the reader's only way to check a reconstructed order, so
   * it is asserted rather than eyeballed. Two separate failures are possible: a
   * page outside the file (which is what an uninitialised `bufferPage` produced —
   * the first paragraph of every document read "第 0 页"), and a page taken from
   * the paragraph before, which happens whenever a section heading flushes the
   * buffer and the body underneath it never re-stamps the page.
   */
  const pages = paper.units.map((unit) => unit.page ?? 0);
  check(
    "每段都带页码，且页码落在文件之内",
    pages.every((p) => Number.isInteger(p) && p >= 1 && p <= extracted.pageCount),
    `实测 ${Math.min(...pages)}–${Math.max(...pages)} 页，文件共 ${extracted.pageCount} 页`,
  );
  check("第一段在第一页", pages[0] === 1, `实测第 ${pages[0]} 页`);

  /*
   * A unit that begins with a lowercase letter is half a sentence, which is the
   * defect a reader notices first and the one no other check here would catch:
   * the order is right, the words are all from the source, coverage is fine —
   * the paragraph is simply cut in the wrong place. Measured before it was
   * fixed: 7/77, 9/79 and 19/400 units.
   */
  const tails = paper.units.filter((unit) => /^[a-z]/.test(unit.original));
  check(
    "没有从半句开始的段落",
    tails.length === (sample.knownTails ?? 0),
    `${tails.length} 段小写字母开头（许可 ${(sample.knownTails ?? 0)}）：` + tails.slice(0, 3).map((u) => `${u.id}「${u.original.slice(0, 44)}」`).join(" / "),
  );
  if (sample.metadataDropped) {
    // Asserting the counter, not only the absence: "keywords:" missing from the
    // prose is also what a parser that lost the abstract looks like.
    check(
      "扉页标签被认出并剔除",
      layout.omittedMetadata >= 1,
      `实测剔除 ${layout.omittedMetadata} 段`,
    );
  }

  /*
   * A caption or footnote absorbed into a paragraph of prose: the sentence the
   * reader is following picks up a URL and then starts describing a plot. This
   * is what broke ResNet's first page — the introduction ends mid-sentence at the
   * foot of the left column, so the footnote under it and the caption of Figure 1
   * below that both landed inside the same paragraph, and the sentence resumed
   * after them.
   *
   * The hard part is not finding splices, it is not calling every cross-reference
   * one. "…is shown in Fig. 2. Formally, we consider…" has the same shape as
   * "…have also Figure 1. Training error…" — a lowercase word, the marker, a
   * number, a full stop, a capital — and only the first is a caption. So the word
   * in front of the marker has to be one that cannot introduce a reference.
   */
  const INTRODUCES_REFERENCE =
    /([,\s](?:in|of|to|by|from|as|see|with|and|or|a|an|the|this|that|these|those|both|either|per|vs|versus|illustrated|shown|depicted|described|summarized|reported|presented|given|defined|compared)\s+)((?:Figure|Fig\.?|Table)\s*\d+(?:\.\d+)*[.:]\s+[A-Z])/g;
  /** Cross-references blanked out, so only an unannounced marker can match. */
  const referencesBlanked = (text: string) => text.replace(INTRODUCES_REFERENCE, "$1\u0000");

  const SPLICED = /[a-z]\s(?:Figure|Fig\.?|Table)\s*\d+(?:\.\d+)*[.:]\s+[A-Z]/;
  const splices = paper.units.filter((unit) => {
    // Only a unit that opens like a sentence can be a paragraph of prose. The
    // furniture blocks the parser quarantines on their own — ResNet page 1 now
    // produces one that starts with a footnote URL and runs through two captions
    // — are allowed to contain whatever the page put inside them.
    if (!/^[A-Z]/.test(unit.original) || unit.original.length <= 200) return false;
    return SPLICED.test(referencesBlanked(unit.original).slice(60));
  });
  const check2 = (unit: { id: string; original: string }) => {
    const blanked = referencesBlanked(unit.original);
    const at = blanked.slice(60).search(SPLICED) + 60;
    return `${unit.id}「…${blanked.slice(Math.max(0, at - 46), at + 34)}…」`;
  };
  check(
    "正文段落里不夹图注脚注",
    splices.length === 0,
    `${splices.length} 段中途出现题注：` + splices.slice(0, 3).map(check2).join(" / "),
  );

  // The counterpart of dropping ink lines: nothing that survives may be ink.
  const scraps = paper.units.filter((unit) => {
    const words = unit.original.split(/\s+/).filter(Boolean);
    return (
      words.length > 0 &&
      words.length <= 6 &&
      words.every((word) => word.length === 1 || /^\d+(?:[.,]\d+)?%?$/.test(word))
    );
  });
  check(
    "没有只剩字符和数字的段落",
    scraps.length === 0,
    `${scraps.length} 段为碎片：` + scraps.slice(0, 4).map((u) => `${u.id}「${u.original}」`).join(" / "),
  );

  const onPage = pageReport(paper.units, extracted.runs);
  check(
    "页码与文字实际所在页一致",
    onPage.wrong === 0 && onPage.checked >= paper.units.length * 0.5,
    `${onPage.checked}/${paper.units.length} 段可唯一定位，${onPage.wrong} 段页码不符` +
      (onPage.detail.length ? `\n     ${onPage.detail.join("\n     ")}` : ""),
  );
  check(
    "跨行断词的数量写进了解析说明",
    layout.linebreakHyphens === 0 ||
      (paper.parseNotes ?? []).some((note) => note.includes("跨行断词")),
    `实测 ${layout.linebreakHyphens} 处`,
  );
  // Two documents, one promise: whatever was not read is declared. A twelve-page
  // paper is expected to reach its bibliography; a seventy-five-page paper hits
  // the import budget long before it gets there, and asserting `!budgetExhausted`
  // there tested the length of the paper, not the honesty of the parser.
  if (sample.capExpected) {
    check(
      "超出容量上限时如实说明",
      layout.budgetExhausted &&
        paper.truncated === true &&
        (paper.parseNotes ?? []).some((note) => note.includes("容量上限")),
      `上限触发 ${layout.budgetExhausted} · truncated=${paper.truncated} · 备注 ${(paper.parseNotes ?? []).length} 条`,
    );
  } else {
    check("在参考文献处截断", layout.stoppedAtReferences);
    check("未突破容量上限", !layout.budgetExhausted);
  }

  const splits = columnSplitPages(extracted.runs);
  const pagesWithText = new Set(extracted.runs.map((run) => run.page)).size;
  if (sample.expectTwoColumn) {
    check("双栏版面被识别出分栏", splits >= Math.max(1, pagesWithText * 0.4), `识别 ${splits}/${pagesWithText} 页`);
  } else {
    check("单栏版面未被误判为双栏", splits === 0, `误判 ${splits} 页`);
  }

  if (sample.file === "2005.14165.pdf") {
    check(
      "超长文档给出页数说明而不是静默截断",
      (paper.parseNotes ?? []).some((note) => note.includes("页")),
      `备注：${(paper.parseNotes ?? []).join(" / ").slice(0, 160)}`,
    );
  }

  const sections = [...new Set(paper.units.map((unit) => unit.section))];
  console.log(`     ${paper.units.length} 段 · ${sections.length} 节 · 正文 ${all.length} 字符`);
  console.log(`     章节：${sections.slice(0, 8).join(" › ")}${sections.length > 8 ? " …" : ""}`);
  console.log(`     作者：${paper.authors.slice(0, 100)}`);
  console.log(`     首段：${(body[0] ?? "").slice(0, 150)}…`);
  console.log("");
}

/* ------------------------------------------------------------------ */
/* Synthetic cases the downloads cannot produce                        */
/* ------------------------------------------------------------------ */

console.log("— 构造用例（真实下载里不存在这些版面）\n");

/**
 * A two-column page built by hand, so the expected order is known exactly.
 *
 * Geometry matters here and was wrong first: a column is 210 units wide, and at
 * 10pt a character is about 5 units, so a line of 66 units of text would have run
 * out of its own column and into the next one. The real reconstruction would then
 * have merged the two columns into a single line — which is the behaviour the
 * fixture is supposed to reject, not the behaviour it demonstrates. Every line
 * below stays inside its column, at the width a real CVPR column has.
 */
function syntheticTwoColumn() {
  const W = 612;
  const H = 792;
  const size = 10;
  const mk = (x: number, y: number, str: string, fontSize = size) => ({
    page: 1,
    x,
    y,
    // A real string's width comes from its own font metrics; here it is capped at
    // the column's text measure, which is what a printed line reports. Letting it
    // overflow would push the line's right edge into the next column and make the
    // fixture demonstrate a merge instead of the separation it tests.
    width: Math.min(str.length * 4.6, 190),
    fontSize,
    str,
    bold: false,
    fontName: "f1",
    pageWidth: W,
    pageHeight: H,
  });

  // Every line distinct: `indexOf` finds the first match, so a repeated string
  // across the two columns makes the fixture assert against the wrong line.
  const left = [
    "Left column first line, which is long enough",
    "to fill the whole measure of this column and",
    "then stops on a short line, because that is",
    "how the end of a paragraph looks on a page.",
    "The next left paragraph goes on describing",
    "something that belongs only in this column.",
    "Its final line runs short on purpose here,",
    "and nothing else follows it on the left side.",
  ];
  const right = [
    "Right column first line, which is long enough",
    "to fill the measure of the right-hand column",
    "and then stops short, which is the same cue",
    "the left column used to end its first block.",
    "A second right paragraph carries on from there",
    "with material that only ever sits over here.",
    "Its closing line breaks early, as they always",
    "do, and this is the very last line on the page.",
  ];

  const runs = [];
  let y = 700;
  for (const text of left) {
    runs.push(mk(72, y, text));
    y -= 12;
  }
  y = 700;
  for (const text of right) {
    runs.push(mk(320, y, text));
    y -= 12;
  }
  // Interleaving the two columns in the array, so nothing can pass by relying on
  // the order the fixture happened to be written in.
  runs.sort((a, b) => b.y - a.y || a.x - b.x);
  return { left, right, runs };
}

{
  const { left, right, runs } = syntheticTwoColumn();
  const ordered = orderForReading(dropRunningFurniture(toLines(runs), 1).kept);
  const texts = ordered.lines.map((line) => line.text);

  const leftAt = texts.indexOf(left[0]);
  const rightAt = texts.indexOf(right[0]);
  check("双栏构造用例：左栏先于右栏", leftAt >= 0 && rightAt > leftAt, `left=${leftAt} right=${rightAt}`);
  check(
    "双栏构造用例：左栏八行连续读完",
    left.every((text, i) => texts.indexOf(text) === leftAt + i),
    texts.map((t, i) => `${i}:${t.slice(0, 20)}`).join(" | "),
  );
  check(
    "双栏构造用例：右栏接在左栏之后",
    right.every((text, i) => texts.indexOf(text) === rightAt + i),
    texts.map((t, i) => `${i}:${t.slice(0, 20)}`).join(" | "),
  );
  check(
    "双栏构造用例：两栏的几何被认出来",
    ordered.lines.every((line) => line.column === 1 || line.column === 2),
    `栏分布 ${[...new Set(ordered.lines.map((l) => l.column))].join(",")}`,
  );
}

{
  // A superscript must not become a line of its own, or every x² in a paper
  // produces a one-character paragraph and a bogus paragraph break.
  const base = {
    page: 1,
    x: 100,
    y: 400,
    width: 120,
    fontSize: 10,
    str: "the value of x",
    bold: false,
    fontName: "f1",
    pageWidth: 612,
    pageHeight: 792,
  };
  const sup = { ...base, x: 222, y: 404, width: 6, fontSize: 7, str: "2", fontName: "f2" };
  const lines = toLines([base, sup]);
  check("上标并入所在行", lines.length === 1 && lines[0].text.includes("x2"), JSON.stringify(lines.map((l) => l.text)));
}

{
  // Two columns at the same baseline must not merge into one line, or the
  // gutter disappears and every two-column page reads across instead of down.
  const a = {
    page: 1,
    x: 72,
    y: 700,
    width: 200,
    fontSize: 10,
    str: "left column text",
    bold: false,
    fontName: "f1",
    pageWidth: 612,
    pageHeight: 792,
  };
  const b = { ...a, x: 320, width: 200, str: "right column text", fontName: "f1" };
  const lines = toLines([a, b]);
  check("同高不同栏的两段不合并成一行", lines.length === 2, JSON.stringify(lines.map((l) => l.text)));
}

{
  // A licence notice set ABOVE the title, in a larger font than the body: the
  // single most common arXiv contamination, and it has to be position, not
  // string matching, that removes it. Four paragraphs of body text follow, because
  // an import that assembles nothing is a failure to assemble and cannot prove
  // anything was filtered — which is exactly how the first version of this case
  // passed while doing nothing.
  const notice =
    "Provided proper attribution is provided, Google hereby grants permission to reproduce";
  const bodyLines = [
    ["We study a problem of great interest to the research community and describe the", "setup in full, then report what happened when we ran it."],
    ["The second paragraph exists so that the reader has something to annotate after", "the first one, in the order they were written on the page."],
    ["Nothing here is real science. The words are chosen to be ordinary prose that", "wraps across two lines and ends each paragraph on a short one."],
    ["And the fourth paragraph is the last one this fixture needs, which makes the", "count of surviving units four, and the parse worth asserting."],
  ];

  const runs = [
    {
      page: 1,
      x: 124,
      y: 710,
      width: 363,
      fontSize: 11.96,
      str: notice,
      bold: false,
      fontName: "f1",
      pageWidth: 612,
      pageHeight: 792,
    },
    {
      page: 1,
      x: 267,
      y: 696,
      width: 220,
      fontSize: 11.96,
      str: "reproduce the tables and figures in this paper.",
      bold: false,
      fontName: "f1",
      pageWidth: 612,
      pageHeight: 792,
    },
    {
      page: 1,
      x: 150,
      y: 630,
      width: 312,
      fontSize: 17.2,
      str: "A Real Paper Title",
      bold: false,
      fontName: "f2",
      pageWidth: 612,
      pageHeight: 792,
    },
  ];

  let y = 500;
  for (const [full, ragged] of bodyLines) {
    runs.push({
      page: 1,
      x: 100,
      y,
      width: 400,
      fontSize: 10,
      str: full,
      bold: false,
      fontName: "f3",
      pageWidth: 612,
      pageHeight: 792,
    });
    y -= 12;
    runs.push({
      page: 1,
      x: 100,
      y,
      width: 150,
      fontSize: 10,
      str: ragged,
      bold: false,
      fontName: "f3",
      pageWidth: 612,
      pageHeight: 792,
    });
    y -= 22;
  }

  const { paper: synthesized, layout } = buildPdfPaper(runs, () => "serif", {
    docId: "pdf-synthetic",
    fileName: "notice.pdf",
    pageCount: 1,
    pagesParsed: 1,
    metadataTitle: "",
  });
  const units = (synthesized?.units ?? []).map((unit) => unit.original);
  const text = units.join(" ").toLowerCase();

  check("构造用例：版面组装出了四段", units.length === 4, `实际 ${units.length} 段`);
  check("标题之上的授权声明被剔除", !text.includes("proper attribution"), text.slice(0, 120));
  check("标题仍被正确认出", synthesized?.title === "A Real Paper Title", String(synthesized?.title));
  check(
    "标题不会又变成第一段正文",
    !text.includes("a real paper title"),
    `首段：${(units[0] ?? "").slice(0, 80)}`,
  );
  check("正文顺序与版面一致", text.startsWith("we study a problem") && text.includes("fourth paragraph"), text.slice(0, 60));
  void layout;
}

console.log(failures === 0 ? "\n全部通过\n" : `\n${failures} 项未通过\n`);
process.exitCode = failures === 0 ? 0 : 1;
