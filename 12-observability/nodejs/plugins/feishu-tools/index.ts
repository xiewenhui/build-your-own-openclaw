import { definePluginEntry } from '../../src/plugin-sdk/define.ts';

export default definePluginEntry({
  id: 'feishu-tools',
  name: 'Feishu Tools',
  description: 'Feishu messaging — send messages to users and groups',

  register(api) {
    api.registerTool({
      name: 'feishu_send_message',
      description: '向飞书用户或群聊发送文本消息。需要 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量。',
      parameters: {
        type: 'object',
        properties: {
          receive_id: { type: 'string', description: '接收方 ID：用户 open_id（ou_xxx）或群聊 chat_id（oc_xxx）' },
          receive_id_type: { type: 'string', description: 'ID 类型：open_id | chat_id | user_id | email，默认 open_id' },
          content: { type: 'string', description: '消息正文（纯文本）' },
        },
        required: ['receive_id', 'content'],
      },
      async execute(_sessionId, params) {
        const appId = process.env['FEISHU_APP_ID'];
        const appSecret = process.env['FEISHU_APP_SECRET'];
        if (!appId || !appSecret) {
          return 'error: FEISHU_APP_ID or FEISHU_APP_SECRET not set';
        }

        // 1. Get tenant access token
        const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        });
        const tokenData = await tokenRes.json() as any;
        if (tokenData.code !== 0) return `error: ${tokenData.msg}`;

        // 2. Send message
        const idType = params['receive_id_type'] ?? 'open_id';
        const sendRes = await fetch(
          `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${idType}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenData.tenant_access_token}` },
            body: JSON.stringify({
              receive_id: params['receive_id'],
              msg_type: 'text',
              content: JSON.stringify({ text: params['content'] }),
            }),
          },
        );
        const sendData = await sendRes.json() as any;
        if (sendData.code !== 0) return `error: ${sendData.msg}`;
        return `ok: message sent (msg_id: ${sendData.data?.message_id ?? 'unknown'})`;
      },
    });
  },
});
