// ============================================
// MONITOR — live view of the serial line: raw log (pause, search, HEX, long-term
// recording), latest values, charts, labels and manual / periodic commands.
//
// Limits keep a fast or misbehaving device from exhausting the page:
//   - lines are rendered once per animation frame, at most MAX_PENDING per frame
//     (the rest are counted as "not displayed"; recording and history still get them)
//   - the raw log keeps MAX_RAW_LINES lines, the history MAX_HISTORY_ROWS rows
//   - charts keep MAX_CHART_POINTS points and at most MAX_SERIES series
//   - raw bytes for the HEX view are kept in a RAW_BUFFER-byte ring
// ============================================

import { parseLine, rowsToCsv } from './parser.js';
import { parseReply } from './channel.js';
import { $, el, download, formatBytes } from './dom.js';

const MAX_RAW_LINES = 500;
const MAX_HISTORY_ROWS = 10000;
const MAX_PENDING = 2000;
const MAX_CHART_POINTS = 100;
const MAX_SERIES = 12;
const RAW_BUFFER = 64 * 1024;
const HEX_SHOWN = 4096;
const MEMORY_RECORDING_LIMIT = 50 * 1024 * 1024;
// Muted, distinguishable series colours (no neon)
const COLORS = ['#2b5fa8', '#c0711f', '#2f8f6a', '#8a4fb3', '#b23a48', '#3d8ea3', '#7d7a2a', '#5f6b78'];
const DEFAULT_LABELS = [
  { prefix: 'A', label: 'Sıcaklık' },
  { prefix: 'B', label: 'Nem' },
  { prefix: 'C', label: 'Basınç' },
  { prefix: 'D', label: 'Işık' },
];
const DEFAULT_PANELS = [
  { id: 'raw-1', type: 'raw' },
  { id: 'tagged-1', type: 'tagged' },
  { id: 'chart-1', type: 'chart' },
];

/** Classic hex dump: offset, 16 bytes, ASCII. */
export function hexDump(bytes, startOffset = 0) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.subarray(i, i + 16);
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${(startOffset + i).toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
  }
  return lines.join('\n');
}

/** Fixed-size byte ring for the HEX view; remembers the absolute offset of its first byte. */
class ByteRing {
  constructor(size) {
    this.buffer = new Uint8Array(size);
    this.length = 0;
    this.total = 0;
  }

  push(bytes) {
    this.total += bytes.length;
    if (bytes.length >= this.buffer.length) {
      this.buffer.set(bytes.subarray(bytes.length - this.buffer.length));
      this.length = this.buffer.length;
      return;
    }
    const keep = Math.min(this.length, this.buffer.length - bytes.length);
    this.buffer.copyWithin(0, this.length - keep, this.length);
    this.buffer.set(bytes, keep);
    this.length = keep + bytes.length;
  }

  tail(n) {
    const count = Math.min(n, this.length);
    return { bytes: this.buffer.subarray(this.length - count, this.length), offset: this.total - count };
  }
}

/**
 * Long-term log recording. Streams to a file the user picks when the browser allows it
 * (File System Access API); otherwise buffers in memory up to a limit and downloads on stop.
 */
