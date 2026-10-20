# 保活「有时候失效」的根因分析与修复方案

> 分析对象：`blitz-keepalive` v1.2.0
> 分析方式：通读调度 / 巡检 / 挂机三条主链路 + 参数默认值与部署配置交叉验证
> 本文只做分析，未修改任何业务代码

## 一、先说结论

「有时候失效」不是一个 bug，而是**四个结构性设计**在特定条件下叠加的结果：

| # | 根因 | 触发条件 | 严重度 |
|---|---|---|---|
| 1 | 调度是串行的，一个慢目标会阻塞全部目标 | 任一目标冷启动慢 / 重试 | 高 |
| 2 | 失败退避把间隔拉长到超过平台休眠阈值 | 连续 2–3 次失败 | 高 |
| 3 | 主循环没有异常隔离和看门狗 | 一次未捕获异常 / 浏览器 close 卡死 | 致命 |
| 4 | 挂机会话启动阻塞调度，且容量上限默认 1 | 配了挂机 + 多目标 | 中高 |
| 5 | 就绪判据偏弱，占位页可能被判成功 | 未配 `expectText` | 中 |
| 6 | 暂停 / 重启状态恢复把目标"冻结"住 | 认证失败自动暂停 | 中 |

下面逐条给出代码位置与机理。

---

## 二、根因 1：串行调度，一个慢目标拖垮全局

### 代码位置

`keepalive.mjs:5304-5379`（主循环）

```js
while (!stopping) {
  const now = Date.now();
  await keepOpenManager.tick(...);      // 可能阻塞 5–30s
  ...
  if (due.length > 0) {
    cycle += 1;
    await runTargets(cfg, due, log, cycle, status, notifier);   // ← 阻塞
    continue;
  }
  ...
}
```

`keepalive.mjs:5115`

```js
const workers = Math.min(cfg.maxConcurrent, queue.length);
await Promise.all(Array.from({ length: workers }, worker));
```

`compose.yaml:22` / `.env.example:29` / `deploy/server/.env.example:37`

```
MAX_CONCURRENT: 1
```

### 机理

- `await runTargets(...)` 返回前，主循环**完全不检查**其它目标的 `nextDue`。
- `MAX_CONCURRENT` 默认且部署模板都是 **1**，所有到期目标在 worker 队列里**串行**执行。
- 单次巡检的最坏耗时（默认参数：`timeoutSec=60`、`wakeWaitSec=30`、`retries=2`、`retryDelaySec=60`、`settleSec=6`）：

  | 阶段 | 最坏耗时 |
  |---|---|
  | `page.goto` 超时 | 60s |
  | `waitForApp` 唤醒轮询 | 30s（每次 reload 最多 +15s，可能超预算） |
  | 第 2 次尝试 | 60 + 30 = 90s |
  | 重试等待 | 60s |
  | 第 3 次尝试 | 90s |
  | 重试等待 | 60s |
  | **合计** | **≈ 390s ≈ 6.5 分钟** |

- 首次访问参数更大（`firstVisitWakeWaitSec=180`、`firstVisitTimeoutSec=180`），**单目标最坏 ≈ 20 分钟**。

### 后果

假设 5 个目标、`interval=20min`、`MAX_CONCURRENT=1`：

- 正常时每个 8s，一轮 40s，没问题。
- 一旦某个目标冷启动失败进入重试，它独占 worker 6.5 分钟，**其余 4 个目标的 `nextDue` 全部被推后**。
- 如果这个目标持续失败，每轮都占 6.5 分钟，实际巡检间隔被拉长到 `interval + 6.5min`，逼近甚至越过平台 30 分钟休眠阈值。

这解释了「平时好好的，某天开始就不行了」——**不是配置变了，是某个目标进入了慢路径**。

---

## 三、根因 2：失败退避与「保活」目标本质冲突

### 代码位置

`keepalive.mjs:4988-5001`

```js
const multiplier = failed
  ? Math.min(2 ** Math.max(0, target.consecutiveFailures - 1), FAILURE_BACKOFF_MAX_MULTIPLIER)
  : 1;
const delay = Math.min(target.intervalMs * multiplier + jitter, MAX_VISIT_WINDOW_MIN * MINUTE);
```

`keepalive.mjs:84`

```js
const MAX_VISIT_WINDOW_MIN = 28; // interval + jitter must stay below blitz.cloud's 30-minute sleep
```

`keepalive.mjs:124`

```js
const FAILURE_BACKOFF_MAX_MULTIPLIER = 4;
```

### 机理

