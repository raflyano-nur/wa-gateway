require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const qrcode = require("qrcode");
const morgan = require("morgan");
const winston = require("winston");
const multer = require("multer");
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");

const APP_NAME = process.env.APP_NAME || "WhatsApp Gateway";
const APP_VERSION =
  process.env.APP_VERSION || require("./package.json").version || "0.0.0";
const NODE_ENV = process.env.NODE_ENV || "development";
const ENV_FILE_PATH = path.join(__dirname, ".env");
const AUTH_DIR = process.env.WA_AUTH_DIR || "auth_info_baileys";
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, "logs");
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || "256kb";
const MESSAGE_TIMEOUT_MS = Number(process.env.MESSAGE_TIMEOUT_MS || 15000);
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
const MAX_FILE_SIZE_BYTES = Number(
  process.env.MAX_FILE_SIZE_BYTES || 16 * 1024 * 1024,
);
const SEND_CONCURRENCY = Math.max(1, Number(process.env.SEND_CONCURRENCY || 1));
const LOG_STATUS_CHECKS = process.env.LOG_STATUS_CHECKS === "true";
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const API_KEY = process.env.API_KEY || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const MAX_BROADCAST_TARGETS = Number(process.env.MAX_BROADCAST_TARGETS || 200);
const SCHEDULER_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 15000);

const SETTINGS_GROUPS = [
  {
    id: "server",
    label: "Server",
    fields: [
      { key: "PORT", label: "Port", type: "number", help: "Port HTTP server. Perlu restart untuk berubah." },
      { key: "HOST", label: "Host", type: "text", help: "Interface bind, contoh 0.0.0.0 untuk semua interface." },
      { key: "NODE_ENV", label: "Environment", type: "select", options: ["development", "production"], help: "Mode aplikasi." },
      { key: "APP_NAME", label: "Nama Aplikasi", type: "text", help: "Ditampilkan di judul halaman & dashboard." },
      { key: "APP_VERSION", label: "Versi Aplikasi", type: "text", help: "Ditampilkan di sidebar & /api/status. Kosongkan untuk memakai versi dari package.json." },
      { key: "TZ", label: "Timezone", type: "text", help: "Contoh: Asia/Jakarta." },
    ],
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    fields: [
      { key: "WA_AUTH_DIR", label: "Folder Sesi Auth", type: "text", help: "Lokasi penyimpanan sesi WhatsApp." },
      { key: "WA_SESSION_NAME", label: "Nama Sesi", type: "text", help: "Label sesi (opsional, untuk referensi)." },
    ],
  },
  {
    id: "storage",
    label: "Lokasi Penyimpanan",
    fields: [
      { key: "LOG_DIR", label: "Folder Log", type: "text", help: "Lokasi file logs/*.log. Arahkan ke folder di volume persisten kalau deploy di platform dengan filesystem sementara (mis. Railway)." },
      { key: "DATA_DIR", label: "Folder Data", type: "text", help: "Lokasi riwayat pesan & pesan terjadwal (data/*.json). Arahkan ke folder di volume persisten kalau deploy di platform dengan filesystem sementara." },
    ],
  },
  {
    id: "security",
    label: "Keamanan",
    fields: [
      { key: "API_KEY", label: "API Key", type: "password", help: "Wajib disertakan lewat header x-api-key saat memanggil /api/*. Kosongkan untuk menonaktifkan proteksi (tidak disarankan)." },
    ],
  },
  {
    id: "messaging",
    label: "Pengiriman Pesan & Upload",
    fields: [
      { key: "REQUEST_BODY_LIMIT", label: "Batas Ukuran Body", type: "text", help: "Contoh: 256kb." },
      { key: "MAX_FILE_SIZE_BYTES", label: "Batas Ukuran File (bytes)", type: "number", help: "Contoh: 16777216 (16MB)." },
      { key: "MESSAGE_TIMEOUT_MS", label: "Timeout Kirim Pesan (ms)", type: "number" },
      { key: "LOGOUT_TIMEOUT_MS", label: "Timeout Logout (ms)", type: "number" },
      { key: "SEND_CONCURRENCY", label: "Konkurensi Pengiriman", type: "number", help: "Jumlah pesan yang diproses bersamaan." },
      { key: "MAX_QUEUE_SIZE", label: "Kapasitas Antrean", type: "number" },
    ],
  },
  {
    id: "reconnect",
    label: "Reconnect WhatsApp",
    fields: [
      { key: "RECONNECT_BASE_DELAY_MS", label: "Delay Awal (ms)", type: "number" },
      { key: "RECONNECT_MAX_DELAY_MS", label: "Delay Maksimum (ms)", type: "number" },
    ],
  },
  {
    id: "dashboard",
    label: "Dashboard & Logging",
    fields: [
      { key: "STATUS_POLL_INTERVAL_MS", label: "Interval Polling Status (ms)", type: "number" },
      { key: "LOG_STATUS_CHECKS", label: "Log Setiap Cek Status", type: "select", options: ["true", "false"] },
      { key: "LOG_LEVEL", label: "Level Log", type: "select", options: ["error", "warn", "info", "http", "debug"] },
    ],
  },
  {
    id: "webhook",
    label: "Webhook Pesan Masuk",
    fields: [
      { key: "WEBHOOK_URL", label: "Webhook URL", type: "text", help: "URL tujuan POST setiap ada pesan WhatsApp masuk. Kosongkan untuk menonaktifkan." },
      { key: "WEBHOOK_SECRET", label: "Webhook Secret", type: "password", help: "Dikirim sebagai header x-webhook-secret, untuk verifikasi di sisi penerima (opsional)." },
    ],
  },
  {
    id: "broadcast",
    label: "Broadcast & Terjadwal",
    fields: [
      { key: "MAX_BROADCAST_TARGETS", label: "Maks Nomor per Broadcast", type: "number" },
      { key: "SCHEDULER_INTERVAL_MS", label: "Interval Cek Pesan Terjadwal (ms)", type: "number" },
    ],
  },
];

const SETTINGS_KEYS = new Set(
  SETTINGS_GROUPS.flatMap((group) => group.fields.map((field) => field.key)),
);

function readEnvFileContent() {
  try {
    return fs.readFileSync(ENV_FILE_PATH, "utf8");
  } catch {
    return "";
  }
}

function parseEnvContent(content) {
  const values = {};

  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    values[key] = value;
  });

  return values;
}

function writeEnvUpdates(updates) {
  const content = readEnvFileContent();
  const lines = content.length ? content.split(/\r?\n/) : [];
  const seenKeys = new Set();

  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      return line;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!Object.prototype.hasOwnProperty.call(updates, key)) {
      return line;
    }

    seenKeys.add(key);
    return `${key}=${updates[key]}`;
  });

  Object.keys(updates).forEach((key) => {
    if (!seenKeys.has(key)) {
      nextLines.push(`${key}=${updates[key]}`);
    }
  });

  fs.writeFileSync(ENV_FILE_PATH, nextLines.join("\n").replace(/\n+$/, "\n"));
}

const LOG_FILES = {
  combined: path.join(LOG_DIR, "combined.log"),
  error: path.join(LOG_DIR, "error.log"),
  whatsapp: path.join(LOG_DIR, "whatsapp.log"),
};

function readLogTail(type, limit) {
  const filePath = LOG_FILES[type] || LOG_FILES.combined;

  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  const tail = lines.slice(-limit);

  return tail.map((line) => {
    try {
      const parsed = JSON.parse(line);
      return {
        timestamp: parsed.timestamp || null,
        level: parsed.level || "info",
        message: parsed.message || line,
        meta: Object.fromEntries(
          Object.entries(parsed).filter(
            ([key]) => !["timestamp", "level", "message", "service"].includes(key),
          ),
        ),
      };
    } catch {
      return { timestamp: null, level: "info", message: line, meta: {} };
    }
  });
}

function buildRestartEnv() {
  const env = { ...process.env };
  SETTINGS_KEYS.forEach((key) => {
    delete env[key];
  });
  return env;
}

const IS_UNDER_PROCESS_MANAGER = Boolean(
  process.env.pm_id ||
    process.env.NODEMON ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PROJECT_ID ||
    process.env.DYNO, // Heroku-style dyno managers, same self-restart hazard
);

function scheduleRestart(reason) {
  logger.warn("Menjadwalkan restart server untuk menerapkan pengaturan baru", {
    reason,
    managedRestart: IS_UNDER_PROCESS_MANAGER,
  });

  setTimeout(() => {
    if (!IS_UNDER_PROCESS_MANAGER) {
      try {
        const child = spawn(process.execPath, process.argv.slice(1), {
          cwd: __dirname,
          detached: true,
          stdio: "ignore",
          env: buildRestartEnv(),
        });
        child.unref();
      } catch (error) {
        logger.error("Gagal menjalankan proses restart", {
          error: error.message,
          stack: error.stack,
        });
      }
    }

    // Under PM2/nodemon, just exit — the process manager restarts the
    // script itself and reloads .env, so spawning our own child here
    // would fight it for the port.
    process.exit(0);
  }, 400);
}

fs.mkdirSync(LOG_DIR, { recursive: true });

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "message-history.json");
const SCHEDULE_FILE = path.join(DATA_DIR, "scheduled-messages.json");
const SCHEDULED_UPLOADS_DIR = path.join(DATA_DIR, "scheduled-uploads");
const MAX_HISTORY_ENTRIES = 500;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SCHEDULED_UPLOADS_DIR, { recursive: true });

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

let messageHistory = readJsonFile(HISTORY_FILE, []);

function recordHistory(entry) {
  messageHistory.push({
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    ...entry,
  });

  if (messageHistory.length > MAX_HISTORY_ENTRIES) {
    messageHistory = messageHistory.slice(-MAX_HISTORY_ENTRIES);
  }

  writeJsonFile(HISTORY_FILE, messageHistory);
}

let scheduledMessages = readJsonFile(SCHEDULE_FILE, []);

function saveScheduledMessages() {
  writeJsonFile(SCHEDULE_FILE, scheduledMessages);
}

async function dispatchWebhook(payload) {
  if (!WEBHOOK_URL) {
    return;
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (WEBHOOK_SECRET) {
      headers["x-webhook-secret"] = WEBHOOK_SECRET;
    }

    await withTimeout(
      fetch(WEBHOOK_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }),
      8000,
      "Webhook",
    );

    logger.info("Webhook pesan masuk terkirim", {
      to: WEBHOOK_URL,
      messageId: payload.messageId,
    });
  } catch (error) {
    logger.warn("Webhook pesan masuk gagal terkirim", {
      to: WEBHOOK_URL,
      error: error.message,
    });
  }
}

function extractIncomingText(message) {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ""
  );
}

async function processScheduledMessages() {
  if (!isConnected || !sock) {
    return;
  }

  const now = Date.now();
  const due = scheduledMessages.filter(
    (job) => job.status === "pending" && new Date(job.sendAt).getTime() <= now,
  );

  if (!due.length) {
    return;
  }

  for (const job of due) {
    try {
      let content;

      if (job.file) {
        const buffer = fs.readFileSync(job.file.path);
        content = buildMediaMessage(
          { buffer, mimetype: job.file.mimetype, originalname: job.file.fileName },
          job.message,
        );
      } else {
        content = { text: job.message };
      }

      const { result } = await enqueueMessageSend({ jid: job.jid, content });

      job.status = "sent";
      job.sentAt = new Date().toISOString();
      job.messageId = result?.key?.id;

      recordHistory({
        source: "scheduled",
        to: maskDestination(job.jid),
        type: job.file ? (job.message ? "file+text" : "file") : "text",
        message: (job.message || "").slice(0, 120),
        status: "sent",
        messageId: result?.key?.id,
      });

      logger.info("Pesan terjadwal terkirim", { id: job.id, to: maskDestination(job.jid) });
    } catch (error) {
      job.status = "failed";
      job.error = error.message;

      recordHistory({
        source: "scheduled",
        to: maskDestination(job.jid),
        type: job.file ? (job.message ? "file+text" : "file") : "text",
        message: (job.message || "").slice(0, 120),
        status: "failed",
        error: error.message,
      });

      logger.error("Pesan terjadwal gagal dikirim", {
        id: job.id,
        to: maskDestination(job.jid),
        error: error.message,
      });
    }

    if (job.file) {
      fs.promises.unlink(job.file.path).catch(() => {});
    }
  }

  saveScheduledMessages();
}

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
      filename: path.join(LOG_DIR, "error.log"),
      level: "error",
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, "combined.log"),
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, "whatsapp.log"),
      maxsize: 5242880,
      maxFiles: 3,
    }),
  ],
});

