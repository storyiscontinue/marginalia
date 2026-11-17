import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_PAPER } from "@/data/demo-paper";
import { FormulaCard } from "@/components/FormulaCard";
import { PaperPicker } from "@/components/PaperPicker";
import { Passage, type SelectionRequest, type ZhSlot } from "@/components/Passage";
import { Spine } from "@/components/Spine";
import {
  deleteAnnotation,
  editUserNote,
  effectiveNote,
  findKnownTerms,
  loadAnnotations,
  loadProgress,
  loadTerms,
  loadTranslations,
  makeAnchor,
  markUnitRead,
  newId,
  rememberTerm,
  resolveAnchor,
  saveTranslation,
  storageAvailable,
  upsertAnnotation,
  type Annotation,
  type ExplainMode,
  type StoredTranslation,
} from "@/lib/annotations";
import {
  describeBackend,
  explainPassage,
  probeBackend,
  ServiceError,
  type BackendState,
} from "@/lib/api";
import {
  importArxivPaper,
  libraryAvailable,
  listLibrary,
  loadImportedPaper,
  loadLastChoice,
  PDF_DOC_ID,
  removeFromLibrary,
  saveLastChoice,
  type ImportFailure,
  type LastChoice,
  type LibraryEntry,
} from "@/lib/import";
import { importPdfFile, type PdfProgress } from "@/lib/pdf";
import {
  docLabel,
  isCurated,
  isFullyAnnotated,
  type ReaderFormula,
  type ReaderPaper,
  type ReaderUnit,
} from "@/lib/paper";

/**
 * Mirror of the Function's `MAX_TRANSLATE_CHARS`.
 *
 * Duplicated on purpose rather than imported: `functions/` is excluded from this
 * project's tsconfig and is never part of the browser bundle, so there is no
 * shared module to import it from. The copy exists so the UI can decline to
 * offer a translation the server would reject — an over-long paragraph gets an
 * explanation instead of a button that always fails. If the two ever disagree,
 * the server still wins; this is only the local hint.
 */
const TRANSLATE_MAX_CHARS = 2400;

/** Honest copy for a failed explanation. Never pretends a capability works. */
/**
 * Reader-facing copy for every code the Function can return.
 *
 * Grouped by what the reader can actually DO about it, because an honest error
 * that implies the wrong action is worse than a vague one:
 *   - retryable   -> say "再试一次"
 *   - config/owner-> say it is not something they caused, and that reading still works
 *   - not deployed-> say the endpoint is absent, so nobody waits on it
 * The upstream message is never echoed.
 */
function failureCopy(code: string): string {
  switch (code) {
    case "route_not_found":
    case "method_not_allowed":
    case "unsupported_media_type":
      return "AI 解释端点尚未部署到站点后端。当前可正常阅读、划词与手动批注。";

    case "service_not_configured":
    case "ai_not_configured":
      return "站点后端未开启或未同步，AI 解释不可用。可先手动写下自己的理解。";
    case "ai_configuration_invalid":
      return "AI 服务配置有误，需要站点维护者修正。阅读与手动批注不受影响。";
    case "ai_access_denied":
      return "服务端凭证被拒绝，AI 解释不可用。这不是你的操作问题。";
    case "ai_resource_not_found":
    case "ai_resource_repair_required":
    case "ai_initialization_rejected":
      return "AI 资源需要维护者重新开通。阅读与手动批注不受影响。";
    case "ai_initialization_conflict":
      return "AI 初始化存在冲突，需要维护者处理。为避免给错答案，这里不会自动挑一个。";

    case "ai_rate_limited":
      return "AI 服务暂时繁忙，稍等片刻再试一次。";
    case "ai_generation_timeout":
      return "AI 生成超时，没有拿到解释。批注已保留，可以重试或自己补写。";
    case "ai_generation_failed":
    case "empty_generation":
      return "AI 这次没有生成出内容。可以重试一次，或自己写下理解。";
    case "ai_service_unavailable":
    case "ai_request_unknown":
    case "ai_response_invalid":
    case "ai_request_rejected":
    case "ai_initialization_pending":
      return "AI 服务暂时不可用。批注已保留，稍后重试即可。";

    case "invalid_request":
    case "invalid_body":
    case "invalid_json":
    case "empty_body":
    case "body_too_large":
    case "invalid_mode":
    case "empty_selection":
    case "selection_too_long":
    case "selection_not_english":
    case "question_too_long":
    case "title_too_long":
    case "invalid_field_type":
      return "这段选区没能发出去：内容过长或不含英文。试试只选一句话。";

    case "client_closed":
      return "请求已中断。批注已保留，可以重新发起解释。";
    case "network_error":
      return "网络不可用，AI 解释未发出。批注已保存为待补充状态。";
    default:
      return "AI 解释失败。批注已保存，你可以自己补写理解。";
  }
}

/**
 * Translation failures get their own copy rather than reusing `failureCopy`.
 *
 * Most of `failureCopy` ends with "批注已保留", which would be nonsense here: a
 * translation is not an annotation, and nothing was kept. Same discipline
 * otherwise — the upstream message is never echoed, and every string says what
 * the reader can do next.
 */
function translationFailureCopy(code: string): string {
  switch (code) {
    case "route_not_found":
    case "method_not_allowed":
    case "unsupported_media_type":
      return "翻译端点尚未部署到站点后端。阅读与手动批注不受影响。";

    case "service_not_configured":
    case "ai_not_configured":
      return "站点后端未开启或未同步，翻译不可用。";
    case "ai_configuration_invalid":
    case "ai_access_denied":
    case "ai_resource_not_found":
    case "ai_resource_repair_required":
    case "ai_initialization_rejected":
    case "ai_initialization_conflict":
    case "ai_initialization_pending":
      return "翻译服务需要站点维护者处理，暂时不可用。";

    case "ai_rate_limited":
      return "翻译服务暂时繁忙，等一会儿再点「再试一次」。";
    case "ai_generation_timeout":
      return "翻译超时，没有拿到结果。这一段还没有被翻过。";
    case "ai_generation_failed":
    case "empty_generation":
      return "这一次没有生成出译文。可以再试一次。";

    case "selection_too_long":
      return "这一段超出了单次翻译的长度上限。可以划选其中一句用「解释这句」。";

    case "ai_service_unavailable":
    case "ai_request_unknown":
    case "ai_response_invalid":
    case "ai_request_rejected":
    case "invalid_explain_result":
      return "翻译服务暂时不可用。这一段还没有被翻过。";

    case "client_closed":
      return "翻译请求被中断了（通常是页面被切走）。可以再试一次。";
    case "network_error":
      return "网络不可用，翻译没有发出。";
    default:
      return "翻译失败。这一段还没有被翻过。";
  }
}

