'use strict';

const { db } = require('../db');
const { today, addDays, money } = require('../util');
const { ok, fail } = require('../http');

function dayRange(date) {
  return [date, addDays(date, 1)];
}

function incomeBetween(from, to) {
  const r = db.prepare("SELECT COALESCE(SUM(paid_amount),0) AS v FROM orders WHERE order_type IN ('open','renew','recharge') AND status IN ('paid','partial_refund','refunded') AND created_at >= ? AND created_at < ?").get(from, to);
  return Number(r.v) - refundBetween(from, to);
}
function refundBetween(from, to) {
  const r = db.prepare("SELECT COALESCE(SUM(total_amount),0) AS v FROM orders WHERE order_type = 'refund' AND status = 'paid' AND created_at >= ? AND created_at < ?").get(from, to);
  return Number(r.v);
}
function reportRange(query) {
  const from = query.get('from') || addDays(today(), -29);
  const endDate = query.get('to') || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return { error: fail(400, '日期格式无效') };
  if (from > endDate) return { error: fail(400, '开始日期不能晚于结束日期') };
  if (from > today() || endDate > today()) return { error: fail(400, '不能查询未来日期') };
  return { from, to: endDate + 'T23:59:59', endDate };
}

// GET /api/dashboard  首页总览
function dashboard({ req }) {
  const [d0, d1] = dayRange(today());
  const income = incomeBetween(d0, d1);
  const refund = refundBetween(d0, d1);
  const open = db.prepare("SELECT COALESCE(SUM(paid_amount),0) AS v FROM orders WHERE order_type='open' AND status IN ('paid','partial_refund','refunded') AND created_at >= ? AND created_at < ?").get(d0, d1).v;
  const renew = db.prepare("SELECT COALESCE(SUM(paid_amount),0) AS v FROM orders WHERE order_type='renew' AND status IN ('paid','partial_refund','refunded') AND created_at >= ? AND created_at < ?").get(d0, d1).v;
  const recharge = db.prepare("SELECT COALESCE(SUM(paid_amount),0) AS v FROM orders WHERE order_type='recharge' AND status IN ('paid','partial_refund','refunded') AND created_at >= ? AND created_at < ?").get(d0, d1).v;
  const entries = db.prepare("SELECT COUNT(*) AS v FROM entries WHERE result='success' AND entry_at >= ? AND entry_at < ?").get(d0, d1).v;
  const expiring = db.prepare("SELECT COUNT(*) AS v FROM member_cards WHERE card_type IN ('month','year') AND status = 'normal' AND end_at IS NOT NULL AND end_at >= ? AND end_at <= ?").get(today(), addDays(today(), 7)).v;
  const lowBalance = db.prepare("SELECT COUNT(*) AS v FROM member_cards mc WHERE mc.card_type='stored' AND mc.status='normal' AND mc.balance < mc.entry_fee").get().v;
  const blacklist = db.prepare("SELECT COUNT(*) AS v FROM members WHERE status='blacklist'").get().v;
  const shift = db.prepare("SELECT * FROM shifts WHERE staff_id = ? AND status = 'active'").get(req.user.id);

  // 近 14 天收入趋势
  const recent = [];
  for (let i = 13; i >= 0; i--) {
    const day = addDays(today(), -i);
    const [a, b] = dayRange(day);
    recent.push({ date: day, income: money(incomeBetween(a, b)), entries: db.prepare("SELECT COUNT(*) AS v FROM entries WHERE result='success' AND entry_at >= ? AND entry_at < ?").get(a, b).v });
  }

  return ok({
    today_income: money(income),
    today_open: money(open),
    today_renew: money(renew),
    today_recharge: money(recharge),
    today_refund: money(refund),
    today_entries: entries,
    expiring_cards: expiring,
    low_balance_members: lowBalance,
    blacklist_count: blacklist,
    current_shift: shift ? { id: shift.id, started_at: shift.started_at, status: shift.status } : null,
    recent
  });
}

