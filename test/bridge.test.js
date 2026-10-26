// Serial bridge over a mock serial port (SerialPortMock) and real Socket.io clients.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { SerialPortMock } = require('serialport');
const { io: connectClient } = require('socket.io-client');
const { createServer } = require('../server');
const { loginAs, request } = require('./helpers');

let ctx;
let server;
let bridge;
let baseUrl;
let auth;
const clients = [];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function client() {
  const socket = connectClient(baseUrl, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie: auth.cookie } });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  clients.push(socket);
  return socket;
}

const call = (socket, event, ...args) => socket.timeout(2000).emitWithAck(event, ...args);

function nextEvent(socket, event, predicate = () => true, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

before(async () => {
  SerialPortMock.binding.createPort('/dev/FIXTURE', { echo: false, record: true });
  SerialPortMock.binding.createPort('/dev/OTHER', { echo: false, record: true });
  ctx = createServer({ dbPath: ':memory:', SerialPortImpl: SerialPortMock, log: {} });
  ({ server, bridge } = ctx);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  auth = await loginAs(baseUrl, ctx, 'operator');
});

beforeEach(async () => {
  while (clients.length) clients.pop().disconnect();
  await bridge.shutdown();
  bridge.state.lock = null;
});

after(() => new Promise((resolve) => {
  while (clients.length) clients.pop().disconnect();
  server.closeAllConnections();
  server.close(resolve);
}));

const port = () => bridge.state.receiver.port; // the MockPortBinding
const written = () => port().recording.toString();

test('opens the port, acknowledges writes and broadcasts received lines to every client', async () => {
  const a = await client();
  const b = await client();
  assert.deepEqual(await call(a, 'select-ports', { receiverPath: '/dev/FIXTURE', baudRate: 115200 }), { ok: true });
  assert.equal(bridge.state.settings.baudRate, 115200);

  const atA = nextEvent(a, 'serial-data', (l) => l === 'A1,B2');
  const atB = nextEvent(b, 'serial-data', (l) => l === '@#0001 OK');
  port().emitData(Buffer.from('A1,B2\r\n@#0001 OK\n'));
  await Promise.all([atA, atB]);

  assert.deepEqual(await call(a, 'send-manual', { text: 'PING', ending: 'crlf' }), { ok: true });
  assert.equal(written(), 'PING\r\n');
});

test('a locked port refuses writes, reconnects and disconnects from other clients', async () => {
  const station = await client();
  const other = await client();
  await call(station, 'select-ports', { receiverPath: '/dev/FIXTURE', baudRate: 9600 });
  assert.deepEqual(await call(station, 'lock', 'run-1'), { ok: true });

  for (const [event, args] of [
    ['send-manual', [{ text: 'PWR ON' }]],
    ['select-ports', [{ receiverPath: '/dev/OTHER', baudRate: 9600 }]],
    ['disconnect-ports', []],
    ['lock', ['run-2']],
  ]) {
    const res = await call(other, event, ...args);
    assert.equal(res.ok, false, event);
    assert.match(res.error, /kilitli/, event);
  }
  assert.equal(bridge.state.receiverPath, '/dev/FIXTURE');
  assert.deepEqual(await call(station, 'send-manual', { text: '#0001 PING' }), { ok: true });
  assert.equal(written(), '#0001 PING\n');

  // The station tab dies: the lock is released so the station is not blocked forever
  const released = nextEvent(other, 'connection-status', (s) => s.locked === false);
  station.disconnect();
  await released;
  assert.deepEqual(await call(other, 'send-manual', { text: 'PING' }), { ok: true });
});

test('rejects messages that are empty, too long or would inject extra lines', async () => {
  const a = await client();
  await call(a, 'select-ports', { receiverPath: '/dev/FIXTURE', baudRate: 9600 });
  for (const text of ['', 'x'.repeat(1025), 'PWR ON\nPWR OFF', 'LED ON\r']) {
    const res = await call(a, 'send-manual', { text });
    assert.equal(res.ok, false, JSON.stringify(text));
  }
  assert.equal((await call(a, 'send-manual', { text: 'PING', ending: 'tab' })).ok, false);
  assert.equal(written(), '');
});

test('reports write errors through the acknowledgement', async () => {
  const a = await client();
  await call(a, 'select-ports', { receiverPath: '/dev/FIXTURE', baudRate: 9600 });
  await bridge.shutdown();
  const res = await call(a, 'send-manual', { text: 'PING' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Port açık değil/);
});

test('validates serial settings', async () => {
  const a = await client();
  for (const options of [{ baudRate: 1234 }, { baudRate: 9600, dataBits: 6 }, { baudRate: 9600, parity: 'mark' }, { baudRate: 9600, stopBits: 3 }]) {
    const res = await call(a, 'select-ports', { receiverPath: '/dev/FIXTURE', ...options });
    assert.equal(res.ok, false, JSON.stringify(options));
  }
  assert.deepEqual(await call(a, 'select-ports', { receiverPath: '/dev/FIXTURE', baudRate: 9600, dataBits: 7, parity: 'even', stopBits: 2 }), { ok: true });
  assert.deepEqual(bridge.state.settings, { baudRate: 9600, dataBits: 7, stopBits: 2, parity: 'even' });
});

test('an endless line without a newline is dropped and counted, later lines still arrive', async () => {
  const a = await client();
  await call(a, 'select-ports', { receiverPath: '/dev/FIXTURE', baudRate: 9600 });
  const overflow = nextEvent(a, 'serial-overflow');
  port().emitData(Buffer.alloc(5000, 0x41));
  assert.equal((await overflow).count, 1);
  const line = nextEvent(a, 'serial-data', (l) => l === 'B7');
  port().emitData(Buffer.from('AAAA\nB7\n'));
  await line;
});

test('raw bytes reach only subscribed clients, unchanged', async () => {
  const a = await client();
  const b = await client();
  await call(a, 'select-ports', { receiverPath: '/dev/FIXTURE', baudRate: 9600 });
  b.emit('raw-subscribe', true);
  await wait(50);
  let aGotRaw = false;
  a.on('serial-raw', () => (aGotRaw = true));
  const raw = nextEvent(b, 'serial-raw');
  const bytes = Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x0a]); // includes invalid UTF-8
  port().emitData(bytes);
  assert.deepEqual(Buffer.from(await raw), bytes);
  await wait(30);
  assert.equal(aGotRaw, false);
});

