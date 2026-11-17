/**
 * Importing a real arXiv paper, and keeping the ones a reader has imported.
 *
 * Three jobs, in the order they can go wrong:
 *
 *   1. Accept what a reader actually types. People paste `arxiv.org/abs/…`
 *      links, not bare ids. The extraction happens here, on the client, and the
 *      Function still receives only a bare id and re-validates it — so being
 *      generous in the input box does not widen the server's surface at all.
 *
 *   2. Validate the response before any of it reaches the DOM. The Function is
 *      ours, but a response is a response. Every field is checked and capped
 *      here; nothing is rendered on trust.
 *
 *   3. Store imported papers on the reader's device. A paper is ~35 kB of JSON,
 *      so the shelf is capped and evicts oldest-first, and a quota failure
 *      evicts and retries rather than throwing the import away.
 *
 * Why the shelf is localStorage and not the site database: same reasoning as
 * annotations (see lib/annotations.ts). No login, no identity, nothing to scope
 * records by — and nothing that a judge has to do before reading.
 */

import { fetchArxivPaper, ServiceError } from "@/lib/api";
import type { ReaderFormula, ReaderPaper, ReaderUnit } from "@/lib/paper";

/* ------------------------------------------------------------------ */
/* Identifier input                                                    */
/* ------------------------------------------------------------------ */

/** Same rule the Function enforces. Kept in sync by hand and by test. */
const BARE_ID = /^([0-9]{4}\.[0-9]{4,5})(v([1-9][0-9]{0,2}))?$/;

/** Hosts whose URLs we are willing to pull an id out of. */
const ARXIV_HOSTS = new Set(["arxiv.org", "www.arxiv.org", "export.arxiv.org"]);

export type IdInput =
  | { ok: true; id: string; version: string }
  | { ok: false; reason: "empty" | "unrecognized" };

/**
 * `1706.03762`, `1706.03762v7`, `arXiv:1706.03762`, or an abs/pdf/html URL on an
 * arXiv host all resolve to the same bare id.
 *
 * The URL branch checks the host rather than regexing an id out of any string:
 * the point is to save the reader a copy-paste edit, not to accept arbitrary
 * text and hope. And whatever this returns, the Function validates it again.
 */
export function normalizeIdInput(raw: string): IdInput {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty" };

  const direct = BARE_ID.exec(text.toLowerCase());
  if (direct) return { ok: true, id: direct[1], version: direct[2] ?? "" };

  const prefixed = /^(?:arxiv\s*[:：]\s*)?(.+)$/i.exec(text);
  if (prefixed) {
    const inner = BARE_ID.exec(prefixed[1].trim().toLowerCase());
    if (inner) return { ok: true, id: inner[1], version: inner[2] ?? "" };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "unrecognized" };
  }
  if (!ARXIV_HOSTS.has(url.hostname.toLowerCase())) return { ok: false, reason: "unrecognized" };

  // /abs/1706.03762v7, /pdf/1706.03762, /html/1706.03762v7
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const fromUrl = BARE_ID.exec(last.toLowerCase());
  if (fromUrl) return { ok: true, id: fromUrl[1], version: fromUrl[2] ?? "" };

  return { ok: false, reason: "unrecognized" };
}

/* ------------------------------------------------------------------ */
/* Failures, with copy a reader can act on                             */
/* ------------------------------------------------------------------ */

export interface ImportFailure {
  code: string;
  /** Reader-facing Chinese. Never echoes an upstream message. */
  message: string;
  /** Whether "再试一次" is a sensible thing to offer. */
  retryable: boolean;
}

