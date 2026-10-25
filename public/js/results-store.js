// ============================================
// STORES — products and production test results
//   ServerStore: SQLite through server.js (/api/products, /api/tests, /api/units)
//   LocalStore:  browser storage for the static GitHub Pages demo; same
//                validation, revisioning and retest policy as the server
// ============================================

import { DEFAULT_PRODUCTS, validateProduct, normalizeSerial } from './recipe.js';
import { prepareTestRecord, filterRecords, summarize, resultsToCsv, unitStatus, cleanLog } from './production.js';

function downloadText(text, filename) {
  const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toQueryString(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, value);
  }
  return params.toString();
}

async function readJson(res) {
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.errors?.join(' · ') || `HTTP ${res.status}`);
  return body;
}

export class ServerStore {
  kind = 'sqlite';

  async listProducts() {
    return readJson(await fetch('api/products', { cache: 'no-store' }));
  }

  async getProduct(code, revision) {
    const qs = revision === undefined ? '' : `?revision=${revision}`;
    return readJson(await fetch(`api/products/${encodeURIComponent(code)}${qs}`, { cache: 'no-store' }));
  }

  async saveProduct(product) {
    return readJson(
      await fetch(`api/products/${encodeURIComponent(product.code)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(product),
      })
    );
  }

  async archiveProduct(code) {
    return readJson(await fetch(`api/products/${encodeURIComponent(code)}`, { method: 'DELETE' }));
  }

  async unitStatus(serial, productCode) {
    return readJson(await fetch(`api/units/${encodeURIComponent(serial)}?${toQueryString({ product: productCode })}`, { cache: 'no-store' }));
  }

  async saveRun(run) {
    return readJson(
      await fetch('api/tests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(run) })
    );
  }

  async query(filters = {}) {
    return readJson(await fetch(`api/tests?${toQueryString(filters)}`, { cache: 'no-store' }));
  }

  async exportCsv(filters = {}) {
    // The server streams the file with Content-Disposition: attachment
    Object.assign(document.createElement('a'), { href: `api/tests/export.csv?${toQueryString(filters)}` }).click();
  }
}

const RESULTS_KEY = 'productionRuns';
const PRODUCTS_KEY = 'productionProducts';
const MAX_LOCAL_RECORDS = 1000;

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // storage full or unavailable — keep working in memory
  }
}

export class LocalStore {
  kind = 'local';

  constructor() {
    // { [code]: { revision, archived, updatedAt, revisions: { [n]: definition } } }
    this.products = read(PRODUCTS_KEY, null);
    if (!this.products) {
      this.products = {};
      for (const p of DEFAULT_PRODUCTS) this.saveProductSync(validateProduct(p).product);
    }
  }

  view(code, revision) {
    const entry = this.products[code];
    if (!entry) return null;
    const rev = revision ?? entry.revision;
    const def = entry.revisions[rev];
    return def ? { ...def, revision: rev, archived: entry.archived, updatedAt: entry.updatedAt } : null;
  }

  saveProductSync(product) {
    const entry = this.products[product.code];
    const now = new Date().toISOString();
    if (!entry) {
      this.products[product.code] = { revision: 1, archived: false, updatedAt: now, revisions: { 1: product } };
    } else if (JSON.stringify(entry.revisions[entry.revision]) !== JSON.stringify(product)) {
      entry.revision += 1;
      entry.revisions[entry.revision] = product;
      entry.archived = false;
      entry.updatedAt = now;
    } else {
      entry.archived = false;
    }
    write(PRODUCTS_KEY, this.products);
    return this.view(product.code);
  }

  async listProducts() {
    return Object.keys(this.products)
      .sort()
      .map((code) => this.view(code))
      .filter((p) => !p.archived);
  }

  async getProduct(code, revision) {
    const product = this.view(code, revision);
    if (!product) throw new Error('Ürün bulunamadı');
    return product;
  }

  async saveProduct(input) {
    const { product, errors } = validateProduct(input);
    if (errors.length) throw new Error(errors.join(' · '));
    return this.saveProductSync(product);
  }

  async archiveProduct(code) {
    if (!this.products[code]) throw new Error('Ürün bulunamadı');
    this.products[code].archived = true;
    write(PRODUCTS_KEY, this.products);
  }

  runs() {
    return read(RESULTS_KEY, []);
  }

  async unitStatus(serial, productCode) {
    const normalized = normalizeSerial(serial);
    const history = this.runs().filter((r) => r.serial === normalized);
    return { serial: normalized, ...unitStatus(history, this.view(productCode)?.maxAttempts ?? Infinity) };
  }

  async saveRun(run) {
    // Same validation and verdict the server would apply
    const { errors, value } = prepareTestRecord(run, this.view(run.productCode, run.recipeRevision));
    if (errors.length) throw new Error(errors.join(' · '));
    const runs = this.runs();
    const record = {
      id: (runs.at(-1)?.id ?? 0) + 1,
      attempt: runs.filter((r) => r.serial === value.serial).length + 1,
      ...value,
      log: cleanLog(run.log),
    };
    runs.push(record);
    if (!write(RESULTS_KEY, runs.slice(-MAX_LOCAL_RECORDS))) throw new Error('Tarayıcı deposu dolu');
    return record;
  }

  async query({ limit = 100, offset = 0, ...filters } = {}) {
    const matching = filterRecords(this.runs(), filters).sort(
      (a, b) => b.finishedAt.localeCompare(a.finishedAt) || b.id - a.id
    );
    return { items: matching.slice(offset, offset + limit), stats: summarize(matching) };
  }

  async exportCsv(filters = {}) {
    const { items } = await this.query({ ...filters, limit: MAX_LOCAL_RECORDS });
    downloadText(resultsToCsv(items), `test-raporu-${new Date().toISOString().slice(0, 10)}.csv`);
  }
}