if (NODE_ENV !== "production") {
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

const DASHBOARD_API_PATHS = new Set(["/status", "/qr", "/logout", "/test-chat"]);

app.use("/api", (req, res, next) => {
  if (DASHBOARD_API_PATHS.has(req.path)) {
    return next();
  }
  return requireApiKey(req, res, next);
});

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

function renderEnvBadge() {
  const isProduction = NODE_ENV === "production";
  const label = isProduction ? "Production" : "Local / Dev";
  const tone = isProduction
    ? "bg-emerald-100 text-emerald-700"
    : "bg-amber-100 text-amber-700";

  return `<span class="inline-flex shrink-0 items-center rounded-full ${tone} px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">${label}</span>`;
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

function normalizeOptionalCaption(caption) {
  if (caption === undefined || caption === null) {
    return "";
  }

  if (typeof caption !== "string") {
    throw new Error("Caption wajib berupa teks");
  }

  return caption.trim();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

function buildMediaMessage(file, caption) {
  const mimetype = file.mimetype || "application/octet-stream";
  const fileName = file.originalname || "file";
  const captionText = caption || undefined;

  if (mimetype.startsWith("image/")) {
    return { image: file.buffer, mimetype, caption: captionText };
  }

  if (mimetype.startsWith("video/")) {
    return { video: file.buffer, mimetype, caption: captionText };
  }

  if (mimetype.startsWith("audio/")) {
    return { audio: file.buffer, mimetype, ptt: false };
  }

  return {
    document: file.buffer,
    mimetype,
    fileName,
    caption: captionText,
  };
}

function getClientIp(req) {
  return (
    req.ip ||
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return next();
  }

  const providedKey = req.get("x-api-key") || "";
  const isValid =
    providedKey.length === API_KEY.length &&
    crypto.timingSafeEqual(Buffer.from(providedKey), Buffer.from(API_KEY));

  if (!isValid) {
    logger.warn(`[${req.id}] API key ditolak`, {
      clientIp: getClientIp(req),
      path: req.path,
    });

    return res.status(401).json({
      success: false,
      message: "API key tidak valid",
      requestId: req.id,
    });
  }

  return next();
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
    version: APP_VERSION,
    environment: NODE_ENV,
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

      if (
          !sock ||
          !isConnected ||
          !sock.user ||
          !sock.ws?.isOpen
      ) {
          const notConnectedError = new Error("WhatsApp belum terhubung");
          notConnectedError.code = "NOT_CONNECTED";
          throw notConnectedError;
      }

      const sendStartedAt = Date.now();

      const result = await withTimeout(
          sock.sendMessage(task.jid, task.content),
          MESSAGE_TIMEOUT_MS,
          "Pengiriman pesan"
      );

      return {
        result,
        queueDelayMs,
        sendDurationMs: Date.now() - sendStartedAt,
      };
    })()
      .then(task.resolve)
      .catch((err) => {
          if (err.message.includes("timeout")) {
              logger.warn("Send timeout, reconnecting WhatsApp");

              isConnected = false;

              try {
                  sock?.end?.();
              } catch {}

              scheduleReconnect("send_timeout");
          }

          task.reject(err);
      })
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
    const { version, isLatest } = await fetchLatestBaileysVersion();

    logger.info("Versi WA Web dipakai", { version, isLatest });

    sock = makeWASocket({
      version,                    // add this line
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

      logger.error("Koneksi WhatsApp terputus", {
          reason,
          shouldReconnect,
          disconnect: lastDisconnect,
          error: disconnectError,
      });

      console.log("===== CONNECTION CLOSED =====");
      console.dir(lastDisconnect, { depth: null });
      console.log("=============================");

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

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (currentGeneration !== socketGeneration || type !== "notify" || !WEBHOOK_URL) {
        return;
      }

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) {
          continue;
        }

        dispatchWebhook({
          from: msg.key.remoteJid,
          fromMasked: maskDestination(msg.key.remoteJid),
          pushName: msg.pushName || null,
          messageId: msg.key.id,
          timestamp: Number(msg.messageTimestamp) * 1000,
          type: Object.keys(msg.message)[0] || "unknown",
          text: extractIncomingText(msg.message),
        });
      }
    });

    sock.ws.on("close", () => {
        logger.warn("WebSocket closed");
        isConnected = false;
    });

    sock.ws.on("error", (err) => {
        logger.error("WebSocket error", {
            error: err.message,
        });

        isConnected = false;
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
  const maxFileMb = Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024);

  return `<!doctype html>
<html lang="id" class="h-full">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${APP_NAME}</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="h-full overflow-hidden bg-slate-100 text-slate-800">
    <div class="flex h-full">
        <aside class="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white sm:flex">
            <div class="flex items-center gap-2.5 border-b border-slate-200 px-5 py-4">
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 2C6.48 2 2 6.15 2 11.27c0 2.62 1.18 5 3.11 6.7-.1 1.02-.4 2.6-1.11 3.94 1.6-.14 3.34-.7 4.55-1.42 1.09.32 2.26.5 3.45.5 5.52 0 10-4.15 10-9.27C22 6.15 17.52 2 12 2z"/>
                    </svg>
                </span>
                <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                        <p class="truncate text-sm font-bold text-slate-900">${APP_NAME}</p>
                        ${renderEnvBadge()}
                    </div>
                    <p class="truncate text-xs text-slate-400">Gateway Panel <span class="text-slate-300">&middot;</span> v${escapeHtml(APP_VERSION)}</p>
                </div>
            </div>

            <nav class="flex-1 space-y-1 p-3">
                <button type="button" data-page-tab="dashboard" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
                    Dashboard
                </button>
                <button type="button" data-page-tab="send" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>
                    Kirim Pesan
                </button>
                <button type="button" data-page-tab="broadcast" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>
                    Broadcast
                </button>
                <button type="button" data-page-tab="schedule" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M12 14v3l2 1.5"/></svg>
                    Terjadwal
                </button>
                <button type="button" data-page-tab="history" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M3 3v5h5"/><path d="M3.05 13a9 9 0 1 0 2.13-6.36L3 8"/><path d="M12 7v5l4 2"/></svg>
                    Riwayat
                </button>
                <button type="button" data-page-tab="logs" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>
                    Logs
                </button>
                <button type="button" data-page-tab="settings" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                    Pengaturan
                </button>
                <a href="/docs" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-slate-600 transition hover:bg-slate-100">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                    API Documentation
                </a>
            </nav>

            <div class="border-t border-slate-200 p-3">
                <a href="/api/status" target="_blank" rel="noreferrer" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs font-medium text-slate-400 transition hover:bg-slate-100 hover:text-slate-600">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                    Lihat JSON Status
                </a>
            </div>
        </aside>

        <div class="flex min-w-0 flex-1 flex-col">
            <header class="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
                <div class="flex items-center gap-2.5 sm:hidden">
                    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.15 2 11.27c0 2.62 1.18 5 3.11 6.7-.1 1.02-.4 2.6-1.11 3.94 1.6-.14 3.34-.7 4.55-1.42 1.09.32 2.26.5 3.45.5 5.52 0 10-4.15 10-9.27C22 6.15 17.52 2 12 2z"/></svg>
                    </span>
                    <p class="text-sm font-bold text-slate-900">${APP_NAME}</p>
                    ${renderEnvBadge()}
                </div>
                <h1 id="pageTitle" class="hidden text-base font-semibold text-slate-800 sm:block">Dashboard</h1>
                <div id="statusBadge" class="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3.5 py-1.5 text-xs font-semibold text-amber-700 sm:text-sm">
                    Memeriksa status...
                </div>
            </header>

            <nav class="flex gap-1.5 overflow-x-auto border-b border-slate-200 bg-white px-4 py-2 sm:hidden">
                <button type="button" data-page-tab="dashboard" class="page-tab shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition">Dashboard</button>
                <button type="button" data-page-tab="send" class="page-tab shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition">Kirim Pesan</button>
                <button type="button" data-page-tab="broadcast" class="page-tab shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition">Broadcast</button>
                <button type="button" data-page-tab="schedule" class="page-tab shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition">Terjadwal</button>
                <button type="button" data-page-tab="history" class="page-tab shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition">Riwayat</button>
                <button type="button" data-page-tab="logs" class="page-tab shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition">Logs</button>
                <button type="button" data-page-tab="settings" class="page-tab shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition">Pengaturan</button>
            </nav>

            <main class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
                <section id="page-dashboard" class="page-panel mx-auto max-w-4xl">
                    <div class="grid gap-4 lg:grid-cols-[minmax(0,240px)_1fr]">
                        <div class="flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white p-5">
                            <img id="qrImage" alt="QR WhatsApp" class="hidden w-full max-w-[200px] rounded-lg border border-slate-200 bg-white p-2">
                            <p id="qrText" class="text-center text-sm text-slate-500">Menunggu status koneksi terbaru...</p>
                        </div>

                        <div class="grid grid-cols-2 gap-3 content-start">
                            <div class="rounded-xl border border-slate-200 bg-white p-3.5">
                                <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Status</p>
                                <p id="connState" class="mt-1.5 text-sm font-medium text-slate-700">-</p>
                            </div>
                            <div class="rounded-xl border border-slate-200 bg-white p-3.5">
                                <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Antrean</p>
                                <p id="queueState" class="mt-1.5 text-sm font-medium text-slate-700">-</p>
                            </div>
                            <div class="rounded-xl border border-slate-200 bg-white p-3.5">
                                <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Reconnect</p>
                                <p id="reconnectState" class="mt-1.5 text-sm font-medium text-slate-700">-</p>
                            </div>
                            <div class="rounded-xl border border-slate-200 bg-white p-3.5">
                                <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Update</p>
                                <p id="updatedAt" class="mt-1.5 text-sm font-medium text-slate-700">-</p>
                            </div>

                            <div class="col-span-2 flex flex-wrap gap-2">
                                <button id="testChatButton" type="button" class="inline-flex h-9 items-center justify-center rounded-lg bg-slate-100 px-4 text-xs font-semibold text-slate-700 hover:bg-slate-200 transition">Test Chat</button>
                                <button id="logoutButton" type="button" class="inline-flex h-9 items-center justify-center rounded-lg bg-red-50 px-4 text-xs font-semibold text-red-600 hover:bg-red-100 transition">Ganti Akun WA</button>
                            </div>
                        </div>
                    </div>

                    <p class="mt-4 text-xs leading-relaxed text-slate-400">Tombol ganti akun akan logout perangkat tertaut saat ini, menghapus folder <code class="rounded bg-slate-100 px-1 py-0.5">${escapeHtml(AUTH_DIR)}</code>, lalu menyiapkan QR untuk akun baru.</p>

                    <section class="mt-5 rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Embed Widget QR</h2>
                        <p class="mt-1 text-xs text-slate-500">Tempel kode ini di website lain untuk menampilkan status &amp; QR scan WhatsApp.</p>
                        <textarea id="embedCode" rows="3" readonly class="mt-3 w-full resize-none rounded-lg border border-slate-200 bg-slate-50 p-2.5 font-mono text-xs text-slate-600"></textarea>
                        <button id="copyEmbedButton" type="button" class="mt-2 inline-flex h-8 items-center justify-center rounded-lg bg-slate-100 px-3.5 text-xs font-semibold text-slate-700 hover:bg-slate-200 transition">Salin Kode</button>
                    </section>
                </section>

                <section id="page-send" class="page-panel mx-auto max-w-2xl hidden">
                    <div class="flex gap-1.5 rounded-xl bg-slate-100 p-1.5">
                        <button type="button" data-mode="text" class="mode-tab flex-1 rounded-lg py-2 text-sm font-semibold transition">Teks Saja</button>
                        <button type="button" data-mode="file" class="mode-tab flex-1 rounded-lg py-2 text-sm font-semibold transition">File Saja</button>
                        <button type="button" data-mode="both" class="mode-tab flex-1 rounded-lg py-2 text-sm font-semibold transition">File + Teks</button>
                    </div>

                    <div id="sendAlert" class="mt-4 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

                    <form id="sendForm" class="mt-5 rounded-xl border border-slate-200 bg-white p-4">
                        <label for="number" class="block text-sm font-semibold text-slate-700">Nomor Tujuan</label>
                        <input id="number" type="text" name="number" placeholder="628123456789" required
                            class="mt-2 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                        <p class="mt-1.5 text-xs text-slate-400">Boleh tulis dengan atau tanpa tanda plus. Nomor akan dirapikan otomatis.</p>

                        <div id="fileField" class="mt-4 hidden">
                            <label for="file" class="block text-sm font-semibold text-slate-700">Berkas</label>
                            <input id="file" type="file" name="file"
                                class="mt-2 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-emerald-50 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-emerald-700 hover:file:bg-emerald-100">
                            <p class="mt-1.5 text-xs text-slate-400">Gambar, video, audio, atau dokumen. Maks ${maxFileMb}MB. Tipe media terdeteksi otomatis.</p>
                        </div>

                        <div id="messageField" class="mt-4">
                            <label for="message" class="block text-sm font-semibold text-slate-700"><span id="messageLabel">Pesan</span></label>
                            <textarea id="message" name="message" placeholder="Tulis pesan Anda di sini..."
                                class="mt-2 min-h-[110px] w-full resize-y rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"></textarea>
                        </div>

                        <div class="mt-5 flex flex-wrap gap-2.5">
                            <button id="sendSubmitButton" type="submit" class="inline-flex h-11 items-center justify-center rounded-xl bg-emerald-600 px-6 text-sm font-semibold text-white hover:bg-emerald-700 transition">Kirim Sekarang</button>
                        </div>
                    </form>
                </section>

                <section id="page-broadcast" class="page-panel mx-auto max-w-2xl hidden">
                    <div id="broadcastGate" class="rounded-xl border border-slate-200 bg-white p-4">
                        <label for="broadcastApiKey" class="block text-sm font-semibold text-slate-700">API Key</label>
                        <p class="mt-1 text-xs text-slate-400">Dibutuhkan untuk mengirim broadcast. Tersimpan hanya di sesi browser ini.</p>
                        <div class="mt-2 flex gap-2">
                            <input id="broadcastApiKey" type="password" placeholder="Masukkan API key (kosongkan jika API_KEY belum diset)"
                                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            <button id="broadcastUnlockButton" type="button" class="inline-flex h-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Buka</button>
                        </div>
                        <p id="broadcastGateError" class="mt-2 hidden text-xs font-medium text-red-600"></p>
                    </div>

                    <div id="broadcastAlert" class="mt-4 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

                    <form id="broadcastForm" class="mt-4 hidden rounded-xl border border-slate-200 bg-white p-4">
                        <label for="broadcastNumbers" class="block text-sm font-semibold text-slate-700">Daftar Nomor Tujuan</label>
                        <textarea id="broadcastNumbers" name="numbers" required placeholder="628123456789&#10;628987654321&#10;atau pisahkan dengan koma"
                            class="mt-2 min-h-[110px] w-full resize-y rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"></textarea>
                        <p class="mt-1.5 text-xs text-slate-400">Satu nomor per baris, atau pisahkan dengan koma. Maksimum ${MAX_BROADCAST_TARGETS} nomor.</p>

                        <div class="mt-4">
                            <label for="broadcastFile" class="block text-sm font-semibold text-slate-700">Berkas (opsional)</label>
                            <input id="broadcastFile" type="file" name="file"
                                class="mt-2 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-emerald-50 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-emerald-700 hover:file:bg-emerald-100">
                        </div>

                        <div class="mt-4">
                            <label for="broadcastMessage" class="block text-sm font-semibold text-slate-700">Pesan / Caption</label>
                            <textarea id="broadcastMessage" name="message" placeholder="Tulis pesan Anda di sini..."
                                class="mt-2 min-h-[110px] w-full resize-y rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"></textarea>
                        </div>

                        <div class="mt-5 flex flex-wrap gap-2.5">
                            <button id="broadcastSubmitButton" type="submit" class="inline-flex h-11 items-center justify-center rounded-xl bg-emerald-600 px-6 text-sm font-semibold text-white hover:bg-emerald-700 transition">Kirim Broadcast</button>
                        </div>
                    </form>
                </section>

                <section id="page-schedule" class="page-panel mx-auto max-w-4xl hidden">
                    <div id="scheduleGate" class="rounded-xl border border-slate-200 bg-white p-4">
                        <label for="scheduleApiKey" class="block text-sm font-semibold text-slate-700">API Key</label>
                        <p class="mt-1 text-xs text-slate-400">Dibutuhkan untuk membuat & melihat pesan terjadwal. Tersimpan hanya di sesi browser ini.</p>
                        <div class="mt-2 flex gap-2">
                            <input id="scheduleApiKey" type="password" placeholder="Masukkan API key (kosongkan jika API_KEY belum diset)"
                                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            <button id="scheduleUnlockButton" type="button" class="inline-flex h-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Buka</button>
                        </div>
                        <p id="scheduleGateError" class="mt-2 hidden text-xs font-medium text-red-600"></p>
                    </div>

                    <div id="schedulePanel" class="mt-4 hidden">
                        <div id="scheduleAlert" class="mb-4 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

                        <form id="scheduleForm" class="rounded-xl border border-slate-200 bg-white p-4">
                            <div class="grid gap-4 sm:grid-cols-2">
                                <div>
                                    <label for="scheduleNumber" class="block text-sm font-semibold text-slate-700">Nomor Tujuan</label>
                                    <input id="scheduleNumber" type="text" name="number" required placeholder="628123456789"
                                        class="mt-2 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                                </div>
                                <div>
                                    <label for="scheduleSendAt" class="block text-sm font-semibold text-slate-700">Waktu Kirim</label>
                                    <input id="scheduleSendAt" type="datetime-local" name="sendAt" required
                                        class="mt-2 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                                </div>
                            </div>

                            <div class="mt-4">
                                <label for="scheduleFile" class="block text-sm font-semibold text-slate-700">Berkas (opsional)</label>
                                <input id="scheduleFile" type="file" name="file"
                                    class="mt-2 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-emerald-50 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-emerald-700 hover:file:bg-emerald-100">
                            </div>

                            <div class="mt-4">
                                <label for="scheduleMessage" class="block text-sm font-semibold text-slate-700">Pesan / Caption</label>
                                <textarea id="scheduleMessage" name="message" placeholder="Tulis pesan Anda di sini..."
                                    class="mt-2 min-h-[90px] w-full resize-y rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"></textarea>
                            </div>

                            <div class="mt-5 flex flex-wrap gap-2.5">
                                <button id="scheduleSubmitButton" type="submit" class="inline-flex h-11 items-center justify-center rounded-xl bg-emerald-600 px-6 text-sm font-semibold text-white hover:bg-emerald-700 transition">Jadwalkan</button>
                            </div>
                        </form>

                        <div class="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white">
                            <table class="w-full text-sm">
                                <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        <th class="px-4 py-2 text-left">Tujuan</th>
                                        <th class="px-4 py-2 text-left">Pesan</th>
                                        <th class="px-4 py-2 text-left">Waktu Kirim</th>
                                        <th class="px-4 py-2 text-left">Status</th>
                                        <th class="px-4 py-2 text-left"></th>
                                    </tr>
                                </thead>
                                <tbody id="scheduleTableBody" class="divide-y divide-slate-200">
                                    <tr><td class="px-4 py-3 text-slate-400" colspan="5">Memuat...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>

                <section id="page-history" class="page-panel mx-auto flex h-full max-w-4xl flex-col hidden">
                    <div id="historyGate" class="rounded-xl border border-slate-200 bg-white p-4">
                        <label for="historyApiKey" class="block text-sm font-semibold text-slate-700">API Key</label>
                        <p class="mt-1 text-xs text-slate-400">Dibutuhkan untuk melihat riwayat pengiriman. Tersimpan hanya di sesi browser ini.</p>
                        <div class="mt-2 flex gap-2">
                            <input id="historyApiKey" type="password" placeholder="Masukkan API key (kosongkan jika API_KEY belum diset)"
                                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            <button id="historyUnlockButton" type="button" class="inline-flex h-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Buka</button>
                        </div>
                        <p id="historyGateError" class="mt-2 hidden text-xs font-medium text-red-600"></p>
                    </div>

                    <div id="historyPanel" class="mt-4 flex min-h-0 flex-1 flex-col hidden">
                        <div class="flex items-center gap-2">
                            <button id="historyRefreshButton" type="button" class="inline-flex h-9 items-center justify-center rounded-lg bg-slate-100 px-4 text-xs font-semibold text-slate-700 hover:bg-slate-200 transition">Refresh</button>
                            <p id="historyCount" class="text-xs text-slate-400"></p>
                        </div>
                        <div class="mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl border border-slate-200 bg-white">
                            <table class="w-full text-sm">
                                <thead class="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        <th class="px-4 py-2 text-left">Waktu</th>
                                        <th class="px-4 py-2 text-left">Sumber</th>
                                        <th class="px-4 py-2 text-left">Tujuan</th>
                                        <th class="px-4 py-2 text-left">Tipe</th>
                                        <th class="px-4 py-2 text-left">Pesan</th>
                                        <th class="px-4 py-2 text-left">Status</th>
                                    </tr>
                                </thead>
                                <tbody id="historyTableBody" class="divide-y divide-slate-200">
                                    <tr><td class="px-4 py-3 text-slate-400" colspan="6">Memuat...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>

                <section id="page-logs" class="page-panel mx-auto flex h-full max-w-4xl flex-col hidden">
                    <div id="logsGate" class="rounded-xl border border-slate-200 bg-white p-4">
                        <label for="logsApiKey" class="block text-sm font-semibold text-slate-700">API Key</label>
                        <p class="mt-1 text-xs text-slate-400">Dibutuhkan untuk membaca log server. Tersimpan hanya di sesi browser ini.</p>
                        <div class="mt-2 flex gap-2">
                            <input id="logsApiKey" type="password" placeholder="Masukkan API key (kosongkan jika API_KEY belum diset)"
                                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            <button id="logsUnlockButton" type="button" class="inline-flex h-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Buka</button>
                        </div>
                        <p id="logsGateError" class="mt-2 hidden text-xs font-medium text-red-600"></p>
                    </div>

                    <div id="logsPanel" class="mt-4 flex min-h-0 flex-1 flex-col hidden">
                        <div class="flex flex-wrap items-center gap-2">
                            <select id="logsType" class="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                                <option value="combined">Combined</option>
                                <option value="error">Error</option>
                                <option value="whatsapp">WhatsApp</option>
                            </select>
                            <button id="logsRefreshButton" type="button" class="inline-flex h-9 items-center justify-center rounded-lg bg-slate-100 px-4 text-xs font-semibold text-slate-700 hover:bg-slate-200 transition">Refresh</button>
                            <label class="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
                                <input id="logsAutoRefresh" type="checkbox" class="rounded" checked>
                                Auto-refresh
                            </label>
                            <button id="logsRelockButton" type="button" class="ml-auto inline-flex h-9 items-center justify-center rounded-lg bg-slate-100 px-4 text-xs font-semibold text-slate-700 hover:bg-slate-200 transition">Kunci</button>
                        </div>
                        <div id="logsConsole" class="mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl bg-slate-950 p-3 font-mono text-xs leading-relaxed text-emerald-300">
                            <p class="text-slate-500">Memuat log...</p>
                        </div>
                    </div>
                </section>

                <section id="page-settings" class="page-panel mx-auto max-w-3xl hidden">
                    <div id="settingsGate" class="rounded-xl border border-slate-200 bg-white p-4">
                        <label for="settingsApiKey" class="block text-sm font-semibold text-slate-700">API Key</label>
                        <p class="mt-1 text-xs text-slate-400">Dibutuhkan untuk membaca & menyimpan pengaturan .env. Tersimpan hanya di sesi browser ini.</p>
                        <div class="mt-2 flex gap-2">
                            <input id="settingsApiKey" type="password" placeholder="Masukkan API key (kosongkan jika API_KEY belum diset)"
                                class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            <button id="settingsUnlockButton" type="button" class="inline-flex h-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Buka</button>
                        </div>
                        <p id="settingsGateError" class="mt-2 hidden text-xs font-medium text-red-600"></p>
                    </div>

                    <div id="settingsAlert" class="mt-4 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

                    <form id="settingsForm" class="mt-4 hidden space-y-4">
                        <div id="settingsGroups"></div>
                        <div class="flex flex-wrap items-center gap-2.5">
                            <button id="settingsSaveButton" type="submit" class="inline-flex h-11 items-center justify-center rounded-xl bg-emerald-600 px-6 text-sm font-semibold text-white hover:bg-emerald-700 transition">Simpan Pengaturan</button>
                            <p class="text-xs text-slate-400">Beberapa perubahan baru berlaku penuh setelah server di-restart.</p>
                        </div>
                    </form>
                </section>
            </main>
        </div>
    </div>

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
        const testChatButton = document.getElementById('testChatButton');

        let lastQrUpdatedAt = 0;

        const BADGE_TONE = {
            waiting: 'bg-amber-50 text-amber-700',
            connected: 'bg-emerald-50 text-emerald-700',
            disconnected: 'bg-red-50 text-red-700',
        };

        function setBadge(label, mode) {
            statusBadge.textContent = label;
            statusBadge.className = 'inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold ' + (BADGE_TONE[mode] || BADGE_TONE.waiting);
        }

        function syncLogoutButton(isBusy) {
            logoutButton.disabled = isBusy;
            logoutButton.classList.toggle('opacity-60', isBusy);
            logoutButton.classList.toggle('cursor-wait', isBusy);
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
                    qrImage.classList.add('hidden');
                    qrText.classList.remove('hidden');
                    qrText.textContent = 'Perangkat tertaut sedang diputus dan sesi lama sedang dibersihkan.';
                } else if (data.connected) {
                    setBadge('WhatsApp terhubung dan siap kirim', 'connected');
                    qrImage.classList.add('hidden');
                    qrText.classList.remove('hidden');
                    qrText.textContent = 'Perangkat aktif dan siap dipakai.';
                } else if (data.hasQR) {
                    setBadge('QR siap dipindai', 'waiting');
                    qrText.textContent = 'Scan QR ini dari WhatsApp di ponsel Anda.';

                    if (lastQrUpdatedAt !== data.qrUpdatedAt) {
                        const qrResponse = await fetch('/api/qr', { cache: 'no-store' });
                        const qrData = await qrResponse.json();
                        qrImage.src = qrData.qrCodeData;
                        qrImage.classList.remove('hidden');
                        qrText.classList.add('hidden');
                        lastQrUpdatedAt = data.qrUpdatedAt;
                    }
                } else if (data.lastDisconnectReason === 401) {
                    setBadge('Sesi logout, perlu scan ulang', 'disconnected');
                    qrImage.classList.add('hidden');
                    qrText.classList.remove('hidden');
                    qrText.textContent = 'Sesi WhatsApp keluar. Tunggu QR baru lalu scan ulang.';
                } else {
                    setBadge('Sedang menyambungkan WhatsApp...', 'waiting');
                    qrImage.classList.add('hidden');
                    qrText.classList.remove('hidden');
                    qrText.textContent = 'Koneksi sedang dipulihkan. Halaman ini akan update otomatis.';
                }
            } catch (error) {
                syncLogoutButton(false);
                setBadge('Status gateway belum bisa diambil', 'disconnected');
                qrImage.classList.add('hidden');
                qrText.classList.remove('hidden');
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
            qrImage.classList.add('hidden');
            qrText.classList.remove('hidden');
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

        testChatButton.addEventListener('click', async () => {
            if (testChatButton.disabled) {
                return;
            }

            testChatButton.disabled = true;
            testChatButton.classList.add('opacity-60', 'cursor-wait');
            testChatButton.textContent = 'Mengirim...';

            try {
                const response = await fetch('/api/test-chat', { method: 'POST' });
                const data = await response.json();

                if (!response.ok || !data.success) {
                    throw new Error(data.message || 'Test chat gagal dikirim');
                }

                window.alert('Test chat berhasil dikirim ke ' + data.to);
            } catch (error) {
                window.alert('Test chat gagal: ' + error.message);
            } finally {
                testChatButton.disabled = false;
                testChatButton.classList.remove('opacity-60', 'cursor-wait');
                testChatButton.textContent = 'Test Chat';
            }
        });

        const embedCode = document.getElementById('embedCode');
        const copyEmbedButton = document.getElementById('copyEmbedButton');
        const embedSnippet = '<iframe\\n  src="' + location.origin + '/widget"\\n  width="280"\\n  height="320"\\n  scrolling="no"\\n  style="border: none; overflow: hidden; display: block; margin: 0 auto;">\\n</iframe>';
        embedCode.value = embedSnippet;

        copyEmbedButton.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(embedSnippet);
                copyEmbedButton.textContent = 'Tersalin!';
            } catch (error) {
                embedCode.select();
                document.execCommand('copy');
                copyEmbedButton.textContent = 'Tersalin!';
            } finally {
                setTimeout(() => {
                    copyEmbedButton.textContent = 'Salin Kode';
                }, 1800);
            }
        });

        refreshStatus();
        setInterval(refreshStatus, pollIntervalMs);

        // --- Page-level tabs (Dashboard / Kirim Pesan) ---
        const pageTabs = document.querySelectorAll('.page-tab');
        const pagePanels = document.querySelectorAll('.page-panel');
        const pageTitle = document.getElementById('pageTitle');
        const PAGE_TITLES = {
            dashboard: 'Dashboard',
            send: 'Kirim Pesan',
            broadcast: 'Broadcast',
            schedule: 'Terjadwal',
            history: 'Riwayat',
            logs: 'Logs',
            settings: 'Pengaturan',
        };

        function activatePage(id) {
            pageTabs.forEach((tab) => {
                const active = tab.dataset.pageTab === id;
                tab.classList.toggle('bg-emerald-50', active);
                tab.classList.toggle('text-emerald-700', active);
                tab.classList.toggle('text-slate-600', !active);
                tab.classList.toggle('hover:bg-slate-100', !active);
            });
            pagePanels.forEach((panel) => {
                panel.classList.toggle('hidden', panel.id !== 'page-' + id);
            });
            if (pageTitle) {
                pageTitle.textContent = PAGE_TITLES[id] || '';
            }
            if (history.replaceState) {
                history.replaceState(null, '', id === 'send' ? '#send' : '#');
            }
        }

        pageTabs.forEach((tab) => {
            tab.addEventListener('click', () => activatePage(tab.dataset.pageTab));
        });

        activatePage(location.hash === '#send' ? 'send' : 'dashboard');

        // --- Send mode tabs (Teks / File / File + Teks) ---
        const modeTabs = document.querySelectorAll('.mode-tab');
        const fileField = document.getElementById('fileField');
        const messageField = document.getElementById('messageField');
        const messageLabel = document.getElementById('messageLabel');
        const fileInput = document.getElementById('file');
        const messageInput = document.getElementById('message');

        function applyMode(mode) {
            modeTabs.forEach((tab) => {
                const active = tab.dataset.mode === mode;
                tab.classList.toggle('bg-white', active);
                tab.classList.toggle('shadow', active);
                tab.classList.toggle('text-emerald-700', active);
                tab.classList.toggle('text-slate-500', !active);
            });

            if (mode === 'text') {
                fileField.classList.add('hidden');
                messageField.classList.remove('hidden');
                messageLabel.textContent = 'Pesan';
                messageInput.required = true;
                fileInput.required = false;
                fileInput.value = '';
            } else if (mode === 'file') {
                fileField.classList.remove('hidden');
                messageField.classList.add('hidden');
                messageInput.required = false;
                fileInput.required = true;
                messageInput.value = '';
            } else {
                fileField.classList.remove('hidden');
                messageField.classList.remove('hidden');
                messageLabel.textContent = 'Caption (opsional)';
                messageInput.required = false;
                fileInput.required = true;
            }
        }

        modeTabs.forEach((tab) => {
            tab.addEventListener('click', () => applyMode(tab.dataset.mode));
        });

        applyMode('text');

        // --- Send form submit (AJAX, stays on the same page) ---
        const sendForm = document.getElementById('sendForm');
        const sendAlert = document.getElementById('sendAlert');
        const sendSubmitButton = document.getElementById('sendSubmitButton');

        function showAlert(message, isError) {
            sendAlert.textContent = message;
            sendAlert.className = 'mt-4 rounded-xl px-4 py-3 text-sm font-medium ' +
                (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
        }

        sendForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            sendSubmitButton.disabled = true;
            sendSubmitButton.classList.add('opacity-60', 'cursor-wait');
            sendSubmitButton.textContent = 'Mengirim...';
            sendAlert.classList.add('hidden');

            try {
                const response = await fetch('/send-message', {
                    method: 'POST',
                    headers: { Accept: 'application/json' },
                    body: new FormData(sendForm),
                });
                const data = await response.json();

                if (!response.ok || !data.success) {
                    throw new Error(data.message || 'Pengiriman gagal');
                }

                showAlert(data.message, false);
                sendForm.reset();
                applyMode(document.querySelector('.mode-tab.bg-white')?.dataset.mode || 'text');
            } catch (error) {
                showAlert(error.message, true);
            } finally {
                sendSubmitButton.disabled = false;
                sendSubmitButton.classList.remove('opacity-60', 'cursor-wait');
                sendSubmitButton.textContent = 'Kirim Sekarang';
            }
        });

        // --- Shared helper: authenticated fetch using an API key kept in sessionStorage ---
        function apiKeyFetch(url, storageKey, options) {
            const key = sessionStorage.getItem(storageKey) || '';
            const headers = Object.assign({}, (options && options.headers) || {});
            if (key) {
                headers['x-api-key'] = key;
            }
            return fetch(url, Object.assign({}, options, { headers }));
        }

        // --- Logs tab ---
        const logsGate = document.getElementById('logsGate');
        const logsPanel = document.getElementById('logsPanel');
        const logsApiKeyInput = document.getElementById('logsApiKey');
        const logsUnlockButton = document.getElementById('logsUnlockButton');
        const logsGateError = document.getElementById('logsGateError');
        const logsType = document.getElementById('logsType');
        const logsRefreshButton = document.getElementById('logsRefreshButton');
        const logsAutoRefresh = document.getElementById('logsAutoRefresh');
        const logsRelockButton = document.getElementById('logsRelockButton');
        const logsConsole = document.getElementById('logsConsole');
        let logsTimer = null;

        const LOG_LEVEL_COLOR = {
            error: 'text-red-400',
            warn: 'text-amber-300',
            info: 'text-emerald-300',
            http: 'text-sky-300',
            debug: 'text-slate-400',
        };

        function escapeForLog(value) {
            return String(value).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
        }

        async function loadLogs() {
            try {
                const response = await apiKeyFetch('/api/logs?type=' + logsType.value + '&limit=300', 'wa_logs_key', { cache: 'no-store' });
                const data = await response.json();

                if (!response.ok || !data.success) {
                    throw new Error(data.message || 'Gagal memuat log');
                }

                if (!data.entries.length) {
                    logsConsole.innerHTML = '<p class="text-slate-500">Belum ada log.</p>';
                    return;
                }

                logsConsole.innerHTML = data.entries.map((entry) => {
                    const time = entry.timestamp ? escapeForLog(entry.timestamp) : '-';
                    const color = LOG_LEVEL_COLOR[entry.level] || 'text-slate-300';
                    return '<div class="whitespace-pre-wrap break-all border-b border-slate-800/60 py-1">' +
                        '<span class="text-slate-500">[' + time + ']</span> ' +
                        '<span class="font-semibold ' + color + '">' + escapeForLog(entry.level) + '</span> ' +
                        '<span>' + escapeForLog(entry.message) + '</span>' +
                        '</div>';
                }).join('');
                logsConsole.scrollTop = logsConsole.scrollHeight;
            } catch (error) {
                logsConsole.innerHTML = '<p class="text-red-400">' + escapeForLog(error.message) + '</p>';
            }
        }

        function stopLogsAutoRefresh() {
            if (logsTimer) {
                clearInterval(logsTimer);
                logsTimer = null;
            }
        }

        function startLogsAutoRefresh() {
            stopLogsAutoRefresh();
            if (logsAutoRefresh.checked) {
                logsTimer = setInterval(loadLogs, 5000);
            }
        }

        function unlockLogs() {
            sessionStorage.setItem('wa_logs_key', logsApiKeyInput.value || '');
            logsGateError.classList.add('hidden');

            apiKeyFetch('/api/logs?type=combined&limit=1', 'wa_logs_key', { cache: 'no-store' })
                .then(async (response) => {
                    const data = await response.json();
                    if (!response.ok || !data.success) {
                        throw new Error(data.message || 'API key tidak valid');
                    }
                    logsGate.classList.add('hidden');
                    logsPanel.classList.remove('hidden');
                    loadLogs();
                    startLogsAutoRefresh();
                })
                .catch((error) => {
                    logsGateError.textContent = error.message;
                    logsGateError.classList.remove('hidden');
                });
        }

        logsUnlockButton.addEventListener('click', unlockLogs);
        logsApiKeyInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') unlockLogs();
        });
        logsRefreshButton.addEventListener('click', loadLogs);
        logsType.addEventListener('change', loadLogs);
        logsAutoRefresh.addEventListener('change', startLogsAutoRefresh);
        logsRelockButton.addEventListener('click', () => {
            stopLogsAutoRefresh();
            sessionStorage.removeItem('wa_logs_key');
            logsPanel.classList.add('hidden');
            logsGate.classList.remove('hidden');
        });

        // --- Settings tab ---
        const settingsGate = document.getElementById('settingsGate');
        const settingsApiKeyInput = document.getElementById('settingsApiKey');
        const settingsUnlockButton = document.getElementById('settingsUnlockButton');
        const settingsGateError = document.getElementById('settingsGateError');
        const settingsForm = document.getElementById('settingsForm');
        const settingsGroupsEl = document.getElementById('settingsGroups');
        const settingsAlert = document.getElementById('settingsAlert');
        const settingsSaveButton = document.getElementById('settingsSaveButton');

        function showSettingsAlert(message, isError) {
            settingsAlert.textContent = message;
            settingsAlert.className = 'mt-4 rounded-xl px-4 py-3 text-sm font-medium ' +
                (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
        }

        function renderSettingsGroups(groups) {
            settingsGroupsEl.innerHTML = groups.map((group) => {
                const fields = group.fields.map((field) => {
                    const id = 'setting-' + field.key;
                    let control;
                    if (field.type === 'select') {
                        const options = field.options.map((opt) =>
                            '<option value="' + opt + '"' + (opt === field.value ? ' selected' : '') + '>' + opt + '</option>'
                        ).join('');
                        control = '<select id="' + id + '" data-key="' + field.key + '" class="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">' + options + '</select>';
                    } else {
                        const type = field.type === 'password' ? 'password' : (field.type === 'number' ? 'number' : 'text');
                        control = '<input id="' + id + '" data-key="' + field.key + '" type="' + type + '" value="' +
                            String(field.value).replace(/"/g, '&quot;') +
                            '" class="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">';
                    }
                    return '<div>' +
                        '<label for="' + id + '" class="text-xs font-semibold text-slate-700">' + field.label + '</label>' +
                        control +
                        (field.help ? '<p class="mt-1 text-[11px] text-slate-400">' + field.help + '</p>' : '') +
                        '</div>';
                }).join('');

                return '<fieldset class="rounded-xl border border-slate-200 bg-white p-4">' +
                    '<legend class="px-1 text-sm font-semibold text-slate-800">' + group.label + '</legend>' +
                    '<div class="mt-2 grid gap-4 sm:grid-cols-2">' + fields + '</div>' +
                    '</fieldset>';
            }).join('');
        }

        function unlockSettings() {
            sessionStorage.setItem('wa_settings_key', settingsApiKeyInput.value || '');
            settingsGateError.classList.add('hidden');

            apiKeyFetch('/api/settings', 'wa_settings_key', { cache: 'no-store' })
                .then(async (response) => {
                    const data = await response.json();
                    if (!response.ok || !data.success) {
                        throw new Error(data.message || 'API key tidak valid');
                    }
                    renderSettingsGroups(data.groups);
                    settingsGate.classList.add('hidden');
                    settingsForm.classList.remove('hidden');
                })
                .catch((error) => {
                    settingsGateError.textContent = error.message;
                    settingsGateError.classList.remove('hidden');
                });
        }

        settingsUnlockButton.addEventListener('click', unlockSettings);
        settingsApiKeyInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') unlockSettings();
        });

        async function waitForServerAndRedirect(redirectUrl, portChanged) {
            let attempts = 0;
            const maxAttempts = 40;

            const poll = async () => {
                attempts += 1;
                try {
                    await fetch(redirectUrl + 'api/status', { mode: 'no-cors', cache: 'no-store' });
                    showSettingsAlert('Server sudah aktif kembali. Mengalihkan...', false);
                    setTimeout(() => { window.location.href = redirectUrl; }, 500);
                } catch (err) {
                    if (attempts >= maxAttempts) {
                        showSettingsAlert(
                            'Server belum merespons otomatis. Buka manual: ' + redirectUrl,
                            true,
                        );
                        settingsSaveButton.disabled = false;
                        settingsSaveButton.classList.remove('opacity-60', 'cursor-wait');
                        return;
                    }
                    setTimeout(poll, 1000);
                }
            };

            showSettingsAlert(
                (portChanged ? 'Server sedang restart dan pindah port. ' : 'Server sedang restart. ') +
                'Menunggu server aktif kembali...',
                false,
            );
            setTimeout(poll, 2000);
        }

        settingsForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const values = {};
            settingsForm.querySelectorAll('[data-key]').forEach((el) => {
                values[el.dataset.key] = el.value;
            });

            settingsSaveButton.disabled = true;
            settingsSaveButton.classList.add('opacity-60', 'cursor-wait');
            settingsAlert.classList.add('hidden');
            let isRestarting = false;

            try {
                const response = await apiKeyFetch('/api/settings', 'wa_settings_key', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ values }),
                });
                const data = await response.json();

                if (!response.ok || !data.success) {
                    throw new Error(data.message || 'Gagal menyimpan pengaturan');
                }

                if (data.restarting && data.redirectUrl) {
                    isRestarting = true;
                    waitForServerAndRedirect(data.redirectUrl, data.portChanged);
                } else {
                    showSettingsAlert(data.message, false);
                }
            } catch (error) {
                showSettingsAlert(error.message, true);
            } finally {
                if (!isRestarting) {
                    settingsSaveButton.disabled = false;
                    settingsSaveButton.classList.remove('opacity-60', 'cursor-wait');
                }
            }
        });

        // --- Broadcast tab ---
        const broadcastGate = document.getElementById('broadcastGate');
        const broadcastApiKeyInput = document.getElementById('broadcastApiKey');
        const broadcastUnlockButton = document.getElementById('broadcastUnlockButton');
        const broadcastGateError = document.getElementById('broadcastGateError');
        const broadcastForm = document.getElementById('broadcastForm');
        const broadcastAlert = document.getElementById('broadcastAlert');
        const broadcastSubmitButton = document.getElementById('broadcastSubmitButton');

        function showBroadcastAlert(message, isError) {
            broadcastAlert.textContent = message;
            broadcastAlert.className = 'mt-4 rounded-xl px-4 py-3 text-sm font-medium ' +
                (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
            broadcastAlert.classList.remove('hidden');
        }

        function unlockBroadcast() {
            sessionStorage.setItem('wa_broadcast_key', broadcastApiKeyInput.value || '');
            broadcastGateError.classList.add('hidden');

            apiKeyFetch('/api/history?limit=1', 'wa_broadcast_key', { cache: 'no-store' })
                .then(async (response) => {
                    const data = await response.json();
                    if (!response.ok || !data.success) {
                        throw new Error(data.message || 'API key tidak valid');
                    }
                    broadcastGate.classList.add('hidden');
                    broadcastForm.classList.remove('hidden');
                })
                .catch((error) => {
                    broadcastGateError.textContent = error.message;
                    broadcastGateError.classList.remove('hidden');
                });
        }

        broadcastUnlockButton.addEventListener('click', unlockBroadcast);
        broadcastApiKeyInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') unlockBroadcast();
        });

        broadcastForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            broadcastSubmitButton.disabled = true;
            broadcastSubmitButton.classList.add('opacity-60', 'cursor-wait');
            broadcastAlert.classList.add('hidden');

            try {
                const response = await apiKeyFetch('/api/broadcast', 'wa_broadcast_key', {
                    method: 'POST',
                    body: new FormData(broadcastForm),
                });
                const data = await response.json();

                if (!response.ok || !data.success) {
                    throw new Error(data.message || 'Broadcast gagal dikirim');
                }

                showBroadcastAlert(data.message, false);
                broadcastForm.reset();
            } catch (error) {
                showBroadcastAlert(error.message, true);
            } finally {
                broadcastSubmitButton.disabled = false;
                broadcastSubmitButton.classList.remove('opacity-60', 'cursor-wait');
            }
        });

        // --- Terjadwal (Schedule) tab ---
        const scheduleGate = document.getElementById('scheduleGate');
        const scheduleApiKeyInput = document.getElementById('scheduleApiKey');
        const scheduleUnlockButton = document.getElementById('scheduleUnlockButton');
        const scheduleGateError = document.getElementById('scheduleGateError');
        const schedulePanel = document.getElementById('schedulePanel');
        const scheduleForm = document.getElementById('scheduleForm');
        const scheduleAlert = document.getElementById('scheduleAlert');
        const scheduleSubmitButton = document.getElementById('scheduleSubmitButton');
        const scheduleTableBody = document.getElementById('scheduleTableBody');

        const SCHEDULE_STATUS_TONE = {
            pending: 'bg-amber-50 text-amber-700',
            sent: 'bg-emerald-50 text-emerald-700',
            failed: 'bg-red-50 text-red-700',
            cancelled: 'bg-slate-100 text-slate-500',
        };

        function showScheduleAlert(message, isError) {
            scheduleAlert.textContent = message;
            scheduleAlert.className = 'mb-4 rounded-xl px-4 py-3 text-sm font-medium ' +
                (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
            scheduleAlert.classList.remove('hidden');
        }

        async function loadSchedule() {
            try {
                const response = await apiKeyFetch('/api/schedule', 'wa_schedule_key', { cache: 'no-store' });
                const data = await response.json();

                if (!response.ok || !data.success) {
                    throw new Error(data.message || 'Gagal memuat pesan terjadwal');
                }

                if (!data.entries.length) {
                    scheduleTableBody.innerHTML = '<tr><td class="px-4 py-3 text-slate-400" colspan="5">Belum ada pesan terjadwal.</td></tr>';
                    return;
                }

                scheduleTableBody.innerHTML = data.entries.map((entry) => {
                    const tone = SCHEDULE_STATUS_TONE[entry.status] || 'bg-slate-100 text-slate-500';
                    const when = new Date(entry.sendAt).toLocaleString('id-ID');
                    const cancelBtn = entry.status === 'pending'
                        ? '<button type="button" data-cancel-id="' + entry.id + '" class="cancel-schedule-btn text-xs font-semibold text-red-600 hover:underline">Batalkan</button>'
                        : '';
                    return '<tr>' +
                        '<td class="px-4 py-2 text-slate-700">' + entry.to + '</td>' +
                        '<td class="px-4 py-2 max-w-[220px] truncate text-slate-600">' + (entry.hasFile ? '[file] ' : '') + (entry.message || '') + '</td>' +
                        '<td class="px-4 py-2 text-slate-600">' + when + '</td>' +
                        '<td class="px-4 py-2"><span class="rounded-full px-2 py-0.5 text-xs font-semibold ' + tone + '">' + entry.status + '</span></td>' +
                        '<td class="px-4 py-2">' + cancelBtn + '</td>' +
                        '</tr>';
                }).join('');

                scheduleTableBody.querySelectorAll('.cancel-schedule-btn').forEach((btn) => {
                    btn.addEventListener('click', async () => {
                        btn.disabled = true;
                        try {
                            const response = await apiKeyFetch('/api/schedule/' + btn.dataset.cancelId, 'wa_schedule_key', { method: 'DELETE' });
                            const data = await response.json();
                            if (!response.ok || !data.success) throw new Error(data.message || 'Gagal membatalkan');
                            loadSchedule();
                        } catch (error) {
                            showScheduleAlert(error.message, true);
                            btn.disabled = false;
                        }
                    });
                });
            } catch (error) {
                scheduleTableBody.innerHTML = '<tr><td class="px-4 py-3 text-red-600" colspan="5">' + error.message + '</td></tr>';
            }
        }

        function unlockSchedule() {
            sessionStorage.setItem('wa_schedule_key', scheduleApiKeyInput.value || '');
            scheduleGateError.classList.add('hidden');

            apiKeyFetch('/api/schedule', 'wa_schedule_key', { cache: 'no-store' })
                .then(async (response) => {
                    const data = await response.json();
                    if (!response.ok || !data.success) {
                        throw new Error(data.message || 'API key tidak valid');
                    }
                    scheduleGate.classList.add('hidden');
                    schedulePanel.classList.remove('hidden');
                    loadSchedule();
                })
                .catch((error) => {
                    scheduleGateError.textContent = error.message;
                    scheduleGateError.classList.remove('hidden');
                });
        }

        scheduleUnlockButton.addEventListener('click', unlockSchedule);
        scheduleApiKeyInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') unlockSchedule();
        });

        scheduleForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            scheduleSubmitButton.disabled = true;
            scheduleSubmitButton.classList.add('opacity-60', 'cursor-wait');
            scheduleAlert.classList.add('hidden');

            try {
                const formData = new FormData(scheduleForm);
                const localValue = document.getElementById('scheduleSendAt').value;
                if (localValue) {
                    formData.set('sendAt', new Date(localValue).toISOString());
                }

                const response = await apiKeyFetch('/api/schedule', 'wa_schedule_key', {
                    method: 'POST',
                    body: formData,
                });
                const data = await response.json();

                if (!response.ok || !data.success) {
                    throw new Error(data.message || 'Gagal membuat pesan terjadwal');
                }

                showScheduleAlert(data.message, false);
                scheduleForm.reset();
                loadSchedule();
            } catch (error) {
                showScheduleAlert(error.message, true);
            } finally {
                scheduleSubmitButton.disabled = false;
                scheduleSubmitButton.classList.remove('opacity-60', 'cursor-wait');
            }
        });

        // --- Riwayat (History) tab ---
        const historyGate = document.getElementById('historyGate');
        const historyApiKeyInput = document.getElementById('historyApiKey');
        const historyUnlockButton = document.getElementById('historyUnlockButton');
        const historyGateError = document.getElementById('historyGateError');
        const historyPanel = document.getElementById('historyPanel');
        const historyRefreshButton = document.getElementById('historyRefreshButton');
        const historyTableBody = document.getElementById('historyTableBody');
        const historyCount = document.getElementById('historyCount');

        const HISTORY_STATUS_TONE = {
            sent: 'bg-emerald-50 text-emerald-700',
            failed: 'bg-red-50 text-red-700',
        };

        async function loadHistory() {
            try {
                const response = await apiKeyFetch('/api/history?limit=200', 'wa_history_key', { cache: 'no-store' });
                const data = await response.json();

                if (!response.ok || !data.success) {
                    throw new Error(data.message || 'Gagal memuat riwayat');
                }

                historyCount.textContent = data.total + ' total riwayat tersimpan';

                if (!data.entries.length) {
                    historyTableBody.innerHTML = '<tr><td class="px-4 py-3 text-slate-400" colspan="6">Belum ada riwayat pengiriman.</td></tr>';
                    return;
                }

                historyTableBody.innerHTML = data.entries.map((entry) => {
                    const tone = HISTORY_STATUS_TONE[entry.status] || 'bg-slate-100 text-slate-500';
                    const when = new Date(entry.timestamp).toLocaleString('id-ID');
                    const text = entry.status === 'failed' ? (entry.error || entry.message || '') : (entry.message || '');
                    return '<tr>' +
                        '<td class="px-4 py-2 whitespace-nowrap text-slate-500">' + when + '</td>' +
                        '<td class="px-4 py-2 text-slate-600">' + (entry.source || '-') + '</td>' +
                        '<td class="px-4 py-2 text-slate-700">' + (entry.to || '-') + '</td>' +
                        '<td class="px-4 py-2 text-slate-600">' + (entry.type || '-') + '</td>' +
                        '<td class="px-4 py-2 max-w-[240px] truncate text-slate-600">' + text + '</td>' +
                        '<td class="px-4 py-2"><span class="rounded-full px-2 py-0.5 text-xs font-semibold ' + tone + '">' + entry.status + '</span></td>' +
                        '</tr>';
                }).join('');
            } catch (error) {
                historyTableBody.innerHTML = '<tr><td class="px-4 py-3 text-red-600" colspan="6">' + error.message + '</td></tr>';
            }
        }

        function unlockHistory() {
            sessionStorage.setItem('wa_history_key', historyApiKeyInput.value || '');
            historyGateError.classList.add('hidden');

            apiKeyFetch('/api/history?limit=1', 'wa_history_key', { cache: 'no-store' })
                .then(async (response) => {
                    const data = await response.json();
                    if (!response.ok || !data.success) {
                        throw new Error(data.message || 'API key tidak valid');
                    }
                    historyGate.classList.add('hidden');
                    historyPanel.classList.remove('hidden');
                    loadHistory();
                })
                .catch((error) => {
                    historyGateError.textContent = error.message;
                    historyGateError.classList.remove('hidden');
                });
        }

        historyUnlockButton.addEventListener('click', unlockHistory);
        historyApiKeyInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') unlockHistory();
        });
        historyRefreshButton.addEventListener('click', loadHistory);

        // Auto-unlock gated tabs if a key was already saved this session
        if (sessionStorage.getItem('wa_logs_key') !== null) {
            logsApiKeyInput.value = sessionStorage.getItem('wa_logs_key');
            unlockLogs();
        }
        if (sessionStorage.getItem('wa_settings_key') !== null) {
            settingsApiKeyInput.value = sessionStorage.getItem('wa_settings_key');
            unlockSettings();
        }
        if (sessionStorage.getItem('wa_broadcast_key') !== null) {
            broadcastApiKeyInput.value = sessionStorage.getItem('wa_broadcast_key');
            unlockBroadcast();
        }
        if (sessionStorage.getItem('wa_schedule_key') !== null) {
            scheduleApiKeyInput.value = sessionStorage.getItem('wa_schedule_key');
            unlockSchedule();
        }
        if (sessionStorage.getItem('wa_history_key') !== null) {
            historyApiKeyInput.value = sessionStorage.getItem('wa_history_key');
            unlockHistory();
        }
    </script>
</body>
</html>`;
}

