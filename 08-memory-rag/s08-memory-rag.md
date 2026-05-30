# 第 08 节：长短期记忆系统 (Memory & RAG)

> "LLM 的 context window 是工作记忆——容量有限，关机即失；向量数据库是长期记忆——无限扩展，随时召回。Agent 需要两者的结合。"

## 本节改动全景

相比第 07 节，本节的改动集中在记忆层，Agent 主循环与浏览器工具**完全不变**：

| 改动点 | 第 07 节 | 第 08 节 |
|--------|---------|---------|
| 记忆范围 | LLM context window（会话内） | + 向量存储（跨会话持久化） |
| 遗忘机制 | 超窗口后 context.ts 截断 | + 主动提取 + 相似度召回 |
| 新增工具 | 无 | `memory_save` / `memory_search` / `kb_index` / `kb_search` |
| 新增模块 | 无 | `memory.ts`（MemoryStore 接口 + 两种后端实现）<br>`knowledgebase.ts`（文档切片 + 批量索引） |
| Agent 主循环 | 不变 | **不变**（记忆注入发生在 assembleContext 之前） |
| DB 层 | sessions + traces | + memories 表（id / session_id / source / content / embedding） |

**这一节的核心设计思想**：记忆层是透明的玻璃——Agent 主循环不感知"这是记忆调用还是知识库查询"，照常 `{"action":"memory_save"}` 发起；记忆层封装了所有 Embedding 和向量检索的细节。

**本节涵盖两种独立但技术同源的能力**：

```
Agent 长期记忆                       企业知识库 RAG
────────────────────                 ────────────────────
运行时动态写入                        离线批量索引
个人偏好 / 对话摘要                   外部文档（PDF/Wiki/代码）
百~千条记忆片段                       万~百万条文档 chunk
Agent 自身调用写入                    管理员 / kb_index 工具写入

           ↓                                   ↓
        共用同一套技术管道
  Embed → 向量存储 → 余弦/ANN 检索 → 注入 system prompt
```

---

## 为什么需要长期记忆

前 7 节的 Agent 状态全部活在 context window 里。会话一关，记忆归零。

```
第一次会话：
  用户：我的代码风格是 TypeScript，2 空格缩进，不用分号
  Agent：好的，我记住了。

（关闭会话，第二天重新打开）

第二次会话：
  用户：帮我写一个 HTTP 请求模块
  Agent：（写出 Python 代码，4 空格缩进）   ← 完全忘记用户偏好
```

对比有记忆层的 Agent：

```
第二次会话（有记忆层）：
  [系统] 自动召回相关记忆：用户使用 TypeScript，2 空格缩进，不用分号
  Agent：（写出正确风格的 TypeScript 代码）  ✓
```

除了个人偏好，还有两类场景是纯 context window 无法解决的：

```
场景 A — 知识超出 context window
  公司内部有 500 份 API 文档、数百页运维手册。
  塞进 context 不仅超出限制，每次调用还要付出巨额 token 成本。
  → 知识库 RAG：只把与当前问题相关的 3-5 个片段注入，其余不动。

场景 B — 信息跨越多个会话积累
  Agent 用了三个月，参与了 50 个项目的代码评审。
  这些经验判断力无法从单次会话中获得。
  → Agent 长期记忆：每次会话结束后提炼要点，下次自动带入。
```

**短期记忆 vs 长期记忆对比**：

| 维度 | 短期记忆（context window） | 长期记忆（向量存储） |
|------|--------------------------|-------------------|
| 范围 | 单次会话 | 跨会话持久化 |
| 容量 | 受限（~200K token） | 理论无限 |
| 写入 | 自动（每轮对话） | 主动提取（Agent 调 memory_save）|
| 读取 | 全量（付出完整 token 代价） | 按需召回（相似度 top-K）|
| 遗忘 | 截断（context.ts truncate）| 不遗忘（除非主动删除）|
| 速度 | 即时 | 毫秒级（本地）/ 网络延迟（Milvus）|

---

## 1. 核心概念：Embedding 与语义搜索

### 什么是 Embedding

文本无法直接做"距离计算"——"苹果手机"和"iPhone"字面上完全不同，但语义相近。Embedding 把文本映射到高维向量空间，让语义相近的文本在空间中距离也近：

```
"苹果手机" → [0.82, 0.13, -0.45, 0.67, ...]  ← 1536 维向量
"iPhone"   → [0.80, 0.15, -0.43, 0.65, ...]  ← 非常接近
"香蕉"     → [0.12, 0.71,  0.23, -0.31, ...] ← 距离很远
```

### 余弦相似度

衡量两个向量方向的一致程度，与向量长度无关：

