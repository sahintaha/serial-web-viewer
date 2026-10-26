// Sample data for the browser-only demo: produced by the real runner, simulator and store.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalDb } from '../public/js/local-db.js';
import { LocalStore } from '../public/js/results-store.js';
import { generateSampleData } from '../public/js/demo-data.js';

let n = 0;
const freshStore = () => new LocalStore({ db: new LocalDb({ name: `sv-demo-${++n}-${Date.now()}`, legacyStorage: null }) }).init();
const NOW = Date.parse('2026-10-26T12:00:00Z');

async function generate(options = {}) {
  const store = await freshStore();
  const summary = await generateSampleData(store, { days: 7, seed: 42, now: NOW, firstSerial: 1000, ...options });
  const runs = (await store.allRuns()).sort((a, b) => a.id - b.id);
  return { store, summary, runs };
}

test('sample data is a week of simulated production stored through the normal path', async () => {
  const { summary, runs } = await generate();
  assert.equal(runs.length, summary.runs);
  assert.ok(summary.boards >= 60, `${summary.boards} boards`);
  assert.ok(runs.every((r) => r.source === 'simulation' && r.transport === 'simulator'), 'never mixed with production data');
  assert.ok(runs.every((r) => Date.parse(r.finishedAt) < NOW && Date.parse(r.startedAt) >= NOW - 8 * 86400_000));
  assert.ok(runs.every((r) => Date.parse(r.finishedAt) > Date.parse(r.startedAt)), 'runs take time on the virtual clock');
  // The simulator's defects show up as real verdicts
  assert.ok(summary.results.PASS > summary.results.FAIL && summary.results.FAIL > 0 && summary.results.ERROR > 0, JSON.stringify(summary.results));
  // An intermittent board gives ERROR first and passes on the retest, through the retest policy
  const retested = runs.filter((r) => r.attempt === 2);
  assert.ok(retested.length > 0);
  for (const r of retested) assert.ok(runs.some((x) => x.serial === r.serial && x.attempt === 1));
  // Measurements, steps and the communication log are complete records
  const pass = runs.find((r) => r.result === 'PASS');
  assert.ok(pass.measurements.length >= 2 && pass.log.length > 10 && pass.safety.state === 'SAFE');
});

test('the same seed gives the same week', async () => {
  const a = await generate();
  const b = await generate();
  const outline = (runs) => runs.map((r) => `${r.serial}:${r.attempt}:${r.result}:${r.finishedAt}`);
  assert.deepEqual(outline(a.runs), outline(b.runs));
});

test('reports show the sample data under the simulation source only', async () => {
  const { store, runs } = await generate();
  const production = await store.report({ source: 'production', tz: 'Europe/Istanbul' });
  assert.deepEqual(production.products, []);
  const simulation = await store.report({ source: 'simulation', tz: 'Europe/Istanbul' });
  assert.equal(simulation.products.reduce((sum, p) => sum + p.tests, 0), runs.length);
  assert.ok(new Set(simulation.daily.map((d) => d.day)).size >= 5, 'several days');
  const voltage = await store.measurementReport({ source: 'simulation' }, 'SVB-100', 'V');
  assert.ok(voltage.n >= 30 && voltage.cpk !== null, `n=${voltage.n} cpk=${voltage.cpk}`);
});

test('deleting simulation records removes the sample data and is audited', async () => {
  const { store, runs } = await generate({ days: 2 });
  assert.equal(await store.deleteSimulationRuns(), runs.length);
  assert.equal((await store.allRuns()).length, 0);
  const audit = await store.audit({ entity: 'runs' });
  assert.equal(audit[0].detail.count, runs.length);
});
