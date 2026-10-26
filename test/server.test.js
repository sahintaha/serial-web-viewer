// REST API, SQLite, retest policy, roles, idempotent saves and exports.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { createServer } = require('../server');
const { openResultsDb, verifyDatabaseFile, LATEST_VERSION } = require('../db');
const { loginAs, request } = require('./helpers');

const tempDirs = [];
function tempFile(prefix, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return path.join(dir, name);
}
after(() => tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

let ctx;
let baseUrl;
let op; // operator
let op2; // second operator
let eng; // engineer
let adm; // admin
const STATION = { id: 'TEST-ST-1', fixture: 'FX-07', calibration: { id: 'CAL-123', due: '2999-12-31' }, appVersion: '2.0.0+test' };

before(async () => {
  ctx = createServer({ dbPath: ':memory:', station: STATION, log: {} });
  await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${ctx.server.address().port}`;
  adm = await loginAs(baseUrl, ctx, 'admin');
  op = await loginAs(baseUrl, ctx, 'operator');
  op2 = await loginAs(baseUrl, ctx, 'operator', 'operator2');
  eng = await loginAs(baseUrl, ctx, 'engineer');
});

after(() => new Promise((resolve) => {
  ctx.server.closeAllConnections();
  ctx.server.close(resolve);
}));

const api = (who, method, url, body) => request(baseUrl, method, url, { cookie: who?.cookie, body });

const GOOD_STEPS = [
  { reply: 'OK' },
  { reply: 'ID SVB-100 FW1.4.2' },
  { reply: 'OK' },
  {},
  { replies: Array(5).fill('V5.01,I115') },
  { reply: 'OK' },
  { reply: 'OK', answer: true },
];
const GOOD_TEARDOWN = [{ reply: 'OK' }, { reply: 'OK' }, { reply: 'PWR=0 LED=0 WDT=0' }];
const FAIL_STEPS = (() => {
  const s = structuredClone(GOOD_STEPS);
  s[4] = { replies: Array(5).fill('V5.0,I190') };
  return s.slice(0, 5);
})();

function submission(runId, serial, steps = GOOD_STEPS, extra = {}) {
  return {
    runId,
    serial,
    productCode: 'SVB-100',
    recipeRevision: 1,
    source: 'simulation',
    transport: 'simulator',
    startedAt: new Date(Date.now() - 4000).toISOString(),
    finishedAt: new Date().toISOString(),
    steps,
    teardown: GOOD_TEARDOWN,
    log: [{ t: 0, dir: 'TX', text: `#0001 SN ${serial}` }, { t: 30, dir: 'RX', text: 'OK' }],
    ...extra,
  };
}

/** Reserve + post, like the station does. */
async function runTest(who, serial, steps = GOOD_STEPS, extra = {}) {
  const runId = crypto.randomUUID();
  const base = submission(runId, serial, steps, extra);
  const reserve = await api(who, 'POST', '/api/runs', {
    runId,
    serial,
    productCode: base.productCode,
    recipeRevision: base.recipeRevision,
    source: base.source,
    transport: base.transport,
    retestReason: extra.retestReason,
  });
  if (reserve.status !== 201) return { reserve, runId };
  const saved = await api(who, 'POST', '/api/tests', base);
  return { reserve, saved, runId, body: base };
}

describe('authentication and roles', () => {
  test('health is public; everything else needs a session', async () => {
    assert.equal((await api(null, 'GET', '/health')).status, 200);
    for (const url of ['/api/products', '/api/tests', '/ports', '/api/station', '/api/reports']) {
      assert.equal((await api(null, 'GET', url)).status, 401, url);
    }
  });

  test('first-time setup cannot be repeated', async () => {
    const again = await api(null, 'POST', '/api/auth/setup', { setupToken: 'x', username: 'evil', displayName: 'x', password: 'xxxxxxxxxxxx' });
    assert.equal(again.status, 409);
  });

  test('wrong passwords are rejected and rate limited', async () => {
    let last;
    for (let i = 0; i < 6; i += 1) last = await api(null, 'POST', '/api/auth/login', { username: 'ratelimit', password: 'wrong-password' });
    assert.equal(last.status, 429);
  });

  test('cross-origin state changes are refused', async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { origin: 'https://evil.example', cookie: op.cookie } });
    assert.equal(res.status, 403);
  });

  test('operators cannot change recipes, reopen units, manage users or download backups', async () => {
    const def = (await api(op, 'GET', '/api/products/SVB-100')).body;
    assert.equal((await api(op, 'PUT', '/api/products/SVB-100/draft', { definition: def })).status, 403);
    assert.equal((await api(op, 'POST', '/api/products/SVB-100/publish', { note: 'x' })).status, 403);
    assert.equal((await api(op, 'POST', '/api/units/SNS-000001/reopen', { reason: 'onarıldı' })).status, 403);
    assert.equal((await api(op, 'GET', '/api/users')).status, 403);
    assert.equal((await api(eng, 'GET', '/api/users')).status, 403);
    assert.equal((await api(eng, 'GET', '/api/admin/backup')).status, 403);
  });

  test('the last administrator cannot be demoted', async () => {
    const users = (await api(adm, 'GET', '/api/users')).body;
    const admin = users.find((u) => u.username === 'admin');
    const res = await api(adm, 'PATCH', `/api/users/${admin.id}`, { role: 'operator' });
    assert.equal(res.status, 400);
    assert.match(res.body.errors[0], /Son etkin yönetici/);
  });

  test('a disabled user loses their session immediately', async () => {
    const temp = await loginAs(baseUrl, ctx, 'operator', 'temp-user');
    const users = (await api(adm, 'GET', '/api/users')).body;
    await api(adm, 'PATCH', `/api/users/${users.find((u) => u.username === 'temp-user').id}`, { disabled: true });
    assert.equal((await api(temp, 'GET', '/api/products')).status, 401);
  });
});

