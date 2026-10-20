#!/usr/bin/env node
/**
 * Wake-page detection regression tests.
 *
 * blitz.cloud serves its "waking up" page with HTTP 200 and real text, and in
 * Chinese for zh-CN browsers. Before these checks existed the page passed every
 * readiness rule and a sleeping app was reported as "页面就绪", so the agent
 * never waited for the app to actually boot.
 *
 * The suite drives the real CLI (--probe) against three local pages:
 *   - a Chinese wake page that never becomes ready
 *   - a wake page that turns into a real page after 8s
 *   - a thin app shell with no wake wording at all
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.CHROME_PATH;

const WAKE_ZH = `<!doctype html><html><head><meta charset="utf-8"><title>opencode2api · Operations Handbook</title></head>
<body><h1>应用正在唤醒</h1><p>正在唤醒应用，通常需要几秒钟，请稍候。</p></body></html>`;
const READY = `<!doctype html><html><head><meta charset="utf-8"><title>opencode2api · Operations Handbook</title></head>
<body><h1>Operations Handbook</h1><p>${'真实内容填充。'.repeat(60)}</p></body></html>`;
const SHELL = `<!doctype html><html><head><meta charset="utf-8"><title>opencode2api · Operations Handbook</title></head>
<body><div id="root"></div><p>Loading</p></body></html>`;

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function send(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function probe(port, extraArgs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [
      'keepalive.mjs',
      `--probe=http://127.0.0.1:${port}/`,
      '--headless',
      ...(CHROME ? [`--chrome=${CHROME}`] : []),
      ...extraArgs,
    ];
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        TARGET_URL_ALLOW_PRIVATE: 'true',
        TARGET_URL_ALLOWLIST: '127.0.0.1',
        LOCK_FILE: path.join(ROOT, 'artifacts', 'wake-test.lock'),
        LOG_DIR: path.join(ROOT, 'artifacts', 'wake-test-logs'),
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(out.slice(out.indexOf('{')));
      } catch {
        parsed = null;
      }
      resolve({ parsed, ms: Date.now() - started, raw: out.slice(0, 300) });
    });
  });
}

const checks = [];

async function main() {
  console.log('[test/wake-page.mjs] 1. Starting local wake pages...');
  const wakeOnly = await startServer((req, res) => send(res, WAKE_ZH));
  const shellOnly = await startServer((req, res) => send(res, SHELL));
  let firstRequestAt = null;
  const eventuallyReady = await startServer((req, res) => {
    if (!firstRequestAt) firstRequestAt = Date.now();
    send(res, Date.now() - firstRequestAt < 8000 ? WAKE_ZH : READY);
  });

  try {
    console.log('[test/wake-page.mjs] 2. Chinese wake page must not be reported ready...');
    const wake = await probe(wakeOnly.port, ['--wake-wait-sec=5', '--wake-extension-sec=0']);
    assert.equal(wake.parsed?.ok, false, `wake page was reported ready: ${wake.raw}`);
    assert.match(String(wake.parsed?.reason), /not-ready:正在唤醒/, `unexpected reason: ${wake.raw}`);
    checks.push('chinese-wake-page-detected');

    console.log('[test/wake-page.mjs] 3. Wake extension must outlast wakeWaitSec...');
    const extended = await probe(wakeOnly.port, ['--wake-wait-sec=5', '--wake-extension-sec=8']);
    assert.equal(extended.parsed?.ok, false, `wake page was reported ready: ${extended.raw}`);
    assert.ok(
      extended.ms > wake.ms + 4_000,
      `extension did not stretch the wait (${wake.ms}ms -> ${extended.ms}ms)`,
    );
    checks.push('wake-extension-applied');

    console.log('[test/wake-page.mjs] 4. Slow cold start succeeds only with extension...');
    firstRequestAt = null;
    const noExt = await probe(eventuallyReady.port, ['--wake-wait-sec=5', '--wake-extension-sec=0']);
    assert.equal(noExt.parsed?.ok, false, `expected timeout without extension: ${noExt.raw}`);
    firstRequestAt = null;
    const withExt = await probe(eventuallyReady.port, ['--wake-wait-sec=5', '--wake-extension-sec=20']);
    assert.equal(withExt.parsed?.ok, true, `expected ready with extension: ${withExt.raw}`);
    assert.equal(withExt.parsed?.reason, 'ready');
    checks.push('cold-start-waits-for-extension');

    console.log('[test/wake-page.mjs] 5. Thin shell needs min-ready-text-length...');
    const shellDefault = await probe(shellOnly.port, ['--wake-wait-sec=5', '--wake-extension-sec=0']);
    assert.equal(shellDefault.parsed?.ok, true, `thin shell should pass the default rule: ${shellDefault.raw}`);
    const shellGuarded = await probe(shellOnly.port, [
      '--wake-wait-sec=5',
      '--wake-extension-sec=0',
      '--min-ready-text-length=200',
    ]);
    assert.equal(shellGuarded.parsed?.ok, false, `expected page-too-short: ${shellGuarded.raw}`);
    assert.equal(shellGuarded.parsed?.reason, 'page-too-short');
    checks.push('min-ready-text-length-guards-shell');
  } finally {
    wakeOnly.server.close();
    shellOnly.server.close();
    eventuallyReady.server.close();
  }

  console.log(`[test/wake-page.mjs] All wake-page checks passed: ${JSON.stringify(checks)}`);
}

main().catch((error) => {
  console.error(`[test/wake-page.mjs] FAILED: ${error.message}`);
  process.exit(1);
});
