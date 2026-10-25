// ============================================
// SERIAL WEB VIEWER — UI
// ============================================

import { parseLine, rowsToCsv } from './parser.js';
import { WebSerialTransport, ServerTransport, DemoTransport } from './transports.js';
import { initProduction } from './production-ui.js';
import { FAULTS } from './simulator.js';
import { replyText } from './recipe.js';

const MAX_RAW_LINES = 500;
const MAX_HISTORY_ROWS = 10000;
const MAX_CHART_POINTS = 100;
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
const MODE_HINTS = {
  webserial: 'Bağlan\'a basınca tarayıcı port seçim penceresi açılır. Kurulum gerekmez (Chrome / Edge).',
  server: 'Node.js sunucusu üzerinden bağlanır. Ayrı alıcı/verici port desteği vardır.',
  demo: "Donanım gerekmez. Sanal kart, gerçek fikstür firmware'iyle aynı komutlara cevap verir.",
};

const $ = (id) => document.getElementById(id);

// ---------- persistence (never let storage errors break the app) ----------
const storage = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable (private mode etc.)
    }
  },
};

// ---------- state ----------
const state = {
  mode: null,
  available: { webserial: WebSerialTransport.isSupported(), server: false, demo: true },
  transport: null,
  connected: false,
  connecting: false,
  labels: storage.get('labels', DEFAULT_LABELS),
  panels: storage.get('panels', DEFAULT_PANELS),
  history: [],
  lineCount: 0,
  autoSendTimer: null,
};

// Shared time series used by every chart panel
const series = { labels: [], datasets: new Map() };
const charts = new Map();

// Other views (production test) subscribe to incoming lines and connection changes
const lineListeners = new Set();
const statusListeners = new Set();

// Lines are rendered once per animation frame so fast devices don't freeze the page
let pendingRows = [];
let frameRequested = false;

// ---------- toast ----------
let toastTimer = null;
function showToast(message, type = 'error') {
  const toast = $('toast');
  toast.className = `toast show toast-${type}`;
  $('toast-message').textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(closeToast, 4000);
}

function closeToast() {
  $('toast').classList.remove('show');
}

// ---------- theme ----------
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('theme', next);
  } catch {
    // ignore
  }
  charts.forEach(applyChartTheme);
}

// ---------- modes & connection ----------
function setMode(mode) {
  if (state.connected || state.connecting || !state.available[mode]) return;
  state.mode = mode;
  storage.set('mode', mode);
  document.querySelectorAll('#mode-selector .seg-item').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  });
  $('mode-hint').textContent = MODE_HINTS[mode];
  $('server-ports').classList.toggle('hidden', mode !== 'server');
  $('baud-group').classList.toggle('hidden', mode === 'demo');
  $('sim-panel').classList.toggle('hidden', mode !== 'demo');
  if (mode === 'demo') ensureSimulator();
  if (mode === 'server') loadPorts();
}

function updateModeAvailability() {
  document.querySelectorAll('#mode-selector .seg-item').forEach((btn) => {
    const mode = btn.dataset.mode;
    btn.disabled = !state.available[mode] || state.connected || state.connecting;
  });
}

function createTransport(mode) {
  const handlers = { onLine: handleLine, onStatus: handleStatus, onError: (e) => showToast(e) };
  if (mode === 'webserial') return new WebSerialTransport(handlers);
  if (mode === 'server') return new ServerTransport(handlers);
  return new DemoTransport(handlers);
}

function selectedPath(selectId, customId, toggleId) {
  return $(toggleId).checked ? $(customId).value.trim() : $(selectId).value;
}

async function connect() {
  const baudRate = Number($('baud-select').value);
  const options = { baudRate };
  if (state.mode === 'server') {
    options.receiverPath = selectedPath('receiver-select', 'receiver-custom', 'receiver-custom-toggle');
    options.transmitterPath = selectedPath('transmitter-select', 'transmitter-custom', 'transmitter-custom-toggle') || null;
    if (!options.receiverPath) {
      showToast('Lütfen alıcı port seçin veya girin');
      return;
    }
  }
  storage.set('baudRate', baudRate);

  state.connecting = true;
  renderConnection();
  try {
    state.transport = state.transport && state.transport.mode === state.mode ? state.transport : createTransport(state.mode);
    state.transport.mode = state.mode;
    await state.transport.connect(options);
    // Server mode reports the result asynchronously through handleStatus
    if (state.mode === 'server') {
      setTimeout(() => {
        if (state.connecting) handleStatus({ connected: false, error: 'Sunucu yanıt vermedi' });
      }, 10000);
    }
  } catch (err) {
    state.connecting = false;
    renderConnection();
    // The user closing the browser's port picker is not an error worth shouting about
    if (err.name !== 'NotFoundError') showToast(`Bağlanılamadı: ${err.message}`);
  }
}

