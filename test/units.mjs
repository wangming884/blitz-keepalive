#!/usr/bin/env node
/**
 * Pure-function unit tests.
 *
 * These cover the three decisions that make or break keep-alive correctness:
 * "is the page actually the app", "when should we visit next", and "is this
 * target healthy". They run in milliseconds because they never launch a
 * browser — the end-to-end suites cover integration, not these boundaries.
 */
import assert from 'node:assert/strict';
import { classify, targetReadinessIssues, DEFAULT_NOT_READY_PATTERNS } from '../page-state.mjs';
import { buildResolverRules } from '../urlguard.mjs';
import {
  scheduleNext,
  MAX_VISIT_WINDOW_MIN,
  FAILURE_BACKOFF_START,
  DEFAULT_SCHEDULE_TIMEZONE,
} from '../schedule.mjs';

const MINUTE = 60_000;
const checks = [];

function state(text, { title = '', ready = 'complete' } = {}) {
  return { title, text, ready };
}

function target(overrides = {}) {
  return {
    id: 't1',
    intervalMs: 20 * MINUTE,
    jitterMs: 0,
    consecutiveFailures: 0,
    scheduleEnabled: false,
    notReadyPatterns: DEFAULT_NOT_READY_PATTERNS,
    expectText: '',
    nextDue: null,
    running: false,
    schedulerQueued: false,
    paused: false,
    lastSuccessfulVisitAt: null,
    keepOpenActive: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

console.log('[test/units.mjs] 1. classify: HTTP status and document state...');
assert.equal(classify(target(), state('Dashboard'), { status: 503 }).reason, 'not-ready:http-503');
assert.equal(classify(target(), state('Dashboard'), { status: 502 }).reason, 'not-ready:http-502');
assert.equal(classify(target(), state('Dashboard'), { status: 504 }).reason, 'not-ready:http-504');
assert.equal(classify(target(), state('Dashboard', { ready: 'loading' })).reason, 'loading');
assert.equal(classify(target(), state('')).reason, 'empty-page');
checks.push('status-and-document-state');

console.log('[test/units.mjs] 2. classify: wake pages in both languages...');
assert.equal(
  classify(target(), state('This app is asleep. Waking it up.')).reason.startsWith('not-ready:'),
  true,
);
assert.equal(
  classify(target(), state('应用正在唤醒，请稍候')).reason.startsWith('not-ready:'),
  true,
  '中文唤醒页必须被识别',
);
assert.equal(
  classify(target(), state('请稍候', { title: 'Waking up' })).reason.startsWith('not-ready:'),
  true,
  '文案只在 <title> 里也要命中',
);
assert.equal(classify(target(), state('Operations Handbook')).awake, true);
checks.push('wake-page-bilingual');

console.log('[test/units.mjs] 3. classify: stateful regex must not poison later calls...');
{
  const gPattern = /正在唤醒/g;
  const t = target({ notReadyPatterns: [gPattern] });
  const first = classify(t, state('正在唤醒'));
  const second = classify(t, state('正在唤醒'));
  assert.equal(first.awake, false);
  assert.equal(second.awake, false, '带 g 标志的正则第二次也必须命中');
  checks.push('global-regex-reset');
}

console.log('[test/units.mjs] 4. classify: thin shell and expect text...');
{
  const shell = state('Loading');
  assert.equal(classify(target(), shell).awake, true, '默认不启用长度判据');
  assert.equal(
    classify(target({ minReadyTextLength: 200 }), shell).reason,
    'page-too-short',
  );
  assert.equal(
    classify(target({ minReadyTextLength: 200 }), state('x'.repeat(200))).awake,
    true,
  );
  assert.equal(
    classify(target({ expectText: 'Dashboard' }), state('Loading')).reason,
    'expect-text-missing',
  );
  assert.equal(
    classify(target({ expectText: 'Dashboard' }), state('Dashboard ready')).awake,
    true,
  );
  // requireExpect=false 用于子资源/中间态检查
  assert.equal(
    classify(target({ expectText: 'Dashboard' }), state('Loading'), { requireExpect: false }).awake,
    true,
  );
  checks.push('thin-shell-and-expect');
}

// ---------------------------------------------------------------------------
// scheduleNext
// ---------------------------------------------------------------------------

console.log('[test/units.mjs] 5. scheduleNext: cadence and backoff...');
{
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);

  const fresh = target();
  const d1 = scheduleNext(fresh, {}, now);
  assert.equal(d1, 20 * MINUTE, '正常情况按 interval 排期');
  assert.equal(fresh.nextDue, now + 20 * MINUTE);

  // 前 4 次失败不应拉长间隔：保活场景下少访问比访问失败更糟
  for (let failures = 1; failures < FAILURE_BACKOFF_START; failures += 1) {
    const t = target({ consecutiveFailures: failures });
    assert.equal(
      scheduleNext(t, { failed: true }, now),
      20 * MINUTE,
      `连续失败 ${failures} 次时仍应保持原间隔`,
    );
  }

  // 到阈值后开始退避；默认 20 分钟 ×2 = 40 分钟会被 28 分钟封顶
  const atThreshold = target({ consecutiveFailures: FAILURE_BACKOFF_START });
  assert.equal(
    scheduleNext(atThreshold, { failed: true }, now),
    MAX_VISIT_WINDOW_MIN * MINUTE,
    '退避不得越过休眠阈值',
  );

  // 再多次失败也不会超过封顶值
  const veryStale = target({ consecutiveFailures: 30 });
  assert.equal(scheduleNext(veryStale, { failed: true }, now), MAX_VISIT_WINDOW_MIN * MINUTE);

  // 封顶 28 分钟
  const longInterval = target({ intervalMs: 28 * MINUTE, consecutiveFailures: 30 });
  assert.equal(
    scheduleNext(longInterval, { failed: true }, now),
    MAX_VISIT_WINDOW_MIN * MINUTE,
  );
  checks.push('cadence-and-backoff');
}

console.log('[test/units.mjs] 6. scheduleNext: jitter stays bounded...');
{
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);
  const t = target({ jitterMs: 2 * MINUTE });
  for (let i = 0; i < 50; i += 1) {
    const delay = scheduleNext(t, {}, now);
    assert.ok(delay >= 20 * MINUTE, `delay 不应小于 interval: ${delay}`);
    assert.ok(delay <= 22 * MINUTE, `delay 不应超过 interval + jitter: ${delay}`);
  }
  // interval + jitter 已接近上限时仍要被 28 分钟截断
  const tight = target({ intervalMs: 27 * MINUTE, jitterMs: 10 * MINUTE });
  for (let i = 0; i < 20; i += 1) {
    assert.ok(scheduleNext(tight, {}, now) <= MAX_VISIT_WINDOW_MIN * MINUTE);
  }
  checks.push('jitter-bounded');
}

