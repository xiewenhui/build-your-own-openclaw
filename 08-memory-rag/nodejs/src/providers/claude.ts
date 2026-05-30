import Anthropic from '@anthropic-ai/sdk';
import type { Message, ContentBlock, Provider } from './types.ts';

// Convert our ContentBlock[] to the Anthropic SDK's content format.
function toAnthropicContent(content: string | ContentBlock[]): string | Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') return content;
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text' as const, text: block.text };
    return {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: block.source.media_type as 'image/png', data: block.source.data },
    };
  });
}

export function createClaudeProvider(): Provider {
  const client = new Anthropic({
    apiKey: process.env['ANTHROPIC_API_KEY'],
  });
  const model = process.env['ANTHROPIC_MODEL'] ?? 'claude-opus-4-7';

  return {
    name: 'claude',
    contextWindow: 200_000,

    async chat(messages: Message[]): Promise<string> {
      const system = messages.find(m => m.role === 'system')?.content ?? '';
      const turns = messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: toAnthropicContent(m.content) }));

      const response = await client.messages.create({
        model,
        max_tokens: 8096,
        system: typeof system === 'string' ? system : '',
        messages: turns,
      });

      const block = response.content[0];
      return block.type === 'text' ? block.text : '';
    },

    async stream(messages: Message[], onToken: (token: string) => void): Promise<string> {
      const system = messages.find(m => m.role === 'system')?.content ?? '';
      const turns = messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: toAnthropicContent(m.content) }));

      let full = '';
      const stream = await client.messages.stream({
        model,
        max_tokens: 8096,
        system: typeof system === 'string' ? system : '',
        messages: turns,
      });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          onToken(event.delta.text);
          full += event.delta.text;
        }
      }
      return full;
    },
  };
}