```typescript
// 1.0 = 完全相同，0 = 无关，-1 = 完全相反
function cosineSimilarity(a: number[], b: number[]): number {
  const dot   = a.reduce((sum, ai, i) => sum + ai * b[i]!, 0);
  const normA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const normB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return normA && normB ? dot / (normA * normB) : 0;
}
```

为什么用余弦而非欧氏距离？文本 Embedding 的长度受文本长度影响，方向才反映语义。一篇长文章和同内容的摘要，方向相近但长度差异大——余弦相似度正确，欧氏距离错误。

### Embedding API 调用

```typescript
// memory.ts — 复用项目已有的 OpenAI 配置（providers/ 层已有 baseURL/apiKey）
async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',   // 1536 维，$0.02/1M tokens
    input: text.slice(0, 8192),        // API 有输入长度限制
  });
  return res.data[0]!.embedding;
}
```

常用 Embedding 模型选型：

| 模型 | 模态支持 | 上下文窗口 | 默认维度 | 部署方式 | 核心优势场景 |
|------|---------|-----------|---------|---------|------------|
| text-embedding-3-small | 纯文本 | 8K tokens | 1536（支持裁剪） | 闭源 API | 低成本、高并发的常规 RAG 任务 |
| text-embedding-3-large | 纯文本 | 8K tokens | 3072（支持裁剪） | 闭源 API | 传统文本检索、对稳定性要求极高的商业项目 |
| Qwen3-Embedding-8B | 纯文本 | 32K tokens | 4096（支持自定义） | 开源可自托管 | 多语言 / 跨语言检索、长文档 RAG |
| Colnomic-embed-multimodal-7B | 多模态（文 / 图 / PDF / 图表） | 高上下文（基于 ColBERT 多向量） | 多向量表示（Late Interaction） | 开源可自托管 | 复杂 PDF、扫描件、财报图表的精细化文档检索 |
| Qwen3-VL-Embedding-8B | 多模态（文 / 图 / 视频 / 混合） | 32K tokens | 4096（支持自定义） | 开源可自托管 | 视频片段检索、跨模态多任务聚类、复杂图文 RAG |

模型通过 `.env` 中的 `OPENAI_EMBEDDING_MODEL` 切换，OpenAI 兼容接口（如本地部署的 Qwen3-Embedding）同样适用，无需改代码：

```bash
# .env — 切换 embedding 模型
OPENAI_API_BASE_URL=http://localhost:11434/v1   # 本地 Ollama / vLLM
OPENAI_EMBEDDING_MODEL=qwen3-embedding-8b
```

**闭源 API 成本估算**：10,000 条记忆 × 平均 100 token/条 = 100 万 token → text-embedding-3-small $0.02，可忽略不计。

---

## 2. MemoryStore 接口：统一后端，可插拔切换

**关键设计**：Agent 记忆和知识库 RAG 使用同一个 `MemoryStore` 接口，通过 `source` 字段区分来源，后端实现（SQLite / Milvus）对上层透明。

```typescript
// memory.ts
export interface MemoryEntry {
  id: string;
  sessionId: string;       // 所属会话（全局记忆如用户偏好可设为 'global'）
  source: 'agent' | 'kb'; // Agent 记忆 vs 知识库文档
  docId?: string;          // 知识库条目的原始文档标识
  content: string;         // 原始文本
  embedding: number[];     // 向量（SQLite 中 JSON 序列化存储）
  tags: string[];          // 可选标签，用于过滤
  createdAt: number;
}

export interface MemoryStore {
  save(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<string>;
  search(
    queryEmbedding: number[],
    topK: number,
    filter?: { source?: 'agent' | 'kb'; sessionId?: string; docId?: string },
  ): Promise<MemoryEntry[]>;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}
```

### 2.1 SQLite 实现（零依赖）

向量 JSON 序列化存 TEXT，检索时全量加载到 JS 内存做余弦排序。简单直接，无需额外服务：

