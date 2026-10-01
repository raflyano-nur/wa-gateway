# Backend Integration Guide

This gateway runs as an independent WhatsApp service. Your Laravel, Express, Python, or other backend only needs to send HTTP requests to the gateway.

## Authentication

For backend-to-gateway integrations, use the user API endpoints:

- `POST /api/external/send`
- `POST /api/external/send-file`
- `POST /api/external/broadcast`
- `POST /api/external/schedule`

Send the user API key in the `X-API-Key` header. Keep the key in your backend environment variables and never expose it in frontend code.

## Send a text message

```json
{
  "number": "6281234567890",
  "message": "Hello from another backend",
  "session": "default"
}
```

```http
POST /api/external/send
Content-Type: application/json
X-API-Key: YOUR_USER_API_KEY
```

## Laravel

```php
use Illuminate\Support\Facades\Http;

$response = Http::withHeaders([
    'X-API-Key' => env('WA_GATEWAY_API_KEY'),
])->post('http://localhost:3000/api/external/send', [
    'number' => '6281234567890',
    'message' => 'Hello from Laravel',
    'session' => 'default',
]);

return response()->json($response->json(), $response->status());
```

For file uploads:

```php
$response = Http::asMultipart()->withHeaders([
    'X-API-Key' => env('WA_GATEWAY_API_KEY'),
])->post('http://localhost:3000/api/external/send-file', [
    ['name' => 'number', 'contents' => '6281234567890'],
    ['name' => 'caption', 'contents' => 'Report from Laravel'],
    ['name' => 'file', 'contents' => fopen(storage_path('app/public/report.pdf'), 'r')],
]);
```

## Express / Node.js

```js
const axios = require("axios");

const response = await axios.post(
  "http://localhost:3000/api/external/send",
  {
    number: "6281234567890",
    message: "Hello from Express",
    session: "default",
  },
  {
    headers: {
      "X-API-Key": process.env.WA_GATEWAY_API_KEY,
    },
    timeout: 30000,
  },
);

console.log(response.data);
```

## Python

```python
import os
import requests

response = requests.post(
    'http://localhost:3000/api/external/send',
    json={
        'number': '6281234567890',
        'message': 'Hello from Python',
        'session': 'default',
    },
    headers={'X-API-Key': os.environ['WA_GATEWAY_API_KEY']},
    timeout=30,
)

print(response.json())
```

## File upload from Python

```python
with open('/path/to/report.pdf', 'rb') as file:
    response = requests.post(
        'http://localhost:3000/api/external/send-file',
        data={
            'number': '6281234567890',
            'caption': 'Report from Python',
            'session': 'default',
        },
        files={'file': ('report.pdf', file, 'application/pdf')},
        headers={'X-API-Key': os.environ['WA_GATEWAY_API_KEY']},
        timeout=30,
    )
```

## Recommended practices

- Store the gateway URL and API key in environment variables.
- Use `/api/external/*` for application-to-gateway communication.
- Keep API keys on the server side only.
- Store the returned `requestId` in logs for troubleshooting.
- Check both the HTTP status and the `success` field in every response.
- Use the webhook configuration for inbound WhatsApp events instead of excessive polling.

## Repository clients

- Laravel: `/docs/client/laravel`
- Express: `/docs/client/express`
- Python: `/docs/client/python`
- Full API reference: `/docs/api-reference`
