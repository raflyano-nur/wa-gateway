require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
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
const MAX_ACCOUNTS = Math.max(1, Number(process.env.MAX_ACCOUNTS || 3));
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");

// Paket langganan user: menentukan berapa akun WAG & berapa pesan/hari yang
// boleh dikirim tiap user. Upgrade antar paket dikonfirmasi manual oleh admin
// (tidak ada payment gateway) — lihat /api/my/upgrade-request & tab Pengguna.
const PLAN_DEFS = {
  free: { label: "Free", maxAccounts: 1, dailyMessageLimit: 10, durationDays: null },
  pro: { label: "Pro", maxAccounts: 3, dailyMessageLimit: 200, durationDays: 30 },
  max: { label: "Max", maxAccounts: 10, dailyMessageLimit: 1000, durationDays: 30 },
};
const DEFAULT_USER_MAX_ACCOUNTS = PLAN_DEFS.free.maxAccounts;

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
      { key: "PUBLIC_BASE_URL", label: "URL Publik", type: "text", help: "Domain publik gateway ini, contoh: https://wa.domainanda.com (tanpa slash di akhir). Dipakai untuk kode Embed Widget QR supaya tidak memakai localhost. Kosongkan untuk otomatis memakai alamat yang sedang dipakai membuka dashboard ini." },
    ],
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    fields: [
      { key: "WA_AUTH_DIR", label: "Folder Sesi Auth", type: "text", help: "Lokasi penyimpanan sesi WhatsApp (folder induk, tiap akun dapat subfolder sendiri)." },
      { key: "WA_SESSION_NAME", label: "Nama Sesi", type: "text", help: "Label sesi (opsional, untuk referensi)." },
      { key: "MAX_ACCOUNTS", label: "Batas Jumlah Akun WhatsApp", type: "number", help: "Maksimum akun WhatsApp yang bisa terhubung bersamaan di gateway ini." },
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
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const SCHEDULED_UPLOADS_DIR = path.join(DATA_DIR, "scheduled-uploads");
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, "wa-gateway.db");
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

const db = new DatabaseSync(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    authDir TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS message_history (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    source TEXT,
    sessionId TEXT,
    recipient TEXT,
    type TEXT,
    message TEXT,
    status TEXT,
    messageId TEXT,
    error TEXT,
    requestId TEXT
  );

  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id TEXT PRIMARY KEY,
    sessionId TEXT,
    jid TEXT,
    recipient TEXT,
    message TEXT,
    filePath TEXT,
    fileMimetype TEXT,
    fileName TEXT,
    hasFile INTEGER NOT NULL DEFAULT 0,
    sendAt TEXT,
    status TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    sentAt TEXT,
    messageId TEXT,
    error TEXT,
    cancelledAt TEXT
  );

  CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    passwordSalt TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    passwordSalt TEXT NOT NULL,
    phone TEXT NOT NULL,
    maxAccounts INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS web_sessions (
    token TEXT PRIMARY KEY,
    subjectType TEXT NOT NULL,
    subjectId TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS payment_bot_state (
    jid TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
`);

// Migrasi kolom baru ke tabel `sessions` yang mungkin sudah berisi data dari
// versi sebelum ada model kepemilikan admin/user + alur approval. Idempotent:
// cek PRAGMA table_info dulu supaya aman dijalankan berkali-kali.
function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((col) => col.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn("sessions", "ownerType", "ownerType TEXT NOT NULL DEFAULT 'admin'");
ensureColumn("sessions", "ownerUserId", "ownerUserId TEXT");
ensureColumn("sessions", "status", "status TEXT NOT NULL DEFAULT 'active'");
ensureColumn("sessions", "requestedPhone", "requestedPhone TEXT");
ensureColumn("sessions", "approvedAt", "approvedAt TEXT");
ensureColumn("sessions", "approvedBy", "approvedBy TEXT");
ensureColumn("sessions", "rejectedAt", "rejectedAt TEXT");
ensureColumn("sessions", "rejectionReason", "rejectionReason TEXT");
ensureColumn("users", "plan", "plan TEXT NOT NULL DEFAULT 'free'");
ensureColumn("users", "pendingPlanRequest", "pendingPlanRequest TEXT");
ensureColumn("users", "planExpiresAt", "planExpiresAt TEXT");
ensureColumn("users", "apiKeyPrefix", "apiKeyPrefix TEXT");
ensureColumn("users", "apiKeyHash", "apiKeyHash TEXT");
ensureColumn("users", "apiKeySalt", "apiKeySalt TEXT");
ensureColumn("users", "apiKeyCreatedAt", "apiKeyCreatedAt TEXT");

db.exec("CREATE INDEX IF NOT EXISTS idx_users_api_key_prefix ON users (apiKeyPrefix)");

const insertSessionStmt = db.prepare(
  "INSERT OR IGNORE INTO sessions (id, name, authDir, createdAt) VALUES (@id, @name, @authDir, @createdAt)",
);
const insertHistoryStmt = db.prepare(`
  INSERT INTO message_history (id, timestamp, source, sessionId, recipient, type, message, status, messageId, error, requestId)
  VALUES (@id, @timestamp, @source, @sessionId, @recipient, @type, @message, @status, @messageId, @error, @requestId)
`);
const trimHistoryStmt = db.prepare(
  "DELETE FROM message_history WHERE rowid NOT IN (SELECT rowid FROM message_history ORDER BY rowid DESC LIMIT ?)",
);
const insertScheduledStmt = db.prepare(`
  INSERT INTO scheduled_messages (id, sessionId, jid, recipient, message, filePath, fileMimetype, fileName, hasFile, sendAt, status, createdAt, sentAt, messageId, error, cancelledAt)
  VALUES (@id, @sessionId, @jid, @recipient, @message, @filePath, @fileMimetype, @fileName, @hasFile, @sendAt, @status, @createdAt, @sentAt, @messageId, @error, @cancelledAt)
`);
const updateScheduledJobStmt = db.prepare(`
  UPDATE scheduled_messages
  SET status = @status, sentAt = @sentAt, messageId = @messageId, error = @error, cancelledAt = @cancelledAt
  WHERE id = @id
`);

// Migrasi satu kali dari file JSON versi lama (kalau ada dan tabelnya masih
// kosong), supaya data yang sudah tersimpan sebelumnya tidak hilang saat
// upgrade ke penyimpanan SQLite. File lama diganti nama jadi *.migrated
// sebagai cadangan, bukan dihapus.
function migrateLegacyJsonFile(jsonFile, countSql, migrateEntry) {
  if (!fs.existsSync(jsonFile)) {
    return;
  }

  const existingCount = db.prepare(countSql).get().c;
  if (existingCount > 0) {
    return;
  }

  const stored = readJsonFile(jsonFile, []);
  if (!Array.isArray(stored) || !stored.length) {
    return;
  }

  stored.forEach(migrateEntry);

  try {
    fs.renameSync(jsonFile, `${jsonFile}.migrated`);
  } catch {
    // abaikan, data sudah aman tersimpan di SQLite
  }

  console.log(
    `[migrasi] ${stored.length} baris dipindah dari ${path.basename(jsonFile)} ke SQLite.`,
  );
}

migrateLegacyJsonFile(SESSIONS_FILE, "SELECT COUNT(*) AS c FROM sessions", (entry) => {
  insertSessionStmt.run({
    id: entry.id,
    name: entry.name,
    authDir: entry.authDir,
    createdAt: entry.createdAt || new Date().toISOString(),
  });
});

migrateLegacyJsonFile(HISTORY_FILE, "SELECT COUNT(*) AS c FROM message_history", (entry) => {
  insertHistoryStmt.run({
    id: entry.id || uuidv4(),
    timestamp: entry.timestamp || new Date().toISOString(),
    source: entry.source ?? null,
    sessionId: entry.sessionId ?? null,
    recipient: entry.to ?? null,
    type: entry.type ?? null,
    message: entry.message ?? null,
    status: entry.status ?? null,
    messageId: entry.messageId ?? null,
    error: entry.error ?? null,
    requestId: entry.requestId ?? null,
  });
});

migrateLegacyJsonFile(SCHEDULE_FILE, "SELECT COUNT(*) AS c FROM scheduled_messages", (entry) => {
  insertScheduledStmt.run({
    id: entry.id,
    sessionId: entry.sessionId ?? null,
    jid: entry.jid ?? null,
    recipient: entry.to ?? null,
    message: entry.message ?? null,
    filePath: entry.file?.path ?? null,
    fileMimetype: entry.file?.mimetype ?? null,
    fileName: entry.file?.fileName ?? null,
    hasFile: entry.hasFile ? 1 : 0,
    sendAt: entry.sendAt ?? null,
    status: entry.status ?? "pending",
    createdAt: entry.createdAt || new Date().toISOString(),
    sentAt: entry.sentAt ?? null,
    messageId: entry.messageId ?? null,
    error: entry.error ?? null,
    cancelledAt: entry.cancelledAt ?? null,
  });
});

function recordHistory(entry) {
  insertHistoryStmt.run({
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    source: entry.source ?? null,
    sessionId: entry.sessionId ?? null,
    recipient: entry.to ?? null,
    type: entry.type ?? null,
    message: entry.message ?? null,
    status: entry.status ?? null,
    messageId: entry.messageId ?? null,
    error: entry.error ?? null,
    requestId: entry.requestId ?? null,
  });

  trimHistoryStmt.run(MAX_HISTORY_ENTRIES);
}

function rowToHistoryEntry(row) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    source: row.source,
    sessionId: row.sessionId,
    to: row.recipient,
    type: row.type,
    message: row.message,
    status: row.status,
    messageId: row.messageId,
    error: row.error,
    requestId: row.requestId,
  };
}

function listHistory(limit) {
  const rows = db
    .prepare("SELECT * FROM message_history ORDER BY rowid DESC LIMIT ?")
    .all(limit);
  const total = db.prepare("SELECT COUNT(*) AS c FROM message_history").get().c;

  return { entries: rows.map(rowToHistoryEntry), total };
}

function rowToJob(row) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    jid: row.jid,
    to: row.recipient,
    message: row.message,
    file: row.filePath
      ? { path: row.filePath, mimetype: row.fileMimetype, fileName: row.fileName }
      : null,
    hasFile: Boolean(row.hasFile),
    sendAt: row.sendAt,
    status: row.status,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
    messageId: row.messageId,
    error: row.error,
    cancelledAt: row.cancelledAt,
  };
}

function insertScheduledJob(job) {
  insertScheduledStmt.run({
    id: job.id,
    sessionId: job.sessionId,
    jid: job.jid,
    recipient: job.to,
    message: job.message,
    filePath: job.file?.path ?? null,
    fileMimetype: job.file?.mimetype ?? null,
    fileName: job.file?.fileName ?? null,
    hasFile: job.hasFile ? 1 : 0,
    sendAt: job.sendAt,
    status: job.status,
    createdAt: job.createdAt,
    sentAt: null,
    messageId: null,
    error: null,
    cancelledAt: null,
  });
}

function listScheduledJobs() {
  return db.prepare("SELECT * FROM scheduled_messages ORDER BY createdAt DESC").all().map(rowToJob);
}

function findScheduledJob(id) {
  const row = db.prepare("SELECT * FROM scheduled_messages WHERE id = ?").get(id);
  return row ? rowToJob(row) : null;
}

function listDuePendingJobs(now) {
  return db
    .prepare("SELECT * FROM scheduled_messages WHERE status = 'pending' AND sendAt <= ?")
    .all(new Date(now).toISOString())
    .map(rowToJob);
}

function updateScheduledJob(id, patch) {
  const current = db.prepare("SELECT * FROM scheduled_messages WHERE id = ?").get(id);
  if (!current) {
    return null;
  }

  updateScheduledJobStmt.run({
    id,
    status: patch.status ?? current.status,
    sentAt: patch.sentAt ?? current.sentAt,
    messageId: patch.messageId ?? current.messageId,
    error: patch.error ?? current.error,
    cancelledAt: patch.cancelledAt ?? current.cancelledAt,
  });

  return findScheduledJob(id);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  const hashBuffer = Buffer.from(hash, "hex");
  const expectedBuffer = Buffer.from(expectedHash, "hex");
  return (
    hashBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(hashBuffer, expectedBuffer)
  );
}

function rowToAdmin(row) {
  return { id: row.id, username: row.username, createdAt: row.createdAt };
}

function listAdmins() {
  return db
    .prepare("SELECT id, username, createdAt FROM admins ORDER BY createdAt ASC")
    .all()
    .map(rowToAdmin);
}

function createAdmin(username, password) {
  const trimmedUsername = String(username || "").trim();
  if (trimmedUsername.length < 3) {
    throw new Error("Username admin minimal 3 karakter");
  }
  if (String(password || "").length < 6) {
    throw new Error("Password admin minimal 6 karakter");
  }

  const existing = db.prepare("SELECT id FROM admins WHERE username = ?").get(trimmedUsername);
  if (existing) {
    throw new Error(`Username '${trimmedUsername}' sudah dipakai`);
  }

  const { salt, hash } = hashPassword(password);
  const admin = {
    id: uuidv4(),
    username: trimmedUsername,
    passwordHash: hash,
    passwordSalt: salt,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    "INSERT INTO admins (id, username, passwordHash, passwordSalt, createdAt) VALUES (@id, @username, @passwordHash, @passwordSalt, @createdAt)",
  ).run(admin);

  return rowToAdmin(admin);
}

function updateAdminPassword(id, password) {
  if (String(password || "").length < 6) {
    throw new Error("Password admin minimal 6 karakter");
  }

  const existing = db.prepare("SELECT id FROM admins WHERE id = ?").get(id);
  if (!existing) {
    throw new Error("Admin tidak ditemukan");
  }

  const { salt, hash } = hashPassword(password);
  db.prepare("UPDATE admins SET passwordHash = ?, passwordSalt = ? WHERE id = ?").run(
    hash,
    salt,
    id,
  );
}

function deleteAdmin(id) {
  const result = db.prepare("DELETE FROM admins WHERE id = ?").run(id);
  if (result.changes === 0) {
    throw new Error("Admin tidak ditemukan");
  }
}

// ---------------------------------------------------------------------------
// Users (tenant), sesi login (cookie), config operasional, & alur approval
// akun WAG milik user. Lihat plan: hashed-stargazing-moore.md
// ---------------------------------------------------------------------------

function rowToUser(row) {
  const plan = PLAN_DEFS[row.plan] ? row.plan : "free";
  return {
    id: row.id,
    username: row.username,
    phone: row.phone,
    maxAccounts: row.maxAccounts,
    createdAt: row.createdAt,
    plan,
    planLabel: PLAN_DEFS[plan].label,
    dailyMessageLimit: PLAN_DEFS[plan].dailyMessageLimit,
    pendingPlanRequest: row.pendingPlanRequest || null,
    planExpiresAt: row.planExpiresAt || null,
    apiKeyPrefix: row.apiKeyPrefix || null,
    apiKeyCreatedAt: row.apiKeyCreatedAt || null,
  };
}

function createUser(username, password, phone) {
  const trimmedUsername = String(username || "").trim();
  if (trimmedUsername.length < 3) {
    throw new Error("Username minimal 3 karakter");
  }
  if (String(password || "").length < 6) {
    throw new Error("Password minimal 6 karakter");
  }

  const trimmedPhone = String(phone || "").replace(/[^\d]/g, "");
  if (trimmedPhone.length < 8) {
    throw new Error("Nomor HP tidak valid");
  }

  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(trimmedUsername);
  if (existing) {
    throw new Error(`Username '${trimmedUsername}' sudah dipakai`);
  }

  const { salt, hash } = hashPassword(password);
  const user = {
    id: uuidv4(),
    username: trimmedUsername,
    passwordHash: hash,
    passwordSalt: salt,
    phone: trimmedPhone,
    maxAccounts: DEFAULT_USER_MAX_ACCOUNTS,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    "INSERT INTO users (id, username, passwordHash, passwordSalt, phone, maxAccounts, createdAt) VALUES (@id, @username, @passwordHash, @passwordSalt, @phone, @maxAccounts, @createdAt)",
  ).run(user);

  return rowToUser(user);
}

function findUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(String(username || "").trim());
}

function findUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function findUserByPhone(phone) {
  return db.prepare("SELECT * FROM users WHERE phone = ?").get(String(phone || "").replace(/[^\d]/g, ""));
}

// API key per-user: cuma hash-nya yang disimpan (kunci mentahnya cuma bisa
// dilihat sekali saat generate/regenerate — dikirim via WA & ditampilkan
// sekali di UI). apiKeyPrefix (12 karakter awal, bukan rahasia) dipakai
// sebagai index untuk cari user pemilik key tanpa perlu scan semua hash.
function generateApiKeyForUser(userId) {
  const rawKey = `wagk_${crypto.randomBytes(24).toString("base64url")}`;
  const prefix = rawKey.slice(0, 12);
  const { salt, hash } = hashPassword(rawKey);

  db.prepare(
    "UPDATE users SET apiKeyPrefix = ?, apiKeyHash = ?, apiKeySalt = ?, apiKeyCreatedAt = ? WHERE id = ?",
  ).run(prefix, hash, salt, new Date().toISOString(), userId);

  return rawKey;
}

function findUserByApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith("wagk_")) {
    return null;
  }

  const prefix = rawKey.slice(0, 12);
  const row = db.prepare("SELECT * FROM users WHERE apiKeyPrefix = ?").get(prefix);

  if (!row || !row.apiKeyHash || !verifyPassword(rawKey, row.apiKeySalt, row.apiKeyHash)) {
    return null;
  }

  return row;
}

function requireUserApiKey(req, res, next) {
  const providedKey = req.get("x-api-key") || "";
  const row = findUserByApiKey(providedKey);

  if (!row) {
    return res.status(401).json({ success: false, message: "API key tidak valid", requestId: req.id });
  }

  req.user = rowToUser(row);
  return next();
}

function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY createdAt ASC").all().map(rowToUser);
}

function updateUserPlan(id, plan) {
  if (!PLAN_DEFS[plan]) {
    throw new Error("Paket tidak dikenal");
  }

  const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!existing) {
    throw new Error("User tidak ditemukan");
  }

  const durationDays = PLAN_DEFS[plan].durationDays;
  const expiresAt = durationDays
    ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  db.prepare(
    "UPDATE users SET plan = ?, maxAccounts = ?, pendingPlanRequest = NULL, planExpiresAt = ? WHERE id = ?",
  ).run(plan, PLAN_DEFS[plan].maxAccounts, expiresAt, id);
}

function setUserPendingPlanRequest(id, plan) {
  db.prepare("UPDATE users SET pendingPlanRequest = ? WHERE id = ?").run(plan, id);
}

function downgradeUserToFree(id) {
  db.prepare("UPDATE users SET plan = 'free', maxAccounts = ?, planExpiresAt = NULL WHERE id = ?").run(
    PLAN_DEFS.free.maxAccounts,
    id,
  );
}

// Dipanggil berkala (bareng scheduler pesan terjadwal) untuk menurunkan user
// yang masa aktif paket berbayarnya sudah lewat kembali ke Free secara otomatis.
function processExpiredPlans() {
  const rows = db
    .prepare(
      "SELECT id, username, phone, plan FROM users WHERE planExpiresAt IS NOT NULL AND planExpiresAt <= ? AND plan != 'free'",
    )
    .all(new Date().toISOString());

  for (const row of rows) {
    downgradeUserToFree(row.id);

    logger.info("Paket user kadaluarsa, diturunkan ke Free", { user: row.username, previousPlan: row.plan });

    sendUserNotification(
      row.phone,
      `Paket ${PLAN_DEFS[row.plan]?.label || row.plan} kamu sudah habis masa berlakunya dan otomatis diturunkan ke Free. Upgrade lagi kalau mau lanjut pakai kuota lebih besar.`,
    );
  }
}

function countUserMessagesToday(userId) {
  const sessionIds = listUserSessionRows(userId).map((row) => row.id);
  if (!sessionIds.length) {
    return 0;
  }

  const placeholders = sessionIds.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM message_history WHERE sessionId IN (${placeholders}) AND date(timestamp) = date('now')`,
    )
    .get(...sessionIds);

  return row.c;
}

function deleteUserRow(id) {
  const result = db.prepare("DELETE FROM users WHERE id = ?").run(id);
  if (result.changes === 0) {
    throw new Error("User tidak ditemukan");
  }
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function createWebSession(subjectType, subjectId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();

  db.prepare(
    "INSERT INTO web_sessions (token, subjectType, subjectId, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)",
  ).run(token, subjectType, subjectId, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString());

  return token;
}

function findWebSession(token, subjectType) {
  if (!token) {
    return null;
  }

  const row = db
    .prepare("SELECT * FROM web_sessions WHERE token = ? AND subjectType = ?")
    .get(token, subjectType);

  if (!row) {
    return null;
  }

  if (new Date(row.expiresAt).getTime() < Date.now()) {
    db.prepare("DELETE FROM web_sessions WHERE token = ?").run(token);
    return null;
  }

  return row;
}

function deleteWebSession(token) {
  if (!token) {
    return;
  }
  db.prepare("DELETE FROM web_sessions WHERE token = ?").run(token);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const result = {};
  if (!header) {
    return result;
  }

  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) {
      return;
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(value);
      } catch {
        result[key] = value;
      }
    }
  });

  return result;
}

