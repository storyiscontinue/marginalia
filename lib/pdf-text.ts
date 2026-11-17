/**
 * PDF text extraction, without the browser.
 *
 * This module is the part of the PDF path that can be run outside a page: it
 * turns pdf.js's already-obtained text items into a reader-facing paper, and it
 * imports nothing that touches the DOM, localStorage or Vite's build.
 *
 * The split is load-bearing, not tidiness. `lib/pdf.ts` owns the pdf.js worker
 * and the device shelf, which means it has a `?worker` import that only Vite can
 * resolve — so nothing that imports it can run under Node, and Node is the only
 * place this project can execute a test. Living here is what lets
 * `dev/test-pdf-layout.ts` drive the real layout code against real published PDFs
 * and assert the reading order that comes out.
 *
 * Relative imports, not `@/`, for the same reason: the alias is a Vite and
 * tsconfig setting that Node's type-stripping does not know about. See
 * `functions/arxiv-parse.ts`, which is dependency-free for exactly the same
 * purpose.
 */

import {
  analyseRuns,
  applyBoldClassification,
  type LayoutResult,
  type PdfRun,
} from "./pdf-layout.ts";
import type { ReaderPaper, ReaderUnit } from "./paper.ts";

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/**
 * Upload cap.
 *
 * 60 MB is far above any journal article and below the point where reading a
 * 200 MB file into browser memory becomes rude. The cap exists so the failure is
 * a sentence rather than a crashed tab.
 */
export const MAX_PDF_BYTES = 60 * 1024 * 1024;

/**
 * Pages parsed.
 *
 * A 75-page monograph parses fine but is not something a person reads in one
 * sitting, and every page past this one costs memory in a tab that also holds
 * the reader's annotations. Reaching the cap is reported as a note on the paper,
 * not hidden — the reader is told how many pages the file actually has.
 */
export const MAX_PDF_PAGES = 60;

/** Fewer viable paragraphs than this means the parse failed, not that the
 *  document is short. Mirrors the arXiv path's own floor. */
const MIN_VIABLE_UNITS = 4;

/* ------------------------------------------------------------------ */
/* Failures                                                            */
/* ------------------------------------------------------------------ */

export interface PdfFailure {
  code: string;
  message: string;
  retryable: boolean;
}

const COPY: Record<string, PdfFailure> = {
  not_a_pdf: {
    code: "not_a_pdf",
    message: "这个文件不是 PDF。请选一个 .pdf 文件。",
    retryable: false,
  },
  pdf_too_large: {
    code: "pdf_too_large",
    message: "这个 PDF 太大了（上限 60 MB）。多数论文都在 10 MB 以内，你选的可能是一份扫描合订本。",
    retryable: false,
  },
  pdf_empty: {
    code: "pdf_empty",
    message: "这个 PDF 里没有页面。",
    retryable: false,
  },
  pdf_encrypted: {
    code: "pdf_encrypted",
    message: "这个 PDF 有密码保护，浏览器解不开。请先在自己的电脑上解除密码再上传。",
    retryable: false,
  },
  pdf_no_text: {
    code: "pdf_no_text",
    message:
      "这个 PDF 里没有可提取的文字——多半是扫描件或图片版。这里不做 OCR：与其给你一份满是错字的正文，不如直说读不了。如果这篇论文在 arXiv 上，用下面的编号导入可以拿到完整正文。",
    retryable: false,
  },
  pdf_too_few_paragraphs: {
    code: "pdf_too_few_paragraphs",
    message:
      "从这份 PDF 里没能解析出足够的正文段落。可能是扫描件、幻灯片，或者版面很不规则。如果这篇论文在 arXiv 上，用编号导入会更可靠。",
    retryable: false,
  },
  pdf_unreadable: {
    code: "pdf_unreadable",
    message: "这个 PDF 解析失败了，文件可能已损坏。换一份试试。",
    retryable: true,
  },
  pdf_read_error: {
    code: "pdf_read_error",
    message: "浏览器没能读取这个文件。可能被其他程序占用，或者权限不足。",
    retryable: true,
  },
};

/**
 * Reader-facing copy for every way a PDF import can fail.
 *
 * Unknown codes get a retryable generic message rather than the code name. An
 * internal identifier on screen tells the reader nothing and makes the product
 * look like it is showing them a stack trace, which is the impression this
 * feature cannot afford on a first attempt.
 */
export function describePdfFailure(code: string): PdfFailure {
  const known = COPY[code];
  if (known) return known;
  return { code, message: "导入失败。稍后再试一次。", retryable: true };
}

