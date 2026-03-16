/**
 * J&J Connect - WhatsApp Bot Engine (Nova)
 * Versión: 6.3.0 (Baileys + historial + bandeja de conversaciones)
 */

const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const cors = require('cors');
const admin = require('firebase-admin');
const cron = require('node-cron');
const fetch = require('node-fetch');
const pino = require('pino');

if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const app = express();
app.use(express.json());
app.use(cors());

const port = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'jj-connect-2026';
const WEATHER_KEY = process.env.OPENWEATHER_API_KEY;
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

let sock = null;
let isReady = false;
let qrCodeBase64 = '';

function formatPhone(phone) {
    if (!phone) return null;
    let clean = String(phone).replace(/\D/g, '');
    if (clean.length < 7) return null;
    if (!clean.startsWith('57')) clean = '57' + clean;
    return clean + '@s.whatsapp.net';
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('/app/.baileys_auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeBase64 = await qrcode.toDataURL(qr);
            isReady = false;
            console.log('[Nova] QR generado - esperando escaneo...');
        }

        if (connection === 'close') {
            isReady = false;
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;
            console.log('[Nova] Desconectado. Reconectando:', shouldReconnect);
            if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
        }

        if (connection === 'open') {
            isReady = true;
            qrCodeBase64 = '';
            console.log('[Nova] ✅ Sistema listo y conectado.');
        }
    });

    // ── Listener de mensajes entrantes ──────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        if (!jid || jid.includes('@g.us')) return; // ignorar grupos

        const textoRaw = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text || ''
        ).trim();
        const texto = textoRaw.toLowerCase();
        const telefono = jid.replace('@s.whatsapp.net', '').replace(/^57/, '');

        console.log(`[Nova] 📩 Mensaje de ${telefono}: ${textoRaw}`);

        // Guardar mensaje entrante en Firestore
        try {
            await db.collection('conversaciones').add({
                jid,
                telefono,
                mensaje: textoRaw,
                tipo: 'entrante',
                leido: false,
                fecha: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch(e) { console.error('[Nova] Error guardando mensaje:', e.message); }

        // Buscar último servicio del cliente
        let ultimoServicio = null;
        let nombreCliente = 'Cliente';
        try {
            const snap = await db.collection('services')
                .where('telefonoCliente', '==', telefono)
                .orderBy('fecha', 'desc')
                .limit(1)
                .get();
            if (!snap.empty) {
                ultimoServicio = snap.docs[0].data();
                nombreCliente = ultimoServicio.clienteNombre || ultimoServicio.cliente || 'Cliente';
            }
        } catch(e) { console.error('[Nova] Error buscando servicio:', e.message); }

        // Actualizar nombre en conversación si se encontró cliente
        if (nombreCliente !== 'Cliente') {
            try {
                const convSnap = await db.collection('conversaciones')
                    .where('jid', '==', jid)
                    .orderBy('fecha', 'desc')
                    .limit(1)
                    .get();
                if (!convSnap.empty) {
                    await convSnap.docs[0].ref.update({ nombre: nombreCliente });
                }
            } catch(e) {}
        }

        let respuesta = null;

        // ── Respuestas automáticas ───────────────────────────────────────
        if (texto.includes('hola') || texto.includes('buenas') || texto.includes('buen dia') || texto.includes('buenos dias')) {
            respuesta = `¡Hola, *${nombreCliente}*! 👋\n\nSoy *Nova*, asistente virtual de *Transportes Especiales J&J* 🚐\n\nPuedes escribirme:\n\n📋 *estado* — Ver tu último servicio\n📞 *contacto* — Información de contacto\n❓ *ayuda* — Ver todas las opciones\n\n¡Con gusto te atiendo! 😊`;
        }
        else if (texto.includes('estado') || texto.includes('servicio') || texto.includes('mi viaje')) {
            if (!ultimoServicio) {
                respuesta = `Hola 👋 No encontré servicios registrados con este número.\n\nPara más información contáctanos al 📞 *314 2889955*.`;
            } else {
                const estadoEmoji = { 'Programado': '🗓️', 'En Servicio': '🚐', 'Finalizado': '✅', 'Cancelado': '❌' }[ultimoServicio.estado] || '📋';
                const fecha = ultimoServicio.fecha ? new Date(ultimoServicio.fecha).toLocaleDateString('es-CO') : 'N/A';
                respuesta = `Hola *${nombreCliente}* 👋\n\nEstado de tu último servicio:\n\n━━━━━━━━━━━━━━━━\n${estadoEmoji} *Estado:* ${ultimoServicio.estado}\n🗓️ *Fecha:* ${fecha}\n⏰ *Hora:* ${ultimoServicio.hora || 'N/A'}\n📍 *Origen:* ${ultimoServicio.origen}\n🏁 *Destino:* ${ultimoServicio.destino}\n👤 *Conductor:* ${ultimoServicio.conductor || 'Por asignar'}\n━━━━━━━━━━━━━━━━\n\n¿Necesitas algo más? Escribe *ayuda* 😊`;
            }
        }
        else if (texto.includes('ayuda') || texto.includes('opciones') || texto.includes('menu') || texto.includes('menú')) {
            respuesta = `Hola *${nombreCliente}* 👋 Estas son mis opciones:\n\n📋 *estado* — Ver tu último servicio\n📞 *contacto* — Datos de contacto\n💰 *pago* — Estado de pago de tu servicio\n\n¿En qué te puedo ayudar? 😊`;
        }
        else if (texto.includes('contacto') || texto.includes('telefono') || texto.includes('teléfono') || texto.includes('numero')) {
            respuesta = `📞 *Transportes Especiales J&J*\n\nCelular: *+57 314 2889955*\nCorreo: transportes.especialesjyj@gmail.com\nDirección: Carrera 58 #130A-82\n\n¡Con gusto te atendemos! 😊`;
        }
        else if (texto.includes('pago') || texto.includes('factura') || texto.includes('cobro') || texto.includes('deuda')) {
            if (!ultimoServicio) {
                respuesta = `No encontré servicios con este número. Contáctanos al 📞 *314 2889955*.`;
            } else {
                const estadoPago = ultimoServicio.estadoPago || 'Pendiente';
                const saldo = Number(ultimoServicio.saldo) || 0;
                const pagoEmoji = estadoPago === 'Pagado' ? '✅' : '⚠️';
                respuesta = `${pagoEmoji} *Estado de pago:* ${estadoPago}\n💵 *Saldo pendiente:* $${saldo.toLocaleString('es-CO')}\n\nPara realizar tu pago:\n🏦 Cuenta Ahorros *99642554661* Bancolombia\n\n¡Gracias por tu preferencia! 🙏`;
            }
        }
        else {
            // Mensaje no reconocido
            respuesta = `Hola *${nombreCliente}* 👋\n\nNo entendí tu mensaje. Escribe *ayuda* para ver las opciones disponibles. 😊`;
        }

        // Enviar respuesta
        if (respuesta) {
            try {
                await sock.sendMessage(jid, { text: respuesta });
                console.log(`[Nova] ✅ Respuesta enviada a ${telefono}`);

                // Guardar respuesta en Firestore
                await db.collection('conversaciones').add({
                    jid,
                    telefono,
                    nombre: 'Nova',
                    mensaje: respuesta,
                    tipo: 'saliente',
                    leido: true,
                    fecha: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch(e) { console.error('[Nova] Error enviando respuesta:', e.message); }
        }
    });
}

const authMiddleware = (req, res, next) => {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'No autorizado.' });
    next();
};

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/status', (req, res) => res.json({ connected: isReady }));

app.get('/qr', (req, res) => {
    if (isReady) return res.json({ connected: true });
    if (!qrCodeBase64) return res.status(404).json({ error: 'QR no disponible aún' });
    res.json({ qr: qrCodeBase64 });
});

app.post('/send-message', authMiddleware, async (req, res) => {
    const { jid, mensaje } = req.body;
    if (!isReady) return res.status(503).json({ error: 'Nova no está conectada' });
    if (!jid || !mensaje) return res.status(400).json({ error: 'Faltan datos' });
    try {
        await sock.sendMessage(jid, { text: mensaje });
        await db.collection('conversaciones').add({
            jid,
            telefono: jid.replace('@s.whatsapp.net', '').replace(/^57/, ''),
            nombre: 'Admin J&J',
            mensaje,
            tipo: 'saliente',
            leido: true,
            fecha: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch(error) {
        console.error('[Nova] Error enviando mensaje manual:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/send-service-notification', authMiddleware, async (req, res) => {
    const data = req.body;
    if (!isReady) return res.status(503).json({ error: 'Nova no está conectada' });

    const jid = formatPhone(data.clienteTelefono);
    if (!jid) return res.status(400).json({ error: 'Teléfono inválido: ' + data.clienteTelefono });

    try {
        const text = `¡Hola, *${data.clienteNombre}*! 👋\n\nSoy *Nova*, asistente virtual de *Transportes Especiales J&J* 🚐\n\nTu servicio ha sido programado:\n\n━━━━━━━━━━━━━━━━\n🗓️ *Fecha:* ${data.fecha}\n⏰ *Hora:* ${data.hora}\n📍 *Origen:* ${data.origen}\n🏁 *Destino:* ${data.destino}\n🚗 *Placa:* ${data.placa}\n👤 *Conductor:* ${data.conductor}\n📞 *Contacto:* ${data.telefonoConductor}\n━━━━━━━━━━━━━━━━\n\nPor favor estar listo 10 minutos antes. 🙏\n\n¡Gracias por elegirnos! 🌟\n*Transportes Especiales J&J*`;

        await sock.sendMessage(jid, { text });
        console.log('[Nova] ✅ Mensaje enviado a:', jid);

        // Registrar en historial Firestore
        await db.collection('notificaciones_whatsapp').add({
            clienteNombre: data.clienteNombre,
            clienteTelefono: data.clienteTelefono,
            tipo: 'servicio_programado',
            mensaje: text,
            estado: 'enviado',
            fecha: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true });
    } catch (error) {
        console.error('[Nova] Error:', error.message);

        // Registrar error en historial Firestore
        try {
            await db.collection('notificaciones_whatsapp').add({
                clienteNombre: data.clienteNombre,
                clienteTelefono: data.clienteTelefono,
                tipo: 'servicio_programado',
                mensaje: '',
                estado: 'error',
                error: error.message,
                fecha: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch(e) { console.error('[Nova] Error guardando log:', e.message); }

        res.status(500).json({ error: error.message });
    }
});

app.post('/send-departure-notification', authMiddleware, async (req, res) => {
    const data = req.body;
    if (!isReady) return res.status(503).json({ error: 'Nova no está conectada' });

    const jid = formatPhone(data.clienteTelefono);
    if (!jid) return res.status(400).json({ error: 'Teléfono inválido' });

    try {
        let duracion = 'N/A', distancia = 'N/A';
        try {
            const mapsRes = await fetch(`https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(data.origen)}&destination=${encodeURIComponent(data.destino)}&language=es&departure_time=now&key=${MAPS_KEY}`);
            const mapsData = await mapsRes.json();
            if (mapsData.status === 'OK' && mapsData.routes.length > 0) {
                const leg = mapsData.routes[0].legs[0];
                duracion = leg.duration_in_traffic?.text || leg.duration.text;
                distancia = leg.distance.text;
            }
        } catch(e) { console.error('[Nova] Maps error:', e.message); }

        let temperatura = 'N/A', sensacion = 'N/A', descripcion = 'N/A', humedad = 'N/A', recomendacion = '';
        try {
            const wRes = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Bogota,CO&appid=${WEATHER_KEY}&units=metric&lang=es`);
            const wData = await wRes.json();
            temperatura = Math.round(wData.main.temp);
            sensacion = Math.round(wData.main.feels_like);
            descripcion = wData.weather[0].description;
            humedad = wData.main.humidity;
            const climaMain = wData.weather[0].main;
            if (['Rain','Drizzle','Thunderstorm'].includes(climaMain)) recomendacion = '🌂 *Recomendación:* Lleva paraguas o impermeable.';
            else if (temperatura < 14) recomendacion = '🧥 *Recomendación:* Lleva abrigo o chaqueta.';
            else if (temperatura > 24) recomendacion = '☀️ *Recomendación:* Ropa ligera y protector solar.';
            else recomendacion = '✅ *Recomendación:* El clima está agradable. ¡Disfruta tu viaje!';
        } catch(e) { console.error('[Nova] Weather error:', e.message); }

        const text = `🚐 *¡Es hora de tu servicio!*\n\nHola *${data.clienteNombre}*, soy *Nova* de *Transportes Especiales J&J* 👋\n\nTu conductor ya está en camino:\n\n━━━━━━━━━━━━━━━━\n🗺️ *Distancia:* ${distancia}\n⏱️ *Tiempo estimado:* ${duracion}\n━━━━━━━━━━━━━━━━\n\n🌤️ *Clima en tu destino:*\n🌡️ ${temperatura}°C (sensación ${sensacion}°C)\n💧 Humedad: ${humedad}%\n☁️ ${descripcion}\n\n${recomendacion}\n\n¡Buen viaje! 🌟\n*Transportes Especiales J&J*`;

        await sock.sendMessage(jid, { text });
        console.log('[Nova] ✅ Notificación de salida enviada a:', jid);

        // Registrar en historial Firestore
        await db.collection('notificaciones_whatsapp').add({
            clienteNombre: data.clienteNombre,
            clienteTelefono: data.clienteTelefono,
            tipo: 'notificacion_salida',
            mensaje: text,
            estado: 'enviado',
            fecha: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true });
    } catch (error) {
        console.error('[Nova] Error:', error.message);

        // Registrar error en historial Firestore
        try {
            await db.collection('notificaciones_whatsapp').add({
                clienteNombre: data.clienteNombre,
                clienteTelefono: data.clienteTelefono,
                tipo: 'notificacion_salida',
                mensaje: '',
                estado: 'error',
                error: error.message,
                fecha: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch(e) { console.error('[Nova] Error guardando log:', e.message); }

        res.status(500).json({ error: error.message });
    }
});

cron.schedule('* * * * *', async () => {
    if (!isReady) return;
    const now = new Date();
    console.log(`[Cron] Revisando servicios: ${now.toISOString()}`);
    try {
        const snapshot = await db.collection('services')
            .where('estado', 'in', ['Programado', 'programado'])
            .where('notificacionSalidaEnviada', '==', false)
            .get();

        console.log(`[Cron] Servicios encontrados: ${snapshot.docs.length}`);

        for (const docSnap of snapshot.docs) {
            const s = docSnap.data();

            let horaRecogida = null;

            // Usar campos fecha + hora que guarda la app
            if (s.fecha && s.hora) {
                try {
                    // fecha es ISO string, hora es "HH:mm"
                    const fechaBase = new Date(s.fecha);
                    const [horas, minutos] = s.hora.split(':').map(Number);
                    horaRecogida = new Date(fechaBase);
                    horaRecogida.setHours(horas, minutos, 0, 0);
                } catch(e) { console.error('[Cron] Error fecha:', e.message); continue; }
            } else {
                console.log(`[Cron] Sin fecha/hora para: ${docSnap.id}`);
                continue;
            }

            const diffMin = (now - horaRecogida) / 60000;
            console.log(`[Cron] ${docSnap.id}: diff=${diffMin.toFixed(2)}min, hora=${horaRecogida.toISOString()}`);

            if (diffMin >= 0 && diffMin <= 2) {
                const phone = formatPhone(s.telefonoCliente || s.contactNumber);
                if (!phone) { console.error('[Cron] Sin teléfono para', docSnap.id); continue; }

                try {
                    await fetch(`http://localhost:${port}/send-departure-notification`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
                        body: JSON.stringify({
                            clienteTelefono: String(s.telefonoCliente || s.contactNumber),
                            clienteNombre: s.clienteNombre || s.cliente,
                            origen: s.origen,
                            destino: s.destino
                        })
                    });
                    await docSnap.ref.update({ notificacionSalidaEnviada: true });
                    console.log(`[Cron] ✅ Enviado para ${docSnap.id}`);
                } catch(e) { console.error(`[Cron] Error:`, e.message); }
            }
        }
    } catch (error) { console.error('[Cron] Error:', error.message); }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`[Nova] Servidor activo en puerto ${port}`);
    connectToWhatsApp().catch(err => console.error('[Nova] Error:', err));
});
