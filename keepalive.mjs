#!/usr/bin/env node
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  DEFAULT_SCHEDULE_START,
  DEFAULT_SCHEDULE_END,
  DEFAULT_SCHEDULE_DAYS,
  DEFAULT_FIRST_VISIT_WAKE_WAIT_SEC,
  DEFAULT_FIRST_VISIT_TIMEOUT_SEC,
  DEFAULT_FIRST_VISIT_RETRIES,
  isValidTimeZone,
  assertValidTimeZone,
  normalizeScheduleFields,
  getScheduleState,
  getNextWindowStart,
  MAX_VISIT_WINDOW_MIN,
  scheduleNext as scheduleNextPure,
} from './schedule.mjs';
import {
  DEFAULT_NOT_READY_PATTERNS,
  classify,
  targetReadinessIssues,
} from './page-state.mjs';
import {
  KeepOpenCapacityError,
  createKeepOpenManager,
  normalizeKeepOpenFields,
} from './keepopen.mjs';
import {
  DEFAULT_TARGET_URL_ALLOWLIST,
  TargetUrlError,
  isTrustedProxyAddress,
  normalizeIpAddress,
  parseTargetUrlAllowlist,
  parseTrustedProxyCidrs,
  validateTargetUrl,
  resolveTargetUrl,
  buildResolverRules,
} from './urlguard.mjs';
import { createNotifier } from './notify.mjs';
import { createStatsStore } from './stats.mjs';
import { writeJsonFileAtomic } from './storage.mjs';
/**
 * blitz.cloud keep-alive agent (single app or many accounts/apps).
 *
 * blitz.cloud (free plan) scales an app to zero after 30 minutes without a
 * *browser* visitor. Since 2026-09-29 plain program requests (curl, uptime
 * monitors, webhooks) no longer wake a sleeping free app - they receive an
 * "asleep" answer. This agent therefore drives a real Chrome/Edge instance
 * (headless by default) on a fixed interval, which counts as a visit.
 *
 * Single app:
 *   node keepalive.mjs --url=https://myapp.myname.blitz.cloud --expect="Dashboard"
 *
 * Many accounts/apps:
 *   node keepalive.mjs --config=targets.json
 *
 * One-off sweep (cron / Task Scheduler):
 *   node keepalive.mjs --config=targets.json --once
 *
 * Exit codes: 0 = success (or another instance already holds the lock),
 *             1 = at least one visit failed (--once mode), 2 = invalid configuration.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  statfs,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const MINUTE = 60_000;
const MAX_INTERVAL_MIN = MAX_VISIT_WINDOW_MIN;
const MAX_JITTER_MIN = 10;
const LOCK_STALE_MS = 15 * MINUTE;
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const MAX_RECENT_LOGS = 100;
const MAX_MANAGED_TARGETS = 100;
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const MAX_IMPORT_BODY_BYTES = 128 * 1024;
const ADMIN_COOKIE_NAME = 'blitz_admin_session';
const ADMIN_SESSION_TTL_MS = 12 * 60 * MINUTE;
const DEFAULT_ADMIN_SESSION_IDLE_TIMEOUT_MIN = 60;
const ADMIN_PASSWORD_MIN_LENGTH = 10;
const ADMIN_PASSWORD_MAX_LENGTH = 256;
const ADMIN_PASSWORD_FILE_VERSION = 1;
const ADMIN_PASSWORD_SALT_BYTES = 16;
const ADMIN_PASSWORD_HASH_BYTES = 64;
const ADMIN_PASSWORD_SCRYPT = Object.freeze({
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});
const TARGET_SECRET_KEY_BYTES = 32;
const TARGET_SECRET_IV_BYTES = 12;
const TARGET_SECRET_TAG_BYTES = 16;
const TARGET_SECRET_RECORD_VERSION = 1;
const TARGET_SECRET_ALGORITHM = 'aes-256-gcm';
const TARGET_LOGIN_PASSWORD_MAX_LENGTH = 512;
const TARGET_PROXY_URL_MAX_LENGTH = 2048;
const TARGET_PROXY_USERNAME_MAX_LENGTH = 256;
const TARGET_PROXY_PASSWORD_MAX_LENGTH = 512;
const TARGET_PROXY_BYPASS_MAX_LENGTH = 2048;
const LOGIN_WINDOW_MS = 10 * MINUTE;
const LOGIN_LOCK_MS = 5 * MINUTE;
const LOGIN_MAX_FAILURES = 5;
const AUTH_FAILURE_PAUSE_THRESHOLD = 3;
const AUTH_FAILURE_PAUSE_MS = 30 * MINUTE;
// A single visit can legitimately take up to ~6 minutes (navigation + wake
// window). Ten minutes without any scheduler progress means the loop is stuck,
// not merely busy.
const SCHEDULER_STALL_MS = 10 * MINUTE;
// nextDue is an absolute timestamp, so a backwards clock step (NTP correction,
// manual change) pushes every target into the far future and keep-alive silently
// stops. Anything beyond this tolerance counts as a clock step, not drift.
const CLOCK_REWIND_TOLERANCE_MS = 1_000;
const TARGET_LOGIN_SUCCESS_SELECTOR_MAX_LENGTH = 300;
const FAILURE_DUMP_CLEANUP_INTERVAL_MS = 6 * 60 * MINUTE;
const VISIT_DURATION_BUCKETS_SEC = [1, 2, 5, 10, 20, 30, 60, 120, 300];
const DEFAULT_WEBHOOK_MIN_INTERVAL_SEC = 900;
const DEFAULT_WEBHOOK_TIMEOUT_SEC = 10;
const DEFAULT_WEBHOOK_FAILURE_THRESHOLD = 1;
// A probe is an interactive diagnostic: navigation, wake wait and login
// navigation each have their own timeout, so the watchdog below is only the sum
// of those budgets plus slack. It exists to bound a page/browser that stops
// answering, not to cut a legitimately slow first visit short.
const PROBE_DEADLINE_FLOOR_MS = 60_000;
const PROBE_DEADLINE_CEILING_MS = 180_000;
const PROBE_DEADLINE_SLACK_MS = 30_000;
const BLOCKABLE_RESOURCE_TYPES = new Set([
  'image',
  'media',
  'font',
  'stylesheet',
  'texttrack',
  'manifest',
  'other',
]);
const MANAGED_TARGETS_FILE_VERSION = 1;
const RUNTIME_STATE_FILE_VERSION = 1;
const RUNTIME_STATE_DEBOUNCE_MS = 250;
const SHUTDOWN_GRACE_MS = 10_000;
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const STATIC_FILES = new Map([
  ['/assets/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/assets/status.js', { file: 'status.js', type: 'text/javascript; charset=utf-8' }],
  ['/assets/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/status', { file: 'status.html', type: 'text/html; charset=utf-8' }],
]);
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

/** Pages served by blitz.cloud while the app is not answering yet. */


const CHROME_CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
};

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/**
 * Chrome's UA reduction reports `HeadlessChrome/<version>` and a platform token
 * that can disagree with the host OS. A hardcoded UA therefore tends to
 * contradict the browser that actually sends it (wrong major version, Windows
 * token on a Linux container). Derive the UA from the running browser instead,
 * keeping only the major version, which is what the reduced UA exposes anyway.
 */
const UA_PLATFORM_TOKENS = {
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  linux: 'X11; Linux x86_64',
};
const BROWSER_USER_AGENT_CACHE = new WeakMap();

function buildUserAgentForMajor(major) {
  const platform = UA_PLATFORM_TOKENS[process.platform] ?? UA_PLATFORM_TOKENS.linux;
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

async function userAgentForPage(page) {
  const browser = typeof page?.browser === 'function' ? page.browser() : null;
  if (!browser || typeof browser.version !== 'function') return DEFAULT_USER_AGENT;
  const cached = BROWSER_USER_AGENT_CACHE.get(browser);
  if (cached) return cached;
  try {
    const version = String(await browser.version());
    const match = version.match(/(\d+)\./);
    if (!match) return DEFAULT_USER_AGENT;
    const derived = buildUserAgentForMajor(match[1]);
    BROWSER_USER_AGENT_CACHE.set(browser, derived);
    return derived;
  } catch {
    return DEFAULT_USER_AGENT;
  }
}

const scrypt = promisify(scryptCallback);

let stopping = false;
const ACTIVE_BROWSERS = new Set();
const STOP_WAITERS = new Set();
let runtimeStateStore = null;

/**
 * Keeps the historical call signature while the computation itself lives in
 * schedule.mjs (where it can be unit-tested without booting the runtime).
 */
function scheduleNext(
  target,
  opts = {},
  now = Date.now(),
  timeZone = DEFAULT_SCHEDULE_TIMEZONE,
) {
  return scheduleNextPure(
    target,
    { ...opts, onScheduled: () => runtimeStateStore?.schedule() },
    now,
    timeZone,
  );
}
let statsStore = null;
let probeInFlight = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Counting semaphore shared by every sweep.
 *
 * Sweeps no longer run one at a time: a slow target must not delay a target that
 * becomes due while the first sweep is still retrying. The concurrency cap still
 * has to be global, otherwise N concurrent sweeps would each spawn maxConcurrent
 * Chromium instances.
 */
function createSemaphore(limit) {
  const max = Math.max(1, Math.trunc(Number(limit)) || 1);
  let active = 0;
  const waiters = [];
  return {
    acquire() {
      if (active < max) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    release() {
      const next = waiters.shift();
      // Hand the permit straight to the next waiter instead of decrementing.
      if (next) next();
      else active = Math.max(0, active - 1);
    },
    get activeCount() {
      return active;
    },
    get pendingCount() {
      return waiters.length;
    },
  };
}

async function closeBrowser(browser) {
  if (!browser) return;
  ACTIVE_BROWSERS.delete(browser);
  // browser.close() waits for the Chrome process to exit. If that process is
  // wedged it never resolves, and because every visit awaits this in its
  // finally block, one stuck browser would freeze the whole scheduler while
  // /healthz still answers 200. Bound it and kill the child as a last resort.
  let timer = null;
  const closed = browser.close().catch(() => 'closed');
  const timedOut = await Promise.race([
    closed.then(() => false),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), BROWSER_CLOSE_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!timedOut) return;
  try {
    const child = browser.process();
    if (child && !child.killed) child.kill('SIGKILL');
  } catch {
    // The process may already be gone; nothing left to clean up.
  }
}

function requestStop() {
  if (stopping) return;
  stopping = true;
  for (const resolve of STOP_WAITERS) resolve(true);
  STOP_WAITERS.clear();
  for (const browser of [...ACTIVE_BROWSERS]) {
    void closeBrowser(browser);
  }
}

function waitForStop(ms) {
  if (stopping) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      STOP_WAITERS.delete(onStop);
      resolve(false);
    }, ms);
    const onStop = () => {
      clearTimeout(timer);
      resolve(true);
    };
    STOP_WAITERS.add(onStop);
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function toNumber(raw, label, { min, max }) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function validateVisitWindow(intervalMin, jitterMin, label = 'intervalMin + jitterMin') {
  if (intervalMin + jitterMin > MAX_VISIT_WINDOW_MIN) {
    throw new Error(
      `${label} must not exceed ${MAX_VISIT_WINDOW_MIN} minutes so a visit always happens before the 30-minute sleep threshold.`,
    );
  }
}

function toBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(raw).toLowerCase());
}

class LoginFlowError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'LoginFlowError';
    this.code = code;
  }
}

function resolveChrome(args) {
  const explicit = args.chrome ?? process.env.CHROME_PATH;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`Chrome/Edge not found at ${explicit}`);
    return explicit;
  }
  for (const candidate of CHROME_CANDIDATES[process.platform] ?? []) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'No Chrome/Edge installation found. Pass --chrome=<path> or set CHROME_PATH.',
  );
}

function readConfigFile(configPath) {
  const absolute = path.resolve(configPath);
  if (!existsSync(absolute)) throw new Error(`Config file not found: ${absolute}`);
  let parsed;
  try {
    // Windows editors (Notepad, PowerShell 5.1) happily prepend a BOM.
    parsed = JSON.parse(readFileSync(absolute, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Config file ${absolute} is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Config file must contain a JSON object.');
  }
  return parsed;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function decodeBase64Value(value, label, expectedBytes = null) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} is not valid base64.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (expectedBytes !== null && decoded.length !== expectedBytes) {
    throw new Error(`${label} has an invalid length.`);
  }
  return decoded;
}

function decodeTargetSecretKey(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    try {
      key = decodeBase64Value(raw, 'TARGET_SECRET_KEY');
    } catch {
      throw new Error('TARGET_SECRET_KEY must be 32 bytes encoded as base64 or 64 hex characters.');
    }
  }
  if (key.length !== TARGET_SECRET_KEY_BYTES) {
    throw new Error('TARGET_SECRET_KEY must be exactly 32 bytes.');
  }
  return key;
}

function readTargetSecretKeyFile(file) {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Target secret key file ${file} is not valid JSON: ${error.message}`);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.version !== TARGET_SECRET_RECORD_VERSION ||
    parsed.algorithm !== TARGET_SECRET_ALGORITHM
  ) {
    throw new Error('Target secret key file uses an unsupported format.');
  }
  try {
    return decodeBase64Value(parsed.key, 'target secret key', TARGET_SECRET_KEY_BYTES);
  } catch (error) {
    throw new Error(`Target secret key file ${file} is invalid: ${error.message}`);
  }
}

async function createTargetSecretKeyFile(file, key) {
  await mkdir(path.dirname(file), { recursive: true });
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
    await handle.writeFile(
      `${JSON.stringify(
        {
          version: TARGET_SECRET_RECORD_VERSION,
          algorithm: TARGET_SECRET_ALGORITHM,
          key: key.toString('base64'),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await handle.sync();
    await handle.close();
    handle = null;
    return true;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

function targetPasswordAad(targetId) {
  return Buffer.from(`blitz-keepalive:target-password:${targetId}`, 'utf8');
}

function targetProxyPasswordAad(targetId) {
  return Buffer.from(`blitz-keepalive:target-proxy-password:${targetId}`, 'utf8');
}

function validateEncryptedTargetPassword(value, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== TARGET_SECRET_RECORD_VERSION ||
    value.algorithm !== TARGET_SECRET_ALGORITHM
  ) {
    throw new Error(`${label} uses an unsupported encrypted password format.`);
  }
  let iv;
  let tag;
  let data;
  try {
    iv = decodeBase64Value(value.iv, `${label}.iv`, TARGET_SECRET_IV_BYTES);
    tag = decodeBase64Value(value.tag, `${label}.tag`, TARGET_SECRET_TAG_BYTES);
    data = decodeBase64Value(value.data, `${label}.data`);
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`);
  }
  if (data.length === 0) throw new Error(`${label}.data is empty.`);
  return { iv, tag, data };
}

function encryptTargetPassword(secretStore, targetId, password) {
  if (!secretStore) throw new Error('Target password encryption is not initialized.');
  const iv = randomBytes(TARGET_SECRET_IV_BYTES);
  const cipher = createCipheriv(TARGET_SECRET_ALGORITHM, secretStore.key, iv);
  cipher.setAAD(targetPasswordAad(targetId));
  const data = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return {
    version: TARGET_SECRET_RECORD_VERSION,
    algorithm: TARGET_SECRET_ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptTargetPassword(secretStore, targetId, value, label = 'encrypted password') {
  if (!secretStore) throw new Error('Target password encryption is not initialized.');
  const { iv, tag, data } = validateEncryptedTargetPassword(value, label);
  try {
    const decipher = createDecipheriv(TARGET_SECRET_ALGORITHM, secretStore.key, iv);
    decipher.setAAD(targetPasswordAad(targetId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(`目标 ${targetId} 的访问密码无法解密，请检查密钥文件是否与目标数据匹配。`);
  }
}

function encryptTargetProxyPassword(secretStore, targetId, password) {
  if (!secretStore) throw new Error('Target proxy password encryption is not initialized.');
  const iv = randomBytes(TARGET_SECRET_IV_BYTES);
  const cipher = createCipheriv(TARGET_SECRET_ALGORITHM, secretStore.key, iv);
  cipher.setAAD(targetProxyPasswordAad(targetId));
  const data = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return {
    version: TARGET_SECRET_RECORD_VERSION,
    algorithm: TARGET_SECRET_ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptTargetProxyPassword(
  secretStore,
  targetId,
  value,
  label = 'encrypted proxy password',
) {
  if (!secretStore) throw new Error('Target proxy password encryption is not initialized.');
  const { iv, tag, data } = validateEncryptedTargetPassword(value, label);
  try {
    const decipher = createDecipheriv(TARGET_SECRET_ALGORITHM, secretStore.key, iv);
    decipher.setAAD(targetProxyPasswordAad(targetId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(`目标 ${targetId} 的代理密码无法解密，请检查密钥文件是否与目标数据匹配。`);
  }
}

async function initializeTargetSecretStore(cfg) {
  const hasEncryptedPasswords = cfg.managedRecords.some(
    (record) => record.loginPasswordEnc || record.proxyPasswordEnc,
  );
  let key = cfg.targetSecretKey ? decodeTargetSecretKey(cfg.targetSecretKey) : null;

  if (!key) {
    key = readTargetSecretKeyFile(cfg.targetSecretKeyFile);
  }
  if (!key) {
    if (hasEncryptedPasswords) {
      throw new Error(
        `目标数据包含加密访问密码或代理密码，但密钥文件不存在：${cfg.targetSecretKeyFile}。请恢复备份的密钥文件，或通过 TARGET_SECRET_KEY 提供原密钥。`,
      );
    }
    const candidate = randomBytes(TARGET_SECRET_KEY_BYTES);
    const created = await createTargetSecretKeyFile(cfg.targetSecretKeyFile, candidate);
    if (created) {
      key = candidate;
    } else {
      // Another process may have created the file between the read and the
      // exclusive open. Give it a moment to finish writing, then reuse its key.
      for (let attempt = 0; attempt < 10 && !key; attempt += 1) {
        await sleep(25);
        key = readTargetSecretKeyFile(cfg.targetSecretKeyFile);
      }
      if (!key) throw new Error(`无法读取目标密钥文件：${cfg.targetSecretKeyFile}`);
    }
  }

  return {
    key,
    encrypt(targetId, password) {
      return encryptTargetPassword(this, targetId, password);
    },
    decrypt(targetId, value, label) {
      return decryptTargetPassword(this, targetId, value, label);
    },
    encryptProxy(targetId, password) {
      return encryptTargetProxyPassword(this, targetId, password);
    },
    decryptProxy(targetId, value, label) {
      return decryptTargetProxyPassword(this, targetId, value, label);
    },
  };
}

function hydrateManagedTargetPasswords(cfg, secretStore) {
  for (const record of cfg.managedRecords) {
    const target = cfg.targets.find((item) => item.id === record.id);
    if (!target) continue;
    if (record.loginPasswordEnc) {
      target.loginPassword = secretStore.decrypt(
        record.id,
        record.loginPasswordEnc,
        `managedTargets.${record.id}.loginPasswordEnc`,
      );
      target.loginPasswordConfigured = true;
    }
    if (record.proxyPasswordEnc) {
      if (target.proxyMode !== 'custom' || !target.proxy) {
        throw new Error(
          `managedTargets.${record.id}.proxyPasswordEnc requires a custom proxy configuration.`,
        );
      }
      target.proxy.password = secretStore.decryptProxy(
        record.id,
        record.proxyPasswordEnc,
        `managedTargets.${record.id}.proxyPasswordEnc`,
      );
      target.proxyPasswordConfigured = true;
    }
  }
}

function publicManagedTargetRecord(record) {
  const { loginPasswordEnc, proxyPasswordEnc, ...safe } = record;
  return {
    ...safe,
    loginPasswordConfigured: Boolean(loginPasswordEnc),
    proxyPasswordConfigured: Boolean(proxyPasswordEnc),
  };
}

function decodeAdminPasswordValue(value, label, expectedBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`Admin password file has an invalid ${label}.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedBytes) {
    throw new Error(`Admin password file has an invalid ${label} length.`);
  }
  return decoded;
}

function readAdminPasswordFile(file) {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Admin password file ${file} is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Admin password file must contain a JSON object.');
  }
  if (parsed.version !== ADMIN_PASSWORD_FILE_VERSION || parsed.algorithm !== 'scrypt') {
    throw new Error('Admin password file uses an unsupported format.');
  }
  if (
    parsed.params === null ||
    typeof parsed.params !== 'object' ||
    Array.isArray(parsed.params) ||
    parsed.params.N !== ADMIN_PASSWORD_SCRYPT.N ||
    parsed.params.r !== ADMIN_PASSWORD_SCRYPT.r ||
    parsed.params.p !== ADMIN_PASSWORD_SCRYPT.p
  ) {
    throw new Error('Admin password file uses unsupported scrypt parameters.');
  }
  const salt = decodeAdminPasswordValue(
    parsed.salt,
    'salt',
    ADMIN_PASSWORD_SALT_BYTES,
  );
  const hash = decodeAdminPasswordValue(
    parsed.hash,
    'hash',
    ADMIN_PASSWORD_HASH_BYTES,
  );
  return {
    version: ADMIN_PASSWORD_FILE_VERSION,
    algorithm: 'scrypt',
    salt,
    hash,
    params: {
      N: ADMIN_PASSWORD_SCRYPT.N,
      r: ADMIN_PASSWORD_SCRYPT.r,
      p: ADMIN_PASSWORD_SCRYPT.p,
    },
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
  };
}

async function createAdminPasswordRecord(password) {
  const salt = randomBytes(ADMIN_PASSWORD_SALT_BYTES);
  const hash = await scrypt(password, salt, ADMIN_PASSWORD_HASH_BYTES, ADMIN_PASSWORD_SCRYPT);
  return {
    version: ADMIN_PASSWORD_FILE_VERSION,
    algorithm: 'scrypt',
    salt,
    hash,
    params: {
      N: ADMIN_PASSWORD_SCRYPT.N,
      r: ADMIN_PASSWORD_SCRYPT.r,
      p: ADMIN_PASSWORD_SCRYPT.p,
    },
    updatedAt: new Date().toISOString(),
  };
}

function serializeAdminPasswordRecord(record) {
  return {
    version: ADMIN_PASSWORD_FILE_VERSION,
    algorithm: 'scrypt',
    salt: record.salt.toString('base64'),
    hash: record.hash.toString('base64'),
    params: {
      N: record.params.N,
      r: record.params.r,
      p: record.params.p,
    },
    updatedAt: record.updatedAt,
  };
}

async function verifyAdminPassword(password, record) {
  if (typeof password !== 'string' || !record) return false;
  const derived = await scrypt(password, record.salt, record.hash.length, ADMIN_PASSWORD_SCRYPT);
  return derived.length === record.hash.length && timingSafeEqual(derived, record.hash);
}

function readManagedTargetsFile(file) {
  if (!existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Managed targets file ${file} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) && parsed !== null && typeof parsed === 'object') {
    if (parsed.version !== undefined && parsed.version !== MANAGED_TARGETS_FILE_VERSION) {
      throw new Error(
        `Managed targets file version ${parsed.version} is not supported (expected ${MANAGED_TARGETS_FILE_VERSION}).`,
      );
    }
  }
  const targets = Array.isArray(parsed) ? parsed : parsed?.targets;
  if (!Array.isArray(targets)) {
    throw new Error('Managed targets file must contain an object with a targets array.');
  }
  if (targets.length > MAX_MANAGED_TARGETS) {
    throw new Error(`Managed targets file has more than ${MAX_MANAGED_TARGETS} targets.`);
  }
  return targets;
}

async function writeManagedTargetsFile(file, records) {
  await writeJsonFileAtomic(file, {
    version: MANAGED_TARGETS_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    targets: records,
  });
}

async function writeAdminPasswordFile(file, record) {
  await writeJsonFileAtomic(file, serializeAdminPasswordRecord(record));
}

/** Proxy schemes Chromium accepts on --proxy-server. */
const PROXY_SCHEMES = new Map([
  ['http:', 'http:'],
  ['https:', 'https:'],
  ['socks:', 'socks5:'],
  ['socks4:', 'socks4:'],
  ['socks5:', 'socks5:'],
  // Chrome's socks5 always resolves DNS at the proxy, i.e. socks5h semantics.
  ['socks5h:', 'socks5:'],
]);

function decodeUserInfo(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Chromium wants bypass entries separated by ';' and does not understand the
 * leading-dot form used by NO_PROXY, so normalize both.
 */
function normalizeBypass(raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  const items = String(raw)
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((item) => (item.startsWith('.') ? `*${item}` : item));
  return items.join(';');
}

/** Best-effort credential removal for error messages. */
function redactUrlForError(value) {
  const text = String(value);
  try {
    const url = new URL(text.includes('://') ? text : `http://${text}`);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return text.replace(/\/\/[^@/\s]*@/, '//***@');
  }
}

/**
 * Validate and normalize a proxy URL. Credentials are kept out of the URL that
 * is handed to Chromium: --proxy-server must never contain them, they go
 * through page.authenticate() instead.
 */
function normalizeProxy(raw, label, { username, password, bypass } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = String(raw).trim();
  if (value.length > TARGET_PROXY_URL_MAX_LENGTH) {
    throw new Error(`${label} must not exceed ${TARGET_PROXY_URL_MAX_LENGTH} characters.`);
  }
  let url;
  try {
    url = new URL(value.includes('://') ? value : `http://${value}`);
  } catch {
    throw new Error(`${label} is not a valid proxy URL: ${redactUrlForError(value)}`);
  }
  const protocol = PROXY_SCHEMES.get(url.protocol.toLowerCase());
  if (!protocol) {
    throw new Error(`${label} must use http, https, socks4, socks5 or socks5h (got ${url.protocol})`);
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error(`${label} must be a plain proxy address without path or query; PAC URLs are not supported.`);
  }
  const defaultPort = protocol === 'socks4:' || protocol === 'socks5:' ? 1080 : protocol === 'https:' ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} has an invalid port: ${url.port}`);
  }

  const user =
    username !== undefined && username !== null && String(username) !== ''
      ? String(username)
      : decodeUserInfo(url.username);
  const pass =
    password !== undefined && password !== null && String(password) !== ''
      ? String(password)
      : decodeUserInfo(url.password);
  if (user.length > TARGET_PROXY_USERNAME_MAX_LENGTH) {
    throw new Error(`${label} username must not exceed ${TARGET_PROXY_USERNAME_MAX_LENGTH} characters.`);
  }
  if (pass.length > TARGET_PROXY_PASSWORD_MAX_LENGTH) {
    throw new Error(`${label} password must not exceed ${TARGET_PROXY_PASSWORD_MAX_LENGTH} characters.`);
  }
  const normalizedBypass = normalizeBypass(bypass);
  if (normalizedBypass.length > TARGET_PROXY_BYPASS_MAX_LENGTH) {
    throw new Error(`${label} bypass list must not exceed ${TARGET_PROXY_BYPASS_MAX_LENGTH} characters.`);
  }
  if ((protocol === 'socks4:' || protocol === 'socks5:') && (user || pass)) {
    throw new Error(
      `${label}: Chromium does not support SOCKS authentication. ` +
        'Use an IP-allowlisted SOCKS proxy or an authenticated HTTP(S) proxy.',
    );
  }

  return {
    server: `${protocol}//${url.hostname}:${port}`,
    username: user || '',
    password: pass || '',
    bypass: normalizedBypass,
  };
}

