/**
 * blitz-keepalive schedule module
 *
 * Implements target-level active windows and first-visit wake parameters.
 * Zero external dependencies; uses Node.js standard Intl API for timezones.
 */

export const DEFAULT_SCHEDULE_TIMEZONE = 'Asia/Shanghai';
export const DEFAULT_SCHEDULE_START = '08:00';
export const DEFAULT_SCHEDULE_END = '23:00';
export const DEFAULT_SCHEDULE_DAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
export const DEFAULT_FIRST_VISIT_WAKE_WAIT_SEC = 180;
export const DEFAULT_FIRST_VISIT_TIMEOUT_SEC = 180;
export const DEFAULT_FIRST_VISIT_RETRIES = 2;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAY_MAP = Object.freeze({
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
});

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

export function assertValidTimeZone(tz, fieldName = '时区') {
  if (!isValidTimeZone(tz)) {
    throw new Error(`${fieldName}不是有效的 IANA 时区（例如 Asia/Shanghai、UTC）：${tz}`);
  }
  return tz.trim();
}

export function normalizeTimeString(raw, fieldName = '时间') {
  if (typeof raw !== 'string') {
    throw new Error(`${fieldName}必须是 HH:MM 格式的字符串。`);
  }
  const trimmed = raw.trim();
  if (!TIME_PATTERN.test(trimmed)) {
    throw new Error(`${fieldName}必须是 24 小时制 HH:MM 格式（00:00 - 23:59）。`);
  }
  return trimmed;
}

export function normalizeScheduleDays(raw) {
  let items;
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    items = raw.split(/[\s,;|]+/);
  } else if (raw === null || raw === undefined) {
    return DEFAULT_SCHEDULE_DAYS.slice();
  } else {
    throw new Error('scheduleDays 必须是数字数组或以逗号分隔的星期数字（1-7）。');
  }

  const set = new Set();
  for (const item of items) {
    if (item === '' || item === undefined || item === null) continue;
    const num = Number(item);
    if (!Number.isInteger(num) || num < 1 || num > 7) {
      throw new Error(`scheduleDays 包含无效的星期数字：${item}（仅允许 1-7，1 为周一，7 为周日）。`);
    }
    set.add(num);
  }

  return Array.from(set).sort((a, b) => a - b);
}

export function normalizeFirstVisitFields(raw = {}, fallback = {}) {
  const wakeWaitSec =
    raw.firstVisitWakeWaitSec !== undefined
      ? Number(raw.firstVisitWakeWaitSec)
      : fallback.firstVisitWakeWaitSec !== undefined
        ? Number(fallback.firstVisitWakeWaitSec)
        : DEFAULT_FIRST_VISIT_WAKE_WAIT_SEC;
  if (!Number.isInteger(wakeWaitSec) || wakeWaitSec < 5 || wakeWaitSec > 300) {
    throw new Error('firstVisitWakeWaitSec 必须是 5 到 300 之间的整数（秒）。');
  }

  const timeoutSec =
    raw.firstVisitTimeoutSec !== undefined
      ? Number(raw.firstVisitTimeoutSec)
      : fallback.firstVisitTimeoutSec !== undefined
        ? Number(fallback.firstVisitTimeoutSec)
        : DEFAULT_FIRST_VISIT_TIMEOUT_SEC;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 5 || timeoutSec > 300) {
    throw new Error('firstVisitTimeoutSec 必须是 5 到 300 之间的整数（秒）。');
  }

  const retries =
    raw.firstVisitRetries !== undefined
      ? Number(raw.firstVisitRetries)
      : fallback.firstVisitRetries !== undefined
        ? Number(fallback.firstVisitRetries)
        : DEFAULT_FIRST_VISIT_RETRIES;
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
    throw new Error('firstVisitRetries 必须是 0 到 5 之间的整数。');
  }

  return {
    firstVisitWakeWaitSec: wakeWaitSec,
    firstVisitTimeoutSec: timeoutSec,
    firstVisitRetries: retries,
  };
}

