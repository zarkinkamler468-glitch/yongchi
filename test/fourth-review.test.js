'use strict';

// 第四轮审查修复的回归用例：只使用独立临时库，不触碰 data/pool.db。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-fourth-'));
process.env.NODE_ENV = 'test';
process.env.PMS_DB_PATH = path.join(testDir, 'fourth.db');
process.env.PMS_SEED_DEMO = '0';
delete process.env.TRUST_PROXY;

const { db } = require('../src/db');
const orders = require('../src/api/orders');
const cards = require('../src/api/cards');
const shifts = require('../src/api/shifts');
const { clientIp } = require('../src/http');
const { today, addDays } = require('../src/util');

const staff = Object.fromEntries(db.prepare('SELECT * FROM staff').all().map((s) => [s.role, s]));
const req = (role) => ({ user: staff[role], socket: { remoteAddress: '172.17.0.1' }, headers: {} });
const product = (type) => db.prepare('SELECT * FROM card_products WHERE type = ? AND enabled = 1 ORDER BY id LIMIT 1').get(type);
const open = (type, phone, name) => orders.create({
  body: { order_type: 'open', name, phone, card_product_id: product(type).id, payments: [{ pay_method: 'cash', amount: product(type).price }] },
  req: req('frontdesk')
});

test.after(() => {
  db.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('代理 IP：默认忽略转发头，显式配置才信任单层代理', () => {
  const make = (remote, forwarded) => ({ socket: { remoteAddress: remote }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });
  assert.equal(clientIp(make('172.17.0.1', '203.0.113.9, 172.17.0.1')), '172.17.0.1');
  assert.equal(clientIp(make('203.0.113.5', '1.2.3.4')), '203.0.113.5');
  process.env.TRUST_PROXY = '1';
  assert.equal(clientIp(make('203.0.113.5', '1.2.3.4')), '1.2.3.4');
  process.env.TRUST_PROXY = '0';
  assert.equal(clientIp(make('172.17.0.1', '1.2.3.4')), '172.17.0.1');
  delete process.env.TRUST_PROXY;
});

test('交班必须填写实点现金，填写后才允许关闭', () => {
  db.prepare("UPDATE shifts SET status='closed'").run();
  const started = shifts.start({ req: req('boss'), body: { opening_cash: 0 } });
  assert.equal(started.status, 201);
  assert.equal(shifts.close({ req: req('boss'), params: { id: started.body.shift.id }, body: {} }).status, 400);
  assert.equal(shifts.close({ req: req('boss'), params: { id: started.body.shift.id }, body: { actual_cash: '' } }).status, 400);
  const closed = shifts.close({ req: req('boss'), params: { id: started.body.shift.id }, body: { actual_cash: 0 } });
  assert.equal(closed.status, 200, closed.body.error);
  assert.equal(db.prepare('SELECT actual_cash FROM shifts WHERE id=?').get(started.body.shift.id).actual_cash, 0);
});

test('老板没有班次时，现金退款归入申请人的进行中班次', () => {
  db.prepare("UPDATE shifts SET status='closed'").run();
  assert.equal(shifts.start({ req: req('frontdesk'), body: { opening_cash: 0 } }).status, 201);
  const opened = open('count', '13500000002', '退款班次');
  assert.equal(opened.status, 201, opened.body.error);
  const applied = orders.refundApply({ req: req('frontdesk'), params: { id: opened.body.order.id }, body: { amount: 10, reason: '班次归属测试' } });
  assert.equal(applied.status, 201, applied.body.error);
  const approved = orders.refundApprove({ req: req('boss'), params: { id: applied.body.refund.id }, body: { refund_method: 'cash' } });
  assert.equal(approved.status, 200, approved.body.error);
  const refund = db.prepare('SELECT * FROM orders WHERE id=?').get(applied.body.refund.id);
  const frontShift = db.prepare("SELECT * FROM shifts WHERE staff_id=? AND status='active'").get(staff.frontdesk.id);
  assert.ok(frontShift);
  assert.equal(refund.shift_id, frontShift.id);
});

test('储值卡有余额时禁止作废，余额清零后才能作废', () => {
  const opened = open('stored', '13500000001', '作废校验');
  assert.equal(opened.status, 201, opened.body.error);
  const cardId = opened.body.order.member_card_id;
  const blocked = cards.voidCard({ req: req('boss'), params: { id: cardId }, body: { reason: '测试' } });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /余额/);
  assert.equal(db.prepare('SELECT status FROM member_cards WHERE id=?').get(cardId).status, 'normal');
  db.prepare('UPDATE member_cards SET balance = 0 WHERE id = ?').run(cardId);
  assert.equal(cards.voidCard({ req: req('boss'), params: { id: cardId }, body: { reason: '测试' } }).status, 200);
});

test('新建卡项按卡种归一无关字段，开卡不会产生隐藏余额', () => {
  const created = cards.createProduct({
    req: req('boss'),
    body: { name: '次卡带储值金额', type: 'count', price: 100, duration_days: 30, total_uses: 5, stored_value: 50, entry_fee: 10, freeze_allowed: true, transfer_allowed: true, extension_allowed: true, enabled: true }
  });
  assert.equal(created.status, 201, created.body.error);
  assert.equal(Number(created.body.product.stored_value), 0);
  assert.equal(Number(created.body.product.entry_fee), 0);
  const opened = orders.create({
    body: { order_type: 'open', name: '归一测试', phone: '13500000003', card_product_id: created.body.product.id, payments: [{ pay_method: 'cash', amount: 100 }] },
    req: req('frontdesk')
  });
  assert.equal(opened.status, 201, opened.body.error);
  const card = db.prepare('SELECT * FROM member_cards WHERE member_id=?').get(opened.body.order.member_id);
  assert.equal(Number(card.balance), 0);
  assert.equal(Number(card.remaining_uses), 5);
});

test('订单响应不再下发 request_id / request_hash 等内部字段', () => {
  const created = orders.create({
    body: { order_type: 'open', name: '字段测试', phone: '13500000004', card_product_id: product('count').id, request_id: 'fourth-fields-1', payments: [{ pay_method: 'cash', amount: product('count').price }] },
    req: req('frontdesk')
  });
  assert.equal(created.status, 201, created.body.error);
  assert.equal('request_hash' in created.body.order, false);
  assert.equal('request_id' in created.body.order, false);
  const list = orders.list({ query: new URLSearchParams('page_size=5'), req: req('frontdesk') });
  assert.equal(list.status, 200);
  const row = list.body.list.find((x) => x.id === created.body.order.id);
  assert.ok(row);
  assert.equal('request_hash' in row, false);
  assert.ok(row.member_name);
  assert.ok(row.business_at);
});

test('已过期会员卡不能转卡', () => {
  const source = open('month', '13500000005', '过期转卡');
  const target = open('month', '13500000006', '接收方');
  assert.equal(source.status, 201); assert.equal(target.status, 201);
  db.prepare('UPDATE member_cards SET end_at = ? WHERE id = ?').run(addDays(today(), -1), source.body.order.member_card_id);
  const result = cards.transfer({
    req: req('boss'),
    params: { id: source.body.order.member_card_id },
    body: { to_member_id: target.body.order.member_id, reason: '过期卡' }
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /过期/);
});

test('Web 核销有未确认请求时改输入会阻止新核销，并可显式重试', async () => {
  const calls = [];
  const elements = {
    '#view-checkin': { innerHTML: '' },
    '#ckKeyword': { value: 'C-OLD', addEventListener() {} },
    '#ckPeople': { value: '1', addEventListener() {} },
    '#ckGate': { value: '前台', addEventListener() {} },
    '#ckResult': { innerHTML: '', textContent: '' },
    '#toast': { hidden: true, className: '', textContent: '' }
  };
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').split('/* ============================= 启动 ============================= */')[0];
  const context = {
    document: { addEventListener() {}, querySelector: (selector) => elements[selector] || null, querySelectorAll: () => [] },
    window: { addEventListener() {} },
    localStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    location: { hash: '#/checkin' },
    fetch: async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { status: 200, ok: true, json: async () => ({ card: { id: 9 } }) }; },
    setTimeout: () => 0,
    clearTimeout,
    URL,
    Blob
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.web={state,renderCheckin,doCheckin,retryCheckin};', context);
  const web = context.web;
  web.renderCheckin();
  const pendingBody = { keyword: 'C-OLD', gate_no: '前台', people: 1, card_id: 9, confirmed: true };
  web.state.checkinPending = { signature: JSON.stringify(pendingBody), body: { ...pendingBody, request_id: 'rid' } };
  web.state.checkinRequestId = 'rid';
  elements['#ckKeyword'].value = 'C-NEW';
  await web.doCheckin();
  assert.equal(calls.length, 0);
  assert.ok(elements['#ckResult'].innerHTML.includes('重试上一笔核销'));
  elements['#ckKeyword'].value = 'C-OLD';
  await web.retryCheckin();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/entries/checkin');
  assert.equal(calls[0].body.keyword, 'C-OLD');
  assert.equal(calls[0].body.request_id, 'rid');
  assert.equal(web.state.checkinPending, null);
});
