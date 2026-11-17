// 取回版面测试用的论文样本。
//
//   node dev/fetch-samples.mjs
//
// 这些 PDF 有版权，所以仓库里不放文件，只放这份下载脚本和清单。脚本从 arXiv 的
// 公开 PDF 地址取原文，落到 `dev/samples/<id>.pdf`，已存在就不重复下载。
//
// 版本说明：`dev/test-pdf-layout.ts` 里的每个数字（段数、字符数、`knownTails`）
// 都是在 11/7 与 11/16 取回的那两份具体版本上测出来的。arXiv 的 `<id>` 地址给的是
// 最新版本，如果论文在此期间出过 v2/v3，个别精确计数断言可能要先重新测量再提交——
// 这是有意的取舍：宁可让基线跟着文件走，也不要把别人的论文抄进仓库。
import { createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "samples");

const SAMPLES = [
  ["1512.03385", "Attention Is All You Need — 单栏预印本，首屏预置论文"],
  ["1706.03762", "Deep Residual Learning for Image Recognition — 双栏 CVPR，页底脚注与图内文字的来源"],
  ["2005.14165", "Language Models are Few-Shot Learners — 75 页，用来测页数上限"],
  ["2012.12675", "Arithmetization of well-formed parenthesis strings — 数学，摘要被跨页切成三截"],
  ["2012.11542", "Uncertainty on the Reproduction Ratio in the SIR Model — 经济，封面行距 24.9 pt 那一篇"],
  ["2012.13779", "Towards sample-efficient policy learning with DAC-ML — LNCS 会议版"],
  ["2012.11922", "Learning Structures in Earth Observation Data with Gaussian Processes — IEEE 地球科学"],
];

for (const [id, label] of SAMPLES) {
  const target = join(here, `${id}.pdf`);
  if (existsSync(target)) {
    console.log(`已有 ${id}.pdf`);
    continue;
  }
  const url = `https://arxiv.org/pdf/${id}`;
  console.log(`下载 ${url} — ${label}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    console.log(`  失败：HTTP ${response.status}（arXiv 有速率限制，稍后重试）`);
    continue;
  }
  await new Promise((resolve, reject) => {
    const file = createWriteStream(target);
    response.body.pipe(file).on("close", resolve).on("error", reject);
    file.on("error", reject);
  });
  console.log(`  → dev/samples/${id}.pdf`);
}

console.log("\n下一步：node dev/test-pdf-layout.ts");