function setSessionCookie(req, res, name, token, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(token)}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${maxAgeSec}`];
  if (req.secure) {
    parts.push("Secure");
  }
  res.append("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(req, res, name) {
  const parts = [`${name}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (req.secure) {
    parts.push("Secure");
  }
  res.append("Set-Cookie", parts.join("; "));
}

function requireAdminSession(req, res, next) {
  const cookies = parseCookies(req);
  const webSession = findWebSession(cookies.wa_admin_sid, "admin");

  if (!webSession) {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({
        success: false,
        message: "Belum login sebagai admin",
        requestId: req.id,
      });
    }
    // Redirect ke portal user (bukan /login) supaya pengunjung biasa yang
    // buka "/" tanpa sesi tidak langsung disodori halaman login admin —
    // admin tetap bisa buka /login langsung lewat URL kalau perlu.
    return res.redirect(302, "/app/login");
  }

  req.admin = { id: webSession.subjectId };
  return next();
}

function requireUserSession(req, res, next) {
  const cookies = parseCookies(req);
  const webSession = findWebSession(cookies.wa_user_sid, "user");
  const userRow = webSession ? findUserById(webSession.subjectId) : null;

  if (!webSession || !userRow) {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({
        success: false,
        message: "Belum login",
        requestId: req.id,
      });
    }
    return res.redirect(302, "/app/login");
  }

  req.user = rowToUser(userRow);
  return next();
}