const COPY: Record<string, { message: string; retryable: boolean }> = {
  invalid_arxiv_id: {
    message: "这不像一个 arXiv 编号。编号形如 1706.03762，可以带版本号（1706.03762v7），也可以直接粘贴论文链接。",
    retryable: false,
  },
  paper_not_found: {
    message: "arXiv 上没有这个编号的论文。检查一下数字有没有抄错。",
    retryable: false,
  },
  paper_no_html: {
    message: "这篇论文存在，但 arXiv 没有为它生成可解析的网页版——较早或缺少 LaTeX 源文件的论文常见。换一篇试试。",
    retryable: false,
  },
  paper_too_large: {
    message: "这篇论文的网页版太大，超出单次导入的上限。",
    retryable: false,
  },
  parse_not_latexml: {
    message: "arXiv 返回的不是可解析的论文网页。",
    retryable: true,
  },
  parse_title_missing: {
    message: "没能从这篇论文中读出标题，解析已中止。宁可失败，也不给你一篇来路不明的文章。",
    retryable: true,
  },
  parse_no_readable_units: {
    message: "这篇论文的网页版里没有解析出可读正文。",
    retryable: false,
  },
  arxiv_rate_limited: {
    message: "arXiv 暂时限制了访问，等一两分钟再试。",
    retryable: true,
  },
  arxiv_timeout: {
    message: "抓取 arXiv 超时了。稍后再试一次。",
    retryable: true,
  },
  arxiv_unavailable: {
    message: "arXiv 那边出问题了，稍后再试。",
    retryable: true,
  },
  arxiv_rejected: {
    message: "arXiv 拒绝了这次请求，稍后再试。",
    retryable: true,
  },
  arxiv_unreachable: {
    message: "站点后端连不上 arXiv。这不是你输入的问题。",
    retryable: true,
  },
  network_error: {
    message: "网络不可用，没能连上站点后端。",
    retryable: true,
  },
  client_closed: {
    message: "导入被中断了。",
    retryable: true,
  },
  login_required: {
    message: "这个站点当前需要登录才能访问后端。",
    retryable: false,
  },
  route_not_found: {
    message: "站点后端还没有部署论文导入端点。",
    retryable: false,
  },
  invalid_payload: {
    message: "后端返回的内容不完整。为避免给你一篇残缺的论文，导入已中止。",
    retryable: true,
  },
};

export function describeImportFailure(code: string): ImportFailure {
  const known = COPY[code];
  if (known) return { code, ...known };
  return { code, message: "导入失败。稍后再试一次。", retryable: true };
}

/* ------------------------------------------------------------------ */
/* Response validation                                                 */
/* ------------------------------------------------------------------ */

/** Hard caps, matched to what the Function projects. A response exceeding them
 *  is treated as malformed rather than rendered. */
const MAX_TITLE = 400;
const MAX_AUTHORS = 1200;
const MAX_UNIT_CHARS = 4000;
const MAX_SECTION = 200;
const MAX_ABSTRACT = 6000;
const MAX_FORMULA_CHARS = 2000;
/** Below this a "paragraph" is a heading fragment or a table cell, not prose. */
const MIN_UNIT_CHARS = 20;
/** Mirrors the Function's own rule: fewer survivors means the import failed,
 *  not that the paper is short. */
const MIN_VIABLE_UNITS = 4;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function objects(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row),
  );
}

/**
 * Projects an untrusted payload into a `ReaderPaper`.
 *
 * Returns null rather than throwing on a malformed response: the caller turns
 * that into `invalid_payload`, which is a code the reader sees as "后端返回的内
 * 容不完整" instead of a stack trace.
 *
 * Units that are individually malformed are dropped, and the whole import fails
 * if too few survive. Dropping silently would leave a gap in the middle of a
 * paper — the same failure the Function's payload budget refuses to produce.
 */