async function disconnect() {
  stopAutoSend();
  try {
    await state.transport?.disconnect();
  } catch (err) {
    showToast(`Bağlantı kesilemedi: ${err.message}`);
  }
}

function handleStatus({ connected, label, error }) {
  const wasConnected = state.connected;
  state.connected = connected;
  state.connecting = false;
  state.statusLabel = label;
  if (!connected) stopAutoSend();
  renderConnection();
  statusListeners.forEach((fn) => fn({ connected, label, error }));
  if (error) showToast(error);
  else if (connected && !wasConnected) showToast(`Bağlandı: ${label}`, 'success');
}

function renderConnection() {
  const status = $('connection-status');
  status.classList.toggle('connected', state.connected);
  status.classList.toggle('demo', state.connected && state.mode === 'demo');
  status.querySelector('.status-text').textContent = state.connecting
    ? 'Bağlanıyor…'
    : state.connected
      ? state.statusLabel || 'Bağlı'
      : 'Bağlı değil';
  status.title = state.statusLabel || '';

  const button = $('connection-button');
  button.disabled = state.connecting;
  button.classList.toggle('connected', state.connected);
  button.textContent = state.connecting
    ? 'Bağlanıyor…'
    : state.connected
      ? 'Bağlantıyı kes'
      : state.mode === 'demo'
        ? 'Simülatörü bağla'
        : 'Bağlan';
  updateModeAvailability();
}

// ---------- simulator ----------
let simulatorBound = null;

/** The simulated board exists as soon as Simulator mode is chosen, so faults can be set before connecting. */
function ensureSimulator() {
  if (!state.transport || state.transport.mode !== 'demo') {
    state.transport = createTransport('demo');
    state.transport.mode = 'demo';
  }
  const board = state.transport.board;
  if (simulatorBound === board) return;
  simulatorBound = board;
  $('sim-fault').replaceChildren(...Object.entries(FAULTS).map(([value, label]) => new Option(label, value)));
  $('sim-fault').value = board.mode;
  board.onChange(renderSimulator);
  renderSimulator(board.state());
}

function renderSimulator(s) {
  const item = (label, value, cls = '') => [
    Object.assign(document.createElement('dt'), { textContent: label }),
    Object.assign(document.createElement('dd'), { textContent: value, className: cls }),
  ];
  $('sim-state').replaceChildren(
    ...item('Model', s.model),
    ...item('Seri no', s.serial ?? '—'),
    ...item('Firmware', s.firmware),
    ...item('Gerçek arıza', FAULTS[s.fault]),
    ...item('Besleme', s.powered ? 'AÇIK' : 'kapalı', s.powered ? 'sim-on' : ''),
    ...item('Yeşil LED', s.led ? 'YANIYOR' : 'sönük', s.led ? 'sim-led' : '')
  );
}

// ---------- server port list ----------
function fillSelect(select, ports, placeholder) {
  const previous = select.value;
  select.replaceChildren(new Option(placeholder, ''));
  for (const port of ports) {
    select.append(new Option(`${port.path} (${port.manufacturer || 'Bilinmeyen'})`, port.path));
  }
  // Keep the user's choice across refreshes
  if (ports.some((p) => p.path === previous)) select.value = previous;
}

async function loadPorts() {
  if (state.mode !== 'server' || !state.transport?.listPorts) {
    state.transport = createTransport('server');
    state.transport.mode = 'server';
  }
  try {
    await state.transport.init();
    const ports = await state.transport.listPorts();
    fillSelect($('receiver-select'), ports, ports.length ? 'Port seçin...' : 'Port bulunamadı');
    fillSelect($('transmitter-select'), ports, 'Alıcı ile aynı');
  } catch (err) {
    showToast(`Portlar yüklenemedi: ${err.message}`);
  }
}

// ---------- incoming data ----------
function handleLine(line) {
  const row = {
    time: new Date().toISOString(),
    raw: line,
    // Protocol replies ("@...") answer a command; they are not telemetry for readouts and charts
    reply: replyText(line) !== null,
    fields: replyText(line) !== null ? [] : parseLine(line, state.labels),
  };
  state.lineCount += 1;
  state.history.push(row);
  if (state.history.length > MAX_HISTORY_ROWS) state.history.shift();
  lineListeners.forEach((fn) => fn(row));
  pendingRows.push(row);
  if (!frameRequested) {
    frameRequested = true;
    requestAnimationFrame(flushRows);
  }
}