const DOC_ENDPOINTS = [
  {
    id: "status",
    method: "GET",
    path: "/api/status",
    title: "Status Gateway",
    badge: "publik",
    summary: "Status koneksi gateway (terhubung, sedang connect, antrean, dsb).",
    body: `<p class="text-slate-600 leading-relaxed">Mengembalikan status koneksi WhatsApp saat ini dalam format JSON. Tidak butuh body request.</p>`,
    curl: (base) => `curl ${base}/api/status`,
    example: JSON.stringify(
      {
        version: APP_VERSION,
        environment: NODE_ENV,
        connected: true,
        connecting: false,
        logoutInProgress: false,
        hasQR: false,
        queueDepth: 0,
        activeSendCount: 0,
        reconnectAttempt: 0,
        lastConnectionState: "open",
        lastDisconnectReason: null,
        lastDisconnectMessage: null,
        qrUpdatedAt: 1786300000000,
        timestamp: "2026-08-10T04:00:00.000Z",
        requestId: "a1b2c3d4",
      },
      null,
      2,
    ),
  },
  {
    id: "qr",
    method: "GET",
    path: "/api/qr",
    title: "Ambil QR Code",
    badge: "publik",
    summary: "QR code (data URL base64) untuk dipindai saat sesi belum terhubung.",
    body: `<p class="text-slate-600 leading-relaxed">Mengembalikan QR code sebagai data URL base64. Mengembalikan status <code class="rounded bg-slate-100 px-1.5 py-0.5 text-sm">404</code> jika QR belum tersedia (misalnya saat sudah terhubung).</p>`,
    curl: (base) => `curl ${base}/api/qr`,
    example: JSON.stringify(
      {
        success: true,
        qrCodeData: "data:image/png;base64,iVBORw0KGgo...",
        updatedAt: 1786300000000,
        requestId: "a1b2c3d4",
      },
      null,
      2,
    ),
  },
  {
    id: "send",
    method: "POST",
    path: "/api/send",
    title: "Kirim Pesan (Text Only)",
    badge: "text only",
    summary: "Mengirim pesan teks biasa ke satu nomor tujuan.",
    body: `
      <p class="text-slate-600 leading-relaxed">Mode <strong>Text only</strong> — mengirim pesan teks polos tanpa lampiran.</p>
      <div class="mt-4 overflow-x-auto rounded-xl border border-slate-200">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr><th class="px-4 py-2 text-left">Field</th><th class="px-4 py-2 text-left">Tipe</th><th class="px-4 py-2 text-left">Keterangan</th></tr>
          </thead>
          <tbody class="divide-y divide-slate-200">
            <tr><td class="px-4 py-2 font-mono text-emerald-700">number</td><td class="px-4 py-2 text-slate-500">string</td><td class="px-4 py-2 text-slate-600">Nomor tujuan, boleh pakai atau tanpa awalan +, contoh <code>628123456789</code></td></tr>
            <tr><td class="px-4 py-2 font-mono text-emerald-700">message</td><td class="px-4 py-2 text-slate-500">string</td><td class="px-4 py-2 text-slate-600">Isi pesan teks (wajib)</td></tr>
          </tbody>
        </table>
      </div>
      <p class="mt-3 text-sm text-slate-500">Content-Type: <code class="rounded bg-slate-100 px-1.5 py-0.5">application/json</code> atau <code class="rounded bg-slate-100 px-1.5 py-0.5">application/x-www-form-urlencoded</code>.</p>
    `,
    curl: (base) => `curl -X POST ${base}/api/send \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{"number":"628123456789","message":"Halo dari API"}'`,
    example: JSON.stringify(
      {
        success: true,
        message: "Pesan berhasil dikirim",
        to: "628***6789",
        requestId: "a1b2c3d4",
        messageId: "3EB0C767...",
        queueDelayMs: 12,
        sendDurationMs: 340,
      },
      null,
      2,
    ),
  },
  {
    id: "send-file",
    method: "POST",
    path: "/api/send-file",
    title: "Kirim File / File + Text",
    badge: "file & gabungan",
    summary: "Kirim media (gambar, video, audio, dokumen) dengan caption opsional.",
    body: `
      <p class="text-slate-600 leading-relaxed">Mendukung dua mode sekaligus: <strong>File only</strong> (tanpa <code>caption</code>) dan <strong>gabungan File + Text</strong> (dengan <code>caption</code> diisi).</p>
      <div class="mt-4 overflow-x-auto rounded-xl border border-slate-200">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr><th class="px-4 py-2 text-left">Field</th><th class="px-4 py-2 text-left">Tipe</th><th class="px-4 py-2 text-left">Keterangan</th></tr>
          </thead>
          <tbody class="divide-y divide-slate-200">
            <tr><td class="px-4 py-2 font-mono text-emerald-700">number</td><td class="px-4 py-2 text-slate-500">string</td><td class="px-4 py-2 text-slate-600">Nomor tujuan (wajib)</td></tr>
            <tr><td class="px-4 py-2 font-mono text-emerald-700">file</td><td class="px-4 py-2 text-slate-500">file (multipart)</td><td class="px-4 py-2 text-slate-600">Berkas yang dikirim, maks ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB (wajib)</td></tr>
            <tr><td class="px-4 py-2 font-mono text-emerald-700">caption</td><td class="px-4 py-2 text-slate-500">string</td><td class="px-4 py-2 text-slate-600">Teks penyerta (opsional). Kosongkan untuk mode file only.</td></tr>
          </tbody>
        </table>
      </div>
      <p class="mt-3 text-sm text-slate-500">Content-Type: <code class="rounded bg-slate-100 px-1.5 py-0.5">multipart/form-data</code>.</p>
      <p class="mt-3 text-sm text-slate-500">Tipe media otomatis dideteksi dari MIME type: <code class="rounded bg-slate-100 px-1.5 py-0.5">image/*</code> → foto, <code class="rounded bg-slate-100 px-1.5 py-0.5">video/*</code> → video, <code class="rounded bg-slate-100 px-1.5 py-0.5">audio/*</code> → audio, selain itu → dokumen.</p>
    `,
    curl: (base) => `# File only
curl -X POST ${base}/api/send-file \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "number=628123456789" \\
  -F "file=@/path/to/gambar.jpg"

# File + text (caption)
curl -X POST ${base}/api/send-file \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "number=628123456789" \\
  -F "caption=Ini laporan bulanan" \\
  -F "file=@/path/to/dokumen.pdf"`,
    example: JSON.stringify(
      {
        success: true,
        message: "File berhasil dikirim",
        to: "628***6789",
        requestId: "a1b2c3d4",
        messageId: "3EB0C767...",
        queueDelayMs: 8,
        sendDurationMs: 512,
      },
      null,
      2,
    ),
  },
  {
    id: "test-chat",
    method: "POST",
    path: "/api/test-chat",
    title: "Test Chat",
    badge: "utilitas",
    summary: "Mengirim pesan uji ke nomor WhatsApp yang sedang login sendiri.",
    body: `<p class="text-slate-600 leading-relaxed">Berguna untuk memastikan gateway benar-benar bisa mengirim pesan tanpa perlu menyiapkan nomor tujuan lain. Tidak butuh body request.</p>`,
    curl: (base) => `curl -X POST ${base}/api/test-chat \\
  -H "x-api-key: YOUR_API_KEY"`,
    example: JSON.stringify(
      {
        success: true,
        message: "Test chat berhasil dikirim",
        to: "628***6789",
        requestId: "a1b2c3d4",
        messageId: "3EB0C767...",
        queueDelayMs: 5,
        sendDurationMs: 298,
      },
      null,
      2,
    ),
  },
  {
    id: "logout",
    method: "POST",
    path: "/api/logout",
    title: "Logout / Ganti Akun",
    badge: "utilitas",
    summary: "Logout perangkat tertaut, hapus sesi lama, siapkan QR baru.",
    body: `<p class="text-slate-600 leading-relaxed">Melogout perangkat WhatsApp yang sedang tertaut, menghapus folder sesi lama, lalu menyiapkan QR baru untuk memindai akun lain. Tidak butuh body request.</p>`,
    curl: (base) => `curl -X POST ${base}/api/logout \\
  -H "x-api-key: YOUR_API_KEY"`,
    example: JSON.stringify(
      {
        success: true,
        message: "Sesi lama berhasil dilogout. QR akun baru sedang disiapkan.",
        requestId: "a1b2c3d4",
      },
      null,
      2,
    ),
  },
  {
    id: "broadcast",
    method: "POST",
    path: "/api/broadcast",
    title: "Broadcast",
    badge: "butuh api key",
    summary: "Kirim satu pesan (teks/file/gabungan) ke banyak nomor sekaligus.",
    body: `
      <p class="text-slate-600 leading-relaxed">Mengirim pesan yang sama ke banyak nomor tujuan lewat antrean internal (tidak flood). Selalu butuh header <code class="rounded bg-slate-100 px-1.5 py-0.5">x-api-key</code>, walau <code class="rounded bg-slate-100 px-1.5 py-0.5">API_KEY</code> belum diset di server.</p>
      <div class="mt-4 overflow-x-auto rounded-xl border border-slate-200">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr><th class="px-4 py-2 text-left">Field</th><th class="px-4 py-2 text-left">Tipe</th><th class="px-4 py-2 text-left">Keterangan</th></tr>
          </thead>
          <tbody class="divide-y divide-slate-200">
            <tr><td class="px-4 py-2 font-mono text-emerald-700">numbers</td><td class="px-4 py-2 text-slate-500">string</td><td class="px-4 py-2 text-slate-600">Daftar nomor tujuan, pisahkan dengan koma atau baris baru (wajib)</td></tr>
            <tr><td class="px-4 py-2 font-mono text-emerald-700">message</td><td class="px-4 py-2 text-slate-500">string</td><td class="px-4 py-2 text-slate-600">Isi pesan / caption (wajib jika tanpa file)</td></tr>
            <tr><td class="px-4 py-2 font-mono text-emerald-700">file</td><td class="px-4 py-2 text-slate-500">file (multipart)</td><td class="px-4 py-2 text-slate-600">Berkas opsional yang dikirim ke semua nomor</td></tr>
          </tbody>
        </table>
      </div>
      <p class="mt-3 text-sm text-slate-500">Content-Type: <code class="rounded bg-slate-100 px-1.5 py-0.5">multipart/form-data</code>. Response dikirim segera setelah pesan masuk antrean; status per nomor bisa dicek lewat <code class="rounded bg-slate-100 px-1.5 py-0.5">/api/history</code>.</p>
    `,
    curl: (base) => `curl -X POST ${base}/api/broadcast \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "numbers=628123456789,628987654321" \\
  -F "message=Pengumuman untuk semua pelanggan"`,
    example: JSON.stringify(
      {
        success: true,
        message: "Broadcast dijadwalkan ke 2 nomor. Cek tab Riwayat untuk status pengiriman.",
        total: 2,
        requestId: "a1b2c3d4",
      },
      null,
      2,
    ),
  },
  {
    id: "schedule-create",
    method: "POST",
    path: "/api/schedule",
    title: "Buat Pesan Terjadwal",
    badge: "butuh api key",
    summary: "Jadwalkan pesan (teks/file/gabungan) untuk dikirim pada waktu tertentu di masa depan.",
    body: `
      <div class="overflow-x-auto rounded-xl border border-slate-200">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr><th class="px-4 py-2 text-left">Field</th><th class="px-4 py-2 text-left">Tipe</th><th class="px-4 py-2 text-left">Keterangan</th></tr>
          </thead>
          <tbody class="divide-y divide-slate-200">
            <tr><td class="px-4 py-2 font-mono text-emerald-700">number</td><td class="px-4 py-2 text-slate-500">string</td><td class="px-4 py-2 text-slate-600">Nomor tujuan (wajib)</td></tr>
            <tr><td class="px-4 py-2 font-mono text-emerald-700">sendAt</td><td class="px-4 py-2 text-slate-500">ISO datetime</td><td class="px-4 py-2 text-slate-600">Waktu pengiriman, harus di masa depan (wajib)</td></tr>
            <tr><td class="px-4 py-2 font-mono text-emerald-700">message</td><td class="px-4 py-2 text-slate-500">string</td><td class="px-4 py-2 text-slate-600">Isi pesan / caption</td></tr>
            <tr><td class="px-4 py-2 font-mono text-emerald-700">file</td><td class="px-4 py-2 text-slate-500">file (multipart)</td><td class="px-4 py-2 text-slate-600">Berkas opsional</td></tr>
          </tbody>
        </table>
      </div>
      <p class="mt-3 text-sm text-slate-500">Pesan diproses oleh scheduler internal setiap <code class="rounded bg-slate-100 px-1.5 py-0.5">SCHEDULER_INTERVAL_MS</code> (default 15 detik). Batalkan dengan <code class="rounded bg-slate-100 px-1.5 py-0.5">DELETE /api/schedule/:id</code>.</p>
    `,
    curl: (base) => `curl -X POST ${base}/api/schedule \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "number=628123456789" \\
  -F "sendAt=2026-08-15T09:00:00.000Z" \\
  -F "message=Selamat pagi! Ini pesan terjadwal."`,
    example: JSON.stringify(
      {
        success: true,
        message: "Pesan terjadwal berhasil dibuat",
        entry: {
          id: "b2c3d4e5-...",
          to: "628***6789",
          message: "Selamat pagi! Ini pesan terjadwal.",
          hasFile: false,
          sendAt: "2026-08-15T09:00:00.000Z",
          status: "pending",
          createdAt: "2026-08-10T04:00:00.000Z",
        },
        requestId: "a1b2c3d4",
      },
      null,
      2,
    ),
  },
  {
    id: "schedule-list",
    method: "GET",
    path: "/api/schedule",
    title: "Daftar Pesan Terjadwal",
    badge: "butuh api key",
    summary: "Lihat semua pesan terjadwal beserta statusnya (pending/sent/failed/cancelled).",
    body: `<p class="text-slate-600 leading-relaxed">Mengembalikan seluruh pesan terjadwal, terbaru lebih dulu. Tidak butuh body request.</p>`,
    curl: (base) => `curl ${base}/api/schedule \\
  -H "x-api-key: YOUR_API_KEY"`,
    example: JSON.stringify(
      {
        success: true,
        entries: [
          {
            id: "b2c3d4e5-...",
            to: "628***6789",
            message: "Selamat pagi!",
            hasFile: false,
            sendAt: "2026-08-15T09:00:00.000Z",
            status: "pending",
            createdAt: "2026-08-10T04:00:00.000Z",
          },
        ],
        requestId: "a1b2c3d4",
      },
      null,
      2,
    ),
  },
  {
    id: "schedule-cancel",
    method: "DELETE",
    path: "/api/schedule/:id",
    title: "Batalkan Pesan Terjadwal",
    badge: "butuh api key",
    summary: "Batalkan pesan terjadwal yang masih berstatus pending.",
    body: `<p class="text-slate-600 leading-relaxed">Method sebenarnya adalah <code class="rounded bg-slate-100 px-1.5 py-0.5">DELETE</code>. Hanya pesan berstatus <code class="rounded bg-slate-100 px-1.5 py-0.5">pending</code> yang bisa dibatalkan; selain itu akan mendapat response <code class="rounded bg-slate-100 px-1.5 py-0.5">409</code>.</p>`,
    curl: (base) => `curl -X DELETE ${base}/api/schedule/<id> \\
  -H "x-api-key: YOUR_API_KEY"`,
    example: JSON.stringify(
      {
        success: true,
        message: "Pesan terjadwal dibatalkan",
        requestId: "a1b2c3d4",
      },
      null,
      2,
    ),
  },
  {
    id: "history",
    method: "GET",
    path: "/api/history",
    title: "Riwayat Pengiriman",
    badge: "butuh api key",
    summary: "Riwayat pesan yang sudah dikirim (form, API, broadcast, terjadwal) beserta statusnya.",
    body: `<p class="text-slate-600 leading-relaxed">Mengembalikan riwayat pengiriman terbaru (maks 500 entri tersimpan). Gunakan parameter query <code class="rounded bg-slate-100 px-1.5 py-0.5">limit</code> untuk membatasi jumlah hasil.</p>`,
    curl: (base) => `curl "${base}/api/history?limit=50" \\
  -H "x-api-key: YOUR_API_KEY"`,
    example: JSON.stringify(
      {
        success: true,
        entries: [
          {
            id: "c3d4e5f6-...",
            timestamp: "2026-08-10T04:00:00.000Z",
            source: "api",
            to: "628***6789",
            type: "text",
            message: "Halo dari API",
            status: "sent",
            messageId: "3EB0C767...",
          },
        ],
        total: 128,
        requestId: "a1b2c3d4",
      },
      null,
      2,
    ),
  },
];