/**
 * Per-target proxy: an explicit `proxy` field wins (empty string disables the
 * proxy for that target), otherwise the target inherits the global proxy and
 * may still override credentials or the bypass list.
 */
function resolveTargetProxy(raw, globals, index) {
  const hasValue = (key) => raw[key] !== undefined && raw[key] !== null && String(raw[key]) !== "";
  const hasExplicitProxy = Object.prototype.hasOwnProperty.call(raw, "proxy");
  if (raw.proxyMode === "direct") {
    if (hasExplicitProxy && String(raw.proxy).trim() !== "") {
      throw new Error("targets[" + index + "].proxy must be empty when proxyMode is direct.");
    }
    return null;
  }
  if (raw.proxyMode === "custom") {
    if (!hasExplicitProxy || String(raw.proxy).trim() === "") {
      throw new Error("targets[" + index + "].proxy is required when proxyMode is custom.");
    }
    const proxy = normalizeProxy(raw.proxy, "targets[" + index + "].proxy", {
      username: raw.proxyUsername,
      password: raw.proxyPassword,
      bypass: raw.proxyBypass,
    });
    if (!proxy) throw new Error("targets[" + index + "].proxy is required when proxyMode is custom.");
    return proxy;
  }
  if (raw.proxyMode === "inherit" && hasExplicitProxy && String(raw.proxy).trim() !== "") {
    throw new Error("targets[" + index + "].proxy must be empty when proxyMode is inherit.");
  }
  if (hasExplicitProxy && raw.proxyMode !== "inherit") {
    return normalizeProxy(raw.proxy, "targets[" + index + "].proxy", {
      username: raw.proxyUsername,
      password: raw.proxyPassword,
      bypass: raw.proxyBypass,
    });
  }
  if (!globals.proxy) return null;
  return {
    ...globals.proxy,
    username: hasValue("proxyUsername") ? String(raw.proxyUsername) : globals.proxy.username,
    password: hasValue("proxyPassword") ? String(raw.proxyPassword) : globals.proxy.password,
    bypass: hasValue("proxyBypass") ? normalizeBypass(raw.proxyBypass) : globals.proxy.bypass,
  };
}

const TARGET_PROXY_MODES = new Set(['inherit', 'direct', 'custom']);

function managedRecordProxyMode(record) {
  if (!record) return 'inherit';
  if (TARGET_PROXY_MODES.has(record.proxyMode)) return record.proxyMode;
  if (!Object.prototype.hasOwnProperty.call(record, 'proxy')) return 'inherit';
  return String(record.proxy).trim() === '' ? 'direct' : 'custom';
}

/** Never let credentials reach logs, status output or error messages. */
function redactProxy(proxy) {
  if (!proxy) return null;
  return {
    server: proxy.server,
    auth: Boolean(proxy.username || proxy.password),
    ...(proxy.bypass ? { bypass: proxy.bypass } : {}),
  };
}

/** Turn Chromium network errors into actionable, credential-free reasons. */
const PROXY_ERROR_HINTS = [
  ['ERR_PROXY_CONNECTION_FAILED', 'proxy-unreachable'],
  ['ERR_TUNNEL_CONNECTION_FAILED', 'proxy-tunnel-failed'],
  ['ERR_PROXY_AUTH_UNSUPPORTED', 'proxy-auth-unsupported'],
  ['ERR_INVALID_AUTH_CREDENTIALS', 'proxy-auth-rejected'],
  ['ERR_SOCKS_CONNECTION_FAILED', 'socks-unreachable'],
  ['ERR_SOCKS_CONNECTION_HOST_UNREACHABLE', 'socks-host-unreachable'],
];

function describeVisitError(error) {
  const message = String(error?.message ?? error);
  for (const [needle, label] of PROXY_ERROR_HINTS) {
    if (message.includes(needle)) {
      return { reason: `${label}:${needle}`, proxyError: true, detail: message.slice(0, 300) };
    }
  }
  return { reason: message, proxyError: false };
}

