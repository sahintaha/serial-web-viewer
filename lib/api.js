// REST API: products (drafts / published revisions), units and the retest policy,
// run reservations, idempotent result storage, history, CSV export, reports,
// audit log and backups. Shared validation / evaluation logic comes from the
// browser modules in public/js (ES modules, loaded once).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { policyGroup } = require('../db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_FOR_TRANSPORT = { simulator: 'simulation', webserial: 'hardware', server: 'hardware' };
const LIST_SOURCES = ['production', 'hardware', 'simulation', 'unknown', 'all'];
const MAX_PAGE = 200;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
// Reports and exports use the viewer's time zone (?tz=Europe/Istanbul); this is the fallback
const SERVER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const fail = (res, status, errors, extra = {}) => res.status(status).json({ errors: [].concat(errors), ...extra });

/**
 * @param {object} options
 * @param {import('express').Express} options.app
 * @param {object} options.db
 * @param {object} options.auth createAuth() instance
 * @param {object} options.bridge createSerialBridge() instance
 * @param {Promise<{production: object, recipe: object}>} options.shared ES modules from public/js
 * @param {object} options.station { id, fixture, calibration: {id, due}, appVersion }
 */
function mountApi({ app, db, auth, bridge, shared, station }) {
  const { requireRole } = auth;
  const operator = requireRole('operator');
  const engineer = requireRole('engineer');
  const admin = requireRole('admin');

  let recipeModule = null;
  const ready = shared.then((mods) => {
    recipeModule = mods.recipe;
    db.seedProducts(mods.recipe.DEFAULT_PRODUCTS.map((p) => mods.recipe.validateProduct(p).product));
    return mods;
  });
  // Definitions saved by older versions lack later fields (protocol, heartbeat, …): fill the
  // defaults when they are read. Every handler that reads products awaits `ready` first.
  const withDefaults = (p) => (p ? { ...p, ...recipeModule.withDefaults(p) } : p);
  const getProduct = (code, revision) => withDefaults(db.getProduct(code, revision));

  // Express 4 does not catch async errors; route them to the error handler
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  function calibrationExpired() {
    return Boolean(station.calibration?.due) && new Date(station.calibration.due) < new Date(new Date().toISOString().slice(0, 10));
  }

  app.get('/api/station', operator, (req, res) => {
    res.json({ ...station, calibrationExpired: calibrationExpired() });
  });

  // ---------- products ----------

  app.get('/api/products', operator, wrap(async (req, res) => {
    await ready;
    const isEngineer = auth.hasRole(req.user, 'engineer');
    res.json(db.listProducts({ includeArchived: isEngineer && req.query.archived === '1', includeDrafts: isEngineer && req.query.drafts === '1' }).map(withDefaults));
  }));

  app.get('/api/products/:code', operator, wrap(async (req, res) => {
    await ready;
    const code = String(req.params.code).toUpperCase();
    const revision = req.query.revision === undefined ? undefined : Number(req.query.revision);
    if (revision !== undefined && !Number.isInteger(revision)) return fail(res, 400, 'Geçersiz revizyon');
    const product = getProduct(code, revision);
    if (!product) return fail(res, 404, 'Ürün bulunamadı');
    if (product.status === 'draft' && !auth.hasRole(req.user, 'engineer')) return fail(res, 403, 'Taslaklar yalnızca mühendislere açık');
    res.json(product);
  }));

  app.get('/api/products/:code/revisions', engineer, wrap(async (req, res) => {
    await ready;
    res.json({ revisions: db.listRevisions(String(req.params.code).toUpperCase()), audit: db.listAudit({ entity: 'product', entityId: String(req.params.code).toUpperCase() }) });
  }));

  app.get('/api/products/:code/draft', engineer, wrap(async (req, res) => {
    await ready;
    const draft = withDefaults(db.getDraft(String(req.params.code).toUpperCase()));
    if (!draft) return fail(res, 404, 'Taslak yok');
    res.json(draft);
  }));

  app.put('/api/products/:code/draft', engineer, wrap(async (req, res) => {
    const { recipe } = await ready;
    const { product, errors } = recipe.validateProduct({ ...req.body?.definition, code: req.params.code });
    if (errors.length) return fail(res, 400, errors);
    const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
    res.json(db.saveDraft(product, req.user.id, note));
  }));

  app.delete('/api/products/:code/draft', engineer, wrap(async (req, res) => {
    await ready;
    if (!db.discardDraft(String(req.params.code).toUpperCase(), req.user.id)) return fail(res, 404, 'Taslak yok');
    res.status(204).end();
  }));

  app.post('/api/products/:code/publish', engineer, wrap(async (req, res) => {
    await ready;
    const note = String(req.body?.note ?? '').trim();
    if (!note) return fail(res, 400, 'Yayın notu (neyi neden değiştirdiniz) zorunlu');
    try {
      res.json(db.publish(String(req.params.code).toUpperCase(), req.user.id, note.slice(0, 500)));
    } catch (err) {
      if (err.code === 'NO_DRAFT') return fail(res, 409, err.message);
      throw err;
    }
  }));

  for (const [action, archived] of [['archive', true], ['restore', false]]) {
    app.post(`/api/products/:code/${action}`, engineer, wrap(async (req, res) => {
      await ready;
      const reason = String(req.body?.reason ?? '').trim();
      if (archived && !reason) return fail(res, 400, 'Arşivleme gerekçesi zorunlu');
      if (!db.setArchived(String(req.params.code).toUpperCase(), archived, req.user.id, reason || null)) return fail(res, 404, 'Ürün bulunamadı');
      res.status(204).end();
    }));
  }

  // ---------- units and the retest policy ----------

  function sourceFromQuery(value) {
    return value === 'simulation' ? 'simulation' : 'hardware';
  }

  app.get('/api/units/:serial', operator, wrap(async (req, res) => {
    const { production, recipe } = await ready;
    const serial = recipe.normalizeSerial(req.params.serial);
    const group = policyGroup(sourceFromQuery(req.query.source));
    const history = db.unitHistory(serial, group);
    const product = req.query.product ? getProduct(String(req.query.product).toUpperCase()) : null;
    res.json({
      serial,
      policyGroup: group,
      ownerProduct: history.ownerProduct,
      ...production.unitStatus(history.results, product?.maxAttempts ?? Infinity, { reopenedAt: history.reopenedAt, maxErrors: product?.maxErrors ?? Infinity }),
      openReservations: db.openReservations(serial, group).length,
      events: db.unitEvents(serial),
    });
  }));

  app.post('/api/units/:serial/reopen', engineer, wrap(async (req, res) => {
    const { recipe } = await ready;
    const reason = String(req.body?.reason ?? '').trim();
    if (reason.length < 5) return fail(res, 400, 'Onarım / yeniden açma gerekçesi en az 5 karakter olmalı');
    const serial = recipe.normalizeSerial(req.params.serial);
    db.reopenUnit(serial, policyGroup(sourceFromQuery(req.body?.source)), req.user.id, reason.slice(0, 500));
    res.status(204).end();
  }));

  // ---------- run reservations ----------

  /**
   * Reserves a test run before the station touches the board. The retest policy is
   * checked and the reservation stored in one transaction, so two stations cannot
   * both start the last allowed attempt.
   */
  app.post('/api/runs', operator, wrap(async (req, res) => {
    const { production, recipe } = await ready;
    const b = req.body ?? {};
    const errors = [];
    if (!UUID_RE.test(String(b.runId ?? ''))) errors.push('runId bir UUID olmalı');
    if (!(b.transport in SOURCE_FOR_TRANSPORT)) errors.push('transport webserial, server veya simulator olmalı');
    else if (b.source !== SOURCE_FOR_TRANSPORT[b.transport]) errors.push(`${b.transport} bağlantısının kaynağı ${SOURCE_FOR_TRANSPORT[b.transport]} olmalı`);
    const code = String(b.productCode ?? '').toUpperCase();
    const product = code ? getProduct(code) : null;
    if (!product) errors.push('Ürün bulunamadı veya yayınlanmamış');
    const serial = recipe.normalizeSerial(b.serial);
    if (product) {
      const serialError = recipe.validateSerial(serial, product.serialMask);
      if (serialError) errors.push(serialError);
    }
    if (errors.length) return fail(res, 400, errors);

    if (product.archived) return fail(res, 409, 'Ürün arşivlenmiş', { code: 'ARCHIVED' });
    if (Number(b.recipeRevision) !== product.revision) {
      return fail(res, 409, `Reçete güncellendi (yayındaki revizyon ${product.revision}); istasyonu yenileyin`, { code: 'REVISION_OUTDATED', revision: product.revision });
    }
    if (b.source === 'hardware' && calibrationExpired()) {
      return fail(res, 409, `İstasyon kalibrasyonunun süresi dolmuş (${station.calibration.due}); gerçek kart test edilemez`, { code: 'CALIBRATION_EXPIRED' });
    }
    if (b.transport === 'server') {
      // The station must hold this server's port lock, so the run really uses this fixture
      if (!bridge.state.connected || bridge.state.lock?.userId !== req.user.id) {
        return fail(res, 409, 'Sunucu portu açık değil veya bu kullanıcı tarafından kilitlenmemiş', { code: 'PORT_NOT_LOCKED' });
      }
    }

    const existing = db.getReservation(b.runId);
    if (existing) {
      const same = existing.serial === serial && existing.product_code === code && existing.user_id === req.user.id;
      if (!same) return fail(res, 409, 'Bu runId başka bir test için kullanılmış', { code: 'RUN_ID_TAKEN' });
      return res.json({ runId: b.runId, reused: true });
    }

    const group = policyGroup(b.source);
    const decision = db.transaction(() => {
      const verdict = production.checkRetestPolicy({
        history: db.unitHistory(serial, group),
        product,
        openReservations: db.openReservations(serial, group),
        retestReason: b.retestReason,
      });
      if (!verdict.allowed) return verdict;
      for (const stale of verdict.abandon) db.closeReservation(stale.run_id, 'abandoned');
      db.insertReservation({
        runId: b.runId,
        serial,
        productCode: code,
        recipeRevision: product.revision,
        source: b.source,
        transport: b.transport,
        userId: req.user.id,
        station: station.id,
        retestReason: b.retestReason ? String(b.retestReason).slice(0, 500) : null,
      });
      if (b.retestReason) db.audit(req.user.id, 'unit.retest-after-pass', 'unit', serial, { reason: String(b.retestReason).slice(0, 500), runId: b.runId });
      return verdict;
    });
    if (!decision.allowed) {
      // Say who holds the unit, so its owner or an engineer can release an interrupted run
      const holders = decision.code === 'IN_PROGRESS' ? db.openReservations(serial, group).filter((r) => !decision.abandon.some((s) => s.run_id === r.run_id)) : [];
      const reservations = holders.map((r) => ({ runId: r.run_id, userId: r.user_id, user: db.getUser(r.user_id)?.displayName ?? null, station: r.station, createdAt: r.created_at }));
      return fail(res, 409, decision.reason, { code: decision.code, unit: decision.status, reservations });
    }
    res.status(201).json({ runId: b.runId, attempt: decision.status.attempts + 1, unit: decision.status, station });
  }));

  app.post('/api/runs/:runId/abandon', operator, wrap(async (req, res) => {
    const r = db.getReservation(req.params.runId);
    if (!r) return fail(res, 404, 'Rezervasyon bulunamadı');
    if (r.user_id !== req.user.id && !auth.hasRole(req.user, 'engineer')) return fail(res, 403, 'Başkasının rezervasyonu');
    if (r.status === 'open') {
      db.transaction(() => {
        db.closeReservation(req.params.runId, 'abandoned');
        db.audit(req.user.id, 'reservation.abandon', 'unit', r.serial, { runId: r.run_id, owner: r.user_id, station: r.station });
      });
    }
    res.status(204).end();
  }));

  // ---------- results ----------

  /**
   * Stores a finished run. Idempotent by runId: resending the same run (e.g. from the
   * station's outbox after a lost response) returns the stored record instead of a
   * second attempt; a different payload under the same runId is a 409.
   */
  app.post('/api/tests', operator, wrap(async (req, res) => {
    const { production } = await ready;
    const b = req.body ?? {};
    if (!UUID_RE.test(String(b.runId ?? ''))) return fail(res, 400, 'runId bir UUID olmalı');
    const digest = sha256(production.submissionDigestInput(b));

    const stored = db.getByRunId(b.runId);
    if (stored) {
      if (stored.payloadHash !== digest) return fail(res, 409, 'Bu runId ile farklı içerikte bir sonuç zaten kayıtlı', { code: 'RUN_CONFLICT', id: stored.record.id });
      return res.status(200).json({ ...stored.record, duplicate: true });
    }

    const reservation = db.getReservation(b.runId);
    if (!reservation) return fail(res, 409, 'Bu test için rezervasyon yok; sonuç kabul edilmedi', { code: 'NO_RESERVATION' });
    const mismatch = [
      ['serial', reservation.serial, String(b.serial ?? '').trim().toUpperCase()],
      ['productCode', reservation.product_code, String(b.productCode ?? '').toUpperCase()],
      ['recipeRevision', reservation.recipe_revision, Number(b.recipeRevision)],
      ['source', reservation.source, b.source],
      ['transport', reservation.transport, b.transport],
    ].filter(([, a, c]) => a !== c);
    if (mismatch.length) return fail(res, 409, `Sonuç rezervasyonla uyuşmuyor: ${mismatch.map(([k]) => k).join(', ')}`, { code: 'RESERVATION_MISMATCH' });
    if (reservation.user_id !== req.user.id) return fail(res, 403, 'Rezervasyon başka bir kullanıcıya ait');

    const product = getProduct(reservation.product_code, reservation.recipe_revision);
    const { errors, value } = production.prepareTestRecord({ ...b, operator: req.user.displayName }, product);
    if (errors.length) return fail(res, 400, errors);

    const id = db.transaction(() => {
      if (db.getByRunId(b.runId)) return null; // a concurrent resend won the race
      const newId = db.insert(value, {
        runId: b.runId,
        payloadHash: digest,
        source: reservation.source,
        transport: reservation.transport,
        station: { ...station, calibrationExpired: calibrationExpired() },
        userId: req.user.id,
        log: production.cleanLog(b.log),
        retestReason: reservation.retest_reason,
      });
      db.closeReservation(b.runId, 'completed');
      return newId;
    });
    if (id === null) return res.status(200).json({ ...db.getByRunId(b.runId).record, duplicate: true });
    res.status(201).json(db.get(id));
  }));

  function parseFilters(query) {
    const errors = [];
    const filters = {};
    if (query.serial) filters.serial = String(query.serial).trim().toUpperCase().slice(0, 40);
    if (query.product) filters.product = String(query.product).trim().toUpperCase().slice(0, 24);
    if (query.result) {
      if (!['PASS', 'FAIL', 'ERROR'].includes(query.result)) errors.push('Geçersiz sonuç filtresi');
      else filters.result = query.result;
    }
    filters.source = query.source ?? 'production';
    if (!LIST_SOURCES.includes(filters.source)) errors.push(`source ${LIST_SOURCES.join(', ')} olmalı`);
    for (const key of ['from', 'to']) {
      if (!query[key]) continue;
      const time = Date.parse(query[key]);
      if (Number.isNaN(time)) errors.push(`Geçersiz tarih: ${key}`);
      else filters[key] = new Date(time).toISOString();
    }
    return { filters, errors };
  }

  function parsePage(query) {
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    const errors = [];
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) errors.push(`limit 1–${MAX_PAGE} arasında olmalı`);
    if (!Number.isInteger(offset) || offset < 0) errors.push('offset geçersiz');
    return { page: { limit, offset }, errors };
  }

  app.get('/api/tests', operator, (req, res) => {
    const { filters, errors } = parseFilters(req.query);
    const { page, errors: pageErrors } = parsePage(req.query);
    if (errors.length || pageErrors.length) return fail(res, 400, [...errors, ...pageErrors]);
    res.json(db.list(filters, page));
  });

  /**
   * Streams the CSV in batches with backpressure and yields to the event loop between
   * batches, so a large export neither holds every row in memory nor blocks the serial bridge.
   */
  app.get('/api/tests/export.csv', operator, wrap(async (req, res) => {
    const { production } = await ready;
    const { filters, errors } = parseFilters(req.query);
    if (errors.length) return fail(res, 400, errors);
    const columns = production.csvColumns(db.measurementColumns(filters));
    const timeZone = production.validTimeZone(req.query.tz) ?? SERVER_TIME_ZONE;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.type('text/csv; charset=utf-8');
    res.attachment(`test-raporu-${stamp}.csv`);
    // BOM so Excel opens Turkish characters correctly
    res.write('\uFEFF' + production.csvHeader(columns) + '\n');
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const ok = res.write(batch.join('\n') + '\n');
      batch = [];
      if (!ok) await new Promise((resolve) => res.once('drain', resolve));
      await new Promise((resolve) => setImmediate(resolve));
    };
    for (const record of db.iterate(filters)) {
      if (res.destroyed) return;
      batch.push(production.csvRow(record, columns, { timeZone }));
      if (batch.length >= 250) await flush();
    }
    await flush();
    res.end();
  }));

  app.get('/api/tests/:id', operator, (req, res) => {
    const record = db.get(Number(req.params.id));
    if (!record) return fail(res, 404, 'Kayıt bulunamadı');
    res.json(record);
  });

  // ---------- reports ----------

  app.get('/api/reports', operator, wrap(async (req, res) => {
    const { production } = await ready;
    const { filters, errors } = parseFilters(req.query);
    if (errors.length) return fail(res, 400, errors);
    const timeZone = production.validTimeZone(req.query.tz) ?? SERVER_TIME_ZONE;
    const r = db.report(filters);
    const counts = {};
    const days = new Map();
    for (const b of r.buckets) {
      counts[b.product] ??= { PASS: 0, FAIL: 0, ERROR: 0 };
      counts[b.product][b.result] += b.n;
      const key = JSON.stringify([production.dayKey(`${b.bucket}:00.000Z`, timeZone), b.product, b.result]);
      days.set(key, (days.get(key) ?? 0) + b.n);
    }
    const daily = [...days]
      .map(([key, n]) => {
        const [day, product, result] = JSON.parse(key);
        return { day, product, result, n };
      })
      .sort((a, b) => a.day.localeCompare(b.day));
    res.json({
      products: r.units.map((u) => production.yields(u, counts[u.product] ?? {})),
      daily,
      pareto: r.pareto,
      measurements: r.measurementKeys,
      timeZone,
    });
  }));

  app.get('/api/reports/measurement', operator, wrap(async (req, res) => {
    const { production } = await ready;
    const { filters, errors } = parseFilters(req.query);
    const product = String(req.query.product ?? '').toUpperCase();
    const key = String(req.query.key ?? '');
    if (!product || !key) errors.push('product ve key zorunlu');
    if (errors.length) return fail(res, 400, errors);
    const rows = db.measurementValues(filters, product, key);
    const limitSets = new Set(rows.map((r) => `${r.min}|${r.max}`));
    const limits = limitSets.size === 1 ? { min: rows[0].min, max: rows[0].max } : null;
    const modes = [...new Set(rows.map((r) => r.mode))];
    const result = production.capability(rows.map((r) => r.value), limits);
    if (modes.length > 1) result.notes.push(`Farklı değerlendirme modları karışık: ${modes.join(', ')}`);
    res.json({ product, key, limits, modes, revisions: [...new Set(rows.map((r) => r.revision))], ...result });
  }));

  // ---------- audit and administration ----------

  app.get('/api/audit', engineer, (req, res) => {
    res.json(db.listAudit({ entity: req.query.entity, entityId: req.query.entityId, limit: Math.min(Number(req.query.limit) || 100, 500) }));
  });

  /** Consistent online backup (VACUUM INTO): safe while the server is running, WAL included. */
  app.get('/api/admin/backup', admin, (req, res, next) => {
    const file = path.join(os.tmpdir(), `pcba-test-station-backup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
    try {
      db.backupTo(file);
    } catch (err) {
      return next(err);
    }
    db.audit(req.user.id, 'backup', 'database', null);
    res.download(file, `pcba-test-station-${new Date().toISOString().slice(0, 10)}.db`, () => fs.rm(file, { force: true }, () => {}));
  });
}

module.exports = { mountApi };
