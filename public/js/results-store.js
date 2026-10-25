// ============================================
// RESULT STORES — where production test results are saved
//   ServerResultStore: SQLite through server.js (/api/tests)
//   LocalResultStore:  browser storage, for the static GitHub Pages demo
// Both expose: kind, save(run), query(filters), exportCsv(filters)
// ============================================

import { prepareTestRecord, filterRecords, summarize, resultsToCsv } from './production.js';

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
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.errors?.join(', ') || `HTTP ${res.status}`);
  return body;
}

export class ServerResultStore {
  kind = 'sqlite';

  async save(run) {
    const res = await fetch('api/tests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(run),
    });
    return readJson(res);
  }

  async query(filters = {}) {
    return readJson(await fetch(`api/tests?${toQueryString(filters)}`, { cache: 'no-store' }));
  }

  async exportCsv(filters = {}) {
    // The server streams the file with Content-Disposition: attachment
    Object.assign(document.createElement('a'), { href: `api/tests/export.csv?${toQueryString(filters)}` }).click();
  }
}

const STORAGE_KEY = 'productionResults';
const MAX_LOCAL_RECORDS = 2000;

export class LocalResultStore {
  kind = 'local';

  load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? [];
    } catch {
      return [];
    }
  }

  persist(records) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_LOCAL_RECORDS)));
    } catch {
      // storage full or unavailable — keep working in memory
    }
  }

  async save(run) {
    // Same validation and verdict the server would apply
    const { errors, value } = prepareTestRecord(run);
    if (errors.length) throw new Error(errors.join(', '));
    const records = this.load();
    const record = {
      id: (records.at(-1)?.id ?? 0) + 1,
      attempt: records.filter((r) => r.serial === value.serial).length + 1,
      ...value,
    };
    records.push(record);
    this.persist(records);
    return record;
  }

  async query({ limit = 100, offset = 0, ...filters } = {}) {
    const matching = filterRecords(this.load(), filters).sort(
      (a, b) => b.finishedAt.localeCompare(a.finishedAt) || b.id - a.id
    );
    return { items: matching.slice(offset, offset + limit), stats: summarize(matching) };
  }

  async exportCsv(filters = {}) {
    const { items } = await this.query({ ...filters, limit: MAX_LOCAL_RECORDS });
    downloadText(resultsToCsv(items), `test-raporu-${new Date().toISOString().slice(0, 10)}.csv`);
  }
}
