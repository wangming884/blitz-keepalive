import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'readiness-admin-password-2f9a';
const TARGET_PASSWORD = 'readiness-target-password-7d4c';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function startProcess(script, args, env = {}) {
  const output = { stdout: '', stderr: '' };
  const child = spawn(process.execPath, [script, ...args], {
    cwd: APP_DIR,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output.stdout = `${output.stdout}${chunk}`.slice(-20_000);
  });
  child.stderr.on('data', (chunk) => {
    output.stderr = `${output.stderr}${chunk}`.slice(-20_000);
  });
  return { child, output };
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code) => {
      cleanup();
      resolve(code);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

async function stopProcess(entry, label) {
  if (!entry || entry.child.exitCode !== null) return;
  entry.child.kill('SIGTERM');
  try {
    await waitForExit(entry.child, 8_000);
  } catch {
    entry.child.kill('SIGKILL');
    try {
      await waitForExit(entry.child, 3_000);
    } catch {
      throw new Error(
        `${label} could not be stopped.\nstdout:\n${entry.output.stdout}\nstderr:\n${entry.output.stderr}`,
      );
    }
  }
}

async function waitForHttp(url, expectedStatuses, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (expectedStatuses.includes(response.status)) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message ?? 'unknown error'}`);
}

async function request(
  baseUrl,
  route,
  { method = 'GET', cookie, body, headers: extraHeaders = {} } = {},
) {
  const headers = { accept: 'application/json', ...extraHeaders };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetch(new URL(route, baseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
  }
  return { response, data, text };
}

function sessionCookie(response) {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'login response must set a session cookie');
  return header.split(';', 1)[0];
}

async function login(baseUrl) {
  const result = await request(baseUrl, '/api/login', {
    method: 'POST',
    body: { password: PASSWORD },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return sessionCookie(result.response);
}

async function getTarget(baseUrl, cookie, id) {
  const result = await request(baseUrl, '/api/overview', { cookie });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return result.data.targets.find((target) => target.id === id) ?? null;
}

async function waitForTarget(baseUrl, cookie, id, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await getTarget(baseUrl, cookie, id);
    if (last && predicate(last)) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for target ${id}; last=${JSON.stringify(last)}`);
}

