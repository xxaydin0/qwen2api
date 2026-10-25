/**
 * Core business logic - shared across all platforms
 */

// ============================================
// UUID generation (inlined to avoid ESM issues)
// ============================================

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ============================================
// Configuration
// ============================================

const BAXIA_VERSION = '2.5.36';
const CACHE_TTL = 4 * 60 * 1000;
const QWEN_BASE_URL = 'https://chat.qwen.ai';
const QWEN_WEB_REFERER = `${QWEN_BASE_URL}/`;
const QWEN_GUEST_REFERER = `${QWEN_BASE_URL}/c/guest`;
const WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const WEB_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
let tokenCache = null;
let tokenCacheTime = 0;

// ============================================
// Cross-platform require helper
// ============================================

// Dynamically load Node built-in modules: returns the module in Node environments,
// and returns null in environments without require (e.g., Cloudflare Workers) for graceful fallback.
// Note: Must require indirectly through this function so esbuild does not statically bundle Node built-ins
// and break Cloudflare Worker builds.
function nodeRequire(name) {
  if (typeof require !== 'function') return null;
  try {
    return require(name);
  } catch {
    return null;
  }
}

// ============================================
// Baxia Token Generation
// ============================================

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  const randomBytes = cryptoRandomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

function cryptoRandomBytes(length) {
  // Prefer crypto.randomBytes in Node environments; fallback to WebCrypto elsewhere
  const nodeCrypto = nodeRequire('crypto');
  if (nodeCrypto && typeof nodeCrypto.randomBytes === 'function') {
    return nodeCrypto.randomBytes(length);
  }
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function cryptoHash(data) {
  // Use MD5 in Node environments; return random string in other environments (CF Workers / Browser)
  const nodeCrypto = nodeRequire('crypto');
  if (nodeCrypto && typeof nodeCrypto.createHash === 'function') {
    return nodeCrypto.createHash('md5').update(data).digest('base64').substring(0, 32);
  }
  return randomString(32);
}

function generateWebGLFingerprint() {
  const renderers = [
    'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.6)',
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080, OpenGL 4.6)',
    'ANGLE (AMD, AMD Radeon RX 580, OpenGL 4.6)',
  ];
  return { renderer: renderers[Math.floor(Math.random() * renderers.length)], vendor: 'Google Inc. (Intel)' };
}

async function collectFingerprintData() {
  const platforms = ['Win32', 'Linux x86_64', 'MacIntel'];
  const languages = ['en-US', 'en-GB'];
  const canvas = cryptoHash(cryptoRandomBytes(32));
  
  return {
    p: platforms[Math.floor(Math.random() * platforms.length)],
    l: languages[Math.floor(Math.random() * languages.length)],
    hc: 4 + Math.floor(Math.random() * 12),
    dm: [4, 8, 16, 32][Math.floor(Math.random() * 4)],
    to: [-480, -300, 0, 60, 480][Math.floor(Math.random() * 5)],
    sw: 1920 + Math.floor(Math.random() * 200),
    sh: 1080 + Math.floor(Math.random() * 100),
    cd: 24,
    pr: [1, 1.25, 1.5, 2][Math.floor(Math.random() * 4)],
    wf: generateWebGLFingerprint().renderer.substring(0, 20),
    cf: canvas,
    af: (124.04347527516074 + Math.random() * 0.001).toFixed(14),
    ts: Date.now(),
    r: Math.random(),
  };
}

function encodeBaxiaToken(data) {
  const jsonStr = JSON.stringify(data);
  let encoded;
  if (typeof Buffer === 'undefined') {
    encoded = btoa(unescape(encodeURIComponent(jsonStr)));
  } else {
    encoded = Buffer.from(jsonStr).toString('base64');
  }
  return `${BAXIA_VERSION.replace(/\./g, '')}!${encoded}`;
}

async function getBaxiaTokens(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && tokenCache && (now - tokenCacheTime) < CACHE_TTL) {
    return tokenCache;
  }

  // Prefer the real baxia SDK (headless system Chrome generating valid tokens).
  // Available in local Node runtime only; serverless / CF Workers without Chrome automatically fall back to wu.json.
  const isNodeRuntime = typeof process !== 'undefined' && process.versions && typeof process.versions.node === 'string';
  const chromeEnabled = isNodeRuntime && (!process.env || process.env.USE_CHROME_BAXIA !== 'false');
  if (chromeEnabled) {
    try {
      const baxiaMod = nodeRequire('./scripts/baxia-token.js');
      if (baxiaMod && typeof baxiaMod.getBaxiaTokens === 'function') {
        const t = await baxiaMod.getBaxiaTokens();
        if (t && t.bxUmidToken && /^T2gA/i.test(t.bxUmidToken)) {
          const result = { bxUa: t.bxUa, bxUmidToken: t.bxUmidToken, bxV: t.bxV || '2.5.37', cookies: t.cookies || '' };
          tokenCache = result;
          tokenCacheTime = now;
          return result;
        } else {
          console.log('[qwen2api][baxia] Chrome branch returned invalid token, fallback');
        }
      } else {
        console.log('[qwen2api][baxia] baxia SDK unavailable in this runtime, fallback');
      }
    } catch (e) {
      console.log('[qwen2api][baxia] Chrome branch failed:', e.message);
    }
  }

  const bxUa = encodeBaxiaToken(await collectFingerprintData());
  let bxUmidToken;
  try {
    const resp = await fetch('https://sg-wum.alibaba.com/w/wu.json', {
      headers: { 'User-Agent': WEB_USER_AGENT }
    });
    const bodyText = await resp.text();
    // wu.json body: try{umx.wu('T2gA...');}catch(e){} try{__fycb('T2gA...');}catch(e){}
    // The token inside is the real umid token required by the upstream API.
    const m = bodyText.match(/umx\.wu\('([^']+)'\)/) || bodyText.match(/'([^']+)'/);
    bxUmidToken = (m && m[1]) || resp.headers.get('etag') || '';
  } catch { bxUmidToken = ''; }
  if (!bxUmidToken || !/^T2gA/i.test(bxUmidToken)) {
    // Fallback only to avoid crashing; upstream will likely reject a fake token.
    bxUmidToken = 'T2gA' + randomString(40);
  }
  
  const result = { bxUa, bxUmidToken, bxV: BAXIA_VERSION };
  tokenCache = result;
  tokenCacheTime = now;
  return result;
}

