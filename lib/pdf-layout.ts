/**
 * Turning a PDF's glyph positions back into reading order.
 *
 * Why this file exists and why it is pure
 * ---------------------------------------
 * A PDF has no paragraphs, no columns and no headings. It has a list of
 * "draw this string at this coordinate" instructions. Everything a reader
 * perceives as structure — two columns, a section title, where one paragraph
 * stops and the next begins — has to be inferred from geometry.
 *
 * That inference is the entire risk in "upload your own PDF". Get it wrong and
 * the reader gets a wall of text in the wrong order, which is worse than not
 * offering the feature. So it is isolated here as pure functions over plain
 * data: no `pdfjs-dist`, no DOM, no I/O. `lib/pdf.ts` does the extraction and
 * hands this module an array of positioned strings; this module hands back
 * ordered paragraphs.
 *
 * Being pure is not tidiness, it is testability. The project cannot run Deno
 * locally and cannot run a headless browser in CI, but it can run Node, so
 * `dev/test-pdf-layout.ts` feeds these functions synthetic two-column pages
 * and asserts the reading order that comes out. A layout bug found by a test is
 * cheap; the same bug found by a judge is not.
 *
 * Known limits, stated rather than hidden
 * ---------------------------------------
 * - A wide element in the middle of a page (a display equation, a figure, a
 *   table) is treated as a barrier that splits the columns above it from the
 *   columns below it. For a normal paper that is correct. For a page whose
 *   float sits mid-column it produces a local ordering error, not lost text.
 * - Text inside figures is whatever the figure's embedded labels happen to be,
 *   and appears where the labels sit. There is no way to tell "caption" from
 *   "in-figure annotation" geometrically.
 * - Mathematical content is not recovered as mathematics. pdf.js sees the
 *   glyphs, not the LaTeX, so an inline `$\alpha_i$` arrives as scattered
 *   characters. This module therefore extracts NO formulas, and the UI says so
 *   instead of showing empty formula cards.
 */

/** One positioned string, as reported by pdf.js. Coordinates are PDF user
 *  units with `y` measured from the BOTTOM of the page, per PDF convention. */
export interface PdfRun {
  /** 1-based. */
  page: number;
  x: number;
  /** Baseline, from the bottom of the page. */
  y: number;
  width: number;
  /** Ascender height of the run's font, used as the "size" of the text. */
  fontSize: number;
  str: string;
  bold: boolean;
  /**
   * pdf.js's internal key for the font this run was drawn with, e.g. `g_d0_f2`.
   * Carried so `classifyBoldFonts` can reason per font rather than per run, and
   * so a line can report which font dominated it.
   */
  fontName: string;
  pageWidth: number;
  pageHeight: number;
}

/** A visual line: runs that share a text band and are horizontally adjacent. */
export interface PdfLine {
  page: number;
  y: number;
  left: number;
  right: number;
  fontSize: number;
  bold: boolean;
  text: string;
  /**
   * Column assignment, set during ordering:
   *   0 = full width (single-column page, or an element spanning the gutter)
   *   1 = left column, 2 = right column
   * Used to decide whether a line "filled" its column, which is how a paragraph
   * break is distinguished from a line wrap.
   */
  column: number;
  pageWidth: number;
  pageHeight: number;
}

export interface Paragraph {
  section: string;
  sectionOrder: number;
  text: string;
  /** Page the paragraph STARTS on, for a reader who wants to check the PDF. */
  page: number;
  /**
   * Type size of the line that starts it — carried so a paragraph cut in half by
   * a figure caption can rejoin its own kind of text instead of the caption that
   * happens to sit next to it. See `isBodyType`.
   */
  size: number;
}

export interface LayoutResult {
  paragraphs: Paragraph[];
  /**
   * Set when parsing stopped early at the bibliography. Reported to the reader
   * as a deliberate omission rather than surfaced as `truncated`, which means
   * "we ran out of budget" — a different thing with a different remedy.
   */
  stoppedAtReferences: boolean;
  /**
   * Set when a cap cut the paper short: too many paragraphs, or too many
   * characters. Distinct from `stoppedAtReferences` because that one is a
   * choice and this one is a limit, and the reader should be told which.
   */
  budgetExhausted: boolean;
  /**
   * The line chosen as the document title, when one could be identified.
   * `null` means the caller should fall back to the file name AND SAY SO.
   */
  title: string | null;
  /** The title's topmost line, so a caller can see where on the page the title
   *  page begins. The author block itself is resolved before this is returned. */
  titleLine: PdfLine | null;
  /** Author block, when it could be separated from the title and abstract. */
  authors: string | null;
  /** Median body-text size, exposed so the caller can report it. */
  bodyFontSize: number;
  /** Which pages yielded no text at all — a cover image, a scanned page. */
  blankPages: number[];
  /**
   * Lines of figure and table ink that were not turned into paragraphs.
   *
   * Counted rather than boolean, so the reader is told how much of the document
   * was skipped and can tell "a dozen axis labels" from "this was a slide deck".
   */
  omittedLabels: number;
  /**
   * Front-matter index cards — "Keywords: …", "MSC 2010: …", a DOI line — that
   * were assembled and then recognised as metadata rather than prose.
   *
   * A separate number from `omittedLabels` because they are separate promises:
   * one says "the words inside your figures are not here", the other says "the
   * list of tags under your abstract is not here".
   */
  omittedMetadata: number;
  /**
   * Lines of page-foot notes that were not turned into paragraphs.
   *
   * Counted because dropping them is the one thing this module does to text the
   * author wrote as sentences. A footnote is a sentence — "To illustrate why the
   * dot products get large, assume that the components…" is 9pt of real English —
   * and it lives at the foot of the page with no place in the reading order, so
   * the reader who searches for it and finds nothing should be told where it went.
   */
  omittedFootnotes: number;
  /**
   * Times two lines were joined because the PDF broke the word at a hyphen.
   *
   * Counted because the reader sees the result and deserves the number: the
   * joined text keeps the hyphen ("ex-tremely"), which is the only thing both
   * candidate meanings have in common. Automatic hyphenation and a real compound
   * hyphen are indistinguishable in a PDF text layer, so joining by dropping the
   * hyphen would silently corrupt `state-of-the-art` to fix `ex-tremely`.
   */
  linebreakHyphens: number;
}

/*
 * There is deliberately no `abstract` here, even though `ReaderPaper` has one.
 *
 * "Abstract" is detected as a heading like any other, so the abstract arrives as
 * the first section's paragraphs and is already on the page where a reader
 * expects it, in the spine, with its own section label. Extracting it a second
 * time to render in the title block would show the same words twice on screen.
 * For an arXiv import the Function supplies `abstract` because LaTeXML marks it
 * structurally and the surrounding prose is separate; a PDF has no such markup.
 */

/* ------------------------------------------------------------------ */
/* Caps                                                                */
/* ------------------------------------------------------------------ */

/**
 * A 400-unit survey is the realistic worst case this has to survive; past that
 * the reader is not reading, they are hoarding, and localStorage pays for it.
 */
export const MAX_PARAGRAPHS = 400;
/** Mirrors the arXiv parser's own unit cap, so both paths agree. */
export const MAX_UNIT_CHARS = 4000;
/** Below this a "paragraph" is a heading fragment, a table cell or a caption
 *  stub, not prose worth annotating. */
export const MIN_PARAGRAPH_CHARS = 40;
/**
 * Total extracted characters. A normal 10-page paper is ~50k; this leaves room
 * for a thesis while keeping ten of them inside a 5 MB localStorage quota.
 */
export const MAX_TOTAL_CHARS = 300_000;

/**
 * How far a line's type size may drift from the body size before it stops
 * counting as body text, as a fraction of the body size.
 *
 * Measured on the three sample PDFs: body is 10pt (ResNet, Transformer) and
 * 11pt (the GPT-3 report); figure captions and footnotes are 7–8pt; the type set
 * inside ResNet's tables is 9.5–10pt and its display math is 9.6pt.
 *
 * 0.07 puts the captions and footnotes on the furniture side and everything
 * else on the body side, which is the wanted split. Tightening it to 0.04 to
 * catch the 9.5pt table headers made things worse rather than better — measured
 * on ResNet, one table came out as a single unit at 0.07 and as three at 0.04,
 * because a table whose rows jitter between 9.5pt and 10pt is one block when the
 * difference is ignored and a pile of fragments when it is not. The headers are
 * dealt with by `isInkUnit` instead, on the words rather than on the size.
 */
const SIZE_BODY_TOLERANCE = 0.07;

/**
 * How many furniture paragraphs a cut-off sentence may reach across on its way
 * back to the paragraph it belongs to.
 *
 * The walk stops at the first prose unit it meets, so it cannot cross a real
 * paragraph break and what it is really bounding is how big an exhibit may be.
 * Twenty-three, measured on the GPT-3 report's Figure 3.17: the prose breaks at
 * "…we did find that a nontrivial number of examples appeared in our training
 * data, and that", the figure then occupies twenty-one paragraphs of prompts and
 * completions plus two captions, and the sentence resumes with "…although models
 * did perform moderately better on data that overlapped between training and
 * testing". A window of fourteen fixed that document's Figure 3.16 and left
 * 3.17's tail stranded, so the cap is set above the larger exhibit rather than
 * tuned to the first one found. It is not a knob: anything past the cap means the
 * tail would have to cross more exhibit paragraphs than a page can hold, and
 * leaving it as its own paragraph is the honest failure.
 */
const MAX_TAIL_CROSSINGS = 40;

/**
 * True when a size is the size prose is set at.
 *
 * Binary rather than "how different are these two lines", because the pair that
 * has to be separated is prose-then-caption, and the pair that must NOT be is
 * caption-then-caption: a 7pt footnote running into an 8pt caption is two
 * furniture blocks in a row, and breaking between them buys nothing.
 */
function isBodyType(size: number, body: number): boolean {
  return Math.abs(size - body) <= body * SIZE_BODY_TOLERANCE;
}

/* ------------------------------------------------------------------ */
/* 0. Which font is the bold one                                       */
/* ------------------------------------------------------------------ */

/**
 * Infers, per font, whether it is a bold face.
 *
 * This is an INFERENCE and the code is written as if it might be wrong, because
 * it can be. pdf.js does not hand over the PostScript font name through
 * `getTextContent`: `styles[fontName].fontFamily` is only the CSS fallback
 * ("serif", "sans-serif", "monospace"), which says nothing about weight. The
 * operator-list route that would expose the real name yields no font objects at
 * all in this version.
 *
 * What is left is measurable: at the same point size, a bold face is wider per
 * character than its regular counterpart. So each font's density — total advance
 * width divided by total (characters × size) — is compared against the median of
 * the other fonts pdf.js assigned to the same CSS fallback family.
 *
 * Two guards keep a wrong answer cheap:
 *   - a font needs 200 characters of sample before it is compared at all, which
 *     excludes the two-character superscript fonts that would otherwise look
 *     wildly "wide";
 *   - `isHeading` treats `bold` as a weak signal that can only corroborate a
 *     structural one (a section number or a known heading word). A font wrongly
 *     marked bold therefore cannot promote a short body line to a heading, which
 *     is the failure that would shred every paragraph in the paper.
 */
export function classifyBoldFonts(
  runs: readonly PdfRun[],
  familyOf: (fontName: string) => string,
): Map<string, boolean> {
  interface Sample {
    advance: number;
    scaled: number;
    chars: number;
  }
  const samples = new Map<string, Sample>();
  for (const run of runs) {
    const chars = run.str.replace(/\s+/g, "").length;
    if (chars <= 0 || run.width <= 0 || run.fontSize <= 0) continue;
    const sample = samples.get(run.fontName) ?? { advance: 0, scaled: 0, chars: 0 };
    sample.advance += run.width;
    sample.scaled += chars * run.fontSize;
    sample.chars += chars;
    samples.set(run.fontName, sample);
  }

  const density = new Map<string, number>();
  const byFamily = new Map<string, Array<{ fontName: string; density: number }>>();
  for (const [fontName, sample] of samples) {
    if (sample.chars < 200) continue;
    const value = sample.advance / sample.scaled;
    if (!Number.isFinite(value) || value <= 0) continue;
    density.set(fontName, value);
    const family = familyOf(fontName) || "unknown";
    const rows = byFamily.get(family);
    if (rows) rows.push({ fontName, density: value });
    else byFamily.set(family, [{ fontName, density: value }]);
  }

  const bold = new Map<string, boolean>();
  for (const run of runs) bold.set(run.fontName, false);

  for (const rows of byFamily.values()) {
    // With one font there is nothing to compare against, so nothing is claimed.
    if (rows.length < 2) continue;
    const sorted = rows.map((row) => row.density).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median <= 0) continue;
    for (const row of rows) bold.set(row.fontName, row.density >= median * 1.06);
  }
  return bold;
}

