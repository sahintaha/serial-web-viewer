// ============================================
// MODERN SERIAL VIEWER - JAVASCRIPT
// ============================================

const socket = io();
let lastTaggedData = '';
let autoSendInterval = null;
let isConnected = false;
let dataChart = null;
let chartData = {
  labels: [],
  datasets: []
};

// Test Mode Variables
let testModeActive = false;
let testInterval = null;

// DOM Elements
const receiverSelect = document.getElementById('receiver-select');
const transmitterSelect = document.getElementById('transmitter-select');
const receiverCustom = document.getElementById('receiver-custom');
const transmitterCustom = document.getElementById('transmitter-custom');
const receiverToggle = document.getElementById('receiver-custom-toggle');
const transmitterToggle = document.getElementById('transmitter-custom-toggle');
const dataContainer = document.getElementById('data-container');
const taggedDataContainer = document.getElementById('tagged-data');
const connectionButton = document.getElementById('connection-button');
const connectionStatus = document.getElementById('connection-status');
const errorToast = document.getElementById('error-toast');
const successToast = document.getElementById('success-toast');
const loadingOverlay = document.getElementById('loading-overlay');

// Theme Management
function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
}

document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

// Toast Notifications
function showToast(message, type = 'error') {
  const toast = type === 'error' ? errorToast : successToast;
  const messageElement = toast.querySelector(`#${type}-message`);
  messageElement.textContent = message;
  toast.classList.add('show');
  
  setTimeout(() => {
    closeToast(type);
  }, 5000);
}

function closeToast(type = 'error') {
  const toast = type === 'error' ? errorToast : successToast;
  toast.classList.remove('show');
}

