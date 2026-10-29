'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const http = require('node:http');
const { Readable } = require('node:stream');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-regression-'));
process.env.NODE_ENV = 'test';
process.env.PMS_DB_PATH = path.join(dir, 'review.db');
process.env.PMS_SEED_DEMO = '0';
const { db, setSettings } = require('../src/db');
const orders = require('../src/api/orders');
const members = require('../src/api/members');
const cards = require('../src/api/cards');
const entries = require('../src/api/entries');
const shifts = require('../src/api/shifts');
const closings = require('../src/api/closings');
const reports = require('../src/api/reports');
const { computeCardEnd } = require('../src/api/common');
const { today, addDays, cents, money } = require('../src/util');
const { verifyPassword } = require('../src/crypto');
const { createSession, findStaffByToken } = require('../src/auth');
const { buildRouter } = require('../src/api');
const { sendJSON } = require('../src/http');
const staff = Object.fromEntries(db.prepare('SELECT * FROM staff').all().map(x => [x.role, x]));
const req = role => ({ user: staff[role] });
const query = obj => new URLSearchParams(obj);
const product = type => db.prepare('SELECT * FROM card_products WHERE type=? ORDER BY id').get(type);
const card = o => db.prepare('SELECT * FROM member_cards WHERE id=?').get(o.member_card_id);
let seq = 0;
function sale(type, memberId, role = 'frontdesk', payments) {
  const p = product(type);
  return orders.create({ req: req(role), body: { order_type: 'open', name: `回归会员${++seq}`, member_id: memberId, card_product_id: p.id, payments: payments || [{ pay_method: 'cash', amount: p.price }] } });
}
function open(...args) { const r = sale(...args); assert.equal(r.status, 201, r.body.error); return r.body.order; }
function refund(o, amount, requestId) {
  const r = orders.refundApply({ req: req('boss'), params: { id: o.id }, body: { amount, reason: '回归验证', request_id: requestId } });
  assert.ok(r.status < 300, r.body.error); return r.body.refund;
}
const approve = r => orders.refundApprove({ req: req('finance'), params: { id: r.id }, body: { refund_method: 'cash' } });
const preview = (keyword, people = 1) => entries.preview({ query: query({ keyword, people }) });
const checkin = (o, people = 1, requestId) => entries.checkin({ req: req('frontdesk'), body: { keyword: card(o).card_no, card_id: o.member_card_id, confirmed: true, people, request_id: requestId } });

for (const type of ['month', 'year']) {
  test(`${type} 期限卡拒绝多人预览和直接核销，单人权益与人数正确`, () => {
    const o = open(type); const before = { ...card(o) };
    for (const people of [2, 100]) {
      const p = preview(before.card_no, people);
      assert.equal(p.status, 400); assert.match(p.body.error, /仅限持卡会员本人/);
      const r = checkin(o, people);
      assert.equal(r.status, 400); assert.match(r.body.error, /人数必须为 1 人/);
    }
    assert.deepEqual({ ...card(o) }, before);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM entries WHERE member_card_id=? AND result='success'").get(o.member_card_id).n, 0);
    const failures = db.prepare("SELECT fail_reason,deducted_uses,deducted_amount FROM entries WHERE member_card_id=? AND result='fail'").all(o.member_card_id);
    assert.equal(failures.length, 2);
    for (const failure of failures) {
      assert.match(failure.fail_reason, /仅限持卡会员本人/);
      assert.equal(failure.deducted_uses, 0); assert.equal(failure.deducted_amount, 0);
    }
    assert.equal(preview(before.card_no).body.card.people, 1);
    assert.equal(checkin(o).status, 200);
    assert.equal(db.prepare("SELECT people FROM entries WHERE member_card_id=? AND result='success'").get(o.member_card_id).people, 1);
    assert.deepEqual({ ...card(o) }, before);
  });

  test(`${type} 期限卡不能通过会员编号、手机号或指定卡 ID 绕过单人限制`, () => {
    const o = open(type);
    const phone = '139' + String(++seq).padStart(8, '0');
    db.prepare('UPDATE members SET phone=? WHERE id=?').run(phone, o.member_id);
    const m = db.prepare('SELECT * FROM members WHERE id=?').get(o.member_id);
    for (const keyword of [m.member_no, phone]) {
      for (const cardId of [undefined, o.member_card_id]) {
        const params = { keyword, people: 2 };
        if (cardId) params.card_id = cardId;
        const p = entries.preview({ query: query(params) });
        assert.equal(p.status, 400); assert.match(p.body.error, /仅限持卡会员本人/);
        const r = entries.checkin({ req: req('frontdesk'), body: { ...params, confirmed: true } });
        assert.equal(r.status, 400); assert.match(r.body.error, /仅限持卡会员本人/);
      }
    }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM entries WHERE member_id=? AND result='success'").get(o.member_id).n, 0);
  });
}

