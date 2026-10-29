'use strict';

// 修复后证据入口。修复前的 11 项观测保留在同目录 evidence.jsonl 中，
// 当前行为以正式回归测试为准，所有测试使用独立临时数据库。
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(process.execPath, ['--test', 'test/fifth-review.test.js'], {
  cwd: path.resolve(__dirname, '..'), stdio: 'inherit'
});
if (result.error) { console.error(result.error.message); process.exitCode = 1; }
else process.exitCode = result.status === null ? 1 : result.status;
