import assert from 'node:assert/strict';
import {
  DEFAULT_KEEP_OPEN_END,
  DEFAULT_KEEP_OPEN_START,
  KeepOpenCapacityError,
  createKeepOpenManager,
  isKeepOpenWindowActive,
  normalizeKeepOpenFields,
} from '../keepopen.mjs';
import { getScheduleState, parseZonedTimeToMs } from '../schedule.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makePage({ evaluate, reload } = {}) {
  let closed = false;
  const listeners = new Map();
  const mainFrameToken = {};
  return {
    evaluate:
      evaluate ??
      (async () => ({
        readyState: 'complete',
        hasBody: true,
        text: 'app ready',
      })),
    viewport: () => ({ width: 1366, height: 900 }),
    mouse: { move: async () => {} },
    reload: reload ?? (async () => {}),
    isClosed: () => closed,
    close: async () => {
      closed = true;
    },
    on(event, listener) {
      const entries = listeners.get(event) ?? [];
      entries.push(listener);
      listeners.set(event, entries);
    },
    off(event, listener) {
      const entries = listeners.get(event) ?? [];
      listeners.set(
        event,
        entries.filter((entry) => entry !== listener),
      );
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    mainFrame: () => mainFrameToken,
  };
}

function makeTarget(id, overrides = {}) {
  return {
    id,
    account: null,
    url: `https://${id}.blitz.cloud/`,
    timeoutMs: 1_000,
    wakeWaitMs: 1_000,
    keepOpenEnabled: true,
    keepOpenScheduled: false,
    keepOpenManual: true,
    keepOpenActive: false,
    ...overrides,
  };
}

function createHarness(overrides = {}) {
  const state = {
    launches: 0,
    closes: 0,
    opens: 0,
    logs: [],
    openOptions: [],
  };
  const manager = createKeepOpenManager(
    {
      chromePath: 'chrome',
      headless: true,
      maxKeepOpenSessions: 1,
      ...overrides.cfg,
    },
    async (entry) => {
      state.logs.push(entry);
    },
    {
      launchBrowser: async () => {
        state.launches += 1;
        return { id: state.launches };
      },
      closeBrowser: async () => {
        state.closes += 1;
      },
      openTargetPage: async (_cfg, _target, _browser, options = {}) => {
        state.opens += 1;
        state.openOptions.push(options);
        return { ok: true, page: makePage() };
      },
      heartbeatIntervalMs: 5,
      pageRefreshIntervalMs: 60_000,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      ...overrides.dependencies,
    },
  );
  return { manager, state };
}

