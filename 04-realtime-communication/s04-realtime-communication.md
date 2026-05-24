# 第 04 节: 实时多通道通信

> "一个 Agent，多条通道，统一协议。"  
> 本节将单一 CLI 应用扩展为同时服务 CLI、浏览器 Web、QQ 机器人三个通道的实时 Agent——每条通道接收消息、流式推送回复、独立维护会话历史，共用同一个 Agent 实例。

## 本节改动全景

相比第 03 节，本节将 Agent 从"单通道阻塞循环"升级为"多通道并发网关"：

| 改动 | 第 03 节 | 第 04 节 |
|------|----------|----------|
| 入口 | `index.ts` 含 Agent 主循环 | `index.ts` 只组装；Agent、Gateway 各独立文件 |
| 通道 | 仅 CLI（readline + stdout） | CLI + Web（WebSocket）+ QQ（QQ Gateway WebSocket） |
| 消息投递 | 主循环直接 `console.log` | `Gateway.dispatch()` 统一路由，通过 `ChannelAdapter.send()` 回写 |
| 流式输出 | 无 | `Provider.stream?()` + `streamWithFallback` + `onDelta` 逐 token 推送 |
| 会话隔离 | 单一全局 `messages[]` | `Agent.sessions: Map<sessionId, Message[]>` 每会话独立历史 |
| 日志 | `console.log` → stdout（干扰 readline） | `logger.ts`：写 stderr，带文件名:行号前缀 |

---

## 文件结构

```
src/
  providers/          — 复用第 03 节，新增 stream?() 接口
    types.ts          — Provider 新增可选 stream?() 方法
    registry.ts       — 新增 streamWithFallback()
  gateway/
    types.ts          — ACPMessage / AgentReply 类型定义
    gateway.ts        — Gateway 类：register / dispatch / start
    router.ts         — resolveSessionId() 会话 ID 填充
  channels/
    types.ts          — ChannelAdapter 接口
    cli.ts            — CLI 通道（readline，非阻塞等待）
    web.ts            — Web 通道（WebSocket 服务端 + inline HTML）
    qq.ts             — QQ 通道（OAuth2 + QQ Gateway WebSocket）
  agent.ts            — Agent 类：多会话 sessions Map + token 缓冲
  logger.ts           — 日志工具：写 stderr，带调用行号
  context.ts          — 复用第 03 节
  tools.ts            — 复用第 03 节
  index.ts            — 组装入口
```

---

## 架构

```
  CLI (readline)          Web Browser          QQ 用户
       │                      │                    │
  readline.question       WebSocket             QQ Gateway
       │                  ws://host/ws           WebSocket
       │                      │                    │
       ▼                      ▼                    ▼
  CliAdapter           WebAdapter            QQAdapter
       │  ACPMessage         │  ACPMessage         │  ACPMessage
       └──────────────┬──────┘─────────────────────┘
                      ▼
               Gateway.dispatch()
               resolveSessionId()
                      │
                      ▼
               Agent.handle(msg, onDelta)
               sessions[sessionId] → messages[]
                      │
             ┌────────┴────────┐
             │ streamWithFallback(messages, chain, onDelta)
             │        │
             │   onDelta(token)  ──→  adapter.send({ type:'delta', ... })
             │        │
             │   return fullReply
             └────────┘
                      │
               adapter.send({ type:'reply', ... })
```

---

## 1. ACP 协议

所有通道与 Agent 之间的消息，统一用两个类型表示：

```typescript
// src/gateway/types.ts
export interface ACPMessage {
  id: string;        // crypto.randomUUID()
  sessionId: string; // 同一 sessionId 共享历史
  channel: string;   // 'cli' | 'web' | 'qq'
  content: string;
  timestamp: number;
}

export interface AgentReply {
  type: 'delta' | 'reply' | 'error';
  id: string;
  sessionId: string;
  channel: string;
  content: string;   // delta: 单 token；reply: 完整回复；error: 错误信息
}
```

**三种 reply 类型的分工：**

| type | 含义 | 接收方行为 |
|------|------|-----------|
| `delta` | 流式 token（逐字推送） | 追加到当前气泡 |
| `reply` | 本轮回复结束信号 | 停止光标动画，解锁输入框 |
| `error` | 出错 | 显示错误信息，解锁输入框 |