function flushRows() {
  frameRequested = false;
  const rows = pendingRows;
  pendingRows = [];
  if (!rows.length) return;

  document.querySelectorAll('[data-role="raw-log"]').forEach((log) => appendRaw(log, rows));
  const latest = [...rows].reverse().find((r) => !r.reply);
  if (latest) document.querySelectorAll('[data-role="tagged"]').forEach((el) => renderTagged(el, latest));
  rows.forEach(pushToSeries);
  charts.forEach(syncChart);
  document.querySelectorAll('[data-role="line-count"]').forEach((el) => {
    el.textContent = `${state.lineCount} satır`;
  });
}

function appendRaw(log, rows) {
  const stickToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const div = document.createElement('div');
    if (row.reply) div.className = 'log-reply';
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = new Date(row.time).toLocaleTimeString('tr-TR');
    div.append(time, ' ', row.raw);
    fragment.append(div);
  }
  log.append(fragment);
  while (log.childElementCount > MAX_RAW_LINES) log.firstElementChild.remove();
  if (stickToBottom) log.scrollTop = log.scrollHeight;
}

function renderTagged(el, row) {
  if (!row.fields.length) {
    el.replaceChildren(Object.assign(document.createElement('div'), { className: 'readouts-empty', textContent: 'Veri bekleniyor' }));
    return;
  }
  el.replaceChildren(
    ...row.fields.map((f) => {
      const cell = document.createElement('div');
      cell.className = f.raw === '---' ? 'readout missing' : 'readout';
      const name = document.createElement('span');
      name.className = 'readout-label';
      name.textContent = f.label;
      const value = document.createElement('span');
      value.className = 'readout-value';
      value.textContent = f.raw;
      cell.append(name, value);
      return cell;
    })
  );
}

// ---------- charts ----------
function pushToSeries(row) {
  const numeric = row.fields.filter((f) => f.value !== null);
  if (!numeric.length) return;

  series.labels.push(new Date(row.time).toLocaleTimeString('tr-TR'));
  for (const f of numeric) {
    if (!series.datasets.has(f.label)) {
      // New series: pad with gaps so it lines up with the time axis
      series.datasets.set(f.label, new Array(series.labels.length - 1).fill(null));
    }
  }
  const values = new Map(numeric.map((f) => [f.label, f.value]));
  for (const [label, data] of series.datasets) data.push(values.has(label) ? values.get(label) : null);

  if (series.labels.length > MAX_CHART_POINTS) {
    series.labels.shift();
    for (const data of series.datasets.values()) data.shift();
  }
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function applyChartTheme(chart) {
  const text = cssVar('--text-2');
  const grid = cssVar('--border');
  chart.options.plugins.legend.labels.color = text;
  chart.options.scales.x.ticks.color = text;
  chart.options.scales.y.ticks.color = text;
  chart.options.scales.y.grid.color = grid;
  chart.update('none');
}

function createChart(canvas) {
  window.Chart.defaults.font.family = "'IBM Plex Sans', sans-serif";
  window.Chart.defaults.font.size = 12;
  const chart = new window.Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      spanGaps: true,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { position: 'top', align: 'start', labels: { boxWidth: 14, boxHeight: 2, padding: 14 } },
      },
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
  if (type === 'raw') return '<button class="btn btn-sm" data-action="clear-raw">Temizle</button>';
  if (type === 'tagged') return '<button class="btn btn-sm" data-action="export-csv" title="Kaydedilen tüm satırları CSV olarak indir">CSV indir</button>';
  return '<button class="btn btn-sm" data-action="reset-chart">Sıfırla</button>';
}

function panelBody(type) {
  if (type === 'raw') return '<div class="log" data-role="raw-log"></div>';
  if (type === 'tagged') return '<div class="readouts" data-role="tagged"><div class="readouts-empty">Veri bekleniyor</div></div>';
  return '<div class="chart-box"><canvas></canvas></div>';
}

