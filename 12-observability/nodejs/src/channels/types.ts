import type { ACPMessage, AgentReply } from '../gateway/types.ts';

export interface ChannelAdapter {
  name: string;
  onMessage(handler: (msg: ACPMessage) => void): void;
  send(reply: AgentReply): void;
  start(): Promise<void>;
}
