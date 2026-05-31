import { DatabaseSync } from 'node:sqlite';
import OpenAI from 'openai';
import type { Config } from './config.ts';
import type { Message } from './providers/types.ts';
import type { Provider } from './providers/types.ts';
import { warn } from './logger.ts';

// ── Embedding ─────────────────────────────────────────────────────────────────

// Reuse the same baseURL as the OpenAI chat provider so users on compatible
// endpoints (DeepSeek, Azure, etc.) don't have to configure a second URL.
const embeddingClient = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'],
  baseURL: process.env['OPENAI_API_BASE_URL'],
});

export async function embed(text: string): Promise<number[]> {
  const res = await embeddingClient.embeddings.create({
    model: process.env['OPENAI_EMBEDDING_MODEL'] ?? 'text-embedding-3-small',
    input: text,
  });
  return res.data[0]!.embedding;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na  += a[i]! * a[i]!;
    nb  += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ── MemoryStore interface ─────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  sessionId: string;
  source: 'agent' | 'kb';
  docId?: string;
  content: string;
  embedding: number[];
  tags: string[];
  createdAt: number;
}

export interface SearchFilter {
  source?: 'agent' | 'kb';
  sessionId?: string;
  docId?: string;
}

export interface MemoryStore {
  save(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<string>;
  search(queryEmbedding: number[], topK: number, filter?: SearchFilter): Promise<MemoryEntry[]>;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}

// ── SQLiteMemoryStore ─────────────────────────────────────────────────────────

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
        embedding   TEXT NOT NULL,
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      entry.sessionId,
      entry.source,
      entry.docId ?? null,
      entry.content,
      JSON.stringify(entry.embedding),
      JSON.stringify(entry.tags ?? []),
      Date.now(),
    );
    return id;
  }

  async search(queryEmbedding: number[], topK: number, filter?: SearchFilter): Promise<MemoryEntry[]> {
    const clauses: string[] = [];
    const args: (string | null)[] = [];

    if (filter?.source)    { clauses.push('source = ?');     args.push(filter.source); }
    if (filter?.sessionId) { clauses.push('session_id = ?'); args.push(filter.sessionId); }
    if (filter?.docId)     { clauses.push('doc_id = ?');     args.push(filter.docId); }

    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = this.db.prepare(`SELECT * FROM memories${where}`).all(...args) as any[];

    return rows
      .map((r) => ({
        id: r.id as string,
        sessionId: r.session_id as string,
        source: r.source as 'agent' | 'kb',
        docId: r.doc_id as string | undefined,
        content: r.content as string,
        embedding: JSON.parse(r.embedding as string) as number[],
        tags: JSON.parse(r.tags as string ?? '[]') as string[],
        createdAt: r.created_at as number,
        _score: cosineSimilarity(queryEmbedding, JSON.parse(r.embedding as string) as number[]),
      }))
      .sort((a, b) => (b as any)._score - (a as any)._score)
      .slice(0, topK)
      .map(({ _score: _, ...entry }) => entry as MemoryEntry);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// ── MilvusMemoryStore ─────────────────────────────────────────────────────────

export class MilvusMemoryStore implements MemoryStore {
  private client: any;
  private readonly col = 'xclaw_memories';

  constructor(address: string) {
    // Dynamically require so users without Milvus SDK can still use SQLite mode.
    let MilvusClient: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ({ MilvusClient } = require('@zilliz/milvus2-sdk-node'));
    } catch {
      throw new Error('Milvus backend requires @zilliz/milvus2-sdk-node — run: npm install @zilliz/milvus2-sdk-node');
    }
    this.client = new MilvusClient({ address });
  }

  async init(): Promise<void> {
    let DataType: any;
    try {
      ({ DataType } = require('@zilliz/milvus2-sdk-node'));
    } catch {
      throw new Error('Milvus SDK not installed');
    }

    const exists = await this.client.hasCollection({ collection_name: this.col });
    if (!exists.value) {
      await this.client.createCollection({
        collection_name: this.col,
        fields: [
          { name: 'id',         data_type: DataType.VarChar, is_primary_key: true, max_length: 36 },
          { name: 'session_id', data_type: DataType.VarChar, max_length: 64 },
          { name: 'source',     data_type: DataType.VarChar, max_length: 8 },
          { name: 'doc_id',     data_type: DataType.VarChar, max_length: 128 },
          { name: 'content',    data_type: DataType.VarChar, max_length: 4096 },
          { name: 'tags',       data_type: DataType.VarChar, max_length: 512 },
          { name: 'created_at', data_type: DataType.Int64 },
          { name: 'embedding',  data_type: DataType.FloatVector, dim: 1536 },
        ],
      });
      await this.client.createIndex({
        collection_name: this.col,
        field_name: 'embedding',
        index_type: 'HNSW',
        metric_type: 'COSINE',
        params: { M: 16, efConstruction: 200 },
      });
    }
    await this.client.loadCollection({ collection_name: this.col });
  }

  async save(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): Promise<string> {
    const id = crypto.randomUUID();
    await this.client.insert({
      collection_name: this.col,
      data: [{
        id,
        session_id: entry.sessionId,
        source: entry.source,
        doc_id: entry.docId ?? '',
        content: entry.content.slice(0, 4096),
        tags: JSON.stringify(entry.tags ?? []),
        created_at: Date.now(),
        embedding: entry.embedding,
      }],
    });
    return id;
  }

  async search(queryEmbedding: number[], topK: number, filter?: SearchFilter): Promise<MemoryEntry[]> {
    const exprs: string[] = [];
    if (filter?.source)    exprs.push(`source == "${filter.source}"`);
    if (filter?.sessionId) exprs.push(`session_id == "${filter.sessionId}"`);
    if (filter?.docId)     exprs.push(`doc_id == "${filter.docId}"`);

    const results = await this.client.search({
      collection_name: this.col,
      vectors: [queryEmbedding],
      output_fields: ['id', 'session_id', 'source', 'doc_id', 'content', 'tags', 'created_at'],
      limit: topK,
      expr: exprs.join(' && ') || undefined,
    });

    return (results.results as any[]).map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      source: r.source as 'agent' | 'kb',
      docId: r.doc_id || undefined,
      content: r.content,
      embedding: [],
      tags: JSON.parse(r.tags ?? '[]'),
      createdAt: Number(r.created_at),
    }));
  }

  async delete(id: string): Promise<void> {
    await this.client.delete({ collection_name: this.col, filter: `id == "${id}"` });
  }

  async close(): Promise<void> {
    await this.client.closeConnection();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createMemoryStore(cfg: Config): MemoryStore {
  if (cfg.memory.backend === 'milvus') {
    return new MilvusMemoryStore(cfg.memory.milvus.address);
  }
  return new SQLiteMemoryStore(cfg.state.dbPath);
}

// ── Auto-extraction pipeline ──────────────────────────────────────────────────

export async function extractAndSaveMemories(
  messages: Message[],
  sessionId: string,
  provider: Provider,
  store: MemoryStore,
): Promise<void> {
  const history = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[multimodal]'}`)
    .join('\n');

  if (history.length < 50) return; // Skip trivially short sessions.

  const extractPrompt =
    `从以下对话中提取值得长期记住的事实（用户偏好、项目设定、重要决策）。` +
    `每条一行，以 "- " 开头，最多 10 条，无关紧要的内容不要提取：\n\n${history}`;

  let raw: string;
  try {
    raw = await provider.chat([{ role: 'user', content: extractPrompt }]);
  } catch (e: any) {
    warn('[memory] extraction LLM call failed:', e.message);
    return;
  }

  const lines = raw.split('\n').filter((l) => l.trim().startsWith('- '));
  for (const line of lines) {
    const content = line.replace(/^-\s*/, '').trim();
    if (content.length < 10) continue;
    try {
      const embedding = await embed(content);
      await store.save({ sessionId, source: 'agent', content, embedding, tags: ['auto-extracted'] });
    } catch (e: any) {
      warn('[memory] failed to embed/save extracted memory:', e.message);
    }
  }
}
