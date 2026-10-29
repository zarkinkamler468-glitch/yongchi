'use strict';

// 2026-10-29 复核问题的回归测试：续费退款快照、待确认放弃、内部字段、验证码启动去重、401 解析。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-20261029-'));
process.env.NODE_ENV = 'test';
process.env.PMS_DB_PATH = path.join(dir, 'fix.db');
process.env.PMS_SEED_DEMO = '0';
delete process.env.TRUST_PROXY;

const { db } = require('../src/db');
const orders = require('../src/api/orders');
const cards = require('../src/api/cards');
const entries = require('../src/api/entries');
const members = require('../src/api/members');
const shifts = require('../src/api/shifts');
const { today, addDays } = require('../src/util');

const staff = Object.fromEntries(db.prepare('SELECT * FROM staff').all().map(s => [s.role, s]));
const req = role => ({ user: staff[role], headers: {}, socket: { remoteAddress: '127.0.0.1' } });
let seq = 0;
const product = (duration_days, type = 'count') => {
  const p = cards.createProduct({ body: { name: `复核修复卡-${++seq}`, type, price: 100, total_uses: type === 'count' ? 10 : 0, duration_days, enabled: true } });
  assert.equal(p.status, 201, p.body.error);
  return p.body.product;
};
const open = (p, method = 'wechat') => {
  const r = orders.create({ req: req('frontdesk'), body: { order_type: 'open', name: `复核修复会员-${++seq}`, card_product_id: p.id, payments: [{ pay_method: method, amount: p.price }] } });
 	assert.equal(r.status, 201, r.body.error);
  return r.body.order;
};
const renew = (o, p, method = 'wechat') => orders.create({ req: req('frontdesk'), body: { order_type: 'renew', member_id: o.member_id, member_card_id: o.member_card_id, card_product_id: p.id, payments: [{ pay_method: method, amount: p.price }] } });
const refund = (order, amount) => {
  const app = orders.refundApply({ req: req('frontdesk'), params: { id: order.id }, body: { amount, reason: '复核回归' } });
  assert.equal(app.status, 201, app.body.error);
  return app.body.refund;
};
const approve = (refundOrder) => orders.refundApprove({ req: req('finance'), params: { id: refundOrder.id }, body: { refund_method: 'original' } });
const cardRow = o => db.prepare('SELECT * FROM member_cards WHERE id=?').get(o.member_card_id);
const cardNo = o => cardRow(o).card_no;

test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('过期卡续费后全额退款恢复续费前的有效期，过期次数不会复活', () => {
  const p = product(30);
  const o = open(p);
  const oldEnd = addDays(today(), -30);
  db.prepare("UPDATE member_cards SET end_at=?, status='expired' WHERE id=?").run(oldEnd, o.member_card_id);
  const r = renew(o, p);
  assert.equal(r.status, 201, r.body.error);
  const renewOrder = db.prepare('SELECT * FROM orders WHERE id=?').get(r.body.order.id);
  assert.equal(renewOrder.benefit_end_before, oldEnd);
  assert.equal(renewOrder.benefit_end_after, addDays(today(), 30));
  const app = refund(r.body.order, 100);
  const approved = approve(app);
  assert.equal(approved.status, 200, approved.body.error);
  const card = cardRow(o);
  assert.equal(card.end_at, oldEnd);
  assert.equal(cards.decorateCard(card).status, 'expired');
  assert.equal(card.remaining_uses, 10);
  const preview = entries.preview({ query: new URLSearchParams({ keyword: cardNo(o) }) });
  assert.equal(preview.status, 400);
  assert.match(preview.body.error, /过期/);
});

