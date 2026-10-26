const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const { openResultsDb } = require('./db');
const { createSerialBridge, BAUD_RATES } = require('./lib/serial-bridge');
const { createAuth } = require('./lib/auth');
const { mountApi } = require('./lib/api');
const { securityHeaders } = require('./lib/security-headers');
const pkg = require('./package.json');

// Validation, recipe evaluation and reporting are shared with the browser (ES modules)
const shared = Promise.all([import('./public/js/production.js'), import('./public/js/recipe.js')]).then(
  ([production, recipe]) => ({ production, recipe })
);

// Optional .env support (Node >= 20.12) without an extra dependency
try {
  process.loadEnvFile();
} catch {
  // no .env file — fall back to defaults
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_BAUD_RATE = Number(process.env.BAUD_RATE) || 9600;
const DEFAULT_DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'serial-viewer.db');

/** Recorded with every test result (traceability). */
function stationFromEnv(env = process.env) {
  return {
    id: env.STATION_ID || os.hostname(),
    fixture: env.FIXTURE_ID || null,
    calibration: env.CALIBRATION_ID || env.CALIBRATION_DUE ? { id: env.CALIBRATION_ID || null, due: env.CALIBRATION_DUE || null } : null,
    appVersion: `${pkg.version}${env.BUILD_SHA ? '+' + env.BUILD_SHA.slice(0, 8) : ''}`,
  };
}

/**
 * Creates the HTTP + Socket.io server. All browser tabs share the same serial
 * connection; every REST and Socket.io request must belong to a logged-in user.
 */
function createServer({ dbPath = DEFAULT_DB_PATH, SerialPortImpl = SerialPort, station = stationFromEnv(), log = console } = {}) {
  const app = express();
  const db = openResultsDb(dbPath);
  const server = http.createServer(app);
  const io = new Server(server);
  const auth = createAuth({ db, log });

  io.use(auth.socketMiddleware);
  const bridge = createSerialBridge({
    io,
    SerialPortImpl,
    defaultBaudRate: DEFAULT_BAUD_RATE,
    canControl: (socket) => auth.hasRole(auth.socketUser(socket), 'operator'),
    log,
  });

  app.disable('x-powered-by');
  app.use(securityHeaders(path.join(__dirname, 'public')));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json({ limit: '512kb' }));
  app.use(auth.attachUser);
  app.use(auth.sameOrigin);

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: bridge.state.connected, storage: 'sqlite', auth: true });
  });

  app.get('/ports', auth.requireRole('operator'), async (req, res) => {
    try {
      res.json(await SerialPortImpl.list());
    } catch (error) {
      log.error?.('Port listesi alınamadı:', error.message);
      res.status(500).json({ errors: ['Port listesi alınamadı'] });
    }
  });

  auth.routes(app);
  mountApi({ app, db, auth, bridge, shared, station });

  // Malformed JSON bodies and unexpected errors end up here instead of an HTML stack trace
  app.use((err, req, res, next) => {
    void next;
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ errors: ['Geçersiz istek gövdesi'] });
    }
    log.error?.('Beklenmeyen sunucu hatası:', err);
    res.status(500).json({ errors: ['Sunucu hatası'] });
  });

  server.on('close', () => db.close());

  /** Closes the serial port, every client connection and the HTTP server; the database follows. */
  async function stop() {
    await bridge.shutdown();
    await new Promise((resolve) => {
      io.close(() => resolve()); // also closes the HTTP server
      server.closeAllConnections?.();
    });
  }

  return { app, server, io, db, bridge, auth, station, stop };
}

if (require.main === module) {
  const { server, stop } = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Serial Web Viewer çalışıyor: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
  // Graceful shutdown (Ctrl+C, docker stop): close the serial port, stop accepting
  // connections, let SQLite checkpoint the WAL, then exit. Forced after 5 s.
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} alındı, kapatılıyor…`);
    setTimeout(() => process.exit(1), 5000).unref();
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createServer, stationFromEnv, BAUD_RATES };
