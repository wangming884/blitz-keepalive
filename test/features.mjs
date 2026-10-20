/**
 * Regression coverage for the observability and operator features added on top
 * of the original scheduler: daily statistics, webhook alerts, the public
 * status page, the probe endpoint and bulk pause/resume.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createStatsStore } from '../stats.mjs';
import { createNotifier } from '../notify.mjs';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'features-admin-password-7c31';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
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

function waitForExit(child, timeoutMs = 10_000) {
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
    await waitForExit(entry.child, 3_000).catch(() => {});
    throw new Error(
      `${label} could not be stopped.\nstdout:\n${entry.output.stdout}\nstderr:\n${entry.output.stderr}`,
    );
  }
}

async function waitForHttp(url, statuses, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (statuses.includes(response.status)) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message}`);
}

async function request(baseUrl, pathname, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { response, data, text };
}

function sessionCookie(response) {
  const header = response.headers.get('set-cookie') ?? '';
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

async function getOverview(baseUrl, cookie) {
  const result = await request(baseUrl, '/api/overview', { cookie });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return result.data;
}

async function waitForTarget(baseUrl, cookie, id, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const overview = await getOverview(baseUrl, cookie);
    last = overview.targets.find((target) => target.id === id) ?? null;
    if (last && predicate(last, overview)) return { target: last, overview };
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
      settleSec: 0,
      retries: 0,
      scheduleEnabled: false,
      ...overrides,
    },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  return result.data.target;
}

async function runStatsUnitTests(tempDir) {
  console.log('[test/features.mjs] 1. Running stats store unit tests...');
  const file = path.join(tempDir, 'stats-unit.json');
  const log = async () => {};
  const cfg = { statsFile: file, once: false, scheduleTimeZone: 'UTC' };
  const store = createStatsStore(cfg, log);
  await store.load();
  store.recordVisit({ ok: true, ms: 1200, at: new Date('2026-10-18T10:00:00.000Z') });
  store.recordVisit({ ok: false, ms: 800, at: new Date('2026-10-18T11:00:00.000Z') });
  store.recordVisit({ ok: true, ms: 400, at: new Date('2026-10-19T09:00:00.000Z') });

  const snapshot = store.snapshot(7, new Date('2026-10-19T12:00:00.000Z'));
  assert.equal(snapshot.today.date, '2026-10-19');
  assert.equal(snapshot.today.visits, 1);
  assert.equal(snapshot.today.ok, 1);
  assert.equal(snapshot.last7Days.length, 7);
  assert.equal(snapshot.totals.visits, 3);
  assert.equal(snapshot.totals.ok, 2);
  assert.equal(snapshot.totals.failed, 1);
  assert.equal(snapshot.totals.avgMs, 800);

  await store.flushNow();
  const reloaded = createStatsStore(cfg, log);
  await reloaded.load();
  const afterReload = reloaded.snapshot(7, new Date('2026-10-19T12:00:00.000Z'));
  assert.equal(afterReload.totals.visits, 3);

  await writeFile(file, JSON.stringify({ version: 99, days: {} }), 'utf8');
  await assert.rejects(() => reloaded.load(), /not supported/);

  // Day buckets follow the configured timezone, not UTC: 07:00 in Shanghai is
  // still "today" for the operator even though UTC is on the previous day.
  const localFile = path.join(tempDir, 'stats-local-day.json');
  const localStore = createStatsStore(
    { statsFile: localFile, once: false, scheduleTimeZone: 'Asia/Shanghai' },
    log,
  );
  localStore.recordVisit({ ok: true, ms: 1000, at: new Date('2026-10-20T07:00:00+08:00') });
  const localSnapshot = localStore.snapshot(7, new Date('2026-10-20T07:30:00+08:00'));
  assert.equal(localSnapshot.today.date, '2026-10-20');
  assert.equal(localSnapshot.today.visits, 1);
  // Same instant counted in UTC lands on the previous day.
  const utcStore = createStatsStore(
    { statsFile: path.join(tempDir, 'stats-utc-day.json'), once: false, scheduleTimeZone: 'UTC' },
    log,
  );
  utcStore.recordVisit({ ok: true, ms: 1000, at: new Date('2026-10-20T07:00:00+08:00') });
  const utcSnapshot = utcStore.snapshot(7, new Date('2026-10-20T07:30:00+08:00'));
  assert.equal(utcSnapshot.today.date, '2026-10-19');

  // A corrupt file must not poison the store: after a failed load it is empty
  // and the next flush rewrites valid JSON (main() only warns).
  const corruptFile = path.join(tempDir, 'stats-corrupt.json');
  await writeFile(corruptFile, '{ not json', 'utf8');
  const corruptStore = createStatsStore(
    { statsFile: corruptFile, once: false, scheduleTimeZone: 'UTC' },
    log,
  );
  await assert.rejects(() => corruptStore.load(), /not valid JSON/);
  corruptStore.recordVisit({ ok: true, ms: 10, at: new Date('2026-10-19T12:00:00.000Z') });
  await corruptStore.flushNow();
  const rewritten = JSON.parse(await readFile(corruptFile, 'utf8'));
  assert.equal(rewritten.version, 1);
  assert.equal(rewritten.days['2026-10-19'].visits, 1);

  console.log('[test/features.mjs] Stats store unit tests passed.');
}

async function runNotifierUnitTests() {
  console.log('[test/features.mjs] 2. Running webhook notifier unit tests...');
  const received = [];
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push({ raw: body });
      }
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const logs = [];
  const notifier = createNotifier(
    {
      webhookUrl: `http://127.0.0.1:${port}/hook`,
      webhookTimeoutMs: 2_000,
      webhookMinIntervalMs: 60_000,
    },
    async (entry) => logs.push(entry),
  );
  assert.equal(notifier.enabled, true);
  notifier.notify('target:a', { event: 'target-failure', target: 'a' });
  notifier.notify('target:a', { event: 'target-failure', target: 'a' });
  notifier.notify('readiness', { event: 'readiness-not-ready' });

  await waitFor(() => received.length >= 2, 'webhook deliveries');
  await sleep(150);
  assert.equal(received.length, 2, 'the same alert key must be silenced inside the window');
  assert.equal(received[0].service, 'blitz-keepalive');
  assert.ok(received.some((payload) => payload.event === 'target-failure'));
  assert.ok(logs.some((entry) => entry.event === 'webhook-sent'));

  // Silence-window bookkeeping must stay bounded: alert keys embed target ids,
  // so a long-lived process that churns targets would otherwise grow the map
  // forever.
  for (let index = 0; index < 520; index += 1) {
    notifier.notify(`target:churn-${index}:failed`, {
      event: 'target-failure',
      target: `churn-${index}`,
    });
  }
  assert.ok(
    notifier.trackedKeys <= 500,
    `silence windows must stay bounded, got ${notifier.trackedKeys}`,
  );

  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));

  const failingLogs = [];
  const broken = createNotifier(
    { webhookUrl: 'http://127.0.0.1:1/hook', webhookTimeoutMs: 500, webhookMinIntervalMs: 0 },
    async (entry) => failingLogs.push(entry),
  );
  broken.notify('k', { event: 'target-failure' });
  await waitFor(
    () => failingLogs.some((entry) => entry.event === 'webhook-failed'),
    'webhook failure log',
  );

  const disabled = createNotifier({ webhookUrl: '' }, async () => {});
  assert.equal(disabled.enabled, false);
  disabled.notify('k', { event: 'ignored' });

  console.log('[test/features.mjs] Webhook notifier unit tests passed.');
}

async function runIntegrationTests(tempDir) {
  console.log('[test/features.mjs] 3. Running status/probe/bulk/webhook integration tests...');
  const appPort = await getFreePort();
  const fakePort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const fakeUrl = `http://127.0.0.1:${fakePort}/`;
  const processes = [];
  const webhookPayloads = [];
  const webhookServer = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        webhookPayloads.push(JSON.parse(body));
      } catch {
        webhookPayloads.push({ raw: body });
      }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve) => webhookServer.listen(0, '127.0.0.1', resolve));
  const webhookPort = webhookServer.address().port;

  try {
    const fake = startProcess('test/fake-blitz.mjs', [String(fakePort)], {
      WAKE_DELAY_MS: '0',
      SLEEP_AFTER_MS: '60000',
    });
    processes.push({ label: 'fake-blitz', entry: fake });
    await waitForHttp(fakeUrl, [503], 5_000);

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
        '--interval-min=28',
        '--jitter-min=0',
        '--max-concurrent=1',
        '--timeout-sec=15',
        '--wake-wait-sec=5',
        '--settle-sec=0',
        '--retries=0',
        '--dump-failures=false',
        '--headless=true',
        '--schedule-timezone=UTC',
        `--webhook-url=http://127.0.0.1:${webhookPort}/hook`,
        '--webhook-min-interval-sec=0',
        '--webhook-failure-threshold=1',
        '--public-status=true',
      ],
      {
        ADMIN_PASSWORD: PASSWORD,
        TARGET_URL_ALLOWLIST: '127.0.0.1',
        TARGET_URL_ALLOW_PRIVATE: 'true',
      },
    );
    processes.push({ label: 'keepalive', entry: keepalive });
    await waitForHttp(`${baseUrl}/healthz`, [200], 20_000);
    const cookie = await login(baseUrl);

    // Static status page is always served; its API is anonymous here because
    // PUBLIC_STATUS=true.
    const statusPage = await request(baseUrl, '/status');
    assert.equal(statusPage.response.status, 200);
    assert.match(statusPage.text, /只读状态页/);

    const publicEmpty = await request(baseUrl, '/api/public-status');
    assert.equal(publicEmpty.response.status, 200, JSON.stringify(publicEmpty.data));
    assert.equal(publicEmpty.data.summary.totalTargets, 0);

    // A target whose expect text never matches: used for the webhook alert.
    await createTarget(baseUrl, cookie, 'probe-fail', fakeUrl, {
      expect: 'NEVER_MATCHES_THIS_TEXT',
    });
    // A healthy target without expect text.
    await createTarget(baseUrl, cookie, 'probe-ok', fakeUrl, {
      account: 'alice@example.com',
    });

    const failed = await waitForTarget(
      baseUrl,
      cookie,
      'probe-fail',
      (target) => target.consecutiveFailures >= 1 && target.lastVisit && !target.running,
    );
    assert.equal(failed.target.lastResult, 'failed');
    assert.ok(
      ['expect-text-missing', 'not-ready-timeout'].includes(failed.target.lastVisit.reason),
      `unexpected failure reason: ${failed.target.lastVisit.reason}`,
    );

    await waitFor(
      () => webhookPayloads.some((payload) => payload.event === 'target-failure'),
      'target-failure webhook',
      10_000,
    );
    const failureAlert = webhookPayloads.find((payload) => payload.event === 'target-failure');
    assert.equal(failureAlert.target, 'probe-fail');
    assert.equal(failureAlert.service, 'blitz-keepalive');
    assert.ok(!('url' in failureAlert), 'webhook payloads must not leak target URLs');

    // Public status exposes health only - never URLs, proxies or secrets.
    const publicStatus = await request(baseUrl, '/api/public-status');
    assert.equal(publicStatus.response.status, 200, JSON.stringify(publicStatus.data));
    assert.equal(publicStatus.data.summary.totalTargets, 2);
    for (const target of publicStatus.data.targets) {
      assert.ok(!('url' in target), 'public status must not expose target URLs');
      assert.ok(!('proxy' in target), 'public status must not expose proxy configuration');
      assert.ok(
        !String(target.account ?? '').includes('alice@'),
        'public status must mask account identifiers',
      );
    }
    const maskedAccount = publicStatus.data.targets.find((target) => target.id === 'probe-ok');
    assert.equal(maskedAccount.account, 'a***@example.com');
    assert.equal(publicStatus.data.targets.length, 2);
    assert.ok(publicStatus.data.stats, 'public status must include daily statistics');

    // Both targets must be idle before probing or bulk operations.
    await waitForTarget(
      baseUrl,
      cookie,
      'probe-ok',
      (target) => !target.running && !target.schedulerQueued && Boolean(target.lastVisit),
    );
    await waitForTarget(
      baseUrl,
      cookie,
      'probe-fail',
      (target) => !target.running && !target.schedulerQueued && Boolean(target.lastVisit),
    );

    // Probe endpoint: healthy target succeeds, failing target reports why.
    const probeOk = await request(baseUrl, '/api/targets/probe-ok/probe', {
      method: 'POST',
      cookie,
    });
    assert.equal(probeOk.response.status, 200, JSON.stringify(probeOk.data));
    assert.equal(probeOk.data.probe.ok, true, JSON.stringify(probeOk.data.probe));
    assert.equal(probeOk.data.probe.httpStatus, 200);
    assert.ok(probeOk.data.probe.ms >= 0);

    const probeFail = await request(baseUrl, '/api/targets/probe-fail/probe', {
      method: 'POST',
      cookie,
    });
    assert.equal(probeFail.response.status, 200, JSON.stringify(probeFail.data));
    assert.equal(probeFail.data.probe.ok, false);
    assert.ok(
      ['expect-text-missing', 'not-ready-timeout'].includes(probeFail.data.probe.reason),
      `unexpected probe reason: ${probeFail.data.probe.reason}`,
    );
    assert.equal(probeFail.data.probe.expectTextFound, false);

    // Probe must not leak the proxy password and must require admin auth.
    const anonymousProbe = await request(baseUrl, '/api/targets/probe-ok/probe', {
      method: 'POST',
    });
    assert.equal(anonymousProbe.response.status, 401);

    // Bulk pause/resume.
    const pauseAll = await request(baseUrl, '/api/targets/pause-all', {
      method: 'POST',
      cookie,
    });
    assert.equal(pauseAll.response.status, 200, JSON.stringify(pauseAll.data));
    assert.deepEqual([...pauseAll.data.paused].sort(), ['probe-fail', 'probe-ok']);
    const pausedOverview = await getOverview(baseUrl, cookie);
    assert.equal(
      pausedOverview.targets.filter((target) => target.paused).length,
      2,
      'pause-all must persist both targets',
    );

    const resumeAll = await request(baseUrl, '/api/targets/resume-all', {
      method: 'POST',
      cookie,
    });
    assert.equal(resumeAll.response.status, 200, JSON.stringify(resumeAll.data));
    assert.deepEqual([...resumeAll.data.resumed].sort(), ['probe-fail', 'probe-ok']);

    // Statistics are recorded for both the failed and the successful visit.
    const withStats = await waitForTarget(
      baseUrl,
      cookie,
      'probe-ok',
      (target, overview) =>
        !target.paused &&
        target.lastResult === 'ok' &&
        Number(overview.stats?.totals?.visits ?? 0) >= 2,
      60_000,
    );
    assert.ok(withStats.overview.stats.today.visits >= 2);
    assert.ok(withStats.overview.stats.totals.failed >= 1);

    const statsFile = JSON.parse(
      await readFile(path.join(tempDir, 'stats.json'), 'utf8').catch(() => '{"days":{}}'),
    );
    assert.ok(statsFile.version === 1);

    // Prometheus output includes the new histogram and keep-open gauge.
    const metrics = await request(baseUrl, '/metrics', { cookie });
    assert.equal(metrics.response.status, 200);
    assert.match(metrics.text, /blitz_keepalive_visit_duration_seconds_bucket\{target="probe-ok"/);
    assert.match(metrics.text, /blitz_keepalive_visit_duration_seconds_count\{target="probe-ok"\} \d+/);
    assert.match(metrics.text, /blitz_keepalive_keep_open_sessions \d+/);
    assert.match(metrics.text, /blitz_keepalive_visits_total \d+/);
    // Scheduler health: a frozen loop keeps /healthz green, so these two gauges
    // are the only signal that visits stopped happening.
    assert.match(metrics.text, /blitz_keepalive_scheduler_loop_age_seconds \d+/);
    assert.match(metrics.text, /blitz_keepalive_scheduler_lag_seconds \d+/);
    assert.match(
      metrics.text,
      /blitz_keepalive_target_last_success_age_seconds\{target="probe-ok"\} -?\d+/,
    );

    // Invalid resource filter is rejected at startup.
    const bad = startProcess('keepalive.mjs', [
      '--probe=http://127.0.0.1:1/',
      '--block-resources=bogus',
    ], {
      TARGET_URL_ALLOWLIST: '127.0.0.1',
      TARGET_URL_ALLOW_PRIVATE: 'true',
    });
    const badExit = await waitForExit(bad.child, 15_000);
    assert.equal(badExit, 2, bad.output.stderr);
    assert.match(bad.output.stderr, /BLOCK_RESOURCES/);

    console.log('[test/features.mjs] Status/probe/bulk/webhook integration tests passed.');
  } finally {
    for (const { label, entry } of processes.reverse()) {
      await stopProcess(entry, label).catch(() => {});
    }
    webhookServer.closeAllConnections?.();
    await new Promise((resolve) => webhookServer.close(resolve));
  }
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'blitz-keepalive-features-'));
  try {
    await runStatsUnitTests(tempDir);
    await runNotifierUnitTests();
    await runIntegrationTests(tempDir);
    console.log('[test/features.mjs] All feature tests passed.');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