/* ------------------------------------------------------------------ */
/* pdf.js text -> positioned runs                                      */
/* ------------------------------------------------------------------ */

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Converts one page's `getTextContent()` result into positioned runs.
 *
 * Written against a structural type, validating every field, rather than
 * importing pdf.js's own: the library's item shape has moved between major
 * versions, and a field that turns up `undefined` should degrade to a dropped
 * run rather than a `NaN` coordinate that silently mis-sorts a line into the
 * wrong place in the reading order.
 *
 * Two kinds of item are dropped on purpose:
 *
 *   - Empty strings. pdf.js emits a zero-width placeholder before most real
 *     items; measured on a real arXiv PDF, roughly a third of the items on a
 *     title page are these. Keeping them would pull every line's left edge to
 *     the placeholder's position and wreck the ragged-end test downstream.
 *   - Rotated text, recognised by a text matrix whose vertical scale dominates
 *     its horizontal one. In an academic PDF this is almost always the arXiv
 *     margin watermark. When it is something else — a rotated table header, a
 *     figure's axis label — it has no place in a top-to-bottom reading order
 *     anyway, and inserting one glyph-per-line streak would shred the paragraph
 *     it landed in.
 */
export function runsFromTextContent(
  items: readonly unknown[],
  pageNumber: number,
  pageWidth: number,
  pageHeight: number,
): PdfRun[] {
  const runs: PdfRun[] = [];

  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;

    const str = item.str;
    if (typeof str !== "string" || str.length === 0) continue;

    const transform = Array.isArray(item.transform) ? item.transform : [];
    const a = numberOf(transform[0]);
    const b = numberOf(transform[1]);
    const c = numberOf(transform[2]);
    const d = numberOf(transform[3]);
    const x = numberOf(transform[4]);
    const y = numberOf(transform[5]);

    // Rotated.
    if (Math.abs(b) > Math.abs(a)) continue;

    const fontSize = Math.hypot(c, d) || numberOf(item.height);
    if (fontSize <= 0) continue;

    runs.push({
      page: pageNumber,
      x,
      y,
      width: Math.max(0, numberOf(item.width)),
      fontSize,
      str,
      // Filled in afterwards by `applyBoldClassification`, which has to see
      // every font in the document before it can say which one is the bold face.
      bold: false,
      fontName: typeof item.fontName === "string" ? item.fontName : "",
      pageWidth,
      pageHeight,
    });
  }

  return runs;
}

/* ------------------------------------------------------------------ */
/* Document identity                                                   */
/* ------------------------------------------------------------------ */

/**
 * A stable id for an uploaded file, derived from its bytes.
 *
 * Content-addressed rather than random, so uploading the same paper twice reopens
 * the same shelf slot with the same annotations instead of creating a second
 * copy that looks identical. The `pdf-` prefix keeps the shape distinct from an
 * arXiv id, which is what lets both kinds share one storage namespace and one
 * hash-route parser without either being mistaken for the other.
 *
 * `crypto.subtle` needs a secure context. The published site has one; a local
 * `file://` preview does not, so the fallback derives an id from the file's name,
 * size and modification time. Weaker — and explicitly labelled weaker in the
 * comment, because the reader's annotations are keyed on this value and a
 * collision would put their notes on the wrong paper.
 */