function getConfig(key) {
  const row = db.prepare("SELECT value FROM app_config WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  db.prepare(
    "INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

// Harga tiap paket diatur admin lewat tab Persetujuan (disimpan di app_config,
// bukan hardcode) — supaya bisa diubah kapan saja tanpa restart server.
function getPlansWithPricing() {
  const plans = {};
  for (const [key, def] of Object.entries(PLAN_DEFS)) {
    const storedPrice = getConfig(`planPrice_${key}`);
    plans[key] = {
      ...def,
      price: key === "free" ? 0 : Number(storedPrice) || 0,
    };
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Auto-reply pembayaran: begitu nomor notifikasi admin dapat chat yang
// menyebut "upgrade paket" (cocok dengan template pesan yang dikirim user
// dari /app/upgrade/:plan), bot otomatis balas menu metode pembayaran, lalu
// balas detail (nomor DANA/Mandiri atau gambar QRIS) sesuai pilihan user.
// Dibatasi trigger keyword supaya tidak ikut membalas chat WA bisnis normal
// yang tidak terkait di nomor yang sama.
// ---------------------------------------------------------------------------

function getPaymentBotState(jid) {
  const row = db.prepare("SELECT state FROM payment_bot_state WHERE jid = ?").get(jid);
  return row ? row.state : null;
}

function setPaymentBotState(jid, state) {
  db.prepare(
    "INSERT INTO payment_bot_state (jid, state, updatedAt) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET state = excluded.state, updatedAt = excluded.updatedAt",
  ).run(jid, state, new Date().toISOString());
}

function clearPaymentBotState(jid) {
  db.prepare("DELETE FROM payment_bot_state WHERE jid = ?").run(jid);
}

function getPaymentConfig() {
  return {
    danaNumber: getConfig("paymentDanaNumber") || "",
    danaName: getConfig("paymentDanaName") || "",
    mandiriNumber: getConfig("paymentMandiriNumber") || "",
    mandiriName: getConfig("paymentMandiriName") || "",
    hasQris: Boolean(getConfig("paymentQrisImage")),
  };
}

async function sendPaymentMenu(session, jid) {
  await session.sock.sendMessage(jid, {
    text: "Baik kak, silakan pilih metode pembayarannya:\n1. DANA\n2. QRIS\n3. Bank Mandiri\n\nBalas dengan angka atau nama metode ya.",
  });
}

// Ketiga fungsi kirim-info-pembayaran ini mengembalikan boolean: true kalau
// metodenya sudah dikonfigurasi admin & berhasil dikirim, false kalau belum
// tersedia (pesan "belum tersedia" tetap dikirim, tapi caller TIDAK boleh
// menganggap alur selesai — state awaiting_choice harus tetap jalan supaya
// user bisa coba metode lain).
async function sendDanaInfo(session, jid) {
  const { danaNumber, danaName } = getPaymentConfig();
  if (!danaNumber) {
    await session.sock.sendMessage(jid, { text: "Maaf kak, metode DANA belum tersedia. Silakan pilih metode lain." });
    return false;
  }
  await session.sock.sendMessage(jid, {
    text: `Silakan transfer ke DANA:\n📱 ${danaNumber}\na.n. ${danaName}\n\nSetelah transfer, kirim bukti pembayaran (screenshot) ke chat ini ya, nanti segera dikonfirmasi.`,
  });
  return true;
}

async function sendMandiriInfo(session, jid) {
  const { mandiriNumber, mandiriName } = getPaymentConfig();
  if (!mandiriNumber) {
    await session.sock.sendMessage(jid, { text: "Maaf kak, metode Bank Mandiri belum tersedia. Silakan pilih metode lain." });
    return false;
  }
  await session.sock.sendMessage(jid, {
    text: `Silakan transfer ke Bank Mandiri:\n🏦 ${mandiriNumber}\na.n. ${mandiriName}\n\nSetelah transfer, kirim bukti pembayaran (screenshot) ke chat ini ya, nanti segera dikonfirmasi.`,
  });
  return true;
}

async function sendQrisInfo(session, jid) {
  const qrisImage = getConfig("paymentQrisImage");
  if (!qrisImage) {
    await session.sock.sendMessage(jid, { text: "Maaf kak, metode QRIS belum tersedia. Silakan pilih metode lain." });
    return false;
  }
  const base64Data = qrisImage.split(",").pop();
  await session.sock.sendMessage(jid, {
    image: Buffer.from(base64Data, "base64"),
    caption: "Scan QRIS berikut untuk pembayaran.\n\nSetelah transfer, kirim bukti pembayaran ke chat ini ya, nanti segera dikonfirmasi.",
  });
  return true;
}

async function sendChangeChoiceMenu(session, jid) {
  await session.sock.sendMessage(jid, {
    text: "Mau ganti pilihan?\n1. Ganti pilihan paket\n2. Ganti metode pembayaran\n3. Batal, gak jadi upgrade\n\nBalas angkanya ya.",
  });
}

function buildPlanListText() {
  const plans = getPlansWithPricing();
  const lines = ["Berikut paket yang tersedia:", ""];

  for (const key of ["free", "pro", "max"]) {
    const def = plans[key];
    const price = def.price > 0 ? `Rp${def.price.toLocaleString("id-ID")}/bulan` : "Gratis";
    const duration = def.durationDays ? `, berlaku ${def.durationDays} hari` : "";
    lines.push(`*${def.label}* - ${price}`);
    lines.push(`${def.maxAccounts} akun WAG, ${def.dailyMessageLimit} pesan/hari${duration}`);
    lines.push("");
  }

  lines.push("Balas nama paketnya (Free/Pro/Max), atau ketik *batal* untuk membatalkan.");
  return lines.join("\n");
}

async function sendPlanList(session, jid) {
  await session.sock.sendMessage(jid, { text: buildPlanListText() });
}

const CANCEL_KEYWORDS = ["batal", "gak jadi", "ga jadi", "tidak jadi", "nggak jadi", "cancel"];

function isCancelKeyword(normalized) {
  return CANCEL_KEYWORDS.some((k) => normalized.includes(k));
}

// Membatalkan alur upgrade: hapus pendingPlanRequest user (kalau ada) supaya
// badge "Minta upgrade" di dashboard admin tidak nyangkut/salah info, terus
// akhiri percakapan bot (state dihapus total, idle sampai trigger baru).
async function cancelUpgradeFlow(session, jid) {
  const userRow = findUserByPhone(jid.split("@")[0]);
  if (userRow && userRow.pendingPlanRequest) {
    setUserPendingPlanRequest(userRow.id, null);
  }

  await session.sock.sendMessage(jid, {
    text: "Oke kak, dibatalkan ya. Chat \"upgrade paket\" lagi kapan aja kalau mau lanjut.",
  });
  clearPaymentBotState(jid);
}

async function handlePaymentBotMessage(session, jid, text) {
  const notifierSessionId = getConfig("notifierSessionId");
  if (!notifierSessionId || session.id !== notifierSessionId || !text) {
    return;
  }

  const normalized = text.trim().toLowerCase();
  const state = getPaymentBotState(jid);

  // Bisa dibatalkan kapan pun selama masih di tengah alur bot.
  if (state && isCancelKeyword(normalized)) {
    await cancelUpgradeFlow(session, jid);
    return;
  }

  if (state === "awaiting_choice") {
    let success = false;

    if (normalized === "1" || normalized.includes("dana")) {
      success = await sendDanaInfo(session, jid);
    } else if (normalized === "2" || normalized.includes("qris")) {
      success = await sendQrisInfo(session, jid);
    } else if (normalized === "3" || normalized.includes("mandiri") || normalized.includes("bank")) {
      success = await sendMandiriInfo(session, jid);
    }

    if (success) {
      // Sudah kirim detail pembayaran — tetap "siaga": kalau user chat apa
      // pun setelah ini (mis. berubah pikiran), tawarkan ganti paket/metode
      // lagi, supaya tidak perlu ketik ulang "upgrade paket" dari awal.
      setPaymentBotState(jid, "post_payment");
      return;
    }

    // Metode belum dikonfigurasi admin (pesan "belum tersedia" sudah dikirim
    // di atas) ATAU balasan tidak dikenali — kirim ulang menu, tetap di state
    // awaiting_choice supaya user bisa coba metode lain.
    await sendPaymentMenu(session, jid);
    return;
  }

  if (state === "post_payment") {
    await sendChangeChoiceMenu(session, jid);
    setPaymentBotState(jid, "post_payment_menu");
    return;
  }

  if (state === "post_payment_menu") {
    if (normalized === "1" || normalized.includes("paket")) {
      await sendPlanList(session, jid);
      setPaymentBotState(jid, "choosing_plan");
      return;
    }

    if (normalized === "2" || normalized.includes("metode") || normalized.includes("bayar")) {
      await sendPaymentMenu(session, jid);
      setPaymentBotState(jid, "awaiting_choice");
      return;
    }

    if (normalized === "3") {
      await cancelUpgradeFlow(session, jid);
      return;
    }

    // Balasan tidak dikenali — tetap tawarkan lagi pilihannya (sticky, tidak
    // berhenti cuma sekali).
    await sendChangeChoiceMenu(session, jid);
    return;
  }

  if (state === "choosing_plan") {
    const userRow = findUserByPhone(jid.split("@")[0]);

    if (normalized.includes("free")) {
      if (userRow) {
        setUserPendingPlanRequest(userRow.id, null);
      }
      await session.sock.sendMessage(jid, {
        text: "Oke kak, tetap di paket Free ya (gratis). Chat \"upgrade paket\" lagi kapan aja kalau berubah pikiran.",
      });
      clearPaymentBotState(jid);
      return;
    }

    const chosenPlan = normalized.includes("max") ? "max" : normalized.includes("pro") ? "pro" : null;

    if (chosenPlan) {
      if (userRow) {
        setUserPendingPlanRequest(userRow.id, chosenPlan);
        const price = getPlansWithPricing()[chosenPlan].price;
        const priceText = price > 0 ? `Rp${price.toLocaleString("id-ID")}/bulan` : "gratis";
        sendAdminNotification(
          `${userRow.username} (${userRow.phone}) ganti pilihan upgrade ke paket ${PLAN_DEFS[chosenPlan].label} (${priceText}) lewat chat. Buka tab Pengguna untuk konfirmasi.`,
        );
      }

      await session.sock.sendMessage(jid, {
        text: `Oke kak, paket diganti ke *${PLAN_DEFS[chosenPlan].label}*.`,
      });
      await sendPaymentMenu(session, jid);
      setPaymentBotState(jid, "awaiting_choice");
      return;
    }

    // Balasan tidak dikenali — tetap tawarkan lagi daftar paketnya.
    await sendPlanList(session, jid);
    return;
  }

  if (normalized.includes("upgrade paket")) {
    await sendPaymentMenu(session, jid);
    setPaymentBotState(jid, "awaiting_choice");
  }
}

const insertPendingRequestStmt = db.prepare(`
  INSERT INTO sessions (id, name, authDir, createdAt, ownerType, ownerUserId, status, requestedPhone)
  VALUES (@id, @name, @authDir, @createdAt, 'user', @ownerUserId, 'pending_approval', @requestedPhone)
`);

function countUserSessions(userId) {
  return db
    .prepare(
      "SELECT COUNT(*) AS c FROM sessions WHERE ownerUserId = ? AND status IN ('pending_approval', 'active')",
    )
    .get(userId).c;
}

function createPendingWagRequest(user, name) {
  const id = uuidv4();
  const trimmedName = String(name || "").trim();
  const row = {
    id,
    name: trimmedName || `WAG ${user.username}`,
    authDir: sessionAuthDirName(id),
    createdAt: new Date().toISOString(),
    ownerUserId: user.id,
    requestedPhone: user.phone,
  };

  insertPendingRequestStmt.run(row);
  return getSessionRow(id);
}

function getSessionRow(id) {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
}

function listUserSessionRows(userId) {
  return db.prepare("SELECT * FROM sessions WHERE ownerUserId = ? ORDER BY createdAt DESC").all(userId);
}

function listPendingRequests() {
  return db
    .prepare(
      `SELECT s.*, u.username AS ownerUsername, u.phone AS ownerPhone
       FROM sessions s JOIN users u ON u.id = s.ownerUserId
       WHERE s.status = 'pending_approval'
       ORDER BY s.createdAt ASC`,
    )
    .all();
}

function approveSessionRequest(id, adminId) {
  const row = getSessionRow(id);
  if (!row || row.status !== "pending_approval") {
    throw new Error("Permintaan tidak ditemukan atau sudah diproses");
  }

  db.prepare("UPDATE sessions SET status = 'active', approvedAt = ?, approvedBy = ? WHERE id = ?").run(
    new Date().toISOString(),
    adminId,
    id,
  );

  return getSessionRow(id);
}

function rejectSessionRequest(id, reason) {
  const row = getSessionRow(id);
  if (!row || row.status !== "pending_approval") {
    throw new Error("Permintaan tidak ditemukan atau sudah diproses");
  }

  db.prepare("UPDATE sessions SET status = 'rejected', rejectedAt = ?, rejectionReason = ? WHERE id = ?").run(
    new Date().toISOString(),
    reason || null,
    id,
  );

  return getSessionRow(id);
}

function deleteSessionRow(id) {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

async function sendSystemNotification(jid, text) {
  if (!jid) {
    return;
  }

  const notifierSessionId = getConfig("notifierSessionId");
  const notifierSession = notifierSessionId ? sessions.get(notifierSessionId) : null;

  if (!notifierSession || !notifierSession.isConnected || !notifierSession.sock) {
    logger.warn("Notifikasi WA dilewati: WAG notifier belum dikonfigurasi/terhubung", {
      jid: maskDestination(jid),
    });
    return;
  }

  try {
    await notifierSession.sock.sendMessage(normalizeRecipient(jid), { text });
  } catch (error) {
    logger.warn("Gagal mengirim notifikasi WA", { jid: maskDestination(jid), error: error.message });
  }
}

function sendAdminNotification(text) {
  const adminPhone = getConfig("adminNotifyPhone");
  if (!adminPhone) {
    return;
  }
  return sendSystemNotification(adminPhone, text);
}

function sendUserNotification(phone, text) {
  if (!phone) {
    return;
  }
  return sendSystemNotification(phone, text);
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
  const due = listDuePendingJobs(Date.now()).filter(
    (job) => getSession(job.sessionId)?.isConnected,
  );

  if (!due.length) {
    return;
  }

  for (const job of due) {
    const session = getSession(job.sessionId);

    try {
      if (!session) {
        throw new Error(`Akun WhatsApp '${job.sessionId}' tidak ditemukan`);
      }

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

      const { result } = await enqueueMessageSend(session, { jid: job.jid, content });

      updateScheduledJob(job.id, {
        status: "sent",
        sentAt: new Date().toISOString(),
        messageId: result?.key?.id ?? null,
      });

      recordHistory({
        source: "scheduled",
        sessionId: job.sessionId,
        to: maskDestination(job.jid),
        type: job.file ? (job.message ? "file+text" : "file") : "text",
        message: (job.message || "").slice(0, 120),
        status: "sent",
        messageId: result?.key?.id,
      });

      logger.info("Pesan terjadwal terkirim", { id: job.id, to: maskDestination(job.jid) });
    } catch (error) {
      updateScheduledJob(job.id, {
        status: "failed",
        error: error.message,
      });

      recordHistory({
        source: "scheduled",
        sessionId: job.sessionId,
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

const DASHBOARD_API_PATHS = new Set(["/status", "/qr", "/logout", "/test-chat", "/sessions"]);

app.use("/api", (req, res, next) => {
  // /api/auth/*, /api/admin/*, /api/my/*, dan /api/external/* punya
  // proteksinya sendiri (cookie session admin/user, atau API key per-user
  // lewat requireUserApiKey), jadi tidak perlu (dan tidak boleh) ikut
  // diwajibkan x-api-key GLOBAL milik admin di sini.
  if (
    DASHBOARD_API_PATHS.has(req.path) ||
    req.path.startsWith("/sessions/") ||
    req.path.startsWith("/auth/") ||
    req.path.startsWith("/admin/") ||
    req.path.startsWith("/my/") ||
    req.path.startsWith("/external/")
  ) {
    return next();
  }
  return requireApiKey(req, res, next);
});

const DEFAULT_SESSION_ID = "default";

const sessions = new Map();

function sessionAuthDirName(id) {
  return id === DEFAULT_SESSION_ID ? AUTH_DIR : path.join(AUTH_DIR, id);
}

function loadSessionRegistry() {
  // Hanya sesi berstatus 'active' yang boleh dapat runtime (socket WA & QR).
  // Permintaan 'pending_approval'/'rejected' tetap di tabel sessions tapi
  // tidak ikut dimuat ke Map in-memory sampai di-approve admin.
  const activeStored = db
    .prepare("SELECT id, name, authDir, createdAt FROM sessions WHERE status = 'active'")
    .all();
  const totalCount = db.prepare("SELECT COUNT(*) AS c FROM sessions").get().c;

  if (totalCount > 0) {
    return activeStored;
  }

  // Instalasi baru atau migrasi dari versi single-session lama: jadikan
  // folder auth yang sudah ada (kalau ada) sebagai sesi "default" apa
  // adanya, supaya akun yang sudah pernah scan QR tidak perlu scan ulang.
  return [
    {
      id: DEFAULT_SESSION_ID,
      name: "Akun Utama",
      authDir: sessionAuthDirName(DEFAULT_SESSION_ID),
      createdAt: new Date().toISOString(),
    },
  ];
}

function createSessionRuntime(id, name, authDir, createdAt) {
  return {
    id,
    name,
    authDir,
    createdAt: createdAt || new Date().toISOString(),
    sock: null,
    qrCodeData: "",
    qrUpdatedAt: 0,
    isConnected: false,
    isConnecting: false,
    reconnectTimer: null,
    reconnectAttempt: 0,
    socketGeneration: 0,
    lastDisconnectReason: null,
    lastDisconnectMessage: null,
    lastConnectionState: "starting",
    isLogoutInProgress: false,
    sendQueue: [],
    activeSendCount: 0,
  };
}

function getSession(id) {
  return sessions.get(id || DEFAULT_SESSION_ID);
}

function getDefaultSession() {
  return sessions.get(DEFAULT_SESSION_ID) || sessions.values().next().value;
}

function resolveSessionOrRespond(req, res) {
  const requestedId = (req.body && req.body.session) || req.query.session || DEFAULT_SESSION_ID;
  const session = sessions.get(requestedId) || (requestedId === DEFAULT_SESSION_ID ? getDefaultSession() : null);

  if (!session) {
    res.status(404).json({
      success: false,
      message: `Akun WhatsApp '${requestedId}' tidak ditemukan`,
      requestId: req.id,
    });
    return null;
  }

  return session;
}

function listSessionsSummary() {
  return Array.from(sessions.values()).map((session) => ({
    id: session.id,
    name: session.name,
    connected: session.isConnected,
    connecting: session.isConnecting,
    logoutInProgress: session.isLogoutInProgress,
    hasQR: session.qrCodeData !== "",
    queueDepth: session.sendQueue.length,
    activeSendCount: session.activeSendCount,
    reconnectAttempt: session.reconnectAttempt,
    lastConnectionState: session.lastConnectionState,
    lastDisconnectReason: session.lastDisconnectReason,
    lastDisconnectMessage: session.lastDisconnectMessage,
    qrUpdatedAt: session.qrUpdatedAt,
    createdAt: session.createdAt,
  }));
}

function bootstrapSessions() {
  const registry = loadSessionRegistry();

  registry.forEach((entry) => {
    sessions.set(
      entry.id,
      createSessionRuntime(entry.id, entry.name, entry.authDir, entry.createdAt),
    );
    insertSessionStmt.run({
      id: entry.id,
      name: entry.name,
      authDir: entry.authDir,
      createdAt: entry.createdAt,
    });
  });
}

async function addSession(name) {
  if (sessions.size >= MAX_ACCOUNTS) {
    throw new Error(`Batas maksimum ${MAX_ACCOUNTS} akun WhatsApp sudah tercapai`);
  }

  const id = uuidv4().split("-")[0];
  const trimmedName = String(name || "").trim() || `Akun ${sessions.size + 1}`;
  const session = createSessionRuntime(id, trimmedName, sessionAuthDirName(id));

  sessions.set(id, session);
  insertSessionStmt.run({
    id: session.id,
    name: session.name,
    authDir: session.authDir,
    createdAt: session.createdAt,
  });

  connectToWhatsApp(session).catch((error) => {
    logger.error("Gagal memulai sesi WhatsApp baru", {
      session: id,
      error: error.message,
      stack: error.stack,
    });
  });

  return session;
}

async function teardownSessionSocket(session) {
  clearReconnectTimer(session);
  session.socketGeneration += 1;

  if (session.sock && session.isConnected) {
    try {
      await withTimeout(
        session.sock.logout("Hapus akun"),
        LOGOUT_TIMEOUT_MS,
        "Logout WhatsApp",
      );
    } catch {
      // abaikan, tetap lanjut hapus sesi
    }
  }

  try {
    session.sock?.end?.();
  } catch {
    // socket sudah tertutup, aman diabaikan
  }

  await removeAuthStateDirectory(session).catch(() => {});
}

async function removeSession(id) {
  const session = sessions.get(id);

  if (!session) {
    throw new Error("Akun tidak ditemukan");
  }

  if (sessions.size <= 1) {
    throw new Error("Minimal harus ada 1 akun WhatsApp");
  }

  await teardownSessionSocket(session);

  sessions.delete(id);
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

async function removeUserOwnedSession(id, userId) {
  const row = getSessionRow(id);

  if (!row || row.ownerType !== "user" || row.ownerUserId !== userId) {
    throw new Error("Akun WAG tidak ditemukan");
  }

  const session = sessions.get(id);
  if (session) {
    await teardownSessionSocket(session);
    sessions.delete(id);
  }

  deleteSessionRow(id);
}

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

function clearReconnectTimer(session) {
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
}

function getAuthDirPath(session) {
  return path.resolve(__dirname, session.authDir);
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

function getGatewayStatus(session, reqId) {
  return {
    version: APP_VERSION,
    environment: NODE_ENV,
    sessionId: session.id,
    sessionName: session.name,
    connected: session.isConnected,
    connecting: session.isConnecting,
    logoutInProgress: session.isLogoutInProgress,
    hasQR: session.qrCodeData !== "",
    queueDepth: session.sendQueue.length,
    activeSendCount: session.activeSendCount,
    reconnectAttempt: session.reconnectAttempt,
    lastConnectionState: session.lastConnectionState,
    lastDisconnectReason: session.lastDisconnectReason,
    lastDisconnectMessage: session.lastDisconnectMessage,
    qrUpdatedAt: session.qrUpdatedAt,
    timestamp: new Date().toISOString(),
    requestId: reqId,
  };
}

function scheduleReconnect(session, context) {
  if (session.reconnectTimer || session.isConnecting) {
    return;
  }

  session.reconnectAttempt += 1;
  const delayMs = getReconnectDelayMs(session.reconnectAttempt);

  logger.warn("Menjadwalkan reconnect WhatsApp", {
    session: session.id,
    attempt: session.reconnectAttempt,
    delayMs,
    context,
  });

  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    connectToWhatsApp(session).catch((error) => {
      logger.error("Reconnect WhatsApp gagal", {
        session: session.id,
        error: error.message,
        stack: error.stack,
      });
    });
  }, delayMs);
}

function processSendQueue(session) {
  while (session.activeSendCount < SEND_CONCURRENCY && session.sendQueue.length > 0) {
    const task = session.sendQueue.shift();
    session.activeSendCount += 1;

    (async () => {
      const queueDelayMs = Date.now() - task.enqueuedAt;

      if (
          !session.sock ||
          !session.isConnected ||
          !session.sock.user ||
          !session.sock.ws?.isOpen
      ) {
          const notConnectedError = new Error("WhatsApp belum terhubung");
          notConnectedError.code = "NOT_CONNECTED";
          throw notConnectedError;
      }

      const sendStartedAt = Date.now();

      const result = await withTimeout(
          session.sock.sendMessage(task.jid, task.content),
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
              logger.warn("Send timeout, reconnecting WhatsApp", { session: session.id });

              session.isConnected = false;

              try {
                  session.sock?.end?.();
              } catch {}

              scheduleReconnect(session, "send_timeout");
          }

          task.reject(err);
      })
      .finally(() => {
        session.activeSendCount -= 1;
        setImmediate(() => processSendQueue(session));
      });
  }
}

function enqueueMessageSend(session, payload) {
  if (session.sendQueue.length >= MAX_QUEUE_SIZE) {
    throw new Error("Antrean pengiriman sedang penuh, coba lagi sebentar");
  }

  return new Promise((resolve, reject) => {
    session.sendQueue.push({
      ...payload,
      enqueuedAt: Date.now(),
      resolve,
      reject,
    });

    setImmediate(() => processSendQueue(session));
  });
}

async function updateQrCode(session, qr) {
  session.qrCodeData = await qrcode.toDataURL(qr, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 256,
  });
  session.qrUpdatedAt = Date.now();
}

async function removeAuthStateDirectory(session) {
  const authDirPath = assertSafeAuthDirPath(getAuthDirPath(session));
  await fs.promises.rm(authDirPath, { recursive: true, force: true });
  logger.info("Folder auth WhatsApp dihapus", { session: session.id, authDir: authDirPath });
}

async function logoutAndRotateAccount(session, reqId) {
  if (session.isLogoutInProgress) {
    throw new Error("Logout akun sedang diproses");
  }

  session.isLogoutInProgress = true;
  clearReconnectTimer(session);

  const activeSock = session.sock;
  const hadSocket = Boolean(activeSock);
  const canLogoutCompanion = Boolean(activeSock) && session.isConnected;

  session.socketGeneration += 1;
  session.sock = null;
  session.isConnected = false;
  session.isConnecting = false;
  session.qrCodeData = "";
  session.qrUpdatedAt = Date.now();
  session.reconnectAttempt = 0;
  session.lastConnectionState = "logging_out";
  session.lastDisconnectReason = null;
  session.lastDisconnectMessage = "Logout manual sedang diproses";

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
          session: session.id,
          error: error.message,
          stack: error.stack,
        });
      }
    }

    await removeAuthStateDirectory(session);

    session.lastConnectionState = "logged_out";
    session.lastDisconnectReason = DisconnectReason.loggedOut;
    session.lastDisconnectMessage = "Sesi lama dihapus. Silakan scan akun baru.";

    logger.info(`[${reqId}] Sesi WhatsApp direset untuk ganti akun`, {
      session: session.id,
      hadSocket,
      canLogoutCompanion,
      authDir: session.authDir,
    });

    await connectToWhatsApp(session);
  } finally {
    session.isLogoutInProgress = false;
  }
}

async function connectToWhatsApp(session) {
  if (session.isConnecting) {
    return;
  }

  clearReconnectTimer(session);
  session.isConnecting = true;
  session.isConnected = false;
  session.lastConnectionState = "connecting";

  const currentGeneration = ++session.socketGeneration;

  try {
    logger.info("Memulai koneksi WhatsApp", { session: session.id, authDir: session.authDir });

    const { state, saveCreds } = await useMultiFileAuthState(getAuthDirPath(session));
    const { version, isLatest } = await fetchLatestBaileysVersion();

    logger.info("Versi WA Web dipakai", { session: session.id, version, isLatest });

    const sock = makeWASocket({
      version,                    // add this line
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: [`${APP_NAME} - ${session.name}`, "Desktop", "1.0.0"],
      connectTimeoutMs: 20000,
      defaultQueryTimeoutMs: MESSAGE_TIMEOUT_MS,
      keepAliveIntervalMs: 30000,
      emitOwnEvents: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    session.sock = sock;

    sock.ev.on("connection.update", async (update) => {
      if (currentGeneration !== session.socketGeneration) {
        return;
      }

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          await updateQrCode(session, qr);
          session.lastConnectionState = "qr_ready";
          logger.info("QR code baru siap dipindai", { session: session.id });
        } catch (error) {
          logger.error("Gagal membuat QR code", {
            session: session.id,
            error: error.message,
            stack: error.stack,
          });
        }
      }

      if (connection === "open") {
        session.isConnected = true;
        session.isConnecting = false;
        session.reconnectAttempt = 0;
        session.qrCodeData = "";
        session.qrUpdatedAt = Date.now();
        session.lastConnectionState = "open";
        session.lastDisconnectReason = null;
        session.lastDisconnectMessage = null;

        logger.info("WhatsApp terhubung", { session: session.id });
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

      session.isConnected = false;
      session.isConnecting = false;
      session.qrCodeData = "";
      session.qrUpdatedAt = Date.now();
      session.lastConnectionState = "closed";
      session.lastDisconnectReason = reason || "unknown";
      session.lastDisconnectMessage = disconnectError?.message || "Connection closed";

      logger.error("Koneksi WhatsApp terputus", {
          session: session.id,
          reason,
          shouldReconnect,
          disconnect: lastDisconnect,
          error: disconnectError,
      });

      if (shouldReconnect) {
        scheduleReconnect(session, "connection_closed");
      } else {
        session.reconnectAttempt = 0;
        clearReconnectTimer(session);
        logger.error("Sesi WhatsApp logout, perlu scan ulang", { session: session.id });
      }
    });

    sock.ev.on("creds.update", (creds) => {
      if (currentGeneration !== session.socketGeneration) {
        return;
      }

      saveCreds(creds);
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (currentGeneration !== session.socketGeneration || type !== "notify") {
        return;
      }

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) {
          continue;
        }

        const text = extractIncomingText(msg.message);

        if (WEBHOOK_URL) {
          dispatchWebhook({
            sessionId: session.id,
            sessionName: session.name,
            from: msg.key.remoteJid,
            fromMasked: maskDestination(msg.key.remoteJid),
            pushName: msg.pushName || null,
            messageId: msg.key.id,
            timestamp: Number(msg.messageTimestamp) * 1000,
            type: Object.keys(msg.message)[0] || "unknown",
            text,
          });
        }

        handlePaymentBotMessage(session, msg.key.remoteJid, text).catch((error) => {
          logger.warn("Gagal memproses auto-reply pembayaran", {
            session: session.id,
            error: error.message,
          });
        });
      }
    });

    sock.ws.on("close", () => {
        logger.warn("WebSocket closed", { session: session.id });
        session.isConnected = false;
    });

    sock.ws.on("error", (err) => {
        logger.error("WebSocket error", {
            session: session.id,
            error: err.message,
        });

        session.isConnected = false;
    });
  } catch (error) {
    session.isConnecting = false;
    session.isConnected = false;
    session.lastConnectionState = "error";
    session.lastDisconnectReason = "connect_error";
    session.lastDisconnectMessage = error.message;

    logger.error("Error saat koneksi WhatsApp", {
      session: session.id,
      error: error.message,
      stack: error.stack,
    });

    scheduleReconnect(session, "connect_error");
    throw error;
  }
}

function renderBrandMark() {
  return `<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2C6.48 2 2 6.15 2 11.27c0 2.62 1.18 5 3.11 6.7-.1 1.02-.4 2.6-1.11 3.94 1.6-.14 3.34-.7 4.55-1.42 1.09.32 2.26.5 3.45.5 5.52 0 10-4.15 10-9.27C22 6.15 17.52 2 12 2z"/>
    </svg>
</span>`;
}

function renderAdminLoginPage() {
  return `<!doctype html>
<html lang="id" class="h-full">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Login Admin — ${escapeHtml(APP_NAME)}</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="flex h-full items-center justify-center bg-slate-100 text-slate-800">
    <div class="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div class="flex items-center gap-2.5">
            ${renderBrandMark()}
            <div>
                <p class="text-sm font-bold text-slate-900">${escapeHtml(APP_NAME)}</p>
                <p class="text-xs text-slate-400">Login Admin</p>
            </div>
        </div>

        <form id="adminLoginForm" class="mt-5 space-y-3">
            <div>
                <label for="loginUsername" class="text-xs font-semibold text-slate-700">Username</label>
                <input id="loginUsername" name="username" type="text" required autofocus
                    class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
            </div>
            <div>
                <label for="loginPassword" class="text-xs font-semibold text-slate-700">Password</label>
                <input id="loginPassword" name="password" type="password" required
                    class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
            </div>
            <p id="adminLoginError" class="hidden text-xs font-medium text-red-600"></p>
            <button type="submit" class="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Masuk</button>
        </form>

        <p class="mt-4 text-center text-xs text-slate-400">Bukan admin? <a href="/app/login" class="font-semibold text-emerald-700 hover:underline">Login sebagai pengguna</a></p>
    </div>

<script>
    document.getElementById('adminLoginForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const errorEl = document.getElementById('adminLoginError');
        errorEl.classList.add('hidden');

        try {
            const response = await fetch('/api/auth/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: document.getElementById('loginUsername').value,
                    password: document.getElementById('loginPassword').value,
                }),
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Login gagal');
            window.location.href = '/';
        } catch (error) {
            errorEl.textContent = error.message;
            errorEl.classList.remove('hidden');
        }
    });
</script>
</body>
</html>`;
}

function renderUserLoginPage() {
  return `<!doctype html>
<html lang="id" class="h-full">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Login / Daftar — ${escapeHtml(APP_NAME)}</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="flex h-full items-center justify-center bg-slate-100 text-slate-800">
    <div class="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div class="flex items-center gap-2.5">
            ${renderBrandMark()}
            <div>
                <p class="text-sm font-bold text-slate-900">${escapeHtml(APP_NAME)}</p>
                <p class="text-xs text-slate-400">Portal Pengguna</p>
            </div>
        </div>

        <div class="mt-5 flex gap-1.5 rounded-xl bg-slate-100 p-1.5">
            <button type="button" data-auth-tab="login" class="auth-tab flex-1 rounded-lg bg-white py-2 text-sm font-semibold text-slate-800 shadow-sm transition">Login</button>
            <button type="button" data-auth-tab="register" class="auth-tab flex-1 rounded-lg py-2 text-sm font-semibold text-slate-500 transition">Daftar</button>
        </div>

        <form id="userLoginForm" class="mt-4 space-y-3">
            <div>
                <label class="text-xs font-semibold text-slate-700">Username</label>
                <input name="username" type="text" required class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
            </div>
            <div>
                <label class="text-xs font-semibold text-slate-700">Password</label>
                <input name="password" type="password" required class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
            </div>
            <p class="hidden text-xs font-medium text-red-600" data-auth-error></p>
            <button type="submit" class="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Masuk</button>
        </form>

        <form id="userRegisterForm" class="mt-4 hidden space-y-3">
            <div>
                <label class="text-xs font-semibold text-slate-700">Username</label>
                <input name="username" type="text" required minlength="3" class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
            </div>
            <div>
                <label class="text-xs font-semibold text-slate-700">Nomor HP (untuk notifikasi WhatsApp)</label>
                <input name="phone" type="text" required placeholder="mis. 628123456789" class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
            </div>
            <div>
                <label class="text-xs font-semibold text-slate-700">Password</label>
                <input name="password" type="password" required minlength="6" class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
            </div>
            <p class="hidden text-xs font-medium text-red-600" data-auth-error></p>
            <button type="submit" class="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Daftar</button>
        </form>

        <p class="mt-4 text-center text-xs text-slate-400">Gratis 1 akun WAG. Butuh lebih? Hubungi admin setelah daftar.</p>
    </div>

<script>
    const authTabs = document.querySelectorAll('[data-auth-tab]');
    const loginForm = document.getElementById('userLoginForm');
    const registerForm = document.getElementById('userRegisterForm');

    authTabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const isLogin = tab.dataset.authTab === 'login';
            authTabs.forEach((t) => {
                const active = t === tab;
                t.classList.toggle('bg-white', active);
                t.classList.toggle('shadow-sm', active);
                t.classList.toggle('text-slate-800', active);
                t.classList.toggle('text-slate-500', !active);
            });
            loginForm.classList.toggle('hidden', !isLogin);
            registerForm.classList.toggle('hidden', isLogin);
        });
    });

    function bindForm(form, url) {
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const errorEl = form.querySelector('[data-auth-error]');
            errorEl.classList.add('hidden');

            const payload = {};
            new FormData(form).forEach((value, key) => { payload[key] = value; });

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.message || 'Gagal');
                window.location.href = '/app';
            } catch (error) {
                errorEl.textContent = error.message;
                errorEl.classList.remove('hidden');
            }
        });
    }

    bindForm(loginForm, '/api/auth/login');
    bindForm(registerForm, '/api/auth/register');
</script>
</body>
</html>`;
}

function renderUserPortalPage(user) {
  return `<!doctype html>
<html lang="id" class="h-full">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Portal Pengguna — ${escapeHtml(APP_NAME)}</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="h-full overflow-hidden bg-slate-100 text-slate-800">
    <div class="flex h-full">
        <aside class="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white sm:flex">
            <div class="flex items-center gap-2.5 border-b border-slate-200 px-5 py-4">
                ${renderBrandMark()}
                <div class="min-w-0">
                    <p class="truncate text-sm font-bold text-slate-900">${escapeHtml(APP_NAME)}</p>
                    <p class="truncate text-xs text-slate-400">Portal Pengguna <span class="text-slate-300">&middot;</span> ${escapeHtml(user.username)}</p>
                </div>
            </div>

            <nav class="flex-1 space-y-1 p-3">
                <button type="button" data-page-tab="dashboard" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
                    Akun WAG
                </button>
                <button type="button" data-page-tab="send" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>
                    Kirim Pesan
                </button>
                <button type="button" data-page-tab="plans" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                    Paket Langganan
                </button>
                <button type="button" data-page-tab="embed" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>
                    Embed Widget QR
                </button>
                <button type="button" data-page-tab="docs" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                    Dokumentasi API
                </button>
            </nav>

            <div class="border-t border-slate-200 p-3">
                <button id="userLogoutButton" type="button" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs font-medium text-red-500 transition hover:bg-red-50">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>
                    Keluar
                </button>
            </div>
        </aside>

        <div class="flex min-w-0 flex-1 flex-col">
            <header class="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
                <div class="flex items-center gap-2.5 sm:hidden">
                    ${renderBrandMark()}
                    <p class="text-sm font-bold text-slate-900">${escapeHtml(APP_NAME)}</p>
                </div>
                <h1 id="pageTitle" class="hidden text-base font-semibold text-slate-800 sm:block">Akun WAG</h1>
                <button id="userLogoutButtonMobile" type="button" class="inline-flex h-9 items-center justify-center rounded-lg bg-slate-100 px-4 text-xs font-semibold text-slate-700 hover:bg-slate-200 transition sm:hidden">Keluar</button>
            </header>

            <nav class="flex gap-1.5 overflow-x-auto border-b border-slate-200 bg-white px-4 py-2 sm:hidden">
                <button type="button" data-page-tab="dashboard" class="page-tab shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition">Akun WAG</button>
                <button type="button" data-page-tab="send" class="page-tab shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition">Kirim Pesan</button>
                <button type="button" data-page-tab="plans" class="page-tab shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition">Paket</button>
                <button type="button" data-page-tab="embed" class="page-tab shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition">Embed</button>
                <button type="button" data-page-tab="docs" class="page-tab shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition">Dokumentasi</button>
            </nav>

            <main class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
                <section id="page-dashboard" class="page-panel mx-auto max-w-2xl">
                    <div class="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 class="text-sm font-semibold text-slate-800">Akun WAG Saya</h2>
                            <p id="quotaInfo" class="text-xs text-slate-400">Memuat kuota...</p>
                        </div>
                        <button id="requestWagButton" type="button" class="inline-flex h-9 items-center justify-center rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white hover:bg-emerald-700 transition">+ Request Akun WAG</button>
                    </div>

                    <div id="myAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

                    <div id="myGrid" class="mt-4 grid gap-4 sm:grid-cols-2">
                        <p class="text-sm text-slate-400">Memuat...</p>
                    </div>
                </section>

                <section id="page-send" class="page-panel mx-auto max-w-2xl hidden">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <div class="flex items-center justify-between gap-2">
                            <h2 class="text-sm font-semibold text-slate-800">Kirim Pesan</h2>
                            <p id="sendQuotaInfo" class="text-xs text-slate-400">Memuat kuota...</p>
                        </div>
                        <form id="sendMessageForm" class="mt-3 space-y-3">
                            <div>
                                <label class="text-xs font-semibold text-slate-700">Kirim Dari Akun</label>
                                <select id="sendFromSession" required class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm">
                                    <option value="">Belum ada akun aktif</option>
                                </select>
                            </div>
                            <div>
                                <label class="text-xs font-semibold text-slate-700">Nomor Tujuan</label>
                                <input id="sendToNumber" type="text" required placeholder="mis. 628123456789"
                                    class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            </div>
                            <div>
                                <label class="text-xs font-semibold text-slate-700">Pesan</label>
                                <textarea id="sendMessageText" rows="3" required
                                    class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"></textarea>
                            </div>
                            <button id="sendMessageButton" type="submit" class="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Kirim</button>
                        </form>
                    </div>
                </section>

                <section id="page-plans" class="page-panel mx-auto max-w-2xl hidden">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Paket Langganan</h2>
                        <p class="mt-1 text-xs text-slate-500">Upgrade paket untuk kirim lebih banyak pesan/hari &amp; bikin lebih banyak akun WAG. Permintaan upgrade dikonfirmasi manual oleh admin.</p>
                        <div id="planCards" class="mt-3 grid gap-3 sm:grid-cols-3">
                            <p class="text-sm text-slate-400">Memuat...</p>
                        </div>
                    </div>
                </section>

                <section id="page-embed" class="page-panel mx-auto max-w-2xl hidden">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Embed Widget QR</h2>
                        <p class="mt-1 text-xs text-slate-500">Tempel kode ini di website lain untuk menampilkan status &amp; QR scan akun WAG kamu. Pilih akun yang mau ditampilkan.</p>
                        <select id="embedSession" class="mt-3 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm">
                            <option value="">Belum ada akun aktif</option>
                        </select>
                        <textarea id="embedCode" rows="3" readonly class="mt-3 w-full resize-none rounded-lg border border-slate-200 bg-slate-50 p-2.5 font-mono text-xs text-slate-600"></textarea>
                        <button id="copyEmbedButton" type="button" class="mt-2 inline-flex h-8 items-center justify-center rounded-lg bg-slate-100 px-3.5 text-xs font-semibold text-slate-700 hover:bg-slate-200 transition">Salin Kode</button>
                        <p id="embedLocalhostWarning" class="mt-2 hidden rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">Alamat di atas memakai <code>localhost</code>, jadi hanya bisa dibuka dari komputer ini. Minta admin isi URL Publik di tab Pengaturan supaya bisa dipakai di website lain.</p>
                    </div>
                </section>

                <section id="page-docs" class="page-panel mx-auto max-w-2xl hidden">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">API Key Kamu</h2>
                        <p class="mt-1 text-xs text-slate-500">Dipakai buat autentikasi endpoint kirim pesan lewat kode/aplikasi kamu sendiri (header <code class="rounded bg-slate-100 px-1 py-0.5">x-api-key</code>). Berlaku untuk semua paket (Free/Pro/Max) — kuota kirim/hari tetap ikut paket kamu. Kunci cuma ditampilkan sekali di sini &amp; dikirim sekali lewat WhatsApp ke nomor kamu; kalau hilang, generate ulang (kunci lama otomatis mati).</p>

                        <div id="apiKeyAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

                        <div id="apiKeyRevealBox" class="mt-3 hidden rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                            <p class="text-xs font-semibold text-emerald-700">API Key baru kamu (simpan sekarang, cuma tampil sekali):</p>
                            <div class="mt-1.5 flex items-center gap-2">
                                <code id="apiKeyRevealValue" class="min-w-0 flex-1 overflow-x-auto rounded-lg bg-white px-2.5 py-2 text-xs text-slate-800"></code>
                                <button id="copyApiKeyButton" type="button" class="shrink-0 inline-flex h-8 items-center justify-center rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-700 transition">Salin</button>
                            </div>
                        </div>

                        <div class="mt-3 flex items-center justify-between gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-3">
                            <div class="min-w-0">
                                <p id="apiKeyStatusLabel" class="truncate text-sm font-semibold text-slate-700">Memuat...</p>
                                <p id="apiKeyStatusSub" class="text-xs text-slate-400"></p>
                            </div>
                            <button id="generateApiKeyButton" type="button" class="shrink-0 inline-flex h-9 items-center justify-center rounded-lg bg-slate-800 px-4 text-xs font-semibold text-white hover:bg-slate-900 transition">Generate Ulang</button>
                        </div>
                    </div>

                    <div class="mt-5 rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Dokumentasi API</h2>
                        <p class="mt-1 text-xs text-slate-500">Endpoint status/QR bersifat publik (tidak butuh key) — dipakai widget embed, tapi bisa juga kamu panggil sendiri. Endpoint kirim pesan wajib pakai API key kamu sendiri di atas. Ganti <code class="rounded bg-slate-100 px-1 py-0.5">SESSION_ID</code> dengan ID akun WAG kamu (lihat tabel di bawah).</p>

                        <div id="docsSessionTableWrap" class="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                            <table class="w-full text-sm">
                                <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr><th class="px-4 py-2 text-left">Nama Akun</th><th class="px-4 py-2 text-left">Session ID</th></tr>
                                </thead>
                                <tbody id="docsSessionTableBody" class="divide-y divide-slate-200">
                                    <tr><td class="px-4 py-3 text-slate-400" colspan="2">Memuat...</td></tr>
                                </tbody>
                            </table>
                        </div>

                        <div class="mt-5">
                            <div class="flex items-center gap-3">
                                <span class="rounded-md bg-emerald-100 px-2.5 py-1 text-xs font-bold tracking-wide text-emerald-700">GET</span>
                                <code class="text-sm font-semibold text-slate-800">/api/status?session=SESSION_ID</code>
                            </div>
                            <p class="mt-1.5 text-xs text-slate-500">Status koneksi akun WAG (terhubung/menunggu QR/dsb).</p>
                            <div class="mt-2 flex items-center justify-between rounded-t-lg bg-slate-900 px-3 py-1.5">
                                <span class="text-xs font-medium text-slate-400">curl</span>
                                <button type="button" data-copy-target="curlStatus" class="doc-copy-btn text-xs font-medium text-slate-400 hover:text-white transition">Salin</button>
                            </div>
                            <pre class="overflow-auto rounded-b-lg bg-slate-950 px-3 py-3 text-xs leading-relaxed text-emerald-300"><code id="curlStatus"></code></pre>
                        </div>

                        <div class="mt-5">
                            <div class="flex items-center gap-3">
                                <span class="rounded-md bg-emerald-100 px-2.5 py-1 text-xs font-bold tracking-wide text-emerald-700">GET</span>
                                <code class="text-sm font-semibold text-slate-800">/api/qr?session=SESSION_ID</code>
                            </div>
                            <p class="mt-1.5 text-xs text-slate-500">Kode QR (data URL base64) untuk dipindai, kalau akunnya belum terhubung.</p>
                            <div class="mt-2 flex items-center justify-between rounded-t-lg bg-slate-900 px-3 py-1.5">
                                <span class="text-xs font-medium text-slate-400">curl</span>
                                <button type="button" data-copy-target="curlQr" class="doc-copy-btn text-xs font-medium text-slate-400 hover:text-white transition">Salin</button>
                            </div>
                            <pre class="overflow-auto rounded-b-lg bg-slate-950 px-3 py-3 text-xs leading-relaxed text-emerald-300"><code id="curlQr"></code></pre>
                        </div>

                        <p class="mt-5 text-xs text-slate-400">Butuh kirim pesan lewat kode/aplikasi kamu sendiri (bukan cuma dari tab Kirim Pesan)? Endpoint pengiriman pesan (<code class="rounded bg-slate-100 px-1 py-0.5">/api/send</code> dkk) pakai API key khusus yang dikelola admin — hubungi admin kalau perlu akses itu.</p>
                    </div>
                </section>
            </main>
        </div>
    </div>

<script>
    const pollIntervalMs = ${STATUS_POLL_INTERVAL_MS};
    const publicBaseUrl = ${JSON.stringify(PUBLIC_BASE_URL)};
    const myGrid = document.getElementById('myGrid');
    const myAlert = document.getElementById('myAlert');
    const quotaInfo = document.getElementById('quotaInfo');
    const requestWagButton = document.getElementById('requestWagButton');
    const embedSession = document.getElementById('embedSession');
    const embedCode = document.getElementById('embedCode');
    const copyEmbedButton = document.getElementById('copyEmbedButton');
    const embedLocalhostWarning = document.getElementById('embedLocalhostWarning');
    const sendQuotaInfo = document.getElementById('sendQuotaInfo');
    const sendFromSession = document.getElementById('sendFromSession');
    const sendMessageForm = document.getElementById('sendMessageForm');
    const sendMessageButton = document.getElementById('sendMessageButton');
    const planCards = document.getElementById('planCards');
    let myCache = [];
    let myPlanInfo = { plan: 'free', dailyMessageLimit: 10, messagesToday: 0, pendingPlanRequest: null, planExpiresAt: null };
    let plansInfo = {};
    const qrCache = {};

    function formatRupiah(value) {
        return value > 0 ? 'Rp' + Number(value).toLocaleString('id-ID') + '/bulan' : 'Gratis';
    }

    function renderPlanCards() {
        const keys = Object.keys(plansInfo);
        if (!keys.length) {
            planCards.innerHTML = '<p class="text-sm text-slate-400 sm:col-span-3">Memuat...</p>';
            return;
        }

        planCards.innerHTML = keys.map((key) => {
            const def = plansInfo[key];
            const isCurrent = key === myPlanInfo.plan;
            const isPending = myPlanInfo.pendingPlanRequest === key;
            let actionHtml;

            if (isCurrent) {
                const expiryText = myPlanInfo.planExpiresAt
                    ? 'Aktif s.d. ' + new Date(myPlanInfo.planExpiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
                    : 'Paket Aktif';
                actionHtml = '<span class="mt-3 block rounded-lg bg-emerald-50 py-2 text-center text-xs font-semibold text-emerald-700">' + expiryText + '</span>';
            } else if (isPending) {
                actionHtml = '<span class="mt-3 block rounded-lg bg-amber-50 py-2 text-center text-xs font-semibold text-amber-700">Menunggu Konfirmasi Admin</span>';
            } else {
                actionHtml = '<a href="/app/upgrade/' + key + '" class="mt-3 block w-full rounded-lg bg-emerald-600 py-2 text-xs font-semibold text-white hover:bg-emerald-700 transition">Upgrade ke ' + def.label + '</a>';
            }

            return '<div class="rounded-xl border ' + (isCurrent ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200') + ' p-3 text-center">' +
                '<p class="text-sm font-bold text-slate-800">' + def.label + '</p>' +
                '<p class="mt-1.5 text-base font-bold text-emerald-700">' + formatRupiah(def.price) + '</p>' +
                '<p class="mt-1 text-xs text-slate-500">' + def.maxAccounts + ' akun WAG</p>' +
                '<p class="text-xs text-slate-500">' + def.dailyMessageLimit + ' pesan/hari</p>' +
                '<p class="text-xs text-slate-500">' + (def.durationDays ? 'Berlaku ' + def.durationDays + ' hari' : 'Tidak ada masa berlaku') + '</p>' +
                actionHtml +
                '</div>';
        }).join('');
    }

    async function loadPlansInfo() {
        try {
            const response = await fetch('/api/my/plans', { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Gagal memuat info paket');
            plansInfo = data.plans;
            renderPlanCards();
        } catch (error) {
            planCards.innerHTML = '<p class="text-sm text-red-600 sm:col-span-3">' + error.message + '</p>';
        }
    }

    function populateSendFromOptions() {
        const usable = myCache.filter((e) => e.status === 'active');
        const previous = sendFromSession.value;

        sendFromSession.innerHTML = usable.length
            ? usable.map((e) => '<option value="' + e.id + '">' + e.name + '</option>').join('')
            : '<option value="">Belum ada akun aktif</option>';

        if (usable.some((e) => e.id === previous)) {
            sendFromSession.value = previous;
        }

        sendMessageButton.disabled = !usable.length;
    }

    sendMessageForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        if (!sendFromSession.value) {
            showMyAlert('Belum ada akun WAG aktif untuk mengirim pesan', true);
            return;
        }

        sendMessageButton.disabled = true;
        try {
            const response = await fetch('/api/my/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: sendFromSession.value,
                    number: document.getElementById('sendToNumber').value,
                    message: document.getElementById('sendMessageText').value,
                }),
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Gagal mengirim pesan');
            showMyAlert(data.message, false);
            sendMessageForm.reset();
            await refreshMine();
        } catch (error) {
            showMyAlert(error.message, true);
        } finally {
            sendMessageButton.disabled = false;
        }
    });

    function buildEmbedSnippet() {
        const base = publicBaseUrl || location.origin;
        const src = base + '/widget?session=' + encodeURIComponent(embedSession.value);
        return '<iframe\\n  src="' + src + '"\\n  width="280"\\n  height="320"\\n  scrolling="no"\\n  style="border: none; overflow: hidden; display: block; margin: 0 auto;">\\n</iframe>';
    }

    function refreshEmbedCode() {
        if (!embedSession.value) {
            embedCode.value = '';
            embedLocalhostWarning.classList.add('hidden');
            return;
        }
        embedCode.value = buildEmbedSnippet();
        const base = publicBaseUrl || location.origin;
        embedLocalhostWarning.classList.toggle('hidden', !/^https?:\\/\\/(localhost|127\\.0\\.0\\.1)/i.test(base));
    }

    function populateEmbedSessionOptions() {
        const usable = myCache.filter((e) => e.status === 'active');
        const previous = embedSession.value;

        embedSession.innerHTML = usable.length
            ? usable.map((e) => '<option value="' + e.id + '">' + e.name + '</option>').join('')
            : '<option value="">Belum ada akun aktif</option>';

        if (usable.some((e) => e.id === previous)) {
            embedSession.value = previous;
        }

        refreshEmbedCode();
    }

    embedSession.addEventListener('change', refreshEmbedCode);

    copyEmbedButton.addEventListener('click', async () => {
        if (!embedCode.value) return;
        try {
            await navigator.clipboard.writeText(embedCode.value);
            copyEmbedButton.textContent = 'Tersalin!';
        } catch (error) {
            embedCode.select();
            document.execCommand('copy');
            copyEmbedButton.textContent = 'Tersalin!';
        } finally {
            setTimeout(() => { copyEmbedButton.textContent = 'Salin Kode'; }, 1800);
        }
    });

    function showMyAlert(message, isError) {
        myAlert.textContent = message;
        myAlert.className = 'mt-3 rounded-xl px-4 py-3 text-sm font-medium ' + (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
        myAlert.classList.remove('hidden');
        setTimeout(() => myAlert.classList.add('hidden'), 5000);
    }

    function statusLabel(entry) {
        if (entry.status === 'pending_approval') return 'Menunggu persetujuan admin';
        if (entry.status === 'rejected') return 'Ditolak';
        if (entry.connected) return 'Terhubung';
        if (entry.hasQR) return 'Menunggu scan QR';
        return 'Menyiapkan koneksi...';
    }

    function statusTone(entry) {
        if (entry.status === 'pending_approval') return 'bg-amber-50 text-amber-700';
        if (entry.status === 'rejected') return 'bg-red-50 text-red-700';
        if (entry.connected) return 'bg-emerald-50 text-emerald-700';
        return 'bg-amber-50 text-amber-700';
    }

    function renderCard(entry) {
        const qrData = qrCache[entry.id];
        let body;
        if (entry.status === 'active' && entry.connected) {
            body = '<p class="text-center text-xs text-slate-500">Perangkat aktif dan siap dipakai.</p>';
        } else if (entry.status === 'active' && entry.hasQR && qrData) {
            body = '<img src="' + qrData + '" alt="QR" class="w-full max-w-[140px] rounded-lg border border-slate-200 bg-white p-1.5">';
        } else if (entry.status === 'pending_approval') {
            body = '<p class="text-center text-xs text-slate-500">Menunggu admin approve permintaan ini.</p>';
        } else if (entry.status === 'rejected') {
            body = '<p class="text-center text-xs text-red-500">' + (entry.rejectionReason || 'Permintaan ditolak.') + '</p>';
        } else {
            body = '<p class="text-center text-xs text-slate-500">Menyiapkan koneksi...</p>';
        }

        return '<div class="rounded-xl border border-slate-200 bg-white p-4" data-card="' + entry.id + '">' +
            '<div class="flex items-start justify-between gap-2">' +
            '<div class="min-w-0"><p class="truncate text-sm font-semibold text-slate-800">' + entry.name + '</p>' +
            '<p class="mt-0.5 text-[11px] text-slate-400">' + entry.requestedPhone + '</p></div>' +
            '<span class="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ' + statusTone(entry) + '">' + statusLabel(entry) + '</span>' +
            '</div>' +
            '<div class="mt-3 flex min-h-[150px] items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3">' + body + '</div>' +
            '<div class="mt-3">' +
            '<button type="button" data-delete="' + entry.id + '" class="inline-flex h-8 items-center justify-center rounded-lg bg-red-50 px-3 text-[11px] font-semibold text-red-600 hover:bg-red-100 transition">Hapus</button>' +
            '</div>' +
            '</div>';
    }

    async function refreshMine() {
        try {
            const response = await fetch('/api/my/sessions', { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Gagal memuat akun');

            myCache = data.entries;
            const activeCount = myCache.filter((e) => e.status !== 'rejected').length;
            const expiryText = data.planExpiresAt
                ? ' (aktif s.d. ' + new Date(data.planExpiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) + ')'
                : '';
            quotaInfo.textContent = 'Kuota: ' + activeCount + '/' + data.maxAccounts + ' akun · Paket ' + data.planLabel + expiryText;
            requestWagButton.disabled = activeCount >= data.maxAccounts;
            requestWagButton.classList.toggle('opacity-50', requestWagButton.disabled);
            requestWagButton.classList.toggle('cursor-not-allowed', requestWagButton.disabled);

            myPlanInfo = {
                plan: data.plan,
                dailyMessageLimit: data.dailyMessageLimit,
                messagesToday: data.messagesToday,
                pendingPlanRequest: data.pendingPlanRequest,
                planExpiresAt: data.planExpiresAt,
            };
            sendQuotaInfo.textContent = 'Sisa hari ini: ' + Math.max(0, data.dailyMessageLimit - data.messagesToday) + '/' + data.dailyMessageLimit;
            renderPlanCards();
            populateSendFromOptions();

            await Promise.all(myCache.map(async (entry) => {
                if (entry.status === 'active' && entry.hasQR && !entry.connected) {
                    try {
                        const qrResponse = await fetch('/api/my/sessions/' + entry.id + '/qr', { cache: 'no-store' });
                        const qrJson = await qrResponse.json();
                        if (qrJson.success) qrCache[entry.id] = qrJson.qrCodeData;
                    } catch (err) { /* coba lagi di refresh berikutnya */ }
                } else {
                    delete qrCache[entry.id];
                }
            }));

            myGrid.innerHTML = myCache.map(renderCard).join('') || '<p class="text-sm text-slate-400">Belum ada akun WAG. Klik tombol di atas untuk request akun pertama.</p>';
            populateEmbedSessionOptions();
            renderDocsExamples();
        } catch (error) {
            myGrid.innerHTML = '<p class="text-sm text-red-600">' + error.message + '</p>';
        }
    }

    requestWagButton.addEventListener('click', async () => {
        const name = window.prompt('Nama akun WAG ini (opsional, mis. Toko Saya):', 'WAG Saya');
        if (name === null) return;

        requestWagButton.disabled = true;
        try {
            const response = await fetch('/api/my/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Gagal membuat permintaan');
            showMyAlert(data.message, false);
            await refreshMine();
        } catch (error) {
            showMyAlert(error.message, true);
        } finally {
            requestWagButton.disabled = false;
        }
    });

    myGrid.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-delete]');
        if (!button) return;
        if (!window.confirm('Hapus akun WAG ini?')) return;

        button.disabled = true;
        try {
            const response = await fetch('/api/my/sessions/' + button.dataset.delete, { method: 'DELETE' });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Gagal menghapus');
            showMyAlert(data.message, false);
            await refreshMine();
        } catch (error) {
            showMyAlert(error.message, true);
            button.disabled = false;
        }
    });

    async function logoutUser() {
        try { await fetch('/api/auth/logout', { method: 'POST' }); } finally { window.location.href = '/app/login'; }
    }
    document.getElementById('userLogoutButton').addEventListener('click', logoutUser);
    document.getElementById('userLogoutButtonMobile').addEventListener('click', logoutUser);

    // --- Sidebar tab navigation (pola sama seperti dashboard admin) ---
    const pageTabs = document.querySelectorAll('.page-tab');
    const pagePanels = document.querySelectorAll('.page-panel');
    const pageTitle = document.getElementById('pageTitle');
    const PAGE_TITLES = {
        dashboard: 'Akun WAG',
        send: 'Kirim Pesan',
        plans: 'Paket Langganan',
        embed: 'Embed Widget QR',
        docs: 'Dokumentasi API',
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
    }

    pageTabs.forEach((tab) => {
        tab.addEventListener('click', () => activatePage(tab.dataset.pageTab));
    });

    activatePage('dashboard');

    // --- Tab Dokumentasi API ---
    const docsSessionTableBody = document.getElementById('docsSessionTableBody');
    const curlStatusEl = document.getElementById('curlStatus');
    const curlQrEl = document.getElementById('curlQr');

    function renderDocsExamples() {
        const base = publicBaseUrl || location.origin;
        const active = myCache.filter((e) => e.status === 'active');
        const exampleId = active.length ? active[0].id : 'SESSION_ID';

        curlStatusEl.textContent = 'curl "' + base + '/api/status?session=' + exampleId + '"';
        curlQrEl.textContent = 'curl "' + base + '/api/qr?session=' + exampleId + '"';

        docsSessionTableBody.innerHTML = active.length
            ? active.map((e) => '<tr><td class="px-4 py-2 font-medium text-slate-700">' + e.name + '</td><td class="px-4 py-2 font-mono text-xs text-slate-600">' + e.id + '</td></tr>').join('')
            : '<tr><td class="px-4 py-3 text-slate-400" colspan="2">Belum ada akun WAG aktif.</td></tr>';
    }

    document.querySelectorAll('.doc-copy-btn').forEach((button) => {
        button.addEventListener('click', async () => {
            const target = document.getElementById(button.dataset.copyTarget);
            if (!target) return;
            try {
                await navigator.clipboard.writeText(target.textContent);
                button.textContent = 'Tersalin!';
            } catch (error) {
                // abaikan kalau clipboard API tidak tersedia
            } finally {
                setTimeout(() => { button.textContent = 'Salin'; }, 1800);
            }
        });
    });

    refreshMine();
    loadPlansInfo();
    setInterval(refreshMine, pollIntervalMs);
</script>
</body>
</html>`;
}

function renderUpgradePlanPage(user, planKey) {
  return `<!doctype html>
<html lang="id" class="h-full">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Upgrade Paket — ${escapeHtml(APP_NAME)}</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-full bg-slate-100 text-slate-800">
    <header class="flex items-center gap-2.5 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <a href="/app" class="flex items-center gap-2.5">
            ${renderBrandMark()}
            <div>
                <p class="text-sm font-bold text-slate-900">${escapeHtml(APP_NAME)}</p>
                <p class="text-xs text-slate-400">Upgrade Paket</p>
            </div>
        </a>
    </header>

    <main class="mx-auto max-w-lg p-4 sm:p-6">
        <a href="/app" class="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700">&larr; Kembali ke Portal</a>

        <div class="mt-4 rounded-2xl border border-emerald-200 bg-white p-5 text-center shadow-sm">
            <p class="text-xs font-semibold uppercase tracking-wide text-emerald-600">Paket Dipilih</p>
            <p id="planName" class="mt-1 text-2xl font-bold text-slate-900">Memuat...</p>
            <p id="planPrice" class="mt-1 text-lg font-bold text-emerald-700"></p>
            <div id="planBenefits" class="mt-3 space-y-1 text-sm text-slate-600"></div>
        </div>

        <div id="statusBox" class="mt-4 hidden rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-700"></div>

        <div class="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
            <h2 class="text-sm font-semibold text-slate-800">Cara Upgrade</h2>
            <ol class="mt-3 space-y-3 text-sm text-slate-600">
                <li class="flex gap-2.5">
                    <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">1</span>
                    <span>Klik tombol <strong>"Chat Admin di WhatsApp"</strong> di bawah — pesan permintaan upgrade otomatis sudah terisi, kamu tinggal cek &amp; kirim.</span>
                </li>
                <li class="flex gap-2.5">
                    <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">2</span>
                    <span>Admin akan membalas chat itu dengan info rekening/pembayaran.</span>
                </li>
                <li class="flex gap-2.5">
                    <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">3</span>
                    <span>Setelah transfer, <strong>kirim bukti pembayaran (screenshot)</strong> ke chat WhatsApp yang sama supaya admin bisa verifikasi.</span>
                </li>
                <li class="flex gap-2.5">
                    <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">4</span>
                    <span>Admin akan aktifkan paket kamu di sistem setelah bukti pembayaran diverifikasi. Kamu bakal dapat notifikasi WhatsApp begitu paketnya aktif.</span>
                </li>
            </ol>

            <div id="upgradeAlert" class="mt-4 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

            <button id="chatAdminButton" type="button" class="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.15 2 11.27c0 2.62 1.18 5 3.11 6.7-.1 1.02-.4 2.6-1.11 3.94 1.6-.14 3.34-.7 4.55-1.42 1.09.32 2.26.5 3.45.5 5.52 0 10-4.15 10-9.27C22 6.15 17.52 2 12 2z"/></svg>
                Chat Admin di WhatsApp
            </button>
            <p class="mt-2 text-center text-[11px] text-slate-400">Permintaan kamu otomatis tercatat di sistem begitu tombol ini diklik.</p>
        </div>
    </main>

<script>
    const planKey = ${JSON.stringify(planKey)};
    const currentUser = ${JSON.stringify({ username: user.username, phone: user.phone })};
    const planName = document.getElementById('planName');
    const planPrice = document.getElementById('planPrice');
    const planBenefits = document.getElementById('planBenefits');
    const statusBox = document.getElementById('statusBox');
    const upgradeAlert = document.getElementById('upgradeAlert');
    const chatAdminButton = document.getElementById('chatAdminButton');
    let planDef = null;
    let adminWaNumber = '';

    function formatRupiah(value) {
        return value > 0 ? 'Rp' + Number(value).toLocaleString('id-ID') + '/bulan' : 'Gratis';
    }

    function showUpgradeAlert(message, isError) {
        upgradeAlert.textContent = message;
        upgradeAlert.className = 'mt-4 rounded-xl px-4 py-3 text-sm font-medium ' + (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
        upgradeAlert.classList.remove('hidden');
    }

    function showStatusBox(message) {
        statusBox.textContent = message;
        statusBox.classList.remove('hidden');
    }

    async function init() {
        try {
            const [plansRes, sessionsRes] = await Promise.all([
                fetch('/api/my/plans', { cache: 'no-store' }),
                fetch('/api/my/sessions', { cache: 'no-store' }),
            ]);
            const plansData = await plansRes.json();
            const sessionsData = await sessionsRes.json();
            if (!plansRes.ok || !plansData.success) throw new Error(plansData.message || 'Gagal memuat info paket');
            if (!sessionsRes.ok || !sessionsData.success) throw new Error(sessionsData.message || 'Gagal memuat info akun');

            planDef = plansData.plans[planKey];
            adminWaNumber = plansData.adminWaNumber || '';

            if (!planDef) {
                planName.textContent = 'Paket tidak ditemukan';
                chatAdminButton.disabled = true;
                return;
            }

            planName.textContent = planDef.label;
            planPrice.textContent = formatRupiah(planDef.price);
            planBenefits.innerHTML =
                '<p>' + planDef.maxAccounts + ' akun WAG</p>' +
                '<p>' + planDef.dailyMessageLimit + ' pesan/hari</p>' +
                '<p>' + (planDef.durationDays ? 'Berlaku ' + planDef.durationDays + ' hari' : 'Tidak ada masa berlaku') + '</p>';

            if (sessionsData.plan === planKey) {
                showStatusBox('Paket ini sudah aktif buat akun kamu.');
                chatAdminButton.disabled = true;
            } else if (sessionsData.pendingPlanRequest === planKey) {
                showStatusBox('Kamu sudah pernah request paket ini dan masih menunggu konfirmasi admin. Boleh tetap chat ulang kalau perlu.');
            }
        } catch (error) {
            planName.textContent = 'Gagal memuat';
            showUpgradeAlert(error.message, true);
        }
    }

    chatAdminButton.addEventListener('click', async () => {
        if (!planDef) return;

        chatAdminButton.disabled = true;
        try {
            const response = await fetch('/api/my/upgrade-request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan: planKey }),
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Gagal mengirim permintaan');

            if (adminWaNumber) {
                const durationText = planDef.durationDays ? 'Berlaku ' + planDef.durationDays + ' hari' : 'Tidak ada masa berlaku';
                const chatText = 'Halo Admin, saya mau upgrade paket WA Gateway.\\n' +
                    'Username: ' + currentUser.username + '\\n' +
                    'No HP: ' + currentUser.phone + '\\n' +
                    'Paket dituju: ' + planDef.label + ' (' + formatRupiah(planDef.price) + ', ' + durationText + ')\\n' +
                    'Mohon info rekening untuk pembayaran. Terima kasih.';
                window.open('https://wa.me/' + adminWaNumber + '?text=' + encodeURIComponent(chatText), '_blank');
                showUpgradeAlert('Permintaan tercatat. Chat WhatsApp sudah dibuka di tab baru — jangan lupa kirim bukti pembayaran setelah transfer ya.', false);
            } else {
                showUpgradeAlert(data.message + ' (Admin belum mengatur nomor WA kontak, tunggu konfirmasi manual.)', false);
            }
        } catch (error) {
            showUpgradeAlert(error.message, true);
        } finally {
            chatAdminButton.disabled = false;
        }
    });

    init();
</script>
</body>
</html>`;
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
                <div class="my-2 border-t border-slate-100"></div>
                <button type="button" data-page-tab="requests" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                    Persetujuan
                    <span id="pendingRequestsBadge" class="ml-auto hidden rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white"></span>
                </button>
                <button type="button" data-page-tab="users" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                    Pengguna
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
                <button id="adminLogoutButton" type="button" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs font-medium text-red-500 transition hover:bg-red-50">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>
                    Keluar
                </button>
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
                    <div class="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 class="text-sm font-semibold text-slate-800">Akun WhatsApp</h2>
                            <p id="accountsCount" class="text-xs text-slate-400">Memuat akun...</p>
                        </div>
                        <button id="addAccountButton" type="button" class="inline-flex h-9 items-center justify-center rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white hover:bg-emerald-700 transition">+ Tambah Akun</button>
                    </div>

                    <div id="accountsAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

                    <div id="accountsGrid" class="mt-4 grid gap-4 sm:grid-cols-2">
                        <p class="text-sm text-slate-400">Memuat akun...</p>
                    </div>

                    <p class="mt-4 text-xs leading-relaxed text-slate-400">Tombol <strong>Ganti Akun</strong> akan logout perangkat tertaut, menghapus sesi lama, lalu menyiapkan QR baru untuk akun tersebut. Tombol <strong>Hapus</strong> menghapus akun sepenuhnya dari daftar (minimal harus ada 1 akun aktif). Batas jumlah akun bisa diubah di tab Pengaturan.</p>

                    <section class="mt-5 rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Embed Widget QR</h2>
                        <p class="mt-1 text-xs text-slate-500">Tempel kode ini di website lain untuk menampilkan status &amp; QR scan WhatsApp. Pilih akun yang ingin ditampilkan &mdash; tiap akun punya kode embed sendiri.</p>
                        <select id="embedSession" class="session-select mt-3 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm"></select>
                        <textarea id="embedCode" rows="3" readonly class="mt-3 w-full resize-none rounded-lg border border-slate-200 bg-slate-50 p-2.5 font-mono text-xs text-slate-600"></textarea>
                        <button id="copyEmbedButton" type="button" class="mt-2 inline-flex h-8 items-center justify-center rounded-lg bg-slate-100 px-3.5 text-xs font-semibold text-slate-700 hover:bg-slate-200 transition">Salin Kode</button>
                        <p id="embedLocalhostWarning" class="mt-2 hidden rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">Alamat di atas memakai <code>localhost</code>, jadi hanya bisa dibuka dari komputer ini. Kalau widget ini mau ditempel di website lain, isi <strong>URL Publik</strong> di tab Pengaturan dengan domain publik gateway ini.</p>
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
                        <label for="sendSession" class="block text-sm font-semibold text-slate-700">Kirim Dari Akun</label>
                        <select id="sendSession" name="session" class="session-select mt-2 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm">
                            <option value="">Memuat akun...</option>
                        </select>

                        <label for="number" class="mt-4 block text-sm font-semibold text-slate-700">Nomor Tujuan</label>
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
                        <label for="broadcastSession" class="block text-sm font-semibold text-slate-700">Kirim Dari Akun</label>
                        <select id="broadcastSession" name="session" class="session-select mt-2 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm">
                            <option value="">Memuat akun...</option>
                        </select>

                        <label for="broadcastNumbers" class="mt-4 block text-sm font-semibold text-slate-700">Daftar Nomor Tujuan</label>
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
                            <label for="scheduleSession" class="block text-sm font-semibold text-slate-700">Kirim Dari Akun</label>
                            <select id="scheduleSession" name="session" class="session-select mt-2 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm">
                                <option value="">Memuat akun...</option>
                            </select>

                            <div class="mt-4 grid gap-4 sm:grid-cols-2">
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

                <section id="page-requests" class="page-panel mx-auto max-w-4xl hidden">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Notifikasi WhatsApp &amp; Harga Paket</h2>
                        <p class="mt-1 text-xs text-slate-500">Nomor WA admin di bawah ini dipakai untuk 2 hal: (1) tujuan notifikasi otomatis dari sistem, dan (2) tujuan chat WhatsApp yang otomatis dibuka user saat mereka klik upgrade paket. Tersimpan langsung, tidak perlu restart server.</p>
                        <div id="notifyConfigAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>
                        <div class="mt-3 grid gap-3 sm:grid-cols-2">
                            <div>
                                <label for="notifierSessionSelect" class="text-xs font-semibold text-slate-700">Akun Pengirim Notifikasi</label>
                                <select id="notifierSessionSelect" class="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                                    <option value="">Belum dipilih</option>
                                </select>
                            </div>
                            <div>
                                <label for="adminNotifyPhoneInput" class="text-xs font-semibold text-slate-700">Nomor WA Admin</label>
                                <input id="adminNotifyPhoneInput" type="text" placeholder="mis. 628123456789"
                                    class="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            </div>
                            <div>
                                <label for="planProPriceInput" class="text-xs font-semibold text-slate-700">Harga Paket Pro (Rp/bulan)</label>
                                <input id="planProPriceInput" type="number" min="0" step="1000" placeholder="mis. 50000"
                                    class="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            </div>
                            <div>
                                <label for="planMaxPriceInput" class="text-xs font-semibold text-slate-700">Harga Paket Max (Rp/bulan)</label>
                                <input id="planMaxPriceInput" type="number" min="0" step="1000" placeholder="mis. 150000"
                                    class="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            </div>
                        </div>
                        <button id="saveNotifyConfigButton" type="button" class="mt-3 inline-flex h-9 items-center justify-center rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white hover:bg-emerald-700 transition">Simpan</button>
                    </div>

                    <div class="mt-5 rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Metode Pembayaran &amp; Auto-Reply</h2>
                        <p class="mt-1 text-xs text-slate-500">Begitu ada chat masuk ke "Akun Pengirim Notifikasi" di atas yang menyebut "upgrade paket" (cocok dengan pesan otomatis dari halaman upgrade user), bot akan otomatis balas menu metode pembayaran, lalu kirim detail sesuai pilihan user (DANA/QRIS/Mandiri). Tidak membalas chat lain yang tidak terkait.</p>
                        <div id="paymentConfigAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>
                        <div class="mt-3 grid gap-3 sm:grid-cols-2">
                            <div>
                                <label for="danaNumberInput" class="text-xs font-semibold text-slate-700">Nomor DANA</label>
                                <input id="danaNumberInput" type="text" placeholder="mis. 081234567890"
                                    class="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            </div>
                            <div>
                                <label for="danaNameInput" class="text-xs font-semibold text-slate-700">Nama Pemilik DANA</label>
                                <input id="danaNameInput" type="text" placeholder="mis. Rafly Ano"
                                    class="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            </div>
                            <div>
                                <label for="mandiriNumberInput" class="text-xs font-semibold text-slate-700">Nomor Rekening Mandiri</label>
                                <input id="mandiriNumberInput" type="text" placeholder="mis. 1234567890123"
                                    class="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            </div>
                            <div>
                                <label for="mandiriNameInput" class="text-xs font-semibold text-slate-700">Nama Pemilik Rekening Mandiri</label>
                                <input id="mandiriNameInput" type="text" placeholder="mis. Rafly Ano"
                                    class="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            </div>
                        </div>
                        <div class="mt-3">
                            <label class="text-xs font-semibold text-slate-700">Gambar QRIS</label>
                            <p class="mt-1 text-[11px] text-slate-400">Belum punya QRIS? Bisa dibuat gratis lewat aplikasi DANA/OVO/GoPay (menu "QRIS Bisnis"/"Terima Uang"), atau lewat mobile banking Mandiri (Livin' Merchant). Setelah dapat gambar QRIS-nya, unggah di sini.</p>
                            <div class="mt-2 flex flex-wrap items-center gap-3">
                                <img id="qrisPreview" src="" alt="QRIS" class="hidden h-24 w-24 rounded-lg border border-slate-200 object-contain bg-white p-1">
                                <input id="qrisImageInput" type="file" accept="image/*" class="text-xs">
                                <button id="deleteQrisButton" type="button" class="hidden inline-flex h-8 items-center justify-center rounded-lg bg-red-50 px-3 text-[11px] font-semibold text-red-600 hover:bg-red-100 transition">Hapus QRIS</button>
                            </div>
                        </div>
                        <button id="savePaymentConfigButton" type="button" class="mt-3 inline-flex h-9 items-center justify-center rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white hover:bg-emerald-700 transition">Simpan</button>
                    </div>

                    <div class="mt-5 rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Permintaan Akun WAG Menunggu Persetujuan</h2>
                        <p class="mt-1 text-xs text-slate-500">Akun baru dari user tidak akan aktif (tidak ada QR) sampai kamu approve di sini.</p>
                        <div id="requestsAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>
                        <div class="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                            <table class="w-full text-sm">
                                <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        <th class="px-4 py-2 text-left">User</th>
                                        <th class="px-4 py-2 text-left">Nomor HP</th>
                                        <th class="px-4 py-2 text-left">Diminta</th>
                                        <th class="px-4 py-2 text-left"></th>
                                    </tr>
                                </thead>
                                <tbody id="requestsTableBody" class="divide-y divide-slate-200">
                                    <tr><td class="px-4 py-3 text-slate-400" colspan="4">Memuat...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>

                <section id="page-users" class="page-panel mx-auto max-w-4xl hidden">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Pengguna Terdaftar</h2>
                        <p class="mt-1 text-xs text-slate-500">Paket Free = 1 akun WAG &amp; 10 pesan/hari, tanpa masa berlaku. Paket Pro/Max berlaku 30 hari sejak dipilih di sini, lalu otomatis turun ke Free kalau tidak diperpanjang. Ganti paket di sini kalau user sudah konfirmasi bayar (manual, tidak ada payment gateway). Badge kuning menandakan user sudah minta upgrade sendiri lewat portalnya.</p>
                        <div id="usersAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>
                        <div class="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                            <table class="w-full text-sm">
                                <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        <th class="px-4 py-2 text-left">Username</th>
                                        <th class="px-4 py-2 text-left">Nomor HP</th>
                                        <th class="px-4 py-2 text-left">Akun WAG</th>
                                        <th class="px-4 py-2 text-left">Pesan Hari Ini</th>
                                        <th class="px-4 py-2 text-left">Paket</th>
                                        <th class="px-4 py-2 text-left">Kadaluarsa</th>
                                        <th class="px-4 py-2 text-left"></th>
                                    </tr>
                                </thead>
                                <tbody id="usersTableBody" class="divide-y divide-slate-200">
                                    <tr><td class="px-4 py-3 text-slate-400" colspan="7">Memuat...</td></tr>
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

                    <div id="adminsPanel" class="mt-5 hidden rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Kelola Admin Dashboard</h2>
                        <p class="mt-1 text-xs text-slate-500">Daftar akun admin yang bisa mengelola gateway ini.</p>

                        <div id="adminsAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

                        <div class="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                            <table class="w-full text-sm">
                                <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        <th class="px-4 py-2 text-left">Username</th>
                                        <th class="px-4 py-2 text-left">Dibuat</th>
                                        <th class="px-4 py-2 text-left"></th>
                                    </tr>
                                </thead>
                                <tbody id="adminsTableBody" class="divide-y divide-slate-200">
                                    <tr><td class="px-4 py-3 text-slate-400" colspan="3">Memuat...</td></tr>
                                </tbody>
                            </table>
                        </div>

                        <form id="addAdminForm" class="mt-4 flex flex-wrap items-end gap-2.5">
                            <div>
                                <label for="newAdminUsername" class="text-xs font-semibold text-slate-700">Username</label>
                                <input id="newAdminUsername" type="text" required minlength="3" placeholder="mis. budi"
                                    class="mt-1.5 w-40 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            </div>
                            <div>
                                <label for="newAdminPassword" class="text-xs font-semibold text-slate-700">Password</label>
                                <input id="newAdminPassword" type="password" required minlength="6" placeholder="Minimal 6 karakter"
                                    class="mt-1.5 w-48 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            </div>
                            <button id="addAdminButton" type="submit" class="inline-flex h-9 items-center justify-center rounded-lg bg-emerald-600 px-4 text-xs font-semibold text-white hover:bg-emerald-700 transition">+ Tambah Admin</button>
                        </form>
                    </div>
                </section>
            </main>
        </div>
    </div>

    <script>
        const pollIntervalMs = ${STATUS_POLL_INTERVAL_MS};
        const publicBaseUrl = ${JSON.stringify(PUBLIC_BASE_URL)};
        const statusBadge = document.getElementById('statusBadge');
        const accountsGrid = document.getElementById('accountsGrid');
        const accountsCount = document.getElementById('accountsCount');
        const accountsAlert = document.getElementById('accountsAlert');
        const addAccountButton = document.getElementById('addAccountButton');

        let sessionsCache = [];
        let maxAccountsCache = 1;
        const qrCache = {};

        const BADGE_TONE = {
            waiting: 'bg-amber-50 text-amber-700',
            connected: 'bg-emerald-50 text-emerald-700',
            disconnected: 'bg-red-50 text-red-700',
        };

        function setBadge(label, mode) {
            statusBadge.textContent = label;
            statusBadge.className = 'inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold ' + (BADGE_TONE[mode] || BADGE_TONE.waiting);
        }

        function showAccountsAlert(message, isError) {
            accountsAlert.textContent = message;
            accountsAlert.className = 'mt-3 rounded-xl px-4 py-3 text-sm font-medium ' +
                (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
            accountsAlert.classList.remove('hidden');
            setTimeout(() => accountsAlert.classList.add('hidden'), 5000);
        }

        function accountStatusLabel(entry) {
            if (entry.logoutInProgress) return 'Sedang logout...';
            if (entry.connected) return 'Terhubung';
            if (entry.hasQR) return 'Menunggu scan QR';
            if (entry.lastDisconnectReason === 401) return 'Perlu scan ulang';
            return 'Menyambungkan...';
        }

        function accountStatusTone(entry) {
            if (entry.connected) return 'connected';
            if (entry.logoutInProgress || (!entry.hasQR && entry.lastDisconnectReason !== 401)) return 'waiting';
            if (entry.lastDisconnectReason === 401) return 'disconnected';
            return 'waiting';
        }

        function renderAccountCard(entry) {
            const tone = accountStatusTone(entry);
            const toneClass = BADGE_TONE[tone] || BADGE_TONE.waiting;
            const label = accountStatusLabel(entry);
            const qrData = qrCache[entry.id];

            return '<div class="rounded-xl border border-slate-200 bg-white p-4" data-card="' + entry.id + '">' +
                '<div class="flex items-start justify-between gap-2">' +
                '<div class="min-w-0">' +
                '<p class="truncate text-sm font-semibold text-slate-800">' + entry.name + '</p>' +
                '<p class="mt-0.5 text-[11px] text-slate-400">' + entry.queueDepth + ' antrean &middot; ' + entry.activeSendCount + ' aktif</p>' +
                '</div>' +
                '<span class="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ' + toneClass + '">' + label + '</span>' +
                '</div>' +
                '<div class="mt-3 flex min-h-[150px] items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3">' +
                (entry.connected
                    ? '<p class="text-center text-xs text-slate-500">Perangkat aktif dan siap dipakai.</p>'
                    : entry.hasQR && qrData
                        ? '<img src="' + qrData + '" alt="QR" class="w-full max-w-[140px] rounded-lg border border-slate-200 bg-white p-1.5">'
                        : '<p class="text-center text-xs text-slate-500">' + (entry.hasQR ? 'Memuat QR...' : 'Menyiapkan koneksi...') + '</p>') +
                '</div>' +
                '<div class="mt-3 flex flex-wrap gap-1.5">' +
                '<button type="button" data-action="test" data-id="' + entry.id + '" class="inline-flex h-8 items-center justify-center rounded-lg bg-slate-100 px-3 text-[11px] font-semibold text-slate-700 hover:bg-slate-200 transition">Test Chat</button>' +
                '<button type="button" data-action="rotate" data-id="' + entry.id + '" class="inline-flex h-8 items-center justify-center rounded-lg bg-amber-50 px-3 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 transition">Ganti Akun</button>' +
                '<button type="button" data-action="delete" data-id="' + entry.id + '" class="inline-flex h-8 items-center justify-center rounded-lg bg-red-50 px-3 text-[11px] font-semibold text-red-600 hover:bg-red-100 transition">Hapus</button>' +
                '</div>' +
                '</div>';
        }

        function populateSessionSelects() {
            document.querySelectorAll('.session-select').forEach((select) => {
                const previous = select.value;
                select.innerHTML = sessionsCache.map((entry) =>
                    '<option value="' + entry.id + '">' + entry.name + (entry.connected ? '' : ' (belum terhubung)') + '</option>'
                ).join('');
                if (sessionsCache.some((entry) => entry.id === previous)) {
                    select.value = previous;
                }
            });
            refreshEmbedCode();
        }

        async function refreshAccounts() {
            try {
                const response = await fetch('/api/sessions', { cache: 'no-store' });
                const data = await response.json();

                if (!response.ok || !data.success) {
                    throw new Error(data.message || 'Gagal memuat akun');
                }

                sessionsCache = data.entries;
                maxAccountsCache = data.maxAccounts;

                const connectedCount = sessionsCache.filter((entry) => entry.connected).length;
                accountsCount.textContent = sessionsCache.length + '/' + maxAccountsCache + ' akun digunakan, ' + connectedCount + ' terhubung';
                addAccountButton.disabled = sessionsCache.length >= maxAccountsCache;
                addAccountButton.classList.toggle('opacity-50', addAccountButton.disabled);
                addAccountButton.classList.toggle('cursor-not-allowed', addAccountButton.disabled);

                if (connectedCount === sessionsCache.length && sessionsCache.length > 0) {
                    setBadge('Semua akun terhubung dan siap kirim', 'connected');
                } else if (connectedCount > 0) {
                    setBadge(connectedCount + '/' + sessionsCache.length + ' akun terhubung', 'waiting');
                } else {
                    setBadge('Belum ada akun yang terhubung', 'waiting');
                }

                await Promise.all(sessionsCache.map(async (entry) => {
                    if (entry.hasQR && !entry.connected) {
                        try {
                            const qrResponse = await fetch('/api/qr?session=' + entry.id, { cache: 'no-store' });
                            const qrJson = await qrResponse.json();
                            if (qrJson.success) {
                                qrCache[entry.id] = qrJson.qrCodeData;
                            }
                        } catch (err) { /* biarkan, coba lagi di refresh berikutnya */ }
                    } else {
                        delete qrCache[entry.id];
                    }
                }));

                accountsGrid.innerHTML = sessionsCache.map(renderAccountCard).join('') ||
                    '<p class="text-sm text-slate-400">Belum ada akun WhatsApp.</p>';

                populateSessionSelects();
            } catch (error) {
                setBadge('Status gateway belum bisa diambil', 'disconnected');
                accountsGrid.innerHTML = '<p class="text-sm text-red-600">' + error.message + '</p>';
            }
        }

        accountsGrid.addEventListener('click', async (event) => {
            const button = event.target.closest('button[data-action]');
            if (!button) return;

            const id = button.dataset.id;
            const action = button.dataset.action;
            const entry = sessionsCache.find((item) => item.id === id);
            const name = entry ? entry.name : id;

            if (action === 'test') {
                button.disabled = true;
                button.textContent = 'Mengirim...';
                try {
                    const response = await fetch('/api/test-chat?session=' + id, { method: 'POST' });
                    const data = await response.json();
                    if (!response.ok || !data.success) throw new Error(data.message || 'Test chat gagal dikirim');
                    showAccountsAlert('Test chat berhasil dikirim ke ' + data.to, false);
                } catch (error) {
                    showAccountsAlert('Test chat gagal: ' + error.message, true);
                } finally {
                    button.disabled = false;
                    button.textContent = 'Test Chat';
                }
            } else if (action === 'rotate') {
                if (!window.confirm('Logout akun "' + name + '" dan siapkan QR untuk akun baru?')) return;
                button.disabled = true;
                try {
                    const response = await fetch('/api/logout?session=' + id, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                    });
                    const data = await response.json();
                    if (!response.ok || !data.success) throw new Error(data.message || 'Logout akun gagal');
                    showAccountsAlert(data.message, false);
                    delete qrCache[id];
                    await refreshAccounts();
                } catch (error) {
                    showAccountsAlert('Ganti akun gagal: ' + error.message, true);
                } finally {
                    button.disabled = false;
                }
            } else if (action === 'delete') {
                if (!window.confirm('Hapus akun "' + name + '" sepenuhnya dari daftar? Tindakan ini tidak bisa dibatalkan.')) return;
                button.disabled = true;
                try {
                    const response = await fetch('/api/sessions/' + id, { method: 'DELETE' });
                    const data = await response.json();
                    if (!response.ok || !data.success) throw new Error(data.message || 'Gagal menghapus akun');
                    showAccountsAlert(data.message, false);
                    delete qrCache[id];
                    await refreshAccounts();
                } catch (error) {
                    showAccountsAlert('Hapus akun gagal: ' + error.message, true);
                    button.disabled = false;
                }
            }
        });

        addAccountButton.addEventListener('click', async () => {
            if (addAccountButton.disabled) return;

            const name = window.prompt('Nama akun baru (opsional):', 'Akun ' + (sessionsCache.length + 1));
            if (name === null) return;

            addAccountButton.disabled = true;
            try {
                const response = await fetch('/api/sessions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name }),
                });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.message || 'Gagal membuat akun baru');
                showAccountsAlert(data.message, false);
                await refreshAccounts();
            } catch (error) {
                showAccountsAlert(error.message, true);
            } finally {
                addAccountButton.disabled = sessionsCache.length >= maxAccountsCache;
            }
        });

        const embedCode = document.getElementById('embedCode');
        const embedSession = document.getElementById('embedSession');
        const copyEmbedButton = document.getElementById('copyEmbedButton');
        const embedLocalhostWarning = document.getElementById('embedLocalhostWarning');

        function buildEmbedSnippet() {
            const sessionId = embedSession.value || 'default';
            const base = publicBaseUrl || location.origin;
            const src = base + '/widget?session=' + encodeURIComponent(sessionId);
            return '<iframe\\n  src="' + src + '"\\n  width="280"\\n  height="320"\\n  scrolling="no"\\n  style="border: none; overflow: hidden; display: block; margin: 0 auto;">\\n</iframe>';
        }

        function refreshEmbedCode() {
            embedCode.value = buildEmbedSnippet();
            const base = publicBaseUrl || location.origin;
            embedLocalhostWarning.classList.toggle('hidden', !/^https?:\\/\\/(localhost|127\\.0\\.0\\.1)/i.test(base));
        }

        embedSession.addEventListener('change', refreshEmbedCode);

        copyEmbedButton.addEventListener('click', async () => {
            const embedSnippet = buildEmbedSnippet();
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

        refreshAccounts();
        setInterval(refreshAccounts, pollIntervalMs);

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
            requests: 'Persetujuan',
            users: 'Pengguna',
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
                    adminsPanel.classList.remove('hidden');
                    loadAdmins();
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

        // --- Kelola Admin (dalam tab Pengaturan) ---
        const adminsPanel = document.getElementById('adminsPanel');
        const adminsAlert = document.getElementById('adminsAlert');
        const adminsTableBody = document.getElementById('adminsTableBody');
        const addAdminForm = document.getElementById('addAdminForm');
        const newAdminUsername = document.getElementById('newAdminUsername');
        const newAdminPassword = document.getElementById('newAdminPassword');
        let adminsCache = [];

        function showAdminsAlert(message, isError) {
            adminsAlert.textContent = message;
            adminsAlert.className = 'mt-3 rounded-xl px-4 py-3 text-sm font-medium ' +
                (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
            adminsAlert.classList.remove('hidden');
            setTimeout(() => adminsAlert.classList.add('hidden'), 5000);
        }

        function renderAdminsTable() {
            if (!adminsCache.length) {
                adminsTableBody.innerHTML = '<tr><td class="px-4 py-3 text-slate-400" colspan="3">Belum ada admin terdaftar.</td></tr>';
                return;
            }

            adminsTableBody.innerHTML = adminsCache.map((admin) => {
                const created = admin.createdAt ? new Date(admin.createdAt).toLocaleString('id-ID') : '-';
                return '<tr>' +
                    '<td class="px-4 py-2 font-medium text-slate-700">' + admin.username + '</td>' +
                    '<td class="px-4 py-2 text-slate-500">' + created + '</td>' +
                    '<td class="px-4 py-2 text-right">' +
                    '<div class="flex justify-end gap-1.5">' +
                    '<button type="button" data-admin-action="password" data-id="' + admin.id + '" data-username="' + admin.username + '" class="inline-flex h-7 items-center justify-center rounded-lg bg-slate-100 px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-200 transition">Ganti Password</button>' +
                    '<button type="button" data-admin-action="delete" data-id="' + admin.id + '" data-username="' + admin.username + '" class="inline-flex h-7 items-center justify-center rounded-lg bg-red-50 px-2.5 text-[11px] font-semibold text-red-600 hover:bg-red-100 transition">Hapus</button>' +
                    '</div>' +
                    '</td>' +
                    '</tr>';
            }).join('');
        }

        async function loadAdmins() {
            try {
                const response = await apiKeyFetch('/api/admins', 'wa_settings_key', { cache: 'no-store' });
                const data = await response.json();
                if (!response.ok || !data.success) {
                    throw new Error(data.message || 'Gagal memuat daftar admin');
                }
                adminsCache = data.entries;
                renderAdminsTable();
            } catch (error) {
                adminsTableBody.innerHTML = '<tr><td class="px-4 py-3 text-red-600" colspan="3">' + error.message + '</td></tr>';
            }
        }

        addAdminForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const username = newAdminUsername.value.trim();
            const password = newAdminPassword.value;
            const button = document.getElementById('addAdminButton');

            button.disabled = true;
            try {
                const response = await apiKeyFetch('/api/admins', 'wa_settings_key', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password }),
                });
                const data = await response.json();
                if (!response.ok || !data.success) {
                    throw new Error(data.message || 'Gagal membuat admin');
                }
                showAdminsAlert(data.message, false);
                addAdminForm.reset();
                await loadAdmins();
            } catch (error) {
                showAdminsAlert(error.message, true);
            } finally {
                button.disabled = false;
            }
        });

        adminsTableBody.addEventListener('click', async (event) => {
            const button = event.target.closest('button[data-admin-action]');
            if (!button) return;

            const id = button.dataset.id;
            const username = button.dataset.username;
            const action = button.dataset.adminAction;

            if (action === 'delete') {
                if (!window.confirm('Hapus admin "' + username + '"?')) return;
                button.disabled = true;
                try {
                    const response = await apiKeyFetch('/api/admins/' + id, 'wa_settings_key', { method: 'DELETE' });
                    const data = await response.json();
                    if (!response.ok || !data.success) throw new Error(data.message || 'Gagal menghapus admin');
                    showAdminsAlert(data.message, false);
                    await loadAdmins();
                } catch (error) {
                    showAdminsAlert(error.message, true);
                    button.disabled = false;
                }
            } else if (action === 'password') {
                const newPassword = window.prompt('Password baru untuk "' + username + '" (minimal 6 karakter):');
                if (newPassword === null) return;
                if (newPassword.length < 6) {
                    showAdminsAlert('Password minimal 6 karakter', true);
                    return;
                }
                button.disabled = true;
                try {
                    const response = await apiKeyFetch('/api/admins/' + id, 'wa_settings_key', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password: newPassword }),
                    });
                    const data = await response.json();
                    if (!response.ok || !data.success) throw new Error(data.message || 'Gagal mengganti password');
                    showAdminsAlert(data.message, false);
                } catch (error) {
                    showAdminsAlert(error.message, true);
                } finally {
                    button.disabled = false;
                }
            }
        });

        // --- Logout admin ---
        document.getElementById('adminLogoutButton').addEventListener('click', async () => {
            try {
                await fetch('/api/auth/admin/logout', { method: 'POST' });
            } finally {
                window.location.href = '/login';
            }
        });

        // --- Tab Persetujuan (permintaan akun WAG dari user) ---
        const requestsAlert = document.getElementById('requestsAlert');
        const requestsTableBody = document.getElementById('requestsTableBody');
        const pendingRequestsBadge = document.getElementById('pendingRequestsBadge');
        const notifierSessionSelect = document.getElementById('notifierSessionSelect');
        const adminNotifyPhoneInput = document.getElementById('adminNotifyPhoneInput');
        const planProPriceInput = document.getElementById('planProPriceInput');
        const planMaxPriceInput = document.getElementById('planMaxPriceInput');
        const notifyConfigAlert = document.getElementById('notifyConfigAlert');
        const saveNotifyConfigButton = document.getElementById('saveNotifyConfigButton');
        const danaNumberInput = document.getElementById('danaNumberInput');
        const danaNameInput = document.getElementById('danaNameInput');
        const mandiriNumberInput = document.getElementById('mandiriNumberInput');
        const mandiriNameInput = document.getElementById('mandiriNameInput');
        const qrisImageInput = document.getElementById('qrisImageInput');
        const qrisPreview = document.getElementById('qrisPreview');
        const deleteQrisButton = document.getElementById('deleteQrisButton');
        const savePaymentConfigButton = document.getElementById('savePaymentConfigButton');
        const paymentConfigAlert = document.getElementById('paymentConfigAlert');

        function showRequestsAlert(message, isError) {
            requestsAlert.textContent = message;
            requestsAlert.className = 'mt-3 rounded-xl px-4 py-3 text-sm font-medium ' +
                (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
            requestsAlert.classList.remove('hidden');
            setTimeout(() => requestsAlert.classList.add('hidden'), 5000);
        }

        async function loadRequests() {
            try {
                const response = await fetch('/api/admin/requests', { cache: 'no-store' });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.message || 'Gagal memuat permintaan');

                const entries = data.entries;
                pendingRequestsBadge.textContent = String(entries.length);
                pendingRequestsBadge.classList.toggle('hidden', entries.length === 0);

                if (!entries.length) {
                    requestsTableBody.innerHTML = '<tr><td class="px-4 py-3 text-slate-400" colspan="4">Tidak ada permintaan menunggu.</td></tr>';
                    return;
                }

                requestsTableBody.innerHTML = entries.map((req) => {
                    const created = req.createdAt ? new Date(req.createdAt).toLocaleString('id-ID') : '-';
                    return '<tr>' +
                        '<td class="px-4 py-2 font-medium text-slate-700">' + req.ownerUsername + '</td>' +
                        '<td class="px-4 py-2 text-slate-600">' + req.requestedPhone + '</td>' +
                        '<td class="px-4 py-2 text-slate-500">' + created + '</td>' +
                        '<td class="px-4 py-2 text-right">' +
                        '<div class="flex justify-end gap-1.5">' +
                        '<button type="button" data-request-action="approve" data-id="' + req.id + '" class="inline-flex h-7 items-center justify-center rounded-lg bg-emerald-50 px-2.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 transition">Approve</button>' +
                        '<button type="button" data-request-action="reject" data-id="' + req.id + '" class="inline-flex h-7 items-center justify-center rounded-lg bg-red-50 px-2.5 text-[11px] font-semibold text-red-600 hover:bg-red-100 transition">Tolak</button>' +
                        '</div>' +
                        '</td>' +
                        '</tr>';
                }).join('');
            } catch (error) {
                requestsTableBody.innerHTML = '<tr><td class="px-4 py-3 text-red-600" colspan="4">' + error.message + '</td></tr>';
            }
        }

        requestsTableBody.addEventListener('click', async (event) => {
            const button = event.target.closest('button[data-request-action]');
            if (!button) return;

            const id = button.dataset.id;
            const action = button.dataset.requestAction;

            if (action === 'approve') {
                button.disabled = true;
                try {
                    const response = await fetch('/api/admin/requests/' + id + '/approve', { method: 'POST' });
                    const data = await response.json();
                    if (!response.ok || !data.success) throw new Error(data.message || 'Gagal approve permintaan');
                    showRequestsAlert(data.message, false);
                    await loadRequests();
                } catch (error) {
                    showRequestsAlert(error.message, true);
                    button.disabled = false;
                }
            } else if (action === 'reject') {
                const reason = window.prompt('Alasan penolakan (opsional):') || '';
                button.disabled = true;
                try {
                    const response = await fetch('/api/admin/requests/' + id + '/reject', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reason }),
                    });
                    const data = await response.json();
                    if (!response.ok || !data.success) throw new Error(data.message || 'Gagal menolak permintaan');
                    showRequestsAlert(data.message, false);
                    await loadRequests();
                } catch (error) {
                    showRequestsAlert(error.message, true);
                    button.disabled = false;
                }
            }
        });

        async function loadNotifyConfig() {
            try {
                const response = await fetch('/api/admin/config', { cache: 'no-store' });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.message || 'Gagal memuat konfigurasi');

                notifierSessionSelect.innerHTML = '<option value="">Belum dipilih</option>' +
                    data.connectedSessions.map((s) => '<option value="' + s.id + '">' + s.name + '</option>').join('');
                notifierSessionSelect.value = data.config.notifierSessionId || '';
                adminNotifyPhoneInput.value = data.config.adminNotifyPhone || '';
                planProPriceInput.value = data.plans.pro.price || '';
                planMaxPriceInput.value = data.plans.max.price || '';
            } catch (error) {
                showRequestsAlert(error.message, true);
            }
        }

        saveNotifyConfigButton.addEventListener('click', async () => {
            saveNotifyConfigButton.disabled = true;
            try {
                const response = await fetch('/api/admin/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        notifierSessionId: notifierSessionSelect.value,
                        adminNotifyPhone: adminNotifyPhoneInput.value.trim(),
                        planProPrice: planProPriceInput.value,
                        planMaxPrice: planMaxPriceInput.value,
                    }),
                });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.message || 'Gagal menyimpan konfigurasi');
                notifyConfigAlert.textContent = data.message;
                notifyConfigAlert.className = 'mt-3 rounded-xl px-4 py-3 text-sm font-medium bg-emerald-50 text-emerald-700';
                notifyConfigAlert.classList.remove('hidden');
                setTimeout(() => notifyConfigAlert.classList.add('hidden'), 4000);
            } catch (error) {
                notifyConfigAlert.textContent = error.message;
                notifyConfigAlert.className = 'mt-3 rounded-xl px-4 py-3 text-sm font-medium bg-red-50 text-red-700';
                notifyConfigAlert.classList.remove('hidden');
            } finally {
                saveNotifyConfigButton.disabled = false;
            }
        });

        function showPaymentConfigAlert(message, isError) {
            paymentConfigAlert.textContent = message;
            paymentConfigAlert.className = 'mt-3 rounded-xl px-4 py-3 text-sm font-medium ' +
                (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
            paymentConfigAlert.classList.remove('hidden');
            setTimeout(() => paymentConfigAlert.classList.add('hidden'), 4000);
        }

        function renderQrisPreview(qrisImage) {
            if (qrisImage) {
                qrisPreview.src = qrisImage;
                qrisPreview.classList.remove('hidden');
                deleteQrisButton.classList.remove('hidden');
            } else {
                qrisPreview.classList.add('hidden');
                deleteQrisButton.classList.add('hidden');
            }
        }

        async function loadPaymentConfig() {
            try {
                const response = await fetch('/api/admin/payment-config', { cache: 'no-store' });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.message || 'Gagal memuat konfigurasi pembayaran');

                danaNumberInput.value = data.config.danaNumber || '';
                danaNameInput.value = data.config.danaName || '';
                mandiriNumberInput.value = data.config.mandiriNumber || '';
                mandiriNameInput.value = data.config.mandiriName || '';
                renderQrisPreview(data.config.qrisImage);
            } catch (error) {
                showPaymentConfigAlert(error.message, true);
            }
        }

        qrisImageInput.addEventListener('change', () => {
            const file = qrisImageInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => renderQrisPreview(reader.result);
            reader.readAsDataURL(file);
        });

        savePaymentConfigButton.addEventListener('click', async () => {
            savePaymentConfigButton.disabled = true;
            try {
                const formData = new FormData();
                formData.append('danaNumber', danaNumberInput.value.trim());
                formData.append('danaName', danaNameInput.value.trim());
                formData.append('mandiriNumber', mandiriNumberInput.value.trim());
                formData.append('mandiriName', mandiriNameInput.value.trim());
                if (qrisImageInput.files[0]) {
                    formData.append('qrisImage', qrisImageInput.files[0]);
                }

                const response = await fetch('/api/admin/payment-config', { method: 'POST', body: formData });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.message || 'Gagal menyimpan konfigurasi pembayaran');
                showPaymentConfigAlert(data.message, false);
                qrisImageInput.value = '';
                await loadPaymentConfig();
            } catch (error) {
                showPaymentConfigAlert(error.message, true);
            } finally {
                savePaymentConfigButton.disabled = false;
            }
        });

        deleteQrisButton.addEventListener('click', async () => {
            if (!window.confirm('Hapus gambar QRIS?')) return;
            deleteQrisButton.disabled = true;
            try {
                const response = await fetch('/api/admin/payment-config/qris', { method: 'DELETE' });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.message || 'Gagal menghapus QRIS');
                showPaymentConfigAlert(data.message, false);
                await loadPaymentConfig();
            } catch (error) {
                showPaymentConfigAlert(error.message, true);
            } finally {
                deleteQrisButton.disabled = false;
            }
        });

        // --- Tab Pengguna ---
        const usersAlert = document.getElementById('usersAlert');
        const usersTableBody = document.getElementById('usersTableBody');

        function showUsersAlert(message, isError) {
            usersAlert.textContent = message;
            usersAlert.className = 'mt-3 rounded-xl px-4 py-3 text-sm font-medium ' +
                (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
            usersAlert.classList.remove('hidden');
            setTimeout(() => usersAlert.classList.add('hidden'), 5000);
        }

        const PLAN_OPTIONS = [
            { value: 'free', label: 'Free' },
            { value: 'pro', label: 'Pro' },
            { value: 'max', label: 'Max' },
        ];

        async function loadUsers() {
            try {
                const response = await fetch('/api/admin/users', { cache: 'no-store' });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.message || 'Gagal memuat pengguna');

                if (!data.entries.length) {
                    usersTableBody.innerHTML = '<tr><td class="px-4 py-3 text-slate-400" colspan="7">Belum ada pengguna terdaftar.</td></tr>';
                    return;
                }

                usersTableBody.innerHTML = data.entries.map((u) => {
                    const planSelect = '<select data-user-plan="' + u.id + '" class="rounded-lg border border-slate-200 px-2 py-1 text-sm">' +
                        PLAN_OPTIONS.map((p) => '<option value="' + p.value + '"' + (p.value === u.plan ? ' selected' : '') + '>' + p.label + '</option>').join('') +
                        '</select>';
                    const pendingBadge = u.pendingPlanRequest
                        ? '<span class="mt-1 block rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Minta upgrade: ' + u.pendingPlanRequest + '</span>'
                        : '';

                    let expiryCell = '<span class="text-slate-400">-</span>';
                    if (u.planExpiresAt) {
                        const expiryDate = new Date(u.planExpiresAt);
                        const isExpired = expiryDate.getTime() <= Date.now();
                        expiryCell = '<span class="' + (isExpired ? 'font-semibold text-red-600' : 'text-slate-600') + '">' +
                            expiryDate.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) +
                            (isExpired ? ' (lewat)' : '') + '</span>';
                    }

                    return '<tr>' +
                        '<td class="px-4 py-2 font-medium text-slate-700">' + u.username + '</td>' +
                        '<td class="px-4 py-2 text-slate-600">' + u.phone + '</td>' +
                        '<td class="px-4 py-2 text-slate-600">' + u.accountCount + '/' + u.maxAccounts + '</td>' +
                        '<td class="px-4 py-2 text-slate-600">' + u.messagesToday + '/' + u.dailyMessageLimit + '</td>' +
                        '<td class="px-4 py-2">' + planSelect + pendingBadge + '</td>' +
                        '<td class="px-4 py-2">' + expiryCell + '</td>' +
                        '<td class="px-4 py-2 text-right">' +
                        '<div class="flex justify-end gap-1.5">' +
                        '<button type="button" data-user-action="save-plan" data-id="' + u.id + '" class="inline-flex h-7 items-center justify-center rounded-lg bg-slate-100 px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-200 transition">Simpan Paket</button>' +
                        '<button type="button" data-user-action="delete" data-id="' + u.id + '" data-username="' + u.username + '" class="inline-flex h-7 items-center justify-center rounded-lg bg-red-50 px-2.5 text-[11px] font-semibold text-red-600 hover:bg-red-100 transition">Hapus</button>' +
                        '</div>' +
                        '</td>' +
                        '</tr>';
                }).join('');
            } catch (error) {
                usersTableBody.innerHTML = '<tr><td class="px-4 py-3 text-red-600" colspan="7">' + error.message + '</td></tr>';
            }
        }

        usersTableBody.addEventListener('click', async (event) => {
            const button = event.target.closest('button[data-user-action]');
            if (!button) return;

            const id = button.dataset.id;
            const action = button.dataset.userAction;

            if (action === 'save-plan') {
                const select = usersTableBody.querySelector('select[data-user-plan="' + id + '"]');
                button.disabled = true;
                try {
                    const response = await fetch('/api/admin/users/' + id, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ plan: select.value }),
                    });
                    const data = await response.json();
                    if (!response.ok || !data.success) throw new Error(data.message || 'Gagal menyimpan paket');
                    showUsersAlert(data.message, false);
                    await loadUsers();
                } catch (error) {
                    showUsersAlert(error.message, true);
                } finally {
                    button.disabled = false;
                }
            } else if (action === 'delete') {
                const username = button.dataset.username;
                if (!window.confirm('Hapus pengguna "' + username + '"? Semua akun WAG miliknya juga akan dihapus.')) return;
                button.disabled = true;
                try {
                    const response = await fetch('/api/admin/users/' + id, { method: 'DELETE' });
                    const data = await response.json();
                    if (!response.ok || !data.success) throw new Error(data.message || 'Gagal menghapus pengguna');
                    showUsersAlert(data.message, false);
                    await loadUsers();
                } catch (error) {
                    showUsersAlert(error.message, true);
                    button.disabled = false;
                }
            }
        });

        loadRequests();
        loadNotifyConfig();
        loadPaymentConfig();
        loadUsers();
        setInterval(loadRequests, pollIntervalMs);

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
    body: `<p class="text-slate-600 leading-relaxed">Mengembalikan status koneksi WhatsApp saat ini dalam format JSON. Tidak butuh body request. Tambahkan query <code class="rounded bg-slate-100 px-1.5 py-0.5">?session=ID</code> untuk memilih akun tertentu (default: akun utama). Lihat daftar ID akun lewat <code class="rounded bg-slate-100 px-1.5 py-0.5">GET /api/sessions</code>.</p>`,
    curl: (base) => `curl ${base}/api/status`,
    example: JSON.stringify(
      {
        version: APP_VERSION,
        environment: NODE_ENV,
        sessionId: "default",
        sessionName: "Akun Utama",
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
  {
    id: "sessions-list",
    method: "GET",
    path: "/api/sessions",
    title: "Daftar Akun WhatsApp",
    badge: "publik",
    summary: "Multi-akun: daftar semua akun WhatsApp yang terhubung ke gateway ini beserta statusnya.",
    body: `<p class="text-slate-600 leading-relaxed">Gateway ini mendukung banyak akun WhatsApp sekaligus (sampai batas <code class="rounded bg-slate-100 px-1.5 py-0.5">MAX_ACCOUNTS</code>, diatur di tab Pengaturan). Gunakan <code class="rounded bg-slate-100 px-1.5 py-0.5">id</code> dari daftar ini sebagai nilai query <code class="rounded bg-slate-100 px-1.5 py-0.5">?session=</code> pada endpoint lain untuk memilih akun pengirim.</p>`,
    curl: (base) => `curl ${base}/api/sessions`,
    example: JSON.stringify(
      {
        success: true,
        maxAccounts: 3,
        entries: [
          {
            id: "default",
            name: "Akun Utama",
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
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        requestId: "a1b2c3d4",
      },
      null,
      2,
    ),
  },
  {
    id: "sessions-create",
    method: "POST",
    path: "/api/sessions",
    title: "Tambah Akun WhatsApp",
    badge: "publik",
    summary: "Buat akun WhatsApp baru untuk dihubungkan (akan mendapat QR baru untuk discan).",
    body: `
      <p class="text-slate-600 leading-relaxed">Ditolak dengan status <code class="rounded bg-slate-100 px-1.5 py-0.5">409</code> kalau jumlah akun sudah mencapai batas <code class="rounded bg-slate-100 px-1.5 py-0.5">MAX_ACCOUNTS</code>.</p>
      <div class="mt-4 overflow-x-auto rounded-xl border border-slate-200">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr><th class="px-4 py-2 text-left">Field</th><th class="px-4 py-2 text-left">Tipe</th><th class="px-4 py-2 text-left">Keterangan</th></tr>
          </thead>
          <tbody class="divide-y divide-slate-200">
            <tr><td class="px-4 py-2 font-mono text-emerald-700">name</td><td class="px-4 py-2 text-slate-500">string</td><td class="px-4 py-2 text-slate-600">Nama akun (opsional, untuk label saja)</td></tr>
          </tbody>
        </table>
      </div>
    `,
    curl: (base) => `curl -X POST ${base}/api/sessions \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Akun Marketing"}'`,
    example: JSON.stringify(
      {
        success: true,
        message: "Akun baru dibuat, silakan scan QR untuk menghubungkan.",
        session: { id: "69c8ca94", name: "Akun Marketing" },
        requestId: "a1b2c3d4",
      },
      null,
      2,
    ),
  },
  {
    id: "sessions-delete",
    method: "DELETE",
    path: "/api/sessions/:id",
    title: "Hapus Akun WhatsApp",
    badge: "publik",
    summary: "Logout & hapus akun WhatsApp sepenuhnya dari daftar.",
    body: `<p class="text-slate-600 leading-relaxed">Minimal harus ada 1 akun tersisa — request akan ditolak (<code class="rounded bg-slate-100 px-1.5 py-0.5">400</code>) kalau ini akun terakhir.</p>`,
    curl: (base) => `curl -X DELETE ${base}/api/sessions/<id>`,
    example: JSON.stringify(
      {
        success: true,
        message: "Akun WhatsApp dihapus",
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

app.get("/", requireAdminSession, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.send(renderHomePage());
});

app.get("/login", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.send(renderAdminLoginPage());
});

app.get("/app/login", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.send(renderUserLoginPage());
});

app.get("/app", requireUserSession, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.send(renderUserPortalPage(req.user));
});

app.get("/app/upgrade/:plan", requireUserSession, (req, res) => {
  const plan = req.params.plan;

  if (!PLAN_DEFS[plan] || plan === "free") {
    return res.redirect(302, "/app");
  }

  res.setHeader("Cache-Control", "no-store");
  res.send(renderUpgradePlanPage(req.user, plan));
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
  const session = resolveSessionOrRespond(req, res);
  if (!session) {
    return;
  }

  if (!session.isConnected || !session.sock) {
    logger.warn(`[${req.id}] WhatsApp belum terhubung`, { to: maskedJid, session: session.id });
    return sendFormResult(req, res, 503, {
      success: false,
      title: "WhatsApp belum terhubung",
      plainMessage: "Silakan buka halaman utama dan scan QR terlebih dahulu.",
      requestId: req.id,
    });
  }

  try {
    const [check] = await session.sock.onWhatsApp(jid);
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
    session: session.id,
    hasFile: Boolean(req.file),
    fileName: req.file?.originalname,
    messageLength: message.length,
    queueDepth: session.sendQueue.length,
    activeSendCount: session.activeSendCount,
  });

  try {
    const { result, queueDelayMs, sendDurationMs } = await enqueueMessageSend(session, {
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
      sessionId: session.id,
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
      sessionId: session.id,
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
  const session = resolveSessionOrRespond(req, res);
  if (!session) {
    return;
  }

  if (!session.isConnected || !session.sock) {
    logger.warn(`[${req.id}] API ditolak karena WhatsApp belum terhubung`, {
      clientIp,
      to: maskedJid,
      session: session.id,
    });

    return res.status(503).json({
      success: false,
      message: "WhatsApp belum terhubung",
      requestId: req.id,
      queueDepth: session.sendQueue.length,
    });
  }

  try {
    const [check] = await session.sock.onWhatsApp(jid);
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
    session: session.id,
    messageLength: message.length,
    queueDepth: session.sendQueue.length,
    activeSendCount: session.activeSendCount,
    userAgent: req.get("user-agent") || "unknown",
  });

  try {
    const { result, queueDelayMs, sendDurationMs } = await enqueueMessageSend(session, {
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
      sessionId: session.id,
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
      sessionId: session.id,
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
      queueDepth: session.sendQueue.length,
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
  const session = resolveSessionOrRespond(req, res);
  if (!session) {
    return;
  }

  if (!session.isConnected || !session.sock) {
    logger.warn(`[${req.id}] API send-file ditolak karena WhatsApp belum terhubung`, {
      clientIp,
      to: maskedJid,
      session: session.id,
    });

    return res.status(503).json({
      success: false,
      message: "WhatsApp belum terhubung",
      requestId: req.id,
      queueDepth: session.sendQueue.length,
    });
  }

  try {
    const [check] = await session.sock.onWhatsApp(jid);
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
    session: session.id,
    fileName: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    hasCaption: Boolean(caption),
    queueDepth: session.sendQueue.length,
    activeSendCount: session.activeSendCount,
  });

  try {
    const content = buildMediaMessage(req.file, caption);

    const { result, queueDelayMs, sendDurationMs } = await enqueueMessageSend(session, {
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
      sessionId: session.id,
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
      sessionId: session.id,
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
      queueDepth: session.sendQueue.length,
    });
  }
});

app.post("/api/test-chat", requireAdminSession, async (req, res) => {
  const clientIp = getClientIp(req);
  const session = resolveSessionOrRespond(req, res);
  if (!session) {
    return;
  }

  if (!session.isConnected || !session.sock || !session.sock.user) {
    return res.status(503).json({
      success: false,
      message: "WhatsApp belum terhubung",
      requestId: req.id,
    });
  }

  const ownJid = jidNormalizedUser(session.sock.user.id);
  const maskedJid = maskDestination(ownJid);

  logger.info(`[${req.id}] Test chat ke nomor sendiri`, {
    clientIp,
    to: maskedJid,
    session: session.id,
  });

  try {
    const { result, queueDelayMs, sendDurationMs } = await enqueueMessageSend(session, {
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

app.post("/api/logout", requireAdminSession, async (req, res) => {
  const clientIp = getClientIp(req);
  const session = resolveSessionOrRespond(req, res);
  if (!session) {
    return;
  }

  if (session.isLogoutInProgress) {
    return res.status(409).json({
      success: false,
      message: "Logout akun sedang diproses",
      requestId: req.id,
    });
  }

  logger.info(`[${req.id}] Permintaan ganti akun WhatsApp`, {
    clientIp,
    session: session.id,
    connected: session.isConnected,
    connecting: session.isConnecting,
    authDir: session.authDir,
  });

  try {
    await logoutAndRotateAccount(session, req.id);

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
  const session = resolveSessionOrRespond(req, res);
  if (!session) {
    return;
  }

  const status = getGatewayStatus(session, req.id);

  if (LOG_STATUS_CHECKS) {
    logger.info(`[${req.id}] Status gateway diminta`, status);
  }

  res.setHeader("Cache-Control", "no-store");
  res.json(status);
});

app.get("/api/qr", (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const session = resolveSessionOrRespond(req, res);
  if (!session) {
    return;
  }

  if (!session.qrCodeData) {
    return res.status(404).json({
      success: false,
      message: "QR code belum tersedia",
      requestId: req.id,
    });
  }

  return res.json({
    success: true,
    qrCodeData: session.qrCodeData,
    updatedAt: session.qrUpdatedAt,
    requestId: req.id,
  });
});

app.get("/api/sessions", requireAdminSession, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    maxAccounts: MAX_ACCOUNTS,
    entries: listSessionsSummary(),
    requestId: req.id,
  });
});

app.post("/api/sessions", requireAdminSession, async (req, res) => {
  const clientIp = getClientIp(req);

  if (sessions.size >= MAX_ACCOUNTS) {
    return res.status(409).json({
      success: false,
      message: `Batas maksimum ${MAX_ACCOUNTS} akun WhatsApp sudah tercapai. Ubah batas ini di tab Pengaturan kalau perlu.`,
      requestId: req.id,
    });
  }

  const name = String((req.body && req.body.name) || "").trim();

  try {
    const session = await addSession(name);

    logger.info(`[${req.id}] Akun WhatsApp baru dibuat`, {
      clientIp,
      session: session.id,
      name: session.name,
    });

    return res.json({
      success: true,
      message: "Akun baru dibuat, silakan scan QR untuk menghubungkan.",
      session: { id: session.id, name: session.name },
      requestId: req.id,
    });
  } catch (error) {
    logger.error(`[${req.id}] Gagal membuat akun WhatsApp baru`, {
      clientIp,
      error: error.message,
    });

    return res.status(409).json({
      success: false,
      message: error.message,
      requestId: req.id,
    });
  }
});

app.delete("/api/sessions/:id", requireAdminSession, async (req, res) => {
  const clientIp = getClientIp(req);

  try {
    await removeSession(req.params.id);

    logger.info(`[${req.id}] Akun WhatsApp dihapus`, {
      clientIp,
      session: req.params.id,
    });

    return res.json({
      success: true,
      message: "Akun WhatsApp dihapus",
      requestId: req.id,
    });
  } catch (error) {
    logger.warn(`[${req.id}] Gagal menghapus akun WhatsApp`, {
      clientIp,
      session: req.params.id,
      error: error.message,
    });

    return res.status(400).json({
      success: false,
      message: error.message,
      requestId: req.id,
    });
  }
});

// ---------------------------------------------------------------------------
// Auth: login admin & login/registrasi user
// ---------------------------------------------------------------------------

app.post("/api/auth/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  const row = db.prepare("SELECT * FROM admins WHERE username = ?").get(String(username || "").trim());

  if (!row || !verifyPassword(String(password || ""), row.passwordSalt, row.passwordHash)) {
    return res.status(401).json({ success: false, message: "Username atau password salah", requestId: req.id });
  }

  const token = createWebSession("admin", row.id);
  setSessionCookie(req, res, "wa_admin_sid", token, SESSION_TTL_MS / 1000);

  logger.info(`[${req.id}] Admin login`, { username: row.username });

  return res.json({ success: true, message: "Login berhasil", requestId: req.id });
});

app.post("/api/auth/admin/logout", (req, res) => {
  const cookies = parseCookies(req);
  deleteWebSession(cookies.wa_admin_sid);
  clearSessionCookie(req, res, "wa_admin_sid");
  return res.json({ success: true, message: "Logout berhasil", requestId: req.id });
});

app.post("/api/auth/register", (req, res) => {
  const { username, password, phone } = req.body || {};

  try {
    const user = createUser(username, password, phone);
    const token = createWebSession("user", user.id);
    setSessionCookie(req, res, "wa_user_sid", token, SESSION_TTL_MS / 1000);

    const apiKey = generateApiKeyForUser(user.id);
    sendUserNotification(
      user.phone,
      `Halo ${user.username}, akun kamu berhasil dibuat!\n\nAPI Key kamu:\n${apiKey}\n\nSimpan baik-baik, dipakai untuk kirim pesan lewat API dari sistem/aplikasi kamu sendiri (lihat tab Dokumentasi API di ${PUBLIC_BASE_URL || ""}/app). Kunci ini cuma dikirim sekali — kalau hilang, generate ulang dari tab yang sama.`,
    );

    logger.info(`[${req.id}] User baru mendaftar`, { username: user.username });

    return res.json({
      success: true,
      message: "Registrasi berhasil",
      user,
      apiKey,
      requestId: req.id,
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const row = findUserByUsername(username);

  if (!row || !verifyPassword(String(password || ""), row.passwordSalt, row.passwordHash)) {
    return res.status(401).json({ success: false, message: "Username atau password salah", requestId: req.id });
  }

  const token = createWebSession("user", row.id);
  setSessionCookie(req, res, "wa_user_sid", token, SESSION_TTL_MS / 1000);

  logger.info(`[${req.id}] User login`, { username: row.username });

  return res.json({ success: true, message: "Login berhasil", user: rowToUser(row), requestId: req.id });
});

app.post("/api/auth/logout", (req, res) => {
  const cookies = parseCookies(req);
  deleteWebSession(cookies.wa_user_sid);
  clearSessionCookie(req, res, "wa_user_sid");
  return res.json({ success: true, message: "Logout berhasil", requestId: req.id });
});

// ---------------------------------------------------------------------------
// Portal user: WAG milik sendiri, request akun baru, kuota
// ---------------------------------------------------------------------------

function sessionRowToPublic(row) {
  const runtime = row.status === "active" ? sessions.get(row.id) : null;

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    requestedPhone: row.requestedPhone,
    createdAt: row.createdAt,
    approvedAt: row.approvedAt,
    rejectedAt: row.rejectedAt,
    rejectionReason: row.rejectionReason,
    connected: runtime ? runtime.isConnected : false,
    hasQR: runtime ? runtime.qrCodeData !== "" : false,
    qrUpdatedAt: runtime ? runtime.qrUpdatedAt : 0,
  };
}

app.get("/api/my/sessions", requireUserSession, (req, res) => {
  const rows = listUserSessionRows(req.user.id);

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    maxAccounts: req.user.maxAccounts,
    plan: req.user.plan,
    planLabel: req.user.planLabel,
    planExpiresAt: req.user.planExpiresAt,
    pendingPlanRequest: req.user.pendingPlanRequest,
    dailyMessageLimit: req.user.dailyMessageLimit,
    messagesToday: countUserMessagesToday(req.user.id),
    entries: rows.map(sessionRowToPublic),
    requestId: req.id,
  });
});

app.get("/api/my/sessions/:id/qr", requireUserSession, (req, res) => {
  const row = getSessionRow(req.params.id);
  if (!row || row.ownerType !== "user" || row.ownerUserId !== req.user.id) {
    return res.status(404).json({ success: false, message: "Akun WAG tidak ditemukan", requestId: req.id });
  }

  const runtime = sessions.get(row.id);
  if (!runtime || !runtime.qrCodeData) {
    return res.status(404).json({ success: false, message: "QR code belum tersedia", requestId: req.id });
  }

  return res.json({
    success: true,
    qrCodeData: runtime.qrCodeData,
    updatedAt: runtime.qrUpdatedAt,
    requestId: req.id,
  });
});

app.post("/api/my/sessions", requireUserSession, (req, res) => {
  const activeCount = countUserSessions(req.user.id);

  if (activeCount >= req.user.maxAccounts) {
    return res.status(400).json({
      success: false,
      message: `Kuota akun WAG kamu sudah penuh (${activeCount}/${req.user.maxAccounts}). Hubungi admin untuk upgrade paket.`,
      requestId: req.id,
    });
  }

  const name = String((req.body && req.body.name) || "").trim();
  const row = createPendingWagRequest(req.user, name);

  logger.info(`[${req.id}] Permintaan akun WAG baru`, { user: req.user.username, name: row.name });

  sendAdminNotification(
    `Permintaan akun WAG baru dari ${req.user.username} (${req.user.phone}). Buka dashboard untuk approve.`,
  );

  return res.json({
    success: true,
    message: "Permintaan dikirim, tunggu persetujuan admin.",
    entry: sessionRowToPublic(row),
    requestId: req.id,
  });
});

app.delete("/api/my/sessions/:id", requireUserSession, async (req, res) => {
  try {
    await removeUserOwnedSession(req.params.id, req.user.id);
    logger.info(`[${req.id}] User menghapus akun WAG miliknya`, { user: req.user.username, id: req.params.id });
    return res.json({ success: true, message: "Akun WAG dihapus", requestId: req.id });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }
});

app.post("/api/my/send", requireUserSession, async (req, res) => {
  const { sessionId, number, message } = req.body || {};

  const row = getSessionRow(sessionId);
  if (!row || row.ownerType !== "user" || row.ownerUserId !== req.user.id || row.status !== "active") {
    return res.status(404).json({ success: false, message: "Akun WAG tidak ditemukan", requestId: req.id });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, message: "Akun WAG tidak ditemukan", requestId: req.id });
  }

  const limit = req.user.dailyMessageLimit;
  const usedToday = countUserMessagesToday(req.user.id);

  if (usedToday >= limit) {
    return res.status(429).json({
      success: false,
      message: `Kuota kirim pesan harian kamu sudah habis (${usedToday}/${limit}). Upgrade paket untuk kirim lebih banyak.`,
      requestId: req.id,
    });
  }

  let jid;
  let text;
  try {
    jid = normalizeRecipient(number);
    text = normalizeMessage(message);
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }

  const maskedJid = maskDestination(jid);

  try {
    const { result } = await enqueueMessageSend(session, { jid, content: { text } });

    recordHistory({
      source: "user_portal",
      sessionId: session.id,
      to: maskedJid,
      type: "text",
      message: text.slice(0, 120),
      status: "sent",
      messageId: result?.key?.id,
    });

    logger.info(`[${req.id}] User kirim pesan lewat portal`, { user: req.user.username, to: maskedJid });

    return res.json({
      success: true,
      message: "Pesan berhasil dikirim",
      remaining: Math.max(0, limit - usedToday - 1),
      requestId: req.id,
    });
  } catch (error) {
    recordHistory({
      source: "user_portal",
      sessionId: session.id,
      to: maskedJid,
      type: "text",
      message: text.slice(0, 120),
      status: "failed",
      error: error.message,
    });

    const statusCode = error.code === "NOT_CONNECTED" ? 503 : 500;
    return res.status(statusCode).json({ success: false, message: error.message, requestId: req.id });
  }
});

// ---------------------------------------------------------------------------
// API eksternal per-user: autentikasi lewat x-api-key milik user sendiri
// (bukan API_KEY global admin). Kuota kirim/hari & jumlah akun WAG tetap
// mengikuti paket user (Free/Pro/Max) — dicek sama seperti /api/my/send.
// ---------------------------------------------------------------------------

app.post("/api/external/send", requireUserApiKey, async (req, res) => {
  const { session: sessionId, number, message } = req.body || {};

  let row;
  if (sessionId) {
    row = getSessionRow(sessionId);
    if (!row || row.ownerType !== "user" || row.ownerUserId !== req.user.id || row.status !== "active") {
      return res.status(404).json({ success: false, message: "Akun WAG tidak ditemukan", requestId: req.id });
    }
  } else {
    row = listUserSessionRows(req.user.id).find((r) => r.status === "active");
    if (!row) {
      return res.status(404).json({
        success: false,
        message: "Belum ada akun WAG aktif. Isi parameter 'session' atau approve dulu akun WAG-mu.",
        requestId: req.id,
      });
    }
  }

  const session = sessions.get(row.id);
  if (!session) {
    return res.status(404).json({ success: false, message: "Akun WAG tidak ditemukan", requestId: req.id });
  }

  const limit = req.user.dailyMessageLimit;
  const usedToday = countUserMessagesToday(req.user.id);

  if (usedToday >= limit) {
    return res.status(429).json({
      success: false,
      message: `Kuota kirim pesan harian kamu sudah habis (${usedToday}/${limit}). Upgrade paket untuk kirim lebih banyak.`,
      requestId: req.id,
    });
  }

  let jid;
  let text;
  try {
    jid = normalizeRecipient(number);
    text = normalizeMessage(message);
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }

  const maskedJid = maskDestination(jid);

  try {
    const { result } = await enqueueMessageSend(session, { jid, content: { text } });

    recordHistory({
      source: "external_api",
      sessionId: session.id,
      to: maskedJid,
      type: "text",
      message: text.slice(0, 120),
      status: "sent",
      messageId: result?.key?.id,
    });

    logger.info(`[${req.id}] User kirim pesan lewat API eksternal`, { user: req.user.username, to: maskedJid });

    return res.json({
      success: true,
      message: "Pesan berhasil dikirim",
      messageId: result?.key?.id,
      remaining: Math.max(0, limit - usedToday - 1),
      requestId: req.id,
    });
  } catch (error) {
    recordHistory({
      source: "external_api",
      sessionId: session.id,
      to: maskedJid,
      type: "text",
      message: text.slice(0, 120),
      status: "failed",
      error: error.message,
    });

    const statusCode = error.code === "NOT_CONNECTED" ? 503 : 500;
    return res.status(statusCode).json({ success: false, message: error.message, requestId: req.id });
  }
});

app.get("/api/my/plans", requireUserSession, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    plans: getPlansWithPricing(),
    adminWaNumber: getConfig("adminNotifyPhone") || "",
    requestId: req.id,
  });
});

app.get("/api/my/api-key", requireUserSession, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    apiKeyPrefix: req.user.apiKeyPrefix,
    apiKeyCreatedAt: req.user.apiKeyCreatedAt,
    requestId: req.id,
  });
});

