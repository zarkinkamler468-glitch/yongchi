'use strict';

const { db } = require('../db');
const { today, now, money } = require('../util');
const { ok, fail } = require('../http');
const audit = require('./audit');
const sms = require('../sms');

function memberByKeyword(kw) {
  const normalized = String(kw || '').trim().replace(/[\s-]/g, '');
  const card = db.prepare('SELECT * FROM member_cards WHERE REPLACE(REPLACE(card_no, \' \', \'\'), \'-\', \'\') = ?').get(normalized);
  if (card) return { member: db.prepare('SELECT * FROM members WHERE id = ?').get(card.member_id), card };
  let m = db.prepare('SELECT * FROM members WHERE REPLACE(REPLACE(phone, \' \', \'\'), \'-\', \'\') = ?').get(normalized);
  if (m) return { member: m };
  m = db.prepare('SELECT * FROM members WHERE REPLACE(REPLACE(member_no, \' \', \'\'), \'-\', \'\') = ?').get(normalized);
  if (m) return { member: m };
  return null;
}

function cardUsable(c) {
  if (['void', 'refunded', 'frozen'].includes(c.status)) return { ok: false, reason: '卡状态异常' };
  if (['month', 'year'].includes(c.card_type) && c.end_at && c.end_at < today()) return { ok: false, reason: '卡已过期' };
  if (c.card_type === 'count' && c.remaining_uses <= 0) return { ok: false, reason: '次数已用尽' };
  return { ok: true };
}

function cardSummary(c) {
  const cp = c.card_product_id ? db.prepare('SELECT name FROM card_products WHERE id = ?').get(c.card_product_id) : null;
  return {
    id: c.id, card_no: c.card_no, card_name: cp ? cp.name : c.card_type,
    card_type: c.card_type, status: c.status, remaining_uses: c.remaining_uses,
    balance: c.balance, entry_fee: c.entry_fee, end_at: c.end_at, start_at: c.start_at
  };
}

function resolveUsableCard(member, specified) {
  let card = specified || null;
  if (!card || !cardUsable(card).ok) {
    const cards = db.prepare('SELECT * FROM member_cards WHERE member_id = ? ORDER BY id').all(member.id);
    card = cards.find((c) => cardUsable(c).ok) || null;
  }
  return card;
}

// GET /api/entries/preview：只查询，不扣次数/余额，不写失败记录
function preview({ query }) {
  const keyword = (query.get('keyword') || '').trim();
  const requestedCardId = Number(query.get('card_id')) || null;
  const people = Math.max(1, Math.floor(Number(query.get('people')) || 1));
  if (people > 100) return fail(400, '同行人数不能超过 100 人');
  if (!keyword) return fail(400, '请输入卡号、手机号或会员编号');
  const found = memberByKeyword(keyword);
  if (!found || !found.member) return fail(404, '未找到对应会员或卡号');
  const member = found.member;
  if (member.status === 'blacklist') return fail(400, '黑名单会员禁止入场');
  if (member.status === 'inactive') return fail(400, '会员已停用');
  let specifiedCard = found.card || null;
  if (requestedCardId) {
    specifiedCard = db.prepare('SELECT * FROM member_cards WHERE id = ? AND member_id = ?').get(requestedCardId, member.id);
    if (!specifiedCard) return fail(404, '指定会员卡不存在或不属于该会员');
    if (found.card && Number(found.card.id) !== requestedCardId) return fail(400, '查询卡号与指定会员卡不一致');
  }
  const card = requestedCardId ? specifiedCard : resolveUsableCard(member, specifiedCard);
  if (!card) return fail(400, '无有效会员卡');
  const check = cardUsable(card);
  if (!check.ok) return fail(400, check.reason);
  const summary = cardSummary(card);
  summary.people = people;
  summary.preview_deducted_uses = card.card_type === 'count' ? people : 0;
  summary.preview_deducted_amount = card.card_type === 'stored' ? money((money(card.entry_fee) || 30) * people) : 0;
  return ok({ member: { id: member.id, name: member.name, member_no: member.member_no, phone: member.phone, status: member.status }, card: summary });
}

// GET /api/entries
function list({ query }) {
  const where = [];
  const args = [];
  const memberId = query.get('member_id');
  if (memberId) { where.push('e.member_id = ?'); args.push(memberId); }
  const from = query.get('from');
  if (from) { where.push('e.entry_at >= ?'); args.push(from); }
  const to = query.get('to');
  if (to) { where.push('e.entry_at <= ?'); args.push(to + 'T23:59:59'); }
  const sql = `
    SELECT e.*, m.name AS member_name, m.member_no, s.real_name AS staff_name
    FROM entries e
    LEFT JOIN members m ON m.id = e.member_id
    LEFT JOIN staff s ON s.id = e.staff_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY e.id DESC LIMIT 1000
  `;
  return ok({ list: db.prepare(sql).all(...args) });
}

