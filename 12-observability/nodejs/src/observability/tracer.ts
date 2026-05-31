import { traceStorage, generateId, type TraceContext } from './context.ts';
import { metrics } from './metrics.ts';

export async function traceSpan<T>(
  spanName: string,
  metadata: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const store = traceStorage.getStore();

  // Top-level call: auto-initialize trace context
  if (!store) {
    const ctx: TraceContext = {
      traceId:   generateId(),
      sessionId: (metadata['sessionId'] as string) ?? 'sys',
      spans:     [],
    };
    return traceStorage.run(ctx, () => traceSpan(spanName, metadata, fn));
  }

  const spanId    = generateId();
  const startTime = Date.now();
  store.spans.push({ spanId, name: spanName, startTime, metadata });

  try {
    const result = await fn();

    // LLM call: capture token usage and cost if available
    if (metadata['type'] === 'LLM_CALL' && result && (result as any).usage) {
      const { prompt_tokens, completion_tokens } = (result as any).usage;
      const model = (metadata['model'] as string) ?? 'unknown';
      metrics.record('llm.tokens.input',  prompt_tokens,     { model });
      metrics.record('llm.tokens.output', completion_tokens, { model });
      // Approximate rate: input $5/M, output $15/M (claude-sonnet-4 reference)
      const cost = (prompt_tokens * 5 + completion_tokens * 15) / 1_000_000;
      metrics.record('llm.cost.usd', cost, { model });
    }

    return result;
  } catch (error: any) {
    metrics.record('agent.error.count', 1, { spanName, error: error.message });
    throw error;
  } finally {
    const duration = Date.now() - startTime;
    metrics.record(`${spanName}.latency.ms`, duration);

    console.log(JSON.stringify({
      log_type:    'TRACE',
      trace_id:    store.traceId,
      session_id:  store.sessionId,
      span_id:     spanId,
      span_name:   spanName,
      duration_ms: duration,
      ...metadata,
      timestamp: new Date().toISOString(),
    }));
  }
}