app.post("/api/my/api-key/regenerate", requireUserSession, (req, res) => {
  const apiKey = generateApiKeyForUser(req.user.id);

  logger.info(`[${req.id}] User generate ulang API key`, { user: req.user.username });

  sendUserNotification(
    req.user.phone,
    `API Key baru kamu (kunci lama otomatis tidak berlaku lagi):\n\n${apiKey}\n\nSimpan baik-baik, kunci ini cuma ditampilkan/dikirim sekali.`,
  );

  return res.json({ success: true, message: "API key baru berhasil dibuat", apiKey, requestId: req.id });
});

app.post("/api/my/upgrade-request", requireUserSession, (req, res) => {
  const plan = String((req.body && req.body.plan) || "").trim();

  if (!["pro", "max"].includes(plan)) {
    return res.status(400).json({ success: false, message: "Paket tidak valid", requestId: req.id });
  }

  setUserPendingPlanRequest(req.user.id, plan);

  const price = getPlansWithPricing()[plan].price;
  const priceText = price > 0 ? `Rp${price.toLocaleString("id-ID")}/bulan` : "gratis";

  logger.info(`[${req.id}] Permintaan upgrade paket`, { user: req.user.username, plan });

  sendAdminNotification(
    `${req.user.username} (${req.user.phone}) minta upgrade ke paket ${PLAN_DEFS[plan].label} (${priceText}). Buka tab Pengguna untuk konfirmasi.`,
  );

  return res.json({
    success: true,
    message: `Permintaan upgrade ke paket ${PLAN_DEFS[plan].label} terkirim, tunggu konfirmasi admin.`,
    requestId: req.id,
  });
});

