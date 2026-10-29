'use strict';

/* ============================= 工具 ============================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const fmtMoney = (n) => { const v = Number(n || 0); return (v < 0 ? '-' : '') + '¥' + Math.abs(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 }); };
const fmtNum = (n) => Number(n || 0).toLocaleString('zh-CN');
const money2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const requestId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
function pendingKey(scope) { return `pms_pending_${state.user?.id || 'current'}_${scope}`; }
function restorePending(scope) {
  if (state[scope + 'Pending']) return;
  const raw = localStorage.getItem(pendingKey(scope));
  if (!raw) return;
  let pending;
  try { pending = JSON.parse(raw); } catch (_) { throw new Error('待确认业务记录损坏，请联系维护人员核对流水'); }
  if (!pending?.body?.request_id || typeof pending.signature !== 'string' || typeof pending.path !== 'string' || (scope === 'cashier' && pending.path !== '/api/orders') || (scope === 'checkin' && pending.path !== '/api/entries/checkin') || (scope === 'refund' && !/^\/api\/orders\/[^/]+\/refund$/.test(pending.path))) throw new Error('待确认业务记录无效，请联系维护人员核对流水');
  state[scope + 'Pending'] = pending;
  state[scope + 'RequestId'] = pending.body.request_id;
}
function pendingRequest(scope, body, path) {
  restorePending(scope);
  const signature = JSON.stringify(body);
  const pending = state[scope + 'Pending'];
  if (pending && (pending.signature !== signature || (path && pending.path !== path))) throw new Error('上一笔结果尚未确认，请点击页面顶部的恢复按钮');
  if (pending) return pending.body;
  const payload = { ...body, request_id: state[scope + 'RequestId'] || requestId(scope) };
  state[scope + 'RequestId'] = payload.request_id;
  const record = { signature, body: payload, path: path || (scope === 'checkin' ? '/api/entries/checkin' : '/api/orders'), created_at: new Date().toISOString() };
  // 持久化失败时禁止发送扣款请求；否则刷新后将失去原编号。
  localStorage.setItem(pendingKey(scope), JSON.stringify(record));
  state[scope + 'Pending'] = record;
  renderPendingRecovery();
  return payload;
}
function pendingSnapshot(scope) { return { key: pendingKey(scope), record: state[scope + 'Pending'] }; }
function clearPending(scope, error, snapshot = pendingSnapshot(scope)) {
  if (!error || [400, 422].includes(error.status)) {
    const id = snapshot.record?.body?.request_id;
    if (!id) return;
    // 旧请求迟到的响应只能清除自己的快照，不能删掉随后开始的新交易。
    const raw = localStorage.getItem(snapshot.key);
    let stored = null;
    try { stored = raw ? JSON.parse(raw) : null; } catch (_) { stored = null; }
    if (stored?.body?.request_id === id) localStorage.removeItem(snapshot.key);
    if (snapshot.key === pendingKey(scope) && state[scope + 'Pending']?.body?.request_id === id) {
      state[scope + 'Pending'] = null; state[scope + 'RequestId'] = null;
    }
    renderPendingRecovery();
  }
}
function renderPendingRecovery() {
  const el = $('#pendingRecovery');
  if (!el) return;
  const labels = { cashier: '收银', checkin: '核销', refund: '退款申请' };
  const scopes = ['cashier', 'checkin', 'refund'].filter(s => state[s + 'Pending'] || (state.corruptPendingScopes || []).includes(s));
  el.hidden = !scopes.length;
  el.innerHTML = scopes.map(s => {
    const record = state[s + 'Pending'];
    const corrupt = !record;
    const created = record?.created_at ? `（${new Date(record.created_at).toLocaleString('zh-CN')}）` : '';
    return `<div class="mb-8">${corrupt ? `待确认${labels[s]}记录损坏，请核对流水后放弃` : `有待确认${labels[s]}${created}，请先恢复原请求`}
      ${corrupt ? '' : `<button class="btn btn-outline" data-action="recoverPending" data-scope="${s}">恢复上一笔</button>`}
      <button class="btn btn-outline" data-action="discardPending" data-scope="${s}">核对后放弃</button></div>`;
  }).join('');
}
async function discardPending(el) {
  const scope = el.dataset.scope;
  if (!['cashier', 'checkin', 'refund'].includes(scope)) return;
  const message = '请先核对收银流水/核销记录，确认上一笔业务确实未执行。放弃后这条待确认记录会被删除。';
  const ok = typeof window.confirm === 'function' ? window.confirm(message) : true;
  if (!ok) return;
  localStorage.removeItem(pendingKey(scope));
  state[scope + 'Pending'] = null; state[scope + 'RequestId'] = null;
  state.corruptPendingScopes = (state.corruptPendingScopes || []).filter(s => s !== scope);
  renderPendingRecovery();
  toast('已放弃待确认记录，请核对流水');
}
async function recoverPending(el) {
  const scope = el.dataset.scope;
  if (!['cashier', 'checkin', 'refund'].includes(scope) || state.recovering || state[scope + 'Submitting']) return;
  const pending = state[scope + 'Pending'];
  if (!pending) return;
  const snapshot = pendingSnapshot(scope);
  state.recovering = true; el.disabled = true;
  try {
    await api(pending.path, { body: pending.body });
    clearPending(scope, undefined, snapshot); toast('上一笔业务结果已确认，请查看流水'); render(currentView());
  } catch (e) { clearPending(scope, e, snapshot); toast(e.message, 'error'); }
  finally { state.recovering = false; el.disabled = false; }
}

function debounce(fn, ms = 200) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function getToken() { return localStorage.getItem('pms_token') || ''; }
function setToken(t) {
  if (getToken() !== t) {
    for (const scope of ['cashier', 'checkin', 'refund']) { state[scope + 'Pending'] = null; state[scope + 'RequestId'] = null; }
    state.corruptPendingScopes = [];
    if (!t) { state.cardPage = 1; state.cardSearch = ''; }
  }
  t ? localStorage.setItem('pms_token', t) : localStorage.removeItem('pms_token');
}

const API_TIMEOUT_MS = 60000;
const AUTO_PAGE_LIMIT = 10;

async function api(path, opts = {}) {
  const method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');
  const init = { method, headers: {} };
  const token = getToken();
  if (token) init.headers['Authorization'] = 'Bearer ' + token;
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (controller) controller.abort(); }, opts.timeout || API_TIMEOUT_MS);
  let res, data = null, parsed = false;
  try {
    res = await fetch(path, controller ? { ...init, signal: controller.signal } : init);
    try {
      data = await res.json();
      parsed = true;
    } catch (err) {
      // 响应体读取被超时中止时，必须保留 AbortError，交给外层统一提示“请求超时”。
      if (err && err.name === 'AbortError') throw err;
      data = null;
    }
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? '请求超时，结果尚未确认，请恢复原请求' : '网络或响应异常，结果尚未确认，请恢复原请求');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 && path !== '/api/auth/login') {
    setToken(''); state.user = null; showLogin();
    throw new Error((data && data.error) || '未登录或登录已过期');
  }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `请求失败 (${res.status})`), { status: res.status });
  if (!parsed || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('响应格式异常，结果尚未确认，请恢复原请求');
  if (method === 'POST' && ((path === '/api/orders' && (!data.order?.id || !Number.isFinite(data.amount)))
    || (path === '/api/entries/checkin' && !data.card?.id)
    || (/^\/api\/orders\/[^/]+\/refund$/.test(path) && !data.refund?.id))) throw new Error('业务响应不完整，请恢复原请求确认结果');
  if (method === 'GET' && !/[?&]page=/.test(path) && Array.isArray(data.list) && data.has_more) {
    let page = data.page;
    let pages = 0;
    while (data.has_more && pages < AUTO_PAGE_LIMIT) {
      const next = await api(path + (path.includes('?') ? '&' : '?') + 'page=' + (++page), opts);
      data.list.push(...next.list); data.has_more = next.has_more; pages += 1;
    }
    if (data.has_more) {
      data.truncated = true;
      toast(`数据较多，仅加载前 ${data.list.length} 条，请使用筛选缩小范围`, 'error');
    }
  }
  return data;
}

/* ============================= 常量 ============================= */
const ROLE_LABEL = { admin: '超管', boss: '老板', frontdesk: '前台', finance: '财务' };
const CARD_TYPE_LABEL = { count: '次卡', month: '月卡', year: '年卡', stored: '储值卡' };
const CARD_STATUS_LABEL = { normal: '正常', frozen: '冻结', expired: '过期', void: '作废', refunded: '已退款' };
const MEMBER_STATUS_LABEL = { normal: '正常', blacklist: '黑名单', inactive: '停用' };
const ORDER_TYPE_LABEL = { open: '开卡', renew: '续费', recharge: '储值充值', refund: '退款' };
const ORDER_STATUS_LABEL = { pending: '待审批', paid: '已支付', partial_refund: '部分退款', refunded: '已退款', void: '已作废' };
const PAY_LABEL = { cash: '现金', wechat: '微信', alipay: '支付宝', stored: '储值' };
const GENDER = { male: '男', female: '女', unknown: '—' };
const ENTRY_CHARGE = { count: '次卡扣减', month: '月卡验证', year: '年卡验证', stored: '储值扣费' };

const cardTypeBadge = (t) => `<span class="badge badge-${({ count: 'green', month: 'amber', year: 'blue', stored: 'blue' }[t] || 'gray')}">${CARD_TYPE_LABEL[t] || t}</span>`;
const cardStatusBadge = (s) => `<span class="badge badge-${({ normal: 'green', frozen: 'amber', expired: 'red', void: 'gray', refunded: 'red' }[s] || 'gray')}">${CARD_STATUS_LABEL[s] || s}</span>`;
const memberStatusBadge = (s) => `<span class="badge badge-${({ normal: 'green', blacklist: 'red', inactive: 'gray' }[s] || 'gray')}">${MEMBER_STATUS_LABEL[s] || s}</span>`;
const orderStatusBadge = (s) => `<span class="badge badge-${({ pending: 'amber', paid: 'green', partial_refund: 'amber', refunded: 'red', void: 'gray' }[s] || 'gray')}">${ORDER_STATUS_LABEL[s] || s}</span>`;
const orderTypeBadge = (t) => `<span class="badge badge-${({ open: 'blue', renew: 'green', recharge: 'amber', refund: 'red' }[t] || 'gray')}">${ORDER_TYPE_LABEL[t] || t}</span>`;

const TITLES = {
  dashboard: '首页总览', members: '会员管理', 'card-products': '卡项管理', 'member-cards': '会员卡账户',
  checkin: '入场核销台', cashier: '收银台', orders: '收银流水', refunds: '退款审批',
  shifts: '交班对账', closings: '日结管理', reports: '报表中心', 'staff-performance': '员工绩效', staff: '员工权限', logs: '操作日志', settings: '系统设置', 'sms-settings': '短信通知配置'
};

const state = { settings: {}, user: null, corruptPendingScopes: [] };

/* ============================= 提示 / 模态框 ============================= */
let toastTimer;
function toast(msg, type = 'success') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function openModal(html, wide = false) {
  const box = $('#modalBox');
  box.innerHTML = html;
  box.classList.toggle('modal-wide', wide);
  $('#modalOverlay').hidden = false;
}
function closeModal() { $('#modalOverlay').hidden = true; $('#modalBox').innerHTML = ''; }