for (const type of ['count', 'stored']) {
  test(`多人自动选卡跳过月卡和年卡，使用 ${type} 卡按人数扣减`, () => {
    const month = open('month'); const year = open('year', month.member_id);
    const paid = open(type, month.member_id); const before = card(paid);
    const m = db.prepare('SELECT * FROM members WHERE id=?').get(month.member_id);
    const p = preview(m.member_no, 3);
    assert.equal(p.status, 200); assert.equal(p.body.card.id, paid.member_card_id);
    // 指定期限卡不能静默切换到付费卡。
    assert.equal(checkin(month, 3).status, 400); assert.equal(checkin(year, 3).status, 400);
    const r = entries.checkin({ req: req('frontdesk'), body: { keyword: m.member_no, people: 3, confirmed: true } });
    assert.equal(r.status, 200); assert.equal(r.body.card.id, paid.member_card_id);
    if (type === 'count') {
      assert.equal(r.body.deducted_uses, 3); assert.equal(card(paid).remaining_uses, before.remaining_uses - 3);
    } else {
      const fee = p.body.card.preview_deducted_amount;
      assert.ok(fee > 0); assert.equal(r.body.deducted_amount, fee); assert.equal(card(paid).balance, before.balance - fee);
    }
    assert.equal(db.prepare("SELECT people FROM entries WHERE member_card_id=? AND result='success'").get(paid.member_card_id).people, 3);
  });
}
test.after(() => {
  db.close();
  for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
  fs.rmdirSync(dir);
});

test('金额拒绝非有限数、越界和超过两位小数，失败时无余额或订单残留', () => {
  const o = open('stored');
  for (const value of ['1e309', 'Infinity', 'NaN', 1000000001, 1.001, -1, true, {}]) {
    const before = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
    const r = orders.create({ req: req('boss'), body: { order_type: 'recharge', member_id: o.member_id, member_card_id: o.member_card_id, amount: value, payments: [{ pay_method: 'cash', amount: value }] } });
    assert.equal(r.status, 400, String(value));
    assert.equal(card(o).balance, 500); assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, before);
  }
  assert.equal(cents('0.29'), 29); assert.equal(money(0.1 + 0.2), 0.3);
  assert.throws(() => db.prepare('UPDATE member_cards SET balance=? WHERE id=?').run(Infinity, o.member_card_id), /安全范围/);
  assert.throws(() => db.prepare('UPDATE member_cards SET balance=-1 WHERE id=?').run(o.member_card_id), /安全范围/);
});

test('支付差一分钱必须拒绝，正确小数混合支付精确记账', () => {
  assert.equal(sale('count', undefined, 'frontdesk', [{ pay_method: 'cash', amount: 249.99 }]).status, 400);
  const o = open('count', undefined, 'frontdesk', [{ pay_method: 'cash', amount: 0.29 }, { pay_method: 'wechat', amount: 249.71 }]);
  assert.equal(o.paid_amount, 250);
  assert.equal(Math.round(db.prepare('SELECT SUM(amount) amount FROM payments WHERE order_id=?').get(o.id).amount * 100), 25000);
});

