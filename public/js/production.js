// ============================================
// PRODUCTION TEST RECORDS — pure logic shared by the browser and server.js
// (run validation, CSV report, statistics, retest policy). Unit tested in /test.
// ============================================

import { csvCell, csvText } from './parser.js';
import { evaluateRun, formatValue, normalizeSerial, validateSerial, MAX_REPLY_LENGTH } from './recipe.js';

export const RESULTS = ['PASS', 'FAIL', 'ERROR'];

const isIsoDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function cleanReply(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > MAX_REPLY_LENGTH) return undefined;
  return value;
}

/** Validates the raw data the runner recorded for one step. undefined = invalid. */
function cleanStepData(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return undefined;
  const data = {};
  if ('reply' in raw) {
    data.reply = cleanReply(raw.reply);
    if (data.reply === undefined) return undefined;
  }
  if ('attempts' in raw) {
    if (!Number.isInteger(raw.attempts) || raw.attempts < 1 || raw.attempts > 10) return undefined;
    data.attempts = raw.attempts;
  }
  if ('replies' in raw) {
    if (!Array.isArray(raw.replies) || raw.replies.length > 200) return undefined;
    data.replies = raw.replies.map(cleanReply);
    if (data.replies.includes(undefined)) return undefined;
  }
  if ('answer' in raw) {
    if (raw.answer !== null && typeof raw.answer !== 'boolean') return undefined;
    data.answer = raw.answer;
  }
  if ('durationMs' in raw && Number.isFinite(raw.durationMs)) data.durationMs = Math.max(0, Math.round(raw.durationMs));
  if ('error' in raw) {
    if (typeof raw.error !== 'string') return undefined;
    data.error = raw.error.slice(0, 200);
  }
  return data;
}

function cleanDataList(list, max, label, errors) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > max) {
    errors.push(`${label} geçersiz`);
    return [];
  }
  return list.map((item, i) => {
    const data = cleanStepData(item);
    if (data === undefined) errors.push(`${label} ${i + 1}: adım verisi geçersiz`);
    return data ?? null;
  });
}

/** Raw data must have the shape its step type produces; e.g. no more samples than the recipe asks for. */
function checkDataMatchesRecipe(steps, dataList, label, errors) {
  dataList.forEach((data, i) => {
    if (!data) return;
    const step = steps[i];
    const where = `${label} ${i + 1}`;
    if (step.type === 'measure') {
      if (!Array.isArray(data.replies)) errors.push(`${where}: ölçüm cevapları eksik`);
      else if (data.replies.length > step.samples) {
        errors.push(`${where}: reçetede ${step.samples} örnek var, ${data.replies.length} cevap gönderildi`);
      }
    } else if ('replies' in data) {
      errors.push(`${where}: bu adım tipi ölçüm cevabı içeremez`);
    }
    if (step.type !== 'confirm' && 'answer' in data) errors.push(`${where}: bu adım tipi operatör cevabı içeremez`);
  });
}

/**
 * Validates a finished run sent by the browser and evaluates it against the exact
 * recipe revision it was run with. Used by server.js (and the browser-only store)
 * so stored verdicts never depend on client-side logic.
 *
 * @param {object} body {serial, operator, productCode, recipeRevision, startedAt, finishedAt, steps, teardown, error}
 * @param {object|null} product the product revision referenced by the body
 * @returns {{errors: string[], value?: object}}
 */
export function prepareTestRecord(body, product) {
  const errors = [];
  if (!product) return { errors: ['Ürün / reçete revizyonu bulunamadı'] };

  const serial = normalizeSerial(body?.serial);
  const serialError = validateSerial(serial, product.serialMask);
  if (serialError) errors.push(serialError);

  const operator = String(body?.operator ?? '').trim().slice(0, 64);
  if (!isIsoDate(body?.startedAt) || !isIsoDate(body?.finishedAt)) {
    errors.push('Başlangıç / bitiş zamanı geçersiz');
  } else if (Date.parse(body.finishedAt) < Date.parse(body.startedAt)) {
    errors.push('Bitiş zamanı başlangıçtan önce olamaz');
  }

  const stepsData = cleanDataList(body?.steps, product.recipe.steps.length, 'Adım', errors);
  const teardownData = cleanDataList(body?.teardown, product.recipe.teardown.length, 'Teardown', errors);
  checkDataMatchesRecipe(product.recipe.steps, stepsData, 'Adım', errors);
  checkDataMatchesRecipe(product.recipe.teardown, teardownData, 'Teardown', errors);
  const error = body?.error ? String(body.error).slice(0, 200) : null;
  if (errors.length) return { errors };

  const verdict = evaluateRun(product.recipe, stepsData, teardownData, { error });
  return {
    errors,
    value: {
      serial,
      operator,
      productCode: product.code,
      productName: product.name,
      recipeRevision: product.revision,
      startedAt: new Date(body.startedAt).toISOString(),
      finishedAt: new Date(body.finishedAt).toISOString(),
      ...verdict,
    },
  };
}

