const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS test_results (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    serial        TEXT    NOT NULL,
    attempt       INTEGER NOT NULL,
    result        TEXT    NOT NULL CHECK (result IN ('PASS', 'FAIL', 'ERROR')),
    reason        TEXT,
    operator      TEXT,
    sample_count  INTEGER NOT NULL,
    started_at    TEXT    NOT NULL,
    finished_at   TEXT    NOT NULL,
    limits_json   TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS measurements (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id  INTEGER NOT NULL REFERENCES test_results(id) ON DELETE CASCADE,
    key      TEXT    NOT NULL,
    name     TEXT    NOT NULL,
    unit     TEXT,
    value    REAL,
    min      REAL    NOT NULL,
    max      REAL    NOT NULL,
    count    INTEGER NOT NULL,
    status   TEXT    NOT NULL CHECK (status IN ('PASS', 'FAIL', 'MISSING'))
  );

  CREATE INDEX IF NOT EXISTS idx_results_serial   ON test_results(serial);
  CREATE INDEX IF NOT EXISTS idx_results_finished ON test_results(finished_at);
  CREATE INDEX IF NOT EXISTS idx_measurements_test ON measurements(test_id);
`;

/**
 * Opens (or creates) the production test database.
 * @param {string} file path to the SQLite file, or ":memory:"
 */
function openResultsDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const countAttempts = db.prepare('SELECT COUNT(*) AS n FROM test_results WHERE serial = ?');
  const insertResult = db.prepare(`
    INSERT INTO test_results (serial, attempt, result, reason, operator, sample_count, started_at, finished_at, limits_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertMeasurement = db.prepare(`
    INSERT INTO measurements (test_id, key, name, unit, value, min, max, count, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function toRecord(row, measurements) {
    return {
      id: row.id,
      serial: row.serial,
      attempt: row.attempt,
      result: row.result,
      reason: row.reason,
      operator: row.operator,
      sampleCount: row.sample_count,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      limits: JSON.parse(row.limits_json),
      measurements: measurements.map((m) => ({
        key: m.key,
        name: m.name,
        unit: m.unit,
        value: m.value,
        min: m.min,
        max: m.max,
        count: m.count,
        status: m.status,
      })),
    };
  }

  function measurementsFor(ids) {
    if (!ids.length) return new Map();
    const rows = db
      .prepare(`SELECT * FROM measurements WHERE test_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
      .all(...ids);
    const byTest = new Map(ids.map((id) => [id, []]));
    for (const m of rows) byTest.get(m.test_id).push(m);
    return byTest;
  }

  /** Stores an evaluated test (see prepareTestRecord) and returns it with id and attempt number. */
  function insert(test) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const attempt = Number(countAttempts.get(test.serial).n) + 1;
      const { lastInsertRowid } = insertResult.run(
        test.serial, attempt, test.result, test.reason, test.operator || null, test.sampleCount,
        test.startedAt, test.finishedAt, JSON.stringify(test.limits)
      );
      const id = Number(lastInsertRowid);
      for (const m of test.measurements) {
        insertMeasurement.run(id, m.key, m.name, m.unit || null, m.value, m.min, m.max, m.count, m.status);
      }
      db.exec('COMMIT');
      return get(id);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function get(id) {
    const row = db.prepare('SELECT * FROM test_results WHERE id = ?').get(id);
    return row ? toRecord(row, measurementsFor([row.id]).get(row.id)) : null;
  }

  function buildWhere({ serial, result, from, to } = {}) {
    const clauses = [];
    const params = [];
    if (serial) {
      clauses.push("serial LIKE ? ESCAPE '\\'");
      params.push(`%${serial.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    }
    if (result) {
      clauses.push('result = ?');
      params.push(result);
    }
    if (from) {
      clauses.push('finished_at >= ?');
      params.push(from);
    }
    if (to) {
      clauses.push('finished_at <= ?');
      params.push(to);
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  /**
   * @param {{serial?: string, result?: string, from?: string, to?: string, limit?: number, offset?: number}} filters
   * @returns {{items: object[], stats: object}}
   */
  function query(filters = {}) {
    const { where, params } = buildWhere(filters);
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    const rows = db
      .prepare(`SELECT * FROM test_results ${where} ORDER BY finished_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    const byTest = measurementsFor(rows.map((r) => r.id));

    const stats = { total: 0, PASS: 0, FAIL: 0, ERROR: 0, yield: null };
    for (const { result, n } of db.prepare(`SELECT result, COUNT(*) AS n FROM test_results ${where} GROUP BY result`).all(...params)) {
      stats[result] = Number(n);
      stats.total += Number(n);
    }
    if (stats.total) stats.yield = Math.round((stats.PASS / stats.total) * 1000) / 10;

    return { items: rows.map((r) => toRecord(r, byTest.get(r.id))), stats };
  }

  return { insert, get, query, close: () => db.close() };
}

module.exports = { openResultsDb };
