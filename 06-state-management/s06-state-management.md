# 第 06 节: 状态管理 (State Management)

> "LLM 是非决定性的，网络是波动的，Agent 长途运行是极易崩溃的——必须用确定性的后端工程架构，去包裹不确定的 AI 行为。"

## 本节改动全景

相比第 05 节，本节的改动集中在持久化层，Agent 主循环与工具系统**完全不变**：

| 改动点 | 第 05 节 | 第 06 节 |
|--------|---------|---------|
| Session 存储 | `Map<sessionId, Message[]>`（内存） | SQLite `sessions + traces` 表（持久化） |
| 消息追加 | `messages.push()` | `messages.push()` + `db.appendTrace()` |
| 启动加载 | 无 | `db.loadSession(sessionId)` 恢复历史 |
| 重连处理 | 新建空 session | 读 `current_status` 决定恢复模式 |
| 回滚 | 无 | `db.rollback(sessionId, stepId)` 原子删除 |
| 主循环 | 不变 | **不变**（持久化层对主循环透明） |

**这一节最重要的设计思想**：持久化层像一块玻璃——Agent 主循环什么都不需要知道，照常 `messages.push()`；玻璃背后自动把每一步存进数据库。

---

## 为什么需要状态管理

前五节的 Agent 状态全部活在进程内存里。`Ctrl+C` 一下，30 步任务的上下文全部归零。

这在脚本模式下可以接受，但 Agent 正在演变成**长周期运行的"数字员工"**：

```
帮我完成这个任务：
  1. 爬取竞品价格数据     ← 已完成
  2. 清洗并入库          ← 已完成
  3. 写分析代码          ← 进行中，Agent 在这里崩了
  4. 运行单元测试
  5. 生成报告并发邮件
```

如果没有状态管理，Agent 只能从第 1 步重来——浪费 Token，浪费时间，用户体验崩溃。

四个模块协同解决这一问题：

```
[ 用户发送指令 ]
       │
       ▼
 1. 状态机持久化  ──► current_status = 'Running'，开启 SQLite 事务
       │
       ▼
 2. 轨迹追踪     ──► 生成 step_id，记录每一步的输入/输出/耗时
       │
       ├─► (服务器断电 / 网页刷新)
       │         │
       │         ▼
       │   3. 断点重连  ──► 读 current_status，区分"仅查看"还是"恢复执行"
       │
       ▼
 4. 回溯与分支  ──► (Agent 走错路) Rollback 时光倒流，或 Fork 出平行宇宙
```

---

## 数据库 Schema

整个状态管理系统只需两张表。

### sessions 表 — 状态机

```sql
CREATE TABLE sessions (
    session_id        TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    current_status    TEXT NOT NULL,   -- Init | Running | Paused | Success | Failed
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    metadata          TEXT,            -- JSON：模型参数（温度、max_tokens 等）
    is_forked         INTEGER DEFAULT 0,
    parent_session_id TEXT,            -- Fork 时指向原 session
    FOREIGN KEY (parent_session_id) REFERENCES sessions(session_id)
);
```

### traces 表 — 执行轨迹

```sql
CREATE TABLE traces (
    step_id                TEXT PRIMARY KEY,
    session_id             TEXT NOT NULL,
    parent_step_id         TEXT,           -- 树状父子关系
    step_type              TEXT NOT NULL,  -- llm_call | tool_call | user_input | system_alert
    name                   TEXT NOT NULL,  -- 如 "shell_tool" 或 "claude-opus-4-7"
    status                 TEXT NOT NULL,  -- running | completed | failed
    input_data             TEXT,           -- JSON：Prompt 或工具参数
    output_data            TEXT,           -- JSON：LLM 原始响应或工具返回值
    error_message          TEXT,
    start_time             INTEGER NOT NULL,  -- 毫秒级时间戳
    end_time               INTEGER,
    token_usage_prompt     INTEGER DEFAULT 0,
    token_usage_completion INTEGER DEFAULT 0,
    FOREIGN KEY (session_id)     REFERENCES sessions(session_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_step_id) REFERENCES traces(step_id) ON DELETE SET NULL
);

-- 断点重连：按会话顺序捞取
CREATE INDEX idx_traces_session_time ON traces(session_id, start_time ASC);
-- 树状查询：按父节点查子节点
CREATE INDEX idx_traces_parent ON traces(parent_step_id);
```

