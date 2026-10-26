// ============================================
// SERIAL WEB VIEWER — application shell: session, connection (modes, serial
// settings, one command channel per port), simulator panel, views and routing.
// The monitor and the production test views live in their own modules.
// ============================================

import { WebSerialTransport, ServerTransport, DemoTransport } from './transports.js';
import { CommandChannel } from './channel.js';
import { FAULTS } from './simulator.js';
import { ServerStore, LocalStore } from './results-store.js';
import { initMonitor } from './monitor.js';
import { initProduction } from './production-ui.js';
import { ensureSession, initUserMenu, applyRoleVisibility } from './auth-ui.js';
import { $, el, openModal } from './dom.js';

const MODE_HINTS = {
  webserial: "Bağlan'a basınca tarayıcı port seçim penceresi açılır. Kurulum gerekmez (Chrome / Edge).",
  server: 'Node.js sunucusu üzerinden bağlanır. Port sunucuda açılır; bütün sekmeler aynı bağlantıyı paylaşır.',
  demo: "Donanım gerekmez. Sanal kart, fikstür firmware'iyle aynı protokolle cevap verir. Bu testler üretim raporlarına girmez.",
};
const SETTINGS = { 'baud-select': ['baudRate', '9600'], 'databits-select': ['dataBits', '8'], 'parity-select': ['parity', 'none'], 'stopbits-select': ['stopBits', '1'], 'ending-select': ['lineEnding', 'lf'] };
const VERSION = (() => {
  const v = new URL(import.meta.url).searchParams.get('v');
  return v && v !== '__BUILD__' ? v : 'dev';
})();

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

const state = {
  mode: null,
  available: { webserial: WebSerialTransport.isSupported(), server: false, demo: true },
  transport: null,
  connected: false,
  connecting: false,
  statusLabel: null,
  remoteLock: null, // server mode: lock held by another client
  channel: null, // CommandChannel of the open connection (ids, queue, test lock)
  testActive: false,
  connectionOp: Promise.resolve(), // connect / disconnect run one after another
};
const statusListeners = new Set();
let monitor = null;
let production = null;

// ---------- toast & banner ----------
let toastTimer = null;
function showToast(message, type = 'error') {
  $('toast').className = `toast show toast-${type}`;
  $('toast-message').textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), type === 'error' ? 6000 : 4000);
}

function showBanner(message) {
  const banner = $('support-banner');
  if ([...banner.children].some((p) => p.textContent === message)) return;
  banner.append(el('p', { textContent: message }));
  banner.classList.remove('hidden');
}

// ---------- theme ----------
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('theme', next); // read raw (not JSON) by the inline script in index.html
  } catch {
    // ignore
  }
  monitor?.onTheme();
  production?.onTheme();
}

// ---------- modes & connection ----------
function setMode(mode) {
  if (state.connected || state.connecting || state.testActive || !state.available[mode]) return;
  state.mode = mode;
  storage.set('mode', mode);
  document.documentElement.classList.toggle('demo-mode', mode === 'demo');
  document.querySelectorAll('#mode-selector .seg-item').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  });
  $('mode-hint').textContent = MODE_HINTS[mode];
  $('server-ports').classList.toggle('hidden', mode !== 'server');
  $('baud-group').classList.toggle('hidden', mode === 'demo');
  $('serial-advanced').classList.toggle('hidden', mode === 'demo');
  $('sim-panel').classList.toggle('hidden', mode !== 'demo');
  if (mode === 'demo') ensureSimulator();
  if (mode === 'server') loadPorts();
  renderConnection();
}

function createTransport(mode) {
  const handlers = {
    onLine: (line) => {
      state.channel?.handleLine(line);
      monitor.handleLine(line);
    },
    onRaw: (bytes) => monitor.handleRaw(bytes),
    onOverflow: (count) => monitor.handleOverflow(count),
    onStatus: handleStatus,
    onError: (message) => showToast(message),
  };
  const transport = mode === 'webserial' ? new WebSerialTransport(handlers) : mode === 'server' ? new ServerTransport(handlers) : new DemoTransport(handlers);
  transport.mode = mode;
  return transport;
}

