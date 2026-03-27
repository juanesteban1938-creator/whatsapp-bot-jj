/**
 * J&J Connect - WhatsApp Bot Engine (Nova) - Versión 7.2.0 (Compacta y Segura)
 */
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const cors = require('cors');
const admin = require('firebase-admin');
const cron = require('node-cron');
const fetch = require('node-fetch');
const pino = require('pino');

if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)) });
const db = admin.firestore();
const app = express();
app.use(express.json()); app.use(cors());
const port = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'jj-connect-2026';
let sock = null, isReady = false, qrCodeBase64 = '';

function formatPhone(phone) {
    if (!phone) return null;
    let clean = String(phone).replace(/\D/g, '');
    if (clean.length < 7) return null;
    return (!clean.startsWith('57') ? '57' + clean : clean) + '@s.whatsapp.net';
}

async function guardarMensaje(jid, telefono, mensaje, tipo, nombre = 'Nova') {
    try { await db.collection('conversaciones').add({ jid, telefono, nombre, mensaje, tipo, leido: tipo === 'saliente', fecha: admin.firestore.FieldValue.serverTimestamp() }); } catch(e) {}
}
async function enviar(jid, telefono, texto) { await sock.sendMessage(jid, { text: texto }); await guardarMensaje(jid, telefono, texto, 'saliente', 'Nova'); }
async function obtenerSesion(jid) { const snap = await db.collection('sesiones_nova').doc(jid).get(); return snap.exists ? snap.data() : null; }
async function guardarSesion(jid, datos) { await db.collection('sesiones_nova').doc(jid).set({ ...datos, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); }
async function eliminarSesion(jid) { try { await db.collection('sesiones_nova').doc(jid).delete(); } catch(e) {} }

const VEHICULOS = { '1': 'Sedán / SUV — hasta 4 pasajeros', '2': 'Van — de 10 a 15 pasajeros', '3': 'Bus — de 16 a 40 pasajeros' };
const EMOJI_VEHICULO = { '1': '🚗', '2': '🚐', '3': '🚌' };

async function procesarFlujo(jid, telefono, textoRaw, nombreCliente, sesion) {
    const texto = textoRaw.toLowerCase().trim();
    if (!sesion) {
        if (/(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|cotizar|informacion|información|quiero|necesito|servicio)/.test(texto)) {
            let servicioActivo = null;
            try {
                const snap = await db.collection('services').where('telefonoCliente', 'in', [telefono, '57' + telefono]).where('estado', 'in', ['Programado', 'En Servicio']).orderBy('fecha', 'desc').limit(1).get();
                if (!snap.empty) servicioActivo = snap.docs[0].data();
            } catch(e) {}
            if (servicioActivo) {
                const emoji = servicioActivo.estado === 'En Servicio' ? '🚐' : '🗓️';
                const f = servicioActivo.fecha ? new Date(servicioActivo.fecha).toLocaleDateString('es-CO') : 'N/A';
                await enviar(jid, telefono, `¡Hola, *${nombreCliente}*! 😊\nTienes un servicio activo:\n━━━━━━━━━━━━━━━━\n${emoji} *Estado:* ${servicioActivo.estado}\n🗓️ *Fecha:* ${f}\n⏰ *Hora:* ${servicioActivo.hora || 'N/A'}\n📍 *Origen:* ${servicioActivo.origen}\n🏁 *Destino:* ${servicioActivo.destino}\n👤 *Conductor:* ${servicioActivo.conductor || 'Por asignar'}\n━━━━━━━━━━━━━━━━\n¿Necesitas algo más? Escribe *contacto* para hablar con un asesor. 😊`);
                return;
            }
            const saludo = nombreCliente !== 'Cliente' ? `¡Hola, *${nombreCliente}*! 😊` : `¡Hola! 😊`;
            await enviar(jid, telefono, `${saludo} Bienvenido a *Transportes Especiales J&J* 🚐\nSoy *Nova*, tu asistente virtual.\n¿Qué vehículo necesitas?\n1️⃣ Sedán / SUV — hasta 4 pasajeros\n2️⃣ Van — de 10 a 15 pasajeros\n3️⃣ Bus — de 16 a 40 pasajeros\n4️⃣ Hablar con un asesor`);
            await guardarSesion(jid, { paso: 'esperando_vehiculo', telefono, nombreCliente });
            return;
        }
        if (texto.includes('estado') || texto.includes('mi viaje')) {
            const snap = await db.collection('services').where('telefonoCliente', 'in', [telefono, '57' + telefono]).orderBy('fecha', 'desc').limit(1).get();
            if (snap.empty) { await enviar(jid, telefono, `No encontré servicios registrados. 😊\nEscríbeme *hola* para cotizar.`); return; }
            const s = snap.docs[0].data();
            const emoji = { 'Programado': '🗓️', 'En Servicio': '🚐', 'Finalizado': '✅', 'Cancelado': '❌' }[s.estado] || '📋';
            await enviar(jid, telefono, `Hola *${nombreCliente}* 👋 Tu último servicio:\n━━━━━━━━━━━━━━━━\n${emoji} *Estado:* ${s.estado}\n📍 *Origen:* ${s.origen}\n🏁 *Destino:* ${s.destino}\n━━━━━━━━━━━━━━━━`);
            return;
        }
        if (texto.includes('pago') || texto.includes('factura') || texto.includes('saldo')) {
            const snap = await db.collection('services').where('telefonoCliente', 'in', [telefono, '57' + telefono]).orderBy('fecha', 'desc').limit(1).get();
            if (snap.empty) { await enviar(jid, telefono, `No encontré servicios. Llámanos al 📞 *314 2889955*.`); return; }
            const s = snap.docs[0].data();
            await enviar(jid, telefono, `${s.estadoPago === 'Pagado' ? '✅' : '⚠️'} *Estado de pago:* ${s.estadoPago || 'Pendiente'}\n💵 *Saldo pendiente:* $${(Number(s.saldo)||0).toLocaleString('es-CO')}\nPago a: Cuenta Ahorros *99642554661* Bancolombia`);
            return;
        }
        if (texto.includes('contacto')) { await enviar(jid, telefono, `📞 *Transportes Especiales J&J*\nCelular: *+57 314 2889955*\nCorreo: transportes.especialesjyj@gmail.com`); return; }
        if (/(gracias|ok|listo|perfecto|entendido|jajaja|jaja|claro|genial|excelente|bien|👍|😊|🙏)/.test(texto)) return;
        await enviar(jid, telefono, `¡Hola! 😊 Soy *Nova*.\nEscríbeme *hola* para cotizar o consultar:\n📋 *estado*\n💰 *pago*\n📞 *contacto*`);
        return;
    }

    if (texto === 'cancelar' || texto === 'salir') { await eliminarSesion(jid); await enviar(jid, telefono, `Solicitud cancelada. 😊`); return; }

    if (sesion.paso === 'esperando_vehiculo') {
        const opcion = texto.replace(/[^1-4]/g, '').trim();
        if (opcion === '4' || texto.includes('asesor')) {
            await eliminarSesion(jid);
            await db.collection('modo_agente').doc(jid).set({ activo: true, activadoPor: 'solicitud', fecha: new Date().toISOString() });
            await enviar(jid, telefono, `¡Con mucho gusto! 😊 En breve un asesor te contactará.`);
            return;
        }
        if (!VEHICULOS[opcion]) { await enviar(jid, telefono, `Por favor responde con 1, 2, 3 o 4.`); return; }
        await enviar(jid, telefono, `${EMOJI_VEHICULO[opcion]} *${VEHICULOS[opcion]}*\nExcelente elección. 😊`);
        setTimeout(async () => { await enviar(jid, telefono, `📍 ¿Cuál es tu *lugar de recogida*?`); }, 1000);
        await guardarSesion(jid, { paso: 'esperando_recogida', tipoVehiculo: VEHICULOS[opcion] });
        return;
    }
    if (sesion.paso === 'esperando_recogida') {
        await guardarSesion(jid, { paso: 'esperando_hora', lugarRecogida: textoRaw });
        await enviar(jid, telefono, `Anotado ✅\n⏰ ¿A qué *hora* necesitas el servicio? (Ej: 8:00 AM)`);
        return;
    }
    if (sesion.paso === 'esperando_hora') {
        await guardarSesion(jid, { paso: 'esperando_fecha', horaRecogida: textoRaw });
        await enviar(jid, telefono, `Perfecto ✅\n🗓️ ¿Para qué *fecha*?`);
        return;
    }
    if (sesion.paso === 'esperando_fecha') {
        await guardarSesion(jid, { paso: 'esperando_destino', fechaServicio: textoRaw });
        await enviar(jid, telefono, `Anotado ✅\n🏁 ¿Cuál es tu *destino*?`);
        return;
    }
    if (sesion.paso === 'esperando_destino') {
        await guardarSesion(jid, { paso: 'esperando_confirmacion', destino: textoRaw });
        const s = await obtenerSesion(jid);
        await enviar(jid, telefono, `Confirma tus datos:\n🚐 Vehículo: ${s.tipoVehiculo}\n📍 Origen: ${s.lugarRecogida}\n🏁 Destino: ${textoRaw}\n🗓️ Fecha: ${s.fechaServicio}\n⏰ Hora: ${s.horaRecogida}\n\n✅ Escribe *SI* para confirmar o *NO* para corregir.`);
        return;
    }
    if (sesion.paso === 'esperando_confirmacion') {
        if (texto.includes('si') || texto === 's') {
            await db.collection('cotizaciones').add({ telefono, nombreCliente, jid, tipoVehiculo: sesion.tipoVehiculo, lugarRecogida: sesion.lugarRecogida, horaRecogida: sesion.horaRecogida, fechaServicio: sesion.fechaServicio, destino: sesion.destino, estado: 'pendiente', fecha: admin.firestore.FieldValue.serverTimestamp() });
            await eliminarSesion(jid);
            await enviar(jid, telefono, `¡Gracias por tu solicitud! 🙌 Un asesor te responderá pronto. ⏱️`);
        } else if (texto.includes('no')) {
            await eliminarSesion(jid);
            await guardarSesion(jid, { paso: 'esperando_vehiculo', telefono, nombreCliente });
            await enviar(jid, telefono, `Vamos de nuevo.\n¿Qué vehículo necesitas?\n1️⃣ Sedán\n2️⃣ Van\n3️⃣ Bus`);
        }
        return;
    }
}

async function aplicarPago(jid, telefono, servicio, pago) {
    const nuevoAnticipo = (Number(servicio.anticipo) || 0) + Number(pago.valor);
    const nuevoSaldo = Math.max(0, (Number(servicio.valorServicio) || 0) - nuevoAnticipo);
    const estadoPago = nuevoSaldo <= 0 ? 'Pagado' : 'Anticipo';
    try {
        await db.collection('services').doc(servicio.id).update({
            anticipo: nuevoAnticipo, saldo: nuevoSaldo, estadoPago,
            ultimoPago: { valor: pago.valor, numeroTransaccion: pago.numeroTransaccion || 'N/A', bancoOrigen: pago.bancoOrigen || 'N/A', fecha: pago.fecha || new Date().toISOString(), aplicadoEn: admin.firestore.FieldValue.serverTimestamp() }
        });
        const jidCliente = formatPhone(servicio.telefonoCliente);
        if (estadoPago === 'Pagado') {
            const msg = `✅ *¡Pago confirmado!*\nValor: $${pago.valor.toLocaleString('es-CO')}\nServicio: ${servicio.consecutivo}\nEstado: PAGADO`;
            if (jidCliente) await sock.sendMessage(jidCliente, { text: msg });
            if (jidCliente !== jid) await enviar(jid, telefono, `✅ Pago aplicado al ${servicio.consecutivo}. PAGADO.`);
        } else {
            const msg = `✅ *Anticipo registrado*\nValor: $${pago.valor.toLocaleString('es-CO')}\nSaldo pendiente: $${nuevoSaldo.toLocaleString('es-CO')}`;
            if (jidCliente) await sock.sendMessage(jidCliente, { text: msg });
            if (jidCliente !== jid) await enviar(jid, telefono, `✅ Anticipo aplicado. Saldo: $${nuevoSaldo.toLocaleString('es-CO')}.`);
        }
    } catch(e) { await enviar(jid, telefono, `Error al aplicar pago.`); }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('/app/.baileys_auth');
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }) });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
        if (u.qr) { qrCodeBase64 = await qrcode.toDataURL(u.qr); isReady = false; }
        if (u.connection === 'close') { isReady = false; setTimeout(connectToWhatsApp, 3000); }
        if (u.connection === 'open') { isReady = true; qrCodeBase64 = ''; console.log('[Nova] ✅ Conectado.'); }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' || !messages[0].message) return;
        const msg = messages[0], jid = msg.key.remoteJid;
        if (!jid || jid.includes('@g.us')) return;
        if (msg.key.fromMe) { await db.collection('modo_agente').doc(jid).set({ activo: true, fecha: new Date().toISOString() }); return; }

        const textoRaw = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const realJid = msg.key.senderPn || jid;
        const telefono = realJid.replace('@s.whatsapp.net', '').replace('@lid', '').replace(/^57/, '');
        const esAdmin = telefono === '3058532676' || jid.includes('55267655942264');

        if (msg.message.imageMessage || msg.message.documentMessage) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text: `Extrae JSON exacto de este pago: {"esComprobante":true,"valor":15000,"numeroTransaccion":"M123","bancoOrigen":"Nequi","bancoDestino":"Bancolombia","fecha":"2023"}` }, { inlineData: { mimeType: msg.message.imageMessage?.mimetype || 'image/jpeg', data: buffer.toString('base64') } }] }] })
                });
                const data = await res.json();
                const txt = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                const pago = JSON.parse(txt.match(/\{[\s\S]*\}/)[0]);

                if (!pago.esComprobante) { await enviar(jid, telefono, `No identifico un comprobante.`); return; }
                
                if (esAdmin) {
                    let lista = '\n📋 *Cartera:*\n';
                    const pSnap = await db.collection('services').where('estadoPago', 'in', ['Pendiente', 'Anticipo']).get();
                    let arr = []; pSnap.forEach(d => arr.push({id: d.id, ...d.data()}));
                    arr.sort((a,b) => new Date(b.fecha||0) - new Date(a.fecha||0));
                    arr.slice(0, 10).forEach(s => lista += `• *${s.consecutivo}* - ${s.clienteNombre} ($${(Number(s.saldo)||0).toLocaleString()})\n`);
                    await db.collection('sesiones_nova').doc(jid).set({ paso: 'admin_pago', pagoData: pago });
                    await enviar(jid, telefono, `✅ Valor: $${pago.valor}\nRef: ${pago.numeroTransaccion}${arr.length?lista:'\n✅ No hay cartera.'}\n👉 Escribe el consecutivo (ej: JJ-1018).`);
                } else {
                    const pSnap = await db.collection('services').where('telefonoCliente', 'in', [telefono, '57'+telefono]).where('estadoPago', 'in', ['Pendiente', 'Anticipo']).orderBy('fecha', 'desc').limit(1).get();
                    if (pSnap.empty) { await enviar(jid, telefono, `Recibimos comprobante por $${pago.valor}. Un asesor confirmará.`); return; }
                    await aplicarPago(jid, telefono, {id: pSnap.docs[0].id, ...pSnap.docs[0].data()}, pago);
                }
            } catch(e) { await enviar(jid, telefono, `Error procesando la imagen.`); }
            return;
        }

        const sAdmin = await obtenerSesion(jid).catch(() => null);
        if (esAdmin && sAdmin?.paso === 'admin_pago') {
            const snap = await db.collection('services').where('consecutivo', '==', textoRaw.toUpperCase()).limit(1).get();
            if (snap.empty) { await enviar(jid, telefono, `No encontré el servicio ${textoRaw.toUpperCase()}.`); return; }
            await aplicarPago(jid, telefono, {id: snap.docs[0].id, ...snap.docs[0].data()}, sAdmin.pagoData);
            await eliminarSesion(jid); return;
        }

        await guardarMensaje(jid, telefono, textoRaw, 'entrante', telefono);
        if (!textoRaw) return;

        const agente = await db.collection('modo_agente').doc(jid).get();
        if (agente.exists && (Date.now() - new Date(agente.data().fecha).getTime()) / 3600000 < 72) return;

        let nombreCliente = 'Cliente';
        const userSnap = await db.collection('services').where('telefonoCliente', 'in', [telefono, '57'+telefono]).orderBy('fecha', 'desc').limit(1).get();
        if (!userSnap.empty) nombreCliente = userSnap.docs[0].data().clienteNombre || 'Cliente';

        await procesarFlujo(jid, telefono, textoRaw, nombreCliente, await obtenerSesion(jid));
    });
}

