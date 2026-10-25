#!/usr/bin/env node
/**
 * Generates chat-html.js from chat.html (inlining the page content as a CommonJS module).
 *
 * Why needed: Vercel / Netlify Node serverless environments only include bundled code,
 * so runtime `fs.readFileSync('chat.html')` cannot find repository files (ENOENT).
 * `getChatHtml()` in core.js falls back to this inlined copy when disk reads fail.
 *
 * After editing chat.html, re-run this script to synchronize:
 *   node scripts/build-chat-html.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const htmlPath = path.join(rootDir, 'chat.html');
const outPath = path.join(rootDir, 'chat-html.js');

const html = fs.readFileSync(htmlPath, 'utf-8');
// JSON.stringify produces a valid JS string literal (escaping quotes, backslashes, and newlines)
const payload = JSON.stringify(html);

const header = `// Auto-generated from chat.html by scripts/build-chat-html.js. Do not edit manually.\n` +
  `// After modifying chat.html, run: node scripts/build-chat-html.js\n` +
  `// Generated at: ${new Date().toISOString()}\n`;

fs.writeFileSync(outPath, header + 'module.exports = ' + payload + ';\n', 'utf-8');

const inBytes = Buffer.byteLength(html, 'utf-8');
const outBytes = fs.statSync(outPath).size;
console.log(`chat-html.js generated: ${outPath}`);
console.log(`  chat.html: ${inBytes} bytes -> chat-html.js: ${outBytes} bytes`);

