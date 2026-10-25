import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRODUCTS,
  validateProduct,
  validateSerial,
  maskToRegExp,
  globMatch,
  replyText,
  renderCommand,
  evaluateStep,
  evaluateRun,
} from '../public/js/recipe.js';

const SENSOR = validateProduct(DEFAULT_PRODUCTS[0]).product;

test('default products are valid', () => {
  for (const p of DEFAULT_PRODUCTS) assert.deepEqual(validateProduct(p).errors, [], p.code);
});

test('serial masks', () => {
  assert.equal(maskToRegExp('SNS-######').source, '^SNS\\-\\d\\d\\d\\d\\d\\d$');
  assert.equal(validateSerial('SNS-000142', 'SNS-######'), null);
  assert.match(validateSerial('SNS-00014', 'SNS-######'), /"SNS-######" biçiminde/);
  assert.match(validateSerial('PWR-000142', 'SNS-######'), /biçiminde/);
  assert.equal(validateSerial('AB-1X', '@@-#?'), null);
  assert.ok(validateSerial('A1-1X', '@@-#?'));
  // Regex metacharacters in a mask are literals
  assert.equal(validateSerial('A.B', 'A.@'), null);
  assert.ok(validateSerial('AXB', 'A.@'));
});

test('globMatch handles * and ? without backtracking blow-ups', () => {
  assert.ok(globMatch('OK', 'OK'));
  assert.ok(globMatch('ID SVB-100 FW1.4.*', 'ID SVB-100 FW1.4.2'));
  assert.ok(!globMatch('ID SVB-100 FW1.4.*', 'ID SVB-100 FW1.3.9'));
  assert.ok(globMatch('V?.??', 'V5.01'));
  assert.ok(globMatch('*', ''));
  assert.ok(!globMatch('OK', 'OKAY'));
  const started = Date.now();
  assert.ok(!globMatch('*a*a*a*a*a*a*a*a*b', 'a'.repeat(200)));
  assert.ok(Date.now() - started < 100);
});

test('protocol helpers', () => {
  assert.equal(replyText('@OK'), 'OK');
  assert.equal(replyText('@ ERR X '), 'ERR X');
  assert.equal(replyText('A25,B60'), null);
  assert.equal(renderCommand('SN {serial}', { serial: 'SNS-1' }), 'SN SNS-1');
});

test('validateProduct reports precise errors', () => {
  const { errors } = validateProduct({
    code: 'x',
    name: '',
    serialMask: 'ABC',
    maxAttempts: 0,
    recipe: {
      stopOnFail: 'yes',
      steps: [
        { type: 'command', send: '' },
        { type: 'measure', send: 'MEAS?', samples: 0, limits: [{ key: 'V', min: 5, max: 4 }] },
        { type: 'confirm' },
        { type: 'reboot' },
        { type: 'delay', ms: -1 },
      ],
      teardown: [{ type: 'measure', send: 'MEAS?' }],
    },
  });
  const expected = [
    /Ürün kodu/,
    /Ürün adı/,
    /Seri no maskesi/,
    /maxAttempts/,
    /stopOnFail/,
    /Adım 1: send boş/,
    /Adım 2: samples 1–100/,
    /Adım 2: limit 1: minimum, maksimumdan büyük/,
    /Adım 3: prompt/,
    /Adım 4: tip/,
    /Adım 5: ms 0–60000/,
    /Teardown 1: tip "command", "delay"/,
  ];
  for (const pattern of expected) assert.ok(errors.some((e) => pattern.test(e)), `${pattern} in ${errors.join(' | ')}`);
});

test('validateProduct fills defaults', () => {
  const { product, errors } = validateProduct({
    code: 'abc-1',
    name: 'Kart',
    serialMask: 'ab-###',
    recipe: { steps: [{ type: 'command', send: 'PING' }, { type: 'measure', send: 'M?', limits: [{ key: 'V', min: '1', max: '2' }] }] },
  });
  assert.deepEqual(errors, []);
  assert.equal(product.code, 'ABC-1');
  assert.equal(product.serialMask, 'AB-###');
  assert.equal(product.maxAttempts, 3);
  assert.equal(product.recipe.stopOnFail, true);
  assert.deepEqual(product.recipe.teardown, []);
  assert.deepEqual(product.recipe.steps[0], { type: 'command', name: 'Komut', send: 'PING', timeoutMs: 1000, retries: 0, expect: 'OK' });
  assert.equal(product.recipe.steps[1].samples, 1);
  assert.equal(product.recipe.steps[1].limits[0].min, 1);
});

test('evaluateStep: command', () => {
  const step = { type: 'command', expect: 'ID SVB-100 FW1.4.*' };
  assert.equal(evaluateStep(step, { reply: 'ID SVB-100 FW1.4.2', attempts: 1 }).status, 'PASS');
  assert.match(evaluateStep(step, { reply: 'ID SVB-100 FW1.3.9' }).reason, /Beklenen "ID SVB-100 FW1.4.\*", gelen "ID SVB-100 FW1.3.9"/);
  assert.deepEqual(evaluateStep(step, { reply: 'ERR NOT_POWERED' }), { status: 'FAIL', reason: 'Cihaz hatası: ERR NOT_POWERED' });
  assert.deepEqual(evaluateStep(step, { reply: null, attempts: 2 }), { status: 'ERROR', reason: 'Cevap yok (2 deneme)' });
});

