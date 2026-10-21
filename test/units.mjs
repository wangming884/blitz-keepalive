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
// 真实 blitz.cloud 中文唤醒页（用「觉醒」而不是「唤醒」）
assert.equal(
  classify(
    target(),
    state(
      'Opencode正在觉醒 有人已经很久没用这个应用了，所以它一直在休眠。现在开始了，需要比平时更长时间。' +
        '当应用准备好时，该页面会自动打开。 唤醒它 启动应用 连接地址 等待 34 秒。你什么都不用做。',
    ),
  ).reason.startsWith('not-ready:'),
  true,
  '「正在觉醒」唤醒页必须被识别',
);
assert.equal(classify(target(), state('Operations Handbook')).awake, true);
checks.push('wake-page-bilingual');

console.log('[test/units.mjs] 2b. classify: English wake page and its bare shell...');
{
  // 真实英文唤醒页（Outlook is waking up），含超时提示变体
  const enWake =
    'blitz.cloud Outlook is waking up Nobody has used this app for a while, so it was asleep. ' +
    'It is starting now and needs a little longer than usual. This page opens the app by itself ' +
    'when it is ready. Waking it up Starting the app Connecting the address Waiting 39 s. ' +
    'You do not need to do anything. Taking a little longer than usual. ' +
    'Is this your app? See why it was asleep This app runs on blitz.cloud.';
  assert.equal(classify(target(), state(enWake)).reason.startsWith('not-ready:'), true);

  // 只留下「超出预估」提示时也要能识别（正文可能还没渲染出来）
  assert.equal(
    classify(target(), state('Taking a little longer than usual.')).reason.startsWith('not-ready:'),
    true,
  );
  assert.equal(
    classify(target(), state('比平时花的时间更长。')).reason.startsWith('not-ready:'),
    true,
  );

  // 水合前的骨架：只有平台品牌，正文还没渲染
  assert.equal(classify(target(), state('blitz.cloud')).reason, 'wake-page-shell');

  // 骨架的另一种形态：页头品牌 + 营销页脚（正文仍未渲染）
  assert.equal(
    classify(
      target(),
      state('blitz.cloud This app runs on blitz.cloud. Put your own apps online for free'),
    ).reason.startsWith('not-ready:'),
    true,
  );
  assert.equal(
    classify(target(), state('blitz.cloud 这个应用运行在 blitz.cloud 上。免费将自己的应用放到网上'))
      .reason.startsWith('not-ready:'),
    true,
  );

  // 极简登录页不能因为短就被当成骨架（真实回归：61 字符的登录页曾永远等不到就绪）
  assert.equal(
    classify(target(), state('Sign in Email Password Continue This app runs on blitz.cloud.')).awake,
    true,
  );

  // 正文足够长的真实页面（页脚同样有 blitz.cloud）不能被误伤
  assert.equal(
    classify(target(), state(`Operations Handbook ${'x'.repeat(200)} This app runs on blitz.cloud.`))
      .awake,
    true,
  );
  checks.push('english-wake-and-shell');
}

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