function runKeepOpenUnitTests() {
  console.log('[test/keepopen.mjs] 1. Running keepopen unit tests...');

  const defaults = normalizeKeepOpenFields();
  assert.equal(defaults.keepOpenEnabled, false);
  assert.equal(defaults.keepOpenScheduled, false);
  assert.equal(defaults.keepOpenStart, DEFAULT_KEEP_OPEN_START);
  assert.equal(defaults.keepOpenEnd, DEFAULT_KEEP_OPEN_END);

  const custom = normalizeKeepOpenFields({
    keepOpenEnabled: true,
    keepOpenScheduled: true,
    keepOpenStart: '10:00',
    keepOpenEnd: '20:00',
  });
  assert.equal(custom.keepOpenEnabled, true);
  assert.equal(custom.keepOpenScheduled, true);
  assert.equal(custom.keepOpenStart, '10:00');
  assert.equal(custom.keepOpenEnd, '20:00');

  assert.equal(normalizeKeepOpenFields({ keepOpenEnabled: 'false' }).keepOpenEnabled, false);
  assert.equal(normalizeKeepOpenFields({ keepOpenEnabled: 'true' }).keepOpenEnabled, true);
  assert.throws(
    () => normalizeKeepOpenFields({ keepOpenEnabled: 'yes' }),
    /keepOpenEnabled.*布尔值/,
  );
  assert.throws(
    () => normalizeKeepOpenFields({ keepOpenScheduled: 1 }),
    /keepOpenScheduled.*布尔值/,
  );
  // Cross-midnight keep-open windows are valid: 20:00 - 10:00.
  assert.equal(
    normalizeKeepOpenFields({ keepOpenStart: '20:00', keepOpenEnd: '10:00' }).keepOpenStart,
    '20:00',
  );
  assert.throws(
    () => normalizeKeepOpenFields({ keepOpenStart: '10:00', keepOpenEnd: '10:00' }),
    /不能相同/,
  );

  const target = {
    keepOpenEnabled: true,
    keepOpenScheduled: true,
    keepOpenStart: '09:00',
    keepOpenEnd: '18:00',
  };
  const insideMs = parseZonedTimeToMs('2026-10-19', '14:00', 'Asia/Shanghai');
  assert.equal(isKeepOpenWindowActive(target, insideMs, 'Asia/Shanghai'), true);
  const outsideMs = parseZonedTimeToMs('2026-10-19', '20:00', 'Asia/Shanghai');
  assert.equal(isKeepOpenWindowActive(target, outsideMs, 'Asia/Shanghai'), false);
  assert.equal(
    isKeepOpenWindowActive({ ...target, keepOpenScheduled: false }, insideMs, 'Asia/Shanghai'),
    false,
  );

  // 22:00 - 02:00 stays active before midnight and after midnight.
  const crossTarget = {
    keepOpenEnabled: true,
    keepOpenScheduled: true,
    keepOpenStart: '22:00',
    keepOpenEnd: '02:00',
  };
  assert.equal(
    isKeepOpenWindowActive(
      crossTarget,
      parseZonedTimeToMs('2026-10-19', '23:30', 'Asia/Shanghai'),
      'Asia/Shanghai',
    ),
    true,
  );
  assert.equal(
    isKeepOpenWindowActive(
      crossTarget,
      parseZonedTimeToMs('2026-10-20', '01:30', 'Asia/Shanghai'),
      'Asia/Shanghai',
    ),
    true,
  );
  assert.equal(
    isKeepOpenWindowActive(
      crossTarget,
      parseZonedTimeToMs('2026-10-20', '02:00', 'Asia/Shanghai'),
      'Asia/Shanghai',
    ),
    false,
  );
  assert.equal(
    isKeepOpenWindowActive(
      crossTarget,
      parseZonedTimeToMs('2026-10-19', '21:59', 'Asia/Shanghai'),
      'Asia/Shanghai',
    ),
    false,
  );

  console.log('[test/keepopen.mjs] KeepOpen unit tests passed.');
}

async function runSessionLifecycleTests() {
  console.log('[test/keepopen.mjs] 2. Running KeepOpen session lifecycle tests...');

  const { manager, state } = createHarness();
  const target = makeTarget('stay-app');
  const first = await manager.startTargetStay(target, 'manual');
  const duplicate = await manager.startTargetStay(target, 'manual');
  assert.equal(duplicate, first, 'duplicate start must reuse the active session');
  assert.equal(state.launches, 1);
  assert.equal(target.keepOpenActive, true);
  assert.equal(manager.isSessionActive(target.id), true);

  await manager.stopTargetStay(target.id, 'manual-stop');
  assert.equal(target.keepOpenActive, false);
  assert.equal(manager.isSessionActive(target.id), false);
  assert.ok(state.closes >= 1, 'stop must close the browser');

  console.log('[test/keepopen.mjs] KeepOpen session lifecycle tests passed.');
}

async function runCapacityTests() {
  console.log('[test/keepopen.mjs] 3. Running KeepOpen capacity tests...');

  const { manager } = createHarness({ cfg: { maxKeepOpenSessions: 1 } });
  const first = makeTarget('capacity-one');
  const second = makeTarget('capacity-two');
  await manager.startTargetStay(first, 'manual');
  await assert.rejects(
    manager.startTargetStay(second, 'manual'),
    (error) =>
      error instanceof KeepOpenCapacityError && error.status === 409 && error.code === 'keep-open-capacity',
  );
  assert.equal(second.keepOpenActive, false);
  await manager.stopTargetStay(first.id, 'test-cleanup');

  console.log('[test/keepopen.mjs] KeepOpen capacity tests passed.');
}

