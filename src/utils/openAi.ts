import OpenAI from 'openai';
import toolsMap from './aiTools';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ================== AI 服务配置 =================
interface AIServiceConfig {
  id: string;
  name: string;
  priority: number;
  client: OpenAI;
  model: string;
  status: 'online' | 'offline' | 'checking';
  responseTime: number | null;
  consecutiveFailures: number;
  lastCheck: Date | null;
  lastSuccess: Date | null;
}

const AI_SERVICES: AIServiceConfig[] = [
  {
    id: 'primary',
    name: 'ChatAnywhere (主服务)',
    priority: 1,
    client: new OpenAI({
      apiKey: 'sk-MhhXBfjcOEJb5eOOjBb0bn8P0qcLaQFE0sVOZTCb5OradbEd',
      baseURL: 'https://api.chatanywhere.tech/v1',
      dangerouslyAllowBrowser: true,
    }),
    model: 'gpt-5-mini',
    status: 'checking',
    responseTime: null,
    consecutiveFailures: 0,
    lastCheck: null,
    lastSuccess: null,
  },
  {
    id: 'backup1',
    name: 'OpenAI Direct (备用)',
    priority: 2,
    client: new OpenAI({
      //   apiKey: '0f513bc89a482ed8fe9d4b6369eac7d8',
      //   baseURL: 'https://spark-api-open.xf-yun.com/v2/chat/completions',
      apiKey: 'sk-MhhXBfjcOEJb5eOOjBb0bn8P0qcLaQFE0sVOZTCb5OradbEd',
      baseURL: 'https://api.chatanywhere.tech/v1',
      dangerouslyAllowBrowser: true,
    }),
    model: 'gpt-4o-mini',
    status: 'checking',
    responseTime: null,
    consecutiveFailures: 0,
    lastCheck: null,
    lastSuccess: null,
  },
  // {
  //   id: 'backup2',
  //   name: 'deepseek',
  //   priority: 3,
  //   client: new OpenAI({
  //     apiKey: 'sk-529ce6e9488446a59323d1950ea1dc8a',
  //     baseURL: 'https://api.deepseek.com',
  //     dangerouslyAllowBrowser: true,
  //   }),
  //   model: 'gpt-4o-mini',
  //   status: 'checking',
  //   responseTime: null,
  //   consecutiveFailures: 0,
  //   lastCheck: null,
  //   lastSuccess: null,
  // },
];

// ==================== 服务管理器 ====================
class AIServiceManager {
  private services: AIServiceConfig[];
  private currentService: AIServiceConfig | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private onServiceChangeCallback?: (service: AIServiceConfig) => void;

  constructor(services: AIServiceConfig[]) {
    this.services = services.sort((a, b) => a.priority - b.priority);
    this.selectBestService();
  }

