// ============================================
// PRODUCTION TEST RECORDS — pure logic shared by the browser and server.js
// (run validation, CSV report, statistics, retest policy). Unit tested in /test.
// ============================================

import { csvCell } from './parser.js';
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
export function resultsToCsv(records) {
  const keys = [];
  const titles = new Map();
  for (const r of records) {
    for (const m of r.measurements) {
      const id = `${m.step ?? ''}:${m.key}`;
      if (!titles.has(id)) {
        keys.push(id);
        titles.set(id, m.unit ? `${m.name} [${m.unit}]` : m.name);
      }
    }
  }
  const header = [
    'id', 'serial', 'product', 'recipe_revision', 'attempt', 'result', 'failed_step', 'reason', 'operator',
    'started_at', 'finished_at', 'duration_s',
    ...keys.flatMap((k) => [titles.get(k), `${titles.get(k)} status`]),
  ];
  const rows = records.map((r) => {
    const byKey = new Map(r.measurements.map((m) => [`${m.step ?? ''}:${m.key}`, m]));
    const duration = (Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000;
    return [
      r.id, r.serial, r.productCode ?? '', r.recipeRevision ?? '', r.attempt, r.result,
      r.failedStep === null || r.failedStep === undefined ? '' : r.failedStep + 1,
      r.reason ?? '', r.operator ?? '', r.startedAt, r.finishedAt, Number.isFinite(duration) ? duration.toFixed(1) : '',
      ...keys.flatMap((k) => {
        const m = byKey.get(k);
        return m ? [m.value === null ? '' : formatValue(m.value, 4), m.status] : ['', ''];
      }),
    ];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
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
export function filterRecords(records, { serial, product, result, from, to } = {}) {
  const needle = normalizeSerial(serial);
  return records.filter(
    (r) =>
      (!needle || r.serial.includes(needle)) &&
      (!product || r.productCode === product) &&
      (!result || r.result === result) &&
      (!from || r.finishedAt >= from) &&
      (!to || r.finishedAt <= to)
  );
}

/**
 * Retest policy for one unit, from its previous results (any order).
 * Only FAIL counts towards the limit: an ERROR means the station, not the board, had a problem.
 */
export function unitStatus(records, maxAttempts) {
  const attempts = records.length;
  const failures = records.filter((r) => r.result === 'FAIL').length;
  const passed = records.some((r) => r.result === 'PASS');
  const last = [...records].sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0] ?? null;
  return {
    attempts,
    failures,
    passed,
    lastResult: last?.result ?? null,
    lastAt: last?.finishedAt ?? null,
    blocked: !passed && failures >= maxAttempts,
  };
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
