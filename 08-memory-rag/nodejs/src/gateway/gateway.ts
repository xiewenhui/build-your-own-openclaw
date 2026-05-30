import type { ChannelAdapter } from '../channels/types.ts';
import type { ACPMessage, AgentReply } from './types.ts';
import type { Agent } from '../agent.ts';
import { resolveSessionId } from './router.ts';
import type { DB } from '../db.ts';

export class Gateway {
  private adapters = new Map<string, ChannelAdapter>();
  private agent: Agent;
  private db: DB | null;

  constructor(agent: Agent, db: DB | null = null) {
    this.agent = agent;
    this.db = db;
  }

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
    adapter.onMessage((raw) => this.dispatch(raw));
  }

  private async dispatch(raw: ACPMessage): Promise<void> {
    const msg: ACPMessage = {
      ...raw,
      sessionId: resolveSessionId(raw.channel, raw.sessionId),
    };
    const adapter = this.adapters.get(msg.channel)!;

    // Handle reconnect: restore history and optionally resume execution.
    if ((raw as any).type === 'reconnect') {
      await this.handleReconnect(msg.sessionId, adapter);
      return;
    }

    try {
      const full = await this.agent.handle(msg, (token) => {
        adapter.send({ type: 'delta', id: msg.id, sessionId: msg.sessionId, channel: msg.channel, content: token });
      });
      adapter.send({ type: 'reply', id: msg.id, sessionId: msg.sessionId, channel: msg.channel, content: full });
    } catch (err: any) {
      adapter.send({ type: 'error', id: msg.id, sessionId: msg.sessionId, channel: msg.channel, content: err.message });
    }
  }

  private async handleReconnect(sessionId: string, adapter: ChannelAdapter): Promise<void> {
    if (!this.db) return;

    const status = this.db.getStatus(sessionId);

    // Always send history (empty array for new sessions) so the CLI/web knows to start prompting.
    const history = status ? this.db.loadHistory(sessionId) : [];
    adapter.send({
      type: 'history',
      id: '',
      sessionId,
      channel: adapter.name,
      content: JSON.stringify(history),
    });

    if (!status) return; // brand-new session — nothing more to do

    // Running/Paused sessions: resume execution with an injected prompt.
    // Success/Failed: read-only; do not trigger the LLM.
    if (status === 'Running' || status === 'Paused') {
      const resumeMsg: ACPMessage = {
        id: crypto.randomUUID(),
        sessionId,
        channel: adapter.name,
        content:
          '[System: 之前由于不可抗力中断，请根据以下历史继续执行，不要重新从头开始。如果有未完成的工具调用，请重新发起。]',
        timestamp: Date.now(),
      };
      try {
        const full = await this.agent.handle(resumeMsg, (token) => {
          adapter.send({ type: 'delta', id: resumeMsg.id, sessionId, channel: adapter.name, content: token });
        });
        adapter.send({ type: 'reply', id: resumeMsg.id, sessionId, channel: adapter.name, content: full });
      } catch (err: any) {
        adapter.send({ type: 'error', id: '', sessionId, channel: adapter.name, content: err.message });
      }
    }
  }

  async start(): Promise<void> {
    await Promise.all([...this.adapters.values()].map(a => a.start()));
  }
}
