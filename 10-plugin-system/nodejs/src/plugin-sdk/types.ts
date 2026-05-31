// PluginTool: a single tool exposed to the agent
export interface PluginTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; [k: string]: any }>;
    required?: string[];
  };
  execute(
    sessionId: string,
    params: Record<string, string>,
    onDelta?: (token: string) => void,
  ): Promise<string>;
}

// PluginService: optional background service with lifecycle hooks
export interface PluginService {
  id: string;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

// PluginApi: the object passed to plugin.register()
export interface PluginApi {
  registerTool(tool: PluginTool): void;
  registerService(svc: PluginService): void;
  pluginConfig?: unknown;
}

// PluginEntry: what a plugin's index.ts must default-export
export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  register(api: PluginApi): void | Promise<void>;
}
