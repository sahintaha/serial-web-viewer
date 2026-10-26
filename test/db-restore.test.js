// Backup / restore from the command line (scripts/db.js).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { openResultsDb, verifyDatabaseFile, LATEST_VERSION } = require('../db');
const { backup, restore } = require('../scripts/db');

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-restore-'));
  dirs.push(dir);
  return dir;
}
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/** A database in the first (version 1) schema with `count` results. */
function legacyDatabase(file, count) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE test_results (id INTEGER PRIMARY KEY AUTOINCREMENT, serial TEXT NOT NULL, attempt INTEGER NOT NULL,
      result TEXT NOT NULL, reason TEXT, operator TEXT, sample_count INTEGER NOT NULL, started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL, limits_json TEXT NOT NULL);
    CREATE TABLE measurements (id INTEGER PRIMARY KEY AUTOINCREMENT, test_id INTEGER NOT NULL, key TEXT NOT NULL,
      name TEXT NOT NULL, unit TEXT, value REAL, min REAL NOT NULL, max REAL NOT NULL, count INTEGER NOT NULL, status TEXT NOT NULL);
  `);
  const insert = db.prepare("INSERT INTO test_results VALUES (?, ?, 1, 'PASS', NULL, NULL, 5, '2026-10-24T10:00:00.000Z', '2026-10-24T10:00:02.000Z', '[]')");
  for (let i = 1; i <= count; i += 1) insert.run(i, `PCB-${String(i).padStart(6, '0')}`);
  db.close();
}

const countTests = (file) => {
  const db = openResultsDb(file);
  try {
    return db.list({ source: 'all' }, { limit: 1 }).total;
  } finally {
    db.close();
  }
};

test('backup and restore round trip; the replaced database is kept', () => {
  const dir = tempDir();
  const live = path.join(dir, 'live.db');
  legacyDatabase(live, 3);
  assert.equal(countTests(live), 3); // migrated to the current schema on open

  const copy = path.join(dir, 'backup.db');
  assert.equal(backup(copy, { dbPath: live }).version, LATEST_VERSION);
  assert.throws(() => backup(copy, { dbPath: live }), /zaten var/, 'an existing backup is never overwritten');

  // Data changes after the backup …
  const db = new DatabaseSync(live);
  db.exec('DELETE FROM test_results WHERE id = 3');
  db.close();
  assert.equal(countTests(live), 2);

  // … and the restore brings the backup back, keeping what it replaced
  const result = restore(copy, { dbPath: live });
  assert.equal(result.tests, 3);
  assert.equal(result.version, LATEST_VERSION);
  assert.ok(result.previous && fs.existsSync(result.previous));
  assert.equal(countTests(result.previous), 2);
  assert.ok(verifyDatabaseFile(live).ok);
});

test('an old-version backup is migrated when it is restored', () => {
  const dir = tempDir();
  const old = path.join(dir, 'old.db');
  legacyDatabase(old, 2);
  const live = path.join(dir, 'live.db');
  const result = restore(old, { dbPath: live });
  assert.equal(result.migratedFrom, 1);
  assert.equal(result.version, LATEST_VERSION);
  assert.equal(result.tests, 2);
  assert.equal(result.previous, null);
});

test('a damaged file or a file from a newer version is refused and the database is untouched', () => {
  const dir = tempDir();
  const live = path.join(dir, 'live.db');
  legacyDatabase(live, 2);
  countTests(live);

  const garbage = path.join(dir, 'garbage.db');
  fs.writeFileSync(garbage, 'this is not a database');
  assert.throws(() => restore(garbage, { dbPath: live }), /kullanılamaz/);

  const newer = path.join(dir, 'newer.db');
  const db = new DatabaseSync(newer);
  db.exec(`CREATE TABLE test_results (id INTEGER PRIMARY KEY); PRAGMA user_version = ${LATEST_VERSION + 1}`);
  db.close();
  assert.throws(() => restore(newer, { dbPath: live }), /Şema sürümü/);

  const foreign = path.join(dir, 'foreign.db');
  new DatabaseSync(foreign).close();
  assert.throws(() => restore(foreign, { dbPath: live }), /test_results tablosu yok/);

  assert.equal(countTests(live), 2);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('restoring') || f.includes('before-restore')), []);
});
