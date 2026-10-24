# WhatsApp Gateway API Reference

This file documents the HTTP API as it is implemented in the current project code. It reflects the actual route names, request body fields, authentication rules, and response shapes used by the server.

## Authentication and security

The server uses two authentication models:

- Global API key: `X-API-Key` / `x-api-key` for most `/api/*` routes when `API_KEY` is configured in `.env`
- Session-based auth: admin/user cookie sessions for dashboard and portal routes such as `/api/auth/*`, `/api/my/*`, `/api/admin/*`
- Per-user API key: `x-api-key` for user external endpoints under `/api/external/*`

Important behavior from the code:

- Global API key is enforced by the `/api` middleware only when `API_KEY` is set.
- If `API_KEY` is empty, those routes are open by default.
- The auth routes under `/api/auth/` and session-protected routes under `/api/my/` and `/api/admin/` are intentionally exempt from the global API key check.
- User external routes such as `/api/external/send` require a valid user API key in the `x-api-key` header.

## Common response format

Most JSON responses follow this shape:

```json
{
  "success": true,
  "message": "Pesan berhasil dikirim",
  "requestId": "abcd1234"
}
```

Error responses usually look like:

```json
{
  "success": false,
  "message": "Nomor tujuan tidak terdaftar di WhatsApp",
  "requestId": "abcd1234"
}
```

Common HTTP status codes:

- 200 OK
- 400 Bad Request
- 401 Unauthorized
- 404 Not Found
- 409 Conflict
- 422 Unprocessable Entity
- 429 Too Many Requests
- 500 Internal Server Error
- 503 Service Unavailable

---

## Public endpoints

### GET /api/status

Get gateway status for the selected session.

Query parameters:

- `session` (optional): session ID, default is the default session

Success response example:

```json
{
  "success": true,
  "session": "default",
  "connected": true,
  "status": "connected",
  "qrCodeData": null,
  "requestId": "abcd1234"
}
```

### GET /api/qr

Get QR code data for the selected session.

Query parameters:

- `session` (optional): session ID, default is the default session

Success response example:

```json
{
  "success": true,
  "qrCodeData": "data:image/png;base64,...",
  "updatedAt": "2026-09-24T10:00:00.000Z",
  "requestId": "abcd1234"
}
```

Error response example:

```json
{
  "success": false,
  "message": "QR code belum tersedia",
  "requestId": "abcd1234"
}
```

### GET /api/sessions

Admin-only listing of WhatsApp sessions.

Headers:

- `Cookie`: admin web session required

Success response example:

```json
{
  "success": true,
  "maxAccounts": 3,
  "entries": [
    {
      "id": "default",
      "name": "default",
      "status": "active",
      "connected": true
    }
  ],
  "requestId": "abcd1234"
}
```

### POST /api/sessions

Create a new WhatsApp session.

Headers:

- `Cookie`: admin web session required

Request body:

```json
{
  "name": "my-session"
}
```

Success response example:

```json
{
  "success": true,
  "message": "Akun baru dibuat, silakan scan QR untuk menghubungkan.",
  "session": {
    "id": "my-session",
    "name": "my-session"
  },
  "requestId": "abcd1234"
}
```

### DELETE /api/sessions/:id

Delete a WhatsApp session.

Headers:

- `Cookie`: admin web session required

Success response example:

```json
{
  "success": true,
  "message": "Akun WhatsApp dihapus",
  "requestId": "abcd1234"
}
```

---

## Message sending endpoints

### POST /api/send

Send a text message.

Required headers:

- `Content-Type: application/json`
- if `API_KEY` is set: `x-api-key`

Request body:

```json
{
  "number": "6281234567890",
  "message": "Halo dari gateway",
  "session": "default"
}
```

Notes:

- `session` is optional
- `number` is the destination phone number
- `message` is the text body

Success response example:

```json
{
  "success": true,
  "message": "Pesan berhasil dikirim",
  "to": "628***6789",
  "requestId": "abcd1234",
  "messageId": "3EB0...",
  "queueDelayMs": 12,
  "sendDurationMs": 894
}
```

