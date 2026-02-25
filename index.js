const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const port = process.env.PORT || 3001;
const apiKey = process.env.API_KEY;

let qrCodeBase64 = '';
let isReady = false;

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    qrcode.toDataURL(qr, (err, url) => {
        if (err) { console.error('Error generando QR:', err); return; }
        qrCodeBase64 = url;
    });
    isReady = false;
    console.log('Nuevo código QR generado.');
});

client.on('ready', () => {
    console.log('¡Cliente de WhatsApp listo!');
    isReady = true;
    qrCodeBase64 = '';
});

client.on('authenticated', () => { console.log('Autenticado en WhatsApp'); });

client.on('auth_failure', msg => {
    console.error('Error de autenticación:', msg);
    isReady = false;
});

client.on('disconnected', (reason) => {
    console.log('Cliente desconectado:', reason);
    isReady = false;
    client.initialize().catch(err => console.error('Error re-inicializando:', err));
});

const authMiddleware = (req, res, next) => {
    const headerKey = req.headers['x-api-key'];
    if (apiKey && headerKey !== apiKey) {
        return res.status(401).json({ error: 'No autorizado. API Key inválida.' });
    }
    next();
};

app.get('/status', (req, res) => {
    res.json({ connected: isReady });
});

app.get('/qr', (req, res) => {
    if (isReady) return res.json({ message: 'Ya está conectado' });
    if (!qrCodeBase64) return res.status(404).json({ error: 'QR no generado aún' });
    res.json({ qr: qrCodeBase64 });
});

app.post('/send-message', authMiddleware, async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Teléfono y mensaje son requeridos' });
    if (!isReady) return res.status(503).json({ error: 'Escanea el QR primero.' });
    try {
        const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
        await client.sendMessage(chatId, message);
        res.json({ success: true, message: 'Mensaje enviado' });
    } catch (error) {
        console.error('Error enviando mensaje:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Servidor del Bot ejecutándose en puerto ${port}`);
    client.initialize().catch(err => console.error('Error inicializando:', err));
});
