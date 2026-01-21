require('dotenv').config();
const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode');
const morgan = require('morgan');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== WINSTON LOGGER SETUP ====================
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
    ),
    defaultMeta: { service: 'whatsapp-gateway' },
    transports: [
        // File untuk error logs
        new winston.transports.File({ 
            filename: 'logs/error.log', 
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),
        // File untuk semua logs
        new winston.transports.File({ 
            filename: 'logs/combined.log',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),
        // File khusus untuk WhatsApp events
        new winston.transports.File({ 
            filename: 'logs/whatsapp.log',
            level: 'info',
            maxsize: 5242880,
            maxFiles: 3,
        })
    ]
});

// Console logging dengan format yang cantik (seperti Laravel)
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ level, message, timestamp, ...meta }) => {
                let metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
                return `[${timestamp}] ${level}: ${message} ${metaStr}`;
            })
        )
    }));
}

// ==================== MORGAN HTTP LOGGER ====================
// Custom token untuk request ID
morgan.token('id', (req) => req.id);

// Format log mirip Laravel
const morganFormat = ':id :method :url :status :res[content-length] - :response-time ms';

app.use(morgan(morganFormat, {
    stream: {
        write: (message) => logger.http(message.trim())
    }
}));

// ==================== MIDDLEWARE REQUEST ID ====================
app.use((req, res, next) => {
    req.id = uuidv4().split('-')[0]; // Short ID
    res.setHeader('X-Request-ID', req.id);
    next();
});

// ==================== WHATSAPP CONNECTION ====================
let sock;
let qrCodeData = '';
let isConnected = false;

async function connectToWhatsApp() {
    try {
        logger.info('🔄 Memulai koneksi WhatsApp...');
        
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            browser: ['WhatsApp Gateway', 'Chrome', '1.0.0']
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                logger.info('📱 QR Code diterima, menunggu scan...');
                qrCodeData = await qrcode.toDataURL(qr);
                isConnected = false;
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;
                
                const reason = lastDisconnect?.error?.output?.statusCode || 'Unknown';
                logger.warn('⚠️ Koneksi WhatsApp terputus', { 
                    reason,
                    shouldReconnect,
                    error: lastDisconnect?.error?.message 
                });
                
                isConnected = false;
                qrCodeData = '';
                
                if (shouldReconnect) {
                    logger.info('🔄 Mencoba reconnect...');
                    setTimeout(() => connectToWhatsApp(), 3000);
                } else {
                    logger.error('❌ Tidak bisa reconnect - Status: Logged Out');
                }
            } else if (connection === 'open') {
                logger.info('✅ WhatsApp terhubung sukses!');
                isConnected = true;
                qrCodeData = '';
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
    } catch (error) {
        logger.error('❌ Error saat koneksi WhatsApp:', { 
            error: error.message,
            stack: error.stack 
        });
    }
}

// Initialize connection
connectToWhatsApp();

// ==================== ROUTES ====================

