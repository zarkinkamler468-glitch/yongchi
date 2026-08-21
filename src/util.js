'use strict';

// 通用工具：日期、金额、编号等

function pad(n) {
  return String(n).padStart(2, '0');
}

// 金额统一保留两位小数
function money(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

// 本地时区日期 YYYY-MM-DD
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 将 Date 格式化为本地 YYYY-MM-DDTHH:mm:ss
function fmtDate(d) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

// 本地时区日期时间 YYYY-MM-DDTHH:mm:ss
function now() {
  return fmtDate(new Date());
}

// 在某日期基础上增加月数，返回 YYYY-MM-DD
function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 在某日期基础上增加天数
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const d = new Date(String(value) + 'T00:00:00');
  return Number.isFinite(d.getTime()) && fmtDate(d).slice(0, 10) === value;
}

// 生成编号（前缀 + 序号补零）
function genNo(prefix, n, width = 6) {
  return prefix + String(n).padStart(width, '0');
}

// 由某表当前最大 id 生成下一个编号
function nextNo(db, table, prefix, width) {
  const row = db.prepare(`SELECT MAX(id) AS mx FROM ${table}`).get();
  const n = row && row.mx ? Number(row.mx) + 1 : 1;
  return genNo(prefix, n, width);
}

module.exports = { pad, money, today, now, fmtDate, addMonths, addDays, isDateString, genNo, nextNo };