Error response example:

```json
{
  "success": false,
  "message": "Nomor tujuan tidak terdaftar di WhatsApp",
  "requestId": "abcd1234"
}
```

### POST /api/send-file

Send a file or file + caption.

Required headers:

- `Content-Type: multipart/form-data`
- if `API_KEY` is set: `x-api-key`

Form fields:

- `file` (required): uploaded file
- `number` (required): destination number
- `caption` (optional): caption text
- `session` (optional): session ID

Success response example:

```json
{
  "success": true,
  "message": "File berhasil dikirim",
  "to": "628***6789",
  "requestId": "abcd1234",
  "messageId": "3EB0...",
  "queueDelayMs": 20,
  "sendDurationMs": 1200
}
```

Error response example:

```json
{
  "success": false,
  "message": "File wajib diunggah pada field 'file'",
  "requestId": "abcd1234"
}
```

### POST /api/test-chat

Send a self-test message to the current connected WhatsApp account.

Headers:

- `Cookie`: admin web session required

Success response example:

```json
{
  "success": true,
  "message": "Test chat berhasil dikirim",
  "to": "628***6789",
  "requestId": "abcd1234",
  "messageId": "3EB0...",
  "queueDelayMs": 5,
  "sendDurationMs": 450
}
```

### POST /api/logout

Logout the selected session and rotate the session.

Headers:

- `Cookie`: admin web session required

Success response example:

```json
{
  "success": true,
  "message": "Sesi lama berhasil dilogout. QR akun baru sedang disiapkan.",
  "requestId": "abcd1234"
}
```

---

## Broadcast endpoints

### POST /api/broadcast

Broadcast a single message to many numbers.

Required headers:

- if `API_KEY` is set: `x-api-key`
- `Content-Type: multipart/form-data` if file upload is used

Request body for text broadcast:

```json
{
  "numbers": "6281234567890,6281234567891\n6281234567892",
  "message": "Pengumuman promo",
  "session": "default"
}
```

Request body for file broadcast:

- `file` (optional)
- `numbers` (required)
- `message` (optional if file has caption)
- `session` (optional)

Success response example:

```json
{
  "success": true,
  "message": "Broadcast dijadwalkan ke 3 nomor. Cek tab Riwayat untuk status pengiriman.",
  "total": 3,
  "requestId": "abcd1234"
}
```

Error response example:

```json
{
  "success": false,
  "message": "Maksimum 200 nomor per broadcast",
  "requestId": "abcd1234"
}
```

---

## Scheduled message endpoints

### POST /api/schedule

Create a scheduled WhatsApp message.

Required headers:

- if `API_KEY` is set: `x-api-key`
- `Content-Type: multipart/form-data` if file upload is used

Request body:

```json
{
  "number": "6281234567890",
  "message": "Pesan ini dikirim nanti",
  "sendAt": "2026-10-01T09:00:00.000Z",
  "session": "default"
}
```

Success response example:

```json
{
  "success": true,
  "message": "Pesan terjadwal berhasil dibuat",
  "entry": {
    "id": "8d1f...",
    "sessionId": "default",
    "to": "628***6789",
    "message": "Pesan ini dikirim nanti",
    "sendAt": "2026-10-01T09:00:00.000Z",
    "status": "pending",
    "createdAt": "2026-09-24T08:00:00.000Z"
  },
  "requestId": "abcd1234"
}
```

### GET /api/schedule

List scheduled jobs.

Required headers:

- if `API_KEY` is set: `x-api-key`

Success response example:

```json
{
  "success": true,
  "entries": [
    {
      "id": "8d1f...",
      "sessionId": "default",
      "to": "628***6789",
      "message": "Pesan ini dikirim nanti",
      "sendAt": "2026-10-01T09:00:00.000Z",
      "status": "pending",
      "createdAt": "2026-09-24T08:00:00.000Z"
    }
  ],
  "requestId": "abcd1234"
}
```