// Create chat session; automatically rotate token and retry on risk-control or network errors
async function createChatSession(actualModel, chatType, retries = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { bxUa, bxUmidToken, bxV, cookies } = await getBaxiaTokens(attempt > 0);
    try {
      const createHeaders = {
        'Accept': 'application/json', 'Content-Type': 'application/json',
        'bx-ua': bxUa, 'bx-umidtoken': bxUmidToken, 'bx-v': bxV,
        'Cookie': cookies,
        'Origin': QWEN_BASE_URL,
        'Referer': QWEN_GUEST_REFERER, 'source': 'web',
        'version': '0.2.83',
        'User-Agent': WEB_USER_AGENT,
        'Accept-Language': WEB_ACCEPT_LANGUAGE,
        'x-request-id': uuidv4()
      };
      const createBody = {
        title: 'New Chat', models: [actualModel], chat_mode: 'guest', chat_type: chatType,
        timestamp: Date.now(), project_id: ''
      };
      const createResp = await fetch(`${QWEN_BASE_URL}/api/v2/chats/new`, {
        method: 'POST',
        headers: createHeaders,
        body: JSON.stringify(createBody)
      });
      const createParsed = await safeReadJson(createResp);
      if (!createParsed.ok) {
        lastErr = { parsed: createParsed, status: createResp.status, resp: createResp };
        const preview = createParsed.rawText ? createParsed.rawText.slice(0, 300) : '(empty)';
        console.log(`[qwen2api][chat] Create chat session failed (attempt ${attempt + 1}): HTTP ${createResp.status}, body: ${preview}`);
        continue;
      }
      const createData = createParsed.data;
      if (!createData.success || !createData.data?.id) {
        const parsedErr = tryParseUpstreamErrorPayload(createParsed.rawText);
        lastErr = { parsed: createParsed, status: createResp.status, resp: createResp, parsedErr };
        console.log(`[qwen2api][chat] Create chat session error (attempt ${attempt + 1}): ${JSON.stringify(createData?.data || createData)}`);
        // Retry on risk-control / rate-limit errors
        if (parsedErr?.riskControlled || parsedErr?.code === 'rgv587' || /rgv.?587/i.test(createParsed.rawText || '')) {
          await new Promise(resolve => setTimeout(resolve, 600));
          continue;
        }
        return createResponse({ error: { message: createData?.data?.details || createData?.data?.message || createData?.data?.code || parsedErr?.message || 'Failed to create chat session', type: 'api_error', ...(parsedErr?.code ? { code: parsedErr.code } : {}) } }, 500);
      }
      return { chatId: createData.data.id, bxUa, bxUmidToken, bxV, cookies };
    } catch (err) {
      lastErr = { error: err, status: 0, resp: null };
      console.log(`[qwen2api][chat] Create chat session exception (attempt ${attempt + 1}): ${err && err.message ? err.message : String(err)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  // All attempts failed; return the most descriptive error
  const last = lastErr || {};
  if (last.parsed) {
    const parsed = last.parsed;
    const preview = parsed.rawText ? parsed.rawText.slice(0, 300) : '(empty)';
    const wafMatch = preview.match(/aliyun_waf/i);
    const msg = wafMatch
      ? 'Upstream WAF blocked the request. The IP may be rate-limited or banned by Aliyun WAF.'
      : (last.parsedErr?.message || `Failed to create chat session: upstream returned non-JSON response (HTTP ${last.status}).`);
    return createResponse({ error: { message: msg, type: 'api_error', ...(last.parsedErr?.code ? { code: last.parsedErr.code } : {}) } }, last.status && last.status >= 400 ? last.status : 502);
  }
  const errMsg = last.error && last.error.message ? last.error.message : 'Failed to create chat session';
  return createResponse({ error: { message: errMsg, type: 'api_error' } }, 502);
}

// ============================================
// Authentication
// ============================================

function getApiTokens(env) {
  // Note: Do not access process?.env directly — in environments without `process` (e.g. CF Workers),
  // referencing an undeclared identifier throws a ReferenceError even with optional chaining.
  let tokens = env?.API_TOKENS;
  if (!tokens && typeof process !== 'undefined' && process?.env) {
    tokens = process.env.API_TOKENS;
  }
  if (!tokens) return [];
  return tokens.split(',').map(t => t.trim()).filter(t => t);
}

function validateToken(authHeader, env) {
  const tokens = getApiTokens(env);
  if (tokens.length === 0) return true;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  return tokens.includes(token);
}

// ============================================
// Response Helpers
// ============================================

function createResponse(body, status = 200, headers = {}) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function createStreamResponse(body) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
    body,
  };
}

function previewBody(rawText, maxLen = 240) {
  const text = normalizeInputString(rawText || '');
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

async function safeReadJson(response) {
  const status = response?.status;
  const rawText = await response.text().catch(() => '');
  if (!rawText) {
    return { ok: false, status, data: null, rawText: '', parseError: new Error('Empty response body') };
  }
  try {
    return { ok: true, status, data: JSON.parse(rawText), rawText, parseError: null };
  } catch (parseError) {
    return { ok: false, status, data: null, rawText, parseError };
  }
}

function logChatDetail(runtime, event, detail = {}) {
  const rawFlag = (typeof process !== 'undefined' && process?.env?.CHAT_DETAIL_LOG) || '';
  const enabled = ['1', 'true', 'yes', 'on'].includes(String(rawFlag).toLowerCase());
  if (!enabled) return;
  const prefix = `[qwen2api][${runtime}][chat]`;
  try {
    console.log(`${prefix} ${event}`, JSON.stringify(detail));
  } catch {
    console.log(`${prefix} ${event}`);
  }
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeMimeType(mimeType) {
  return (mimeType || 'application/octet-stream').toLowerCase();
}

function inferFileCategory(mimeType, explicitType) {
  if (explicitType === 'image' || explicitType === 'audio' || explicitType === 'video' || explicitType === 'document') {
    return explicitType;
  }
  const mime = normalizeMimeType(mimeType);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

function fileExtensionFromMime(mimeType) {
  const mime = normalizeMimeType(mimeType);
  const mapping = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'application/json': 'json',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/avi': 'avi',
  };
  return mapping[mime] || 'bin';
}

function decodeBase64ToBytes(base64) {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const matched = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/i);
  if (!matched) return null;
  return {
    mimeType: normalizeMimeType(matched[1] || 'application/octet-stream'),
    bytes: decodeBase64ToBytes(matched[2]),
  };
}

function inferFilename(rawFilename, mimeType) {
  const name = normalizeInputString(rawFilename);
  if (name) {
    return name;
  }
  return `attachment-${uuidv4()}.${fileExtensionFromMime(mimeType)}`;
}

function normalizeInputString(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower === '[undefined]' || lower === 'undefined' || lower === '[null]' || lower === 'null') {
    return '';
  }
  return trimmed;
}

function normalizeReasoningFragments(value) {
  if (typeof value === 'string') {
    const text = normalizeReasoningString(value);
    return text ? [text] : [];
  }
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const text = normalizeReasoningString(item);
      if (text) out.push(text);
    } else if (item && typeof item === 'object') {
      const text = normalizeReasoningString(item.text || item.content || item.value);
      if (text) out.push(text);
    }
  }
  return out;
}

function normalizeReasoningString(value) {
  if (typeof value !== 'string') return '';
  const lowered = value.trim().toLowerCase();
  if (lowered === '[undefined]' || lowered === 'undefined' || lowered === '[null]' || lowered === 'null') {
    return '';
  }
  return value;
}

function extractReasoningContentFromDelta(delta) {
  if (!delta || typeof delta !== 'object') return '';
  const direct = normalizeReasoningString(delta.reasoning_content || delta.reasoning || '');
  if (direct) return direct;
  const phase = typeof delta.phase === 'string' ? delta.phase : '';
  if (phase !== 'thinking_summary' && phase !== 'think') return '';
  if (phase === 'think' && typeof delta.content === 'string') {
    return normalizeReasoningString(delta.content);
  }
  const thoughtContent = normalizeReasoningFragments(delta?.extra?.summary_thought?.content);
  if (thoughtContent.length > 0) return thoughtContent.join('\n');
  return '';
}

function mapUpstreamDeltaToOpenAI(delta) {
  if (!delta || typeof delta !== 'object') return null;
  const mapped = {};
  // OpenAI API specification: in streaming responses delta.role should only be "assistant" or omitted.
  // When upstream returns roles like "function", do not set the role field.
  if (delta.role === 'assistant') mapped.role = delta.role;
  const phase = typeof delta.phase === 'string' ? delta.phase : '';
  const reasoningContent = extractReasoningContentFromDelta(delta);
  if (reasoningContent) mapped.reasoning_content = reasoningContent;
  if (phase !== 'think' && phase !== 'thinking_summary' && typeof delta.content === 'string') {
    mapped.content = delta.content;
  }
  return Object.keys(mapped).length > 0 ? mapped : null;
}

function parseQwenSsePayload(rawPayload) {
  const payload = typeof rawPayload === 'string' ? rawPayload : '';
  const events = [];
  const contentParts = [];
  const reasoningParts = [];
  let usage = null;

  for (const line of payload.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed?.usage && typeof parsed.usage === 'object') {
        usage = parsed.usage;
      }
      const upstreamDelta = parsed?.choices?.[0]?.delta;
      const delta = mapUpstreamDeltaToOpenAI(upstreamDelta);
      const finishReason = parsed?.choices?.[0]?.finish_reason || null;
      if (delta || finishReason) {
        events.push({ delta: delta || {}, finish_reason: finishReason });
      }
      if (delta?.content) contentParts.push(delta.content);
      if (delta?.reasoning_content) reasoningParts.push(delta.reasoning_content);
    } catch (parseError) {
      void parseError;
    }
  }

  return {
    events,
    content: contentParts.join(''),
    reasoning_content: reasoningParts.join(''),
    usage,
  };
}

function mapUsageToOpenAI(usage) {
  const inputTokens = Number(usage?.input_tokens || 0);
  const outputTokens = Number(usage?.output_tokens || 0);
  const totalTokens = Number(usage?.total_tokens || (inputTokens + outputTokens));
  const mapped = {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: totalTokens,
  };
  const inputDetails = usage?.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? { ...usage.input_tokens_details }
    : null;
  const outputDetails = usage?.output_tokens_details && typeof usage.output_tokens_details === 'object'
    ? { ...usage.output_tokens_details }
    : null;
  if (inputDetails && Object.keys(inputDetails).length > 0) {
    mapped.prompt_tokens_details = inputDetails;
  }
  if (outputDetails && Object.keys(outputDetails).length > 0) {
    mapped.completion_tokens_details = outputDetails;
  }
  return mapped;
}

function tryParseOpenAiImageSize(size) {
  const text = normalizeInputString(size);
  if (!text) return null;
  const m = text.toLowerCase().match(/^(\d{2,5})\s*x\s*(\d{2,5})$/);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function tryParseRatioString(size) {
  const text = normalizeInputString(size);
  if (!text) return null;
  const m = text.toLowerCase().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return `${w}:${h}`;
}

function mapOpenAiImageSizeToQwenRatio(size) {
  // Qwen Web t2i uses ratio strings such as "16:9".
  // Supports two formats:
  // 1. Direct ratio string: "1:1", "16:9", "9:16", "4:3", "3:4"
  // 2. OpenAI size format: "1024x1024" (mapped to the closest supported ratio)
  
  // First try parsing a direct ratio string
  const ratio = tryParseRatioString(size);
  if (ratio) {
    // Validate against supported ratios
    const validRatios = ['1:1', '16:9', '9:16', '4:3', '3:4'];
    if (validRatios.includes(ratio)) {
      return ratio;
    }
  }
  
  // Otherwise parse OpenAI size format and map to the nearest ratio
  const parsed = tryParseOpenAiImageSize(size);
  if (!parsed) return '1:1';
  const { width, height } = parsed;
  const r = width / height;

  // Supported target ratios
  const candidates = [
    { key: '1:1', r: 1 },
    { key: '16:9', r: 16 / 9 },
    { key: '9:16', r: 9 / 16 },
    { key: '4:3', r: 4 / 3 },
    { key: '3:4', r: 3 / 4 },
  ];

  let best = candidates[0];
  let bestDiff = Infinity;
  for (const c of candidates) {
    const diff = Math.abs(r - c.r);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return best.key;
}

function extractImageUrlsFromUpstreamSse(rawPayload) {
  const payload = typeof rawPayload === 'string' ? rawPayload : '';
  const urls = [];

  for (const line of payload.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed?.choices?.[0]?.delta;
      if (!delta || typeof delta !== 'object') continue;
      const phase = typeof delta.phase === 'string' ? delta.phase : '';
      if (phase !== 'image_gen') continue;
      const content = delta.content;
      if (typeof content !== 'string') continue;
      const url = content.trim();
      if (!url) continue;
      if (!/^https?:\/\//i.test(url)) continue;
      urls.push(url);
    } catch {
      // ignore
    }
  }

  // Deduplicate while preserving order
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function extractUpstreamErrorFromSse(rawPayload) {
  const payload = typeof rawPayload === 'string' ? rawPayload : '';
  for (const line of payload.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      const err = parsed?.error;
      if (err && err.code === 'data_inspection_failed') {
        return { message: err.details || err.message || 'Content safety warning', code: err.code };
      }
    } catch {}
  }
  return null;
}

// Upstream risk-control returns HTTP 200 with an Aliyun punish payload like:
// {"rgv587_flag":"sm","url":"https://bixi.alicdn.com/punish/...?...&action=deny&pureDenyWait="}
// Surface the upstream content as a readable error instead of a silent "HTTP 200".
function tryParseRiskControlPayload(rawText) {
  const text = typeof rawText === 'string' ? rawText : '';
  const firstChar = text.trimStart().charAt(0);
  if (firstChar !== '{' && firstChar !== '[') return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const punishUrl = typeof parsed.url === 'string' && /punish|action=deny|pureDenyWait/i.test(parsed.url) ? parsed.url : '';
  const hasRiskFlag = typeof parsed.rgv587_flag === 'string' || typeof parsed['rgv-flag'] === 'string';
  if (!hasRiskFlag && !punishUrl) return null;

  let message = '';
  if (typeof parsed.details === 'string' && parsed.details) message = parsed.details;
  else if (typeof parsed.message === 'string' && parsed.message) message = parsed.message;
  else if (typeof parsed.error === 'string' && parsed.error) message = parsed.error;
  else if (punishUrl) message = punishUrl;
  if (!message) message = text;
  return { message, code: parsed.rgv587_flag || 'rgv587', type: 'api_error', riskControlled: true };
}

function tryParseUpstreamErrorPayload(rawText) {
  const risk = tryParseRiskControlPayload(rawText);
  if (risk) return risk;
  const text = typeof rawText === 'string' ? rawText : '';
  const firstChar = text.trimStart().charAt(0);
  if (firstChar !== '{' && firstChar !== '[') return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  if (Array.isArray(parsed.ret)) {
    const parts = parsed.ret.filter(p => typeof p === 'string' && p);
    if (parts.length > 0) {
      const code = parts[0];
      const message = parts.slice(1).filter(Boolean).join(' | ') || code;
      return { message, code, type: 'api_error' };
    }
  }

  if (parsed.success === false) {
    const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {};
    const message = data.details || data.message || data.msg || data.code || 'Upstream request failed';
    return { message, code: data.code, type: 'api_error' };
  }

  if (parsed.error && typeof parsed.error === 'object') {
    return {
      message: parsed.error.message || 'Upstream request failed',
      code: parsed.error.code,
      type: parsed.error.type || 'api_error',
    };
  }

  return null;
}

async function fetchImageAsBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch image: HTTP ${resp.status}`);
  }
  const arrayBuffer = await resp.arrayBuffer();
  return bytesToBase64(new Uint8Array(arrayBuffer));
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes || new Uint8Array());
  } catch {
    return '';
  }
}

function extractInlineTextFromAttachment(source, mimeType, filename) {
  const mime = normalizeMimeType(mimeType);
  const isTextLike = mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || mime === 'text/markdown';
  if (!isTextLike) return '';
  const parsed = parseDataUrl(source);
  if (!parsed) return '';
  const text = normalizeInputString(decodeUtf8(parsed.bytes));
  if (!text) return '';
  const label = normalizeInputString(filename) || 'unnamed.txt';
  const capped = text.length > 12000 ? `${text.slice(0, 12000)}\n...[truncated]` : text;
  return `[Attachment Text ${label}]\n${capped}`;
}

function pushTextPart(parts, value) {
  const text = normalizeInputString(value);
  if (text) {
    parts.push(text);
  }
}

function normalizeContentParts(content) {
  if (typeof content === 'string') {
    const text = normalizeInputString(content);
    return {
      text,
      attachments: [],
    };
  }

  if (!Array.isArray(content)) {
    return {
      text: '',
      attachments: [],
    };
  }

  const textParts = [];
  const attachments = [];

  for (const part of content) {
    if (!part) continue;
    if (typeof part === 'string') {
      pushTextPart(textParts, part);
      continue;
    }

    const type = part.type || '';
    if (type === 'text' || type === 'input_text') {
      pushTextPart(textParts, part.text || part.input_text);
      continue;
    }

    if (type === 'image_url' || type === 'input_image') {
      const imageUrl = normalizeInputString(
        part.image_url?.url ||
        part.image_url ||
        part.url ||
        part.file_url ||
        part.file_data
      );
      if (imageUrl) {
        attachments.push({
          source: imageUrl,
          filename: normalizeInputString(part.filename) || normalizeInputString(part.name),
          mimeType: normalizeInputString(part.mime_type) || normalizeInputString(part.content_type),
          explicitType: 'image',
        });
      }
      continue;
    }

    if (type === 'file' || type === 'input_file' || type === 'audio' || type === 'input_audio' || type === 'video' || type === 'input_video') {
      const fileSource = normalizeInputString(part.file_data || part.url || part.file_url || part.data);
      if (fileSource) {
        const normalizedFilename = normalizeInputString(part.filename) || normalizeInputString(part.name);
        const normalizedMimeType = normalizeInputString(part.mime_type) || normalizeInputString(part.content_type);
        const explicitType = type.includes('audio') ? 'audio' : (type.includes('video') ? 'video' : undefined);
        attachments.push({
          source: fileSource,
          filename: normalizedFilename,
          mimeType: normalizedMimeType,
          explicitType,
        });
      }
      continue;
    }

    if (typeof part.text === 'string') {
      pushTextPart(textParts, part.text);
    }
  }

  return {
    text: textParts.join('\n'),
    attachments,
  };
}

function normalizeLegacyFiles(message) {
  const attachments = [];
  const candidates = [...toArray(message?.attachments), ...toArray(message?.files)];
  for (const item of candidates) {
    if (!item) continue;
    const source = normalizeInputString(item.data || item.file_data || item.url || item.file_url);
    if (!source) continue;
    attachments.push({
      source,
      filename: normalizeInputString(item.filename) || normalizeInputString(item.name),
      mimeType: normalizeInputString(item.mime_type) || normalizeInputString(item.content_type) || normalizeInputString(item.type),
      explicitType: item.type,
    });
  }
  return attachments;
}

// ============================================
// Reliable OpenAI-Compatible Tool Calling Engine
// ============================================

function normalizeToolsConfig(body) {
  const rawTools = Array.isArray(body?.tools) ? body.tools : [];
  const rawFunctions = Array.isArray(body?.functions) ? body.functions : [];
  const useLegacyFunctions = rawTools.length === 0 && rawFunctions.length > 0;

  const tools = [];
  const toolMap = new Map();

  for (const item of rawTools) {
    if (!item || typeof item !== 'object') continue;
    const fn = item.type === 'function' && item.function && typeof item.function === 'object'
      ? item.function
      : (item.name ? item : null);
    if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) continue;
    const name = fn.name.trim();
    const normalizedFn = {
      name,
      description: typeof fn.description === 'string' ? fn.description.trim() : '',
      parameters: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
      strict: !!fn.strict,
    };
    if (!toolMap.has(name)) {
      toolMap.set(name, normalizedFn);
      tools.push({ type: 'function', function: normalizedFn });
    }
  }

  for (const fn of rawFunctions) {
    if (!fn || typeof fn !== 'object' || typeof fn.name !== 'string' || !fn.name.trim()) continue;
    const name = fn.name.trim();
    if (toolMap.has(name)) continue;
    const normalizedFn = {
      name,
      description: typeof fn.description === 'string' ? fn.description.trim() : '',
      parameters: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
      strict: !!fn.strict,
    };
    toolMap.set(name, normalizedFn);
    tools.push({ type: 'function', function: normalizedFn });
  }

  const rawChoice = body?.tool_choice !== undefined ? body.tool_choice : body?.function_call;
  let mode = 'auto';
  let forcedFunctionName = null;

  if (tools.length === 0) {
    mode = 'none';
  } else if (typeof rawChoice === 'string') {
    const lowered = rawChoice.trim().toLowerCase();
    if (lowered === 'none') {
      mode = 'none';
    } else if (lowered === 'required' || lowered === 'any') {
      mode = 'required';
    } else if (lowered === 'auto' || !lowered) {
      mode = 'auto';
    } else if (toolMap.has(rawChoice.trim())) {
      mode = 'function';
      forcedFunctionName = rawChoice.trim();
    }
  } else if (rawChoice && typeof rawChoice === 'object') {
    const candidateName = normalizeInputString(rawChoice?.function?.name || rawChoice?.name);
    if (candidateName) {
      mode = 'function';
      forcedFunctionName = candidateName;
    }
  }

  const parallelToolCalls = body?.parallel_tool_calls !== false;
  const hasActiveTools = tools.length > 0 && mode !== 'none';

  return {
    tools,
    toolMap,
    mode,
    forcedFunctionName,
    parallelToolCalls,
    useLegacyFunctions,
    hasActiveTools,
  };
}

