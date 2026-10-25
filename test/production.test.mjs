import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIMITS,
  normalizeSerial,
  validateSerial,
  validateLimits,
  evaluateTest,
  prepareTestRecord,
  resultsToCsv,
  summarize,
  filterRecords,
} from '../public/js/production.js';

const LIMITS = [
  { key: 'V', name: 'Voltaj', unit: 'V', min: 4.9, max: 5.1 },
  { key: 'I', name: 'Akım', unit: 'mA', min: 0, max: 150 },
];

function submission(overrides = {}) {
  return {
    serial: 'pcb-000142',
    operator: 'Taha',
    sampleCount: 3,
    startedAt: '2026-10-25T10:00:00.000Z',
    finishedAt: '2026-10-25T10:00:02.000Z',
    limits: LIMITS,
    samples: { V: [5.01, 5.02, 5.03], I: [118, 120, 122] },
    ...overrides,
  };
}

test('serial numbers are normalized and validated', () => {
  assert.equal(normalizeSerial('  pcb-000142 '), 'PCB-000142');
  assert.equal(validateSerial('PCB-000142'), null);
  assert.equal(validateSerial('A_1-B'), null);
  assert.match(validateSerial(''), /boş/);
  assert.ok(validateSerial('AB'));
  assert.ok(validateSerial('PCB 0001'));
  assert.ok(validateSerial('-PCB'));
  assert.ok(validateSerial('X'.repeat(41)));
});

test('default limits are valid', () => {
  assert.deepEqual(validateLimits(DEFAULT_LIMITS).errors, []);
});

