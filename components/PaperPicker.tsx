import { useEffect, useRef, useState } from "react";
import type { ImportFailure, LibraryEntry } from "@/lib/import";

interface PaperPickerProps {
  library: LibraryEntry[];
  /** An arXiv import is in flight. */
  busy: boolean;
  /** A PDF is being read or parsed on this machine. */
  pdfBusy: boolean;
  /** Which page the parser is on, once pdf.js has opened the file. */
  pdfProgress: { page: number; total: number } | null;
  failure: ImportFailure | null;
  /** The paper currently on screen, so the shelf can mark it. */
  currentDocId: string;
  isDemo: boolean;
  storageOk: boolean;
  onFile: (file: File) => void;
  onSubmit: (raw: string) => void;
  onPickDemo: () => void;
  onPickStored: (docId: string) => void;
  onRemove: (docId: string) => void;
  onClose: () => void;
}

function whenText(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The "read something else" panel.
 *
 * Rendered inline under the masthead rather than as a modal overlay: it is a
 * short-lived control, and an overlay would cover the paper the reader is
 * deciding whether to leave. It also keeps the stacking-context and focus-trap
 * work that a dialog would require out of a component whose whole job is one
 * drop zone, one input and a list.
 *
 * The PDF drop zone comes first because that is how this product is meant to be
 * used: a reader has a paper on their own machine, and making them find an arXiv
 * id before they can read it would be doing the work the tool exists to save.
 * The arXiv row stays underneath as the secondary path — deliberately not
 * deleted, because an arXiv import keeps the section hierarchy and the original
 * LaTeX of every display equation, neither of which survives in a PDF's text
 * layer. It is no longer the entry point, and that is the whole difference.
 *
 * Deliberately not a search box. Searching arXiv means a second upstream
 * endpoint and a results list the reader has to judge; picking a file or typing
 * an id is one step and cannot return the wrong paper.
 */
export function PaperPicker({
  library,
  busy,
  pdfBusy,
  pdfProgress,
  failure,
  currentDocId,
  isDemo,
  storageOk,
  onFile,
  onSubmit,
  onPickDemo,
  onPickStored,
  onRemove,
  onClose,
}: PaperPickerProps) {
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // The arXiv row, never the drop zone: focusing a file input opens the
  // operating system's picker unasked, which is a rude thing to do to a panel
  // the reader only just opened.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    if (busy || !draft.trim()) return;
    onSubmit(draft);
  };

  const pick = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // `files[0]` and nothing else. Importing a batch would need a queue, a
    // result per file and a way to show ten failures; a reader who selects ten
    // gets the first one and can drop the rest afterwards.
    onFile(files[0]);
  };

  const anyBusy = busy || pdfBusy;

  return (
    <section
      className="border-t px-4 py-3.5 sm:px-6"
      style={{ borderColor: "var(--paper-rule)", background: "var(--paper)" }}
      aria-label="换一篇论文"
    >
      <div className="mx-auto flex max-w-[104rem] flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[0.6875rem] font-semibold tracking-wide text-indigo uppercase">
            读你自己的论文
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer text-[0.6875rem] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-ink"
          >
            收起
          </button>
        </div>

        {/* --- the PDF drop zone -------------------------------------- */}
        <div
          onDragOver={(event) => {
            if (anyBusy) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (anyBusy) return;
            pick(event.dataTransfer.files);
          }}
          className="rounded-lg border-2 border-dashed px-4 py-4"
          style={{
            borderColor: dragging ? "var(--cinnabar)" : "var(--border)",
            background: dragging ? "var(--cinnabar-wash)" : "var(--background)",
          }}
        >
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(event) => {
              pick(event.target.files);
              // Cleared so that choosing the SAME file twice fires `change`
              // again. Without it, a reader who re-picks the paper they just
              // mis-dropped clicks a button that appears to do nothing.
              event.target.value = "";
            }}
          />
          <p className="text-[0.9375rem] font-medium text-ink">把论文的 PDF 拖到这里</p>
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">
            {pdfBusy
              ? pdfProgress
                ? `正在解析第 ${pdfProgress.page} / ${pdfProgress.total} 页——全部在你这台电脑上完成。`
                : "正在读取文件…"
              : "或者点击选择文件。单栏、双栏、会议版、预印本都可以。"}
          </p>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={anyBusy}
            className="mt-2.5 cursor-pointer rounded px-3.5 py-1.5 text-[0.8125rem] font-medium disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: "var(--cinnabar)", color: "var(--primary-foreground)" }}
          >
            {pdfBusy ? "正在解析…" : "选择 PDF 文件"}
          </button>
          <p className="mt-2.5 text-[0.75rem] leading-relaxed text-muted-foreground">
            文件不上传：解析在你自己的浏览器里完成，本机之外没有第二份副本。之后你划选的那一句照常发出去求解释，和导入一篇 arXiv 论文时完全一样。
          </p>
        </div>

        {/* --- the arXiv row, secondary ------------------------------- */}
        <div className="border-t pt-3" style={{ borderColor: "var(--paper-rule)" }}>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="arxiv-input">
              arXiv 编号或论文链接
            </label>
            <input
              id="arxiv-input"
              ref={inputRef}
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
              placeholder="也可以填 arXiv 编号或链接，例如 1706.03762"
              className="min-w-0 flex-1 rounded border px-3 py-1.5 font-mono text-[0.8125rem] text-ink disabled:opacity-50"
              style={{ borderColor: "var(--input)", background: "var(--background)" }}
            />
            <button
              type="button"
              onClick={submit}
              disabled={busy || !draft.trim()}
              className="shrink-0 cursor-pointer rounded border px-3.5 py-1.5 text-[0.8125rem] font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: "var(--border)", color: "var(--ink-soft)" }}
            >
              {busy ? "正在导入…" : "从 arXiv 导入"}
            </button>
          </div>
          <p className="mt-1.5 text-[0.75rem] leading-relaxed text-muted-foreground">
            这条路值得留着，是因为它能拿到 PDF 里没有的东西：章节层级和每个公式的原始 LaTeX。正文取自 arXiv 为该论文生成的网页版，需要论文有 LaTeX 源文件；较早或部分期刊投稿的论文可能没有，届时会如实告知，而不是给你一篇残缺的文章。
          </p>
        </div>

        {failure && (
          <p
            className="rounded border px-3 py-2 text-[0.8125rem] leading-relaxed"
            style={{ borderColor: "var(--border)", background: "var(--muted)", color: "var(--destructive)" }}
            role="alert"
          >
            {failure.message}
            {failure.retryable && !anyBusy && (
              <button
                type="button"
                onClick={() => onSubmit(draft)}
                disabled={!draft.trim()}
                className="ml-2 cursor-pointer font-medium underline decoration-dotted underline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
                style={{ color: "var(--cinnabar)" }}
              >
                再试一次
              </button>
            )}
          </p>
        )}

        {!storageOk && (
          <p className="text-[0.75rem]" style={{ color: "var(--destructive)" }}>
            浏览器存储不可用（可能是无痕模式）。本次导入可以正常阅读，但刷新后不会保留。
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: "var(--paper-rule)" }}>
          <span className="text-[0.6875rem] font-semibold tracking-wide text-cinnabar uppercase">
            本机书架
          </span>
          <span className="text-[0.6875rem] text-muted-foreground tabular-nums">
            {library.length} 篇
          </span>
          <button
            type="button"
            onClick={onPickDemo}
            disabled={isDemo || anyBusy}
            className="ml-auto cursor-pointer rounded-full border px-3 py-1 text-[0.75rem] font-medium transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: "var(--border)", color: "var(--ink-soft)" }}
          >
            回到预置示范论文
          </button>
        </div>

        {library.length === 0 ? (
          <p className="text-[0.8125rem] text-muted-foreground">
            还没有导入过论文。
          </p>
        ) : (
          <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-1 scrollbar-thin">
            {library.map((entry) => {
              const isCurrent = entry.arxivId === currentDocId && !isDemo;
              const isPdf = entry.kind === "pdf";
              return (
                <li
                  key={entry.arxivId}
                  className="flex items-center gap-2 rounded border px-3 py-2"
                  style={{
                    borderColor: isCurrent ? "var(--cinnabar)" : "var(--border)",
                    background: isCurrent ? "var(--cinnabar-wash)" : "var(--background)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onPickStored(entry.arxivId)}
                    disabled={anyBusy}
                    className="min-w-0 flex-1 cursor-pointer text-left disabled:cursor-not-allowed"
                  >
                    <span className="block truncate text-[0.8125rem] font-medium text-ink">
                      {entry.title}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[0.6875rem] text-muted-foreground">
                      {isPdf
                        ? `本机 PDF${entry.fileName ? ` · ${entry.fileName}` : ""}${
                            entry.pageCount ? ` · ${entry.pageCount} 页` : ""
                          }`
                        : `arXiv:${entry.arxivId}${entry.version}`}{" "}
                      · {entry.unitCount} 段 · {whenText(entry.importedAt)}
                      {isCurrent ? " · 正在读" : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(entry.arxivId)}
                    disabled={anyBusy}
                    className="shrink-0 cursor-pointer text-[0.6875rem] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-destructive disabled:cursor-not-allowed"
                    title={
                      isPdf
                        ? "从本机书架移除（不影响你的批注，更不影响你自己电脑上那份 PDF 文件）"
                        : "从本机书架移除（不影响你的批注，批注按论文编号单独保存）"
                    }
                  >
                    移除
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
