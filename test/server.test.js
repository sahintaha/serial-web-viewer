const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createServer } = require('../server');
const { openResultsDb } = require('../db');

let server;
let baseUrl;

before(async () => {
  ({ server } = createServer({ dbPath: ':memory:' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
}));

const api = async (method, url, body) => {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const GOOD_STEPS = [
  { reply: 'OK' },
  { reply: 'ID SVB-100 FW1.4.2' },
  { reply: 'OK' },
  {},
  { replies: Array(5).fill('V5.01,I115') },
  { reply: 'OK' },
  { reply: 'OK', answer: true },
];

function run(serial, steps = GOOD_STEPS, extra = {}) {
  return {
    serial,
    productCode: 'SVB-100',
    recipeRevision: 1,
    startedAt: new Date(Date.now() - 4000).toISOString(),
    finishedAt: new Date().toISOString(),
    steps,
    teardown: [{ reply: 'OK' }, { reply: 'OK' }, { reply: 'PWR=0 LED=0 WDT=0' }],
    log: [{ t: 0, dir: 'TX', text: `SN ${serial}` }, { t: 30, dir: 'RX', text: 'OK' }],
    ...extra,
  };
}

test('GET /health reports status', async () => {
  const { status, body } = await api('GET', '/health');
  assert.equal(status, 200);
  assert.deepEqual(body, { status: 'ok', connected: false, storage: 'sqlite' });
});

test('GET /ports returns an array', async () => {
  const { status, body } = await api('GET', '/ports');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
});

test('serves the web interface and ES modules', async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.match(await page.text(), /Serial Web Viewer/);
  for (const mod of ['app', 'recipe', 'runner', 'simulator']) {
    const res = await fetch(`${baseUrl}/js/${mod}.js`);
    assert.equal(res.status, 200, mod);
    assert.match(res.headers.get('content-type'), /javascript/);
  }
});

test('default products are seeded at revision 1', async () => {
  const { body } = await api('GET', '/api/products');
  assert.deepEqual(body.map((p) => [p.code, p.revision]), [['SVB-100', 1], ['SVB-200', 1]]);
  assert.equal(body[0].recipe.steps.length, 7);
});

test('PUT /api/products creates revisions only when the definition changes', async () => {
  const { body: current } = await api('GET', '/api/products/SVB-200');
  const definition = { name: current.name, serialMask: current.serialMask, maxAttempts: current.maxAttempts, recipe: current.recipe };

  const same = await api('PUT', '/api/products/SVB-200', definition);
  assert.equal(same.body.revision, 1);

  definition.recipe.steps[4].limits[0].max = 12.4;
  const changed = await api('PUT', '/api/products/svb-200', definition);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.revision, 2);

  const old = await api('GET', '/api/products/SVB-200?revision=1');
  assert.equal(old.body.recipe.steps[4].limits[0].max, 12.3);

  const invalid = await api('PUT', '/api/products/SVB-200', { ...definition, serialMask: '' });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.errors[0], /maskesi/);
});

test('archived products disappear from the list but keep their revisions', async () => {
  const created = await api('PUT', '/api/products/TMP-1', {
    name: 'Geçici',
    serialMask: 'TMP-###',
    recipe: { steps: [{ type: 'command', send: 'PING' }] },
  });
  assert.equal(created.body.revision, 1);
  assert.equal((await api('DELETE', '/api/products/TMP-1')).status, 204);
  assert.ok(!(await api('GET', '/api/products')).body.some((p) => p.code === 'TMP-1'));
  assert.equal((await api('GET', '/api/products/TMP-1')).body.archived, true);
  assert.equal((await api('DELETE', '/api/products/NOPE')).status, 404);
});

test('POST /api/tests stores the server-side verdict and counts attempts', async () => {
  const fail = [...GOOD_STEPS];
  fail[4] = { replies: Array(5).fill('V5.0,I190') };
  const first = await api('POST', '/api/tests', run('sns-000142', fail, { result: 'PASS' }));
  assert.equal(first.status, 201);
  assert.equal(first.body.serial, 'SNS-000142');
  assert.equal(first.body.result, 'FAIL'); // the client-sent "PASS" is ignored
  assert.equal(first.body.failedStep, 4);
  assert.equal(first.body.attempt, 1);
  assert.equal(first.body.steps[5].status, 'SKIPPED');
  assert.equal(first.body.log.length, 2);

  const retest = await api('POST', '/api/tests', run('SNS-000142'));
  assert.equal(retest.body.result, 'PASS');
  assert.equal(retest.body.attempt, 2);
  assert.equal(retest.body.productName, 'Sensör kartı');

  const fetched = await api('GET', `/api/tests/${retest.body.id}`);
  assert.deepEqual(fetched.body, retest.body);
});