test('limits: numeric strings from form inputs are converted', () => {
  const { limits, errors } = validateLimits([{ key: 'T', name: '', unit: '°C', min: '20', max: '30.5' }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(limits[0], { key: 'T', name: 'T', unit: '°C', min: 20, max: 30.5 });
});

test('limits: invalid tables are rejected with row numbers', () => {
  assert.match(validateLimits([]).errors[0], /En az bir/);
  const { errors } = validateLimits([
    { key: 'V', min: 1, max: 2 },
    { key: 'V', min: 1, max: 2 },
    { key: '', min: 'x', max: 2 },
    { key: 'A B', min: 5, max: 1 },
  ]);
  assert.ok(errors.some((e) => /Satır 2: "V" anahtarı tekrar/.test(e)));
  assert.ok(errors.some((e) => /Satır 3: anahtar boş/.test(e)));
  assert.ok(errors.some((e) => /Satır 3: minimum sayı/.test(e)));
  assert.ok(errors.some((e) => /Satır 4: geçersiz anahtar/.test(e)));
  assert.ok(errors.some((e) => /Satır 4: minimum, maksimumdan büyük/.test(e)));
});

test('evaluate: PASS when every mean is within limits', () => {
  const r = evaluateTest({ V: [5.0, 5.02], I: [100, 110] }, LIMITS, { sampleCount: 2 });
  assert.equal(r.result, 'PASS');
  assert.equal(r.reason, null);
  assert.equal(r.measurements[0].value, 5.01);
  assert.equal(r.measurements[1].count, 2);
});

test('evaluate: limits are inclusive', () => {
  const r = evaluateTest({ V: [4.9], I: [150] }, LIMITS, { sampleCount: 1 });
  assert.equal(r.result, 'PASS');
});

test('evaluate: FAIL names the measurement and the violated bound', () => {
  const r = evaluateTest({ V: [5.2, 5.2], I: [120, 120] }, LIMITS, { sampleCount: 2 });
  assert.equal(r.result, 'FAIL');
  assert.equal(r.measurements[0].status, 'FAIL');
  assert.match(r.reason, /Voltaj limit dışı \(5\.2 V > 5\.1 V\)/);

  const low = evaluateTest({ V: [5], I: [-3] }, LIMITS, { sampleCount: 1 });
  assert.match(low.reason, /Akım limit dışı \(-3 mA < 0 mA\)/);
});

test('evaluate: missing samples give ERROR, not FAIL', () => {
  const r = evaluateTest({ V: [5.0, 5.0, 5.0], I: [120] }, LIMITS, { sampleCount: 3 });
  assert.equal(r.result, 'ERROR');
  assert.equal(r.measurements[1].status, 'MISSING');
  assert.match(r.reason, /Eksik ölçüm: Akım \(1\/3\)/);
});

test('evaluate: a known failure wins over missing data or an aborted run', () => {
  const r = evaluateTest({ V: [6, 6] }, LIMITS, { sampleCount: 2, error: 'Bağlantı koptu' });
  assert.equal(r.result, 'FAIL');
});

test('evaluate: run errors are reported as ERROR with the given reason', () => {
  const r = evaluateTest({ V: [5], I: [100] }, LIMITS, { sampleCount: 1, error: 'Bağlantı koptu' });
  assert.equal(r.result, 'ERROR');
  assert.equal(r.reason, 'Bağlantı koptu');
});

test('evaluate: non-finite samples are ignored', () => {
  const r = evaluateTest({ V: [5, NaN, Infinity, '5'], I: [100] }, LIMITS, { sampleCount: 1 });
  assert.equal(r.measurements[0].count, 1);
  assert.equal(r.result, 'PASS');
});

test('prepareTestRecord: accepts a valid run and evaluates it', () => {
  const { errors, value } = prepareTestRecord(submission());
  assert.deepEqual(errors, []);
  assert.equal(value.serial, 'PCB-000142');
  assert.equal(value.result, 'PASS');
  assert.equal(value.measurements.length, 2);
});

test('prepareTestRecord: ignores a client-supplied verdict', () => {
  const { value } = prepareTestRecord(submission({ result: 'PASS', samples: { V: [9, 9, 9], I: [1, 1, 1] } }));
  assert.equal(value.result, 'FAIL');
});

test('prepareTestRecord: rejects malformed input', () => {
  const cases = [
    [{ serial: '' }, /Seri numarası boş/],
    [{ sampleCount: 0 }, /Örnek sayısı/],
    [{ sampleCount: 2.5 }, /Örnek sayısı/],
    [{ startedAt: 'yesterday' }, /zaman/],
    [{ finishedAt: '2026-10-25T09:00:00.000Z' }, /Bitiş zamanı/],
    [{ limits: [] }, /limit/],
    [{ samples: { V: [5, '5.1', 5], I: [1, 1, 1] } }, /"V" için ölçüm verisi geçersiz/],
    [{ samples: { V: 'abc' } }, /"V" için/],
  ];
  for (const [override, pattern] of cases) {
    const { errors } = prepareTestRecord(submission(override));
    assert.ok(errors.some((e) => pattern.test(e)), `${JSON.stringify(override)} → ${errors}`);
  }
  assert.ok(prepareTestRecord(null).errors.length > 0);
});

test('resultsToCsv: one row per test, value + status per measurement', () => {
  const { value } = prepareTestRecord(submission({ samples: { V: [5.2, 5.2, 5.2], I: [1, 2, 3] } }));
  const csv = resultsToCsv([{ id: 7, attempt: 2, ...value }]);
  const [header, row] = csv.split('\n');
  assert.equal(
    header,
    'id,serial,attempt,result,reason,operator,started_at,finished_at,sample_count,Voltaj [V],Voltaj [V] status,Akım [mA],Akım [mA] status'
  );
  assert.match(row, /^7,PCB-000142,2,FAIL,Voltaj limit dışı \(5\.2 V > 5\.1 V\),Taha,/);
  assert.match(row, /,5\.2,FAIL,2,PASS$/);
});

test('summarize and filterRecords', () => {
  const records = [
    { serial: 'PCB-1', result: 'PASS', finishedAt: '2026-10-24T10:00:00.000Z' },
    { serial: 'PCB-2', result: 'FAIL', finishedAt: '2026-10-25T10:00:00.000Z' },
    { serial: 'XYZ-3', result: 'PASS', finishedAt: '2026-10-25T12:00:00.000Z' },
    { serial: 'PCB-2', result: 'ERROR', finishedAt: '2026-10-25T13:00:00.000Z' },
  ];
  assert.deepEqual(summarize(records), { total: 4, PASS: 2, FAIL: 1, ERROR: 1, yield: 50 });
  assert.deepEqual(summarize([]).yield, null);
  assert.equal(filterRecords(records, { serial: 'pcb' }).length, 3);
  assert.equal(filterRecords(records, { result: 'PASS' }).length, 2);
  assert.equal(filterRecords(records, { from: '2026-10-25T00:00:00.000Z', to: '2026-10-25T12:00:00.000Z' }).length, 2);
});