async function runHeartbeatReconnectTests() {
  console.log('[test/keepopen.mjs] 4. Running KeepOpen heartbeat reconnect tests...');

  let opens = 0;
  const { manager, state } = createHarness({
    dependencies: {
      heartbeatIntervalMs: 5,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      openTargetPage: async () => {
        opens += 1;
        if (opens === 1) {
          return {
            ok: true,
            page: makePage({
              evaluate: async () => {
                throw new Error('heartbeat-failed');
              },
            }),
          };
        }
        return { ok: true, page: makePage() };
      },
    },
  });
  const target = makeTarget('heartbeat-retry');
  await manager.startTargetStay(target, 'manual');
  await waitFor(() => opens >= 2, 'heartbeat reconnect');
  assert.equal(manager.isSessionActive(target.id), true);
  assert.ok(state.closes >= 1, 'failed page must close before reconnecting');
  assert.ok(state.logs.some((entry) => entry.event === 'keep-open-heartbeat-failed'));
  assert.ok(state.logs.some((entry) => entry.event === 'keep-open-reconnecting'));
  await manager.stopTargetStay(target.id, 'test-cleanup');

  console.log('[test/keepopen.mjs] KeepOpen heartbeat reconnect tests passed.');
}

async function runReloadReconnectTests() {
  console.log('[test/keepopen.mjs] 5. Running KeepOpen reload reconnect tests...');

  let opens = 0;
  const { manager, state } = createHarness({
    dependencies: {
      heartbeatIntervalMs: 5,
      pageRefreshIntervalMs: 1,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      openTargetPage: async () => {
        opens += 1;
        if (opens === 1) {
          return {
            ok: true,
            page: makePage({
              reload: async () => ({ status: () => 503 }),
            }),
          };
        }
        return { ok: true, page: makePage() };
      },
    },
  });
  const target = makeTarget('reload-retry');
  await manager.startTargetStay(target, 'manual');
  await waitFor(() => opens >= 2, 'reload reconnect');
  assert.equal(manager.isSessionActive(target.id), true);
  assert.ok(state.closes >= 1, 'failed reload must close the browser before reconnecting');
  assert.ok(state.logs.some((entry) => entry.event === 'keep-open-heartbeat-failed'));
  assert.ok(
    state.logs.some(
      (entry) =>
        entry.event === 'keep-open-heartbeat-failed' &&
        entry.reason === 'not-ready:http-503',
    ),
    'HTTP 503 reload must be treated as not ready',
  );
  assert.ok(state.logs.some((entry) => entry.event === 'keep-open-reconnecting'));
  await manager.stopTargetStay(target.id, 'test-cleanup');

  console.log('[test/keepopen.mjs] KeepOpen reload reconnect tests passed.');
}

async function runScheduledFirstVisitFailureTests() {
  console.log('[test/keepopen.mjs] 6. Running scheduled first-visit failure tests...');

  const timeZone = 'Asia/Shanghai';
  let persistCalls = 0;
  let opens = 0;
  const openOptions = [];
  const { manager } = createHarness({
    dependencies: {
      onTargetStateChanged: async () => {
        persistCalls += 1;
      },
      openTargetPage: async (_cfg, _target, _browser, options = {}) => {
        opens += 1;
        openOptions.push(options);
        if (opens === 1) {
          return { ok: false, reason: 'not-ready:http-503' };
        }
        return { ok: true, page: makePage(), status: 200 };
      },
    },
  });
  const target = makeTarget('scheduled-first-failure', {
    timeoutMs: 1_000,
    wakeWaitMs: 1_000,
    scheduleEnabled: true,
    scheduleStart: '00:00',
    scheduleEnd: '23:59',
    scheduleDays: [1, 2, 3, 4, 5, 6, 7],
    keepOpenScheduled: true,
    keepOpenStart: '00:00',
    keepOpenEnd: '23:59',
    firstVisitWakeWaitSec: 180,
    firstVisitTimeoutSec: 180,
    firstVisitRetries: 0,
    firstVisitWindowKey: null,
  });
  const windowKey = getScheduleState(target, Date.now(), timeZone).windowKey;
  assert.ok(windowKey, 'test window must be active');

  await assert.rejects(
    manager.startTargetStay(target, 'scheduled', timeZone),
    /keep-open-open-failed:not-ready:http-503/,
  );
  assert.equal(target.firstVisitWindowKey, windowKey);
  assert.ok(persistCalls > 0, 'first failed visit must persist the consumed window');
  assert.equal(manager.isSessionActive(target.id), false);
  assert.equal(openOptions[0].timeoutMs, 180_000);
  assert.equal(openOptions[0].wakeWaitMs, 180_000);

  await manager.startTargetStay(target, 'scheduled', timeZone);
  assert.equal(opens, 2);
  assert.equal(openOptions[1].timeoutMs, 1_000);
  assert.equal(openOptions[1].wakeWaitMs, 1_000);
  assert.equal(manager.isSessionActive(target.id), true);
  await manager.stopTargetStay(target.id, 'test-cleanup');

  console.log('[test/keepopen.mjs] Scheduled first-visit failure tests passed.');
}