function buildToolCallingInstructions(toolsConfig) {
  if (!toolsConfig || !toolsConfig.hasActiveTools) return '';

  const activeTools = toolsConfig.mode === 'function' && toolsConfig.forcedFunctionName
    ? toolsConfig.tools.filter(t => t.function.name === toolsConfig.forcedFunctionName)
    : toolsConfig.tools;
  const serializedTools = (activeTools.length > 0 ? activeTools : toolsConfig.tools)
    .map(t => JSON.stringify(t))
    .join('\n');

  const choiceRule = toolsConfig.mode === 'function' && toolsConfig.forcedFunctionName
    ? `CRITICAL REQUIREMENT: You MUST invoke the tool "${toolsConfig.forcedFunctionName}" in this turn. Do NOT respond with plain text; output ONLY the <tool_call> block for "${toolsConfig.forcedFunctionName}".`
    : toolsConfig.mode === 'required'
      ? 'CRITICAL REQUIREMENT: You MUST invoke at least one of the provided tools in this turn. Do NOT respond with plain text; output ONLY the <tool_call> block(s).'
      : 'When a user request can be answered or fulfilled by calling one of the provided tools, output the <tool_call> block(s) instead of guessing or fabricating tool results. If no tool is relevant or needed, answer normally.';

  const parallelRule = toolsConfig.parallelToolCalls
    ? 'If multiple tool calls are needed and independent, you may emit multiple <tool_call>...</tool_call> blocks in sequence.'
    : 'Emit at most ONE <tool_call>...</tool_call> block in this turn.';

  return [
    '# Tools',
    '',
    'You have access to the following function tools:',
    '<tools>',
    serializedTools,
    '</tools>',
    '',
    '## Tool Calling Protocol',
    'To call a function tool, respond with one (or more) XML blocks in this EXACT format:',
    '<tool_call>',
    '{"name": "<function_name>", "arguments": <valid_json_object>}',
    '</tool_call>',
    '',
    'Strict Rules for Tool Calling:',
    '1. Inside <tool_call>...</tool_call>, output ONLY a single valid JSON object with keys "name" (string) and "arguments" (JSON object matching the parameter schema).',
    '2. Do NOT wrap <tool_call> in markdown code fences (no ```xml or ```json).',
    '3. Ensure all required parameters defined in the tool schema are provided with their exact types (numbers as numbers, booleans as booleans, arrays as arrays).',
    '4. When you emit a <tool_call>, do NOT fabricate <tool_response> — stop immediately after the closing </tool_call> tag and wait for the user/system to supply the tool execution result.',
    `5. ${parallelRule}`,
    `6. ${choiceRule}`,
  ].join('\n');
}

function formatMessageForHistory(message) {
  const role = (message?.role || 'user').toLowerCase();
  const parsed = normalizeContentParts(message?.content);
  const attachments = [...parsed.attachments, ...normalizeLegacyFiles(message)];

  if (role === 'tool' || role === 'function') {
    const toolCallId = normalizeInputString(message?.tool_call_id || message?.id) || 'call_result';
    const toolName = normalizeInputString(message?.name) || 'tool';
    const rawContent = typeof message?.content === 'string'
      ? message.content
      : (parsed.text || JSON.stringify(message?.content ?? ''));
    return {
      role: 'tool',
      text: `<tool_response id="${toolCallId}" name="${toolName}">\n${rawContent}\n</tool_response>`,
      attachments,
    };
  }

  if (role === 'assistant') {
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const legacyCall = message?.function_call && typeof message.function_call === 'object'
      ? [{ id: 'call_legacy', type: 'function', function: message.function_call }]
      : [];
    const allCalls = [...toolCalls, ...legacyCall];
    const serializedCalls = allCalls.map((tc) => {
      const fnName = tc?.function?.name || tc?.name || '';
      if (!fnName) return '';
      let argsObj = {};
      const rawArgs = tc?.function?.arguments ?? tc?.arguments;
      if (typeof rawArgs === 'string') {
        try {
          argsObj = JSON.parse(rawArgs);
        } catch {
          argsObj = { _raw: rawArgs };
        }
      } else if (rawArgs && typeof rawArgs === 'object') {
        argsObj = rawArgs;
      }
      const callPayload = {
        ...(tc?.id ? { id: tc.id } : {}),
        name: fnName,
        arguments: argsObj,
      };
      return `<tool_call>\n${JSON.stringify(callPayload)}\n</tool_call>`;
    }).filter(Boolean).join('\n');

    const combinedText = [parsed.text, serializedCalls].filter(Boolean).join('\n');
    return {
      role: 'assistant',
      text: combinedText,
      attachments,
    };
  }

  return {
    role,
    text: parsed.text,
    attachments,
  };
}

function parseIncomingMessages(messages, toolsConfig = null) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const normalized = safeMessages.map(formatMessageForHistory);

  const allAttachments = [];
  for (const m of normalized) {
    if (Array.isArray(m.attachments) && m.attachments.length > 0) {
      allAttachments.push(...m.attachments);
    }
  }

  const toolSystemBlock = toolsConfig && toolsConfig.hasActiveTools
    ? buildToolCallingInstructions(toolsConfig)
    : '';

  if (normalized.length === 0) {
    return { content: toolSystemBlock, attachments: [] };
  }

  const last = normalized[normalized.length - 1];
  const historyParts = [];
  if (toolSystemBlock) {
    historyParts.push(`[System]:\n${toolSystemBlock}`);
  }

  for (let i = 0; i < normalized.length - 1; i++) {
    const m = normalized[i];
    if (!m.text) continue;
    const roleLabel = m.role === 'assistant'
      ? 'Assistant'
      : m.role === 'system' || m.role === 'developer'
        ? 'System'
        : m.role === 'tool'
          ? 'Tool'
          : 'User';
    historyParts.push(`[${roleLabel}]: ${m.text}`);
  }

  const history = historyParts.join('\n\n');
  const lastRoleLabel = last.role === 'tool'
    ? 'Tool'
    : last.role === 'system' || last.role === 'developer'
      ? 'System'
      : last.role === 'assistant'
        ? 'Assistant'
        : 'User';
  const lastText = last.text || (allAttachments.length > 0 ? 'Please answer based on the attached files.' : '');

  let merged;
  if (history) {
    const suffixReminder = toolsConfig && toolsConfig.hasActiveTools && (toolsConfig.mode === 'required' || toolsConfig.mode === 'function')
      ? `\n\n[System Reminder]: Output ONLY the required <tool_call>...</tool_call> XML block${toolsConfig.forcedFunctionName ? ` for "${toolsConfig.forcedFunctionName}"` : ''}.`
      : '';
    merged = `${history}\n\n[${lastRoleLabel}]: ${lastText}${suffixReminder}`;
  } else {
    merged = lastText;
  }

  return {
    content: merged,
    attachments: allAttachments,
  };
}

function stripMarkdownFences(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json|xml|javascript|js|ts|tool_call)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  return text;
}

function extractBalancedJsonObjects(text) {
  const results = [];
  if (typeof text !== 'string' || !text) return results;
  let depth = 0;
  let start = -1;
  let inString = false;
  let quoteChar = '"';
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (inString) {
      if (ch === quoteChar) {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      quoteChar = ch;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          results.push({
            raw: text.slice(start, i + 1),
            start,
            end: i + 1,
          });
          start = -1;
        }
      }
    }
  }
  return results;
}

function repairJsonString(raw) {
  if (typeof raw !== 'string') return null;
  let candidate = stripMarkdownFences(raw)
    .replace(/^\s*<tool_call>\s*/i, '')
    .replace(/\s*<\/tool_call>\s*$/i, '')
    .trim();

  if (!candidate) return null;

  try {
    return JSON.parse(candidate);
  } catch {}

  // Attempt common syntax repairs: trailing commas, Python literals, smart quotes
  let repaired = candidate
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/:\s*True\b/g, ': true')
    .replace(/:\s*False\b/g, ': false')
    .replace(/:\s*None\b/g, ': null');

  try {
    return JSON.parse(repaired);
  } catch {}

  // Balance missing closing braces/brackets if truncated
  const openBraces = (repaired.match(/\{/g) || []).length;
  const closeBraces = (repaired.match(/\}/g) || []).length;
  if (openBraces > closeBraces && openBraces - closeBraces <= 4) {
    const padded = repaired + '}'.repeat(openBraces - closeBraces);
    try {
      return JSON.parse(padded);
    } catch {}
  }

  // Extract first balanced JSON object inside the string
  const balanced = extractBalancedJsonObjects(repaired);
  for (const item of balanced) {
    try {
      return JSON.parse(item.raw);
    } catch {}
  }

  return null;
}

function resolveCanonicalToolName(rawName, toolsConfig) {
  const name = normalizeInputString(rawName);
  if (!name) return null;
  if (!toolsConfig || !toolsConfig.toolMap || toolsConfig.toolMap.size === 0) {
    return name;
  }
  if (toolsConfig.toolMap.has(name)) {
    return name;
  }
  // Strip common namespaces such as "functions.get_weather" or "tools:get_weather"
  const stripped = name.replace(/^(?:functions?|tools?|call)[.:/]/i, '');
  if (toolsConfig.toolMap.has(stripped)) {
    return stripped;
  }
  // Case-insensitive match
  const lower = stripped.toLowerCase();
  for (const key of toolsConfig.toolMap.keys()) {
    if (key.toLowerCase() === lower) {
      return key;
    }
  }
  return null;
}

function coerceValueBySchema(value, propSchema) {
  if (!propSchema || typeof propSchema !== 'object' || value === undefined || value === null) {
    return value;
  }
  const targetType = Array.isArray(propSchema.type)
    ? propSchema.type.find(t => t !== 'null') || propSchema.type[0]
    : propSchema.type;

  if (targetType === 'number' || targetType === 'integer') {
    if (typeof value === 'string' && value.trim() !== '') {
      const num = Number(value.trim());
      if (Number.isFinite(num)) {
        return targetType === 'integer' ? Math.trunc(num) : num;
      }
    }
    return value;
  }

  if (targetType === 'boolean') {
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (lowered === 'true' || lowered === '1') return true;
      if (lowered === 'false' || lowered === '0') return false;
    }
    return value;
  }

  if (targetType === 'array') {
    if (typeof value === 'string') {
      const parsed = repairJsonString(value);
      if (Array.isArray(parsed)) return parsed;
    }
    return value;
  }

  if (targetType === 'object') {
    if (typeof value === 'string') {
      const parsed = repairJsonString(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return coerceToolArguments(parsed, propSchema);
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      return coerceToolArguments(value, propSchema);
    }
    return value;
  }

  if (targetType === 'string' && typeof value !== 'string') {
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
  }

  return value;
}

function coerceToolArguments(rawArgs, parametersSchema) {
  let argsObj = {};
  if (typeof rawArgs === 'string') {
    const parsed = repairJsonString(rawArgs);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      argsObj = { ...parsed };
    }
  } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    argsObj = { ...rawArgs };
  }

  const schema = parametersSchema && typeof parametersSchema === 'object' ? parametersSchema : null;
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : null;
  if (!properties) {
    return argsObj;
  }

  const propKeys = Object.keys(properties);
  const coerced = {};

  for (const [k, v] of Object.entries(argsObj)) {
    if (Object.prototype.hasOwnProperty.call(properties, k)) {
      coerced[k] = coerceValueBySchema(v, properties[k]);
    } else {
      // Case-insensitive property key match
      const matchedKey = propKeys.find(pk => pk.toLowerCase() === k.toLowerCase());
      if (matchedKey && argsObj[matchedKey] === undefined) {
        coerced[matchedKey] = coerceValueBySchema(v, properties[matchedKey]);
      } else {
        coerced[k] = v;
      }
    }
  }

  // Apply schema defaults for missing required fields when available
  const requiredList = Array.isArray(schema?.required) ? schema.required : [];
  for (const reqKey of requiredList) {
    if (coerced[reqKey] === undefined && properties[reqKey] && properties[reqKey].default !== undefined) {
      coerced[reqKey] = properties[reqKey].default;
    }
  }

  return coerced;
}

