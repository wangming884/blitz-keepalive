/**
 * Daily visit statistics.
 *
 * The append-only log is rotated and cleared, so long-term success rates need
 * their own small, bounded store: one record per local day, pruned after the
 * retention window. Counters are deliberately coarse (visits / ok / failed /
 * total duration) to keep the file tiny and the write path cheap.
 *
 * Day boundaries follow the process schedule timezone rather than UTC: an
 * operator in Asia/Shanghai reading "今天" at 07:00 must see the visits made
 * this morning, not yesterday's bucket.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonFileAtomic } from './storage.mjs';
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  addDaysToDateString,
  getZonedDateParts,
  isValidTimeZone,
} from './schedule.mjs';

export const STATS_FILE_VERSION = 1;
export const STATS_RETENTION_DAYS = 90;
const FLUSH_DEBOUNCE_MS = 1_000;

function emptyDay() {
  return { visits: 0, ok: 0, failed: 0, totalMs: 0 };
}

function publicDay(key, value) {
  const visits = Math.max(0, Number(value?.visits) || 0);
  const ok = Math.max(0, Number(value?.ok) || 0);
  const failed = Math.max(0, Number(value?.failed) || 0);
  const totalMs = Math.max(0, Number(value?.totalMs) || 0);
  return {
    date: key,
    visits,
    ok,
    failed,
    avgMs: visits > 0 ? Math.round(totalMs / visits) : 0,
  };
}

export function createStatsStore(cfg, log) {
  let days = {};
  let timer = null;
  let writeQueue = Promise.resolve();
  const timeZone =
    typeof cfg.scheduleTimeZone === 'string' && isValidTimeZone(cfg.scheduleTimeZone)
      ? cfg.scheduleTimeZone.trim()
      : DEFAULT_SCHEDULE_TIMEZONE;

  const dayKey = (value = new Date()) => {
    const date = value instanceof Date ? value : new Date(value);
    return getZonedDateParts(date, timeZone).dateStr;
  };

  const prune = (now = Date.now()) => {
    const cutoff = addDaysToDateString(dayKey(new Date(now)), -STATS_RETENTION_DAYS);
    for (const key of Object.keys(days)) {
      if (key < cutoff) delete days[key];
    }
  };

  const snapshot = () => ({
    version: STATS_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    days,
  });

  const flush = async () => {
    // Do not create an empty statistics file on every boot; it appears after
    // the first recorded visit.
    if (Object.keys(days).length === 0 && !existsSync(cfg.statsFile)) return;
    await writeJsonFileAtomic(cfg.statsFile, snapshot());
  };

  const schedule = () => {
    if (cfg.once) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      writeQueue = writeQueue.then(flush).catch((error) => {
        void log({ level: 'warn', event: 'stats-write-failed', error: error.message });
      });
    }, FLUSH_DEBOUNCE_MS);
    timer.unref?.();
  };

  return {
    async load() {
      if (!existsSync(cfg.statsFile)) return;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(cfg.statsFile, 'utf8').replace(/^\uFEFF/, ''));
      } catch (error) {
        throw new Error(`Stats file ${cfg.statsFile} is not valid JSON: ${error.message}`);
      }
      if (parsed?.version !== STATS_FILE_VERSION) {
        throw new Error(
          `Stats file version ${parsed?.version ?? 'missing'} is not supported (expected ${STATS_FILE_VERSION}).`,
        );
      }
      if (parsed.days === null || typeof parsed.days !== 'object' || Array.isArray(parsed.days)) {
        throw new Error('Stats file must contain a days object.');
      }
      days = {};
      for (const [key, value] of Object.entries(parsed.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
        days[key] = {
          visits: Math.max(0, Math.trunc(Number(value.visits) || 0)),
          ok: Math.max(0, Math.trunc(Number(value.ok) || 0)),
          failed: Math.max(0, Math.trunc(Number(value.failed) || 0)),
          totalMs: Math.max(0, Math.trunc(Number(value.totalMs) || 0)),
        };
      }
      prune();
    },
    recordVisit({ ok, ms, at = new Date() } = {}) {
      const key = dayKey(at);
      const day = days[key] ?? emptyDay();
      day.visits += 1;
      if (ok) day.ok += 1;
      else day.failed += 1;
      day.totalMs += Math.max(0, Math.round(Number(ms) || 0));
      days[key] = day;
      prune();
      schedule();
    },
    snapshot(lastNDays = 7, now = new Date()) {
      const count = Math.max(1, Math.min(90, Math.trunc(lastNDays) || 7));
      const recent = [];
      let visits = 0;
      let ok = 0;
      let failed = 0;
      let totalMs = 0;
      // Walk calendar days in the configured timezone instead of subtracting
      // 24h from the clock, so DST shifts can never duplicate or skip a bucket.
      const todayKey = dayKey(now);
      for (let offset = count - 1; offset >= 0; offset -= 1) {
        const key = addDaysToDateString(todayKey, -offset);
        recent.push(publicDay(key, days[key]));
      }
      for (const value of Object.values(days)) {
        visits += Number(value.visits) || 0;
        ok += Number(value.ok) || 0;
        failed += Number(value.failed) || 0;
        totalMs += Number(value.totalMs) || 0;
      }
      return {
        today: recent[recent.length - 1],
        last7Days: recent.slice(-7),
        totals: {
          days: Object.keys(days).length,
          visits,
          ok,
          failed,
          avgMs: visits > 0 ? Math.round(totalMs / visits) : 0,
        },
      };
    },
    async flushNow() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await writeQueue;
      await flush();
    },
  };
}
