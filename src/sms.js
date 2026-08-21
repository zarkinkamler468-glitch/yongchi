'use strict';

// 腾讯云 / 阿里云短信轻量实现，不依赖第三方 SDK。
const https = require('node:https');
const crypto = require('node:crypto');
const { getSetting } = require('./db');

function phoneOf(phone) {
  const p = String(phone || '').replace(/[\s-]/g, '');
  return /^1\d{10}$/.test(p) ? p : null;
}
function config() {
  return {
    enabled: getSetting('sms_enabled') === '1', provider: getSetting('sms_provider') === 'aliyun' ? 'aliyun' : 'tencent',
    tencent: { secretId: getSetting('sms_secret_id'), secretKey: getSetting('sms_secret_key'), appId: getSetting('sms_sdk_app_id'), signName: getSetting('sms_sign_name'), templateId: getSetting('sms_template_account_change') },
    aliyun: { accessKeyId: getSetting('aliyun_access_key_id'), accessKeySecret: getSetting('aliyun_access_key_secret'), signName: getSetting('aliyun_sign_name'), templateCode: getSetting('aliyun_template_account_change') }
  };
}

function hmac256(key, text, encoding) { return crypto.createHmac('sha256', key).update(text).digest(encoding); }
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function requestTencent(payload, c) {
  const host = 'sms.tencentcloudapi.com';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(body)}`;
  const scope = `${date}/sms/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const kDate = hmac256('TC3' + c.secretKey, date);
  const kService = hmac256(kDate, 'sms');
  const signature = hmac256(hmac256(kService, 'tc3_request'), stringToSign, 'hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${c.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, method: 'POST', path: '/', headers: {
      'Content-Type': 'application/json; charset=utf-8', Host: host, Authorization: authorization,
      'X-TC-Action': 'SendSms', 'X-TC-Version': '2021-01-11', 'X-TC-Region': 'ap-guangzhou', 'X-TC-Timestamp': timestamp, 'Content-Length': Buffer.byteLength(body)
    }, timeout: 10000 }, (res) => {
      let raw = ''; res.on('data', (x) => { raw += x; });
      res.on('end', () => { try { const j = JSON.parse(raw); const err = j.Response && j.Response.Error; if (err) reject(new Error(err.Code + '：' + err.Message)); else resolve(j.Response); } catch (_) { reject(new Error('腾讯云短信响应解析失败')); } });
    });
    req.on('timeout', () => req.destroy(new Error('腾讯云短信请求超时')));
    req.on('error', reject); req.write(body); req.end();
  });
}

function aliyunEncode(value) {
  return encodeURIComponent(String(value)).replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');
}
function requestAliyun(phone, variables, c) {
  const params = {
    AccessKeyId: c.accessKeyId, Action: 'SendSms', Format: 'JSON', PhoneNumbers: phone, SignName: c.signName,
    SignatureMethod: 'HMAC-SHA1', SignatureNonce: crypto.randomUUID(), SignatureVersion: '1.0',
    TemplateCode: c.templateCode, TemplateParam: JSON.stringify(variables), Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), Version: '2017-05-25'
  };
  const canonical = Object.keys(params).sort().map((k) => `${aliyunEncode(k)}=${aliyunEncode(params[k])}`).join('&');
  const signature = crypto.createHmac('sha1', c.accessKeySecret + '&').update(`GET&${aliyunEncode('/')}&${aliyunEncode(canonical)}`).digest('base64');
  const path = '/?' + canonical + '&Signature=' + aliyunEncode(signature);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'dysmsapi.aliyuncs.com', method: 'GET', path, timeout: 10000 }, (res) => {
      let raw = ''; res.on('data', (x) => { raw += x; });
      res.on('end', () => { try { const j = JSON.parse(raw); if (j.Code !== 'OK') reject(new Error((j.Code || 'AliyunError') + '：' + (j.Message || '短信发送失败'))); else resolve(j); } catch (e) { reject(e instanceof SyntaxError ? new Error('阿里云短信响应解析失败') : e); } });
    });
    req.on('timeout', () => req.destroy(new Error('阿里云短信请求超时')));
    req.on('error', reject); req.end();
  });
}

async function send(phone, params, options = {}) {
  const c = config();
  const target = phoneOf(phone);
  if ((!c.enabled && !options.force) || !target) return { skipped: true };
  const values = Array.isArray(params) ? params.map((v) => String(v)) : [];
  if (c.provider === 'aliyun') {
    const a = c.aliyun;
    if (!a.accessKeyId || !a.accessKeySecret || !a.signName || !a.templateCode) return { skipped: true };
    const response = await requestAliyun(target, { name: values[0] || '会员', type: values[1] || '账户变动', detail: values[2] || '请联系门店查询' }, a);
    return { skipped: false, serial_no: response.BizId || response.RequestId, provider: 'aliyun' };
  }
  const t = c.tencent;
  if (!t.secretId || !t.secretKey || !t.appId || !t.signName || !t.templateId) return { skipped: true };
  const response = await requestTencent({ PhoneNumberSet: ['+86' + target], SmsSdkAppId: t.appId, SignName: t.signName, TemplateId: t.templateId, TemplateParamSet: values }, t);
  const status = response.SendStatusSet && response.SendStatusSet[0];
  if (!status || status.Code !== 'Ok') throw new Error((status && status.Code) + '：' + ((status && status.Message) || '短信发送失败'));
  return { skipped: false, serial_no: status.SerialNo, provider: 'tencent' };
}
function accountChange(member, event, detail) {
  if (!member || !member.phone) return;
  send(member.phone, [member.name || '会员', event, detail]).catch((e) => console.warn('[短信] 账户变动通知失败：' + e.message));
}
function publicConfig() {
  const c = config();
  return {
    enabled: c.enabled, provider: c.provider,
    secret_id: c.tencent.secretId ? '已配置' : '', secret_key: c.tencent.secretKey ? '已配置' : '', sdk_app_id: c.tencent.appId || '', sign_name: c.tencent.signName || '', template_account_change: c.tencent.templateId || '',
    aliyun_access_key_id: c.aliyun.accessKeyId ? '已配置' : '', aliyun_access_key_secret: c.aliyun.accessKeySecret ? '已配置' : '', aliyun_sign_name: c.aliyun.signName || '', aliyun_template_account_change: c.aliyun.templateCode || ''
  };
}

module.exports = { send, accountChange, publicConfig, aliyunEncode };
