'use strict';
// 本地页面验收专用服务：独立临时库，八分钟后退出并清理。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-browser-'));
process.env.NODE_ENV = 'test';
process.env.PMS_DB_PATH = path.join(dir, 'browser.db');
process.env.PORT = '3199';
process.env.HOST = '127.0.0.1';
process.env.PMS_SEED_DEMO = '0';
for (const role of ['ADMIN', 'BOSS', 'FRONTDESK', 'FINANCE']) process.env[`PMS_INITIAL_${role}_PASSWORD`] = 'LocalBrowserFixture2026';
require('../server');
process.on('SIGINT', () => process.exit(0));
process.on('exit', () => {
  require('../src/db').db.close();
  for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
  fs.rmdirSync(dir);
});
setTimeout(() => process.exit(0), 8 * 60 * 1000);