test('查询和核销不提前解冻第二张及之后的冻结卡', () => {
  const first = open('count'); const second = open('month', first.member_id); const third = open('stored', first.member_id);
  for (const o of [second, third]) assert.equal(cards.freeze({ req: req('boss'), params: { id: o.member_card_id }, body: { frozen_until: addDays(today(), 10) } }).status, 200);
  const m = db.prepare('SELECT * FROM members WHERE id=?').get(first.member_id);
  assert.equal(preview(m.member_no).status, 200);
  assert.equal(entries.checkin({ req: req('frontdesk'), body: { keyword: m.member_no, people: 1, confirmed: true } }).status, 200);
  assert.equal(card(second).status, 'frozen'); assert.equal(card(third).status, 'frozen');
  assert.equal(cards.refreshFrozenCard(card(second), 1).status, 'frozen');
});

test('会员详情限制前台订单，老板保留完整范围', () => {
  const o = open('count', undefined, 'boss');
  const mine = open('stored', o.member_id);
  assert.equal(orders.get({ params: { id: o.id }, req: req('frontdesk') }).status, 403);
  const front = members.get({ params: { id: o.member_id }, req: req('frontdesk') }).body.orders;
  assert.deepEqual(front.map(x => x.id), [mine.id]);
  assert.equal(members.get({ params: { id: o.member_id }, req: req('boss') }).body.orders.length, 2);
});

test('会员详情刷新到期自动解冻与过期状态', () => {
  const o = open('count'); const before = card(o).end_at;
  db.prepare("UPDATE member_cards SET status='frozen',frozen_from=?,frozen_until=? WHERE id=?").run(addDays(today(), -2), today(), o.member_card_id);
  const refreshed = members.get({ req: req('boss'), params: { id: o.member_id } }).body.cards[0];
  assert.equal(refreshed.status, 'normal'); assert.equal(refreshed.end_at, addDays(before, 2));
  db.prepare('UPDATE member_cards SET end_at=? WHERE id=?').run(addDays(today(), -1), o.member_card_id);
  assert.equal(members.get({ req: req('boss'), params: { id: o.member_id } }).body.cards[0].status, 'expired');
});

test('首页提醒和到期卡报表刷新已到截止日的冻结卡', () => {
  const o = open('count');
  db.prepare("UPDATE member_cards SET status='frozen',frozen_from=?,frozen_until=?,end_at=? WHERE id=?").run(addDays(today(), -1), today(), addDays(today(), 2), o.member_card_id);
  reports.dashboard({ req: req('boss') }); assert.equal(card(o).status, 'normal');
  const page = reports.cardsExpiring({ query: query({ days: 7 }) }).body;
  assert.ok(page.list.some(c => c.id === o.member_card_id)); assert.equal(page.total, page.list.length);
});

test('过期卡延期后可重新核销，冻结卡延期不绕过冻结', () => {
  const o = open('count');
  db.prepare("UPDATE member_cards SET status='expired',end_at=? WHERE id=?").run(addDays(today(), -1), o.member_card_id);
  assert.equal(cards.extend({ req: req('boss'), params: { id: o.member_card_id }, body: { days: 30 } }).status, 200);
  assert.equal(preview(card(o).card_no).status, 200);
  cards.freeze({ req: req('boss'), params: { id: o.member_card_id }, body: {} });
  cards.extend({ req: req('boss'), params: { id: o.member_card_id }, body: { days: 1 } });
  assert.equal(preview(card(o).card_no).status, 400);
});

