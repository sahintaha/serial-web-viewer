// Client side of the Node bridge with a fake Socket.io client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerTransport } from '../public/js/transports.js';

function fakeSocketIo() {
  const handlers = {};
  const sent = [];
  const socket = { on: (event, fn) => (handlers[event] = fn), emit: (...args) => sent.push(args) };
  globalThis.window = { io: () => socket };
  return { handlers, sent };
}

test('the raw byte subscription (HEX view) is renewed after the socket reconnects', async () => {
  const { handlers, sent } = fakeSocketIo();
  const transport = new ServerTransport({ onLine() {}, onStatus() {} });
  await transport.init();

  handlers.connect(); // first connection: nothing to restore yet
  assert.deepEqual(sent, []);

  transport.subscribeRaw(true);
  handlers.connect(); // reconnect: the server-side socket is new and has left the room
  assert.deepEqual(sent, [
    ['raw-subscribe', true],
    ['raw-subscribe', true],
  ]);

  transport.subscribeRaw(false);
  handlers.connect();
  assert.deepEqual(sent.at(-1), ['raw-subscribe', false], 'an unsubscribed view is not re-joined');
  assert.equal(sent.length, 3);
  delete globalThis.window;
});
