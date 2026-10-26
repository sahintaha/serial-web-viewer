// ============================================
// TRANSPORTS — where serial lines come from and where commands go
//
// Every transport takes handlers and exposes connect(options), disconnect() and
// send(text, {ending}):
//   onLine(line)          one received text line (without line ending)
//   onRaw?(bytes)         received bytes, untouched (HEX view)
//   onOverflow?(count)    a line exceeded the length limit and was dropped
//   onStatus(status)      { connected, label?, error?, locked?, lockOwner? }
//
// send() resolves only when the bytes were actually written (and, for the
// Node bridge, acknowledged by the server) and rejects otherwise.
// ============================================

import { createLineSplitter } from './parser.js';
import { SimulatedBoard } from './simulator.js';

export const LINE_ENDINGS = { lf: '\n', crlf: '\r\n', cr: '\r', none: '' };
export const MAX_LINE_LENGTH = 4096;
const hex = (n) => n.toString(16).padStart(4, '0');
const abortError = (message) => Object.assign(new Error(message), { name: 'AbortError' });

function describeSettings({ baudRate, dataBits = 8, parity = 'none', stopBits = 1 }) {
  return `${baudRate} ${dataBits}${parity[0].toUpperCase()}${stopBits}`;
}

/** Talks to the serial port directly from the browser (Chrome / Edge, HTTPS or localhost). */
export class WebSerialTransport {
  static isSupported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  constructor(handlers) {
    this.handlers = handlers;
    this.port = null;
    this.reader = null;
    this.readDone = null;
    this.generation = 0; // bumps on every disconnect so a late-finishing open can be detected
    this.closing = Promise.resolve();
    this.onPortDisconnect = () => this.lost('Cihaz bağlantısı koptu (kablo çıkarıldı)');
  }

  async connect({ baudRate, dataBits = 8, stopBits = 1, parity = 'none' }) {
    await this.closing; // never reopen a port that is still closing
    const generation = ++this.generation;
    // Must be called from a user gesture (click) — opens the browser's port picker
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate, dataBits, stopBits, parity, bufferSize: 8192 });
    if (generation !== this.generation) {
      // Disconnect was pressed while the port was opening: close the late port object
      await port.close().catch(() => {});
      throw abortError('Bağlantı iptal edildi');
    }
    this.port = port;
    port.addEventListener('disconnect', this.onPortDisconnect);
    const { usbVendorId, usbProductId } = port.getInfo();
    const label = usbVendorId ? `USB ${hex(usbVendorId)}:${hex(usbProductId)}` : 'Seri port';
    this.handlers.onStatus({ connected: true, label: `${label} · ${describeSettings({ baudRate, dataBits, parity, stopBits })}` });
    this.readDone = this.readLoop(port);
  }

  async readLoop(port) {
    // Bytes are read as bytes: the HEX view gets them untouched, text is decoded separately
    const reader = port.readable.getReader();
    this.reader = reader;
    const decoder = new TextDecoder('utf-8');
    const splitter = createLineSplitter(MAX_LINE_LENGTH);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.handlers.onRaw?.(value);
        const before = splitter.overflows;
        for (const line of splitter.push(decoder.decode(value, { stream: true }))) this.handlers.onLine(line);
        if (splitter.overflows !== before) this.handlers.onOverflow?.(splitter.overflows);
      }
    } catch (err) {
      if (this.port === port) this.lost(`Okuma hatası: ${err.message}`);
    } finally {
      reader.releaseLock();
    }
  }

  async send(text, { ending = 'lf' } = {}) {
    const port = this.port;
    if (!port?.writable) throw new Error('Port açık değil');
    const writer = port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(text + (LINE_ENDINGS[ending] ?? '\n')));
    } finally {
      writer.releaseLock();
    }
  }

  close() {
    const port = this.port;
    this.port = null;
    if (!port) return Promise.resolve();
    port.removeEventListener('disconnect', this.onPortDisconnect);
    this.closing = (async () => {
      await this.reader?.cancel().catch(() => {});
      await this.readDone;
      await port.close().catch(() => {});
      this.reader = null;
    })();
    return this.closing;
  }

  async disconnect() {
    this.generation += 1;
    await this.close();
    this.handlers.onStatus({ connected: false });
  }

  async lost(error) {
    this.generation += 1;
    await this.close();
    this.handlers.onStatus({ connected: false, error });
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`${src} yüklenemedi`));
    document.head.appendChild(script);
  });
}

/** Uses the Node.js bridge (server.js) over Socket.io — needed for separate RX/TX ports or non-Chromium browsers. */
export class ServerTransport {
  /** True when this page is served by server.js (not e.g. GitHub Pages). */
  static async isAvailable() {
    // Static hosting never has the Node bridge — skip the probe (and its 404 in the console)
    if (location.hostname.endsWith('github.io')) return false;
    try {
      const res = await fetch('health', { cache: 'no-store' });
      if (!res.ok) return false;
      const body = await res.json();
      return body.status === 'ok';
    } catch {
      return false;
    }
  }

