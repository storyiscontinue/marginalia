/**
 * Preloaded demonstration paper.
 *
 * This file is the reason a judge can open the site and see the product
 * working in under ten seconds with zero actions, zero login and zero
 * waiting: the content is bundled into the static artifact, so the first
 * paint costs no Function invocation and no model tokens.
 *
 * Source: Vaswani et al., "Attention Is All You Need", arXiv:1706.03762.
 * Excerpts are reproduced for reading-instruction demonstration.
 */

import type { DiscourseRole, FormulaSymbol, PaperOrigin, Prerequisite } from "@/lib/paper";

// The closed discourse-role enum, its Chinese labels, the difficulty labels and
// the section derivation all live in `lib/paper.ts` now, so an imported arXiv
// paper and this curated one are described by a single model. They are
// re-exported from here because this file was their original home and existing
// imports point at it.
export { DISCOURSE_ROLES, DIFFICULTY_LABEL, ROLE_LABEL, deriveSections } from "@/lib/paper";
export type {
  DiscourseRole,
  FormulaSymbol,
  Prerequisite,
  ReaderFormula,
  ReaderPaper,
  ReaderUnit,
  SectionNode,
} from "@/lib/paper";

/**
 * The curated paper's units.
 *
 * Every interpretive field is REQUIRED here, and that is the honest shape: a
 * human read this paper and could state what each paragraph does and how hard it
 * is. `ReaderUnit` in `lib/paper.ts` is the same record with those fields
 * optional, which is what an import can truthfully offer. Because required
 * narrows to optional, `DemoPaper` is assignable to `ReaderPaper` and the whole
 * UI can run against one type.
 */
export interface ReadingUnit {
  id: string;
  order: number;
  section: string;
  sectionOrder: number;
  /** English original — the thing being read. */
  original: string;
  /** Chinese counterpart. Infrastructure, not the selling point. */
  zh: string;
  role: DiscourseRole;
  /** 1–5. Drives the "where will I get stuck" affordance, not decoration. */
  difficulty: 1 | 2 | 3 | 4 | 5;
}

export interface Formula {
  id: string;
  label: string;
  /** Canonical form, retained for a future KaTeX pass. */
  latex: string;
  /** Renderable now, without adding a typesetting dependency. */
  unicode: string;
  unitId: string;
  symbols: FormulaSymbol[];
  /** Item-by-item reading. Answers "how do I read this aloud". */
  plainReading: string;
  /** Where the paper itself leans on this formula. */
  citedIn: string[];
}

export interface DemoPaper {
  arxivId: string;
  title: string;
  authors: string;
  year: number;
  venue: string;
  primaryCategory: string;
  url: string;
  origin: PaperOrigin;
  prerequisites: Prerequisite[];
  units: ReadingUnit[];
  formulas: Formula[];
}

/**
 * Section numbering below was corrected against the real paper on 11/7, once
 * `functions/arxiv-parse.ts` could extract arXiv's own headings: 3.2 is
 * "Attention", and the scaled dot-product material is its subsection 3.2.1. The
 * units previously claimed 3.2 for it. A small error, but this file is the
 * product's credibility exhibit — a wrong heading in the hand-curated demo is
 * precisely the class of mistake the import path exists to eliminate.
 */
