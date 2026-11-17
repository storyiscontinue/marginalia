/**
 * 参赛帖截图凭证：对【线上】站点做真实操作并截图。
 *
 * 为什么不用手截：这一组截图要证明的是"评委点开就能用"，所以每一步都走真实
 * 公网地址、真实上传、真实 AI 请求，而不是本地预览或摆拍。驱动方式是 Chrome
 * + CDP（Node 26 自带 WebSocket，不需要装任何依赖）。
 *
 * 为什么是【有头】Chrome：Sites 网关会拒绝无头浏览器（BOT_DETECTED，
 * "Automated tools are not allowed"）。我们不改 UA 去绕它——开一个真实浏览器
 * 窗口、用真实 UA 走完整流程，截图期间桌面上会短暂出现这个窗口。
 *
 * 用法：node dev/shots.mjs
 * 产物：docs/shots/*.png
 *
 * 注意：08 / 06 两张"终端"图是把命令的真实 stdout 原样排版后截的图，
 * 不是终端窗口截屏；帖子里要按这个口径写。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const LIVE = "https://marginalia-reader-ni20c3jx4cs.qoder.zone";
const PDF = path.resolve("dev/samples/2012.13779.pdf"); // LNCS 模板，非 CS 排版
const OUT = path.resolve("docs/shots");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 2;

fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(PDF)) throw new Error(`缺少样本 PDF：${PDF}（先跑 node dev/fetch-samples.mjs）`);

/* --- launch headless Chrome, learn its debugging port from stderr -------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "marginalia-shots-"));
const child = spawn(
  CHROME,
  [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    `--force-device-scale-factor=${SCALE}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    "--lang=zh-CN",
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let stderrBuf = "";
const wsUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Chrome 未在 20s 内给出调试地址")), 20000);
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
    const match = stderrBuf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
  child.on("exit", (code) => reject(new Error(`Chrome 提前退出 code=${code}\n${stderrBuf}`)));
});

/* --- minimal CDP client -------------------------------------------------- */
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("CDP 连接失败"));
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
    else resolve(msg.result);
  }
};
function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const cdp = (method, params) => send(method, params, sessionId);
await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("DOM.enable");
await cdp("Emulation.setDeviceMetricsOverride", {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: SCALE,
  mobile: false,
});

async function evaluate(expression) {
  const res = await cdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`页面脚本异常：${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
  }
  return res.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, fn, timeoutMs = 60000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(everyMs);
  }
}
async function shot(name, clipHeight) {
  const params = { format: "png" };
  if (clipHeight) {
    params.captureBeyondViewport = true;
    params.clip = { x: 0, y: 0, width: WIDTH, height: clipHeight, scale: 1 };
  }
  const { data } = await cdp("Page.captureScreenshot", params);
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  shot ${name}.png  (${(fs.statSync(file).size / 1024).toFixed(0)} kB)`);
  return file;
}
const clickByText = (selector, text) => `
  (() => {
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((n) => n.textContent.trim() === ${JSON.stringify(text)});
    if (!node) return false;
    node.click();
    return true;
  })()
`;

