import fs from 'fs/promises';
import type { MemoryStore } from './memory.ts';
import { embed } from './memory.ts';

// ── Text chunking ─────────────────────────────────────────────────────────────

// Fixed-size sliding window chunking.
// maxTokens   — approximate max tokens per chunk (1 token ≈ 4 chars)
// overlapTokens — tokens to repeat from the end of the previous chunk so
//                 sentence context isn't lost at boundaries.
export function chunkText(text: string, maxTokens = 512, overlapTokens = 64): string[] {
  const approxCharsPerToken = 4;
  const maxChars     = maxTokens     * approxCharsPerToken;
  const overlapChars = overlapTokens * approxCharsPerToken;

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (end === text.length) break;
    start = end - overlapChars;
  }
  return chunks;
}

// ── Document indexing ─────────────────────────────────────────────────────────

// Index a single document file into the MemoryStore as KB entries.
// Returns the number of chunks created.
export async function indexDocument(
  filePath: string,
  docId: string,
  store: MemoryStore,
): Promise<number> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const chunks = chunkText(raw);
  for (const chunk of chunks) {
    const embedding = await embed(chunk);
    await store.save({
      sessionId: 'global',
      source: 'kb',
      docId,
      content: chunk,
      embedding,
      tags: [docId],
    });
  }
  return chunks.length;
}
