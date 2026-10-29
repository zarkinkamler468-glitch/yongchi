'use strict';

// 本轮 14 项发现的回归测试。数据库、网络监听和前端状态均与生产隔离。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { inflateSync } = require('node:zlib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-fifth-'));
process.env.NODE_ENV = 'test';
process.env.PMS_DB_PATH = path.join(dir, 'fifth.db');
process.env.PMS_SEED_DEMO = '0';
delete process.env.TRUST_PROXY;
const { db } = require('../src/db');
const orders = require('../src/api/orders');
const cards = require('../src/api/cards');
const entries = require('../src/api/entries');
const shifts = require('../src/api/shifts');
const { today, now, addDays } = require('../src/util');
const { nextMemberNo, nextCardNo } = require('../src/api/common');
const { clientIp } = require('../src/http');
const staff = Object.fromEntries(db.prepare('SELECT * FROM staff').all().map(s => [s.role, s]));
const req = role => ({ user: staff[role], headers: {}, socket: { remoteAddress: '127.0.0.1' } });
let sequence = 0;
const query = values => new URLSearchParams(values);
const getCard = o => db.prepare('SELECT * FROM member_cards WHERE id=?').get(o.member_card_id);
function product(days) {
  const r = cards.createProduct({ body: { name: '修复测试卡-' + (++sequence), type: 'count', price: 100, total_uses: 10, duration_days: days, freeze_allowed: true, extension_allowed: true } });
  assert.equal(r.status, 201, r.body.error);
  return r.body.product;
}
function open(p, method = 'cash', role = 'frontdesk') {
  const r = orders.create({ req: req(role), body: { order_type: 'open', name: '修复测试会员-' + (++sequence), card_product_id: p.id, payments: [{ pay_method: method, amount: 100 }] } });
  assert.equal(r.status, 201, r.body.error);
  return r.body.order;
}
function renew(o, p) {
  return orders.create({ req: req('frontdesk'), body: { order_type: 'renew', member_id: o.member_id, member_card_id: o.member_card_id, card_product_id: p.id, payments: [{ pay_method: 'cash', amount: 100 }] } });
}
function apply(o, amount = 100) {
  const r = orders.refundApply({ req: req('frontdesk'), params: { id: o.id }, body: { amount, reason: '修复回归验证' } });
  assert.equal(r.status, 201, r.body.error);
  return r.body.refund;
}
function approve(r, method = 'original') {
  return orders.refundApprove({ req: req('finance'), params: { id: r.id }, body: { refund_method: method } });
}
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('非法静态路径返回400，随后请求仍成功；同步文件异常由入口返回500', async () => {
  const { server } = require('../server');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const suffix of ['%00', '%1f', '%7f', '%zz']) assert.equal((await fetch(base + '/invalid' + suffix)).status, 400);
    assert.equal((await fetch(base + '/')).status, 200);
    const read = fs.readFile, log = console.error;
    let status, result;
    try {
      fs.readFile = () => { throw new Error('fixture synchronous file error'); };
      console.error = () => {};
      await server.listeners('request')[0]({ url: '/app.js', method: 'GET', headers: {} }, {
        setHeader() {}, writeHead(s) { status = s; }, end(s) { result = s; }
      });
    } finally { fs.readFile = read; console.error = log; }
    assert.equal(status, 500); assert.match(result, /服务器错误/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('有期限次卡续不限期卡项在收款前拒绝，过期和未过期均不改变卡及订单', () => {
  const finite = product(30), unlimited = product(0);
  for (const offset of [-1, 20]) {
    const o = open(finite);
    db.prepare('UPDATE member_cards SET end_at=?,status=? WHERE id=?').run(addDays(today(), offset), offset < 0 ? 'expired' : 'normal', o.member_card_id);
    const before = { ...getCard(o) };
    const count = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
    const r = renew(o, unlimited);
    assert.equal(r.status, 400); assert.match(r.body.error, /有期限次卡/);
    assert.deepEqual({ ...getCard(o) }, before);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, count);
  }
});

test('不限期次卡续有限期或不限期卡项、再全额退款均保留原不限期权益', () => {
  const unlimited = product(0);
  for (const p of [product(30), unlimited]) {
    const o = open(unlimited), r = renew(o, p);
    assert.equal(r.status, 201, r.body.error);
    assert.equal(getCard(o).end_at, null); assert.equal(getCard(o).remaining_uses, 20);
    assert.equal(db.prepare('SELECT benefit_days FROM orders WHERE id=?').get(r.body.order.id).benefit_days, 0);
    const refunded = approve(apply(r.body.order));
    assert.equal(refunded.status, 200, refunded.body.error);
    assert.equal(getCard(o).end_at, null); assert.equal(getCard(o).remaining_uses, 10);
    assert.equal(entries.preview({ query: query({ keyword: getCard(o).card_no }) }).status, 200);
    assert.equal(cards.extend({ req: req('boss'), params: { id: o.member_card_id }, body: { days: 30 } }).status, 400);
  }
});

test('有限期续费正常延长，退款仅收回本次获得的期限和次数', () => {
  const p = product(30), o = open(p), before = getCard(o), r = renew(o, p);
  assert.equal(r.status, 201, r.body.error);
  assert.equal(getCard(o).end_at, addDays(before.end_at, 30));
  const refunded = approve(apply(r.body.order));
  assert.equal(refunded.status, 200, refunded.body.error);
  assert.equal(getCard(o).end_at, before.end_at); assert.equal(getCard(o).remaining_uses, before.remaining_uses);
});

test('冻结卡延期以有效期限计算，解冻只补偿一次冻结天数', () => {
  for (const offset of [-10, -30, 20]) {
    const o = open(product(30));
    db.prepare("UPDATE member_cards SET end_at=?,status='frozen',frozen_from=?,frozen_until=NULL WHERE id=?")
      .run(addDays(today(), offset), addDays(today(), -20) + 'T12:00:00', o.member_card_id);
    const expected = addDays(today(), Math.max(0, offset + 20) + 30);
    const r = cards.extend({ req: req('boss'), params: { id: o.member_card_id }, body: { days: 30 } });
    assert.equal(r.status, 200, r.body.error);
    assert.equal(cards.effectiveCardEnd(getCard(o)), expected);
    const thaw = cards.unfreeze({ req: req('boss'), params: { id: o.member_card_id }, body: {} });
    assert.equal(thaw.status, 200, thaw.body.error); assert.equal(thaw.body.card.end_at, expected);
  }
});

test('现金退款无进行中班次时拒绝且回滚，开班后重试同张退款成功且可对账', () => {
  for (const method of ['cash', 'original']) {
    const o = open(product(0)), refund = apply(o, 10), before = { ...getCard(o) };
    db.prepare("UPDATE shifts SET status='closed',ended_at=? WHERE status='active'").run(now());
    assert.equal(approve(refund, method).status, 400);
    assert.deepEqual({ ...getCard(o) }, before);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(refund.id).status, 'pending');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE order_id=?').get(refund.id).n, 0);
    const shift = shifts.start({ req: req('frontdesk'), body: { opening_cash: 100 } });
    assert.equal(shift.status, 201, shift.body.error);
    assert.equal(approve(refund, method).status, 200);
    assert.equal(db.prepare('SELECT shift_id FROM orders WHERE id=?').get(refund.id).shift_id, shift.body.shift.id);
    const repeated = approve(refund, method); assert.equal(repeated.status, 200); assert.equal(repeated.body.repeated, true);
    assert.equal(db.prepare('SELECT SUM(amount) amount FROM payments WHERE order_id=?').get(refund.id).amount, -10);
  }
});