function renderPanel({ id, type }) {
  const meta = PANEL_META[type];
  const el = document.createElement('section');
  el.className = `panel panel-item${type === 'chart' ? ' panel-wide' : ''}`;
  el.dataset.panelId = id;
  el.dataset.panelType = type;
  el.innerHTML = `
    <div class="panel-head">
      <div class="drag-handle" title="Sürükleyerek taşı" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span></div>
      <div class="panel-title">
        <h2>${meta.title}</h2>
        <span class="panel-sub">${meta.subtitle}${type === 'raw' ? ' · <span data-role="line-count">0 satır</span>' : ''}</span>
      </div>
      <div class="panel-actions">
        ${panelActions(type)}
        <button class="icon-btn sm" data-action="delete-panel" title="Paneli kaldır" aria-label="Paneli kaldır">&times;</button>
      </div>
    </div>
    <div class="panel-body">${panelBody(type)}</div>`;
  $('panels-container').append(el);

  if (type === 'chart' && window.Chart) charts.set(id, createChart(el.querySelector('canvas')));
  if (type === 'tagged' && state.history.length) renderTagged(el.querySelector('[data-role="tagged"]'), state.history.at(-1));
  if (type === 'raw') el.querySelector('[data-role="line-count"]').textContent = `${state.lineCount} satır`;
}

function savePanels() {
  storage.set('panels', state.panels);
}

function addPanel(type) {
  const id = `${type}-${Date.now().toString(36)}`;
  const panel = { id, type };
  state.panels.push(panel);
  renderPanel(panel);
  savePanels();
  $('add-panel-modal').classList.remove('show');
}

function deletePanel(panelEl) {
  const id = panelEl.dataset.panelId;
  charts.get(id)?.destroy();
  charts.delete(id);
  state.panels = state.panels.filter((p) => p.id !== id);
  panelEl.remove();
  savePanels();
}

function initSortable() {
  if (typeof window.Sortable === 'undefined') return;
  window.Sortable.create($('panels-container'), {
    handle: '.drag-handle',
    draggable: '.panel-item',
    animation: 200,
    ghostClass: 'sortable-ghost',
    dragClass: 'sortable-drag',
    onEnd: () => {
      const order = [...document.querySelectorAll('#panels-container .panel-item')].map((el) => el.dataset.panelId);
      state.panels.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      savePanels();
    },
  });
}

// ---------- labels ----------
function renderLabels() {
  const container = $('label-configs');
  container.replaceChildren(
    ...state.labels.map(({ prefix, label }) => {
      const row = document.createElement('div');
      row.className = 'label-row';
      row.innerHTML = `
        <input type="text" class="input mono prefix-input" placeholder="A" aria-label="Anahtar">
        <input type="text" class="input label-input" placeholder="Sıcaklık" aria-label="Görünen ad">
        <button type="button" class="icon-btn sm" data-action="remove-label" aria-label="Etiketi sil">&times;</button>`;
      row.querySelector('.prefix-input').value = prefix;
      row.querySelector('.label-input').value = label;
      return row;
    })
  );
}

function readLabels() {
  state.labels = [...document.querySelectorAll('#label-configs .label-row')].map((row) => ({
    prefix: row.querySelector('.prefix-input').value.trim(),
    label: row.querySelector('.label-input').value.trim(),
  }));
  storage.set('labels', state.labels);
}

// ---------- sending ----------
async function sendText(text) {
  if (!state.connected) {
    showToast('Önce bağlantı kurun');
    return false;
  }
  try {
    await state.transport.send(text);
    return true;
  } catch (err) {
    showToast(`Gönderilemedi: ${err.message}`);
    return false;
  }
}

async function onSendSubmit(event) {
  event.preventDefault();
  const text = $('send-input').value.trim();
  if (!text) {
    showToast('Lütfen gönderilecek veriyi girin');
    return;
  }
  if (await sendText(text)) showToast(`Gönderildi: ${text}`, 'success');
}

function startAutoSend() {
  const text = $('send-input').value.trim();
  const interval = Number($('send-interval').value);
  if (!text) {
    showToast('Önce gönderilecek komutu yazın');
    $('auto-send-checkbox').checked = false;
    return;
  }
  if (!Number.isFinite(interval) || interval < 100) {
    showToast('Aralık en az 100 ms olmalıdır');
    $('auto-send-checkbox').checked = false;
    return;
  }
  if (!state.connected) {
    showToast('Önce bağlantı kurun');
    $('auto-send-checkbox').checked = false;
    return;
  }
  stopAutoSend();
  state.autoSendTimer = setInterval(() => sendText(text), interval);
}

function stopAutoSend() {
  clearInterval(state.autoSendTimer);
  state.autoSendTimer = null;
  $('auto-send-checkbox').checked = false;
}

