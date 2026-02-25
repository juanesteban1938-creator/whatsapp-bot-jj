
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());
app.use(cors());

const port = process.env.PORT || 3001;
const apiKey = process.env.API_KEY || 'jj-connect-2026';

let qrCodeBase64 = '';
let isReady = false;

// Configuración del cliente de WhatsApp
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
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

// Eventos de WhatsApp
client.on('qr', (qr) => {
    qrcode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('Error generando QR:', err);
            return;
        }
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

client.on('authenticated', () => {
    console.log('Autenticado en WhatsApp');
});

client.on('auth_failure', msg => {
    console.error('Error de autenticación:', msg);
    isReady = false;
});

client.on('disconnected', (reason) => {
    console.log('Cliente desconectado:', reason);
    isReady = false;
    client.initialize().catch(err => console.error('Error re-inicializando cliente:', err));
});

// Middleware de Seguridad
const authMiddleware = (req, res, next) => {
    const headerKey = req.headers['x-api-key'];
    if (apiKey && headerKey !== apiKey) {
        return res.status(401).json({ error: 'No autorizado. API Key inválida.' });
    }
    next();
};

// Endpoints
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
    if (!phone || !message) return res.status(400).json({ error: 'Faltan datos' });
    if (!isReady) return res.status(503).json({ error: 'WhatsApp no listo' });

    try {
        const chatId = phone.includes('@c.us') ? phone : `${phone}@c.us`;
        await client.sendMessage(chatId, message);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/send-service-notification', authMiddleware, async (req, res) => {
    const data = req.body;
    if (!data.clienteTelefono) return res.status(400).json({ error: 'Teléfono requerido' });
    if (!isReady) return res.status(503).json({ error: 'WhatsApp no listo' });

    const chatId = data.clienteTelefono.includes('@c.us') ? data.clienteTelefono : `${data.clienteTelefono}@c.us`;

    // 1. Formatear mensaje de texto
    const textMessage = `¡Hola, ${data.clienteNombre}! 👋

Soy *Nova*, asistente virtual de *Transportes Especiales J&J* 🚐

Me complace confirmarte que tu servicio de transporte ha sido programado exitosamente. Aquí tienes todos los detalles:

━━━━━━━━━━━━━━━━
🗓️ *Fecha:* ${data.fecha}
⏰ *Hora de recogida:* ${data.hora}
📍 *Origen:* ${data.origen}
🏁 *Destino:* ${data.destino}
🚗 *Vehículo / Placa:* ${data.placa}
👤 *Conductor:* ${data.conductor}
📞 *Contacto conductor:* ${data.telefonoConductor}
💰 *Valor del servicio:* ${data.valor}
━━━━━━━━━━━━━━━━

Por favor, estar listo 10 minutos antes de la hora de recogida. 🙏

Si tienes alguna pregunta o necesitas hacer algún cambio, no dudes en contactarnos.

¡Gracias por confiar en nosotros! 🌟
*Transportes Especiales J&J*`;

    try {
        // Enviar mensaje de texto
        await client.sendMessage(chatId, textMessage);

        // 2. Generar imagen con Puppeteer
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 600, height: 600, deviceScaleFactor: 2 });
        
        const htmlContent = `
        <html>
        <body style="margin:0; padding:20px; background:#f0f2f5; font-family:sans-serif;">
            <div id="card" style="width:560px; background:white; border-radius:16px; overflow:hidden; box-shadow:0 8px 30px rgba(0,0,0,0.1); border:1px solid #e1e4e8;">
                <div style="background:#1a5fa8; padding:24px; display:flex; align-items:center; justify-content:space-between; color:white;">
                    <div>
                        <div style="font-size:22px; font-weight:bold; letter-spacing:0.5px;">Resumen del Servicio</div>
                        <div style="font-size:12px; opacity:0.8; margin-top:4px;">J&J CONNECT V2.0</div>
                    </div>
                    <img src="https://i.ibb.co/zhzhTrvV/logo-cxc.png" height="50" style="filter: brightness(0) invert(1);" />
                </div>
                <div style="padding:32px;">
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:24px;">
                        <div>
                            <div style="font-size:11px; color:#888; text-transform:uppercase; font-weight:bold; margin-bottom:4px;">Cliente</div>
                            <div style="font-size:15px; font-weight:bold; color:#333;">${data.clienteNombre}</div>
                        </div>
                        <div>
                            <div style="font-size:11px; color:#888; text-transform:uppercase; font-weight:bold; margin-bottom:4px;">Vehículo / Placa</div>
                            <div style="font-size:15px; font-weight:bold; color:#333;">${data.placa}</div>
                        </div>
                        <div style="grid-column: span 2;">
                            <div style="font-size:11px; color:#888; text-transform:uppercase; font-weight:bold; margin-bottom:4px;">Ruta del Servicio</div>
                            <div style="font-size:14px; color:#444; line-height:1.4;">
                                <span style="color:#22c55e;">●</span> ${data.origen}<br>
                                <span style="color:#ef4444;">▼</span> ${data.destino}
                            </div>
                        </div>
                    </div>
                    <div style="margin-top:32px; padding-top:24px; border-top:2px dashed #eee;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div style="font-size:11px; color:#888; text-transform:uppercase; font-weight:bold;">Total del Servicio</div>
                            <div style="font-size:28px; font-weight:bold; color:#1a5fa8;">${data.valor}</div>
                        </div>
                    </div>
                </div>
                <div style="background:#f8f9fa; padding:16px; text-align:center; color:#666; font-size:11px; border-top:1px solid #eee;">
                    Nova | Asistente Virtual de Transportes Especiales J&J
                </div>
            </div>
        </body>
        </html>`;

        await page.setContent(htmlContent);
        const card = await page.$('#card');
        const screenshot = await card.screenshot({ encoding: 'base64' });
        await browser.close();

        // Enviar imagen
        const media = new MessageMedia('image/png', screenshot, 'resumen.png');
        await client.sendMessage(chatId, media);

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Bot Nova corriendo en puerto ${port}`);
    client.initialize().catch(err => console.error(err));
});