失败时 `delay = interval × 2^(n-1)`，但外层还有一个 `Math.min(..., MAX_VISIT_WINDOW_MIN × MINUTE)` 兜底，所以**实际封顶 28 分钟**，不会真的退到 80 分钟。以默认 `interval=20min`、`jitter=2min` 计算：

| 连续失败次数 | 计算值 | 实际 delay |
|---|---|---|
| 1 | 20 + 2 | 22 分钟 |
| 2 | 40 + 2 | **28 分钟（封顶）** |
| 3+ | 80 + 2 | 28 分钟（封顶） |

### 真正的问题不是"退避到 80 分钟"，而是这 28 分钟是**延迟量**，不是**访问间隔**

`nextDue = now + delay` 里的 `now` 是**巡检结束**的时刻，所以两次访问的**开始时刻**间隔是：

```
实际间隔 = delay + 上一次巡检耗时
```

上一次巡检如果走了重试路径，耗时 6.5 分钟，那么：

```
28 分钟 + 6.5 分钟 = 34.5 分钟 > 30 分钟休眠阈值
```

也就是说：**只要连续失败 2 次，间隔就已经越过平台休眠阈值**，站点必然睡下，下一次又要冷启动。

配套的两个判定同样偏晚：

- `keepalive.mjs:3253`：`stale-success` 用 `intervalMs × 4 + jitter + 10min`（默认 ≈ 100 分钟）才判为过期
- `keepalive.mjs:130`：`DEFAULT_WEBHOOK_FAILURE_THRESHOLD = 3`，等到第 3 次失败告警时，已经过去 50 分钟以上

**告警响的时候，站点已经睡了至少半小时。**

> 修复后：前 4 次失败保持原 `interval`（20–22 分钟），只有连续失败 5 次才允许 ×2，且仍受 28 分钟封顶；告警阈值降到 1 次。

### 后果：恶性循环

```
冷启动慢 → 巡检超时失败
        → 下次间隔 22 分钟（还算安全）
        → 再失败 → 间隔 28 分钟 + 巡检耗时 6.5 分钟 = 34.5 分钟
        → 站点休眠
        → 下次访问又是冷启动，耗时更长
        → 更容易超时失败
        → 永远卡在 28 分钟 + 长耗时的组合上
```

**退避策略适用于"减少无效重试"，但保活场景恰恰要求"必须比休眠更频繁"。这两者是直接矛盾的。**

同一逻辑还出现在两处「过期」判定里，同样过于宽松：

- `keepalive.mjs:3253`：`stale-success` 用 `intervalMs × 4 + jitter + 10min`（默认 ≈ 100 分钟）才判为过期
- `keepalive.mjs:130`：`DEFAULT_WEBHOOK_FAILURE_THRESHOLD = 3`，等到第 3 次失败告警时，退避已经拉到 80 分钟

也就是说：**告警响的时候，站点已经睡了至少一个小时。**

---

## 四、根因 3：主循环没有异常隔离，也没有看门狗（最致命）

### 3a. 未捕获异常直接终止进程

`keepalive.mjs:5033-5037`

```js
const worker = async () => {
  while (queue.length > 0 && !stopping) {
    const target = queue.shift();
    const result = await runTargetCycle(cfg, target, log, cycle, status);  // ← 没有 try/catch
```

`runTargetCycle` 内部对 `visitOnce` 做了 try/catch，但 **try 块之外**还有这些可能抛错的操作：

- `recordVisit()` → `statsStore.recordVisit()`（`keepalive.mjs:2822`）
- `getScheduleState()` 的时区计算
- `runtimeStateStore.schedule()` 之外的持久化路径

一旦抛出，`worker()` 的 Promise reject → `Promise.all` reject → `runTargets` 抛出 → 主循环 `await` 抛出 → `main().catch` → `process.exit(1)`。

**结果是整个进程退出。** 如果没有 systemd / Docker `restart: always` 兜底，保活就永久停止了；即使有，也会丢掉所有 `nextDue` 的连续性。

### 3b. `closeBrowser` 没有超时，可能永久挂起

`keepalive.mjs:254-258`

```js
async function closeBrowser(browser) {
  if (!browser) return;
  ACTIVE_BROWSERS.delete(browser);
  await browser.close().catch(() => {});   // ← 没有超时
}
```

`browser.close()` 在 Chrome 进程僵死时可能永不 resolve。调用链：

`visitOnce` 的 `finally` → `await closeBrowser` → 永不返回 → worker 永久挂起 → `Promise.all` 永不 settle → **主循环静默停摆**。

此时进程还活着、`/healthz` 仍返回 200、`/readyz` 也看不出异常，**监控完全无感知**。

