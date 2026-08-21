'use strict';

const https = require('node:https');
const { db, getSetting } = require('../db');
const { verifyPassword, createToken } = require('../crypto');
const { createSession, deleteSession, publicStaff } = require('../auth');
const { ok, fail, httpError } = require('../http');

// ---------------- 登录爆破防护（内存计数，单实例够用） ----------------
const loginAttempts = new Map(); // key: ip|username -> { count, until }
const LOGIN_MAX_FAIL = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 10 * 60 * 1000;

function rateLimitKey(req, username) {
  const ip = (req && req.socket && req.socket.remoteAddress) || '';
  return ip + '|' + username;
}
function checkRateLimit(req, username) {
  const key = rateLimitKey(req, username);
  const rec = loginAttempts.get(key);
  if (rec && rec.until > Date.now()) return fail(429, '尝试次数过多，请 10 分钟后再试');
  return null;
}
function recordLoginFail(req, username) {
  const key = rateLimitKey(req, username);
  const now = Date.now();
  let rec = loginAttempts.get(key);
  if (!rec || now - rec.last > LOGIN_WINDOW_MS) rec = { count: 0, last: now, until: 0 };
  rec.count += 1;
  rec.last = now;
  if (rec.count >= LOGIN_MAX_FAIL) { rec.until = now + LOGIN_LOCK_MS; rec.count = 0; }
  loginAttempts.set(key, rec);
}
function clearLoginFails(req, username) {
  loginAttempts.delete(rateLimitKey(req, username));
}

// ---------------- 图形验证码 ----------------
const captchaTokens = new Map(); // token -> { code, expires }

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function captchaSvg(code) {
  const w = 128, h = 46;
  let body = '';
  for (let i = 0; i < 3; i++) {
    const x1 = Math.random() * w, y1 = Math.random() * h, x2 = Math.random() * w, y2 = Math.random() * h;
    body += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#cbd5e1" stroke-width="1"/>`;
  }
  const colors = ['#2563eb', '#0ea5e9', '#7c3aed', '#16a34a', '#dc2626'];
  for (let i = 0; i < code.length; i++) {
    const x = 18 + i * 26 + (Math.random() * 6 - 3);
    const y = 32 + (Math.random() * 8 - 4);
    const rot = (Math.random() * 30 - 15).toFixed(1);
    body += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="26" font-family="Arial" font-weight="bold" fill="${colors[i % colors.length]}" transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})">${code[i]}</text>`;
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
    https.get(url, (res) => {
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
    }).on('error', () => reject(httpError(500, '无法连接微信服务器')));
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
    return fail(401, '账号或密码错误');
  }
  if (u.status !== 'active') return fail(403, '该账号已被禁用');
  clearLoginFails(req, username);
  const { token } = createSession(u.id);
  req.user = u;
  return ok({ token, user: publicStaff(u), wx_bound: !!u.wx_openid });
}

// ---------------- 微信登录 ----------------
async function wxLogin({ body }) {
  const ts = Date.now();
  for (const [key, rec] of bindTokens) if (!rec || rec.expires < ts) bindTokens.delete(key);
  const code = (body.code || '').trim();
  if (!code) return fail(400, '缺少微信登录 code');
  const sess = await jscode2session(code);
  const openid = sess.openid;
  const u = db.prepare('SELECT * FROM staff WHERE wx_openid = ?').get(openid);
  if (u) {
    if (u.status !== 'active') return fail(403, '该账号已被禁用');
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
  db.prepare('UPDATE staff SET wx_openid = ? WHERE id = ?').run(rec.openid, u.id);
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
