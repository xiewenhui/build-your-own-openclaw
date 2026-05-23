import type { Message, Provider } from './types.ts';
import { assembleContext } from '../context.ts';

// ── Provider registry ────────────────────────────────────────────────────────

const providerRegistry = new Map<string, Provider>();

export function registerProvider(provider: Provider) {
  providerRegistry.set(provider.name, provider);
}

// ── Fallback router ──────────────────────────────────────────────────────────

// Tries each provider in order; moves to the next on any error.
export async function chatWithFallback(
  messages: Message[],
  chain: string[],
): Promise<string> {
  const errors: string[] = [];

  for (const name of chain) {
    const provider = providerRegistry.get(name);
    if (!provider) {
      errors.push(`${name}: not registered`);
      continue;
    }

    const ctx = await assembleContext(messages, provider);
    try {
      return await provider.chat(ctx);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.warn(`[provider:${name}] failed — ${msg}`);
      errors.push(`${name}: ${msg}`);
    }
  }

  throw new Error(`All providers failed:\n${errors.join('\n')}`);
}