// ---------------------------------------------------------------------------
// Admin: approval permintaan WAG, kelola user, config notifikasi
// ---------------------------------------------------------------------------

app.get("/api/admin/requests", requireAdminSession, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ success: true, entries: listPendingRequests(), requestId: req.id });
});

app.post("/api/admin/requests/:id/approve", requireAdminSession, async (req, res) => {
  if (sessions.size >= MAX_ACCOUNTS) {
    return res.status(409).json({
      success: false,
      message: `Batas maksimum ${MAX_ACCOUNTS} akun WhatsApp sudah tercapai. Naikkan batas ini di tab Pengaturan dulu sebelum approve.`,
      requestId: req.id,
    });
  }

  try {
    const row = approveSessionRequest(req.params.id, req.admin.id);
    activateSessionRuntime(row);

    const owner = findUserById(row.ownerUserId);

    logger.info(`[${req.id}] Permintaan WAG di-approve`, { id: row.id, owner: owner?.username });

    if (owner) {
      sendUserNotification(
        owner.phone,
        `Permintaan akun WAG kamu disetujui! Buka ${PUBLIC_BASE_URL || ""}/app untuk scan QR.`,
      );
    }

    return res.json({ success: true, message: "Permintaan disetujui, sesi WA sedang disiapkan.", requestId: req.id });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }
});

