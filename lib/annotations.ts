/**
 * Annotation persistence — device-local by design.
 *
 * Why localStorage and not the site database (docs/规划书 §6.3):
 *   1. A judge must get the full experience with zero login. The competition
 *      rules require the work to be usable within five steps of opening it.
 *   2. The Sites Gateway does not treat a browser-supplied user id as a
 *      verified application identity, so anonymous records cannot be safely
 *      scoped server-side without an identity story we deliberately cut.
 *   3. Platform guidance is explicit that browser storage is the right home
 *      for device-local state.
 *
 * The product consequence is the point of the whole project: the notes belong
 * to the reader, live on their machine, and survive a reload.
 */

import type { ReaderPaper } from "@/lib/paper";

export type ExplainMode = "sentence" | "term" | "formula" | "custom" | "note";

export interface AnnotationAnchor {
  /** Character offsets within the unit's ORIGINAL English text. */
  start: number;
  end: number;
  /** The selected text itself. */
  text: string;
  /** Up to 24 chars preceding the selection. Used to re-locate the anchor if
   *  offsets drift, so a note is never silently attached to the wrong span. */
  prefix: string;
}

export interface Annotation {
  id: string;
  unitId: string;
  anchor: AnnotationAnchor;
  mode: ExplainMode;
  /** What the reader asked. Preserved alongside the answer on purpose — this
   *  pairing is the actual product innovation, not the explanation itself. */
  question: string;
  /** What the model answered. */
  answer: string;
  /** The reader's own version. Wins over `answer` whenever editedByUser. */
  userNote: string;
  editedByUser: boolean;
  /** Set when a term was recognised, feeding cross-paper term memory. */
  term?: string;
  pending?: boolean;
  failed?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TermMemory {
  term: string;
  normalized: string;
  explanation: string;
  firstPaper: string;
  firstSeenAt: number;
  lastRecalledAt: number;
  recallCount: number;
}

const NS = "marginalia";
const annotationsKey = (arxivId: string) => `${NS}:annotations:${arxivId}`;
const TERMS_KEY = `${NS}:terms`;

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as T;
    return value ?? fallback;
  } catch {
    // Corrupt or hand-edited storage must not brick the reader.
    return fallback;
  }
}

function available(): boolean {
  try {
    const probe = `${NS}:__probe__`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    // Private mode or a disabled storage API. The reader still works for the
    // current session; notes simply will not survive a reload.
    return false;
  }
}

const STORAGE_OK = available();

export function storageAvailable(): boolean {
  return STORAGE_OK;
}

