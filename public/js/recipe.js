// ============================================
// PRODUCTS & TEST RECIPES — pure logic shared by the browser and server.js
//
// A product has a serial-number mask, a retest policy and a recipe: an ordered
// list of steps that talk to the device with the line protocol in
// docs/protocol.md (replies start with "@"), plus teardown steps that always run.
//
// Step status:  PASS | FAIL (the board is bad) | ERROR (the test could not be
//               completed, e.g. no reply) | SKIPPED (not run after a failure)
// ============================================

import { parseLine } from './parser.js';

export const STEP_TYPES = ['command', 'measure', 'delay', 'confirm'];

/** How a measure step turns its samples into one value checked against the limits. */
export const EVALUATION_MODES = {
  mean: 'Ortalama',
  min: 'En küçük örnek',
  max: 'En büyük örnek',
  all: 'Her örnek limit içinde',
};
export const TEARDOWN_TYPES = ['command', 'delay'];
export const REPLY_PREFIX = '@';
export const MAX_REPLY_LENGTH = 256;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const toNumber = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
const PRINTABLE_RE = /^[\x20-\x7E]+$/;

// ---------- formatting ----------

export function formatValue(value, digits = 3) {
  if (!isFiniteNumber(value)) return '—';
  return Number(value.toFixed(digits)).toString();
}

// ---------- serial numbers ----------

