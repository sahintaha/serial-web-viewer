// ============================================
// TRANSPORTS — where serial lines come from
//
// Every transport takes { onLine(line), onStatus(status) } handlers and
// exposes connect(options), disconnect() and send(text).
//   status: { connected: boolean, label?: string, error?: string }
// ============================================

import { createLineSplitter } from './parser.js';

const hex = (n) => n.toString(16).padStart(4, '0');

/** Talks to the serial port directly from the browser (Chrome / Edge, HTTPS or localhost). */
export class WebSerialTransport {
  static isSupported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  constructor(handlers) {
    this.handlers = handlers;
    this.port = null;
    this.reader = null;
    this.readableClosed = null;
    this.onPortDisconnect = () => this.lost('Cihaz bağlantısı koptu');
  }

  async connect({ baudRate }) {
    // Must be called from a user gesture (click) — opens the browser's port picker
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate });
    this.port = port;
    port.addEventListener('disconnect', this.onPortDisconnect);

    const { usbVendorId, usbProductId } = port.getInfo();
    const label = usbVendorId ? `USB ${hex(usbVendorId)}:${hex(usbProductId)}` : 'Seri port';
    this.handlers.onStatus({ connected: true, label: `${label} @ ${baudRate}` });
    this.readLoop();
  }

  async readLoop() {
    const decoder = new TextDecoderStream();
    this.readableClosed = this.port.readable.pipeTo(decoder.writable).catch(() => {});
    this.reader = decoder.readable.getReader();
    const splitter = createLineSplitter();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        for (const line of splitter.push(value)) this.handlers.onLine(line);
      }
    } catch (err) {
      if (this.port) this.lost(`Okuma hatası: ${err.message}`);
    } finally {
      this.reader?.releaseLock();
    }
  }

  async send(text) {
    if (!this.port?.writable) throw new Error('Port açık değil');
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(text + '\n'));
    } finally {
      writer.releaseLock();
    }
  }

  async close() {
    const port = this.port;
    if (!port) return;
    this.port = null;
    port.removeEventListener('disconnect', this.onPortDisconnect);
    await this.reader?.cancel().catch(() => {});
    await this.readableClosed;
    await port.close().catch(() => {});
    this.reader = null;
  }

  async disconnect() {
    await this.close();
    this.handlers.onStatus({ connected: false });
  }

  async lost(error) {
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
  }

  async init() {
    if (this.socket) return;
    if (typeof window.io !== 'function') await loadScript('socket.io/socket.io.js');
    this.socket = window.io();
    this.socket.on('serial-data', (line) => this.handlers.onLine(line));
    this.socket.on('send-error', (error) => this.handlers.onError?.(error));
    this.socket.on('connection-status', (s) => {
      this.connected = s.connected;
      const label = s.connected
        ? `${s.receiverPath}${s.transmitterPath ? ' → ' + s.transmitterPath : ''} @ ${s.baudRate}`
        : undefined;
      this.handlers.onStatus({ connected: s.connected, label, error: s.error });
    });
    this.socket.on('disconnect', () => {
      if (this.connected) this.handlers.onStatus({ connected: false, error: 'Sunucu bağlantısı koptu' });
      this.connected = false;
    });
  }

  async listPorts() {
    const res = await fetch('ports', { cache: 'no-store' });
    if (!res.ok) throw new Error('Port listesi alınamadı');
    return res.json();
  }

  async connect({ receiverPath, transmitterPath, baudRate }) {
    await this.init();
    this.socket.emit('select-ports', { receiverPath, transmitterPath, baudRate });
  }

  async send(text) {
    this.socket.emit('send-manual', text);
  }

  async disconnect() {
    this.socket?.emit('disconnect-ports');
  }
}

/** Generates realistic-looking sensor data so the UI can be tried without hardware. */
export class DemoTransport {
  constructor(handlers) {
    this.handlers = handlers;
    this.timer = null;
    this.t = 0;
  }

  async connect({ intervalMs = 500 } = {}) {
    this.t = 0;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.handlers.onStatus({ connected: true, label: 'Demo verisi' });
    this.tick();
  }

  tick() {
    this.t += 1;
    const t = this.t;
    const noise = (scale) => (Math.random() - 0.5) * scale;
    // Units chosen so every series shares one sensible y-axis
    const temperature = 24 + 4 * Math.sin(t / 20) + noise(0.6); // °C
    const humidity = 55 + 12 * Math.sin(t / 35 + 1) + noise(2); // %
    const pressure = 101.3 + 0.4 * Math.sin(t / 50) + noise(0.05); // kPa
    const light = Math.min(100, Math.max(0, 50 + 35 * Math.sin(t / 15) + noise(6))); // %
    // Supply rail of the board under test — drifts so some boards fail the production limits
    const voltage = 5.0 + 0.07 * Math.sin(t / 23) + noise(0.03); // V
    const current = 118 + 32 * Math.sin(t / 17 + 2) + noise(6); // mA
    // Same format an Arduino sketch would print: "A25.5,B60,C101.3,D50,V5.02,I120"
    this.handlers.onLine(
      `A${temperature.toFixed(1)},B${humidity.toFixed(0)},C${pressure.toFixed(2)},D${light.toFixed(0)},` +
        `V${voltage.toFixed(3)},I${current.toFixed(1)}`
    );
    // Simulate an occasional corrupted line (noise on the wire)
    if (Math.random() < 0.03) this.handlers.onLine('A2#.?,B,V5..0');
  }

  async send(text) {
    // Pretend the device acknowledges every command
    setTimeout(() => this.handlers.onLine(`ACK:${text}`), 50);
  }

  async disconnect() {
    clearInterval(this.timer);
    this.timer = null;
    this.handlers.onStatus({ connected: false });
  }
}