test('POST /api/tests records aborted runs as ERROR', async () => {
  const { status, body } = await api('POST', '/api/tests', run('SNS-000500', GOOD_STEPS.slice(0, 2), { error: 'Test sırasında cihaz bağlantısı koptu' }));
  assert.equal(status, 201);
  assert.equal(body.result, 'ERROR');
  assert.equal(body.reason, 'Test sırasında cihaz bağlantısı koptu');
});

test('POST /api/tests rejects invalid data', async () => {
  const badSerial = await api('POST', '/api/tests', run('PWR-000001'));
  assert.equal(badSerial.status, 400);
  assert.match(badSerial.body.errors[0], /biçiminde/);

  const unknownRevision = await api('POST', '/api/tests', run('SNS-000001', GOOD_STEPS, { recipeRevision: 99 }));
  assert.equal(unknownRevision.status, 400);
  assert.match(unknownRevision.body.errors[0], /revizyonu bulunamadı/);

  const badJson = await api('POST', '/api/tests', '{not json');
  assert.equal(badJson.status, 400);
  assert.deepEqual(badJson.body, { errors: ['Geçersiz istek gövdesi'] });
});

test('GET /api/units applies the retest policy', async () => {
  const fail = [...GOOD_STEPS];
  fail[1] = { reply: 'ID SVB-100 FW1.3.9' };
  for (let i = 0; i < 3; i += 1) await api('POST', '/api/tests', run('SNS-000777', fail));
  const { body } = await api('GET', '/api/units/sns-000777?product=SVB-100');
  assert.deepEqual(
    { attempts: body.attempts, failures: body.failures, passed: body.passed, blocked: body.blocked },
    { attempts: 3, failures: 3, passed: false, blocked: true }
  );
  const fresh = await api('GET', '/api/units/SNS-999999?product=SVB-100');
  assert.equal(fresh.body.attempts, 0);
});

test('GET /api/tests filters and summarizes', async () => {
  const all = await api('GET', '/api/tests');
  assert.equal(all.body.stats.total, 6);
  assert.deepEqual([all.body.stats.PASS, all.body.stats.FAIL, all.body.stats.ERROR], [1, 4, 1]);
  assert.equal(all.body.items[0].serial, 'SNS-000777'); // newest first

  assert.equal((await api('GET', '/api/tests?serial=000142')).body.items.length, 2);
  assert.equal((await api('GET', '/api/tests?product=SVB-200')).body.stats.total, 0);
  assert.equal((await api('GET', '/api/tests?result=ERROR')).body.items[0].serial, 'SNS-000500');
  assert.equal((await api('GET', '/api/tests?from=2999-01-01')).body.stats.total, 0);
  // LIKE wildcards in the filter are treated literally
  assert.equal((await api('GET', '/api/tests?serial=%25')).body.stats.total, 0);
  assert.equal((await api('GET', '/api/tests?result=MAYBE&limit=0')).status, 400);
});

test('GET /api/tests/export.csv returns a CSV report', async () => {
  const res = await fetch(`${baseUrl}/api/tests/export.csv?result=FAIL`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="test-raporu-.*\.csv"/);
  const lines = (await res.text()).replace(/^\uFEFF/, '').split('\n');
  assert.match(lines[0], /^id,serial,product,recipe_revision,attempt,result,failed_step/);
  assert.equal(lines.length, 5); // header + 4 FAIL rows
});

test('GET /api/tests/:id returns 404 for unknown ids', async () => {
  assert.equal((await api('GET', '/api/tests/99999')).status, 404);
});

test('a version 1 database is migrated in place without losing results', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-migrate-')), 'old.db');
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
  const { items } = db.query();
  assert.equal(items.length, 1);
  assert.equal(items[0].serial, 'PCB-000142');
  assert.equal(items[0].productCode, null);
  assert.deepEqual(items[0].steps, []);
  assert.equal(items[0].measurements[0].value, 5.01);
  db.close();
});

test('an overflowing measurement is stored as ERROR with an INVALID measurement', async () => {
  const steps = [...GOOD_STEPS];
  steps[4] = { replies: ['V1e999,I115', 'V-1e999,I115', 'V5.0,I115', 'V5.0,I115', 'V5.0,I115'] };
  const { status, body } = await api('POST', '/api/tests', run('SNS-001999', steps));
  assert.equal(status, 201);
  assert.equal(body.result, 'ERROR');
  assert.equal(body.measurements[0].status, 'INVALID');
  assert.equal(body.measurements[0].mode, 'mean');
  assert.equal(body.measurements[1].stats.n, 5);
});