```typescript
// memory.ts — SQLiteMemoryStore
export class SQLiteMemoryStore implements MemoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        source      TEXT NOT NULL DEFAULT 'agent',
        doc_id      TEXT,
        content     TEXT NOT NULL,
        embedding   TEXT NOT NULL,   -- JSON 序列化的 number[]
        tags        TEXT DEFAULT '[]',
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mem_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_mem_source  ON memories(source);
    `);
  }

  async save(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<string> {
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO memories (id, session_id, source, doc_id, content, embedding, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, entry.sessionId, entry.source, entry.docId ?? null,
      entry.content, JSON.stringify(entry.embedding),
      JSON.stringify(entry.tags ?? []), Date.now(),
    );
    return id;
  }

  async search(
    queryEmbedding: number[],
    topK: number,
    filter?: { source?: 'agent' | 'kb'; sessionId?: string; docId?: string },
  ): Promise<MemoryEntry[]> {
    // 构建 WHERE 子句
    const conditions: string[] = [];
    const args: (string | null)[] = [];
    if (filter?.source)    { conditions.push('source = ?');     args.push(filter.source); }
    if (filter?.sessionId) { conditions.push('session_id = ?'); args.push(filter.sessionId); }
    if (filter?.docId)     { conditions.push('doc_id = ?');     args.push(filter.docId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = this.db.prepare(`SELECT * FROM memories ${where}`).all(...args) as any[];

    // 全量余弦排序（< 50K 条时 < 50ms）
    return rows
      .map(r => ({
        id: r.id, sessionId: r.session_id, source: r.source as 'agent' | 'kb',
        docId: r.doc_id ?? undefined, content: r.content,
        embedding: JSON.parse(r.embedding) as number[],
        tags: JSON.parse(r.tags) as string[], createdAt: r.created_at,
        _score: cosineSimilarity(queryEmbedding, JSON.parse(r.embedding) as number[]),
      }))
      .sort((a, b) => b._score - a._score)
      .slice(0, topK);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
```

**性能边界**：
- 10,000 条 × 1536 维 ≈ 60 MB 内存，全量余弦排序 < 50ms
- 50,000 条以上建议切换 Milvus

### 2.2 Milvus 实现（ANN 索引）

适合生产环境、多用户、知识库百万级文档：

```typescript
// memory.ts — MilvusMemoryStore
import { MilvusClient, DataType } from '@zilliz/milvus2-sdk-node';

export class MilvusMemoryStore implements MemoryStore {
  private client: MilvusClient;
  private readonly collection = 'xclaw_memories';

  constructor(address: string) {
    this.client = new MilvusClient({ address });
  }

  async init(): Promise<void> {
    await this.client.createCollection({
      collection_name: this.collection,
      fields: [
        { name: 'id',          data_type: DataType.VarChar,     is_primary_key: true, max_length: 36 },
        { name: 'session_id',  data_type: DataType.VarChar,     max_length: 64 },
        { name: 'source',      data_type: DataType.VarChar,     max_length: 8 },
        { name: 'doc_id',      data_type: DataType.VarChar,     max_length: 128 },
        { name: 'content',     data_type: DataType.VarChar,     max_length: 4096 },
        { name: 'tags',        data_type: DataType.VarChar,     max_length: 512 },
        { name: 'created_at',  data_type: DataType.Int64 },
        { name: 'embedding',   data_type: DataType.FloatVector, dim: 1536 },
      ],
    });
    // HNSW 索引：M=16 控制图的连通性，efConstruction=200 控制构建精度
    await this.client.createIndex({
      collection_name: this.collection,
      field_name: 'embedding',
      index_type: 'HNSW',
      metric_type: 'COSINE',
      params: { M: 16, efConstruction: 200 },
    });
    await this.client.loadCollection({ collection_name: this.collection });
  }

  async search(
    queryEmbedding: number[],
    topK: number,
    filter?: { source?: string; sessionId?: string; docId?: string },
  ): Promise<MemoryEntry[]> {
    const exprs: string[] = [];
    if (filter?.source)    exprs.push(`source == "${filter.source}"`);
    if (filter?.sessionId) exprs.push(`session_id == "${filter.sessionId}"`);
    if (filter?.docId)     exprs.push(`doc_id == "${filter.docId}"`);

    const results = await this.client.search({
      collection_name: this.collection,
      vectors: [queryEmbedding],
      output_fields: ['id', 'session_id', 'source', 'doc_id', 'content', 'tags', 'created_at'],
      limit: topK,
      expr: exprs.length ? exprs.join(' && ') : undefined,
    });
    return results.results.map(r => ({
      id: r.id, sessionId: r.session_id, source: r.source as 'agent' | 'kb',
      docId: r.doc_id || undefined, content: r.content,
      embedding: [], tags: JSON.parse(r.tags ?? '[]'), createdAt: Number(r.created_at),
    }));
  }

  // save / delete 实现类似，略
  async save(_entry: any): Promise<string> { /* ... */ return ''; }
  async delete(_id: string): Promise<void> { /* ... */ }
  async close(): Promise<void> { await this.client.closeConnection(); }
}
```

**HNSW 参数说明**：

| 参数 | 作用 | 推荐值 |
|------|------|-------|
| `M` | 每个节点的最大连边数，越大精度越高、内存越多 | 16（通用）|
| `efConstruction` | 构建时的搜索深度，越大精度越高、构建越慢 | 200（通用）|
| 搜索时 `ef` | 查询时的候选集大小，越大精度越高、越慢 | 64-128 |

**SQLite vs Milvus 选型对比**：

| 维度 | SQLite + 余弦 | Milvus HNSW |
|------|-------------|------------|
| 外部依赖 | 无（node:sqlite 内置） | Docker / Milvus 独立服务 |
| 算法复杂度 | O(n) 全量扫描 | O(log n) ANN 近似 |
| 精确度 | 100% 精确 | ANN 近似（召回率 >95%）|
| 规模上限 | ~50K 条（< 50ms） | 百万级无压力 |
| 运维成本 | 零 | 需维护独立进程 |
| 适用场景 | 开发 / 个人 / 小团队 | 生产 / 多用户 / 大规模知识库 |

### 2.3 工厂函数（Config 驱动切换）

```typescript
// memory.ts
export function createMemoryStore(cfg: Config): MemoryStore {
  if (cfg.memory.backend === 'milvus') {
    return new MilvusMemoryStore(cfg.memory.milvus.address);
  }
  return new SQLiteMemoryStore(cfg.state.dbPath); // 默认：零依赖本地
}
```

```yaml
# xclaw.yaml — 切换后端只改这一行
memory:
  backend: sqlite      # 或 milvus
  milvus:
    address: localhost:19530
  topK: 5              # 每次召回条数
```

---

## 3. Agent 长期记忆

### 3.1 记忆注入流程

每次用户发消息，在构建 LLM 上下文之前，先用消息语义召回相关记忆注入 system prompt：

```
用户发送消息
    │
    ▼
embed(msg.content)              ← 将用户消息向量化
    │
    ▼
memoryStore.search(topK=5,      ← 语义召回（source: 'agent'）
  source: 'agent')
    │
    ▼
buildSystemPrompt(recalled)     ← 注入 system prompt 末尾
    │
    ▼
LLM 调用（带记忆上下文）
```

注入位置选择 system prompt 末尾，而非 user message——避免污染对话历史，也避免 LLM 把记忆当用户说的话处理：

```typescript
// agent.ts — handle() 方法，在构建 messages 之前
const recalled = await recallAgentMemories(msg.content, memoryStore);
const systemPrompt = buildSystemPrompt(recalled);

// ...
if (!this.sessions.has(msg.sessionId)) {
  this.sessions.set(msg.sessionId, [{ role: 'system', content: systemPrompt }]);
}
```

```typescript
// agent.ts
async function recallAgentMemories(query: string, store: MemoryStore): Promise<string> {
  const embedding = await embed(query);
  const results = await store.search(embedding, 5, { source: 'agent' });
  if (results.length === 0) return '';
  return results.map(r => `- ${r.content}`).join('\n');
}

export function buildSystemPrompt(memoryContext = ''): string {
  const base = `You are xclaw...（原有 system prompt 内容）`;
  if (!memoryContext) return base;
  return `${base}

## 相关历史记忆
${memoryContext}
（以上为与本次对话相关的历史记忆，请在回答中自然参考，无需引用编号）`;
}
```

### 3.2 记忆工具

```typescript
// tools.ts — memory_save
registerTool(
  {
    name: 'memory_save',
    description: '将重要事实、用户偏好、项目背景保存到长期记忆，以便在未来会话中自动召回。适合保存：用户的技术栈偏好、代码风格要求、项目背景信息、重要决策结论。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要记住的内容，1-3 句话，简洁完整，包含足够上下文' },
        tags:    { type: 'string', description: 'JSON 数组格式的标签，如 ["preference","typescript"]' },
      },
      required: ['content'],
    },
  },
  async (sessionId, params) => {
    const embedding = await embed(params['content']!);
    const id = await memoryStore.save({
      sessionId,
      source: 'agent',
      content: params['content']!,
      embedding,
      tags: JSON.parse(params['tags'] ?? '[]'),
    });
    return `memory saved: ${id}`;
  },
);

// tools.ts — memory_search
registerTool(
  {
    name: 'memory_search',
    description: '语义搜索长期记忆，返回与查询最相关的历史记录。用于主动查询历史信息，日常召回由系统自动处理。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询文本' },
        top_k: { type: 'string', description: '返回条数（默认 5）' },
      },
      required: ['query'],
    },
  },
  async (_sessionId, params) => {
    const embedding = await embed(params['query']!);
    const results = await memoryStore.search(
      embedding,
      parseInt(params['top_k'] ?? '5', 10),
      { source: 'agent' },
    );
    if (results.length === 0) return 'no relevant memories found';
    return results.map((r, i) => `[${i + 1}] ${r.content}`).join('\n');
  },
);
```

system prompt 中需要告知 Agent 何时主动保存记忆：

```
## 记忆指南
当用户提到以下信息时，主动调用 memory_save 保存：
- 技术栈偏好（语言、框架、工具）
- 代码风格要求（缩进、命名、格式）
- 项目背景和目标
- 重要决策和结论
每条记忆应包含足够上下文，使其在未来会话中独立可读。
```

### 3.3 三种记忆写入策略

| 策略 | 触发时机 | 适用场景 |
|------|---------|---------|
| **主动保存**（Agent 调 `memory_save`） | LLM 判断值得保存时 | 用户偏好、项目决策、不变事实 |
| **自动提取**（Session 结束后） | status 变为 Success | 长会话结束后的要点摘要 |
| **显式命令**（用户说"记住这个"） | 用户明确指令 | 用户主导的记忆管理 |

### 3.4 自动记忆提取 Pipeline

不依赖 Agent 自觉调用 `memory_save`，会话结束后用 LLM 从对话历史中蒸馏重要事实：

```typescript
// memory.ts — extractAndSaveMemories
export async function extractAndSaveMemories(
  messages: Message[],
  sessionId: string,
  provider: Provider,
  store: MemoryStore,
): Promise<void> {
  const history = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : '[image]'}`)
    .join('\n');

  if (history.length < 200) return; // 对话太短，无需提取

  const extractPrompt = `从以下对话中提取值得长期记住的事实（用户偏好、项目设定、重要决策）。
