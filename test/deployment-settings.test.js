'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const tool = path.resolve(__dirname, '../scripts/verify-settings.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-settings-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = path.join(dir, 'before.db');
  const after = path.join(dir, 'after.db');
  const secret = 'test-only-private-value-never-print';
  for (const file of [before, after]) {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT)');
    const insert = db.prepare('INSERT INTO settings VALUES (?, ?)');
    insert.run('store_name', '测试门店');
    insert.run('wechat_secret', secret);
    insert.run('sms_secret_key', '');
    insert.run('schema_v05', '1');
    db.close();
  }
  return { before, after, secret };
}

function run(...files) {
  return spawnSync(process.execPath, [tool, ...files], { encoding: 'utf8' });
}

test('部署配置核对允许新增参数和迁移标记，且只读不修改数据库', t => {
  const { before, after, secret } = fixture(t);
  const db = new DatabaseSync(after);
  db.exec("UPDATE settings SET value='2' WHERE key='schema_v05'; INSERT INTO settings VALUES ('migration_new', '1'), ('new_parameter', 'x')");
  db.close();
  const originals = [fs.readFileSync(before), fs.readFileSync(after)];
  const result = run(before, after);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /核对通过/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
  assert.deepEqual(fs.readFileSync(before), originals[0]);
  assert.deepEqual(fs.readFileSync(after), originals[1]);
});

test('部署核对发现原密钥改变或配置缺失，只输出配置键不输出密钥值', t => {
  const { before, after, secret } = fixture(t);
  const db = new DatabaseSync(after);
  db.exec("UPDATE settings SET value='changed-test-only-secret' WHERE key='wechat_secret'; DELETE FROM settings WHERE key='store_name'");
  db.close();
  const result = run(before, after);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /wechat_secret/);
  assert.match(result.stderr, /store_name/);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
  assert.ok(!(result.stdout + result.stderr).includes('changed-test-only-secret'));
});

test('部署核对错误路径不能创建空库，单库检查不泄露密钥', t => {
  const { before, secret } = fixture(t);
  const missing = path.join(path.dirname(before), 'missing.db');
  const bad = run(missing);
  assert.equal(bad.status, 2);
  assert.equal(fs.existsSync(missing), false);
  const good = run(before);
  assert.equal(good.status, 0, good.stderr);
  assert.ok(!(good.stdout + good.stderr).includes(secret));
});
