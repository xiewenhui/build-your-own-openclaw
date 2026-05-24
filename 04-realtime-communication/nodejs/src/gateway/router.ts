import type { ACPMessage } from './types.ts';

// sessionId 命名空间：CLI 固定 'cli'，QQ 固定 'qq'，Web 由客户端传入。
// 本节只有一个 Agent，路由职责仅是确保 sessionId 已填充。
export function resolveSessionId(channel: string, clientSessionId?: string): string {
  if (channel === 'cli') return 'cli';
  return clientSessionId ?? `web-${Date.now()}`;
}
