const REFRESH_MS = 15_000;

const elements = {
  connection: document.getElementById('status-connection'),
  connectionLabel: document.getElementById('status-connection-label'),
  updated: document.getElementById('status-updated'),
  error: document.getElementById('status-error'),
  errorMessage: document.getElementById('status-error-message'),
  hero: document.getElementById('status-hero'),
  overall: document.getElementById('status-overall'),
  detail: document.getElementById('status-detail'),
  targetCount: document.getElementById('status-target-count'),
  activeCount: document.getElementById('status-active-count'),
  issueCount: document.getElementById('status-issue-count'),
  keepOpenCount: document.getElementById('status-keepopen-count'),
  targets: document.getElementById('status-targets'),
  statsSummary: document.getElementById('status-stats-summary'),
  statsBars: document.getElementById('status-stats-bars'),
};

function setText(element, value) {
  if (element) element.textContent = value;
}

function setConnection(kind, label) {
  elements.connection.dataset.state = kind;
  elements.connectionLabel.textContent = label;
}

function formatDateTime(value) {
  const time = Date.parse(value ?? '');
  if (!Number.isFinite(time)) return '--';
  return new Date(time).toLocaleString('zh-CN', { hour12: false });
}

function formatRelative(value) {
  const time = Date.parse(value ?? '');
  if (!Number.isFinite(time)) return '尚无记录';
  const diff = Date.now() - time;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return formatDateTime(value);
}

function targetState(target) {
  if (target.paused) return { key: 'paused', label: '已暂停' };
  if (target.keepOpenActive) return { key: 'keep-open', label: '挂机保持中' };
  if (target.scheduledOff) return { key: 'scheduled-off', label: '计划关闭' };
  if (target.consecutiveFailures > 0 || target.readinessIssues?.length > 0) {
    return { key: 'failed', label: '需关注' };
  }
  if (target.lastResult === 'ok') return { key: 'ok', label: '正常' };
  return { key: 'idle', label: '等待首轮' };
}

function renderTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '暂无保活目标。';
    elements.targets.replaceChildren(empty);
    return;
  }
  const table = document.createElement('table');
  const head = document.createElement('thead');
  head.innerHTML =
    '<tr><th scope="col">目标</th><th scope="col">状态</th><th scope="col">最近成功</th><th scope="col">下次执行</th><th scope="col">连续失败</th></tr>';
  const body = document.createElement('tbody');
  for (const target of targets) {
    const status = targetState(target);
    const row = document.createElement('tr');
    row.dataset.state = status.key;

    const nameCell = document.createElement('td');
    const name = document.createElement('strong');
    name.textContent = target.id;
    nameCell.append(name);
    if (target.account) {
      const account = document.createElement('small');
      account.textContent = `账号 ${target.account}`;
      nameCell.append(account);
    }

    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.dataset.state = status.key;
    badge.textContent = status.label;
    statusCell.append(badge);

    const successCell = document.createElement('td');
    successCell.textContent = target.lastSuccessfulVisitAt
      ? formatRelative(target.lastSuccessfulVisitAt)
      : '尚无成功记录';

    const nextCell = document.createElement('td');
    nextCell.textContent = target.scheduledOff
      ? target.scheduleNextStart
        ? `窗口开启 ${formatDateTime(target.scheduleNextStart)}`
        : '等待下一窗口'
      : formatDateTime(target.nextDue);

    const failureCell = document.createElement('td');
    failureCell.textContent = String(target.consecutiveFailures ?? 0);

    row.append(nameCell, statusCell, successCell, nextCell, failureCell);
    body.append(row);
  }
  table.append(head, body);
  elements.targets.replaceChildren(table);
}

function renderStats(stats) {
  const days = Array.isArray(stats?.last7Days) ? stats.last7Days : [];
  const totals = stats?.totals || {};
  if (days.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '暂无访问统计。';
    elements.statsBars.replaceChildren(empty);
    setText(elements.statsSummary, '暂无统计');
    return;
  }
  const max = Math.max(1, ...days.map((day) => Number(day.visits) || 0));
  const todayDate = days[days.length - 1]?.date;
  const fragment = document.createDocumentFragment();
  for (const day of days) {
    const visits = Number(day.visits) || 0;
    const failed = Number(day.failed) || 0;
    const bar = document.createElement('div');
    bar.className = 'stats-bar';
    bar.title = `${day.date}：${visits} 次访问，${failed} 次失败`;
    if (day.date === todayDate) bar.dataset.today = 'true';

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
  }
  elements.statsBars.replaceChildren(fragment);
  setText(
    elements.statsSummary,
    `累计 ${totals.visits ?? 0} 次 · 失败 ${totals.failed ?? 0} 次`,
  );
}

function render(data) {
  const summary = data.summary || {};
  setText(elements.updated, formatDateTime(data.generatedAt));
  setText(elements.targetCount, String(summary.totalTargets ?? 0));
  setText(elements.activeCount, String(summary.activeTargets ?? 0));
  setText(elements.issueCount, String(summary.issueCount ?? 0));
  setText(elements.keepOpenCount, String(summary.keepOpenTargets ?? 0));
  elements.hero.dataset.state = data.ready ? 'ok' : 'degraded';
  setText(elements.overall, data.ready ? '运行正常' : '需要关注');
  setText(
    elements.detail,
    data.ready
      ? `全部 ${summary.activeTargets ?? 0} 个活动目标都在保活窗口内。`
      : `${summary.issueCount ?? 0} 个目标未满足保活窗口，请查看管理控制台。`,
  );
  renderTargets(data.targets);
  renderStats(data.stats);
}

async function load() {
  try {
    const response = await fetch('/api/public-status', { cache: 'no-store' });
    if (response.status === 401 || response.status === 403) {
      throw new Error('状态页未公开。请在服务端设置 PUBLIC_STATUS=true，或使用管理控制台查看。');
    }
    if (!response.ok) throw new Error(`服务返回 HTTP ${response.status}`);
    const data = await response.json();
    elements.error.hidden = true;
    render(data);
    setConnection('online', '已连接');
  } catch (error) {
    setConnection('error', '连接失败');
    elements.error.hidden = false;
    elements.errorMessage.textContent =
      error instanceof Error ? error.message : String(error);
  }
}

load();
window.setInterval(() => {
  if (!document.hidden) void load();
}, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void load();
});
