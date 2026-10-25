// Acceptance tests for measurement correctness: no invalid, overflowing, missing or
// malformed data may ever produce a PASS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toNumber, parseLine } from '../public/js/parser.js';
import { DEFAULT_PRODUCTS, validateProduct, evaluateStep, evaluateRun, sampleStats } from '../public/js/recipe.js';
import { prepareTestRecord } from '../public/js/production.js';

const SENSOR = { ...validateProduct(DEFAULT_PRODUCTS[0]).product, revision: 1 };
const MEASURE = SENSOR.recipe.steps.find((s) => s.type === 'measure'); // V 4.9–5.1, I 80–150, 5 samples
const withMode = (evaluate) => ({ ...MEASURE, evaluate });
const ok = 'V5.0,I115';

test('toNumber rejects values that overflow to ±Infinity', () => {
  for (const raw of ['1e999', '-1e999', '+1e400', '9'.repeat(400)]) assert.equal(toNumber(raw), null, raw);
  assert.equal(toNumber('1e308'), 1e308);
  assert.equal(toNumber(Infinity), null);
  assert.equal(toNumber(NaN), null);
  assert.equal(parseLine('V1e999')[0].value, null);
});

const NEVER_PASS = {
  'V overflow +': ['V1e999,I115', ok, ok, ok, ok],
  'V overflow -': ['V-1e999,I115', ok, ok, ok, ok],
  'overflow both signs (former NaN mean)': ['V1e999,I115', 'V-1e999,I115', ok, ok, ok],
  'literal NaN': ['VNaN,I115', ok, ok, ok, ok],
  'literal Infinity': ['VInfinity,I115', ok, ok, ok, ok],
  'non-numeric value': ['Vabc,I115', ok, ok, ok, ok],
  'empty value': ['V,I115', ok, ok, ok, ok],
  'missing key in one reply': ['I115', ok, ok, ok, ok],
  'one reply lost': [null, ok, ok, ok, ok],
  'too few replies': [ok, ok, ok],
  'no replies': [],
  'garbage reply': ['%%%', ok, ok, ok, ok],
  'huge finite values whose sum overflows': Array(5).fill('V1.7e308,I115'),
  'six replies for five samples': [ok, ok, ok, ok, ok, ok],
};

for (const mode of ['mean', 'min', 'max', 'all']) {
  for (const [name, replies] of Object.entries(NEVER_PASS)) {
    test(`[${mode}] ${name} is never PASS`, () => {
      const r = evaluateStep(withMode(mode), { replies });
      assert.notEqual(r.status, 'PASS', JSON.stringify(r.measurements?.map((m) => [m.key, m.value, m.status])));
      for (const m of r.measurements ?? []) assert.ok(m.status !== 'PASS' || Number.isFinite(m.value));
    });
  }
}

test('invalid values are reported as ERROR with a clear reason, not FAIL', () => {
  const r = evaluateStep(MEASURE, { replies: ['V1e999,I115', ok, ok, ok, ok] });
  assert.equal(r.status, 'ERROR');
  assert.match(r.reason, /Geçersiz ölçüm değeri .*Voltaj/);
  assert.equal(r.measurements[0].status, 'INVALID');
  assert.equal(r.measurements[0].invalid, 1);
});

test('a real out-of-limit value still wins over invalid data elsewhere', () => {
  const r = evaluateStep(MEASURE, { replies: Array(5).fill('V1e999,I300') });
  assert.equal(r.status, 'FAIL');
  assert.match(r.reason, /Akım limit dışı/);
});

