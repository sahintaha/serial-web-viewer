// D: request ids, serialisation, ownership lock and heartbeats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandChannel, parseReply } from '../public/js/channel.js';
import { SimulatedBoard } from '../public/js/simulator.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function fakePort() {
  const written = [];
  const channel = new CommandChannel({ write: async (line) => written.push(line), staleGuardMs: 30 });
  return { channel, written };
}

test('parseReply distinguishes numbered and legacy replies', () => {
  assert.deepEqual(parseReply('@#00A1 OK'), { id: '00A1', body: 'OK' });
  assert.deepEqual(parseReply('@#00A1 V5.0,I115'), { id: '00A1', body: 'V5.0,I115' });
  assert.deepEqual(parseReply('@OK'), { id: null, body: 'OK' });
  assert.deepEqual(parseReply('@ID SVB-100 FW1.4.2'), { id: null, body: 'ID SVB-100 FW1.4.2' });
  assert.equal(parseReply('A25.1,B60'), null);
});

test('a late @OK of a timed-out request cannot satisfy the next request', async () => {
  const { channel, written } = fakePort();
  const first = await channel.request('PWR ON', { timeoutMs: 20 });
  assert.equal(first.reply, null);
  const second = channel.request('SELFTEST', { timeoutMs: 200 });
  await tick();
  const [firstId, secondId] = written.map((l) => l.slice(1, 5));
  channel.handleLine(`@#${firstId} OK`); // the late reply of the first request
  channel.handleLine('@OK'); // an unnumbered reply (e.g. someone typed in the monitor)
  await tick();
  channel.handleLine(`@#${secondId} ERR SENSOR_FAULT`);
  assert.deepEqual(await second, { reply: 'ERR SENSOR_FAULT', id: secondId });
  assert.equal(channel.stats.stale, 1);
  assert.equal(channel.stats.unmatched, 1);
});

test('duplicate replies are ignored', async () => {
  const { channel, written } = fakePort();
  const p = channel.request('ID?', { timeoutMs: 100 });
  await tick();
  const id = written[0].slice(1, 5);
  channel.handleLine(`@#${id} ID SVB-100 FW1.4.2`);
  channel.handleLine(`@#${id} ID SVB-100 FW1.4.2`);
  assert.equal((await p).reply, 'ID SVB-100 FW1.4.2');
  assert.equal(channel.stats.stale, 1);
});

test('requests are serialised: the second is written only after the first is answered', async () => {
  const { channel, written } = fakePort();
  const a = channel.request('A?', { timeoutMs: 100 });
  const b = channel.request('B?', { timeoutMs: 100 });
  await tick();
  assert.equal(written.length, 1);
  channel.handleLine(`@#${written[0].slice(1, 5)} 1`);
  await a;
  await tick();
  assert.equal(written.length, 2);
  channel.handleLine(`@#${written[1].slice(1, 5)} 2`);
  assert.equal((await b).reply, '2');
});

test('the owner lock blocks manual sends and auto-send while a test runs', async () => {
  const { channel, written } = fakePort();
  channel.lock('run-1');
  await assert.rejects(channel.sendRaw('LED ON', 'monitor'), { code: 'LOCKED' });
  await assert.rejects(channel.request('PWR ON', { timeoutMs: 10, owner: 'run-2' }), { code: 'LOCKED' });
  assert.throws(() => channel.lock('run-2'), { code: 'LOCKED' });
  const p = channel.request('PING', { timeoutMs: 10, owner: 'run-1' });
  await p;
  channel.unlock('run-1');
  await channel.sendRaw('LED ON', 'monitor');
  assert.equal(written.at(-1), 'LED ON');
});

test('write failures are reported, not swallowed', async () => {
  const channel = new CommandChannel({ write: async () => { throw new Error('USB çıkarıldı'); } });
  await assert.rejects(channel.request('PING', { timeoutMs: 50 }), { code: 'WRITE_FAILED', message: /USB çıkarıldı/ });
  const closed = new CommandChannel({ write: async () => {}, isConnected: () => false });
  await assert.rejects(closed.request('PING', { timeoutMs: 50 }), { code: 'NOT_CONNECTED' });
});

test('legacy protocol (v1): a late reply inside the guard window is discarded', async () => {
  const { channel, written } = fakePort();
  assert.equal((await channel.request('PWR ON', { timeoutMs: 15, protocol: 'v1' })).reply, null);
  const p = channel.request('SELFTEST', { timeoutMs: 200, protocol: 'v1' });
  channel.handleLine('@OK'); // late reply of PWR ON
  await tick(40);
  assert.equal(written.length, 2, 'the next command waited for the guard window');
  channel.handleLine('@ERR SENSOR_FAULT');
  assert.equal((await p).reply, 'ERR SENSOR_FAULT');
  assert.equal(written[1], 'SELFTEST');
});

test('aborting a request rejects it and frees the queue', async () => {
  const { channel } = fakePort();
  const controller = new AbortController();
  const p = channel.request('MEAS?', { timeoutMs: 1000, signal: controller.signal });
  controller.abort('iptal');
  await assert.rejects(p, { name: 'AbortError' });
  const next = channel.request('PING', { timeoutMs: 20 });
  assert.equal((await next).reply, null);
});

test('the simulator replays a cached reply for a retried id instead of executing again', () => {
  const board = new SimulatedBoard();
  board.setMode('none');
  board.handle('#00A1 SN SNS-000001');
  const before = board.executed;
  assert.equal(board.handle('#00A2 PWR ON'), '@#00A2 OK');
  assert.equal(board.handle('#00A2 PWR ON'), '@#00A2 OK');
  assert.equal(board.executed - before, 1);
  assert.equal(board.handle('#00A2 PWR OFF'), '@#00A2 ERR ID_REUSED');
  assert.equal(board.handle('PWR OFF'), '@OK', 'unnumbered commands still work (legacy / manual use)');
});

test('heartbeat pings an idle line and reports a dead device', async () => {
  const { channel, written } = fakePort();
  let failed = null;
  channel.lastActivity = 0;
  channel.startHeartbeat({ owner: 'run', intervalMs: 20, timeoutMs: 10, maxMisses: 2, onFail: (r) => (failed = r) });
  channel.lock('run');
  // Wait for the outcome instead of a fixed time, so the test is stable under CPU load
  for (let i = 0; i < 200 && !failed; i += 1) await tick(10);
  channel.stopHeartbeat();
  assert.ok(written.some((l) => l.endsWith(' PING')));
  assert.match(failed, /2 heartbeat/);
});
