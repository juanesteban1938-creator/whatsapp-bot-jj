const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

// Inicialización de Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || 'studio-6997056255-a0ecc'
    });
}

const app = express();
app.use(express.json());
app.use(cors());

const port = process.env.PORT || 3001;
const apiKey = process.env.API_KEY || 'jj-connect-2026';

let qrCodeBase64 = '';
let isReady = false;

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
            '--no-first-run',
            '--no-zygote',
            '--single-process'
        ]
    }
});

client.on('qr', (qr) => {
    qrcode.toDataURL(qr, (err, url) => {
        if (err) return console.error('Error generando QR:', err);
        qrCodeBase64 = url;
    });
    isReady = false;
    console.log('Nuevo QR generado. Escanea en la página de estado.');
});

client.on('ready', () => {
    console.log('Bot Nova listo y conectado.');
    isReady = true;
    qrCodeBase64 = '';
});

client.on('disconnected', (reason) => {
    console.log('Bot desconectado:', reason);
    isReady = false;
    client.initialize().catch(err => console.error(err));
});

const authMiddleware = (req, res, next) => {
    const headerKey = req.headers['x-api-key'];
    if (apiKey && headerKey !== apiKey) {
        return res.status(401).json({ error: 'No autorizado.' });
    }
    next();
};

app.get('/status', (req, res) => res.json({ connected: isReady }));

app.get('/qr', (req, res) => {
    if (isReady) return res.json({ message: 'Conectado' });
    if (!qrCodeBase64) return res.status(404).json({ error: 'QR no listo' });
    res.json({ qr: qrCodeBase64 });
});

