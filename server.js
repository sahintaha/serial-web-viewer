const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// Optional .env support (Node >= 20.12) without an extra dependency
try {
  process.loadEnvFile();
} catch {
  // no .env file — fall back to defaults
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_BAUD_RATE = Number(process.env.BAUD_RATE) || 9600;
const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 500000, 1000000];
const MAX_MESSAGE_LENGTH = 1024;

/**
 * Creates the HTTP + Socket.io server. All browser tabs share the same
 * serial connection, so state lives here and every event is broadcast.
 */
function createServer() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  const state = {
    receiver: null,
    transmitter: null,
    receiverPath: null,
    transmitterPath: null,
    baudRate: DEFAULT_BAUD_RATE,
    connected: false,
  };

  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: state.connected });
  });

  app.get('/ports', async (req, res) => {
    try {
      res.json(await SerialPort.list());
    } catch (error) {
      console.error('Port listesi alınamadı:', error.message);
      res.status(500).json({ error: 'Port listesi alınamadı' });
    }
  });

  function statusPayload(extra = {}) {
    return {
      connected: state.connected,
      receiverPath: state.receiverPath,
      transmitterPath: state.transmitterPath,
      baudRate: state.baudRate,
      ...extra,
    };
  }

  function broadcastStatus(extra) {
    io.emit('connection-status', statusPayload(extra));
  }

  function closePort(port) {
    if (!port) return;
    port.removeAllListeners();
    // Keep a no-op error handler so a late error can't crash the process
    port.on('error', () => {});
    if (port.isOpen) port.close();
  }

  function closeSerialPorts() {
    closePort(state.receiver);
    if (state.transmitter !== state.receiver) closePort(state.transmitter);
    state.receiver = state.transmitter = null;
    state.receiverPath = state.transmitterPath = null;
    state.connected = false;
  }

  function openPort(portPath, baudRate) {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path: portPath, baudRate, autoOpen: false });
      port.open((err) => (err ? reject(err) : resolve(port)));
    });
  }

  async function openSerialPorts({ receiverPath, transmitterPath, baudRate }) {
    closeSerialPorts();

    const receiver = await openPort(receiverPath, baudRate);
    let transmitter = receiver;
    if (transmitterPath && transmitterPath !== receiverPath) {
      try {
        transmitter = await openPort(transmitterPath, baudRate);
      } catch (err) {
        closePort(receiver);
        throw err;
      }
    }

    // Accept both "\n" and "\r\n" line endings
    const parser = receiver.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (line) => {
      const data = line.replace(/\r$/, '');
      if (data) io.emit('serial-data', data);
    });

    const onLost = (label) => (err) => {
      if (!state.connected) return;
      console.error(`❌ ${label} port bağlantısı koptu${err ? ': ' + err.message : ''}`);
      closeSerialPorts();
      broadcastStatus({ error: `${label} port bağlantısı koptu` });
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
      baudRate,
      connected: true,
    });
  }

  io.on('connection', (socket) => {
    // A newly opened tab immediately sees the shared connection state
    socket.emit('connection-status', statusPayload());

    socket.on('select-ports', async (options = {}) => {
      const receiverPath = typeof options.receiverPath === 'string' ? options.receiverPath.trim() : '';
      const transmitterPath = typeof options.transmitterPath === 'string' ? options.transmitterPath.trim() : '';
      const baudRate = Number(options.baudRate) || DEFAULT_BAUD_RATE;

      if (!receiverPath) {
        socket.emit('connection-status', statusPayload({ error: 'Alıcı port seçilmedi' }));
        return;
      }
      if (!BAUD_RATES.includes(baudRate)) {
        socket.emit('connection-status', statusPayload({ error: `Geçersiz baud rate: ${baudRate}` }));
        return;
      }

      try {
        await openSerialPorts({ receiverPath, transmitterPath, baudRate });
        console.log(`✅ Bağlandı: ${receiverPath}${transmitterPath ? ' / ' + transmitterPath : ''} @ ${baudRate}`);
        broadcastStatus();
      } catch (err) {
        console.error('❌ Port açılamadı:', err.message);
        closeSerialPorts();
        socket.emit('connection-status', statusPayload({ error: `Port açılamadı: ${err.message}` }));
      }
    });

    socket.on('disconnect-ports', () => {
      closeSerialPorts();
      broadcastStatus();
    });

    socket.on('send-manual', (message) => {
      if (typeof message !== 'string' || !message || message.length > MAX_MESSAGE_LENGTH) {
        socket.emit('send-error', 'Geçersiz mesaj');
        return;
      }
      if (!state.transmitter || !state.transmitter.isOpen) {
        socket.emit('send-error', 'Port açık değil, veri gönderilemedi');
        return;
      }
      state.transmitter.write(message + '\n', (err) => {
        if (err) socket.emit('send-error', `Gönderim hatası: ${err.message}`);
      });
    });
  });

  return { app, server, io, closeSerialPorts };
}

if (require.main === module) {
  const { server, closeSerialPorts } = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`🚀 Serial Web Viewer çalışıyor: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
  process.on('SIGINT', () => {
    closeSerialPorts();
    process.exit(0);
  });
}

module.exports = { createServer, BAUD_RATES };