const transportFor = (mode) => (state.transport?.mode === mode ? state.transport : (state.transport = createTransport(mode)));
const selectedPath = (side) => ($(`${side}-custom-toggle`).checked ? $(`${side}-custom`).value.trim() : $(`${side}-select`).value);

function serialSettings() {
  return { baudRate: Number($('baud-select').value), dataBits: Number($('databits-select').value), parity: $('parity-select').value, stopBits: Number($('stopbits-select').value) };
}

/** Connect and disconnect are queued: a port is never reopened before the previous close finished. */
function queueConnection(task) {
  const run = state.connectionOp.then(task, task);
  state.connectionOp = run.catch(() => {});
  return run;
}

function connect() {
  if (state.connecting || state.connected || state.testActive) return;
  const options = serialSettings();
  if (state.mode === 'server') {
    options.receiverPath = selectedPath('receiver');
    options.transmitterPath = selectedPath('transmitter') || null;
    if (!options.receiverPath) return showToast('Lütfen alıcı port seçin veya girin');
  }
  state.connecting = true;
  renderConnection();
  return queueConnection(async () => {
    try {
      await transportFor(state.mode).connect(options);
    } catch (err) {
      state.connecting = false;
      renderConnection();
      // The user closing the browser's port picker is not an error worth shouting about
      if (err.name !== 'NotFoundError' && err.name !== 'AbortError') showToast(`Bağlanılamadı: ${err.message}`);
    }
  });
}

function disconnect() {
  if (state.testActive) return showToast('Test çalışırken bağlantı kesilemez; önce testi durdurun');
  monitor.stopAutoSend();
  return queueConnection(async () => {
    try {
      await state.transport?.disconnect();
    } catch (err) {
      showToast(`Bağlantı kesilemedi: ${err.message}`);
    }
  });
}

function handleStatus({ connected, label, error, locked, lockOwner }) {
  const wasConnected = state.connected;
  state.connected = connected;
  state.connecting = false;
  state.statusLabel = label ?? null;
  state.remoteLock = locked && !state.testActive ? lockOwner : null;
  if (connected && !state.channel) {
    // Every write (monitor, auto-send, test station) goes through one queue per port
    state.channel = new CommandChannel({ write: (line, options) => state.transport.send(line, options), isConnected: () => state.connected });
  } else if (!connected && state.channel) {
    state.channel.close();
    state.channel = null;
  }
  if (!connected) monitor.stopAutoSend();
  renderConnection();
  statusListeners.forEach((fn) => fn({ connected, label, error }));
  if (error) showToast(error);
  else if (connected && !wasConnected) showToast(`Bağlandı: ${label}`, 'success');
}

function renderConnection() {
  const status = $('connection-status');
  status.classList.toggle('connected', state.connected);
  status.classList.toggle('demo', state.connected && state.mode === 'demo');
  const lockText = state.remoteLock ? ` · testte (${state.remoteLock.user ?? 'başka istemci'})` : '';
  status.querySelector('.status-text').textContent = state.connecting ? 'Bağlanıyor…' : state.connected ? `${state.statusLabel || 'Bağlı'}${lockText}` : 'Bağlı değil';
  status.title = state.statusLabel || '';

  // A running test owns the port: no disconnect, mode or setting change meanwhile
  const button = $('connection-button');
  button.disabled = state.connecting || state.testActive;
  button.title = state.testActive ? 'Test çalışırken bağlantı değiştirilemez' : '';
  button.classList.toggle('connected', state.connected);
  button.textContent = state.connecting ? 'Bağlanıyor…' : state.connected ? 'Bağlantıyı kes' : state.mode === 'demo' ? 'Simülatörü bağla' : 'Bağlan';
  for (const id of ['baud-select', 'databits-select', 'parity-select', 'stopbits-select']) $(id).disabled = state.connected || state.connecting;
  $('sim-fault').disabled = false; // faults may change mid-test: that is what the simulator is for
  document.querySelectorAll('#mode-selector .seg-item').forEach((btn) => {
    btn.disabled = !state.available[btn.dataset.mode] || state.connected || state.connecting || state.testActive;
  });
}

// ---------- simulator ----------
let simulatorBound = null;