function payOptions(sel) {
  return ['cash', 'wechat', 'alipay', 'stored'].map((k) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${PAY_LABEL[k]}</option>`).join('');
}

function downloadCSV(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function downloadBase64(data, filename, mime = 'application/octet-stream') {
  const raw = atob(data); const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

/* ============================= 图表 ============================= */
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const d = v / p; const m = d <= 1 ? 1 : d <= 2 ? 2 : d <= 5 ? 5 : 10; return m * p; }
function compactNum(v) {
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
  if (v >= 10000) return (v / 10000).toFixed(v % 10000 ? 1 : 0) + '万';
  if (v >= 1000) return (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k';
  return String(Math.round(v * 100) / 100);
}
function barChart({ labels, series, height = 220, valueFormat = fmtMoney }) {
  const W = 760, L = 52, R = 12, T = 14, B = 30;
  const iw = W - L - R, ih = height - T - B;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const n = Math.max(labels.length, 1);
  let parts = '';
  for (let i = 0; i <= 4; i++) {
    const val = (max * i) / 4, y = T + ih - (val / max) * ih;
    parts += `<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" stroke="#eef1f6"/>`;
    parts += `<text x="${L - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#98a2b3">${compactNum(val)}</text>`;
  }
  const groupW = iw / n;
  const gap = 2, barW = Math.min(30, (groupW - 8) / series.length);
  series.forEach((s, si) => s.values.forEach((v, idx) => {
    if (v <= 0) return;
    const totalW = series.length * barW + (series.length - 1) * gap;
    const x = L + idx * groupW + groupW / 2 - totalW / 2 + si * (barW + gap);
    const h = (v / max) * ih, y = T + ih - h;
    parts += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${s.color}"><title>${esc(s.name)}：${valueFormat(v)}</title></rect>`;
  }));
  const step = Math.ceil(n / Math.floor(iw / 52));
  labels.forEach((lb, idx) => {
    if (idx % step !== 0 && idx !== n - 1) return;
    const x = L + idx * groupW + groupW / 2;
    parts += `<text x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="10" fill="#98a2b3">${esc(lb)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${height}" xmlns="http://www.w3.org/2000/svg">${parts}</svg>`;
}

/* ============================= 路由 / 视图 ============================= */
function currentView() { const h = location.hash.replace(/^#\//, ''); return TITLES[h] ? h : 'dashboard'; }

function switchView() {
  const v = currentView();
  // 隐藏菜单不是权限边界：按导航上的 data-roles 拦截 hash 直达，后端仍有最终校验。
  if (state.user) {
    const nav = $(`.nav-item[data-view="${v}"]`);
    const roles = nav && nav.dataset.roles ? nav.dataset.roles.split(',') : null;
    if (roles && state.user.role !== 'admin' && !roles.includes(state.user.role)) { location.hash = '#/dashboard'; return; }
  }
  $$('.view').forEach((el) => el.classList.remove('active'));
  const view = $('#view-' + v);
  if (view) view.classList.add('active');
  $('#pageTitle').textContent = TITLES[v];
  $$('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
  render(v);
  if (state.user) refreshRefundBadge();
}
window.addEventListener('hashchange', switchView);
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e && e.reason && e.reason.message) || '操作失败，请重试';
  try { toast(msg, 'error'); } catch (_) { /* 页面尚未初始化时忽略 */ }
});
window.addEventListener('focus', () => { if (state.user) refreshRefundBadge(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.user) refreshRefundBadge(); });

function render(v) {
  const fns = {
    dashboard: renderDashboard, members: renderMembers, 'card-products': renderCardProducts,
    'member-cards': renderMemberCards, checkin: renderCheckin, cashier: renderCashier,
    orders: renderOrders, refunds: renderRefunds, shifts: renderShifts, closings: renderClosings,
    reports: renderReports, 'staff-performance': renderStaffPerformance, staff: renderStaff, logs: renderLogs, settings: renderSettings, 'sms-settings': renderSmsSettings
  };
  if (!fns[v]) return;
  try {
    const result = fns[v]();
    if (result && typeof result.catch === 'function') result.catch((e) => viewFailed(v, e));
  } catch (e) {
    viewFailed(v, e);
  }
}
// 视图加载失败时给出可重试的占位，而不是永远停在“加载中…”。
function viewFailed(v, e) {
  const el = $('#view-' + v);
  if (!el) return;
  el.innerHTML = `<div class="card"><div class="card-title">加载失败</div><div class="hint">${esc((e && e.message) || '请求失败')}</div><button class="btn btn-primary mt-16" data-action="retryView" data-view="${esc(v)}">重试</button></div>`;
  toast((e && e.message) || '加载失败', 'error');
}

/* ============================= 登录 / 导航 ============================= */
function showApp() {
  state.corruptPendingScopes = [];
  for (const scope of ['cashier', 'checkin', 'refund']) {
    try { restorePending(scope); } catch (e) {
      if (!state.corruptPendingScopes.includes(scope)) state.corruptPendingScopes.push(scope);
      toast(e.message, 'error');
    }
  }
  renderPendingRecovery();
  $('#loginScreen').hidden = true; $('#app').hidden = false; applyBrand(); applyNav(); switchView(); checkShiftReminder(); refreshRefundBadge();
}
function showLogin() {
  closeModal();
  $('#app').hidden = true;
  $('#loginScreen').hidden = false;
  $('#loginStoreName').textContent = '请登录后开始使用';
  // 验证码一次性消费：退出或会话过期后必须换一张，否则第一次登录必然失败。
  loadCaptcha();
}
async function refreshRefundBadge() {
  const badge = $('#refundPendingBadge');
  if (!badge) return;
  const canApprove = ['boss', 'finance', 'admin'].includes(state.user?.role);
  if (!canApprove) { badge.hidden = true; return; }
  try {
    const d = await api('/api/refunds?status=pending');
    const count = Array.isArray(d.list) ? d.list.length : 0;
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
  } catch (_) { /* 网络短暂失败时保留页面，不打扰当前操作 */ }
}
function brandLogoHtml() {
  const s = state.settings;
  if (s.brand_logo_img) return `<img src="${esc(s.brand_logo_img)}" alt="">`;
  return esc(s.brand_icon || '🏊');
}
function applyLoginBrand() {
  const s = state.settings;
  const name = s.store_name || '游泳馆管理';
  $('#loginTitle').textContent = name;
  $('#loginLogo').innerHTML = brandLogoHtml();
  if (s.login_bg) {
    $('#loginScreen').style.background = `url(${s.login_bg}) center/cover no-repeat, linear-gradient(150deg,#0f2f5e 0%,#1e40af 45%,#2563eb 100%)`;
  } else {
    $('#loginScreen').style.background = '';
  }
  const items = [];
  if (s.icp_no) items.push(`<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">${esc(s.icp_no)}</a>`);
  if (s.public_security_no) items.push(`<span>${esc(s.public_security_no)}</span>`);
  $('#loginFooter').innerHTML = items.length ? items.join('　') : '<span>备案号待填写</span>';
}
function applyBrand() {
  const name = state.settings.store_name || '游泳馆管理';
  $('#brandName').textContent = name; $('#storeName').textContent = name;
  $('#brandLogo').innerHTML = brandLogoHtml();
  document.title = name + ' - 游泳池管理系统';
  applyLoginBrand();
}
function applyNav() {
  const role = state.user?.role;
  $$('.nav-item').forEach((el) => {
    const roles = el.dataset.roles ? el.dataset.roles.split(',') : null;
    el.style.display = (role === 'admin' || !roles || roles.includes(role)) ? '' : 'none';
  });
  const chip = $('#userChip');
  if (state.user) {
    chip.innerHTML = `<span class="badge ${role === 'boss' ? 'badge-amber' : role === 'finance' ? 'badge-blue' : 'badge-green'}">${ROLE_LABEL[role] || role}</span> <b>${esc(state.user.name)}</b>`;
  } else chip.innerHTML = '';
  const v = currentView();
  const el = $(`.nav-item[data-view="${v}"]`);
  if (el && el.style.display === 'none') location.hash = '#/dashboard';
}
let captchaInFlight = null;
function loadCaptcha() {
  // 启动/401/退出可能在同一时刻触发多次，合并成一次签发，避免 20 次/分钟额度被自己耗尽。
  if (captchaInFlight) return captchaInFlight;
  captchaInFlight = (async () => {
    try {
      const d = await api('/api/auth/captcha');
      state.captchaToken = d.captcha_token;
      $('#captchaImg').innerHTML = `<img src="${esc(d.image_path)}" alt="验证码">`;
    } catch (e) {
      toast('验证码获取失败，请稍后重试', 'error');
    } finally {
      captchaInFlight = null;
    }
  })();
  return captchaInFlight;
}
function loadRemembered() {
  const v = localStorage.getItem('pms_remember');
  if (!v) return;
  try {
    // 新版本只记账号；兼容读取旧数据时主动丢弃其中的密码。
    const raw = decodeURIComponent(escape(atob(v)));
    $('#loginUsername').value = raw.includes(':') ? raw.slice(0, raw.indexOf(':')) : raw;
    $('#rememberPwd').checked = true;
    if (raw.includes(':')) localStorage.setItem('pms_remember', btoa(unescape(encodeURIComponent($('#loginUsername').value))));
  } catch (e) { localStorage.removeItem('pms_remember'); }
}
function saveRemembered() {
  if ($('#rememberPwd').checked) {
    const u = $('#loginUsername').value;
    localStorage.setItem('pms_remember', btoa(unescape(encodeURIComponent(u))));
  } else {
    localStorage.removeItem('pms_remember');
  }
}
function bindLogin() {
  $('#captchaImg').addEventListener('click', loadCaptcha);
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#loginError'); err.hidden = true;
    try {
      const d = await api('/api/auth/login', { body: {
        username: $('#loginUsername').value, password: $('#loginPassword').value,
        captcha_token: state.captchaToken, captcha_code: $('#loginCaptcha').value
      } });
      saveRemembered();
      setToken(d.token); state.user = d.user;
      $('#loginPassword').value = ''; $('#loginCaptcha').value = '';
      await loadSettings(); showApp();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      loadCaptcha();
    }
  });
}
async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch (e) { /* ignore */ }
  setToken(''); state.user = null; showLogin();
}
async function loadSettings() {
  try { const d = await api('/api/settings'); state.settings = d.settings; state.settingsLoaded = true; } catch (e) { state.settingsLoaded = false; }
}

/* 登录后开班提醒 */
async function checkShiftReminder() {
  if (!['boss', 'frontdesk', 'admin'].includes(state.user?.role)) return;
  try {
    const d = await api('/api/shifts/current');
    if (!d.shift) {
      openModal(`
        <div class="modal-head"><h3>🕐 开始今日班次</h3><button class="modal-close" data-action="closeModal">×</button></div>
        <div class="modal-body">
          <p>当前还没有进行中的班次。开始班次后，收银与核销才会归入本班，交班时系统才能自动汇总营收与支付明细。</p>
        </div>
        <div class="modal-foot">
          <button class="btn" data-action="closeModal">稍后再说</button>
          <button class="btn btn-primary" data-action="startShiftFromReminder">开始班次</button>
        </div>`);
    }
  } catch (e) { /* ignore */ }
}
function startShiftFromReminder() { startShift(); }

/* ============================= 首页总览 ============================= */
async function renderDashboard() {
  const el = $('#view-dashboard');
  const dashboardBg = state.settings.dashboard_bg ? ` style="background-image:linear-gradient(180deg,rgba(8,30,70,.18),rgba(8,30,70,.68)),url('${esc(state.settings.dashboard_bg)}')"` : '';
  el.innerHTML = `<div class="hero"${dashboardBg}><h2>欢迎使用${esc(state.settings.store_name || '游泳馆管理')}系统</h2><p>纯会员制 · 今日营业概览</p></div>
    <div id="dashShiftBanner"></div>
    <div class="grid cols-4 mb-16" id="dashStats"><div class="card stat"><span class="stat-label">加载中…</span></div></div>
    <div class="grid cols-3 mb-16" id="dashRemind"></div>
    <div class="card"><div class="card-title" id="dashChartTitle">近 14 天收入趋势</div><div class="chart" id="dashChart"></div></div>`;
  try {
    const d = await api('/api/dashboard');
    const labels = d.recent.map((r) => r.date.slice(5));
    const canShift = ['boss', 'frontdesk', 'admin'].includes(state.user?.role);
    const canFinance = d.can_view_finance !== false;
    $('#dashShiftBanner').innerHTML = (!d.current_shift && canShift)
      ? `<div class="card mb-16" style="background:linear-gradient(135deg,rgba(245,158,11,.9),rgba(249,115,22,.85));color:#fff;border:none">
          <div class="flex-between"><div><b>今日班次尚未开始</b><div style="font-size:13px;opacity:.9">开始班次后收银与核销才会归入本班并自动汇总</div></div>
          <button class="btn btn-primary" data-action="startShiftFromReminder" style="background:#fff;color:#d97706">开始班次</button></div></div>`
      : '';
    const shiftCard = `<div class="card stat"><span class="stat-label">班次状态</span><span class="stat-value num" style="font-size:20px">${canShift ? (d.current_shift ? '进行中' : '未开班') : '无需开班'}</span></div>`;
    $('#dashStats').innerHTML = canFinance
      ? `<div class="card stat accent"><span class="stat-label">今日收入</span><span class="stat-value num">${fmtMoney(d.today_income)}</span></div>
        <div class="card stat"><span class="stat-label">今日开卡 / 续费 / 充值</span><span class="stat-value num" style="font-size:20px">${fmtMoney(d.today_open)} / ${fmtMoney(d.today_renew)} / ${fmtMoney(d.today_recharge)}</span></div>
        <div class="card stat"><span class="stat-label">今日退款 / 入场人次</span><span class="stat-value num" style="font-size:20px">${fmtMoney(d.today_refund)} / ${fmtNum(d.today_entries)}</span></div>
        ${shiftCard}`
      : `<div class="card stat accent"><span class="stat-label">今日入场人次</span><span class="stat-value num">${fmtNum(d.today_entries)}</span></div>
        <div class="card stat"><span class="stat-label">即将到期 / 余额不足 / 黑名单</span><span class="stat-value num" style="font-size:20px">${d.expiring_cards} / ${d.low_balance_members} / ${d.blacklist_count}</span></div>
        ${shiftCard}`;
    $('#dashRemind').innerHTML = canFinance ? `
      <div class="card"><div class="stat-label">即将到期会员卡</div><div class="stat-value num">${d.expiring_cards}</div><div class="stat-extra">近 7 天</div></div>
      <div class="card"><div class="stat-label">储值余额不足会员</div><div class="stat-value num">${d.low_balance_members}</div></div>
      <div class="card"><div class="stat-label">黑名单提醒</div><div class="stat-value num">${d.blacklist_count}</div></div>` : '';
    const chartTitle = $('#dashChartTitle');
    if (chartTitle) chartTitle.textContent = canFinance ? '近 14 天收入趋势' : '近 14 天入场趋势';
    $('#dashChart').innerHTML = canFinance
      ? barChart({ labels, series: [{ name: '收入', color: '#2563eb', values: d.recent.map((r) => r.income) }] })
      : barChart({ labels, series: [{ name: '入场人次', color: '#0ea5e9', values: d.recent.map((r) => r.entries) }], valueFormat: fmtNum });
  } catch (e) { toast(e.message, 'error'); }
}

/* ============================= 会员管理 ============================= */
async function refreshMembers() {
  const q = new URLSearchParams();
  if ($('#mSearch')?.value) q.set('search', $('#mSearch').value);
  if ($('#mStatus')?.value) q.set('status', $('#mStatus').value);
  try {
    const d = await api('/api/members?' + q.toString());
    const body = $('#membersBody');
    body.innerHTML = d.list.length ? d.list.map((m) => `<tr>
      <td class="num">${esc(m.member_no)}</td>
      <td><b>${esc(m.name)}</b>${m.gender && m.gender !== 'unknown' ? `<span class="badge badge-gray" style="margin-left:6px">${GENDER[m.gender]}</span>` : ''}</td>
      <td>${esc(m.phone || '—')}</td>
      <td>${(m.tags || []).map((t) => `<span class="badge badge-blue" style="margin-right:4px">${esc(t.tag_name)}</span>`).join('') || '—'}</td>
      <td>${memberStatusBadge(m.status)}</td>
      <td class="num">${m.card_count} 张</td>
      <td class="ops">
        <button class="btn btn-sm btn-outline" data-action="openMember" data-id="${m.id}">详情</button>
        <button class="btn btn-sm btn-outline" data-action="openMemberForm" data-id="${m.id}">编辑</button>
      </td></tr>`).join('') : `<tr><td colspan="7" class="empty">暂无会员</td></tr>`;
  } catch (e) { toast(e.message, 'error'); }
}
function renderMembers() {
  $('#view-members').innerHTML = `
    <div class="toolbar">
      <input class="input" id="mSearch" placeholder="姓名 / 会员号 / 手机号" style="width:240px" data-input="memberSearch">
      <select class="select" id="mStatus" data-change="memberSearch">
        <option value="">全部状态</option><option value="normal">正常</option><option value="blacklist">黑名单</option><option value="inactive">停用</option>
      </select>
      <div class="spacer"></div>
      ${state.user?.role === 'admin' ? '<button class="btn btn-outline" data-action="downloadMemberTemplate">下载 Excel 模板</button><button class="btn btn-primary" data-action="openMemberImport">导入会员</button>' : ''}
      <button class="btn btn-primary" data-action="openMemberForm">＋ 新增会员</button>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>会员号</th><th>姓名</th><th>手机号</th><th>标签</th><th>状态</th><th>卡数</th><th>操作</th></tr></thead>
      <tbody id="membersBody"></tbody></table></div></div>`;
  refreshMembers();
}