// GET /api/reports/overview?from=&to=  经营汇总
function overview({ query }) {
  const range = reportRange(query); if (range.error) return range.error;
  const { from, to } = range;
  const income = incomeBetween(from, to);
  const refund = refundBetween(from, to);
  const entries = db.prepare("SELECT COUNT(*) AS v FROM entries WHERE result='success' AND entry_at >= ? AND entry_at <= ?").get(from, to).v;
  const newMembers = db.prepare('SELECT COUNT(*) AS v FROM members WHERE created_at >= ? AND created_at <= ?').get(from, to).v;

  const byCard = db.prepare(`
    SELECT mc.card_type, COALESCE(SUM(p.amount),0) AS amount
    FROM payments p JOIN orders o ON o.id = p.order_id LEFT JOIN member_cards mc ON mc.id = o.member_card_id
    WHERE p.paid_at >= ? AND p.paid_at <= ?
    GROUP BY mc.card_type
  `).all(from, to);

  const byPay = db.prepare(`
    SELECT p.pay_method, COALESCE(SUM(p.amount),0) AS amount
    FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE p.paid_at >= ? AND p.paid_at <= ?
    GROUP BY p.pay_method
  `).all(from, to);

  const byStaff = db.prepare(`
    SELECT o.staff_id, s.real_name, COALESCE(SUM(p.amount),0) AS amount, COUNT(DISTINCT o.id) AS cnt
    FROM payments p JOIN orders o ON o.id = p.order_id LEFT JOIN staff s ON s.id = o.staff_id
    WHERE p.paid_at >= ? AND p.paid_at <= ?
    GROUP BY o.staff_id
  `).all(from, to);

  return ok({
    income: money(income), refund: money(refund), entries, new_members: newMembers,
    by_card: byCard, by_pay: byPay, by_staff: byStaff
  });
}

// GET /api/reports/staff-performance?from=&to=
// 按原销售订单操作员汇总绩效；退款回冲原销售员工，审批人仅用于审计。
function staffPerformance({ query }) {
  const range = reportRange(query); if (range.error) return range.error;
  const { from, to } = range;
  const rows = db.prepare(`
    SELECT s.id, s.username, s.real_name,
      COALESCE(SUM(CASE WHEN o.order_type = 'open' AND o.status IN ('paid','partial_refund','refunded') THEN 1 ELSE 0 END),0) AS open_count,
      COALESCE(SUM(CASE WHEN o.order_type = 'open' AND o.status IN ('paid','partial_refund','refunded') THEN o.paid_amount ELSE 0 END),0) AS open_amount,
      COALESCE(SUM(CASE WHEN o.order_type = 'renew' AND o.status IN ('paid','partial_refund','refunded') THEN 1 ELSE 0 END),0) AS renew_count,
      COALESCE(SUM(CASE WHEN o.order_type = 'renew' AND o.status IN ('paid','partial_refund','refunded') THEN o.paid_amount ELSE 0 END),0) AS renew_amount,
      COALESCE(SUM(CASE WHEN o.order_type = 'recharge' AND o.status IN ('paid','partial_refund','refunded') THEN 1 ELSE 0 END),0) AS recharge_count,
      COALESCE(SUM(CASE WHEN o.order_type = 'recharge' AND o.status IN ('paid','partial_refund','refunded') THEN o.paid_amount ELSE 0 END),0) AS recharge_amount,
      COALESCE(SUM(CASE WHEN o.order_type IN ('open','renew','recharge') AND o.status IN ('paid','partial_refund','refunded') THEN o.paid_amount ELSE 0 END),0) AS gross_amount,
      COALESCE((SELECT COUNT(*) FROM orders r JOIN orders original ON original.id=r.original_order_id WHERE r.order_type='refund' AND r.status='paid' AND original.staff_id=s.id AND r.created_at >= ? AND r.created_at <= ?),0) AS refund_count,
      COALESCE((SELECT SUM(r.total_amount) FROM orders r JOIN orders original ON original.id=r.original_order_id WHERE r.order_type='refund' AND r.status='paid' AND original.staff_id=s.id AND r.created_at >= ? AND r.created_at <= ?),0) AS refund_amount
    FROM staff s LEFT JOIN orders o ON o.staff_id = s.id AND o.created_at >= ? AND o.created_at <= ?
    WHERE s.status = 'active' OR EXISTS (SELECT 1 FROM orders ox WHERE ox.staff_id=s.id AND ox.created_at >= ? AND ox.created_at <= ?)
    GROUP BY s.id ORDER BY gross_amount DESC, s.id
  `).all(from, to, from, to, from, to, from, to);
  return ok({ from, to: to.slice(0, 10), list: rows.map((r) => ({ ...r, open_amount: money(r.open_amount), renew_amount: money(r.renew_amount), recharge_amount: money(r.recharge_amount), gross_amount: money(r.gross_amount), refund_amount: money(r.refund_amount), net_amount: money(Number(r.gross_amount) - Number(r.refund_amount)) })) });
}

