# Instalasi Gateway WhatsApp

Dokumen ini menjelaskan cara menginstal dan menjalankan gateway agar bisa dipakai oleh project lain.

## Persyaratan

- Node.js >= 22.5.0
- npm
- akses internet untuk instalasi dependency
- folder writable untuk data dan log
- device/host yang bisa menjalankan WhatsApp session secara normal

## 1. Clone atau masuk ke project

```bash
cd c:/path/to/wa-gateway
```

## 2. Install dependency

```bash
npm install
```

## 3. Siapkan environment

Salin file .env.example jika ada. Jika tidak, buat file .env baru di root project dengan minimal konfigurasi seperti berikut:

```env
PORT=3000
HOST=0.0.0.0
NODE_ENV=development
APP_NAME=WhatsApp Gateway
TZ=Asia/Jakarta
WA_AUTH_DIR=./auth_info_baileys
DATA_DIR=./data
LOG_DIR=./logs
MAX_ACCOUNTS=3
WA_WEBSITE_URL=https://wa.example.com
API_KEY=
CENTRIFUGO_API_URL=http://localhost:8000/api
CENTRIFUGO_API_KEY=
CENTRIFUGO_WS_URL=ws://localhost:8000/connection/websocket
CENTRIFUGO_CHANNEL=wa-gateway:admin
WEBHOOK_URL=
WEBHOOK_SECRET=
```

Catatan:

- isi API_KEY jika ingin melindungi endpoint /api/\* dari akses yang tidak berwenang
- isi WA_WEBSITE_URL dengan URL website WhatsApp yang harus diketik saat login dashboard
- login dashboard hanya memakai pasangan WA_WEBSITE_URL dan API_KEY; username/password tidak digunakan
- isi konfigurasi CENTRIFUGO jika ingin status sesi dan riwayat diperbarui realtime; channel tersebut harus mengizinkan subscribe dari dashboard
- kosongkan WEBHOOK_URL jika tidak digunakan
- pilih folder persistens agar sesi WhatsApp tidak hilang saat restart server

## 4. Jalankan server

```bash
npm start
```

Atau untuk mode development:

```bash
node server.js
```

## 5. Verifikasi server sudah hidup

Buka browser ke:

- http://localhost:3000
- http://localhost:3000/api/status

Endpoint /api/status biasanya menampilkan status gateway dan metadata dasar.

## 6. Login dashboard

Buka `http://localhost:3000/login`, lalu masukkan URL website WhatsApp sesuai `WA_WEBSITE_URL` dan nilai `API_KEY` yang sama.

## 7. Siapkan akun WhatsApp

- login sebagai admin atau user yang sesuai
- tambahkan akun WhatsApp baru dari dashboard
- scan QR yang muncul
- tunggu status berubah menjadi terhubung

## 8. Deployment untuk project lain

Untuk proyek produksi, sebaiknya:

- gunakan process manager seperti PM2
- simpan session dan data di volume yang persistent
- aktifkan API key
- batasi akses via reverse proxy atau firewall
- simpan log ke folder khusus untuk monitoring

## Catatan penting

Gateway ini sebaiknya dijalankan sebagai layanan terpisah dari aplikasi utama Anda. Dengan cara ini:

- aplikasi frontend atau backend lain tidak perlu ikut mengelola session WhatsApp
- API dapat dipanggil secara terpisah dan lebih aman
- kontrak integrasi lebih konsisten antara proyek dan gateway