**两表分工清晰**：`sessions` 管生命周期状态，`traces` 管每一步的流水记录。

---

## 1. 状态机与持久化 (State Engine)

### 问题：JSON 文件为什么不行

最直觉的持久化方式是把 messages[] 序列化成 JSON 文件：

```typescript
// 看起来很简单
fs.writeFileSync('session.json', JSON.stringify(messages));
```

但它在以下三个场景全部失效：

| 场景 | JSON 文件 | SQLite |
|------|-----------|--------|
| **写到一半进程崩溃** | 文件内容损坏，`JSON.parse` 报错，历史全丢 | 事务回滚，文件完整，下次启动正常加载 |
| **Rollback 操作** | 读整个文件 → 过滤 → 重写，三步非原子，崩在中间又损坏 | `DELETE WHERE start_time >= ?`，一条 SQL，原子完成 |
| **多 session 并发写** | 多个文件并发写入，容易互相覆盖 | WAL 模式原生支持并发读写 |

结论：**JSON 文件适合配置，不适合执行档案。**

### 状态机设计

Agent 每个 session 的生命周期是一个有限状态机：

```
     Init
      │
      │ (收到第一条消息)
      ▼
   Running ──────────────────────→ Success
      │                              (任务完成，LLM 输出最终回答)
      │ (HITL 等待用户确认)
      ▼
   Paused ──(用户点 y)──→ Running
      │
      │ (报错 / 超出最大迭代次数)
      ▼
   Failed
```

状态写入是所有持久化操作的**第一步**：

### 原子操作的关键顺序

这是本节最重要的工程细节，顺序不能错：

```typescript
// ✅ 正确顺序：先写状态，再执行工具
async function executeTool(sessionId: string, toolName: string, params: object) {
  // 第一步：在同一个事务里记录"我要调用工具了"并持久化状态
  db.transaction(() => {
    db.run(`INSERT INTO traces (step_id, session_id, step_type, status, input_data, start_time)
            VALUES (?, ?, 'tool_call', 'running', ?, ?)`,
           [stepId, sessionId, JSON.stringify(params), Date.now()]);
    db.run(`UPDATE sessions SET current_status='Running', updated_at=? WHERE session_id=?`,
           [Date.now(), sessionId]);
  })();

  // 第二步：事务 Commit 之后，才发起实际的工具调用
  const result = await tool.execute(params);

  // 第三步：记录结果
  db.run(`UPDATE traces SET status='completed', output_data=?, end_time=? WHERE step_id=?`,
         [JSON.stringify(result), Date.now(), stepId]);
}
```

```typescript
// ❌ 错误顺序：先执行工具，再写状态
const result = await tool.execute(params);  // 如果这里崩溃
db.run('INSERT INTO traces ...');           // 这行永远不会执行
// 结果：工具执行了，但数据库里没有任何记录
// 重连后 Agent 不知道工具已经跑过，可能重复执行（如重复发邮件、重复扣款）
```

**原则：状态先落地，副作用后发生。崩溃后数据库里只会出现两种干净状态——"工具已记录未执行"或"工具已执行已记录"，绝不会出现"工具执行了但无记录"的脏数据。**

---

## 2. 完整轨迹追踪 (Trace Logging)

### 从扁平列表到树状轨迹

第 05 节的 messages[] 是一个扁平数组，记录"说了什么"，但不记录"怎么到达这里的"：

