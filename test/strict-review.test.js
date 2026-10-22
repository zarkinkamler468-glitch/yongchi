'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-strict-'));
process.env.NODE_ENV = 'test';
process.env.PMS_DB_PATH = path.join(dir, 'strict.db');
process.env.PMS_SEED_DEMO = '0';
const { db, setSettings } = require('../src/db');
const orders = require('../src/api/orders');
const entries = require('../src/api/entries');
const cards = require('../src/api/cards');
const shifts = require('../src/api/shifts');
const reports = require('../src/api/reports');
const closings = require('../src/api/closings');
const members = require('../src/api/members');
const { buildRouter } = require('../src/api');
const { today, addDays } = require('../src/util');
const staff = Object.fromEntries(db.prepare('SELECT * FROM staff').all().map(x => [x.role, x]));
const req = role => ({ user: staff[role] });
const query = o => new URLSearchParams(o);
const product = type => db.prepare('SELECT * FROM card_products WHERE type=? ORDER BY id').get(type);
const card = o => db.prepare('SELECT * FROM member_cards WHERE id=?').get(o.member_card_id);
let seq = 0;
function open(type, memberId, payments) {
  const p = product(type);
  const r = orders.create({ req: req('frontdesk'), body: { order_type: 'open', name: '严格审查' + (++seq), member_id: memberId, card_product_id: p.id, payments: payments || [{ pay_method: 'cash', amount: p.price }] } });
  assert.equal(r.status, 201, r.body.error); return r.body.order;
}
const checkin = o => entries.checkin({ req: req('frontdesk'), body: { keyword: card(o).card_no, people: 1, confirmed: true } });
test.after(() => {
  db.close();
  for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
  fs.rmdirSync(dir);
});

test('储值入场连续扣小数至零，不因浮点尾差拒绝足额余额', () => {
  const o = open('stored');
  db.prepare('UPDATE member_cards SET balance=0.3,entry_fee=0.1 WHERE id=?').run(o.member_card_id);
  for (let i = 0; i < 3; i++) assert.equal(checkin(o).status, 200);
  assert.equal(card(o).balance, 0);
  assert.equal(checkin(o).status, 400);
});

test('储值拆分支付和原路退款按分落账，累计充值无尾差', () => {
  const source = open('stored'); const p = product('count');
  db.prepare('UPDATE member_cards SET balance=0.3 WHERE id=?').run(source.member_card_id);
  db.prepare('UPDATE card_products SET price=0.3 WHERE id=?').run(p.id);
  try {
    const paid = open('count', source.member_id, [0.1, 0.2].map(amount => ({ pay_method: 'stored', amount, source_card_id: source.member_card_id })));
    assert.equal(card(source).balance, 0);
    const r = orders.refundApply({ req: req('frontdesk'), params: { id: paid.id }, body: { amount: 0.3, reason: '小数原路退' } });
    assert.equal(r.status, 201);
    assert.equal(orders.refundApprove({ req: req('finance'), params: { id: r.body.refund.id }, body: { refund_method: 'original' } }).status, 200);
    assert.equal(card(source).balance, 0.3);
    db.prepare('UPDATE member_cards SET balance=0.1 WHERE id=?').run(source.member_card_id);
    const recharge = orders.create({ req: req('frontdesk'), body: { order_type: 'recharge', member_id: source.member_id, member_card_id: source.member_card_id, amount: 0.2, payments: [{ pay_method: 'cash', amount: 0.2 }] } });
    assert.equal(recharge.status, 201); assert.equal(card(source).balance, 0.3);
  } finally { db.prepare('UPDATE card_products SET price=? WHERE id=?').run(p.price, p.id); }
});

test('全额退款通过后同编号申请重试返回原结果，不因原单状态变化失败', () => {
  const o = open('count'); const body = { amount: o.paid_amount, reason: '幂等复核', request_id: 'strict-refund' };
  const args = { req: req('frontdesk'), params: { id: o.id }, body };
  const first = orders.refundApply(args); assert.equal(first.status, 201);
  assert.equal(orders.refundApprove({ req: req('finance'), params: { id: first.body.refund.id }, body: { refund_method: 'cash' } }).status, 200);
  const retry = orders.refundApply(args); assert.equal(retry.status, 200); assert.equal(retry.body.repeated, true);
  assert.equal(retry.body.refund.id, first.body.refund.id);
  assert.equal(orders.refundApply({ ...args, body: { ...body, amount: 1 } }).status, 409);
});

