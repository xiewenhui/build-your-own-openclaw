# 第 02 节: 工具系统

> 工具调用的本质是：**协议（LLM 怎么表达意图） + 解析（代码怎么理解意图） + 分发（代码怎么执行意图）**。本节从三个维度逐步升级第 01 节的极简实现，最终得到一套可插拔的动态工具系统。

## 本节改动全景

相比第 01 节，本节做了四处升级：

| 改动 | 第 01 节 | 第 02 节 |
|------|----------|----------|
| 工具调用协议 | 文本前缀 `command: <cmd>` | JSON 对象 `{"action": "tool", ...params}` |
| LLM 响应解析 | `reply.startsWith('command: ')` | `extractJSON` 多策略 + 非法转义修复 |
| 工具注册 | hardcoded if/else | `registerTool` 注册表 + 自动分发 |
| 循环保护 | 无限制 | `MAX_ITERATIONS = 10` |

---

## 1. 工具调用协议：从前缀到 JSON

### 为什么换协议

前缀协议（`text:` / `command:`）有两个致命弱点：

1. **弱类型**：每个工具只能携带一个字符串，无法表达多参数（如 `read_file` 需要路径和编码）
2. **线性扩展**：增加新工具就得加新前缀和新的 `startsWith` 分支，主循环越来越臃肿

JSON 协议天然支持多字段，工具间靠 `action` 字段区分：

```json
{"action": "shell",     "command": "ls -la"}
{"action": "read_file", "path": "/etc/hosts", "encoding": "utf-8"}
{"action": "search",    "query": "Beijing weather"}
```

### System Prompt 设计原则

Prompt 里对工具调用格式的描述有两个关键决策：

1. **允许 markdown 代码块包裹**：强行禁止反而让模型混淆，不如在解析侧兼容
2. **工具描述由注册表自动生成**：不在 Prompt 里手写工具列表，见第 3 节

---

## 2. 鲁棒 JSON 提取器

### 问题根源

你要求 LLM 输出 JSON，但它可能输出：

```
// 期望
{"action": "shell", "command": "ls"}

// 实际可能出现的各种形式
Here's my action:
```json
{"action": "shell", "command": "ls"}
```
Let me proceed...
```

LLM 的输出是概率采样的文本，格式遵循度受模型能力、温度、上下文多种因素影响，**不能假设输出格式严格合规**。除了格式多样，LLM 还会产生非法 JSON 内容——比如在 shell 命令里写 `\;`，而 `\;` 不是合法的 JSON 转义序列，导致 `JSON.parse` 直接抛错。

### 两层防御：格式提取 + 内容修复

```typescript
// 第一层：修复非法转义序列
// JSON 只允许 \" \\ \/ \b \f \n \r \t \uXXXX，其余 \X 均非法
function repairJSON(s: string): string {
  return s.replace(/\\([^"\\/bfnrtu\d])/g, '\\\\$1');
}

// 每个候选字符串先试原文，失败再试修复版
function tryParse(candidate: string): Record<string, unknown> | null {
  try { return JSON.parse(candidate); } catch {}
  try { return JSON.parse(repairJSON(candidate)); } catch {}
  return null;
}

// 第二层：从各种格式中提取 JSON 候选字符串
function extractJSON(text: string): Record<string, unknown> | null {
  const s = text.trim();

  // 策略1：裸 JSON（最理想情况）
  const r1 = tryParse(s);
  if (r1) return r1;

  // 策略2：```json ... ``` 代码块
  const jsonBlock = s.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlock) { const r = tryParse(jsonBlock[1].trim()); if (r) return r; }

  // 策略3：``` ... ``` 无语言标注代码块
  const rawBlock = s.match(/```\s*([\s\S]*?)```/);
  if (rawBlock) { const r = tryParse(rawBlock[1].trim()); if (r) return r; }

  // 策略4：文本中内嵌的 {...}（贪婪匹配最外层大括号）
  const inlineMatch = s.match(/\{[\s\S]*\}/);
  if (inlineMatch) { const r = tryParse(inlineMatch[0]); if (r) return r; }

  return null;  // 全部失败 → 视为普通文本
}
```