```
messages（扁平，给 LLM 看）      traces（树状，给开发者看）

[                               s0001 (user_input)
  {role:'user', content:'...'},  └─ s0002 (llm_call, 38ms)
  {role:'assistant', ...},          └─ s0003 (tool_call: shell, 12ms)
  {role:'user', content:'...'},        └─ s0004 (tool_output)
  ...                                     └─ s0005 (llm_call, 41ms)
]                                            └─ s0006 (reply)
```

两者共存，职责不同：**messages[] 是给 LLM 的上下文，traces 是给人和系统的审计档案。**

### parent_step_id：为什么必须树状

当主 Agent 派生出多个子 Agent 并行工作时，扁平日志会全部混在一起：

```
// 扁平日志（无法 Debug）
[agent-A] llm_call
[agent-B] llm_call
[agent-A] tool_call: search
[agent-C] tool_call: read_file
[agent-B] tool_call: write_file   ← 这个 write_file 是谁触发的？为什么写？
[agent-A] reply
```

树状日志（`parent_step_id` 串联）：

```
step_001 (main_agent: user_input)
├─ step_002 (agent-A: llm_call)
│  └─ step_003 (agent-A: tool_call: search, 23ms)
│     └─ step_004 (agent-A: reply)
├─ step_005 (agent-B: llm_call)
│  └─ step_006 (agent-B: tool_call: write_file, 8ms)  ← 清晰溯源
└─ step_007 (agent-C: tool_call: read_file, 5ms)
```

一眼看出 `write_file` 是 agent-B 在 step_005 的 llm_call 决策后触发的。

### 记录一个完整步骤

```typescript
async function traceToolCall(
  sessionId: string,
  parentStepId: string,
  toolName: string,
  params: object,
): Promise<{ stepId: string; result: string }> {
  const stepId = `${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const startTime = Date.now();

  // 开始记录（status: running）
  db.run(`INSERT INTO traces
          (step_id, session_id, parent_step_id, step_type, name, status, input_data, start_time)
          VALUES (?, ?, ?, 'tool_call', ?, 'running', ?, ?)`,
         [stepId, sessionId, parentStepId, toolName, JSON.stringify(params), startTime]);

  try {
    const result = await tool.execute(params);
    const endTime = Date.now();

    // 完成记录（status: completed + 耗时）
    db.run(`UPDATE traces SET status='completed', output_data=?, end_time=? WHERE step_id=?`,
           [JSON.stringify(result), endTime, stepId]);

    return { stepId, result };
  } catch (err: any) {
    db.run(`UPDATE traces SET status='failed', error_message=?, end_time=? WHERE step_id=?`,
           [err.message, Date.now(), stepId]);
    throw err;
  }
}
```

`duration_ms = end_time - start_time` 自然可算，不需要额外字段。

---

## 3. 断点重连 (Session Resume)

### 两种完全不同的重连模式

客户端重连时携带 `sessionId`，服务端做的第一件事是读状态机：

```typescript
async function handleReconnect(sessionId: string, adapter: ChannelAdapter) {
  const session = db.get(`SELECT * FROM sessions WHERE session_id=?`, [sessionId]);

  if (!session) {
    // 全新 session，走正常初始化流程
    return initNewSession(sessionId, adapter);
  }

  // 加载历史轨迹（两种模式都需要）
  const history = db.all(
    `SELECT step_type, input_data, output_data FROM traces
     WHERE session_id=? AND status='completed' ORDER BY start_time ASC`,
    [sessionId]
  );

  // 重构 messages[]，发送历史给前端展示
  const messages = reconstructMessages(history);
  adapter.send({ type: 'history', sessionId, content: JSON.stringify(messages) });

  // 根据状态机决定是否继续执行
  if (session.current_status === 'Running' || session.current_status === 'Paused') {
    await resumeExecution(session, messages, adapter);  // 恢复执行
  }
  // Success / Failed：只展示历史，不触发 LLM
}
```

### 恢复执行的关键：注入恢复提示词

仅仅把历史 messages[] 塞给 LLM 是不够的——LLM 会以为任务已经完成，输出一个总结性回答，而不是继续往下执行。

```typescript
async function resumeExecution(session: Session, messages: Message[], adapter: ChannelAdapter) {
  // 在历史末尾注入恢复提示词
  const resumePrompt: Message = {
    role: 'user',
    content: '[System: 之前由于不可抗力中断，请根据以下历史继续执行，不要重新从头开始。如果有未完成的工具调用，请重新发起。]',
  };
  messages.push(resumePrompt);

  // 重新激活 Agent 内层循环
  await agent.handle({ sessionId: session.session_id, messages }, adapter.send.bind(adapter));
}
```

### 悬空步骤处理

如果崩溃发生在工具执行过程中，`traces` 表里会留下一个 `status='running'` 的孤立步骤：

```typescript
function reconstructMessages(history: TraceRow[]): Message[] {
  const messages: Message[] = [];

  for (const row of history) {
    // 跳过悬空的 running 步骤（崩溃时未完成的工具调用）
    // 它们会在恢复提示词触发后由 LLM 重新决策是否发起
    if (row.status === 'running') continue;

    if (row.step_type === 'user_input') {
      messages.push({ role: 'user', content: JSON.parse(row.input_data) });
    } else if (row.step_type === 'llm_call') {
      messages.push({ role: 'assistant', content: JSON.parse(row.output_data) });
    } else if (row.step_type === 'tool_call') {
      // 把工具调用结果转回 user 消息（与第 02 节 tool output 格式一致）
      messages.push({ role: 'user', content: `tool output:\n${JSON.parse(row.output_data)}` });
    }
  }

  return messages;
}
```

**Paused 状态的特殊处理**：重连后需要重新弹出 HITL 确认提示，因为原来等待 `y/n` 的 readline 已随进程销毁。

---

## 4. 轨迹回溯与分支 (Rollback & Fork)

### 查看步骤列表：/steps

在执行 Rollback 或 Fork 之前，用户需要知道目标 step 的 ID。`/steps` 命令列出当前 session 最近的 N 个步骤（默认 10）：

```
You: /steps
步骤列表 (session: cli):
  s0001  user_input    user        "帮我分析日志"
  s0002  llm_call      llm
  s0003  tool_call     shell       {"command":"cat app.log"}
  s0004  llm_call      llm
  s0005  user_input    user        "统计 ERROR 行数"
  s0006  llm_call      llm
  s0007  tool_call     shell       {"command":"grep -c ERROR ..."}
  s0008  llm_call      llm

