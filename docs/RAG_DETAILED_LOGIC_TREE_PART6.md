# RAG 检索增强生成系统 - 超详细逻辑结构树 (Part 6: 证据构建与 AI 生成)

## 续 Part 5...

````
├─ 14. 构建证据和生成 (续 ragComplete 方法)
│  │
│  ├─ 14.1 检测文档类型
│  │  │
│  │  └─ const docType = detectDocTypeForRAG(
│  │       `${prefix.slice(-500)} ${suffix.slice(0, 200)}`
│  │     )
│  │     │
│  │     └─ 14.1.1 detectDocTypeForRAG(text)
│  │        │
│  │        ├─ const sample = (text || '').slice(0, 5000)
│  │        │  └─ 取前 5000 字符作为样本
│  │        │
│  │        ├─ 统计代码块
│  │        │  │
│  │        │  ├─ const codeBlockMatches = sample.match(/```[\s\S]*?```/g) || []
│  │        │  │  └─ 匹配所有代码块
│  │        │  │
│  │        │  ├─ const codeBlockChars = codeBlockMatches.join('').length
│  │        │  │  └─ 计算代码块总字符数
│  │        │  │
│  │        │  └─ const codeRatio = sample.length > 0
│  │        │       ? codeBlockChars / sample.length
│  │        │       : 0
│  │        │     └─ 代码占比 = 代码字符数 / 总字符数
│  │        │
│  │        ├─ 统计技术词汇密度
│  │        │  │
│  │        │  ├─ const technicalWords = sample.match(
│  │        │  │    /\bAPI\b|\bHTTP\b|\bCLI\b|配置|安装|版本|性能|算法|复杂度/g
│  │        │  │  ) || []
│  │        │  │  └─ 匹配技术关键词
│  │        │  │
│  │        │  └─ const technicalDensity =
│  │        │       technicalWords.length / (sample.length / 100)
│  │        │     └─ 技术词汇密度 = 关键词数 / 每100字符
│  │        │
│  │        └─ 判断主要类型
│  │           │
│  │           ├─ if (codeRatio > 0.3) {
│  │           │    return { primary: 'code', codeRatio }
│  │           │  }
│  │           │  └─ 代码占比 > 30%，判定为代码文档
│  │           │
│  │           ├─ if (technicalDensity > 3) {
│  │           │    return { primary: 'technical', codeRatio }
│  │           │  }
│  │           │  └─ 技术词汇密度 > 3，判定为技术文档
│  │           │
│  │           └─ return { primary: 'literary', codeRatio }
│  │              └─ 否则判定为文学/普通文档
│  │
│  ├─ 14.2 计算 Token 预算
│  │  │
│  │  ├─ const estimateTokens = (text: string) => Math.ceil(text.length / 2)
│  │  │  └─ Token 估算函数：字符数 / 2
│  │  │
│  │  ├─ const maxInputTokens =
│  │  │    RAG_CONFIG.MAX_CONTEXT_TOKENS - RAG_CONFIG.RESERVED_FOR_OUTPUT
│  │  │  │
│  │  │  ├─ MAX_CONTEXT_TOKENS = 3000
│  │  │  ├─ RESERVED_FOR_OUTPUT = 1024
│  │  │  └─ maxInputTokens = 3000 - 1024 = 1976
│  │  │
│  │  ├─ const styleGuide = this.buildStyleGuide(docType.primary)
│  │  │  │
│  │  │  └─ 14.2.1 buildStyleGuide(docType)
│  │  │     │
│  │  │     ├─ const guides = {
│  │  │     │    code: '[STYLE]\nType: code\n' +
│  │  │     │          'Instructions: Continue the code precisely; ' +
│  │  │     │          'keep language and style; avoid explanations; ' +
│  │  │     │          'maintain indentation; use the same programming language.',
│  │  │     │
│  │  │     │    technical: '[STYLE]\nType: technical\n' +
│  │  │     │               'Instructions: Be concise and precise; ' +
│  │  │     │               'keep markdown structure; keep terminology consistent; ' +
│  │  │     │               'prefer bullet points when appropriate; ' +
│  │  │     │               'avoid generic filler.',
│  │  │     │
│  │  │     │    literary: '[STYLE]\nType: literary\n' +
│  │  │     │              'Instructions: Keep tone consistent; ' +
│  │  │     │              'ensure smooth transitions; ' +
│  │  │     │              'use natural and expressive language as context indicates.'
│  │  │     │  }
│  │  │     │
│  │  │     └─ return guides[docType]
│  │  │
│  │  ├─ const styleGuideTokens = estimateTokens(styleGuide)
│  │  │
│  │  ├─ const availableTokens = maxInputTokens - styleGuideTokens
│  │  │  └─ 可用 Token = 最大输入 - 风格指南
│  │  │
│  │  ├─ const evidenceTokenBudget = Math.floor(
│  │  │    availableTokens * RAG_CONFIG.EVIDENCE_TOKEN_RATIO
│  │  │  )
│  │  │  │
│  │  │  ├─ EVIDENCE_TOKEN_RATIO = 0.2
│  │  │  └─ 检索结果预算 = 可用 Token × 20%
│  │  │
│  │  └─ const contextTokenBudget = Math.floor(
│  │       availableTokens * RAG_CONFIG.CONTEXT_TOKEN_RATIO
│  │     )
│  │     │
│  │     ├─ CONTEXT_TOKEN_RATIO = 0.8
│  │     └─ 上下文预算 = 可用 Token × 80%
│  │
│  ├─ 14.3 构建证据
│  │  │
│  │  ├─ const evidencePerChunk = Math.floor(
│  │  │    (evidenceTokenBudget / finalResults.length) * 2
│  │  │  )
│  │  │  └─ 每个分块的字符数 = (Token预算 / 结果数) × 2
│  │  │
│  │  └─ const evidence = finalResults
│  │       .map((r, idx) => {
│  │         │
│  │         ├─ const source = r.source
│  │         │    ? ` [${r.source === 'history' ? '历史' : '当前'}]`
│  │         │    : ''
│  │         │  └─ 标记来源
│  │         │
│  │         ├─ const title = `${idx + 1}. ${r.metadata.chapter}${source}`
│  │         │  └─ 格式：序号. 章节名 [来源]
│  │         │
│  │         ├─ const snippet = r.content.slice(
│  │         │    0,
│  │         │    Math.max(100, evidencePerChunk)
│  │         │  )
│  │         │  └─ 截取内容片段，至少100字符
│  │         │
│  │         └─ return `${title} (${(r.score * 100).toFixed(0)}%)\n${snippet}`
│  │       })
│  │       .join('\n\n')
│  │     │
│  │     └─ 格式示例:
│  │        1. React 性能优化 [当前] (85%)
│  │        React.memo 可以优化组件性能，避免不必要的重渲染...
│  │
│  │        2. 虚拟化技术 [当前] (72%)
│  │        使用虚拟滚动可以处理大量数据...
│  │
│  ├─ 14.4 动态调整上下文长度
│  │  │
│  │  ├─ const contextChars = contextTokenBudget * 2
│  │  │  └─ 上下文字符数 = Token预算 × 2
│  │  │
│  │  ├─ const prefixChars = Math.floor(contextChars * 0.7)
│  │  │  └─ 前文字符数 = 总字符数 × 70%
│  │  │
│  │  └─ const suffixChars = Math.floor(contextChars * 0.3)
│  │     └─ 后文字符数 = 总字符数 × 30%
│  │
│  ├─ 14.5 构建最终 Prompt
│  │  │
│  │  ├─ const injectedPrefix =
│  │  │    `${styleGuide}\n\n[参考片段]\n${evidence}\n\n${prefix.slice(-prefixChars)}`
│  │  │  │
│  │  │  └─ 格式:
│  │  │     [STYLE]
│  │  │     Type: technical
│  │  │     Instructions: ...
│  │  │
│  │  │     [参考片段]
│  │  │     1. React 性能优化 [当前] (85%)
│  │  │     React.memo 可以优化组件性能...
│  │  │
│  │  │     2. 虚拟化技术 [当前] (72%)
│  │  │     使用虚拟滚动可以处理大量数据...
│  │  │
│  │  │     [当前文档的前文]
│  │  │     ...光标前的内容...
│  │  │
│  │  └─ const injectedSuffix = suffix.slice(0, suffixChars)
│  │     └─ 光标后的内容
│  │
│  ├─ 14.6 调整温度参数
│  │  │
│  │  ├─ let temperature = 0.7  // 默认值
│  │  │
│  │  ├─ if (docType.primary === 'code') {
│  │  │    temperature = 0.2
│  │  │  }
│  │  │  └─ 代码文档：低温度，精确生成
│  │  │
│  │  ├─ else if (docType.primary === 'technical') {
│  │  │    temperature = docType.codeRatio > 0.1 ? 0.3 : 0.4
│  │  │  }
│  │  │  └─ 技术文档：中等温度，根据代码占比调整
│  │  │
│  │  └─ else {
│  │       temperature = 0.8
│  │     }
│  │     └─ 普通文档：高温度，更有创意
│  │
│  ├─ 14.7 调试输出
│  │  │
│  │  └─ if (showContext) {
│  │       ├─ console.log('🧩 RAG.ragComplete 调试')
│  │       ├─ console.log(' - query:', query.slice(0, 300))
│  │       ├─ console.log(' - 文档类型:', docType.primary,
│  │       │    `(代码占比: ${(docType.codeRatio * 100).toFixed(1)}%)`)
│  │       ├─ console.log(' - 命中片段数:', finalResults.length)
│  │       ├─ finalResults.forEach((r, i) => {
│  │       │    const source = r.source ? ` [${r.source}]` : ''
│  │       │    console.log(
│  │       │      `   ${i + 1}. ${r.metadata.chapter}${source} - ` +
│  │       │      `${(r.score * 100).toFixed(1)}% (${r.content.length}字)`
│  │       │    )
│  │       │  })
│  │       ├─ console.log(' - Token 预估:')
│  │       ├─ console.log(`   - Style Guide: ${styleGuideTokens}`)
│  │       ├─ console.log(`   - Evidence: ${estimateTokens(evidence)}`)
│  │       ├─ console.log(`   - Context: ${estimateTokens(injectedPrefix + injectedSuffix)}`)
│  │       └─ console.log(' - Temperature:', temperature)
│  │     }
│  │
│  ├─ 14.8 调用 AI 生成
│  │  │
│  │  └─ try {
│  │       │
│  │       ├─ const result = await chatInEditor({
│  │       │    prefix: injectedPrefix,
│  │       │    suffix: injectedSuffix,
│  │       │    temperature
│  │       │  })
│  │       │  │
│  │       │  └─ 14.8.1 chatInEditor(options)
│  │       │     │
│  │       │     ├─ const response = await fetch('http://localhost:3001/api/chat', {
│  │       │     │    method: 'POST',
│  │       │     │    headers: { 'Content-Type': 'application/json' },
│  │       │     │    body: JSON.stringify({
│  │       │     │      messages: [
│  │       │     │        {
│  │       │     │          role: 'system',
│  │       │     │          content: 'You are a helpful writing assistant. ' +
│  │       │     │                   'Continue the text naturally based on context.'
│  │       │     │        },
│  │       │     │        {
│  │       │     │          role: 'user',
│  │       │     │          content: `${options.prefix}<|CURSOR|>${options.suffix}`
│  │       │     │        }
│  │       │     │      ],
│  │       │     │      stream: false,
│  │       │     │      temperature: options.temperature,
│  │       │     │      max_tokens: 500
│  │       │     │    })
│  │       │     │  })
│  │       │     │
│  │       │     ├─ const data = await response.json()
│  │       │     │
│  │       │     └─ return data.choices?.[0]?.message?.content || ''
│  │       │
│  │       ├─ if (showContext) {
│  │       │    console.log('✅ RAG 生成成功:', result.slice(0, 100) + '...')
│  │       │  }
│  │       │
│  │       └─ return result
│  │
│  └─ 14.9 异常处理
│     │
│     └─ } catch (error) {
│          │
│          ├─ const reason = `生成失败: ${
│          │    error instanceof Error ? error.message : String(error)
│          │  }`
│          │
│          ├─ this.stats.degradeReasons.push(reason)
│          │
│          ├─ console.error('❌ RAG 生成失败，降级到普通补全', error)
│          │
│          └─ return this.normalComplete(prefix, suffix)
│             │
│             └─ 14.9.1 normalComplete(prefix, suffix)
│                │
│                ├─ this.stats.normalCalls++
│                │  └─ 统计普通补全次数
│                │
│                └─ return chatInEditor({
│                     prefix: prefix.slice(-1000),
│                     suffix: suffix.slice(0, 500),
│                     temperature: 0.7
│                   })
│                   └─ 不使用 RAG，直接基于前后文生成
│
│
├─────────────────────────────────────────────────────────────────
│ 【第四层】结果展示与用户交互
├─────────────────────────────────────────────────────────────────
│
├─ 15. 显示 AI 建议 [draft.tsx]
│  │
│  ├─ 15.1 通过事件总线发送建议
│  │  │
│  │  └─ AISuggestionBus.getInstance().show({
│  │       id: `rag-${Date.now()}`,
│  │       text: result,
│  │       mode: 'insert',
│  │       position: from
│  │     })
│  │     │
│  │     └─ 15.1.1 AISuggestionBus.show(suggestion)
│  │        │
│  │        ├─ this.currentSuggestion = suggestion
│  │        │  └─ 保存当前建议
│  │        │
│  │        └─ this.listeners.forEach(listener => {
│  │             listener(suggestion)
│  │           })
│  │           └─ 通知所有监听器
│  │
│  └─ 15.2 AISuggestionPreview 组件接收并显示
│     │
│     ├─ useEffect(() => {
│     │    const unsubscribe = AISuggestionBus.getInstance().subscribe(
│     │      (suggestion) => {
│     │        setSuggestion(suggestion)
│     │      }
│     │    )
│     │    return unsubscribe
│     │  }, [])
│     │  └─ 订阅建议事件
│     │
│     └─ 渲染建议内容
│        │
│        ├─ <div className="ai-suggestion-preview">
│        │    <div className="suggestion-text">
│        │      {suggestion.text}
│        │    </div>
│        │    <div className="suggestion-hint">
│        │      按 Tab 或 Enter 确认，Esc 取消
│        │    </div>
│        │  </div>
│        │
│        └─ 监听键盘事件
│           │
│           ├─ Tab / Enter: 确认建议
│           │  └─ editor.commands.insertContent(suggestion.text)
│           │
│           └─ Esc: 取消建议
│              └─ setSuggestion(null)
│
│
└─ 16. 完整流程结束
   │
   └─ 用户可以:
      ├─ 按 Tab/Enter 确认建议 → 插入文本
      ├─ 按 Esc 取消建议 → 继续编辑
      └─ 继续输入 → 建议自动消失
````