### 3c. 没有调度心跳

主循环没有任何"我上次跑到哪了"的时间戳。`status.lastSweepAt` 只在 `runTargets` 结束时更新，但没人检查它的年龄。

---

## 五、根因 4：挂机会话阻塞调度，且容量默认 1

### 代码位置

`keepopen.mjs:724-752`（`tick`）

```js
async function tick(targets, nowMs, timeZone) {
  await Promise.all(
    targets.map(async (target) => {
      ...
      await tryStartFromTick(target, 'scheduled', nowMs, timeZone);  // ← 同步等待
```

`keepopen.mjs:604-605`

```js
try {
  await connectSession(session);   // 启动 Chrome + 打开页面，5–30s
```

`keepopen.mjs:567-569`

```js
if (sessions.size >= maxSessions) {
  throw new KeepOpenCapacityError(maxSessions);
}
```

### 机理

1. **`tick()` 阻塞主循环**：`startTargetStay` 同步等待 `connectSession` 完成才返回。浏览器启动慢时，主循环被卡 5–30 秒；`stopTargetStay` 还会 `await session.done`（可能再等 15 秒的 reload 超时）。
2. **`maxKeepOpenSessions` 默认 1**：配了 2 个挂机目标时，第二个每次 `tick` 都抛 `KeepOpenCapacityError`，每 30 秒重试一次（`START_RETRY_DELAY_MS`），**每次都要走一遍阻塞路径**。日志里会持续出现 `keep-open-session-limit`，但用户看到的只是"第二个目标没保住"。
3. **挂机与巡检互斥**：`keepalive.mjs:5349` 里 `if (keepOpenManager.isSessionActive(target.id)) return false;` —— 挂机会话活跃的目标**不参与巡检**。如果会话"假活"（页面白屏但心跳判据通过），巡检也不会兜底，等于双重失效。

---

## 六、根因 5：就绪判据偏弱，占位页可能被判成功

`keepalive.mjs:2026-2039`

```js
function classify(target, state, { requireExpect = true, status = null } = {}) {
  if (status === 503 || status === 502 || status === 504) return { awake: false, ... };
  if (state.ready !== 'complete') return { awake: false, reason: 'loading' };
  if (!state.text) return { awake: false, reason: 'empty-page' };
  for (const pattern of target.notReadyPatterns) { ... }
  if (requireExpect && target.expectText && !state.text.includes(target.expectText)) {
    return { awake: false, reason: 'expect-text-missing' };
  }
  return { awake: true, reason: 'ready' };
}
```

### 机理

- 只认 **HTTP 状态码**、`readyState=complete`、**正文非空**、**内置 not-ready 正则**、可选的 `expectText`。
- Blitz 类平台的"正在唤醒 / 应用未启动"占位页，**可能返回 200 且带文案**。如果这个文案没有命中 `DEFAULT_NOT_READY_PATTERNS`，就会被判为「已就绪」。
- 用户如果没配 `expectText`（默认空），等于**没有任何业务内容校验**。

### 后果

日志里全是 `ok: true`，`lastSuccessfulVisitAt` 一直在刷新，但站点其实没真正保活。等用户去访问时才发现要冷启动——这是最容易被误判为"保活失效"的一类。

---

## 七、根因 6：暂停状态把目标"冻结"

`keepalive.mjs:4966-4983`

```js
} else if (isAuthenticationFailureReason(finalResult.reason)) {
  target.authFailureCount = (target.authFailureCount ?? 0) + 1;
  if (target.authFailureCount >= AUTH_FAILURE_PAUSE_THRESHOLD) {   // 3 次
    pauseTarget(target, `连续 ${target.authFailureCount} 次认证失败，自动暂停 30 分钟`, ...);
  }
}
```

`keepalive.mjs:1997-2011`（重启后恢复）

```js
target.paused = state.paused === true;
target.pausedUntil = target.paused && typeof state.pausedUntil === 'string' ? state.pausedUntil : null;
target.nextDue = target.paused ? null : ...;
```

### 机理

- 目标后台改了密码 / 登录态策略变了 → 连续 3 次认证失败 → **自动暂停 30 分钟**。
- 如果 `pausedUntil` 为空（手动暂停），重启后**永久暂停**，`nextDue = null`，调度器永远跳过它。
- `resumeExpiredPauses` 只在主循环**开头**执行（`keepalive.mjs:5307`），而主循环在 `runTargets` 期间不转，所以暂停到期也可能被延后最多一整轮巡检。

### 后果

