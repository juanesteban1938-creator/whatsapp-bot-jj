/**
 * J&J Connect - WhatsApp Bot Engine (Nova)
 * Versión: 7.0.4 (Fix Safety Settings Gemini + Raw Log)
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
                tipoVehiculo: null, lugarRecogida: null,
                horaRecogida: null, fechaServicio: null, destino: null
            });
            return;
        }

        // Consulta estado
        if (texto.includes('estado') || texto.includes('mi viaje')) {
            const snap = await db.collection('services')
                .where('telefonoCliente', 'in', [telefono, '57' + telefono])
                .orderBy('fecha', 'desc').limit(1).get();
            if (snap.empty) {
                await enviar(jid, telefono, `No encontré servicios registrados con este número. 😊\n\n¿Deseas cotizar un nuevo servicio? Escríbeme *hola* para comenzar.`);
            } else {
                const s = snap.docs[0].data();
                const estadoEmoji = { 'Programado': '🗓️', 'En Servicio': '🚐', 'Finalizado': '✅', 'Cancelado': '❌' }[s.estado] || '📋';
                const fecha = s.fecha ? new Date(s.fecha).toLocaleDateString('es-CO') : 'N/A';
                await enviar(jid, telefono,
                    `Hola *${nombreCliente}* 👋 Aquí el estado de tu último servicio:\n\n━━━━━━━━━━━━━━━━\n${estadoEmoji} *Estado:* ${s.estado}\n🗓️ *Fecha:* ${fecha}\n⏰ *Hora:* ${s.hora || 'N/A'}\n📍 *Origen:* ${s.origen}\n🏁 *Destino:* ${s.destino}\n👤 *Conductor:* ${s.conductor || 'Por asignar'}\n━━━━━━━━━━━━━━━━\n\n¿Necesitas algo más? Escribe *hola* para ver las opciones. 😊`
                );
            }
            return;
        }

        // Pago
        if (texto.includes('pago') || texto.includes('factura') || texto.includes('saldo') || texto.includes('cobro')) {
            const snap = await db.collection('services')
                .where('telefonoCliente', 'in', [telefono, '57' + telefono])
                .orderBy('fecha', 'desc').limit(1).get();
            if (snap.empty) {
                await enviar(jid, telefono, `No encontré servicios con este número.\n\nPara más información llámanos al 📞 *314 2889955*.`);
            } else {
                const s = snap.docs[0].data();
                const saldo = Number(s.saldo) || 0;
                const pagoEmoji = s.estadoPago === 'Pagado' ? '✅' : '⚠️';
                await enviar(jid, telefono,
                    `${pagoEmoji} *Estado de pago:* ${s.estadoPago || 'Pendiente'}\n💵 *Saldo pendiente:* $${saldo.toLocaleString('es-CO')}\n\nRealiza tu pago a:\n🏦 Cuenta Ahorros *99642554661* Bancolombia\n\n¡Gracias por tu preferencia! 🙏`
                );
            }
            return;
        }

        // Contacto
        if (texto.includes('contacto') || texto.includes('telefono') || texto.includes('teléfono')) {
            await enviar(jid, telefono,
                `📞 *Transportes Especiales J&J*\n\nCelular: *+57 314 2889955*\nCorreo: transportes.especialesjyj@gmail.com\nDirección: Carrera 58 #130A-82\n\n¡Con gusto te atendemos! 😊`
            );
            return;
        }

        // Despedidas y confirmaciones — Nova no responde
        const esDespedida = texto.includes('gracias') || texto.includes('ok') ||
            texto === 'listo' || texto === 'perfecto' || texto === 'entendido' ||
            texto === 'jajaja' || texto === 'jaja' || texto.includes('claro') ||
            texto === 'genial' || texto === 'excelente' || texto === 'bien' ||
            texto === '👍' || texto === '😊' || texto === '🙏';
        if (esDespedida) return;

        // Mensaje no reconocido
        await enviar(jid, telefono,
            `¡Hola! 😊 Soy *Nova* de *Transportes Especiales J&J*.\n\nEscríbeme *hola* para cotizar un servicio o consultar:\n📋 *estado* — Ver tu último servicio\n💰 *pago* — Estado de pago\n📞 *contacto* — Información de contacto`
        );
        return;
    }

    // ── Con sesión activa — flujo de cotización ───────────────────────────────
    const paso = sesion.paso;

    // Cancelar en cualquier momento
    if (texto === 'cancelar' || texto === 'salir' || texto === 'cancel') {
        await eliminarSesion(jid);
        await enviar(jid, telefono, `Tu solicitud ha sido cancelada. 😊\n\nEscríbeme *hola* cuando quieras retomar. ¡Estamos aquí para servirte!`);
        return;
    }

    // Paso 1: Esperando tipo de vehículo
    if (paso === 'esperando_vehiculo') {
        const opcion = texto.replace(/[^1-4]/g, '').trim();

        // Opción 4 — Hablar con asesor
        if (opcion === '4' || texto.includes('asesor') || texto.includes('agente') || texto.includes('humano') || texto.includes('persona')) {
            await eliminarSesion(jid);

            // Registrar solicitud de asesor en Firestore
            try {
                await db.collection('solicitudes_asesor').add({
                    jid,
                    telefono,
                    nombreCliente,
                    motivo: 'Solicitud manual desde menú',
                    estado: 'pendiente',
                    fecha: admin.firestore.FieldValue.serverTimestamp()
                });
                // Activar modo agente inmediatamente
                await db.collection('modo_agente').doc(jid).set({
                    activo: true,
                    activadoPor: 'solicitud_cliente',
                    fecha: new Date().toISOString()
                });
            } catch(e) { console.error('[Nova] Error registrando solicitud:', e.message); }

            await enviar(jid, telefono,
                `¡Con mucho gusto! 😊\n\nHemos notificado a uno de nuestros asesores. En los próximos minutos alguien de nuestro equipo de *Transportes Especiales J&J* te contactará aquí mismo para brindarte atención personalizada. ⏱️\n\nEstamos aquí para servirte. 🌟`
            );
            return;
        }

        if (!VEHICULOS[opcion]) {
            await enviar(jid, telefono,
                `Por favor responde con el número de tu opción:\n\n1️⃣ Sedán / SUV — hasta 4 pasajeros\n2️⃣ Van — de 10 a 15 pasajeros\n3️⃣ Bus — de 16 a 40 pasajeros\n4️⃣ Hablar con un asesor`
            );
            return;
        }

        const vehiculoElegido = VEHICULOS[opcion];
        const emoji = EMOJI_VEHICULO[opcion];

        await enviar(jid, telefono, `${emoji} *${vehiculoElegido}*\n\nExcelente elección. 😊\n\n${BENEFICIOS}`);
        await new Promise(r => setTimeout(r, 1500));
        await enviar(jid, telefono, `Perfecto 😊 Ahora necesito los detalles de tu servicio.\n\n📍 ¿Cuál es tu *lugar de recogida*?\n_(Escribe la dirección completa)_`);
        await guardarSesion(jid, { paso: 'esperando_recogida', tipoVehiculo: vehiculoElegido });
        return;
    }

    // Paso 2: Esperando lugar de recogida
    if (paso === 'esperando_recogida') {
        if (textoRaw.length < 5) {
            await enviar(jid, telefono, `Por favor escribe la dirección completa de recogida. 📍`);
            return;
        }
        await guardarSesion(jid, { paso: 'esperando_hora', lugarRecogida: textoRaw });
        await enviar(jid, telefono, `Anotado ✅\n\n⏰ ¿A qué *hora* necesitas el servicio?\n_(Ejemplo: 8:00 AM, 2:30 PM)_`);
        return;
    }

    // Paso 3: Esperando hora
    if (paso === 'esperando_hora') {
        if (textoRaw.length < 3) {
            await enviar(jid, telefono, `Por favor indica la hora del servicio. ⏰\n_(Ejemplo: 8:00 AM, 2:30 PM)_`);
            return;
        }
        await guardarSesion(jid, { paso: 'esperando_fecha', horaRecogida: textoRaw });
        await enviar(jid, telefono, `Perfecto ✅\n\n🗓️ ¿Para qué *fecha* es el servicio?\n_(Ejemplo: 25 de marzo, mañana, el viernes)_`);
        return;
    }

    // Paso 4: Esperando fecha
    if (paso === 'esperando_fecha') {
        if (textoRaw.length < 3) {
            await enviar(jid, telefono, `Por favor indica la fecha del servicio. 🗓️\n_(Ejemplo: 25 de marzo, mañana, el viernes)_`);
            return;
        }
        await guardarSesion(jid, { paso: 'esperando_destino', fechaServicio: textoRaw });
        await enviar(jid, telefono, `Anotado ✅\n\n🏁 ¿Cuál es tu *destino*?\n_(Escribe la dirección o ciudad de destino)_`);
        return;
    }

    // Paso 5: Esperando destino
    if (paso === 'esperando_destino') {
        if (textoRaw.length < 3) {
            await enviar(jid, telefono, `Por favor indica el destino del servicio. 🏁`);
            return;
        }
        await guardarSesion(jid, { paso: 'esperando_confirmacion', destino: textoRaw });
        const sesionActualizada = await obtenerSesion(jid);
        const emojiV = Object.keys(VEHICULOS).find(k => VEHICULOS[k] === sesionActualizada.tipoVehiculo);

        await enviar(jid, telefono,
            `¡Perfecto! Permíteme confirmar los datos de tu solicitud:\n\n━━━━━━━━━━━━━━━━\n${EMOJI_VEHICULO[emojiV] || '🚐'} *Vehículo:* ${sesionActualizada.tipoVehiculo}\n📍 *Recogida:* ${sesionActualizada.lugarRecogida}\n⏰ *Hora:* ${sesionActualizada.horaRecogida}\n🗓️ *Fecha:* ${sesionActualizada.fechaServicio}\n🏁 *Destino:* ${textoRaw}\n━━━━━━━━━━━━━━━━\n\n¿Es correcta esta información?\n\n✅ Escribe *SI* para confirmar\n✏️ Escribe *NO* para corregir`
        );
        return;
    }

    // Paso 6: Esperando confirmación
    if (paso === 'esperando_confirmacion') {
        if (texto.includes('si') || texto === 's' || texto.includes('sí') || texto.includes('confirmo') || texto.includes('correcto')) {
            try {
                await db.collection('cotizaciones').add({
                    telefono: sesion.telefono,
                    nombreCliente: sesion.nombreCliente,
                    jid,
                    tipoVehiculo: sesion.tipoVehiculo,
                    lugarRecogida: sesion.lugarRecogida,
                    horaRecogida: sesion.horaRecogida,
                    fechaServicio: sesion.fechaServicio,
                    destino: sesion.destino,
                    estado: 'pendiente',
                    fecha: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`[Nova] ✅ Cotización guardada para ${sesion.telefono}`);
            } catch(e) {
                console.error('[Nova] Error guardando cotización:', e.message);
            }

            await eliminarSesion(jid);
            await enviar(jid, telefono,
                `¡Muchas gracias por tu solicitud! 🙌\n\nTus datos han sido enviados a nuestro equipo de operaciones. Un asesor de *Transportes Especiales J&J* te responderá en este mismo chat en los próximos minutos. ⏱️\n\nEstamos aquí para servirte. 😊`
            );
            return;
        }

        if (texto.includes('no') || texto.includes('corregir') || texto.includes('cambiar')) {
            await eliminarSesion(jid);
            await enviar(jid, telefono,
                `Sin problema 😊 Vamos a empezar de nuevo.\n\n¿Qué tipo de vehículo necesitas?\n\n1️⃣ Sedán / SUV — hasta 4 pasajeros\n2️⃣ Van — de 10 a 15 pasajeros\n3️⃣ Bus — de 16 a 40 pasajeros`
            );
            await guardarSesion(jid, {
                paso: 'esperando_vehiculo', telefono, nombreCliente: sesion.nombreCliente,
                tipoVehiculo: null, lugarRecogida: null,
                horaRecogida: null, fechaServicio: null, destino: null
            });
            return;
        }

        await enviar(jid, telefono, `Por favor responde *SI* para confirmar o *NO* para corregir los datos. 😊`);
        return;
    }
}

// ── Aplicar pago a un servicio ────────────────────────────────────────────────
async function aplicarPago(jid, telefono, servicio, pago) {
    const saldoActual = Number(servicio.saldo) || 0;
    const anticipoActual = Number(servicio.anticipo) || 0;
    const valorServicio = Number(servicio.valorServicio) || 0;
    const valorPago = Number(pago.valor) || 0;

    const nuevoAnticipo = anticipoActual + valorPago;
    const nuevoSaldo = Math.max(0, valorServicio - nuevoAnticipo);
    const estadoPago = nuevoSaldo <= 0 ? 'Pagado' : (nuevoAnticipo > 0 ? 'Anticipo' : 'Pendiente');

    try {
        // Actualizar servicio en Firestore
        await db.collection('services').doc(servicio.id).update({
            anticipo: nuevoAnticipo,
            saldo: nuevoSaldo,
            estadoPago,
            ultimoPago: {
                valor: valorPago,
                numeroTransaccion: pago.numeroTransaccion || 'N/A',
                bancoOrigen: pago.bancoOrigen || 'N/A',
                bancoDestino: pago.bancoDestino || 'N/A',
                fecha: pago.fecha || new Date().toLocaleDateString('es-CO'),
                aplicadoEn: admin.firestore.FieldValue.serverTimestamp()
            }
        });

        // Guardar en colección de pagos para auditoría
        await db.collection('pagos_aplicados').add({
            servicioId: servicio.id,
            consecutivo: servicio.consecutivo,
            clienteNombre: servicio.clienteNombre || servicio.cliente,
            telefonoCliente: servicio.telefonoCliente,
            valorPago,
            numeroTransaccion: pago.numeroTransaccion || 'N/A',
            bancoOrigen: pago.bancoOrigen || 'N/A',
            bancoDestino: pago.bancoDestino || 'N/A',
            saldoAnterior: saldoActual,
            saldoNuevo: nuevoSaldo,
            estadoPago,
            fecha: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`[Nova] ✅ Pago aplicado: $${valorPago} al servicio ${servicio.consecutivo}`);

        // Responder al cliente/admin
        const telefonoCliente = servicio.telefonoCliente;
        const jidCliente = formatPhone(telefonoCliente);

        if (estadoPago === 'Pagado') {
            const msg = `✅ *¡Pago confirmado!*\n\nHola *${servicio.clienteNombre || servicio.cliente}*, hemos registrado tu pago:\n\n━━━━━━━━━━━━━━━━\n💵 *Valor:* $${valorPago.toLocaleString('es-CO')}\n🔢 *Transacción:* ${pago.numeroTransaccion || 'N/A'}\n🏦 *Banco:* ${pago.bancoOrigen || 'N/A'}\n📋 *Servicio:* ${servicio.consecutivo}\n✅ *Estado:* PAGADO\n━━━━━━━━━━━━━━━━\n\n¡Muchas gracias por tu pago! En breve recibirás tu cuenta de cobro por correo. 🙏`;
            if (jidCliente) await sock.sendMessage(jidCliente, { text: msg });
            if (jidCliente !== jid) await enviar(jid, telefono, `✅ Pago de $${valorPago.toLocaleString('es-CO')} aplicado al servicio ${servicio.consecutivo}. Estado: PAGADO.`);

            // Notificar al panel para enviar correo
            await db.collection('pagos_pendientes_correo').add({
                servicioId: servicio.id,
                emailCliente: servicio.emailCliente,
                consecutivo: servicio.consecutivo,
                pendiente: true,
                fecha: admin.firestore.FieldValue.serverTimestamp()
            });
        } else {
            const msg = `✅ *Anticipo registrado*\n\nHola *${servicio.clienteNombre || servicio.cliente}*, registramos tu pago:\n\n━━━━━━━━━━━━━━━━\n💵 *Valor recibido:* $${valorPago.toLocaleString('es-CO')}\n🔢 *Transacción:* ${pago.numeroTransaccion || 'N/A'}\n📋 *Servicio:* ${servicio.consecutivo}\n⚠️ *Saldo pendiente:* $${nuevoSaldo.toLocaleString('es-CO')}\n━━━━━━━━━━━━━━━━\n\n¡Gracias! Cuando realices el pago del saldo envíanos el comprobante. 😊`;
            if (jidCliente) await sock.sendMessage(jidCliente, { text: msg });
            if (jidCliente !== jid) await enviar(jid, telefono, `✅ Anticipo de $${valorPago.toLocaleString('es-CO')} aplicado. Saldo pendiente: $${nuevoSaldo.toLocaleString('es-CO')}.`);
        }
    } catch(e) {
        console.error('[Nova] Error aplicando pago:', e.message);
        await enviar(jid, telefono, `Error al aplicar el pago. Por favor verifica manualmente.`);
    }
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

    // ── Listener de mensajes entrantes ──────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;

        const jid = msg.key.remoteJid;
        if (!jid || jid.includes('@g.us')) return;

        // Si el asesor responde directamente desde WhatsApp → activar modo agente
        if (msg.key.fromMe) {
            try {
                await db.collection('modo_agente').doc(jid).set({
                    activo: true,
                    activadoPor: 'respuesta_directa_whatsapp',
                    fecha: new Date().toISOString()
                });
                console.log(`[Nova] 🧑 Modo agente activado por respuesta directa a ${jid}`);
            } catch(e) { console.error('[Nova] Error activando modo agente:', e.message); }
            return;
        }

        const textoRaw = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text || ''
        ).trim();

        const telefonoConCodigo = jid.replace('@s.whatsapp.net', '');
        const telefono = telefonoConCodigo.replace(/^57/, '');

        // ── Detectar si es imagen/comprobante de pago ────────────────────────
        const esImagen = msg.message.imageMessage || msg.message.documentMessage;
        const ADMIN_PHONE = '3058532676';
        const esAdmin = telefono === ADMIN_PHONE || telefonoConCodigo === `57${ADMIN_PHONE}`;

        if (esImagen) {
            console.log(`[Nova] 🖼️ Imagen recibida de ${telefono}`);
            await guardarMensaje(jid, telefono, '📎 Imagen recibida', 'entrante', telefono);

            try {
                // Descargar imagen usando la función de Baileys
                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    { },
                    { logger: pino({ level: 'silent' }) }
                );
                
                const base64Image = buffer.toString('base64');
                const mimeType = msg.message.imageMessage?.mimetype || 'image/jpeg';

                // Analizar con Gemini Vision
                const geminiRes = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{
                                parts: [
                                    { text: `Analiza este comprobante de pago bancario colombiano y extrae en formato JSON exacto:
{
  "esComprobante": true/false,
  "valor": número sin puntos ni comas (ej: 150000),
  "numeroTransaccion": "string o null",
  "bancoOrigen": "string o null",
  "bancoDestino": "string o null",
  "fecha": "string o null",
  "descripcion": "string breve"
}
Si no es un comprobante de pago, retorna esComprobante: false.` },
                                    { inlineData: { mimeType, data: base64Image } }
                                ]
                            }],
                            generationConfig: { temperature: 0 },
                            safetySettings: [
                                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
                                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }
                            ]
                        })
                    }
                );

                const geminiData = await geminiRes.json();
                
                // NUEVO: Imprimir toda la respuesta de Google para diagnóstico
                console.log('[Nova] 🔍 RAW Gemini:', JSON.stringify(geminiData, null, 2));

                if (geminiData.error) {
                    console.error('[Nova] ❌ Error directo desde Google Gemini:', geminiData.error);
                    throw new Error(`Google rechazó la petición: ${geminiData.error.message}`);
                }

                const textoGemini = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
                console.log('[Nova] Gemini respuesta parseada:', textoGemini);

                // Parsear JSON de Gemini
                const jsonMatch = textoGemini.match(/\{[\s\S]*\}/);
                if (!jsonMatch) throw new Error('No se pudo parsear respuesta de Gemini (está vacía o no tiene formato JSON)');
                const pago = JSON.parse(jsonMatch[0]);

                if (!pago.esComprobante) {
                    await enviar(jid, telefono, `No pude identificar un comprobante de pago en esta imagen. 😊\n\nSi es un comprobante, asegúrate de que la imagen sea clara y muestre el valor y número de transacción.`);
                    return;
                }

                console.log(`[Nova] 💰 Comprobante detectado: $${pago.valor} - Transacción: ${pago.numeroTransaccion}`);

                if (esAdmin) {
                    // Admin enviando comprobante — preguntar a qué cliente aplicar
                    await db.collection('sesiones_nova').doc(jid).set({
                        paso: 'admin_esperando_cliente_pago',
                        pagoData: pago,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    await enviar(jid, telefono,
                        `✅ Comprobante detectado:\n💵 Valor: $${pago.valor?.toLocaleString('es-CO')}\n🏦 Banco: ${pago.bancoOrigen || 'N/A'} → ${pago.bancoDestino || 'N/A'}\n🔢 Transacción: ${pago.numeroTransaccion || 'N/A'}\n\n¿A qué cliente o servicio aplicamos este pago?\nEscribe el nombre, NIT o consecutivo (ej: JJ-1018)`
                    );
                } else {
                    // Cliente enviando comprobante — buscar su servicio automáticamente
                    const serviciosSnap = await db.collection('services')
                        .where('telefonoCliente', 'in', [telefono, telefonoConCodigo])
                        .where('estadoPago', 'in', ['Pendiente', 'Anticipo'])
                        .orderBy('fecha', 'desc').limit(5).get();

                    if (serviciosSnap.empty) {
                        await enviar(jid, telefono, `Recibimos tu comprobante de $${pago.valor?.toLocaleString('es-CO')} 😊\n\nNo encontré servicios pendientes de pago asociados a tu número. Un asesor revisará y te confirmará. ⏱️`);
                        return;
                    }

                    // Buscar servicio que coincida con el valor
                    let servicioMatch = null;
                    for (const doc of serviciosSnap.docs) {
                        const s = doc.data();
                        const saldo = Number(s.saldo) || 0;
                        const valorServicio = Number(s.valorServicio) || 0;
                        if (Math.abs(saldo - pago.valor) < saldo * 0.05 || Math.abs(valorServicio - pago.valor) < valorServicio * 0.05) {
                            servicioMatch = { id: doc.id, ...s };
                            break;
                        }
                    }

                    if (!servicioMatch) {
                        // No coincide exactamente — guardar como anticipo al primer servicio
                        servicioMatch = { id: serviciosSnap.docs[0].id, ...serviciosSnap.docs[0].data() };
                    }

                    await aplicarPago(jid, telefono, servicioMatch, pago);
                }
            } catch(e) {
                console.error('[Nova] Error procesando comprobante:', e.message);
                await enviar(jid, telefono, `Recibimos tu imagen 📎\n\nNo pude procesar el comprobante automáticamente. Un asesor lo revisará y confirmará tu pago. ⏱️`);
            }
            return;
        }

        // ── Admin respondiendo a qué cliente aplicar el pago ────────────────
        const sesionAdmin = await obtenerSesion(jid).catch(() => null);
        if (esAdmin && sesionAdmin?.paso === 'admin_esperando_cliente_pago') {
            const busqueda = textoRaw.toLowerCase().trim();
            try {
                // Buscar por consecutivo, nombre o NIT
                const snaps = await Promise.all([
                    db.collection('services').where('consecutivo', '==', textoRaw.toUpperCase()).limit(1).get(),
                    db.collection('services').where('clienteNombre', '>=', busqueda).where('clienteNombre', '<=', busqueda + '\uf8ff').limit(1).get(),
                    db.collection('services').where('nitCliente', '==', textoRaw).limit(1).get()
                ]);

                let servicioEncontrado = null;
                for (const snap of snaps) {
                    if (!snap.empty) { servicioEncontrado = { id: snap.docs[0].id, ...snap.docs[0].data() }; break; }
                }

                if (!servicioEncontrado) {
                    await enviar(jid, telefono, `No encontré ningún servicio con "${textoRaw}". Intenta con el consecutivo (ej: JJ-1018), nombre completo o NIT del cliente.`);
                    return;
                }

                await aplicarPago(jid, telefono, servicioEncontrado, sesionAdmin.pagoData);
                await eliminarSesion(jid);
            } catch(e) {
                console.error('[Nova] Error buscando servicio admin:', e.message);
                await enviar(jid, telefono, `Error buscando el servicio. Intenta de nuevo.`);
            }
            return;
        }

        console.log(`[Nova] 📩 Mensaje de ${telefono}: ${textoRaw}`);
        await guardarMensaje(jid, telefono, textoRaw, 'entrante', telefono);

        if (!textoRaw) return;

        // Buscar nombre del cliente
        let nombreCliente = 'Cliente';
        try {
            const snap = await db.collection('services')
                .where('telefonoCliente', 'in', [telefono, telefonoConCodigo])
                .orderBy('fecha', 'desc').limit(1).get();
            if (!snap.empty) {
                const s = snap.docs[0].data();
                nombreCliente = s.clienteNombre || s.cliente || 'Cliente';
            }
        } catch(e) {}

        if (nombreCliente === 'Cliente') {
            try {
                const snap = await db.collection('cotizaciones')
                    .where('telefono', '==', telefono)
                    .orderBy('fecha', 'desc').limit(1).get();
                if (!snap.empty) nombreCliente = snap.docs[0].data().nombreCliente || 'Cliente';
            } catch(e) {}
        }

        // Verificar si hay un agente humano atendiendo (modo agente 72 horas)
        try {
            const agenteSnap = await db.collection('modo_agente').doc(jid).get();
            if (agenteSnap.exists) {
                const data = agenteSnap.data();
                const horasTranscurridas = (Date.now() - new Date(data.fecha).getTime()) / 3600000;
                if (horasTranscurridas < 72) {
                    console.log(`[Nova] 🧑 Agente humano activo para ${telefono} — Nova en pausa (${horasTranscurridas.toFixed(1)}h)`);
                    return;
                } else {
                    await db.collection('modo_agente').doc(jid).delete();
                    console.log(`[Nova] ⏱️ Modo agente expirado para ${telefono} — Nova retoma`);
                }
            }
        } catch(e) { console.error('[Nova] Error verificando modo agente:', e.message); }

        // Obtener sesión activa
        let sesion = null;
        try { sesion = await obtenerSesion(jid); } catch(e) {}

        // Procesar flujo
        try {
            await procesarFlujo(jid, telefono, textoRaw, nombreCliente, sesion);
        } catch(e) {
            console.error('[Nova] Error en flujo:', e.message);
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

app.post('/send-file', authMiddleware, async (req, res) => {
    const { jid, fileBase64, mimeType, fileName, caption } = req.body;
    if (!isReady) return res.status(503).json({ error: 'Nova no está conectada' });
    if (!jid || !fileBase64 || !mimeType) return res.status(400).json({ error: 'Faltan datos' });
    try {
        const buffer = Buffer.from(fileBase64, 'base64');
        let message;

        if (mimeType.startsWith('image/')) {
            message = { image: buffer, caption: caption || '', mimetype: mimeType };
        } else {
            message = { document: buffer, mimetype: mimeType, fileName: fileName || 'archivo', caption: caption || '' };
        }

        await sock.sendMessage(jid, message);
        console.log('[Nova] ✅ Archivo enviado a:', jid);

        await db.collection('conversaciones').add({
            jid,
            telefono: jid.replace('@s.whatsapp.net', '').replace(/^57/, ''),
            nombre: 'Admin J&J',
            mensaje: `📎 ${fileName || 'Archivo adjunto'}`,
            tipo: 'saliente',
            leido: true,
            fecha: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true });
    } catch(error) {
        console.error('[Nova] Error enviando archivo:', error.message);
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
        console.log('[Nova] ✅ Notificación de servicio enviada a:', jid);

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
        try {
            await db.collection('notificaciones_whatsapp').add({
                clienteNombre: data.clienteNombre,
                clienteTelefono: data.clienteTelefono,
                tipo: 'servicio_programado',
                mensaje: '', estado: 'error', error: error.message,
                fecha: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch(e) {}
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

        await db.collection('notificaciones_whatsapp').add({
            clienteNombre: data.clienteNombre,
            clienteTelefono: data.clienteTelefono,
            tipo: 'notificacion_salida',
            mensaje: text, estado: 'enviado',
            fecha: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true });
    } catch (error) {
        console.error('[Nova] Error:', error.message);
        try {
            await db.collection('notificaciones_whatsapp').add({
                clienteNombre: data.clienteNombre,
                clienteTelefono: data.clienteTelefono,
                tipo: 'notificacion_salida',
                mensaje: '', estado: 'error', error: error.message,
                fecha: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch(e) {}
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

            if (s.fecha && s.hora) {
                try {
                    const fechaStr = `${s.fecha.substring(0, 10)}T${s.hora}:00-05:00`;
                    horaRecogida = new Date(fechaStr);
                } catch(e) { console.error('[Cron] Error fecha:', e.message); continue; }
            } else {
                console.log(`[Cron] Sin fecha/hora para: ${docSnap.id}`);
                continue;
            }

            const diffMin = (now - horaRecogida) / 60000;
            console.log(`[Cron] ${docSnap.id}: diff=${diffMin.toFixed(2)}min`);

            if (diffMin >= 0 && diffMin <= 2) {
                const phone = formatPhone(s.telefonoCliente || s.contactNumber);
                if (!phone) { console.error('[Cron] Sin teléfono para', docSnap.id); continue; }

                try {
                    // 1. Cambiar estado a "En Servicio" automáticamente
                    await docSnap.ref.update({
                        estado: 'En Servicio',
                        notificacionSalidaEnviada: true,
                        iniciadoAutomaticamente: true,
                        horaInicioReal: admin.firestore.FieldValue.serverTimestamp()
                    });
                    console.log(`[Cron] ✅ Servicio ${docSnap.id} cambiado a En Servicio`);

                    // 2. Enviar notificación de salida al cliente
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

                    // 3. Enviar link GPS al conductor automáticamente
                    if (s.conductorTelefono) {
                        const conductorJid = formatPhone(s.conductorTelefono);
                        if (conductorJid) {
                            const gpsLink = `https://studio--jj-connect--18988325-5ab9e.us-central1.hosted.app/gps/${docSnap.id}`;
                            const msgConductor = `🚐 *Servicio ${s.consecutivo || docSnap.id} INICIADO*\n\nHola *${s.conductor}*, es la hora de tu servicio.\n\n📍 *Destino:* ${s.destino}\n👤 *Cliente:* ${s.clienteNombre || s.cliente}\n📞 *Contacto cliente:* ${s.telefonoCliente}\n\n━━━━━━━━━━━━━━━━\n⚠️ *IMPORTANTE:* Abre este link para activar el GPS y NO lo cierres durante el trayecto:\n\n🔗 ${gpsLink}\n━━━━━━━━━━━━━━━━\n\n¡Buen viaje! 🌟`;
                            await sock.sendMessage(conductorJid, { text: msgConductor });
                            console.log(`[Cron] ✅ Link GPS enviado al conductor ${s.conductor}`);
                        }
                    }

                } catch(e) { console.error(`[Cron] Error:`, e.message); }
            }
        }
    } catch (error) { console.error('[Cron] Error:', error.message); }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`[Nova] Servidor activo en puerto ${port}`);
    connectToWhatsApp().catch(err => console.error('[Nova] Error:', err));
});