test('rapid reconnects are serialised and end on the last requested port', async () => {
  const a = await client();
  const results = await Promise.all([
    call(a, 'select-ports', { receiverPath: '/dev/FIXTURE', baudRate: 9600 }),
    call(a, 'disconnect-ports'),
    call(a, 'select-ports', { receiverPath: '/dev/OTHER', baudRate: 19200 }),
  ]);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.equal(bridge.state.receiverPath, '/dev/OTHER');
  assert.equal(bridge.state.connected, true);
});

test('a port that disappears is reported to all clients', async () => {
  const a = await client();
  await call(a, 'select-ports', { receiverPath: '/dev/FIXTURE', baudRate: 9600 });
  const lost = nextEvent(a, 'connection-status', (s) => s.connected === false);
  bridge.state.receiver.close();
  const status = await lost;
  assert.match(status.error, /koptu/);
  assert.equal(bridge.state.connected, false);
});

test('connections without a valid session are refused', async () => {
  const socket = connectClient(baseUrl, { transports: ['websocket'], forceNew: true });
  const err = await new Promise((resolve) => socket.once('connect_error', resolve));
  socket.disconnect();
  assert.match(err.message, /Oturum/);
});

test('logging out takes port control away from an already connected socket', async () => {
  const other = await loginAs(baseUrl, ctx, 'operator', 'leaving');
  const socket = connectClient(baseUrl, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie: other.cookie } });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  clients.push(socket);
  assert.deepEqual(await call(socket, 'select-ports', { receiverPath: '/dev/FIXTURE', baudRate: 9600 }), { ok: true });

  await request(baseUrl, 'POST', '/api/auth/logout', { cookie: other.cookie });
  assert.deepEqual(await call(socket, 'send-manual', { text: 'PWR ON' }), { ok: false, error: 'Yetki yok' });
  assert.deepEqual(await call(socket, 'disconnect-ports'), { ok: false, error: 'Yetki yok' });
  assert.equal(bridge.state.connected, true);
});