用法:
  /rollback s0005   回到该步骤之前重新执行
  /fork s0005       从该步骤分叉新会话（原会话保留）
```

step ID 格式为 `s0001`、`s0002`……按 session 内顺序编号，重启后不会重置（从 DB 继续累计）。

### Rollback：原地时光倒流

用户发现 Agent 从某一步开始走偏（例如进错了目录，在里面打转了 5 轮），要求退回：

```typescript
async function rollback(sessionId: string, targetStepId: string) {
  // 找到目标步骤的时间戳
  const target = db.get(`SELECT start_time FROM traces WHERE step_id=?`, [targetStepId]);

  db.transaction(() => {
    // 抹除目标步骤之后的所有记录
    db.run(
      `DELETE FROM traces WHERE session_id=? AND start_time >= ?`,
      [sessionId, target.start_time]
    );
    // 状态机重置为 Running，等待用户重新输入
    db.run(
      `UPDATE sessions SET current_status='Running', updated_at=? WHERE session_id=?`,
      [Date.now(), sessionId]
    );
  })();
}
```

**Rollback 只能撤销"记忆"，不能撤销副作用。** 如果 Agent 在被回滚的步骤里已经发送了邮件、写了文件、调用了支付接口，这些现实世界的副作用无法撤回。与第 05 节沙箱结合（沙箱文件系统支持快照），才能做到环境与记忆的同步回滚。

### Fork：平行宇宙探索

Rollback 会销毁失败现场。如果用户希望**保留失败现场**作为参照，同时在新分支上尝试不同策略：

```typescript
async function fork(originalSessionId: string, targetStepId: string, newTitle: string) {
  const newSessionId = `fork_${originalSessionId}_${Date.now()}`;
  const target = db.get(`SELECT start_time FROM traces WHERE step_id=?`, [targetStepId]);

  db.transaction(() => {
    // 1. 原 session 完全不动（失败现场完整保留）
    // 2. 克隆一个新 session，标记 is_forked=1 和 parent_session_id 溯源
    db.run(
      `INSERT INTO sessions (session_id, title, current_status, created_at, updated_at, is_forked, parent_session_id)
       VALUES (?, ?, 'Init', ?, ?, 1, ?)`,
      [newSessionId, newTitle, Date.now(), Date.now(), originalSessionId]
    );
    // 3. 截止目标步骤的历史全量复制到新 session
    db.run(
      `INSERT INTO traces (step_id, session_id, parent_step_id, step_type, name, status,
                           input_data, output_data, start_time, end_time)
       SELECT 'fork_' || step_id, ?, parent_step_id, step_type, name, status,
              input_data, output_data, start_time, end_time
       FROM traces
       WHERE session_id=? AND start_time <= ?`,
      [newSessionId, originalSessionId, target.start_time]
    );
  })();

  return newSessionId;
}
```

Fork 完成后，用户在新 session 里重新提需求（可以附上修正说明），Agent 在全新分支上探索，两条路径可以并排对比结果。

### Rollback vs Fork 对比

| 维度 | Rollback | Fork |
|------|---------|------|
| **原 session** | 脏步骤被删除，原 session 继续 | **原 session 不动**，完整保留失败现场 |
| **新 session** | 无，在原 session 上重试 | 创建新 session，`is_forked=1` 标记溯源 |
| **使用场景** | 确定走错了，直接原地重来 | 不确定对错，想并行对比两种策略 |
| **副作用** | 内存回滚，现实副作用不可撤 | 同上，Fork 不影响任何已执行的操作 |

---

## 架构全景

```
第 05 节                              第 06 节

