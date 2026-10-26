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
  // v3: measurement statistics, evaluation mode and the INVALID status (overflow / non-numeric)
  `
  CREATE TABLE measurements_v3 (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id    INTEGER NOT NULL REFERENCES test_results(id) ON DELETE CASCADE,
    step       INTEGER,
    key        TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    unit       TEXT,
    value      REAL,
    min        REAL    NOT NULL,
    max        REAL    NOT NULL,
    count      INTEGER NOT NULL,
    status     TEXT    NOT NULL CHECK (status IN ('PASS', 'FAIL', 'MISSING', 'INVALID')),
    mode       TEXT    NOT NULL DEFAULT 'mean',
    invalid    INTEGER NOT NULL DEFAULT 0,
    stat_mean  REAL,
    stat_min   REAL,
    stat_max   REAL,
    stat_sd    REAL
  );
  INSERT INTO measurements_v3 (id, test_id, step, key, name, unit, value, min, max, count, status, stat_mean)
    SELECT id, test_id, step, key, name, unit, value, min, max, count, status, value FROM measurements;
  DROP TABLE measurements;
  ALTER TABLE measurements_v3 RENAME TO measurements;
  CREATE INDEX idx_measurements_test ON measurements(test_id);
  `,
  // v4: run ids (idempotent saves), data source, safety state, reservations / retest
  //     policy, users and sessions, draft / published recipes, audit log
  `
  ALTER TABLE test_results ADD COLUMN run_id        TEXT;
  ALTER TABLE test_results ADD COLUMN payload_hash  TEXT;
  ALTER TABLE test_results ADD COLUMN source        TEXT NOT NULL DEFAULT 'unknown'
    CHECK (source IN ('hardware', 'simulation', 'unknown'));
  ALTER TABLE test_results ADD COLUMN transport     TEXT;
  ALTER TABLE test_results ADD COLUMN safety_state  TEXT;
  ALTER TABLE test_results ADD COLUMN safety_reason TEXT;
  ALTER TABLE test_results ADD COLUMN captures_json TEXT;
  ALTER TABLE test_results ADD COLUMN station_json  TEXT;
  ALTER TABLE test_results ADD COLUMN user_id       INTEGER;
  ALTER TABLE test_results ADD COLUMN retest_reason TEXT;
  CREATE UNIQUE INDEX idx_results_run ON test_results(run_id) WHERE run_id IS NOT NULL;
  CREATE INDEX idx_results_source_finished  ON test_results(source, finished_at);
  CREATE INDEX idx_results_serial_source    ON test_results(serial, source);
  CREATE INDEX idx_results_product_finished ON test_results(product_code, finished_at);
  CREATE INDEX idx_results_result_finished  ON test_results(result, finished_at);
  CREATE INDEX idx_measurements_key ON measurements(key, test_id);

  ALTER TABLE products ADD COLUMN published_revision INTEGER;
  ALTER TABLE products ADD COLUMN draft_revision     INTEGER;
  UPDATE products SET published_revision = revision;
  ALTER TABLE product_revisions ADD COLUMN status       TEXT NOT NULL DEFAULT 'superseded'
    CHECK (status IN ('draft', 'published', 'superseded'));
  ALTER TABLE product_revisions ADD COLUMN created_by   INTEGER;
  ALTER TABLE product_revisions ADD COLUMN note         TEXT;
  ALTER TABLE product_revisions ADD COLUMN published_at TEXT;
  ALTER TABLE product_revisions ADD COLUMN published_by INTEGER;
  UPDATE product_revisions SET status = 'published', published_at = created_at
    WHERE (code, revision) IN (SELECT code, revision FROM products);

  CREATE TABLE users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    display_name   TEXT    NOT NULL,
    role           TEXT    NOT NULL CHECK (role IN ('operator', 'engineer', 'admin')),
    password_hash  TEXT    NOT NULL,
    disabled       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL
  );
  CREATE TABLE sessions (
    token_hash  TEXT    PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT    NOT NULL,
    expires_at  TEXT    NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE reservations (
    run_id           TEXT    PRIMARY KEY,
    serial           TEXT    NOT NULL,
    product_code     TEXT    NOT NULL,
    recipe_revision  INTEGER NOT NULL,
    source           TEXT    NOT NULL,
    transport        TEXT,
    user_id          INTEGER,
    station          TEXT,
    retest_reason    TEXT,
    status           TEXT    NOT NULL CHECK (status IN ('open', 'completed', 'abandoned')),
    created_at       TEXT    NOT NULL,
    closed_at        TEXT
  );
  CREATE INDEX idx_reservations_serial ON reservations(serial, status);

  CREATE TABLE unit_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    serial        TEXT    NOT NULL,
    policy_group  TEXT    NOT NULL,
    kind          TEXT    NOT NULL,
    reason        TEXT    NOT NULL,
    user_id       INTEGER,
    at            TEXT    NOT NULL
  );
  CREATE INDEX idx_unit_events_serial ON unit_events(serial, policy_group);

  CREATE TABLE audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT    NOT NULL,
    user_id      INTEGER,
    action       TEXT    NOT NULL,
    entity       TEXT    NOT NULL,
    entity_id    TEXT,
    detail_json  TEXT
  );
  CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
  `,
];