test('退款审批响应丢失后可重复确认，不增加支付流水或再回收权益', () => {
  const o = open('count');
  const applied = orders.refundApply({ req: req('frontdesk'), params: { id: o.id }, body: { amount: 25, reason: '审批重试' } });
  const args = { req: req('finance'), params: { id: applied.body.refund.id }, body: { refund_method: 'cash' } };
  assert.equal(orders.refundApprove(args).status, 200);
  const before = { ...card(o) }; const n = db.prepare('SELECT COUNT(*) n FROM payments').get().n;
  const again = orders.refundApprove(args); assert.equal(again.status, 200); assert.equal(again.body.repeated, true);
  assert.deepEqual({ ...card(o) }, before); assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, n);
});

test('原路储值退款拒绝退入已作废来源卡，保持退款待审且资金权益不变', () => {
  const source = open('stored');
  const paid = open('count', source.member_id, [{ pay_method: 'stored', amount: 250, source_card_id: source.member_card_id }]);
  // 新规则禁止作废仍有余额的储值卡，先把余额清零（模拟已退款）再作废。
  db.prepare('UPDATE member_cards SET balance = 0 WHERE id = ?').run(source.member_card_id);
  assert.equal(cards.voidCard({ req: req('boss'), params: { id: source.member_card_id }, body: {} }).status, 200);
  const applied = orders.refundApply({ req: req('frontdesk'), params: { id: paid.id }, body: { amount: 250, reason: '作废来源卡退款' } });
  const before = { ...card(paid) }; const balance = card(source).balance;
  const approved = orders.refundApprove({ req: req('finance'), params: { id: applied.body.refund.id }, body: { refund_method: 'original' } });
  assert.equal(approved.status, 400); assert.match(approved.body.error, /无法原路退回/);
  assert.deepEqual({ ...card(paid) }, before); assert.equal(card(source).balance, balance);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(applied.body.refund.id).status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE order_id=?').get(applied.body.refund.id).n, 0);
});

test('退款比例用整数分计算，整除边界不多收回次数或天数', () => {
  const p = product('count'); db.prepare('UPDATE card_products SET price=0.35 WHERE id=?').run(p.id);
  try {
    const o = open('count');
    const r = orders.refundApply({ req: req('frontdesk'), params: { id: o.id }, body: { amount: 0.07, reason: '精确收回两次' } });
    assert.equal(orders.refundApprove({ req: req('finance'), params: { id: r.body.refund.id }, body: { refund_method: 'cash' } }).status, 200);
    assert.equal(card(o).remaining_uses, 8);
  } finally { db.prepare('UPDATE card_products SET price=? WHERE id=?').run(p.price, p.id); }
  const month = product('month'); db.prepare('UPDATE card_products SET price=0.35,duration_days=10 WHERE id=?').run(month.id);
  try {
    const o = open('month'); const before = card(o).end_at;
    const r = orders.refundApply({ req: req('frontdesk'), params: { id: o.id }, body: { amount: 0.07, reason: '精确收回两天' } });
    assert.equal(orders.refundApprove({ req: req('finance'), params: { id: r.body.refund.id }, body: { refund_method: 'cash' } }).status, 200);
    assert.equal(card(o).end_at, addDays(before, -2));
  } finally { db.prepare('UPDATE card_products SET price=?,duration_days=? WHERE id=?').run(month.price, month.duration_days, month.id); }
});

test('交班和开班拒绝多余小数及错误类型金额，不静默舍入', () => {
  db.prepare("UPDATE shifts SET status='closed'").run();
  for (const opening_cash of [0.001, true, {}, 1000000001]) {
    const r = shifts.start({ req: req('boss'), body: { opening_cash } });
    assert.equal(r.status, 400);
  }
  const started = shifts.start({ req: req('boss'), body: { opening_cash: 0.29 } }); assert.equal(started.status, 201);
  for (const actual_cash of [0.001, true, {}, 1000000001]) {
    const r = shifts.close({ req: req('boss'), params: { id: started.body.shift.id }, body: { actual_cash, note: '不能掩盖无效金额' } });
    assert.equal(r.status, 400);
    assert.equal(db.prepare('SELECT status FROM shifts WHERE id=?').get(started.body.shift.id).status, 'active');
  }
  assert.equal(shifts.close({ req: req('boss'), params: { id: started.body.shift.id }, body: { actual_cash: 0.29 } }).status, 200);
});