function normalizeTarget(raw, globals, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`targets[${index}] must be an object.`);
  }
  if (!raw.url) throw new Error(`targets[${index}].url is required.`);
  let url;
  try {
    url = new URL(raw.url);
  } catch {
    throw new Error(`targets[${index}].url is invalid: ${raw.url}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`targets[${index}].url must be http(s): ${raw.url}`);
  }
  if (url.username || url.password) {
    // Would end up in logs and in the browser history; credentials belong in
    // the proxy settings or in the app itself.
    throw new Error(`targets[${index}].url must not contain credentials: ${url.origin}`);
  }

  const intervalMin = toNumber(
    raw.intervalMin ?? globals.intervalMin,
    `targets[${index}].intervalMin`,
    { min: 1, max: MAX_INTERVAL_MIN },
  );
  const jitterMin = toNumber(raw.jitterMin ?? globals.jitterMin, `targets[${index}].jitterMin`, {
    min: 0,
    max: MAX_JITTER_MIN,
  });
  validateVisitWindow(intervalMin, jitterMin, `targets[${index}] intervalMin + jitterMin`);
  const id = String(raw.id ?? url.hostname).trim();
  if (!id) throw new Error(`targets[${index}].id is empty.`);
  const loginSuccessSelector = String(raw.loginSuccessSelector ?? '').trim();
  if (loginSuccessSelector.length > TARGET_LOGIN_SUCCESS_SELECTOR_MAX_LENGTH) {
    throw new Error(
      `targets[${index}].loginSuccessSelector must not exceed ${TARGET_LOGIN_SUCCESS_SELECTOR_MAX_LENGTH} characters.`,
    );
  }
  if (raw.proxyMode !== undefined && (typeof raw.proxyMode !== "string" || !TARGET_PROXY_MODES.has(raw.proxyMode))) {
    throw new Error("targets[" + index + "].proxyMode must be inherit, direct or custom.");
  }
  const proxyMode = TARGET_PROXY_MODES.has(raw.proxyMode)
    ? raw.proxyMode
    : Object.prototype.hasOwnProperty.call(raw, 'proxy')
      ? String(raw.proxy).trim() === ''
        ? 'direct'
        : 'custom'
      : 'inherit';

  const scheduleFields = normalizeScheduleFields(raw, globals);
  const keepOpenFields = normalizeKeepOpenFields(raw, globals);

  return {
    id,
    account: raw.account ? String(raw.account) : null,
    url: url.toString(),
    intervalMs: intervalMin * MINUTE,
    jitterMs: jitterMin * MINUTE,
    timeoutMs:
      toNumber(raw.timeoutSec ?? globals.timeoutSec, `targets[${index}].timeoutSec`, {
        min: 5,
        max: 300,
      }) * 1000,
    wakeWaitMs:
      toNumber(raw.wakeWaitSec ?? globals.wakeWaitSec, `targets[${index}].wakeWaitSec`, {
        min: 5,
        max: 300,
      }) * 1000,
    wakeExtensionMs:
      toNumber(
        raw.wakeExtensionSec ?? globals.wakeExtensionSec,
        `targets[${index}].wakeExtensionSec`,
        { min: 0, max: 600 },
      ) * 1000,
    minReadyTextLength: toNumber(
      raw.minReadyTextLength ?? globals.minReadyTextLength,
      `targets[${index}].minReadyTextLength`,
      { min: 0, max: 100_000 },
    ),
    settleMs:
      toNumber(raw.settleSec ?? globals.settleSec, `targets[${index}].settleSec`, {
        min: 0,
        max: 60,
      }) * 1000,
    retries: toNumber(raw.retries ?? globals.retries, `targets[${index}].retries`, {
      min: 0,
      max: 5,
    }),
    expectText: String(raw.expect ?? globals.expectText ?? ''),
    loginSuccessSelector,
    loginPassword: null,
    loginPasswordConfigured: false,
    notReadyPatterns: globals.notReadyPatterns.slice(),
    proxyMode,
    proxyUsername:
      raw.proxyUsername === undefined || raw.proxyUsername === null
        ? ''
        : String(raw.proxyUsername),
    proxyPasswordConfigured: Boolean(raw.proxyPassword),
    proxy: resolveTargetProxy(raw, globals, index),
    scheduleEnabled: scheduleFields.scheduleEnabled,
    scheduleStart: scheduleFields.scheduleStart,
    scheduleEnd: scheduleFields.scheduleEnd,
    scheduleDays: scheduleFields.scheduleDays,
    scheduleTimezone: scheduleFields.scheduleTimezone,
    firstVisitWakeWaitSec: scheduleFields.firstVisitWakeWaitSec,
    firstVisitTimeoutSec: scheduleFields.firstVisitTimeoutSec,
    firstVisitRetries: scheduleFields.firstVisitRetries,
    keepOpenEnabled: keepOpenFields.keepOpenEnabled,
    keepOpenScheduled: keepOpenFields.keepOpenScheduled,
    keepOpenStart: keepOpenFields.keepOpenStart,
    keepOpenEnd: keepOpenFields.keepOpenEnd,
    keepOpenManual: false,
    keepOpenActive: false,
    firstVisitWindowKey:
      typeof raw.firstVisitWindowKey === 'string' && raw.firstVisitWindowKey.length <= 128
        ? raw.firstVisitWindowKey
        : null,
    nextDue: 0,
    consecutiveFailures: 0,
    authFailureCount: 0,
    lastSuccessfulVisitAt: null,
    paused: false,
    pauseReason: null,
    pausedUntil: null,
    lastResult: null,
    lastVisit: null,
    running: false,
  };
}

const AUTHENTICATION_FAILURE_REASONS = new Set([
  'auth-failed',
  'login-form-missing',
  'login-submit-failed',
]);

function isAuthenticationFailureReason(reason) {
  return AUTHENTICATION_FAILURE_REASONS.has(String(reason ?? ''));
}

function pauseTarget(target, reason, until = null) {
  target.paused = true;
  target.pauseReason = String(reason ?? '手动暂停').slice(0, 240);
  target.pausedUntil = until ? new Date(until).toISOString() : null;
  target.nextDue = null;
  runtimeStateStore?.schedule();
}

function resumeTarget(target) {
  target.paused = false;
  target.pauseReason = null;
  target.pausedUntil = null;
  target.authFailureCount = 0;
  target.nextDue = Date.now() + 1_000;
  runtimeStateStore?.schedule();
}

function resumeExpiredPauses(targets) {
  const now = Date.now();
  const resumed = [];
  for (const target of targets) {
    if (!target.paused || !target.pausedUntil) continue;
    const until = Date.parse(target.pausedUntil);
    if (!Number.isFinite(until) || until > now) continue;
    resumeTarget(target);
    resumed.push(target.id);
  }
  return resumed;
}

const MANAGED_TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function baseManagedTargetId(urlValue) {
  let hostname = 'target';
  try {
    hostname = new URL(urlValue).hostname;
  } catch {
    // normalizeTarget() reports the actionable URL error below.
  }
  const base = hostname
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .slice(0, 48);
  return base || 'target';
}

function uniqueManagedTargetId(urlValue, knownIds) {
  const base = baseManagedTargetId(urlValue);
  if (!knownIds.has(base)) return base;
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!knownIds.has(candidate)) return candidate;
  }
  throw new HttpError(409, '无法自动生成唯一目标名称，请手动填写名称。');
}

/**
 * Validate a web-managed target without accepting arbitrary JSON fields. The
 * returned record is exactly what is persisted; the normalized target also
 * contains the runtime fields used by the scheduler.
 */
function normalizedTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function buildManagedTarget(
  raw,
  existing,
  globals,
  index,
  knownIds,
  secretStore,
  { preserveTimestamps = false, persistedRecord = null } = {},
) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, '请求内容必须是 JSON 对象。');
  }

  if (raw.id !== undefined && typeof raw.id !== 'string') {
    throw new HttpError(400, '目标名称必须是字符串。');
  }
  if (raw.id !== undefined && existing && String(raw.id).trim() !== existing.id) {
    throw new HttpError(400, '目标名称不可修改，请删除后重新创建。');
  }

  const urlValue = raw.url ?? existing?.url;
  if (typeof urlValue !== 'string' || !urlValue.trim()) {
    throw new HttpError(400, '网页地址不能为空。');
  }
  if (urlValue.length > 2048) throw new HttpError(400, '网页地址不能超过 2048 个字符。');

  let id = existing?.id ?? (raw.id === undefined ? uniqueManagedTargetId(urlValue, knownIds) : String(raw.id).trim());
  if (!MANAGED_TARGET_ID_PATTERN.test(id)) {
    throw new HttpError(400, '目标名称只能包含字母、数字、点、下划线和短横线，长度 1-64。');
  }
  if (knownIds.has(id)) throw new HttpError(409, `目标名称已存在：${id}`);

  const previousRecord = existing ?? persistedRecord;
  const intervalMin = raw.intervalMin ?? previousRecord?.intervalMin ?? globals.intervalMin;
  const jitterMin = raw.jitterMin ?? previousRecord?.jitterMin ?? globals.jitterMin;
  const wakeWaitSec =
    raw.wakeWaitSec !== undefined
      ? raw.wakeWaitSec
      : previousRecord?.wakeWaitSec !== undefined
        ? previousRecord.wakeWaitSec
        : undefined;
  const timeoutSec = raw.timeoutSec ?? previousRecord?.timeoutSec;
  const settleSec = raw.settleSec ?? previousRecord?.settleSec;
  const retries = raw.retries ?? previousRecord?.retries;
  const wakeExtensionSec =
    raw.wakeExtensionSec ?? previousRecord?.wakeExtensionSec ?? undefined;
  const minReadyTextLength =
    raw.minReadyTextLength ?? previousRecord?.minReadyTextLength ?? undefined;
  const expect = raw.expect ?? previousRecord?.expect ?? '';
  const loginSuccessSelector =
    raw.loginSuccessSelector ?? previousRecord?.loginSuccessSelector ?? '';
  const account = raw.account ?? previousRecord?.account ?? null;
  if (typeof expect !== 'string') throw new HttpError(400, '期望文本必须是字符串。');
  if (expect.length > 500) throw new HttpError(400, '期望文本不能超过 500 个字符。');
  if (typeof loginSuccessSelector !== 'string') {
    throw new HttpError(400, '登录成功选择器必须是字符串。');
  }
  if (loginSuccessSelector.length > TARGET_LOGIN_SUCCESS_SELECTOR_MAX_LENGTH) {
    throw new HttpError(
      400,
      `登录成功选择器不能超过 ${TARGET_LOGIN_SUCCESS_SELECTOR_MAX_LENGTH} 个字符。`,
    );
  }
  if (account !== null && typeof account !== 'string') throw new HttpError(400, '账号名称必须是字符串。');
  if (typeof account === 'string' && account.length > 100) {
    throw new HttpError(400, '账号名称不能超过 100 个字符。');
  }
  if (raw.loginPassword !== undefined && typeof raw.loginPassword !== 'string') {
    throw new HttpError(400, '后台访问密码必须是字符串。');
  }
  if (raw.clearLoginPassword !== undefined && typeof raw.clearLoginPassword !== 'boolean') {
    throw new HttpError(400, '清除访问密码标记必须是布尔值。');
  }
  if (raw.loginPassword && raw.loginPassword.length > TARGET_LOGIN_PASSWORD_MAX_LENGTH) {
    throw new HttpError(
      400,
      `后台访问密码不能超过 ${TARGET_LOGIN_PASSWORD_MAX_LENGTH} 个字符。`,
    );
  }
  if (raw.loginPassword && raw.clearLoginPassword) {
    throw new HttpError(400, '不能同时设置和清除后台访问密码。');
  }
  if (raw.clearLoginPassword && !existing) {
    throw new HttpError(400, '新建目标时没有可清除的后台访问密码。');
  }
  if (raw.loginPasswordEnc !== undefined && !persistedRecord) {
    throw new HttpError(400, '不能直接提交加密后的访问密码。');
  }
  if (persistedRecord && raw.loginPassword !== undefined) {
    throw new Error('managedTargets records must not contain plaintext loginPassword.');
  }

  const sourceRecord = previousRecord;
  if (
    raw.proxyMode !== undefined &&
    (typeof raw.proxyMode !== 'string' || !TARGET_PROXY_MODES.has(raw.proxyMode))
  ) {
    throw new HttpError(400, '代理模式必须是 inherit、direct 或 custom。');
  }
  for (const field of ['proxy', 'proxyUsername', 'proxyPassword', 'proxyBypass']) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') {
      throw new HttpError(400, `代理字段 ${field} 必须是字符串。`);
    }
  }
  if (raw.clearProxyPassword !== undefined && typeof raw.clearProxyPassword !== 'boolean') {
    throw new HttpError(400, '清除代理密码标记必须是布尔值。');
  }
  if (raw.proxy && raw.proxy.trim().length > TARGET_PROXY_URL_MAX_LENGTH) {
    throw new HttpError(400, `代理地址不能超过 ${TARGET_PROXY_URL_MAX_LENGTH} 个字符。`);
  }
  if (raw.proxyUsername && raw.proxyUsername.length > TARGET_PROXY_USERNAME_MAX_LENGTH) {
    throw new HttpError(400, `代理用户名不能超过 ${TARGET_PROXY_USERNAME_MAX_LENGTH} 个字符。`);
  }
  if (raw.proxyPassword && raw.proxyPassword.length > TARGET_PROXY_PASSWORD_MAX_LENGTH) {
    throw new HttpError(400, `代理密码不能超过 ${TARGET_PROXY_PASSWORD_MAX_LENGTH} 个字符。`);
  }
  if (raw.proxyBypass && raw.proxyBypass.length > TARGET_PROXY_BYPASS_MAX_LENGTH) {
    throw new HttpError(400, `代理绕过列表不能超过 ${TARGET_PROXY_BYPASS_MAX_LENGTH} 个字符。`);
  }
  if (raw.proxyPassword && raw.clearProxyPassword) {
    throw new HttpError(400, '不能同时设置和清除代理密码。');
  }
  if (raw.clearProxyPassword && !sourceRecord?.proxyPasswordEnc) {
    throw new HttpError(400, '该目标没有可清除的代理密码。');
  }
  if (raw.proxyPasswordEnc !== undefined && !persistedRecord) {
    throw new HttpError(400, '不能直接提交加密后的代理密码。');
  }
  if (persistedRecord && raw.proxyPassword !== undefined) {
    throw new Error('managedTargets records must not contain plaintext proxyPassword.');
  }

  let proxyMode;
  if (raw.proxyMode !== undefined) {
    proxyMode = raw.proxyMode;
  } else if (raw.proxy !== undefined) {
    proxyMode = raw.proxy.trim() === '' ? 'direct' : 'custom';
  } else {
    proxyMode = previousRecord ? managedRecordProxyMode(previousRecord) : 'inherit';
  }

  let scheduleFields;
  try {
    scheduleFields = normalizeScheduleFields(raw, previousRecord ?? globals);
  } catch (error) {
    throw new HttpError(400, error.message);
  }

  let keepOpenFields;
  try {
    keepOpenFields = normalizeKeepOpenFields(raw, previousRecord ?? {});
  } catch (error) {
    throw new HttpError(400, error.message);
  }

  let proxy = null;
  let proxyPasswordEnc = null;
  if (proxyMode === 'custom') {
    const proxyValue = raw.proxy ?? sourceRecord?.proxy ?? '';
    if (typeof proxyValue !== 'string' || !proxyValue.trim()) {
      throw new HttpError(400, '指定代理时必须填写代理地址。');
    }
    const reuseExistingProxyFields = raw.proxy === undefined && Boolean(sourceRecord);
    const proxyUsername =
      raw.proxyUsername ?? (reuseExistingProxyFields ? sourceRecord.proxyUsername ?? '' : '');
    const proxyBypass =
      raw.proxyBypass ?? (reuseExistingProxyFields ? sourceRecord.proxyBypass ?? '' : '');
    try {
      proxy = normalizeProxy(proxyValue, 'proxy', {
        username: proxyUsername,
        password: raw.proxyPassword,
        bypass: proxyBypass,
      });
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    if (!proxy) throw new HttpError(400, '指定代理时必须填写代理地址。');
    if (proxy.password && !proxy.username) {
      throw new HttpError(400, '配置代理密码时必须同时填写代理用户名。');
    }
    if (proxy.password && raw.clearProxyPassword) {
      throw new HttpError(400, '不能同时设置和清除代理密码。');
    }

    if (proxy.password) {
      if (!secretStore) throw new HttpError(500, '代理密码加密服务尚未初始化。');
      proxyPasswordEnc = secretStore.encryptProxy(id, proxy.password);
    } else if (!raw.clearProxyPassword && sourceRecord?.proxyPasswordEnc) {
      let sameProxyIdentity = false;
      if (sourceRecord.proxy) {
        try {
          const previous = normalizeProxy(sourceRecord.proxy, 'stored proxy', {
            username: sourceRecord.proxyUsername,
            bypass: sourceRecord.proxyBypass,
          });
          sameProxyIdentity =
            Boolean(previous) &&
            previous.server === proxy.server &&
            previous.username === proxy.username;
        } catch (error) {
          throw new Error(
            `managedTargets.${id}.proxy is invalid: ${error.message}`,
          );
        }
      }
      if (sameProxyIdentity) {
        proxyPasswordEnc = sourceRecord.proxyPasswordEnc;
        if (secretStore) {
          proxy.password = secretStore.decryptProxy(
            id,
            proxyPasswordEnc,
            `managedTargets.${id}.proxyPasswordEnc`,
          );
        } else {
          validateEncryptedTargetPassword(
            proxyPasswordEnc,
            `managedTargets.${id}.proxyPasswordEnc`,
          );
        }
      }
    }
  } else if (raw.proxy !== undefined && raw.proxy.trim() !== '') {
    throw new HttpError(400, '继承全局代理或直连时不能同时填写代理地址。');
  } else if (
    (raw.proxyUsername && raw.proxyUsername.trim()) ||
    raw.proxyPassword ||
    (raw.proxyBypass && raw.proxyBypass.trim()) ||
    raw.clearProxyPassword
  ) {
    throw new HttpError(400, '只有指定代理模式才能配置代理凭据或绕过列表。');
  }

  let target;
  try {
    target = normalizeTarget(
      {
        id,
        url: urlValue.trim(),
        intervalMin,
        jitterMin,
        expect,
        account,
        loginSuccessSelector,
        ...(wakeWaitSec !== undefined ? { wakeWaitSec } : {}),
        ...(timeoutSec !== undefined ? { timeoutSec } : {}),
        ...(settleSec !== undefined ? { settleSec } : {}),
        ...(retries !== undefined ? { retries } : {}),
        ...(wakeExtensionSec !== undefined ? { wakeExtensionSec } : {}),
        ...(minReadyTextLength !== undefined ? { minReadyTextLength } : {}),
        proxyMode,
        ...scheduleFields,
        ...keepOpenFields,
        firstVisitWindowKey:
          existing && existing.url === urlValue.trim()
            ? existing.firstVisitWindowKey ?? null
            : null,
        ...(proxyMode === 'custom'
          ? {
              proxy: proxy.server,
              proxyUsername: proxy.username,
              proxyPassword: proxy.password,
              proxyBypass: proxy.bypass,
            }
          : proxyMode === 'direct'
            ? { proxy: '' }
            : {}),
      },
      globals,
      index,
    );
  } catch (error) {
    throw new HttpError(400, error.message);
  }

  const now = new Date().toISOString();
  const persistedCreatedAt = preserveTimestamps ? normalizedTimestamp(raw.createdAt) : null;
  const persistedUpdatedAt = preserveTimestamps ? normalizedTimestamp(raw.updatedAt) : null;
  target.source = 'managed';
  target.managedCreatedAt = existing?.createdAt ?? persistedCreatedAt ?? now;
  target.managedUpdatedAt = existing ? now : persistedUpdatedAt ?? now;
  let loginPasswordEnc =
    existing?.loginPasswordEnc ?? persistedRecord?.loginPasswordEnc ?? null;
  if (raw.loginPassword) {
    if (!secretStore) throw new HttpError(500, '目标访问密码加密服务尚未初始化。');
    target.loginPassword = raw.loginPassword;
    loginPasswordEnc = secretStore.encrypt(target.id, raw.loginPassword);
  } else if (raw.clearLoginPassword) {
    loginPasswordEnc = null;
  } else if (existing?.loginPasswordEnc) {
    if (!secretStore) throw new HttpError(500, '目标访问密码加密服务尚未初始化。');
    target.loginPassword = secretStore.decrypt(
      target.id,
      existing.loginPasswordEnc,
      `managedTargets.${target.id}.loginPasswordEnc`,
    );
  } else if (persistedRecord?.loginPasswordEnc) {
    validateEncryptedTargetPassword(
      persistedRecord.loginPasswordEnc,
      `managedTargets.${target.id}.loginPasswordEnc`,
    );
  }
  target.loginPasswordConfigured = Boolean(loginPasswordEnc);
  target.proxyMode = proxyMode;
  target.proxyUsername = proxy?.username ?? '';
  target.proxyPasswordConfigured = Boolean(proxyPasswordEnc);
  if (target.loginPasswordConfigured && !target.expectText && !target.loginSuccessSelector) {
    throw new HttpError(400, '配置后台访问密码时，必须同时设置期望文本或登录成功选择器。');
  }
  const record = {
    id: target.id,
    url: target.url,
    intervalMin: Math.round(target.intervalMs / MINUTE),
    jitterMin: Math.round(target.jitterMs / MINUTE),
    wakeWaitSec: Math.round(target.wakeWaitMs / 1000),
    timeoutSec: Math.round(target.timeoutMs / 1000),
    settleSec: Math.round(target.settleMs / 1000),
    retries: target.retries,
    ...(Number(target.wakeExtensionMs) > 0
      ? { wakeExtensionSec: Math.round(target.wakeExtensionMs / 1000) }
      : {}),
    ...(Number(target.minReadyTextLength) > 0
      ? { minReadyTextLength: Number(target.minReadyTextLength) }
      : {}),
    expect: target.expectText,
    ...(target.loginSuccessSelector
      ? { loginSuccessSelector: target.loginSuccessSelector }
      : {}),
    ...(target.account ? { account: target.account } : {}),
    ...(loginPasswordEnc ? { loginPasswordEnc } : {}),
    proxyMode,
    ...(proxyMode === 'custom'
      ? {
          proxy: proxy.server,
          ...(proxy.username ? { proxyUsername: proxy.username } : {}),
          ...(proxy.bypass ? { proxyBypass: proxy.bypass } : {}),
        }
      : proxyMode === 'direct'
        ? { proxy: '' }
        : {}),
    ...(proxyPasswordEnc ? { proxyPasswordEnc } : {}),
    scheduleEnabled: target.scheduleEnabled,
    scheduleStart: target.scheduleStart,
    scheduleEnd: target.scheduleEnd,
    scheduleDays: target.scheduleDays,
    ...(target.scheduleTimezone ? { scheduleTimezone: target.scheduleTimezone } : {}),
    firstVisitWakeWaitSec: target.firstVisitWakeWaitSec,
    firstVisitTimeoutSec: target.firstVisitTimeoutSec,
    firstVisitRetries: target.firstVisitRetries,
    keepOpenEnabled: target.keepOpenEnabled,
    keepOpenScheduled: target.keepOpenScheduled,
    keepOpenStart: target.keepOpenStart,
    keepOpenEnd: target.keepOpenEnd,
    createdAt: target.managedCreatedAt,
    updatedAt: target.managedUpdatedAt,
  };
  return { target, record };
}

function normalizeManagedRecord(raw, globals, index, knownIds) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`managedTargets[${index}] must be an object.`);
  }
  if (typeof raw.id !== 'string' || !raw.id.trim()) {
    throw new Error(`managedTargets[${index}].id is required.`);
  }
  try {
    return buildManagedTarget(raw, null, globals, index, knownIds, null, {
      preserveTimestamps: true,
      persistedRecord: raw,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      throw new Error(`managedTargets[${index}]: ${error.message}`);
    }
    throw error;
  }
}

function parseBlockResourceTypes(raw) {
  const entries = String(raw ?? '')
    .split(/[\s,;]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const out = [];
  for (const entry of entries) {
    if (entry === 'none') continue;
    if (!BLOCKABLE_RESOURCE_TYPES.has(entry)) {
      throw new Error(
        `BLOCK_RESOURCES contains an unsupported resource type: ${entry} (allowed: ${[...BLOCKABLE_RESOURCE_TYPES].join(', ')})`,
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function loadConfig() {
  const args = parseArgs(process.argv.slice(2));
  // Target URLs are added through the management console and persisted in
  // managed-targets.json. CLI --url/--config remain available for local and
  // one-off automation, but are intentionally not read from environment
  // variables so a container can start with zero targets and no target-address
  // environment variable.
  const configPath = args.config;
  const urlArg = args.url;
  const port = toNumber(args.port ?? process.env.PORT, 'port', { min: 0, max: 65535 }) ?? 0;
  const bindHost = String(args['bind-host'] ?? process.env.BIND_HOST ?? '127.0.0.1').trim();
  if (!bindHost) throw new Error('BIND_HOST must not be empty.');
  const requireHttps = toBool(args['require-https'] ?? process.env.REQUIRE_HTTPS, false);
  const trustProxy = toBool(args['trust-proxy'] ?? process.env.TRUST_PROXY, false);
  const trustedProxyCidrsRaw = String(
    args['trust-proxy-cidrs'] ?? process.env.TRUST_PROXY_CIDRS ?? '',
  );
  const trustedProxyCidrs = parseTrustedProxyCidrs(trustedProxyCidrsRaw);
  if (trustProxy && trustedProxyCidrsRaw.trim() === '') {
    throw new Error('TRUST_PROXY=true requires TRUST_PROXY_CIDRS.');
  }

  const scheduleTimeZoneRaw = String(
    args['schedule-timezone'] ?? process.env.SCHEDULE_TIMEZONE ?? DEFAULT_SCHEDULE_TIMEZONE,
  ).trim();
  let scheduleTimeZone;
  try {
    scheduleTimeZone = assertValidTimeZone(scheduleTimeZoneRaw, 'SCHEDULE_TIMEZONE');
  } catch (error) {
    throw new Error(`配置错误: ${error.message}`);
  }
  const sessionIdleTimeoutMs =
    (toNumber(
      args['session-idle-timeout-min'] ?? process.env.SESSION_IDLE_TIMEOUT_MIN,
      'sessionIdleTimeoutMin',
      { min: 5, max: 720 },
    ) ?? DEFAULT_ADMIN_SESSION_IDLE_TIMEOUT_MIN) * MINUTE;
  const statusToken = String(args['status-token'] ?? process.env.STATUS_TOKEN ?? '');
  const adminPassword = String(args['admin-password'] ?? process.env.ADMIN_PASSWORD ?? '');
  const adminPasswordFile = path.resolve(
    args['admin-password-file'] ?? process.env.ADMIN_PASSWORD_FILE ?? path.join('data', 'admin-auth.json'),
  );
  const managedTargetsFile = path.resolve(
    args['managed-targets-file'] ?? process.env.MANAGED_TARGETS_FILE ?? path.join('data', 'managed-targets.json'),
  );
  const targetSecretKey = String(
    args['target-secret-key'] ?? process.env.TARGET_SECRET_KEY ?? '',
  ).trim();
  const targetSecretKeyFile = path.resolve(
    args['target-secret-key-file'] ??
      process.env.TARGET_SECRET_KEY_FILE ??
      path.join('data', 'target-secrets.key'),
  );
  const probeUrl = args.probe ? String(args.probe).trim() : null;
  if (probeUrl === '') throw new Error('--probe requires a URL, e.g. --probe=https://app.example.com');
  if (configPath && urlArg) {
    throw new Error('Use either --config (many apps) or --url (one app), not both.');
  }
  if (!configPath && !urlArg && !port && !probeUrl) {
    throw new Error(
      'Provide --config=<file>, --url=<app>, --port=<port>, or --probe=<url>.',
    );
  }
  if (port && !adminPassword && !existsSync(adminPasswordFile)) {
    throw new Error(
      'PORT requires ADMIN_PASSWORD or an existing ADMIN_PASSWORD_FILE. STATUS_TOKEN is read-only and cannot unlock the management console.',
    );
  }

  const fileConfig = configPath ? readConfigFile(configPath) : {};
  const fileDefaults = fileConfig.defaults ?? {};
  if (typeof fileDefaults !== 'object' || Array.isArray(fileDefaults)) {
    throw new Error('defaults must be an object.');
  }

  const globals = {
    // Proxy is resolved once for the whole process; targets may override it.
    // Credentials can come from the URL, --proxy-user/--proxy-pass or
    // PROXY_USERNAME/PROXY_PASSWORD (preferred: env vars are not visible in ps).
    proxy: normalizeProxy(args.proxy ?? process.env.PROXY_URL ?? fileDefaults.proxy, 'proxy', {
      username: args['proxy-user'] ?? process.env.PROXY_USERNAME ?? fileDefaults.proxyUsername,
      password: args['proxy-pass'] ?? process.env.PROXY_PASSWORD ?? fileDefaults.proxyPassword,
      bypass: args['proxy-bypass'] ?? process.env.PROXY_BYPASS ?? process.env.NO_PROXY ?? fileDefaults.proxyBypass,
    }),
    intervalMin: toNumber(
      args['interval-min'] ?? process.env.INTERVAL_MIN ?? fileDefaults.intervalMin,
      'intervalMin',
      { min: 1, max: MAX_INTERVAL_MIN },
    ) ?? 20,
    jitterMin: toNumber(args['jitter-min'] ?? process.env.JITTER_MIN ?? fileDefaults.jitterMin, 'jitterMin', {
      min: 0,
      max: MAX_JITTER_MIN,
    }) ?? 2,
    timeoutSec: toNumber(args['timeout-sec'] ?? process.env.TIMEOUT_SEC ?? fileDefaults.timeoutSec, 'timeoutSec', {
      min: 5,
      max: 300,
    }) ?? 60,
    // 90s covers the cold starts we see on blitz.cloud (the wake page alone can
    // sit there for a minute). The old 30s default regularly gave up while the
    // app was still booting, which showed up as "not-ready-timeout" failures
    // even though the site was fine a few seconds later.
    wakeWaitSec: toNumber(args['wake-wait-sec'] ?? process.env.WAKE_WAIT_SEC ?? fileDefaults.wakeWaitSec, 'wakeWaitSec', {
      min: 5,
      max: 300,
    }) ?? 90,
    // Extra budget granted only while the page still looks like a wake page.
    // 0 disables it; raise it for apps that need several minutes to boot.
    wakeExtensionSec: toNumber(
      args['wake-extension-sec'] ?? process.env.WAKE_EXTENSION_SEC ?? fileDefaults.wakeExtensionSec,
      'wakeExtensionSec',
      { min: 0, max: 600 },
    ) ?? 0,
    // Minimum visible text length before a page counts as ready. 0 disables the
    // check; useful for apps whose wake page renders a thin shell.
    minReadyTextLength: toNumber(
      args['min-ready-text-length'] ??
        process.env.MIN_READY_TEXT_LENGTH ??
        fileDefaults.minReadyTextLength,
      'minReadyTextLength',
      { min: 0, max: 100_000 },
    ) ?? 0,
    settleSec: toNumber(args['settle-sec'] ?? process.env.SETTLE_SEC ?? fileDefaults.settleSec, 'settleSec', {
      min: 0,
      max: 60,
    }) ?? 6,
    retries: toNumber(args.retries ?? process.env.RETRIES ?? fileDefaults.retries, 'retries', { min: 0, max: 5 }) ?? 2,
    expectText: String(args.expect ?? process.env.EXPECT_TEXT ?? fileDefaults.expect ?? ''),
    notReadyPatterns: DEFAULT_NOT_READY_PATTERNS.slice(),
    scheduleTimeZone,
  };
  validateVisitWindow(globals.intervalMin, globals.jitterMin);

  const extraPattern = args['not-ready-regex'] ?? fileDefaults.notReadyRegex;
  if (extraPattern) globals.notReadyPatterns.push(new RegExp(extraPattern, 'i'));

  let rawTargets = [];
  if (configPath) {
    if (fileConfig.targets !== undefined && !Array.isArray(fileConfig.targets)) {
      throw new Error('targets must be an array.');
    }
    rawTargets = fileConfig.targets ?? [];
  } else if (urlArg) {
    rawTargets = [{ id: new URL(urlArg).hostname, url: urlArg }];
  }

  const targets = rawTargets.map((raw, index) => {
    const target = normalizeTarget(raw, globals, index);
    target.source = 'config';
    return target;
  });
  const seen = new Set();
  for (const target of targets) {
    if (seen.has(target.id)) throw new Error(`Duplicate target id: ${target.id}`);
    seen.add(target.id);
  }

  const managedRecords = [];
  const rawManagedTargets = readManagedTargetsFile(managedTargetsFile);
  rawManagedTargets.forEach((raw, index) => {
    const { target, record } = normalizeManagedRecord(raw, globals, index, seen);
    targets.push(target);
    managedRecords.push(record);
    seen.add(target.id);
  });

  const once = toBool(args.once ?? process.env.ONCE, false);
  if (once && targets.length === 0) {
    throw new Error('At least one target is required in --once mode.');
  }
  if (targets.length === 0 && !port && !probeUrl) {
    throw new Error(
      'No targets are configured. Set PORT to start the web console and add targets there.',
    );
  }

  const logDir = path.resolve(args['log-dir'] ?? process.env.LOG_DIR ?? 'logs');
  const runtimeStateFile = path.resolve(
    args['runtime-state-file'] ?? process.env.RUNTIME_STATE_FILE ?? path.join('data', 'runtime-state.json'),
  );
  const statsFile = path.resolve(
    args['stats-file'] ?? process.env.STATS_FILE ?? path.join('data', 'stats.json'),
  );
  const webhookUrl = String(args['webhook-url'] ?? process.env.WEBHOOK_URL ?? '').trim();
  if (webhookUrl) {
    let parsedWebhook;
    try {
      parsedWebhook = new URL(webhookUrl);
    } catch {
      throw new Error('WEBHOOK_URL is not a valid URL.');
    }
    if (!['http:', 'https:'].includes(parsedWebhook.protocol)) {
      throw new Error('WEBHOOK_URL must use http:// or https://.');
    }
  }
  const webhookMinIntervalMs =
    (toNumber(
      args['webhook-min-interval-sec'] ?? process.env.WEBHOOK_MIN_INTERVAL_SEC,
      'webhookMinIntervalSec',
      { min: 0, max: 86_400 },
    ) ?? DEFAULT_WEBHOOK_MIN_INTERVAL_SEC) * 1000;
  const webhookTimeoutMs =
    (toNumber(
      args['webhook-timeout-sec'] ?? process.env.WEBHOOK_TIMEOUT_SEC,
      'webhookTimeoutSec',
      { min: 1, max: 60 },
    ) ?? DEFAULT_WEBHOOK_TIMEOUT_SEC) * 1000;
  const webhookFailureThreshold =
    toNumber(
      args['webhook-failure-threshold'] ?? process.env.WEBHOOK_FAILURE_THRESHOLD,
      'webhookFailureThreshold',
      { min: 1, max: 20 },
    ) ?? DEFAULT_WEBHOOK_FAILURE_THRESHOLD;
  const publicStatus = toBool(args['public-status'] ?? process.env.PUBLIC_STATUS, false);
  const blockResourceTypes = parseBlockResourceTypes(
    args['block-resources'] ?? process.env.BLOCK_RESOURCES,
  );

  return {
    targets,
    scheduleTimeZone,
    probeUrl,
    // Runtime defaults are also needed when web-managed targets are created or
    // updated after startup; keep them separate from the public config fields.
    globals,
    // Two workers keep one slow/cold-starting target from monopolising the
    // whole sweep. Each worker owns a Chromium instance (~300-500MB), so
    // memory-constrained hosts should pin this to 1 explicitly.
    maxConcurrent: toNumber(
      args['max-concurrent'] ?? process.env.MAX_CONCURRENT ?? fileConfig.maxConcurrent,
      'maxConcurrent',
      { min: 1, max: 5 },
    ) ?? 2,
    maxKeepOpenSessions: toNumber(
      args['max-keep-open-sessions'] ??
        process.env.MAX_KEEP_OPEN_SESSIONS ??
        fileConfig.maxKeepOpenSessions,
      'maxKeepOpenSessions',
      { min: 1, max: 10 },
    ) ?? 1,
    retryDelayMs:
      (toNumber(args['retry-delay-sec'] ?? process.env.RETRY_DELAY_SEC ?? fileDefaults.retryDelaySec, 'retryDelaySec', {
        min: 5,
        max: 600,
      }) ?? 60) * 1000,
    once,
    headless: toBool(args.headless ?? process.env.HEADLESS, true),
    userAgent: args['user-agent'] ?? process.env.USER_AGENT ?? DEFAULT_USER_AGENT,
    // Only an explicit override wins; otherwise the UA is derived from the
    // browser version actually in use so the header cannot contradict it.
    userAgentExplicit: Boolean(args['user-agent'] ?? process.env.USER_AGENT),
    chromePath: resolveChrome(args),
    chromeNoSandbox: toBool(args['chrome-no-sandbox'] ?? process.env.CHROME_NO_SANDBOX, false),
    // Optional HTTP server so the container can be deployed as a blitz.cloud
    // app (blitz requires the image to answer on a port) and expose liveness.
    port,
    bindHost,
    requireHttps,
    trustProxy,
    trustedProxyCidrs,
    sessionIdleTimeoutMs,
    statusToken,
    adminPassword,
    adminPasswordFile,
    managedTargetsFile,
    managedRecords,
    statsFile,
    publicStatus,
    webhookUrl,
    webhookMinIntervalMs,
    webhookTimeoutMs,
    webhookFailureThreshold,
    blockResourceTypes,
    targetUrlAllowlist: parseTargetUrlAllowlist(
      args['target-url-allowlist'] ?? process.env.TARGET_URL_ALLOWLIST ?? DEFAULT_TARGET_URL_ALLOWLIST,
    ),
    targetUrlAllowPrivate: toBool(
      args['target-url-allow-private'] ?? process.env.TARGET_URL_ALLOW_PRIVATE,
      false,
    ),
    targetUrlStrictSubresources: toBool(
      args['target-url-strict-subresources'] ?? process.env.TARGET_URL_STRICT_SUBRESOURCES,
      false,
    ),
    targetSecretKey,
    targetSecretKeyFile,
    logDir,
    logFile: path.join(logDir, 'keepalive.log'),
    runtimeStateFile,
    lockFile: path.resolve(args['lock-file'] ?? process.env.LOCK_FILE ?? 'keepalive.lock'),
    dumpFailures: toBool(args['dump-failures'] ?? process.env.DUMP_FAILURES, false),
    failureDumpMaxFiles: toNumber(
      args['failure-dump-max-files'] ?? process.env.FAILURE_DUMP_MAX_FILES,
      'failureDumpMaxFiles',
      { min: 1, max: 10_000 },
    ) ?? 100,
    failureDumpMaxAgeDays: toNumber(
      args['failure-dump-max-age-days'] ?? process.env.FAILURE_DUMP_MAX_AGE_DAYS,
      'failureDumpMaxAgeDays',
      { min: 1, max: 365 },
    ) ?? 7,
  };
}

async function rotateLog(logFile) {
  try {
    const info = await stat(logFile);
    if (info.size > LOG_ROTATE_BYTES) {
      const rotatedFile = `${logFile}.1`;
      await unlink(rotatedFile).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await rename(logFile, rotatedFile);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Single-instance guard. A daemon and a cron sweep must not overlap: two
 * concurrent sweeps are pointless and can double the load on blitz.cloud.
 * Returns a release function, or null when another live instance owns the lock.
 */
async function acquireLock(cfg) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(cfg.lockFile, 'wx');
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        'utf8',
      );
      await handle.close();
      return async () => {
        await unlink(cfg.lockFile).catch(() => {});
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const raw = await readFile(cfg.lockFile, 'utf8').catch(() => '');
      let pid = 0;
      let startedAt = 0;
      try {
        const parsed = JSON.parse(raw);
        pid = Number(parsed.pid);
        startedAt = Date.parse(parsed.startedAt ?? '') || 0;
      } catch {
        // Corrupted lock file: treat as stale below.
      }
      // A live PID always owns the lock. Age is only used to decide whether a
      // damaged lock (or one whose process is gone) is safe to remove. This
      // prevents a long-running daemon from being displaced after 15 minutes.
      if (isProcessAlive(pid)) return null;
      if (!Number.isInteger(pid) || pid <= 0) {
        const info = await stat(cfg.lockFile).catch(() => null);
        const stale = !info || Date.now() - info.mtimeMs > LOCK_STALE_MS;
        if (!stale) return null;
      }
      await unlink(cfg.lockFile).catch(() => {});
    }
  }
  throw new Error(`Could not acquire lock file ${cfg.lockFile}`);
}

function createLogger(cfg) {
  const recent = [];
  let writeQueue = Promise.resolve();
  const log = async (event) => {
    const entry = { ts: new Date().toISOString(), ...event };
    const line = JSON.stringify(entry);
    // stdout is captured by Task Scheduler/systemd; the file survives restarts.
    console.log(line);
    recent.push(entry);
    if (recent.length > MAX_RECENT_LOGS) recent.splice(0, recent.length - MAX_RECENT_LOGS);
    writeQueue = writeQueue
      .then(async () => {
        await rotateLog(cfg.logFile);
        await appendFile(cfg.logFile, `${line}\n`, 'utf8');
      })
      .catch((error) => {
        console.error(`failed to write log: ${error.message}`);
      });
    await writeQueue;
  };
  log.snapshot = (limit = 50) =>
    recent.slice(-Math.min(Math.max(Number(limit) || 50, 1), MAX_RECENT_LOGS));
  log.clear = async () => {
    // Remove only entries present when clear() was called. Logs queued after
    // the request remain visible and are appended after the files are reset.
    const entriesToClear = new Set(recent);
    const operation = writeQueue.then(async () => {
      for (let index = recent.length - 1; index >= 0; index -= 1) {
        if (entriesToClear.has(recent[index])) recent.splice(index, 1);
      }
      await truncate(cfg.logFile, 0).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await unlink(`${cfg.logFile}.1`).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    });
    writeQueue = operation.catch((error) => {
      console.error(`failed to clear log: ${error.message}`);
    });
    await operation;
    return entriesToClear.size;
  };
  return log;
}

function createRuntimeStateStore(cfg, log) {
  let timer = null;
  let writeQueue = Promise.resolve();

  const snapshot = () => ({
    version: RUNTIME_STATE_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    targets: Object.fromEntries(
      cfg.targets.map((target) => [
        target.id,
        {
          paused: Boolean(target.paused),
          pauseReason: target.pauseReason ?? null,
          pausedUntil: target.pausedUntil ?? null,
          lastResult: target.lastResult ?? null,
          lastVisit: publicVisit(target.lastVisit),
          lastSuccessfulVisitAt: target.lastSuccessfulVisitAt ?? null,
          consecutiveFailures: Math.max(0, Number(target.consecutiveFailures) || 0),
          authFailureCount: Math.max(0, Number(target.authFailureCount) || 0),
          firstVisitWindowKey:
            typeof target.firstVisitWindowKey === 'string' ? target.firstVisitWindowKey : null,
          nextDue: Number.isFinite(target.nextDue) ? new Date(target.nextDue).toISOString() : null,
        },
      ]),
    ),
  });

  const flush = async () => {
    await writeJsonFileAtomic(cfg.runtimeStateFile, snapshot());
  };

  const schedule = () => {
    if (cfg.once) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      writeQueue = writeQueue.then(flush).catch((error) => {
        void log({ level: 'warn', event: 'runtime-state-write-failed', error: error.message });
      });
    }, RUNTIME_STATE_DEBOUNCE_MS);
    timer.unref?.();
  };

  return {
    async load() {
      if (!existsSync(cfg.runtimeStateFile)) return;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(cfg.runtimeStateFile, 'utf8').replace(/^\uFEFF/, ''));
      } catch (error) {
        throw new Error(`Runtime state file ${cfg.runtimeStateFile} is not valid JSON: ${error.message}`);
      }
      if (parsed?.version !== RUNTIME_STATE_FILE_VERSION) {
        throw new Error(
          `Runtime state file version ${parsed?.version ?? 'missing'} is not supported (expected ${RUNTIME_STATE_FILE_VERSION}).`,
        );
      }
      if (parsed.targets === null || typeof parsed.targets !== 'object' || Array.isArray(parsed.targets)) {
        throw new Error('Runtime state file must contain a targets object.');
      }
      const byId = new Map(cfg.targets.map((target) => [target.id, target]));
      for (const [id, state] of Object.entries(parsed.targets)) {
        const target = byId.get(id);
        if (!target || state === null || typeof state !== 'object' || Array.isArray(state)) continue;
        target.paused = state.paused === true;
        target.pauseReason = target.paused && typeof state.pauseReason === 'string' ? state.pauseReason.slice(0, 240) : null;
        target.pausedUntil = target.paused && typeof state.pausedUntil === 'string' ? state.pausedUntil : null;
        target.lastResult = ['ok', 'failed'].includes(state.lastResult) ? state.lastResult : null;
        target.lastVisit = publicVisit(state.lastVisit);
        target.lastSuccessfulVisitAt =
          typeof state.lastSuccessfulVisitAt === 'string' ? state.lastSuccessfulVisitAt : null;
        target.consecutiveFailures = Math.max(0, Math.trunc(Number(state.consecutiveFailures) || 0));
        target.authFailureCount = Math.max(0, Math.trunc(Number(state.authFailureCount) || 0));
        target.firstVisitWindowKey =
          typeof state.firstVisitWindowKey === 'string' && state.firstVisitWindowKey.length <= 128
            ? state.firstVisitWindowKey
            : null;
        const nextDue = Date.parse(state.nextDue ?? '');
        target.nextDue = target.paused ? null : Number.isFinite(nextDue) ? nextDue : 0;
      }
    },
    schedule,
    async flushNow() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await writeQueue;
      if (!cfg.once) await flush();
    },
  };
}

async function readPageState(page) {
  return page.evaluate(() => ({
    title: document.title || '',
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 5000),
    ready: document.readyState,
  }));
}

/**
 * The blitz.cloud waking page reloads itself once the app answers, which
 * destroys the JS execution context. Poll instead of waiting on a single
 * evaluate() call.
 */
async function waitForApp(
  target,
  page,
  {
    requireExpect = true,
    wakeWaitMs = target.wakeWaitMs,
    initialStatus = null,
    timeoutMs = target.timeoutMs,
  } = {},
) {
  // Wake pages are served with HTTP 200 and real text, so "wait until it looks
  // ready" is not enough — the app itself can need far longer than wakeWaitSec
  // to finish booting. When the target opts into wakeExtensionMs, a page that
  // still looks like a wake page keeps buying more time (rolling 15s windows)
  // up to a hard ceiling, instead of being reported as a failure at wakeWaitMs.
  const wakeExtensionMs = Math.max(0, Number(target.wakeExtensionMs) || 0);
  const startedAt = Date.now();
  const hardDeadline = startedAt + wakeWaitMs + wakeExtensionMs;
  let deadline = startedAt + wakeWaitMs;
  let currentStatus = initialStatus;
  let state = { title: '', text: '', ready: 'loading' };
  let verdict = { awake: false, reason: 'loading' };
  let lastReloadAt = Date.now();
  const looksLikeWakePage = () =>
    currentStatus === 503 ||
    currentStatus === 502 ||
    currentStatus === 504 ||
    verdict.reason.startsWith('not-ready:') ||
    verdict.reason === 'page-too-short';
  for (;;) {
    try {
      state = await readPageState(page);
      verdict = classify(target, state, { requireExpect, status: currentStatus });
    } catch (error) {
      // Navigation in progress (wake page reloading itself): retry.
      state = { ...state, ready: 'loading' };
      verdict = { awake: false, reason: `navigating:${error.message.slice(0, 80)}` };
    }
    if (verdict.awake) return { ...verdict, ...state, status: currentStatus };
    if (wakeExtensionMs > 0 && looksLikeWakePage()) {
      deadline = Math.min(hardDeadline, Math.max(deadline, Date.now() + 15_000));
    }
    if (Date.now() >= deadline) {
      // "loading"/"navigating:*" only describe why the last poll failed; after
      // the wake window expires the actionable reason is that the app never
      // became ready.
      const timedOut =
        !verdict.reason ||
        verdict.reason === 'loading' ||
        verdict.reason.startsWith('navigating:');
      return {
        ...verdict,
        ...state,
        status: currentStatus,
        reason: timedOut ? 'not-ready-timeout' : verdict.reason,
      };
    }

    const isWaking = looksLikeWakePage();

    if (isWaking && Date.now() - lastReloadAt >= 4_000) {
      lastReloadAt = Date.now();
      try {
        const reloadResponse = await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: Math.min(timeoutMs, 15_000),
        });
        if (reloadResponse) {
          currentStatus = reloadResponse.status();
        }
      } catch {
        // Reload failed or in progress; poll again on next iteration
      }
    } else {
      await sleep(2000);
    }
  }
}

function createLoginVisitState(target) {
  return {
    loginPasswordConfigured: Boolean(target.loginPassword),
    loginPasswordFieldFound: false,
    loginAttempted: false,
    loginSubmitted: false,
    loginVerified: false,
  };
}

async function clearPasswordFields(page) {
  for (const frame of page.frames()) {
    await frame
      .evaluate(() => {
      for (const input of document.querySelectorAll('input[type="password"]')) {
        input.value = '';
        input.removeAttribute('value');
      }
      })
      .catch(() => {});
  }
}

async function findVisiblePasswordField(page) {
  for (const frame of page.frames()) {
    let fields;
    try {
      fields = await frame.$$('input[type="password"]');
    } catch {
      continue;
    }
    for (const field of fields) {
      let visible = false;
      try {
        visible = await field.evaluate((input) => {
          const style = window.getComputedStyle(input);
          const rect = input.getBoundingClientRect();
          return (
            !input.disabled &&
            !input.readOnly &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0 &&
            input.getClientRects().length > 0
          );
        });
      } catch {
        // The wake page can replace the document while it is being inspected.
      }
      if (visible) return { frame, field };
      await field.dispose().catch(() => {});
    }
  }
  return null;
}

async function selectorVisible(page, selector) {
  if (!selector) return true;
  for (const frame of page.frames()) {
    let matches;
    try {
      matches = await frame.$$(selector);
    } catch {
      return false;
    }
    try {
      for (const match of matches) {
        const visible = await match.evaluate((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0 &&
            element.getClientRects().length > 0
          );
        }).catch(() => false);
        if (visible) return true;
      }
    } finally {
      await Promise.all(matches.map((match) => match.dispose().catch(() => {})));
    }
  }
  return false;
}

async function findSubmitControl(passwordField) {
  const handle = await passwordField.evaluateHandle((input) => {
    const form = input.form;
    if (!form) return null;
    return (
      [...form.querySelectorAll('button, input[type="submit"]')].find((control) => {
        const tag = control.tagName;
        const type = control.getAttribute('type');
        const isSubmit =
          tag === 'INPUT' ? type === 'submit' : type === null || type === 'submit';
        if (!isSubmit || control.disabled) return false;
        const style = window.getComputedStyle(control);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          control.getClientRects().length > 0
        );
      }) ?? null
    );
  });
  const element = handle.asElement();
  if (!element) {
    await handle.dispose().catch(() => {});
    return null;
  }
  return element;
}

async function attemptTargetLogin(target, page, loginState, { timeoutMs = target.timeoutMs } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const found = await findVisiblePasswordField(page);
    if (!found) {
      if (attempt === 1) await sleep(400);
      continue;
    }

    loginState.loginPasswordFieldFound = true;
    loginState.loginAttempted = true;
    try {
      await found.field.click({ clickCount: 3 });
      // Type with a human-like cadence and let framework-backed forms observe
      // the same input/change events a real keyboard would emit.
      await found.field.type(target.loginPassword, { delay: 45 });
      await found.field.evaluate((input) => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const submitControl = await findSubmitControl(found.field);
      const navigation = page
        .waitForNavigation({
          waitUntil: 'domcontentloaded',
          timeout: Math.min(timeoutMs, 5_000),
        })
        .catch(() => null);
      try {
        if (submitControl) await submitControl.click();
        else await found.field.press('Enter');
      } finally {
        await submitControl?.dispose().catch(() => {});
      }
      // SPA logins may not navigate. The caller polls the final page state next.
      const navigationResponse = await Promise.race([navigation, sleep(1_500)]);
      loginState.loginSubmitted = true;
      return navigationResponse?.status?.() ?? null;
    } catch (error) {
      lastError = error;
      await clearPasswordFields(page);
      if (attempt === 1) await sleep(400);
    }
  }
  if (lastError) {
    throw new LoginFlowError('login-submit-failed', lastError.message);
  }
  throw new LoginFlowError('login-form-missing', '未找到可用的目标登录密码框。');
}

async function waitForLoginSuccess(
  target,
  page,
  loginState,
  { wakeWaitMs = target.wakeWaitMs, initialStatus = null } = {},
) {
  const deadline = Date.now() + wakeWaitMs;
  let state = { title: '', text: '', ready: 'loading' };
  let passwordField = null;
  if ([502, 503, 504].includes(initialStatus)) {
    return {
      ok: false,
      state,
      reason: `not-ready:http-${initialStatus}`,
      status: initialStatus,
    };
  }
  for (;;) {
    try {
      state = await readPageState(page);
    } catch (error) {
      state = { ...state, ready: 'loading', reason: error.message.slice(0, 80) };
    }
    passwordField = await findVisiblePasswordField(page).catch(() => null);
    const selectorOk = await selectorVisible(page, target.loginSuccessSelector);
    const expectOk = !target.expectText || state.text.includes(target.expectText);
    const notReady = target.notReadyPatterns.some((pattern) => pattern.test(state.text));
    if (!passwordField && state.ready === 'complete' && selectorOk && expectOk && !notReady) {
      loginState.loginVerified = true;
      return { ok: true, state, status: initialStatus };
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        state,
        reason: passwordField ? 'auth-failed' : 'not-ready',
        status: initialStatus,
      };
    }
    await sleep(1_000);
  }
}

function safeFilePart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'target';
}

async function dumpFailure(cfg, target, page, tag) {
  if (!cfg.dumpFailures) return {};
  await clearPasswordFields(page);
  const dir = path.join(cfg.logDir, 'failures');
  await mkdir(dir, { recursive: true }).catch(() => {});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${stamp}-${safeFilePart(target.id)}-${tag}`;
  const htmlName = `${base}.html`;
  const shotName = `${base}.png`;
  const written = {};
  try {
    const html = await page.content();
    await writeFile(path.join(dir, htmlName), html, 'utf8');
    written.html = htmlName;
  } catch {
    // Page may be mid-navigation; a missing dump must not fail the cycle.
  }
  try {
    await page.screenshot({ path: path.join(dir, shotName), fullPage: false });
    written.screenshot = shotName;
  } catch {
    // Same as above.
  }
  return written;
}

async function cleanupFailureDumps(cfg) {
  if (!cfg.dumpFailures) return;
  const dir = path.join(cfg.logDir, 'failures');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:html|png)$/i.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      const info = await stat(file);
      candidates.push({ file, mtimeMs: info.mtimeMs });
    } catch {
      // A concurrent cleanup or failed write may remove the file first.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const cutoff = Date.now() - cfg.failureDumpMaxAgeDays * 24 * 60 * 60 * 1000;
  await Promise.all(
    candidates.map((entry, index) =>
      index >= cfg.failureDumpMaxFiles || entry.mtimeMs < cutoff
        ? unlink(entry.file).catch(() => {})
        : undefined,
    ),
  );
}