export const DEMO_PAPER: DemoPaper = {
  arxivId: "1706.03762",
  title: "Attention Is All You Need",
  authors:
    "Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Łukasz Kaiser, Illia Polosukhin",
  year: 2017,
  venue: "NeurIPS 2017",
  primaryCategory: "cs.CL",
  url: "https://arxiv.org/abs/1706.03762",
  origin: "curated",

  prerequisites: [
    {
      term: "sequence transduction（序列转导）",
      explanation:
        "指把一个序列映射成另一个序列的任务，机器翻译就是典型例子：输入英文句子，输出中文句子。它和分类任务的区别在于输出长度不固定、且输出内部有顺序依赖。论文里几乎所有'模型'都指做这件事的模型。",
    },
    {
      term: "RNN / LSTM 的逐步计算",
      explanation:
        "循环网络沿时间步一个一个地处理词，第 t 步的隐藏状态依赖第 t−1 步。这个串行依赖正是本文要攻击的靶子：它让训练无法在时间维度上并行。理解'串行依赖'这个词，就理解了本文一半的动机。",
    },
    {
      term: "softmax",
      explanation:
        "把任意一组实数压成一组和为 1 的正数，用来表示概率分布。关键性质是它会放大差距：输入越大，输出越接近 one-hot，梯度越接近 0。这个'饱和'特性是公式 (1) 里为什么要除以 √dₖ 的直接原因。",
    },
    {
      term: "Query / Key / Value 的检索隐喻",
      explanation:
        "借自数据库检索：拿一个查询（Query）去和一堆键（Key）比对相似度，相似度高的就把对应的值（Value）多取一点。在注意力里，'相似度'用点积衡量，'多取一点'用 softmax 权重实现。这套隐喻本身不含数学，先记住它在模仿检索。",
    },
    {
      term: "表示子空间（representation subspace）",
      explanation:
        "同一个词向量可以被投影到不同子空间，每个子空间关注不同性质的关系（比如一个管句法、一个管指代）。多头注意力的'多头'就是并行地做多次这种投影。这是理解 3.2.2 节的前置概念。",
    },
  ],

  units: [
    {
      id: "u-abstract-1",
      order: 1,
      section: "Abstract",
      sectionOrder: 1,
      original:
        "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
      zh: "主流的序列转导模型都基于复杂的循环或卷积神经网络，包含一个编码器和一个解码器。性能最好的模型还会通过注意力机制把编码器和解码器连接起来。我们提出一种新的简单网络架构——Transformer，它完全基于注意力机制，彻底摒弃了循环和卷积。",
      role: "gap",
      difficulty: 2,
    },
    {
      id: "u-intro-1",
      order: 2,
      section: "1 Introduction",
      sectionOrder: 2,
      original:
        "Recurrent neural networks, long short-term memory and gated recurrent neural networks in particular, have been firmly established as state of the art approaches in sequence modeling and transduction problems such as language modeling and machine translation.",
      zh: "循环神经网络，尤其是长短期记忆网络和门控循环神经网络，已被牢固确立为序列建模与转导问题（例如语言建模和机器翻译）的最先进方法。",
      role: "prior_work_limit",
      difficulty: 1,
    },
    {
      id: "u-intro-2",
      order: 3,
      section: "1 Introduction",
      sectionOrder: 2,
      original:
        "Inherently sequential nature of RNNs precludes parallelization within training examples, which becomes critical at longer sequence lengths, as memory constraints limit batching across examples. The fundamental constraint is that sequential computation prevents parallelization within training examples.",
      zh: "RNN 固有的顺序本质排除了训练样本内部的并行化，而这在序列较长时会变得至关重要，因为内存限制约束了跨样本的批处理。根本约束在于：顺序计算阻止了训练样本内部的并行化。",
      role: "gap",
      difficulty: 3,
    },
    {
      id: "u-32-1",
      order: 4,
      section: "3.2.1 Scaled Dot-Product Attention",
      sectionOrder: 3,
      original:
        "We call our particular approach “scaled dot-product attention”. The input consists of queries and keys of dimension d_k, and values of dimension d_v. We compute the dot products of the query with all keys, divide each by √d_k, and apply a softmax function to obtain the weights on the values.",
      zh: "我们把这种特定做法称为“缩放点积注意力”。输入由维度为 d_k 的查询和键、以及维度为 d_v 的值组成。我们计算查询与所有键的点积，把每个点积除以 √d_k，再应用 softmax 函数，从而得到施加在值上的权重。",
      role: "notation",
      difficulty: 3,
    },
    {
      id: "u-32-2",
      order: 5,
      section: "3.2.1 Scaled Dot-Product Attention",
      sectionOrder: 3,
      original:
        "The two most common attention functions in practice are additive attention, and dot-product (multiplicative) attention. Dot-product attention is identical to our algorithm, except for the scaling factor of 1/√d_k. Additive attention computes the attention function using a feed-forward network with a single hidden layer.",
      zh: "实践中最常见的两种注意力函数是加性注意力和点积（乘性）注意力。点积注意力与我们的算法完全相同，只是没有 1/√d_k 这个缩放因子。加性注意力则用一个带单隐层的前馈网络来计算注意力函数。",
      role: "prior_work_limit",
      difficulty: 2,
    },
    {
      id: "u-32-3",
      order: 6,
      section: "3.2.1 Scaled Dot-Product Attention",
      sectionOrder: 3,
      original:
        "We suspect that for large values of d_k, the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients. To counteract this effect, we scale the dot products by 1/√d_k.",
      zh: "我们推测：当 d_k 较大时，点积的数值会变得很大，把 softmax 函数推入梯度极小的区域。为了抵消这一效应，我们把点积缩放 1/√d_k。",
      role: "hypothesis",
      difficulty: 5,
    },
    {
      id: "u-322-1",
      order: 7,
      section: "3.2.2 Multi-Head Attention",
      sectionOrder: 4,
      original:
        "Instead of performing a single attention function with d_model-dimensional keys, values and queries, we found it beneficial to linearly project the queries, keys and values h times with different, learned linear projections to d_k, d_k and d_v dimensions, respectively.",
      zh: "我们发现，与其用 d_model 维的键、值、查询执行单个注意力函数，不如把查询、键、值分别线性投影 h 次到 d_k、d_k 和 d_v 维，且每次使用不同的、可学习的线性投影——这样做是有益的。",
      role: "method_step",
      difficulty: 4,
    },
    {
      id: "u-322-2",
      order: 8,
      section: "3.2.2 Multi-Head Attention",
      sectionOrder: 4,
      original:
        "Multi-head attention allows the model to jointly attend to information from different representation subspaces at different positions. With a single attention head, averaging inhibits this.",
      zh: "多头注意力让模型能够在不同位置上，同时关注来自不同表示子空间的信息。而只用单个注意力头时，平均操作会抑制这种能力。",
      role: "hypothesis",
      difficulty: 4,
    },
    {
      id: "u-322-3",
      order: 9,
      section: "3.2.2 Multi-Head Attention",
      sectionOrder: 4,
      original:
        "In practice, we compute the attention function on a set of queries simultaneously, packed together into a matrix Q. The keys and values are also packed together into matrices K and V.",
      zh: "在实践中，我们同时对一组查询计算注意力函数，把它们打包进一个矩阵 Q。键和值也同样被打包进矩阵 K 和 V。",
      role: "transition",
      difficulty: 3,
    },
  ],

  formulas: [
    {
      id: "f-attention",
      label: "(1)",
      latex: "\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}\\!\\left(\\frac{QK^{\\top}}{\\sqrt{d_k}}\\right)V",
      unicode: "Attention(Q, K, V) = softmax( QKᵀ ⁄ √dₖ ) V",
      unitId: "u-32-1",
      symbols: [
        { sym: "Q", meaning: "查询矩阵。每行是一个位置上'我在找什么'的向量。" },
        { sym: "K", meaning: "键矩阵。每行是一个位置上'我能提供什么'的向量。" },
        { sym: "V", meaning: "值矩阵。每行是一个位置上'真正要被取走的内容'。" },
        { sym: "Kᵀ", meaning: "K 的转置。转置是为了让矩阵乘法的形状对得上，从而一次算出所有查询与所有键的两两点积。" },
        { sym: "√dₖ", meaning: "键向量维度的平方根。它是一个标量，唯一作用是防止点积过大。" },
        { sym: "softmax(·)", meaning: "把每一行分数归一成和为 1 的权重，也就是'该从各个位置取多少'。" },
      ],
      plainReading:
        "从左往右读：第一步 QKᵀ，让每个查询和每个键做点积，得到一张'相关性打分表'。第二步除以 √dₖ，把打分表的数值压回温和区间，防止下一步饱和。第三步 softmax，把每一行打分变成一组和为 1 的权重。第四步乘 V，用这组权重对所有位置的内容做加权求和——这就是该位置的输出。\n\n一句话：这是一次可微分的软检索。打分决定取谁的、softmax 决定各取多少、V 是被取的东西。",
      citedIn: ["u-32-2", "u-32-3", "u-322-1"],
    },
    {
      id: "f-multihead",
      label: "(2)",
      latex:
        "\\mathrm{MultiHead}(Q,K,V)=\\mathrm{Concat}(\\mathrm{head}_1,\\dots,\\mathrm{head}_h)W^{O},\\quad \\mathrm{head}_i=\\mathrm{Attention}(QW_i^{Q},KW_i^{K},VW_i^{V})",
      unicode:
        "MultiHead(Q, K, V) = Concat(head₁, …, headₕ) Wᴼ，其中 headᵢ = Attention(QWᵢᵠ, KWᵢᴷ, VWᵢⱽ)",
      unitId: "u-322-1",
      symbols: [
        { sym: "h", meaning: "头的数量。论文取 8。每个头是一次独立的注意力计算。" },
        { sym: "Wᵢᵠ, Wᵢᴷ, Wᵢⱽ", meaning: "第 i 个头的三套投影矩阵。它们是让各个头看向不同子空间的唯一来源。" },
        { sym: "Concat", meaning: "把 h 个头的输出沿特征维拼接起来，而不是相加。" },
        { sym: "Wᴼ", meaning: "拼接后的输出投影矩阵，把拼起来的结果重新混合一次。" },
      ],
      plainReading:
        "先读右边再读左边。右边说的是：每个头先把 Q、K、V 各自过一遍自己专属的投影矩阵，再套用公式 (1) 做一次完整的注意力。也就是说 h 个头 = h 次独立的软检索，每次看的是不同子空间。\n\n左边说的是：把这 h 份结果拼接起来，再乘一个 Wᴼ 做最后混合。\n\n关键理解点：论文特意把每个头的维度降到 d_model/h，所以总计算量和单头全维度注意力大致相当——多头几乎是'免费'换来的。这是 3.2.2 节最容易被读漏的一句话。",
      citedIn: ["u-322-2", "u-322-3"],
    },
  ],
};
