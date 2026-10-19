const REFRESH_MS = 10_000;

let overviewController = null;

const state = {
  data: null,
  authenticated: false,
  authRequired: false,
  passwordConfigured: false,
  passwordFileExists: false,
  passwordChangeAvailable: false,
  loading: false,
  saving: false,
  clearingLogs: false,
  changingPassword: false,
  editingTargetId: null,
  editingTargetPasswordConfigured: false,
  editingTargetProxyPasswordConfigured: false,
  targetSearch: '',
  targetFilter: 'all',
  lastRenderedTargets: [],
  targetsSignature: '',
  consecutiveLoadFailures: 0,
  toastTimer: null,
};

const elements = {
  connection: document.getElementById('connection'),
  connectionLabel: document.getElementById('connection-label'),
  refreshButton: document.getElementById('refresh-button'),
  runAllButton: document.getElementById('run-all-button'),
  pauseAllButton: document.getElementById('pause-all-button'),
  resumeAllButton: document.getElementById('resume-all-button'),
  topbarSecondary: document.getElementById('topbar-secondary'),
  topbarMoreToggle: document.getElementById('topbar-more-toggle'),
  addTargetButton: document.getElementById('add-target-button'),
  addTargetSecondary: document.getElementById('add-target-secondary'),
  securityButton: document.getElementById('security-button'),
  logoutButton: document.getElementById('logout-button'),
  authPanel: document.getElementById('auth-panel'),
  authForm: document.getElementById('auth-form'),
  authMessage: document.getElementById('auth-message'),
  passwordInput: document.getElementById('password-input'),
  loginButton: document.getElementById('login-button'),
  dashboardContent: document.getElementById('dashboard-content'),
  securityWarning: document.getElementById('security-warning'),
  securityWarningTitle: document.getElementById('security-warning-title'),
  securityWarningMessage: document.getElementById('security-warning-message'),
  errorBanner: document.getElementById('error-banner'),
  errorMessage: document.getElementById('error-message'),
  retryButton: document.getElementById('retry-button'),
  statusHero: document.getElementById('status-hero'),
  overallLabel: document.getElementById('overall-label'),
  overallDetail: document.getElementById('overall-detail'),
  lastSweep: document.getElementById('last-sweep'),
  uptime: document.getElementById('uptime'),
  lastUpdated: document.getElementById('last-updated'),
  metricTargets: document.getElementById('metric-targets'),
  metricHealthy: document.getElementById('metric-healthy'),
  metricFailing: document.getElementById('metric-failing'),
  metricPaused: document.getElementById('metric-paused'),
  metricReadinessCard: document.getElementById('metric-readiness-card'),
  metricReadiness: document.getElementById('metric-readiness'),
  metricVisits: document.getElementById('metric-visits'),
  metricMemory: document.getElementById('metric-memory'),
  metricBrowsers: document.getElementById('metric-browsers'),
  metricQueue: document.getElementById('metric-queue'),
  statsBars: document.getElementById('stats-bars'),
  statsSummary: document.getElementById('stats-summary'),
  targetSearch: document.getElementById('target-search'),
  targetFilters: document.getElementById('target-filters'),
  targetFilterSummary: document.getElementById('target-filter-summary'),
  exportTargetsButton: document.getElementById('export-targets-button'),
  importTargetsButton: document.getElementById('import-targets-button'),
  targetImportFile: document.getElementById('target-import-file'),
  targetsList: document.getElementById('targets-list'),
  activityList: document.getElementById('activity-list'),
  activityCount: document.getElementById('activity-count'),
  clearLogsButton: document.getElementById('clear-logs-button'),
  targetDialog: document.getElementById('target-dialog'),
  targetForm: document.getElementById('target-form'),
  targetDialogTitle: document.getElementById('target-dialog-title'),
  targetUrl: document.getElementById('target-url'),
  targetId: document.getElementById('target-id'),
  targetAccount: document.getElementById('target-account'),
  targetProxyMode: document.getElementById('target-proxy-mode'),
  targetProxyFields: document.getElementById('target-proxy-fields'),
  targetProxy: document.getElementById('target-proxy'),
  targetProxyUsername: document.getElementById('target-proxy-username'),
  targetProxyPassword: document.getElementById('target-proxy-password'),
  targetProxyPasswordHint: document.getElementById('target-proxy-password-hint'),
  targetClearProxyPasswordWrap: document.getElementById('target-clear-proxy-password-wrap'),
  targetClearProxyPassword: document.getElementById('target-clear-proxy-password'),
  targetProxyBypass: document.getElementById('target-proxy-bypass'),
  targetLoginPassword: document.getElementById('target-login-password'),
  targetLoginPasswordHint: document.getElementById('target-login-password-hint'),
  targetClearPasswordWrap: document.getElementById('target-clear-password-wrap'),
  targetClearPassword: document.getElementById('target-clear-password'),
  targetInterval: document.getElementById('target-interval'),
  targetJitter: document.getElementById('target-jitter'),
  targetWakeWait: document.getElementById('target-wake-wait'),
  targetExpect: document.getElementById('target-expect'),
  targetLoginSuccessSelector: document.getElementById('target-login-success-selector'),
  targetScheduleEnabled: document.getElementById('target-schedule-enabled'),
  targetScheduleFields: document.getElementById('target-schedule-fields'),
  targetScheduleStart: document.getElementById('target-schedule-start'),
  targetScheduleEnd: document.getElementById('target-schedule-end'),
  targetScheduleTimezone: document.getElementById('target-schedule-timezone'),
  targetScheduleDays: document.getElementById('target-schedule-days'),
  targetFirstWakeWait: document.getElementById('target-first-wake-wait'),
  targetFirstTimeout: document.getElementById('target-first-timeout'),
  targetFirstRetries: document.getElementById('target-first-retries'),
  targetKeepOpenEnabled: document.getElementById('target-keep-open-enabled'),
  targetKeepOpenFields: document.getElementById('target-keep-open-fields'),
  targetKeepOpenScheduled: document.getElementById('target-keep-open-scheduled'),
  targetKeepOpenStart: document.getElementById('target-keep-open-start'),
  targetKeepOpenEnd: document.getElementById('target-keep-open-end'),
  targetFormError: document.getElementById('target-form-error'),
  targetSave: document.getElementById('target-save'),
  targetCancel: document.getElementById('target-cancel'),
  targetCancelX: document.getElementById('target-cancel-x'),
  securityDialog: document.getElementById('security-dialog'),
  passwordForm: document.getElementById('password-form'),
  currentPassword: document.getElementById('current-password'),
  newPassword: document.getElementById('new-password'),
  confirmPassword: document.getElementById('confirm-password'),
  passwordFormError: document.getElementById('password-form-error'),
  passwordSave: document.getElementById('password-save'),
  passwordCancel: document.getElementById('password-cancel'),
  passwordCancelX: document.getElementById('password-cancel-x'),
  toast: document.getElementById('toast'),
};

const eventLabels = {
  start: '进程启动',
  visit: '访问巡检',
  scheduled: '安排下一次',
  summary: '巡检汇总',
  shutdown: '进程停止',
  'health-listen': 'HTTP 服务启动',
  'manual-run-request': '手动巡检',
  'login-success': '登录成功',
  'login-failed': '登录失败',
  'login-rate-limited': '登录已限流',
  'password-changed': '修改管理密码',
  'target-created': '创建目标',
  'target-updated': '更新目标',
  'target-deleted': '删除目标',
  'target-paused': '暂停目标',
  'target-resumed': '恢复目标',
  'target-auto-paused': '自动暂停目标',
  'scheduled-paused': '跳过暂停目标',
  'targets-imported': '导入目标',
  'targets-paused-all': '批量暂停',
  'targets-resumed-all': '批量恢复',
  'target-probed': '测试连通',
  'webhook-sent': '告警已推送',
  'webhook-failed': '告警推送失败',
  'logs-cleared': '清空日志',
};

function apiHeaders(json = false) {
  const headers = {};
  if (json) headers['content-type'] = 'application/json';
  return headers;
}

function setConnection(kind, label) {
  // 轮询每 10 秒跑一次，重复写入同样的值会让顶栏状态反复重绘（视觉上闪动）。
  if (elements.connection.dataset.state === kind && elements.connectionLabel.textContent === label) {
    return;
  }
  elements.connection.dataset.state = kind;
  elements.connectionLabel.textContent = label;
}

function setText(element, value) {
  element.textContent = value;
}

function showToast(message, kind = 'success') {
  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.kind = kind;
  elements.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
    state.toastTimer = null;
  }, 4_500);
}

function showError(message) {
  elements.errorMessage.textContent = message;
  elements.errorBanner.hidden = false;
}

function hideError() {
  elements.errorBanner.hidden = true;
}

function closeTopbarMenu() {
  elements.topbarSecondary.classList.remove('is-open');
  elements.topbarMoreToggle.setAttribute('aria-expanded', 'false');
}

function showLogin(message, { clearPassword = false } = {}) {
  state.authenticated = false;
  closeTargetDialog();
  closePasswordDialog();
  closeTopbarMenu();
  elements.authPanel.hidden = false;
  elements.dashboardContent.hidden = true;
  elements.addTargetButton.hidden = true;
  elements.addTargetSecondary.hidden = true;
  elements.securityButton.hidden = true;
  elements.logoutButton.hidden = true;
  elements.refreshButton.hidden = true;
  elements.runAllButton.hidden = true;
  elements.pauseAllButton.hidden = true;
  elements.resumeAllButton.hidden = true;
  elements.topbarMoreToggle.hidden = true;
  setConnection('auth', '需要登录');
  if (message) elements.authMessage.textContent = message;
  if (clearPassword) elements.passwordInput.value = '';
  window.requestAnimationFrame(() => elements.passwordInput.focus());
}

