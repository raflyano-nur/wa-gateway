require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool, types: pgTypes } = require("pg");
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
      { key: "LOGIN_MAX_ATTEMPTS", label: "Maks Percobaan Login Gagal", type: "number", help: "Berapa kali salah password sebelum login dikunci sementara. Default 5." },
      { key: "LOGIN_LOCKOUT_MS", label: "Durasi Kunci Login (ms)", type: "number", help: "Lama login dikunci setelah melewati batas percobaan. Default 900000 (15 menit)." },
      { key: "LOGIN_ATTEMPT_WINDOW_MS", label: "Jendela Hitung Percobaan (ms)", type: "number", help: "Rentang waktu penghitungan percobaan gagal. Kalau tidak ada percobaan gagal baru selama periode ini, hitungannya di-reset. Default 900000 (15 menit)." },
    ],
  },
  {
    id: "plans",
    label: "Paket Langganan",
    fields: [
      { key: "PLAN_EXPIRY_WARNING_DAYS", label: "Peringatan Sebelum Kadaluarsa (hari)", type: "number", help: "Berapa hari sebelum paket berbayar habis, user diingatkan lewat WhatsApp supaya sempat perpanjang. Default 3." },
    ],
  },
  {
    id: "database",
    label: "Database PostgreSQL",
    fields: [
      { key: "HOST_NAME", label: "Host Database", type: "text", help: "⚠️ Salah isi = server gagal start & dashboard tidak bisa dibuka. Perbaikannya harus lewat edit file .env langsung di server." },
      { key: "PORT_DB", label: "Port Database", type: "number", help: "Default PostgreSQL: 5432." },
      { key: "USERNAME_DB", label: "Username Database", type: "text" },
      { key: "PASSWORD_DB", label: "Password Database", type: "password" },
      { key: "NAME_DB", label: "Nama Database", type: "text", help: "Database harus sudah dibuat lebih dulu di PostgreSQL. Tabelnya dibuat otomatis saat server start." },
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

// PostgreSQL type OID 20 = int8/bigint. pg returns those as strings by
// default (BigInt precision safety) — this app only uses them for small
// COUNT(*) results, so parsing to a regular Number keeps every existing
// `.c` / row usage working unchanged.
pgTypes.setTypeParser(20, (value) => parseInt(value, 10));

const pool = new Pool({
  host: process.env.HOST_NAME || "localhost",
  port: Number(process.env.PORT_DB) || 5432,
  user: process.env.USERNAME_DB || "postgres",
  password: process.env.PASSWORD_DB || "",
  database: process.env.NAME_DB,
});

pool.on("error", (error) => {
  logger.error("Koneksi pool PostgreSQL error", { error: error.message });
});

// Query helpers: SQL bisa pakai placeholder `?` (params sebagai array,
// posisi berurutan) ATAU `@nama` (params sebagai object, cocok dengan nama
// key-nya) — sama seperti gaya node:sqlite yang dipakai sebelumnya, supaya
// SQL & pemanggilnya tidak perlu ditulis ulang total. Keduanya dikompilasi
// ke placeholder asli PostgreSQL ($1, $2, ...) sebelum dieksekusi.
function compileQuery(sql, params) {
  if (Array.isArray(params)) {
    let i = 0;
    return { text: sql.replace(/\?/g, () => `$${++i}`), values: params };
  }

  if (params && typeof params === "object") {
    const keys = [];
    const text = sql.replace(/@(\w+)/g, (_, name) => {
      keys.push(name);
      return `$${keys.length}`;
    });
    return { text, values: keys.map((k) => params[k]) };
  }

  return { text: sql, values: [] };
}

function toCamelCase(key) {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// Tabel dibuat dengan kolom snake_case (konvensi native PostgreSQL — kolom
// unquoted otomatis di-lowercase, jadi camelCase akan pecah kalau tidak
// selalu di-quote). Baris hasil query di-camelCase-kan otomatis di sini
// supaya seluruh kode lain yang mengakses row.authDir / row.createdAt dst
// (gaya lama, peninggalan skema SQLite) tetap jalan tanpa diubah.
function camelizeRow(row) {
  if (!row) return row;
  const out = {};
  for (const key of Object.keys(row)) {
    out[toCamelCase(key)] = row[key];
  }
  return out;
}

async function dbAll(sql, params) {
  const { text, values } = compileQuery(sql, params);
  const result = await pool.query(text, values);
  return result.rows.map(camelizeRow);
}

async function dbGet(sql, params) {
  const rows = await dbAll(sql, params);
  return rows[0];
}

async function dbRun(sql, params) {
  const { text, values } = compileQuery(sql, params);
  const result = await pool.query(text, values);
  return { changes: result.rowCount };
}

async function dbExec(sql) {
  await pool.query(sql);
}

async function initSchema() {
  await dbExec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      auth_dir TEXT NOT NULL,
      created_at TEXT NOT NULL,
      owner_type TEXT NOT NULL DEFAULT 'admin',
      owner_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      requested_phone TEXT,
      approved_at TEXT,
      approved_by TEXT,
      rejected_at TEXT,
      rejection_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS message_history (
      seq SERIAL,
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      source TEXT,
      session_id TEXT,
      recipient TEXT,
      type TEXT,
      message TEXT,
      status TEXT,
      message_id TEXT,
      error TEXT,
      request_id TEXT
    );

    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      jid TEXT,
      recipient TEXT,
      message TEXT,
      file_path TEXT,
      file_mimetype TEXT,
      file_name TEXT,
      has_file INTEGER NOT NULL DEFAULT 0,
      send_at TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      message_id TEXT,
      error TEXT,
      cancelled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      phone TEXT NOT NULL,
      max_accounts INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      pending_plan_request TEXT,
      plan_expires_at TEXT,
      api_key_prefix TEXT,
      api_key_hash TEXT,
      api_key_salt TEXT,
      api_key_created_at TEXT,
      expiry_notice_sent_at TEXT,
      expiry_warning_sent_at TEXT,
      webhook_url TEXT,
      webhook_secret TEXT
    );

    CREATE TABLE IF NOT EXISTS web_sessions (
      token TEXT PRIMARY KEY,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS payment_bot_state (
      jid TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Pesan MASUK. Dulu cuma diteruskan ke webhook lalu hilang; sekarang
    -- disimpan supaya user punya inbox & auto-reply punya jejak.
    CREATE TABLE IF NOT EXISTS incoming_messages (
      seq SERIAL,
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      owner_user_id TEXT,
      from_jid TEXT NOT NULL,
      from_masked TEXT,
      push_name TEXT,
      message_id TEXT,
      timestamp TEXT NOT NULL,
      type TEXT,
      text TEXT,
      auto_replied INTEGER NOT NULL DEFAULT 0
    );

    -- Aturan balas otomatis milik user (keyword -> balasan).
    -- user_id NULL + admin_scope=1 = aturan milik admin (berlaku untuk semua
    -- akun WAG milik admin, bukan per-akun-admin — sengaja global karena akun
    -- WAG admin bukan milik satu login admin tertentu).
    CREATE TABLE IF NOT EXISTS auto_replies (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      admin_scope INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      keyword TEXT NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'contains',
      reply_text TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      group_name TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_templates (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Jejak pengiriman webhook (dulu gagal diam-diam tanpa bisa dilacak).
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      seq SERIAL,
      id TEXT PRIMARY KEY,
      user_id TEXT,
      url TEXT NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER,
      attempts INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_api_key_prefix ON users (api_key_prefix);
    CREATE INDEX IF NOT EXISTS idx_incoming_owner ON incoming_messages (owner_user_id, seq DESC);
    CREATE INDEX IF NOT EXISTS idx_incoming_session ON incoming_messages (session_id);
    CREATE INDEX IF NOT EXISTS idx_auto_replies_user ON auto_replies (user_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts (user_id);
    CREATE INDEX IF NOT EXISTS idx_templates_user ON message_templates (user_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_user ON webhook_deliveries (user_id, seq DESC);
  `);

  await ensureColumn("users", "expiry_notice_sent_at", "expiry_notice_sent_at TEXT");
  await ensureColumn("users", "expiry_warning_sent_at", "expiry_warning_sent_at TEXT");
  await ensureColumn("users", "webhook_url", "webhook_url TEXT");
  await ensureColumn("users", "webhook_secret", "webhook_secret TEXT");
  // Pesan terjadwal sekarang bisa dibuat user (dulu admin-only), jadi perlu
  // tahu pemiliknya supaya user cuma bisa lihat/batalkan miliknya sendiri.
  await ensureColumn("scheduled_messages", "owner_user_id", "owner_user_id TEXT");

  // Balas otomatis sekarang bisa dipunya admin juga (dulu user_id NOT NULL,
  // cuma user). Drop NOT NULL aman dijalankan berkali-kali — no-op kalau
  // constraint-nya sudah tidak ada.
  await ensureColumn("auto_replies", "admin_scope", "admin_scope INTEGER NOT NULL DEFAULT 0");
  await dbExec("ALTER TABLE auto_replies ALTER COLUMN user_id DROP NOT NULL");

  // Index ini HARUS dibuat setelah ensureColumn di atas — di database lama
  // kolomnya belum ada saat blok CREATE TABLE di atas dijalankan.
  await dbExec("CREATE INDEX IF NOT EXISTS idx_scheduled_owner ON scheduled_messages (owner_user_id)");
}

// Migrasi kolom baru ke tabel yang sudah berjalan di production (data user
// sudah ada) — idempotent, aman dijalankan tiap start.
async function ensureColumn(table, column, ddl) {
  const existing = await dbAll(
    "SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
    [table, column],
  );
  if (existing.length) {
    return;
  }
  await dbExec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

const insertSessionSql =
  "INSERT INTO sessions (id, name, auth_dir, created_at) VALUES (@id, @name, @authDir, @createdAt) ON CONFLICT (id) DO NOTHING";
const insertHistorySql = `
  INSERT INTO message_history (id, timestamp, source, session_id, recipient, type, message, status, message_id, error, request_id)
  VALUES (@id, @timestamp, @source, @sessionId, @recipient, @type, @message, @status, @messageId, @error, @requestId)
`;
const trimHistorySql =
  "DELETE FROM message_history WHERE seq NOT IN (SELECT seq FROM message_history ORDER BY seq DESC LIMIT ?)";
const insertScheduledSql = `
  INSERT INTO scheduled_messages (id, session_id, jid, recipient, message, file_path, file_mimetype, file_name, has_file, send_at, status, created_at, sent_at, message_id, error, cancelled_at)
  VALUES (@id, @sessionId, @jid, @recipient, @message, @filePath, @fileMimetype, @fileName, @hasFile, @sendAt, @status, @createdAt, @sentAt, @messageId, @error, @cancelledAt)
`;
const updateScheduledJobSql = `
  UPDATE scheduled_messages
  SET status = @status, sent_at = @sentAt, message_id = @messageId, error = @error, cancelled_at = @cancelledAt
  WHERE id = @id
`;

// Migrasi satu kali dari file JSON versi lama (kalau ada dan tabelnya masih
// kosong), supaya data yang sudah tersimpan sebelumnya tidak hilang saat
// upgrade. File lama diganti nama jadi *.migrated sebagai cadangan, bukan
// dihapus.
async function migrateLegacyJsonFile(jsonFile, countSql, migrateEntry) {
  if (!fs.existsSync(jsonFile)) {
    return;
  }

  const existingCount = (await dbGet(countSql)).c;
  if (existingCount > 0) {
    return;
  }

  const stored = readJsonFile(jsonFile, []);
  if (!Array.isArray(stored) || !stored.length) {
    return;
  }

  for (const entry of stored) {
    await migrateEntry(entry);
  }

  try {
    fs.renameSync(jsonFile, `${jsonFile}.migrated`);
  } catch {
    // abaikan, data sudah aman tersimpan di PostgreSQL
  }

  console.log(
    `[migrasi] ${stored.length} baris dipindah dari ${path.basename(jsonFile)} ke PostgreSQL.`,
  );
}

async function migrateLegacyJsonFiles() {
  await migrateLegacyJsonFile(SESSIONS_FILE, "SELECT COUNT(*) AS c FROM sessions", (entry) =>
    dbRun(insertSessionSql, {
      id: entry.id,
      name: entry.name,
      authDir: entry.authDir,
      createdAt: entry.createdAt || new Date().toISOString(),
    }),
  );

  await migrateLegacyJsonFile(HISTORY_FILE, "SELECT COUNT(*) AS c FROM message_history", (entry) =>
    dbRun(insertHistorySql, {
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
    }),
  );

  await migrateLegacyJsonFile(SCHEDULE_FILE, "SELECT COUNT(*) AS c FROM scheduled_messages", (entry) =>
    dbRun(insertScheduledSql, {
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
    }),
  );
}

async function recordHistory(entry) {
  try {
    await dbRun(insertHistorySql, {
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

    await dbRun(trimHistorySql, [MAX_HISTORY_ENTRIES]);
  } catch (error) {
    // recordHistory dipanggil fire-and-forget di banyak tempat (broadcast,
    // scheduler) — kegagalan simpan riwayat tidak boleh menjatuhkan proses
    // utama, cukup dicatat.
    logger.error("Gagal menyimpan riwayat pesan", { error: error.message });
  }
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

async function listHistory(limit) {
  const rows = await dbAll("SELECT * FROM message_history ORDER BY seq DESC LIMIT ?", [limit]);
  const total = (await dbGet("SELECT COUNT(*) AS c FROM message_history")).c;

  return { entries: rows.map(rowToHistoryEntry), total };
}

function rowToJob(row) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    ownerUserId: row.ownerUserId || null,
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

async function insertScheduledJob(job) {
  await dbRun(insertScheduledSql, {
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

async function listScheduledJobs() {
  const rows = await dbAll("SELECT * FROM scheduled_messages ORDER BY created_at DESC");
  return rows.map(rowToJob);
}

async function findScheduledJob(id) {
  const row = await dbGet("SELECT * FROM scheduled_messages WHERE id = ?", [id]);
  return row ? rowToJob(row) : null;
}

async function listDuePendingJobs(now) {
  const rows = await dbAll(
    "SELECT * FROM scheduled_messages WHERE status = 'pending' AND send_at <= ?",
    [new Date(now).toISOString()],
  );
  return rows.map(rowToJob);
}

async function updateScheduledJob(id, patch) {
  const current = await dbGet("SELECT * FROM scheduled_messages WHERE id = ?", [id]);
  if (!current) {
    return null;
  }

  await dbRun(updateScheduledJobSql, {
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

// ---------------------------------------------------------------------------
// Proteksi brute-force login. Percobaan gagal dihitung per kombinasi
// IP + username, disimpan in-memory (cukup — kalau proses restart, penyerang
// juga kehilangan koneksi & harus mulai dari awal). Begitu melewati batas,
// login dari kombinasi itu ditolak sementara TANPA menyentuh database sama
// sekali, jadi serangan tidak membebani Postgres & tidak bisa dipakai untuk
// menebak apakah suatu username ada atau tidak.
// ---------------------------------------------------------------------------

const LOGIN_MAX_ATTEMPTS = Math.max(1, Number(process.env.LOGIN_MAX_ATTEMPTS || 5));
const LOGIN_LOCKOUT_MS = Math.max(1000, Number(process.env.LOGIN_LOCKOUT_MS || 15 * 60 * 1000));
const LOGIN_ATTEMPT_WINDOW_MS = Math.max(1000, Number(process.env.LOGIN_ATTEMPT_WINDOW_MS || 15 * 60 * 1000));

const loginAttempts = new Map();

function loginAttemptKey(scope, username, ip) {
  return `${scope}:${String(username || "").trim().toLowerCase()}:${ip}`;
}

// Dipanggil SEBELUM query database. Mengembalikan sisa detik lockout kalau
// masih terkunci, atau 0 kalau boleh lanjut mencoba.
function getLoginLockoutSeconds(key) {
  const entry = loginAttempts.get(key);
  if (!entry) {
    return 0;
  }

  if (entry.lockedUntil && entry.lockedUntil > Date.now()) {
    return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
  }

  // Lockout sudah lewat, atau jendela penghitungan sudah kedaluwarsa —
  // reset supaya user sah tidak kena getahnya selamanya.
  if ((entry.lockedUntil && entry.lockedUntil <= Date.now()) || Date.now() - entry.firstAt > LOGIN_ATTEMPT_WINDOW_MS) {
    loginAttempts.delete(key);
  }

  return 0;
}

function recordFailedLogin(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);

  if (!entry || now - entry.firstAt > LOGIN_ATTEMPT_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
    return;
  }

  entry.count += 1;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOGIN_LOCKOUT_MS;
  }
}

function clearLoginAttempts(key) {
  loginAttempts.delete(key);
}

// Sapu entri kedaluwarsa berkala supaya Map tidak tumbuh tanpa batas kalau
// ada serangan dari banyak IP berbeda.
const loginAttemptSweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    const lockExpired = !entry.lockedUntil || entry.lockedUntil <= now;
    if (lockExpired && now - entry.firstAt > LOGIN_ATTEMPT_WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }
}, 60 * 1000);
loginAttemptSweeper.unref();

function rowToAdmin(row) {
  return { id: row.id, username: row.username, createdAt: row.createdAt };
}

async function listAdmins() {
  const rows = await dbAll("SELECT id, username, created_at FROM admins ORDER BY created_at ASC");
  return rows.map(rowToAdmin);
}

async function createAdmin(username, password) {
  const trimmedUsername = String(username || "").trim();
  if (trimmedUsername.length < 3) {
    throw new Error("Username admin minimal 3 karakter");
  }
  if (String(password || "").length < 6) {
    throw new Error("Password admin minimal 6 karakter");
  }

  const existing = await dbGet("SELECT id FROM admins WHERE username = ?", [trimmedUsername]);
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

  await dbRun(
    "INSERT INTO admins (id, username, password_hash, password_salt, created_at) VALUES (@id, @username, @passwordHash, @passwordSalt, @createdAt)",
    admin,
  );

  return rowToAdmin(admin);
}

async function updateAdminPassword(id, password) {
  if (String(password || "").length < 6) {
    throw new Error("Password admin minimal 6 karakter");
  }

  const existing = await dbGet("SELECT id FROM admins WHERE id = ?", [id]);
  if (!existing) {
    throw new Error("Admin tidak ditemukan");
  }

  const { salt, hash } = hashPassword(password);
  await dbRun("UPDATE admins SET password_hash = ?, password_salt = ? WHERE id = ?", [
    hash,
    salt,
    id,
  ]);
}

async function deleteAdmin(id) {
  const result = await dbRun("DELETE FROM admins WHERE id = ?", [id]);
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
  // Paket berbayar yang sudah lewat masa berlakunya TIDAK otomatis turun ke
  // Free — biar admin yang putuskan lewat perpanjangan manual (lihat tab
  // Pengguna). Selama masih kadaluarsa, kirim pesan diblokir total (limit 0)
  // di sisi enforcement (bukan cuma ngikut kuota Free) — lihat pengecekan
  // req.user.planExpired di route pengiriman & permintaan akun WAG baru.
  const planExpired = Boolean(row.planExpiresAt) && new Date(row.planExpiresAt).getTime() <= Date.now();
  return {
    id: row.id,
    username: row.username,
    phone: row.phone,
    maxAccounts: row.maxAccounts,
    createdAt: row.createdAt,
    plan,
    planLabel: PLAN_DEFS[plan].label,
    dailyMessageLimit: planExpired ? 0 : PLAN_DEFS[plan].dailyMessageLimit,
    planExpired,
    pendingPlanRequest: row.pendingPlanRequest || null,
    planExpiresAt: row.planExpiresAt || null,
    apiKeyPrefix: row.apiKeyPrefix || null,
    apiKeyCreatedAt: row.apiKeyCreatedAt || null,
  };
}

async function createUser(username, password, phone) {
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

  const existing = await dbGet("SELECT id FROM users WHERE username = ?", [trimmedUsername]);
  if (existing) {
    throw new Error(`Username '${trimmedUsername}' sudah dipakai`);
  }

  // 1 nomor HP cuma boleh dipakai 1 akun — nomor ini juga jadi satu-satunya
  // jalur pengiriman API key (lihat generateApiKeyForUser), jadi harus unik
  // supaya key tidak bisa "nyasar" ke akun lain yang kebetulan pakai nomor sama.
  const existingPhone = await dbGet("SELECT id FROM users WHERE phone = ?", [trimmedPhone]);
  if (existingPhone) {
    throw new Error("Nomor HP ini sudah terdaftar di akun lain");
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

  await dbRun(
    "INSERT INTO users (id, username, password_hash, password_salt, phone, max_accounts, created_at) VALUES (@id, @username, @passwordHash, @passwordSalt, @phone, @maxAccounts, @createdAt)",
    user,
  );

  return rowToUser(user);
}

async function findUserByUsername(username) {
  return dbGet("SELECT * FROM users WHERE username = ?", [String(username || "").trim()]);
}

async function findUserById(id) {
  return dbGet("SELECT * FROM users WHERE id = ?", [id]);
}

async function findUserByPhone(phone) {
  return dbGet("SELECT * FROM users WHERE phone = ?", [String(phone || "").replace(/[^\d]/g, "")]);
}

function generateRandomDigits(length) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += crypto.randomInt(0, 10).toString();
  }
  return out;
}

// API key per-user: cuma hash-nya yang disimpan (kunci mentahnya cuma bisa
// dilihat sekali saat generate — dikirim via WA, tidak pernah ditampilkan di
// UI/response API). Formatnya "WAG-<16 digit acak>-<nomor HP user>" supaya
// gampang dikenali user sendiri kalau lihat di chat WA-nya. apiKeyPrefix (12
// karakter awal — cuma menyentuh bagian acaknya, bukan nomor HP) dipakai
// sebagai index untuk cari user pemilik key tanpa perlu scan semua hash.
async function generateApiKeyForUser(userId, phone) {
  const randomDigits = generateRandomDigits(16);
  const phoneDigits = String(phone || "").replace(/[^\d]/g, "");
  const rawKey = `WAG-${randomDigits}-${phoneDigits}`;
  const prefix = rawKey.slice(0, 12);
  const { salt, hash } = hashPassword(rawKey);

  await dbRun(
    "UPDATE users SET api_key_prefix = ?, api_key_hash = ?, api_key_salt = ?, api_key_created_at = ? WHERE id = ?",
    [prefix, hash, salt, new Date().toISOString(), userId],
  );

  return rawKey;
}

async function findUserByApiKey(rawKey) {
  if (!rawKey || rawKey.length < 12) {
    return null;
  }

  const prefix = rawKey.slice(0, 12);
  const row = await dbGet("SELECT * FROM users WHERE api_key_prefix = ?", [prefix]);

  if (!row || !row.apiKeyHash || !verifyPassword(rawKey, row.apiKeySalt, row.apiKeyHash)) {
    return null;
  }

  return row;
}

async function requireUserApiKey(req, res, next) {
  const providedKey = req.get("x-api-key") || "";
  const row = await findUserByApiKey(providedKey);

  if (!row) {
    return res.status(401).json({ success: false, message: "API key tidak valid", requestId: req.id });
  }

  req.user = rowToUser(row);
  return next();
}

async function listUsers() {
  const rows = await dbAll("SELECT * FROM users ORDER BY created_at ASC");
  return rows.map(rowToUser);
}

async function updateUserPlan(id, plan) {
  if (!PLAN_DEFS[plan]) {
    throw new Error("Paket tidak dikenal");
  }

  const existing = await dbGet("SELECT id FROM users WHERE id = ?", [id]);
  if (!existing) {
    throw new Error("User tidak ditemukan");
  }

  const durationDays = PLAN_DEFS[plan].durationDays;
  const expiresAt = durationDays
    ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  await dbRun(
    "UPDATE users SET plan = ?, max_accounts = ?, pending_plan_request = NULL, plan_expires_at = ?, expiry_notice_sent_at = NULL, expiry_warning_sent_at = NULL WHERE id = ?",
    [plan, PLAN_DEFS[plan].maxAccounts, expiresAt, id],
  );
}

async function setUserPendingPlanRequest(id, plan) {
  await dbRun("UPDATE users SET pending_plan_request = ? WHERE id = ?", [plan, id]);
}

// Downgrade ke Free HANYA dipanggil lewat konfirmasi eksplisit user (balas
// "2" di chat notifikasi kadaluarsa) — tidak pernah otomatis lewat cron.
async function downgradeUserToFreeConfirmed(id) {
  await dbRun(
    "UPDATE users SET plan = 'free', max_accounts = ?, plan_expires_at = NULL, expiry_notice_sent_at = NULL, expiry_warning_sent_at = NULL WHERE id = ?",
    [PLAN_DEFS.free.maxAccounts, id],
  );
}

// Dipanggil berkala (bareng scheduler pesan terjadwal). Paket yang sudah
// lewat masa berlakunya TIDAK diturunkan otomatis — cuma dikirimi WA sekali
// (idempotent via expiry_notice_sent_at) berisi pilihan: perpanjang ke paket
// yang sama, atau turun ke Free. Balasannya ditangani di handlePaymentBotMessage
// (state "expiry_choice").
async function notifyExpiredPlans() {
  const rows = await dbAll(
    "SELECT id, username, phone, plan, plan_expires_at FROM users WHERE plan_expires_at IS NOT NULL AND plan_expires_at <= ? AND plan != 'free' AND expiry_notice_sent_at IS NULL",
    [new Date().toISOString()],
  );

  for (const row of rows) {
    const planLabel = PLAN_DEFS[row.plan]?.label || row.plan;
    const expiredDate = new Date(row.planExpiresAt).toLocaleDateString("id-ID", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    const jid = `${row.phone}@s.whatsapp.net`;
    const delivered = await sendUserNotification(
      row.phone,
      `Paket ${planLabel} kamu sudah habis masa berlakunya sejak ${expiredDate}. Kirim pesan & tambah akun WAG baru diblokir sementara sampai kamu pilih salah satu:\n\n1. Perpanjang ke ${planLabel} lagi\n2. Turun ke paket Free (gratis, kuota lebih kecil)\n\nBalas angkanya ya.`,
    );

    if (delivered) {
      await setPaymentBotState(jid, "expiry_choice");
      await dbRun("UPDATE users SET expiry_notice_sent_at = ? WHERE id = ?", [new Date().toISOString(), row.id]);
      logger.info("Notifikasi paket kadaluarsa terkirim", { user: row.username, plan: row.plan });
    } else {
      logger.warn("Gagal mengirim notifikasi paket kadaluarsa (WAG notifier belum terhubung)", { user: row.username });
    }
  }
}

// Peringatan H-3 SEBELUM paket habis, supaya user sempat bayar sebelum
// layanannya diblokir (beda dengan notifyExpiredPlans yang jalan setelah
// telanjur mati). Idempotent lewat expiry_warning_sent_at, yang di-reset tiap
// kali paket diperpanjang/diganti di updateUserPlan.
const PLAN_EXPIRY_WARNING_DAYS = Math.max(1, Number(process.env.PLAN_EXPIRY_WARNING_DAYS || 3));

async function notifyExpiringSoonPlans() {
  const now = Date.now();
  const horizon = new Date(now + PLAN_EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const rows = await dbAll(
    `SELECT id, username, phone, plan, plan_expires_at FROM users
     WHERE plan_expires_at IS NOT NULL
       AND plan_expires_at > ?
       AND plan_expires_at <= ?
       AND plan != 'free'
       AND expiry_warning_sent_at IS NULL`,
    [new Date(now).toISOString(), horizon],
  );

  for (const row of rows) {
    const planLabel = PLAN_DEFS[row.plan]?.label || row.plan;
    const expiresAtMs = new Date(row.planExpiresAt).getTime();
    const daysLeft = Math.max(1, Math.ceil((expiresAtMs - now) / (24 * 60 * 60 * 1000)));
    const expiryDate = new Date(row.planExpiresAt).toLocaleDateString("id-ID", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    const jid = `${row.phone}@s.whatsapp.net`;
    const delivered = await sendUserNotification(
      row.phone,
      `Halo ${row.username}, paket *${planLabel}* kamu akan berakhir dalam ${daysLeft} hari lagi (${expiryDate}).\n\nPerpanjang sekarang supaya layanan tidak terputus — kalau sudah lewat tanggalnya, kirim pesan & tambah akun WAG otomatis diblokir sampai diperpanjang.\n\nBalas *1* kalau mau perpanjang sekarang.`,
    );

    if (delivered) {
      // State yang sama dengan alur kadaluarsa: balas "1" = minta perpanjang,
      // "2" = turun ke Free. Konsisten supaya user tidak bingung.
      await setPaymentBotState(jid, "expiry_choice");
      await dbRun("UPDATE users SET expiry_warning_sent_at = ? WHERE id = ?", [new Date().toISOString(), row.id]);
      logger.info("Peringatan paket akan berakhir terkirim", { user: row.username, plan: row.plan, daysLeft });
    } else {
      logger.warn("Gagal mengirim peringatan paket akan berakhir (WAG notifier belum terhubung)", {
        user: row.username,
      });
    }
  }
}

async function countUserMessagesToday(userId) {
  const sessionRows = await listUserSessionRows(userId);
  const sessionIds = sessionRows.map((row) => row.id);
  if (!sessionIds.length) {
    return 0;
  }

  const placeholders = sessionIds.map(() => "?").join(",");
  const row = await dbGet(
    `SELECT COUNT(*) AS c FROM message_history WHERE session_id IN (${placeholders}) AND timestamp::date = CURRENT_DATE`,
    sessionIds,
  );

  return row.c;
}

async function deleteUserRow(id) {
  const result = await dbRun("DELETE FROM users WHERE id = ?", [id]);
  if (result.changes === 0) {
    throw new Error("User tidak ditemukan");
  }
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function createWebSession(subjectType, subjectId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();

  await dbRun(
    "INSERT INTO web_sessions (token, subject_type, subject_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    [token, subjectType, subjectId, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString()],
  );

  return token;
}

async function findWebSession(token, subjectType) {
  if (!token) {
    return null;
  }

  const row = await dbGet("SELECT * FROM web_sessions WHERE token = ? AND subject_type = ?", [
    token,
    subjectType,
  ]);

  if (!row) {
    return null;
  }

  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await dbRun("DELETE FROM web_sessions WHERE token = ?", [token]);
    return null;
  }

  return row;
}

async function deleteWebSession(token) {
  if (!token) {
    return;
  }
  await dbRun("DELETE FROM web_sessions WHERE token = ?", [token]);
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

async function requireAdminSession(req, res, next) {
  const cookies = parseCookies(req);
  const webSession = await findWebSession(cookies.wa_admin_sid, "admin");

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

async function requireUserSession(req, res, next) {
  const cookies = parseCookies(req);
  const webSession = await findWebSession(cookies.wa_user_sid, "user");
  const userRow = webSession ? await findUserById(webSession.subjectId) : null;

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

async function getConfig(key) {
  const row = await dbGet("SELECT value FROM app_config WHERE key = ?", [key]);
  return row ? row.value : null;
}

async function setConfig(key, value) {
  await dbRun(
    "INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

// Harga tiap paket diatur admin lewat tab Persetujuan (disimpan di app_config,
// bukan hardcode) — supaya bisa diubah kapan saja tanpa restart server.
async function getPlansWithPricing() {
  const plans = {};
  for (const [key, def] of Object.entries(PLAN_DEFS)) {
    const storedPrice = await getConfig(`planPrice_${key}`);
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

async function getPaymentBotState(jid) {
  const row = await dbGet("SELECT state FROM payment_bot_state WHERE jid = ?", [jid]);
  return row ? row.state : null;
}

async function setPaymentBotState(jid, state) {
  await dbRun(
    "INSERT INTO payment_bot_state (jid, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
    [jid, state, new Date().toISOString()],
  );
}

async function clearPaymentBotState(jid) {
  await dbRun("DELETE FROM payment_bot_state WHERE jid = ?", [jid]);
}

async function getPaymentConfig() {
  return {
    danaNumber: (await getConfig("paymentDanaNumber")) || "",
    danaName: (await getConfig("paymentDanaName")) || "",
    mandiriNumber: (await getConfig("paymentMandiriNumber")) || "",
    mandiriName: (await getConfig("paymentMandiriName")) || "",
    hasQris: Boolean(await getConfig("paymentQrisImage")),
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
  const { danaNumber, danaName } = await getPaymentConfig();
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
  const { mandiriNumber, mandiriName } = await getPaymentConfig();
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
  const qrisImage = await getConfig("paymentQrisImage");
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

async function buildPlanListText() {
  const plans = await getPlansWithPricing();
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
  await session.sock.sendMessage(jid, { text: await buildPlanListText() });
}

const CANCEL_KEYWORDS = ["batal", "gak jadi", "ga jadi", "tidak jadi", "nggak jadi", "cancel"];

function isCancelKeyword(normalized) {
  return CANCEL_KEYWORDS.some((k) => normalized.includes(k));
}

// Membatalkan alur upgrade: hapus pendingPlanRequest user (kalau ada) supaya
// badge "Minta upgrade" di dashboard admin tidak nyangkut/salah info, terus
// akhiri percakapan bot (state dihapus total, idle sampai trigger baru).
async function cancelUpgradeFlow(session, jid) {
  const userRow = await findUserByPhone(jid.split("@")[0]);
  if (userRow && userRow.pendingPlanRequest) {
    await setUserPendingPlanRequest(userRow.id, null);
  }

  await session.sock.sendMessage(jid, {
    text: "Oke kak, dibatalkan ya. Chat \"upgrade paket\" lagi kapan aja kalau mau lanjut.",
  });
  await clearPaymentBotState(jid);
}

async function handlePaymentBotMessage(session, jid, text) {
  const notifierSessionId = await getConfig("notifierSessionId");
  if (!notifierSessionId || session.id !== notifierSessionId || !text) {
    return;
  }

  const normalized = text.trim().toLowerCase();
  const state = await getPaymentBotState(jid);

  // Bisa dibatalkan kapan pun selama masih di tengah alur bot.
  if (state && isCancelKeyword(normalized)) {
    await cancelUpgradeFlow(session, jid);
    return;
  }

  // Balasan atas notifikasi paket kadaluarsa (dikirim notifyExpiredPlans).
  if (state === "expiry_choice") {
    const userRow = await findUserByPhone(jid.split("@")[0]);

    if (normalized === "2" || normalized.includes("free") || normalized.includes("turun")) {
      if (userRow) {
        await downgradeUserToFreeConfirmed(userRow.id);
      }
      await session.sock.sendMessage(jid, {
        text: "Oke kak, paket diturunkan ke Free ya. Chat \"upgrade paket\" lagi kapan aja kalau mau lanjut pakai kuota lebih besar.",
      });
      await clearPaymentBotState(jid);
      return;
    }

    if (normalized === "1" || normalized.includes("perpanjang") || normalized.includes("lanjut") || normalized.includes("pro") || normalized.includes("max")) {
      if (userRow) {
        const renewPlan = PLAN_DEFS[userRow.plan] ? userRow.plan : "pro";
        await setUserPendingPlanRequest(userRow.id, renewPlan);
        const price = (await getPlansWithPricing())[renewPlan].price;
        const priceText = price > 0 ? `Rp${price.toLocaleString("id-ID")}/bulan` : "gratis";
        sendAdminNotification(
          `${userRow.username} (${userRow.phone}) mau perpanjang paket ${PLAN_DEFS[renewPlan].label} (${priceText}) lewat chat — paketnya sudah kadaluarsa. Buka tab Pengguna untuk konfirmasi setelah bayar.`,
        );
      }

      await sendPaymentMenu(session, jid);
      await setPaymentBotState(jid, "awaiting_choice");
      return;
    }

    // Balasan tidak dikenali — tawarkan lagi pilihannya (sticky).
    await session.sock.sendMessage(jid, {
      text: "Balas *1* buat perpanjang paket, atau *2* buat turun ke Free ya kak.",
    });
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
      await setPaymentBotState(jid, "post_payment");
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
    await setPaymentBotState(jid, "post_payment_menu");
    return;
  }

  if (state === "post_payment_menu") {
    if (normalized === "1" || normalized.includes("paket")) {
      await sendPlanList(session, jid);
      await setPaymentBotState(jid, "choosing_plan");
      return;
    }

    if (normalized === "2" || normalized.includes("metode") || normalized.includes("bayar")) {
      await sendPaymentMenu(session, jid);
      await setPaymentBotState(jid, "awaiting_choice");
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
    const userRow = await findUserByPhone(jid.split("@")[0]);

    if (normalized.includes("free")) {
      if (userRow) {
        await setUserPendingPlanRequest(userRow.id, null);
      }
      await session.sock.sendMessage(jid, {
        text: "Oke kak, tetap di paket Free ya (gratis). Chat \"upgrade paket\" lagi kapan aja kalau berubah pikiran.",
      });
      await clearPaymentBotState(jid);
      return;
    }

    const chosenPlan = normalized.includes("max") ? "max" : normalized.includes("pro") ? "pro" : null;

    if (chosenPlan) {
      if (userRow) {
        await setUserPendingPlanRequest(userRow.id, chosenPlan);
        const price = (await getPlansWithPricing())[chosenPlan].price;
        const priceText = price > 0 ? `Rp${price.toLocaleString("id-ID")}/bulan` : "gratis";
        sendAdminNotification(
          `${userRow.username} (${userRow.phone}) ganti pilihan upgrade ke paket ${PLAN_DEFS[chosenPlan].label} (${priceText}) lewat chat. Buka tab Pengguna untuk konfirmasi.`,
        );
      }

      await session.sock.sendMessage(jid, {
        text: `Oke kak, paket diganti ke *${PLAN_DEFS[chosenPlan].label}*.`,
      });
      await sendPaymentMenu(session, jid);
      await setPaymentBotState(jid, "awaiting_choice");
      return;
    }

    // Balasan tidak dikenali — tetap tawarkan lagi daftar paketnya.
    await sendPlanList(session, jid);
    return;
  }

  if (normalized.includes("upgrade paket")) {
    await sendPaymentMenu(session, jid);
    await setPaymentBotState(jid, "awaiting_choice");
  }
}

const insertPendingRequestSql = `
  INSERT INTO sessions (id, name, auth_dir, created_at, owner_type, owner_user_id, status, requested_phone)
  VALUES (@id, @name, @authDir, @createdAt, 'user', @ownerUserId, 'pending_approval', @requestedPhone)
`;

async function countUserSessions(userId) {
  const row = await dbGet(
    "SELECT COUNT(*) AS c FROM sessions WHERE owner_user_id = ? AND status IN ('pending_approval', 'active')",
    [userId],
  );
  return row.c;
}

async function createPendingWagRequest(user, name) {
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

  await dbRun(insertPendingRequestSql, row);
  return getSessionRow(id);
}

async function getSessionRow(id) {
  return dbGet("SELECT * FROM sessions WHERE id = ?", [id]);
}

async function listUserSessionRows(userId) {
  return dbAll("SELECT * FROM sessions WHERE owner_user_id = ? ORDER BY created_at DESC", [userId]);
}

async function listPendingRequests() {
  return dbAll(
    `SELECT s.*, u.username AS owner_username, u.phone AS owner_phone
     FROM sessions s JOIN users u ON u.id = s.owner_user_id
     WHERE s.status = 'pending_approval'
     ORDER BY s.created_at ASC`,
  );
}

async function approveSessionRequest(id, adminId) {
  const row = await getSessionRow(id);
  if (!row || row.status !== "pending_approval") {
    throw new Error("Permintaan tidak ditemukan atau sudah diproses");
  }

  await dbRun("UPDATE sessions SET status = 'active', approved_at = ?, approved_by = ? WHERE id = ?", [
    new Date().toISOString(),
    adminId,
    id,
  ]);

  return getSessionRow(id);
}

async function rejectSessionRequest(id, reason) {
  const row = await getSessionRow(id);
  if (!row || row.status !== "pending_approval") {
    throw new Error("Permintaan tidak ditemukan atau sudah diproses");
  }

  await dbRun("UPDATE sessions SET status = 'rejected', rejected_at = ?, rejection_reason = ? WHERE id = ?", [
    new Date().toISOString(),
    reason || null,
    id,
  ]);

  return getSessionRow(id);
}

async function deleteSessionRow(id) {
  await dbRun("DELETE FROM sessions WHERE id = ?", [id]);
}

// Mengembalikan boolean: true kalau pesan benar-benar terkirim. Dipakai
// caller yang perlu tahu apakah pengiriman WA-nya sukses (mis. pengiriman
// API key, yang cuma dikirim lewat WA — tidak ada fallback tampil di layar).
async function sendSystemNotification(jid, text) {
  if (!jid) {
    return false;
  }

  try {
    const notifierSessionId = await getConfig("notifierSessionId");
    const notifierSession = notifierSessionId ? sessions.get(notifierSessionId) : null;

    if (!notifierSession || !notifierSession.isConnected || !notifierSession.sock) {
      logger.warn("Notifikasi WA dilewati: WAG notifier belum dikonfigurasi/terhubung", {
        jid: maskDestination(jid),
      });
      return false;
    }

    await notifierSession.sock.sendMessage(normalizeRecipient(jid), { text });
    return true;
  } catch (error) {
    logger.warn("Gagal mengirim notifikasi WA", { jid: maskDestination(jid), error: error.message });
    return false;
  }
}

async function sendAdminNotification(text) {
  try {
    const adminPhone = await getConfig("adminNotifyPhone");
    if (!adminPhone) {
      return false;
    }
    return sendSystemNotification(adminPhone, text);
  } catch (error) {
    logger.warn("Gagal mengambil konfigurasi nomor admin", { error: error.message });
    return false;
  }
}

async function sendUserNotification(phone, text) {
  if (!phone) {
    return false;
  }
  return sendSystemNotification(phone, text);
}

// Dipanggil saat sebuah akun WAG putus permanen (logged out — perlu scan
// ulang). Sesi milik user dikabari ke nomor user itu; sesi milik admin
// dikabari ke nomor notifikasi admin. Sesi notifier sendiri dilewati karena
// pesannya mustahil terkirim (justru notifier-nya yang mati).
async function notifySessionLoggedOut(session) {
  const notifierSessionId = await getConfig("notifierSessionId");

  if (notifierSessionId && session.id === notifierSessionId) {
    logger.error("WAG notifier sendiri yang logout — notifikasi WA tidak bisa dikirim, perlu scan ulang manual", {
      session: session.id,
    });
    return;
  }

  const row = await getSessionRow(session.id);
  const portalUrl = `${PUBLIC_BASE_URL || ""}/app`;

  if (row && row.ownerType === "user" && row.ownerUserId) {
    const owner = await findUserById(row.ownerUserId);
    if (owner) {
      await sendUserNotification(
        owner.phone,
        `⚠️ Akun WAG kamu *${session.name}* terputus dari WhatsApp dan perlu di-scan ulang.\n\nSelama belum di-scan, pesan yang dikirim lewat akun ini akan gagal. Buka ${portalUrl} lalu scan QR-nya lagi ya.`,
      );
      logger.info("Notifikasi WAG terputus dikirim ke user", { session: session.id, user: owner.username });
    }
    return;
  }

  await sendAdminNotification(
    `⚠️ Akun WAG *${session.name}* (${session.id}) terputus dari WhatsApp dan perlu di-scan ulang lewat dashboard admin.`,
  );
  logger.info("Notifikasi WAG terputus dikirim ke admin", { session: session.id });
}

const WEBHOOK_MAX_ATTEMPTS = Math.max(1, Number(process.env.WEBHOOK_MAX_ATTEMPTS || 3));
const WEBHOOK_RETRY_BASE_MS = Math.max(200, Number(process.env.WEBHOOK_RETRY_BASE_MS || 2000));
const MAX_WEBHOOK_LOG_ENTRIES = Math.max(50, Number(process.env.MAX_WEBHOOK_LOG_ENTRIES || 500));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Kirim webhook dengan percobaan ulang berjenjang (exponential backoff) dan
// selalu mencatat hasil akhirnya ke webhook_deliveries — dulu kegagalan cuma
// muncul di log server, jadi user tidak pernah tahu webhook-nya bermasalah.
// Status HTTP 4xx TIDAK diulang: itu error di sisi penerima (URL salah, auth
// ditolak), mengulanginya cuma buang waktu.
async function postWebhook(url, secret, payload, label, userId) {
  if (!url) {
    return;
  }

  const headers = { "Content-Type": "application/json" };
  if (secret) {
    headers["x-webhook-secret"] = secret;
  }

  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await withTimeout(
        fetch(url, { method: "POST", headers, body: JSON.stringify(payload) }),
        8000,
        "Webhook",
      );

      lastStatus = response.status;

      if (response.ok) {
        logger.info(`${label} pesan masuk terkirim`, { to: url, messageId: payload.messageId, attempt });
        await recordWebhookDelivery(userId, url, "sent", response.status, attempt, null);
        return;
      }

      lastError = `HTTP ${response.status}`;

      if (response.status >= 400 && response.status < 500) {
        logger.warn(`${label} ditolak penerima, tidak diulang`, { to: url, status: response.status });
        await recordWebhookDelivery(userId, url, "failed", response.status, attempt, lastError);
        return;
      }
    } catch (error) {
      lastError = error.message;
    }

    if (attempt < WEBHOOK_MAX_ATTEMPTS) {
      await sleep(WEBHOOK_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }

  logger.warn(`${label} pesan masuk gagal terkirim`, { to: url, error: lastError, attempts: WEBHOOK_MAX_ATTEMPTS });
  await recordWebhookDelivery(userId, url, "failed", lastStatus, WEBHOOK_MAX_ATTEMPTS, lastError);
}

async function recordWebhookDelivery(userId, url, status, httpStatus, attempts, error) {
  try {
    await dbRun(
      `INSERT INTO webhook_deliveries (id, user_id, url, status, http_status, attempts, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), userId || null, url, status, httpStatus, attempts, error, new Date().toISOString()],
    );

    await dbRun(
      "DELETE FROM webhook_deliveries WHERE seq NOT IN (SELECT seq FROM webhook_deliveries ORDER BY seq DESC LIMIT ?)",
      [MAX_WEBHOOK_LOG_ENTRIES],
    );
  } catch (dbError) {
    logger.warn("Gagal mencatat log pengiriman webhook", { error: dbError.message });
  }
}

// Webhook global milik operator gateway (diatur lewat .env) — menerima pesan
// masuk dari SEMUA akun WAG.
async function dispatchWebhook(payload) {
  await postWebhook(WEBHOOK_URL, WEBHOOK_SECRET, payload, "Webhook");
}

// Webhook milik user pemilik akun WAG (diatur sendiri lewat portal). Hanya
// menerima pesan masuk dari akun WAG miliknya sendiri, jadi user tidak bisa
// mengintip percakapan akun user lain.
async function dispatchUserWebhook(sessionId, payload) {
  const row = await getSessionRow(sessionId);
  if (!row || row.ownerType !== "user" || !row.ownerUserId) {
    return;
  }

  const owner = await findUserById(row.ownerUserId);
  if (!owner || !owner.webhookUrl) {
    return;
  }

  await postWebhook(owner.webhookUrl, owner.webhookSecret, payload, "Webhook user", owner.id);
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

// ---------------------------------------------------------------------------
// Inbox pesan masuk + balas otomatis berbasis keyword milik user.
// ---------------------------------------------------------------------------

const MAX_INBOX_ENTRIES = Math.max(100, Number(process.env.MAX_INBOX_ENTRIES || 2000));

// Isi placeholder {{nama}} / {{nomor}} dst pada template & balasan otomatis.
// Placeholder yang tidak dikenal dibiarkan apa adanya supaya user sadar kalau
// salah tulis, bukan diam-diam jadi string kosong.
function renderTemplateContent(content, vars) {
  return String(content || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (full, key) => {
    const value = vars[String(key).toLowerCase()];
    return value === undefined || value === null || value === "" ? full : String(value);
  });
}

function matchesAutoReplyRule(rule, normalizedText) {
  const keyword = String(rule.keyword || "").trim().toLowerCase();
  if (!keyword) {
    return false;
  }

  if (rule.matchType === "exact") {
    return normalizedText === keyword;
  }
  if (rule.matchType === "starts") {
    return normalizedText.startsWith(keyword);
  }
  return normalizedText.includes(keyword);
}

async function storeIncomingAndAutoReply(session, msg, payload) {
  const row = await getSessionRow(session.id);
  const ownerUserId = row && row.ownerType === "user" ? row.ownerUserId : null;

  await dbRun(
    `INSERT INTO incoming_messages (id, session_id, owner_user_id, from_jid, from_masked, push_name, message_id, timestamp, type, text, auto_replied)
     VALUES (@id, @sessionId, @ownerUserId, @fromJid, @fromMasked, @pushName, @messageId, @timestamp, @type, @text, 0)
     ON CONFLICT (id) DO NOTHING`,
    {
      id: uuidv4(),
      sessionId: session.id,
      ownerUserId,
      fromJid: payload.from || "",
      fromMasked: payload.fromMasked || null,
      pushName: payload.pushName,
      messageId: payload.messageId || null,
      timestamp: new Date(payload.timestamp || Date.now()).toISOString(),
      type: payload.type || null,
      text: payload.text || null,
    },
  );

  // Buang entri paling lama supaya tabel tidak tumbuh tanpa batas.
  await dbRun(
    "DELETE FROM incoming_messages WHERE seq NOT IN (SELECT seq FROM incoming_messages ORDER BY seq DESC LIMIT ?)",
    [MAX_INBOX_ENTRIES],
  );

  if (!payload.text) {
    return;
  }

  const isAdminSession = row && row.ownerType === "admin";
  if (!ownerUserId && !isAdminSession) {
    return;
  }

  let owner = null;
  let ownerPublic = null;

  if (ownerUserId) {
    owner = await findUserById(ownerUserId);
    if (!owner) {
      return;
    }
    // Paket kadaluarsa = layanan diblokir, termasuk balas otomatis.
    ownerPublic = rowToUser(owner);
    if (ownerPublic.planExpired) {
      return;
    }
  }

  // Aturan user cuma dicocokkan untuk sesi milik user itu; aturan admin
  // (admin_scope=1, global) cuma dicocokkan untuk sesi milik admin — dua
  // scope ini sengaja tidak pernah tercampur.
  const rules = ownerUserId
    ? await dbAll(
        `SELECT * FROM auto_replies
         WHERE user_id = ? AND enabled = 1 AND (session_id IS NULL OR session_id = ?)
         ORDER BY created_at ASC`,
        [ownerUserId, session.id],
      )
    : await dbAll(
        `SELECT * FROM auto_replies
         WHERE admin_scope = 1 AND enabled = 1 AND (session_id IS NULL OR session_id = ?)
         ORDER BY created_at ASC`,
        [session.id],
      );
  if (!rules.length) {
    return;
  }

  const normalized = String(payload.text).trim().toLowerCase();
  const matched = rules.find((rule) => matchesAutoReplyRule(rule, normalized));
  if (!matched) {
    return;
  }

  // Kuota harian cuma berlaku untuk user (paket berbayar) — akun admin tidak
  // punya konsep kuota harian.
  if (ownerUserId) {
    const usedToday = await countUserMessagesToday(ownerUserId);
    if (usedToday >= ownerPublic.dailyMessageLimit) {
      logger.warn("Auto-reply dilewati: kuota harian user habis", { user: owner.username });
      return;
    }
  }

  const replyText = renderTemplateContent(matched.replyText, {
    nama: payload.pushName || "",
    nomor: String(payload.from || "").split("@")[0],
  });

  try {
    const { result } = await enqueueMessageSend(session, {
      jid: payload.from,
      content: { text: replyText },
    });

    await dbRun("UPDATE incoming_messages SET auto_replied = 1 WHERE message_id = ? AND session_id = ?", [
      payload.messageId || null,
      session.id,
    ]);

    await recordHistory({
      source: "auto_reply",
      sessionId: session.id,
      to: payload.fromMasked,
      type: "text",
      message: replyText.slice(0, 120),
      status: "sent",
      messageId: result?.key?.id,
    });

    logger.info("Balas otomatis terkirim", { session: session.id, keyword: matched.keyword });
  } catch (error) {
    await recordHistory({
      source: "auto_reply",
      sessionId: session.id,
      to: payload.fromMasked,
      type: "text",
      message: replyText.slice(0, 120),
      status: "failed",
      error: error.message,
    });
  }
}

async function processScheduledMessages() {
  const dueJobs = await listDuePendingJobs(Date.now());
  const due = dueJobs.filter((job) => getSession(job.sessionId)?.isConnected);

  if (!due.length) {
    return;
  }

  for (const job of due) {
    const session = getSession(job.sessionId);

    try {
      if (!session) {
        throw new Error(`Akun WhatsApp '${job.sessionId}' tidak ditemukan`);
      }

      // Jadwal milik user (bukan admin) tetap tunduk pada paket & kuota
      // hariannya SAAT DIKIRIM — bukan saat dijadwalkan. Kalau tidak dicek di
      // sini, user bisa menjadwalkan banyak pesan lalu paketnya kadaluarsa /
      // kuotanya habis, tapi pesannya tetap terkirim.
      if (job.ownerUserId) {
        const ownerRow = await findUserById(job.ownerUserId);
        if (!ownerRow) {
          throw new Error("Pemilik jadwal tidak ditemukan");
        }

        const owner = rowToUser(ownerRow);
        if (owner.planExpired) {
          throw new Error(`Paket ${owner.planLabel} pemilik sudah kadaluarsa`);
        }

        const usedToday = await countUserMessagesToday(job.ownerUserId);
        if (usedToday >= owner.dailyMessageLimit) {
          throw new Error(`Kuota harian pemilik sudah habis (${usedToday}/${owner.dailyMessageLimit})`);
        }
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

      await updateScheduledJob(job.id, {
        status: "sent",
        sentAt: new Date().toISOString(),
        messageId: result?.key?.id ?? null,
      });

      await recordHistory({
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
      await updateScheduledJob(job.id, {
        status: "failed",
        error: error.message,
      });

      await recordHistory({
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

async function loadSessionRegistry() {
  // Hanya sesi berstatus 'active' yang boleh dapat runtime (socket WA & QR).
  // Permintaan 'pending_approval'/'rejected' tetap di tabel sessions tapi
  // tidak ikut dimuat ke Map in-memory sampai di-approve admin.
  const activeStored = await dbAll(
    "SELECT id, name, auth_dir, created_at FROM sessions WHERE status = 'active'",
  );
  const totalCount = (await dbGet("SELECT COUNT(*) AS c FROM sessions")).c;

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

async function bootstrapSessions() {
  const registry = await loadSessionRegistry();

  for (const entry of registry) {
    sessions.set(
      entry.id,
      createSessionRuntime(entry.id, entry.name, entry.authDir, entry.createdAt),
    );
    await dbRun(insertSessionSql, {
      id: entry.id,
      name: entry.name,
      authDir: entry.authDir,
      createdAt: entry.createdAt,
    });
  }
}

async function addSession(name) {
  if (sessions.size >= MAX_ACCOUNTS) {
    throw new Error(`Batas maksimum ${MAX_ACCOUNTS} akun WhatsApp sudah tercapai`);
  }

  const id = uuidv4().split("-")[0];
  const trimmedName = String(name || "").trim() || `Akun ${sessions.size + 1}`;
  const session = createSessionRuntime(id, trimmedName, sessionAuthDirName(id));

  sessions.set(id, session);
  await dbRun(insertSessionSql, {
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
  await dbRun("DELETE FROM sessions WHERE id = ?", [id]);
}

async function removeUserOwnedSession(id, userId) {
  const row = await getSessionRow(id);

  if (!row || row.ownerType !== "user" || row.ownerUserId !== userId) {
    throw new Error("Akun WAG tidak ditemukan");
  }

  const session = sessions.get(id);
  if (session) {
    await teardownSessionSocket(session);
    sessions.delete(id);
  }

  await deleteSessionRow(id);
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

        // Putus permanen (logged out / 401) — reconnect otomatis TIDAK jalan,
        // jadi akunnya diam-diam mati sampai ada yang scan ulang. Kabari
        // pemiliknya sekali di sini supaya tidak baru ketahuan pas mau kirim.
        notifySessionLoggedOut(session).catch((error) => {
          logger.warn("Gagal mengirim notifikasi WAG terputus", {
            session: session.id,
            error: error.message,
          });
        });
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

        const webhookPayload = {
          sessionId: session.id,
          sessionName: session.name,
          from: msg.key.remoteJid,
          fromMasked: maskDestination(msg.key.remoteJid),
          pushName: msg.pushName || null,
          messageId: msg.key.id,
          timestamp: Number(msg.messageTimestamp) * 1000,
          type: Object.keys(msg.message)[0] || "unknown",
          text,
        };

        if (WEBHOOK_URL) {
          dispatchWebhook(webhookPayload);
        }

        dispatchUserWebhook(session.id, webhookPayload).catch((error) => {
          logger.warn("Gagal mengirim webhook user", { session: session.id, error: error.message });
        });

        // Simpan ke inbox + jalankan aturan balas otomatis milik pemilik akun.
        // Sengaja fire-and-forget: kegagalan di sini tidak boleh menghambat
        // pemrosesan pesan masuk berikutnya.
        storeIncomingAndAutoReply(session, msg, webhookPayload).catch((error) => {
          logger.warn("Gagal memproses inbox/auto-reply", {
            session: session.id,
            error: error.message,
          });
        });

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

function renderEyeIcon() {
  return `<svg data-eye-open width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg><svg data-eye-closed class="hidden" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M6.61 6.61A18.42 18.42 0 0 0 1 12s4 8 11 8a9.26 9.26 0 0 0 5.39-1.61"/><path d="M1 1l22 22"/></svg>`;
}

const TOGGLE_PASSWORD_SCRIPT = `document.querySelectorAll('[data-toggle-password]').forEach((button) => {
        button.addEventListener('click', () => {
            const input = document.getElementById(button.dataset.togglePassword);
            if (!input) return;
            const isHidden = input.type === 'password';
            input.type = isHidden ? 'text' : 'password';
            button.querySelector('[data-eye-open]').classList.toggle('hidden', isHidden);
            button.querySelector('[data-eye-closed]').classList.toggle('hidden', !isHidden);
            button.setAttribute('aria-label', isHidden ? 'Sembunyikan password' : 'Tampilkan password');
        });
    });`;

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
                <div class="relative mt-1.5">
                    <input id="loginPassword" name="password" type="password" required
                        class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 pr-10 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                    <button type="button" data-toggle-password="loginPassword" aria-label="Tampilkan password"
                        class="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-400 hover:text-slate-600">
                        ${renderEyeIcon()}
                    </button>
                </div>
            </div>
            <p id="adminLoginError" class="hidden text-xs font-medium text-red-600"></p>
            <button type="submit" class="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Masuk</button>
        </form>

        <p class="mt-4 text-center text-xs text-slate-400">Bukan admin? <a href="/app/login" class="font-semibold text-emerald-700 hover:underline">Login sebagai pengguna</a></p>
    </div>

<script>
    ${TOGGLE_PASSWORD_SCRIPT}
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
                <div class="relative mt-1.5">
                    <input id="userLoginPassword" name="password" type="password" required
                        class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 pr-10 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                    <button type="button" data-toggle-password="userLoginPassword" aria-label="Tampilkan password"
                        class="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-400 hover:text-slate-600">
                        ${renderEyeIcon()}
                    </button>
                </div>
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
                <div class="relative mt-1.5">
                    <input id="userRegisterPassword" name="password" type="password" required minlength="6"
                        class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 pr-10 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                    <button type="button" data-toggle-password="userRegisterPassword" aria-label="Tampilkan password"
                        class="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-400 hover:text-slate-600">
                        ${renderEyeIcon()}
                    </button>
                </div>
            </div>
            <p class="hidden text-xs font-medium text-red-600" data-auth-error></p>
            <button type="submit" class="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Daftar</button>
        </form>

        <p class="mt-4 text-center text-xs text-slate-400">Gratis 1 akun WAG. Butuh lebih? Hubungi admin setelah daftar.</p>
    </div>

<script>
    ${TOGGLE_PASSWORD_SCRIPT}
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
        <aside class="hidden w-60 shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-white sm:flex">
            <div class="flex items-center gap-2.5 border-b border-slate-200 px-5 py-4">
                ${renderBrandMark()}
                <div class="min-w-0">
                    <p class="truncate text-sm font-bold text-slate-900">${escapeHtml(APP_NAME)}</p>
                    <p class="truncate text-xs text-slate-400">Portal Pengguna <span class="text-slate-300">&middot;</span> ${escapeHtml(user.username)}</p>
                </div>
            </div>

            <nav class="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
                <button type="button" data-page-tab="dashboard" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
                    Akun WAG
                </button>
                <button type="button" data-page-tab="test-api" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M9 3h6M10 3v5.5L4.5 18a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 8.5V3"/><path d="M7.5 14h9"/></svg>
                    Uji API
                </button>
                <button type="button" data-page-tab="broadcast" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M4.9 19.1A10 10 0 0 1 4.9 4.9M7.8 16.2a6 6 0 0 1 0-8.4"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M19.1 4.9a10 10 0 0 1 0 14.2"/></svg>
                    Broadcast
                </button>
                <button type="button" data-page-tab="schedule" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                    Pesan Terjadwal
                </button>
                <button type="button" data-page-tab="contacts" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>
                    Kontak &amp; Template
                </button>
                <button type="button" data-page-tab="autoreply" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="m8 10 2 2 4-4"/></svg>
                    Balas Otomatis
                </button>
                <button type="button" data-page-tab="inbox" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
                    Pesan Masuk
                </button>
                <button type="button" data-page-tab="plans" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                    Paket Langganan
                </button>
                <button type="button" data-page-tab="embed" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>
                    Embed Widget QR
                </button>
                <button type="button" data-page-tab="history" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>
                    Riwayat Kirim
                </button>
                <button type="button" data-page-tab="docs" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                    Dokumentasi API
                </button>
            </nav>

            <div class="border-t border-slate-200 p-3">
                <a href="/app/manual" target="_blank" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs font-medium text-slate-500 transition hover:bg-slate-100">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                    Panduan Pengguna
                </a>
                <button id="userLogoutButton" type="button" class="mt-1 flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs font-medium text-red-500 transition hover:bg-red-50">
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

            <main class="min-h-0 flex-1 overflow-y-auto p-4 pb-24 sm:p-6 sm:pb-6">
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

                <section id="page-test-api" class="page-panel mx-auto max-w-2xl hidden">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <div class="flex items-center justify-between gap-2">
                            <h2 class="text-sm font-semibold text-slate-800">Uji API</h2>
                            <p id="testApiQuotaInfo" class="text-xs text-slate-400">Memuat kuota...</p>
                        </div>
                        <p class="mt-1 text-xs text-slate-500">Coba langsung endpoint <code class="rounded bg-slate-100 px-1 py-0.5">POST /api/external/send</code> pakai API key kamu sendiri — persis kayak kalau dipanggil dari kode/aplikasi kamu (lihat tab Dokumentasi API). Request dikirim langsung dari browser, key kamu tidak disimpan di server.</p>

                        <form id="testApiForm" class="mt-3 space-y-3">
                            <div>
                                <label for="testApiKey" class="text-xs font-semibold text-slate-700">API Key</label>
                                <div class="relative mt-1.5">
                                    <input id="testApiKey" type="password" required placeholder="WAG-..."
                                        class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 pr-10 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                                    <button type="button" data-toggle-password="testApiKey" aria-label="Tampilkan API key"
                                        class="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-400 hover:text-slate-600">
                                        ${renderEyeIcon()}
                                    </button>
                                </div>
                            </div>
                            <div>
                                <label class="text-xs font-semibold text-slate-700">Kirim Dari Akun <span class="font-normal text-slate-400">(opsional)</span></label>
                                <select id="testApiSession" class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm">
                                    <option value="">Otomatis (akun aktif pertama)</option>
                                </select>
                            </div>
                            <div>
                                <div class="flex items-center justify-between gap-2">
                                    <label class="text-xs font-semibold text-slate-700">Nomor Tujuan</label>
                                    <select id="testApiContact" class="rounded-lg border border-slate-200 px-2 py-1 text-xs">
                                        <option value="">Pilih dari kontak...</option>
                                    </select>
                                </div>
                                <input id="testApiNumber" type="text" required placeholder="mis. 628123456789"
                                    class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            </div>
                            <div>
                                <div class="flex items-center justify-between gap-2">
                                    <label class="text-xs font-semibold text-slate-700">Pesan</label>
                                    <select id="testApiTemplate" class="rounded-lg border border-slate-200 px-2 py-1 text-xs">
                                        <option value="">Pakai template...</option>
                                    </select>
                                </div>
                                <textarea id="testApiMessage" rows="3" required
                                    class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"></textarea>
                            </div>
                            <button id="testApiButton" type="submit" class="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Uji Kirim</button>
                        </form>

                        <div class="mt-4">
                            <div class="rounded-t-lg bg-slate-900 px-3 py-1.5">
                                <span class="text-xs font-medium text-slate-400">Response</span>
                            </div>
                            <pre id="testApiResult" class="overflow-auto rounded-b-lg bg-slate-950 px-3 py-3 text-xs leading-relaxed text-slate-400">Belum ada percobaan.</pre>
                        </div>

                        <p class="mt-3 text-[11px] text-slate-400">Lupa/belum punya API key? Buka tab Dokumentasi API dan klik "Minta API Key ke Admin lewat WhatsApp".</p>
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

                <section id="page-broadcast" class="page-panel mx-auto max-w-2xl hidden">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <div class="flex items-center justify-between gap-2">
                            <h2 class="text-sm font-semibold text-slate-800">Broadcast Pesan</h2>
                            <p id="broadcastQuota" class="text-xs text-slate-400">Memuat kuota...</p>
                        </div>
                        <p class="mt-1 text-xs text-slate-500">Kirim satu pesan ke banyak nomor sekaligus lewat antrean internal (tidak flood). Pakai <code class="rounded bg-slate-100 px-1 py-0.5">{{nama}}</code> untuk menyapa tiap kontak dengan namanya — hanya berlaku untuk tujuan dari grup kontak.</p>

                        <div id="broadcastAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

                        <form id="broadcastForm" class="mt-3 space-y-3">
                            <div class="grid gap-3 sm:grid-cols-2">
                                <div>
                                    <label class="text-xs font-semibold text-slate-700">Kirim Dari Akun</label>
                                    <select id="broadcastSession" class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm">
                                        <option value="">Otomatis (akun aktif pertama)</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="text-xs font-semibold text-slate-700">Grup Kontak <span class="font-normal text-slate-400">(opsional)</span></label>
                                    <select id="broadcastGroup" class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm">
                                        <option value="">— tidak pakai grup —</option>
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label class="text-xs font-semibold text-slate-700">Nomor Tujuan Manual <span class="font-normal text-slate-400">(opsional kalau sudah pilih grup)</span></label>
                                <textarea id="broadcastNumbers" rows="3" placeholder="628123456789, 628987654321&#10;atau satu nomor per baris"
                                    class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"></textarea>
                            </div>
                            <div>
                                <div class="flex items-center justify-between gap-2">
                                    <label class="text-xs font-semibold text-slate-700">Pesan</label>
                                    <select id="broadcastTemplate" class="rounded-lg border border-slate-200 px-2 py-1 text-xs">
                                        <option value="">Pakai template...</option>
                                    </select>
                                </div>
                                <textarea id="broadcastMessage" rows="4" required placeholder="Halo {{nama}}, ada promo spesial!"
                                    class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"></textarea>
                            </div>
                            <button id="broadcastButton" type="submit" class="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Kirim Broadcast</button>
                        </form>
                    </div>
                </section>

                <section id="page-schedule" class="page-panel mx-auto max-w-3xl hidden">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Jadwalkan Pesan</h2>
                        <p class="mt-1 text-xs text-slate-500">Pesan dikirim otomatis pada waktu yang kamu tentukan. Kuota &amp; masa aktif paket dicek ulang saat pesan benar-benar dikirim.</p>

                        <div id="scheduleAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

                        <form id="scheduleForm" class="mt-3 space-y-3">
                            <div class="grid gap-3 sm:grid-cols-3">
                                <div>
                                    <label class="text-xs font-semibold text-slate-700">Dari Akun</label>
                                    <select id="scheduleSession" class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm">
                                        <option value="">Otomatis</option>
                                    </select>
                                </div>
                                <div>
                                    <div class="flex items-center justify-between gap-2">
                                        <label class="text-xs font-semibold text-slate-700">Nomor Tujuan</label>
                                        <select id="scheduleContact" class="rounded-lg border border-slate-200 px-2 py-1 text-xs">
                                            <option value="">Pilih kontak...</option>
                                        </select>
                                    </div>
                                    <input id="scheduleNumber" type="text" required placeholder="628123456789"
                                        class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                                </div>
                                <div>
                                    <label class="text-xs font-semibold text-slate-700">Waktu Kirim</label>
                                    <input id="scheduleSendAt" type="datetime-local" required
                                        class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                                </div>
                            </div>
                            <div>
                                <div class="flex items-center justify-between gap-2">
                                    <label class="text-xs font-semibold text-slate-700">Pesan</label>
                                    <select id="scheduleTemplate" class="rounded-lg border border-slate-200 px-2 py-1 text-xs">
                                        <option value="">Pakai template...</option>
                                    </select>
                                </div>
                                <textarea id="scheduleMessage" rows="3" required
                                    class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"></textarea>
                            </div>
                            <button id="scheduleButton" type="submit" class="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Jadwalkan</button>
                        </form>
                    </div>

                    <div class="mt-4 rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Daftar Pesan Terjadwal</h2>
                        <div class="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                            <table class="w-full text-sm">
                                <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        <th class="px-3 py-2 text-left">Waktu Kirim</th>
                                        <th class="px-3 py-2 text-left">Tujuan</th>
                                        <th class="px-3 py-2 text-left">Pesan</th>
                                        <th class="px-3 py-2 text-left">Status</th>
                                        <th class="px-3 py-2 text-right">Aksi</th>
                                    </tr>
                                </thead>
                                <tbody id="scheduleTableBody" class="divide-y divide-slate-200">
                                    <tr><td class="px-3 py-3 text-slate-400" colspan="5">Memuat...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>

                <section id="page-contacts" class="page-panel mx-auto max-w-3xl hidden">
                    <div class="flex gap-1.5 rounded-xl bg-slate-100 p-1.5">
                        <button type="button" data-contacts-tab="contacts" class="contacts-tab flex-1 rounded-lg py-2 text-sm font-semibold transition">Kontak</button>
                        <button type="button" data-contacts-tab="templates" class="contacts-tab flex-1 rounded-lg py-2 text-sm font-semibold transition">Template Pesan</button>
                    </div>

                    <div id="contactsView" class="mt-4">
                        <div class="rounded-xl border border-slate-200 bg-white p-4">
                            <h2 class="text-sm font-semibold text-slate-800">Tambah Kontak</h2>
                            <div id="contactsAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>
                            <form id="contactForm" class="mt-3 grid gap-3 sm:grid-cols-4">
                                <input id="contactName" type="text" required placeholder="Nama"
                                    class="rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                                <input id="contactPhone" type="text" required placeholder="628123456789"
                                    class="rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                                <input id="contactGroup" type="text" placeholder="Grup (opsional)"
                                    class="rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                                <button type="submit" class="rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Tambah</button>
                            </form>

                            <details class="mt-3 group">
                                <summary class="cursor-pointer list-none rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600 marker:content-none [&amp;::-webkit-details-marker]:hidden">
                                    <span class="inline-block transition-transform group-open:rotate-90">▸</span> Import banyak kontak sekaligus
                                </summary>
                                <div class="mt-2 space-y-2">
                                    <textarea id="contactImportData" rows="4" placeholder="Budi,628111111111&#10;Siti,628222222222"
                                        class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"></textarea>
                                    <div class="flex gap-2">
                                        <input id="contactImportGroup" type="text" placeholder="Masukkan ke grup (opsional)"
                                            class="flex-1 rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm">
                                        <button id="contactImportButton" type="button" class="shrink-0 rounded-xl bg-slate-800 px-4 text-sm font-semibold text-white hover:bg-slate-900 transition">Import</button>
                                    </div>
                                    <p class="text-[11px] text-slate-400">Satu baris = satu kontak, format <code>Nama,Nomor</code>. Maksimum 1000 baris. Nomor duplikat otomatis dilewati.</p>
                                </div>
                            </details>
                        </div>

                        <div class="mt-4 rounded-xl border border-slate-200 bg-white p-4">
                            <div class="flex items-center justify-between gap-2">
                                <h2 class="text-sm font-semibold text-slate-800">Daftar Kontak</h2>
                                <p id="contactsCount" class="text-xs text-slate-400"></p>
                            </div>
                            <div class="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                                <table class="w-full text-sm">
                                    <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                        <tr><th class="px-3 py-2 text-left">Nama</th><th class="px-3 py-2 text-left">Nomor</th><th class="px-3 py-2 text-left">Grup</th><th class="px-3 py-2 text-right">Aksi</th></tr>
                                    </thead>
                                    <tbody id="contactsTableBody" class="divide-y divide-slate-200">
                                        <tr><td class="px-3 py-3 text-slate-400" colspan="4">Memuat...</td></tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>

                    <div id="templatesView" class="mt-4 hidden">
                        <div class="rounded-xl border border-slate-200 bg-white p-4">
                            <h2 class="text-sm font-semibold text-slate-800">Buat Template</h2>
                            <p class="mt-1 text-xs text-slate-500">Simpan pesan yang sering dipakai. Placeholder <code class="rounded bg-slate-100 px-1 py-0.5">{{nama}}</code> otomatis diganti nama kontak saat broadcast ke grup.</p>
                            <div id="templatesAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>
                            <form id="templateForm" class="mt-3 space-y-3">
                                <input id="templateName" type="text" required placeholder="Nama template (mis. Promo Bulanan)"
                                    class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                                <textarea id="templateContent" rows="3" required placeholder="Halo {{nama}}, ada promo spesial buat kamu!"
                                    class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"></textarea>
                                <button type="submit" class="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Simpan Template</button>
                            </form>
                        </div>

                        <div class="mt-4 rounded-xl border border-slate-200 bg-white p-4">
                            <h2 class="text-sm font-semibold text-slate-800">Template Tersimpan</h2>
                            <div id="templatesList" class="mt-3 space-y-2">
                                <p class="text-sm text-slate-400">Memuat...</p>
                            </div>
                        </div>
                    </div>
                </section>

                <section id="page-autoreply" class="page-panel mx-auto max-w-3xl hidden">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <h2 id="autoReplyFormTitle" class="text-sm font-semibold text-slate-800">Balas Otomatis</h2>
                        <p class="mt-1 text-xs text-slate-500">Kalau ada pesan masuk yang cocok dengan kata kunci, sistem otomatis membalas. Balasan tetap memakai kuota harian paket kamu. Pakai <code class="rounded bg-slate-100 px-1 py-0.5">{{nama}}</code> untuk menyapa pengirim.</p>

                        <div id="autoReplyAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

                        <form id="autoReplyForm" class="mt-3 space-y-3">
                            <input type="hidden" id="autoReplyEditingId" value="">
                            <div class="grid gap-3 sm:grid-cols-3">
                                <div>
                                    <label class="text-xs font-semibold text-slate-700">Kata Kunci</label>
                                    <input id="autoReplyKeyword" type="text" required placeholder="mis. harga"
                                        class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                                </div>
                                <div>
                                    <label class="text-xs font-semibold text-slate-700">Cara Cocok</label>
                                    <select id="autoReplyMatchType" class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm">
                                        <option value="contains">Mengandung kata</option>
                                        <option value="exact">Sama persis</option>
                                        <option value="starts">Diawali kata</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="text-xs font-semibold text-slate-700">Berlaku di Akun</label>
                                    <select id="autoReplySession" class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm">
                                        <option value="">Semua akun WAG saya</option>
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label class="text-xs font-semibold text-slate-700">Isi Balasan</label>
                                <textarea id="autoReplyText" rows="3" required placeholder="Halo {{nama}}, ini daftar harga kami: ..."
                                    class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"></textarea>
                            </div>
                            <div class="flex gap-2">
                                <button id="autoReplySubmitButton" type="submit" class="flex-1 rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Tambah Aturan</button>
                                <button id="autoReplyCancelEditButton" type="button" class="hidden shrink-0 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-200 transition">Batal</button>
                            </div>
                        </form>
                    </div>

                    <div class="mt-4 rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Aturan Aktif</h2>
                        <div id="autoRepliesList" class="mt-3 space-y-2">
                            <p class="text-sm text-slate-400">Memuat...</p>
                        </div>
                    </div>
                </section>

                <section id="page-inbox" class="page-panel mx-auto max-w-3xl hidden">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <h2 class="text-sm font-semibold text-slate-800">Pesan Masuk</h2>
                                <p class="mt-1 text-xs text-slate-500">Pesan WhatsApp yang masuk ke akun WAG kamu. Tanda ✓ berarti sudah dibalas otomatis.</p>
                            </div>
                            <p id="inboxTotal" class="text-xs text-slate-400">Memuat...</p>
                        </div>
                        <div class="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                            <table class="w-full text-sm">
                                <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        <th class="px-3 py-2 text-left">Waktu</th>
                                        <th class="px-3 py-2 text-left">Dari</th>
                                        <th class="px-3 py-2 text-left">Akun</th>
                                        <th class="px-3 py-2 text-left">Pesan</th>
                                        <th class="px-3 py-2 text-left">Auto</th>
                                    </tr>
                                </thead>
                                <tbody id="inboxTableBody" class="divide-y divide-slate-200">
                                    <tr><td class="px-3 py-3 text-slate-400" colspan="5">Memuat...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>

                <section id="page-history" class="page-panel mx-auto max-w-3xl hidden">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <h2 class="text-sm font-semibold text-slate-800">Statistik Penggunaan</h2>
                            <select id="analyticsRange" class="rounded-lg border border-slate-200 px-2 py-1 text-xs">
                                <option value="7">7 hari terakhir</option>
                                <option value="14" selected>14 hari terakhir</option>
                                <option value="30">30 hari terakhir</option>
                            </select>
                        </div>
                        <div id="analyticsTotals" class="mt-3 grid gap-3 sm:grid-cols-3">
                            <p class="text-sm text-slate-400 sm:col-span-3">Memuat...</p>
                        </div>
                        <div id="analyticsChart" class="mt-4 flex h-32 items-end gap-1 border-b border-l border-slate-200 pb-1 pl-1"></div>
                        <p class="mt-1.5 text-[11px] text-slate-400">Batang hijau = terkirim, merah = gagal, biru = pesan masuk.</p>
                    </div>

                    <div class="mt-4 rounded-xl border border-slate-200 bg-white p-4">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <h2 class="text-sm font-semibold text-slate-800">Riwayat Kirim</h2>
                                <p class="mt-1 text-xs text-slate-500">Pesan yang pernah dikirim lewat akun WAG kamu — dari portal, API, maupun terjadwal. Berguna buat cek mana yang gagal saat debug integrasi.</p>
                            </div>
                            <div class="flex items-center gap-2">
                                <p id="myHistoryTotal" class="text-xs text-slate-400">Memuat...</p>
                                <a id="exportHistoryButton" href="/api/my/history/export" class="inline-flex h-8 items-center justify-center rounded-lg bg-slate-100 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-200 transition">Export CSV</a>
                            </div>
                        </div>

                        <div class="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                            <table class="w-full text-sm">
                                <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                    <tr>
                                        <th class="px-3 py-2 text-left">Waktu</th>
                                        <th class="px-3 py-2 text-left">Akun</th>
                                        <th class="px-3 py-2 text-left">Tujuan</th>
                                        <th class="px-3 py-2 text-left">Pesan</th>
                                        <th class="px-3 py-2 text-left">Sumber</th>
                                        <th class="px-3 py-2 text-left">Status</th>
                                    </tr>
                                </thead>
                                <tbody id="myHistoryTableBody" class="divide-y divide-slate-200">
                                    <tr><td class="px-3 py-3 text-slate-400" colspan="6">Memuat...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>

                <section id="page-docs" class="page-panel mx-auto max-w-2xl hidden">
                    <div class="flex gap-1.5 rounded-xl bg-slate-100 p-1.5">
                        <button type="button" data-docs-tab="setup" class="docs-tab flex-1 rounded-lg py-2 text-sm font-semibold transition">Pengaturan API</button>
                        <button type="button" data-docs-tab="reference" class="docs-tab flex-1 rounded-lg py-2 text-sm font-semibold transition">Referensi Endpoint</button>
                    </div>

                    <div id="docsSetupView" class="mt-4">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">API Key Kamu</h2>
                        <p class="mt-1 text-xs text-slate-500">Dipakai buat autentikasi endpoint kirim pesan lewat kode/aplikasi kamu sendiri (header <code class="rounded bg-slate-100 px-1 py-0.5">x-api-key</code>). Berlaku untuk semua paket (Free/Pro/Max) — kuota kirim/hari tetap ikut paket kamu.</p>
                        <p class="mt-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">⚠️ Key lengkap <strong>cuma dikirim lewat WhatsApp</strong> ke nomor terdaftar kamu — tidak pernah ditampilkan di halaman ini, supaya tidak tersimpan di riwayat browser. Simpan baik-baik begitu diterima &amp; <strong>jangan bagikan ke siapa pun</strong> — siapa saja yang punya key ini bisa kirim pesan atas nama akun kamu.</p>

                        <div id="apiKeyAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

                        <div class="mt-3 flex items-center justify-between gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-3">
                            <div class="min-w-0">
                                <div class="flex items-center gap-1.5">
                                    <p id="apiKeyStatusLabel" class="truncate text-sm font-semibold text-slate-700">Memuat...</p>
                                    <button id="copyApiKeyPrefixButton" type="button" title="Salin prefix key" class="hidden shrink-0 text-slate-400 hover:text-slate-600">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                    </button>
                                </div>
                                <p id="apiKeyStatusSub" class="text-xs text-slate-400"></p>
                            </div>
                        </div>
                        <p class="mt-1.5 text-[11px] text-slate-400">Baris di atas cuma prefix (buat identifikasi key yang aktif), bukan key lengkap. Butuh key baru? Minta admin lewat tombol di bawah — kamu tidak bisa generate sendiri.</p>

                        <button id="chatAdminApiKeyButton" type="button" class="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.15 2 11.27c0 2.62 1.18 5 3.11 6.7-.1 1.02-.4 2.6-1.11 3.94 1.6-.14 3.34-.7 4.55-1.42 1.09.32 2.26.5 3.45.5 5.52 0 10-4.15 10-9.27C22 6.15 17.52 2 12 2z"/></svg>
                            Minta API Key ke Admin lewat WhatsApp
                        </button>
                    </div>

                    <div class="mt-5 rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Webhook Pesan Masuk</h2>
                        <p class="mt-1 text-xs text-slate-500">Setiap ada pesan WhatsApp <strong>masuk</strong> ke akun WAG kamu, sistem akan otomatis kirim <code class="rounded bg-slate-100 px-1 py-0.5">POST</code> berisi JSON ke URL ini. Cocok buat auto-reply, simpan chat ke database kamu, atau integrasi CRM. Kosongkan URL untuk menonaktifkan.</p>

                        <div id="webhookAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

                        <form id="webhookForm" class="mt-3 space-y-3">
                            <div class="grid gap-3 sm:grid-cols-2">
                                <div>
                                    <label for="webhookUrl" class="text-xs font-semibold text-slate-700">URL Webhook</label>
                                    <input id="webhookUrl" type="text" placeholder="https://sistemkamu.com/webhook/wa"
                                        class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                                </div>
                                <div>
                                    <label for="webhookSecret" class="text-xs font-semibold text-slate-700">Secret <span class="font-normal text-slate-400">(opsional, buat verifikasi request)</span></label>
                                    <div class="relative mt-1.5">
                                        <input id="webhookSecret" type="password" placeholder="Header x-webhook-secret"
                                            class="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 pr-10 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                                        <button type="button" data-toggle-password="webhookSecret" aria-label="Tampilkan secret"
                                            class="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-400 hover:text-slate-600">
                                            ${renderEyeIcon()}
                                        </button>
                                    </div>
                                </div>
                            </div>
                            <button id="webhookSaveButton" type="submit" class="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Simpan Webhook</button>
                        </form>

                        <details class="mt-4 group">
                            <summary class="cursor-pointer list-none rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 marker:content-none [&::-webkit-details-marker]:hidden">
                                <span class="inline-block transition-transform group-open:rotate-90">▸</span> Contoh JSON yang dikirim ke URL kamu
                            </summary>
                            <pre class="overflow-auto rounded-b-lg bg-slate-950 px-3 py-3 text-xs leading-relaxed text-emerald-300"><code>{
  "sessionId": "abc123",
  "sessionName": "WAG Toko Saya",
  "from": "628123456789@s.whatsapp.net",
  "pushName": "Budi",
  "messageId": "3EB0...",
  "timestamp": 1755000000000,
  "type": "conversation",
  "text": "Halo, masih ada stoknya?"
}</code></pre>
                        </details>
                    </div>
                    </div>

                    <div id="docsReferenceView" class="mt-4 hidden">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Referensi Endpoint</h2>
                        <p class="mt-1 text-xs text-slate-500">Endpoint kirim pesan wajib pakai API key kamu sendiri (header <code class="rounded bg-slate-100 px-1 py-0.5">x-api-key</code>, lihat tab "Pengaturan API"). Endpoint status/QR bersifat publik (tidak butuh key) — dipakai widget embed, tapi bisa juga kamu panggil sendiri. Klik tiap endpoint buat lihat detail &amp; contoh <code class="rounded bg-slate-100 px-1 py-0.5">curl</code>-nya. Ganti <code class="rounded bg-slate-100 px-1 py-0.5">SESSION_ID</code> dengan ID akun WAG kamu (lihat tabel di bawah).</p>

                        <details class="mt-3 group">
                            <summary class="cursor-pointer list-none rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600 marker:content-none [&::-webkit-details-marker]:hidden">
                                <span class="inline-block transition-transform group-open:rotate-90">▸</span> Daftar Session ID akun WAG kamu
                            </summary>
                            <div id="docsSessionTableWrap" class="mt-2 overflow-x-auto rounded-xl border border-slate-200">
                                <table class="w-full text-sm">
                                    <thead class="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                                        <tr><th class="px-4 py-2 text-left">Nama Akun</th><th class="px-4 py-2 text-left">Session ID</th></tr>
                                    </thead>
                                    <tbody id="docsSessionTableBody" class="divide-y divide-slate-200">
                                        <tr><td class="px-4 py-3 text-slate-400" colspan="2">Memuat...</td></tr>
                                    </tbody>
                                </table>
                            </div>
                        </details>

                        <details class="doc-endpoint mt-3 group rounded-xl border border-slate-200">
                            <summary class="flex cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-2.5 marker:content-none [&::-webkit-details-marker]:hidden group-open:rounded-b-none group-open:border-b group-open:border-slate-200">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-slate-400 transition-transform group-open:rotate-90"><path d="m9 18 6-6-6-6"/></svg>
                                <span class="rounded-md bg-blue-100 px-2.5 py-1 text-xs font-bold tracking-wide text-blue-700">POST</span>
                                <code class="text-sm font-semibold text-slate-800">/api/external/send</code>
                                <span class="ml-auto shrink-0 text-xs text-slate-400">Kirim teks</span>
                            </summary>
                            <div class="p-3">
                                <p class="text-xs text-slate-500">Kirim pesan teks WhatsApp pakai API key kamu sendiri. Parameter <code class="rounded bg-slate-100 px-1 py-0.5">session</code> opsional — kosongkan untuk otomatis pakai akun WAG aktif pertama kamu. Kuota kirim/hari tetap ikut paket kamu (lihat tab Paket Langganan).</p>
                                <div class="mt-2 flex items-center justify-between rounded-t-lg bg-slate-900 px-3 py-1.5">
                                    <span class="text-xs font-medium text-slate-400">curl</span>
                                    <button type="button" data-copy-target="curlExternalSend" class="doc-copy-btn text-xs font-medium text-slate-400 hover:text-white transition">Salin</button>
                                </div>
                                <pre class="overflow-auto rounded-b-lg bg-slate-950 px-3 py-3 text-xs leading-relaxed text-emerald-300"><code id="curlExternalSend"></code></pre>
                            </div>
                        </details>

                        <details class="doc-endpoint mt-2 group rounded-xl border border-slate-200">
                            <summary class="flex cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-2.5 marker:content-none [&::-webkit-details-marker]:hidden group-open:rounded-b-none group-open:border-b group-open:border-slate-200">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-slate-400 transition-transform group-open:rotate-90"><path d="m9 18 6-6-6-6"/></svg>
                                <span class="rounded-md bg-blue-100 px-2.5 py-1 text-xs font-bold tracking-wide text-blue-700">POST</span>
                                <code class="text-sm font-semibold text-slate-800">/api/external/send-file</code>
                                <span class="ml-auto shrink-0 text-xs text-slate-400">Kirim file</span>
                            </summary>
                            <div class="p-3">
                                <p class="text-xs text-slate-500">Kirim gambar, video, audio, atau dokumen (PDF dll). Body-nya <code class="rounded bg-slate-100 px-1 py-0.5">multipart/form-data</code>, bukan JSON. Jenis pesan WA ditentukan otomatis dari tipe file-nya. <code class="rounded bg-slate-100 px-1 py-0.5">caption</code> &amp; <code class="rounded bg-slate-100 px-1 py-0.5">session</code> opsional.</p>
                                <div class="mt-2 flex items-center justify-between rounded-t-lg bg-slate-900 px-3 py-1.5">
                                    <span class="text-xs font-medium text-slate-400">curl</span>
                                    <button type="button" data-copy-target="curlExternalSendFile" class="doc-copy-btn text-xs font-medium text-slate-400 hover:text-white transition">Salin</button>
                                </div>
                                <pre class="overflow-auto rounded-b-lg bg-slate-950 px-3 py-3 text-xs leading-relaxed text-emerald-300"><code id="curlExternalSendFile"></code></pre>
                            </div>
                        </details>

                        <details class="doc-endpoint mt-2 group rounded-xl border border-slate-200">
                            <summary class="flex cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-2.5 marker:content-none [&::-webkit-details-marker]:hidden group-open:rounded-b-none group-open:border-b group-open:border-slate-200">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-slate-400 transition-transform group-open:rotate-90"><path d="m9 18 6-6-6-6"/></svg>
                                <span class="rounded-md bg-blue-100 px-2.5 py-1 text-xs font-bold tracking-wide text-blue-700">POST</span>
                                <code class="text-sm font-semibold text-slate-800">/api/external/broadcast</code>
                                <span class="ml-auto shrink-0 text-xs text-slate-400">Broadcast</span>
                            </summary>
                            <div class="p-3">
                                <p class="text-xs text-slate-500">Kirim satu pesan ke banyak nomor. Isi <code class="rounded bg-slate-100 px-1 py-0.5">numbers</code> (dipisah koma/baris baru) dan/atau <code class="rounded bg-slate-100 px-1 py-0.5">contactGroup</code> (nama grup kontak kamu). Placeholder <code class="rounded bg-slate-100 px-1 py-0.5">{{nama}}</code> otomatis diisi nama kontak. Kuota dipotong sebanyak jumlah tujuan.</p>
                                <div class="mt-2 flex items-center justify-between rounded-t-lg bg-slate-900 px-3 py-1.5">
                                    <span class="text-xs font-medium text-slate-400">curl</span>
                                    <button type="button" data-copy-target="curlExternalBroadcast" class="doc-copy-btn text-xs font-medium text-slate-400 hover:text-white transition">Salin</button>
                                </div>
                                <pre class="overflow-auto rounded-b-lg bg-slate-950 px-3 py-3 text-xs leading-relaxed text-emerald-300"><code id="curlExternalBroadcast"></code></pre>
                            </div>
                        </details>

                        <details class="doc-endpoint mt-2 group rounded-xl border border-slate-200">
                            <summary class="flex cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-2.5 marker:content-none [&::-webkit-details-marker]:hidden group-open:rounded-b-none group-open:border-b group-open:border-slate-200">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-slate-400 transition-transform group-open:rotate-90"><path d="m9 18 6-6-6-6"/></svg>
                                <span class="rounded-md bg-blue-100 px-2.5 py-1 text-xs font-bold tracking-wide text-blue-700">POST</span>
                                <code class="text-sm font-semibold text-slate-800">/api/external/schedule</code>
                                <span class="ml-auto shrink-0 text-xs text-slate-400">Jadwalkan</span>
                            </summary>
                            <div class="p-3">
                                <p class="text-xs text-slate-500">Jadwalkan pesan untuk dikirim nanti. <code class="rounded bg-slate-100 px-1 py-0.5">sendAt</code> format ISO 8601 dan harus di masa depan. Kuota &amp; masa aktif paket dicek ulang saat pesan benar-benar dikirim.</p>
                                <div class="mt-2 flex items-center justify-between rounded-t-lg bg-slate-900 px-3 py-1.5">
                                    <span class="text-xs font-medium text-slate-400">curl</span>
                                    <button type="button" data-copy-target="curlExternalSchedule" class="doc-copy-btn text-xs font-medium text-slate-400 hover:text-white transition">Salin</button>
                                </div>
                                <pre class="overflow-auto rounded-b-lg bg-slate-950 px-3 py-3 text-xs leading-relaxed text-emerald-300"><code id="curlExternalSchedule"></code></pre>
                            </div>
                        </details>

                        <details class="doc-endpoint mt-2 group rounded-xl border border-slate-200">
                            <summary class="flex cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-2.5 marker:content-none [&::-webkit-details-marker]:hidden group-open:rounded-b-none group-open:border-b group-open:border-slate-200">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-slate-400 transition-transform group-open:rotate-90"><path d="m9 18 6-6-6-6"/></svg>
                                <span class="rounded-md bg-emerald-100 px-2.5 py-1 text-xs font-bold tracking-wide text-emerald-700">GET</span>
                                <code class="text-sm font-semibold text-slate-800">/api/status</code>
                                <span class="ml-auto shrink-0 text-xs text-slate-400">Status koneksi</span>
                            </summary>
                            <div class="p-3">
                                <p class="text-xs text-slate-500">Status koneksi akun WAG (terhubung/menunggu QR/dsb). Publik, tidak butuh API key.</p>
                                <div class="mt-2 flex items-center justify-between rounded-t-lg bg-slate-900 px-3 py-1.5">
                                    <span class="text-xs font-medium text-slate-400">curl</span>
                                    <button type="button" data-copy-target="curlStatus" class="doc-copy-btn text-xs font-medium text-slate-400 hover:text-white transition">Salin</button>
                                </div>
                                <pre class="overflow-auto rounded-b-lg bg-slate-950 px-3 py-3 text-xs leading-relaxed text-emerald-300"><code id="curlStatus"></code></pre>
                            </div>
                        </details>

                        <details class="doc-endpoint mt-2 group rounded-xl border border-slate-200">
                            <summary class="flex cursor-pointer list-none items-center gap-3 rounded-xl px-3 py-2.5 marker:content-none [&::-webkit-details-marker]:hidden group-open:rounded-b-none group-open:border-b group-open:border-slate-200">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-slate-400 transition-transform group-open:rotate-90"><path d="m9 18 6-6-6-6"/></svg>
                                <span class="rounded-md bg-emerald-100 px-2.5 py-1 text-xs font-bold tracking-wide text-emerald-700">GET</span>
                                <code class="text-sm font-semibold text-slate-800">/api/qr</code>
                                <span class="ml-auto shrink-0 text-xs text-slate-400">Kode QR</span>
                            </summary>
                            <div class="p-3">
                                <p class="text-xs text-slate-500">Kode QR (data URL base64) untuk dipindai, kalau akunnya belum terhubung. Publik, tidak butuh API key.</p>
                                <div class="mt-2 flex items-center justify-between rounded-t-lg bg-slate-900 px-3 py-1.5">
                                    <span class="text-xs font-medium text-slate-400">curl</span>
                                    <button type="button" data-copy-target="curlQr" class="doc-copy-btn text-xs font-medium text-slate-400 hover:text-white transition">Salin</button>
                                </div>
                                <pre class="overflow-auto rounded-b-lg bg-slate-950 px-3 py-3 text-xs leading-relaxed text-emerald-300"><code id="curlQr"></code></pre>
                            </div>
                        </details>

                        <p class="mt-3 text-xs text-slate-400">Lupa API key kamu? Buka tab "Pengaturan API" dan klik tombol chat WhatsApp ke admin — kamu tidak bisa generate sendiri.</p>
                    </div>
                    </div>
                </section>
            </main>

            <nav class="fixed inset-x-0 bottom-0 z-20 flex items-stretch justify-around border-t border-slate-200 bg-white shadow-[0_-2px_8px_rgba(0,0,0,0.04)] sm:hidden">
                <button type="button" data-page-tab="dashboard" class="page-tab flex flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[11px] font-medium transition">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>
                    Akun
                </button>
                <button type="button" data-page-tab="broadcast" class="page-tab flex flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[11px] font-medium transition">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M4.9 19.1A10 10 0 0 1 4.9 4.9M7.8 16.2a6 6 0 0 1 0-8.4"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M19.1 4.9a10 10 0 0 1 0 14.2"/></svg>
                    Broadcast
                </button>
                <button type="button" data-page-tab="schedule" class="page-tab flex flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[11px] font-medium transition">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                    Terjadwal
                </button>
                <button type="button" data-page-tab="contacts" class="page-tab flex flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[11px] font-medium transition">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>
                    Kontak
                </button>
                <button type="button" id="moreNavButton" class="flex flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[11px] font-medium text-slate-600 transition">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
                    Lainnya
                </button>
            </nav>

            <div id="moreSheetBackdrop" class="fixed inset-0 z-30 hidden bg-slate-900/40 sm:hidden"></div>
            <div id="moreSheet" class="fixed inset-x-0 bottom-0 z-40 hidden max-h-[70vh] translate-y-full overflow-y-auto rounded-t-2xl bg-white p-4 shadow-2xl transition-transform duration-200 sm:hidden">
                <div id="moreSheetHandle" class="-mx-4 -mt-4 cursor-grab touch-none select-none px-4 pt-3 pb-2 active:cursor-grabbing">
                    <div class="mx-auto mb-3 h-1.5 w-10 rounded-full bg-slate-200"></div>
                    <p class="mb-3 text-xs font-semibold text-slate-400">Menu Lainnya</p>
                </div>
                <div class="grid grid-cols-3 gap-3 pb-4">
                    <button type="button" data-page-tab="test-api" class="page-tab more-tab flex flex-col items-center gap-1.5 rounded-xl border border-slate-100 p-3 text-center text-[11px] font-medium transition">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M9 3h6M10 3v5.5L4.5 18a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 8.5V3"/><path d="M7.5 14h9"/></svg>
                        Uji API
                    </button>
                    <button type="button" data-page-tab="autoreply" class="page-tab more-tab flex flex-col items-center gap-1.5 rounded-xl border border-slate-100 p-3 text-center text-[11px] font-medium transition">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="m8 10 2 2 4-4"/></svg>
                        Balas Otomatis
                    </button>
                    <button type="button" data-page-tab="inbox" class="page-tab more-tab flex flex-col items-center gap-1.5 rounded-xl border border-slate-100 p-3 text-center text-[11px] font-medium transition">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
                        Pesan Masuk
                    </button>
                    <button type="button" data-page-tab="plans" class="page-tab more-tab flex flex-col items-center gap-1.5 rounded-xl border border-slate-100 p-3 text-center text-[11px] font-medium transition">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                        Paket
                    </button>
                    <button type="button" data-page-tab="embed" class="page-tab more-tab flex flex-col items-center gap-1.5 rounded-xl border border-slate-100 p-3 text-center text-[11px] font-medium transition">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>
                        Embed QR
                    </button>
                    <button type="button" data-page-tab="history" class="page-tab more-tab flex flex-col items-center gap-1.5 rounded-xl border border-slate-100 p-3 text-center text-[11px] font-medium transition">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>
                        Riwayat
                    </button>
                    <button type="button" data-page-tab="docs" class="page-tab more-tab flex flex-col items-center gap-1.5 rounded-xl border border-slate-100 p-3 text-center text-[11px] font-medium transition">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                        Dokumentasi
                    </button>
                    <a href="/app/manual" target="_blank" class="flex flex-col items-center gap-1.5 rounded-xl border border-slate-100 p-3 text-center text-[11px] font-medium text-slate-700 transition">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                        Panduan
                    </a>
                    <button type="button" id="moreLogoutButton" class="flex flex-col items-center gap-1.5 rounded-xl border border-slate-100 p-3 text-center text-[11px] font-medium text-red-500 transition">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>
                        Keluar
                    </button>
                </div>
            </div>
        </div>
    </div>

<script>
    const pollIntervalMs = ${STATUS_POLL_INTERVAL_MS};
    const publicBaseUrl = ${JSON.stringify(PUBLIC_BASE_URL)};
    const currentUser = ${JSON.stringify({ username: user.username, phone: user.phone })};
    let adminWaNumber = '';
    const myGrid = document.getElementById('myGrid');
    const myAlert = document.getElementById('myAlert');
    const quotaInfo = document.getElementById('quotaInfo');
    const requestWagButton = document.getElementById('requestWagButton');
    const embedSession = document.getElementById('embedSession');
    const embedCode = document.getElementById('embedCode');
    const copyEmbedButton = document.getElementById('copyEmbedButton');
    const embedLocalhostWarning = document.getElementById('embedLocalhostWarning');
    const testApiQuotaInfo = document.getElementById('testApiQuotaInfo');
    const testApiSession = document.getElementById('testApiSession');
    const testApiForm = document.getElementById('testApiForm');
    const testApiButton = document.getElementById('testApiButton');
    const testApiResult = document.getElementById('testApiResult');
    const planCards = document.getElementById('planCards');
    let myCache = [];
    let myPlanInfo = { plan: 'free', dailyMessageLimit: 10, messagesToday: 0, pendingPlanRequest: null, planExpiresAt: null };
    let plansInfo = {};
    const qrCache = {};

    ${TOGGLE_PASSWORD_SCRIPT}

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

            if (isCurrent && myPlanInfo.planExpired) {
                const expiredText = 'Kadaluarsa sejak ' + new Date(myPlanInfo.planExpiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
                actionHtml = '<span class="mt-3 block rounded-lg bg-red-50 py-2 text-center text-xs font-semibold text-red-600">' + expiredText + '</span>' +
                    '<a href="/app/upgrade/' + key + '" class="mt-1.5 block w-full rounded-lg bg-emerald-600 py-2 text-xs font-semibold text-white hover:bg-emerald-700 transition">Perpanjang</a>';
            } else if (isCurrent) {
                const expiryText = myPlanInfo.planExpiresAt
                    ? 'Aktif s.d. ' + new Date(myPlanInfo.planExpiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
                    : 'Paket Aktif';
                actionHtml = '<span class="mt-3 block rounded-lg bg-emerald-50 py-2 text-center text-xs font-semibold text-emerald-700">' + expiryText + '</span>';
            } else if (isPending) {
                actionHtml = '<span class="mt-3 block rounded-lg bg-amber-50 py-2 text-center text-xs font-semibold text-amber-700">Menunggu Konfirmasi Admin</span>';
            } else {
                actionHtml = '<a href="/app/upgrade/' + key + '" class="mt-3 block w-full rounded-lg bg-emerald-600 py-2 text-xs font-semibold text-white hover:bg-emerald-700 transition">Upgrade ke ' + def.label + '</a>';
            }

            return '<div class="rounded-xl border ' + (isCurrent && myPlanInfo.planExpired ? 'border-red-300 bg-red-50' : isCurrent ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200') + ' p-3 text-center">' +
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
            adminWaNumber = data.adminWaNumber || '';
            renderPlanCards();
        } catch (error) {
            planCards.innerHTML = '<p class="text-sm text-red-600 sm:col-span-3">' + error.message + '</p>';
        }
    }

    function populateTestApiSessionOptions() {
        const usable = myCache.filter((e) => e.status === 'active');
        const previous = testApiSession.value;

        testApiSession.innerHTML = '<option value="">Otomatis (akun aktif pertama)</option>' +
            usable.map((e) => '<option value="' + e.id + '">' + e.name + '</option>').join('');

        if (usable.some((e) => e.id === previous)) {
            testApiSession.value = previous;
        }
    }

    function setTestApiResult(text, tone) {
        testApiResult.textContent = text;
        testApiResult.className = 'overflow-auto rounded-b-lg bg-slate-950 px-3 py-3 text-xs leading-relaxed ' + tone;
    }

    testApiForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const apiKey = document.getElementById('testApiKey').value.trim();
        const payload = {
            number: document.getElementById('testApiNumber').value,
            message: document.getElementById('testApiMessage').value,
        };
        if (testApiSession.value) {
            payload.session = testApiSession.value;
        }

        testApiButton.disabled = true;
        setTestApiResult('Mengirim...', 'text-slate-400');
        try {
            // Dipanggil langsung dari browser ke endpoint publiknya (bukan lewat
            // sesi login) supaya benar-benar mensimulasikan pemanggilan API dari
            // luar — API key cuma dipakai di request ini, tidak pernah dikirim/
            // disimpan ke server portal.
            const response = await fetch('/api/external/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
                body: JSON.stringify(payload),
            });
            const data = await response.json();
            setTestApiResult('HTTP ' + response.status + '\\n' + JSON.stringify(data, null, 2), data.success ? 'text-emerald-300' : 'text-red-300');
            if (data.success) {
                await refreshMine();
            }
        } catch (error) {
            setTestApiResult('Error: ' + error.message, 'text-red-300');
        } finally {
            testApiButton.disabled = false;
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
            requestWagButton.disabled = activeCount >= data.maxAccounts || data.planExpired;
            requestWagButton.classList.toggle('opacity-50', requestWagButton.disabled);
            requestWagButton.classList.toggle('cursor-not-allowed', requestWagButton.disabled);

            myPlanInfo = {
                plan: data.plan,
                dailyMessageLimit: data.dailyMessageLimit,
                messagesToday: data.messagesToday,
                pendingPlanRequest: data.pendingPlanRequest,
                planExpiresAt: data.planExpiresAt,
                planExpired: data.planExpired,
            };
            if (data.planExpired) {
                showMyAlert('Paket ' + data.planLabel + ' kamu sudah kadaluarsa — kirim pesan & request akun WAG baru diblokir sampai diperpanjang admin. Buka tab Paket Langganan untuk perpanjang.', true);
            }
            const sisaKuota = Math.max(0, data.dailyMessageLimit - data.messagesToday);
            testApiQuotaInfo.textContent = data.planExpired
                ? 'Paket kadaluarsa — kirim pesan diblokir'
                : 'Sisa hari ini: ' + sisaKuota + '/' + data.dailyMessageLimit;
            if (broadcastQuota) {
                broadcastQuota.textContent = data.planExpired
                    ? 'Paket kadaluarsa — broadcast diblokir'
                    : 'Sisa kuota hari ini: ' + sisaKuota;
            }
            renderPlanCards();
            populateTestApiSessionOptions();
            // Dropdown akun WAG di tab Broadcast / Terjadwal / Balas Otomatis
            // ikut disegarkan tiap refresh supaya akun baru langsung muncul.
            fillSessionSelect(broadcastSession, 'Otomatis (akun aktif pertama)');
            fillSessionSelect(scheduleSession, 'Otomatis');
            fillSessionSelect(autoReplySession, 'Semua akun WAG saya');

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
        'test-api': 'Uji API',
        broadcast: 'Broadcast',
        schedule: 'Pesan Terjadwal',
        contacts: 'Kontak & Template',
        autoreply: 'Balas Otomatis',
        inbox: 'Pesan Masuk',
        plans: 'Paket Langganan',
        embed: 'Embed Widget QR',
        history: 'Riwayat Kirim',
        docs: 'Dokumentasi API',
    };

    const PAGE_TAB_IDS = Array.from(pageTabs).reduce((ids, tab) => {
        if (!ids.includes(tab.dataset.pageTab)) ids.push(tab.dataset.pageTab);
        return ids;
    }, []);

    // --- Bottom nav mobile: sheet "Lainnya" ---
    const moreNavButton = document.getElementById('moreNavButton');
    const moreSheet = document.getElementById('moreSheet');
    const moreSheetBackdrop = document.getElementById('moreSheetBackdrop');
    const MORE_TAB_IDS = Array.from(document.querySelectorAll('.more-tab')).map((tab) => tab.dataset.pageTab);

    function openMoreSheet() {
        moreSheetBackdrop.classList.remove('hidden');
        moreSheet.classList.remove('hidden');
        requestAnimationFrame(() => moreSheet.classList.remove('translate-y-full'));
    }
    function closeMoreSheet() {
        moreSheet.classList.add('translate-y-full');
        moreSheetBackdrop.classList.add('hidden');
        setTimeout(() => moreSheet.classList.add('hidden'), 200);
    }
    moreNavButton?.addEventListener('click', () => {
        if (moreSheet.classList.contains('hidden')) openMoreSheet(); else closeMoreSheet();
    });
    moreSheetBackdrop?.addEventListener('click', closeMoreSheet);
    document.getElementById('moreLogoutButton')?.addEventListener('click', logoutUser);

    // Drag naik/turun (tuas + jari/kursor) untuk tutup sheet, mirip bottom sheet aplikasi native.
    const moreSheetHandle = document.getElementById('moreSheetHandle');
    let sheetDragStartY = null;
    let sheetDragDelta = 0;

    function sheetDragStart(clientY) {
        sheetDragStartY = clientY;
        sheetDragDelta = 0;
        moreSheet.style.transition = 'none';
    }
    function sheetDragMove(clientY) {
        if (sheetDragStartY === null) return;
        sheetDragDelta = Math.max(0, clientY - sheetDragStartY);
        moreSheet.style.transform = 'translateY(' + sheetDragDelta + 'px)';
    }
    function sheetDragEnd() {
        if (sheetDragStartY === null) return;
        moreSheet.style.transition = '';
        moreSheet.style.transform = '';
        if (sheetDragDelta > moreSheet.getBoundingClientRect().height * 0.25) {
            closeMoreSheet();
        }
        sheetDragStartY = null;
    }
    moreSheetHandle?.addEventListener('pointerdown', (event) => {
        sheetDragStart(event.clientY);
        moreSheetHandle.setPointerCapture(event.pointerId);
    });
    moreSheetHandle?.addEventListener('pointermove', (event) => sheetDragMove(event.clientY));
    moreSheetHandle?.addEventListener('pointerup', sheetDragEnd);
    moreSheetHandle?.addEventListener('pointercancel', sheetDragEnd);

    // Dipanggil dari klik tab (butuh entry history baru, biar tombol
    // back/forward browser bisa dipakai) maupun dari popstate/initial load
    // (cukup sinkronkan tampilan, tanpa nambah entry history lagi).
    function activatePage(id, pushHistory) {
        if (!PAGE_TAB_IDS.includes(id)) {
            id = 'dashboard';
        }

        pageTabs.forEach((tab) => {
            const active = tab.dataset.pageTab === id;
            tab.classList.toggle('bg-emerald-50', active);
            tab.classList.toggle('text-emerald-700', active);
            tab.classList.toggle('text-slate-600', !active);
            tab.classList.toggle('hover:bg-slate-100', !active);
        });
        if (moreNavButton) {
            const moreActive = MORE_TAB_IDS.includes(id);
            moreNavButton.classList.toggle('text-emerald-700', moreActive);
            moreNavButton.classList.toggle('text-slate-600', !moreActive);
        }
        pagePanels.forEach((panel) => {
            panel.classList.toggle('hidden', panel.id !== 'page-' + id);
        });
        if (pageTitle) {
            pageTitle.textContent = PAGE_TITLES[id] || '';
        }
        closeMoreSheet();

        const hash = '#' + id;
        if (location.hash !== hash) {
            if (pushHistory && history.pushState) {
                history.pushState(null, '', hash);
            } else if (history.replaceState) {
                history.replaceState(null, '', hash);
            }
        }
    }

    pageTabs.forEach((tab) => {
        tab.addEventListener('click', () => activatePage(tab.dataset.pageTab, true));
    });

    window.addEventListener('popstate', () => {
        activatePage(location.hash.slice(1));
    });

    activatePage(location.hash.slice(1) || 'dashboard');

    // --- Sub-tab dalam Dokumentasi API (Pengaturan API / Referensi Endpoint) ---
    const docsTabs = document.querySelectorAll('.docs-tab');
    const docsSetupView = document.getElementById('docsSetupView');
    const docsReferenceView = document.getElementById('docsReferenceView');

    docsTabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const isSetup = tab.dataset.docsTab === 'setup';
            docsTabs.forEach((t) => {
                const active = t === tab;
                t.classList.toggle('bg-white', active);
                t.classList.toggle('shadow-sm', active);
                t.classList.toggle('text-slate-800', active);
                t.classList.toggle('text-slate-500', !active);
            });
            docsSetupView.classList.toggle('hidden', !isSetup);
            docsReferenceView.classList.toggle('hidden', isSetup);
        });
    });
    docsTabs[0]?.classList.add('bg-white', 'shadow-sm', 'text-slate-800');
    docsTabs[1]?.classList.add('text-slate-500');

    // --- Tab Dokumentasi API ---
    const docsSessionTableBody = document.getElementById('docsSessionTableBody');
    const curlExternalSendEl = document.getElementById('curlExternalSend');
    const curlExternalSendFileEl = document.getElementById('curlExternalSendFile');
    const curlExternalBroadcastEl = document.getElementById('curlExternalBroadcast');
    const curlExternalScheduleEl = document.getElementById('curlExternalSchedule');
    const curlStatusEl = document.getElementById('curlStatus');
    const curlQrEl = document.getElementById('curlQr');

    function renderDocsExamples() {
        const base = publicBaseUrl || location.origin;
        const active = myCache.filter((e) => e.status === 'active');
        const exampleId = active.length ? active[0].id : 'SESSION_ID';

        curlExternalSendEl.textContent = 'curl -X POST "' + base + '/api/external/send" \\\\\\n' +
            '  -H "x-api-key: YOUR_API_KEY" \\\\\\n' +
            '  -H "Content-Type: application/json" \\\\\\n' +
            '  -d \\'{"session":"' + exampleId + '","number":"628123456789","message":"Halo dari API"}\\'';
        curlExternalSendFileEl.textContent = 'curl -X POST "' + base + '/api/external/send-file" \\\\\\n' +
            '  -H "x-api-key: YOUR_API_KEY" \\\\\\n' +
            '  -F "session=' + exampleId + '" \\\\\\n' +
            '  -F "number=628123456789" \\\\\\n' +
            '  -F "caption=Ini laporan bulanan" \\\\\\n' +
            '  -F "file=@/path/ke/dokumen.pdf"';
        curlExternalBroadcastEl.textContent = 'curl -X POST "' + base + '/api/external/broadcast" \\\\\\n' +
            '  -H "x-api-key: YOUR_API_KEY" \\\\\\n' +
            '  -H "Content-Type: application/json" \\\\\\n' +
            '  -d \\'{"contactGroup":"VIP","numbers":"628123456789","message":"Halo {{nama}}, ada promo!"}\\'';
        curlExternalScheduleEl.textContent = 'curl -X POST "' + base + '/api/external/schedule" \\\\\\n' +
            '  -H "x-api-key: YOUR_API_KEY" \\\\\\n' +
            '  -H "Content-Type: application/json" \\\\\\n' +
            '  -d \\'{"number":"628123456789","message":"Pengingat rapat","sendAt":"2026-12-31T09:00:00Z"}\\'';
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

    // --- API Key ---
    const apiKeyAlert = document.getElementById('apiKeyAlert');
    const apiKeyStatusLabel = document.getElementById('apiKeyStatusLabel');
    const apiKeyStatusSub = document.getElementById('apiKeyStatusSub');
    const copyApiKeyPrefixButton = document.getElementById('copyApiKeyPrefixButton');
    const chatAdminApiKeyButton = document.getElementById('chatAdminApiKeyButton');
    let currentApiKeyPrefix = '';

    function showApiKeyAlert(message, isError) {
        apiKeyAlert.textContent = message;
        apiKeyAlert.className = 'mt-3 rounded-xl px-4 py-3 text-sm font-medium ' + (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
        apiKeyAlert.classList.remove('hidden');
        setTimeout(() => apiKeyAlert.classList.add('hidden'), 5000);
    }

    async function loadApiKeyStatus() {
        try {
            const response = await fetch('/api/my/api-key', { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Gagal memuat status API key');

            if (data.apiKeyPrefix) {
                currentApiKeyPrefix = data.apiKeyPrefix;
                apiKeyStatusLabel.textContent = data.apiKeyPrefix + '...';
                apiKeyStatusSub.textContent = data.apiKeyCreatedAt
                    ? 'Dibuat ' + new Date(data.apiKeyCreatedAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
                    : '';
                copyApiKeyPrefixButton.classList.remove('hidden');
            } else {
                currentApiKeyPrefix = '';
                apiKeyStatusLabel.textContent = 'Belum ada API key';
                apiKeyStatusSub.textContent = 'Minta admin buatkan lewat tombol di bawah.';
                copyApiKeyPrefixButton.classList.add('hidden');
            }
        } catch (error) {
            currentApiKeyPrefix = '';
            apiKeyStatusLabel.textContent = 'Gagal memuat';
            apiKeyStatusSub.textContent = error.message;
            copyApiKeyPrefixButton.classList.add('hidden');
        }
    }

    copyApiKeyPrefixButton.addEventListener('click', async () => {
        if (!currentApiKeyPrefix) return;
        try {
            await navigator.clipboard.writeText(currentApiKeyPrefix);
            showApiKeyAlert('Prefix key disalin. Ingat, ini bukan key lengkap — key lengkap cuma dikirim sekali lewat WhatsApp.', false);
        } catch (error) {
            // abaikan kalau clipboard API tidak tersedia
        }
    });

    chatAdminApiKeyButton.addEventListener('click', () => {
        if (!adminWaNumber) {
            showApiKeyAlert('Admin belum mengatur nomor WA kontak. Hubungi admin secara manual ya.', true);
            return;
        }

        const chatText = 'Halo Admin, saya mau minta dibuatkan/generate ulang API Key WA Gateway saya.\\n' +
            'Username: ' + currentUser.username + '\\n' +
            'No HP terdaftar: ' + currentUser.phone + '\\n' +
            'Mohon dikirim ke WhatsApp nomor ini ya. Terima kasih.';
        window.open('https://wa.me/' + adminWaNumber + '?text=' + encodeURIComponent(chatText), '_blank');
    });

    // --- Webhook milik user ---
    const webhookAlert = document.getElementById('webhookAlert');
    const webhookForm = document.getElementById('webhookForm');
    const webhookUrlInput = document.getElementById('webhookUrl');
    const webhookSecretInput = document.getElementById('webhookSecret');
    const webhookSaveButton = document.getElementById('webhookSaveButton');

    function showWebhookAlert(message, isError) {
        webhookAlert.textContent = message;
        webhookAlert.className = 'mt-3 rounded-xl px-4 py-3 text-sm font-medium ' + (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
        webhookAlert.classList.remove('hidden');
        setTimeout(() => webhookAlert.classList.add('hidden'), 5000);
    }

    async function loadWebhookConfig() {
        try {
            const response = await fetch('/api/my/webhook', { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Gagal memuat webhook');
            webhookUrlInput.value = data.webhookUrl || '';
            webhookSecretInput.value = data.webhookSecret || '';
        } catch (error) {
            showWebhookAlert(error.message, true);
        }
    }

    webhookForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        webhookSaveButton.disabled = true;
        try {
            const response = await fetch('/api/my/webhook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    webhookUrl: webhookUrlInput.value,
                    webhookSecret: webhookSecretInput.value,
                }),
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Gagal menyimpan webhook');
            showWebhookAlert(data.message, false);
        } catch (error) {
            showWebhookAlert(error.message, true);
        } finally {
            webhookSaveButton.disabled = false;
        }
    });

    // --- Riwayat kirim milik user ---
    const myHistoryTableBody = document.getElementById('myHistoryTableBody');
    const myHistoryTotal = document.getElementById('myHistoryTotal');

    const HISTORY_SOURCE_LABELS = {
        user_portal: 'Portal',
        external_api: 'API',
        scheduled: 'Terjadwal',
        broadcast: 'Broadcast',
        api: 'API Admin',
        form: 'Form',
    };

    function escapeHistoryHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    async function loadMyHistory() {
        try {
            const response = await fetch('/api/my/history?limit=50', { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Gagal memuat riwayat');

            myHistoryTotal.textContent = 'Total: ' + data.total + ' pesan';

            if (!data.entries.length) {
                myHistoryTableBody.innerHTML = '<tr><td class="px-3 py-3 text-slate-400" colspan="6">Belum ada pesan terkirim.</td></tr>';
                return;
            }

            myHistoryTableBody.innerHTML = data.entries.map((e) => {
                const when = e.timestamp ? new Date(e.timestamp).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';
                const isSent = e.status === 'sent';
                const statusCell = isSent
                    ? '<span class="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">Terkirim</span>'
                    : '<span class="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-600" title="' + escapeHistoryHtml(e.error) + '">Gagal</span>';

                return '<tr>' +
                    '<td class="px-3 py-2 whitespace-nowrap text-slate-600">' + when + '</td>' +
                    '<td class="px-3 py-2 text-slate-600">' + escapeHistoryHtml(e.sessionName) + '</td>' +
                    '<td class="px-3 py-2 whitespace-nowrap text-slate-600">' + escapeHistoryHtml(e.to) + '</td>' +
                    '<td class="px-3 py-2 text-slate-600">' + escapeHistoryHtml(e.message) + '</td>' +
                    '<td class="px-3 py-2 text-slate-500">' + (HISTORY_SOURCE_LABELS[e.source] || escapeHistoryHtml(e.source) || '-') + '</td>' +
                    '<td class="px-3 py-2">' + statusCell + '</td>' +
                    '</tr>';
            }).join('');
        } catch (error) {
            myHistoryTableBody.innerHTML = '<tr><td class="px-3 py-3 text-red-600" colspan="6">' + escapeHistoryHtml(error.message) + '</td></tr>';
        }
    }

    // =======================================================================
    // Broadcast, Terjadwal, Kontak, Template, Balas Otomatis, Inbox, Analitik
    // =======================================================================

    function showPanelAlert(el, message, isError) {
        el.textContent = message;
        el.className = 'mt-3 rounded-xl px-4 py-3 text-sm font-medium ' +
            (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
        el.classList.remove('hidden');
        setTimeout(() => el.classList.add('hidden'), 5000);
    }

    // Semua request JSON di bawah dibungkus helper ini supaya penanganan error
    // seragam & pesan dari server selalu tampil apa adanya ke user.
    async function apiJson(url, options) {
        const response = await fetch(url, options);
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.message || 'Permintaan gagal');
        }
        return data;
    }

    // Isi <select> pilihan akun WAG aktif (dipakai broadcast/jadwal/auto-reply).
    function fillSessionSelect(select, placeholderLabel) {
        if (!select) return;
        const usable = myCache.filter((e) => e.status === 'active');
        const previous = select.value;
        select.innerHTML = '<option value="">' + placeholderLabel + '</option>' +
            usable.map((e) => '<option value="' + e.id + '">' + escapeHistoryHtml(e.name) + '</option>').join('');
        if (usable.some((e) => e.id === previous)) select.value = previous;
    }

    // --- Broadcast ---
    const broadcastForm = document.getElementById('broadcastForm');
    const broadcastAlert = document.getElementById('broadcastAlert');
    const broadcastButton = document.getElementById('broadcastButton');
    const broadcastSession = document.getElementById('broadcastSession');
    const broadcastGroup = document.getElementById('broadcastGroup');
    const broadcastTemplate = document.getElementById('broadcastTemplate');
    const broadcastMessage = document.getElementById('broadcastMessage');
    const broadcastQuota = document.getElementById('broadcastQuota');

    broadcastForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        broadcastButton.disabled = true;
        try {
            const data = await apiJson('/api/my/broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session: broadcastSession.value || undefined,
                    contactGroup: broadcastGroup.value || undefined,
                    numbers: document.getElementById('broadcastNumbers').value,
                    message: broadcastMessage.value,
                }),
            });
            showPanelAlert(broadcastAlert, data.message, false);
            broadcastForm.reset();
            await refreshMine();
            await loadMyHistory();
        } catch (error) {
            showPanelAlert(broadcastAlert, error.message, true);
        } finally {
            broadcastButton.disabled = false;
        }
    });

    broadcastTemplate.addEventListener('change', () => {
        const tpl = templatesCache.find((t) => t.id === broadcastTemplate.value);
        if (tpl) broadcastMessage.value = tpl.content;
    });

    // --- Pesan terjadwal ---
    const scheduleForm = document.getElementById('scheduleForm');
    const scheduleAlert = document.getElementById('scheduleAlert');
    const scheduleButton = document.getElementById('scheduleButton');
    const scheduleSession = document.getElementById('scheduleSession');
    const scheduleTableBody = document.getElementById('scheduleTableBody');

    scheduleForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        scheduleButton.disabled = true;
        try {
            // datetime-local memberi waktu LOKAL tanpa zona; diubah ke ISO
            // supaya server tidak salah menafsirkan sebagai UTC.
            const localValue = document.getElementById('scheduleSendAt').value;
            const data = await apiJson('/api/my/schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session: scheduleSession.value || undefined,
                    number: document.getElementById('scheduleNumber').value,
                    message: document.getElementById('scheduleMessage').value,
                    sendAt: localValue ? new Date(localValue).toISOString() : '',
                }),
            });
            showPanelAlert(scheduleAlert, data.message, false);
            scheduleForm.reset();
            await loadSchedule();
        } catch (error) {
            showPanelAlert(scheduleAlert, error.message, true);
        } finally {
            scheduleButton.disabled = false;
        }
    });

    const SCHEDULE_STATUS_TONE = {
        pending: 'bg-amber-50 text-amber-700',
        sent: 'bg-emerald-50 text-emerald-700',
        failed: 'bg-red-50 text-red-600',
        cancelled: 'bg-slate-100 text-slate-500',
    };

    async function loadSchedule() {
        try {
            const data = await apiJson('/api/my/schedule', { cache: 'no-store' });
            if (!data.entries.length) {
                scheduleTableBody.innerHTML = '<tr><td class="px-3 py-3 text-slate-400" colspan="5">Belum ada pesan terjadwal.</td></tr>';
                return;
            }
            scheduleTableBody.innerHTML = data.entries.map((e) => {
                const when = new Date(e.sendAt).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
                const tone = SCHEDULE_STATUS_TONE[e.status] || 'bg-slate-100 text-slate-500';
                const action = e.status === 'pending'
                    ? '<button type="button" data-cancel-schedule="' + e.id + '" class="rounded-lg bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-100 transition">Batalkan</button>'
                    : '<span class="text-[11px] text-slate-300">—</span>';
                return '<tr>' +
                    '<td class="px-3 py-2 whitespace-nowrap text-slate-600">' + when + '</td>' +
                    '<td class="px-3 py-2 whitespace-nowrap text-slate-600">' + escapeHistoryHtml(e.to) + '</td>' +
                    '<td class="px-3 py-2 text-slate-600">' + escapeHistoryHtml(e.message) + '</td>' +
                    '<td class="px-3 py-2"><span class="rounded-full px-2 py-0.5 text-[11px] font-semibold ' + tone + '" title="' + escapeHistoryHtml(e.error) + '">' + e.status + '</span></td>' +
                    '<td class="px-3 py-2 text-right">' + action + '</td>' +
                    '</tr>';
            }).join('');
        } catch (error) {
            scheduleTableBody.innerHTML = '<tr><td class="px-3 py-3 text-red-600" colspan="5">' + escapeHistoryHtml(error.message) + '</td></tr>';
        }
    }

    scheduleTableBody.addEventListener('click', async (event) => {
        const btn = event.target.closest('[data-cancel-schedule]');
        if (!btn) return;
        if (!confirm('Batalkan pesan terjadwal ini?')) return;
        btn.disabled = true;
        try {
            const data = await apiJson('/api/my/schedule/' + btn.dataset.cancelSchedule, { method: 'DELETE' });
            showPanelAlert(scheduleAlert, data.message, false);
            await loadSchedule();
        } catch (error) {
            showPanelAlert(scheduleAlert, error.message, true);
            btn.disabled = false;
        }
    });

    // --- Sub-tab Kontak / Template ---
    const contactsTabs = document.querySelectorAll('.contacts-tab');
    const contactsView = document.getElementById('contactsView');
    const templatesView = document.getElementById('templatesView');

    contactsTabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const isContacts = tab.dataset.contactsTab === 'contacts';
            contactsTabs.forEach((t) => {
                const active = t === tab;
                t.classList.toggle('bg-white', active);
                t.classList.toggle('shadow-sm', active);
                t.classList.toggle('text-slate-800', active);
                t.classList.toggle('text-slate-500', !active);
            });
            contactsView.classList.toggle('hidden', !isContacts);
            templatesView.classList.toggle('hidden', isContacts);
        });
    });
    contactsTabs[0]?.classList.add('bg-white', 'shadow-sm', 'text-slate-800');
    contactsTabs[1]?.classList.add('text-slate-500');

    // --- Kontak ---
    const contactForm = document.getElementById('contactForm');
    const contactsAlert = document.getElementById('contactsAlert');
    const contactsTableBody = document.getElementById('contactsTableBody');
    const contactsCount = document.getElementById('contactsCount');
    const contactImportButton = document.getElementById('contactImportButton');
    let contactsCache = [];
    const testApiContact = document.getElementById('testApiContact');
    const testApiTemplate = document.getElementById('testApiTemplate');
    const scheduleContact = document.getElementById('scheduleContact');
    const scheduleTemplate = document.getElementById('scheduleTemplate');

    function fillContactSelect(select) {
        const previous = select.value;
        select.innerHTML = '<option value="">Pilih dari kontak...</option>' +
            contactsCache.map((c) => '<option value="' + c.id + '">' + escapeHistoryHtml(c.name) + ' (' + escapeHistoryHtml(c.phone) + ')</option>').join('');
        if (contactsCache.some((c) => c.id === previous)) select.value = previous;
    }

    function fillTemplateSelect(select) {
        const previous = select.value;
        select.innerHTML = '<option value="">Pakai template...</option>' +
            templatesCache.map((t) => '<option value="' + t.id + '">' + escapeHistoryHtml(t.name) + '</option>').join('');
        if (templatesCache.some((t) => t.id === previous)) select.value = previous;
    }

    testApiContact.addEventListener('change', () => {
        const contact = contactsCache.find((c) => c.id === testApiContact.value);
        if (contact) document.getElementById('testApiNumber').value = contact.phone;
    });
    testApiTemplate.addEventListener('change', () => {
        const tpl = templatesCache.find((t) => t.id === testApiTemplate.value);
        if (tpl) document.getElementById('testApiMessage').value = tpl.content;
    });
    scheduleContact.addEventListener('change', () => {
        const contact = contactsCache.find((c) => c.id === scheduleContact.value);
        if (contact) document.getElementById('scheduleNumber').value = contact.phone;
    });
    scheduleTemplate.addEventListener('change', () => {
        const tpl = templatesCache.find((t) => t.id === scheduleTemplate.value);
        if (tpl) document.getElementById('scheduleMessage').value = tpl.content;
    });

    contactForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            const data = await apiJson('/api/my/contacts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: document.getElementById('contactName').value,
                    phone: document.getElementById('contactPhone').value,
                    groupName: document.getElementById('contactGroup').value,
                }),
            });
            showPanelAlert(contactsAlert, data.message, false);
            contactForm.reset();
            await loadContacts();
        } catch (error) {
            showPanelAlert(contactsAlert, error.message, true);
        }
    });

    contactImportButton.addEventListener('click', async () => {
        contactImportButton.disabled = true;
        try {
            const data = await apiJson('/api/my/contacts/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    data: document.getElementById('contactImportData').value,
                    groupName: document.getElementById('contactImportGroup').value,
                }),
            });
            showPanelAlert(contactsAlert, data.message, false);
            document.getElementById('contactImportData').value = '';
            await loadContacts();
        } catch (error) {
            showPanelAlert(contactsAlert, error.message, true);
        } finally {
            contactImportButton.disabled = false;
        }
    });

    async function loadContacts() {
        try {
            const data = await apiJson('/api/my/contacts', { cache: 'no-store' });
            contactsCount.textContent = data.entries.length + ' kontak';
            contactsCache = data.entries;

            // Grup kontak juga dipakai sebagai pilihan tujuan di tab Broadcast.
            const previousGroup = broadcastGroup.value;
            broadcastGroup.innerHTML = '<option value="">— tidak pakai grup —</option>' +
                data.groups.map((g) => '<option value="' + escapeHistoryHtml(g) + '">' + escapeHistoryHtml(g) + '</option>').join('');
            if (data.groups.includes(previousGroup)) broadcastGroup.value = previousGroup;

            // Kontak individual juga dipakai sebagai pilihan cepat di Uji API & Jadwalkan Pesan.
            fillContactSelect(testApiContact);
            fillContactSelect(scheduleContact);

            if (!data.entries.length) {
                contactsTableBody.innerHTML = '<tr><td class="px-3 py-3 text-slate-400" colspan="4">Belum ada kontak.</td></tr>';
                return;
            }
            contactsTableBody.innerHTML = data.entries.map((c) =>
                '<tr>' +
                '<td class="px-3 py-2 font-medium text-slate-700">' + escapeHistoryHtml(c.name) + '</td>' +
                '<td class="px-3 py-2 text-slate-600">' + escapeHistoryHtml(c.phone) + '</td>' +
                '<td class="px-3 py-2 text-slate-500">' + (c.groupName ? escapeHistoryHtml(c.groupName) : '—') + '</td>' +
                '<td class="px-3 py-2 text-right"><button type="button" data-delete-contact="' + c.id + '" class="rounded-lg bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-100 transition">Hapus</button></td>' +
                '</tr>').join('');
        } catch (error) {
            contactsTableBody.innerHTML = '<tr><td class="px-3 py-3 text-red-600" colspan="4">' + escapeHistoryHtml(error.message) + '</td></tr>';
        }
    }

    contactsTableBody.addEventListener('click', async (event) => {
        const btn = event.target.closest('[data-delete-contact]');
        if (!btn) return;
        if (!confirm('Hapus kontak ini?')) return;
        try {
            await apiJson('/api/my/contacts/' + btn.dataset.deleteContact, { method: 'DELETE' });
            await loadContacts();
        } catch (error) {
            showPanelAlert(contactsAlert, error.message, true);
        }
    });

    // --- Template ---
    const templateForm = document.getElementById('templateForm');
    const templatesAlert = document.getElementById('templatesAlert');
    const templatesList = document.getElementById('templatesList');
    let templatesCache = [];

    templateForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            const data = await apiJson('/api/my/templates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: document.getElementById('templateName').value,
                    content: document.getElementById('templateContent').value,
                }),
            });
            showPanelAlert(templatesAlert, data.message, false);
            templateForm.reset();
            await loadTemplates();
        } catch (error) {
            showPanelAlert(templatesAlert, error.message, true);
        }
    });

    async function loadTemplates() {
        try {
            const data = await apiJson('/api/my/templates', { cache: 'no-store' });
            templatesCache = data.entries;

            const previousTpl = broadcastTemplate.value;
            broadcastTemplate.innerHTML = '<option value="">Pakai template...</option>' +
                data.entries.map((t) => '<option value="' + t.id + '">' + escapeHistoryHtml(t.name) + '</option>').join('');
            if (data.entries.some((t) => t.id === previousTpl)) broadcastTemplate.value = previousTpl;

            // Template juga dipakai sebagai pilihan cepat di Uji API & Jadwalkan Pesan.
            fillTemplateSelect(testApiTemplate);
            fillTemplateSelect(scheduleTemplate);

            if (!data.entries.length) {
                templatesList.innerHTML = '<p class="text-sm text-slate-400">Belum ada template.</p>';
                return;
            }
            templatesList.innerHTML = data.entries.map((t) =>
                '<div class="flex items-start justify-between gap-3 rounded-xl border border-slate-200 p-3">' +
                '<div class="min-w-0"><p class="text-sm font-semibold text-slate-800">' + escapeHistoryHtml(t.name) + '</p>' +
                '<p class="mt-0.5 whitespace-pre-wrap break-words text-xs text-slate-500">' + escapeHistoryHtml(t.content) + '</p></div>' +
                '<button type="button" data-delete-template="' + t.id + '" class="shrink-0 rounded-lg bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-100 transition">Hapus</button>' +
                '</div>').join('');
        } catch (error) {
            templatesList.innerHTML = '<p class="text-sm text-red-600">' + escapeHistoryHtml(error.message) + '</p>';
        }
    }

    templatesList.addEventListener('click', async (event) => {
        const btn = event.target.closest('[data-delete-template]');
        if (!btn) return;
        if (!confirm('Hapus template ini?')) return;
        try {
            await apiJson('/api/my/templates/' + btn.dataset.deleteTemplate, { method: 'DELETE' });
            await loadTemplates();
        } catch (error) {
            showPanelAlert(templatesAlert, error.message, true);
        }
    });

    // --- Balas otomatis ---
    const autoReplyForm = document.getElementById('autoReplyForm');
    const autoReplyAlert = document.getElementById('autoReplyAlert');
    const autoReplySession = document.getElementById('autoReplySession');
    const autoRepliesList = document.getElementById('autoRepliesList');
    const autoReplyFormTitle = document.getElementById('autoReplyFormTitle');
    const autoReplySubmitButton = document.getElementById('autoReplySubmitButton');
    const autoReplyCancelEditButton = document.getElementById('autoReplyCancelEditButton');
    const autoReplyEditingId = document.getElementById('autoReplyEditingId');
    let autoRepliesCache = [];

    const MATCH_LABELS = { contains: 'mengandung', exact: 'sama persis', starts: 'diawali' };

    // Form yang sama dipakai buat tambah DAN edit — jadi klik Edit tidak
    // membuka form/halaman baru (tetap di tempat, tidak nambah tinggi
    // halaman / scroll).
    function resetAutoReplyForm() {
        autoReplyEditingId.value = '';
        autoReplyForm.reset();
        autoReplyFormTitle.textContent = 'Balas Otomatis';
        autoReplySubmitButton.textContent = 'Tambah Aturan';
        autoReplyCancelEditButton.classList.add('hidden');
    }

    function startEditAutoReply(rule) {
        autoReplyEditingId.value = rule.id;
        document.getElementById('autoReplyKeyword').value = rule.keyword;
        document.getElementById('autoReplyMatchType').value = rule.matchType;
        document.getElementById('autoReplyText').value = rule.replyText;
        autoReplySession.value = rule.sessionId || '';
        autoReplyFormTitle.textContent = 'Edit Aturan';
        autoReplySubmitButton.textContent = 'Simpan Perubahan';
        autoReplyCancelEditButton.classList.remove('hidden');
        autoReplyForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    autoReplyCancelEditButton.addEventListener('click', resetAutoReplyForm);

    autoReplyForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const editingId = autoReplyEditingId.value;
        try {
            const payload = {
                keyword: document.getElementById('autoReplyKeyword').value,
                replyText: document.getElementById('autoReplyText').value,
                matchType: document.getElementById('autoReplyMatchType').value,
                sessionId: autoReplySession.value || '',
            };
            const data = editingId
                ? await apiJson('/api/my/auto-replies/' + editingId, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                })
                : await apiJson('/api/my/auto-replies', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
            showPanelAlert(autoReplyAlert, data.message, false);
            resetAutoReplyForm();
            await loadAutoReplies();
        } catch (error) {
            showPanelAlert(autoReplyAlert, error.message, true);
        }
    });

    async function loadAutoReplies() {
        try {
            const data = await apiJson('/api/my/auto-replies', { cache: 'no-store' });
            autoRepliesCache = data.entries;
            if (!data.entries.length) {
                autoRepliesList.innerHTML = '<p class="text-sm text-slate-400">Belum ada aturan balas otomatis.</p>';
                return;
            }
            autoRepliesList.innerHTML = data.entries.map((r) =>
                '<div class="flex items-start justify-between gap-3 rounded-xl border ' + (r.enabled ? 'border-slate-200' : 'border-dashed border-slate-300 bg-slate-50') + ' p-3">' +
                '<div class="min-w-0">' +
                '<p class="text-sm font-semibold text-slate-800">' + escapeHistoryHtml(r.keyword) +
                ' <span class="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">' + (MATCH_LABELS[r.matchType] || r.matchType) + '</span>' +
                (r.enabled ? '' : ' <span class="ml-1 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-500">nonaktif</span>') + '</p>' +
                '<p class="mt-0.5 whitespace-pre-wrap break-words text-xs text-slate-500">' + escapeHistoryHtml(r.replyText) + '</p></div>' +
                '<div class="flex shrink-0 gap-1.5">' +
                '<button type="button" data-edit-reply="' + r.id + '" class="rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-200 transition">Edit</button>' +
                '<button type="button" data-toggle-reply="' + r.id + '" data-enabled="' + r.enabled + '" class="rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-200 transition">' + (r.enabled ? 'Nonaktifkan' : 'Aktifkan') + '</button>' +
                '<button type="button" data-delete-reply="' + r.id + '" class="rounded-lg bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-100 transition">Hapus</button>' +
                '</div></div>').join('');
        } catch (error) {
            autoRepliesList.innerHTML = '<p class="text-sm text-red-600">' + escapeHistoryHtml(error.message) + '</p>';
        }
    }

    autoRepliesList.addEventListener('click', async (event) => {
        const editBtn = event.target.closest('[data-edit-reply]');
        const toggleBtn = event.target.closest('[data-toggle-reply]');
        const deleteBtn = event.target.closest('[data-delete-reply]');
        try {
            if (editBtn) {
                const rule = autoRepliesCache.find((r) => r.id === editBtn.dataset.editReply);
                if (rule) startEditAutoReply(rule);
            } else if (toggleBtn) {
                await apiJson('/api/my/auto-replies/' + toggleBtn.dataset.toggleReply, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: toggleBtn.dataset.enabled !== 'true' }),
                });
                await loadAutoReplies();
            } else if (deleteBtn) {
                if (!confirm('Hapus aturan ini?')) return;
                if (autoReplyEditingId.value === deleteBtn.dataset.deleteReply) resetAutoReplyForm();
                await apiJson('/api/my/auto-replies/' + deleteBtn.dataset.deleteReply, { method: 'DELETE' });
                await loadAutoReplies();
            }
        } catch (error) {
            showPanelAlert(autoReplyAlert, error.message, true);
        }
    });

    // --- Inbox ---
    const inboxTableBody = document.getElementById('inboxTableBody');
    const inboxTotal = document.getElementById('inboxTotal');

    async function loadInbox() {
        try {
            const data = await apiJson('/api/my/inbox?limit=50', { cache: 'no-store' });
            inboxTotal.textContent = 'Total: ' + data.total + ' pesan';
            if (!data.entries.length) {
                inboxTableBody.innerHTML = '<tr><td class="px-3 py-3 text-slate-400" colspan="5">Belum ada pesan masuk.</td></tr>';
                return;
            }
            inboxTableBody.innerHTML = data.entries.map((e) => {
                const when = new Date(e.timestamp).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
                const who = e.pushName ? escapeHistoryHtml(e.pushName) : escapeHistoryHtml(e.from);
                return '<tr>' +
                    '<td class="px-3 py-2 whitespace-nowrap text-slate-600">' + when + '</td>' +
                    '<td class="px-3 py-2 text-slate-700">' + who + '</td>' +
                    '<td class="px-3 py-2 text-slate-500">' + escapeHistoryHtml(e.sessionName) + '</td>' +
                    '<td class="px-3 py-2 text-slate-600">' + (e.text ? escapeHistoryHtml(e.text) : '<span class="text-slate-300">(' + escapeHistoryHtml(e.type || 'non-teks') + ')</span>') + '</td>' +
                    '<td class="px-3 py-2">' + (e.autoReplied ? '<span class="text-emerald-600">✓</span>' : '<span class="text-slate-300">—</span>') + '</td>' +
                    '</tr>';
            }).join('');
        } catch (error) {
            inboxTableBody.innerHTML = '<tr><td class="px-3 py-3 text-red-600" colspan="5">' + escapeHistoryHtml(error.message) + '</td></tr>';
        }
    }

    // --- Analitik ---
    const analyticsRange = document.getElementById('analyticsRange');
    const analyticsTotals = document.getElementById('analyticsTotals');
    const analyticsChart = document.getElementById('analyticsChart');

    async function loadAnalytics() {
        try {
            const data = await apiJson('/api/my/analytics?days=' + analyticsRange.value, { cache: 'no-store' });

            analyticsTotals.innerHTML =
                '<div class="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-center"><p class="text-lg font-bold text-emerald-700">' + data.totals.sent + '</p><p class="text-xs text-emerald-600">Terkirim</p></div>' +
                '<div class="rounded-xl border border-red-200 bg-red-50 p-3 text-center"><p class="text-lg font-bold text-red-600">' + data.totals.failed + '</p><p class="text-xs text-red-500">Gagal</p></div>' +
                '<div class="rounded-xl border border-blue-200 bg-blue-50 p-3 text-center"><p class="text-lg font-bold text-blue-700">' + data.totals.incoming + '</p><p class="text-xs text-blue-600">Pesan Masuk</p></div>';

            // Skala batang relatif terhadap hari tersibuk; minimal 1 supaya
            // tidak bagi nol saat belum ada data sama sekali.
            const peak = Math.max(1, ...data.daily.map((d) => Math.max(d.sent, d.failed, d.incoming)));
            const barHeight = (value) => Math.round((value / peak) * 100);

            analyticsChart.innerHTML = data.daily.map((d) => {
                const label = d.date.slice(8) + '/' + d.date.slice(5, 7);
                const title = label + ' — terkirim ' + d.sent + ', gagal ' + d.failed + ', masuk ' + d.incoming;
                return '<div class="flex min-w-0 flex-1 flex-col items-center justify-end gap-0.5" title="' + title + '">' +
                    '<div class="flex w-full items-end justify-center gap-px" style="height:100px">' +
                    '<div class="w-1/3 rounded-t bg-emerald-500" style="height:' + barHeight(d.sent) + '%"></div>' +
                    '<div class="w-1/3 rounded-t bg-red-400" style="height:' + barHeight(d.failed) + '%"></div>' +
                    '<div class="w-1/3 rounded-t bg-blue-400" style="height:' + barHeight(d.incoming) + '%"></div>' +
                    '</div>' +
                    '<span class="truncate text-[9px] text-slate-400">' + label + '</span>' +
                    '</div>';
            }).join('');
        } catch (error) {
            analyticsTotals.innerHTML = '<p class="text-sm text-red-600 sm:col-span-3">' + escapeHistoryHtml(error.message) + '</p>';
        }
    }

    analyticsRange.addEventListener('change', loadAnalytics);

    refreshMine();
    loadPlansInfo();
    loadWebhookConfig();
    loadMyHistory();
    setInterval(loadMyHistory, pollIntervalMs);
    loadApiKeyStatus();
    loadContacts();
    loadTemplates();
    loadAutoReplies();
    loadSchedule();
    loadInbox();
    loadAnalytics();
    setInterval(refreshMine, pollIntervalMs);
    setInterval(loadPlansInfo, pollIntervalMs);
    setInterval(loadApiKeyStatus, pollIntervalMs);
    setInterval(loadInbox, pollIntervalMs);
    setInterval(loadSchedule, pollIntervalMs);
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
        <aside class="hidden w-60 shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-white sm:flex">
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

            <nav class="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
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
                <button type="button" data-page-tab="autoreply" class="page-tab flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="m8 10 2 2 4-4"/></svg>
                    Balas Otomatis
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
                <a href="/manual" target="_blank" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs font-medium text-slate-500 transition hover:bg-slate-100">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                    Panduan Admin
                </a>
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
                <button type="button" data-page-tab="autoreply" class="page-tab shrink-0 rounded-lg px-3 py-2 text-sm font-semibold transition">Balas Otomatis</button>
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
                        <p class="mt-1 text-xs text-slate-500">Paket Free = 1 akun WAG &amp; 10 pesan/hari, tanpa masa berlaku. Paket Pro/Max berlaku 30 hari sejak dipilih di sini. Kalau sudah lewat (tanggal merah), kirim pesan &amp; request akun WAG baru otomatis diblokir sampai kamu perpanjang manual di sini — <strong>tidak otomatis turun ke Free</strong>. Ganti paket di sini kalau user sudah konfirmasi bayar (manual, tidak ada payment gateway). Badge kuning menandakan user sudah minta upgrade sendiri lewat portalnya.</p>
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

                <section id="page-autoreply" class="page-panel mx-auto max-w-3xl hidden">
                    <div class="rounded-xl border border-slate-200 bg-white p-4">
                        <h2 id="adminAutoReplyFormTitle" class="text-sm font-semibold text-slate-800">Balas Otomatis</h2>
                        <p class="mt-1 text-xs text-slate-500">Berlaku untuk akun WhatsApp milik admin (bukan akun WAG milik user — itu diatur user masing-masing lewat portalnya sendiri). Pakai <code class="rounded bg-slate-100 px-1 py-0.5">{{nama}}</code> untuk menyapa pengirim.</p>

                        <div id="adminAutoReplyAlert" class="mt-3 hidden rounded-xl px-4 py-3 text-sm font-medium"></div>

                        <form id="adminAutoReplyForm" class="mt-3 space-y-3">
                            <input type="hidden" id="adminAutoReplyEditingId" value="">
                            <div class="grid gap-3 sm:grid-cols-3">
                                <div>
                                    <label class="text-xs font-semibold text-slate-700">Kata Kunci</label>
                                    <input id="adminAutoReplyKeyword" type="text" required placeholder="mis. jam operasional"
                                        class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                                </div>
                                <div>
                                    <label class="text-xs font-semibold text-slate-700">Cara Cocok</label>
                                    <select id="adminAutoReplyMatchType" class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm">
                                        <option value="contains">Mengandung kata</option>
                                        <option value="exact">Sama persis</option>
                                        <option value="starts">Diawali kata</option>
                                    </select>
                                </div>
                                <div>
                                    <label class="text-xs font-semibold text-slate-700">Berlaku di Akun</label>
                                    <select id="adminAutoReplySession" class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm">
                                        <option value="">Semua akun WhatsApp admin</option>
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label class="text-xs font-semibold text-slate-700">Isi Balasan</label>
                                <textarea id="adminAutoReplyText" rows="3" required placeholder="Halo {{nama}}, kami buka Senin-Sabtu jam 09.00-17.00"
                                    class="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"></textarea>
                            </div>
                            <div class="flex gap-2">
                                <button id="adminAutoReplySubmitButton" type="submit" class="flex-1 rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 transition">Tambah Aturan</button>
                                <button id="adminAutoReplyCancelEditButton" type="button" class="hidden shrink-0 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-200 transition">Batal</button>
                            </div>
                        </form>
                    </div>

                    <div class="mt-4 rounded-xl border border-slate-200 bg-white p-4">
                        <h2 class="text-sm font-semibold text-slate-800">Aturan Aktif</h2>
                        <div id="adminAutoRepliesList" class="mt-3 space-y-2">
                            <p class="text-sm text-slate-400">Memuat...</p>
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

                <section id="page-settings" class="page-panel mx-auto max-w-5xl hidden">
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

                    <form id="settingsForm" class="mt-4 hidden">
                        <div class="relative">
                            <svg class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                            <input id="settingsSearch" type="text" autocomplete="off" placeholder="Cari pengaturan... (mis. port, webhook, login)"
                                class="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-10 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100">
                            <button id="settingsSearchClear" type="button" aria-label="Bersihkan pencarian"
                                class="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                            </button>
                        </div>

                        <div id="settingsLayout" class="mt-3 gap-4 sm:grid sm:grid-cols-[190px_minmax(0,1fr)] sm:items-start">
                            <nav id="settingsNav" class="mb-3 flex gap-1.5 overflow-x-auto sm:sticky sm:top-4 sm:mb-0 sm:flex-col sm:overflow-visible"></nav>
                            <div id="settingsGroups" class="min-w-0"></div>
                        </div>

                        <p id="settingsEmpty" class="hidden rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-400">Tidak ada pengaturan yang cocok dengan pencarian.</p>

                        <div class="sticky bottom-0 mt-4 flex flex-wrap items-center gap-2.5 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
                            <button id="settingsSaveButton" type="submit" class="inline-flex h-11 items-center justify-center rounded-xl bg-emerald-600 px-6 text-sm font-semibold text-white hover:bg-emerald-700 transition">Simpan Pengaturan</button>
                            <p class="text-xs text-slate-400">Perubahan berlaku setelah server restart otomatis.</p>
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
            autoreply: 'Balas Otomatis',
            history: 'Riwayat',
            logs: 'Logs',
            settings: 'Pengaturan',
            requests: 'Persetujuan',
            users: 'Pengguna',
        };

        const PAGE_TAB_IDS = Array.from(pageTabs).reduce((ids, tab) => {
            if (!ids.includes(tab.dataset.pageTab)) ids.push(tab.dataset.pageTab);
            return ids;
        }, []);

        // Dipanggil dari klik tab (butuh entry history baru, biar tombol
        // back/forward browser bisa dipakai) maupun dari popstate/initial load
        // (cukup sinkronkan tampilan, tanpa nambah entry history lagi).
        function activatePage(id, pushHistory) {
            if (!PAGE_TAB_IDS.includes(id)) {
                id = 'dashboard';
            }

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

            const hash = '#' + id;
            if (location.hash !== hash) {
                if (pushHistory && history.pushState) {
                    history.pushState(null, '', hash);
                } else if (history.replaceState) {
                    history.replaceState(null, '', hash);
                }
            }
        }

        pageTabs.forEach((tab) => {
            tab.addEventListener('click', () => activatePage(tab.dataset.pageTab, true));
        });

        window.addEventListener('popstate', () => {
            activatePage(location.hash.slice(1));
        });

        activatePage(location.hash.slice(1) || 'dashboard');

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

        const settingsSearch = document.getElementById('settingsSearch');
        const settingsSearchClear = document.getElementById('settingsSearchClear');
        const settingsLayoutEl = document.getElementById('settingsLayout');
        const settingsNavEl = document.getElementById('settingsNav');
        const settingsEmptyEl = document.getElementById('settingsEmpty');
        let activeSettingsGroup = null;

        const NAV_ACTIVE = 'bg-emerald-50 text-emerald-700';
        const NAV_IDLE = 'text-slate-600 hover:bg-slate-100';

        function renderSettingsGroups(groups) {
            // Semua field tetap dirender ke DOM (yang tidak aktif cuma di-hide),
            // supaya tombol Simpan tetap mengirim SELURUH nilai — bukan cuma
            // kategori yang sedang dibuka.
            settingsNavEl.innerHTML = groups.map((group, index) => {
                const isActive = index === 0;
                return '<button type="button" data-settings-nav="' + group.id + '" ' +
                    'class="settings-nav-btn shrink-0 rounded-lg px-3 py-2 text-left text-sm font-semibold transition ' +
                    (isActive ? NAV_ACTIVE : NAV_IDLE) + '">' + group.label + '</button>';
            }).join('');

            settingsGroupsEl.innerHTML = groups.map((group, index) => {
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
                    // data-search menyimpan teks yang bisa dicari: nama kategori +
                    // label field + nama variabel .env. Kategori ikut disertakan
                    // supaya cari "paket" / "database" tetap ketemu walau kata itu
                    // tidak ada di label field-nya.
                    const searchText = (group.label + ' ' + field.label + ' ' + field.key).toLowerCase().replace(/"/g, '&quot;');
                    return '<div data-field-wrap data-search="' + searchText + '">' +
                        '<label for="' + id + '" class="text-xs font-semibold text-slate-700">' + field.label + '</label>' +
                        '<code class="ml-1 text-[10px] text-slate-400">' + field.key + '</code>' +
                        control +
                        (field.help ? '<p class="mt-1 text-[11px] leading-relaxed text-slate-400">' + field.help + '</p>' : '') +
                        '</div>';
                }).join('');

                return '<fieldset data-settings-panel="' + group.id + '" class="rounded-xl border border-slate-200 bg-white p-4' + (index === 0 ? '' : ' hidden') + '">' +
                    '<legend class="px-1 text-sm font-semibold text-slate-800">' + group.label + '</legend>' +
                    '<div class="mt-2 grid gap-4 lg:grid-cols-2">' + fields + '</div>' +
                    '</fieldset>';
            }).join('');

            activeSettingsGroup = groups.length ? groups[0].id : null;
        }

        function showSettingsGroup(id) {
            activeSettingsGroup = id;
            settingsNavEl.querySelectorAll('[data-settings-nav]').forEach((btn) => {
                const isActive = btn.dataset.settingsNav === id;
                btn.className = 'settings-nav-btn shrink-0 rounded-lg px-3 py-2 text-left text-sm font-semibold transition ' +
                    (isActive ? NAV_ACTIVE : NAV_IDLE);
            });
            settingsGroupsEl.querySelectorAll('[data-settings-panel]').forEach((panel) => {
                panel.classList.toggle('hidden', panel.dataset.settingsPanel !== id);
            });
            // Pastikan tidak ada field yang tersembunyi sisa dari mode pencarian.
            settingsGroupsEl.querySelectorAll('[data-field-wrap]').forEach((el) => el.classList.remove('hidden'));
            settingsEmptyEl.classList.add('hidden');
        }

        function applySettingsSearch(rawQuery) {
            const query = rawQuery.trim().toLowerCase();
            settingsSearchClear.classList.toggle('hidden', !query);

            if (!query) {
                settingsNavEl.classList.remove('hidden');
                // Kembalikan ke grid 2 kolom (nav + konten) — lihat catatan di bawah.
                settingsLayoutEl.style.gridTemplateColumns = '';
                if (activeSettingsGroup) showSettingsGroup(activeSettingsGroup);
                return;
            }

            // Mode pencarian: sembunyikan navigasi kategori, tampilkan SEMUA
            // panel tapi hanya field yang cocok — jadi user tidak perlu tahu
            // pengaturan itu ada di kategori mana. PENTING: grid luar (nav 190px
            // + konten) pakai grid-template-columns TETAP walau nav-nya
            // disembunyikan, jadi kontennya harus dipaksa jadi 1 kolom penuh di
            // sini — kalau tidak, kontennya ketiban lebar kolom nav yang 190px
            // itu dan jadi sangat sempit/berantakan.
            settingsLayoutEl.style.gridTemplateColumns = '1fr';
            settingsNavEl.classList.add('hidden');
            let totalMatches = 0;

            settingsGroupsEl.querySelectorAll('[data-settings-panel]').forEach((panel) => {
                let panelMatches = 0;
                panel.querySelectorAll('[data-field-wrap]').forEach((wrap) => {
                    const hit = (wrap.dataset.search || '').includes(query);
                    wrap.classList.toggle('hidden', !hit);
                    if (hit) panelMatches++;
                });
                panel.classList.toggle('hidden', panelMatches === 0);
                totalMatches += panelMatches;
            });

            settingsEmptyEl.classList.toggle('hidden', totalMatches > 0);
        }

        settingsNavEl.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-settings-nav]');
            if (btn) showSettingsGroup(btn.dataset.settingsNav);
        });

        settingsSearch.addEventListener('input', () => applySettingsSearch(settingsSearch.value));

        settingsSearchClear.addEventListener('click', () => {
            settingsSearch.value = '';
            applySettingsSearch('');
            settingsSearch.focus();
        });

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
                        '<button type="button" data-user-action="reset-api-key" data-id="' + u.id + '" data-username="' + u.username + '" class="inline-flex h-7 items-center justify-center rounded-lg bg-slate-100 px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-200 transition">Reset API Key</button>' +
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
            } else if (action === 'reset-api-key') {
                const username = button.dataset.username;
                if (!window.confirm('Generate ulang API key untuk "' + username + '"? Key lama otomatis tidak berlaku, dan key baru dikirim lewat WhatsApp ke nomor terdaftarnya.')) return;
                button.disabled = true;
                try {
                    const response = await fetch('/api/admin/users/' + id + '/api-key/regenerate', { method: 'POST' });
                    const data = await response.json();
                    // Sukses/gagal, tampilkan apa adanya — kalau gagal kirim WA,
                    // key lama di sisi server tetap sudah tidak berlaku.
                    showUsersAlert(data.message, !data.success);
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

        // --- Balas Otomatis (admin) ---
        function escapeAutoReplyHtml(value) {
            return String(value == null ? '' : value)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        const adminAutoReplyForm = document.getElementById('adminAutoReplyForm');
        const adminAutoReplyAlert = document.getElementById('adminAutoReplyAlert');
        const adminAutoReplySession = document.getElementById('adminAutoReplySession');
        const adminAutoRepliesList = document.getElementById('adminAutoRepliesList');
        const adminAutoReplyFormTitle = document.getElementById('adminAutoReplyFormTitle');
        const adminAutoReplySubmitButton = document.getElementById('adminAutoReplySubmitButton');
        const adminAutoReplyCancelEditButton = document.getElementById('adminAutoReplyCancelEditButton');
        const adminAutoReplyEditingId = document.getElementById('adminAutoReplyEditingId');
        let adminAutoRepliesCache = [];
        const ADMIN_MATCH_LABELS = { contains: 'mengandung', exact: 'sama persis', starts: 'diawali' };

        function showAdminAutoReplyAlert(message, isError) {
            adminAutoReplyAlert.textContent = message;
            adminAutoReplyAlert.className = 'mt-3 rounded-xl px-4 py-3 text-sm font-medium ' +
                (isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700');
            adminAutoReplyAlert.classList.remove('hidden');
            setTimeout(() => adminAutoReplyAlert.classList.add('hidden'), 5000);
        }

        function resetAdminAutoReplyForm() {
            adminAutoReplyEditingId.value = '';
            adminAutoReplyForm.reset();
            adminAutoReplyFormTitle.textContent = 'Balas Otomatis';
            adminAutoReplySubmitButton.textContent = 'Tambah Aturan';
            adminAutoReplyCancelEditButton.classList.add('hidden');
        }

        function startEditAdminAutoReply(rule) {
            adminAutoReplyEditingId.value = rule.id;
            document.getElementById('adminAutoReplyKeyword').value = rule.keyword;
            document.getElementById('adminAutoReplyMatchType').value = rule.matchType;
            document.getElementById('adminAutoReplyText').value = rule.replyText;
            adminAutoReplySession.value = rule.sessionId || '';
            adminAutoReplyFormTitle.textContent = 'Edit Aturan';
            adminAutoReplySubmitButton.textContent = 'Simpan Perubahan';
            adminAutoReplyCancelEditButton.classList.remove('hidden');
            adminAutoReplyForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        adminAutoReplyCancelEditButton.addEventListener('click', resetAdminAutoReplyForm);

        async function loadAdminOwnSessions() {
            try {
                const response = await fetch('/api/admin/own-sessions', { cache: 'no-store' });
                const data = await response.json();
                if (!response.ok || !data.success) return;
                const previous = adminAutoReplySession.value;
                adminAutoReplySession.innerHTML = '<option value="">Semua akun WhatsApp admin</option>' +
                    data.entries.map((s) => '<option value="' + s.id + '">' + escapeAutoReplyHtml(s.name) + '</option>').join('');
                if (data.entries.some((s) => s.id === previous)) adminAutoReplySession.value = previous;
            } catch (error) { /* biarkan, dropdown tetap terakhir kali dimuat */ }
        }

        adminAutoReplyForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const editingId = adminAutoReplyEditingId.value;
            try {
                const payload = {
                    keyword: document.getElementById('adminAutoReplyKeyword').value,
                    replyText: document.getElementById('adminAutoReplyText').value,
                    matchType: document.getElementById('adminAutoReplyMatchType').value,
                    sessionId: adminAutoReplySession.value || '',
                };
                const url = editingId ? '/api/admin/auto-replies/' + editingId : '/api/admin/auto-replies';
                const response = await fetch(url, {
                    method: editingId ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.message || 'Gagal menyimpan aturan');
                showAdminAutoReplyAlert(data.message, false);
                resetAdminAutoReplyForm();
                await loadAdminAutoReplies();
            } catch (error) {
                showAdminAutoReplyAlert(error.message, true);
            }
        });

        async function loadAdminAutoReplies() {
            try {
                const response = await fetch('/api/admin/auto-replies', { cache: 'no-store' });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.message || 'Gagal memuat aturan');
                adminAutoRepliesCache = data.entries;

                if (!data.entries.length) {
                    adminAutoRepliesList.innerHTML = '<p class="text-sm text-slate-400">Belum ada aturan balas otomatis.</p>';
                    return;
                }
                adminAutoRepliesList.innerHTML = data.entries.map((r) =>
                    '<div class="flex items-start justify-between gap-3 rounded-xl border ' + (r.enabled ? 'border-slate-200' : 'border-dashed border-slate-300 bg-slate-50') + ' p-3">' +
                    '<div class="min-w-0">' +
                    '<p class="text-sm font-semibold text-slate-800">' + escapeAutoReplyHtml(r.keyword) +
                    ' <span class="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">' + (ADMIN_MATCH_LABELS[r.matchType] || r.matchType) + '</span>' +
                    (r.enabled ? '' : ' <span class="ml-1 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-500">nonaktif</span>') + '</p>' +
                    '<p class="mt-0.5 whitespace-pre-wrap break-words text-xs text-slate-500">' + escapeAutoReplyHtml(r.replyText) + '</p></div>' +
                    '<div class="flex shrink-0 gap-1.5">' +
                    '<button type="button" data-edit-admin-reply="' + r.id + '" class="rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-200 transition">Edit</button>' +
                    '<button type="button" data-toggle-admin-reply="' + r.id + '" data-enabled="' + r.enabled + '" class="rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-200 transition">' + (r.enabled ? 'Nonaktifkan' : 'Aktifkan') + '</button>' +
                    '<button type="button" data-delete-admin-reply="' + r.id + '" class="rounded-lg bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-100 transition">Hapus</button>' +
                    '</div></div>').join('');
            } catch (error) {
                adminAutoRepliesList.innerHTML = '<p class="text-sm text-red-600">' + escapeAutoReplyHtml(error.message) + '</p>';
            }
        }

        adminAutoRepliesList.addEventListener('click', async (event) => {
            const editBtn = event.target.closest('[data-edit-admin-reply]');
            const toggleBtn = event.target.closest('[data-toggle-admin-reply]');
            const deleteBtn = event.target.closest('[data-delete-admin-reply]');
            try {
                if (editBtn) {
                    const rule = adminAutoRepliesCache.find((r) => r.id === editBtn.dataset.editAdminReply);
                    if (rule) startEditAdminAutoReply(rule);
                } else if (toggleBtn) {
                    await fetch('/api/admin/auto-replies/' + toggleBtn.dataset.toggleAdminReply, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ enabled: toggleBtn.dataset.enabled !== 'true' }),
                    });
                    await loadAdminAutoReplies();
                } else if (deleteBtn) {
                    if (!confirm('Hapus aturan ini?')) return;
                    if (adminAutoReplyEditingId.value === deleteBtn.dataset.deleteAdminReply) resetAdminAutoReplyForm();
                    await fetch('/api/admin/auto-replies/' + deleteBtn.dataset.deleteAdminReply, { method: 'DELETE' });
                    await loadAdminAutoReplies();
                }
            } catch (error) {
                showAdminAutoReplyAlert(error.message, true);
            }
        });

        loadRequests();
        loadNotifyConfig();
        loadPaymentConfig();
        loadUsers();
        loadAdmins();
        loadSchedule();
        loadHistory();
        loadAdminOwnSessions();
        loadAdminAutoReplies();
        setInterval(loadRequests, pollIntervalMs);
        setInterval(loadUsers, pollIntervalMs);
        setInterval(loadAdmins, pollIntervalMs);
        setInterval(loadSchedule, pollIntervalMs);
        setInterval(loadHistory, pollIntervalMs);
        setInterval(loadAdminOwnSessions, pollIntervalMs);
        // Notifikasi & konfigurasi pembayaran SENGAJA tidak di-poll otomatis —
        // isinya form yang lagi diedit admin, auto-refresh bisa nimpa input yang
        // lagi diketik. Cukup dimuat sekali di awal + refresh manual setelah save.

        async function waitForServerAndRedirect(redirectUrl, portChanged) {
            let attempts = 0;
            const maxAttempts = 40;
            // redirectUrl sekarang bisa bawa hash (mis. ".../#settings") supaya
            // admin balik ke tab yang sama setelah restart — base URL tanpa
            // hash dipakai buat health-check-nya, hash-nya cuma dipakai pas
            // navigasi akhir.
            const baseUrl = redirectUrl.split('#')[0];

            const poll = async () => {
                attempts += 1;
                try {
                    await fetch(baseUrl + 'api/status', { mode: 'no-cors', cache: 'no-store' });
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

function renderManualShell({ role, username, backHref, content }) {
  const fileSlug = "panduan-" + role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `<!doctype html>
<html lang="id">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Panduan ${escapeHtml(role)} — ${escapeHtml(APP_NAME)}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
</head>
<body class="bg-slate-100 text-slate-800">
    <header class="no-print sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <div class="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <div class="flex items-center gap-2.5 min-w-0">
                ${renderBrandMark()}
                <div class="min-w-0">
                    <p class="truncate text-sm font-bold text-slate-900">${escapeHtml(APP_NAME)}</p>
                    <p class="truncate text-xs text-slate-400">Panduan Penggunaan &middot; ${escapeHtml(role)}${username ? " &middot; " + escapeHtml(username) : ""}</p>
                </div>
            </div>
            <div class="flex shrink-0 items-center gap-2">
                <button id="downloadManualButton" type="button" class="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 text-xs font-semibold text-white hover:bg-emerald-700 transition disabled:opacity-60">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
                    <span id="downloadManualLabel">Unduh PDF</span>
                </button>
                <a href="${backHref}" class="inline-flex h-9 items-center justify-center rounded-lg bg-slate-100 px-3.5 text-xs font-semibold text-slate-700 hover:bg-slate-200 transition">Kembali</a>
            </div>
        </div>
    </header>

    <main class="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        <div id="manualCard" class="manual-card rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
            ${content}
        </div>
    </main>

    <script>
        document.getElementById('downloadManualButton').addEventListener('click', async () => {
            const button = document.getElementById('downloadManualButton');
            const label = document.getElementById('downloadManualLabel');
            button.disabled = true;
            label.textContent = 'Menyiapkan...';
            try {
                await html2pdf()
                    .set({
                        filename: '${fileSlug}.pdf',
                        margin: [10, 10, 10, 10],
                        image: { type: 'jpeg', quality: 0.98 },
                        html2canvas: { scale: 2, useCORS: true },
                        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                        pagebreak: { mode: ['css'], avoid: ['tr'] },
                    })
                    .from(document.getElementById('manualCard'))
                    .save();
            } finally {
                button.disabled = false;
                label.textContent = 'Unduh PDF';
            }
        });
    </script>
</body>
</html>`;
}

function renderManualToc(items) {
  return `<nav class="no-print mb-8 rounded-xl bg-slate-50 p-4">
        <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Daftar Isi</p>
        <ol class="grid gap-1 text-sm sm:grid-cols-2">
            ${items.map((item, i) => `<li><a href="#${item.id}" class="text-emerald-700 hover:underline">${i + 1}. ${escapeHtml(item.title)}</a></li>`).join("")}
        </ol>
    </nav>`;
}

function renderManualSection(id, title, bodyHtml) {
  return `<section id="${id}" class="mb-8 scroll-mt-4">
        <h2 class="border-b border-slate-200 pb-2 text-lg font-bold text-slate-900">${escapeHtml(title)}</h2>
        <div class="mt-3 space-y-2.5 text-sm leading-relaxed text-slate-600">${bodyHtml}</div>
    </section>`;
}

function renderUserManualPage(user) {
  const sections = [
    { id: "mulai", title: "Mulai: Login &amp; Daftar" },
    { id: "akun-wag", title: "Akun WAG (Sambungkan WhatsApp)" },
    { id: "uji-api-docs", title: "Uji API &amp; Dokumentasi API" },
    { id: "broadcast", title: "Broadcast Pesan" },
    { id: "schedule", title: "Jadwalkan Pesan" },
    { id: "contacts", title: "Kontak &amp; Template" },
    { id: "autoreply", title: "Balas Otomatis" },
    { id: "inbox", title: "Pesan Masuk" },
    { id: "plans", title: "Paket Langganan" },
    { id: "embed", title: "Embed Widget QR" },
    { id: "history", title: "Riwayat Kirim" },
    { id: "mobile-nav", title: "Navigasi di HP" },
    { id: "faq", title: "Tanya Jawab Singkat" },
  ];

  const content = `
        <h1 class="text-2xl font-bold text-slate-900">Panduan Pengguna</h1>
        <p class="mt-1 text-sm text-slate-500">${escapeHtml(APP_NAME)} — semua fitur yang bisa kamu pakai di Portal Pengguna, dari sambungkan WhatsApp sampai broadcast &amp; otomatisasi.</p>

        ${renderManualToc(sections)}

        ${renderManualSection("mulai", "Mulai: Login &amp; Daftar", `
            <p>Buka halaman <code class="rounded bg-slate-100 px-1 py-0.5">/app/login</code>. Kalau belum punya akun, klik tab <strong>Daftar</strong> dan isi username, password, serta nomor WhatsApp aktif kamu (dipakai untuk menerima API key &amp; notifikasi penting).</p>
            <p>Di kolom password ada ikon mata — klik untuk menampilkan/menyembunyikan ketikan password, baik saat login maupun daftar.</p>
            <p>Setelah login, kamu masuk ke Portal Pengguna. Tiap kali pindah halaman, alamat di browser ikut berubah (mis. <code class="rounded bg-slate-100 px-1 py-0.5">#broadcast</code>) tanpa reload — jadi tombol back/forward browser tetap berfungsi normal.</p>
        `)}

        ${renderManualSection("akun-wag", "Akun WAG (Sambungkan WhatsApp)", `
            <p>Ini halaman utama setelah login. Klik <strong>+ Request Akun WAG</strong> untuk minta 1 slot akun WhatsApp baru (jumlah maksimum akun tergantung paket kamu — lihat bagian Paket Langganan).</p>
            <p>Permintaan akun baru harus <strong>disetujui admin</strong> dulu sebelum QR-nya muncul. Setelah disetujui, kembali ke halaman ini dan klik akun tersebut untuk memindai QR pakai aplikasi WhatsApp di HP kamu (Perangkat Tertaut &rarr; Tautkan Perangkat).</p>
            <p>Kartu tiap akun menampilkan status (Menunggu QR / Terhubung / Terputus) dan tombol <strong>Hapus</strong> untuk memutus &amp; menghapus akun itu.</p>
        `)}

        ${renderManualSection("uji-api-docs", "Uji API &amp; Dokumentasi API", `
            <p><strong>Dokumentasi API</strong> berisi API key kamu (hanya ditampilkan sebagian/prefix di layar — key lengkap <em>hanya dikirim lewat WhatsApp</em> ke nomor terdaftar kamu, tidak pernah tampil penuh di browser). Ada tombol salin untuk prefix key, dan contoh <code class="rounded bg-slate-100 px-1 py-0.5">curl</code> siap pakai untuk tiap endpoint (kirim pesan, kirim gambar/file, cek status, ambil QR).</p>
            <p>Kalau lupa atau butuh API key baru, kamu <strong>tidak bisa generate sendiri</strong> — klik tombol "Minta API Key ke Admin lewat WhatsApp" yang otomatis membuka chat ke admin.</p>
            <p><strong>Uji API</strong> adalah form untuk mencoba langsung endpoint <code class="rounded bg-slate-100 px-1 py-0.5">POST /api/external/send</code> dari browser, persis seperti kalau dipanggil dari kode/aplikasi luar. Isi API key, pilih akun pengirim (opsional), nomor tujuan, dan pesan — atau pilih dari dropdown <strong>Pilih dari kontak</strong> / <strong>Pakai template</strong> supaya tidak perlu ngetik manual. Key yang kamu masukkan di sini tidak disimpan di server.</p>
            <p>Bagian Dokumentasi juga menjelaskan <strong>Webhook Pesan Masuk</strong>: kalau kamu isi URL webhook, setiap ada chat masuk ke akun WAG kamu, sistem otomatis kirim <code class="rounded bg-slate-100 px-1 py-0.5">POST</code> berisi JSON pesan itu ke URL tersebut (berguna untuk integrasi CRM/auto-reply eksternal).</p>
        `)}

        ${renderManualSection("broadcast", "Broadcast Pesan", `
            <p>Kirim satu pesan ke banyak nomor sekaligus lewat antrean internal (tidak flood/spam sekaligus). Nomor tujuan bisa ditulis manual (pisah koma atau baris baru) dan/atau pilih <strong>Grup Kontak</strong> yang sudah kamu simpan di halaman Kontak.</p>
            <p>Pakai placeholder <code class="rounded bg-slate-100 px-1 py-0.5">{{nama}}</code> di isi pesan supaya tiap penerima disapa dengan namanya masing-masing — placeholder ini hanya terisi untuk tujuan yang berasal dari grup kontak (karena nomor manual tidak punya data nama). Ada juga dropdown <strong>Pakai template</strong> untuk langsung isi pesan dari Template yang sudah dibuat.</p>
            <p>Jumlah broadcast per hari ikut memotong kuota harian pesan sesuai paket kamu.</p>
        `)}

        ${renderManualSection("schedule", "Jadwalkan Pesan", `
            <p>Atur pesan supaya terkirim otomatis di waktu tertentu di masa depan. Isi nomor tujuan (atau pilih dari <strong>Pilih kontak</strong>), pesan (atau <strong>Pakai template</strong>), dan waktu kirim.</p>
            <p>Kuota &amp; masa aktif paket dicek ulang <strong>saat pesan benar-benar dikirim</strong>, bukan saat dijadwalkan — jadi kalau paket kamu habis sebelum waktunya tiba, pesan itu akan gagal terkirim (statusnya berubah jadi "failed").</p>
            <p>Daftar di bawah form menampilkan semua pesan terjadwal beserta statusnya (pending/sent/failed/cancelled). Pesan yang masih "pending" bisa dibatalkan lewat tombol <strong>Batalkan</strong>.</p>
        `)}

        ${renderManualSection("contacts", "Kontak &amp; Template", `
            <p>Halaman ini punya 2 sub-tab:</p>
            <p><strong>Kontak</strong> — buku alamat pribadi kamu. Simpan nama, nomor WA, dan grup (opsional) supaya tidak perlu ketik ulang nomor tiap kirim pesan. Bisa juga import banyak kontak sekaligus. Kontak individual dipakai sebagai pilihan cepat di form Uji API dan Jadwalkan Pesan; grup kontak dipakai sebagai pilihan tujuan massal di Broadcast.</p>
            <p><strong>Template Pesan</strong> — simpan format pesan yang sering dipakai (promo, reminder, dsb) supaya tidak ngetik dari nol. Mendukung placeholder <code class="rounded bg-slate-100 px-1 py-0.5">{{nama}}</code> dan <code class="rounded bg-slate-100 px-1 py-0.5">{{nomor}}</code> yang otomatis diganti data penerima saat dipakai lewat Broadcast (dengan grup kontak).</p>
        `)}

        ${renderManualSection("autoreply", "Balas Otomatis", `
            <p>Buat aturan supaya akun WAG kamu otomatis membalas pesan masuk yang mengandung kata kunci tertentu — cocok untuk FAQ, jam operasional, dsb.</p>
            <p>Tiap aturan punya: <strong>Kata Kunci</strong>, <strong>Cara Cocok</strong> (mengandung kata / sama persis / diawali kata), <strong>Berlaku di Akun</strong> (bisa semua akun WAG kamu atau salah satu saja), dan <strong>Isi Balasan</strong> (mendukung <code class="rounded bg-slate-100 px-1 py-0.5">{{nama}}</code>).</p>
            <p>Klik <strong>Edit</strong> pada aturan yang sudah ada untuk mengubah semua bagiannya (bukan cuma aktif/nonaktif) — form yang sama dipakai ulang, lengkap dengan tombol Batal. Balas otomatis tetap memotong kuota kirim harian kamu.</p>
        `)}

        ${renderManualSection("inbox", "Pesan Masuk", `
            <p>Menampilkan riwayat pesan WhatsApp yang <strong>masuk</strong> ke akun WAG kamu (bukan yang kamu kirim) — berguna untuk memantau balasan pelanggan tanpa buka HP. Jumlah yang disimpan dibatasi (entri terlama otomatis dibuang kalau sudah penuh).</p>
        `)}

        ${renderManualSection("plans", "Paket Langganan", `
            <p>Paket <strong>Free</strong>: 1 akun WAG, 10 pesan/hari, tanpa masa berlaku (selamanya, selama tidak melanggar aturan). Paket <strong>Pro</strong> dan <strong>Max</strong> memberi kuota pesan/hari &amp; jumlah akun WAG lebih banyak, berlaku 30 hari sejak diaktifkan admin.</p>
            <p>Klik paket yang diinginkan untuk membuka halaman upgrade — di sana ada tombol chat WhatsApp ke admin untuk konfirmasi pembayaran (tidak ada payment gateway otomatis, semua dikonfirmasi manual oleh admin).</p>
            <p><strong>Penting:</strong> kalau paket berbayar kamu habis masa aktifnya, akun <strong>tidak otomatis turun ke Free</strong>. Fitur kirim pesan &amp; request akun baru akan diblokir sementara (kuota jadi 0) sampai admin memperpanjang, atau kamu balas "2" di chat WhatsApp pengingat untuk memilih turun ke Free secara sadar.</p>
        `)}

        ${renderManualSection("embed", "Embed Widget QR", `
            <p>Menyediakan potongan kode (HTML) untuk ditempel di website lain, menampilkan status &amp; QR scan salah satu akun WAG kamu secara live — misalnya untuk halaman "Hubungi Kami via WhatsApp" di toko online kamu sendiri.</p>
            <p>Kalau alamat gateway ini masih memakai <code class="rounded bg-slate-100 px-1 py-0.5">localhost</code>, kode itu cuma jalan di komputer ini — minta admin isi "URL Publik" di Pengaturan supaya bisa dipakai dari website lain.</p>
        `)}

        ${renderManualSection("history", "Riwayat Kirim", `
            <p>Log semua pesan yang pernah kamu kirim (manual, broadcast, terjadwal, auto-reply) beserta statusnya. Bisa diexport ke CSV untuk dibuka di Excel/Spreadsheet.</p>
        `)}

        ${renderManualSection("mobile-nav", "Navigasi di HP", `
            <p>Di layar HP, menu utama ada di <strong>bar bawah</strong> (Akun, Broadcast, Terjadwal, Kontak). Tombol <strong>Lainnya</strong> membuka panel dari bawah berisi menu sisanya (Uji API, Balas Otomatis, Pesan Masuk, Paket, Embed QR, Riwayat, Dokumentasi, Keluar).</p>
            <p>Panel "Lainnya" itu bisa ditutup dengan cara digeser ke bawah (tarik bagian tuas abu-abu di atasnya, pakai jari), diklik area gelap di sekitarnya, atau otomatis tertutup begitu kamu pilih salah satu menunya.</p>
        `)}

        ${renderManualSection("faq", "Tanya Jawab Singkat", `
            <ul class="list-disc space-y-1.5 pl-5">
                <li><strong>Kenapa API key saya tidak pernah terlihat lengkap di layar?</strong> Untuk keamanan — key lengkap cuma dikirim sekali lewat WhatsApp ke nomor terdaftar. Simpan baik-baik.</li>
                <li><strong>Kenapa tidak bisa generate API key sendiri?</strong> Regenerasi key sengaja dibuat admin-only supaya tidak sembarang orang bisa mematikan integrasi yang sedang berjalan.</li>
                <li><strong>Pesan gagal terkirim, kenapa?</strong> Cek status akun WAG (harus "Terhubung"), sisa kuota harian, dan format nomor tujuan (pakai kode negara, contoh 628123456789 tanpa tanda + atau spasi).</li>
                <li><strong>Paket saya habis tapi saya belum sempat bayar, apa yang terjadi?</strong> Kirim pesan &amp; request akun baru diblokir sementara, tapi data &amp; pengaturan kamu tetap aman — tinggal minta admin perpanjang.</li>
            </ul>
        `)}
    `;

  return renderManualShell({ role: "Pengguna", username: user?.username, backHref: "/app", content });
}

function renderAdminManualPage() {
  const sections = [
    { id: "mulai", title: "Login Admin" },
    { id: "dashboard", title: "Dashboard &amp; Akun WhatsApp Admin" },
    { id: "kirim", title: "Kirim Pesan" },
    { id: "broadcast", title: "Broadcast" },
    { id: "schedule", title: "Terjadwal" },
    { id: "autoreply", title: "Balas Otomatis (Akun Admin)" },
    { id: "history-logs", title: "Riwayat &amp; Logs" },
    { id: "requests", title: "Persetujuan" },
    { id: "users", title: "Pengguna" },
    { id: "settings", title: "Pengaturan" },
    { id: "faq", title: "Tanya Jawab Singkat" },
  ];

  const settingsTable = SETTINGS_GROUPS.map((group) => `
        <div class="mt-3 break-inside-avoid">
            <p class="text-sm font-semibold text-slate-800">${escapeHtml(group.label)}</p>
            <table class="mt-1.5 w-full text-xs">
                <tbody class="divide-y divide-slate-100">
                    ${group.fields.map((f) => `<tr>
                        <td class="w-1/3 py-1.5 pr-3 align-top font-medium text-slate-600">${escapeHtml(f.label)}</td>
                        <td class="py-1.5 align-top text-slate-500">${escapeHtml(f.help || "-")}</td>
                    </tr>`).join("")}
                </tbody>
            </table>
        </div>`).join("");

  const content = `
        <h1 class="text-2xl font-bold text-slate-900">Panduan Admin</h1>
        <p class="mt-1 text-sm text-slate-500">${escapeHtml(APP_NAME)} — cara mengelola pengguna, akun WhatsApp milik bisnis, persetujuan, dan konfigurasi server.</p>

        ${renderManualToc(sections)}

        ${renderManualSection("mulai", "Login Admin", `
            <p>Buka halaman <code class="rounded bg-slate-100 px-1 py-0.5">/login</code> dan masuk pakai akun admin. Dashboard admin terpisah total dari Portal Pengguna (<code class="rounded bg-slate-100 px-1 py-0.5">/app</code>) — akun admin tidak ikut aturan paket/kuota seperti akun user biasa.</p>
        `)}

        ${renderManualSection("dashboard", "Dashboard &amp; Akun WhatsApp Admin", `
            <p>Menampilkan semua akun WhatsApp milik <strong>admin sendiri</strong> (berbeda dari akun WAG milik masing-masing user). Dari sini kamu bisa tambah akun WhatsApp baru untuk dipakai fitur Kirim Pesan/Broadcast/Balas Otomatis milik admin, scan QR-nya, dan memutuskannya.</p>
        `)}

        ${renderManualSection("kirim", "Kirim Pesan", `
            <p>Kirim pesan manual satu-satu lewat salah satu akun WhatsApp admin — berguna untuk testing cepat atau balas manual ke pelanggan.</p>
            <p>Kalau muncul error <code class="rounded bg-slate-100 px-1 py-0.5">not-acceptable</code>, itu bukan bug aplikasi — itu penolakan mentah dari server WhatsApp sendiri (biasanya karena versi protokol yang perlu diperbarui, masalah identitas LID, atau sesi perlu di-scan ulang). Coba hapus &amp; scan ulang akun tersebut di Dashboard.</p>
        `)}

        ${renderManualSection("broadcast", "Broadcast", `
            <p>Sama seperti Broadcast di sisi user, tapi memakai akun WhatsApp milik admin dan tidak dibatasi kuota paket.</p>
        `)}

        ${renderManualSection("schedule", "Terjadwal", `
            <p>Jadwalkan pesan admin untuk terkirim otomatis di waktu tertentu, memakai akun WhatsApp admin.</p>
        `)}

        ${renderManualSection("autoreply", "Balas Otomatis (Akun Admin)", `
            <p>Sama seperti Balas Otomatis di sisi user, tapi <strong>khusus untuk akun WhatsApp milik admin</strong> (mis. nomor CS resmi bisnis) — aturan di sini terpisah total dari aturan balas otomatis milik masing-masing user, dan tidak dipotong kuota apa pun.</p>
        `)}

        ${renderManualSection("history-logs", "Riwayat &amp; Logs", `
            <p><strong>Riwayat</strong> mencatat semua pesan yang dikirim lewat akun admin. <strong>Logs</strong> menampilkan log teknis server (koneksi WhatsApp, error, dsb) — berguna untuk troubleshooting.</p>
        `)}

        ${renderManualSection("requests", "Persetujuan", `
            <p>Halaman ini menggabungkan 3 hal:</p>
            <p><strong>Notifikasi WhatsApp &amp; Harga Paket</strong> — pilih akun WhatsApp admin mana yang dipakai mengirim notifikasi otomatis sistem, nomor WA admin tujuan notifikasi, dan harga paket Pro/Max yang ditampilkan ke user.</p>
            <p><strong>Metode Pembayaran &amp; Auto-Reply</strong> — begitu ada chat masuk ke akun notifikasi yang menyebut "upgrade paket", bot otomatis membalas menu metode pembayaran (DANA/QRIS/Mandiri) sesuai data yang kamu isi di sini, termasuk gambar QRIS.</p>
            <p><strong>Permintaan Akun WAG Menunggu Persetujuan</strong> — daftar permintaan akun WAG baru dari user. Akun baru <strong>tidak akan aktif</strong> (tidak muncul QR-nya) sampai kamu approve di sini.</p>
        `)}

        ${renderManualSection("users", "Pengguna", `
            <p>Daftar semua user terdaftar beserta jumlah akun WAG, pemakaian pesan hari ini, paket, dan tanggal kadaluarsa (merah kalau sudah lewat). Badge kuning menandakan user sudah minta upgrade sendiri lewat portalnya.</p>
            <p>Untuk tiap user tersedia 3 aksi:</p>
            <ul class="list-disc space-y-1 pl-5">
                <li><strong>Simpan Paket</strong> — ganti paket user (Free/Pro/Max) setelah user konfirmasi bayar manual. Paket Pro/Max otomatis berlaku 30 hari sejak disimpan.</li>
                <li><strong>Reset API Key</strong> — generate ulang API key user (key baru otomatis dikirim ke WhatsApp terdaftar user). Ini satu-satunya cara API key berubah — user tidak bisa generate sendiri.</li>
                <li><strong>Hapus</strong> — hapus akun user beserta seluruh datanya.</li>
            </ul>
            <p><strong>Penting:</strong> kalau paket berbayar user lewat masa aktifnya, sistem <strong>tidak otomatis menurunkan ke Free</strong> — fitur kirim &amp; request akun baru diblokir sementara sampai kamu perpanjang manual di sini.</p>
        `)}

        ${renderManualSection("settings", "Pengaturan", `
            <p>Semua konfigurasi server (isi file <code class="rounded bg-slate-100 px-1 py-0.5">.env</code>) bisa diubah lewat halaman ini tanpa edit file manual, dikelompokkan per kategori dan bisa dicari. Sebagian pengaturan butuh restart server manual (mis. layanan Windows "Wag") supaya berlaku.</p>
            ${settingsTable}
        `)}

        ${renderManualSection("faq", "Tanya Jawab Singkat", `
            <ul class="list-disc space-y-1.5 pl-5">
                <li><strong>User komplain fitur baru belum muncul padahal sudah di-deploy?</strong> Pastikan service aplikasi sudah di-restart setelah update kode (mis. <code class="rounded bg-slate-100 px-1 py-0.5">Restart-Service -Name "Wag" -Force</code> di server Windows).</li>
                <li><strong>Kenapa akun user baru tidak muncul QR-nya?</strong> Harus di-approve dulu lewat tab Persetujuan.</li>
                <li><strong>User minta API key baru, harus ke mana?</strong> Tab Pengguna &rarr; tombol Reset API Key pada baris user tersebut.</li>
                <li><strong>Boleh menurunkan paket user yang belum bayar ke Free langsung?</strong> Sistem sengaja tidak melakukan ini otomatis. Kalau memang perlu, ubah manual lewat Simpan Paket setelah dikonfirmasi ke user.</li>
            </ul>
        `)}
    `;

  return renderManualShell({ role: "Admin", username: null, backHref: "/", content });
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

app.get("/app/manual", requireUserSession, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.send(renderUserManualPage(req.user));
});

app.get("/manual", requireAdminSession, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.send(renderAdminManualPage());
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

app.post("/api/auth/admin/login", async (req, res) => {
  const { username, password } = req.body || {};
  const clientIp = getClientIp(req);
  const attemptKey = loginAttemptKey("admin", username, clientIp);

  const lockoutSeconds = getLoginLockoutSeconds(attemptKey);
  if (lockoutSeconds > 0) {
    logger.warn(`[${req.id}] Login admin ditolak: terlalu banyak percobaan gagal`, { clientIp, username });
    return res.status(429).json({
      success: false,
      message: `Terlalu banyak percobaan login gagal. Coba lagi dalam ${Math.ceil(lockoutSeconds / 60)} menit.`,
      requestId: req.id,
    });
  }

  const row = await dbGet("SELECT * FROM admins WHERE username = ?", [String(username || "").trim()]);

  if (!row || !verifyPassword(String(password || ""), row.passwordSalt, row.passwordHash)) {
    recordFailedLogin(attemptKey);
    logger.warn(`[${req.id}] Login admin gagal`, { clientIp, username });
    return res.status(401).json({ success: false, message: "Username atau password salah", requestId: req.id });
  }

  clearLoginAttempts(attemptKey);

  const token = await createWebSession("admin", row.id);
  setSessionCookie(req, res, "wa_admin_sid", token, SESSION_TTL_MS / 1000);

  logger.info(`[${req.id}] Admin login`, { username: row.username });

  return res.json({ success: true, message: "Login berhasil", requestId: req.id });
});

app.post("/api/auth/admin/logout", async (req, res) => {
  const cookies = parseCookies(req);
  await deleteWebSession(cookies.wa_admin_sid);
  clearSessionCookie(req, res, "wa_admin_sid");
  return res.json({ success: true, message: "Logout berhasil", requestId: req.id });
});

app.post("/api/auth/register", async (req, res) => {
  const { username, password, phone } = req.body || {};

  try {
    const user = await createUser(username, password, phone);
    const token = await createWebSession("user", user.id);
    setSessionCookie(req, res, "wa_user_sid", token, SESSION_TTL_MS / 1000);

    const apiKey = await generateApiKeyForUser(user.id, user.phone);
    const delivered = await sendUserNotification(
      user.phone,
      `Halo ${user.username}, akun kamu berhasil dibuat!\n\nAPI Key kamu:\n${apiKey}\n\nDipakai untuk kirim pesan lewat API dari sistem/aplikasi kamu sendiri (lihat tab Dokumentasi API di ${PUBLIC_BASE_URL || ""}/app). Kunci ini cuma dikirim sekali lewat WhatsApp ke nomor ini — kalau hilang, hubungi admin lewat tombol chat WA di tab Dokumentasi API untuk minta dibuatkan ulang.\n\n⚠️ JANGAN bagikan API key ini ke siapa pun. Siapa saja yang punya key ini bisa kirim pesan atas nama akun kamu.`,
    );

    logger.info(`[${req.id}] User baru mendaftar`, { username: user.username, apiKeyDelivered: delivered });

    return res.json({
      success: true,
      message: delivered
        ? "Registrasi berhasil. API key sudah dikirim ke WhatsApp kamu."
        : "Registrasi berhasil, tapi API key gagal dikirim ke WhatsApp (WAG notifier belum terhubung). Buka tab Dokumentasi API setelah login untuk generate ulang.",
      user,
      apiKeyDelivered: delivered,
      requestId: req.id,
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  const clientIp = getClientIp(req);
  const attemptKey = loginAttemptKey("user", username, clientIp);

  const lockoutSeconds = getLoginLockoutSeconds(attemptKey);
  if (lockoutSeconds > 0) {
    logger.warn(`[${req.id}] Login user ditolak: terlalu banyak percobaan gagal`, { clientIp, username });
    return res.status(429).json({
      success: false,
      message: `Terlalu banyak percobaan login gagal. Coba lagi dalam ${Math.ceil(lockoutSeconds / 60)} menit.`,
      requestId: req.id,
    });
  }

  const row = await findUserByUsername(username);

  if (!row || !verifyPassword(String(password || ""), row.passwordSalt, row.passwordHash)) {
    recordFailedLogin(attemptKey);
    logger.warn(`[${req.id}] Login user gagal`, { clientIp, username });
    return res.status(401).json({ success: false, message: "Username atau password salah", requestId: req.id });
  }

  clearLoginAttempts(attemptKey);

  const token = await createWebSession("user", row.id);
  setSessionCookie(req, res, "wa_user_sid", token, SESSION_TTL_MS / 1000);

  logger.info(`[${req.id}] User login`, { username: row.username });

  return res.json({ success: true, message: "Login berhasil", user: rowToUser(row), requestId: req.id });
});

app.post("/api/auth/logout", async (req, res) => {
  const cookies = parseCookies(req);
  await deleteWebSession(cookies.wa_user_sid);
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

app.get("/api/my/sessions", requireUserSession, async (req, res) => {
  const rows = await listUserSessionRows(req.user.id);

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    maxAccounts: req.user.maxAccounts,
    plan: req.user.plan,
    planLabel: req.user.planLabel,
    planExpiresAt: req.user.planExpiresAt,
    planExpired: req.user.planExpired,
    pendingPlanRequest: req.user.pendingPlanRequest,
    dailyMessageLimit: req.user.dailyMessageLimit,
    messagesToday: await countUserMessagesToday(req.user.id),
    entries: rows.map(sessionRowToPublic),
    requestId: req.id,
  });
});

app.get("/api/my/sessions/:id/qr", requireUserSession, async (req, res) => {
  const row = await getSessionRow(req.params.id);
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

app.post("/api/my/sessions", requireUserSession, async (req, res) => {
  if (req.user.planExpired) {
    const expiredDate = new Date(req.user.planExpiresAt).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
    return res.status(402).json({
      success: false,
      message: `Paket ${req.user.planLabel} kamu sudah kadaluarsa sejak ${expiredDate}. Perpanjang dulu lewat admin sebelum bisa tambah akun WAG baru.`,
      requestId: req.id,
    });
  }

  const activeCount = await countUserSessions(req.user.id);

  if (activeCount >= req.user.maxAccounts) {
    return res.status(400).json({
      success: false,
      message: `Kuota akun WAG kamu sudah penuh (${activeCount}/${req.user.maxAccounts}). Hubungi admin untuk upgrade paket.`,
      requestId: req.id,
    });
  }

  const name = String((req.body && req.body.name) || "").trim();
  const row = await createPendingWagRequest(req.user, name);

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

  const row = await getSessionRow(sessionId);
  if (!row || row.ownerType !== "user" || row.ownerUserId !== req.user.id || row.status !== "active") {
    return res.status(404).json({ success: false, message: "Akun WAG tidak ditemukan", requestId: req.id });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, message: "Akun WAG tidak ditemukan", requestId: req.id });
  }

  if (req.user.planExpired) {
    const expiredDate = new Date(req.user.planExpiresAt).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
    return res.status(402).json({
      success: false,
      message: `Paket ${req.user.planLabel} kamu sudah kadaluarsa sejak ${expiredDate}. Perpanjang dulu lewat admin sebelum bisa kirim pesan lagi.`,
      requestId: req.id,
    });
  }

  const limit = req.user.dailyMessageLimit;
  const usedToday = await countUserMessagesToday(req.user.id);

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

    await recordHistory({
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
    await recordHistory({
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

// Resolve akun WAG + validasi paket & kuota untuk endpoint API eksternal.
// Mengembalikan { session, limit, usedToday } kalau lolos, atau null kalau
// sudah mengirim response error sendiri (caller tinggal `return`).
async function resolveExternalSendContext(req, res) {
  const sessionId = req.body && req.body.session;

  let row;
  if (sessionId) {
    row = await getSessionRow(sessionId);
    if (!row || row.ownerType !== "user" || row.ownerUserId !== req.user.id || row.status !== "active") {
      res.status(404).json({ success: false, message: "Akun WAG tidak ditemukan", requestId: req.id });
      return null;
    }
  } else {
    const ownedSessions = await listUserSessionRows(req.user.id);
    row = ownedSessions.find((r) => r.status === "active");
    if (!row) {
      res.status(404).json({
        success: false,
        message: "Belum ada akun WAG aktif. Isi parameter 'session' atau approve dulu akun WAG-mu.",
        requestId: req.id,
      });
      return null;
    }
  }

  const session = sessions.get(row.id);
  if (!session) {
    res.status(404).json({ success: false, message: "Akun WAG tidak ditemukan", requestId: req.id });
    return null;
  }

  if (req.user.planExpired) {
    const expiredDate = new Date(req.user.planExpiresAt).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
    res.status(402).json({
      success: false,
      message: `Paket ${req.user.planLabel} kamu sudah kadaluarsa sejak ${expiredDate}. Perpanjang dulu lewat admin sebelum bisa kirim pesan lagi.`,
      requestId: req.id,
    });
    return null;
  }

  const limit = req.user.dailyMessageLimit;
  const usedToday = await countUserMessagesToday(req.user.id);

  if (usedToday >= limit) {
    res.status(429).json({
      success: false,
      message: `Kuota kirim pesan harian kamu sudah habis (${usedToday}/${limit}). Upgrade paket untuk kirim lebih banyak.`,
      requestId: req.id,
    });
    return null;
  }

  return { session, limit, usedToday };
}

app.post("/api/external/send", requireUserApiKey, async (req, res) => {
  const { number, message } = req.body || {};

  const context = await resolveExternalSendContext(req, res);
  if (!context) {
    return;
  }
  const { session, limit, usedToday } = context;

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

    await recordHistory({
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
    await recordHistory({
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

// Kirim gambar/dokumen/video/audio lewat API key user. Body multipart:
// file (wajib), number (wajib), caption & session (opsional). Jenis pesan WA
// ditentukan otomatis dari mimetype-nya (lihat buildMediaMessage).
app.post(
  "/api/external/send-file",
  requireUserApiKey,
  (req, res, next) => {
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
  },
  async (req, res) => {
    const context = await resolveExternalSendContext(req, res);
    if (!context) {
      return;
    }
    const { session, limit, usedToday } = context;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "File wajib diunggah pada field 'file'",
        requestId: req.id,
      });
    }

    let jid;
    let caption;
    try {
      jid = normalizeRecipient(req.body.number);
      caption = normalizeOptionalCaption(req.body.caption);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message, requestId: req.id });
    }

    const maskedJid = maskDestination(jid);
    const type = caption ? "file+text" : "file";

    try {
      const content = buildMediaMessage(req.file, caption);
      const { result } = await enqueueMessageSend(session, { jid, content });

      await recordHistory({
        source: "external_api",
        sessionId: session.id,
        to: maskedJid,
        type,
        message: (caption || req.file.originalname || "").slice(0, 120),
        status: "sent",
        messageId: result?.key?.id,
      });

      logger.info(`[${req.id}] User kirim file lewat API eksternal`, {
        user: req.user.username,
        to: maskedJid,
        fileName: req.file.originalname,
        mimetype: req.file.mimetype,
      });

      return res.json({
        success: true,
        message: "File berhasil dikirim",
        messageId: result?.key?.id,
        remaining: Math.max(0, limit - usedToday - 1),
        requestId: req.id,
      });
    } catch (error) {
      await recordHistory({
        source: "external_api",
        sessionId: session.id,
        to: maskedJid,
        type,
        message: (caption || req.file.originalname || "").slice(0, 120),
        status: "failed",
        error: error.message,
      });

      const statusCode = error.code === "NOT_CONNECTED" ? 503 : 500;
      return res.status(statusCode).json({ success: false, message: error.message, requestId: req.id });
    }
  },
);

// ---------------------------------------------------------------------------
// Broadcast & pesan terjadwal MILIK USER. Sebelumnya dua fitur ini cuma bisa
// dipakai admin (lewat API key global), padahal user berbayar juga butuh.
// Dipakai bareng oleh portal (cookie) & API eksternal (x-api-key user).
// ---------------------------------------------------------------------------

// Rakit daftar tujuan broadcast dari input mentah: bisa dari nomor manual,
// dan/atau dari grup kontak milik user. Mengembalikan { targets, error }.
async function buildBroadcastTargets(userId, rawNumbers, contactGroup) {
  const targets = [];
  const seen = new Set();

  const pushTarget = (rawValue, contactName) => {
    let jid;
    try {
      jid = normalizeRecipient(rawValue);
    } catch {
      return;
    }
    if (seen.has(jid)) {
      return;
    }
    seen.add(jid);
    targets.push({ jid, name: contactName || "" });
  };

  String(rawNumbers || "")
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => pushTarget(value, ""));

  if (contactGroup) {
    const rows = await dbAll("SELECT name, phone FROM contacts WHERE user_id = ? AND group_name = ?", [
      userId,
      contactGroup,
    ]);
    rows.forEach((row) => pushTarget(row.phone, row.name));
  }

  if (!targets.length) {
    return { targets: null, error: "Tidak ada nomor tujuan yang valid. Isi nomor manual atau pilih grup kontak." };
  }
  if (targets.length > MAX_BROADCAST_TARGETS) {
    return { targets: null, error: `Maksimum ${MAX_BROADCAST_TARGETS} nomor per broadcast` };
  }

  return { targets, error: null };
}

// Inti broadcast user, dipakai endpoint portal maupun API eksternal.
async function handleUserBroadcast(req, res, source) {
  const context = await resolveExternalSendContext(req, res);
  if (!context) {
    return;
  }
  const { session, limit, usedToday } = context;

  const { numbers, contactGroup, message } = req.body || {};

  let text;
  try {
    text = normalizeMessage(message);
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }

  const { targets, error: targetError } = await buildBroadcastTargets(req.user.id, numbers, contactGroup);
  if (targetError) {
    return res.status(400).json({ success: false, message: targetError, requestId: req.id });
  }

  // Broadcast memakan kuota sebanyak jumlah tujuannya — dicek di depan supaya
  // user tidak "kebobolan" mengirim melebihi paketnya.
  const remaining = limit - usedToday;
  if (targets.length > remaining) {
    return res.status(429).json({
      success: false,
      message: `Sisa kuota harian kamu ${remaining} pesan, sedangkan broadcast ini butuh ${targets.length}. Kurangi jumlah tujuan atau upgrade paket.`,
      requestId: req.id,
    });
  }

  logger.info(`[${req.id}] Broadcast user dimulai`, {
    user: req.user.username,
    session: session.id,
    total: targets.length,
    source,
  });

  // Dikirim di belakang layar lewat antrean internal — response langsung balik
  // supaya request HTTP tidak menggantung menunggu ratusan pesan.
  targets.forEach(({ jid, name }) => {
    const maskedJid = maskDestination(jid);
    const personalized = renderTemplateContent(text, {
      nama: name,
      nomor: String(jid).split("@")[0],
    });

    enqueueMessageSend(session, { jid, content: { text: personalized } })
      .then(({ result }) => {
        recordHistory({
          source,
          sessionId: session.id,
          to: maskedJid,
          type: "text",
          message: personalized.slice(0, 120),
          status: "sent",
          messageId: result?.key?.id,
          requestId: req.id,
        });
      })
      .catch((error) => {
        recordHistory({
          source,
          sessionId: session.id,
          to: maskedJid,
          type: "text",
          message: personalized.slice(0, 120),
          status: "failed",
          error: error.message,
          requestId: req.id,
        });
      });
  });

  return res.json({
    success: true,
    message: `Broadcast dijadwalkan ke ${targets.length} nomor. Cek tab Riwayat Kirim untuk status pengiriman.`,
    total: targets.length,
    remaining: Math.max(0, remaining - targets.length),
    requestId: req.id,
  });
}

app.post("/api/my/broadcast", requireUserSession, (req, res) => handleUserBroadcast(req, res, "user_broadcast"));
app.post("/api/external/broadcast", requireUserApiKey, (req, res) => handleUserBroadcast(req, res, "external_broadcast"));

// Inti penjadwalan pesan milik user.
async function handleUserSchedule(req, res) {
  const context = await resolveExternalSendContext(req, res);
  if (!context) {
    return;
  }
  const { session } = context;

  const { number, message, sendAt } = req.body || {};

  let jid;
  let text;
  let sendAtDate;
  try {
    jid = normalizeRecipient(number);
    text = normalizeMessage(message);

    if (!sendAt) {
      throw new Error("Waktu pengiriman (sendAt) wajib diisi");
    }
    sendAtDate = new Date(sendAt);
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
  await dbRun(
    `INSERT INTO scheduled_messages (id, session_id, owner_user_id, jid, recipient, message, has_file, send_at, status, created_at)
     VALUES (@id, @sessionId, @ownerUserId, @jid, @recipient, @message, 0, @sendAt, 'pending', @createdAt)`,
    {
      id,
      sessionId: session.id,
      ownerUserId: req.user.id,
      jid,
      recipient: maskDestination(jid),
      message: text,
      sendAt: sendAtDate.toISOString(),
      createdAt: new Date().toISOString(),
    },
  );

  logger.info(`[${req.id}] Pesan terjadwal user dibuat`, {
    user: req.user.username,
    to: maskDestination(jid),
    sendAt: sendAtDate.toISOString(),
  });

  return res.json({
    success: true,
    message: "Pesan terjadwal berhasil dibuat",
    id,
    sendAt: sendAtDate.toISOString(),
    requestId: req.id,
  });
}

app.post("/api/my/schedule", requireUserSession, (req, res) => handleUserSchedule(req, res));
app.post("/api/external/schedule", requireUserApiKey, (req, res) => handleUserSchedule(req, res));

app.get("/api/my/schedule", requireUserSession, async (req, res) => {
  const rows = await dbAll(
    "SELECT * FROM scheduled_messages WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 100",
    [req.user.id],
  );

  const sessionRows = await listUserSessionRows(req.user.id);
  const sessionNameById = new Map(sessionRows.map((row) => [row.id, row.name]));

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    entries: rows.map((row) => ({
      id: row.id,
      sessionName: sessionNameById.get(row.sessionId) || row.sessionId,
      to: row.recipient,
      message: row.message,
      sendAt: row.sendAt,
      status: row.status,
      sentAt: row.sentAt,
      error: row.error,
      createdAt: row.createdAt,
    })),
    requestId: req.id,
  });
});

app.delete("/api/my/schedule/:id", requireUserSession, async (req, res) => {
  const row = await dbGet("SELECT * FROM scheduled_messages WHERE id = ? AND owner_user_id = ?", [
    req.params.id,
    req.user.id,
  ]);
  if (!row) {
    return res.status(404).json({ success: false, message: "Pesan terjadwal tidak ditemukan", requestId: req.id });
  }
  if (row.status !== "pending") {
    return res.status(409).json({
      success: false,
      message: `Pesan terjadwal sudah berstatus '${row.status}', tidak bisa dibatalkan`,
      requestId: req.id,
    });
  }

  await dbRun("UPDATE scheduled_messages SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [
    new Date().toISOString(),
    req.params.id,
  ]);

  return res.json({ success: true, message: "Pesan terjadwal dibatalkan", requestId: req.id });
});

app.get("/api/my/plans", requireUserSession, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    plans: await getPlansWithPricing(),
    adminWaNumber: (await getConfig("adminNotifyPhone")) || "",
    requestId: req.id,
  });
});

// --- Webhook milik user sendiri ---------------------------------------------

app.get("/api/my/webhook", requireUserSession, async (req, res) => {
  const row = await findUserById(req.user.id);

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    webhookUrl: row?.webhookUrl || "",
    webhookSecret: row?.webhookSecret || "",
    requestId: req.id,
  });
});

app.post("/api/my/webhook", requireUserSession, async (req, res) => {
  const rawUrl = String((req.body && req.body.webhookUrl) || "").trim();
  const rawSecret = String((req.body && req.body.webhookSecret) || "").trim();

  // URL kosong = matikan webhook. Kalau diisi, wajib http(s) yang valid —
  // dicek di sini supaya tidak menyimpan URL yang pasti gagal saat dikirim.
  if (rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return res.status(400).json({ success: false, message: "URL webhook tidak valid", requestId: req.id });
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return res.status(400).json({
        success: false,
        message: "URL webhook harus diawali http:// atau https://",
        requestId: req.id,
      });
    }
  }

  await dbRun("UPDATE users SET webhook_url = ?, webhook_secret = ? WHERE id = ?", [
    rawUrl || null,
    rawSecret || null,
    req.user.id,
  ]);

  logger.info(`[${req.id}] Webhook user diperbarui`, { user: req.user.username, enabled: Boolean(rawUrl) });

  return res.json({
    success: true,
    message: rawUrl ? "Webhook tersimpan" : "Webhook dinonaktifkan",
    requestId: req.id,
  });
});

// --- Riwayat kirim milik user sendiri ---------------------------------------

app.get("/api/my/history", requireUserSession, async (req, res) => {
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));

  // Dibatasi hanya akun WAG milik user ini — user tidak boleh melihat riwayat
  // pengiriman milik user lain / akun WAG admin.
  const sessionRows = await listUserSessionRows(req.user.id);
  const sessionIds = sessionRows.map((row) => row.id);

  res.setHeader("Cache-Control", "no-store");

  if (!sessionIds.length) {
    return res.json({ success: true, entries: [], total: 0, requestId: req.id });
  }

  const placeholders = sessionIds.map(() => "?").join(",");
  const rows = await dbAll(
    `SELECT * FROM message_history WHERE session_id IN (${placeholders}) ORDER BY seq DESC LIMIT ?`,
    [...sessionIds, limit],
  );
  const totalRow = await dbGet(
    `SELECT COUNT(*) AS c FROM message_history WHERE session_id IN (${placeholders})`,
    sessionIds,
  );

  const sessionNameById = new Map(sessionRows.map((row) => [row.id, row.name]));

  return res.json({
    success: true,
    entries: rows.map((row) => ({
      ...rowToHistoryEntry(row),
      sessionName: sessionNameById.get(row.sessionId) || row.sessionId,
    })),
    total: totalRow.c,
    requestId: req.id,
  });
});

// --- Analitik, export, & log webhook milik user -----------------------------

app.get("/api/my/analytics", requireUserSession, async (req, res) => {
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));

  const sessionRows = await listUserSessionRows(req.user.id);
  const sessionIds = sessionRows.map((row) => row.id);

  res.setHeader("Cache-Control", "no-store");

  if (!sessionIds.length) {
    return res.json({ success: true, days, daily: [], totals: { sent: 0, failed: 0, incoming: 0 }, requestId: req.id });
  }

  const placeholders = sessionIds.map(() => "?").join(",");
  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  since.setHours(0, 0, 0, 0);
  const sinceIso = since.toISOString();

  // Pengelompokan hari WAJIB pakai zona waktu lokal server (TZ di .env), bukan
  // UTC. Kalau pakai UTC, di zona seperti Asia/Jakarta (UTC+7) pesan sore hari
  // akan terhitung di tanggal berikutnya/sebelumnya — grafiknya jadi salah
  // sehari. Postgres mengembalikan hari sebagai TEXT supaya tidak ada
  // konversi Date bolak-balik di sisi JS yang bisa menggeser tanggal lagi.
  const groupTz = process.env.TZ || "UTC";
  const dayExpr = `to_char(timestamp::timestamptz AT TIME ZONE '${groupTz.replace(/'/g, "''")}', 'YYYY-MM-DD')`;

  const outgoing = await dbAll(
    `SELECT ${dayExpr} AS day, status, COUNT(*) AS c
     FROM message_history
     WHERE session_id IN (${placeholders}) AND timestamp >= ?
     GROUP BY 1, status`,
    [...sessionIds, sinceIso],
  );

  const incoming = await dbAll(
    `SELECT ${dayExpr} AS day, COUNT(*) AS c
     FROM incoming_messages
     WHERE owner_user_id = ? AND timestamp >= ?
     GROUP BY 1`,
    [req.user.id, sinceIso],
  );

  // Format tanggal lokal (bukan toISOString yang selalu UTC).
  const localDayKey = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // Rangka tanggal dibuat lengkap dulu (termasuk hari tanpa aktivitas) supaya
  // grafik di UI tidak bolong-bolong.
  const dayMap = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 24 * 60 * 60 * 1000);
    const key = localDayKey(d);
    dayMap.set(key, { date: key, sent: 0, failed: 0, incoming: 0 });
  }

  outgoing.forEach((row) => {
    const entry = dayMap.get(row.day);
    if (!entry) return;
    if (row.status === "sent") entry.sent += Number(row.c);
    else entry.failed += Number(row.c);
  });

  incoming.forEach((row) => {
    const entry = dayMap.get(row.day);
    if (entry) entry.incoming += Number(row.c);
  });

  const daily = [...dayMap.values()];
  const totals = daily.reduce(
    (acc, d) => ({ sent: acc.sent + d.sent, failed: acc.failed + d.failed, incoming: acc.incoming + d.incoming }),
    { sent: 0, failed: 0, incoming: 0 },
  );

  return res.json({ success: true, days, daily, totals, requestId: req.id });
});

