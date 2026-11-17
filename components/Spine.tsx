import { deriveSections, type ReaderPaper } from "@/lib/paper";

interface SpineProps {
  paper: ReaderPaper;
  currentUnitId: string | null;
  readUnitIds: string[];
  annotationCountByUnit: Record<string, number>;
  onJump: (unitId: string) => void;
}

/**
 * The reading spine.
 *
 * Doubles as the product's visual identity: a vertical route through the paper
 * with the reader's position marked, like a climbing line. It is a functional
 * element (progress, orientation, jump-to) and a recognisable screenshot at the
 * same time, which matters because most entries will look like a white
 * dashboard with a chat box.
 */
export function Spine({
  paper,
  currentUnitId,
  readUnitIds,
  annotationCountByUnit,
  onJump,
}: SpineProps) {
  const sections = deriveSections(paper.units);
  const total = paper.units.length;
  const done = readUnitIds.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <nav
      aria-label="阅读进度"
      className="sticky top-6 hidden shrink-0 flex-col gap-3 self-start pt-2 lg:flex"
      style={{ width: "9.5rem" }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[0.6875rem] font-medium tracking-wide text-ink-soft uppercase">
          进度
        </span>
        <span className="font-serif text-sm text-ink tabular-nums">{pct}%</span>
      </div>

      <div className="flex flex-col gap-0">
        {sections.map((section, sectionIndex) => (
          <div key={section.section} className="flex flex-col">
            <div className="flex items-center gap-2 py-1.5">
              <span
                aria-hidden
                className="block h-px w-3"
                style={{ background: "var(--paper-rule)" }}
              />
              <span className="text-[0.6875rem] leading-tight font-medium text-ink-soft">
                {section.section}
              </span>
            </div>

            {section.unitIds.map((unitId, unitIndex) => {
              const isCurrent = unitId === currentUnitId;
              const isRead = readUnitIds.includes(unitId);
              const notes = annotationCountByUnit[unitId] ?? 0;
              const isLast =
                sectionIndex === sections.length - 1 && unitIndex === section.unitIds.length - 1;

              return (
                <button
                  key={unitId}
                  type="button"
                  onClick={() => onJump(unitId)}
                  aria-current={isCurrent ? "true" : undefined}
                  aria-label={`跳到第 ${unitId} 段${notes > 0 ? `，${notes} 条批注` : ""}`}
                  className="group flex cursor-pointer items-stretch gap-2 text-left"
                >
                  <span className="relative flex w-3 justify-center">
                    {/* The continuous route line */}
                    <span
                      aria-hidden
                      className="absolute top-0 bottom-0 w-px"
                      style={{
                        background: isLast && !isRead ? "transparent" : "var(--paper-rule)",
                      }}
                    />
                    <span
                      aria-hidden
                      className="spine-node relative mt-2 block rounded-full"
                      data-current={isCurrent}
                      style={{
                        width: isCurrent ? "0.5rem" : "0.375rem",
                        height: isCurrent ? "0.5rem" : "0.375rem",
                        background: isCurrent
                          ? "var(--cinnabar)"
                          : isRead
                            ? "var(--indigo)"
                            : "var(--paper)",
                        border: `1px solid ${isCurrent || isRead ? "transparent" : "var(--paper-rule)"}`,
                        boxShadow: isCurrent ? "0 0 0 3px var(--cinnabar-wash)" : undefined,
                      }}
                    />
                  </span>

                  <span className="flex min-w-0 flex-1 items-center gap-1 pb-2">
                    <span
                      className="truncate text-[0.6875rem] text-muted-foreground transition-colors group-hover:text-ink"
                      style={isCurrent ? { color: "var(--cinnabar)", fontWeight: 600 } : undefined}
                    >
                      {isCurrent ? "正在读" : isRead ? "已读" : "未读"}
                    </span>
                    {notes > 0 && (
                      <span
                        className="shrink-0 rounded-full px-1.5 text-[0.625rem] font-semibold tabular-nums"
                        style={{
                          background: "var(--cinnabar-wash)",
                          color: "var(--cinnabar)",
                        }}
                        title={`${notes} 条页边批注`}
                      >
                        {notes}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
        批注保存在本机浏览器，不上传、不需要登录。
      </p>
    </nav>
  );
}
