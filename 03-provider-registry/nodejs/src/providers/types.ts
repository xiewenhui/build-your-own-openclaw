export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Provider {
  name: string;
  contextWindow: number;  // max tokens this model accepts
  chat(messages: Message[]): Promise<string>;
}
