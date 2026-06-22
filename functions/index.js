// =========================================================
// 🌵 CristóbalBot – Chatbot turístico de WhatsApp
// Municipio de Colón, Querétaro
// Node.js 22 · ESM · Firebase Functions · MySQL
// =========================================================

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import axios from "axios";
import mysql from "mysql2/promise";

// =========================================================
// 🔐 SECRETS
// =========================================================

const VERIFY_TOKEN = defineSecret("VERIFY_TOKEN_COLONBOT");
const WHATSAPP_TOKEN = defineSecret("WHATSAPP_TOKEN_COLONBOT");
const WHATSAPP_PHONE_NUMBER_ID = defineSecret("WHATSAPP_PHONE_NUMBER_ID_COLONBOT");
const DB_HOST = defineSecret("DB_HOST_COLONBOT");
const DB_USER = defineSecret("DB_USER_COLONBOT");
const DB_PASSWORD = defineSecret("DB_PASSWORD_COLONBOT");
const DB_NAME = defineSecret("DB_NAME_COLONBOT");

// =========================================================
// 🗄️ MYSQL POOL (Lazy)
// =========================================================

let pool = null;
function getPool(cfg) {
  if (!pool) {
    pool = mysql.createPool({
      host: cfg.DB_HOST,
      user: cfg.DB_USER,
      password: cfg.DB_PASSWORD,
      database: cfg.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      timezone: "Z",
    });
  }
  return pool;
}

// =========================================================
// 📊 CONSTANTES
// =========================================================

const API_BASE = "https://graph.facebook.com/v20.0";

const CAT_EMOJI = {
  1: "🍽️", 2: "🏨", 3: "🍷", 4: "🏛️", 5: "⭐",
  6: "🌊", 7: "🎨", 8: "🍸", 9: "⛰️",
};

// ── URL base para las rutas en el mapa ────────────────────

const MAP_BASE_URL = "https://colon.click/sistema/mapa";
const IMAGES_BASE_URL = "https://colon.click/sistema/images";

// =========================================================
// 💬 HELPERS WHATSAPP CLOUD API
// =========================================================

async function sendWA(phoneNumberId, token, to, payload) {
  await axios.post(
    `${API_BASE}/${phoneNumberId}/messages`,
    { messaging_product: "whatsapp", to, ...payload },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    }
  );
}

async function markRead(wa, messageId) {
  await axios
    .post(
      `${API_BASE}/${wa.phoneNumberId}/messages`,
      { messaging_product: "whatsapp", status: "read", message_id: messageId },
      {
        headers: {
          Authorization: `Bearer ${wa.token}`,
          "Content-Type": "application/json",
        },
        timeout: 5_000,
      }
    )
    .catch(() => {});
}

async function sendText(wa, to, text) {
  await sendWA(wa.phoneNumberId, wa.token, to, {
    type: "text",
    text: { body: text },
  });
}

async function sendButtons(wa, to, body, buttons) {
  await sendWA(wa.phoneNumberId, wa.token, to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.substring(0, 20) },
        })),
      },
    },
  });
}

async function sendList(wa, to, body, buttonText, sections) {
  await sendWA(wa.phoneNumberId, wa.token, to, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      action: {
        button: buttonText.substring(0, 20),
        sections: sections.map((s) => ({
          title: s.title.substring(0, 24),
          rows: s.rows.map((r) => ({
            id: r.id,
            title: r.title.substring(0, 24),
            ...(r.description
              ? { description: r.description.substring(0, 72) }
              : {}),
          })),
        })),
      },
    },
  });
}

async function sendLocation(wa, to, lat, lng, name, address) {
  await sendWA(wa.phoneNumberId, wa.token, to, {
    type: "location",
    location: {
      latitude: parseFloat(lat),
      longitude: parseFloat(lng),
      name,
      address: address || "Colón, Querétaro",
    },
  });
}

// =========================================================
// 🔍 EXTRAER INPUT DEL MENSAJE
// =========================================================