describe('products: drafts, publishing, audit', () => {
  test('default products are seeded as published revision 1', async () => {
    const { body } = await api(op, 'GET', '/api/products');
    assert.deepEqual(body.map((p) => [p.code, p.revision, p.status]), [['SVB-100', 1, 'published'], ['SVB-200', 1, 'published']]);
  });

  test('a draft is invisible to the station until published, with who / when / why recorded', async () => {
    const current = (await api(eng, 'GET', '/api/products/SVB-200')).body;
    const definition = { code: current.code, name: current.name, serialMask: current.serialMask, maxAttempts: current.maxAttempts, protocol: current.protocol, heartbeatMs: current.heartbeatMs, recipe: current.recipe };

    const unchanged = await api(eng, 'PUT', '/api/products/SVB-200/draft', { definition });
    assert.equal(unchanged.body.unchanged, true);

    definition.recipe.steps[4].limits[0].max = 12.4;
    const draft = await api(eng, 'PUT', '/api/products/SVB-200/draft', { definition, note: '12 V üst limit genişletildi' });
    assert.equal(draft.status, 200);
    assert.equal(draft.body.product.revision, 2);
    assert.equal(draft.body.product.status, 'draft');
    assert.equal((await api(op, 'GET', '/api/products/SVB-200')).body.revision, 1, 'station still sees rev 1');
    assert.equal((await api(op, 'GET', '/api/products/SVB-200?revision=2')).status, 403, 'operators cannot read drafts');

    assert.equal((await api(eng, 'POST', '/api/products/SVB-200/publish', {})).status, 400, 'a publish note is required');
    const published = await api(eng, 'POST', '/api/products/SVB-200/publish', { note: 'Tedarikçi değişikliği' });
    assert.equal(published.body.revision, 2);
    assert.equal(published.body.publishedBy, 'engineer kullanıcı');
    assert.equal((await api(op, 'GET', '/api/products/SVB-200')).body.recipe.steps[4].limits[0].max, 12.4);

    const history = (await api(eng, 'GET', '/api/products/SVB-200/revisions')).body;
    assert.deepEqual(history.revisions.map((r) => [r.revision, r.status]), [[2, 'published'], [1, 'superseded']]);
    assert.ok(history.audit.some((a) => a.action === 'publish' && a.user === 'engineer kullanıcı' && a.detail.note === 'Tedarikçi değişikliği'));
  });

  test('invalid definitions are rejected with field errors', async () => {
    const res = await api(eng, 'PUT', '/api/products/SVB-200/draft', { definition: { name: 'x', serialMask: '' } });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.some((e) => /maskesi/.test(e)));
  });

  test('a new product exists only as a draft until published; discarding removes it', async () => {
    const definition = { code: 'TMP-1', name: 'Geçici', serialMask: 'TMP-###', recipe: { steps: [{ type: 'command', send: 'PING' }] } };
    await api(eng, 'PUT', '/api/products/TMP-1/draft', { definition });
    assert.ok(!(await api(op, 'GET', '/api/products')).body.some((p) => p.code === 'TMP-1'));
    assert.ok((await api(eng, 'GET', '/api/products?drafts=1')).body.some((p) => p.code === 'TMP-1'));
    assert.equal((await api(eng, 'DELETE', '/api/products/TMP-1/draft')).status, 204);
    assert.equal((await api(eng, 'GET', '/api/products/TMP-1')).status, 404);
  });

  test('a revision saved by an older version is read with the new defaults, stored unchanged', async () => {
    const old = { code: 'OLD-1', name: 'Eski ürün', serialMask: 'OLD-####', maxAttempts: 3, recipe: { stopOnFail: true, steps: [{ type: 'command', name: 'Ping', send: 'PING', expect: 'OK' }], teardown: [] } };
    ctx.db.saveDraft(old, null, null);
    ctx.db.publish('OLD-1', null, 'eski sürümden kalan revizyon');
    const { body } = await api(op, 'GET', '/api/products/OLD-1');
    assert.equal(body.protocol, 'v2');
    assert.equal(body.heartbeatMs, 1000);
    assert.equal(body.revision, 1);
    const listed = (await api(op, 'GET', '/api/products')).body.find((p) => p.code === 'OLD-1');
    assert.equal(listed.protocol, 'v2');
    const { revisions } = (await api(eng, 'GET', '/api/products/OLD-1/revisions')).body;
    assert.equal(revisions[0].definition.protocol, undefined, 'the stored revision is not rewritten');
    ctx.db.setArchived('OLD-1', true, null, 'test');
  });

  test('archiving needs a reason and hides the product from the station', async () => {
    const definition = { code: 'TMP-2', name: 'Geçici', serialMask: 'TMP-###', recipe: { steps: [{ type: 'command', send: 'PING' }] } };
    await api(eng, 'PUT', '/api/products/TMP-2/draft', { definition });
    await api(eng, 'POST', '/api/products/TMP-2/publish', { note: 'ilk sürüm' });
    assert.equal((await api(eng, 'POST', '/api/products/TMP-2/archive', {})).status, 400);
    assert.equal((await api(eng, 'POST', '/api/products/TMP-2/archive', { reason: 'Ürün hattan kalktı' })).status, 204);
    assert.ok(!(await api(op, 'GET', '/api/products')).body.some((p) => p.code === 'TMP-2'));
  });
});