  // 启动健康检查
  startHealthCheck(interval = 30000) {
    this.performHealthCheck();
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, interval);
  }

  // 停止健康检查
  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  // 执行健康检查
  async performHealthCheck() {
    const checkPromises = this.services.map(async (service) => {
      try {
        const startTime = Date.now();

        // 简单的模型列表检查作为健康检查
        await service.client.models.list();

        const responseTime = Date.now() - startTime;
        service.status = 'online';
        service.responseTime = responseTime;
        service.lastCheck = new Date();
        service.consecutiveFailures = 0;

        console.log(`✅ ${service.name} 健康检查通过 (${responseTime}ms)`);
      } catch (error) {
        service.status = 'offline';
        service.consecutiveFailures += 1;
        service.lastCheck = new Date();
        console.error(`❌ ${service.name} 健康检查失败:`, error);
      }
    });

    await Promise.allSettled(checkPromises);
    this.selectBestService();
  }

  // 选择最佳服务
  selectBestService() {
    const availableServices = this.services.filter(
      (s) => s.status === 'online',
    );

    if (availableServices.length === 0) {
      console.warn('⚠️ 没有可用的 AI 服务');
      this.currentService = null;
      return null;
    }

    // 选择优先级最高且响应最快的服务
    const bestService = availableServices.reduce((best, current) => {
      if (current.priority < best.priority) return current;
      if (
        current.priority === best.priority &&
        (current.responseTime || 0) < (best.responseTime || 0)
      ) {
        return current;
      }
      return best;
    });

    if (!this.currentService || this.currentService.id !== bestService.id) {
      console.log(`🔄 切换到服务: ${bestService.name}`);
      this.currentService = bestService;
      this.onServiceChangeCallback?.(bestService);
    }

    return bestService;
  }

  // 获取当前服务
  getCurrentService(): AIServiceConfig | null {
    return this.currentService;
  }

  // 标记服务失败
  markServiceFailure(serviceId: string) {
    const service = this.services.find((s) => s.id === serviceId);
    if (service) {
      service.consecutiveFailures += 1;

      // 连续失败3次标记为离线
      if (service.consecutiveFailures >= 3) {
        service.status = 'offline';
        console.warn(
          `⚠️ ${service.name} 被标记为离线 (连续失败${service.consecutiveFailures}次)`,
        );
        this.selectBestService();
      }
    }
  }

  // 标记服务成功
  markServiceSuccess(serviceId: string) {
    const service = this.services.find((s) => s.id === serviceId);
    if (service) {
      service.consecutiveFailures = 0;
      service.lastSuccess = new Date();
      if (service.status === 'offline') {
        service.status = 'online';
        this.selectBestService();
      }
    }
  }

  // 获取所有服务状态
  getServicesStatus() {
    return this.services.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      priority: s.priority,
      responseTime: s.responseTime,
      consecutiveFailures: s.consecutiveFailures,
      lastCheck: s.lastCheck,
      lastSuccess: s.lastSuccess,
    }));
  }

  // 设置服务变更回调
  onServiceChange(callback: (service: AIServiceConfig) => void) {
    this.onServiceChangeCallback = callback;
  }
}

// 初始化服务管理器
const aiServiceManager = new AIServiceManager(AI_SERVICES);

// 启动健康检查（每30秒）
aiServiceManager.startHealthCheck(60000 * 60 * 24);

// 监听服务切换
aiServiceManager.onServiceChange((service) => {
  console.log(`📡 当前使用服务: ${service.name}`);
});

// 初始化客户端（Key 硬编码仅用于测试，生产环境必须移除！）
// const openai = new OpenAI({
//   apiKey: 'sk-MhhXBfjcOEJb5eOOjBb0bn8P0qcLaQFE0sVOZTCb5OradbEd', // 替换为你的实际 Key
//   baseURL: 'https://api.chatanywhere.tech/v1',
//   dangerouslyAllowBrowser: true, // 明确允许浏览器环境（仅限开发）
// });

const tools = Array.from(toolsMap.values()).map(({ fun, ...item }) => {
  const jsonSchema = zodToJsonSchema(item.function.parameters);
  return {
    type: item.type,
    function: {
      name: item.function.name,
      description: item.function.description,
      parameters: {
        type: 'object',
        properties: jsonSchema.properties,
        required: jsonSchema.required,
      },
    },
  };
});

