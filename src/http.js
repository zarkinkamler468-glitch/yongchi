'use strict';

const { URL } = require('node:url');

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
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
        sendJSON(res, 400, { error: e.message });
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
      try {
        result = await r.handler({ req, res, params, query: u.searchParams, body: body || {} });
      } catch (e) {
        result = (e && e.status) ? fail(e.status, e.message) : fail(500, e.message || '服务器错误');
      }
      if (result && typeof result === 'object' && 'status' in result) {
        sendJSON(res, result.status, result.body);
      }
      // 成功的写操作写审计日志（最小化：只记 动作/对象/操作人；audit:false 的路由由处理器自行记录）
      if (opts.audit && r.audit !== false && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && result && result.status < 400) {
        opts.audit({
          req,
          action: r.action || `${method} ${r.path}`,
          target_type: r.module || 'system',
          target_id: params && params.id ? Number(params.id) : undefined
        });
      }
      return true;
    }
    return false;
  }
  return { add, handle, routes };
}

module.exports = { sendJSON, ok, fail, httpError, readBody, makeRouter };