app.post("/api/admin/requests/:id/reject", requireAdminSession, (req, res) => {
  const reason = String((req.body && req.body.reason) || "").trim();

  try {
    const row = rejectSessionRequest(req.params.id, reason);
    const owner = findUserById(row.ownerUserId);

    logger.info(`[${req.id}] Permintaan WAG ditolak`, { id: row.id, owner: owner?.username, reason });

    if (owner) {
      sendUserNotification(
        owner.phone,
        `Permintaan akun WAG kamu ditolak.${reason ? ` Alasan: ${reason}` : ""}`,
      );
    }

    return res.json({ success: true, message: "Permintaan ditolak", requestId: req.id });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }
});

app.get("/api/admin/users", requireAdminSession, (req, res) => {
  const countStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM sessions WHERE ownerUserId = ? AND status IN ('pending_approval', 'active')",
  );

  const entries = listUsers().map((user) => ({
    ...user,
    accountCount: countStmt.get(user.id).c,
    messagesToday: countUserMessagesToday(user.id),
  }));

  res.setHeader("Cache-Control", "no-store");
  return res.json({ success: true, entries, plans: PLAN_DEFS, requestId: req.id });
});

app.patch("/api/admin/users/:id", requireAdminSession, (req, res) => {
  const plan = (req.body && req.body.plan) || "";

  try {
    const previous = findUserById(req.params.id);
    updateUserPlan(req.params.id, plan);
    logger.info(`[${req.id}] Paket user diperbarui`, { id: req.params.id, plan });

    if (previous && previous.plan !== plan) {
      const def = PLAN_DEFS[plan];
      const expiryText = def?.durationDays
        ? ` Berlaku sampai ${new Date(Date.now() + def.durationDays * 24 * 60 * 60 * 1000).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}.`
        : "";

      sendUserNotification(
        previous.phone,
        `Paket kamu sudah diaktifkan admin: ${def?.label || plan} (${def?.maxAccounts ?? "-"} akun WAG, ${def?.dailyMessageLimit ?? "-"} pesan/hari).${expiryText} Buka ${PUBLIC_BASE_URL || ""}/app untuk detailnya.`,
      );
    }

    return res.json({ success: true, message: "Paket berhasil disimpan", requestId: req.id });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }
});