export function normalizeScheduleFields(raw = {}, fallback = {}) {
  const scheduleEnabledValue =
    raw.scheduleEnabled !== undefined ? raw.scheduleEnabled : fallback.scheduleEnabled;
  let scheduleEnabled = false;
  if (scheduleEnabledValue !== undefined) {
    if (typeof scheduleEnabledValue === 'boolean') {
      scheduleEnabled = scheduleEnabledValue;
    } else if (scheduleEnabledValue === 'true') {
      scheduleEnabled = true;
    } else if (scheduleEnabledValue === 'false') {
      scheduleEnabled = false;
    } else {
      throw new Error('scheduleEnabled 必须是布尔值。');
    }
  }

  const scheduleStart = normalizeTimeString(
    raw.scheduleStart ?? fallback.scheduleStart ?? DEFAULT_SCHEDULE_START,
    'scheduleStart',
  );
  const scheduleEnd = normalizeTimeString(
    raw.scheduleEnd ?? fallback.scheduleEnd ?? DEFAULT_SCHEDULE_END,
    'scheduleEnd',
  );

  if (scheduleStart === scheduleEnd) {
    throw new Error(
      `活动窗口时间无效：开始时间与结束时间不能相同（${scheduleStart}）。跨午夜请使用 22:00 - 02:00 这种开始晚于结束的写法。`,
    );
  }

  const scheduleTimezoneRaw = raw.scheduleTimezone ?? fallback.scheduleTimezone;
  let scheduleTimezone = null;
  if (
    scheduleTimezoneRaw !== undefined &&
    scheduleTimezoneRaw !== null &&
    String(scheduleTimezoneRaw).trim() !== ''
  ) {
    scheduleTimezone = assertValidTimeZone(String(scheduleTimezoneRaw).trim(), 'scheduleTimezone');
  }

  const scheduleDays = normalizeScheduleDays(raw.scheduleDays ?? fallback.scheduleDays);
  if (scheduleEnabled && scheduleDays.length === 0) {
    throw new Error('启用定时启停时，至少必须选择一个生效星期（1-7）。');
  }

  const firstVisit = normalizeFirstVisitFields(raw, fallback);

  return {
    scheduleEnabled,
    scheduleStart,
    scheduleEnd,
    scheduleDays,
    scheduleTimezone,
    ...firstVisit,
  };
}

// Constructing Intl.DateTimeFormat is expensive (it resolves the tz database),
// and the scheduler calls these helpers dozens of times per loop iteration.
// One formatter per (timezone, shape) is reused for the process lifetime.
const formatterCache = new Map();

