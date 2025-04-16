const socket = io();
const portSelect = document.getElementById('portSelect');
const output = document.getElementById('output');
const connectBtn = document.getElementById('connectBtn');

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

socket.on('serial-data', (data) => {
  output.textContent += data + '\n';
});

// Sayfa açıldığında portları listele
listPorts();
