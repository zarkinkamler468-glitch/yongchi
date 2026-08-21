'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-test-'));
process.env.PMS_DB_PATH = path.join(testDir, 'pool-test.db');
process.env.PMS_SEED_DEMO = '0';

const { db } = require('../src/db');
const orders = require('../src/api/orders');
const reports = require('../src/api/reports');
const staffApi = require('../src/api/staff');
const membersApi = require('../src/api/members');
const entriesApi = require('../src/api/entries');
const settingsApi = require('../src/api/settings');
const shiftsApi = require('../src/api/shifts');
const cardsApi = require('../src/api/cards');
const { today, addDays } = require('../src/util');

const staff = Object.fromEntries(db.prepare('SELECT * FROM staff').all().map((s) => [s.role, s]));
const req = (role) => ({ user: staff[role], socket: { remoteAddress: '127.0.0.1' } });
const product = (type) => db.prepare('SELECT * FROM card_products WHERE type = ? AND enabled = 1 ORDER BY id LIMIT 1').get(type);

function openCard({ name, phone, type, operator = 'frontdesk', memberId }) {
  const p = product(type);
  const result = orders.create({
    body: { order_type: 'open', member_id: memberId, name, phone, card_product_id: p.id, payments: [{ pay_method: 'cash', amount: p.price }] },
    req: req(operator)
  });
  assert.equal(result.status, 201, result.body.error);
  return db.prepare('SELECT * FROM orders WHERE order_no = ?').get(result.body.order_no);
}

function requestRefund(order, amount, applicant = 'frontdesk') {
  const result = orders.refundApply({ params: { id: order.id }, body: { amount, reason: '自动化测试' }, req: req(applicant) });
  assert.equal(result.status, 201, result.body.error);
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(result.body.refund.id);
}

function approveRefund(refund, approver = 'finance') {
  return orders.refundApprove({ params: { id: refund.id }, body: { refund_method: 'cash' }, req: req(approver) });
}