function showDashboard() {
  state.authenticated = true;
  elements.authPanel.hidden = true;
  elements.dashboardContent.hidden = false;
  elements.addTargetButton.hidden = false;
  elements.addTargetSecondary.hidden = false;
  elements.securityButton.hidden = !state.passwordChangeAvailable;
  elements.logoutButton.hidden = !state.authRequired;
  elements.refreshButton.hidden = false;
  elements.runAllButton.hidden = false;
  elements.pauseAllButton.hidden = false;
  elements.resumeAllButton.hidden = false;
  elements.topbarMoreToggle.hidden = false;
  setConnection('online', '已连接');
}

function loginMessage() {
  if (state.passwordConfigured) return '请输入管理密码，登录后可在安全设置中修改。';
  return '该实例未设置访问密码，管理接口当前处于开放状态。';
}

function setSecurityWarning(config) {
  const passwordConfigured = Boolean(config.passwordConfigured);
  if (passwordConfigured) {
    elements.securityWarning.hidden = true;
    return;
  }
  elements.securityWarning.hidden = false;
  elements.securityWarningTitle.textContent = '未设置管理密码';
  elements.securityWarningMessage.textContent =
    '当前管理接口对能访问此端口的人开放。请配置 ADMIN_PASSWORD，并通过 HTTPS 暴露控制台。';
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

async function loadSession() {
  setConnection('loading', '验证会话');
  try {
    const response = await fetch('/api/session', {
      headers: apiHeaders(),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const data = await readJson(response);
    if (!response.ok) throw new Error(data.error || `服务返回 HTTP ${response.status}`);

    state.authRequired = Boolean(data.authRequired);
    state.passwordConfigured = Boolean(data.passwordConfigured);
    state.passwordFileExists = Boolean(data.passwordFileExists);
    state.passwordChangeAvailable = Boolean(data.passwordChangeAvailable);

    if (data.authenticated) {
      showDashboard();
      await loadOverview();
    } else {
      showLogin(loginMessage(), { clearPassword: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setConnection('error', '连接失败');
    showLogin(`无法连接管理服务：${message}`, { clearPassword: true });
  }
}

async function loadOverview({ silent = false } = {}) {
  if (!state.authenticated) return;
  if (overviewController) {
    if (silent) return;
    overviewController.abort();
  }
  const controller = new AbortController();
  overviewController = controller;
  state.loading = true;
  if (!silent) {
    setConnection('loading', '连接中');
    elements.refreshButton.disabled = true;
    elements.refreshButton.textContent = '刷新中…';
  }

  try {
    const response = await fetch('/api/overview', {
      headers: apiHeaders(),
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });
    const data = await readJson(response);

    if (response.status === 401) {
      showLogin('登录已过期，请重新输入访问密码。', { clearPassword: true });
      return;
    }
    if (!response.ok) {
      throw new Error(data.error || `服务返回 HTTP ${response.status}`);
    }

    state.data = data;
    state.authRequired = Boolean(data.config?.authRequired);
    state.passwordConfigured = Boolean(data.config?.passwordConfigured);
    state.passwordFileExists = Boolean(data.config?.passwordFileExists);
    state.passwordChangeAvailable = Boolean(data.config?.passwordChangeAvailable);
    render(data);
    state.consecutiveLoadFailures = 0;
    if (state.authenticated) {
      // Already on the dashboard: only refresh the connection pill. Calling
      // showDashboard() again would re-apply every hidden/visible flag on each
      // 10s poll, which makes the top bar look like it keeps reconnecting.
      setConnection('online', '已连接');
    } else {
      showDashboard();
    }
    hideError();
  } catch (error) {
    if (error?.name === 'AbortError') return;
    const message = error instanceof Error ? error.message : String(error);
    state.consecutiveLoadFailures += 1;
    // A single failed background poll should not repaint the pill red: with a
    // flaky proxy the user sees "连接失败 / 已连接" flicker every 10 seconds.
    if (!silent || state.consecutiveLoadFailures >= 2) {
      setConnection('error', '连接失败');
    }
    if (!silent) showError(message);
  } finally {
    if (overviewController === controller) {
      overviewController = null;
      state.loading = false;
    }
    if (!silent) {
      elements.refreshButton.disabled = false;
      elements.refreshButton.textContent = '刷新';
    }
  }
}

function render(data) {
  const status = data.status || {};
  const runtime = data.runtime || {};
  const readiness = data.readiness || {};
  const targets = Array.isArray(data.targets) ? data.targets : [];
  const logs = Array.isArray(data.logs) ? data.logs : [];
  const healthy = targets.filter(targetIsHealthy).length;
  const failing = targets.filter(targetHasFailure).length;
  const paused = targets.filter((target) => target.paused === true).length;
  const overall =
    data.overall ||
    (failing > 0 ? 'degraded' : targets.some((target) => target.lastVisit) ? 'ok' : 'idle');

  setSecurityWarning(data.config || {});
  const readinessReady = readiness.ready === true;
  renderOverall(overall, targets, failing, readiness);
  setText(elements.metricTargets, String(targets.length));
  setText(elements.metricHealthy, `${healthy} / ${targets.length}`);
  setText(elements.metricFailing, String(failing));
  setText(elements.metricPaused, String(paused));
  setText(elements.metricReadiness, readinessReady ? '就绪' : '需关注');
  elements.metricReadinessCard.dataset.state = readinessReady ? 'ready' : 'warning';
  setText(elements.metricVisits, String(status.visits ?? 0));
  setText(elements.metricMemory, formatBytes(runtime.memoryUsage?.rss));
  setText(elements.metricBrowsers, String(runtime.activeBrowsers ?? 0));
  setText(elements.metricQueue, String(runtime.queueLength ?? 0));
  renderStats(data.stats);
  setText(elements.lastSweep, status.lastSweepAt ? formatDateTime(status.lastSweepAt) : '等待首轮');
  setText(elements.uptime, formatUptime(status.uptimeSec));
  setText(elements.lastUpdated, formatDateTime(data.generatedAt));
  // Avoid rebuilding every card on each 10s poll: the DOM is identical unless
  // the data changed, and replacing it drops focus/selection inside the list.
  const signature = JSON.stringify(targets);
  if (signature !== state.targetsSignature) {
    state.targetsSignature = signature;
    renderTargets(targets);
  } else {
    state.lastRenderedTargets = targets;
  }
  renderLogs(logs);
}

function renderStats(stats) {
  if (!elements.statsBars) return;
  const days = Array.isArray(stats?.last7Days) ? stats.last7Days : [];
  const totals = stats?.totals || {};
  if (days.length === 0) {
    elements.statsBars.replaceChildren(createEmptyState('暂无访问统计，完成首轮巡检后显示。'));
    setText(elements.statsSummary, '暂无统计');
    return;
  }
  const max = Math.max(1, ...days.map((day) => Number(day.visits) || 0));
  const fragment = document.createDocumentFragment();
  days.forEach((day, index) => {
    const visits = Number(day.visits) || 0;
    const failed = Number(day.failed) || 0;
    const bar = document.createElement('div');
    bar.className = 'stats-bar';
    bar.title = `${day.date}：${visits} 次访问，${failed} 次失败`;
    if (index === days.length - 1) bar.dataset.today = 'true';

    const value = document.createElement('strong');
    value.className = 'stats-bar-value';
    value.textContent = String(visits);

    const track = document.createElement('div');
    track.className = 'stats-bar-track';
    const fill = document.createElement('div');
    fill.className = 'stats-bar-fill';
    fill.dataset.state = failed > 0 ? 'warn' : 'ok';
    fill.style.height = `${visits > 0 ? Math.max(6, Math.round((visits / max) * 100)) : 2}%`;
    track.append(fill);

    const label = document.createElement('span');
    label.className = 'stats-bar-label';
    label.textContent = String(day.date).slice(5);

    bar.append(value, track, label);
    fragment.append(bar);
  });
  elements.statsBars.replaceChildren(fragment);
  setText(
    elements.statsSummary,
    `累计 ${totals.visits ?? 0} 次 · 失败 ${totals.failed ?? 0} 次 · 平均 ${formatDurationMs(totals.avgMs)}`,
  );
}

function formatDurationMs(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (seconds < 1) return '0 秒';
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  return `${(seconds / 60).toFixed(1)} 分钟`;
}

function renderOverall(overall, targets, failing, readiness = {}) {
  elements.statusHero.dataset.state = overall;
  if (targets.length === 0) {
    setText(elements.overallLabel, '等待添加目标');
    setText(elements.overallDetail, '添加一个网页目标后，调度器会自动开始定时访问并验证页面内容。');
    return;
  }
  if (overall === 'degraded') {
    const notReady = Math.max(0, Number(readiness.issueCount) || 0);
    const overdue = targets.filter((target) => target.overdue === true).length;
    const issues = [];
    if (failing > 0) issues.push(`${failing} 个目标连续失败`);
    if (notReady > 0) issues.push(`${notReady} 个目标未满足保活窗口`);
    if (overdue > 0) issues.push(`${overdue} 个目标调度超时`);
    setText(elements.overallLabel, '需要关注');
    setText(
      elements.overallDetail,
      `${issues.length > 0 ? issues.join('，') : '业务就绪检查未通过'}。请检查目标地址、页面文案、代理和浏览器进程。`,
    );
    return;
  }
  if (overall === 'idle') {
    setText(elements.overallLabel, '等待首轮巡检');
    setText(elements.overallDetail, `进程已启动，共 ${targets.length} 个目标正在等待调度。`);
    return;
  }
  setText(elements.overallLabel, '运行正常');
  setText(elements.overallDetail, `最近一次巡检结果正常，共 ${targets.length} 个目标纳入保活。`);
}

function renderTargets(targets) {
  state.lastRenderedTargets = targets;
  if (targets.length === 0) {
    setText(elements.targetFilterSummary, '暂无保活目标');
    updateFilterCounts(targets);
    const empty = createEmptyState('还没有保活目标。添加网页地址后，调度器会自动开始访问。');
    const button = document.createElement('button');
    button.className = 'button button-primary button-small';
    button.type = 'button';
    button.textContent = '添加第一个目标';
    button.addEventListener('click', () => openTargetDialog());
    empty.append(button);
    elements.targetsList.replaceChildren(empty);
    return;
  }

  const visibleTargets = targets.filter(targetMatchesFilters);
  updateFilterCounts(targets);
  setText(
    elements.targetFilterSummary,
    visibleTargets.length === targets.length
      ? `共 ${targets.length} 个目标`
      : `显示 ${visibleTargets.length} / ${targets.length} 个目标`,
  );
  if (visibleTargets.length === 0) {
    const empty = createEmptyState(emptyFilterMessage(targets));
    const reset = makeActionButton('清除筛选', 'button button-quiet button-small', resetTargetFilters);
    empty.append(reset);
    elements.targetsList.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const target of visibleTargets) {
    // One malformed target must not blank out the whole list: render a
    // placeholder for it and keep the other cards on screen.
    try {
      fragment.append(createTargetCard(target));
    } catch (error) {
      console.error('[target-card] 渲染失败', target?.id, error);
      fragment.append(createTargetErrorCard(target, error));
    }
  }
  elements.targetsList.replaceChildren(fragment);
}

function createTargetErrorCard(target, error) {
  const card = document.createElement('article');
  card.className = 'target-card';
  card.dataset.state = 'failed';
  const title = document.createElement('h3');
  title.textContent = target?.id || '未命名目标';
  const detail = document.createElement('p');
  detail.className = 'target-reason';
  detail.textContent = `卡片渲染失败：${error instanceof Error ? error.message : String(error)}`;
  card.append(title, detail);
  return card;
}

function emptyFilterMessage(targets) {
  const query = state.targetSearch.trim();
  if (query) return `没有匹配「${query}」的目标。`;
  if (state.targetFilter !== 'all') {
    return `当前筛选下没有目标，切换到「全部」可查看全部 ${targets.length} 个目标。`;
  }
  return '没有可显示的目标。';
}

const filterCounters = {
  all: (targets) => targets.length,
  healthy: (targets) => targets.filter(targetIsHealthy).length,
  failing: (targets) => targets.filter(targetHasFailure).length,
  paused: (targets) => targets.filter((target) => target.paused === true).length,
  'scheduled-off': (targets) =>
    targets.filter((target) => !target.paused && target.scheduledOff === true).length,
  'keep-open': (targets) =>
    targets.filter((target) => !target.paused && target.keepOpenActive === true).length,
  waiting: (targets) =>
    targets.filter(
      (target) =>
        !target.paused &&
        !target.scheduledOff &&
        !target.lastVisit &&
        Number(target.consecutiveFailures) === 0,
    ).length,
};

function updateFilterCounts(targets) {
  if (!elements.targetFilters) return;
  for (const chip of elements.targetFilters.querySelectorAll('[data-filter]')) {
    const key = chip.dataset.filter || 'all';
    const counter = filterCounters[key];
    if (!counter) continue;
    if (!chip.dataset.label) chip.dataset.label = chip.textContent.trim();
    const count = counter(targets);
    const badge = document.createElement('span');
    badge.className = 'filter-chip-count';
    badge.textContent = String(count);
    chip.replaceChildren(document.createTextNode(chip.dataset.label), badge);
    chip.classList.toggle('is-empty', count === 0);
  }
}

function targetMatchesFilters(target) {
  const query = state.targetSearch.trim().toLocaleLowerCase('zh-CN');
  if (query) {
    const haystack = [target.id, target.account, target.url]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase('zh-CN');
    if (!haystack.includes(query)) return false;
  }

  if (state.targetFilter === 'paused') return target.paused === true;
  if (state.targetFilter === 'keep-open') return !target.paused && target.keepOpenActive === true;
  if (state.targetFilter === 'scheduled-off') return !target.paused && target.scheduledOff === true;
  // "全部" 必须无条件显示所有目标。暂停和计划关闭的目标同样要出现，
  // 否则用户会以为目标丢了（自动暂停是最常见的触发路径）。
  if (state.targetFilter === 'all') return true;
  if (target.paused || target.scheduledOff) return false;
  if (state.targetFilter === 'healthy') return targetIsHealthy(target);
  if (state.targetFilter === 'failing') return targetHasFailure(target);
  if (state.targetFilter === 'waiting') {
    return !target.lastVisit && Number(target.consecutiveFailures) === 0;
  }
  return true;
}

function targetIsHealthy(target) {
  return (
    !target.paused &&
    !target.scheduledOff &&
    target.lastVisit?.ok === true &&
    !(target.readinessIssues?.length > 0)
  );
}

function targetHasFailure(target) {
  return (
    !target.paused &&
    !target.scheduledOff &&
    (target.lastVisit?.ok === false ||
      Number(target.consecutiveFailures) > 0 ||
      target.readinessIssues?.length > 0)
  );
}

function resetTargetFilters() {
  state.targetSearch = '';
  state.targetFilter = 'all';
  elements.targetSearch.value = '';
  for (const chip of elements.targetFilters.querySelectorAll('[data-filter]')) {
    const active = chip.dataset.filter === 'all';
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-pressed', String(active));
  }
  renderTargets(state.lastRenderedTargets);
}

function targetState(target) {
  if (target.paused) return { key: 'paused', label: '已暂停' };
  if (target.keepOpenActive) return { key: 'keep-open', label: '挂机保持中' };
  if (target.scheduledOff) return { key: 'scheduled-off', label: '计划关闭' };
  if (target.running) return { key: 'running', label: '巡检中' };
  if (target.locked) return { key: 'pending', label: '处理中' };
  if (target.pendingRun) return { key: 'pending', label: '已排队' };
  const waking = formatWakingState(target.lastVisit);
  const issues = Array.isArray(target.readinessIssues) ? target.readinessIssues : [];
  // 唤醒中的 502/503/504 会自然累计连续失败，不应因此遮住更具体的唤醒状态；
  // 认证失败、成功记录过期、调度超时等问题仍优先显示为“需关注”。
  if (waking && issues.every((issue) => issue === 'consecutive-failures')) return waking;
  if (issues.length > 0) return { key: 'failed', label: '需关注' };
  if (waking) return waking;
  if (target.lastVisit?.ok === true) return { key: 'ok', label: '正常' };
  if (target.lastVisit || Number(target.consecutiveFailures) > 0) {
    return { key: 'failed', label: '异常' };
  }
  return { key: 'idle', label: '等待首轮' };
}

function formatWakingState(visit) {
  const match = /^not-ready:http-(502|503|504)$/.exec(String(visit?.reason || ''));
  if (!match) return null;
  const labels = {
    502: '服务启动中',
    503: '服务唤醒中',
    504: '网关响应超时',
  };
  return { key: 'waking', label: labels[match[1]] };
}

function createTargetCard(target) {
  const status = targetState(target);
  const card = document.createElement('article');
  card.className = 'target-card';
  card.dataset.state = status.key;

  const head = document.createElement('div');
  head.className = 'target-card-head';
  const identity = document.createElement('div');
  identity.className = 'target-identity';
  const title = document.createElement('h3');
  title.textContent = target.id || '未命名目标';
  title.title = target.id || '';
  const source = document.createElement('p');
  source.textContent = `${target.source === 'managed' ? '网页管理目标' : '配置文件目标'}${
    target.account ? ` · 账号 ${target.account}` : ''
  }`;
  identity.append(title, source);

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.dataset.state = status.key;
  badge.textContent = status.label;
  head.append(identity, badge);

  const url = document.createElement('a');
  url.className = 'target-url';
  url.textContent = target.url || '未提供地址';
  url.title = target.url || '';
  const safeUrl = safeHttpUrl(target.url);
  if (safeUrl) {
    url.href = safeUrl;
    url.target = '_blank';
    url.rel = 'noopener noreferrer';
  }

  let pauseNotice = null;
  if (target.paused) {
    pauseNotice = document.createElement('div');
    pauseNotice.className = 'target-pause-notice';
    const pauseTitle = document.createElement('strong');
    pauseTitle.textContent = target.pauseReason || '目标已暂停';
    const pauseDetail = document.createElement('span');
    pauseDetail.textContent = target.pausedUntil
      ? `自动恢复时间：${formatDateTime(target.pausedUntil)}`
      : '暂停期间不会参与自动巡检，可随时手动恢复。';
    pauseNotice.append(pauseTitle, pauseDetail);
  }

  let scheduleNotice = null;
  if (!target.paused && target.scheduledOff) {
    scheduleNotice = document.createElement('div');
    scheduleNotice.className = 'target-schedule-notice';
    const scheduleTitle = document.createElement('strong');
    scheduleTitle.textContent = '当前处于计划关闭时段';
    const scheduleDetail = document.createElement('span');
    scheduleDetail.textContent = target.scheduleNextStart
      ? `预计将在 ${formatDateTime(target.scheduleNextStart)} 自动开启并立即发起首次唤醒。`
      : '将在下一有效活动窗口自动开启。';
    scheduleNotice.append(scheduleTitle, scheduleDetail);
  }

  let keepOpenNotice = null;
  if (target.keepOpenActive) {
    keepOpenNotice = document.createElement('div');
    keepOpenNotice.className = 'target-keep-open-notice';
    const keepOpenTitle = document.createElement('strong');
    keepOpenTitle.textContent = '浏览器长驻挂机保持中';
    const keepOpenDetail = document.createElement('span');
    const mins = Math.floor((target.keepOpenDurationSec || 0) / 60);
    keepOpenDetail.textContent = `页面持续保持打开与心跳探活，已保持访问约 ${mins} 分钟。`;
    keepOpenNotice.append(keepOpenTitle, keepOpenDetail);
  }

  const facts = document.createElement('dl');
  facts.className = 'target-facts';
  appendFact(
    facts,
    '访问窗口',
    `${target.intervalMin ?? '--'} 分钟 + 最多 ${target.jitterMin ?? '--'} 分钟`,
  );
  if (target.scheduleEnabled) {
    const daysStr = formatScheduleDays(target.scheduleDays);
    appendFact(facts, '定时窗口', `${target.scheduleStart} - ${target.scheduleEnd} (${daysStr})`);
    if (target.scheduleTimezone) {
      appendFact(facts, '活动时区', target.scheduleTimezone);
    }
    if (target.firstVisitPending) {
      appendFact(facts, '首次唤醒', '待执行（独立唤醒参数）');
    }
  }
  if (target.keepOpenEnabled) {
    const modeDesc = target.keepOpenScheduled
      ? `定时保持 (${target.keepOpenStart} - ${target.keepOpenEnd})`
      : '手动启闭';
    appendFact(facts, '长驻挂机', target.keepOpenActive ? `保持中 · ${modeDesc}` : `就绪 · ${modeDesc}`);
  }
  appendFact(facts, '保活状态', formatTargetReadiness(target));
  const nextDue = appendFact(facts, '下次执行', formatNext(target.nextDue));
  if (target.nextDue) nextDue.dataset.nextDue = target.nextDue;
  appendFact(facts, '最近成功', target.lastSuccessfulVisitAt ? formatDateTime(target.lastSuccessfulVisitAt) : '尚无成功记录');
  appendFact(facts, '最近结果', target.lastVisit ? formatDateTime(target.lastVisit.at) : '尚无记录');
  appendFact(
    facts,
    '登录校验',
    target.expectConfigured || target.loginSuccessSelector ? '已配置' : '未配置',
  );
  appendFact(facts, '访问密码', target.loginPasswordConfigured ? '已配置' : '未配置');
  appendFact(facts, '网络', formatProxy(target));
  appendFact(facts, '连续失败', String(target.consecutiveFailures ?? 0));
  appendFact(facts, '认证失败', String(target.authFailureCount ?? 0));

  const footer = document.createElement('div');
  footer.className = 'target-footer';
  const reason = document.createElement('span');
  reason.className = 'target-reason';
  reason.textContent = target.paused
    ? target.pauseReason || '目标已暂停'
    : target.lastVisit
      ? formatLogDetail(target.lastVisit)
      : '等待第一次巡检结果';
  reason.title = reason.textContent;

  const actions = document.createElement('div');
  actions.className = 'target-actions';
  const runButton = makeActionButton('立即巡检', 'button button-quiet', () => triggerRun(target.id, runButton));
  runButton.disabled = Boolean(target.paused || target.running || target.locked || target.pendingRun || target.keepOpenActive);

  const probeButton = makeActionButton('测试连通', 'button button-quiet', () =>
    probeTargetAction(target, probeButton),
  );
  probeButton.disabled = Boolean(target.running || target.locked);

  const toggleKeepOpenButton = makeActionButton(
    target.keepOpenActive ? '停止保持' : '保持访问',
    target.keepOpenActive ? 'button button-primary' : 'button button-quiet',
    () => toggleTargetKeepOpen(target, toggleKeepOpenButton),
  );
  toggleKeepOpenButton.disabled = Boolean(target.paused || target.running || target.locked || target.pendingRun);

  const togglePauseButton = makeActionButton(
    target.paused ? '恢复调度' : '暂停',
    'button button-quiet',
    () => toggleTargetPause(target, togglePauseButton),
  );
  togglePauseButton.disabled = Boolean(target.running || target.locked || target.pendingRun || target.keepOpenActive);
  actions.append(runButton, probeButton, toggleKeepOpenButton, togglePauseButton);

  if (target.editable) {
    const editButton = makeActionButton('编辑', 'button button-quiet', () => openTargetDialog(target));
    const deleteButton = makeActionButton('删除', 'button button-danger', () => deleteTarget(target));
    editButton.disabled = Boolean(target.locked || target.keepOpenActive);
    deleteButton.disabled = Boolean(target.locked || target.keepOpenActive);
    actions.append(editButton, deleteButton);
  }

  footer.append(reason, actions);
  card.append(head, url, ...(pauseNotice ? [pauseNotice] : keepOpenNotice ? [keepOpenNotice] : scheduleNotice ? [scheduleNotice] : []), facts, footer);
  return card;
}

const SCHEDULE_DAY_LABELS = {
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
  7: '周日',
};

function formatScheduleDays(days) {
  const list = Array.isArray(days)
    ? [...new Set(days.map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))].sort(
        (a, b) => a - b,
      )
    : [];
  if (list.length === 0 || list.length === 7) return '每天';
  if (list.length === 5 && list.every((day, index) => day === index + 1)) return '工作日';
  if (list.length === 2 && list[0] === 6 && list[1] === 7) return '周末';

  // Collapse consecutive runs so 1-5 renders as "周一至周五" instead of a list.
  const ranges = [];
  let start = list[0];
  let previous = list[0];
  for (const day of list.slice(1)) {
    if (day === previous + 1) {
      previous = day;
      continue;
    }
    ranges.push([start, previous]);
    start = day;
    previous = day;
  }
  ranges.push([start, previous]);
  return ranges
    .map(([from, to]) =>
      from === to ? SCHEDULE_DAY_LABELS[from] : `${SCHEDULE_DAY_LABELS[from]}至${SCHEDULE_DAY_LABELS[to]}`,
    )
    .join('、');
}

function formatTargetReadiness(target) {
  if (target.paused) return '已暂停';
  if (target.scheduledOff) return '计划关闭';
  const labels = {
    'consecutive-failures': '连续失败',
    'schedule-overdue': '调度超时',
    'stale-success': '成功记录过期',
  };
  const issues = Array.isArray(target.readinessIssues) ? target.readinessIssues : [];
  return issues.length > 0 ? issues.map((issue) => labels[issue] || issue).join('、') : '正常';
}

function makeActionButton(label, className, onClick) {
  const button = document.createElement('button');
  button.className = className;
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function appendFact(list, label, value) {
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = value;
  description.title = value;
  wrapper.append(term, description);
  list.append(wrapper);
  return description;
}

function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function renderLogs(logs) {
  setText(elements.activityCount, `${logs.length} 条`);
  elements.clearLogsButton.disabled = state.clearingLogs || logs.length === 0;
  if (logs.length === 0) {
    elements.activityList.replaceChildren(createEmptyState('暂无事件记录。'));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of logs.slice().reverse()) {
    const row = document.createElement('article');
    row.className = 'activity-entry';
    row.dataset.level = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'info';

    const marker = document.createElement('span');
    marker.className = 'activity-marker';
    marker.setAttribute('aria-hidden', 'true');

    const copy = document.createElement('div');
    copy.className = 'activity-copy';
    const title = document.createElement('div');
    title.className = 'activity-title';
    const event = document.createElement('strong');
    event.textContent = eventLabels[entry.event] || entry.event || '事件';
    title.append(event);
    if (entry.target) {
      const target = document.createElement('span');
      target.textContent = `· ${entry.target}`;
      title.append(target);
    }
    const detail = document.createElement('p');
    detail.className = 'activity-detail';
    detail.textContent = formatLogDetail(entry);
    detail.title = detail.textContent;
    copy.append(title, detail);

    const time = document.createElement('time');
    time.className = 'activity-time';
    time.textContent = formatDateTime(entry.ts);
    if (entry.ts) time.dateTime = entry.ts;

    row.append(marker, copy, time);
    fragment.append(row);
  }
  elements.activityList.replaceChildren(fragment);
}

function formatLogDetail(entry) {
  const pieces = [];
  const reason = String(entry.reason || '');
  if (reason) pieces.push(formatReason(reason));
  if (entry.status && !/^not-ready:http-\d{3}$/.test(reason)) {
    pieces.push(`HTTP ${entry.status}`);
  }
  if (entry.title) pieces.push(entry.title);
  if (entry.nextVisitInMin !== undefined) pieces.push(`下次约 ${entry.nextVisitInMin} 分钟`);
  if (entry.attempts) pieces.push(`尝试 ${entry.attempts} 次`);
  if (entry.loginPasswordConfigured) {
    if (!entry.loginPasswordFieldFound) {
      pieces.push('未发现密码框');
    } else {
      if (entry.loginAttempted) pieces.push('已自动填写访问密码');
      if (entry.loginSubmitted) pieces.push('已提交登录表单');
    }
  }
  if (entry.artifacts) pieces.push('已保存失败现场');
  if (entry.clearedEntries !== undefined) pieces.push(`清理 ${entry.clearedEntries} 条`);
  if (entry.detail) pieces.push(entry.detail);
  return pieces.join(' · ') || '无附加信息';
}

function formatReason(raw) {
  const value = String(raw || '');
  if (value === 'ready') return '页面就绪';
  if (value === 'not-ready:http-503') return '服务唤醒中 (HTTP 503)';
  if (value === 'not-ready:http-502') return '服务启动中 (HTTP 502)';
  if (value === 'not-ready:http-504') return '网关响应超时 (HTTP 504)';
  if (value === 'expect-text-missing') return '未找到期望文本';
  if (value === 'empty-page') return '页面为空';
  if (value === 'not-ready-timeout') return '等待页面就绪超时';
  if (value.startsWith('not-ready:')) return `页面未就绪 (${value.slice(10)})`;
  if (value.startsWith('proxy-')) return `代理异常 (${value})`;
  if (value.startsWith('navigating:')) return '页面正在刷新';
  return value.length > 140 ? `${value.slice(0, 137)}...` : value || '未知结果';
}

function formatProxy(target) {
  const mode = target.proxyMode || (target.proxy ? 'custom' : 'direct');
  const proxy = target.proxy;
  if (mode === 'direct') return '直连';
  if (mode === 'inherit') {
    return proxy
      ? `继承全局 · ${proxy.server || '代理'}${proxy.auth ? ' · 认证' : ''}`
      : '继承全局（当前直连）';
  }
  if (!proxy) return '指定代理未生效';
  return `${proxy.server || '代理'}${proxy.auth ? ' · 认证' : ''}`;
}

function formatDateTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function formatUptime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分 ${Math.floor(seconds % 60)} 秒`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '--';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes / 1024;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unitIndex]}`;
}

function formatNext(value) {
  if (!value) return '待调度';
  const due = new Date(value).getTime();
  if (Number.isNaN(due)) return '待调度';
  const diff = Math.max(0, due - Date.now());
  if (diff === 0) return '即将执行';
  if (diff < 60_000) return `${Math.ceil(diff / 1000)} 秒后`;
  if (diff < 3_600_000) return `${Math.ceil(diff / 60_000)} 分钟后`;
  return `${Math.ceil(diff / 3_600_000)} 小时后`;
}

function createEmptyState(message) {
  const element = document.createElement('div');
  element.className = 'empty-state';
  element.textContent = message;
  return element;
}

function updateTargetScheduleFields() {
  const enabled = elements.targetScheduleEnabled.checked;
  elements.targetScheduleFields.hidden = !enabled;
}

function updateTargetKeepOpenFields() {
  const enabled = elements.targetKeepOpenEnabled.checked;
  elements.targetKeepOpenFields.hidden = !enabled;
}

function updateTargetProxyFields() {
  const custom = elements.targetProxyMode.value === 'custom';
  elements.targetProxyFields.hidden = !custom;
  if (!custom) {
    elements.targetClearProxyPassword.checked = false;
    elements.targetProxyPassword.disabled = false;
    return;
  }
  const clear = elements.targetClearProxyPassword.checked;
  elements.targetProxyPassword.disabled = clear;
  elements.targetClearProxyPasswordWrap.hidden =
    !state.editingTargetId || !state.editingTargetProxyPasswordConfigured;
  if (!state.editingTargetId) {
    elements.targetProxyPasswordHint.textContent = '填写后加密保存；留空表示无认证。';
  } else if (state.editingTargetProxyPasswordConfigured) {
    elements.targetProxyPasswordHint.textContent = '已配置；未修改代理地址或用户名时留空可保留，修改后需重新输入。';
  } else {
    elements.targetProxyPasswordHint.textContent = '尚未配置代理密码；填写后加密保存。';
  }
}

function openTargetDialog(target = null) {
  state.editingTargetId = target?.id || null;
  state.editingTargetPasswordConfigured = Boolean(target?.loginPasswordConfigured);
  state.editingTargetProxyPasswordConfigured = Boolean(target?.proxyPasswordConfigured);
  elements.targetForm.reset();
  elements.targetFormError.hidden = true;
  elements.targetFormError.textContent = '';
  elements.targetDialogTitle.textContent = target ? '编辑保活目标' : '添加保活目标';
  elements.targetSave.textContent = target ? '保存修改' : '保存目标';
  elements.targetId.readOnly = Boolean(target);
  elements.targetUrl.value = target?.url || '';
  elements.targetId.value = target?.id || '';
  elements.targetAccount.value = target?.account || '';
  const proxyMode = ['inherit', 'direct', 'custom'].includes(target?.proxyMode)
    ? target.proxyMode
    : 'inherit';
  elements.targetProxyMode.value = proxyMode;
  elements.targetProxy.value = proxyMode === 'custom' ? target?.proxy?.server || '' : '';
  elements.targetProxyUsername.value = target?.proxyUsername || '';
  elements.targetProxyPassword.value = '';
  elements.targetProxyPassword.disabled = false;
  elements.targetClearProxyPassword.checked = false;
  elements.targetProxyBypass.value = target?.proxyBypass || target?.proxy?.bypass || '';
  elements.targetInterval.value = String(target?.intervalMin ?? 20);
  elements.targetJitter.value = String(target?.jitterMin ?? 2);
  elements.targetWakeWait.value = String(target?.wakeWaitSec ?? 30);
  elements.targetExpect.value = target?.expect || '';
  elements.targetLoginSuccessSelector.value = target?.loginSuccessSelector || '';
  elements.targetLoginPassword.value = '';
  elements.targetLoginPassword.disabled = false;
  elements.targetClearPassword.checked = false;
  const passwordConfigured = Boolean(target?.loginPasswordConfigured);
  elements.targetClearPasswordWrap.hidden = !target || !passwordConfigured;
  if (!target) {
    elements.targetLoginPasswordHint.textContent = '填写后巡检会自动登录目标后台；留空不配置。';
  } else if (passwordConfigured) {
    elements.targetLoginPasswordHint.textContent = '已配置，留空保持不变；输入新密码会替换。';
  } else {
    elements.targetLoginPasswordHint.textContent = '尚未配置，填写后巡检会自动登录目标后台。';
  }
  const scheduleEnabled = Boolean(target?.scheduleEnabled);
  elements.targetScheduleEnabled.checked = scheduleEnabled;
  elements.targetScheduleStart.value = target?.scheduleStart || '08:00';
  elements.targetScheduleEnd.value = target?.scheduleEnd || '23:00';
  elements.targetScheduleTimezone.value = target?.scheduleTimezone || '';
  const selectedDays = new Set(target?.scheduleDays ?? [1, 2, 3, 4, 5, 6, 7]);
  for (const checkbox of elements.targetScheduleDays.querySelectorAll('input[type="checkbox"]')) {
    checkbox.checked = selectedDays.has(Number(checkbox.value));
  }
  elements.targetFirstWakeWait.value = String(target?.firstVisitWakeWaitSec ?? 180);
  elements.targetFirstTimeout.value = String(target?.firstVisitTimeoutSec ?? 180);
  elements.targetFirstRetries.value = String(target?.firstVisitRetries ?? 2);
  const keepOpenEnabled = Boolean(target?.keepOpenEnabled);
  elements.targetKeepOpenEnabled.checked = keepOpenEnabled;
  elements.targetKeepOpenScheduled.checked = Boolean(target?.keepOpenScheduled);
  elements.targetKeepOpenStart.value = target?.keepOpenStart || '09:00';
  elements.targetKeepOpenEnd.value = target?.keepOpenEnd || '18:00';
  updateTargetScheduleFields();
  updateTargetKeepOpenFields();
  updateTargetProxyFields();
  elements.targetDialog.showModal();
  window.requestAnimationFrame(() => elements.targetUrl.focus());
}

function closeTargetDialog() {
  state.editingTargetPasswordConfigured = false;
  state.editingTargetProxyPasswordConfigured = false;
  elements.targetLoginPassword.value = '';
  elements.targetLoginPassword.disabled = false;
  elements.targetProxyPassword.value = '';
  elements.targetProxyPassword.disabled = false;
  elements.targetClearProxyPassword.checked = false;
  if (elements.targetDialog.open) elements.targetDialog.close();
}

function openPasswordDialog() {
  elements.passwordForm.reset();
  elements.passwordFormError.hidden = true;
  elements.passwordFormError.textContent = '';
  elements.securityDialog.showModal();
  window.requestAnimationFrame(() => elements.currentPassword.focus());
}

function closePasswordDialog() {
  if (elements.securityDialog.open) elements.securityDialog.close();
}

function showPasswordFormError(message) {
  elements.passwordFormError.textContent = message;
  elements.passwordFormError.hidden = false;
}

function validatePasswordPayload(payload) {
  if (!payload.currentPassword) return '请输入当前管理密码。';
  if (payload.newPassword.length < 10 || payload.newPassword.length > 256) {
    return '新密码长度必须为 10–256 个字符。';
  }
  if (payload.newPassword !== payload.confirmPassword) return '两次输入的新密码不一致。';
  return null;
}

async function submitPasswordForm(event) {
  event.preventDefault();
  if (state.changingPassword) return;

  const payload = {
    currentPassword: elements.currentPassword.value,
    newPassword: elements.newPassword.value,
    confirmPassword: elements.confirmPassword.value,
  };
  const validationError = validatePasswordPayload(payload);
  if (validationError) {
    showPasswordFormError(validationError);
    return;
  }

  state.changingPassword = true;
  elements.passwordSave.disabled = true;
  elements.passwordSave.textContent = '更新中…';
  elements.passwordFormError.hidden = true;

  try {
    const response = await fetch('/api/password', {
      method: 'PUT',
      headers: apiHeaders(true),
      credentials: 'same-origin',
      body: JSON.stringify({
        currentPassword: payload.currentPassword,
        newPassword: payload.newPassword,
      }),
    });
    const data = await readJson(response);
    if (response.status === 401) {
      closePasswordDialog();
      showLogin('登录已过期，请重新输入管理密码。', { clearPassword: true });
      return;
    }
    if (!response.ok) {
      showPasswordFormError(data.error || `修改失败（HTTP ${response.status}）。`);
      return;
    }

    state.passwordConfigured = true;
    state.passwordFileExists = true;
    state.passwordChangeAvailable = true;
    elements.passwordForm.reset();
    closePasswordDialog();
    showToast(data.message || '管理密码已修改。');
    await loadOverview({ silent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showPasswordFormError(`修改失败：${message}`);
  } finally {
    state.changingPassword = false;
    elements.passwordSave.disabled = false;
    elements.passwordSave.textContent = '更新密码';
  }
}

function showTargetFormError(message) {
  elements.targetFormError.textContent = message;
  elements.targetFormError.hidden = false;
}

function isValidTimeZoneName(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validateTargetPayload(payload) {
  let parsedUrl;
  try {
    parsedUrl = new URL(payload.url);
  } catch {
    return '请输入有效的网页地址。';
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) return '网页地址仅支持 http:// 或 https://。';
  if (parsedUrl.username || parsedUrl.password) return '网页地址不能包含账号或密码。';
  if (!Number.isInteger(payload.intervalMin) || payload.intervalMin < 1 || payload.intervalMin > 28) {
    return '巡检间隔必须是 1–28 的整数。';
  }
  if (!Number.isInteger(payload.jitterMin) || payload.jitterMin < 0 || payload.jitterMin > 10) {
    return '随机抖动必须是 0–10 的整数。';
  }
  if (payload.intervalMin + payload.jitterMin > 28) {
    return '巡检间隔与随机抖动之和不能超过 28 分钟，否则可能错过 30 分钟休眠窗口。';
  }
  if (payload.wakeWaitSec !== undefined) {
    if (!Number.isInteger(payload.wakeWaitSec) || payload.wakeWaitSec < 5 || payload.wakeWaitSec > 300) {
      return '常规唤醒等待时间必须是 5–300 之间的整数（秒）。';
    }
  }
  if (payload.keepOpenEnabled && payload.keepOpenScheduled) {
    if (!payload.keepOpenStart || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(payload.keepOpenStart)) {
      return '挂机开始时间必须是 24 小时制 HH:MM 格式。';
    }
    if (!payload.keepOpenEnd || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(payload.keepOpenEnd)) {
      return '挂机结束时间必须是 24 小时制 HH:MM 格式。';
    }
    if (payload.keepOpenStart === payload.keepOpenEnd) {
      return '挂机开始时间与结束时间不能相同；跨午夜请使用 22:00 - 02:00 这种写法。';
    }
  }
  if (payload.scheduleEnabled) {
    if (!payload.scheduleStart || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(payload.scheduleStart)) {
      return '活动开始时间必须是 24 小时制 HH:MM 格式。';
    }
    if (!payload.scheduleEnd || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(payload.scheduleEnd)) {
      return '活动结束时间必须是 24 小时制 HH:MM 格式。';
    }
    if (payload.scheduleStart === payload.scheduleEnd) {
      return '活动开始时间与结束时间不能相同；跨午夜请使用 22:00 - 02:00 这种写法。';
    }
    if (payload.scheduleTimezone && !isValidTimeZoneName(payload.scheduleTimezone)) {
      return '活动窗口时区不是有效的 IANA 时区（例如 Asia/Shanghai）。';
    }
    if (!Array.isArray(payload.scheduleDays) || payload.scheduleDays.length === 0) {
      return '启用定时启停时，至少必须选择一个生效星期。';
    }
  }
  if (!Number.isInteger(payload.firstVisitWakeWaitSec) || payload.firstVisitWakeWaitSec < 5 || payload.firstVisitWakeWaitSec > 300) {
    return '首次唤醒等待时间必须是 5–300 之间的整数（秒）。';
  }
  if (!Number.isInteger(payload.firstVisitTimeoutSec) || payload.firstVisitTimeoutSec < 5 || payload.firstVisitTimeoutSec > 300) {
    return '首次页面超时时间必须是 5–300 之间的整数（秒）。';
  }
  if (!Number.isInteger(payload.firstVisitRetries) || payload.firstVisitRetries < 0 || payload.firstVisitRetries > 5) {
    return '首次重试次数必须是 0–5 之间的整数。';
  }
  if (payload.id && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(payload.id)) {
    return '目标名称只能包含字母、数字、点、下划线和短横线，长度 1–64。';
  }
  if (payload.account.length > 100) return '账号备注不能超过 100 个字符。';
  if (payload.expect.length > 500) return '期望文本不能超过 500 个字符。';
  if (payload.loginSuccessSelector.length > 300) {
    return '登录成功选择器不能超过 300 个字符。';
  }
  if (payload.loginPassword !== undefined && payload.loginPassword.length > 512) {
    return '后台访问密码不能超过 512 个字符。';
  }
  if (payload.loginPassword && payload.clearLoginPassword) {
    return '不能同时设置和清除后台访问密码。';
  }
  if (!['inherit', 'direct', 'custom'].includes(payload.proxyMode)) {
    return '请选择有效的网络代理模式。';
  }
  if (payload.proxyMode !== 'custom') {
    if (payload.proxy || payload.proxyUsername || payload.proxyPassword || payload.proxyBypass) {
      return '只有指定代理模式才能配置代理参数。';
    }
    if (payload.clearProxyPassword) return '只有指定代理模式才能清除代理密码。';
    return null;
  }
  if (!payload.proxy) return '指定代理时必须填写代理地址。';
  if (payload.proxy.length > 2048) return '代理地址不能超过 2048 个字符。';
  if (payload.proxyUsername.length > 256) return '代理用户名不能超过 256 个字符。';
  if (payload.proxyPassword !== undefined && payload.proxyPassword.length > 512) {
    return '代理密码不能超过 512 个字符。';
  }
  if (payload.proxyBypass.length > 2048) return '代理绕过列表不能超过 2048 个字符。';
  if (payload.proxyPassword && !payload.proxyUsername) {
    return '配置代理密码时必须同时填写代理用户名。';
  }
  if (payload.proxyPassword && payload.clearProxyPassword) {
    return '不能同时设置和清除代理密码。';
  }

  let proxyUrl;
  try {
    proxyUrl = new URL(
      /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(payload.proxy)
        ? payload.proxy
        : `http://${payload.proxy}`,
    );
  } catch {
    return '请输入有效的代理地址。';
  }
  if (!['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'].includes(proxyUrl.protocol)) {
    return '代理地址仅支持 HTTP、HTTPS、SOCKS4、SOCKS5 或 SOCKS5H。';
  }
  if (
    ['socks4:', 'socks5:', 'socks5h:'].includes(proxyUrl.protocol) &&
    (payload.proxyUsername || payload.proxyPassword)
  ) {
    return 'SOCKS 代理不支持用户名或密码认证。';
  }
  return null;
}

async function submitTargetForm(event) {
  event.preventDefault();
  if (state.saving) return;

  const selectedDays = [];
  for (const checkbox of elements.targetScheduleDays.querySelectorAll('input[type="checkbox"]:checked')) {
    selectedDays.push(Number(checkbox.value));
  }
  const payload = {
    url: elements.targetUrl.value.trim(),
    id: elements.targetId.value.trim(),
    account: elements.targetAccount.value.trim(),
    intervalMin: Number(elements.targetInterval.value),
    jitterMin: Number(elements.targetJitter.value),
    wakeWaitSec: Number(elements.targetWakeWait.value),
    expect: elements.targetExpect.value.trim(),
    loginSuccessSelector: elements.targetLoginSuccessSelector.value.trim(),
    proxyMode: elements.targetProxyMode.value,
    scheduleEnabled: elements.targetScheduleEnabled.checked,
    scheduleStart: elements.targetScheduleStart.value.trim(),
    scheduleEnd: elements.targetScheduleEnd.value.trim(),
    scheduleTimezone: elements.targetScheduleTimezone.value.trim(),
    scheduleDays: selectedDays,
    firstVisitWakeWaitSec: Number(elements.targetFirstWakeWait.value),
    firstVisitTimeoutSec: Number(elements.targetFirstTimeout.value),
    firstVisitRetries: Number(elements.targetFirstRetries.value),
    keepOpenEnabled: elements.targetKeepOpenEnabled.checked,
    keepOpenScheduled: elements.targetKeepOpenScheduled.checked,
    keepOpenStart: elements.targetKeepOpenStart.value.trim(),
    keepOpenEnd: elements.targetKeepOpenEnd.value.trim(),
  };
  if (payload.proxyMode === 'custom') {
    payload.proxy = elements.targetProxy.value.trim();
    payload.proxyUsername = elements.targetProxyUsername.value.trim();
    payload.proxyBypass = elements.targetProxyBypass.value.trim();
    const proxyPassword = elements.targetProxyPassword.value;
    if (proxyPassword) payload.proxyPassword = proxyPassword;
    if (state.editingTargetId && elements.targetClearProxyPassword.checked) {
      payload.clearProxyPassword = true;
    }
  } else if (payload.proxyMode === 'direct') {
    payload.proxy = '';
  }
  const loginPassword = elements.targetLoginPassword.value;
  if (loginPassword) payload.loginPassword = loginPassword;
  if (state.editingTargetId && elements.targetClearPassword.checked) {
    payload.clearLoginPassword = true;
  }
  if (!payload.id) delete payload.id;
  const validationError = validateTargetPayload(payload);
  if (validationError) {
    showTargetFormError(validationError);
    return;
  }
  const passwordWillBeConfigured =
    Boolean(payload.loginPassword) ||
    (state.editingTargetPasswordConfigured && !payload.clearLoginPassword);
  if (passwordWillBeConfigured && !payload.expect && !payload.loginSuccessSelector) {
    showTargetFormError('配置后台访问密码时，必须填写期望文本或登录成功选择器。');
    return;
  }
  if (
    payload.clearLoginPassword &&
    !window.confirm('确定清除该目标已保存的后台访问密码吗？')
  ) {
    return;
  }
  if (
    payload.clearProxyPassword &&
    !window.confirm('确定清除该目标已保存的代理密码吗？')
  ) {
    return;
  }

  state.saving = true;
  elements.targetSave.disabled = true;
  elements.targetSave.textContent = '保存中…';
  elements.targetFormError.hidden = true;
  const editingId = state.editingTargetId;

  try {
    const response = await fetch(editingId ? `/api/targets/${encodeURIComponent(editingId)}` : '/api/targets', {
      method: editingId ? 'PATCH' : 'POST',
      headers: apiHeaders(true),
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    const data = await readJson(response);
    if (response.status === 401) {
      closeTargetDialog();
      showLogin('登录已过期，请重新输入访问密码。', { clearPassword: true });
      return;
    }
    if (!response.ok) {
      showTargetFormError(data.error || `保存失败（HTTP ${response.status}）。`);
      return;
    }
    closeTargetDialog();
    showToast(data.message || (editingId ? '目标已更新。' : '目标已创建。'));
    await loadOverview({ silent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showTargetFormError(`保存失败：${message}`);
  } finally {
    state.saving = false;
    elements.targetSave.disabled = false;
    elements.targetSave.textContent = editingId ? '保存修改' : '保存目标';
  }
}

async function deleteTarget(target) {
  if (target.locked || target.keepOpenActive) return;
  if (!window.confirm(`确定删除目标“${target.id}”吗？删除后不会影响静态配置文件。`)) return;
  try {
    const response = await fetch(`/api/targets/${encodeURIComponent(target.id)}`, {
      method: 'DELETE',
      headers: apiHeaders(),
      credentials: 'same-origin',
    });
    const data = await readJson(response);
    if (response.status === 401) {
      showLogin('登录已过期，请重新输入访问密码。', { clearPassword: true });
      return;
    }
    if (!response.ok) throw new Error(data.error || `服务返回 HTTP ${response.status}`);
    showToast(data.message || '目标已删除。');
    await loadOverview({ silent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`删除失败：${message}`, 'error');
  }
}

async function toggleTargetKeepOpen(target, button) {
  const nextAction = target.keepOpenActive ? 'stop' : 'start';
  const label = nextAction === 'start' ? '开启长驻挂机保持访问' : '停止长驻挂机保持';
  if (!window.confirm(`确定要为目标「${target.id}」${label}吗？`)) {
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch(`/api/targets/${encodeURIComponent(target.id)}/keep-open`, {
      method: 'POST',
      headers: apiHeaders(true),
      credentials: 'same-origin',
      body: JSON.stringify({ action: nextAction }),
    });
    const data = await readJson(response);
    if (response.status === 401) {
      showLogin('登录已过期，请重新输入管理密码。', { clearPassword: true });
      return;
    }
    if (!response.ok) throw new Error(data.error || `服务返回 HTTP ${response.status}`);
    showToast(data.message || (nextAction === 'start' ? '已开启长驻挂机保持' : '已停止长驻挂机保持'));
    await loadOverview({ silent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`${nextAction === 'start' ? '开启' : '停止'}保持失败：${message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function toggleTargetPause(target, button) {
  if (target.running || target.locked || target.pendingRun) return;
  const action = target.paused ? 'resume' : 'pause';
  if (
    action === 'pause' &&
    !window.confirm(`确定暂停目标“${target.id}”吗？暂停期间不会执行自动巡检。`)
  ) {
    return;
  }

  button.disabled = true;
  try {
    const response = await fetch(
      `/api/targets/${encodeURIComponent(target.id)}/${action}`,
      {
        method: 'POST',
        headers: apiHeaders(),
        credentials: 'same-origin',
      },
    );
    const data = await readJson(response);
    if (response.status === 401) {
      showLogin('登录已过期，请重新输入管理密码。', { clearPassword: true });
      return;
    }
    if (!response.ok) throw new Error(data.error || `服务返回 HTTP ${response.status}`);
    showToast(data.message || (action === 'pause' ? '目标已暂停。' : '目标已恢复。'));
    await loadOverview({ silent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`${action === 'pause' ? '暂停' : '恢复'}失败：${message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function exportTargets() {
  elements.exportTargetsButton.disabled = true;
  try {
    const response = await fetch('/api/targets/export', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (response.status === 401) {
      showLogin('登录已过期，请重新输入管理密码。', { clearPassword: true });
      return;
    }
    if (!response.ok) {
      const data = await readJson(response);
      throw new Error(data.error || `服务返回 HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const fileName =
      disposition.match(/filename="([^"]+)"/i)?.[1] ||
      `blitz-keepalive-targets-${new Date().toISOString().slice(0, 10)}.json`;
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    showToast('目标配置已导出。导出文件不包含后台访问密码和代理密码。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`导出失败：${message}`, 'error');
  } finally {
    elements.exportTargetsButton.disabled = false;
  }
}

function buildImportPreview(payload) {
  const incoming = Array.isArray(payload?.targets) ? payload.targets : [];
  const current = new Map(
    (state.data?.targets || [])
      .filter((target) => target.source === 'managed')
      .map((target) => [target.id, target]),
  );
  const incomingIds = new Set();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const item of incoming) {
    const id = String(item?.id ?? '');
    if (!id) continue;
    incomingIds.add(id);
    const existing = current.get(id);
    if (!existing) {
      added += 1;
      continue;
    }
    const fields = [
      'url',
      'intervalMin',
      'jitterMin',
      'expect',
      'scheduleEnabled',
      'scheduleStart',
      'scheduleEnd',
      'scheduleTimezone',
      'keepOpenEnabled',
      'keepOpenStart',
      'keepOpenEnd',
    ];
    const changed = fields.some(
      (key) => JSON.stringify(item[key] ?? null) !== JSON.stringify(existing[key] ?? null),
    );
    if (changed) updated += 1;
    else unchanged += 1;
  }
  const removed = [...current.keys()].filter((id) => !incomingIds.has(id)).length;
  return { total: incoming.length, added, updated, unchanged, removed };
}

async function importTargetsFile(file) {
  if (!file) return;
  if (file.size > 128 * 1024) {
    showToast('导入文件不能超过 128 KB。', 'error');
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    showToast('导入文件不是有效的 JSON。', 'error');
    return;
  }
  const preview = buildImportPreview(payload);
  if (
    !window.confirm(
      `导入将完整替换当前网页管理目标（静态配置文件目标不受影响）。\n\n` +
        `共 ${preview.total} 个：新增 ${preview.added} · 更新 ${preview.updated} · 不变 ${preview.unchanged} · 移除 ${preview.removed}\n\n` +
        '确定继续吗？',
    )
  ) {
    elements.targetImportFile.value = '';
    return;
  }

  elements.importTargetsButton.disabled = true;
  try {
    const response = await fetch('/api/targets/import', {
      method: 'POST',
      headers: apiHeaders(true),
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    const data = await readJson(response);
    if (response.status === 401) {
      showLogin('登录已过期，请重新输入管理密码。', { clearPassword: true });
      return;
    }
    if (!response.ok) throw new Error(data.error || `服务返回 HTTP ${response.status}`);
    showToast(data.message || `已导入 ${data.imported ?? 0} 个目标。`);
    resetTargetFilters();
    await loadOverview({ silent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`导入失败：${message}`, 'error');
  } finally {
    elements.importTargetsButton.disabled = false;
    elements.targetImportFile.value = '';
  }
}

async function triggerRun(targetId = null, button = null) {
  if (button) button.disabled = true;
  elements.runAllButton.disabled = true;
  try {
    const url = targetId ? `/api/run?target=${encodeURIComponent(targetId)}` : '/api/run';
    const response = await fetch(url, {
      method: 'POST',
      headers: apiHeaders(),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const data = await readJson(response);
    if (response.status === 401) {
      showLogin('登录已过期，请重新输入访问密码。', { clearPassword: true });
      return;
    }
    if (!response.ok) throw new Error(data.error || `服务返回 HTTP ${response.status}`);
    showToast(data.message || '巡检请求已排队，将在数秒内执行。');
    // 立刻同步一次状态：排队后卡片会变成「巡检中 / 已排队」，
    // 按钮随之禁用。只等 10 秒轮询会让用户在间隙里重复点击并收到 409。
    await loadOverview({ silent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`巡检请求失败：${message}`, 'error');
  } finally {
    if (button) button.disabled = false;
    elements.runAllButton.disabled = false;
  }
}

async function probeTargetAction(target, button) {
  if (button) {
    button.disabled = true;
    button.textContent = '探测中…';
  }
  try {
    const response = await fetch(`/api/targets/${encodeURIComponent(target.id)}/probe`, {
      method: 'POST',
      headers: apiHeaders(),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const data = await readJson(response);
    if (response.status === 401) {
      showLogin('登录已过期，请重新输入管理密码。', { clearPassword: true });
      return;
    }
    if (!response.ok) throw new Error(data.error || `服务返回 HTTP ${response.status}`);
    const probe = data.probe || {};
    const detail = probe.ok
      ? `HTTP ${probe.httpStatus ?? '-'} · ${probe.ms ?? 0} ms${probe.proxy?.auth ? ' · 已走代理' : ''}`
      : `未就绪：${formatReason(probe.reason)} · HTTP ${probe.httpStatus ?? '-'} · ${probe.ms ?? 0} ms`;
    showToast(`${target.id}：${detail}`, probe.ok ? 'success' : 'error');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`测试连通失败：${message}`, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '测试连通';
    }
  }
}

async function bulkTargetAction(action, button) {
  const label = action === 'pause' ? '暂停' : '恢复';
  if (!window.confirm(`确定要${label}全部目标吗？${action === 'pause' ? '正在巡检的目标会被跳过。' : ''}`)) {
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch(
      `/api/targets/${action === 'pause' ? 'pause-all' : 'resume-all'}`,
      {
        method: 'POST',
        headers: apiHeaders(),
        cache: 'no-store',
        credentials: 'same-origin',
      },
    );
    const data = await readJson(response);
    if (response.status === 401) {
      showLogin('登录已过期，请重新输入管理密码。', { clearPassword: true });
      return;
    }
    if (!response.ok) throw new Error(data.error || `服务返回 HTTP ${response.status}`);
    const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
    showToast(`${data.message || `已${label}全部目标。`}${skipped > 0 ? ` 跳过 ${skipped} 个正在巡检的目标。` : ''}`);
    await loadOverview({ silent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`批量${label}失败：${message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function login(event) {
  event.preventDefault();
  const password = elements.passwordInput.value;
  if (!password) return;
  elements.loginButton.disabled = true;
  elements.loginButton.textContent = '登录中…';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password }),
    });
    const data = await readJson(response);
    if (response.status === 429) {
      const wait = Number(data.retryAfterSec) > 0 ? `，约 ${data.retryAfterSec} 秒后重试` : '';
      elements.authMessage.textContent = `${data.error || '登录失败次数过多。'}${wait}。`;
      return;
    }
    if (!response.ok) {
      elements.authMessage.textContent = data.error || '访问密码错误。';
      return;
    }
    state.authRequired = Boolean(data.authRequired);
    state.passwordConfigured = Boolean(data.passwordConfigured);
    state.passwordFileExists = Boolean(data.passwordFileExists);
    state.passwordChangeAvailable = Boolean(data.passwordChangeAvailable);
    showDashboard();
    elements.passwordInput.value = '';
    showToast('登录成功。');
    await loadOverview();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.authMessage.textContent = `登录失败：${message}`;
  } finally {
    elements.loginButton.disabled = false;
    elements.loginButton.textContent = '登录';
  }
}

async function clearLogs() {
  if (state.clearingLogs) return;
  if (!window.confirm('确定清空事件日志吗？失败现场不会被删除。')) return;

  state.clearingLogs = true;
  elements.clearLogsButton.disabled = true;
  elements.clearLogsButton.textContent = '清空中…';
  try {
    const response = await fetch('/api/logs', {
      method: 'DELETE',
      headers: apiHeaders(),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const data = await readJson(response);
    if (response.status === 401) {
      showLogin('登录已过期，请重新输入访问密码。', { clearPassword: true });
      return;
    }
    if (!response.ok) throw new Error(data.error || `服务返回 HTTP ${response.status}`);

    showToast(data.message || `已清空 ${data.clearedEntries ?? 0} 条事件日志。`);
    await loadOverview();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`清空日志失败：${message}`, 'error');
  } finally {
    state.clearingLogs = false;
    elements.clearLogsButton.textContent = '清空日志';
    const logs = Array.isArray(state.data?.logs) ? state.data.logs : [];
    elements.clearLogsButton.disabled = logs.length === 0;
  }
}

async function logout() {
  elements.logoutButton.disabled = true;
  try {
    const response = await fetch('/api/logout', {
      method: 'POST',
      headers: apiHeaders(),
      credentials: 'same-origin',
    });
    const data = await readJson(response);
    if (!response.ok) throw new Error(data.error || `服务返回 HTTP ${response.status}`);
    state.data = null;
    showLogin('已退出登录。请输入访问密码继续。', { clearPassword: true });
    showToast(data.message || '已退出登录。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`退出失败：${message}`, 'error');
  } finally {
    elements.logoutButton.disabled = false;
  }
}

function updateNextDueLabels() {
  for (const element of elements.targetsList.querySelectorAll('[data-next-due]')) {
    element.textContent = formatNext(element.dataset.nextDue);
  }
}

function bindEvents() {
  elements.refreshButton.addEventListener('click', () => {
    if (state.authenticated) loadOverview();
    else loadSession();
  });
  elements.retryButton.addEventListener('click', () => {
    if (state.authenticated) loadOverview();
    else loadSession();
  });
  elements.runAllButton.addEventListener('click', () => triggerRun());
  elements.pauseAllButton.addEventListener('click', () =>
    bulkTargetAction('pause', elements.pauseAllButton),
  );
  elements.resumeAllButton.addEventListener('click', () =>
    bulkTargetAction('resume', elements.resumeAllButton),
  );
  elements.topbarMoreToggle.addEventListener('click', () => {
    const open = elements.topbarSecondary.classList.toggle('is-open');
    elements.topbarMoreToggle.setAttribute('aria-expanded', String(open));
  });
  elements.topbarSecondary.addEventListener('click', (event) => {
    if (event.target.closest('button')) closeTopbarMenu();
  });
  document.addEventListener('click', (event) => {
    if (!elements.topbarSecondary.classList.contains('is-open')) return;
    if (event.target.closest('#topbar-secondary') || event.target.closest('#topbar-more-toggle')) {
      return;
    }
    closeTopbarMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!elements.topbarSecondary.classList.contains('is-open')) return;
    closeTopbarMenu();
    elements.topbarMoreToggle.focus();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) closeTopbarMenu();
  });
  elements.addTargetButton.addEventListener('click', () => openTargetDialog());
  elements.addTargetSecondary.addEventListener('click', () => openTargetDialog());
  elements.securityButton.addEventListener('click', openPasswordDialog);
  elements.clearLogsButton.addEventListener('click', clearLogs);
  elements.logoutButton.addEventListener('click', logout);
  elements.targetSearch.addEventListener('input', () => {
    state.targetSearch = elements.targetSearch.value;
    renderTargets(state.lastRenderedTargets);
  });
  elements.targetFilters.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-filter]');
    if (!chip || !elements.targetFilters.contains(chip)) return;
    state.targetFilter = chip.dataset.filter || 'all';
    for (const item of elements.targetFilters.querySelectorAll('[data-filter]')) {
      const active = item === chip;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    }
    renderTargets(state.lastRenderedTargets);
  });
  elements.exportTargetsButton.addEventListener('click', exportTargets);
  elements.importTargetsButton.addEventListener('click', () => elements.targetImportFile.click());
  elements.targetImportFile.addEventListener('change', () => {
    void importTargetsFile(elements.targetImportFile.files?.[0] ?? null);
  });
  elements.authForm.addEventListener('submit', login);
  elements.passwordForm.addEventListener('submit', submitPasswordForm);
  elements.targetForm.addEventListener('submit', submitTargetForm);
  elements.targetScheduleEnabled.addEventListener('change', updateTargetScheduleFields);
  elements.targetKeepOpenEnabled.addEventListener('change', updateTargetKeepOpenFields);
  elements.targetProxyMode.addEventListener('change', updateTargetProxyFields);
  elements.targetClearProxyPassword.addEventListener('change', () => {
    if (elements.targetClearProxyPassword.checked) elements.targetProxyPassword.value = '';
    elements.targetProxyPassword.disabled = elements.targetClearProxyPassword.checked;
    updateTargetProxyFields();
  });
  elements.targetClearPassword.addEventListener('change', () => {
    if (elements.targetClearPassword.checked) elements.targetLoginPassword.value = '';
    elements.targetLoginPassword.disabled = elements.targetClearPassword.checked;
  });
  elements.targetCancel.addEventListener('click', closeTargetDialog);
  elements.targetCancelX.addEventListener('click', closeTargetDialog);
  elements.targetDialog.addEventListener('click', (event) => {
    if (event.target === elements.targetDialog) closeTargetDialog();
  });
  elements.targetDialog.addEventListener('close', () => {
    elements.targetLoginPassword.value = '';
    elements.targetLoginPassword.disabled = false;
    elements.targetClearPassword.checked = false;
    elements.targetProxyPassword.value = '';
    elements.targetProxyPassword.disabled = false;
    elements.targetClearProxyPassword.checked = false;
  });
  elements.passwordCancel.addEventListener('click', closePasswordDialog);
  elements.passwordCancelX.addEventListener('click', closePasswordDialog);
  elements.securityDialog.addEventListener('click', (event) => {
    if (event.target === elements.securityDialog) closePasswordDialog();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.authenticated) loadOverview({ silent: true });
  });
}

function init() {
  bindEvents();
  loadSession();
  window.setInterval(updateNextDueLabels, 1_000);
  window.setInterval(() => {
    if (!document.hidden && state.authenticated) loadOverview({ silent: true });
  }, REFRESH_MS);
}

init();