async function configureTargetPage(cfg, target, page, { timeoutMs = target.timeoutMs } = {}) {
  const userAgent = cfg.userAgentExplicit ? cfg.userAgent : await userAgentForPage(page);
  await page.setUserAgent(userAgent);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  if (target.proxy?.username) {
    await page.authenticate({
      username: target.proxy.username,
      password: target.proxy.password,
    });
  }
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    void (async () => {
      if (request.isInterceptResolutionHandled()) return;
      try {
        const requestUrl = new URL(request.url());
        if (['data:', 'blob:', 'about:'].includes(requestUrl.protocol)) {
          await request.continue();
          return;
        }
        if (!['http:', 'https:'].includes(requestUrl.protocol)) {
          await request.abort('blockedbyclient');
          return;
        }
        if (
          Array.isArray(cfg.blockResourceTypes) &&
          cfg.blockResourceTypes.includes(request.resourceType())
        ) {
          await request.abort('blockedbyclient');
          return;
        }
        const enforceAllowlist =
          cfg.targetUrlStrictSubresources ||
          (request.isNavigationRequest() && request.frame() === page.mainFrame());
        await validateTargetUrl(request.url(), cfg, { enforceAllowlist });
        await request.continue();
      } catch {
        await request.abort('blockedbyclient').catch(() => {});
      }
    })();
  });
}

