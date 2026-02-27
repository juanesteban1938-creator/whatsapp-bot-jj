/**
 * J&J Connect - WhatsApp Bot Engine (Nova)
 * Versión: 4.5.0 (Optimización Cron + Timezone UTC-5)
 */

const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const puppeteer = require('puppeteer');
const admin = require('firebase-admin');
const cron = require('node-cron');
const fetch = require('node-fetch');

if (!admin.apps.length) {
    admin.initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || 'jj-connect-18988325-5ab9e'
    });
}
const db = admin.firestore();

const app = express();
app.use(express.json());
app.use(cors());

const port = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'jj-connect-2026';
const WEATHER_KEY = process.env.OPENWEATHER_API_KEY;
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

let qrCodeBase64 = '';
let isReady = false;

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/tmp/.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

function resolveWAId(number) {
    let clean = number.toString().replace(/\D/g, '');
    if (!clean.startsWith('57')) clean = '57' + clean;
    return `${clean}@c.us`;
}

async function generateServiceCard(data) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        const html = `<html><head><style>
            body{font-family:Arial,sans-serif;margin:0;background:#f4f6f8;width:600px;}
            .card{width:560px;margin:20px;border-radius:16px;background:white;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);border:1px solid #e1e4e8;}
            .header{background:#1a5fa8;padding:24px;display:flex;align-items:center;justify-content:space-between;color:white;}
            .header-title{font-size:20px;font-weight:bold;letter-spacing:1px;}
            .header-sub{font-size:11px;opacity:0.8;margin-top:4px;text-transform:uppercase;}
            .logo-box{background:white;border-radius:8px;padding:6px 12px;display:flex;align-items:center;gap:6px;}
            .logo-jj{background:#1a5fa8;color:white;font-weight:900;font-size:14px;padding:4px 8px;border-radius:4px;}
            .logo-text{color:#1a5fa8;font-weight:700;font-size:13px;}
            .content{padding:28px;}
            .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;}
            .label{font-size:10px;color:#888;text-transform:uppercase;font-weight:bold;margin-bottom:3px;}
            .value{font-size:14px;font-weight:bold;color:#333;}
            .route-box{grid-column:span 2;background:#f8f9fa;padding:14px;border-radius:10px;border-left:4px solid #1a5fa8;}
            .route-item{display:flex;align-items:center;margin-bottom:8px;font-size:13px;color:#333;}
            .dot{width:10px;height:10px;border-radius:50%;margin-right:10px;flex-shrink:0;}
            .footer{background:#f8f9fa;padding:12px;text-align:center;color:#1a5fa8;font-size:11px;border-top:1px solid #eee;font-weight:bold;}
        </style></head><body>
            <div class="card" id="card">
                <div class="header">
                    <div>
                        <div class="header-title">RESUMEN DEL SERVICIO</div>
                        <div class="header-sub">Transportes Especiales J&J</div>
                    </div>
                    <div class="logo-box">
                        <div class="logo-jj">J&J</div>
                        <span class="logo-text">Connect</span>
                    </div>
                </div>
                <div class="content">
                    <div class="grid">
                        <div style="grid-column:span 2;">
                            <div class="label">Cliente / Pasajero</div>
                            <div class="value" style="font-size:18px;color:#1a5fa8;">${data.clienteNombre}</div>
                        </div>
                        <div><div class="label">Fecha</div><div class="value">${data.fecha}</div></div>
                        <div><div class="label">Hora de Recogida</div><div class="value">${data.hora}</div></div>
                        <div class="route-box">
                            <div class="route-item"><div class="dot" style="background:#22c55e;"></div><div><b>Origen:</b> ${data.origen}</div></div>
                            <div class="route-item"><div class="dot" style="background:#ef4444;"></div><div><b>Destino:</b> ${data.destino}</div></div>
                        </div>
                        <div><div class="label">Vehículo / Placa</div><div class="value">${data.placa}</div></div>
                        <div><div class="label">Conductor</div><div class="value">${data.conductor}</div></div>
                        <div style="grid-column:span 2;"><div class="label">Contacto Conductor</div><div class="value">${data.telefonoConductor}</div></div>
                    </div>
                </div>
                <div class="footer">Nova | Asistente Virtual de Transportes Especiales J&J</div>
            </div>
        </body></html>`;
        await page.setViewport({ width: 600, height: 700, deviceScaleFactor: 2 });
        await page.setContent(html);
        await new Promise(r => setTimeout(r, 300));
        const card = await page.$('#card');
        const screenshot = await card.screenshot({ encoding: 'base64' });
        await browser.close();
        return screenshot;
    } catch (err) {
        if (browser) await browser.close();
        throw err;
    }
}