export function toReaderPaper(payload: unknown): ReaderPaper | null {
  if (!payload || typeof payload !== "object") return null;
  const paper = (payload as Record<string, unknown>).paper;
  if (!paper || typeof paper !== "object") return null;
  const record = paper as Record<string, unknown>;

  const arxivId = text(record.arxivId, 20);
  if (!/^[0-9]{4}\.[0-9]{4,5}$/.test(arxivId)) return null;

  const title = text(record.title, MAX_TITLE).trim();
  if (!title) return null;

  const version = text(record.version, 8);
  const rawUnits = objects(record.units);

  const units: ReaderUnit[] = [];
  for (const row of rawUnits) {
    const id = text(row.id, 120);
    const original = text(row.original, MAX_UNIT_CHARS);
    if (!id || original.trim().length < MIN_UNIT_CHARS) continue;
    units.push({
      id,
      // Renumbered from position rather than taken from the response: if a
      // malformed unit was dropped above, the server's numbering would leave a
      // hole, and the spine and aria-labels read that as a missing paragraph.
      order: units.length + 1,
      section: text(row.section, MAX_SECTION).trim() || "正文",
      sectionOrder: integer(row.sectionOrder, units.length + 1),
      original,
    });
  }
  if (units.length < MIN_VIABLE_UNITS) return null;

  const unitIds = new Set(units.map((unit) => unit.id));

  const formulas: ReaderFormula[] = [];
  for (const row of objects(record.formulas)) {
    const id = text(row.id, 120);
    const unicode = text(row.unicode, MAX_FORMULA_CHARS).trim();
    const unitId = text(row.unitId, 120);
    if (!id || !unicode) continue;
    // A formula whose paragraph did not survive validation would render in no
    // section at all, or worse, next to the wrong one.
    if (unitId && !unitIds.has(unitId)) continue;
    formulas.push({
      id,
      label: text(row.label, 12),
      latex: text(row.latex, MAX_FORMULA_CHARS),
      unicode,
      unitId,
      // Empty, not fabricated. See lib/paper.ts: an import states what the
      // paper says and nothing it does not.
      symbols: [],
      citedIn: [],
    });
  }

  return {
    arxivId,
    title,
    authors: text(record.authors, MAX_AUTHORS).trim(),
    primaryCategory: text(record.primaryCategory, 40).trim(),
    // Taken from the response only when it is an arxiv.org link. Anything else
    // falls back to the canonical form built from the validated id, so a
    // compromised or buggy upstream cannot turn this into a navigation target.
    url: normalizePaperUrl(text(record.url, 300), arxivId, version),
    origin: "imported",
    version: /^v[1-9][0-9]{0,2}$/.test(version) ? version : "",
    dateText: text(record.dateText, 40).trim(),
    abstract: text(record.abstract, MAX_ABSTRACT).trim(),
    prerequisites: [],
    units,
    formulas,
    truncated: record.truncated === true,
    // Preserved when present. This function validates a network response AND a
    // record read back off the shelf, and stamping `now` on a shelf record would
    // make every stored paper look freshly imported — which is exactly the value
    // oldest-first eviction sorts on.
    importedAt: positiveInteger(record.importedAt) ?? Date.now(),
  };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function normalizePaperUrl(raw: string, arxivId: string, version: string): string {
  const fallback = `https://arxiv.org/abs/${arxivId}${version}`;
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    return url.hostname.toLowerCase() === "arxiv.org" && url.protocol === "https:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Uploaded-PDF records                                                */
/* ------------------------------------------------------------------ */

/** The shape `lib/pdf.ts` mints for an uploaded file's identity. */
export const PDF_DOC_ID = /^pdf-[0-9a-f]{8,40}$/;

/**
 * Validates an uploaded-PDF paper read back off the shelf.
 *
 * A separate function from `toReaderPaper` rather than a branch inside it,
 * because the two records disagree on almost everything that matters: the id
 * shape, the absence of a URL, the absence of formulas, and the presence of
 * `parseNotes` that the reader must be shown again on every reload. Folding them
 * into one validator would mean a single function whose every line is
 * conditional on which kind of paper it is holding.
 *
 * Same discipline as the arXiv one, and for the same reason: this reads from
 * localStorage, which any script on the origin can write to and any older build
 * of this site could have written to in a shape that no longer exists. Nothing
 * here is rendered on trust.
 */
export function toStoredPdfPaper(record: Record<string, unknown>): ReaderPaper | null {
  const docId = text(record.arxivId, 60);
  if (!PDF_DOC_ID.test(docId)) return null;

  const title = text(record.title, MAX_TITLE).trim();
  if (!title) return null;

  const rawUnits = objects(record.units);
  const units: ReaderUnit[] = [];
  for (const row of rawUnits) {
    const id = text(row.id, 120);
    const original = text(row.original, MAX_UNIT_CHARS);
    if (!id || original.trim().length < MIN_UNIT_CHARS) continue;
    units.push({
      id,
      order: units.length + 1,
      section: text(row.section, MAX_SECTION).trim() || "正文",
      sectionOrder: integer(row.sectionOrder, units.length + 1),
      original,
      page: positiveInteger(row.page) ?? undefined,
    });
  }
  if (units.length < MIN_VIABLE_UNITS) return null;

  // Notes are re-capped rather than trusted: they are sentences rendered
  // verbatim into the page, and a record edited in storage could put anything
  // there. A note over the cap is dropped, which loses a caveat at worst.
  const parseNotes = Array.isArray(record.parseNotes)
    ? record.parseNotes
        .filter((note): note is string => typeof note === "string")
        .map((note) => note.slice(0, 400))
        .slice(0, 12)
    : [];

  return {
    arxivId: docId,
    title,
    authors: text(record.authors, MAX_AUTHORS).trim(),
    primaryCategory: "",
    // Never restored from storage. An uploaded file has no canonical URL, and
    // accepting one from a record would turn this field into an open redirect
    // that the reader's own storage controls.
    url: "",
    origin: "pdf",
    prerequisites: [],
    units,
    // A PDF parse produces no formulas, so a record claiming some is either
    // corrupt or hand-edited. Either way, dropping them is safe: the UI renders
    // nothing, and no reader loses a formula they were shown before.
    formulas: [],
    truncated: record.truncated === true,
    importedAt: positiveInteger(record.importedAt) ?? Date.now(),
    sourceFileName: text(record.sourceFileName, 200).trim(),
    pageCount: positiveInteger(record.pageCount) ?? undefined,
    parseNotes,
  };
}

/* ------------------------------------------------------------------ */
/* The shelf                                                           */
/* ------------------------------------------------------------------ */

const NS = "marginalia";
const INDEX_KEY = `${NS}:library:index`;
const paperKey = (arxivId: string) => `${NS}:library:paper:${arxivId}`;
const LAST_KEY = `${NS}:last`;

/** ~35 kB per arXiv paper and up to ~300 kB of extracted text per PDF, so ten
 *  of them is still a workable fraction of a 5 MB quota — and `saveImportedPaper`
 *  evicts oldest-first when it is not. */
const MAX_LIBRARY_PAPERS = 10;

export type LibraryKind = "arxiv" | "pdf";

export interface LibraryEntry {
  arxivId: string;
  version: string;
  title: string;
  authors: string;
  primaryCategory: string;
  dateText: string;
  url: string;
  unitCount: number;
  importedAt: number;
  /**
   * Which kind of paper this is.
   *
   * Absent on records written before PDF upload existed, so every read defaults
   * to `"arxiv"`. That default is what keeps an existing reader's shelf working
   * after this change instead of silently emptying it.
   */
  kind?: LibraryKind;
  /** Uploaded PDFs only: the file name, so two papers with the same extracted
   *  title can still be told apart on the shelf. */
  fileName?: string;
  /** Uploaded PDFs only. */
  pageCount?: number;
}

export type LastChoice =
  | { kind: "demo" }
  | { kind: "arxiv"; arxivId: string }
  | { kind: "pdf"; docId: string };

function available(): boolean {
  try {
    const probe = `${NS}:__probe__`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

const STORAGE_OK = available();

function readJson<T>(key: string, fallback: T): T {
  if (!STORAGE_OK) return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as T;
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): boolean {
  if (!STORAGE_OK) return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function libraryAvailable(): boolean {
  return STORAGE_OK;
}

export function listLibrary(): LibraryEntry[] {
  const rows = readJson<LibraryEntry[]>(INDEX_KEY, []);
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (row) =>
        row &&
        typeof row.arxivId === "string" &&
        typeof row.title === "string" &&
        (row.kind === "pdf" || row.kind === "arxiv" || row.kind === undefined),
    )
    .map((row) => ({ ...row, kind: row.kind ?? ("arxiv" as LibraryKind) }))
    .sort((a, b) => (b.importedAt ?? 0) - (a.importedAt ?? 0));
}

/**
 * Reads a paper back off the shelf, whichever kind it is.
 *
 * Dispatches on the stored `origin` rather than on the id's shape: `origin` is
 * the field the writer set, so it is the one that says what the record is. Shape
 * sniffing would work today and quietly break the first time an id format moves.
 *
 * Re-validated on the way out in both branches. A record written by an older
 * build, or edited by hand, must not be trusted just because it came from our
 * own storage.
 */
export function loadImportedPaper(docId: string): ReaderPaper | null {
  const stored = readJson<Record<string, unknown> | null>(paperKey(docId), null);
  if (!stored || typeof stored !== "object") return null;
  return stored.origin === "pdf"
    ? toStoredPdfPaper(stored)
    : toReaderPaper({ paper: stored });
}

export function removeFromLibrary(arxivId: string): LibraryEntry[] {
  const next = listLibrary().filter((row) => row.arxivId !== arxivId);
  writeJson(INDEX_KEY, next);
  if (STORAGE_OK) {
    try {
      localStorage.removeItem(paperKey(arxivId));
    } catch {
      /* non-fatal */
    }
  }
  return next;
}

/**
 * Stores a paper and its shelf entry, evicting oldest-first on quota failure.
 *
 * Eviction retries rather than giving up: the reader just waited on a network
 * fetch and a parse, and losing that to a full localStorage would be a bad trade
 * for a stale copy of a paper they read last week.
 */
export function saveImportedPaper(paper: ReaderPaper): boolean {
  if (!STORAGE_OK) return false;

  const entry: LibraryEntry = {
    arxivId: paper.arxivId,
    version: paper.version ?? "",
    title: paper.title,
    authors: paper.authors,
    primaryCategory: paper.primaryCategory,
    dateText: paper.dateText ?? "",
    url: paper.url,
    unitCount: paper.units.length,
    importedAt: paper.importedAt ?? Date.now(),
    kind: paper.origin === "pdf" ? "pdf" : "arxiv",
    fileName: paper.sourceFileName,
    pageCount: paper.pageCount,
  };

  const index = listLibrary().filter((row) => row.arxivId !== paper.arxivId);
  index.unshift(entry);

  for (let attempt = 0; attempt <= MAX_LIBRARY_PAPERS; attempt += 1) {
    const trimmed = index.slice(0, MAX_LIBRARY_PAPERS);
    if (writeJson(paperKey(paper.arxivId), paper)) {
      writeJson(INDEX_KEY, trimmed);
      // Drop the stored bodies of entries that fell off the end, or they linger
      // and consume quota for papers the shelf no longer lists.
      for (const stale of index.slice(MAX_LIBRARY_PAPERS)) {
        try {
          localStorage.removeItem(paperKey(stale.arxivId));
        } catch {
          /* non-fatal */
        }
      }
      return true;
    }
    // Quota. Evict the oldest other paper and try again.
    const victim = trimmed[trimmed.length - 1];
    if (!victim || victim.arxivId === paper.arxivId) return false;
    index.splice(index.indexOf(victim), 1);
    try {
      localStorage.removeItem(paperKey(victim.arxivId));
    } catch {
      /* non-fatal */
    }
  }
  return false;
}

export function loadLastChoice(): LastChoice {
  const stored = readJson<LastChoice | null>(LAST_KEY, null);
  if (stored && stored.kind === "arxiv" && typeof stored.arxivId === "string") return stored;
  // The id is re-checked on the way out, not just on the way in. A stale or
  // edited record whose `kind` says "pdf" but whose id is not a document id must
  // fall through to the demo rather than send `loadImportedPaper` off looking for
  // a shelf slot that can never exist.
  if (stored && stored.kind === "pdf" && PDF_DOC_ID.test(stored.docId)) return stored;
  return { kind: "demo" };
}

export function saveLastChoice(choice: LastChoice): void {
  writeJson(LAST_KEY, choice);
}

/* ------------------------------------------------------------------ */
/* The import itself                                                   */
/* ------------------------------------------------------------------ */

export interface ImportSuccess {
  ok: true;
  paper: ReaderPaper;
  /** True when the paper came from the device shelf rather than the network. */
  fromShelf: boolean;
}

export interface ImportRejected {
  ok: false;
  failure: ImportFailure;
}

export type ImportResult = ImportSuccess | ImportRejected;

/**
 * Full import flow: normalize the reader's input, prefer the local shelf,
 * otherwise fetch, validate, and store.
 *
 * `force` re-fetches even when the paper is on the shelf. arXiv content at a
 * given version is immutable, so the cached copy is not stale — but a reader who
 * suspects a bad parse should be able to ask again without clearing storage.
 */
export async function importArxivPaper(rawInput: string, force = false): Promise<ImportResult> {
  const input = normalizeIdInput(rawInput);
  if (!input.ok) {
    return {
      ok: false,
      failure:
        input.reason === "empty"
          ? { code: "empty_input", message: "先输入一个 arXiv 编号或论文链接。", retryable: false }
          : describeImportFailure("invalid_arxiv_id"),
    };
  }

  if (!force) {
    const cached = loadImportedPaper(input.id);
    if (cached) return { ok: true, paper: cached, fromShelf: true };
  }

  let payload: unknown;
  try {
    payload = await fetchArxivPaper(input.id);
  } catch (error) {
    const code = error instanceof ServiceError ? error.code : "network_error";
    return { ok: false, failure: describeImportFailure(code) };
  }

  const paper = toReaderPaper(payload);
  if (!paper) return { ok: false, failure: describeImportFailure("invalid_payload") };

  // A failed write is not a failed import: the paper is in memory and readable
  // right now. It simply will not be on the shelf after a reload.
  saveImportedPaper(paper);
  return { ok: true, paper, fromShelf: false };
}