test.after(() => {
  db.close();
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('已有会员可以开多张不同类型的卡', () => {
  const first = openCard({ name: '多卡会员', phone: '13900000001', type: 'count' });
  const second = openCard({ memberId: first.member_id, type: 'month' });
  assert.equal(second.member_id, first.member_id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM member_cards WHERE member_id = ?').get(first.member_id).n, 2);
});

test('次卡已消费导致权益不足时拒绝退款且不生成退款流水', () => {
  const order = openCard({ name: '次卡退款', phone: '13900000002', type: 'count' });
  const card = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(order.member_card_id);
  db.prepare('UPDATE member_cards SET remaining_uses = 5 WHERE id = ?').run(card.id);
  const refund = requestRefund(order, 225);
  const result = approveRefund(refund);
  assert.equal(result.status, 400);
  assert.match(result.body.error, /剩余次数不足/);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(refund.id).status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE order_id = ?').get(refund.id).n, 0);
});

test('储值权益已消费后拒绝超额退款', () => {
  const order = openCard({ name: '储值退款', phone: '13900000003', type: 'stored' });
  db.prepare('UPDATE member_cards SET balance = 20 WHERE id = ?').run(order.member_card_id);
  const refund = requestRefund(order, 100);
  const result = approveRefund(refund);
  assert.equal(result.status, 400);
  assert.match(result.body.error, /可退权益不足/);
  assert.equal(db.prepare('SELECT balance FROM member_cards WHERE id = ?').get(order.member_card_id).balance, 20);
});

test('月卡续费部分退款按比例回退有效期', () => {
  const open = openCard({ name: '月卡退款', phone: '13900000004', type: 'month' });
  const p = product('month');
  const beforeRenew = db.prepare('SELECT end_at FROM member_cards WHERE id = ?').get(open.member_card_id).end_at;
  const renew = orders.create({ body: { order_type: 'renew', member_id: open.member_id, member_card_id: open.member_card_id, card_product_id: p.id, payments: [{ pay_method: 'cash', amount: p.price }] }, req: req('frontdesk') });
  assert.equal(renew.status, 201, renew.body.error);
  const renewOrder = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(renew.body.order_no);
  const afterRenew = db.prepare('SELECT end_at FROM member_cards WHERE id = ?').get(open.member_card_id).end_at;
  const refund = requestRefund(renewOrder, p.price / 2);
  const approved = approveRefund(refund);
  assert.equal(approved.status, 200, approved.body.error);
  const afterRefund = db.prepare('SELECT end_at FROM member_cards WHERE id = ?').get(open.member_card_id).end_at;
  assert.equal(afterRefund, addDays(afterRenew, -Math.ceil(renewOrder.benefit_days / 2)));
  assert.ok(afterRefund > beforeRenew);
});

test('员工绩效退款回冲原销售员工而不是审批人', () => {
  const order = openCard({ name: '绩效退款', phone: '13900000005', type: 'count', operator: 'frontdesk' });
  const refund = requestRefund(order, 25);
  const approved = approveRefund(refund, 'finance');
  assert.equal(approved.status, 200, approved.body.error);
  const query = new URLSearchParams({ from: today(), to: today() });
  const result = reports.staffPerformance({ query });
  const seller = result.body.list.find((r) => r.id === staff.frontdesk.id);
  const approver = result.body.list.find((r) => r.id === staff.finance.id);
  assert.ok(Number(seller.refund_amount) >= 25);
  assert.equal(approver.refund_amount, 0);
});

test('混合支付多次原路退款不会对同一渠道超退', () => {
  const p = product('count');
  const created = orders.create({ body: { order_type: 'open', name: '混合支付', phone: '13900000007', card_product_id: p.id, payments: [{ pay_method: 'cash', amount: 200 }, { pay_method: 'wechat', amount: p.price - 200 }] }, req: req('frontdesk') });
  assert.equal(created.status, 201, created.body.error);
  const order = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(created.body.order_no);
  let refund = requestRefund(order, 125);
  assert.equal(orders.refundApprove({ params: { id: refund.id }, body: { refund_method: 'original' }, req: req('finance') }).status, 200);
  refund = requestRefund(order, 125);
  assert.equal(orders.refundApprove({ params: { id: refund.id }, body: { refund_method: 'original' }, req: req('finance') }).status, 200);
  const rows = db.prepare(`SELECT p.pay_method, SUM(-p.amount) amount FROM payments p JOIN orders r ON r.id=p.order_id WHERE r.original_order_id=? AND p.amount<0 GROUP BY p.pay_method`).all(order.id);
  const totals = Object.fromEntries(rows.map((r) => [r.pay_method, r.amount]));
  assert.equal(totals.cash, 200);
  assert.equal(totals.wechat, 50);
});

test('不能移除最后一个启用状态的老板角色', () => {
  const result = staffApi.update({ params: { id: staff.boss.id }, body: { real_name: staff.boss.real_name, role: 'frontdesk', status: 'active' }, req: req('admin') });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /至少保留一名启用状态的老板/);
});

test('会员标签可以添加、重复添加和删除', () => {
  const order = openCard({ name: '标签会员', phone: '13900000006', type: 'count' });
  const first = membersApi.addTag({ params: { id: order.member_id }, body: { tag_name: '重点会员' }, req: req('frontdesk') });
  const second = membersApi.addTag({ params: { id: order.member_id }, body: { tag_name: '重点会员' }, req: req('frontdesk') });
  assert.equal(first.status, 200);
  assert.equal(second.body.tags.length, 1);
  const removed = membersApi.removeTag({ params: { id: order.member_id, tagId: first.body.tags[0].id }, req: req('frontdesk') });
  assert.equal(removed.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM member_tags WHERE member_id = ?').get(order.member_id).n, 0);
});

test('保存普通设置不会误清空微信 AppSecret', () => {
  db.prepare("UPDATE settings SET value = 'secret-kept' WHERE key = 'wechat_secret'").run();
  const saved = settingsApi.update({ body: { store_name: '测试门店', wechat_secret: '' }, req: req('admin') });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.store_name, '测试门店');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'wechat_secret'").get().value, 'secret-kept');
  assert.equal(saved.body.settings.wechat_secret, '');
});

test('核销记录写入失败时不会扣减会员卡权益', () => {
  const order = openCard({ name: '事务核销', phone: '13900000008', type: 'count' });
  const before = db.prepare('SELECT remaining_uses FROM member_cards WHERE id = ?').get(order.member_card_id).remaining_uses;
  db.exec("CREATE TRIGGER test_abort_entry BEFORE INSERT ON entries WHEN NEW.result='success' BEGIN SELECT RAISE(ABORT, 'test abort'); END;");
  const result = entriesApi.checkin({ body: { keyword: db.prepare('SELECT member_no FROM members WHERE id = ?').get(order.member_id).member_no, people: 1, confirmed: true }, req: req('frontdesk') });
  db.exec('DROP TRIGGER test_abort_entry');
  assert.equal(result.status, 500);
  assert.equal(db.prepare('SELECT remaining_uses FROM member_cards WHERE id = ?').get(order.member_card_id).remaining_uses, before);
});

test('储值支付原路退款退回实际扣款的储值卡', () => {
  const first = openCard({ name: '多储值卡', phone: '13900000009', type: 'stored' });
  const second = openCard({ memberId: first.member_id, type: 'stored' });
  db.prepare('UPDATE member_cards SET balance = 10 WHERE id = ?').run(first.member_card_id);
  const secondBefore = db.prepare('SELECT balance FROM member_cards WHERE id = ?').get(second.member_card_id).balance;
  const p = product('count');
  const created = orders.create({ body: { order_type: 'open', member_id: first.member_id, card_product_id: p.id, payments: [{ pay_method: 'stored', amount: p.price }] }, req: req('frontdesk') });
  assert.equal(created.status, 201, created.body.error);
  const sale = db.prepare('SELECT * FROM orders WHERE order_no = ?').get(created.body.order_no);
  const pay = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(sale.id);
  assert.equal(pay.source_card_id, second.member_card_id);
  const afterPay = db.prepare('SELECT balance FROM member_cards WHERE id = ?').get(second.member_card_id).balance;
  const refund = requestRefund(sale, 25);
  const approved = orders.refundApprove({ params: { id: refund.id }, body: { refund_method: 'original' }, req: req('finance') });
  assert.equal(approved.status, 200, approved.body.error);
  assert.equal(db.prepare('SELECT balance FROM member_cards WHERE id = ?').get(second.member_card_id).balance, afterPay + 25);
  assert.equal(db.prepare('SELECT balance FROM member_cards WHERE id = ?').get(first.member_card_id).balance, 10);
  assert.equal(secondBefore - afterPay, p.price);
});

test('前台不能为其他前台经手的订单申请退款', () => {
  const order = openCard({ name: '退款权限', phone: '13900000010', type: 'count', operator: 'frontdesk' });
  const another = { ...staff.frontdesk, id: Number(staff.frontdesk.id) + 1000, role: 'frontdesk' };
  const result = orders.refundApply({ params: { id: order.id }, body: { amount: 10 }, req: { user: another } });
  assert.equal(result.status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM orders WHERE original_order_id = ? AND order_type = 'refund'").get(order.id).n, 0);
});

test('冻结会员卡不能续费或储值充值', () => {
  const order = openCard({ name: '冻结卡业务', phone: '13900000011', type: 'stored' });
  db.prepare("UPDATE member_cards SET status = 'frozen' WHERE id = ?").run(order.member_card_id);
  const productStored = product('stored');
  const result = orders.create({ body: { order_type: 'recharge', member_id: order.member_id, member_card_id: order.member_card_id, amount: 100, payments: [{ pay_method: 'cash', amount: 100 }] }, req: req('frontdesk') });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /冻结/);
  const renew = orders.create({ body: { order_type: 'renew', member_id: order.member_id, member_card_id: order.member_card_id, card_product_id: productStored.id, payments: [{ pay_method: 'cash', amount: productStored.price }] }, req: req('frontdesk') });
  assert.equal(renew.status, 400);
  assert.match(renew.body.error, /冻结/);
});

test('老板不能通过普通设置接口修改短信密钥', () => {
  const result = settingsApi.update({ body: { store_name: '正常名称', sms_secret_key: 'not-allowed' }, req: req('boss') });
  assert.equal(result.status, 403);
  assert.notEqual(db.prepare("SELECT value FROM settings WHERE key='sms_secret_key'").get().value, 'not-allowed');
});

test('储值卡不能使用自身新增余额支付充值订单', () => {
  const opened = openCard({ name: '禁止自充自付', phone: '13900000012', type: 'stored' });
  db.prepare('UPDATE member_cards SET balance = 0 WHERE id = ?').run(opened.member_card_id);
  const result = orders.create({ body: { order_type: 'recharge', member_id: opened.member_id, member_card_id: opened.member_card_id, amount: 100, payments: [{ pay_method: 'stored', amount: 100 }] }, req: req('frontdesk') });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /余额不足/);
  assert.equal(db.prepare('SELECT balance FROM member_cards WHERE id = ?').get(opened.member_card_id).balance, 0);
});

test('相同请求编号重复收银只生成一张订单', () => {
  const p = product('count');
  const body = { order_type: 'open', name: '幂等收银', phone: '13900000013', card_product_id: p.id, request_id: 'same-order-request', payments: [{ pay_method: 'cash', amount: p.price }] };
  const first = orders.create({ body, req: req('frontdesk') });
  const second = orders.create({ body, req: req('frontdesk') });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.repeated, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM orders WHERE request_id='same-order-request'").get().n, 1);
});

test('相同请求编号重复核销只扣减一次', () => {
  const opened = openCard({ name: '幂等核销', phone: '13900000014', type: 'count' });
  const memberNo = db.prepare('SELECT member_no FROM members WHERE id = ?').get(opened.member_id).member_no;
  const body = { keyword: memberNo, card_id: opened.member_card_id, people: 1, confirmed: true, request_id: 'same-entry-request' };
  const before = db.prepare('SELECT remaining_uses FROM member_cards WHERE id = ?').get(opened.member_card_id).remaining_uses;
  assert.equal(entriesApi.checkin({ body, req: req('frontdesk') }).status, 200);
  const repeated = entriesApi.checkin({ body, req: req('frontdesk') });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.repeated, true);
  assert.equal(db.prepare('SELECT remaining_uses FROM member_cards WHERE id = ?').get(opened.member_card_id).remaining_uses, before - 1);
});

