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
  all.aliyun_access_key_id = '';
  all.aliyun_access_key_secret = '';
  return ok({ settings: all });
}

function update({ body, req }) {
  if (!body || typeof body !== 'object') return get();
  const protectedKeys = [
    'wechat_appid', 'wechat_secret', 'icp_no', 'public_security_no',
    'sms_enabled', 'sms_secret_id', 'sms_secret_key', 'sms_sdk_app_id',
    'sms_sign_name', 'sms_template_account_change', 'sms_provider',
    'aliyun_access_key_id', 'aliyun_access_key_secret', 'aliyun_sign_name',
    'aliyun_template_account_change'
  ];
  if (req.user.role !== 'admin' && protectedKeys.some((k) => Object.prototype.hasOwnProperty.call(body, k))) {
    return fail(403, '微信、小程序备案和短信配置仅限超管维护');
  }
  // AppSecret 不会回传到前端；前端保存普通设置时会带回空值，不能因此覆盖已有密钥。
  // 如需清空密钥，使用明确的 clear_wechat_secret 标志，避免误操作。
  const patch = { ...body };
  if (Object.prototype.hasOwnProperty.call(patch, 'store_name')) {
    patch.store_name = String(patch.store_name || '').trim();
    if (!patch.store_name) return fail(400, '门店名称不能为空');
    if (patch.store_name.length > 100) return fail(400, '门店名称不能超过 100 个字');
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'month_rule') && !['natural', 'purchase'].includes(patch.month_rule)) return fail(400, '月卡起算方式无效');
  if (Object.prototype.hasOwnProperty.call(patch, 'default_entry_fee')) {
    const fee = Number(patch.default_entry_fee);
    if (!Number.isFinite(fee) || fee < 0 || fee > 100000) return fail(400, '储值卡默认单次扣费必须是有效的非负金额');
    patch.default_entry_fee = String(Math.round((fee + Number.EPSILON) * 100) / 100);
  }
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
