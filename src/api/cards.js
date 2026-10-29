'use strict';

const { db } = require('../db');
const { today, now, addDays, money, cents, isDateString } = require('../util');
const { ok, fail } = require('../http');
const { CARD_TYPES, atomic } = require('./common');
const audit = require('./audit');
const sms = require('../sms');
const { paginate } = require('./pagination');

const CARD_STATUS = { normal: '正常', frozen: '冻结', expired: '过期', void: '作废', refunded: '已退款' };
const CARD_TYPE_LABEL = { count: '次卡', month: '月卡', year: '年卡', stored: '储值卡' };

// 内部幂等字段不对外下发。
function withoutInternal(row) {
  const { request_id, request_hash, ...rest } = row;
  return rest;
}

function deriveStatus(c) {
  if (c.status !== 'normal') return c.status;
  if (c.card_type !== 'stored' && c.end_at && c.end_at < today()) return 'expired';
  return 'normal';
}

function calendarDays(from, to) {
  if (!from || !to) return 0;
  const a = new Date(String(from).slice(0, 10) + 'T00:00:00');
  const b = new Date(String(to).slice(0, 10) + 'T00:00:00');
  const diff = Math.round((b - a) / 86400000);
  return Number.isFinite(diff) ? Math.max(0, diff) : 0;
}

// 冻结期间已经暂停的天数属于尚未消费的期限权益，不改变冻结状态。
function effectiveCardEnd(card) {
  if (!card || !card.end_at || card.status !== 'frozen') return card && card.end_at;
  const cutoff = card.frozen_until && card.frozen_until < today() ? card.frozen_until : today();
  return addDays(card.end_at, calendarDays(card.frozen_from, cutoff));
}

// 冻结截止日到达后惰性自动解冻；有效期只顺延实际冻结的日历天数。
function refreshFrozenCard(card, options = {}) {
  if (!card || card.status !== 'frozen') return card;
  const forceDate = options && typeof options === 'object' ? options.forceDate : null;
  if (forceDate && (!isDateString(forceDate) || forceDate > today())) throw Object.assign(new Error('解冻日期格式无效或晚于今天'), { status: 400 });
  const thawDate = forceDate || (card.frozen_until && card.frozen_until <= today() ? today() : null);
  if (!thawDate) return card;
  const days = calendarDays(card.frozen_from, card.frozen_until && card.frozen_until < thawDate ? card.frozen_until : thawDate);
  const endAt = card.end_at && days > 0 ? addDays(card.end_at, days) : card.end_at;
  const status = card.card_type !== 'stored' && endAt && endAt < today() ? 'expired' : 'normal';
  db.prepare("UPDATE member_cards SET status = ?, frozen_from = NULL, frozen_until = NULL, end_at = ?, updated_at = ? WHERE id = ?")
    .run(status, endAt, now(), card.id);
  const fresh = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(card.id);
  return { ...card, ...fresh };
}

function decorateCard(c) {
  return {
    ...c,
    status: deriveStatus(c),
    status_label: CARD_STATUS[deriveStatus(c)] || deriveStatus(c),
    type_label: CARD_TYPE_LABEL[c.card_type] || c.card_type
  };
}

// ------------------------- 卡项（card_products） -------------------------

function listProducts() {
  const rows = db.prepare('SELECT * FROM card_products ORDER BY id').all();
  return ok({ list: rows });
}

// 卡项字段按卡种归一：次卡只保留次数，储值卡只保留余额/扣费，期限卡只保留天数。
// 这样开卡时不会把无关字段复制到会员卡，产生看不到也用不掉的余额或次数。
function productFields(body) {
  const type = body.type;
  return {
    duration_days: type === 'stored' ? 0 : (Number(body.duration_days) || 0),
    total_uses: type === 'count' ? (Number(body.total_uses) || 0) : 0,
    stored_value: type === 'stored' ? money(body.stored_value) : 0,
    entry_fee: type === 'stored' ? money(body.entry_fee) : 0
  };
}