test('开班备用金计入应交现金', () => {
  const fake = { ...staff.frontdesk, id: staff.frontdesk.id + 2000 };
  const started = shiftsApi.start({ req: { user: fake }, body: { opening_cash: 200 } });
  assert.equal(started.status, 201);
  assert.equal(shiftsApi.shiftSummary(started.body.shift.id).cash_should, 200);
});

test('前台不能查看其他员工班次详情', () => {
  const financeShift = shiftsApi.start({ req: req('finance'), body: { opening_cash: 0 } }).body.shift;
  const result = shiftsApi.get({ params: { id: financeShift.id }, req: req('frontdesk') });
  assert.equal(result.status, 403);
});

test('已发卡的卡项不能修改卡种类型', () => {
  const opened = openCard({ name: '卡项类型锁定', phone: '13900000015', type: 'count' });
  const p = db.prepare('SELECT cp.* FROM card_products cp JOIN member_cards mc ON mc.card_product_id=cp.id WHERE mc.id=?').get(opened.member_card_id);
  const result = cardsApi.updateProduct({ params: { id: p.id }, body: { ...p, type: 'stored', stored_value: 100 } });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /不能修改卡种类型/);
});

test('储值余额内部消费不会重复计入实际收入', () => {
  const stored = openCard({ name: '内部余额支付', phone: '13900000016', type: 'stored' });
  const before = reports.dashboard({ req: req('boss') }).body.today_income;
  const p = product('count');
  const sale = orders.create({ body: { order_type: 'open', member_id: stored.member_id, card_product_id: p.id, payments: [{ pay_method: 'stored', amount: p.price }] }, req: req('frontdesk') });
  assert.equal(sale.status, 201, sale.body.error);
  const after = reports.dashboard({ req: req('boss') }).body.today_income;
  assert.equal(after, before);
});