index.ts                              index.ts
  ├─ Agent                    →         ├─ Agent（主循环不变）
  │   └─ sessions: Map<>      →         │   └─ db.loadSession() / db.appendTrace()
  ├─ Gateway                            ├─ Gateway
  │   └─ dispatch()           →         │   └─ dispatch() + handleReconnect()
  └─ Channels                           ├─ Channels
                                        └─ db.ts  ← 新增：SQLite 持久化层
                                              ├─ sessions 表（状态机）
                                              └─ traces 表（执行轨迹）

增加能力：
  进程重启 → sessions 从 DB 加载，历史完整恢复
  网页刷新 → 按 current_status 决定恢复模式
  走错路   → Rollback 删除脏步骤 / Fork 开辟新分支
  多 Agent → parent_step_id 串联树状轨迹，Debug 不串线
```

---

## 知识点总结

| 知识点 | 说明 |
|--------|------|
| **JSON 文件 vs SQLite** | JSON 文件写到一半崩溃即损坏；SQLite 事务原子性保证崩溃后状态干净可恢复 |
| **状态先落地，副作用后发生** | INSERT trace + UPDATE status 先 Commit，再调用工具。颠倒顺序会产生"工具执行但无记录"的脏数据 |
| **messages[] 与 traces 双轨并存** | messages[] 是给 LLM 的上下文窗口；traces 是给人和系统的审计档案。两者共存，职责不同 |
| **parent_step_id 树状追踪** | 多 Agent 场景下扁平日志会串线；树状结构让每条探索路径独立可溯源 |
| **两种重连模式** | Running/Paused → 恢复执行（重构 messages[] + 注入恢复提示词）；Success/Failed → 只读历史（不触发 LLM） |
| **恢复提示词** | Actionable Resume 必须注入 `[System: 中断后请继续执行]`，否则 LLM 误以为任务已完成，输出总结而非继续 |
| **悬空步骤** | `status='running'` 的孤立 trace 是崩溃现场；重连时跳过，由 LLM 重新决策是否补发工具调用 |
| **Rollback vs Fork** | Rollback 销毁失败现场原地重试；Fork 保留失败现场克隆新分支，`parent_session_id` 记录溯源 |
| **Rollback 的局限** | 只能撤销"记忆"，无法撤销现实副作用（邮件、文件、支付）；真正的时空倒流需配合沙箱快照（第 05 节） |

---

## 试一试

```bash
cd sections/06-state-management/nodejs
cp .env.example .env
# 确认 .env 中 API_KEY 正确
npm install
npm start
```

```bash
# golang
cd sections/06-state-management/golang
cp .env.example .env
go run .
```

**Terminal 2（CLI 客户端）**

```bash
# nodejs
node --env-file=.env src/cli.ts