export function newId(): string {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ */
/* Anchoring                                                           */
/* ------------------------------------------------------------------ */

export const PREFIX_LEN = 24;

export function makeAnchor(original: string, start: number, end: number): AnnotationAnchor {
  const clampedStart = Math.max(0, Math.min(start, original.length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, original.length));
  return {
    start: clampedStart,
    end: clampedEnd,
    text: original.slice(clampedStart, clampedEnd),
    prefix: original.slice(Math.max(0, clampedStart - PREFIX_LEN), clampedStart),
  };
}

/**
 * Resolve a stored anchor against the current unit text.
 * Returns null when the span can no longer be located — the caller should then
 * surface the note as orphaned rather than highlight the wrong words.
 */
export function resolveAnchor(
  anchor: AnnotationAnchor,
  original: string,
): { start: number; end: number } | null {
  if (!anchor.text) return null;

  // Fast path: offsets still line up.
  if (original.slice(anchor.start, anchor.end) === anchor.text) {
    return { start: anchor.start, end: anchor.end };
  }

  // Drift path: use the prefix fingerprint to find the original neighbourhood.
  if (anchor.prefix) {
    const at = original.indexOf(anchor.prefix);
    if (at >= 0) {
      const start = at + anchor.prefix.length;
      if (original.slice(start, start + anchor.text.length) === anchor.text) {
        return { start, end: start + anchor.text.length };
      }
    }
  }

  // Last resort: the selected text is still unique in the passage.
  const first = original.indexOf(anchor.text);
  if (first >= 0 && original.indexOf(anchor.text, first + 1) === -1) {
    return { start: first, end: first + anchor.text.length };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Annotations                                                         */
/* ------------------------------------------------------------------ */

export function loadAnnotations(arxivId: string): Annotation[] {
  if (!STORAGE_OK) return [];
  const rows = safeParse<Annotation[]>(localStorage.getItem(annotationsKey(arxivId)), []);
  return Array.isArray(rows) ? rows.filter(isAnnotation).sort((a, b) => a.createdAt - b.createdAt) : [];
}

function isAnnotation(value: unknown): value is Annotation {
  if (!value || typeof value !== "object") return false;
  const a = value as Partial<Annotation>;
  return (
    typeof a.id === "string" &&
    typeof a.unitId === "string" &&
    !!a.anchor &&
    typeof a.anchor.text === "string"
  );
}

function persist(arxivId: string, rows: Annotation[]): void {
  if (!STORAGE_OK) return;
  try {
    localStorage.setItem(annotationsKey(arxivId), JSON.stringify(rows));
  } catch {
    // Quota exceeded. Losing a note is bad; crashing the reader is worse.
  }
}

export function upsertAnnotation(arxivId: string, annotation: Annotation): Annotation[] {
  const rows = loadAnnotations(arxivId);
  const index = rows.findIndex((row) => row.id === annotation.id);
  const stamped: Annotation = { ...annotation, updatedAt: Date.now() };
  if (index >= 0) rows[index] = stamped;
  else rows.push(stamped);
  persist(arxivId, rows);
  return rows;
}

export function deleteAnnotation(arxivId: string, id: string): Annotation[] {
  const rows = loadAnnotations(arxivId).filter((row) => row.id !== id);
  persist(arxivId, rows);
  return rows;
}

/** The reader's own edit always takes precedence over the model's answer. */
export function editUserNote(arxivId: string, id: string, userNote: string): Annotation[] {
  const rows = loadAnnotations(arxivId).map((row) =>
    row.id === id ? { ...row, userNote, editedByUser: true, updatedAt: Date.now() } : row,
  );
  persist(arxivId, rows);
  return rows;
}

export function effectiveNote(annotation: Annotation): string {
  const own = annotation.userNote.trim();
  return own.length > 0 ? own : annotation.answer.trim();
}

/* ------------------------------------------------------------------ */
/* Cross-paper term memory                                             */
/* ------------------------------------------------------------------ */

export function normalizeTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!?()[\]]/g, "");
}

export function loadTerms(): Record<string, TermMemory> {
  if (!STORAGE_OK) return {};
  return safeParse<Record<string, TermMemory>>(localStorage.getItem(TERMS_KEY), {});
}

export function rememberTerm(
  paper: Pick<ReaderPaper, "title">,
  term: string,
  explanation: string,
): Record<string, TermMemory> {
  const normalized = normalizeTerm(term);
  if (!normalized) return loadTerms();
  const all = loadTerms();
  const now = Date.now();
  const existing = all[normalized];
  all[normalized] = existing
    ? {
        ...existing,
        explanation: explanation.trim() || existing.explanation,
        lastRecalledAt: now,
        recallCount: existing.recallCount + 1,
      }
    : {
        term: term.trim(),
        normalized,
        explanation: explanation.trim(),
        firstPaper: paper.title,
        firstSeenAt: now,
        lastRecalledAt: now,
        recallCount: 1,
      };
  if (STORAGE_OK) {
    try {
      localStorage.setItem(TERMS_KEY, JSON.stringify(all));
    } catch {
      /* non-fatal */
    }
  }
  return all;
}

/**
 * Scan a passage for terms the reader has already asked about elsewhere.
 * This is the affordance no summary-style product can build: it only exists
 * because questions and answers were persisted against their sentences.
 */
export function findKnownTerms(
  text: string,
  excludeArxivId?: string,
): Array<{ term: string; memory: TermMemory }> {
  const all = loadTerms();
  const lower = text.toLowerCase();
  const hits: Array<{ term: string; memory: TermMemory }> = [];
  for (const memory of Object.values(all)) {
    if (excludeArxivId && memory.firstPaper === excludeArxivId) continue;
    if (!memory.normalized) continue;
    if (lower.includes(memory.normalized)) hits.push({ term: memory.term, memory });
  }
  // Longest first so "attention mechanism" wins over "attention".
  return hits.sort((a, b) => b.memory.normalized.length - a.memory.normalized.length).slice(0, 6);
}