test('到期报表支持当天0天范围，拒绝非数字和小数查询天数', () => {
  const o = open('count'); db.prepare('UPDATE member_cards SET end_at=? WHERE id=?').run(addDays(today(), 1), o.member_card_id);
  assert.ok(!reports.cardsExpiring({ query: query({ days: 0 }) }).body.list.some(c => c.id === o.member_card_id));
  for (const days of ['abc', 'NaN', 0.5, -1]) assert.equal(reports.cardsExpiring({ query: query({ days }) }).status, 400);
});

test('日结详情拒绝无效日期，避免输出NaN日期下的误导性零汇总', () => {
  for (const date of ['2026-02-30', 'abc', '2026-1-1']) assert.equal(closings.get({ params: { date } }).status, 400);
});

test('会员生日和性别在手工建档与编辑中执行与导入相同的校验', () => {
  for (const body of [{ birthday: '2026-02-30' }, { birthday: addDays(today(), 1) }, { gender: 'arbitrary' }]) {
    assert.equal(members.create({ req: req('frontdesk'), body: { name: '无效资料', ...body } }).status, 400);
  }
  const o = open('count'); const m = db.prepare('SELECT * FROM members WHERE id=?').get(o.member_id);
  assert.equal(members.update({ req: req('frontdesk'), params: { id: m.id }, body: { name: m.name, birthday: '2026-02-30' } }).status, 400);
  assert.equal(db.prepare('SELECT birthday FROM members WHERE id=?').get(m.id).birthday, null);
});

test('CSV姓名和备注中的前导空白公式及回车正确转义', () => {
  const created = members.create({ req: req('boss'), body: { name: 'CSV审查', note: '\t=1+1\r后续' } }); assert.equal(created.status, 201);
  const csv = reports.exportMembers().body.csv;
  assert.ok(csv.includes('"\'=1+1\r后续"'));
  db.prepare('UPDATE members SET note=? WHERE id=?').run('\t=1+1\r后续', created.body.member.id);
  assert.ok(reports.exportMembers().body.csv.includes('"\'\t=1+1\r后续"'));
});

