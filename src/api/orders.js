'use strict';

const { db, getSetting } = require('../db');
const { today, now, money } = require('../util');
const { ok, fail, httpError } = require('../http');
const { nextOrderNo, nextCardNo, resolveMember, ensureShift, computeCardEnd } = require('./common');
const audit = require('./audit');
const sms = require('../sms');

const ORDER_TYPES = ['open', 'renew', 'recharge', 'refund'];
const PAY_METHODS = ['cash', 'wechat', 'alipay', 'stored'];

function orderById(id) { return db.prepare('SELECT * FROM orders WHERE id = ?').get(id); }

function alreadyRefunded(orderId) {
  const r = db.prepare("SELECT COALESCE(SUM(total_amount),0) AS s FROM orders WHERE original_order_id = ? AND order_type = 'refund' AND status = 'paid'").get(orderId);
  return Number(r.s);
}

function pendingRefunded(orderId, excludeId) {
  const r = db.prepare("SELECT COALESCE(SUM(total_amount),0) AS s FROM orders WHERE original_order_id = ? AND order_type = 'refund' AND status = 'pending'" + (excludeId ? ' AND id != ?' : ''))
    .get(orderId, ...(excludeId ? [excludeId] : []));
  return Number(r.s);
}

function rollbackError(e) {
  try { db.exec('ROLLBACK'); } catch (_) { /* no active transaction */ }
  return fail((e && e.status) || 500, (e && e.message) || '服务器错误');
}

function decorateOrder(o) {
  const m = db.prepare('SELECT name, member_no, phone FROM members WHERE id = ?').get(o.member_id);
  const card = o.member_card_id ? db.prepare('SELECT card_no, card_type FROM member_cards WHERE id = ?').get(o.member_card_id) : null;
  const s = db.prepare('SELECT real_name FROM staff WHERE id = ?').get(o.staff_id);
  return { ...o, member_name: m ? m.name : '—', member_no: m ? m.member_no : '', card_no: card ? card.card_no : '', staff_name: s ? s.real_name : '' };
}

// 扣减储值余额（支付方式为“储值”时）
function deductStored(memberId, amount, excludeCardId) {
  const cards = db.prepare("SELECT * FROM member_cards WHERE member_id = ? AND card_type = 'stored' AND status = 'normal' ORDER BY id").all(memberId);
  for (const c of cards) {
    if (excludeCardId && Number(c.id) === Number(excludeCardId)) continue;
    if (c.balance >= amount) {
      db.prepare('UPDATE member_cards SET balance = balance - ?, updated_at = ? WHERE id = ?').run(amount, now(), c.id);
      return c;
    }
  }
  throw httpError(400, '储值卡余额不足');
}

// ------------------------- 列表 / 详情 -------------------------

function list({ query, req }) {
  const where = [];
  const args = [];
  // 前台仅查看本人订单
  if (req.user.role === 'frontdesk') { where.push('o.staff_id = ?'); args.push(req.user.id); }
  // 收入订单与退款订单分开查询，避免混在收银流水中造成账目理解混乱。
  if (query.get('income_only') === '1') where.push("o.order_type IN ('open','renew','recharge')");
  const type = query.get('order_type');
  if (type) { where.push('o.order_type = ?'); args.push(type); }
  const status = query.get('status');
  if (status) { where.push('o.status = ?'); args.push(status); }
  const memberId = query.get('member_id');
  if (memberId) { where.push('o.member_id = ?'); args.push(memberId); }
  const staffId = query.get('staff_id');
  if (staffId) { where.push('o.staff_id = ?'); args.push(staffId); }
  const search = (query.get('search') || '').trim();
  if (search) {
    where.push('(m.name LIKE ? OR m.member_no LIKE ? OR m.phone LIKE ?)');
    const like = `%${search}%`; args.push(like, like, like);
  }
  const from = query.get('from');
  if (from) { where.push('o.created_at >= ?'); args.push(from); }
  const to = query.get('to');
  if (to) { where.push('o.created_at <= ?'); args.push(to + 'T23:59:59'); }
  const sql = 'SELECT o.* FROM orders o LEFT JOIN members m ON m.id = o.member_id' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY o.id DESC LIMIT 1000';
  const rows = db.prepare(sql).all(...args);
  return ok({ list: rows.map(decorateOrder), total: rows.length });
}