function normalizeParsedToolCandidate(candidate, toolsConfig) {
  if (!candidate || typeof candidate !== 'object') return [];

  if (Array.isArray(candidate)) {
    const out = [];
    for (const item of candidate) {
      out.push(...normalizeParsedToolCandidate(item, toolsConfig));
    }
    return out;
  }

  if (Array.isArray(candidate.tool_calls)) {
    return normalizeParsedToolCandidate(candidate.tool_calls, toolsConfig);
  }

  const fnObj = candidate.function && typeof candidate.function === 'object' ? candidate.function : candidate;
  let rawName = fnObj.name || fnObj.tool || fnObj.tool_name || fnObj.function_name || candidate.name;
  let rawArgs = fnObj.arguments !== undefined
    ? fnObj.arguments
    : fnObj.parameters !== undefined
      ? fnObj.parameters
      : fnObj.args !== undefined
        ? fnObj.args
        : fnObj.input !== undefined
          ? fnObj.input
          : undefined;

  // Handle case where model forced a single function and emitted only the arguments object directly
  if (!rawName && toolsConfig?.mode === 'function' && toolsConfig.forcedFunctionName) {
    const forcedSchema = toolsConfig.toolMap.get(toolsConfig.forcedFunctionName)?.parameters;
    const schemaProps = forcedSchema?.properties ? Object.keys(forcedSchema.properties) : [];
    const candidateKeys = Object.keys(candidate);
    if (schemaProps.length === 0 || candidateKeys.some(k => schemaProps.includes(k))) {
      rawName = toolsConfig.forcedFunctionName;
      rawArgs = candidate;
    }
  }

  const canonicalName = resolveCanonicalToolName(rawName, toolsConfig);
  if (!canonicalName) return [];

  if (rawArgs === undefined) {
    // If candidate has other keys besides name/type/id, treat remaining keys as arguments
    const rest = {};
    for (const [k, v] of Object.entries(fnObj)) {
      if (!['name', 'tool', 'tool_name', 'function_name', 'type', 'id'].includes(k)) {
        rest[k] = v;
      }
    }
    rawArgs = rest;
  }

  const toolDef = toolsConfig?.toolMap?.get(canonicalName);
  const coercedArgs = coerceToolArguments(rawArgs, toolDef?.parameters);
  const callId = typeof candidate.id === 'string' && candidate.id.startsWith('call_')
    ? candidate.id
    : `call_${uuidv4().replace(/-/g, '').slice(0, 24)}`;

  return [{
    id: callId,
    type: 'function',
    function: {
      name: canonicalName,
      arguments: JSON.stringify(coercedArgs),
    },
  }];
}

function extractToolCallsFromText(rawText, toolsConfig) {
  const text = typeof rawText === 'string' ? rawText : '';
  if (!text || (toolsConfig && !toolsConfig.hasActiveTools)) {
    return {
      toolCalls: [],
      cleanedContent: text,
      hadMalformedToolAttempt: false,
    };
  }

  const extractedCalls = [];
  const spansToRemove = [];
  let hadMalformedToolAttempt = false;

  // 1. Match explicit <tool_call>...</tool_call> or <function_call>...</function_call> blocks
  const xmlRegex = /<(?:tool_call|function_call|tool_use)>\s*([\s\S]*?)\s*<\/(?:tool_call|function_call|tool_use)>/gi;
  let match;
  while ((match = xmlRegex.exec(text)) !== null) {
    spansToRemove.push([match.index, match.index + match[0].length]);
    const inner = match[1].trim();
    const parsed = repairJsonString(inner);
    if (parsed) {
      const normalized = normalizeParsedToolCandidate(parsed, toolsConfig);
      if (normalized.length > 0) {
        extractedCalls.push(...normalized);
      } else {
        hadMalformedToolAttempt = true;
      }
    } else {
      hadMalformedToolAttempt = true;
    }
  }

  // 2. Check for an unclosed trailing <tool_call> block (e.g., if model omitted closing tag)
  if (extractedCalls.length === 0) {
    const unclosedMatch = text.match(/<(?:tool_call|function_call|tool_use)>\s*([\s\S]+)$/i);
    if (unclosedMatch && typeof unclosedMatch.index === 'number') {
      const parsed = repairJsonString(unclosedMatch[1]);
      if (parsed) {
        const normalized = normalizeParsedToolCandidate(parsed, toolsConfig);
        if (normalized.length > 0) {
          extractedCalls.push(...normalized);
          spansToRemove.push([unclosedMatch.index, text.length]);
        } else {
          hadMalformedToolAttempt = true;
        }
      } else {
        hadMalformedToolAttempt = true;
      }
    }
  }

  // 3. Match Qwen / DeepSeek style <function=name>{...}</function>
  if (extractedCalls.length === 0) {
    const fnEqRegex = /<function=([a-zA-Z0-9_.-]+)>\s*([\s\S]*?)\s*<\/function>/gi;
    while ((match = fnEqRegex.exec(text)) !== null) {
      const fnName = match[1];
      const argsParsed = repairJsonString(match[2]) || {};
      const normalized = normalizeParsedToolCandidate({ name: fnName, arguments: argsParsed }, toolsConfig);
      if (normalized.length > 0) {
        extractedCalls.push(...normalized);
        spansToRemove.push([match.index, match.index + match[0].length]);
      }
    }
  }

  // 4. Fallback: Fenced JSON blocks or standalone JSON objects matching a declared tool
  if (extractedCalls.length === 0) {
    const objects = extractBalancedJsonObjects(text);
    for (const objInfo of objects) {
      const parsed = repairJsonString(objInfo.raw);
      if (!parsed || typeof parsed !== 'object') continue;
      const normalized = normalizeParsedToolCandidate(parsed, toolsConfig);
      if (normalized.length > 0) {
        extractedCalls.push(...normalized);
        spansToRemove.push([objInfo.start, objInfo.end]);
      }
    }
  }

  const finalCalls = toolsConfig && !toolsConfig.parallelToolCalls && extractedCalls.length > 1
    ? [extractedCalls[0]]
    : extractedCalls;

  let cleanedContent = text;
  if (spansToRemove.length > 0 && finalCalls.length > 0) {
    const sorted = spansToRemove.slice().sort((a, b) => b[0] - a[0]);
    for (const [start, end] of sorted) {
      cleanedContent = cleanedContent.slice(0, start) + cleanedContent.slice(end);
    }
    // Strip leftover empty markdown fences around removed tool calls
    cleanedContent = cleanedContent.replace(/```(?:json|xml|tool_call)?\s*```/gi, '').trim();
  }

  return {
    toolCalls: finalCalls,
    cleanedContent: cleanedContent.trim(),
    hadMalformedToolAttempt,
  };
}

function buildStreamingToolCallEvents(toolCalls, useLegacyFunctions = false) {
  const events = [];
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return events;

  if (useLegacyFunctions) {
    const first = toolCalls[0];
    events.push({
      delta: {
        role: 'assistant',
        content: null,
        function_call: {
          name: first.function.name,
          arguments: first.function.arguments,
        },
      },
      finish_reason: null,
    });
    events.push({
      delta: {},
      finish_reason: 'function_call',
    });
    return events;
  }

  events.push({
    delta: {
      role: 'assistant',
      content: null,
      tool_calls: toolCalls.map((tc, index) => ({
        index,
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    },
    finish_reason: null,
  });
  events.push({
    delta: {},
    finish_reason: 'tool_calls',
  });
  return events;
}

async function getAttachmentBytes(attachment) {
  const dataParsed = parseDataUrl(attachment.source);
  if (dataParsed) {
    return {
      bytes: dataParsed.bytes,
      mimeType: attachment.mimeType || dataParsed.mimeType,
      filename: inferFilename(attachment.filename, attachment.mimeType || dataParsed.mimeType),
    };
  }

  if (/^https?:\/\//i.test(attachment.source)) {
    const resp = await fetch(attachment.source);
    if (!resp.ok) {
      throw new Error(`Failed to fetch attachment URL: ${resp.status}`);
    }
    const mimeType = attachment.mimeType || resp.headers.get('content-type') || 'application/octet-stream';
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return {
      bytes,
      mimeType,
      filename: inferFilename(attachment.filename, mimeType),
    };
  }

  const maybeBase64 = attachment.source.replace(/\s+/g, '');
  const bytes = decodeBase64ToBytes(maybeBase64);
  const mimeType = attachment.mimeType || 'application/octet-stream';
  return {
    bytes,
    mimeType,
    filename: inferFilename(attachment.filename, mimeType),
  };
}

async function requestUploadToken(file, baxiaTokens) {
  const filetype = inferFileCategory(file.mimeType, file.explicitType);
  const resp = await fetch(`${QWEN_BASE_URL}/api/v2/files/getstsToken`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'bx-ua': baxiaTokens.bxUa,
      'bx-umidtoken': baxiaTokens.bxUmidToken,
      'bx-v': baxiaTokens.bxV,
      'source': 'web',
      'timezone': new Date().toUTCString(),
      'Referer': QWEN_WEB_REFERER,
      'x-request-id': uuidv4(),
    },
    body: JSON.stringify({
      filename: file.filename,
      filesize: file.bytes.length,
      filetype,
    }),
  });

  const data = await resp.json();
  if (!resp.ok || !data?.success || !data?.data?.file_url) {
    throw new Error(`Failed to get upload token: ${resp.status}`);
  }

  return {
    tokenData: data.data,
    filetype,
  };
}

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function formatOssDate(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function formatOssDateScope(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function getWebCrypto() {
  if (globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto;
  }
  const nodeCrypto = nodeRequire('crypto');
  if (nodeCrypto && nodeCrypto.webcrypto && nodeCrypto.webcrypto.subtle) {
    return nodeCrypto.webcrypto;
  }
  throw new Error('WebCrypto is not available');
}

async function sha256Hex(input) {
  const cryptoApi = getWebCrypto();
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const hash = await cryptoApi.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(hash));
}

async function hmacSha256(keyBytes, content) {
  const cryptoApi = getWebCrypto();
  const cryptoKey = await cryptoApi.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const message = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const signature = await cryptoApi.subtle.sign('HMAC', cryptoKey, message);
  return new Uint8Array(signature);
}

async function buildOssSignedHeaders(uploadUrl, tokenData, file) {
  const parsedUrl = new URL(uploadUrl);
  const query = parsedUrl.searchParams;
  const credentialFromQuery = decodeURIComponent(query.get('x-oss-credential') || '');
  const credentialParts = credentialFromQuery.split('/');

  const dateScope = credentialParts[1] || formatOssDateScope();
  const region = credentialParts[2] || 'ap-southeast-1';
  const xOssDate = query.get('x-oss-date') || formatOssDate();

  const hostParts = parsedUrl.hostname.split('.');
  const bucket = hostParts.length > 0 ? hostParts[0] : '';
  const objectPath = parsedUrl.pathname || '/';
  const canonicalUri = bucket ? `/${bucket}${objectPath}` : objectPath;
  const xOssUserAgent = 'aliyun-sdk-js/6.23.0';
  const canonicalHeaders = [
    `content-type:${file.mimeType}`,
    'x-oss-content-sha256:UNSIGNED-PAYLOAD',
    `x-oss-date:${xOssDate}`,
    `x-oss-security-token:${tokenData.security_token}`,
    `x-oss-user-agent:${xOssUserAgent}`,
  ].join('\n') + '\n';
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders,
    '',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const credentialScope = `${dateScope}/${region}/oss/aliyun_v4_request`;
  const stringToSign = [
    'OSS4-HMAC-SHA256',
    xOssDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmacSha256(new TextEncoder().encode(`aliyun_v4${tokenData.access_key_secret}`), dateScope);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, 'oss');
  const kSigning = await hmacSha256(kService, 'aliyun_v4_request');
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  return {
    'Accept': '*/*',
    'Content-Type': file.mimeType,
    'authorization': `OSS4-HMAC-SHA256 Credential=${tokenData.access_key_id}/${credentialScope},Signature=${signature}`,
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-oss-date': xOssDate,
    'x-oss-security-token': tokenData.security_token,
    'x-oss-user-agent': xOssUserAgent,
    'Referer': QWEN_WEB_REFERER,
  };
}

async function uploadFileToQwenOss(file, tokenData) {
  const uploadUrl = typeof tokenData.file_url === 'string' ? tokenData.file_url.split('?')[0] : '';
  if (!uploadUrl) {
    throw new Error('Upload failed: missing upload URL');
  }
  const signedHeaders = await buildOssSignedHeaders(tokenData.file_url, tokenData, file);
  const resp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: signedHeaders,
    body: file.bytes,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Upload failed with status ${resp.status}${detail ? `: ${detail}` : ''}`);
  }
}

async function parseDocumentIfNeeded(qwenFilePayload, filetype, file, baxiaTokens) {
  if (filetype !== 'document') return;
  const resp = await fetch(`${QWEN_BASE_URL}/api/v2/files/parse`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'bx-ua': baxiaTokens.bxUa,
      'bx-umidtoken': baxiaTokens.bxUmidToken,
      'bx-v': baxiaTokens.bxV,
      'source': 'web',
      'timezone': new Date().toUTCString(),
      'Referer': QWEN_WEB_REFERER,
      'x-request-id': uuidv4(),
    },
    body: JSON.stringify({ file_id: qwenFilePayload.id }),
  });
  const detail = await resp.text().catch(() => '');
  if (!resp.ok) {
    logChatDetail('core', 'attachments.parse.document.skip', {
      fileId: qwenFilePayload.id,
      filename: file.filename,
      status: resp.status,
      detail,
    });
    throw new Error(`Document parse failed with status ${resp.status}${detail ? `: ${detail}` : ''}`);
  }
  let payload = {};
  try {
    payload = detail ? JSON.parse(detail) : {};
  } catch {}
  if (payload && payload.success === false) {
    logChatDetail('core', 'attachments.parse.document.skip', {
      fileId: qwenFilePayload.id,
      filename: file.filename,
      status: resp.status,
      detail,
    });
    throw new Error(`Document parse rejected${payload?.msg ? `: ${payload.msg}` : ''}`);
  }
  logChatDetail('core', 'attachments.parse.document.done', {
    fileId: qwenFilePayload.id,
    filename: file.filename,
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureUploadStatusForNonVideo(filetype, baxiaTokens) {
  if (filetype === 'video') return;
  const maxAttempts = 6;
  let lastPayload = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(`${QWEN_BASE_URL}/api/v2/users/status`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'bx-v': baxiaTokens.bxV,
        'source': 'web',
        'timezone': new Date().toUTCString(),
        'Referer': QWEN_WEB_REFERER,
        'x-request-id': uuidv4(),
      },
      body: JSON.stringify({
        typarms: {
          typarm1: 'web',
          typarm2: '',
          typarm3: 'prod',
          typarm4: 'qwen_chat',
          typarm5: 'product',
          orgid: 'tongyi',
        }
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Upload status check failed with status ${resp.status}${detail ? `: ${detail}` : ''}`);
    }
    const payload = await resp.json().catch(() => ({}));
    lastPayload = payload;
    if (payload?.data === true) {
      return;
    }
    if (attempt < maxAttempts) {
      await sleep(400);
    }
  }
  throw new Error(`Upload status not ready for non-video file${lastPayload ? `: ${JSON.stringify(lastPayload)}` : ''}`);
}

