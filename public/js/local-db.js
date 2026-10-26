// ============================================
// LOCAL DATABASE — IndexedDB for the browser-only store and the outbox.
//
// - Transactions are atomic across tabs (IndexedDB serialises overlapping
//   read-write transactions), so attempt numbers and reservations stay consistent.
// - Other tabs are told about changes through a BroadcastChannel.
// - Data from the earlier localStorage format is imported once and then removed.
// - Nothing is ever deleted silently; quota errors are reported to the caller.
// ============================================

// Named after the project's first name; kept so existing browser data stays readable
const DB_NAME = 'serial-web-viewer';
const DB_VERSION = 1;
const LEGACY_KEYS = { runs: 'productionRuns', products: 'productionProducts' };

const promisify = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageError';
    this.code = cause?.name === 'QuotaExceededError' ? 'QUOTA' : 'STORAGE';
    this.cause = cause;
  }
}

function upgrade(db) {
  db.createObjectStore('kv', { keyPath: 'key' });
  const runs = db.createObjectStore('runs', { keyPath: 'id', autoIncrement: true });
  runs.createIndex('runId', 'runId', { unique: true });
  runs.createIndex('serial', 'serial');
  runs.createIndex('finishedAt', 'finishedAt');
  const reservations = db.createObjectStore('reservations', { keyPath: 'runId' });
  reservations.createIndex('serial', 'serial');
  db.createObjectStore('unitEvents', { keyPath: 'id', autoIncrement: true }).createIndex('serial', 'serial');
  db.createObjectStore('audit', { keyPath: 'id', autoIncrement: true });
  db.createObjectStore('outbox', { keyPath: 'runId' });
}

export class LocalDb {
  /**
   * @param {object} [options]
   * @param {IDBFactory} [options.idb] injectable for tests
   * @param {Storage} [options.legacyStorage] localStorage of the earlier version
   */
  constructor({ idb = globalThis.indexedDB, legacyStorage = globalThis.localStorage, name = DB_NAME } = {}) {
    this.idb = idb;
    this.legacyStorage = legacyStorage;
    this.name = name;
    this.db = null;
    this.listeners = new Set();
    this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`${name}-changes`) : null;
    if (this.channel) this.channel.onmessage = (e) => this.listeners.forEach((fn) => fn(e.data));
    // Node (tests) only: an open channel must not keep the process alive
    this.channel?.unref?.();
  }

  async open() {
    if (this.db) return this;
    if (!this.idb) throw new StorageError('Bu tarayıcıda IndexedDB yok');
    const request = this.idb.open(this.name, DB_VERSION);
    request.onupgradeneeded = () => upgrade(request.result);
    this.db = await promisify(request);
    // Another tab upgraded the schema: close so it can proceed
    this.db.onversionchange = () => this.db.close();
    await this.importLegacy();
    return this;
  }

  /** Runs fn inside one transaction; every await inside fn must be an IndexedDB request. */
  async tx(storeNames, mode, fn) {
    await this.open();
    let transaction;
    try {
      transaction = this.db.transaction(storeNames, mode);
    } catch (err) {
      throw new StorageError(`Depo açılamadı: ${err.message}`, err);
    }
    const stores = Object.fromEntries([].concat(storeNames).map((n) => [n, transaction.objectStore(n)]));
    const done = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('İşlem iptal edildi'));
    });
    let result;
    try {
      result = await fn(stores, transaction);
    } catch (err) {
      try {
        transaction.abort();
      } catch {
        // already finished
      }
      await done.catch(() => {});
      throw err;
    }
    try {
      await done;
    } catch (err) {
      throw new StorageError(err?.name === 'QuotaExceededError' ? 'Tarayıcı deposu dolu; kayıtları dışa aktarıp yer açın' : `Kayıt yazılamadı: ${err?.message}`, err);
    }
    if (mode === 'readwrite') this.notify({ stores: [].concat(storeNames) });
    return result;
  }

  get(store, key) {
    return this.tx(store, 'readonly', (s) => promisify(s[store].get(key)));
  }

  getAll(store, indexName, query) {
    return this.tx(store, 'readonly', (s) => promisify((indexName ? s[store].index(indexName) : s[store]).getAll(query)));
  }

  put(store, value) {
    return this.tx(store, 'readwrite', (s) => promisify(s[store].put(value)));
  }

  delete(store, key) {
    return this.tx(store, 'readwrite', (s) => promisify(s[store].delete(key)));
  }

  count(store) {
    return this.tx(store, 'readonly', (s) => promisify(s[store].count()));
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(message) {
    this.channel?.postMessage(message);
  }

  /** Storage usage of this origin, when the browser can tell. */
  async estimate() {
    const estimate = (await navigator?.storage?.estimate?.().catch(() => null)) ?? null;
    const persisted = (await navigator?.storage?.persisted?.().catch(() => false)) ?? false;
    return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, persisted };
  }

  /** Asks the browser not to evict this origin's data under storage pressure. */
  async requestPersistence() {
    return (await navigator?.storage?.persist?.().catch(() => false)) ?? false;
  }

  /** One-time import of the earlier localStorage format (results and products). */
  async importLegacy() {
    const storage = this.legacyStorage;
    if (!storage) return;
    let runs;
    let products;
    try {
      runs = JSON.parse(storage.getItem(LEGACY_KEYS.runs) ?? 'null');
      products = JSON.parse(storage.getItem(LEGACY_KEYS.products) ?? 'null');
    } catch {
      return;
    }
    if (!runs && !products) return;
    await this.tx(['runs', 'kv'], 'readwrite', async (s) => {
      for (const run of runs ?? []) {
        const { id, ...rest } = run;
        void id;
        // Earlier runs carried no source: never claim they came from real hardware
        await promisify(s.runs.add({ ...rest, runId: rest.runId ?? `legacy-${crypto.randomUUID()}`, source: rest.source ?? 'unknown' }));
      }
      if (products && !(await promisify(s.kv.get('products')))) {
        const migrated = {};
        for (const [code, entry] of Object.entries(products)) {
          const revisions = {};
          for (const [n, definition] of Object.entries(entry.revisions ?? {})) {
            revisions[n] = { definition, status: Number(n) === entry.revision ? 'published' : 'superseded', createdAt: entry.updatedAt ?? null, note: null };
          }
          migrated[code] = { revision: entry.revision, published: entry.revision, draft: null, archived: Boolean(entry.archived), revisions };
        }
        await promisify(s.kv.put({ key: 'products', value: migrated }));
      }
    });
    storage.removeItem(LEGACY_KEYS.runs);
    storage.removeItem(LEGACY_KEYS.products);
  }

  close() {
    this.db?.close();
    this.db = null;
    this.channel?.close();
  }
}

export { promisify };
