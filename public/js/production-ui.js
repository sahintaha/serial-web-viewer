// ============================================
// PRODUCTION TEST VIEW
// Scan a serial number → collect N samples per measurement → PASS / FAIL / ERROR
// → save to SQLite (server mode) or browser storage (static demo).
// ============================================

import {
  DEFAULT_LIMITS,
  MAX_SAMPLE_COUNT,
  normalizeSerial,
  validateSerial,
  validateLimits,
  evaluateTest,
  formatValue,
} from './production.js';
import { ServerResultStore, LocalResultStore } from './results-store.js';

const TEST_TIMEOUT_MS = 15000;
const MAX_INVALID_LINES = 20;
const RESULT_TEXT = { PASS: 'PASS', FAIL: 'FAIL', ERROR: 'HATA' };

const $ = (id) => document.getElementById(id);

function el(tag, { dataset, ...props } = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  if (dataset) Object.assign(node.dataset, dataset);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'medium' });
}

/**
 * @param {object} app hooks provided by app.js
 * @param {(fn: (row) => void) => void} app.onLine
 * @param {(fn: (status) => void) => void} app.onStatus
 * @param {() => {connected: boolean, label?: string}} app.getConnection
 * @param {(message: string, type?: string) => void} app.showToast
 * @param {{get: Function, set: Function}} app.storage
 * @param {boolean} app.serverAvailable
 */