function extractUploadedFileId(fileUrl) {
  try {
    const pathname = decodeURIComponent(new URL(fileUrl).pathname);
    const filename = pathname.split('/').pop() || '';
    if (filename.includes('_')) {
      return filename.split('_')[0];
    }
  } catch {}
  return uuidv4();
}

function buildQwenFilePayload(file, tokenData, filetype) {
  const now = Date.now();
  const id = normalizeInputString(tokenData?.file_id) || extractUploadedFileId(tokenData.file_url);
  const isDocument = filetype === 'document';
  const showType = isDocument ? 'file' : filetype;
  const fileClass = isDocument ? 'document' : (filetype === 'image' ? 'vision' : filetype);
  const fileSize = file.bytes.length;
  const fileMimeType = file.mimeType;
  const uploadTaskId = uuidv4();
  return {
    type: showType,
    file: {
      created_at: now,
      data: {},
      filename: file.filename,
      hash: null,
      id,
      meta: {
        name: file.filename,
        size: fileSize,
        content_type: fileMimeType,
      },
      update_at: now,
    },
    id,
    url: tokenData.file_url,
    name: file.filename,
    collection_name: '',
    progress: 0,
    status: 'uploaded',
    is_uploading: false,
    error: '',
    showType,
    file_class: fileClass,
    itemId: uuidv4(),
    greenNet: 'success',
    size: fileSize,
    file_type: fileMimeType,
    uploadTaskId,
  };
}

async function uploadAttachments(attachments, baxiaTokens) {
  logChatDetail('core', 'attachments.upload.start', { count: attachments.length });
  const files = [];
  for (let i = 0; i < attachments.length; i++) {
    const rawAttachment = attachments[i];
    const loaded = await getAttachmentBytes(rawAttachment);
    loaded.explicitType = rawAttachment.explicitType;
    logChatDetail('core', 'attachments.upload.file.prepare', {
      index: i,
      filename: loaded.filename,
      mimeType: loaded.mimeType,
      size: loaded.bytes.length,
    });
    const { tokenData, filetype } = await requestUploadToken(loaded, baxiaTokens);
    await uploadFileToQwenOss(loaded, tokenData);
    const qwenFilePayload = buildQwenFilePayload(loaded, tokenData, filetype);
    await ensureUploadStatusForNonVideo(filetype, baxiaTokens);
    await parseDocumentIfNeeded(qwenFilePayload, filetype, loaded, baxiaTokens);
    if (filetype === 'document') {
      await ensureUploadStatusForNonVideo(filetype, baxiaTokens);
    }
    files.push(qwenFilePayload);
    logChatDetail('core', 'attachments.upload.file.done', {
      index: i,
      filetype,
      filename: loaded.filename,
    });
  }
  logChatDetail('core', 'attachments.upload.done', { uploaded: files.length });
  return files;
}

// ============================================
// API Handlers
// ============================================

// Upstream `/api/models` is behind a WAF and now returns an HTML block page
// instead of JSON. The web app ships the model list inside the homepage HTML
// as `window.__prerendered_data`, so we scrape that instead. The WAF also
// rejects short User-Agent strings, so a complete Chrome UA is required.
const MODELS_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const MODELS_SEC_CH_UA = '"Chromium";v="143", "Not(A:Brand";v="24", "Google Chrome";v="143"';
const MODELS_CACHE_TTL = 10 * 60 * 1000;
let modelsCache = null;
let modelsCacheTime = 0;

// Extracts the balanced JSON object that follows `window.__prerendered_data`.
function extractPrerenderedData(html) {
  const marker = html.indexOf('window.__prerendered_data');
  if (marker < 0) return null;
  const start = html.indexOf('{', marker);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchQwenModels() {
  const resp = await fetch(`${QWEN_BASE_URL}/`, {
    headers: {
      'User-Agent': MODELS_BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': WEB_ACCEPT_LANGUAGE,
      'Upgrade-Insecure-Requests': '1',
      'sec-ch-ua': MODELS_SEC_CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    },
  });
  if (!resp.ok) throw new Error(`models page returned HTTP ${resp.status}`);
  const html = await resp.text();
  const data = extractPrerenderedData(html);
  const models = Array.isArray(data?.models) ? data.models : null;
  if (!models || models.length === 0) throw new Error('no models found in page');
  const ids = [];
  for (const m of models) {
    const id = typeof m?.id === 'string' ? m.id : (typeof m?.info?.id === 'string' ? m.info.id : '');
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) throw new Error('no model ids found in page');
  return ids;
}

async function getQwenModels() {
  const now = Date.now();
  if (modelsCache && now - modelsCacheTime < MODELS_CACHE_TTL) {
    return modelsCache;
  }
  const ids = await fetchQwenModels();
  modelsCache = ids;
  modelsCacheTime = now;
  return ids;
}

async function handleModels(authHeader, env) {
  if (!validateToken(authHeader, env)) {
    return createResponse({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } }, 401);
  }
  try {
    const ids = await getQwenModels();
    const created = Math.floor(Date.now() / 1000);
    return createResponse({
      object: 'list',
      data: ids.map((id) => ({ id, object: 'model', created, owned_by: 'qwen' })),
    });
  } catch (err) {
    logChatDetail('core', 'models.fetch.failed', { message: err?.message || String(err) });
    return createResponse({ error: { message: 'Failed to fetch models', type: 'api_error' } }, 500);
  }
}

async function handleImageGenerations(body, authHeader, env) {
  // OpenAI Images API compatible: POST /v1/images/generations
  // Request fields: prompt (required), model (optional), n (optional), size (optional), response_format (optional)
  if (!validateToken(authHeader, env)) {
    return createResponse({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } }, 401);
  }

  const prompt = normalizeInputString(body?.prompt);
  if (!prompt) {
    return createResponse({ error: { message: 'prompt is required', type: 'invalid_request_error' } }, 400);
  }

  const actualModel = normalizeInputString(body?.model) || 'qwen3.8-max';
  const nRaw = body?.n;
  let n = Number.isFinite(nRaw) ? Number(nRaw) : Number.parseInt(String(nRaw || ''), 10);
  if (!Number.isFinite(n) || n <= 0) n = 1;
  if (n > 10) n = 10;

  const responseFormat = normalizeInputString(body?.response_format) || 'url';
  if (responseFormat !== 'url' && responseFormat !== 'b64_json') {
    return createResponse({ error: { message: 'response_format must be one of url or b64_json', type: 'invalid_request_error' } }, 400);
  }

  const qwenRatio = mapOpenAiImageSizeToQwenRatio(body?.size);
  // Create t2i session (automatically rotate token and retry on failure)
  const createdChat = await createChatSession(actualModel, 't2i');
  if (createdChat.statusCode) {
    return createdChat;
  }
  const { chatId, bxUa, bxUmidToken, bxV, cookies } = createdChat;

  // Map n to upstream via prompt hint since upstream has no explicit count parameter
  const finalPrompt = n === 1 ? prompt : `${prompt}\n\n(Generate ${n} images.)`;

  const chatResp = await fetch(`${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'bx-ua': bxUa,
      'bx-umidtoken': bxUmidToken,
      'bx-v': bxV,
      'Cookie': cookies,
      'x-accel-buffering': 'no',
      'Origin': QWEN_BASE_URL,
      'source': 'web',
      'version': '0.2.83',
      'Referer': QWEN_GUEST_REFERER,
      'User-Agent': WEB_USER_AGENT,
      'Accept-Language': WEB_ACCEPT_LANGUAGE,
      'x-request-id': uuidv4(),
    },
    body: JSON.stringify({
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'guest',
      model: actualModel,
      parent_id: null,
      messages: [{
        fid: uuidv4(),
        parentId: null,
        childrenIds: [uuidv4()],
        role: 'user',
        content: finalPrompt,
        user_action: 'chat',
        files: [],
        timestamp: Date.now(),
        models: [actualModel],
        chat_type: 't2i',
        feature_config: {
          thinking_enabled: true,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: true,
          thinking_mode: 'Auto',
          thinking_format: 'summary',
          auto_search: true,
        },
        extra: { meta: { subChatType: 't2i' } },
        sub_chat_type: 't2i',
        parent_id: null,
      }],
      timestamp: Date.now(),
      size: qwenRatio,
    }),
  });

  const rawText = await chatResp.text().catch(() => '');
  if (!chatResp.ok) {
    return createResponse({ error: { message: rawText || `HTTP ${chatResp.status}`, type: 'api_error' } }, chatResp.status);
  }

  const firstChar = rawText.trimStart().charAt(0);
  if (firstChar === '{' || firstChar === '[') {
    let parsed;
    try { parsed = JSON.parse(rawText); } catch {}
    if (parsed && parsed.success === false) {
      const errData = parsed.data || parsed;
      const msg = errData.details || errData.message || errData.code || 'Upstream request failed';
      return createResponse({ error: { message: msg, type: 'api_error', code: errData.code } }, 502);
    }
  }

  const urls = extractImageUrlsFromUpstreamSse(rawText);
  if (!urls || urls.length === 0) {
    const upstreamError = extractUpstreamErrorFromSse(rawText);
    if (upstreamError) {
      return createResponse({ error: { message: upstreamError.message, type: 'api_error', code: upstreamError.code } }, 502);
    }
    console.log('[qwen2api][image] Upstream SSE response with no image URLs:');
    console.log(rawText.slice(0, 2000));
    return createResponse({ error: { message: 'Upstream returned no image URLs', type: 'api_error' } }, 502);
  }

  const created = Math.floor(Date.now() / 1000);
  if (responseFormat === 'url') {
    return createResponse({
      created,
      data: urls.slice(0, n).map((u) => ({ url: u })),
    });
  }

  // b64_json
  try {
    const b64List = [];
    for (const u of urls.slice(0, n)) {
      b64List.push(await fetchImageAsBase64(u));
    }
    return createResponse({
      created,
      data: b64List.map((b64) => ({ b64_json: b64 })),
    });
  } catch (err) {
    const message = err && err.message ? err.message : 'Failed to fetch image bytes';
    return createResponse({ error: { message, type: 'api_error' } }, 502);
  }
}

async function sendUpstreamChatCompletionRequest({ chatId, bxUa, bxUmidToken, bxV, cookies, actualModel, chatType, enableSearch, content, uploadedFiles }) {
  return fetch(`${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'bx-ua': bxUa,
      'bx-umidtoken': bxUmidToken,
      'bx-v': bxV,
      'Cookie': cookies,
      'x-accel-buffering': 'no',
      'Origin': QWEN_BASE_URL,
      'source': 'web',
      'version': '0.2.83',
      'Referer': QWEN_GUEST_REFERER,
      'User-Agent': WEB_USER_AGENT,
      'Accept-Language': WEB_ACCEPT_LANGUAGE,
      'x-request-id': uuidv4(),
    },
    body: JSON.stringify({
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'guest',
      model: actualModel,
      parent_id: null,
      messages: [{
        id: null,
        fid: uuidv4(),
        parentId: null,
        childrenIds: [uuidv4()],
        role: 'user',
        content,
        user_action: 'chat',
        files: uploadedFiles,
        timestamp: Date.now(),
        models: [actualModel],
        model: '',
        chat_type: chatType,
        feature_config: {
          thinking_enabled: true,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: true,
          thinking_mode: 'Auto',
          thinking_format: 'summary',
          auto_search: enableSearch,
        },
        extra: { meta: { subChatType: chatType } },
        sub_chat_type: chatType,
        parent_id: null,
      }],
      timestamp: Date.now(),
    }),
  });
}

async function collectUpstreamSseBuffer(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer;
}

function buildFinalCompletionPayload({ responseId, created, actualModel, parsedSse, toolsConfig, stream }) {
  const toolExtraction = toolsConfig && toolsConfig.hasActiveTools
    ? extractToolCallsFromText(parsedSse.content, toolsConfig)
    : { toolCalls: [], cleanedContent: parsedSse.content, hadMalformedToolAttempt: false };

  const hasToolCalls = toolExtraction.toolCalls.length > 0;

  if (stream) {
    const events = [];
    if (parsedSse.reasoning_content) {
      events.push({
        delta: { role: 'assistant', reasoning_content: parsedSse.reasoning_content },
        finish_reason: null,
      });
    }
    if (hasToolCalls) {
      if (toolExtraction.cleanedContent) {
        events.push({
          delta: { role: 'assistant', content: toolExtraction.cleanedContent },
          finish_reason: null,
        });
      }
      events.push(...buildStreamingToolCallEvents(toolExtraction.toolCalls, toolsConfig.useLegacyFunctions));
    } else {
      for (const ev of parsedSse.events) {
        if (ev.delta?.reasoning_content && parsedSse.reasoning_content) continue;
        events.push(ev);
      }
      if (events.length === 0 || events[events.length - 1].finish_reason === null) {
        events.push({ delta: {}, finish_reason: 'stop' });
      }
    }
    const streamBody = events.map((event) => `data: ${JSON.stringify({
      id: responseId,
      object: 'chat.completion.chunk',
      created,
      model: actualModel,
      choices: [{ index: 0, delta: event.delta, finish_reason: event.finish_reason || null }],
    })}\n\n`).join('') + 'data: [DONE]\n\n';
    return createStreamResponse(streamBody);
  }

  const messageObj = {
    role: 'assistant',
    content: hasToolCalls ? (toolExtraction.cleanedContent || null) : parsedSse.content,
    ...(parsedSse.reasoning_content ? { reasoning_content: parsedSse.reasoning_content } : {}),
  };

  let finishReason = 'stop';
  if (hasToolCalls) {
    if (toolsConfig.useLegacyFunctions) {
      messageObj.function_call = {
        name: toolExtraction.toolCalls[0].function.name,
        arguments: toolExtraction.toolCalls[0].function.arguments,
      };
      finishReason = 'function_call';
    } else {
      messageObj.tool_calls = toolExtraction.toolCalls;
      finishReason = 'tool_calls';
    }
  }

  return createResponse({
    id: responseId,
    object: 'chat.completion',
    created,
    model: actualModel,
    choices: [{ index: 0, message: messageObj, finish_reason: finishReason }],
    usage: mapUsageToOpenAI(parsedSse.usage),
  });
}

