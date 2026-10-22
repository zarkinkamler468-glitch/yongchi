'use strict';

const crypto = require('node:crypto');
const { db, getSetting } = require('../db');
const { today, now, money, cents, addDays } = require('../util');
const { ok, fail, httpError } = require('../http');
const { nextOrderNo, nextCardNo, resolveMember, ensureShift, computeCardEnd, ensureBusinessOpen, atomic } = require('./common');
const audit = require('./audit');
const sms = require('../sms');
const { refreshFrozenCard, effectiveCardEnd } = require('./cards');
const { paginate } = require('./pagination');

const ORDER_TYPES = ['open', 'renew', 'recharge', 'refund'];
const PAY_METHODS = ['cash', 'wechat', 'alipay', 'stored'];

function requestHash(kind, body) {
  const payments = Array.isArray(body.payments) ? body.payments.map((p) => ({ method: p.pay_method || '', amount: money(p.amount), source_card_id: Number(p.source_card_id) || null, no: String(p.transaction_no || '') })) : [];
  const payload = kind === 'refund'
    ? { kind, original_order_id: Number(body.original_order_id), amount: body.amount === undefined || body.amount === '' || body.amount === null ? null : money(body.amount), reason: String(body.reason || '').trim() }
    : { kind, member_id: Number(body.member_id) || null, name: String(body.name || '').trim(), phone: String(body.phone || '').replace(/[\s-]/g, ''), gender: body.gender || '', product: Number(body.card_product_id) || null, card: Number(body.member_card_id) || null, amount: money(body.amount), discount: money(body.discount_amount), payments };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

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

function daysBetween(from, to) {
  if (!from || !to) return 0;
  return Math.max(0, Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000));
}

function entitlementDelta(order, refundAmount) {
  const previous = alreadyRefunded(order.id);
  const totalAfter = money(previous + refundAmount);
  const paid = Number(order.paid_amount);
  if (!(paid > 0)) return { uses: 0, amount: 0, days: 0, totalAfter };
  const paidCents = BigInt(cents(paid));
  const beforeCents = BigInt(cents(Math.min(paid, money(previous))));
  const afterCents = BigInt(cents(Math.min(paid, totalAfter)));
  // 按整数分计算累计回收，避免 0.07 / 0.35 * 10 被浮点误差向上取整为 3。
  const recoverWhole = (granted, refunded) => Number((BigInt(granted) * refunded + paidCents - 1n) / paidCents);
  const recoverCents = (granted, refunded) => Number((BigInt(cents(granted)) * refunded * 2n + paidCents) / (paidCents * 2n));
  const grantedUses = Number(order.benefit_uses) || 0;
  const grantedAmount = Number(order.benefit_amount) || 0;
  const grantedDays = Number(order.benefit_days) || 0;
  return {
    uses: Math.max(0, recoverWhole(grantedUses, afterCents) - recoverWhole(grantedUses, beforeCents)),
    amount: Math.max(0, recoverCents(grantedAmount, afterCents) - recoverCents(grantedAmount, beforeCents)) / 100,
    days: Math.max(0, recoverWhole(grantedDays, afterCents) - recoverWhole(grantedDays, beforeCents)),
    totalAfter
  };
}

function validateEntitlementRefund(order, card, delta, full) {
  if (!card) return;
  if (delta.uses > Number(card.remaining_uses)) throw httpError(400, `剩余次数不足，需收回 ${delta.uses} 次，当前仅剩 ${card.remaining_uses} 次`);
  if (delta.amount > Number(card.balance) + 0.001) throw httpError(400, `可退权益不足，需收回 ${delta.amount} 元，当前余额仅 ${money(card.balance)} 元`);
  if (delta.days > 0) {
    if (!card.end_at) throw httpError(400, '会员卡有效期异常，无法退款');
    if (addDays(effectiveCardEnd(card), -delta.days) < today()) throw httpError(400, '该有效期权益已部分使用，无法按当前金额退款');
  }
  if (full && order.order_type === 'open') {
    const used = db.prepare("SELECT id FROM entries WHERE member_card_id = ? AND result = 'success' AND entry_at >= ? LIMIT 1").get(card.id, order.created_at);
    if (used) throw httpError(400, '该卡已产生核销记录，不能全额退款');
  }
}