test('自动选卡按本次人数和余额选择，显式卡不静默替换', () => {
  const first = open('stored'); const next = open('count', first.member_id);
  db.prepare('UPDATE member_cards SET balance=0 WHERE id=?').run(first.member_card_id);
  const m = db.prepare('SELECT * FROM members WHERE id=?').get(first.member_id);
  assert.equal(preview(m.member_no, 3).body.card.id, next.member_card_id);
  assert.equal(preview(card(first).card_no).status, 400);
  assert.equal(entries.checkin({ req: req('frontdesk'), body: { keyword: m.member_no, people: 3, confirmed: true } }).body.deducted_uses, 3);
});

test('多人次在首页、报表、日结一致，非法人数不扣减', () => {
  const o = open('count');
  const before = closings.computeDaily(today()).total_entries;
  assert.equal(checkin(o, 3).body.deducted_uses, 3);
  assert.equal(closings.computeDaily(today()).total_entries - before, 3);
  assert.equal(reports.dashboard({ req: req('boss') }).body.today_entries, before + 3);
  assert.equal(reports.overview({ query: query({ from: today(), to: today() }) }).body.entries, before + 3);
  for (const n of [0, -1, 1.5, 101, 'abc']) { assert.equal(preview(card(o).card_no, n).status, 400); assert.equal(checkin(o, n).status, 400); }
  assert.equal(card(o).remaining_uses, 7);
});

test('储值支付拒绝未来生效卡，明确来源只扣选中卡，原路退回该卡', () => {
  const a = open('stored'); const b = open('stored', a.member_id);
  db.prepare('UPDATE member_cards SET start_at=? WHERE id=?').run(addDays(today(), 10), a.member_card_id);
  assert.equal(sale('count', a.member_id, 'frontdesk', [{ pay_method: 'stored', amount: 250, source_card_id: a.member_card_id }]).status, 400);
  const o = open('count', a.member_id, 'frontdesk', [{ pay_method: 'cash', amount: 100 }, { pay_method: 'stored', amount: 150, source_card_id: b.member_card_id }]);
  assert.equal(card(a).balance, 500); assert.equal(card(b).balance, 350);
  const r = refund(o, 250);
  assert.equal(orders.refundApprove({ req: req('finance'), params: { id: r.id }, body: { refund_method: 'original' } }).status, 200);
  assert.equal(card(b).balance, 500); assert.equal(card(a).balance, 500);
});

test('退款请求编号不能跨原订单复用，同订单重试保持幂等', () => {
  const a = open('count'); const b = open('count'); const id = 'regression-refund';
  const first = refund(a, 10, id);
  assert.equal(refund(a, 10, id).id, first.id);
  const r = orders.refundApply({ req: req('boss'), params: { id: b.id }, body: { amount: 10, reason: '回归验证', request_id: id } });
  assert.equal(r.status, 409);
});

test('历史期限卡无可靠权益快照时禁止自动退款', () => {
  const o = open('month'); const before = card(o).end_at;
  db.prepare('UPDATE orders SET benefit_days=0,benefit_snapshot_known=0 WHERE id=?').run(o.id);
  const r = refund(o, 150); const result = approve(r);
  assert.equal(result.status, 400); assert.match(result.body.error, /人工核算/);
  assert.equal(card(o).end_at, before); assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE order_id=?').get(r.id).n, 0);
});

test('自然月续费覆盖月末、闰年、跨年和过期重购', () => {
  setSettings({ month_rule: 'natural' });
  try {
    assert.equal(computeCardEnd('month', 30, '2024-01-31', true), '2024-02-29');
    assert.equal(computeCardEnd('month', 30, '2025-01-31', true), '2025-02-28');
    assert.equal(computeCardEnd('month', 30, '2026-12-31', true), '2027-01-31');
    assert.equal(computeCardEnd('month', 30, '2026-10-13', false), '2026-10-31');
    const o = open('month'); const p = product('month');
    const before = card(o).end_at;
    const result = orders.create({ req: req('frontdesk'), body: { order_type: 'renew', member_id: o.member_id, member_card_id: o.member_card_id, card_product_id: p.id, payments: [{ pay_method: 'cash', amount: p.price }] } });
    assert.equal(result.status, 201); assert.equal(card(o).end_at, computeCardEnd('month', 30, before, true));
    assert.ok(result.body.order.benefit_days > 0);
  } finally { setSettings({ month_rule: 'purchase' }); }
});

