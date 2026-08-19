'use strict';
const { getSettings, setSettings } = require('../db');
const { ok, fail } = require('../http');
const sms = require('../sms');

function get() { return ok({ settings: sms.publicConfig() }); }
function update({ body }) {
  const current = getSettings();
  const patch = {
    sms_enabled: body.enabled ? '1' : '0', sms_sdk_app_id: String(body.sdk_app_id || '').trim(),
    sms_sign_name: String(body.sign_name || '').trim(), sms_template_account_change: String(body.template_account_change || '').trim()
  };
  if (String(body.secret_id || '').trim()) patch.sms_secret_id = String(body.secret_id).trim(); else patch.sms_secret_id = current.sms_secret_id || '';
  if (String(body.secret_key || '').trim()) patch.sms_secret_key = String(body.secret_key).trim(); else patch.sms_secret_key = current.sms_secret_key || '';
  if (patch.sms_enabled === '1' && (!patch.sms_secret_id || !patch.sms_secret_key || !patch.sms_sdk_app_id || !patch.sms_sign_name || !patch.sms_template_account_change)) {
    return fail(400, '启用短信前请完整填写腾讯云密钥、应用、签名和模板');
  }
  setSettings(patch); return get();
}
async function test({ body }) {
  const phone = String(body.phone || '').trim();
  if (!phone) return fail(400, '请输入接收测试短信的手机号');
  const c = sms.publicConfig();
  if (!c.secret_id || !c.secret_key || !c.sdk_app_id || !c.sign_name || !c.template_account_change) return fail(400, '请先完整保存腾讯云短信配置');
  try { const result = await sms.send(phone, ['测试会员', '账户变动测试', '腾讯云短信配置已生效'], { force: true }); if (result.skipped) return fail(400, '测试手机号格式无效'); return ok({}); } catch (e) { return fail(400, e.message); }
}
module.exports = { get, update, test };
