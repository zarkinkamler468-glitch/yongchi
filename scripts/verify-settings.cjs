'use strict';

// 独立只读工具：不加载业务模块，不执行迁移，也不打印配置值或密钥。
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

function readSettings(file) {
  const database = new DatabaseSync(path.resolve(file), { readOnly: true });
  try {
    return database.prepare('SELECT key, value FROM settings ORDER BY key').all()
      .filter(row => !/^(schema_|migration_)/.test(row.key));
  } finally {
    database.close();
  }
}

function main(files) {
  if (files.length < 1 || files.length > 2) {
    console.error('用法：node scripts/verify-settings.cjs <升级前数据库> [升级后数据库]');
    return 2;
  }
  const before = readSettings(files[0]);
  if (!before.length) {
    console.error('未发现业务配置，请确认数据库路径；停止升级并检查。');
    return 2;
  }
  console.log(`业务配置项：${before.length}；非空配置项：${before.filter(row => row.value != null && String(row.value).length > 0).length}。`);
  if (files.length === 1) {
    console.log('数据库可读取。未显示任何配置值或密钥。');
    return 0;
  }
  const after = new Map(readSettings(files[1]).map(row => [row.key, row.value]));
  const changed = before.filter(row => !after.has(row.key) || after.get(row.key) !== row.value);
  if (changed.length) {
    console.error(`核对失败：${changed.length} 项原有配置缺失或值改变。`);
    for (const row of changed) console.error(`配置键：${row.key}`);
    return 1;
  }
  console.log(`核对通过：${before.length} 项原有业务配置完全一致；包含原有密钥。`);
  console.log('仅忽略 schema_ / migration_ 前缀的版本迁移标记；允许新版增加配置项。');
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    console.error(`核对未完成：${error.code || '数据库读取失败'}。请检查路径、数据库权限和 settings 表。`);
    process.exitCode = 2;
  }
}

module.exports = { main };
