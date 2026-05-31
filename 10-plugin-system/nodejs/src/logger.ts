function caller(): string {
  const line = new Error().stack?.split('\n')[3] ?? '';
  const m = line.match(/[\\/]([\w.-]+\.ts):(\d+)/);
  return m ? `${m[1]}:${m[2]}` : '?';
}

export const log  = (...a: unknown[]) =>
  process.stderr.write(`[${caller()}] ` + a.map(String).join(' ') + '\n');
export const warn = (...a: unknown[]) =>
  process.stderr.write(`[WARN][${caller()}] ` + a.map(String).join(' ') + '\n');
