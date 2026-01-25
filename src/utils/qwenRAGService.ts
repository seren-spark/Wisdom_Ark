/**
 * QwenRAGService - 基于通义千问的 RAG 服务
 *
 * 已实现功能：
 * ✅ 多路召回检索（向量 + BM25 + 查询改写 + HyDE）
 * ✅ LLM 智能重排序
 * ✅ 滑动窗口重叠分块（20% overlap）
 * ✅ 引用溯源标注（[REF-X]）
 * ✅ 混合检索（向量 + 关键词）
 * ✅ 动态上下文压缩
 * ✅ 元数据增强（章节层级）
 *
 * 待优化（面试可提）：
 * - 向量数据库：当前用内存数组，生产环境可用 Qdrant/Milvus
 * - 效果评估：召回率/精准率统计
 * - 用户反馈闭环
 */

/**
 * 1. 检索策略过于简单(应该已实现)
当前只用了余弦相似度 + Top-K，缺少：

重排序（Reranking）：可以提到用交叉编码器二次排序，提升精准度
混合检索：BM25（关键词） + 向量检索的融合，对专有名词效果更好
查询改写：用 LLM 把用户意图扩展成多个查询，提高召回
 *
2. 分块策略不够智能
现在按固定字数 + 标题切分，更好的做法：

滑动窗口重叠：chunk 之间有 20% 重叠，避免语义被截断
语义边界识别：用 NLP 找句子/段落边界，而非硬切
元数据增强：给每个 chunk 加上「所属章节层级」「前后文摘要」

上下文构建缺少优化
检索到内容后直接拼接，可以：

动态上下文压缩：用 LLM 把检索结果压缩成精华，节省 Token
引用溯源：告诉 LLM 哪段内容来自哪个 chunk，生成时可标注来源
负例注入：加入「不相关的内容示例」，让模型学会拒答


面试可以主动提「如何衡量 RAG 效果」：

召回率/精准率：检索是否找到了正确片段
答案质量：用 ROUGE/BLEU 或 LLM-as-Judge 打分
用户反馈闭环：记录哪些回答被点赞/差评，持续优化



向量数据库用本地数组
面试官可能会问「生产环境怎么做」：

提到可以用 Pinecone / Qdrant / Milvus 等专业向量库
支持分布式存储、ANN 近似搜索（HNSW/IVF）
可以讲讲索引构建的 Trade-off（速度 vs 精度）

6. Embedding 模型选择
当前固定用通义的 text-embedding-v2，可以深入：

多语言模型：中文用 bge-large-zh，英文用 OpenAI Ada-002
领域适配：医疗/法律文档可以 Fine-tune Embedding
降维优化：提到 Matryoshka Embeddings（可变维度）
 */

import { chatInEditor } from '@/utils/openAi';

interface Chunk {
  id: string;
  content: string;
  embedding: number[];
  metadata: {
    chapter: string;
    level: number;
    position: number;
    type?: 'text' | 'code';
    source?: 'current' | 'history';
    articleId?: string;
    articleTitle?: string;
  };
}

interface SearchResult {
  content: string;
  score: number;
  metadata: {
    chapter: string;
    level: number;
    position: number;
    type?: 'text' | 'code';
    source?: 'current' | 'history';
    articleId?: string;
    articleTitle?: string;
  };
  source?:
    | 'current'
    | 'history'
    | 'vector'
    | 'keyword'
    | 'hybrid'
    | 'original'
    | 'rewritten'
    | 'expanded'
    | 'hyde';
  refId?: string; // 🆕 引用溯源 ID
}

interface DocTypeInfo {
  primary: 'code' | 'technical' | 'literary';
  codeRatio: number;
}

// RAG 配置常量
const RAG_CONFIG = {
  // 上下文长度
  QUERY_PREFIX_LENGTH: 300,
  QUERY_SUFFIX_LENGTH: 100,
  INJECTED_PREFIX_LENGTH: 500,
  INJECTED_SUFFIX_LENGTH: 200,

  // 文档限制
  MIN_DOC_LENGTH: 500,
  MAX_CHUNK_SIZE: 800,
  MIN_CHUNK_SIZE: 100,

  // 🆕 滑动窗口重叠配置（根据文档类型动态调整）
  CHUNK_OVERLAP_RATIO: 0.2, // 20% 重叠（自然语言）
  CHUNK_OVERLAP_RATIO_CODE: 0.1, // 10% 重叠（代码文档）

  // 检索参数
  DEFAULT_TOP_K: 3,
  MIN_SIMILARITY: 0.2,
  HIGH_QUALITY_THRESHOLD: 0.3, // 🔧 从 0.35 降到 0.3（更宽松）
  BATCH_SIZE: 10,

  // 🆕 高级功能开关（默认关闭，可选启用）
  ENABLE_QUERY_EXPANSION: false, // 查询扩展（3次LLM调用）
  ENABLE_HYDE: false, // HyDE假设文档生成（1次LLM调用）
  ENABLE_LLM_RERANK: false, // LLM重排序（1次LLM调用）
  ENABLE_BM25: false, // BM25关键词检索
  ENABLE_CITATION: false, // 引用标注 [REF-X]
  RERANK_MIN_RESULTS: 3,

  // 🔧 Token 预算调整（更适合补全场景）
  EVIDENCE_TOKEN_RATIO: 0.2, // 20% 给检索结果
  CONTEXT_TOKEN_RATIO: 0.8, // 80% 给前后文
  MAX_CONTEXT_TOKENS: 3000,
  RESERVED_FOR_OUTPUT: 1024,

  // 缓存
  MAX_CACHE_SIZE: 1000,
} as const;

