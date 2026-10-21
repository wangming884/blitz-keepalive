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

const WAKE_ZH = `<!doctype html><html><head><meta charset="utf-8"><title>Opencode正在觉醒</title></head>
<body><h1>Opencode正在觉醒</h1>
<p>有人已经很久没用这个应用了，所以它一直在休眠。现在开始了，需要比平时更长时间。当应用准备好时，该页面会自动打开。</p>
<p>唤醒它 启动应用 连接地址</p>
<p>等待 34 秒。你什么都不用做。</p>
<p>比平时花的时间更长。</p></body></html>`;
const WAKE_EN = `<!doctype html><html><head><meta charset="utf-8"><title>Outlook is waking up</title></head>
<body><h1>Outlook is waking up</h1>
<p>Nobody has used this app for a while, so it was asleep. It is starting now and needs a little longer than usual. This page opens the app by itself when it is ready.</p>
<ul><li>Waking it up</li><li>Starting the app</li><li>Connecting the address</li></ul>
<p>Waiting 0 s. You do not need to do anything.</p>
<p>Probably about 34 s more, going by earlier starts.</p>
<p>This app runs on blitz.cloud.</p></body></html>`;

const READY = `<!doctype html><html><head><meta charset="utf-8"><title>opencode2api · Operations Handbook</title></head>
<body><h1>Operations Handbook</h1><p>${'真实内容填充。'.repeat(60)}</p></body></html>`;
const SHELL = `<!doctype html><html><head><meta charset="utf-8"><title>opencode2api · Operations Handbook</title></head>
<body><div id="root"></div><p>Loading</p></body></html>`;

// 真实的 blitz.cloud 中文唤醒页：显示倒计时，并在就绪后由页面自己跳转。
// 页面每 4 秒被 reload 一次的话，这个计时器永远走不到 10 秒。
const countdownPage = () => `<!doctype html><html><head><meta charset="utf-8"><title>Opencode正在觉醒</title></head>
<body><h1>Opencode正在觉醒</h1>
<p>有人已经很久没用这个应用了，所以它一直在休眠。该页面会自动打开。</p>
<p>等待 <span id="n">10</span> 秒。你什么都不用做。</p>
<script>
  let n = 10;
  setInterval(function () { n = Math.max(0, n - 1); document.getElementById('n').textContent = String(n); }, 1000);
  setTimeout(function () { location.href = '/ready'; }, 10000);
</script></body></html>`;

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

  // 倒计时唤醒页：/ready 之前一直返回带计时器的唤醒页
  const countdown = await startServer((req, res) => {
    if (req.url === '/ready') return send(res, READY);
    send(res, countdownPage());
  });

  // 英文唤醒页：10 秒后才真正就绪
  let enStartAt = null;
  const english = await startServer((req, res) => {
    if (!enStartAt) enStartAt = Date.now();
    send(res, Date.now() - enStartAt < 10000 ? WAKE_EN : READY);
  });

  // 骨架页：只渲染出平台品牌，6 秒后正文才到
  const SHELL_ONLY =
    '<!doctype html><html><head><meta charset="utf-8"><title>blitz.cloud</title></head><body>blitz.cloud</body></html>';
  let shellStartAt = null;
  const shellWake = await startServer((req, res) => {
    if (!shellStartAt) shellStartAt = Date.now();
    send(res, Date.now() - shellStartAt < 6000 ? SHELL_ONLY : READY);
  });

  try {
    console.log('[test/wake-page.mjs] 2. Chinese wake page must not be reported ready...');
    const wake = await probe(wakeOnly.port, ['--wake-wait-sec=5', '--wake-extension-sec=0']);
    assert.equal(wake.parsed?.ok, false, `wake page was reported ready: ${wake.raw}`);
    assert.match(String(wake.parsed?.reason), /not-ready:正在觉醒/, `unexpected reason: ${wake.raw}`);
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

    console.log('[test/wake-page.mjs] 6. Countdown wake page must not be reloaded away...');
    const counted = await probe(countdown.port, [
      '--wake-wait-sec=5',
      '--wake-extension-sec=20',
    ]);
    assert.equal(
      counted.parsed?.ok,
      true,
      `倒计时唤醒页被刷新打断，永远等不到就绪: ${counted.raw}`,
    );
    checks.push('countdown-not-interrupted');

    console.log('[test/wake-page.mjs] 7. English wake page is waited out...');
    const en = await probe(english.port, ['--wake-wait-sec=5', '--wake-extension-sec=20']);
    assert.equal(en.parsed?.ok, true, `英文唤醒页没有被等待: ${en.raw}`);
    assert.equal(en.parsed?.reason, 'ready');
    checks.push('english-wake-waited');

    console.log('[test/wake-page.mjs] 8. Bare shell counts as waking, not ready...');
    const shell = await probe(shellWake.port, ['--wake-wait-sec=5', '--wake-extension-sec=20']);
    assert.equal(shell.parsed?.ok, true, `骨架页没有被继续等待: ${shell.raw}`);
    assert.equal(shell.parsed?.reason, 'ready');
    checks.push('bare-shell-waited');
  } finally {
    wakeOnly.server.close();
    shellOnly.server.close();
    eventuallyReady.server.close();
    countdown.server.close();
    english.server.close();
    shellWake.server.close();
  }

  console.log(`[test/wake-page.mjs] All wake-page checks passed: ${JSON.stringify(checks)}`);
}

main().catch((error) => {
  console.error(`[test/wake-page.mjs] FAILED: ${error.message}`);
  process.exit(1);
});