**设计要点：**

- **先解析再修复**：优先接受 LLM 的原始输出，仅失败时才修复，避免误改合法内容
- **策略独立**：每种提取方式的失败不影响后续策略
- **优先级从严到宽**：先尝试最干净的形式，再退化到模糊匹配
- **返回 null 而非抛出**：调用方用 `null` 统一判断"非工具调用"，逻辑清晰

---

## 3. 动态工具注册机制（核心）

### 问题：hardcoded 工具的局限

第 01 节的工具逻辑写死在主循环里：

```typescript
// 每加一个工具就要改这里
if (toolCall.action === 'shell') {
  execSync(toolCall.command);
} else if (toolCall.action === 'read_file') {
  // ...
} else if (toolCall.action === 'search') {
  // ...
}
```

同时 System Prompt 里的工具说明也是手写字符串，与实际实现脱节——改了代码忘了改 Prompt，或者改了 Prompt 忘了改代码，是真实项目中的高频 bug。

**根本问题**：工具的"描述"和"实现"分离在两个地方，且主循环和 Prompt 都要随工具增减而修改。

### 解决方案：Tool = Schema + Executor

把每个工具定义为一个对象，包含两部分：

- **Schema**：工具的名称、功能描述、参数列表（供 LLM 理解）
- **Executor**：工具的实际执行函数（供代码调用）

```typescript
interface ToolParam {
  type: string;
  description: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParam>;
    required: string[];
  };
}

type ToolExecutor = (params: Record<string, string>) => string;

interface Tool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}
```

### 注册表：Map<name, Tool>

```typescript
const toolRegistry = new Map<string, Tool>();

function registerTool(definition: ToolDefinition, execute: ToolExecutor) {
  toolRegistry.set(definition.name, { definition, execute });
}
```

注册一个 shell 工具：

```typescript
registerTool(
  {
    name: 'shell',
    description: 'Execute a bash shell command and return stdout',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
      },
      required: ['command'],
    },
  },
  ({ command }) => execSync(command, { encoding: 'utf-8' }),
);
```

### 自动生成工具描述注入 Prompt

注册表里有了工具的完整 Schema，System Prompt 就可以**动态生成**，而不是手写：

```typescript
function buildToolsPrompt(): string {
  return [...toolRegistry.values()]
    .map(({ definition: d }) => {
      const params = Object.entries(d.parameters.properties)
        .map(([k, v]) => `  - ${k} (${v.type}): ${v.description}`)
        .join('\n');
      return `### ${d.name}\n${d.description}\nParameters:\n${params}`;
    })
    .join('\n\n');
}

const SYSTEM_PROMPT = `You are an AI assistant named xclaw.

To use a tool, output a JSON object (bare or in a markdown code block):
{"action": "<tool_name>", "<param1>": "<value1>", ...}

To answer directly, output plain text — do NOT use JSON.

Available tools:
${buildToolsPrompt()}`;
```

**这就是"自动生成工具描述"的核心**：新增一个 `registerTool` 调用，LLM 自动就能看到并使用这个工具，无需手动修改 Prompt 字符串。

### 工具分发

主循环里不再有 if/else，只有注册表查找：

```typescript
const toolCall = extractJSON(reply);
if (toolCall && typeof toolCall.action === 'string') {
  const tool = toolRegistry.get(toolCall.action);
  if (tool) {
    const { action, ...params } = toolCall as Record<string, string>;
    console.log(`xclaw uses [${action}]:`, params);
    try {
      const output = tool.execute(params);
      console.log(output);
      messages.push({ role: 'user', content: `tool output:\n${output}` });
    } catch (err: any) {
      const errMsg = err.stderr ?? err.message;
      console.error(`error: ${errMsg}`);
      messages.push({ role: 'user', content: `tool error:\n${errMsg}` });
    }
  } else {
    // 未知工具：告知模型，让它重试或换策略
    messages.push({ role: 'user', content: `error: unknown tool "${toolCall.action}". Available: ${[...toolRegistry.keys()].join(', ')}` });
  }
} else {
  console.log(`xclaw: ${reply}`);
  break;
}
```

未知工具不是静默失败，而是把可用工具列表反馈给模型——这是一次 Observation，让模型有机会自我纠正。

### 扩展性验证：增加 read_file 工具

增加一个新工具，只需一次 `registerTool` 调用，**主循环零改动，Prompt 自动更新**：

```typescript
import { readFileSync } from 'fs';

