const socket = io();
const portSelect = document.getElementById('portSelect');
const output = document.getElementById('output');
const connectBtn = document.getElementById('connectBtn');

// Port listesini al ve <select> içine doldur
async function listPorts() {
  const res = await fetch('/ports');
  const ports = await res.json();

  portSelect.innerHTML = '';
  ports.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.path;
    opt.textContent = `${p.path} (${p.manufacturer})`;
    portSelect.appendChild(opt);
  });
}

// Kullanıcı butona basarsa bu fonksiyon çalışır
connectBtn.addEventListener('click', async () => {
  const path = portSelect.value;
  const res = await fetch('/select-port', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  });

  if (res.ok) {
    alert('✅ Bağlantı başarılı!');
  } else {
    alert('❌ Bağlantı hatası!');
  }
});

// Gelen seri veriyi ekrana yaz
socket.on('serial-data', (data) => {
  output.textContent += data + '\n';
});

// Sayfa açıldığında portları listele
listPorts();
