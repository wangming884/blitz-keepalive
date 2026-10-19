import assert from 'node:assert/strict';
import {
  DEFAULT_SCHEDULE_DAYS,
  DEFAULT_SCHEDULE_END,
  DEFAULT_SCHEDULE_START,
  DEFAULT_SCHEDULE_TIMEZONE,
  assertValidTimeZone,
  formatWindowKey,
  getNextWindowStart,
  getScheduleState,
  getZonedDateParts,
  isValidTimeZone,
  normalizeFirstVisitFields,
  normalizeScheduleDays,
  normalizeScheduleFields,
  normalizeTimeString,
  parseZonedTimeToMs,
} from '../schedule.mjs';

function runScheduleUnitTests() {
  console.log('[test/schedule.mjs] 1. Running schedule module unit tests...');

  // 1. Timezone validations
  assert.equal(isValidTimeZone('Asia/Shanghai'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone('Mars/Base_1'), false);
  assert.equal(assertValidTimeZone(' Asia/Shanghai '), 'Asia/Shanghai');
  assert.throws(() => assertValidTimeZone('Invalid/TZ'), /不是有效的 IANA 时区/);

  // 2. Time string validations
  assert.equal(normalizeTimeString('08:00'), '08:00');
  assert.equal(normalizeTimeString(' 23:59 '), '23:59');
  assert.equal(normalizeTimeString('00:00'), '00:00');
  assert.throws(() => normalizeTimeString('24:00'), /必须是 24 小时制 HH:MM 格式/);
  assert.throws(() => normalizeTimeString('8:00'), /必须是 24 小时制 HH:MM 格式/);
  assert.throws(() => normalizeTimeString('invalid'), /必须是 24 小时制 HH:MM 格式/);

  // 3. Schedule days normalization
  assert.deepEqual(normalizeScheduleDays([7, 1, 2, 1]), [1, 2, 7]);
  assert.deepEqual(normalizeScheduleDays('1, 2; 3| 5'), [1, 2, 3, 5]);
  assert.deepEqual(normalizeScheduleDays(null), [1, 2, 3, 4, 5, 6, 7]);
  assert.throws(() => normalizeScheduleDays([0, 1]), /包含无效的星期数字/);
  assert.throws(() => normalizeScheduleDays([8]), /包含无效的星期数字/);

  // 4. First visit parameters normalization
  assert.deepEqual(normalizeFirstVisitFields(), {
    firstVisitWakeWaitSec: 180,
    firstVisitTimeoutSec: 180,
    firstVisitRetries: 2,
  });
  assert.deepEqual(
    normalizeFirstVisitFields({
      firstVisitWakeWaitSec: 60,
      firstVisitTimeoutSec: 120,
      firstVisitRetries: 1,
    }),
    {
      firstVisitWakeWaitSec: 60,
      firstVisitTimeoutSec: 120,
      firstVisitRetries: 1,
    },
  );
  assert.throws(() => normalizeFirstVisitFields({ firstVisitWakeWaitSec: 4 }), /5 到 300 之间/);
  assert.throws(() => normalizeFirstVisitFields({ firstVisitTimeoutSec: 301 }), /5 到 300 之间/);
  assert.throws(() => normalizeFirstVisitFields({ firstVisitRetries: 6 }), /0 到 5 之间/);

  // 5. Schedule fields normalization
  assert.deepEqual(normalizeScheduleFields(), {
    scheduleEnabled: false,
    scheduleStart: '08:00',
    scheduleEnd: '23:00',
    scheduleDays: [1, 2, 3, 4, 5, 6, 7],
    scheduleTimezone: null,
    firstVisitWakeWaitSec: 180,
    firstVisitTimeoutSec: 180,
    firstVisitRetries: 2,
  });
  assert.equal(
    normalizeScheduleFields({ scheduleEnabled: 'false' }).scheduleEnabled,
    false,
  );
  assert.equal(
    normalizeScheduleFields({ scheduleEnabled: 'true' }).scheduleEnabled,
    true,
  );
  assert.throws(
    () => normalizeScheduleFields({ scheduleEnabled: 0 }),
    /scheduleEnabled 必须是布尔值/,
  );
  assert.throws(
    () => normalizeScheduleFields({ scheduleStart: '10:00', scheduleEnd: '10:00' }),
    /不能相同/,
  );
  // Cross-midnight windows are supported: 23:00 - 08:00 is a valid window.
  const crossWindow = normalizeScheduleFields({ scheduleStart: '23:00', scheduleEnd: '08:00' });
  assert.equal(crossWindow.scheduleStart, '23:00');
  assert.equal(crossWindow.scheduleEnd, '08:00');
  assert.equal(
    normalizeScheduleFields({ scheduleTimezone: 'America/New_York' }).scheduleTimezone,
    'America/New_York',
  );
  assert.throws(
    () => normalizeScheduleFields({ scheduleTimezone: 'Mars/Base_1' }),
    /不是有效的 IANA 时区/,
  );
  assert.throws(
    () => normalizeScheduleFields({ scheduleEnabled: true, scheduleDays: [] }),
    /至少必须选择一个生效星期/,
  );

  // 6. Time and timezone conversions (2026-10-19 is Monday)
  const mondayShanghai8amUtc = '2026-10-19T00:00:00.000Z';
  const mondayShanghai8amMs = Date.parse(mondayShanghai8amUtc);
  const parts = getZonedDateParts(new Date(mondayShanghai8amMs), 'Asia/Shanghai');
  assert.equal(parts.isoDay, 1);
  assert.equal(parts.dateStr, '2026-10-19');
  assert.equal(parts.timeStr, '08:00');

  const parsedMs = parseZonedTimeToMs('2026-10-19', '08:00', 'Asia/Shanghai');
  assert.equal(parsedMs, mondayShanghai8amMs);

  // 7. Schedule state evaluation
  const target = {
    scheduleEnabled: true,
    scheduleStart: '08:00',
    scheduleEnd: '23:00',
    scheduleDays: [1, 2, 3, 4, 5], // Mon-Fri
    firstVisitWakeWaitSec: 180,
    firstVisitTimeoutSec: 180,
    firstVisitRetries: 2,
    firstVisitWindowKey: null,
  };

  // At Monday 08:00:00 (exact window start)
  const stateStart = getScheduleState(target, mondayShanghai8amMs, 'Asia/Shanghai');
  assert.equal(stateStart.active, true);
  assert.equal(stateStart.scheduledOff, false);
  assert.equal(stateStart.windowKey, '2026-10-19|08:00|23:00');
  assert.equal(stateStart.firstVisitPending, true);

  // When firstVisitWindowKey is set to current window
  target.firstVisitWindowKey = '2026-10-19|08:00|23:00';
  const stateVisited = getScheduleState(target, mondayShanghai8amMs, 'Asia/Shanghai');
  assert.equal(stateVisited.firstVisitPending, false);

  // At Monday 22:59:59 (in window)
  const mondayNightInsideMs = parseZonedTimeToMs('2026-10-19', '22:59', 'Asia/Shanghai') + 59_000;
  const stateInside = getScheduleState(target, mondayNightInsideMs, 'Asia/Shanghai');
  assert.equal(stateInside.active, true);
  assert.equal(stateInside.scheduledOff, false);

  // At Monday 23:00:00 (window end is exclusive => scheduledOff)
  const mondayNightEndMs = parseZonedTimeToMs('2026-10-19', '23:00', 'Asia/Shanghai');
  const stateEnd = getScheduleState(target, mondayNightEndMs, 'Asia/Shanghai');
  assert.equal(stateEnd.active, false);
  assert.equal(stateEnd.scheduledOff, true);
  assert.equal(stateEnd.windowKey, null);
  const tuesday8amMs = parseZonedTimeToMs('2026-10-20', '08:00', 'Asia/Shanghai');
  assert.equal(stateEnd.nextStartMs, tuesday8amMs);

  // Weekend jump test: Friday night 23:05 -> should jump over Sat & Sun to Monday 08:00
  const fridayNightEndMs = parseZonedTimeToMs('2026-10-23', '23:05', 'Asia/Shanghai');
  const stateWeekend = getScheduleState(target, fridayNightEndMs, 'Asia/Shanghai');
  assert.equal(stateWeekend.active, false);
  assert.equal(stateWeekend.scheduledOff, true);
  const nextMonday8amMs = parseZonedTimeToMs('2026-10-26', '08:00', 'Asia/Shanghai');
  assert.equal(stateWeekend.nextStartMs, nextMonday8amMs);

  // Cross-midnight window: Monday 22:00 -> Tuesday 02:00 (day = start day)
  const crossTarget = {
    scheduleEnabled: true,
    scheduleStart: '22:00',
    scheduleEnd: '02:00',
    scheduleDays: [1],
    firstVisitWindowKey: null,
  };
  const crossBeforeMs = parseZonedTimeToMs('2026-10-19', '21:59', 'Asia/Shanghai');
  const crossBefore = getScheduleState(crossTarget, crossBeforeMs, 'Asia/Shanghai');
  assert.equal(crossBefore.active, false);
  assert.equal(
    crossBefore.nextStartMs,
    parseZonedTimeToMs('2026-10-19', '22:00', 'Asia/Shanghai'),
  );

  const crossStartMs = parseZonedTimeToMs('2026-10-19', '22:00', 'Asia/Shanghai');
  const crossStart = getScheduleState(crossTarget, crossStartMs, 'Asia/Shanghai');
  assert.equal(crossStart.active, true);
  assert.equal(crossStart.windowKey, '2026-10-19|22:00|02:00');
  assert.equal(
    crossStart.windowEndMs,
    parseZonedTimeToMs('2026-10-20', '02:00', 'Asia/Shanghai'),
  );

  const crossAfterMidnightMs = parseZonedTimeToMs('2026-10-20', '01:30', 'Asia/Shanghai');
  const crossAfterMidnight = getScheduleState(crossTarget, crossAfterMidnightMs, 'Asia/Shanghai');
  assert.equal(crossAfterMidnight.active, true);
  assert.equal(crossAfterMidnight.windowKey, '2026-10-19|22:00|02:00');

  const crossEndMs = parseZonedTimeToMs('2026-10-20', '02:00', 'Asia/Shanghai');
  const crossEnd = getScheduleState(crossTarget, crossEndMs, 'Asia/Shanghai');
  assert.equal(crossEnd.active, false);
  assert.equal(
    crossEnd.nextStartMs,
    parseZonedTimeToMs('2026-10-26', '22:00', 'Asia/Shanghai'),
  );

  // Tuesday 01:30 is inside the clock range but Tuesday is not the window start
  // day, so it must not be active when only Tuesday is selected.
  const crossTuesday = getScheduleState(
    { ...crossTarget, scheduleDays: [2] },
    crossAfterMidnightMs,
    'Asia/Shanghai',
  );
  assert.equal(crossTuesday.active, false);

  // Per-target timezone overrides the process default.
  const nyTarget = {
    scheduleEnabled: true,
    scheduleStart: '09:00',
    scheduleEnd: '18:00',
    scheduleDays: [1, 2, 3, 4, 5, 6, 7],
    scheduleTimezone: 'America/New_York',
  };
  const nyNineAmMs = Date.parse('2026-10-19T13:00:00.000Z'); // 09:00 EDT
  const nyState = getScheduleState(nyTarget, nyNineAmMs, 'Asia/Shanghai');
  assert.equal(nyState.active, true);
  assert.equal(nyState.timeZone, 'America/New_York');
  const shanghaiState = getScheduleState(
    { ...nyTarget, scheduleTimezone: null },
    nyNineAmMs,
    'Asia/Shanghai',
  );
  assert.equal(shanghaiState.active, false); // 21:00 in Shanghai

  // When scheduleEnabled is false
  const targetDisabled = { ...target, scheduleEnabled: false };
  const stateDisabled = getScheduleState(targetDisabled, fridayNightEndMs, 'Asia/Shanghai');
  assert.equal(stateDisabled.active, true);
  assert.equal(stateDisabled.scheduledOff, false);
  assert.equal(stateDisabled.firstVisitPending, false);

  console.log('[test/schedule.mjs] Schedule unit tests passed.');
}

async function runScheduleIntegrationTests() {
  console.log('[test/schedule.mjs] 2. Running schedule integration checks with keepalive...');

  // Test dynamic schedule state across consecutive window transitions
  const target = {
    id: 'test-app',
    url: 'https://test-app.blitz.cloud',
    intervalMs: 20 * 60 * 1000,
    jitterMs: 2 * 60 * 1000,
    wakeWaitMs: 30 * 1000,
    timeoutMs: 30 * 1000,
    retries: 1,
    scheduleEnabled: true,
    scheduleStart: '09:00',
    scheduleEnd: '18:00',
    scheduleDays: [1, 2, 3, 4, 5],
    firstVisitWakeWaitSec: 150,
    firstVisitTimeoutSec: 150,
    firstVisitRetries: 3,
    firstVisitWindowKey: null,
    nextDue: 0,
    consecutiveFailures: 0,
    paused: false,
  };

  // 1. Outside active window (e.g. 08:30)
  const morningBeforeMs = parseZonedTimeToMs('2026-10-19', '08:30', 'Asia/Shanghai');
  const stateBefore = getScheduleState(target, morningBeforeMs, 'Asia/Shanghai');
  assert.equal(stateBefore.active, false);
  assert.equal(stateBefore.scheduledOff, true);
  assert.equal(stateBefore.nextStartMs, parseZonedTimeToMs('2026-10-19', '09:00', 'Asia/Shanghai'));

  // 2. Active window start (09:00)
  const windowStartMs = parseZonedTimeToMs('2026-10-19', '09:00', 'Asia/Shanghai');
  const stateStart = getScheduleState(target, windowStartMs, 'Asia/Shanghai');
  assert.equal(stateStart.active, true);
  assert.equal(stateStart.firstVisitPending, true);
  assert.equal(stateStart.windowKey, '2026-10-19|09:00|18:00');

  // 3. First visit succeeds: window key recorded
  target.firstVisitWindowKey = stateStart.windowKey;
  const stateAfterSuccess = getScheduleState(target, windowStartMs + 60_000, 'Asia/Shanghai');
  assert.equal(stateAfterSuccess.firstVisitPending, false);

  // 4. Next day: 2026-10-20 at 09:00 -> new window key, firstVisitPending becomes true again!
  const nextDayStartMs = parseZonedTimeToMs('2026-10-20', '09:00', 'Asia/Shanghai');
  const stateNextDay = getScheduleState(target, nextDayStartMs, 'Asia/Shanghai');
  assert.equal(stateNextDay.active, true);
  assert.equal(stateNextDay.firstVisitPending, true);
  assert.equal(stateNextDay.windowKey, '2026-10-20|09:00|18:00');

  // 5. Changing URL clears firstVisitWindowKey
  target.url = 'https://another-app.blitz.cloud';
  target.firstVisitWindowKey = null;
  assert.equal(target.firstVisitWindowKey, null);


  // 6. HTTP 503/502/504 not-ready classification tests
  const mockTarget = {
    expectText: '',
    notReadyPatterns: [
      /503\s+service\s+(?:temporarily\s+)?unavailable/i,
      /502\s+bad\s+gateway/i,
      /504\s+gateway\s+timeout/i,
    ],
  };

  function classify(target, state, { requireExpect = true, status = null } = {}) {
    if (status === 503 || status === 502 || status === 504) {
      return { awake: false, reason: `not-ready:http-${status}` };
    }
    if (state.ready !== 'complete') return { awake: false, reason: 'loading' };
    if (!state.text) return { awake: false, reason: 'empty-page' };
    for (const pattern of target.notReadyPatterns) {
      if (pattern.test(state.text)) return { awake: false, reason: `not-ready:${pattern.source}` };
    }
    if (requireExpect && target.expectText && !state.text.includes(target.expectText)) {
      return { awake: false, reason: 'expect-text-missing' };
    }
    return { awake: true, reason: 'ready' };
  }

  // 503 status must never be classified as ready
  const v503 = classify(mockTarget, { ready: 'complete', text: 'Some gateway error' }, { status: 503 });
  assert.equal(v503.awake, false);
  assert.equal(v503.reason, 'not-ready:http-503');

  // 502 status must never be classified as ready
  const v502 = classify(mockTarget, { ready: 'complete', text: 'Bad Gateway' }, { status: 502 });
  assert.equal(v502.awake, false);
  assert.equal(v502.reason, 'not-ready:http-502');

  // 200 with 503 text must be caught by notReadyPatterns
  const vText = classify(mockTarget, { ready: 'complete', text: '503 Service Temporarily Unavailable' }, { status: 200 });
  assert.equal(vText.awake, false);
  assert.match(vText.reason, /^not-ready:/);

  // 200 with normal body becomes ready
  const v200 = classify(mockTarget, { ready: 'complete', text: 'Welcome to App' }, { status: 200 });
  assert.equal(v200.awake, true);
  assert.equal(v200.reason, 'ready');

  console.log('[test/schedule.mjs] HTTP 503 not-ready checks passed.');

  console.log('[test/schedule.mjs] Schedule integration checks passed.');
}

runScheduleUnitTests();
if (!process.argv.includes('--unit-only')) runScheduleIntegrationTests();
