/**
 * The reader-facing paper model.
 *
 * Why this file exists
 * --------------------
 * The site originally had exactly one paper, hand-curated in
 * `data/demo-paper.ts`, and every field on it was required: Chinese
 * counterpart, discourse role, difficulty score, formula glossary, plain
 * reading. That worked because a human had actually read the paper.
 *
 * An imported arXiv paper has not been read by anyone. The Function can extract
 * verifiable facts from it — section headings, paragraph text, the LaTeX of each
 * display equation, the equation number the authors themselves printed — but it
 * cannot know what a paragraph is DOING in the argument, how hard it is, or what
 * each symbol means. Those are interpretive claims.
 *
 * So every interpretive field here is optional, and the UI is required to say so
 * when one is missing. The alternative — letting the parser guess a `role` of
 * "method_step" for every paragraph it cannot classify — would make an imported
 * paper look analysed when it is not, which is the one failure mode this product
 * cannot survive: its entire claim is that it helps you read accurately.
 *
 * Dependency direction: `data/demo-paper.ts` (content) imports from here
 * (model), never the reverse.
 */

/**
 * Closed enum. Never let a model free-text this, or the UI cannot render it
 * stably. See docs/规划书 §9.
 */
export const DISCOURSE_ROLES = [
  "gap",
  "prior_work_limit",
  "notation",
  "hypothesis",
  "method_step",
  "experiment_setup",
  "result",
  "caveat",
  "transition",
] as const;

export type DiscourseRole = (typeof DISCOURSE_ROLES)[number];

/** What this paragraph is DOING in the paper's argument chain — not what it is
 *  about. The former navigates; the latter degenerates into a summary. */
export const ROLE_LABEL: Record<DiscourseRole, string> = {
  gap: "指出研究缺口",
  prior_work_limit: "承认前人不足",
  notation: "引入记号",
  hypothesis: "提出核心假设",
  method_step: "方法步骤",
  experiment_setup: "实验设置",
  result: "给出结果",
  caveat: "兜底与局限",
  transition: "承上启下",
};

export const DIFFICULTY_LABEL: Record<number, string> = {
  1: "易读",
  2: "较易",
  3: "中等",
  4: "较难",
  5: "劝退级",
};

export interface FormulaSymbol {
  sym: string;
  meaning: string;
}

export interface ReaderUnit {
  id: string;
  order: number;
  section: string;
  sectionOrder: number;
  /** English original — the thing being read. Always present. */
  original: string;

  /**
   * Chinese counterpart.
   *
   * Present for the curated demo paper. Absent for an import until the reader
   * asks for that paragraph, at which point it is generated through the same
   * Cloud Agents chain as an explanation and stored on the reader's own device.
   * Not generated eagerly for all 60-odd paragraphs: that would be 60 discarded
   * upstream Sessions before the reader has decided they want any of it.
   */
  zh?: string;

  /** Interpretive. Absent on an import; see the file header. */
  role?: DiscourseRole;
  /** Interpretive. Absent on an import; see the file header. */
  difficulty?: 1 | 2 | 3 | 4 | 5;
  /**
   * The PDF page this paragraph starts on. Uploaded PDFs only.
   *
   * Worth carrying because a reconstructed reading order can be wrong, and when
   * it is, the reader's only way to check is to open the original file. A page
   * number turns "is this right?" from a hunt into a glance. An arXiv import has
   * no page numbers — its source is HTML — so this stays absent there rather than
   * being faked.
   */
  page?: number;
}

export interface ReaderFormula {
  id: string;
  /**
   * The number the authors printed, e.g. "(1)". Empty for an unnumbered display
   * group — which is the truth, not a gap: MultiHead and the positional
   * encoding in 1706.03762 are genuinely unnumbered in the published paper.
   */
  label: string;
  /** Canonical form, retained for a future KaTeX pass. */
  latex: string;
  /** Renderable now, without adding a typesetting dependency. */
  unicode: string;
  unitId: string;
  /** Interpretive. Empty on an import. */
  symbols: FormulaSymbol[];
  /** Interpretive. Absent on an import. */
  plainReading?: string;
  /** Where the paper itself leans on this formula. Empty on an import. */
  citedIn: string[];
}

export interface Prerequisite {
  term: string;
  explanation: string;
}

export type PaperOrigin = "curated" | "imported" | "pdf";

/**
 * The three origins are three different facts, and a UI branch that tests only
 * two of them will eventually state the wrong one.
 *
 * Writing `origin !== "curated"` everywhere was fine while the alternatives were
 * "curated" and "not". Adding PDF upload turned that second bucket into two
 * papers with different promises — an arXiv import has formula LaTeX and a
 * canonical link, an uploaded file has page numbers and no URL and no formulas —
 * so every branch that actually cares went explicit. `isCurated` survives
 * because "a human read this" really is a binary question; there is deliberately
 * no `isExtracted` helper, because asking it is how a false arXiv attribution
 * gets back into the footer.
 */

