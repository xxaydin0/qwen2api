/**
 * Vercel Node.js Entry Point - Reuses core.js (shares identical logic with Local / Netlify)
 *
 * Notes:
 * - Switched from Edge Runtime to Node Runtime so CommonJS core.js can be required directly.
 * - When stream=true, upstream SSE is forwarded in real time via createExpressStreamHandler
 *   (Vercel Node functions natively support streaming responses), matching local Express behavior.
 * - Timeout is configured via module.exports.config.maxDuration: Hobby cap is 60s, Pro allows higher.
 * - Cannot run Chromium / yt-dlp; tokens use the lightweight fallback path.
 */

const {
  handleModels,
  handleChatCompletions,
  handleChatCompletionsWithLogs,
  handleImageGenerations,
  handleRoot,
  handleChatPage,
  createExpressStreamHandler,
  createExpressLogStreamHandler,
} = require('../core.js');

const API_PREFIX = '/api';

function normalizePath(req) {
  let pathname = req.url || req.path || '';
  try {
    pathname = new URL(pathname, 'http://localhost').pathname;
  } catch {}
  if (pathname === API_PREFIX) return '/';
  if (pathname.startsWith(API_PREFIX + '/')) {
    const rest = pathname.slice(API_PREFIX.length);
    return rest || '/';
  }
  return pathname;
}

function parseBody(req) {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body || {};
}

function sendResult(res, result) {
  const headers = result.headers || {};
  for (const key of Object.keys(headers)) {
    if (headers[key] !== undefined && headers[key] !== null) {
      res.setHeader(key, headers[key]);
    }
  }
  return res.status(result.statusCode).send(result.body);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const pathname = normalizePath(req);
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';

  if (req.method === 'GET' && pathname === '/v1/models') {
    return sendResult(res, await handleModels(authHeader));
  }

  if (req.method === 'POST' && pathname === '/v1/chat/completions/log') {
    const result = await handleChatCompletionsWithLogs(parseBody(req), authHeader, undefined, createExpressLogStreamHandler(res));
    if (res.headersSent) {
      if (!res.writableEnded && result && typeof result.statusCode === 'number') {
        let payload = { error: { message: `HTTP ${result.statusCode}`, type: 'api_error' } };
        try {
          const parsed = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
          if (parsed && parsed.error) {
            payload = parsed;
          } else if (result.statusCode >= 200 && result.statusCode < 300 && parsed) {
            payload = parsed;
          }
        } catch {}
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
      return;
    }
    if (result && typeof result.statusCode === 'number') {
      return sendResult(res, result);
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/chat/completions') {
    const result = await handleChatCompletions(parseBody(req), authHeader, undefined, createExpressStreamHandler(res));
    if (result && typeof result.statusCode === 'number') {
      return sendResult(res, result);
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/images/generations') {
    return sendResult(res, await handleImageGenerations(parseBody(req), authHeader));
  }

  if (req.method === 'GET' && (pathname === '/chat' || pathname === '/chat/')) {
    return sendResult(res, handleChatPage());
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '')) {
    return sendResult(res, handleRoot());
  }

  return res.status(404).json({ error: { message: 'Not found', type: 'invalid_request_error' } });
};

// Vercel function maximum execution duration (seconds):
// - Hobby plan hard cap is 60s (higher values are clamped to 60)
// - Pro plan up to 300s, Enterprise up to 800s
// Attachment uploads (OSS PUT + status polling) take longer; keep a high value on Pro and above.
module.exports.config = { maxDuration: 300 };