/** The simulated board exists as soon as Simulator mode is chosen, so faults can be set before connecting. */
function ensureSimulator() {
  const board = transportFor('demo').board;
  if (simulatorBound === board) return;
  simulatorBound = board;
  $('sim-fault').replaceChildren(...Object.entries(FAULTS).map(([value, label]) => new Option(label, value)));
  $('sim-fault').value = board.mode;
  board.onChange(renderSimulator);
  renderSimulator(board.state());
}

function renderSimulator(s) {
  const item = (label, value, cls = '') => [el('dt', { textContent: label }), el('dd', { textContent: value, className: cls })];
  $('sim-state').replaceChildren(
    ...item('Model', s.model),
    ...item('Seri no', s.serial ?? '—'),
    ...item('Firmware', s.firmware),
    ...item('Gerçek arıza', FAULTS[s.fault]),
    ...item('Besleme', s.powered ? 'AÇIK' : 'kapalı', s.powered ? 'sim-on' : ''),
    ...item('Yeşil LED', s.led ? 'YANIYOR' : 'sönük', s.led ? 'sim-led' : ''),
    ...item('Watchdog', s.watchdogTripped ? 'TETİKLENDİ' : s.watchdogMs ? `${s.watchdogMs} ms` : 'kapalı', s.watchdogTripped ? 'sim-on' : '')
  );
}

// ---------- server port list ----------
function fillSelect(select, ports, placeholder) {
  const previous = select.value;
  select.replaceChildren(new Option(placeholder, ''), ...ports.map((p) => new Option(`${p.path} (${p.manufacturer || 'Bilinmeyen'})`, p.path)));
  if (ports.some((p) => p.path === previous)) select.value = previous; // keep the choice across refreshes
}

async function loadPorts() {
  try {
    const transport = transportFor('server');
    await transport.init();
    const ports = await transport.listPorts();
    fillSelect($('receiver-select'), ports, ports.length ? 'Port seçin…' : 'Port bulunamadı');
    fillSelect($('transmitter-select'), ports, 'Alıcı ile aynı');
  } catch (err) {
    showToast(`Portlar yüklenemedi: ${err.message}`);
  }
}

// ---------- views (Monitor / Production test) ----------
function parseHash() {
  const [view, page] = location.hash.replace(/^#/, '').split('/');
  return view === 'production' ? { view, page } : { view: 'monitor' };
}

function setView(view, page) {
  const isProduction = view === 'production';
  $('panels-container').classList.toggle('hidden', isProduction);
  $('production-view').classList.toggle('hidden', !isProduction);
  document.querySelectorAll('.monitor-only').forEach((n) => n.classList.toggle('hidden', isProduction));
  document.querySelectorAll('#view-tabs .tab').forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  if (isProduction) {
    if (page) production?.showPage(page);
  } else monitor.resize();
}

// ---------- events ----------
function bindEvents() {
  $('theme-toggle').addEventListener('click', toggleTheme);
  $('connection-button').addEventListener('click', () => (state.connected ? disconnect() : connect()));
  $('refresh-ports').addEventListener('click', loadPorts);
  $('sim-fault').addEventListener('change', (e) => state.transport?.board?.setMode(e.target.value));
  $('mode-selector').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-item');
    if (btn) setMode(btn.dataset.mode);
  });
  for (const [id, [key, fallback]] of Object.entries(SETTINGS)) {
    $(id).value = String(storage.get(key, fallback));
    $(id).addEventListener('change', () => storage.set(key, $(id).value));
  }
  for (const side of ['receiver', 'transmitter']) {
    $(`${side}-custom-toggle`).addEventListener('change', (e) => {
      $(`${side}-select`).classList.toggle('hidden', e.target.checked);
      $(`${side}-custom`).classList.toggle('hidden', !e.target.checked);
    });
    $(`${side}-custom`).addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !state.connected) connect();
    });
  }

  let closeAddPanel = null;
  document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'show-add-panel') closeAddPanel = openModal($('add-panel-modal'));
    else if (action === 'close-add-panel') closeAddPanel?.();
    else if (action === 'close-toast') $('toast').classList.remove('show');
  });
  monitorHooks.closeAddPanel = () => closeAddPanel?.();

  $('view-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    history.replaceState(null, '', tab.dataset.view === 'production' ? '#production' : location.pathname + location.search);
    setView(tab.dataset.view);
  });
  window.addEventListener('hashchange', () => {
    const { view, page } = parseHash();
    setView(view, page);
  });

  // Refresh the server port list while disconnected (keeps the current selection)
  setInterval(() => {
    if (state.mode === 'server' && !state.connected && !state.connecting && !document.hidden) loadPorts();
  }, 10000);
}