每条一行，以 "- " 开头，最多 10 条，简洁完整（每条含足够上下文），无关紧要的内容不要提取：

${history}`;

  const raw = await provider.chat([{ role: 'user', content: extractPrompt }]);
  const lines = raw.split('\n').filter(l => l.trim().startsWith('- '));

  for (const line of lines) {
    const content = line.replace(/^-\s*/, '').trim();
    if (content.length < 15) continue; // 过短的条目丢弃
    const embedding = await embed(content);
    await store.save({ sessionId, source: 'agent', content, embedding, tags: ['auto-extracted'] });
  }
}
```

在 `agent.ts` 中，Session 成功完成后异步触发（不阻塞回复）：

```typescript
// agent.ts — handle() 方法末尾
if (this.db) this.db.setStatus(msg.sessionId, 'Success');
this.sessions.set(msg.sessionId, messages);

// 异步提取，不 await，不阻塞当前会话
extractAndSaveMemories(messages, msg.sessionId, currentProvider, this.memoryStore)
  .catch(e => warn(`[memory] extraction failed: ${e.message}`));

return reply;
```

### 3.5 与第 06 节 traces 表的关系

第 06 节引入的 `traces` 表和本节的 `memories` 表都持久化了"对话发生过什么"，但服务完全不同的目的：

