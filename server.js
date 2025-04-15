const { SerialPort, ReadlineParser } = require('serialport');
const express = require('express');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const PORT = 3000;

let io; 

const startServer = () => {
  app.use(express.static(path.join(__dirname, 'public')));
  const server = app.listen(PORT, () =>
    console.log(`Web server running at http://localhost:${PORT}`)
  );

  io = socketIo(server);

  io.on('connection', (socket) => {
    console.log('A user connected.');
    socket.on('disconnect', () => {
      console.log('A user disconnected.');
    });
  });
};


const initSerial = async () => {
  const ports = await SerialPort.list();
  const portInfo = ports.find(p => p.manufacturer);

  if (!portInfo) {
    console.log('⚠️ No serial port found. Starting server without Arduino.');
    startServer(); 
    return;
  }

  const serialPort = new SerialPort({
    path: portInfo.path,
    baudRate: 9600,
  });

  const parser = serialPort.pipe(new ReadlineParser({ delimiter: '\r\n' }));

  parser.on('data', (data) => {
    console.log('Arduino Data:', data);
    if (io) io.emit('serial-data', data);
  });

  startServer();
};

initSerial().catch(error => {
  console.error('❌ Error initializing serial port:', error);
  startServer(); 
});