function get({ params, req }) {
  const o = orderById(params.id);
  if (!o) return fail(404, '订单不存在');
  if (req.user.role === 'frontdesk' && Number(o.staff_id) !== Number(req.user.id)) return fail(403, '前台只能查看本人订单');
  const payments = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id').all(o.id);
  return ok({ order: decorateOrder(o), payments });
}

// ------------------------- 收银开单（开卡/续费/储值充值） -------------------------

function create({ body, req }) {
  // 开卡、权益变更、支付记录必须作为一个原子操作；任一步失败都不能留下卡余额或次数。
  db.exec('BEGIN IMMEDIATE');
  try {
  const orderType = body.order_type;
  if (!['open', 'renew', 'recharge'].includes(orderType)) throw httpError(400, '无效的业务类型');
  if (orderType === 'open' && body.member_id) throw httpError(400, '开卡请直接填写新会员资料，无需选择已有会员');
  const member = resolveMember(body);
  if (member.status === 'blacklist') throw httpError(400, '黑名单会员禁止办卡、续费');
  if (member.status === 'inactive') throw httpError(400, '会员已停用');
  const staff = req.user;
  const shift = ensureShift(staff.id);
  const ts = now();

  let total = 0;
  let memberCardId = null;
  let benefitUses = 0;

  if (orderType === 'open') {
    const cp = db.prepare('SELECT * FROM card_products WHERE id = ?').get(body.card_product_id);
    if (!cp || !cp.enabled) throw httpError(400, '请选择有效的卡项');
    total = money(cp.price);
    benefitUses = cp.type === 'count' ? Number(cp.total_uses) || 0 : 0;
    const r = db.prepare(`INSERT INTO member_cards(member_id, card_product_id, card_no, card_type, start_at, end_at, remaining_uses, balance, entry_fee, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', ?, ?)`)
      .run(member.id, cp.id, nextCardNo(), cp.type, today(), computeCardEnd(cp.type, cp.duration_days),
        cp.total_uses || 0, money(cp.stored_value), money(cp.entry_fee), ts, ts);
    memberCardId = Number(r.lastInsertRowid);
  } else if (orderType === 'renew') {
    const card = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(body.member_card_id);
    if (!card || Number(card.member_id) !== Number(member.id)) throw httpError(400, '请选择正确的会员卡');
    if (['void', 'refunded'].includes(card.status)) throw httpError(400, '该卡已作废或退款，不可续费');
    const cp = db.prepare('SELECT * FROM card_products WHERE id = ?').get(body.card_product_id);
    if (!cp || !cp.enabled) throw httpError(400, '请选择有效的续费卡项');
    if (cp.type !== card.card_type) throw httpError(400, '续费需与会员卡同卡种');
    total = money(cp.price);
    benefitUses = cp.type === 'count' ? Number(cp.total_uses) || 0 : 0;
    memberCardId = card.id;
    if (cp.type === 'count') db.prepare('UPDATE member_cards SET remaining_uses = remaining_uses + ?, updated_at = ? WHERE id = ?').run(cp.total_uses || 0, ts, card.id);
    else if (cp.type === 'stored') db.prepare('UPDATE member_cards SET balance = balance + ?, updated_at = ? WHERE id = ?').run(money(cp.stored_value), ts, card.id);
    else {
      const base = card.end_at && card.end_at >= today() ? card.end_at : today();
      const end = computeCardEnd(cp.type, cp.duration_days);
      // 在现有有效期基础上顺延
      const endD = end ? new Date(end + 'T00:00:00') : null;
      const baseD = new Date(base + 'T00:00:00');
      let endAt = null;
      if (endD) {
        const days = Math.round((endD - new Date(today() + 'T00:00:00')) / 86400000);
        const dd = new Date(baseD); dd.setDate(dd.getDate() + days);
        endAt = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
      }
      db.prepare('UPDATE member_cards SET end_at = ?, status = ?, updated_at = ? WHERE id = ?').run(endAt, 'normal', ts, card.id);
    }
  } else {
    // recharge 储值充值
    const card = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(body.member_card_id);
    if (!card || Number(card.member_id) !== Number(member.id)) throw httpError(400, '请选择正确的会员卡');
    if (card.card_type !== 'stored') throw httpError(400, '储值充值需选择储值卡');
    if (['void', 'refunded'].includes(card.status)) throw httpError(400, '该卡已作废或退款，不可充值');
    total = money(body.amount);
    if (!(total > 0)) throw httpError(400, '充值金额必须大于 0');
    memberCardId = card.id;
    db.prepare('UPDATE member_cards SET balance = balance + ?, updated_at = ? WHERE id = ?').run(total, ts, card.id);
  }

  const discount = money(body.discount_amount || 0);
  const payable = money(total - discount);
  if (payable < 0) throw httpError(400, '优惠金额不能超过应付金额');

  // 校验支付
  const pays = Array.isArray(body.payments) ? body.payments : [];
  if (!pays.length) throw httpError(400, '请录入支付方式');
  let paySum = 0;
  for (const p of pays) {
    if (!PAY_METHODS.includes(p.pay_method)) throw httpError(400, '无效的支付方式');
    const amt = money(p.amount);
    if (!(amt > 0)) throw httpError(400, '支付金额必须大于 0');
    paySum = money(paySum + amt);
  }
  if (Math.abs(paySum - payable) > 0.01) throw httpError(400, `支付金额合计(${paySum})必须等于实付金额(${payable})`);

  // 创建订单
  const orderNo = nextOrderNo();
  const r = db.prepare(`INSERT INTO orders(order_no, order_type, member_id, member_card_id, total_amount, discount_amount, payable_amount, paid_amount, status, shift_id, staff_id, benefit_uses, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, ?)`)
    .run(orderNo, orderType, member.id, memberCardId, total, discount, payable, shift.id, staff.id, benefitUses, ts);
  const orderId = Number(r.lastInsertRowid);
  if (orderType === 'open') db.prepare('UPDATE member_cards SET created_order_id = ? WHERE id = ?').run(orderId, memberCardId);

  // 生成支付记录（储值支付同步扣余额）
  for (const p of pays) {
    if (p.pay_method === 'stored') deductStored(member.id, money(p.amount), orderType === 'open' ? memberCardId : null);
    db.prepare('INSERT INTO payments(order_id, pay_method, amount, transaction_no, paid_at, staff_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(orderId, p.pay_method, money(p.amount), p.transaction_no || null, ts, staff.id);
  }

  db.prepare("UPDATE orders SET status = 'paid', paid_amount = ? WHERE id = ?").run(payable, orderId);

  audit.record({ req, action: orderType === 'open' ? '开卡' : orderType === 'renew' ? '续费' : '储值充值', target_type: 'order', target_id: orderId, after: { order_no: orderNo, total, discount, payable, member_id: member.id, member_card_id: memberCardId } });

  db.exec('COMMIT');
  const eventLabel = orderType === 'open' ? '开卡成功' : orderType === 'renew' ? '续费成功' : '储值充值';
  const changeDetail = orderType === 'recharge' ? `充值${total}元` : `${eventLabel}，实付${payable}元`;
  sms.accountChange(member, eventLabel, changeDetail);
  return ok({ order: decorateOrder(orderById(orderId)), order_no: orderNo, amount: payable }, 201);
  } catch (e) {
    return rollbackError(e);
  }
}

// ------------------------- 退款 -------------------------

// 申请退款
function refundApply({ params, body, req }) {
  const o = orderById(params.id);
  if (!o) return fail(404, '订单不存在');
  if (!['open', 'renew', 'recharge'].includes(o.order_type)) return fail(400, '该订单不可退款');
  if (!['paid', 'partial_refund'].includes(o.status)) return fail(400, '该订单状态不可退款');
  // 待审批的退款也占用额度，避免同一订单重复提交全额退款。
  const max = money(Number(o.paid_amount) - alreadyRefunded(o.id) - pendingRefunded(o.id));
  if (max <= 0) return fail(400, '该订单已无可退金额');
  const amount = body.amount === undefined || body.amount === '' || body.amount === null ? max : money(Number(body.amount));
  if (!(amount > 0)) return fail(400, '退款金额无效');
  if (amount > max + 0.001) return fail(400, `退款金额不能超过可退金额 ${max}`);
  const reason = (body.reason || '').trim();
  const ts = now();
  const r = db.prepare(`INSERT INTO orders(order_no, order_type, member_id, member_card_id, original_order_id, total_amount, payable_amount, paid_amount, status, staff_id, refund_reason, created_at)
    VALUES (?, 'refund', ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?)`)
    .run(nextOrderNo(), o.member_id, o.member_card_id, o.id, amount, amount, req.user.id, reason, ts);
  audit.record({ req, action: '退款申请', target_type: 'order', target_id: Number(r.lastInsertRowid), after: { original_order_id: o.id, amount, reason } });
  return ok({ refund: decorateOrder(orderById(Number(r.lastInsertRowid))) }, 201);
}

// 退款单列表（审批用）
function refunds({ query }) {
  const where = ["o.order_type = 'refund'"];
  const args = [];
  const status = query.get('status');
  if (status) { where.push('o.status = ?'); args.push(status); }
  const rows = db.prepare('SELECT o.* FROM orders o WHERE ' + where.join(' AND ') + ' ORDER BY o.id DESC LIMIT 500').all(...args);
  return ok({ list: rows.map(decorateOrder) });
}

// 审批通过
function refundApprove({ params, body, req }) {
  db.exec('BEGIN IMMEDIATE');
  try {
  const r = orderById(params.id);
  if (!r || r.order_type !== 'refund') throw httpError(404, '退款单不存在');
  if (r.status !== 'pending') throw httpError(400, '该退款单已处理');
  const o = orderById(r.original_order_id);
  if (!o) throw httpError(404, '原订单不存在');
  const method = body.refund_method === 'cash' ? 'cash' : 'original';
  const ts = now();
  const amount = money(r.total_amount);
  const remainingRefundable = money(Number(o.paid_amount) - alreadyRefunded(o.id));
  if (amount > remainingRefundable + 0.001) throw httpError(400, `退款金额超过当前可退金额 ${remainingRefundable}`);

  // 生成负向支付记录
  if (method === 'cash') {
    db.prepare('INSERT INTO payments(order_id, pay_method, amount, paid_at, staff_id) VALUES (?, ?, ?, ?, ?)')
      .run(r.id, 'cash', -amount, ts, req.user.id);
  } else {
    // 原路退回：按原支付逐笔生成负向记录；储值退回余额
    const origPays = db.prepare('SELECT pay_method, amount FROM payments WHERE order_id = ? AND amount > 0').all(o.id);
    let remaining = amount;
    for (const p of origPays) {
      if (remaining <= 0) break;
      const amt = Math.min(remaining, Number(p.amount));
      db.prepare('INSERT INTO payments(order_id, pay_method, amount, paid_at, staff_id) VALUES (?, ?, ?, ?, ?)')
        .run(r.id, p.pay_method, -amt, ts, req.user.id);
      if (p.pay_method === 'stored') {
        // 退回储值余额到原会员储值卡
        const card = db.prepare("SELECT * FROM member_cards WHERE member_id = ? AND card_type = 'stored' AND status IN ('normal','frozen') ORDER BY id").get(o.member_id);
        if (card) db.prepare('UPDATE member_cards SET balance = balance + ?, updated_at = ? WHERE id = ?').run(amt, ts, card.id);
      }
      remaining = money(remaining - amt);
    }
  }

  // 收回权益
  const card = o.member_card_id ? db.prepare('SELECT * FROM member_cards WHERE id = ?').get(o.member_card_id) : null;
  if (card) {
    const refundedTotal = money(alreadyRefunded(o.id) + amount);
    const full = Math.abs(Number(o.paid_amount) - refundedTotal) <= 0.01;
    if (full && o.order_type === 'open') {
      const laterOrder = db.prepare("SELECT id FROM orders WHERE member_card_id = ? AND id != ? AND order_type IN ('open','renew','recharge') AND status IN ('paid','partial_refund') AND id > ?").get(card.id, o.id, o.id);
      if (laterOrder) throw httpError(400, '该开卡后已有后续业务，不能直接全额退款；请先处理后续订单');
      db.prepare("UPDATE member_cards SET status = 'refunded', remaining_uses = 0, balance = 0, updated_at = ? WHERE id = ?").run(ts, card.id);
    } else if (o.order_type === 'recharge' || card.card_type === 'stored') {
      db.prepare('UPDATE member_cards SET balance = MAX(0, balance - ?), updated_at = ? WHERE id = ?').run(amount, ts, card.id);
    } else if (card.card_type === 'count' && ['open', 'renew'].includes(o.order_type)) {
      const grantedUses = Number(o.benefit_uses) || 0;
      if (grantedUses > 0 && Number(o.paid_amount) > 0) {
        // 按该订单的单次成交价收回次数：退款金额 ÷（订单实付 ÷ 赠送次数）。
        // 按累计退款计算目标扣减数，再减去此前已扣数，避免多次部分退款重复向上取整。
        const unitPrice = Number(o.paid_amount) / grantedUses;
        const previousRefunded = money(refundedTotal - amount);
        const previousRemoved = Math.ceil(previousRefunded / unitPrice);
        const targetRemoved = Math.ceil(refundedTotal / unitPrice);
        const remove = Math.max(0, targetRemoved - previousRemoved);
        db.prepare('UPDATE member_cards SET remaining_uses = MAX(0, remaining_uses - ?), updated_at = ? WHERE id = ?').run(remove, ts, card.id);
      }
    }
  }

  db.prepare("UPDATE orders SET status = 'paid', approved_by = ? WHERE id = ?").run(req.user.id, r.id);
  // 退款的负向流水归入审批人的当前班次，否则交班汇总会漏掉退款。
  const activeRefundShift = db.prepare("SELECT id FROM shifts WHERE staff_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(req.user.id);
  const refundShiftId = activeRefundShift ? activeRefundShift.id : o.shift_id;
  if (refundShiftId) db.prepare('UPDATE orders SET shift_id = ? WHERE id = ?').run(refundShiftId, r.id);
  const newRefunded = money(alreadyRefunded(o.id));
  const origStatus = Math.abs(Number(o.paid_amount) - newRefunded) <= 0.01 ? 'refunded' : 'partial_refund';
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(origStatus, o.id);

  audit.record({ req, action: '退款审批通过', target_type: 'order', target_id: r.id, after: { original_order_id: o.id, amount, method } });
  db.exec('COMMIT');
  const refundMember = db.prepare('SELECT * FROM members WHERE id = ?').get(o.member_id);
  sms.accountChange(refundMember, '退款成功', `退款${amount}元，原订单${o.order_no}`);
  return ok({ refund: decorateOrder(orderById(r.id)), original_status: origStatus });
  } catch (e) {
    return rollbackError(e);
  }
}

// 审批驳回
function refundReject({ params, body, req }) {
  const r = orderById(params.id);
  if (!r || r.order_type !== 'refund') return fail(404, '退款单不存在');
  if (r.status !== 'pending') return fail(400, '该退款单已处理');
  db.prepare("UPDATE orders SET status = 'void', refund_reason = ? WHERE id = ?")
    .run((r.refund_reason || '') + '（驳回：' + ((body.reason || '').trim() || '不同意') + '）', r.id);
  audit.record({ req, action: '退款审批驳回', target_type: 'order', target_id: r.id, reason: body.reason });
  return ok({});
}

module.exports = { list, get, create, refundApply, refunds, refundApprove, refundReject };