/**
 * Returns the same runs with `bold` filled in from the per-font classification.
 *
 * A separate step rather than folded into `analyseRuns` because the caller is the
 * one holding pdf.js's `styles` table, and this module must not know pdf.js
 * exists — that is the whole reason it can be tested under Node.
 */
export function applyBoldClassification(
  runs: readonly PdfRun[],
  familyOf: (fontName: string) => string,
): PdfRun[] {
  const bold = classifyBoldFonts(runs, familyOf);
  return runs.map((run) => ({ ...run, bold: bold.get(run.fontName) === true }));
}

/* ------------------------------------------------------------------ */
/* 1. Runs -> visual lines                                             */
/* ------------------------------------------------------------------ */

/**
 * The vertical band a run occupies.
 *
 * PDF gives a baseline; the box is estimated from the font size using the
 * conventional 25% descender / 75% ascender split. Precise enough for overlap
 * tests, which is all it is used for.
 */
function boxOf(y: number, size: number): { top: number; bottom: number } {
  return { top: y + size * 0.75, bottom: y - size * 0.25 };
}

/**
 * Overlap ratio of two vertical bands, relative to the SMALLER one.
 *
 * Relative to the smaller box on purpose: that is what makes sub- and
 * superscripts join their base line instead of forming a stray line of their
 * own. A superscript raised by ~0.4em still overlaps the body glyph box by
 * roughly 75% of its own height; the line below, at 1.2em leading, overlaps by
 * zero. Comparing absolute overlap instead would merge the superscript and
 * reject nothing.
 */
function bandOverlap(a: PdfRun | PdfLine, b: PdfRun | PdfLine): number {
  const aBox = boxOf(a.y, a.fontSize);
  const bBox = boxOf(b.y, b.fontSize);
  const overlap = Math.min(aBox.top, bBox.top) - Math.max(aBox.bottom, bBox.bottom);
  if (overlap <= 0) return 0;
  const smaller = Math.min(aBox.top - aBox.bottom, bBox.top - bBox.bottom);
  return smaller > 0 ? overlap / smaller : 0;
}

const SAME_LINE_OVERLAP = 0.4;

/**
 * Horizontal gap past which two runs at the same height are NOT part of the
 * same line — they are separate columns, or separate cells of a table.
 *
 * 1.2em is comfortably above any inter-word gap in justified text (spaces at a
 * line end stretch to ~0.5em) and comfortably below a real column gutter
 * (~1.5em minimum, usually far more).
 */
function splitGap(fontSize: number): number {
  return fontSize * 1.2 + 1;
}

function rightEdgeOf(run: PdfRun): number {
  // A run can report width 0 when the font's advance widths are missing. Fall
  // back to a rough per-character estimate so a zero-width run cannot collapse
  // a whole line's right edge and fool the ragged-end test later.
  if (run.width > 0) return run.x + run.width;
  return run.x + Math.max(1, run.str.length) * run.fontSize * 0.5;
}

/**
 * Gap above which a space is inserted between two fragments, measured in ems of
 * the line's own size.
 *
 * pdf.js usually gives the word space as a run of its own, and most boundaries
 * never need this. It fires on the other case — a boundary the producer drew as
 * two separate strings with real white space between them.
 *
 * Measured against the samples: kerning inside a word stays at or below ~0.05em,
 * and the narrowest space advance in body text is about 0.25em, so 0.15em sits
 * in the empty band between them. Getting this wrong in either direction is
 * visible in the output — "RenJian" if too high, "com prehensive" if too low —
 * which is why it is a named constant rather than a number inside the loop.
 */
const INFERRED_SPACE_EM = 0.15;

/**
 * A piece of a line, remembered by position rather than by the order pdf.js drew
 * it in.
 *
 * Position is the only trustworthy evidence. On the ResNet title page the author
 * row arrives as `"Shaoqing Ren"`, `" "`, `"Jian Sun"`, and the space run's
 * `x` (391.1) is *behind* the previous run's right edge because its width is
 * measured from its own origin. Appending in stream order therefore glues
 * "Ren" to "Jian" and moves the space somewhere else in the line entirely.
 * Sorting fragments by `x` before joining makes both problems disappear, and it
 * is also what puts a superscript after its base word no matter which one the
 * content stream drew first.
 */
interface LineFragment {
  x: number;
  right: number;
  str: string;
  size: number;
}

interface MutableLine extends PdfLine {
  /** The run that anchors this line's vertical band — the largest one, so a
   *  superscript arriving first does not become the anchor. */
  anchorFontSize: number;
  fragments: LineFragment[];
}

/**
 * A run set this much below the line's own size is a super- or subscript, and
 * those hug the word they belong to instead of standing after a space — but only
 * for as far as `SCRIPT_HUG_EM` below allows.
 *
 * Without it, `x²` and `Vaswani∗` come out as "x 2" and "Vaswani ∗" whenever the
 * producer happened to leave a fraction of an em between them — which pdftex
 * does, because a superscript box is positioned by its own origin rather than by
 * the base glyph's advance. The measured case was a synthetic page, and the same
 * geometry occurs in real documents, so the exception is made here rather than by
 * tightening the space threshold for everything.
 */
const SCRIPT_SIZE_RATIO = 0.75;

/**
 * How far a script may sit from whatever precedes it and still be that word.
 *
 * The hugging rule above cannot be unconditional, because a raised subscript is
 * often positioned over the *next* glyph rather than the one it belongs to. On
 * Attention's page 5 the projections line reaches pdf.js as `R` (10pt, right edge
 * 322.8) then `model` (5pt, left edge 327.0): a 0.42em gap, and the `d` it truly
 * follows is sitting one baseline higher. Glued, the reader is handed the word
 * "Rmodel", which appears nowhere in the paper.
 *
 * 0.3em separates the two measured cases: pdftex puts a real superscript 0.2em
 * after its base ("the value of x²" → 220 then 222 at 10pt), and a displaced
 * subscript at 0.42em.
 */
const SCRIPT_HUG_EM = 0.3;

/** A fragment that is one letter on its own: a math variable inside a sentence. */
function isLoneLetter(str: string): boolean {
  return str.length === 1 && /\p{L}/u.test(str);
}

/** Joins a line's fragments left to right, inferring the spaces between them. */
function joinFragments(fragments: readonly LineFragment[], size: number): string {
  const ordered = [...fragments].sort((a, b) => a.x - b.x || a.right - b.right);
  let out = "";
  let right = Number.NEGATIVE_INFINITY;
  let previous: LineFragment | null = null;

  for (const fragment of ordered) {
    // A variable set in italic and the word after it are positioned as close as
    // kerning allows, so the em threshold below never fires and the reader sees
    // "njobs". Measured in GPT-3. A single letter beside a word is always a
    // boundary, so it gets a space on its own evidence rather than on the gap.
    const variableBoundary = isLoneLetter(fragment.str) || (previous !== null && isLoneLetter(previous.str));
    const gap = fragment.x - right;
    // Small and close: the suffix of the word before it, which no space rule
    // applies to. Small and far: a script that belongs to something the producer
    // drew elsewhere, and it is separated like any other token.
    const hugs = fragment.size < size * SCRIPT_SIZE_RATIO && gap <= size * SCRIPT_HUG_EM;
    const needsSpace =
      out.length > 0 &&
      !hugs &&
      (gap > size * INFERRED_SPACE_EM || variableBoundary) &&
      !out.endsWith(" ") &&
      !fragment.str.startsWith(" ");
    if (needsSpace) out += " ";
    out += fragment.str;
    if (fragment.right > right) right = fragment.right;
    previous = fragment;
  }
  return out;
}

/**
 * Groups positioned runs into visual lines.
 *
 * Two passes, because neither ordering alone works:
 *   - sort by descending baseline so a line is built top-down;
 *   - cluster on vertical band overlap against the line's largest run;
 *   - split a cluster when the horizontal gap exceeds `splitGap`, which is what
 *     keeps two columns from becoming one very long line.
 *
 * Text is not assembled until the end (see `LineFragment`), so the sort order of
 * the content stream cannot leak into the reading order of a line.
 */
export function toLines(runs: readonly PdfRun[]): PdfLine[] {
  const sorted = [...runs]
    .filter((run) => run.str && run.str.length > 0)
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);

  const lines: MutableLine[] = [];

  for (const run of sorted) {
    const right = rightEdgeOf(run);
    // Only the immediately preceding lines are candidates: the sort guarantees
    // anything further back is on a lower band. Bounded, so this stays linear
    // on a 4000-run page.
    let placed = false;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 12; i -= 1) {
      const line = lines[i];
      if (line.page !== run.page) continue;
      if (bandOverlap(line, run) < SAME_LINE_OVERLAP) continue;

      const size = Math.max(run.fontSize, line.fontSize);
      if (Math.max(run.x - line.right, line.left - right) > splitGap(size)) continue;

      line.fragments.push({ x: run.x, right, str: run.str, size: run.fontSize });
      line.left = Math.min(line.left, run.x);
      line.right = Math.max(line.right, right);
      if (run.fontSize > line.anchorFontSize) {
        line.anchorFontSize = run.fontSize;
        line.fontSize = run.fontSize;
        line.y = run.y;
      }
      line.bold = line.bold || (run.bold && run.str.trim().length > 0);
      placed = true;
      break;
    }

    if (!placed) {
      lines.push({
        page: run.page,
        y: run.y,
        left: run.x,
        right,
        fontSize: run.fontSize,
        bold: run.bold,
        text: "",
        column: 0,
        pageWidth: run.pageWidth,
        pageHeight: run.pageHeight,
        anchorFontSize: run.fontSize,
        fragments: [{ x: run.x, right, str: run.str, size: run.fontSize }],
      });
    }
  }

  return lines
    .map(({ anchorFontSize: _anchor, fragments, ...line }) => ({
      ...line,
      text: joinFragments(fragments, line.fontSize).replace(/\s+/g, " ").trim(),
    }))
    .filter((line) => line.text.length > 0)
    .sort((a, b) => a.page - b.page || b.y - a.y || a.left - b.left);
}

/* ------------------------------------------------------------------ */
/* 2. Body font size                                                   */
/* ------------------------------------------------------------------ */

/**
 * Character-weighted median line height.
 *
 * Weighted because a page has few heading lines and many body lines, but the
 * headings are the ones an unweighted median-of-lines could drift toward on a
 * page that is mostly a figure. Counting characters makes body text dominate by
 * construction, which is the definition we actually want.
 */
export function bodyFontSize(lines: readonly PdfLine[]): number {
  const weighted: number[] = [];
  for (const line of lines) {
    const size = Math.round(line.fontSize * 10) / 10;
    // Capped per line so one 900-character table row cannot outvote the page.
    const weight = Math.min(line.text.length, 200);
    for (let i = 0; i < Math.ceil(weight / 8); i += 1) weighted.push(size);
  }
  if (weighted.length === 0) return 10;
  weighted.sort((a, b) => a - b);
  return weighted[Math.floor(weighted.length / 2)];
}

/* ------------------------------------------------------------------ */
/* 3. Running furniture                                                */
/* ------------------------------------------------------------------ */

