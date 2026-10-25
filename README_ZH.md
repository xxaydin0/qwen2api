# Qwen2API

[English](README.md)

A proxy service that converts Qwen Chat into an OpenAI-compatible API.

## Features

- 🔄 OpenAI API compatible format
- 🛠️ Reliable OpenAI-compatible Tool / Function Calling (`tools`, `tool_choice`, `parallel_tool_calls`, streaming & non-streaming `tool_calls`)
- 🚀 Streaming response support (SSE)
- 🔐 Optional API Token authentication
- 🌐 Multi-platform deployment: Local NodeJS / Docker, Vercel, Netlify, Cloudflare Workers
- 🖼️ Image generation support
- 🎬📄 Video analysis, image and document parsing support
- 💬 Built-in web chat interface

## Architecture Overview

All deployment targets share one codebase: every platform entry (`index.js`,
`api/index.js`, `netlify/functions/api.js`, `worker.js`) is a thin protocol
adapter that calls the same `core.js` business logic. Routes, attachment
uploads, tool calling, streaming and error handling therefore behave identically everywhere.

```
                     ┌──────────────────────────────────────┐
                     │  Clients: OpenAI SDK / curl / the    │
                     │  built-in /chat web page             │
                     └──────────────────┬───────────────────┘
                                        │  OpenAI-compatible HTTP
                                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Entry adapters (thin wrappers: routing + platform protocol only)        │
│                                                                          │
│   index.js              api/index.js       netlify/functions/api.js      │
│   (Express,             (Vercel Node fn,   (Netlify Node fn,             │
│    local / Docker)       maxDuration)         timeout)                   │
│   worker.js                                                              │
│   (CF Worker, nodejs_compat)                                             │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  core.js — the single business-logic module (bundled into every entry)  │
│                                                                          │
│   Routes:  GET  /v1/models                 (model list from upstream)    │
│            POST /v1/chat/completions       (chat + tool calling)         │
│            POST /v1/chat/completions/log   (chat + progress logs;        │
│                                              video-analysis endpoint)    │
│            POST /v1/images/generations     (image generation)            │
│            GET  /chat                      (built-in chat UI)            │
│            GET  /                          (health check)                │
│                                                                          │
│   /chat page:  read chat.html from disk (local dev, always fresh)        │
│                → fallback to bundled chat-html.js when unreadable        │
│                  (serverless function environments); regenerate with:    │
│                  npm run build:chat-html                                 │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │  per-request pipeline
                                    ▼
   ①  Auth      validateToken — env API_TOKENS (empty ⇒ open access)
   ②  Tokens    getBaxiaTokens
                  ├─ Node + Chromium → real baxia SDK (T2gAv_ + cookies, 25-min cache)
                  └─ serverless / CF → simplified token (wu.json), auto fallback
   ③  Session   createChatSession — /api/v2/chats/new, retry with fresh token ×3
   ④  Parse     messages + tools → prompt + tool definitions + attachments
   ⑤  Video     [only /log endpoint] body.video_url → yt-dlp download
                  → wrapped as a video attachment
                  (local/Docker only; serverless returns a clear error)
   ⑥  Upload    per attachment: bytes → getstsToken → PUT Qwen OSS (V4 signed)
                  → status poll (skipped for video) → document parse (documents)
   ⑦  Chat      POST /api/v2/chat/completions (upstream SSE, files=uploaded)
   ⑧  Respond   stream=true  → live SSE mapping (Express / Vercel / CF)
                               or buffered SSE, returned whole (Netlify)
                stream=false → collected JSON chat.completion (with tool_calls)
```

### Tool Calling (Function Calling)

`/v1/chat/completions` and `/v1/chat/completions/log` support OpenAI-style tool calling in both streaming (`stream: true`) and non-streaming (`stream: false`) modes:

- **`tools` & `functions`**: Standard OpenAI `tools` array (`[{ "type": "function", "function": { "name", "description", "parameters" } }]`) as well as legacy `functions`.
- **`tool_choice` & `function_call`**:
  - `"auto"` (default): Model decides whether to call a tool or reply with text.
  - `"required"` / `"any"`: Model is required to call at least one declared tool.
  - `"none"`: Disables tool calling even when `tools` are provided.
  - `{"type": "function", "function": {"name": "..."}}`: Forces calling a specific function.
- **Reliability features**:
  - Schema-enforced `<tool_call>` protocol with automatic JSON repair (handles trailing commas, code fences, single-quoted strings, Python `True`/`False`/`None`, and unclosed tags).
  - Automatic argument coercion against the JSON Schema (`number`, `integer`, `boolean`, `array`, `object`, `string`, and schema `default` values).
  - Automatic self-correction retry if `tool_choice` is `"required"` or targets a specific function and the first upstream pass fails to produce a valid tool call.
  - Multi-turn support for `role: "assistant"` messages with `tool_calls` and `role: "tool"` (or `role: "function"`) result messages.

### Video Analysis Flow

Video analysis reuses the **general chat endpoint** (`/v1/chat/completions/log`)
plus one optional field — no dedicated endpoint is needed. The web chat UI
auto-switches to this endpoint when a video URL is filled in.

```
POST /v1/chat/completions/log
body: {
  "messages": [...],
  "stream": true,
  "video_url": "https://...",      // triggers video analysis
  "min_video_resolution": 480      // optional, default 480
}

  ①  yt-dlp downloads the video (resolution: body → env MIN_VIDEO_RESOLUTION → 480)
  ②  the video becomes a normal 'video' attachment
  ③  same OSS upload chain as images/files (status polling skipped for video)
  ④  regular chat completion against the uploaded file
```

### Platform Capabilities

| Capability | Local / Docker | Vercel | Netlify | CF Worker |
|------------|----------------|--------|---------|-----------|
| Real baxia token (Chromium) | ✅ | ❌ simplified | ❌ simplified | ❌ simplified |
| Live SSE streaming | ✅ | ✅ | ⚠️ buffered | ✅ |
| Tool / Function calling | ✅ | ✅ | ✅ | ✅ |
| Video analysis (yt-dlp) | ✅ | ❌ | ❌ | ❌ |
| Attachment upload (OSS) | ✅ | ✅  | ✅  | ✅  |
| Chat page `/chat` | ✅ file | ✅ inline | ✅ inline | ✅ inline |

## Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Server runs at http://localhost:3000
```

## Disclaimer

This project is for learning and testing purposes only. Do not use it in production or commercial environments. Users are solely responsible for any consequences arising from the use of this project, and the project author assumes no liability.

## License

MIT
