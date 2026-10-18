import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSWORD = 'test-password-4f6c1d';
const NEW_PASSWORD = 'new-test-password-8a3b2c';
const TARGET_PASSWORD = 'target-site-password-7c2e9b';
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
  const { child, output } = entry;
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  try {
    await waitForExit(child, 8_000);
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
  assert.equal(result.data.authenticated, true);
  const setCookie = result.response.headers.get('set-cookie');
  assert.ok(setCookie, 'login response must set a session cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.doesNotMatch(setCookie, /;\s*Secure/i);
  return sessionCookie(result.response);
}

async function waitForOverview(baseUrl, cookie, predicate, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const result = await request(baseUrl, '/api/overview', { cookie });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    last = result.data;
    if (predicate(last)) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for overview condition; last=${JSON.stringify(last)}`);
}

async function waitForLogEvent(file, eventName, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.event === eventName) return entry;
        } catch (error) {
          lastError = error;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for log event ${eventName} in ${file}: ${lastError?.message ?? 'event not found'}`,
  );
}
async function startManagementInstance(tempDir, label, extraEnv = {}) {
  const port = await getFreePort();
  const directory = path.join(tempDir, label);
  await mkdir(directory, { recursive: true });
  const baseUrl = `http://127.0.0.1:${port}`;
  const entry = startProcess(
    'keepalive.mjs',
    [
      `--port=${port}`,
      '--bind-host=127.0.0.1',
      `--managed-targets-file=${path.join(directory, 'managed-targets.json')}`,
      `--admin-password-file=${path.join(directory, 'admin-auth.json')}`,
      `--target-secret-key-file=${path.join(directory, 'target-secrets.key')}`,
      `--log-dir=${path.join(directory, 'logs')}`,
      `--lock-file=${path.join(directory, 'keepalive.lock')}`,
      '--interval-min=1',
      '--jitter-min=0',
      '--max-concurrent=1',
      '--timeout-sec=15',
      '--wake-wait-sec=5',
      '--settle-sec=0',
      '--retries=0',
      '--dump-failures=false',
      '--headless=true',
    ],
    {
      ADMIN_PASSWORD: PASSWORD,
      TARGET_URL_ALLOWLIST: '127.0.0.1',
      TARGET_URL_ALLOW_PRIVATE: 'true',
      ...extraEnv,
    },
  );
  try {
    await waitForHttp(`${baseUrl}/healthz`, [200], 15_000);
    return { entry, label, baseUrl };
  } catch (error) {
    await stopProcess(entry, label).catch(() => {});
    throw new Error(
      `${label} failed to start: ${error.message}\nstdout:\n${entry.output.stdout}\nstderr:\n${entry.output.stderr}`,
    );
  }
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'blitz-keepalive-smoke-'));
  const managedTargetsFile = path.join(tempDir, 'managed-targets.json');
  const adminPasswordFile = path.join(tempDir, 'admin-auth.json');
  const targetSecretKeyFile = path.join(tempDir, 'target-secrets.key');
  const logDir = path.join(tempDir, 'logs');
  const lockFile = path.join(tempDir, 'keepalive.lock');
  const fakePort = await getFreePort();
  const appPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const fakeUrl = `http://127.0.0.1:${fakePort}/`;
  // Regression coverage: legacy target environment variables must not create
  // targets or require a config file. The management console is the source.
  const legacyTargetEnv = {
    ['BLITZ' + '_URL']: fakeUrl,
    ['CONFIG' + '_FILE']: path.join(tempDir, 'legacy-targets.json'),
  };
  let fake = null;
  let keepalive = null;
  const isolatedInstances = [];

  try {
    fake = startProcess('test/fake-blitz.mjs', [String(fakePort)], {
      WAKE_DELAY_MS: '100',
      SLEEP_AFTER_MS: '60000',
      APP_PASSWORD: TARGET_PASSWORD,
    });
    await waitForHttp(fakeUrl, [503], 5_000);

    const noPasswordPort = await getFreePort();
    const noPassword = startProcess('keepalive.mjs', [
      `--port=${noPasswordPort}`,
      `--managed-targets-file=${path.join(tempDir, 'unused.json')}`,
      `--admin-password-file=${path.join(tempDir, 'missing-admin-auth.json')}`,
      `--log-dir=${path.join(tempDir, 'unused-logs')}`,
      `--lock-file=${path.join(tempDir, 'unused.lock')}`,
    ]);
    const noPasswordExit = await waitForExit(noPassword.child, 15_000);
    assert.equal(noPasswordExit, 2, noPassword.output.stderr);
    assert.match(noPassword.output.stderr, /ADMIN_PASSWORD/);

    const keepaliveArgs = [
      `--port=${appPort}`,
      `--managed-targets-file=${managedTargetsFile}`,
      `--admin-password-file=${adminPasswordFile}`,
      `--target-secret-key-file=${targetSecretKeyFile}`,
      `--log-dir=${logDir}`,
      `--lock-file=${lockFile}`,
      '--interval-min=1',
      '--jitter-min=0',
      '--max-concurrent=1',
      '--timeout-sec=15',
      '--wake-wait-sec=5',
      '--settle-sec=0',
      '--retries=0',
      '--dump-failures=false',
      '--headless=true',
    ];
    keepalive = startProcess('keepalive.mjs', keepaliveArgs, {
      ADMIN_PASSWORD: PASSWORD,
      TARGET_URL_ALLOWLIST: '127.0.0.1',
      TARGET_URL_ALLOW_PRIVATE: 'true',
      ...legacyTargetEnv,
    });
    await waitForHttp(`${baseUrl}/healthz`, [200], 15_000);

    const adminPage = await fetch(`${baseUrl}/admin`);
    assert.equal(adminPage.status, 200);
    const adminHtml = await adminPage.text();
    assert.match(adminHtml, /登录管理控制台/);
    assert.match(adminHtml, /安全设置/);
    assert.match(adminHtml, /修改管理密码/);
    assert.match(adminHtml, /业务就绪/);
    assert.equal((await fetch(`${baseUrl}/assets/app.js`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/assets/styles.css`)).status, 200);

    const browserRoot = await fetch(`${baseUrl}/`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    assert.equal(browserRoot.status, 200);
    assert.match(browserRoot.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await browserRoot.text(), /登录管理控制台/);

    const scriptRoot = await fetch(`${baseUrl}/`, {
      headers: { accept: 'application/json' },
    });
    assert.equal(scriptRoot.status, 200);
    assert.match(scriptRoot.headers.get('content-type') ?? '', /application\/json/);

    const anonymous = await request(baseUrl, '/api/overview');
    assert.equal(anonymous.response.status, 401);
    const queryTokenIgnored = await request(baseUrl, '/api/overview?token=legacy-token');
    assert.equal(queryTokenIgnored.response.status, 401);

    const anonymousPasswordChange = await request(baseUrl, '/api/password', {
      method: 'PUT',
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert.equal(anonymousPasswordChange.response.status, 401);

    const anonymousSession = await request(baseUrl, '/api/session');
    assert.equal(anonymousSession.response.status, 200);
    assert.equal(anonymousSession.data.authenticated, false);
    assert.equal(anonymousSession.data.authRequired, true);
    assert.equal(anonymousSession.data.passwordConfigured, true);
    assert.equal(anonymousSession.data.passwordFileExists, false);
    assert.equal(anonymousSession.data.passwordChangeAvailable, true);

    const wrongPassword = await request(baseUrl, '/api/login', {
      method: 'POST',
      body: { password: 'wrong-password' },
    });
    assert.equal(wrongPassword.response.status, 401);

    let cookie = await login(baseUrl);
    const authenticatedSession = await request(baseUrl, '/api/session', { cookie });
    assert.equal(authenticatedSession.data.authenticated, true);
    assert.equal(authenticatedSession.data.via, 'session');

    const secondCookie = await login(baseUrl);

    const wrongCurrentPassword = await request(baseUrl, '/api/password', {
      method: 'PUT',
      cookie,
      body: { currentPassword: 'wrong-current-password', newPassword: NEW_PASSWORD },
    });
    assert.equal(wrongCurrentPassword.response.status, 403);

    const weakPassword = await request(baseUrl, '/api/password', {
      method: 'PUT',
      cookie,
      body: { currentPassword: PASSWORD, newPassword: 'too-short' },
    });
    assert.equal(weakPassword.response.status, 400);

    const changedPassword = await request(baseUrl, '/api/password', {
      method: 'PUT',
      cookie,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert.equal(changedPassword.response.status, 200, JSON.stringify(changedPassword.data));
    assert.equal(changedPassword.data.authenticated, true);
    assert.equal(changedPassword.data.passwordFileExists, true);
    assert.equal(changedPassword.data.passwordChangeAvailable, true);
    const changedCookie = sessionCookie(changedPassword.response);
    const passwordChangedLog = await waitForLogEvent(
      path.join(logDir, 'keepalive.log'),
      'password-changed',
    );
    assert.equal(passwordChangedLog.client, '127.0.0.1');
    assert.equal(passwordChangedLog.via, 'session');

    const invalidatedCookie = await request(baseUrl, '/api/overview', { cookie });
    assert.equal(invalidatedCookie.response.status, 401);
    const invalidatedSecondCookie = await request(baseUrl, '/api/overview', {
      cookie: secondCookie,
    });
    assert.equal(invalidatedSecondCookie.response.status, 401);
    const changedSessionOverview = await request(baseUrl, '/api/overview', {
      cookie: changedCookie,
    });
    assert.equal(changedSessionOverview.response.status, 200);
    assert.equal(changedSessionOverview.data.config.bindHost, '127.0.0.1');
    assert.equal(changedSessionOverview.data.config.requireHttps, false);
    assert.equal(changedSessionOverview.data.targets.length, 0);
    assert.equal(changedSessionOverview.data.summary.totalTargets, 0);

    const passwordFileText = await readFile(adminPasswordFile, 'utf8');
    assert.equal(JSON.parse(passwordFileText).algorithm, 'scrypt');
    assert.equal(passwordFileText.includes(PASSWORD), false);
    assert.equal(passwordFileText.includes(NEW_PASSWORD), false);

    const oldPasswordLogin = await request(baseUrl, '/api/login', {
      method: 'POST',
      body: { password: PASSWORD },
    });
    assert.equal(oldPasswordLogin.response.status, 401);
    cookie = await login(baseUrl, NEW_PASSWORD);

    const created = await request(baseUrl, '/api/targets', {
      method: 'POST',
      cookie,
      body: {
        url: fakeUrl,
        intervalMin: 1,
        jitterMin: 0,
        expect: 'Demo app is online',
        loginPassword: TARGET_PASSWORD,
      },
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.target.loginPasswordConfigured, true);
    assert.equal(created.text.includes(TARGET_PASSWORD), false);
    assert.equal(created.text.includes('loginPasswordEnc'), false);
    const targetId = created.data.target.id;

    const firstVisit = await waitForOverview(
      baseUrl,
      cookie,
      (overview) =>
        overview.targets.some(
          (target) => target.id === targetId && target.lastVisit?.ok === true,
        ),
    );
    const firstTarget = firstVisit.targets.find((target) => target.id === targetId);
    assert.equal(firstTarget.loginPasswordConfigured, true);
    assert.equal(firstTarget.lastVisit.loginPasswordFieldFound, true);
    assert.equal(firstTarget.lastVisit.loginAttempted, true);
    assert.equal(firstTarget.lastVisit.loginSubmitted, true);
    const firstVisitAt = firstTarget.lastVisit.at;
    const firstVisitCount = firstVisit.status.visits;

    const manualRun = await request(baseUrl, `/api/run?target=${encodeURIComponent(targetId)}`, {
      method: 'POST',
      cookie,
    });
    assert.equal(manualRun.response.status, 202, JSON.stringify(manualRun.data));
    await waitForOverview(
      baseUrl,
      cookie,
      (overview) => {
        const target = overview.targets.find((item) => item.id === targetId);
        return (
          target?.lastVisit?.at !== firstVisitAt &&
          overview.status.visits > firstVisitCount &&
          !target.running &&
          !target.locked
        );
      },
    );

    const paused = await request(baseUrl, `/api/targets/${encodeURIComponent(targetId)}/pause`, {
      method: 'POST',
      cookie,
    });
    assert.equal(paused.response.status, 200, JSON.stringify(paused.data));
    assert.equal(paused.data.target.paused, true);

    const pausedManualRun = await request(
      baseUrl,
      `/api/run?target=${encodeURIComponent(targetId)}`,
      { method: 'POST', cookie },
    );
    assert.equal(pausedManualRun.response.status, 409, JSON.stringify(pausedManualRun.data));

    const resumed = await request(baseUrl, `/api/targets/${encodeURIComponent(targetId)}/resume`, {
      method: 'POST',
      cookie,
    });
    assert.equal(resumed.response.status, 200, JSON.stringify(resumed.data));
    assert.equal(resumed.data.target.paused, false);

    const exported = await request(baseUrl, '/api/targets/export', { cookie });
    assert.equal(exported.response.status, 200, JSON.stringify(exported.data));
    assert.match(
      exported.response.headers.get('content-disposition') ?? '',
      /attachment; filename="blitz-keepalive-targets-/,
    );
    assert.equal(exported.data.version, 1);
    assert.equal(exported.data.targets.length, 1);
    assert.equal(exported.text.includes(TARGET_PASSWORD), false);
    assert.equal(exported.text.includes('loginPassword'), false);
    assert.equal(exported.text.includes('loginPasswordEnc'), false);

    const persistedBeforeFailedImport = await readFile(managedTargetsFile, 'utf8');
    const sensitiveImport = await request(baseUrl, '/api/targets/import', {
      method: 'POST',
      cookie,
      body: {
        version: 1,
        targets: [
          {
            id: 'sensitive-import',
            url: fakeUrl,
            expect: 'Demo app is online',
            loginPassword: TARGET_PASSWORD,
          },
        ],
      },
    });
    assert.equal(sensitiveImport.response.status, 400, JSON.stringify(sensitiveImport.data));
    assert.equal(await readFile(managedTargetsFile, 'utf8'), persistedBeforeFailedImport);

    const tooManyTargets = await request(baseUrl, '/api/targets/import', {
      method: 'POST',
      cookie,
      body: {
        version: 1,
        targets: Array.from({ length: 101 }, (_, index) => ({
          id: `bulk-${index}`,
          url: fakeUrl,
          expect: 'Demo app is online',
        })),
      },
    });
    assert.equal(tooManyTargets.response.status, 409, JSON.stringify(tooManyTargets.data));
    assert.equal(await readFile(managedTargetsFile, 'utf8'), persistedBeforeFailedImport);

    const importPayload = structuredClone(exported.data);
    importPayload.targets[0].intervalMin = 2;
    const imported = await request(baseUrl, '/api/targets/import', {
      method: 'POST',
      cookie,
      body: importPayload,
    });
    assert.equal(imported.response.status, 200, JSON.stringify(imported.data));
    assert.equal(imported.data.imported, 1);
    const importedPersisted = JSON.parse(await readFile(managedTargetsFile, 'utf8'));
    assert.equal(importedPersisted.targets.length, 1);
    assert.equal(importedPersisted.targets[0].id, targetId);
    assert.equal(importedPersisted.targets[0].intervalMin, 2);
    assert.equal(importedPersisted.targets[0].loginPasswordEnc.algorithm, 'aes-256-gcm');

    const patched = await request(baseUrl, `/api/targets/${encodeURIComponent(targetId)}`, {
      method: 'PATCH',
      cookie,
      body: { intervalMin: 2, expect: 'Demo app is online' },
    });
    assert.equal(patched.response.status, 200, JSON.stringify(patched.data));
    assert.equal(patched.data.target.intervalMin, 2);
    assert.equal(patched.data.target.loginPasswordConfigured, true);

    const persistedText = await readFile(managedTargetsFile, 'utf8');
    const persisted = JSON.parse(persistedText);
    assert.equal(persisted.targets.length, 1);
    assert.equal(persisted.targets[0].id, targetId);
    assert.equal(persisted.targets[0].intervalMin, 2);
    assert.equal(persistedText.includes(TARGET_PASSWORD), false);
    assert.equal(persisted.targets[0].loginPasswordEnc.algorithm, 'aes-256-gcm');

    const secretKeyText = await readFile(targetSecretKeyFile, 'utf8');
    const secretKeyRecord = JSON.parse(secretKeyText);
    assert.equal(secretKeyRecord.version, 1);
    assert.equal(secretKeyRecord.algorithm, 'aes-256-gcm');
    assert.equal(Buffer.from(secretKeyRecord.key, 'base64').length, 32);
    assert.equal(secretKeyText.includes(TARGET_PASSWORD), false);

    const keepaliveLogText = await readFile(path.join(logDir, 'keepalive.log'), 'utf8');
    for (const secret of [PASSWORD, NEW_PASSWORD, TARGET_PASSWORD]) {
      assert.equal(keepaliveLogText.includes(secret), false);
    }

    await stopProcess(keepalive, 'keepalive');
    keepalive = null;

    keepalive = startProcess('keepalive.mjs', keepaliveArgs, {
      ADMIN_PASSWORD: PASSWORD,
      TARGET_URL_ALLOWLIST: '127.0.0.1',
      TARGET_URL_ALLOW_PRIVATE: 'true',
      ...legacyTargetEnv,
    });
    await waitForHttp(`${baseUrl}/healthz`, [200], 15_000);
    cookie = await login(baseUrl, NEW_PASSWORD);
    const restored = await request(baseUrl, '/api/overview', { cookie });
    assert.equal(restored.response.status, 200);
    const restoredTarget = restored.data.targets.find((target) => target.id === targetId);
    assert.ok(restoredTarget, 'managed target must survive a process restart');
    assert.equal(restoredTarget.intervalMin, 2);
    assert.equal(restoredTarget.loginPasswordConfigured, true);

    await waitForOverview(
      baseUrl,
      cookie,
      (overview) => {
        const target = overview.targets.find((item) => item.id === targetId);
        return (
          target?.lastVisit?.ok === true &&
          target.lastVisit.loginAttempted === true &&
          target.lastVisit.loginSubmitted === true &&
          !target.running &&
          !target.locked &&
          !target.schedulerQueued
        );
      },
    );

    const conflictingPasswordUpdate = await request(
      baseUrl,
      `/api/targets/${encodeURIComponent(targetId)}`,
      {
        method: 'PATCH',
        cookie,
        body: { loginPassword: 'replacement-password', clearLoginPassword: true },
      },
    );
    assert.equal(conflictingPasswordUpdate.response.status, 400);

    const cleared = await request(baseUrl, `/api/targets/${encodeURIComponent(targetId)}`, {
      method: 'PATCH',
      cookie,
      body: { clearLoginPassword: true },
    });
    assert.equal(cleared.response.status, 200, JSON.stringify(cleared.data));
    assert.equal(cleared.data.target.loginPasswordConfigured, false);

    const clearedPersistedText = await readFile(managedTargetsFile, 'utf8');
    const clearedPersisted = JSON.parse(clearedPersistedText);
    assert.equal(Object.hasOwn(clearedPersisted.targets[0], 'loginPasswordEnc'), false);
    assert.equal(clearedPersistedText.includes(TARGET_PASSWORD), false);

    const removed = await request(baseUrl, `/api/targets/${encodeURIComponent(targetId)}`, {
      method: 'DELETE',
      cookie,
    });
    assert.equal(removed.response.status, 200, JSON.stringify(removed.data));

    const emptyPersisted = JSON.parse(await readFile(managedTargetsFile, 'utf8'));
    assert.deepEqual(emptyPersisted.targets, []);

    const loggedOut = await request(baseUrl, '/api/logout', { method: 'POST', cookie });
    assert.equal(loggedOut.response.status, 200);
    const oldSession = await request(baseUrl, '/api/overview', { cookie });
    assert.equal(oldSession.response.status, 401);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failed = await request(baseUrl, '/api/login', {
        method: 'POST',
        body: { password: `wrong-${attempt}` },
      });
      assert.equal(failed.response.status, attempt < 5 ? 401 : 429);
    }
    const locked = await request(baseUrl, '/api/login', {
      method: 'POST',
      body: { password: NEW_PASSWORD },
    });
    assert.equal(locked.response.status, 429);
    assert.ok(Number(locked.data.retryAfterSec) > 0);
    const rateLimitLog = await waitForLogEvent(
      path.join(logDir, 'keepalive.log'),
      'login-rate-limited',
    );
    assert.equal(rateLimitLog.client, '127.0.0.1');
    assert.ok(Number(rateLimitLog.retryAfterSec) > 0);

    const readOnlyToken = 'readonly-test-token-9d2c';
    const tokenInstance = await startManagementInstance(tempDir, 'status-token', {
      STATUS_TOKEN: readOnlyToken,
    });
    isolatedInstances.push(tokenInstance);
    const tokenHeaders = { 'x-status-token': readOnlyToken };
    const tokenOverview = await request(tokenInstance.baseUrl, '/api/overview', {
      headers: tokenHeaders,
    });
    assert.equal(tokenOverview.response.status, 200, JSON.stringify(tokenOverview.data));
    const tokenSession = await request(tokenInstance.baseUrl, '/api/session', {
      headers: tokenHeaders,
    });
    assert.equal(tokenSession.response.status, 200);
    assert.equal(tokenSession.data.authenticated, false);
    assert.equal(tokenSession.data.readAuthorized, true);
    assert.equal(tokenSession.data.via, 'token');
    const tokenWrite = await request(tokenInstance.baseUrl, '/api/targets', {
      method: 'POST',
      headers: tokenHeaders,
      body: { url: fakeUrl, intervalMin: 1 },
    });
    assert.equal(tokenWrite.response.status, 401, JSON.stringify(tokenWrite.data));
    const tokenLogin = await request(tokenInstance.baseUrl, '/api/login', {
      method: 'POST',
      headers: { authorization: `Bearer ${readOnlyToken}` },
      body: { password: 'wrong-password' },
    });
    assert.equal(tokenLogin.response.status, 401, JSON.stringify(tokenLogin.data));

    const httpsInstance = await startManagementInstance(tempDir, 'https-required', {
      REQUIRE_HTTPS: 'true',
    });
    isolatedInstances.push(httpsInstance);
    const httpsHealth = await fetch(`${httpsInstance.baseUrl}/healthz`);
    assert.equal(httpsHealth.status, 200);
    const httpsAdmin = await fetch(`${httpsInstance.baseUrl}/admin`);
    assert.equal(httpsAdmin.status, 426);
    const httpsOverview = await request(httpsInstance.baseUrl, '/api/overview');
    assert.equal(httpsOverview.response.status, 426);

    const privateInstance = await startManagementInstance(tempDir, 'private-url', {
      TARGET_URL_ALLOWLIST: '127.0.0.1',
      TARGET_URL_ALLOW_PRIVATE: 'false',
    });
    isolatedInstances.push(privateInstance);
    const privateCookie = await login(privateInstance.baseUrl);
    const privateCreate = await request(privateInstance.baseUrl, '/api/targets', {
      method: 'POST',
      cookie: privateCookie,
      body: { url: fakeUrl, intervalMin: 1 },
    });
    assert.equal(privateCreate.response.status, 400, JSON.stringify(privateCreate.data));
    assert.match(privateCreate.data.error ?? '', /私网|本机/);

    const allowlistInstance = await startManagementInstance(tempDir, 'allowlist-url', {
      TARGET_URL_ALLOWLIST: 'example.blitz.cloud',
      TARGET_URL_ALLOW_PRIVATE: 'true',
    });
    isolatedInstances.push(allowlistInstance);
    const allowlistCookie = await login(allowlistInstance.baseUrl);
    const allowlistCreate = await request(allowlistInstance.baseUrl, '/api/targets', {
      method: 'POST',
      cookie: allowlistCookie,
      body: { url: fakeUrl, intervalMin: 1 },
    });
    assert.equal(allowlistCreate.response.status, 400, JSON.stringify(allowlistCreate.data));
    assert.match(allowlistCreate.data.error ?? '', /允许列表/);

    console.log(
      JSON.stringify({
        ok: true,
        checks: [
          'port-without-password-rejected',
          'admin-assets-served',
          'admin-readiness-card',
          'anonymous-api-rejected',
          'password-login-and-session',
          'password-change-validation-and-persistence',
          'password-change-audit-context',
          'password-change-invalidates-old-sessions',
          'password-change-rotates-login-secret',
          'restart-uses-persisted-password',
          'legacy-target-env-ignored-and-zero-target-start',
          'managed-target-create',
          'target-login-password-encrypted-at-rest',
          'target-login-password-not-exposed',
          'scheduled-browser-visit',
          'target-login-auto-filled-and-submitted',
          'manual-run',
          'target-pause-resume-and-paused-run-rejected',
          'target-export-has-no-secret-material',
          'target-import-atomicity-and-sensitive-field-rejection',
          'target-import-limit',
          'target-import-preserves-same-id-password-ciphertext',
          'managed-target-update-and-persistence',
          'restart-restores-target',
          'restart-restores-target-login-password',
          'target-login-password-conflict-rejected',
          'target-login-password-clear',
          'managed-target-delete',
          'logout-invalidates-session',
          'login-rate-limit',
          'login-rate-limit-audit-context',
          'sensitive-values-not-logged',
          'status-token-is-read-only',
          'https-required-healthz-exemption',
          'target-url-private-address-rejected',
          'target-url-allowlist-rejected',
        ],
      }),
    );
  } finally {
    if (keepalive) await stopProcess(keepalive, 'keepalive').catch(() => {});
    for (const instance of isolatedInstances) {
      await stopProcess(instance.entry, instance.label).catch(() => {});
    }
    if (fake) await stopProcess(fake, 'fake-blitz').catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
