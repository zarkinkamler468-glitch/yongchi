'use strict';

const https = require('node:https');
const crypto = require('node:crypto');
const { db, getSetting } = require('../db');
const { verifyPassword, createToken } = require('../crypto');
const { createSession, deleteSession, publicStaff } = require('../auth');
const { ok, fail, httpError, clientIp } = require('../http');
const audit = require('./audit');
const { captchaPng } = require('../captcha');

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

// 验证码只是辅助防护；签发同时限速、限制总量，避免 CPU / 内存无界增长。
const captchaIssuance = new Map();
const CAPTCHA_WINDOW_MS = 60000;
const CAPTCHA_IP_LIMIT = 20;
const CAPTCHA_CAPACITY = 1000;
function captcha({ req } = {}) {
  const ts = Date.now();
  for (const [key, rec] of captchaTokens) if (!rec || rec.expires <= ts) captchaTokens.delete(key);
  for (const [key, rec] of captchaIssuance) if (rec.until <= ts) captchaIssuance.delete(key);
  const ip = clientIp(req);
  const recent = captchaIssuance.get(ip);
  if (recent && recent.count >= CAPTCHA_IP_LIMIT) return fail(429, '验证码请求过于频繁，请稍后再试');
  if (captchaTokens.size >= CAPTCHA_CAPACITY || (!recent && captchaIssuance.size >= CAPTCHA_CAPACITY)) return fail(429, '验证码服务繁忙，请稍后再试');
  const code = randomCode();
  const token = createToken();
  const image = captchaPng(code);
  captchaTokens.set(token, { code, image, expires: ts + 5 * 60 * 1000 });
  captchaIssuance.set(ip, { count: (recent ? recent.count : 0) + 1, until: recent ? recent.until : ts + CAPTCHA_WINDOW_MS });
  return ok({ captcha_token: token, image_path: '/api/auth/captcha-image?token=' + encodeURIComponent(token) });
}
function captchaImage({ query, res }) {
  const token = (query.get('token') || '').trim();
  const rec = captchaTokens.get(token);
  if (!rec || rec.expires <= Date.now()) {
    captchaTokens.delete(token);
    res.writeHead(404, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end();
    return null;
  }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
  res.end(rec.image);
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