app.delete("/api/admin/users/:id", requireAdminSession, async (req, res) => {
  const userId = req.params.id;

  try {
    const ownedSessions = listUserSessionRows(userId);
    for (const row of ownedSessions) {
      await removeUserOwnedSession(row.id, userId).catch(() => {});
    }

    deleteUserRow(userId);

    logger.info(`[${req.id}] User dihapus`, { id: userId });

    return res.json({ success: true, message: "Pengguna dihapus", requestId: req.id });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }
});

app.get("/api/admin/config", requireAdminSession, (req, res) => {
  const connectedSessions = Array.from(sessions.values())
    .filter((s) => s.isConnected)
    .map((s) => ({ id: s.id, name: s.name }));

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    config: {
      notifierSessionId: getConfig("notifierSessionId") || "",
      adminNotifyPhone: getConfig("adminNotifyPhone") || "",
    },
    plans: getPlansWithPricing(),
    connectedSessions,
    requestId: req.id,
  });
});

app.post("/api/admin/config", requireAdminSession, (req, res) => {
  const { notifierSessionId, adminNotifyPhone, planProPrice, planMaxPrice } = req.body || {};

  setConfig("notifierSessionId", String(notifierSessionId || ""));
  setConfig("adminNotifyPhone", String(adminNotifyPhone || "").replace(/[^\d]/g, ""));

  if (planProPrice !== undefined) {
    setConfig("planPrice_pro", String(Math.max(0, Number(planProPrice) || 0)));
  }
  if (planMaxPrice !== undefined) {
    setConfig("planPrice_max", String(Math.max(0, Number(planMaxPrice) || 0)));
  }

  logger.info(`[${req.id}] Konfigurasi notifikasi & harga paket diperbarui`, {
    notifierSessionId,
    adminNotifyPhone,
    planProPrice,
    planMaxPrice,
  });

  return res.json({ success: true, message: "Konfigurasi tersimpan", requestId: req.id });
});

