// Serial port ⇄ Socket.io bridge.
//
// - One shared connection for all clients; open / close operations are serialised
//   so a quick connect → disconnect → connect never reopens a port that is still closing.
// - A test station can lock the port: while locked, other clients cannot write,
//   reconnect or disconnect. The lock is released when its socket disconnects.
// - Writes are acknowledged with the real result (written and drained, or the error).
// - Incoming data is split into lines with a hard length limit; raw bytes are
//   forwarded only to clients that asked for them (HEX view).

const { SerialPort } = require('serialport');

const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 500000, 1000000];
const DATA_BITS = [7, 8];
const STOP_BITS = [1, 2];
const PARITIES = ['none', 'even', 'odd'];
const LINE_ENDINGS = { lf: '\n', crlf: '\r\n', cr: '\r', none: '' };
const MAX_MESSAGE_LENGTH = 1024;
const MAX_LINE_LENGTH = 4096;

/** Splits a byte stream into lines; an overlong line is dropped and counted, never buffered forever. */
function createLineSplitter({ onLine, onOverflow, maxLength = MAX_LINE_LENGTH }) {
  let buffer = '';
  let discarding = false;
  const decoder = new TextDecoder('utf-8');
  return (chunk) => {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (discarding) {
        discarding = false; // the tail of an overlong line
        continue;
      }
      if (line) onLine(line);
    }
    if (buffer.length > maxLength) {
      buffer = '';
      discarding = true;
      onOverflow();
    }
  };
}

function validSettings(options) {
  const baudRate = Number(options.baudRate);
  const dataBits = options.dataBits === undefined ? 8 : Number(options.dataBits);
  const stopBits = options.stopBits === undefined ? 1 : Number(options.stopBits);
  const parity = options.parity ?? 'none';
  const errors = [];
  if (!BAUD_RATES.includes(baudRate)) errors.push(`Geçersiz baud rate: ${options.baudRate}`);
  if (!DATA_BITS.includes(dataBits)) errors.push('Data bits 7 veya 8 olmalı');
  if (!STOP_BITS.includes(stopBits)) errors.push('Stop bits 1 veya 2 olmalı');
  if (!PARITIES.includes(parity)) errors.push('Parity none, even veya odd olmalı');
  return { settings: { baudRate, dataBits, stopBits, parity }, errors };
}

/**
 * @param {object} options
 * @param {import('socket.io').Server} options.io
 * @param {typeof SerialPort} [options.SerialPortImpl] e.g. SerialPortMock in tests
 * @param {number} [options.defaultBaudRate]
 * @param {(socket) => boolean} [options.canControl] authorisation hook (roles)
 */