function methodBadgeTone(method) {
  if (method === "GET") return "bg-sky-100 text-sky-700";
  if (method === "DELETE") return "bg-red-100 text-red-700";
  return "bg-emerald-100 text-emerald-700";
}

function renderDocsPage(req) {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const apiKeyNote = API_KEY
    ? "Endpoint ditandai <strong>publik</strong> tidak butuh API key; sisanya wajib menyertakan header <code class=\"rounded bg-white/70 px-1.5 py-0.5\">x-api-key</code>."
    : "<strong>API_KEY belum diset</strong> di server, jadi semua endpoint saat ini bisa diakses tanpa autentikasi. Set <code class=\"rounded bg-white/70 px-1.5 py-0.5\">API_KEY</code> di <code class=\"rounded bg-white/70 px-1.5 py-0.5\">.env</code> untuk produksi.";

  const navItems = DOC_ENDPOINTS.map(
    (ep, index) => `
      <button
        type="button"
        data-tab="${ep.id}"
        class="doc-tab w-full flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition ${index === 0 ? "bg-emerald-600 text-white shadow" : "text-slate-600 hover:bg-slate-100"}"
      >
        <span class="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${methodBadgeTone(ep.method)} ${index === 0 ? "!bg-white/20 !text-white" : ""}">${ep.method}</span>
        <span class="truncate font-medium">${ep.title}</span>
      </button>`,
  ).join("") + `
      <button
        type="button"
        data-tab="response-format"
        class="doc-tab w-full flex items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-slate-600 transition hover:bg-slate-100"
      >
        <span class="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide bg-slate-200 text-slate-700">INFO</span>
        <span class="truncate font-medium">Response Format</span>
      </button>`;

const RESPONSE_FORMAT_PANEL = `
  <div class="flex flex-wrap items-center gap-3">
    <span class="rounded-md px-2.5 py-1 text-xs font-bold tracking-wide bg-slate-200 text-slate-700">INFO</span>
    <span class="text-lg font-semibold text-slate-800">Response Format</span>
  </div>
  <p class="mt-2 text-sm text-slate-500">Semua endpoint <code class="rounded bg-slate-100 px-1.5 py-0.5">/api/*</code> mengembalikan JSON dengan pola berikut, dan kode status HTTP yang umum dipakai.</p>
  <div class="mt-4 overflow-x-auto rounded-xl border border-slate-200">
    <table class="w-full text-sm">
      <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
        <tr><th class="px-4 py-2 text-left">Kode</th><th class="px-4 py-2 text-left">Arti</th></tr>
      </thead>
      <tbody class="divide-y divide-slate-200">
        <tr><td class="px-4 py-2 font-mono text-slate-700">400</td><td class="px-4 py-2 text-slate-600">Input tidak valid</td></tr>
        <tr><td class="px-4 py-2 font-mono text-slate-700">401</td><td class="px-4 py-2 text-slate-600">API key salah / tidak ada</td></tr>
        <tr><td class="px-4 py-2 font-mono text-slate-700">422</td><td class="px-4 py-2 text-slate-600">Nomor tidak terdaftar di WhatsApp</td></tr>
        <tr><td class="px-4 py-2 font-mono text-slate-700">429</td><td class="px-4 py-2 text-slate-600">Antrean pengiriman penuh</td></tr>
        <tr><td class="px-4 py-2 font-mono text-slate-700">503</td><td class="px-4 py-2 text-slate-600">WhatsApp belum terhubung</td></tr>
      </tbody>
    </table>
  </div>
`;

  const panels = DOC_ENDPOINTS.map(
    (ep, index) => `
      <section data-panel="${ep.id}" class="doc-panel px-1 ${index === 0 ? "" : "hidden"}">
        <div class="grid gap-5 lg:grid-cols-[1fr_360px]">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-3">
              <span class="rounded-md px-2.5 py-1 text-xs font-bold tracking-wide ${methodBadgeTone(ep.method)}">${ep.method}</span>
              <code class="text-lg font-semibold text-slate-800">${ep.path}</code>
              <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500">${ep.badge}</span>
            </div>
            <p class="mt-2 text-sm text-slate-500">${ep.summary}</p>
            <div class="mt-4">${ep.body}</div>
          </div>
          <div class="min-w-0">
            <div class="flex gap-1 rounded-t-xl bg-slate-900 p-1.5">
              <button type="button" data-example-tab="request" class="example-tab flex-1 rounded-lg py-1.5 text-xs font-semibold transition" data-scope="${ep.id}">Request</button>
              <button type="button" data-example-tab="response" class="example-tab flex-1 rounded-lg py-1.5 text-xs font-semibold transition" data-scope="${ep.id}">Contoh Response</button>
            </div>
            <div data-example-panel="request" data-scope="${ep.id}" class="example-panel">
              <div class="flex items-center justify-between bg-slate-900 px-4 py-1.5">
                <span class="text-xs font-medium text-slate-400">curl</span>
                <button type="button" class="copy-btn text-xs font-medium text-slate-400 hover:text-white transition" data-target="curl-${ep.id}">Salin</button>
              </div>
              <pre class="max-h-[55vh] overflow-auto rounded-b-xl bg-slate-950 px-4 py-4 text-sm leading-relaxed text-emerald-300"><code id="curl-${ep.id}">${escapeHtml(ep.curl(baseUrl))}</code></pre>
            </div>
            <div data-example-panel="response" data-scope="${ep.id}" class="example-panel hidden">
              <div class="flex items-center justify-between bg-slate-900 px-4 py-1.5">
                <span class="text-xs font-medium text-slate-400">JSON</span>
                <button type="button" class="copy-btn text-xs font-medium text-slate-400 hover:text-white transition" data-target="example-${ep.id}">Salin</button>
              </div>
              <pre class="max-h-[55vh] overflow-auto rounded-b-xl bg-slate-950 px-4 py-4 text-sm leading-relaxed text-sky-300"><code id="example-${ep.id}">${escapeHtml(ep.example || "")}</code></pre>
            </div>
          </div>
        </div>
      </section>`,
  ).join("") + `
      <section data-panel="response-format" class="doc-panel hidden px-1">
        ${RESPONSE_FORMAT_PANEL}
      </section>`;

  return `<!doctype html>
<html lang="id" class="h-full">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>API Documentation - ${APP_NAME}</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="h-full overflow-hidden bg-slate-100 text-slate-800">
    <div class="flex h-full">
        <div id="drawerBackdrop" class="fixed inset-0 z-30 hidden bg-slate-900/40 sm:hidden"></div>

        <aside id="drawer" class="fixed inset-y-0 left-0 z-40 flex w-72 -translate-x-full flex-col border-r border-slate-200 bg-white transition-transform duration-200 sm:static sm:z-0 sm:w-60 sm:translate-x-0">
            <div class="flex items-center justify-between gap-2.5 border-b border-slate-200 px-5 py-4">
                <div class="flex min-w-0 items-center gap-2.5">
                    <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.15 2 11.27c0 2.62 1.18 5 3.11 6.7-.1 1.02-.4 2.6-1.11 3.94 1.6-.14 3.34-.7 4.55-1.42 1.09.32 2.26.5 3.45.5 5.52 0 10-4.15 10-9.27C22 6.15 17.52 2 12 2z"/></svg>
                    </span>
                    <div class="min-w-0">
                        <div class="flex items-center gap-1.5">
                            <p class="truncate text-sm font-bold text-slate-900">${escapeHtml(APP_NAME)}</p>
                            ${renderEnvBadge()}
                        </div>
                        <p class="truncate text-xs text-slate-400">API Documentation <span class="text-slate-300">&middot;</span> v${escapeHtml(APP_VERSION)}</p>
                    </div>
                </div>
                <button id="drawerClose" type="button" class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 sm:hidden" aria-label="Tutup menu">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
                </button>
            </div>

            <p class="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Endpoints</p>
            <nav class="flex-1 space-y-1 overflow-y-auto p-3 pt-1">${navItems}</nav>

            <div class="border-t border-slate-200 p-3">
                <a href="/" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-slate-600 transition hover:bg-slate-100">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
                    Kembali ke Home
                </a>
            </div>
        </aside>

        <div class="flex min-w-0 flex-1 flex-col">
            <header class="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
                <div class="flex items-center gap-2.5">
                    <button id="drawerToggle" type="button" class="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-100 sm:hidden" aria-label="Buka menu">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
                    </button>
                    <h1 id="docTitle" class="text-base font-semibold text-slate-800">Status Gateway</h1>
                </div>
            </header>

            <main class="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
                <div class="mx-auto h-full max-w-3xl">
                    <div class="mb-4 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-900 sm:text-sm">
                        ${apiKeyNote}
                    </div>

                    <div class="rounded-xl border border-slate-200 bg-white p-5">
                        ${panels}
                    </div>
                </div>
            </main>
        </div>
    </div>

    <script>
        const tabs = document.querySelectorAll('.doc-tab');
        const panels = document.querySelectorAll('.doc-panel');
        const drawer = document.getElementById('drawer');
        const drawerBackdrop = document.getElementById('drawerBackdrop');
        const docTitle = document.getElementById('docTitle');
        const DOC_TITLES = ${JSON.stringify({
          ...Object.fromEntries(DOC_ENDPOINTS.map((ep) => [ep.id, ep.title])),
          "response-format": "Response Format",
        })};

        function activateTab(id) {
            tabs.forEach((tab) => {
                const active = tab.dataset.tab === id;
                tab.classList.toggle('bg-emerald-600', active);
                tab.classList.toggle('text-white', active);
                tab.classList.toggle('shadow', active);
                tab.classList.toggle('text-slate-600', !active);
                tab.querySelector('span:first-child').classList.toggle('!bg-white/20', active);
                tab.querySelector('span:first-child').classList.toggle('!text-white', active);
            });
            panels.forEach((panel) => {
                panel.classList.toggle('hidden', panel.dataset.panel !== id);
            });
            if (docTitle) {
                docTitle.textContent = DOC_TITLES[id] || '';
            }
            const main = document.querySelector('main');
            if (main) {
                main.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
            }
        }

        tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                activateTab(tab.dataset.tab);
                closeDrawer();
            });
        });

        function openDrawer() {
            drawer.classList.remove('-translate-x-full');
            drawerBackdrop.classList.remove('hidden');
        }
        function closeDrawer() {
            if (window.innerWidth < 640) {
                drawer.classList.add('-translate-x-full');
                drawerBackdrop.classList.add('hidden');
            }
        }

        document.getElementById('drawerToggle').addEventListener('click', openDrawer);
        document.getElementById('drawerClose').addEventListener('click', closeDrawer);
        drawerBackdrop.addEventListener('click', closeDrawer);

        document.querySelectorAll('.copy-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const target = document.getElementById(btn.dataset.target);
                try {
                    await navigator.clipboard.writeText(target.textContent);
                    const original = btn.textContent;
                    btn.textContent = 'Tersalin!';
                    setTimeout(() => { btn.textContent = original; }, 1500);
                } catch (err) {
                    /* clipboard unavailable, ignore */
                }
            });
        });

        // --- Request / Contoh Response toggle inside each endpoint panel ---
        function activateExampleTab(scope, kind) {
            document.querySelectorAll('.example-tab[data-scope="' + scope + '"]').forEach((tab) => {
                const active = tab.dataset.exampleTab === kind;
                tab.classList.toggle('bg-white', active);
                tab.classList.toggle('text-slate-900', active);
                tab.classList.toggle('text-slate-400', !active);
            });
            document.querySelectorAll('.example-panel[data-scope="' + scope + '"]').forEach((panel) => {
                panel.classList.toggle('hidden', panel.dataset.examplePanel !== kind);
            });
        }

        document.querySelectorAll('.example-tab').forEach((tab) => {
            activateExampleTab(tab.dataset.scope, 'request');
            tab.addEventListener('click', () => activateExampleTab(tab.dataset.scope, tab.dataset.exampleTab));
        });
    </script>
</body>
</html>`;
}