export function initProduction(app) {
  const store = app.serverAvailable ? new ServerResultStore() : new LocalResultStore();
  let limits = app.storage.get('productionLimits', DEFAULT_LIMITS);
  const live = new Map(); // latest numeric value per key, shown while idle
  let run = null; // the test in progress
  let lastResult = null;
  let frameRequested = false;

  // ---------- rendering ----------
  function scheduleRender() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      renderMeasurements();
      renderStatus();
    });
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

  function renderMeasurements() {
    const container = $('pt-measurements');
    const verdict = !run && lastResult ? new Map(lastResult.measurements.map((m) => [m.key, m])) : null;

    container.replaceChildren(
      ...limits.map((limit) => {
        let value;
        let status = null;
        let detail = '';
        if (run) {
          const samples = run.samples[limit.key] ?? [];
          value = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
          detail = `${samples.length}/${run.sampleCount} örnek`;
        } else if (verdict?.has(limit.key)) {
          const m = verdict.get(limit.key);
          value = m.value;
          status = m.status;
          detail = `${m.count} örnek ortalaması`;
        } else {
          value = live.get(limit.key) ?? null;
          detail = value === null ? 'Veri bekleniyor' : 'Canlı değer';
        }
        if (!status && value !== null) status = value < limit.min || value > limit.max ? 'FAIL' : 'PASS';

        const unit = limit.unit ? ` ${limit.unit}` : '';
        return el(
          'div',
          { className: `pt-measure ${status ? 'pt-' + status.toLowerCase() : ''}` },
          el('div', { className: 'pt-measure-head' },
            el('span', { className: 'pt-measure-name', textContent: limit.name }),
            el('span', { className: 'pt-measure-detail', textContent: detail })),
          el('div', { className: 'pt-measure-value', textContent: value === null ? '—' : `${formatValue(value, 3)}${unit}` }),
          gauge(limit, value),
          el('div', { className: 'pt-measure-limit', textContent: `Limit: ${formatValue(limit.min)} – ${formatValue(limit.max)}${unit}` })
        );
      })
    );
  }

  function renderStatus() {
    const box = $('pt-result');
    const { connected, label } = app.getConnection();
    $('pt-device').textContent = connected ? label || 'Bağlı' : 'Bağlı değil';
    $('pt-device').classList.toggle('muted', !connected);

    $('pt-start').disabled = !!run;
    $('pt-cancel').classList.toggle('hidden', !run);
    $('pt-retest').disabled = !!run || !lastResult;
    $('pt-limits-save').disabled = !!run;

    if (run) {
      const needed = run.limits.length * run.sampleCount;
      const got = run.limits.reduce((n, l) => n + run.samples[l.key].length, 0);
      const pct = Math.round((got / needed) * 100);
      box.className = 'pt-result pt-running';
      box.replaceChildren(
        el('div', { className: 'pt-result-title', textContent: 'Test ediliyor…' }),
        el('div', { className: 'pt-result-sub', textContent: `${run.serial} · ${got}/${needed} örnek · atlanan satır: ${run.invalidLines}` }),
        el('div', { className: 'pt-progress' }, Object.assign(el('div', { className: 'pt-progress-bar' }), { style: `width:${pct}%` }))
      );
    } else if (lastResult) {
      const r = lastResult;
      box.className = `pt-result pt-${r.result.toLowerCase()}`;
      box.replaceChildren(
        ...[
        el('div', { className: 'pt-result-title', textContent: RESULT_TEXT[r.result] }),
        el('div', {
          className: 'pt-result-sub',
          textContent: `${r.serial}${r.attempt ? ` · ${r.attempt}. deneme` : ''}${r.saved === false ? ' · KAYDEDİLEMEDİ' : ''}`,
        }),
          r.reason ? el('div', { className: 'pt-result-reason', textContent: r.reason }) : null,
        ].filter(Boolean)
      );
    } else {
      box.className = 'pt-result';
      box.replaceChildren(
        el('div', { className: 'pt-result-title muted', textContent: 'Hazır' }),
        el('div', { className: 'pt-result-sub', textContent: 'Seri numarasını okutun veya yazıp Enter\'a basın' })
      );
    }
  }

  // ---------- test run ----------
  function startTest(rawSerial) {
    if (run) return;
    const serial = normalizeSerial(rawSerial);
    const serialError = validateSerial(serial);
    $('pt-serial').classList.toggle('invalid', !!serialError);
    if (serialError) return app.showToast(serialError);

    const { limits: validLimits, errors } = validateLimits(limits);
    if (errors.length) return app.showToast(`Limit hatası: ${errors[0]}`);

    const sampleCount = Number($('pt-samples').value);
    if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > MAX_SAMPLE_COUNT) {
      return app.showToast(`Örnek sayısı 1–${MAX_SAMPLE_COUNT} arasında olmalı`);
    }
    if (!app.getConnection().connected) return app.showToast('Önce cihaza bağlanın (Demo modunu da kullanabilirsiniz)');

    app.storage.set('productionSampleCount', sampleCount);
    app.storage.set('productionOperator', $('pt-operator').value.trim());
    $('pt-serial').value = serial;
    lastResult = null;
    run = {
      serial,
      operator: $('pt-operator').value.trim(),
      sampleCount,
      limits: validLimits,
      samples: Object.fromEntries(validLimits.map((l) => [l.key, []])),
      invalidLines: 0,
      startedAt: new Date().toISOString(),
      timer: setTimeout(onTimeout, TEST_TIMEOUT_MS),
    };
    scheduleRender();
  }

  function addRow(row) {
    let valid = false;
    for (const limit of run.limits) {
      const field = row.fields.find((f) => f.key === limit.key);
      if (!field || field.value === null) continue;
      valid = true;
      const samples = run.samples[limit.key];
      if (samples.length < run.sampleCount) samples.push(field.value);
    }
    // Lines without any valid measurement (corrupted data, ACKs, debug prints) are skipped
    if (!valid) run.invalidLines += 1;
    if (run.invalidLines > MAX_INVALID_LINES) {
      finishRun(`Çok fazla hatalı / eksik veri (${run.invalidLines} satır atlandı)`);
      return;
    }
    if (run.limits.every((l) => run.samples[l.key].length >= run.sampleCount)) finishRun(null);
  }

  function onTimeout() {
    if (!run) return;
    const missing = run.limits
      .filter((l) => run.samples[l.key].length < run.sampleCount)
      .map((l) => `${l.name} (${run.samples[l.key].length}/${run.sampleCount})`);
    finishRun(`Zaman aşımı (${TEST_TIMEOUT_MS / 1000} sn): eksik ölçüm ${missing.join(', ')}`);
  }

  async function finishRun(error) {
    if (!run) return;
    const current = run;
    run = null;
    clearTimeout(current.timer);

    const submission = {
      serial: current.serial,
      operator: current.operator,
      sampleCount: current.sampleCount,
      startedAt: current.startedAt,
      finishedAt: new Date().toISOString(),
      limits: current.limits,
      samples: current.samples,
      error,
    };
    // Show the verdict immediately; the store re-validates and assigns the attempt number
    lastResult = {
      serial: current.serial,
      ...evaluateTest(current.samples, current.limits, { sampleCount: current.sampleCount, error }),
    };
    scheduleRender();

    try {
      lastResult = await store.save(submission);
      refreshHistory();
    } catch (err) {
      lastResult = { ...lastResult, saved: false };
      app.showToast(`Sonuç kaydedilemedi: ${err.message}`);
    }
    $('pt-serial').value = '';
    $('pt-serial').focus();
    scheduleRender();
  }

  // ---------- limits editor ----------
  function renderLimitsEditor() {
    $('pt-limits-body').replaceChildren(
      ...limits.map((l) => {
        const input = (field, value, attrs = {}) =>
          el('td', {}, el('input', { className: 'input pt-input', value: value ?? '', dataset: { field }, ...attrs }));
        const row = el(
          'tr',
          {},
          input('key', l.key, { placeholder: 'V', ariaLabel: 'Anahtar' }),
          input('name', l.name, { placeholder: 'Voltaj', ariaLabel: 'Ad' }),
          input('unit', l.unit, { placeholder: 'V', ariaLabel: 'Birim' }),
          input('min', l.min, { type: 'number', step: 'any', ariaLabel: 'Minimum' }),
          input('max', l.max, { type: 'number', step: 'any', ariaLabel: 'Maksimum' }),
          el('td', {}, el('button', { type: 'button', className: 'icon-btn sm', textContent: '×', title: 'Sil', dataset: { ptAction: 'remove-limit' } }))
        );
        return row;
      })
    );
  }

  function readLimitsEditor() {
    return [...$('pt-limits-body').querySelectorAll('tr')].map((tr) => {
      const get = (f) => tr.querySelector(`[data-field="${f}"]`).value;
      return { key: get('key'), name: get('name'), unit: get('unit'), min: get('min'), max: get('max') };
    });
  }

  function saveLimits() {
    const { limits: valid, errors } = validateLimits(readLimitsEditor());
    $('pt-limits-errors').replaceChildren(...errors.map((e) => el('li', { textContent: e })));
    if (errors.length) return;
    limits = valid;
    app.storage.set('productionLimits', limits);
    lastResult = null;
    renderLimitsEditor();
    scheduleRender();
    app.showToast('Limitler kaydedildi', 'success');
  }

  // ---------- history ----------
  function readFilters() {
    const day = (id, end) => {
      const v = $(id).value;
      return v ? new Date(`${v}T${end ? '23:59:59.999' : '00:00:00'}`).toISOString() : undefined;
    };
    return {
      serial: $('pt-filter-serial').value.trim(),
      result: $('pt-filter-result').value,
      from: day('pt-filter-from', false),
      to: day('pt-filter-to', true),
    };
  }

  async function refreshHistory() {
    try {
      const { items, stats } = await store.query({ ...readFilters(), limit: 100 });
      renderStats(stats);
      renderHistory(items);
    } catch (err) {
      app.showToast(`Geçmiş yüklenemedi: ${err.message}`);
    }
  }

  function renderStats(stats) {
    const chip = (label, value, cls = '') =>
      el('div', { className: `pt-stat ${cls}` }, el('span', { textContent: label }), el('strong', { textContent: value }));
    $('pt-stats').replaceChildren(
      chip('Toplam', stats.total),
      chip('PASS', stats.PASS, 'pt-pass'),
      chip('FAIL', stats.FAIL, 'pt-fail'),
      chip('HATA', stats.ERROR, 'pt-error'),
      chip('Verim', stats.yield === null ? '—' : `%${stats.yield}`)
    );
  }

  function renderHistory(items) {
    const body = $('pt-history-body');
    if (!items.length) {
      body.replaceChildren(el('tr', { className: 'table-empty' }, el('td', { colSpan: 7, textContent: 'Kayıt yok' })));
      return;
    }
    body.replaceChildren(
      ...items.map((r) =>
        el(
          'tr',
          {},
          el('td', { textContent: formatDateTime(r.finishedAt) }),
          el('td', { className: 'mono', textContent: r.serial }),
          el('td', { textContent: r.attempt }),
          el('td', {}, el('span', { className: `badge badge-${r.result.toLowerCase()}`, textContent: RESULT_TEXT[r.result] })),
          el('td', { className: 'mono' }, ...r.measurements.map((m) =>
            el('div', {
              className: m.status === 'PASS' ? '' : `text-${m.status === 'FAIL' ? 'fail' : 'error'}`,
              textContent: `${m.name}: ${m.value === null ? '—' : formatValue(m.value)}${m.unit ? ' ' + m.unit : ''}`,
            }))),
          el('td', { className: 'pt-reason', textContent: r.reason || '' }),
          el('td', {}, el('button', {
            type: 'button',
            className: 'btn btn-sm',
            textContent: 'Tekrar test',
            dataset: { ptAction: 'retest-serial', serial: r.serial },
          }))
        )
      )
    );
  }

  // ---------- events ----------
  $('pt-form').addEventListener('submit', (e) => {
    e.preventDefault();
    startTest($('pt-serial').value);
  });
  $('pt-serial').addEventListener('input', () => $('pt-serial').classList.remove('invalid'));
  $('pt-cancel').addEventListener('click', () => finishRun('Test operatör tarafından iptal edildi'));
  $('pt-retest').addEventListener('click', () => lastResult && startTest(lastResult.serial));
  $('pt-limits-save').addEventListener('click', saveLimits);
  $('pt-limits-add').addEventListener('click', () => {
    limits = [...readLimitsEditor(), { key: '', name: '', unit: '', min: '', max: '' }];
    renderLimitsEditor();
  });
  $('pt-limits-reset').addEventListener('click', () => {
    limits = DEFAULT_LIMITS.map((l) => ({ ...l }));
    app.storage.set('productionLimits', limits);
    renderLimitsEditor();
    scheduleRender();
  });
  $('pt-filters').addEventListener('submit', (e) => {
    e.preventDefault();
    refreshHistory();
  });
  $('pt-export').addEventListener('click', () => store.exportCsv(readFilters()));

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-pt-action]');
    if (!target) return;
    if (target.dataset.ptAction === 'remove-limit') {
      target.closest('tr').remove();
      limits = readLimitsEditor();
    } else if (target.dataset.ptAction === 'retest-serial') {
      $('pt-serial').value = target.dataset.serial;
      startTest(target.dataset.serial);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  app.onLine((row) => {
    for (const f of row.fields) if (f.value !== null) live.set(f.key, f.value);
    if (run) addRow(row);
    scheduleRender();
  });

  app.onStatus(({ connected }) => {
    if (!connected && run) finishRun('Test sırasında cihaz bağlantısı koptu');
    scheduleRender();
  });

  // ---------- init ----------
  $('pt-samples').value = app.storage.get('productionSampleCount', 5);
  $('pt-operator').value = app.storage.get('productionOperator', '');
  $('pt-storage').textContent = store.kind === 'sqlite' ? 'SQLite' : 'Tarayıcı deposu';
  $('pt-storage').title =
    store.kind === 'sqlite'
      ? 'Sonuçlar sunucudaki SQLite veritabanına kaydediliyor'
      : 'Sunucu yok: sonuçlar bu tarayıcıda saklanıyor (npm start ile SQLite kullanılır)';
  renderLimitsEditor();
  scheduleRender();
  refreshHistory();
}