/** Digits folded to `#` so "1234" and "1235" are the same page number. */
function normalizeFurniture(text: string): string {
  return text.replace(/[0-9]+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Removes headers, footers, page numbers and margin watermarks.
 *
 * Two independent tests, because either alone is wrong:
 *   - Repetition. A string in the top or bottom margin band that appears on at
 *     least half the pages is a running head. Digits are folded first, so a
 *     page number counts as a repeat of itself.
 *   - Position. Anything in the outer margin bands that is a bare number, or a
 *     single short token, goes. This catches the first and last page, where a
 *     running head appears only once and repetition cannot see it.
 *
 * The arXiv left-margin watermark ("arXiv:1706.03762v7 [cs.CL] 2 Aug 2023") is
 * set rotated, so pdf.js reports it as runs whose box is tall and narrow in the
 * left few percent of the page. That is caught by the margin-band test.
 */
export function dropRunningFurniture(
  lines: readonly PdfLine[],
  pageCount: number,
): { kept: PdfLine[]; dropped: string[] } {
  if (pageCount < 2) return { kept: [...lines], dropped: [] };

  const counts = new Map<string, number>();
  const inMarginBand = (line: PdfLine): boolean => {
    // Baseline is from the bottom, so the footer band is small `y` and the
    // header band is `y` near the page height. 9% of the page height is enough
    // to include a two-line footer without eating the first body line.
    const band = line.pageHeight * 0.09;
    return line.y < band || line.y > line.pageHeight - band;
  };
  const inSideMargin = (line: PdfLine): boolean => {
    const band = line.pageWidth * 0.07;
    return line.right < band || line.left > line.pageWidth - band;
  };

  for (const line of lines) {
    if (!inMarginBand(line) || line.text.length > 90) continue;
    const key = normalizeFurniture(line.text);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const threshold = Math.max(2, Math.ceil(pageCount * 0.5));
  const repeated = new Set([...counts].filter(([, n]) => n >= threshold).map(([key]) => key));

  const kept: PdfLine[] = [];
  const dropped: string[] = [];
  for (const line of lines) {
    const key = normalizeFurniture(line.text);
    const bareNumber = /^[#]+$/.test(key) || /^page\s*#$/.test(key) || /^#\s*of\s*#$/.test(key);
    const isFurniture =
      inSideMargin(line) ||
      (inMarginBand(line) && (repeated.has(key) || bareNumber || line.text.length <= 3));

    if (isFurniture) {
      if (dropped.length < 12) dropped.push(line.text.slice(0, 60));
      continue;
    }
    kept.push(line);
  }
  return { kept, dropped };
}

/* ------------------------------------------------------------------ */
/* 4. Column detection and reading order                               */
/* ------------------------------------------------------------------ */

const GUTTER_BUCKET = 4;

/** A line counts as spanning the page when it crosses this much of the middle. */
const CENTRE_LEFT = 0.42;
const CENTRE_RIGHT = 0.58;

/**
 * Whether a line is wide enough to be a full-width object rather than a column.
 *
 * On the measured two-column pages a column ends at ~0.47 of the page width and
 * the next column starts at ~0.53, so a line that both starts left of 0.42 and
 * reaches past 0.58 is not in a column at all — it is a table row, a spanning
 * figure, or a centric equation.
 */
function crossesCentre(line: PdfLine, pageWidth: number): boolean {
  return line.left < pageWidth * CENTRE_LEFT && line.right > pageWidth * CENTRE_RIGHT;
}

/** Floor on the lines needed to judge a gutter from the narrowed set. */
const GUTTER_MIN_LINES = 8;

/**
 * How much of the page the narrowed set must still account for to be trusted.
 *
 * Below this the page is mostly spanning content — a poster slide, a table with
 * two lines of note under it — and letting a handful of stray fragments define
 * the reading order is worse than reading the page top-down.
 */
const GUTTER_MIN_SHARE = 0.2;

/**
 * How far from a quiet run's border a column's edge is still the same column.
 *
 * 24pt covers the case that matters: a page whose left column is a figure and
 * whose right column is prose, where the white strip the projection finds runs
 * from the figure's ink out to the prose margin, and the prose margin — the only
 * hard edge on the page — sits 30pt inside it.
 */
const GUTTER_NEIGHBOURHOOD = 24;

/** Two edges this far apart are the same margin; justified text aligns to a point. */
const EDGE_TOLERANCE = 3;

/** A margin needs this many lines behind it to be a margin at all. */
const EDGE_MIN_LINES = 4;

/** A gutter wider than this fraction of the page is two pages, not two columns. */
const GUTTER_MAX_WIDTH = 0.18;

/**
 * Where in the page a column split is allowed to be, as a fraction of the width.
 *
 * A journal or conference two-column layout splits near the middle; measured
 * gutters in the samples sit at 0.46-0.50. Anything found closer to the margin
 * than this is a figure's internal white space (ResNet page 4 has a 43pt strip at
 * 0.33 of the width, inside Figure 3) or a side note, and splitting there
 * reorders real prose into nonsense.
 */
const GUTTER_CENTRE_MIN = 0.38;
const GUTTER_CENTRE_MAX = 0.66;

/** Counts how many of `values` fall within EDGE_TOLERANCE of `at`. */
function edgeSupport(values: readonly number[], at: number): number {
  let n = 0;
  for (const value of values) if (Math.abs(value - at) <= EDGE_TOLERANCE) n += 1;
  return n;
}

/**
 * The outermost position inside the window that a repeated edge supports.
 *
 * `preferOuter` looks for the edge furthest from the gutter — the right edge of
 * the left column, or the left edge of the right column. Taking the *mode* of the
 * window instead is what produced a wrong answer on ResNet page 4: Figure 3 fills
 * that column and 30 of its labels end at x=252, so the mode said 252 while the
 * caption — real text, the only thing with a margin — ends at 286. Taking the
 * outermost supported edge says 286, which is the column.
 */
function marginAt(
  values: readonly number[],
  from: number,
  to: number,
  minLines: number,
  preferOuter: boolean,
): number | null {
  const sorted = [...values].sort((a, b) => (preferOuter ? b - a : a - b));
  for (const value of sorted) {
    if (value < from || value > to) continue;
    if (edgeSupport(values, value) >= minLines) return value;
  }
  return null;
}

/**
 * Finds the vertical white space between two columns, or null.
 *
 * A horizontal projection finds the quiet strips, and then — this is the part
 * that took three measured revisions — the gutter's position is taken from the
 * two column *edges* around the strip rather than from the strip's centre. Three
 * separate real failures are behind that:
 *
 *   1. A full-width table or figure covers the strip the gutter is made of, so
 *      the projection finds nothing quiet on the page at all, and the WHOLE page
 *      reads across instead of down. Measured on ResNet, where Table 1 spans:
 *      "34-layer plain net has higher training error throughout the for increasing
 *      dimensions (option A). So they have no extra" — two columns' lines glued
 *      mid-sentence. Fix: judge the projection from column-sized lines only.
 *   2. Excluding spanning lines from the *judgement* does not exclude them from
 *      the *output*: they are still ordered, and `orderPage` treats them as band
 *      barriers, which is how a reader moves from prose to a table and back.
 *   3. On a page whose left column is a figure, the quiet strip starts at the
 *      figure's ink rather than at the column's right margin (ResNet page 4: the
 *      strip is 256-308, the caption ends at 286). Its centre, 282, is *inside*
 *      the left column, so the caption lines straddle it, become "spanning", and
 *      are emitted between the two halves of a sentence the reader was following.
 *      Fix: snap to the edges.
 *
 * The both-sides requirement is what keeps a single-column page from being split
 * at all: a single-column page has an empty right region on ragged-right text,
 * and one reordered single-column page is worse than a missed two-column page.
 */
function detectGutter(lines: readonly PdfLine[], pageWidth: number): number | null {
  if (lines.length < 10 || pageWidth <= 0) return null;

  const columnar = lines.filter((line) => !crossesCentre(line, pageWidth));
  const basis =
    columnar.length >= GUTTER_MIN_LINES && columnar.length >= lines.length * GUTTER_MIN_SHARE
      ? columnar
      : lines;

  const bucketCount = Math.max(1, Math.ceil(pageWidth / GUTTER_BUCKET));
  const cover = new Array<number>(bucketCount).fill(0);
  for (const line of basis) {
    const from = Math.max(0, Math.min(bucketCount - 1, Math.floor(line.left / GUTTER_BUCKET)));
    const to = Math.max(0, Math.min(bucketCount - 1, Math.floor(line.right / GUTTER_BUCKET)));
    for (let i = from; i <= to; i += 1) cover[i] += 1;
  }

  // "Near-empty" relative to the page's own line count: a table-heavy page has
  // more coverage everywhere than a prose page, so an absolute cutoff would
  // find a gutter on one and not the other.
  const quiet = Math.max(1, basis.length * 0.04);
  const lo = Math.floor(bucketCount * 0.3);
  const hi = Math.ceil(bucketCount * 0.72);

  const rightEdges = basis.map((line) => line.right);
  const leftEdges = basis.map((line) => line.left);
  // A column of body text is many lines deep; a strip inside a figure is a
  // handful of labels. The right column has to clear this bar, and the left one
  // only EDGE_MIN_LINES, because a figure column legitimately has few long lines.
  const minRight = Math.max(EDGE_MIN_LINES + 2, basis.length * 0.1);

  let best: { at: number; support: number } | null = null;

  let i = lo;
  while (i <= hi) {
    if (cover[i] > quiet) {
      i += 1;
      continue;
    }
    let j = i;
    while (j <= hi && cover[j] <= quiet) j += 1;
    const from = i * GUTTER_BUCKET;
    const to = j * GUTTER_BUCKET;

    const leftMargin = marginAt(rightEdges, from - GUTTER_NEIGHBOURHOOD, to, EDGE_MIN_LINES, true);
    const rightMargin = marginAt(leftEdges, from, to + GUTTER_NEIGHBOURHOOD, minRight, false);
    if (leftMargin !== null && rightMargin !== null) {
      const strip = rightMargin - leftMargin;
      const centre = (leftMargin + rightMargin) / 2;
      if (
        strip >= 6 &&
        strip <= pageWidth * GUTTER_MAX_WIDTH &&
        centre >= pageWidth * GUTTER_CENTRE_MIN &&
        centre <= pageWidth * GUTTER_CENTRE_MAX
      ) {
        const support = Math.min(edgeSupport(rightEdges, leftMargin), edgeSupport(leftEdges, rightMargin));
        if (best === null || support > best.support) best = { at: centre, support };
      }
    }
    i = j;
  }

  return best ? best.at : null;
}


/** Sorts top-down, then left-to-right, matching how a person reads. */
function byReadingPosition(a: PdfLine, b: PdfLine): number {
  return b.y - a.y || a.left - b.left;
}

/**
 * Orders one page's lines.
 *
 * When a gutter exists, lines that span it (a title, a section heading, a wide
 * equation, a figure) become band boundaries: everything above such a line is
 * read left-column-then-right-column, then the spanning line, then the next
 * band. That is how a real two-column page reads, and it is what keeps a section
 * heading from being emitted after the paragraph it introduces.
 */
function orderPage(lines: PdfLine[], gutter: number | null): PdfLine[] {
  if (gutter === null) {
    return lines.map((line) => ({ ...line, column: 0 })).sort(byReadingPosition);
  }

  const tolerance = 2;
  const spanning: PdfLine[] = [];
  const left: PdfLine[] = [];
  const right: PdfLine[] = [];

  for (const line of lines) {
    if (line.left < gutter - tolerance && line.right > gutter + tolerance) {
      spanning.push({ ...line, column: 0 });
    } else if ((line.left + line.right) / 2 < gutter) {
      left.push({ ...line, column: 1 });
    } else {
      right.push({ ...line, column: 2 });
    }
  }

  spanning.sort(byReadingPosition);
  left.sort(byReadingPosition);
  right.sort(byReadingPosition);

  /** Lines strictly between two spanning lines, or outside them at the ends. */
  const between = (rows: PdfLine[], above: number | null, below: number | null): PdfLine[] =>
    rows.filter((row) => (above === null || row.y < above) && (below === null || row.y > below));

  const out: PdfLine[] = [];
  let upper: number | null = null;
  for (const barrier of spanning) {
    out.push(...between(left, upper, barrier.y));
    out.push(...between(right, upper, barrier.y));
    out.push(barrier);
    upper = barrier.y;
  }
  out.push(...between(left, upper, null));
  out.push(...between(right, upper, null));
  return out;
}

/**
 * Orders every page, and records per-(page, column) measurements the paragraph
 * pass needs: the column's right edge and its typical leading.
 */
export interface OrderedLayout {
  lines: PdfLine[];
  /** 90th-percentile right edge for each `page:column` — "full" for that column. */
  columnRight: Map<string, number>;
  /** Median baseline-to-baseline distance for each `page:column`. */
  columnLeading: Map<string, number>;
}

function percentile(values: number[], at: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))];
}

export function orderForReading(lines: readonly PdfLine[]): OrderedLayout {
  const pages = new Map<number, PdfLine[]>();
  for (const line of lines) {
    const rows = pages.get(line.page);
    if (rows) rows.push(line);
    else pages.set(line.page, [line]);
  }

  const ordered: PdfLine[] = [];
  const columnRight = new Map<string, number>();
  const columnLeading = new Map<string, number>();

  for (const page of [...pages.keys()].sort((a, b) => a - b)) {
    const pageLines = pages.get(page)!;
    const pageWidth = pageLines[0]?.pageWidth ?? 0;
    const gutter = detectGutter(pageLines, pageWidth);
    const placed = orderPage(pageLines, gutter);
    ordered.push(...placed);

    const groups = new Map<string, PdfLine[]>();
    for (const line of placed) {
      const key = `${line.page}:${line.column}`;
      const rows = groups.get(key);
      if (rows) rows.push(line);
      else groups.set(key, [line]);
    }
    for (const [key, rows] of groups) {
      columnRight.set(key, percentile(rows.map((row) => row.right), 0.9));
      // Leading is only meaningful between lines in the same column, in order.
      const gaps: number[] = [];
      for (let i = 1; i < rows.length; i += 1) {
        const gap = rows[i - 1].y - rows[i].y;
        if (gap > 0 && gap < rows[i].fontSize * 4) gaps.push(gap);
      }
      columnLeading.set(key, gaps.length ? percentile(gaps, 0.5) : rows[0].fontSize * 1.2);
    }
  }

  return { lines: ordered, columnRight, columnLeading };
}

/**
 * Removes the title page from the prose.
 *
 * Two different things live here, and both were measured on the sample PDFs.
 *
 * The first is boilerplate ABOVE the title. arXiv stamps every preprint it
 * generates with a licence notice — "Provided proper attribution is provided,
 * Google hereby grants permission to…" — set in a font LARGER than the body text
 * and placed at the very top of page 1. It is not the authors' prose, and a
 * reader who selects it and asks for an explanation gets an answer about arXiv's
 * terms instead of about the paper. The arXiv HTML path filters it by class
 * name; a PDF has no class names, only position, and position is enough.
 *
 * The second is the title block itself: the title line and everything
 * `collectTitlePage` recognised as names, affiliations or addresses. Those words
 * belong in the header of the reader. Showing them again as the first paragraph
 * of the body is exactly what happened before they were removed here — the
 * Transformer paper opened with a paragraph of its own authors, e-mail addresses
 * and "Google Brain".
 *
 * Bounded twice over: only lines above the identified title, and only inside the
 * top quarter of the page. If the title was not found, no positional filtering
 * happens at all — losing a licence notice is a small harm and losing the first
 * paragraph of a paper is not, so the pass fails toward keeping.
 */
export function dropFrontMatter(
  lines: readonly PdfLine[],
  titleLine: PdfLine | null,
  titlePage?: ReadonlySet<PdfLine>,
): PdfLine[] {
  return lines.filter((line) => {
    if (titlePage?.has(line)) return false;
    if (!titleLine || line.page !== titleLine.page) return true;
    return !(line.y > titleLine.y && line.y > titleLine.pageHeight * 0.75);
  });
}

/**
 * Drops footnote blocks.
 *
 * A footnote is three conditions together, because any one of them alone
 * describes ordinary body text:
 *   - set smaller than the body,
 *   - separated from the line above it by a gap much larger than the leading —
 *     the whitespace and rule the author put there on purpose,
 *   - running down to the bottom of the page.
 *
 * The block, and not the line, is the unit being tested. That is a measured
 * correction: the per-line version demanded the bottom fifth of the page, and the
 * "Equal contribution. Listing order is random…" block on the Transformer title
 * page sits well above that, under a short abstract. Line by line it was
 * unrecognisable; as a small-typed block that runs to the foot of the page and
 * begins after a gap, it is obvious.
 *
 * Requiring EVERY line of the block to be small is what keeps prose safe. A body
 * paragraph that happens to end near the bottom of a page is not small, so it
 * cannot start a block; and a heading inside the candidate block aborts it,
 * because a heading belongs to the article rather than to the note.
 */
const SMALL_FOOTNOTE_RATIO = 0.92;
const FOOTNOTE_BOTTOM = 0.3;

/**
 * How a footnote marker looks once extraction has flattened it.
 *
 * Either a marker glyph with the note's first word after it — "? Paper published
 * in…" — or a superscript number welded to the word it annotates, because the
 * baseline information is in the font size and not in the text: "1University of
 * Toronto.". A space after the digits would make it a list item or a page number
 * instead, so this is deliberately the welded shape only.
 */
const MARKER_OPEN = /^(?:[\u002a\u0023\u005e\u00a7\u00b6\u2020\u2021\u2217\u2225?]|["'\u201c\u2018]\d{1,2}|\d{1,2}[A-Za-z\u00c0-\u024f])/;

export function dropFootnotes(
  layout: OrderedLayout,
  body: number,
): { kept: PdfLine[]; dropped: number } {
  const { lines, columnLeading } = layout;
  const kept: PdfLine[] = [];
  let dropped = 0;

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.fontSize > body * SMALL_FOOTNOTE_RATIO) {
      kept.push(line);
      index += 1;
      continue;
    }

    // The maximal run of small lines on this page, in reading order.
    let end = index;
    while (
      end < lines.length &&
      lines[end].page === line.page &&
      lines[end].fontSize <= body * SMALL_FOOTNOTE_RATIO
    ) {
      end += 1;
    }
    const block = lines.slice(index, end);

    const above = lines[index - 1];
    const gap = above && above.page === line.page ? above.y - line.y : 0;
    /*
     * The gap is measured against the body's rhythm, not this page's.
     *
     * `columnLeading` is the median line distance of the column it is asked
     * about, and on the pages that actually have footnotes that is the body's own
     * leading. On a cover page it is not: arXiv 2012.11542 opens with a title
     * block, a date, two affiliations and nothing else, so page 1's median is
     * 24.9pt against a 12pt body, and 1.8 times that is a gap no footnote on any
     * other page of the document could clear. The affiliation pair at the foot of
     * that page survived as the paper's third paragraph because the spacing it
     * was judged by belonged to a page that is not typesetting prose.
     *
     * Capping at 1.4 times the body size can only ever make this rule see more,
     * never less: a page genuinely set that loose is a page whose own idea of
     * "normal" says nothing about a footnote.
     */
    const leading = Math.min(columnLeading.get(`${line.page}:${line.column}`) ?? body * 1.2, body * 1.4);
    const separated = gap > leading * 1.8;
    const nearFoot = block[block.length - 1].y < line.pageHeight * FOOTNOTE_BOTTOM;
    /*
     * A note that begins with a marker is a note even where the template left no
     * gap above it.
     *
     * arXiv 2012.11922 is the case: its page-foot note — "Paper published in
     * Advanced Analysis and Learning on Temporal Data. AALTD 2015. Lecture Notes
     * in Computer Science, vol 9785. Springer, Cham. https://doi.org/…" — sits 23pt
     * under the last body line of a 12pt document, which is 1.3 leading and
     * therefore under the 1.8 the gap test wants, and it became the third
     * paragraph of the reader's paper. What does identify it is the marker, which
     * extraction flattens onto the baseline: the line opens with "?" because the
     * superscript it belongs to is drawn as ordinary text.
     *
     * The marker has to be at the front of the block. A small-typed paragraph
     * that merely mentions a number is not a note, which is why this is an OR on
     * the gap test and not a replacement for it: every line still has to be
     * small, the block still has to reach the foot, and a heading inside it still
     * aborts it.
     */
    const marked = MARKER_OPEN.test(block[0].text.trim());
    const isNote = (separated || marked) && nearFoot && !block.some((row) => isHeading(row, body));

    if (isNote) dropped += block.length;
    else kept.push(...block);
    index = end;
  }
  return { kept, dropped };
}

/* ------------------------------------------------------------------ */
/* 4b. Tables of contents                                              */
/* ------------------------------------------------------------------ */

/** Leader dots — ". . . . . ." A typographic device with exactly one use. */
const LEADER_DOTS = /(?:\s?\.\s?){5,}/;

/** A line that ends in a bare number, which in a contents page is the page. */
const ENDS_WITH_PAGE_NUMBER = /(?:\s|\[)\d{1,4}\]?$/;

/**
 * Drops a table of contents.
 *
 * GPT-3 has one, and it is the worst kind of thing a spine can contain: every
 * entry looks exactly like a section heading, so the first pass filed the whole
 * paper under sections called "2 Approach 6" and "3 Results 10" — numbers that
 * are page references, not section numbers, and a reader following them lands in
 * the wrong place every time.
 *
 * One entry is not enough evidence, and a leader dot is not either: the level-1
 * lines of a real contents page use a wide space instead of dots, so the pattern
 * has to be the BLOCK. Four or more consecutive lines that each end in a bare
 * number, at least two fifths of them carrying leader dots, on one page.
 *
 * The leader-dot requirement is what keeps a bibliography out of the blast
 * radius. Reference lines end in a year, which is a bare number, but no
 * reference style fills its lines with dots; and in any case the walk stops at
 * the References heading before it reaches them.
 */
export function dropContents(layout: OrderedLayout): { kept: PdfLine[]; dropped: number } {
  const { lines } = layout;
  const kept: PdfLine[] = [];
  let dropped = 0;

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!ENDS_WITH_PAGE_NUMBER.test(line.text)) {
      kept.push(line);
      index += 1;
      continue;
    }

    let end = index;
    while (
      end < lines.length &&
      lines[end].page === line.page &&
      ENDS_WITH_PAGE_NUMBER.test(lines[end].text)
    ) {
      end += 1;
    }
    const block = lines.slice(index, end);
    const leaders = block.filter((row) => LEADER_DOTS.test(row.text)).length;

    if (block.length >= 4 && leaders >= block.length * 0.4) dropped += block.length;
    else kept.push(...block);
    index = end;
  }

  return { kept, dropped };
}

