# WhatsApp Gateway

Gateway berbasis [Baileys](https://github.com/WhiskeySockets/Baileys) untuk mengirim pesan WhatsApp (teks, file, atau gabungan keduanya) lewat REST API maupun dashboard web, lengkap dengan antrean pengiriman internal, auto-reconnect, dan panel admin untuk memantau status, log, serta pengaturan tanpa perlu edit file `.env` manual.

## Fitur

- **Login WhatsApp via scan QR** (multi-device), tanpa perlu WhatsApp Business API resmi.
- **Multi-akun WhatsApp** — hubungkan lebih dari satu nomor WhatsApp sekaligus ke gateway yang sama, masing-masing dengan sesi, antrean pengiriman, dan QR sendiri-sendiri. Batas jumlah akun diatur lewat `MAX_ACCOUNTS` (default 3), bisa diubah di tab Pengaturan. Semua endpoint pengiriman (`/api/send`, `/api/send-file`, `/api/broadcast`, `/api/schedule`, `/api/test-chat`, `/api/logout`, `/api/status`, `/api/qr`) menerima parameter opsional `session` (nama/ID akun) untuk memilih akun pengirim — kalau tidak diisi, pakai akun utama.
- **Dashboard admin single-page** (`/`) — sidebar dengan tab Dashboard, Kirim Pesan, Broadcast, Terjadwal, Riwayat, Logs, dan Pengaturan, tanpa reload halaman.
  - Tab Dashboard menampilkan kartu per akun WhatsApp (status, QR, tombol Test Chat/Ganti Akun/Hapus) plus tombol "+ Tambah Akun".
  - Form Kirim Pesan, Broadcast, dan Terjadwal punya pilihan "Kirim Dari Akun" untuk memilih akun WhatsApp mana yang mengirim.
  - Badge versi & mode aplikasi (Production/Local Dev) di sidebar.
  - Widget QR yang bisa di-embed (`/widget`, atau `/widget?session=ID` untuk akun tertentu) ke website lain lewat `<iframe>`.
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
| `WA_AUTH_DIR` | `auth_info_baileys` | Folder induk penyimpanan sesi/kredensial WhatsApp. Akun utama memakai folder ini langsung; akun tambahan dapat subfolder `WA_AUTH_DIR/<id-akun>` masing-masing |
| `WA_SESSION_NAME` | `wa-gateway-session` | Label sesi (referensi) |
| `MAX_ACCOUNTS` | `3` | Batas maksimum akun WhatsApp yang bisa terhubung bersamaan (server-wide, admin + semua user) |
| `ADMIN_USERNAME` | `admin` | Username admin default, dibuat otomatis saat pertama kali server jalan (kalau belum ada admin sama sekali) |
| `ADMIN_PASSWORD` | *(random)* | Password admin default. Kalau kosong, di-generate acak & ditampilkan sekali di console log saat server pertama kali jalan — segera login lalu ganti lewat tab Pengaturan → Kelola Admin |
| `DEFAULT_USER_MAX_ACCOUNTS` | `1` | Kuota akun WAG gratis untuk user baru yang daftar sendiri. Admin bisa naikkan per-user di tab Pengguna |
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

## Multi-User: Registrasi, Login, & Approval

Gateway ini punya dua peran terpisah, masing-masing dengan portal & login sendiri (cookie session, terpisah dari `API_KEY` yang dipakai endpoint `/api/send` dkk):

- **Admin** — akses penuh: kelola semua akun WAG (termasuk milik user), approve/reject permintaan akun baru, atur kuota tiap user, kelola akun admin lain. Login di `/login`.
- **User** — daftar sendiri di `/app/login` (tab "Daftar"), lalu login untuk masuk ke portal-nya sendiri di `/app`. Cuma bisa lihat & kelola akun WAG miliknya sendiri.

Alur bikin akun WAG oleh user:
1. User daftar (username, password, nomor HP) → langsung bisa login, tidak perlu approval untuk registrasinya.
2. Di `/app`, user klik "+ Request Akun WAG" dan isi nama akun (opsional) — nomor HP tujuan otomatis dipakai dari nomor yang diisi saat daftar, tidak ditanya lagi. Permintaan berstatus **menunggu persetujuan** — belum ada sesi/QR yang dibuat.
3. Admin buka tab **Persetujuan** di dashboard (`/`), approve atau tolak (dengan alasan) permintaan itu.
4. Setelah di-approve, sistem baru membuat sesi WhatsApp & QR untuk akun tersebut — user tinggal buka `/app` lagi untuk scan.

**Paket, kuota, & masa berlaku** — 3 tingkat, ditentukan `PLAN_DEFS` di `server.js`. Harga Pro/Max diatur admin lewat dashboard (bukan hardcode):

| Paket | Akun WAG | Pesan/hari | Masa berlaku | Harga |
| --- | --- | --- | --- | --- |
| Free (default) | 1 | 10 | Tidak ada batas | Gratis |
| Pro | 3 | 200 | 30 hari sejak diaktifkan | Diatur admin (tab Persetujuan) |
| Max | 10 | 1000 | 30 hari sejak diaktifkan | Diatur admin (tab Persetujuan) |

Kuota pesan/hari dihitung dari `message_history` (semua pesan yang dikirim lewat akun WAG milik user itu, baik dari portal `/app` maupun API). Tanggal kadaluarsa (`planExpiresAt`) dihitung ulang tiap kali admin mengganti paket user (30 hari ke depan untuk Pro/Max). Scheduler internal (interval `SCHEDULER_INTERVAL_MS`, sama dengan yang dipakai pesan terjadwal) mengecek berkala dan **otomatis menurunkan user ke Free** begitu `planExpiresAt` lewat, plus kirim notifikasi WhatsApp ke user kalau notifikasi otomatis sudah dikonfigurasi.

Alur upgrade (mirip alur "pilih paket → halaman detail → chat admin" ala platform patungan):
1. User klik salah satu paket di section **Paket Langganan** pada `/app` → pindah ke halaman detail `GET /app/upgrade/:plan` (`pro` atau `max`).
2. Halaman itu menampilkan detail paket (harga, kuota akun, kuota pesan/hari, masa berlaku) dan langkah-langkah upgrade: chat admin → admin kirim info rekening → user transfer → **user kirim bukti pembayaran lewat chat WhatsApp yang sama** → admin verifikasi & aktifkan paket.
3. Tombol **"Chat Admin di WhatsApp"** di halaman itu: mencatat permintaan (`pendingPlanRequest`, muncul sebagai badge kuning di tab Pengguna admin) lalu membuka tab WhatsApp baru ke nomor admin dengan **pesan chat yang sudah terisi otomatis** (username, no HP, paket & harga yang diminta) — user tinggal cek & kirim.
4. Setelah user bayar secara manual dan kirim bukti lewat chat itu (**tidak ada payment gateway**), admin konfirmasi dengan mengganti paket user di tab **Pengguna**; kuota akun, kuota pesan/hari, & tanggal kadaluarsa otomatis ikut ter-set sesuai paket yang dipilih.

**Auto-reply metode pembayaran (bot di WA admin)** — diatur di tab Persetujuan, section "Metode Pembayaran & Auto-Reply": isi nomor DANA, nomor rekening Mandiri, & upload gambar QRIS. Begitu "Akun Pengirim Notifikasi" (nomor WA admin, biasa dipakai WA Business) menerima chat yang menyebut *"upgrade paket"* (persis cocok dengan template pesan yang dikirim dari `/app/upgrade/:plan`), bot otomatis:
1. Balas menu: *"Baik kak, silakan pilih metode pembayarannya: 1. DANA 2. QRIS 3. Bank Mandiri"*.
2. User balas angka/nama metode → bot kirim detail pembayaran yang sesuai (nomor DANA/rekening Mandiri, atau gambar QRIS).
3. Chat lain yang tidak menyebut "upgrade paket" **tidak ikut dibalas** — supaya tidak mengganggu percakapan WhatsApp Business normal di nomor yang sama.

Belum punya QRIS? Bisa dibuat gratis lewat aplikasi DANA/OVO/GoPay (cari menu "QRIS Bisnis"/"Terima Uang" di aplikasinya) atau lewat mobile banking Mandiri (Livin' Merchant) — setelah dapat gambarnya, tinggal upload di section ini.

**Notifikasi WhatsApp otomatis** (opsional): di tab Persetujuan, admin bisa pilih satu akun WAG yang sudah terhubung sebagai "Akun Pengirim Notifikasi" dan isi nomor WA admin. Setelah dikonfigurasi, sistem otomatis kirim pesan WhatsApp ke admin saat ada permintaan akun WAG baru maupun permintaan upgrade paket, dan ke user saat permintaan akun WAG-nya di-approve/ditolak.

**Login admin pertama kali**: kalau belum ada admin sama sekali, server otomatis membuat satu admin default saat pertama kali dijalankan — cek console log saat startup untuk username & password-nya (lihat variabel `ADMIN_USERNAME`/`ADMIN_PASSWORD` di tabel konfigurasi). Segera login dan ganti password lewat tab Pengaturan → Kelola Admin.

## Halaman Web

### `GET /`
Dashboard admin single-page (tanpa reload, wajib login admin — redirect ke `/login` kalau belum), berisi 9 tab:

- **Dashboard** — kartu per akun WhatsApp (status, QR, Test Chat/Ganti Akun/Hapus), tombol "+ Tambah Akun" (dibatasi `MAX_ACCOUNTS`), embed widget QR.
- **Kirim Pesan** — kirim pesan Teks Saja / File Saja / File + Teks langsung dari browser, pilih akun pengirim.
- **Broadcast** — kirim satu pesan ke banyak nomor sekaligus dari akun pilihan. Butuh API key.
- **Terjadwal** — buat, lihat, dan batalkan pesan yang dijadwalkan untuk dikirim nanti dari akun pilihan. Butuh API key.
- **Riwayat** — histori pesan yang sudah dikirim (form, API, broadcast, terjadwal) dari semua akun beserta statusnya. Butuh API key.
- **Logs** — baca log server (`combined` / `error` / `whatsapp`) dengan auto-refresh. Butuh API key.
- **Pengaturan** — ubah konfigurasi `.env` dari browser (otomatis restart server saat disimpan), termasuk Kelola Admin (tambah/hapus akun admin, ganti password). Butuh API key.
- **Persetujuan** — approve/reject permintaan akun WAG baru dari user, plus konfigurasi notifikasi WhatsApp otomatis.
- **Pengguna** — daftar user terdaftar, jumlah akun WAG & pesan terkirim hari ini, dropdown ganti paket (Free/Pro/Max — naikkan di sini setelah user konfirmasi bayar manual), tanggal kadaluarsa paket (merah kalau sudah lewat), badge kalau user sudah minta upgrade sendiri, hapus user.

> Tab yang "butuh API key" menampilkan form "Buka" — masukkan API key sekali, tersimpan di `sessionStorage` browser (bukan di server lain). Kalau `API_KEY` belum diset di server, cukup klik "Buka" tanpa mengisi apa pun. Ini terpisah dari login admin (cookie session) yang melindungi dashboard secara keseluruhan.

### `GET /login`, `GET /app/login`, `GET /app`, `GET /app/upgrade/:plan`
`/login` — form login admin. `/app/login` — form login/daftar untuk user. `/app` — portal user (wajib login, redirect ke `/app/login` kalau belum), pakai layout sidebar yang sama gayanya dengan dashboard admin, berisi 5 tab:

- **Akun WAG** — kartu status akun WAG miliknya (scan QR, hapus, request akun baru sesuai kuota paket).
- **Kirim Pesan** — kirim pesan teks langsung dari akun WAG miliknya sendiri, dibatasi kuota pesan/hari sesuai paket.
- **Paket Langganan** — 3 kartu (Free/Pro/Max) dengan harga & masa berlaku; klik "Upgrade" pindah ke `/app/upgrade/pro` atau `/app/upgrade/max`. Kartu paket aktif menampilkan tanggal kadaluarsa.
- **Embed Widget QR** — kode `<iframe>` untuk akun WAG miliknya, sama seperti di dashboard admin.
- **Dokumentasi API** — versi ringkas dari `/docs` khusus buat user: cuma menjelaskan 2 endpoint publik yang relevan buat mereka (`GET /api/status?session=...` & `GET /api/qr?session=...`, dipakai kalau mau cek status/QR akun WAG-nya dari sistem lain), lengkap dengan daftar Session ID akun WAG miliknya & contoh `curl` siap-salin. Tidak menampilkan endpoint pengiriman pesan (`/api/send` dkk) yang pakai API key admin — beda dari `/docs` yang isinya lengkap untuk admin.

`/app/upgrade/:plan` — halaman detail paket yang dipilih: harga, kuota, masa berlaku, langkah-langkah upgrade (chat admin → transfer → kirim bukti pembayaran via WA → admin verifikasi), dan tombol "Chat Admin di WhatsApp" yang mencatat permintaan sekaligus membuka `wa.me` dengan pesan konfirmasi yang sudah terisi otomatis.

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
| `GET` | `/api/sessions` | Daftar akun WhatsApp yang terhubung (publik) |
| `POST` | `/api/sessions` | Tambah akun WhatsApp baru (publik, dibatasi `MAX_ACCOUNTS`) |
| `DELETE` | `/api/sessions/:id` | Hapus akun WhatsApp (publik, minimal 1 akun tersisa) |
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

Semua endpoint `/api/*` (kecuali `/api/status`, `/api/qr`, dan `/api/sessions`) butuh header `x-api-key` kalau `API_KEY` sudah diset di `.env`. Kalau `API_KEY` kosong, semua endpoint API bisa diakses tanpa header (tidak disarankan untuk production). Request dengan key yang tidak cocok akan mendapat response `401`.

Endpoint pengiriman/status (`/api/send`, `/api/send-file`, `/api/broadcast`, `/api/schedule`, `/api/test-chat`, `/api/logout`, `/api/status`, `/api/qr`) menerima parameter opsional `session` (body untuk `POST`, query string untuk `GET`) berisi `id` akun dari `GET /api/sessions` — kalau tidak diisi, pakai akun utama (`default`).

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
auth_info_baileys/           # sesi/kredensial WhatsApp — akun utama (jangan di-commit)
  <id-akun>/                 # sesi/kredensial akun tambahan, satu folder per akun
logs/                        # file log (jangan di-commit)
data/
  wa-gateway.db               # SQLite: daftar akun, riwayat pesan, & pesan terjadwal (jangan di-commit)
  scheduled-uploads/          # file yang menunggu dikirim sesuai jadwal
```

Catatan migrasi: kalau folder `data/` masih berisi `sessions.json` / `message-history.json` / `scheduled-messages.json` dari versi lama, isinya otomatis dipindah ke `wa-gateway.db` sekali saat server pertama kali dijalankan setelah upgrade. File JSON lama diganti nama jadi `*.migrated` sebagai cadangan, bukan dihapus.

## Catatan

- Folder `auth_info_baileys/` (dan subfoldernya per akun tambahan) berisi kredensial sesi WhatsApp — jangan pernah di-commit atau dibagikan.
- Folder `data/` berisi database SQLite (`wa-gateway.db`) dengan daftar akun, riwayat pesan, & pesan terjadwal (termasuk isi pesan dan file yang diunggah) — jangan di-commit atau dibagikan.
- Setelah scan QR, tunggu beberapa detik hingga status benar-benar "terhubung" sebelum mengirim pesan pertama, karena WhatsApp kadang meminta satu siklus reconnect otomatis di awal sesi baru.
- Instalasi lama (sebelum fitur multi-akun) otomatis bermigrasi: kredensial yang sudah ada di `auth_info_baileys/` dijadikan akun "Akun Utama" (`id: default`) apa adanya saat pertama kali dijalankan dengan kode baru — tidak perlu scan ulang QR.
- Tab **Broadcast**, **Terjadwal**, **Riwayat**, **Pengaturan**, dan **Logs** di dashboard menampilkan form "Buka" — masukkan API key sekali (kalau `API_KEY` sudah diset), tersimpan hanya di sesi browser (`sessionStorage`), tidak dikirim ke tempat lain.
- Saat menyimpan Pengaturan, server restart otomatis (~beberapa detik). Kalau port berubah, dashboard akan menunggu server aktif kembali lalu mengarahkan browser ke port baru secara otomatis.
- Pesan terjadwal hanya diproses saat akun pengirimnya dalam status terhubung — kalau akun itu sedang terputus pas jatuh tempo, pesan tetap `pending` dan akan dikirim begitu koneksi akun tersebut pulih.

## Riwayat Pembaruan Fitur

Dokumen ini diperbarui setiap kali ada fitur baru ditambahkan ke gateway, supaya daftar fitur & konfigurasi di atas selalu sesuai dengan kode yang berjalan.
