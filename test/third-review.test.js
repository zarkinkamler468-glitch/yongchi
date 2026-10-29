'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-third-'));
process.env.NODE_ENV = 'test';
process.env.PMS_DB_PATH = path.join(dir, 'third.db');
process.env.PMS_SEED_DEMO = '0';

const { db, setSettings } = require('../src/db');
const staffApi = require('../src/api/staff');
const cardsApi = require('../src/api/cards');
const orders = require('../src/api/orders');
const members = require('../src/api/members');
const reports = require('../src/api/reports');
const auth = require('../src/api/auth');
const { today } = require('../src/util');

const staff = Object.fromEntries(db.prepare('SELECT * FROM staff').all().map((s) => [s.role, s]));
const req = (role) => ({ user: staff[role], socket: { remoteAddress: '127.0.0.1' } });
const product = (type) => db.prepare('SELECT * FROM card_products WHERE type = ? AND enabled = 1 ORDER BY id LIMIT 1').get(type);

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('编辑停用员工不会重新启用账号或重置角色', () => {
  const created = staffApi.create({ req: req('boss'), body: { username: 'inactive_edit', real_name: '停用测试', password: 'Password123', role: 'frontdesk' } });
  assert.equal(created.status, 201, created.body.error);
  const id = created.body.staff.id;
  assert.equal(staffApi.remove({ req: req('boss'), params: { id } }).status, 200);
  assert.equal(db.prepare('SELECT status FROM staff WHERE id = ?').get(id).status, 'inactive');

  const edited = staffApi.update({ req: req('boss'), params: { id }, body: { username: 'inactive_edit', real_name: '改名' } });
  assert.equal(edited.status, 200, edited.body.error);
  const row = db.prepare('SELECT status, role FROM staff WHERE id = ?').get(id);
  assert.equal(row.status, 'inactive');
  assert.equal(row.role, 'frontdesk');

  const reenabled = staffApi.update({ req: req('boss'), params: { id }, body: { username: 'inactive_edit', real_name: '改名', role: 'frontdesk', status: 'active' } });
  assert.equal(reenabled.status, 200, reenabled.body.error);
  assert.equal(db.prepare('SELECT status FROM staff WHERE id = ?').get(id).status, 'active');
});

test('停用卡项编辑后保持停用，卡项名称禁止重复', () => {
  const created = cardsApi.createProduct({ req: req('boss'), body: { name: '第三轮唯一卡项', type: 'count', price: 10, duration_days: 30, total_uses: 5 } });
  assert.equal(created.status, 201, created.body.error);
  const id = created.body.product.id;
  assert.equal(cardsApi.createProduct({ req: req('boss'), body: { name: '第三轮唯一卡项', type: 'count', price: 10, duration_days: 30, total_uses: 5 } }).status, 400);
  assert.equal(cardsApi.disableProduct({ req: req('boss'), params: { id } }).status, 200);

  const edited = cardsApi.updateProduct({ req: req('boss'), params: { id }, body: { name: '第三轮唯一卡项', type: 'count', price: 10, duration_days: 30, total_uses: 5 } });
  assert.equal(edited.status, 200, edited.body.error);
  assert.equal(edited.body.product.enabled, 0);

  const reenabled = cardsApi.updateProduct({ req: req('boss'), params: { id }, body: { name: '第三轮唯一卡项', type: 'count', price: 10, duration_days: 30, total_uses: 5, enabled: true } });
  assert.equal(reenabled.body.product.enabled, 1);
});

test('同一 request_id 跨订单类型返回 409 而不是 500', () => {
  const p = product('count');
  const body = { order_type: 'open', name: '编号复用会员', phone: '13970000001', card_product_id: p.id, request_id: 'cross-type-id', payments: [{ pay_method: 'cash', amount: p.price }] };
  const first = orders.create({ req: req('frontdesk'), body });
  assert.equal(first.status, 201, first.body.error);
  const repeated = orders.create({ req: req('frontdesk'), body });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.repeated, true);

  const refund = orders.refundApply({ req: req('frontdesk'), params: { id: first.body.order.id }, body: { amount: 10, reason: '跨类型编号', request_id: 'cross-type-id' } });
  assert.equal(refund.status, 409, JSON.stringify(refund.body));

  const freshRefund = orders.refundApply({ req: req('frontdesk'), params: { id: first.body.order.id }, body: { amount: 10, reason: '正常编号', request_id: 'cross-type-refund' } });
  assert.equal(freshRefund.status, 201, freshRefund.body.error);
});