**为什么需要 `reply` 信号而不只有 `delta`？**  
`delta` 只是 token 片段，接收方无法判断流什么时候结束。`reply` 作为终止信号，携带完整内容（QQ 等不支持流式的通道只消费这一条），对两类通道提供统一接口。

---

## 2. ChannelAdapter 接口

```typescript
// src/channels/types.ts
export interface ChannelAdapter {
  name: string;
  onMessage(handler: (msg: ACPMessage) => void): void;
  send(reply: AgentReply): void;
  start(): Promise<void>;
}
```

三个方法职责清晰：

- `onMessage(handler)`：注册入站回调，由 Gateway 调用一次
- `send(reply)`：Gateway 调用，将回复推回该通道的客户端
- `start()`：启动通道（开监听端口、建立 WebSocket 连接等）

各通道的 `send()` 行为差异：

| 通道 | delta | reply | error |
|------|-------|-------|-------|
| CLI | `process.stdout.write(token)` | 输出换行 + 触发下一次 `rl.question()` | 打印错误 + 触发下一次提示 |
| Web | `ws.send({type:'delta', content})` | `ws.send({type:'reply'})` | `ws.send({type:'error'})` |
| QQ | 忽略（不支持流式） | 调用 QQ API 发送消息 | 忽略 |

---

## 3. Gateway 与 Router

### Gateway：统一分发

```typescript
// src/gateway/gateway.ts
export class Gateway {
  private adapters = new Map<string, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
    adapter.onMessage((raw) => this.dispatch(raw));  // 注册入站回调
  }

  private async dispatch(raw: ACPMessage): Promise<void> {
    const msg = { ...raw, sessionId: resolveSessionId(raw.channel, raw.sessionId) };
    const adapter = this.adapters.get(msg.channel)!;

    try {
      await this.agent.handle(msg, (token) => {
        adapter.send({ type: 'delta', ...msg, content: token });
      }).then((full) => {
        adapter.send({ type: 'reply', ...msg, content: full });
      });
    } catch (err: any) {
      adapter.send({ type: 'error', ...msg, content: err.message });
    }
  }
}
```

**dispatch 做了什么：**

1. 调用 `resolveSessionId` 填充/规范化 `sessionId`
2. 把 `onDelta` 回调传给 `agent.handle()`，每个 token 实时推送 `delta`
3. 全部 token 输出后推送 `reply`（携带完整内容供 QQ 等通道使用）
4. 任何异常推送 `error`

### Router：sessionId 规范化

```typescript
// src/gateway/router.ts
export function resolveSessionId(channel: string, clientSessionId?: string): string {
  if (channel === 'cli') return 'cli';       // CLI 固定单会话
  return clientSessionId ?? `web-${Date.now()}`;  // Web/QQ 用客户端传入的 ID
}
```

QQ 通道的 sessionId 由适配器自己构造（`qq-c2c-{openid}` / `qq-group-{groupOpenid}`），直接透传，保证每个用户/群有独立历史。

---

## 4. 流式输出

### Provider 接口新增 stream?()

```typescript
// src/providers/types.ts
export interface Provider {
  name: string;
  contextWindow: number;
  chat(messages: Message[]): Promise<string>;
  stream?(messages: Message[], onToken: (token: string) => void): Promise<string>;  // 新增，可选
}
```

`stream?()` 是可选方法，不实现的 Provider 自动降级到 `chat()` + 单次 `onToken` 调用。

### streamWithFallback

```typescript
// src/providers/registry.ts
export async function streamWithFallback(
  messages: Message[],
  chain: string[],
  onToken: (token: string) => void,
): Promise<string> {
  for (const name of chain) {
    const provider = providerRegistry.get(name)!;
    const ctx = await assembleContext(messages, provider);
    try {
      if (provider.stream) {
        return await provider.stream(ctx, onToken);  // 真流式
      }
      const reply = await provider.chat(ctx);
      onToken(reply);   // 降级：整体作为一个 token 发出
      return reply;
    } catch (err: any) { /* 尝试下一个 */ }
  }
  throw new Error('All providers failed');
}
```

