# 第 01 节: Agent 循环

> "One loop & Bash is all you need" , Agent = While True Loop + 能力边界（Bash/Tools) + 退出条件.

## 架构

代码由两层嵌套的 `while(true)` 构成：外层等待用户输入，内层驱动 agent 自主推理直到输出最终答案。

```
    User Input
        |
        v
    messages[] <-- push {role: "user", content}
        |
        v
  ┌─── 内层 while(true): agent 自主推理 ───────────────────────┐
  │                                                            │
  │   client.chat.completions.create(model, messages)         │
  │             │  [Thought]                                   │
  │             v                                              │
  │       reply 前缀匹配?                                       │
  │        /           \                                       │
  │  "command: ..."   "text: ..." (或其他)                     │
  │       │                  │                                 │
  │   execSync(cmd)       Print reply                          │
  │   [Action]            break ◄── 退出内层循环               │
  │       │                                                    │
  │   messages[] <-- push {role: "user", content: output}     │
  │   [Observation]                                            │
  │       │                                                    │
  │       └──────────────── 继续内层循环 ──────────────────────┘
        |
        v
    回到外层循环，等待下一次用户输入
```

后续所有功能 -- 工具、会话、路由、投递 -- 都是在这个循环之上叠加的层,
循环本身不会改变.

## 核心分析

`src/index.ts` 实现了最小的 **Thought → Action → Observation** 循环，是 agent loop 的原型。

### 循环结构

代码的核心是两层嵌套的 `while(true)`：

```
外层循环：等待用户输入（人机交互轮次）
  └─ 内层循环：agent 自主推理轮次
       ├─ Thought   ── 调用 LLM，生成下一步意图
       ├─ Action    ── 若回复为 command:，执行 shell 命令
       ├─ Observation ── 将命令输出追加到消息历史
       └─ （循环直到 LLM 输出 text:，退出内层）
```

### 三个阶段对应关系

| 阶段 | 代码位置 | 说明 |
|------|----------|------|
| **Thought** | `client.chat.completions.create(...)` | 模型基于完整消息历史推理，决定下一步是执行命令还是直接回答 |
| **Action** | `execSync(cmd, ...)` | 解析 `command:` 前缀后执行 shell 命令，是模型唯一的"手脚" |
| **Observation** | `messages.push({ role: 'user', content: 'command output:\n...' })` | 将 stdout/stderr 作为新消息压入历史，让模型"看到"执行结果 |

### 关键设计特点

- **消息历史即状态**：所有上下文（用户输入、模型推理、命令输出）都存储在 `messages` 数组，LLM 通过读取完整历史来维持状态，无需额外状态机
- **格式即协议**：通过 System Prompt 约定 `text:` / `command:` 两种前缀，将工具调用协议内嵌于自然语言，而非依赖结构化 function calling API
- **同步阻塞执行**：使用 `execSync` 而非异步，保证 Observation 在下一次 Thought 前一定就绪
- **错误也是 Observation**：命令失败时，stderr 同样被送回模型，模型可据此调整策略（自我纠错）

### 与完整 Agent 框架的差异

此实现刻意保持极简，省略了生产环境中的常见能力：

- 无工具注册机制（hardcode 了"只有 shell"这一种工具）
- 无并行工具调用
- 无沙箱隔离（命令直接在宿主机执行）
- 无最大迭代次数限制（内层循环可能永不退出）

这些省略使代码适合作为 **起始原型**，完整呈现 agent loop 的最小必要结构。

## 试一试

```bash
mv .env.example .env
vim .env   # 确保 .env 中 API_KEY 和 URL 正确
npm install
npm start
```

在 `You:` 提示符处输入消息，输入 `exit` 退出。

```
# 和它对话 -- 多轮对话有效，因为 messages[] 会累积
You: 地球上国土面积最大的国家是哪个？
xclaw: 地球上国土面积最大的国家是俄罗斯。俄罗斯的国土面积约为1,709万平方公里，横跨欧亚两大洲，约占地球陆地总面积的11%以上。排名第二的是加拿大，面积约为998万平方公里。

You: 它的人口是多少？
xclaw: 根据最新数据，俄罗斯的人口约为1.44亿至1.46亿人。尽管俄罗斯国土面积世界第一，但人口密度相对较低，平均每平方公里只有约8.5人。这主要是因为西伯利亚和远东地区气候寒冷，不适合大规模人类居住，大部分人口集中在欧洲部分的莫斯科、圣彼得堡等大城市周边。
You:
# 模型记得上一轮提到的"俄罗斯"，因为完整 messages[] 都传给了模型


You: package.json 里的 scripts 有哪些？
xclaw runs: cat package.json | grep -A 20 '"scripts"'
  "scripts": {
    "start": "node --env-file=.env src/index.ts",
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "module",
  "dependencies": {
    "openai": "^6.34.0"
  },
  "devDependencies": {
    "@types/node": "^25.6.0"
  }
}

xclaw: package.json 中的 scripts 如下：

1. **start**: `node --env-file=.env src/index.ts`
   - 启动应用，使用 `.env` 文件中的环境变量运行 `src/index.ts`

2. **test**: `echo "Error: no test specified" && exit 1`
   - 测试脚本，目前未配置具体测试，会输出错误信息并退出
```