class Recording {
  static async start() {
    const rec = new Recording();
    const name = `serial-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    if (typeof window.showSaveFilePicker === 'function') {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Metin', accept: { 'text/plain': ['.txt'] } }] });
      rec.writable = await handle.createWritable();
      rec.target = handle.name;
    } else {
      rec.chunks = [];
      rec.target = `${name} (bellekte, en fazla ${formatBytes(MEMORY_RECORDING_LIMIT)})`;
      rec.name = name;
    }
    rec.startedAt = new Date();
    return rec;
  }

  constructor() {
    this.bytes = 0;
    this.lines = 0;
    this.queue = Promise.resolve();
    this.full = false;
  }

  write(rows) {
    if (this.full) return;
    const text = rows.map((r) => `${r.time}\t${r.raw}\n`).join('');
    this.bytes += text.length;
    this.lines += rows.length;
    if (this.writable) {
      this.queue = this.queue.then(() => this.writable.write(text)).catch((err) => {
        this.error = err.message;
      });
    } else {
      this.chunks.push(text);
      if (this.bytes >= MEMORY_RECORDING_LIMIT) this.full = true;
    }
  }

  async stop() {
    if (this.writable) {
      await this.queue;
      await this.writable.close();
    } else {
      download(this.chunks.join(''), this.name, 'text/plain;charset=utf-8');
    }
  }
}

/**
 * @param {object} app
 * @param {{get: Function, set: Function}} app.storage
 * @param {(message: string, type?: string) => void} app.showToast
 * @param {() => import('./channel.js').CommandChannel|null} app.getChannel
 * @param {() => {subscribeRaw?: Function}|null} app.getTransport
 */
export function initMonitor(app) {
  const state = {
    labels: app.storage.get('labels', DEFAULT_LABELS),
    panels: app.storage.get('panels', DEFAULT_PANELS),
    history: [],
    lineCount: 0,
    notDisplayed: 0,
    overflows: 0,
    autoSendTimer: null,
    recording: null,
    rawPanels: new Map(), // id → { paused, pausedAt, filter, hex }
  };
  const raw = new ByteRing(RAW_BUFFER);
  const series = { labels: [], datasets: new Map(), dropped: new Set() };
  const charts = new Map();
  let pendingRows = [];
  let frameRequested = false;

  // ---------- incoming data ----------

  function handleLine(line) {
    const isReply = parseReply(line) !== null;
    const row = {
      time: new Date().toISOString(),
      raw: line,
      // Protocol replies ("@...") answer a command; they are not telemetry for readouts and charts
      reply: isReply,
      fields: isReply ? [] : parseLine(line, state.labels),
    };
    state.lineCount += 1;
    state.history.push(row);
    if (state.history.length > MAX_HISTORY_ROWS) state.history.shift();
    state.recording?.write([row]);
    pendingRows.push(row);
    if (pendingRows.length > MAX_PENDING) {
      state.notDisplayed += pendingRows.length - MAX_PENDING;
      pendingRows = pendingRows.slice(-MAX_PENDING);
    }
    if (!frameRequested) {
      frameRequested = true;
      requestAnimationFrame(flushRows);
    }
  }

  function handleRaw(bytes) {
    raw.push(bytes);
    for (const [id, p] of state.rawPanels) if (p.hex && !p.paused) scheduleHex(id);
  }

  function handleOverflow(count) {
    state.overflows = count;
    renderCounters();
  }

  function flushRows() {
    frameRequested = false;
    const rows = pendingRows;
    pendingRows = [];
    if (!rows.length) return;
    for (const [id, p] of state.rawPanels) {
      if (p.paused || p.hex) continue;
      const log = document.querySelector(`[data-panel-id="${id}"] [data-role="raw-log"]`);
      if (log) appendRaw(log, p.filter ? rows.filter((r) => matches(r, p.filter)) : rows);
    }
    const latest = [...rows].reverse().find((r) => !r.reply);
    if (latest) document.querySelectorAll('[data-role="tagged"]').forEach((node) => renderTagged(node, latest));
    rows.forEach(pushToSeries);
    charts.forEach(syncChart);
    renderCounters();
  }

  const matches = (row, filter) => row.raw.toLowerCase().includes(filter);

  function logLine(row) {
    const div = el('div', { className: row.reply ? 'log-reply' : '' }, el('span', { className: 'log-time', textContent: new Date(row.time).toLocaleTimeString('tr-TR') }), ' ', row.raw);
    return div;
  }

  function appendRaw(log, rows) {
    if (!rows.length) return;
    const stickToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const fragment = document.createDocumentFragment();
    for (const row of rows.slice(-MAX_RAW_LINES)) fragment.append(logLine(row));
    log.append(fragment);
    while (log.childElementCount > MAX_RAW_LINES) log.firstElementChild.remove();
    if (stickToBottom) log.scrollTop = log.scrollHeight;
  }

  /** Rebuilds a raw log from the history (after resume or a filter change). */
  function rebuildRaw(id) {
    const p = state.rawPanels.get(id);
    const panel = document.querySelector(`[data-panel-id="${id}"]`);
    if (!p || !panel) return;
    const log = panel.querySelector('[data-role="raw-log"]');
    const hex = panel.querySelector('[data-role="hex"]');
    log.classList.toggle('hidden', p.hex);
    hex.classList.toggle('hidden', !p.hex);
    if (p.hex) {
      renderHex(id);
      return;
    }
    const rows = (p.filter ? state.history.filter((r) => matches(r, p.filter)) : state.history).slice(-MAX_RAW_LINES);
    log.replaceChildren(...rows.map(logLine));
    log.scrollTop = log.scrollHeight;
  }

  const hexScheduled = new Set();
  function scheduleHex(id) {
    if (hexScheduled.has(id)) return;
    hexScheduled.add(id);
    requestAnimationFrame(() => {
      hexScheduled.delete(id);
      renderHex(id);
    });
  }

  function renderHex(id) {
    const node = document.querySelector(`[data-panel-id="${id}"] [data-role="hex"]`);
    if (!node) return;
    const { bytes, offset } = raw.tail(HEX_SHOWN);
    node.textContent = bytes.length ? hexDump(bytes, offset) : 'Henüz bayt alınmadı';
    node.scrollTop = node.scrollHeight;
  }

  function renderCounters() {
    for (const [id, p] of state.rawPanels) {
      const panel = document.querySelector(`[data-panel-id="${id}"]`);
      if (!panel) continue;
      panel.querySelector('[data-role="line-count"]').textContent = `${state.lineCount} satır`;
      const notes = [];
      if (p.paused) notes.push(`Görüntü duraklatıldı — veri alımı${state.recording ? ' ve kayıt' : ''} sürüyor (${state.lineCount - p.pausedAt} yeni satır)`);
      if (state.notDisplayed) notes.push(`Yoğun veri: ${state.notDisplayed} satır ekrana basılmadı (geçmişte ve kayıtta var)`);
      if (state.overflows) notes.push(`${state.overflows} aşırı uzun satır atıldı (satır sonu gelmedi)`);
      if (series.dropped.size) notes.push(`Grafik ${MAX_SERIES} seriyle sınırlı; gösterilmeyen: ${[...series.dropped].slice(0, 5).join(', ')}`);
      const status = panel.querySelector('[data-role="raw-status"]');
      status.textContent = notes.join(' · ');
      status.classList.toggle('hidden', !notes.length);
      panel.querySelector('[data-action="pause-raw"]').textContent = p.paused ? 'Devam' : 'Duraklat';
      panel.querySelector('[data-action="hex-raw"]').setAttribute('aria-pressed', String(p.hex));
    }
    const recordButtons = document.querySelectorAll('[data-action="record-raw"]');
    recordButtons.forEach((b) => {
      b.textContent = state.recording ? `Kaydı durdur (${formatBytes(state.recording.bytes)})` : 'Kaydet…';
      b.classList.toggle('btn-stop', Boolean(state.recording));
    });
  }

  function renderTagged(node, row) {
    if (!row.fields.length) {
      node.replaceChildren(el('div', { className: 'readouts-empty', textContent: 'Veri bekleniyor' }));
      return;
    }
    node.replaceChildren(
      ...row.fields.map((f) =>
        el('div', { className: f.raw === '---' ? 'readout missing' : 'readout' }, el('span', { className: 'readout-label', textContent: f.label }), el('span', { className: 'readout-value', textContent: f.raw }))
      )
    );
  }

  // ---------- charts ----------

  function pushToSeries(row) {
    const numeric = row.fields.filter((f) => f.value !== null);
    if (!numeric.length) return;
    series.labels.push(new Date(row.time).toLocaleTimeString('tr-TR'));
    for (const f of numeric) {
      if (series.datasets.has(f.label)) continue;
      if (series.datasets.size >= MAX_SERIES) {
        series.dropped.add(f.label);
        continue;
      }
      // New series: pad with gaps so it lines up with the time axis
      series.datasets.set(f.label, new Array(series.labels.length - 1).fill(null));
    }
    const values = new Map(numeric.map((f) => [f.label, f.value]));
    for (const [label, data] of series.datasets) data.push(values.has(label) ? values.get(label) : null);
    if (series.labels.length > MAX_CHART_POINTS) {
      series.labels.shift();
      for (const data of series.datasets.values()) data.shift();
    }
  }

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function applyChartTheme(chart) {
    const text = cssVar('--text-2');
    const grid = cssVar('--border');
    if (chart.options.plugins.legend.labels) chart.options.plugins.legend.labels.color = text;
    for (const scale of Object.values(chart.options.scales)) {
      scale.ticks = { ...scale.ticks, color: text };
      if (scale.grid?.display !== false) scale.grid = { ...scale.grid, color: grid };
    }
    chart.update('none');
  }

  function createChart(canvas) {
    const chart = new window.Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        spanGaps: true,
        interaction: { intersect: false, mode: 'index' },
        plugins: { legend: { position: 'top', align: 'start', labels: { boxWidth: 14, boxHeight: 2, padding: 14 } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { family: "'IBM Plex Mono', monospace", size: 11 } } },
          y: { grid: {}, ticks: { font: { family: "'IBM Plex Mono', monospace", size: 11 } } },
        },
      },
    });
    applyChartTheme(chart);
    syncChart(chart);
    return chart;
  }

  function syncChart(chart) {
    chart.data.labels = series.labels.slice();
    let i = 0;
    for (const [label, data] of series.datasets) {
      let dataset = chart.data.datasets.find((d) => d.label === label);
      if (!dataset) {
        const color = COLORS[i % COLORS.length];
        dataset = { label, data: [], borderColor: color, backgroundColor: color, borderWidth: 1.5, tension: 0, pointRadius: 0, pointHoverRadius: 3 };
        chart.data.datasets.push(dataset);
      }
      dataset.data = data.slice();
      i += 1;
    }
    chart.update('none');
  }

  function resetChart() {
    series.labels = [];
    series.datasets.clear();
    series.dropped.clear();
    charts.forEach((chart) => {
      chart.data.datasets = [];
      syncChart(chart);
    });
  }

  // ---------- panels ----------

  const PANEL_META = {
    raw: { title: 'Gelen veri', subtitle: 'Ham satırlar' },
    tagged: { title: 'Son değerler', subtitle: 'Son satırın alanları' },
    chart: { title: 'Grafik', subtitle: 'Sayısal alanlar, son 100 ölçüm' },
  };

  function panelActions(type) {
    if (type === 'raw') {
      return [
        el('input', { className: 'input input-sm', type: 'search', placeholder: 'Ara / filtrele', ariaLabel: 'Log içinde ara', dataset: { role: 'raw-filter' } }),
        el('button', { className: 'btn btn-sm', type: 'button', dataset: { action: 'pause-raw' }, title: 'Yalnızca görüntüyü durdurur; veri alımı ve kayıt sürer', textContent: 'Duraklat' }),
        el('button', { className: 'btn btn-sm', type: 'button', dataset: { action: 'hex-raw' }, title: 'Ham baytları HEX olarak göster', textContent: 'HEX' }),
        el('button', { className: 'btn btn-sm', type: 'button', dataset: { action: 'record-raw' }, title: 'Gelen tüm satırları dosyaya kaydet', textContent: 'Kaydet…' }),
        el('button', { className: 'btn btn-sm', type: 'button', dataset: { action: 'clear-raw' }, textContent: 'Temizle' }),
      ];
    }
    if (type === 'tagged') return [el('button', { className: 'btn btn-sm', type: 'button', dataset: { action: 'export-csv' }, title: 'Kaydedilen satırları CSV olarak indir', textContent: 'CSV indir' })];
    return [el('button', { className: 'btn btn-sm', type: 'button', dataset: { action: 'reset-chart' }, textContent: 'Sıfırla' })];
  }

  function panelBody(type) {
    if (type === 'raw') {
      return [
        el('p', { className: 'raw-status hidden', dataset: { role: 'raw-status' }, ariaLive: 'polite' }),
        el('div', { className: 'log', dataset: { role: 'raw-log' }, tabIndex: 0, ariaLabel: 'Gelen satırlar' }),
        el('pre', { className: 'log hex hidden', dataset: { role: 'hex' }, tabIndex: 0, ariaLabel: 'HEX görünüm' }),
      ];
    }
    if (type === 'tagged') return [el('div', { className: 'readouts', dataset: { role: 'tagged' } }, el('div', { className: 'readouts-empty', textContent: 'Veri bekleniyor' }))];
    return [el('div', { className: 'chart-box' }, el('canvas', { role: 'img', ariaLabel: 'Sayısal alanların zaman grafiği' }))];
  }

  function renderPanel({ id, type }) {
    const meta = PANEL_META[type];
    const node = el(
      'section',
      { className: `panel panel-item${type === 'chart' ? ' panel-wide' : ''}`, dataset: { panelId: id, panelType: type }, ariaLabel: meta.title },
      el(
        'div',
        { className: 'panel-head' },
        el('div', { className: 'drag-handle', title: 'Sürükleyerek taşı', ariaHidden: 'true' }, ...Array.from({ length: 6 }, () => el('span'))),
        el('div', { className: 'panel-title' }, el('h2', { textContent: meta.title }), el('span', { className: 'panel-sub' }, meta.subtitle, type === 'raw' ? ' · ' : null, type === 'raw' ? el('span', { dataset: { role: 'line-count' }, textContent: '0 satır' }) : null)),
        el('div', { className: 'panel-actions' }, ...panelActions(type), el('button', { className: 'icon-btn sm', type: 'button', dataset: { action: 'delete-panel' }, title: 'Paneli kaldır', ariaLabel: 'Paneli kaldır', textContent: '×' }))
      ),
      el('div', { className: 'panel-body' }, ...panelBody(type))
    );
    $('panels-container').append(node);
    if (type === 'raw') {
      state.rawPanels.set(id, { paused: false, pausedAt: 0, filter: '', hex: false });
      rebuildRaw(id);
    }
    if (type === 'chart' && window.Chart) charts.set(id, createChart(node.querySelector('canvas')));
    if (type === 'tagged') {
      const last = [...state.history].reverse().find((r) => !r.reply);
      if (last) renderTagged(node.querySelector('[data-role="tagged"]'), last);
    }
    renderCounters();
  }

  const savePanels = () => app.storage.set('panels', state.panels);

  function addPanel(type) {
    const panel = { id: `${type}-${Date.now().toString(36)}`, type };
    state.panels.push(panel);
    renderPanel(panel);
    savePanels();
  }

  function deletePanel(node) {
    const id = node.dataset.panelId;
    charts.get(id)?.destroy();
    charts.delete(id);
    state.rawPanels.delete(id);
    state.panels = state.panels.filter((p) => p.id !== id);
    node.remove();
    savePanels();
  }

  function initSortable() {
    if (typeof window.Sortable === 'undefined') return;
    window.Sortable.create($('panels-container'), {
      handle: '.drag-handle',
      draggable: '.panel-item',
      animation: 200,
      ghostClass: 'sortable-ghost',
      onEnd: () => {
        const order = [...document.querySelectorAll('#panels-container .panel-item')].map((n) => n.dataset.panelId);
        state.panels.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        savePanels();
      },
    });
  }

  // ---------- labels ----------

  function renderLabels() {
    $('label-configs').replaceChildren(
      ...state.labels.map(({ prefix, label }) =>
        el(
          'div',
          { className: 'label-row' },
          el('input', { type: 'text', className: 'input mono prefix-input', placeholder: 'A', ariaLabel: 'Anahtar', value: prefix }),
          el('input', { type: 'text', className: 'input label-input', placeholder: 'Sıcaklık', ariaLabel: 'Görünen ad', value: label }),
          el('button', { type: 'button', className: 'icon-btn sm', dataset: { action: 'remove-label' }, ariaLabel: 'Etiketi sil', textContent: '×' })
        )
      )
    );
  }

  function readLabels() {
    state.labels = [...document.querySelectorAll('#label-configs .label-row')].map((row) => ({
      prefix: row.querySelector('.prefix-input').value.trim(),
      label: row.querySelector('.label-input').value.trim(),
    }));
    app.storage.set('labels', state.labels);
  }

  // ---------- sending ----------

  const ending = () => $('ending-select').value;

  async function sendText(text) {
    const channel = app.getChannel();
    if (!channel) {
      app.showToast('Önce bağlantı kurun');
      return false;
    }
    try {
      await channel.sendRaw(text, 'monitor', { ending: ending() });
      return true;
    } catch (err) {
      app.showToast(err.code === 'LOCKED' ? err.message : `Gönderilemedi: ${err.message}`);
      if (err.code === 'LOCKED' || err.code === 'NOT_CONNECTED') stopAutoSend();
      return false;
    }
  }

  function startAutoSend() {
    const text = $('send-input').value.trim();
    const interval = Number($('send-interval').value);
    const refuse = (message) => {
      app.showToast(message);
      $('auto-send-checkbox').checked = false;
    };
    if (!text) return refuse('Önce gönderilecek komutu yazın');
    if (!Number.isFinite(interval) || interval < 100) return refuse('Aralık en az 100 ms olmalıdır');
    if (!app.getChannel()) return refuse('Önce bağlantı kurun');
    stopAutoSend();
    state.autoSendTimer = setInterval(() => sendText(text), interval);
    $('auto-send-checkbox').checked = true;
  }

  function stopAutoSend() {
    clearInterval(state.autoSendTimer);
    state.autoSendTimer = null;
    $('auto-send-checkbox').checked = false;
  }

  // ---------- recording ----------

  async function toggleRecording() {
    if (state.recording) {
      const rec = state.recording;
      state.recording = null;
      await rec.stop();
      app.showToast(`Kayıt kapatıldı: ${rec.lines} satır, ${formatBytes(rec.bytes)}${rec.error ? ` (hata: ${rec.error})` : ''}`, rec.error ? 'error' : 'success');
    } else {
      try {
        state.recording = await Recording.start();
        app.showToast(`Kayıt başladı: ${state.recording.target}`, 'success');
      } catch (err) {
        if (err.name !== 'AbortError') app.showToast(`Kayıt başlatılamadı: ${err.message}`);
      }
    }
    renderCounters();
  }

  // ---------- events ----------

  function bindEvents() {
    $('send-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('send-input').value.trim();
      if (!text) return app.showToast('Lütfen gönderilecek veriyi girin');
      if (await sendText(text)) app.showToast(`Gönderildi: ${text}`, 'success');
    });
    $('auto-send-checkbox').addEventListener('change', (e) => (e.target.checked ? startAutoSend() : stopAutoSend()));
    $('label-configs').addEventListener('input', readLabels);
    $('panels-container').addEventListener('input', (e) => {
      if (e.target.dataset.role !== 'raw-filter') return;
      const id = e.target.closest('.panel-item').dataset.panelId;
      state.rawPanels.get(id).filter = e.target.value.trim().toLowerCase();
      rebuildRaw(id);
    });

    document.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const panel = target.closest('.panel-item');
      const id = panel?.dataset.panelId;
      switch (target.dataset.action) {
        case 'add-label':
          readLabels();
          state.labels.push({ prefix: '', label: '' });
          renderLabels();
          $('label-configs').lastElementChild.querySelector('input').focus();
          break;
        case 'remove-label':
          target.closest('.label-row').remove();
          readLabels();
          break;
        case 'add-panel':
          addPanel(target.dataset.type);
          app.closeAddPanel?.();
          break;
        case 'delete-panel':
          deletePanel(panel);
          break;
        case 'clear-raw':
          state.history = [];
          rebuildRaw(id);
          break;
        case 'pause-raw': {
          const p = state.rawPanels.get(id);
          p.paused = !p.paused;
          p.pausedAt = state.lineCount;
          if (!p.paused) rebuildRaw(id);
          renderCounters();
          break;
        }
        case 'hex-raw': {
          const p = state.rawPanels.get(id);
          p.hex = !p.hex;
          app.getTransport()?.subscribeRaw?.([...state.rawPanels.values()].some((x) => x.hex));
          rebuildRaw(id);
          renderCounters();
          break;
        }
        case 'record-raw':
          toggleRecording();
          break;
        case 'reset-chart':
          resetChart();
          break;
        case 'export-csv':
          if (!state.history.length) app.showToast('Dışa aktarılacak veri yok');
          else download('\uFEFF' + rowsToCsv(state.history.filter((r) => !r.reply)), `serial-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, 'text/csv;charset=utf-8');
          break;
      }
    });
  }

  renderLabels();
  state.panels.forEach(renderPanel);
  initSortable();
  bindEvents();

  return {
    handleLine,
    handleRaw,
    handleOverflow,
    stopAutoSend,
    onTheme: () => charts.forEach(applyChartTheme),
    resize: () => charts.forEach((c) => c.resize()),
    /** Called when the connection's test lock changes. */
    setLocked(locked) {
      for (const id of ['send-input', 'auto-send-checkbox', 'send-interval']) $(id).disabled = locked;
      document.querySelector('#send-form [type=submit]').disabled = locked;
      $('send-lock-hint').hidden = !locked;
      if (locked) stopAutoSend();
    },
  };
}