// Loading Overlay
function showLoading() {
  loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

// Load Ports
async function loadPorts() {
  showLoading();
  try {
  const res = await fetch('/ports');
  const ports = await res.json();

    receiverSelect.innerHTML = '<option value="">Port seçin...</option>';
    transmitterSelect.innerHTML = '<option value="">Port seçin (opsiyonel)...</option>';
    
    ports.forEach(port => {
      const option1 = document.createElement('option');
      const option2 = document.createElement('option');
      option1.value = option2.value = port.path;
      const manufacturer = port.manufacturer || 'Bilinmeyen';
      option1.textContent = option2.textContent = `${port.path} (${manufacturer})`;
      receiverSelect.appendChild(option1);
      transmitterSelect.appendChild(option2);
    });
    
    hideLoading();
  } catch (error) {
    hideLoading();
    showToast('Portlar yüklenirken hata oluştu: ' + error.message);
  }
}

// Connection Management
function toggleConnection() {
  if (!isConnected) {
    connectPorts();
  } else {
    disconnectPorts();
  }
}

function connectPorts() {
  const receiverPath = receiverToggle.checked ? receiverCustom.value.trim() : receiverSelect.value;
  const transmitterPath = transmitterToggle.checked ? transmitterCustom.value.trim() : transmitterSelect.value;
  
  if (!receiverPath) {
    showToast('Lütfen alıcı port seçin veya girin');
    return;
  }

  connectionButton.disabled = true;
  connectionButton.innerHTML = '<span class="btn-icon">⏳</span><span>Bağlanıyor...</span>';
  
  socket.emit('select-ports', {
    receiverPath: receiverPath,
    transmitterPath: transmitterPath || null
  });
}

function disconnectPorts() {
  socket.emit('disconnect-ports');
  clearInterval(autoSendInterval);
  autoSendInterval = null;
  document.getElementById('auto-send-checkbox').checked = false;
  updateConnectionStatus(false);
}

function updateConnectionStatus(connected) {
  isConnected = connected;
  connectionStatus.classList.toggle('connected', connected);
  
  if (connected) {
    connectionStatus.querySelector('.status-text').textContent = 'Bağlı';
    connectionButton.innerHTML = '<span class="btn-icon">❌</span><span>Bağlantıyı Kes</span>';
    connectionButton.classList.add('connected');
    showToast('Bağlantı başarılı!', 'success');
  } else {
    connectionStatus.querySelector('.status-text').textContent = 'Bağlantı Yok';
    connectionButton.innerHTML = '<span class="btn-icon">🔌</span><span>Bağlan</span>';
    connectionButton.classList.remove('connected');
  }
  
  connectionButton.disabled = false;
}

// Send Data
function sendData() {
  const message = document.getElementById('send-input').value.trim();
  if (!message) {
    showToast('Lütfen gönderilecek veriyi girin');
    return;
  }
  
  if (!isConnected) {
    showToast('Önce port bağlantısı kurun');
    return;
  }
  
  socket.emit('send-manual', message);
  document.getElementById('send-input').value = '';
  showToast('Veri gönderildi', 'success');
}

// Clear Data
function clearData(containerId) {
  const container = document.getElementById(containerId);
  if (container) {
    container.innerHTML = '';
    if (containerId === 'tagged-data') {
      lastTaggedData = '';
    }
  }
}

// Add Label Row
function addLabelRow() {
  const labelConfigs = document.getElementById('label-configs');
  const newRow = document.createElement('div');
  newRow.className = 'label-row';
  newRow.innerHTML = `
    <input type="text" class="form-input prefix-input" placeholder="Örn: D">
    <input type="text" class="form-input label-input" placeholder="Örn: Hız">
  `;
  labelConfigs.appendChild(newRow);
}

// Port Toggle Handlers
receiverToggle.addEventListener('change', () => {
  receiverSelect.style.display = receiverToggle.checked ? 'none' : 'block';
  receiverCustom.style.display = receiverToggle.checked ? 'block' : 'none';
});

transmitterToggle.addEventListener('change', () => {
  transmitterSelect.style.display = transmitterToggle.checked ? 'none' : 'block';
  transmitterCustom.style.display = transmitterToggle.checked ? 'block' : 'none';
});

// Auto Send
document.getElementById('auto-send-checkbox').addEventListener('change', (e) => {
  if (e.target.checked) {
    const intervalMs = parseInt(document.getElementById('send-interval').value) || 1000;
    if (intervalMs < 100) {
      showToast('Aralık en az 100ms olmalıdır');
      e.target.checked = false;
      return;
    }
    
    autoSendInterval = setInterval(() => {
      if (lastTaggedData && isConnected) {
        socket.emit('send-manual', lastTaggedData);
      }
    }, intervalMs);
  } else {
    if (autoSendInterval) {
      clearInterval(autoSendInterval);
      autoSendInterval = null;
    }
  }
});

// Chart Initialization
function initializeChart() {
  const ctx = document.getElementById('dataChart').getContext('2d');
  dataChart = new Chart(ctx, {
    type: 'line',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index'
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            usePointStyle: true,
            padding: 15,
            font: {
              size: 12,
              family: "'-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', sans-serif"
            }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          padding: 12,
          titleFont: {
            size: 14
          },
          bodyFont: {
            size: 13
          }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          },
          ticks: {
            maxRotation: 45,
            minRotation: 0,
            font: {
              size: 11
            }
          }
        },
        y: {
          beginAtZero: true,
          grid: {
            color: 'rgba(0, 0, 0, 0.05)'
          },
          ticks: {
            font: {
              size: 11
            }
          }
        }
      },
      animation: {
        duration: 300
      }
    }
  });
}

