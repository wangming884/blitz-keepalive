import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADMIN_PASSWORD = 'proxy-admin-password-5b8d2e';
const PROXY_ONE_AUTH = 'proxy-one:pass-one-7c1d';
const PROXY_TWO_AUTH = 'proxy-two:pass-two-9f4a';
const PROXY_ONE_PASSWORD = PROXY_ONE_AUTH.slice(PROXY_ONE_AUTH.indexOf(':') + 1);
const PROXY_TWO_PASSWORD = PROXY_TWO_AUTH.slice(PROXY_TWO_AUTH.indexOf(':') + 1);
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
    output.stdout = `${output.stdout}${chunk}`.slice(-60_000);
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

async function stopProcess(entry, label) {
  const { child, output } = entry;
  if (hasExited(child)) return;
  child.kill('SIGTERM');
  try {
    await waitForExit(child, 10_000);
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

async function login(baseUrl) {
  const result = await request(baseUrl, '/api/login', {
    method: 'POST',
    body: { password: ADMIN_PASSWORD },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return sessionCookie(result.response);
}

async function waitForOverview(baseUrl, cookie, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const result = await request(baseUrl, '/api/overview', { cookie });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    last = result.data;
    if (predicate(last)) return result;
    await sleep(250);
  }
  throw new Error(`timed out waiting for overview condition; last=${JSON.stringify(last)}`);
}

function parseProxyEntries(entry) {
  return entry.output.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function proxiedPaths(entry) {
  return parseProxyEntries(entry)
    .filter((item) => item.proto === 'http')
    .map((item) => item.url);
}

async function waitForProcessText(entry, text, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entry.output.stdout.includes(text)) return;
    await sleep(100);
  }
  throw new Error(`${label} did not log ${text}\nstdout:\n${entry.output.stdout}\nstderr:\n${entry.output.stderr}`);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'blitz-keepalive-target-proxy-'));
  const dataDir = path.join(tempDir, 'data');
  const logDir = path.join(tempDir, 'logs');
  await mkdir(dataDir, { recursive: true });
  const managedTargetsFile = path.join(dataDir, 'managed-targets.json');
  const adminPasswordFile = path.join(dataDir, 'admin-auth.json');
  const targetSecretKeyFile = path.join(dataDir, 'target-secrets.key');
  const runtimeStateFile = path.join(dataDir, 'runtime-state.json');
  const statsFile = path.join(dataDir, 'stats.json');
  const lockFile = path.join(tempDir, 'keepalive.lock');

  const appPort = await getFreePort();
  const proxyOnePort = await getFreePort();
  const proxyTwoPort = await getFreePort();
  const proxySocksPort = await getFreePort();
  const keepalivePort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${keepalivePort}`;
  const proxyOneUrl = `http://127.0.0.1:${proxyOnePort}`;
  const proxyTwoUrl = `http://127.0.0.1:${proxyTwoPort}`;
  const proxySocksUrl = `socks5://127.0.0.1:${proxySocksPort}`;
  const targetBase = `http://127.0.0.1:${appPort}`;

  let fakeApp = null;
  let proxyOne = null;
  let proxyTwo = null;
  let proxySocks = null;
  let keepalive = null;

  const keepaliveArgs = [
    `--port=${keepalivePort}`,
    '--bind-host=127.0.0.1',
    `--managed-targets-file=${managedTargetsFile}`,
    `--admin-password-file=${adminPasswordFile}`,
    `--target-secret-key-file=${targetSecretKeyFile}`,
    `--runtime-state-file=${runtimeStateFile}`,
    `--stats-file=${statsFile}`,
    `--log-dir=${logDir}`,
    `--lock-file=${lockFile}`,
    '--interval-min=20',
    '--jitter-min=0',
    '--max-concurrent=1',
    '--timeout-sec=15',
    '--wake-wait-sec=5',
    '--settle-sec=0',
    '--retries=0',
    '--dump-failures=false',
    '--headless=true',
  ];
  const keepaliveEnv = {
    ADMIN_PASSWORD,
    TARGET_URL_ALLOWLIST: '127.0.0.1',
    TARGET_URL_ALLOW_PRIVATE: 'true',
  };

  try {
    fakeApp = startProcess('test/fake-blitz.mjs', [String(appPort)], {
      WAKE_DELAY_MS: '100',
      SLEEP_AFTER_MS: '60000',
    });
    proxyOne = startProcess('test/fake-proxy.mjs', [String(proxyOnePort)], {
      MODE: 'http',
      PROXY_AUTH: PROXY_ONE_AUTH,
    });
    proxyTwo = startProcess('test/fake-proxy.mjs', [String(proxyTwoPort)], {
      MODE: 'http',
      PROXY_AUTH: PROXY_TWO_AUTH,
    });
    proxySocks = startProcess('test/fake-proxy.mjs', [String(proxySocksPort)], {
      MODE: 'socks',
    });
    await waitForHttp(`${targetBase}/`, [503], 5_000);
    await waitForProcessText(proxyOne, '"event":"listen"', 'proxy one');
    await waitForProcessText(proxyTwo, '"event":"listen"', 'proxy two');
    await waitForProcessText(proxySocks, '"event":"listen"', 'proxy socks');

    keepalive = startProcess('keepalive.mjs', keepaliveArgs, keepaliveEnv);
    await waitForHttp(`${baseUrl}/healthz`, [200], 15_000);
    let cookie = await login(baseUrl);

    const adminPage = await fetch(`${baseUrl}/admin`);
    assert.equal(adminPage.status, 200);
    const adminHtml = await adminPage.text();
    assert.match(adminHtml, /id="target-proxy-mode"/);
    assert.match(adminHtml, /id="target-proxy-password"/);
    assert.match(adminHtml, /指定独立代理/);

    const createTarget = async (body) => {
      const result = await request(baseUrl, '/api/targets', {
        method: 'POST',
        cookie,
        body,
      });
      assert.equal(result.response.status, 201, JSON.stringify(result.data));
      for (const secret of [PROXY_ONE_PASSWORD, PROXY_TWO_PASSWORD]) {
        assert.equal(result.text.includes(secret), false);
      }
      assert.equal(result.text.includes('proxyPasswordEnc'), false);
      return result.data.target;
    };

    const customOne = await createTarget({
      id: 'custom-one',
      url: `${targetBase}/?target=custom-one`,
      intervalMin: 20,
      jitterMin: 0,
      expect: 'Demo app is online',
      proxyMode: 'custom',
      proxy: proxyOneUrl,
      proxyUsername: 'proxy-one',
      proxyPassword: PROXY_ONE_PASSWORD,
      proxyBypass: '<-loopback>',
    });
    assert.equal(customOne.proxyMode, 'custom');
    assert.equal(customOne.proxyPasswordConfigured, true);

    const customTwo = await createTarget({
      id: 'custom-two',
      url: `${targetBase}/?target=custom-two`,
      intervalMin: 20,
      jitterMin: 0,
      expect: 'Demo app is online',
      proxyMode: 'custom',
      proxy: proxyTwoUrl,
      proxyUsername: 'proxy-two',
      proxyPassword: PROXY_TWO_PASSWORD,
      proxyBypass: '<-loopback>',
    });
    assert.equal(customTwo.proxyPasswordConfigured, true);

    const customSocks = await createTarget({
      id: 'custom-socks',
      url: `${targetBase}/?target=custom-socks`,
      intervalMin: 20,
      jitterMin: 0,
      expect: 'Demo app is online',
      proxyMode: 'custom',
      proxy: proxySocksUrl,
      proxyBypass: '<-loopback>',
    });
    assert.equal(customSocks.proxyMode, 'custom');
    assert.equal(customSocks.proxyPasswordConfigured, false);

    await createTarget({
      id: 'direct-target',
      url: `${targetBase}/?target=direct`,
      intervalMin: 20,
      jitterMin: 0,
      expect: 'Demo app is online',
      proxyMode: 'direct',
    });
    await createTarget({
      id: 'inherit-target',
      url: `${targetBase}/?target=inherit`,
      intervalMin: 20,
      jitterMin: 0,
      expect: 'Demo app is online',
      proxyMode: 'inherit',
    });

    const successful = await waitForOverview(
      baseUrl,
      cookie,
      (overview) =>
        overview.targets.length === 5 &&
        overview.targets.every((target) => target.lastVisit?.ok === true),
    );
    const byId = new Map(successful.data.targets.map((target) => [target.id, target]));
    assert.equal(byId.get('custom-one').proxyMode, 'custom');
    assert.equal(byId.get('custom-one').proxy.server, proxyOneUrl);
    assert.equal(byId.get('custom-one').proxyUsername, 'proxy-one');
    assert.equal(byId.get('custom-one').proxyPasswordConfigured, true);
    assert.equal(byId.get('custom-two').proxy.server, proxyTwoUrl);
    assert.equal(byId.get('custom-two').proxyPasswordConfigured, true);
    assert.equal(byId.get('custom-socks').proxy.server, proxySocksUrl);
    assert.equal(byId.get('custom-socks').proxyPasswordConfigured, false);
    assert.equal(byId.get('direct-target').proxyMode, 'direct');
    assert.equal(byId.get('direct-target').proxy, null);
    assert.equal(byId.get('inherit-target').proxyMode, 'inherit');

    await waitForProcessText(proxyOne, 'target=custom-one', 'proxy one');
    await waitForProcessText(proxyTwo, 'target=custom-two', 'proxy two');
    await waitForProcessText(proxySocks, '"proto":"socks"', 'proxy socks');
    const proxyOnePaths = proxiedPaths(proxyOne);
    const proxyTwoPaths = proxiedPaths(proxyTwo);
    assert.ok(proxyOnePaths.some((url) => url.includes('target=custom-one')));
    assert.ok(proxyTwoPaths.some((url) => url.includes('target=custom-two')));
    assert.equal(proxyOnePaths.some((url) => url.includes('target=custom-two')), false);
    assert.equal(proxyTwoPaths.some((url) => url.includes('target=custom-one')), false);
    assert.equal(proxyOnePaths.some((url) => /target=(?:direct|inherit|custom-socks)/.test(url)), false);
    assert.equal(proxyTwoPaths.some((url) => /target=(?:direct|inherit|custom-socks)/.test(url)), false);
    assert.ok(parseProxyEntries(proxyOne).some((item) => item.proto === 'http' && item.authenticated === true));
    assert.ok(parseProxyEntries(proxyTwo).some((item) => item.proto === 'http' && item.authenticated === true));
    assert.ok(
      parseProxyEntries(proxySocks).some(
        (item) =>
          item.proto === 'socks' &&
          item.host === '127.0.0.1' &&
          item.port === appPort &&
          item.authenticated === false,
      ),
    );

    const overviewText = successful.text;
    for (const secret of [PROXY_ONE_PASSWORD, PROXY_TWO_PASSWORD]) {
      assert.equal(overviewText.includes(secret), false);
    }
    assert.equal(overviewText.includes('proxyPasswordEnc'), false);

    const persistedBeforeExport = JSON.parse(await readFile(managedTargetsFile, 'utf8'));
    const persistedOne = persistedBeforeExport.targets.find((target) => target.id === 'custom-one');
    const persistedTwo = persistedBeforeExport.targets.find((target) => target.id === 'custom-two');
    const persistedDirect = persistedBeforeExport.targets.find((target) => target.id === 'direct-target');
    const persistedInherit = persistedBeforeExport.targets.find((target) => target.id === 'inherit-target');
    assert.equal(persistedOne.proxyMode, 'custom');
    assert.equal(persistedOne.proxy, proxyOneUrl);
    assert.equal(persistedOne.proxyUsername, 'proxy-one');
    assert.equal(persistedOne.proxyBypass, '<-loopback>');
    assert.equal(persistedOne.proxyPasswordEnc.algorithm, 'aes-256-gcm');
    assert.equal(persistedTwo.proxyPasswordEnc.algorithm, 'aes-256-gcm');
    assert.equal(persistedDirect.proxyMode, 'direct');
    assert.equal(persistedDirect.proxy, '');
    assert.equal(persistedInherit.proxyMode, 'inherit');
    assert.equal(Object.hasOwn(persistedInherit, 'proxy'), false);
    const persistedText = JSON.stringify(persistedBeforeExport);
    for (const secret of [PROXY_ONE_PASSWORD, PROXY_TWO_PASSWORD]) {
      assert.equal(persistedText.includes(secret), false);
    }

    const exported = await request(baseUrl, '/api/targets/export', { cookie });
    assert.equal(exported.response.status, 200, JSON.stringify(exported.data));
    assert.equal(exported.data.targets.length, 5);
    assert.equal(exported.text.includes('proxyPassword'), false);
    assert.equal(exported.text.includes(PROXY_ONE_PASSWORD), false);
    assert.equal(exported.text.includes(PROXY_TWO_PASSWORD), false);
    const exportedOne = exported.data.targets.find((target) => target.id === 'custom-one');
    assert.equal(exportedOne.proxyMode, 'custom');
    assert.equal(exportedOne.proxy, proxyOneUrl);
    assert.equal(exportedOne.proxyUsername, 'proxy-one');

    const persistedBeforeRejectedImport = await readFile(managedTargetsFile, 'utf8');
    const rejectedImport = await request(baseUrl, '/api/targets/import', {
      method: 'POST',
      cookie,
      body: {
        version: 1,
        targets: [
          {
            id: 'custom-one',
            url: `${targetBase}/?target=custom-one`,
            proxyMode: 'custom',
            proxy: proxyOneUrl,
            proxyUsername: 'proxy-one',
            proxyPassword: PROXY_ONE_PASSWORD,
          },
        ],
      },
    });
    assert.equal(rejectedImport.response.status, 400, JSON.stringify(rejectedImport.data));
    assert.equal(await readFile(managedTargetsFile, 'utf8'), persistedBeforeRejectedImport);

    const imported = await request(baseUrl, '/api/targets/import', {
      method: 'POST',
      cookie,
      body: exported.data,
    });
    assert.equal(imported.response.status, 200, JSON.stringify(imported.data));
    assert.equal(imported.data.imported, 5);
    const persistedAfterImport = JSON.parse(await readFile(managedTargetsFile, 'utf8'));
    const importedOne = persistedAfterImport.targets.find((target) => target.id === 'custom-one');
    const importedTwo = persistedAfterImport.targets.find((target) => target.id === 'custom-two');
    assert.deepEqual(importedOne.proxyPasswordEnc, persistedOne.proxyPasswordEnc);
    assert.deepEqual(importedTwo.proxyPasswordEnc, persistedTwo.proxyPasswordEnc);

    const patchedInterval = await request(baseUrl, '/api/targets/custom-one', {
      method: 'PATCH',
      cookie,
      body: { intervalMin: 2 },
    });
    assert.equal(patchedInterval.response.status, 200, JSON.stringify(patchedInterval.data));
    assert.equal(patchedInterval.data.target.proxyPasswordConfigured, true);
    let persistedAfterPatch = JSON.parse(await readFile(managedTargetsFile, 'utf8'));
    let patchedOne = persistedAfterPatch.targets.find((target) => target.id === 'custom-one');
    assert.deepEqual(patchedOne.proxyPasswordEnc, persistedOne.proxyPasswordEnc);

    const changedServer = await request(baseUrl, '/api/targets/custom-one', {
      method: 'PATCH',
      cookie,
      body: {
        proxyMode: 'custom',
        proxy: proxyTwoUrl,
        proxyUsername: 'proxy-one',
        proxyBypass: '<-loopback>',
      },
    });
    assert.equal(changedServer.response.status, 200, JSON.stringify(changedServer.data));
    assert.equal(changedServer.data.target.proxyPasswordConfigured, false);
    persistedAfterPatch = JSON.parse(await readFile(managedTargetsFile, 'utf8'));
    patchedOne = persistedAfterPatch.targets.find((target) => target.id === 'custom-one');
    assert.equal(Object.hasOwn(patchedOne, 'proxyPasswordEnc'), false);

    const changedUsername = await request(baseUrl, '/api/targets/custom-one', {
      method: 'PATCH',
      cookie,
      body: {
        proxyMode: 'custom',
        proxy: proxyOneUrl,
        proxyUsername: 'proxy-one-changed',
        proxyBypass: '<-loopback>',
      },
    });
    assert.equal(changedUsername.response.status, 200, JSON.stringify(changedUsername.data));
    assert.equal(changedUsername.data.target.proxyPasswordConfigured, false);

    const restoredProxyPassword = await request(baseUrl, '/api/targets/custom-one', {
      method: 'PATCH',
      cookie,
      body: {
        proxyMode: 'custom',
        proxy: proxyOneUrl,
        proxyUsername: 'proxy-one',
        proxyPassword: PROXY_ONE_PASSWORD,
        proxyBypass: '<-loopback>',
      },
    });
    assert.equal(restoredProxyPassword.response.status, 200, JSON.stringify(restoredProxyPassword.data));
    assert.equal(restoredProxyPassword.data.target.proxyPasswordConfigured, true);
    assert.equal(restoredProxyPassword.text.includes(PROXY_ONE_PASSWORD), false);
    assert.equal(restoredProxyPassword.text.includes('proxyPasswordEnc'), false);

    const clearedProxyPassword = await request(baseUrl, '/api/targets/custom-one', {
      method: 'PATCH',
      cookie,
      body: { clearProxyPassword: true },
    });
    assert.equal(clearedProxyPassword.response.status, 200, JSON.stringify(clearedProxyPassword.data));
    assert.equal(clearedProxyPassword.data.target.proxyPasswordConfigured, false);
    persistedAfterPatch = JSON.parse(await readFile(managedTargetsFile, 'utf8'));
    patchedOne = persistedAfterPatch.targets.find((target) => target.id === 'custom-one');
    assert.equal(Object.hasOwn(patchedOne, 'proxyPasswordEnc'), false);

    const resetProxyPassword = await request(baseUrl, '/api/targets/custom-one', {
      method: 'PATCH',
      cookie,
      body: {
        proxyMode: 'custom',
        proxy: proxyOneUrl,
        proxyUsername: 'proxy-one',
        proxyPassword: PROXY_ONE_PASSWORD,
        proxyBypass: '<-loopback>',
      },
    });
    assert.equal(resetProxyPassword.response.status, 200, JSON.stringify(resetProxyPassword.data));
    assert.equal(resetProxyPassword.data.target.proxyPasswordConfigured, true);

    const logText = await readFile(path.join(logDir, 'keepalive.log'), 'utf8');
    for (const secret of [ADMIN_PASSWORD, PROXY_ONE_PASSWORD, PROXY_TWO_PASSWORD]) {
      assert.equal(logText.includes(secret), false);
    }

    await stopProcess(keepalive, 'keepalive');
    keepalive = null;
    keepalive = startProcess('keepalive.mjs', keepaliveArgs, keepaliveEnv);
    await waitForHttp(`${baseUrl}/healthz`, [200], 15_000);
    cookie = await login(baseUrl);
    const restored = await request(baseUrl, '/api/overview', { cookie });
    assert.equal(restored.response.status, 200, JSON.stringify(restored.data));
    const restoredById = new Map(restored.data.targets.map((target) => [target.id, target]));
    assert.equal(restoredById.get('custom-one').proxy.server, proxyOneUrl);
    assert.equal(restoredById.get('custom-one').proxyUsername, 'proxy-one');
    assert.equal(restoredById.get('custom-one').proxyPasswordConfigured, true);
    assert.equal(restoredById.get('custom-two').proxyPasswordConfigured, true);

    const beforeRestartVisit = restoredById.get('custom-one').lastVisit?.at ?? null;
    const manualRun = await request(baseUrl, '/api/run?target=custom-one', {
      method: 'POST',
      cookie,
    });
    assert.equal(manualRun.response.status, 202, JSON.stringify(manualRun.data));
    await waitForOverview(
      baseUrl,
      cookie,
      (overview) => {
        const target = overview.targets.find((item) => item.id === 'custom-one');
        return target?.lastVisit?.ok === true && target.lastVisit.at !== beforeRestartVisit;
      },
    );

    console.log(
      JSON.stringify({
        ok: true,
        checks: [
          'admin-proxy-fields-present',
          'two-targets-use-different-authenticated-proxies',
          'socks5-target-proxy',
          'direct-and-inherit-targets-bypass-proxies',
          'proxy-password-encrypted-at-rest',
          'proxy-password-hidden-from-api-export-and-logs',
          'sensitive-proxy-import-rejected-atomically',
          'import-preserves-proxy-password-ciphertext',
          'edit-preserves-or-invalidates-proxy-password-correctly',
          'clear-and-reset-proxy-password',
          'restart-restores-proxy-configuration-and-password',
        ],
      }),
    );
  } finally {
    if (keepalive) await stopProcess(keepalive, 'keepalive').catch(() => {});
    if (fakeApp) await stopProcess(fakeApp, 'fake-app').catch(() => {});
    if (proxyOne) await stopProcess(proxyOne, 'proxy-one').catch(() => {});
    if (proxyTwo) await stopProcess(proxyTwo, 'proxy-two').catch(() => {});
    if (proxySocks) await stopProcess(proxySocks, 'proxy-socks').catch(() => {});
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