function extractInput(msg) {
  if (msg.type === "text") return msg.text.body.trim();
  if (msg.type === "interactive") {
    const ir = msg.interactive;
    if (ir.type === "button_reply") return ir.button_reply.id;
    if (ir.type === "list_reply") return ir.list_reply.id;
  }
  return null;
}

// =========================================================
// 🗃️ SESIÓN (tabla chatbot_sessions)
// =========================================================

async function getSession(db, waId) {
  const [rows] = await db.execute(
    "SELECT * FROM chatbot_sessions WHERE wa_id = ?",
    [waId]
  );
  return rows[0] || null;
}

async function upsertSession(db, waId, state, context) {
  const ctxJson = JSON.stringify(context || {});
  const [existing] = await db.execute(
    "SELECT id FROM chatbot_sessions WHERE wa_id = ?",
    [waId]
  );
  if (existing.length) {
    await db.execute(
      "UPDATE chatbot_sessions SET state = ?, last_message = ? WHERE wa_id = ?",
      [state, ctxJson, waId]
    );
  } else {
    await db.execute(
      "INSERT INTO chatbot_sessions (wa_id, state, last_message) VALUES (?, ?, ?)",
      [waId, state, ctxJson]
    );
  }
}

// =========================================================
// 📈 ANALYTICS
// =========================================================

async function trackEvent(db, businessId, event) {
  await db
    .execute(
      "INSERT INTO analytics (business_id, event, ip, user_agent) VALUES (?, ?, ?, ?)",
      [businessId, event, null, "CristóbalBot/WhatsApp"]
    )
    .catch((e) => logger.warn("analytics insert failed", e));
}

// =========================================================
// 🌵 BIENVENIDA – Saludo + selección de ruta
// =========================================================

async function handleWelcome(wa, db, from) {
  // Obtener las rutas (categorías activas) desde la BD
  const [routes] = await db.execute(
    `SELECT id, name, slug FROM categories WHERE active = 1 ORDER BY sort_order ASC`
  );

  if (!routes.length) {
    await sendText(wa, from, "😔 No hay rutas disponibles en este momento.");
    return;
  }

  const body =
    `📲 *¡Hola! Bienvenido a CristóbalBot* 🌵\n\n` +
    `Soy tu guía turística digital del municipio de ` +
    `*Colón, Querétaro*. 🇲🇽\n\n` +
    `🗺️ Tenemos *${routes.length} rutas turísticas*\n` +
    `que puedes explorar.\n\n` +
    `Selecciona la que más te interese 👇\n\n` +
    `_Escribe *ayuda* si necesitas asistencia_`;

  await sendList(wa, from, body, "🧭 Ver Rutas", [
    {
      title: "Rutas turísticas",
      rows: routes.map((r) => ({
        id: `route_${r.id}`,
        title: `${CAT_EMOJI[r.id] || "📍"} ${r.name.replace(/^Ruta\s+de(l|\s+la)?\s+/i, "")}`.substring(0, 24),
      })),
    },
  ]);

  await trackEvent(db, null, "chatbot_session");
  await upsertSession(db, from, "welcome", {});
}

// =========================================================
// 🌵 RUTA SELECCIONADA → Link del mapa + negocios activos
// =========================================================

async function handleRouteSelected(wa, db, from, catId) {
  // Obtener info de la categoría/ruta desde la BD
  const [catRows] = await db.execute(
    `SELECT id, name, slug FROM categories WHERE id = ? AND active = 1`,
    [catId]
  );
  const cat = catRows[0];
  if (!cat) return;

  const emoji = CAT_EMOJI[cat.id] || "📍";
  const mapLink = `${MAP_BASE_URL}/${cat.slug}`;

  // Enviar el enlace del mapa
  await sendText(
    wa,
    from,
    `${emoji} *${cat.name}*\n\n` +
      `🗺️ *Mapa interactivo de la ruta:*\n` +
      `👉 ${mapLink}\n\n` +
      `📋 A continuación te muestro los\n` +
      `lugares disponibles en esta ruta:`
  );

  // Mostrar negocios publicados de la categoría activa
  const [businesses] = await db.execute(
    `SELECT b.id, b.name, b.address, b.rating, b.featured
     FROM businesses b
     WHERE b.category_id = ? AND b.status = 'published'
     ORDER BY b.featured DESC, b.rating DESC`,
    [catId]
  );

  if (!businesses.length) {
    await sendText(
      wa,
      from,
      `😔 Aún no hay lugares registrados en\n` +
        `*${cat.name}*.\n\n` +
        `Escribe *menu* para ver otras rutas.`
    );
    await upsertSession(db, from, "route_selected", { route: catId });
    return;
  }

  const body =
    `${emoji} *${cat.name}*\n\n` +
    `✅ Encontré *${businesses.length}* lugar(es).\n\n` +
    `Selecciona uno para ver su ficha completa 👇`;

  const rows = businesses.slice(0, 10).map((b) => ({
    id: `biz_${b.id}`,
    title: b.name.substring(0, 24),
  }));

  await sendList(wa, from, body, "📋 Ver Lugares", [
    { title: cat.name.substring(0, 24), rows },
  ]);

  await upsertSession(db, from, `route:${catId}`, { route: catId });
}



