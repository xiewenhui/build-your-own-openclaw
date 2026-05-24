import { readFileSync } from 'fs';
import yaml from 'js-yaml';

export interface Config {
  agent: {
    maxIterations: number;
    providers: { primary: string; fallback: string };
  };
  sandbox: {
    mode: string;
    workDir: string;
    hitl: { autoApproveReads: boolean };
  };
  tools: {
    file: {
      read: { allowedExtensions: string[]; maxBytes: number };
      write: { allowedExtensions: string[]; maxBytes: number };
      delete: { enabled: boolean };
    };
  };
  state: { dbPath: string };
}

function defaults(): Config {
  return {
    agent: {
      maxIterations: 10,
      providers: { primary: 'claude', fallback: 'openai' },
    },
    sandbox: {
      mode: 'host',
      workDir: './workspace',
      hitl: { autoApproveReads: true },
    },
    tools: {
      file: {
        read: {
          allowedExtensions: ['.txt', '.md', '.json', '.js', '.ts', '.py', '.go', '.yaml', '.yml', '.toml'],
          maxBytes: 65536,
        },
        write: {
          allowedExtensions: ['.txt', '.md', '.json', '.js', '.ts', '.py', '.go', '.yaml', '.yml', '.toml'],
          maxBytes: 32768,
        },
        delete: { enabled: false },
      },
    },
    state: { dbPath: 'xclaw.db' },
  };
}

function deepMerge(base: any, override: any): any {
  if (override === null || override === undefined) return base;
  if (typeof override !== 'object' || Array.isArray(override)) return override;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (key in base && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

export function loadConfig(path: string): Config {
  const base = defaults();
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = yaml.load(raw) as any;
    return deepMerge(base, parsed) as Config;
  } catch {
    return base;
  }
}

export function extSet(exts: string[]): Set<string> {
  return new Set(exts.map((e) => e.toLowerCase()));
}
