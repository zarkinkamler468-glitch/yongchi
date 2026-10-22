'use strict';

const https = require('node:https');
const crypto = require('node:crypto');
const { db, getSetting } = require('../db');
const { verifyPassword, createToken } = require('../crypto');
const { createSession, deleteSession, publicStaff } = require('../auth');
const { ok, fail, httpError, clientIp } = require('../http');
const audit = require('./audit');

// ---------------- 登录爆破防护（内存计数，单实例够用） ----------------
const loginAttempts = new Map(); // key: ip|username -> { count, until }
const LOGIN_MAX_FAIL = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 10 * 60 * 1000;

function rateLimitKey(req, username) {
  return clientIp(req) + '|' + username;
}
// 清理过期的登录失败记录；Map 有上限，避免被随机用户名撑大内存。
function pruneLoginAttempts(ts) {
  for (const [key, rec] of loginAttempts) {
    if (!rec || (!rec.until && ts - rec.last > LOGIN_WINDOW_MS)) loginAttempts.delete(key);
  }
  if (loginAttempts.size > 5000) {
    let removed = 0;
    for (const key of loginAttempts.keys()) {
      loginAttempts.delete(key);
      if (++removed >= 1000) break;
    }
  }
}
function checkRateLimit(req, username) {
  pruneLoginAttempts(Date.now());
  const key = rateLimitKey(req, username);
  const rec = loginAttempts.get(key);
  if (rec && rec.until > Date.now()) return fail(429, '尝试次数过多，请 10 分钟后再试');
  return null;
}
function recordLoginFail(req, username) {
  const ts = Date.now();
  pruneLoginAttempts(ts);
  const key = rateLimitKey(req, username);
  let rec = loginAttempts.get(key);
  if (!rec || ts - rec.last > LOGIN_WINDOW_MS) rec = { count: 0, last: ts, until: 0 };
  rec.count += 1;
  rec.last = ts;
  if (rec.count >= LOGIN_MAX_FAIL) { rec.until = ts + LOGIN_LOCK_MS; rec.count = 0; }
  loginAttempts.set(key, rec);
}
function clearLoginFails(req, username) {
  loginAttempts.delete(rateLimitKey(req, username));
}
// 登录日志不能影响登录本身：审计写入失败只记录到控制台。
function safeLoginAudit(payload) {
  try { audit.record(payload); } catch (e) { console.error('[审计] 登录日志写入失败:', (e && e.message) || e); }
}

// ---------------- 图形验证码 ----------------
const captchaTokens = new Map(); // token -> { code, expires }

const CAPTCHA_LEN = 6;

function randomCode() {
  const chars = '23456789'; // 去掉 0/1，减少与 8/7 的视觉混淆
  let s = '';
  for (let i = 0; i < CAPTCHA_LEN; i++) s += chars[crypto.randomInt(0, chars.length)];
  return s;
}

