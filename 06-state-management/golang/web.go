package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ── Inline chat HTML ──────────────────────────────────────────────────────────

const webHTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>xclaw</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f0f2f5; height: 100vh; display: flex; flex-direction: column; }
  header { background: #1a73e8; color: #fff; padding: 14px 20px; font-size: 18px; font-weight: 600; letter-spacing: .5px; display: flex; align-items: center; justify-content: space-between; }
  #session-id { font-size: 11px; opacity: .7; font-weight: 400; font-family: monospace; }
  #messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
  .bubble { max-width: 70%; padding: 10px 14px; border-radius: 16px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .user   { align-self: flex-end; background: #1a73e8; color: #fff; border-bottom-right-radius: 4px; }
  .agent  { align-self: flex-start; background: #fff; color: #333; border-bottom-left-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .label  { font-size: 11px; color: #888; margin-bottom: 3px; }
  .restored { opacity: .6; }
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
<header>
  xclaw
  <span id="session-id"></span>
</header>
<div id="messages"></div>
<form id="form">
  <input id="input" type="text" placeholder="输入消息… (支持 /rollback <stepID> 和 /fork <stepID> [title])" autocomplete="off">
  <button id="send" type="submit">发送</button>
</form>
<script>
// Persist sessionId across page reloads — this is what enables history restoration.
let sessionId = localStorage.getItem('xclaw_session_id');
if (!sessionId) {
  sessionId = 'web-' + Math.random().toString(36).slice(2, 10);
  localStorage.setItem('xclaw_session_id', sessionId);
}
document.getElementById('session-id').textContent = sessionId;

const msgs  = document.getElementById('messages');
const input = document.getElementById('input');
const send  = document.getElementById('send');

const ws = new WebSocket('ws://' + location.host + '/ws');
let agentBubble = null;

// On connect: immediately send reconnect so the server can push back history.
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'reconnect', sessionId }));
});

ws.addEventListener('message', (ev) => {
  const pkt = JSON.parse(ev.data);
  if (pkt.type === 'history') {
    // Server pushed back previous conversation — restore as greyed-out bubbles.
    const messages = JSON.parse(pkt.content || '[]');
    for (const m of messages) {
      const role = m.role === 'user' ? 'user' : 'agent';
      addBubble(role, m.content, true);
    }
    if (messages.length > 0) {
      addDivider('── 以上为历史消息 ──');
    }
  } else if (pkt.type === 'delta') {
    if (agentBubble) { agentBubble.textContent += pkt.content; msgs.scrollTop = msgs.scrollHeight; }
  } else if (pkt.type === 'reply') {
    if (agentBubble) agentBubble.classList.remove('cursor');
    agentBubble = null;
    input.disabled = false; send.disabled = false; input.focus();
  } else if (pkt.type === 'error') {
    if (agentBubble) { agentBubble.textContent = '错误：' + pkt.content; agentBubble.classList.remove('cursor'); }
    agentBubble = null;
    input.disabled = false; send.disabled = false;
  }
});
ws.addEventListener('close', () => console.warn('WebSocket disconnected'));

function addBubble(role, text, restored) {
  const wrap = document.createElement('div');
  const lbl  = document.createElement('div');
  const bbl  = document.createElement('div');
  lbl.className = 'label'; lbl.textContent = role === 'user' ? 'You' : 'xclaw';
  bbl.className = 'bubble ' + role + (restored ? ' restored' : '');
  bbl.textContent = text;
  wrap.append(lbl, bbl); msgs.appendChild(wrap); msgs.scrollTop = msgs.scrollHeight;
  return bbl;
}

function addDivider(text) {
  const div = document.createElement('div');
  div.style.cssText = 'text-align:center;font-size:11px;color:#aaa;padding:4px 0;';
  div.textContent = text;
  msgs.appendChild(div);
}

document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || ws.readyState !== WebSocket.OPEN) return;
  input.value = ''; input.disabled = true; send.disabled = true;
  addBubble('user', text);
  agentBubble = addBubble('agent', '');
  agentBubble.classList.add('cursor');
  ws.send(JSON.stringify({ type: 'message', sessionId, content: text }));
});
input.focus();
</script>
</body>
</html>`

// ── Web Adapter ───────────────────────────────────────────────────────────────

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type wsClient struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (c *wsClient) writeJSON(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(v)
}

type webAdapter struct {
	handler       func(ACPMessage)
	historyLoader func(sessionID string) []HistoryEntry // set by Gateway.register()
	clients       sync.Map                              // sessionID -> *wsClient
}

func newWebAdapter() *webAdapter { return &webAdapter{} }

func (w *webAdapter) name() string { return "web" }

func (w *webAdapter) onMessage(h func(ACPMessage)) { w.handler = h }

func (w *webAdapter) send(reply AgentReply) {
	v, ok := w.clients.Load(reply.SessionID)
	if !ok {
		return
	}
	_ = v.(*wsClient).writeJSON(map[string]string{
		"type":    reply.Type,
		"content": reply.Content,
	})
}

func (w *webAdapter) handleWS(rw http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(rw, r, nil)
	if err != nil {
		return
	}
	client := &wsClient{conn: conn}
	var sessionID string

	defer func() {
		conn.Close()
		if sessionID != "" {
			w.clients.Delete(sessionID)
		}
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var pkt struct {
			Type      string `json:"type"`
			SessionID string `json:"sessionId"`
			Content   string `json:"content"`
		}
		if json.Unmarshal(raw, &pkt) != nil {
			continue
		}

		// reconnect: browser sends this on every page load with its stored sessionId.
		// We push back the conversation history without calling the agent.
		if pkt.Type == "reconnect" && pkt.SessionID != "" {
			sessionID = pkt.SessionID
			w.clients.Store(sessionID, client)
			if w.historyLoader != nil {
				history := w.historyLoader(sessionID)
				_ = client.writeJSON(map[string]string{
					"type":    "history",
					"content": marshalHistory(history),
				})
			}
			continue
		}

		if pkt.Type != "message" {
			continue
		}

		if sessionID == "" {
			sessionID = pkt.SessionID
			w.clients.Store(sessionID, client)
		}

		w.handler(ACPMessage{
			ID:        newUUID(),
			SessionID: sessionID,
			Channel:   "web",
			Content:   pkt.Content,
			Timestamp: time.Now().UnixMilli(),
		})
	}
}

func (w *webAdapter) start() error {
	port := os.Getenv("WEB_PORT")
	if port == "" {
		port = "3000"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "text/html; charset=utf-8")
		rw.Write([]byte(webHTML))
	})
	mux.HandleFunc("/ws", w.handleWS)

	fmt.Fprintf(os.Stderr, "[web] http://localhost:%s\n", port)
	go func() {
		if err := http.ListenAndServe(":"+port, mux); err != nil {
			fmt.Fprintf(os.Stderr, "[web] server error: %v\n", err)
		}
	}()
	return nil
}