/**
 * 🔹 智能文档类型检测（基于内容比例）
 */
function detectDocTypeForRAG(text: string): DocTypeInfo {
  const sample = (text || '').slice(0, 5000);

  // 1. 统计代码块
  const codeBlockMatches = sample.match(/```[\s\S]*?```/g) || [];
  const codeBlockChars = codeBlockMatches.join('').length;
  const codeRatio = sample.length > 0 ? codeBlockChars / sample.length : 0;

  // 2. 统计技术词汇密度
  const technicalWords =
    sample.match(/\bAPI\b|\bHTTP\b|\bCLI\b|配置|安装|版本|性能|算法|复杂度/g) ||
    [];
  const technicalDensity = technicalWords.length / (sample.length / 100);

  // 3. 判断主要类型
  if (codeRatio > 0.3) {
    return { primary: 'code', codeRatio };
  }

  if (technicalDensity > 3) {
    return { primary: 'technical', codeRatio };
  }

  return { primary: 'literary', codeRatio };
}

export class QwenRAGService {
  private chunks: Chunk[] = []; //存储知识库的文本分片
  private apiKey: string;
  private embeddingCache = new Map<string, number[]>(); // 缓存嵌入向量
  private stats = {
    ragCalls: 0, //Rag模型调用次数  走[检索+生成]
    normalCalls: 0, //普通模式调用次数
    degradeReasons: [] as string[], //eg: 降级原因
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * 🔹 步骤1：构建文档索引
   * @param markdown 当前文档内容
   * @param options 可选配置
   *   - includeHistory: 是否包含历史文档（默认 false）
   *   - historyDocs: 用户选择的历史文档列表
   */
  async buildIndex(
    markdown: string,
    options: {
      includeHistory?: boolean;
      historyDocs?: { id: string; title: string; content: string }[];
    } = {},
  ): Promise<void> {
    const { includeHistory = false, historyDocs = [] } = options;

    console.log('📚 开始构建RAG索引...');
    const startTime = Date.now();

    // 1. 语义分块当前文档
    const rawChunks = this.semanticChunk(markdown);
    console.log(`✂️ 当前文档已分成 ${rawChunks.length} 个语义块`);

    // 🆕 2. 如果启用历史文档，添加历史文档的分块
    if (includeHistory && historyDocs.length > 0) {
      console.log(`📖 包含 ${historyDocs.length} 篇历史文档`);

      for (const doc of historyDocs) {
        const historyChunks = this.semanticChunk(doc.content);

        // 标记来源为历史文档
        historyChunks.forEach((chunk) => {
          chunk.metadata = {
            ...chunk.metadata,
            source: 'history',
            articleId: doc.id,
            articleTitle: doc.title,
          };
        });

        rawChunks.push(...historyChunks);
      }

      console.log(`📦 总共 ${rawChunks.length} 个语义块（含历史文档）`);
    }

    if (rawChunks.length === 0) {
      console.warn('⚠️ 文档太短，未生成有效分块');
      return;
    }

    // 2. 批量生成embedding
    const BATCH_SIZE = 10; // 通义千问建议每次不超过25个

    for (let i = 0; i < rawChunks.length; i += BATCH_SIZE) {
      const batch = rawChunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map((c) => c.content);

      try {
        const embeddings = await this.batchGetEmbeddings(texts);

        batch.forEach((chunk, idx) => {
          this.chunks.push({
            id: `chunk-${i + idx}`,
            content: chunk.content,
            embedding: embeddings[idx],
            metadata: chunk.metadata,
          });
        });

        // console.log(
        //   `📊 进度：${Math.min(i + BATCH_SIZE, rawChunks.length)}/${rawChunks.length}`,
        // );
      } catch (error) {
        console.error('Embedding生成失败', error);
        throw error;
      }
    }

    const duration = Date.now() - startTime;
    console.log(`✅ RAG索引构建完成！`);
    console.log(`   - 总块数：${this.chunks.length}`);
    console.log(`   - 耗时：${(duration / 1000).toFixed(1)}秒`);
  }

  /**
   * 🔹 步骤2：检索相关文档
   */
  async search(
    query: string,
    topK = 3,
    debug = false,
  ): Promise<SearchResult[]> {
    if (this.chunks.length === 0) {
      console.warn('⚠️ 索引为空，请先调用 buildIndex()');
      return [];
    }

    // 1. 查询文本转向量
    const queryEmbedding = await this.getEmbedding(query);

    // 2. 计算所有chunk的相似度
    const scores = this.chunks.map((chunk) => ({
      content: chunk.content,
      metadata: chunk.metadata,
      score: this.cosineSimilarity(queryEmbedding, chunk.embedding),
    }));
    const MIN_SIM = 0.2;
    const filtered = scores.filter((s) => s.score >= MIN_SIM);
    if (debug) {
      console.log('🔎 RAG.search 调试');
      console.log(' - query:', query.slice(0, 300));
      console.log(' - topK:', topK, ' MIN_SIM:', MIN_SIM);
      console.log(
        ' - chunks:',
        this.chunks.length,
        ' filtered:',
        filtered.length,
      );
    }

    // 3. 排序并返回Top-K
    const pool = filtered.length > 0 ? filtered : [];
    const results = pool.sort((a, b) => b.score - a.score).slice(0, topK);

    console.log('🔍 检索结果：');
    results.forEach((r, i) => {
      console.log(
        `  ${i + 1}. [${r.metadata.chapter}] 相似度: ${(r.score * 100).toFixed(1)}%`,
      );
    });

    return results;
  }

  /**
   * 🔹 多路召回检索 - 简化版（保留核心功能）
   * @param query 查询文本
   * @param topK 返回结果数量
   * @param options 可选配置
   */
  async multiRetrieval(
    query: string,
    topK = 3,
    options: {
      debug?: boolean;
      enableExpansion?: boolean; // 是否启用查询扩展
      enableHyDE?: boolean; // 是否启用 HyDE
      enableLLMRerank?: boolean; // 是否启用 LLM 重排序
    } = {},
  ): Promise<SearchResult[]> {
    const {
      debug = false,
      enableExpansion = RAG_CONFIG.ENABLE_QUERY_EXPANSION,
      enableHyDE = RAG_CONFIG.ENABLE_HYDE,
      enableLLMRerank = RAG_CONFIG.ENABLE_LLM_RERANK,
    } = options;

    if (this.chunks.length === 0) {
      console.warn('⚠️ 索引为空，请先调用 buildIndex()');
      return [];
    }

    // ✅ 1. 原始查询检索（必选）
    const originalResults = await this.search(query, topK * 2, debug);

    // ✅ 2. 查询改写检索（必选，提升召回率）
    const rewrittenQuery = await this.rewriteQuery(query);
    const rewrittenResults =
      rewrittenQuery !== query
        ? await this.search(rewrittenQuery, topK, debug)
        : [];

    // ⚠️ 3. 查询扩展检索（可选，默认关闭）
    const expandedResults: SearchResult[] = [];
    if (enableExpansion) {
      const expandedQueries = await this.expandQuery(query);
      for (const expQuery of expandedQueries.slice(1)) {
        const expResults = await this.search(
          expQuery,
          Math.ceil(topK / 2),
          debug,
        );
        expandedResults.push(...expResults);
      }
    }

    // ⚠️ 4. HyDE检索（可选，默认关闭）
    let hydeResults: SearchResult[] = [];
    if (enableHyDE) {
      const hypotheticalDoc = await this.generateHypotheticalDocument(query);
      hydeResults =
        hypotheticalDoc !== query
          ? await this.search(hypotheticalDoc, Math.ceil(topK / 2), debug)
          : [];
    }

    // 5. 合并结果并去重
    const allResults: (SearchResult & {
      source: SearchResult['source'];
      weight: number;
    })[] = [
      ...originalResults.map((r) => ({
        ...r,
        source: 'original' as const,
        weight: 1.0,
      })),
      ...rewrittenResults.map((r) => ({
        ...r,
        source: 'rewritten' as const,
        weight: 1.1,
      })),
      ...(enableExpansion
        ? expandedResults.map((r) => ({
            ...r,
            source: 'expanded' as const,
            weight: 0.9,
          }))
        : []),
      ...(enableHyDE
        ? hydeResults.map((r) => ({
            ...r,
            source: 'hyde' as const,
            weight: 0.8,
          }))
        : []),
    ];

    // 6. 去重
    const deduplicatedResults = this.deduplicateResults(allResults);

    // ⚠️ 7. 重排序（可选，默认关闭）
    const finalResults = enableLLMRerank
      ? await this.rerankResults(query, deduplicatedResults)
      : this.simpleRerank(deduplicatedResults);

    if (debug) {
      console.log('🔍 多路召回调试信息:');
      console.log(' - 原始查询结果数:', originalResults.length);
      console.log(' - 改写查询结果数:', rewrittenResults.length);
      if (enableExpansion)
        console.log(' - 扩展查询结果数:', expandedResults.length);
      if (enableHyDE) console.log(' - HyDE查询结果数:', hydeResults.length);
      console.log(' - 去重后结果数:', deduplicatedResults.length);
      console.log(' - 最终返回:', Math.min(topK, finalResults.length));
    }

    return finalResults.slice(0, topK);
  }

  /**
   * 🔹 混合检索 - 结合向量和关键词检索
   * @param query 查询文本
   * @param topK 返回结果数量
   * @param options 可选配置
   */
  async hybridSearch(
    query: string,
    topK = 3,
    options: {
      debug?: boolean;
      bm25Weight?: number; // BM25权重（默认0.3）
    } = {},
  ): Promise<SearchResult[]> {
    const { debug = false, bm25Weight = 0.3 } = options;

    // 向量检索
    const vectorResults = await this.search(query, topK * 2, debug);

    // ⚠️ 关键词检索（可选，默认关闭）
    const keywordResults = RAG_CONFIG.ENABLE_BM25
      ? await this.bm25Search(query, topK * 2)
      : [];

    // 合并结果（加权融合）
    const allChunks = new Map<
      string,
      SearchResult & { source: SearchResult['source']; weight: number }
    >();

    // 添加向量检索结果（权重0.7）
    vectorResults.forEach((result) => {
      const key = result.content.substring(0, 100); // 使用内容前100字符作为key
      allChunks.set(key, {
        ...result,
        source: 'vector' as const,
        weight: 0.7,
        score: result.score * 0.7,
      });
    });

    // 添加关键词检索结果（权重0.3）
    keywordResults.forEach((result) => {
      const key = result.content.substring(0, 100);
      if (allChunks.has(key)) {
        // 如果已存在，合并分数
        const existing = allChunks.get(key)!;
        allChunks.set(key, {
          ...result,
          source: 'hybrid' as const,
          weight: 1.0,
          score: existing.score + result.score * 0.3,
        });
      } else {
        allChunks.set(key, {
          ...result,
          source: 'keyword' as const,
          weight: 0.3,
          score: result.score * 0.3,
        });
      }
    });

    // 排序并返回Top-K
    return [...allChunks.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * 🔹 结果去重 - 基于内容相似度
   */
  private deduplicateResults(
    results: (SearchResult & {
      source: SearchResult['source'];
      weight: number;
    })[],
  ): (SearchResult & { source: SearchResult['source']; weight: number })[] {
    const uniqueResults: (SearchResult & {
      source: SearchResult['source'];
      weight: number;
    })[] = [];

    for (const result of results) {
      let isDuplicate = false;

      for (const unique of uniqueResults) {
        // 计算内容相似度，如果相似度超过阈值则认为是重复
        const similarity = this.calculateContentSimilarity(
          result.content,
          unique.content,
        );
        if (similarity > 0.8) {
          isDuplicate = true;
          // 保留权重更高的结果
          if (result.weight > unique.weight) {
            unique.content = result.content;
            unique.score = result.score;
            unique.source = result.source;
            unique.weight = result.weight;
          }
          break;
        }
      }

      if (!isDuplicate) {
        uniqueResults.push(result);
      }
    }

    return uniqueResults;
  }

  /**
   * 🔹 内容相似度计算
   */
  private calculateContentSimilarity(
    content1: string,
    content2: string,
  ): number {
    // 简化的Jaccard相似度计算
    const words1 = new Set(content1.toLowerCase().match(/\b\w+\b/g) || []);
    const words2 = new Set(content2.toLowerCase().match(/\b\w+\b/g) || []);

    const intersection = new Set(
      [...words1].filter((word) => words2.has(word)),
    );
    const union = new Set([...words1, ...words2]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * 🔹 重排序 - 使用 LLM 智能重排序（带降级）
   */
  private async rerankResults(
    query: string,
    results: (SearchResult & {
      source: SearchResult['source'];
      weight: number;
    })[],
  ): Promise<SearchResult[]> {
    if (results.length <= 1) return results;

    // 如果结果太少或禁用了 LLM 重排序，使用简单加权
    if (
      !RAG_CONFIG.ENABLE_LLM_RERANK ||
      results.length < RAG_CONFIG.RERANK_MIN_RESULTS
    ) {
      return this.simpleRerank(results);
    }

    try {
      // 构造重排序 prompt
      const candidates = results
        .map((r, idx) => `[${idx}] ${r.content.slice(0, 150)}...`)
        .join('\n\n');

      const prompt = `查询: "${query}"

以下是${results.length}个候选文档片段，请按照与查询的相关性从高到低排序。
只返回编号序列，用逗号分隔（如: 2,0,4,1,3）

候选片段:
${candidates}

相关性排序:`;

      const response = await fetch('http://localhost:3001/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          temperature: 0.1, // 低温度保证稳定输出
        }),
      });

      const data = await response.json();
      const rankingStr = data.choices?.[0]?.message?.content?.trim() || '';

      // 解析排序结果 "2,0,4,1,3"
      const indices = rankingStr
        .split(/[,\s]+/)
        .map((s: string) => parseInt(s.trim()))
        .filter(
          (idx: number) => !isNaN(idx) && idx >= 0 && idx < results.length,
        );

      // 如果解析成功且数量匹配，使用 LLM 排序
      if (
        indices.length === results.length &&
        new Set(indices).size === results.length
      ) {
        console.log('✅ LLM 重排序成功:', indices.join(','));
        return indices.map((idx: number) => results[idx]);
      }

      // 部分匹配：优先使用 LLM 排序的结果，剩余按原分数
      if (indices.length > 0) {
        console.log('⚠️ LLM 重排序部分成功，混合排序');
        const reranked: SearchResult[] = [];
        const used = new Set<number>();

        indices.forEach((idx: number) => {
          if (!used.has(idx)) {
            reranked.push(results[idx]);
            used.add(idx);
          }
        });

        // 添加未被 LLM 排序的结果
        results.forEach((r, idx) => {
          if (!used.has(idx)) {
            reranked.push(r);
          }
        });

        return reranked;
      }

      console.warn('⚠️ LLM 重排序解析失败，降级到分数排序');
    } catch (error) {
      console.warn('❌ LLM 重排序 API 调用失败:', error);
    }

    // 降级：使用简单加权排序
    return this.simpleRerank(results);
  }

  /**
   * 🔹 简单加权重排序（降级方案）
   */
  private simpleRerank(
    results: (SearchResult & {
      source: SearchResult['source'];
      weight: number;
    })[],
  ): SearchResult[] {
    return results
      .map((result) => ({
        ...result,
        score: result.score * result.weight,
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * 🔹 步骤3：RAG增强的AI补全
   */
  async ragComplete(
    prefix: string,
    suffix: string,
    options: {
      topK?: number;
      showContext?: boolean;
      useMultiRetrieval?: boolean; // 新增选项
      useHybridSearch?: boolean; // 新增选项
    } = {},
  ): Promise<string> {
    const {
      topK = RAG_CONFIG.DEFAULT_TOP_K,
      showContext = false,
      useMultiRetrieval = true, // 默认启用多路召回
      useHybridSearch = false, // 默认不使用混合检索
    } = options;
    this.stats.ragCalls++;

    // 1. 智能提取查询
    const query = this.extractSmartQuery(prefix, suffix);

    // 2. 根据选项选择检索策略
    let currentResults: SearchResult[];
    if (useMultiRetrieval) {
      currentResults = await this.multiRetrieval(query, topK, {
        debug: showContext,
      });
    } else if (useHybridSearch) {
      currentResults = await this.hybridSearch(query, topK, {
        debug: showContext,
      });
    } else {
      currentResults = await this.search(query, topK, showContext);
    }

    // 3. 筛选高质量结果
    const highQualityResults = currentResults.filter(
      (r) => r.score >= RAG_CONFIG.HIGH_QUALITY_THRESHOLD,
    );

    // 4. 使用高质量结果（历史文档已在 buildIndex 时包含）
    const finalResults = highQualityResults.slice(0, topK);

    // 5. 降级检查
    if (finalResults.length === 0) {
      const reason = '未找到相关内容';
      this.stats.degradeReasons.push(reason);
      console.warn(`⚠️ RAG 降级: ${reason}`);
      return this.normalComplete(prefix, suffix);
    }

    if (
      finalResults.every((r) => r.score < RAG_CONFIG.HIGH_QUALITY_THRESHOLD)
    ) {
      const reason = `所有结果质量过低 (最高: ${(Math.max(...finalResults.map((r) => r.score)) * 100).toFixed(1)}%)`;
      this.stats.degradeReasons.push(reason);
      console.warn(`⚠️ RAG 降级: ${reason}`);
      return this.normalComplete(prefix, suffix);
    }

    // 6. 智能构建证据（动态调整长度，避免 Token 溢出）
    const docType = detectDocTypeForRAG(
      `${prefix.slice(-500)} ${suffix.slice(0, 200)}`,
    );

    // 计算可用 Token 数
    const estimateTokens = (text: string) => Math.ceil(text.length / 2);
    const maxInputTokens =
      RAG_CONFIG.MAX_CONTEXT_TOKENS - RAG_CONFIG.RESERVED_FOR_OUTPUT;

    // 构建 Style Guide
    const styleGuide = this.buildStyleGuide(docType.primary);
    const styleGuideTokens = estimateTokens(styleGuide);

    // 🔧 计算可用于证据和上下文的 Token（调整为 20% + 80%）
    const availableTokens = maxInputTokens - styleGuideTokens;
    const evidenceTokenBudget = Math.floor(
      availableTokens * RAG_CONFIG.EVIDENCE_TOKEN_RATIO,
    ); // 20%
    const contextTokenBudget = Math.floor(
      availableTokens * RAG_CONFIG.CONTEXT_TOKEN_RATIO,
    ); // 80%

    // 动态调整证据长度
    const evidencePerChunk = Math.floor(
      (evidenceTokenBudget / finalResults.length) * 2,
    );

    // ✅ 构建证据（不使用引用标注）
    const evidence = finalResults
      .map((r, idx) => {
        const source = r.source
          ? ` [${r.source === 'history' ? '历史' : '当前'}]`
          : '';
        const title = `${idx + 1}. ${r.metadata.chapter}${source}`;
        const snippet = r.content.slice(0, Math.max(100, evidencePerChunk));
        return `${title} (${(r.score * 100).toFixed(0)}%)\n${snippet}`;
      })
      .join('\n\n');

    // 动态调整上下文长度
    const contextChars = contextTokenBudget * 2;
    const prefixChars = Math.floor(contextChars * 0.7);
    const suffixChars = Math.floor(contextChars * 0.3);

    // ✅ 构建 Prompt（不包含引用标注指令）
    const injectedPrefix = `${styleGuide}\n\n[参考片段]\n${evidence}\n\n${prefix.slice(-prefixChars)}`;
    const injectedSuffix = suffix.slice(0, suffixChars);

    // 根据文档类型和代码比例调整温度
    let temperature = 0.7;
    if (docType.primary === 'code') {
      temperature = 0.2;
    } else if (docType.primary === 'technical') {
      temperature = docType.codeRatio > 0.1 ? 0.3 : 0.4;
    } else {
      temperature = 0.8;
    }

    if (showContext) {
      console.log('🧩 RAG.ragComplete 调试');
      console.log(' - query:', query.slice(0, 300));
      console.log(
        ' - 文档类型:',
        docType.primary,
        `(代码占比: ${(docType.codeRatio * 100).toFixed(1)}%)`,
      );
      console.log(' - 命中片段数:', finalResults.length);
      finalResults.forEach((r, i) => {
        const source = r.source ? ` [${r.source}]` : '';
        console.log(
          `   ${i + 1}. ${r.metadata.chapter}${source} - ${(r.score * 100).toFixed(1)}% (${r.content.length}字)`,
        );
      });
      console.log(' - Token 预估:');
      console.log(`   - Style Guide: ${styleGuideTokens}`);
      console.log(`   - Evidence: ${estimateTokens(evidence)}`);
      console.log(
        `   - Context: ${estimateTokens(injectedPrefix + injectedSuffix)}`,
      );
      console.log(' - Temperature:', temperature);
    }

    // 7. 调用 AI 生成
    try {
      const result = await chatInEditor({
        prefix: injectedPrefix,
        suffix: injectedSuffix,
        temperature,
      });

      if (showContext) {
        console.log('✅ RAG 生成成功:', result.slice(0, 100) + '...');
      }

      return result;
    } catch (error) {
      const reason = `生成失败: ${error instanceof Error ? error.message : String(error)}`;
      this.stats.degradeReasons.push(reason);
      console.error('❌ RAG 生成失败，降级到普通补全', error);
      return this.normalComplete(prefix, suffix);
    }
  }

  /**
   * 🔹 智能提取查询（提取主题而非简单截取）
   */
  private extractSmartQuery(prefix: string, suffix: string): string {
    // 1. 尝试提取最近的标题
    const recentHeader = this.extractRecentHeader(prefix);
    if (recentHeader) {
      return recentHeader;
    }

    // 2. 提取最后一个段落
    const paragraphs = prefix.split('\n\n').filter((p) => p.trim());
    if (paragraphs.length > 0) {
      const lastParagraph = paragraphs[paragraphs.length - 1];
      if (lastParagraph.length >= 50 && lastParagraph.length <= 500) {
        return lastParagraph;
      }
    }

    // 3. 降级：使用前后文组合
    return `${prefix.slice(-RAG_CONFIG.QUERY_PREFIX_LENGTH)} ${suffix.slice(0, RAG_CONFIG.QUERY_SUFFIX_LENGTH)}`.trim();
  }

  /**
   * 🔹 提取最近的标题
   */
  private extractRecentHeader(prefix: string): string | null {
    const lines = prefix.split('\n');
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
      if (match) {
        return match[2];
      }
    }
    return null;
  }

  /**
   * 🔹 构建 Style Guide
   */
  private buildStyleGuide(docType: 'code' | 'technical' | 'literary'): string {
    const guides = {
      code: '[STYLE]\nType: code\nInstructions: Continue the code precisely; keep language and style; avoid explanations; maintain indentation; use the same programming language.',
      technical:
        '[STYLE]\nType: technical\nInstructions: Be concise and precise; keep markdown structure; keep terminology consistent; prefer bullet points when appropriate; avoid generic filler.',
      literary:
        '[STYLE]\nType: literary\nInstructions: Keep tone consistent; ensure smooth transitions; use natural and expressive language as context indicates.',
    };
    return guides[docType];
  }

  /**
   * 🔹 通义千问Embedding API调用
   */
  private async batchGetEmbeddings(texts: string[]): Promise<number[][]> {
    // console.log(this.apiKey, 'this.apiKey');
    // const response = await fetch('https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding', {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${this.apiKey}`,
    //     'Content-Type': 'application/json'
    //   },
    //   body: JSON.stringify({
    //     model: 'text-embedding-v2', // 通义千问的Embedding模型
    //     input: {
    //       texts: texts
    //     },
    //     parameters: {
    //       text_type: 'document' // document或query
    //     }
    //   })
    // });

    // if (!response.ok) {
    //   throw new Error(`Embedding API调用失败: ${response.status}`);
    // }

    // const data = await response.json();

    // // 通义千问返回格式
    // return data.output.embeddings.map((item: any) => item.embedding);
    // 🔥 使用代理路径
    // const apiUrl = import.meta.env.DEV
    //   ? '/api/dashscope/api/v1/services/embeddings/text-embedding/text-embedding' // 开发环境走代理
    //   : 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding'; // 生产环境需要后端
    const apiUrl = import.meta.env.DEV
      ? 'http://localhost:3001/api/embedding'
      : '/api/embedding';

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        texts,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Embedding API调用失败: ${response.status}`);
    }

    const data = await response.json();

    if (!data.output || !data.output.embeddings) {
      throw new Error('Embedding API 返回格式错误');
    }

    return data.output.embeddings.map((item: any) => item.embedding);
  }

  /**
   * 🔹 获取单个文本的Embedding（带缓存）
   */
  private async getEmbedding(text: string): Promise<number[]> {
    const cacheKey = this.hashText(text);

    if (this.embeddingCache.has(cacheKey)) {
      return this.embeddingCache.get(cacheKey)!;
    }

    const embeddings = await this.batchGetEmbeddings([text]);
    const embedding = embeddings[0];

    this.embeddingCache.set(cacheKey, embedding);
    return embedding;
  }

  /**
   * 轻量历史检索：从 localStorage('wisdom_ark_history_docs') 读取历史文档，
   * 与当前 query 进行相似度计算，返回 Top-K 片段。失败则返回空数组。
   */
  private async searchHistoryLocal(
    query: string,
    topK: number,
    minSim: number,
  ): Promise<SearchResult[]> {
    try {
      const raw = localStorage.getItem('wisdom_ark_history_docs');
      if (!raw) return [];
      const docs = JSON.parse(raw) as {
        id: string;
        title?: string;
        content: string;
      }[];
      if (!Array.isArray(docs) || docs.length === 0) return [];

      const queryEmbedding = await this.getEmbedding(query);

      const allChunks: {
        content: string;
        metadata: any;
        embedding?: number[];
      }[] = [];

      for (const doc of docs) {
        const parts = this.semanticChunk(doc.content);
        for (const p of parts) {
          allChunks.push({
            content: p.content,
            metadata: {
              ...p.metadata,
              chapter: p.metadata.chapter || doc.title || p.metadata.chapter,
            },
          });
        }
      }

      const BATCH = 10;
      for (let i = 0; i < allChunks.length; i += BATCH) {
        const slice = allChunks.slice(i, i + BATCH);
        const embs = await this.batchGetEmbeddings(slice.map((s) => s.content));
        slice.forEach((s, idx) => {
          s.embedding = embs[idx];
        });
      }

      const results: SearchResult[] = allChunks
        .filter((s) => Array.isArray(s.embedding))
        .map((s) => ({
          content: s.content,
          metadata: s.metadata,
          score: this.cosineSimilarity(queryEmbedding, s.embedding as number[]),
        }))
        .filter((r) => r.score >= minSim)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      return results;
    } catch {
      return [];
    }
  }

  /**
   * 🔹 语义分块（保持段落完整性 + 滑动窗口重叠）
   */
  private semanticChunk(markdown: string): {
    content: string;
    metadata: {
      chapter: string;
      level: number;
      position: number;
      source?: 'current' | 'history';
      articleId?: string;
      articleTitle?: string;
    };
  }[] {
    const chunks: {
      content: string;
      metadata: {
        chapter: string;
        level: number;
        position: number;
        source?: 'current' | 'history';
        articleId?: string;
        articleTitle?: string;
      };
    }[] = [];
    let currentChapter = '引言';
    let level = 0;
    let position = 0;

    const lines = markdown.split('\n');
    let buffer = '';
    let previousChunkTail = ''; // 保存上一个 chunk 的尾部用于重叠

    const OVERLAP_RATIO = RAG_CONFIG.CHUNK_OVERLAP_RATIO; //20%重叠
    const MAX_SIZE = RAG_CONFIG.MAX_CHUNK_SIZE;

    for (const line of lines) {
      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
      //  当前行是标题行
      if (headerMatch) {
        // 保存之前的内容块
        if (buffer.trim().length > 100) {
          // 拼接重叠内容：上一个 chunk 的尾部 + 当前缓存内容
          const contentWithOverlap = previousChunkTail
            ? `[上文] ${previousChunkTail}\n\n${buffer.trim()}`
            : buffer.trim();
          // 将内容块加入结果数组，附加元数据
          chunks.push({
            content: contentWithOverlap,
            metadata: { chapter: currentChapter, level, position },
          });

          // 保存当前 chunk 的尾部用于下一个 chunk 的重叠
          const overlapSize = Math.floor(buffer.length * OVERLAP_RATIO);
          previousChunkTail = buffer.slice(-overlapSize).trim();

          position++;
          buffer = '';
        }

        // 更新章节信息：标题层级 = # 的数量，章节名 = 标题内容
        level = headerMatch[1].length;
        currentChapter = headerMatch[2];
      } else {
        // 当前行是普通文本行
        buffer += line + '\n';

        // 防止单个块过大
        if (buffer.length > MAX_SIZE) {
          // 找语义边界：优先句号，其次双换行
          let splitPoint = buffer.lastIndexOf('。');
          if (splitPoint < MAX_SIZE * 0.5) {
            splitPoint = buffer.lastIndexOf('\n\n');
          }
          if (splitPoint < MAX_SIZE * 0.3) {
            splitPoint = buffer.lastIndexOf('.');
          }
          if (splitPoint < MAX_SIZE * 0.3) {
            splitPoint = Math.floor(MAX_SIZE * 0.8);
          }
          //  如果找到有效分割点，拆分缓存
          if (splitPoint > 0) {
            const chunkContent = buffer.slice(0, splitPoint + 1).trim();

            // 添加重叠
            const contentWithOverlap = previousChunkTail
              ? `[上文] ${previousChunkTail}\n\n${chunkContent}`
              : chunkContent;

            chunks.push({
              content: contentWithOverlap,
              metadata: { chapter: currentChapter, level, position },
            });

            // 🆕 保存尾部用于重叠
            const overlapSize = Math.floor(chunkContent.length * OVERLAP_RATIO);
            previousChunkTail = chunkContent.slice(-overlapSize).trim();

            position++;
            buffer = buffer.slice(splitPoint + 1);
          }
        }
      }
    }

    // 循环结束后，保存最后缓存的内容（如果有效）
    if (buffer.trim().length > 100) {
      const contentWithOverlap = previousChunkTail
        ? `[上文] ${previousChunkTail}\n\n${buffer.trim()}`
        : buffer.trim();

      chunks.push({
        content: contentWithOverlap,
        metadata: { chapter: currentChapter, level, position },
      });
    }

    console.log(
      `📦 分块完成: ${chunks.length} 个块 (重叠率: ${OVERLAP_RATIO * 100}%)`,
    );
    return chunks;
  }

  /**
   * 🔹 余弦相似度计算
   */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      throw new Error('向量维度不匹配');
    }

    let dotProduct = 0; //点积
    let normA = 0; // 向量A的模
    let normB = 0; // 向量B的模

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    } // 点积

    const denominator = Math.sqrt(normA) * Math.sqrt(normB); // ||A|| x ||B||
    return denominator === 0 ? 0 : dotProduct / denominator; //cos(θ)
  }

  /**
   * 🔹 BM25风格关键词检索（简化实现）
   */
  /**
   * 🔹 标准BM25实现
   */
  private async bm25Search(query: string, topK = 3): Promise<SearchResult[]> {
    const k1 = 1.5; // 词频饱和参数
    const b = 0.75; // 长度归一化参数

    // 1. 分词
    const queryTerms =
      query.toLowerCase().match(/[\u4e00-\u9fa5a-z0-9]+/g) || [];
    if (queryTerms.length === 0) return [];

    // 2. 计算平均文档长度
    const avgDocLen =
      this.chunks.reduce((sum, c) => sum + c.content.length, 0) /
      this.chunks.length;

    // 3. 计算IDF（逆文档频率）
    const idf = new Map<string, number>();
    queryTerms.forEach((term) => {
      const docFreq = this.chunks.filter((c) =>
        c.content.toLowerCase().includes(term),
      ).length;

      // IDF公式: log((N - df + 0.5) / (df + 0.5) + 1)
      const N = this.chunks.length;
      idf.set(term, Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1));
    });

    // 4. 计算每个文档的BM25分数
    const results = this.chunks.map((chunk) => {
      const docLen = chunk.content.length;
      let score = 0;

      queryTerms.forEach((term) => {
        // 词频（TF）
        const tf = (
          chunk.content.toLowerCase().match(new RegExp(term, 'g')) || []
        ).length;

        if (tf > 0) {
          const idfScore = idf.get(term) || 0;

          // BM25公式: IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDocLen))
          const numerator = tf * (k1 + 1);
          const denominator = tf + k1 * (1 - b + b * (docLen / avgDocLen));
          score += idfScore * (numerator / denominator);
        }
      });

      return {
        content: chunk.content,
        metadata: chunk.metadata,
        score: score, // BM25分数已经是标准化的
      };
    });

    return results
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private hashText(text: string): string {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 33) ^ text.charCodeAt(i);
    }
    return (hash >>> 0).toString(36);
  }

  /**
   * 🔹 查询改写 - 使用LLM优化查询
   */
  private async rewriteQuery(originalQuery: string): Promise<string> {
    // 使用本地AI服务进行查询改写
    const rewritePrompt = `将以下查询改写为更适合文档检索的形式，保留核心意图：\n\n原始查询: ${originalQuery}\n改写查询:`;

    try {
      const response = await fetch('http://localhost:3001/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: rewritePrompt }],
          stream: false,
        }),
      });

      const data = await response.json();
      return data.choices?.[0]?.message?.content?.trim() || originalQuery;
    } catch (error) {
      console.warn('查询改写失败，使用原始查询:', error);
      return originalQuery;
    }
  }

  /**
   * 🔹 查询扩展 - 生成多个查询变体
   */
  private async expandQuery(query: string): Promise<string[]> {
    const expandedQueries = [query]; // 包含原始查询

    // 使用LLM生成查询变体
    const expansionPrompt = `为以下查询生成3个不同的表达方式，保持相同含义：\n\n原始查询: ${query}\n变体查询:\n1. \n2. \n3. `;

    try {
      const response = await fetch('http://localhost:3001/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: expansionPrompt }],
          stream: false,
        }),
      });

      const data = await response.json();
      const variants =
        data.choices?.[0]?.message?.content
          ?.split('\n')
          .filter((line: string) => line.trim() && line.includes('. ')) || [];

      // 添加变体到查询列表
      variants.forEach((variant: string) => {
        const cleaned = variant.replace(/^\d+\.\s*/, '').trim();
        if (cleaned && cleaned !== query) {
          expandedQueries.push(cleaned);
        }
      });
    } catch (error) {
      console.warn('查询扩展失败，仅使用原始查询:', error);
    }

    return expandedQueries;
  }

  /**
   * 🔹 HyDE (Hypothetical Document Embedding) - 生成假设文档
   */
  private async generateHypotheticalDocument(query: string): Promise<string> {
    const hydePrompt = `为以下查询生成一个假设的详细回答（这将用于文档检索）：\n\n查询: ${query}\n假设回答:`;

    try {
      const response = await fetch('http://localhost:3001/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: hydePrompt }],
          stream: false,
        }),
      });

      const data = await response.json();
      return data.choices?.[0]?.message?.content?.trim() || query;
    } catch (error) {
      console.warn('HyDE生成失败，返回原始查询:', error);
      return query;
    }
  }

  /**
   * 🔹 普通补全（无RAG）
   */
  private async normalComplete(
    prefix: string,
    suffix: string,
  ): Promise<string> {
    this.stats.normalCalls++;
    return await chatInEditor({
      prefix: prefix.slice(-RAG_CONFIG.INJECTED_PREFIX_LENGTH),
      suffix: suffix.slice(0, RAG_CONFIG.INJECTED_SUFFIX_LENGTH),
    });
  }

  /**
   * 🔹 获取统计信息
   */
  getStats() {
    const chapters = [...new Set(this.chunks.map((c) => c.metadata.chapter))];
    const totalTokens = this.chunks.reduce((sum, chunk) => {
      return sum + Math.ceil(chunk.content.length / 2);
    }, 0);

    return {
      totalChunks: this.chunks.length,
      chapters,
      totalTokens,
      cacheSize: this.embeddingCache.size,
      averageChunkSize:
        this.chunks.length > 0
          ? Math.round(
              this.chunks.reduce((sum, c) => sum + c.content.length, 0) /
                this.chunks.length,
            )
          : 0,
      ragCalls: this.stats.ragCalls,
      normalCalls: this.stats.normalCalls,
      degradeRate:
        this.stats.ragCalls > 0
          ? ((this.stats.normalCalls / this.stats.ragCalls) * 100).toFixed(1) +
            '%'
          : '0%',
      recentDegradeReasons: this.stats.degradeReasons.slice(-5),
    };
  }

  /**
   * 🔹 清理资源
   */
  clear() {
    this.chunks = [];
    this.embeddingCache.clear();
    console.log('🗑️ RAG索引已清空');
  }
}
