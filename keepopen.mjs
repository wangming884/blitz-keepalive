/**
 * blitz-keepalive keep-open manager
 *
 * Implements persistent stay / keep-open browser sessions for targets.
 * Keeps a dedicated Chromium page open continuously during scheduled windows
 * or manual activation, sending periodic keep-alive touches.
 */

import {
  parseZonedTimeToMs,
  getZonedDateParts,
  getScheduleState,
  addDaysToDateString,
  isCrossMidnightWindow,
  normalizeTimeString,
  resolveScheduleTimeZone,
} from './schedule.mjs';

export const DEFAULT_KEEP_OPEN_START = '09:00';
export const DEFAULT_KEEP_OPEN_END = '18:00';
export const DEFAULT_MAX_KEEP_OPEN_SESSIONS = 1;
export const MAX_KEEP_OPEN_SESSIONS = 10;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PAGE_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const START_RETRY_DELAY_MS = 30_000;
const ALERT_AFTER_FAILURES = 3;

export class KeepOpenCapacityError extends Error {
  constructor(limit) {
    super(`长驻挂机会话已达到上限 ${limit} 个，请先停止其他保持访问会话。`);
    this.name = 'KeepOpenCapacityError';
    this.code = 'keep-open-capacity';
    this.status = 409;
  }
}

