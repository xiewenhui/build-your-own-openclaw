import OpenAI from 'openai';
import type { Message, ContentBlock, Provider } from './types.ts';

// Convert our ContentBlock[] to the OpenAI SDK's content format.
function toOpenAIContent(content: string | ContentBlock[]): string | OpenAI.ChatCompletionContentPart[] {
  if (typeof content === 'string') return content;
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text' as const, text: block.text };
    return {
      type: 'image_url' as const,
      image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
    };
  });
}

export function createOpenAIProvider(): Provider {
  const client = new OpenAI({
    apiKey: process.env['OPENAI_API_KEY'],
    baseURL: process.env['OPENAI_API_BASE_URL'],
  });
  const model = process.env['OPENAI_MODEL'] ?? 'gpt-4o';

  return {
    name: 'openai',
    contextWindow: 128_000,

    async chat(messages: Message[]): Promise<string> {
      const completion = await client.chat.completions.create({
        model,
        messages: messages.map(m => ({ role: m.role, content: toOpenAIContent(m.content) })),
      });
      return completion.choices[0].message.content ?? '';
    },

    async stream(messages: Message[], onToken: (token: string) => void): Promise<string> {
      const stream = await client.chat.completions.create({
        model,
        messages: messages.map(m => ({ role: m.role, content: toOpenAIContent(m.content) })),
        stream: true,
      });
      let full = '';
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content ?? '';
        if (token) { onToken(token); full += token; }
      }
      return full;
    },
  };
}
