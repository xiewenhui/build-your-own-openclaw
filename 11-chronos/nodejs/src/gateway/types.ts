export interface ACPMessage {
  id: string;        // crypto.randomUUID()
  sessionId: string; // 会话 ID，同一 sessionId 共享历史
  channel: string;   // 'cli' | 'web' | 'qq'
  content: string;
  timestamp: number;
  type?: string;          // 'message' | 'reconnect'; adapters set this for gateway routing
  caller?: 'user' | 'agent'; // 消息来源：用户发起 or 另一个 Agent 发起（delegate/debate/pipeline）
  parentSessionId?: string;  // 父会话 ID，用于追踪子任务归属（traces 表可关联完整调用链）
  isChronos?: boolean;       // 系统自动触发标志，ChronosEngine 发出的消息置为 true
}

export interface AgentReply {
  type: 'delta' | 'reply' | 'error' | 'history';
  id: string;
  sessionId: string;
  channel: string;
  content: string;   // delta: 单 token; reply: 完整回复; error: 错误信息; history: JSON array
}
