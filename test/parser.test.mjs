import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, createLineSplitter, rowsToCsv, toNumber } from '../public/js/parser.js';

const LABELS = [
  { prefix: 'A', label: 'Sıcaklık' },
  { prefix: 'B', label: 'Nem' },
];

test('toNumber accepts numeric strings only', () => {
  assert.equal(toNumber('25.5'), 25.5);
  assert.equal(toNumber('-3'), -3);
  assert.equal(toNumber('1e3'), 1000);
  assert.equal(toNumber('.5'), 0.5);
  assert.equal(toNumber('12abc'), null);
  assert.equal(toNumber('---'), null);
  assert.equal(toNumber(''), null);
});

test('prefix format maps configured labels in order', () => {
  const fields = parseLine('A25.5,B60', LABELS);
  assert.deepEqual(
    fields.map((f) => [f.label, f.value]),
    [['Sıcaklık', 25.5], ['Nem', 60]]
  );
});

test('missing configured keys are reported as "---"', () => {
  const [temp, hum] = parseLine('A21', LABELS);
  assert.equal(temp.value, 21);
  assert.equal(hum.raw, '---');
  assert.equal(hum.value, null);
});

test('unconfigured keys are still shown after configured ones', () => {
  const fields = parseLine('A1,B2,C1013,D500', LABELS);
  assert.deepEqual(fields.map((f) => f.label), ['Sıcaklık', 'Nem', 'C', 'D']);
});

test('multi-letter prefixes and negative values', () => {
  const fields = parseLine('TEMP-4.5, HUM 80', []);
  assert.deepEqual(fields.map((f) => [f.key, f.value]), [['TEMP', -4.5], ['HUM', 80]]);
});

test('key:value and key=value pairs with mixed separators', () => {
  const fields = parseLine('temp: 25.1; hum=60\tstatus:ok', []);
  assert.deepEqual(
    fields.map((f) => [f.key, f.raw, f.value]),
    [['temp', '25.1', 25.1], ['hum', '60', 60], ['status', 'ok', null]]
  );
});

test('JSON objects are detected', () => {
  const fields = parseLine('{"temp": 22.5, "hum": 41, "ok": true, "nested": {"x": 1}}', [{ prefix: 'temp', label: 'Sıcaklık' }]);
  assert.deepEqual(
    fields.map((f) => [f.label, f.raw]),
    [['Sıcaklık', '22.5'], ['hum', '41'], ['ok', 'true']]
  );
});

test('invalid JSON falls back to delimited parsing', () => {
  const fields = parseLine('{broken', []);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].raw, '{broken');
});

test('plain CSV values get positional keys', () => {
  const fields = parseLine('1.5,2.5,3.5', []);
  assert.deepEqual(fields.map((f) => [f.key, f.value]), [['#1', 1.5], ['#2', 2.5], ['#3', 3.5]]);
});

test('empty and whitespace lines produce no fields', () => {
  assert.deepEqual(parseLine('', LABELS), []);
  assert.deepEqual(parseLine('   ', LABELS), []);
  assert.deepEqual(parseLine(undefined), []);
});

test('duplicate or empty label prefixes are ignored', () => {
  const fields = parseLine('A1', [{ prefix: 'A', label: 'x' }, { prefix: 'A', label: 'y' }, { prefix: '', label: 'z' }]);
  assert.deepEqual(fields.map((f) => f.label), ['x']);
});

test('line splitter handles chunk boundaries and CRLF', () => {
  const splitter = createLineSplitter();
  assert.deepEqual(splitter.push('A1,B'), []);
  assert.deepEqual(splitter.push('2\r\nA3'), ['A1,B2']);
  assert.deepEqual(splitter.push(',B4\nA5\r\n\r\n'), ['A3,B4', 'A5']);
  assert.deepEqual(splitter.flush(), []);
  splitter.push('tail');
  assert.deepEqual(splitter.flush(), ['tail']);
});

test('line splitter flushes overly long lines without a newline', () => {
  const splitter = createLineSplitter(10);
  assert.deepEqual(splitter.push('x'.repeat(15)), ['x'.repeat(15)]);
});

test('rowsToCsv builds a column per label and escapes cells', () => {
  const rows = [
    { time: 't1', raw: 'A1,B2', fields: [{ label: 'A', raw: '1' }, { label: 'B', raw: '2' }] },
    { time: 't2', raw: 'msg:"hi", there', fields: [{ label: 'msg', raw: '"hi"' }] },
  ];
  assert.equal(
    rowsToCsv(rows),
    ['time,A,B,msg,raw', 't1,1,2,,"A1,B2"', 't2,,,"""hi""","msg:""hi"", there"'].join('\n')
  );
});