// Export riwayat kirim ke CSV. Nilai di-escape sesuai aturan CSV (bungkus
// tanda kutip, gandakan kutip di dalam) supaya pesan yang mengandung koma /
// baris baru tidak merusak kolom saat dibuka di Excel.
function toCsvValue(value) {
  const str = String(value == null ? "" : value);
  return `"${str.replace(/"/g, '""')}"`;
}

app.get("/api/my/history/export", requireUserSession, async (req, res) => {
  const sessionRows = await listUserSessionRows(req.user.id);
  const sessionIds = sessionRows.map((row) => row.id);
  const sessionNameById = new Map(sessionRows.map((row) => [row.id, row.name]));

  const header = ["Waktu", "Akun WAG", "Tujuan", "Tipe", "Pesan", "Sumber", "Status", "Error"];
  let rows = [];

  if (sessionIds.length) {
    const placeholders = sessionIds.map(() => "?").join(",");
    rows = await dbAll(
      `SELECT * FROM message_history WHERE session_id IN (${placeholders}) ORDER BY seq DESC LIMIT 5000`,
      sessionIds,
    );
  }

  const lines = [header.map(toCsvValue).join(",")];
  rows.forEach((row) => {
    lines.push(
      [
        row.timestamp,
        sessionNameById.get(row.sessionId) || row.sessionId,
        row.recipient,
        row.type,
        row.message,
        row.source,
        row.status,
        row.error,
      ]
        .map(toCsvValue)
        .join(","),
    );
  });

  const filename = `riwayat-${req.user.username}-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // BOM supaya Excel di Windows membaca UTF-8 dengan benar (nama/emoji tidak
  // berubah jadi karakter aneh).
  return res.send("﻿" + lines.join("\r\n"));
});

app.get("/api/my/webhook/deliveries", requireUserSession, async (req, res) => {
  const rows = await dbAll(
    "SELECT * FROM webhook_deliveries WHERE user_id = ? ORDER BY seq DESC LIMIT 50",
    [req.user.id],
  );

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    entries: rows.map((row) => ({
      id: row.id,
      url: row.url,
      status: row.status,
      httpStatus: row.httpStatus,
      attempts: row.attempts,
      error: row.error,
      createdAt: row.createdAt,
    })),
    requestId: req.id,
  });
});

// --- Inbox pesan masuk milik user ------------------------------------------

app.get("/api/my/inbox", requireUserSession, async (req, res) => {
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));

  const rows = await dbAll(
    "SELECT * FROM incoming_messages WHERE owner_user_id = ? ORDER BY seq DESC LIMIT ?",
    [req.user.id, limit],
  );
  const totalRow = await dbGet("SELECT COUNT(*) AS c FROM incoming_messages WHERE owner_user_id = ?", [
    req.user.id,
  ]);

  const sessionRows = await listUserSessionRows(req.user.id);
  const sessionNameById = new Map(sessionRows.map((row) => [row.id, row.name]));

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    entries: rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      sessionName: sessionNameById.get(row.sessionId) || row.sessionId,
      from: row.fromMasked || row.fromJid,
      pushName: row.pushName,
      timestamp: row.timestamp,
      type: row.type,
      text: row.text,
      autoReplied: Boolean(row.autoReplied),
    })),
    total: totalRow.c,
    requestId: req.id,
  });
});

// --- Aturan balas otomatis milik user ---------------------------------------

const AUTO_REPLY_MATCH_TYPES = ["contains", "exact", "starts"];

app.get("/api/my/auto-replies", requireUserSession, async (req, res) => {
  const rows = await dbAll("SELECT * FROM auto_replies WHERE user_id = ? ORDER BY created_at ASC", [
    req.user.id,
  ]);

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    entries: rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      keyword: row.keyword,
      matchType: row.matchType,
      replyText: row.replyText,
      enabled: Boolean(row.enabled),
      createdAt: row.createdAt,
    })),
    requestId: req.id,
  });
});

app.post("/api/my/auto-replies", requireUserSession, async (req, res) => {
  const { keyword, replyText, matchType, sessionId } = req.body || {};

  const trimmedKeyword = String(keyword || "").trim();
  const trimmedReply = String(replyText || "").trim();

  if (!trimmedKeyword) {
    return res.status(400).json({ success: false, message: "Kata kunci wajib diisi", requestId: req.id });
  }
  if (!trimmedReply) {
    return res.status(400).json({ success: false, message: "Isi balasan wajib diisi", requestId: req.id });
  }

  const resolvedMatchType = AUTO_REPLY_MATCH_TYPES.includes(matchType) ? matchType : "contains";

  // sessionId opsional; kalau diisi harus benar-benar milik user ini.
  let resolvedSessionId = null;
  if (sessionId) {
    const row = await getSessionRow(sessionId);
    if (!row || row.ownerType !== "user" || row.ownerUserId !== req.user.id) {
      return res.status(404).json({ success: false, message: "Akun WAG tidak ditemukan", requestId: req.id });
    }
    resolvedSessionId = sessionId;
  }

  const id = uuidv4();
  await dbRun(
    `INSERT INTO auto_replies (id, user_id, session_id, keyword, match_type, reply_text, enabled, created_at)
     VALUES (@id, @userId, @sessionId, @keyword, @matchType, @replyText, 1, @createdAt)`,
    {
      id,
      userId: req.user.id,
      sessionId: resolvedSessionId,
      keyword: trimmedKeyword,
      matchType: resolvedMatchType,
      replyText: trimmedReply,
      createdAt: new Date().toISOString(),
    },
  );

  logger.info(`[${req.id}] Aturan balas otomatis dibuat`, { user: req.user.username, keyword: trimmedKeyword });

  return res.json({ success: true, message: "Aturan balas otomatis disimpan", id, requestId: req.id });
});

// Dipakai bareng oleh PATCH user & admin — validasi field & bangun objek
// UPDATE dari body request. sessionOwnerCheck memvalidasi sessionId sesuai
// scope pemanggilnya (user cuma boleh pilih akun WAG miliknya sendiri, admin
// cuma boleh pilih akun WAG milik admin).
async function buildAutoReplyUpdate(req, res, existing, sessionOwnerCheck) {
  const body = req.body || {};
  const update = {
    keyword: existing.keyword,
    matchType: existing.matchType,
    replyText: existing.replyText,
    sessionId: existing.sessionId,
    enabled: existing.enabled,
  };

  if (body.keyword !== undefined) {
    const trimmed = String(body.keyword).trim();
    if (!trimmed) {
      res.status(400).json({ success: false, message: "Kata kunci wajib diisi", requestId: req.id });
      return null;
    }
    update.keyword = trimmed;
  }

  if (body.replyText !== undefined) {
    const trimmed = String(body.replyText).trim();
    if (!trimmed) {
      res.status(400).json({ success: false, message: "Isi balasan wajib diisi", requestId: req.id });
      return null;
    }
    update.replyText = trimmed;
  }

  if (body.matchType !== undefined) {
    update.matchType = AUTO_REPLY_MATCH_TYPES.includes(body.matchType) ? body.matchType : "contains";
  }

  if (body.sessionId !== undefined) {
    if (body.sessionId) {
      const ok = await sessionOwnerCheck(body.sessionId);
      if (!ok) {
        res.status(404).json({ success: false, message: "Akun WAG tidak ditemukan", requestId: req.id });
        return null;
      }
      update.sessionId = body.sessionId;
    } else {
      update.sessionId = null;
    }
  }

  if (typeof body.enabled === "boolean") {
    update.enabled = body.enabled ? 1 : 0;
  }

  return update;
}

app.patch("/api/my/auto-replies/:id", requireUserSession, async (req, res) => {
  const existing = await dbGet("SELECT * FROM auto_replies WHERE id = ? AND user_id = ?", [
    req.params.id,
    req.user.id,
  ]);
  if (!existing) {
    return res.status(404).json({ success: false, message: "Aturan tidak ditemukan", requestId: req.id });
  }

  const update = await buildAutoReplyUpdate(req, res, existing, async (sessionId) => {
    const row = await getSessionRow(sessionId);
    return row && row.ownerType === "user" && row.ownerUserId === req.user.id;
  });
  if (!update) {
    return; // response error sudah dikirim di dalam buildAutoReplyUpdate
  }

  await dbRun(
    "UPDATE auto_replies SET keyword = ?, match_type = ?, reply_text = ?, session_id = ?, enabled = ? WHERE id = ?",
    [update.keyword, update.matchType, update.replyText, update.sessionId, update.enabled, req.params.id],
  );

  return res.json({ success: true, message: "Aturan disimpan", requestId: req.id });
});

app.delete("/api/my/auto-replies/:id", requireUserSession, async (req, res) => {
  const result = await dbRun("DELETE FROM auto_replies WHERE id = ? AND user_id = ?", [
    req.params.id,
    req.user.id,
  ]);
  if (result.changes === 0) {
    return res.status(404).json({ success: false, message: "Aturan tidak ditemukan", requestId: req.id });
  }
  return res.json({ success: true, message: "Aturan dihapus", requestId: req.id });
});

// --- Kontak milik user ------------------------------------------------------

app.get("/api/my/contacts", requireUserSession, async (req, res) => {
  const rows = await dbAll("SELECT * FROM contacts WHERE user_id = ? ORDER BY name ASC", [req.user.id]);
  const groups = [...new Set(rows.map((row) => row.groupName).filter(Boolean))].sort();

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    entries: rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      groupName: row.groupName || null,
    })),
    groups,
    requestId: req.id,
  });
});

app.post("/api/my/contacts", requireUserSession, async (req, res) => {
  const name = String((req.body && req.body.name) || "").trim();
  const phone = String((req.body && req.body.phone) || "").replace(/[^\d]/g, "");
  const groupName = String((req.body && req.body.groupName) || "").trim();

  if (!name) {
    return res.status(400).json({ success: false, message: "Nama kontak wajib diisi", requestId: req.id });
  }
  if (phone.length < 8) {
    return res.status(400).json({ success: false, message: "Nomor HP tidak valid", requestId: req.id });
  }

  const duplicate = await dbGet("SELECT id FROM contacts WHERE user_id = ? AND phone = ?", [req.user.id, phone]);
  if (duplicate) {
    return res.status(409).json({ success: false, message: "Nomor ini sudah ada di kontak kamu", requestId: req.id });
  }

  await dbRun(
    "INSERT INTO contacts (id, user_id, name, phone, group_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [uuidv4(), req.user.id, name, phone, groupName || null, new Date().toISOString()],
  );

  return res.json({ success: true, message: "Kontak disimpan", requestId: req.id });
});

// Import massal dari teks (satu baris = "Nama,Nomor"). Dipakai tombol Import
// di portal supaya user tidak perlu input satu-satu.
app.post("/api/my/contacts/import", requireUserSession, async (req, res) => {
  const raw = String((req.body && req.body.data) || "");
  const groupName = String((req.body && req.body.groupName) || "").trim() || null;

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    return res.status(400).json({ success: false, message: "Data import kosong", requestId: req.id });
  }
  if (lines.length > 1000) {
    return res.status(400).json({ success: false, message: "Maksimum 1000 baris per import", requestId: req.id });
  }

  let imported = 0;
  const skipped = [];

  for (const line of lines) {
    const parts = line.split(/[,;\t]/);
    const name = String(parts[0] || "").trim();
    const phone = String(parts[1] || "").replace(/[^\d]/g, "");

    if (!name || phone.length < 8) {
      skipped.push(line);
      continue;
    }

    const duplicate = await dbGet("SELECT id FROM contacts WHERE user_id = ? AND phone = ?", [req.user.id, phone]);
    if (duplicate) {
      skipped.push(line);
      continue;
    }

    await dbRun(
      "INSERT INTO contacts (id, user_id, name, phone, group_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [uuidv4(), req.user.id, name, phone, groupName, new Date().toISOString()],
    );
    imported += 1;
  }

  logger.info(`[${req.id}] Import kontak`, { user: req.user.username, imported, skipped: skipped.length });

  return res.json({
    success: true,
    message: `${imported} kontak diimport${skipped.length ? `, ${skipped.length} dilewati (format salah/duplikat)` : ""}`,
    imported,
    skipped: skipped.length,
    requestId: req.id,
  });
});

app.delete("/api/my/contacts/:id", requireUserSession, async (req, res) => {
  const result = await dbRun("DELETE FROM contacts WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
  if (result.changes === 0) {
    return res.status(404).json({ success: false, message: "Kontak tidak ditemukan", requestId: req.id });
  }
  return res.json({ success: true, message: "Kontak dihapus", requestId: req.id });
});

// --- Template pesan milik user ----------------------------------------------

app.get("/api/my/templates", requireUserSession, async (req, res) => {
  const rows = await dbAll("SELECT * FROM message_templates WHERE user_id = ? ORDER BY name ASC", [
    req.user.id,
  ]);

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    entries: rows.map((row) => ({ id: row.id, name: row.name, content: row.content })),
    requestId: req.id,
  });
});

app.post("/api/my/templates", requireUserSession, async (req, res) => {
  const name = String((req.body && req.body.name) || "").trim();
  const content = String((req.body && req.body.content) || "").trim();

  if (!name) {
    return res.status(400).json({ success: false, message: "Nama template wajib diisi", requestId: req.id });
  }
  if (!content) {
    return res.status(400).json({ success: false, message: "Isi template wajib diisi", requestId: req.id });
  }

  await dbRun(
    "INSERT INTO message_templates (id, user_id, name, content, created_at) VALUES (?, ?, ?, ?, ?)",
    [uuidv4(), req.user.id, name, content, new Date().toISOString()],
  );

  return res.json({ success: true, message: "Template disimpan", requestId: req.id });
});

app.delete("/api/my/templates/:id", requireUserSession, async (req, res) => {
  const result = await dbRun("DELETE FROM message_templates WHERE id = ? AND user_id = ?", [
    req.params.id,
    req.user.id,
  ]);
  if (result.changes === 0) {
    return res.status(404).json({ success: false, message: "Template tidak ditemukan", requestId: req.id });
  }
  return res.json({ success: true, message: "Template dihapus", requestId: req.id });
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

// User tidak bisa generate ulang API key sendiri lagi — cuma admin yang bisa
// (lewat tab Pengguna di dashboard admin), setelah user minta lewat chat WA.
// Lihat tombol "Chat Admin di WhatsApp" di tab Dokumentasi API portal user.
app.post("/api/admin/users/:id/api-key/regenerate", requireAdminSession, async (req, res) => {
  const user = await findUserById(req.params.id);
  if (!user) {
    return res.status(404).json({ success: false, message: "Pengguna tidak ditemukan", requestId: req.id });
  }

  const apiKey = await generateApiKeyForUser(user.id, user.phone);

  // Key lengkap CUMA dikirim lewat WhatsApp ke nomor terdaftar user — tidak
  // pernah dikembalikan lewat response API, supaya tidak tersimpan di
  // riwayat browser/network log admin. Key lama sudah tidak berlaku begitu
  // generateApiKeyForUser dipanggil, terlepas dari sukses/gagalnya
  // pengiriman WA di bawah ini.
  const delivered = await sendUserNotification(
    user.phone,
    `API Key baru kamu (kunci lama otomatis tidak berlaku lagi):\n\n${apiKey}\n\nKunci ini cuma dikirim sekali lewat WhatsApp ke nomor ini — kalau hilang, hubungi admin lagi lewat tab Dokumentasi API.\n\n⚠️ JANGAN bagikan API key ini ke siapa pun. Siapa saja yang punya key ini bisa kirim pesan atas nama akun kamu.`,
  );

  logger.info(`[${req.id}] Admin generate ulang API key user`, { user: user.username, delivered });

  if (!delivered) {
    return res.status(502).json({
      success: false,
      message: "API key baru berhasil dibuat, tapi gagal dikirim ke WhatsApp user (WAG notifier belum terhubung). Key lama sudah tidak berlaku — coba lagi beberapa saat lagi.",
      requestId: req.id,
    });
  }

  return res.json({
    success: true,
    message: `API key baru berhasil dibuat dan dikirim ke WhatsApp ${user.username}.`,
    requestId: req.id,
  });
});

app.post("/api/my/upgrade-request", requireUserSession, async (req, res) => {
  const plan = String((req.body && req.body.plan) || "").trim();

  if (!["pro", "max"].includes(plan)) {
    return res.status(400).json({ success: false, message: "Paket tidak valid", requestId: req.id });
  }

  await setUserPendingPlanRequest(req.user.id, plan);

  const price = (await getPlansWithPricing())[plan].price;
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

// --- Balas otomatis milik admin (global, berlaku untuk semua akun WAG admin) ---

async function isAdminOwnedSession(sessionId) {
  const row = await getSessionRow(sessionId);
  return Boolean(row && row.ownerType === "admin");
}

// Daftar ringkas akun WA milik admin (bukan milik user) — dipakai dropdown
// "Berlaku di Akun" di panel Balas Otomatis admin, supaya tidak tercampur
// dengan akun WAG milik user (yang punya scope terpisah).
app.get("/api/admin/own-sessions", requireAdminSession, async (req, res) => {
  const rows = await dbAll("SELECT id, name FROM sessions WHERE owner_type = 'admin' ORDER BY created_at ASC");
  res.setHeader("Cache-Control", "no-store");
  return res.json({ success: true, entries: rows, requestId: req.id });
});

app.get("/api/admin/auto-replies", requireAdminSession, async (req, res) => {
  const rows = await dbAll("SELECT * FROM auto_replies WHERE admin_scope = 1 ORDER BY created_at ASC");

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    entries: rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      keyword: row.keyword,
      matchType: row.matchType,
      replyText: row.replyText,
      enabled: Boolean(row.enabled),
      createdAt: row.createdAt,
    })),
    requestId: req.id,
  });
});

app.post("/api/admin/auto-replies", requireAdminSession, async (req, res) => {
  const { keyword, replyText, matchType, sessionId } = req.body || {};

  const trimmedKeyword = String(keyword || "").trim();
  const trimmedReply = String(replyText || "").trim();

  if (!trimmedKeyword) {
    return res.status(400).json({ success: false, message: "Kata kunci wajib diisi", requestId: req.id });
  }
  if (!trimmedReply) {
    return res.status(400).json({ success: false, message: "Isi balasan wajib diisi", requestId: req.id });
  }

  const resolvedMatchType = AUTO_REPLY_MATCH_TYPES.includes(matchType) ? matchType : "contains";

  let resolvedSessionId = null;
  if (sessionId) {
    if (!(await isAdminOwnedSession(sessionId))) {
      return res.status(404).json({ success: false, message: "Akun WhatsApp tidak ditemukan", requestId: req.id });
    }
    resolvedSessionId = sessionId;
  }

  const id = uuidv4();
  await dbRun(
    `INSERT INTO auto_replies (id, user_id, admin_scope, session_id, keyword, match_type, reply_text, enabled, created_at)
     VALUES (@id, NULL, 1, @sessionId, @keyword, @matchType, @replyText, 1, @createdAt)`,
    {
      id,
      sessionId: resolvedSessionId,
      keyword: trimmedKeyword,
      matchType: resolvedMatchType,
      replyText: trimmedReply,
      createdAt: new Date().toISOString(),
    },
  );

  logger.info(`[${req.id}] Aturan balas otomatis admin dibuat`, { keyword: trimmedKeyword });

  return res.json({ success: true, message: "Aturan balas otomatis disimpan", id, requestId: req.id });
});

app.patch("/api/admin/auto-replies/:id", requireAdminSession, async (req, res) => {
  const existing = await dbGet("SELECT * FROM auto_replies WHERE id = ? AND admin_scope = 1", [req.params.id]);
  if (!existing) {
    return res.status(404).json({ success: false, message: "Aturan tidak ditemukan", requestId: req.id });
  }

  const update = await buildAutoReplyUpdate(req, res, existing, isAdminOwnedSession);
  if (!update) {
    return;
  }

  await dbRun(
    "UPDATE auto_replies SET keyword = ?, match_type = ?, reply_text = ?, session_id = ?, enabled = ? WHERE id = ?",
    [update.keyword, update.matchType, update.replyText, update.sessionId, update.enabled, req.params.id],
  );

  return res.json({ success: true, message: "Aturan disimpan", requestId: req.id });
});

app.delete("/api/admin/auto-replies/:id", requireAdminSession, async (req, res) => {
  const result = await dbRun("DELETE FROM auto_replies WHERE id = ? AND admin_scope = 1", [req.params.id]);
  if (result.changes === 0) {
    return res.status(404).json({ success: false, message: "Aturan tidak ditemukan", requestId: req.id });
  }
  return res.json({ success: true, message: "Aturan dihapus", requestId: req.id });
});

app.get("/api/admin/requests", requireAdminSession, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ success: true, entries: await listPendingRequests(), requestId: req.id });
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
    const row = await approveSessionRequest(req.params.id, req.admin.id);
    activateSessionRuntime(row);

    const owner = await findUserById(row.ownerUserId);

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

app.post("/api/admin/requests/:id/reject", requireAdminSession, async (req, res) => {
  const reason = String((req.body && req.body.reason) || "").trim();

  try {
    const row = await rejectSessionRequest(req.params.id, reason);
    const owner = await findUserById(row.ownerUserId);

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

app.get("/api/admin/users", requireAdminSession, async (req, res) => {
  const users = await listUsers();
  const entries = [];
  for (const user of users) {
    const accountCountRow = await dbGet(
      "SELECT COUNT(*) AS c FROM sessions WHERE owner_user_id = ? AND status IN ('pending_approval', 'active')",
      [user.id],
    );
    entries.push({
      ...user,
      accountCount: accountCountRow.c,
      messagesToday: await countUserMessagesToday(user.id),
    });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.json({ success: true, entries, plans: PLAN_DEFS, requestId: req.id });
});

app.patch("/api/admin/users/:id", requireAdminSession, async (req, res) => {
  const plan = (req.body && req.body.plan) || "";

  try {
    const previous = await findUserById(req.params.id);
    await updateUserPlan(req.params.id, plan);
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
    const ownedSessions = await listUserSessionRows(userId);
    for (const row of ownedSessions) {
      await removeUserOwnedSession(row.id, userId).catch(() => {});
    }

    await deleteUserRow(userId);

    logger.info(`[${req.id}] User dihapus`, { id: userId });

    return res.json({ success: true, message: "Pengguna dihapus", requestId: req.id });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message, requestId: req.id });
  }
});

app.get("/api/admin/config", requireAdminSession, async (req, res) => {
  const connectedSessions = Array.from(sessions.values())
    .filter((s) => s.isConnected)
    .map((s) => ({ id: s.id, name: s.name }));

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    config: {
      notifierSessionId: (await getConfig("notifierSessionId")) || "",
      adminNotifyPhone: (await getConfig("adminNotifyPhone")) || "",
    },
    plans: await getPlansWithPricing(),
    connectedSessions,
    requestId: req.id,
  });
});

app.post("/api/admin/config", requireAdminSession, async (req, res) => {
  const { notifierSessionId, adminNotifyPhone, planProPrice, planMaxPrice } = req.body || {};

  await setConfig("notifierSessionId", String(notifierSessionId || ""));
  await setConfig("adminNotifyPhone", String(adminNotifyPhone || "").replace(/[^\d]/g, ""));

  if (planProPrice !== undefined) {
    await setConfig("planPrice_pro", String(Math.max(0, Number(planProPrice) || 0)));
  }
  if (planMaxPrice !== undefined) {
    await setConfig("planPrice_max", String(Math.max(0, Number(planMaxPrice) || 0)));
  }

  logger.info(`[${req.id}] Konfigurasi notifikasi & harga paket diperbarui`, {
    notifierSessionId,
    adminNotifyPhone,
    planProPrice,
    planMaxPrice,
  });

  return res.json({ success: true, message: "Konfigurasi tersimpan", requestId: req.id });
});

app.get("/api/admin/payment-config", requireAdminSession, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    config: { ...(await getPaymentConfig()), qrisImage: (await getConfig("paymentQrisImage")) || "" },
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
  async (req, res) => {
    const { danaNumber, danaName, mandiriNumber, mandiriName } = req.body || {};

    await setConfig("paymentDanaNumber", String(danaNumber || "").trim());
    await setConfig("paymentDanaName", String(danaName || "").trim());
    await setConfig("paymentMandiriNumber", String(mandiriNumber || "").trim());
    await setConfig("paymentMandiriName", String(mandiriName || "").trim());

    if (req.file) {
      const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      await setConfig("paymentQrisImage", dataUrl);
    }

    logger.info(`[${req.id}] Konfigurasi metode pembayaran diperbarui`, {
      hasNewQris: Boolean(req.file),
    });

    return res.json({ success: true, message: "Konfigurasi pembayaran tersimpan", requestId: req.id });
  },
);

app.delete("/api/admin/payment-config/qris", requireAdminSession, async (req, res) => {
  await setConfig("paymentQrisImage", "");
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
    // #settings disertakan supaya admin balik ke tab Pengaturan lagi setelah
    // restart otomatis — bukan ke Dashboard, tempat activatePage() akan
    // fallback kalau tidak ada hash sama sekali di URL.
    const redirectUrl = `${req.protocol}://${displayHost}:${newPort}/#settings`;
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

app.get("/api/admins", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    success: true,
    entries: await listAdmins(),
    requestId: req.id,
  });
});