# golang
go run ./cmd/cli
```

> **nodejs / golang CLI**：首次启动在当前目录生成 `.cli_session` 文件保存 session ID，重启后自动续接同一 session。想开新 session，删除 `.cli_session` 再重启。

### 验证断点重连

```
# 对话几轮，然后 Ctrl+C 杀掉主进程
You: 帮我列出当前目录下的所有 .ts 文件
xclaw uses [shell]: {"command":"find . -name '*.ts' ..."}
xclaw: 找到以下文件：...

You: 统计每个文件的行数
xclaw uses [shell]: {"command":"wc -l ..."}
^C  ← 这里杀进程

# 重启主进程，重新启动 CLI（session ID 不变，来自 .cli_session）
[history] ── 以下为历史消息 ──
[history] You: 帮我列出当前目录下的所有 .ts 文件
[history] xclaw: 找到以下文件：...
[history] You: 统计每个文件的行数
[history] xclaw: ...
[history] ── 以上为历史消息 ──
You: ▌  ← 可以继续对话，上下文完整
```

### 验证状态机（崩溃场景）

```
# 触发一个多步工具调用，在工具执行中途 kill -9 进程
You: 执行 sleep 10 然后告诉我结果

# 另一个终端执行 kill -9 <pid>

# 重启后重连：期望 Agent 能识别到"上次工具未完成"
# 并在恢复提示词触发下重新决策
[resume] detected interrupted tool_call, retrying...
xclaw uses [shell]: {"command":"sleep 10"}
```

### 验证 Rollback

```
You: 帮我创建 a.txt
xclaw: 已创建 a.txt

You: 帮我创建 b.txt
xclaw: 已创建 b.txt

# 先用 /steps 查看步骤编号
You: /steps
步骤列表 (session: cli):
  s0001  user_input    user    "帮我创建 a.txt"
  s0002  llm_call      llm
  s0003  tool_call     write_file  {"path":"a.txt"...}
  s0004  llm_call      llm
  s0005  user_input    user    "帮我创建 b.txt"
  s0006  llm_call      llm
  s0007  tool_call     write_file  {"path":"b.txt"...}
  s0008  llm_call      llm

用法:
  /rollback s0005   回到该步骤之前重新执行
  /fork s0005       从该步骤分叉新会话（原会话保留）

You: /rollback s0005
[rollback] session reset to before step s0005 — send your new instruction

You: 这里重新来，帮我创建 c.txt  ← b.txt 的记忆已不存在
xclaw: 已创建 c.txt
```

### 验证 Fork

```
You: /steps
步骤列表 (session: web-abc123):
  s0001  user_input  user  "帮我重构 readFile 函数"
  s0002  llm_call    llm
  s0003  tool_call   edit_file  {"path":"tools.go"...}
  ...

You: /fork s0002 方案A-io流式读
[fork] new session created: fork_a1b2c3
connect with this session ID to continue on the forked branch.
original session web-abc123 is unchanged.

# Web 端切换到新 session：浏览器控制台执行
# localStorage.setItem('xclaw_session_id', 'fork_a1b2c3')
# 刷新页面，历史恢复到 s0002，继续探索新策略
# 原 session web-abc123 完整保留，两条路径可并排对比
```
