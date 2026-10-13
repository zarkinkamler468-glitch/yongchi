'use strict';

// 通用工具：日期、金额、编号等

function pad(n) {
  return String(n).padStart(2, '0');
}

// 金额统一保留两位小数
function money(n) {
  const value = Number(n ?? 0);
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 100) {
    const e = new Error('金额必须为安全范围内的有限数值'); e.status = 400; throw e;
  }
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// 外部输入以整数分校验，拒绝多余小数；内部计算仍用 money 四舍五入。
function cents(value, label = '金额') {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') {
    const e = new Error(`${label}格式无效`); e.status = 400; throw e;
  }
  const n = Number(value); money(n);
  const result = Math.round(n * 100);
  if (n < 0 || n > 1000000000 || Math.abs(n * 100 - result) > 0.00001) {
    const e = new Error(`${label}必须为非负金额，最多两位小数`); e.status = 400; throw e;
  }
  return result;
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

module.exports = { pad, money, cents, today, now, fmtDate, addMonths, addDays, isDateString, genNo, nextNo };
