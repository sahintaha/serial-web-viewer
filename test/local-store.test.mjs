// Browser-only store (IndexedDB) and the outbox, on fake-indexeddb.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalDb, StorageError } from '../public/js/local-db.js';
import { LocalStore, StoreError } from '../public/js/results-store.js';
import { Outbox } from '../public/js/outbox.js';

let n = 0;
const freshDb = (legacyStorage = null) => new LocalDb({ name: `sv-test-${++n}-${Date.now()}`, legacyStorage });

const GOOD_STEPS = [
  { reply: 'OK' },
  { reply: 'ID SVB-100 FW1.4.2' },
  { reply: 'OK' },
  {},
  { replies: Array(5).fill('V5.01,I115') },
  { reply: 'OK' },
  { reply: 'OK', answer: true },
];
const FAIL_STEPS = [...GOOD_STEPS.slice(0, 4), { replies: Array(5).fill('V5.0,I190') }];

function submission(runId, serial, steps = GOOD_STEPS) {
  return {
    runId,
    serial,
    productCode: 'SVB-100',
    recipeRevision: 1,
    source: 'simulation',
    transport: 'simulator',
    startedAt: new Date(Date.now() - 3000).toISOString(),
    finishedAt: new Date().toISOString(),
    steps,
    teardown: [{ reply: 'OK' }, { reply: 'OK' }, { reply: 'PWR=0 LED=0 WDT=0' }],
  };
}

async function runOnce(store, serial, steps = GOOD_STEPS, extra = {}) {
  const runId = crypto.randomUUID();
  await store.reserve({ runId, serial, productCode: 'SVB-100', recipeRevision: 1, source: 'simulation', transport: 'simulator', ...extra });
  return store.saveRun(submission(runId, serial, steps));
}

test('reserve → save evaluates locally and numbers attempts', async () => {
  const store = await new LocalStore({ db: freshDb() }).init();
  const first = await runOnce(store, 'SNS-000001', FAIL_STEPS);
  assert.equal(first.result, 'FAIL');
  assert.equal(first.attempt, 1);
  const second = await runOnce(store, 'SNS-000001');
  assert.equal(second.attempt, 2);
  assert.equal(second.safety.state, 'SAFE');
  const page = await store.query({ source: 'simulation' }, { limit: 10 });
  assert.equal(page.total, 2);
  assert.equal(page.items[0].steps, undefined, 'lists carry summaries only');
});

test('saveRun is idempotent by runId and refuses conflicting content', async () => {
  const store = await new LocalStore({ db: freshDb() }).init();
  const runId = crypto.randomUUID();
  await store.reserve({ runId, serial: 'SNS-000002', productCode: 'SVB-100', recipeRevision: 1, source: 'simulation', transport: 'simulator' });
  const sub = submission(runId, 'SNS-000002');
  const a = await store.saveRun(sub);
  const b = await store.saveRun(sub);
  assert.equal(b.duplicate, true);
  assert.equal(b.id, a.id);
  await assert.rejects(store.saveRun({ ...sub, steps: FAIL_STEPS }), { code: 'RUN_CONFLICT' });
  await assert.rejects(store.saveRun(submission(crypto.randomUUID(), 'SNS-000002')), { code: 'NO_RESERVATION' });
});

test('the retest policy is the same as on the server', async () => {
  const store = await new LocalStore({ db: freshDb() }).init();
  for (let i = 0; i < 3; i += 1) await runOnce(store, 'SNS-000777', FAIL_STEPS);
  await assert.rejects(runOnce(store, 'SNS-000777'), { code: 'BLOCKED' });
  await store.reopenUnit('SNS-000777', 'R12 değiştirildi', 'simulation');
  assert.equal((await runOnce(store, 'SNS-000777')).result, 'PASS');
  await assert.rejects(runOnce(store, 'SNS-000777'), { code: 'PASSED_NEEDS_REASON' });
  assert.equal((await runOnce(store, 'SNS-000777', GOOD_STEPS, { retestReason: 'kontrol' })).retestReason, 'kontrol');
  const unit = await store.unitStatus('SNS-000777', 'SVB-100', 'simulation');
  assert.equal(unit.events.length, 1);
});

