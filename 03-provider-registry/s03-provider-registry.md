# 第 03 节: 多模型适配 (Provider Registry)

> 模型无关性的本质是：**统一内部表示 + 边界转换**。内部永远使用同一种消息格式，只在调用各 Provider 的瞬间做格式翻译。上下文组装、降级路由都建立在这个抽象之上。

## 本节改动全景

相比第 02 节，本节将 LLM 调用层从主循环中完全剥离：

| 改动 | 第 02 节 | 第 03 节 |
|------|----------|----------|
| LLM 调用 | 直接调用 OpenAI SDK | `chatWithFallback(messages, chain)` |
| 消息类型 | `OpenAI.Chat.ChatCompletionMessageParam[]` | 统一 `Message[]` 接口 |
| 上下文管理 | 无，消息无限增长 | 自动截断 + 压缩摘要 |
| 多模型支持 | 单一 Provider | 可注册任意 Provider，错误自动降级 |

工具系统（`extractJSON`、`toolRegistry`）完整复用，主循环结构不变。

---

## 文件结构

```
src/
  providers/
    types.ts      — Message / Provider 统一接口定义
    openai.ts     — OpenAI Provider 实现
    claude.ts     — Claude Provider 实现（格式转换核心）
    registry.ts   — 注册表 + chatWithFallback 降级路由
  context.ts      — Token 估算 / 截断 / 压缩
  tools.ts        — 工具系统（从第 02 节复用）
  index.ts        — 主循环
```

---

## 1. 统一接口：Provider 抽象

### 问题：耦合在 SDK 类型上

第 02 节的消息数组类型是 `OpenAI.Chat.ChatCompletionMessageParam[]`——这是 OpenAI SDK 的私有类型，一旦想切换到 Claude，整个消息历史的类型都要改。

### 解决方案：定义内部统一类型

```typescript
// src/providers/types.ts
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Provider {
  name: string;
  contextWindow: number;   // 模型 token 上限
  chat(messages: Message[]): Promise<string>;
}
```

**关键设计**：`Provider` 接口只暴露一个 `chat` 方法，接收统一的 `Message[]`，返回字符串。每个 Provider 实现内部负责把 `Message[]` 翻译成自己的 API 格式——**格式差异被封装在 Provider 边界内，主循环对此无感知**。

---

## 2. 格式转换：OpenAI vs Claude

这是本节最核心的工程问题。两家 API 的消息格式存在本质差异：

| 字段 | OpenAI | Anthropic (Claude) |
|------|--------|--------------------|
| system 消息 | 放在 `messages` 数组首位 | 从 `messages` 中提取，作为独立顶层字段 |
| role 取值 | `system` / `user` / `assistant` | 只允许 `user` / `assistant` |
| 调用方式 | `client.chat.completions.create({messages})` | `client.messages.create({system, messages})` |

### OpenAI Provider（直接映射）

```typescript
// src/providers/openai.ts
async chat(messages: Message[]): Promise<string> {
  const completion = await client.chat.completions.create({
    model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  });
  return completion.choices[0].message.content ?? '';
}
```

OpenAI 的格式与内部 `Message` 天然兼容，几乎是透传。

### Claude Provider（格式转换）

```typescript
// src/providers/claude.ts
async chat(messages: Message[]): Promise<string> {
  // Anthropic 要求 system 作为独立顶层字段，不能混在 messages 里
  const system = messages.find(m => m.role === 'system')?.content ?? '';
  const turns  = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const response = await client.messages.create({
    model,
    max_tokens: 8096,
    system,           // ← 独立传入
    messages: turns,  // ← 不含 system
  });

  const block = response.content[0];
  return block.type === 'text' ? block.text : '';
}
```

**这段代码是 Provider 机制的价值体现**：调用方传入统一的 `Message[]`，格式转换完全在 Provider 内部完成，主循环对 OpenAI 和 Claude 的调用代码完全相同。

---

## 3. 上下文组装器

### 问题：消息历史无限增长

第 02 节的 `messages` 数组随对话轮次无限增长，迟早会超出模型的 context window 上限，触发 API 报错。

### 三层处理流程

```
assembleContext(messages, provider)
        │
        ▼
  1. 估算 token 数
        │
  超出上限？
   ├─ 否 → 直接返回
   │
   └─ 是 → truncate()
              │
          仍超限？（极少发生）
           ├─ 否 → 返回
           │
           └─ 是 → compress() → truncate() → 返回
```

### Token 估算

```typescript
// src/context.ts
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);  // 4 字符 ≈ 1 token（粗估）
}
```

无需引入 tokenizer 依赖，粗估足够指导截断决策。对中文会低估（中文约 2 字符/token），但截断时保留 10% headroom 可以弥补。

### 截断策略

保留 system 消息（不可丢），从末尾向前尽量多保留对话轮次：

```typescript
function truncate(messages: Message[], limit: number): Message[] {
  const system = messages.filter(m => m.role === 'system');
  const turns  = messages.filter(m => m.role !== 'system');

  let budget = limit - messagesTokens(system);
  let kept = 0;

  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = estimateTokens(turns[i].content) + 4;
    if (budget - cost < 0) break;
    budget -= cost;
    kept++;
  }

  return [...system, ...turns.slice(turns.length - kept)];
}
```

**越新的消息越重要**：从最新轮次开始保留，超限后直接丢弃旧轮次。