async function runNavigationStatusReconnectTests() {
  console.log('[test/keepopen.mjs] 7. Running navigation status reconnect tests...');

  let opens = 0;
  const { manager, state } = createHarness({
    dependencies: {
      heartbeatIntervalMs: 5,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      openTargetPage: async () => {
        opens += 1;
        const page = makePage();
        if (opens === 1) {
          setTimeout(() => {
            page.emit('response', {
              request: () => ({ isNavigationRequest: () => true }),
              frame: () => page.mainFrame(),
              status: () => 503,
            });
          }, 1);
        }
        return { ok: true, page, status: 200 };
      },
    },
  });
  const target = makeTarget('navigation-status-retry');
  await manager.startTargetStay(target, 'manual');
  await waitFor(() => opens >= 2, 'navigation status reconnect');
  assert.equal(manager.isSessionActive(target.id), true);
  assert.ok(
    state.logs.some(
      (entry) =>
        entry.event === 'keep-open-heartbeat-failed' &&
        entry.reason === 'not-ready:http-503',
    ),
    'main-document HTTP 503 must fail the heartbeat',
  );
  assert.ok(state.logs.some((entry) => entry.event === 'keep-open-reconnecting'));
  await manager.stopTargetStay(target.id, 'test-cleanup');

  console.log('[test/keepopen.mjs] Navigation status reconnect tests passed.');
}

async function runSleepingContentTests() {
  console.log('[test/keepopen.mjs] 8. Running sleeping-content heartbeat tests...');

  let patternOpens = 0;
  const patternHarness = createHarness({
    dependencies: {
      heartbeatIntervalMs: 5,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      openTargetPage: async () => {
        patternOpens += 1;
        if (patternOpens === 1) {
          return {
            ok: true,
            page: makePage({
              evaluate: async () => ({
                readyState: 'complete',
                hasBody: true,
                text: 'This app is asleep right now. Waking it up...',
              }),
            }),
          };
        }
        return { ok: true, page: makePage() };
      },
    },
  });
  const patternTarget = makeTarget('sleeping-content', {
    notReadyPatterns: [/app\s+is\s+asleep/i],
  });
  await patternHarness.manager.startTargetStay(patternTarget, 'manual');
  await waitFor(() => patternOpens >= 2, 'sleeping-page reconnect');
  assert.equal(patternHarness.manager.isSessionActive(patternTarget.id), true);
  assert.ok(
    patternHarness.state.logs.some(
      (entry) =>
        entry.event === 'keep-open-heartbeat-failed' &&
        String(entry.reason).startsWith('not-ready:app\\s+is\\s+asleep'),
    ),
    'a sleeping page must fail the heartbeat even without a navigation',
  );
  await patternHarness.manager.stopTargetStay(patternTarget.id, 'test-cleanup');

  let expectOpens = 0;
  const expectHarness = createHarness({
    dependencies: {
      heartbeatIntervalMs: 5,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      openTargetPage: async () => {
        expectOpens += 1;
        if (expectOpens === 1) {
          return {
            ok: true,
            page: makePage({
              evaluate: async () => ({
                readyState: 'complete',
                hasBody: true,
                text: 'Welcome back',
              }),
            }),
          };
        }
        return { ok: true, page: makePage() };
      },
    },
  });
  const expectTarget = makeTarget('expect-content', { expectText: 'Dashboard' });
  await expectHarness.manager.startTargetStay(expectTarget, 'manual');
  await waitFor(() => expectOpens >= 2, 'expect-text reconnect');
  assert.equal(expectHarness.manager.isSessionActive(expectTarget.id), true);
  assert.ok(
    expectHarness.state.logs.some(
      (entry) =>
        entry.event === 'keep-open-heartbeat-failed' &&
        entry.reason === 'expect-text-missing',
    ),
    'missing expect text must fail the heartbeat',
  );
  await expectHarness.manager.stopTargetStay(expectTarget.id, 'test-cleanup');

  console.log('[test/keepopen.mjs] Sleeping-content heartbeat tests passed.');
}