function renderSuccessPage(title, body, requestId, isError) {
  const iconWrap = isError
    ? "bg-red-50 text-red-600"
    : "bg-emerald-50 text-emerald-600";
  const icon = isError
    ? `<path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a1 1 0 00.86 1.5h18.64a1 1 0 00.86-1.5L13.71 3.86a1 1 0 00-1.72 0z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;

  return `<!doctype html>
<html lang="id">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-slate-50 text-slate-800">
    <div class="mx-auto flex min-h-screen max-w-lg items-center px-4 py-10 sm:px-6">
        <div class="w-full rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <span class="mx-auto flex h-14 w-14 items-center justify-center rounded-full ${iconWrap}">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none">${icon}</svg>
            </span>
            <h1 class="mt-4 text-xl font-bold text-slate-900">${escapeHtml(title)}</h1>
            <p class="mt-2 text-sm leading-relaxed text-slate-600">${body}</p>
            <p class="mt-3 text-xs text-slate-400">Request ID: ${escapeHtml(requestId)}</p>
            <div class="mt-6 flex flex-wrap justify-center gap-2.5">
                <a href="/send-form" class="inline-flex h-11 items-center justify-center rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Kirim Lagi</a>
                <a href="/" class="inline-flex h-11 items-center justify-center rounded-xl bg-slate-100 px-5 text-sm font-semibold text-slate-700 hover:bg-slate-200 transition">Home</a>
            </div>
        </div>
    </div>
</body>
</html>`;
}

app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.send(renderHomePage());
});

app.get("/send-form", (req, res) => {
  res.redirect(302, "/#send");
});

app.get("/docs", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.send(renderDocsPage(req));
});

app.get("/widget", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "widget-qr.html"));
});

function wantsJson(req) {
  return Boolean(req.get("accept") && req.get("accept").includes("application/json"));
}

function sendFormResult(req, res, statusCode, { success, title, plainMessage, requestId }) {
  if (wantsJson(req)) {
    return res.status(statusCode).json({
      success,
      message: plainMessage,
      requestId,
    });
  }

  return res
    .status(statusCode)
    .send(renderSuccessPage(title, escapeHtml(plainMessage), requestId, !success));
}

app.post("/send-message", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? `Ukuran file melebihi batas ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB`
          : err.message;

      logger.warn(`[${req.id}] Upload file form gagal`, { error: message });

      return sendFormResult(req, res, 400, {
        success: false,
        title: "Input tidak valid",
        plainMessage: message,
        requestId: req.id,
      });
    }

    return next();
  });
}, async (req, res) => {
  let jid;
  let message;

  try {
    jid = normalizeRecipient(req.body.number);
    message = normalizeOptionalCaption(req.body.message);

    if (!req.file && !message) {
      throw new Error("Isi pesan atau lampirkan file terlebih dahulu");
    }

    if (!req.file) {
      message = normalizeMessage(message);
    }
  } catch (error) {
    logger.warn(`[${req.id}] Validasi form gagal`, {
      error: error.message,
    });

    return sendFormResult(req, res, 400, {
      success: false,
      title: "Input tidak valid",
      plainMessage: error.message,
      requestId: req.id,
    });
  }

  const maskedJid = maskDestination(jid);

  if (!isConnected || !sock) {
    logger.warn(`[${req.id}] WhatsApp belum terhubung`, { to: maskedJid });
    return sendFormResult(req, res, 503, {
      success: false,
      title: "WhatsApp belum terhubung",
      plainMessage: "Silakan buka halaman utama dan scan QR terlebih dahulu.",
      requestId: req.id,
    });
  }

  try {
    const [check] = await sock.onWhatsApp(jid);
    if (!check?.exists) {
      logger.warn(`[${req.id}] Nomor tidak terdaftar di WhatsApp`, {
        to: maskedJid,
      });

      return sendFormResult(req, res, 422, {
        success: false,
        title: "Nomor tidak valid",
        plainMessage: "Nomor tujuan tidak terdaftar di WhatsApp.",
        requestId: req.id,
      });
    }
  } catch (error) {
    logger.warn(`[${req.id}] Gagal cek status nomor WhatsApp, lanjut kirim tanpa validasi`, {
      to: maskedJid,
      error: error.message,
    });
  }

  const content = req.file ? buildMediaMessage(req.file, message) : { text: message };

  logger.info(`[${req.id}] Form kirim pesan`, {
    to: maskedJid,
    hasFile: Boolean(req.file),
    fileName: req.file?.originalname,
    messageLength: message.length,
    queueDepth: sendQueue.length,
    activeSendCount,
  });

  try {
    const { result, queueDelayMs, sendDurationMs } = await enqueueMessageSend({
      jid,
      content,
    });

    logger.info(`[${req.id}] Pesan form terkirim`, {
      to: maskedJid,
      queueDelayMs,
      sendDurationMs,
    });

    recordHistory({
      source: "form",
      to: maskedJid,
      type: req.file ? (message ? "file+text" : "file") : "text",
      message: (message || "").slice(0, 120),
      status: "sent",
      messageId: result?.key?.id,
      requestId: req.id,
    });

    return sendFormResult(req, res, 200, {
      success: true,
      title: "Pesan berhasil terkirim",
      plainMessage: `Pesan${req.file ? " (dengan file)" : ""} telah dikirim ke ${maskedJid}.`,
      requestId: req.id,
    });
  } catch (error) {
    logger.error(`[${req.id}] Gagal kirim dari form`, {
      to: maskedJid,
      error: error.message,
      stack: error.stack,
    });

    recordHistory({
      source: "form",
      to: maskedJid,
      type: req.file ? (message ? "file+text" : "file") : "text",
      message: (message || "").slice(0, 120),
      status: "failed",
      error: error.message,
      requestId: req.id,
    });

    const statusCode = error.code === "NOT_CONNECTED" ? 503 : 500;

    return sendFormResult(req, res, statusCode, {
      success: false,
      title: "Pengiriman gagal",
      plainMessage: error.message,
      requestId: req.id,
    });
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

  try {
    const [check] = await sock.onWhatsApp(jid);
    if (!check?.exists) {
      logger.warn(`[${req.id}] Nomor tidak terdaftar di WhatsApp`, {
        clientIp,
        to: maskedJid,
      });

      return res.status(422).json({
        success: false,
        message: "Nomor tujuan tidak terdaftar di WhatsApp",
        requestId: req.id,
      });
    }
  } catch (error) {
    logger.warn(`[${req.id}] Gagal cek status nomor WhatsApp, lanjut kirim tanpa validasi`, {
      clientIp,
      to: maskedJid,
      error: error.message,
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
      content: { text: message },
    });

    logger.info(`[${req.id}] API pesan terkirim`, {
      clientIp,
      to: maskedJid,
      messageId: result?.key?.id,
      queueDelayMs,
      sendDurationMs,
    });

    recordHistory({
      source: "api",
      to: maskedJid,
      type: "text",
      message: message.slice(0, 120),
      status: "sent",
      messageId: result?.key?.id,
      requestId: req.id,
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
    const statusCode = isQueueFull
      ? 429
      : error.code === "NOT_CONNECTED"
        ? 503
        : 500;

    logger.error(`[${req.id}] API kirim pesan gagal`, {
      clientIp,
      to: maskedJid,
      error: error.message,
      stack: error.stack,
    });

    recordHistory({
      source: "api",
      to: maskedJid,
      type: "text",
      message: message.slice(0, 120),
      status: "failed",
      error: error.message,
      requestId: req.id,
    });

    return res.status(statusCode).json({
      success: false,
      message: error.message,
      requestId: req.id,
      queueDepth: sendQueue.length,
    });
  }
});

app.post("/api/send-file", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? `Ukuran file melebihi batas ${MAX_FILE_SIZE_BYTES} bytes`
          : err.message;

      logger.warn(`[${req.id}] Upload file gagal`, { error: message });

      return res.status(400).json({
        success: false,
        message,
        requestId: req.id,
      });
    }

    return next();
  });
}, async (req, res) => {
  const clientIp = getClientIp(req);
  let jid;
  let caption;

  try {
    jid = normalizeRecipient(req.body.number);
    caption = normalizeOptionalCaption(req.body.caption);
  } catch (error) {
    logger.warn(`[${req.id}] Validasi API send-file gagal`, {
      clientIp,
      error: error.message,
    });

    return res.status(400).json({
      success: false,
      message: error.message,
      requestId: req.id,
    });
  }

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "File wajib diunggah pada field 'file'",
      requestId: req.id,
    });
  }

  const maskedJid = maskDestination(jid);

  if (!isConnected || !sock) {
    logger.warn(`[${req.id}] API send-file ditolak karena WhatsApp belum terhubung`, {
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

  try {
    const [check] = await sock.onWhatsApp(jid);
    if (!check?.exists) {
      logger.warn(`[${req.id}] Nomor tidak terdaftar di WhatsApp`, {
        clientIp,
        to: maskedJid,
      });

      return res.status(422).json({
        success: false,
        message: "Nomor tujuan tidak terdaftar di WhatsApp",
        requestId: req.id,
      });
    }
  } catch (error) {
    logger.warn(`[${req.id}] Gagal cek status nomor WhatsApp, lanjut kirim tanpa validasi`, {
      clientIp,
      to: maskedJid,
      error: error.message,
    });
  }

  logger.info(`[${req.id}] API kirim file`, {
    clientIp,
    to: maskedJid,
    fileName: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    hasCaption: Boolean(caption),
    queueDepth: sendQueue.length,
    activeSendCount,
  });

  try {
    const content = buildMediaMessage(req.file, caption);

    const { result, queueDelayMs, sendDurationMs } = await enqueueMessageSend({
      jid,
      content,
    });

    logger.info(`[${req.id}] API file terkirim`, {
      clientIp,
      to: maskedJid,
      messageId: result?.key?.id,
      queueDelayMs,
      sendDurationMs,
    });

    recordHistory({
      source: "api",
      to: maskedJid,
      type: caption ? "file+text" : "file",
      message: (caption || "").slice(0, 120),
      status: "sent",
      messageId: result?.key?.id,
      requestId: req.id,
    });

    return res.json({
      success: true,
      message: "File berhasil dikirim",
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
    const statusCode = isQueueFull
      ? 429
      : error.code === "NOT_CONNECTED"
        ? 503
        : 500;

    logger.error(`[${req.id}] API kirim file gagal`, {
      clientIp,
      to: maskedJid,
      error: error.message,
      stack: error.stack,
    });

    recordHistory({
      source: "api",
      to: maskedJid,
      type: caption ? "file+text" : "file",
      message: (caption || "").slice(0, 120),
      status: "failed",
      error: error.message,
      requestId: req.id,
    });

    return res.status(statusCode).json({
      success: false,
      message: error.message,
      requestId: req.id,
      queueDepth: sendQueue.length,
    });
  }
});

app.post("/api/test-chat", async (req, res) => {
  const clientIp = getClientIp(req);

  if (!isConnected || !sock || !sock.user) {
    return res.status(503).json({
      success: false,
      message: "WhatsApp belum terhubung",
      requestId: req.id,
    });
  }

  const ownJid = jidNormalizedUser(sock.user.id);
  const maskedJid = maskDestination(ownJid);

  logger.info(`[${req.id}] Test chat ke nomor sendiri`, {
    clientIp,
    to: maskedJid,
  });

  try {
    const { result, queueDelayMs, sendDurationMs } = await enqueueMessageSend({
      jid: ownJid,
      content: {
        text: `Test Chat berhasil ✅\nWaktu: ${new Date().toLocaleString("id-ID")}`,
      },
    });

    return res.json({
      success: true,
      message: "Test chat berhasil dikirim",
      to: maskedJid,
      requestId: req.id,
      messageId: result?.key?.id,
      queueDelayMs,
      sendDurationMs,
    });
  } catch (error) {
    logger.error(`[${req.id}] Test chat gagal`, {
      clientIp,
      to: maskedJid,
      error: error.message,
    });

    return res.status(500).json({
      success: false,
      message: error.message || "Test chat gagal dikirim",
      requestId: req.id,
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

app.get("/api/settings", (req, res) => {
  const currentValues = parseEnvContent(readEnvFileContent());

  const groups = SETTINGS_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    fields: group.fields.map((field) => ({
      ...field,
      value: currentValues[field.key] ?? "",
    })),
  }));

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    groups,
    requestId: req.id,
  });
});

app.post("/api/settings", (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body.values : null;

  if (!body || typeof body !== "object") {
    return res.status(400).json({
      success: false,
      message: "Payload values wajib berupa object",
      requestId: req.id,
    });
  }

  const updates = {};
  const invalidKeys = [];

  for (const [key, rawValue] of Object.entries(body)) {
    if (!SETTINGS_KEYS.has(key)) {
      invalidKeys.push(key);
      continue;
    }

    updates[key] = String(rawValue ?? "").replace(/[\r\n]/g, " ").trim();
  }

  if (invalidKeys.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Key tidak dikenal: ${invalidKeys.join(", ")}`,
      requestId: req.id,
    });
  }

  try {
    writeEnvUpdates(updates);

    const mergedValues = parseEnvContent(readEnvFileContent());
    const newPort = Number(mergedValues.PORT || PORT);
    const rawHost = mergedValues.HOST || HOST;
    const displayHost =
      !rawHost || rawHost === "0.0.0.0" ? req.hostname || "localhost" : rawHost;
    const redirectUrl = `${req.protocol}://${displayHost}:${newPort}/`;
    const portChanged = newPort !== PORT;

    logger.info(`[${req.id}] Pengaturan .env diperbarui, menjadwalkan restart`, {
      keys: Object.keys(updates),
      portChanged,
      newPort,
    });

    res.json({
      success: true,
      message: portChanged
        ? `Pengaturan tersimpan. Server sedang restart dan akan pindah ke port ${newPort}.`
        : "Pengaturan tersimpan. Server sedang restart untuk menerapkan perubahan.",
      restarting: true,
      portChanged,
      redirectUrl,
      requestId: req.id,
    });

    res.on("finish", () => scheduleRestart("settings_saved"));
    return;
  } catch (error) {
    logger.error(`[${req.id}] Gagal menyimpan pengaturan .env`, {
      error: error.message,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      message: "Gagal menyimpan pengaturan: " + error.message,
      requestId: req.id,
    });
  }
});

