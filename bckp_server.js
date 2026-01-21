require('dotenv').config();
const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let sock;
let qrCodeData = '';
let isConnected = false;

async function connectToWhatsApp() {
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
            console.log('QR Code received');
            qrCodeData = await qrcode.toDataURL(qr);
            isConnected = false;
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;
            
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            isConnected = false;
            qrCodeData = '';
            
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connected successfully!');
            isConnected = true;
            qrCodeData = '';
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Initialize connection
connectToWhatsApp();

// Route untuk menampilkan QR code
app.get('/', (req, res) => {
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
                        <div class="status">‚úÖ WhatsApp Terhubung!</div>
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
                        <h1>Ì≥± Scan QR Code</h1>
                        <p>Buka WhatsApp di HP Anda</p>
                        <img src="${qrCodeData}" alt="QR Code">
                        <div class="instructions">
                            <p><strong>Cara scan:</strong></p>
                            <p>WhatsApp ‚Üí Menu (3 titik) ‚Üí Perangkat Tertaut ‚Üí Tautkan Perangkat</p>
                            <p><small>‚ü≥ Halaman refresh otomatis setiap 5 detik</small></p>
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
                        <h1>‚è≥ Memuat...</h1>
                        <div class="loader"></div>
                        <p>Menunggu QR Code...</p>
                    </div>
                </body>
            </html>
        `);
    }
});

// Route untuk form kirim pesan
app.get('/send-form', (req, res) => {
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
                    <h1>Ì≥± Kirim Pesan WhatsApp</h1>
                    <form action="/send-message" method="POST">
                        <label>Nomor Tujuan:</label>
                        <input type="text" name="number" placeholder="628123456789" required>
                        <div class="note">Format: 628xxxxxxxxxx (tanpa + atau 0)</div>
                        
                        <label>Pesan:</label>
                        <textarea name="message" rows="5" placeholder="Tulis pesan Anda di sini..." required></textarea>
                        
                        <button type="submit">Kirim Pesan</button>
                    </form>
                    <a href="/" class="back">‚Üê Kembali</a>
                </div>
            </body>
        </html>
    `);
});

// Endpoint untuk kirim pesan
app.post('/send-message', async (req, res) => {
    if (!isConnected) {
        return res.status(503).send(`
            <html>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h1>‚ùå WhatsApp Belum Terhubung</h1>
                    <p>Silakan scan QR code terlebih dahulu</p>
                    <a href="/">Kembali ke Home</a>
                </body>
            </html>
        `);
    }

    const { number, message } = req.body;

    if (!number || !message) {
        return res.status(400).send('Nomor dan pesan harus diisi!');
    }

    try {
        // Format nomor WhatsApp (tambahkan @s.whatsapp.net)
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        
        // Kirim pesan
        await sock.sendMessage(jid, { text: message });
        
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
                        <div class="success">‚úÖ</div>
                        <h1>Pesan Berhasil Terkirim!</h1>
                        <p>Pesan telah dikirim ke <strong>${number}</strong></p>
                        <a href="/send-form">Kirim Pesan Lagi</a>
                        <a href="/">Home</a>
                    </div>
                </body>
            </html>
        `);
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).send(`
            <html>
                <body style="font-family: Arial; text-align: center; padding: 50px;">
                    <h1>‚ùå Error</h1>
                    <p>${error.message}</p>
                    <a href="/send-form">Coba Lagi</a>
                </body>
            </html>
        `);
    }
});

// API endpoint JSON untuk kirim pesan
app.post('/api/send', async (req, res) => {
    if (!isConnected) {
        return res.status(503).json({
            success: false,
            message: 'WhatsApp belum terhubung'
        });
    }

    const { number, message } = req.body;

    if (!number || !message) {
        return res.status(400).json({
            success: false,
            message: 'Nomor dan pesan harus diisi'
        });
    }

    try {
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        
        res.json({
            success: true,
            message: 'Pesan berhasil dikirim',
            to: number
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Check status
app.get('/api/status', (req, res) => {
    res.json({
        connected: isConnected,
        hasQR: qrCodeData !== ''
    });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

app.listen(PORT, () => {
    console.log(`Ì∫Ä Server berjalan di http://${HOST}:${PORT}`);
    console.log(`Ì≥± Environment: ${process.env.NODE_ENV || 'development'}`);
});