test('纯电子原路退款无需现金班次；混合支付中途遇现金无班次时全部回滚', () => {
  const p = product(0), o = open(p, 'wechat');
  const refund = apply(o, 10);
  db.prepare("UPDATE shifts SET status='closed'").run();
  const result = approve(refund);
  assert.equal(result.status, 200, result.body.error);
  assert.equal(db.prepare('SELECT shift_id FROM orders WHERE id=?').get(refund.id).shift_id, null);
  const mixed = orders.create({ req: req('frontdesk'), body: { order_type: 'open', name: '混合回滚', card_product_id: p.id, payments: [{ pay_method: 'wechat', amount: 50 }, { pay_method: 'cash', amount: 50 }] } });
  assert.equal(mixed.status, 201, mixed.body.error);
  const r = apply(mixed.body.order), before = { ...getCard(mixed.body.order) };
  db.prepare("UPDATE shifts SET status='closed'").run();
  assert.equal(approve(r).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE order_id=?').get(r.id).n, 0);
  assert.deepEqual({ ...getCard(mixed.body.order) }, before);
});

test('导入超长会员号与卡号不会污染自动编号，正常显式序列继续递增', async () => {
  const importer = require('../src/api/member-import'), p = product(0);
  const headers = ['姓名','手机号','会员号','性别','生日','备注','建档日期','卡号','卡项名称','卡种','剩余次数','储值余额','开始日期','结束日期','卡状态','冻结开始','冻结截止'];
  const row = ['超长编号','','M999999999999999999999999','','','','','C999999999999999999999999',p.name,'count','1','0',today(),'','normal','',''];
  const body = { filename: 'regression.csv', data: Buffer.from(headers.join(',') + '\n' + row.join(',')).toString('base64') };
  assert.equal((await importer.preview({ body })).body.errors.length, 0);
  const imported = await importer.commit({ req: req('admin'), body }); assert.equal(imported.status, 200, imported.body.error);
  assert.match(nextMemberNo(), /^M\d+$/); assert.match(nextCardNo(), /^C\d+$/);
  const o = open(p); assert.ok(getCard(o).card_no.length < 20);
  const ts = now();
  db.prepare("INSERT INTO members(member_no,name,status,created_at,updated_at) VALUES ('M1234567','显式号','normal',?,?)").run(ts, ts);
  assert.equal(nextMemberNo(), 'M1234568');
  db.prepare("INSERT INTO member_cards(member_id,card_no,card_type,status,created_at,updated_at) VALUES (?,'C123456789','count','normal',?,?)").run(o.member_id, ts, ts);
  assert.equal(nextCardNo(), 'C123456790');
});

test('代理默认不信任内网请求头；可信单层代理忽略伪造前缀并验证IP', () => {
  const r = { socket: { remoteAddress: '::ffff:172.17.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' } };
  try {
    assert.equal(clientIp(r), r.socket.remoteAddress);
    process.env.TRUST_PROXY = '172.17.0.1,127.0.0.1';
    assert.equal(clientIp(r), '203.0.113.9');
    r.headers['x-forwarded-for'] = '6.7.8.9, invalid'; assert.equal(clientIp(r), r.socket.remoteAddress);
    r.headers['x-real-ip'] = '::1'; assert.equal(clientIp(r), '::1');
    r.socket.remoteAddress = '203.0.113.22'; assert.equal(clientIp(r), '203.0.113.22');
  } finally { delete process.env.TRUST_PROXY; }
});

const webSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').split('/* ============================= 启动 ============================= */')[0];
const response = data => ({ status: 200, ok: true, json: async () => data });
function web(fetchImpl, storage = new Map(), elements = {}, timers = {}) {
  const context = { document: { addEventListener() {}, querySelector: s => elements[s] || null, querySelectorAll: () => [] },
    window: { addEventListener() {} }, location: { hash: '#/checkin' }, fetch: fetchImpl,
    localStorage: { getItem: k => storage.get(k) || '', setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    setTimeout: () => 0, clearTimeout() {}, AbortController, URL, URLSearchParams, Blob, ...timers };
  vm.createContext(context);
  vm.runInContext(webSource + '\nrender=()=>{};toast=()=>{};this.web={state,api,pendingRequest,clearPending,restorePending,recoverPending,confirmRefundApply,confirmCheckin,renderMemberCards,memberCardsPage,searchMemberCards,openMember,setToken};', context);
  context.web.state.user = { id: 7, role: 'frontdesk' };
  return context.web;
}

test('Web刷新、重新登录恢复原编号；其他员工隔离，未知状态不能改参数', async () => {
  const saved = new Map(), calls = [], element = { hidden: true, innerHTML: '' };
  const first = web(async () => {}, saved);
  const original = first.pendingRequest('cashier', { order_type: 'recharge', amount: 100 });
  first.setToken('');
  const second = web(async (url, opts) => { calls.push({ url, data: JSON.parse(opts.body) }); return response({ order: { id: 5 }, amount: 100 }); }, saved, { '#pendingRecovery': element });
  second.restorePending('cashier');
  assert.equal(second.state.cashierPending.body.request_id, original.request_id);
  assert.throws(() => second.pendingRequest('cashier', { order_type: 'recharge', amount: 200 }), /结果尚未确认/);
  assert.equal(second.pendingRequest('cashier', { order_type: 'recharge', amount: 100 }).request_id, original.request_id);
  assert.equal(element.hidden, true); // 恢复记录本身不重新发送请求。
  await second.recoverPending({ dataset: { scope: 'cashier' } });
  assert.equal(calls.length, 1); assert.equal(calls[0].data.request_id, original.request_id); assert.equal(second.state.cashierPending, null);
  assert.ok(![...saved.keys()].some(k => k.endsWith('_cashier')));
  const third = web(async () => {}, saved); third.state.user.id = 8;
  const own = third.pendingRequest('cashier', { amount: 1 }); assert.notEqual(own.request_id, original.request_id);
  third.state.user.id = 7; third.state.cashierPending = null; third.restorePending('cashier'); assert.equal(third.state.cashierPending, null);
});

test('Web截断JSON、空成功响应和各类未知HTTP错误保留待确认记录', async () => {
  for (const fetchImpl of [async () => ({ ...response({}), json: async () => { throw new SyntaxError(); } }), async () => response({}), ...[401,403,404,409,500].map(status => async () => ({ status, ok: false, json: async () => ({ error: 'fixture' }) }))]) {
    const saved = new Map(), w = web(fetchImpl, saved);
    const body = w.pendingRequest('checkin', { keyword: 'card', people: 1 });
    let error;
    try { await w.api('/api/entries/checkin', { body }); } catch (e) { error = e; }
    assert.ok(error); w.clearPending('checkin', error);
    const after = web(async () => {}, saved); after.restorePending('checkin');
    assert.equal(after.state.checkinPending.body.request_id, body.request_id);
  }
});

test('Web读取响应体全过程受超时约束，超时保留原编号', async () => {
  let signal;
  const w = web(async (_, opts) => {
    signal = opts.signal;
    return { status: 200, ok: true, json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' })))) };
  }, new Map(), {}, { setTimeout, clearTimeout });
  const body = w.pendingRequest('checkin', { keyword: 'slow-body' });
  await assert.rejects(w.api('/api/entries/checkin', { body, timeout: 15 }), /请求超时/);
  assert.equal(signal.aborted, true); assert.equal(w.state.checkinPending.body.request_id, body.request_id);
});

test('Web退款申请绑定原订单路径；失败后切换订单被阻止，恢复后新申请使用新编号', async () => {
  const saved = new Map(), sent = [], elements = { '#rfAmount': { value: '10' }, '#rfReason': { value: '退款' } };
  const w = web(async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); throw new Error('断线'); }, saved, elements);
  await w.confirmRefundApply({ dataset: { id: '1' } });
  await w.confirmRefundApply({ dataset: { id: '2' } });
  assert.equal(sent.length, 1);
  const retry = web(async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return response({ refund: { id: 30 } }); }, saved);
  retry.restorePending('refund');
  await retry.recoverPending({ dataset: { scope: 'refund' } });
  assert.equal(sent[1].url, '/api/orders/1/refund'); assert.equal(sent[1].body.request_id, sent[0].body.request_id);
  assert.notEqual(retry.pendingRequest('refund', { amount: '10', reason: '退款' }, '/api/orders/2/refund').request_id, sent[0].body.request_id);
});

