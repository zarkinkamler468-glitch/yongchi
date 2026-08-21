'use strict';

const { db } = require('../db');
const { now } = require('../util');
const { ok, fail } = require('../http');
const { hashPassword } = require('../crypto');

const ROLES = ['admin', 'boss', 'frontdesk', 'finance'];

function sanitize(u) {
  const { id, username, real_name, role, status, created_at } = u;
  return { id, username, real_name, name: real_name, role, status, created_at };
}

function activeCount(role, excludeId) {
  const r = db.prepare('SELECT COUNT(*) AS n FROM staff WHERE role = ? AND status = ?' + (excludeId ? ' AND id != ?' : ''))
    .get(role, 'active', ...(excludeId ? [excludeId] : []));
  return r.n;
}

function list() {
  return ok({ list: db.prepare('SELECT * FROM staff ORDER BY id').all().map(sanitize) });
}

function create({ body, req }) {
  const username = (body.username || '').trim();
  const realName = (body.real_name || '').trim();
  const password = String(body.password || '');
  const role = ROLES.includes(body.role) ? body.role : 'frontdesk';
  if (role === 'admin' && (!req.user || req.user.role !== 'admin')) return fail(403, '仅超管可创建超管账号');
  if (!username) return fail(400, '登录账号不能为空');
  if (username.length > 50 || !/^[A-Za-z0-9_.-]+$/.test(username)) return fail(400, '登录账号仅支持字母、数字、点、下划线和短横线，且不超过 50 位');
  if (!realName) return fail(400, '姓名不能为空');
  if (realName.length > 50) return fail(400, '姓名不能超过 50 个字');
  if (password.length < 8) return fail(400, '密码至少 8 位');
  if (db.prepare('SELECT id FROM staff WHERE username = ?').get(username)) return fail(400, '账号已存在');
  db.prepare('INSERT INTO staff(username, password_hash, real_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, hashPassword(password), realName, role, 'active', now());
  const u = db.prepare('SELECT * FROM staff WHERE username = ?').get(username);
  return ok({ staff: sanitize(u) }, 201);
}

function update({ params, body, req }) {
  const u = db.prepare('SELECT * FROM staff WHERE id = ?').get(params.id);
  if (!u) return fail(404, '员工不存在');
  const realName = (body.real_name || '').trim();
  if (!realName) return fail(400, '姓名不能为空');
  if (realName.length > 50) return fail(400, '姓名不能超过 50 个字');
  const username = body.username === undefined ? u.username : String(body.username || '').trim();
  if (!username || username.length > 50 || !/^[A-Za-z0-9_.-]+$/.test(username)) return fail(400, '登录账号格式无效');
  if (db.prepare('SELECT id FROM staff WHERE username = ? AND id != ?').get(username, u.id)) return fail(400, '账号已存在');
  const role = ROLES.includes(body.role) ? body.role : 'frontdesk';
  const status = body.status === 'inactive' ? 'inactive' : 'active';
  const isSelf = req.user && Number(req.user.id) === Number(u.id);
  const isAdminOp = req.user && req.user.role === 'admin';
  // 仅超管可管理超管账号、或把账号改为/改出超管
  if ((u.role === 'admin' || role === 'admin') && !isAdminOp) return fail(403, '仅超管可管理超管账号');
  if (u.role === 'admin' && (role !== 'admin' || status !== 'active') && activeCount('admin', u.id) < 1) {
    return fail(400, '至少保留一名启用状态的超管账号');
  }
  if (u.role === 'boss' && (role !== 'boss' || status !== 'active') && activeCount('boss', u.id) < 1) {
    return fail(400, '至少保留一名启用状态的老板账号');
  }
  if (isSelf && status !== 'active') return fail(400, '不能停用当前登录账号');
  let hash = u.password_hash;
  if (body.password) {
    if (String(body.password).length < 8) return fail(400, '密码至少 8 位');
    hash = hashPassword(String(body.password));
  }
  db.prepare('UPDATE staff SET username = ?, real_name = ?, role = ?, status = ?, password_hash = ? WHERE id = ?')
    .run(username, realName, role, status, hash, u.id);
  if (body.password || status !== 'active' || role !== u.role) db.prepare('DELETE FROM sessions WHERE staff_id = ?').run(u.id);
  return ok({ staff: sanitize(db.prepare('SELECT * FROM staff WHERE id = ?').get(u.id)) });
}

function remove({ params, req }) {
  const u = db.prepare('SELECT * FROM staff WHERE id = ?').get(params.id);
  if (!u) return fail(404, '员工不存在');
  const isSelf = req.user && Number(req.user.id) === Number(u.id);
  const isAdminOp = req.user && req.user.role === 'admin';
  const target = u.status === 'active' ? 'inactive' : 'active';
  if (u.role === 'admin' && !isAdminOp) return fail(403, '仅超管可管理超管账号');
  if (isSelf && target === 'inactive') return fail(400, '不能停用当前登录账号');
  if (u.role === 'admin' && target === 'inactive' && activeCount('admin', u.id) < 1) {
    return fail(400, '至少保留一名启用状态的超管账号');
  }
  if (u.role === 'boss' && target === 'inactive' && activeCount('boss', u.id) < 1) {
    return fail(400, '至少保留一名启用状态的老板账号');
  }
  db.prepare('UPDATE staff SET status = ? WHERE id = ?').run(target, u.id);
  if (target === 'inactive') db.prepare('DELETE FROM sessions WHERE staff_id = ?').run(u.id);
  return ok({ id: Number(u.id), status: target });
}

module.exports = { list, create, update, remove };