async function loadTargetPage(
  cfg,
  target,
  page,
  {
    timeoutMs = target.timeoutMs,
    wakeWaitMs = target.wakeWaitMs,
    loginState = createLoginVisitState(target),
    dumpOnFailure = true,
  } = {},
) {
  let response;
  try {
    response = await page.goto(target.url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
  } catch (error) {
    const described = describeVisitError(error);
    return {
      ok: false,
      page,
      reason: described.reason,
      status: null,
      title: '',
      url: page.url(),
      ...loginState,
    };
  }

  if (response?.status() === 407) {
    const dump = dumpOnFailure ? await dumpFailure(cfg, target, page, 'proxy-auth') : {};
    return {
      ok: false,
      page,
      reason: 'proxy-auth-rejected',
      status: 407,
      title: '',
      url: page.url(),
      ...loginState,
      ...dump,
    };
  }

  let state;
  let loginNavigationStatus = null;
  if (target.loginPassword) {
    state = await waitForApp(target, page, {
      requireExpect: false,
      wakeWaitMs,
      initialStatus: response?.status() ?? null,
      timeoutMs,
    });
    if (!state.awake) {
      const dump = dumpOnFailure ? await dumpFailure(cfg, target, page, 'not-ready') : {};
      return {
        ok: false,
        page,
        reason: state.reason,
        status: state.status ?? response?.status() ?? null,
        title: state.title,
        url: page.url(),
        ...loginState,
        ...dump,
      };
    }
    try {
      loginNavigationStatus = await attemptTargetLogin(target, page, loginState, { timeoutMs });
    } catch (error) {
      const reason = error instanceof LoginFlowError ? error.code : 'login-submit-failed';
      await clearPasswordFields(page);
      const dump = dumpOnFailure ? await dumpFailure(cfg, target, page, reason) : {};
      return {
        ok: false,
        page,
        reason,
        status: response?.status() ?? null,
        title: '',
        url: page.url(),
        ...loginState,
        ...dump,
      };
    }

    const loginResult = await waitForLoginSuccess(target, page, loginState, {
      wakeWaitMs,
      initialStatus: loginNavigationStatus,
    });
    if (!loginResult.ok) {
      await clearPasswordFields(page);
      const dump = dumpOnFailure ? await dumpFailure(cfg, target, page, 'login-verify') : {};
      return {
        ok: false,
        page,
        reason: loginResult.reason,
        status: loginResult.status ?? loginNavigationStatus ?? response?.status() ?? null,
        title: loginResult.state.title,
        url: page.url(),
        ...loginState,
        ...dump,
      };
    }
  }

  state = await waitForApp(target, page, {
    wakeWaitMs,
    initialStatus: loginNavigationStatus ?? state?.status ?? response?.status() ?? null,
    timeoutMs,
  });
  if (!state.awake) {
    const dump = dumpOnFailure ? await dumpFailure(cfg, target, page, 'not-ready') : {};
    return {
      ok: false,
      page,
      reason: state.reason,
      status: state.status ?? response?.status() ?? null,
      title: state.title,
      url: page.url(),
      ...loginState,
      ...dump,
    };
  }

  return {
    ok: true,
    reason: 'ready',
    page,
    status: state.status ?? response?.status() ?? null,
    title: state.title,
    url: page.url(),
    state,
    ...loginState,
  };
}

async function openTargetPage(cfg, target, browser, options = {}) {
  await validateTargetUrl(target.url, cfg);
  let page = null;
  try {
    page = await browser.newPage();
    await configureTargetPage(cfg, target, page, options);
    return await loadTargetPage(cfg, target, page, options);
  } catch (error) {
    const described = describeVisitError(error);
    return {
      ok: false,
      page,
      reason: described.reason,
      status: null,
      title: '',
      url: page?.url?.() ?? target.url,
      ...createLoginVisitState(target),
    };
  }
}
function browserLaunchArgs(cfg, target, resolverRules = null) {
  const args = [
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=1366,900',
    '--lang=en-US',
    // Keep proxy traffic (and bandwidth) limited to the target itself.
    '--disable-component-update',
    '--disable-sync',
    '--disable-domain-reliability',
    '--disable-background-mode',
    '--no-pings',
  ];
  if (cfg.chromeNoSandbox) args.unshift('--no-sandbox');
  if (target.proxy) {
    // Credentials are intentionally not part of --proxy-server; Chromium strips
    // them. They are supplied per page through page.authenticate().
    args.push(`--proxy-server=${target.proxy.server}`);
    if (target.proxy.bypass) args.push(`--proxy-bypass-list=${target.proxy.bypass}`);
  } else {
    // direct and inherit-without-global-proxy must not fall back to system/env proxy.
    args.push('--no-proxy-server');
    // Pin the hostname to the addresses that passed validation. Without this the
    // browser resolves the name again at connect time, so a DNS answer that
    // changes in between could point it at a private address (rebinding).
    // Proxied targets skip the pin: the proxy resolves, not the browser.
    if (resolverRules) args.push(`--host-resolver-rules=${resolverRules}`);
  }
  return args;
}

/**
 * Opens a target once and reports what the browser actually saw. Used by
 * `--probe` and by the management console's "test connection" button, so it
 * must never touch runtime state, scheduling or the statistics store.
 */
async function probeTarget(cfg, target, { timeoutMs, wakeWaitMs, deadlineMs } = {}) {
  const { hostname: pinnedHost, addresses: pinnedAddresses } = await resolveTargetUrl(
    target.url,
    cfg,
  );
  const startedAt = Date.now();
  const effectiveTimeout = timeoutMs ?? Math.min(target.timeoutMs, 30_000);
  // A probe is an interactive diagnostic; never block an HTTP request for the
  // full first-visit wake window (up to 300s). The 90s cap matches the default
  // wakeWaitSec so the button agrees with what the scheduler would do — capping
  // it lower made probes report "not ready" for apps the scheduler handles fine.
  const effectiveWakeWait = wakeWaitMs ?? Math.min(target.wakeWaitMs, 90_000);
  const budgetMs = Math.max(
    PROBE_DEADLINE_FLOOR_MS,
    Math.min(
      PROBE_DEADLINE_CEILING_MS,
      effectiveTimeout + effectiveWakeWait + PROBE_DEADLINE_SLACK_MS,
    ),
  );
  const requestedDeadline = Number(deadlineMs);
  const deadlineAt = startedAt + (requestedDeadline > 0 ? requestedDeadline : budgetMs);

  const browser = await puppeteer.launch({
    executablePath: cfg.chromePath,
    headless: cfg.headless,
    defaultViewport: { width: 1366, height: 900 },
    args: browserLaunchArgs(cfg, target, buildResolverRules(pinnedHost, pinnedAddresses)),
  });
  ACTIVE_BROWSERS.add(browser);

  let watchdog = null;
  try {
    const steps = (async () => {
      const page = await browser.newPage();
      await configureTargetPage(cfg, target, page, { timeoutMs: effectiveTimeout });
      const opened = await loadTargetPage(cfg, target, page, {
        timeoutMs: effectiveTimeout,
        wakeWaitMs: effectiveWakeWait,
        dumpOnFailure: false,
      });
      let state = opened.state;
      if (!state) {
        state = await readPageState(page).catch(() => ({ title: '', text: '', ready: 'unknown' }));
      }
      const text = typeof state.text === 'string' ? state.text : '';
      const matchedNotReadyPatterns = (target.notReadyPatterns ?? [])
        .filter((pattern) => pattern.test(text))
        .map((pattern) => pattern.source);
      const passwordField = await findVisiblePasswordField(page).catch(() => null);
      if (passwordField?.field) await passwordField.field.dispose().catch(() => {});
      return {
        ok: Boolean(opened.ok),
        reason: opened.reason ?? 'ready',
        httpStatus: opened.status ?? null,
        title: state.title ?? '',
        readyState: state.ready ?? null,
        finalUrl: page.url(),
        ms: Date.now() - startedAt,
        matchedNotReadyPatterns,
        expectTextConfigured: Boolean(target.expectText),
        expectTextFound: target.expectText ? text.includes(target.expectText) : null,
        passwordFieldFound: Boolean(passwordField),
        loginPasswordConfigured: Boolean(target.loginPassword),
        textPreview: text.slice(0, 300),
        proxy: redactProxy(target.proxy),
      };
    })();
    // The watchdog wins the race when the browser stops answering. Keep a
    // handler on the losing promise so its late rejection is never reported as
    // an unhandled rejection once the browser is closed underneath it.
    void steps.catch(() => {});

    return await Promise.race([
      steps,
      new Promise((_resolve, reject) => {
        watchdog = setTimeout(() => {
          const error = new Error(
            `探测超时：${Math.round((Date.now() - startedAt) / 1000)} 秒内未完成，页面或浏览器无响应。`,
          );
          error.code = 'probe-timeout';
          reject(error);
        }, Math.max(0, deadlineAt - Date.now()));
        watchdog.unref?.();
      }),
    ]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await closeBrowser(browser);
  }
}

async function runProbeCli(cfg) {
  let target;
  try {
    target = normalizeTarget({ id: 'probe', url: cfg.probeUrl }, cfg.globals, 0);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 2;
    return;
  }
  try {
    const result = await probeTarget(cfg, target);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.log(
      JSON.stringify(
        { ok: false, error: String(error?.message ?? error).slice(0, 300) },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

async function visitOnce(
  cfg,
  target,
  { timeoutMs = target.timeoutMs, wakeWaitMs = target.wakeWaitMs } = {},
) {
  // resolveTargetUrl validates (allowlist + private address) and hands back the
  // addresses so the browser can be pinned to them.
  const { hostname: pinnedHost, addresses: pinnedAddresses } = await resolveTargetUrl(
    target.url,
    cfg,
  );
  const args = browserLaunchArgs(cfg, target, buildResolverRules(pinnedHost, pinnedAddresses));

  const browser = await puppeteer.launch({
    executablePath: cfg.chromePath,
    headless: cfg.headless,
    defaultViewport: { width: 1366, height: 900 },
    args,
  });
  ACTIVE_BROWSERS.add(browser);

  try {
    const opened = await openTargetPage(cfg, target, browser, {
      timeoutMs,
      wakeWaitMs,
      dumpOnFailure: true,
    });
    if (!opened.ok) {
      const { page: _page, ...result } = opened;
      return result;
    }

    const page = opened.page;
    // Behave like a short human visit: give the app time to finish booting and
    // touch the page once, without inflating memory on the blitz side.
    const viewport = page.viewport() ?? { width: 1366, height: 900 };
    await page.mouse
      .move(
        Math.floor(viewport.width * (0.35 + Math.random() * 0.3)),
        Math.floor(viewport.height * (0.35 + Math.random() * 0.3)),
        { steps: 7 },
      )
      .catch(() => {});
    await page
      .evaluate(() => window.scrollTo(0, Math.min(200, document.body.scrollHeight)))
      .catch(() => {});
    await waitForStop(target.settleMs);

    const { page: _page, state: _state, ...result } = opened;
    return result;
  } finally {
    await closeBrowser(browser);
  }
}
function createStatus(cfg) {
  return {
    startedAt: new Date().toISOString(),
    targetCount: cfg.targets.length,
    visits: 0,
    failures: 0,
    sweeps: 0,
    lastSweepAt: null,
    lastVisitAt: null,
    lastVisitOk: null,
    lastTarget: null,
    lastError: null,
    // Heartbeat for the scheduler loop. A frozen loop keeps /healthz green while
    // no target is ever visited again, so /readyz and /metrics watch this.
    lastLoopAt: Date.now(),
  };
}

function recordVisit(status, target, result, { ms = 0 } = {}) {
  status.visits += 1;
  status.lastVisitAt = new Date().toISOString();
  status.lastVisitOk = Boolean(result.ok);
  status.lastTarget = target.id;
  if (result.ok) {
    status.lastError = null;
  } else {
    status.failures += 1;
    status.lastError = String(result.reason ?? 'unknown').slice(0, 200);
  }
  const durationSec = Math.max(0, Number(ms) || 0) / 1000;
  target.durationCount = (target.durationCount ?? 0) + 1;
  target.durationSum = (target.durationSum ?? 0) + durationSec;
  target.durationBuckets ??= VISIT_DURATION_BUCKETS_SEC.map(() => 0);
  for (let index = 0; index < VISIT_DURATION_BUCKETS_SEC.length; index += 1) {
    if (durationSec <= VISIT_DURATION_BUCKETS_SEC[index]) {
      target.durationBuckets[index] += 1;
      break;
    }
  }
  statsStore?.recordVisit({ ok: Boolean(result.ok), ms });
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function serveStatic(res, asset) {
  try {
    const body = await readFile(path.join(PUBLIC_DIR, asset.file));
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': asset.type,
      'cache-control': 'no-cache',
      'content-length': body.length,
    });
    res.end(body);
  } catch (error) {
    console.error(`failed to serve ${asset.file}: ${error.message}`);
    if (!res.headersSent) sendText(res, 404, 'not found');
  }
}

function acceptsHtml(req) {
  return String(req.headers.accept ?? '')
    .split(',')
    .some((part) => part.trim().toLowerCase().startsWith('text/html'));
}

function hashSecret(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function secretMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const left = hashSecret(actual);
  const right = hashSecret(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(rawHeader) {
  const cookies = new Map();
  if (typeof rawHeader !== 'string') return cookies;
  for (const part of rawHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      cookies.set(name, rawValue);
    }
  }
  return cookies;
}

function createSessionStore(idleTimeoutMs) {
  const sessions = new Map();
  const prune = () => {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (session.expiresAt <= now || now - session.lastSeenAt >= idleTimeoutMs) {
        sessions.delete(key);
      }
    }
  };
  return {
    create() {
      prune();
      const token = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
      sessions.set(hashSecret(token).toString('hex'), {
        expiresAt,
        lastSeenAt: Date.now(),
      });
      return { token, expiresAt };
    },
    verify(token) {
      if (typeof token !== 'string' || !token) return false;
      prune();
      const key = hashSecret(token).toString('hex');
      const session = sessions.get(key);
      const now = Date.now();
      if (
        !session ||
        session.expiresAt <= now ||
        now - session.lastSeenAt >= idleTimeoutMs
      ) {
        if (session) sessions.delete(key);
        return false;
      }
      session.lastSeenAt = now;
      return true;
    },
    destroy(token) {
      if (typeof token === 'string' && token) {
        sessions.delete(hashSecret(token).toString('hex'));
      }
    },
    clear() {
      sessions.clear();
    },
  };
}

function createLoginLimiter() {
  const entries = new Map();
  const prune = (now) => {
    for (const [key, entry] of entries) {
      const recent = entry.failures.filter((timestamp) => now - timestamp < LOGIN_WINDOW_MS);
      if (recent.length === 0 && entry.lockedUntil <= now) entries.delete(key);
      else entry.failures = recent;
    }
  };
  return {
    retryAfterSec(key) {
      const now = Date.now();
      prune(now);
      const entry = entries.get(key);
      if (!entry || entry.lockedUntil <= now) return 0;
      return Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000));
    },
    recordFailure(key) {
      const now = Date.now();
      prune(now);
      const entry = entries.get(key) ?? { failures: [], lockedUntil: 0 };
      entry.failures = entry.failures.filter((timestamp) => now - timestamp < LOGIN_WINDOW_MS);
      entry.failures.push(now);
      if (entry.failures.length >= LOGIN_MAX_FAILURES) {
        entry.lockedUntil = now + LOGIN_LOCK_MS;
        entry.failures = [];
      }
      entries.set(key, entry);
    },
    reset(key) {
      entries.delete(key);
    },
  };
}

function createAdminAuth(cfg) {
  const sessions = createSessionStore(cfg.sessionIdleTimeoutMs);
  const limiter = createLoginLimiter();
  let passwordRecord = readAdminPasswordFile(cfg.adminPasswordFile);
  let passwordChangeQueue = Promise.resolve();

  const passwordConfigured = () => Boolean(passwordRecord || cfg.adminPassword);
  const required = () => passwordConfigured();
  const verifyPassword = async (password) => {
    if (passwordRecord) return verifyAdminPassword(password, passwordRecord);
    return secretMatches(password, cfg.adminPassword);
  };

  return {
    sessions,
    limiter,
    get required() {
      return required();
    },
    get passwordConfigured() {
      return passwordConfigured();
    },
    get passwordChangeAvailable() {
      return required();
    },
    get passwordFileExists() {
      return existsSync(cfg.adminPasswordFile);
    },
    tokenConfigured: Boolean(cfg.statusToken),
    verifyPassword,
    async changePassword(currentPassword, newPassword) {
      const operation = passwordChangeQueue.then(async () => {
        if (!(await verifyPassword(currentPassword))) {
          return { ok: false, reason: 'invalid-current' };
        }

        const nextRecord = await createAdminPasswordRecord(newPassword);
        await writeAdminPasswordFile(cfg.adminPasswordFile, nextRecord);
        passwordRecord = nextRecord;

        // Invalidate every old session before issuing a fresh one to the
        // browser that successfully completed the password change.
        sessions.clear();
        const session = sessions.create();
        return { ok: true, session };
      });
      passwordChangeQueue = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
}

function authenticateRequest(cfg, req, admin) {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.get(ADMIN_COOKIE_NAME);
  if (sessionToken && admin.sessions.verify(sessionToken)) {
    return {
      authorized: true,
      adminAuthorized: true,
      via: 'session',
      sessionToken,
    };
  }

  const rawHeader = req.headers['x-status-token'];
  const headerToken = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const authorization = req.headers.authorization;
  const bearer =
    typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)
      ? authorization.replace(/^Bearer\s+/i, '')
      : '';
  if (
    cfg.statusToken &&
    [headerToken, bearer].some((candidate) =>
      secretMatches(candidate, cfg.statusToken),
    )
  ) {
    return {
      authorized: true,
      adminAuthorized: false,
      via: 'token',
      sessionToken: null,
    };
  }
  if (!admin.required) {
    return {
      authorized: true,
      adminAuthorized: true,
      via: 'open',
      sessionToken: null,
    };
  }
  return {
    authorized: false,
    adminAuthorized: false,
    via: null,
    sessionToken: null,
  };
}

function directClientIp(req) {
  return normalizeIpAddress(req.socket?.remoteAddress)?.address ?? 'unknown';
}

function requestComesFromTrustedProxy(cfg, req) {
  return Boolean(
    cfg.trustProxy &&
      isTrustedProxyAddress(cfg.trustedProxyCidrs, req.socket?.remoteAddress),
  );
}

function getClientIp(cfg, req) {
  if (!requestComesFromTrustedProxy(cfg, req)) return directClientIp(req);
  const forwardedFor = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)
    ?.split(',')[0]
    ?.trim();
  return normalizeIpAddress(first)?.address ?? directClientIp(req);
}

function isSecureRequest(cfg, req) {
  if (req.socket?.encrypted) return true;
  if (!requestComesFromTrustedProxy(cfg, req)) return false;
  const forwardedProto = req.headers['x-forwarded-proto'];
  return typeof forwardedProto === 'string' && forwardedProto.split(',')[0].trim() === 'https';
}

function sessionCookieHeader(cfg, req, token) {
  const secure = isSecureRequest(cfg, req) ? '; Secure' : '';
  return `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
    ADMIN_SESSION_TTL_MS / 1000,
  )}${secure}`;
}

function clearSessionCookieHeader(cfg, req) {
  const secure = isSecureRequest(cfg, req) ? '; Secure' : '';
  return `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
}

function requestOriginAllowed(req) {
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && !['same-origin', 'none'].includes(fetchSite)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === req.headers.host;
  } catch {
    return false;
  }
}

function readJsonBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] ?? '');
    if (!/^application\/(?:[^;\s]+\+)?json(?:\s*;|$)/i.test(contentType)) {
      reject(new HttpError(415, '请求必须使用 application/json。'));
      req.resume();
      return;
    }

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      reject(new HttpError(413, '请求内容过大。'));
      req.resume();
      return;
    }

    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(new HttpError(413, '请求内容过大。'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (total === 0) {
        reject(new HttpError(400, '请求内容不能为空。'));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(new HttpError(400, '请求内容不是有效 JSON。'));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new HttpError(400, '请求内容必须是 JSON 对象。'));
        return;
      }
      resolve(parsed);
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function publicVisit(visit) {
  if (!visit || typeof visit !== 'object') return null;
  return {
    ok: Boolean(visit.ok),
    reason: visit.reason ?? null,
    status: visit.status ?? null,
    title: visit.title ?? null,
    url: visit.url ?? null,
    at: visit.at ?? null,
    attempts: visit.attempts ?? null,
    ms: visit.ms ?? null,
    loginPasswordConfigured: Boolean(visit.loginPasswordConfigured),
    loginPasswordFieldFound: Boolean(visit.loginPasswordFieldFound),
    loginAttempted: Boolean(visit.loginAttempted),
    loginSubmitted: Boolean(visit.loginSubmitted),
  };
}



function buildReadinessPayload(cfg, now = Date.now(), keepOpenManager = null) {
  const activeTargets = cfg.targets.filter(
    (target) =>
      !target.paused &&
      !getScheduleState(target, now, cfg.scheduleTimeZone).scheduledOff,
  );
  const issues = activeTargets
    .map((target) => ({
      id: target.id,
      reasons: targetReadinessIssues(
        target,
        now,
        cfg.scheduleTimeZone,
        keepOpenManager,
      ),
    }))
    .filter((target) => target.reasons.length > 0);
  const ready = issues.length === 0;
  return {
    status: ready ? 'ready' : 'not-ready',
    ready,
    checkedAt: new Date(now).toISOString(),
    targetCount: cfg.targets.length,
    activeTargetCount: activeTargets.length,
    issueCount: issues.length,
    issues,
  };
}

function publicTargetRuntime(target, cfg = null, keepOpenManager = null) {
  const timeZone = cfg?.scheduleTimeZone ?? DEFAULT_SCHEDULE_TIMEZONE;
  const readinessIssues = targetReadinessIssues(
    target,
    Date.now(),
    timeZone,
    keepOpenManager,
  );
  const scheduleState = getScheduleState(target, Date.now(), timeZone);
  const stayStatus = keepOpenManager?.getTargetStayStatus(target.id) ?? { active: false, durationSec: 0 };
  return {
    id: target.id,
    account: target.account,
    loginPasswordConfigured: Boolean(target.loginPasswordConfigured),
    loginSuccessSelector: target.loginSuccessSelector || null,
    nextDue: target.nextDue ? new Date(target.nextDue).toISOString() : null,
    lastResult: target.lastResult,
    lastVisit: publicVisit(target.lastVisit),
    lastSuccessfulVisitAt: target.lastSuccessfulVisitAt ?? null,
    consecutiveFailures: target.consecutiveFailures ?? 0,
    authFailureCount: target.authFailureCount ?? 0,
    paused: Boolean(target.paused),
    pauseReason: target.pauseReason ?? null,
    pausedUntil: target.pausedUntil ?? null,
    running: Boolean(target.running),
    overdue: readinessIssues.includes('schedule-overdue'),
    readinessIssues,
    wakeWaitSec: Math.round(target.wakeWaitMs / 1000),
    wakeExtensionSec: Math.round((Number(target.wakeExtensionMs) || 0) / 1000),
    minReadyTextLength: Math.max(0, Number(target.minReadyTextLength) || 0),
    proxyMode: target.proxyMode ?? (target.proxy ? 'custom' : 'direct'),
    proxyUsername: target.proxyUsername || null,
    proxyBypass: target.proxy?.bypass || null,
    proxyPasswordConfigured: Boolean(target.proxyPasswordConfigured),
    proxy: redactProxy(target.proxy),
    scheduleEnabled: Boolean(target.scheduleEnabled),
    scheduleStart: target.scheduleStart,
    scheduleEnd: target.scheduleEnd,
    scheduleDays: target.scheduleDays,
    scheduleTimezone: target.scheduleTimezone ?? null,
    effectiveScheduleTimezone: scheduleState.timeZone ?? timeZone,
    firstVisitWakeWaitSec: target.firstVisitWakeWaitSec,
    firstVisitTimeoutSec: target.firstVisitTimeoutSec,
    firstVisitRetries: target.firstVisitRetries,
    scheduleActive: scheduleState.active,
    scheduledOff: scheduleState.scheduledOff,
    scheduleNextStart: scheduleState.nextStartAt,
    firstVisitPending: scheduleState.firstVisitPending,
    keepOpenEnabled: Boolean(target.keepOpenEnabled),
    keepOpenScheduled: Boolean(target.keepOpenScheduled),
    keepOpenStart: target.keepOpenStart,
    keepOpenEnd: target.keepOpenEnd,
    keepOpenManual: Boolean(target.keepOpenManual),
    keepOpenActive: Boolean(stayStatus.active || target.keepOpenActive),
    keepOpenDurationSec: stayStatus.durationSec,
  };
}

function publicLogEntry(entry) {
  const { html, screenshot, ...safe } = entry;
  return {
    ...safe,
    ...(html || screenshot ? { artifacts: true } : {}),
  };
}

function buildHealthPayload(status) {
  return {
    status: status.lastVisitOk === false ? 'degraded' : 'ok',
    targetCount: status.targetCount,
    visits: status.visits,
    failures: status.failures,
    sweeps: status.sweeps,
    lastSweepAt: status.lastSweepAt,
    lastVisitAt: status.lastVisitAt,
    lastTarget: status.lastTarget,
    uptimeSec: Math.round((Date.now() - Date.parse(status.startedAt)) / 1000),
  };
}

function prometheusLabelValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function buildMetrics(cfg, status, controls, keepOpenManager = null) {
  const now = Date.now();
  const memory = process.memoryUsage();
  const uptimeSec = Math.max(0, Math.round((now - Date.parse(status.startedAt)) / 1000));
  const schedulerQueued = cfg.targets.filter((target) => target.schedulerQueued).length;
  const queueLength = schedulerQueued + controls.pendingCount();
  const readiness = buildReadinessPayload(cfg, now, keepOpenManager);
  const loopAgeSec = Math.max(0, Math.round((now - (status.lastLoopAt ?? now)) / 1000));
  const dueTimes = cfg.targets
    .filter((target) => !target.paused && Number.isFinite(target.nextDue) && target.nextDue > 0)
    .map((target) => target.nextDue);
  const lagSec = dueTimes.length
    ? Math.max(0, Math.round((now - Math.min(...dueTimes)) / 1000))
    : 0;
  const lines = [
    '# HELP blitz_keepalive_up Whether the keep-alive process is running.',
    '# TYPE blitz_keepalive_up gauge',
    'blitz_keepalive_up 1',
    '# HELP blitz_keepalive_ready Whether all active targets are within their keep-alive window.',
    '# TYPE blitz_keepalive_ready gauge',
    `blitz_keepalive_ready ${readiness.ready ? 1 : 0}`,
    '# HELP blitz_keepalive_targets Number of configured keep-alive targets.',
    '# TYPE blitz_keepalive_targets gauge',
    `blitz_keepalive_targets ${Math.max(0, Number(status.targetCount) || 0)}`,
    '# HELP blitz_keepalive_visits_total Total completed target visits since process start.',
    '# TYPE blitz_keepalive_visits_total counter',
    `blitz_keepalive_visits_total ${Math.max(0, Number(status.visits) || 0)}`,
    '# HELP blitz_keepalive_failures_total Total failed target visits since process start.',
    '# TYPE blitz_keepalive_failures_total counter',
    `blitz_keepalive_failures_total ${Math.max(0, Number(status.failures) || 0)}`,
    '# HELP blitz_keepalive_active_browsers Number of browser processes currently active.',
    '# TYPE blitz_keepalive_active_browsers gauge',
    `blitz_keepalive_active_browsers ${ACTIVE_BROWSERS.size}`,
    '# HELP blitz_keepalive_queue_length Targets queued for scheduling or manual runs.',
    '# TYPE blitz_keepalive_queue_length gauge',
    `blitz_keepalive_queue_length ${queueLength}`,
    '# HELP blitz_keepalive_process_memory_bytes Node.js process RSS memory.',
    '# TYPE blitz_keepalive_process_memory_bytes gauge',
    `blitz_keepalive_process_memory_bytes ${Math.max(0, Number(memory.rss) || 0)}`,
    '# HELP blitz_keepalive_uptime_seconds Process uptime in seconds.',
    '# TYPE blitz_keepalive_uptime_seconds gauge',
    `blitz_keepalive_uptime_seconds ${uptimeSec}`,
    '# HELP blitz_keepalive_scheduler_loop_age_seconds Seconds since the scheduler loop last made progress.',
    '# TYPE blitz_keepalive_scheduler_loop_age_seconds gauge',
    `blitz_keepalive_scheduler_loop_age_seconds ${loopAgeSec}`,
    '# HELP blitz_keepalive_scheduler_lag_seconds How far the most overdue active target is behind schedule.',
    '# TYPE blitz_keepalive_scheduler_lag_seconds gauge',
    `blitz_keepalive_scheduler_lag_seconds ${lagSec}`,
    '# HELP blitz_keepalive_visit_permits_active Visit permits currently held.',
    '# TYPE blitz_keepalive_visit_permits_active gauge',
    `blitz_keepalive_visit_permits_active ${status.visitPermits?.activeCount ?? 0}`,
    '# HELP blitz_keepalive_visit_permits_pending Visits waiting for a permit.',
    '# TYPE blitz_keepalive_visit_permits_pending gauge',
    `blitz_keepalive_visit_permits_pending ${status.visitPermits?.pendingCount ?? 0}`,
  ];

  lines.push(
    '# HELP blitz_keepalive_target_last_success_timestamp_seconds Unix timestamp of the last successful target visit.',
    '# TYPE blitz_keepalive_target_last_success_timestamp_seconds gauge',
    '# HELP blitz_keepalive_target_last_success_age_seconds Seconds since the last successful visit, -1 when it never succeeded.',
    '# TYPE blitz_keepalive_target_last_success_age_seconds gauge',
    '# HELP blitz_keepalive_target_consecutive_failures Number of consecutive failed target visits.',
    '# TYPE blitz_keepalive_target_consecutive_failures gauge',
    '# HELP blitz_keepalive_target_next_due_timestamp_seconds Unix timestamp when the target is next due.',
    '# TYPE blitz_keepalive_target_next_due_timestamp_seconds gauge',
    '# HELP blitz_keepalive_target_paused Whether the target is paused.',
    '# TYPE blitz_keepalive_target_paused gauge',
    '# HELP blitz_keepalive_target_overdue Whether the target scheduler is overdue beyond the readiness grace period.',
    '# TYPE blitz_keepalive_target_overdue gauge',
  );
  for (const target of cfg.targets) {
    const label = `target="${prometheusLabelValue(target.id)}"`;
    const lastSuccessfulAt = Date.parse(target.lastSuccessfulVisitAt ?? '');
    // A keep-open session replaces scheduled visits, so lastSuccessfulVisitAt
    // stops moving while the target is legitimately being held open. Use the
    // session heartbeat as the freshness signal instead, otherwise a healthy
    // keep-open target looks stale forever and trips last_success_age alerts.
    const stayStatus = keepOpenManager?.getTargetStayStatus?.(target.id);
    const lastHeartbeatAt = Date.parse(stayStatus?.lastHeartbeatAt ?? '');
    const freshnessCandidates = [];
    if (Number.isFinite(lastSuccessfulAt)) freshnessCandidates.push(lastSuccessfulAt);
    if (stayStatus?.active && Number.isFinite(lastHeartbeatAt)) freshnessCandidates.push(lastHeartbeatAt);
    const freshnessAt = freshnessCandidates.length ? Math.max(...freshnessCandidates) : NaN;
    const nextDue = Number(target.nextDue);
    const overdue = targetReadinessIssues(
      target,
      Date.now(),
      cfg.scheduleTimeZone,
      keepOpenManager,
    ).includes('schedule-overdue');
    lines.push(
      `blitz_keepalive_target_last_success_timestamp_seconds{${label}} ${
        Number.isFinite(lastSuccessfulAt) ? lastSuccessfulAt / 1000 : 0
      }`,
      `blitz_keepalive_target_last_success_age_seconds{${label}} ${
        Number.isFinite(freshnessAt) ? Math.max(0, Math.round((now - freshnessAt) / 1000)) : -1
      }`,
      `blitz_keepalive_target_consecutive_failures{${label}} ${
        Math.max(0, Number(target.consecutiveFailures) || 0)
      }`,
      `blitz_keepalive_target_next_due_timestamp_seconds{${label}} ${
        Number.isFinite(nextDue) && nextDue > 0 ? nextDue / 1000 : 0
      }`,
      `blitz_keepalive_target_paused{${label}} ${target.paused ? 1 : 0}`,
      `blitz_keepalive_target_overdue{${label}} ${overdue ? 1 : 0}`,
    );
  }
  lines.push(
    '# HELP blitz_keepalive_keep_open_sessions Number of active keep-open browser sessions.',
    '# TYPE blitz_keepalive_keep_open_sessions gauge',
    `blitz_keepalive_keep_open_sessions ${Math.max(0, Number(keepOpenManager?.activeCount) || 0)}`,
    '# HELP blitz_keepalive_visit_duration_seconds Target visit duration in seconds.',
    '# TYPE blitz_keepalive_visit_duration_seconds histogram',
  );
  for (const target of cfg.targets) {
    const label = `target="${prometheusLabelValue(target.id)}"`;
    let cumulative = 0;
    VISIT_DURATION_BUCKETS_SEC.forEach((le, index) => {
      cumulative += Number(target.durationBuckets?.[index]) || 0;
      lines.push(
        `blitz_keepalive_visit_duration_seconds_bucket{${label},le="${le}"} ${cumulative}`,
      );
    });
    const count = Math.max(0, Number(target.durationCount) || 0);
    lines.push(
      `blitz_keepalive_visit_duration_seconds_bucket{${label},le="+Inf"} ${count}`,
      `blitz_keepalive_visit_duration_seconds_sum{${label}} ${Number(
        target.durationSum ?? 0,
      ).toFixed(3)}`,
      `blitz_keepalive_visit_duration_seconds_count{${label}} ${count}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Manual checks are queued in memory and picked up by the scheduler. Keeping
 * them separate from nextDue prevents a request that arrives during a running
 * visit from being overwritten by scheduleNext().
 */
function createRunController(cfg) {
  const pending = new Set();
  return {
    requestRun(ids) {
      if (cfg.once) {
        return { status: 409, error: 'manual run is unavailable in --once mode' };
      }
      if (cfg.targets.length === 0) {
        return { status: 409, error: '当前没有可巡检的目标。' };
      }
      resumeExpiredPauses(cfg.targets);
      const explicit = Array.isArray(ids) && ids.length > 0;
      const requested = explicit ? ids : cfg.targets.map((target) => target.id);
      const known = new Set(cfg.targets.map((target) => target.id));
      const unknown = requested.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        return { status: 404, error: `unknown target: ${unknown.join(', ')}` };
      }
      const targetById = new Map(cfg.targets.map((target) => [target.id, target]));
      const paused = requested.filter((id) => targetById.get(id)?.paused);
      if (explicit && paused.length > 0) {
        return { status: 409, error: `目标已暂停，请先恢复：${paused.join(', ')}` };
      }
      const accepted = [...new Set(requested)].filter((id) => !targetById.get(id)?.paused);
      if (accepted.length === 0) {
        return { status: 409, error: '所有目标均已暂停。' };
      }
      accepted.forEach((id) => pending.add(id));
      return { accepted, pending: [...pending] };
    },
    takePending() {
      const ids = [...pending];
      pending.clear();
      return ids;
    },
    hasPending(id) {
      return pending.has(id);
    },
    pendingCount() {
      return pending.size;
    },
  };
}

function createTargetManager(cfg, status, controls, keepOpenManager = null) {
  let mutationQueue = Promise.resolve();
  const serialize = (operation) => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => {});
    return result;
  };
  const ensureIdle = (target) => {
    if (!target) throw new HttpError(404, '目标不存在。');
    if (keepOpenManager?.isSessionActive(target.id) || target.keepOpenActive) {
      throw new HttpError(409, '目标正在长驻挂机，请先停止保持访问。');
    }
    if (target.running || target.schedulerQueued || controls.hasPending(target.id)) {
      throw new HttpError(409, '目标正在巡检或已排队，请稍后再试。');
    }
    if (target.managementLocked) {
      throw new HttpError(409, '目标正在被其他管理操作修改，请稍后再试。');
    }
  };
  const ensureEditable = (target) => {
    ensureIdle(target);
    if (target.source !== 'managed') {
      throw new HttpError(409, '静态配置目标不能在网页中修改。');
    }
  };
  const persist = async (records) => {
    await writeManagedTargetsFile(cfg.managedTargetsFile, records);
    cfg.managedRecords = records;
  };
  const exportRecord = (record) => {
    const proxyMode = managedRecordProxyMode(record);
    return {
      id: record.id,
      url: record.url,
      intervalMin: record.intervalMin,
      jitterMin: record.jitterMin,
      wakeWaitSec: record.wakeWaitSec ?? 90,
      timeoutSec: record.timeoutSec ?? 60,
      settleSec: record.settleSec ?? 6,
      retries: record.retries ?? 2,
      // Export is a whitelist: anything missing here is silently dropped from
      // the backup and from a subsequent import round-trip.
      ...(record.wakeExtensionSec ? { wakeExtensionSec: record.wakeExtensionSec } : {}),
      ...(record.minReadyTextLength ? { minReadyTextLength: record.minReadyTextLength } : {}),
      expect: record.expect,
      ...(record.loginSuccessSelector
        ? { loginSuccessSelector: record.loginSuccessSelector }
        : {}),
      ...(record.account ? { account: record.account } : {}),
      proxyMode,
      ...(record.proxy !== undefined ? { proxy: record.proxy } : {}),
      ...(record.proxyUsername ? { proxyUsername: record.proxyUsername } : {}),
      ...(record.proxyBypass ? { proxyBypass: record.proxyBypass } : {}),
      scheduleEnabled: Boolean(record.scheduleEnabled),
      scheduleStart: record.scheduleStart ?? DEFAULT_SCHEDULE_START,
      scheduleEnd: record.scheduleEnd ?? DEFAULT_SCHEDULE_END,
      scheduleDays: record.scheduleDays ?? DEFAULT_SCHEDULE_DAYS.slice(),
      ...(record.scheduleTimezone ? { scheduleTimezone: record.scheduleTimezone } : {}),
      firstVisitWakeWaitSec:
        record.firstVisitWakeWaitSec ?? DEFAULT_FIRST_VISIT_WAKE_WAIT_SEC,
      firstVisitTimeoutSec:
        record.firstVisitTimeoutSec ?? DEFAULT_FIRST_VISIT_TIMEOUT_SEC,
      firstVisitRetries: record.firstVisitRetries ?? DEFAULT_FIRST_VISIT_RETRIES,
      keepOpenEnabled: Boolean(record.keepOpenEnabled),
      keepOpenScheduled: Boolean(record.keepOpenScheduled),
      keepOpenStart: record.keepOpenStart ?? '09:00',
      keepOpenEnd: record.keepOpenEnd ?? '18:00',
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    };
  };

  return {
    create(raw) {
      return serialize(async () => {
        if (cfg.managedRecords.length >= MAX_MANAGED_TARGETS) {
          throw new HttpError(409, `网页管理目标最多允许 ${MAX_MANAGED_TARGETS} 个。`);
        }
        const knownIds = new Set(cfg.targets.map((target) => target.id));
        const { target, record } = buildManagedTarget(
          raw,
          null,
          cfg.globals,
          cfg.targets.length,
          knownIds,
          cfg.targetSecrets,
        );
        await validateTargetUrl(target.url, cfg);
        await persist([...cfg.managedRecords, record]);
        target.nextDue = Date.now() + 1_000;
        cfg.targets.push(target);
        status.targetCount = cfg.targets.length;
        runtimeStateStore?.schedule();
        return { target, record };
      });
    },
    update(id, raw) {
      return serialize(async () => {
        const index = cfg.targets.findIndex((target) => target.id === id);
        const current = cfg.targets[index];
        ensureEditable(current);
        current.managementLocked = true;
        try {
          const existingRecord = cfg.managedRecords.find((record) => record.id === id);
          if (!existingRecord) throw new HttpError(500, '目标持久化记录缺失。');
          const knownIds = new Set(
            cfg.targets.filter((target) => target.id !== id).map((target) => target.id),
          );
          const requestedUrl = raw.url ?? existingRecord.url;
          const normalizedRequestedUrl =
            typeof requestedUrl === 'string' ? requestedUrl.trim() : requestedUrl;
          const existingWithRuntime = {
            ...existingRecord,
            firstVisitWindowKey:
              normalizedRequestedUrl === current.url
                ? current.firstVisitWindowKey ?? null
                : null,
          };
          const { target, record } = buildManagedTarget(
            raw,
            existingWithRuntime,
            cfg.globals,
            index,
            knownIds,
            cfg.targetSecrets,
          );
          await validateTargetUrl(target.url, cfg);
          const nextRecords = cfg.managedRecords.map((item) => (item.id === id ? record : item));
          await persist(nextRecords);

          target.paused = current.paused;
          target.pauseReason = current.pauseReason;
          target.pausedUntil = current.pausedUntil;
          const scheduleState = getScheduleState(target, Date.now(), cfg.scheduleTimeZone);
          if (scheduleState.scheduledOff) {
            target.nextDue = scheduleState.nextStartMs;
          } else if (current.url === target.url && !current.paused) {
            target.nextDue = current.nextDue;
            target.lastResult = current.lastResult;
            target.lastVisit = current.lastVisit;
            target.consecutiveFailures = current.consecutiveFailures;
            target.authFailureCount = current.authFailureCount;
            target.lastSuccessfulVisitAt = current.lastSuccessfulVisitAt;
          } else {
            target.nextDue = Date.now() + 1_000;
          }
          cfg.targets.splice(index, 1, target);
          runtimeStateStore?.schedule();
          return { target, record };
        } finally {
          current.managementLocked = false;
        }
      });
    },
    remove(id) {
      return serialize(async () => {
        const index = cfg.targets.findIndex((target) => target.id === id);
        const current = cfg.targets[index];
        ensureEditable(current);
        current.managementLocked = true;
        try {
          const nextRecords = cfg.managedRecords.filter((record) => record.id !== id);
          await persist(nextRecords);
          cfg.targets.splice(index, 1);
          status.targetCount = cfg.targets.length;
          runtimeStateStore?.schedule();
          return current;
        } finally {
          current.managementLocked = false;
        }
      });
    },
    pause(id) {
      return serialize(async () => {
        const target = cfg.targets.find((item) => item.id === id);
        ensureIdle(target);
        target.managementLocked = true;
        try {
          pauseTarget(target, '手动暂停');
          runtimeStateStore?.schedule();
          return target;
        } finally {
          target.managementLocked = false;
        }
      });
    },
    resume(id) {
      return serialize(async () => {
        const target = cfg.targets.find((item) => item.id === id);
        ensureIdle(target);
        target.managementLocked = true;
        try {
          await validateTargetUrl(target.url, cfg);
          resumeTarget(target);
          runtimeStateStore?.schedule();
          return target;
        } finally {
          target.managementLocked = false;
        }
      });
    },
    pauseAll() {
      return serialize(async () => {
        const paused = [];
        const skipped = [];
        const stopping = [];
        for (const target of cfg.targets) {
          if (target.paused) {
            paused.push(target.id);
            continue;
          }
          if (
            target.running ||
            target.schedulerQueued ||
            target.managementLocked ||
            controls.hasPending(target.id)
          ) {
            skipped.push(target.id);
            continue;
          }
          target.managementLocked = true;
          try {
            // Pause first: the scheduler must not pick the target up while a
            // keep-open browser is still shutting down.
            pauseTarget(target, '批量暂停');
            paused.push(target.id);
            if (keepOpenManager?.isSessionActive(target.id)) {
              target.keepOpenManual = false;
              stopping.push(
                keepOpenManager.stopTargetStay(target.id, 'bulk-pause').catch(() => {}),
              );
            }
          } finally {
            target.managementLocked = false;
          }
        }
        await Promise.all(stopping);
        runtimeStateStore?.schedule();
        return { paused, skipped };
      });
    },
    resumeAll() {
      return serialize(async () => {
        const resumed = [];
        const failed = [];
        for (const target of cfg.targets) {
          if (!target.paused) continue;
          if (target.managementLocked) {
            failed.push({ id: target.id, reason: '目标正在被其他管理操作修改' });
            continue;
          }
          try {
            await validateTargetUrl(target.url, cfg);
            resumeTarget(target);
            resumed.push(target.id);
          } catch (error) {
            failed.push({ id: target.id, reason: String(error?.message ?? error).slice(0, 160) });
          }
        }
        runtimeStateStore?.schedule();
        return { resumed, failed };
      });
    },
    export() {
      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        targets: cfg.managedRecords.map(exportRecord),
      };
    },
    import(raw) {
      return serialize(async () => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new HttpError(400, '导入内容必须是 JSON 对象。');
        }
        if (!Array.isArray(raw.targets)) {
          throw new HttpError(400, '导入内容必须包含 targets 数组。');
        }
        if (raw.targets.length > MAX_MANAGED_TARGETS) {
          throw new HttpError(409, `网页管理目标最多允许 ${MAX_MANAGED_TARGETS} 个。`);
        }

        const sensitiveFields = [
          'loginPassword',
          'loginPasswordEnc',
          'clearLoginPassword',
          'proxyPassword',
          'proxyPasswordEnc',
          'clearProxyPassword',
        ];
        raw.targets.forEach((item, index) => {
          if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            throw new HttpError(400, `导入目标 ${index + 1} 必须是对象。`);
          }
          const found = sensitiveFields.find((field) => Object.hasOwn(item, field));
          if (found) {
            throw new HttpError(400, `导入文件不能包含敏感字段：${found}。`);
          }
        });

        cfg.targets.filter((target) => target.source === 'managed').forEach(ensureIdle);
        const existingRecords = new Map(cfg.managedRecords.map((record) => [record.id, record]));
        const knownIds = new Set(
          cfg.targets.filter((target) => target.source !== 'managed').map((target) => target.id),
        );
        const nextTargets = [];
        const nextRecords = [];

        for (let index = 0; index < raw.targets.length; index += 1) {
          const item = raw.targets[index];
          const existingRecord =
            typeof item.id === 'string' ? existingRecords.get(item.id.trim()) : null;
          const persistedRecord = existingRecord ?? null;
          const { target, record } = buildManagedTarget(
            item,
            null,
            cfg.globals,
            index,
            knownIds,
            cfg.targetSecrets,
            { preserveTimestamps: true, persistedRecord },
          );
          if (existingRecord?.loginPasswordEnc && record.loginPasswordEnc) {
            target.loginPassword = cfg.targetSecrets.decrypt(
              target.id,
              record.loginPasswordEnc,
              `managedTargets.${target.id}.loginPasswordEnc`,
            );
            target.loginPasswordConfigured = true;
          }
          if (existingRecord?.proxyPasswordEnc && record.proxyPasswordEnc) {
            if (target.proxyMode !== 'custom' || !target.proxy) {
              throw new Error('Imported proxy password requires a custom proxy configuration.');
            }
            target.proxy.password = cfg.targetSecrets.decryptProxy(
              target.id,
              record.proxyPasswordEnc,
              `managedTargets.${target.id}.proxyPasswordEnc`,
            );
            target.proxyPasswordConfigured = true;
          }
          await validateTargetUrl(target.url, cfg);
          knownIds.add(target.id);
          nextTargets.push(target);
          nextRecords.push(record);
        }

        // Nothing above this point mutates persisted or live state. Persist the
        // complete replacement first, then swap the in-memory target list.
        await writeManagedTargetsFile(cfg.managedTargetsFile, nextRecords);
        const currentById = new Map(cfg.targets.map((target) => [target.id, target]));
        const now = Date.now();
        nextTargets.forEach((target, index) => {
          const current = currentById.get(target.id);
          target.firstVisitWindowKey =
            current?.url === target.url ? current.firstVisitWindowKey ?? null : null;
          const scheduleState = getScheduleState(target, now, cfg.scheduleTimeZone);
          if (scheduleState.scheduledOff) {
            target.nextDue = scheduleState.nextStartMs;
          } else if (current?.url === target.url && !current.paused) {
            target.nextDue = current.nextDue || now + 1_000;
            target.lastResult = current.lastResult;
            target.lastVisit = current.lastVisit;
            target.consecutiveFailures = current.consecutiveFailures;
            target.authFailureCount = current.authFailureCount;
            target.lastSuccessfulVisitAt = current.lastSuccessfulVisitAt;
          } else {
            target.nextDue = now + 1_000 + index * 250;
          }
        });
        const staticTargets = cfg.targets.filter((target) => target.source !== 'managed');
        cfg.targets.splice(0, cfg.targets.length, ...staticTargets, ...nextTargets);
        cfg.managedRecords = nextRecords;
        status.targetCount = cfg.targets.length;
        runtimeStateStore?.schedule();
        return { imported: nextTargets.length, targets: nextTargets };
      });
    },
  };
}

