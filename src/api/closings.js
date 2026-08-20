'use strict';

const { db } = require('../db');
const { today, now, addDays, money } = require('../util');
const { ok, fail } = require('../http');
const audit = require('./audit');

function computeDaily(date) {
  const next = addDays(date, 1);
  const grossIncome = db.prepare("SELECT COALESCE(SUM(paid_amount),0) AS v FROM orders WHERE order_type IN ('open','renew','recharge') AND status IN ('paid','partial_refund','refunded') AND created_at >= ? AND created_at < ?").get(date, next).v;
  const refund = db.prepare("SELECT COALESCE(SUM(total_amount),0) AS v FROM orders WHERE order_type = 'refund' AND status = 'paid' AND created_at >= ? AND created_at < ?").get(date, next).v;
  const entries = db.prepare("SELECT COUNT(*) AS v FROM entries WHERE result = 'success' AND entry_at >= ? AND entry_at < ?").get(date, next).v;
  const newMembers = db.prepare('SELECT COUNT(*) AS v FROM members WHERE created_at >= ? AND created_at < ?').get(date, next).v;
  return { total_income: money(Number(grossIncome) - Number(refund)), total_refund: money(refund), total_entries: entries, new_members: newMembers };
}

// GET /api/closings
function list() {
  const rows = db.prepare('SELECT d.*, s.real_name AS closed_by_name FROM daily_closings d LEFT JOIN staff s ON s.id = d.closed_by ORDER BY d.business_date DESC LIMIT 200').all();
  return ok({ list: rows });
}

// GET /api/closings/:date
function get({ params }) {
  const d = db.prepare('SELECT d.*, s.real_name AS closed_by_name FROM daily_closings d LEFT JOIN staff s ON s.id = d.closed_by WHERE d.business_date = ?').get(params.date);
  return ok({ closing: d || null, preview: computeDaily(params.date) });
}

// POST /api/closings  （财务/老板执行日结）
function create({ body, req }) {
  const date = body.business_date || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(400, '营业日期格式无效');
  if (date > today()) return fail(400, '不能对未来日期执行日结');
  const existing = db.prepare('SELECT * FROM daily_closings WHERE business_date = ?').get(date);
  const summary = computeDaily(date);
  if (existing) {
    // 老板可调整（覆盖为已调整状态）
    if (req.user.role !== 'boss' && req.user.role !== 'admin') return fail(403, '仅老板可调整已完成的日结');
    db.prepare("UPDATE daily_closings SET total_income = ?, total_refund = ?, total_entries = ?, new_members = ?, closed_by = ?, closed_at = ?, status = 'adjusted' WHERE business_date = ?")
      .run(summary.total_income, summary.total_refund, summary.total_entries, summary.new_members, req.user.id, now(), date);
  } else {
    db.prepare("INSERT INTO daily_closings(business_date, total_income, total_refund, total_entries, new_members, closed_by, closed_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'closed')")
      .run(date, summary.total_income, summary.total_refund, summary.total_entries, summary.new_members, req.user.id, now());
  }
  audit.record({ req, action: existing ? '日结调整' : '执行日结', target_type: 'daily_closing', target_id: existing ? existing.id : undefined, after: { business_date: date, ...summary } });
  return ok({ closing: db.prepare('SELECT * FROM daily_closings WHERE business_date = ?').get(date) });
}

module.exports = { list, get, create, computeDaily };
