import WebSocket from 'ws';
import type { ChannelAdapter } from './types.ts';
import type { ACPMessage, AgentReply } from '../gateway/types.ts';
import { log } from '../logger.ts';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE  = 'https://api.sgroup.qq.com';

// GROUP_AND_C2C (1<<25) intent — covers private C2C messages and group @ messages
const INTENTS = (1 << 25);

// ── Token 缓存 ────────────────────────────────────────────────────────────────

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(appId: string, secret: string): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: secret }),
  });
  const data = await res.json() as { access_token: string; expires_in: number };
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function getGatewayUrl(accessToken: string): Promise<string> {
  const res = await fetch(`${API_BASE}/gateway`, {
    headers: { Authorization: `QQBot ${accessToken}` },
  });
  const data = await res.json() as { url: string };
  return data.url;
}

// ── 发送消息 ──────────────────────────────────────────────────────────────────

async function sendC2C(token: string, openid: string, content: string, msgId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v2/users/${openid}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, msg_type: 0, msg_id: msgId, msg_seq: Date.now() % 65536 }),
  });
  if (!res.ok) console.error(`[qq] sendC2C failed: ${res.status} ${await res.text()}`);
}

async function sendGroup(token: string, groupOpenid: string, content: string, msgId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v2/groups/${groupOpenid}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, msg_type: 0, msg_id: msgId, msg_seq: Date.now() % 65536 }),
  });
  if (!res.ok) console.error(`[qq] sendGroup failed: ${res.status} ${await res.text()}`);
}

// ── QQ Gateway WebSocket ──────────────────────────────────────────────────────

function connectGateway(
  appId: string,
  secret: string,
  onEvent: (t: string, d: unknown) => void,
): void {
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastSeq: number | null = null;

  const cleanup = (ws: WebSocket) => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (ws.readyState === WebSocket.OPEN) ws.close();
  };

  const connect = async () => {
    try {
      const accessToken = await getAccessToken(appId, secret);
      const gatewayUrl = await getGatewayUrl(accessToken);
      if (!gatewayUrl) {
        console.error('[qq] failed to get gateway URL (check QQ_APP_ID / QQ_CLIENT_SECRET), giving up');
        return;
      }
      log(`[qq] connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl);

      ws.on('message', (raw) => {
        let payload: { op: number; t?: string; d?: unknown; s?: number };
        try { payload = JSON.parse(raw.toString()); } catch { return; }
        const { op, t, d, s } = payload;
        if (s != null) lastSeq = s;

        switch (op) {
          case 10: { // HELLO
            const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ op: 1, d: lastSeq }));
              }
            }, interval);

            // IDENTIFY
            ws.send(JSON.stringify({
              op: 2,
              d: { token: `QQBot ${accessToken}`, intents: INTENTS, shard: [0, 1] },
            }));
            break;
          }
          case 0: // DISPATCH
            if (t) onEvent(t, d);
            break;
          case 11: // Heartbeat ACK
            break;
          case 9: // Invalid session
            console.error('[qq] invalid session, reconnecting…');
            cleanup(ws);
            setTimeout(connect, 5000);
            break;
          case 7: // Reconnect
            log('[qq] server requested reconnect');
            cleanup(ws);
            setTimeout(connect, 1000);
            break;
        }
      });

      ws.on('open', () => log('[qq] WebSocket connected'));
      ws.on('error', (err) => console.error('[qq] WebSocket error:', err));
      ws.on('close', (code) => {
        log(`[qq] WebSocket closed (code=${code}), reconnecting in 5s…`);
        cleanup(ws);
        setTimeout(connect, 5000);
      });
    } catch (err) {
      console.error('[qq] connect error:', err, '— retrying in 10s');
      setTimeout(connect, 10_000);
    }
  };

  connect();
}

// ── QQ Adapter ────────────────────────────────────────────────────────────────

export function createQQAdapter(): ChannelAdapter {
  const appId  = process.env['QQ_APP_ID'] ?? '';
  const secret = process.env['QQ_CLIENT_SECRET'] ?? '';

  let messageHandler: ((msg: ACPMessage) => void) | null = null;

  // 每条入站消息的回复上下文：sessionId → { type, targetId, msgId }
  const replyCtx = new Map<string, { type: 'c2c' | 'group'; targetId: string; msgId: string }>();

  return {
    name: 'qq',

    onMessage(h) { messageHandler = h; },

    send(reply: AgentReply): void {
      // delta 不发给 QQ（不支持流式）；只在最终 reply 时发送
      if (reply.type !== 'reply') return;
      const ctx = replyCtx.get(reply.sessionId);
      if (!ctx) return;
      replyCtx.delete(reply.sessionId);

      getAccessToken(appId, secret)
        .then((token) => ctx.type === 'c2c'
          ? sendC2C(token, ctx.targetId, reply.content, ctx.msgId)
          : sendGroup(token, ctx.targetId, reply.content, ctx.msgId))
        .catch((err) => console.error('[qq] send error:', err));
    },

    async start(): Promise<void> {
      if (!appId || !secret) {
        log('[qq] QQ_APP_ID / QQ_CLIENT_SECRET 未配置，跳过 QQ 渠道');
        return;
      }

      connectGateway(appId, secret, (t, d: any) => {
        if (t === 'C2C_MESSAGE_CREATE') {
          const msg = d.msg ?? d;
          const openid  = msg.author?.user_openid ?? msg.author?.id;
          const text    = (msg.content ?? '').replace(/<@!\d+>/g, '').trim();
          const msgId   = msg.id;
          if (!text) return;

          const sessionId = `qq-c2c-${openid}`;
          replyCtx.set(sessionId, { type: 'c2c', targetId: openid, msgId });
          log(`[qq] c2c from ${openid}: ${text}`);
          messageHandler?.({ id: crypto.randomUUID(), sessionId, channel: 'qq', content: text, timestamp: Date.now() });
        }

        if (t === 'GROUP_AT_MESSAGE_CREATE') {
          const msg         = d.msg ?? d;
          const groupOpenid = msg.group_openid;
          const openid      = msg.author?.member_openid ?? msg.author?.id;
          const text        = (msg.content ?? '').replace(/<@!\d+>/g, '').trim();
          const msgId       = msg.id;
          if (!text) return;

          const sessionId = `qq-group-${groupOpenid}`;
          replyCtx.set(sessionId, { type: 'group', targetId: groupOpenid, msgId });
          log(`[qq] group ${groupOpenid} from ${openid}: ${text}`);
          messageHandler?.({ id: crypto.randomUUID(), sessionId, channel: 'qq', content: text, timestamp: Date.now() });
        }
      });
    },
  };
}