async function buildOverview(cfg, status, log, controls, admin, keepOpenManager = null) {
  const readiness = buildReadinessPayload(cfg, Date.now(), keepOpenManager);
  const targets = cfg.targets.map((target) => {
    const readinessIssues = targetReadinessIssues(
      target,
      Date.now(),
      cfg.scheduleTimeZone,
      keepOpenManager,
    );
    const scheduleState = getScheduleState(target, Date.now(), cfg.scheduleTimeZone);
    return {
      id: target.id,
      source: target.source ?? 'config',
      editable: target.source === 'managed',
      account: target.account,
      url: target.url,
      intervalMin: Math.round(target.intervalMs / MINUTE),
      jitterMin: Math.round(target.jitterMs / MINUTE),
      wakeWaitSec: Math.round(target.wakeWaitMs / 1000),
      // The edit dialog prefills from this payload. Omitting these would make a
      // plain "edit and save" silently reset a configured wake extension to 0.
      wakeExtensionSec: Math.round((Number(target.wakeExtensionMs) || 0) / 1000),
      minReadyTextLength: Math.max(0, Number(target.minReadyTextLength) || 0),
      expect: target.expectText,
      expectConfigured: Boolean(target.expectText),
      loginPasswordConfigured: Boolean(target.loginPasswordConfigured),
      loginSuccessSelector: target.loginSuccessSelector || null,
      nextDue: target.nextDue ? new Date(target.nextDue).toISOString() : null,
      lastResult: target.lastResult,
      lastVisit: publicVisit(target.lastVisit),
      lastSuccessfulVisitAt: target.lastSuccessfulVisitAt ?? null,
      consecutiveFailures: target.consecutiveFailures,
      authFailureCount: target.authFailureCount ?? 0,
      paused: Boolean(target.paused),
      pauseReason: target.pauseReason ?? null,
      pausedUntil: target.pausedUntil ?? null,
      running: Boolean(target.running),
      overdue: readinessIssues.includes('schedule-overdue'),
      readinessIssues,
      locked: Boolean(target.managementLocked || target.schedulerQueued),
      pendingRun: controls.hasPending(target.id),
      proxyMode: target.proxyMode ?? (target.proxy ? 'custom' : 'direct'),
      proxyUsername: target.proxyUsername || null,
      proxyBypass: target.proxy?.bypass || null,
      proxyPasswordConfigured: Boolean(target.proxyPasswordConfigured),
      proxy: redactProxy(target.proxy),
      scheduleEnabled: Boolean(target.scheduleEnabled),
      scheduleStart: target.scheduleStart,
      scheduleEnd: target.scheduleEnd,
      scheduleDays: target.scheduleDays,
      scheduleTimezone: target.scheduleTimezone ?? null,
      effectiveScheduleTimezone: scheduleState.timeZone ?? cfg.scheduleTimeZone,
      firstVisitWakeWaitSec: target.firstVisitWakeWaitSec,
      firstVisitTimeoutSec: target.firstVisitTimeoutSec,
      firstVisitRetries: target.firstVisitRetries,
      scheduleActive: scheduleState.active,
      scheduledOff: scheduleState.scheduledOff,
      scheduleNextStart: scheduleState.nextStartAt,
      firstVisitPending: scheduleState.firstVisitPending,
      keepOpenEnabled: Boolean(target.keepOpenEnabled),
      keepOpenScheduled: Boolean(target.keepOpenScheduled),
      keepOpenStart: target.keepOpenStart,
      keepOpenEnd: target.keepOpenEnd,
      keepOpenManual: Boolean(target.keepOpenManual),
      keepOpenActive: Boolean(keepOpenManager?.isSessionActive(target.id) || target.keepOpenActive),
      keepOpenDurationSec: keepOpenManager?.getTargetStayStatus(target.id)?.durationSec ?? 0,
    };
  });
  // Keep-open targets are held alive by their session, so a stale failure streak
  // from before the session started must not keep the dashboard "degraded".
  const failing = targets.filter(
    (target) =>
      target.consecutiveFailures > 0 && !target.scheduledOff && !target.keepOpenActive,
  ).length;
  const visited = targets.filter((target) => target.lastVisit).length;
  const pausedTargets = targets.filter((target) => target.paused).length;
  const authFailures = targets.filter((target) => target.authFailureCount > 0).length;
  const authFailureCount = targets.reduce((sum, target) => sum + target.authFailureCount, 0);
  const overdueTargets = targets.filter((target) => target.overdue).length;
  const overall =
    readiness.ready === false || failing > 0 || authFailures > 0
      ? 'degraded'
      : visited > 0
        ? 'ok'
        : 'idle';
  let storage = null;
  try {
    const info = await statfs(cfg.logDir);
    const totalBytes = Number(info.blocks) * Number(info.bsize);
    const freeBytes = Number(info.bavail) * Number(info.bsize);
    storage = {
      totalBytes,
      freeBytes,
      usedPercent:
        totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10 : null,
    };
  } catch {
    // Disk statistics are advisory; a transient statfs failure must not hide the
    // console or make the management API unavailable.
  }
  return {
    generatedAt: new Date().toISOString(),
    scheduleTimeZone: cfg.scheduleTimeZone,
    overall,
    readiness,
    summary: {
      totalTargets: targets.length,
      failingTargets: failing,
      notReadyTargets: readiness.issueCount,
      overdueTargets,
      pausedTargets,
      scheduledOffTargets: targets.filter((target) => target.scheduledOff).length,
      firstVisitPendingTargets: targets.filter((target) => target.firstVisitPending).length,
      keepOpenTargets: targets.filter((target) => target.keepOpenActive).length,
      authFailures,
      authFailureCount,
      visitedTargets: visited,
    },
    status: {
      ...status,
      uptimeSec: Math.round((Date.now() - Date.parse(status.startedAt)) / 1000),
    },
    runtime: {
      memoryUsage: process.memoryUsage(),
      storage,
      activeBrowsers: ACTIVE_BROWSERS.size,
      queueLength:
        cfg.targets.filter((target) => target.schedulerQueued).length + controls.pendingCount(),
    },
    config: {
      maxConcurrent: cfg.maxConcurrent,
      maxKeepOpenSessions: cfg.maxKeepOpenSessions,
      retryDelaySec: Math.round(cfg.retryDelayMs / 1000),
      headless: cfg.headless,
      port: cfg.port || null,
      once: cfg.once,
      authRequired: admin.required,
      authEnabled: admin.required,
      passwordConfigured: admin.passwordConfigured,
      tokenConfigured: admin.tokenConfigured,
      passwordFileExists: admin.passwordFileExists,
      passwordChangeAvailable: admin.passwordChangeAvailable,
      managedTargetsFileName: path.basename(cfg.managedTargetsFile),
      managedTargetsFileExists: existsSync(cfg.managedTargetsFile),
      targetSecretKeyFileName: path.basename(cfg.targetSecretKeyFile),
      targetSecretKeyFileExists: existsSync(cfg.targetSecretKeyFile),
      adminPasswordFileName: path.basename(cfg.adminPasswordFile),
      targetPasswordEncryption: 'aes-256-gcm',
      managedTargetLimit: MAX_MANAGED_TARGETS,
      requireHttps: cfg.requireHttps,
      bindHost: cfg.bindHost,
      publicStatus: Boolean(cfg.publicStatus),
      webhookEnabled: Boolean(cfg.webhookUrl),
      blockResourceTypes: cfg.blockResourceTypes ?? [],
    },
    stats: statsStore?.snapshot(7) ?? null,
    targets,
    logs: log.snapshot(40).map(publicLogEntry),
  };
}

