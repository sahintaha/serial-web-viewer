// ============================================
// DEVICE SIMULATOR — a virtual board that speaks the line protocol in
// docs/protocol.md exactly like examples/arduino/svb_fixture does:
// request ids with a reply cache (idempotent retries), a supply watchdog,
// STATUS? / PING / WDT, and the legacy unnumbered form.
//
// Faults are deterministic: in "auto" mode a board's defect is derived from its
// serial number, so retesting the same bad board fails again (as in real life),
// while an "intermittent" board loses replies only on its first attempt.
// ============================================

export const FAULTS = {
  auto: 'Seri numarasına göre',
  none: 'Sağlam kart',
  overcurrent: 'Aşırı akım',
  undervoltage: 'Düşük voltaj',
  firmware: 'Eski firmware',
  selftest: 'Sensör arızası',
  led: 'LED arızası',
  intermittent: 'Aralıklı iletişim',
  silent: 'Cevap vermiyor',
  stuckpower: 'Besleme kapanmıyor (yapışmış röle)',
};

export const DEFAULT_WATCHDOG_MS = 3000;
const REPLY_CACHE_SIZE = 8;
const NUMBERED_RE = /^#([0-9A-Za-z]{1,8}) (.+)$/;

/** FNV-1a: small, stable string hash. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Roughly 80 % good boards; the rest get one realistic defect. */
export function faultForSerial(serial) {
  const n = hash(serial) % 100;
  if (n < 80) return 'none';
  if (n < 85) return 'overcurrent';
  if (n < 88) return 'undervoltage';
  if (n < 91) return 'firmware';
  if (n < 94) return 'selftest';
  if (n < 97) return 'led';
  return 'intermittent';
}

const MODELS = {
  'SVB-100': { fw: '1.4.2', oldFw: '1.3.9', v: 5.0, vNoise: 0.015, vLow: 4.82, i: 115, iNoise: 6, iHigh: 168 },
  'SVB-200': { fw: '2.1.0', oldFw: '1.9.0', v: 12.02, vNoise: 0.04, vLow: 11.48, i: 38, iNoise: 3, iHigh: 79, t: 34, tNoise: 1.5 },
};

export class SimulatedBoard {
  /**
   * @param {{random?: () => number, now?: () => number}} options inject a seeded random / clock for tests
   */
  constructor({ random = Math.random, now = Date.now } = {}) {
    this.random = random;
    this.now = now;
    this.mode = 'auto';
    this.serial = null;
    this.powered = false;
    this.led = false;
    this.stream = true;
    this.watchdogMs = DEFAULT_WATCHDOG_MS;
    this.watchdogTripped = false;
    this.lastCommandAt = now();
    this.replyCache = []; // [{ id, command, reply }]
    this.executed = 0; // commands actually executed (not replayed) — lets tests verify idempotency
    this.attempts = new Map(); // serial → how many times it was programmed (= test attempts)
    this.listeners = new Set();
  }

  /** The station writes the serial with "SN"; SVB-200 power boards use the PWR- prefix. */
  get model() {
    return this.serial?.startsWith('PWR-') ? 'SVB-200' : 'SVB-100';
  }

  get fault() {
    if (this.mode !== 'auto') return this.mode;
    return this.serial ? faultForSerial(this.serial) : 'none';
  }

  get firmware() {
    const m = MODELS[this.model];
    return this.fault === 'firmware' ? m.oldFw : m.fw;
  }

  setMode(mode) {
    if (!(mode in FAULTS)) throw new Error(`Bilinmeyen arıza modu: ${mode}`);
    this.mode = mode;
    this.notify();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    this.listeners.forEach((fn) => fn(this.state()));
  }

  state() {
    return {
      model: this.model,
      serial: this.serial,
      firmware: this.firmware,
      fault: this.fault,
      mode: this.mode,
      powered: this.powered,
      led: this.led,
      watchdogMs: this.watchdogMs,
      watchdogTripped: this.watchdogTripped,
    };
  }

  /** Call periodically: the watchdog cuts the supply when the station goes quiet. */
  tick(now = this.now()) {
    if (this.powered && this.watchdogMs > 0 && now - this.lastCommandAt > this.watchdogMs) {
      this.setSupply(false);
      this.watchdogTripped = true;
      this.notify();
    }
  }

  setSupply(on) {
    if (!on && this.fault === 'stuckpower') return; // a welded relay ignores the command
    this.powered = on;
    if (!on) this.led = false;
  }

  noise(scale) {
    return (this.random() - 0.5) * 2 * scale;
  }