function normalizeBooleanField(raw, fallback, key) {
  const value = raw[key] !== undefined ? raw[key] : fallback[key];
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${key} 必须是布尔值。`);
}

export function normalizeKeepOpenFields(raw = {}, fallback = {}) {
  const keepOpenEnabled = normalizeBooleanField(raw, fallback, 'keepOpenEnabled');
  const keepOpenScheduled = normalizeBooleanField(raw, fallback, 'keepOpenScheduled');

  const keepOpenStart = normalizeTimeString(
    raw.keepOpenStart ?? fallback.keepOpenStart ?? DEFAULT_KEEP_OPEN_START,
    'keepOpenStart',
  );

  const keepOpenEnd = normalizeTimeString(
    raw.keepOpenEnd ?? fallback.keepOpenEnd ?? DEFAULT_KEEP_OPEN_END,
    'keepOpenEnd',
  );

  if (keepOpenStart === keepOpenEnd) {
    throw new Error(
      `挂机时间段无效：开始时间与结束时间不能相同（${keepOpenStart}）。跨午夜请使用 22:00 - 02:00 这种开始晚于结束的写法。`,
    );
  }

  return {
    keepOpenEnabled,
    keepOpenScheduled,
    keepOpenStart,
    keepOpenEnd,
  };
}

export function isKeepOpenWindowActive(target, nowMs = Date.now(), timeZone = 'Asia/Shanghai') {
  if (!target || !target.keepOpenEnabled || !target.keepOpenScheduled) return false;
  const tz = resolveScheduleTimeZone(target, timeZone);
  const parts = getZonedDateParts(new Date(nowMs), tz);
  const startMs = parseZonedTimeToMs(parts.dateStr, target.keepOpenStart, tz);
  const endMs = parseZonedTimeToMs(parts.dateStr, target.keepOpenEnd, tz);
  if (isCrossMidnightWindow(target.keepOpenStart, target.keepOpenEnd)) {
    // 22:00 - 02:00 stays active from 22:00 today until 02:00 tomorrow.
    return nowMs >= startMs || nowMs < endMs;
  }
  return nowMs >= startMs && nowMs < endMs;
}

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }

    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      finish();
      resolve(true);
    };
    const timer = setTimeout(() => {
      finish();
      resolve(false);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(error) {
  return String(error?.message ?? error ?? 'unknown').slice(0, 500);
}

function browserArgsForTarget(cfg, target) {
  const args = [
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=1366,900',
    '--lang=en-US',
    '--disable-component-update',
    '--disable-sync',
    '--disable-domain-reliability',
    '--disable-background-mode',
    '--no-pings',
  ];
  if (cfg.chromeNoSandbox) args.unshift('--no-sandbox');
  if (target.proxy) {
    args.push(`--proxy-server=${target.proxy.server}`);
    if (target.proxy.bypass) args.push(`--proxy-bypass-list=${target.proxy.bypass}`);
  } else {
    args.push('--no-proxy-server');
  }
  return args;
}

/**
 * Heartbeat health check. A session must not stay "active" just because the tab
 * still renders something: blitz.cloud can put the app back to sleep while the
 * page stays open. Reuse the same signals as a regular visit (HTTP status, page
 * text, not-ready patterns and the configured expect text) so a sleeping app is
 * detected within one heartbeat instead of waiting for the periodic reload.
 */
async function pageHealth(page, target = null, response = null, trackedStatus = null) {
  if (!page || page.isClosed?.()) throw new Error('page-closed');
  const responseStatus = typeof response?.status === 'function' ? response.status() : null;
  const status = Number.isInteger(responseStatus) ? responseStatus : trackedStatus;
  if ([502, 503, 504].includes(status)) {
    throw new Error(`not-ready:http-${status}`);
  }
  const readState = () =>
    page.evaluate(() => ({
      readyState: document.readyState,
      hasBody: Boolean(document.body),
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 5000),
    }));

  let state = await readState();
  if (!state?.hasBody || !['interactive', 'complete'].includes(state.readyState)) {
    throw new Error(`page-not-ready:${state?.readyState ?? 'unknown'}`);
  }
  // A client-rendered app can still be empty right after a reload; give it one
  // short grace period instead of tearing the browser down on a blank frame.
  if (!state.text) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    state = await readState();
    if (!state?.hasBody || !['interactive', 'complete'].includes(state.readyState)) {
      throw new Error(`page-not-ready:${state?.readyState ?? 'unknown'}`);
    }
  }
  const text = typeof state.text === 'string' ? state.text : '';
  if (!text) throw new Error('empty-page');
  const notReadyPatterns = Array.isArray(target?.notReadyPatterns) ? target.notReadyPatterns : [];
  for (const pattern of notReadyPatterns) {
    if (pattern instanceof RegExp && pattern.test(text)) {
      throw new Error(`not-ready:${pattern.source}`);
    }
  }
  if (target?.expectText && !text.includes(target.expectText)) {
    throw new Error('expect-text-missing');
  }
  return state;
}

export function createKeepOpenManager(
  cfg,
  log,
  {
    launchBrowser,
    closeBrowser,
    openTargetPage,
    onTargetStateChanged = null,
    onAlert = null,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    pageRefreshIntervalMs = PAGE_REFRESH_INTERVAL_MS,
    reconnectBaseDelayMs = RECONNECT_BASE_DELAY_MS,
    reconnectMaxDelayMs = RECONNECT_MAX_DELAY_MS,
  },
) {
  if (typeof launchBrowser !== 'function') throw new Error('launchBrowser is required.');
  if (typeof closeBrowser !== 'function') throw new Error('closeBrowser is required.');
  if (typeof openTargetPage !== 'function') throw new Error('openTargetPage is required.');
  if (onTargetStateChanged !== null && typeof onTargetStateChanged !== 'function') {
    throw new Error('onTargetStateChanged must be a function when provided.');
  }
  if (onAlert !== null && typeof onAlert !== 'function') {
    throw new Error('onAlert must be a function when provided.');
  }

  const heartbeatMs = Math.max(1, Math.floor(heartbeatIntervalMs));
  const pageRefreshMs = Math.max(1, Math.floor(pageRefreshIntervalMs));
  const reconnectBaseMs = Math.max(1, Math.floor(reconnectBaseDelayMs));
  const reconnectMaxMs = Math.max(reconnectBaseMs, Math.floor(reconnectMaxDelayMs));

  const sessions = new Map();
  const retryAfter = new Map();
  const suppressedWindows = new Map();
  const maxSessions = Math.max(
    1,
    Number.isInteger(cfg.maxKeepOpenSessions)
      ? cfg.maxKeepOpenSessions
      : DEFAULT_MAX_KEEP_OPEN_SESSIONS,
  );

  async function safeLog(entry) {
    try {
      await log(entry);
    } catch {
      // Logging must never break a browser session or shutdown path.
    }
  }

  async function notifyTargetStateChanged() {
    if (!onTargetStateChanged) return;
    try {
      await onTargetStateChanged();
    } catch (error) {
      await safeLog({
        level: 'warn',
        event: 'keep-open-state-persist-failed',
        reason: errorMessage(error),
      });
    }
  }

  function scheduledWindowEnded(session) {
    if (session.reason !== 'scheduled') return false;
    // A scheduled keep-open session is driven by the keep-open window
    // (keepOpenStart/keepOpenEnd), not by the target's visit schedule. Using
    // the visit schedule here killed sessions early whenever both features
    // were configured with different hours.
    return !isKeepOpenWindowActive(session.target, Date.now(), session.timeZone);
  }

  function throwIfScheduledWindowEnded(session) {
    if (!scheduledWindowEnded(session)) return;
    const error = new Error('keep-open-window-ended');
    error.code = 'keep-open-window-ended';
    throw error;
  }

  async function markFirstVisitAttempted(session, attemptedWindowKey) {
    if (
      !attemptedWindowKey ||
      !session.active ||
      session.abortController.signal.aborted
    ) {
      return;
    }
    const currentScheduleState = getScheduleState(
      session.target,
      Date.now(),
      session.timeZone,
    );
    if (
      !currentScheduleState.active ||
      currentScheduleState.windowKey !== attemptedWindowKey
    ) {
      return;
    }
    session.target.firstVisitWindowKey = currentScheduleState.windowKey;
    await notifyTargetStateChanged();
  }

  function stopTrackingPageResponses(session) {
    const page = session.trackedPage;
    const listener = session.responseListener;
    if (page && listener && typeof page.off === 'function') {
      page.off('response', listener);
    }
    session.trackedPage = null;
    session.responseListener = null;
  }

  function trackPageResponses(session, page) {
    stopTrackingPageResponses(session);
    if (typeof page?.on !== 'function') return;

    const listener = (response) => {
      try {
        const request = response?.request?.();
        if (!request?.isNavigationRequest?.()) return;
        const frame = response?.frame?.();
        if (frame && typeof page.mainFrame === 'function' && frame !== page.mainFrame()) return;
        const status = response?.status?.();
        if (Number.isInteger(status)) session.lastDocumentStatus = status;
      } catch {
        // A closing page may invalidate its frame while an event is being handled.
      }
    };
    session.trackedPage = page;
    session.responseListener = listener;
    page.on('response', listener);
  }

  async function closeSessionBrowser(session) {
    const browser = session.browser;
    stopTrackingPageResponses(session);
    session.browser = null;
    session.page = null;
    session.lastDocumentStatus = null;
    if (browser) await closeBrowser(browser);
  }

  async function connectSessionOnce(session, { timeoutMs, wakeWaitMs }) {
    const { target } = session;
    throwIfScheduledWindowEnded(session);
    session.status = 'connecting';
    const browser = await launchBrowser({
      executablePath: cfg.chromePath,
      headless: cfg.headless,
      defaultViewport: { width: 1366, height: 900 },
      args: browserArgsForTarget(cfg, target),
    });
    session.browser = browser;

    throwIfScheduledWindowEnded(session);
    if (!session.active || session.abortController.signal.aborted) {
      throw new Error('keep-open-session-stopped');
    }

    const opened = await openTargetPage(cfg, target, browser, {
      timeoutMs,
      wakeWaitMs,
      dumpOnFailure: false,
    });
    throwIfScheduledWindowEnded(session);
    if (!opened.ok) {
      throw new Error(`keep-open-open-failed:${opened.reason || 'unknown'}`);
    }
    if (!session.active || session.abortController.signal.aborted) {
      throw new Error('keep-open-session-stopped');
    }

    session.page = opened.page;
    session.lastDocumentStatus = Number.isInteger(opened.status) ? opened.status : null;
    trackPageResponses(session, opened.page);
    session.status = 'active';
    session.lastHeartbeatAt = Date.now();
    await safeLog({
      level: 'info',
      event: 'keep-open-connected',
      target: target.id,
      reason: session.reason,
    });
  }

  async function connectSession(session) {
    const { target } = session;
    throwIfScheduledWindowEnded(session);
    const scheduleState =
      session.reason === 'scheduled'
        ? getScheduleState(target, Date.now(), session.timeZone)
        : null;
    const attemptedWindowKey = scheduleState?.windowKey ?? null;
    const firstScheduledConnect =
      session.reason === 'scheduled' &&
      session.firstConnectCompleted !== true &&
      scheduleState?.firstVisitPending === true;
    const firstVisitTimeoutSec = Number(target.firstVisitTimeoutSec);
    const firstVisitWakeWaitSec = Number(target.firstVisitWakeWaitSec);
    const timeoutMs =
      firstScheduledConnect && Number.isFinite(firstVisitTimeoutSec)
        ? firstVisitTimeoutSec * 1000
        : target.timeoutMs || 30_000;
    const wakeWaitMs =
      firstScheduledConnect && Number.isFinite(firstVisitWakeWaitSec)
        ? firstVisitWakeWaitSec * 1000
        : target.wakeWaitMs;
    const retries = firstScheduledConnect
      ? Math.max(0, Math.min(5, Math.trunc(Number(target.firstVisitRetries) || 0)))
      : 0;
    const maxAttempts = retries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      throwIfScheduledWindowEnded(session);
      try {
        await connectSessionOnce(session, { timeoutMs, wakeWaitMs });
        session.firstConnectCompleted = true;
        if (firstScheduledConnect) {
          await markFirstVisitAttempted(session, attemptedWindowKey);
        }
        return;
      } catch (error) {
        await closeSessionBrowser(session);
        if (!session.active || session.abortController.signal.aborted) throw error;
        throwIfScheduledWindowEnded(session);
        if (attempt >= maxAttempts) {
          if (firstScheduledConnect) {
            await markFirstVisitAttempted(session, attemptedWindowKey);
          }
          throw error;
        }

        await safeLog({
          level: 'warn',
          event: 'keep-open-first-connect-retry',
          target: target.id,
          attempt,
          maxAttempts,
          reason: errorMessage(error),
        });
        const aborted = await abortableSleep(
          Math.min(reconnectBaseMs, 5_000),
          session.abortController.signal,
        );
        if (aborted) throw new Error('keep-open-session-stopped');
        throwIfScheduledWindowEnded(session);
      }
    }
  }

  async function monitorSession(session, onHealthy) {
    const { target } = session;
    let lastPageRefreshAt = Date.now();

    while (session.active && !session.abortController.signal.aborted) {
      const aborted = await abortableSleep(heartbeatMs, session.abortController.signal);
      if (aborted || !session.active) return;

      const page = session.page;
      try {
        await pageHealth(page, target, null, session.lastDocumentStatus);
        const viewport = page.viewport() ?? { width: 1366, height: 900 };
        await page.mouse
          .move(
            Math.floor(viewport.width * 0.5 + (Math.random() - 0.5) * 100),
            Math.floor(viewport.height * 0.5 + (Math.random() - 0.5) * 100),
          )
          .catch(() => {});
        session.lastHeartbeatAt = Date.now();
        // Only a heartbeat that actually proved the page healthy clears the
        // failure streak. Resetting on connect alone made a session that
        // connects fine but fails every heartbeat loop forever without ever
        // reaching ALERT_AFTER_FAILURES.
        onHealthy?.();

        if (Date.now() - lastPageRefreshAt >= pageRefreshMs) {
          const reloadResponse = await page.reload({
            waitUntil: 'domcontentloaded',
            timeout: 15_000,
          });
          if (Number.isInteger(reloadResponse?.status?.())) {
            session.lastDocumentStatus = reloadResponse.status();
          }
          await pageHealth(page, target, reloadResponse, session.lastDocumentStatus);
          lastPageRefreshAt = Date.now();
          session.lastHeartbeatAt = Date.now();
        }
      } catch (error) {
        if (!session.active || session.abortController.signal.aborted) return;
        await safeLog({
          level: 'warn',
          event: 'keep-open-heartbeat-failed',
          target: target.id,
          reason: errorMessage(error),
        });
        throw error;
      }
    }
  }

  async function runSession(session) {
    const { target } = session;
    let consecutiveFailures = 0;

    try {
      while (session.active && !session.abortController.signal.aborted) {
        try {
          if (!session.page) {
            session.status = consecutiveFailures > 0 ? 'reconnecting' : 'connecting';
            await connectSession(session);
          }
          await monitorSession(session, () => {
            consecutiveFailures = 0;
          });
        } catch (error) {
          if (!session.active || session.abortController.signal.aborted) break;
          if (
            error?.code === 'keep-open-window-ended' ||
            scheduledWindowEnded(session)
          ) {
            session.stopReason = 'window-ended';
            session.active = false;
            session.abortController.abort();
            break;
          }
          consecutiveFailures += 1;
          await closeSessionBrowser(session);
          if (consecutiveFailures === ALERT_AFTER_FAILURES && onAlert) {
            try {
              await onAlert({
                event: 'keep-open-unstable',
                target: target.id,
                consecutiveFailures,
                reason: errorMessage(error),
              });
            } catch {
              // Alerting must never break the reconnect loop.
            }
          }
          await safeLog({
            level: 'warn',
            event: 'keep-open-reconnecting',
            target: target.id,
            reason: errorMessage(error),
            consecutiveFailures,
          });
          const delay = Math.min(
            reconnectMaxMs,
            reconnectBaseMs * Math.max(1, consecutiveFailures),
          );
          await abortableSleep(delay, session.abortController.signal);
        }
      }
    } finally {
      await closeSessionBrowser(session);
      if (sessions.get(target.id) === session) {
        sessions.delete(target.id);
        session.status = 'stopped';
        target.keepOpenActive = false;
        await safeLog({
          level: 'info',
          event: 'keep-open-stopped',
          target: target.id,
          reason: session.stopReason ?? 'session-ended',
          durationSec: Math.round((Date.now() - session.startedAt) / 1000),
        });
      }
    }
  }

  async function startTargetStay(
    target,
    reason = 'manual',
    timeZone = cfg.scheduleTimeZone ?? 'Asia/Shanghai',
  ) {
    if (reason === 'manual') suppressedWindows.delete(target.id);
    if (sessions.has(target.id)) {
      return sessions.get(target.id);
    }
    if (sessions.size >= maxSessions) {
      throw new KeepOpenCapacityError(maxSessions);
    }

    const abortController = new AbortController();
    const session = {
      targetId: target.id,
      target,
      startedAt: Date.now(),
      reason,
      timeZone,
      browser: null,
      page: null,
      active: true,
      abortController,
      status: 'starting',
      lastHeartbeatAt: null,
      stopReason: null,
      firstConnectCompleted: false,
      windowKey: reason === 'scheduled' ? keepOpenWindowKey(target, Date.now(), timeZone) : null,
      lastDocumentStatus: null,
      trackedPage: null,
      responseListener: null,
      done: null,
    };
    sessions.set(target.id, session);
    retryAfter.delete(target.id);
    target.keepOpenActive = true;

    await safeLog({
      level: 'info',
      event: 'keep-open-started',
      target: target.id,
      account: target.account,
      reason,
    });

    try {
      await connectSession(session);
    } catch (error) {
      session.active = false;
      abortController.abort();
      await closeSessionBrowser(session);
      if (sessions.get(target.id) === session) sessions.delete(target.id);
      target.keepOpenActive = false;
      await safeLog({
        level: 'warn',
        event: 'keep-open-start-failed',
        target: target.id,
        reason: errorMessage(error),
      });
      throw error;
    }

    session.done = runSession(session).catch((error) => {
      void safeLog({
        level: 'error',
        event: 'keep-open-loop-failed',
        target: target.id,
        reason: errorMessage(error),
      });
    });
    return session;
  }

  async function stopTargetStay(targetId, reason = 'manual') {
    const session = sessions.get(targetId);
    if (!session) return false;

    if (
      reason === 'manual' &&
      session.reason === 'scheduled' &&
      session.windowKey
    ) {
      suppressedWindows.set(targetId, session.windowKey);
    }

    session.active = false;
    session.stopReason = reason;
    session.abortController.abort();
    if (sessions.get(targetId) === session) sessions.delete(targetId);
    session.target.keepOpenActive = false;
    await closeSessionBrowser(session);
    if (session.done) await session.done;
    retryAfter.delete(targetId);
    await safeLog({
      level: 'info',
      event: 'keep-open-stopped',
      target: targetId,
      reason,
      durationSec: Math.round((Date.now() - session.startedAt) / 1000),
    });
    return true;
  }

  function getTargetStayStatus(targetId) {
    const session = sessions.get(targetId);
    if (!session) {
      return {
        active: false,
        durationSec: 0,
        status: 'inactive',
      };
    }
    return {
      active: true,
      durationSec: Math.round((Date.now() - session.startedAt) / 1000),
      status: session.status,
      reason: session.reason,
      startedAt: new Date(session.startedAt).toISOString(),
      lastHeartbeatAt: session.lastHeartbeatAt
        ? new Date(session.lastHeartbeatAt).toISOString()
        : null,
    };
  }

  async function tryStartFromTick(target, reason, nowMs, timeZone) {
    if ((retryAfter.get(target.id) ?? 0) > nowMs) return;
    try {
      await startTargetStay(target, reason, timeZone);
      retryAfter.delete(target.id);
    } catch (error) {
      retryAfter.set(target.id, nowMs + START_RETRY_DELAY_MS);
      await safeLog({
        level: 'warn',
        event:
          error instanceof KeepOpenCapacityError
            ? 'keep-open-session-limit'
            : 'keep-open-start-retry',
        target: target.id,
        reason: errorMessage(error),
        retryAfterSec: Math.round(START_RETRY_DELAY_MS / 1000),
      });
    }
  }

  function keepOpenWindowKey(target, nowMs, timeZone) {
    const tz = resolveScheduleTimeZone(target, timeZone);
    const parts = getZonedDateParts(new Date(nowMs), tz);
    let dateStr = parts.dateStr;
    if (isCrossMidnightWindow(target.keepOpenStart, target.keepOpenEnd)) {
      // Between midnight and the end time we are still inside the window that
      // started yesterday; the key must match the one used when it started.
      const endMs = parseZonedTimeToMs(parts.dateStr, target.keepOpenEnd, tz);
      if (nowMs < endMs) dateStr = addDaysToDateString(parts.dateStr, -1);
    }
    return `${dateStr}|${target.keepOpenStart}|${target.keepOpenEnd}`;
  }

  function isSuppressedWindow(target, nowMs, timeZone) {
    const suppressedKey = suppressedWindows.get(target.id);
    if (!suppressedKey) return false;
    if (suppressedKey === keepOpenWindowKey(target, nowMs, timeZone)) return true;
    suppressedWindows.delete(target.id);
    return false;
  }

  async function tick(targets, nowMs = Date.now(), timeZone = 'Asia/Shanghai') {
    await Promise.all(
      targets.map(async (target) => {
        if (target.paused) {
          if (sessions.has(target.id)) await stopTargetStay(target.id, 'target-paused');
          retryAfter.delete(target.id);
          return;
        }

        if (target.keepOpenManual) {
          if (!sessions.has(target.id)) {
            await tryStartFromTick(target, 'manual', nowMs, timeZone);
          }
          return;
        }

        const inWindow = isKeepOpenWindowActive(target, nowMs, timeZone);
        const isRunning = sessions.has(target.id);
        if (inWindow && !isRunning && !isSuppressedWindow(target, nowMs, timeZone)) {
          await tryStartFromTick(target, 'scheduled', nowMs, timeZone);
        } else if (!inWindow && isRunning && sessionIsScheduled(target.id)) {
          await stopTargetStay(target.id, 'window-ended');
        }
        if (!inWindow && !isRunning) {
          retryAfter.delete(target.id);
          isSuppressedWindow(target, nowMs, timeZone);
        }
      }),
    );
  }

  function sessionIsScheduled(targetId) {
    const session = sessions.get(targetId);
    return session?.reason === 'scheduled';
  }

  async function stopAll() {
    const entries = [...sessions.entries()];
    sessions.clear();
    for (const [, session] of entries) {
      session.active = false;
      session.stopReason = 'shutdown';
      session.abortController.abort();
      session.target.keepOpenActive = false;
    }
    await Promise.all(
      entries.map(async ([targetId, session]) => {
        await closeSessionBrowser(session);
        if (session.done) await session.done;
        await safeLog({
          level: 'info',
          event: 'keep-open-stopped',
          target: targetId,
          reason: 'shutdown',
          durationSec: Math.round((Date.now() - session.startedAt) / 1000),
        });
      }),
    );
    retryAfter.clear();
    suppressedWindows.clear();
  }

  return {
    startTargetStay,
    stopTargetStay,
    getTargetStayStatus,
    isSessionActive: (id) => sessions.has(id),
    tick,
    stopAll,
    get activeCount() {
      return sessions.size;
    },
  };
}