// 用七段矩形绘制数字，验证码不再以 <text> 明文出现在公开 SVG 中。
const SEGMENTS = {
  a: [3, 0, 10, 3], b: [13, 3, 3, 10], c: [13, 16, 3, 10],
  d: [3, 26, 10, 3], e: [0, 16, 3, 10], f: [0, 3, 3, 10], g: [3, 13, 10, 3]
};
const DIGIT_SEGMENTS = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc',
  5: 'afgcd', 6: 'afgecd', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg'
};
function captchaSvg(code) {
  const w = 168, h = 48, cell = 22, left = 14, top = 8;
  const colors = ['#2563eb', '#0ea5e9', '#7c3aed', '#16a34a', '#dc2626'];
  let body = `<rect width="${w}" height="${h}" fill="#f8fafc"/>`;
  for (let i = 0; i < 3; i++) {
    const x1 = (Math.random() * w).toFixed(1), y1 = (Math.random() * h).toFixed(1);
    const x2 = (Math.random() * w).toFixed(1), y2 = (Math.random() * h).toFixed(1);
    body += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#cbd5e1" stroke-width="1"/>`;
  }
  for (let i = 0; i < code.length; i++) {
    const x = left + i * cell + (Math.random() * 4 - 2);
    const y = top + (Math.random() * 4 - 2);
    const rot = (Math.random() * 10 - 5).toFixed(1);
    const color = colors[i % colors.length];
    body += `<g transform="rotate(${rot} ${(x + 8).toFixed(1)} ${(y + 14).toFixed(1)})">`;
    for (const seg of DIGIT_SEGMENTS[code[i]] || '') {
      const [dx, dy, sw, sh] = SEGMENTS[seg];
      body += `<rect x="${(x + dx).toFixed(1)}" y="${(y + dy).toFixed(1)}" width="${sw}" height="${sh}" rx="1" fill="${color}"/>`;
    }
    body += '</g>';
  }
  for (let i = 0; i < 14; i++) {
    body += `<circle cx="${(Math.random() * w).toFixed(1)}" cy="${(Math.random() * h).toFixed(1)}" r="${(Math.random() * 1.5 + 0.5).toFixed(1)}" fill="#94a3b8" opacity="0.5"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
}
function captcha() {
  const ts = Date.now();
  for (const [key, rec] of captchaTokens) if (!rec || rec.expires < ts) captchaTokens.delete(key);
  const code = randomCode();
  const token = createToken();
  captchaTokens.set(token, { code, expires: Date.now() + 5 * 60 * 1000 });
  return ok({ captcha_token: token, svg: captchaSvg(code), image_path: '/api/auth/captcha-image?token=' + encodeURIComponent(token) });
}
// 小程序 image 组件直接使用服务端 SVG 地址；令牌仍由登录请求一次性消费。
function captchaImage({ query, res }) {
  const token = (query.get('token') || '').trim();
  const rec = captchaTokens.get(token);
  if (!rec || rec.expires < Date.now()) {
    captchaTokens.delete(token);
    res.writeHead(404, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
    res.end('');
    return null;
  }
  const svg = captchaSvg(rec.code);
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(svg);
  return null;
}
function verifyCaptcha(token, code) {
  if (!token) return false;
  const rec = captchaTokens.get(token);
  if (!rec || rec.expires < Date.now()) { captchaTokens.delete(token); return false; }
  captchaTokens.delete(token); // 一次性
  return rec.code === String(code || '').trim().toUpperCase();
}

// ---------------- 微信 jscode2session ----------------
const bindTokens = new Map(); // bind_token -> { openid, expires }

function jscode2session(code) {
  const appid = getSetting('wechat_appid');
  const secret = getSetting('wechat_secret');
  if (!appid || !secret) throw httpError(500, '后台未配置微信小程序 appid / secret');
  const url = 'https://api.weixin.qq.com/sns/jscode2session?appid=' + encodeURIComponent(appid) +
    '&secret=' + encodeURIComponent(secret) + '&js_code=' + encodeURIComponent(code) + '&grant_type=authorization_code';
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.openid) resolve(j);
          else reject(httpError(400, '微信登录失败：' + (j.errmsg || '未知错误')));
        } catch (e) {
          reject(httpError(500, '微信接口响应异常'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('微信请求超时')));
    request.on('error', () => reject(httpError(500, '无法连接微信服务器或请求超时')));
  });
}

// ---------------- 账号密码登录 ----------------
function login({ body, req }) {
  const username = (body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return fail(400, '请输入账号和密码');
  // 验证码校验
  if (!verifyCaptcha(body.captcha_token, body.captcha_code)) return fail(400, '验证码错误或已过期');
  const blocked = checkRateLimit(req, username);
  if (blocked) return blocked;
  const u = db.prepare('SELECT * FROM staff WHERE username = ?').get(username);
  if (!u || !verifyPassword(password, u.password_hash)) {
    recordLoginFail(req, username);
    if (u) safeLoginAudit({ req, action: '登录失败', target_type: 'auth', target_id: u.id, reason: username });
    return fail(401, '账号或密码错误');
  }
  if (u.status !== 'active') {
    safeLoginAudit({ req, action: '登录失败', target_type: 'auth', target_id: u.id, reason: '账号已禁用' });
    return fail(403, '该账号已被禁用');
  }
  clearLoginFails(req, username);
  const { token } = createSession(u.id);
  req.user = u;
  safeLoginAudit({ req, action: '登录系统', target_type: 'auth', target_id: u.id });
  return ok({ token, user: publicStaff(u), wx_bound: !!u.wx_openid });
}

// ---------------- 微信登录 ----------------
async function wxLogin({ body, req }) {
  const ts = Date.now();
  for (const [key, rec] of bindTokens) if (!rec || rec.expires < ts) bindTokens.delete(key);
  const code = (body.code || '').trim();
  if (!code) return fail(400, '缺少微信登录 code');
  const sess = await jscode2session(code);
  const openid = sess.openid;
  const u = db.prepare('SELECT * FROM staff WHERE wx_openid = ?').get(openid);
  if (u) {
    if (u.status !== 'active') return fail(403, '该账号已被禁用');
    if (req) req.user = u;
    const { token } = createSession(u.id);
    return ok({ token, user: publicStaff(u), wx_bound: true });
  }
  // 未绑定：下发一次性绑定令牌（5 分钟有效）
  const bindToken = createToken();
  bindTokens.set(bindToken, { openid, expires: Date.now() + 5 * 60 * 1000 });
  return ok({ need_bind: true, bind_token: bindToken });
}

// ---------------- 微信绑定（账号密码验证后绑定 openid） ----------------
function wxBind({ body, req }) {
  const bindToken = (body.bind_token || '').trim();
  const username = (body.username || '').trim();
  const password = String(body.password || '');
  if (!bindToken || !username || !password) return fail(400, '参数不完整');
  const rec = bindTokens.get(bindToken);
  if (!rec || rec.expires < Date.now()) {
    bindTokens.delete(bindToken);
    return fail(400, '绑定会话已过期，请重新微信登录');
  }
  const blocked = checkRateLimit(req, username);
  if (blocked) return blocked;
  const u = db.prepare('SELECT * FROM staff WHERE username = ?').get(username);
  if (!u || !verifyPassword(password, u.password_hash)) {
    recordLoginFail(req, username);
    return fail(401, '账号或密码错误');
  }
  if (u.status !== 'active') return fail(403, '该账号已被禁用');
  clearLoginFails(req, username);
  // 该 openid 已绑定其他账号则拒绝
  const other = db.prepare('SELECT id FROM staff WHERE wx_openid = ? AND id != ?').get(rec.openid, u.id);
  if (other) { bindTokens.delete(bindToken); return fail(400, '该微信已绑定其他账号'); }
  try { db.prepare('UPDATE staff SET wx_openid = ? WHERE id = ?').run(rec.openid, u.id); } catch (e) {
    if (String(e && e.message).includes('UNIQUE')) return fail(409, '该微信已绑定其他账号');
    throw e;
  }
  bindTokens.delete(bindToken);
  req.user = u;
  const { token } = createSession(u.id);
  return ok({ token, user: publicStaff(u), wx_bound: true });
}

// 解绑当前账号的微信
function wxUnbind({ req }) {
  db.prepare('UPDATE staff SET wx_openid = NULL WHERE id = ?').run(req.user.id);
  return ok({});
}

function logout({ req }) {
  deleteSession(req.authToken);
  return ok({});
}

function me({ req }) {
  return ok({ user: { ...publicStaff(req.user), wx_bound: !!req.user.wx_openid } });
}

module.exports = { login, logout, me, captcha, captchaImage, wxLogin, wxBind, wxUnbind };