// =========================================================
// 📋 LISTADO DE NEGOCIOS POR CATEGORÍA
// =========================================================

async function handleBusinessList(wa, db, from, catId, ctx) {
  const [businesses] = await db.execute(
    `SELECT b.id, b.name, b.address, b.rating, b.featured
     FROM businesses b
     JOIN categories c ON b.category_id = c.id
     WHERE b.category_id = ? AND b.status = 'published' AND c.active = 1
     ORDER BY b.featured DESC, b.rating DESC`,
    [catId]
  );

  const [catRow] = await db.execute(
    "SELECT name FROM categories WHERE id = ? AND active = 1",
    [catId]
  );
  const catName = catRow[0]?.name || "Categoría";

  if (!businesses.length) {
    await sendText(
      wa,
      from,
      `😔 Aún no hay lugares registrados en *${catName}*.\n\nEscribe *menu* para volver.`
    );
    return;
  }

  const body =
    `${CAT_EMOJI[catId] || "📌"} *${catName}*\n\n` +
    `Encontré *${businesses.length}* lugar(es).\n` +
    `Selecciona uno para ver su ficha completa 👇`;

  const rows = businesses.slice(0, 10).map((b) => ({
    id: `biz_${b.id}`,
    title: b.name.substring(0, 24),
  }));

  await sendList(wa, from, body, "📋 Ver Lugares", [
    { title: catName.substring(0, 24), rows },
  ]);

  await upsertSession(db, from, `cat:${catId}`, ctx);
}

// =========================================================
// 🏢 FICHA DE NEGOCIO (Microprestador)
// =========================================================

