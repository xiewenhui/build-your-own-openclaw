import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { buildPluginApi } from '../plugin-sdk/api.ts';
import { globalSkillRegistry } from '../skills/registry.ts';
import { log } from '../logger.ts';
import type { PluginService } from '../plugin-sdk/types.ts';

interface PluginManifest {
  id: string;
  enabledByDefault?: boolean;
  activation?: { onStartup?: boolean };
  contracts?: { tools?: string[] };
  skills?: string[];
}

const pluginServices: PluginService[] = [];

export async function loadPluginsDir(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) {
    log(`[plugins] directory not found, skipping: ${dir}`);
    return;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(dir, entry.name);
    const manifestPath = path.join(pluginDir, 'openclaw.plugin.json');
    if (!fs.existsSync(manifestPath)) continue;

    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      log(`[plugin:${entry.name}] bad manifest: ${e}`);
      continue;
    }

    if (!manifest.enabledByDefault && !manifest.activation?.onStartup) continue;

    try {
      const pluginIndexPath = path.join(pluginDir, 'index.ts');
      log(`[plugin:${manifest.id}] loading: ${pluginIndexPath}`);

      // SECURITY NOTE: plugin code runs with the same Node.js process permissions as the
      // host — full filesystem, env vars, and network access. For production use, plugins
      // should be executed in a sandboxed worker (vm2, isolated-vm, or a subprocess with
      // restricted capabilities). Sandboxing is omitted here to keep the teaching example simple.
      const mod = await import(pathToFileURL(pluginIndexPath).href);
      log(`[plugin:${manifest.id}] imported, default export type: ${typeof mod?.default}`);

      const entry = mod.default;
      if (typeof entry?.register !== 'function') {
        log(`[plugin:${manifest.id}] missing register() export`);
        continue;
      }

      const api = buildPluginApi({ id: manifest.id, pluginDir, services: pluginServices });

      // Snapshot length before register() so we only start services this plugin added.
      // Without this, every subsequent plugin load would re-start all previously registered services.
      const lenBefore = pluginServices.length;
      await entry.register(api);

      // Start only newly registered services
      for (const svc of pluginServices.slice(lenBefore)) {
        svc.start?.().catch((e: any) => log(`[plugin:${manifest.id}] service ${svc.id} start error: ${e.message}`));
      }

      // Register embedded skill directories
      for (const rel of manifest.skills ?? []) {
        globalSkillRegistry.addDir(path.resolve(pluginDir, rel));
      }

      const tools = manifest.contracts?.tools ?? [];
      log(`[plugin:${manifest.id}] loaded (tools: ${tools.join(', ') || 'none'})`);
    } catch (e: any) {
      log(`[plugin:${manifest.id}] load error: ${e.message ?? e}`);
    }
  }
}

export async function stopPluginServices(): Promise<void> {
  for (const svc of pluginServices) {
    await svc.stop?.().catch(() => {});
  }
}