/**
 * Read-only view for people who should see whether the apps are awake but must
 * not see URLs, proxies, credentials or logs.
 */
/**
 * The public status page is anonymous when PUBLIC_STATUS=true, so account
 * identifiers must not be readable there: an email like alice@corp.com is
 * enough to fingerprint the operator's tenancy. Keep enough shape to tell
 * targets apart without disclosing the login.
 */
function maskAccount(account) {
  const value = String(account ?? '').trim();
  if (!value) return null;
  const at = value.indexOf('@');
  if (at > 0) return `${value.slice(0, 1)}***${value.slice(at)}`;
  if (value.length <= 2) return '***';
  return `***${value.slice(-2)}`;
}

function buildPublicStatus(cfg, status, keepOpenManager = null) {
  const now = Date.now();
  const readiness = buildReadinessPayload(cfg, now, keepOpenManager);
  const targets = cfg.targets.map((target) => {
    const scheduleState = getScheduleState(target, now, cfg.scheduleTimeZone);
    const stay = keepOpenManager?.getTargetStayStatus(target.id) ?? {
      active: false,
      durationSec: 0,
    };
    return {
      id: target.id,
      account: maskAccount(target.account),
      paused: Boolean(target.paused),
      lastResult: target.lastResult ?? null,
      lastSuccessfulVisitAt: target.lastSuccessfulVisitAt ?? null,
      consecutiveFailures: Math.max(0, Number(target.consecutiveFailures) || 0),
      scheduleActive: scheduleState.active,
      scheduledOff: scheduleState.scheduledOff,
      scheduleNextStart: scheduleState.nextStartAt,
      nextDue: target.nextDue ? new Date(target.nextDue).toISOString() : null,
      keepOpenActive: Boolean(stay.active || target.keepOpenActive),
      readinessIssues: targetReadinessIssues(target, now, cfg.scheduleTimeZone, keepOpenManager),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    overall: readiness.ready ? 'ok' : 'degraded',
    ready: readiness.ready,
    summary: {
      totalTargets: targets.length,
      activeTargets: readiness.activeTargetCount,
      issueCount: readiness.issueCount,
      failingTargets: targets.filter(
        (target) =>
          target.consecutiveFailures > 0 && !target.keepOpenActive && !target.scheduledOff,
      ).length,
      pausedTargets: targets.filter((target) => target.paused).length,
      keepOpenTargets: targets.filter((target) => target.keepOpenActive).length,
    },
    status: {
      visits: status.visits,
      failures: status.failures,
      uptimeSec: Math.round((Date.now() - Date.parse(status.startedAt)) / 1000),
      lastVisitAt: status.lastVisitAt,
    },
    stats: statsStore?.snapshot(7) ?? null,
    targets,
  };
}

async function handleRequest(req, res, cfg, status, log, controls, admin, targetManager, keepOpenManager = null) {
  let pathname = '/';
  let searchParams = new URLSearchParams();
  try {
    const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
    pathname = parsed.pathname;
    searchParams = parsed.searchParams;
  } catch {
    sendText(res, 400, 'bad request');
    return;
  }

  const secureRequest = isSecureRequest(cfg, req);
  if (secureRequest) {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }

  // Container and reverse-proxy health checks commonly probe over loopback
  // HTTP. Keep this endpoint available before enforcing HTTPS so a healthy
  // process is not marked unhealthy when TLS terminates at the proxy.
  if (req.method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, buildHealthPayload(status));
    return;
  }

  // Liveness only proves that the process can answer. Readiness reflects
  // whether every active target remains inside its keep-alive window and is
  // therefore safe to use for alerting and load-balancer decisions.
  if (req.method === 'GET' && pathname === '/readyz') {
    const readiness = buildReadinessPayload(cfg, Date.now(), keepOpenManager);
    // A wedged scheduler visits nobody, so no target accumulates new failures
    // and the per-target checks keep reporting ready. Surface the stall itself.
    const loopAgeMs = Date.now() - (status.lastLoopAt ?? Date.now());
    if (!cfg.once && loopAgeMs > SCHEDULER_STALL_MS) {
      readiness.ready = false;
      readiness.status = 'not-ready';
      readiness.issues = [
        ...readiness.issues,
        { id: 'scheduler', reasons: ['scheduler-stalled'], loopAgeSec: Math.round(loopAgeMs / 1000) },
      ];
      readiness.issueCount = readiness.issues.length;
    }
    sendJson(res, readiness.ready ? 200 : 503, readiness);
    return;
  }

  if (cfg.requireHttps && !secureRequest) {
    sendText(res, 426, 'HTTPS is required.');
    return;
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !requestOriginAllowed(req)) {
    sendJson(res, 403, { error: '跨站请求已被拒绝。' });
    return;
  }

  const authenticate = () => authenticateRequest(cfg, req, admin);
  const sendUnauthorized = () => {
    sendJson(res, 401, {
      error: 'unauthorized',
      authRequired: admin.required,
      passwordConfigured: admin.passwordConfigured,
      tokenConfigured: admin.tokenConfigured,
      passwordFileExists: admin.passwordFileExists,
      passwordChangeAvailable: admin.passwordChangeAvailable,
    });
  };
  const requireReadAuth = () => {
    const authentication = authenticate();
    if (authentication.authorized) return authentication;
    sendUnauthorized();
    return null;
  };
  const requireAdminAuth = () => {
    const authentication = authenticate();
    if (authentication.adminAuthorized) return authentication;
    sendUnauthorized();
    return null;
  };
  const decodeTargetId = (raw) => {
    try {
      return decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, '目标名称编码无效。');
    }
  };

  if (pathname === '/admin' || pathname === '/admin/') {
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    await serveStatic(res, { file: 'index.html', type: 'text/html; charset=utf-8' });
    return;
  }

  const asset = STATIC_FILES.get(pathname);
  if (asset) {
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    await serveStatic(res, asset);
    return;
  }

  if (req.method === 'GET' && pathname === '/' && acceptsHtml(req)) {
    await serveStatic(res, { file: 'index.html', type: 'text/html; charset=utf-8' });
    return;
  }

  if (req.method === 'GET' && pathname === '/') {
    sendJson(res, 200, buildHealthPayload(status));
    return;
  }

  if (pathname === '/api/session') {
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    const authentication = authenticate();
    sendJson(res, 200, {
      authenticated: authentication.adminAuthorized,
      readAuthorized: authentication.authorized,
      authRequired: admin.required,
      passwordConfigured: admin.passwordConfigured,
      tokenConfigured: admin.tokenConfigured,
      passwordFileExists: admin.passwordFileExists,
      passwordChangeAvailable: admin.passwordChangeAvailable,
      via: authentication.via,
    });
    return;
  }

  if (pathname === '/metrics') {
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (!requireReadAuth()) return;
    sendText(
      res,
      200,
      buildMetrics(cfg, status, controls, keepOpenManager),
      'text/plain; version=0.0.4; charset=utf-8',
    );
    return;
  }

  if (pathname === '/api/login') {
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (!admin.required) {
      sendJson(res, 400, { error: '当前实例未配置访问密码。', authRequired: false });
      return;
    }

    const body = await readJsonBody(req);
    if (typeof body.password !== 'string' || body.password.length === 0) {
      throw new HttpError(400, '请输入访问密码。');
    }
    if (body.password.length > 1024) {
      throw new HttpError(400, '密码长度无效。');
    }

    const clientKey = getClientIp(cfg, req);
    const retryAfterSec = admin.limiter.retryAfterSec(clientKey);
    if (retryAfterSec > 0) {
      void log({
        level: 'warn',
        event: 'login-rate-limited',
        client: clientKey,
        retryAfterSec,
      });
      sendJson(
        res,
        429,
        { error: '登录失败次数过多，请稍后再试。', retryAfterSec },
        { 'retry-after': String(retryAfterSec) },
      );
      return;
    }

    if (!(await admin.verifyPassword(body.password))) {
      admin.limiter.recordFailure(clientKey);
      void log({ level: 'warn', event: 'login-failed', client: clientKey });
      const lockedFor = admin.limiter.retryAfterSec(clientKey);
      if (lockedFor > 0) {
        sendJson(
          res,
          429,
          { error: '登录失败次数过多，请稍后再试。', retryAfterSec: lockedFor },
          { 'retry-after': String(lockedFor) },
        );
      } else {
        sendJson(res, 401, { error: '访问密码错误。' });
      }
      return;
    }

    admin.limiter.reset(clientKey);
    const session = admin.sessions.create();
    void log({ level: 'info', event: 'login-success', client: clientKey });
    sendJson(
      res,
      200,
      {
        authenticated: true,
        authRequired: admin.required,
        passwordConfigured: admin.passwordConfigured,
        tokenConfigured: admin.tokenConfigured,
        passwordFileExists: admin.passwordFileExists,
        passwordChangeAvailable: admin.passwordChangeAvailable,
        expiresAt: new Date(session.expiresAt).toISOString(),
      },
      { 'set-cookie': sessionCookieHeader(cfg, req, session.token) },
    );
    return;
  }

  if (pathname === '/api/password') {
    if (req.method !== 'PUT') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    const authentication = requireAdminAuth();
    if (!authentication) return;
    if (!admin.passwordChangeAvailable) {
      sendJson(res, 400, { error: '当前实例未配置访问密码，无法修改密码。' });
      return;
    }

    const body = await readJsonBody(req);
    if (typeof body.currentPassword !== 'string' || body.currentPassword.length === 0) {
      throw new HttpError(400, '请输入当前管理密码。');
    }
    if (body.currentPassword.length > 1024) {
      throw new HttpError(400, '当前密码长度无效。');
    }
    if (
      typeof body.newPassword !== 'string' ||
      body.newPassword.length < ADMIN_PASSWORD_MIN_LENGTH ||
      body.newPassword.length > ADMIN_PASSWORD_MAX_LENGTH
    ) {
      throw new HttpError(
        400,
        `新密码长度必须为 ${ADMIN_PASSWORD_MIN_LENGTH}–${ADMIN_PASSWORD_MAX_LENGTH} 个字符。`,
      );
    }

    const result = await admin.changePassword(body.currentPassword, body.newPassword);
    if (!result.ok) {
      sendJson(res, 403, { error: '当前管理密码不正确。' });
      return;
    }

    void log({
      level: 'info',
      event: 'password-changed',
      client: getClientIp(cfg, req),
      via: authentication.via,
    });
    sendJson(
      res,
      200,
      {
        message: '管理密码已修改，其他登录会话已失效。',
        authenticated: true,
        passwordConfigured: true,
        passwordFileExists: true,
        passwordChangeAvailable: true,
        expiresAt: new Date(result.session.expiresAt).toISOString(),
      },
      { 'set-cookie': sessionCookieHeader(cfg, req, result.session.token) },
    );
    return;
  }

  if (pathname === '/api/logout') {
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    const authentication = authenticate();
    if (authentication.sessionToken) admin.sessions.destroy(authentication.sessionToken);
    sendJson(
      res,
      200,
      { authenticated: false, message: '已退出登录。' },
      { 'set-cookie': clearSessionCookieHeader(cfg, req) },
    );
    return;
  }

  if (pathname === '/status') {
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (!authenticate().authorized) {
      sendText(res, 404, 'not found');
      return;
    }
    sendJson(res, 200, {
      ...status,
      targets: cfg.targets.map((target) =>
        publicTargetRuntime(target, cfg, keepOpenManager),
      ),
    });
    return;
  }

  if (pathname === '/api/overview') {
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (!requireReadAuth()) return;
    sendJson(res, 200, await buildOverview(cfg, status, log, controls, admin, keepOpenManager));
    return;
  }

  if (pathname === '/api/logs') {
    if (req.method === 'GET') {
      if (!requireReadAuth()) return;
      const requestedLimit = Number(searchParams.get('limit') ?? 50);
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
        : 50;
      sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        logs: log.snapshot(limit).map(publicLogEntry),
      });
      return;
    }
    if (req.method === 'DELETE') {
      const authentication = requireAdminAuth();
      if (!authentication) return;
      const clearedEntries = await log.clear();
      await log({
        level: 'info',
        event: 'logs-cleared',
        client: getClientIp(cfg, req),
        via: authentication.via,
        clearedEntries,
      });
      sendJson(res, 200, {
        message: '事件日志已清空。',
        clearedEntries,
      });
      return;
    }
    sendText(res, 405, 'method not allowed');
    return;
  }

  if (pathname === '/api/targets/export') {
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (!requireReadAuth()) return;
    const exported = targetManager.export();
    sendJson(res, 200, exported, {
      'content-disposition': `attachment; filename="blitz-keepalive-targets-${exported.exportedAt.slice(0, 10)}.json"`,
    });
    return;
  }

  if (pathname === '/api/targets/import') {
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (!requireAdminAuth()) return;
    const body = await readJsonBody(req, MAX_IMPORT_BODY_BYTES);
    const result = await targetManager.import(body);
    void log({
      level: 'info',
      event: 'targets-imported',
      imported: result.imported,
    });
    sendJson(res, 200, {
      imported: result.imported,
      message: `已导入 ${result.imported} 个目标。`,
    });
    return;
  }

  if (pathname === '/api/run') {
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (!requireAdminAuth()) return;
    const target = searchParams.get('target');
    const result = controls.requestRun(target ? [target] : null);
    if (result.error) {
      sendJson(res, result.status ?? 400, { error: result.error });
      return;
    }
    void log({
      level: 'info',
      event: 'manual-run-request',
      targets: result.accepted,
    });
    sendJson(res, 202, {
      accepted: result.accepted,
      message: target ? '目标巡检已排队。' : '全部目标巡检已排队。',
    });
    return;
  }

  if (pathname === '/api/public-status') {
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    // PUBLIC_STATUS=true makes this page anonymous; otherwise it stays behind
    // the normal read auth so an admin can still preview it.
    if (!cfg.publicStatus && !requireReadAuth()) return;
    sendJson(res, 200, buildPublicStatus(cfg, status, keepOpenManager));
    return;
  }

  if (pathname === '/api/targets/pause-all' || pathname === '/api/targets/resume-all') {
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (!requireAdminAuth()) return;
    const action = pathname.endsWith('pause-all') ? 'pause' : 'resume';
    const result =
      action === 'pause' ? await targetManager.pauseAll() : await targetManager.resumeAll();
    void log({
      level: 'info',
      event: action === 'pause' ? 'targets-paused-all' : 'targets-resumed-all',
      ...result,
    });
    sendJson(res, 200, {
      message:
        action === 'pause'
          ? `已暂停 ${result.paused.length} 个目标。`
          : `已恢复 ${result.resumed.length} 个目标。`,
      ...result,
    });
    return;
  }

  if (pathname === '/api/targets') {
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (!requireAdminAuth()) return;
    const body = await readJsonBody(req);
    const result = await targetManager.create(body);
    void log({
      level: 'info',
      event: 'target-created',
      target: result.target.id,
      source: 'managed',
    });
    sendJson(res, 201, {
      message: '目标已创建并加入调度。',
      target: publicManagedTargetRecord(result.record),
    });
    return;
  }

  const targetProbeRoute = pathname.match(/^\/api\/targets\/([^/]+)\/probe$/);
  if (targetProbeRoute) {
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (!requireAdminAuth()) return;
    const targetId = decodeTargetId(targetProbeRoute[1]);
    const target = cfg.targets.find((item) => item.id === targetId);
    if (!target) throw new HttpError(404, '目标不存在。');
    if (target.running || target.schedulerQueued || target.managementLocked) {
      throw new HttpError(409, '目标正在巡检或已排队，请稍后再试。');
    }
    if (probeInFlight) throw new HttpError(429, '已有探测任务正在进行，请稍后再试。');
    probeInFlight = true;
    try {
      const probe = await probeTarget(cfg, target);
      void log({
        level: probe.ok ? 'info' : 'warn',
        event: 'target-probed',
        target: target.id,
        ok: probe.ok,
        reason: probe.reason,
        status: probe.httpStatus,
        ms: probe.ms,
        proxy: redactProxy(target.proxy),
      });
      sendJson(res, 200, {
        message: probe.ok ? '目标可正常访问。' : '探测完成，目标当前未就绪。',
        probe,
      });
    } catch (error) {
      if (error?.code === 'probe-timeout') {
        void log({
          level: 'warn',
          event: 'target-probe-timeout',
          target: target.id,
          error: error.message,
        });
        throw new HttpError(504, error.message);
      }
      throw error;
    } finally {
      probeInFlight = false;
    }
    return;
  }

  const targetKeepOpenRoute = pathname.match(/^\/api\/targets\/([^/]+)\/keep-open$/);
  if (targetKeepOpenRoute) {
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (!requireAdminAuth()) return;
    const targetId = decodeTargetId(targetKeepOpenRoute[1]);
    const target = cfg.targets.find((t) => t.id === targetId);
    if (!target) throw new HttpError(404, '目标不存在。');
    const body = await readJsonBody(req);
    const action = String(body.action || '').trim().toLowerCase();
    if (!['start', 'stop'].includes(action)) {
      throw new HttpError(400, 'action 必须是 start 或 stop。');
    }
    if (action === 'start') {
      try {
        if (keepOpenManager) await keepOpenManager.startTargetStay(target, 'manual');
        target.keepOpenManual = true;
      } catch (error) {
        if (error instanceof KeepOpenCapacityError) {
          throw new HttpError(409, error.message);
        }
        throw error;
      }
    } else {
      // Clear the manual flag *before* stopping. stopTargetStay() removes the
      // session first and only then closes the browser, so a scheduler tick that
      // runs in between would see keepOpenManual=true with no session and start
      // it again, leaving the target stuck in "挂机保持中" right after a stop.
      target.keepOpenManual = false;
      if (keepOpenManager) await keepOpenManager.stopTargetStay(target.id, 'manual');
      // The session itself was keeping the app alive, so there is nothing to
      // catch up on. Re-arm the normal cadence instead of firing an immediate
      // visit the instant the session stops (nextDue went stale during it).
      if (!target.paused && (!Number.isFinite(target.nextDue) || target.nextDue <= Date.now())) {
        scheduleNext(target, {}, Date.now(), cfg.scheduleTimeZone);
      }
    }
    runtimeStateStore?.schedule();
    void log({
      level: 'info',
      event: action === 'start' ? 'target-keep-open-started' : 'target-keep-open-stopped',
      target: target.id,
      manual: true,
    });
    sendJson(res, 200, {
      message: action === 'start' ? '已开启长驻挂机保持访问。' : '已停止长驻挂机保持。',
      target: publicTargetRuntime(target, cfg, keepOpenManager),
    });
    return;
  }

  const targetActionRoute = pathname.match(/^\/api\/targets\/([^/]+)\/(pause|resume)$/);
  if (targetActionRoute) {
    if (req.method !== 'POST') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (!requireAdminAuth()) return;
    const targetId = decodeTargetId(targetActionRoute[1]);
    const action = targetActionRoute[2];
    const target =
      action === 'pause'
        ? await targetManager.pause(targetId)
        : await targetManager.resume(targetId);
    void log({
      level: 'info',
      event: action === 'pause' ? 'target-paused' : 'target-resumed',
      target: target.id,
    });
    sendJson(res, 200, {
      message: action === 'pause' ? '目标已暂停。' : '目标已恢复调度。',
      target: publicTargetRuntime(target, cfg, keepOpenManager),
    });
    return;
  }

  const targetRoute = pathname.match(/^\/api\/targets\/([^/]+)$/);
  if (targetRoute) {
    if (!['PATCH', 'DELETE'].includes(req.method)) {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (!requireAdminAuth()) return;
    const targetId = decodeTargetId(targetRoute[1]);
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const result = await targetManager.update(targetId, body);
      void log({
        level: 'info',
        event: 'target-updated',
        target: result.target.id,
        source: 'managed',
      });
      sendJson(res, 200, {
        message: '目标已更新。',
        target: publicManagedTargetRecord(result.record),
      });
      return;
    }
    const removed = await targetManager.remove(targetId);
    void log({
      level: 'info',
      event: 'target-deleted',
      target: removed.id,
      source: 'managed',
    });
    sendJson(res, 200, { message: '目标已删除。', id: removed.id });
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204, SECURITY_HEADERS).end();
    return;
  }

  sendText(res, 404, 'not found');
}

/**
 * Minimal HTTP server required when the agent runs as a blitz.cloud app. It
 * also serves the management console at /admin. The root path remains a cheap
 * JSON health response for scripts, while browser requests with Accept:
 * text/html receive the same password-protected console. STATUS_TOKEN is
 * intentionally read-only and can never unlock the browser console.
 */
