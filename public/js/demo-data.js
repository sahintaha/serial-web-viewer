// ============================================
// SAMPLE DATA for the browser-only demo: two weeks of a simulated production line.
//
// Nothing is made up row by row: every test is run by the real runner against the
// device simulator, evaluated by the recipe code and stored through the normal
// reserve → save path (retest policy included). Only the clock is virtual, so two
// weeks take a few seconds. Every record is source "simulation", so sample data is
// never mixed into production reports, and it can be deleted with the simulation records.
// ============================================

import { runTest } from './runner.js';
import { SimulatedBoard } from './simulator.js';
import { parseReply } from './channel.js';

const HOUR = 3600_000;
// Shift windows (local time, hours) and how many boards each shift tests
const SHIFTS = [
  { from: 8, to: 16, boards: [7, 11] },
  { from: 16, to: 24, boards: [5, 9] },
];
const NIGHT_SHIFT = { from: 0, to: 4, boards: [3, 5] }; // every third day: tests just after midnight
const OPERATORS = ['Örnek operatör 1', 'Örnek operatör 2', 'Örnek operatör 3'];

/** Small deterministic PRNG, so the same seed gives the same two weeks. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Device io for the runner: the simulated board on a virtual clock, with realistic latencies. */
function virtualLine(board, clock, random) {
  let counter = Math.floor(random() * 36 ** 3);
  return {
    newId() {
      counter = (counter + 1) % 36 ** 4;
      return counter.toString(36).toUpperCase().padStart(4, '0');
    },
    async request(command, { timeoutMs, id }) {
      clock.advance(10 + random() * 40); // cable + firmware
      const line = board.handle(id ? `#${id} ${command}` : command, clock.now());
      if (line === null) {
        clock.advance(timeoutMs);
        return null;
      }
      return parseReply(line)?.body ?? null;
    },
    async confirm() {
      // The operator looks at the LED; the station's heartbeat keeps the board powered meanwhile
      const wait = 1200 + random() * 2500;
      for (let t = 0; t < wait; t += 1000) {
        clock.advance(Math.min(1000, wait - t));
        board.handle('PING', clock.now());
      }
      return board.led;
    },
    async sleep(ms) {
      clock.advance(ms);
    },
  };
}

/** Test slots (local time) for the past `days` days, oldest first. Sundays are off. */
function schedule(days, now, random) {
  const slots = [];
  for (let d = days; d >= 1; d -= 1) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - d);
    if (day.getDay() === 0) continue;
    const shifts = d % 3 === 0 ? [NIGHT_SHIFT, ...SHIFTS] : SHIFTS;
    for (const shift of shifts) {
      const [min, max] = shift.boards;
      const count = min + Math.floor(random() * (max - min + 1));
      for (let i = 0; i < count; i += 1) {
        const at = new Date(day);
        at.setTime(day.getTime() + (shift.from + ((i + random()) / count) * (shift.to - shift.from)) * HOUR);
        slots.push(at.getTime());
      }
    }
  }
  return slots.sort((a, b) => a - b);
}

/**
 * Generates sample production data in a browser-only store.
 * @param {object} store LocalStore
 * @param {object} [options]
 * @param {number} [options.days] how many past days (default 14)
 * @param {number} [options.seed]
 * @param {number} [options.now] "today" (ms)
 * @param {number} [options.firstSerial] first serial number; defaults to a range unlikely to be in use
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<{boards: number, runs: number, results: {PASS: number, FAIL: number, ERROR: number}, refused: number}>}
 */
export async function generateSampleData(store, { days = 14, seed = 20261026, now = Date.now(), firstSerial, onProgress } = {}) {
  if (store.kind !== 'local') throw new Error('Örnek veri yalnızca sunucusuz (tarayıcı) kurulumda oluşturulur');
  const random = mulberry32(seed);
  const products = [];
  for (const code of ['SVB-100', 'SVB-200']) {
    const product = await store.getProduct(code).catch(() => null);
    // Serial numbers are generated as <prefix><6 digits>; skip a product whose mask was changed
    if (product && !product.archived && /^[A-Z0-9-]*#{6}$/.test(product.serialMask)) products.push(product);
  }
  if (!products.length) throw new Error('Yayında, seri no maskesi "ABC-######" biçiminde bir SVB-100 / SVB-200 ürünü yok');

  const clock = { t: 0, now: () => clock.t, advance: (ms) => (clock.t += ms) };
  const board = new SimulatedBoard({ random, now: clock.now });
  board.setMode('auto'); // the defect, if any, follows from the serial number
  const io = virtualLine(board, clock, random);
  const slots = schedule(days, now, random);
  let serialNumber = firstSerial ?? 900000 + (Math.floor(now / 1000) % 90) * 1000;
  const summary = { boards: 0, runs: 0, results: { PASS: 0, FAIL: 0, ERROR: 0 }, refused: 0 };

  for (const [index, slot] of slots.entries()) {
    clock.t = Math.max(slot, clock.t);
    // One power board for every three sensor boards
    const product = products[products.length > 1 && random() < 0.25 ? 1 : 0];
    const prefix = product.serialMask.slice(0, product.serialMask.indexOf('#'));
    const serial = `${prefix}${String((serialNumber += 1) % 1_000_000).padStart(6, '0')}`;
    const operator = OPERATORS[Math.floor(clock.t / (8 * HOUR)) % OPERATORS.length];
    summary.boards += 1;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const runId = crypto.randomUUID();
      try {
        await store.reserve({ runId, serial, productCode: product.code, recipeRevision: product.revision, source: 'simulation', transport: 'simulator' });
      } catch {
        summary.refused += 1; // FAIL limit reached: the board goes to repair
        break;
      }
      const raw = await runTest({ product, serial, io, now: clock.now });
      const record = await store.saveRun({
        runId,
        serial,
        operator,
        productCode: product.code,
        recipeRevision: product.revision,
        source: 'simulation',
        transport: 'simulator',
        startedAt: raw.startedAt,
        finishedAt: raw.finishedAt,
        steps: raw.steps,
        teardown: raw.teardown,
        error: raw.error,
        log: raw.log,
        appVersion: 'örnek veri',
      });
      summary.runs += 1;
      summary.results[record.result] += 1;
      if (record.result === 'PASS') break;
      // ERROR: reseat and retest; FAIL: the operator retests now and then
      if (record.result === 'FAIL' && random() < 0.4) break;
      clock.advance(60_000 + random() * 240_000);
    }
    clock.advance(30_000 + random() * 60_000);
    onProgress?.(index + 1, slots.length);
  }
  return summary;
}