/* ------------------------------------------------------------------ */
/* 4c. The ink inside figures and tables                               */
/* ------------------------------------------------------------------ */

/**
 * The closed class of English — the words a sentence cannot be built without.
 *
 * This is the test that separates prose from figure and table ink, and the
 * measurement behind it is on the ResNet sample, which contains every kind of
 * page a two-column paper gets: 110 lines of Figure 3's internals, Table 1's
 * cell grid, axis labels, and normal prose. Every one of those ink lines
 * contains ZERO of these words. Every body line contains at least one, and
 * usually three to six. Words like "output", "layer", "method" are deliberately
 * NOT here: they are content words, they appear in both, and a test that leans on
 * them cannot tell a table from a sentence.
 *
 * Numerals are not here either, for the same reason — "28.07" is a table cell and
 * "4.49%" is a sentence, and both are numbers.
 */
const FUNCTION_WORDS = new Set(
  "a an the and or but if then than that this these those there here which who whom whose what when where why how is are was were be been being am it its their they we our us you he she me him her them my your his of in on at to for from by with as into onto over under above below between among within without across per via up down out off again further once also only just very too quite not no yes do does did done have has had having will would shall should can could may might must each every some any all both few more most other others another such own same because while although though however therefore thus hence during against about like unlike whether either neither first second third".split(
    " ",
  ),
);

/** A line longer than this is prose no matter what it is made of. */
const INK_MAX_WORDS = 8;

/**
 * How many consecutive ink lines make a block.
 *
 * Five, because prose does produce a short line with no function word in it —
 * ResNet page 7 ends a wrapped sentence with "lion FLOPs)." — and one such line
 * among body text is not evidence of anything. A figure or a table produces tens
 * of them in a row. The block requirement is what makes the whole test safe
 * enough to delete text with.
 */
const INK_MIN_BLOCK = 5;

/**
 * True when the line reads as a table cell or an axis tick rather than a
 * sentence: short, no closed-class word in it, and carrying a numeral.
 *
 * The numeral test is not decoration. Attention's page 5 sets its multi-head
 * projections as six consecutive lines — "i ∈d", "Rmodel×dk ,", "i ∈d", … — which
 * have no function word in them either, and a pass that stopped at that signal
 * deleted a sentence of the paper and left the reader with
 * "…matrices W i and W ∈ R". Those fragments contain no digit; every one of
 * ResNet's 110 Figure-3 lines and every table row does. That is the difference
 * between mathematics and ink: mathematics is still part of what the authors
 * wrote.
 */
/**
 * True when no token of the text is a closed-class English word.
 *
 * Extracted from `isInkLine` unchanged — the per-token strip is what makes
 * "models." count as "model"-adjacent rather than as itself.
 */
