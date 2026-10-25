// ============================================
// PRODUCTION TEST — pure logic shared by the browser and server.js
// (validation, PASS/FAIL evaluation, CSV report). Unit tested in /test.
// ============================================

import { csvCell } from './parser.js';

export const RESULTS = ['PASS', 'FAIL', 'ERROR'];
export const SERIAL_RE = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;
export const MAX_SAMPLE_COUNT = 100;

export const DEFAULT_LIMITS = [
  { key: 'V', name: 'Voltaj', unit: 'V', min: 4.9, max: 5.1 },
  { key: 'I', name: 'Akım', unit: 'mA', min: 0, max: 150 },
];

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isIsoDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** Trims and upper-cases a scanned / typed serial number. */
export function normalizeSerial(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

/** @returns {string|null} error message, or null when valid */
export function validateSerial(serial) {
  if (!serial) return 'Seri numarası boş olamaz';
  if (!SERIAL_RE.test(serial)) {
    return 'Seri numarası 3–40 karakter olmalı; sadece harf, rakam, "-" ve "_" içerebilir';
  }
  return null;
}

/**
 * Validates and normalizes a limit table.
 * @returns {{limits: object[], errors: string[]}}
 */
export function validateLimits(input) {
  const errors = [];
  if (!Array.isArray(input) || input.length === 0) {
    return { limits: [], errors: ['En az bir ölçüm limiti tanımlanmalı'] };
  }
  if (input.length > 32) errors.push('En fazla 32 limit tanımlanabilir');

  const seen = new Set();
  const limits = input.map((raw, i) => {
    const row = i + 1;
    const key = String(raw?.key ?? '').trim();
    const name = String(raw?.name ?? '').trim() || key;
    const unit = String(raw?.unit ?? '').trim();
    const min = typeof raw?.min === 'string' && raw.min.trim() !== '' ? Number(raw.min) : raw?.min;
    const max = typeof raw?.max === 'string' && raw.max.trim() !== '' ? Number(raw.max) : raw?.max;

    if (!key) errors.push(`Satır ${row}: anahtar boş olamaz`);
    else if (key.length > 32 || /[,;=:\s]/.test(key)) errors.push(`Satır ${row}: geçersiz anahtar "${key}"`);
    else if (seen.has(key)) errors.push(`Satır ${row}: "${key}" anahtarı tekrar ediyor`);
    seen.add(key);

    if (!isFiniteNumber(min)) errors.push(`Satır ${row}: minimum sayı olmalı`);
    if (!isFiniteNumber(max)) errors.push(`Satır ${row}: maksimum sayı olmalı`);
    if (isFiniteNumber(min) && isFiniteNumber(max) && min > max) {
      errors.push(`Satır ${row}: minimum, maksimumdan büyük olamaz`);
    }
    return { key, name: name.slice(0, 64), unit: unit.slice(0, 16), min, max };
  });
  return { limits, errors };
}

/** Number formatting that keeps limits readable (5.1 → "5.10" when the limit has 2 decimals). */
export function formatValue(value, digits = 3) {
  if (!isFiniteNumber(value)) return '—';
  return Number(value.toFixed(digits)).toString();
}

/**
 * Turns collected samples into a PASS / FAIL / ERROR verdict.
 *
 * - A measurement FAILs when the mean of its samples is outside [min, max] (inclusive).
 * - A measurement is MISSING when fewer valid samples than required were collected.
 * - The test FAILs if any measurement failed (the board is known bad), otherwise it is
 *   an ERROR when data is missing or the run was aborted, otherwise PASS.
 *
 * @param {Record<string, number[]>} samples valid numeric samples per limit key
 * @param {object[]} limits validated limits
 * @param {{sampleCount: number, error?: string|null}} options
 */
export function evaluateTest(samples, limits, { sampleCount, error = null }) {
  const measurements = limits.map((limit) => {
    const values = (samples?.[limit.key] ?? []).filter(isFiniteNumber);
    const value = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    let status;
    if (values.length < sampleCount) status = 'MISSING';
    else if (value < limit.min || value > limit.max) status = 'FAIL';
    else status = 'PASS';
    return { ...limit, value, count: values.length, status };
  });

  const failed = measurements.filter((m) => m.status === 'FAIL');
  const missing = measurements.filter((m) => m.status === 'MISSING');
  let result;
  let reason = null;

  if (failed.length) {
    result = 'FAIL';
    reason = failed
      .map((m) => {
        const unit = m.unit ? ` ${m.unit}` : '';
        const bound = m.value > m.max ? `> ${formatValue(m.max)}` : `< ${formatValue(m.min)}`;
        return `${m.name} limit dışı (${formatValue(m.value)}${unit} ${bound}${unit})`;
      })
      .join('; ');
  } else if (error || missing.length) {
    result = 'ERROR';
    reason = error || `Eksik ölçüm: ${missing.map((m) => `${m.name} (${m.count}/${sampleCount})`).join(', ')}`;
  } else {
    result = 'PASS';
  }

  return { result, reason, measurements };
}

/**
 * Validates a finished test run sent by the browser and evaluates it.
 * Used by server.js so stored verdicts never depend on client-side logic.
 * @returns {{errors: string[], value?: object}}
 */
export function prepareTestRecord(body) {
  const errors = [];
  const serial = normalizeSerial(body?.serial);
  const serialError = validateSerial(serial);
  if (serialError) errors.push(serialError);

  const operator = String(body?.operator ?? '').trim().slice(0, 64);
  const sampleCount = Number(body?.sampleCount);
  if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > MAX_SAMPLE_COUNT) {
    errors.push(`Örnek sayısı 1–${MAX_SAMPLE_COUNT} arasında olmalı`);
  }
  if (!isIsoDate(body?.startedAt) || !isIsoDate(body?.finishedAt)) {
    errors.push('Başlangıç / bitiş zamanı geçersiz');
  } else if (Date.parse(body.finishedAt) < Date.parse(body.startedAt)) {
    errors.push('Bitiş zamanı başlangıçtan önce olamaz');
  }

  const { limits, errors: limitErrors } = validateLimits(body?.limits);
  errors.push(...limitErrors);

  const samples = {};
  const rawSamples = body?.samples && typeof body.samples === 'object' ? body.samples : {};
  for (const limit of limits) {
    const list = rawSamples[limit.key];
    if (list === undefined) {
      samples[limit.key] = [];
    } else if (!Array.isArray(list) || list.length > 1000 || !list.every(isFiniteNumber)) {
      errors.push(`"${limit.key}" için ölçüm verisi geçersiz`);
    } else {
      samples[limit.key] = list;
    }
  }

  const error = body?.error ? String(body.error).slice(0, 200) : null;
  if (errors.length) return { errors };

  const verdict = evaluateTest(samples, limits, { sampleCount, error });
  return {
    errors,
    value: {
      serial,
      operator,
      sampleCount,
      startedAt: new Date(body.startedAt).toISOString(),
      finishedAt: new Date(body.finishedAt).toISOString(),
      limits,
      ...verdict,
    },
  };
}

