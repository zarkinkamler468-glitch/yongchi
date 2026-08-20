'use strict';

const { db } = require('../db');
const { now } = require('../util');
const { ok, fail } = require('../http');
const { nextMemberNo, normalizePhone } = require('./common');
const audit = require('./audit');

const STATUSES = ['normal', 'blacklist', 'inactive'];

function decorate(m, tags, cardCount) {
  const t = tags !== undefined
    ? tags
    : db.prepare('SELECT id, tag_name FROM member_tags WHERE member_id = ? ORDER BY id').all(m.id);
  const cc = cardCount !== undefined
    ? cardCount
    : db.prepare('SELECT COUNT(*) AS n FROM member_cards WHERE member_id = ?').get(m.id).n;
  return { ...m, tags: t, card_count: cc };
}

// GET /api/members（标签与卡数用聚合查询一次取回，避免 N+1）
function list({ query }) {
  const where = [];
  const args = [];
  const search = (query.get('search') || '').trim();
  if (search) {
    const normalized = normalizePhone(search);
    where.push('(name LIKE ? OR REPLACE(REPLACE(member_no, \' \', \'\'), \'-\', \'\') LIKE ? OR REPLACE(REPLACE(phone, \' \', \'\'), \'-\', \'\') LIKE ?)');
    args.push(`%${search}%`, `%${normalized}%`, `%${normalized}%`);
  }
  const status = query.get('status');
  if (status) { where.push('status = ?'); args.push(status); }
  const sql = 'SELECT * FROM members' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT 1000';
  const rows = db.prepare(sql).all(...args);
  const ids = rows.map((r) => r.id);
  const tagMap = {};
  const cardMap = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const tagRows = db.prepare(`SELECT member_id, id, tag_name FROM member_tags WHERE member_id IN (${ph}) ORDER BY id`).all(...ids);
    for (const t of tagRows) (tagMap[t.member_id] = tagMap[t.member_id] || []).push({ id: t.id, tag_name: t.tag_name });
    const cardRows = db.prepare(`SELECT member_id, COUNT(*) AS n FROM member_cards WHERE member_id IN (${ph}) GROUP BY member_id`).all(...ids);
    for (const c of cardRows) cardMap[c.member_id] = c.n;
  }
  return ok({ list: rows.map((m) => decorate(m, tagMap[m.id], cardMap[m.id])), total: rows.length });
}

// GET /api/members/:id
function get({ params }) {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(params.id);
  if (!m) return fail(404, '会员不存在');
  const cards = db.prepare('SELECT mc.*, cp.name AS card_name FROM member_cards mc LEFT JOIN card_products cp ON cp.id = mc.card_product_id WHERE mc.member_id = ? ORDER BY mc.id DESC').all(m.id);
  const entries = db.prepare('SELECT * FROM entries WHERE member_id = ? ORDER BY id DESC LIMIT 20').all(m.id);
  const orders = db.prepare('SELECT * FROM orders WHERE member_id = ? ORDER BY id DESC LIMIT 20').all(m.id);
  return ok({ member: decorate(m), cards, entries, orders });
}

// POST /api/members
function create({ body, req }) {
  const name = (body.name || '').trim();
  if (!name) return fail(400, '姓名不能为空');
  const phone = normalizePhone(body.phone) || null;
  if (phone) {
    const dup = db.prepare('SELECT id FROM members WHERE phone = ?').get(phone);
    if (dup) return fail(400, '该手机号已绑定其他会员，不可重复');
  }
  const ts = now();
  const no = nextMemberNo();
  const r = db.prepare(`INSERT INTO members(member_no, name, phone, gender, birthday, note, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'normal', ?, ?)`)
    .run(no, name, phone, body.gender || 'unknown', body.birthday || null, (body.note || '').trim() || null, ts, ts);
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(Number(r.lastInsertRowid));
  audit.record({ req, action: '会员建档', target_type: 'member', target_id: m.id, after: { name, phone } });
  return ok({ member: decorate(m) }, 201);
}

// PUT /api/members/:id
function update({ params, body, req }) {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(params.id);
  if (!m) return fail(404, '会员不存在');
  const name = (body.name || '').trim();
  if (!name) return fail(400, '姓名不能为空');
  const phone = normalizePhone(body.phone) || null;
  if (phone && phone !== m.phone) {
    const dup = db.prepare('SELECT id FROM members WHERE phone = ? AND id != ?').get(phone, m.id);
    if (dup) return fail(400, '该手机号已绑定其他会员，不可重复');
  }
  const status = STATUSES.includes(body.status) ? body.status : m.status;
  db.prepare(`UPDATE members SET name = ?, phone = ?, gender = ?, birthday = ?, note = ?, status = ?, updated_at = ? WHERE id = ?`)
    .run(name, phone, body.gender || m.gender, body.birthday !== undefined ? (body.birthday || null) : m.birthday,
      body.note !== undefined ? (body.note || '').trim() || null : m.note, status, now(), m.id);
  // 最小化日志：仅记录动作与原因，敏感变更（手机号/黑名单）区分动作
  const changed = [];
  if (phone !== m.phone) changed.push('修改手机号');
  if (status !== m.status) changed.push(status === 'blacklist' ? '设置黑名单' : status === 'normal' ? '解除黑名单' : '停用会员');
  audit.record({ req, action: changed.length ? changed.join('、') : '编辑会员', target_type: 'member', target_id: m.id, reason: body.reason || null });
  return ok({ member: decorate(db.prepare('SELECT * FROM members WHERE id = ?').get(m.id)) });
}

// 标签
function addTag({ params, body, req }) {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(params.id);
  if (!m) return fail(404, '会员不存在');
  const tag = (body.tag_name || '').trim();
  if (!tag) return fail(400, '标签不能为空');
  const exists = db.prepare('SELECT id FROM member_tags WHERE member_id = ? AND tag_name = ?').get(m.id, tag);
  if (!exists) {
    db.prepare('INSERT INTO member_tags(member_id, tag_name, created_at) VALUES (?, ?, ?)').run(m.id, tag, now());
    audit.record({ req, action: '添加会员标签', target_type: 'member', target_id: m.id, after: { tag_name: tag } });
  }
  const tags = db.prepare('SELECT id, tag_name FROM member_tags WHERE member_id = ? ORDER BY id').all(m.id);
  return ok({ tags });
}

function removeTag({ params, req }) {
  const tag = db.prepare('SELECT id, tag_name FROM member_tags WHERE id = ? AND member_id = ?').get(params.tagId, params.id);
  if (!tag) return fail(404, '标签不存在或已删除');
  db.prepare('DELETE FROM member_tags WHERE id = ? AND member_id = ?').run(params.tagId, params.id);
  audit.record({ req, action: '删除会员标签', target_type: 'member', target_id: Number(params.id), before: { tag_name: tag.tag_name } });
  return ok({});
}

module.exports = { list, get, create, update, addTag, removeTag };