test('跨日退款按审批日导出，负向实付金额正确', () => {
  const o = open('count'); const r = refund(o, 10); assert.equal(approve(r).status, 200);
  db.prepare('UPDATE orders SET created_at=? WHERE id=?').run(addDays(today(), -2) + 'T08:00:00', r.id);
  const q = query({ from: today(), to: today() });
  assert.ok(orders.list({ query: q, req: req('boss') }).body.list.some(x => x.id === r.id));
  const csv = reports.exportOrders({ query: q }).body.csv;
  const line = csv.split('\n').find(x => x.startsWith(r.order_no + ','));
  assert.ok(line); assert.match(line, /,-10,/); assert.ok(line.endsWith(today() + line.slice(line.lastIndexOf('T'))));
});

test('已停用员工历史销售退款仍计入当天绩效', () => {
  const o = open('count'); db.prepare('UPDATE orders SET created_at=? WHERE id=?').run(addDays(today(), -2) + 'T08:00:00', o.id);
  const r = refund(o, 10); assert.equal(approve(r).status, 200);
  const all = db.prepare('SELECT id,created_at FROM orders WHERE staff_id=?').all(staff.frontdesk.id);
  try {
    for (const row of all) db.prepare('UPDATE orders SET created_at=? WHERE id=?').run(addDays(today(), -2) + 'T08:00:00', row.id);
    db.prepare("UPDATE staff SET status='inactive' WHERE id=?").run(staff.frontdesk.id);
    const row = reports.staffPerformance({ query: query({ from: today(), to: today() }) }).body.list.find(x => x.id === staff.frontdesk.id);
    assert.ok(row); assert.ok(row.refund_amount >= 10); assert.equal(row.net_amount, -row.refund_amount);
  } finally {
    db.prepare("UPDATE staff SET status='active' WHERE id=?").run(staff.frontdesk.id);
    for (const row of all) db.prepare('UPDATE orders SET created_at=? WHERE id=?').run(row.created_at, row.id);
  }
});

test('会员分页越过旧的1000条限制，total真实且无重复', () => {
  const insert = db.prepare("INSERT INTO members(member_no,name,status,created_at,updated_at) VALUES(?,?,'normal',?,?)");
  db.exec('BEGIN');
  for (let i = 0; i < 1005; i++) insert.run('PAGE-' + i, '分页会员-' + i, today(), today());
  db.exec('COMMIT');
  const first = members.list({ query: query({ search: '分页会员-', page_size: 1000 }) }).body;
  const next = members.list({ query: query({ search: '分页会员-', page_size: 1000, page: 2 }) }).body;
  assert.equal(first.total, 1005); assert.equal(first.list.length, 1000); assert.equal(first.has_more, true);
  assert.equal(next.list.length, 5); assert.equal(next.has_more, false);
  assert.equal(new Set([...first.list, ...next.list].map(x => x.id)).size, 1005);
  assert.throws(() => members.list({ query: query({ page: -1 }) }), /分页参数/);
});