  constructor(handlers) {
    this.handlers = handlers;
    this.socket = null;
    this.connected = false;
    this.ackTimeoutMs = 3000;
  }

  async init() {
    if (this.socket) return;
    if (typeof window.io !== 'function') await loadScript('socket.io/socket.io.js');
    this.socket = window.io({ withCredentials: true });
    // A reconnected client gets a new server-side socket without its rooms: re-join raw bytes
    this.socket.on('connect', () => {
      if (this.rawWanted) this.socket.emit('raw-subscribe', true);
    });
    this.socket.on('serial-data', (line) => this.handlers.onLine(line));
    this.socket.on('serial-raw', (bytes) => this.handlers.onRaw?.(new Uint8Array(bytes)));
    this.socket.on('serial-overflow', ({ count }) => this.handlers.onOverflow?.(count));
    this.socket.on('connection-status', (s) => {
      this.connected = s.connected;
      const label = s.connected
        ? `${s.receiverPath}${s.transmitterPath ? ' → ' + s.transmitterPath : ''} · ${describeSettings(s.settings ?? s)}`
        : undefined;
      this.handlers.onStatus({ connected: s.connected, label, error: s.error, locked: s.locked, lockOwner: s.lockOwner });
    });
    this.socket.on('connect_error', (err) => this.handlers.onError?.(`Sunucuya bağlanılamadı: ${err.message}`));
    this.socket.on('disconnect', () => {
      if (this.connected) this.handlers.onStatus({ connected: false, error: 'Sunucu bağlantısı koptu' });
      this.connected = false;
    });
  }

  /** Emits an event and waits for the server's acknowledgement; rejects on {ok:false} or timeout. */
  async call(event, ...args) {
    await this.init();
    let res;
    try {
      res = await this.socket.timeout(this.ackTimeoutMs).emitWithAck(event, ...args);
    } catch {
      throw new Error('Sunucu yanıt vermedi');
    }
    if (!res?.ok) throw new Error(res?.error ?? 'Sunucu isteği reddetti');
    return res;
  }

  async listPorts() {
    const res = await fetch('ports', { cache: 'no-store' });
    if (!res.ok) throw new Error('Port listesi alınamadı');
    return res.json();
  }

  async connect(options) {
    await this.call('select-ports', options);
  }

  async send(text, { ending = 'lf' } = {}) {
    await this.call('send-manual', { text, ending });
  }

  /** Server-side test lock: other tabs / clients cannot write or reconnect meanwhile. */
  async lock(owner) {
    await this.call('lock', owner);
  }

  async unlock(owner) {
    await this.call('unlock', owner).catch(() => {});
  }

  subscribeRaw(on) {
    this.rawWanted = on;
    this.socket?.emit('raw-subscribe', on);
  }

  async disconnect() {
    await this.call('disconnect-ports');
  }
}

/**
 * Connects to a simulated board (js/simulator.js) instead of hardware. It streams
 * environment readings like the Arduino fixture and answers protocol commands
 * after a realistic delay, so the production test runs exactly as with a device.
 */
export class DemoTransport {
  constructor(handlers) {
    this.handlers = handlers;
    this.board = new SimulatedBoard();
    this.timer = null;
    this.watchdogTimer = null;
    this.t = 0;
    this.connected = false;
    this.partial = '';
    this.encoder = new TextEncoder();
  }

  emit(line) {
    if (!this.connected) return;
    this.handlers.onRaw?.(this.encoder.encode(line + '\n'));
    this.handlers.onLine(line);
  }

  async connect({ intervalMs = 1000 } = {}) {
    this.t = 0;
    this.connected = true;
    this.timer = setInterval(() => this.tick(), intervalMs);
    // The board's supply watchdog runs on its own clock, like the firmware's millis() check
    this.watchdogTimer ??= setInterval(() => this.board.tick(), 100);
    this.handlers.onStatus({ connected: true, label: 'Simülatör' });
    this.tick();
  }

  tick() {
    this.t += 1;
    if (!this.board.stream) return;
    this.emit(this.board.streamLine(this.t));
    // An occasional corrupted line, as on a noisy cable
    if (Math.random() < 0.02) this.emit('A2#.?,B,C1..0');
  }

  async send(text, { ending = 'lf' } = {}) {
    if (!this.connected) throw new Error('Simülatör bağlı değil');
    // Like a real device, a command is only processed once its line ending arrives
    this.partial += text;
    if (ending === 'none') return;
    const line = this.partial;
    this.partial = '';
    const reply = this.board.handle(line);
    if (reply === null) return;
    // UART + firmware latency
    setTimeout(() => this.emit(reply), 15 + Math.random() * 45);
  }

  async disconnect() {
    this.connected = false;
    clearInterval(this.timer);
    this.timer = null;
    // The board keeps running (and its watchdog keeps counting) after the "cable" is pulled
    this.handlers.onStatus({ connected: false });
  }
}
