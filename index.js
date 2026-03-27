/**
 * J&J Connect - WhatsApp Bot Engine (Nova)
 * Versión: 7.0.5 (Actualización de modelo Gemini a 2.5-flash)
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

// ── Guardar mensaje en Firestore ─────────────────────────────────────────────
async function guardarMensaje(jid, telefono, mensaje, tipo, nombre = 'Nova') {
    try {
        await db.collection('conversaciones').add({
            jid, telefono, nombre, mensaje, tipo,
            leido: tipo === 'saliente',
            fecha: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch(e) { console.error('[Nova] Error guardando mensaje:', e.message); }
}

// ── Enviar mensaje y guardarlo ───────────────────────────────────────────────
async function enviar(jid, telefono, texto) {
    await sock.sendMessage(jid, { text: texto });
    await guardarMensaje(jid, telefono, texto, 'saliente', 'Nova');
}

// ── Sesiones ─────────────────────────────────────────────────────────────────
async function obtenerSesion(jid) {
    const snap = await db.collection('sesiones_nova').doc(jid).get();
    return snap.exists ? snap.data() : null;
}

async function guardarSesion(jid, datos) {
    await db.collection('sesiones_nova').doc(jid).set({
        ...datos,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

async function eliminarSesion(jid) {
    try { await db.collection('sesiones_nova').doc(jid).delete(); } catch(e) {}
}

// ── Datos de vehículos ────────────────────────────────────────────────────────
const VEHICULOS = {
    '1': 'Sedán / SUV — hasta 4 pasajeros',
    '2': 'Van — de 10 a 15 pasajeros',
    '3': 'Bus — de 16 a 40 pasajeros'
};

const EMOJI_VEHICULO = { '1': '🚗', '2': '🚐', '3': '🚌' };

const BENEFICIOS = `✨ *¿Por qué elegirnos?*

🛡️ *Seguridad garantizada:* Contamos con póliza de Responsabilidad Civil Extracontractual y Contractual vigente, cumpliendo la normativa colombiana (Decreto 431 de 2017).

🔧 *Mantenimiento preventivo:* Realizamos 2 revisiones técnicas al mes para garantizar que cada vehículo esté en óptimas condiciones antes de cada servicio.

🧹 *Protocolos de limpieza:* Desinfección completa del vehículo antes de cada servicio.

🐾 *Pet friendly:* Aceptamos mascotas en nuestros traslados.

📋 *Documentación al día:* SOAT, tecnomecánica y licencias siempre vigentes.

¡Tu comodidad y seguridad son nuestra prioridad! 🌟`;

// ── Flujo conversacional ──────────────────────────────────────────────────────
async function procesarFlujo(jid, telefono, textoRaw, nombreCliente, sesion) {
    const texto = textoRaw.toLowerCase().trim();

    // ── Sin sesión activa ─────────────────────────────────────────────────────
    if (!sesion) {
        const esSaludo = texto.includes('hola') || texto.includes('buenas') ||
            texto.includes('buen dia') || texto.includes('buenos dias') ||
            texto.includes('buenas tardes') || texto.includes('buenas noches') ||
            texto.includes('cotizar') || texto.includes('informacion') ||
            texto.includes('información') || texto.includes('quiero') ||
            texto.includes('necesito') || texto.includes('servicio');

        if (esSaludo) {
            // Verificar si tiene servicio activo
            let servicioActivo = null;
            try {
                const snapActivo = await db.collection('services')
                    .where('telefonoCliente', 'in', [telefono, '57' + telefono])
                    .where('estado', 'in', ['Programado', 'En Servicio'])
                    .orderBy('fecha', 'desc').limit(1).get();
                if (!snapActivo.empty) servicioActivo = snapActivo.docs[0].data();
            } catch(e) {}

            if (servicioActivo) {
                // Cliente con servicio activo — respuesta contextual
                const estadoEmoji = servicioActivo.estado === 'En Servicio' ? '🚐' : '🗓️';
                const fecha = servicioActivo.fecha
                    ? new Date(servicioActivo.fecha).toLocaleDateString('es-CO') : 'N/A';
                await enviar(jid, telefono,
                    `¡Hola, *${nombreCliente}*! 😊\n\nTienes un servicio activo con nosotros:\n\n━━━━━━━━━━━━━━━━\n${estadoEmoji} *Estado:* ${servicioActivo.estado}\n🗓️ *Fecha:* ${fecha}\n⏰ *Hora:* ${servicioActivo.hora || 'N/A'}\n📍 *Origen:* ${servicioActivo.origen}\n🏁 *Destino:* ${servicioActivo.destino}\n👤 *Conductor:* ${servicioActivo.conductor || 'Por asignar'}\n━━━━━━━━━━━━━━━━\n\n¿Necesitas algo más? Escribe *contacto* para hablar con un asesor. 😊`
                );
                return;
            }

            // Cliente sin servicio activo — mostrar menú normal
            const saludo = nombreCliente !== 'Cliente' ? `¡Hola, *${nombreCliente}*! 😊` : `¡Hola! 😊`;
            await enviar(jid, telefono,
                `${saludo} Bienvenido a *Transportes Especiales J&J* 🚐\n\nSoy *Nova*, tu asistente virtual. Es un placer atenderte.\n\n¿Qué tipo de vehículo necesitas para tu servicio?\n\n1️⃣ Sedán / SUV — hasta 4 pasajeros\n2️⃣ Van — de 10 a 15 pasajeros\n3️⃣ Bus — de 16 a 40 pasajeros\n4️⃣ Hablar con un asesor\n\n_Responde con el número de tu opción._`
            );
            await guardarSesion(jid, {
                paso: 'esperando_vehiculo', telefono, nombreCliente,
                tipoVehiculo: null, lugarRecog