| 维度 | s06 `traces` 表 | s08 `memories` 表 |
|------|----------------|------------------|
| **存什么** | 每一步的完整输入/输出（verbatim） | 提炼后的语义事实（distilled） |
| **为什么存** | 崩溃恢复、回滚、Fork | 跨会话语义召回 |
| **访问方式** | 按时间顺序重放（`loadMessages`） | 按语义相似度检索（向量 top-K） |
| **生命周期** | 会话范围内（跨 restart 可恢复） | 跨会话长期持久 |
| **体量** | 全量（每个 tool_call、llm_call 都记录） | 精选（每次会话最多十几条）|

两者之间存在一条数据流——**`traces` 是原料，`memories` 是精华**：

```
s06 traces 表（原始日志）
    │
    │  Session status → 'Success'
    │  db.loadMessages(sessionId) 重建完整对话历史
    │         │
    │         ▼
    │  extractAndSaveMemories(messages, ...)
    │  用 LLM 从对话历史中蒸馏重要事实
    │
    ▼
s08 memories 表（语义知识）
    │
    ▼
下次会话：embed(query) → search() → 注入 system prompt
```

`extractAndSaveMemories()` 接收的 `messages` 参数正是 `db.loadMessages()` 从 traces 表重建出来的对话历史——第 06 节的持久化基础设施直接喂养了第 08 节的记忆提取 Pipeline。

类比：`traces` 是服务器 access.log（全量、逐行、用于回放调试），`memories` 是工程师的个人笔记（提炼后的关键点、随时语义查找）。

---

## 4. 企业知识库 RAG

### 4.1 与 Agent 记忆的关键差异

两者技术栈完全相同，区别在于"谁写入、写什么、何时写"：

| 维度 | Agent 长期记忆 | 企业知识库 RAG |
|------|--------------|--------------|
| 数据来源 | Agent 运行过程中产生 | 外部文档（PDF / Markdown / Wiki）|
| 写入时机 | 实时（对话中 / Session 结束） | 离线批量索引 |
| 数据规模 | 百~千条短片段 | 万~百万条文档 chunk |
| 写入者 | Agent 自身 | 管理员 / `kb_index` 工具 |
| 更新频率 | 频繁（随对话增长） | 低频（文档变更时重新索引）|
| `source` 字段 | `'agent'` | `'kb'` |

### 4.2 文档切片（Chunking）

原始文档不能整体 embed——一篇 50 页的 PDF embed 成一个向量，语义太宽泛，"在第 23 页提到的 rate limit"这类具体问题无法命中。

必须切成合适大小的 chunk，每个 chunk 语义聚焦，可以独立回答一个具体问题：

