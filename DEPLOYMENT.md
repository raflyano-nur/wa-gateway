# Deploy ke raflyano.online (Railway)

Panduan ini asumsinya kamu sudah punya domain `raflyano.online` di Niagahoster dan mau deploy lewat **Railway** (railway.app) — tidak perlu urus VPS/Nginx/SSL manual, tinggal push kode dan Railway yang jalanin.

Kenapa Railway cocok buat WA Gateway ini (yang harus nyala terus & pegang koneksi WebSocket ke WhatsApp): servicenya **tidak auto-sleep** kalau ada traffic aktif (beda sama Render free tier), dan mendukung WebSocket & proses long-running secara native. Yang perlu diperhatikan: filesystem Railway **sementara** (reset tiap redeploy) kecuali kamu pasang **Volume** — makanya sesi WhatsApp harus disimpan di volume supaya tidak perlu scan ulang QR tiap kali deploy.

## 1. Push project ke GitHub

Railway deploy dari repo GitHub. Kalau project ini belum ada di GitHub:

```bash
cd c:/www/projects/wa-gateway
git init                     # kalau belum ada repo git
git add .
git commit -m "Initial commit"
```

Buat repo baru di GitHub (lewat web), lalu:

```bash
git remote add origin <url-repo-github-kamu>
git branch -M main
git push -u origin main
```

> Pastikan `.env` **tidak ikut ke-push** (sudah ada di `.gitignore`) — isi environment variable nanti langsung di dashboard Railway, bukan lewat file.

## 2. Buat project di Railway

1. Daftar/login di [railway.app](https://railway.app) (bisa langsung pakai akun GitHub).
2. **New Project → Deploy from GitHub repo** → pilih repo `wa-gateway` kamu.
3. Railway otomatis mendeteksi ini project Node.js (dari `package.json`) dan akan menjalankan `npm install` lalu `npm start`. Tidak perlu setting build command manual.

## 3. Pasang Volume (biar sesi WhatsApp & data tidak hilang tiap redeploy)

Di service yang baru dibuat:

1. Buka tab **Settings** service → bagian **Volumes** → **New Volume**.
2. Mount path: `/app/storage`
3. Setelah volume terpasang, buka tab **Variables**, tambahkan:

| Variable | Value |
| --- | --- |
| `WA_AUTH_DIR` | `/app/storage/auth_info_baileys` |
| `LOG_DIR` | `/app/storage/logs` |
| `DATA_DIR` | `/app/storage/data` |

> `LOG_DIR` dan `DATA_DIR` ini fitur yang baru ditambahkan supaya folder `logs/` (log server) dan `data/` (riwayat pesan & pesan terjadwal) juga bisa diarahkan ke volume persisten — kalau tidak diset, keduanya tetap jalan normal tapi isinya reset tiap redeploy.

## 4. Set environment variable lain

Masih di tab **Variables**, tambahkan sisanya (samakan isinya dengan `.env` lokal kamu):

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_NAME` | `WhatsApp Gateway` |
| `API_KEY` | isi dengan key yang kuat |
| `TZ` | `Asia/Jakarta` |
| `HOST` | `0.0.0.0` |

**Jangan set `PORT` manual** — Railway inject port-nya sendiri secara otomatis lewat env var `PORT`, dan `server.js` sudah baca `process.env.PORT` secara default.

Klik **Deploy** (atau otomatis re-deploy setelah menyimpan variable).

## 5. Sambungkan domain raflyano.online

1. Di service Railway → tab **Settings → Networking → Custom Domain** → masukkan `raflyano.online` (ulangi juga untuk `www.raflyano.online` kalau mau keduanya aktif).
2. Railway akan menampilkan **CNAME record** yang harus kamu tambahkan (biasanya sesuatu seperti `xxxxx.up.railway.app`).
3. Buka panel Niagahoster → domain `raflyano.online` → **DNS Management**, tambahkan:

| Type | Host | Value |
| --- | --- | --- |
| `CNAME` | `www` | `<target dari Railway>` |
| `CNAME` atau `ALIAS`/`ANAME` | `@` | `<target dari Railway>` |

> Kalau Niagahoster tidak punya opsi `ALIAS`/`ANAME` untuk domain root (`@`), cek juga apakah mereka punya fitur "Domain Forwarding"/"URL Redirect" dari `raflyano.online` → `https://www.raflyano.online`, dan pakai `www.raflyano.online` sebagai alamat utama.

4. Tunggu propagasi DNS (5-30 menit). Railway otomatis pasang SSL (Let's Encrypt) begitu DNS terverifikasi — tidak perlu certbot manual.

## 6. Scan QR & selesai

Buka `https://raflyano.online` (atau `https://www.raflyano.online`), scan QR dengan WhatsApp seperti biasa. Karena sudah pakai Volume, kalau Railway redeploy/restart service, sesi WhatsApp tetap tersimpan — tidak perlu scan ulang.

## Catatan penting

- **Biaya**: Railway memberi kredit percobaan gratis ($5 saat akun baru), setelah habis kamu perlu tambah metode pembayaran (paket Hobby mulai ~$5/bulan, dihitung dari pemakaian resource). Ini bukan "gratis selamanya" seperti Oracle Always Free, tapi jauh lebih gampang setup-nya dan tidak ada isu verifikasi email seperti Oracle.
- Fitur **"Simpan Pengaturan"** di dashboard (yang otomatis restart server) sudah dibuat aman untuk Railway — server mendeteksi environment Railway dan tidak mencoba bikin proses duplikat, cukup exit lalu biarkan Railway yang restart container-nya.
- Kalau butuh cek log mentah dari sisi platform (bukan dari tab Logs dashboard), pakai tab **Deployments → View Logs** di Railway.

## Update aplikasi di masa depan (auto-deploy)

Railway otomatis redeploy setiap ada `git push` ke branch yang di-deploy (default `main`) — tidak perlu login ke Railway atau klik apa pun secara manual:

```bash
git add .
git commit -m "Update fitur X"
git push
```

Yang perlu diketahui soal auto-deploy ini:

- **Branch yang dipantau** bisa diatur di **Settings → Service → Source → Branch** kalau mau ganti dari `main` ke branch lain.
- **Bisa dimatikan sementara** lewat toggle "Auto Deploy" di halaman yang sama — berguna kalau lagi eksperimen di banyak commit dan belum mau semuanya langsung live.
- Setiap redeploy = **container baru dibuat dari awal** (`npm install` fresh), tapi isi **Volume tetap dipakai bareng** (bukan ikut direset) — jadi sesi WhatsApp, log, dan riwayat pesan yang disimpan di `/app/storage` tetap ada setelah update.
- Ada jeda beberapa detik–menit (tergantung durasi build) sebelum versi baru live — selama proses ini versi lama tetap jalan dulu, baru di-switch begitu build sukses (jadi tidak ada downtime kalau deploy-nya berhasil). Kalau build gagal, Railway tetap menjalankan versi lama dan kasih notifikasi error di dashboard.
- Progress build & deploy bisa dipantau real-time di tab **Deployments**.

Railway otomatis mendeteksi push baru dan redeploy. Sesi WhatsApp & data tetap aman karena tersimpan di Volume.
