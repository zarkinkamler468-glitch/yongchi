'use strict';
// 审查反例已转为修复后的回归测试；使用独立临时库运行。
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...['business.test.js', 'review.test.js', 'strict-review.test.js'].map(file => path.join(__dirname, '../test', file))], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