/** Trims and upper-cases a scanned / typed serial number. */
export function normalizeSerial(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

/**
 * Serial masks: "#" = digit, "@" = letter, "?" = letter or digit, anything else literal.
 * "SNS-######" → /^SNS-\d{6}$/. Masks instead of user regexes keep the server safe
 * from catastrophic backtracking.
 */
export function maskToRegExp(mask) {
  let pattern = '';
  for (const ch of mask) {
    if (ch === '#') pattern += '\\d';
    else if (ch === '@') pattern += '[A-Z]';
    else if (ch === '?') pattern += '[A-Z0-9]';
    else pattern += ch.replace(/[.*+^${}()|[\]\\/-]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

/** @returns {string|null} error message, or null when the serial fits the product mask */
export function validateSerial(serial, mask) {
  if (!serial) return 'Seri numarası boş olamaz';
  if (!maskToRegExp(mask).test(serial)) return `Seri numarası "${mask}" biçiminde olmalı`;
  return null;
}

// ---------- reply matching ----------

/** Glob match for expected replies: "*" any text, "?" one character. Linear, no regex. */
export function globMatch(pattern, text) {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      mark = t;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/** Replaces {serial} in a command template. */
export function renderCommand(template, context) {
  return template.replace(/\{serial\}/g, context.serial ?? '');
}

/** True for protocol reply lines; returns the reply text without the prefix. */
export function replyText(line) {
  if (typeof line !== 'string' || !line.startsWith(REPLY_PREFIX)) return null;
  // Numbered replies (protocol v2) look like "@#00A1 OK"; return only the body
  return line.slice(REPLY_PREFIX.length).replace(/^#[0-9A-Z]{1,8} ?/, '').trim();
}

// ---------- limits ----------

/**
 * Validates and normalizes a limit table.
 * @returns {{limits: object[], errors: string[]}}
 */
export function validateLimits(input, where = '') {
  const errors = [];
  const at = (row) => `${where}limit ${row}`;
  if (!Array.isArray(input) || input.length === 0) {
    return { limits: [], errors: [`${where}en az bir ölçüm limiti tanımlanmalı`] };
  }
  if (input.length > 16) errors.push(`${where}en fazla 16 limit tanımlanabilir`);

  const seen = new Set();
  const limits = input.map((raw, i) => {
    const key = String(raw?.key ?? '').trim();
    const name = String(raw?.name ?? '').trim() || key;
    const unit = String(raw?.unit ?? '').trim();
    const min = toNumber(raw?.min);
    const max = toNumber(raw?.max);

    if (!key) errors.push(`${at(i + 1)}: anahtar boş olamaz`);
    else if (key.length > 32 || /[,;=:\s]/.test(key)) errors.push(`${at(i + 1)}: geçersiz anahtar "${key}"`);
    else if (seen.has(key)) errors.push(`${at(i + 1)}: "${key}" anahtarı tekrar ediyor`);
    seen.add(key);

    if (!isFiniteNumber(min)) errors.push(`${at(i + 1)}: minimum sayı olmalı`);
    if (!isFiniteNumber(max)) errors.push(`${at(i + 1)}: maksimum sayı olmalı`);
    if (isFiniteNumber(min) && isFiniteNumber(max) && min > max) {
      errors.push(`${at(i + 1)}: minimum, maksimumdan büyük olamaz`);
    }
    return { key, name: name.slice(0, 64), unit: unit.slice(0, 16), min, max };
  });
  return { limits, errors };
}

// ---------- products & recipes ----------

function intInRange(value, fallback, min, max) {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : NaN;
}

function validateCommandText(value, label, errors, { optional = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text) {
    if (!optional) errors.push(`${label} boş olamaz`);
    return undefined;
  }
  if (text.length > 64 || !PRINTABLE_RE.test(text)) errors.push(`${label} en fazla 64 yazdırılabilir ASCII karakter olmalı`);
  return text;
}

const DEFAULT_STEP_NAMES = { command: 'Komut', measure: 'Ölçüm', delay: 'Bekle', confirm: 'Operatör kontrolü' };

function validateStep(raw, where, allowedTypes, errors) {
  const type = raw?.type;
  if (!allowedTypes.includes(type)) {
    errors.push(`${where}: tip ${allowedTypes.map((t) => `"${t}"`).join(', ')} olmalı`);
    return { type: String(type), name: '' };
  }
  const step = { type, name: String(raw.name ?? '').trim().slice(0, 64) || DEFAULT_STEP_NAMES[type] };
  const num = (key, fallback, min, max, unit = '') => {
    const v = intInRange(raw[key], fallback, min, max);
    if (Number.isNaN(v)) errors.push(`${where}: ${key} ${min}–${max}${unit} arasında tam sayı olmalı`);
    return v;
  };

  if (type === 'delay') {
    step.ms = num('ms', undefined, 0, 60000, ' ms');
    return step;
  }

  if (type === 'confirm') {
    step.prompt = String(raw.prompt ?? '').trim().slice(0, 200);
    if (!step.prompt) errors.push(`${where}: prompt (operatöre sorulacak soru) boş olamaz`);
    step.send = validateCommandText(raw.send, `${where}: send`, errors, { optional: true });
    if (step.send) {
      step.expect = validateCommandText(raw.expect ?? 'OK', `${where}: expect`, errors);
      step.timeoutMs = num('timeoutMs', 1000, 50, 30000, ' ms');
    }
    return step;
  }

  step.send = validateCommandText(raw.send, `${where}: send`, errors);
  step.timeoutMs = num('timeoutMs', 1000, 50, 30000, ' ms');
  step.retries = num('retries', 0, 0, 5);

  if (type === 'command') {
    step.expect = validateCommandText(raw.expect ?? 'OK', `${where}: expect`, errors);
    if (raw.capture !== undefined) {
      step.capture = String(raw.capture);
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(step.capture)) errors.push(`${where}: capture bir alan adı olmalı (ör. "firmware")`);
    }
    if (raw.critical !== undefined) {
      if (typeof raw.critical !== 'boolean') errors.push(`${where}: critical true veya false olmalı`);
      step.critical = raw.critical === true;
    }
  } else {
    step.samples = num('samples', 1, 1, 100);
    step.intervalMs = num('intervalMs', 0, 0, 10000, ' ms');
    step.evaluate = raw.evaluate ?? 'mean';
    if (!(step.evaluate in EVALUATION_MODES)) {
      errors.push(`${where}: evaluate ${Object.keys(EVALUATION_MODES).map((m) => `"${m}"`).join(', ')} olmalı`);
    }
    const { limits, errors: limitErrors } = validateLimits(raw.limits, `${where}: `);
    step.limits = limits;
    errors.push(...limitErrors);
  }
  return step;
}

/**
 * Validates and normalizes a product definition (metadata + recipe).
 * @returns {{product: object, errors: string[]}}
 */
export function validateProduct(input) {
  const errors = [];
  const code = String(input?.code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,23}$/.test(code)) errors.push('Ürün kodu 2–24 karakter olmalı (harf, rakam, "-")');

  const name = String(input?.name ?? '').trim();
  if (!name || name.length > 64) errors.push('Ürün adı 1–64 karakter olmalı');

  const serialMask = String(input?.serialMask ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9_#@?-]{3,40}$/.test(serialMask) || !/[#@?]/.test(serialMask)) {
    errors.push('Seri no maskesi 3–40 karakter olmalı ve en az bir # (rakam), @ (harf) veya ? içermeli');
  }

  const maxAttempts = intInRange(input?.maxAttempts, 3, 1, 10);
  if (Number.isNaN(maxAttempts)) errors.push('maxAttempts 1–10 arasında olmalı');

  // Legacy firmware without request ids must be chosen explicitly, never assumed
  const protocol = input?.protocol ?? 'v2';
  if (!['v2', 'v1'].includes(protocol)) errors.push('protocol "v2" (istek kimlikli) veya "v1" (eski firmware) olmalı');
  const heartbeatMs = intInRange(input?.heartbeatMs, protocol === 'v2' ? 1000 : 0, 0, 10000);
  if (Number.isNaN(heartbeatMs)) errors.push('heartbeatMs 0–10000 arasında tam sayı olmalı');
  else if (protocol === 'v1' && heartbeatMs > 0) errors.push('heartbeat yalnızca protokol v2 ile kullanılabilir');

  const recipeIn = input?.recipe ?? {};
  const stepsIn = Array.isArray(recipeIn.steps) ? recipeIn.steps : null;
  const teardownIn = recipeIn.teardown === undefined ? [] : recipeIn.teardown;
  if (!stepsIn || stepsIn.length === 0) errors.push('Reçetede en az bir adım olmalı (recipe.steps)');
  else if (stepsIn.length > 50) errors.push('Reçete en fazla 50 adım içerebilir');
  if (!Array.isArray(teardownIn) || teardownIn.length > 10) errors.push('recipe.teardown en fazla 10 adımlık bir dizi olmalı');
  if (recipeIn.stopOnFail !== undefined && typeof recipeIn.stopOnFail !== 'boolean') {
    errors.push('recipe.stopOnFail true veya false olmalı');
  }

  const steps = (stepsIn ?? []).slice(0, 50).map((s, i) => validateStep(s, `Adım ${i + 1}`, STEP_TYPES, errors));
  steps.forEach((s, i) => s.critical && errors.push(`Adım ${i + 1}: critical yalnızca teardown adımlarında kullanılır`));
  const teardown = (Array.isArray(teardownIn) ? teardownIn : [])
    .slice(0, 10)
    .map((s, i) => validateStep(s, `Teardown ${i + 1}`, TEARDOWN_TYPES, errors));

  return {
    product: {
      code,
      name,
      serialMask,
      maxAttempts,
      protocol,
      heartbeatMs,
      recipe: { stopOnFail: recipeIn.stopOnFail ?? true, steps, teardown },
    },
    errors,
  };
}

/**
 * A stored definition with the fields later versions added (protocol, heartbeat,
 * evaluation mode, …) filled in with their defaults. Used when a revision is read;
 * the stored revision itself is never rewritten.
 */
export function withDefaults(definition) {
  const { product, errors } = validateProduct(definition);
  if (!errors.length) return product;
  const protocol = definition?.protocol ?? 'v2';
  return { ...definition, protocol, heartbeatMs: definition?.heartbeatMs ?? (protocol === 'v2' ? 1000 : 0) };
}

// ---------- evaluation ----------

function deviceError(reply) {
  return reply.startsWith('ERR') ? `Cihaz hatası: ${reply}` : null;
}

function checkReply(reply, expect, attempts) {
  if (reply === null || reply === undefined) {
    return { status: 'ERROR', reason: `Cevap yok (${attempts} deneme)` };
  }
  const err = deviceError(reply);
  if (err) return { status: 'FAIL', reason: err };
  if (!globMatch(expect, reply)) return { status: 'FAIL', reason: `Beklenen "${expect}", gelen "${reply}"` };
  return { status: 'PASS', reason: null };
}

/** Summary statistics of finite samples; null fields when they cannot be computed safely. */
export function sampleStats(values) {
  const n = values.length;
  if (!n) return { n: 0, mean: null, min: null, max: null, sd: null };
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // Mean via a running average so huge-but-finite samples cannot overflow the sum
  let mean = 0;
  values.forEach((v, i) => {
    mean += (v - mean) / (i + 1);
  });
  let sd = null;
  if (n > 1) {
    const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
    sd = Math.sqrt(variance);
  }
  const finite = (x) => (Number.isFinite(x) ? x : null);
  return { n, mean: finite(mean), min: finite(min), max: finite(max), sd: finite(sd) };
}

const inLimits = (value, limit) => Number.isFinite(value) && value >= limit.min && value <= limit.max;

/**
 * Evaluates a measure step. Never returns PASS unless every limit has exactly the
 * configured number of finite samples and the evaluated value is finite and inside
 * [min, max]. Non-numeric, overflowing ("1e999") or missing values make the step ERROR.
 */
function evaluateMeasure(step, data) {
  const replies = Array.isArray(data.replies) ? data.replies : [];
  const mode = step.evaluate ?? 'mean';
  if (replies.length > step.samples) {
    return { status: 'ERROR', reason: `Reçetede ${step.samples} örnek tanımlı, ${replies.length} cevap kaydedildi`, measurements: [] };
  }
  const values = Object.fromEntries(step.limits.map((l) => [l.key, []]));
  const invalid = Object.fromEntries(step.limits.map((l) => [l.key, 0]));
  let timeouts = 0;

  for (const reply of replies) {
    if (reply === null || reply === undefined) {
      timeouts += 1;
      continue;
    }
    const err = deviceError(reply);
    if (err) return { status: 'FAIL', reason: err, measurements: [] };
    const fields = parseLine(reply);
    for (const limit of step.limits) {
      const field = fields.find((f) => f.key === limit.key);
      if (!field) continue;
      if (Number.isFinite(field.value)) values[limit.key].push(field.value);
      else invalid[limit.key] += 1;
    }
  }

  const measurements = step.limits.map((limit) => {
    const samples = values[limit.key];
    const stats = sampleStats(samples);
    const base = { ...limit, mode, count: samples.length, invalid: invalid[limit.key], stats };
    if (invalid[limit.key] > 0) return { ...base, value: stats.mean, status: 'INVALID' };
    if (samples.length < step.samples) return { ...base, value: stats.mean, status: 'MISSING' };

    let value;
    let pass;
    if (mode === 'all') {
      // Report the sample furthest outside the limits (or the mean when all are inside)
      const outside = samples.filter((v) => !inLimits(v, limit));
      value = outside.length
        ? outside.reduce((worst, v) => (Math.max(limit.min - v, v - limit.max) > Math.max(limit.min - worst, worst - limit.max) ? v : worst))
        : stats.mean;
      pass = outside.length === 0;
    } else {
      value = mode === 'min' ? stats.min : mode === 'max' ? stats.max : stats.mean;
      pass = inLimits(value, limit);
    }
    if (!Number.isFinite(value) || Object.values(stats).some((s) => s !== null && !Number.isFinite(s))) {
      return { ...base, value: null, status: 'INVALID' };
    }
    return { ...base, value, status: pass ? 'PASS' : 'FAIL' };
  });

  const failed = measurements.filter((m) => m.status === 'FAIL');
  if (failed.length) {
    const reason = failed
      .map((m) => {
        const unit = m.unit ? ` ${m.unit}` : '';
        const bound = m.value > m.max ? `> ${formatValue(m.max)}` : `< ${formatValue(m.min)}`;
        const what = mode === 'mean' ? '' : ` (${EVALUATION_MODES[mode].toLowerCase()})`;
        return `${m.name}${what} limit dışı (${formatValue(m.value)}${unit} ${bound}${unit})`;
      })
      .join('; ');
    return { status: 'FAIL', reason, measurements };
  }
  const bad = measurements.filter((m) => m.status === 'INVALID');
  if (bad.length) {
    return { status: 'ERROR', reason: `Geçersiz ölçüm değeri (sayı değil / taşma): ${bad.map((m) => m.name).join(', ')}`, measurements };
  }
  const missing = measurements.filter((m) => m.status === 'MISSING');
  if (missing.length) {
    const detail = missing.map((m) => `${m.name} ${m.count}/${step.samples}`).join(', ');
    return { status: 'ERROR', reason: `Eksik ölçüm: ${detail}${timeouts ? ` (${timeouts} cevapsız istek)` : ''}`, measurements };
  }
  // Defensive: PASS only if every measurement explicitly passed
  if (!measurements.every((m) => m.status === 'PASS')) {
    return { status: 'ERROR', reason: 'Ölçüm değerlendirilemedi', measurements };
  }
  return { status: 'PASS', reason: null, measurements };
}

/**
 * Evaluates one executed step from its raw data.
 * @param {object} step validated step
 * @param {object} data raw data recorded by the runner: {reply, attempts} | {replies} | {answer, reply}
 */
export function evaluateStep(step, data) {
  if (!data) return { status: 'ERROR', reason: 'Adım çalıştırılmadı' };
  switch (step.type) {
    case 'delay':
      return { status: 'PASS', reason: null };
    case 'command':
      // The runner records why a command could not be sent at all (e.g. the port is gone)
      if (data.error && (data.reply === null || data.reply === undefined)) return { status: 'ERROR', reason: data.error };
      return checkReply(data.reply ?? null, step.expect, data.attempts ?? 1);
    case 'measure':
      return evaluateMeasure(step, data);
    case 'confirm': {
      if (step.send) {
        const sent = checkReply(data.reply ?? null, step.expect, data.attempts ?? 1);
        if (sent.status !== 'PASS') return sent;
      }
      if (data.answer === true) return { status: 'PASS', reason: null };
      if (data.answer === false) return { status: 'FAIL', reason: `Operatör: "${step.prompt}" → Hayır` };
      return { status: 'ERROR', reason: 'Operatör cevabı alınamadı' };
    }
    default:
      return { status: 'ERROR', reason: `Bilinmeyen adım tipi: ${step.type}` };
  }
}

/**
 * Evaluates a whole run. The same function decides the verdict in the browser
 * (live) and on the server (from the raw data that was sent).
 *
 * @param {{stopOnFail: boolean, steps: object[], teardown: object[]}} recipe validated recipe
 * @param {object[]} stepsData raw data per main step (missing entries = not executed)
 * @param {object[]} teardownData raw data per teardown step
 * @param {{error?: string|null}} options run-level error (cancel, disconnect)
 */
export function evaluateRun(recipe, stepsData = [], teardownData = [], { error = null } = {}) {
  let stopped = false;
  const steps = recipe.steps.map((step, index) => {
    const data = stepsData[index];
    // After a failure in a stop-on-fail recipe nothing more counts, even if data was sent
    if (stopped) return { index, ...step, data: null, status: 'SKIPPED', reason: null };
    const verdict = data || !error ? evaluateStep(step, data) : { status: 'SKIPPED', reason: null };
    if (recipe.stopOnFail && (verdict.status === 'FAIL' || verdict.status === 'ERROR')) stopped = true;
    return { index, ...step, data: data ?? null, ...verdict };
  });

  const teardown = recipe.teardown.map((step, index) => {
    const data = teardownData[index];
    return { index, ...step, data: data ?? null, ...(data ? evaluateStep(step, data) : { status: 'SKIPPED', reason: null }) };
  });

  const failed = steps.find((s) => s.status === 'FAIL');
  const errored = steps.find((s) => s.status === 'ERROR');
  let result = 'PASS';
  let reason = null;
  let failedStep = null;
  if (failed) {
    result = 'FAIL';
    failedStep = failed.index;
    reason = `Adım ${failed.index + 1} (${failed.name}): ${failed.reason}`;
  } else if (error) {
    result = 'ERROR';
    reason = error;
  } else if (errored) {
    result = 'ERROR';
    failedStep = errored.index;
    reason = `Adım ${errored.index + 1} (${errored.name}): ${errored.reason}`;
  }

  const measurements = steps.flatMap((s) => (s.measurements ?? []).map((m) => ({ step: s.index, ...m })));
  const captures = {};
  for (const s of steps) if (s.capture && s.status === 'PASS' && s.data?.reply) captures[s.capture] = s.data.reply;
  return { result, reason, failedStep, steps, teardown, measurements, captures, safety: evaluateSafety(teardown) };
}

/**
 * Whether the station could confirm the board was left in a safe state.
 * Kept apart from the verdict: a board can PASS while the station failed to switch it off.
 *   SAFE        every critical teardown step passed
 *   UNSAFE      a critical step got a wrong reply or a device error
 *   UNVERIFIED  a critical step got no reply or could not be sent
 *   NOT_CHECKED the recipe has no critical teardown step
 */
export function evaluateSafety(teardown) {
  const critical = teardown.filter((s) => s.critical);
  if (!critical.length) return { state: 'NOT_CHECKED', reason: 'Reçetede kritik kapatma adımı yok' };
  const unsafe = critical.find((s) => s.status === 'FAIL');
  if (unsafe) return { state: 'UNSAFE', reason: `${unsafe.name}: ${unsafe.reason}` };
  const unverified = critical.find((s) => s.status !== 'PASS');
  if (unverified) {
    return { state: 'UNVERIFIED', reason: `${unverified.name}: ${unverified.reason ?? 'çalıştırılamadı'}` };
  }
  return { state: 'SAFE', reason: null };
}

// ---------- default products ----------

/** Both products are implemented by the device simulator and by examples/arduino/svb_fixture. */
export const DEFAULT_PRODUCTS = [
  {
    code: 'SVB-100',
    name: 'Sensör kartı',
    serialMask: 'SNS-######',
    maxAttempts: 3,
    recipe: {
      stopOnFail: true,
      steps: [
        { type: 'command', name: 'Seri numarasını yaz', send: 'SN {serial}', expect: 'OK' },
        { type: 'command', name: 'Kimlik ve firmware', send: 'ID?', expect: 'ID SVB-100 FW1.4.*', retries: 1, capture: 'firmware' },
        { type: 'command', name: 'Beslemeyi aç', send: 'PWR ON', expect: 'OK' },
        { type: 'delay', name: 'Oturma süresi', ms: 300 },
        {
          type: 'measure',
          name: 'Besleme ölçümü',
          send: 'MEAS?',
          samples: 5,
          intervalMs: 100,
          timeoutMs: 800,
          retries: 1,
          limits: [
            { key: 'V', name: 'Voltaj', unit: 'V', min: 4.9, max: 5.1 },
            { key: 'I', name: 'Akım', unit: 'mA', min: 80, max: 150 },
          ],
        },
        { type: 'command', name: 'Sensör self-test', send: 'SELFTEST', expect: 'OK', timeoutMs: 2000 },
        { type: 'confirm', name: 'LED kontrolü', send: 'LED ON', prompt: 'Karttaki yeşil LED yanıyor mu?' },
      ],
      teardown: [
        { type: 'command', name: 'LED kapat', send: 'LED OFF', expect: 'OK' },
        { type: 'command', name: 'Beslemeyi kapat', send: 'PWR OFF', expect: 'OK', retries: 2, critical: true },
        { type: 'command', name: 'Kapalı olduğunu doğrula', send: 'STATUS?', expect: 'PWR=0 *', retries: 2, critical: true },
      ],
    },
  },
  {
    code: 'SVB-200',
    name: 'Güç kartı',
    serialMask: 'PWR-######',
    maxAttempts: 2,
    recipe: {
      stopOnFail: true,
      steps: [
        { type: 'command', name: 'Seri numarasını yaz', send: 'SN {serial}', expect: 'OK' },
        { type: 'command', name: 'Kimlik ve firmware', send: 'ID?', expect: 'ID SVB-200 FW2.*', retries: 1, capture: 'firmware' },
        { type: 'command', name: 'Beslemeyi aç', send: 'PWR ON', expect: 'OK' },
        { type: 'delay', name: 'Oturma süresi', ms: 500 },
        {
          type: 'measure',
          name: 'Çıkış ölçümü',
          send: 'MEAS?',
          samples: 10,
          intervalMs: 50,
          timeoutMs: 800,
          retries: 1,
          limits: [
            { key: 'V', name: '12 V hat', unit: 'V', min: 11.7, max: 12.3 },
            { key: 'I', name: 'Boştaki akım', unit: 'mA', min: 20, max: 60 },
            { key: 'T', name: 'Regülatör sıcaklığı', unit: '°C', min: 10, max: 60 },
          ],
        },
      ],
      teardown: [
        { type: 'command', name: 'Beslemeyi kapat', send: 'PWR OFF', expect: 'OK', retries: 2, critical: true },
        { type: 'command', name: 'Kapalı olduğunu doğrula', send: 'STATUS?', expect: 'PWR=0 *', retries: 2, critical: true },
      ],
    },
  },
];