  measure() {
    const m = MODELS[this.model];
    const v = (this.fault === 'undervoltage' ? m.vLow : m.v) + this.noise(m.vNoise);
    const i = (this.fault === 'overcurrent' ? m.iHigh : m.i) + this.noise(m.iNoise);
    let line = `V${v.toFixed(3)},I${i.toFixed(1)}`;
    if (m.t !== undefined) line += `,T${(m.t + this.noise(m.tNoise)).toFixed(1)}`;
    return line;
  }

  /** A line of the periodic sensor stream (not a reply, so it has no "@" prefix). */
  streamLine(t) {
    const temperature = 24 + 3 * Math.sin(t / 20) + this.noise(0.3);
    const humidity = 55 + 10 * Math.sin(t / 35 + 1) + this.noise(1);
    const pressure = 101.3 + 0.3 * Math.sin(t / 50) + this.noise(0.03);
    const light = Math.min(100, Math.max(0, 50 + 30 * Math.sin(t / 15) + this.noise(4)));
    return `A${temperature.toFixed(1)},B${humidity.toFixed(0)},C${pressure.toFixed(2)},D${light.toFixed(0)}`;
  }

  /**
   * Handles one command line, numbered ("#00A1 PWR ON") or not ("PWR ON").
   * A numbered command whose id and text are in the reply cache is not executed
   * again; the cached reply is replayed (idempotent retry).
   * @returns {string|null} reply line, or null when the board stays silent
   */
  handle(line, now = this.now()) {
    this.tick(now);
    const text = String(line).trim();
    const numbered = text.match(NUMBERED_RE);
    const id = numbered ? numbered[1].toUpperCase() : null;
    const command = numbered ? numbered[2].trim() : text;
    if (this.fault === 'silent') return null;
    this.lastCommandAt = now; // any command feeds the watchdog

    if (id) {
      const cached = this.replyCache.find((c) => c.id === id);
      if (cached) return cached.command === command ? cached.reply : `@#${id} ERR ID_REUSED`;
    }
    const body = this.execute(command, now);
    if (body === null) return null;
    this.notify();
    if (!id) return `@${body}`;
    const reply = `@#${id} ${body}`;
    this.replyCache.push({ id, command, reply });
    if (this.replyCache.length > REPLY_CACHE_SIZE) this.replyCache.shift();
    return reply;
  }

  /** @returns {string|null} reply body; null = no reply */
  execute(command, now) {
    const upper = command.toUpperCase();
    this.executed += 1;

    if (upper.startsWith('SN ')) {
      const serial = command.slice(3).trim().toUpperCase();
      if (!serial) return 'ERR BAD_ARG';
      if (serial !== this.serial) {
        this.setSupply(false);
        this.led = false;
      }
      this.serial = serial;
      this.attempts.set(serial, (this.attempts.get(serial) ?? 0) + 1);
      return 'OK';
    }
    if (upper.startsWith('WDT ')) {
      const ms = Number(command.slice(4).trim());
      if (!Number.isInteger(ms) || ms < 0 || ms > 60000) return 'ERR BAD_ARG';
      this.watchdogMs = ms;
      return 'OK';
    }

    switch (upper) {
      case 'PING':
        return 'OK';
      case 'SN?':
        return `SN ${this.serial ?? '-'}`;
      case 'ID?':
        return `ID ${this.model} FW${this.firmware}`;
      case 'STATUS?':
        return `PWR=${this.powered ? 1 : 0} LED=${this.led ? 1 : 0} WDT=${this.watchdogTripped ? 1 : 0}`;
      case 'PWR ON':
        this.setSupply(true);
        this.watchdogTripped = false;
        this.lastCommandAt = now;
        return 'OK';
      case 'PWR OFF':
        this.setSupply(false);
        return 'OK';
      case 'MEAS?':
        if (!this.powered) return 'ERR NOT_POWERED';
        // An intermittent board drops measurement replies on its first attempt only
        if (this.fault === 'intermittent' && (this.attempts.get(this.serial) ?? 0) <= 1) return null;
        return this.measure();
      case 'SELFTEST':
        if (!this.powered) return 'ERR NOT_POWERED';
        return this.fault === 'selftest' ? 'ERR SENSOR_FAULT' : 'OK';
      case 'LED ON':
        if (!this.powered) return 'ERR NOT_POWERED';
        // A broken LED still acknowledges the command: only a human can see the difference
        this.led = this.fault !== 'led';
        return 'OK';
      case 'LED OFF':
        this.led = false;
        return 'OK';
      case 'STREAM ON':
        this.stream = true;
        return 'OK';
      case 'STREAM OFF':
        this.stream = false;
        return 'OK';
      default:
        return 'ERR UNKNOWN_CMD';
    }
  }
}
