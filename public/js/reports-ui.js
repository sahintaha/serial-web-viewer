// ============================================
// REPORTS — yields per product (attempt yield, first-pass yield, final yield),
// daily results, failure Pareto, and the distribution / capability of one
// measurement. Simulation results are excluded unless the source filter asks.
// All numbers come from the store's aggregate queries, not from the visible page.
// ============================================

import { formatValue, EVALUATION_MODES } from './recipe.js';
import { $, el } from './dom.js';

const pct = (v) => (v === null || v === undefined ? '—' : `%${v}`);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function dayBound(value, end) {
  return value ? new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`).toISOString() : undefined;
}

export function initReports({ store, app }) {
  const charts = {};
  let report = null;
  let distribution = null;
  let token = 0;

  function readFilters() {
    return { product: $('rp-product').value, source: $('rp-source').value, from: dayBound($('rp-from').value, false), to: dayBound($('rp-to').value, true) };
  }

  function chart(id, config) {
    charts[id]?.destroy();
    if (!window.Chart) return;
    charts[id] = new window.Chart($(id), config);
  }

  function axes(extra = {}) {
    const grid = { color: cssVar('--border') };
    const ticks = { color: cssVar('--text-2'), font: { family: cssVar('--mono'), size: 11 } };
    return { x: { grid, ticks, ...extra.x }, y: { grid, ticks, beginAtZero: true, ...extra.y }, ...extra.more };
  }

  async function refresh() {
    const mine = ++token;
    try {
      const filters = readFilters();
      const r = await store.report(filters);
      if (mine !== token) return;
      report = r;
      renderYields();
      renderDaily();
      renderPareto();
      renderMeasureOptions();
      await refreshDistribution();
    } catch (err) {
      if (mine === token) app.showToast(`Rapor hesaplanamadı: ${err.message}`);
    }
  }

  function renderYields() {
    const rows = report.products;
    $('rp-products').replaceChildren(
      ...(rows.length
        ? rows.map((p) =>
            el(
              'tr',
              {},
              el('td', { className: 'mono', textContent: p.product ?? '—' }),
              ...[p.tests, p.PASS, p.FAIL, p.ERROR, p.retests, p.units].map((n) => el('td', { className: 'num', textContent: n })),
              ...[p.attemptYield, p.fpy, p.finalYield].map((v) => el('td', { className: 'num', textContent: pct(v) }))
            )
          )
        : [el('tr', { className: 'table-empty' }, el('td', { colSpan: 10, textContent: $('rp-source').value === 'simulation' || $('rp-source').value === 'all' ? 'Bu filtreyle test yok' : 'Bu filtreyle üretim testi yok. Simülatörle yapılan testler için Kaynak: Simülasyon seçin.' }))])
    );
  }

  function renderDaily() {
    const days = [...new Set(report.daily.map((d) => d.day))].sort();
    const sum = (day, result) => report.daily.filter((d) => d.day === day && d.result === result).reduce((a, d) => a + d.n, 0);
    const dataset = (result, label, color) => ({ label, data: days.map((d) => sum(d, result)), backgroundColor: color, stack: 'r' });
    chart('rp-daily', {
      type: 'bar',
      data: { labels: days, datasets: [dataset('PASS', 'PASS', cssVar('--pass')), dataset('FAIL', 'FAIL', cssVar('--fail')), dataset('ERROR', 'HATA', cssVar('--warn'))] },
      options: { maintainAspectRatio: false, animation: false, scales: axes({ x: { stacked: true }, y: { stacked: true, ticks: { precision: 0, color: cssVar('--text-2') } } }), plugins: { legend: { labels: { color: cssVar('--text-2') } } } },
    });
  }

  function renderPareto() {
    const rows = report.pareto;
    const total = rows.reduce((a, r) => a + r.n, 0);
    let running = 0;
    const cumulative = rows.map((r) => {
      running += r.n;
      return Math.round((running / total) * 1000) / 10;
    });
    chart('rp-pareto', {
      type: 'bar',
      data: {
        labels: rows.map((r) => `${r.result === 'ERROR' ? 'HATA' : 'FAIL'} · ${r.cause}`),
        datasets: [
          { type: 'bar', label: 'Adet', data: rows.map((r) => r.n), backgroundColor: rows.map((r) => (r.result === 'FAIL' ? cssVar('--fail') : cssVar('--warn'))), yAxisID: 'y' },
          { type: 'line', label: 'Kümülatif %', data: cumulative, borderColor: cssVar('--accent'), backgroundColor: cssVar('--accent'), yAxisID: 'pct', pointRadius: 2 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        animation: false,
        scales: axes({ x: { ticks: { color: cssVar('--text-2'), autoSkip: false, maxRotation: 60 } }, y: { ticks: { precision: 0, color: cssVar('--text-2') } }, more: { pct: { position: 'right', min: 0, max: 100, grid: { display: false }, ticks: { color: cssVar('--text-2') } } } }),
        plugins: { legend: { labels: { color: cssVar('--text-2') } } },
      },
    });
  }

  function renderMeasureOptions() {
    const select = $('rp-measure');
    const current = select.value;
    const options = report.measurements.map((m) => new Option(`${m.product} · ${m.name} (${m.key}${m.unit ? ', ' + m.unit : ''}) · n=${m.n}`, `${m.product}|${m.key}`, false, `${m.product}|${m.key}` === current));
    select.replaceChildren(...(options.length ? options : [new Option('Ölçüm yok', '')]));
  }

  async function refreshDistribution() {
    const [product, key] = $('rp-measure').value.split('|');
    if (!product || !key) {
      distribution = null;
      renderDistribution();
      return;
    }
    const mine = token;
    const d = await store.measurementReport(readFilters(), product, key);
    if (mine !== token) return;
    distribution = d;
    renderDistribution();
  }

  function renderDistribution() {
    const d = distribution;
    const kv = (k, v) => [el('dt', { textContent: k }), el('dd', { className: 'mono', textContent: v })];
    if (!d) {
      charts['rp-histogram']?.destroy();
      $('rp-stats').replaceChildren();
      $('rp-notes').replaceChildren();
      return;
    }
    const inLimits = (bin) => !d.limits || (bin.to > d.limits.min && bin.from < d.limits.max);
    chart('rp-histogram', {
      type: 'bar',
      data: {
        labels: d.histogram.map((b) => formatValue((b.from + b.to) / 2)),
        datasets: [{ label: 'Ölçüm sayısı', data: d.histogram.map((b) => b.count), backgroundColor: d.histogram.map((b) => (inLimits(b) ? cssVar('--accent') : cssVar('--fail'))), barPercentage: 1, categoryPercentage: 1 }],
      },
      options: { maintainAspectRatio: false, animation: false, scales: axes({ y: { ticks: { precision: 0, color: cssVar('--text-2') } } }), plugins: { legend: { display: false } } },
    });
    $('rp-stats').replaceChildren(
      ...kv('n', d.n),
      ...kv('Ortalama', d.mean === null ? '—' : formatValue(d.mean)),
      ...kv('Std. sapma', d.sd === null ? '—' : formatValue(d.sd)),
      ...kv('Min / max', d.min === null ? '—' : `${formatValue(d.min)} / ${formatValue(d.max)}`),
      ...kv('Limitler', d.limits ? `${formatValue(d.limits.min)} … ${formatValue(d.limits.max)}` : 'dönem içinde değişmiş'),
      ...kv('Cpk', d.cpk === null ? '— (koşullar sağlanmıyor)' : d.cpk.toFixed(2)),
      ...kv('Revizyonlar', d.revisions.join(', ') || '—'),
      ...kv('Değerlendirme', d.modes.map((m) => EVALUATION_MODES[m] ?? m).join(', ') || '—')
    );
    $('rp-notes').replaceChildren(...d.notes.map((n) => el('li', { textContent: n })));
  }

  $('rp-filters').addEventListener('submit', (e) => {
    e.preventDefault();
    refresh();
  });
  $('rp-measure').addEventListener('change', () => refreshDistribution().catch((err) => app.showToast(err.message)));

  return {
    refresh,
    onTheme() {
      if (!report) return;
      renderDaily();
      renderPareto();
      renderDistribution();
    },
    setProducts(products) {
      const current = $('rp-product').value;
      $('rp-product').replaceChildren(new Option('Tüm ürünler', ''), ...products.map((p) => new Option(p.code, p.code, false, p.code === current)));
    },
  };
}
