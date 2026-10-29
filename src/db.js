'use strict';

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  throw new Error('当前 Node.js 不支持 node:sqlite。请升级到 Node.js 22.13+，或使用 --experimental-sqlite 启动。');
}
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { now } = require('./util');
const { hashPassword } = require('./crypto');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.PMS_DB_PATH ? path.resolve(process.env.PMS_DB_PATH) : path.join(DEFAULT_DATA_DIR, 'pool.db');
const DATA_DIR = path.dirname(DB_PATH);

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
// 备份工具或误开的第二个实例短暂持锁时，等待而不是立刻 SQLITE_BUSY 失败。
db.exec('PRAGMA busy_timeout = 5000;');

// settings 表最先创建，用于存放迁移标记与全局配置
db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);`);

// 版本标记：新数据库直接进入当前结构；旧版数据库绝不自动删表。
const migrated = db.prepare("SELECT value FROM settings WHERE key = 'schema_v05'").get();
if (!migrated) {
  const existingTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'settings'").all();
  if (existingTables.length) {
    db.close();
    throw new Error('检测到未迁移的旧版数据库。为防止会员和账务数据丢失，系统已停止启动；请先备份数据库并执行人工迁移，程序不会自动删除旧表。');
  }
  db.prepare("INSERT INTO settings(key, value) VALUES ('schema_v05', '1')").run();
}

// 为已存在的表补齐新增列（幂等）
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// ---------------------------------------------------------------------------
// 表结构（对齐开发文档 11.x）
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS staff (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  real_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'frontdesk',   -- boss / frontdesk / finance
  status        TEXT NOT NULL DEFAULT 'active',      -- active / inactive
  wx_openid     TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  staff_id   INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_no  TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  phone      TEXT UNIQUE,
  gender     TEXT NOT NULL DEFAULT 'unknown',        -- male / female / unknown
  birthday   TEXT,
  note       TEXT,
  status     TEXT NOT NULL DEFAULT 'normal',         -- normal / blacklist / inactive
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS member_tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER NOT NULL,
  tag_name   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL,                    -- count / month / year / stored
  price             REAL NOT NULL DEFAULT 0,
  duration_days     INTEGER NOT NULL DEFAULT 0,       -- 0 表示不限
  total_uses        INTEGER NOT NULL DEFAULT 0,       -- 仅次卡
  stored_value      REAL NOT NULL DEFAULT 0,          -- 仅储值卡
  entry_fee         REAL NOT NULL DEFAULT 0,          -- 储值卡单次入场扣费
  freeze_allowed    INTEGER NOT NULL DEFAULT 1,
  transfer_allowed  INTEGER NOT NULL DEFAULT 1,
  extension_allowed INTEGER NOT NULL DEFAULT 1,
  enabled           INTEGER NOT NULL DEFAULT 1,
  note              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS member_cards (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id        INTEGER NOT NULL,
  card_product_id  INTEGER,
  card_no          TEXT UNIQUE NOT NULL,
  card_type        TEXT NOT NULL,                     -- count / month / year / stored
  start_at         TEXT,
  end_at           TEXT,
  remaining_uses   INTEGER NOT NULL DEFAULT 0,
  balance          REAL NOT NULL DEFAULT 0,
  entry_fee        REAL NOT NULL DEFAULT 0,           -- 储值卡快照
  status           TEXT NOT NULL DEFAULT 'normal',    -- normal / frozen / expired / void / refunded
  frozen_from      TEXT,
  frozen_until     TEXT,
  created_order_id INTEGER,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no          TEXT UNIQUE NOT NULL,
  order_type        TEXT NOT NULL,                    -- open / renew / recharge / refund
  member_id         INTEGER NOT NULL,
  member_card_id    INTEGER,
  original_order_id INTEGER,
  total_amount      REAL NOT NULL DEFAULT 0,
  discount_amount   REAL NOT NULL DEFAULT 0,
  payable_amount    REAL NOT NULL DEFAULT 0,
  paid_amount       REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending / paid / partial_refund / refunded / void
  shift_id          INTEGER,
  staff_id          INTEGER NOT NULL,
  approved_by       INTEGER,
  refund_reason     TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL,
  source_card_id INTEGER,
  pay_method     TEXT NOT NULL,                       -- cash / wechat / alipay / stored
  amount         REAL NOT NULL,                       -- 退款为负数
  transaction_no TEXT,
  paid_at        TEXT NOT NULL,
  staff_id       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       INTEGER NOT NULL,
  member_card_id  INTEGER,
  charge_type     TEXT,                               -- count / month / year / stored
  deducted_uses   INTEGER NOT NULL DEFAULT 0,
  deducted_amount REAL NOT NULL DEFAULT 0,
  gate_no         TEXT,
  result          TEXT NOT NULL,                      -- success / fail
  fail_reason     TEXT,
  entry_at        TEXT NOT NULL,
  staff_id        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id     INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  opening_cash REAL NOT NULL DEFAULT 0,
  cash_amount  REAL NOT NULL DEFAULT 0,
  actual_cash  REAL,
  difference   REAL,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'active'         -- active / closed
);

CREATE TABLE IF NOT EXISTS daily_closings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT UNIQUE NOT NULL,
  total_income  REAL NOT NULL DEFAULT 0,
  total_refund  REAL NOT NULL DEFAULT 0,
  total_entries INTEGER NOT NULL DEFAULT 0,
  new_members   INTEGER NOT NULL DEFAULT 0,
  closed_by     INTEGER NOT NULL,
  closed_at     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'closed'        -- closed / adjusted
);

CREATE TABLE IF NOT EXISTS operation_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id    INTEGER,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  before_data TEXT,
  after_data  TEXT,
  reason      TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS member_import_batches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash    TEXT UNIQUE NOT NULL,
  filename     TEXT,
  row_count    INTEGER NOT NULL DEFAULT 0,
  imported_by  INTEGER NOT NULL,
  imported_at  TEXT NOT NULL
);
`);