async function handleBusinessFicha(wa, db, from, bizId, ctx) {
  const [rows] = await db.execute(
    `SELECT b.*, c.name AS category_name
     FROM businesses b
     JOIN categories c ON b.category_id = c.id
     WHERE b.id = ?`,
    [bizId]
  );
  const biz = rows[0];
  if (!biz) {
    await sendText(
      wa,
      from,
      "❌ No encontré ese lugar. Escribe *menu* para volver."
    );
    return;
  }

  // Amenidades
  const [amenities] = await db.execute(
    `SELECT a.name FROM amenities a
     JOIN business_amenities ba ON a.id = ba.amenity_id
     WHERE ba.business_id = ?`,
    [bizId]
  );

  // ── 1) Enviar imagen de portada si existe ───────────────
  if (biz.cover_image) {
    const imageUrl = `${IMAGES_BASE_URL}/${biz.cover_image}`;
    try {
      await sendWA(wa.phoneNumberId, wa.token, from, {
        type: "image",
        image: { link: imageUrl },
      });
      await new Promise((r) => setTimeout(r, 1500));
    } catch (imgErr) {
      logger.warn("No se pudo enviar imagen de portada", imgErr?.response?.data || imgErr);
    }
  }

  // ── 2) Construir ficha con descripción e info ──────────
  let card = `${CAT_EMOJI[biz.category_id] || "📌"} *${biz.name}*\n`;
  card += `▸ ${biz.category_name}\n\n`;

  if (biz.description) {
    const short =
      biz.description.length > 300
        ? biz.description.substring(0, 300) + "…"
        : biz.description;
    card += `${short}\n\n`;
  }

  if (biz.address) card += `◦ ${biz.address}\n`;
  if (biz.lat && biz.lng) {
    const lat = parseFloat(biz.lat);
    const lng = parseFloat(biz.lng);
    card += `◦ Maps: https://www.google.com/maps?q=${lat},${lng}\n`;
    card += `◦ Waze: https://waze.com/ul?ll=${lat},${lng}&navigate=yes\n`;
  }

  if (biz.schedule) {
    try {
      const s = JSON.parse(biz.schedule);
      card +=
        `◦ ` +
        Object.entries(s)
          .map(([k, v]) => `${k}: ${v}`)
          .join(" | ") +
        "\n";
    } catch {
      /* schedule no es JSON */
    }
  }

  if (amenities.length) {
    card += `\n*Amenidades:*\n${amenities.map((a) => `  · ${a.name}`).join("\n")}\n\n`;
    card += `Más información en:  ${MAP_BASE_URL}/${biz.id}\n`;
  }

  await sendText(wa, from, card);

  // ── 3) Botones de acción ───────────────────────────────
  const buttons = [
    { id: `fotos_${bizId}`, title: "📸 Ver Imágenes" },
    { id: `reservar_${bizId}`, title: "📩 Reservar" },
    { id: "go_routes", title: "🔙 Volver" },
  ];

  await sendButtons(wa, from, "¿Qué deseas hacer?", buttons);

  await trackEvent(db, bizId, "chatbot_view");
  await upsertSession(db, from, `biz:${bizId}`, ctx);
}

// =========================================================
// ➡️ MÁS OPCIONES DE UN NEGOCIO
// =========================================================

async function handleMoreOptions(wa, db, from, bizId) {
  const [r] = await db.execute(
    "SELECT name FROM businesses WHERE id = ?",
    [bizId]
  );
  const name = r[0]?.name || "Negocio";

  await sendList(
    wa,
    from,
    `➡️ *Más opciones para ${name}*`,
    "📋 Ver Opciones",
    [
      {
        title: "Opciones",
        rows: [
          {
            id: `fotos_${bizId}`,
            title: "📸 Ver Fotos",
            description: "Galería de imágenes",
          },
          {
            id: "go_routes",
            title: "🏠 Menú Principal",
            description: "Volver al inicio",
          },
        ],
      },
    ]
  );
}

// =========================================================
// 📍 UBICACIÓN GPS
// =========================================================

async function handleLocation(wa, db, from, bizId) {
  const [r] = await db.execute(
    "SELECT name, address, lat, lng FROM businesses WHERE id = ?",
    [bizId]
  );
  const b = r[0];
  if (b?.lat && b?.lng) {
    const lat = parseFloat(b.lat);
    const lng = parseFloat(b.lng);
    const googleUrl = `https://www.google.com/maps?q=${lat},${lng}`;
    const wazeUrl = `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;

    await sendText(
      wa,
      from,
      `📍 *Ubicación de ${b.name}*\n\n` +
        `📍 ${b.address || "Colón, Querétaro"}\n\n` +
        `🗺️ *Google Maps:*\n${googleUrl}\n\n` +
        `🟦 *Waze:*\n${wazeUrl}`
    );
    await trackEvent(db, bizId, "directions_click");
  } else {
    await sendText(
      wa,
      from,
      "❌ Este lugar no tiene ubicación GPS registrada."
    );
  }
}

// =========================================================
// 📞 CONTACTO WHATSAPP DEL NEGOCIO
// =========================================================

async function handleWhatsAppLink(wa, db, from, bizId) {
  const [r] = await db.execute(
    "SELECT name, whatsapp FROM businesses WHERE id = ?",
    [bizId]
  );
  const b = r[0];
  if (b?.whatsapp) {
    const preMsg = encodeURIComponent(
      `Hola, vi tu servicio en CristóbalBot y me interesa saber más sobre ${b.name}`
    );
    await sendText(
      wa,
      from,
      `📞 *Contactar a ${b.name}*\n\n` +
        `Abre este enlace para enviarle un mensaje directo:\n` +
        `👉 https://wa.me/${b.whatsapp}?text=${preMsg}`
    );
    await trackEvent(db, bizId, "whatsapp_click");
  } else {
    await sendText(
      wa,
      from,
      "❌ Este negocio no tiene WhatsApp registrado."
    );
  }
}

