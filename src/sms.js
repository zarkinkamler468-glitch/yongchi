'use strict';

// 腾讯云短信（TC3-HMAC-SHA256）轻量实现，不依赖第三方 SDK。
const https = require('node:https');
const crypto = require('node:crypto');
const { getSetting } = require('./db');

const HOST = 'sms.tencentcloudapi.com';
const SERVICE = 'sms';
const VERSION = '2021-01-11';
const REGION = 'ap-guangzhou';

function hmac(key, text, encoding) { return crypto.createHmac('sha256', key).update(text).digest(encoding); }
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function phoneOf(phone) {
  const p = String(phone || '').replace(/[\s-]/g, '');
  if (!/^1\d{10}$/.test(p)) return null;
  return '+86' + p;
}
function config() {
  return {
    enabled: getSetting('sms_enabled') === '1', secretId: getSetting('sms_secret_id'), secretKey: getSetting('sms_secret_key'),
    appId: getSetting('sms_sdk_app_id'), signName: getSetting('sms_sign_name'), templateId: getSetting('sms_template_account_change')
  };
}
function requestTencent(action, payload, c) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${HOST}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(body)}`;
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`;
  const kDate = hmac('TC3' + c.secretKey, date);
  const kService = hmac(kDate, SERVICE);
  const kSigning = hmac(kService, 'tc3_request');
  const signature = hmac(kSigning, stringToSign, 'hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${c.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: HOST, method: 'POST', path: '/', headers: {
      'Content-Type': 'application/json; charset=utf-8', Host: HOST, Authorization: authorization,
      'X-TC-Action': action, 'X-TC-Version': VERSION, 'X-TC-Region': REGION, 'X-TC-Timestamp': timestamp, 'Content-Length': Buffer.byteLength(body)
    }, timeout: 10000 }, (res) => {
      let raw = ''; res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => { try { const j = JSON.parse(raw); const err = j.Response && j.Response.Error; if (err) reject(new Error(err.Code + '：' + err.Message)); else resolve(j.Response); } catch (_) { reject(new Error('腾讯云短信响应解析失败')); } });
    });
    req.on('timeout', () => req.destroy(new Error('腾讯云短信请求超时')));
    req.on('error', reject); req.write(body); req.end();
  });
}

async function send(phone, params, options = {}) {
  const c = config();
  const target = phoneOf(phone);
  if ((!c.enabled && !options.force) || !target || !c.secretId || !c.secretKey || !c.appId || !c.signName || !c.templateId) return { skipped: true };
  const response = await requestTencent('SendSms', { PhoneNumberSet: [target], SmsSdkAppId: c.appId, SignName: c.signName, TemplateId: c.templateId, TemplateParamSet: params.map((v) => String(v)) }, c);
  const status = response.SendStatusSet && response.SendStatusSet[0];
  if (!status || status.Code !== 'Ok') throw new Error((status && status.Code) + '：' + ((status && status.Message) || '短信发送失败'));
  return { skipped: false, serial_no: status.SerialNo };
}
function accountChange(member, event, detail) {
  if (!member || !member.phone) return;
  // 约定账户变动模板变量顺序：姓名、业务类型、变动说明。
  send(member.phone, [member.name || '会员', event, detail]).catch((e) => console.warn('[短信] 账户变动通知失败：' + e.message));
}
function publicConfig() {
  const c = config();
  return { enabled: c.enabled, secret_id: c.secretId ? '已配置' : '', secret_key: c.secretKey ? '已配置' : '', sdk_app_id: c.appId || '', sign_name: c.signName || '', template_account_change: c.templateId || '' };
}
module.exports = { send, accountChange, publicConfig };
