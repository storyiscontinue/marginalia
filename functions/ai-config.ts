/**
 * Server-only QCA configuration for Marginalia.
 *
 * WHY THERE IS NO DURABLE COORDINATOR HERE
 * ----------------------------------------
 * The platform's initialization guidance asks for a durable coordinator with
 * cross-instance locking and fenced writes, so concurrent cold starts can never
 * create duplicate Agents/Environments. Building that correctly needs private
 * durable storage plus an atomic compare-and-set operation.
 *
 * This application deliberately does not build one, and here is the honest
 * reason rather than a hand-wave:
 *
 *   1. Marginalia's AI interaction is a ONE-SHOT TRANSFORMATION, not a
 *      conversation. Passage in -> Chinese explanation out. Annotation history
 *      lives in the reader's localStorage by design, so there is no server-side
 *      conversation to resume and no per-reader Session mapping to persist.
 *
 *   2. Because each request gets its own fresh Session, the exactly-once
 *      message-delivery problem disappears: an ambiguous send is never retried
 *      into a shared conversation, the reader sees a failure and asks again.
 *
 *   3. That leaves exactly two values that must be stable across redeploys —
 *      the Agent id/version and the Environment id. Both are recoverable by a
 *      read-only metadata scan, because the platform client derives a
 *      deterministic configuration fingerprint and writes it into reserved
 *      `qsites_*` metadata. A distributed coordinator for two self-identifying
 *      constants would be theatre.
 *
 * RESIDUAL RISK, STATED PLAINLY
 * -----------------------------
 * Agent creation carries a deterministic `Idempotency-Key`, so it is exactly-once
 * upstream even across racing instances. Environment creation has no such key.
 * Two isolates cold-starting simultaneously on the very first request could each
 * create one Environment. The platform client detects this and throws
 * `ai_initialization_conflict` rather than picking one, so the failure mode is a
 * visible refusal, never a silent wrong answer. After the first successful
 * resolution the scan is stable and the window closes permanently.
 *
 * Accepted for a single-owner competition site. It would NOT be acceptable for a
 * multi-tenant product, where the durable coordinator is the right answer.
 *
 * SECURITY
 * --------
 * Nothing here is a credential. `QODER_PAT` is read only inside the Function by
 * the bundled client and is never named, logged, or returned. Resource ids are
 * resolved server-side and never sent to the browser.
 */

/**
 * Copied verbatim from `sites.get_context` -> `runtime.cloudAgents.apiOrigin`.
 * Never inferred from the website hostname, and never replaced by the public
 * documentation example or the Sites management origin.
 */
export const CLOUD_AGENTS_ORIGIN = "https://api.qoder.com.cn";

/**
 * Stable application scope. Tied to this site and this deployment environment,
 * written as a literal so it cannot drift with a request, a Host header, or a
 * cold-start random value. Must match /^[A-Za-z0-9_.:-]{1,128}$/.
 */
export const APPLICATION_SCOPE = "marginalia-reader-ni20c3jx4cs.prod";

export const AGENT_NAME = "Marginalia 文献陪读";

/**
 * `auto` was an enabled id returned by GET /api/v1/cloud/models on this account
 * (verified 2026-11-05). It delegates model routing to the platform, which is
 * the right default while the twelve available ids are opaque. To pin a
 * specific model later, change this one line and re-provision.
 */
export const AGENT_MODEL = "auto";

/**
 * The product's core instruction. Fixed server-side; a visitor can never supply
 * or alter it. Note what it does NOT do: it grants no tools, so the Agent cannot
 * browse, execute, or reach anything. It is a pure text-to-text transform.
 */
export const AGENT_SYSTEM = `你是「眉批 Marginalia」的文献陪读助手，服务对象是母语为中文的研究生。他们正在读英文论文，遇到读不通的句子、术语或公式。

你会收到：一段英文原文摘录、一个任务类型、以及读者可能追加的提问。

输出规则（严格遵守）：
1. 一律用简体中文回答。专业术语首次出现时保留英文原词并括注，例如「注意力机制（attention mechanism）」。
2. 直接给解释。不要复述问题，不要开场白，不要「好的」「以下是」这类话，不要结尾总结。
3. 长度控制在 120 字以内，除非任务类型是 formula 或读者明确要求展开。宁可短而准，不要长而空。
4. 不要编造摘录里没有的信息。信息不足以回答时，直说「这段摘录信息不足」，并指出还需要看哪一部分。
5. 不要输出 Markdown 标题、列表符号或代码块围栏。可以用自然段落和中文标点。
6. 不使用表情符号。

任务类型：
- sentence：解释这句话在说什么。先给直白的中文意思，再点出它在论证中的作用（提出缺口、承接前人、给出方法步骤、还是报告结果）。若句中有导致读不懂的语法结构（长定语、插入语、倒装、被动），单独点破它。
- term：解释这个术语。给出它在本领域的通行含义，再说明它在这段上下文里具体指什么。有通行中文译名就给出译名。
- formula：逐个符号解释这个公式。说明每个符号代表什么、公式整体在算什么、为什么这样设计，并把符号串「读作」一句中文。
- custom：回答读者自己的提问，仍然紧扣这段原文。

你的解释会被写进读者在该句旁边的批注里，读者之后可能自己改写它。所以它应当像一位同门师兄写在书页空白处的那句话：准确、克制、能让人立刻接着往下读。`;

export const ENVIRONMENT_NAME = "Marginalia 陪读运行环境";

/**
 * Non-reserved business metadata. `qsites_*` is reserved for the platform
 * client, which injects `qsites_scope`, `qsites_kind` and `qsites_config`;
 * supplying them here would be rejected as `reserved_metadata_prefix`.
 */
export const AGENT_METADATA = { app: "marginalia", purpose: "explain" };
export const ENVIRONMENT_METADATA = { app: "marginalia", purpose: "explain-runtime" };