function zonedFormatter(timeZone, withWeekday) {
  const key = `${withWeekday ? 'weekday' : 'plain'}|${timeZone}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      ...(withWeekday ? { weekday: 'short' } : {}),
    });
    formatterCache.set(key, formatter);
  }
  return formatter;
}

export function getTimeZoneOffsetMs(date, timeZone) {
  const dtf = zonedFormatter(timeZone, false);
  const parts = dtf.formatToParts(date);
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - date.getTime();
}

export function parseZonedTimeToMs(dateStr, timeStr, timeZone) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = getTimeZoneOffsetMs(new Date(guess), timeZone);
  const utc = guess - offset;
  const refinedOffset = getTimeZoneOffsetMs(new Date(utc), timeZone);
  return guess - refinedOffset;
}

export function getZonedDateParts(date, timeZone) {
  const dtf = zonedFormatter(timeZone, true);
  const parts = dtf.formatToParts(date);
  const p = {};
  for (const { type, value } of parts) p[type] = value;

  const isoDay = WEEKDAY_MAP[p.weekday] ?? 1;
  const dateStr = `${p.year}-${p.month}-${p.day}`;
  const timeStr = `${p.hour}:${p.minute}`;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    dateStr,
    timeStr,
    isoDay,
  };
}

export function formatWindowKey(dateStr, start, end) {
  return `${dateStr}|${start}|${end}`;
}

export function addDaysToDateString(dateStr, days) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(
    shifted.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** ISO weekday (1 = Monday) for a calendar date, independent of any timezone. */
export function isoDayOfDateString(dateStr) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return utcDay === 0 ? 7 : utcDay;
}

export function isCrossMidnightWindow(start, end) {
  return String(start) > String(end);
}

/** Per-target scheduleTimezone wins over the process-wide default. */
export function resolveScheduleTimeZone(target, fallback = DEFAULT_SCHEDULE_TIMEZONE) {
  const raw = target?.scheduleTimezone;
  const value = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback;
  return assertValidTimeZone(value);
}

/**
 * Returns the next window start timestamp (epoch ms) strictly greater than fromMs.
 * A cross-midnight window (start > end) still *starts* on the selected day, so
 * only the start day is used to decide whether the window exists.
 */
export function getNextWindowStart(target, fromMs, timeZone = DEFAULT_SCHEDULE_TIMEZONE) {
  const tz = resolveScheduleTimeZone(target, timeZone);
  const daysSet = new Set(target.scheduleDays ?? DEFAULT_SCHEDULE_DAYS);
  if (daysSet.size === 0) return null;

  const parts = getZonedDateParts(new Date(fromMs), tz);
  for (let offset = 0; offset <= 14; offset += 1) {
    const dateStr = addDaysToDateString(parts.dateStr, offset);
    if (!daysSet.has(isoDayOfDateString(dateStr))) continue;
    const startMs = parseZonedTimeToMs(dateStr, target.scheduleStart, tz);
    if (startMs > fromMs) return startMs;
  }

  return null;
}

/**
 * Evaluates target schedule status at nowMs under timeZone.
 *
 * For a cross-midnight window (e.g. 22:00 - 02:00) the "day" refers to the day
 * the window starts, so 01:00 on Tuesday still belongs to Monday's window.
 */
export function getScheduleState(
  target,
  nowMs = Date.now(),
  timeZone = DEFAULT_SCHEDULE_TIMEZONE,
) {
  if (!target || !target.scheduleEnabled) {
    return {
      enabled: false,
      active: true,
      scheduledOff: false,
      windowKey: null,
      windowStartMs: null,
      windowEndMs: null,
      nextStartMs: null,
      nextStartAt: null,
      firstVisitPending: false,
      timeZone: null,
    };
  }

  const tz = resolveScheduleTimeZone(target, timeZone);
  const parts = getZonedDateParts(new Date(nowMs), tz);
  const daysSet = new Set(target.scheduleDays ?? DEFAULT_SCHEDULE_DAYS);
  const { scheduleStart, scheduleEnd } = target;
  const crossMidnight = isCrossMidnightWindow(scheduleStart, scheduleEnd);

  let windowStartMs = null;
  let windowEndMs = null;
  let windowDate = null;

  if (crossMidnight) {
    // Window that starts today and runs into tomorrow.
    if (daysSet.has(parts.isoDay)) {
      const startMs = parseZonedTimeToMs(parts.dateStr, scheduleStart, tz);
      if (nowMs >= startMs) {
        windowStartMs = startMs;
        windowEndMs = parseZonedTimeToMs(addDaysToDateString(parts.dateStr, 1), scheduleEnd, tz);
        windowDate = parts.dateStr;
      }
    }
    // Window that started yesterday and is still running this morning.
    if (windowStartMs === null) {
      const yesterday = addDaysToDateString(parts.dateStr, -1);
      if (daysSet.has(isoDayOfDateString(yesterday))) {
        const endMs = parseZonedTimeToMs(parts.dateStr, scheduleEnd, tz);
        if (nowMs < endMs) {
          windowStartMs = parseZonedTimeToMs(yesterday, scheduleStart, tz);
          windowEndMs = endMs;
          windowDate = yesterday;
        }
      }
    }
  } else if (daysSet.has(parts.isoDay)) {
    const startMs = parseZonedTimeToMs(parts.dateStr, scheduleStart, tz);
    const endMs = parseZonedTimeToMs(parts.dateStr, scheduleEnd, tz);
    if (nowMs >= startMs && nowMs < endMs) {
      windowStartMs = startMs;
      windowEndMs = endMs;
      windowDate = parts.dateStr;
    }
  }

  if (windowDate !== null) {
    const windowKey = formatWindowKey(windowDate, scheduleStart, scheduleEnd);
    const firstVisitPending = target.firstVisitWindowKey !== windowKey;
    const nextStartMs = getNextWindowStart(target, windowEndMs, tz);
    return {
      enabled: true,
      active: true,
      scheduledOff: false,
      windowKey,
      windowStartMs,
      windowEndMs,
      nextStartMs,
      nextStartAt: nextStartMs ? new Date(nextStartMs).toISOString() : null,
      firstVisitPending,
      timeZone: tz,
    };
  }

  const nextStartMs = getNextWindowStart(target, nowMs, tz);
  return {
    enabled: true,
    active: false,
    scheduledOff: true,
    windowKey: null,
    windowStartMs: null,
    windowEndMs: null,
    nextStartMs,
    nextStartAt: nextStartMs ? new Date(nextStartMs).toISOString() : null,
    firstVisitPending: false,
    timeZone: tz,
  };
}

// ---------------------------------------------------------------------------
// Next-visit computation
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;

/** interval + jitter must stay below blitz.cloud's 30-minute sleep threshold. */
export const MAX_VISIT_WINDOW_MIN = 28;
/** Consecutive failures before backoff starts stretching the interval. */
export const FAILURE_BACKOFF_START = 5;
/** Hard cap on the backoff multiplier; never enough to cross the sleep window. */
export const FAILURE_BACKOFF_MAX_MULTIPLIER = 2;

/**
 * Computes and stores the next due time for a target.
 *
 * Keep-alive has an inverted cost model compared to a normal crawler: visiting
 * too rarely is worse than visiting a failing page, because a sleeping app has
 * to cold-start on the next visit and is more likely to fail again. So the
 * first few failures keep the normal cadence, and backoff only kicks in once
 * the target looks permanently broken. Even then the delay stays under
 * MAX_VISIT_WINDOW_MIN so a recovered target is noticed before it sleeps.
 *
 * `onScheduled` lets the caller persist the runtime state without this module
 * depending on the state store.
 */
export function scheduleNext(
  target,
  { failed = false, onScheduled = null } = {},
  now = Date.now(),
  timeZone = DEFAULT_SCHEDULE_TIMEZONE,
) {
  const failures = Math.max(0, Number(target.consecutiveFailures) || 0);
  const multiplier =
    failed && failures >= FAILURE_BACKOFF_START
      ? Math.min(2 ** (failures - FAILURE_BACKOFF_START + 1), FAILURE_BACKOFF_MAX_MULTIPLIER)
      : 1;
  const jitter = target.jitterMs > 0 ? Math.floor(Math.random() * target.jitterMs) : 0;
  const delay = Math.min(
    target.intervalMs * multiplier + jitter,
    MAX_VISIT_WINDOW_MIN * MINUTE_MS,
  );
  let nextDue = now + delay;

  if (target.scheduleEnabled) {
    const scheduleState = getScheduleState(target, now, timeZone);
    if (scheduleState.active) {
      if (scheduleState.windowEndMs && nextDue >= scheduleState.windowEndMs) {
        const nextStart = getNextWindowStart(target, scheduleState.windowEndMs, timeZone);
        if (nextStart) nextDue = nextStart;
      }
    } else {
      const nextStart = getNextWindowStart(target, now, timeZone);
      if (nextStart) nextDue = nextStart;
    }
  }

  target.nextDue = nextDue;
  if (typeof onScheduled === 'function') onScheduled();
  return Math.max(0, nextDue - now);
}
