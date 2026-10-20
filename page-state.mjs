/**
 * blitz-keepalive page-state judgement
 *
 * Decides whether a loaded page is actually the application, or still the
 * platform's wake page / an empty shell. Kept separate from the runtime so it
 * can be unit-tested without launching a browser.
 *
 * The rules here are the whole reliability contract of the agent: a false
 * "ready" means the app keeps sleeping, a false "not ready" means pointless
 * retries. Both directions are covered by test/units.mjs.
 */
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  FAILURE_BACKOFF_MAX_MULTIPLIER,
  getScheduleState,
} from './schedule.mjs';

const MINUTE = 60_000;

/** Consecutive failures that make an active target "needs attention". */
export const READINESS_FAILURE_THRESHOLD = 3;
/** How late a target may be before /readyz reports it. */
export const READINESS_GRACE_MS = 10 * MINUTE;

/**
 * Wake-page signatures.
 *
 * blitz.cloud serves its waking page with HTTP 200 and visible text, and in
 * Chinese for zh-CN browsers, so a status-code check alone is not enough.
 */
export const DEFAULT_NOT_READY_PATTERNS = Object.freeze([
  /app\s+is\s+asleep/i,
  /app\s+is\s+sleeping/i,
  /is\s+asleep\s+right\s+now/i,
  /waking\s+(?:it\s+|the\s+app\s+)?up/i,
  /wakes?\s+in\s+(?:a\s+)?few\s+seconds/i,
  /app\s+is\s+(?:paused|stopped|starting|building|updating)/i,
  /needs\s+attention/i,
  /503\s+service\s+(?:temporarily\s+)?unavailable/i,
  /502\s+bad\s+gateway/i,
  /504\s+gateway\s+timeout/i,
  /正在唤醒/,
  /唤醒中/,
  /应用(?:已|正在)?休眠/,
  /应用正在启动/,
  /正在启动应用/,
  /即将就绪/,
  /\bwaking\b/i,
  /\bcold\s*start/i,
  /\bstarting\s+up\b/i,
  /\bthis\s+page\s+will\s+(?:reload|refresh)\s+automatically/i,
]);

/**
 * Classifies one page snapshot.
 *
 * `status` is the HTTP status of the document request, `state` is what
 * readPageState() returned (title / text / readyState).
 */
export function classify(target, state, { requireExpect = true, status = null } = {}) {
  if (status === 503 || status === 502 || status === 504) {
    return { awake: false, reason: `not-ready:http-${status}` };
  }
  if (state.ready !== 'complete') return { awake: false, reason: 'loading' };
  if (!state.text) return { awake: false, reason: 'empty-page' };
  // Some wake pages put "Waking up ..." in <title> while the body only shows a
  // spinner, so match against both. Reset lastIndex in case a user-supplied
  // --not-ready-regex carries the /g flag (stateful test()).
  const haystack = state.title ? `${state.title}\n${state.text}` : state.text;
  for (const pattern of target.notReadyPatterns ?? []) {
    pattern.lastIndex = 0;
    if (pattern.test(haystack)) return { awake: false, reason: `not-ready:${pattern.source}` };
  }
  // A wake page that renders an app shell can be short but "complete". When the
  // target opts into a minimum length, a thin page keeps waiting instead of
  // being reported ready.
  const minReadyTextLength = Math.max(0, Number(target.minReadyTextLength) || 0);
  if (minReadyTextLength > 0 && state.text.length < minReadyTextLength) {
    return { awake: false, reason: 'page-too-short' };
  }
  if (requireExpect && target.expectText && !state.text.includes(target.expectText)) {
    return { awake: false, reason: 'expect-text-missing' };
  }
  return { awake: true, reason: 'ready' };
}

/**
 * Returns the readiness problems for one target.
 *
 * A keep-open session holds the app alive without running scheduled visits, so
 * both the failure streak and the last-success timestamp freeze for its
 * duration. Every check below therefore skips keep-open targets: the session
 * itself is the proof of health.
 */
export function targetReadinessIssues(
  target,
  now = Date.now(),
  timeZone = DEFAULT_SCHEDULE_TIMEZONE,
  keepOpenManager = null,
) {
  if (target.paused) return [];

  const issues = [];
  const scheduleState = getScheduleState(target, now, timeZone);
  const keepOpenActive =
    keepOpenManager?.isSessionActive(target.id) === true || target.keepOpenActive === true;
  const consecutiveFailures = Math.max(0, Number(target.consecutiveFailures) || 0);
  if (!keepOpenActive && consecutiveFailures >= READINESS_FAILURE_THRESHOLD) {
    issues.push('consecutive-failures');
  }

  if (!scheduleState.scheduledOff && !keepOpenActive) {
    const nextDue = Number(target.nextDue);
    if (
      !target.running &&
      !target.schedulerQueued &&
      Number.isFinite(nextDue) &&
      nextDue > 0 &&
      now - nextDue > READINESS_GRACE_MS
    ) {
      issues.push('schedule-overdue');
    }

    const lastSuccessfulVisitAt = Date.parse(target.lastSuccessfulVisitAt ?? '');
    // Wall-clock staleness is misleading inside a narrow daily window: at 09:00
    // the last success is legitimately yesterday's, so a target that only runs
    // 09:00-10:00 would look stale for the first minutes of every window. The
    // window start restarts the clock and gives the target a full budget.
    const windowStartMs = Number(scheduleState.windowStartMs);
    const freshnessBaseline = Math.max(
      Number.isFinite(lastSuccessfulVisitAt) ? lastSuccessfulVisitAt : 0,
      Number.isFinite(windowStartMs) ? windowStartMs : 0,
    );
    if (
      freshnessBaseline > 0 &&
      now - freshnessBaseline >
        target.intervalMs * FAILURE_BACKOFF_MAX_MULTIPLIER +
          target.jitterMs +
          READINESS_GRACE_MS
    ) {
      issues.push('stale-success');
    }
  }
  return issues;
}