const LATEST_VERSION = MIGRATIONS.length;

/** Legacy v1 columns are filled for new rows so old readers keep working. */
const LEGACY_SAMPLE_COUNT = 0;
const LEGACY_LIMITS = '[]';

/** Simulation history never influences production decisions; unknown (legacy) rows count as production. */
const POLICY_SOURCES = { production: ['hardware', 'unknown'], simulation: ['simulation'] };
const policyGroup = (source) => (source === 'simulation' ? 'simulation' : 'production');

/** SQLite limits bound parameters per statement; large id lists are queried in chunks. */
const CHUNK = 500;

function migrate(db) {
  // A v1 database created before user_version was used already has the tables
  let version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'test_results'").get()) version = 1;
  if (version > LATEST_VERSION) {
    throw new Error(`Veritabanı sürümü (${version}) bu uygulamadan yeni (${LATEST_VERSION}); uygulamayı güncelleyin`);
  }
  for (let v = version; v < LATEST_VERSION; v += 1) {
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
  return version;
}

/**
 * Opens (or creates and migrates) the production test database.
 * @param {string} file path to the SQLite file, or ":memory:"
 */
function openResultsDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const migratedFrom = migrate(db);

  const now = () => new Date().toISOString();
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
  const userName = (id) => (id ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(id)?.display_name ?? null : null);

  // ---------- audit ----------

  function audit(userId, action, entity, entityId, detail) {
    db.prepare('INSERT INTO audit_log (at, user_id, action, entity, entity_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)').run(
      now(), userId ?? null, action, entity, entityId == null ? null : String(entityId), detail === undefined ? null : JSON.stringify(detail)
    );
  }

  function listAudit({ entity, entityId, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (entity) {
      clauses.push('entity = ?');
      params.push(entity);
    }
    if (entityId) {
      clauses.push('entity_id = ?');
      params.push(entityId);
    }
    return db
      .prepare(
        `SELECT a.*, u.display_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ?`
      )
      .all(...params, limit)
      .map((r) => ({ id: r.id, at: r.at, user: r.user_name, action: r.action, entity: r.entity, entityId: r.entity_id, detail: r.detail_json ? JSON.parse(r.detail_json) : null }));
  }

  // ---------- products: drafts and published revisions ----------

  const productHead = (code) => db.prepare('SELECT * FROM products WHERE code = ?').get(code);
  const revisionRow = (code, revision) => db.prepare('SELECT * FROM product_revisions WHERE code = ? AND revision = ?').get(code, revision);

  function toProduct(head, row) {
    return {
      ...JSON.parse(row.definition_json),
      revision: row.revision,
      status: row.status,
      archived: Boolean(head.archived),
      createdAt: row.created_at,
      createdBy: userName(row.created_by),
      note: row.note,
      publishedAt: row.published_at,
      publishedBy: userName(row.published_by),
      draftRevision: head.draft_revision ?? null,
    };
  }

  /** Published products for the station; engineers can ask for drafts and archived ones too. */
  function listProducts({ includeArchived = false, includeDrafts = false } = {}) {
    return db
      .prepare('SELECT * FROM products ORDER BY code')
      .all()
      .filter((head) => (includeArchived || !head.archived) && (head.published_revision || (includeDrafts && head.draft_revision)))
      .map((head) => {
        const revision = head.published_revision ?? head.draft_revision;
        return toProduct(head, revisionRow(head.code, revision));
      });
  }

  /** A specific revision, or the published one. */
  function getProduct(code, revision) {
    const head = productHead(code);
    if (!head) return null;
    const rev = revision ?? head.published_revision;
    if (!rev) return null;
    const row = revisionRow(code, rev);
    return row ? toProduct(head, row) : null;
  }

  function getDraft(code) {
    const head = productHead(code);
    return head?.draft_revision ? toProduct(head, revisionRow(code, head.draft_revision)) : null;
  }

  function listRevisions(code) {
    return db
      .prepare('SELECT * FROM product_revisions WHERE code = ? ORDER BY revision DESC')
      .all(code)
      .map((r) => ({
        revision: r.revision,
        status: r.status,
        createdAt: r.created_at,
        createdBy: userName(r.created_by),
        note: r.note,
        publishedAt: r.published_at,
        publishedBy: userName(r.published_by),
        definition: JSON.parse(r.definition_json),
      }));
  }

  /**
   * Creates or updates the single editable draft of a product.
   * @returns {{product: object, unchanged?: boolean}}
   */
  function saveDraft(definition, userId, note) {
    const json = JSON.stringify(definition);
    return transaction(() => {
      const head = productHead(definition.code);
      const stamp = now();
      if (!head) {
        db.prepare('INSERT INTO products (code, name, revision, archived, updated_at, published_revision, draft_revision) VALUES (?, ?, 1, 0, ?, NULL, 1)').run(definition.code, definition.name, stamp);
        db.prepare("INSERT INTO product_revisions (code, revision, definition_json, created_at, status, created_by, note) VALUES (?, 1, ?, ?, 'draft', ?, ?)").run(definition.code, json, stamp, userId ?? null, note ?? null);
        audit(userId, 'draft.create', 'product', definition.code, { revision: 1, note });
        return { product: getDraft(definition.code) };
      }
      const published = head.published_revision ? revisionRow(head.code, head.published_revision) : null;
      if (!head.draft_revision && published?.definition_json === json) return { product: getProduct(head.code), unchanged: true };
      if (head.draft_revision) {
        db.prepare('UPDATE product_revisions SET definition_json = ?, created_at = ?, created_by = ?, note = ? WHERE code = ? AND revision = ?').run(json, stamp, userId ?? null, note ?? null, head.code, head.draft_revision);
        audit(userId, 'draft.update', 'product', head.code, { revision: head.draft_revision, note });
        return { product: getDraft(head.code) };
      }
      const revision = head.revision + 1;
      db.prepare("INSERT INTO product_revisions (code, revision, definition_json, created_at, status, created_by, note) VALUES (?, ?, ?, ?, 'draft', ?, ?)").run(head.code, revision, json, stamp, userId ?? null, note ?? null);
      db.prepare('UPDATE products SET revision = ?, draft_revision = ?, updated_at = ? WHERE code = ?').run(revision, revision, stamp, head.code);
      audit(userId, 'draft.create', 'product', head.code, { revision, note });
      return { product: getDraft(head.code) };
    });
  }

  function discardDraft(code, userId) {
    return transaction(() => {
      const head = productHead(code);
      if (!head?.draft_revision) return false;
      db.prepare("DELETE FROM product_revisions WHERE code = ? AND revision = ? AND status = 'draft'").run(code, head.draft_revision);
      if (!head.published_revision) db.prepare('DELETE FROM products WHERE code = ?').run(code);
      else db.prepare('UPDATE products SET draft_revision = NULL, revision = ?, updated_at = ? WHERE code = ?').run(head.draft_revision - 1, now(), code);
      audit(userId, 'draft.discard', 'product', code, { revision: head.draft_revision });
      return true;
    });
  }

  /** The draft becomes the published (immutable) revision; the previous one is superseded. */
  function publish(code, userId, note) {
    return transaction(() => {
      const head = productHead(code);
      if (!head?.draft_revision) throw Object.assign(new Error('Yayınlanacak taslak yok'), { code: 'NO_DRAFT' });
      const stamp = now();
      if (head.published_revision) {
        db.prepare("UPDATE product_revisions SET status = 'superseded' WHERE code = ? AND revision = ?").run(code, head.published_revision);
      }
      const draft = revisionRow(code, head.draft_revision);
      db.prepare(
        "UPDATE product_revisions SET status = 'published', published_at = ?, published_by = ?, note = COALESCE(?, note) WHERE code = ? AND revision = ?"
      ).run(stamp, userId ?? null, note ?? null, code, head.draft_revision);
      db.prepare('UPDATE products SET name = ?, published_revision = ?, draft_revision = NULL, archived = 0, updated_at = ? WHERE code = ?').run(
        JSON.parse(draft.definition_json).name, head.draft_revision, stamp, code
      );
      audit(userId, 'publish', 'product', code, { revision: head.draft_revision, previous: head.published_revision, note });
      return getProduct(code);
    });
  }

  function setArchived(code, archived, userId, reason) {
    return transaction(() => {
      const changed = db.prepare('UPDATE products SET archived = ?, updated_at = ? WHERE code = ?').run(archived ? 1 : 0, now(), code).changes > 0;
      if (changed) audit(userId, archived ? 'archive' : 'restore', 'product', code, { reason });
      return changed;
    });
  }

  function seedProducts(definitions) {
    if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n > 0) return;
    transaction(() => {
      const stamp = now();
      for (const def of definitions) {
        db.prepare('INSERT INTO products (code, name, revision, archived, updated_at, published_revision, draft_revision) VALUES (?, ?, 1, 0, ?, 1, NULL)').run(def.code, def.name, stamp);
        db.prepare("INSERT INTO product_revisions (code, revision, definition_json, created_at, status, note, published_at) VALUES (?, 1, ?, ?, 'published', 'Varsayılan ürün', ?)").run(def.code, JSON.stringify(def), stamp, stamp);
      }
    });
  }

  // ---------- units, reservations ----------

  const sourceList = (group) => POLICY_SOURCES[group];
  const inSources = (group) => `(${sourceList(group).map(() => '?').join(',')})`;

  /** Results of one unit within a policy group, plus the time of the last reopen. */
  function unitHistory(serial, group) {
    const results = db
      .prepare(`SELECT result, finished_at AS finishedAt, product_code AS productCode, source FROM test_results WHERE serial = ? AND source IN ${inSources(group)} ORDER BY finished_at`)
      .all(serial, ...sourceList(group))
      .map((r) => ({ ...r }));
    const reopenedAt = db.prepare("SELECT MAX(at) AS at FROM unit_events WHERE serial = ? AND policy_group = ? AND kind = 'reopen'").get(serial, group)?.at ?? null;
    const owner = db
      .prepare(`SELECT product_code FROM test_results WHERE serial = ? AND product_code IS NOT NULL AND source IN ${inSources(group)} ORDER BY id LIMIT 1`)
      .get(serial, ...sourceList(group))?.product_code ?? null;
    return { results, reopenedAt, ownerProduct: owner };
  }

  function unitEvents(serial) {
    return db
      .prepare('SELECT e.*, u.display_name AS user_name FROM unit_events e LEFT JOIN users u ON u.id = e.user_id WHERE serial = ? ORDER BY e.id')
      .all(serial)
      .map((e) => ({ kind: e.kind, policyGroup: e.policy_group, reason: e.reason, user: e.user_name, at: e.at }));
  }

  function reopenUnit(serial, group, userId, reason) {
    return transaction(() => {
      db.prepare("INSERT INTO unit_events (serial, policy_group, kind, reason, user_id, at) VALUES (?, ?, 'reopen', ?, ?, ?)").run(serial, group, reason, userId ?? null, now());
      audit(userId, 'unit.reopen', 'unit', serial, { group, reason });
    });
  }

  function openReservations(serial, group) {
    return db
      .prepare(`SELECT * FROM reservations WHERE serial = ? AND status = 'open' AND source IN ${inSources(group)}`)
      .all(serial, ...sourceList(group))
      .map((r) => ({ ...r }));
  }

  const getReservation = (runId) => {
    const r = db.prepare('SELECT * FROM reservations WHERE run_id = ?').get(runId);
    return r ? { ...r } : null;
  };

  function insertReservation(r) {
    db.prepare(
      "INSERT INTO reservations (run_id, serial, product_code, recipe_revision, source, transport, user_id, station, retest_reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)"
    ).run(r.runId, r.serial, r.productCode, r.recipeRevision, r.source, r.transport ?? null, r.userId ?? null, r.station ?? null, r.retestReason ?? null, now());
  }

  function closeReservation(runId, status) {
    db.prepare("UPDATE reservations SET status = ?, closed_at = ? WHERE run_id = ? AND status = 'open'").run(status, now(), runId);
  }

  // ---------- test results ----------

  const insertResult = db.prepare(`
    INSERT INTO test_results (serial, attempt, result, reason, operator, sample_count, started_at, finished_at, limits_json,
                              product_code, product_name, recipe_revision, failed_step, steps_json, log_json,
                              run_id, payload_hash, source, transport, safety_state, safety_reason, captures_json,
                              station_json, user_id, retest_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertMeasurement = db.prepare(`
    INSERT INTO measurements (test_id, step, key, name, unit, value, min, max, count, status, mode, invalid, stat_mean, stat_min, stat_max, stat_sd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function toMeasurement(m) {
    return {
      step: m.step,
      key: m.key,
      name: m.name,
      unit: m.unit,
      value: m.value,
      min: m.min,
      max: m.max,
      count: m.count,
      status: m.status,
      mode: m.mode,
      invalid: m.invalid,
      stats: { n: m.count, mean: m.stat_mean, min: m.stat_min, max: m.stat_max, sd: m.stat_sd },
    };
  }

  /** Summary fields only — used by the history list. */
  function toSummary(row) {
    return {
      id: row.id,
      runId: row.run_id,
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
      source: row.source,
      transport: row.transport,
      safety: row.safety_state ? { state: row.safety_state, reason: row.safety_reason } : null,
    };
  }

  function toRecord(row, measurements, { includeLog = true } = {}) {
    const steps = row.steps_json ? JSON.parse(row.steps_json) : { steps: [], teardown: [] };
    return {
      ...toSummary(row),
      retestReason: row.retest_reason,
      captures: row.captures_json ? JSON.parse(row.captures_json) : {},
      station: row.station_json ? JSON.parse(row.station_json) : null,
      steps: steps.steps,
      teardown: steps.teardown,
      measurements: measurements.map(toMeasurement),
      ...(includeLog ? { log: row.log_json ? JSON.parse(row.log_json) : [] } : {}),
    };
  }

  function measurementsFor(ids) {
    const byTest = new Map(ids.map((id) => [id, []]));
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const rows = db.prepare(`SELECT * FROM measurements WHERE test_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`).all(...chunk);
      for (const m of rows) byTest.get(m.test_id).push(m);
    }
    return byTest;
  }

  /**
   * Stores an evaluated run. Attempt = earlier results of the unit in the same policy group + 1.
   * @param {object} test output of prepareTestRecord
   * @param {object} meta { runId, payloadHash, source, transport, station, userId, log, retestReason }
   */
  function insert(test, meta = {}) {
    const group = policyGroup(meta.source ?? 'unknown');
    const attempt =
      Number(db.prepare(`SELECT COUNT(*) AS n FROM test_results WHERE serial = ? AND source IN ${inSources(group)}`).get(test.serial, ...sourceList(group)).n) + 1;
    const { lastInsertRowid } = insertResult.run(
      test.serial, attempt, test.result, test.reason, test.operator || null, LEGACY_SAMPLE_COUNT,
      test.startedAt, test.finishedAt, LEGACY_LIMITS,
      test.productCode, test.productName, test.recipeRevision, test.failedStep,
      JSON.stringify({ steps: test.steps, teardown: test.teardown }), JSON.stringify(meta.log ?? []),
      meta.runId ?? null, meta.payloadHash ?? null, meta.source ?? 'unknown', meta.transport ?? null,
      test.safety?.state ?? null, test.safety?.reason ?? null, JSON.stringify(test.captures ?? {}),
      meta.station ? JSON.stringify(meta.station) : null, meta.userId ?? null, meta.retestReason ?? null
    );
    const id = Number(lastInsertRowid);
    for (const m of test.measurements) {
      insertMeasurement.run(
        id, m.step, m.key, m.name, m.unit || null, m.value, m.min, m.max, m.count, m.status,
        m.mode ?? 'mean', m.invalid ?? 0, m.stats?.mean ?? null, m.stats?.min ?? null, m.stats?.max ?? null, m.stats?.sd ?? null
      );
    }
    return id;
  }

  function get(id) {
    const row = db.prepare('SELECT * FROM test_results WHERE id = ?').get(id);
    return row ? toRecord(row, measurementsFor([row.id]).get(row.id)) : null;
  }

  function getByRunId(runId) {
    const row = db.prepare('SELECT * FROM test_results WHERE run_id = ?').get(runId);
    return row ? { record: toRecord(row, measurementsFor([row.id]).get(row.id)), payloadHash: row.payload_hash } : null;
  }

  /**
   * @param {{serial?, serialExact?, product?, result?, from?, to?, source?}} filters
   * source: 'production' (hardware + unknown, the default), 'hardware', 'simulation', 'unknown' or 'all'
   */
  function buildWhere({ serial, serialExact, product, result, from, to, source = 'production' } = {}) {
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
    if (source !== 'all') {
      const sources = POLICY_SOURCES[source] ?? [source];
      clauses.push(`source IN (${sources.map(() => '?').join(',')})`);
      params.push(...sources);
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  /** One page of summaries, the total count and per-result statistics for the same filters. */
  function list(filters = {}, { limit = 50, offset = 0 } = {}) {
    const { where, params } = buildWhere(filters);
    const rows = db.prepare(`SELECT * FROM test_results ${where} ORDER BY finished_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const stats = { total: 0, PASS: 0, FAIL: 0, ERROR: 0, yield: null };
    for (const { result, n } of db.prepare(`SELECT result, COUNT(*) AS n FROM test_results ${where} GROUP BY result`).all(...params)) {
      stats[result] = Number(n);
      stats.total += Number(n);
    }
    if (stats.total) stats.yield = Math.round((stats.PASS / stats.total) * 1000) / 10;
    return { items: rows.map(toSummary), total: stats.total, limit, offset, stats };
  }

  /**
   * Full records (without the communication log) in id order, fetched in batches
   * so an export of any size uses bounded memory.
   */
  function* iterate(filters = {}, batchSize = 250) {
    const { where, params } = buildWhere(filters);
    let lastId = 0;
    for (;;) {
      const rows = db
        .prepare(`SELECT * FROM test_results ${where ? where + ' AND' : 'WHERE'} id > ? ORDER BY id LIMIT ?`)
        .all(...params, lastId, batchSize);
      if (!rows.length) return;
      const byTest = measurementsFor(rows.map((r) => r.id));
      for (const row of rows) yield toRecord(row, byTest.get(row.id), { includeLog: false });
      lastId = rows.at(-1).id;
    }
  }

  /** Distinct measurement columns for a CSV export with these filters, in first-seen order. */
  function measurementColumns(filters = {}) {
    const { where, params } = buildWhere(filters);
    return db
      .prepare(
        `SELECT m.step, m.key, m.name, m.unit, MIN(m.id) AS first FROM measurements m JOIN test_results t ON t.id = m.test_id
         ${where} GROUP BY m.step, m.key ORDER BY first`
      )
      .all(...params)
      .map((r) => ({ step: r.step, key: r.key, name: r.name, unit: r.unit }));
  }

  // ---------- reports ----------

  function report(filters = {}) {
    const { where, params } = buildWhere(filters);
    const and = where ? `${where} AND` : 'WHERE';

    // Counts per 15 minutes (UTC). Every time zone offset is a multiple of 15 minutes, so the
    // caller can map each bucket to the viewer's local day exactly, without loading every row.
    const buckets = db
      .prepare(
        `SELECT substr(finished_at, 1, 14) || printf('%02d', (CAST(substr(finished_at, 15, 2) AS INTEGER) / 15) * 15) AS bucket,
                product_code AS product, result, COUNT(*) AS n
         FROM test_results ${where} GROUP BY bucket, product, result ORDER BY bucket`
      )
      .all(...params)
      .map((r) => ({ ...r }));

    // Per product, aggregated in SQL so the report does not load every row:
    //   firstAttemptUnits / firstPass → first-pass yield (units whose attempt 1 is in the period)
    //   units / unitsPassed           → final yield (units with any PASS in the period)
    const units = db
      .prepare(
        `SELECT product_code AS product,
                COUNT(*) AS tests,
                SUM(CASE WHEN attempt > 1 THEN 1 ELSE 0 END) AS retests,
                COUNT(DISTINCT serial) AS units,
                COUNT(DISTINCT CASE WHEN result = 'PASS' THEN serial END) AS unitsPassed,
                SUM(CASE WHEN attempt = 1 THEN 1 ELSE 0 END) AS firstAttemptUnits,
                SUM(CASE WHEN attempt = 1 AND result = 'PASS' THEN 1 ELSE 0 END) AS firstPass
         FROM test_results ${where} GROUP BY product_code ORDER BY product_code`
      )
      .all(...params)
      .map((r) => ({ ...r }));

    const pareto = db
      .prepare(
        `SELECT result, CASE WHEN instr(reason, ':') > 0 THEN substr(reason, 1, instr(reason, ':') - 1) ELSE COALESCE(reason, '—') END AS cause,
                COUNT(*) AS n
         FROM test_results ${and} result IN ('FAIL', 'ERROR') GROUP BY result, cause ORDER BY n DESC LIMIT 20`
      )
      .all(...params)
      .map((r) => ({ ...r }));

    const measurementKeys = db
      .prepare(
        `SELECT t.product_code AS product, m.key, m.name, m.unit, COUNT(*) AS n FROM measurements m JOIN test_results t ON t.id = m.test_id
         ${and} m.status IN ('PASS', 'FAIL') AND m.value IS NOT NULL GROUP BY t.product_code, m.key ORDER BY t.product_code, m.key`
      )
      .all(...params)
      .map((r) => ({ ...r }));

    return { buckets, units, pareto, measurementKeys };
  }

  /** Values of one measurement (per-test evaluated value) and the current limits, for distribution / Cpk. */
  function measurementValues(filters, product, key, maxValues = 20000) {
    const { where, params } = buildWhere({ ...filters, product });
    const and = where ? `${where} AND` : 'WHERE';
    return db
      .prepare(
        `SELECT m.value, m.min, m.max, m.mode, t.recipe_revision AS revision FROM measurements m JOIN test_results t ON t.id = m.test_id
         ${and} m.key = ? AND m.status IN ('PASS', 'FAIL') AND m.value IS NOT NULL ORDER BY t.id DESC LIMIT ?`
      )
      .all(...params, key, maxValues)
      .map((r) => ({ ...r }));
  }

  // ---------- users and sessions ----------

  const countUsers = () => Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n);

  function toUser(row) {
    return row ? { id: row.id, username: row.username, displayName: row.display_name, role: row.role, disabled: Boolean(row.disabled), createdAt: row.created_at } : null;
  }

  function createUser({ username, displayName, role, passwordHash }, byUserId) {
    return transaction(() => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO users (username, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(username, displayName, role, passwordHash, now());
      audit(byUserId ?? Number(lastInsertRowid), 'user.create', 'user', Number(lastInsertRowid), { username, role });
      return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid));
    });
  }

  const findUserForLogin = (username) => {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
  };
  const getUser = (id) => toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  const listUsers = () => db.prepare('SELECT * FROM users ORDER BY username').all().map(toUser);

  function updateUser(id, { role, disabled, passwordHash, displayName }, byUserId) {
    return transaction(() => {
      if (!getUser(id)) return null;
      if (role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
      if (disabled !== undefined) db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
      if (displayName !== undefined) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
      if (passwordHash !== undefined) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
      // Role, status or password changes end existing sessions
      if (role !== undefined || disabled || passwordHash !== undefined) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      audit(byUserId, 'user.update', 'user', id, { role, disabled, displayName, passwordChanged: passwordHash !== undefined });
      return getUser(id);
    });
  }

  const countAdmins = () => Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n);

  function createSession(tokenHash, userId, expiresAt) {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, userId, now(), expiresAt);
  }

  function getSessionUser(tokenHash) {
    const row = db
      .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0')
      .get(tokenHash, now());
    return toUser(row);
  }

  const deleteSession = (tokenHash) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);

  // ---------- backup ----------

  /** Consistent snapshot of the live database (WAL included) into a new file. */
  function backupTo(target) {
    db.prepare('VACUUM INTO ?').run(target);
  }

  return {
    raw: db,
    transaction,
    migratedFrom,
    audit,
    listAudit,
    listProducts,
    getProduct,
    getDraft,
    listRevisions,
    saveDraft,
    discardDraft,
    publish,
    setArchived,
    seedProducts,
    unitHistory,
    unitEvents,
    reopenUnit,
    openReservations,
    getReservation,
    insertReservation,
    closeReservation,
    insert,
    get,
    getByRunId,
    list,
    iterate,
    measurementColumns,
    report,
    measurementValues,
    countUsers,
    countAdmins,
    createUser,
    findUserForLogin,
    getUser,
    listUsers,
    updateUser,
    createSession,
    getSessionUser,
    deleteSession,
    backupTo,
    close: () => db.close(),
  };
}

/**
 * Checks a database file before it is restored: integrity, foreign keys and schema version.
 * @returns {{ok: boolean, errors: string[], version: number}}
 */
function verifyDatabaseFile(file) {
  const errors = [];
  let version = 0;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check);
    if (integrity.join() !== 'ok') errors.push(`integrity_check: ${integrity.slice(0, 5).join('; ')}`);
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length) errors.push(`${fk.length} yabancı anahtar hatası`);
    version = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (version > LATEST_VERSION) errors.push(`Şema sürümü ${version}, bu uygulama en fazla ${LATEST_VERSION} destekliyor`);
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'test_results'").get()) errors.push('test_results tablosu yok; bu bir Serial Web Viewer veritabanı değil');
  } catch (err) {
    errors.push(err.message);
  } finally {
    db?.close();
  }
  return { ok: errors.length === 0, errors, version };
}

module.exports = { openResultsDb, verifyDatabaseFile, LATEST_VERSION, POLICY_SOURCES, policyGroup };