describe('reservations, idempotent saves and the retest policy', () => {
  test('reserve → save stores the server verdict, the station metadata and the safety state', async () => {
    const r = await runTest(op, 'SNS-000142', FAIL_STEPS, { result: 'PASS' });
    assert.equal(r.reserve.status, 201);
    assert.equal(r.reserve.body.attempt, 1);
    assert.equal(r.saved.status, 201);
    assert.equal(r.saved.body.result, 'FAIL', 'a client-sent "PASS" is ignored');
    assert.equal(r.saved.body.failedStep, 4);
    assert.equal(r.saved.body.operator, 'operator kullanıcı');
    assert.equal(r.saved.body.source, 'simulation');
    assert.equal(r.saved.body.safety.state, 'SAFE');
    assert.deepEqual(r.saved.body.station, { ...STATION, calibrationExpired: false });
    assert.equal(r.saved.body.captures.firmware, 'ID SVB-100 FW1.4.2');
  });

  test('the same runId resent after a lost response returns the stored record, not a second attempt', async () => {
    const r = await runTest(op, 'SNS-000200');
    // The server stored it, but the station never saw the response; its outbox resends
    const again = await api(op, 'POST', '/api/tests', r.body);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.id, r.saved.body.id);
    const list = (await api(op, 'GET', '/api/tests?serial=SNS-000200&source=all')).body;
    assert.equal(list.total, 1);
  });

  test('the same runId with different content is a conflict', async () => {
    const r = await runTest(op, 'SNS-000201');
    const changed = { ...r.body, steps: FAIL_STEPS };
    const res = await api(op, 'POST', '/api/tests', changed);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'RUN_CONFLICT');
  });

  test('results without a reservation, or not matching it, are refused', async () => {
    const orphan = await api(op, 'POST', '/api/tests', submission(crypto.randomUUID(), 'SNS-000202'));
    assert.equal(orphan.status, 409);
    assert.equal(orphan.body.code, 'NO_RESERVATION');

    const runId = crypto.randomUUID();
    await api(op, 'POST', '/api/runs', { runId, serial: 'SNS-000203', productCode: 'SVB-100', recipeRevision: 1, source: 'simulation', transport: 'simulator' });
    const other = await api(op, 'POST', '/api/tests', submission(runId, 'SNS-000204'));
    assert.equal(other.body.code, 'RESERVATION_MISMATCH');
    const someoneElse = await api(op2, 'POST', '/api/tests', submission(runId, 'SNS-000203'));
    assert.equal(someoneElse.status, 403);
  });

  test('a unit that reached its FAIL limit is blocked until an engineer reopens it', async () => {
    for (let i = 0; i < 3; i += 1) assert.equal((await runTest(op, 'SNS-000777', FAIL_STEPS)).saved.status, 201);
    const blocked = await runTest(op, 'SNS-000777');
    assert.equal(blocked.reserve.status, 409);
    assert.equal(blocked.reserve.body.code, 'BLOCKED');

    assert.equal((await api(eng, 'POST', '/api/units/SNS-000777/reopen', { reason: 'R12 değiştirildi', source: 'simulation' })).status, 204);
    const afterRepair = await runTest(op, 'SNS-000777');
    assert.equal(afterRepair.saved.body.result, 'PASS');
    assert.equal(afterRepair.saved.body.attempt, 4);
    const unit = (await api(op, 'GET', '/api/units/SNS-000777?product=SVB-100&source=simulation')).body;
    assert.equal(unit.events[0].reason, 'R12 değiştirildi');
    assert.equal(unit.events[0].user, 'engineer kullanıcı');
  });

  test('ERROR results do not count towards the FAIL limit', async () => {
    const aborted = GOOD_STEPS.slice(0, 2);
    for (let i = 0; i < 4; i += 1) {
      const r = await runTest(op, 'SNS-000888', aborted, { error: 'Test operatör tarafından durduruldu' });
      assert.equal(r.saved.body.result, 'ERROR');
    }
    assert.equal((await runTest(op, 'SNS-000888')).saved.body.result, 'PASS');
  });

  test('retesting a passed unit needs a reason, which is recorded', async () => {
    await runTest(op, 'SNS-000300');
    const noReason = await runTest(op, 'SNS-000300');
    assert.equal(noReason.reserve.body.code, 'PASSED_NEEDS_REASON');
    const withReason = await runTest(op, 'SNS-000300', GOOD_STEPS, { retestReason: 'Müşteri iadesi kontrolü' });
    assert.equal(withReason.saved.status, 201);
    assert.equal(withReason.saved.body.retestReason, 'Müşteri iadesi kontrolü');
  });

  test('two stations cannot reserve the same unit at the same time', async () => {
    const body = (runId) => ({ runId, serial: 'SNS-000400', productCode: 'SVB-100', recipeRevision: 1, source: 'simulation', transport: 'simulator' });
    const [a, b] = await Promise.all([api(op, 'POST', '/api/runs', body(crypto.randomUUID())), api(op2, 'POST', '/api/runs', body(crypto.randomUUID()))]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal([a, b].find((r) => r.status === 409).body.code, 'IN_PROGRESS');
  });

  test('a serial number belongs to one product', async () => {
    await runTest(op, 'SNS-000500');
    const res = await api(op, 'POST', '/api/runs', { runId: crypto.randomUUID(), serial: 'SNS-000500', productCode: 'SVB-200', recipeRevision: 2, source: 'simulation', transport: 'simulator' });
    assert.equal(res.status, 400, 'SVB-200 serial mask rejects it first');
    // Same mask, different product: create one to prove the ownership rule
    const definition = { code: 'SNS-ALT', name: 'Alternatif', serialMask: 'SNS-######', recipe: { steps: [{ type: 'command', send: 'PING' }] } };
    await api(eng, 'PUT', '/api/products/SNS-ALT/draft', { definition });
    await api(eng, 'POST', '/api/products/SNS-ALT/publish', { note: 'test' });
    const owned = await api(op, 'POST', '/api/runs', { runId: crypto.randomUUID(), serial: 'SNS-000500', productCode: 'SNS-ALT', recipeRevision: 1, source: 'simulation', transport: 'simulator' });
    assert.equal(owned.body.code, 'WRONG_PRODUCT');
  });

  test('an outdated recipe revision cannot start a run', async () => {
    const res = await api(op, 'POST', '/api/runs', { runId: crypto.randomUUID(), serial: 'PWR-000001', productCode: 'SVB-200', recipeRevision: 1, source: 'simulation', transport: 'simulator' });
    assert.equal(res.body.code, 'REVISION_OUTDATED');
    assert.equal(res.body.revision, 2);
  });

  test('source and transport must be consistent, and a server-port run needs the port lock', async () => {
    const mismatched = await api(op, 'POST', '/api/runs', { runId: crypto.randomUUID(), serial: 'SNS-000600', productCode: 'SVB-100', recipeRevision: 1, source: 'hardware', transport: 'simulator' });
    assert.equal(mismatched.status, 400);
    const noLock = await api(op, 'POST', '/api/runs', { runId: crypto.randomUUID(), serial: 'SNS-000600', productCode: 'SVB-100', recipeRevision: 1, source: 'hardware', transport: 'server' });
    assert.equal(noLock.body.code, 'PORT_NOT_LOCKED');
  });
});

