// ContentBlock is used for Vision (multimodal) messages.
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface UsageStats {
  prompt_tokens:     number;
  completion_tokens: number;
}

export interface StreamResult {
  reply: string;
  usage?: UsageStats;
}

export interface Provider {
  name: string;
  contextWindow: number;  // max tokens this model accepts
  chat(messages: Message[]): Promise<string>;
  stream?(messages: Message[], onToken: (token: string) => void): Promise<StreamResult>;
}
