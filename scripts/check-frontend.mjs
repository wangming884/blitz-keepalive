#!/usr/bin/env node
/**
 * Guards the browser bundles against the class of bug that `node --check`
 * cannot catch: a function that is *called* but never *defined*.
 *
 * `public/app.js` had a `formatScheduleDays()` call with no definition, so any
 * target with a schedule window threw during render. The whole target list went
 * blank while the request itself succeeded — a syntax gate would never see it.
 *
 * The check is deliberately heuristic: it only looks at bare (non-member) calls
 * in the top-level of the bundled scripts and ignores platform globals, so the
 * false-positive rate stays near zero for the style used in this repo.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TARGET_DIR = path.join(ROOT, 'public');

const PLATFORM_GLOBALS = new Set([
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'Promise', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'RegExp', 'parseInt',
  'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
  'decodeURI', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask', 'structuredClone', 'console',
  'document', 'window', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'Intl', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'MutationObserver',
  'IntersectionObserver', 'ResizeObserver', 'Event', 'CustomEvent', 'Blob', 'File', 'FileReader',
  'FormData', 'Headers', 'Request', 'Response', 'TextEncoder', 'TextDecoder', 'Symbol', 'BigInt',
  'Function', 'Proxy', 'Reflect', 'globalThis', 'self', 'alert', 'confirm', 'prompt',
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'void', 'delete', 'new', 'await',
  'async', 'function', 'class', 'super', 'this', 'yield', 'in', 'of', 'instanceof', 'do', 'else',
  'try', 'finally', 'throw', 'break', 'continue', 'case', 'default', 'let', 'const', 'var',
]);

async function collectJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectJsFiles(absolute)));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }
  return files;
}

function collectDefinitions(source) {
  const defined = new Set();
  for (const match of source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(match[1]);
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(match[1]);
  for (const match of source.matchAll(/^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
    defined.add(match[1]);
  }
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) defined.add(name);
    }
  }
  for (const match of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) defined.add(match[1]);
  return defined;
}

function collectBareCalls(source) {
  const calls = new Map();
  for (const match of source.matchAll(/(^|[^\w$.\]])\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[2];
    if (PLATFORM_GLOBALS.has(name)) continue;
    if (calls.has(name)) continue;
    const line = source.slice(0, match.index).split('\n').length;
    calls.set(name, line);
  }
  return calls;
}

const files = await collectJsFiles(TARGET_DIR);
const failures = [];

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const defined = collectDefinitions(source);
  for (const [name, line] of collectBareCalls(source)) {
    if (defined.has(name)) continue;
    failures.push(`${path.relative(ROOT, file)}:${line}  调用了未定义的函数 ${name}()`);
  }
}

if (failures.length > 0) {
  console.error('[check-frontend] 发现未定义的函数调用：');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`[check-frontend] ${files.length} 个浏览器脚本，未发现未定义的函数调用。`);
