import { AsyncLocalStorage } from 'async_hooks';

export interface TraceSpan {
  spanId:    string;
  name:      string;
  startTime: number;
  endTime?:  number;
  metadata?: Record<string, unknown>;
}

export interface TraceContext {
  traceId:   string;
  sessionId: string;
  spans:     TraceSpan[];
}

export const traceStorage = new AsyncLocalStorage<TraceContext>();

export function generateId(): string {
  return Math.random().toString(36).slice(2, 15);
}
