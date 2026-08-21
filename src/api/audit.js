'use strict';

const { db } = require('../db');
const { now, addDays, today } = require('../util');
const { ok } = require('../http');

const LOG_RETAIN_DAYS = 90;

// 记录操作日志（最小化：动作/对象/操作人/原因/IP；详情最多 200 字符）
function record({ req, action, target_type = 'system', target_id, before, after, reason }) {
  const u = (req && req.user) || {};
  let ip = '';
  if (req && req.socket && req.socket.remoteAddress) ip = req.socket.remoteAddress;
  const compact = (v) => {
    if (v === undefined || v === null) return null;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.slice(0, 200);
  };
  db.prepare(`
    INSERT INTO operation_logs(staff_id, action, target_type, target_id, before_data, after_data, reason, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(u.id || null, action, target_type, target_id || null, compact(before), compact(after), (reason || '').slice(0, 200) || null, ip, now());
}

// 定期清理过期日志，控制云端存储占用（启动时执行一次）
function prune() {
  try {
    const cutoff = addDays(today(), -LOG_RETAIN_DAYS);
    const r = db.prepare('DELETE FROM operation_logs WHERE created_at < ?').run(cutoff);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    if (r.changes > 0) console.log(`[日志] 已清理 ${r.changes} 条超过 ${LOG_RETAIN_DAYS} 天的操作日志`);
  } catch (e) { /* ignore */ }
}

// GET /api/operation-logs（支持 search / target_type / from / to）
function list({ query }) {
  const where = [];
  const args = [];
  const search = (query.get('search') || '').trim();
  if (search) {
    where.push('(l.action LIKE ? OR s.real_name LIKE ? OR l.target_type LIKE ?)');
    const like = `%${search}%`;
    args.push(like, like, like);
  }
  const targetType = query.get('target_type');
  if (targetType) { where.push('l.target_type = ?'); args.push(targetType); }
  const from = query.get('from');
  if (from) { where.push('l.created_at >= ?'); args.push(from); }
  const to = query.get('to');
  if (to) { where.push('l.created_at <= ?'); args.push(to + 'T23:59:59'); }
  const sql = `
    SELECT l.id, l.staff_id, s.real_name AS staff_name, l.action, l.target_type, l.target_id, l.reason, l.ip, l.created_at
    FROM operation_logs l LEFT JOIN staff s ON s.id = l.staff_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY l.id DESC LIMIT 300
  `;
  const rows = db.prepare(sql).all(...args);
  return ok({ list: rows, total: rows.length });
}

module.exports = { record, list, prune };