test('显式编号不会与下一次自动编号碰撞', () => {
  const maxMember = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(member_no, 2) AS INTEGER)), 0) AS m FROM members WHERE member_no LIKE 'M%'").get().m;
  const collidingMember = 'M' + String(maxMember + 1).padStart(6, '0');
  const ts = today() + 'T00:00:00';
  db.prepare("INSERT INTO members(member_no, name, status, created_at, updated_at) VALUES (?, '占位编号', 'normal', ?, ?)").run(collidingMember, ts, ts);
  const createdMember = members.create({ req: req('frontdesk'), body: { name: '编号避让会员' } });
  assert.equal(createdMember.status, 201, createdMember.body.error);
  assert.ok(createdMember.body.member.member_no > collidingMember);

  const memberId = createdMember.body.member.id;
  const maxCard = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(card_no, 2) AS INTEGER)), 0) AS m FROM member_cards WHERE card_no LIKE 'C%'").get().m;
  const collidingCard = 'C' + String(maxCard + 1).padStart(8, '0');
  db.prepare("INSERT INTO member_cards(member_id, card_no, card_type, status, created_at, updated_at) VALUES (?, ?, 'count', 'normal', ?, ?)").run(memberId, collidingCard, ts, ts);
  const p = product('count');
  const sale = orders.create({ req: req('frontdesk'), body: { order_type: 'open', member_id: memberId, card_product_id: p.id, payments: [{ pay_method: 'cash', amount: p.price }] } });
  assert.equal(sale.status, 201, sale.body.error);
  assert.ok(sale.body.order.card_no > collidingCard);
});

test('验证码只下发 PNG 地址，不公开数字几何结构', () => {
  const result = auth.captcha({});
  assert.equal(result.status, 200);
  assert.equal(result.body.svg, undefined);
  let image;
  auth.captchaImage({ query: new URLSearchParams({ token: result.body.captcha_token }), res: {
    writeHead(status, headers) { assert.equal(status, 200); assert.equal(headers['Content-Type'], 'image/png'); },
    end(body) { image = body; }
  } });
  assert.deepEqual([...image.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
});

test('settings 不会写入 constructor 等原型链键', () => {
  setSettings({ constructor: 'polluted', toString: 'polluted', store_name: '第三轮门店' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key IN ('constructor','toString')").get().n, 0);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'store_name'").get().value, '第三轮门店');
});

test('收银新建会员保存生日与备注', () => {
  const p = product('count');
  const result = orders.create({ req: req('frontdesk'), body: { order_type: 'open', name: '生日备注会员', phone: '13970000002', birthday: '2000-01-02', note: '收银建档备注', card_product_id: p.id, payments: [{ pay_method: 'cash', amount: p.price }] } });
  assert.equal(result.status, 201, result.body.error);
  const member = db.prepare('SELECT birthday, note FROM members WHERE phone = ?').get('13970000002');
  assert.equal(member.birthday, '2000-01-02');
  assert.equal(member.note, '收银建档备注');
});

test('CSV 保留负数数值，同时继续转义公式文本', () => {
  const created = members.create({ req: req('boss'), body: { name: 'CSV公式会员', note: '-1+1' } });
  assert.equal(created.status, 201, created.body.error);
  const csv = reports.exportMembers().body.csv;
  assert.ok(csv.includes(",'-1+1,"), '公式文本应加文本前缀');
});

test('首页财务字段只对有财务权限的角色返回', () => {
  const front = reports.dashboard({ req: req('frontdesk') });
  assert.equal(front.status, 200);
  assert.equal(front.body.can_view_finance, false);
  assert.equal(front.body.today_income, null);
  assert.equal(front.body.today_open, null);
  assert.ok(Array.isArray(front.body.recent));
  assert.ok(front.body.recent.every((row) => row.income === null && typeof row.entries === 'number'));

  const boss = reports.dashboard({ req: req('boss') });
  assert.equal(boss.body.can_view_finance, true);
  assert.equal(typeof boss.body.today_income, 'number');
  assert.ok(boss.body.recent.every((row) => typeof row.income === 'number'));
});

test('staff.wx_openid 存在唯一索引', () => {
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_staff_wx_openid'").get();
  assert.ok(idx);
});

test('随机初始密码写入受限文件而不是启动日志', () => {
  const childDir = path.join(dir, 'child');
  fs.mkdirSync(childDir, { recursive: true });
  const env = { ...process.env, PMS_DB_PATH: path.join(childDir, 'pool.db'), NODE_ENV: 'production', PMS_SEED_DEMO: '0' };
  for (const key of ['PMS_INITIAL_ADMIN_PASSWORD', 'PMS_INITIAL_BOSS_PASSWORD', 'PMS_INITIAL_FRONTDESK_PASSWORD', 'PMS_INITIAL_FINANCE_PASSWORD']) delete env[key];
  const result = spawnSync(process.execPath, ['-e', "require('./src/db').db.close()"], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(childDir, 'initial-passwords.txt');
  assert.ok(fs.existsSync(file));
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.includes('\t'));
  assert.equal(lines.length, 4);
  for (const line of lines) {
    const password = line.split('\t')[1];
    assert.ok(password.length >= 8);
    assert.equal((result.stdout + result.stderr).includes(password), false);
  }
});
