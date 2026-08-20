'use strict';

const { getSettings, setSettings } = require('../db');
const { ok, fail } = require('../http');

// 公开品牌配置（登录页用，不含任何敏感信息）
const PUBLIC_KEYS = ['store_name', 'brand_icon', 'brand_logo_img', 'login_bg', 'dashboard_bg', 'icp_no', 'public_security_no'];

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
  if (!body || typeof body !== 'object') return get();
  const protectedKeys = ['wechat_appid', 'wechat_secret', 'icp_no', 'public_security_no'];
  if (req.user.role !== 'admin' && protectedKeys.some((k) => Object.prototype.hasOwnProperty.call(body, k))) {
    return fail(403, '仅超管可以修改微信小程序配置和备案号');
  }
  // AppSecret 不会回传到前端；前端保存普通设置时会带回空值，不能因此覆盖已有密钥。
  // 如需清空密钥，使用明确的 clear_wechat_secret 标志，避免误操作。
  const patch = { ...body };
  if (req.user.role === 'admin' && patch.clear_wechat_secret === true) {
    patch.wechat_secret = '';
  } else if (Object.prototype.hasOwnProperty.call(patch, 'wechat_secret') && String(patch.wechat_secret || '').trim() === '') {
    delete patch.wechat_secret;
  }
  delete patch.clear_wechat_secret;
  setSettings(patch);
  return get();
}

module.exports = { get, update, publicConfig };
