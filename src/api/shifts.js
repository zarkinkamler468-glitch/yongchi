'use strict';

const { db } = require('../db');
const { now, money } = require('../util');
const { ok, fail } = require('../http');
const audit = require('./audit');

function shiftSummary(shiftId) {
  const rows = db.prepare(`
    SELECT p.pay_method,
      COALESCE(SUM(CASE WHEN p.amount > 0 THEN p.amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN p.amount < 0 THEN -p.amount ELSE 0 END), 0) AS refund
    FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE o.shift_id = ? GROUP BY p.pay_method
  `).all(shiftId);
  const byMethod = {};
  let totalIncome = 0;
  let totalRefund = 0;
  for (const r of rows) {
    byMethod[r.pay_method] = { income: money(r.income), refund: money(r.refund) };
    if (r.pay_method !== 'stored') {
      totalIncome = money(totalIncome + r.income);
      totalRefund = money(totalRefund + r.refund);
    }
  }
  const cash = byMethod.cash || { income: 0, refund: 0 };
  const shift = db.prepare('SELECT opening_cash FROM shifts WHERE id = ?').get(shiftId);
  const cashShould = money(Number(shift && shift.opening_cash || 0) + cash.income - cash.refund);
  return { by_method: byMethod, total_income: totalIncome, total_refund: totalRefund, cash_should: cashShould };
}

function decorate(s) {
  const st = db.prepare('SELECT real_name FROM staff WHERE id = ?').get(s.staff_id);
  return { ...s, staff_name: st ? st.real_name : '' };
}

// GET /api/shifts
function list({ req, query }) {
  const where = [];
  const args = [];
  if (req.user.role === 'frontdesk') { where.push('s.staff_id = ?'); args.push(req.user.id); }
  const status = query.get('status');
  if (status) { where.push('s.status = ?'); args.push(status); }
  const sql = 'SELECT s.* FROM shifts s' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY s.id DESC LIMIT 500';
  const rows = db.prepare(sql).all(...args);
  return ok({ list: rows.map(decorate) });
}

// GET /api/shifts/current
function current({ req }) {
  const s = db.prepare("SELECT * FROM shifts WHERE staff_id = ? AND status = 'active'").get(req.user.id);
  return ok({ shift: s ? decorate(s) : null });
}

// POST /api/shifts/start
function start({ req, body }) {
  const active = db.prepare("SELECT * FROM shifts WHERE staff_id = ? AND status = 'active'").get(req.user.id);
  if (active) return ok({ shift: decorate(active) });
  const openingCash = money(body.opening_cash || 0);
  if (!Number.isFinite(Number(body.opening_cash || 0)) || openingCash < 0) return fail(400, '开班备用金不能为负数');
  const r = db.prepare("INSERT INTO shifts(staff_id, started_at, opening_cash, status) VALUES (?, ?, ?, 'active')")
    .run(req.user.id, now(), openingCash);
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(Number(r.lastInsertRowid));
  return ok({ shift: decorate(s) }, 201);
}

// GET /api/shifts/:id
function get({ params, req }) {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(params.id);
  if (!s) return fail(404, '班次不存在');
  if (req.user.role === 'frontdesk' && Number(s.staff_id) !== Number(req.user.id)) return fail(403, '前台只能查看自己的班次');
  const orders = db.prepare('SELECT * FROM orders WHERE shift_id = ? ORDER BY id DESC LIMIT 500').all(s.id);
  const summary = shiftSummary(s.id);
  return ok({ shift: decorate(s), summary, orders });
}

// POST /api/shifts/:id/close
function close({ params, body, req }) {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(params.id);
  if (!s) return fail(404, '班次不存在');
  if (s.status !== 'active') return fail(400, '该班次已交班');
  if (Number(s.staff_id) !== Number(req.user.id) && req.user.role === 'frontdesk') return fail(403, '前台只能交自己的班');
  const summary = shiftSummary(s.id);
  const actualCash = body.actual_cash === undefined || body.actual_cash === '' ? null : money(Number(body.actual_cash));
  if (actualCash !== null && (!Number.isFinite(Number(body.actual_cash)) || actualCash < 0)) return fail(400, '实点现金必须是非负数');
  let difference = null;
  if (actualCash !== null) difference = money(actualCash - summary.cash_should);
  if (difference !== null && Math.abs(difference) > 0.001 && !(body.note || '').trim()) {
    return fail(400, '现金差额不为 0 时必须填写说明');
  }
  db.prepare("UPDATE shifts SET ended_at = ?, cash_amount = ?, actual_cash = ?, difference = ?, note = ?, status = 'closed' WHERE id = ?")
    .run(now(), summary.cash_should, actualCash, difference, (body.note || '').trim() || null, s.id);
  audit.record({ req, action: '交班对账', target_type: 'shift', target_id: s.id, after: { actual_cash: actualCash, difference, cash_should: summary.cash_should } });
  return ok({ shift: decorate(db.prepare('SELECT * FROM shifts WHERE id = ?').get(s.id)), summary });
}

module.exports = { list, current, start, get, close, shiftSummary };
