// Layout-stage diagnostic — not a test, and not part of the build.
//
//   node dev/probe-stages.ts 2012.11922.pdf
//
// `dev/test-pdf-layout.ts` says whether a paper came out right. This says WHICH
// function is responsible: it re-runs the pipeline stage by stage and prints
// every page-1 line with the stage that claims it, then the lines the footnote
// stage removed. That is the whole reason a leaked title page is hard to fix
// from the suite alone — five stages can each be innocent and the text still
// reaches the prose, and the gap test in `dropFootnotes` measures against a
// number no test prints.
//
// Parses the first 12 pages only, which is deliberate: the leaks it is for are
// on page 1, and reading 60 pages to see them takes a minute per run.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  toLines,
  bodyFontSize,
  dropRunningFurniture,
  orderForReading,
  findTitle,
  collectTitlePage,
  dropFrontMatter,
  dropFootnotes,
  dropContents,
  dropLabels,
} from "../lib/pdf-layout.ts";
import { runsFromTextContent } from "../lib/pdf-text.ts";

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];

const task = getDocument({
  data: new Uint8Array(readFileSync(join(here, "samples", file))),
  verbosity: 0,
  disableFontFace: true,
});
const doc = await task.promise;
const runs: ReturnType<typeof runsFromTextContent> = [];
for (let index = 1; index <= Math.min(doc.numPages, 12); index += 1) {
  const page = await doc.getPage(index);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  runs.push(...runsFromTextContent(content.items ?? [], index, viewport.width, viewport.height));
  page.cleanup();
}
await task.destroy();

const lines = toLines(runs as never);
const body = bodyFontSize(lines);
const furniture = dropRunningFurniture(lines, doc.numPages);
const ordered = orderForReading(furniture.kept as never);
const found = findTitle(ordered.lines, body);
const titleLines = found?.titleLines ?? [];
const tp = collectTitlePage(ordered.lines, titleLines, body);
const noFront = dropFrontMatter(ordered.lines, titleLines[0] ?? null, tp.drop);
const notes = dropFootnotes({ ...ordered, lines: noFront }, body);
const toc = dropContents({ ...ordered, lines: notes.kept });
const labels = dropLabels({ ...ordered, lines: toc.kept }, body);

const front = new Set(tp.drop);
const noFrontSet = new Set(noFront);
const notesSet = new Set(notes.kept);
const tocSet = new Set(toc.kept);
const labelSet = new Set(labels.kept);
const first = titleLines[0];

console.log(`正文字号 ${body.toFixed(1)} · 标题行 ${titleLines.length} · 作者 ${JSON.stringify(tp.authors)}`);
console.log(`脚注剔除 ${notes.dropped} · 目录剔除 ${toc.dropped} · 标注剔除 ${labels.dropped}`);
console.log(`每栏行距: ${[...ordered.columnLeading.entries()].slice(0, 4).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" ")}`);
console.log(`\n第 1 页逐行（y / 字号 / 列 / 归谁 / 文本）`);
for (const line of ordered.lines) {
  if (line.page !== 1) continue;
  const fate = front.has(line)
    ? "扉页"
    : !noFrontSet.has(line)
      ? "前文剔除?"
      : !notesSet.has(line)
        ? "脚注"
        : !tocSet.has(line)
          ? "目录"
          : !labelSet.has(line)
            ? "标注"
            : "正文";
  console.log(
    `  ${String(Math.round(line.y)).padStart(4)} ${line.fontSize.toFixed(1).padStart(4)} c${line.column} ${fate.padEnd(6)} ${line.text.slice(0, 78)}`,
  );
}
console.log(`\n标题 y=${first ? Math.round(first.y) : "?"}`);

const keptAfterFront = new Set(noFront);
console.log(`\n脚注阶段剔除的行（共 ${notes.kept.length} 行保留 / ${notes.dropped} 行剔除）`);
let shown = 0;
for (const line of noFront) {
  if (notesSet.has(line)) continue;
  if (shown++ > 45) {
    console.log("  …");
    break;
  }
  console.log(`  p${line.page} ${String(Math.round(line.y)).padStart(4)} ${line.fontSize.toFixed(1)} ${line.text.slice(0, 74)}`);
}
void keptAfterFront;