// =========================================================
// 📸 GALERÍA DE FOTOS
// =========================================================

async function handlePhotos(wa, db, from, bizId) {
  const [br] = await db.execute(
    "SELECT name FROM businesses WHERE id = ?",
    [bizId]
  );
  const biz = br[0];
  if (!biz) return;

  // Obtener fotos extra de la galería (tabla business_images)
  const [images] = await db.execute(
    "SELECT path FROM business_images WHERE business_id = ? ORDER BY id ASC",
    [bizId]
  );

  if (!images.length) {
    await sendText(
      wa,
      from,
      "📸 No hay fotos adicionales para *" + biz.name + "*.\n\nEscribe *hola* para volver a empezar."
    );
    return;
  }

  // Enviar cada foto de la galería
  for (const img of images) {
    const imageUrl = `${IMAGES_BASE_URL}/${img.path}`;
    try {
      await sendWA(wa.phoneNumberId, wa.token, from, {
        type: "image",
        image: { link: imageUrl },
      });
      // Pausa entre imágenes para que WhatsApp las entregue en orden
      await new Promise((r) => setTimeout(r, 1500));
    } catch (imgErr) {
      logger.warn("No se pudo enviar foto de galería", imgErr?.response?.data || imgErr);
    }
  }

  // Botones después de la galería
  await sendButtons(wa, from, "¿Qué deseas hacer?", [
    { id: `reservar_${bizId}`, title: "📩 Reservar" },
    { id: "go_routes", title: "🔙 Regresar" },
  ]);
}



// =========================================================
// 🛠️ AYUDA
// =========================================================

async function handleTools(wa, from) {
  const text =
    `🛠️ *Ayuda — CristóbalBot*\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📌 *Comandos disponibles:*\n` +
    `   • Escribe *hola* para empezar de nuevo\n` +
    `   • Escribe *menu* para ver las rutas\n\n` +
    `🚨 *Emergencias:*\n` +
    `   Llama al *911*\n\n` +
    `📍 *Municipio de Colón, Querétaro*`;
  await sendText(wa, from, text);
}

// =========================================================
// ⭐ RETROALIMENTACIÓN Y CIERRE
// =========================================================

async function handleFeedback(wa, db, from, ctx) {
  await sendButtons(
    wa,
    from,
    `⭐ *¿Te fue útil CristóbalBot?*\n\n` +
      `_Tu opinión nos ayuda a mejorar._`,
    [
      { id: "fb_good", title: "👍 Sí, excelente" },
      { id: "fb_ok", title: "🔄 Regular" },
      { id: "fb_bad", title: "👎 Necesita mejorar" },
    ]
  );
  await upsertSession(db, from, "feedback", ctx);
}

async function handleFeedbackResponse(wa, db, from, input, ctx) {
  if (input === "fb_good") {
    await sendText(
      wa,
      from,
      `🎉 *¡Nos alegra mucho!*\n\n` +
        `Gracias por explorar Colón con CristóbalBot. 💛\n\n` +
        `Escribe *hola* para empezar de nuevo.`
    );
  } else if (input === "fb_ok") {
    await sendText(
      wa,
      from,
      `🔄 *Gracias por tu honestidad.*\n\n` +
        `Escribe *hola* para empezar de nuevo.`
    );
  } else if (input === "fb_bad") {
    await sendText(
      wa,
      from,
      `😔 *Lamentamos eso.*\n\n` +
        `Tomaremos en cuenta tu opinión para mejorar.\n\n` +
        `Escribe *hola* para empezar de nuevo.`
    );
  }
  await trackEvent(db, null, "feedback_" + (input || "").replace("fb_", ""));
  await upsertSession(db, from, "welcome", {});
}

// =========================================================
// 🧠 ROUTER PRINCIPAL – Máquina de estados
// =========================================================