test('日结后阻止新业务，重开须老板和原因，重结后再次锁定', () => {
  const o = open('count'); const pending = refund(o, 10);
  db.prepare("UPDATE shifts SET status='closed'").run();
  assert.equal(closings.create({ req: req('finance'), body: { business_date: today() } }).status, 200);
  try {
    assert.equal(sale('count').status, 409); assert.equal(checkin(o).status, 409); assert.equal(approve(pending).status, 409);
    assert.equal(members.create({ req: req('frontdesk'), body: { name: '日结会员' } }).status, 409);
    assert.equal(shifts.start({ req: req('frontdesk'), body: {} }).status, 409);
    assert.equal(closings.get({ params: { date: today() } }).body.preview.total_income, closings.get({ params: { date: today() } }).body.closing.total_income);
    assert.equal(closings.reopen({ req: req('finance'), params: { date: today() }, body: { reason: '补录' } }).status, 403);
    assert.equal(closings.reopen({ req: req('boss'), params: { date: today() }, body: {} }).status, 400);
    assert.equal(closings.reopen({ req: req('boss'), params: { date: today() }, body: { reason: '补录收款' } }).status, 200);
    open('count');
    assert.equal(shifts.start({ req: req('boss'), body: { opening_cash: 0 } }).status, 201);
    assert.equal(approve(pending).status, 200);
    db.prepare("UPDATE shifts SET status='closed'").run();
    assert.equal(closings.create({ req: req('finance'), body: { business_date: today() } }).status, 200);
    assert.equal(sale('count').status, 409);
  } finally { db.prepare('DELETE FROM daily_closings WHERE business_date=?').run(today()); }
});

function loadPage(file, requestImpl) {
  let page;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/' + file), 'utf8'), {
    Page: value => { page = value; }, require: id => id.includes('request') ? { request: requestImpl, toast: () => {} } : require('../miniprogram/utils/util'),
    wx: { showLoading() {}, hideLoading() {}, showModal() {} }, setTimeout, clearTimeout
  });
  page.data = { ...page.data }; page.setData = patch => Object.assign(page.data, patch); return page;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function loadWeb(elements, fetchImpl) {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').split('/* ============================= 启动 ============================= */')[0];
  const document = {
    addEventListener() {},
    querySelector: selector => elements[selector] || null,
    querySelectorAll: selector => selector === '.cs-split' ? elements.splits || [] : []
  };
  const context = { document, window: { addEventListener() {} }, localStorage: { getItem: () => '', setItem() {}, removeItem() {} }, location: { hash: '#/cashier' }, fetch: fetchImpl, setTimeout: () => 0, clearTimeout, URL, Blob };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.web={state,api,submitCashier,confirmCheckin,doCheckin};', context);
  return { context, web: context.web };
}

test('Web 混合支付提交多笔并拒绝错误合计，保留请求快照', async () => {
  let sent; let calls = 0;
  const elements = {
    '#csProduct': { value: '1' }, '#csDiscount': { value: '0' }, '#csMixed': { checked: true }, '#csStoredSource': { value: '9' },
    '#toast': {}, splits: [{ dataset: { method: 'cash' }, value: '100' }, { dataset: { method: 'stored' }, value: '150' }]
  };
  const { web } = loadWeb(elements, async (url, opts) => {
    calls++; sent = JSON.parse(opts.body);
    return { status: 400, ok: false, json: async () => ({ error: '测试请求捕获' }) };
  });
  Object.assign(web.state, { cashierTab: 'open', cashierMember: { id: 5 }, products: [{ id: 1, price: 250 }] });
  await web.submitCashier();
  assert.equal(sent.payments.length, 2); assert.equal(sent.payments[1].source_card_id, 9);
  assert.equal(sent.payments.reduce((sum, p) => sum + p.amount, 0), 250);
  elements.splits[0].value = '99'; await web.submitCashier(); assert.equal(calls, 1);
});

test('Web 核销确认发送冻结的预览参数，不重新读取人数输入框', async () => {
  let sent;
  const { web } = loadWeb({ '#ckPeople': { value: '3' }, '#ckResult': {}, '#toast': {} }, async (url, opts) => {
    sent = JSON.parse(opts.body); return { status: 200, ok: true, json: async () => ({ card: { id: 7 } }) };
  });
  web.state.checkinPreview = { keyword: 'C-confirmed', people: 1, card_id: 7, gate_no: '前台' };
  await web.confirmCheckin({ disabled: false });
  assert.equal(sent.people, 1); assert.equal(sent.keyword, 'C-confirmed'); assert.equal(web.state.checkinPreview, null);
});

