# Marginalia 眉批 · 英文文献陪读

> 你读英文文献时问过的每一个问题，都会变成你自己的页边批注库。
>
> **在线地址（无需登录、无需 API Key）**：<https://marginalia-reader-ni20c3jx4cs.qoder.zone>
>
> 2026 Qoder 高校创造力大赛 · StudyHack 学习科研赛道。开发与部署均由 Qoder 完成，部署用 Qoder Sites。

## 它做什么

把你的英文论文 PDF 拖进去，正文按版面重建出来（双栏、脚注、图注、目录页都有规则），然后：

- 划住任意一句 →「解释这句 / 这是术语 / 提问… / 只写批注」。问题与 AI 的回答一起写进那一句的页边批注卡。
- 批注可改写：改写后以你的版本为准，并标注来源。可删除：删的只是那一句的眉批，术语本上的词仍然留着。
- 每段下方「译这段」，只译你点的那一段。
- 刷新、换天、换设备前的所有东西都在你自己浏览器里（localStorage），论文文件不出本机。

## 五分钟跑起来

```sh
npm ci
npm run dev            # 前端，按提示用 loopback 地址
node dev/fetch-samples.mjs && node dev/test-pdf-layout.ts   # 版面回归（164 项断言）
npm run build          # tsc --noEmit + Function 类型检查 + Vite 产物
npm run preview        # 用刚构建的 dist 起本地站点
```

Node 版本要求见 `package.json`（`^22.13.0 || >=24.0.0`）。**`npm run build` 是唯一的类型检查**：Node 26 的类型擦除只删标注、不检查类型，这个坑踩过两次。

## 架构

三层，边界是硬的：

| 层 | 文件 | 允许依赖 | 为什么 |
|---|---|---|---|
| 版面几何 | `lib/pdf-layout.ts` | 零 import | 纯函数，能被 Node 直接跑测试，版面规则因此有回归网 |
| 正文组装 | `lib/pdf-text.ts` | 不碰 DOM | 段落、作者行、解析说明在这里成形 |
| pdf.js 提取 | `lib/pdf.ts` | 浏览器专属 | 唯一 import pdf.js 的地方 |

**为什么 PDF 解析在浏览器里**：Qoder Sites 的后端是一个 Deno Edge Function，打包器不安装 npm 依赖，`pdfjs-dist` 进不去。这个限制的真实含义不是"做不了 PDF"，而是"只能在浏览器里做"——pdf.js 本来就是浏览器库，`?worker` 打进前端产物即可。副作用是方案变好了：用户的论文不出本机，隐私论述从"我们不存"升级成"我们收不到"。

AI 链路：`functions/index.ts` 里的 `explain` / `translate` / `fetch-paper`。调用凭证只以平台 Secret 的形式存在于 Function 内部（`Deno.env.get`），前端永远碰不到 Key。每次解释走一个一次性 Session + 有界轮询，上游 429 做一次有界重试；单次可提交文本长度超限是 400 拒绝，**不截断**——截断会让读者以为自己得到了完整答案。

## 测试

| 命令 | 覆盖 |
|---|---|
| `node dev/test-pdf-layout.ts` | 七篇真实论文的版面重建，164 项断言：段落顺序与内容流一致、没有半句开头的段落、正文里不夹图注脚注、扉页标签被剔除、作者行不含单位/邮箱/URL |
| `node dev/test-arxiv-parse.ts` | arXiv LaTeXML 纯解析器（离线，用仓库内的两个 HTML 夹具） |
| `node dev/test-arxiv-fetch.ts` | 抓取侧与出口校验 |
| `node dev/verify-live.ts` | 线上六组检查：服务产物与本地构建一致、第二篇论文可导入、翻译模式、超长拒绝、边界（无 Origin 的 POST 被网关拒、被撤掉的临时路由仍是 404） |
| `node dev/probe-stages.ts <file>` | 逐阶段诊断：每栏行距、第 1 页每一行归谁、脚注阶段删了哪几行。不是测试，不进构建 |

版面阈值旁边都写着它是被哪篇论文的哪个版面测出来的，改规则前先读那段注释。样本清单与版本漂移说明见 [dev/samples/README.md](dev/samples/README.md)。

## 有意识的边界

- **不做 OCR**。扫描件没有文字层，返回的是"这里不做 OCR：与其给你一份满是错字的正文，不如直说读不到"。
- **不给导入的论文生成公式卡**。PDF 文字层里的公式只剩打乱顺序的字母，宁可空着，也不拼一条错公式上去。
- **删掉多少就报告多少**。页首如实写出：图和表里 N 行文字没读入、页面底部 N 行脚注没读入、扉页 N 段标签没读入、N 处跨行断词保留了连字符（自动断词和原文自带的连字符在文字层里是同一个符号，去掉会把后者拼成错词）。
- **提交份数与成本**。逐段按需翻译，而不是打开就全译：每个 AI 请求都是一个一次性 Session（约 8 次上游调用），无条件前置这笔开销不合理。

## 已知缺陷（点名，不藏着）

1. 经济论文第 1 页的致谢段成了首段——它的字号就是正文字号，几何上不是家具，再放宽判据就会开始吃正文。
2. 同一篇里两位作者的名在 14 pt 的两行排布中丢了，只剩姓氏缩写。
3. 数学论文的摘要被自己的跨页排版切成三截（夹具里记成 `knownTails: 2`）。
4. 地球科学论文有一段是"三条参考链接 + 一句图内说明"焊在一起，`isLinkList` 只认去掉链接后剩下不足 40 字符的那种，这里剩了约 50 字符。

## 目录

```
lib/          版面几何 / 正文组装 / pdf.js 提取
src/          React 入口与主界面
functions/    Deno Edge Function（explain / translate / fetch-paper）
components/   随模板带来的 UI 目录（见 PROVENANCE.md）
data/         首屏预置论文（打包进静态资源，零请求）
dev/          测试、诊断、本地 Function、样本获取脚本
docs/         产品规划书与参赛帖草稿
```

## 版权

论文版权归原作者。仓库里不放论文 PDF（用 `dev/fetch-samples.mjs` 自己取回），线上服务也不留存任何一篇；这里只做阅读辅助，不做再发布。模板来源见 [PROVENANCE.md](PROVENANCE.md)。