async function handleChatCompletions(body, authHeader, env, streamWriter) {
  logChatDetail('core', 'request.entry', {
    hasAuthHeader: !!authHeader,
    bodyType: typeof body,
    hasMessages: !!body?.messages,
  });

  if (!validateToken(authHeader, env)) {
    logChatDetail('core', 'request.auth.failed', {});
    return createResponse({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } }, 401);
  }

  const { model, messages, stream = false } = body;
  if (!messages?.length) {
    logChatDetail('core', 'request.validation.failed', { reason: 'Messages are required' });
    return createResponse({ error: { message: 'Messages are required', type: 'invalid_request_error' } }, 400);
  }

  const toolsConfig = normalizeToolsConfig(body);

  logChatDetail('core', 'request.received', {
    stream: !!stream,
    model: model || 'qwen3.8-max',
    messageCount: Array.isArray(messages) ? messages.length : 0,
    hasTools: toolsConfig.hasActiveTools,
    toolCount: toolsConfig.tools.length,
    toolChoiceMode: toolsConfig.mode,
  });

  const actualModel = model || 'qwen3.8-max';

  // Disable upstream web search when active tools are present so it doesn't interfere with tool calling
  const rawEnableSearch = (env?.ENABLE_SEARCH || (typeof process !== 'undefined' && process.env && process.env.ENABLE_SEARCH) || '').toLowerCase() === 'true';
  const enableSearch = toolsConfig.hasActiveTools ? false : rawEnableSearch;
  const chatType = enableSearch ? 'search' : 't2t';
  logChatDetail('core', 'request.config', { actualModel, chatType, enableSearch });

  // Create chat session (automatically rotate token and retry on failure)
  const createdChat = await createChatSession(actualModel, chatType);
  if (createdChat.statusCode) {
    return createdChat;
  }
  const { chatId, bxUa, bxUmidToken, bxV, cookies } = createdChat;

  // Parse OpenAI-compatible messages, tool history, and attachments
  const parsedMessages = parseIncomingMessages(messages, toolsConfig);
  const content = parsedMessages.content;
  logChatDetail('core', 'message.parsed', {
    contentLength: content.length,
    attachmentCount: parsedMessages.attachments.length,
  });
  const uploadedFiles = parsedMessages.attachments.length > 0
    ? await uploadAttachments(parsedMessages.attachments, { bxUa, bxUmidToken, bxV })
    : [];
  logChatDetail('core', 'message.ready', {
    uploadedFileCount: uploadedFiles.length,
  });

  // Send request to upstream Qwen API
  const chatResp = await sendUpstreamChatCompletionRequest({
    chatId,
    bxUa,
    bxUmidToken,
    bxV,
    cookies,
    actualModel,
    chatType,
    enableSearch,
    content,
    uploadedFiles,
  });

  if (!chatResp.ok) {
    const errorText = await chatResp.text().catch(() => '');
    console.log(`[qwen2api][chat] Completion error: HTTP ${chatResp.status}, body: ${errorText.slice(0, 500)}`);
    const parsedErr = tryParseUpstreamErrorPayload(errorText);
    const errMsg = parsedErr?.message || errorText || `HTTP ${chatResp.status}`;
    return createResponse({ error: { message: errMsg, type: 'api_error', ...(parsedErr?.code ? { code: parsedErr.code } : {}) } }, chatResp.status);
  }
  logChatDetail('core', 'chat.completion.started', { status: chatResp.status, chatId, stream: !!stream });

  const responseId = `chatcmpl-${uuidv4()}`;
  const created = Math.floor(Date.now() / 1000);

  // If an Express/Vercel streamWriter is provided and tool_choice does not require a retry check, stream directly
  if (streamWriter && stream && !(toolsConfig.hasActiveTools && (toolsConfig.mode === 'required' || toolsConfig.mode === 'function'))) {
    logChatDetail('core', 'stream.proxy.express', { chatId, model: actualModel });
    return streamWriter(chatResp, actualModel, responseId, created, toolsConfig);
  }

  // Collect full response (and perform self-correction retry if a required tool call was missed or malformed)
  let buffer = await collectUpstreamSseBuffer(chatResp);
  let upstreamErr = tryParseUpstreamErrorPayload(buffer);
  if (upstreamErr) {
    console.log(`[qwen2api][chat] Upstream returned error (HTTP 200): ${upstreamErr.message}`);
    return createResponse({ error: upstreamErr }, 502);
  }
  let parsedSse = parseQwenSsePayload(buffer);

  if (toolsConfig.hasActiveTools) {
    const initialExtraction = extractToolCallsFromText(parsedSse.content, toolsConfig);
    const needsRetry = initialExtraction.toolCalls.length === 0 && (
      toolsConfig.mode === 'required' ||
      toolsConfig.mode === 'function' ||
      initialExtraction.hadMalformedToolAttempt
    );

    if (needsRetry) {
      logChatDetail('core', 'tool_call.retry.start', {
        mode: toolsConfig.mode,
        forcedFunctionName: toolsConfig.forcedFunctionName,
        hadMalformedToolAttempt: initialExtraction.hadMalformedToolAttempt,
      });
      const retrySession = await createChatSession(actualModel, chatType);
      if (!retrySession.statusCode) {
        const targetHint = toolsConfig.forcedFunctionName
          ? `You MUST call the function "${toolsConfig.forcedFunctionName}".`
          : `You MUST call one of these functions: ${Array.from(toolsConfig.toolMap.keys()).join(', ')}.`;
        const retryContent = `${content}\n\n[Assistant]: ${parsedSse.content || '(invalid output)'}\n\n[System Correction]: Your previous response did not contain a valid <tool_call> block. ${targetHint} Respond ONLY with:\n<tool_call>\n{"name": "${toolsConfig.forcedFunctionName || Array.from(toolsConfig.toolMap.keys())[0]}", "arguments": {...}}\n</tool_call>`;
        const retryResp = await sendUpstreamChatCompletionRequest({
          chatId: retrySession.chatId,
          bxUa: retrySession.bxUa,
          bxUmidToken: retrySession.bxUmidToken,
          bxV: retrySession.bxV,
          cookies: retrySession.cookies,
          actualModel,
          chatType,
          enableSearch,
          content: retryContent,
          uploadedFiles,
        });
        if (retryResp.ok) {
          const retryBuffer = await collectUpstreamSseBuffer(retryResp);
          const retryErr = tryParseUpstreamErrorPayload(retryBuffer);
          if (!retryErr) {
            const retryParsed = parseQwenSsePayload(retryBuffer);
            const retryExtraction = extractToolCallsFromText(retryParsed.content, toolsConfig);
            if (retryExtraction.toolCalls.length > 0) {
              parsedSse = retryParsed;
              logChatDetail('core', 'tool_call.retry.succeeded', { count: retryExtraction.toolCalls.length });
            }
          }
        }
      }
    }
  }

  logChatDetail('core', 'chat.completion.collected', {
    chunkCount: parsedSse.events.length,
    outputLength: parsedSse.content.length,
    stream: !!stream,
  });
  logChatDetail('core', 'stream.content.full', {
    content: parsedSse.content,
  });

  // If streaming via Express streamWriter after a required-tool buffer/retry, write the SSE payload to streamWriter
  if (streamWriter && stream) {
    const streamRes = buildFinalCompletionPayload({
      responseId,
      created,
      actualModel,
      parsedSse,
      toolsConfig,
      stream: true,
    });
    // Create a synthetic Response with the repacked SSE stream so streamWriter can flush it
    const syntheticResp = new Response(streamRes.body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    return streamWriter(syntheticResp, actualModel, responseId, created, null);
  }

  return buildFinalCompletionPayload({
    responseId,
    created,
    actualModel,
    parsedSse,
    toolsConfig,
    stream: !!stream,
  });
}

function handleRoot() {
  const html = '<html><head><title>200 OK</title></head><body><center><h1>200 OK</h1></center><hr><center>nginx</center></body></html>';
  return createResponse(html, 200, { 'Content-Type': 'text/html' });
}

// Chat HTML cache (disabled in development when disk is readable)
let chatHtmlCache = null;

function getChatHtml() {
  const fs = nodeRequire('fs');
  const path = nodeRequire('path');
  if (fs && path) {
    try {
      const htmlPath = path.join(__dirname, 'chat.html');
      // Always re-read file in development mode when disk is accessible
      chatHtmlCache = fs.readFileSync(htmlPath, 'utf-8');
      return chatHtmlCache;
    } catch {
      // Serverless bundle environments (Vercel/Netlify) cannot read chat.html directly; fall back to inlined copy below
    }
  }
  // Fallback: chat-html.js is an inlined copy generated from chat.html by the build script,
  // statically bundled by esbuild across all platforms (Local, Vercel, Netlify, CF Workers).
  return require('./chat-html.js');
}

function handleChatPage() {
  const html = getChatHtml();
  return createResponse(html, 200, { 'Content-Type': 'text/html; charset=utf-8' });
}

// ============================================
// Video Download (yt-dlp)
// ============================================

let ytdlpEnsurePromise = null;

function isTruthyFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timer);
  });
}

function resolveYtDlpAsset(platform, arch) {
  if (platform === 'win32') {
    if (arch === 'arm64') return { assetName: 'yt-dlp_arm64.exe', binaryName: 'yt-dlp.exe' };
    if (arch === 'ia32') return { assetName: 'yt-dlp_x86.exe', binaryName: 'yt-dlp.exe' };
    return { assetName: 'yt-dlp.exe', binaryName: 'yt-dlp.exe' };
  }
  if (platform === 'darwin') {
    return { assetName: 'yt-dlp_macos', binaryName: 'yt-dlp' };
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return { assetName: 'yt-dlp_linux_aarch64', binaryName: 'yt-dlp' };
    return { assetName: 'yt-dlp_linux', binaryName: 'yt-dlp' };
  }
  throw new Error(`Unsupported platform for auto-install yt-dlp: ${platform}/${arch}`);
}

function canRunYtDlp(binaryPath) {
  const childProcess = nodeRequire('child_process');
  if (!childProcess || typeof childProcess.spawnSync !== 'function') return false;
  const result = childProcess.spawnSync(binaryPath, ['--version'], {
    stdio: 'ignore',
    shell: false,
  });
  return result.status === 0;
}

async function ensureYtDlpAvailable(sendLog) {
  const fs = nodeRequire('fs');
  const path = nodeRequire('path');
  const os = nodeRequire('os');
  if (!fs || !path || !os) {
    throw new Error('yt-dlp is not supported in this runtime (no filesystem)');
  }
  const log = typeof sendLog === 'function' ? sendLog : () => {};
  const platform = process.platform;
  const arch = process.arch;
  const configuredPath = (process.env.YT_DLP_PATH || '').trim();
  if (configuredPath) {
    if (!canRunYtDlp(configuredPath)) {
      throw new Error(`YT_DLP_PATH is set but not executable: ${configuredPath}`);
    }
    return configuredPath;
  }

  if (canRunYtDlp('yt-dlp')) {
    return 'yt-dlp';
  }

  const autoDownload = isTruthyFlag(process.env.YT_DLP_AUTO_DOWNLOAD, true);
  if (!autoDownload) {
    throw new Error('yt-dlp not found and auto-download is disabled (YT_DLP_AUTO_DOWNLOAD=false).');
  }

  if (ytdlpEnsurePromise) {
    return ytdlpEnsurePromise;
  }

  ytdlpEnsurePromise = (async () => {
    const { assetName, binaryName } = resolveYtDlpAsset(platform, arch);
    const baseDir = path.join(os.tmpdir(), 'qwen2api_bin', 'yt-dlp');
    const binaryPath = path.join(baseDir, binaryName);
    const tempPath = `${binaryPath}.tmp-${process.pid}-${Date.now()}`;
    const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;

    if (fs.existsSync(binaryPath) && canRunYtDlp(binaryPath)) {
      log('video.ytdlp.ready', { source: 'cached', binaryPath, platform, arch });
      return binaryPath;
    }

    log('video.ytdlp.download.start', { platform, arch, assetName, downloadUrl });
    fs.mkdirSync(baseDir, { recursive: true });

    let response;
    try {
      response = await fetchWithTimeout(downloadUrl, { method: 'GET' }, 45000);
    } catch (err) {
      throw new Error(`Failed to download yt-dlp: ${err.message}`);
    }

    if (!response.ok) {
      throw new Error(`Failed to download yt-dlp: HTTP ${response.status}`);
    }

    let bytes;
    try {
      const arrayBuffer = await response.arrayBuffer();
      bytes = Buffer.from(arrayBuffer);
      fs.writeFileSync(tempPath, bytes);

      if (platform !== 'win32') {
        fs.chmodSync(tempPath, 0o755);
      }

      fs.renameSync(tempPath, binaryPath);
    } finally {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {}
    }

    if (!canRunYtDlp(binaryPath)) {
      try {
        if (fs.existsSync(binaryPath)) {
          fs.unlinkSync(binaryPath);
        }
      } catch (cleanupErr) {
        log('video.ytdlp.cleanup.failed', { error: cleanupErr.message, binaryPath });
      }
      throw new Error(`yt-dlp downloaded but execution failed: ${binaryPath}`);
    }

    log('video.ytdlp.download.done', {
      binaryPath,
      size: bytes.length,
      platform,
      arch,
      assetName,
    });

    return binaryPath;
  })();

  try {
    return await ytdlpEnsurePromise;
  } finally {
    ytdlpEnsurePromise = null;
  }
}