// POST /api/entries/checkin  入场核销
function checkin({ body, req }) {
  if (body.confirmed !== true) return fail(400, '请先查询并确认会员信息后再核销');
  const keyword = (body.keyword || '').trim();
  if (!keyword) return fail(400, '请输入卡号、手机号或会员编号');
  const found = memberByKeyword(keyword);
  if (!found || !found.member) return fail(404, '未找到对应会员或卡号');
  const member = found.member;
  const requestedCardId = Number(body.card_id) || null;
  if (requestedCardId) {
    const specifiedCard = db.prepare('SELECT * FROM member_cards WHERE id = ? AND member_id = ?').get(requestedCardId, member.id);
    if (!specifiedCard) return fail(404, '指定会员卡不存在或不属于该会员');
    if (found.card && Number(found.card.id) !== requestedCardId) return fail(400, '查询卡号与指定会员卡不一致');
    found.card = specifiedCard;
  }
  const staff = req.user;
  const requestId = String(body.request_id || '').trim() || null;
  if (requestId && requestId.length > 100) return fail(400, '请求编号格式无效');
  const gateNo = (body.gate_no || '').trim() || '前台';
  const people = Math.max(1, Math.floor(Number(body.people) || 1));
  if (people > 100) return fail(400, '同行人数不能超过 100 人');
  const ts = now();

  // 核销是“查询后确认”的扣减操作，必须在同一写事务内完成，避免并发请求超扣。
  db.exec('BEGIN IMMEDIATE');

  if (requestId) {
    const existing = db.prepare("SELECT * FROM entries WHERE request_id = ? AND staff_id = ? AND result = 'success'").get(requestId, staff.id);
    if (existing) {
      if (Number(existing.member_id) !== Number(member.id)) {
        db.exec('ROLLBACK');
        return fail(409, '请求编号已用于其他会员核销');
      }
      const existingCard = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(existing.member_card_id);
      db.exec('COMMIT');
      return ok({
        member: { id: member.id, name: member.name, member_no: member.member_no, phone: member.phone, status: member.status },
        card: cardSummary(existingCard), charge_type: existing.charge_type,
        deducted_uses: existing.deducted_uses, deducted_amount: existing.deducted_amount, repeated: true
      });
    }
  }

  const recordFail = (reason) => {
    db.prepare(`INSERT INTO entries(member_id, member_card_id, charge_type, deducted_uses, deducted_amount, gate_no, result, fail_reason, entry_at, staff_id)
      VALUES (?, ?, NULL, 0, 0, ?, 'fail', ?, ?, ?)`)
      .run(member.id, found.card ? found.card.id : null, gateNo, reason, ts, staff.id);
    db.exec('COMMIT');
    return fail(400, reason);
  };

  const rollback = (e) => {
    try { db.exec('ROLLBACK'); } catch (_) { /* no active transaction */ }
    return fail((e && e.status) || 500, (e && e.message) || '核销失败');
  };

  try {
    if (member.status === 'blacklist') return recordFail('黑名单会员禁止入场');
    if (member.status === 'inactive') return recordFail('会员已停用');

  // 选择可用卡
  let card = found.card || null;
  if (requestedCardId && card && !cardUsable(card).ok) return recordFail(cardUsable(card).reason);
  if (!card || !cardUsable(card).ok) {
    const cards = db.prepare('SELECT * FROM member_cards WHERE member_id = ? ORDER BY id').all(member.id);
    card = null;
    for (const c of cards) {
      const u = cardUsable(c);
      if (u.ok) { card = c; break; }
    }
    if (!card) {
      const c0 = cards[0];
      const u = c0 ? cardUsable(c0) : { reason: '无有效会员卡' };
      return recordFail(u.reason || '无有效会员卡');
    }
  }

  let deductedUses = 0;
  let deductedAmount = 0;
  let chargeType = null;

  if (card.card_type === 'count') {
    if (card.remaining_uses < people) return recordFail('剩余次数不足');
    const changed = db.prepare('UPDATE member_cards SET remaining_uses = remaining_uses - ?, updated_at = ? WHERE id = ? AND remaining_uses >= ?').run(people, ts, card.id, people);
    if (changed.changes !== 1) return recordFail('剩余次数不足，请重新查询后再试');
    deductedUses = people;
    chargeType = 'count';
  } else if (card.card_type === 'month' || card.card_type === 'year') {
    if (card.end_at && card.end_at < today()) return recordFail('卡已过期');
    chargeType = card.card_type;
  } else if (card.card_type === 'stored') {
    const fee = money(card.entry_fee) || money(30);
    const totalFee = money(fee * people);
    if (card.balance < totalFee) return recordFail('储值余额不足');
    const changed = db.prepare('UPDATE member_cards SET balance = balance - ?, updated_at = ? WHERE id = ? AND balance >= ?').run(totalFee, ts, card.id, totalFee);
    if (changed.changes !== 1) return recordFail('储值余额不足，请重新查询后再试');
    deductedAmount = totalFee;
    chargeType = 'stored';
  } else {
    return recordFail('未知卡种');
  }

  db.prepare(`INSERT INTO entries(member_id, member_card_id, charge_type, deducted_uses, deducted_amount, gate_no, result, fail_reason, entry_at, staff_id, request_id)
    VALUES (?, ?, ?, ?, ?, ?, 'success', NULL, ?, ?, ?)`)
    .run(member.id, card.id, chargeType, deductedUses, deductedAmount, gateNo, ts, staff.id, requestId);

  const refreshedCard = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(card.id);
  audit.record({ req, action: '入场核销', target_type: 'member', target_id: member.id, after: { card_id: card.id, charge_type: chargeType, deducted_uses: deductedUses, deducted_amount: deductedAmount } });
  const detail = chargeType === 'count' ? `入场核销，扣减${deductedUses}次，剩余${refreshedCard.remaining_uses}次` : chargeType === 'stored' ? `入场核销，扣减${deductedAmount}元，余额${refreshedCard.balance}元` : '入场核销成功';
  sms.accountChange(member, '入场核销', detail);

  db.exec('COMMIT');

  return ok({
    member: { id: member.id, name: member.name, member_no: member.member_no, phone: member.phone, status: member.status },
    card: cardSummary(refreshedCard),
    charge_type: chargeType,
    deducted_uses: deductedUses,
    deducted_amount: deductedAmount
  });
  } catch (e) {
    return rollback(e);
  }
}

module.exports = { list, preview, checkin };
