// Runs real recipes against the device simulator through an in-memory "serial line".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRODUCTS, validateProduct, evaluateRun, replyText } from '../public/js/recipe.js';
import { runTest, sleep } from '../public/js/runner.js';
import { SimulatedBoard, faultForSerial } from '../public/js/simulator.js';

const SENSOR = validateProduct(DEFAULT_PRODUCTS[0]).product;
const POWER = validateProduct(DEFAULT_PRODUCTS[1]).product;

// Fast timings so the suite stays quick
function fast(product) {
  const tune = (s) => ({ ...s, ...(s.ms ? { ms: 1 } : {}), ...(s.timeoutMs ? { timeoutMs: 30 } : {}), ...(s.intervalMs ? { intervalMs: 1 } : {}) });
  return { ...product, recipe: { ...product.recipe, steps: product.recipe.steps.map(tune), teardown: product.recipe.teardown.map(tune) } };
}

/** Wires a SimulatedBoard to the runner's io interface, with stream noise between replies. */
function harness(board, { answer = true, noise = true } = {}) {
  const listeners = new Set();
  const emit = (line) => listeners.forEach((fn) => fn(line));
  return {
    request(command, timeoutMs, signal) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => done(null), timeoutMs);
        const onLine = (line) => {
          const reply = replyText(line);
          if (reply !== null) done(reply);
        };
        const onAbort = () => {
          cleanup();
          const err = new Error(signal.reason);
          err.name = 'AbortError';
          reject(err);
        };
        function cleanup() {
          clearTimeout(timer);
          listeners.delete(onLine);
          signal?.removeEventListener('abort', onAbort);
        }
        function done(value) {
          cleanup();
          resolve(value);
        }
        listeners.add(onLine);
        signal?.addEventListener('abort', onAbort, { once: true });
        // Unsolicited stream lines must never be taken as replies
        if (noise) emit(board.streamLine(1));
        const reply = board.handle(command);
        if (reply !== null) setTimeout(() => emit(reply), 1);
      });
    },
    confirm: async () => (typeof answer === 'function' ? answer(board) : answer),
    sleep,
  };
}

async function run(product, serial, board, opts) {
  const raw = await runTest({ product, serial, io: harness(board, opts), signal: opts?.signal });
  return { raw, ...evaluateRun(product.recipe, raw.steps, raw.teardown, { error: raw.error }) };
}

function serialWithFault(prefix, fault) {
  for (let n = 0; n < 100000; n += 1) {
    const serial = `${prefix}-${String(n).padStart(6, '0')}`;
    if (faultForSerial(serial) === fault) return serial;
  }
  throw new Error(`no serial with ${fault}`);
}

test('a good SVB-100 passes every step and is powered off afterwards', async () => {
  const board = new SimulatedBoard();
  const r = await run(fast(SENSOR), serialWithFault('SNS', 'none'), board, { answer: (b) => b.led });
  assert.equal(r.result, 'PASS', r.reason);
  assert.deepEqual(r.steps.map((s) => s.status), Array(7).fill('PASS'));
  assert.deepEqual(r.teardown.map((s) => s.status), ['PASS', 'PASS']);
  assert.equal(board.powered, false);
  assert.ok(r.raw.log.some((e) => e.dir === 'TX' && e.text.startsWith('SN SNS-')));
});

test('a good SVB-200 passes with three measurements', async () => {
  const r = await run(fast(POWER), serialWithFault('PWR', 'none'), new SimulatedBoard());
  assert.equal(r.result, 'PASS', r.reason);
  assert.deepEqual(r.measurements.map((m) => m.key), ['V', 'I', 'T']);
});

const FAULT_CASES = [
  ['overcurrent', 'FAIL', /Adım 5 \(Besleme ölçümü\): Akım limit dışı/],
  ['undervoltage', 'FAIL', /Voltaj limit dışı/],
  ['firmware', 'FAIL', /Adım 2 .*gelen "ID SVB-100 FW1\.3\.9"/],
  ['selftest', 'FAIL', /Cihaz hatası: ERR SENSOR_FAULT/],
  ['led', 'FAIL', /Adım 7 \(LED kontrolü\): Operatör/],
  ['intermittent', 'ERROR', /Adım 5 .*Eksik ölçüm/],
];

for (const [fault, result, reason] of FAULT_CASES) {
  test(`fault "${fault}" → ${result}`, async () => {
    const board = new SimulatedBoard();
    // The operator answers what they see on the (virtual) board
    const r = await run(fast(SENSOR), serialWithFault('SNS', fault), board, { answer: (b) => b.led });
    assert.equal(r.result, result);
    assert.match(r.reason, reason);
    assert.equal(board.powered, false, 'teardown switched the board off');
  });
}

test('an intermittent board passes on retest, a bad board fails again', async () => {
  const board = new SimulatedBoard();
  const flaky = serialWithFault('SNS', 'intermittent');
  assert.equal((await run(fast(SENSOR), flaky, board, { answer: true })).result, 'ERROR');
  assert.equal((await run(fast(SENSOR), flaky, board, { answer: true })).result, 'PASS');

  const bad = serialWithFault('SNS', 'overcurrent');
  assert.equal((await run(fast(SENSOR), bad, board)).result, 'FAIL');
  assert.equal((await run(fast(SENSOR), bad, board)).result, 'FAIL');
});

test('a silent device gives ERROR (no reply), not FAIL', async () => {
  const board = new SimulatedBoard();
  board.setMode('silent');
  const r = await run(fast(SENSOR), 'SNS-000001', board);
  assert.equal(r.result, 'ERROR');
  assert.match(r.reason, /Adım 1 .*Cevap yok/);
});

test('cancelling mid-run still runs teardown', async () => {
  const board = new SimulatedBoard();
  board.setMode('none');
  const controller = new AbortController();
  const product = fast(SENSOR);
  product.recipe.steps[3] = { ...product.recipe.steps[3], ms: 200 }; // long settle time
  setTimeout(() => controller.abort('Test operatör tarafından iptal edildi'), 40);
  const r = await run(product, 'SNS-000002', board, { signal: controller.signal });
  assert.equal(r.result, 'ERROR');
  assert.equal(r.reason, 'Test operatör tarafından iptal edildi');
  assert.equal(r.steps[4].status, 'SKIPPED');
  assert.equal(board.powered, false);
});
