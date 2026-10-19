/**
 * Webhook notifier.
 *
 * The agent's whole job is silent reliability, so failures must reach a human
 * even when nobody watches /metrics. Each alert kind has its own silence
 * window: a target that fails every 20 minutes must not page every 20 minutes.
 * Delivery is fire-and-forget so a slow webhook can never delay scheduling.
 */
const DEFAULT_TIMEOUT_MS = 10_000;
// Alert keys are mostly `target:<uuid>:<kind>`, so a long-lived process that
// creates and deletes targets would otherwise accumulate one map entry forever
// per retired id. Every entry older than the silence window is dead weight, so
// the map is swept once it grows past this ceiling.
const MAX_TRACKED_KEYS = 500;

function describeError(error) {
  return String(error?.message ?? error ?? 'unknown').slice(0, 200);
}

export function createNotifier(cfg, log) {
  const lastSentAt = new Map();
  const url = cfg.webhookUrl || '';
  const enabled = Boolean(url);
  const timeoutMs = Math.max(1_000, Number(cfg.webhookTimeoutMs) || DEFAULT_TIMEOUT_MS);
  const minIntervalMs = Math.max(0, Number(cfg.webhookMinIntervalMs) || 0);

  function pruneSilenceWindows(now) {
    if (lastSentAt.size <= MAX_TRACKED_KEYS) return;
    for (const [key, sentAt] of lastSentAt) {
      if (now - sentAt >= minIntervalMs) lastSentAt.delete(key);
    }
    if (lastSentAt.size <= MAX_TRACKED_KEYS) return;
    // Still over the ceiling because the window is long: drop the oldest keys,
    // which are the ones closest to expiring anyway.
    const oldestFirst = [...lastSentAt.entries()].sort((a, b) => a[1] - b[1]);
    for (const [key] of oldestFirst.slice(0, lastSentAt.size - MAX_TRACKED_KEYS)) {
      lastSentAt.delete(key);
    }
  }

  async function post(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'blitz-keepalive',
        },
        body: JSON.stringify({ service: 'blitz-keepalive', ...payload }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await log({ level: 'info', event: 'webhook-sent', kind: payload.event, target: payload.target ?? null });
      return true;
    } catch (error) {
      await log({
        level: 'warn',
        event: 'webhook-failed',
        kind: payload.event,
        target: payload.target ?? null,
        error: describeError(error),
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enabled,
    /** Number of silence windows currently tracked; bounded by MAX_TRACKED_KEYS. */
    get trackedKeys() {
      return lastSentAt.size;
    },
    /**
     * `key` identifies the alert kind (and usually the target); repeated calls
     * inside the silence window are dropped. A failed delivery clears the
     * timestamp so the next occurrence can retry.
     */
    notify(key, payload) {
      if (!enabled) return;
      const now = Date.now();
      const last = lastSentAt.get(key) ?? 0;
      if (now - last < minIntervalMs) return;
      lastSentAt.set(key, now);
      pruneSilenceWindows(now);
      void post({ at: new Date().toISOString(), ...payload }).then((ok) => {
        if (!ok) lastSentAt.delete(key);
      });
    },
  };
}