/** Builds the CSV test report: one row per test, two columns per measurement. */
export function resultsToCsv(records) {
  const keys = [];
  const titles = new Map();
  for (const r of records) {
    for (const m of r.measurements) {
      if (!titles.has(m.key)) {
        keys.push(m.key);
        titles.set(m.key, m.unit ? `${m.name} [${m.unit}]` : m.name);
      }
    }
  }
  const header = [
    'id', 'serial', 'attempt', 'result', 'reason', 'operator', 'started_at', 'finished_at', 'sample_count',
    ...keys.flatMap((k) => [titles.get(k), `${titles.get(k)} status`]),
  ];
  const rows = records.map((r) => {
    const byKey = new Map(r.measurements.map((m) => [m.key, m]));
    return [
      r.id, r.serial, r.attempt, r.result, r.reason ?? '', r.operator ?? '', r.startedAt, r.finishedAt, r.sampleCount,
      ...keys.flatMap((k) => {
        const m = byKey.get(k);
        return m ? [m.value === null ? '' : formatValue(m.value, 4), m.status] : ['', ''];
      }),
    ];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

/** Pass / fail / error counts and first-pass-independent yield (% of tests that passed). */
export function summarize(records) {
  const stats = { total: records.length, PASS: 0, FAIL: 0, ERROR: 0 };
  for (const r of records) stats[r.result] += 1;
  stats.yield = stats.total ? Math.round((stats.PASS / stats.total) * 1000) / 10 : null;
  return stats;
}

/**
 * Filters records the same way the SQLite query does (used by the browser-only store).
 * @param {{serial?: string, result?: string, from?: string, to?: string}} filters ISO timestamps
 */
export function filterRecords(records, { serial, result, from, to } = {}) {
  const needle = normalizeSerial(serial);
  return records.filter(
    (r) =>
      (!needle || r.serial.includes(needle)) &&
      (!result || r.result === result) &&
      (!from || r.finishedAt >= from) &&
      (!to || r.finishedAt <= to)
  );
}
