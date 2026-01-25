// utils/hybridFIMService.ts
import { chatInEditor, chatRaw } from './openAi';
import { InferenceClient } from '@huggingface/inference';

export interface FIMOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  useRealFIM?: boolean;
  fallbackOnError?: boolean;
  fimModel?: string; // 优先使用的FIM模型
}

export class HybridFIMService {
  private hf: InferenceClient | null = null; //创建并管理 HuggingFace 推理请求的客户端实例
  private cache = new Map<string, string>(); //作为缓存，存储 FIM 结果以提升重复请求的响应速度.
  private maxCacheSize = 100;
  private fimModel: string; //作为默认 FIM 模型标识，供真实/提示 FIM 调用时选择使用
  private performanceStats = {
    realFIMCalls: 0, //记录使用真实 FIM 模型的调用次数
    promptFIMCalls: 0, //记录使用提示 FIM 模型的调用次数
    realFIMSuccess: 0, //记录使用真实 FIM 模型的成功次数
    promptFIMSuccess: 0, //记录使用提示 FIM 模型的成功次数
    averageRealFIMTime: 0, //记录使用真实 FIM 模型的平均响应时间
    averagePromptFIMTime: 0, //记录使用提示 FIM 模型的平均响应时间
  }; //性能记录

  constructor(hfApiKey?: string) {
    // 优先使用传入的API Key，否则使用环境变量

    const apiKey = hfApiKey || import.meta.env.VITE_HUGGINGFACE_TOKEN;

    // this.fimModel =
    //   import.meta.env.REACT_APP_HF_FIM_MODEL || 'bigcode/starcoder';
    this.fimModel = 'Qwen/Qwen2.5-Coder-7B-Instruct';
    if (apiKey) {
      this.hf = new InferenceClient(apiKey);
      console.log('Hugging Face API Key 已设置');
    } else {
      console.warn('Hugging Face API Key 未设置，将使用备用方案');
    }
  }

  // 智能FIM补全
  async fillInMiddle(prefix: string, suffix: string, options: FIMOptions = {}) {
    const {
      maxTokens = 100,
      temperature = 0.7,
      topP = 0.9,
      useRealFIM = true,
      fallbackOnError = true,
    } = options;

    // 缓存检查
    const cacheKey = `${prefix.slice(-30)}_${suffix.slice(0, 30)}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    let result: string;
    const startTime = Date.now();

    try {
      if (useRealFIM) {
        result = await chatInEditor({ prefix, suffix });

        this.performanceStats.realFIMCalls++;
        this.performanceStats.realFIMSuccess++;
        this.performanceStats.averageRealFIMTime =
          (this.performanceStats.averageRealFIMTime +
            (Date.now() - startTime)) /
          2;
      } else {
        throw new Error('Real FIM not available');
      }
    } catch (error) {
      console.warn('Real FIM failed, using prompt fallback:', error);

      if (fallbackOnError) {
        result = await this.promptFIMFillIn(prefix, suffix);
        this.performanceStats.promptFIMCalls++;
        this.performanceStats.promptFIMSuccess++;
        this.performanceStats.averagePromptFIMTime =
          (this.performanceStats.averagePromptFIMTime +
            (Date.now() - startTime)) /
          2;
      } else {
        throw error;
      }
    }

    // 缓存管理
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(cacheKey, result);

    return result;
  }

  // 真实FIM模型调用
  private async realFIMFillIn(
    prefix: string,
    suffix: string,
    options: {
      maxTokens: number;
      temperature: number;
      topP: number;
      fimModel?: string;
    },
  ) {
    if (!this.hf) throw new Error('Hugging Face client not initialized');
    const modelToUse = options.fimModel || this.fimModel;
    const fimPrefix = '<|fim_prefix|>';
    const fimSuffix = '<|fim_suffix|>';
    const fimMiddle = '<|fim_middle|>';

    try {
      const result = await this.hf.textGeneration({
        model: 'Qwen/Qwen2.5-Coder-7B-Instruct',
        inputs: `${fimPrefix}${prefix}${fimSuffix}${suffix}${fimMiddle}`,
        parameters: {
          max_new_tokens: options.maxTokens,
          temperature: options.temperature,
          top_p: options.topP,
          do_sample: true,
          return_full_text: false,
        },
      });
      console.log('FIM result', result.generated_text);

      return result.generated_text;
    } catch (error) {
      console.error('FIM failed:', error);

      throw error;
    }
  }

  // Prompt FIM备用方案
  private async promptFIMFillIn(prefix: string, suffix: string) {
    const prompt = `
        你是一个专业的文本编辑助手，专门处理Fill-in-the-Middle任务。

        **任务：** 在以下文本的中间位置插入合适的内容

        **前缀：** ${prefix}
        **后缀：** ${suffix}

        **要求：**
        1. 分析前缀的结尾部分，理解其表达的内容和情感
        2. 分析后缀的开头部分，理解其想要表达的内容
        3. 在两者之间插入自然过渡的内容
        4. 确保插入内容与前后文风格一致
        5. 保持逻辑连贯性

        请直接返回插入的内容，不要包含前后缀。
`;

    // const response = await chatInEditor({ prefix, suffix });
    const response = await chatRaw([{ role: 'user', content: prompt }]);
    console.log('通义response', response);

    return response;
  }

  // 智能改错
  async correctText(content: string, options: FIMOptions = {}) {
    const prompt = `
        你是一个专业的文本编辑专家，擅长文本修正和优化。

        **原文：** ${content}

        **任务要求：**
        1. 检查语法、拼写、标点符号错误
        2. 修正表达不清晰的地方
        3. 优化语言表达，提升可读性
        4. 保持原文核心意思不变
        5. 在合适位置插入改进内容

        请返回完整的修正后文本。
`;

    try {
      const response = await chatRaw([{ role: 'user', content: prompt }]);
      return response;
    } catch (error) {
      console.error('文本改错失败:', error);
      throw error;
    }
  }

  // 智能扩写
  async expandText(content: string, targetLength?: number) {
    const prompt = `
      你是一个专业的写作助手，擅长文本扩写和优化  偏向于写技术文。

      **原文：** ${content}
      ${targetLength ? `**目标长度：** 约${targetLength}字` : '**目标：** 适当扩写'}

      **任务要求：**
      1. 在文本中间插入专业的描述,若是专业性语言 则保持原文风格，若是文科类 则使用优雅的修辞，
      2. 保持原文逻辑结构
      3. 确保内容自然流畅
      4. 不要重复已有内容
      5. 使用markdown格式输出
      6. 用来直接插入文本中,不要包含原文
      7. 不要语义不连贯 可直接衔接原文
      请返回完整的扩写后文本。
      `;

    try {
      const response = await chatRaw([{ role: 'user', content: prompt }]);
      console.log(response, '智能扩写response');

      return response;
    } catch (error) {
      console.error('文本扩写失败:', error);
      throw error;
    }
  }

  // 获取性能统计
  getPerformanceStats() {
    return {
      ...this.performanceStats,
      realFIMSuccessRate:
        this.performanceStats.realFIMCalls > 0
          ? this.performanceStats.realFIMSuccess /
            this.performanceStats.realFIMCalls
          : 0,
      promptFIMSuccessRate:
        this.performanceStats.promptFIMCalls > 0
          ? this.performanceStats.promptFIMSuccess /
            this.performanceStats.promptFIMCalls
          : 0,
    };
  }

  // 清理缓存
  clearCache() {
    this.cache.clear();
  }

  // 配置/读取默认FIM模型
  setFimModel(model: string) {
    this.fimModel = model;
  }
  getFimModel() {
    return this.fimModel;
  }
}
