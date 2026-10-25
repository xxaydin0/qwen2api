# Chat with Thinking Request Sample

```js
fetch("https://chat.qwen.ai/api/v2/chat/completions?chat_id=f9cd4ce1-c216-4f59-bc3d-ad3eb0e88977", {
  "headers": {
    "accept": "application/json",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    "source": "web",
    "x-accel-buffering": "no",
    "x-request-id": "6f2ca998-9941-40d4-b78c-3be734c43cb3",
    "Referer": "https://chat.qwen.ai/c/f9cd4ce1-c216-4f59-bc3d-ad3eb0e88977"
  },
  "body": JSON.stringify({
    "stream": true,
    "version": "2.1",
    "incremental_output": true,
    "chat_id": "f9cd4ce1-c216-4f59-bc3d-ad3eb0e88977",
    "chat_mode": "normal",
    "model": "qwen3.5-plus",
    "parent_id": null,
    "messages": [
      {
        "fid": "2dc4a351-67e8-4f63-bec8-49e39e1f6f18",
        "parentId": null,
        "childrenIds": [
          "13f36d54-988a-4e20-bb33-28612b1da980"
        ],
        "role": "user",
        "content": "Introduce yourself",
        "user_action": "chat",
        "files": [],
        "timestamp": 1771316375,
        "models": [
          "qwen3.5-plus"
        ],
        "chat_type": "t2t",
        "feature_config": {
          "thinking_enabled": true,
          "output_schema": "phase",
          "research_mode": "normal",
          "auto_search": true
        },
        "extra": {
          "meta": {
            "subChatType": "t2t"
          }
        },
        "sub_chat_type": "t2t",
        "parent_id": null
      }
    ],
    "timestamp": 1771316375
  }),
  "method": "POST"
});
```

## Upstream SSE Response Sample

```text
data: {"response.created":{"chat_id":"f9cd4ce1-c216-4f59-bc3d-ad3eb0e88977","parent_id":"2dc4a351-67e8-4f63-bec8-49e39e1f6f18","response_id":"13f36d54-988a-4e20-bb33-28612b1da980"}}

data: {"choices":[{"delta":{"role":"assistant","content":"The user wants me to ","phase":"think","status":"typing"}}]}

data: {"choices":[{"delta":{"role":"assistant","content":"introduce myself.","phase":"think","status":"typing"}}]}

data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"think","status":"finished"}}]}

data: {"choices":[{"delta":{"role":"assistant","content":"Hello! I am Qwen, a large-scale language model developed by Alibaba Cloud.","phase":"answer","status":"typing"}}]}

data: {"choices":[{"delta":{"role":"assistant","content":"","phase":"answer","status":"finished"}}]}
```