function resolveMinVideoResolutionFromInput(rawValue) {
  const allowed = new Set([360, 480, 720]);
  if (rawValue === undefined || rawValue === null) return null;
  const text = String(rawValue).trim().toLowerCase();
  if (!text || text === 'default') return null;
  const numeric = Number.parseInt(text, 10);
  if (!Number.isFinite(numeric)) return null;
  return allowed.has(numeric) ? numeric : null;
}

function getEffectiveMinResolution(preferredResolution) {
  const fromWeb = resolveMinVideoResolutionFromInput(preferredResolution);
  if (fromWeb) {
    return { minResolution: fromWeb, source: 'web' };
  }
  const fromEnv = resolveMinVideoResolutionFromInput(process.env.MIN_VIDEO_RESOLUTION || '480');
  if (fromEnv) {
    return { minResolution: fromEnv, source: 'env' };
  }
  return { minResolution: 480, source: 'fallback' };
}

async function downloadVideoWithYtDlp(videoUrl, sendLog, preferredResolution) {
  const childProcess = nodeRequire('child_process');
  const path = nodeRequire('path');
  const fs = nodeRequire('fs');
  const os = nodeRequire('os');
  if (!childProcess || !path || !fs || !os) {
    throw new Error('yt-dlp is not supported in this runtime (no child_process/filesystem)');
  }
  const { spawn } = childProcess;

  // Read minimum resolution from environment or request, default 480p
  const resolutionInfo = getEffectiveMinResolution(preferredResolution);
  const minResolution = resolutionInfo.minResolution;

  return new Promise((resolve, reject) => {
    const tmpDir = path.join(os.tmpdir(), 'qwen2api_videos');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const outputFile = path.join(tmpDir, `video_${Date.now()}.mp4`);
    
    // Format selection: prefer available streams up to target height to avoid "format not available" errors
    // Fallback chain: <=target height separate video+audio -> <=target height single file -> any separate stream -> best
    const formatSelector = `bestvideo[height<=${minResolution}][vcodec!=none][acodec=none]+bestaudio[acodec!=none]/best[height<=${minResolution}]/bestvideo[vcodec!=none][acodec=none]+bestaudio[acodec!=none]/best`;

    sendLog('video.download.running', {
      videoUrl,
      minResolution: minResolution + 'p',
      minResolutionHint: 'height',
      resolutionSource: resolutionInfo.source,
      requestedResolution: preferredResolution === undefined ? null : String(preferredResolution),
      formatSelector,
    });

    let ytdlpBinary = 'yt-dlp';
    ensureYtDlpAvailable(sendLog).then((resolvedBinary) => {
      ytdlpBinary = resolvedBinary;
      const ytdlp = spawn(ytdlpBinary, [
        '-f', formatSelector,
        '--no-playlist',
        '--max-filesize', '100M',
        '-o', outputFile,
        '--no-warnings',
        '--merge-output-format', 'mp4',
        videoUrl
      ]);

      let stderr = '';
      
      ytdlp.stderr.on('data', (data) => {
        stderr += data.toString();
        // Parse download progress
        const progressMatch = stderr.match(/(\d+\.?\d*)%/);
        if (progressMatch) {
          sendLog('video.download.progress', { progress: progressMatch[1] + '%' });
        }
      });

      ytdlp.on('close', (code) => {
        if (code !== 0) {
          // Clean up temp file on failure
          try {
            if (fs.existsSync(outputFile)) {
              fs.unlinkSync(outputFile);
            }
          } catch {}
          reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
          return;
        }

        if (!fs.existsSync(outputFile)) {
          reject(new Error('Video file not found after download'));
          return;
        }

        try {
          const stats = fs.statSync(outputFile);
          const bytes = fs.readFileSync(outputFile);
          const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
          
          sendLog('video.download.finished', {
            filepath: outputFile,
            size: stats.size,
            sizeMB: sizeMB + ' MB'
          });

          // Create attachment object matching web upload format
          const base64 = bytes.toString('base64');
          const dataUrl = `data:video/mp4;base64,${base64}`;
          
          const attachment = {
            source: dataUrl,
            filename: path.basename(outputFile),
            mimeType: 'video/mp4',
            explicitType: 'video',
            size: stats.size,
            sizeMB: sizeMB + ' MB',
            _tempFilePath: outputFile, // Keep temporary file path for subsequent cleanup
          };

          resolve(attachment);
        } catch (err) {
          reject(err);
        }
      });

      ytdlp.on('error', (err) => {
        // Clean up temp file on error
        try {
          if (fs.existsSync(outputFile)) {
            fs.unlinkSync(outputFile);
          }
        } catch (cleanupErr) {
          sendLog('video.download.cleanup.failed', { error: cleanupErr.message, outputFile });
        }
        if (err.code === 'ENOENT') {
          reject(new Error(`yt-dlp not found after ensure step. binary=${ytdlpBinary}`));
        } else {
          reject(err);
        }
      });
    }).catch((err) => {
      sendLog('video.ytdlp.ensure.failed', { error: err && err.message ? err.message : String(err) });
      reject(err);
    });
  });
}

// ============================================
// Streaming Chat Completions with Logs
// ============================================

function createLogStreamWriter(writer, onDone = null) {
  // writer is an object containing write/log/end methods
  return async (response, model, responseId, created, toolsConfig = null) => {
    const reader = response.body?.getReader ? response.body.getReader() : null;
    const decoder = new TextDecoder();
    let buffer = '';
    let doneWritten = false;
    let anyChunkWritten = false;
    let nonDataBuffer = '';
    const hasActiveTools = !!(toolsConfig && toolsConfig.hasActiveTools);
    const answerBufferParts = [];

    if (!reader) {
      throw new Error('Upstream response has no readable body');
    }

    const flushToolAwareAnswer = () => {
      if (!hasActiveTools) return;
      const fullAnswer = answerBufferParts.join('');
      const extraction = extractToolCallsFromText(fullAnswer, toolsConfig);
      if (extraction.toolCalls.length > 0) {
        if (extraction.cleanedContent) {
          const textChunk = {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { role: 'assistant', content: extraction.cleanedContent }, finish_reason: null }],
          };
          writer.write(`data: ${JSON.stringify(textChunk)}\n\n`);
        }
        const toolEvents = buildStreamingToolCallEvents(extraction.toolCalls, toolsConfig.useLegacyFunctions);
        for (const ev of toolEvents) {
          const tcChunk = {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: ev.delta, finish_reason: ev.finish_reason }],
          };
          writer.write(`data: ${JSON.stringify(tcChunk)}\n\n`);
        }
        anyChunkWritten = true;
      } else if (fullAnswer) {
        const textChunk = {
          id: responseId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content: fullAnswer }, finish_reason: 'stop' }],
        };
        writer.write(`data: ${JSON.stringify(textChunk)}\n\n`);
        anyChunkWritten = true;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trimStart();
          if (!trimmed.startsWith('data:')) {
            nonDataBuffer += line + '\n';
            continue;
          }
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            flushToolAwareAnswer();
            writer.write('data: [DONE]\n\n');
            doneWritten = true;
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed?.error) {
              const upstreamError = typeof parsed.error === 'string' ? { message: parsed.error } : parsed.error;
              const errorMsg = upstreamError.message || upstreamError.details || 'Request failed';
              // Surface content safety warnings as normal assistant output instead of errors
              if (upstreamError.code === 'data_inspection_failed' || upstreamError.details) {
                const warningChunk = {
                  id: responseId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: { role: 'assistant', content: errorMsg },
                    finish_reason: 'stop',
                  }],
                };
                writer.write(`data: ${JSON.stringify(warningChunk)}\n\n`);
                doneWritten = true;
                writer.write('data: [DONE]\n\n');
                continue;
              }
              const errObj = {
                error: {
                  message: errorMsg,
                  type: upstreamError.type || 'api_error',
                  code: upstreamError.code,
                }
              };
              writer.write(`data: ${JSON.stringify(errObj)}\n\n`);
              anyChunkWritten = true;
              continue;
            }

            // Pass through pre-formatted OpenAI tool_calls chunks (from synthetic retry stream)
            const rawDelta = parsed?.choices?.[0]?.delta;
            if (rawDelta && (rawDelta.tool_calls || rawDelta.function_call)) {
              writer.write(`data: ${JSON.stringify(parsed)}\n\n`);
              anyChunkWritten = true;
              continue;
            }

            const delta = mapUpstreamDeltaToOpenAI(rawDelta);
            if (hasActiveTools) {
              if (delta?.reasoning_content) {
                const rChunk = {
                  id: responseId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: delta.reasoning_content }, finish_reason: null }],
                };
                writer.write(`data: ${JSON.stringify(rChunk)}\n\n`);
                anyChunkWritten = true;
              }
              if (typeof delta?.content === 'string' && delta.content) {
                answerBufferParts.push(delta.content);
              }
              continue;
            }

            if (delta || parsed?.choices?.[0]?.finish_reason) {
              const chunk = {
                id: responseId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                  index: 0,
                  delta: delta || {},
                  finish_reason: parsed?.choices?.[0]?.finish_reason || null,
                }],
              };
              writer.write(`data: ${JSON.stringify(chunk)}\n\n`);
              anyChunkWritten = true;
            }
          } catch {}
        }
      }
      if (buffer.trim() && !buffer.trimStart().startsWith('data:')) {
        nonDataBuffer += buffer;
      }
      if (!doneWritten && hasActiveTools && answerBufferParts.length > 0) {
        flushToolAwareAnswer();
      }
      if (!doneWritten && !anyChunkWritten) {
        const err = tryParseUpstreamErrorPayload(nonDataBuffer);
        if (err) {
          writer.write(`data: ${JSON.stringify({ error: err })}\n\n`);
          writer.write('data: [DONE]\n\n');
          doneWritten = true;
        }
      }
    } catch (err) {
      const message = err && err.message ? err.message : 'stream proxy error';
      writer.write(`data: ${JSON.stringify({ error: { message, type: 'api_error' } })}\n\n`);
    } finally {
      if (!doneWritten) {
        writer.write('data: [DONE]\n\n');
      }
      writer.end();
      // Execute cleanup callback
      if (onDone) {
        try {
          onDone();
        } catch {}
      }
    }
  };
}

