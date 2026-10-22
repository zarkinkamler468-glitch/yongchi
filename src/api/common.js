'use strict';

const { db, getSetting } = require('../db');
const { today, now, addDays, nextNo, pad, isDateString } = require('../util');
const { httpError, fail } = require('../http');

const CARD_TYPES = ['count', 'month', 'year', 'stored'];

// 同步写操作及其审计作为一个事务；失败不留下已变更却返回错误的半完成状态。
function atomic(handler) {
  return args => {
    let started = false;
    try {
      db.exec('BEGIN IMMEDIATE'); started = true;
      const result = handler(args);
      db.exec(result && result.status >= 400 ? 'ROLLBACK' : 'COMMIT');
      started = false;
      return result;
    } catch (e) {
      if (started) { try { db.exec('ROLLBACK'); } catch (_) {} }
      if (!e || !e.status || e.status >= 500) console.error('[事务] 业务写入失败:', (e && e.stack) || e);
      return fail(e.status || 500, e.status ? e.message : '业务写入失败，请重试');
    }
  };
}

// 手机号在写入前统一去除常见分隔符，避免同一号码因录入格式不同重复建档。
function normalizePhone(value) {
  return String(value || '').trim().replace(/[\s-]/g, '');
}

function validateMemberProfile(body) {
  if (body.gender && !['male', 'female', 'unknown'].includes(body.gender)) throw httpError(400, '性别须为 male/female/unknown');
  if (body.birthday && (!isDateString(body.birthday) || body.birthday > today())) throw httpError(400, '生日格式无效或晚于今天');
  if (body.note && (typeof body.note !== 'string' || body.note.length > 500)) throw httpError(400, '备注必须为不超过 500 字的文本');
}

function nextMemberNo() { return nextNo(db, 'members', 'M', 6); }
function nextCardNo() { return nextNo(db, 'member_cards', 'C', 8); }
function nextOrderNo() { return nextNo(db, 'orders', 'O', 8); }

// 解析会员：有 member_id 用之；否则按姓名/手机号新建（手机号唯一）
function resolveMember(body) {
  validateMemberProfile(body);
  if (body.member_id) {
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(body.member_id);
    if (m) return m;
    throw httpError(404, '会员不存在');
  }
  const name = (body.name || '').trim();
  if (!name) throw httpError(400, '请填写会员姓名');
  if (name.length > 50) throw httpError(400, '姓名不能超过 50 个字');
  const phone = normalizePhone(body.phone) || null;
  if (phone && !/^1\d{10}$/.test(phone)) throw httpError(400, '手机号格式无效');
  if (phone) {
    const dup = db.prepare('SELECT * FROM members WHERE phone = ?').get(phone);
    if (dup) throw httpError(400, '该手机号已绑定其他会员，不可重复');
  }
  const ts = now();
  const r = db.prepare(`INSERT INTO members(member_no, name, phone, gender, birthday, note, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'normal', ?, ?)`)
    .run(nextMemberNo(), name, phone, body.gender || 'unknown', body.birthday || null, (body.note || '').trim() || null, ts, ts);
  return db.prepare('SELECT * FROM members WHERE id = ?').get(Number(r.lastInsertRowid));
}

// 确保员工存在进行中的班次，不存在则自动开一个
function ensureShift(staffId) {
  ensureBusinessOpen();
  let shift = db.prepare("SELECT * FROM shifts WHERE staff_id = ? AND status = 'active'").get(staffId);
  if (shift) return shift;
  const r = db.prepare("INSERT INTO shifts(staff_id, started_at, opening_cash, status) VALUES (?, ?, 0, 'active')")
    .run(staffId, now());
  return db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(r.lastInsertRowid));
}

// 某月最后一天
function monthEnd(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}`;
}

// 计算卡到期日：储值卡无期限；月卡按全局配置（自然月/购买日起算）；年卡/次卡按天数
function computeCardEnd(type, durationDays, base = today(), renewing = false) {
  if (type === 'stored' || !durationDays || durationDays <= 0) return null;
  if (type === 'month' && getSetting('month_rule') === 'natural') {
    return monthEnd(renewing ? addDays(monthEnd(base), 1) : base);
  }
  return addDays(base, durationDays);
}

function ensureBusinessOpen(date = today()) {
  if (db.prepare("SELECT id FROM daily_closings WHERE business_date=? AND status != 'reopened'").get(date)) {
    throw httpError(409, '该营业日已日结，请老板重开营业日后再办理');
  }
}

module.exports = { CARD_TYPES, atomic, normalizePhone, validateMemberProfile, nextMemberNo, nextCardNo, nextOrderNo, resolveMember, ensureShift, computeCardEnd, ensureBusinessOpen };