async function runScheduledStopSuppressionTests() {
  console.log('[test/keepopen.mjs] 9. Running scheduled keep-open stop suppression tests...');

  let opens = 0;
  const { manager } = createHarness({
    dependencies: {
      heartbeatIntervalMs: 5,
      openTargetPage: async () => {
        opens += 1;
        return { ok: true, page: makePage() };
      },
    },
  });
  // The visit schedule is intentionally disabled: stopping a scheduled
  // keep-open session must be suppressed by the keep-open window itself, not
  // by the (unrelated) target visit schedule.
  const target = makeTarget('scheduled-suppress', {
    keepOpenManual: false,
    keepOpenScheduled: true,
    keepOpenStart: '00:00',
    keepOpenEnd: '23:59',
    scheduleEnabled: false,
  });
  await manager.startTargetStay(target, 'scheduled');
  assert.equal(manager.isSessionActive(target.id), true);

  await manager.stopTargetStay(target.id, 'manual');
  assert.equal(manager.isSessionActive(target.id), false);
  await manager.tick([target], Date.now(), 'Asia/Shanghai');
  assert.equal(
    manager.isSessionActive(target.id),
    false,
    'manual stop must not be undone by the next tick inside the same window',
  );
  assert.equal(opens, 1);

  // The suppression is scoped to one window: the next day starts again.
  await manager.tick([target], Date.now() + 24 * 60 * 60 * 1000, 'Asia/Shanghai');
  assert.equal(manager.isSessionActive(target.id), true);
  await manager.stopTargetStay(target.id, 'test-cleanup');

  console.log('[test/keepopen.mjs] Scheduled keep-open stop suppression tests passed.');
}

async function runSessionIdentityTests() {
  console.log('[test/keepopen.mjs] 10. Running KeepOpen session identity tests...');

  let releaseFirstClose;
  const firstCloseGate = new Promise((resolve) => {
    releaseFirstClose = resolve;
  });
  let closes = 0;
  const { manager } = createHarness({
    dependencies: {
      closeBrowser: async () => {
        closes += 1;
        if (closes === 1) await firstCloseGate;
      },
    },
  });
  const oldTarget = makeTarget('session-identity');
  const newTarget = makeTarget('session-identity');
  await manager.startTargetStay(oldTarget, 'manual');
  const stopping = manager.stopTargetStay(oldTarget.id, 'manual-stop');
  await waitFor(() => closes === 1, 'old browser close');

  await manager.startTargetStay(newTarget, 'manual');
  assert.equal(manager.isSessionActive(newTarget.id), true);
  releaseFirstClose();
  await stopping;

  assert.equal(manager.isSessionActive(newTarget.id), true, 'old session cleanup must not delete new session');
  assert.equal(newTarget.keepOpenActive, true);
  await manager.stopTargetStay(newTarget.id, 'test-cleanup');

  console.log('[test/keepopen.mjs] KeepOpen session identity tests passed.');
}

async function runUnstableAlertTests() {
  console.log('[test/keepopen.mjs] 11. Running keep-open instability alert tests...');

  // A page that connects fine but fails every heartbeat: the failure streak must
  // keep counting across reconnects, otherwise keep-open-unstable never fires
  // for the most common outage shape.
  const alerts = [];
  const { manager } = createHarness({
    dependencies: {
      heartbeatIntervalMs: 5,
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      openTargetPage: async () => ({
        ok: true,
        page: makePage({
          evaluate: async () => {
            throw new Error('heartbeat-failed');
          },
        }),
      }),
      onAlert: (payload) => {
        alerts.push(payload);
      },
    },
  });
  const target = makeTarget('unstable-heartbeat');
  await manager.startTargetStay(target, 'manual');
  await waitFor(() => alerts.length > 0, 'keep-open-unstable alert', 3_000);
  assert.equal(alerts[0].event, 'keep-open-unstable');
  assert.equal(alerts[0].target, target.id);
  assert.ok(alerts[0].consecutiveFailures >= 3);
  await manager.stopTargetStay(target.id, 'test-cleanup');

  console.log('[test/keepopen.mjs] Keep-open instability alert tests passed.');
}

runKeepOpenUnitTests();
if (!process.argv.includes('--unit-only')) {
  await runSessionLifecycleTests();
  await runCapacityTests();
  await runHeartbeatReconnectTests();
  await runReloadReconnectTests();
  await runScheduledFirstVisitFailureTests();
  await runNavigationStatusReconnectTests();
  await runSleepingContentTests();
  await runScheduledStopSuppressionTests();
  await runSessionIdentityTests();
  await runUnstableAlertTests();
}
