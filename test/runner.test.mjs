// Runs real recipes against the device simulator through the real CommandChannel
// and a fake "cable" that can delay, drop or break the line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRODUCTS, validateProduct, evaluateRun } from '../public/js/recipe.js';
import { runTest, sleep } from '../public/js/runner.js';
import { CommandChannel } from '../public/js/channel.js';
import { SimulatedBoard, faultForSerial } from '../public/js/simulator.js';

const SENSOR = validateProduct(DEFAULT_PRODUCTS[0]).product;
const POWER = validateProduct(DEFAULT_PRODUCTS[1]).product;

// Fast timings so the suite stays quick
function fast(product, { heartbeatMs = 0 } = {}) {
  const tune = (s) => ({ ...s, ...(s.ms ? { ms: 1 } : {}), ...(s.timeoutMs ? { timeoutMs: 40 } : {}), ...(s.intervalMs ? { intervalMs: 1 } : {}) });
  return {
    ...product,
    heartbeatMs,
    recipe: { ...product.recipe, steps: product.recipe.steps.map(tune), teardown: product.recipe.teardown.map(tune) },
  };
}

/**
 * Board ⇄ cable ⇄ channel. `cable` hooks:
 *   onWrite(line) → false to make the write fail (port gone)
 *   replyDelay(line) → ms before the reply reaches the channel (default 1)
 *   dropReply(line) → true to lose the reply on the wire (the board still executed the command)
 */
function harness(board, { answer = true, cable = {}, noise = true } = {}) {
  let connected = true;
  const channel = new CommandChannel({
    isConnected: () => connected,
    write: async (line) => {
      if (cable.onWrite?.(line) === false) {
        connected = false;
        throw new Error('port kapandı');
      }
      if (noise) setTimeout(() => channel.handleLine(board.streamLine(1)), 0);
      const reply = board.handle(line);
      if (reply === null || cable.dropReply?.(line)) return;
      setTimeout(() => channel.handleLine(reply), cable.replyDelay?.(line) ?? 1);
    },
  });
  const io = {
    request: (command, { timeoutMs, signal, id }) => channel.request(command, { timeoutMs, signal, id }).then((r) => r.reply),
    newId: () => channel.newId(),
    confirm: async (step, signal) => (typeof answer === 'function' ? answer(board, signal) : answer),
    sleep,
    startHeartbeat: (o) => channel.startHeartbeat(o),
    stopHeartbeat: () => channel.stopHeartbeat(),
  };
  return { io, channel, disconnect: () => (connected = false) };
}

async function run(product, serial, board, opts = {}) {
  const h = harness(board, opts);
  const raw = await runTest({ product, serial, io: h.io, signal: opts.signal });
  return { raw, channel: h.channel, ...evaluateRun(product.recipe, raw.steps, raw.teardown, { error: raw.error }) };
}

function serialWithFault(prefix, fault) {
  for (let n = 0; n < 100000; n += 1) {
    const serial = `${prefix}-${String(n).padStart(6, '0')}`;
    if (faultForSerial(serial) === fault) return serial;
  }
  throw new Error(`no serial with ${fault}`);
}

const GOOD = serialWithFault('SNS', 'none');
const ledAnswer = (b) => b.led;

// ---------- recipe outcomes ----------