client.on('qr', (qr) => {
    qrcode.toDataURL(qr, (err, url) => { if (!err) qrCodeBase64 = url; });
    isReady = false;
    console.log('[Nova] Nuevo QR generado.');
});

client.on('ready', () => {
    isReady = true;
    qrCodeBase64 = '';
    console.log('[Nova] Sistema operando correctamente.');
});

client.on('disconnected', (reason) => {
    console.log('[Nova] Desconectado:', reason);
    isReady = false;
    client.initialize().catch(err => console.error(err));
});

const authMiddleware = (req, res, next) => {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'No autorizado.' });
    next();
};

app.get('/status', (req, res) => res.json({ connected: isReady }));

app.get('/qr', (req, res) => {
    if (isReady) return res.json({ connected: true });
    if (!qrCodeBase64) return res.status(404).json({ error: 'QR no disponible aún' });
    res.json({ qr: qrCodeBase64 });
});

app.post('/send-service-notification', authMiddleware, async (req, res) => {
    const data = req.body;
    if (!isReady) return res.status(503).json({ error: 'Nova no está conectada' });
    try {
        const jid = resolveWAId(data.clienteTelefono);
        const text = `¡Hola, *${data.clienteNombre}*! 👋\n\nSoy *Nova*, asistente virtual de *Transportes Especiales J&J* 🚐\n\nTu servicio ha sido programado exitosamente:\n\n━━━━━━━━━━━━━━━━\n🗓️ *Fecha:* ${data.fecha}\n⏰ *Hora:* ${data.hora}\n📍 *Origen:* ${data.origen}\n🏁 *Destino:* ${data.destino}\n🚗 *Placa:* ${data.placa}\n👤 *Conductor:* ${data.conductor}\n📞 *Contacto:* ${data.telefonoConductor}\n━━━━━━━━━━━━━━━━\n\nPor favor estar listo 10 minutos antes. 🙏\n\n¡Gracias por elegirnos! 🌟\n*Transportes Especiales J&J*`;
        await client.sendMessage(jid, text);
        const img = await generateServiceCard(data);
        const media = new MessageMedia('image/png', img, 'resumen_servicio.png');
        await client.sendMessage(jid, media);
        res.json({ success: true });
    } catch (error) {
        console.error('[Nova] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/send-departure-notification', authMiddleware, async (req, res) => {
    const data = req.body;
    if (!isReady) return res.status(503).json({ error: 'Nova no está conectada' });
    try {
        const jid = resolveWAId(data.clienteTelefono);

        let duracion = 'N/A', distancia = 'N/A';
        try {
            const mapsRes = await fetch(`https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(data.origen)}&destination=${encodeURIComponent(data.destino)}&language=es&departure_time=now&key=${MAPS_KEY}`);
            const mapsData = await mapsRes.json();
            if (mapsData.status === 'OK' && mapsData.routes.length > 0) {
                const leg = mapsData.routes[0].legs[0];
                duracion = leg.duration_in_traffic?.text || leg.duration.text;
                distancia = leg.distance.text;
            }
        } catch(e) { console.error('[Nova] Maps error:', e); }

        let temperatura = 'N/A', sensacion = 'N/A', descripcion = 'N/A', humedad = 'N/A', recomendacion = '';
        try {
            const wRes = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Bogota,CO&appid=${WEATHER_KEY}&units=metric&lang=es`);
            const wData = await wRes.json();
            temperatura = Math.round(wData.main.temp);
            sensacion = Math.round(wData.main.feels_like);
            descripcion = wData.weather[0].description;
            humedad = wData.main.humidity;
            const climaMain = wData.weather[0].main;
            if (['Rain','Drizzle','Thunderstorm'].includes(climaMain)) recomendacion = '🌂 *Recomendación:* Hay probabilidad de lluvia. Te sugerimos llevar paraguas o impermeable.';
            else if (temperatura < 14) recomendacion = '🧥 *Recomendación:* Hace frío. Te sugerimos llevar abrigo o chaqueta.';
            else if (temperatura > 24) recomendacion = '☀️ *Recomendación:* Hace calor. Te sugerimos ropa ligera y protector solar.';
            else recomendacion = '✅ *Recomendación:* El clima está agradable. ¡Disfruta tu viaje!';
        } catch(e) { console.error('[Nova] Weather error:', e); }

        const text = `🚐 *¡Es hora de tu servicio!*\n\nHola *${data.clienteNombre}*, soy *Nova* de *Transportes Especiales J&J* 👋\n\nTu conductor ya está en camino. Información en tiempo real:\n\n━━━━━━━━━━━━━━━━\n🗺️ *Distancia:* ${distancia}\n⏱️ *Tiempo estimado:* ${duracion} (con tráfico actual)\n━━━━━━━━━━━━━━━━\n\n🌤️ *Clima en tu destino:*\n🌡️ Temperatura: ${temperatura}°C (sensación ${sensacion}°C)\n💧 Humedad: ${humedad}%\n☁️ Condición: ${descripcion}\n\n${recomendacion}\n\n━━━━━━━━━━━━━━━━\nPor favor estar listo en el punto de recogida. 🙏\n\n¡Buen viaje! 🌟\n*Transportes Especiales J&J*`;
        await client.sendMessage(jid, text);
        res.json({ success: true });
    } catch (error) {
        console.error('[Nova] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

cron.schedule('* * * * *', async () => {
    if (!isReady) return;
    const now = new Date();
    console.log(`[Cron] Revisando: ${now.toISOString()}`);
    try {
        const snapshot = await db.collection('servicios')
            .where('estado', 'in', ['Programado', 'programado'])
            .where('notificacionSalidaEnviada', '==', false)
            .get();

        for (const doc of snapshot.docs) {
            const s = doc.data();
            if (!s.horaRecogidaTimestamp) {
                console.log(`[Cron] Sin timestamp: ${s.consecutivo}`);
                continue;
            }
            const horaRecogida = s.horaRecogidaTimestamp.toDate();
            const diffMs = now - horaRecogida;
            const diffMin = diffMs / 60000;
            console.log(`[Cron] Servicio ${s.consecutivo}: diff=${diffMin.toFixed(2)} min, hora=${horaRecogida.toISOString()}`);

            if (diffMin >= 0 && diffMin <= 2) {
                console.log(`[Cron] ¡Disparando para ${s.consecutivo}!`);
                try {
                    await fetch(`http://localhost:${port}/send-departure-notification`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
                        body: JSON.stringify({
                            clienteTelefono: s.telefonoCliente || s.clienteTelefono,
                            clienteNombre: s.clienteNombre || s.cliente,
                            origen: s.origen,
                            destino: s.destino
                        })
                    });
                    await doc.ref.update({ notificacionSalidaEnviada: true });
                    console.log(`[Cron] ✅ Enviado y marcado.`);
                } catch(e) {
                    console.error(`[Cron] Error:`, e.message);
                }
            }
        }
    } catch (error) {
        console.error('[Cron] Error general:', error.message);
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`[Nova] Servidor activo en puerto ${port}`);
    client.initialize().catch(err => console.error('[Nova] Error de inicialización:', err));
});
