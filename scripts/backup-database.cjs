'use strict';

// 仅作在线一致性备份，不加载业务模块、不迁移、不输出数据或密钥。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');

async function main() {
  const sourcePath = path.resolve(process.env.PMS_DB_PATH || '/app/data/pool.db');
  const directory = path.resolve(process.env.PMS_BACKUP_DIR || '/backups');
  if (!fs.existsSync(sourcePath)) throw new Error('源数据库不存在；未创建空数据库');
  if (typeof backup !== 'function') throw new Error('备份工具需要支持 node:sqlite backup 的 Node.js 24 运行时');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = 'pool-' + new Date().toISOString().replaceAll(':', '-') + '-' + crypto.randomUUID() + '.db';
  const target = path.join(directory, filename);
  const partial = target + '.partial';
  let source;
  let restored;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    await backup(source, partial);
    fs.chmodSync(partial, 0o600);
    restored = new DatabaseSync(partial);
    // 源库的 WAL 设置会随快照继承；完成 checkpoint 后再发布独立单文件。
    if (restored.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') throw new Error('备份无法转换为独立单文件');
    if (restored.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('备份完整性检查失败');
    if (restored.prepare('PRAGMA foreign_key_check').all().length) throw new Error('备份外键检查失败');
    restored.close();
    restored = null;
    fs.renameSync(partial, target);
    console.log('备份成功：' + target + '；完整性与外键检查通过；字节=' + fs.statSync(target).size);
  } finally {
    if (restored) restored.close();
    if (source) source.close();
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
  }
}

main().catch(error => {
  console.error('备份失败：' + error.message);
  process.exitCode = 1;
});