/* ------------------------------------------------------------------ */
/* Which paper opens on load                                            */
/* ------------------------------------------------------------------ */

/**
 * The one failure an arXiv paper cannot have: the shelf entry survived but its
 * body is gone, and there is no server that holds the original to get it back.
 *
 * Written once because two paths reach it — a `#d=` link opened after eviction,
 * and clicking a stale shelf row — and because the honest sentence has to
 * include the thing the reader can still do (drop the file again) rather than
 * just say "not found".
 */
const PDF_NOT_ON_SHELF: ImportFailure = {
  code: "pdf_not_on_shelf",
  message:
    "这份 PDF 的解析结果已经不在本机书架上了（可能被容量淘汰，或浏览器存储被清理）。论文文件还在你自己的电脑上——重新拖进来就好，批注一条都不会丢。",
  retryable: false,
};

const BARE_ID = /^([0-9]{4}\.[0-9]{4,5})(v[1-9][0-9]{0,2})?$/;

/** Only an arXiv id shape is ever accepted. Anything else is ignored, not fetched. */
function normalizeHashId(raw: string): { kind: "arxiv"; arxivId: string } | null {
  const cleaned = raw.trim().toLowerCase();
  return BARE_ID.test(cleaned) ? { kind: "arxiv", arxivId: cleaned } : null;
}

/**
 * Reads the paper choice out of the URL.
 *
 * Two shapes, because there are two ways to arrive with a paper in mind:
 * `#p=1706.03762v7` for an arXiv id, and `#d=pdf-3f9a1c…` for a document id.
 *
 * The PDF hash is a RESTORE hint, never a fetch instruction. An uploaded file
 * has no canonical location — it is on one person's disk — so the only thing a
 * document id can legitimately ask for is the parse already sitting on this
 * device's shelf. A `#d=` link sent to somebody else, or the same link after the
 * shelf was cleared, deliberately falls through to the demo with the picker
 * open: the alternative is a page that looks broken because it could not
 * download a file that was never online.
 *
 * Both are hints rather than instructions. An id that fails to import falls
 * through to the demo.
 */
