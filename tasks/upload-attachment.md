# Upload Attachment Request Sample

## 1. Request STS Token (`POST /api/v2/files/getstsToken`)

```js
fetch("https://chat.qwen.ai/api/v2/files/getstsToken", {
  "headers": {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    "source": "web",
    "x-request-id": "fb279124-958a-4c6c-bb30-6b4e7f7c9e95",
    "Referer": "https://chat.qwen.ai/c/guest"
  },
  "body": JSON.stringify({
    "filename": "image.png",
    "filesize": 286407,
    "filetype": "image"
  }),
  "method": "POST"
});
```

## 2. Chat Completion with Uploaded Image Attachment

```js
fetch("https://chat.qwen.ai/api/v2/chat/completions?chat_id=14275b56-0ba2-46c5-bec5-de8430b583bf", {
  "headers": {
    "accept": "application/json",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    "source": "web",
    "x-accel-buffering": "no",
    "x-request-id": "6f84499d-099a-498c-beb3-2046376ba2a4",
    "Referer": "https://chat.qwen.ai/c/14275b56-0ba2-46c5-bec5-de8430b583bf"
  },
  "body": JSON.stringify({
    "stream": true,
    "version": "2.1",
    "incremental_output": true,
    "chat_id": "14275b56-0ba2-46c5-bec5-de8430b583bf",
    "chat_mode": "normal",
    "model": "qwen3.5-plus",
    "parent_id": null,
    "messages": [
      {
        "fid": "dc16d3e7-810e-4ba1-9bf5-b2e2eb5c27b8",
        "parentId": null,
        "childrenIds": [
          "db55e6ef-e32b-47ef-9775-f6a20233cb12"
        ],
        "role": "user",
        "content": "Describe this image in detail",
        "user_action": "chat",
        "files": [
          {
            "type": "image",
            "file": {
              "created_at": 1771316522164,
              "data": {},
              "filename": "image.png",
              "hash": null,
              "id": "df1be717-f1a7-4aa0-8ae9-f66f092c179f",
              "user_id": "guest",
              "meta": {
                "name": "image.png",
                "size": 286407,
                "content_type": "image/png"
              },
              "update_at": 1771316522164
            },
            "id": "df1be717-f1a7-4aa0-8ae9-f66f092c179f",
            "url": "https://qianwen-res.oss-accelerate.aliyuncs.com/...",
            "name": "image.png",
            "collection_name": "",
            "progress": 0,
            "status": "uploaded",
            "greenNet": "success",
            "size": 286407,
            "error": "",
            "itemId": "f4c158be-d9ca-403e-b42d-53ee0a2cb3c1",
            "file_type": "image/png",
            "showType": "image",
            "file_class": "vision",
            "uploadTaskId": "8f274e5e-3940-4848-8789-37b7fc45a1e6"
          }
        ],
        "timestamp": 1771316525,
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
    "timestamp": 1771316525
  }),
  "method": "POST"
});
```