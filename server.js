const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { openResultsDb } = require('./db');

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
const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 500000, 1000000];
const MAX_MESSAGE_LENGTH = 1024;
const DEFAULT_DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'serial-viewer.db');

/**
 * Creates the HTTP + Socket.io server. All browser tabs share the same
 * serial connection, so state lives here and every event is broadcast.
 */
function createServer({ dbPath = DEFAULT_DB_PATH } = {}) {
  const app = express();
  const db = openResultsDb(dbPath);
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

  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', connected: state.connected, storage: 'sqlite' });
  });

  // ---------- products (versioned recipes) ----------
  const ready = shared.then(({ recipe }) => {
    db.seedProducts(recipe.DEFAULT_PRODUCTS.map((p) => recipe.validateProduct(p).product));
    return shared;
  });

  app.get('/api/products', async (req, res) => {
    await ready;
    res.json(db.listProducts({ includeArchived: req.query.archived === '1' }));
  });

  app.get('/api/products/:code', async (req, res) => {
    await ready;
    const revision = req.query.revision === undefined ? undefined : Number(req.query.revision);
    if (revision !== undefined && !Number.isInteger(revision)) return res.status(400).json({ errors: ['Geçersiz revizyon'] });
    const product = db.getProduct(String(req.params.code).toUpperCase(), revision);
    if (!product) return res.status(404).json({ errors: ['Ürün bulunamadı'] });
    res.json(product);
  });

  app.put('/api/products/:code', async (req, res) => {
    const { recipe } = await ready;
    const { product, errors } = recipe.validateProduct({ ...req.body, code: req.params.code });
    if (errors.length) return res.status(400).json({ errors });
    res.json(db.saveProduct(product));
  });

  app.delete('/api/products/:code', async (req, res) => {
    await ready;
    if (!db.archiveProduct(String(req.params.code).toUpperCase())) return res.status(404).json({ errors: ['Ürün bulunamadı'] });
    res.status(204).end();
  });

  // Retest policy for one unit: attempts so far, failures, blocked?
  app.get('/api/units/:serial', async (req, res) => {
    const { production, recipe } = await ready;
    const serial = recipe.normalizeSerial(req.params.serial);
    const product = req.query.product ? db.getProduct(String(req.query.product).toUpperCase()) : null;
    res.json({ serial, ...production.unitStatus(db.unitHistory(serial), product?.maxAttempts ?? Infinity) });
  });

  // ---------- production test results ----------
  function parseFilters(query, { maxLimit = 1000 } = {}) {
    const errors = [];
    const filters = {};
    if (query.serial) filters.serial = String(query.serial).trim().toUpperCase().slice(0, 40);
    if (query.product) filters.product = String(query.product).trim().toUpperCase().slice(0, 24);
    if (query.result) {
      if (!['PASS', 'FAIL', 'ERROR'].includes(query.result)) errors.push('Geçersiz sonuç filtresi');
      else filters.result = query.result;
    }
    for (const key of ['from', 'to']) {
      if (!query[key]) continue;
      const time = Date.parse(query[key]);
      if (Number.isNaN(time)) errors.push(`Geçersiz tarih: ${key}`);
      else filters[key] = new Date(time).toISOString();
    }
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) errors.push(`limit 1–${maxLimit} arasında olmalı`);
    if (!Number.isInteger(offset) || offset < 0) errors.push('offset geçersiz');
    filters.limit = limit;
    filters.offset = offset;
    return { filters, errors };
  }

  app.post('/api/tests', async (req, res) => {
    const { production } = await ready;
    const code = String(req.body?.productCode ?? '').toUpperCase();
    const revision = Number(req.body?.recipeRevision);
    // The verdict is recomputed with the exact recipe revision the station ran
    const product = code && Number.isInteger(revision) ? db.getProduct(code, revision) : null;
    const { errors, value } = production.prepareTestRecord(req.body, product);
    if (errors.length) return res.status(400).json({ errors });
    try {
      res.status(201).json(db.insert(value, production.cleanLog(req.body?.log)));
    } catch (err) {
      console.error('❌ Test sonucu kaydedilemedi:', err.message);
      res.status(500).json({ errors: ['Test sonucu kaydedilemedi'] });
    }
  });

  app.get('/api/tests', (req, res) => {
    const { filters, errors } = parseFilters(req.query);
    if (errors.length) return res.status(400).json({ errors });
    res.json(db.query(filters));
  });

  app.get('/api/tests/export.csv', async (req, res) => {
    const { production } = await ready;
    const { filters, errors } = parseFilters({ limit: 100000, ...req.query }, { maxLimit: 100000 });
    if (errors.length) return res.status(400).json({ errors });
    const { items } = db.query(filters);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.type('text/csv; charset=utf-8');
    res.attachment(`test-raporu-${stamp}.csv`);
    // BOM so Excel opens Turkish characters correctly
    res.send('\uFEFF' + production.resultsToCsv(items));
  });

  app.get('/api/tests/:id', (req, res) => {
    const record = db.get(Number(req.params.id));
    if (!record) return res.status(404).json({ errors: ['Kayıt bulunamadı'] });
    res.json(record);
  });

  // Malformed JSON bodies end up here instead of an HTML stack trace
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ errors: ['Geçersiz istek gövdesi'] });
    }
    next(err);
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

  server.on('close', () => db.close());

  return { app, server, io, db, closeSerialPorts };
}

if (require.main === module) {
  const { server, db, closeSerialPorts } = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`🚀 Serial Web Viewer çalışıyor: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
  process.on('SIGINT', () => {
    closeSerialPorts();
    db.close();
    process.exit(0);
  });
}

module.exports = { createServer, BAUD_RATES };
