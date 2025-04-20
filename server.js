const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let receiverPort = null;
let transmitterPort = null;
let receiverParser = null;
let sendInterval = null;

// Statik dosyalar (index.html burada olacak)
app.use(express.static(path.join(__dirname, 'public')));

// Port listesini istemciye gönder
app.get('/ports', async (req, res) => {
  try {
    const ports = await SerialPort.list();
    res.json(ports);
  } catch (error) {
    console.error('Port listesi alınamadı:', error);
    res.status(500).json({ error: 'Port listesi alınamadı' });
  }
});

io.on('connection', (socket) => {
  console.log('📡 Yeni istemci bağlandı');

  // Kullanıcı port seçtiğinde
  socket.on('select-ports', ({ receiverPath, transmitterPath }) => {
    console.log(`🎯 Seçilen portlar -> Receiver: ${receiverPath}, Transmitter: ${transmitterPath}`);
    openSerialPorts(receiverPath, transmitterPath, socket);
    socket.emit('connection-status', { connected: true });
  });

  // Manuel veri gönder
  socket.on('send-manual', (message) => {
    if (transmitterPort && transmitterPort.isOpen) {
      transmitterPort.write(message + '\n', (err) => {
        if (err) console.error('🛑 Manuel gönderim hatası:', err.message);
        else console.log('📤 Manuel veri gönderildi:', message);
      });
    } else {
      console.log('⚠️ Verici port açık değil, veri gönderilemedi');
    }
  });

  // Manuel bağlantı kesme
  socket.on('disconnect-ports', () => {
    console.log('🔌 Manuel bağlantı kesme talebi alındı');
    closeSerialPorts();
    socket.emit('connection-status', { connected: false });
  });

  // Otomatik veri gönderimi başlat
  socket.on('start-auto-send', (message, interval) => {
    if (sendInterval) clearInterval(sendInterval);
    if (transmitterPort && transmitterPort.isOpen) {
      sendInterval = setInterval(() => {
        transmitterPort.write(message + '\n', (err) => {
          if (err) console.error('🛑 Otomatik gönderim hatası:', err.message);
          else console.log('📤 Otomatik veri gönderildi:', message);
        });
      }, interval);
    } else {
      console.log('⚠️ Verici port açık değil, otomatik gönderim başlatılamadı');
    }
  });

  // Otomatik gönderimi durdur
  socket.on('stop-auto-send', () => {
    if (sendInterval) {
      clearInterval(sendInterval);
      sendInterval = null;
      console.log('⛔ Otomatik gönderim durduruldu');
    }
  });
});

// Serial portları kapatma
function closeSerialPorts() {
  if (receiverPort && receiverPort.isOpen) receiverPort.close();
  if (transmitterPort && transmitterPort.isOpen) transmitterPort.close();
  receiverPort = transmitterPort = receiverParser = null;
  if (sendInterval) {
    clearInterval(sendInterval);
    sendInterval = null;
  }
}

// Serial portları aç
function openSerialPorts(receiverPath, transmitterPath, socket) {
  if (!receiverPath) {
    console.error('❌ Hatalı port yolları');
    return;
  }

  closeSerialPorts();

  // Receiver port
  receiverPort = new SerialPort({ path: receiverPath, baudRate: 9600 });
  receiverParser = receiverPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

  receiverParser.on('data', (data) => {
    console.log('📥 Alıcıdan gelen veri:', data);
    socket.emit('serial-data', data);
  });

  receiverPort.on('open', () => {
    console.log('✅ Receiver port açıldı:', receiverPath);
    socket.emit('connection-status', { connected: true });
  });

  receiverPort.on('error', (err) => {
    console.error('❌ Receiver port hatası:', err.message);
    socket.emit('connection-status', { connected: false, error: err.message });
  });

  // Transmitter port (sadece seçilmişse)
  if (transmitterPath) {
    transmitterPort = new SerialPort({ path: transmitterPath, baudRate: 9600 });

    transmitterPort.on('open', () => {
      console.log('✅ Transmitter port açıldı:', transmitterPath);
    });

    transmitterPort.on('error', (err) => {
      console.error('❌ Transmitter port hatası:', err.message);
    });
  } else {
    console.log('ℹ️ Transmitter port seçilmedi, sadece veri alımı yapılacak');
  }
}

server.listen(3000, () => {
  console.log('🚀 Sunucu çalışıyor http://localhost:3000');
});