// Home - QR Code / Status
app.get('/', (req, res) => {
    logger.info(`[${req.id}] GET / - Status: ${isConnected ? 'Connected' : 'Disconnected'}`);
    
    if (isConnected) {
        res.send(`
            <html>
                <head>
                    <title>WhatsApp Gateway</title>
                    <style>
                        body { font-family: Arial; text-align: center; padding: 50px; background: #f0f2f5; }
                        .container { background: white; max-width: 600px; margin: 0 auto; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                        .status { color: #25D366; font-size: 24px; margin-bottom: 20px; }
                        a { display: inline-block; margin-top: 20px; padding: 12px 30px; background: #25D366; color: white; text-decoration: none; border-radius: 5px; }
                        a:hover { background: #128C7E; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="status">✅ WhatsApp Terhubung!</div>
                        <p>Client sudah terhubung dan siap mengirim pesan</p>
                        <a href="/send-form">Kirim Pesan WhatsApp</a>
                    </div>
                </body>
            </html>
        `);
    } else if (qrCodeData) {
        res.send(`
            <html>
                <head>
                    <title>WhatsApp Gateway - QR Code</title>
                    <meta http-equiv="refresh" content="5">
                    <style>
                        body { font-family: Arial; text-align: center; padding: 50px; background: #f0f2f5; }
                        .container { background: white; max-width: 600px; margin: 0 auto; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                        img { max-width: 300px; border: 3px solid #25D366; border-radius: 10px; }
                        .instructions { margin-top: 20px; color: #666; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>📱 Scan QR Code</h1>
                        <p>Buka WhatsApp di HP Anda</p>
                        <img src="${qrCodeData}" alt="QR Code">
                        <div class="instructions">
                            <p><strong>Cara scan:</strong></p>
                            <p>WhatsApp → Menu (3 titik) → Perangkat Tertaut → Tautkan Perangkat</p>
                            <p><small>⟳ Halaman refresh otomatis setiap 5 detik</small></p>
                        </div>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <head>
                    <title>WhatsApp Gateway</title>
                    <meta http-equiv="refresh" content="3">
                    <style>
                        body { font-family: Arial; text-align: center; padding: 50px; background: #f0f2f5; }
                        .container { background: white; max-width: 600px; margin: 0 auto; padding: 40px; border-radius: 10px; }
                        .loader { border: 5px solid #f3f3f3; border-top: 5px solid #25D366; border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite; margin: 20px auto; }
                        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>⏳ Memuat...</h1>
                        <div class="loader"></div>
                        <p>Menunggu QR Code...</p>
                    </div>
                </body>
            </html>
        `);
    }
});

// Form kirim pesan
app.get('/send-form', (req, res) => {
    logger.info(`[${req.id}] GET /send-form`);
    
    res.send(`
        <html>
            <head>
                <title>Kirim Pesan WhatsApp</title>
                <style>
                    body { font-family: Arial; background: #f0f2f5; padding: 20px; }
                    .container { max-width: 600px; margin: 50px auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    h1 { color: #128C7E; }
                    label { display: block; margin-top: 15px; color: #333; font-weight: bold; }
                    input, textarea { width: 100%; padding: 10px; margin-top: 5px; border: 1px solid #ddd; border-radius: 5px; box-sizing: border-box; font-family: Arial; }
                    button { margin-top: 20px; padding: 12px 30px; background: #25D366; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
                    button:hover { background: #128C7E; }
                    .back { display: inline-block; margin-top: 15px; color: #128C7E; text-decoration: none; }
                    .note { background: #fff3cd; padding: 10px; border-radius: 5px; margin-top: 10px; font-size: 14px; color: #856404; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>💬 Kirim Pesan WhatsApp</h1>
                    <form action="/send-message" method="POST">
                        <label>Nomor Tujuan:</label>
                        <input type="text" name="number" placeholder="628123456789" required>
                        <div class="note">Format: 628xxxxxxxxxx (tanpa + atau 0)</div>
                        
                        <label>Pesan:</label>
                        <textarea name="message" rows="5" placeholder="Tulis pesan Anda di sini..." required></textarea>
                        
                        <button type="submit">Kirim Pesan</button>
                    </form>
                    <a href="/" class="back">← Kembali</a>
                </div>
            </body>
        </html>
    `);
});

