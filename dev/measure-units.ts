// Measures the parsed unit-length distribution so the translate mode's excerpt
// and answer caps are chosen from data rather than guessed.
//
// Run: node dev/measure-units.ts
import { readFileSync } from "node:fs";
import { parseLatexml } from "../functions/arxiv-parse.ts";

const SAMPLES: Array<[string, string, string]> = [
  ["Attention", "dev/samples/attention.html", "1706.03762"],
  ["Mixtral", "dev/samples/mixtral.html", "2401.04088"],
];

for (const [name, file, id] of SAMPLES) {
  const result = parseLatexml(readFileSync(file, "utf8"), id);
  if (!result.ok) {
    console.log(`${name}: parse failed (${result.code})`);
    continue;
  }
  const lengths = result.paper.units.map((u) => u.original.length).sort((a, b) => a - b);
  const at = (q: number) => lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * q))];
  const countOver = (n: number) => lengths.filter((x) => x > n).length;
  console.log(
    `${name.padEnd(10)} units ${String(lengths.length).padStart(3)} | ` +
      `min ${String(lengths[0]).padStart(4)} med ${String(at(0.5)).padStart(4)} ` +
      `p90 ${String(at(0.9)).padStart(4)} max ${String(lengths[lengths.length - 1]).padStart(4)} | ` +
      `>1200: ${countOver(1200)}  >1800: ${countOver(1800)}  >2400: ${countOver(2400)} | ` +
      `chars ${lengths.reduce((a, b) => a + b, 0)}`,
  );
}