app.get("/api/admin/payment-config", requireAdminSession, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    config: { ...getPaymentConfig(), qrisImage: getConfig("paymentQrisImage") || "" },
    requestId: req.id,
  });
});

app.post(
  "/api/admin/payment-config",
  requireAdminSession,
  (req, res, next) => {
    upload.single("qrisImage")(req, res, (err) => {
      if (err) {
        const message =
          err.code === "LIMIT_FILE_SIZE"
            ? `Ukuran gambar melebihi batas ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB`
            : err.message;
        return res.status(400).json({ success: false, message, requestId: req.id });
      }
      return next();
    });
  },
  (req, res) => {
    const { danaNumber, danaName, mandiriNumber, mandiriName } = req.body || {};

    setConfig("paymentDanaNumber", String(danaNumber || "").trim());
    setConfig("paymentDanaName", String(danaName || "").trim());
    setConfig("paymentMandiriNumber", String(mandiriNumber || "").trim());
    setConfig("paymentMandiriName", String(mandiriName || "").trim());

    if (req.file) {
      const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      setConfig("paymentQrisImage", dataUrl);
    }

    logger.info(`[${req.id}] Konfigurasi metode pembayaran diperbarui`, {
      hasNewQris: Boolean(req.file),
    });

    return res.json({ success: true, message: "Konfigurasi pembayaran tersimpan", requestId: req.id });
  },
);

app.delete("/api/admin/payment-config/qris", requireAdminSession, (req, res) => {
  setConfig("paymentQrisImage", "");
  logger.info(`[${req.id}] Gambar QRIS dihapus`);
  return res.json({ success: true, message: "Gambar QRIS dihapus", requestId: req.id });
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

app.get("/api/admins", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    entries: listAdmins(),
    requestId: req.id,
  });
});

app.post("/api/admins", (req, res) => {
  const { username, password } = req.body || {};

  try {
    const admin = createAdmin(username, password);

    logger.info(`[${req.id}] Admin baru dibuat`, { username: admin.username });

    return res.json({
      success: true,
      message: "Admin berhasil dibuat",
      entry: admin,
      requestId: req.id,
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }
});

app.patch("/api/admins/:id", (req, res) => {
  const { password } = req.body || {};

  try {
    updateAdminPassword(req.params.id, password);

    logger.info(`[${req.id}] Password admin diperbarui`, { id: req.params.id });

    return res.json({
      success: true,
      message: "Password admin berhasil diperbarui",
      requestId: req.id,
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }
});

app.delete("/api/admins/:id", (req, res) => {
  try {
    deleteAdmin(req.params.id);

    logger.info(`[${req.id}] Admin dihapus`, { id: req.params.id });

    return res.json({
      success: true,
      message: "Admin berhasil dihapus",
      requestId: req.id,
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
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
  const { entries, total } = listHistory(limit);

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    entries,
    total,
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

  const session = resolveSessionOrRespond(req, res);
  if (!session) {
    return;
  }

  if (!session.isConnected || !session.sock) {
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
    session: session.id,
    total: targets.length,
    type,
  });

  targets.forEach(({ jid }) => {
    const maskedJid = maskDestination(jid);

    enqueueMessageSend(session, { jid, content })
      .then(({ result }) => {
        recordHistory({
          source: "broadcast",
          sessionId: session.id,
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
          sessionId: session.id,
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
  const entries = listScheduledJobs().map(({ jid, file, ...rest }) => rest);

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    entries,
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
  const session = resolveSessionOrRespond(req, res);
  if (!session) {
    return;
  }

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
    sessionId: session.id,
    jid,
    to: maskDestination(jid),
    message,
    file: fileInfo,
    hasFile: Boolean(fileInfo),
    sendAt: sendAtDate.toISOString(),
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  insertScheduledJob(job);

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
  const job = findScheduledJob(req.params.id);

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

  updateScheduledJob(job.id, {
    status: "cancelled",
    cancelledAt: new Date().toISOString(),
  });

  if (job.file) {
    await fs.promises.unlink(job.file.path).catch(() => {});
  }

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
  sessions.forEach((session) => clearReconnectTimer(session));

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

function bootstrapDefaultAdmin() {
  if (listAdmins().length > 0) {
    return;
  }

  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");
  const admin = createAdmin(username, password);

  // console.log dipakai (bukan cuma logger) supaya kredensial first-run pasti
  // terlihat operator walau NODE_ENV=production (transport console logger
  // dimatikan di mode production).
  console.log("============================================================");
  console.log(" Akun admin default dibuat untuk login pertama kali:");
  console.log(`   URL      : ${PUBLIC_BASE_URL || `http://localhost:${PORT}`}/login`);
  console.log(`   Username : ${admin.username}`);
  console.log(`   Password : ${password}`);
  console.log(" Segera login lalu ganti password ini lewat tab Pengaturan > Kelola Admin.");
  console.log("============================================================");

  logger.warn("Admin default dibuat", { username: admin.username });
}

function activateSessionRuntime(row) {
  const runtime = createSessionRuntime(row.id, row.name, row.authDir, row.createdAt);
  sessions.set(row.id, runtime);

  connectToWhatsApp(runtime).catch((error) => {
    logger.error("Gagal memulai sesi WhatsApp setelah approval", {
      session: row.id,
      error: error.message,
      stack: error.stack,
    });
  });

  return runtime;
}

bootstrapSessions();
bootstrapDefaultAdmin();

sessions.forEach((session) => {
  connectToWhatsApp(session).catch((error) => {
    logger.error("Inisialisasi awal WhatsApp gagal", {
      session: session.id,
      error: error.message,
      stack: error.stack,
    });
  });
});

const schedulerTimer = setInterval(() => {
  processScheduledMessages().catch((error) => {
    logger.error("Gagal memproses antrean pesan terjadwal", {
      error: error.message,
      stack: error.stack,
    });
  });

  try {
    processExpiredPlans();
  } catch (error) {
    logger.error("Gagal memproses paket user yang kadaluarsa", {
      error: error.message,
      stack: error.stack,
    });
  }
}, SCHEDULER_INTERVAL_MS);
schedulerTimer.unref();