```
原始 PDF（50 页，约 25000 字）
    │
    ▼
文本提取（fs.readFile / pdf-parse）
    │
    ▼
chunkText()：固定大小滑动窗口切片
    │
    ├── chunk 1：第 1-512 token（含 64 token 尾部）
    ├── chunk 2：第 448-960 token（前 64 token 与 chunk 1 重叠）
    ├── chunk 3：第 896-1408 token
    └── ...
    │
    ▼
每个 chunk → embed() → memoryStore.save(source: 'kb')
```

**重叠（overlap）的作用**：

```
chunk 1 末尾："...用户可以通过 API 调用来触发工作流。工作流"
chunk 2 开头："工作流支持并行步骤和条件分支，每个步骤..."

没有重叠 → chunk 2 开头的"工作流"语境丢失，LLM 不知道指什么
有重叠  → chunk 2 保留上下文，独立可读，召回时 LLM 理解语境
```

```typescript
// knowledgebase.ts — 文档切片
export function chunkText(
  text: string,
  maxTokens = 512,
  overlapTokens = 64,
): string[] {
  const charsPerToken = 4; // 粗估：1 token ≈ 4 个英文字符 / 1.5 个中文字符
  const maxChars     = maxTokens    * charsPerToken;
  const overlapChars = overlapTokens * charsPerToken;

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (end === text.length) break;
    start = end - overlapChars; // 滑动窗口：保留尾部 overlap
  }
  return chunks;
}
```

**切片策略对比**：

| 策略 | 实现 | 优点 | 缺点 |
|------|------|------|------|
| 固定大小 + 重叠 | `chunkText()`（本节实现） | 简单，适合密集文本 | 可能在句子中间切断 |
| 段落切片 | 按 `\n\n` 分割 | 保持段落完整 | 段落长度不均，长段超限 |
| 递归字符切片 | 优先 `\n\n`，退化到 `\n`，再退化到 `. ` | 兼顾结构 + 长度 | 实现稍复杂 |
| 语义切片 | 用 LLM 判断边界 | 最精准 | 成本高，速度慢 |

### 4.3 批量索引文档

```typescript
// knowledgebase.ts — 索引单个文档
export async function indexDocument(
  filePath: string,
  docId: string,
  store: MemoryStore,
): Promise<{ docId: string; chunks: number }> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const chunks = chunkText(raw);

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embed(chunks[i]!);
    await store.save({
      sessionId: 'global',   // 知识库记录不属于特定会话
      source: 'kb',
      docId,
      content: chunks[i]!,
      embedding,
      tags: [docId, `chunk-${i}`],
    });
  }

  return { docId, chunks: chunks.length };
}
```

### 4.4 知识库工具

```typescript
// tools.ts — kb_index
registerTool(
  {
    name: 'kb_index',
    description: '将文件批量索引到知识库，建立语义检索能力。支持 .txt / .md 等文本格式，索引后可用 kb_search 检索。',
    parameters: {
      type: 'object',
      properties: {
        path:   { type: 'string', description: '文件路径（workspace 内）' },
        doc_id: { type: 'string', description: '文档唯一标识符，用于后续按文档过滤检索' },
      },
      required: ['path', 'doc_id'],
    },
  },
  async (_sessionId, params) => {
    const abs = canonicalize(params['path']!, workDir);
    const result = await indexDocument(abs, params['doc_id']!, memoryStore);
    return `indexed ${result.chunks} chunks from ${params['path']} (doc_id: ${result.docId})`;
  },
);

// tools.ts — kb_search
registerTool(
  {
    name: 'kb_search',
    description: '在知识库中语义搜索，返回最相关的文档片段。适合从已索引文档中查找具体信息。',
    parameters: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: '查询问题或关键词' },
        top_k:  { type: 'string', description: '返回条数（默认 5）' },
        doc_id: { type: 'string', description: '限定在特定文档内检索（可选）' },
      },
      required: ['query'],
    },
  },
  async (_sessionId, params) => {
    const embedding = await embed(params['query']!);
    const results = await memoryStore.search(
      embedding,
      parseInt(params['top_k'] ?? '5', 10),
      { source: 'kb', docId: params['doc_id'] },
    );
    if (results.length === 0) return 'no relevant documents found';
    return results
      .map((r, i) => `[${i + 1}] (doc: ${r.docId})\n${r.content}`)
      .join('\n\n');
  },
);
```

### 4.5 双路召回：Agent 记忆 + 知识库并行

