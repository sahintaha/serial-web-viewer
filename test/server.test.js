const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

let server;
let baseUrl;

before(async () => {
  ({ server } = createServer());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
}));

test('GET /health reports status', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok', connected: false });
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