test('HTTP拒绝非对象JSON和错误字段类型，失败不能留下部分业务变更', async () => {
  const router = buildRouter(); const server = http.createServer(async (request, response) => {
    request.user = staff.frontdesk; await router.handle(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const body of [[], 1, 'invalid', { name: {} }, { name: '部分变更', reason: {} }]) {
      const before = db.prepare('SELECT COUNT(*) n FROM members').get().n;
      const response = await fetch(base + '/api/members', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM members').get().n, before);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

function loadPage(file, requestImpl) {
  let page;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/' + file), 'utf8'), {
    Page: value => { page = value; }, require: id => id.includes('request') ? { request: requestImpl, toast() {} } : require('../miniprogram/utils/util'),
    wx: { showLoading() {}, hideLoading() {}, showModal() {} }, setTimeout, clearTimeout
  });
  page.data = { ...page.data }; page.setData = patch => Object.assign(page.data, patch); return page;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('小程序收银卡列表乱序响应不能覆盖后来选中的会员', async () => {
  const pending = [];
  const page = loadPage('cashier/cashier.js', () => new Promise(resolve => pending.push(resolve)));
  page.data.tab = 'recharge'; page.data.selectedMember = { id: 1 }; page.loadCards(1);
  page.data.selectedMember = { id: 2 }; page.loadCards(2);
  pending[1]({ list: [{ id: 22, card_type: 'stored' }] }); await tick();
  pending[0]({ list: [{ id: 11, card_type: 'stored' }] }); await tick();
  assert.equal(page.data.cards[0].id, 22);
});

test('小程序重新搜索会员立即清除原会员与卡，避免对原会员收款', () => {
  const page = loadPage('cashier/cashier.js', () => Promise.resolve({ list: [] }));
  Object.assign(page.data, { selectedMember: { id: 1 }, cards: [{ id: 11 }], storedCards: [{ id: 12 }] });
  page.searchMember({ detail: { value: '另一个会员' } }); clearTimeout(page._memberSearchTimer);
  assert.equal(page.data.selectedMember, null); assert.equal(page.data.cards.length, 0); assert.equal(page.data.storedCards.length, 0);
});

test('小程序微信绑定密码错误仅显示错误，不重启登录丢失绑定会话', async () => {
  let relaunched = 0; const removed = [];
  const context = { module: { exports: {} }, require: () => ({ BASE_URL: 'http://fixture.local' }), wx: {
    getStorageSync: () => '', removeStorageSync: key => removed.push(key), reLaunch: () => relaunched++,
    request: opts => opts.success({ statusCode: 401, data: { error: '账号或密码错误' } })
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/request.js'), 'utf8'), context);
  await assert.rejects(context.module.exports.request('/api/auth/wxbind', { data: {} }), /账号或密码错误/);
  assert.equal(relaunched, 0); assert.equal(removed.length, 0);
});

test('微信服务器无响应时请求有超时并销毁连接，不无限挂起', async () => {
  let options; let destroyed = false;
  const outgoing = new EventEmitter(); outgoing.destroy = error => { destroyed = true; outgoing.emit('error', error); };
  const context = { module: { exports: {} }, require: id => {
    if (id === 'node:https') return { get: (url, opts) => { options = opts; return outgoing; } };
    if (id === '../db') return { db, getSetting: () => 'fixture-only' };
    if (id === '../crypto') return require('../src/crypto');
    if (id === '../auth') return require('../src/auth');
    return require('../src/http');
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/api/auth.js'), 'utf8'), context);
  const pending = context.module.exports.wxLogin({ body: { code: 'fixture-only' } });
  assert.equal(options.timeout, 10000); outgoing.emit('timeout');
  await assert.rejects(pending, /请求超时/); assert.equal(destroyed, true);
});

function loadWeb(elements, fetchImpl) {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').split('/* ============================= 启动 ============================= */')[0];
  const context = { document: { addEventListener() {}, querySelector: s => elements[s] || null, querySelectorAll: () => [] },
    window: { addEventListener() {} }, localStorage: { getItem: () => '', setItem() {}, removeItem() {} }, location: {}, fetch: fetchImpl,
    setTimeout: () => 0, clearTimeout, URL, Blob };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.web={state,setToken,doCheckin,confirmCheckin,loadMemberCards,cashierMemberSearch,cashierRenewCard,pendingRequest,clearPending,refreshOrders,openOrder};', context);
  return context.web;
}

test('Web重新搜索会员清除选中项，旧卡列表响应不能覆盖新会员', async () => {
  const elements = { '#csCard': { innerHTML: '' }, '#csMemberResults': {}, '#csMemberSelected': {}, '#csStoredSource': {} };
  const pending = [];
  const web = loadWeb(elements, () => new Promise(resolve => pending.push(resolve)));
  Object.assign(web.state, { cashierTab: 'recharge', cashierMember: { id: 1 } });
  const first = web.loadMemberCards(1);
  web.state.cashierMember = { id: 2 }; const second = web.loadMemberCards(2);
  const response = id => ({ status: 200, ok: true, json: async () => ({ list: [{ id, card_type: 'stored', status: 'normal' }] }) });
  pending[1](response(22)); await second; pending[0](response(11)); await first;
  assert.ok(elements['#csCard'].innerHTML.includes('value="22"')); assert.ok(!elements['#csCard'].innerHTML.includes('value="11"'));
  web.cashierMemberSearch(); assert.equal(web.state.cashierMember, null); assert.ok(elements['#csCard'].innerHTML.includes('请先选择会员'));
});

test('Web续费选项只显示所选卡种，切换卡后刷新应收', () => {
  const elements = { '#csCard': { value: '2' }, '#csProduct': { value: '20' }, '#csPayable': {}, '#csPayAmount': {}, '#csDiscount': { value: '0' } };
  const web = loadWeb(elements, () => {});
  Object.assign(web.state, { cashierTab: 'renew', cashierCards: [{ id: 2, card_type: 'month' }], products: [{ id: 10, type: 'count', price: 250 }, { id: 20, type: 'month', name: '月卡', price: 300 }] });
  web.cashierRenewCard();
  assert.ok(elements['#csProduct'].innerHTML.includes('value="20"')); assert.ok(!elements['#csProduct'].innerHTML.includes('value="10"'));
  assert.equal(elements['#csPayAmount'].value, 300);
});

test('Web核销网络断开后再查询仍重试原请求，不能生成新编号重复扣减', async () => {
  const sent = []; let applied = 0; const seen = new Set();
  const web = loadWeb({ '#ckKeyword': { value: 'C-original' }, '#ckPeople': { value: '1' }, '#ckGate': { value: '前台' }, '#ckResult': {}, '#toast': { classList: { toggle() {} } } }, async (url, opts) => {
    assert.equal(url, '/api/entries/checkin'); const body = JSON.parse(opts.body); sent.push(body);
    if (!seen.has(body.request_id)) { seen.add(body.request_id); applied++; }
    if (sent.length === 1) throw new Error('响应丢失');
    return { status: 200, ok: true, json: async () => ({}) };
  });
  web.state.checkinPreview = { keyword: 'C-original', card_id: 1, people: 1, gate_no: '前台' };
  await web.confirmCheckin({ disabled: false });
  await web.doCheckin();
  assert.equal(sent.length, 2); assert.equal(sent[0].request_id, sent[1].request_id); assert.equal(applied, 1);
  assert.equal(web.state.checkinPending, null);
});

test('Web收银未知结果期间不能改变订单参数，原参数重试保持编号', () => {
  const web = loadWeb({}, () => {}); const body = { order_type: 'recharge', amount: 10 };
  const first = web.pendingRequest('cashier', body);
  web.clearPending('cashier', new Error('断线'));
  assert.throws(() => web.pendingRequest('cashier', { ...body, amount: 20 }), /结果尚未确认/);
  assert.equal(web.pendingRequest('cashier', body).request_id, first.request_id);
  web.clearPending('cashier', { status: 400 }); assert.equal(web.state.cashierPending, null);
  web.pendingRequest('cashier', body); web.pendingRequest('checkin', { keyword: 'C-original' });
  web.setToken('another-session');
  assert.equal(web.state.cashierPending, null); assert.equal(web.state.checkinPending, null);
});

test('小程序核销断线后改输入先要求重试原请求，不查询也不扣新人', async () => {
  const sent = [];
  const page = loadPage('checkin/checkin.js', (url, opts) => {
    assert.equal(url, '/api/entries/checkin'); sent.push(opts.data);
    return sent.length === 1 ? Promise.reject(new Error('断线')) : Promise.resolve({});
  });
  page.data.preview = { keyword: 'C-original', card_id: 1, gate_no: '前台', people: 1 };
  page.confirm(); await tick();
  page.onInput({ currentTarget: { dataset: { key: 'keyword' } }, detail: { value: 'C-other' } });
  page.submit(); await tick();
  assert.equal(sent.length, 1);
  assert.equal(page.data.result.retry, true);
  page.retryPendingCheckin(); await tick();
  assert.equal(sent.length, 2); assert.equal(sent[1].keyword, 'C-original'); assert.equal(sent[0].request_id, sent[1].request_id);
  assert.equal(page._pendingCheckin, null);
});

test('小程序收银断线后阻止改额收款，按原参数重试', async () => {
  const sent = []; const page = loadPage('cashier/cashier.js', (url, opts) => { sent.push(opts.data); return Promise.reject(new Error('断线')); });
  Object.assign(page.data, { tab: 'recharge', selectedMember: { id: 1 }, cards: [{ id: 11, status: 'normal' }], amount: '10', payAmount: '10' });
  page.submit(); await tick();
  page.data.amount = '20'; page.data.payAmount = '20'; page.submit(); await tick(); assert.equal(sent.length, 1);
  page.data.amount = '10'; page.data.payAmount = '10'; page.submit(); await tick(); assert.equal(sent.length, 2);
  assert.equal(sent[0].request_id, sent[1].request_id);
});

test('小程序收银恢复页面时保持同卡种续费列表', async () => {
  const page = loadPage('cashier/cashier.js', () => Promise.resolve({ list: [{ id: 1, enabled: 1, type: 'count' }, { id: 2, enabled: 1, type: 'year' }] }));
  Object.assign(page.data, { tab: 'renew', cards: [{ card_type: 'year' }], cardIndex: 0 });
  page.loadBase(); await tick(); assert.equal(page.data.products.length, 1); assert.equal(page.data.products[0].type, 'year');
});

test('小程序流水未审批及驳回退款显示零支出，已通过退款显示负数', async () => {
  const page = loadPage('orders/orders.js', () => Promise.resolve({ list: ['pending', 'void', 'paid'].map((status, id) => ({ id, status, order_type: 'refund', total_amount: 10, paid_amount: 0 })) }));
  page.load(); await tick();
  assert.equal(page.data.list[0].amountText, '¥0.00'); assert.equal(page.data.list[1].amountText, '¥0.00'); assert.equal(page.data.list[2].amountText, '-¥10.00');
});

test('冻结卡退款计入已暂停的期限，回收后保持冻结且解冻期限正确', () => {
  const o = open('month');
  db.prepare("UPDATE member_cards SET start_at=?,end_at=?,status='frozen',frozen_from=?,frozen_until=? WHERE id=?")
    .run(addDays(today(), -10), addDays(today(), 20), addDays(today(), -8), addDays(today(), 10), o.member_card_id);
  const applied = orders.refundApply({ req: req('frontdesk'), params: { id: o.id }, body: { amount: 250, reason: '收回25天期限' } });
  assert.equal(applied.status, 201);
  const approved = orders.refundApprove({ req: req('finance'), params: { id: applied.body.refund.id }, body: { refund_method: 'cash' } });
  assert.equal(approved.status, 200, approved.body.error); assert.equal(card(o).status, 'frozen');
  assert.equal(card(o).end_at, addDays(today(), -5));
  assert.equal(cards.unfreeze({ req: req('boss'), params: { id: o.member_card_id }, body: {} }).status, 200);
  assert.equal(card(o).end_at, addDays(today(), 3)); assert.equal(card(o).status, 'normal');
  const remainder = orders.refundApply({ req: req('frontdesk'), params: { id: o.id }, body: { amount: 50, reason: '已消费2天不能全退' } });
  assert.equal(orders.refundApprove({ req: req('finance'), params: { id: remainder.body.refund.id }, body: { refund_method: 'cash' } }).status, 400);
});

test('审计写入故障时建档、转卡、退款申请及交班全部回滚', () => {
  const source = open('count'); const target = open('count');
  const shift = db.prepare("SELECT * FROM shifts WHERE staff_id=? AND status='active'").get(staff.frontdesk.id);
  const memberCount = db.prepare('SELECT COUNT(*) n FROM members').get().n;
  const orderCount = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
  db.exec("CREATE TRIGGER strict_audit_fail BEFORE INSERT ON operation_logs BEGIN SELECT RAISE(ABORT,'fixture audit unavailable'); END;");
  try {
    assert.equal(members.create({ req: req('boss'), body: { name: '不能残留的建档' } }).status, 500);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM members').get().n, memberCount);
    assert.equal(cards.transfer({ req: req('boss'), params: { id: source.member_card_id }, body: { to_member_id: target.member_id } }).status, 500);
    assert.equal(card(source).member_id, source.member_id);
    assert.equal(orders.refundApply({ req: req('frontdesk'), params: { id: source.id }, body: { amount: 25, reason: '不能残留的申请' } }).status, 500);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, orderCount);
    assert.equal(shifts.close({ req: req('frontdesk'), params: { id: shift.id }, body: { actual_cash: 0, note: '审计故障测试' } }).status, 500);
    assert.equal(db.prepare('SELECT status FROM shifts WHERE id=?').get(shift.id).status, 'active');
  } finally { db.exec('DROP TRIGGER strict_audit_fail'); }
});

test('路由自动审计故障时普通设置写入回滚，不出现成功响应后异常', async () => {
  const router = buildRouter(); const server = http.createServer(async (request, response) => { request.user = staff.boss; await router.handle(request, response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const before = db.prepare("SELECT value FROM settings WHERE key='store_name'").get().value;
  db.exec("CREATE TRIGGER strict_audit_fail BEFORE INSERT ON operation_logs BEGIN SELECT RAISE(ABORT,'fixture audit unavailable'); END;");
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ store_name: '不能残留的设置' }) });
    assert.equal(response.status, 500); assert.equal(db.prepare("SELECT value FROM settings WHERE key='store_name'").get().value, before);
  } finally { db.exec('DROP TRIGGER strict_audit_fail'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('真实服务入口验证未登录、角色权限、错误URL与请求大小，服务持续可用', async () => {
  const { server } = require('../server'); const { createSession } = require('../src/auth');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port; const base = 'http://127.0.0.1:' + port;
    assert.equal((await fetch(base + '/api/members')).status, 401);
    const token = createSession(staff.frontdesk.id).token; const headers = { Authorization: 'Bearer ' + token };
    assert.equal((await fetch(base + '/api/staff', { headers })).status, 403);
    assert.equal((await fetch(base + '/api/refunds', { headers })).status, 403);
    const settings = await (await fetch(base + '/api/settings', { headers })).json(); assert.equal(settings.settings.wechat_secret, '');
    const malformed = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: 'http://[', method: 'GET' }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject); request.end();
    });
    assert.equal(malformed, 400);
    assert.equal((await fetch(base + '/api/members', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '大请求', note: 'x'.repeat(5 * 1024 * 1024) }) })).status, 413);
    assert.equal((await fetch(base + '/api/members?page_size=1', { headers })).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