"某个目标突然不保活了"——其实是被自动暂停了，界面上可能因为筛选/状态不显眼而被忽略。这正好和之前修过的「全部筛选隐藏暂停目标」是同一类问题的两个面。

---

## 八、次要因素

| 因素 | 位置 | 说明 |
|---|---|---|
| 每次巡检启停浏览器 | `keepalive.mjs:2745`、`:2782` | 每次 `puppeteer.launch` + `close`，1–3s 固定开销；频繁启停易产生僵尸进程，`ACTIVE_BROWSERS` 无上限 |
| 窄定时窗口一次失败就错过整窗 | `keepalive.mjs:4914-4925` | `waitForRetryWindow` 检测到 `scheduled-off` 直接 `break`，本轮记为失败，`scheduleNext` 推到下个窗口，**这个窗口内没有任何成功巡检** |
| 日志写盘串行 | `keepalive.mjs:1897-1905` | 每次 `log()` 都 `await writeQueue`，慢盘上会拖慢巡检节奏 |
| `waitForApp` 预算超支 | `keepalive.mjs:2101-2113` | 每次 reload 最多 15s，且不检查 deadline，实际唤醒时间可能远超 `wakeWaitSec` |

---

## 九、修复方案

### P0（建议尽快做，改动小、收益最大）

**1. 给 worker 加异常隔离**

```js
const worker = async () => {
  while (queue.length > 0 && !stopping) {
    const target = queue.shift();
    try {
      const result = await runTargetCycle(cfg, target, log, cycle, status);
      // ...原有处理
    } catch (error) {
      // 单个目标的意外异常不能终止调度
      await log({ level: 'error', event: 'target-cycle-crashed', target: target.id, error: error.message }).catch(() => {});
      results.set(target.id, false);
      target.running = false;
      scheduleNext(target, { failed: true }, Date.now(), cfg.scheduleTimeZone);
    }
  }
};
```

**2. 给 `closeBrowser` 加超时 + 强制回收**

```js
async function closeBrowser(browser) {
  if (!browser) return;
  ACTIVE_BROWSERS.delete(browser);
  const closed = browser.close().catch(() => {});
  await Promise.race([closed, sleep(5_000)]);
  // 超时后杀掉进程，避免僵尸累积
  try { const p = browser.process(); if (p && !p.killed) p.kill('SIGKILL'); } catch {}
}
```

**3. 失败退避不能叠加在保活间隔上**

保活场景下「少访问」比「访问失败」更致命：站点一旦睡下，下次又要冷启动，失败概率更高。建议**前几次失败不延长间隔**，只有连续失败到「基本可以判定目标长期不可用」时才退避：

```js
const FAILURE_BACKOFF_START = 5;
const multiplier =
  failed && failures >= FAILURE_BACKOFF_START
    ? Math.min(2 ** (failures - FAILURE_BACKOFF_START), 2)   // 上限从 ×4 降到 ×2
    : 1;
```

**4. 告警提前到第 1 次失败**

`DEFAULT_WEBHOOK_FAILURE_THRESHOLD` 从 3 改成 1，或增加一个「连续失败 2 次且距上次成功 > 1.5 × interval」的独立告警。

### P1（结构性调整）

**5. 调度从「串行跑批」改成「每目标独立定时器 + 并发信号量」**

现状是 `while` 循环 + `await runTargets`。建议：

```js
// 每个目标维护自己的 setTimeout，到点就丢进并发池，互不阻塞
for (const target of cfg.targets) armTarget(target);

function armTarget(target) {
  const delay = Math.max(0, target.nextDue - Date.now());
  target.timer = setTimeout(async () => {
    await semaphore.acquire();
    try { await runTargetCycle(...); } finally { semaphore.release(); }
    armTarget(target);           // 自己安排下一轮
  }, delay);
}
```

主循环退化为纯 tick（挂机检查 + readiness），不再阻塞。

**6. `MAX_CONCURRENT` 默认从 1 提到 2–3**

受内存约束（每个 Chrome ≈ 200–400MB），按容器内存设：`2GB → 3`。这样单个慢目标不会独占全部执行槽。

**7. `tick()` 里的挂机启动改为非阻塞**

```js
if (inWindow && !isRunning && !isSuppressedWindow(...)) {
  void tryStartFromTick(target, 'scheduled', nowMs, timeZone);  // 不 await
}
```

同时 `maxKeepOpenSessions` 建议按目标数自动放宽，或至少在达到上限时发一次告警（现在只记 `keep-open-session-limit` 日志）。

### P2（可观测性，建议配合 P0/P1 一起上）

**8. 增加两个直接反映"保活是否真的在跑"的指标**

