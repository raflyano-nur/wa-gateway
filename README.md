# WhatsApp Gateway

Gateway sederhana berbasis [Baileys](https://github.com/WhiskeySockets/Baileys) untuk mengirim pesan WhatsApp lewat HTTP API atau form web, dengan antrean pengiriman internal dan auto-reconnect.

## Fitur

- Login WhatsApp via scan QR (multi-device), tanpa perlu WhatsApp Business API resmi.
- Halaman web untuk memantau status koneksi, melihat QR, dan mengganti akun.
- Form web (`/send-form`) untuk kirim pesan manual.
- REST API (`/api/send`) untuk kirim pesan dari aplikasi lain.
- Antrean pengiriman internal dengan batas ukuran dan konkurensi, supaya kirim beruntun tidak saling tabrak.
- Auto-reconnect dengan backoff saat koneksi WhatsApp terputus.
- Logging terstruktur (Winston) ke `logs/combined.log`, `logs/error.log`, dan `logs/whatsapp.log`.

## Instalasi

```bash
npm install
```

## Menjalankan

```bash
node server.js
```

Secara default server berjalan di `http://localhost:3000`. Buka halaman utama, scan QR yang muncul menggunakan WhatsApp di ponsel, dan tunggu status berubah menjadi "terhubung".

## Konfigurasi (Environment Variables)

Semua variabel opsional, bisa diatur lewat file `.env`:

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port HTTP server |
| `HOST` | `0.0.0.0` | Host bind server |
| `WA_AUTH_DIR` | `auth_info_baileys` | Folder penyimpanan sesi/kredensial WhatsApp |
| `REQUEST_BODY_LIMIT` | `256kb` | Batas ukuran body request |
| `MESSAGE_TIMEOUT_MS` | `15000` | Timeout pengiriman satu pesan |
| `LOGOUT_TIMEOUT_MS` | `15000` | Timeout proses logout akun |
| `RECONNECT_BASE_DELAY_MS` | `3000` | Delay awal sebelum reconnect |
| `RECONNECT_MAX_DELAY_MS` | `30000` | Delay maksimum reconnect (backoff) |
| `STATUS_POLL_INTERVAL_MS` | `5000` | Interval polling status di halaman web |
| `MAX_QUEUE_SIZE` | `200` | Kapasitas maksimum antrean pengiriman |
| `SEND_CONCURRENCY` | `1` | Jumlah pesan yang diproses bersamaan |
| `LOG_STATUS_CHECKS` | `false` | Log setiap request ke `/api/status` |
| `LOG_LEVEL` | `info` | Level log Winston |

## Endpoint

### `GET /`
Halaman utama: status koneksi, QR code, dan tombol ganti akun.

### `GET /send-form`
Form web untuk kirim pesan manual.

### `POST /send-message`
Kirim pesan dari form web (`application/x-www-form-urlencoded`).

Body: `number`, `message`

### `POST /api/send`
Kirim pesan lewat API (JSON).

```bash
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -d '{"number": "628123456789", "message": "Halo dari gateway"}'
```

Response sukses:

```json
{
  "success": true,
  "message": "Pesan berhasil dikirim",
  "to": "628***6789@s.whatsapp.net",
  "requestId": "abc12345",
  "messageId": "...",
  "queueDelayMs": 12,
  "sendDurationMs": 340
}
```

Nomor tujuan boleh ditulis dengan atau tanpa `+`/spasi/strip, akan dirapikan otomatis. Format JID custom (mengandung `@`) juga didukung langsung.

### `POST /api/logout`
Logout akun WhatsApp yang sedang aktif, hapus sesi lama, dan siapkan QR untuk akun baru.

### `GET /api/status`
Status gateway saat ini (JSON): status koneksi, panjang antrean, percobaan reconnect, dll.

### `GET /api/qr`
QR code aktif dalam bentuk data URL (jika tersedia).

## Struktur Folder

```
server.js              # entry point aplikasi
auth_info_baileys/      # sesi/kredensial WhatsApp (jangan di-commit)
logs/                    # file log (jangan di-commit)
```

## Catatan

- Folder `auth_info_baileys/` berisi kredensial sesi WhatsApp — jangan pernah di-commit atau dibagikan.
- Setelah scan QR, tunggu beberapa detik hingga status benar-benar "terhubung" sebelum mengirim pesan pertama, karena WhatsApp kadang meminta satu siklus reconnect otomatis di awal sesi baru.
