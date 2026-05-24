import * as readline from 'readline';
import type { ChannelAdapter } from './types.ts';
import type { ACPMessage, AgentReply } from '../gateway/types.ts';
import { log } from '../logger.ts';

export function createCliAdapter(): ChannelAdapter {
  let messageHandler: ((msg: ACPMessage) => void) | null = null;
  let promptNext: (() => void) | null = null;

  return {
    name: 'cli',

    onMessage(h) { messageHandler = h; },

    send(reply: AgentReply): void {
      if (reply.type === 'delta') {
        process.stdout.write(reply.content);
      } else if (reply.type === 'reply') {
        process.stdout.write('\n');
        promptNext?.();  // re-prompt after full reply arrives
      } else {
        console.error(`[cli] error: ${reply.content}`);
        promptNext?.();
      }
    },

    async start(): Promise<void> {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      log('[cli] ready — type your message (exit to quit)');

      const ask = () => {
        rl.question('You: ', (input) => {
          const trimmed = input.trim();
          if (trimmed.toLowerCase() === 'exit') { rl.close(); process.exit(0); }
          if (!trimmed) { ask(); return; }

          // Register one-shot callback to re-prompt after reply
          promptNext = ask;
          messageHandler?.({
            id: crypto.randomUUID(),
            sessionId: 'cli',
            channel: 'cli',
            content: trimmed,
            timestamp: Date.now(),
          });
        });
      };
      ask();
    },
  };
}