app.get('/health', (req, res) => res.send('OK'));
app.get('/status', (req, res) => res.json({ connected: isReady }));
app.get('/qr', (req, res) => res.json({ qr: qrCodeBase64 }));

cron.schedule('* * * * *', async () => {
    if (!isReady) return;
    try {
        const snap = await db.collection('services').where('estado', 'in', ['Programado', 'programado']).where('notificacionSalidaEnviada', '==', false).get();
        const now = new Date();
        for (const doc of snap.docs) {
            const s = doc.data();
            if (!s.fecha || !s.hora) continue;
            const d = new Date(`${s.fecha.substring(0, 10)}T${s.hora}:00-05:00`);
            if ((now - d) / 60000 >= 0 && (now - d) / 60000 <= 2) {
                await doc.ref.update({ estado: 'En Servicio', notificacionSalidaEnviada: true });
                if (s.conductorTelefono) {
                    const cJid = formatPhone(s.conductorTelefono);
                    if (cJid) await sock.sendMessage(cJid, { text: `🚐 Servicio INICIADO\nLink GPS: https://studio--jj-connect--18988325-5ab9e.us-central1.hosted.app/gps/${doc.id}` });
                }
            }
        }
    } catch(e) {}
});

app.listen(port, '0.0.0.0', () => { connectToWhatsApp().catch(e => console.log(e)); });
