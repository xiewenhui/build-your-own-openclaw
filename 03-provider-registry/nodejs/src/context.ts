import type { Message, Provider } from './providers/types.ts';

// ── Token estimation ─────────────────────────────────────────────────────────

// Rough estimate: ~4 chars per token (works for English; Chinese is ~2 chars/token,
// so this may undercount — conservative enough to avoid over-truncation).
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

// ── Truncation ───────────────────────────────────────────────────────────────

// Keep system message + as many recent turns as fit within the limit.
function truncate(messages: Message[], limit: number): Message[] {
  const system = messages.filter(m => m.role === 'system');
  const turns  = messages.filter(m => m.role !== 'system');

  const systemTokens = messagesTokens(system);
  let budget = limit - systemTokens;
  let kept = 0;

  // Walk turns from newest to oldest, accumulate until budget runs out
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = estimateTokens(turns[i].content) + 4;
    if (budget - t < 0) break;
    budget -= t;
    kept++;
  }

  return [...system, ...turns.slice(turns.length - kept)];
}

// ── Compression ──────────────────────────────────────────────────────────────

// When even the most recent turns still exceed the limit, summarize the oldest
// portion using the provider itself, then reattach the recent turns.
async function compress(messages: Message[], provider: Provider): Promise<Message[]> {
  const system = messages.filter(m => m.role === 'system');
  const turns  = messages.filter(m => m.role !== 'system');

  // Keep the 4 most recent turns verbatim; summarize everything older
  const KEEP_RECENT = 4;
  const toSummarize = turns.slice(0, -KEEP_RECENT);
  const recent      = turns.slice(-KEEP_RECENT);

  if (toSummarize.length === 0) return messages;

  const summaryRequest: Message[] = [
    {
      role: 'user',
      content:
        'Summarize the following conversation history concisely, preserving key facts and decisions:\n\n' +
        toSummarize.map(m => `${m.role}: ${m.content}`).join('\n'),
    },
  ];

  const summary = await provider.chat(summaryRequest);

  return [
    ...system,
    { role: 'user', content: `[Conversation summary]\n${summary}` },
    ...recent,
  ];
}

// ── Public entry point ───────────────────────────────────────────────────────

// Assemble context for a provider: truncate first, compress only if still over limit.
export async function assembleContext(
  messages: Message[],
  provider: Provider,
): Promise<Message[]> {
  const limit = Math.floor(provider.contextWindow * 0.9); // keep 10% headroom for reply

  let ctx = truncate(messages, limit);

  if (messagesTokens(ctx) > limit) {
    ctx = await compress(ctx, provider);
    ctx = truncate(ctx, limit); // truncate again after compression
  }

  return ctx;
}