// GET /api/reports/cards-expiring?days=30
function cardsExpiring({ query }) {
  const days = Number(query.get('days')) || 30;
  if (!Number.isFinite(days) || days < 0 || days > 3650) return fail(400, '查询天数范围无效');
  const rows = db.prepare(`
    SELECT mc.*, m.name AS member_name, m.member_no, m.phone
    FROM member_cards mc JOIN members m ON m.id = mc.member_id
    WHERE mc.card_type IN ('month','year') AND mc.status = 'normal' AND mc.end_at IS NOT NULL AND mc.end_at >= ? AND mc.end_at <= ?
    ORDER BY mc.end_at LIMIT 500
  `).all(today(), addDays(today(), days));
  return ok({ list: rows });
}

// CSV 导出：订单流水
function csvEscape(v) {
  let s = String(v === null || v === undefined ? '' : v);
  // 防止 Excel / WPS 将会员输入的内容当作公式执行。
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportOrders({ query }) {
  const range = reportRange(query); if (range.error) return range.error;
  const { from, to, endDate } = range;
  const rows = db.prepare(`
    SELECT o.order_no, o.order_type, o.status, o.total_amount, o.discount_amount, o.payable_amount, o.paid_amount, o.created_at,
      m.name AS member_name, m.member_no, mc.card_no, s.real_name AS staff_name
    FROM orders o
    LEFT JOIN members m ON m.id = o.member_id
    LEFT JOIN member_cards mc ON mc.id = o.member_card_id
    LEFT JOIN staff s ON s.id = o.staff_id
    WHERE o.created_at >= ? AND o.created_at <= ?
    ORDER BY o.id
  `).all(from, to);
  const head = ['订单号', '类型', '状态', '原价', '优惠', '应付', '实付', '会员', '会员号', '卡号', '操作员', '时间'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([r.order_no, r.order_type, r.status, r.total_amount, r.discount_amount, r.payable_amount, r.paid_amount, r.member_name, r.member_no, r.card_no, r.staff_name, r.created_at].map(csvEscape).join(','));
  }
  return ok({ csv: '\ufeff' + lines.join('\n'), filename: `订单流水_${from}_${endDate}.csv` });
}

function exportMembers() {
  const rows = db.prepare('SELECT * FROM members ORDER BY id').all();
  const head = ['会员编号', '姓名', '手机号', '性别', '生日', '状态', '备注', '创建时间'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([r.member_no, r.name, r.phone, r.gender, r.birthday, r.status, r.note, r.created_at].map(csvEscape).join(','));
  }
  return ok({ csv: '\ufeff' + lines.join('\n'), filename: `会员_${today()}.csv` });
}

module.exports = { dashboard, overview, staffPerformance, cardsExpiring, exportOrders, exportMembers };