// POST - Kirim pesan via Form
app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;
    
    logger.info(`[${req.id}] POST /send-message`, { 
        number, 
        messageLength: message?.length,
        isConnected 
    });

    if (!isConnected) {
        logger.warn(`[${req.id}] Gagal kirim - WhatsApp belum terhubung`);
        return res.status(503).send(`
            <html>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h1>❌ WhatsApp Belum Terhubung</h1>
                    <p>Silakan scan QR code terlebih dahulu</p>
                    <a href="/">Kembali ke Home</a>
                </body>
            </html>
        `);
    }

    if (!number || !message) {
        logger.warn(`[${req.id}] Validasi gagal - Nomor atau pesan kosong`);
        return res.status(400).send('Nomor dan pesan harus diisi!');
    }

    try {
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        
        logger.info(`[${req.id}] 📤 Mengirim pesan ke ${jid}...`);
        
        await sock.sendMessage(jid, { text: message });
        
        logger.info(`[${req.id}] ✅ Pesan berhasil terkirim ke ${number}`);
        
        res.send(`
            <html>
                <head>
                    <title>Pesan Terkirim</title>
                    <style>
                        body { font-family: Arial; text-align: center; padding: 50px; background: #f0f2f5; }
                        .container { background: white; max-width: 600px; margin: 0 auto; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                        .success { color: #25D366; font-size: 60px; }
                        a { display: inline-block; margin: 10px; padding: 10px 20px; background: #25D366; color: white; text-decoration: none; border-radius: 5px; }
                        a:hover { background: #128C7E; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="success">✅</div>
                        <h1>Pesan Berhasil Terkirim!</h1>
                        <p>Pesan telah dikirim ke <strong>${number}</strong></p>
                        <p><small>Request ID: ${req.id}</small></p>
                        <a href="/send-form">Kirim Pesan Lagi</a>
                        <a href="/">Home</a>
                    </div>
                </body>
            </html>
        `);
    } catch (error) {
        logger.error(`[${req.id}] ❌ Error kirim pesan:`, { 
            error: error.message,
            stack: error.stack,
            number,
            messageLength: message?.length
        });
        
        res.status(500).send(`
            <html>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h1>❌ Error</h1>
                    <p>${error.message}</p>
                    <p><small>Request ID: ${req.id}</small></p>
                    <a href="/send-form">Coba Lagi</a>
                </body>
            </html>
        `);
    }
});

// ==================== API ENDPOINTS ====================

// API - Kirim pesan (JSON)
app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    logger.info(`[${req.id}] POST /api/send dari ${clientIP}`, { 
        number, 
        messageLength: message?.length,
        isConnected,
        headers: req.headers
    });

    if (!isConnected) {
        logger.warn(`[${req.id}] API Gagal - WhatsApp belum terhubung`);
        return res.status(503).json({
            success: false,
            message: 'WhatsApp belum terhubung',
            requestId: req.id
        });
    }

    if (!number || !message) {
        logger.warn(`[${req.id}] API Validasi gagal`, { number, hasMessage: !!message });
        return res.status(400).json({
            success: false,
            message: 'Nomor dan pesan harus diisi',
            requestId: req.id
        });
    }

    try {
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        
        logger.info(`[${req.id}] 📤 API: Mengirim pesan ke ${jid}...`);
        
        const result = await sock.sendMessage(jid, { text: message });
        
        logger.info(`[${req.id}] ✅ API: Pesan terkirim`, { 
            to: number,
            messageId: result?.key?.id 
        });
        
        res.json({
            success: true,
            message: 'Pesan berhasil dikirim',
            to: number,
            requestId: req.id,
            messageId: result?.key?.id
        });
    } catch (error) {
        logger.error(`[${req.id}] ❌ API Error:`, { 
            error: error.message,
            stack: error.stack,
            number,
            messageLength: message?.length
        });
        
        res.status(500).json({
            success: false,
            message: error.message,
            requestId: req.id
        });
    }
});

// API - Status check
app.get('/api/status', (req, res) => {
    const status = {
        connected: isConnected,
        hasQR: qrCodeData !== '',
        timestamp: new Date().toISOString(),
        requestId: req.id
    };
    
    logger.info(`[${req.id}] GET /api/status`, status);
    
    res.json(status);
});

// ==================== ERROR HANDLER ====================
app.use((err, req, res, next) => {
    logger.error(`[${req.id}] Unhandled Error:`, {
        error: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method
    });
    
    res.status(500).json({
        success: false,
        message: 'Internal Server Error',
        requestId: req.id
    });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

app.listen(PORT, HOST, () => {
    logger.info('='.repeat(50));
    logger.info('🚀 WhatsApp Gateway Server Started');
    logger.info('='.repeat(50));
    logger.info(`📍 Server: http://${HOST}:${PORT}`);
    logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`📝 Log Level: ${process.env.LOG_LEVEL || 'info'}`);
    logger.info(`🕐 Timezone: ${process.env.TZ || 'UTC'}`);
    logger.info('='.repeat(50));
});