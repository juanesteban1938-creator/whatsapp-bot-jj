/**
 * J&J Connect - WhatsApp Bot Engine (Nova)
 * Versión: 7.0.9 (Lista de Cartera para Admin + Fix de LID)
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
            if (jidCliente !== jid) await enviar(jid, telefono, `✅ Pago de $${valor
