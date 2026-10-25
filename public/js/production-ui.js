// ============================================
// PRODUCTION TEST VIEW
//   Station  — select product, scan serial, run the recipe, verdict, save
//   History  — query results, per-step detail, CSV report
//   Products — edit products and their recipes (each save = new revision)
// ============================================

import {
  validateProduct,
  validateSerial,
  normalizeSerial,
  evaluateRun,
  renderCommand,
  replyText,
  formatValue,
} from './recipe.js';
import { runTest, sleep, abortError } from './runner.js';
import { ServerStore, LocalStore } from './results-store.js';

const RESULT_TEXT = { PASS: 'PASS', FAIL: 'FAIL', ERROR: 'HATA' };
const STATUS_TEXT = { PENDING: 'bekliyor', RUNNING: 'çalışıyor', PASS: 'PASS', FAIL: 'FAIL', ERROR: 'HATA', SKIPPED: 'atlandı' };
const STATUS_BADGE = { PENDING: 'idle', RUNNING: 'run', PASS: 'pass', FAIL: 'fail', ERROR: 'error', SKIPPED: 'idle' };
const TYPE_TEXT = { command: 'komut', measure: 'ölçüm', delay: 'bekle', confirm: 'operatör' };

const $ = (id) => document.getElementById(id);

function el(tag, { dataset, ...props } = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const badge = (status, text = STATUS_TEXT[status] ?? status) =>
  el('span', { className: `badge badge-${STATUS_BADGE[status] ?? 'idle'}`, textContent: text });

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'medium' });
}

