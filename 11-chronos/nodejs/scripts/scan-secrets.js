#!/usr/bin/env node
// scan-secrets.js — Cross-platform hardcoded secret scanner
// Usage: node config/scan-secrets.js [rootDir]
// Output: CLEAN  or  FOUND\n<file>:<line>  <match-type>  ...

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS  = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const SCAN_EXTS  = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.env', '.yaml', '.yml', '.toml', '.properties', '.xml', '.config']);
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

const PATTERNS = [
  { name: 'OpenAI key',       re: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'Anthropic key',    re: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
  { name: 'Private key block',re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
  { name: 'AWS key',          re: /AKIA[0-9A-Z]{16}/g },
  { name: 'Generic secret',   re: /(?:secret|password|passwd|pwd)\s*[:=]\s*["'][^"'\s]{8,}["']/gi },
  { name: 'API key assign',   re: /(?:api[_-]?key|apikey)\s*[:=]\s*["'][^"'\s]{8,}["']/gi },
  { name: 'Bearer token',     re: /Bearer\s+[A-Za-z0-9\-_]{20,}/g },
];

const findings = [];

function scanFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return; // binary or unreadable
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) {
        const rel = path.relative(ROOT, filePath).replace(/\\/g, '/');
        findings.push(`${rel}:${i + 1}  [${name}]`);
        break; // one finding per line
      }
    }
  }
}

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      if (SCAN_EXTS.has(path.extname(entry.name).toLowerCase())) {
        scanFile(full);
      }
    }
  }
}

walk(ROOT);

if (findings.length === 0) {
  console.log('CLEAN');
} else {
  console.log('FOUND');
  for (const f of findings) console.log(f);
}