function createSerialBridge({ io, SerialPortImpl = SerialPort, defaultBaudRate = 9600, canControl = () => true, log = console }) {
  const state = {
    receiver: null,
    transmitter: null,
    receiverPath: null,
    transmitterPath: null,
    settings: { baudRate: defaultBaudRate, dataBits: 8, stopBits: 1, parity: 'none' },
    connected: false,
    lock: null, // { socketId, owner, user, since }
    overflows: 0,
  };
  let operations = Promise.resolve();

  /** Runs open / close operations strictly one after another. */
  const serialise = (fn) => {
    const next = operations.then(fn, fn);
    operations = next.catch(() => {});
    return next;
  };

  function statusPayload(extra = {}) {
    return {
      connected: state.connected,
      receiverPath: state.receiverPath,
      transmitterPath: state.transmitterPath,
      baudRate: state.settings.baudRate,
      settings: state.settings,
      locked: Boolean(state.lock),
      lockOwner: state.lock ? { owner: state.lock.owner, user: state.lock.user, since: state.lock.since } : null,
      overflows: state.overflows,
      ...extra,
    };
  }

  const broadcastStatus = (extra) => io.emit('connection-status', statusPayload(extra));

  function closePort(port) {
    return new Promise((resolve) => {
      if (!port) return resolve();
      port.removeAllListeners();
      port.on('error', () => {}); // a late error must not crash the process
      if (!port.isOpen) return resolve();
      port.close(() => resolve());
    });
  }

  async function closeAll() {
    const { receiver, transmitter } = state;
    Object.assign(state, { receiver: null, transmitter: null, receiverPath: null, transmitterPath: null, connected: false });
    await closePort(receiver);
    if (transmitter !== receiver) await closePort(transmitter);
  }

  function openPort(path, settings) {
    return new Promise((resolve, reject) => {
      const port = new SerialPortImpl({ path, ...settings, autoOpen: false });
      port.open((err) => (err ? reject(err) : resolve(port)));
    });
  }

  async function openAll({ receiverPath, transmitterPath, settings }) {
    await closeAll(); // wait until the previous port is really closed
    const receiver = await openPort(receiverPath, settings);
    let transmitter = receiver;
    if (transmitterPath && transmitterPath !== receiverPath) {
      try {
        transmitter = await openPort(transmitterPath, settings);
      } catch (err) {
        await closePort(receiver);
        throw err;
      }
    }

    const split = createLineSplitter({
      onLine: (line) => io.emit('serial-data', line),
      onOverflow: () => {
        state.overflows += 1;
        io.emit('serial-overflow', { count: state.overflows, maxLength: MAX_LINE_LENGTH });
      },
    });
    receiver.on('data', (chunk) => {
      io.to('raw').emit('serial-raw', chunk);
      split(chunk);
    });

    const onLost = (label) => (err) => {
      if (!state.connected) return;
      log.error?.(`${label} port bağlantısı koptu${err ? ': ' + err.message : ''}`);
      serialise(closeAll).then(() => broadcastStatus({ error: `${label} port bağlantısı koptu` }));
    };
    receiver.on('close', onLost('Alıcı'));
    receiver.on('error', onLost('Alıcı'));
    if (transmitter !== receiver) {
      transmitter.on('close', onLost('Verici'));
      transmitter.on('error', onLost('Verici'));
    }
    Object.assign(state, {
      receiver,
      transmitter,
      receiverPath,
      transmitterPath: transmitter === receiver ? null : transmitterPath,
      settings,
      connected: true,
    });
  }

  function lockedByOther(socket) {
    return state.lock && state.lock.socketId !== socket.id;
  }

  const reply = (ack, payload) => typeof ack === 'function' && ack(payload);
  const lockedMessage = () => `Port, ${state.lock.user ?? 'başka bir istemci'} tarafından test için kilitli (${state.lock.owner})`;

  io.on('connection', (socket) => {
    socket.emit('connection-status', statusPayload());

    socket.on('select-ports', async (options = {}, ack) => {
      if (!canControl(socket)) return reply(ack, { ok: false, error: 'Yetki yok' });
      if (lockedByOther(socket)) return reply(ack, { ok: false, error: lockedMessage() });
      const receiverPath = typeof options.receiverPath === 'string' ? options.receiverPath.trim() : '';
      const transmitterPath = typeof options.transmitterPath === 'string' ? options.transmitterPath.trim() : '';
      const { settings, errors } = validSettings({ baudRate: defaultBaudRate, ...options });
      if (!receiverPath) errors.unshift('Alıcı port seçilmedi');
      if (errors.length) {
        socket.emit('connection-status', statusPayload({ error: errors[0] }));
        return reply(ack, { ok: false, error: errors[0] });
      }
      try {
        await serialise(() => openAll({ receiverPath, transmitterPath, settings }));
        log.log?.(`Bağlandı: ${receiverPath}${transmitterPath ? ' / ' + transmitterPath : ''} @ ${settings.baudRate}`);
        broadcastStatus();
        reply(ack, { ok: true });
      } catch (err) {
        await serialise(closeAll);
        const error = `Port açılamadı: ${err.message}`;
        socket.emit('connection-status', statusPayload({ error }));
        reply(ack, { ok: false, error });
      }
    });

    socket.on('disconnect-ports', async (ack) => {
      if (!canControl(socket)) return reply(ack, { ok: false, error: 'Yetki yok' });
      if (lockedByOther(socket)) return reply(ack, { ok: false, error: lockedMessage() });
      await serialise(closeAll);
      broadcastStatus();
      reply(ack, { ok: true });
    });

    socket.on('send-manual', (payload, ack) => {
      const text = typeof payload === 'string' ? payload : payload?.text;
      const ending = typeof payload === 'object' && payload?.ending ? payload.ending : 'lf';
      if (!canControl(socket)) return reply(ack, { ok: false, error: 'Yetki yok' });
      if (typeof text !== 'string' || !text || text.length > MAX_MESSAGE_LENGTH || /[\r\n]/.test(text)) {
        return reply(ack, { ok: false, error: 'Geçersiz mesaj (boş, çok uzun veya satır sonu içeriyor)' });
      }
      if (!(ending in LINE_ENDINGS)) return reply(ack, { ok: false, error: 'Geçersiz satır sonu' });
      if (lockedByOther(socket)) return reply(ack, { ok: false, error: lockedMessage() });
      const port = state.transmitter;
      if (!port || !port.isOpen) return reply(ack, { ok: false, error: 'Port açık değil, veri gönderilemedi' });
      port.write(text + LINE_ENDINGS[ending], (err) => {
        if (err) return reply(ack, { ok: false, error: `Gönderim hatası: ${err.message}` });
        port.drain((drainErr) => reply(ack, drainErr ? { ok: false, error: drainErr.message } : { ok: true }));
      });
    });

    socket.on('lock', (owner, ack) => {
      if (!canControl(socket)) return reply(ack, { ok: false, error: 'Yetki yok' });
      if (lockedByOther(socket)) return reply(ack, { ok: false, error: lockedMessage() });
      if (!state.connected) return reply(ack, { ok: false, error: 'Port açık değil' });
      state.lock = { socketId: socket.id, owner: String(owner).slice(0, 64), user: socket.data.user?.displayName ?? null, since: new Date().toISOString() };
      broadcastStatus();
      reply(ack, { ok: true });
    });

    socket.on('unlock', (owner, ack) => {
      if (state.lock?.socketId === socket.id) {
        state.lock = null;
        broadcastStatus();
      }
      reply(ack, { ok: true });
    });

    socket.on('raw-subscribe', (on) => (on ? socket.join('raw') : socket.leave('raw')));

    socket.on('disconnect', () => {
      // A crashed or closed tab must not keep the port locked; the board's own watchdog switches it off
      if (state.lock?.socketId === socket.id) {
        log.warn?.(`Test kilidi sahibi bağlantıyı kaybetti (${state.lock.owner}); kilit kaldırıldı`);
        state.lock = null;
        broadcastStatus();
      }
    });
  });

  return {
    state,
    statusPayload,
    shutdown: () => serialise(closeAll),
  };
}

module.exports = { createSerialBridge, createLineSplitter, BAUD_RATES, LINE_ENDINGS, MAX_LINE_LENGTH };