### 压缩/摘要

当截断后仍超限（历史中有单条超长消息时可能发生），用 LLM 对旧消息做摘要：

```typescript
async function compress(messages: Message[], provider: Provider): Promise<Message[]> {
  const KEEP_RECENT = 4;
  const toSummarize = turns.slice(0, -KEEP_RECENT);
  const recent      = turns.slice(-KEEP_RECENT);

  const summary = await provider.chat([{
    role: 'user',
    content: 'Summarize the following conversation history concisely:\n\n' +
      toSummarize.map(m => `${m.role}: ${m.content}`).join('\n'),
  }]);

  return [
    ...system,
    { role: 'user', content: `[Conversation summary]\n${summary}` },
    ...recent,
  ];
}
```

摘要本身消耗的 token 远少于原始消息，之后再经一轮 `truncate` 保证最终不超限。

---

## 4. Provider 注册表与错误降级

### 注册表（同第 02 节工具注册表的模式）

```typescript
// src/providers/registry.ts
const providerRegistry = new Map<string, Provider>();

export function registerProvider(provider: Provider) {
  providerRegistry.set(provider.name, provider);
}
```

### 错误降级路由

```typescript
export async function chatWithFallback(
  messages: Message[],
  chain: string[],   // Provider 名称列表，按优先级排列
): Promise<string> {
  const errors: string[] = [];

  for (const name of chain) {
    const provider = providerRegistry.get(name)!;
    const ctx = await assembleContext(messages, provider);  // ← 每个 Provider 独立组装上下文
    try {
      return await provider.chat(ctx);
    } catch (err: any) {
      console.warn(`[provider:${name}] failed — ${err.message}`);
      errors.push(`${name}: ${err.message}`);
    }
  }

  throw new Error(`All providers failed:\n${errors.join('\n')}`);
}
```

**两个设计细节：**

1. **每个 Provider 独立组装上下文**：不同 Provider 的 `contextWindow` 不同，比如Claude Haiku 4.5 是 200K，OpenAI GPT-4o 是 128K等，必须分别计算截断边界
2. **所有 Provider 都失败才抛错**：只要链条中有一个成功就返回，报错信息收集后统一抛出，方便排查

### 主循环调用（变化极小）

```typescript
// 第 02 节
const completion = await client.chat.completions.create({ model, messages });
const reply = completion.choices[0].message.content ?? '';

// 第 03 节
const reply = await chatWithFallback(messages, providerChain);
```

主循环只改了这一行，工具分发逻辑完全不变。

---

## 架构对比

```
第 02 节                           第 03 节

index.ts                           index.ts
  ├─ OpenAI SDK（直接调用）  →       ├─ chatWithFallback(messages, chain)
  ├─ 消息类型：OpenAI 私有类型         │       │
  └─ 消息无上限增长                   │   providers/registry.ts
                                    │       ├─ assembleContext()  ← context.ts
                                    │       ├─ openai.ts (Provider)
                                    │       └─ claude.ts (Provider)
                                    │
                                    └─ messages: Message[]  ← 统一内部类型

增加新 Provider 只需：
  1. 实现 Provider 接口（格式转换封装在此）
  2. registerProvider(createXxxProvider())
  3. 加入 providerChain
```

---

## 知识点总结

| 知识点 | 说明 |
|--------|------|
| **统一内部消息格式** | 内部维护与 SDK 无关的 `Message[]`，格式转换封装在 Provider 边界内 |
| **格式转换是 Provider 的核心职责** | Claude 需提取 system 字段，OpenAI 直接映射——差异完全隔离在各自实现里 |
| **Token 粗估够用** | 4 字符≈1 token 无需 tokenizer 依赖，配合 10% headroom 可安全截断 |
| **截断优先于压缩** | 丢弃旧消息比 LLM 摘要便宜得多，压缩是最后手段 |
| **每 Provider 独立组装上下文** | contextWindow 不同，必须分别计算截断边界，不能跨 Provider 复用同一份 ctx |
| **错误降级链** | 按顺序尝试，第一个成功即返回；全部失败才抛错并汇总原因 |
| **主循环与 Provider 解耦** | 主循环只调用 `chatWithFallback`，对 Provider 数量、类型、格式完全无感知 |

---

## 试一试

```bash
cd sections/03-provider-registry/nodejs
cp .env.example .env
# 填入 OPENAI_API_KEY 和 ANTHROPIC_API_KEY
npm install
npm start
```

`.env` 关键配置：

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-7

OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o

PRIMARY_PROVIDER=claude     # 主 Provider
FALLBACK_PROVIDER=openai    # 降级 Provider
```

```
# 正常对话（走主 Provider claude）
You: 用一句话介绍你自己
xclaw: 我是 xclaw，一个由 Claude 驱动的 AI 助手...

# 工具调用仍正常（复用第 02 节的工具系统）
You: 列出 src 目录下的文件
xclaw uses [shell]: { command: 'ls src/' }
...
xclaw: src 目录下有以下文件...

# 验证降级：将 ANTHROPIC_API_KEY 改为无效值后重启
# 期望：Claude 报错后自动切换到 OpenAI，对话继续
[provider:claude] failed — 401 Unauthorized, trying next...
xclaw: ...（由 OpenAI 回答）

# 验证上下文截断：大量对话后不会报 context length 错误
```