function createProduct({ body }) {
  const name = (body.name || '').trim();
  if (!name) return fail(400, '卡项名称不能为空');
  if (name.length > 100) return fail(400, '卡项名称不能超过 100 个字');
  if (db.prepare('SELECT id FROM card_products WHERE name = ?').get(name)) return fail(400, '卡项名称已存在');
  if (!CARD_TYPES.includes(body.type)) return fail(400, '无效的卡种类型');
  const validation = validateProduct(body); if (validation) return validation;
  const ts = now();
  const f = productFields(body);
  const r = db.prepare(`INSERT INTO card_products(name, type, price, duration_days, total_uses, stored_value, entry_fee, freeze_allowed, transfer_allowed, extension_allowed, enabled, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, body.type, money(body.price), f.duration_days, f.total_uses, f.stored_value, f.entry_fee,
      body.freeze_allowed ? 1 : 0, body.transfer_allowed ? 1 : 0, body.extension_allowed ? 1 : 0,
      body.enabled === undefined ? 1 : (body.enabled ? 1 : 0), (body.note || '').trim() || null, ts, ts);
  return ok({ product: db.prepare('SELECT * FROM card_products WHERE id = ?').get(Number(r.lastInsertRowid)) }, 201);
}

function updateProduct({ params, body }) {
  const p = db.prepare('SELECT * FROM card_products WHERE id = ?').get(params.id);
  if (!p) return fail(404, '卡项不存在');
  const name = (body.name || '').trim();
  if (!name) return fail(400, '卡项名称不能为空');
  if (name.length > 100) return fail(400, '卡项名称不能超过 100 个字');
  if (db.prepare('SELECT id FROM card_products WHERE name = ? AND id != ?').get(name, p.id)) return fail(400, '卡项名称已存在');
  if (!CARD_TYPES.includes(body.type)) return fail(400, '无效的卡种类型');
  if (body.type !== p.type && db.prepare('SELECT id FROM member_cards WHERE card_product_id = ? LIMIT 1').get(p.id)) return fail(400, '该卡项已经发卡，不能修改卡种类型');
  const validation = validateProduct(body); if (validation) return validation;
  const enabled = body.enabled === undefined ? p.enabled : (body.enabled ? 1 : 0);
  const f = productFields(body);
  db.prepare(`UPDATE card_products SET name = ?, type = ?, price = ?, duration_days = ?, total_uses = ?, stored_value = ?, entry_fee = ?, freeze_allowed = ?, transfer_allowed = ?, extension_allowed = ?, enabled = ?, note = ?, updated_at = ? WHERE id = ?`)
    .run(name, body.type, money(body.price), f.duration_days, f.total_uses, f.stored_value, f.entry_fee,
      body.freeze_allowed ? 1 : 0, body.transfer_allowed ? 1 : 0, body.extension_allowed ? 1 : 0,
      enabled, (body.note || '').trim() || null, now(), p.id);
  return ok({ product: db.prepare('SELECT * FROM card_products WHERE id = ?').get(p.id) });
}

function validateProduct(body) {
  const price = Number(body.price);
  const duration = Number(body.duration_days || 0);
  const uses = Number(body.total_uses || 0);
  const stored = Number(body.stored_value || 0);
  const fee = Number(body.entry_fee || 0);
  try { cents(body.price, '卡项价格'); cents(body.stored_value ?? 0, '储值金额'); cents(body.entry_fee ?? 0, '入场扣费'); } catch (e) { return fail(400, e.message); }
  if (!Number.isFinite(price) || price < 0) return fail(400, '卡项价格不能为负数');
  if (!Number.isFinite(duration) || duration < 0 || duration > 36500 || !Number.isInteger(duration)) return fail(400, '有效天数必须是 0 到 36500 的整数');
  if (!Number.isFinite(uses) || uses < 0 || uses > 1000000 || !Number.isInteger(uses)) return fail(400, '次数必须是 0 到 1000000 的整数');
  if (!Number.isFinite(stored) || stored < 0) return fail(400, '储值金额不能为负数');
  if (!Number.isFinite(fee) || fee < 0) return fail(400, '单次入场扣费不能为负数');
  if (body.type === 'count' && uses <= 0) return fail(400, '次卡总次数必须大于 0');
  if (body.type === 'stored' && stored <= 0) return fail(400, '储值卡储值金额必须大于 0');
  if (['month', 'year'].includes(body.type) && duration <= 0) return fail(400, '期限卡有效天数必须大于 0');
  return null;
}

function disableProduct({ params }) {
  const p = db.prepare('SELECT * FROM card_products WHERE id = ?').get(params.id);
  if (!p) return fail(404, '卡项不存在');
  db.prepare('UPDATE card_products SET enabled = 0, updated_at = ? WHERE id = ?').run(now(), p.id);
  return ok({ id: Number(p.id) });
}

// ------------------------- 会员卡账户（member_cards） -------------------------

function listCards({ query }) {
  const where = [];
  const args = [];
  const memberId = query.get('member_id');
  if (memberId) { where.push('mc.member_id = ?'); args.push(memberId); }
  const status = query.get('status');
  if (status) { where.push('mc.status = ?'); args.push(status); }
  const search = (query.get('search') || '').trim();
  if (search) {
    where.push('(mc.card_no LIKE ? OR m.name LIKE ? OR m.member_no LIKE ? OR m.phone LIKE ?)');
    args.push(...Array(4).fill(`%${search}%`));
  }
  const sql = `
    SELECT mc.*, m.name AS member_name, m.member_no, cp.name AS card_name
    FROM member_cards mc
    LEFT JOIN members m ON m.id = mc.member_id
    LEFT JOIN card_products cp ON cp.id = mc.card_product_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY mc.id DESC
  `;
  // 先刷新状态再筛选，避免已自动解冻的卡落入错误状态分页。
  db.prepare("SELECT * FROM member_cards WHERE status='frozen' AND frozen_until <= ?").all(today()).forEach(c => refreshFrozenCard(c));
  const page = paginate(sql.replace('mc.status = ?', "(CASE WHEN mc.status='normal' AND mc.card_type!='stored' AND mc.end_at < date('now','localtime') THEN 'expired' ELSE mc.status END) = ?"), args, query);
  return ok({ ...page, list: page.list.map(decorateCard) });
}

function getCard({ params }) {
  const c = db.prepare(`
    SELECT mc.*, m.name AS member_name, m.member_no, m.phone AS member_phone, cp.name AS card_name
    FROM member_cards mc
    LEFT JOIN members m ON m.id = mc.member_id
    LEFT JOIN card_products cp ON cp.id = mc.card_product_id
    WHERE mc.id = ?
  `).get(params.id);
  if (!c) return fail(404, '会员卡不存在');
  const refreshed = refreshFrozenCard(c);
  const entries = db.prepare('SELECT * FROM entries WHERE member_card_id = ? ORDER BY id DESC LIMIT 20').all(refreshed.id).map(withoutInternal);
  return ok({ card: decorateCard(refreshed), entries });
}

function productOf(card) {
  return card.card_product_id ? db.prepare('SELECT * FROM card_products WHERE id = ?').get(card.card_product_id) : null;
}

function memberOf(card) {
  return card ? db.prepare('SELECT * FROM members WHERE id = ?').get(card.member_id) : null;
}

// 冻结
function freeze({ params, body, req }) {
  const c = refreshFrozenCard(db.prepare('SELECT * FROM member_cards WHERE id = ?').get(params.id));
  if (!c) return fail(404, '会员卡不存在');
  if (deriveStatus(c) === 'expired') return fail(400, '已过期会员卡不能冻结');
  if (c.status === 'void' || c.status === 'refunded') return fail(400, '该卡已作废或退款，不可冻结');
  if (c.status === 'frozen') return fail(400, '该卡已经处于冻结状态');
  const frozenUntil = (body.frozen_until || '').trim() || null;
  if (frozenUntil && (!isDateString(frozenUntil) || frozenUntil < today())) return fail(400, '冻结截止时间格式无效或早于今天');
  const p = productOf(c);
  if (p && !p.freeze_allowed) return fail(400, '该卡项不允许冻结');
  db.prepare("UPDATE member_cards SET status = 'frozen', frozen_from = ?, frozen_until = ?, updated_at = ? WHERE id = ?")
    .run(now(), frozenUntil, now(), c.id);
  audit.record({ req, action: '冻结会员卡', target_type: 'member_card', target_id: c.id, after: { frozen_until: frozenUntil }, reason: body.reason });
  sms.accountChange(memberOf(c), '会员卡冻结', `${c.card_no}已冻结${frozenUntil ? `，截止${frozenUntil}` : ''}`);
  return ok({ card: decorateCard(db.prepare('SELECT * FROM member_cards WHERE id = ?').get(c.id)) });
}

// 解冻（顺延有效期）
function unfreeze({ params, body, req }) {
  const c = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(params.id);
  if (!c) return fail(404, '会员卡不存在');
  if (c.status !== 'frozen') return fail(400, '该卡不在冻结状态');
  const refreshed = refreshFrozenCard(c, { forceDate: today() });
  audit.record({ req, action: '解冻会员卡', target_type: 'member_card', target_id: c.id, reason: body.reason });
  sms.accountChange(memberOf(c), '会员卡解冻', `${c.card_no}已解冻${refreshed.end_at ? `，有效期至${refreshed.end_at}` : ''}`);
  return ok({ card: decorateCard(refreshed) });
}

// 延期
function extend({ params, body, req }) {
  const c = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(params.id);
  if (!c) return fail(404, '会员卡不存在');
  if (['void', 'refunded'].includes(c.status)) return fail(400, '该卡已作废或退款，不可延期');
  const days = Number(body.days);
  if (!Number.isFinite(days) || days <= 0 || days > 36500 || !Number.isInteger(days)) return fail(400, '延期天数必须是 1 到 36500 的整数');
  if (c.card_type === 'stored' || !c.end_at) return fail(400, '该卡没有有效期，无需延期');
  const p = productOf(c);
  if (p && !p.extension_allowed) return fail(400, '该卡项不允许延期');
  const effectiveEnd = effectiveCardEnd(c);
  const base = effectiveEnd && effectiveEnd >= today() ? effectiveEnd : today();
  // 冻结补偿在解冻时统一入账；存储期限先扣掉这部分，不能延期和解冻各补一次。
  const pausedDays = c.status === 'frozen' ? calendarDays(c.end_at, effectiveEnd) : 0;
  const endAt = addDays(base, days - pausedDays);
  db.prepare("UPDATE member_cards SET end_at = ?, status = CASE WHEN status='expired' THEN 'normal' ELSE status END, updated_at = ? WHERE id = ?").run(endAt, now(), c.id);
  audit.record({ req, action: '会员卡延期', target_type: 'member_card', target_id: c.id, after: { days, end_at: endAt }, reason: body.reason });
  sms.accountChange(memberOf(c), '会员卡延期', `${c.card_no}延期${days}天，有效期至${endAt}`);
  return ok({ card: decorateCard(db.prepare('SELECT * FROM member_cards WHERE id = ?').get(c.id)) });
}

// 转卡
function transfer({ params, body, req }) {
  const c = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(params.id);
  if (!c) return fail(404, '会员卡不存在');
  if (['void', 'refunded'].includes(c.status)) return fail(400, '该卡已作废或退款，不可转卡');
  if (deriveStatus(c) === 'expired') return fail(400, '已过期会员卡没有剩余权益，不能转卡');
  const toId = Number(body.to_member_id);
  const to = db.prepare('SELECT * FROM members WHERE id = ?').get(toId);
  if (!to) return fail(404, '接收会员不存在');
  if (to.status !== 'normal') return fail(400, '接收会员状态异常，不能接收转卡');
  if (Number(to.id) === Number(c.member_id)) return fail(400, '不能转给原会员');
  const p = productOf(c);
  if (p && !p.transfer_allowed) return fail(400, '该卡项不允许转卡');
  const fromId = c.member_id;
  const fromMember = memberOf(c);
  db.prepare('UPDATE member_cards SET member_id = ?, updated_at = ? WHERE id = ?').run(to.id, now(), c.id);
  audit.record({ req, action: '会员卡转卡', target_type: 'member_card', target_id: c.id, before: { member_id: fromId }, after: { member_id: to.id }, reason: body.reason });
  sms.accountChange(fromMember, '会员卡转出', `${c.card_no}已转给${to.name}`);
  sms.accountChange(to, '会员卡转入', `${c.card_no}已由${fromMember ? fromMember.name : '原会员'}转入`);
  return ok({ card: decorateCard(db.prepare('SELECT * FROM member_cards WHERE id = ?').get(c.id)) });
}

// 作废
function voidCard({ params, body, req }) {
  const c = db.prepare('SELECT * FROM member_cards WHERE id = ?').get(params.id);
  if (!c) return fail(404, '会员卡不存在');
  if (['void', 'refunded'].includes(c.status)) return fail(400, '该卡已作废或退款，无需重复作废');
  // 储值余额是会员预存资金，作废后卡不可用但余额不会消失，必须先退款或转卡。
  if (c.card_type === 'stored' && money(c.balance) > 0) {
    return fail(400, `该储值卡仍有余额 ${money(c.balance)} 元，请先办理退款或转卡后再作废`);
  }
  db.prepare("UPDATE member_cards SET status = 'void', updated_at = ? WHERE id = ?").run(now(), c.id);
  audit.record({ req, action: '会员卡作废', target_type: 'member_card', target_id: c.id, reason: body.reason, before: { balance: money(c.balance), remaining_uses: c.remaining_uses } });
  sms.accountChange(memberOf(c), '会员卡作废', `${c.card_no}已作废`);
  return ok({ card: decorateCard(db.prepare('SELECT * FROM member_cards WHERE id = ?').get(c.id)) });
}

module.exports = {
  listProducts, createProduct, updateProduct, disableProduct,
  listCards, getCard, freeze: atomic(freeze), unfreeze: atomic(unfreeze), extend: atomic(extend), transfer: atomic(transfer), voidCard: atomic(voidCard),
  refreshFrozenCard, decorateCard, effectiveCardEnd
};
