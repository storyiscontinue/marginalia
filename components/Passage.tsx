import { useCallback, useEffect, useMemo, useRef } from "react";
import { DIFFICULTY_LABEL, ROLE_LABEL, type ReaderUnit } from "@/lib/paper";
import { resolveAnchor, type Annotation } from "@/lib/annotations";

export interface SelectionRequest {
  unitId: string;
  start: number;
  end: number;
  text: string;
  /** Viewport coordinates for the floating toolbar. */
  x: number;
  y: number;
}

/**
 * The Chinese line under an English paragraph.
 *
 * A union rather than four optional props, because these states are mutually
 * exclusive and exactly one must render. "No translation exists yet" is not the
 * same fact as "a translation was requested and failed", and collapsing them is
 * how a product ends up showing an empty grey box that the reader cannot tell is
 * loading, broken, or simply absent.
 */
export type ZhSlot =
  /** Text to show: curated up front, or generated on request. */
  | { kind: "text"; text: string; truncated?: boolean }
  /** Nothing yet. `blocked` carries the reason when asking is not possible. */
  | { kind: "offer"; blocked?: string }
  | { kind: "loading" }
  | { kind: "failed"; message: string };

interface ResolvedMark {
  start: number;
  end: number;
  annotationId: string;
}

interface Segment {
  text: string;
  annotationId: string | null;
}

interface PassageProps {
  unit: ReaderUnit;
  annotations: Annotation[];
  activeAnnotationId: string | null;
  showZh: boolean;
  isCurrent: boolean;
  knownTerms: string[];
  /** Ignored when `showZh` is false. */
  zh?: ZhSlot;
  onRequestZh?: (unitId: string) => void;
  onSelectAnnotation: (annotationId: string) => void;
  onRequestExplain: (request: SelectionRequest) => void;
  onEnterView: (unitId: string) => void;
}

/** Sum the lengths of every text node before `target` inside `root`. */
function offsetWithin(root: HTMLElement, target: Node, targetOffset: number): number | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let node = walker.nextNode();
  while (node) {
    if (node === target) return total + targetOffset;
    total += node.textContent?.length ?? 0;
    node = walker.nextNode();
  }
  return null;
}

/**
 * Build non-overlapping segments that concatenate back to exactly `original`.
 * That invariant is what makes offsets stored in an annotation remain valid:
 * the text the reader selected is measured against the same string.
 */
function buildSegments(original: string, marks: ResolvedMark[]): Segment[] {
  const ordered = [...marks].sort((a, b) => a.start - b.start || a.end - b.end);
  const segments: Segment[] = [];
  let cursor = 0;

  for (const mark of ordered) {
    if (mark.start < cursor) continue; // overlaps an earlier mark; skip it
    if (mark.start > cursor) {
      segments.push({ text: original.slice(cursor, mark.start), annotationId: null });
    }
    segments.push({
      text: original.slice(mark.start, mark.end),
      annotationId: mark.annotationId,
    });
    cursor = mark.end;
  }

  if (cursor < original.length) {
    segments.push({ text: original.slice(cursor), annotationId: null });
  }
  return segments;
}