console.log('[test/units.mjs] 7. scheduleNext: scheduled window pushes past the end...');
{
  // 固定在一个窗口内的时刻：窗口 08:00-09:00，当前 08:50
  const now = Date.UTC(2026, 9, 20, 0, 50, 0); // UTC 00:50 = Asia/Shanghai 08:50
  const t = target({
    scheduleEnabled: true,
    scheduleStart: '08:00',
    scheduleEnd: '09:00',
    scheduleDays: [1, 2, 3, 4, 5, 6, 7],
    scheduleTimezone: DEFAULT_SCHEDULE_TIMEZONE,
    intervalMs: 20 * MINUTE,
  });
  const delay = scheduleNext(t, {}, now, DEFAULT_SCHEDULE_TIMEZONE);
  assert.ok(delay > 20 * MINUTE, '排到窗口之外时应跳到下一个窗口开始');
  const next = new Date(t.nextDue);
  assert.equal(next.getUTCHours(), 0, '下一次应落在次日 08:00 (UTC 00:00)');
  assert.equal(next.getUTCMinutes(), 0);
  checks.push('window-rollover');
}

// ---------------------------------------------------------------------------
// targetReadinessIssues
// ---------------------------------------------------------------------------

console.log('[test/units.mjs] 8. readiness: paused targets are never reported...');
assert.deepEqual(targetReadinessIssues(target({ paused: true })), []);
checks.push('paused-ignored');

console.log('[test/units.mjs] 9. readiness: failure streak and overdue...');
{
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);
  assert.deepEqual(
    targetReadinessIssues(target({ consecutiveFailures: 2 }), now),
    [],
    '未达阈值不报',
  );
  assert.deepEqual(
    targetReadinessIssues(target({ consecutiveFailures: 3 }), now),
    ['consecutive-failures'],
  );
  assert.deepEqual(
    targetReadinessIssues(target({ nextDue: now - 11 * MINUTE }), now),
    ['schedule-overdue'],
  );
  assert.deepEqual(
    targetReadinessIssues(target({ nextDue: now - 11 * MINUTE, running: true }), now),
    [],
    '正在巡检不算逾期',
  );
  assert.deepEqual(
    targetReadinessIssues(target({ nextDue: now - 11 * MINUTE, schedulerQueued: true }), now),
    [],
    '已排队不算逾期',
  );
  checks.push('failures-and-overdue');
}

console.log('[test/units.mjs] 10. readiness: keep-open sessions freeze the counters...');
{
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);
  // 挂机前失败过 3 次：会话期间不应继续报红，否则 /readyz 永远 503
  assert.deepEqual(
    targetReadinessIssues(target({ consecutiveFailures: 3, keepOpenActive: true }), now),
    [],
  );
  // 挂机期间 lastSuccessfulVisitAt 不更新，也不该判 stale-success
  assert.deepEqual(
    targetReadinessIssues(
      target({
        keepOpenActive: true,
        lastSuccessfulVisitAt: new Date(now - 5 * 60 * MINUTE).toISOString(),
      }),
      now,
    ),
    [],
  );
  // 会话管理器报告的活跃状态同样生效
  const manager = { isSessionActive: (id) => id === 't1' };
  assert.deepEqual(
    targetReadinessIssues(target({ consecutiveFailures: 9 }), now, DEFAULT_SCHEDULE_TIMEZONE, manager),
    [],
  );
  checks.push('keep-open-freezes-counters');
}

console.log('[test/units.mjs] 11. readiness: stale success...');
{
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);
  const t = target({
    lastSuccessfulVisitAt: new Date(now - 60 * MINUTE).toISOString(),
  });
  // 20min interval × 2 + 0 jitter + 10min grace = 50min
  assert.deepEqual(targetReadinessIssues(t, now), ['stale-success']);
  const fresh = target({
    lastSuccessfulVisitAt: new Date(now - 10 * MINUTE).toISOString(),
  });
  assert.deepEqual(targetReadinessIssues(fresh, now), []);
  checks.push('stale-success');
}

console.log('[test/units.mjs] 12. resolver pinning...');
{
  assert.equal(
    buildResolverRules('app.example.com', [{ address: '1.2.3.4' }, { address: '5.6.7.8' }]),
    'MAP app.example.com 1.2.3.4, MAP app.example.com 5.6.7.8',
  );
  assert.equal(buildResolverRules('app.example.com', []), null, 'IP 字面量无需固定');
  assert.equal(buildResolverRules('', [{ address: '1.2.3.4' }]), null);
  assert.equal(buildResolverRules('h', [{ address: '' }]), null);
  checks.push('resolver-pinning');
}

console.log(`[test/units.mjs] All unit checks passed: ${JSON.stringify(checks)}`);