describe('simulation and production data are separated', () => {
  test('simulation results are excluded from default lists and do not affect real units', async () => {
    for (let i = 0; i < 3; i += 1) await runTest(op, 'SNS-000999', FAIL_STEPS); // simulation, now blocked in simulation
    const real = await api(op, 'POST', '/api/runs', { runId: crypto.randomUUID(), serial: 'SNS-000999', productCode: 'SVB-100', recipeRevision: 1, source: 'hardware', transport: 'webserial' });
    assert.equal(real.status, 201, 'the real board is not blocked by simulation history');
    assert.equal(real.body.attempt, 1);

    const production = (await api(op, 'GET', '/api/tests?serial=SNS-000999')).body;
    assert.equal(production.total, 0);
    const sim = (await api(op, 'GET', '/api/tests?serial=SNS-000999&source=simulation')).body;
    assert.equal(sim.total, 3);
    assert.ok(sim.items.every((i) => i.source === 'simulation'));
  });
});

describe('history, CSV and reports', () => {
  test('list returns summaries with paging and totals; details come from the item endpoint', async () => {
    const page1 = (await api(op, 'GET', '/api/tests?source=simulation&limit=5')).body;
    const page2 = (await api(op, 'GET', '/api/tests?source=simulation&limit=5&offset=5')).body;
    assert.equal(page1.items.length, 5);
    assert.ok(page1.total > 10);
    assert.equal(page1.total, page2.total);
    assert.equal(new Set([...page1.items, ...page2.items].map((i) => i.id)).size, 10);
    assert.equal(page1.items[0].log, undefined, 'no logs in lists');
    assert.equal(page1.items[0].steps, undefined, 'no step data in lists');
    const detail = (await api(op, 'GET', `/api/tests/${page1.items[0].id}`)).body;
    assert.ok(Array.isArray(detail.steps) && Array.isArray(detail.log));
    assert.equal((await api(op, 'GET', '/api/tests?limit=1000')).status, 400);
  });

  test('the CSV export contains exactly the filtered rows', async () => {
    const filters = 'source=simulation&result=FAIL';
    const total = (await api(op, 'GET', `/api/tests?${filters}&limit=1`)).body.total;
    const res = await fetch(`${baseUrl}/api/tests/export.csv?${filters}`, { headers: { cookie: op.cookie } });
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const lines = (await res.text()).replace(/^\uFEFF/, '').trim().split('\n');
    assert.equal(lines.length - 1, total);
    assert.match(lines[0], /^id,serial,product,recipe_revision,attempt,result,failed_step,reason,operator,source,transport,safety,dut_firmware/);
  });

  test('CSV cells cannot become spreadsheet formulas, numbers stay numbers', async () => {
    const r = await runTest(op, 'SNS-000700', GOOD_STEPS.slice(0, 2), { error: '=HYPERLINK("http://evil","x")' });
    assert.equal(r.saved.status, 201);
    const res = await fetch(`${baseUrl}/api/tests/export.csv?serial=SNS-000700&source=simulation`, { headers: { cookie: op.cookie } });
    const row = (await res.text()).trim().split('\n')[1];
    assert.match(row, /,"'=HYPERLINK\(""http:\/\/evil"",""x""\)",/);
    const fail = await runTest(op, 'SNS-000701', [...FAIL_STEPS.slice(0, 4), { replies: Array(5).fill('V-3.2,I115') }]);
    const csv = await (await fetch(`${baseUrl}/api/tests/export.csv?serial=SNS-000701&source=simulation`, { headers: { cookie: op.cookie } })).text();
    assert.equal(fail.saved.body.result, 'FAIL');
    assert.match(csv.trim().split('\n')[1], /,-3\.2,FAIL,/);
  });

  test('reports separate attempt yield, first-pass yield and final yield', async () => {
    const { body } = await api(op, 'GET', '/api/reports?source=simulation&product=SVB-100');
    const p = body.products[0];
    assert.equal(p.product, 'SVB-100');
    assert.ok(p.retests > 0);
    assert.ok(p.fpy < p.finalYield, 'retests that pass raise the final yield above FPY');
    assert.ok(body.pareto.length > 0);
    assert.ok(body.pareto[0].cause.startsWith('Adım'));
    const m = (await api(op, 'GET', '/api/reports/measurement?source=simulation&product=SVB-100&key=I')).body;
    assert.ok(m.n > 0);
    assert.equal(m.cpk, null);
    assert.ok(m.notes.some((n) => /en az 30/.test(n)));
  });
});