```
用户发送消息："用 TypeScript 帮我写一个遵循 API 文档限制的请求模块"
    │
    ├── 并行召回 ①：Agent 记忆（source: 'agent'）
    │     → 用户使用 TypeScript，2 空格缩进，不用分号
    │
    └── 并行召回 ②：知识库（source: 'kb'）
          → [api-ref] 每分钟最多 60 次请求，超出返回 429...
          → [api-ref] 建议使用指数退避重试策略...
    │
    ▼
合并注入 system prompt：

  ## 相关历史记忆
  - 用户使用 TypeScript，2 空格缩进，不用分号

  ## 相关文档
  [1] (doc: api-ref) 每分钟最多 60 次请求...
  [2] (doc: api-ref) 建议使用指数退避重试策略...

    │
    ▼
LLM 生成：包含 rate limit 处理逻辑的 TypeScript 代码，2 空格缩进，无分号 ✓
```

```typescript
// agent.ts — 双路并行召回
async function buildContextWithMemory(
  query: string,
  memoryStore: MemoryStore,
): Promise<string> {
  const embedding = await embed(query);

  // 并行召回两个来源
  const [agentMemories, kbChunks] = await Promise.all([
    memoryStore.search(embedding, 5, { source: 'agent' }),
    memoryStore.search(embedding, 5, { source: 'kb'    }),
  ]);

  const parts: string[] = [];

  if (agentMemories.length > 0) {
    parts.push('## 相关历史记忆\n' + agentMemories.map(r => `- ${r.content}`).join('\n'));
  }
  if (kbChunks.length > 0) {
    parts.push(
      '## 相关文档\n' +
      kbChunks.map((r, i) => `[${i + 1}] (doc: ${r.docId})\n${r.content}`).join('\n\n'),
    );
  }

  return parts.join('\n\n');
}
```

---

## 5. 改动全景

```
第 07 节                              第 08 节

agent.ts                              agent.ts
  handle()                    →         handle()
    buildSystemPrompt()                   + buildContextWithMemory()
                                              并行召回 Agent 记忆 + KB
                                          buildSystemPrompt(memoryContext)
    agent loop（不变）                      agent loop（不变）
                                          + extractAndSaveMemories()
                                              （异步，Success 后，不阻塞回复）

tools.ts                              tools.ts
  registerBrowserTools()      →         registerBrowserTools()（不变）
                                        + registerMemoryTools(memoryStore)
                                              memory_save  ← 主动保存偏好/事实
                                              memory_search ← 主动查询记忆
                                        + registerKBTools(memoryStore)
                                              kb_index     ← 批量索引文档
                                              kb_search    ← 知识库语义检索

memory.ts（新建）                       MemoryEntry 接口（source: 'agent'|'kb'）
                                        MemoryStore 接口
                                        SQLiteMemoryStore  ← 零依赖，余弦全量排序
                                        MilvusMemoryStore  ← ANN，百万级文档
                                        createMemoryStore(cfg) ← 工厂函数
                                        embed(text)        ← OpenAI embeddings
                                        cosineSimilarity() ← 向量相似度
                                        extractAndSaveMemories() ← 自动提取 Pipeline

knowledgebase.ts（新建）                chunkText(text, maxTokens, overlapTokens)
                                          固定大小滑动窗口切片
                                        indexDocument(filePath, docId, store)
                                          文本提取 → 切片 → 批量 embed → 存储

config.ts                             config.ts
  无 memory 字段              →         + memory:
                                            backend: 'sqlite' | 'milvus'
                                            milvus: { address: string }
                                            topK: 5

db.ts / SQLite                        db.ts / SQLite（backend=sqlite 时扩展）
  sessions + traces           →         + memories 表
                                            id / session_id / source / doc_id
                                            content / embedding / tags / created_at

index.ts                              index.ts
  browserPool.init()          →         + memoryStore = createMemoryStore(cfg)
  registerBrowserTools()                + registerMemoryTools(memoryStore)
                                        + registerKBTools(memoryStore)
  SIGINT: browserPool.closeAll()        + memoryStore.close()

增加能力：
  跨会话记忆  → memory_save + 自动提取 → 下次会话自动召回用户偏好
  语义记忆搜索 → memory_search（主动查询历史记录）
  企业文档索引 → kb_index（离线批量切片 + embed）
  知识库检索  → kb_search（语义搜索文档片段）
  双路召回    → 并行 Agent 记忆 + KB，合并注入 system prompt
  后端可插拔  → SQLite（零依赖）/ Milvus（生产级）按 config 切换
```

---

## 知识点总结

