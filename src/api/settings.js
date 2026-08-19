'use strict';

const { getSettings, setSettings } = require('../db');
const { ok, fail } = require('../http');

// 公开品牌配置（登录页用，不含任何敏感信息）
const PUBLIC_KEYS = ['store_name', 'brand_icon', 'brand_logo_img', 'login_bg', 'icp_no', 'public_security_no'];

function publicConfig() {
  const all = getSettings();
  const out = {};
  for (const k of PUBLIC_KEYS) out[k] = all[k] || '';
  return ok({ settings: out });
}

// 认证后的设置；所有第三方密钥均不回传。
function get() {
  const all = getSettings();
  all.wechat_secret = '';
  all.sms_secret_id = '';
  all.sms_secret_key = '';
  return ok({ settings: all });
}

function update({ body, req }) {
  if (!body || typeof body !== 'object') return ok({ settings: get().body });
  const protectedKeys = ['wechat_appid', 'wechat_secret', 'icp_no', 'public_security_no'];
  if (req.user.role !== 'admin' && protectedKeys.some((k) => Object.prototype.hasOwnProperty.call(body, k))) {
    return fail(403, '仅超管可以修改微信小程序配置和备案号');
  }
  setSettings(body);
  return ok({ settings: get().body });
}

module.exports = { get, update, publicConfig };