### DELETE /api/schedule/:id

Cancel a scheduled job if status is still `pending`.

Required headers:

- if `API_KEY` is set: `x-api-key`

Success response example:

```json
{
  "success": true,
  "message": "Pesan terjadwal dibatalkan",
  "requestId": "abcd1234"
}
```

---

## History and logs

### GET /api/history

Get sending history.

Required headers:

- if `API_KEY` is set: `x-api-key`

Query parameters:

- `limit` (optional): max items, default 100

Success response example:

```json
{
  "success": true,
  "entries": [
    {
      "id": "seq-123",
      "sessionId": "default",
      "to": "628***6789",
      "type": "text",
      "message": "Halo",
      "status": "sent",
      "timestamp": "2026-09-24T08:10:00.000Z"
    }
  ],
  "total": 1,
  "requestId": "abcd1234"
}
```

### GET /api/logs

Read server logs.

Required headers:

- if `API_KEY` is set: `x-api-key`

Query parameters:

- `type` (optional): `combined`, `error`, `whatsapp`
- `limit` (optional): max lines

Success response example:

```json
{
  "success": true,
  "type": "combined",
  "entries": ["[2026-09-24T08:12:00.000Z] info: server started"],
  "requestId": "abcd1234"
}
```

---

## Auth endpoints

### POST /api/auth/admin/login

Admin login.

Request body:

```json
{
  "username": "admin",
  "password": "secret"
}
```

Success response example:

```json
{
  "success": true,
  "message": "Login berhasil",
  "requestId": "abcd1234"
}
```

If 2FA is enabled, response includes:

```json
{
  "success": true,
  "requiresTwoFactor": true,
  "pendingToken": "abc123",
  "message": "Kode verifikasi sudah dikirim ke WhatsApp nomor terdaftar akun ini.",
  "requestId": "abcd1234"
}
```

### POST /api/auth/admin/login/verify-2fa

Verify admin 2FA login.

Request body:

```json
{
  "pendingToken": "abc123",
  "otp": "123456"
}
```

### POST /api/auth/admin/logout

Admin logout.

### POST /api/auth/admin/forgot-password

Request password reset via WhatsApp OTP.

### POST /api/auth/admin/reset-password

Reset admin password via OTP.

### POST /api/auth/register

Register a new user.

Request body:

```json
{
  "username": "user1",
  "password": "secret123",
  "phone": "6281234567890"
}
```

### POST /api/auth/login

User login.

### POST /api/auth/login/verify-2fa

Verify user 2FA login.

### POST /api/auth/logout

User logout.

### POST /api/auth/forgot-password

Request user password reset OTP.

### POST /api/auth/reset-password

Reset user password using OTP.

---

## User portal endpoints

These are session-protected endpoints used by the logged-in user portal.

### GET /api/my/sessions

List sessions owned by the logged-in user.

### GET /api/my/sessions/:id/qr

Get QR for one user-owned session.

### POST /api/my/sessions

Request a new WAG session for the user.

### DELETE /api/my/sessions/:id

Delete a user-owned session.

### POST /api/my/send

User sends a text message from one of their owned sessions.

Request body:

```json
{
  "sessionId": "my-session",
  "number": "6281234567890",
  "message": "Halo dari portal user"
}
```

### POST /api/my/broadcast

User broadcast to multiple numbers.

### POST /api/my/schedule

User schedules a message.

### GET /api/my/schedule

List user scheduled messages.

### DELETE /api/my/schedule/:id

Cancel user scheduled message.

### GET /api/my/plans

Get available plans and pricing.

### GET /api/my/webhook

Get webhook config for the user.

### POST /api/my/webhook

Set or disable user webhook URL.

### GET /api/my/history

Get user-owned sending history.

### GET /api/my/analytics

Get user analytics by day.

### GET /api/my/history/export

Export user history as CSV.

### GET /api/my/webhook/deliveries

View webhook delivery attempts.

### GET /api/my/inbox

