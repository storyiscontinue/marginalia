# dev/samples

版面与解析测试用的真实样本。

**PDF 不在仓库里**：论文有版权，而且七份合计 21 MB。取回方式：

```sh
node dev/fetch-samples.mjs
```

跑完之后：

```sh
node dev/test-pdf-layout.ts   # 七篇论文 · 164 项断言
```

## 清单

| 文件 | 论文 | 它在测试里负责什么 |
|---|---|---|
| `1512.03385.pdf` | Attention Is All You Need | 单栏预印本基线；∗/†/‡ 说明块与页底脚注的剔除 |
| `1706.03762.pdf` | Deep Residual Learning for Image Recognition | 双栏 CVPR：栏序、图注断段、坐标轴碎片丢弃、页数上限 |
| `2005.14165.pdf` | Language Models are Few-Shot Learners | 75 页超长文：容量上限的如实说明、半句越过 23 段找回正文 |
| `2012.12675.pdf` | Arithmetization of well-formed parenthesis strings | 数学模板：关键词表剔除、摘要被跨页切成三截（`knownTails: 2`） |
| `2012.11542.pdf` | Uncertainty on the Reproduction Ratio in the SIR Model | 经济模板：24.9 pt 封面行距逼出的脚注参照量修正、`(Preliminary version)` |
| `2012.13779.pdf` | Towards sample-efficient policy learning with DAC-ML | LNCS：`Adri´ an` 这类分离重音拼回 `Adrián`、`?` 游离标记 |
| `2012.11922.pdf` | Learning Structures in Earth Observation Data with GPs | IEEE：`MARKER_OPEN`（"Paper published in …" 曾是第 3 段正文）、URL 冒充作者名 |

`attention.html`（1706.03762 的 arXiv LaTeXML 网页版）与 `mixtral.html`（2401.04088）是**随仓库提交的**，因为它们只有 190 kB 左右，而 `dev/test-arxiv-parse.ts` 要离线跑纯解析器；它们同样是 arXiv 生成的公开产物，来源就是上面这两个编号。

## 版本漂移

`dev/test-pdf-layout.ts` 里的每个数字都是在 11/7 与 11/16 取回的那两份具体版本上量出来的。`fetch-samples.mjs` 走的是 arXiv 的最新版地址，如果某篇论文在这期间出过 v2/v3，重新取回的文件可能让个别精确计数断言变红——那不是回归，是基线跟着文件变了。遇到这种情况请重新测量并把数字写回夹具，而不是放宽断言。