// 对话函数
export const chatWithGPT = async (
  messages: any,
  onChunk?: (chunk: string) => void, // 回调函数，用于处理每个数据块
  onComplete?: (fullResponse: string) => void, // 完成时的回调
  onError?: (error: any) => void, // 错误处理回调
  onServiceSwitch?: (serviceName: string) => void, // 新增：服务切换回调
) => {
  const externalContent =
    '智汇云舟（Wisdom Ark）是一个便于用户查询、学习、使用的前端知识库';
  const recentMessages = messages.slice(-5);
  const newMessages = [
    {
      role: 'system',
      content: `
        ## 角色
        你是一个专业的前端导师，你最擅长React、Webpack、Antd这些前端框架，你能够由浅入深的回答用户关于前端的问题
        ## 参考内容
        ${externalContent}
        ## 输出规范
        - 关于代码问题，你能够按照"设计思路"、"代码实现"两个维度来回答
        - 跟编程无关的问题你可以拒绝回答
        `,
    },
    ...recentMessages,
  ];

  // 尝试所有可用AI
  const attemptedServices = new Set<string>();
  let lastError: any = null;

  while (true) {
    const currentService = aiServiceManager.getCurrentService();

    if (!currentService) {
      const error = new Error('所有 AI 服务都不可用，请稍后再试');
      onError?.(error);
      throw error;
    }

    // 避免重复尝试同一服务
    if (attemptedServices.has(currentService.id)) {
      break;
    }
    attemptedServices.add(currentService.id);
    try {
      console.log(`🚀 使用 ${currentService.name} 发送请求...`);
      onServiceSwitch?.(currentService.name);

      const response = await currentService.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: newMessages,
        stream: true, // 启用流式响应
        temperature: 0.7,
        tools: tools as any,
      });

      let fullResponse = '';
      const toolCalls: any[] = [];

      // 处理流式数据
      for await (const chunk of response) {
        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          // 普通文本内容
          const content = delta.content;
          fullResponse += content;
          // 实时回调，用于UI更新
          onChunk?.(content);
        }

        if (delta?.tool_calls) {
          // 处理工具调用（流式模式下工具调用可能分多个chunk）
          delta.tool_calls.forEach((toolCall: any, index: number) => {
            if (!toolCalls[index]) {
              toolCalls[index] = {
                id: toolCall.id,
                type: toolCall.type,
                function: { name: '', arguments: '' },
              };
            }

            if (toolCall.function?.name) {
              toolCalls[index].function.name += toolCall.function.name;
            }

            if (toolCall.function?.arguments) {
              toolCalls[index].function.arguments +=
                toolCall.function.arguments;
            }
          });
        }

        // 检查是否完成
        if (
          chunk.choices[0]?.finish_reason === 'stop' ||
          chunk.choices[0]?.finish_reason === 'tool_calls'
        ) {
          break;
        }
      }

      // 如果有工具调用，处理工具调用
      if (toolCalls.length > 0) {
        const toolResponses = await Promise.all(
          toolCalls.map(async (toolCall) => {
            const toolId = toolCall.id;
            if (!toolId) {
              return {
                role: 'tool',
                content: '未找到对应工具',
                tool_call_id: toolId,
              };
            }

            const functionName = toolCall.function.name;
            const tool = toolsMap.get(functionName);

            if (tool) {
              try {
                const args = JSON.parse(toolCall.function.arguments);
                const result = await tool.fun(args);

                return {
                  role: 'tool',
                  content:
                    typeof result === 'string'
                      ? result
                      : JSON.stringify(result),
                  tool_call_id: toolId,
                };
              } catch (error) {
                console.error('工具执行失败:', error);
                return {
                  role: 'tool',
                  content: '工具执行失败',
                  tool_call_id: toolId,
                };
              }
            } else {
              return {
                role: 'tool',
                content: '未找到对应工具',
                tool_call_id: toolId,
              };
            }
          }),
        );

        const toolResult = JSON.parse(toolResponses[0].content).content;
        onComplete?.(toolResult);
        return toolResult;
      }

      // 标记服务成功
      aiServiceManager.markServiceSuccess(currentService.id);

      onComplete?.(fullResponse);
      return fullResponse;
    } catch (error) {
      //   console.error('OpenAI API Error:', error);
      //   return '发生错误，请重试';
      lastError = error;
      console.error(`❌ ${currentService.name} 请求失败:`, error);

      // 标记服务失败
      aiServiceManager.markServiceFailure(currentService.id);

      // 尝试切换到下一个服务
      const nextService = aiServiceManager.selectBestService();

      if (!nextService || attemptedServices.has(nextService.id)) {
        // 没有更多可用服务
        break;
      }

      console.log(`🔄 自动切换到备用服务: ${nextService.name}`);
      await new Promise((resolve) => setTimeout(resolve, 1000)); // 等待1秒后重试
    }
  }
  // 所有服务都失败了
  const error = lastError || new Error('所有 AI 服务都失败了');
  onError?.(error);
  return '发生错误，所有 AI 服务暂时不可用，请稍后重试';
};