/** True for the one paper a human actually read and annotated by hand. */
export function isCurated(paper: Pick<ReaderPaper, "origin">): boolean {
  return paper.origin === "curated";
}

export interface ReaderPaper {
  /**
   * The paper's identity key, and the key every reader-local record hangs off:
   * annotations, reading progress, per-paragraph translations, the device shelf.
   *
   * For an arXiv paper it is the bare id, e.g. `1706.03762`. For an uploaded PDF
   * it is a content-derived id, e.g. `pdf-3f9a1c…`, because the file has no
   * identifier of its own and two readers' copies of the same PDF should not
   * share a shelf slot by accident. The two shapes cannot collide, which is what
   * makes one storage namespace safe for both.
   *
   * The name is historical. It is read as "the document id" everywhere outside
   * the arXiv path, and anything that renders it to a reader goes through
   * `docLabel` rather than printing this field directly.
   */
  arxivId: string;
  title: string;
  authors: string;
  primaryCategory: string;
  /** Reader-facing canonical link. For an import it carries the version suffix,
   *  so "查看原文" lands on the exact text being shown. Empty for an uploaded
   *  PDF: there is no link to give, and inventing one would send the reader to a
   *  search page for a document they already have. */
  url: string;
  /** Drives every "this has not been analysed" caveat in the UI. */
  origin: PaperOrigin;

  /** Curated only. An import reports arXiv's own strings instead. */
  year?: number;
  venue?: string;
  /** arXiv's version watermark, e.g. "v7". Empty when the HTML had none. */
  version?: string;
  /** arXiv's own date string for this version, e.g. "02 Aug 2023". */
  dateText?: string;
  abstract?: string;

  /** Curated only: a human wrote these after reading the paper. */
  prerequisites: Prerequisite[];

  units: ReaderUnit[];
  formulas: ReaderFormula[];

  /** Set when the Function's payload budget dropped trailing paragraphs, or the
   *  source itself was cut. Surfaced, never hidden. */
  truncated?: boolean;
  importedAt?: number;

  /* --- uploaded PDFs only ------------------------------------------- */

  /** The file name the reader chose, shown on the shelf so two papers with the
   *  same extracted title can still be told apart. */
  sourceFileName?: string;
  /** Pages the PDF had. Reported even when parsing stopped early, so the reader
   *  can see how much was not reached. */
  pageCount?: number;
  /**
   * Things the reader must be told about THIS parse, in the reader's language:
   * the title came from the file name, pages yielded no text, the bibliography
   * was cut, the character budget ran out. Kept as finished sentences rather than
   * codes because they are composed here, where the measurements are, instead of
   * being reverse-engineered in the component that renders them.
   */
  parseNotes?: string[];
}

/**
 * How to name this paper's source in one short line.
 *
 * Exists because `arxivId` is not always an arXiv id, and printing `pdf-3f9a1c…`
 * after the word "arXiv:" would be a small, plain lie in the middle of the page.
 */
export function docLabel(paper: ReaderPaper): string {
  if (paper.origin === "pdf") {
    return paper.sourceFileName ? `本机 PDF · ${paper.sourceFileName}` : "本机 PDF";
  }
  return `arXiv:${paper.arxivId}${paper.version ?? ""}`;
}

export interface SectionNode {
  section: string;
  sectionOrder: number;
  unitIds: string[];
}

/**
 * Sections in reading order, derived rather than hand-maintained so the spine
 * can never drift out of sync with the units.
 *
 * Takes the structural minimum rather than a full unit, which is what lets it
 * serve both the curated demo and an import without a second implementation.
 */
export function deriveSections(
  units: ReadonlyArray<Pick<ReaderUnit, "id" | "section" | "sectionOrder">>,
): SectionNode[] {
  const map = new Map<string, SectionNode>();
  for (const unit of units) {
    const existing = map.get(unit.section);
    if (existing) {
      existing.unitIds.push(unit.id);
    } else {
      map.set(unit.section, {
        section: unit.section,
        sectionOrder: unit.sectionOrder,
        unitIds: [unit.id],
      });
    }
  }
  return [...map.values()].sort((a, b) => a.sectionOrder - b.sectionOrder);
}

/**
 * Measured, not asserted.
 *
 * The UI uses this to decide whether to promise the interpretive layer. It is a
 * function of the data rather than a flag on the paper, so a partially curated
 * import cannot claim a completeness it does not have.
 */
export function annotatedUnitCount(paper: ReaderPaper): number {
  return paper.units.filter((unit) => unit.zh && unit.role && unit.difficulty).length;
}

export function isFullyAnnotated(paper: ReaderPaper): boolean {
  return paper.units.length > 0 && annotatedUnitCount(paper) === paper.units.length;
}
