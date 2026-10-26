// End-to-end test harness.
//
//   startStatic()  serves public/ like GitHub Pages (no server, browser storage)
//   startServer()  runs server.js in-process on a mock serial port; a SimulatedBoard
//                  answers on that port, so the whole chain (browser → Socket.io →
//                  port lock → serial port → "firmware" → SQLite) is exercised without hardware.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { SerialPortMock } = require('serialport');
const { createServer } = require('../server');

const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain' };

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

async function startStatic() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  const url = await listen(server);
  return { url, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Connects a simulated board to every mock port the bridge opens. */
function attachBoard(binding, board) {
  const open = binding.open.bind(binding);
  binding.open = async (options) => {
    const port = await open(options);
    const write = port.write.bind(port);
    let buffer = '';
    port.write = async (data) => {
      await write(data);
      buffer += data.toString();
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, '');
        buffer = buffer.slice(i + 1);
        const reply = board.handle(line);
        if (reply !== null) setTimeout(() => port.isOpen && port.emitData(Buffer.from(reply + '\n')), 10);
      }
    };
    return port;
  };
}

async function startServer() {
  const { SimulatedBoard } = await import('../public/js/simulator.js');
  SerialPortMock.binding.reset();
  SerialPortMock.binding.createPort('/dev/FIXTURE', { echo: false, record: false });
  const board = new SimulatedBoard();
  board.setMode('none');
  attachBoard(SerialPortMock.binding, board);
  const watchdog = setInterval(() => board.tick(), 100);

  const ctx = createServer({
    dbPath: ':memory:',
    SerialPortImpl: SerialPortMock,
    station: { id: 'E2E-01', fixture: 'FX-E2E', calibration: { id: 'CAL-E2E', due: '2099-01-01' }, appVersion: 'e2e' },
    log: {},
  });
  const url = await listen(ctx.server);
  return {
    url,
    ctx,
    board,
    setupToken: ctx.auth.getSetupToken(),
    async close() {
      clearInterval(watchdog);
      await ctx.stop();
    },
  };
}

module.exports = { startStatic, startServer };