function hasFunctionWord(text: string): boolean {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .some((word) => FUNCTION_WORDS.has(word.toLowerCase().replace(/[^a-z']/g, "")));
}

function isInkLine(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > INK_MAX_WORDS) return false;
  if (!/\d/.test(text)) return false;
  return !hasFunctionWord(text);
}

/**
 * Drops the text drawn inside figures and tables.
 *
 * A reader asked to select a sentence gets no sentence out of this:
 *
 *   "VGG-16 [41] 28.07 9.33 GoogLeNet [44] - 9.15 PReLU-net [13] 24.27 7.38"
 *   "1×1, 64 1×1, 64 1×1, 64 conv2 x 56×56 3×3, 64 ×2 3×3, 64 ×3"
 *
 * which is what ResNet's Tables 1-6 and Figures 3-7 contribute to the extracted
 * text. They are also the reason the reading order looked broken after the column
 * bug was fixed: a run of cell text sits between two lines of one sentence, so
 * the paragraph pass cut the sentence in half and the second half appeared after
 * material that comes later on the page.
 *
 * Captions survive. "Figure 4. Training on ImageNet. Thin curves denote training
 * error, and bold curves denote validation error of the center crops." is a
 * sentence the authors wrote, and a reader who cannot see the figure still learns
 * what it shows. That is what the two signals buy — no closed-class word, and a
 * numeral —: they separate what a cell contains from what a person wrote, not
 * "important" from "unimportant".
 *
 * What is lost is the numbers themselves: 98 of ResNet's ink lines go. The 14
 * short lines on that document that carry no numeral are deliberately kept, and
 * measured — they are "References", "PASCAL VOC", "# filters", "lion FLOPs)." and
 * wrapped prose of that kind. Keeping a few table headers is the cheaper
 * mistake, because deleting a heading costs the reader the shape of the paper.
 * This pass reports its own count rather than hiding it; a reading aid that shows
 * a table's cells as a paragraph teaches nothing and looks broken.
 */
export function dropLabels(
  layout: OrderedLayout,
  body: number,
): { kept: PdfLine[]; dropped: number } {
  const { lines } = layout;
  const kept: PdfLine[] = [];
  let dropped = 0;

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!isInkLine(line.text)) {
      kept.push(line);
      index += 1;
      continue;
    }

    let end = index;
    while (
      end < lines.length &&
      lines[end].page === line.page &&
      lines[end].column === line.column &&
      isInkLine(lines[end].text)
    ) {
      end += 1;
    }
    const block = lines.slice(index, end);

    // A run of headings is a contents page or a slide, not a figure; both are
    // handled elsewhere, and neither is this pass's business to delete.
    if (block.length >= INK_MIN_BLOCK && !block.some((row) => isHeading(row, body))) {
      dropped += block.length;
    } else {
      kept.push(...block);
    }
    index = end;
  }

  return { kept, dropped };
}

/* ------------------------------------------------------------------ */
/* 5. Headings, sections, paragraphs                                   */
/* ------------------------------------------------------------------ */

/**
 * A section number at the start of a line: "1", "3.2", "A.1", "ii.", "B.".
 *
 * Written to reject the things that look like one and are not. `\d{1,2}` rather
 * than `\d+` so a line beginning "2012 was a good year" cannot match after
 * backtracking; a mandatory point after a roman numeral or a single letter so
 * "I think that" and "A simple approach" cannot match; and a required capital or
 * digit after the number, so "12 monkeys were used" cannot match either.
 */
const SECTION_NUMBER =
  /^(?:\d{1,2}(?:\.\d{1,2}){0,2}\.?\s+[A-Z0-9]|[ivxlcdm]{1,5}\.\s+[A-Z]|[A-Z]\.\s+[A-Z])/;

const KNOWN_HEADING =
  /^(abstract|introduction|background|related\s+work|prior\s+work|method(?:ology|s)?|approach|model|framework|experiments?|experimental\s+(?:setup|results)|evaluation|results?(?:\s+and\s+discussion)?|discussion|conclusions?(?:\s+and\s+future\s+work)?|summary|limitations?|appendix|acknowledg(?:e|ements)|references|bibliography)\b/i;

/**
 * One of these words alone on a line is a heading whatever font it is set in.
 * Every paper that has an abstract labels it "Abstract"; the same holds for the
 * bibliography. Matching the WHOLE line is what makes this safe — a sentence
 * that merely begins with the word cannot match.
 */
const FULL_LINE_HEADING =
  /^(?:abstract|introduction|background|methods?|methodology|experiments?|results?|discussion|conclusions?|summary|limitations?|appendix|acknowledgements?|references|bibliography)$/i;

const REFERENCES_HEADING = /^(?:(?:\d{1,2}(?:\.\d{1,2})*|[ivxlcdm]{1,5}|[A-Z])\.?\s+)?(references|bibliography)\s*$/i;

/** Operators never belong in a section title, but they fill a table or an
 *  equation. The measured false heading this catches is `model .= 512`, one row
 *  of the Transformer paper's hyper-parameter table. */
const MATH_OPERATOR_CHARS = "=<>|\\_{}()[]≈±×÷∞∑∏√";

/** A page number sitting at the end of a line is a contents entry, never a title. */
const TRAILING_BARE_NUMBER = /(?:\s|\.)\d{1,4}\.?$/;

/**
 * A single letter alone in the line is a variable, never a title.
 *
 * "A" and "I" are excluded because they are words: without that, the very common
 * heading "A Simple Framework for…" would be rejected by its own first letter.
 */
const LONE_LETTER = /(?:^|\s)(?![AI](?:\s|$))[A-Za-z](?:\s|$)/;

/**
 * Does this line read as mathematics, a table row or a contents entry rather
 * than as a title?
 *
 * Three tests, chosen for what they were measured on. An operator is decisive:
 * no section heading contains `=`, `_` or brackets, so rejecting one costs a
 * missing label at worst — and the false heading this caught was `model .= 512`,
 * one row of the Transformer hyper-parameter table. A lone letter is a variable,
 * which is how GPT-3's "model n jobs" table cell became a section called "model
 * n". A bare number at the END of a line is the page number of a table of
 * contents entry, and a paper whose contents page is parsed as three sections
 * has a spine that is simply wrong.
 *
 * A numeral anywhere else is not decisive, because real titles do say "4.1 BLEU
 * scores on WMT 2014" — so digits only count against a line that has no section
 * number of its own to explain them.
 *
 * The asymmetry is why this exists at all. Missing a heading leaves the following
 * paragraphs under the previous section label, which is still a true description
 * of the paper. Inventing one files everything after it under a section that does
 * not exist.
 */
function looksLikeMathOrData(text: string): boolean {
  for (const character of MATH_OPERATOR_CHARS) {
    if (text.includes(character)) return true;
  }
  if (TRAILING_BARE_NUMBER.test(text)) return true;
  if (LONE_LETTER.test(text.replace(TRAILING_BARE_NUMBER, " "))) return true;
  return !SECTION_NUMBER.test(text) && /\d/.test(text);
}

/**
 * Does this text read as a sentence rather than a title?
 *
 * The single most damaging heading false-positive is a numbered list item in the
 * body — "2 We then apply the filter" — because everything after it gets filed
 * under a section that does not exist, and the spine becomes fiction. Titles do
 * not contain finite verbs or subject pronouns; sentences do. Testing for those
 * is a cheap and very effective discriminator.
 */
function readsAsSentence(text: string): boolean {
  if (text.includes(",")) return true;
  if (text.split(/\s+/).length > 9) return true;
  return (
    /\b(?:we|our|us|it|its|they|their|this|that|these|those|there|is|are|was|were|be|been|being|has|have|had|can|could|will|would|shall|should|may|might|must|do|does|did|and\s+then)\b/i.test(
      text,
    )
  );
}

/**
 * Is this line a heading?
 *
 * Signals are ranked by how much they can be trusted, because treating them as
 * equals is what produces a shredded paper:
 *
 *   structural  — a section number ("3.2") or a heading word every paper uses
 *                 ("Introduction", "Related Work"). Strong: these are what the
 *                 authors typed to mark a section.
 *   typographic — measurably larger than the body size. Strong: it is a number
 *                 read off the page, not a guess.
 *   weight      — inferred bold. WEAK. See `classifyBoldFonts` for why it can be
 *                 wrong; it is only ever allowed to corroborate a structural
 *                 signal, never to stand with `short` on its own.
 *
 * The bounds are what keep prose out: at most 120 characters and 14 words, and
 * never ending in a comma, period, semicolon or colon. That last rule is
 * load-bearing — without it the final ragged line of a paragraph becomes a
 * section.
 */
export function isHeading(line: PdfLine, body: number): boolean {
  const text = line.text.trim();
  if (!text || text.length > 120) return false;
  if (/[.,;:]$/.test(text)) return false;
  if (text.split(/\s+/).length > 14) return false;

  if (FULL_LINE_HEADING.test(text)) return true;
  if (looksLikeMathOrData(text)) return false;

  const typographic = line.fontSize >= body * 1.08;
  const short = text.length <= 72;
  const sentence = readsAsSentence(text);

  const numbered = SECTION_NUMBER.test(text);
  if (numbered && !sentence && (typographic || short || line.bold)) return true;

  // A keyword heading with no number needs real typographic evidence. Without
  // it, "Model performance improves with scale" is indistinguishable from a
  // section called "Model", and guessing wrong costs more than missing it.
  const keyword = KNOWN_HEADING.test(text);
  if (keyword && !sentence && short && (typographic || line.bold)) return true;

  return typographic && short && line.bold && !sentence;
}

function endsSentence(text: string): boolean {
  return /[.!?]["')\]]?$/.test(text.trim());
}

/** Bullet, enumerated list item, or a numbered equation's leading marker. */
function startsListItem(text: string): boolean {
  return /^(?:[([]?\d{1,2}[.)\]]|[(][a-z][)]|[•‣▪◆◦·\-\*–—])\s+\S/.test(text.trim());
}

/**
 * True when a "paragraph" is really the rest of the sentence before it.
 *
 * English prose does not begin with a lowercase letter, so the letter is the
 * tell that the break in front of it was invented here rather than by the
 * authors: a column that ended mid-sentence next to a figure, a page that split
 * a paragraph. Measured on the three sample papers before this existed, 7 of 77,
 * 9 of 79 and 19 of 400 units began lowercase, and every one inspected was a
 * tail — `greatly benefited from very deep models.`, `of the values, where the
 * weight assigned to each value is computed as…`.
 *
 * Only a LETTER triggers it. `(i)` and a formula line like `lrate = dmodel…`
 * genuinely do start there, and welding an equation onto the sentence before it
 * is a different error than the one being fixed.
 */
function isSentenceTail(text: string): boolean {
  return /^[a-z]/.test(text);
}

/** A token that carries no word: one character of any kind, or a number. */
const UNREADABLE_TOKEN = /^(?:[\p{L}\p{P}\p{Sm}\p{Sk}]|[+\-−–—]?\d+(?:[.,]\d+)?%?)$/u;

/** Past this many tokens a "fragment" is a table row, and rows are `dropLabels`' job. */
const FRAGMENT_MAX_TOKENS = 6;

/**
 * True when nothing here could be read as a sentence, or selected and asked about.
 *
 * This is what is left of the figure and table ink once type size started
 * breaking paragraphs: "k k", "2 2 2", "+ + +", "−9", "a f a". Before that
 * change they were invisible because each one had been glued onto the end of a
 * real sentence, which was its own bug — the reader saw "…defined as below. k k".
 *
 * Deliberately narrower than "short" or "no digits-and-letters mix".
 * `MultiHead(Q, K, V ) = Concat(head1, … ) W` has the same shape at a glance and
 * is the most quoted line of the Transformer paper; `Poor English input: I eated
 * the purple berries.` is a real example from GPT-3's appendix. Both survive
 * because a token like `MultiHead(Q,` or `input:` is longer than one character.
 */
function isFragmentText(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > FRAGMENT_MAX_TOKENS) return false;
  return tokens.every((token) => UNREADABLE_TOKEN.test(token));
}

/**
 * A line that names its own exhibit: "Figure 1. Training error…", "Table 4: The
 * Transformer benchmark…". The number and the separator after it are what make
 * it a caption rather than a sentence about a figure — "Figure 3 shows the loss"
 * is prose and must stay prose.
 */
const CAPTION_START = /^(?:figure|fig\.|table|algorithm|listing|chart)\s+[ivxl\d][\w.]*[.:](?:\s|$)/i;

/**
 * True when a whole unit is ink rather than something the authors wrote to be read.
 *
 * `dropLabels` already deletes this material, but only in runs of five lines or
 * more, because a run is proof and one line is not — its own comment records
 * that keeping a stray table header is cheaper than deleting a heading. Breaking
 * paragraphs on type size changed what an isolated header looks like: it used to
 * be invisible inside a sentence, and now it stands where a paragraph should be.
 * A unit three signals agree on is safe to leave out:
 *
 *   - it is set smaller than the body, so it is not prose. This is the guard that
 *     matters: nothing body-sized is ever dropped here, so the worst this rule
 *     can do is lose a caption.
 *   - it is either unreadable token soup ("2 2 2", "a f a"), or an ink line by
 *     the measured test (`isInkLine`), or a single word with no punctuation
 *     ("njobs", "O").
 *   - it does not name an exhibit, so "Figure 6.1: Racial Sentiment Across Models"
 *     — small type, one clause, no verb — stays on the page.
 *
 * Anything that survives is a reading unit the reader can select and ask about.
 */
function isInkUnit(text: string, size: number, body: number): boolean {
  if (isFragmentText(text)) return true;
  // A lowercase start is the authors' own evidence that this is not the beginning
  // of anything: no sentence, heading or caption in these papers opens with a
  // small letter. Combined with `isInkLine` — short, carrying a numeral, with
  // none of the closed-class words a sentence is built from — it describes a
  // table row that got cut loose from the block its neighbours are in, which is
  // the one shape of ink that `dropLabels` is not allowed to delete on its own.
  if (/^[a-z]/.test(text) && isInkLine(text) && !endsSentence(text)) return true;
  // The same idea with the length limit lifted, for the row-block a whole table
  // leaves behind. ResNet's Table 1 is set at body size, so nothing about the
  // type says "not prose", but
  //   "layer name output size 18-layer 34-layer 50-layer … conv1 112×112 7×7, 64, stride 2 [ ] [ ]"
  // has no closed-class word in it anywhere — which the measurement behind
  // `FUNCTION_WORDS` says no body line does — and four or more of its tokens
  // carry a digit, which is what a run of cells looks like. A sentence tail that
  // happens to start lowercase is still safe: "reaching 76% of the reported
  // accuracy" has `of` and `the` in it, and any prose with that many numbers in
  // it also has the prepositions that hold them together.
  if (
    /^[a-z]/.test(text) &&
    !endsSentence(text) &&
    !hasFunctionWord(text) &&
    text.split(/\s+/).filter((token) => /\d/.test(token)).length >= 4
  ) {
    return true;
  }
  // Inside a diagram the words are component names, and a diagram is set smaller
  // than the prose around it: "x weight layer relu F ( x ) x weight layer identity".
  // English prose without a single closed-class word in it does not exist, so the
  // two signals together have no false positive to find — and a body-sized run of
  // words with no function word in it is left alone, because that is what a
  // heading or a label set in the text font looks like.
  if (/^[a-z]/.test(text) && !hasFunctionWord(text) && !isBodyType(size, body)) return true;
  if (isBodyType(size, body)) return false;
  if (CAPTION_START.test(text.trim())) return false;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (
    /^[a-z]/.test(text) &&
    tokens.length <= FRAGMENT_MAX_TOKENS &&
    !endsSentence(text)
  ) {
    // A label set into the figure, not a sentence: ResNet's Figure 7 carries its
    // rotated x-axis text "layer index (sorted by magnitude)" as a unit of five
    // words between two captions. It has a function word in it, so the clause
    // above cannot see it, but nothing this small and this unterminated is
    // something the authors wrote to be read. Getting here already means the type
    // is not body type, which is what keeps a short sentence of the same shape in
    // the text — a heading, or the last clause of a cut-off footnote — out of
    // reach of this rule.
    return true;
  }
  return tokens.length === 1 || isInkLine(text);
}

/**
 * The label that opens a paper's own index card.
 *
 * "Keywords: Cognitive Architectures, Sample-Inefficiency Problem, …" is not a
 * paragraph and no reader wants to select a sentence out of it, but it is real
 * text at real size on page 1, so nothing in the geometry calls it furniture.
 * It was the single most common leak across the four non-CS templates tried for
 * this rule — arXiv 2012.12675, 2012.11542, 2012.13779 and 2012.11922 all print
 * one, and three of them set it in the same size as their abstract, which is
 * exactly where the title-page walk stops.
 *
 * The colon is what makes this safe. "Keywords are extracted automatically" is a
 * sentence and has no colon after the first word; nothing that reads as prose
 * opens with a metadata label and a punctuation mark.
 *
 * `Abstract` is deliberately absent: the abstract is the one piece of front
 * matter a reader of Marginalia wants in the column, with the same annotations
 * available on it as on any other paragraph.
 */
const METADATA_LABEL =
  /^(?:keywords?\s*[:\-–—]|key\s*words?\s*[:\-–—]|index\s+terms\s*[:\-–—]|categorization\s*[:\-–—]|ccs\s+concepts|acm\s+subject\s+classification|pacs\s*[:\-–—]|msc(?:\s*20\d\d)?\s*[:\-–—]|jel(?:\s+classification)?\s*[:\-–—]|https?:|doi\s*[:\-–—]|orcid)/i;

const BARE_URL = /(?:https?:\/\/|www\.)\S+/gi;

/**
 * A paragraph that is nothing but links.
 *
 * arXiv 2012.11922 lists its software references as three footnote markers with
 * a URL after each, and the assembly welds them into one unit: "3
 * http://www.gaussianprocess.org/ 4 http://becs.aalto.fi/… 5 http://is…". No
 * label opens it, so `METADATA_LABEL` cannot see it.
 *
 * What makes this safe is the residue test. Take the links out and a real
 * sentence still says something — "we compare http://a.org and http://b.org on
 * CIFAR-10" leaves most of its words behind — while a link list is left with
 * three digits. Two links minimum, because a paragraph with one URL in it is
 * prose about a resource rather than a list of them.
 */
function isLinkList(text: string): boolean {
  const urls = text.match(BARE_URL);
  if (!urls || urls.length < 2) return false;
  const rest = text.replace(BARE_URL, " ").replace(/\s+/g, " ").trim();
  return rest.length <= 40 && !/[a-z]{4,}\s+[a-z]{4,}/.test(rest);
}

/**
 * Whether an assembled paragraph is front-matter metadata rather than prose.
 */
function isMetadata(text: string): boolean {
  return METADATA_LABEL.test(text) || isLinkList(text);
}

/**
 * Merges ordered lines into paragraphs and tracks the section each belongs to.
 *
 * The break rule is the crux of the whole module. A line wrap and a paragraph
 * break look identical in isolation; what distinguishes them in justified text
 * is that the last line of a paragraph is SHORT. So a break needs both
 * conditions: the previous line did not reach its column's right edge, and it
 * ended a sentence. Either alone is wrong — requiring only raggedness splits
 * every paragraph containing an inline equation that shortened a line, and
 * requiring only sentence-end splits after every sentence, which is not
 * paragraphs at all but a list of sentences.
 *
 * Page boundaries do not break a paragraph unless the previous line was ragged:
 * prose flows across pages constantly, and breaking there would fragment a
 * paper into one paragraph per page.
 *
 * Type size does break one, because size is the one signal that is not
 * ambiguous: prose is set at a single size and everything the author meant as
 * furniture — caption, footnote, table title — is set smaller. Without that
 * rule a paragraph that ends at the foot of a column absorbed the footnote
 * under it and the caption after it, and the reader got one sentence quoting a
 * URL and then describing a plot.
 */
export function toParagraphs(
  layout: OrderedLayout,
  body: number,
): {
  paragraphs: Paragraph[];
  stoppedAtReferences: boolean;
  capReached: boolean;
  linebreakHyphens: number;
  droppedFragments: number;
  droppedMetadata: number;
} {
  const { lines, columnRight, columnLeading } = layout;
  const paragraphs: Paragraph[] = [];

  let section = "正文";
  let sectionOrder = 0;
  let stoppedAtReferences = false;
  let capReached = false;

  let buffer = "";
  let bufferPage = 0;
  let bufferSize = 0;
  let bufferLines = 0;
  let linebreakHyphens = 0;
  let droppedFragments = 0;
  let droppedMetadata = 0;
  let prev: PdfLine | null = null;

  /**
   * The paragraph a fragment rejoins, searching past exhibit paragraphs —
   * anything not set at prose size, or opened by a caption marker — until it
   * reaches the first paragraph of prose.
   *
   * ResNet page 1 is the case this exists for. The introduction runs to the foot
   * of the left column mid-sentence, the footnote with its two URLs sits under
   * it, the caption of Figure 1 opens the right column, and the sentence
   * resumes below the caption — so the tail's two nearest neighbours in reading
   * order are both furniture, and merging with "the previous paragraph" puts
   * `greatly benefited from very deep models.` inside a figure caption.
   */
  const mergeTarget = (sectionOf: string, sizeOf: number): Paragraph | null => {
    for (let i = paragraphs.length - 1, crossed = 0; i >= 0; i -= 1, crossed += 1) {
      if (crossed >= MAX_TAIL_CROSSINGS) return null;
      const candidate = paragraphs[i];
      if (candidate.section !== sectionOf) return null;
      // Set at another size, or opening with an exhibit marker: either way this
      // is something the sentence was cut away from, not the sentence's home.
      if (!isBodyType(candidate.size, body) || CAPTION_START.test(candidate.text)) continue;
      // The first prose paragraph is the only candidate. A tail that is itself
      // not prose — the 8pt footnote with the broken last line — does not belong
      // to it, and reaching further back would weld the footnote to whichever
      // paragraph happens to sit a page ahead of it.
      return isBodyType(sizeOf, body) ? candidate : null;
    }
    return null;
  };

  const flush = () => {
    const text = buffer.replace(/\s+/g, " ").trim();
    const lines = bufferLines;
    buffer = "";
    bufferLines = 0;
    if (!text) return;

    // Figure and table scraps are counted, not silently skipped, so the reader
    // can be told how many lines of ink the parse left out. Counted in LINES
    // because that is the unit `omittedLabels` already reports in, and the two
    // numbers are added together.
    // The index card, counted separately from the ink: figure scraps and a
    // keyword list are both things that are not sentences, but they come apart
    // in a paper for different reasons and the reader is told about them in
    // different words. Tested first, so a keyword list set in a caption's size
    // cannot be booked as figure ink.
    if (isMetadata(text)) {
      droppedMetadata += 1;
      return;
    }

    if (isInkUnit(text, bufferSize, body)) {
      droppedFragments += lines;
      return;
    }

    // A tail belongs to the paragraph it was cut from, and that paragraph is
    // only the previous one while the section has not changed.
    if (text.length < MIN_PARAGRAPH_CHARS || isSentenceTail(text)) {
      const last = mergeTarget(section, bufferSize);
      if (last) {
        last.text = `${last.text} ${text}`.replace(/\s+/g, " ").trim();
        return;
      }
    }
    // Anything else stands alone — including a short fragment under a new
    // heading. An earlier version dropped those, which lost sentences with no
    // trace; a stub the reader can see is recoverable and a vanished sentence
    // is not.
    paragraphs.push({ section, sectionOrder, text, page: bufferPage, size: bufferSize });
  };

  for (const line of lines) {
    if (isHeading(line, body)) {
      flush();
      if (REFERENCES_HEADING.test(line.text.trim())) {
        stoppedAtReferences = true;
        break;
      }
      section = line.text.trim().replace(/\s+/g, " ");
      sectionOrder += 1;
      prev = line;
      continue;
    }

    // The cap STOPS the walk rather than skipping lines. Skipping would leave a
    // hole in the middle of the paper — the same failure the arXiv payload
    // budget refuses to produce. Everything after the cap is simply not there,
    // and `budgetExhausted` says so out loud.
    if (paragraphs.length >= MAX_PARAGRAPHS) {
      flush();
      capReached = true;
      break;
    }

    // The page a paragraph starts on is the page of the line that starts it.
    // Testing `!buffer` here rather than in each branch is what makes that true
    // for the line right after a section heading: `flush()` empties the buffer,
    // and the paragraph then inherits `bufferPage` from whichever paragraph was
    // flushed last — on the first section of the document, still 0, which printed
    // "第 0 页" on a twelve-page paper whose abstract is on page 1.
    if (!buffer) {
      bufferPage = line.page;
      bufferSize = line.fontSize;
    }

    if (!prev) {
      buffer = buffer ? `${buffer} ${line.text}` : line.text;
      bufferLines += 1;
      prev = line;
      continue;
    }

    const prevKey = `${prev.page}:${prev.column}`;
    const filled = (columnRight.get(prevKey) ?? prev.right) - prev.right <= body * 0.9;
    const samePage = prev.page === line.page;
    const leading = columnLeading.get(`${line.page}:${line.column}`) ?? body * 1.2;
    const gap = samePage ? prev.y - line.y : 0;
    const bigGap = samePage && gap > leading * 1.9;
    const pageBreak = !samePage;

    // A change from body type to furniture type (or back) is a change of block.
    // Raggedness and sentence-end cannot see it: a footnote ends with a period
    // and a caption is short, exactly like the last line of a paragraph, which
    // is how a URL and a figure legend used to end up inside a sentence.
    const sizeShift =
      buffer.length > 0 && isBodyType(line.fontSize, body) !== isBodyType(prev.fontSize, body);

    // The same rule for the papers that do not change size to mark a caption.
    // Attention sets Table 4 in the same 10pt as its prose, and GPT-3 does the
    // same in its margin figures, so type size cannot separate them; the marker
    // itself can. "…during inference, we Table 4: The Transformer benchmark…" is
    // the sentence the reader was left with, and unlike the ResNet case it is
    // still there when only the size rule is applied.
    const opensCaption = buffer.length > 0 && CAPTION_START.test(line.text.trim());

    const shouldBreak =
      sizeShift ||
      opensCaption ||
      bigGap ||
      startsListItem(line.text) ||
      (!filled && endsSentence(prev.text) && !pageBreak) ||
      (pageBreak && !filled && endsSentence(prev.text));

    if (shouldBreak) {
      flush();
      bufferPage = line.page;
      bufferSize = line.fontSize;
      buffer = line.text;
    } else {
      // Hyphenated line break. Joining with NO space and KEEPING the hyphen is
      // correct for both cases at once: "state-of-the-" + "art" gives
      // "state-of-the-art", and "well-" + "known" gives "well-known". Stripping
      // the hyphen would produce "state-of-theart"; inserting a space would
      // produce "well- known". A discretionary hyphen (U+00AD) is the exception:
      // it is not part of the word, so it is dropped.
      //
      // Measured on the ResNet PDF: 144 joins, most of them LaTeX's automatic
      // hyphenation ("ex-tremely", "computa-tional") rather than the compounds
      // this branch was written for. So some of what the reader sees carries a
      // hyphen the paper does not — but the text layer cannot tell the two apart
      // (pdftex draws the same "-" glyph for both), and the only rules that
      // guess do it by asking whether each side is an English word, which fails
      // on exactly the prefixes that hyphenate most often in this literature:
      // "re-sults" would become "results" correctly and "re-formulation" would
      // fuse into a word that already had no hyphen, while "com-posed" and
      // "counter-part" fuse into real words and stay wrong either way.
      // Keeping the hyphen is the choice that never turns one word into a
      // different word, and `linebreakHyphens` is reported so the reader knows
      // how many places to expect it.
      const softHyphen = buffer.endsWith("\u00ad");
      if (softHyphen) buffer = buffer.slice(0, -1);
      const hardHyphen = !softHyphen && buffer.endsWith("-") && filled;
      if (softHyphen || hardHyphen) linebreakHyphens += 1;
      buffer = `${buffer}${hardHyphen || softHyphen ? "" : " "}${line.text}`;
    }
    bufferLines += 1;
    prev = line;
  }
  flush();

  return {
    paragraphs,
    stoppedAtReferences,
    capReached,
    linebreakHyphens,
    droppedFragments,
    droppedMetadata,
  };
}

/* ------------------------------------------------------------------ */
/* 6. Title, authors, abstract                                         */
/* ------------------------------------------------------------------ */

/**
 * A line that carries contact details rather than words.
 *
 * `https?` is matched against the slashes and not with a trailing word boundary:
 * "http://isp.uv.es/" has no word character on either side of the colon, so
 * `\bhttps?:\b` cannot match it, and that line — the last of the correspondence
 * block under arXiv 2012.11922's authors — was collected as the final author's
 * second name.
 */
const EMAILISH = /[@]|\b(?:orcid|doi\.org)|https?:\/{2}|\bwww\./i;

/**
 * A submission date, as it appears under a title: "December, 15, 2020
 * (Preliminary version)".
 *
 * May is missing on purpose. "May 4, 2021" is a date and "May" is also the most
 * ordinary modal verb in an English abstract, and the price of the ambiguity is
 * one line left in the prose rather than a sentence deleted.
 */
const DATE_LINE =
  /\b(?:january|february|march|april|june|july|august|september|october|november|december)\b[^\n]{0,24}\b(?:19|20)\d{2}\b/i;

/**
 * A line that is nothing but a status parenthetical: "(Preliminary version)",
 * "(Extended abstract)", "(Under review)".
 *
 * arXiv 2012.11542 prints one under its submission date, in the same 14pt as the
 * author names, and it became the reader's first paragraph. Nothing in the
 * geometry separates it from the block above — same size, same column, similar
 * gap — so the only thing left to ask is what it says, and a whole line that is
 * one bracket and nothing else is not a sentence anyone meant to be read.
 */
const STATUS_PARENTHETICAL = /^\([^()]{2,60}\)[.。]?$/;

/**
 * Countries, as an affiliation line ends with them.
 *
 * The institution words are already in `AFFILIATION`; this catches the line that
 * does not repeat them, because a four-line affiliation block ends each line with
 * "…, Barcelona, Spain" and only the first of them names a university.
 *
 * "Institute of Science and Technology (BIST), Barcelona, Spain" is also the
 * reason this rule exists at all rather than a stricter name test:
 * `looksLikeNames` counts "of" and "and" as name particles, so a line of
 * capitalised institution words clears its 70% bar and got collected as an
 * author. A country at the end of the line is the shape that cannot be a person.
 */
const ENDS_WITH_COUNTRY =
  /,\s*(?:u\.?s\.?a?\.?|united states|canada|mexico|brazil|argentina|chile|peru|colombia|uk|united kingdom|england|scotland|wales|ireland|france|germany|austria|switzerland|italy|spain|espana|portugal|greece|belgium|netherlands|denmark|sweden|norway|finland|poland|czech(?: republic)?|hungary|romania|bulgaria|croatia|serbia|russia|ukraine|israel|turkey|china|japan|korea|india|pakistan|singapore|malaysia|thailand|vietnam|australia|new zealand|south africa|egypt|nigeria|kenya|morocco|tunisia)\s*[.\u3002]?$/i;

/**
 * Which kind of title-page furniture a line is, or `null` when it is not.
 *
 * `"address"` is definitive by itself — a line of the title block carrying an
 * e-mail, an ORCID or a URL is not prose in any template. `"soft"` is not: an
 * affiliation word ("Department", "Institute", and by design also "research",
 * "company", "lab") opens plenty of first sentences, so a soft line only counts
 * as part of the block when another furniture line is adjacent to it, or when the
 * walk has already found names above it. See `collectTitlePage`.
 */
function furnitureClass(text: string): "address" | "soft" | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 140) return null;
  if (EMAILISH.test(trimmed)) return "address";
  if (/^keywords?\b/i.test(trimmed) && trimmed.length <= 120) return "soft";
  if (DATE_LINE.test(trimmed) && trimmed.length <= 70) return "soft";
  if (STATUS_PARENTHETICAL.test(trimmed)) return "soft";
  if (ENDS_WITH_COUNTRY.test(trimmed) && trimmed.length <= 110) return "soft";
  if (
    AFFILIATION.test(trimmed) &&
    trimmed.length <= 110 &&
    !endsSentence(trimmed) &&
    !/[.;:]$/.test(trimmed)
  ) {
    return "soft";
  }
  return null;
}