### 工具调用 token 不能透传

Agent 内层循环有一个关键细节：工具调用的 JSON（`{"action":"shell","command":"ls"}`）不能被推送给客户端——用户看到原始 JSON 是错误的体验。

```typescript
// src/agent.ts（核心逻辑）
const buffer: string[] = [];
const reply = await streamWithFallback(messages, providerChain, (token) => {
  buffer.push(token);   // 先缓冲，不立即发出
});
messages.push({ role: 'assistant', content: reply });

const toolCall = extractJSON(reply);
if (toolCall && typeof toolCall.action === 'string') {
  // 是工具调用 → 执行工具，buffer 中的 JSON token 静默丢弃
  // ...
} else {
  // 是普通回复 → 此时才把缓冲的 token 依次发给客户端
  for (const token of buffer) onDelta(token);
  return reply;
}
```

**设计要点：确认是文本回复后才 flush buffer。** 工具调用轮次的 token 直接丢弃，下一轮（真正的文字回复轮次）再从头缓冲并 flush。

---

## 5. 多会话隔离

```typescript
// src/agent.ts
export class Agent {
  private sessions = new Map<string, Message[]>();

  async handle(msg: ACPMessage, onDelta: ...): Promise<string> {
    if (!this.sessions.has(msg.sessionId)) {
      this.sessions.set(msg.sessionId, [{ role: 'system', content: SYSTEM_PROMPT }]);
    }
    const messages = this.sessions.get(msg.sessionId)!;
    // ...
  }
}
```

每个 `sessionId` 对应独立的 `messages[]`。第 03 节的全局数组变成了 Map，代码改动极小，但支持了任意数量的并发会话。

**sessionId 命名约定：**

| 通道 | sessionId |
|------|-----------|
| CLI | `cli`（固定值，单会话） |
| Web | `web-{randomHex}`（浏览器启动时生成） |
| QQ 私聊 | `qq-c2c-{userOpenid}` |
| QQ 群 | `qq-group-{groupOpenid}` |

---

## 6. QQ 通道实现

QQ 机器人不走 HTTP 轮询，而是通过 QQ Gateway WebSocket 接收实时推送。

### 连接流程

```
qqAdapter.start()
    │
    ├─ 1. POST /app/getAppAccessToken  →  access_token（有效期约 2h）
    │
    ├─ 2. GET /gateway  →  wss://... 网关地址
    │
    └─ 3. WebSocket 握手序列
         ├─ Server → op=10 HELLO { heartbeat_interval }
         ├─ Client → op=2  IDENTIFY { token, intents: 1<<25, shard: [0,1] }
         ├─ Client → op=1  心跳（每 heartbeat_interval ms 一次）
         └─ Server → op=0  DISPATCH { t: "C2C_MESSAGE_CREATE" | "GROUP_AT_MESSAGE_CREATE", d: {...} }
```

`intents = 1 << 25` 订阅 `GROUP_AND_C2C` 事件集，覆盖私聊和群 @ 消息。

### 回复上下文（replyCtx）

QQ 的回复 API 要求携带原始消息的 `msg_id`，但 `send()` 被调用时只有 `sessionId` 可用，没有原始消息 ID。

解决方案：收到消息时把 `{ type, targetId, msgId }` 存入 `replyCtx Map`，`send()` 时按 `sessionId` 取出再发送：

```typescript
// 收到消息时存入
replyCtx.set(sessionId, { type: 'c2c', targetId: openid, msgId: msg.id });

// send() 时取出
const ctx = replyCtx.get(reply.sessionId);
replyCtx.delete(reply.sessionId);  // 一次性使用
sendC2C(token, ctx.targetId, reply.content, ctx.msgId);
```

---

## 7. 日志隔离

CLI 通道使用 `readline` 在 stdout 管理 `You: ` 提示符。如果其他通道的日志也写 stdout，会直接插入到用户的输入行中间，导致光标错位。

解决方案：所有诊断日志写 stderr，CLI 对话保持 stdout。

