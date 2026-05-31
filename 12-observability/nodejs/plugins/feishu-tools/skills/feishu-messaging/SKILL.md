---
name: feishu-messaging
description: "Send Feishu messages to users and groups using feishu_send_message tool."
user-invocable: false
metadata:
  openclaw:
    emoji: "🔵"
    requires:
      env: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"]
---

# Feishu Messaging

Use `feishu_send_message` to send text messages to Feishu users or group chats.

## Tool: feishu_send_message

```json
{
  "action": "feishu_send_message",
  "receive_id": "ou_xxxxxxxxxxxxxxxx",
  "receive_id_type": "open_id",
  "content": "任务完成：构建成功 ✅"
}
```

## ID Types

| `receive_id_type` | ID Format | Use When |
|-------------------|-----------|----------|
| `open_id` | `ou_xxx` | Sending to a specific user |
| `chat_id` | `oc_xxx` | Sending to a group chat |
| `user_id` | numeric | Internal user ID |
| `email` | email address | User's registered email |

## Getting IDs

- User open_id: Available from Feishu Admin or via the Events API.
- Group chat_id: Visible in the group info URL or via `im.chat.list` API.