View incoming message inbox.

### GET /api/my/auto-replies

List user auto replies.

### POST /api/my/auto-replies

Create a user auto reply.

### PATCH /api/my/auto-replies/:id

Update user auto reply.

### DELETE /api/my/auto-replies/:id

Delete user auto reply.

### GET /api/my/contacts

List user contacts.

### POST /api/my/contacts

Add a contact.

### POST /api/my/contacts/import

Bulk import contacts via CSV-like text.

### DELETE /api/my/contacts/:id

Delete a contact.

### GET /api/my/templates

List saved templates.

### POST /api/my/templates

Create a template.

### DELETE /api/my/templates/:id

Delete a template.

### GET /api/my/api-key

Get current user API key prefix and created time.

### POST /api/my/upgrade-request

Request a plan upgrade.

---

## User external API endpoints

These endpoints are meant for external backend integrations and require a valid per-user API key in the `x-api-key` header.

### POST /api/external/send

Send a text message using the caller's user API key.

Request body:

```json
{
  "number": "6281234567890",
  "message": "Halo dari backend lain",
  "session": "optional-session-id"
}
```

Success response example:

```json
{
  "success": true,
  "message": "Pesan berhasil dikirim",
  "messageId": "3EB0...",
  "remaining": 98,
  "requestId": "abcd1234"
}
```

### POST /api/external/send-file

Send file using user API key.

Form fields:

- `file` (required)
- `number` (required)
- `caption` (optional)
- `session` (optional)

### POST /api/external/broadcast

User external broadcast endpoint.

### POST /api/external/schedule

User external scheduled message endpoint.

---

## Admin endpoints

These require admin session or API key depending on implementation and are primarily used by dashboard operations.

### GET /api/admin/own-sessions

List admin-owned sessions.

### GET /api/admin/auto-replies

List admin auto replies.

### POST /api/admin/auto-replies

Create admin auto reply.

### PATCH /api/admin/auto-replies/:id

Update admin auto reply.

### DELETE /api/admin/auto-replies/:id

Delete admin auto reply.

### GET /api/admin/requests

List pending WAG requests.

### POST /api/admin/requests/:id/approve

Approve a WAG request.

### POST /api/admin/requests/:id/reject

Reject a WAG request.

### GET /api/admin/users

List registered users.

### PATCH /api/admin/users/:id

Update user plan or metadata.

### DELETE /api/admin/users/:id

Delete a user.

### GET /api/admin/audit-log

List admin audit events.

### GET /api/admin/config

Read notifier / pricing / 2FA config.

### POST /api/admin/config

Set notifier / pricing / 2FA config.

### GET /api/admin/payment-config

Read payment config.

### POST /api/admin/payment-config

Upload QRIS and payment config.

### DELETE /api/admin/payment-config/qris

Delete QRIS image.

### GET /api/admin/stats/messages

Get admin message stats over number of days.

### POST /api/admin/users/:id/api-key/regenerate

Regenerate a user's API key and send it to their registered WhatsApp number.

---

## Settings endpoints

### GET /api/settings

Read environment configuration groups.

Required headers:

- if `API_KEY` is set: `x-api-key`

### POST /api/settings

Save environment settings with the `values` object.

Request body:

```json
{
  "values": {
    "PORT": "3000",
    "MAX_ACCOUNTS": "5"
  }
}
```

---

## Admin management endpoints

### GET /api/admins

List admin accounts.

### POST /api/admins

Create admin account.

### PATCH /api/admins/:id

Update admin password or phone.

### DELETE /api/admins/:id

Delete admin account.

---

## Notes

- All `POST /api/send` and `POST /api/send-file` routes expect a valid WhatsApp session. If no session is provided, the default session is used.
- The project uses a `requestId` field in most responses for correlation and logging.
- For user-facing integrations, the recommended route is `/api/external/send` or `/api/external/send-file` with a valid `x-api-key`.
- The server also exposes inbound message webhooks through user webhook configuration and its internal webhook delivery tracking.
