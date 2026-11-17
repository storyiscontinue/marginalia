import { useState } from "react";
import type { ReaderFormula } from "@/lib/paper";

interface FormulaCardProps {
  formula: ReaderFormula;
  /** Title of the unit this formula lives in, for the "where is it used" link. */
  onAskAboutFormula?: (formula: ReaderFormula) => void;
  aiReady: boolean;
}

/**
 * Formula, in plain language.
 *
 * This is the single highest-value macro-layer element and the one most likely
 * to produce the "aha" on a projected screen: it answers not "what symbols are
 * here" but "how do I read this aloud, and why is each term present".
 *
 * Rendered from a pre-computed unicode form so the first slice needs no
 * typesetting dependency. The canonical LaTeX is kept on the data model for a
 * later KaTeX pass.
 *
 * Two levels of completeness reach this card. A curated paper arrives with a
 * symbol glossary, a plain reading and cross-references written by a human. An
 * import arrives with the LaTeX the authors wrote, its readable rendering, and
 * the number the authors printed — and nothing interpretive. The card shows what
 * it has and says plainly what it does not, rather than filling the gaps with a
 * plausible guess about what a symbol might mean.
 */
export function FormulaCard({ formula, onAskAboutFormula, aiReady }: FormulaCardProps) {
  const [open, setOpen] = useState(true);
  const glossed = formula.symbols.length > 0 || !!formula.plainReading;

  return (
    <section
      className="system-note my-5 rounded-r-md px-4 py-3.5 sm:px-5"
      aria-labelledby={`${formula.id}-heading`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3
          id={`${formula.id}-heading`}
          className="text-[0.6875rem] font-semibold tracking-wide text-indigo uppercase"
        >
          {glossed
            ? `公式 ${formula.label || "(未编号)"} · 人话拆解`
            : `公式 ${formula.label || "(未编号)"} · 原文照录`}
        </h3>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="cursor-pointer text-[0.6875rem] font-medium text-indigo underline decoration-dotted underline-offset-2 hover:opacity-70"
        >
          {open ? "收起" : "展开"}
        </button>
      </div>

      {/* The formula itself */}
      <div
        className="mt-3 overflow-x-auto rounded border px-4 py-3 text-center"
        style={{ borderColor: "var(--paper-rule)", background: "var(--paper)" }}
      >
        <span className="font-serif text-base whitespace-nowrap text-ink sm:text-lg">
          {formula.unicode}
        </span>
      </div>

      {open && (
        <>
          {/* Symbol table — curated papers only. */}
          {formula.symbols.length > 0 && (
            <dl className="mt-3.5 grid gap-x-5 gap-y-2 sm:grid-cols-2">
              {formula.symbols.map((symbol) => (
                <div key={symbol.sym} className="flex gap-2">
                  <dt className="shrink-0 font-serif text-sm font-semibold text-indigo tabular-nums">
                    {symbol.sym}
                  </dt>
                  <dd className="text-[0.8125rem] leading-relaxed text-ink-soft">{symbol.meaning}</dd>
                </div>
              ))}
            </dl>
          )}

          {/* Item-by-item reading — curated papers only. */}
          {formula.plainReading && (
            <div className="mt-3.5 border-t pt-3" style={{ borderColor: "var(--paper-rule)" }}>
              <h4 className="text-[0.6875rem] font-semibold tracking-wide text-indigo uppercase">
                怎么读
              </h4>
              {formula.plainReading.split("\n\n").map((paragraph, index) => (
                <p
                  key={index}
                  className="mt-1.5 text-[0.875rem] leading-relaxed text-ink-soft first:mt-2"
                >
                  {paragraph}
                </p>
              ))}
            </div>
          )}

          {/* An imported formula: the LaTeX is the authors', the readable form is
              mechanically derived from it, and nothing here is an opinion about
              what it means. Say that, then offer the one thing that can help. */}
          {!glossed && (
            <p
              className="mt-3.5 border-t pt-3 text-[0.8125rem] leading-relaxed text-ink-soft"
              style={{ borderColor: "var(--paper-rule)" }}
            >
              这是从论文里原样提取的公式，还没有人替它写过逐符号解释。点下面的按钮，它会连同所在段落一起交给
              AI 讲解，结果写进你那一段的页边批注，你可以自己改写。
            </p>
          )}

          {formula.citedIn.length > 0 && (
            <div
              className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3"
              style={{ borderColor: "var(--paper-rule)" }}
            >
              <span className="text-[0.6875rem] text-muted-foreground">
                正文在这些地方用到它：
              </span>
              <span className="flex flex-wrap gap-1.5">
                {formula.citedIn.map((unitId) => (
                  <code
                    key={unitId}
                    className="rounded px-1.5 py-0.5 font-mono text-[0.6875rem] text-ink-soft"
                    style={{ background: "var(--muted)" }}
                  >
                    {unitId}
                  </code>
                ))}
              </span>
            </div>
          )}

          {onAskAboutFormula && (
            <div
              className="mt-3.5 flex justify-end border-t pt-3"
              style={{ borderColor: "var(--paper-rule)" }}
            >
              <button
                type="button"
                onClick={() => onAskAboutFormula(formula)}
                disabled={!aiReady}
                title={aiReady ? "就这个公式提问" : "AI 服务未接通，暂不可用"}
                className="shrink-0 cursor-pointer rounded-full border px-3 py-1 text-[0.75rem] font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  borderColor: "var(--cinnabar)",
                  color: "var(--cinnabar)",
                  background: "var(--cinnabar-wash)",
                }}
              >
                就这个公式提问
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