test('a good SVB-100 passes, is switched off and verified safe', async () => {
  const board = new SimulatedBoard();
  const r = await run(fast(SENSOR), GOOD, board, { answer: ledAnswer });
  assert.equal(r.result, 'PASS', r.reason);
  assert.deepEqual(r.steps.map((s) => s.status), Array(7).fill('PASS'));
  assert.deepEqual(r.teardown.map((s) => s.status), ['PASS', 'PASS', 'PASS']);
  assert.equal(r.safety.state, 'SAFE');
  assert.equal(board.powered, false);
  assert.equal(r.captures.firmware, 'ID SVB-100 FW1.4.2');
  assert.ok(r.raw.log.some((e) => e.dir === 'TX' && /^#[0-9A-Z]{4} SN SNS-/.test(e.text)));
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
  test(`fault "${fault}" → ${result}, board left safe`, async () => {
    const board = new SimulatedBoard();
    const r = await run(fast(SENSOR), serialWithFault('SNS', fault), board, { answer: ledAnswer });
    assert.equal(r.result, result);
    assert.match(r.reason, reason);
    assert.equal(r.safety.state, 'SAFE');
    assert.equal(board.powered, false);
  });
}

test('an intermittent board passes on retest, a bad board fails again', async () => {
  const board = new SimulatedBoard();
  const flaky = serialWithFault('SNS', 'intermittent');
  assert.equal((await run(fast(SENSOR), flaky, board)).result, 'ERROR');
  assert.equal((await run(fast(SENSOR), flaky, board)).result, 'PASS');
  const bad = serialWithFault('SNS', 'overcurrent');
  assert.equal((await run(fast(SENSOR), bad, board)).result, 'FAIL');
  assert.equal((await run(fast(SENSOR), bad, board)).result, 'FAIL');
});

test('a silent device gives ERROR, and safety cannot be verified', async () => {
  const board = new SimulatedBoard();
  board.setMode('silent');
  const r = await run(fast(SENSOR), 'SNS-000001', board);
  assert.equal(r.result, 'ERROR');
  assert.match(r.reason, /Adım 1 .*Cevap yok/);
  assert.equal(r.safety.state, 'UNVERIFIED');
});

// ---------- B: teardown and safe shutdown ----------

test('cancelling mid-run still runs every teardown step', async () => {
  const board = new SimulatedBoard();
  board.setMode('none');
  const controller = new AbortController();
  const product = fast(SENSOR);
  product.recipe.steps[3] = { ...product.recipe.steps[3], ms: 300 };
  setTimeout(() => controller.abort('Test operatör tarafından durduruldu'), 60);
  const r = await run(product, 'SNS-000002', board, { signal: controller.signal });
  assert.equal(r.result, 'ERROR');
  assert.equal(r.reason, 'Test operatör tarafından durduruldu');
  assert.equal(r.steps[4].status, 'SKIPPED');
  assert.equal(r.safety.state, 'SAFE');
  assert.equal(board.powered, false);
});

test('an unexpected exception still runs the teardown', async () => {
  const board = new SimulatedBoard();
  board.setMode('none');
  const h = harness(board);
  let calls = 0;
  const io = {
    ...h.io,
    request: (command, opts) => {
      calls += 1;
      if (command === 'PWR ON') throw new TypeError('beklenmedik durum');
      return h.io.request(command, opts);
    },
  };
  const raw = await runTest({ product: fast(SENSOR), serial: GOOD, io });
  const r = evaluateRun(SENSOR.recipe, raw.steps, raw.teardown, { error: raw.error });
  assert.equal(r.result, 'ERROR');
  assert.match(r.reason, /Beklenmeyen hata: beklenmedik durum/);
  assert.deepEqual(r.teardown.map((s) => s.status), ['PASS', 'PASS', 'PASS']);
  assert.ok(calls > 3);
});

test('an exception in the progress callback cannot skip the teardown', async () => {
  const board = new SimulatedBoard();
  board.setMode('none');
  const h = harness(board);
  const raw = await runTest({
    product: fast(SENSOR),
    serial: GOOD,
    io: h.io,
    onProgress: () => {
      throw new Error('UI çöktü');
    },
  });
  assert.equal(raw.teardown.length, 3);
  assert.equal(board.powered, false);
});

test('a failing non-critical teardown step does not prevent the power-off', async () => {
  const board = new SimulatedBoard();
  board.setMode('none');
  // LED OFF is lost on the wire every time
  const r = await run(fast(SENSOR), GOOD, board, { answer: ledAnswer, cable: { dropReply: (line) => line.endsWith('LED OFF') } });
  assert.equal(r.teardown[0].status, 'ERROR');
  assert.equal(r.teardown[1].status, 'PASS');
  assert.equal(r.safety.state, 'SAFE');
  assert.equal(r.result, 'PASS', 'the board verdict is not changed by teardown problems');
  assert.equal(board.powered, false);
});

test('critical power-off is retried with the same request id and executed once', async () => {
  const board = new SimulatedBoard();
  board.setMode('none');
  let dropped = 0;
  let executedBefore = 0;
  const r = await run(fast(SENSOR), GOOD, board, {
    answer: ledAnswer,
    cable: {
      onWrite: (line) => {
        if (line.endsWith('PWR OFF')) executedBefore = executedBefore || board.executed;
      },
      dropReply: (line) => line.endsWith('PWR OFF') && dropped++ < 2,
    },
  });
  const off = r.teardown[1];
  assert.equal(off.status, 'PASS');
  assert.equal(off.data.attempts, 3);
  const ids = r.raw.log.filter((e) => e.dir === 'TX' && e.text.endsWith('PWR OFF')).map((e) => e.text.split(' ')[0]);
  assert.equal(new Set(ids).size, 1, 'all retries reuse one id');
  assert.equal(board.executed - executedBefore, 2, 'PWR OFF executed once (retries were replays), then STATUS? once');
});

test('a stuck relay is reported UNSAFE while the board verdict stays PASS', async () => {
  const board = new SimulatedBoard();
  board.setMode('stuckpower');
  const r = await run(fast(SENSOR), GOOD, board, { answer: true });
  assert.equal(r.result, 'PASS');
  assert.equal(r.safety.state, 'UNSAFE');
  assert.match(r.safety.reason, /Kapalı olduğunu doğrula: Beklenen "PWR=0 \*", gelen "PWR=1/);
  assert.equal(board.powered, true);
});

test('losing the port during the test: ERROR, teardown recorded as not sent, safety UNVERIFIED', async () => {
  const board = new SimulatedBoard();
  board.setMode('none');
  const r = await run(fast(SENSOR), GOOD, board, { cable: { onWrite: (line) => !line.endsWith('MEAS?') } });
  assert.equal(r.result, 'ERROR');
  assert.match(r.reason, /Bağlantı koptu/);
  assert.equal(r.safety.state, 'UNVERIFIED');
  assert.ok(r.teardown.every((s) => s.status === 'ERROR'));
  assert.match(r.teardown[2].reason, /Bağlantı yok|gönderilemedi|Bağlantı/);
});

test('without the station the board watchdog cuts the supply', () => {
  let now = 0;
  const board = new SimulatedBoard({ now: () => now });
  board.setMode('none');
  board.handle('#0001 PWR ON', now);
  now = 2900;
  board.tick(now);
  assert.equal(board.powered, true);
  now = 3100;
  board.tick(now);
  assert.equal(board.powered, false);
  assert.match(board.handle('#0002 STATUS?', now), /PWR=0 LED=0 WDT=1/);
});

test('heartbeats keep the board powered through a long operator question', async () => {
  for (const [heartbeatMs, expectPowered] of [[40, true], [0, false]]) {
    const board = new SimulatedBoard();
    board.setMode('none');
    board.watchdogMs = 150;
    const tickTimer = setInterval(() => board.tick(), 10);
    let poweredDuringQuestion;
    const r = await run(fast(SENSOR, { heartbeatMs }), GOOD, board, {
      answer: async (b) => {
        await sleep(400);
        poweredDuringQuestion = b.powered;
        return true;
      },
    });
    clearInterval(tickTimer);
    assert.equal(poweredDuringQuestion, expectPowered, `heartbeat ${heartbeatMs}`);
    assert.equal(r.safety.state, 'SAFE');
    // Heartbeats are in the log as one counting line, not one line per PING
    const beats = r.raw.log.filter((e) => e.dir === 'HB');
    if (heartbeatMs) {
      assert.equal(beats.length, 1);
      assert.match(beats[0].text, /heartbeat: \d+ × PING → OK/);
      assert.ok(Number(beats[0].text.match(/heartbeat: (\d+)/)[1]) >= 3);
    } else {
      assert.equal(beats.length, 0);
    }
  }
});