// Chart Update
function updateChart(taggedData) {
  if (!dataChart) return;
  
  const parts = taggedData.split(', ');
  const currentTime = new Date().toLocaleTimeString('tr-TR');
  const colors = [
    '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', 
    '#10b981', '#06b6d4', '#ef4444', '#6366f1'
  ];

  parts.forEach((part, index) => {
    const [label, value] = part.split(':');
    const numericValue = parseFloat(value);

    if (!isNaN(numericValue)) {
      let dataset = chartData.datasets.find(ds => ds.label === label);
      
      if (!dataset) {
        const colorIndex = chartData.datasets.length % colors.length;
        dataset = {
          label: label,
          data: [],
          borderColor: colors[colorIndex],
          backgroundColor: colors[colorIndex] + '20',
          borderWidth: 2,
          fill: false,
          tension: 0.4,
          pointRadius: 3,
          pointHoverRadius: 5
        };
        chartData.datasets.push(dataset);
      }

      dataset.data.push(numericValue);
      if (dataset.data.length > 50) {
        dataset.data.shift();
      }
    }
  });

  chartData.labels.push(currentTime);
  if (chartData.labels.length > 50) {
    chartData.labels.shift();
    chartData.datasets.forEach(dataset => {
      if (dataset.data.length > 50) {
        dataset.data.shift();
      }
    });
  }

  dataChart.update('none');
}

function resetChart() {
  chartData.labels = [];
  chartData.datasets = [];
  if (dataChart) {
    dataChart.update();
  }
  showToast('Grafik sıfırlandı', 'success');
}

// Socket Event Handlers
socket.on('connection-status', (status) => {
  if (status.error) {
    showToast(status.error);
    updateConnectionStatus(false);
  } else {
    updateConnectionStatus(status.connected);
  }
});

socket.on('serial-data', (data) => {
  processSerialData(data);
});

socket.on('send-error', (error) => {
  showToast(error);
});

socket.on('connect', () => {
  console.log('Socket.io bağlantısı kuruldu');
});

socket.on('disconnect', () => {
  console.log('Socket.io bağlantısı kesildi');
  updateConnectionStatus(false);
});

// Test Mode Functions
function toggleTestMode() {
  testModeActive = !testModeActive;
  const testButton = document.getElementById('test-mode-button');
  
  if (testModeActive) {
    testButton.innerHTML = '<span class="btn-icon">⏹️</span><span>Test Durdur</span>';
    testButton.classList.add('connected');
    showToast('Test modu başlatıldı - Sahte veriler gönderiliyor', 'success');
    
    // Simulate connected state for UI
    updateConnectionStatus(true);
    
    // Start sending fake data
    sendFakeData();
    testInterval = setInterval(sendFakeData, 1000);
  } else {
    testButton.innerHTML = '<span class="btn-icon">🧪</span><span>Test Modu</span>';
    testButton.classList.remove('connected');
    
    if (testInterval) {
      clearInterval(testInterval);
      testInterval = null;
    }
    
    // Reset connection status if not actually connected
    if (!isConnected) {
      updateConnectionStatus(false);
    }
    
    showToast('Test modu durduruldu', 'success');
  }
}

function sendFakeData() {
  // Generate realistic fake sensor data
  const temperature = (20 + Math.random() * 15).toFixed(1);  // 20-35°C
  const humidity = (40 + Math.random() * 40).toFixed(0);      // 40-80%
  const pressure = (1000 + Math.random() * 30).toFixed(0);    // 1000-1030 hPa
  const light = (100 + Math.random() * 900).toFixed(0);       // 100-1000 lux
  
  // Format like Arduino would send: "A25.5,B60,C1013,D500"
  const fakeData = `A${temperature},B${humidity},C${pressure},D${light}`;
  
  // Simulate receiving data (same as socket.on('serial-data'))
  processSerialData(fakeData);
}

