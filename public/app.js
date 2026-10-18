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
  changingPassword: false,
  editingTargetId: null,
  editingTargetPasswordConfigured: false,
  targetSearch: '',
  targetFilter: 'all',
  lastRenderedTargets: [],
  toastTimer: null,
};

const elements = {
  connection: document.getElementById('connection'),
  connectionLabel: document.getElementById('connection-label'),
  refreshButton: document.getElementById('refresh-button'),
  runAllButton: document.getElementById('run-all-button'),
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
  targetSearch: document.getElementById('target-search'),
  targetFilters: document.getElementById('target-filters'),
  targetFilterSummary: document.getElementById('target-filter-summary'),
  exportTargetsButton: document.getElementById('export-targets-button'),
  importTargetsButton: document.getElementById('import-targets-button'),
  targetImportFile: document.getElementById('target-import-file'),
  targetsList: document.getElementById('targets-list'),
  activityList: document.getElementById('activity-list'),
  activityCount: document.getElementById('activity-count'),
  targetDialog: document.getElementById('target-dialog'),
  targetForm: document.getElementById('target-form'),
  targetDialogTitle: document.getElementById('target-dialog-title'),
  targetUrl: document.getElementById('target-url'),
  targetId: document.getElementById('target-id'),
  targetAccount: document.getElementById('target-account'),
  targetLoginPassword: document.getElementById('target-login-password'),
  targetLoginPasswordHint: document.getElementById('target-login-password-hint'),
  targetClearPasswordWrap: document.getElementById('target-clear-password-wrap'),
  targetClearPassword: document.getElementById('target-clear-password'),
  targetInterval: document.getElementById('target-interval'),
  targetJitter: document.getElementById('target-jitter'),
  targetExpect: document.getElementById('target-expect'),
  targetLoginSuccessSelector: document.getElementById('target-login-success-selector'),
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
};

function apiHeaders(json = false) {
  const headers = {};
  if (json) headers['content-type'] = 'application/json';
  return headers;
}

function setConnection(kind, label) {
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

function showLogin(message, { clearPassword = false } = {}) {
  state.authenticated = false;
  closeTargetDialog();
  closePasswordDialog();
  elements.authPanel.hidden = false;
  elements.dashboardContent.hidden = true;
  elements.addTargetButton.hidden = true;
  elements.addTargetSecondary.hidden = true;
  elements.securityButton.hidden = true;
  elements.logoutButton.hidden = true;
  elements.refreshButton.hidden = true;
  elements.runAllButton.hidden = true;
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
  if (!silent) setConnection('loading', '连接中');

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
    showDashboard();
    hideError();
  } catch (error) {
    if (error?.name === 'AbortError') return;
    const message = error instanceof Error ? error.message : String(error);
    setConnection('error', '连接失败');
    if (!silent) showError(message);
  } finally {
    if (overviewController === controller) {
      overviewController = null;
      state.loading = false;
    }
  }
}

function render(data) {
  const status = data.status || {};
  const runtime = data.runtime || {};
  const readiness = data.readiness || {};
  const targets = Array.isArray(data.targets) ? data.targets : [];
  const logs = Array.isArray(data.logs) ? data.logs : [];
  const healthy = targets.filter((target) => target.lastVisit?.ok === true).length;
  const failing = targets.filter((target) => Number(target.consecutiveFailures) > 0).length;
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
  setText(elements.lastSweep, status.lastSweepAt ? formatDateTime(status.lastSweepAt) : '等待首轮');
  setText(elements.uptime, formatUptime(status.uptimeSec));
  setText(elements.lastUpdated, formatDateTime(data.generatedAt));
  renderTargets(targets);
  renderLogs(logs);
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
  setText(
    elements.targetFilterSummary,
    visibleTargets.length === targets.length
      ? `共 ${targets.length} 个目标`
      : `显示 ${visibleTargets.length} / ${targets.length} 个目标`,
  );
  if (visibleTargets.length === 0) {
    const empty = createEmptyState('没有符合当前搜索和筛选条件的目标。');
    const reset = makeActionButton('清除筛选', 'button button-quiet button-small', resetTargetFilters);
    empty.append(reset);
    elements.targetsList.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const target of visibleTargets) fragment.append(createTargetCard(target));
  elements.targetsList.replaceChildren(fragment);
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
  if (target.paused) return false;
  if (state.targetFilter === 'healthy') {
    return target.lastVisit?.ok === true && !(target.readinessIssues?.length > 0);
  }
  if (state.targetFilter === 'failing') {
    return (
      target.lastVisit?.ok === false ||
      Number(target.consecutiveFailures) > 0 ||
      target.readinessIssues?.length > 0
    );
  }
  if (state.targetFilter === 'waiting') {
    return !target.lastVisit && Number(target.consecutiveFailures) === 0;
  }
  return true;
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
  if (target.running) return { key: 'running', label: '巡检中' };
  if (target.locked) return { key: 'pending', label: '处理中' };
  if (target.pendingRun) return { key: 'pending', label: '已排队' };
  if (target.readinessIssues?.length > 0) return { key: 'failed', label: '需关注' };
  if (target.lastVisit?.ok === true) return { key: 'ok', label: '正常' };
  if (target.lastVisit || Number(target.consecutiveFailures) > 0) {
    return { key: 'failed', label: '异常' };
  }
  return { key: 'idle', label: '等待首轮' };
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

  const facts = document.createElement('dl');
  facts.className = 'target-facts';
  appendFact(
    facts,
    '访问窗口',
    `${target.intervalMin ?? '--'} 分钟 + 最多 ${target.jitterMin ?? '--'} 分钟`,
  );
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
  appendFact(facts, '网络', formatProxy(target.proxy));
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
  runButton.disabled = Boolean(target.paused || target.running || target.locked || target.pendingRun);
  const togglePauseButton = makeActionButton(
    target.paused ? '恢复调度' : '暂停',
    'button button-quiet',
    () => toggleTargetPause(target, togglePauseButton),
  );
  togglePauseButton.disabled = Boolean(target.running || target.locked || target.pendingRun);
  actions.append(runButton, togglePauseButton);

  if (target.editable) {
    const editButton = makeActionButton('编辑', 'button button-quiet', () => openTargetDialog(target));
    const deleteButton = makeActionButton('删除', 'button button-danger', () => deleteTarget(target));
    editButton.disabled = Boolean(target.locked);
    deleteButton.disabled = Boolean(target.locked);
    actions.append(editButton, deleteButton);
  }

  footer.append(reason, actions);
  card.append(head, url, ...(pauseNotice ? [pauseNotice] : []), facts, footer);
  return card;
}

