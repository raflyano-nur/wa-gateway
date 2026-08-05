require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const qrcode = require("qrcode");
const morgan = require("morgan");
const winston = require("winston");
const { v4: uuidv4 } = require("uuid");

const APP_NAME = "WhatsApp Gateway";
const AUTH_DIR = process.env.WA_AUTH_DIR || "auth_info_baileys";
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || "256kb";
const MESSAGE_TIMEOUT_MS = Number(process.env.MESSAGE_TIMEOUT_MS || 45000);
const LOGOUT_TIMEOUT_MS = Number(process.env.LOGOUT_TIMEOUT_MS || 15000);
const RECONNECT_BASE_DELAY_MS = Number(
  process.env.RECONNECT_BASE_DELAY_MS || 3000,
);
const RECONNECT_MAX_DELAY_MS = Number(
  process.env.RECONNECT_MAX_DELAY_MS || 30000,
);
const STATUS_POLL_INTERVAL_MS = Number(
  process.env.STATUS_POLL_INTERVAL_MS || 5000,
);
const MAX_QUEUE_SIZE = Number(process.env.MAX_QUEUE_SIZE || 200);
const SEND_CONCURRENCY = Math.max(1, Number(process.env.SEND_CONCURRENCY || 1));
const LOG_STATUS_CHECKS = process.env.LOG_STATUS_CHECKS === "true";
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

fs.mkdirSync(path.join(__dirname, "logs"), { recursive: true });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: REQUEST_BODY_LIMIT }));

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json(),
  ),
  defaultMeta: { service: "whatsapp-gateway" },
  transports: [
    new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: "logs/combined.log",
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: "logs/whatsapp.log",
      maxsize: 5242880,
      maxFiles: 3,
    }),
  ],
});

if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const metaStr = Object.keys(meta).length
            ? ` ${JSON.stringify(meta)}`
            : "";
          return `[${timestamp}] ${level}: ${message}${metaStr}`;
        }),
      ),
    }),
  );
}

app.use((req, res, next) => {
  req.id = uuidv4().split("-")[0];
  res.setHeader("X-Request-ID", req.id);
  next();
});

morgan.token("id", (req) => req.id || "-");

app.use(
  morgan(":id :method :url :status :res[content-length] - :response-time ms", {
    skip: (req) => req.path === "/api/status" || req.path === "/api/qr",
    stream: {
      write: (message) => logger.http(message.trim()),
    },
  }),
);

let sock = null;
let qrCodeData = "";
let qrUpdatedAt = 0;
let isConnected = false;
let isConnecting = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let socketGeneration = 0;
let lastDisconnectReason = null;
let lastDisconnectMessage = null;
let lastConnectionState = "starting";
let isLogoutInProgress = false;

const sendQueue = [];
let activeSendCount = 0;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function maskDestination(value) {
  const input = String(value || "");

  if (input.includes("@")) {
    const [local, domain] = input.split("@");
    return `${maskDestination(local)}@${domain}`;
  }

  const digits = input.replace(/\D/g, "");
  if (!digits) {
    return "unknown";
  }

  if (digits.length <= 4) {
    return `***${digits}`;
  }

  return `${digits.slice(0, 3)}***${digits.slice(-4)}`;
}

function normalizeRecipient(number) {
  if (typeof number !== "string") {
    throw new Error("Nomor tujuan harus berupa teks");
  }

  const trimmed = number.trim();
  if (!trimmed) {
    throw new Error("Nomor tujuan wajib diisi");
  }

  if (trimmed.includes("@")) {
    return trimmed;
  }

  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 8) {
    throw new Error("Format nomor tidak valid");
  }

  return `${digits}@s.whatsapp.net`;
}

function normalizeMessage(message) {
  if (typeof message !== "string") {
    throw new Error("Pesan wajib berupa teks");
  }

  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error("Pesan tidak boleh kosong");
  }

  return trimmed;
}