// Endpoint 1: Notificación inicial de programación (con Imagen de Resumen)
app.post('/send-service-notification', authMiddleware, async (req, res) => {
    const data = req.body;
    if (!data.clienteTelefono) return res.status(400).json({ error: 'Teléfono requerido' });
    if (!isReady) return res.status(503).json({ error: 'Bot no conectado' });

    try {
        const numberId = await client.getNumberId(data.clienteTelefono);
        if (!numberId) {
            return res.status(404).json({ error: 'El número no está en WhatsApp.' });
        }
        const chatId = numberId._serialized;

        const textMessage = `¡Hola, ${data.clienteNombre}! 👋\n\nSoy *Nova*, asistente virtual de *Transportes Especiales J&J* 🚐\n\nTu servicio ha sido programado exitosamente:\n\n━━━━━━━━━━━━━━━━\n🗓️ *Fecha:* ${data.fecha}\n⏰ *Hora:* ${data.hora}\n📍 *Origen:* ${data.origen}\n🏁 *Destino:* ${data.destino}\n🚗 *Placa:* ${data.placa}\n👤 *Conductor:* ${data.conductor}\n📞 *Contacto:* ${data.telefonoConductor}\n━━━━━━━━━━━━━━━━\n\nPor favor estar listo 10 minutos antes. 🙏\n\n¡Gracias por elegirnos! 🌟`;

        await client.sendMessage(chatId, textMessage);

        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 600, height: 700, deviceScaleFactor: 2 });
        
        const htmlContent = `
        <html>
        <head>
            <style>
                body { margin: 0; padding: 20px; background: #f4f6f8; font-family: 'Helvetica', 'Arial', sans-serif; }
                .card { width: 560px; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); border: 1px solid #e1e4e8; }
                .header { background: #1a5fa8; padding: 24px; display: flex; align-items: center; justify-content: space-between; color: white; }
                .header-title { font-size: 20px; font-weight: bold; letter-spacing: 1px; }
                .logo-simulado { background: white; border-radius: 8px; padding: 6px 12px; display: flex; align-items: center; gap: 6px; }
                .logo-jj { background: #1a5fa8; color: white; font-weight: 900; font-size: 14px; padding: 4px 8px; border-radius: 4px; }
                .logo-text { color: #1a5fa8; font-weight: 700; font-size: 13px; }
                .content { padding: 30px; }
                .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
                .info-box { margin-bottom: 5px; }
                .label { font-size: 10px; color: #888; text-transform: uppercase; font-weight: bold; margin-bottom: 2px; }
                .value { font-size: 14px; font-weight: bold; color: #333; }
                .route-box { grid-column: span 2; background: #f8f9fa; padding: 15px; border-radius: 10px; margin-top: 10px; border-left: 4px solid #1a5fa8; }
                .route-item { display: flex; align-items: center; margin-bottom: 8px; font-size: 13px; }
                .dot { width: 10px; height: 10px; border-radius: 50%; margin-right: 12px; }
                .footer { background: #f8f9fa; padding: 12px; text-align: center; color: #666; font-size: 10px; border-top: 1px solid #eee; font-style: italic; }
            </style>
        </head>
        <body>
            <div class="card" id="card">
                <div class="header">
                    <div class="header-title">RESUMEN DEL SERVICIO</div>
                    <div class="logo-simulado">
                        <div class="logo-jj">J&J</div>
                        <span class="logo-text">Connect</span>
                    </div>
                </div>
                <div class="content">
                    <div class="grid">
                        <div class="info-box" style="grid-column: span 2;">
                            <div class="label">Cliente / Pasajero</div>
                            <div class="value" style="font-size: 18px; color: #1a5fa8;">${data.clienteNombre}</div>
                        </div>
                        <div class="info-box">
                            <div class="label">Fecha del Servicio</div>
                            <div class="value">${data.fecha}</div>
                        </div>
                        <div class="info-box">
                            <div class="label">Hora de Recogida</div>
                            <div class="value">${data.hora}</div>
                        </div>
                        <div class="route-box">
                            <div class="route-item">
                                <div class="dot" style="background: #22c55e;"></div>
                                <div><b>Origen:</b> ${data.origen}</div>
                            </div>
                            <div class="route-item" style="margin-bottom: 0;">
                                <div class="dot" style="background: #ef4444;"></div>
                                <div><b>Destino:</b> ${data.destino}</div>
                            </div>
                        </div>
                        <div class="info-box">
                            <div class="label">Vehículo / Placa</div>
                            <div class="value">${data.placa}</div>
                        </div>
                        <div class="info-box">
                            <div class="label">Conductor</div>
                            <div class="value">${data.conductor}</div>
                        </div>
                    </div>
                </div>
                <div class="footer">
                    Nova | Asistente Virtual J&J
                </div>
            </div>
        </body>
        </html>`;

        await page.setContent(htmlContent);
        const cardElement = await page.$('#card');
        const screenshot = await cardElement.screenshot({ encoding: 'base64' });
        await browser.close();

        const media = new MessageMedia('image/png', screenshot, 'resumen_servicio.png');
        await client.sendMessage(chatId, media);

        res.json({ success: true, message: 'Notificación enviada' });
    } catch (error) {
        console.error('Error enviando notificación avanzada:', error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint 2: Notificación de salida automática (Tiempo Real + Clima)
app.post('/send-departure-notification', authMiddleware, async (req, res) => {
    const data = req.body;
    if (!data.clienteTelefono) return res.status(400).json({ error: 'Teléfono requerido' });
    if (!isReady) return res.status(503).json({ error: 'Bot no conectado' });

    try {
        // A) Google Maps Directions API
        const mapsUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(data.origen)}&destination=${encodeURIComponent(data.destino)}&language=es&departure_time=now&key=${process.env.GOOGLE_MAPS_API_KEY}`;
        const mapsResponse = await fetch(mapsUrl);
        const mapsData = await mapsResponse.json();
        
        let duracion = 'N/A';
        let distancia = 'N/A';

        if (mapsData.status === 'OK' && mapsData.routes.length > 0) {
            const leg = mapsData.routes[0].legs[0];
            duracion = leg.duration_in_traffic?.text || leg.duration.text;
            distancia = leg.distance.text;
        }

        // B) OpenWeatherMap API
        const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?q=Bogota,CO&appid=${process.env.OPENWEATHER_API_KEY}&units=metric&lang=es`;
        const weatherResponse = await fetch(weatherUrl);
        const weatherData = await weatherResponse.json();
        
        const temperatura = Math.round(weatherData.main.temp);
        const sensacion = Math.round(weatherData.main.feels_like);
        const descripcion = weatherData.weather[0].description;
        const climaMain = weatherData.weather[0].main;
        const humedad = weatherData.main.humidity;

        // C) Recomendación
        let recomendacion = '';
        if (['Rain', 'Drizzle', 'Thunderstorm'].includes(climaMain)) {
            recomendacion = '🌂 *Recomendación:* Hay probabilidad de lluvia. Te sugerimos llevar paraguas o impermeable.';
        } else if (temperatura < 14) {
            recomendacion = '🧥 *Recomendación:* Hace frío en el destino. Te sugerimos llevar abrigo o chaqueta.';
        } else if (temperatura > 24) {
            recomendacion = '☀️ *Recomendación:* Hace calor en el destino. Te sugerimos ropa ligera y protector solar.';
        } else {
            recomendacion = '✅ *Recomendación:* El clima está agradable. ¡Disfruta tu viaje!';
        }

        const numberId = await client.getNumberId(data.clienteTelefono);
        if (!numberId) return res.status(404).json({ error: 'Número no registrado' });
        const chatId = numberId._serialized;

        const textMessage = `🚐 *¡Es hora de tu servicio!*\n\nHola ${data.clienteNombre}, soy *Nova* de *Transportes Especiales J&J* 👋\n\nTu conductor ya está en camino a recogerte. Aquí tienes la información de tu ruta en tiempo real:\n\n━━━━━━━━━━━━━━━━\n🗺️ *Distancia:* ${distancia}\n⏱️ *Tiempo estimado:* ${duracion} (con tráfico actual)\n━━━━━━━━━━━━━━━━\n\n🌤️ *Clima en tu destino ahora:*\n🌡️ Temperatura: ${temperatura}°C (sensación ${sensacion}°C)\n💧 Humedad: ${humedad}%\n☁️ Condición: ${descripcion}\n\n${recomendacion}\n\n━━━━━━━━━━━━━━━━\nPor favor estar listo en el punto de recogida. 🙏\n\n¡Buen viaje! 🌟\n*Transportes Especiales J&J*`;

        await client.sendMessage(chatId, textMessage);
        res.json({ success: true, message: 'Notificación de salida enviada' });

    } catch (error) {
        console.error('Error en notificación de salida:', error);
        res.status(500).json({ error: error.message });
    }
});

// Cron Job: Revisar servicios cada minuto
cron.schedule('* * * * *', async () => {
    const now = new Date();
    console.log(`[CRON] Revisando servicios: ${now.toLocaleTimeString()}`);
    
    try {
        const snapshot = await admin.firestore()
            .collection('servicios')
            .where('estado', 'in', ['Programado', 'programado'])
            .where('notificacionSalidaEnviada', '==', false)
            .get();

        for (const doc of snapshot.docs) {
            const servicio = doc.data();
            
            if (servicio.horaRecogidaTimestamp) {
                const horaRecogida = servicio.horaRecogidaTimestamp.toDate();
                const diff = Math.abs(now - horaRecogida) / 60000; 

                if (diff <= 1) {
                    console.log(`[CRON] Disparando notificación automática para: ${servicio.cliente}`);
                    
                    const response = await fetch(`http://localhost:${port}/send-departure-notification`, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json', 
                            'x-api-key': apiKey 
                        },
                        body: JSON.stringify({
                            clienteTelefono: servicio.telefonoCliente,
                            clienteNombre: servicio.cliente,
                            origen: servicio.origen,
                            destino: servicio.destino
                        })
                    });

                    if (response.ok) {
                        await doc.ref.update({ notificacionSalidaEnviada: true });
                        console.log(`[CRON] Servicio actualizado exitosamente.`);
                    }
                }
            }
        }
    } catch (error) {
        console.error('[CRON] Error:', error);
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Bot Nova corriendo en puerto ${port}`);
    client.initialize().catch(err => console.error(err));
});
