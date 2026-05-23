import OpenAI from 'openai';
import type { Message, Provider } from './types.ts';

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
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      });
      return completion.choices[0].message.content ?? '';
    },
  };
}