| 知识点 | 说明 |
|--------|------|
| **短期 vs 长期记忆** | context window = 工作记忆（容量限、关窗即失）；向量存储 = 长期记忆（持久、按需召回） |
| **Agent 记忆 vs 知识库 RAG** | Agent 记忆：运行时动态写入，个人偏好/历史；知识库：离线批量索引，外部文档；共用 MemoryStore 接口 |
| **Embedding** | 文本 → 高维向量；语义相近的文本向量方向相近；text-embedding-3-small 1536 维 |
| **余弦相似度** | 衡量向量方向一致程度；1 = 完全相同，0 = 无关；不受向量长度影响，优于欧氏距离 |
| **RAG 注入位置** | 召回结果注入 system prompt 末尾，而非 user message；避免污染对话历史 |
| **双路并行召回** | `Promise.all([search(agent), search(kb)])` 并行召回后合并注入；互不干扰 |
| **MemoryStore 接口** | SQLite（零依赖，O(n) 全量余弦，<50K 条）/ Milvus（O(log n) ANN，百万级）；工厂函数按 config 切换 |
| **source 字段** | `'agent'` = Agent 运行时写入；`'kb'` = 知识库离线索引；search filter 按来源隔离召回 |
| **文档切片（Chunking）** | 固定大小滑动窗口：512 token + 64 token overlap；overlap 保证跨 chunk 语义连续性 |
| **主动保存** | Agent 判断值得保存时调 `memory_save`；system prompt 中给出保存时机指南 |
| **自动提取 Pipeline** | Session Success 后异步触发；用 LLM 从对话历史蒸馏要点；不阻塞当前回复 |
| **topK 召回** | 默认 top-5；Agent 记忆片段短可用 5-10；KB chunk 较长建议 3-5；过多引入噪音 |
| **HNSW 索引** | Hierarchical Navigable Small World；M 控制图连通性，efConstruction 控制构建精度；ANN 召回率 >95%|
| **Embedding 成本** | text-embedding-3-small $0.02/1M tokens；10K 条 × 100 token ≈ $0.002，可忽略 |

---

## 试一试

```bash
cd sections/08-memory-rag/nodejs
cp .env.example .env
# 确认 .env 中 OPENAI_API_KEY 正确（用于 embedding + chat）
npm install
npm start
```

**Terminal 2（CLI 客户端）**

```bash
node --env-file=.env src/cli.ts
```

### 验证 Agent 长期记忆

```
You: 我用 TypeScript 开发，代码风格是 2 空格缩进、不用分号

xclaw uses [memory_save]: {"content":"用户使用 TypeScript 开发，代码风格：2 空格缩进，不使用分号","tags":"[\"preference\",\"code-style\"]"}
→ memory saved: a1b2c3d4-...

（Ctrl+C 停止服务，重新启动，新建会话）

You: 帮我写一个简单的 fetch 封装

（系统在 system prompt 中自动注入：
  ## 相关历史记忆
  - 用户使用 TypeScript 开发，代码风格：2 空格缩进，不使用分号）

xclaw: 这是符合你风格的 TypeScript fetch 封装：
  async function request<T>(url: string, options?: RequestInit): Promise<T> {
    const res = await fetch(url, options)    ← 无分号 ✓
    if (!res.ok) throw new Error(`HTTP ${res.status}`)  ← 2 空格缩进 ✓
    return res.json() as Promise<T>
  }
```

### 验证知识库 RAG

```
You: 先把 API 文档索引一下

xclaw uses [kb_index]: {"path":"docs/api-reference.md","doc_id":"api-ref"}
→ indexed 47 chunks from docs/api-reference.md (doc_id: api-ref)

You: API 的 rate limit 策略是什么？

xclaw uses [kb_search]: {"query":"rate limit 频率限制策略","top_k":"3","doc_id":"api-ref"}
→ [1] (doc: api-ref) 每分钟最多 60 次请求，超出限制返回 HTTP 429...
→ [2] (doc: api-ref) 建议客户端实现指数退避重试：首次等待 1s，依次翻倍...

xclaw: 根据 API 文档，rate limit 为每分钟 60 次请求。
       超出时服务器返回 429，建议实现指数退避重试策略。
```

### 验证双路召回

```
You: 帮我写一个符合我风格的 API 客户端，要处理好限流

（系统并行召回：
  Agent 记忆 → "用户 TypeScript，2 空格，无分号"
  知识库     → "rate limit 60次/min" + "指数退避重试"）

xclaw: 这是包含限流处理的 TypeScript API 客户端：

  async function apiRequest<T>(url: string, retries = 3): Promise<T> {
    for (let i = 0; i < retries; i++) {
      const res = await fetch(url)         ← 无分号 ✓，2 空格缩进 ✓
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 1000 * 2 ** i))  ← 指数退避 ✓
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<T>
    }
    throw new Error('max retries exceeded')
  }
```

### 验证自动记忆提取

```
（经过一次较长会话，Agent 完成了若干任务）
（会话结束，status → Success，异步触发提取）

[memory] extractAndSaveMemories: session cli-abc → 3 memories extracted
  - 用户正在开发名为 xclaw 的 AI Agent 框架
  - 项目使用 Node.js + TypeScript，数据库为 SQLite
  - API 文档已索引到知识库，doc_id: api-ref

（下次会话，这些事实自动作为上下文注入）
```
