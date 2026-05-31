import path from 'path';
import { toolRegistry, pluginToolNames } from '../tools.ts';
import { log } from '../logger.ts';
import type { PluginApi, PluginService } from './types.ts';

export function buildPluginApi(opts: {
  id: string;
  pluginDir: string;
  services: PluginService[];
  pluginConfig?: unknown;
}): PluginApi {
  // TODO: pluginConfig is a placeholder for a config-injection mechanism.
  // Intended design: loader reads a `config.json` next to the plugin's index.ts,
  // validates it against manifest.configSchema (ajv), then passes it here so plugins
  // can declare their config schema and receive typed config without touching process.env.
  // Until implemented, plugins should read their own config from process.env directly.
  return {
    pluginConfig: opts.pluginConfig,

    registerTool(tool) {
      toolRegistry.set(tool.name, {
        definition: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as any,
        },
        execute: tool.execute,
      });
      pluginToolNames.add(tool.name);
      log(`[plugin:${opts.id}] registered tool: ${tool.name}`);
    },

    registerService(svc) {
      opts.services.push(svc);
    },
  };
}