function processSerialData(data) {
  // Add to data container
  const div = document.createElement('div');
  div.textContent = `[${new Date().toLocaleTimeString('tr-TR')}] ${data}`;
  dataContainer.appendChild(div);
  dataContainer.scrollTop = dataContainer.scrollHeight;

  // Process tagged data
  const parts = data.split(',').map(p => p.trim());
  
  const configs = Array.from(document.querySelectorAll('#label-configs .label-row')).map(row => {
    const prefixInput = row.querySelector('.prefix-input');
    const labelInput = row.querySelector('.label-input');
    const prefix = prefixInput ? prefixInput.value.trim() : '';
    const label = labelInput ? labelInput.value.trim() : '';
    return { prefix, label };
  }).filter(cfg => cfg.prefix && cfg.label);

  if (configs.length > 0) {
    const tagged = configs.map(cfg => {
      const match = parts.find(p => p.startsWith(cfg.prefix));
      const value = match ? match.slice(cfg.prefix.length) : '---';
      return `${cfg.label}:${value}`;
    }).join(', ');

    taggedDataContainer.innerHTML = tagged
      .split(', ')
      .map(line => `<div>${line}</div>`).join('');

    lastTaggedData = tagged;
    updateChart(tagged);
  } else {
    taggedDataContainer.innerHTML = '<div style="color: var(--text-tertiary);">Etiket ayarlarını yapın</div>';
  }
}

// Enter key handlers
document.getElementById('send-input').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    sendData();
  }
});

receiverCustom.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !isConnected) {
    connectPorts();
  }
});

transmitterCustom.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !isConnected) {
    connectPorts();
  }
});

// Connection button
connectionButton.addEventListener('click', toggleConnection);

// Initialize
// Panel Management
let panelCounter = 0;

function initSortable() {
  const container = document.getElementById('panels-container');
  if (container && typeof Sortable !== 'undefined') {
    new Sortable(container, {
      handle: '.drag-handle',
      animation: 200,
      ghostClass: 'sortable-ghost',
      dragClass: 'sortable-drag',
      filter: '.panel-add-wrapper',
      onEnd: () => {
        savePanelOrder();
      }
    });
  }
}

function savePanelOrder() {
  const container = document.getElementById('panels-container');
  const panels = Array.from(container.querySelectorAll('.panel-item'));
  const order = panels.map(panel => panel.dataset.panelId);
  localStorage.setItem('panelOrder', JSON.stringify(order));
}

function loadPanelOrder() {
  const savedOrder = localStorage.getItem('panelOrder');
  if (!savedOrder) return;
  
  try {
    const order = JSON.parse(savedOrder);
    const container = document.getElementById('panels-container');
    const panels = Array.from(container.querySelectorAll('.panel-item'));
    const addButton = container.querySelector('.panel-add-wrapper');
    
    // Sort panels according to saved order
    order.forEach(panelId => {
      const panel = panels.find(p => p.dataset.panelId === panelId);
      if (panel && panel.parentNode) {
        container.insertBefore(panel, addButton);
      }
    });
  } catch (e) {
    console.error('Panel order yüklenemedi:', e);
  }
}

function showAddPanelModal() {
  const modal = document.getElementById('add-panel-modal');
  if (modal) {
    modal.classList.add('show');
  }
}

function closeAddPanelModal() {
  const modal = document.getElementById('add-panel-modal');
  if (modal) {
    modal.classList.remove('show');
  }
}

