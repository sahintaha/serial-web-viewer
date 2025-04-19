const { SerialPort, ReadlineParser } = require('serialport');
const express = require('express');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const PORT = 3000;

let io;
let serialPort;
let parser;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const server = app.listen(PORT, () => {
  console.log(`🌐 Web server running at http://localhost:${PORT}`);
});

io = socketIo(server);

// Web istemciden gelen bağlantı isteğini dinle
io.on('connection', (socket) => {
  console.log('⚡ Bir kullanıcı bağlandı.');

  socket.on('disconnect', () => {
    console.log('❌ Kullanıcı ayrıldı.');
  });

  socket.on('select-port', (portPath) => {
    console.log(`🔌 Port seçildi: ${portPath}`);
    openSerialPort(portPath);
  });

  socket.on('disconnect-port', () => {
    if (serialPort && serialPort.isOpen) {
      serialPort.close((err) => {
        if (err) {
          console.error('❌ Port kapatma hatası:', err.message);
        } else {
          console.log('🔌 Seri port kapatıldı.');
        }
      });
    }
  });
});

app.get('/ports', async (req, res) => {
  const ports = await SerialPort.list();
  res.json(ports.map(p => ({
    path: p.path,
    manufacturer: p.manufacturer || 'Bilinmeyen'
  })));
});

function openSerialPort(portPath) {
  if (serialPort && serialPort.isOpen) {
    serialPort.close();
  }

  serialPort = new SerialPort({ path: portPath, baudRate: 9600 });
  parser = serialPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

  parser.on('data', (data) => {
    console.log('📡 Arduino:', data);
    if (io) io.emit('serial-data', data);
  });

  serialPort.on('error', (err) => {
    console.error('❌ Seri port hatası:', err.message);
  });
}