app.get("/api/logs", (req, res) => {
  const type = ["combined", "error", "whatsapp"].includes(req.query.type)
    ? req.query.type
    : "combined";
  const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 200));

  res.setHeader("Cache-Control", "no-store");

  return res.json({
    success: true,
    type,
    entries: readLogTail(type, limit),
    requestId: req.id,
  });
});

app.get("/api/history", (req, res) => {
  const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 100));
  const entries = messageHistory.slice(-limit).reverse();

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    entries,
    total: messageHistory.length,
    requestId: req.id,
  });
});

app.post("/api/broadcast", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? `Ukuran file melebihi batas ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB`
          : err.message;

      return res.status(400).json({ success: false, message, requestId: req.id });
    }

    return next();
  });
}, async (req, res) => {
  const clientIp = getClientIp(req);
  let targets;

  try {
    const rawNumbers = String(req.body.numbers || "")
      .split(/[\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean);

    if (!rawNumbers.length) {
      throw new Error("Daftar nomor tujuan wajib diisi (pisahkan dengan koma atau baris baru)");
    }

    if (rawNumbers.length > MAX_BROADCAST_TARGETS) {
      throw new Error(`Maksimum ${MAX_BROADCAST_TARGETS} nomor per broadcast`);
    }

    targets = rawNumbers.map((raw) => ({ raw, jid: normalizeRecipient(raw) }));
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }

  let message;
  try {
    message = normalizeOptionalCaption(req.body.message);
    if (!req.file) {
      message = normalizeMessage(message);
    }
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }

  if (!isConnected || !sock) {
    return res.status(503).json({
      success: false,
      message: "WhatsApp belum terhubung",
      requestId: req.id,
    });
  }

  const content = req.file ? buildMediaMessage(req.file, message) : { text: message };
  const type = req.file ? (message ? "file+text" : "file") : "text";

  logger.info(`[${req.id}] Broadcast dimulai`, {
    clientIp,
    total: targets.length,
    type,
  });

  targets.forEach(({ jid }) => {
    const maskedJid = maskDestination(jid);

    enqueueMessageSend({ jid, content })
      .then(({ result }) => {
        recordHistory({
          source: "broadcast",
          to: maskedJid,
          type,
          message: message.slice(0, 120),
          status: "sent",
          messageId: result?.key?.id,
          requestId: req.id,
        });
      })
      .catch((error) => {
        logger.error(`[${req.id}] Broadcast gagal ke satu nomor`, {
          to: maskedJid,
          error: error.message,
        });

        recordHistory({
          source: "broadcast",
          to: maskedJid,
          type,
          message: message.slice(0, 120),
          status: "failed",
          error: error.message,
          requestId: req.id,
        });
      });
  });

  return res.json({
    success: true,
    message: `Broadcast dijadwalkan ke ${targets.length} nomor. Cek tab Riwayat untuk status pengiriman.`,
    total: targets.length,
    requestId: req.id,
  });
});

