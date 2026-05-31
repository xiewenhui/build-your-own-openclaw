import type { PluginEntry } from './types.ts';

// Pure marker function — wraps the entry object for type checking only.
// The runtime reads .id, .name, .description, and calls .register(api).
export function definePluginEntry(entry: PluginEntry): PluginEntry {
  return entry;
}