function addPanel(type) {
  const container = document.getElementById('panels-container');
  const addButton = container.querySelector('.panel-add-wrapper');
  panelCounter++;
  
  let panelHTML = '';
  let panelId = `${type}-panel-${panelCounter}`;
  
  switch(type) {
    case 'data':
      panelHTML = `
        <div class="card data-card panel-item" data-panel-id="${panelId}" data-panel-type="data">
          <div class="card-header">
            <div class="card-header-left">
              <div class="drag-handle" title="Sürükle">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 5h6M9 10h6M9 15h6M9 20h6"/>
                </svg>
              </div>
              <div>
                <h2>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                  </svg>
                  Gelen Veri ${panelCounter > 1 ? panelCounter : ''}
                </h2>
                <p class="card-subtitle">Seri porttan gelen ham veriler</p>
              </div>
            </div>
            <div class="card-actions">
              <button class="btn-icon-only" onclick="clearData('${panelId}-container')" title="Temizle">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                </svg>
              </button>
              <button class="btn-icon-only btn-delete" onclick="deletePanel('${panelId}')" title="Paneli Sil">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="card-content">
            <div id="${panelId}-container" class="data-display scrollable-content"></div>
          </div>
        </div>
      `;
      break;
    case 'tagged':
      panelHTML = `
        <div class="card data-card panel-item" data-panel-id="${panelId}" data-panel-type="tagged">
          <div class="card-header">
            <div class="card-header-left">
              <div class="drag-handle" title="Sürükle">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 5h6M9 10h6M9 15h6M9 20h6"/>
                </svg>
              </div>
              <div>
                <h2>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                  </svg>
                  Etiketlenmiş Veri ${panelCounter > 1 ? panelCounter : ''}
                </h2>
                <p class="card-subtitle">İşlenmiş veriler</p>
              </div>
            </div>
            <div class="card-actions">
              <button class="btn-icon-only" onclick="clearData('${panelId}-container')" title="Temizle">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                </svg>
              </button>
              <button class="btn-icon-only btn-delete" onclick="deletePanel('${panelId}')" title="Paneli Sil">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="card-content">
            <div id="${panelId}-container" class="data-display tagged-display scrollable-content"></div>
          </div>
        </div>
      `;
      break;
    case 'chart':
      panelHTML = `
        <div class="card chart-card panel-item" data-panel-id="${panelId}" data-panel-type="chart">
          <div class="card-header">
            <div class="card-header-left">
              <div class="drag-handle" title="Sürükle">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 5h6M9 10h6M9 15h6M9 20h6"/>
                </svg>
              </div>
              <div>
                <h2>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                  </svg>
                  Grafik ${panelCounter > 1 ? panelCounter : ''}
                </h2>
                <p class="card-subtitle">Verilerin grafiksel gösterimi</p>
              </div>
            </div>
            <div class="card-actions">
              <button class="btn-icon-only" onclick="resetChart('${panelId}')" title="Sıfırla">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="1 4 1 10 7 10"/>
                </svg>
              </button>
              <button class="btn-icon-only btn-delete" onclick="deletePanel('${panelId}')" title="Paneli Sil">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="card-content">
            <div class="chart-container scrollable-content">
              <canvas id="${panelId}-chart"></canvas>
            </div>
          </div>
        </div>
      `;
      break;
  }
  
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = panelHTML;
  const newPanel = tempDiv.firstElementChild;
  
  container.insertBefore(newPanel, addButton);
  closeAddPanelModal();
  initSortable(); // Reinitialize sortable
  savePanelOrder();
  
  // Initialize chart if needed
  if (type === 'chart') {
    // Chart initialization would go here if needed
  }
  
  showToast('Panel eklendi', 'success');
}

function deletePanel(panelId) {
  if (confirm('Bu paneli silmek istediğinize emin misiniz?')) {
    const panel = document.querySelector(`[data-panel-id="${panelId}"]`);
    if (panel) {
      // Don't allow deleting core panels
      if (panelId === 'data-panel' || panelId === 'tagged-panel' || panelId === 'chart-panel') {
        showToast('Ana paneller silinemez', 'error');
        return;
      }
      
      panel.style.animation = 'fadeOut 0.3s ease-out';
      setTimeout(() => {
        panel.remove();
        savePanelOrder();
        showToast('Panel silindi', 'success');
      }, 300);
    }
  }
}

// Close modal when clicking outside
document.addEventListener('click', (e) => {
  const modal = document.getElementById('add-panel-modal');
  if (modal && e.target === modal) {
    closeAddPanelModal();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadPorts();
  initializeChart();
  loadPanelOrder();
  
  // Initialize sortable after a short delay to ensure DOM is ready
  setTimeout(() => {
    initSortable();
  }, 100);
  
  // Periodically refresh port list
  setInterval(loadPorts, 30000); // Every 30 seconds
});