import Anthropic from '@anthropic-ai/sdk';
import type { Message, Provider } from './types.ts';

export function createClaudeProvider(): Provider {
  const client = new Anthropic({
    apiKey: process.env['ANTHROPIC_API_KEY'],
  });
  const model = process.env['ANTHROPIC_MODEL'] ?? 'claude-opus-4-7';

  return {
    name: 'claude',
    contextWindow: 200_000,

    async chat(messages: Message[]): Promise<string> {
      // Anthropic API requires system as a top-level field, not inside messages
      const system = messages.find(m => m.role === 'system')?.content ?? '';
      const turns = messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      const response = await client.messages.create({
        model,
        max_tokens: 8096,
        system,
        messages: turns,
      });

      const block = response.content[0];
      return block.type === 'text' ? block.text : '';
    },
  };
}
