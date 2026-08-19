'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildRouter } = require('./src/api');
const { sendJSON } = require('./src/http');
const { getSetting } = require('./src/db');
const { findStaffByToken } = require('./src/auth');
const { prune } = require('./src/api/audit');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const router = buildRouter();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  // 防目录穿越：必须严格位于 public 目录内
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

function getToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith('/api/')) {
    // 公开接口：账号登录 / 微信登录 / 微信绑定；其余接口需登录令牌
    const PUBLIC = ['/api/auth/login', '/api/auth/wxlogin', '/api/auth/wxbind', '/api/auth/captcha', '/api/auth/captcha-image', '/api/public-config'];
    if (!PUBLIC.includes(pathname)) {
      const token = getToken(req);
      const user = findStaffByToken(token);
      if (!user) {
        sendJSON(res, 401, { error: '未登录或登录已过期' });
        return;
      }
      req.user = user;
      req.authToken = token;
    }
    const handled = await router.handle(req, res);
    if (!handled) sendJSON(res, 404, { error: '接口不存在' });
    return;
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  serveStatic(req, res, pathname);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[错误] 端口 ${PORT} 已被占用，请使用其它端口：PORT=3001 npm start`);
  } else {
    console.error('[错误]', err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  prune(); // 启动时清理过期操作日志
  console.log('==============================================');
  console.log(`  ${getSetting('store_name')} - 游泳池管理系统`);
  console.log('==============================================');
  console.log(`  服务已启动：http://localhost:${PORT}`);
  console.log(`  数据库文件：${path.join(__dirname, 'data', 'pool.db')}`);
  console.log('  安全提示：首次部署后请立即修改初始账号密码，并妥善备份数据库。');
  console.log('  按 Ctrl+C 停止服务');
  console.log('==============================================');
});