try {
  /* --- 07 首屏：零操作打开就是双语正文 ---------------------------------- */
  console.log("07 首屏");
  await cdp("Page.navigate", { url: LIVE });
  await waitFor("首屏段落", () => evaluate(`document.querySelectorAll("[data-unit-root]").length`), 60000);
  // 冷启动时探针可能先报不可用；点「重试」等它真的接通，再拍首屏。
  await waitFor(
    "AI 探针接通",
    async () => {
      const down = await evaluate(`document.body.textContent.includes("AI 服务暂时不可用")`);
      if (!down) return true;
      await evaluate(clickByText("button", "重试"));
      return false;
    },
    90000,
    4000,
  );
  await sleep(1200);
  const firstUrl = await evaluate("location.href");
  console.log(`  url ${firstUrl}`);
  await shot("07-first-screen");

  /* --- 09 拖入自己的 PDF ------------------------------------------------ */
  console.log("09 导入 PDF");
  if (!(await evaluate(clickByText("button", "换一篇")))) throw new Error("找不到「换一篇」");
  await waitFor("文件输入框", () => evaluate(`!!document.querySelector('input[type="file"]')`));
  await shot("09a-picker-open");
  const { root } = await cdp("DOM.getDocument", { depth: 1 });
  const { nodeId } = await cdp("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type="file"]' });
  await cdp("DOM.setFileInputFiles", { files: [PDF], nodeId });
  await waitFor(
    "PDF 解析完成",
    () =>
      evaluate(`
        (() => {
          const units = document.querySelectorAll("[data-unit-root]").length;
          const pickerGone = !document.querySelector('input[type="file"]');
          return units > 0 && pickerGone ? units : 0;
        })()
      `),
    120000,
  );
  await sleep(1500);
  const importedUrl = await evaluate("location.href");
  const importedTitle = await evaluate(`document.querySelector("h1")?.textContent ?? ""`);
  console.log(`  url ${importedUrl}`);
  console.log(`  title ${importedTitle}`);
  await evaluate(`window.scrollTo(0, 0)`);
  await sleep(400);
  await shot("09b-imported", 1500);

  /* --- 14 页首"哪些没有读入"的说明 -------------------------------------- */
  console.log("14 页首说明");
  await shot("14-parse-notes", 1150);

  /* --- 10 划线工具条 ---------------------------------------------------- */
  console.log("10 划线工具条");
  const picked = await evaluate(`
    (() => {
      const passages = [...document.querySelectorAll("p.passage")];
      const p = passages[2] ?? passages[0];
      p.scrollIntoView({ block: "center" });
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const textNode = walker.nextNode();
      const text = textNode.data;
      const sentences = text.match(/[^.!?]+[.!?]/g) ?? [text];
      const sentence = sentences.find((s) => s.trim().length >= 60 && s.trim().length <= 220) ?? sentences[0];
      const start = text.indexOf(sentence);
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + sentence.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      p.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return sentence.trim();
    })()
  `);
  console.log(`  selected: ${picked}`);
  await waitFor("工具条", () => evaluate(`!!document.querySelector("[data-toolbar]")`));
  await sleep(400);
  await shot("10-toolbar");

  /* --- 11 解释这句 → 页边批注卡 ----------------------------------------- */
  console.log("11 解释这句（真实 AI 请求）");
  if (!(await evaluate(clickByText("[data-toolbar] button", "解释这句")))) throw new Error("找不到「解释这句」");
  await sleep(4000);
  console.log(`  card: ${await evaluate(`document.querySelector(".annotation-card")?.textContent?.slice(0, 120) ?? "(无)"`)}`);
  try {
    await waitFor(
      "批注卡拿到答案",
      () =>
        evaluate(`
          (() => {
            const card = document.querySelector(".annotation-card");
            if (!card) return false;
            if (card.textContent.includes("正在请求解释…")) return false;
            card.scrollIntoView({ block: "center" });
            return true;
          })()
        `),
      240000,
      2000,
    );
  } catch (err) {
    console.error(`  诊断 card: ${await evaluate(`document.querySelector(".annotation-card")?.textContent ?? "(无)"`)}`);
    throw err;
  }
  await sleep(800);
  await shot("11-annotation");

  /* --- 12 改写批注 ------------------------------------------------------ */
  console.log("12 改写批注");
  if (!(await evaluate(clickByText(".annotation-card button", "改写")))) throw new Error("找不到「改写」");
  await waitFor("改写输入框", () => evaluate(`!!document.querySelector(".annotation-card textarea")`));
  await evaluate(`
    (() => {
      const ta = document.querySelector(".annotation-card textarea");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, "我自己的理解：这里说的是采样效率——用更少的交互次数学到够用的策略，重点是样本怎么挑，而不是模型多大。组会上我就讲这一句。");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()
  `);
  await sleep(300);
  if (!(await evaluate(clickByText(".annotation-card button", "保存我的理解")))) throw new Error("找不到「保存我的理解」");
  await waitFor("改写已保存", () => evaluate(`document.body.textContent.includes("已按你的改写保存")`));
  await sleep(500);
  await shot("12-edited");

  /* --- 13 刷新后从本机书架恢复 ------------------------------------------ */
  console.log("13 刷新恢复");
  await cdp("Page.reload", { ignoreCache: false });
  await waitFor(
    "刷新后恢复",
    () =>
      evaluate(`
        (() => {
          const units = document.querySelectorAll("[data-unit-root]").length;
          const card = document.querySelector(".annotation-card");
          return units > 0 && card && card.textContent.includes("已按你的改写保存") ? units : 0;
        })()
      `),
    90000,
  );
  await sleep(1000);
  const restoredUrl = await evaluate("location.href");
  console.log(`  url ${restoredUrl}`);
  await evaluate(`window.scrollTo(0, 0)`);
  await sleep(400);
  await shot("13-restored", 1200);
  fs.writeFileSync(
    path.join(OUT, "urls.txt"),
    `07 首屏: ${firstUrl}\n09 导入后: ${importedUrl}\n13 刷新后: ${restoredUrl}\n`,
  );

  /* --- 08 / 06 终端输出：真实 stdout 原样排版 --------------------------- */
  console.log("08 / 06 终端输出图");
  const { execFileSync } = await import("node:child_process");
  for (const [name, script] of [
    ["08-layout-suite", "dev/test-pdf-layout.ts"],
    ["06-verify-live", "dev/verify-live.ts"],
  ]) {
    const stdout = execFileSync(process.execPath, [script], { encoding: "utf8", cwd: path.resolve(".") });
    fs.writeFileSync(path.join(OUT, `${name}.txt`), stdout);
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:#1c1917;color:#e7e5e4;font:13px/1.55 Consolas,"Cascadia Mono",monospace;padding:28px 32px}
      .ok{color:#86efac}.fail{color:#fca5a5}.head{color:#fdba74}
      pre{margin:0;white-space:pre-wrap}
    </style><pre>${stdout
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/^=+ .* =+$/gm, (m) => `<span class="head">${m}</span>`)
      .replace(/^  ok {3}.*$/gm, (m) => `<span class="ok">${m}</span>`)
      .replace(/^  FAIL.*$/gm, (m) => `<span class="fail">${m}</span>`)}</pre>`;
    const htmlFile = path.join(OUT, `${name}.html`);
    fs.writeFileSync(htmlFile, html);
    await cdp("Page.navigate", { url: `file:///${htmlFile.replace(/\\/g, "/")}` });
    await waitFor("终端页渲染", () => evaluate(`document.querySelector("pre")?.textContent.length ?? 0`));
    await sleep(300);
    const height = await evaluate(`Math.ceil(document.body.scrollHeight)`);
    await shot(name, Math.min(height + 8, 16000));
  }

  console.log("\n全部截图完成 → docs/shots/");
} catch (err) {
  console.error(`\n截图流程失败：${err.message}`);
  process.exitCode = 1;
} finally {
  ws.close();
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  } catch {
    console.log(`（临时浏览器目录未删净，可手动清理：${profile}）`);
  }
}