export async function contentId(
  buffer: ArrayBuffer,
  file: { name: string; size: number; lastModified: number },
): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `pdf-${hex.slice(0, 20)}`;
  } catch {
    const seed = `${file.name}|${file.size}|${file.lastModified}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `pdf-${hash.toString(16).padStart(8, "0")}`;
  }
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

export interface PdfSourceInfo {
  docId: string;
  fileName: string;
  /** Pages the file actually has. */
  pageCount: number;
  /** Pages this run parsed, which is `min(pageCount, MAX_PDF_PAGES)`. */
  pagesParsed: number;
  /** The PDF's own `/Title` metadata, when it has one that is not empty. */
  metadataTitle: string;
}

/** Strips a file extension and the punctuation that would read as a filename. */
function titleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.[^.]{1,5}$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * Turns a layout result into the reader-facing paper model.
 *
 * Returns null when too few paragraphs survived, which the caller reports as a
 * failed import. Producing a three-paragraph "paper" instead would be worse than
 * failing: the reader would sit down to read something and find a fragment.
 *
 * The title has three sources, tried in order of trustworthiness, and the reader
 * is told which one was used whenever it was not the document itself. A paper
 * titled after its file name (`1706.03762v7.pdf`) is a small indignity; that same
 * paper silently titled after a filename the reader does not recognise is a
 * reason to distrust everything else on the page.
 */
export function assemblePdfPaper(layout: LayoutResult, source: PdfSourceInfo): ReaderPaper | null {
  const units: ReaderUnit[] = [];
  for (const paragraph of layout.paragraphs) {
    const text = paragraph.text.trim();
    if (!text) continue;
    units.push({
      id: `u${units.length + 1}`,
      order: units.length + 1,
      section: paragraph.section,
      sectionOrder: paragraph.sectionOrder,
      original: text,
      page: paragraph.page,
    });
  }
  if (units.length < MIN_VIABLE_UNITS) return null;

  const notes: string[] = [];

  const metadataTitle = source.metadataTitle.trim();
  let title = layout.title ?? "";
  if (!title && metadataTitle.length >= 6 && metadataTitle.length <= 300) {
    title = metadataTitle;
    notes.push("标题取自 PDF 文件自身的元数据。");
  }
  if (!title) {
    title = titleFromFileName(source.fileName) || "未命名文档";
    notes.push("没能从版面里认出标题，这里用的是文件名。正文本身是完整的。");
  }

  if (!layout.authors) {
    notes.push(
      "没能可靠地分辨出作者行，所以这里不显示作者——与其把单位和邮箱当成人名列出来，不如留空。",
    );
  }

  if (source.pageCount > source.pagesParsed) {
    notes.push(
      `这份 PDF 共 ${source.pageCount} 页，本次解析了前 ${source.pagesParsed} 页。后面的内容没有读入，不是丢失，是没有解析。`,
    );
  }
  if (layout.stoppedAtReferences) {
    notes.push("参考文献列表已略去：那是引用条目，不是可以逐句读的正文。");
  }
  if (layout.omittedLabels > 0) {
    notes.push(
      `图和表里的 ${layout.omittedLabels} 行文字（坐标轴刻度、单元格数字）没有读入——它们不是句子，划出来也问不出什么。图表的标题（Figure 3、Table 1 那些）保留了。`,
    );
  }
  if (layout.omittedFootnotes > 0) {
    notes.push(
      `页面底部的 ${layout.omittedFootnotes} 行脚注没有读入。脚注是作者写给正文的补充说明，不在正文的句子里——需要看它请回原 PDF。`,
    );
  }
  if (layout.omittedMetadata > 0) {
    notes.push(
      `扉页的 ${layout.omittedMetadata} 段标签（关键词表、学科分类码、DOI 链接）没有读入——那是论文的索引卡，不是可以逐句读的文字。摘要保留了。`,
    );
  }
  if (layout.budgetExhausted) {
    notes.push("正文超出了单次导入的容量上限，末尾若干段落没有读入。上面显示的就是已读入的全部。");
  }
  /*
   * The one caveat that is a property of every PDF rather than of this document,
   * and still worth a number. Measured on the ResNet PDF: 144 of these joins, and
   * the reader will meet them mid-sentence. Saying where they come from is what
   * turns "this parser misspells words" into "the file broke the line there" —
   * and it is true even in the cases we cannot tell apart, because the hyphen
   * really is in the file.
   */
  if (layout.linebreakHyphens > 0) {
    notes.push(
      `解析时遇到 ${layout.linebreakHyphens} 处跨行断词，断词处的连字符被原样保留（所以你会看到 ex-tremely 这样的词）。PDF 的文字层里，自动断词和原文自带的连字符（state-of-the-art）是同一个符号，去掉它会把后者拼成错词，所以宁可留着一个能看懂的连字符。`,
    );
  }
  if (layout.blankPages.length > 0) {
    notes.push(
      layout.blankPages.length <= 12
        ? `第 ${layout.blankPages.join("、")} 页没有提取到文字，可能是整页图片或图表。`
        : `有 ${layout.blankPages.length} 页没有提取到文字，可能是整页图片或图表。`,
    );
  }

  return {
    arxivId: source.docId,
    title,
    authors: layout.authors ?? "",
    // Unknown and unknowable from a PDF's bytes. Left empty rather than filled
    // with a guess: this string is rendered, and a category repeated on every
    // uploaded paper is noise the reader learns to ignore.
    primaryCategory: "",
    url: "",
    origin: "pdf",
    prerequisites: [],
    units,
    // See this module's header. Extracted as an empty list on purpose; a formula
    // card holding mis-ordered glyphs would be actively misleading.
    formulas: [],
    truncated: layout.budgetExhausted,
    importedAt: Date.now(),
    sourceFileName: source.fileName,
    pageCount: source.pageCount,
    parseNotes: notes,
  };
}

/* ------------------------------------------------------------------ */
/* The pure pipeline, exposed for tests                                */
/* ------------------------------------------------------------------ */

/**
 * Everything from pdf.js's per-page output to a finished paper, with no I/O.
 *
 * `familiesOf` maps a pdf.js font key to its CSS fallback family, which is all
 * pdf.js will tell you about a font and is the input `applyBoldClassification`
 * needs. The caller supplies it as a function rather than the `styles` object so
 * this module never has to know pdf.js's shape at all.
 */
export function buildPdfPaper(
  runs: readonly PdfRun[],
  familyOf: (fontName: string) => string,
  source: PdfSourceInfo,
): { paper: ReaderPaper | null; layout: LayoutResult } {
  const classified = applyBoldClassification(runs, familyOf);
  const layout = analyseRuns(classified, source.pagesParsed);
  return { layout, paper: assemblePdfPaper(layout, source) };
}
