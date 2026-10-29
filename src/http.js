'use strict';

const { URL } = require('node:url');
const { isIP } = require('node:net');

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

// 处理器返回 { status, body } 结果对象，由路由统一发送响应
function ok(data, status = 200) {
  return { status, body: data };
}
function fail(status, message) {
  return { status, body: { error: message } };
}

// 业务异常：抛出后由路由按状态码返回
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// 默认不信任转发头。单层代理可设置 TRUST_PROXY 为直连代理 IP 列表；
// TRUST_PROXY=1 仅适用于后端端口已隔离、只能由可信代理访问的部署。
function clientIp(req) {
  const remote = (req && req.socket && req.socket.remoteAddress) || '';
  const mode = String(process.env.TRUST_PROXY || '').trim();
  const trusted = mode === '1' || mode.split(',').some(ip => ip && ip.trim() === String(remote).replace(/^::ffff:/, ''));
  if (trusted) {
    const forwarded = req && req.headers && req.headers['x-forwarded-for'];
    if (forwarded) {
      // 单层代理只信任紧邻代理追加/覆盖的最后一项，不信任客户端可控制的首项。
      const last = String(forwarded).split(',').pop().trim();
      if (isIP(last)) return last;
    }
    const real = req && req.headers && req.headers['x-real-ip'];
    if (real && isIP(String(real).trim())) return String(real).trim();
  }
  return remote;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        tooLarge = true;
        chunks.length = 0;
        reject(httpError(413, '请求体过大'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (chunks.length === 0) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        validateBody(body);
        resolve(body);
      } catch (e) {
        reject(e.status ? e : httpError(400, 'JSON 解析失败'));
      }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(httpError(400, '请求已中断')));
  });
}

// 在业务写入前拒绝异常结构，避免 .trim/.slice 等抛错后留下部分变更。
function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, '请求体必须是 JSON 对象');
  const textFields = ['name', 'real_name', 'username', 'password', 'phone', 'gender', 'birthday', 'note', 'reason', 'status', 'type', 'order_type', 'keyword', 'request_id', 'gate_no', 'frozen_until', 'business_date', 'refund_method', 'tag_name', 'filename', 'data', 'code', 'bind_token', 'captcha_token', 'captcha_code'];
  for (const key of textFields) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') throw httpError(400, `${key} 必须为文本`);
  }
  if (body.payments !== undefined) {
    if (!Array.isArray(body.payments) || body.payments.length > 100) throw httpError(400, '支付明细必须为不超过 100 笔的数组');
    for (const payment of body.payments) {
      if (!payment || typeof payment !== 'object' || Array.isArray(payment)) throw httpError(400, '支付明细格式无效');
      if (typeof payment.pay_method !== 'string' || (payment.transaction_no != null && typeof payment.transaction_no !== 'string')) throw httpError(400, '支付方式或交易编号格式无效');
    }
  }
}

// 极简路由：/api/members/:id 形式，路径参数按顺序捕获
// opts = { audit, roles, action, module }
function makeRouter(opts = {}) {
  const routes = [];
  function add(method, path, handler, routeOpts = {}) {
    const keys = [];
    const regexStr = path.split('/').map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    const re = new RegExp('^' + regexStr + '$');
    routes.push({ method, re, keys, handler, path, roles: routeOpts.roles, action: routeOpts.action, module: routeOpts.module, audit: routeOpts.audit });
  }
  async function handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const method = req.method;
    let body = null;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      try {
        body = await readBody(req);
      } catch (e) {
        sendJSON(res, e.status || 400, { error: e.message });
        return true;
      }
    }
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = u.pathname.match(r.re);
      if (!m) continue;
      const params = {};
      try {
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      } catch (_) {
        sendJSON(res, 400, { error: '请求参数格式无效' });
        return true;
      }

      // 角色权限校验：admin 超管拥有全部权限
      if (r.roles && r.roles.length && req.user && req.user.role !== 'admin' && !r.roles.includes(req.user.role)) {
        sendJSON(res, 403, { error: '无权限执行该操作' });
        return true;
      }

      let result;
      let audited = false;
      const auditWrite = opts.audit && r.audit !== false && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
      const writeAudit = () => opts.audit({ req, action: r.action || `${method} ${r.path}`, target_type: r.module || 'system', target_id: params.id ? Number(params.id) : undefined });
      try {
        const args = { req, res, params, query: u.searchParams, body: body || {} };
        if (auditWrite && opts.atomic && r.handler.constructor.name !== 'AsyncFunction') {
          result = opts.atomic(input => {
            const value = r.handler(input);
            if (value && value.status < 400) writeAudit();
            return value;
          })(args);
          audited = true;
        } else result = await r.handler(args);
      } catch (e) {
        if (!e || !e.status || e.status >= 500) console.error(`[请求] ${method} ${r.path} 处理失败:`, (e && e.stack) || e);
        result = (e && e.status) ? fail(e.status, e.message) : fail(500, '服务器错误');
      }
      if (result && typeof result === 'object' && 'status' in result) {
        sendJSON(res, result.status, result.body);
      }
      // 成功的写操作写审计日志（最小化：只记 动作/对象/操作人；audit:false 的路由由处理器自行记录）
      if (auditWrite && !audited && result && result.status < 400) {
        try { opts.audit({
          req,
          action: r.action || `${method} ${r.path}`,
          target_type: r.module || 'system',
          target_id: params && params.id ? Number(params.id) : undefined
        }); } catch (err) { console.error('[审计] 操作日志写入失败:', (err && err.stack) || err); }
      }
      return true;
    }
    return false;
  }
  return { add, handle, routes };
}

module.exports = { sendJSON, ok, fail, httpError, readBody, makeRouter, clientIp };