test('evaluation modes', () => {
  // mean inside, one sample outside
  const spiky = ['V5.0,I100', 'V5.0,I100', 'V5.0,I100', 'V5.0,I100', 'V5.0,I155'];
  assert.equal(evaluateStep(withMode('mean'), { replies: spiky }).status, 'PASS');
  const all = evaluateStep(withMode('all'), { replies: spiky });
  assert.equal(all.status, 'FAIL');
  assert.equal(all.measurements[1].value, 155);
  assert.match(all.reason, /Akım \(her örnek limit içinde\) limit dışı \(155 mA > 150 mA\)/);
  assert.equal(evaluateStep(withMode('max'), { replies: spiky }).status, 'FAIL');
  assert.equal(evaluateStep(withMode('min'), { replies: spiky }).status, 'PASS');

  const low = ['V5.0,I70', 'V5.0,I120', 'V5.0,I120', 'V5.0,I120', 'V5.0,I120'];
  assert.equal(evaluateStep(withMode('min'), { replies: low }).status, 'FAIL');
  assert.equal(evaluateStep(withMode('mean'), { replies: low }).status, 'PASS');
});

test('the evaluation mode and sample statistics are kept in the result', () => {
  const r = evaluateStep(withMode('max'), { replies: ['V4.95,I100', 'V5.0,I110', 'V5.05,I120', 'V5.0,I110', 'V5.0,I110'] });
  const v = r.measurements[0];
  assert.equal(v.mode, 'max');
  assert.equal(v.value, 5.05);
  assert.deepEqual(Object.keys(v.stats), ['n', 'mean', 'min', 'max', 'sd']);
  assert.equal(v.stats.n, 5);
  assert.equal(v.stats.min, 4.95);
  assert.ok(Math.abs(v.stats.mean - 5.0) < 1e-12);
});

test('sampleStats never returns non-finite numbers', () => {
  const s = sampleStats([1.7e308, 1.7e308, -1.7e308]);
  for (const v of Object.values(s)) assert.ok(v === null || Number.isFinite(v), String(v));
  assert.deepEqual(sampleStats([]), { n: 0, mean: null, min: null, max: null, sd: null });
});

test('unknown evaluation modes are rejected when the recipe is saved', () => {
  const p = structuredClone(DEFAULT_PRODUCTS[0]);
  p.recipe.steps[4].evaluate = 'median';
  assert.ok(validateProduct(p).errors.some((e) => /evaluate "mean", "min", "max", "all"/.test(e)));
});

test('a whole run with an overflowing measurement is not PASS', () => {
  const steps = [{ reply: 'OK' }, { reply: 'ID SVB-100 FW1.4.2' }, { reply: 'OK' }, {}, { replies: ['V1e999,I115', 'V-1e999,I115', ok, ok, ok] }, { reply: 'OK' }, { reply: 'OK', answer: true }];
  const r = evaluateRun(SENSOR.recipe, steps, []);
  assert.equal(r.result, 'ERROR');
  assert.equal(r.failedStep, 4);
});

test('the server-side record check rejects data that does not match the recipe', () => {
  const base = {
    serial: 'SNS-000001',
    productCode: 'SVB-100',
    recipeRevision: 1,
    startedAt: '2026-10-26T10:00:00.000Z',
    finishedAt: '2026-10-26T10:00:03.000Z',
  };
  const tooMany = prepareTestRecord({ ...base, steps: [{ reply: 'OK' }, { reply: 'ID SVB-100 FW1.4.2' }, { reply: 'OK' }, {}, { replies: Array(6).fill(ok) }] }, SENSOR);
  assert.ok(tooMany.errors.some((e) => /reçetede 5 örnek var, 6 cevap/.test(e)));
  const wrongShape = prepareTestRecord({ ...base, steps: [{ replies: [ok] }] }, SENSOR);
  assert.ok(wrongShape.errors.some((e) => /ölçüm cevabı içeremez/.test(e)));
  const answerOnCommand = prepareTestRecord({ ...base, steps: [{ reply: 'OK', answer: true }] }, SENSOR);
  assert.ok(answerOnCommand.errors.some((e) => /operatör cevabı içeremez/.test(e)));
  const noReplies = prepareTestRecord({ ...base, steps: [{ reply: 'OK' }, { reply: 'ID SVB-100 FW1.4.2' }, { reply: 'OK' }, {}, { reply: 'V5,I100' }] }, SENSOR);
  assert.ok(noReplies.errors.some((e) => /ölçüm cevapları eksik/.test(e)));
});