app.get("/api/schedule", (req, res) => {
  const sorted = [...scheduledMessages].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    entries: sorted.map(({ jid, file, ...rest }) => rest),
    requestId: req.id,
  });
});

app.post("/api/schedule", (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? `Ukuran file melebihi batas ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB`
          : err.message;

      return res.status(400).json({ success: false, message, requestId: req.id });
    }

    return next();
  });
}, async (req, res) => {
  let jid;
  let message;
  let sendAtDate;

  try {
    jid = normalizeRecipient(req.body.number);
    message = normalizeOptionalCaption(req.body.message);

    if (!req.file && !message) {
      throw new Error("Isi pesan atau lampirkan file terlebih dahulu");
    }

    if (!req.body.sendAt) {
      throw new Error("Waktu pengiriman (sendAt) wajib diisi");
    }

    sendAtDate = new Date(req.body.sendAt);
    if (Number.isNaN(sendAtDate.getTime())) {
      throw new Error("Format waktu pengiriman tidak valid");
    }

    if (sendAtDate.getTime() <= Date.now()) {
      throw new Error("Waktu pengiriman harus di masa depan");
    }
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }

  const id = uuidv4();
  let fileInfo = null;

  if (req.file) {
    const storedPath = path.join(SCHEDULED_UPLOADS_DIR, `${id}-${req.file.originalname}`);
    await fs.promises.writeFile(storedPath, req.file.buffer);
    fileInfo = {
      path: storedPath,
      mimetype: req.file.mimetype,
      fileName: req.file.originalname,
    };
  }

  const job = {
    id,
    jid,
    to: maskDestination(jid),
    message,
    file: fileInfo,
    hasFile: Boolean(fileInfo),
    sendAt: sendAtDate.toISOString(),
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  scheduledMessages.push(job);
  saveScheduledMessages();

  logger.info(`[${req.id}] Pesan terjadwal dibuat`, {
    id,
    to: job.to,
    sendAt: job.sendAt,
    hasFile: job.hasFile,
  });

  const { jid: _jid, file: _file, ...publicJob } = job;

  return res.json({
    success: true,
    message: "Pesan terjadwal berhasil dibuat",
    entry: publicJob,
    requestId: req.id,
  });
});

