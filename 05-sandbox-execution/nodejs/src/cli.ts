import WebSocket from 'ws';
import readline from 'readline';

const port = process.env['WEB_PORT'] ?? '3001';
const sessionId = `cli-${crypto.randomUUID().slice(0, 8)}`;
const url = `ws://127.0.0.1:${port}/ws`;

const ws = new WebSocket(url);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let asking = false;

function ask() {
  if (asking) return;
  asking = true;
  rl.question('You: ', (text) => {
    asking = false;
    const trimmed = text.trim();
    if (trimmed.toLowerCase() === 'exit') { ws.close(); rl.close(); process.exit(0); }
    if (!trimmed) { ask(); return; }
    ws.send(JSON.stringify({ type: 'message', sessionId, content: trimmed }));
    // re-ask only after agent replies (see ws.on('message'))
  });
}

ws.on('open', () => {
  process.stderr.write(`[cli] connected to ${url} (session: ${sessionId})\n`);
  ask();
});

ws.on('message', (raw) => {
  const pkt = JSON.parse(raw.toString()) as { type: string; content: string };
  if (pkt.type === 'delta') {
    process.stdout.write(pkt.content);
  } else if (pkt.type === 'reply') {
    process.stdout.write('\n');
    ask();
  } else if (pkt.type === 'error') {
    process.stderr.write(`error: ${pkt.content}\n`);
    ask();
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
