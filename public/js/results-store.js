// ============================================
// STORES — products, reservations and production test results
//
//   ServerStore: SQLite through server.js (REST, session cookie). The server is
//                the authority: retest policy, idempotent saves, roles.
//   LocalStore:  IndexedDB for the static GitHub Pages demo / offline use. Same
//                rules, applied in this browser only — it cannot give a central
//                guarantee (another browser has its own history) and has no users.
//
// Both expose the same methods so the UI does not care which one it talks to.
// ============================================

import { DEFAULT_PRODUCTS, validateProduct, withDefaults, normalizeSerial, validateSerial } from './recipe.js';
import {
  prepareTestRecord,
  filterRecords,
  summarize,
  resultsToCsv,
  unitStatus,
  cleanLog,
  checkRetestPolicy,
  policyGroup,
  submissionDigestInput,
  yields,
  capability,
  SOURCE_FILTERS,
} from './production.js';
import { LocalDb, promisify } from './local-db.js';

export class StoreError extends Error {
  constructor(message, { status = null, code = null, permanent = false, details = null } = {}) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
    this.code = code;
    this.permanent = permanent; // retrying the same request will fail the same way
    this.details = details;
  }
}

function download(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toQueryString(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
  return q.toString();
}

const SOURCE_FOR_TRANSPORT = { simulator: 'simulation', webserial: 'hardware', server: 'hardware' };

// ---------------------------------------------------------------------------
// Server store
// ---------------------------------------------------------------------------

export class ServerStore {
  kind = 'sqlite';
  requiresAuth = true;

  constructor({ onUnauthenticated = () => {} } = {}) {
    this.onUnauthenticated = onUnauthenticated;
  }

  async call(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        // A hanging server must not keep the station in SAVING; the outbox retries later
        signal: AbortSignal.timeout(15000),
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new StoreError('Sunucuya ulaşılamadı', { permanent: false });
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    if (res.status === 401) this.onUnauthenticated();
    throw new StoreError(data.errors?.join(' · ') || `HTTP ${res.status}`, {
      status: res.status,
      code: data.code ?? (res.status === 401 ? 'UNAUTHENTICATED' : null),
      // 4xx are answers about the request itself; 401 (expired session) and 429 can succeed later
      permanent: res.status >= 400 && res.status < 500 && ![401, 408, 429].includes(res.status),
      details: data,
    });
  }

  // auth & users
  authState = () => this.call('GET', 'api/auth/state');
  login = (username, password) => this.call('POST', 'api/auth/login', { username, password });
  logout = () => this.call('POST', 'api/auth/logout', {});
  setup = (body) => this.call('POST', 'api/auth/setup', body);
  changePassword = (currentPassword, newPassword) => this.call('POST', 'api/auth/password', { currentPassword, newPassword });
  listUsers = () => this.call('GET', 'api/users');
  createUser = (user) => this.call('POST', 'api/users', user);
  updateUser = (id, patch) => this.call('PATCH', `api/users/${id}`, patch);
  station = () => this.call('GET', 'api/station');

  // products
  listProducts = ({ drafts = false, archived = false } = {}) => this.call('GET', `api/products?${toQueryString({ drafts: drafts ? 1 : '', archived: archived ? 1 : '' })}`);
  getProduct = (code, revision) => this.call('GET', `api/products/${encodeURIComponent(code)}${revision === undefined ? '' : `?revision=${revision}`}`);
  getDraft = (code) => this.call('GET', `api/products/${encodeURIComponent(code)}/draft`).catch((err) => (err.status === 404 ? null : Promise.reject(err)));
  listRevisions = (code) => this.call('GET', `api/products/${encodeURIComponent(code)}/revisions`);
  saveDraft = (definition, note) => this.call('PUT', `api/products/${encodeURIComponent(definition.code)}/draft`, { definition, note });
  discardDraft = (code) => this.call('DELETE', `api/products/${encodeURIComponent(code)}/draft`);
  publish = (code, note) => this.call('POST', `api/products/${encodeURIComponent(code)}/publish`, { note });
  archive = (code, reason) => this.call('POST', `api/products/${encodeURIComponent(code)}/archive`, { reason });
  restore = (code) => this.call('POST', `api/products/${encodeURIComponent(code)}/restore`, {});

  // units, reservations, results
  unitStatus = (serial, productCode, source) => this.call('GET', `api/units/${encodeURIComponent(serial)}?${toQueryString({ product: productCode, source })}`);
  reopenUnit = (serial, reason, source) => this.call('POST', `api/units/${encodeURIComponent(serial)}/reopen`, { reason, source });
  reserve = (reservation) => this.call('POST', 'api/runs', reservation);
  abandon = (runId) => this.call('POST', `api/runs/${runId}/abandon`, {}).catch(() => {});
  saveRun = (submission) => this.call('POST', 'api/tests', submission);
  query = (filters = {}, page = {}) => this.call('GET', `api/tests?${toQueryString({ ...filters, ...page })}`);
  getRun = (id) => this.call('GET', `api/tests/${id}`);
  report = (filters = {}) => this.call('GET', `api/reports?${toQueryString(filters)}`);
  measurementReport = (filters, product, key) => this.call('GET', `api/reports/measurement?${toQueryString({ ...filters, product, key })}`);
  audit = (params = {}) => this.call('GET', `api/audit?${toQueryString(params)}`);

  exportCsv(filters = {}) {
    // The server streams the file with Content-Disposition: attachment
    Object.assign(document.createElement('a'), { href: `api/tests/export.csv?${toQueryString(filters)}` }).click();
  }

  backup() {
    Object.assign(document.createElement('a'), { href: 'api/admin/backup' }).click();
  }
}

// ---------------------------------------------------------------------------
// Local (IndexedDB) store
// ---------------------------------------------------------------------------

async function digest(text) {
  if (globalThis.crypto?.subtle) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return text; // no SubtleCrypto (insecure context): compare the canonical text itself
}

const LOCAL_USER = 'Bu tarayıcı';

function productView(entry, code, revision) {
  const rev = entry.revisions[revision];
  if (!rev) return null;
  return {
    ...withDefaults(rev.definition),
    revision: Number(revision),
    status: rev.status,
    archived: entry.archived,
    createdAt: rev.createdAt,
    createdBy: LOCAL_USER,
    note: rev.note,
    publishedAt: rev.publishedAt ?? null,
    publishedBy: rev.publishedAt ? LOCAL_USER : null,
    draftRevision: entry.draft,
  };
}

function seedProducts() {
  const now = new Date().toISOString();
  return Object.fromEntries(
    DEFAULT_PRODUCTS.map((p) => {
      const definition = validateProduct(p).product;
      return [definition.code, { revision: 1, published: 1, draft: null, archived: false, revisions: { 1: { definition, status: 'published', createdAt: now, publishedAt: now, note: 'Varsayılan ürün' } } }];
    })
  );
}

export class LocalStore {
  kind = 'local';
  requiresAuth = false;

  constructor({ db = new LocalDb() } = {}) {
    this.db = db;
  }

  async init() {
    await this.db.open();
    // Results live only here: ask the browser not to evict them under storage pressure
    this.db.requestPersistence().catch(() => {});
    await this.db.tx(['kv'], 'readwrite', async (s) => {
      if (!(await promisify(s.kv.get('products')))) await promisify(s.kv.put({ key: 'products', value: seedProducts() }));
    });
    return this;
  }

  onChange(fn) {
    return this.db.onChange(fn);
  }

  async products(s) {
    return (await promisify(s.kv.get('products')))?.value ?? seedProducts();
  }

  async audit(params = {}) {
    const all = await this.db.getAll('audit');
    return all
      .filter((a) => (!params.entity || a.entity === params.entity) && (!params.entityId || a.entityId === params.entityId))
      .reverse()
      .slice(0, params.limit ?? 100);
  }

  addAudit(s, action, entity, entityId, detail) {
    return promisify(s.audit.add({ at: new Date().toISOString(), user: LOCAL_USER, action, entity, entityId, detail }));
  }

  // ---------- products ----------

  async listProducts({ drafts = false, archived = false } = {}) {
    const products = await this.db.tx('kv', 'readonly', (s) => this.products(s));
    return Object.keys(products)
      .sort()
      .map((code) => [code, products[code]])
      .filter(([, e]) => (archived || !e.archived) && (e.published || (drafts && e.draft)))
      .map(([code, e]) => productView(e, code, e.published ?? e.draft));
  }

  async getProduct(code, revision) {
    const products = await this.db.tx('kv', 'readonly', (s) => this.products(s));
    const entry = products[code];
    const rev = revision ?? entry?.published;
    const view = entry && rev ? productView(entry, code, rev) : null;
    if (!view) throw new StoreError('Ürün bulunamadı', { status: 404, permanent: true });
    return view;
  }

  async getDraft(code) {
    const products = await this.db.tx('kv', 'readonly', (s) => this.products(s));
    const entry = products[code];
    return entry?.draft ? productView(entry, code, entry.draft) : null;
  }

  async listRevisions(code) {
    const products = await this.db.tx('kv', 'readonly', (s) => this.products(s));
    const entry = products[code];
    if (!entry) return { revisions: [], audit: [] };
    const revisions = Object.entries(entry.revisions)
      .map(([n, r]) => ({ revision: Number(n), status: r.status, createdAt: r.createdAt, createdBy: LOCAL_USER, note: r.note, publishedAt: r.publishedAt ?? null, definition: r.definition }))
      .sort((a, b) => b.revision - a.revision);
    return { revisions, audit: await this.audit({ entity: 'product', entityId: code }) };
  }

  async mutateProducts(fn) {
    return this.db.tx(['kv', 'audit'], 'readwrite', async (s) => {
      const products = await this.products(s);
      const result = await fn(products, s);
      await promisify(s.kv.put({ key: 'products', value: products }));
      return result;
    });
  }

  async saveDraft(input, note = null) {
    const { product: definition, errors } = validateProduct(input);
    if (errors.length) throw new StoreError(errors.join(' · '), { status: 400, permanent: true, details: { errors } });
    return this.mutateProducts(async (products, s) => {
      const now = new Date().toISOString();
      const entry = products[definition.code];
      if (!entry) {
        products[definition.code] = { revision: 1, published: null, draft: 1, archived: false, revisions: { 1: { definition, status: 'draft', createdAt: now, note } } };
        await this.addAudit(s, 'draft.create', 'product', definition.code, { revision: 1, note });
        return { product: productView(products[definition.code], definition.code, 1) };
      }
      const publishedJson = entry.published ? JSON.stringify(entry.revisions[entry.published].definition) : null;
      if (!entry.draft && publishedJson === JSON.stringify(definition)) return { product: productView(entry, definition.code, entry.published), unchanged: true };
      if (!entry.draft) {
        entry.revision += 1;
        entry.draft = entry.revision;
      }
      entry.revisions[entry.draft] = { definition, status: 'draft', createdAt: now, note };
      await this.addAudit(s, 'draft.save', 'product', definition.code, { revision: entry.draft, note });
      return { product: productView(entry, definition.code, entry.draft) };
    });
  }

  async discardDraft(code) {
    return this.mutateProducts(async (products, s) => {
      const entry = products[code];
      if (!entry?.draft) throw new StoreError('Taslak yok', { status: 404, permanent: true });
      delete entry.revisions[entry.draft];
      if (!entry.published) delete products[code];
      else {
        entry.revision = entry.draft - 1;
        entry.draft = null;
      }
      await this.addAudit(s, 'draft.discard', 'product', code, {});
    });
  }

  async publish(code, note) {
    if (!String(note ?? '').trim()) throw new StoreError('Yayın notu (neyi neden değiştirdiniz) zorunlu', { status: 400, permanent: true });
    return this.mutateProducts(async (products, s) => {
      const entry = products[code];
      if (!entry?.draft) throw new StoreError('Yayınlanacak taslak yok', { status: 409, permanent: true });
      const now = new Date().toISOString();
      if (entry.published) entry.revisions[entry.published].status = 'superseded';
      Object.assign(entry.revisions[entry.draft], { status: 'published', publishedAt: now, note });
      await this.addAudit(s, 'publish', 'product', code, { revision: entry.draft, previous: entry.published, note });
      entry.published = entry.draft;
      entry.draft = null;
      entry.archived = false;
      return productView(entry, code, entry.published);
    });
  }

  async archive(code, reason) {
    if (!String(reason ?? '').trim()) throw new StoreError('Arşivleme gerekçesi zorunlu', { status: 400, permanent: true });
    return this.mutateProducts(async (products, s) => {
      if (!products[code]) throw new StoreError('Ürün bulunamadı', { status: 404, permanent: true });
      products[code].archived = true;
      await this.addAudit(s, 'archive', 'product', code, { reason });
    });
  }

  async restore(code) {
    return this.mutateProducts(async (products, s) => {
      if (!products[code]) throw new StoreError('Ürün bulunamadı', { status: 404, permanent: true });
      products[code].archived = false;
      await this.addAudit(s, 'restore', 'product', code, {});
    });
  }

  // ---------- units, reservations ----------

  async history(s, serial, group) {
    const sources = SOURCE_FILTERS[group === 'simulation' ? 'simulation' : 'production'];
    const runs = (await promisify(s.runs.index('serial').getAll(serial))).filter((r) => sources.includes(r.source ?? 'unknown'));
    const events = (await promisify(s.unitEvents.index('serial').getAll(serial))).filter((e) => e.policyGroup === group);
    const reservations = (await promisify(s.reservations.index('serial').getAll(serial))).filter((r) => r.status === 'open' && policyGroup(r.source) === group);
    return {
      history: {
        results: runs.map((r) => ({ result: r.result, finishedAt: r.finishedAt, productCode: r.productCode })),
        reopenedAt: events.length ? events.map((e) => e.at).sort().at(-1) : null,
        ownerProduct: [...runs].sort((a, b) => a.id - b.id).find((r) => r.productCode)?.productCode ?? null,
      },
      reservations,
      events,
    };
  }

  async unitStatus(serial, productCode, source = 'hardware') {
    const normalized = normalizeSerial(serial);
    const group = policyGroup(source);
    return this.db.tx(['runs', 'unitEvents', 'reservations', 'kv'], 'readonly', async (s) => {
      const { history, reservations, events } = await this.history(s, normalized, group);
      const products = await this.products(s);
      const entry = products[productCode];
      const maxAttempts = entry?.published ? entry.revisions[entry.published].definition.maxAttempts : Infinity;
      return {
        serial: normalized,
        policyGroup: group,
        ownerProduct: history.ownerProduct,
        ...unitStatus(history.results, maxAttempts, { reopenedAt: history.reopenedAt }),
        openReservations: reservations.length,
        events: events.map((e) => ({ kind: e.kind, policyGroup: e.policyGroup, reason: e.reason, user: LOCAL_USER, at: e.at })),
      };
    });
  }

  async reopenUnit(serial, reason, source = 'hardware') {
    if (String(reason ?? '').trim().length < 5) throw new StoreError('Onarım / yeniden açma gerekçesi en az 5 karakter olmalı', { status: 400, permanent: true });
    const normalized = normalizeSerial(serial);
    await this.db.tx(['unitEvents', 'audit'], 'readwrite', async (s) => {
      await promisify(s.unitEvents.add({ serial: normalized, policyGroup: policyGroup(source), kind: 'reopen', reason, at: new Date().toISOString() }));
      await this.addAudit(s, 'unit.reopen', 'unit', normalized, { reason });
    });
  }

  /** Same checks as POST /api/runs, atomically within this browser. */
  async reserve(r) {
    const serial = normalizeSerial(r.serial);
    if (r.source !== SOURCE_FOR_TRANSPORT[r.transport]) throw new StoreError('Kaynak ve bağlantı tipi uyuşmuyor', { status: 400, permanent: true });
    return this.db.tx(['runs', 'unitEvents', 'reservations', 'kv', 'audit'], 'readwrite', async (s) => {
      const products = await this.products(s);
      const entry = products[r.productCode];
      if (!entry?.published) throw new StoreError('Ürün bulunamadı veya yayınlanmamış', { status: 400, permanent: true });
      if (entry.archived) throw new StoreError('Ürün arşivlenmiş', { status: 409, code: 'ARCHIVED', permanent: true });
      if (Number(r.recipeRevision) !== entry.published) {
        throw new StoreError(`Reçete güncellendi (yayındaki revizyon ${entry.published})`, { status: 409, code: 'REVISION_OUTDATED', permanent: true });
      }
      const product = productView(entry, r.productCode, entry.published);
      const serialError = validateSerial(serial, product.serialMask);
      if (serialError) throw new StoreError(serialError, { status: 400, permanent: true });
      const existing = await promisify(s.reservations.get(r.runId));
      if (existing) return { runId: r.runId, reused: true };

      const group = policyGroup(r.source);
      const { history, reservations } = await this.history(s, serial, group);
      const verdict = checkRetestPolicy({ history, product, openReservations: reservations.map((x) => ({ ...x, created_at: x.createdAt })), retestReason: r.retestReason });
      if (!verdict.allowed) throw new StoreError(verdict.reason, { status: 409, code: verdict.code, permanent: true, details: { unit: verdict.status } });
      for (const stale of verdict.abandon) await promisify(s.reservations.put({ ...stale, status: 'abandoned' }));
      await promisify(s.reservations.put({ runId: r.runId, serial, productCode: r.productCode, recipeRevision: entry.published, source: r.source, transport: r.transport, retestReason: r.retestReason ?? null, status: 'open', createdAt: new Date().toISOString() }));
      if (r.retestReason) await this.addAudit(s, 'unit.retest-after-pass', 'unit', serial, { reason: r.retestReason, runId: r.runId });
      return { runId: r.runId, attempt: verdict.status.attempts + 1, unit: verdict.status };
    });
  }

  async abandon(runId) {
    await this.db.tx('reservations', 'readwrite', async (s) => {
      const r = await promisify(s.reservations.get(runId));
      if (r?.status === 'open') await promisify(s.reservations.put({ ...r, status: 'abandoned' }));
    });
  }

  /** Same contract as POST /api/tests: idempotent by runId, verdict evaluated here from raw data. */
  async saveRun(sub) {
    const hash = await digest(submissionDigestInput(sub));
    return this.db.tx(['runs', 'reservations', 'kv'], 'readwrite', async (s) => {
      const stored = await promisify(s.runs.index('runId').get(sub.runId));
      if (stored) {
        if (stored.payloadHash !== hash) throw new StoreError('Bu runId ile farklı içerikte bir sonuç zaten kayıtlı', { status: 409, code: 'RUN_CONFLICT', permanent: true });
        return { ...stored, duplicate: true };
      }
      const reservation = await promisify(s.reservations.get(sub.runId));
      if (!reservation) throw new StoreError('Bu test için rezervasyon yok', { status: 409, code: 'NO_RESERVATION', permanent: true });
      const products = await this.products(s);
      const entry = products[reservation.productCode];
      const product = entry ? productView(entry, reservation.productCode, reservation.recipeRevision) : null;
      const { errors, value } = prepareTestRecord(sub, product);
      if (errors.length) throw new StoreError(errors.join(' · '), { status: 400, permanent: true });
      const group = policyGroup(reservation.source);
      const sources = SOURCE_FILTERS[group === 'simulation' ? 'simulation' : 'production'];
      const earlier = (await promisify(s.runs.index('serial').getAll(value.serial))).filter((r) => sources.includes(r.source ?? 'unknown'));
      const record = {
        ...value,
        runId: sub.runId,
        payloadHash: hash,
        attempt: earlier.length + 1,
        source: reservation.source,
        transport: reservation.transport,
        retestReason: reservation.retestReason,
        station: { id: 'tarayıcı', fixture: null, calibration: null, appVersion: sub.appVersion ?? null },
        log: cleanLog(sub.log),
      };
      record.id = await promisify(s.runs.add(record));
      await promisify(s.reservations.put({ ...reservation, status: 'completed' }));
      return record;
    });
  }

  async allRuns() {
    return this.db.getAll('runs');
  }

  async query(filters = {}, { limit = 50, offset = 0 } = {}) {
    const matching = filterRecords(await this.allRuns(), { source: 'production', ...filters }).sort(
      (a, b) => b.finishedAt.localeCompare(a.finishedAt) || b.id - a.id
    );
    const stats = summarize(matching);
    const items = matching.slice(offset, offset + limit).map(({ steps, teardown, log, measurements, payloadHash, ...summary }) => {
      void steps, teardown, log, measurements, payloadHash;
      return summary;
    });
    return { items, total: stats.total, limit, offset, stats };
  }

  async getRun(id) {
    const run = await this.db.get('runs', Number(id));
    if (!run) throw new StoreError('Kayıt bulunamadı', { status: 404, permanent: true });
    return run;
  }

  async exportCsv(filters = {}) {
    const matching = filterRecords(await this.allRuns(), { source: 'production', ...filters }).sort((a, b) => a.id - b.id);
    download('﻿' + resultsToCsv(matching), `test-raporu-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8');
  }

  /** Same shape as GET /api/reports. */
  async report(filters = {}) {
    const runs = filterRecords(await this.allRuns(), { source: 'production', ...filters });
    const dailyMap = new Map();
    const byProduct = new Map();
    const pareto = new Map();
    const keys = new Map();
    for (const r of runs) {
      const day = r.finishedAt.slice(0, 10);
      const dk = `${day}|${r.productCode}|${r.result}`;
      dailyMap.set(dk, (dailyMap.get(dk) ?? 0) + 1);
      const p = byProduct.get(r.productCode) ?? { product: r.productCode, tests: 0, retests: 0, serials: new Set(), passed: new Set(), firstAttemptUnits: 0, firstPass: 0, counts: { PASS: 0, FAIL: 0, ERROR: 0 } };
      p.tests += 1;
      if (r.attempt > 1) p.retests += 1;
      p.serials.add(r.serial);
      if (r.result === 'PASS') p.passed.add(r.serial);
      if (r.attempt === 1) {
        p.firstAttemptUnits += 1;
        if (r.result === 'PASS') p.firstPass += 1;
      }
      p.counts[r.result] += 1;
      byProduct.set(r.productCode, p);
      if (r.result !== 'PASS') {
        const cause = r.reason?.includes(':') ? r.reason.slice(0, r.reason.indexOf(':')) : r.reason ?? '—';
        const pk = `${r.result}|${cause}`;
        pareto.set(pk, (pareto.get(pk) ?? 0) + 1);
      }
      for (const m of r.measurements ?? []) {
        if (!['PASS', 'FAIL'].includes(m.status) || m.value === null) continue;
        const kk = `${r.productCode}|${m.key}`;
        const k = keys.get(kk) ?? { product: r.productCode, key: m.key, name: m.name, unit: m.unit, n: 0 };
        k.n += 1;
        keys.set(kk, k);
      }
    }
    return {
      products: [...byProduct.values()]
        .sort((a, b) => String(a.product).localeCompare(String(b.product)))
        .map((p) => yields({ product: p.product, tests: p.tests, retests: p.retests, units: p.serials.size, unitsPassed: p.passed.size, firstAttemptUnits: p.firstAttemptUnits, firstPass: p.firstPass }, p.counts)),
      daily: [...dailyMap.entries()].map(([k, n]) => {
        const [day, product, result] = k.split('|');
        return { day, product, result, n };
      }).sort((a, b) => a.day.localeCompare(b.day)),
      pareto: [...pareto.entries()].map(([k, n]) => {
        const [result, ...cause] = k.split('|');
        return { result, cause: cause.join('|'), n };
      }).sort((a, b) => b.n - a.n).slice(0, 20),
      measurements: [...keys.values()],
    };
  }

  async measurementReport(filters, product, key) {
    const rows = filterRecords(await this.allRuns(), { source: 'production', ...filters, product })
      .flatMap((r) => (r.measurements ?? []).filter((m) => m.key === key && ['PASS', 'FAIL'].includes(m.status) && m.value !== null).map((m) => ({ ...m, revision: r.recipeRevision })));
    const limitSets = new Set(rows.map((r) => `${r.min}|${r.max}`));
    const limits = limitSets.size === 1 ? { min: rows[0].min, max: rows[0].max } : null;
    const modes = [...new Set(rows.map((r) => r.mode ?? 'mean'))];
    const result = capability(rows.map((r) => r.value), limits);
    if (modes.length > 1) result.notes.push(`Farklı değerlendirme modları karışık: ${modes.join(', ')}`);
    return { product, key, limits, modes, revisions: [...new Set(rows.map((r) => r.revision))], ...result };
  }

  // ---------- storage management (no silent deletion) ----------

  async storageInfo() {
    const [runs, outbox, estimate] = await Promise.all([this.db.count('runs'), this.db.count('outbox'), this.db.estimate()]);
    return { runs, outbox, ...estimate };
  }

  async exportAll() {
    const [runs, products, events, audit] = await Promise.all([this.allRuns(), this.db.get('kv', 'products'), this.db.getAll('unitEvents'), this.db.getAll('audit')]);
    download(JSON.stringify({ exportedAt: new Date().toISOString(), runs, products: products?.value ?? null, unitEvents: events, audit }, null, 2), `serial-viewer-yedek-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  }

  /** Explicit clean-up the user asked for (after exporting): deletes runs finished before `before`. */
  async deleteRunsBefore(before) {
    return this.db.tx(['runs', 'audit'], 'readwrite', async (s) => {
      const old = await promisify(s.runs.index('finishedAt').getAllKeys(IDBKeyRange.upperBound(before, true)));
      for (const id of old) await promisify(s.runs.delete(id));
      await this.addAudit(s, 'runs.delete', 'runs', null, { before, count: old.length });
      return old.length;
    });
  }
}
