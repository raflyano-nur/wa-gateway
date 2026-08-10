# WhatsApp Gateway

Gateway berbasis [Baileys](https://github.com/WhiskeySockets/Baileys) untuk mengirim pesan WhatsApp (teks, file, atau gabungan keduanya) lewat REST API maupun dashboard web, lengkap dengan antrean pengiriman internal, auto-reconnect, dan panel admin untuk memantau status, log, serta pengaturan tanpa perlu edit file `.env` manual.

## Fitur

- **Login WhatsApp via scan QR** (multi-device), tanpa perlu WhatsApp Business API resmi.
- **Dashboard admin single-page** (`/`) — sidebar dengan tab Dashboard, Kirim Pesan, Broadcast, Terjadwal, Riwayat, Logs, dan Pengaturan, tanpa reload halaman.
  - Status koneksi real-time, QR code, badge versi & mode aplikasi (Production/Local Dev).
  - Tombol Test Chat dan Ganti Akun (logout + reset sesi).
  - Widget QR yang bisa di-embed (`/widget`) ke website lain lewat `<iframe>`.
- **Kirim pesan 3 mode** lewat dashboard maupun API:
  - Teks saja
  - File saja (gambar, video, audio, dokumen — tipe media terdeteksi otomatis dari MIME type)
  - File + caption (gabungan)
- **Broadcast** (tab Broadcast / `POST /api/broadcast`) — kirim satu pesan (teks/file/gabungan) ke banyak nomor sekaligus (dipisah koma atau baris baru), tetap lewat antrean internal supaya tidak flood.
- **Pesan terjadwal** (tab Terjadwal / `POST /api/schedule`) — jadwalkan pesan untuk dikirim otomatis pada waktu tertentu di masa depan; scheduler internal mengecek & mengirim pesan yang sudah jatuh tempo, bisa dibatalkan selama masih `pending`.
- **Riwayat pengiriman** (tab Riwayat / `GET /api/history`) — catatan setiap pesan yang dikirim (lewat form, API, broadcast, maupun terjadwal), lengkap dengan tujuan (masked), tipe, status, dan waktu.
- **Webhook pesan masuk** — set `WEBHOOK_URL` (opsional `WEBHOOK_SECRET`) supaya gateway mem-POST notifikasi JSON ke URL kamu setiap ada pesan WhatsApp masuk, cocok untuk bikin bot atau integrasi ke sistem lain.
- **REST API** (`/api/send`, `/api/send-file`, `/api/broadcast`, `/api/schedule`, `/api/history`, `/api/test-chat`, `/api/logout`, `/api/status`, `/api/qr`) — lihat dokumentasi interaktif di `/docs`.
- **Dokumentasi API interaktif** (`/docs`) — daftar endpoint, contoh `curl`, dan contoh response JSON per endpoint.
- **Log viewer** di dashboard (tab Logs) — baca `combined.log` / `error.log` / `whatsapp.log` langsung dari browser, dengan auto-refresh, tanpa perlu SSH ke server.
- **Pengaturan via web** (tab Pengaturan) — ubah konfigurasi `.env` (port, host, timeout, batas antrean, API key, webhook, dll) langsung dari dashboard. Perubahan otomatis disimpan ke `.env` dan **server restart sendiri** untuk menerapkannya; kalau port berubah, dashboard otomatis mengarahkan browser ke port baru.
- **Antrean pengiriman internal** dengan batas ukuran dan konkurensi, supaya kirim beruntun tidak saling tabrak.
- **Auto-reconnect** dengan backoff saat koneksi WhatsApp terputus.
- **Validasi nomor tujuan** — dicek dulu apakah terdaftar di WhatsApp sebelum dikirim, supaya gagal jelas alih-alih diam-diam gagal di sisi WhatsApp.
- **Logging terstruktur** (Winston) ke `logs/combined.log`, `logs/error.log`, dan `logs/whatsapp.log`.
- **Proteksi API key** opsional (`X-API-Key` / `x-api-key`) untuk semua endpoint `/api/*`. Tab Broadcast, Terjadwal, Riwayat, Logs, dan Pengaturan di dashboard selalu menampilkan form "Buka" (masukkan API key sekali per sesi browser) sebelum bisa diakses, karena berisi data/aksi yang lebih sensitif dibanding Kirim Pesan biasa.

## Instalasi

```bash
npm install
```

## Menjalankan

```bash
node server.js
```

Secara default server berjalan sesuai `PORT`/`HOST` di `.env` (default `3000` / `0.0.0.0`). Buka halaman utama, scan QR yang muncul menggunakan WhatsApp di ponsel, dan tunggu status berubah menjadi "terhubung".

## Deploy ke Production

Untuk deploy ke Railway dengan domain sendiri (push dari GitHub, auto-SSL, tanpa perlu urus VPS/Nginx manual), ikuti [DEPLOYMENT.md](DEPLOYMENT.md). Konfigurasi `LOG_DIR`/`DATA_DIR`/`WA_AUTH_DIR` bisa diarahkan ke Volume Railway supaya sesi WhatsApp & data tidak hilang tiap redeploy.

Kalau nanti pindah ke VPS sendiri (Oracle Cloud/DigitalOcean/Niagahoster Cloud VPS dkk), file `ecosystem.config.js` (PM2) dan `deploy/nginx-raflyano.online.conf` (Nginx reverse proxy) sudah disiapkan sebagai starting point.

## Konfigurasi (Environment Variables)

Semua variabel bisa diatur lewat file `.env`, **atau lewat tab Pengaturan di dashboard** (`/` → Pengaturan) — perubahan dari dashboard langsung menulis ke `.env` dan me-restart server otomatis.

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port HTTP server |
| `HOST` | `0.0.0.0` | Host bind server |
| `NODE_ENV` | `development` | Mode aplikasi (`development` / `production`), ditampilkan sebagai badge di dashboard |
| `APP_NAME` | `WhatsApp Gateway` | Nama aplikasi yang ditampilkan di judul halaman & dashboard |
| `APP_VERSION` | *(dari `package.json`)* | Versi aplikasi yang ditampilkan di dashboard & `/api/status`; bisa di-override tanpa mengubah `package.json` |
| `WA_AUTH_DIR` | `auth_info_baileys` | Folder penyimpanan sesi/kredensial WhatsApp |
| `WA_SESSION_NAME` | `wa-gateway-session` | Label sesi (referensi) |
| `LOG_DIR` | `./logs` | Folder file log (`combined.log`, `error.log`, `whatsapp.log`). Arahkan ke folder di volume persisten kalau deploy di platform dengan filesystem sementara (mis. Railway) |
| `DATA_DIR` | `./data` | Folder riwayat pesan & pesan terjadwal. Arahkan ke folder di volume persisten kalau deploy di platform dengan filesystem sementara |
| `API_KEY` | *(kosong)* | Kalau diisi, semua endpoint `/api/*` wajib menyertakan header `x-api-key`. Kalau kosong, endpoint API tidak diproteksi (tidak disarankan untuk production) |
| `TZ` | `Asia/Jakarta` | Timezone |
| `REQUEST_BODY_LIMIT` | `256kb` | Batas ukuran body request |
| `MAX_FILE_SIZE_BYTES` | `16777216` (16MB) | Batas ukuran file yang bisa diunggah lewat `/api/send-file` atau form |
| `MESSAGE_TIMEOUT_MS` | `15000` | Timeout pengiriman satu pesan |
| `LOGOUT_TIMEOUT_MS` | `15000` | Timeout proses logout akun |
| `SEND_CONCURRENCY` | `1` | Jumlah pesan yang diproses bersamaan |
| `MAX_QUEUE_SIZE` | `200` | Kapasitas maksimum antrean pengiriman |
| `RECONNECT_BASE_DELAY_MS` | `3000` | Delay awal sebelum reconnect |
| `RECONNECT_MAX_DELAY_MS` | `30000` | Delay maksimum reconnect (backoff) |
| `STATUS_POLL_INTERVAL_MS` | `5000` | Interval polling status di halaman web |
| `LOG_STATUS_CHECKS` | `false` | Log setiap request ke `/api/status` |
| `LOG_LEVEL` | `info` | Level log Winston |
| `WEBHOOK_URL` | *(kosong)* | URL tujuan POST setiap ada pesan WhatsApp masuk. Kosongkan untuk menonaktifkan webhook |
| `WEBHOOK_SECRET` | *(kosong)* | Dikirim sebagai header `x-webhook-secret` ke `WEBHOOK_URL`, untuk verifikasi di sisi penerima (opsional) |
| `MAX_BROADCAST_TARGETS` | `200` | Batas maksimum nomor tujuan per request broadcast |
| `SCHEDULER_INTERVAL_MS` | `15000` | Interval pengecekan pesan terjadwal yang sudah jatuh tempo |

## Halaman Web

### `GET /`
Dashboard admin single-page (tanpa reload), berisi 7 tab:

- **Dashboard** — status koneksi, QR code, tombol Test Chat & Ganti Akun, embed widget QR.
- **Kirim Pesan** — kirim pesan Teks Saja / File Saja / File + Teks langsung dari browser.
- **Broadcast** — kirim satu pesan ke banyak nomor sekaligus. Butuh API key.
- **Terjadwal** — buat, lihat, dan batalkan pesan yang dijadwalkan untuk dikirim nanti. Butuh API key.
- **Riwayat** — histori pesan yang sudah dikirim (form, API, broadcast, terjadwal) beserta statusnya. Butuh API key.
- **Logs** — baca log server (`combined` / `error` / `whatsapp`) dengan auto-refresh. Butuh API key.
- **Pengaturan** — ubah konfigurasi `.env` dari browser, otomatis restart server saat disimpan. Butuh API key.

> Tab yang "butuh API key" menampilkan form "Buka" — masukkan API key sekali, tersimpan di `sessionStorage` browser (bukan di server lain). Kalau `API_KEY` belum diset di server, cukup klik "Buka" tanpa mengisi apa pun.

### `GET /docs`
Dokumentasi API interaktif — daftar endpoint, parameter, contoh `curl`, dan contoh response JSON.

### `GET /widget`
Halaman ringan (untuk `<iframe>`) yang menampilkan status & QR code, cocok untuk di-embed ke website lain.

## REST API

Ringkasan endpoint (detail lengkap + contoh response ada di `/docs`):

| Method | Endpoint | Keterangan |
| --- | --- | --- |
| `GET` | `/api/status` | Status koneksi gateway (publik, tidak perlu API key) |
| `GET` | `/api/qr` | QR code aktif dalam bentuk data URL (publik) |
| `POST` | `/api/send` | Kirim pesan **teks saja** (JSON) |
| `POST` | `/api/send-file` | Kirim **file saja** atau **file + caption** (`multipart/form-data`) |
| `POST` | `/api/broadcast` | Kirim satu pesan ke banyak nomor sekaligus (butuh API key) |
| `POST` | `/api/schedule` | Buat pesan terjadwal (butuh API key) |
| `GET` | `/api/schedule` | Daftar pesan terjadwal & statusnya (butuh API key) |
| `DELETE` | `/api/schedule/:id` | Batalkan pesan terjadwal yang masih `pending` (butuh API key) |
| `GET` | `/api/history` | Riwayat pengiriman pesan (butuh API key) |
| `POST` | `/api/test-chat` | Kirim pesan uji ke nomor sendiri |
| `POST` | `/api/logout` | Logout akun aktif, hapus sesi lama, siapkan QR baru |
| `GET` | `/api/logs` | Baca log server (butuh API key) |
| `GET`/`POST` | `/api/settings` | Baca/ubah konfigurasi `.env` (butuh API key) |

Semua endpoint `/api/*` (kecuali `/api/status` dan `/api/qr`) butuh header `x-api-key` kalau `API_KEY` sudah diset di `.env`. Kalau `API_KEY` kosong, semua endpoint API bisa diakses tanpa header (tidak disarankan untuk production). Request dengan key yang tidak cocok akan mendapat response `401`.

### Webhook Pesan Masuk

Kalau `WEBHOOK_URL` diisi (lewat `.env` atau tab Pengaturan), setiap pesan WhatsApp masuk (bukan dari nomor sendiri) akan di-POST sebagai JSON ke URL tersebut:

```json
{
  "from": "628123456789@s.whatsapp.net",
  "fromMasked": "628***6789@s.whatsapp.net",
  "pushName": "Nama Kontak",
  "messageId": "3EB0C767...",
  "timestamp": 1786300000000,
  "type": "conversation",
  "text": "Isi pesan yang dikirim"
}
```

Kalau `WEBHOOK_SECRET` diisi, request akan menyertakan header `x-webhook-secret` supaya penerima bisa memverifikasi asal request.

### Contoh: kirim teks

```bash
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY dari .env>" \
  -d '{"number": "628123456789", "message": "Halo dari gateway"}'
```

### Contoh: kirim file + caption

```bash
curl -X POST http://localhost:3000/api/send-file \
  -H "x-api-key: <API_KEY dari .env>" \
  -F "number=628123456789" \
  -F "caption=Ini laporan bulanan" \
  -F "file=@/path/to/dokumen.pdf"
```

Nomor tujuan boleh ditulis dengan atau tanpa `+`/spasi/strip, akan dirapikan otomatis, dan divalidasi dulu apakah terdaftar di WhatsApp sebelum dikirim (response `422` kalau tidak terdaftar). Format JID custom (mengandung `@`) juga didukung langsung.

Response sukses (pola umum untuk semua endpoint `/api/*`):

```json
{
  "success": true,
  "message": "Pesan berhasil dikirim",
  "to": "628***6789",
  "requestId": "abc12345",
  "messageId": "...",
  "queueDelayMs": 12,
  "sendDurationMs": 340
}
```

### Contoh: broadcast ke banyak nomor

```bash
curl -X POST http://localhost:3000/api/broadcast \
  -H "x-api-key: <API_KEY dari .env>" \
  -F "numbers=628123456789,628987654321" \
  -F "message=Pengumuman untuk semua pelanggan"
```

### Contoh: jadwalkan pesan

```bash
curl -X POST http://localhost:3000/api/schedule \
  -H "x-api-key: <API_KEY dari .env>" \
  -F "number=628123456789" \
  -F "sendAt=2026-08-15T09:00:00.000Z" \
  -F "message=Selamat pagi! Ini pesan terjadwal."
```

## Struktur Folder

```
server.js                    # entry point aplikasi (routes, dashboard, API, WA socket)
public/                      # aset statis (widget-qr.html)
auth_info_baileys/           # sesi/kredensial WhatsApp (jangan di-commit)
logs/                        # file log (jangan di-commit)
data/
  message-history.json       # riwayat pengiriman pesan (jangan di-commit)
  scheduled-messages.json    # antrean pesan terjadwal (jangan di-commit)
  scheduled-uploads/         # file yang menunggu dikirim sesuai jadwal
```

## Catatan

- Folder `auth_info_baileys/` berisi kredensial sesi WhatsApp — jangan pernah di-commit atau dibagikan.
- Folder `data/` berisi riwayat pesan & pesan terjadwal (termasuk isi pesan dan file yang diunggah) — jangan di-commit atau dibagikan.
- Setelah scan QR, tunggu beberapa detik hingga status benar-benar "terhubung" sebelum mengirim pesan pertama, karena WhatsApp kadang meminta satu siklus reconnect otomatis di awal sesi baru.
- Tab **Broadcast**, **Terjadwal**, **Riwayat**, **Pengaturan**, dan **Logs** di dashboard menampilkan form "Buka" — masukkan API key sekali (kalau `API_KEY` sudah diset), tersimpan hanya di sesi browser (`sessionStorage`), tidak dikirim ke tempat lain.
- Saat menyimpan Pengaturan, server restart otomatis (~beberapa detik). Kalau port berubah, dashboard akan menunggu server aktif kembali lalu mengarahkan browser ke port baru secara otomatis.
- Pesan terjadwal hanya diproses saat WhatsApp dalam status terhubung — kalau gateway sedang terputus pas jatuh tempo, pesan tetap `pending` dan akan dikirim begitu koneksi pulih.

## Riwayat Pembaruan Fitur

Dokumen ini diperbarui setiap kali ada fitur baru ditambahkan ke gateway, supaya daftar fitur & konfigurasi di atas selalu sesuai dengan kode yang berjalan.