function openMemberImport() {
  state.memberImport = null;
  openModal(`<div class="modal-head"><h3>批量导入会员与会员卡</h3><button class="modal-close" data-action="closeModal">×</button></div>
    <div class="modal-body"><p class="hint">支持 CSV、XLSX，最多 5000 行、3MB。请使用系统模板；导入只创建历史会员和会员卡，不生成订单、支付、班次、营收或提成记录。</p>
    <div class="flex mb-16"><button class="btn btn-sm btn-outline" data-action="downloadMemberTemplate">下载 Excel 模板</button><button class="btn btn-sm btn-outline" data-action="downloadMemberCsvTemplate">下载 CSV 模板</button></div>
    <div class="field"><label>选择文件</label><input class="input" id="memberImportFile" type="file" accept=".csv,.xlsx" data-change="memberImportFile"></div>
    <div id="memberImportResult" class="mt-16"></div></div>
    <div class="modal-foot"><button class="btn" data-action="closeModal">取消</button><button class="btn btn-primary" id="memberImportCommit" data-action="commitMemberImport" disabled>确认导入</button></div>`, true);
}
function downloadMemberTemplate() {
  api('/api/members/import/template').then((d) => downloadBase64(d.data, d.filename, d.mime)).catch((e) => toast(e.message, 'error'));
}
function downloadMemberCsvTemplate() { api('/api/members/import/template?format=csv').then((d) => downloadBase64(d.data, d.filename, d.mime)).catch((e) => toast(e.message, 'error')); }
function memberImportFile(el) {
  const file = el.files && el.files[0]; if (!file) return;
  if (file.size > 3 * 1024 * 1024) { toast('文件不能超过 3MB', 'error'); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = String(reader.result).split(',').pop();
      const d = await api('/api/members/import/preview', { body: { filename: file.name, data }, timeout: 180000 });
      state.memberImport = { data, filename: file.name };
      const errors = d.errors || [];
      $('#memberImportResult').innerHTML = `<div class="hint">共 ${d.total} 行，${errors.length ? `<span class="badge badge-red">${errors.length} 行有错误</span>` : '<span class="badge badge-green">校验通过</span>'}</div>${errors.length ? `<div class="table-wrap mt-16"><table><thead><tr><th>行号</th><th>错误</th></tr></thead><tbody>${errors.map((x) => `<tr><td>${x.row}</td><td>${esc(x.message)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="table-wrap mt-16"><table><thead><tr><th>行</th><th>会员</th><th>手机号</th><th>卡项</th><th>处理方式</th></tr></thead><tbody>${(d.preview || []).slice(0, 100).map((x) => `<tr><td>${x.row}</td><td>${esc(x.name)}</td><td>${esc(x.phone || '—')}</td><td>${esc(x.card_name || '—')}</td><td>${esc(x.action)}</td></tr>`).join('')}</tbody></table></div>`}`;
      $('#memberImportCommit').disabled = !!errors.length;
    } catch (e) { toast(e.message, 'error'); }
  };
  reader.readAsDataURL(file);
}
async function commitMemberImport() {
  if (!state.memberImport) return;
  const button = $('#memberImportCommit'); if (button) { button.disabled = true; button.textContent = '正在导入…'; }
  try { const d = await api('/api/members/import/commit', { body: state.memberImport, timeout: 180000 }); toast(d.repeated ? '该文件已经导入过，未重复写入' : `已导入 ${d.members} 名会员、${d.cards} 张卡`); closeModal(); refreshMembers(); }
  catch (e) { toast(e.message, 'error'); }
  finally { if ($('#memberImportCommit')) { $('#memberImportCommit').disabled = false; $('#memberImportCommit').textContent = '确认导入'; } }
}

async function openMemberForm(id) {
  let m = null;
  if (id) { const d = await api('/api/members/' + id); m = d.member; }
  openModal(`
    <div class="modal-head"><h3>${m ? '编辑会员' : '新增会员'}</h3><button class="modal-close" data-action="closeModal">×</button></div>
    <div class="modal-body">
      <div class="form-row">
        <div class="field"><label>姓名 *</label><input class="input" id="mfName" value="${esc(m?.name || '')}"></div>
        <div class="field"><label>手机号</label><input class="input" id="mfPhone" value="${esc(m?.phone || '')}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>性别</label><select class="select" id="mfGender">
          <option value="unknown" ${m?.gender !== 'male' && m?.gender !== 'female' ? 'selected' : ''}>未知</option>
          <option value="male" ${m?.gender === 'male' ? 'selected' : ''}>男</option>
          <option value="female" ${m?.gender === 'female' ? 'selected' : ''}>女</option>
        </select></div>
        <div class="field"><label>生日</label><input class="input" type="date" id="mfBirthday" value="${m?.birthday || ''}"></div>
      </div>
      ${m ? `<div class="field"><label>状态</label><select class="select" id="mfStatus">
        <option value="normal" ${m.status === 'normal' ? 'selected' : ''}>正常</option>
        <option value="blacklist" ${m.status === 'blacklist' ? 'selected' : ''}>黑名单</option>
        <option value="inactive" ${m.status === 'inactive' ? 'selected' : ''}>停用</option>
      </select></div><div class="field"><label>状态变更原因</label><input class="input" id="mfReason" placeholder="黑名单/停用请填写原因"></div>` : ''}
      <div class="field"><label>备注</label><textarea class="textarea" id="mfNote">${esc(m?.note || '')}</textarea></div>
    </div>
    <div class="modal-foot"><button class="btn" data-action="closeModal">取消</button><button class="btn btn-primary" data-action="saveMember" data-id="${m?.id || ''}">保存</button></div>`);
}

async function saveMember(el) {
  if (el.disabled) return;
  el.disabled = true;
  const id = el.dataset.id;
  const body = { name: $('#mfName').value, phone: $('#mfPhone').value, gender: $('#mfGender').value, birthday: $('#mfBirthday').value, note: $('#mfNote').value };
  if ($('#mfStatus')) { body.status = $('#mfStatus').value; body.reason = $('#mfReason').value; }
  try {
    if (id) await api('/api/members/' + id, { method: 'PUT', body });
    else await api('/api/members', { body });
    toast('会员已保存'); closeModal(); refreshMembers();
  } catch (e) { el.disabled = false; toast(e.message, 'error'); }
}

/* ---------- 会员详情 ---------- */
async function openMember(id) {
  try {
    const d = await api('/api/members/' + id);
    const m = d.member;
    const isBoss = ['boss', 'admin'].includes(state.user?.role);
    openModal(`
      <div class="modal-head"><h3>会员详情 · ${esc(m.name)}</h3><button class="modal-close" data-action="closeModal">×</button></div>
      <div class="modal-body">
        <div class="flex-between mb-16">
          <div><b class="num">${esc(m.member_no)}</b> · ${esc(m.phone || '无电话')} · ${GENDER[m.gender]}</div>
          <div>${memberStatusBadge(m.status)}</div>
        </div>
        <div class="card-title">标签</div>
        <div class="flex mb-16" style="flex-wrap:wrap">
          ${(m.tags || []).map((t) => `<span class="badge badge-blue" style="margin-right:6px">${esc(t.tag_name)} <button style="border:none;background:none;cursor:pointer" data-action="removeTag" data-id="${m.id}" data-tag="${t.id}">×</button></span>`).join('') || '<span class="text-muted">无</span>'}
        </div>
        <div class="flex mb-16"><input class="input" id="tagInput" placeholder="新标签"><button class="btn btn-sm btn-outline" data-action="addTag" data-id="${m.id}">添加</button></div>
        <div class="card-title">会员卡账户</div>
        <div class="table-wrap mb-16"><table><thead><tr><th>卡号</th><th>卡项</th><th>类型</th><th>剩余/余额</th><th>有效期</th><th>状态</th>${isBoss ? '<th>操作</th>' : ''}</tr></thead>
        <tbody>${d.cards.length ? d.cards.map((c) => `<tr>
          <td class="num">${esc(c.card_no)}</td><td>${esc(c.card_name || '—')}</td><td>${cardTypeBadge(c.card_type)}</td>
          <td class="num">${c.card_type === 'stored' ? fmtMoney(c.balance) : (c.card_type === 'count' ? c.remaining_uses + ' 次' : '—')}</td>
          <td class="num">${c.end_at || '—'}</td><td>${cardStatusBadge(c.status)}</td>
          ${isBoss ? `<td class="ops">${c.status === 'frozen' ? `<button class="btn btn-sm btn-success" data-action="cardUnfreeze" data-id="${c.id}">解冻</button>` : `<button class="btn btn-sm btn-outline" data-action="cardFreeze" data-id="${c.id}">冻结</button>`}
          ${c.end_at ? `<button class="btn btn-sm btn-outline" data-action="cardExtend" data-id="${c.id}">延期</button>` : ''}
          <button class="btn btn-sm btn-outline" data-action="cardTransfer" data-id="${c.id}">转卡</button>
          <button class="btn btn-sm btn-danger" data-action="cardVoid" data-id="${c.id}">作废</button></td>` : ''}</tr>`).join('') : '<tr><td colspan="7" class="empty">暂无会员卡</td></tr>'}</tbody></table></div>
        <div class="card-title">最近入场</div>
        <div class="table-wrap mb-16"><table><thead><tr><th>时间</th><th>方式</th><th>扣减</th><th>结果</th></tr></thead>
        <tbody>${d.entries.length ? d.entries.map((e) => `<tr><td class="num">${esc((e.entry_at || '').replace('T', ' ').slice(0, 16))}</td><td>${ENTRY_CHARGE[e.charge_type] || '—'}</td><td class="num">${e.deducted_uses ? e.deducted_uses + ' 次' : e.deducted_amount ? fmtMoney(e.deducted_amount) : '—'}</td><td>${e.result === 'success' ? '<span class="badge badge-green">成功</span>' : '<span class="badge badge-red">失败</span>'}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">暂无</td></tr>'}</tbody></table></div>
        <div class="card-title">最近订单</div>
        <div class="table-wrap"><table><thead><tr><th>单号</th><th>类型</th><th>实付</th><th>状态</th></tr></thead>
        <tbody>${d.orders.length ? d.orders.map((o) => `<tr><td class="num">${esc(o.order_no)}</td><td>${orderTypeBadge(o.order_type)}</td><td class="num">${fmtMoney(o.order_type === 'refund' ? (o.status === 'paid' ? -o.total_amount : 0) : o.paid_amount)}</td><td>${orderStatusBadge(o.status)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">暂无</td></tr>'}</tbody></table></div>
      </div>
      <div class="modal-foot"><button class="btn" data-action="closeModal">关闭</button></div>`, true);
  } catch (e) { toast(e.message, 'error'); }
}

async function addTag(el) { try { await api(`/api/members/${el.dataset.id}/tags`, { body: { tag_name: $('#tagInput').value } }); toast('已添加'); openMember(el.dataset.id); } catch (e) { toast(e.message, 'error'); } }
async function removeTag(el) { try { await api(`/api/members/${el.dataset.id}/tags/${el.dataset.tag}`, { method: 'DELETE' }); toast('已删除'); openMember(el.dataset.id); } catch (e) { toast(e.message, 'error'); } }

/* ============================= 卡项管理 ============================= */
async function renderCardProducts() {
  const d = await api('/api/card-products');
  $('#view-card-products').innerHTML = `
    <div class="toolbar"><div class="spacer"></div><button class="btn btn-primary" data-action="openProductForm">＋ 新增卡项</button></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>名称</th><th>类型</th><th>售价</th><th>有效期(天)</th><th>次数/储值</th><th>入场扣费</th><th>冻结/转卡/延期</th><th>启用</th><th>操作</th></tr></thead>
      <tbody>${d.list.map((p) => `<tr>
        <td><b>${esc(p.name)}</b></td><td>${cardTypeBadge(p.type)}</td><td class="num">${fmtMoney(p.price)}</td>
        <td class="num">${p.duration_days || '不限'}</td>
        <td class="num">${p.type === 'count' ? p.total_uses + ' 次' : p.type === 'stored' ? fmtMoney(p.stored_value) : '—'}</td>
        <td class="num">${p.type === 'stored' ? fmtMoney(p.entry_fee) : '—'}</td>
        <td>${p.freeze_allowed ? '✓' : '—'} / ${p.transfer_allowed ? '✓' : '—'} / ${p.extension_allowed ? '✓' : '—'}</td>
        <td>${p.enabled ? '<span class="badge badge-green">启用</span>' : '<span class="badge badge-gray">停用</span>'}</td>
        <td class="ops"><button class="btn btn-sm btn-outline" data-action="openProductForm" data-id="${p.id}">编辑</button>
        ${p.enabled ? `<button class="btn btn-sm btn-danger" data-action="toggleProduct" data-id="${p.id}">停用</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div></div>`;
}

async function openProductForm(id) {
  let p = null;
  if (id) { const d = await api('/api/card-products'); p = d.list.find((x) => String(x.id) === String(id)); }
  openModal(`
    <div class="modal-head"><h3>${p ? '编辑卡项' : '新增卡项'}</h3><button class="modal-close" data-action="closeModal">×</button></div>
    <div class="modal-body">
      <div class="form-row">
        <div class="field"><label>名称 *</label><input class="input" id="pfName" value="${esc(p?.name || '')}"></div>
        <div class="field"><label>类型 *</label><select class="select" id="pfType">
          ${['count', 'month', 'year', 'stored'].map((t) => `<option value="${t}" ${p?.type === t ? 'selected' : ''}>${CARD_TYPE_LABEL[t]}</option>`).join('')}
        </select></div>
      </div>
      <div class="form-row">
        <div class="field"><label>售价（元）</label><input class="input" type="number" step="0.01" id="pfPrice" value="${p?.price ?? 0}"></div>
        <div class="field"><label>有效期天数（0=不限）</label><input class="input" type="number" id="pfDuration" value="${p?.duration_days ?? 0}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>总次数（次卡）</label><input class="input" type="number" id="pfUses" value="${p?.total_uses ?? 0}"></div>
        <div class="field"><label>储值金额（储值卡）</label><input class="input" type="number" step="0.01" id="pfStored" value="${p?.stored_value ?? 0}"></div>
      </div>
      <div class="field"><label>储值卡单次入场扣费</label><input class="input" type="number" step="0.01" id="pfEntryFee" value="${p?.entry_fee ?? 0}"></div>
      <div class="flex" style="gap:16px">
        <label><input type="checkbox" id="pfFreeze" ${p?.freeze_allowed ? 'checked' : ''}> 允许冻结</label>
        <label><input type="checkbox" id="pfTransfer" ${p?.transfer_allowed ? 'checked' : ''}> 允许转卡</label>
        <label><input type="checkbox" id="pfExtension" ${p?.extension_allowed ? 'checked' : ''}> 允许延期</label>
        <label><input type="checkbox" id="pfEnabled" ${p?.enabled !== 0 ? 'checked' : ''}> 启用</label>
      </div>
      <div class="field mt-16"><label>备注</label><input class="input" id="pfNote" value="${esc(p?.note || '')}"></div>
    </div>
    <div class="modal-foot"><button class="btn" data-action="closeModal">取消</button><button class="btn btn-primary" data-action="saveProduct" data-id="${p?.id || ''}">保存</button></div>`);
}

async function saveProduct(el) {
  if (el.disabled) return;
  el.disabled = true;
  const body = {
    name: $('#pfName').value, type: $('#pfType').value, price: $('#pfPrice').value, duration_days: $('#pfDuration').value,
    total_uses: $('#pfUses').value, stored_value: $('#pfStored').value, entry_fee: $('#pfEntryFee').value,
    freeze_allowed: $('#pfFreeze').checked, transfer_allowed: $('#pfTransfer').checked, extension_allowed: $('#pfExtension').checked,
    enabled: $('#pfEnabled').checked, note: $('#pfNote').value
  };
  try {
    if (el.dataset.id) await api('/api/card-products/' + el.dataset.id, { method: 'PUT', body });
    else await api('/api/card-products', { body });
    toast('卡项已保存'); closeModal(); renderCardProducts();
  } catch (e) { el.disabled = false; toast(e.message, 'error'); }
}
async function toggleProduct(el) {
  if (el.disabled) return; el.disabled = true;
  try { await api('/api/card-products/' + el.dataset.id, { method: 'DELETE' }); toast('已停用'); renderCardProducts(); } catch (e) { el.disabled = false; toast(e.message, 'error'); }
}

/* ============================= 会员卡账户 ============================= */
async function renderMemberCards() {
  const version = state.cardPageVersion = (state.cardPageVersion || 0) + 1;
  const q = new URLSearchParams({ page: state.cardPage || 1, page_size: 100 });
  if (state.cardSearch) q.set('search', state.cardSearch);
  const d = await api('/api/member-cards?' + q.toString());
  if (version !== state.cardPageVersion) return;
  const isBoss = ['boss', 'admin'].includes(state.user?.role);
  $('#view-member-cards').innerHTML = `
    <div class="toolbar"><input class="input" id="mcSearch" value="${esc(state.cardSearch || '')}" placeholder="卡号 / 姓名 / 会员号 / 手机号">
      <button class="btn btn-primary" data-action="searchMemberCards">搜索</button>
      <span>共 ${d.total} 张 · 第 ${d.page} 页</span>
      <button class="btn" data-action="memberCardsPage" data-page="${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>上一页</button>
      <button class="btn" data-action="memberCardsPage" data-page="${d.page + 1}" ${!d.has_more ? 'disabled' : ''}>下一页</button></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>卡号</th><th>会员</th><th>卡项</th><th>类型</th><th>剩余/余额</th><th>有效期</th><th>状态</th>${isBoss ? '<th>操作</th>' : ''}</tr></thead>
      <tbody>${d.list.map((c) => `<tr>
        <td class="num">${esc(c.card_no)}</td><td>${esc(c.member_name)}（${esc(c.member_no)}）</td><td>${esc(c.card_name || '—')}</td><td>${cardTypeBadge(c.card_type)}</td>
        <td class="num">${c.card_type === 'stored' ? fmtMoney(c.balance) : c.card_type === 'count' ? c.remaining_uses + ' 次' : '—'}</td>
        <td class="num">${c.end_at || '—'}</td><td>${cardStatusBadge(c.status)}</td>
        ${isBoss ? `<td class="ops">
          ${c.status === 'frozen' ? `<button class="btn btn-sm btn-success" data-action="cardUnfreeze" data-id="${c.id}">解冻</button>` : `<button class="btn btn-sm btn-outline" data-action="cardFreeze" data-id="${c.id}">冻结</button>`}
          ${c.end_at ? `<button class="btn btn-sm btn-outline" data-action="cardExtend" data-id="${c.id}">延期</button>` : ''}
          <button class="btn btn-sm btn-outline" data-action="cardTransfer" data-id="${c.id}">转卡</button>
          <button class="btn btn-sm btn-danger" data-action="cardVoid" data-id="${c.id}">作废</button>
        </td>` : ''}
      </tr>`).join('') || `<tr><td colspan="${isBoss ? 9 : 8}" class="empty">暂无会员卡</td></tr>`}</tbody></table></div></div>`;
}

async function searchMemberCards() {
  state.cardSearch = $('#mcSearch').value.trim(); state.cardPage = 1;
  try { await renderMemberCards(); } catch (e) { toast(e.message, 'error'); }
}
async function memberCardsPage(el) {
  if (el.disabled) return;
  const page = Number(el.dataset.page);
  if (!Number.isInteger(page) || page < 1) return;
  state.cardPage = page;
  try { await renderMemberCards(); } catch (e) { toast(e.message, 'error'); }
}

function cardPrompt(title, fieldHtml, action, id) {
  openModal(`
    <div class="modal-head"><h3>${title}</h3><button class="modal-close" data-action="closeModal">×</button></div>
    <div class="modal-body">${fieldHtml}<div class="field"><label>原因</label><input class="input" id="cardReason" placeholder="请填写原因"></div></div>
    <div class="modal-foot"><button class="btn" data-action="closeModal">取消</button><button class="btn btn-primary" data-action="${action}" data-id="${id}">确定</button></div>`);
}
function cardFreeze(el) { cardPrompt('冻结会员卡', `<div class="field"><label>冻结截止时间</label><input class="input" type="date" id="cardFrozenUntil"></div>`, 'confirmCardFreeze', el.dataset.id); }
async function confirmCardFreeze(el) {
  if (el.disabled) return; el.disabled = true;
  try { await api(`/api/member-cards/${el.dataset.id}/freeze`, { body: { frozen_until: $('#cardFrozenUntil').value, reason: $('#cardReason').value } }); toast('已冻结'); closeModal(); renderMemberCards(); } catch (e) { el.disabled = false; toast(e.message, 'error'); }
}
async function cardUnfreeze(el) {
  if (el.disabled) return; el.disabled = true;
  try { await api(`/api/member-cards/${el.dataset.id}/unfreeze`, { body: {} }); toast('已解冻'); renderMemberCards(); } catch (e) { el.disabled = false; toast(e.message, 'error'); }
}
function cardExtend(el) { cardPrompt('会员卡延期', `<div class="field"><label>延期天数</label><input class="input" type="number" id="cardDays" value="30"></div>`, 'confirmCardExtend', el.dataset.id); }
async function confirmCardExtend(el) {
  if (el.disabled) return; el.disabled = true;
  try { await api(`/api/member-cards/${el.dataset.id}/extend`, { body: { days: Number($('#cardDays').value), reason: $('#cardReason').value } }); toast('已延期'); closeModal(); renderMemberCards(); } catch (e) { el.disabled = false; toast(e.message, 'error'); }
}
function cardTransfer(el) { cardPrompt('转卡', `<div class="field"><label>接收会员ID</label><input class="input" type="number" id="cardToMember" placeholder="输入会员ID"></div>`, 'confirmCardTransfer', el.dataset.id); }
async function confirmCardTransfer(el) {
  if (el.disabled) return; el.disabled = true;
  try { await api(`/api/member-cards/${el.dataset.id}/transfer`, { body: { to_member_id: Number($('#cardToMember').value), reason: $('#cardReason').value } }); toast('已转卡'); closeModal(); renderMemberCards(); } catch (e) { el.disabled = false; toast(e.message, 'error'); }
}
function cardVoid(el) { cardPrompt('作废会员卡', `<p class="text-muted">作废后该卡不可入场，且不可恢复；储值卡有余额时需先退款或转卡。</p>`, 'confirmCardVoid', el.dataset.id); }
async function confirmCardVoid(el) {
  if (el.disabled) return; el.disabled = true;
  try { await api(`/api/member-cards/${el.dataset.id}/void`, { body: { reason: $('#cardReason').value } }); toast('已作废'); closeModal(); renderMemberCards(); } catch (e) { el.disabled = false; toast(e.message, 'error'); }
}

/* ============================= 入场核销台 ============================= */
function renderCheckin() {
  $('#view-checkin').innerHTML = `
    <div class="card mb-16">
      <div class="card-title">入场核销</div>
      <div class="form-row">
        <div class="field"><label>卡号 / 手机号 / 会员编号</label><input class="input" id="ckKeyword" placeholder="输入后回车核销"></div>
        <div class="field"><label>通道号</label><input class="input" id="ckGate" value="前台"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>入场人数（次卡、储值卡按人头扣费）</label><input class="input" type="number" id="ckPeople" value="1" min="1" max="100" step="1"><div>月卡、年卡仅限持卡会员本人 1 人使用，核销前请核对本人身份。</div></div>
        <div class="field"><label>&nbsp;</label><button class="btn btn-primary btn-block" data-action="doCheckin">核销入场</button></div>
      </div>
    </div>
    <div class="card"><div class="card-title">会员核对</div><div id="ckResult"><span class="text-muted">输入关键词后点击查询，核对会员信息后再确认扣减</span></div></div>`;
  $('#ckKeyword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doCheckin(); });
  state.checkinPreview = null;
  ['#ckKeyword', '#ckPeople', '#ckGate'].forEach(s => $(s).addEventListener('input', () => {
    state.checkinPreview = null;
    state.checkinPreviewVersion = (state.checkinPreviewVersion || 0) + 1;
    $('#ckResult').textContent = state.checkinPending
      ? '上一笔核销结果未确认，请先重试上一笔核销'
      : '查询条件已改变，请重新查询并确认';
  }));
}
async function doCheckin() {
  if (state.checkinSubmitting) return;
  if (state.checkinPending) {
    const p = state.checkinPending.body;
    const keyword = ($('#ckKeyword')?.value || '').trim();
    const people = Number($('#ckPeople')?.value) || 1;
    const gate = $('#ckGate')?.value || '';
    // 上一笔结果未知时不能直接给另一位会员扣费，否则可能重复扣减；先让营业员显式重试。
    if (p.keyword !== keyword || Number(p.people) !== people || String(p.gate_no || '') !== gate) {
      $('#ckResult').innerHTML = `<div class="badge badge-red">上一笔核销结果未确认</div>
        <div class="hint mt-8">请先重试上一笔核销，确认扣减结果后再为其他会员办理，避免重复扣减。</div>
        <button class="btn btn-primary mt-16" data-action="retryCheckin">重试上一笔核销</button>`;
      toast('上一笔核销结果未确认，请先重试', 'error');
      return;
    }
    const { request_id, confirmed, ...snapshot } = state.checkinPending.body;
    state.checkinPreview = snapshot;
    toast('正在重试确认上一笔核销结果');
    return confirmCheckin({ disabled: false });
  }
  const version = state.checkinPreviewVersion = (state.checkinPreviewVersion || 0) + 1;
  state.checkinPreview = null;
  $('#ckResult').textContent = '查询中…';
  const body = { keyword: $('#ckKeyword').value, gate_no: $('#ckGate').value, people: Number($('#ckPeople').value) || 1 };
  try {
    const d = await api('/api/entries/preview?keyword=' + encodeURIComponent(body.keyword) + '&people=' + body.people);
    if (version !== state.checkinPreviewVersion) return;
    const c = d.card;
    state.checkinPreview = { ...body, people: c.people, card_id: c.id };
    $('#ckResult').innerHTML = `<div class="flex-between mb-16">
      <div><h2 style="margin:0">${esc(d.member.name)}</h2><span class="text-muted">${esc(d.member.member_no)} · ${esc(d.member.phone || '')}</span></div>
      <span class="badge badge-blue">待确认</span></div>
      <div class="grid cols-4">
        <div class="card stat"><span class="stat-label">卡项</span><span class="stat-value num" style="font-size:18px">${esc(c.card_name || '')}</span></div>
        <div class="card stat"><span class="stat-label">本次扣次数</span><span class="stat-value num">${c.preview_deducted_uses || 0}</span></div>
        <div class="card stat"><span class="stat-label">本次扣金额</span><span class="stat-value num">${fmtMoney(c.preview_deducted_amount)}</span></div>
        <div class="card stat"><span class="stat-label">有效期</span><span class="stat-value num" style="font-size:18px">${c.end_at || '—'}</span></div>
      </div><div class="mt-16"><button class="btn btn-primary" data-action="confirmCheckin" data-keyword="${esc(body.keyword)}" data-card="${c.id}">确认核销并扣减</button></div>`;
    state.checkinRequestId = requestId('checkin');
    toast('请核对会员信息');
  } catch (e) { if (version === state.checkinPreviewVersion) { state.checkinPreview = null; $('#ckResult').innerHTML = `<span class="badge badge-red">${esc(e.message)}</span>`; } }
}
async function confirmCheckin(el) {
  if (state.checkinSubmitting || !state.checkinPreview) return;
  const snapshot = { ...state.checkinPreview };
  let pending;
  state.checkinSubmitting = true; el.disabled = true;
  try {
    const body = pendingRequest('checkin', { ...snapshot, confirmed: true });
    pending = pendingSnapshot('checkin');
    await api('/api/entries/checkin', { body });
    clearPending('checkin', undefined, pending);
    state.checkinPreview = null; state.checkinRequestId = null; $('#ckResult').innerHTML = '<span class="badge badge-green">核销成功，权益已扣减</span>'; toast('核销成功');
  } catch (e) { clearPending('checkin', e, pending); toast(e.message, 'error'); el.disabled = false; }
  finally { state.checkinSubmitting = false; }
}
async function retryCheckin() {
  if (!state.checkinPending) return;
  const { request_id, confirmed, ...snapshot } = state.checkinPending.body;
  state.checkinPreview = snapshot;
  return confirmCheckin({ disabled: false });
}

/* ============================= 收银台 ============================= */
function renderCashier() {
  $('#view-cashier').innerHTML = `
    <div class="toolbar">
      <div class="sale-tabs" style="margin:0">
        <button class="sale-tab active" data-action="cashierTab" data-tab="open">开卡</button>
        <button class="sale-tab" data-action="cashierTab" data-tab="renew">续费</button>
        <button class="sale-tab" data-action="cashierTab" data-tab="recharge">储值充值</button>
      </div>
      <div class="spacer"></div>
      <button class="btn btn-outline" data-action="toggleCashierFullscreen" id="cashierFsBtn">⛶ 全屏收银</button>
    </div>
    <div id="cashierForm"></div>`;
  renderCashierForm('open');
}

async function renderCashierForm(tab) {
  state.cashierTab = tab;
  state.cashierMember = null;
  state.cashierNewMember = tab === 'open';
  if (!state.payMethod) state.payMethod = 'cash';
  state.storedPaymentCards = [];
  $$('.sale-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const wrap = $('#cashierForm');
  const products = (await api('/api/card-products')).list.filter((p) => p.enabled);
  state.members = []; state.products = products;
  wrap.innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <div class="card-title">会员与卡项</div>
        ${tab === 'open' ? '<div class="sale-tabs mb-16"><button class="sale-tab active" id="csNewMemberTab" data-action="cashierNewMember">新建会员</button><button class="sale-tab" id="csExistingMemberTab" data-action="cashierExistingMember">已有会员</button></div>' : ''}
        <div id="csExistingMember"${state.cashierNewMember ? ' hidden' : ''}><div class="field"><label>查询已有会员</label><input class="input" id="csMemberSearch" data-input="cashierMemberSearch" placeholder="输入姓名、手机号或会员编号查询"><div id="csMemberResults" class="search-results"></div><div id="csMemberSelected" class="text-muted mt-8"></div></div></div>
        <div id="csNewMember"${state.cashierNewMember ? '' : ' hidden'}>
          <div class="form-row">
            <div class="field"><label>姓名 *</label><input class="input" id="csName"></div>
            <div class="field"><label>手机号</label><input class="input" id="csPhone"></div>
          </div>
          <div class="field"><label>性别</label><select class="select" id="csGender"><option value="unknown">未知</option><option value="male">男</option><option value="female">女</option></select></div>
        </div>
        ${tab === 'open' ? `<div class="field"><label>选择卡项</label><select class="select" id="csProduct" data-change="cashierAmount">${products.map((p) => `<option value="${p.id}">${esc(p.name)} · ${fmtMoney(p.price)}</option>`).join('')}</select></div>` : ''}
        ${tab === 'renew' ? `<div class="field"><label>选择会员卡</label><select class="select" id="csCard" data-change="cashierRenewCard"></select></div><div class="field"><label>选择续费卡项（同卡种）</label><select class="select" id="csProduct" data-change="cashierAmount"></select></div>` : ''}
        ${tab === 'recharge' ? `<div class="field"><label>选择储值卡</label><select class="select" id="csCard"></select></div><div class="field"><label>充值金额（元）</label><input class="input" type="number" step="0.01" id="csAmount" value="100" data-input="cashierAmount"></div>` : ''}
        <div class="field"><label>优惠金额（元）</label><input class="input" type="number" step="0.01" id="csDiscount" value="0" data-input="cashierAmount"></div>
      </div>
      <div class="card">
        <div class="card-title">收款</div>
        <div class="field"><label>支付方式</label>
          <div class="pos-pays">
            <button class="pos-pay ${state.payMethod === 'cash' ? 'active' : ''}" data-action="pickPayMethod" data-pay="cash">现金</button>
            <button class="pos-pay ${state.payMethod === 'wechat' ? 'active' : ''}" data-action="pickPayMethod" data-pay="wechat">微信</button>
            <button class="pos-pay ${state.payMethod === 'alipay' ? 'active' : ''}" data-action="pickPayMethod" data-pay="alipay">支付宝</button>
            <button class="pos-pay ${state.payMethod === 'stored' ? 'active' : ''}" data-action="pickPayMethod" data-pay="stored">储值</button>
          </div>
        </div>
        <div class="flex-between"><span class="text-muted">应收金额（自动）</span><b class="num" id="csPayable" style="font-size:22px">¥0</b></div>
        <div class="field mt-16"><label>实收金额（自动，等于应收；抹零请填优惠金额）</label><input class="input" type="number" step="0.01" id="csPayAmount" readonly style="font-size:22px;font-weight:700;background:#f8fafc"></div>
        <div class="field"><label><input type="checkbox" id="csMixed" data-change="toggleMixedPay"> 混合支付</label></div>
        <div id="csMixedRows" hidden>${['cash', 'wechat', 'alipay', 'stored'].map(method => `<div class="field"><label>${PAY_LABEL[method]}金额（不用填 0）</label><input class="input cs-split" data-method="${method}" type="number" min="0" step="0.01" value="0"></div>`).join('')}</div>
        <div class="field"><label>储值支付来源</label><select class="select" id="csStoredSource"><option value="">自动选择可用储值卡</option></select></div>
        <button class="btn btn-primary btn-block mt-16" data-action="submitCashier">确认收款</button>
      </div>
    </div>`;
  cashierMemberPick();
  updateCashierTotal();
}

function cashierPayable() {
  const tab = state.cashierTab;
  let total = 0;
  if (tab === 'open' || tab === 'renew') {
    const pid = $('#csProduct')?.value;
    const p = (state.products || []).find((x) => String(x.id) === String(pid));
    total = p ? Number(p.price) : 0;
  } else total = Number($('#csAmount')?.value) || 0;
  const discount = Number($('#csDiscount')?.value) || 0;
  return money2(Math.max(0, total - discount));
}
function pickPayMethod(el) {
  state.payMethod = el.dataset.pay;
  $$('#view-cashier .pos-pay').forEach((b) => b.classList.toggle('active', b.dataset.pay === state.payMethod));
}
function toggleMixedPay() { $('#csMixedRows').hidden = !$('#csMixed').checked; }
async function loadStoredPaymentCards(memberId) {
  const d = await api('/api/member-cards?member_id=' + memberId);
  if (Number(state.cashierMember?.id) !== Number(memberId)) return;
  state.storedPaymentCards = d.list.filter(c => c.card_type === 'stored' && c.status === 'normal' && (!c.start_at || c.start_at <= todayStr()));
  const sel = $('#csStoredSource');
  if (sel) sel.innerHTML = '<option value="">自动选择可用储值卡</option>' + state.storedPaymentCards.map(c => `<option value="${c.id}">${esc(c.card_no)} · ${fmtMoney(c.balance)}</option>`).join('');
}

function cashierMemberPick() {
  const nm = $('#csNewMember');
  if (nm) nm.hidden = !state.cashierNewMember;
  const em = $('#csExistingMember');
  if (em) em.hidden = state.cashierNewMember;
  $('#csNewMemberTab')?.classList.toggle('active', state.cashierNewMember);
  $('#csExistingMemberTab')?.classList.toggle('active', !state.cashierNewMember);
}
const cashierMemberSearchDebounced = debounce(searchCashierMembers, 250);
async function searchCashierMembers() {
  const q = $('#csMemberSearch')?.value.trim();
  const result = $('#csMemberResults');
  if (!result) return;
  if (!q) { result.innerHTML = ''; return; }
  try {
    const d = await api('/api/members?status=normal&search=' + encodeURIComponent(q));
    if ($('#csMemberSearch') !== null && $('#csMemberSearch').value.trim() !== q) return;
    state.members = d.list;
    result.innerHTML = d.list.slice(0, 20).map((m) => `<button class="search-result" data-action="cashierPickMember" data-id="${m.id}">${esc(m.name)} <span>${esc(m.member_no)} · ${esc(m.phone || '')}</span></button>`).join('') || '<div class="text-muted mt-8">未找到匹配会员</div>';
  } catch (e) { if ($('#csMemberSearch')?.value.trim() === q) result.innerHTML = `<div class="text-danger mt-8">${esc(e.message)}</div>`; }
}
function cashierMemberSearch() {
  state.cashierMember = null; state.members = []; state.storedPaymentCards = [];
  if ($('#csCard')) $('#csCard').innerHTML = '<option value="">请先选择会员</option>';
  if ($('#csStoredSource')) $('#csStoredSource').innerHTML = '<option value="">自动选择可用储值卡</option>';
  if ($('#csMemberSelected')) $('#csMemberSelected').textContent = '';
  if ($('#csMemberResults')) $('#csMemberResults').innerHTML = '';
  cashierMemberSearchDebounced();
}
function cashierPickMember(el) {
  const m = (state.members || []).find((x) => Number(x.id) === Number(el.dataset.id));
  // 搜索结果未缓存时，直接从按钮文本外的接口数据重新读取，避免依赖全量会员列表。
  if (!m) return;
  state.cashierMember = m;
  state.cashierNewMember = false;
  $('#csMemberSearch').value = `${m.member_no} · ${m.name}`;
  $('#csMemberResults').innerHTML = '';
  $('#csMemberSelected').textContent = `已选择：${m.name}（${m.member_no}）`;
  cashierMemberPick();
  loadStoredPaymentCards(m.id).catch(e => toast(e.message, 'error'));
  if (['renew', 'recharge'].includes(state.cashierTab)) loadMemberCards(m.id);
}
function cashierNewMember() {
  state.cashierMember = null;
  state.cashierNewMember = true;
  if ($('#csStoredSource')) $('#csStoredSource').innerHTML = '<option value="">自动选择可用储值卡</option>';
  if ($('#csMemberSearch')) $('#csMemberSearch').value = '';
  if ($('#csMemberResults')) $('#csMemberResults').innerHTML = '';
  if ($('#csMemberSelected')) $('#csMemberSelected').textContent = '将创建新会员';
  cashierMemberPick();
}
function cashierExistingMember() {
  state.cashierMember = null;
  state.cashierNewMember = false;
  // 隐藏的“新建会员”字段必须清空，否则会被当成未选会员时的姓名提交。
  if ($('#csName')) $('#csName').value = '';
  if ($('#csPhone')) $('#csPhone').value = '';
  if ($('#csStoredSource')) $('#csStoredSource').innerHTML = '<option value="">自动选择可用储值卡</option>';
  cashierMemberPick();
  $('#csMemberSearch')?.focus();
}
async function loadMemberCards(memberId) {
  const tab = state.cashierTab;
  const version = state.cardLoadVersion = (state.cardLoadVersion || 0) + 1;
  if ($('#csCard')) $('#csCard').innerHTML = '<option value="">正在加载会员卡</option>';
  const d = await api('/api/member-cards?member_id=' + memberId);
  if (version !== state.cardLoadVersion || Number(state.cashierMember?.id) !== Number(memberId) || state.cashierTab !== tab) return;
  const type = state.cashierTab === 'renew' ? '' : 'stored';
  const cards = type ? d.list.filter((c) => c.card_type === type) : d.list;
  const sel = $('#csCard');
  if (sel) sel.innerHTML = (state.cashierTab === 'renew' ? '<option value="">请选择要续费的会员卡</option>' : '') + cards.map((c) => {
    const status = c.status === 'void' ? '已作废' : c.status === 'refunded' ? '已退款' : c.status === 'frozen' ? '已冻结' : c.card_type === 'stored' ? fmtMoney(c.balance) : c.remaining_uses + '次';
    const disabled = ['void', 'refunded', 'frozen'].includes(c.status) ? ' disabled' : '';
    return `<option value="${c.id}"${disabled}>${esc(c.card_no)} · ${esc(c.card_name || '')} · ${status}</option>`;
  }).join('') || '<option value="">无可用卡</option>';
  state.cashierCards = cards;
  cashierRenewCard();
}
function cashierRenewCard() {
  if (state.cashierTab !== 'renew') return;
  const value = $('#csCard')?.value;
  const card = value ? (state.cashierCards || []).find(c => String(c.id) === String(value)) : null;
  const products = card ? (state.products || []).filter(p => p.type === card.card_type && (!card.end_at || Number(p.duration_days) > 0)) : [];
  if ($('#csProduct')) $('#csProduct').innerHTML = products.map(p => `<option value="${p.id}">${esc(p.name)} · ${fmtMoney(p.price)}</option>`).join('') || '<option value="">请先选择要续费的会员卡</option>';
  updateCashierTotal();
}
function updateCashierTotal() {
  const payable = cashierPayable();
  if ($('#csPayable')) $('#csPayable').textContent = fmtMoney(payable);
  const inp = $('#csPayAmount');
  if (inp) inp.value = payable;
}
async function submitCashier() {
  if (state.cashierSubmitting) return;
  const tab = state.cashierTab;
  const memberId = state.cashierMember?.id || '';
  const payable = cashierPayable();
  if (!Number.isFinite(payable) || payable < 0) { toast('应收金额无效'); return; }
  let payments = payable > 0 ? [{ pay_method: state.payMethod || 'cash', amount: payable }] : [];
  if ($('#csMixed').checked) {
    payments = $$('.cs-split').map(input => ({ pay_method: input.dataset.method, amount: Number(input.value) }));
    if (payments.some(p => !Number.isFinite(p.amount) || p.amount < 0)) { toast('拆分金额必须为非负数'); return; }
    payments = payments.filter(p => p.amount > 0);
  }
  if (payments.reduce((n, p) => n + Math.round(p.amount * 100), 0) !== Math.round(payable * 100)) { toast('支付合计必须等于应收金额，抹零请填写优惠金额'); return; }
  payments.forEach(p => { if (p.pay_method === 'stored' && $('#csStoredSource').value) p.source_card_id = Number($('#csStoredSource').value); });
  const usingNewMember = tab === 'open' && state.cashierNewMember;
  if (tab === 'open' && !memberId && !usingNewMember) { toast('请选择已有会员或填写新会员姓名'); return; }
  if (tab === 'open' && !memberId && usingNewMember && !($('#csName')?.value || '').trim()) { toast('请填写新会员姓名'); return; }
  if (['renew', 'recharge'].includes(tab) && !memberId) { toast('请先查询并选择会员'); return; }
  if (tab === 'renew' && !$('#csCard')?.value) { toast('请选择要续费的会员卡'); return; }
  if (tab === 'recharge' && !$('#csCard')?.value) { toast('请选择要充值的储值卡'); return; }
  const body = {
    order_type: tab,
    member_id: memberId ? Number(memberId) : undefined,
    name: usingNewMember ? $('#csName')?.value : undefined,
    phone: usingNewMember ? $('#csPhone')?.value : undefined,
    gender: usingNewMember ? ($('#csGender')?.value || 'unknown') : undefined,
    card_product_id: $('#csProduct')?.value ? Number($('#csProduct').value) : undefined,
    member_card_id: $('#csCard')?.value ? Number($('#csCard').value) : undefined,
    discount_amount: Number($('#csDiscount')?.value) || 0,
    payments
  };
  if (tab === 'recharge') body.amount = Number($('#csAmount')?.value);
  let pending;
  try {
    state.cashierSubmitting = true;
    const payload = pendingRequest('cashier', body);
    pending = pendingSnapshot('cashier');
    const d = await api('/api/orders', { body: payload });
    clearPending('cashier', undefined, pending);
    toast(`收款成功：${fmtMoney(d.amount)}`);
    renderCashierForm(tab);
  } catch (e) { clearPending('cashier', e, pending); toast(e.message, 'error'); }
  finally { state.cashierSubmitting = false; }
}

function toggleCashierFullscreen() {
  const on = document.body.classList.toggle('cashier-fs');
  const btn = $('#cashierFsBtn');
  if (btn) btn.textContent = on ? '✕ 退出全屏' : '⛶ 全屏收银';
  try {
    if (on) document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen && document.exitFullscreen().catch(() => {});
  } catch (e) { /* 忽略浏览器全屏限制 */ }
}

/* ============================= 收银流水 ============================= */
async function renderOrders() {
  $('#view-orders').innerHTML = `
    <div class="toolbar">
      <select class="select" id="oType" data-change="refreshOrders"><option value="income">收入订单（开卡/续费/充值）</option><option value="refund">退款订单</option><option value="">全部订单</option><option value="open">仅开卡</option><option value="renew">仅续费</option><option value="recharge">仅储值充值</option></select>
      <select class="select" id="oStatus" data-change="refreshOrders"><option value="">全部状态</option><option value="paid">已支付</option><option value="partial_refund">部分退款</option><option value="refunded">已退款</option><option value="pending">待审批</option><option value="void">已作废</option></select>
      <input class="input" type="date" id="oFrom" data-change="refreshOrders"><span class="text-muted">至</span><input class="input" type="date" id="oTo" data-change="refreshOrders">
      <div class="spacer"></div><button class="btn btn-sm btn-outline" data-action="exportOrders">导出 CSV</button>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>单号</th><th>类型</th><th>状态</th><th>会员</th><th>卡号</th><th>原价</th><th>优惠</th><th>实付</th><th>操作员</th><th>时间</th><th>操作</th></tr></thead>
      <tbody id="ordersBody"></tbody></table></div></div>`;
  $('#oFrom').value = addDays(todayStr(), -6);
  $('#oTo').value = todayStr();
  refreshOrders();
}
async function refreshOrders() {
  const q = new URLSearchParams();
  const orderType = $('#oType')?.value;
  if (orderType === 'income') q.set('income_only', '1');
  else if (orderType) q.set('order_type', orderType);
  if ($('#oStatus')?.value) q.set('status', $('#oStatus').value);
  if ($('#oFrom')?.value) q.set('from', $('#oFrom').value);
  if ($('#oTo')?.value) q.set('to', $('#oTo').value);
  const d = await api('/api/orders?' + q.toString());
  $('#ordersBody').innerHTML = d.list.map((o) => `<tr>
    <td class="num">${esc(o.order_no)}</td><td>${orderTypeBadge(o.order_type)}</td><td>${orderStatusBadge(o.status)}</td>
    <td>${esc(o.member_name)}</td><td class="num">${esc(o.card_no || '—')}</td>
     <td class="num">${fmtMoney(o.total_amount)}</td><td class="num">${fmtMoney(o.discount_amount)}</td><td class="num"><b>${fmtMoney(o.order_type === 'refund' ? (o.status === 'paid' ? -o.total_amount : 0) : o.paid_amount)}</b></td>
    <td>${esc(o.staff_name)}</td><td class="num">${esc((o.business_at || o.created_at || '').replace('T', ' ').slice(0, 16))}</td>
    <td class="ops"><button class="btn btn-sm btn-outline" data-action="openOrder" data-id="${o.id}">详情</button>
    ${['open', 'renew', 'recharge'].includes(o.order_type) && ['paid', 'partial_refund'].includes(o.status) ? `<button class="btn btn-sm btn-danger" data-action="refundApply" data-id="${o.id}">退款</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="11" class="empty">暂无订单</td></tr>';
}
async function openOrder(id) {
  const d = await api('/api/orders/' + id);
  const o = d.order;
  openModal(`
    <div class="modal-head"><h3>订单详情 · ${esc(o.order_no)}</h3><button class="modal-close" data-action="closeModal">×</button></div>
    <div class="modal-body">
      <div class="grid cols-4 mb-16">
        <div class="card stat"><span class="stat-label">原价</span><span class="stat-value num">${fmtMoney(o.total_amount)}</span></div>
        <div class="card stat"><span class="stat-label">优惠</span><span class="stat-value num">${fmtMoney(o.discount_amount)}</span></div>
        <div class="card stat"><span class="stat-label">实付</span><span class="stat-value num">${fmtMoney(o.order_type === 'refund' ? (o.status === 'paid' ? -o.total_amount : 0) : o.paid_amount)}</span></div>
        <div class="card stat"><span class="stat-label">状态</span><span class="stat-value num">${ORDER_STATUS_LABEL[o.status]}</span></div>
      </div>
      <div class="card-title">支付记录</div>
      <div class="table-wrap"><table><thead><tr><th>方式</th><th>金额</th><th>时间</th><th>交易号</th></tr></thead>
      <tbody>${d.payments.map((p) => `<tr><td>${PAY_LABEL[p.pay_method]}</td><td class="num" style="color:${p.amount >= 0 ? '#16a34a' : '#dc2626'};font-weight:600">${p.amount >= 0 ? '+' : ''}${fmtMoney(p.amount)}</td><td class="num">${esc((p.paid_at || '').replace('T', ' ').slice(0, 16))}</td><td>${esc(p.transaction_no || '—')}</td></tr>`).join('')}</tbody></table></div>
    </div>
    <div class="modal-foot"><button class="btn" data-action="closeModal">关闭</button></div>`);
}
function refundApply(el) {
  openModal(`
    <div class="modal-head"><h3>退款申请</h3><button class="modal-close" data-action="closeModal">×</button></div>
    <div class="modal-body">
      <div class="field"><label>退款金额（元）</label><input class="input" type="number" step="0.01" id="rfAmount"></div>
      <div class="field"><label>退款原因 *</label><input class="input" id="rfReason"></div>
    </div>
    <div class="modal-foot"><button class="btn" data-action="closeModal">取消</button><button class="btn btn-danger" data-action="confirmRefundApply" data-id="${el.dataset.id}">提交申请</button></div>`);
}
async function confirmRefundApply(el) {
  if (state.refundSubmitting) return;
  state.refundSubmitting = true; el.disabled = true;
  const path = `/api/orders/${el.dataset.id}/refund`;
  let pending;
  try {
    const body = pendingRequest('refund', { amount: $('#rfAmount').value, reason: $('#rfReason').value }, path);
    pending = pendingSnapshot('refund');
    await api(path, { body }); clearPending('refund', undefined, pending); toast('退款申请已提交'); closeModal(); refreshOrders();
  } catch (e) { clearPending('refund', e, pending); toast(e.message, 'error'); el.disabled = false; }
  finally { state.refundSubmitting = false; }
}
async function exportOrders() {
  const q = new URLSearchParams();
  if ($('#oFrom')?.value) q.set('from', $('#oFrom').value);
  if ($('#oTo')?.value) q.set('to', $('#oTo').value);
  const d = await api('/api/reports/export/orders?' + q.toString(), { timeout: 180000 });
  downloadCSV(d.csv, d.filename);
}

/* ============================= 退款审批 ============================= */
async function renderRefunds() {
  $('#view-refunds').innerHTML = `
    <div class="sale-tabs mb-16">
      <button class="sale-tab active" data-action="refundTab" data-tab="pending">待审批</button>
      <button class="sale-tab" data-action="refundTab" data-tab="">全部</button>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>退款单号</th><th>原单号</th><th>会员</th><th>金额</th><th>原因</th><th>申请人</th><th>状态</th><th>操作</th></tr></thead>
      <tbody id="refundsBody"></tbody></table></div></div>`;
  state.refundTab = 'pending';
  refreshRefunds();
}
async function refreshRefunds() {
  const q = new URLSearchParams();
  if (state.refundTab) q.set('status', state.refundTab);
  const d = await api('/api/refunds?' + q.toString());
  refreshRefundBadge();
  $('#refundsBody').innerHTML = d.list.map((r) => `<tr>
    <td class="num">${esc(r.order_no)}</td><td class="num">${esc(r.original_order_id)}</td>
    <td>${esc(r.member_name)}</td><td class="num"><b>${fmtMoney(r.total_amount)}</b></td>
    <td>${esc(r.refund_reason || '—')}</td><td>${esc(r.staff_name)}</td><td>${orderStatusBadge(r.status)}</td>
    <td class="ops">${r.status === 'pending' ? `<button class="btn btn-sm btn-success" data-action="approveRefund" data-id="${r.id}">通过</button><button class="btn btn-sm btn-danger" data-action="rejectRefund" data-id="${r.id}">驳回</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="8" class="empty">暂无退款单</td></tr>';
}
function approveRefund(el) {
  openModal(`
    <div class="modal-head"><h3>审批通过</h3><button class="modal-close" data-action="closeModal">×</button></div>
    <div class="modal-body"><div class="field"><label>退款方式</label><select class="select" id="apMethod"><option value="original">原路退回</option><option value="cash">现金登记</option></select></div></div>
    <div class="modal-foot"><button class="btn" data-action="closeModal">取消</button><button class="btn btn-success" data-action="confirmApproveRefund" data-id="${el.dataset.id}">确认通过</button></div>`);
}
async function confirmApproveRefund(el) { if (el.disabled) return; el.disabled = true; try { await api(`/api/refunds/${el.dataset.id}/approve`, { body: { refund_method: $('#apMethod').value } }); toast('已通过'); closeModal(); refreshRefunds(); } catch (e) { el.disabled = false; toast(e.message, 'error'); } }
function rejectRefund(el) {
  openModal(`
    <div class="modal-head"><h3>驳回退款</h3><button class="modal-close" data-action="closeModal">×</button></div>
    <div class="modal-body"><div class="field"><label>驳回原因</label><input class="input" id="rjReason"></div></div>
    <div class="modal-foot"><button class="btn" data-action="closeModal">取消</button><button class="btn btn-danger" data-action="confirmRejectRefund" data-id="${el.dataset.id}">确认驳回</button></div>`);
}
async function confirmRejectRefund(el) { if (el.disabled) return; el.disabled = true; try { await api(`/api/refunds/${el.dataset.id}/reject`, { body: { reason: $('#rjReason').value } }); toast('已驳回'); closeModal(); refreshRefunds(); } catch (e) { el.disabled = false; toast(e.message, 'error'); } }

/* ============================= 交班对账 ============================= */
async function renderShifts() {
  $('#view-shifts').innerHTML = `
    <div class="card mb-16" id="shiftCurrent"></div>
    <div class="card"><div class="card-head"><div class="card-title">班次记录</div></div><div class="table-wrap"><table>
      <thead><tr><th>班次</th><th>员工</th><th>开始</th><th>结束</th><th>应交现金</th><th>实点现金</th><th>差额</th><th>状态</th><th>操作</th></tr></thead>
      <tbody id="shiftsBody"></tbody></table></div></div>`;
  refreshShifts();
}
async function refreshShifts() {
  const cur = await api('/api/shifts/current');
  const box = $('#shiftCurrent');
  // 从首页/登录提醒开班时交班视图还没渲染，跳过而不是对 null 赋值。
  if (!box) return;
  const canOperate = ['boss', 'frontdesk', 'admin'].includes(state.user?.role);
  box.innerHTML = cur.shift
    ? `<div class="flex-between"><div><b>当前班次</b> · 开始于 ${esc((cur.shift.started_at || '').replace('T', ' ').slice(0, 16))}</div>
       ${canOperate ? `<button class="btn btn-success" data-action="openShiftClose" data-id="${cur.shift.id}">交班对账</button>` : ''}</div>`
    : `<div class="flex-between"><div><b>暂无进行中班次</b></div>${canOperate ? `<button class="btn btn-primary" data-action="startShift">开始班次</button>` : ''}</div>`;
  const d = await api('/api/shifts');
  const body = $('#shiftsBody');
  if (!body) return;
  body.innerHTML = d.list.map((s) => `<tr>
    <td class="num">${s.id}</td><td>${esc(s.staff_name)}</td>
    <td class="num">${esc((s.started_at || '').replace('T', ' ').slice(0, 16))}</td>
    <td class="num">${s.ended_at ? esc(s.ended_at.replace('T', ' ').slice(0, 16)) : '—'}</td>
    <td class="num">${s.cash_amount ?? '—'}</td><td class="num">${s.actual_cash ?? '—'}</td>
    <td class="num">${s.difference !== null && s.difference !== undefined ? (s.difference === 0 ? '0' : '<b style="color:#dc2626">' + s.difference + '</b>') : '—'}</td>
    <td>${s.status === 'active' ? '<span class="badge badge-green">进行中</span>' : '<span class="badge badge-gray">已交班</span>'}</td>
    <td><button class="btn btn-sm btn-outline" data-action="openShift" data-id="${s.id}">详情</button></td>
  </tr>`).join('') || '<tr><td colspan="9" class="empty">暂无班次</td></tr>';
}
function startShift() {
  openModal(`<div class="modal-head"><h3>开始班次</h3><button class="modal-close" data-action="closeModal">×</button></div>
    <div class="modal-body"><div class="field"><label>开班备用金（元）</label><input class="input" type="number" min="0" step="0.01" id="shiftOpeningCash" value="0"><div class="hint mt-8">钱箱中上个班次留下的现金，不属于本班收入，但会计入本班应交现金。</div></div></div>
    <div class="modal-foot"><button class="btn" data-action="closeModal">取消</button><button class="btn btn-primary" data-action="confirmStartShift">确认开班</button></div>`);
}
async function confirmStartShift(el) {
  if (el.disabled) return;
  el.disabled = true;
  try {
    await api('/api/shifts/start', { body: { opening_cash: $('#shiftOpeningCash').value } });
    toast('已开班'); closeModal();
    if (currentView() === 'shifts') refreshShifts(); else renderDashboard();
  } catch (e) { el.disabled = false; toast(e.message, 'error'); }
}
async function openShiftClose(el) {
  try {
    const d = await api('/api/shifts/' + el.dataset.id);
    const sum = d.summary;
    state.shiftCloseSummary = sum;
    openModal(`
      <div class="modal-head"><h3>交班对账</h3><button class="modal-close" data-action="closeModal">×</button></div>
      <div class="modal-body">
        <div class="grid cols-4 mb-16">
          <div class="card stat accent"><span class="stat-label">本班收入</span><span class="stat-value num">${fmtMoney(sum.total_income)}</span></div>
          <div class="card stat"><span class="stat-label">本班退款</span><span class="stat-value num">${fmtMoney(sum.total_refund)}</span></div>
          <div class="card stat"><span class="stat-label">应交现金</span><span class="stat-value num">${fmtMoney(sum.cash_should)}</span></div>
          <div class="card stat"><span class="stat-label">订单数</span><span class="stat-value num">${d.orders.length}</span></div>
        </div>
        <div class="card-title">分支付方式（自动汇总）</div>
        <div class="table-wrap mb-16"><table><thead><tr><th>方式</th><th>收入</th><th>退款</th></tr></thead>
        <tbody>${Object.entries(sum.by_method).map(([k, v]) => `<tr><td>${PAY_LABEL[k] || k}</td><td class="num">${fmtMoney(v.income)}</td><td class="num">${fmtMoney(v.refund)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">本班暂无支付记录</td></tr>'}</tbody></table></div>
        <div class="form-row">
          <div class="field"><label>实点现金（元）</label><input class="input" type="number" step="0.01" id="scActual" placeholder="清点现金后录入" data-input="shiftDiff"></div>
          <div class="field"><label>现金差额（自动）</label><div id="scDiff" style="font-size:24px;font-weight:800">—</div></div>
        </div>
        <div class="field"><label>差额说明（差额不为 0 时必填）</label><input class="input" id="scNote" placeholder="例如：微信多收 / 找零差异"></div>
      </div>
      <div class="modal-foot"><button class="btn" data-action="closeModal">取消</button><button class="btn btn-primary" data-action="confirmShiftClose" data-id="${el.dataset.id}">确认交班</button></div>`, true);
    updateShiftDiff();
  } catch (e) { toast(e.message, 'error'); }
}
function updateShiftDiff() {
  const sum = state.shiftCloseSummary;
  if (!sum) return;
  const el = $('#scDiff');
  const raw = $('#scActual')?.value;
  if (String(raw ?? '').trim() === '') {
    if (el) { el.textContent = '—'; el.style.color = ''; }
    return;
  }
  const actual = Number(raw) || 0;
  const diff = money2(actual - sum.cash_should);
  if (el) {
    el.textContent = (diff >= 0 ? '+' : '') + fmtMoney(diff).replace('¥', '');
    el.style.color = Math.abs(diff) < 0.005 ? '#16a34a' : '#dc2626';
  }
}
async function confirmShiftClose(el) {
  if (el.disabled) return;
  const actual = $('#scActual').value;
  if (String(actual).trim() === '') { toast('请先清点现金并填写实点金额', 'error'); return; }
  el.disabled = true;
  try { await api(`/api/shifts/${el.dataset.id}/close`, { body: { actual_cash: actual, note: $('#scNote').value } }); toast('已交班'); closeModal(); refreshShifts(); } catch (e) { el.disabled = false; toast(e.message, 'error'); }
}
async function openShift(id) {
  const d = await api('/api/shifts/' + id);
  const sum = d.summary;
  openModal(`
    <div class="modal-head"><h3>班次详情 #${id}</h3><button class="modal-close" data-action="closeModal">×</button></div>
    <div class="modal-body">
      <div class="grid cols-3 mb-16">
        <div class="card stat"><span class="stat-label">总收入</span><span class="stat-value num">${fmtMoney(sum.total_income)}</span></div>
        <div class="card stat"><span class="stat-label">总退款</span><span class="stat-value num">${fmtMoney(sum.total_refund)}</span></div>
        <div class="card stat"><span class="stat-label">应交现金</span><span class="stat-value num">${fmtMoney(sum.cash_should)}</span></div>
      </div>
      <div class="card-title">分支付方式</div>
      <div class="table-wrap"><table><thead><tr><th>方式</th><th>收入</th><th>退款</th></tr></thead>
      <tbody>${Object.entries(sum.by_method).map(([k, v]) => `<tr><td>${PAY_LABEL[k] || k}</td><td class="num">${fmtMoney(v.income)}</td><td class="num">${fmtMoney(v.refund)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">无</td></tr>'}</tbody></table></div>
    </div>
    <div class="modal-foot"><button class="btn" data-action="closeModal">关闭</button></div>`, true);
}

/* ============================= 日结管理 ============================= */
async function renderClosings() {
  $('#view-closings').innerHTML = `
    <div class="toolbar">
      <input class="input" type="date" id="clDate" value="${todayStr()}" max="${todayStr()}">
      <button class="btn btn-primary" data-action="doClosing">执行日结</button>
      <div class="spacer"></div>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>营业日期</th><th>净收入</th><th>总退款</th><th>入场人次</th><th>新增会员</th><th>日结人</th><th>状态</th><th>操作</th></tr></thead>
      <tbody id="closingsBody"></tbody></table></div></div>`;
  refreshClosings();
}
async function refreshClosings() {
  const d = await api('/api/closings');
  $('#closingsBody').innerHTML = d.list.map((c) => `<tr>
    <td class="num">${esc(c.business_date)}</td><td class="num">${fmtMoney(c.total_income)}</td><td class="num">${fmtMoney(c.total_refund)}</td>
    <td class="num">${c.total_entries}</td><td class="num">${c.new_members}</td><td>${esc(c.closed_by_name || '')}</td>
    <td>${c.status === 'reopened' ? '<span class="badge badge-amber">已重开，待日结</span>' : c.status === 'adjusted' ? '<span class="badge badge-amber">已调整</span>' : '<span class="badge badge-green">已日结</span>'}</td>
    <td><button class="btn btn-sm btn-outline" data-action="openClosing" data-date="${esc(c.business_date)}">详情</button></td>
  </tr>`).join('') || '<tr><td colspan="8" class="empty">暂无日结</td></tr>';
}
async function doClosing() { try { await api('/api/closings', { body: { business_date: $('#clDate').value } }); toast('日结完成'); refreshClosings(); } catch (e) { toast(e.message, 'error'); } }
async function openClosing(el) {
  const d = await api('/api/closings/' + el.dataset.date);
  const c = d.closing || d.preview;
  openModal(`
    <div class="modal-head"><h3>日结 ${el.dataset.date}</h3><button class="modal-close" data-action="closeModal">×</button></div>
    <div class="modal-body"><div class="grid cols-4">
      <div class="card stat"><span class="stat-label">净收入</span><span class="stat-value num">${fmtMoney(c.total_income)}</span></div>
      <div class="card stat"><span class="stat-label">退款</span><span class="stat-value num">${fmtMoney(c.total_refund)}</span></div>
      <div class="card stat"><span class="stat-label">入场</span><span class="stat-value num">${c.total_entries}</span></div>
      <div class="card stat"><span class="stat-label">新会员</span><span class="stat-value num">${c.new_members}</span></div>
    </div>${d.closing && c.status !== 'reopened' && ['boss', 'admin'].includes(state.user?.role) ? `<div class="field mt-16"><label>重开营业日原因</label><input class="input" id="clReopenReason"><button class="btn btn-outline mt-8" data-action="reopenClosing" data-date="${esc(el.dataset.date)}">重开营业日</button></div>` : ''}</div>
    <div class="modal-foot"><button class="btn" data-action="closeModal">关闭</button></div>`);
}
async function reopenClosing(el) {
  if (el.disabled) return;
  el.disabled = true;
  try { await api('/api/closings/' + el.dataset.date + '/reopen', { body: { reason: $('#clReopenReason').value } }); closeModal(); toast('营业日已重开，业务结束后请重新日结'); refreshClosings(); }
  catch (e) { el.disabled = false; toast(e.message, 'error'); }
}

/* ============================= 报表中心 ============================= */
async function renderReports() {
  $('#view-reports').innerHTML = `
    <div class="toolbar">
      <input class="input" type="date" id="rpFrom"><span class="text-muted">至</span><input class="input" type="date" id="rpTo">
      <button class="btn btn-outline" data-action="refreshReports">查询</button>
      <div class="spacer"></div>
      <button class="btn btn-sm btn-outline" data-action="exportOrders2">导出订单 CSV</button>
      <button class="btn btn-sm btn-outline" data-action="exportMembers">导出会员 CSV</button>
    </div>
    <div class="grid cols-4 mb-16" id="rpSummary"></div>
    <div class="grid cols-3" id="rpCharts"></div>`;
  $('#rpFrom').value = addDays(todayStr(), -29);
  $('#rpTo').value = todayStr();
  refreshReports();
}

/* ============================= 员工绩效 ============================= */
async function renderStaffPerformance() {
  $('#view-staff-performance').innerHTML = `<div class="toolbar"><input class="input" type="date" id="spFrom"><span class="text-muted">至</span><input class="input" type="date" id="spTo"><button class="btn btn-primary" data-action="refreshStaffPerformance">查询</button><div class="spacer"></div></div><div class="card"><div class="hint mb-16">统计收款员工的开卡、续费、充值单量与实收；退款回冲原销售员工。净收入=业务实收−原销售订单退款，审批人仅用于审计。</div><div class="table-wrap"><table><thead><tr><th>员工</th><th>开卡</th><th>续费</th><th>充值</th><th>业务实收</th><th>退款</th><th>净收入</th></tr></thead><tbody id="spBody"></tbody></table></div></div>`;
  $('#spFrom').value = addDays(todayStr(), -29); $('#spTo').value = todayStr();
  refreshStaffPerformance();
}
async function refreshStaffPerformance() {
  const q = new URLSearchParams({ from: $('#spFrom')?.value || addDays(todayStr(), -29), to: $('#spTo')?.value || todayStr() });
  try {
    const d = await api('/api/reports/staff-performance?' + q.toString());
    $('#spBody').innerHTML = d.list.map((r) => `<tr><td><b>${esc(r.real_name)}</b><div class="text-muted">${esc(r.username)}</div></td><td>${r.open_count} 单<br><span class="num">${fmtMoney(r.open_amount)}</span></td><td>${r.renew_count} 单<br><span class="num">${fmtMoney(r.renew_amount)}</span></td><td>${r.recharge_count} 单<br><span class="num">${fmtMoney(r.recharge_amount)}</span></td><td class="num">${fmtMoney(r.gross_amount)}</td><td>${r.refund_count} 单<br><span class="num text-danger">-${fmtMoney(r.refund_amount)}</span></td><td class="num"><b>${fmtMoney(r.net_amount)}</b></td></tr>`).join('') || '<tr><td colspan="7" class="empty">暂无数据</td></tr>';
  } catch (e) { toast(e.message, 'error'); }
}
async function refreshReports() {
  const q = new URLSearchParams({ from: $('#rpFrom').value, to: $('#rpTo').value });
  const d = await api('/api/reports/overview?' + q.toString());
  $('#rpSummary').innerHTML = `
    <div class="card stat"><span class="stat-label">区间净收入</span><span class="stat-value num">${fmtMoney(d.income)}</span></div>
    <div class="card stat"><span class="stat-label">区间退款</span><span class="stat-value num">${fmtMoney(d.refund)}</span></div>
    <div class="card stat"><span class="stat-label">入场人次</span><span class="stat-value num">${fmtNum(d.entries)}</span></div>
    <div class="card stat"><span class="stat-label">新增会员</span><span class="stat-value num">${fmtNum(d.new_members)}</span></div>`;
  const table = (title, rows) => `<div class="card"><div class="card-title">${title}</div><div class="table-wrap"><table><thead><tr><th>项目</th><th>金额</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num"><b>${fmtMoney(r.value)}</b></td></tr>`).join('') || '<tr><td colspan="2" class="empty">无</td></tr>'}</tbody></table></div></div>`;
  $('#rpCharts').innerHTML = table('按卡种', d.by_card.map((x) => ({ label: CARD_TYPE_LABEL[x.card_type] || x.card_type, value: x.amount })))
    + table('按支付方式', d.by_pay.map((x) => ({ label: PAY_LABEL[x.pay_method] || x.pay_method, value: x.amount })))
    + table('按员工', d.by_staff.map((x) => ({ label: x.real_name || ('#' + x.staff_id), value: x.amount })));
}
async function exportMembers() { const d = await api('/api/reports/export/members', { timeout: 180000 }); downloadCSV(d.csv, d.filename); }
async function exportOrders2() {
  const q = new URLSearchParams({ from: $('#rpFrom').value, to: $('#rpTo').value });
  const d = await api('/api/reports/export/orders?' + q.toString(), { timeout: 180000 });
  downloadCSV(d.csv, d.filename);
}

/* ============================= 员工权限 ============================= */
async function renderStaff() {
  const d = await api('/api/staff');
  $('#view-staff').innerHTML = `
    <div class="toolbar"><div class="spacer"></div><button class="btn btn-primary" data-action="openStaffForm">＋ 新增员工</button></div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>账号</th><th>姓名</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${d.list.map((u) => `<tr>
        <td class="num">${esc(u.username)}</td><td><b>${esc(u.real_name)}</b></td>
        <td>${u.role === 'admin' ? '<span class="badge badge-red">超管</span>' : u.role === 'boss' ? '<span class="badge badge-amber">老板</span>' : u.role === 'finance' ? '<span class="badge badge-blue">财务</span>' : '<span class="badge badge-green">前台</span>'}</td>
        <td>${u.status === 'active' ? '<span class="badge badge-green">启用</span>' : '<span class="badge badge-gray">停用</span>'}</td>
        <td class="num">${esc((u.created_at || '').replace('T', ' ').slice(0, 16))}</td>
        <td class="ops"><button class="btn btn-sm btn-outline" data-action="openStaffForm" data-id="${u.id}">编辑</button>
        <button class="btn btn-sm ${u.status === 'active' ? 'btn-danger' : 'btn-outline'}" data-action="toggleStaff" data-id="${u.id}">${u.status === 'active' ? '停用' : '启用'}</button></td>
      </tr>`).join('')}</tbody></table></div></div>`;
}
async function openStaffForm(id) {
  let u = null;
  if (id) { const d = await api('/api/staff'); u = d.list.find((x) => String(x.id) === String(id)); }
  openModal(`
    <div class="modal-head"><h3>${u ? '编辑员工' : '新增员工'}</h3><button class="modal-close" data-action="closeModal">×</button></div>
    <div class="modal-body">
      <div class="form-row">
        <div class="field"><label>登录账号 *</label><input class="input" id="sfUsername" value="${esc(u?.username || '')}"></div>
        <div class="field"><label>姓名 *</label><input class="input" id="sfName" value="${esc(u?.real_name || '')}"></div>
      </div>
      <div class="form-row">
        <div class="field"><label>角色</label><select class="select" id="sfRole">
          ${state.user?.role === 'admin' ? `<option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>超管</option>` : ''}
          <option value="boss" ${u?.role === 'boss' ? 'selected' : ''}>老板</option>
          <option value="frontdesk" ${u?.role === 'frontdesk' ? 'selected' : ''}>前台</option>
          <option value="finance" ${u?.role === 'finance' ? 'selected' : ''}>财务</option>
        </select></div>
        <div class="field"><label>${u ? '重置密码（留空不修改）' : '密码 *'}</label><input class="input" type="password" id="sfPassword" placeholder="${u ? '留空则不变' : '至少 8 位'}"></div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn" data-action="closeModal">取消</button><button class="btn btn-primary" data-action="saveStaff" data-id="${u?.id || ''}">保存</button></div>`);
}
async function saveStaff(el) {
  if (el.disabled) return;
  el.disabled = true;
  const body = { username: $('#sfUsername').value, real_name: $('#sfName').value, role: $('#sfRole').value };
  if ($('#sfPassword').value) body.password = $('#sfPassword').value;
  try {
    if (el.dataset.id) await api('/api/staff/' + el.dataset.id, { method: 'PUT', body });
    else await api('/api/staff', { body });
    toast('已保存'); closeModal(); renderStaff();
  } catch (e) { el.disabled = false; toast(e.message, 'error'); }
}
async function toggleStaff(el) {
  if (el.disabled) return;
  el.disabled = true;
  try { await api('/api/staff/' + el.dataset.id, { method: 'DELETE' }); toast('已更新'); renderStaff(); } catch (e) { el.disabled = false; toast(e.message, 'error'); }
}

/* ============================= 操作日志 ============================= */
async function renderLogs() {
  $('#view-logs').innerHTML = `
    <div class="toolbar">
      <input class="input" id="lgSearch" placeholder="操作员 / 动作 / 对象" style="width:200px" data-input="logSearch">
      <select class="select" id="lgType" data-change="logSearch">
        <option value="">全部对象</option><option value="member">会员</option><option value="order">订单</option><option value="member_card">会员卡</option><option value="card_product">卡项</option><option value="shift">班次</option><option value="staff">员工</option><option value="settings">设置</option><option value="daily_closing">日结</option><option value="entry">入场</option><option value="auth">登录</option>
      </select>
      <input class="input" type="date" id="lgFrom" data-change="logSearch"><span class="text-muted">至</span><input class="input" type="date" id="lgTo" data-change="logSearch">
      <div class="spacer"></div>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>时间</th><th>操作员</th><th>动作</th><th>对象</th><th>原因</th><th>IP</th></tr></thead>
      <tbody id="logsBody"></tbody></table></div></div>`;
  $('#lgFrom').value = addDays(todayStr(), -7);
  $('#lgTo').value = todayStr();
  refreshLogs();
}
async function refreshLogs() {
  const q = new URLSearchParams();
  if ($('#lgSearch')?.value) q.set('search', $('#lgSearch').value);
  if ($('#lgType')?.value) q.set('target_type', $('#lgType').value);
  if ($('#lgFrom')?.value) q.set('from', $('#lgFrom').value);
  if ($('#lgTo')?.value) q.set('to', $('#lgTo').value);
  const d = await api('/api/operation-logs?' + q.toString());
  $('#logsBody').innerHTML = d.list.map((l) => `<tr>
    <td class="num">${esc((l.created_at || '').replace('T', ' ').slice(0, 16))}</td>
    <td>${esc(l.staff_name || '—')}</td><td><b>${esc(l.action)}</b></td>
    <td>${esc((l.target_type || '') + (l.target_id ? '#' + l.target_id : ''))}</td>
    <td style="max-width:260px;white-space:normal;font-size:12px">${esc(l.reason || '—')}</td>
    <td class="num">${esc(l.ip || '')}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty">暂无日志</td></tr>';
}

/* ============================= 系统设置 ============================= */
async function renderSettings() {
  if (!state.settingsLoaded) {
    $('#view-settings').innerHTML = `<div class="card"><div class="card-title">设置加载失败</div><div class="hint">未能读取系统设置。为避免用空值覆盖数据库里的门店配置，已禁用保存，请检查网络后重试。</div><button class="btn btn-primary mt-16" data-action="reloadSettings">重新加载</button></div>`;
    return;
  }
  const s = state.settings;
  const canEditProtected = state.user?.role === 'admin';
  state.brand_logo_img = s.brand_logo_img || '';
  state.login_bg = s.login_bg || '';
  state.dashboard_bg = s.dashboard_bg || '';
  $('#view-settings').innerHTML = `
    <div class="grid cols-2">
      <div class="card"><div class="card-title">有效期与扣费规则</div>
        <div class="field"><label>月卡起算方式</label><select class="select" id="stMonth"><option value="purchase" ${s.month_rule !== 'natural' ? 'selected' : ''}>购买日起算</option><option value="natural" ${s.month_rule === 'natural' ? 'selected' : ''}>自然月</option></select></div>
        <div class="field"><label>储值卡默认单次入场扣费（元）</label><input class="input" type="number" step="0.01" id="stEntryFee" value="${esc(s.default_entry_fee || '')}"></div>
      </div>
      ${canEditProtected ? `<div class="card"><div class="card-title">微信小程序登录（员工微信绑定）</div>
        <div class="field"><label>小程序 AppID</label><input class="input" id="stWxAppid" value="${esc(s.wechat_appid || '')}" placeholder="用于 jscode2session 换取 openid"></div>
        <div class="field"><label>小程序 AppSecret</label><input class="input" type="password" id="stWxSecret" value="${esc(s.wechat_secret || '')}"></div>
        <div class="field"><div class="hint">留空则不启用微信登录；填写后员工可在小程序用微信一键登录并绑定账号。</div></div>
      </div>` : ''}
      <div class="card"><div class="card-title">品牌图标与名称</div>
        <div class="field"><label>品牌名称</label><input class="input" id="stStoreName" value="${esc(s.store_name || '')}"></div>
        <div class="field"><label>图标（emoji / 文字）</label><input class="input" id="stBrandIcon" value="${esc(s.brand_icon || '')}"></div>
        <div class="field"><label>图标图片（可选，上传后覆盖文字图标）</label>
          <input class="input" type="file" id="stLogoFile" accept="image/*">
          <div class="flex mt-16" style="gap:8px;align-items:center">
            <div class="brand-logo" id="stLogoPreview" style="width:56px;height:56px;font-size:26px">${brandLogoHtml()}</div>
            ${s.brand_logo_img ? '<button class="btn btn-sm btn-danger" data-action="clearLogoImg">清除图片</button>' : ''}
          </div>
        </div>
      </div>
      <div class="card"><div class="card-title">登录页背景${canEditProtected ? '与备案号' : ''}</div>
        <div class="field"><label>登录背景图（可选，上传后替换默认渐变）</label>
          <input class="input" type="file" id="stBgFile" accept="image/*">
          ${s.login_bg ? '<button class="btn btn-sm btn-danger mt-16" data-action="clearLoginBg">清除背景图</button>' : ''}
        </div>
        ${canEditProtected ? `<div class="field"><label>ICP 备案号（登录页底部）</label><input class="input" id="stIcp" value="${esc(s.icp_no || '')}" placeholder="例如：京ICP备XXXXXXXX号"></div>
        <div class="field"><label>公安网安备案号（登录页底部）</label><input class="input" id="stPse" value="${esc(s.public_security_no || '')}" placeholder="例如：京公网安备XXXXXXXX号"></div>` : ''}
      </div>
      <div class="card"><div class="card-title">首页欢迎区背景</div>
        <div class="field"><label>首页横幅背景图（可选）</label><input class="input" type="file" id="stDashboardBgFile" accept="image/*">
          <div class="hint mt-8">建议使用横向图片，首页会自动叠加暗色遮罩以保证文字清晰。</div>
          ${s.dashboard_bg ? '<button class="btn btn-sm btn-danger mt-16" data-action="clearDashboardBg">清除首页背景图</button>' : ''}
        </div>
      </div>
    </div>
    <div class="mt-16"><button class="btn btn-primary" data-action="saveSettings">保存设置</button></div>`;
  // 图片上传处理
  $('#stLogoFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) readImageAsDataURL(f, 200, (u) => { state.brand_logo_img = u; $('#stLogoPreview').innerHTML = `<img src="${esc(u)}" alt="">`; }); });
  $('#stBgFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) readImageAsDataURL(f, 1600, (u) => { state.login_bg = u; }); });
  $('#stDashboardBgFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) readImageAsDataURL(f, 1600, (u) => { state.dashboard_bg = u; }); });
}
function readImageAsDataURL(file, maxW, cb) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(c.toDataURL('image/jpeg', 0.82));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
function clearLogoImg() { state.brand_logo_img = ''; $('#stLogoPreview').innerHTML = esc(state.settings.brand_icon || '🏊'); }
function clearLoginBg() { state.login_bg = ''; }
function clearDashboardBg() { state.dashboard_bg = ''; }
async function saveSettings() {
  if (!state.settingsLoaded) { toast('设置未加载成功，请重新加载后再保存', 'error'); return; }
  try {
    const body = {
      store_name: $('#stStoreName').value, month_rule: $('#stMonth').value, default_entry_fee: $('#stEntryFee').value,
      brand_icon: $('#stBrandIcon').value, brand_logo_img: state.brand_logo_img || '', login_bg: state.login_bg || '', dashboard_bg: state.dashboard_bg || ''
    };
    if (state.user?.role === 'admin') Object.assign(body, {
      wechat_appid: $('#stWxAppid').value, wechat_secret: $('#stWxSecret').value,
      icp_no: $('#stIcp').value, public_security_no: $('#stPse').value
    });
    const d = await api('/api/settings', { method: 'PUT', body });
    state.settings = d.settings; applyBrand(); toast('设置已保存');
  } catch (e) { toast(e.message, 'error'); }
}

/* ============================= 短信通知（仅超管） ============================= */
async function renderSmsSettings() {
  if (state.user?.role !== 'admin') { location.hash = '#/dashboard'; return; }
  const d = await api('/api/sms-settings'); const s = d.settings;
  $('#view-sms-settings').innerHTML = `<div class="card mb-16"><div class="flex-between"><div><div class="card-title">短信服务商</div><div class="hint">两套配置分别保存，切换后只使用当前选中的服务商。</div></div>
      <select class="select" id="smsProvider" style="width:180px"><option value="tencent" ${s.provider !== 'aliyun' ? 'selected' : ''}>腾讯云短信</option><option value="aliyun" ${s.provider === 'aliyun' ? 'selected' : ''}>阿里云短信</option></select></div>
      <div class="field mt-16"><label><input type="checkbox" id="smsEnabled" ${s.enabled ? 'checked' : ''}> 启用会员账户变动短信</label></div></div>
    <div class="grid cols-2 sms-provider-panel" id="smsTencentPanel" ${s.provider === 'aliyun' ? 'hidden' : ''}>
    <div class="card"><div class="card-title">腾讯云账户</div>
      <div class="field"><label>SecretId</label><input class="input" id="smsSecretId" type="password" placeholder="${s.secret_id ? '已配置，留空不修改' : '请输入腾讯云 SecretId'}"></div>
      <div class="field"><label>SecretKey</label><input class="input" id="smsSecretKey" type="password" placeholder="${s.secret_key ? '已配置，留空不修改' : '请输入腾讯云 SecretKey'}"></div>
      <div class="field"><label>短信 SdkAppId</label><input class="input" id="smsAppId" value="${esc(s.sdk_app_id)}" placeholder="例如 1400xxxxxx"></div>
    </div>
    <div class="card"><div class="card-title">签名与模板</div>
      <div class="field"><label>短信签名</label><input class="input" id="smsSignName" value="${esc(s.sign_name)}" placeholder="与腾讯云审核通过的签名完全一致"></div>
      <div class="field"><label>账户变动模板 ID</label><input class="input" id="smsTemplateId" value="${esc(s.template_account_change)}" placeholder="例如 1234567"></div>
      <div class="hint">模板变量必须依次为：{1}会员姓名、{2}业务类型、{3}变动说明。用于开卡、续费、充值、退款和入场核销通知。</div>
    </div>
  </div>
  <div class="grid cols-2 sms-provider-panel" id="smsAliyunPanel" ${s.provider !== 'aliyun' ? 'hidden' : ''}>
    <div class="card"><div class="card-title">阿里云账户</div>
      <div class="field"><label>AccessKey ID</label><input class="input" id="aliyunAccessKeyId" type="password" placeholder="${s.aliyun_access_key_id ? '已配置，留空不修改' : '请输入 RAM 用户 AccessKey ID'}"></div>
      <div class="field"><label>AccessKey Secret</label><input class="input" id="aliyunAccessKeySecret" type="password" placeholder="${s.aliyun_access_key_secret ? '已配置，留空不修改' : '请输入 AccessKey Secret'}"></div>
    </div>
    <div class="card"><div class="card-title">阿里云签名与模板</div>
      <div class="field"><label>短信签名</label><input class="input" id="aliyunSignName" value="${esc(s.aliyun_sign_name)}" placeholder="审核通过的签名，不加【】"></div>
      <div class="field"><label>账户变动模板 CODE</label><input class="input" id="aliyunTemplateId" value="${esc(s.aliyun_template_account_change)}" placeholder="例如 SMS_123456789"></div>
      <div class="hint">阿里云模板变量固定为：&#36;{name} 会员姓名、&#36;{type} 业务类型、&#36;{detail} 变动说明。变量名称必须完全一致。</div>
    </div>
  </div>
  <div class="card mt-16"><div class="field"><label>测试接收手机号</label><input class="input" id="smsTestPhone" placeholder="仅中国大陆 11 位手机号"></div>
    <div class="flex" style="gap:10px"><button class="btn btn-primary" data-action="saveSmsSettings">保存短信配置</button><button class="btn btn-outline" data-action="testSmsSettings">按当前服务商发送测试短信</button></div></div>`;
  $('#smsProvider').addEventListener('change', () => {
    const aliyun = $('#smsProvider').value === 'aliyun';
    $('#smsTencentPanel').hidden = aliyun; $('#smsAliyunPanel').hidden = !aliyun;
  });
}
async function saveSmsSettings() {
  try { await api('/api/sms-settings', { method: 'PUT', body: {
    enabled: $('#smsEnabled').checked, provider: $('#smsProvider').value,
    secret_id: $('#smsSecretId').value, secret_key: $('#smsSecretKey').value, sdk_app_id: $('#smsAppId').value, sign_name: $('#smsSignName').value, template_account_change: $('#smsTemplateId').value,
    aliyun_access_key_id: $('#aliyunAccessKeyId').value, aliyun_access_key_secret: $('#aliyunAccessKeySecret').value,
    aliyun_sign_name: $('#aliyunSignName').value, aliyun_template_account_change: $('#aliyunTemplateId').value
  } }); toast('短信配置已保存'); renderSmsSettings(); } catch (e) { toast(e.message, 'error'); }
}
async function testSmsSettings() {
  try { await api('/api/sms-settings/test', { body: { phone: $('#smsTestPhone').value } }); toast('测试短信已提交，请查收'); } catch (e) { toast(e.message, 'error'); }
}

/* ============================= 事件分发 ============================= */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  handle(el.dataset.action, el);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  handle(el.dataset.change, el);
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (!el) return;
  handle(el.dataset.input, el);
});

const memberSearchDebounced = debounce(refreshMembers, 200);
const logSearchDebounced = debounce(refreshLogs, 200);

function handle(name, el) {
  switch (name) {
    case 'recoverPending': recoverPending(el); break;
    case 'discardPending': discardPending(el); break;
    case 'searchMemberCards': searchMemberCards(); break;
    case 'memberCardsPage': memberCardsPage(el); break;
    case 'retryView': render(el.dataset.view); break;
    case 'reloadSettings': loadSettings().then(() => renderSettings()); break;
    case 'closeModal': closeModal(); break;
    case 'logout': doLogout(); break;
    case 'memberSearch': memberSearchDebounced(); break;
    case 'memberImportFile': memberImportFile(el); break;
    case 'openMemberForm': openMemberForm(el.dataset.id); break;
    case 'openMemberImport': openMemberImport(); break;
    case 'downloadMemberTemplate': downloadMemberTemplate(); break;
    case 'downloadMemberCsvTemplate': downloadMemberCsvTemplate(); break;
    case 'commitMemberImport': commitMemberImport(); break;
    case 'saveMember': saveMember(el); break;
    case 'openMember': openMember(el.dataset.id); break;
    case 'addTag': addTag(el); break;
    case 'removeTag': removeTag(el); break;
    case 'openProductForm': openProductForm(el.dataset.id); break;
    case 'saveProduct': saveProduct(el); break;
    case 'toggleProduct': toggleProduct(el); break;
    case 'cardFreeze': cardFreeze(el); break;
    case 'confirmCardFreeze': confirmCardFreeze(el); break;
    case 'cardUnfreeze': cardUnfreeze(el); break;
    case 'cardExtend': cardExtend(el); break;
    case 'confirmCardExtend': confirmCardExtend(el); break;
    case 'cardTransfer': cardTransfer(el); break;
    case 'confirmCardTransfer': confirmCardTransfer(el); break;
    case 'cardVoid': cardVoid(el); break;
    case 'confirmCardVoid': confirmCardVoid(el); break;
    case 'doCheckin': doCheckin(); break;
    case 'retryCheckin': retryCheckin(); break;
    case 'confirmCheckin': confirmCheckin(el); break;
    case 'cashierTab': renderCashierForm(el.dataset.tab); break;
    case 'cashierMemberPick': cashierMemberPick(); break;
    case 'cashierMemberSearch': cashierMemberSearch(); break;
    case 'cashierPickMember': cashierPickMember(el); break;
    case 'cashierNewMember': cashierNewMember(); break;
    case 'cashierExistingMember': cashierExistingMember(); break;
    case 'pickPayMethod': pickPayMethod(el); break;
    case 'toggleCashierFullscreen': toggleCashierFullscreen(); break;
    case 'cashierAmount': updateCashierTotal(); break;
    case 'submitCashier': submitCashier(); break;
    case 'refreshOrders': refreshOrders(); break;
    case 'refreshStaffPerformance': refreshStaffPerformance(); break;
    case 'openOrder': openOrder(el.dataset.id); break;
    case 'refundApply': refundApply(el); break;
    case 'confirmRefundApply': confirmRefundApply(el); break;
    case 'exportOrders': exportOrders(); break;
    case 'refundTab': state.refundTab = el.dataset.tab; $$('.sale-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === el.dataset.tab)); refreshRefunds(); break;
    case 'approveRefund': approveRefund(el); break;
    case 'confirmApproveRefund': confirmApproveRefund(el); break;
    case 'rejectRefund': rejectRefund(el); break;
    case 'confirmRejectRefund': confirmRejectRefund(el); break;
    case 'startShift': startShift(); break;
    case 'confirmStartShift': confirmStartShift(el); break;
    case 'startShiftFromReminder': startShiftFromReminder(); break;
    case 'openShiftClose': openShiftClose(el); break;
    case 'confirmShiftClose': confirmShiftClose(el); break;
    case 'shiftDiff': updateShiftDiff(); break;
    case 'openShift': openShift(el.dataset.id); break;
    case 'doClosing': doClosing(); break;
    case 'openClosing': openClosing(el); break;
    case 'reopenClosing': reopenClosing(el); break;
    case 'toggleMixedPay': toggleMixedPay(); break;
    case 'cashierRenewCard': cashierRenewCard(); break;
    case 'refreshReports': refreshReports(); break;
    case 'exportMembers': exportMembers(); break;
    case 'exportOrders2': exportOrders2(); break;
    case 'openStaffForm': openStaffForm(el.dataset.id); break;
    case 'saveStaff': saveStaff(el); break;
    case 'toggleStaff': toggleStaff(el); break;
    case 'logSearch': logSearchDebounced(); break;
    case 'saveSettings': saveSettings(); break;
    case 'saveSmsSettings': saveSmsSettings(); break;
    case 'testSmsSettings': testSmsSettings(); break;
    case 'clearLogoImg': clearLogoImg(); break;
    case 'clearLoginBg': clearLoginBg(); break;
    case 'clearDashboardBg': clearDashboardBg(); break;
  }
}

/* ============================= 启动 ============================= */
(async function init() {
  bindLogin();
  loadRemembered();
  const now = new Date();
  $('#todayLabel').textContent = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} 周${'日一二三四五六'[now.getDay()]}`;
  // 先加载公开品牌配置（登录页要用，无需登录）
  try {
    const pub = await api('/api/public-config');
    state.settings = { ...state.settings, ...pub.settings };
  } catch (e) { /* ignore */ }
  applyLoginBrand();
  try {
    const d = await api('/api/auth/me');
    state.user = d.user;
    await loadSettings();
    showApp();
  } catch (e) {
    // api 的 401 处理已经调用 showLogin；这里只处理网络/其他失败，避免重复签发验证码。
    if ($('#loginScreen').hidden) showLogin();
  }
})();