test('过期卡续费后先核销再全额退款被拒绝，退款保持待审', () => {
  const p = product(30);
  const o = open(p);
  db.prepare("UPDATE member_cards SET end_at=?, status='expired' WHERE id=?").run(addDays(today(), -5), o.member_card_id);
  const r = renew(o, p);
  assert.equal(r.status, 201, r.body.error);
  const used = entries.checkin({ req: req('frontdesk'), body: { keyword: cardNo(o), confirmed: true, people: 1 } });
  assert.equal(used.status, 200, used.body.error);
  const app = refund(r.body.order, 100);
  const rejected = approve(app);
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /核销/);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(app.id).status, 'pending');
  assert.equal(cardRow(o).end_at, addDays(today(), 30));
  assert.equal(cardRow(o).remaining_uses, 19);
});

test('未过期卡续费全额退款仍恢复到续费前日期', () => {
  const p = product(30);
  const o = open(p);
  const oldEnd = addDays(today(), 10);
  db.prepare("UPDATE member_cards SET end_at=?, status='normal' WHERE id=?").run(oldEnd, o.member_card_id);
  const r = renew(o, p);
  assert.equal(r.status, 201, r.body.error);
  const app = refund(r.body.order, 100);
  assert.equal(approve(app).status, 200);
  assert.equal(cardRow(o).end_at, oldEnd);
  assert.equal(cardRow(o).remaining_uses, 10);
  assert.equal(entries.preview({ query: new URLSearchParams({ keyword: cardNo(o) }) }).status, 200);
});

test('不限期卡续有限期卡项后全额退款仍保持不限期', () => {
  const unlimited = product(0);
  const o = open(unlimited);
  assert.equal(cardRow(o).end_at, null);
  const limited = product(30);
  const r = renew(o, limited);
  assert.equal(r.status, 201, r.body.error);
  assert.equal(cardRow(o).end_at, null);
  const app = refund(r.body.order, 100);
  assert.equal(approve(app).status, 200);
  assert.equal(cardRow(o).end_at, null);
  assert.equal(cardRow(o).remaining_uses, 10);
});

test('续费后又有后续续费时，旧续费单不能全额退款', () => {
  const p = product(30);
  const o = open(p);
  db.prepare("UPDATE member_cards SET end_at=?, status='normal' WHERE id=?").run(addDays(today(), 10), o.member_card_id);
  const first = renew(o, p);
  const second = renew(o, p);
  assert.equal(first.status, 201, first.body.error);
  assert.equal(second.status, 201, second.body.error);
  const app = refund(first.body.order, 100);
  const result = approve(app);
  assert.equal(result.status, 400);
  assert.match(result.body.error, /其他变更/);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(app.id).status, 'pending');
});

test('会员详情、卡详情、班次详情不再下发 request_id/request_hash', () => {
  const p = product(30);
  const o = open(p, 'cash');
  assert.equal(entries.checkin({ req: req('frontdesk'), body: { keyword: cardNo(o), confirmed: true, people: 1, request_id: 'hide-entry-1' } }).status, 200);
  const memberDetail = members.get({ params: { id: o.member_id }, req: req('frontdesk') });
  assert.equal(memberDetail.status, 200);
  assert.ok(memberDetail.body.orders.length > 0);
  assert.ok(memberDetail.body.entries.length > 0);
  for (const row of [...memberDetail.body.orders, ...memberDetail.body.entries]) {
    assert.equal('request_id' in row, false);
    assert.equal('request_hash' in row, false);
  }
  const cardDetail = cards.getCard({ params: { id: o.member_card_id }, req: req('frontdesk') });
  assert.equal(cardDetail.status, 200);
  assert.ok(cardDetail.body.entries.length > 0);
  assert.equal('request_id' in cardDetail.body.entries[0], false);
  const shiftDetail = shifts.get({ params: { id: o.shift_id }, req: req('frontdesk') });
  assert.equal(shiftDetail.status, 200);
  assert.ok(shiftDetail.body.orders.length > 0);
  assert.equal('request_id' in shiftDetail.body.orders[0], false);
});