function startHealthServer(cfg, status, log, controls, admin, targetManager, keepOpenManager = null) {
  if (!cfg.port) return null;

  const server = createServer((req, res) => {
    handleRequest(req, res, cfg, status, log, controls, admin, targetManager, keepOpenManager).catch((error) => {
      if (error instanceof HttpError) {
        if (!res.headersSent) sendJson(res, error.status, { error: error.message });
        else res.destroy();
        return;
      }
      if (error instanceof TargetUrlError) {
        if (!res.headersSent) sendJson(res, 400, { error: error.message });
        else res.destroy();
        return;
      }
      console.error(`http request error: ${error.stack ?? error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal server error' });
      else res.destroy();
    });
  });

  server.on('error', (error) => {
    console.error(`health server error: ${error.message}`);
    process.exit(1);
  });
  server.listen(cfg.port, cfg.bindHost, () => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        event: 'health-listen',
        host: cfg.bindHost,
        port: cfg.port,
        requireHttps: cfg.requireHttps,
        admin: `/admin`,
      }),
    );
  });
  return server;
}

async function waitForRetryWindow(target, delayMs, timeZone) {
  const deadline = Date.now() + Math.max(0, delayMs);
  while (Date.now() < deadline) {
    if (stopping) return 'stopped';
    if (
      target.scheduleEnabled &&
      getScheduleState(target, Date.now(), timeZone).scheduledOff
    ) {
      return 'scheduled-off';
    }
    const remainingMs = deadline - Date.now();
    if (await waitForStop(Math.min(remainingMs, 1_000))) return 'stopped';
  }
  return target.scheduleEnabled &&
    getScheduleState(target, Date.now(), timeZone).scheduledOff
    ? 'scheduled-off'
    : 'ready';
}

async function runTargetCycle(cfg, target, log, cycle, status) {
  const startedAt = Date.now();
  let lastResult = null;
  let attempts = 0;

  const scheduleState = getScheduleState(target, Date.now(), cfg.scheduleTimeZone);
  const isFirstVisit = scheduleState.active && scheduleState.firstVisitPending;
  const cycleTimeoutMs = isFirstVisit
    ? target.firstVisitTimeoutSec * 1000
    : target.timeoutMs;
  const cycleWakeWaitMs = isFirstVisit
    ? target.firstVisitWakeWaitSec * 1000
    : target.wakeWaitMs;
  const maxRetries = isFirstVisit ? target.firstVisitRetries : target.retries;

  if (scheduleState.scheduledOff) {
    await log({
      level: 'info',
      event: 'visit-skipped',
      target: target.id,
      account: target.account,
      cycle,
      reason: 'scheduled-off',
      nextStart: scheduleState.nextStartAt,
    });
    return { ok: false, reason: 'scheduled-off', skipped: true };
  }

  target.running = true;
  try {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      if (stopping) break;
      // Keep the scheduler heartbeat fresh during long retry chains so a slow
      // but healthy visit is not mistaken for a stalled loop.
      status.lastLoopAt = Date.now();
      if (
        attempt > 1 &&
        target.scheduleEnabled &&
        getScheduleState(target, Date.now(), cfg.scheduleTimeZone).scheduledOff
      ) {
        await log({
          level: 'info',
          event: 'visit-retry-skipped',
          target: target.id,
          account: target.account,
          cycle,
          attempt,
          reason: 'scheduled-off',
        });
        break;
      }
      attempts = attempt;
      try {
        lastResult = await visitOnce(cfg, target, {
          timeoutMs: cycleTimeoutMs,
          wakeWaitMs: cycleWakeWaitMs,
        });
        await log({
          level: lastResult.ok ? 'info' : 'warn',
          event: 'visit',
          target: target.id,
          account: target.account,
          cycle,
          attempt,
          firstVisit: isFirstVisit,
          ok: lastResult.ok,
          reason: lastResult.reason ?? 'ready',
          status: lastResult.status ?? null,
          title: lastResult.title ?? null,
          loginPasswordConfigured: Boolean(lastResult.loginPasswordConfigured),
          loginPasswordFieldFound: Boolean(lastResult.loginPasswordFieldFound),
          loginAttempted: Boolean(lastResult.loginAttempted),
          loginSubmitted: Boolean(lastResult.loginSubmitted),
          proxy: redactProxy(target.proxy),
          ms: Date.now() - startedAt,
          ...(lastResult.html ? { html: lastResult.html } : {}),
          ...(lastResult.screenshot ? { screenshot: lastResult.screenshot } : {}),
        });
        if (lastResult.ok || isAuthenticationFailureReason(lastResult.reason)) break;
      } catch (error) {
        const described = describeVisitError(error);
        lastResult = { ok: false, reason: described.reason, proxyError: described.proxyError };
        await log({
          level: 'error',
          event: 'visit',
          target: target.id,
          account: target.account,
          cycle,
          attempt,
          firstVisit: isFirstVisit,
          ok: false,
          reason: described.reason,
          proxy: redactProxy(target.proxy),
          ...(described.proxyError ? { proxyError: true, detail: described.detail } : {}),
          ms: Date.now() - startedAt,
        });
      }
      if (
        attempt <= maxRetries &&
        !stopping &&
        !isAuthenticationFailureReason(lastResult?.reason)
      ) {
        const retryState = await waitForRetryWindow(
          target,
          cfg.retryDelayMs ?? 60_000,
          cfg.scheduleTimeZone,
        );
        if (retryState !== 'ready') {
          await log({
            level: 'info',
            event: 'visit-retry-skipped',
            target: target.id,
            account: target.account,
            cycle,
            attempt,
            reason: retryState,
          });
          break;
        }
      }
    }
  } finally {
    target.running = false;
  }
  const finalResult = lastResult ?? { ok: false, reason: 'stopped' };
  if (attempts === 0) {
    // Shutdown happened before the first attempt. Do not record a visit or a
    // failure that never took place (it would skew /metrics and stats.json).
    return { ...finalResult, aborted: true };
  }
  const currentScheduleState = getScheduleState(
    target,
    Date.now(),
    cfg.scheduleTimeZone,
  );
  if (
    !stopping &&
    attempts > 0 &&
    scheduleState.active &&
    scheduleState.windowKey &&
    currentScheduleState.active &&
    currentScheduleState.windowKey === scheduleState.windowKey
  ) {
    // First-visit parameters apply to the first cycle of a window, not only to
    // the first successful cycle. A failed cold start must not keep every later
    // cycle in the long wake window for the rest of the day.
    target.firstVisitWindowKey = scheduleState.windowKey;
  }
  recordVisit(status, target, finalResult, { ms: Date.now() - startedAt });
  target.lastVisit = {
    ...finalResult,
    at: new Date().toISOString(),
    attempts,
    ms: Date.now() - startedAt,
    firstVisit: isFirstVisit,
  };
  if (finalResult.ok) {
    target.authFailureCount = 0;
    target.lastSuccessfulVisitAt = target.lastVisit.at;
  } else if (isAuthenticationFailureReason(finalResult.reason)) {
    target.authFailureCount = (target.authFailureCount ?? 0) + 1;
    if (target.authFailureCount >= AUTH_FAILURE_PAUSE_THRESHOLD) {
      pauseTarget(
        target,
        `连续 ${target.authFailureCount} 次认证失败，自动暂停 30 分钟`,
        Date.now() + AUTH_FAILURE_PAUSE_MS,
      );
      await log({
        level: 'warn',
        event: 'target-auto-paused',
        target: target.id,
        account: target.account,
        authFailureCount: target.authFailureCount,
        pausedUntil: target.pausedUntil,
      });
    }
  }
  runtimeStateStore?.schedule();
  return finalResult;
}


/**
 * Runs the given targets with a bounded worker pool. Each visit owns its own
 * browser process, so one hanging app cannot stall or crash the others.
 */
async function runTargets(cfg, targets, log, cycle, status, notifier = null, semaphore = null) {
  const results = new Map();
  const queuedTargets = new Set(targets);
  queuedTargets.forEach((target) => {
    target.schedulerQueued = true;
  });
  // Every target is an independent task behind one shared permit. A sweep can
  // therefore never exceed maxConcurrent browsers, and a second sweep started
  // while the first is still retrying simply queues behind it instead of
  // waiting for the whole batch to finish.
  const limit = semaphore ?? createSemaphore(cfg.maxConcurrent);
  const runOne = async (target) => {
    await limit.acquire();
    try {
      if (stopping) return;
      let result;
      try {
        result = await runTargetCycle(cfg, target, log, cycle, status);
      } catch (error) {
        // One target blowing up must never take down the scheduler: a rejected
        // task would reject Promise.all -> main loop -> process.exit(1), which
        // silently ends keep-alive for every other target.
        target.running = false;
        const previousFailures = Math.max(0, Number(target.consecutiveFailures) || 0);
        target.lastResult = 'failed';
        target.consecutiveFailures = previousFailures + 1;
        results.set(target.id, false);
        await log({
          level: 'error',
          event: 'target-cycle-crashed',
          target: target.id,
          account: target.account,
          error: describeVisitError(error).reason,
          consecutiveFailures: target.consecutiveFailures,
        }).catch(() => {});
        if (!cfg.once) {
          const delay = scheduleNext(target, { failed: true }, Date.now(), cfg.scheduleTimeZone);
          await log({
            level: 'warn',
            event: 'scheduled',
            target: target.id,
            account: target.account,
            consecutiveFailures: target.consecutiveFailures,
            nextVisitInMin: Math.ceil(delay / MINUTE),
          }).catch(() => {});
        }
        return;
      }
      if (result.aborted) {
        results.set(target.id, true);
        return;
      }
      if (result.skipped) {
        results.set(target.id, true);
        if (!cfg.once) {
          const scheduleState = getScheduleState(target, Date.now(), cfg.scheduleTimeZone);
          target.nextDue = scheduleState.nextStartMs ?? null;
          const nextVisitInMin = Number.isFinite(target.nextDue)
            ? Math.ceil(Math.max(0, target.nextDue - Date.now()) / MINUTE)
            : null;
          await log({
            level: 'info',
            event: 'scheduled-skipped',
            target: target.id,
            account: target.account,
            reason: result.reason,
            nextVisitInMin,
          });
          runtimeStateStore?.schedule();
        }
        return;
      }
      const ok = Boolean(result.ok);
      results.set(target.id, ok);
      const previousFailures = Math.max(0, Number(target.consecutiveFailures) || 0);
      target.lastResult = ok ? 'ok' : 'failed';
      target.consecutiveFailures = ok ? 0 : previousFailures + 1;
      if (ok && previousFailures > 0) {
        notifier?.notify(`target:${target.id}:recovered`, {
          event: 'target-recovered',
          severity: 'info',
          target: target.id,
          account: target.account,
          previousFailures,
        });
      } else if (!ok && target.consecutiveFailures === cfg.webhookFailureThreshold) {
        notifier?.notify(`target:${target.id}:failed`, {
          event: 'target-failure',
          severity: 'error',
          target: target.id,
          account: target.account,
          reason: String(result.reason ?? 'unknown').slice(0, 200),
          consecutiveFailures: target.consecutiveFailures,
        });
      }
      if (!cfg.once) {
        if (target.paused) {
          target.nextDue = null;
          await log({
            level: 'warn',
            event: 'scheduled-paused',
            target: target.id,
            account: target.account,
            reason: target.pauseReason,
            pausedUntil: target.pausedUntil,
          });
        } else {
          const delay = scheduleNext(target, { failed: !ok }, Date.now(), cfg.scheduleTimeZone);
          await log({
            level: ok ? 'info' : 'warn',
            event: 'scheduled',
            target: target.id,
            account: target.account,
            consecutiveFailures: target.consecutiveFailures,
            authFailureCount: target.authFailureCount,
            nextVisitInMin: Math.ceil(delay / MINUTE),
          });
        }
        runtimeStateStore?.schedule();
      }
    } finally {
      limit.release();
    }
  };
  try {
    await Promise.all(targets.map(runOne));
  } finally {
    queuedTargets.forEach((target) => {
      target.schedulerQueued = false;
    });
  }
  status.sweeps += 1;
  status.lastSweepAt = new Date().toISOString();
  return results;
}

async function main() {
  let cfg;
  let admin;
  let release = null;
  let failureDumpCleanupTimer = null;
  let shutdownForceTimer = null;
  try {
    cfg = loadConfig();
    if (cfg.probeUrl) {
      await runProbeCli(cfg);
      return;
    }
    admin = createAdminAuth(cfg);
    release = await acquireLock(cfg);
    if (!release) {
      console.error(`another keep-alive instance is already running (lock: ${cfg.lockFile})`);
      process.exit(0);
    }
    cfg.targetSecrets = await initializeTargetSecretStore(cfg);
    hydrateManagedTargetPasswords(cfg, cfg.targetSecrets);
  } catch (error) {
    await release?.().catch(() => {});
    console.error(`configuration error: ${error.message}`);
    process.exit(2);
  }

  await mkdir(cfg.logDir, { recursive: true });
  await rotateLog(cfg.logFile);

  const log = createLogger(cfg);
  runtimeStateStore = createRuntimeStateStore(cfg, log);
  statsStore = createStatsStore(cfg, log);
  const notifier = createNotifier(cfg, log);
  try {
    await runtimeStateStore.load();
  } catch (error) {
    await log({
      level: 'error',
      event: 'state-load-failed',
      error: error.message,
    }).catch(() => {});
    await release?.().catch(() => {});
    process.exitCode = 2;
    return;
  }
  try {
    await statsStore.load();
  } catch (error) {
    // Statistics are telemetry, not runtime state: a truncated or hand-edited
    // stats.json must never stop the agent from keeping sites awake. The store
    // is already empty after a failed load and the next flush rewrites it.
    await log({
      level: 'warn',
      event: 'stats-load-failed',
      error: error.message,
      recovery: 'starting with empty statistics',
    }).catch(() => {});
  }
  const status = createStatus(cfg);
  const controls = createRunController(cfg);
  // One permit pool for the whole process: sweeps may overlap, browsers may not.
  const visitSemaphore = createSemaphore(cfg.maxConcurrent);
  status.visitPermits = visitSemaphore;
  const keepOpenManager = createKeepOpenManager(cfg, log, {
    launchBrowser: async (opts) => {
      const b = await puppeteer.launch(opts);
      ACTIVE_BROWSERS.add(b);
      return b;
    },
    closeBrowser,
    openTargetPage,
    onTargetStateChanged: () => runtimeStateStore?.schedule(),
    onAlert: (payload) =>
      notifier.notify(`keep-open:${payload.target}`, {
        severity: 'warn',
        ...payload,
      }),
  });
  const targetManager = createTargetManager(cfg, status, controls, keepOpenManager);

  try {
    await cleanupFailureDumps(cfg);
  } catch (error) {
    await log({
      level: 'warn',
      event: 'failure-dump-cleanup-failed',
      error: error.message,
    }).catch(() => {});
  }
  if (!cfg.once) {
    failureDumpCleanupTimer = setInterval(() => {
      cleanupFailureDumps(cfg).catch((error) => {
        void log({
          level: 'warn',
          event: 'failure-dump-cleanup-failed',
          error: error.message,
        });
      });
    }, FAILURE_DUMP_CLEANUP_INTERVAL_MS);
    failureDumpCleanupTimer.unref?.();
  }

  const health = startHealthServer(cfg, status, log, controls, admin, targetManager, keepOpenManager);
  const stop = (signal) => {
    const firstSignal = !stopping;
    requestStop();
    keepOpenManager.stopAll().catch(() => {});
    if (!firstSignal) return;
    void log({ level: 'info', event: 'shutdown', signal }).catch(() => {});
    shutdownForceTimer = setTimeout(() => {
      void log({
        level: 'warn',
        event: 'shutdown-timeout',
        graceMs: SHUTDOWN_GRACE_MS,
      }).catch(() => {});
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  await log({
    level: 'info',
    event: 'start',
    mode: cfg.targets.length > 1 ? 'multi' : cfg.targets.length === 1 ? 'single' : 'managed',
    scheduleTimeZone: cfg.scheduleTimeZone,
    targets: cfg.targets.map((t) => ({ id: t.id, account: t.account, url: t.url, proxy: redactProxy(t.proxy) })),
    intervalMin:
      cfg.targets.length > 0
        ? Math.round(Math.min(...cfg.targets.map((t) => t.intervalMs)) / MINUTE)
        : null,
    maxConcurrent: cfg.maxConcurrent,
    maxKeepOpenSessions: cfg.maxKeepOpenSessions,
    headless: cfg.headless,
    bindHost: cfg.bindHost,
    requireHttps: cfg.requireHttps,
    port: cfg.port || null,
    chrome: cfg.chromePath,
    pid: process.pid,
  });

  try {
    if (cfg.once) {
      const results = await runTargets(cfg, cfg.targets, log, 0, status);
      const failed = [...results.entries()].filter(([, ok]) => !ok);
      await log({
        level: failed.length === 0 ? 'info' : 'warn',
        event: 'summary',
        mode: 'once',
        total: results.size,
        ok: results.size - failed.length,
        failed: failed.map(([id]) => id),
      });
      process.exitCode = failed.length === 0 ? 0 : 1;
      return;
    }

    // Spread the first sweep over one interval so visits don't burst at boot.
    // Targets added through the web console already receive a near-term nextDue.
    if (cfg.targets.length > 0) {
      const minInterval = Math.min(...cfg.targets.map((t) => t.intervalMs));
      cfg.targets.forEach((target, index) => {
        if (!target.paused && (!Number.isFinite(target.nextDue) || target.nextDue <= 0)) {
          if (target.scheduleEnabled) {
            const scheduleState = getScheduleState(target, Date.now(), cfg.scheduleTimeZone);
            if (scheduleState.scheduledOff) {
              target.nextDue = scheduleState.nextStartMs;
              return;
            }
          }
          target.nextDue = Date.now() + Math.floor((index * minInterval) / cfg.targets.length);
        }
      });
      runtimeStateStore?.schedule();
    }

    let cycle = 0;
    let lastReadinessCheckAt = 0;
    let lastReadinessReady = null;
    // A sweep can take minutes (cold start + retries), and awaiting it inline
    // froze this loop: no other target was scheduled, keep-open windows were not
    // evaluated, and expired pauses were not resumed until the sweep finished.
    // Sweeps run in the background so this loop keeps evaluating keep-open
    // windows, expired pauses and readiness while a slow target retries. Several
    // sweeps may overlap; `schedulerQueued` keeps them from visiting the same
    // target twice and `visitSemaphore` caps the total browser count.
    const sweepsInFlight = new Set();
    let lastWallClock = 0;
    while (!stopping) {
      const now = Date.now();
      // A backwards clock step would leave nextDue in the far future and stop
      // every visit until the clock catches up. Detect it and pull the affected
      // targets back to a normal horizon.
      if (lastWallClock > 0 && now < lastWallClock - CLOCK_REWIND_TOLERANCE_MS) {
        void log({
          level: 'warn',
          event: 'clock-rewind',
          deltaMs: now - lastWallClock,
        });
        for (const target of cfg.targets) {
          if (target.paused || !Number.isFinite(target.nextDue)) continue;
          const horizon = now + target.intervalMs + target.jitterMs;
          if (target.nextDue > horizon) target.nextDue = horizon;
        }
        runtimeStateStore?.schedule();
      }
      lastWallClock = now;
      status.lastLoopAt = now;
      await keepOpenManager.tick(cfg.targets, now, cfg.scheduleTimeZone);
      const tickMs = Date.now() - now;
      const resumed = resumeExpiredPauses(cfg.targets);
      if (resumed.length > 0) {
        await log({ level: 'info', event: 'targets-auto-resumed', targets: resumed });
      }
      // Readiness is expensive to compute (per-target timezone math), so poll it
      // on a fixed cadence. The first sample reports a broken start; afterwards
      // only transitions are worth a page.
      if (now - lastReadinessCheckAt >= 30_000) {
        lastReadinessCheckAt = now;
        const readiness = buildReadinessPayload(cfg, now, keepOpenManager);
        if (lastReadinessReady === null) {
          // First sample: a deployment that starts broken is exactly the case
          // nobody is watching, so report it instead of waiting for a
          // transition that may never come. Recovery has nothing to undo yet.
          if (!readiness.ready) {
            notifier.notify('readiness', {
              event: 'readiness-not-ready',
              severity: 'error',
              issueCount: readiness.issueCount,
              targets: readiness.issues.map((issue) => issue.id).slice(0, 20),
            });
          }
        } else if (readiness.ready !== lastReadinessReady) {
          if (!readiness.ready) {
            notifier.notify('readiness', {
              event: 'readiness-not-ready',
              severity: 'error',
              issueCount: readiness.issueCount,
              targets: readiness.issues.map((issue) => issue.id).slice(0, 20),
            });
          } else {
            notifier.notify('readiness-recovered', {
              event: 'readiness-recovered',
              severity: 'info',
            });
          }
        }
        lastReadinessReady = readiness.ready;
      }
      const manual = new Set(controls.takePending());
      const dueStartedAt = Date.now();
      const due = cfg.targets.filter((target) => {
        if (target.paused || target.managementLocked || target.schedulerQueued) return false;
        if (keepOpenManager.isSessionActive(target.id)) return false;
        if (manual.has(target.id)) return true;
        if (!Number.isFinite(target.nextDue) || target.nextDue > now) return false;
        if (target.scheduleEnabled) {
          const scheduleState = getScheduleState(target, now, cfg.scheduleTimeZone);
          if (scheduleState.scheduledOff) {
            target.nextDue = scheduleState.nextStartMs;
            return false;
          }
        }
        return true;
      });
      if (due.length > 0) {
        cycle += 1;
        // Surface scheduler lag: a visit that starts long after nextDue means the
        // loop was blocked or the wait granularity is too coarse.
        const oldestDue = Math.min(
          ...due.map((target) => (Number.isFinite(target.nextDue) ? target.nextDue : now)),
        );
        const lagMs = Math.max(0, now - oldestDue);
        if (lagMs >= 2_000) {
          void log({
            level: 'info',
            event: 'scheduler-lag',
            lagMs,
            tickMs,
            dueMs: dueStartedAt - now,
            targets: due.map((target) => target.id).slice(0, 10),
          });
        }
        let sweep;
        sweep = runTargets(cfg, due, log, cycle, status, notifier, visitSemaphore)
          .catch((error) =>
            log({
              level: 'error',
              event: 'sweep-crashed',
              error: String(error?.message ?? error).slice(0, 200),
            }).catch(() => {}),
          )
          .finally(() => {
            sweepsInFlight.delete(sweep);
          });
        sweepsInFlight.add(sweep);
      }
      const nextDue = Math.min(
        ...cfg.targets
          .filter(
            (target) =>
              !target.paused &&
              !target.managementLocked &&
              !target.schedulerQueued &&
              Number.isFinite(target.nextDue),
          )
          .map((target) => target.nextDue),
      );
      const requestedWaitMs = Number.isFinite(nextDue)
        ? Math.max(1000, Math.min(5000, nextDue - Date.now()))
        : 1000;
      const waitStartedAt = Date.now();
      await waitForStop(requestedWaitMs);
      // setTimeout can overshoot badly when the event loop is starved by a busy
      // Chromium; that delay directly becomes scheduling lag.
      const waitMs = Date.now() - waitStartedAt;
      if (waitMs - requestedWaitMs > 2_000) {
        void log({
          level: 'warn',
          event: 'scheduler-wait-overshoot',
          requestedWaitMs,
          waitMs,
        });
      }
    }
    // Let every in-flight sweep close its browsers before the process exits.
    await Promise.allSettled([...sweepsInFlight]);
  } finally {
    try {
      await runtimeStateStore?.flushNow();
    } catch (error) {
      await log({
        level: 'warn',
        event: 'runtime-state-flush-failed',
        error: error.message,
      }).catch(() => {});
    }
    try {
      await statsStore?.flushNow();
    } catch (error) {
      await log({
        level: 'warn',
        event: 'stats-flush-failed',
        error: error.message,
      }).catch(() => {});
    }
    if (failureDumpCleanupTimer) clearInterval(failureDumpCleanupTimer);
    if (health) {
      await new Promise((resolve) => health.close(resolve));
    }
    if (shutdownForceTimer) clearTimeout(shutdownForceTimer);
    admin.sessions.clear();
    await release();
  }
}

main().catch((error) => {
  console.error(`fatal: ${error.stack ?? error.message}`);
  process.exit(1);
});