function formatTargetReadiness(target) {
  if (target.paused) return '已暂停';
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
  if (entry.reason) pieces.push(formatReason(entry.reason));
  if (entry.status) pieces.push(`HTTP ${entry.status}`);
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
  if (entry.detail) pieces.push(entry.detail);
  return pieces.join(' · ') || '无附加信息';
}

function formatReason(raw) {
  const value = String(raw || '');
  if (value === 'ready') return '页面就绪';
  if (value === 'expect-text-missing') return '未找到期望文本';
  if (value === 'empty-page') return '页面为空';
  if (value === 'not-ready-timeout') return '等待页面就绪超时';
  if (value.startsWith('not-ready:')) return `页面未就绪 (${value.slice(10)})`;
  if (value.startsWith('proxy-')) return `代理异常 (${value})`;
  if (value.startsWith('navigating:')) return '页面正在刷新';
  return value.length > 140 ? `${value.slice(0, 137)}...` : value || '未知结果';
}

function formatProxy(proxy) {
  if (!proxy) return '直连';
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

function openTargetDialog(target = null) {
  state.editingTargetId = target?.id || null;
  state.editingTargetPasswordConfigured = Boolean(target?.loginPasswordConfigured);
  elements.targetForm.reset();
  elements.targetFormError.hidden = true;
  elements.targetFormError.textContent = '';
  elements.targetDialogTitle.textContent = target ? '编辑保活目标' : '添加保活目标';
  elements.targetSave.textContent = target ? '保存修改' : '保存目标';
  elements.targetId.readOnly = Boolean(target);
  elements.targetUrl.value = target?.url || '';
  elements.targetId.value = target?.id || '';
  elements.targetAccount.value = target?.account || '';
  elements.targetInterval.value = String(target?.intervalMin ?? 20);
  elements.targetJitter.value = String(target?.jitterMin ?? 2);
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
  elements.targetDialog.showModal();
  window.requestAnimationFrame(() => elements.targetUrl.focus());
}

function closeTargetDialog() {
  state.editingTargetPasswordConfigured = false;
  elements.targetLoginPassword.value = '';
  elements.targetLoginPassword.disabled = false;
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
  return null;
}

async function submitTargetForm(event) {
  event.preventDefault();
  if (state.saving) return;

  const payload = {
    url: elements.targetUrl.value.trim(),
    id: elements.targetId.value.trim(),
    account: elements.targetAccount.value.trim(),
    intervalMin: Number(elements.targetInterval.value),
    jitterMin: Number(elements.targetJitter.value),
    expect: elements.targetExpect.value.trim(),
    loginSuccessSelector: elements.targetLoginSuccessSelector.value.trim(),
  };
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
  if (target.locked) return;
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
    showToast('目标配置已导出。导出文件不包含访问密码。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`导出失败：${message}`, 'error');
  } finally {
    elements.exportTargetsButton.disabled = false;
  }
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
  if (
    !window.confirm(
      '导入会完整替换当前所有网页管理目标；静态配置文件目标不受影响。确定继续吗？',
    )
  ) {
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
    window.setTimeout(() => loadOverview({ silent: true }), 700);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`巡检请求失败：${message}`, 'error');
  } finally {
    if (button) button.disabled = false;
    elements.runAllButton.disabled = false;
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
  elements.addTargetButton.addEventListener('click', () => openTargetDialog());
  elements.addTargetSecondary.addEventListener('click', () => openTargetDialog());
  elements.securityButton.addEventListener('click', openPasswordDialog);
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