function readHashChoice(): Exclude<LastChoice, { kind: "demo" }> | null {
  const hash = window.location.hash;

  const pdf = hash.match(/[#&]d=([^&#]+)/);
  if (pdf) {
    try {
      const raw = decodeURIComponent(pdf[1]).toLowerCase();
      return PDF_DOC_ID.test(raw) ? { kind: "pdf", docId: raw } : null;
    } catch {
      return null;
    }
  }

  const arxiv = hash.match(/[#&]p=([^&#]+)/);
  if (!arxiv) return null;
  try {
    const parsed = normalizeHashId(decodeURIComponent(arxiv[1]));
    return parsed;
  } catch {
    // A malformed percent-escape. Ignored, exactly like any other bad id.
    return null;
  }
}

/**
 * `replaceState`, not `assign`: switching papers should not leave a trail of
 * history entries that the back button then has to walk through one at a time.
 */
function writeHash(paper: ReaderPaper): void {
  const base = `${window.location.pathname}${window.location.search}`;

  if (isCurated(paper)) {
    // The hash has to be REMOVED, not merely left alone. Found by clicking
    // "回到预置示范论文" on the live site: the imported paper's id stayed in the
    // address bar, so copying the link or refreshing opened Mixtral while the
    // screen showed Attention. A URL that disagrees with what is on screen is
    // worse than no URL at all.
    if (!window.location.hash) return;
    window.history.replaceState(null, "", base);
    return;
  }

  const next =
    paper.origin === "pdf"
      ? `#d=${paper.arxivId}`
      : `#p=${paper.arxivId}${paper.version ?? ""}`;
  if (window.location.hash === next) return;
  window.history.replaceState(null, "", `${base}${next}`);
}

export default function App() {
  const [paper, setPaper] = useState<ReaderPaper>(DEMO_PAPER);
  const [backend, setBackend] = useState<BackendState>({ kind: "unknown" });
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [terms, setTerms] = useState(() => loadTerms());
  const [showZh, setShowZh] = useState(true);
  const [currentUnitId, setCurrentUnitId] = useState<string | null>(null);
  const [readUnitIds, setReadUnitIds] = useState<string[]>([]);
  const [selection, setSelection] = useState<SelectionRequest | null>(null);
  const [askDraft, setAskDraft] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [storageWarned, setStorageWarned] = useState(false);

  /* --- paper import ------------------------------------------------- */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [importBusy, setImportBusy] = useState(false);
  const [importFailure, setImportFailure] = useState<ImportFailure | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfProgress, setPdfProgress] = useState<PdfProgress | null>(null);

  /* --- translations, requested one paragraph at a time -------------- */
  const [translations, setTranslations] = useState<Record<string, StoredTranslation>>({});
  const [zhLoading, setZhLoading] = useState<Record<string, boolean>>({});
  const [zhFailed, setZhFailed] = useState<Record<string, string>>({});

  const unitRefs = useRef(new Map<string, HTMLElement>());
  // Assigned during render so it can never be a frame behind the paper on
  // screen; in-flight translations check against it before painting.
  const paperIdRef = useRef(paper.arxivId);
  paperIdRef.current = paper.arxivId;

  const aiReady = backend.kind === "ready";
  const isDemo = isCurated(paper);
  const isPdf = paper.origin === "pdf";
  const fullyAnnotated = isFullyAnnotated(paper);
  const translatedCount = useMemo(
    () => Object.values(translations).filter((entry) => entry.zh).length,
    [translations],
  );
  // Never prints `paper.arxivId` straight into a string: for an uploaded PDF that
  // field is a content id, and "arXiv:pdf-3f9a1c…" would be a small lie in the
  // middle of the page. `docLabel` is the one place that knows the difference.
  const subtitle = isDemo
    ? `arXiv:${paper.arxivId} · ${paper.venue ?? ""} · ${paper.primaryCategory}`
    : isPdf
      ? `${docLabel(paper)}${paper.pageCount ? ` · 共 ${paper.pageCount} 页` : ""} · 在你本机解析`
      : `${docLabel(paper)} · ${paper.dateText ?? ""} · ${paper.primaryCategory}`;

  /**
   * Swaps in a paper and every record keyed to it, in one batch.
   *
   * This is a function rather than an effect on `paper` because an effect runs
   * after the commit: the reader would get one painted frame of the new paper
   * wearing the old paper's annotations, all of them reported as "unable to
   * relocate". React batches these updates, so there is exactly one render.
   */
  const openPaper = useCallback((next: ReaderPaper) => {
    setPaper(next);
    setAnnotations(loadAnnotations(next.arxivId));
    setReadUnitIds(loadProgress(next.arxivId).readUnitIds);
    setTranslations(loadTranslations(next.arxivId));

    // Transient state belonging to the previous paper. A spinner for a unit id
    // that no longer exists is worse than no spinner at all.
    setZhLoading({});
    setZhFailed({});
    setCurrentUnitId(null);
    setActiveId(null);
    setSelection(null);
    setAskDraft(null);
    setEditingId(null);

    // Stale refs point at DOM nodes from the previous paper; `jumpTo` would
    // scroll to a detached element and silently do nothing.
    unitRefs.current.clear();

    writeHash(next);
    saveLastChoice(
      next.origin === "pdf"
        ? { kind: "pdf", docId: next.arxivId }
        : next.origin === "imported"
          ? { kind: "arxiv", arxivId: next.arxivId }
          : { kind: "demo" },
    );
    window.scrollTo({ top: 0 });
  }, []);

  /**
   * Imports a paper from raw reader input (bare id, `arXiv:` form, or a pasted
   * link — `lib/import.ts` accepts all three).
   *
   * Never throws. A failure becomes a message the picker can render, and whether
   * to offer a retry comes from the failure's own `retryable` flag rather than
   * being guessed here.
   */
  const runImport = useCallback(
    async (rawInput: string, force = false) => {
      setImportBusy(true);
      setImportFailure(null);
      const result = await importArxivPaper(rawInput, force);
      setImportBusy(false);

      if (!result.ok) {
        setImportFailure(result.failure);
        // Re-open on failure so the message is somewhere the reader can see it,
        // even when the failure arrived from a link or from the last-read choice.
        setPickerOpen(true);
        return;
      }

      openPaper(result.paper);
      setLibrary(listLibrary());
      setImportFailure(null);
      setPickerOpen(false);
    },
    [openPaper],
  );

  /**
   * Imports a PDF the reader dropped, parsed on their own machine.
   *
   * `runImport`'s counterpart rather than a branch inside it: the two share
   * nothing after "produce a paper" — one reads bytes off disk and needs a page
   * counter, the other makes a network request and needs a retry — and merging
   * them would put an `if (kind)` on every step.
   *
   * Never throws. `lib/pdf.ts` returns a coded, reader-worded failure for every
   * way a file can disappoint (not a PDF, too large, encrypted, scanned images
   * only), and those messages are written where the limits are known instead of
   * being guessed at this side of the boundary.
   */
  const runPdfImport = useCallback(
    async (file: File) => {
      setPdfBusy(true);
      setPdfProgress(null);
      setImportFailure(null);

      // Throttled on purpose. Every progress callback is a React state update,
      // and a 75-page paper would otherwise re-render the whole reader 75 times
      // in the middle of the one operation that cannot afford the time. A
      // quarter of the way is plenty of resolution for a progress line.
      const report = (progress: PdfProgress) => {
        const step = Math.max(1, Math.ceil(progress.total / 4));
        if (progress.page === 1 || progress.page % step === 0 || progress.page === progress.total) {
          setPdfProgress(progress);
        }
      };

      const result = await importPdfFile(file, report);
      setPdfBusy(false);
      setPdfProgress(null);

      if (!result.ok) {
        setImportFailure(result.failure);
        setPickerOpen(true);
        return;
      }

      openPaper(result.paper);
      setLibrary(listLibrary());
      setImportFailure(null);
      setPickerOpen(false);
    },
    [openPaper],
  );

  /* --- load device-local state once -------------------------------- */
  useEffect(() => {
    const storageOk = storageAvailable();
    if (!storageOk) setStorageWarned(true);
    setLibrary(listLibrary());

    setAnnotations(loadAnnotations(DEMO_PAPER.arxivId));
    setReadUnitIds(loadProgress(DEMO_PAPER.arxivId).readUnitIds);
    setTranslations(loadTranslations(DEMO_PAPER.arxivId));

    // A hash link outranks the last-read choice: the point of the hash is that
    // whoever sent the link decides what opens.
    const choice = readHashChoice() ?? loadLastChoice();
    if (choice.kind === "demo") return;

    const docId = choice.kind === "arxiv" ? choice.arxivId : choice.docId;
    const stored = storageOk ? loadImportedPaper(docId) : null;
    if (stored) {
      openPaper(stored);
      return;
    }

    // An arXiv id can be re-fetched; an uploaded PDF cannot, because its file
    // only exists on the disk it came from. So the two parts company here: the
    // hash is the reader's intent, and the only honest way to honour a lost PDF
    // is to say so and open the drop zone.
    if (choice.kind === "pdf") {
      setImportFailure(PDF_NOT_ON_SHELF);
      setPickerOpen(true);
      return;
    }
    void runImport(docId);
  }, [openPaper, runImport]);

  /* --- verify the backend rather than assume it ---------------------- */
  useEffect(() => {
    let cancelled = false;
    setBackend({ kind: "checking" });
    void probeBackend().then((state) => {
      if (!cancelled) setBackend(state);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* --- dismiss the floating toolbar on outside interaction ----------- */
  useEffect(() => {
    if (!selection) return;
    const clear = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-toolbar]")) return;
      setSelection(null);
      setAskDraft(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelection(null);
        setAskDraft(null);
      }
    };
    document.addEventListener("mousedown", clear);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", clear);
      document.removeEventListener("keydown", onKey);
    };
  }, [selection]);

  const annotationsByUnit = useMemo(() => {
    const map: Record<string, Annotation[]> = {};
    for (const annotation of annotations) {
      (map[annotation.unitId] ??= []).push(annotation);
    }
    return map;
  }, [annotations]);

  const countByUnit = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [unitId, rows] of Object.entries(annotationsByUnit)) counts[unitId] = rows.length;
    return counts;
  }, [annotationsByUnit]);

  const handleEnterView = useCallback(
    (unitId: string) => {
      setCurrentUnitId(unitId);
      setReadUnitIds((previous) => {
        if (previous.includes(unitId)) return previous;
        return markUnitRead(paper.arxivId, unitId).readUnitIds;
      });
    },
    [paper.arxivId],
  );

  const jumpTo = useCallback((unitId: string) => {
    unitRefs.current.get(unitId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(null);
  }, []);

  /** Create a note, ask the model, then write BOTH back into the margin. */
  const runExplain = useCallback(
    async (request: SelectionRequest, mode: ExplainMode, question: string) => {
      const unit = paper.units.find((candidate) => candidate.id === request.unitId);
      if (!unit) return;

      const id = newId();
      const anchor = makeAnchor(unit.original, request.start, request.end);
      const now = Date.now();

      const draft: Annotation = {
        id,
        unitId: unit.id,
        anchor,
        mode,
        question: question.trim() || (mode === "term" ? `「${anchor.text}」是什么意思？` : "解释这句"),
        answer: "",
        userNote: "",
        editedByUser: false,
        pending: true,
        createdAt: now,
        updatedAt: now,
      };

      setAnnotations(upsertAnnotation(paper.arxivId, draft));
      setActiveId(id);
      setSelection(null);
      setAskDraft(null);
      window.getSelection()?.removeAllRanges();

      // A note-only entry never calls the model. That keeps the reader's own
      // understanding writable even with no backend at all.
      if (mode === "note") {
        setAnnotations(upsertAnnotation(paper.arxivId, { ...draft, pending: false }));
        setEditingId(id);
        setEditText("");
        return;
      }

      try {
        const result = await explainPassage({
          arxivId: paper.arxivId,
          unitId: unit.id,
          selectedText: anchor.text,
          // `mode` is already narrowed to the four model-backed modes by the
          // early return above; "note" never reaches this call.
          mode,
          paperTitle: paper.title,
          ...(question.trim() ? { question: question.trim() } : {}),
        });
        const done: Annotation = {
          ...draft,
          answer: result.answer,
          pending: false,
          ...(result.term ? { term: result.term } : {}),
        };
        setAnnotations(upsertAnnotation(paper.arxivId, done));
        if (result.term) setTerms(rememberTerm(paper, result.term, result.answer));
      } catch (error) {
        const code = error instanceof ServiceError ? error.code : "unknown";
        setAnnotations(
          upsertAnnotation(paper.arxivId, {
            ...draft,
            pending: false,
            failed: true,
            answer: failureCopy(code),
          }),
        );
      }
    },
    [paper],
  );

  /**
   * Translates one paragraph on demand, then stores the result on device.
   *
   * Deliberately not eager. Translating a whole imported paper up front would
   * open sixty-odd discarded upstream sessions before the reader had decided
   * they wanted any of it. One paragraph = one request = one stored rendering,
   * kept under the paper's own key so re-importing never throws it away.
   */
  const requestTranslation = useCallback(
    async (unitId: string) => {
      const unit = paper.units.find((candidate) => candidate.id === unitId);
      if (!unit) return;

      const paperId = paper.arxivId;
      setZhLoading((previous) => ({ ...previous, [unitId]: true }));
      setZhFailed((previous) => {
        if (!(unitId in previous)) return previous;
        const next = { ...previous };
        delete next[unitId];
        return next;
      });

      try {
        const result = await explainPassage({
          arxivId: paperId,
          unitId,
          selectedText: unit.original,
          mode: "translate",
          paperTitle: paper.title,
        });
        // Stored under the paper it was requested for even if the reader has
        // since navigated away — the work is not wasted, it just does not get
        // painted onto a different paper's paragraphs.
        const stored = saveTranslation(paperId, unitId, result.answer, result.truncated);
        if (paperIdRef.current === paperId) setTranslations(stored);
      } catch (error) {
        if (paperIdRef.current !== paperId) return;
        const code = error instanceof ServiceError ? error.code : "unknown";
        setZhFailed((previous) => ({ ...previous, [unitId]: translationFailureCopy(code) }));
      } finally {
        if (paperIdRef.current === paperId) {
          setZhLoading((previous) => {
            if (!(unitId in previous)) return previous;
            const next = { ...previous };
            delete next[unitId];
            return next;
          });
        }
      }
    },
    [paper],
  );

  /**
   * Decides what the Chinese line under a paragraph shows.
   *
   * The order is the priority: a curated translation beats a stored one, which
   * beats an in-flight request, which beats a failure, which beats an offer. The
   * `blocked` variants exist so a paragraph the server would refuse never
   * presents a button that always fails — the reason is stated instead.
   */
  const zhSlotFor = useCallback(
    (unit: ReaderUnit): ZhSlot | undefined => {
      if (unit.zh) return { kind: "text", text: unit.zh };

      const stored = translations[unit.id];
      if (stored?.zh) {
        return { kind: "text", text: stored.zh, ...(stored.truncated ? { truncated: true } : {}) };
      }

      if (zhLoading[unit.id]) return { kind: "loading" };

      const failed = zhFailed[unit.id];
      if (failed) return { kind: "failed", message: failed };

      if (!aiReady) {
        return { kind: "offer", blocked: "AI 服务未接通，暂时不能翻译这一段。" };
      }
      if (unit.original.length > TRANSLATE_MAX_CHARS) {
        return {
          kind: "offer",
          blocked: `这一段有 ${unit.original.length} 个字符，超过单次翻译的上限（${TRANSLATE_MAX_CHARS}）。可以划选其中一句用「解释这句」。`,
        };
      }
      return { kind: "offer" };
    },
    [translations, zhLoading, zhFailed, aiReady],
  );

  const askAboutFormula = useCallback(
    (formula: ReaderFormula) => {
      const unit = paper.units.find((candidate) => candidate.id === formula.unitId);
      if (!unit) return;

      // Anchor on the equation's own number when the paragraph contains it. The
      // previous version searched for the literal string "scaled dot-product
      // attention", which only ever matched one paper and silently anchored at
      // offset 0 on every other.
      const needle = formula.label.replace(/[()]/g, "").trim();
      const found = needle ? unit.original.indexOf(needle) : -1;
      const at = found >= 0 ? found : 0;
      const end = Math.min(at + 60, unit.original.length);

      const firstSymbol = formula.symbols[0]?.sym;
      // The question field has a 400-character budget server-side, so the
      // fallback wording carries the formula's readable form rather than LaTeX.
      const readable = formula.unicode.slice(0, 320);

      void runExplain(
        {
          unitId: unit.id,
          start: at,
          end,
          text: unit.original.slice(at, end),
          x: window.innerWidth / 2,
          y: 200,
        },
        "formula",
        firstSymbol
          ? `公式 ${formula.label} 里的 ${firstSymbol} 到底在做什么？`
          : `把这个公式逐个符号讲清楚，并说明它在这段里起什么作用：${readable}`,
      );
    },
    [paper, runExplain],
  );

  /* --- the device shelf -------------------------------------------- */

  const openStoredPaper = useCallback(
    (docId: string) => {
      const stored = loadImportedPaper(docId);
      if (stored) {
        openPaper(stored);
        setPickerOpen(false);
        return;
      }
      // Listed on the shelf but the body is gone — evicted for quota, or storage
      // was cleared while a stale index survived.
      const entry = library.find((row) => row.arxivId === docId);
      if (entry?.kind === "pdf" || PDF_DOC_ID.test(docId)) {
        // Re-fetching is not an option: the bytes are on the reader's disk and
        // nowhere else. Report it and leave the drop zone open.
        setImportFailure(PDF_NOT_ON_SHELF);
        setPickerOpen(true);
        return;
      }
      // An arXiv id can simply be fetched again, which beats reporting a mystery
      // failure the reader cannot act on.
      void runImport(docId, true);
    },
    [library, openPaper, runImport],
  );

  const openDemoPaper = useCallback(() => {
    openPaper(DEMO_PAPER);
    setPickerOpen(false);
  }, [openPaper]);

  const dropFromShelf = useCallback((arxivId: string) => {
    setLibrary(removeFromLibrary(arxivId));
    // Deliberately does NOT navigate away when the removed paper is the one on
    // screen. It is still fully readable and its annotations live under their
    // own key; yanking the reader off a page because they tidied the shelf would
    // be a surprise, not a feature.
  }, []);

  const commitEdit = useCallback(
    (id: string) => {
      setAnnotations(editUserNote(paper.arxivId, id, editText));
      setEditingId(null);
    },
    [editText, paper.arxivId],
  );

  const knownTermsFor = useCallback(
    (text: string) => findKnownTerms(text).map((hit) => hit.term),
    [terms],
  );

  const orphaned = useMemo(
    () =>
      annotations.filter((annotation) => {
        const unit = paper.units.find((candidate) => candidate.id === annotation.unitId);
        return !unit || !resolveAnchor(annotation.anchor, unit.original);
      }),
    [annotations, paper.units],
  );

  const totalNotes = annotations.length;

  return (
    <div className="min-h-dvh" style={{ background: "var(--background)" }}>
      {/* --- Masthead ------------------------------------------------ */}
      <header
        className="sticky top-0 z-30 border-b backdrop-blur"
        style={{ borderColor: "var(--paper-rule)", background: "color-mix(in srgb, var(--background) 88%, transparent)" }}
      >
        <div className="mx-auto flex max-w-[104rem] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
          <div className="flex items-baseline gap-2">
            <span className="font-serif text-lg font-semibold tracking-tight text-ink">
              Marginalia
            </span>
            <span className="text-[0.6875rem] text-muted-foreground">眉批 · 英文文献陪读</span>
          </div>

          <span
            className="hidden h-4 w-px sm:block"
            style={{ background: "var(--paper-rule)" }}
            aria-hidden
          />

          <div className="min-w-0 flex-1">
            <p className="truncate font-serif text-sm text-ink">{paper.title}</p>
            <p className="truncate text-[0.6875rem] text-muted-foreground">{subtitle}</p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPickerOpen((value) => !value)}
              aria-expanded={pickerOpen}
              className="cursor-pointer rounded-full px-3 py-1 text-[0.75rem] font-medium transition-opacity hover:opacity-80"
              style={{ background: "var(--cinnabar)", color: "var(--primary-foreground)" }}
              title="拖入你自己的 PDF，或填一个 arXiv 编号，换一篇读"
            >
              换一篇
            </button>

            <button
              type="button"
              onClick={() => setShowZh((value) => !value)}
              aria-pressed={showZh}
              className="cursor-pointer rounded-full border px-3 py-1 text-[0.75rem] font-medium transition-opacity hover:opacity-70"
              style={{ borderColor: "var(--border)", color: "var(--ink-soft)" }}
            >
              中文对照 {showZh ? "开" : "关"}
            </button>

            <span
              role="status"
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium"
              style={{
                background: aiReady ? "color-mix(in srgb, #2f6f4f 12%, transparent)" : "var(--muted)",
                color: aiReady ? "#2f6f4f" : "var(--ink-soft)",
              }}
              title={describeBackend(backend)}
            >
              <span
                aria-hidden
                className="block h-1.5 w-1.5 rounded-full"
                style={{ background: "currentColor" }}
              />
              {backend.kind === "checking"
                ? "检查中…"
                : aiReady
                  ? "AI 已接通"
                  : backend.kind === "unknown"
                    ? "未检测"
                    : "AI 未接通"}
            </span>

            {!aiReady && backend.kind !== "checking" && (
              <button
                type="button"
                onClick={() => {
                  setBackend({ kind: "checking" });
                  void probeBackend().then(setBackend);
                }}
                className="cursor-pointer rounded-full px-2.5 py-1 text-[0.6875rem] font-medium underline decoration-dotted underline-offset-2"
                style={{ color: "var(--cinnabar)" }}
              >
                重试
              </button>
            )}
          </div>
        </div>

        {!aiReady && backend.kind !== "checking" && backend.kind !== "unknown" && (
          <p
            className="border-t px-4 py-1.5 text-[0.75rem] sm:px-6"
            style={{ borderColor: "var(--paper-rule)", color: "var(--ink-soft)", background: "var(--indigo-wash)" }}
          >
            {describeBackend(backend)}。阅读、划词与手动批注不受影响——批注保存在你本机。
          </p>
        )}
        {storageWarned && (
          <p
            className="border-t px-4 py-1.5 text-[0.75rem] sm:px-6"
            style={{ borderColor: "var(--paper-rule)", color: "var(--destructive)" }}
          >
            浏览器存储不可用（可能是无痕模式）。批注不会在刷新后保留，导入的论文也存不进本机书架。
          </p>
        )}
      </header>

      {/* --- Paper picker --------------------------------------------- */}
      {/*
        Kept out of the sticky header on purpose: with a full ten-paper shelf the
        panel is taller than a laptop viewport, and a sticky panel that tall would
        cover the very paper the reader is trying to reach.

        The wrapper carries only the bottom rule and the background. PaperPicker
        brings its own `border-t`, horizontal padding and max-width container, so
        adding them here too would double every one of them.
      */}
      {pickerOpen && (
        <div
          className="border-b"
          style={{ borderColor: "var(--paper-rule)", background: "var(--paper)" }}
        >
          <PaperPicker
            library={library}
            busy={importBusy}
            pdfBusy={pdfBusy}
            pdfProgress={pdfProgress}
            failure={importFailure}
            currentDocId={paper.arxivId}
            isDemo={isDemo}
            storageOk={libraryAvailable()}
            onFile={(file) => void runPdfImport(file)}
            onSubmit={(raw) => void runImport(raw)}
            onPickDemo={openDemoPaper}
            onPickStored={openStoredPaper}
            onRemove={dropFromShelf}
            onClose={() => setPickerOpen(false)}
          />
        </div>
      )}

      {/* Shown only when the picker is closed: an import can also start from a
          link or from the last-read choice, and then there is no panel to
          report progress inside. */}
      {(importBusy || pdfBusy) && !pickerOpen && (
        <p
          role="status"
          className="border-b px-4 py-2 text-[0.8125rem] sm:px-6"
          style={{
            borderColor: "var(--paper-rule)",
            color: "var(--ink-soft)",
            background: "var(--indigo-wash)",
          }}
        >
          {pdfBusy
            ? pdfProgress
              ? `正在你本机解析 PDF：第 ${pdfProgress.page} / ${pdfProgress.total} 页`
              : "正在读取 PDF…"
            : "正在从 arXiv 导入论文…"}
        </p>
      )}

      {/* --- Body ---------------------------------------------------- */}
      <div className="mx-auto flex max-w-[104rem] gap-6 px-4 py-6 sm:px-6">
        <Spine
          paper={paper}
          currentUnitId={currentUnitId}
          readUnitIds={readUnitIds}
          annotationCountByUnit={countByUnit}
          onJump={jumpTo}
        />

        {/* Paper column */}
        <main className="min-w-0 flex-1">
          <div className="paper-surface rounded-lg">
            {/* Title block */}
            <div
              className="border-b px-5 py-6 sm:px-8"
              style={{ borderColor: "var(--paper-rule)" }}
            >
              <h1 className="font-serif text-2xl leading-tight font-semibold text-ink sm:text-3xl">
                {paper.title}
              </h1>
              <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-soft">{paper.authors}</p>
              <p className="mt-3 text-[0.8125rem] text-muted-foreground">
                {isDemo
                  ? "这是一篇预置的示范论文，已离线解析完成，打开即可读，无需登录、无需上传、无需等待。"
                  : isPdf
                    ? `这份 PDF 在你自己的浏览器里解析 · ${paper.units.length} 段 · ${paper.pageCount ? `共 ${paper.pageCount} 页` : "页数未知"} · 已译 ${translatedCount} 段`
                    : `从 arXiv 现场导入 · ${paper.units.length} 段 · ${paper.formulas.length} 个公式 · 已译 ${translatedCount} 段`}
              </p>
              {/* Gated on the link existing, not on the origin: an uploaded PDF
                  has no URL to offer, and inventing one would send the reader to
                  a search page for a file they are already holding. */}
              {paper.url && (
                <a
                  href={paper.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1.5 inline-block text-[0.8125rem] font-medium underline decoration-dotted underline-offset-2"
                  style={{ color: "var(--indigo)" }}
                >
                  在 arXiv 上看原文 ↗
                </a>
              )}
            </div>

            {/*
              Prerequisites exist only on the curated paper: a human wrote them
              after reading it. An import has none, and inventing five concepts
              for a paper nobody has read would be exactly the kind of confident
              guess this product must not make.
            */}
            {paper.prerequisites.length > 0 && (
              <section
                className="system-note mx-5 my-5 rounded-r-md px-4 py-3.5 sm:mx-8 sm:px-5"
                aria-labelledby="prereq-heading"
              >
                <h2
                  id="prereq-heading"
                  className="text-[0.6875rem] font-semibold tracking-wide text-indigo uppercase"
                >
                  读这篇之前，你需要知道的 5 个概念
                </h2>
                <dl className="mt-2.5 grid gap-x-6 gap-y-2.5 lg:grid-cols-2">
                  {paper.prerequisites.map((item) => (
                    <div key={item.term}>
                      <dt className="font-serif text-[0.9375rem] font-semibold text-ink">
                        {item.term}
                      </dt>
                      <dd className="mt-0.5 text-[0.8125rem] leading-relaxed text-ink-soft">
                        {item.explanation}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {/*
              The provenance notice is an extracted paper's counterpart to the
              prerequisites block: instead of analysis nobody has done, it says
              plainly what WAS extracted verbatim, what is absent, and why. The
              two sources differ enough to deserve separate sentences — a PDF has
              no formula LaTeX and no canonical link, and claiming otherwise to a
              reader who is holding the file would be a straightforward lie.
            */}
            {!fullyAnnotated && (
              <section
                className="system-note mx-5 my-5 rounded-r-md px-4 py-3.5 sm:mx-8 sm:px-5"
                aria-labelledby="provenance-heading"
              >
                <h2
                  id="provenance-heading"
                  className="text-[0.6875rem] font-semibold tracking-wide text-indigo uppercase"
                >
                  这篇是{isPdf ? "从你的 PDF 解析的" : "导入的"}：哪些是原样提取，哪些还没有
                </h2>
                <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-soft">
                  {isPdf ? (
                    <>
                      每一段正文都来自你这份文件自己的文字层，一字未改；章节标题按字号和位置认出，页码是原文页码。
                      下面这些<strong className="font-semibold text-ink">没有</strong>，因为 PDF 的文字层里本来就没有它们：
                      公式（PDF 里只剩下打乱顺序的字母，宁可空着也不给你一条拼错公式的卡片）、
                      段落中文对照（在每段下方点「译这段」逐段生成）、
                      段落在论证中的作用标签、难度评级、前置概念清单。
                      划词解释和手动批注不受影响。
                    </>
                  ) : (
                    <>
                      正文段落、章节标题和公式的 LaTeX 都取自 arXiv 官方网页版，一字未改。
                      下面这些<strong className="font-semibold text-ink">没有</strong>，因为还没有人读过这篇论文，机器猜不出来：
                      段落中文对照（在每段下方点「译这段」逐段生成）、
                      段落在论证中的作用标签、难度评级、前置概念清单，以及公式的逐符号拆解。
                      公式卡片会把原始 LaTeX 照录出来，你可以直接就它提问。
                    </>
                  )}
                </p>
                {/*
                  What the parser itself noticed, in the sentences it wrote at the
                  moment it noticed. Rendered rather than recomposed here, so a
                  caveat can never go missing because a component forgot to
                  reconstruct it from flags.
                */}
                {(paper.parseNotes?.length ?? 0) > 0 && (
                  <ul className="mt-2.5 flex flex-col gap-1.5 border-t pt-2.5 text-[0.8125rem] leading-relaxed" style={{ borderColor: "var(--paper-rule)" }}>
                    {paper.parseNotes?.map((note) => (
                      <li key={note} className="flex gap-2">
                        <span aria-hidden className="mt-2 block h-1 w-1 shrink-0 rounded-full" style={{ background: "var(--indigo)" }} />
                        <span className="text-ink-soft">{note}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {paper.truncated && !isPdf && (
                  <p
                    className="mt-2 text-[0.8125rem] leading-relaxed"
                    style={{ color: "var(--destructive)" }}
                  >
                    这篇论文超出了单次导入的容量上限，末尾若干段落没有被取回。上面显示的就是已取回的全部。
                  </p>
                )}
              </section>
            )}

            {/* Units, with formulas interleaved after their owning unit */}
            {paper.units.map((unit) => (
              <div
                key={unit.id}
                data-unit-root
                ref={(node) => {
                  if (node) unitRefs.current.set(unit.id, node);
                  else unitRefs.current.delete(unit.id);
                }}
              >
                <Passage
                  unit={unit}
                  annotations={annotationsByUnit[unit.id] ?? []}
                  activeAnnotationId={activeId}
                  showZh={showZh}
                  // Always supplied. Passage gates the line on `showZh && zh`, so
                  // the toggle stays the single control for whether Chinese
                  // appears — `zh` only decides what appears when it does.
                  zh={zhSlotFor(unit)}
                  onRequestZh={requestTranslation}
                  isCurrent={currentUnitId === unit.id}
                  knownTerms={knownTermsFor(unit.original)}
                  onSelectAnnotation={setActiveId}
                  onRequestExplain={setSelection}
                  onEnterView={handleEnterView}
                />
                {paper.formulas
                  .filter((formula) => formula.unitId === unit.id)
                  .map((formula) => (
                    <div key={formula.id} className="px-5 pb-2 sm:px-8">
                      <FormulaCard
                        formula={formula}
                        aiReady={aiReady}
                        onAskAboutFormula={askAboutFormula}
                      />
                    </div>
                  ))}
              </div>
            ))}

            <footer
              className="border-t px-5 py-4 text-[0.75rem] text-muted-foreground sm:px-8"
              style={{ borderColor: "var(--paper-rule)" }}
            >
              {/* Provenance, stated three ways because the three origins really
                  are different facts. The PDF branch must not mention arXiv: the
                  reader's file has nothing to do with arXiv, and a footer that
                  says otherwise would attribute the text to a site they never
                  visited — and hide the thing they should know, that the file
                  never left their machine. */}
              {isPdf ? (
                <span>
                  正文提取自你本机的这份 PDF{paper.sourceFileName ? `（${paper.sourceFileName}）` : ""}——解析在你的浏览器里完成，文件本身没有上传到任何服务器。{paper.pageCount ? `共 ${paper.pageCount} 页，读出 ${paper.units.length} 段。` : ""}版权属于原作者；这里只做阅读辅助，不做再发布。
                </span>
              ) : isDemo ? (
                `节选自 ${paper.title}（arXiv:${paper.arxivId}），用于阅读教学演示。`
              ) : (
                `正文提取自 arXiv:${paper.arxivId}${paper.version ?? ""}（${paper.primaryCategory}）。版权属于原作者与 arXiv；这里只做阅读辅助，不做再发布。`
              )}
            </footer>
          </div>
        </main>

        {/* Margin column — the reader's own notes */}
        <aside className="hidden w-[21rem] shrink-0 xl:block" aria-label="页边批注">
          <div className="sticky top-20">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="text-[0.6875rem] font-semibold tracking-wide text-cinnabar uppercase">
                我的页边批注
              </h2>
              <span className="text-[0.6875rem] text-muted-foreground tabular-nums">
                {totalNotes} 条
              </span>
            </div>

            <p className="mb-3 rounded border border-dashed px-3 py-2 text-[0.75rem] leading-relaxed text-muted-foreground"
              style={{ borderColor: "var(--border)" }}
            >
              在左侧原文上划选任意一句，就会浮出工具条。你的<strong className="font-semibold text-ink-soft">问题</strong>和
              <strong className="font-semibold text-ink-soft">解释</strong>会一起写进这里，之后可以自己改写——最终的理解归你，不归模型。
            </p>

            <div className="flex max-h-[calc(100dvh-14rem)] flex-col gap-2.5 overflow-y-auto pr-1 scrollbar-thin">
              {totalNotes === 0 && (
                <p className="rounded px-3 py-6 text-center text-[0.8125rem] text-muted-foreground"
                  style={{ background: "var(--muted)" }}
                >
                  还没有批注。
                  <br />
                  划一句话试试。
                </p>
              )}

              {annotations.map((annotation) => {
                const note = effectiveNote(annotation);
                const isEditing = editingId === annotation.id;
                return (
                  <div
                    key={annotation.id}
                    className="annotation-card rounded px-3 py-2.5"
                    data-active={annotation.id === activeId}
                    style={annotation.id === activeId ? { boxShadow: "0 0 0 2px var(--cinnabar-wash), 0 6px 20px -10px rgb(28 25 23 / 0.3)" } : undefined}
                  >
                    <p
                      className="border-l-2 pl-2 font-serif text-[0.8125rem] leading-snug text-ink-soft italic"
                      style={{ borderColor: "var(--paper-rule)" }}
                    >
                      “{annotation.anchor.text.length > 90
                        ? `${annotation.anchor.text.slice(0, 90)}…`
                        : annotation.anchor.text}”
                    </p>

                    <p className="mt-2 text-[0.75rem] font-medium text-cinnabar">
                      问：{annotation.question}
                    </p>

                    {isEditing ? (
                      <div className="mt-1.5">
                        <textarea
                          autoFocus
                          value={editText}
                          onChange={(event) => setEditText(event.target.value)}
                          rows={4}
                          placeholder="写下你自己的理解…"
                          className="w-full resize-y rounded border px-2 py-1.5 text-[0.8125rem] leading-relaxed text-ink"
                          style={{ borderColor: "var(--input)", background: "var(--paper)" }}
                        />
                        <div className="mt-1.5 flex gap-2">
                          <button
                            type="button"
                            onClick={() => commitEdit(annotation.id)}
                            className="cursor-pointer rounded px-2.5 py-1 text-[0.75rem] font-medium"
                            style={{ background: "var(--cinnabar)", color: "var(--primary-foreground)" }}
                          >
                            保存我的理解
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="cursor-pointer rounded px-2 py-1 text-[0.75rem] text-muted-foreground hover:text-ink"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="mt-1 text-[0.8125rem] leading-relaxed text-ink">
                          {annotation.pending ? (
                            <span className="text-muted-foreground">正在请求解释…</span>
                          ) : annotation.failed ? (
                            <span style={{ color: "var(--destructive)" }}>{note || "请求失败"}</span>
                          ) : (
                            note
                          )}
                        </p>

                        {annotation.editedByUser && (
                          <p className="mt-1 text-[0.6875rem] font-medium text-cinnabar">
                            ✎ 已按你的改写保存
                          </p>
                        )}

                        <div className="mt-2 flex gap-2.5 border-t pt-1.5"
                          style={{ borderColor: "var(--paper-rule)" }}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(annotation.id);
                              setEditText(annotation.userNote || annotation.answer);
                            }}
                            className="cursor-pointer text-[0.6875rem] font-medium text-ink-soft underline decoration-dotted underline-offset-2 hover:text-cinnabar"
                          >
                            改写
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setAnnotations(deleteAnnotation(paper.arxivId, annotation.id));
                              if (activeId === annotation.id) setActiveId(null);
                            }}
                            className="cursor-pointer text-[0.6875rem] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-destructive"
                          >
                            删除
                          </button>
                          <button
                            type="button"
                            onClick={() => jumpTo(annotation.unitId)}
                            className="ml-auto cursor-pointer text-[0.6875rem] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-ink"
                          >
                            回到原文
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}

              {orphaned.length > 0 && (
                <p className="rounded px-3 py-2 text-[0.6875rem]"
                  style={{ background: "var(--muted)", color: "var(--ink-soft)" }}
                >
                  有 {orphaned.length} 条批注无法在原文中重新定位，已保留但不再高亮。
                </p>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* --- Floating selection toolbar ------------------------------ */}
      {selection && (
        <div
          data-toolbar
          className="select-toolbar fixed z-50 -translate-x-1/2 -translate-y-full"
          style={{ left: selection.x, top: Math.max(selection.y - 8, 8) }}
          role="toolbar"
          aria-label="对选中内容操作"
        >
          <div
            className="flex items-center gap-1 rounded-lg border p-1 shadow-lg"
            style={{ borderColor: "var(--border)", background: "var(--paper)" }}
          >
            {(
              [
                ["sentence", "解释这句"],
                ["term", "这是术语"],
                ["custom", "提问…"],
                ["note", "只写批注"],
              ] as Array<[ExplainMode, string]>
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                disabled={mode !== "note" && mode !== "custom" && !aiReady}
                title={
                  mode !== "note" && !aiReady ? "AI 服务未接通，可先手动批注" : undefined
                }
                onClick={() => {
                  if (mode === "custom") {
                    setAskDraft((value) => (value === null ? "" : null));
                    return;
                  }
                  void runExplain(selection, mode, "");
                }}
                className="cursor-pointer rounded px-2.5 py-1 text-[0.75rem] font-medium whitespace-nowrap transition-colors hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-40"
                style={
                  mode === "note"
                    ? { color: "var(--cinnabar)" }
                    : { color: "var(--ink)" }
                }
              >
                {label}
              </button>
            ))}
          </div>

          {askDraft !== null && (
            <div
              className="mt-1 w-72 rounded-lg border p-2 shadow-lg"
              style={{ borderColor: "var(--border)", background: "var(--paper)" }}
            >
              <label className="block text-[0.6875rem] font-medium text-muted-foreground" htmlFor="ask-input">
                就这段问点什么
              </label>
              <textarea
                id="ask-input"
                autoFocus
                rows={2}
                value={askDraft}
                onChange={(event) => setAskDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && askDraft.trim()) {
                    void runExplain(selection, "custom", askDraft);
                  }
                }}
                placeholder="例如：这里的 scaling 为什么是根号？"
                className="mt-1 w-full resize-none rounded border px-2 py-1.5 text-[0.8125rem] text-ink"
                style={{ borderColor: "var(--input)", background: "var(--background)" }}
              />
              <button
                type="button"
                disabled={!askDraft.trim()}
                onClick={() => void runExplain(selection, "custom", askDraft)}
                className="mt-1.5 w-full cursor-pointer rounded px-2.5 py-1.5 text-[0.75rem] font-medium disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--cinnabar)", color: "var(--primary-foreground)" }}
              >
                问并写入批注（⌘/Ctrl + Enter）
              </button>
            </div>
          )}
        </div>
      )}

      {/* Mobile: notes below the paper */}
      <div className="px-4 pb-10 xl:hidden">
        <h2 className="mb-2 text-[0.6875rem] font-semibold tracking-wide text-cinnabar uppercase">
          我的页边批注（{totalNotes}）
        </h2>
        {totalNotes === 0 ? (
          <p className="rounded px-3 py-5 text-center text-[0.8125rem] text-muted-foreground"
            style={{ background: "var(--muted)" }}
          >
            还没有批注。在原文上划一句话试试。
          </p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {annotations.map((annotation) => (
              <div key={annotation.id} className="annotation-card rounded px-3 py-2.5">
                <p className="font-serif text-[0.8125rem] text-ink-soft italic">
                  “{annotation.anchor.text}”
                </p>
                <p className="mt-1.5 text-[0.75rem] font-medium text-cinnabar">
                  问：{annotation.question}
                </p>
                <p className="mt-1 text-[0.8125rem] text-ink">
                  {annotation.pending ? "正在请求解释…" : effectiveNote(annotation)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