```typescript
// src/logger.ts
function caller(): string {
  // Error.stack 第 3 帧是实际调用方（0=Error, 1=caller(), 2=log(), 3=调用点）
  const line = new Error().stack?.split('\n')[3] ?? '';
  const m = line.match(/[\\/]([\w.-]+\.ts):(\d+)/);
  return m ? `${m[1]}:${m[2]}` : '?';
}

export const log  = (...a: unknown[]) =>
  process.stderr.write(`[${caller()}] ` + a.map(String).join(' ') + '\n');
```

输出示例：
```
[qq.ts:77] connecting to wss://api.sgroup.qq.com/websocket
[qq.ts:122] WebSocket connected
[qq.ts:184] c2c from A4C16F8A: 你好
[agent.ts:67] [qq-c2c-A4C16F8A] uses [shell]: {"command":"pwd"}
```

可用 `2>/dev/null` 屏蔽所有诊断日志，只保留 CLI 对话输出。

---

## 知识点总结

| 知识点 | 说明 |
|--------|------|
| **ACP（Agent Channel Protocol）** | 两个类型（ACPMessage / AgentReply）统一所有通道的消息格式，通道实现对 Agent 透明 |
| **ChannelAdapter 接口** | `onMessage` 注入回调 / `send` 推回 / `start` 启动，三方法覆盖通道全生命周期 |
| **流式 token 缓冲** | 工具调用轮次的 token 缓冲不发出；只有确认为文本回复时才 flush——防止 JSON 透传给用户 |
| **会话 Map 隔离** | `Map<sessionId, Message[]>` 支持任意并发会话，主循环代码零改动 |
| **QQ Gateway WebSocket** | HELLO → IDENTIFY → 心跳 三段握手；intents 位掩码控制订阅的事件类型 |
| **replyCtx 一次性映射** | QQ 回复需要原始 msg_id，存入 Map 供 send() 取用后立即删除 |
| **stderr/stdout 分流** | 日志写 stderr，readline 只在 stdout 渲染提示符，两者天然隔离不互相干扰 |
| **Error.stack 行号** | 帧索引 `[3]` 跳过 caller()/log() 两层包装，取到真正的调用文件和行号 |

---

## 试一试

### 配置

```bash
cd sections/04-realtime-communication/nodejs
cp .env.example .env
```

编辑 `.env`，至少填入一个 LLM Provider 的 Key：

```dotenv
# LLM Provider（至少填一个）
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-7

OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o

PRIMARY_PROVIDER=claude     # 主 Provider
FALLBACK_PROVIDER=openai    # 降级 Provider

# Web 通道（可选，默认 3000）
WEB_PORT=3000

# QQ 通道（可选，不填则跳过 QQ 通道）
QQ_APP_ID=...
QQ_CLIENT_SECRET=...
```

#### QQ 机器人配置

1. 前往 [QQ 开放平台](https://q.qq.com/#/apps)，点击**创建机器人**
2. 创建完成后在机器人详情页找到 **AppID** 和 **AppSecret**
3. 将两者填入 `.env` 的 `QQ_APP_ID` 和 `QQ_CLIENT_SECRET`
4. 在开放平台的"沙箱配置"里把自己的 QQ 号加入白名单，即可用个人号给机器人发私信测试

不配置 QQ 相关环境变量时，QQ 通道会自动跳过，CLI 和 Web 正常工作。

### 启动

```bash
npm install
npm start
```

启动后同时监听三个通道：

```
[cli.ts:29]  [cli] ready — type your message (exit to quit)
[web.ts:171] [web] http://localhost:3000
[qq.ts:169]  [qq] QQ_APP_ID / QQ_CLIENT_SECRET 未配置，跳过 QQ 渠道
You:
```

### 验证

```
# CLI — 直接在终端输入
You: 当前目录下有哪些文件？
xclaw uses [shell]: {"command":"ls"}
...
xclaw: 当前目录下有以下文件：...

# Web — 打开 http://localhost:3000
# 消息气泡实时流式出现（逐字）

# QQ — 在 QQ 中给机器人发私信或在群里 @ 它
# 机器人收到消息后调用 Agent，回复完整答案（QQ 不支持流式，一次性发送）

# 验证多会话：CLI 和 Web 同时聊，各自维护独立上下文
# CLI 里执行 shell 命令后，Web 里的历史不受影响
```