test('Web 自动加载分页保留真实总量，不递归重复第一页', async () => {
  const paths = [];
  const { web } = loadWeb({}, async url => {
    paths.push(url); const second = url.includes('page=2');
    return { status: 200, ok: true, json: async () => ({ list: [{ id: second ? 2 : 1 }], page: second ? 2 : 1, total: 2, has_more: !second }) };
  });
  const result = await web.api('/api/members?status=normal');
  assert.equal(result.list.length, 2); assert.equal(result.total, 2); assert.equal(paths.length, 2);
  assert.equal(paths[1], '/api/members?status=normal&page=2');
});

test('小程序自动加载后续页保留真实总量', async () => {
  const urls = []; const context = {
    module: { exports: {} },
    require: () => ({ BASE_URL: 'http://fixture.local' }),
    wx: { getStorageSync: () => '', request: opts => {
      urls.push(opts.url); const second = opts.url.includes('page=2');
      opts.success({ statusCode: 200, data: { list: [{ id: second ? 2 : 1 }], page: second ? 2 : 1, total: 2, has_more: !second } });
    } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/request.js'), 'utf8'), context);
  const data = await context.module.exports.request('/api/members');
  assert.equal(data.list.length, 2); assert.equal(data.total, 2); assert.equal(urls.length, 2);
});

test('小程序修改核销条件清除预览，乱序响应不得恢复旧预览', async () => {
  let resolve; let calls = 0;
  const page = loadPage('checkin/checkin.js', () => { calls++; return new Promise(r => { resolve = r; }); });
  page.data.keyword = 'C-old'; page.submit();
  page.onInput({ currentTarget: { dataset: { key: 'people' } }, detail: { value: '3' } });
  resolve({ member: {}, card: { id: 1, people: 1 } }); await tick();
  assert.equal(page.data.preview, null); page.confirm(); assert.equal(calls, 1);
});

test('小程序核销确认只发送预览快照', async () => {
  let sent;
  const page = loadPage('checkin/checkin.js', (url, opts) => { sent = opts.data; return Promise.resolve({}); });
  page.data.preview = { keyword: 'C-original', gate_no: '前台', people: 1, card_id: 2 };
  page.data.keyword = 'C-other'; page.data.people = 3; page.confirm(); await tick();
  assert.equal(sent.keyword, 'C-original'); assert.equal(sent.people, 1);
});

test('小程序混合支付提交多笔与选定储值来源，错误合计不请求', async () => {
  let sent; let calls = 0;
  const page = loadPage('cashier/cashier.js', (url, opts) => { calls++; sent = opts.data; return Promise.resolve({ amount: 250 }); });
  page.loadBase = () => {};
  Object.assign(page.data, { tab: 'open', selectedMember: { id: 3 }, products: [{ id: 1, price: 250 }], payAmount: 250, mixedPay: true, splitCash: 100, splitStored: 150, storedCards: [{ id: 6 }], storedCardIndex: 0 });
  page.submit(); await tick();
  assert.equal(sent.payments.length, 2); assert.equal(sent.payments[1].source_card_id, 6);
  Object.assign(page.data, { tab: 'open', selectedMember: { id: 3 }, products: [{ id: 1, price: 250 }], payAmount: 250, mixedPay: true, splitCash: 99, splitStored: 150 });
  page.submit(); assert.equal(calls, 1);
});

function restartCopy(name, mutate, env = {}) {
  const target = path.join(dir, name + '.db'); db.prepare('VACUUM INTO ?').run(target);
  const copy = new DatabaseSync(target); mutate(copy); copy.close();
  const modulePath = path.resolve(__dirname, '../src/db.js');
  const childEnv = { ...process.env, PMS_DB_PATH: target, NODE_ENV: 'test', ...env };
  if (env.PMS_INITIAL_ADMIN_PASSWORD === null) delete childEnv.PMS_INITIAL_ADMIN_PASSWORD;
  return { target, run: spawnSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}).db.close()`], { env: childEnv, encoding: 'utf8' }) };
}

test('旧库缺超管时要求显式凭证，不生成无法取得密码的账号', () => {
  const failed = restartCopy('missing-admin', copy => copy.exec("DELETE FROM staff WHERE role='admin'"), { PMS_INITIAL_ADMIN_PASSWORD: null });
  assert.notEqual(failed.run.status, 0); assert.match(failed.run.stderr, /PMS_INITIAL_ADMIN_PASSWORD/);
  const check = new DatabaseSync(failed.target); assert.equal(check.prepare("SELECT COUNT(*) n FROM staff WHERE role='admin'").get().n, 0); check.close();
  const password = 'RegressionFixture2026';
  const success = restartCopy('admin-provision', copy => copy.exec("DELETE FROM staff WHERE role='admin'"), { PMS_INITIAL_ADMIN_PASSWORD: password });
  assert.equal(success.run.status, 0, success.run.stderr);
  const verify = new DatabaseSync(success.target); assert.ok(verifyPassword(password, verify.prepare("SELECT password_hash FROM staff WHERE role='admin'").get().password_hash)); verify.close();
});

test('旧入场人数只回填次卡，重启不使用现卡项重算历史权益', () => {
  const o = open('count'); checkin(o, 3);
  const copied = restartCopy('entry-migration', copy => {
    copy.exec("ALTER TABLE entries DROP COLUMN people; DELETE FROM settings WHERE key='migration_entry_people_v1';");
    copy.prepare('UPDATE orders SET benefit_uses=0,benefit_snapshot_known=0 WHERE id=?').run(o.id);
  });
  assert.equal(copied.run.status, 0, copied.run.stderr);
  const check = new DatabaseSync(copied.target);
  assert.equal(check.prepare("SELECT people FROM entries WHERE member_card_id=? AND result='success'").get(o.member_card_id).people, 3);
  assert.equal(check.prepare('SELECT benefit_uses FROM orders WHERE id=?').get(o.id).benefit_uses, 0); check.close();
});

test('真实HTTP路由验证会员订单权限、分页与日结重开权限', async () => {
  const o = open('count', undefined, 'boss'); const router = buildRouter();
  const token = createSession(staff.frontdesk.id).token;
  const server = http.createServer(async (request, response) => {
    request.user = findStaffByToken((request.headers.authorization || '').replace('Bearer ', ''));
    if (!request.user) return sendJSON(response, 401, { error: '未登录' });
    try { if (!(await router.handle(request, response))) sendJSON(response, 404, {}); } catch (e) { sendJSON(response, 500, { error: e.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port; const headers = { Authorization: 'Bearer ' + token };
    for (const type of ['month', 'year']) {
      const personal = open(type); const keyword = card(personal).card_no;
      const p = await fetch(base + '/api/entries/preview?' + query({ keyword, people: 2 }), { headers });
      assert.equal(p.status, 400); assert.match((await p.json()).error, /仅限持卡会员本人/);
      const r = await fetch(base + '/api/entries/checkin', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword, card_id: personal.member_card_id, people: 2, confirmed: true }) });
      assert.equal(r.status, 400); assert.match((await r.json()).error, /仅限持卡会员本人/);
    }
    assert.equal((await fetch(base + '/api/orders/' + o.id, { headers })).status, 403);
    const detail = await (await fetch(base + '/api/members/' + o.member_id, { headers })).json(); assert.equal(detail.orders.length, 0);
    const paged = await (await fetch(base + '/api/members?page_size=2&page=2', { headers })).json(); assert.equal(paged.list.length, 2); assert.ok(paged.total > 1000);
    assert.equal((await fetch(base + '/api/closings/' + today() + '/reopen', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: '越权重开' }) })).status, 403);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
