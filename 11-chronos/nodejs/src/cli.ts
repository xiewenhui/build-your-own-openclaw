import WebSocket from 'ws';
import readline from 'readline';
import fs from 'fs';

const SESSION_FILE = '.cli_session';
const port = process.env['WEB_PORT'] ?? '3000';
const sessionId = loadOrCreateSession();
const url = `ws://127.0.0.1:${port}/ws`;

const ws = new WebSocket(url);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let asking = false;
let inputLines: string[] = [];  // buffer for multi-line input

function ask() {
  if (asking) return;
  asking = true;
  inputLines = [];
  process.stdout.write('You: ');
  // Multi-line mode: collect lines until a blank line, then send.
  // Single-line messages (no blank line needed) also work — blank line triggers send.
  rl.on('line', onLine);
}

function onLine(line: string) {
  if (line === '') {
    // blank line = end of input
    rl.removeListener('line', onLine);
    const text = inputLines.join('\n').trim();
    inputLines = [];
    if (text.toLowerCase() === 'exit') { ws.close(); rl.close(); process.exit(0); }
    if (!text) { ask(); return; }
    ws.send(JSON.stringify({ type: 'message', sessionId, content: text }));
    // re-ask only after agent replies (see ws.on('message'))
  } else {
    inputLines.push(line);
    // Show continuation prompt for lines after the first
    if (inputLines.length === 1) process.stdout.write('... ');
  }
}

ws.on('open', () => {
  process.stderr.write(`[cli] connected to ${url} (session: ${sessionId})\n`);
  // Send reconnect first so the server can push back history.
  ws.send(JSON.stringify({ type: 'reconnect', sessionId }));
});

ws.on('message', (raw) => {
  const pkt = JSON.parse(raw.toString()) as { type: string; content: string };
  switch (pkt.type) {
    case 'history': {
      // Restore previous conversation as greyed-out context.
      let messages: Array<{ role: string; content: string }> = [];
      try { messages = JSON.parse(pkt.content); } catch { break; }
      if (messages.length > 0) {
        process.stderr.write('[history] ── 以下为历史消息 ──\n');
        for (const m of messages) {
          const label = m.role === 'user' ? 'You' : 'xclaw';
          process.stderr.write(`[history] ${label}: ${m.content}\n`);
        }
        process.stderr.write('[history] ── 以上为历史消息 ──\n');
      }
      ask();
      break;
    }
    case 'delta':
      process.stdout.write(pkt.content);
      break;
    case 'reply':
      process.stdout.write('\n');
      asking = false;
      ask();
      break;
    case 'error':
      process.stderr.write(`error: ${pkt.content}\n`);
      asking = false;
      ask();
      break;
  }
});

ws.on('close', () => {
  process.stderr.write('[cli] disconnected\n');
  rl.close();
  process.exit(0);
});

ws.on('error', (err) => {
  process.stderr.write(`[cli] connection error: ${err.message}\n`);
  process.exit(1);
});

// loadOrCreateSession reads .cli_session, creating a new ID if absent.
// This ensures the same session is resumed across CLI restarts.
function loadOrCreateSession(): string {
  try {
    const id = fs.readFileSync(SESSION_FILE, 'utf8').trim();
    if (id) return id;
  } catch { /* file absent on first run */ }
  const id = 'cli-' + crypto.randomUUID().slice(0, 8);
  fs.writeFileSync(SESSION_FILE, id, { mode: 0o600 });
  return id;
}