// ---------- export ----------
function exportCsv() {
  if (!state.history.length) {
    showToast('Dışa aktarılacak veri yok');
    return;
  }
  const blob = new Blob(['\uFEFF' + rowsToCsv(state.history)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `serial-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- events ----------
function bindEvents() {
  $('theme-toggle').addEventListener('click', toggleTheme);
  $('connection-button').addEventListener('click', () => (state.connected ? disconnect() : connect()));
  $('refresh-ports').addEventListener('click', loadPorts);
  $('sim-fault').addEventListener('change', (e) => state.transport?.board?.setMode(e.target.value));
  $('send-form').addEventListener('submit', onSendSubmit);
  $('auto-send-checkbox').addEventListener('change', (e) => (e.target.checked ? startAutoSend() : stopAutoSend()));
  $('baud-select').value = String(storage.get('baudRate', 9600));

  $('mode-selector').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-item');
    if (btn) setMode(btn.dataset.mode);
  });

  for (const side of ['receiver', 'transmitter']) {
    $(`${side}-custom-toggle`).addEventListener('change', (e) => {
      $(`${side}-select`).classList.toggle('hidden', e.target.checked);
      $(`${side}-custom`).classList.toggle('hidden', !e.target.checked);
    });
    $(`${side}-custom`).addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !state.connected) connect();
    });
  }

  $('label-configs').addEventListener('input', readLabels);

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) {
      if (e.target === $('add-panel-modal')) $('add-panel-modal').classList.remove('show');
      return;
    }
    const panel = target.closest('.panel-item');
    switch (target.dataset.action) {
      case 'add-label':
        state.labels.push({ prefix: '', label: '' });
        renderLabels();
        $('label-configs').lastElementChild.querySelector('input').focus();
        break;
      case 'remove-label':
        target.closest('.label-row').remove();
        readLabels();
        break;
      case 'show-add-panel':
        $('add-panel-modal').classList.add('show');
        break;
      case 'close-add-panel':
        $('add-panel-modal').classList.remove('show');
        break;
      case 'add-panel':
        addPanel(target.dataset.type);
        break;
      case 'delete-panel':
        deletePanel(panel);
        break;
      case 'clear-raw':
        panel.querySelector('[data-role="raw-log"]').replaceChildren();
        break;
      case 'reset-chart':
        resetChart();
        break;
      case 'export-csv':
        exportCsv();
        break;
      case 'close-toast':
        closeToast();
        break;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('add-panel-modal').classList.remove('show');
  });

  // Refresh the server port list while disconnected (keeps the current selection)
  setInterval(() => {
    if (state.mode === 'server' && !state.connected && !state.connecting && !document.hidden) loadPorts();
  }, 10000);
}

function showSupportBanner() {
  if (state.available.webserial || state.available.server) return;
  const banner = $('support-banner');
  banner.textContent =
    'Bu tarayıcı Web Serial API desteklemiyor. Gerçek cihaza bağlanmak için Chrome veya Edge kullanın — ya da Demo modunu deneyin.';
  banner.classList.remove('hidden');
}

// ---------- views (Monitor / Production test) ----------
function setView(view) {
  const production = view === 'production';
  $('panels-container').classList.toggle('hidden', production);
  $('production-view').classList.toggle('hidden', !production);
  document.querySelectorAll('.monitor-only').forEach((el) => el.classList.toggle('hidden', production));
  document.querySelectorAll('#view-tabs .tab').forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  if (production) $('pt-serial').focus();
  else charts.forEach((chart) => chart.resize());
}

function initViews() {
  $('view-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    history.replaceState(null, '', tab.dataset.view === 'production' ? '#production' : location.pathname + location.search);
    setView(tab.dataset.view);
  });
  // Links like ".../#production" also work when only the hash changes
  window.addEventListener('hashchange', () => setView(location.hash === '#production' ? 'production' : 'monitor'));
  setView(location.hash === '#production' ? 'production' : 'monitor');
}

async function init() {
  renderLabels();
  state.panels.forEach(renderPanel);
  initSortable();
  bindEvents();

  state.available.server = await ServerTransport.isAvailable();
  const params = new URLSearchParams(location.search);
  const saved = storage.get('mode', null);
  const preferred = params.has('demo')
    ? 'demo'
    : state.available[saved]
      ? saved
      : state.available.server ? 'server' : state.available.webserial ? 'webserial' : 'demo';

  setMode(preferred);
  renderConnection();
  showSupportBanner();

  initProduction({
    onLine: (fn) => {
      lineListeners.add(fn);
      return () => lineListeners.delete(fn);
    },
    send: (text) => (state.connected ? state.transport.send(text) : Promise.reject(new Error('Bağlantı yok'))),
    onStatus: (fn) => statusListeners.add(fn),
    getConnection: () => ({ connected: state.connected, label: state.statusLabel }),
    showToast,
    storage,
    serverAvailable: state.available.server,
  });
  initViews();

  if (params.has('demo')) connect();
}

init();