describe('administration', () => {
  test('backups are consistent snapshots that pass verification', async () => {
    const res = await fetch(`${baseUrl}/api/admin/backup`, { headers: { cookie: adm.cookie } });
    assert.equal(res.status, 200);
    const file = tempFile('sv-bk-', 'b.db');
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const check = verifyDatabaseFile(file);
    assert.deepEqual(check, { ok: true, errors: [], version: LATEST_VERSION });
    const restored = openResultsDb(file);
    assert.ok(restored.list({ source: 'all' }, { limit: 1 }).total > 0);
    restored.close();
  });

  test('calibration overdue blocks real-hardware runs but not simulation', async () => {
    const expired = createServer({ dbPath: ':memory:', station: { ...STATION, calibration: { id: 'CAL-1', due: '2020-01-01' } }, log: {} });
    await new Promise((resolve) => expired.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${expired.server.address().port}`;
    const who = await loginAs(url, expired, 'operator');
    const call = (source, transport) =>
      request(url, 'POST', '/api/runs', { cookie: who.cookie, body: { runId: crypto.randomUUID(), serial: 'SNS-000001', productCode: 'SVB-100', recipeRevision: 1, source, transport } });
    assert.equal((await call('hardware', 'webserial')).body.code, 'CALIBRATION_EXPIRED');
    assert.equal((await call('simulation', 'simulator')).status, 201);
    expired.server.closeAllConnections();
    await new Promise((resolve) => expired.server.close(resolve));
  });

  test('malformed JSON gives a JSON error', async () => {
    const res = await api(op, 'POST', '/api/tests', '{not json');
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { errors: ['Geçersiz istek gövdesi'] });
  });
});

describe('database migrations', () => {
  test('a version 1 database is migrated to the latest schema without losing results', () => {
    const file = tempFile('sv-migrate-', 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE test_results (id INTEGER PRIMARY KEY AUTOINCREMENT, serial TEXT NOT NULL, attempt INTEGER NOT NULL,
        result TEXT NOT NULL, reason TEXT, operator TEXT, sample_count INTEGER NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL, limits_json TEXT NOT NULL);
      CREATE TABLE measurements (id INTEGER PRIMARY KEY AUTOINCREMENT, test_id INTEGER NOT NULL, key TEXT NOT NULL,
        name TEXT NOT NULL, unit TEXT, value REAL, min REAL NOT NULL, max REAL NOT NULL, count INTEGER NOT NULL, status TEXT NOT NULL);
      INSERT INTO test_results VALUES (1, 'PCB-000142', 1, 'PASS', NULL, NULL, 5, '2026-10-24T10:00:00.000Z', '2026-10-24T10:00:02.000Z', '[]');
      INSERT INTO measurements VALUES (1, 1, 'V', 'Voltaj', 'V', 5.01, 4.9, 5.1, 5, 'PASS');
    `);
    old.close();

    const db = openResultsDb(file);
    assert.equal(db.migratedFrom, 1);
    const { items } = db.list({ source: 'all' });
    assert.equal(items.length, 1);
    assert.equal(items[0].serial, 'PCB-000142');
    assert.equal(items[0].source, 'unknown', 'legacy rows are never labelled as real hardware');
    assert.equal(db.list({}).total, 1, 'unknown rows are part of the production view (conservative)');
    assert.equal(db.get(1).measurements[0].stats.mean, 5.01);
    db.close();
    assert.equal(verifyDatabaseFile(file).version, LATEST_VERSION);
  });

  test('a database from a newer application version is refused', () => {
    const file = tempFile('sv-new-', 'new.db');
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
    db.close();
    assert.throws(() => openResultsDb(file), /bu uygulamadan yeni/);
  });

  test('large exports are streamed without loading every row', async () => {
    const big = createServer({ dbPath: ':memory:', station: STATION, log: {} });
    await new Promise((resolve) => big.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${big.server.address().port}`;
    const who = await loginAs(url, big, 'operator');
    const production = await import('../public/js/production.js');
    const recipe = await import('../public/js/recipe.js');
    const product = { ...recipe.validateProduct(recipe.DEFAULT_PRODUCTS[0]).product, revision: 1 };
    const { value } = production.prepareTestRecord(submission(crypto.randomUUID(), 'SNS-000001'), product);
    big.db.transaction(() => {
      for (let i = 0; i < 3000; i += 1) big.db.insert({ ...value, serial: `SNS-${String(i).padStart(6, '0')}` }, { source: 'hardware', runId: crypto.randomUUID() });
    });
    const started = Date.now();
    const res = await fetch(`${url}/api/tests/export.csv`, { headers: { cookie: who.cookie } });
    const text = await res.text();
    assert.equal(text.trim().split('\n').length, 3001);
    assert.ok(Date.now() - started < 10000);
    big.server.closeAllConnections();
    await new Promise((resolve) => big.server.close(resolve));
  });
});