function getClientIp(req) {
  return (
    req.ip ||
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function getReconnectDelayMs(attempt) {
  return Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    RECONNECT_MAX_DELAY_MS,
  );
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function getAuthDirPath() {
  return path.resolve(__dirname, AUTH_DIR);
}

function assertSafeAuthDirPath(targetPath) {
  const appRoot = path.resolve(__dirname);
  const normalizedPath = path.resolve(targetPath);
  const relativePath = path.relative(appRoot, normalizedPath);

  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Lokasi auth WhatsApp tidak aman untuk dihapus otomatis");
  }

  return normalizedPath;
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timeout setelah ${timeoutMs} ms`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function getGatewayStatus(reqId) {
  return {
    connected: isConnected,
    connecting: isConnecting,
    logoutInProgress: isLogoutInProgress,
    hasQR: qrCodeData !== "",
    queueDepth: sendQueue.length,
    activeSendCount,
    reconnectAttempt,
    lastConnectionState,
    lastDisconnectReason,
    lastDisconnectMessage,
    qrUpdatedAt,
    timestamp: new Date().toISOString(),
    requestId: reqId,
  };
}

function scheduleReconnect(context) {
  if (reconnectTimer || isConnecting) {
    return;
  }

  reconnectAttempt += 1;
  const delayMs = getReconnectDelayMs(reconnectAttempt);

  logger.warn("Menjadwalkan reconnect WhatsApp", {
    attempt: reconnectAttempt,
    delayMs,
    context,
  });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp().catch((error) => {
      logger.error("Reconnect WhatsApp gagal", {
        error: error.message,
        stack: error.stack,
      });
    });
  }, delayMs);
}

function processSendQueue() {
  while (activeSendCount < SEND_CONCURRENCY && sendQueue.length > 0) {
    const task = sendQueue.shift();
    activeSendCount += 1;

    (async () => {
      const queueDelayMs = Date.now() - task.enqueuedAt;

      if (!sock || !isConnected) {
        throw new Error("WhatsApp belum terhubung");
      }

      const sendStartedAt = Date.now();
      const result = await withTimeout(
        sock.sendMessage(task.jid, { text: task.message }),
        MESSAGE_TIMEOUT_MS,
        "Pengiriman pesan",
      );

      return {
        result,
        queueDelayMs,
        sendDurationMs: Date.now() - sendStartedAt,
      };
    })()
      .then(task.resolve)
      .catch(task.reject)
      .finally(() => {
        activeSendCount -= 1;
        setImmediate(processSendQueue);
      });
  }
}

function enqueueMessageSend(payload) {
  if (sendQueue.length >= MAX_QUEUE_SIZE) {
    throw new Error("Antrean pengiriman sedang penuh, coba lagi sebentar");
  }

  return new Promise((resolve, reject) => {
    sendQueue.push({
      ...payload,
      enqueuedAt: Date.now(),
      resolve,
      reject,
    });

    setImmediate(processSendQueue);
  });
}

async function updateQrCode(qr) {
  qrCodeData = await qrcode.toDataURL(qr, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 256,
  });
  qrUpdatedAt = Date.now();
}

async function removeAuthStateDirectory() {
  const authDirPath = assertSafeAuthDirPath(getAuthDirPath());
  await fs.promises.rm(authDirPath, { recursive: true, force: true });
  logger.info("Folder auth WhatsApp dihapus", { authDir: authDirPath });
}

async function logoutAndRotateAccount(reqId) {
  if (isLogoutInProgress) {
    throw new Error("Logout akun sedang diproses");
  }

  isLogoutInProgress = true;
  clearReconnectTimer();

  const activeSock = sock;
  const hadSocket = Boolean(activeSock);
  const canLogoutCompanion = Boolean(activeSock) && isConnected;

  socketGeneration += 1;
  sock = null;
  isConnected = false;
  isConnecting = false;
  qrCodeData = "";
  qrUpdatedAt = Date.now();
  reconnectAttempt = 0;
  lastConnectionState = "logging_out";
  lastDisconnectReason = null;
  lastDisconnectMessage = "Logout manual sedang diproses";

  try {
    if (canLogoutCompanion) {
      try {
        await withTimeout(
          activeSock.logout("Logout manual dari dashboard"),
          LOGOUT_TIMEOUT_MS,
          "Logout WhatsApp",
        );
      } catch (error) {
        logger.warn(`[${reqId}] Logout socket tidak selesai sempurna`, {
          error: error.message,
          stack: error.stack,
        });
      }
    }

    await removeAuthStateDirectory();

    lastConnectionState = "logged_out";
    lastDisconnectReason = DisconnectReason.loggedOut;
    lastDisconnectMessage = "Sesi lama dihapus. Silakan scan akun baru.";

    logger.info(`[${reqId}] Sesi WhatsApp direset untuk ganti akun`, {
      hadSocket,
      canLogoutCompanion,
      authDir: AUTH_DIR,
    });

    await connectToWhatsApp();
  } finally {
    isLogoutInProgress = false;
  }
}

async function connectToWhatsApp() {
  if (isConnecting) {
    return;
  }

  clearReconnectTimer();
  isConnecting = true;
  isConnected = false;
  lastConnectionState = "connecting";

  const currentGeneration = ++socketGeneration;

  try {
    logger.info("Memulai koneksi WhatsApp", { authDir: AUTH_DIR });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: [APP_NAME, "Desktop", "1.0.0"],
      connectTimeoutMs: 20000,
      defaultQueryTimeoutMs: MESSAGE_TIMEOUT_MS,
      keepAliveIntervalMs: 30000,
      emitOwnEvents: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sock.ev.on("connection.update", async (update) => {
      if (currentGeneration !== socketGeneration) {
        return;
      }

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          await updateQrCode(qr);
          lastConnectionState = "qr_ready";
          logger.info("QR code baru siap dipindai");
        } catch (error) {
          logger.error("Gagal membuat QR code", {
            error: error.message,
            stack: error.stack,
          });
        }
      }

      if (connection === "open") {
        isConnected = true;
        isConnecting = false;
        reconnectAttempt = 0;
        qrCodeData = "";
        qrUpdatedAt = Date.now();
        lastConnectionState = "open";
        lastDisconnectReason = null;
        lastDisconnectMessage = null;

        logger.info("WhatsApp terhubung");
        return;
      }

      if (connection !== "close") {
        return;
      }

      const disconnectError = lastDisconnect?.error;
      const reason =
        disconnectError instanceof Boom
          ? disconnectError.output.statusCode
          : lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect =
        disconnectError instanceof Boom
          ? disconnectError.output.statusCode !== DisconnectReason.loggedOut
          : true;

      isConnected = false;
      isConnecting = false;
      qrCodeData = "";
      qrUpdatedAt = Date.now();
      lastConnectionState = "closed";
      lastDisconnectReason = reason || "unknown";
      lastDisconnectMessage = disconnectError?.message || "Connection closed";

      logger.warn("Koneksi WhatsApp terputus", {
        reason: lastDisconnectReason,
        shouldReconnect,
        error: lastDisconnectMessage,
      });

      if (shouldReconnect) {
        scheduleReconnect("connection_closed");
      } else {
        reconnectAttempt = 0;
        clearReconnectTimer();
        logger.error("Sesi WhatsApp logout, perlu scan ulang");
      }
    });

    sock.ev.on("creds.update", (creds) => {
      if (currentGeneration !== socketGeneration) {
        return;
      }

      saveCreds(creds);
    });
  } catch (error) {
    isConnecting = false;
    isConnected = false;
    lastConnectionState = "error";
    lastDisconnectReason = "connect_error";
    lastDisconnectMessage = error.message;

    logger.error("Error saat koneksi WhatsApp", {
      error: error.message,
      stack: error.stack,
    });

    scheduleReconnect("connect_error");
    throw error;
  }
}

function renderHomePage() {
  return `<!doctype html>
<html lang="id">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${APP_NAME}</title>
    <style>
        :root {
            color-scheme: light;
            --bg: #eef4ef;
            --panel: #ffffff;
            --line: #d9e4da;
            --text: #183025;
            --muted: #587164;
            --accent: #1f8f52;
            --accent-dark: #16683c;
            --warn: #b36a00;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: "Segoe UI", Tahoma, sans-serif;
            color: var(--text);
            background:
                radial-gradient(circle at top right, rgba(31, 143, 82, 0.12), transparent 28%),
                linear-gradient(180deg, #f8fbf8 0%, var(--bg) 100%);
            min-height: 100vh;
            display: grid;
            place-items: center;
            padding: 24px;
        }
        .card {
            width: min(720px, 100%);
            background: rgba(255, 255, 255, 0.94);
            border: 1px solid var(--line);
            border-radius: 24px;
            padding: 32px;
            box-shadow: 0 24px 60px rgba(24, 48, 37, 0.08);
        }
        h1 { margin: 0 0 8px; font-size: 32px; }
        p { margin: 0; line-height: 1.6; }
        .status {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            margin-top: 20px;
            padding: 10px 16px;
            border-radius: 999px;
            background: #edf8f1;
            color: var(--accent-dark);
            font-weight: 600;
        }
        .status.waiting {
            background: #fff5e8;
            color: var(--warn);
        }
        .status.disconnected {
            background: #f7ecec;
            color: #9a3737;
        }
        .grid {
            display: grid;
            gap: 18px;
            margin-top: 24px;
        }
        .qr-box {
            min-height: 280px;
            display: grid;
            place-items: center;
            border: 1px dashed var(--line);
            border-radius: 18px;
            background: #fbfdfb;
            padding: 20px;
        }
        .qr-box img {
            width: min(260px, 100%);
            height: auto;
            display: none;
            border-radius: 12px;
            border: 1px solid var(--line);
            background: #fff;
            padding: 10px;
        }
        .meta {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 14px;
        }
        .meta-item {
            border: 1px solid var(--line);
            border-radius: 16px;
            padding: 14px;
            background: #fff;
        }
        .meta-item strong {
            display: block;
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--muted);
            margin-bottom: 8px;
        }
        .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-top: 24px;
        }
        .button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-height: 44px;
            padding: 0 18px;
            border-radius: 12px;
            background: var(--accent);
            color: #fff;
            text-decoration: none;
            font-weight: 600;
            border: none;
            cursor: pointer;
            font: inherit;
        }
        .button.secondary {
            background: #eff5f0;
            color: var(--text);
        }
        .button.danger {
            background: #c74b4b;
        }
        .button:disabled {
            opacity: 0.7;
            cursor: wait;
        }
        .hint {
            margin-top: 14px;
            color: var(--muted);
            font-size: 14px;
        }
        @media (max-width: 640px) {
            .card { padding: 22px; }
            h1 { font-size: 26px; }
        }
    </style>