// 旧库补齐微信绑定列
ensureColumn('staff', 'wx_openid', 'wx_openid TEXT');
// 已存在重复 openid 时不能建唯一索引；否则阻止同一微信绑定多个员工。
try {
  const dup = db.prepare("SELECT wx_openid FROM staff WHERE wx_openid IS NOT NULL GROUP BY wx_openid HAVING COUNT(*) > 1 LIMIT 1").get();
  if (dup) console.warn('[数据检查] staff.wx_openid 存在重复值，暂不创建唯一索引，请人工核对微信绑定关系。');
  else db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_wx_openid ON staff(wx_openid) WHERE wx_openid IS NOT NULL');
} catch (e) {
  console.warn('[数据检查] 创建 wx_openid 唯一索引失败：' + (e && e.message));
}
ensureColumn('orders', 'benefit_uses', 'benefit_uses INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'benefit_amount', 'benefit_amount REAL NOT NULL DEFAULT 0');
ensureColumn('orders', 'benefit_days', 'benefit_days INTEGER NOT NULL DEFAULT 0');
// 续费单保存续费前后的有效期（空字符串表示不限期），用于全额退款时精确恢复，
// 避免过期卡续费后退款把有效期“复活”到今天。
ensureColumn('orders', 'benefit_end_before', 'benefit_end_before TEXT');
ensureColumn('orders', 'benefit_end_after', 'benefit_end_after TEXT');
ensureColumn('orders', 'benefit_snapshot_known', 'benefit_snapshot_known INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'approved_at', 'approved_at TEXT');
ensureColumn('orders', 'request_id', 'request_id TEXT');
ensureColumn('orders', 'request_hash', 'request_hash TEXT');
ensureColumn('payments', 'source_card_id', 'source_card_id INTEGER');
ensureColumn('entries', 'request_id', 'request_id TEXT');
ensureColumn('entries', 'request_hash', 'request_hash TEXT');
ensureColumn('entries', 'people', 'people INTEGER NOT NULL DEFAULT 1');
// 旧记录只有次卡扣次可可靠还原人数；期限/储值卡保持 1，不猜测历史费率。
if (!db.prepare("SELECT 1 FROM settings WHERE key='migration_entry_people_v1'").get()) {
  db.exec("BEGIN IMMEDIATE; UPDATE entries SET people=deducted_uses WHERE result='success' AND charge_type='count' AND deducted_uses>0; INSERT INTO settings(key,value) VALUES('migration_entry_people_v1','1'); COMMIT;");
}
ensureColumn('members', 'is_imported', 'is_imported INTEGER NOT NULL DEFAULT 0');
db.exec('DROP INDEX IF EXISTS idx_orders_request_id;');
db.exec('DROP INDEX IF EXISTS idx_entries_request_id;');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_staff_request_id ON orders(staff_id, request_id) WHERE request_id IS NOT NULL;');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_staff_request_id ON entries(staff_id, request_id) WHERE request_id IS NOT NULL;');
db.exec('CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);');
db.exec('CREATE INDEX IF NOT EXISTS idx_member_cards_member ON member_cards(member_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_member ON orders(member_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_original ON orders(original_order_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_payments_order_paid_at ON payments(order_id, paid_at);');
db.exec('CREATE INDEX IF NOT EXISTS idx_entries_member_entry_at ON entries(member_id, entry_at);');
// 卡项名称是会员导入匹配与收银选择的依据；有历史重名时跳过并告警，不阻塞启动。
try {
  const dup = db.prepare('SELECT name FROM card_products GROUP BY name HAVING COUNT(*) > 1 LIMIT 1').get();
  if (dup) console.warn(`[数据检查] 卡项名称“${dup.name}”存在重名，暂不创建唯一索引，请人工整理。`);
  else db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_card_products_name ON card_products(name)');
} catch (e) {
  console.warn('[数据检查] 创建卡项名称唯一索引失败：' + (e && e.message));
}

// 不再根据当前卡项猜测历史授予权益。缺失快照的历史退款交由人工核算。
// 兼容现有库的约束使用触发器，不重建或覆盖业务表。
for (const [table, predicate] of [
  ['member_cards', "NEW.balance < 0 OR NEW.balance > 1000000000 OR NEW.remaining_uses < 0"],
  ['payments', 'ABS(NEW.amount) > 1000000000'],
  ['orders', 'NEW.total_amount < 0 OR NEW.total_amount > 1000000000 OR NEW.paid_amount < 0 OR NEW.paid_amount > 1000000000']
]) {
  for (const event of ['INSERT', 'UPDATE']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS guard_${table}_${event.toLowerCase()} BEFORE ${event} ON ${table} WHEN ${predicate} BEGIN SELECT RAISE(ABORT, '金额或权益超出安全范围'); END;`);
  }
}

// ---------------------------------------------------------------------------
// 默认设置
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  store_name: '峡谷游泳馆',
  month_rule: 'purchase',   // 月卡起算方式：natural 自然月 / purchase 购买日起算
  default_entry_fee: '30',  // 新建储值卡时的默认单次入场扣费
  wechat_appid: '',         // 微信小程序 AppID（员工微信登录用）
  wechat_secret: '',        // 微信小程序 AppSecret
  brand_icon: '🏊',         // 品牌图标（emoji/文字，或上传图片后由 brand_logo_img 覆盖）
  brand_logo_img: '',       // 品牌图标图片（base64 data URL，可选）
  login_bg: '',             // 登录页背景图（base64 data URL，可选）
  dashboard_bg: '',         // 首页欢迎区背景图（base64 data URL，可选）
  icp_no: '',               // ICP 备案号（登录页底部预留）
  public_security_no: '',   // 公安网安备案号（登录页底部预留）
  sms_enabled: '0',
  sms_provider: 'tencent',
  sms_secret_id: '',
  sms_secret_key: '',
  sms_sdk_app_id: '',
  sms_sign_name: '',
  sms_template_account_change: '',
  aliyun_access_key_id: '',
  aliyun_access_key_secret: '',
  aliyun_sign_name: '',
  aliyun_template_account_change: ''
};

function initSettings() {
  const insert = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = Object.create(null);
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}

function setSettings(patch) {
  const upsert = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (Object.hasOwn(DEFAULT_SETTINGS, k) || k === 'store_name') upsert.run(k, String(v));
  }
}

// ---------------------------------------------------------------------------
// 种子数据
// ---------------------------------------------------------------------------
function initialPassword(envName) {
  const configured = String(process.env[envName] || '');
  if (configured.length >= 8) return { password: configured, generated: false };
  return { password: crypto.randomBytes(18).toString('base64url'), generated: true };
}
function writeInitialPasswords(rows) {
  const file = path.join(DATA_DIR, 'initial-passwords.txt');
  const content = [
    '游泳池管理系统初始账号（首次登录后请立即修改密码并删除本文件）',
    '',
    ...rows.map(({ username, password }) => `${username}\t${password}`),
    ''
  ].join('\n');
  fs.writeFileSync(file, content, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows 等平台可能不支持 */ }
  return file;
}
function seedStaff() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM staff').get().n;
  if (n > 0) return;
  const ts = now();
  const ins = db.prepare('INSERT INTO staff(username, password_hash, real_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const credentials = [
    ['admin', 'PMS_INITIAL_ADMIN_PASSWORD', '超管', 'admin'],
    ['boss', 'PMS_INITIAL_BOSS_PASSWORD', '老板', 'boss'],
    ['frontdesk', 'PMS_INITIAL_FRONTDESK_PASSWORD', '前台小陈', 'frontdesk'],
    ['finance', 'PMS_INITIAL_FINANCE_PASSWORD', '财务小李', 'finance']
  ];
  const generated = [];
  for (const [username, envName, realName, role] of credentials) {
    const { password, generated: isGenerated } = initialPassword(envName);
    ins.run(username, hashPassword(password), realName, role, 'active', ts);
    if (isGenerated) generated.push({ username, password });
  }
  if (generated.length) {
    const file = writeInitialPasswords(generated);
    if (process.env.NODE_ENV !== 'test') console.warn(`[初始账号] 随机初始密码已写入 ${file}（权限 600），请登录后修改并删除该文件。`);
  }
}

function seedCardProducts() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM card_products').get().n;
  if (n > 0) return;
  const ts = now();
  const ins = db.prepare(`INSERT INTO card_products(name, type, price, duration_days, total_uses, stored_value, entry_fee, freeze_allowed, transfer_allowed, extension_allowed, enabled, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?, ?, ?)`);
  ins.run('次卡 10 次', 'count', 250, 180, 10, 0, 0, '10次计次卡', ts, ts);
  ins.run('次卡 20 次', 'count', 450, 365, 20, 0, 0, '20次计次卡', ts, ts);
  ins.run('月卡', 'month', 300, 30, 0, 0, 0, '月卡', ts, ts);
  ins.run('年卡', 'year', 2800, 365, 0, 0, 0, '年卡', ts, ts);
  ins.run('储值卡', 'stored', 500, 0, 0, 500, 30, '储值卡', ts, ts);
}

function seedDemoMembers() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM members').get().n;
  if (n > 0) return;
  const ts = now();
  const ins = db.prepare(`INSERT INTO members(member_no, name, phone, gender, birthday, note, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'normal', ?, ?)`);
  ins.run('M000001', '张伟', '13800000001', 'male', null, '演示会员', ts, ts);
  ins.run('M000002', '李娜', '13800000002', 'female', null, null, ts, ts);
  ins.run('M000003', '王小明', '13800000003', 'male', '2015-06-01', '儿童会员', ts, ts);
}

// 确保存在一个超管账号（兼容旧库：已有 staff 但无 admin 时补建）
function ensureAdmin() {
  const has = db.prepare("SELECT id FROM staff WHERE role = 'admin'").get();
  if (has) return;
  const taken = db.prepare('SELECT id FROM staff WHERE username = ?').get('admin');
  if (taken) throw new Error('旧库缺少超管且 admin 用户名已占用，请由维护人员处理账号后重新启动');
  const password = String(process.env.PMS_INITIAL_ADMIN_PASSWORD || '');
  if (password.length < 8) throw new Error('旧库缺少超管，请设置至少 8 位的 PMS_INITIAL_ADMIN_PASSWORD 后重新启动');
  db.prepare('INSERT INTO staff(username, password_hash, real_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('admin', hashPassword(password), '超管', 'admin', 'active', now());
}

initSettings();
seedStaff();
ensureAdmin();
seedCardProducts();
// 演示会员仅在显式设置 PMS_SEED_DEMO=1 时写入，避免生产环境重启后自动恢复测试数据。
if (process.env.PMS_SEED_DEMO === '1') seedDemoMembers();

module.exports = { db, DB_PATH, getSettings, getSetting, setSettings, DEFAULT_SETTINGS };
