# Integrasi dengan Backend Lain

Dokumen ini menjelaskan cara memakai gateway WhatsApp ini dari aplikasi lain seperti Laravel, Express, Python, atau backend apapun yang bisa mengirim HTTP request.

## 1. Prinsip arsitektur

Gateway ini berjalan sebagai layanan terpisah. Aplikasi utama Anda tidak perlu menghubungkan langsung ke Baileys atau menyimpan file auth WhatsApp.

Pola yang benar:

1. Backend Anda mengirim request ke gateway via HTTP.
2. Gateway memproses pengiriman ke WhatsApp menggunakan session yang sudah terhubung.
3. Anda tetap menjaga API key, user identity, dan log bisnis di aplikasi utama.

## 2. Keamanan dan autentikasi

Server ini mempunyai 3 pola auth yang penting:

- Global API key admin: `X-API-Key` untuk sebagian endpoint `/api` bila `API_KEY` di `.env` aktif.
- User API key: `X-API-Key` untuk endpoint `/api/external/*`.
- Session user/admin: cookie session untuk dashboard dan portal protected routes.

Jadi, untuk integrasi dari backend lain, pola yang disarankan adalah:

- Gunakan endpoint `/api/external/*` untuk integrasi otomatis dari app lain.
- Kirim header `X-API-Key` dengan key user yang valid.
- Jika gateway tidak punya `API_KEY`, global key tidak diperlukan.

> Route `/api/send` dan `/api/send-file` tetap bisa dipakai, tetapi mereka tidak memakai user API key secara otomatis; mereka di-protect oleh global `API_KEY` jika global key diaktifkan.

## 3. Endpoint yang paling umum dipakai

### 3.1 Kirim teks

- `POST /api/send`
- Body JSON:

```json
{
  "number": "6281234567890",
  "message": "Halo dari backend lain",
  "session": "default"
}
```

Header yang umum:

```http
Content-Type: application/json
X-API-Key: YOUR_API_KEY
```

### 3.2 Kirim file

- `POST /api/send-file`
- Form-data multipart:

```text
number=6281234567890
caption=Ini file dari backend
session=default
file=@/path/to/file.pdf
```

Header:

```http
X-API-Key: YOUR_API_KEY
```

### 3.3 Cek status gateway

- `GET /api/status?session=default`

### 3.4 Lihat history

- `GET /api/history?limit=100`

### 3.5 Broadcast

- `POST /api/broadcast`
- `numbers` dipisah `,` atau newline
- `message` atau `file`

## 4. Integrasi dengan Laravel

Contoh paling aman adalah memakai endpoint eksternal via user API key.

### 4.1 Install HTTP client

Laravel sudah punya `Http` facade.

### 4.2 Example

```php
use Illuminate\Support\Facades\Http;

$response = Http::withHeaders([
    'Content-Type' => 'application/json',
    'X-API-Key' => env('WA_GATEWAY_API_KEY'),
])->post('http://localhost:3000/api/external/send', [
    'number' => '6281234567890',
    'message' => 'Halo dari Laravel',
    'session' => 'default',
]);

if ($response->successful()) {
    $body = $response->json();
    // kirim ke log atau business logic Anda
    return response()->json($body);
}

return response()->json([
    'success' => false,
    'message' => 'Gagal kirim WhatsApp',
    'details' => $response->json(),
], 500);
```

### 4.3 Upload file dari Laravel

```php
use Illuminate\Support\Facades\Http;

$response = Http::asMultipart()->withHeaders([
    'X-API-Key' => env('WA_GATEWAY_API_KEY'),
])->post('http://localhost:3000/api/external/send-file', [
    'number' => '6281234567890',
    'caption' => 'Laporan dari Laravel',
    'session' => 'default',
    'file' => fopen(storage_path('app/public/laporan.pdf'), 'r'),
]);
```

## 5. Integrasi dengan Express.js

### 5.1 Example using axios

```js
const axios = require("axios");

async function sendWaMessage({ number, message }) {
  const response = await axios.post(
    "http://localhost:3000/api/external/send",
    {
      number,
      message,
      session: "default",
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.WA_GATEWAY_API_KEY,
      },
      timeout: 30000,
    },
  );

  return response.data;
}
```

### 5.2 Upload file

```js
const fs = require("fs");
const FormData = require("form-data");

async function sendWaFile({ number, filePath, caption }) {
  const form = new FormData();
  form.append("number", number);
  form.append("caption", caption || "");
  form.append("session", "default");
  form.append("file", fs.createReadStream(filePath));

  const response = await axios.post(
    "http://localhost:3000/api/external/send-file",
    form,
    {
      headers: {
        ...form.getHeaders(),
        "X-API-Key": process.env.WA_GATEWAY_API_KEY,
      },
      timeout: 30000,
    },
  );

  return response.data;
}
```

## 6. Integrasi dengan Python

```python
import os
import requests

url = 'http://localhost:3000/api/external/send'
headers = {
    'Content-Type': 'application/json',
    'X-API-Key': os.getenv('WA_GATEWAY_API_KEY', ''),
}
payload = {
    'number': '6281234567890',
    'message': 'Halo dari Python',
    'session': 'default',
}

response = requests.post(url, json=payload, headers=headers, timeout=30)
print(response.status_code)
print(response.json())
```

### 6.1 Upload file dari Python

```python
import os
import requests

url = 'http://localhost:3000/api/external/send-file'
headers = {
    'X-API-Key': os.getenv('WA_GATEWAY_API_KEY', ''),
}
with open('/path/to/file.pdf', 'rb') as f:
    files = {'file': ('file.pdf', f, 'application/pdf')}
    data = {
        'number': '6281234567890',
        'caption': 'Laporan dari Python',
        'session': 'default',
    }
    response = requests.post(url, data=data, files=files, headers=headers, timeout=30)
    print(response.json())
```

## 7. Integrasi dengan backend lain

Pola komunikasi umum untuk backend lain seperti Go, Java, Rust, .NET, Ruby, atau Node lainnya adalah sama:

1. Siapkan URL gateway.
2. Masukkan `X-API-Key` jika diperlukan.
3. Kirim request ke endpoint yang sesuai.
4. Tangani `success`, `message`, dan `requestId` dari response.
5. Simpan log untuk troubleshooting.

## 8. Contoh skenario dunia nyata

- Laravel mengirim notifikasi pembayaran ke pelanggan.
- Express backend mengirim OTP atau status update.
- Python worker mengirim laporan tahunan ke admin WhatsApp.
- Aplikasi internal memanggil gateway untuk broadcast promo.

## 9. Best practice

- Simpan URL dan API key di environment variable.
- Gunakan session id yang konsisten.
- Hindari hardcode nomor tujuan di aplikasi utama.
- Gunakan `/api/external/*` untuk komunikasi backend-to-gateway.
- Jika gateway di production, aktifkan API key dan batasi akses jaringan.
- Simpan `requestId` untuk debugging dan audit.

## 10. File pendukung dalam repo ini

- [API.md](../API.md)
- [docs/INSTALLATION.md](INSTALLATION.md)
- [docs/USAGE.md](USAGE.md)
- [clients/laravel/WhatsappGatewayService.php](../clients/laravel/WhatsappGatewayService.php)
- [clients/express/whatsappGatewayClient.js](../clients/express/whatsappGatewayClient.js)
- [clients/python/whatsapp_gateway_client.py](../clients/python/whatsapp_gateway_client.py)