/** Builds the CSV test report: one row per test, two columns per measurement. */
/**
 * Measurement columns of a report, one per (step, key), from measurement definitions
 * ({step, key, name, unit}) — known before streaming so the header can be written first.
 */
export function csvColumns(definitions) {
  const columns = [];
  const seen = new Set();
  for (const m of definitions) {
    const id = `${m.step ?? ''}:${m.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    columns.push({ id, title: m.unit ? `${m.name} [${m.unit}]` : m.name });
  }
  return columns;
}

// ---------- time zones: days and times are shown in the viewer's local calendar ----------

const formatters = new Map();

function formatter(timeZone, options) {
  const key = `${timeZone}|${Object.keys(options).join()}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, ...options });
    formatters.set(key, f);
  }
  return f;
}

/** The name if it is a time zone this runtime knows (e.g. "Europe/Istanbul"), otherwise null. */
export function validTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return null;
  try {
    formatter(timeZone, { year: 'numeric' });
    return timeZone;
  } catch {
    return null;
  }
}

const part = (parts, type) => parts.find((p) => p.type === type)?.value ?? '';

/** Calendar day "YYYY-MM-DD" of an instant in a time zone (DST aware). */
export function dayKey(iso, timeZone = 'UTC') {
  const parts = formatter(timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  return `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}`;
}

/** Wall-clock time "YYYY-MM-DD HH:MM:SS" (spreadsheets read it as a date) and the UTC offset "+03:00". */
export function localTime(iso, timeZone = 'UTC') {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return { text: '', offset: '' };
  const parts = formatter(timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const zone = part(parts, 'timeZoneName'); // "GMT+03:00", or "GMT" for UTC
  return {
    text: `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')} ${part(parts, 'hour')}:${part(parts, 'minute')}:${part(parts, 'second')}`,
    offset: zone === 'GMT' ? '+00:00' : zone.replace('GMT', ''),
  };
}

// started_at / finished_at are local wall-clock times; utc_offset makes them unambiguous
const CSV_FIXED = [
  'id', 'serial', 'product', 'recipe_revision', 'attempt', 'result', 'failed_step', 'reason', 'operator',
  'source', 'transport', 'safety', 'dut_firmware', 'retest_reason', 'station', 'started_at', 'finished_at', 'utc_offset', 'duration_s',
];

export function csvHeader(columns) {
  return [...CSV_FIXED, ...columns.flatMap((c) => [c.title, `${c.title} status`])].map(csvText).join(',');
}

export function csvRow(r, columns, { timeZone = 'UTC' } = {}) {
  const byKey = new Map(r.measurements.map((m) => [`${m.step ?? ''}:${m.key}`, m]));
  const started = localTime(r.startedAt, timeZone);
  const finished = localTime(r.finishedAt, timeZone);
  const duration = (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000;
  const numeric = [r.id, r.recipeRevision ?? '', r.attempt, r.failedStep === null || r.failedStep === undefined ? '' : r.failedStep + 1];
  return [
    csvCell(numeric[0]),
    csvText(r.serial),
    csvText(r.productCode ?? ''),
    csvCell(numeric[1]),
    csvCell(numeric[2]),
    csvCell(r.result),
    csvCell(numeric[3]),
    csvText(r.reason ?? ''),
    csvText(r.operator ?? ''),
    csvCell(r.source ?? ''),
    csvCell(r.transport ?? ''),
    csvCell(r.safety?.state ?? ''),
    csvText(r.captures?.firmware ?? ''),
    csvText(r.retestReason ?? ''),
    csvText(r.station?.id ?? ''),
    csvCell(started.text),
    csvCell(finished.text),
    csvCell(finished.offset),
    csvCell(Number.isFinite(duration) ? duration.toFixed(1) : ''),
    ...columns.flatMap((c) => {
      const m = byKey.get(c.id);
      return m ? [csvCell(m.value === null ? '' : formatValue(m.value, 4)), csvCell(m.status)] : ['', ''];
    }),
  ].join(',');
}

/** Builds the CSV test report in memory (browser-only store); the server streams the same rows. */
export function resultsToCsv(records, options = {}) {
  const columns = csvColumns(records.flatMap((r) => r.measurements));
  return [csvHeader(columns), ...records.map((r) => csvRow(r, columns, options))].join('\n');
}

/**
 * Process capability of one measurement. Cpk is only reported when it means something:
 * at least `minSamples` values, one set of limits, and a non-zero spread. It assumes a
 * stable, roughly normal process — the caller shows these assumptions with the number.
 */
export function capability(values, limits, { minSamples = 30, bins = 20 } = {}) {
  const notes = [];
  const finite = values.filter(Number.isFinite);
  const n = finite.length;
  const stats = sampleStatsLocal(finite);
  let cpk = null;
  if (n < minSamples) notes.push(`Cpk için en az ${minSamples} ölçüm gerekir (şu an ${n})`);
  if (!limits) notes.push('Dönem içinde limitler değişmiş; Cpk tek limit seti için hesaplanır');
  if (n >= 2 && stats.sd === 0) notes.push('Tüm ölçümler aynı; dağılım hesaplanamaz');
  if (n >= minSamples && limits && stats.sd > 0) {
    cpk = Math.min(limits.max - stats.mean, stats.mean - limits.min) / (3 * stats.sd);
    if (!Number.isFinite(cpk)) cpk = null;
  }
  // Histogram over the wider of the data range and the limits
  let histogram = [];
  if (n) {
    const lo = Math.min(stats.min, limits?.min ?? stats.min);
    const hi = Math.max(stats.max, limits?.max ?? stats.max);
    const width = (hi - lo) / bins || 1;
    histogram = Array.from({ length: bins }, (_, i) => ({ from: lo + i * width, to: lo + (i + 1) * width, count: 0 }));
    for (const v of finite) histogram[Math.min(bins - 1, Math.floor((v - lo) / width))].count += 1;
  }
  return { n, ...stats, cpk, histogram, notes };
}

function sampleStatsLocal(values) {
  const n = values.length;
  if (!n) return { mean: null, sd: null, min: null, max: null };
  let mean = 0;
  let min = Infinity;
  let max = -Infinity;
  values.forEach((v, i) => {
    mean += (v - mean) / (i + 1);
    if (v < min) min = v;
    if (v > max) max = v;
  });
  const sd = n > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : null;
  return { mean, sd, min, max };
}

/**
 * Per-product yields from the aggregated rows of the report query.
 *   attempt yield = PASS tests / all tests
 *   first-pass yield (FPY) = units passing on attempt 1 / units whose attempt 1 is in the period
 *   final yield = units with a PASS in the period / units tested in the period
 */
export function yields(row, counts) {
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    product: row.product,
    tests: row.tests,
    PASS: counts.PASS ?? 0,
    FAIL: counts.FAIL ?? 0,
    ERROR: counts.ERROR ?? 0,
    retests: row.retests,
    units: row.units,
    attemptYield: pct(counts.PASS ?? 0, row.tests),
    fpy: pct(row.firstPass, row.firstAttemptUnits),
    finalYield: pct(row.unitsPassed, row.units),
  };
}

/** Pass / fail / error counts and yield (% of tests that passed). */
export function summarize(records) {
  const stats = { total: records.length, PASS: 0, FAIL: 0, ERROR: 0 };
  for (const r of records) stats[r.result] += 1;
  stats.yield = stats.total ? Math.round((stats.PASS / stats.total) * 1000) / 10 : null;
  return stats;
}

/**
 * Filters records the same way the SQLite query does (used by the browser-only store).
 * @param {{serial?: string, product?: string, result?: string, from?: string, to?: string}} filters ISO timestamps
 */
export function filterRecords(records, { serial, product, result, from, to, source = 'all' } = {}) {
  const needle = normalizeSerial(serial);
  const sources = SOURCE_FILTERS[source] ?? [source];
  return records.filter(
    (r) =>
      (!needle || r.serial.includes(needle)) &&
      (!product || r.productCode === product) &&
      (!result || r.result === result) &&
      (!from || r.finishedAt >= from) &&
      (!to || r.finishedAt <= to) &&
      (source === 'all' || sources.includes(r.source ?? 'unknown'))
  );
}

/** History source filters; "production" = real hardware plus legacy rows of unknown origin. */
export const SOURCE_FILTERS = {
  production: ['hardware', 'unknown'],
  hardware: ['hardware'],
  simulation: ['simulation'],
  unknown: ['unknown'],
};

/**
 * Retest policy for one unit, from its previous results (any order).
 * Only FAIL counts towards the limit: an ERROR means the station, not the board, had a problem.
 */
export function unitStatus(records, maxAttempts, { reopenedAt = null, maxErrors = Infinity } = {}) {
  // A repair "reopen" starts the FAIL and ERROR counts again; earlier attempts stay in the history
  const counted = reopenedAt ? records.filter((r) => r.finishedAt > reopenedAt) : records;
  const attempts = records.length;
  const failures = counted.filter((r) => r.result === 'FAIL').length;
  // ERROR usually means the station had a problem, so it does not count as a FAIL; but a
  // board that never completes a test must not be retried forever: it has its own limit
  const errors = counted.filter((r) => r.result === 'ERROR').length;
  const passed = counted.some((r) => r.result === 'PASS');
  const last = [...records].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0] ?? null;
  const blockedBy = passed ? null : failures >= maxAttempts ? 'FAIL' : errors >= maxErrors ? 'ERROR' : null;
  return {
    attempts,
    failures,
    errors,
    passed,
    reopenedAt,
    lastResult: last?.result ?? null,
    lastAt: last?.finishedAt ?? null,
    blocked: blockedBy !== null,
    blockedBy,
  };
}

// ---------- retest policy (enforced by the server, mirrored by the browser-only store) ----------

export const SOURCES = ['hardware', 'simulation'];
export const TRANSPORTS = ['webserial', 'server', 'simulator'];
/** An open reservation older than this is treated as abandoned (tab closed, station crashed). */
export const RESERVATION_STALE_MS = 30 * 60 * 1000;

/** Simulation history never influences production decisions. */
export const policyGroup = (source) => (source === 'simulation' ? 'simulation' : 'production');

/**
 * Decides atomically (the caller holds the transaction) whether a unit may be tested now.
 *
 * Rules:
 *   - a serial number belongs to the first product it was tested as (serials are unique across products)
 *   - only one open reservation per unit; one older than RESERVATION_STALE_MS is abandoned
 *   - FAIL results since the last repair reopen are limited by product.maxAttempts
 *   - ERROR results do not count as FAIL; they have their own limit (product.maxErrors)
 *   - a unit that already passed can be retested only with a written reason
 *
 * @param {object} p
 * @param {{results: object[], reopenedAt: string|null, ownerProduct: string|null}} p.history
 * @param {object} p.product published product revision
 * @param {object[]} p.openReservations open reservations of this unit (same policy group)
 * @param {string} [p.retestReason]
 * @returns {{allowed: boolean, code?: string, reason?: string, status: object, abandon: object[]}}
 */
export function checkRetestPolicy({ history, product, openReservations = [], retestReason, now = Date.now() }) {
  const status = unitStatus(history.results, product.maxAttempts, { reopenedAt: history.reopenedAt, maxErrors: product.maxErrors ?? Infinity });
  const created = (r) => Date.parse(r.created_at ?? r.createdAt);
  const abandon = openReservations.filter((r) => now - created(r) >= RESERVATION_STALE_MS);
  const deny = (code, reason) => ({ allowed: false, code, reason, status, abandon });

  if (history.ownerProduct && history.ownerProduct !== product.code) {
    return deny('WRONG_PRODUCT', `Bu seri numarası ${history.ownerProduct} ürününe ait; ${product.code} olarak test edilemez`);
  }
  if (openReservations.length > abandon.length) {
    return deny('IN_PROGRESS', 'Bu kart şu anda başka bir istasyonda test ediliyor');
  }
  if (status.blockedBy === 'ERROR') {
    return deny(
      'BLOCKED',
      `Bu kart ${status.errors} kez HATA verdi, test bir kez bile tamamlanamadı (sınır ${product.maxErrors}). Kartı ve fikstürü kontrol edin; bir mühendis yeniden açmalı.`
    );
  }
  if (status.blocked) {
    return deny(
      'BLOCKED',
      `Bu kart ${status.failures} kez FAIL aldı (sınır ${product.maxAttempts}). Onarımdan sonra bir mühendis kartı yeniden açmalı.`
    );
  }
  if (status.passed && !String(retestReason ?? '').trim()) {
    return deny('PASSED_NEEDS_REASON', 'Bu kart daha önce PASS aldı; tekrar test için gerekçe girilmeli');
  }
  return { allowed: true, status, abandon };
}

/** Deterministic JSON (sorted keys) so the same payload always hashes the same. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The part of a submission that identifies its content (used to detect conflicting resends). */
export function submissionDigestInput(body) {
  const pick = ['runId', 'serial', 'productCode', 'recipeRevision', 'startedAt', 'finishedAt', 'steps', 'teardown', 'error', 'source', 'transport'];
  return canonicalJson(Object.fromEntries(pick.map((k) => [k, body?.[k]])));
}

const LOG_DIRECTIONS = ['TX', 'RX', '--', 'OP'];

/** Keeps the communication log a station sent within sane bounds. */
export function cleanLog(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 400)
    .filter((e) => e && Number.isFinite(e.t) && LOG_DIRECTIONS.includes(e.dir) && typeof e.text === 'string')
    .map((e) => ({ t: Math.max(0, Math.round(e.t)), dir: e.dir, text: e.text.slice(0, MAX_REPLY_LENGTH) }));
}