function duration(record) {
  const s = (Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000;
  return Number.isFinite(s) ? `${s.toFixed(1)} s` : '';
}

function download(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** One-line summary of what a step received, for the steps table. */
function stepOutput(step, data) {
  if (!data) return '';
  if (step.type === 'delay') return `${step.ms} ms`;
  if (step.type === 'measure') {
    if (step.measurements?.length) {
      return step.measurements
        .map((m) => `${m.key} ${m.value === null ? '—' : formatValue(m.value)}${m.unit ? ' ' + m.unit : ''}`)
        .join('  ');
    }
    const last = [...(data.replies ?? [])].reverse().find((r) => r !== null);
    return last ?? 'cevap yok';
  }
  if (step.type === 'confirm' && data.answer !== undefined && data.answer !== null) return data.answer ? 'Evet' : 'Hayır';
  return data.reply ?? 'cevap yok';
}

function stepRow(step, number, ctx) {
  const status = step.status ?? 'PENDING';
  const nameCell = el('td', {}, el('div', { textContent: step.name }));
  if (step.reason && status !== 'PASS') {
    nameCell.append(el('div', { className: `step-reason text-${status === 'FAIL' ? 'fail' : 'error'}`, textContent: step.reason }));
  }
  return el(
    'tr',
    { className: status === 'RUNNING' ? 'row-running' : '' },
    el('td', { className: 'num muted', textContent: number }),
    nameCell,
    el('td', { className: 'mono', textContent: step.send ? renderCommand(step.send, ctx) : '' }),
    el('td', { className: 'mono step-output', textContent: stepOutput(step, step.data) }),
    el('td', {}, badge(status)),
    el('td', { className: 'num muted', textContent: step.data?.durationMs ?? '' })
  );
}

function renderStepsTable(tbody, steps, teardown, ctx) {
  const rows = steps.map((s, i) => stepRow(s, i + 1, ctx));
  if (teardown.length) {
    rows.push(el('tr', { className: 'row-section' }, el('td', { colSpan: 6, textContent: 'Teardown — her durumda çalışır' })));
    rows.push(...teardown.map((s, i) => stepRow(s, `T${i + 1}`, ctx)));
  }
  tbody.replaceChildren(...rows);
}

function renderLog(container, entries) {
  container.replaceChildren(
    ...entries.map((e) =>
      el(
        'div',
        { className: `log-line log-${e.dir === '--' ? 'warn' : e.dir.toLowerCase()}` },
        el('span', { className: 'log-time', textContent: `${String(e.t).padStart(6, ' ')} ms` }),
        el('span', { className: 'log-dir', textContent: e.dir }),
        e.text
      )
    )
  );
  container.scrollTop = container.scrollHeight;
}

function gauge(limit, value) {
  const span = limit.max - limit.min || Math.abs(limit.max) || 1;
  const lo = limit.min - span * 0.25;
  const hi = limit.max + span * 0.25;
  const pct = (v) => Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
  const track = el('div', { className: 'pt-gauge' });
  const zone = el('div', { className: 'pt-gauge-zone' });
  zone.style.left = `${pct(limit.min)}%`;
  zone.style.width = `${pct(limit.max) - pct(limit.min)}%`;
  track.append(zone);
  if (value !== null && value !== undefined) {
    const marker = el('div', { className: 'pt-gauge-marker' });
    marker.style.left = `${pct(value)}%`;
    track.append(marker);
  }
  return track;
}

function measurementCards(container, measureSteps) {
  container.replaceChildren(
    ...measureSteps.flatMap((step) =>
      step.limits.map((limit) => {
        const m = step.measurements?.find((x) => x.key === limit.key);
        const value = m?.value ?? null;
        const status = m?.status ?? null;
        const unit = limit.unit ? ` ${limit.unit}` : '';
        return el(
          'div',
          { className: `pt-measure ${status ? 'pt-' + status.toLowerCase() : ''}` },
          el('div', { className: 'pt-measure-head' },
            el('span', { className: 'pt-measure-name', textContent: limit.name }),
            el('span', { className: 'pt-measure-detail', textContent: m ? `${m.count}/${step.samples} örnek ort.` : step.name })),
          el('div', { className: 'pt-measure-value', textContent: value === null ? '—' : `${formatValue(value)}${unit}` }),
          gauge(limit, value),
          el('div', { className: 'pt-measure-limit', textContent: `${formatValue(limit.min)} … ${formatValue(limit.max)}${unit}` })
        );
      })
    )
  );
}

/**
 * @param {object} app hooks provided by app.js
 * @param {(fn: (row) => void) => () => void} app.onLine subscribe to parsed lines, returns unsubscribe
 * @param {(fn: (status) => void) => void} app.onStatus
 * @param {() => {connected: boolean, label?: string}} app.getConnection
 * @param {(text: string) => Promise<void>} app.send
 * @param {(message: string, type?: string) => void} app.showToast
 * @param {{get: Function, set: Function}} app.storage
 * @param {boolean} app.serverAvailable
 */
export function initProduction(app) {
  const store = app.serverAvailable ? new ServerStore() : new LocalStore();
  let products = [];
  let product = null; // current revision of the selected product
  let run = null; // test in progress
  let last = null; // evaluated result of the last run (+ saved record fields)
  let logEntries = [];
  let unitLookup = 0;

  // ---------- operator dialog (confirm steps, retest questions) ----------
  function ask(question, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal.reason));
      const modal = $('pt-confirm');
      $('pt-confirm-question').textContent = question;
      modal.classList.add('show');
      $('pt-confirm-yes').focus();
      const finish = (fn, value) => {
        modal.classList.remove('show');
        $('pt-confirm-yes').removeEventListener('click', onYes);
        $('pt-confirm-no').removeEventListener('click', onNo);
        document.removeEventListener('keydown', onKey, true);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onYes = () => finish(resolve, true);
      const onNo = () => finish(resolve, false);
      const onAbort = () => finish(reject, abortError(signal.reason));
      const onKey = (e) => {
        const k = e.key.toLowerCase();
        if (k === 'e' || k === 'y') { e.preventDefault(); onYes(); }
        if (k === 'h' || k === 'n' || k === 'escape') { e.preventDefault(); onNo(); }
      };
      $('pt-confirm-yes').addEventListener('click', onYes);
      $('pt-confirm-no').addEventListener('click', onNo);
      document.addEventListener('keydown', onKey, true);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ---------- device io for the runner ----------
  const io = {
    request(command, timeoutMs, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError(signal.reason));
        let unsubscribe = () => {};
        const timer = setTimeout(() => done(resolve, null), timeoutMs);
        const onAbort = () => done(reject, abortError(signal.reason));
        function done(fn, value) {
          clearTimeout(timer);
          unsubscribe();
          signal?.removeEventListener('abort', onAbort);
          fn(value);
        }
        // Listen before sending so a fast reply cannot be missed
        unsubscribe = app.onLine((row) => {
          const reply = replyText(row.raw);
          if (reply !== null) done(resolve, reply);
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        app.send(command).catch((err) => done(reject, abortError(`Gönderilemedi: ${err.message}`)));
      });
    },
    confirm: (step, signal) => ask(step.prompt, signal),
    sleep,
  };

  // ---------- station ----------
  function idleSteps() {
    return {
      steps: product.recipe.steps.map((s) => ({ ...s, status: 'PENDING', data: null })),
      teardown: product.recipe.teardown.map((s) => ({ ...s, status: 'PENDING', data: null })),
    };
  }

  function renderStation() {
    const { connected, label } = app.getConnection();
    $('pt-start').disabled = !!run || !product;
    $('pt-start').classList.toggle('hidden', !!run);
    $('pt-cancel').classList.toggle('hidden', !run);
    $('pt-product').disabled = !!run;
    $('pt-serial').disabled = !!run;

    if (!product) return;
    $('pt-mask').textContent = `· ${product.serialMask}`;
    $('pt-serial').placeholder = product.serialMask;
    $('pt-recipe-info').textContent = `${product.code} rev ${product.revision} · ${product.recipe.steps.length} adım${product.recipe.stopOnFail ? ' · ilk hatada durur' : ''}`;

    // A blocked unit has no steps to show; fall back to the recipe outline
    const view = run ? run.view : last?.steps ? last : idleSteps();
    const ctx = { serial: run?.serial ?? last?.serial ?? '' };
    renderStepsTable($('pt-steps'), view.steps, view.teardown, ctx);
    measurementCards($('pt-measurements'), view.steps.filter((s) => s.type === 'measure'));

    const box = $('pt-result');
    if (run) {
      const done = run.view.steps.filter((s) => !['PENDING', 'RUNNING'].includes(s.status)).length;
      const current = run.view.steps.find((s) => s.status === 'RUNNING') ?? run.view.teardown.find((s) => s.status === 'RUNNING');
      box.className = 'pt-result pt-running';
      box.replaceChildren(
        el('div', { className: 'pt-result-title', textContent: 'TEST' }),
        el('div', { className: 'pt-result-sub', textContent: `${run.serial} · ${done}/${run.view.steps.length} adım${current ? ` · ${current.name}` : ''}` }),
        el('div', { className: 'pt-progress' }, Object.assign(el('div', { className: 'pt-progress-bar' }), { style: `width:${(done / run.view.steps.length) * 100}%` }))
      );
    } else if (last?.blocked) {
      box.className = 'pt-result pt-fail';
      box.replaceChildren(
        el('div', { className: 'pt-result-title', textContent: 'ONARIM' }),
        el('div', { className: 'pt-result-sub', textContent: last.serial }),
        el('div', { className: 'pt-result-reason', textContent: last.reason })
      );
    } else if (last) {
      const sub = [last.serial, last.attempt ? `${last.attempt}. deneme` : null, last.saved === false ? 'KAYDEDİLEMEDİ' : null].filter(Boolean).join(' · ');
      box.className = `pt-result pt-${last.result.toLowerCase()}`;
      box.replaceChildren(
        ...[
          el('div', { className: 'pt-result-title', textContent: RESULT_TEXT[last.result] }),
          el('div', { className: 'pt-result-sub', textContent: sub }),
          last.reason ? el('div', { className: 'pt-result-reason', textContent: last.reason }) : null,
        ].filter(Boolean)
      );
    } else {
      box.className = 'pt-result';
      box.replaceChildren(
        el('div', { className: 'pt-result-title muted', textContent: 'HAZIR' }),
        el('div', { className: 'pt-result-sub', textContent: connected ? `${label ?? 'Cihaz'} · seri numarasını okutun` : 'Önce soldan cihaza bağlanın' })
      );
    }
  }

  async function lookupUnit() {
    const serial = normalizeSerial($('pt-serial').value);
    const token = ++unitLookup;
    if (!product || validateSerial(serial, product.serialMask)) {
      $('pt-unit').textContent = '';
      return null;
    }
    try {
      const unit = await store.unitStatus(serial, product.code);
      if (token !== unitLookup) return unit;
      $('pt-unit').className = `pt-unit${unit.blocked ? ' text-fail' : ''}`;
      $('pt-unit').textContent = unit.attempts
        ? `${unit.attempts} deneme · son: ${RESULT_TEXT[unit.lastResult]} · FAIL ${unit.failures}/${product.maxAttempts}${unit.blocked ? ' · onarıma gönderin' : ''}`
        : 'Yeni kart';
      return unit;
    } catch {
      return null;
    }
  }

  async function startTest(rawSerial) {
    if (run || !product) return;
    const serial = normalizeSerial(rawSerial);
    const serialError = validateSerial(serial, product.serialMask);
    $('pt-serial').classList.toggle('invalid', !!serialError);
    if (serialError) return app.showToast(serialError);
    if (!app.getConnection().connected) return app.showToast('Önce cihaza bağlanın (donanım yoksa Simülatör modu)');

    const unit = await store.unitStatus(serial, product.code).catch(() => null);
    if (unit?.blocked) {
      last = { serial, blocked: true, reason: `Bu kart ${unit.failures} kez FAIL aldı (sınır ${product.maxAttempts}). Tekrar test edilmez; onarım istasyonuna gönderin.` };
      renderStation();
      return;
    }
    if (unit?.passed && !(await ask(`${serial} daha önce PASS aldı. Yine de tekrar test edilsin mi?`))) return;

    app.storage.set('productionOperator', $('pt-operator').value.trim());
    const testedProduct = product;
    const controller = new AbortController();
    run = { serial, controller, view: idleSteps() };
    last = null;
    logEntries = [];
    renderLog($('pt-log'), logEntries);
    renderStation();

    let raw;
    try {
      raw = await runTest({
        product: testedProduct,
        serial,
        io,
        signal: controller.signal,
        onProgress(event) {
          if (event.type === 'log') {
            logEntries.push(event.entry);
            renderLog($('pt-log'), logEntries);
            return;
          }
          const list = event.phase === 'steps' ? run.view.steps : run.view.teardown;
          list[event.index] = { ...list[event.index], status: event.status, ...(event.verdict ?? {}), data: event.data ?? list[event.index].data };
          renderStation();
        },
      });
    } catch (err) {
      run = null;
      renderStation();
      app.showToast(`Test çalıştırılamadı: ${err.message}`);
      return;
    }

    const verdict = evaluateRun(testedProduct.recipe, raw.steps, raw.teardown, { error: raw.error });
    run = null;
    last = { serial, ...verdict };
    renderStation();

    try {
      const record = await store.saveRun({
        serial,
        operator: $('pt-operator').value.trim(),
        productCode: testedProduct.code,
        recipeRevision: testedProduct.revision,
        startedAt: raw.startedAt,
        finishedAt: raw.finishedAt,
        steps: raw.steps,
        teardown: raw.teardown,
        error: raw.error,
        log: raw.log,
      });
      // The stored verdict comes from the server's own evaluation
      last = record;
      if (record.result !== verdict.result) app.showToast('Sunucu kararı istasyondan farklı; sunucu kaydı gösteriliyor');
    } catch (err) {
      last = { ...last, saved: false };
      app.showToast(`Sonuç kaydedilemedi: ${err.message}`);
    }
    $('pt-serial').value = '';
    $('pt-unit').textContent = '';
    renderStation();
    $('pt-serial').focus();
    if (!$('pt-page-history').classList.contains('hidden')) refreshHistory();
  }

  async function selectProduct(code) {
    try {
      product = await store.getProduct(code);
      app.storage.set('productionProduct', code);
      last = null;
      $('pt-product').value = code;
      renderStation();
      lookupUnit();
    } catch (err) {
      app.showToast(`Ürün yüklenemedi: ${err.message}`);
    }
  }

  // ---------- history ----------
  function readFilters() {
    const day = (id, end) => {
      const v = $(id).value;
      return v ? new Date(`${v}T${end ? '23:59:59.999' : '00:00:00'}`).toISOString() : undefined;
    };
    return {
      serial: $('pt-filter-serial').value.trim(),
      product: $('pt-filter-product').value,
      result: $('pt-filter-result').value,
      from: day('pt-filter-from', false),
      to: day('pt-filter-to', true),
    };
  }

  let historyItems = [];

  async function refreshHistory() {
    try {
      const { items, stats } = await store.query({ ...readFilters(), limit: 200 });
      historyItems = items;
      renderStats(stats);
      renderHistory(items);
    } catch (err) {
      app.showToast(`Geçmiş yüklenemedi: ${err.message}`);
    }
  }

  function renderStats(stats) {
    const cell = (label, value, cls = '') =>
      el('div', { className: `pt-stat ${cls}` }, el('span', { textContent: label }), el('strong', { textContent: value }));
    $('pt-stats').replaceChildren(
      cell('Toplam', stats.total),
      cell('PASS', stats.PASS, 'pt-pass'),
      cell('FAIL', stats.FAIL, 'pt-fail'),
      cell('HATA', stats.ERROR, 'pt-error'),
      cell('Verim', stats.yield === null ? '—' : `%${stats.yield}`)
    );
  }

  function renderHistory(items) {
    const body = $('pt-history-body');
    if (!items.length) {
      body.replaceChildren(el('tr', { className: 'table-empty' }, el('td', { colSpan: 8, textContent: 'Kayıt yok' })));
      return;
    }
    body.replaceChildren(
      ...items.map((r, i) =>
        el(
          'tr',
          { className: 'row-link', dataset: { index: i }, tabIndex: 0 },
          el('td', { className: 'mono', textContent: formatDateTime(r.finishedAt) }),
          el('td', { className: 'mono', textContent: r.serial }),
          el('td', { className: 'mono', textContent: r.productCode ? `${r.productCode} r${r.recipeRevision}` : '—' }),
          el('td', { className: 'num', textContent: r.attempt }),
          el('td', {}, badge(r.result, RESULT_TEXT[r.result])),
          el('td', { className: 'pt-reason', textContent: r.reason ?? '' }),
          el('td', { textContent: r.operator ?? '' }),
          el('td', { className: 'num', textContent: duration(r) })
        )
      )
    );
  }

  function openDetail(record) {
    $('pt-detail-title').textContent = `${record.serial} · ${RESULT_TEXT[record.result]}`;
    $('pt-detail-sub').textContent = [
      record.productCode ? `${record.productCode} ${record.productName ?? ''} rev ${record.recipeRevision}` : null,
      `${record.attempt}. deneme`,
      formatDateTime(record.startedAt),
      duration(record),
      record.operator ? `operatör: ${record.operator}` : null,
    ].filter(Boolean).join(' · ');
    $('pt-detail-retest').dataset.serial = record.serial;
    $('pt-detail-retest').dataset.product = record.productCode ?? '';

    const stepsBody = el('tbody');
    renderStepsTable(stepsBody, record.steps ?? [], record.teardown ?? [], { serial: record.serial });
    const measurements = record.measurements ?? [];
    const logBox = el('div', { className: 'log comm-log' });
    renderLog(logBox, record.log ?? []);

    $('pt-detail-body').replaceChildren(
      ...[
        record.reason ? el('p', { className: `detail-reason text-${record.result === 'FAIL' ? 'fail' : 'error'}`, textContent: record.reason }) : null,
        el('h3', { className: 'section-title', textContent: 'Adımlar' }),
        record.steps?.length
          ? el('div', { className: 'table-wrap' }, el('table', { className: 'table' },
            el('thead', {}, el('tr', {}, ...['#', 'Adım', 'Komut', 'Cevap / değer', 'Durum', 'ms'].map((h) => el('th', { textContent: h })))),
            stepsBody))
          : el('p', { className: 'muted', textContent: 'Bu kayıt adım bilgisi içermiyor (eski sürüm).' }),
        measurements.length ? el('h3', { className: 'section-title', textContent: 'Ölçümler' }) : null,
        measurements.length
          ? el('div', { className: 'table-wrap' }, el('table', { className: 'table' },
            el('thead', {}, el('tr', {}, ...['Ölçüm', 'Değer', 'Min', 'Max', 'Örnek', 'Durum'].map((h) => el('th', { textContent: h })))),
            el('tbody', {}, ...measurements.map((m) => el('tr', {},
              el('td', { textContent: m.name }),
              el('td', { className: 'num', textContent: `${formatValue(m.value)}${m.unit ? ' ' + m.unit : ''}` }),
              el('td', { className: 'num', textContent: formatValue(m.min) }),
              el('td', { className: 'num', textContent: formatValue(m.max) }),
              el('td', { className: 'num', textContent: m.count }),
              el('td', {}, badge(m.status === 'MISSING' ? 'ERROR' : m.status, m.status === 'MISSING' ? 'eksik' : m.status)))))))
          : null,
        record.log?.length ? el('h3', { className: 'section-title', textContent: 'Haberleşme kaydı' }) : null,
        record.log?.length ? logBox : null,
      ].filter(Boolean)
    );
    $('pt-detail').classList.add('show');
  }

  // ---------- products editor ----------
  let editing = null; // { product (saved revision) | null for new }

  const NEW_TEMPLATE = {
    code: '',
    name: '',
    serialMask: 'ABC-######',
    maxAttempts: 3,
    recipe: {
      stopOnFail: true,
      steps: [
        { type: 'command', name: 'Seri numarasını yaz', send: 'SN {serial}', expect: 'OK' },
        { type: 'command', name: 'Beslemeyi aç', send: 'PWR ON', expect: 'OK' },
        { type: 'delay', name: 'Oturma süresi', ms: 300 },
        { type: 'measure', name: 'Ölçüm', send: 'MEAS?', samples: 5, intervalMs: 100, limits: [{ key: 'V', name: 'Voltaj', unit: 'V', min: 4.9, max: 5.1 }] },
      ],
      teardown: [{ type: 'command', name: 'Beslemeyi kapat', send: 'PWR OFF', expect: 'OK' }],
    },
  };

  function definitionOf(p) {
    return { code: p.code, name: p.name, serialMask: p.serialMask, maxAttempts: p.maxAttempts, recipe: p.recipe };
  }

  function fillEditor(def, saved) {
    editing = saved;
    $('pr-title').textContent = saved ? `${saved.code} · ${saved.name}` : 'Yeni ürün';
    $('pr-meta').textContent = saved ? `rev ${saved.revision} · son değişiklik ${formatDateTime(saved.updatedAt)}` : 'Henüz kaydedilmedi';
    $('pr-code').value = def.code;
    $('pr-code').readOnly = !!saved;
    $('pr-name').value = def.name;
    $('pr-mask').value = def.serialMask;
    $('pr-attempts').value = def.maxAttempts;
    $('pr-recipe').value = JSON.stringify(def.recipe, null, 2);
    $('pr-archive').disabled = !saved;
    $('pr-export').disabled = false;
    validateEditor();
    renderProductList();
  }

  function readEditor() {
    let recipe;
    try {
      recipe = JSON.parse($('pr-recipe').value);
    } catch (err) {
      return { errors: [`Reçete JSON hatası: ${err.message}`] };
    }
    return validateProduct({
      code: $('pr-code').value,
      name: $('pr-name').value,
      serialMask: $('pr-mask').value,
      maxAttempts: $('pr-attempts').value,
      recipe,
    });
  }

  function validateEditor() {
    const { product: def, errors } = readEditor();
    $('pr-errors').replaceChildren(...errors.map((e) => el('li', { textContent: e })));
    $('pr-recipe').classList.toggle('invalid', errors.some((e) => e.startsWith('Reçete JSON')));
    const dirty = !editing || !def || JSON.stringify(def) !== JSON.stringify(definitionOf(editing));
    $('pr-dirty').textContent = editing ? (dirty ? 'Kaydedilmemiş değişiklik var' : 'Kayıtlı revizyonla aynı') : '';
    $('pr-save').disabled = errors.length > 0 || (editing && !dirty);
    $('pr-save').textContent = editing ? `Kaydet → rev ${editing.revision + 1}` : 'Kaydet';

    const preview = $('pr-preview');
    if (!def || errors.some((e) => e.startsWith('Reçete JSON'))) {
      preview.replaceChildren();
      return;
    }
    const describe = (s) => {
      if (s.type === 'measure') return s.limits.map((l) => `${l.key}: ${formatValue(l.min)}…${formatValue(l.max)}${l.unit ? ' ' + l.unit : ''}`).join(', ') + ` (${s.samples} örnek)`;
      if (s.type === 'delay') return `${s.ms} ms`;
      if (s.type === 'confirm') return s.prompt;
      return s.expect;
    };
    const row = (s, n) => el('tr', {},
      el('td', { className: 'num muted', textContent: n }),
      el('td', { textContent: TYPE_TEXT[s.type] ?? s.type }),
      el('td', { textContent: s.name }),
      el('td', { className: 'mono', textContent: s.send ?? '' }),
      el('td', { className: 'mono', textContent: describe(s) ?? '' }));
    preview.replaceChildren(
      ...def.recipe.steps.map((s, i) => row(s, i + 1)),
      ...(def.recipe.teardown.length ? [el('tr', { className: 'row-section' }, el('td', { colSpan: 5, textContent: 'Teardown' }))] : []),
      ...def.recipe.teardown.map((s, i) => row(s, `T${i + 1}`))
    );
  }

  function renderProductList() {
    $('pr-list').replaceChildren(
      ...products.map((p) =>
        el('li', {},
          el('button', {
            type: 'button',
            className: `product-item${editing?.code === p.code ? ' active' : ''}`,
            dataset: { code: p.code },
          },
          el('span', { className: 'mono', textContent: p.code }),
          el('span', { textContent: p.name }),
          el('span', { className: 'muted mono', textContent: `rev ${p.revision}` })))
      )
    );
  }

  async function reloadProducts(selectCode) {
    products = await store.listProducts();
    const options = products.map((p) => new Option(`${p.code} — ${p.name}`, p.code));
    $('pt-product').replaceChildren(...options);
    $('pt-filter-product').replaceChildren(new Option('Tüm ürünler', ''), ...products.map((p) => new Option(p.code, p.code)));
    renderProductList();
    const code = selectCode && products.some((p) => p.code === selectCode) ? selectCode : products[0]?.code;
    if (code) await selectProduct(code);
    else {
      product = null;
      renderStation();
    }
  }

  async function saveEditor() {
    const { product: def, errors } = readEditor();
    if (errors.length) return;
    if (!editing && products.some((p) => p.code === def.code)) {
      app.showToast(`${def.code} zaten var; mevcut ürünü listeden seçip düzenleyin`);
      return;
    }
    try {
      const saved = await store.saveProduct(def);
      app.showToast(`${saved.code} rev ${saved.revision} kaydedildi`, 'success');
      await reloadProducts(product?.code === saved.code || !product ? saved.code : product.code);
      fillEditor(definitionOf(saved), saved);
    } catch (err) {
      app.showToast(`Kaydedilemedi: ${err.message}`);
    }
  }

  // ---------- pages ----------
  function showPage(page) {
    for (const name of ['station', 'history', 'products']) $(`pt-page-${name}`).classList.toggle('hidden', name !== page);
    document.querySelectorAll('#pt-subtabs .subtab').forEach((t) => t.classList.toggle('active', t.dataset.page === page));
    app.storage.set('productionPage', page);
    if (page === 'history') refreshHistory();
    if (page === 'products' && !editing && products[0]) fillEditor(definitionOf(products.find((p) => p.code === product?.code) ?? products[0]), products.find((p) => p.code === product?.code) ?? products[0]);
    if (page === 'station') $('pt-serial').focus();
  }

  // ---------- events ----------
  $('pt-subtabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.subtab');
    if (tab) showPage(tab.dataset.page);
  });
  $('pt-product').addEventListener('change', (e) => selectProduct(e.target.value));
  $('pt-form').addEventListener('submit', (e) => {
    e.preventDefault();
    startTest($('pt-serial').value);
  });
  let unitTimer = null;
  $('pt-serial').addEventListener('input', () => {
    $('pt-serial').classList.remove('invalid');
    clearTimeout(unitTimer);
    unitTimer = setTimeout(lookupUnit, 250);
  });
  $('pt-cancel').addEventListener('click', () => run?.controller.abort('Test operatör tarafından durduruldu'));

  $('pt-filters').addEventListener('submit', (e) => {
    e.preventDefault();
    refreshHistory();
  });
  $('pt-export').addEventListener('click', () => store.exportCsv(readFilters()));
  $('pt-history-body').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-index]');
    if (row) openDetail(historyItems[Number(row.dataset.index)]);
  });
  $('pt-history-body').addEventListener('keydown', (e) => {
    const row = e.target.closest('tr[data-index]');
    if (row && e.key === 'Enter') openDetail(historyItems[Number(row.dataset.index)]);
  });
  const closeDetail = () => $('pt-detail').classList.remove('show');
  $('pt-detail-close').addEventListener('click', closeDetail);
  $('pt-detail').addEventListener('click', (e) => e.target === $('pt-detail') && closeDetail());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDetail());
  $('pt-detail-retest').addEventListener('click', async (e) => {
    const { serial, product: code } = e.currentTarget.dataset;
    closeDetail();
    showPage('station');
    if (code && code !== product?.code && products.some((p) => p.code === code)) await selectProduct(code);
    $('pt-serial').value = serial;
    lookupUnit();
  });

  $('pr-list').addEventListener('click', (e) => {
    const item = e.target.closest('.product-item');
    if (!item) return;
    const p = products.find((x) => x.code === item.dataset.code);
    if (p) fillEditor(definitionOf(p), p);
  });
  $('pr-new').addEventListener('click', () => fillEditor(NEW_TEMPLATE, null));
  for (const id of ['pr-code', 'pr-name', 'pr-mask', 'pr-attempts', 'pr-recipe']) $(id).addEventListener('input', validateEditor);
  $('pr-save').addEventListener('click', saveEditor);
  $('pr-revert').addEventListener('click', () => (editing ? fillEditor(definitionOf(editing), editing) : fillEditor(NEW_TEMPLATE, null)));
  $('pr-export').addEventListener('click', () => {
    const { product: def } = readEditor();
    const data = def ?? (editing ? definitionOf(editing) : null);
    if (data) download(JSON.stringify(data, null, 2), `${data.code || 'urun'}.json`, 'application/json');
  });
  $('pr-import').addEventListener('click', () => $('pr-import-file').click());
  $('pr-import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const def = JSON.parse(await file.text());
      const existing = products.find((p) => p.code === String(def.code ?? '').toUpperCase()) ?? null;
      fillEditor({ ...NEW_TEMPLATE, ...def, recipe: def.recipe ?? NEW_TEMPLATE.recipe }, existing);
      app.showToast('Dosya editöre yüklendi; kaydedince yeni revizyon oluşur', 'success');
    } catch (err) {
      app.showToast(`Dosya okunamadı: ${err.message}`);
    }
  });
  $('pr-archive').addEventListener('click', async () => {
    if (!editing) return;
    if (!(await ask(`${editing.code} arşivlensin mi? Geçmiş test kayıtları korunur; ürün istasyon listesinden kalkar.`))) return;
    try {
      await store.archiveProduct(editing.code);
      app.showToast(`${editing.code} arşivlendi`, 'success');
      editing = null;
      await reloadProducts(product?.code);
      if (products[0]) fillEditor(definitionOf(products[0]), products[0]);
    } catch (err) {
      app.showToast(`Arşivlenemedi: ${err.message}`);
    }
  });

  app.onStatus(({ connected }) => {
    if (!connected && run) run.controller.abort('Test sırasında cihaz bağlantısı koptu');
    renderStation();
  });

  // ---------- init ----------
  $('pt-operator').value = app.storage.get('productionOperator', '');
  $('pt-storage').textContent = store.kind === 'sqlite' ? 'SQLite (sunucu)' : 'tarayıcı deposu';
  $('pt-storage').title =
    store.kind === 'sqlite'
      ? 'Sonuçlar ve ürünler sunucudaki SQLite veritabanında'
      : 'Sunucu yok (ör. GitHub Pages): veriler bu tarayıcıda saklanıyor. npm start ile SQLite kullanılır.';
  reloadProducts(app.storage.get('productionProduct', null))
    .then(() => showPage(app.storage.get('productionPage', 'station')))
    .catch((err) => app.showToast(`Ürünler yüklenemedi: ${err.message}`));
}