function decorateOrder(o) {
  const m = db.prepare('SELECT name, member_no, phone FROM members WHERE id = ?').get(o.member_id);
  const card = o.member_card_id ? db.prepare('SELECT card_no, card_type FROM member_cards WHERE id = ?').get(o.member_card_id) : null;
  const s = db.prepare('SELECT real_name FROM staff WHERE id = ?').get(o.staff_id);
  const businessAt = o.order_type === 'refund' && o.status === 'paid' ? (o.approved_at || o.created_at) : o.created_at;
  return { ...o, business_at: businessAt, member_name: m ? m.name : '—', member_no: m ? m.member_no : '', card_no: card ? card.card_no : '', staff_name: s ? s.real_name : '' };
}

// 内部幂等字段不下发给客户端；列表页也不需要 64 位哈希。
function publicOrder(o) {
  const { request_id, request_hash, ...rest } = decorateOrder(o);
  return rest;
}

// 扣减储值余额（支付方式为“储值”时）
function deductStored(memberId, amount, excludeCardId, sourceCardId) {
  const cards = db.prepare("SELECT * FROM member_cards WHERE member_id = ? AND card_type = 'stored' ORDER BY id").all(memberId);
  for (const raw of cards) {
    const c = refreshFrozenCard(raw);
    if (sourceCardId && Number(c.id) !== Number(sourceCardId)) continue;
    if (c.status !== 'normal' || (c.start_at && c.start_at > today())) continue;
    if (excludeCardId && Number(c.id) === Number(excludeCardId)) continue;
    if (money(c.balance) >= amount) {
      db.prepare('UPDATE member_cards SET balance = ROUND(balance - ?, 2), updated_at = ? WHERE id = ?').run(amount, now(), c.id);
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
  // 已通过退款以审批通过时间入账，流水筛选也使用同一业务时间，才能和日报、报表对账。
  const businessTime = "CASE WHEN o.order_type = 'refund' AND o.status = 'paid' THEN COALESCE(o.approved_at, o.created_at) ELSE o.created_at END";
  const from = query.get('from');
  if (from) { where.push(businessTime + ' >= ?'); args.push(from); }
  const to = query.get('to');
  if (to) { where.push(businessTime + ' <= ?'); args.push(to + 'T23:59:59'); }
  // 会员、卡号、操作员一次 JOIN 取回，避免列表逐条回查（N+1）。
  const sql = `SELECT o.*, m.name AS member_name, m.member_no,
      mc.card_no, s.real_name AS staff_name,
      CASE WHEN o.order_type = 'refund' AND o.status = 'paid' THEN COALESCE(o.approved_at, o.created_at) ELSE o.created_at END AS business_at
    FROM orders o
    LEFT JOIN members m ON m.id = o.member_id
    LEFT JOIN member_cards mc ON mc.id = o.member_card_id
    LEFT JOIN staff s ON s.id = o.staff_id`
    + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY o.id DESC';
  const page = paginate(sql, args, query);
  return ok({ ...page, list: page.list.map(({ request_id, request_hash, ...rest }) => rest) });
}

function get({ params, req }) {
  const o = orderById(params.id);
  if (!o) return fail(404, '订单不存在');
  if (req.user.role === 'frontdesk' && Number(o.staff_id) !== Number(req.user.id)) return fail(403, '前台只能查看本人订单');
  const payments = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id').all(o.id);
  return ok({ order: publicOrder(o), payments });
}

// ------------------------- 收银开单（开卡/续费/储值充值） -------------------------

function create({ body, req }) {
  // 开卡、权益变更、支付记录必须作为一个原子操作；任一步失败都不能留下卡余额或次数。
  db.exec('BEGIN IMMEDIATE');
  try {
  const orderType = body.order_type;
  if (!['open', 'renew', 'recharge'].includes(orderType)) throw httpError(400, '无效的业务类型');
  const requestId = String(body.request_id || '').trim() || null;
  const fingerprint = requestHash(orderType, body);
  if (requestId && requestId.length > 100) throw httpError(400, '请求编号格式无效');
  if (requestId) {
    // request_id 在员工维度全局唯一；先按任意类型查找，再判断类型与指纹，避免唯一索引冲突变成 500。
    const existing = db.prepare('SELECT * FROM orders WHERE request_id = ? AND staff_id = ?').get(requestId, req.user.id);
    if (existing) {
      if (existing.order_type !== orderType) throw httpError(409, '请求编号已用于其他业务类型，请刷新后重试');
      if (existing.request_hash && existing.request_hash !== fingerprint) throw httpError(409, '请求编号已用于其他收银操作，请刷新后重试');
      db.exec('COMMIT');
      return ok({ order: publicOrder(existing), order_no: existing.order_no, amount: existing.paid_amount, repeated: true });
    }
  }
  ensureBusinessOpen();
  const member = resolveMember(body);
  if (member.status === 'blacklist') throw httpError(400, '黑名单会员禁止办卡、续费');
  if (member.status === 'inactive') throw httpError(400, '会员已停用');
  const staff = req.user;
  const shift = ensureShift(staff.id);
  const ts = now();

  let total = 0;
  let memberCardId = null;
  let benefitUses = 0;
  let benefitAmount = 0;
  let benefitDays = 0;

  if (orderType === 'open') {
    const cp = db.prepare('SELECT * FROM card_products WHERE id = ?').get(body.card_product_id);
    if (!cp || !cp.enabled) throw httpError(400, '请选择有效的卡项');
    total = money(cp.price);
    benefitUses = cp.type === 'count' ? Number(cp.total_uses) || 0 : 0;
    benefitAmount = cp.type === 'stored' ? money(cp.stored_value) : 0;
    const cardEnd = computeCardEnd(cp.type, cp.duration_days);
    benefitDays = ['month', 'year'].includes(cp.type) ? daysBetween(today(), cardEnd) : 0;
    const r = db.prepare(`INSERT INTO member_cards(member_id, card_product_id, card_no, card_type, start_at, end_at, remaining_uses, balance, entry_fee, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', ?, ?)`)
      .run(member.id, cp.id, nextCardNo(), cp.type, today(), cardEnd,
        cp.total_uses || 0, money(cp.stored_value), cp.type === 'stored' && money(cp.entry_fee) <= 0 ? money(getSetting('default_entry_fee')) : money(cp.entry_fee), ts, ts);
    memberCardId = Number(r.lastInsertRowid);
  } else if (orderType === 'renew') {
    const card = refreshFrozenCard(db.prepare('SELECT * FROM member_cards WHERE id = ?').get(body.member_card_id));
    if (!card || Number(card.member_id) !== Number(member.id)) throw httpError(400, '请选择正确的会员卡');
    if (['void', 'refunded', 'frozen'].includes(card.status)) throw httpError(400, '该卡已作废、退款或冻结，不可续费');
    const cp = db.prepare('SELECT * FROM card_products WHERE id = ?').get(body.card_product_id);
    if (!cp || !cp.enabled) throw httpError(400, '请选择有效的续费卡项');
    if (cp.type !== card.card_type) throw httpError(400, '续费需与会员卡同卡种');
    total = money(cp.price);
    benefitUses = cp.type === 'count' ? Number(cp.total_uses) || 0 : 0;
    benefitAmount = cp.type === 'stored' ? money(cp.stored_value) : 0;
    memberCardId = card.id;
    if (cp.type === 'count') {
      let endAt = card.end_at;
      if (cp.duration_days > 0) {
        const base = card.end_at && card.end_at >= today() ? card.end_at : today();
        endAt = addDays(base, Number(cp.duration_days));
        benefitDays = daysBetween(base, endAt);
      }
      db.prepare("UPDATE member_cards SET remaining_uses = remaining_uses + ?, end_at = ?, status = 'normal', updated_at = ? WHERE id = ?")
        .run(cp.total_uses || 0, endAt, ts, card.id);
    }
    else if (cp.type === 'stored') db.prepare('UPDATE member_cards SET balance = ROUND(balance + ?, 2), updated_at = ? WHERE id = ?').run(money(cp.stored_value), ts, card.id);
    else {
      const base = card.end_at && card.end_at >= today() ? card.end_at : today();
      const endAt = computeCardEnd(cp.type, cp.duration_days, base, !!card.end_at && card.end_at >= today());
      benefitDays = daysBetween(base, endAt);
      db.prepare('UPDATE member_cards SET end_at = ?, status = ?, updated_at = ? WHERE id = ?').run(endAt, 'normal', ts, card.id);
    }
  } else {
    // recharge 储值充值
    const card = refreshFrozenCard(db.prepare('SELECT * FROM member_cards WHERE id = ?').get(body.member_card_id));
    if (!card || Number(card.member_id) !== Number(member.id)) throw httpError(400, '请选择正确的会员卡');
    if (card.card_type !== 'stored') throw httpError(400, '储值充值需选择储值卡');
    if (['void', 'refunded', 'frozen'].includes(card.status)) throw httpError(400, '该卡已作废、退款或冻结，不可充值');
    total = cents(body.amount, '充值金额') / 100;
    if (!(total > 0)) throw httpError(400, '充值金额必须大于 0');
    memberCardId = card.id;
    benefitAmount = total;
    db.prepare('UPDATE member_cards SET balance = ROUND(balance + ?, 2), updated_at = ? WHERE id = ?').run(total, ts, card.id);
  }

  const discount = cents(body.discount_amount ?? 0, '优惠金额') / 100;
  if (!Number.isFinite(Number(body.discount_amount || 0)) || discount < 0) throw httpError(400, '优惠金额不能为负数');
  const payable = money(total - discount);
  if (payable < 0) throw httpError(400, '优惠金额不能超过应付金额');

  // 校验支付
  const pays = Array.isArray(body.payments) ? body.payments : [];
  if (payable > 0 && !pays.length) throw httpError(400, '请录入支付方式');
  if (payable === 0 && pays.length) throw httpError(400, '零元订单不需要录入支付方式');
  let paySum = 0;
  for (const p of pays) {
    if (!PAY_METHODS.includes(p.pay_method)) throw httpError(400, '无效的支付方式');
    const amt = cents(p.amount, '支付金额') / 100;
    if (!(amt > 0)) throw httpError(400, '支付金额必须大于 0');
    paySum = money(paySum + amt);
  }
  if (Math.round(paySum * 100) !== Math.round(payable * 100)) throw httpError(400, `支付金额合计(${paySum})必须等于实付金额(${payable})`);

  // 创建订单
  const orderNo = nextOrderNo();
  const r = db.prepare(`INSERT INTO orders(order_no, order_type, member_id, member_card_id, total_amount, discount_amount, payable_amount, paid_amount, status, shift_id, staff_id, benefit_uses, benefit_amount, benefit_days, request_id, request_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(orderNo, orderType, member.id, memberCardId, total, discount, payable, shift.id, staff.id, benefitUses, benefitAmount, benefitDays, requestId, fingerprint, ts);
  const orderId = Number(r.lastInsertRowid);
  db.prepare('UPDATE orders SET benefit_snapshot_known=1 WHERE id=?').run(orderId);
  if (orderType === 'open') db.prepare('UPDATE member_cards SET created_order_id = ? WHERE id = ?').run(orderId, memberCardId);

  // 生成支付记录（储值支付同步扣余额）
  for (const p of pays) {
    let sourceCardId = null;
    // 目标储值卡不能支付自己的开卡、续费或充值订单，否则会形成“先入账再扣款”的虚假收入。
    if (p.pay_method === 'stored') sourceCardId = deductStored(member.id, money(p.amount), memberCardId, p.source_card_id).id;
    db.prepare('INSERT INTO payments(order_id, source_card_id, pay_method, amount, transaction_no, paid_at, staff_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(orderId, sourceCardId, p.pay_method, money(p.amount), p.transaction_no || null, ts, staff.id);
  }

  db.prepare("UPDATE orders SET status = 'paid', paid_amount = ? WHERE id = ?").run(payable, orderId);

  audit.record({ req, action: orderType === 'open' ? '开卡' : orderType === 'renew' ? '续费' : '储值充值', target_type: 'order', target_id: orderId, after: { order_no: orderNo, total, discount, payable, member_id: member.id, member_card_id: memberCardId } });

  db.exec('COMMIT');
  const eventLabel = orderType === 'open' ? '开卡成功' : orderType === 'renew' ? '续费成功' : '储值充值';
  const changeDetail = orderType === 'recharge' ? `充值${total}元` : `${eventLabel}，实付${payable}元`;
  sms.accountChange(member, eventLabel, changeDetail);
  return ok({ order: publicOrder(orderById(orderId)), order_no: orderNo, amount: payable }, 201);
  } catch (e) {
    return rollbackError(e);
  }
}

// ------------------------- 退款 -------------------------

// 申请退款
function refundApply({ params, body, req }) {
  const o = orderById(params.id);
  if (!o) return fail(404, '订单不存在');
  if (req.user.role === 'frontdesk' && Number(o.staff_id) !== Number(req.user.id)) return fail(403, '前台只能为本人订单申请退款');
  if (!['open', 'renew', 'recharge'].includes(o.order_type)) return fail(400, '该订单不可退款');
  const requestId = String(body.request_id || '').trim() || null;
  let fingerprint;
  try { fingerprint = requestHash('refund', { ...body, original_order_id: o.id }); } catch (e) { return fail(e.status || 400, e.message); }
  if (requestId && requestId.length > 100) return fail(400, '请求编号格式无效');
  if (requestId) {
    // 与收银共用 (staff_id, request_id) 唯一索引，先按任意类型查找，避免跨类型冲突变成 500。
    const existing = db.prepare('SELECT * FROM orders WHERE request_id = ? AND staff_id = ?').get(requestId, req.user.id);
    if (existing) {
      if (existing.order_type !== 'refund') return fail(409, '请求编号已用于其他业务类型');
      if (Number(existing.original_order_id) !== Number(o.id)) return fail(409, '请求编号已用于其他原订单的退款');
      if (existing.request_hash && existing.request_hash !== fingerprint) return fail(409, '请求编号已用于其他退款申请，请刷新后重试');
      return ok({ refund: publicOrder(existing), repeated: true });
    }
  }
  if (!['paid', 'partial_refund'].includes(o.status)) return fail(400, '该订单状态不可退款');
  // 待审批的退款也占用额度，避免同一订单重复提交全额退款。
  const max = money(Number(o.paid_amount) - alreadyRefunded(o.id) - pendingRefunded(o.id));
  if (max <= 0) return fail(400, '该订单已无可退金额');
  let amount;
  try { amount = body.amount === undefined || body.amount === '' || body.amount === null ? max : cents(body.amount, '退款金额') / 100; } catch (e) { return fail(e.status || 400, e.message); }
  if (!(amount > 0)) return fail(400, '退款金额无效');
  if (amount > max + 0.001) return fail(400, `退款金额不能超过可退金额 ${max}`);
  const reason = (body.reason || '').trim();
  if (!reason) return fail(400, '请填写退款原因');
  if (reason.length > 500) return fail(400, '退款原因不能超过 500 个字');
  const ts = now();
  const r = db.prepare(`INSERT INTO orders(order_no, order_type, member_id, member_card_id, original_order_id, total_amount, payable_amount, paid_amount, status, staff_id, refund_reason, request_id, request_hash, created_at)
    VALUES (?, 'refund', ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, ?, ?)`)
    .run(nextOrderNo(), o.member_id, o.member_card_id, o.id, amount, amount, req.user.id, reason, requestId, fingerprint, ts);
  audit.record({ req, action: '退款申请', target_type: 'order', target_id: Number(r.lastInsertRowid), after: { original_order_id: o.id, amount, reason } });
  return ok({ refund: publicOrder(orderById(Number(r.lastInsertRowid))) }, 201);
}

// 退款单列表（审批用）
function refunds({ query }) {
  const where = ["o.order_type = 'refund'"];
  const args = [];
  const status = query.get('status');
  if (status) { where.push('o.status = ?'); args.push(status); }
  const page = paginate('SELECT o.* FROM orders o WHERE ' + where.join(' AND ') + ' ORDER BY o.id DESC', args, query);
  return ok({ ...page, list: page.list.map(publicOrder) });
}

// 审批通过
function refundApprove({ params, body, req }) {
  db.exec('BEGIN IMMEDIATE');
  try {
  const r = orderById(params.id);
  if (!r || r.order_type !== 'refund') throw httpError(404, '退款单不存在');
  if (r.status === 'paid') {
    const original = orderById(r.original_order_id);
    db.exec('COMMIT');
    return ok({ refund: publicOrder(r), original_status: original && original.status, repeated: true });
  }
  if (r.status !== 'pending') throw httpError(400, '该退款单已处理');
  ensureBusinessOpen();
  // 老板承担最终退款责任，可以自审；前台和财务仍必须由其他有权账号审批，超管可处理全部退款。
  if (Number(r.staff_id) === Number(req.user.id) && !['admin', 'boss'].includes(req.user.role)) throw httpError(403, '退款申请人与审批人不能是同一账号');
  const o = orderById(r.original_order_id);
  if (!o) throw httpError(404, '原订单不存在');
  const method = body.refund_method === 'cash' ? 'cash' : 'original';
  const ts = now();
  const amount = money(r.total_amount);
  const remainingRefundable = money(Number(o.paid_amount) - alreadyRefunded(o.id));
  if (amount > remainingRefundable + 0.001) throw httpError(400, `退款金额超过当前可退金额 ${remainingRefundable}`);

  // 必须先确认对应权益能够完整收回，再生成退款支付流水。
  const card = o.member_card_id ? refreshFrozenCard(db.prepare('SELECT * FROM member_cards WHERE id = ?').get(o.member_card_id)) : null;
  if (card && !o.benefit_snapshot_known && (
    (['month', 'year'].includes(card.card_type) && !(o.benefit_days > 0)) ||
    (card.card_type === 'count' && !(o.benefit_uses > 0)) ||
    (card.card_type === 'stored' && !(o.benefit_amount > 0))
  )) {
    throw httpError(400, '历史订单缺少权益快照，请人工核算后处理退款');
  }
  if (card && Number(card.member_id) !== Number(o.member_id)) throw httpError(400, '该会员卡已转给其他会员，不能直接退款；请先处理转卡关系');
  const delta = entitlementDelta(o, amount);
  const full = Math.round(Number(o.paid_amount) * 100) === Math.round(delta.totalAfter * 100);
  if (full && o.order_type === 'open') {
    const laterOrder = db.prepare("SELECT id FROM orders WHERE member_card_id = ? AND id != ? AND order_type IN ('open','renew','recharge') AND status IN ('paid','partial_refund') AND id > ?").get(card && card.id, o.id, o.id);
    if (laterOrder) throw httpError(400, '该开卡后已有后续业务，不能直接全额退款；请先处理后续订单');
  }
  validateEntitlementRefund(o, card, delta, full);

  // 生成负向支付记录
  if (method === 'cash') {
    db.prepare('INSERT INTO payments(order_id, pay_method, amount, paid_at, staff_id) VALUES (?, ?, ?, ?, ?)')
      .run(r.id, 'cash', -amount, ts, req.user.id);
  } else {
    // 原路退回：按原支付逐笔生成负向记录；储值退回余额
    const origPays = db.prepare('SELECT pay_method, source_card_id, SUM(amount) AS amount FROM payments WHERE order_id = ? AND amount > 0 GROUP BY pay_method, source_card_id ORDER BY MIN(id)').all(o.id);
    const refundedByMethod = Object.fromEntries(db.prepare(`
      SELECT p.pay_method, p.source_card_id, COALESCE(SUM(-p.amount),0) AS amount
      FROM payments p JOIN orders r ON r.id = p.order_id
      WHERE r.original_order_id = ? AND r.order_type = 'refund' AND r.status = 'paid' AND p.amount < 0
      GROUP BY p.pay_method, p.source_card_id
    `).all(o.id).map((p) => [`${p.pay_method}:${p.source_card_id || ''}`, Number(p.amount)]));
    let remaining = amount;
    for (const p of origPays) {
      if (remaining <= 0) break;
      const refundKey = `${p.pay_method}:${p.source_card_id || ''}`;
      const methodAvailable = money(Number(p.amount) - Number(refundedByMethod[refundKey] || 0));
      if (methodAvailable <= 0) continue;
      const amt = Math.min(remaining, methodAvailable);
      db.prepare('INSERT INTO payments(order_id, source_card_id, pay_method, amount, paid_at, staff_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(r.id, p.source_card_id || null, p.pay_method, -amt, ts, req.user.id);
      if (p.pay_method === 'stored') {
        // 退回原支付所使用的储值卡；旧订单没有 source_card_id 时才兼容回退到首张卡。
        const card = p.source_card_id
          ? db.prepare("SELECT * FROM member_cards WHERE id = ? AND member_id = ? AND card_type = 'stored'").get(p.source_card_id, o.member_id)
          : db.prepare("SELECT * FROM member_cards WHERE member_id = ? AND card_type = 'stored' AND status IN ('normal','frozen') ORDER BY id").get(o.member_id);
        if (!card) throw httpError(400, '原储值卡不存在，无法安全退款');
        if (!['normal', 'frozen'].includes(card.status)) throw httpError(400, '原储值卡已作废、退款或过期，无法原路退回，请核实退款方式');
        db.prepare('UPDATE member_cards SET balance = ROUND(balance + ?, 2), updated_at = ? WHERE id = ?').run(amt, ts, card.id);
      }
      remaining = money(remaining - amt);
    }
    if (remaining > 0.001) throw httpError(400, '原支付渠道可退金额不足');
  }

  // 收回权益
  if (card) {
    if (full && o.order_type === 'open') {
      db.prepare("UPDATE member_cards SET status = 'refunded', remaining_uses = 0, balance = 0, updated_at = ? WHERE id = ?").run(ts, card.id);
    } else {
      if (delta.uses > 0) db.prepare('UPDATE member_cards SET remaining_uses = remaining_uses - ?, updated_at = ? WHERE id = ?').run(delta.uses, ts, card.id);
      if (delta.amount > 0) db.prepare('UPDATE member_cards SET balance = ROUND(balance - ?, 2), updated_at = ? WHERE id = ?').run(delta.amount, ts, card.id);
      if (delta.days > 0) db.prepare('UPDATE member_cards SET end_at = ?, updated_at = ? WHERE id = ?').run(addDays(card.end_at, -delta.days), ts, card.id);
    }
  }

  // 退款现金必须有归属：优先审批人当前班次；审批人（财务、老板）没有班次时，
  // 归到退款申请人的进行中班次（通常是收银前台的钱箱），两者都没有才留空。
  const activeRefundShift = db.prepare("SELECT id FROM shifts WHERE staff_id = ? AND status = 'active'").get(req.user.id)
    || db.prepare("SELECT id FROM shifts WHERE staff_id = ? AND status = 'active'").get(r.staff_id);
  db.prepare("UPDATE orders SET status = 'paid', approved_by = ?, approved_at = ?, shift_id = ? WHERE id = ?")
    .run(req.user.id, ts, activeRefundShift ? activeRefundShift.id : null, r.id);
  const newRefunded = money(alreadyRefunded(o.id));
  const origStatus = Math.round(Number(o.paid_amount) * 100) === Math.round(newRefunded * 100) ? 'refunded' : 'partial_refund';
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(origStatus, o.id);

  audit.record({ req, action: '退款审批通过', target_type: 'order', target_id: r.id, after: { original_order_id: o.id, amount, method } });
  db.exec('COMMIT');
  const refundMember = db.prepare('SELECT * FROM members WHERE id = ?').get(o.member_id);
  sms.accountChange(refundMember, '退款成功', `退款${amount}元，原订单${o.order_no}`);
  return ok({ refund: publicOrder(orderById(r.id)), original_status: origStatus });
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

module.exports = { list, get, create, refundApply: atomic(refundApply), refunds, refundApprove, refundReject: atomic(refundReject) };