const monitorHooks = {
  storage,
  showToast,
  getChannel: () => state.channel,
  getTransport: () => state.transport,
  closeAddPanel: null,
};

// ---------- start ----------
async function openStore() {
  if (state.available.server) {
    let reauth = null;
    const store = new ServerStore({
      // Session expired: show the login screen over the page; a running test keeps running
      onUnauthenticated: () => {
        reauth ??= ensureSession(store).finally(() => {
          reauth = null;
        });
      },
    });
    return store;
  }
  try {
    return await new LocalStore().init();
  } catch (err) {
    showBanner(`Tarayıcı deposu açılamadı (${err.message}). Üretim testi kullanılamıyor; monitör çalışır.`);
    return null;
  }
}

async function init() {
  monitor = initMonitor(monitorHooks);
  bindEvents();

  state.available.server = await ServerTransport.isAvailable();
  const store = await openStore();
  const user = store ? await ensureSession(store) : null;
  initUserMenu({ store, user, showToast });
  applyRoleVisibility(user, { requiresAuth: Boolean(store?.requiresAuth) });

  const params = new URLSearchParams(location.search);
  const saved = storage.get('mode', null);
  // A first visit to the browser-only site (no server, nothing chosen yet) starts on the
  // simulator, so there is something to see without hardware; a saved choice is kept
  const firstVisit = saved === null && !state.available.server;
  const preferred = params.has('demo') || firstVisit ? 'demo' : state.available[saved] ? saved : state.available.server ? 'server' : state.available.webserial ? 'webserial' : 'demo';
  setMode(preferred);
  if (!state.available.webserial && !state.available.server) {
    showBanner('Bu tarayıcı Web Serial API desteklemiyor. Gerçek cihaza bağlanmak için Chrome veya Edge kullanın; donanımsız denemek için Simülatör modu.');
  }

  if (store) {
    production = await initProduction({
      store,
      user,
      app: {
        version: VERSION,
        storage,
        showToast,
        showBanner,
        getChannel: () => state.channel,
        getConnection: () => ({ connected: state.connected, label: state.statusLabel }),
        getTransportKind: () => (state.connected ? state.mode : null),
        onStatus: (fn) => statusListeners.add(fn),
        // Locks the port for a test: locally (command channel) and, with the Node bridge, on the server
        lockPort: async (owner) => {
          if (!state.channel) throw new Error('Bağlantı yok');
          state.channel.lock(owner);
          try {
            await state.transport.lock?.(owner);
          } catch (err) {
            state.channel.unlock(owner);
            throw err;
          }
        },
        unlockPort: async (owner) => {
          state.channel?.unlock(owner);
          await state.transport?.unlock?.(owner);
        },
        setTestActive: (active) => {
          state.testActive = active;
          monitor.setLocked(active);
          renderConnection();
        },
        showPage: () => {},
        /** Simulator only: makes the board's defect follow the serial number again. */
        setSimulatorFault: (fault) => {
          const board = state.mode === 'demo' ? state.transport?.board : null;
          if (!board) return;
          board.setMode(fault);
          $('sim-fault').value = fault;
        },
      },
    });
  } else {
    $('view-tabs').querySelector('[data-view="production"]').disabled = true;
  }

  const { view, page } = parseHash();
  setView(store ? view : 'monitor', page);
  renderConnection();
  // On the browser-only site the simulator reconnects by itself; a station server never auto-connects
  if (params.has('demo') || (!state.available.server && preferred === 'demo')) connect();
}

init().catch((err) => {
  console.error(err);
  showBanner(`Uygulama başlatılamadı: ${err.message}`);
});
