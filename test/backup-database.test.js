'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const script = path.resolve(__dirname, '../scripts/backup-database.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-backup-test-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('pool-backup-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { source: path.join(root, 'source.db'), output: path.join(root, 'output') };
}

function run({ source, output }) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, PMS_DB_PATH: source, PMS_BACKUP_DIR: output },
    encoding: 'utf8', timeout: 15000
  });
}

test('online backup includes committed WAL rows and creates independent verified snapshots', t => {
  const files = fixture(t);
  const source = new DatabaseSync(files.source);
  try {
    source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT);');
    source.prepare('INSERT INTO entries(value) VALUES (?)').run('committed-in-WAL');
    assert.ok(fs.statSync(files.source + '-wal').size > 0);
    for (let i = 0; i < 2; i++) {
      const result = run(files);
      assert.equal(result.status, 0, result.stderr);
    }
    const names = fs.readdirSync(files.output);
    assert.equal(names.length, 2);
    assert.equal(new Set(names).size, 2);
    for (const name of names) {
      assert.ok(name.endsWith('.db'));
      const snapshot = new DatabaseSync(path.join(files.output, name), { readOnly: true });
      try {
        assert.equal(snapshot.prepare('SELECT value FROM entries').get().value, 'committed-in-WAL');
        assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      } finally { snapshot.close(); }
    }
    assert.equal(source.prepare('SELECT count(*) AS n FROM entries').get().n, 1);
  } finally { source.close(); }
});

test('missing source fails without creating an empty source database', t => {
  const files = fixture(t);
  const result = run(files);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(files.source), false);
  assert.equal(fs.existsSync(files.output), false);
});

test('foreign-key violation fails without publishing a completed snapshot', t => {
  const files = fixture(t);
  const source = new DatabaseSync(files.source);
  source.exec('PRAGMA foreign_keys=OFF; CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES parents(id)); INSERT INTO children VALUES(1,999);');
  source.close();
  const result = run(files);
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(fs.readdirSync(files.output), []);
});