</head>
<body>
    <main class="card">
        <h1>${APP_NAME}</h1>
        <p>Gateway ini dipoles supaya koneksi lebih stabil, polling lebih ringan, dan proses kirim tidak saling tabrak saat traffic naik.</p>

        <div id="statusBadge" class="status waiting">Memeriksa status...</div>

        <section class="grid">
            <div class="qr-box">
                <img id="qrImage" alt="QR WhatsApp">
                <p id="qrText">Menunggu status koneksi terbaru...</p>
            </div>

            <div class="meta">
                <div class="meta-item">
                    <strong>Status</strong>
                    <span id="connState">-</span>
                </div>
                <div class="meta-item">
                    <strong>Antrean</strong>
                    <span id="queueState">-</span>
                </div>
                <div class="meta-item">
                    <strong>Reconnect</strong>
                    <span id="reconnectState">-</span>
                </div>
                <div class="meta-item">
                    <strong>Update</strong>
                    <span id="updatedAt">-</span>
                </div>
            </div>
        </section>

        <div class="actions">
            <a class="button" href="/send-form">Kirim Pesan</a>
            <button id="logoutButton" class="button danger" type="button">Ganti Akun WA</button>
            <a class="button secondary" href="/api/status" target="_blank" rel="noreferrer">Lihat JSON Status</a>
        </div>

        <p class="hint">Tombol ganti akun akan logout perangkat tertaut saat ini, menghapus folder <code>${escapeHtml(AUTH_DIR)}</code>, lalu menyiapkan QR untuk akun baru.</p>
    </main>

    <script>
        const pollIntervalMs = ${STATUS_POLL_INTERVAL_MS};
        const statusBadge = document.getElementById('statusBadge');
        const connState = document.getElementById('connState');
        const queueState = document.getElementById('queueState');
        const reconnectState = document.getElementById('reconnectState');
        const updatedAt = document.getElementById('updatedAt');
        const qrImage = document.getElementById('qrImage');
        const qrText = document.getElementById('qrText');
        const logoutButton = document.getElementById('logoutButton');

        let lastQrUpdatedAt = 0;

        function setBadge(label, mode) {
            statusBadge.textContent = label;
            statusBadge.className = 'status ' + mode;
        }

        function syncLogoutButton(isBusy) {
            logoutButton.disabled = isBusy;
            logoutButton.textContent = isBusy ? 'Memproses Logout...' : 'Ganti Akun WA';
        }

        async function refreshStatus() {
            try {
                const response = await fetch('/api/status', { cache: 'no-store' });
                const data = await response.json();

                connState.textContent = data.lastConnectionState || (data.connected ? 'open' : 'disconnected');
                queueState.textContent = data.queueDepth + ' antrean, ' + data.activeSendCount + ' aktif';
                reconnectState.textContent = data.reconnectAttempt > 0
                    ? 'Percobaan ke-' + data.reconnectAttempt
                    : 'Siaga';
                updatedAt.textContent = new Date(data.timestamp).toLocaleString('id-ID');
                syncLogoutButton(Boolean(data.logoutInProgress));

                if (data.logoutInProgress) {
                    setBadge('Sedang logout akun WhatsApp...', 'waiting');
                    qrImage.style.display = 'none';
                    qrText.textContent = 'Perangkat tertaut sedang diputus dan sesi lama sedang dibersihkan.';
                } else if (data.connected) {
                    setBadge('WhatsApp terhubung dan siap kirim', '');
                    qrImage.style.display = 'none';
                    qrText.textContent = 'Perangkat aktif dan siap dipakai.';
                } else if (data.hasQR) {
                    setBadge('QR siap dipindai', 'waiting');
                    qrText.textContent = 'Scan QR ini dari WhatsApp di ponsel Anda.';

                    if (lastQrUpdatedAt !== data.qrUpdatedAt) {
                        const qrResponse = await fetch('/api/qr', { cache: 'no-store' });
                        const qrData = await qrResponse.json();
                        qrImage.src = qrData.qrCodeData;
                        qrImage.style.display = 'block';
                        lastQrUpdatedAt = data.qrUpdatedAt;
                    }
                } else if (data.lastDisconnectReason === 401) {
                    setBadge('Sesi logout, perlu scan ulang', 'disconnected');
                    qrImage.style.display = 'none';
                    qrText.textContent = 'Sesi WhatsApp keluar. Tunggu QR baru lalu scan ulang.';
                } else {
                    setBadge('Sedang menyambungkan WhatsApp...', 'waiting');
                    qrImage.style.display = 'none';
                    qrText.textContent = 'Koneksi sedang dipulihkan. Halaman ini akan update otomatis.';
                }
            } catch (error) {
                syncLogoutButton(false);
                setBadge('Status gateway belum bisa diambil', 'disconnected');
                qrImage.style.display = 'none';
                qrText.textContent = 'Server sedang sibuk atau baru restart.';
            }
        }

        logoutButton.addEventListener('click', async () => {
            if (logoutButton.disabled) {
                return;
            }

            const confirmed = window.confirm('Logout akun WhatsApp saat ini dan siapkan QR untuk akun baru?');
            if (!confirmed) {
                return;
            }

            syncLogoutButton(true);
            setBadge('Memproses logout akun...', 'waiting');
            qrImage.style.display = 'none';
            qrText.textContent = 'Perangkat tertaut sedang diputus. Tunggu beberapa detik...';

            try {
                const response = await fetch('/api/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                });
                const data = await response.json();

                if (!response.ok || !data.success) {
                    throw new Error(data.message || 'Logout akun gagal');
                }

                lastQrUpdatedAt = 0;
                qrText.textContent = data.message;
                await refreshStatus();
            } catch (error) {
                syncLogoutButton(false);
                setBadge('Logout akun gagal', 'disconnected');
                qrText.textContent = error.message;
            }
        });

        refreshStatus();
        setInterval(refreshStatus, pollIntervalMs);
    </script>
</body>
</html>`;
}

function renderSendFormPage() {
  return `<!doctype html>
<html lang="id">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Kirim Pesan</title>
    <style>
        :root {
            --bg: #eef4ef;
            --panel: #ffffff;
            --line: #d9e4da;
            --text: #183025;
            --muted: #587164;
            --accent: #1f8f52;
            --accent-dark: #16683c;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: "Segoe UI", Tahoma, sans-serif;
            color: var(--text);
            background: linear-gradient(180deg, #f7fbf7 0%, var(--bg) 100%);
            min-height: 100vh;
            display: grid;
            place-items: center;
            padding: 24px;
        }
        .card {
            width: min(640px, 100%);
            background: var(--panel);
            border-radius: 22px;
            padding: 28px;
            border: 1px solid var(--line);
            box-shadow: 0 24px 60px rgba(24, 48, 37, 0.08);
        }
        h1 { margin-top: 0; }
        p { color: var(--muted); line-height: 1.6; }
        label { display: block; margin-top: 16px; font-weight: 600; }
        input, textarea {
            width: 100%;
            padding: 12px 14px;
            border: 1px solid var(--line);
            border-radius: 12px;
            margin-top: 8px;
            font: inherit;
        }
        textarea { min-height: 160px; resize: vertical; }
        .note {
            margin-top: 8px;
            color: var(--muted);
            font-size: 14px;
        }
        .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-top: 24px;
        }
        button, a {
            min-height: 44px;
            padding: 0 18px;
            border-radius: 12px;
            font: inherit;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
        button {
            background: var(--accent);
            color: #fff;
            border: none;
            cursor: pointer;
            font-weight: 600;
        }
        a {
            background: #eff5f0;
            color: var(--text);
        }
    </style>
</head>
<body>
    <main class="card">
        <h1>Kirim Pesan WhatsApp</h1>
        <p>Form ini langsung memakai antrean internal gateway, jadi saat banyak request masuk server tetap rapi dan tidak saling menahan secara liar.</p>

        <form action="/send-message" method="POST">
            <label for="number">Nomor Tujuan</label>
            <input id="number" type="text" name="number" placeholder="628123456789" required>
            <div class="note">Boleh tulis dengan atau tanpa tanda plus. Nomor akan dirapikan otomatis.</div>

            <label for="message">Pesan</label>
            <textarea id="message" name="message" placeholder="Tulis pesan Anda di sini..." required></textarea>

            <div class="actions">
                <button type="submit">Kirim Sekarang</button>
                <a href="/">Kembali</a>
            </div>
        </form>
    </main>
</body>
</html>`;
}

function renderSuccessPage(title, body, requestId) {
  return `<!doctype html>
<html lang="id">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
        body {
            margin: 0;
            font-family: "Segoe UI", Tahoma, sans-serif;
            background: #f6faf7;
            display: grid;
            place-items: center;
            min-height: 100vh;
            padding: 24px;
        }
        .card {
            width: min(640px, 100%);
            background: #fff;
            border: 1px solid #d9e4da;
            border-radius: 20px;
            padding: 28px;
            text-align: center;
            box-shadow: 0 24px 60px rgba(24, 48, 37, 0.08);
        }
        a {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-height: 44px;
            padding: 0 18px;
            margin: 8px 6px 0;
            border-radius: 12px;
            background: #1f8f52;
            color: #fff;
            text-decoration: none;
            font-weight: 600;
        }
        .secondary {
            background: #eff5f0;
            color: #183025;
        }
        small { color: #587164; }
    </style>
</head>
<body>
    <main class="card">
        <h1>${escapeHtml(title)}</h1>
        <p>${body}</p>
        <p><small>Request ID: ${escapeHtml(requestId)}</small></p>
        <a href="/send-form">Kirim Lagi</a>
        <a class="secondary" href="/">Home</a>
    </main>
</body>
</html>`;
}

app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.send(renderHomePage());
});

app.get("/send-form", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.send(renderSendFormPage());
});

app.post("/send-message", async (req, res) => {
  let jid;
  let message;

  try {
    jid = normalizeRecipient(req.body.number);
    message = normalizeMessage(req.body.message);
  } catch (error) {
    logger.warn(`[${req.id}] Validasi form gagal`, {
      error: error.message,
    });

    return res
      .status(400)
      .send(
        renderSuccessPage(
          "Input tidak valid",
          escapeHtml(error.message),
          req.id,
        ),
      );
  }

  const maskedJid = maskDestination(jid);

  if (!isConnected || !sock) {
    logger.warn(`[${req.id}] WhatsApp belum terhubung`, { to: maskedJid });
    return res
      .status(503)
      .send(
        renderSuccessPage(
          "WhatsApp belum terhubung",
          "Silakan buka halaman utama dan scan QR terlebih dahulu.",
          req.id,
        ),
      );
  }

  logger.info(`[${req.id}] Form kirim pesan`, {
    to: maskedJid,
    messageLength: message.length,
    queueDepth: sendQueue.length,
    activeSendCount,
  });

  try {
    const { queueDelayMs, sendDurationMs } = await enqueueMessageSend({
      jid,
      message,
    });

    logger.info(`[${req.id}] Pesan form terkirim`, {
      to: maskedJid,
      queueDelayMs,
      sendDurationMs,
    });

    return res.send(
      renderSuccessPage(
        "Pesan berhasil terkirim",
        `Pesan telah dikirim ke <strong>${escapeHtml(maskedJid)}</strong>.`,
        req.id,
      ),
    );
  } catch (error) {
    logger.error(`[${req.id}] Gagal kirim dari form`, {
      to: maskedJid,
      error: error.message,
      stack: error.stack,
    });

    return res
      .status(500)
      .send(
        renderSuccessPage(
          "Pengiriman gagal",
          escapeHtml(error.message),
          req.id,
        ),
      );
  }
});

app.post("/api/send", async (req, res) => {
  const clientIp = getClientIp(req);
  let jid;
  let message;

  try {
    jid = normalizeRecipient(req.body.number);
    message = normalizeMessage(req.body.message);
  } catch (error) {
    logger.warn(`[${req.id}] Validasi API gagal`, {
      clientIp,
      error: error.message,
    });

    return res.status(400).json({
      success: false,
      message: error.message,
      requestId: req.id,
    });
  }

  const maskedJid = maskDestination(jid);

  if (!isConnected || !sock) {
    logger.warn(`[${req.id}] API ditolak karena WhatsApp belum terhubung`, {
      clientIp,
      to: maskedJid,
    });

    return res.status(503).json({
      success: false,
      message: "WhatsApp belum terhubung",
      requestId: req.id,
      queueDepth: sendQueue.length,
    });
  }

  logger.info(`[${req.id}] API kirim pesan`, {
    clientIp,
    to: maskedJid,
    messageLength: message.length,
    queueDepth: sendQueue.length,
    activeSendCount,
    userAgent: req.get("user-agent") || "unknown",
  });

  try {
    const { result, queueDelayMs, sendDurationMs } = await enqueueMessageSend({
      jid,
      message,
    });

    logger.info(`[${req.id}] API pesan terkirim`, {
      clientIp,
      to: maskedJid,
      messageId: result?.key?.id,
      queueDelayMs,
      sendDurationMs,
    });

    return res.json({
      success: true,
      message: "Pesan berhasil dikirim",
      to: maskedJid,
      requestId: req.id,
      messageId: result?.key?.id,
      queueDelayMs,
      sendDurationMs,
    });
  } catch (error) {
    const isQueueFull = error.message.includes(
      "Antrean pengiriman sedang penuh",
    );
    const statusCode = isQueueFull ? 429 : 500;

    logger.error(`[${req.id}] API kirim pesan gagal`, {
      clientIp,
      to: maskedJid,
      error: error.message,
      stack: error.stack,
    });

    return res.status(statusCode).json({
      success: false,
      message: error.message,
      requestId: req.id,
      queueDepth: sendQueue.length,
    });
  }
});

app.post("/api/logout", async (req, res) => {
  const clientIp = getClientIp(req);

  if (isLogoutInProgress) {
    return res.status(409).json({
      success: false,
      message: "Logout akun sedang diproses",
      requestId: req.id,
    });
  }

  logger.info(`[${req.id}] Permintaan ganti akun WhatsApp`, {
    clientIp,
    connected: isConnected,
    connecting: isConnecting,
    authDir: AUTH_DIR,
  });

  try {
    await logoutAndRotateAccount(req.id);

    return res.json({
      success: true,
      message: "Sesi lama berhasil dilogout. QR akun baru sedang disiapkan.",
      requestId: req.id,
    });
  } catch (error) {
    logger.error(`[${req.id}] Gagal ganti akun WhatsApp`, {
      clientIp,
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: error.message,
      requestId: req.id,
    });
  }
});

app.get("/api/status", (req, res) => {
  const status = getGatewayStatus(req.id);

  if (LOG_STATUS_CHECKS) {
    logger.info(`[${req.id}] Status gateway diminta`, status);
  }

  res.setHeader("Cache-Control", "no-store");
  res.json(status);
});

app.get("/api/qr", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (!qrCodeData) {
    return res.status(404).json({
      success: false,
      message: "QR code belum tersedia",
      requestId: req.id,
    });
  }

  return res.json({
    success: true,
    qrCodeData,
    updatedAt: qrUpdatedAt,
    requestId: req.id,
  });
});

app.use((err, req, res, next) => {
  logger.error(`[${req.id || "unknown"}] Unhandled error`, {
    error: err.message,
    stack: err.stack,
    url: req?.url,
    method: req?.method,
  });

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).json({
    success: false,
    message: "Internal Server Error",
    requestId: req?.id,
  });
});

const server = app.listen(PORT, HOST, () => {
  logger.info("WhatsApp Gateway server started", {
    host: HOST,
    port: PORT,
    environment: process.env.NODE_ENV || "development",
    timezone: process.env.TZ || "UTC",
    sendConcurrency: SEND_CONCURRENCY,
    maxQueueSize: MAX_QUEUE_SIZE,
    messageTimeoutMs: MESSAGE_TIMEOUT_MS,
  });
});

async function shutdown(signal) {
  logger.warn("Menerima sinyal shutdown", { signal });
  clearReconnectTimer();

  server.close(() => {
    logger.info("HTTP server berhenti");
  });

  setTimeout(() => {
    process.exit(0);
  }, 3000).unref();
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

connectToWhatsApp().catch((error) => {
  logger.error("Inisialisasi awal WhatsApp gagal", {
    error: error.message,
    stack: error.stack,
  });
});