```
# 距上次成功访问的秒数，按目标
blitz_keepalive_last_success_age_seconds{target="..."}

# 调度滞后：现在 - 最早一个已逾期目标的 nextDue
blitz_keepalive_scheduler_lag_seconds
```

`last_success_age` 超过 `1.5 × interval` 就告警，比"连续失败 3 次"敏感得多，而且能覆盖「判据误判为成功」以外的一切失效。

**9. `/readyz` 增加调度心跳判定**

主循环每轮更新 `status.lastLoopAt`；`/readyz` 在 `now - lastLoopAt > 90s` 时返回 503。这样主循环卡死能被外部监控发现，而不是只有 `healthz` 的 200。

**10. 记录"为什么这次没跑"**

在 `runTargets` 跳过目标时（`paused` / `scheduledOff` / `keepOpenActive` / `managementLocked`）统一写一条 `visit-skip-reason` 日志，并在管理台目标卡上显示"最近一次跳过原因"。目前这些跳过是静默的，排查时只能靠猜。

---

## 十、怎么确认你遇到的是哪一类

按这个顺序排查，基本能定位：

1. **看 `logs/keepalive.log` 里 `event: "visit"` 的时间戳间隔**
   - 间隔稳定但比 `interval` 长很多 → 根因 1（串行阻塞）
   - 间隔呈 20 → 40 → 80 分钟递增 → 根因 2（退避）
   - 完全没有 `visit` 记录，但进程还在 → 根因 3（主循环卡死）
2. **搜 `keep-open-session-limit`** → 根因 4
3. **`ok: true` 但用户反馈仍要冷启动** → 根因 5（判据误判）
4. **搜 `target-auto-paused`** → 根因 6
5. **`/metrics` 里 `blitz_keepalive_visits_total` 长时间不涨** → 根因 1 或 3

---

## 十一、建议的实施顺序

| 顺序 | 动作 | 预期收益 |
|---|---|---|
| 1 | worker 异常隔离 + `closeBrowser` 超时 | 消除「进程直接死」「静默卡死」两类致命失效 |
| 2 | 退避封顶到 28 分钟 | 消除「失败一次就睡过去」的恶性循环 |
| 3 | 告警阈值降到 1–2 次 | 让问题在站点休眠前被发现 |
| 4 | `MAX_CONCURRENT=2` + 挂机 tick 非阻塞 | 消除「一个慢目标拖垮全部」 |
| 5 | 增加 `last_success_age` 指标 + `/readyz` 心跳 | 把「不知道有没有在保活」变成可观测 |
| 6 | 调度器改为每目标独立定时器 | 从根本上消除串行阻塞 |

---

## 十二、实施记录（2026-10-20）

本文的 P0/P1/P2 修复已落地，逐项对应如下。

| 项 | 改动 | 文件 |
|---|---|---|
| P0-1 | `runTargets` 的 worker 包 try/catch，异常时记 `target-cycle-crashed` 并自行安排下一轮 | `keepalive.mjs` |
| P0-2 | `closeBrowser` 增加 5 秒超时，超时后 `SIGKILL` 子进程 | `keepalive.mjs` |
| P0-3 | 退避前 4 次失败不延长间隔；连续失败 5 次才允许 ×2（原 ×4 封顶逻辑保留） | `keepalive.mjs` |
| P0-4 | `WEBHOOK_FAILURE_THRESHOLD` 默认 3 → 1，同步 compose 与 env 模板 | `keepalive.mjs`、`compose*.yaml`、`.env.example` |
| P1-5 | `maxConcurrent` 默认 1 → 2；`compose.server.yaml` 同步为 2，1 GB 档的 `compose.yaml` 保持 1 | `keepalive.mjs`、`compose*.yaml`、`.env.example`、`config.example.json` |
| P1-6 | `tick()` 里启动挂机会话改为非阻塞（`void`），停止仍同步等待 | `keepopen.mjs` |
| P2-7 | 新增 `scheduler_loop_age_seconds`、`scheduler_lag_seconds`、`target_last_success_age_seconds`；`/readyz` 在循环停摆 > 600 秒时返回 503 | `keepalive.mjs` |

未实施：**P1 第 6 项「每目标独立定时器」的调度器重构**。它会把 `while + await runTargets` 换成 per-target `setTimeout` + 并发信号量，收益最大但改动面也最大，建议单独一轮改造并配套压测，不宜与其他修复混在一起。

验证：`npm run check` 通过（21 文件 + 前端脚本检查），`npm test` 全绿；`test/hardening.mjs` 的默认并发断言更新为 2，`test/features.mjs` 新增三个指标断言。
