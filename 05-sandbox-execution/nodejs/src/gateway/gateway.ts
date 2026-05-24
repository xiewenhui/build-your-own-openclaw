import type { ChannelAdapter } from '../channels/types.ts';
import type { ACPMessage, AgentReply } from './types.ts';
import type { Agent } from '../agent.ts';
import { resolveSessionId } from './router.ts';

export class Gateway {
  private adapters = new Map<string, ChannelAdapter>();
  private agent: Agent;

  constructor(agent: Agent) {
    this.agent = agent;
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

    try {
      await this.agent.handle(msg, (token) => {
        adapter.send({ type: 'delta', id: msg.id, sessionId: msg.sessionId, channel: msg.channel, content: token });
      }).then((full) => {
        adapter.send({ type: 'reply', id: msg.id, sessionId: msg.sessionId, channel: msg.channel, content: full });
      });
    } catch (err: any) {
      adapter.send({ type: 'error', id: msg.id, sessionId: msg.sessionId, channel: msg.channel, content: err.message });
    }
  }

  async start(): Promise<void> {
    await Promise.all([...this.adapters.values()].map(a => a.start()));
  }
}
