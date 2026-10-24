# Dokumentasi Gateway WhatsApp

Dokumen ini dipisah menjadi beberapa bagian agar lebih mudah digunakan oleh tim backend yang ingin mengintegrasikan gateway ini ke proyek lain.

## Daftar dokumen

- [Instalasi](INSTALLATION.md) — langkah menyiapkan server gateway dari nol
- [Penggunaan](USAGE.md) — cara mengakses dashboard, API, dan fitur umum
- [Integrasi dengan backend lain](INTEGRATION.md) — contoh integrasi dengan Laravel, Express, Python, dan backend lain

## Ringkasan cepat

Gateway ini adalah server WhatsApp berbasis Baileys yang dapat dipakai sebagai layanan terpisah dari aplikasi utama. Proyek lain cukup memanggil endpoint HTTP untuk:

- mengirim pesan teks
- mengirim file dan caption
- menyiapkan akun WhatsApp multi-session
- cek status dan QR
- broadcast ke banyak tujuan
- jadwalkan pengiriman
- menerima webhook saat ada pesan masuk

Semua komunikasi antar proyek dapat dilakukan melalui HTTP dan JSON, sehingga tidak tergantung pada bahasa backend tertentu.