function loadWeb(elements, fetchImpl, storage = new Map()) {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').split('/* ============================= 启动 ============================= */')[0];
  const context = {
    document: { addEventListener() {}, querySelector: s => elements[s] || null, querySelectorAll: () => [] },
    window: { addEventListener() {} },
    localStorage: { getItem: k => storage.get(k) || '', setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    location: { hash: '#/checkin' }, fetch: fetchImpl,
    setTimeout: () => 0, clearTimeout() {}, AbortController, URL, URLSearchParams, Blob
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.web={state,api,pendingRequest,discardPending};', context);
  context.web.state.user = { id: 7, role: 'frontdesk' };
  return context.web;
}

test('待确认记录可核对后放弃，放弃后允许新业务', async () => {
  const elements = { '#toast': { hidden: true, className: '', textContent: '' }, '#pendingRecovery': { hidden: true, innerHTML: '' } };
  const storage = new Map();
  const w = loadWeb(elements, async () => ({ status: 200, ok: true, json: async () => ({ card: { id: 1 } }) }), storage);
  w.pendingRequest('checkin', { keyword: 'C-OLD', people: 1, confirmed: true });
  assert.equal(storage.size, 1);
  await w.discardPending({ dataset: { scope: 'checkin' } });
  assert.equal(storage.size, 0);
  assert.equal(w.state.checkinPending, null);
  const next = w.pendingRequest('checkin', { keyword: 'C-NEW', people: 1, confirmed: true });
  assert.ok(next.request_id);
});

test('未登录启动只签发一次验证码', async () => {
  let captchaCalls = 0;
  const elements = {};
  for (const id of ['#loginScreen', '#app', '#loginStoreName', '#loginTitle', '#loginLogo', '#loginFooter', '#captchaImg', '#loginForm', '#loginUsername', '#loginPassword', '#loginCaptcha', '#rememberPwd', '#loginError', '#modalOverlay', '#modalBox', '#toast', '#brandLogo', '#brandName', '#storeName', '#pageTitle', '#todayLabel']) {
    elements[id] = { hidden: true, style: {}, innerHTML: '', textContent: '', value: '', checked: false, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } };
  }
  const context = {
    document: { addEventListener() {}, querySelector: s => elements[s] || null, querySelectorAll: () => [] },
    window: { addEventListener() {} },
    localStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    location: { hash: '#/dashboard' },
    fetch: async (url) => {
      if (url === '/api/auth/captcha') { captchaCalls++; return { status: 200, ok: true, json: async () => ({ captcha_token: 't' + captchaCalls, image_path: '/x' }) }; }
      if (url === '/api/public-config') return { status: 200, ok: true, json: async () => ({ settings: {} }) };
      if (url === '/api/auth/me') return { status: 401, ok: false, json: async () => ({ error: '未登录' }) };
      return { status: 200, ok: true, json: async () => ({}) };
    },
    setTimeout, clearTimeout, AbortController, URL, URLSearchParams, Blob
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(captchaCalls, 1);
});

test('401 响应体不是 JSON 时也会清理会话', async () => {
  const elements = {
    '#loginScreen': { hidden: true }, '#app': { hidden: false }, '#loginStoreName': { textContent: '' },
    '#captchaImg': { innerHTML: '' }, '#modalOverlay': { hidden: false }, '#modalBox': { innerHTML: '' },
    '#toast': { hidden: true, className: '', textContent: '' }
  };
  const storage = new Map([['pms_token', 'old-token']]);
  const w = loadWeb(elements, async (url) => {
    if (url === '/api/auth/captcha') return { status: 200, ok: true, json: async () => ({ captcha_token: 't', image_path: '/x' }) };
    return { status: 401, ok: false, json: async () => { throw new SyntaxError('html'); } };
  }, storage);
  w.state.user = { id: 7 };
  await assert.rejects(w.api('/api/entries/checkin', { body: {} }));
  assert.equal(storage.has('pms_token'), false);
  assert.equal(w.state.user, null);
  assert.equal(elements['#loginScreen'].hidden, false);
});
