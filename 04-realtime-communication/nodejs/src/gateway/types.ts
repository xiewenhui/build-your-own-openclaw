export interface ACPMessage {
  id: string;        // crypto.randomUUID()
  sessionId: string; // 会话 ID，同一 sessionId 共享历史
  channel: string;   // 'cli' | 'web' | 'qq'
  content: string;
  timestamp: number;
}

export interface AgentReply {
  type: 'delta' | 'reply' | 'error';
  id: string;
  sessionId: string;
  channel: string;
  content: string;   // delta: 单 token; reply: 完整回复; error: 错误信息
}