registerTool(
  {
    name: 'read_file',
    description: 'Read the content of a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path' },
      },
      required: ['path'],
    },
  },
  ({ path }) => readFileSync(path, 'utf-8'),
);
```

---

## 4. 最大迭代次数限制

### 问题：内层循环可能永不退出

如果 LLM 持续输出工具调用（模型 bug、Prompt 设计问题、工具反复报错后模型陷入自循环），Agent 会无限消耗 token 和 API 额度。

### 解决方案

```typescript
const MAX_ITERATIONS = 10;

let iterations = 0;
while (true) {
  if (++iterations > MAX_ITERATIONS) {
    console.log(`[xclaw] reached max iterations (${MAX_ITERATIONS}), stopping`);
    break;
  }
  // ... 正常逻辑
}
```

`MAX_ITERATIONS` 是**每次用户输入**对应的内层推理上限，不是整个会话的轮数。正常的多步任务通常 3～5 轮完成，10 轮足够应对复杂任务同时防止失控。

---

## 架构对比

```
第 01 节（hardcoded）          第 02 节（动态注册）

SYSTEM_PROMPT                  buildToolsPrompt()
  手写工具说明字符串     →        从注册表自动生成

主循环工具分发                  主循环工具分发
  if action === 'shell'  →        tool = toolRegistry.get(action)
  else if action === ...          tool.execute(params)
  else if ...

增加工具需要改：                增加工具只需：
  1. SYSTEM_PROMPT 字符串         1. registerTool(definition, executor)
  2. 主循环 if/else
```

---

## 知识点总结

| 知识点 | 说明 |
|--------|------|
| **JSON 作为工具调用协议** | 比文本前缀更具扩展性，多参数工具天然支持，增加工具不改解析逻辑 |
| **LLM 输出不可信任格式** | 输出是概率采样的文本，必须兼容裸 JSON、代码块包裹、文本内嵌等多种形式 |
| **非法转义修复** | `\;` `\:` 等非法 JSON 转义是 LLM 生成 shell 命令时的高频 bug，解析前修复 |
| **Tool = Schema + Executor** | 工具描述和执行函数绑定在同一个对象，消除描述与实现脱节的问题 |
| **动态 Prompt 生成** | System Prompt 从注册表自动生成，增删工具不改 Prompt 字符串 |
| **未知工具反馈** | 未知工具调用不静默失败，将可用工具列表作为 Observation 送回模型 |
| **迭代次数限制** | Agent 内层循环的安全阀，防止模型 bug 或工具持续报错导致无限消耗 |

---

## 试一试

```bash
cd sections/02-tool-system/nodejs
cp .env.example .env
# 确认 .env 中 API_KEY 和 URL 正确
npm install
npm start
```

```
# 直接回答（不触发工具）
You: 地球上国土面积最大的国家是哪个？
xclaw: 地球上国土面积最大的国家是俄罗斯...

# 触发 shell 工具
You: package.json 里有哪些依赖？
xclaw uses [shell]: { command: 'cat package.json' }
...
xclaw: package.json 中有以下依赖...

# 触发 read_file 工具（如已注册）
You: 读取 src/index.ts 的内容
xclaw uses [read_file]: { path: 'src/index.ts' }
...
xclaw: 文件内容如下...

# 多步推理（观察内层循环多次迭代）
You: 当前目录下有哪些 .ts 文件，每个文件有多少行？
xclaw uses [shell]: { command: "find . -name '*.ts' -not -path '*/node_modules/*'" }
...
xclaw uses [shell]: { command: 'wc -l src/index.ts' }
...
xclaw: 当前目录下有 1 个 .ts 文件：src/index.ts，共 XX 行。
```
