const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

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

const LIMITS = [
  { key: 'V', name: 'Voltaj', unit: 'V', min: 4.9, max: 5.1 },
  { key: 'I', name: 'Akım', unit: 'mA', min: 0, max: 150 },
];

function run(serial, samples, extra = {}) {
  return {
    serial,
    sampleCount: 2,
    startedAt: new Date(Date.now() - 2000).toISOString(),
    finishedAt: new Date().toISOString(),
    limits: LIMITS,
    samples,
    ...extra,
  };
}

async function post(body) {
  const res = await fetch(`${baseUrl}/api/tests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('GET /health reports status', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', connected: false, storage: 'sqlite' });
});

test('GET /ports returns an array', async () => {
  const res = await fetch(`${baseUrl}/ports`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

test('serves the web interface', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Serial Web Viewer/);
});

test('serves ES modules with a JavaScript MIME type', async () => {
  const res = await fetch(`${baseUrl}/js/app.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
});

test('POST /api/tests stores the server-side verdict and counts attempts', async () => {
  const first = await post(run('pcb-000142', { V: [5.3, 5.3], I: [120, 120] }, { result: 'PASS' }));
  assert.equal(first.status, 201);
  assert.equal(first.body.serial, 'PCB-000142');
  assert.equal(first.body.result, 'FAIL'); // client-sent "PASS" is ignored
  assert.equal(first.body.attempt, 1);
  assert.equal(first.body.measurements[0].status, 'FAIL');

  const retest = await post(run('PCB-000142', { V: [5.0, 5.02], I: [120, 121] }));
  assert.equal(retest.body.result, 'PASS');
  assert.equal(retest.body.attempt, 2);

  const fetched = await (await fetch(`${baseUrl}/api/tests/${retest.body.id}`)).json();
  assert.deepEqual(fetched, retest.body);
});

test('POST /api/tests records aborted runs as ERROR', async () => {
  const { status, body } = await post(run('PCB-000500', { V: [5.0] }, { error: 'Test sırasında cihaz bağlantısı koptu' }));
  assert.equal(status, 201);
  assert.equal(body.result, 'ERROR');
  assert.equal(body.reason, 'Test sırasında cihaz bağlantısı koptu');
  assert.equal(body.measurements[1].status, 'MISSING');
});

test('POST /api/tests rejects invalid data', async () => {
  const bad = await post(run('no spaces allowed', { V: [5, 5], I: [1, 1] }));
  assert.equal(bad.status, 400);
  assert.match(bad.body.errors[0], /Seri numarası/);

  const badSamples = await post(run('PCB-1', { V: ['5', 5], I: [1, 1] }));
  assert.equal(badSamples.status, 400);

  const badJson = await post('{not json');
  assert.equal(badJson.status, 400);
  assert.deepEqual(badJson.body, { errors: ['Geçersiz istek gövdesi'] });
});

test('GET /api/tests filters and summarizes', async () => {
  await post(run('XYZ-000001', { V: [5, 5], I: [10, 10] }));

  const all = await (await fetch(`${baseUrl}/api/tests`)).json();
  assert.equal(all.stats.total, 4);
  assert.deepEqual([all.stats.PASS, all.stats.FAIL, all.stats.ERROR], [2, 1, 1]);
  assert.equal(all.stats.yield, 50);
  assert.equal(all.items[0].serial, 'XYZ-000001'); // newest first

  const bySerial = await (await fetch(`${baseUrl}/api/tests?serial=pcb-000142`)).json();
  assert.equal(bySerial.items.length, 2);

  const failed = await (await fetch(`${baseUrl}/api/tests?result=FAIL`)).json();
  assert.deepEqual(failed.items.map((r) => r.serial), ['PCB-000142']);

  const future = await (await fetch(`${baseUrl}/api/tests?from=2999-01-01`)).json();
  assert.equal(future.stats.total, 0);

  // LIKE wildcards in the filter are treated literally
  const wildcard = await (await fetch(`${baseUrl}/api/tests?serial=%25`)).json();
  assert.equal(wildcard.stats.total, 0);

  const invalid = await fetch(`${baseUrl}/api/tests?result=MAYBE&limit=0`);
  assert.equal(invalid.status, 400);
});

test('GET /api/tests/export.csv returns a CSV report', async () => {
  const res = await fetch(`${baseUrl}/api/tests/export.csv?result=PASS`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="test-raporu-.*\.csv"/);
  const lines = (await res.text()).replace(/^\uFEFF/, '').split('\n');
  assert.match(lines[0], /^id,serial,attempt,result/);
  assert.equal(lines.length, 3); // header + 2 PASS rows
});

test('GET /api/tests/:id returns 404 for unknown ids', async () => {
  const res = await fetch(`${baseUrl}/api/tests/99999`);
  assert.equal(res.status, 404);
});