/* ------------------------------------------------------------------ */
/* Reading progress                                                    */
/* ------------------------------------------------------------------ */

export interface Progress {
  lastUnitId: string | null;
  readUnitIds: string[];
  updatedAt: number;
}

const progressKey = (arxivId: string) => `${NS}:progress:${arxivId}`;

export function loadProgress(arxivId: string): Progress {
  if (!STORAGE_OK) return { lastUnitId: null, readUnitIds: [], updatedAt: 0 };
  return safeParse<Progress>(localStorage.getItem(progressKey(arxivId)), {
    lastUnitId: null,
    readUnitIds: [],
    updatedAt: 0,
  });
}

export function markUnitRead(arxivId: string, unitId: string): Progress {
  const current = loadProgress(arxivId);
  const readUnitIds = current.readUnitIds.includes(unitId)
    ? current.readUnitIds
    : [...current.readUnitIds, unitId];
  const next: Progress = { lastUnitId: unitId, readUnitIds, updatedAt: Date.now() };
  if (STORAGE_OK) {
    try {
      localStorage.setItem(progressKey(arxivId), JSON.stringify(next));
    } catch {
      /* non-fatal */
    }
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* On-demand translations                                              */
/* ------------------------------------------------------------------ */

/**
 * Chinese renderings the reader asked for, keyed by unit id.
 *
 * The curated demo paper ships with every paragraph already translated, because
 * a human read it and wrote them. An imported paper ships with none, because
 * nobody has.
 *
 * The alternative to on-demand would be translating all 60-odd paragraphs at
 * import time. That means 60 discarded upstream Sessions before the reader has
 * decided they want any of it, and docs/规划书 R12 is precisely the note about
 * why Session accumulation is not free. So: one paragraph, one request, one
 * Session, and the result kept here.
 *
 * Stored apart from the paper record so that re-importing a paper — which is
 * safe and cheap, since arXiv content at a version is immutable — does not throw
 * away translations the reader already waited for.
 */
export interface StoredTranslation {
  zh: string;
  /** Set when the server's output ceiling cut the reply. Surfaced, not hidden. */
  truncated?: boolean;
  at: number;
}

const translationsKey = (arxivId: string) => `${NS}:translations:${arxivId}`;

export function loadTranslations(arxivId: string): Record<string, StoredTranslation> {
  if (!STORAGE_OK) return {};
  const rows = safeParse<Record<string, StoredTranslation>>(
    localStorage.getItem(translationsKey(arxivId)),
    {},
  );
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) return {};

  // Drop anything not shaped like a translation. Storage can be hand-edited, and
  // a corrupt entry must not render into the reading column.
  const clean: Record<string, StoredTranslation> = {};
  for (const [unitId, row] of Object.entries(rows)) {
    if (row && typeof row === "object" && typeof row.zh === "string" && row.zh.trim()) {
      clean[unitId] = row;
    }
  }
  return clean;
}

function persistTranslations(arxivId: string, all: Record<string, StoredTranslation>): void {
  if (!STORAGE_OK) return;
  try {
    localStorage.setItem(translationsKey(arxivId), JSON.stringify(all));
  } catch {
    // Quota. The translation is still on screen for this session; it simply will
    // not survive a reload. Not worth failing the request over.
  }
}

export function saveTranslation(
  arxivId: string,
  unitId: string,
  zh: string,
  truncated = false,
): Record<string, StoredTranslation> {
  const all = loadTranslations(arxivId);
  all[unitId] = { zh: zh.trim(), ...(truncated ? { truncated: true } : {}), at: Date.now() };
  persistTranslations(arxivId, all);
  return all;
}

/** Lets a reader throw away a rendering they think is wrong and ask again. */
export function discardTranslation(
  arxivId: string,
  unitId: string,
): Record<string, StoredTranslation> {
  const all = loadTranslations(arxivId);
  delete all[unitId];
  persistTranslations(arxivId, all);
  return all;
}
