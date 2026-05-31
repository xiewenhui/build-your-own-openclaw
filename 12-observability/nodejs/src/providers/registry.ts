import type { Message, Provider, StreamResult } from './types.ts';
import { assembleContext } from '../context.ts';
import { warn } from '../logger.ts';

// ── Provider registry ────────────────────────────────────────────────────────

const providerRegistry = new Map<string, Provider>();

export function registerProvider(provider: Provider) {
  providerRegistry.set(provider.name, provider);
}

export function getProvider(name: string): Provider | undefined {
  return providerRegistry.get(name);
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
      warn(`[provider:${name}] failed — ${msg}`);
      errors.push(`${name}: ${msg}`);
    }
  }

  throw new Error(`All providers failed:\n${errors.join('\n')}`);
}

// Streaming variant: calls provider.stream() if available, otherwise falls back
// to provider.chat() with a single synthetic onToken call at the end.
export async function streamWithFallback(
  messages: Message[],
  chain: string[],
  onToken: (token: string) => void,
): Promise<StreamResult> {
  const errors: string[] = [];

  for (const name of chain) {
    const provider = providerRegistry.get(name);
    if (!provider) {
      errors.push(`${name}: not registered`);
      continue;
    }

    const ctx = await assembleContext(messages, provider);
    try {
      if (provider.stream) {
        return await provider.stream(ctx, onToken);
      }
      // Degrade gracefully: no streaming → emit full reply as one token
      const reply = await provider.chat(ctx);
      onToken(reply);
      return { reply };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      warn(`[provider:${name}] failed — ${msg}`);
      errors.push(`${name}: ${msg}`);
    }
  }

  throw new Error(`All providers failed:\n${errors.join('\n')}`);
}