export function Passage({
  unit,
  annotations,
  activeAnnotationId,
  showZh,
  isCurrent,
  knownTerms,
  zh,
  onRequestZh,
  onSelectAnnotation,
  onRequestExplain,
  onEnterView,
}: PassageProps) {
  const englishRef = useRef<HTMLParagraphElement>(null);

  // Resolve stored anchors against the current text. A note whose span can no
  // longer be located is dropped from rendering rather than attached to the
  // wrong words — it stays in storage and in the margin list as orphaned.
  const marks = useMemo<ResolvedMark[]>(() => {
    const resolved: ResolvedMark[] = [];
    for (const annotation of annotations) {
      const at = resolveAnchor(annotation.anchor, unit.original);
      if (at) resolved.push({ ...at, annotationId: annotation.id });
    }
    return resolved;
  }, [annotations, unit.original]);

  const segments = useMemo(
    () => buildSegments(unit.original, marks),
    [unit.original, marks],
  );

  // Report which unit is on screen so the spine can track the reader.
  useEffect(() => {
    const node = englishRef.current?.closest("[data-unit-root]");
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.4) onEnterView(unit.id);
        }
      },
      { threshold: [0.4, 0.75] },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [onEnterView, unit.id]);

  const handleMouseUp = useCallback(() => {
    const root = englishRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    // Only act when BOTH ends live inside this passage.
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;

    const start = offsetWithin(root, range.startContainer, range.startOffset);
    const end = offsetWithin(root, range.endContainer, range.endOffset);
    if (start === null || end === null) return;

    const [low, high] = start <= end ? [start, end] : [end, start];
    const text = unit.original.slice(low, high).trim();
    if (text.length < 2) return;

    const rect = range.getBoundingClientRect();
    onRequestExplain({
      unitId: unit.id,
      start: low,
      end: high,
      text,
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  }, [onRequestExplain, unit.id, unit.original]);

  // An imported paragraph carries no discourse role and no difficulty score,
  // because nobody has read it yet — reading it is the whole point of importing
  // it. An empty chip would be noise repeated sixty times over and a guessed
  // chip would be a lie, so neither renders; the absence is explained once, at
  // the top of the paper.
  const annotated = unit.role !== undefined || unit.difficulty !== undefined;

  return (
    <article
      className="border-b px-5 py-5 last:border-b-0 sm:px-8 sm:py-6"
      style={{ borderColor: "var(--paper-rule)" }}
      aria-label={`${unit.section} 第 ${unit.order} 段`}
    >
      <header className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {annotated && unit.role && (
          <span
            className="role-chip rounded-sm px-1.5 py-0.5 text-[0.625rem] font-semibold tracking-wide"
            style={{ background: "var(--indigo-wash)", color: "var(--indigo)" }}
            title="这段在全文论证链条中承担的角色"
          >
            {ROLE_LABEL[unit.role]}
          </span>
        )}

        {annotated && unit.difficulty && (
          <span
            className="text-[0.625rem] text-muted-foreground"
            title={`难度 ${unit.difficulty}/5`}
          >
            {DIFFICULTY_LABEL[unit.difficulty]}
          </span>
        )}

        {/* The page number. Uploaded PDFs only — an arXiv import has no pages,
            and a fake "第 1 页" would be worse than nothing.
            It is worth a chip because a reconstructed reading order can be
            wrong, and when it is the reader's only remedy is the original file:
            a page number turns "is this paragraph in the right place?" from a
            hunt into a glance. */}
        {unit.page !== undefined && (
          <span
            className="rounded-sm px-1.5 py-0.5 font-mono text-[0.625rem]"
            style={{ background: "var(--muted)", color: "var(--ink-soft)" }}
            title={`原文第 ${unit.page} 页。段落顺序由版式重建，页码取自文件本身`}
          >
            第 {unit.page} 页
          </span>
        )}

        <span className="ml-auto font-mono text-[0.625rem] text-muted-foreground">{unit.id}</span>
      </header>

      <p
        ref={englishRef}
        data-unit-id={unit.id}
        className="passage text-[1.0625rem] text-ink select-text"
        onMouseUp={handleMouseUp}
        onKeyUp={handleMouseUp}
        style={isCurrent ? { borderLeft: "2px solid var(--cinnabar)", paddingLeft: "0.875rem" } : { paddingLeft: "calc(0.875rem + 2px)" }}
      >
        {segments.map((segment, index) =>
          segment.annotationId ? (
            <mark
              key={index}
              className="mark-mine"
              data-active={segment.annotationId === activeAnnotationId}
              onClick={() => onSelectAnnotation(segment.annotationId!)}
              title="点击查看这条页边批注"
            >
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </p>

      {showZh && zh && <ZhLine unitId={unit.id} slot={zh} onRequestZh={onRequestZh} />}

      {knownTerms.length > 0 && (
        <p className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-3 text-[0.75rem]">
          <span className="text-muted-foreground">你在别处问过：</span>
          {knownTerms.map((term) => (
            <span
              key={term}
              className="rounded-full px-2 py-0.5 font-medium"
              style={{ background: "var(--cinnabar-wash)", color: "var(--cinnabar)" }}
              title="跨论文术语记忆：你之前问过这个词"
            >
              {term}
            </span>
          ))}
        </p>
      )}
    </article>
  );
}

/**
 * The Chinese line, in whichever of its four states it currently is.
 *
 * Split out for readability: the states have genuinely different markup, and a
 * chain of ternaries inside the article is what made this component awkward to
 * extend.
 */
function ZhLine({
  unitId,
  slot,
  onRequestZh,
}: {
  unitId: string;
  slot: ZhSlot;
  onRequestZh?: (unitId: string) => void;
}) {
  if (slot.kind === "text") {
    return (
      <div className="mt-2.5 pl-3">
        <p className="passage-zh text-[0.9375rem] text-ink-soft">{slot.text}</p>
        {slot.truncated && (
          <p className="mt-1 text-[0.6875rem]" style={{ color: "var(--destructive)" }}>
            译文在长度上限处被截断，结尾可能不完整。
          </p>
        )}
      </div>
    );
  }

  if (slot.kind === "loading") {
    return (
      <p className="mt-2.5 pl-3 text-[0.875rem] text-muted-foreground" role="status">
        正在翻译这一段…
      </p>
    );
  }

  if (slot.kind === "failed") {
    return (
      <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-3">
        <p className="text-[0.8125rem]" style={{ color: "var(--destructive)" }}>
          {slot.message}
        </p>
        {onRequestZh && (
          <button
            type="button"
            onClick={() => onRequestZh(unitId)}
            className="cursor-pointer text-[0.75rem] font-medium underline decoration-dotted underline-offset-2"
            style={{ color: "var(--cinnabar)" }}
          >
            再试一次
          </button>
        )}
      </div>
    );
  }

  // kind === "offer"
  if (slot.blocked) {
    return <p className="mt-2.5 pl-3 text-[0.8125rem] text-muted-foreground">{slot.blocked}</p>;
  }

  return (
    <div className="mt-2.5 pl-3">
      <button
        type="button"
        disabled={!onRequestZh}
        onClick={() => onRequestZh?.(unitId)}
        className="cursor-pointer rounded-full border px-2.5 py-0.5 text-[0.75rem] font-medium transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-40"
        style={{ borderColor: "var(--border)", color: "var(--ink-soft)" }}
        title="按段落生成中文译文，结果只存在你本机"
      >
        译这段
      </button>
    </div>
  );
}
