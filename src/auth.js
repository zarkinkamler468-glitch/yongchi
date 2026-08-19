'use strict';

const { db } = require('./db');
const { now, fmtDate } = require('./util');
const { createToken } = require('./crypto');

const SESSION_DAYS = 7;

function createSession(staffId) {
  const token = createToken();
  const ts = now();
  const expires = fmtDate(new Date(Date.now() + SESSION_DAYS * 86400000));
  db.prepare('INSERT INTO sessions(token, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, staffId, ts, expires);
  return { token, expires_at: expires };
}

// 按令牌查找有效员工；过期会话自动清理
function findStaffByToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (s.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const u = db.prepare('SELECT * FROM staff WHERE id = ? AND status = ?').get(s.staff_id, 'active');
  return u || null;
}

function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function publicStaff(u) {
  return u ? { id: u.id, username: u.username, real_name: u.real_name, name: u.real_name, role: u.role } : null;
}

module.exports = { createSession, findStaffByToken, deleteSession, publicStaff };
