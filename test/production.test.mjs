import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRODUCTS, validateProduct } from '../public/js/recipe.js';
import { prepareTestRecord, resultsToCsv, summarize, filterRecords, unitStatus, cleanLog } from '../public/js/production.js';

const SENSOR = { ...validateProduct(DEFAULT_PRODUCTS[0]).product, revision: 3 };

const GOOD_STEPS = [
  { reply: 'OK', attempts: 1, durationMs: 20 },
  { reply: 'ID SVB-100 FW1.4.2', attempts: 1 },
  { reply: 'OK', attempts: 1 },
  { durationMs: 300 },
  { replies: ['V5.01,I115', 'V5.0,I116', 'V5.02,I114', 'V5.0,I115', 'V5.01,I115'] },
  { reply: 'OK', attempts: 1 },
  { reply: 'OK', attempts: 1, answer: true },
];

function submission(overrides = {}) {
  return {
    serial: 'sns-000142',
    operator: 'Taha',
    productCode: 'SVB-100',
    recipeRevision: 3,
    startedAt: '2026-10-25T10:00:00.000Z',
    finishedAt: '2026-10-25T10:00:04.500Z',
    steps: GOOD_STEPS,
    teardown: [{ reply: 'OK' }, { reply: 'OK' }, { reply: 'PWR=0 LED=0 WDT=0' }],
    ...overrides,
  };
}

test('prepareTestRecord evaluates the run against the given revision', () => {
  const { errors, value } = prepareTestRecord(submission(), SENSOR);
  assert.deepEqual(errors, []);
  assert.equal(value.serial, 'SNS-000142');
  assert.equal(value.productCode, 'SVB-100');
  assert.equal(value.recipeRevision, 3);
  assert.equal(value.result, 'PASS');
  assert.equal(value.measurements.length, 2);
  assert.equal(value.steps[4].data.replies.length, 5);
});

test('prepareTestRecord ignores any verdict sent by the client', () => {
  const steps = [...GOOD_STEPS];
  steps[4] = { replies: Array(5).fill('V5.0,I190') };
  const { value } = prepareTestRecord(submission({ steps, result: 'PASS', reason: null }), SENSOR);
  assert.equal(value.result, 'FAIL');
  assert.match(value.reason, /Akım limit dışı/);
});

test('prepareTestRecord: run-level errors', () => {
  const { value } = prepareTestRecord(submission({ steps: GOOD_STEPS.slice(0, 2), error: 'Test sırasında cihaz bağlantısı koptu' }), SENSOR);
  assert.equal(value.result, 'ERROR');
  assert.equal(value.reason, 'Test sırasında cihaz bağlantısı koptu');
});

test('prepareTestRecord rejects malformed input', () => {
  const cases = [
    [{ serial: 'PWR-000142' }, /"SNS-######" biçiminde/],
    [{ startedAt: 'dün' }, /zaman/],
    [{ finishedAt: '2026-10-25T09:00:00.000Z' }, /Bitiş zamanı/],
    [{ steps: 'x' }, /Adım geçersiz/],
    [{ steps: Array(8).fill({}) }, /Adım geçersiz/],
    [{ steps: [{ reply: 5 }] }, /Adım 1: adım verisi geçersiz/],
    [{ steps: [{ reply: 'x'.repeat(300) }] }, /Adım 1/],
    [{ steps: [{ replies: 'V5' }] }, /Adım 1/],
    [{ steps: [{ answer: 'evet' }] }, /Adım 1/],
    [{ teardown: [{ attempts: 0 }] }, /Teardown 1/],
  ];
  for (const [override, pattern] of cases) {
    const { errors } = prepareTestRecord(submission(override), SENSOR);
    assert.ok(errors.some((e) => pattern.test(e)), `${JSON.stringify(override).slice(0, 60)} → ${errors}`);
  }
  assert.deepEqual(prepareTestRecord(submission(), null).errors, ['Ürün / reçete revizyonu bulunamadı']);
});

test('resultsToCsv: product, revision, failed step and one column pair per measurement', () => {
  const steps = [...GOOD_STEPS];
  steps[4] = { replies: Array(5).fill('V5.0,I190') };
  const { value } = prepareTestRecord(submission({ steps }), SENSOR);
  const [header, row] = resultsToCsv([{ id: 7, attempt: 2, ...value }]).split('\n');
  assert.equal(
    header,
    'id,serial,product,recipe_revision,attempt,result,failed_step,reason,operator,started_at,finished_at,duration_s,' +
      'Voltaj [V],Voltaj [V] status,Akım [mA],Akım [mA] status'
  );
  assert.match(row, /^7,SNS-000142,SVB-100,3,2,FAIL,5,Adım 5 \(Besleme ölçümü\): Akım limit dışı .*,Taha,.*,4\.5,5,PASS,190,FAIL$/);
});

test('summarize and filterRecords', () => {
  const records = [
    { serial: 'SNS-1', productCode: 'SVB-100', result: 'PASS', finishedAt: '2026-10-24T10:00:00.000Z' },
    { serial: 'SNS-2', productCode: 'SVB-100', result: 'FAIL', finishedAt: '2026-10-25T10:00:00.000Z' },
    { serial: 'PWR-3', productCode: 'SVB-200', result: 'PASS', finishedAt: '2026-10-25T12:00:00.000Z' },
    { serial: 'SNS-2', productCode: 'SVB-100', result: 'ERROR', finishedAt: '2026-10-25T13:00:00.000Z' },
  ];
  assert.deepEqual(summarize(records), { total: 4, PASS: 2, FAIL: 1, ERROR: 1, yield: 50 });
  assert.equal(summarize([]).yield, null);
  assert.equal(filterRecords(records, { serial: 'sns' }).length, 3);
  assert.equal(filterRecords(records, { product: 'SVB-200' }).length, 1);
  assert.equal(filterRecords(records, { result: 'PASS' }).length, 2);
  assert.equal(filterRecords(records, { from: '2026-10-25T00:00:00.000Z', to: '2026-10-25T12:00:00.000Z' }).length, 2);
});

test('unitStatus: only FAIL counts towards the retest limit', () => {
  const r = (result, h) => ({ result, finishedAt: `2026-10-25T1${h}:00:00.000Z` });
  assert.deepEqual(unitStatus([], 3), { attempts: 0, failures: 0, passed: false, lastResult: null, lastAt: null, blocked: false });
  const flaky = unitStatus([r('ERROR', 0), r('ERROR', 1), r('FAIL', 2)], 2);
  assert.equal(flaky.blocked, false);
  assert.equal(flaky.lastResult, 'FAIL');
  assert.equal(unitStatus([r('FAIL', 0), r('FAIL', 1)], 2).blocked, true);
  assert.equal(unitStatus([r('FAIL', 0), r('FAIL', 1), r('PASS', 2)], 2).blocked, false);
});

test('cleanLog keeps well-formed entries only', () => {
  const log = cleanLog([
    { t: 1.6, dir: 'TX', text: 'MEAS?' },
    { t: 5, dir: 'RX', text: 'x'.repeat(400) },
    { t: 'x', dir: 'RX', text: 'bad' },
    { t: 1, dir: 'HACK', text: 'bad' },
    null,
  ]);
  assert.deepEqual(log.map((e) => [e.t, e.dir, e.text.length]), [[2, 'TX', 5], [5, 'RX', 256]]);
  assert.deepEqual(cleanLog('nope'), []);
});
