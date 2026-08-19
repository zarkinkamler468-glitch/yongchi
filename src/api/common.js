'use strict';

const { db, getSetting } = require('../db');
const { today, now, addDays, nextNo, pad } = require('../util');
const { httpError } = require('../http');

const CARD_TYPES = ['count', 'month', 'year', 'stored'];

// 手机号在写入前统一去除常见分隔符，避免同一号码因录入格式不同重复建档。
function normalizePhone(value) {
  return String(value || '').trim().replace(/[\s-]/g, '');
}

function nextMemberNo() { return nextNo(db, 'members', 'M', 6); }
function nextCardNo() { return nextNo(db, 'member_cards', 'C', 8); }
function nextOrderNo() { return nextNo(db, 'orders', 'O', 8); }

// 解析会员：有 member_id 用之；否则按姓名/手机号新建（手机号唯一）
function resolveMember(body) {
  if (body.member_id) {
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(body.member_id);
    if (m) return m;
    throw httpError(404, '会员不存在');
  }
  const name = (body.name || '').trim();
  if (!name) throw httpError(400, '请填写会员姓名');
  const phone = normalizePhone(body.phone) || null;
  if (phone) {
    const dup = db.prepare('SELECT * FROM members WHERE phone = ?').get(phone);
    if (dup) throw httpError(400, '该手机号已绑定其他会员，不可重复');
  }
  const ts = now();
  const r = db.prepare(`INSERT INTO members(member_no, name, phone, gender, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'normal', ?, ?)`)
    .run(nextMemberNo(), name, phone, body.gender || 'unknown', ts, ts);
  return db.prepare('SELECT * FROM members WHERE id = ?').get(Number(r.lastInsertRowid));
}

// 确保员工存在进行中的班次，不存在则自动开一个
function ensureShift(staffId) {
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
function computeCardEnd(type, durationDays) {
  if (type === 'stored' || !durationDays || durationDays <= 0) return null;
  if (type === 'month' && getSetting('month_rule') === 'natural') return monthEnd(today());
  return addDays(today(), durationDays);
}

module.exports = { CARD_TYPES, normalizePhone, nextMemberNo, nextCardNo, nextOrderNo, resolveMember, ensureShift, computeCardEnd };