/**
 * Words that mark a line as an affiliation rather than a person.
 *
 * Deliberately broad and deliberately lower-stakes than it looks: the only cost
 * of a false match is one missing name from a display line, while the cost of
 * missing the pattern is "Google Brain" appearing in the author list. Broad wins.
 *
 * `universit` and `institut` are prefixes rather than words because the templates
 * are: "Universitat Pompeu Fabra" is what an affiliation line says in Catalan, and
 * spelling out every language's ending is how arXiv 2012.13779's affiliation block
 * ended up collected as its author list.
 */
const AFFILIATION =
  /\b(?:universit\w*|institut\w*|department|school|college|faculty|laborator\w*|research|centre|center|hospital|academy|clinic|foundation|inc|llc|ltd|corp|corporation|company|labs?|google|microsoft|meta|openai|deepmind|nvidia|ibm|amazon|apple|baidu|tencent|alibaba|huawei|xiaomi|bytedance|mit|stanford|berkeley|cambridge|oxford|harvard|princeton|yale|cornell|eth|epfl|inria|cnrs|max\s*planck|tsinghua|peking|fudan|zhejiang|shanghai|beijing)\b/i;

/** Anything with a letter in it — Latin, Greek or CJK. A line of only footnote
 *  markers ("∗ † ‡") fails this, which is exactly what it is for. */