// ==================== 无限制对话函数（不添加系统约束、不使用工具） ====================
export interface ChatRawOptions {
  model?: string;
  temperature?: number;
  stream?: boolean;
  onChunk?: (chunk: string) => void;
  onComplete?: (fullResponse: string) => void;
  onError?: (error: any) => void;
  onServiceSwitch?: (serviceName: string) => void;
}

export const chatRaw = async (
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  options: ChatRawOptions = {},
) => {
  const {
    model,
    temperature = 0.7,
    stream = false,
    onChunk,
    onComplete,
    onError,
    onServiceSwitch,
  } = options;

  const attempted = new Set<string>();
  let lastErr: any = null;

  while (true) {
    const svc = aiServiceManager.getCurrentService();
    if (!svc) {
      const err = new Error('所有 AI 服务都不可用');
      onError?.(err);
      throw err;
    }
    if (attempted.has(svc.id)) break;
    attempted.add(svc.id);

    try {
      onServiceSwitch?.(svc.name);
      const usedModel = model || svc.model || 'gpt-4o-mini';

      // 非流式
      if (!stream) {
        const res = await svc.client.chat.completions.create({
          model: usedModel,
          messages,
          temperature,
        });
        const content = res.choices?.[0]?.message?.content || '';
        console.log(content, 'chatRaw');

        aiServiceManager.markServiceSuccess(svc.id);
        onComplete?.(content);
        return content;
      }

      // 流式
      const res = await svc.client.chat.completions.create({
        model: usedModel,
        messages,
        temperature,
        stream: true,
      });

      let full = '';
      for await (const chunk of res) {
        const delta = chunk.choices?.[0]?.delta;
        const txt = delta?.content || '';
        if (txt) {
          full += txt;
          onChunk?.(txt);
        }
        if (chunk.choices?.[0]?.finish_reason) break;
      }
      aiServiceManager.markServiceSuccess(svc.id);
      onComplete?.(full);
      return full;
    } catch (e) {
      lastErr = e;
      aiServiceManager.markServiceFailure(svc.id);
      const next = aiServiceManager.selectBestService();
      if (!next || attempted.has(next.id)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  onError?.(lastErr);
  return '';
};

export const chatInEditor = async (content: {
  prefix: string;
  suffix: string;
  temperature?: number;
}) => {
  const { prefix, suffix, temperature } = content;
  console.log('RAG 检索增强----');
  console.log(prefix, 'prefix');
  console.log(suffix, 'suffix');

  const client = new OpenAI({
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-da6f76fe6f8e4bc2871be0c57ffa3201',
    dangerouslyAllowBrowser: true,
  });

  const completion = await client.completions.create({
    model: 'qwen-coder-turbo',
    prompt: `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
    max_tokens: 1024,
    temperature: typeof temperature === 'number' ? temperature : 0.7,
  });
  console.log(completion, 'completion');
  console.log(completion.choices[0], 'completion.choices[0]');

  return completion.choices[0].text;

  return `
   let timer = null;
 return function (fn, time) {
   if(timer){
     clearTimeout(timer);
   }
   timer = setTimeout(() => {
     fn.apply(this, arguments);
   },time)
 }  
}

// 调用
const debouncedScrollHandler = debounce(function() {
  console.log('滚动事件触发');
}, 300);

window.addEventListener('scroll', debouncedScrollHandler);`;
};
