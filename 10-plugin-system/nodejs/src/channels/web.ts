import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ChannelAdapter } from './types.ts';
import type { ACPMessage, AgentReply } from '../gateway/types.ts';
import { log } from '../logger.ts';

// ── Inline chat HTML ─────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>xclaw</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f0f2f5; height: 100vh; display: flex; flex-direction: column; }
  header { background: #1a73e8; color: #fff; padding: 14px 20px; font-size: 18px; font-weight: 600; letter-spacing: .5px; }
  #messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
  .bubble { max-width: 70%; padding: 10px 14px; border-radius: 16px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .user   { align-self: flex-end; background: #1a73e8; color: #fff; border-bottom-right-radius: 4px; }
  .agent  { align-self: flex-start; background: #fff; color: #333; border-bottom-left-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .restored { opacity: 0.5; }
  .divider { text-align: center; font-size: 12px; color: #aaa; margin: 4px 0; }
  .label  { font-size: 11px; color: #888; margin-bottom: 3px; }
  #form   { display: flex; gap: 10px; padding: 14px 20px; background: #fff; border-top: 1px solid #e0e0e0; }
  #input  { flex: 1; padding: 10px 14px; border: 1px solid #ccc; border-radius: 24px; font-size: 15px; outline: none; }
  #input:focus { border-color: #1a73e8; }
  #send   { padding: 10px 22px; background: #1a73e8; color: #fff; border: none; border-radius: 24px; font-size: 15px; cursor: pointer; }
  #send:disabled { opacity: .5; cursor: default; }
  .cursor::after { content: '▌'; animation: blink .7s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
</style>
</head>
<body>
<header id="header">xclaw</header>
<div id="messages"></div>
<form id="form">
  <input id="input" type="text" placeholder="输入消息…" autocomplete="off">
  <button id="send" type="submit">发送</button>
</form>
<script>
// Persist sessionId across page refreshes.
let sessionId = localStorage.getItem('xclaw_session_id');
if (!sessionId) {
  sessionId = 'web-' + Math.random().toString(36).slice(2);
  localStorage.setItem('xclaw_session_id', sessionId);
}
document.getElementById('header').textContent = 'xclaw — ' + sessionId;

const msgs  = document.getElementById('messages');
const input = document.getElementById('input');
const send  = document.getElementById('send');

// ── WebSocket connection ──────────────────────────────────────────────────────
const ws = new WebSocket('ws://' + location.host + '/ws');
let agentBubble = null;

ws.addEventListener('open', () => {
  // Send reconnect so the server can push back history.
  ws.send(JSON.stringify({ type: 'reconnect', sessionId }));
});

ws.addEventListener('message', (ev) => {
  const pkt = JSON.parse(ev.data);
  if (pkt.type === 'history') {
    let messages = [];
    try { messages = JSON.parse(pkt.content); } catch {}
    if (messages.length > 0) {
      const divTop = document.createElement('div');
      divTop.className = 'divider';
      divTop.textContent = '── 以下为历史消息 ──';
      msgs.appendChild(divTop);
      for (const m of messages) {
        addBubble(m.role === 'user' ? 'user' : 'agent', m.content, true);
      }
      const divBot = document.createElement('div');
      divBot.className = 'divider';
      divBot.textContent = '── 以上为历史消息 ──';
      msgs.appendChild(divBot);
      msgs.scrollTop = msgs.scrollHeight;
    }
  } else if (pkt.type === 'delta') {
    if (agentBubble) {
      agentBubble.textContent += pkt.content;
      msgs.scrollTop = msgs.scrollHeight;
    }
  } else if (pkt.type === 'reply') {
    if (agentBubble) agentBubble.classList.remove('cursor');
    agentBubble = null;
    input.disabled = false;
    send.disabled  = false;
    input.focus();
  } else if (pkt.type === 'error') {
    if (agentBubble) {
      agentBubble.textContent = '错误：' + pkt.content;
      agentBubble.classList.remove('cursor');
    }
    agentBubble = null;
    input.disabled = false;
    send.disabled  = false;
  }
});

ws.addEventListener('close', () => {
      console.warn('WebSocket disconnected');
});

// ── Send message ──────────────────────────────────────────────────────────────
function addBubble(role, text, restored) {
  const wrap = document.createElement('div');
  const lbl  = document.createElement('div');
  const bbl  = document.createElement('div');
  lbl.className = 'label';
  lbl.textContent = role === 'user' ? 'You' : 'xclaw';
  bbl.className = 'bubble ' + role + (restored ? ' restored' : '');
  bbl.textContent = text;
  wrap.append(lbl, bbl);
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
  return bbl;
}

document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || ws.readyState !== WebSocket.OPEN) return;
  input.value = '';
  input.disabled = true;
  send.disabled  = true;

  addBubble('user', text, false);
  agentBubble = addBubble('agent', '', false);
  agentBubble.classList.add('cursor');

  ws.send(JSON.stringify({ type: 'message', sessionId, content: text }));
});

input.focus();
</script>
</body>
</html>`;

// ── Web Adapter ───────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['WEB_PORT'] ?? '3000', 10);

export function createWebAdapter(): ChannelAdapter {
  let messageHandler: ((msg: ACPMessage) => void) | null = null;

  // sessionId → WebSocket，用于把 Agent 回复推回对应浏览器
  const clients = new Map<string, WebSocket>();

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
    } else {
      res.writeHead(404).end();
    }
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    let sessionId: string | null = null;

    ws.on('message', (raw) => {
      let pkt: { type: string; sessionId: string; content?: string };
      try { pkt = JSON.parse(raw.toString()); } catch { return; }

      if (pkt.type === 'reconnect') {
        sessionId = pkt.sessionId;
        clients.set(sessionId, ws);
        // Forward as reconnect to the gateway.
        messageHandler?.({
          id: crypto.randomUUID(),
          sessionId,
          channel: 'web',
          content: '',
          timestamp: Date.now(),
          type: 'reconnect',
        });
        return;
      }

      if (pkt.type !== 'message') return;

      sessionId = pkt.sessionId;
      clients.set(sessionId, ws);

      messageHandler?.({
        id: crypto.randomUUID(),
        sessionId,
        channel: 'web',
        content: pkt.content ?? '',
        timestamp: Date.now(),
        type: 'message',
      });
    });

    ws.on('close', () => {
      if (sessionId) clients.delete(sessionId);
    });
  });

  return {
    name: 'web',

    onMessage(h) { messageHandler = h; },

    send(reply: AgentReply): void {
      const ws = clients.get(reply.sessionId);
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: reply.type, content: reply.content }));
    },

    async start(): Promise<void> {
      await new Promise<void>((resolve) => httpServer.listen(PORT, resolve));
      log(`[web]     http://localhost:${PORT}`);
    },
  };
}