async function createTarget(baseUrl, cookie, id, url, overrides = {}) {
  const result = await request(baseUrl, '/api/targets', {
    method: 'POST',
    cookie,
    body: {
      id,
      url,
      intervalMin: 28,
      jitterMin: 0,
      expect: '',
      timeoutSec: 15,
      wakeWaitSec: 5,
      wakeExtensionSec: 0,
      settleSec: 0,
      retries: 0,
      scheduleEnabled: false,
      ...overrides,
    },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  return result.data.target;
}

async function runTargetAndWaitForFailures(baseUrl, cookie, id, expectedFailures, reason) {
  const before = await waitForTarget(
    baseUrl,
    cookie,
    id,
    (target) => !target.running && !target.schedulerQueued && target.lastVisit,
  );
  const run = await request(baseUrl, `/api/run?target=${encodeURIComponent(id)}`, {
    method: 'POST',
    cookie,
  });
  assert.equal(run.response.status, 202, JSON.stringify(run.data));
  return waitForTarget(
    baseUrl,
    cookie,
    id,
    (target) =>
      !target.running &&
      !target.schedulerQueued &&
      target.consecutiveFailures === expectedFailures &&
      target.lastVisit?.reason === reason,
  );
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'blitz-keepalive-readiness-'));
  const appPort = await getFreePort();
  const fakePort = await getFreePort();
  const loginFakePort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const fakeUrl = `http://127.0.0.1:${fakePort}/`;
  const loginFakeUrl = `http://127.0.0.1:${loginFakePort}/`;
  const processes = [];

  try {
    const fake = startProcess('test/fake-blitz.mjs', [String(fakePort)], {
      WAKE_DELAY_MS: '0',
      SLEEP_AFTER_MS: '60000',
    });
    processes.push({ label: 'fake-blitz', entry: fake });
    await waitForHttp(fakeUrl, [503], 5_000);

    const loginFake = startProcess('test/fake-blitz.mjs', [String(loginFakePort)], {
      WAKE_DELAY_MS: '0',
      SLEEP_AFTER_MS: '60000',
      APP_PASSWORD: TARGET_PASSWORD,
      LOGIN_REDIRECT_STATUS: '503',
    });
    processes.push({ label: 'fake-blitz-login', entry: loginFake });
    await waitForHttp(loginFakeUrl, [503], 5_000);

    const keepalive = startProcess(
      'keepalive.mjs',
      [
        `--port=${appPort}`,
        '--bind-host=127.0.0.1',
        `--managed-targets-file=${path.join(tempDir, 'managed-targets.json')}`,
        `--admin-password-file=${path.join(tempDir, 'admin-auth.json')}`,
        `--target-secret-key-file=${path.join(tempDir, 'target-secrets.key')}`,
        `--runtime-state-file=${path.join(tempDir, 'runtime-state.json')}`,
        `--stats-file=${path.join(tempDir, 'stats.json')}`,
        `--log-dir=${path.join(tempDir, 'logs')}`,
        `--lock-file=${path.join(tempDir, 'keepalive.lock')}`,
        '--interval-min=1',
        '--jitter-min=0',
        '--max-concurrent=1',
        '--timeout-sec=15',
        '--wake-wait-sec=5',
        '--wake-extension-sec=0',
        '--settle-sec=0',
        '--retries=0',
        '--dump-failures=false',
        '--headless=true',
        '--schedule-timezone=UTC',
      ],
      {
        ADMIN_PASSWORD: PASSWORD,
        TARGET_URL_ALLOWLIST: '127.0.0.1',
        TARGET_URL_ALLOW_PRIVATE: 'true',
      },
    );
    processes.push({ label: 'keepalive', entry: keepalive });
    await waitForHttp(`${baseUrl}/healthz`, [200], 15_000);
    const cookie = await login(baseUrl);

    const utcDay = new Date().getUTCDay();
    const currentScheduleDay = utcDay === 0 ? 7 : utcDay;
    const offScheduleDay = currentScheduleDay === 7 ? 1 : currentScheduleDay + 1;
    await createTarget(baseUrl, cookie, 'scheduled-off', fakeUrl, {
      scheduleEnabled: true,
      scheduleStart: '00:00',
      scheduleEnd: '23:59',
      scheduleDays: [offScheduleDay],
    });
    await sleep(1_500);
    const scheduledOff = await waitForTarget(
      baseUrl,
      cookie,
      'scheduled-off',
      (target) => target.scheduledOff === true,
    );
    assert.equal(scheduledOff.lastVisit, null);

    const readyWhileScheduledOff = await fetch(`${baseUrl}/readyz`);
    const readyWhileScheduledOffBody = await readyWhileScheduledOff.json();
    assert.equal(readyWhileScheduledOff.status, 200, JSON.stringify(readyWhileScheduledOffBody));
    assert.equal(readyWhileScheduledOffBody.activeTargetCount, 0);
    assert.equal(readyWhileScheduledOffBody.issueCount, 0);

    for (const status of [502, 503, 504]) {
      const id = `gateway-${status}`;
      await createTarget(baseUrl, cookie, id, `${fakeUrl}?gateway=${status}`);
      const target = await waitForTarget(
        baseUrl,
        cookie,
        id,
        (item) =>
          !item.running &&
          !item.schedulerQueued &&
          item.lastVisit?.reason === `not-ready:http-${status}`,
      );
      assert.equal(target.lastVisit.ok, false);
      assert.equal(target.lastVisit.status, status);
    }

    await createTarget(baseUrl, cookie, 'error-body-503', `${fakeUrl}?errorBody=503`);
    const errorBodyTarget = await waitForTarget(
      baseUrl,
      cookie,
      'error-body-503',
      (target) =>
        !target.running &&
        !target.schedulerQueued &&
        target.lastVisit?.ok === false &&
        target.lastVisit.reason?.startsWith('not-ready:'),
    );
    assert.equal(errorBodyTarget.lastVisit.status, 200);
    assert.match(errorBodyTarget.lastVisit.reason, /503/i);

    await createTarget(baseUrl, cookie, 'gateway-503-once', `${fakeUrl}?gateway=503-once`, {
      expect: 'Demo app is online',
      wakeWaitSec: 12,
    });
    const reloadedTarget = await waitForTarget(
      baseUrl,
      cookie,
      'gateway-503-once',
      (target) => !target.running && !target.schedulerQueued && target.lastVisit?.ok === true,
    );
    assert.equal(reloadedTarget.lastVisit.status, 200);
    assert.equal(reloadedTarget.lastVisit.reason, 'ready');

    await createTarget(baseUrl, cookie, 'login-redirect-503', loginFakeUrl, {
      loginPassword: TARGET_PASSWORD,
      expect: 'Demo app is online',
      timeoutSec: 15,
      wakeWaitSec: 5,
      wakeExtensionSec: 0,
    });
    const loginRedirectTarget = await waitForTarget(
      baseUrl,
      cookie,
      'login-redirect-503',
      (target) =>
        !target.running &&
        !target.schedulerQueued &&
        target.lastVisit?.reason === 'not-ready:http-503',
    );
    assert.equal(loginRedirectTarget.lastVisit.status, 503);
    assert.equal(loginRedirectTarget.lastVisit.loginAttempted, true);
    assert.equal(loginRedirectTarget.lastVisit.loginSubmitted, true);

    const gateway503 = await waitForTarget(
      baseUrl,
      cookie,
      'gateway-503',
      (target) => target.consecutiveFailures >= 1 && !target.running && !target.schedulerQueued,
    );
    assert.equal(gateway503.consecutiveFailures, 1);
    await runTargetAndWaitForFailures(baseUrl, cookie, 'gateway-503', 2, 'not-ready:http-503');
    await runTargetAndWaitForFailures(baseUrl, cookie, 'gateway-503', 3, 'not-ready:http-503');

    const notReady = await fetch(`${baseUrl}/readyz`);
    const notReadyBody = await notReady.json();
    assert.equal(notReady.status, 503, JSON.stringify(notReadyBody));
    const failingIssue = notReadyBody.issues.find((issue) => issue.id === 'gateway-503');
    assert.ok(failingIssue, JSON.stringify(notReadyBody));
    assert.ok(failingIssue.reasons.includes('consecutive-failures'), JSON.stringify(failingIssue));
    assert.equal(
      notReadyBody.issues.some((issue) => issue.id === 'scheduled-off'),
      false,
      JSON.stringify(notReadyBody),
    );

    console.log('[test/readiness.mjs] Production readiness integration checks passed.');
  } finally {
    for (const { label, entry } of processes.reverse()) {
      await stopProcess(entry, label).catch((error) => {
        console.error(error.message);
      });
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