test('evaluateStep: measure uses the mean of all samples', () => {
  const step = SENSOR.recipe.steps[4];
  const pass = evaluateStep(step, { replies: ['V5.0,I100', 'V5.02,I110', 'V4.98,I120', 'V5.0,I100', 'V5.0,I120'] });
  assert.equal(pass.status, 'PASS');
  assert.equal(pass.measurements[1].value, 110);

  const fail = evaluateStep(step, { replies: Array(5).fill('V5.0,I170') });
  assert.equal(fail.status, 'FAIL');
  assert.match(fail.reason, /Akım limit dışı \(170 mA > 150 mA\)/);

  const missing = evaluateStep(step, { replies: ['V5.0,I100', null, 'V5.0', null, 'V5.0,I100'] });
  assert.equal(missing.status, 'ERROR');
  assert.match(missing.reason, /Eksik ölçüm: Voltaj 3\/5, Akım 2\/5 \(2 cevapsız istek\)/);

  assert.equal(evaluateStep(step, { replies: ['ERR NOT_POWERED'] }).status, 'FAIL');
});

test('evaluateStep: confirm and delay', () => {
  const step = { type: 'confirm', send: 'LED ON', expect: 'OK', prompt: 'LED yanıyor mu?' };
  assert.equal(evaluateStep(step, { reply: 'OK', answer: true }).status, 'PASS');
  assert.match(evaluateStep(step, { reply: 'OK', answer: false }).reason, /Operatör: "LED yanıyor mu\?" → Hayır/);
  assert.equal(evaluateStep(step, { reply: 'ERR NOT_POWERED', answer: null }).status, 'FAIL');
  assert.equal(evaluateStep({ type: 'delay', ms: 10 }, {}).status, 'PASS');
  assert.equal(evaluateStep({ type: 'delay', ms: 10 }, null).status, 'ERROR');
});

const GOOD_RUN = [
  { reply: 'OK' },
  { reply: 'ID SVB-100 FW1.4.2' },
  { reply: 'OK' },
  {},
  { replies: Array(5).fill('V5.01,I115') },
  { reply: 'OK' },
  { reply: 'OK', answer: true },
];

test('evaluateRun: PASS, FAIL with skipped steps, ERROR', () => {
  const pass = evaluateRun(SENSOR.recipe, GOOD_RUN, [{ reply: 'OK' }, { reply: 'OK' }]);
  assert.equal(pass.result, 'PASS');
  assert.equal(pass.measurements.length, 2);
  assert.equal(pass.measurements[0].step, 4);
  assert.deepEqual(pass.teardown.map((s) => s.status), ['PASS', 'PASS']);

  const fail = evaluateRun(SENSOR.recipe, [...GOOD_RUN.slice(0, 5), { reply: 'ERR SENSOR_FAULT' }]);
  assert.equal(fail.result, 'FAIL');
  assert.equal(fail.failedStep, 5);
  assert.equal(fail.reason, 'Adım 6 (Sensör self-test): Cihaz hatası: ERR SENSOR_FAULT');
  assert.equal(fail.steps[6].status, 'SKIPPED');

  const timeout = evaluateRun(SENSOR.recipe, [{ reply: null, attempts: 1 }]);
  assert.equal(timeout.result, 'ERROR');
  assert.match(timeout.reason, /Adım 1 \(Seri numarasını yaz\): Cevap yok/);
  assert.ok(timeout.steps.slice(1).every((s) => s.status === 'SKIPPED'));
});

test('evaluateRun: aborted runs are ERROR unless the board already failed', () => {
  const cancelled = evaluateRun(SENSOR.recipe, GOOD_RUN.slice(0, 3), [], { error: 'İptal edildi' });
  assert.equal(cancelled.result, 'ERROR');
  assert.equal(cancelled.reason, 'İptal edildi');
  assert.equal(cancelled.steps[3].status, 'SKIPPED');

  const failedThenCancelled = evaluateRun(
    { ...SENSOR.recipe, stopOnFail: false },
    [GOOD_RUN[0], { reply: 'ID SVB-100 FW1.3.9' }],
    [],
    { error: 'İptal edildi' }
  );
  assert.equal(failedThenCancelled.result, 'FAIL');
});

test('evaluateRun: a step that was never executed cannot be smuggled in as PASS', () => {
  const holes = evaluateRun({ ...SENSOR.recipe, stopOnFail: false }, [GOOD_RUN[0], undefined, GOOD_RUN[2]]);
  assert.equal(holes.result, 'ERROR');
  assert.equal(holes.steps[1].reason, 'Adım çalıştırılmadı');
});