app.delete("/api/schedule/:id", async (req, res) => {
  const job = scheduledMessages.find((entry) => entry.id === req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Pesan terjadwal tidak ditemukan",
      requestId: req.id,
    });
  }

  if (job.status !== "pending") {
    return res.status(409).json({
      success: false,
      message: `Pesan terjadwal sudah berstatus '${job.status}', tidak bisa dibatalkan`,
      requestId: req.id,
    });
  }

  job.status = "cancelled";
  job.cancelledAt = new Date().toISOString();

  if (job.file) {
    await fs.promises.unlink(job.file.path).catch(() => {});
  }

  saveScheduledMessages();

  logger.info(`[${req.id}] Pesan terjadwal dibatalkan`, { id: job.id });

  return res.json({
    success: true,
    message: "Pesan terjadwal dibatalkan",
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
    environment: NODE_ENV,
    timezone: process.env.TZ || "UTC",
    sendConcurrency: SEND_CONCURRENCY,
    maxQueueSize: MAX_QUEUE_SIZE,
    messageTimeoutMs: MESSAGE_TIMEOUT_MS,
  });

  if (!API_KEY) {
    logger.warn(
      "API_KEY belum diset — semua endpoint /api/* bisa diakses tanpa autentikasi. Set API_KEY di .env untuk mengamankannya.",
    );
  }
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

const schedulerTimer = setInterval(() => {
  processScheduledMessages().catch((error) => {
    logger.error("Gagal memproses antrean pesan terjadwal", {
      error: error.message,
      stack: error.stack,
    });
  });
}, SCHEDULER_INTERVAL_MS);
schedulerTimer.unref();
