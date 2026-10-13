'use strict';

const { db } = require('../db');
const { today, now, addDays, money, isDateString } = require('../util');
const { ok, fail } = require('../http');
const audit = require('./audit');
const { paginate } = require('./pagination');

function computeDaily(date) {
  const next = addDays(date, 1);
  const grossIncome = db.prepare(`SELECT COALESCE(SUM(p.amount),0) AS v FROM payments p JOIN orders o ON o.id=p.order_id
    WHERE o.order_type IN ('open','renew','recharge') AND p.amount > 0 AND p.pay_method != 'stored' AND p.paid_at >= ? AND p.paid_at < ?`).get(date, next).v;
  const refund = db.prepare(`SELECT COALESCE(SUM(-p.amount),0) AS v FROM payments p JOIN orders o ON o.id=p.order_id
    WHERE o.order_type='refund' AND o.status='paid' AND p.amount < 0 AND p.pay_method != 'stored' AND p.paid_at >= ? AND p.paid_at < ?`).get(date, next).v;
  const entries = db.prepare("SELECT COALESCE(SUM(people),0) AS v FROM entries WHERE result = 'success' AND entry_at >= ? AND entry_at < ?").get(date, next).v;
  const newMembers = db.prepare('SELECT COUNT(*) AS v FROM members WHERE is_imported = 0 AND created_at >= ? AND created_at < ?').get(date, next).v;
  return { total_income: money(Number(grossIncome) - Number(refund)), total_refund: money(refund), total_entries: entries, new_members: newMembers };
}

// GET /api/closings
function list({ query } = {}) {
  return ok(paginate('SELECT d.*, s.real_name AS closed_by_name FROM daily_closings d LEFT JOIN staff s ON s.id = d.closed_by ORDER BY d.business_date DESC', [], query));
}

// GET /api/closings/:date
function get({ params }) {
  if (!isDateString(params.date)) return fail(400, '营业日期格式无效');
  const d = db.prepare('SELECT d.*, s.real_name AS closed_by_name FROM daily_closings d LEFT JOIN staff s ON s.id = d.closed_by WHERE d.business_date = ?').get(params.date);
  return ok({ closing: d || null, preview: computeDaily(params.date) });
}

// POST /api/closings  （财务/老板执行日结）
function create({ body, req }) {
  const date = body.business_date || today();
  if (!isDateString(date)) return fail(400, '营业日期格式无效');
  if (date > today()) return fail(400, '不能对未来日期执行日结');
  db.exec('BEGIN IMMEDIATE');
  try {
  if (date === today() && db.prepare("SELECT id FROM shifts WHERE status='active' LIMIT 1").get()) {
    db.exec('ROLLBACK'); return fail(400, '仍有进行中的班次，请全部交班后再执行今日日结');
  }
  const existing = db.prepare('SELECT * FROM daily_closings WHERE business_date = ?').get(date);
  const summary = computeDaily(date);
  if (existing) {
    // 老板可调整（覆盖为已调整状态）
    if (existing.status !== 'reopened' && req.user.role !== 'boss' && req.user.role !== 'admin') {
      db.exec('ROLLBACK'); return fail(403, '仅老板可调整已完成的日结');
    }
    db.prepare("UPDATE daily_closings SET total_income = ?, total_refund = ?, total_entries = ?, new_members = ?, closed_by = ?, closed_at = ?, status = 'adjusted' WHERE business_date = ?")
      .run(summary.total_income, summary.total_refund, summary.total_entries, summary.new_members, req.user.id, now(), date);
  } else {
    db.prepare("INSERT INTO daily_closings(business_date, total_income, total_refund, total_entries, new_members, closed_by, closed_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'closed')")
      .run(date, summary.total_income, summary.total_refund, summary.total_entries, summary.new_members, req.user.id, now());
  }
  audit.record({ req, action: existing ? '日结调整' : '执行日结', target_type: 'daily_closing', target_id: existing ? existing.id : undefined, after: { business_date: date, ...summary } });
  db.exec('COMMIT');
  return ok({ closing: db.prepare('SELECT * FROM daily_closings WHERE business_date = ?').get(date) });
  } catch (e) { db.exec('ROLLBACK'); return fail(e.status || 500, e.message); }
}

function reopen({ params, body, req }) {
  if (!['boss', 'admin'].includes(req.user.role)) return fail(403, '仅老板可重开营业日');
  if (!isDateString(params.date) || params.date > today()) return fail(400, '营业日期格式无效');
  const reason = String(body.reason || '').trim();
  if (!reason || reason.length > 500) return fail(400, '请填写 1 到 500 字的重开原因');
  const existing = db.prepare('SELECT * FROM daily_closings WHERE business_date=?').get(params.date);
  if (!existing) return fail(404, '该营业日尚未日结');
  if (existing.status === 'reopened') return ok({ closing: existing });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE daily_closings SET status='reopened' WHERE id=?").run(existing.id);
    audit.record({ req, action: '重开营业日', target_type: 'daily_closing', target_id: existing.id, before: existing, reason });
    db.exec('COMMIT');
    return ok({ closing: { ...existing, status: 'reopened' } });
  } catch (e) { db.exec('ROLLBACK'); return fail(500, e.message); }
}

module.exports = { list, get, create, computeDaily, reopen };
