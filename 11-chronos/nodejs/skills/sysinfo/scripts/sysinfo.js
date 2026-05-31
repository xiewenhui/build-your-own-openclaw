#!/usr/bin/env node
// System information script for the sysinfo skill.
// Usage: node sysinfo.js [cpu|memory|disk|processes|all]
import os from 'os';
import { execSync } from 'child_process';

const cmd = process.argv[2] ?? 'all';

function cpuInfo() {
  const cpus = os.cpus();
  const model = cpus[0]?.model ?? 'unknown';
  const count = cpus.length;
  const loadAvg = os.loadavg();
  return { model, count, loadAvg1m: loadAvg[0], loadAvg5m: loadAvg[1], loadAvg15m: loadAvg[2] };
}

function memoryInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    totalMB: Math.round(total / 1024 / 1024),
    usedMB: Math.round(used / 1024 / 1024),
    freeMB: Math.round(free / 1024 / 1024),
    usedPct: Math.round((used / total) * 100),
  };
}

function diskInfo() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('wmic logicaldisk get size,freespace,caption', { encoding: 'utf8' });
      const lines = out.trim().split('\n').slice(1).filter(l => l.trim());
      return lines.map(l => {
        const parts = l.trim().split(/\s+/);
        const caption = parts[0];
        const free = parseInt(parts[1] ?? '0');
        const size = parseInt(parts[2] ?? '0');
        return {
          drive: caption,
          totalMB: Math.round(size / 1024 / 1024),
          freeMB: Math.round(free / 1024 / 1024),
          usedPct: size > 0 ? Math.round(((size - free) / size) * 100) : 0,
        };
      });
    } else {
      const out = execSync("df -BM / | tail -1", { encoding: 'utf8' });
      const parts = out.trim().split(/\s+/);
      return [{
        mount: parts[5],
        totalMB: parseInt(parts[1] ?? '0'),
        usedMB: parseInt(parts[2] ?? '0'),
        freeMB: parseInt(parts[3] ?? '0'),
        usedPct: parseInt((parts[4] ?? '0%').replace('%', '')),
      }];
    }
  } catch {
    return { error: 'disk info unavailable' };
  }
}

function processInfo() {
  try {
    let out;
    if (process.platform === 'win32') {
      out = execSync('tasklist /fo csv /nh', { encoding: 'utf8' });
      const lines = out.trim().split('\n').slice(0, 10);
      return lines.map(l => {
        const parts = l.split('","');
        return { name: parts[0]?.replace('"', ''), pid: parts[1], memKB: parts[4]?.replace('"', '') };
      });
    } else {
      out = execSync('ps aux --sort=-%cpu | head -11 | tail -10', { encoding: 'utf8' });
      return out.trim().split('\n').map(l => {
        const parts = l.trim().split(/\s+/);
        return { user: parts[0], pid: parts[1], cpu: parts[2], mem: parts[3], cmd: parts.slice(10).join(' ') };
      });
    }
  } catch {
    return { error: 'process info unavailable' };
  }
}

const result = {};
if (cmd === 'cpu'       || cmd === 'all') result.cpu       = cpuInfo();
if (cmd === 'memory'    || cmd === 'all') result.memory     = memoryInfo();
if (cmd === 'disk'      || cmd === 'all') result.disk       = diskInfo();
if (cmd === 'processes' || cmd === 'all') result.processes  = processInfo();
if (cmd === 'all') result.os = { platform: process.platform, release: os.release(), uptime: os.uptime() };

console.log(JSON.stringify(result, null, 2));
