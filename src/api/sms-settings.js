'use strict';
const { getSettings, setSettings } = require('../db');
const { ok, fail } = require('../http');
const sms = require('../sms');

function get() { return ok({ settings: sms.publicConfig() }); }
function update({ body }) {
  const current = getSettings();
  const provider = body.provider === 'aliyun' ? 'aliyun' : 'tencent';
  const patch = {
    sms_enabled: body.enabled ? '1' : '0', sms_provider: provider,
    sms_sdk_app_id: body.sdk_app_id === undefined ? current.sms_sdk_app_id || '' : String(body.sdk_app_id || '').trim(),
    sms_sign_name: body.sign_name === undefined ? current.sms_sign_name || '' : String(body.sign_name || '').trim(),
    sms_template_account_change: body.template_account_change === undefined ? current.sms_template_account_change || '' : String(body.template_account_change || '').trim(),
    aliyun_sign_name: body.aliyun_sign_name === undefined ? current.aliyun_sign_name || '' : String(body.aliyun_sign_name || '').trim(),
    aliyun_template_account_change: body.aliyun_template_account_change === undefined ? current.aliyun_template_account_change || '' : String(body.aliyun_template_account_change || '').trim()
  };
  if (String(body.secret_id || '').trim()) patch.sms_secret_id = String(body.secret_id).trim(); else patch.sms_secret_id = current.sms_secret_id || '';
  if (String(body.secret_key || '').trim()) patch.sms_secret_key = String(body.secret_key).trim(); else patch.sms_secret_key = current.sms_secret_key || '';
  if (String(body.aliyun_access_key_id || '').trim()) patch.aliyun_access_key_id = String(body.aliyun_access_key_id).trim(); else patch.aliyun_access_key_id = current.aliyun_access_key_id || '';
  if (String(body.aliyun_access_key_secret || '').trim()) patch.aliyun_access_key_secret = String(body.aliyun_access_key_secret).trim(); else patch.aliyun_access_key_secret = current.aliyun_access_key_secret || '';
  if (patch.sms_enabled === '1' && provider === 'tencent' && (!patch.sms_secret_id || !patch.sms_secret_key || !patch.sms_sdk_app_id || !patch.sms_sign_name || !patch.sms_template_account_change)) {
    return fail(400, '启用腾讯云短信前请完整填写密钥、应用、签名和模板');
  }
  if (patch.sms_enabled === '1' && provider === 'aliyun' && (!patch.aliyun_access_key_id || !patch.aliyun_access_key_secret || !patch.aliyun_sign_name || !patch.aliyun_template_account_change)) {
    return fail(400, '启用阿里云短信前请完整填写 AccessKey、签名和模板 CODE');
  }
  setSettings(patch); return get();
}
async function test({ body }) {
  const phone = String(body.phone || '').trim();
  if (!phone) return fail(400, '请输入接收测试短信的手机号');
  const c = sms.publicConfig();
  const complete = c.provider === 'aliyun'
    ? c.aliyun_access_key_id && c.aliyun_access_key_secret && c.aliyun_sign_name && c.aliyun_template_account_change
    : c.secret_id && c.secret_key && c.sdk_app_id && c.sign_name && c.template_account_change;
  if (!complete) return fail(400, `请先完整保存${c.provider === 'aliyun' ? '阿里云' : '腾讯云'}短信配置`);
  try { const result = await sms.send(phone, ['测试会员', '账户变动测试', '短信配置已生效'], { force: true }); if (result.skipped) return fail(400, '测试手机号格式无效或配置不完整'); return ok({ provider: result.provider }); } catch (e) { return fail(400, e.message); }
}
module.exports = { get, update, test };