app.post("/api/admins", async (req, res) => {
  const { username, password } = req.body || {};

  try {
    const admin = await createAdmin(username, password);

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

app.patch("/api/admins/:id", async (req, res) => {
  const { password } = req.body || {};

  try {
    await updateAdminPassword(req.params.id, password);

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

app.delete("/api/admins/:id", async (req, res) => {
  try {
    await deleteAdmin(req.params.id);

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

app.get("/api/history", async (req, res) => {
  const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 100));
  const { entries, total } = await listHistory(limit);

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

app.get("/api/schedule", async (req, res) => {
  const jobs = await listScheduledJobs();
  const entries = jobs.map(({ jid, file, ...rest }) => rest);

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

  await insertScheduledJob(job);

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
  const job = await findScheduledJob(req.params.id);

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

  await updateScheduledJob(job.id, {
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

let server;

async function shutdown(signal) {
  logger.warn("Menerima sinyal shutdown", { signal });
  sessions.forEach((session) => clearReconnectTimer(session));

  server?.close(() => {
    logger.info("HTTP server berhenti");
  });

  await pool.end().catch(() => {});

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

async function bootstrapDefaultAdmin() {
  if ((await listAdmins()).length > 0) {
    return;
  }

  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");
  const admin = await createAdmin(username, password);

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

async function main() {
  await initSchema();
  await migrateLegacyJsonFiles();
  await bootstrapSessions();
  await bootstrapDefaultAdmin();

  server = app.listen(PORT, HOST, () => {
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

    notifyExpiredPlans().catch((error) => {
      logger.error("Gagal mengirim notifikasi paket kadaluarsa", {
        error: error.message,
        stack: error.stack,
      });
    });

    notifyExpiringSoonPlans().catch((error) => {
      logger.error("Gagal mengirim peringatan paket akan berakhir", {
        error: error.message,
        stack: error.stack,
      });
    });
  }, SCHEDULER_INTERVAL_MS);
  schedulerTimer.unref();
}

main().catch((error) => {
  logger.error("Gagal memulai server", { error: error.message, stack: error.stack });
  console.error("Gagal memulai server:", error);
  process.exit(1);
});
