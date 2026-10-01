# Penggunaan Gateway WhatsApp

Dokumen ini menjelaskan cara memakai gateway sebagai layanan independen yang dapat diakses dari aplikasi lain.

## 1. Akses dashboard

Setelah server berjalan, buka:

- http://localhost:3000/ untuk dashboard admin
- http://localhost:3000/login untuk login dashboard

Login dashboard hanya menggunakan URL website WhatsApp (`WA_WEBSITE_URL`) dan API key (`API_KEY`). Sistem ini tidak memakai akun user, username, atau password untuk login.

## 2. Menghubungkan akun WhatsApp

Pada dashboard:

1. masuk ke tab Dashboard atau Akun WAG
2. pilih tambah akun
3. scan QR menggunakan WhatsApp di ponsel
4. tunggu sesi terhubung

Setiap akun mempunyai session id yang dipakai saat mengirim pesan atau mengecek status tertentu.

## 3. Mengirim pesan teks

Endpoint utama:

```http
POST /api/send
```

Contoh body JSON:

```json
{
  "to": "6281234567890",
  "text": "Halo dari gateway WhatsApp",
  "session": "default"
}
```

Jika session tidak disediakan, sistem biasanya memakai akun utama.

## 4. Mengirim file

Endpoint:

```http
POST /api/send-file
```

Gunakan form-data seperti:

- file
- to
- caption
- session

Contoh curl:

```bash
curl -X POST http://localhost:3000/api/send-file \
  -F "to=6281234567890" \
  -F "caption=Ini file dari gateway" \
  -F "session=default" \
  -F "file=@/path/to/file.pdf"
```

## 5. Broadcast

Untuk mengirim ke banyak nomor sekaligus:

```http
POST /api/broadcast
```

Biasanya menerima daftar nomor dan satu pesan yang sama. Gunakan API key jika server memerlukannya.

## 6. Pesan terjadwal

Endpoint:

```http
POST /api/schedule
```

Gunakan ini untuk menjadwalkan pengiriman berdasarkan waktu tertentu, misalnya:

- reminder otomatis
- promosi di jam tertentu
- notifikasi transaksi

## 7. Cek status & QR

Endpoint publik:

```http
GET /api/status
GET /api/qr
GET /api/sessions
```

Endpoint ini berguna jika aplikasi lain ingin memeriksa apakah gateway masih hidup atau sedang menunggu QR login.

## 8. Menggunakan API key

Jika API_KEY diatur, semua endpoint yang sensitif wajib memakai header:

```http
x-api-key: YOUR_API_KEY
```

Contoh:

```bash
curl -X GET "http://localhost:3000/api/history" \
  -H "x-api-key: YOUR_API_KEY"
```

## 9. Webhook pesan masuk

Jika WEBHOOK_URL diisi, setiap pesan masuk akan dikirim ke URL target dalam format JSON. Gunakan WEBHOOK_SECRET jika ingin verifikasi asal request.

Contoh payload:

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

## 10. Penggunaan yang direkomendasikan

Untuk integrasi proyek lain, biasanya yang paling aman dan mudah adalah:

- jalankan gateway sebagai layanan terpisah
- gunakan satu aplikasi backend pusat untuk mengelola pesan
- panggil gateway melalui HTTP dari Laravel, Express, Python, atau project lain
- simpan session id di database aplikasi Anda jika anda memakai banyak akun
