/**
 * Netlify Functions Entry Point - Node Runtime (non-Edge Function)
 *
 * netlify.toml rewrites /v1/*, /chat, and / to /.netlify/functions/api
 * via [[redirects]], handled uniformly by this function.
 *
 * Differences from Edge Functions:
 * - Standard Netlify Functions buffer the full response before returning, so requests
 *   with stream=true are collected by core.js as a complete SSE payload and returned at once.
 * - Timeout is configured in netlify.toml: synchronous function limit is 26s on Pro/Enterprise
 *   and 10s on free Hobby tier.
 * - Cannot run Chromium/yt-dlp; tokens use the lightweight fallback path.
 */

const {
  handleModels,
  handleChatCompletions,
  handleChatCompletionsWithLogs,
  handleImageGenerations,
  handleRoot,
  handleChatPage,
} = require('../../core.js');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const NETLIFY_FN_PREFIX = '/.netlify/functions/api';

function normalizePath(event) {
  let pathname = event.path || '';
  try {
    pathname = new URL(pathname, 'http://localhost').pathname;
  } catch {}
  if (pathname === NETLIFY_FN_PREFIX) return '/';
  if (pathname.startsWith(NETLIFY_FN_PREFIX + '/')) {
    const rest = pathname.slice(NETLIFY_FN_PREFIX.length);
    return rest || '/';
  }
  return pathname;
}

function parseBody(event) {
  if (!event.body) return {};
  let text = event.body;
  if (event.isBase64Encoded) {
    try {
      text = Buffer.from(event.body, 'base64').toString('utf8');
    } catch {
      return {};
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function toNetlifyResponse(result) {
  if (!result || typeof result.statusCode !== 'number') {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'No response from handler', type: 'api_error' } }),
    };
  }
  return {
    statusCode: result.statusCode,
    headers: { ...CORS_HEADERS, ...(result.headers || {}) },
    body: typeof result.body === 'string' ? result.body : JSON.stringify(result.body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const pathname = normalizePath(event);
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';

  if (event.httpMethod === 'GET' && pathname === '/v1/models') {
    return toNetlifyResponse(await handleModels(authHeader));
  }

  if (event.httpMethod === 'POST' && pathname === '/v1/chat/completions/log') {
    return toNetlifyResponse(await handleChatCompletionsWithLogs(parseBody(event), authHeader));
  }

  if (event.httpMethod === 'POST' && pathname === '/v1/chat/completions') {
    return toNetlifyResponse(await handleChatCompletions(parseBody(event), authHeader));
  }

  if (event.httpMethod === 'POST' && pathname === '/v1/images/generations') {
    return toNetlifyResponse(await handleImageGenerations(parseBody(event), authHeader));
  }

  if (event.httpMethod === 'GET' && (pathname === '/chat' || pathname === '/chat/')) {
    return toNetlifyResponse(handleChatPage());
  }

  if (event.httpMethod === 'GET' && (pathname === '/' || pathname === '')) {
    return toNetlifyResponse(handleRoot());
  }

  return {
    statusCode: 404,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }),
  };
};
