# 🔌 Serial Web Viewer

[![CI](https://github.com/sahintaha/serial-web-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/sahintaha/serial-web-viewer/actions/workflows/ci.yml)
[![Live demo](https://img.shields.io/badge/demo-live-3b82f6)](https://sahintaha.github.io/serial-web-viewer/?demo)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

**Arduino ve gömülü cihazlar için gerçek zamanlı seri port monitörü.** Kurulum gerektirmeden tarayıcıda çalışır (Web Serial API). İsterseniz Node.js köprüsüyle de kullanabilirsiniz.

### 👉 [Canlı demo: sahintaha.github.io/serial-web-viewer](https://sahintaha.github.io/serial-web-viewer/?demo)

Donanımınız yoksa demo sahte sensör verisiyle açılır. Arduino'nuzu USB ile takıp **Tarayıcı** modunda **Bağlan**'a basarsanız gerçek veriniz görünür (Chrome / Edge).

| Açık tema | Koyu tema |
|:---:|:---:|
| <img src="docs/screenshots/light-theme.png" alt="Açık tema" width="420"> | <img src="docs/screenshots/dark-theme.png" alt="Koyu tema" width="420"> |

---

## ✨ Özellikler

- **3 bağlantı modu**
  - **Tarayıcı**: Web Serial API ile USB porta doğrudan bağlanır. Sunucu ve kurulum gerekmez.
  - **Sunucu**: Node.js + Socket.io köprüsü. Ayrı alıcı/verici port kullanılabilir ve birden fazla sekme aynı bağlantıyı paylaşır.
  - **Demo**: donanım olmadan sahte sensör verisi üretir.
- **Format algılama**: `A25.5,B60`, `temp:25;hum=60`, `{"temp":25}` ve düz `25,60` biçimlerini otomatik tanır.
- **Etiketleme**: anahtarları anlamlı adlara eşler (`A` → Sıcaklık). Tanımlanmamış alanlar da gösterilir.
- **Canlı grafik**: Chart.js ile son 100 ölçümü çizer. Eksik değerler boşluk olarak kalır, zaman ekseni kaymaz.
- **CSV dışa aktarma**: kaydedilen tüm satırları (en fazla 10.000) Excel'de açılabilen bir CSV olarak indirir.
- **Komut gönderme**: tek seferlik ya da belirli aralıklarla tekrarlanan komutlar gönderilebilir.
- **Ayarlanabilir panel düzeni**: paneller sürükle-bırak ile sıralanır, eklenip silinebilir. Düzen, etiketler, tema ve baud rate hatırlanır.
- **Performans**: gelen satırlar her animation frame'de toplu olarak çizilir ve ham log 500 satırla sınırlıdır; hızlı cihazlarda bile sayfa donmaz.
- **Güvenlik**: cihazdan gelen veri her zaman `textContent` ile basılır (XSS yok). Sunucu varsayılan olarak yalnızca `127.0.0.1` adresini dinler, girdiler doğrulanır.

## 🏗️ Mimari

```
                     ┌─────────── public/js ───────────┐
 USB ── Web Serial ─▶│ WebSerialTransport ┐            │
                     │ DemoTransport ─────┼─▶ parser ─▶│─▶ Panels (log, chips, chart, CSV)
 USB ── server.js ──▶│ ServerTransport ───┘  (pure)    │
       (Socket.io)   └─────────────────────────────────┘
```

| Dosya | Görev |
|---|---|
| `public/js/parser.js` | Satır ayrıştırma, satır bölme ve CSV üretimi. DOM'a dokunmayan saf fonksiyonlardır ve birim testleri vardır. |
| `public/js/transports.js` | Ortak arayüze sahip üç veri kaynağı: Web Serial, Socket.io ve Demo |
| `public/js/app.js` | Arayüz durumu, paneller ve grafik |
| `server.js` | Express + Socket.io köprüsü (`/health`, `/ports`) |

Frontend'de bundler veya framework yok; doğrudan tarayıcıda çalışan ES modülleri kullanılıyor. Bu sayede GitHub Pages'e olduğu gibi yüklenebiliyor.

## 🚀 Kurulum

### Sadece tarayıcı
[Canlı demoyu](https://sahintaha.github.io/serial-web-viewer/) açın, **Tarayıcı** modunu seçip **Bağlan**'a basın. Chrome veya Edge gerekir.

### Node.js köprüsü ile

```bash
git clone https://github.com/sahintaha/serial-web-viewer.git
cd serial-web-viewer
npm install
npm start
```

Ardından `http://localhost:3000` adresini açın. Ayarlar için `.env.example` dosyasını `.env` olarak kopyalayın:

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `3000` | Web arayüzünün HTTP portu |
| `HOST` | `127.0.0.1` | Dinlenecek arayüz. `0.0.0.0` yaparsanız ağdaki herkes cihazınıza yazabilir. |
| `BAUD_RATE` | `9600` | Varsayılan baud rate (arayüzden de değiştirilebilir) |

### Docker

```bash
docker compose up -d
```

Seri cihazı container'a vermek için `docker-compose.yml` içindeki `devices` bölümünü açın.

## 🔧 Arduino örneği

[`examples/arduino/sensor_stream`](examples/arduino/sensor_stream/sensor_stream.ino) her saniye `A<sıcaklık>,B<nem>,C<pot>,D<ışık>` satırını yollar ve arayüzden gelen `LED:ON`, `LED:OFF`, `RATE:500` komutlarına `ACK:` ile yanıt verir.

## 📡 Socket.io API (Sunucu modu)

| Yön | Olay | Veri |
|---|---|---|
| İstemci → Sunucu | `select-ports` | `{ receiverPath, transmitterPath?, baudRate }` |
| İstemci → Sunucu | `disconnect-ports` | — |
| İstemci → Sunucu | `send-manual` | `string` (en fazla 1024 karakter) |
| Sunucu → İstemci | `serial-data` | `string` (tek satır) |
| Sunucu → İstemci | `connection-status` | `{ connected, receiverPath, transmitterPath, baudRate, error? }` |
| Sunucu → İstemci | `send-error` | `string` |

REST uçları: `GET /ports` port listesini, `GET /health` ise `{ status, connected }` döndürür.

## 🧪 Geliştirme

```bash
npm run dev    # nodemon ile otomatik yeniden başlatma
npm test       # node:test — parser + sunucu testleri
npm run lint   # ESLint
```

Her push'ta GitHub Actions, Node 20 ve 22 üzerinde lint ve testleri çalıştırır. `main` dalına gelen değişiklikler `public/` klasörünü otomatik olarak GitHub Pages'e yayınlar.

## 📋 Yol haritası

- [x] Web Serial API ile sunucusuz mod ve canlı demo
- [x] CSV dışa aktarma
- [x] Docker desteği
- [x] Birim testleri ve CI
- [ ] HEX / binary görünüm
- [ ] Eşik alarmları ve gauge widget'ları
- [ ] Oturum kaydı ve tekrar oynatma
- [ ] MQTT köprüsü
- [ ] TypeScript'e geçiş

## 🐛 Sorun giderme

- **Tarayıcı modu pasif**: Firefox ve Safari Web Serial desteklemiyor. Chrome veya Edge kullanın ya da Sunucu modunu deneyin.
- **Port listede yok (Linux)**: `sudo usermod -a -G dialout $USER` komutunu çalıştırıp oturumu yeniden açın.
- **Clone Arduino (CH340)**: ilgili USB-serial sürücüsünü kurun.
- **Veri anlamsız karakterler**: baud rate'in Arduino kodundaki `Serial.begin(...)` değeriyle aynı olduğundan emin olun.

## 📄 Lisans

[MIT](LICENSE) © Taha Şahin