function hasLetters(text: string): boolean {
  return /[A-Za-z\u00c0-\u024f\u0370-\u03ff\u4e00-\u9fff]/.test(text);
}

/**
 * Finds the document title.
 *
 * Strategy: the largest text on page 1, above the first heading, is the title.
 * Consecutive lines within 10% of that size are joined, because long titles wrap
 * and a title truncated at its first line is worse than one carrying a subtitle.
 *
 * Returns null when nothing is clearly larger than the body, which is common on
 * slides, on preprints with a small title, and on scanned documents. The caller
 * must then fall back to the file name and TELL THE READER it did.
 *
 * The title's lines are returned as a list: the author block is defined as
 * "whatever sits between the title and the first heading", which needs positions
 * rather than spelling, and a title that wrapped to two lines has to be dropped
 * from the prose in full. Matching the two back up by string comparison would
 * break on exactly the titles that wrap.
 */
export function findTitle(
  lines: readonly PdfLine[],
  body: number,
): { title: string; titleLines: PdfLine[] } | null {
  const firstPage = lines.filter((line) => line.page === 1);
  if (firstPage.length === 0) return null;

  const candidates = firstPage.filter((line) => {
    const headingAbove = firstPage.some(
      (other) => other.y > line.y && isHeading(other, body),
    );
    return !headingAbove && line.fontSize >= body * 1.15 && line.text.length >= 6;
  });
  if (candidates.length === 0) return null;

  const biggest = candidates.reduce((a, b) => (b.fontSize > a.fontSize ? b : a));
  const sized = candidates
    .filter((line) => line.fontSize >= biggest.fontSize * 0.9)
    .sort((a, b) => b.y - a.y);

  /*
   * A section heading set as large as the title is not part of the title.
   *
   * Measured on a number-theory preprint (arXiv 2012.12675) whose author sets the
   * heading "1 Introduction" in the same size as the two title lines above it: the
   * joined title became "…Motzkin Numbers of the Second Kind 1 Introduction", and
   * because the title block is where `collectTitlePage` starts walking, the
   * heading was then no longer there to stop it, so the title page bled into the
   * prose as well. Two errors from one line.
   *
   * Only the two unambiguous shapes are cut. `KNOWN_HEADING` is not used, because
   * a real title does open with one of its words — "Model Checking", "Methods of
   * …" — while a title line that begins with "3.2 " or consists of the single word
   * "Introduction" does not occur.
   */
  const titleLines = sized.filter(
    (line) => !SECTION_NUMBER.test(line.text.trim()) && !FULL_LINE_HEADING.test(line.text.trim()),
  );

  const title = titleLines
    .map((line) => line.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (title.length < 6 || title.length > 400 || EMAILISH.test(title)) return null;
  return { title, titleLines };
}

/**
 * Footnote markers that ride on a name: "Vaswani∗", "Gomez∗ †".
 *
 * Superscript digits arrive as ordinary digits in the text stream, so a run of
 * them after at least two letters is treated as a marker too. That is a
 * judgement, and a narrow one: "Vaswani1" is a footnote, while a real surname
 * ending in a digit does not occur in an author list.
 *
 * Every codepoint below is written as an escape on purpose. The Transformer
 * paper's marker is U+2217 (asterisk operator), not U+002A, and the two are
 * indistinguishable in a source file — a class typed with the literal character
 * silently matched nothing and the author line came out dotted with daggers.
 */
const FOOTNOTE_MARKERS = /[\u002a\u0023\u005e\u00a7\u00b6\u2020\u2021\u2217\u2225\u22c6\u221a]/g;

function stripMarkers(text: string): string {
  return text
    .replace(FOOTNOTE_MARKERS, "")
    .replace(/(\p{L}{2,})\d+/gu, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The accent glyphs pdftex positions over a letter, and the combining mark each
 * one becomes when the letter it belongs to is found after it.
 *
 * A PDF drawn this way has no "í" in its text layer: it has "i" in one item and
 * a spacing acute in another, which is why "Muñoz-Marí" arrives whole from one
 * template and "Adrián" arrives as "Adri´" plus "an" from another. Only the
 * second case needs this table, and only the five marks a name actually uses.
 */
const SPACING_ACCENTS = new Map<string, string>([
  ["\u00b4", "\u0301"], // ´ →  ́
  ["\u02dc", "\u0303"], // ˜ →  ̃
  ["\u0060", "\u0300"], // ` →  ̀
  ["\u00a8", "\u0308"], // ¨ →  ̈
  ["\u02c6", "\u0302"], // ˆ →  ̂
]);

/** Lowercase particles inside a name, which must not count against it. */const NAME_PARTICLES = new Set([
  "van", "von", "de", "del", "der", "di", "da", "dos", "du", "la", "le", "el",
  "den", "ter", "bin", "ibn", "al", "st", "jr", "sr",
]);

/**
 * Does this line read as a list of personal names?
 *
 * This is the gate that decides what may be deleted from the paragraph stream as
 * title-page furniture, and both errors are visible to a reader: a false
 * negative leaves names in the prose, a false positive silently deletes the
 * paper's first sentence. So it is a shape test rather than "anything between the
 * title and the first heading".
 *
 * Names are capitalised and finite verbs are not, which makes the ratio of
 * capitalised words a strong and cheap discriminator. Body text opens with one or
 * two capitals and then goes lowercase ("The dominant sequence transduction
 * models are based on complex recurrent or" — 1 of 11), which no author row does.
 */
function looksLikeNames(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 24) return false;
  if (/[@/\\]/.test(text)) return false;

  let letterWords = 0;
  let capitals = 0;
  for (const word of words) {
    if (!/^\p{L}/u.test(word)) continue;
    letterWords += 1;
    if (/^\p{Lu}/u.test(word)) {
      capitals += 1;
      continue;
    }
    if (NAME_PARTICLES.has(word.replace(/[^\p{L}]/gu, "").toLowerCase())) capitals += 1;
  }
  return letterWords > 0 && capitals / letterWords >= 0.7;
}

export interface TitlePage {
  /** The author block, when one could be separated from the title and abstract. */
  authors: string | null;
  /**
   * Every line this block consisted of, including the title itself.
   *
   * Returned as a set of line references for `dropFrontMatter` to remove. Title
   * pages are laid out as a grid — pdf.js streams the first author's name, his
   * affiliation and his e-mail, then the second author's name — so the lines
   * interleave across rows. Collecting only the name rows and leaving the rest in
   * the prose was the measured failure: the first "paragraph" of the Transformer
   * paper was its own title block.
   */
  drop: Set<PdfLine>;
}

/**
 * Finds the author block, and everything else that belongs to the title page.
 *
 * The walk goes down the page from the title, consuming names and title-page
 * furniture (`furnitureClass`) and stopping at the first line that is neither —
 * which is the abstract, or the first paragraph, or a heading it cannot mistake
 * for one. Furniture is skipped rather than breaking the walk because title pages
 * are grids: pdf.js streams the first author's name, his affiliation and his
 * e-mail, then the second author's name, so the rows interleave. Collecting only
 * the name rows and leaving the rest in the prose was the measured failure — the
 * Transformer paper's first "paragraph" was its own title block, and returning
 * "∗, Ashish Vaswani, Google Brain, avaswani@google.com" as an author list is
 * worse than returning nothing, because it looks authoritative.
 *
 * Returning null is still the right answer more often than guessing: the UI then
 * shows no author line at all.
 */
export function collectTitlePage(
  lines: readonly PdfLine[],
  titleLines: readonly PdfLine[],
  body: number,
): TitlePage {
  const drop = new Set<PdfLine>(titleLines);
  const first = titleLines[0];
  if (!first) return { authors: null, drop };

  const below = lines
    .filter((line) => line.page === first.page && line.y < first.y && !drop.has(line))
    .sort(byReadingPosition);

  const collected: string[] = [];
  let inBlock = false;
  for (let index = 0; index < below.length; index += 1) {
    const line = below[index];
    const text = stripMarkers(line.text);
    if (!text) continue;

    const kind = furnitureClass(text);
    const nextIsFurniture =
      index + 1 < below.length && furnitureClass(stripMarkers(below[index + 1].text)) !== null;
    if (kind === "address") {
      drop.add(line);
      inBlock = true;
      // A name wearing an address. "Gennady Eremin ergenns@gmail.com" (arXiv
      // 2012.12675, a one-author number-theory preprint) is furniture because of
      // the contact details, but the person in it is exactly what the reader wants
      // in the header, so the address comes off and what is left gets the same
      // shape test as any other row.
      const bare = text
        .replace(/\S*@\S+/g, "")
        .replace(/\b(?:orcid|doi|https?:|www\.)\S*/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (bare && looksLikeNames(bare)) collected.push(bare);
      continue;
    }
    if (kind === "soft" && (inBlock || nextIsFurniture)) {
      drop.add(line);
      inBlock = true;
      continue;
    }

    /*
     * The name test comes before the heading break, and the order is the fix.
     *
     * On a Springer LNCS page the most common size on page 1 is the 9pt
     * affiliation block, so `bodyFontSize` returns 9pt and the 10pt author line
     * above it is, typographically, a heading. Breaking on the heading before
     * asking what the line says ended the walk at its first step, which cost
     * arXiv 2012.13779 its author list and left that list as the paper's first
     * paragraph. A heading-shaped line that reads as a list of names, sitting
     * directly under the title on page 1, is an author line; a real heading
     * ("1 Introduction") does not read as names and still breaks the walk.
     */
    if (hasLetters(text) && looksLikeNames(text)) {
      drop.add(line);
      collected.push(text);
      inBlock = true;
      if (collected.length >= 40) break;
      continue;
    }

    if (isHeading(line, body)) break;
    /*
     * One printed row, several lines.
     *
     * pdftex sets "Adrián" as the glyphs "Adri´" then "an", and pdf.js hands back
     * two entries for the same baseline, so an author row arrives in pieces:
     * arXiv 2012.13779's is "Ismael T. Freire1,2,3, Adri´" / "an F. Amil1,2,3" /
     * ", Vasiliki Vouloutsi1,3, and". Each piece after the first reads as neither
     * a name nor furniture, and ending the walk there left the whole affiliation
     * block in the prose. Inside a block that has already produced names, a short
     * row-opening continuation joins the name above it. The opening shape —
     * lowercase, or a comma — is what keeps the abstract out of it: an abstract
     * that wraps mid-sentence is a capital-starting line, and it breaks the walk.
     *
     * Contact details are excluded by name, because they open lowercase more
     * often than prose does: "http://isp.uv.es/" and "orcid.org/0000-0002-…" both
     * arrive as a short line directly under the names, and the first of them was
     * measured joining itself to the last author.
     */
    if (
      collected.length > 0 &&
      /^[a-z,;]/.test(text) &&
      text.length <= 60 &&
      !EMAILISH.test(text) &&
      !endsSentence(text)
    ) {
      drop.add(line);
      collected[collected.length - 1] = `${collected[collected.length - 1]} ${text}`
        .replace(/\s+/g, " ")
        .trim();
      continue;
    }
    // Anything else is the article proper — the abstract, or the first
    // paragraph. The walk stops rather than guessing.
    break;
  }

  if (collected.length === 0) return { authors: null, drop };
  /*
   * Superscript affiliation markers survive extraction as ordinary digits, and
   * `stripMarkers` only removes a digit run that rides directly on a letter —
   * "Freire1,2,3" becomes "Freire,2,3" rather than "Freire", because the same rule
   * applied to "Henry VIII" would be wrong in a sentence. Here the line is already
   * known to be an author row, so the commas-and-digits go: this string is printed
   * under the title, and "Ismael T. Freire,2,3, Adri´ an" is not what a reader
   * should be shown as an author list.
   */
  /*
   * What is left after the digits are gone is still not what a reader should be
   * shown, and three shapes remain, all measured on arXiv 2012.13779:
   *
   *   "…Paul F.M.J. Verschure ?" — a footnote marker drawn on the baseline, so
   *     `stripMarkers` (which only removes a marker riding on a letter) leaves it
   *     as a word of its own at the end of the list.
   *   "…Vouloutsi, and, Paul…" — the row was collected in pieces, and the piece
   *     that ended "and" was joined to the piece that opened "Paul" with a comma
   *     on each side. A serial comma before "and" is correct English; one after it
   *     is only ever an artefact of how the line was broken.
   *   "Adri´ an" — pdftex positions the acute as its own glyph, so the accent
   *     arrives before the vowel it modifies and one space too far from it.
   *     Moving it after the letter as a combining mark is what makes the name
   *     render as "Adrián" instead of as a typo.
   */
  const authors = collected
    .join(", ")
    .replace(/(?:,\s*\d+)+/g, "")
    // A marker glyph standing on its own between words. `stripMarkers` already
    // removed the ones welded to a letter; what survives to here is a marker that
    // pdf.js reported as its own item on the baseline — and "?" is not in
    // `FOOTNOTE_MARKERS` at all, because a question mark welded to a word is far
    // too likely to belong to a real title.
    .replace(/\s+[\u002a\u0023\u005e\u00a7\u00b6\u2020\u2021\u2217\u2225?](?=\s|$)/g, "")
    .replace(/\band,\s+/gi, "and ")
    // A space before a comma is never typographic; it is what a superscript
    // leaves behind when pdftex breaks "Amil1,2,3" across two extraction items.
    .replace(/\s+,/g, ",")
    // An affiliation reference in parentheses. The econ template on arXiv
    // 2012.11542 numbers its two authors "(1)" and "(2)" as ordinary text rather
    // than as superscripts, so the digit rule above — which needs a comma to hang
    // on — leaves them, and a reader is shown "ELLIOTT, (1) and GOURIEROUX (2)".
    // No author's name contains a parenthesised number.
    .replace(/\s*\(\d{1,2}\)/g, "")
    .replace(/([\u00b4\u02dc\u0060\u00a8\u02c6])\s*([A-Za-z])/g, (_all, mark: string, letter: string) => {
      const combining = SPACING_ACCENTS.get(mark);
      return combining ? letter + combining : _all;
    })
    .replace(/,\s*,+/g, ",")
    .replace(/\s{2,}/g, " ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
  return {
    authors: authors.length >= 4 && authors.length <= 600 ? authors : null,
    drop,
  };
}

/* ------------------------------------------------------------------ */
/* 7. Assembly                                                         */
/* ------------------------------------------------------------------ */

/** Splits an over-long paragraph at a sentence boundary rather than dropping
 *  it. Dropping is what the arXiv path does, because there the over-long unit is
 *  a parser artefact; here it would be real prose the reader paid to upload. */
function splitLong(text: string): string[] {
  if (text.length <= MAX_UNIT_CHARS) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_UNIT_CHARS) {
    const window = rest.slice(0, MAX_UNIT_CHARS);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
    const at = cut > MAX_UNIT_CHARS * 0.5 ? cut + 1 : MAX_UNIT_CHARS;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Full pipeline from positioned runs to a layout result.
 *
 * The order of the passes is not interchangeable, and each one depends on a
 * measurement the previous one made:
 *
 *   lines -> body size -> furniture -> ordering -> title
 *         -> front matter -> footnotes -> contents -> ink -> paragraphs
 *
 * Furniture has to go before ordering, or a page number in the footer becomes a
 * "spanning line" that splits the columns into two phantom bands. Body size has
 * to be measured before furniture removal, because the median is more stable
 * with more samples. The title has to be found before front matter is dropped,
 * because the title's position is what defines the title page. And footnotes,
 * contents entries and figure ink have to go after ordering, because the tests
 * that identify them — a gap measured against the column's leading, a block of
 * lines that each end in a page number, a RUN of lines with no function word in
 * them — are properties of a reading sequence rather than of a line.
 */
export function analyseRuns(runs: readonly PdfRun[], pageCount: number): LayoutResult {
  const rawLines = toLines(runs);
  const body = bodyFontSize(rawLines);

  const furniture = dropRunningFurniture(rawLines, pageCount);
  const firstPass = orderForReading(furniture.kept);

  const found = findTitle(firstPass.lines, body);
  const titleLines = found?.titleLines ?? [];
  const titleLine = titleLines[0] ?? null;
  const titlePage = collectTitlePage(firstPass.lines, titleLines, body);

  const withoutFrontMatter = dropFrontMatter(firstPass.lines, titleLine, titlePage.drop);
  const footnotes = dropFootnotes({ ...firstPass, lines: withoutFrontMatter }, body);
  const contents = dropContents({ ...firstPass, lines: footnotes.kept });
  const labels = dropLabels({ ...firstPass, lines: contents.kept }, body);

  const walk = toParagraphs(
    { ...firstPass, lines: labels.kept },
    body,
  );

  // Section numbering is re-derived from the paragraphs actually kept, so a
  // section that produced no viable paragraph cannot leave a hole in the spine.
  const sectionOrder = new Map<string, number>();
  const rebuilt: Paragraph[] = [];
  let totalChars = 0;
  let budgetExhausted = walk.capReached;

  for (const paragraph of walk.paragraphs) {
    if (totalChars >= MAX_TOTAL_CHARS) {
      budgetExhausted = true;
      break;
    }
    for (const piece of splitLong(paragraph.text)) {
      if (!sectionOrder.has(paragraph.section)) {
        sectionOrder.set(paragraph.section, sectionOrder.size + 1);
      }
      rebuilt.push({
        section: paragraph.section,
        sectionOrder: sectionOrder.get(paragraph.section)!,
        text: piece,
        page: paragraph.page,
        size: paragraph.size,
      });
      totalChars += piece.length;
      if (totalChars >= MAX_TOTAL_CHARS) {
        budgetExhausted = true;
        break;
      }
    }
    // No exit here on purpose. The outer loop's own `totalChars` test at the top
    // is what ends the walk; an earlier version also tested `budgetExhausted`,
    // and because that flag is seeded from `capReached` — which is already true
    // when the paragraph cap stopped the walk — it broke out after the FIRST
    // paragraph. A 75-page paper came back as one unit and the import reported
    // "not enough paragraphs" for a document with hundreds.
  }

  const pagesWithText = new Set(footnotes.kept.map((line) => line.page));
  const blankPages: number[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    if (!pagesWithText.has(page)) blankPages.push(page);
  }

  return {
    paragraphs: rebuilt,
    stoppedAtReferences: walk.stoppedAtReferences,
    budgetExhausted,
    title: found?.title ?? null,
    titleLine,
    authors: titlePage.authors,
    bodyFontSize: body,
    blankPages,
    // Both stages throw away the same kind of material — text drawn inside a
    // figure or a table — so they are reported as one number. `dropLabels` can
    // only see a RUN of such lines; once type size started breaking paragraphs,
    // the two- or three-character leftovers ("k k", "2 2 2") that used to hide
    // at the end of a sentence stood up on their own, and this is where they go.
    omittedLabels: labels.dropped + walk.droppedFragments,
    omittedMetadata: walk.droppedMetadata,
    omittedFootnotes: footnotes.dropped,
    linebreakHyphens: walk.linebreakHyphens,
  };
}