async function handleChatCompletionsWithLogs(body, authHeader, env, streamWriter) {
  logChatDetail('core', 'request.entry', {
    hasAuthHeader: !!authHeader,
    bodyType: typeof body,
    hasMessages: !!body?.messages,
  });

  // Validate token
  if (!validateToken(authHeader, env)) {
    logChatDetail('core', 'request.auth.failed', {});
    return createResponse({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } }, 401);
  }

  const { model, messages, stream = false } = body;
  if (!messages?.length) {
    logChatDetail('core', 'request.validation.failed', { reason: 'Messages are required' });
    return createResponse({ error: { message: 'Messages are required', type: 'invalid_request_error' } }, 400);
  }

  const toolsConfig = normalizeToolsConfig(body);

  // Log helper
  const sendLog = (event, detail = {}) => {
    const logData = JSON.stringify({ event, timestamp: Date.now(), ...detail });
    if (streamWriter && streamWriter.log) {
      streamWriter.log(logData);
    }
  };

  logChatDetail('core', 'request.received', {
    stream: !!stream,
    model: model || 'qwen3.8-max',
    messageCount: Array.isArray(messages) ? messages.length : 0,
    hasTools: toolsConfig.hasActiveTools,
  });
  sendLog('request.received', {
    model: model || 'qwen3.8-max',
    messageCount: messages.length,
    hasTools: toolsConfig.hasActiveTools,
    toolCount: toolsConfig.tools.length,
  });

  const actualModel = model || 'qwen3.8-max';

  // Check if web search is enabled (disabled when active tools are configured)
  const rawEnableSearch = (env?.ENABLE_SEARCH || (typeof process !== 'undefined' && process.env && process.env.ENABLE_SEARCH) || '').toLowerCase() === 'true';
  const enableSearch = toolsConfig.hasActiveTools ? false : rawEnableSearch;
  const chatType = enableSearch ? 'search' : 't2t';
  logChatDetail('core', 'request.config', { actualModel, chatType, enableSearch });
  sendLog('config.ready', { model: actualModel, chatType, enableSearch });

  // Create chat session (automatically rotate token and retry on failure)
  sendLog('chat.creating', {});
  const createdChat = await createChatSession(actualModel, chatType);
  if (createdChat.statusCode) {
    sendLog('chat.create.failed', { status: createdChat.statusCode, error: 'create-failed', response: null });
    return createdChat;
  }
  const { chatId, bxUa, bxUmidToken, bxV, cookies } = createdChat;
  sendLog('chat.created', { chatId });

  // Parse messages and attachments
  const parsedMessages = parseIncomingMessages(messages, toolsConfig);
  const content = parsedMessages.content;
  logChatDetail('core', 'message.parsed', {
    contentLength: content.length,
    attachmentCount: parsedMessages.attachments.length,
  });
  sendLog('message.parsed', { contentLength: content.length, attachmentCount: parsedMessages.attachments.length });

  // Collect temporary file paths for subsequent cleanup
  const tempFilesToClean = [];

  // Handle video URL download
  const videoUrl = body.video_url;
  const preferredResolution = body?.min_video_resolution;
  if (videoUrl) {
    sendLog('video.download.start', {
      videoUrl,
      preferredResolution: preferredResolution === undefined ? null : String(preferredResolution),
    });
    try {
      const videoAttachment = await downloadVideoWithYtDlp(videoUrl, sendLog, preferredResolution);
      if (videoAttachment) {
        parsedMessages.attachments.push(videoAttachment);
        // Record temporary file path
        if (videoAttachment._tempFilePath) {
          tempFilesToClean.push(videoAttachment._tempFilePath);
        }
        sendLog('video.download.completed', {
          filename: videoAttachment.filename,
          size: videoAttachment.size || 0,
          sizeMB: videoAttachment.sizeMB || '',
        });
      }
    } catch (err) {
      const errorMessage = err && err.message ? err.message : String(err);
      sendLog('video.download.failed', { error: errorMessage });
      return createResponse({
        error: {
          message: `Video download failed: ${errorMessage}`,
          type: 'api_error'
        }
      }, 500);
    }
  }

  // Upload attachments
  let uploadedFiles = [];
  if (parsedMessages.attachments.length > 0) {
    sendLog('attachments.upload.start', { count: parsedMessages.attachments.length });
    for (let i = 0; i < parsedMessages.attachments.length; i++) {
      const rawAttachment = parsedMessages.attachments[i];
      sendLog('attachment.uploading', { index: i + 1, filename: rawAttachment.filename || 'unknown' });
      
      try {
        const loaded = await getAttachmentBytes(rawAttachment);
        loaded.explicitType = rawAttachment.explicitType;
        const { tokenData, filetype } = await requestUploadToken(loaded, { bxUa, bxUmidToken, bxV });
        await uploadFileToQwenOss(loaded, tokenData);
        const qwenFilePayload = buildQwenFilePayload(loaded, tokenData, filetype);
        await ensureUploadStatusForNonVideo(filetype, { bxUa, bxUmidToken, bxV });
        await parseDocumentIfNeeded(qwenFilePayload, filetype, loaded, { bxUa, bxUmidToken, bxV });
        if (filetype === 'document') {
          await ensureUploadStatusForNonVideo(filetype, { bxUa, bxUmidToken, bxV });
        }
        uploadedFiles.push(qwenFilePayload);
        sendLog('attachment.uploaded', { index: i + 1, filetype, filename: loaded.filename });
      } catch (err) {
        const errorMessage = err && err.message ? err.message : String(err);
        sendLog('attachment.upload.failed', { index: i + 1, error: errorMessage });
        return createResponse({
          error: {
            message: `Attachment upload failed (index ${i + 1}): ${errorMessage}`,
            type: 'api_error'
          }
        }, 500);
      }
    }
    sendLog('attachments.upload.done', { uploadedCount: uploadedFiles.length });
  }

  logChatDetail('core', 'message.ready', {
    uploadedFileCount: uploadedFiles.length,
  });

  // Send request
  sendLog('chat.sending', { chatId });
  const chatResp = await sendUpstreamChatCompletionRequest({
    chatId,
    bxUa,
    bxUmidToken,
    bxV,
    cookies,
    actualModel,
    chatType,
    enableSearch,
    content,
    uploadedFiles,
  });

  if (!chatResp.ok) {
    const errorText = await chatResp.text().catch(() => '');
    logChatDetail('core', 'chat.completion.error', { status: chatResp.status, chatId, error: errorText });
    sendLog('chat.response.failed', { status: chatResp.status, error: errorText });
    const parsedErr = tryParseUpstreamErrorPayload(errorText);
    const errMsg = parsedErr?.message || errorText || `HTTP ${chatResp.status}`;
    return createResponse({ error: { message: errMsg, type: 'api_error', ...(parsedErr?.code ? { code: parsedErr.code } : {}) } }, chatResp.status);
  }

  logChatDetail('core', 'chat.completion.started', { status: chatResp.status, chatId, stream: !!stream });
  sendLog('chat.streaming', {});

  const responseId = `chatcmpl-${uuidv4()}`;
  const created = Math.floor(Date.now() / 1000);

  // Function to clean up temporary video files
  const cleanupTempFiles = () => {
    const fs = nodeRequire('fs');
    if (!fs) return;
    for (const tempFile of tempFilesToClean) {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
          sendLog('video.tempfile.cleaned', { file: tempFile });
        }
      } catch {}
    }
  };

  // If streamWriter is provided, use streaming handler
  if (streamWriter && stream && !(toolsConfig.hasActiveTools && (toolsConfig.mode === 'required' || toolsConfig.mode === 'function'))) {
    logChatDetail('core', 'stream.proxy.express', { chatId, model: actualModel });
    const logAwareWriter = createLogStreamWriter(streamWriter, cleanupTempFiles);
    return logAwareWriter(chatResp, actualModel, responseId, created, toolsConfig);
  }

  // Non-Express or required tool verification: collect full response
  const buffer = await collectUpstreamSseBuffer(chatResp);
  const upstreamErr = tryParseUpstreamErrorPayload(buffer);
  if (upstreamErr) {
    console.log(`[qwen2api][chat-log] Upstream returned error (HTTP 200): ${upstreamErr.message}`);
    sendLog('chat.response.failed', { error: upstreamErr.message });
    cleanupTempFiles();
    return createResponse({ error: upstreamErr }, 502);
  }
  const parsedSse = parseQwenSsePayload(buffer);

  logChatDetail('core', 'chat.completion.collected', {
    chunkCount: parsedSse.events.length,
    outputLength: parsedSse.content.length,
    stream: !!stream,
  });
  logChatDetail('core', 'stream.content.full', {
    content: parsedSse.content,
  });
  sendLog('chat.completed', { outputLength: parsedSse.content.length });

  // Clean up temporary video files
  cleanupTempFiles();

  if (streamWriter && stream) {
    const streamRes = buildFinalCompletionPayload({
      responseId,
      created,
      actualModel,
      parsedSse,
      toolsConfig,
      stream: true,
    });
    const syntheticResp = new Response(streamRes.body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const logAwareWriter = createLogStreamWriter(streamWriter, null);
    return logAwareWriter(syntheticResp, actualModel, responseId, created, null);
  }

  return buildFinalCompletionPayload({
    responseId,
    created,
    actualModel,
    parsedSse,
    toolsConfig,
    stream: !!stream,
  });
}

// ============================================
// Streaming Response Writer (shared by Express / Vercel Node)
// ============================================

// Generic SSE stream writer: converts upstream SSE into OpenAI format in real time and writes to res
// (res only needs setHeader / write / end / writableEnded, supported by both Express and Vercel Node)
function createExpressStreamHandler(res) {
  return async (response, model, responseId, created, toolsConfig = null) => {
    const rawFlag = (typeof process !== 'undefined' && process.env && process.env.CHAT_DETAIL_LOG) || '';
    const debugEnabled = ['1', 'true', 'yes', 'on'].includes(String(rawFlag).toLowerCase());
    let hasStreamContent = false;

    const writeStreamContent = (content) => {
      if (!debugEnabled || !content) return;
      hasStreamContent = true;
      if (typeof process !== 'undefined' && process.stdout) process.stdout.write(content);
    };

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    const reader = response.body?.getReader ? response.body.getReader() : null;
    const decoder = new TextDecoder();
    let buffer = '';
    let doneWritten = false;
    let anyChunkWritten = false;
    let nonDataBuffer = '';
    const hasActiveTools = !!(toolsConfig && toolsConfig.hasActiveTools);
    const answerBufferParts = [];

    const flushToolAwareAnswer = () => {
      if (!hasActiveTools || res.writableEnded) return;
      const fullAnswer = answerBufferParts.join('');
      const extraction = extractToolCallsFromText(fullAnswer, toolsConfig);
      if (extraction.toolCalls.length > 0) {
        if (extraction.cleanedContent) {
          writeStreamContent(extraction.cleanedContent);
          const textChunk = {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { role: 'assistant', content: extraction.cleanedContent }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
        }
        const toolEvents = buildStreamingToolCallEvents(extraction.toolCalls, toolsConfig.useLegacyFunctions);
        for (const ev of toolEvents) {
          const tcChunk = {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: ev.delta, finish_reason: ev.finish_reason }],
          };
          res.write(`data: ${JSON.stringify(tcChunk)}\n\n`);
        }
        anyChunkWritten = true;
      } else if (fullAnswer) {
        writeStreamContent(fullAnswer);
        const textChunk = {
          id: responseId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content: fullAnswer }, finish_reason: 'stop' }],
        };
        res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
        anyChunkWritten = true;
      }
    };

    try {
      if (!reader) {
        throw new Error('Upstream response has no readable body');
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trimStart();
          if (!trimmed.startsWith('data:')) {
            nonDataBuffer += line + '\n';
            continue;
          }
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            flushToolAwareAnswer();
            res.write('data: [DONE]\n\n');
            doneWritten = true;
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed?.error) {
              const upstreamError = typeof parsed.error === 'string' ? { message: parsed.error } : parsed.error;
              const errorMsg = upstreamError.message || upstreamError.details || 'Request failed';
              // Surface content safety warnings as normal assistant output instead of errors
              if (upstreamError.code === 'data_inspection_failed' || upstreamError.details) {
                const warningChunk = {
                  id: responseId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: { role: 'assistant', content: errorMsg },
                    finish_reason: 'stop',
                  }],
                };
                res.write(`data: ${JSON.stringify(warningChunk)}\n\n`);
                doneWritten = true;
                res.write('data: [DONE]\n\n');
                continue;
              }
              const errObj = {
                error: {
                  message: errorMsg,
                  type: upstreamError.type || 'api_error',
                  code: upstreamError.code,
                }
              };
              res.write(`data: ${JSON.stringify(errObj)}\n\n`);
              anyChunkWritten = true;
              continue;
            }

            // Pass through pre-formatted OpenAI tool_calls chunks (from synthetic retry stream)
            const rawDelta = parsed?.choices?.[0]?.delta;
            if (rawDelta && (rawDelta.tool_calls || rawDelta.function_call)) {
              res.write(`data: ${JSON.stringify(parsed)}\n\n`);
              anyChunkWritten = true;
              continue;
            }

            const delta = mapUpstreamDeltaToOpenAI(rawDelta);
            if (hasActiveTools) {
              if (delta?.reasoning_content) {
                const rChunk = {
                  id: responseId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: delta.reasoning_content }, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(rChunk)}\n\n`);
                anyChunkWritten = true;
              }
              if (typeof delta?.content === 'string' && delta.content) {
                answerBufferParts.push(delta.content);
              }
              continue;
            }

            if (delta || parsed?.choices?.[0]?.finish_reason) {
              if (delta && typeof delta.content === 'string' && delta.content) {
                writeStreamContent(delta.content);
              }
              const chunk = {
                id: responseId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                  index: 0,
                  delta: delta || {},
                  finish_reason: parsed?.choices?.[0]?.finish_reason || null,
                }],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              anyChunkWritten = true;
            }
          } catch {}
        }
      }
      if (buffer.trim() && !buffer.trimStart().startsWith('data:')) {
        nonDataBuffer += buffer;
      }
      if (!doneWritten && hasActiveTools && answerBufferParts.length > 0) {
        flushToolAwareAnswer();
      }
      if (!doneWritten && !anyChunkWritten) {
        const err = tryParseUpstreamErrorPayload(nonDataBuffer);
        if (err) {
          res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
          res.write('data: [DONE]\n\n');
          doneWritten = true;
        }
      }
    } catch (err) {
      if (!res.writableEnded) {
        const message = err && err.message ? err.message : 'stream proxy error';
        res.write(`data: ${JSON.stringify({ error: { message, type: 'api_error' } })}\n\n`);
      }
    } finally {
      if (!doneWritten && !res.writableEnded) {
        res.write('data: [DONE]\n\n');
      }
      if (!res.writableEnded) {
        res.end();
      }
    }

    if (debugEnabled && hasStreamContent && typeof process !== 'undefined' && process.stdout) {
      process.stdout.write('\n');
      console.log('[qwen2api][stream] Stream completed');
    }
  };
}

// Stream writer with log events (event: log)
function createExpressLogStreamHandler(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  const streamWriter = {
    write: (data) => {
      if (!res.writableEnded) {
        res.write(data);
      }
    },
    log: (logData) => {
      if (!res.writableEnded) {
        res.write(`event: log\n`);
        res.write(`data: ${logData}\n\n`);
      }
    },
    end: () => {
      if (!res.writableEnded) {
        res.end();
      }
    }
  };

  return streamWriter;
}

// ============================================
// Exports
// ============================================

module.exports = {
  handleModels,
  handleChatCompletions,
  handleChatCompletionsWithLogs,
  handleImageGenerations,
  handleRoot,
  handleChatPage,
  createResponse,
  validateToken,
  getBaxiaTokens,
  mapUpstreamDeltaToOpenAI,
  parseQwenSsePayload,
  mapUsageToOpenAI,
  tryParseUpstreamErrorPayload,
  createExpressStreamHandler,
  createExpressLogStreamHandler,
  normalizeToolsConfig,
  extractToolCallsFromText,
  buildStreamingToolCallEvents,
  parseIncomingMessages,
  uuidv4,
};