test('two tabs cannot reserve the same unit at once', async () => {
  const name = `sv-tabs-${Date.now()}`;
  const tabA = await new LocalStore({ db: new LocalDb({ name, legacyStorage: null }) }).init();
  const tabB = await new LocalStore({ db: new LocalDb({ name, legacyStorage: null }) }).init();
  const reserve = (store) =>
    store.reserve({ runId: crypto.randomUUID(), serial: 'SNS-000050', productCode: 'SVB-100', recipeRevision: 1, source: 'simulation', transport: 'simulator' });
  const results = await Promise.allSettled([reserve(tabA), reserve(tabB)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'IN_PROGRESS');
});

test('other tabs are told about changes', async () => {
  const name = `sv-notify-${Date.now()}`;
  const tabA = await new LocalStore({ db: new LocalDb({ name, legacyStorage: null }) }).init();
  const tabB = await new LocalStore({ db: new LocalDb({ name, legacyStorage: null }) }).init();
  const heard = new Promise((resolve) => tabB.onChange(resolve));
  await runOnce(tabA, 'SNS-000060');
  const message = await heard;
  assert.ok(message.stores.length > 0);
});

test('drafts, publishing and archiving work like on the server', async () => {
  const store = await new LocalStore({ db: freshDb() }).init();
  const current = await store.getProduct('SVB-100');
  const definition = structuredClone({ code: current.code, name: current.name, serialMask: current.serialMask, maxAttempts: current.maxAttempts, protocol: current.protocol, heartbeatMs: current.heartbeatMs, recipe: current.recipe });
  assert.equal((await store.saveDraft(definition)).unchanged, true);
  definition.maxAttempts = 5;
  const { product: draft } = await store.saveDraft(definition, 'iki deneme daha');
  assert.equal(draft.revision, 2);
  assert.equal((await store.getProduct('SVB-100')).revision, 1);
  await assert.rejects(store.publish('SVB-100', ''), StoreError);
  assert.equal((await store.publish('SVB-100', 'onaylandı')).revision, 2);
  const { revisions, audit } = await store.listRevisions('SVB-100');
  assert.deepEqual(revisions.map((r) => r.status), ['published', 'superseded']);
  assert.ok(audit.some((a) => a.action === 'publish'));
  await assert.rejects(store.reserve({ runId: crypto.randomUUID(), serial: 'SNS-000070', productCode: 'SVB-100', recipeRevision: 1, source: 'simulation', transport: 'simulator' }), { code: 'REVISION_OUTDATED' });
});

test('data from the earlier localStorage format is imported once, labelled as unknown source', async () => {
  const storage = new Map([
    ['productionRuns', JSON.stringify([{ id: 1, serial: 'SNS-000900', productCode: 'SVB-100', recipeRevision: 1, attempt: 1, result: 'PASS', finishedAt: '2026-10-20T10:00:00.000Z', measurements: [] }])],
  ]);
  const legacy = { getItem: (k) => storage.get(k) ?? null, removeItem: (k) => storage.delete(k) };
  const store = await new LocalStore({ db: freshDb(legacy) }).init();
  const all = await store.query({ source: 'all' });
  assert.equal(all.total, 1);
  assert.equal(all.items[0].source, 'unknown');
  assert.equal(storage.size, 0, 'legacy keys removed after a successful import');
  assert.equal((await store.query({ source: 'simulation' })).total, 0);
});

test('products from the earlier format get the new defaults when read, stored unchanged', async () => {
  const old = { code: 'OLD-1', name: 'Eski ürün', serialMask: 'OLD-####', maxAttempts: 3, recipe: { steps: [{ type: 'command', name: 'Ping', send: 'PING', expect: 'OK' }], teardown: [{ type: 'command', name: 'Kapat', send: 'PWR OFF', expect: 'OK' }] } };
  const storage = new Map([['productionProducts', JSON.stringify({ 'OLD-1': { revision: 1, updatedAt: '2026-10-01T00:00:00.000Z', revisions: { 1: old } } })]]);
  const legacy = { getItem: (k) => storage.get(k) ?? null, removeItem: (k) => storage.delete(k) };
  const store = await new LocalStore({ db: freshDb(legacy) }).init();
  const product = await store.getProduct('OLD-1');
  assert.equal(product.protocol, 'v2');
  assert.equal(product.heartbeatMs, 1000);
  assert.equal(product.recipe.steps[0].send, 'PING');
  const { revisions } = await store.listRevisions('OLD-1');
  assert.equal(revisions[0].definition.protocol, undefined, 'the stored revision is not rewritten');
});

test('the outbox delivers, retries transient errors and keeps rejected runs', async () => {
  const db = await freshDb().open();
  let mode = 'offline';
  const delivered = [];
  const send = async (sub) => {
    if (mode === 'offline') throw new StoreError('Sunucuya ulaşılamadı', { permanent: false });
    if (mode === 'reject') throw new StoreError('Rezervasyon yok', { permanent: true, code: 'NO_RESERVATION' });
    delivered.push(sub.runId);
    return { id: delivered.length, runId: sub.runId };
  };
  const events = [];
  const outbox = new Outbox({ db, send, onChange: (e) => events.push(e.type) });

  await outbox.add({ runId: 'r1' });
  await assert.rejects(outbox.deliver('r1'));
  assert.deepEqual(await outbox.counts(), { pending: 1, rejected: 0 });

  // "Page reload": a new Outbox on the same database finds the pending run and sends it
  mode = 'online';
  const afterReload = new Outbox({ db, send });
  await afterReload.flush({ force: true });
  assert.deepEqual(delivered, ['r1']);
  assert.deepEqual(await afterReload.counts(), { pending: 0, rejected: 0 });

  mode = 'reject';
  await outbox.add({ runId: 'r2' });
  await outbox.flush({ force: true });
  assert.deepEqual(await outbox.counts(), { pending: 0, rejected: 1 });
  const exported = JSON.parse(await outbox.exportJson());
  assert.equal(exported.entries[0].lastError, 'Rezervasyon yok');
  mode = 'online';
  await outbox.retry('r2');
  assert.deepEqual(await outbox.counts(), { pending: 0, rejected: 0 });
  assert.ok(events.includes('rejected') && events.includes('saved'));
});

test('a run the store saved whose response was lost is cleared on resend, not duplicated', async () => {
  const db = freshDb();
  const store = await new LocalStore({ db }).init();
  const runId = crypto.randomUUID();
  await store.reserve({ runId, serial: 'SNS-000300', productCode: 'SVB-100', recipeRevision: 1, source: 'simulation', transport: 'simulator' });
  let loseResponse = true;
  const send = async (sub) => {
    const record = await store.saveRun(sub);
    if (loseResponse) {
      loseResponse = false;
      throw new StoreError('Bağlantı koptu (cevap alınamadı)', { permanent: false });
    }
    return record;
  };
  const outbox = new Outbox({ db, send });
  await outbox.add(submission(runId, 'SNS-000300'));
  await outbox.flush({ force: true });
  assert.equal((await outbox.counts()).pending, 1);
  await outbox.flush({ force: true });
  assert.equal((await outbox.counts()).pending, 0);
  assert.equal((await store.query({ serial: 'SNS-000300', source: 'simulation' })).total, 1);
});

test('a storage failure is reported, never swallowed', async () => {
  const failingDb = { put: async () => { throw new StorageError('Tarayıcı deposu dolu', Object.assign(new Error('x'), { name: 'QuotaExceededError' })); } };
  const outbox = new Outbox({ db: failingDb, send: async () => ({}) });
  await assert.rejects(outbox.add({ runId: 'x' }), { name: 'StorageError', code: 'QUOTA' });
});

test('explicit deletion of old runs is audited; nothing is removed automatically', async () => {
  const store = await new LocalStore({ db: freshDb() }).init();
  for (let i = 0; i < 3; i += 1) await runOnce(store, `SNS-00010${i}`);
  assert.equal((await store.storageInfo()).runs, 3);
  const removed = await store.deleteRunsBefore('2999-01-01T00:00:00.000Z');
  assert.equal(removed, 3);
  assert.ok((await store.audit({ entity: 'runs' }))[0].detail.count === 3);
});

test('local reports have the same shape as the server', async () => {
  const store = await new LocalStore({ db: freshDb() }).init();
  await runOnce(store, 'SNS-000400', FAIL_STEPS);
  await runOnce(store, 'SNS-000400');
  await runOnce(store, 'SNS-000401');
  const r = await store.report({ source: 'simulation' });
  assert.deepEqual(Object.keys(r).sort(), ['daily', 'measurements', 'pareto', 'products', 'timeZone']);
  const p = r.products[0];
  assert.equal(p.tests, 3);
  assert.equal(p.fpy, 50);
  assert.equal(p.finalYield, 100);
  assert.equal(p.dppm, 500_000, 'one of the two boards failed its first test');
  assert.equal(p.retests, 1);
  const m = await store.measurementReport({ source: 'simulation' }, 'SVB-100', 'I');
  assert.equal(m.n, 3);
  assert.equal(m.cpk, null);
});