test('Web本地存储失败时禁止发送核销；损坏的待确认记录不得被覆盖', async () => {
  const saved = new Map(); let calls = 0;
  saved.set = () => { throw new Error('quota'); };
  const w = web(async () => { calls++; }, saved);
  w.state.checkinPreview = { keyword: 'card', card_id: 3, people: 1, gate_no: '前台' };
  await w.confirmCheckin({}); assert.equal(calls, 0);
  const corrupted = new Map([['pms_pending_7_cashier', '{bad']]);
  assert.throws(() => web(async () => {}, corrupted).pendingRequest('cashier', { amount: 1 }), /损坏/);
  assert.equal(corrupted.get('pms_pending_7_cashier'), '{bad');
});

function mini(storage, requestImpl) {
  const wx = { getStorageSync: k => storage.get(k) || '', setStorageSync: (k, v) => storage.set(k, JSON.parse(JSON.stringify(v))), removeStorageSync: k => storage.delete(k),
    request: requestImpl, showToast() {}, reLaunch() {} };
  const context = { wx, module: { exports: {} }, require: () => ({ BASE_URL: 'https://example.test' }) };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/request.js'), 'utf8'), context);
  return { ...context.module.exports, wx };
}

test('小程序页面销毁后从“我的”恢复原路径和编号，后端重放仅扣一次', async () => {
  const o = open(product(0)), saved = new Map([['user', { id: staff.frontdesk.id }], ['token', 'test']]);
  const sent = [];
  const first = mini(saved, opts => {
    sent.push(opts.data);
    assert.equal(entries.checkin({ req: req('frontdesk'), body: opts.data }).status, 200);
    opts.fail();
  });
  const body = { keyword: getCard(o).card_no, card_id: o.member_card_id, people: 1, confirmed: true };
  await assert.rejects(first.request('/api/entries/checkin', { data: body }), /网络错误/);
  const second = mini(saved, opts => {
    if (opts.url.endsWith('/api/auth/me')) return opts.success({ statusCode: 200, data: { user: {} } });
    if (opts.url.endsWith('/api/public-config')) return opts.success({ statusCode: 200, data: { settings: {} } });
    sent.push(opts.data);
    const replay = entries.checkin({ req: req('frontdesk'), body: opts.data });
    assert.equal(replay.status, 200, replay.body.error); assert.equal(replay.body.repeated, true);
    opts.success({ statusCode: 200, data: replay.body });
  });
  await assert.rejects(second.request('/api/entries/checkin', { data: { ...body, people: 2 } }), /结果尚未确认/);
  let page;
  const context = { wx: second.wx, Page: p => { page = p; }, require: p => p.includes('request') ? second : require('../miniprogram/utils/util') };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/profile/profile.js'), 'utf8'), context);
  page.data = { ...page.data }; page.setData = patch => Object.assign(page.data, patch);
  page.onShow(); assert.equal(page.data.pending[0].scope, 'checkin');
  page.recoverPending({ currentTarget: { dataset: { scope: 'checkin' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 2); assert.equal(sent[0].request_id, sent[1].request_id);
  assert.equal(getCard(o).remaining_uses, 9); assert.equal(second.pendingTransactions().length, 0); assert.equal(page.data.pending.length, 0);
});

test('小程序账号隔离、异常响应保留待确认状态，400明确拒绝才清除', async () => {
  for (const status of [200,400,401,403,409,500]) {
    const saved = new Map([['user', { id: 1 }], ['token', 'test']]);
    const m = mini(saved, opts => opts.success({ statusCode: status, data: status === 200 ? {} : { error: 'fixture' } }));
    await assert.rejects(m.request('/api/orders', { data: { amount: 100 } }));
    if (status === 401) saved.set('user', { id: 1 });
    assert.equal(m.pendingTransactions().length, status === 400 ? 0 : 1);
    saved.set('user', { id: 2 }); assert.equal(m.pendingTransactions().length, 0);
  }
});

test('小程序写存储失败不发请求，损坏快照保留并阻止新交易', async () => {
  const saved = new Map([['user', { id: 1 }]]); let sent = 0;
  const m = mini(saved, () => sent++);
  saved.set = () => { throw new Error('quota'); };
  await assert.rejects(m.request('/api/orders', { data: { amount: 10 } }), /quota/); assert.equal(sent, 0);
  const broken = new Map([['user', { id: 1 }], ['pms_pending_https://example.test_1_cashier', { invalid: true }]]);
  const b = mini(broken, () => sent++);
  await assert.rejects(b.request('/api/orders', { data: { amount: 10 } }), /损坏/);
  assert.equal(b.pendingTransactions()[0].corrupt, true); assert.equal(sent, 0);
});

test('旧恢复响应迟到时，Web和小程序都不能误删下一笔待确认业务', async () => {
  const saved = new Map(), calls = [];
  const w = web(() => new Promise(resolve => calls.push(resolve)), saved);
  w.pendingRequest('cashier', { amount: 10 });
  const recovery = w.recoverPending({ dataset: { scope: 'cashier' } });
  w.clearPending('cashier'); // 模拟另一个相同原请求先得到确认。
  const next = w.pendingRequest('cashier', { amount: 20 });
  calls[0](response({ order: { id: 1 }, amount: 10 })); await recovery;
  assert.equal(w.state.cashierPending.body.request_id, next.request_id);
  assert.equal(JSON.parse(saved.get('pms_pending_7_cashier')).body.request_id, next.request_id);

  const store = new Map([['user', { id: 1 }]]), sent = [], m = mini(store, opts => sent.push(opts));
  const first = m.request('/api/orders', { data: { amount: 10 } });
  const replay = m.request('/api/orders', { data: { amount: 10 } });
  sent[0].success({ statusCode: 200, data: { order: { id: 1 }, amount: 10 } }); await first;
  const newer = m.request('/api/orders', { data: { amount: 20 } });
  sent[1].success({ statusCode: 200, data: { order: { id: 1 }, amount: 10 } }); await replay;
  assert.equal(m.pendingTransactions()[0].data.request_id, sent[2].data.request_id);
  sent[2].success({ statusCode: 200, data: { order: { id: 2 }, amount: 20 } }); await newer;
  assert.equal(m.pendingTransactions().length, 0);
});

test('会员卡页面可到第12页且有搜索和翻页；后端搜索支持卡号及会员信息', async () => {
  const paths = [], elements = { '#view-member-cards': {}, '#mcSearch': { value: '搜索词' } };
  const w = web(async url => {
    paths.push(url); const page = Number(new URL(url, 'http://local').searchParams.get('page'));
    return response({ list: [{ id: page, card_no: 'PAGE-' + page, card_type: 'count', status: 'normal', remaining_uses: 1 }], page, total: 1200, has_more: page < 12 });
  }, new Map(), elements);
  await w.renderMemberCards(); assert.equal(paths.length, 1);
  assert.match(elements['#view-member-cards'].innerHTML, /searchMemberCards/);
  await w.memberCardsPage({ dataset: { page: 12 } });
  assert.match(paths[1], /page=12/); assert.match(elements['#view-member-cards'].innerHTML, /PAGE-12/);
  await w.searchMemberCards(); const search = new URL(paths[2], 'http://local').searchParams;
  assert.equal(search.get('page'), '1'); assert.equal(search.get('search'), '搜索词');
  const o = open(product(0)), c = getCard(o), m = db.prepare('SELECT * FROM members WHERE id=?').get(o.member_id);
  db.prepare('UPDATE members SET phone=? WHERE id=?').run('13912345678', m.id);
  for (const term of [c.card_no, m.member_no, m.name, '13912345678']) {
    const result = cards.listCards({ query: query({ search: term, page: 1 }) });
    assert.equal(result.status, 200); assert.ok(result.body.list.some(row => row.id === c.id));
  }
  assert.equal(cards.listCards({ query: query({ search: "' OR 1=1 --" }) }).body.total, 0);
});

test('Web及小程序会员详情正确显示已通过退款负数、待审和驳回零金额', async () => {
  const fixture = { member: { id: 1, name: '会员', status: 'normal', tags: [] }, cards: [], entries: [], orders: ['paid','pending','void'].map((status, i) => ({ id: i + 1, order_type: 'refund', total_amount: 25, paid_amount: 0, status })) };
  let page;
  const context = { Page: p => { page = p; }, require: p => p.includes('request') ? { request: async () => fixture, toast() {} } : require('../miniprogram/utils/util') };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/member-detail/member-detail.js'), 'utf8'), context);
  page.data = { ...page.data, id: 1 }; page.setData = p => Object.assign(page.data, p);
  page.load(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.orders[0].amountText, '-¥25.00'); assert.equal(page.data.orders[1].amountText, '¥0.00'); assert.equal(page.data.orders[2].amountText, '¥0.00');
  const modal = { innerHTML: '', classList: { toggle() {} } }, elements = { '#modalBox': modal, '#modalOverlay': { hidden: true } };
  const w = web(async () => response(fixture), new Map(), elements);
  await w.openMember(1); assert.match(modal.innerHTML, /-¥25/);
});

function authSandbox() {
  const filename = path.join(__dirname, '../src/api/auth.js'); let clock = 1000000;
  class Clock extends Date { static now() { return clock; } }
  const context = { require: createRequire(filename), module: { exports: {} }, Date: Clock, console };
  vm.createContext(context); vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  return { api: context.module.exports, advance: ms => { clock += ms; } };
}
function readCaptcha(api, token) {
  let status, headers, buffer;
  api.captchaImage({ query: query({ token }), res: { writeHead(s, h) { status = s; headers = h; }, end(b) { buffer = b; } } });
  return { status, headers, buffer };
}
test('验证码为稳定PNG像素，不公开答案；每IP限速且过期图片不可使用', () => {
  const { api, advance } = authSandbox(); const request = { req: req('frontdesk') };
  const challenge = api.captcha(request); assert.equal(challenge.status, 200); assert.equal(challenge.body.svg, undefined); assert.equal(challenge.body.code, undefined);
  const first = readCaptcha(api, challenge.body.captcha_token), second = readCaptcha(api, challenge.body.captcha_token);
  assert.equal(first.status, 200); assert.equal(first.headers['Content-Type'], 'image/png'); assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.deepEqual(first.buffer, second.buffer); assert.deepEqual([...first.buffer.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  const chunks = []; let width, height;
  for (let offset = 8; offset < first.buffer.length;) {
    const len = first.buffer.readUInt32BE(offset), type = first.buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR') { width = first.buffer.readUInt32BE(offset + 8); height = first.buffer.readUInt32BE(offset + 12); }
    if (type === 'IDAT') chunks.push(first.buffer.subarray(offset + 8, offset + 8 + len));
    offset += 12 + len;
  }
  assert.equal(inflateSync(Buffer.concat(chunks)).length, height * (width * 3 + 1));
  for (let i = 1; i < 20; i++) assert.equal(api.captcha(request).status, 200);
  assert.equal(api.captcha(request).status, 429);
  advance(60001); assert.equal(api.captcha(request).status, 200);
  advance(5 * 60000); assert.equal(readCaptcha(api, challenge.body.captcha_token).status, 404);
  assert.equal(api.captcha(request).status, 200);
});

test('验证码全局容量有上限，过期清理后恢复签发且不逐出有效挑战', () => {
  const { api, advance } = authSandbox(); let token;
  for (let i = 0; i < 1000; i++) {
    const r = api.captcha({ req: { socket: { remoteAddress: 'test-client-' + i } } });
    assert.equal(r.status, 200); if (i === 0) token = r.body.captcha_token;
  }
  assert.equal(api.captcha({ req: { socket: { remoteAddress: 'another-client' } } }).status, 429);
  assert.equal(readCaptcha(api, token).status, 200);
  advance(5 * 60000 + 1);
  assert.equal(api.captcha({ req: req('frontdesk') }).status, 200);
});
