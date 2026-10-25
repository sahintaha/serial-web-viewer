// ============================================
// DEVICE SIMULATOR — a virtual board that speaks the line protocol in
// docs/protocol.md exactly like examples/arduino/svb_fixture does.
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
};

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
   * @param {{random?: () => number}} options inject a seeded random for tests
   */
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.mode = 'auto';
    this.serial = null;
    this.powered = false;
    this.led = false;
    this.stream = true;
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
    };
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
   * Handles one command line.
   * @returns {string|null} reply line ("@..."), or null when the board stays silent
   */
  handle(line) {
    const text = String(line).trim();
    const upper = text.toUpperCase();
    const reply = (body) => {
      this.notify();
      return `@${body}`;
    };

    if (this.fault === 'silent') return null;

    if (upper.startsWith('SN ')) {
      const serial = text.slice(3).trim().toUpperCase();
      if (!serial) return reply('ERR BAD_ARG');
      if (serial !== this.serial) {
        this.powered = false;
        this.led = false;
      }
      this.serial = serial;
      this.attempts.set(serial, (this.attempts.get(serial) ?? 0) + 1);
      return reply('OK');
    }

    switch (upper) {
      case 'SN?':
        return reply(`SN ${this.serial ?? '-'}`);
      case 'ID?':
        return reply(`ID ${this.model} FW${this.firmware}`);
      case 'PWR ON':
        this.powered = true;
        return reply('OK');
      case 'PWR OFF':
        this.powered = false;
        this.led = false;
        return reply('OK');
      case 'MEAS?':
        if (!this.powered) return reply('ERR NOT_POWERED');
        // An intermittent board drops measurement replies on its first attempt only
        if (this.fault === 'intermittent' && (this.attempts.get(this.serial) ?? 0) <= 1) return null;
        return reply(this.measure());
      case 'SELFTEST':
        if (!this.powered) return reply('ERR NOT_POWERED');
        return reply(this.fault === 'selftest' ? 'ERR SENSOR_FAULT' : 'OK');
      case 'LED ON':
        if (!this.powered) return reply('ERR NOT_POWERED');
        // A broken LED still acknowledges the command: only a human can see the difference
        this.led = this.fault !== 'led';
        return reply('OK');
      case 'LED OFF':
        this.led = false;
        return reply('OK');
      case 'STREAM ON':
        this.stream = true;
        return reply('OK');
      case 'STREAM OFF':
        this.stream = false;
        return reply('OK');
      default:
        return reply('ERR UNKNOWN_CMD');
    }
  }
}