async function handleMessage(wa, db, from, msg, contactName) {
  const input = extractInput(msg);
  if (!input) return;

  const lower = input.toLowerCase();

  // ── Detectar mensaje desde la web: "quiero ver las opciones para X" ──
  const webMatch = lower.match(/quiero ver las opciones para (.+)/i);
  if (webMatch) {
    const searchName = webMatch[1].trim();
    const [bizRows] = await db.execute(
      `SELECT id FROM businesses WHERE LOWER(name) = LOWER(?) AND status = 'published' LIMIT 1`,
      [searchName]
    );
    if (bizRows.length) {
      await handleBusinessFicha(wa, db, from, bizRows[0].id, {});
      return;
    }
    // Búsqueda parcial si no se encontró exacto
    const [fuzzyRows] = await db.execute(
      `SELECT id, name FROM businesses WHERE LOWER(name) LIKE CONCAT('%', LOWER(?), '%') AND status = 'published' LIMIT 5`,
      [searchName]
    );
    if (fuzzyRows.length === 1) {
      await handleBusinessFicha(wa, db, from, fuzzyRows[0].id, {});
      return;
    }
    if (fuzzyRows.length > 1) {
      const rows = fuzzyRows.map((b) => ({
        id: `biz_${b.id}`,
        title: b.name.substring(0, 24),
      }));
      await sendList(wa, from, `🔍 Encontré *${fuzzyRows.length}* lugares que coinciden con *"${searchName}"*.\n\nSelecciona uno:`, "📋 Ver Lugares", [
        { title: "Resultados", rows },
      ]);
      await upsertSession(db, from, "welcome", {});
      return;
    }
    // No encontrado → bienvenida
    await sendText(wa, from, `😔 No encontré un lugar llamado *"${searchName}"*.\n\nEscribe *menu* para ver las rutas disponibles.`);
    await upsertSession(db, from, "welcome", {});
    return;
  }

  // ── Comandos globales ──────────────────────────────────
  if (["ayuda", "help", "emergencia", "sos"].includes(lower)) {
    await handleTools(wa, from);
    return;
  }

  // ── Sesión ─────────────────────────────────────────────
  const session = await getSession(db, from);
  const state = session?.state || null;
  let ctx = {};
  try {
    ctx = session?.last_message ? JSON.parse(session.last_message) : {};
  } catch {
    ctx = {};
  }

  // ── "menu" / "inicio" → volver a las rutas ──────────────
  if (["menu", "inicio", "volver"].includes(lower) || input === "go_routes" || input === "go_pmenu") {
    await handleWelcome(wa, db, from);
    return;
  }

  // ── "hola" → bienvenida ────────────────────────────────
  if (
    [
      "hola",
      "hi",
      "hello",
      "buenas",
      "buenos dias",
      "buenas tardes",
      "buenas noches",
    ].includes(lower)
  ) {
    await handleWelcome(wa, db, from);
    return;
  }

  // ── "gracias" / "adios" → retroalimentación ────────────
  if (["gracias", "adios", "adiós", "bye", "chao"].includes(lower)) {
    await handleFeedback(wa, db, from, ctx);
    return;
  }

  // ── Selección de ruta desde cualquier estado ───────────
  if (input.startsWith("route_")) {
    const catId = parseInt(input.replace("route_", ""), 10);
    if (catId) {
      await handleRouteSelected(wa, db, from, catId);
      return;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Routing por ESTADO
  // ═══════════════════════════════════════════════════════

  // ── WELCOME (seleccionar ruta) ─────────────────────────
  if (state === "welcome" || !session) {
    await handleWelcome(wa, db, from);
    return;
  }

  // ── ROUTE SELECTED / CAT LIST (seleccionar negocio) ────
  if (state.startsWith("route:") || state === "route_selected" || state.startsWith("cat:")) {
    if (input.startsWith("biz_")) {
      const bizId = parseInt(input.replace("biz_", ""), 10);
      if (bizId) {
        await handleBusinessFicha(wa, db, from, bizId, ctx);
        return;
      }
    }
    await handleWelcome(wa, db, from);
    return;
  }

  // ── BUSINESS (acciones sobre un negocio) ───────────────
  if (state.startsWith("biz:")) {
    const bizId = parseInt(state.split(":")[1], 10);

    if (input.startsWith("loc_")) {
      await handleLocation(
        wa,
        db,
        from,
        parseInt(input.replace("loc_", ""), 10)
      );
      return;
    }
    if (input.startsWith("wa_")) {
      await handleWhatsAppLink(
        wa,
        db,
        from,
        parseInt(input.replace("wa_", ""), 10)
      );
      return;
    }
    if (input.startsWith("more_")) {
      await handleMoreOptions(
        wa,
        db,
        from,
        parseInt(input.replace("more_", ""), 10)
      );
      return;
    }
    if (input.startsWith("fotos_")) {
      await handlePhotos(
        wa,
        db,
        from,
        parseInt(input.replace("fotos_", ""), 10)
      );
      return;
    }
    if (input.startsWith("reservar_")) {
      await handleWhatsAppLink(
        wa,
        db,
        from,
        parseInt(input.replace("reservar_", ""), 10)
      );
      return;
    }

    if (input.startsWith("biz_")) {
      await handleBusinessFicha(
        wa,
        db,
        from,
        parseInt(input.replace("biz_", ""), 10),
        ctx
      );
      return;
    }
    if (input === "go_routes") {
      await handleWelcome(wa, db, from);
      return;
    }
    await handleBusinessFicha(wa, db, from, bizId, ctx);
    return;
  }



  // ── FEEDBACK ───────────────────────────────────────────
  if (state === "feedback") {
    await handleFeedbackResponse(wa, db, from, input, ctx);
    return;
  }

  // ── FALLBACK ───────────────────────────────────────────
  await handleWelcome(wa, db, from);
}

// =========================================================
// 🚀 WEBHOOK PRINCIPAL – Firebase Function
// =========================================================

export const whatsappWebhookColonBot = onRequest(
  {
    cors: true,
    region: "us-central1",
    secrets: [
      VERIFY_TOKEN,
      WHATSAPP_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID,
      DB_HOST,
      DB_USER,
      DB_PASSWORD,
      DB_NAME,
    ],
  },
  async (req, res) => {
    const cfg = {
      VERIFY_TOKEN: VERIFY_TOKEN.value(),
      WHATSAPP_TOKEN: WHATSAPP_TOKEN.value(),
      WHATSAPP_PHONE_NUMBER_ID: WHATSAPP_PHONE_NUMBER_ID.value(),
      DB_HOST: DB_HOST.value(),
      DB_USER: DB_USER.value(),
      DB_PASSWORD: DB_PASSWORD.value(),
      DB_NAME: DB_NAME.value(),
    };

    // ── GET: Verificación de Meta ────────────────────────
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      return mode === "subscribe" && token === cfg.VERIFY_TOKEN
        ? res.status(200).send(challenge)
        : res.sendStatus(403);
    }

    // ── POST: Mensajes entrantes ─────────────────────────
    try {
      const body = req.body;
      logger.info("Webhook body", body);

      const statuses = body?.entry?.[0]?.changes?.[0]?.value?.statuses;
      if (Array.isArray(statuses) && statuses.length) {
        return res.sendStatus(200);
      }

      const messages = body?.entry?.[0]?.changes?.[0]?.value?.messages;
      const from = messages?.[0]?.from;
      if (!messages || !from) return res.sendStatus(200);

      const msg = messages[0];
      if (!msg || !["text", "interactive"].includes(msg.type)) {
        return res.sendStatus(200);
      }

      const contactName =
        body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name;

      const db = getPool(cfg);
      const wa = {
        token: cfg.WHATSAPP_TOKEN,
        phoneNumberId: cfg.WHATSAPP_PHONE_NUMBER_ID,
      };

      await markRead(wa, msg.id);
      await handleMessage(wa, db, from, msg, contactName);

      return res.sendStatus(200);
    } catch (err) {
      logger.error("Error webhook:", err?.response?.data || err);
      return res.sendStatus(200);
    }
  }
);
