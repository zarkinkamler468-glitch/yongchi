'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { today, now, addMonths, addDays, nextNo } = require('./util');
const { hashPassword } = require('./crypto');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.PMS_DB_PATH ? path.resolve(process.env.PMS_DB_PATH) : path.join(DEFAULT_DATA_DIR, 'pool.db');
const DATA_DIR = path.dirname(DB_PATH);

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// settings 表最先创建，用于存放迁移标记与全局配置
db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);`);

// 一次性迁移：旧版（散客/课程/季卡模型）表直接清理
const migrated = db.prepare("SELECT value FROM settings WHERE key = 'schema_v05'").get();
if (!migrated) {
  db.exec(`
    DROP TABLE IF EXISTS transactions;
    DROP TABLE IF EXISTS checkins;
    DROP TABLE IF EXISTS coaches;
    DROP TABLE IF EXISTS courses;
    DROP TABLE IF EXISTS enrollments;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS audit_logs;
    DROP TABLE IF EXISTS members;
  `);
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
`);

// 旧库补齐微信绑定列
ensureColumn('staff', 'wx_openid', 'wx_openid TEXT');
ensureColumn('orders', 'benefit_uses', 'benefit_uses INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'benefit_amount', 'benefit_amount REAL NOT NULL DEFAULT 0');
ensureColumn('orders', 'benefit_days', 'benefit_days INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'approved_at', 'approved_at TEXT');
ensureColumn('orders', 'request_id', 'request_id TEXT');
ensureColumn('payments', 'source_card_id', 'source_card_id INTEGER');
ensureColumn('entries', 'request_id', 'request_id TEXT');
db.exec('DROP INDEX IF EXISTS idx_orders_request_id;');
db.exec('DROP INDEX IF EXISTS idx_entries_request_id;');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_staff_request_id ON orders(staff_id, request_id) WHERE request_id IS NOT NULL;');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_staff_request_id ON entries(staff_id, request_id) WHERE request_id IS NOT NULL;');

// 兼容旧订单：新增退款权益快照字段后，为仍未发生退款的历史订单尽可能回填卡项权益。
// 已经产生部分退款的订单不强行重算，避免改变既有账务结果。
db.exec(`
  UPDATE orders SET benefit_uses = COALESCE((SELECT cp.total_uses FROM card_products cp JOIN member_cards mc ON mc.card_product_id = cp.id WHERE mc.id = orders.member_card_id), 0)
  WHERE benefit_uses = 0 AND order_type IN ('open','renew') AND member_card_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM orders r WHERE r.original_order_id = orders.id AND r.order_type = 'refund');
  UPDATE orders SET benefit_amount = CASE
    WHEN order_type = 'recharge' THEN paid_amount
    ELSE COALESCE((SELECT cp.stored_value FROM card_products cp JOIN member_cards mc ON mc.card_product_id = cp.id WHERE mc.id = orders.member_card_id), 0)
  END
  WHERE benefit_amount = 0 AND member_card_id IS NOT NULL AND order_type IN ('open','renew','recharge')
    AND EXISTS (SELECT 1 FROM member_cards mc WHERE mc.id = orders.member_card_id AND mc.card_type = 'stored')
    AND NOT EXISTS (SELECT 1 FROM orders r WHERE r.original_order_id = orders.id AND r.order_type = 'refund');
`);

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
  sms_secret_id: '',
  sms_secret_key: '',
  sms_sdk_app_id: '',
  sms_sign_name: '',
  sms_template_account_change: ''
};

function initSettings() {
  const insert = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
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
    if (k in DEFAULT_SETTINGS || k === 'store_name') upsert.run(k, String(v));
  }
}

// ---------------------------------------------------------------------------
// 种子数据
// ---------------------------------------------------------------------------
function initialPassword(envName, label) {
  const configured = String(process.env[envName] || '');
  if (configured.length >= 8) return configured;
  const generated = crypto.randomBytes(18).toString('base64url');
  if (process.env.NODE_ENV !== 'test') console.warn(`[安全提示] ${label} 使用随机初始密码，请从启动日志中获取并立即修改。`);
  return generated;
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
  for (const [username, envName, realName, role] of credentials) {
    const password = initialPassword(envName, `${username} 账号`);
    ins.run(username, hashPassword(password), realName, role, 'active', ts);
    if (process.env.NODE_ENV !== 'test') console.warn(`[初始账号] ${username} 初始密码：${password}`);
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
  if (taken) return;
  db.prepare('INSERT INTO staff(username, password_hash, real_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('admin', hashPassword(initialPassword('PMS_INITIAL_ADMIN_PASSWORD', '超管账号')), '超管', 'admin', 'active', now());
}

initSettings();
seedStaff();
ensureAdmin();
seedCardProducts();
// 演示会员仅在显式设置 PMS_SEED_DEMO=1 时写入，避免生产环境重启后自动恢复测试数据。
if (process.env.PMS_SEED_DEMO === '1') seedDemoMembers();

module.exports = { db, DB_PATH, getSettings, getSetting, setSettings, DEFAULT_SETTINGS };
