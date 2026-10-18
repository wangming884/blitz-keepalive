import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  decryptFile,
  encryptFile,
  inspectBackupHeader,
} from '../deploy/backup-crypto.mjs';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'hardening-password-7f3a9c';
const STATUS_TOKEN = 'hardening-status-token-4d2e8b';
const PASSPHRASE = 'hardening-backup-passphrase-9c4f';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
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
    output.stdout = `${output.stdout}${chunk}`.slice(-30_000);
  });
  child.stderr.on('data', (chunk) => {
    output.stderr = `${output.stderr}${chunk}`.slice(-30_000);
  });
  return { child, output };
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs = 5_000) {
  if (hasExited(child)) return Promise.resolve(child.exitCode);
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

async function stopProcess(entry, label, timeoutMs = 10_000) {
  const { child, output } = entry;
  if (hasExited(child)) return 0;
  const startedAt = Date.now();
  child.kill('SIGTERM');
  try {
    await waitForExit(child, timeoutMs);
  } catch {
    child.kill('SIGKILL');
    try {
      await waitForExit(child, 3_000);
    } catch {
      throw new Error(
        `${label} could not be stopped.\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      );
    }
  }
  return Date.now() - startedAt;
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
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message ?? 'unknown error'}`);
}

async function request(baseUrl, route, { method = 'GET', cookie, body, headers: extraHeaders = {} } = {}) {
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

async function login(baseUrl, password = PASSWORD) {
  const result = await request(baseUrl, '/api/login', {
    method: 'POST',
    body: { password },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return sessionCookie(result.response);
}

async function waitForJson(file, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${file}: ${lastError?.message ?? 'condition not met'}`);
}

function instancePaths(tempDir, label) {
  const directory = path.join(tempDir, label);
  return {
    directory,
    configFile: path.join(directory, 'targets.json'),
    managedTargetsFile: path.join(directory, 'managed-targets.json'),
    adminPasswordFile: path.join(directory, 'admin-auth.json'),
    targetSecretKeyFile: path.join(directory, 'target-secrets.key'),
    runtimeStateFile: path.join(directory, 'runtime-state.json'),
    logDir: path.join(directory, 'logs'),
    lockFile: path.join(directory, 'keepalive.lock'),
  };
}

async function startManagementInstance(
  tempDir,
  label,
  { extraArgs = [], env = {}, wait = true, includeMaxConcurrentArg = true } = {},
) {
  const paths = instancePaths(tempDir, label);
  await mkdir(paths.directory, { recursive: true });
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const entry = startProcess(
    'keepalive.mjs',
    [
      `--port=${port}`,
      '--bind-host=127.0.0.1',
      `--managed-targets-file=${paths.managedTargetsFile}`,
      `--admin-password-file=${paths.adminPasswordFile}`,
      `--target-secret-key-file=${paths.targetSecretKeyFile}`,
      `--runtime-state-file=${paths.runtimeStateFile}`,
      `--log-dir=${paths.logDir}`,
      `--lock-file=${paths.lockFile}`,
      '--interval-min=20',
      '--jitter-min=0',
      ...(includeMaxConcurrentArg ? ['--max-concurrent=1'] : []),
      '--timeout-sec=15',
      '--wake-wait-sec=5',
      '--settle-sec=0',
      '--retries=0',
      '--dump-failures=false',
      '--headless=true',
      ...extraArgs,
    ],
    {
      ADMIN_PASSWORD: PASSWORD,
      STATUS_TOKEN,
      TARGET_URL_ALLOWLIST: '127.0.0.1,localhost',
      TARGET_URL_ALLOW_PRIVATE: 'true',
      ...env,
    },
  );
  const instance = { entry, label, baseUrl, port, ...paths };
  if (!wait) return instance;
  try {
    await waitForHttp(`${baseUrl}/healthz`, [200], 15_000);
    return instance;
  } catch (error) {
    await stopProcess(entry, label).catch(() => {});
    throw new Error(
      `${label} failed to start: ${error.message}\nstdout:\n${entry.output.stdout}\nstderr:\n${entry.output.stderr}`,
    );
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function runOnce(args, env = {}, timeoutMs = 30_000) {
  const entry = startProcess('keepalive.mjs', args, env);
  const code = await waitForExit(entry.child, timeoutMs);
  return { ...entry, code };
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'blitz-keepalive-hardening-'));
  const instances = [];
  const checks = [];
  try {
    const invalidIntervalDir = path.join(tempDir, 'invalid-interval');
    await mkdir(invalidIntervalDir, { recursive: true });
    const invalidInterval = await runOnce([
      '--url=https://example.blitz.cloud',
      '--once',
      `--managed-targets-file=${path.join(invalidIntervalDir, 'managed.json')}`,
      `--admin-password-file=${path.join(invalidIntervalDir, 'admin.json')}`,
      `--log-dir=${path.join(invalidIntervalDir, 'logs')}`,
      `--lock-file=${path.join(invalidIntervalDir, 'lock')}`,
      '--interval-min=29',
    ]);
    assert.equal(invalidInterval.code, 2, invalidInterval.output.stderr);
    assert.match(invalidInterval.output.stderr, /intervalMin must be a number between 1 and 28/);
    checks.push('interval-29-rejected');

    const invalidWindow = await runOnce([
      '--url=https://example.blitz.cloud',
      '--once',
      `--managed-targets-file=${path.join(invalidIntervalDir, 'managed-2.json')}`,
      `--admin-password-file=${path.join(invalidIntervalDir, 'admin-2.json')}`,
      `--log-dir=${path.join(invalidIntervalDir, 'logs-2')}`,
      `--lock-file=${path.join(invalidIntervalDir, 'lock-2')}`,
      '--interval-min=20',
      '--jitter-min=10',
    ]);
    assert.equal(invalidWindow.code, 2, invalidWindow.output.stderr);
    assert.match(invalidWindow.output.stderr, /must not exceed 28/);
    checks.push('interval-jitter-sum-rejected');

    const boundary = await startManagementInstance(tempDir, 'interval-boundary', {
      extraArgs: ['--interval-min=28', '--jitter-min=0'],
      includeMaxConcurrentArg: false,
      env: { MAX_CONCURRENT: '' },
    });
    instances.push(boundary);
    const boundaryCookie = await login(boundary.baseUrl);
    const boundaryOverview = await request(boundary.baseUrl, '/api/overview', {
      cookie: boundaryCookie,
    });
    assert.equal(boundaryOverview.response.status, 200, boundaryOverview.text);
    assert.equal(boundaryOverview.data.config.maxConcurrent, 1);
    checks.push('single-browser-default');
    const emptyReadiness = await request(boundary.baseUrl, '/readyz');
    assert.equal(emptyReadiness.response.status, 200, emptyReadiness.text);
    assert.equal(emptyReadiness.data.ready, true);
    assert.equal(emptyReadiness.data.issueCount, 0);
    checks.push('readyz-zero-targets-ready');
    const boundaryElapsed = await stopProcess(boundary.entry, boundary.label);
    assert.ok(boundaryElapsed < 10_000, `boundary instance took ${boundaryElapsed}ms to stop`);
    // Windows does not deliver SIGTERM to child processes; Node terminates them
    // immediately, so graceful lock cleanup can only be asserted on POSIX.
    if (process.platform !== 'win32') {
      assert.equal(existsSync(boundary.lockFile), false);
    }
    checks.push('interval-28-boundary-accepted');
    if (process.platform !== 'win32') {
      checks.push('sigterm-shutdown-under-10s');
      assert.match(boundary.entry.output.stdout, /"event":"shutdown"/);
    }

    const persisted = instancePaths(tempDir, 'persisted-runtime');
    await mkdir(persisted.directory, { recursive: true });
    const futureDue = new Date(Date.now() + 60 * 60_000).toISOString();
    const staleSuccess = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await writeFile(
      persisted.configFile,
      `${JSON.stringify({
        targets: [
          {
            id: 'persisted-target',
            url: 'https://example.blitz.cloud',
            intervalMin: 20,
            jitterMin: 0,
            expect: '',
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      persisted.runtimeStateFile,
      `${JSON.stringify({
        version: 1,
        targets: {
          'persisted-target': {
            paused: false,
            pauseReason: null,
            pausedUntil: null,
            lastResult: null,
            lastVisit: null,
            lastSuccessfulVisitAt: staleSuccess,
            consecutiveFailures: 3,
            authFailureCount: 0,
            nextDue: futureDue,
          },
        },
      }, null, 2)}\n`,
      'utf8',
    );

    let managed = await startManagementInstance(tempDir, 'persisted-runtime', {
      extraArgs: [`--config=${persisted.configFile}`],
    });
    instances.push(managed);
    let cookie = await login(managed.baseUrl);
    let overview = await request(managed.baseUrl, '/api/overview', { cookie });
    assert.equal(overview.response.status, 200, JSON.stringify(overview.data));
    let target = overview.data.targets.find((item) => item.id === 'persisted-target');
    assert.ok(target);
    assert.equal(target.paused, false);
    assert.equal(target.nextDue, futureDue);
    assert.equal(overview.data.readiness.ready, false);
    assert.equal(overview.data.summary.notReadyTargets, 1);
    assert.equal(target.overdue, false);
    assert.ok(target.readinessIssues.includes('consecutive-failures'));
    assert.ok(target.readinessIssues.includes('stale-success'));
    checks.push('readiness-overview-fields');

    const liveness = await request(managed.baseUrl, '/healthz');
    assert.equal(liveness.response.status, 200, liveness.text);
    const notReady = await request(managed.baseUrl, '/readyz');
    assert.equal(notReady.response.status, 503, notReady.text);
    assert.equal(notReady.data.ready, false);
    assert.equal(notReady.data.status, 'not-ready');
    const notReadyTarget = notReady.data.issues.find((item) => item.id === 'persisted-target');
    assert.ok(notReadyTarget);
    assert.ok(notReadyTarget.reasons.includes('consecutive-failures'));
    assert.ok(notReadyTarget.reasons.includes('stale-success'));
    for (const secret of ['https://example.blitz.cloud', PASSWORD, STATUS_TOKEN]) {
      assert.equal(notReady.text.includes(secret), false);
    }
    checks.push('healthz-remains-live-when-not-ready');
    checks.push('readyz-reports-target-readiness-issues');
    checks.push('readyz-does-not-expose-secrets-or-target-url');

    const anonymousMetrics = await request(managed.baseUrl, '/metrics');
    assert.equal(anonymousMetrics.response.status, 401);
    const tokenMetrics = await request(managed.baseUrl, '/metrics', {
      headers: { 'x-status-token': STATUS_TOKEN },
    });
    assert.equal(tokenMetrics.response.status, 200, tokenMetrics.text);
    assert.match(tokenMetrics.response.headers.get('content-type') ?? '', /text\/plain/);
    assert.match(tokenMetrics.text, /blitz_keepalive_up 1/);
    assert.match(tokenMetrics.text, /blitz_keepalive_process_memory_bytes \d+/);
    assert.match(tokenMetrics.text, /blitz_keepalive_ready 0/);
    for (const metric of [
      'blitz_keepalive_target_last_success_timestamp_seconds',
      'blitz_keepalive_target_consecutive_failures',
      'blitz_keepalive_target_next_due_timestamp_seconds',
      'blitz_keepalive_target_paused',
      'blitz_keepalive_target_overdue',
    ]) {
      assert.match(
        tokenMetrics.text,
        new RegExp(`${metric}\\{target="persisted-target"\\} [0-9.e+-]+`),
        metric,
      );
    }
    const sessionMetrics = await request(managed.baseUrl, '/metrics', { cookie });
    assert.equal(sessionMetrics.response.status, 200, sessionMetrics.text);
    checks.push('metrics-requires-read-auth');
    checks.push('metrics-session-and-token-readable');

    const lockCompetitor = await startManagementInstance(tempDir, 'lock-competitor', {
      extraArgs: [`--lock-file=${managed.lockFile}`, `--config=${persisted.configFile}`],
      wait: false,
    });
    const competitorCode = await waitForExit(lockCompetitor.entry.child, 10_000);
    assert.equal(competitorCode, 0, lockCompetitor.entry.output.stderr);
    assert.match(lockCompetitor.entry.output.stderr, /another keep-alive instance/);
    assert.equal(existsSync(managed.lockFile), true);
    await waitForHttp(`${managed.baseUrl}/healthz`, [200], 2_000);
    checks.push('single-instance-lock-competition');

    const paused = await request(
      managed.baseUrl,
      '/api/targets/persisted-target/pause',
      { method: 'POST', cookie },
    );
    assert.equal(paused.response.status, 200, JSON.stringify(paused.data));
    assert.equal(paused.data.target.paused, true);
    const persistedPause = await waitForJson(
      persisted.runtimeStateFile,
      (state) => state.targets?.['persisted-target']?.paused === true,
    );
    assert.equal(persistedPause.targets['persisted-target'].nextDue, null);
    checks.push('pause-flushed-to-runtime-state');
    const pausedReadiness = await request(managed.baseUrl, '/readyz');
    assert.equal(pausedReadiness.response.status, 200, pausedReadiness.text);
    assert.equal(pausedReadiness.data.ready, true);
    assert.equal(pausedReadiness.data.activeTargetCount, 0);
    checks.push('readyz-all-targets-paused-ready');

    await stopProcess(managed.entry, managed.label);
    managed = await startManagementInstance(tempDir, 'persisted-runtime', {
      extraArgs: [`--config=${persisted.configFile}`],
    });
    instances.push(managed);
    cookie = await login(managed.baseUrl);
    overview = await request(managed.baseUrl, '/api/overview', { cookie });
    target = overview.data.targets.find((item) => item.id === 'persisted-target');
    assert.ok(target);
    assert.equal(target.paused, true);
    assert.equal(target.pauseReason, '手动暂停');
    assert.equal(target.nextDue, null);
    checks.push('pause-restored-after-restart');
    await stopProcess(managed.entry, managed.label);

    const runtimeVersionDir = path.join(tempDir, 'runtime-version');
    await mkdir(runtimeVersionDir, { recursive: true });
    const runtimeVersionFile = path.join(runtimeVersionDir, 'runtime-state.json');
    await writeFile(runtimeVersionFile, '{"version":99,"targets":{}}\n', 'utf8');
    const runtimeVersion = await runOnce([
      `--port=${await getFreePort()}`,
      '--bind-host=127.0.0.1',
      `--managed-targets-file=${path.join(runtimeVersionDir, 'managed.json')}`,
      `--admin-password-file=${path.join(runtimeVersionDir, 'admin.json')}`,
      `--runtime-state-file=${runtimeVersionFile}`,
      `--log-dir=${path.join(runtimeVersionDir, 'logs')}`,
      `--lock-file=${path.join(runtimeVersionDir, 'lock')}`,
    ], { ADMIN_PASSWORD: PASSWORD });
    assert.equal(runtimeVersion.code, 2, runtimeVersion.output.stderr);
    assert.match(runtimeVersion.output.stdout, /Runtime state file version 99 is not supported/);
    assert.equal(existsSync(path.join(runtimeVersionDir, 'lock')), false);
    checks.push('unsupported-runtime-state-version-rejected');

    const managedVersionDir = path.join(tempDir, 'managed-version');
    await mkdir(managedVersionDir, { recursive: true });
    const managedVersionFile = path.join(managedVersionDir, 'managed.json');
    await writeFile(managedVersionFile, '{"version":99,"targets":[]}\n', 'utf8');
    const managedVersion = await runOnce([
      `--port=${await getFreePort()}`,
      '--bind-host=127.0.0.1',
      `--managed-targets-file=${managedVersionFile}`,
      `--admin-password-file=${path.join(managedVersionDir, 'admin.json')}`,
      `--log-dir=${path.join(managedVersionDir, 'logs')}`,
      `--lock-file=${path.join(managedVersionDir, 'lock')}`,
    ], { ADMIN_PASSWORD: PASSWORD });
    assert.equal(managedVersion.code, 2, managedVersion.output.stderr);
    assert.match(managedVersion.output.stderr, /Managed targets file version 99 is not supported/);
    checks.push('unsupported-managed-targets-version-rejected');

    const backupDir = path.join(tempDir, 'backup');
    await mkdir(backupDir, { recursive: true });
    const plainFile = path.join(backupDir, 'backup.bin');
    const encryptedFile = `${plainFile}.enc`;
    const decryptedFile = path.join(backupDir, 'restored.bin');
    const source = Buffer.from('sensitive-backup-payload-0123456789', 'utf8');
    await writeFile(plainFile, source);
    await encryptFile({ inputPath: plainFile, passphrase: PASSPHRASE, removePlaintext: true });
    await assert.rejects(access(plainFile), (error) => error.code === 'ENOENT');
    const encryptedBody = await readFile(encryptedFile);
    assert.equal(encryptedBody.includes(source), false);
    assert.deepEqual(inspectBackupHeader(encryptedBody), { version: 1 });
    if (process.platform !== 'win32') {
      assert.equal((await stat(encryptedFile)).mode & 0o777, 0o600);
    }
    await decryptFile({ inputPath: encryptedFile, outputPath: decryptedFile, passphrase: PASSPHRASE });
    assert.deepEqual(await readFile(decryptedFile), source);
    checks.push('encrypted-backup-round-trip');
    checks.push('encrypted-backup-plaintext-removed');

    await assert.rejects(
      decryptFile({
        inputPath: encryptedFile,
        outputPath: path.join(backupDir, 'wrong-pass.bin'),
        passphrase: 'wrong-backup-passphrase-1234',
      }),
      /authentication failed/i,
    );
    const tamperedFile = path.join(backupDir, 'tampered.enc');
    const tampered = Buffer.from(encryptedBody);
    tampered[tampered.length - 1] ^= 0xff;
    await writeFile(tamperedFile, tampered, { mode: 0o600 });
    await assert.rejects(
      decryptFile({
        inputPath: tamperedFile,
        outputPath: path.join(backupDir, 'tampered.bin'),
        passphrase: PASSPHRASE,
      }),
      /authentication failed/i,
    );
    const unsupportedHeader = Buffer.from(encryptedBody);
    unsupportedHeader[4] = 99;
    assert.throws(() => inspectBackupHeader(unsupportedHeader), /version 99 is not supported/);
    checks.push('backup-wrong-passphrase-and-tamper-rejected');
    checks.push('backup-unsupported-version-rejected');

    let subresourceHits = 0;
    const subresource = createServer((req, res) => {
      subresourceHits += 1;
      res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'));
    });
    const subresourcePort = await getFreePort();
    await listen(subresource, subresourcePort);
    const mainPage = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(
        `<html><body><p>strict-subresource-ready</p><img src="http://127.0.0.1:${subresourcePort}/pixel.gif" alt=""></body></html>`,
      );
    });
    const mainPort = await getFreePort();
    await listen(mainPage, mainPort);
    try {
      const strictDir = path.join(tempDir, 'strict-subresources');
      await mkdir(strictDir, { recursive: true });
      const commonArgs = [
        '--once',
        `--url=http://localhost:${mainPort}/`,
        '--expect=strict-subresource-ready',
        '--interval-min=20',
        '--jitter-min=0',
        '--timeout-sec=15',
        '--wake-wait-sec=5',
        '--settle-sec=0',
        '--retries=0',
        '--dump-failures=false',
        '--headless=true',
        '--target-url-allowlist=localhost',
        `--managed-targets-file=${path.join(strictDir, 'managed.json')}`,
        `--admin-password-file=${path.join(strictDir, 'admin.json')}`,
        `--target-secret-key-file=${path.join(strictDir, 'target-secrets.key')}`,
        `--runtime-state-file=${path.join(strictDir, 'runtime-state.json')}`,
        `--log-dir=${path.join(strictDir, 'logs')}`,
        `--lock-file=${path.join(strictDir, 'lock')}`,
      ];
      const env = { TARGET_URL_ALLOW_PRIVATE: 'true' };
      subresourceHits = 0;
      const nonStrict = await runOnce([...commonArgs, '--target-url-strict-subresources=false'], env);
      assert.equal(nonStrict.code, 0, nonStrict.output.stderr);
      assert.ok(subresourceHits > 0, 'non-strict mode should load a cross-host subresource');
      subresourceHits = 0;
      const strict = await runOnce([...commonArgs, '--target-url-strict-subresources=true'], env);
      assert.equal(strict.code, 0, strict.output.stderr);
      assert.equal(subresourceHits, 0, 'strict mode must block a subresource outside the allowlist');
      checks.push('strict-subresource-allowlist-enforced');
    } finally {
      await closeServer(mainPage);
      await closeServer(subresource);
    }

    console.log(JSON.stringify({ ok: true, checks }, null, 2));
  } finally {
    for (const instance of instances) {
      await stopProcess(instance.entry, instance.label).catch(() => {});
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
