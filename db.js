const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Each migration moves the schema one version forward (PRAGMA user_version).
// Existing databases are upgraded in place; nothing is ever dropped.
const MIGRATIONS = [
  // v1: limit-based production test
  `
  CREATE TABLE test_results (
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
  CREATE TABLE measurements (
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
  CREATE INDEX idx_results_serial   ON test_results(serial);
  CREATE INDEX idx_results_finished ON test_results(finished_at);
  CREATE INDEX idx_measurements_test ON measurements(test_id);
  `,
  // v2: products with versioned recipes, step-based results
  `
  CREATE TABLE products (
    code        TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    revision    INTEGER NOT NULL,
    archived    INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT    NOT NULL
  );
  CREATE TABLE product_revisions (
    code             TEXT    NOT NULL REFERENCES products(code),
    revision         INTEGER NOT NULL,
    definition_json  TEXT    NOT NULL,
    created_at       TEXT    NOT NULL,
    PRIMARY KEY (code, revision)
  );
  ALTER TABLE test_results ADD COLUMN product_code    TEXT;
  ALTER TABLE test_results ADD COLUMN product_name    TEXT;
  ALTER TABLE test_results ADD COLUMN recipe_revision INTEGER;
  ALTER TABLE test_results ADD COLUMN failed_step     INTEGER;
  ALTER TABLE test_results ADD COLUMN steps_json      TEXT;
  ALTER TABLE test_results ADD COLUMN log_json        TEXT;
  ALTER TABLE measurements ADD COLUMN step            INTEGER;
  CREATE INDEX idx_results_product ON test_results(product_code);
  `,
];

/** Legacy v1 columns are filled for new rows so old readers keep working. */
const LEGACY_SAMPLE_COUNT = 0;
const LEGACY_LIMITS = '[]';

/**
 * Opens (or creates and migrates) the production test database.
 * @param {string} file path to the SQLite file, or ":memory:"
 */
function openResultsDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

  // A v1 database created before user_version was used already has the tables
  let version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'test_results'").get()) version = 1;
  for (let v = version; v < MIGRATIONS.length; v += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  // ---------- products ----------

  function productFrom(row, definitionJson) {
    return {
      ...JSON.parse(definitionJson),
      revision: row.revision,
      archived: Boolean(row.archived),
      updatedAt: row.updated_at ?? row.created_at,
    };
  }

  function listProducts({ includeArchived = false } = {}) {
    return db
      .prepare(
        `SELECT p.*, r.definition_json FROM products p
         JOIN product_revisions r ON r.code = p.code AND r.revision = p.revision
         ${includeArchived ? '' : 'WHERE p.archived = 0'} ORDER BY p.code`
      )
      .all()
      .map((row) => productFrom(row, row.definition_json));
  }

  /** Current revision, or a specific one (old results reference the revision they ran with). */
  function getProduct(code, revision) {
    const head = db.prepare('SELECT * FROM products WHERE code = ?').get(code);
    if (!head) return null;
    const rev = revision ?? head.revision;
    const row = db.prepare('SELECT * FROM product_revisions WHERE code = ? AND revision = ?').get(code, rev);
    return row ? productFrom({ ...head, revision: rev }, row.definition_json) : null;
  }

  /** Stores a validated product. Creates a new revision only when the definition changed. */
  function saveProduct(product) {
    const json = JSON.stringify(product);
    const now = new Date().toISOString();
    return transaction(() => {
      const head = db.prepare('SELECT * FROM products WHERE code = ?').get(product.code);
      if (head) {
        const current = db.prepare('SELECT definition_json FROM product_revisions WHERE code = ? AND revision = ?').get(head.code, head.revision);
        if (current.definition_json === json && !head.archived) return getProduct(product.code);
        const revision = current.definition_json === json ? head.revision : head.revision + 1;
        if (revision !== head.revision) {
          db.prepare('INSERT INTO product_revisions VALUES (?, ?, ?, ?)').run(product.code, revision, json, now);
        }
        db.prepare('UPDATE products SET name = ?, revision = ?, archived = 0, updated_at = ? WHERE code = ?').run(product.name, revision, now, product.code);
      } else {
        db.prepare('INSERT INTO products VALUES (?, ?, 1, 0, ?)').run(product.code, product.name, now);
        db.prepare('INSERT INTO product_revisions VALUES (?, 1, ?, ?)').run(product.code, json, now);
      }
      return getProduct(product.code);
    });
  }

  /** Products are archived, never deleted: test results keep pointing at their recipe. */
  function archiveProduct(code) {
    return db.prepare('UPDATE products SET archived = 1, updated_at = ? WHERE code = ?').run(new Date().toISOString(), code).changes > 0;
  }

  function seedProducts(products) {
    if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n > 0) return;
    for (const p of products) saveProduct(p);
  }

  // ---------- test results ----------

  const insertResult = db.prepare(`
    INSERT INTO test_results (serial, attempt, result, reason, operator, sample_count, started_at, finished_at, limits_json,
                              product_code, product_name, recipe_revision, failed_step, steps_json, log_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertMeasurement = db.prepare(`
    INSERT INTO measurements (test_id, step, key, name, unit, value, min, max, count, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function toRecord(row, measurements) {
    const steps = row.steps_json ? JSON.parse(row.steps_json) : { steps: [], teardown: [] };
    return {
      id: row.id,
      serial: row.serial,
      productCode: row.product_code,
      productName: row.product_name,
      recipeRevision: row.recipe_revision,
      attempt: row.attempt,
      result: row.result,
      reason: row.reason,
      failedStep: row.failed_step,
      operator: row.operator,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      steps: steps.steps,
      teardown: steps.teardown,
      log: row.log_json ? JSON.parse(row.log_json) : [],
      measurements: measurements.map((m) => ({
        step: m.step,
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

  /** Stores an evaluated run (see prepareTestRecord) and returns it with id and attempt number. */
  function insert(test, log = []) {
    return transaction(() => {
      const attempt = Number(db.prepare('SELECT COUNT(*) AS n FROM test_results WHERE serial = ?').get(test.serial).n) + 1;
      const { lastInsertRowid } = insertResult.run(
        test.serial, attempt, test.result, test.reason, test.operator || null, LEGACY_SAMPLE_COUNT,
        test.startedAt, test.finishedAt, LEGACY_LIMITS,
        test.productCode, test.productName, test.recipeRevision, test.failedStep,
        JSON.stringify({ steps: test.steps, teardown: test.teardown }), JSON.stringify(log)
      );
      const id = Number(lastInsertRowid);
      for (const m of test.measurements) {
        insertMeasurement.run(id, m.step, m.key, m.name, m.unit || null, m.value, m.min, m.max, m.count, m.status);
      }
      return get(id);
    });
  }

  function get(id) {
    const row = db.prepare('SELECT * FROM test_results WHERE id = ?').get(id);
    return row ? toRecord(row, measurementsFor([row.id]).get(row.id)) : null;
  }

  function buildWhere({ serial, serialExact, product, result, from, to } = {}) {
    const clauses = [];
    const params = [];
    if (serialExact) {
      clauses.push('serial = ?');
      params.push(serialExact);
    } else if (serial) {
      clauses.push("serial LIKE ? ESCAPE '\\'");
      params.push(`%${serial.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    }
    if (product) {
      clauses.push('product_code = ?');
      params.push(product);
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
   * @param {{serial?: string, serialExact?: string, product?: string, result?: string, from?: string, to?: string, limit?: number, offset?: number}} filters
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

  /** Minimal history of one unit, for the retest policy. */
  function unitHistory(serial) {
    return db
      .prepare('SELECT result, finished_at AS finishedAt FROM test_results WHERE serial = ? ORDER BY finished_at')
      .all(serial)
      .map((r) => ({ ...r }));
  }

  return {
    listProducts,
    getProduct,
    saveProduct,
    archiveProduct,
    seedProducts,
    insert,
    get,
    query,
    unitHistory,
    close: () => db.close(),
  };
}

module.exports = { openResultsDb };
