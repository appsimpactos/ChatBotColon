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

const PROFILE_NAMES = {
  viajero: "🇪🇸 Viajero Europa / Negocios",
  aventura: "🏔️ Aventura",
  religioso: "🙏 Turismo Religioso",
  vino: "🍷 Turismo de Vino",
};

// ── Mensajes de bienvenida por perfil ────────────────────

const PROFILE_WELCOME = {
  viajero:
    `✨ *Hola, viajero.*\n` +
    `Aquí en Colón encontrarás experiencias que ` +
    `combinan tradición mexicana con calidad turística.\n\n` +
    `Selecciona una opción para explorar:`,
  aventura:
    `⛰️ *¡Bienvenido, aventurero!*\n` +
    `Colón tiene spots de naturaleza y aventura.\n` +
    `Te comparto lo que tenemos registrado:`,
  religioso:
    `🌹 *Bienvenido, peregrino.*\n` +
    `Colón es hogar de la *Basílica de Soriano* ` +
    `y otros sitios históricos de gran valor religioso.\n\n` +
    `¿Qué información necesitas?`,
  vino:
    `🍷 En Colón encontrarás viñedos, queserías ` +
    `artesanales y restaurantes de la región.\n\n` +
    `¿Qué prefieres?`,
};

// ── Menús de opciones por perfil ─────────────────────────

const PROFILE_MENUS = {
  viajero: {
    btn: "🧭 Ver opciones",
    rows: [
      { id: "v_ruta", title: "🍷 Viñedos y Queserías", description: "Productores de vino y queso" },
      { id: "v_arte", title: "🏺 Artesanías", description: "Ópalo, lana, cerámica" },
      { id: "v_gastro", title: "🍽️ Restaurantes", description: "Gastronomía de la región" },
      { id: "v_historia", title: "🏛️ Sitios históricos", description: "Museos, misiones, capillas" },
      { id: "v_contacto", title: "📞 Conectar prestador", description: "Contacto directo WhatsApp" },
    ],
  },
  aventura: {
    btn: "🧭 Ver actividades",
    rows: [
      { id: "a_senderismo", title: "🏃 Senderismo", description: "Zamorano, Pilones, Presa" },
      { id: "a_escalada", title: "🧗 Tirolesa y escalada", description: "Aventura extrema" },
      { id: "a_camping", title: "🏨 Hospedaje", description: "Hoteles y alojamiento" },
      { id: "a_mapa", title: "📍 Mapa de spots", description: "Ubicaciones GPS" },
    ],
  },
  religioso: {
    btn: "🧭 Ver opciones",
    rows: [
      { id: "r_basilica", title: "⛪ Basílica Soriano", description: "Información del sitio" },
      { id: "r_capilla", title: "🕯️ Capilla de Ánimas", description: "Historia y ubicación" },
      { id: "r_sitios", title: "🏛️ Sitios históricos", description: "Misiones y museos" },
      { id: "r_comida", title: "🍽️ Restaurantes", description: "Opciones para comer" },
    ],
  },
  vino: {
    btn: "🧭 Ver opciones",
    rows: [
      { id: "w_vinedos", title: "🍷 Viñedos", description: "Degustaciones y recorridos" },
      { id: "w_quesos", title: "🧀 Queserías", description: "Productores de queso" },
      { id: "w_maridajes", title: "🍽️ Restaurantes", description: "Gastronomía de la región" },
      { id: "w_tiendas", title: "🛍️ Artesanías", description: "Productos locales" },
    ],
  },
};

// ── Mapeo: opción del menú → tipo de acción ──────────────

const OPTION_ACTION = {
  // Viajero
  v_ruta:     { type: "rich", id: "ruta_queso_vino" },
  v_arte:     { type: "cat", catId: 7 },
  v_gastro:   { type: "cat", catId: 1 },
  v_historia: { type: "cat", catId: 4 },
  v_contacto: { type: "rich", id: "contacto_prestadores" },
  // Aventura
  a_senderismo: { type: "cat", catId: 9 },
  a_escalada:   { type: "cat", catId: 5 },
  a_camping:    { type: "cat", catId: 2 },
  a_mapa:       { type: "rich", id: "mapa_aventura" },
  // Religioso
  r_basilica:   { type: "biz", bizId: 28 },
  r_capilla:    { type: "biz", bizId: 29 },
  r_sitios:     { type: "cat", catId: 4 },
  r_comida:     { type: "cat", catId: 1 },
  // Vino
  w_vinedos:   { type: "cat", catId: 3 },
  w_quesos:    { type: "rich", id: "queserias" },
  w_maridajes: { type: "rich", id: "maridajes" },
  w_tiendas:   { type: "cat", catId: 7 },
};

// ── Palabras clave de texto libre → acción ───────────────

const KEYWORDS = {
  restaurante: "cat_1", restaurantes: "cat_1", comida: "cat_1",
  comer: "cat_1",
  hotel: "cat_2", hoteles: "cat_2", hospedaje: "cat_2", dormir: "cat_2",
  "viñedos": "cat_3", vinedos: "cat_3", vino: "cat_3", cata: "cat_3",
  historia: "cat_4", "históricos": "cat_4", historicos: "cat_4",
  iglesia: "cat_4",
  experiencias: "cat_5", experiencia: "cat_5", tour: "cat_5", tours: "cat_5",
  balneario: "cat_6", balnearios: "cat_6", alberca: "cat_6",
  "artesanías": "cat_7", artesanias: "cat_7", artesanos: "cat_7",
  artesano: "cat_7",
  bares: "cat_8", bar: "cat_8",
  aventura: "cat_9", escalada: "cat_9", tirolesa: "cat_9",
  senderismo: "cat_9", zamorano: "cat_9",
  misa: "cat_4", "basílica": "cat_4", basilica: "cat_4",
  soriano: "cat_4",
  queso: "cat_3", quesos: "cat_3",
};

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
// 🌵 BIENVENIDA – Saludo + selección de perfil
// =========================================================

async function handleWelcome(wa, db, from) {
  const body =
    `📲 *Bienvenido a CristóbalBot* 🌵\n` +
    `Soy tu guía turística digital del municipio de ` +
    `*Colón, Querétaro*. 🌮✨\n\n` +
    `Para recomendarte la mejor experiencia, cuéntame:\n` +
    `*¿Qué tipo de visitante eres?*\n\n` +
    `_Escribe *ayuda* si necesitas asistencia_`;

  await sendList(wa, from, body, "🧭 Elegir perfil", [
    {
      title: "Tipo de visitante",
      rows: [
        {
          id: "profile_viajero",
          title: "🇪🇸 Viajero / Negocios",
          description: "Europa, Internacional o Trabajo",
        },
        {
          id: "profile_aventura",
          title: "🏔️ Aventura",
          description: "Senderismo, Escalada, Tirolesa",
        },
        {
          id: "profile_religioso",
          title: "🙏 Turismo Religioso",
          description: "Basílica, Misiones, Capillas",
        },
        {
          id: "profile_vino",
          title: "🍷 Turismo de Vino",
          description: "Viñedos, Queserías, Catas",
        },
      ],
    },
  ]);

  await trackEvent(db, null, "chatbot_session");
  await upsertSession(db, from, "welcome", {});
}

// =========================================================
// 🌵 PERFIL SELECCIONADO → Bienvenida + Menú del perfil
// =========================================================

async function handleProfileSelected(wa, db, from, profile) {
  const welcomeText = PROFILE_WELCOME[profile];
  if (welcomeText) {
    await sendText(wa, from, welcomeText);
  }
  await sendProfileMenu(wa, from, profile);
  await upsertSession(db, from, "pmenu", { profile });
}

async function sendProfileMenu(wa, from, profile) {
  const menu = PROFILE_MENUS[profile];
  if (!menu) return;

  const body =
    `📍 *Menú — ${PROFILE_NAMES[profile]}*\n\n` +
    `Selecciona una opción para explorar 👇\n\n` +
    `💡 _Escribe *menu* para volver aquí\n` +
    `Escribe *ayuda* para asistencia_`;

  await sendList(wa, from, body, menu.btn, [
    { title: "Opciones", rows: menu.rows },
  ]);
}

// =========================================================
// 🌵 CONTENIDO ENRIQUECIDO POR OPCIÓN
// (Solo datos que existen en la base de datos)
// =========================================================

async function handleRichContent(wa, db, from, richId, ctx) {
  switch (richId) {
    // ─────────────────────────────────────────────────────
    // 🍷🧀 VIÑEDOS Y QUESERÍAS (cat 3 desde BD)
    // ─────────────────────────────────────────────────────
    case "ruta_queso_vino": {
      const [businesses] = await db.execute(
        `SELECT id, name, description, phone, whatsapp
         FROM businesses
         WHERE category_id = 3 AND status = 'published'
         ORDER BY featured DESC, rating DESC`
      );

      if (!businesses.length) {
        await sendText(wa, from, `😔 Aún no hay viñedos ni queserías registrados.`);
        await sendProfileMenu(wa, from, ctx.profile);
        break;
      }

      let text = `🍷🧀 *Viñedos y Queserías de Colón*\n\n`;
      for (const b of businesses) {
        text += `📌 *${b.name}*\n`;
        if (b.description) {
          const short = b.description.length > 120
            ? b.description.substring(0, 120) + "…"
            : b.description;
          text += `   ${short}\n`;
        }
        if (b.phone) text += `   📞 ${b.phone}\n`;
        text += "\n";
      }
      text += `Selecciona uno de la lista para ver su ficha completa:`;
      await sendText(wa, from, text);
      await handleBusinessList(wa, db, from, 3, ctx);
      break;
    }

    // ─────────────────────────────────────────────────────
    // 📍 MAPA DE SPOTS DE AVENTURA (cat 9 GPS desde BD)
    // ─────────────────────────────────────────────────────
    case "mapa_aventura": {
      await sendText(
        wa,
        from,
        `📍 *Spots de aventura en Colón*\nTe comparto las ubicaciones:`
      );
      const [spots] = await db.execute(
        `SELECT id, name, address, lat, lng FROM businesses
         WHERE category_id = 9 AND status = 'published'
         AND lat IS NOT NULL AND lng IS NOT NULL`
      );
      for (const spot of spots.slice(0, 3)) {
        if (spot.lat && spot.lng) {
          await sendLocation(
            wa,
            from,
            spot.lat,
            spot.lng,
            spot.name,
            spot.address
          );
        }
      }
      await sendButtons(wa, from, "¿Algo más?", [
        { id: "sub_cat_9", title: "📋 Ver todos" },
        { id: "go_pmenu", title: "🔙 Volver" },
      ]);
      await upsertSession(db, from, "rich:mapa_aventura", ctx);
      break;
    }

    // ─────────────────────────────────────────────────────
    // 🧀 QUESERÍAS (businesses 31, 32 desde BD)
    // ─────────────────────────────────────────────────────
    case "queserias": {
      const [businesses] = await db.execute(
        `SELECT id, name, description, phone, whatsapp
         FROM businesses
         WHERE id IN (31, 32) AND status = 'published'`
      );

      if (!businesses.length) {
        await sendText(wa, from, `😔 Aún no hay queserías registradas.`);
        await sendProfileMenu(wa, from, ctx.profile);
        break;
      }

      let text = `🧀 *Queserías de Colón*\n\n`;
      for (const b of businesses) {
        text += `📌 *${b.name}*\n`;
        if (b.description) text += `   ${b.description}\n`;
        if (b.phone) text += `   📞 ${b.phone}\n`;
        if (b.whatsapp) text += `   💬 wa.me/${b.whatsapp}\n`;
        text += "\n";
      }
      await sendText(wa, from, text);
      await sendButtons(wa, from, "¿Qué te interesa?", [
        { id: "sub_vinedos", title: "🍷 Ver viñedos" },
        { id: "go_pmenu", title: "🔙 Volver" },
      ]);
      await upsertSession(db, from, "rich:queserias", ctx);
      break;
    }

    // ─────────────────────────────────────────────────────
    // 🍽️ RESTAURANTES (cat 1 desde BD)
    // ─────────────────────────────────────────────────────
    case "maridajes": {
      const [restaurants] = await db.execute(
        `SELECT id, name, description, phone, whatsapp
         FROM businesses
         WHERE category_id = 1 AND status = 'published'
         ORDER BY featured DESC, rating DESC`
      );

      if (!restaurants.length) {
        await sendText(wa, from, `😔 Aún no hay restaurantes registrados.`);
        await sendProfileMenu(wa, from, ctx.profile);
        break;
      }

      let text = `🍽️ *Restaurantes en Colón*\n\n`;
      for (const b of restaurants) {
        text += `📌 *${b.name}*\n`;
        if (b.description) {
          const short = b.description.length > 120
            ? b.description.substring(0, 120) + "…"
            : b.description;
          text += `   ${short}\n`;
        }
        if (b.phone) text += `   📞 ${b.phone}\n`;
        text += "\n";
      }
      text += `Selecciona uno de la lista para ver su ficha completa:`;
      await sendText(wa, from, text);
      await handleBusinessList(wa, db, from, 1, ctx);
      break;
    }

    // ─────────────────────────────────────────────────────
    // 📞 CONTACTO CON PRESTADORES (dinámico desde BD)
    // ─────────────────────────────────────────────────────
    case "contacto_prestadores": {
      const [bizList] = await db.execute(
        `SELECT id, name, whatsapp, phone, category_id
         FROM businesses
         WHERE status = 'published'
           AND whatsapp IS NOT NULL AND whatsapp != ''
         ORDER BY featured DESC, rating DESC
         LIMIT 10`
      );
      if (!bizList.length) {
        await sendText(
          wa,
          from,
          `📞 No hay prestadores con contacto WhatsApp registrado aún.`
        );
        await sendProfileMenu(wa, from, ctx.profile);
        break;
      }
      let text =
        `📞 *Conectar con prestador*\n\n` +
        `Contacta directamente por WhatsApp:\n\n`;
      for (const b of bizList) {
        const preMsg = encodeURIComponent(
          `Hola, vi tu servicio en CristóbalBot y me interesa saber más sobre ${b.name}`
        );
        text +=
          `${CAT_EMOJI[b.category_id] || "📌"} *${b.name}*\n` +
          `   👉 wa.me/${b.whatsapp}?text=${preMsg}\n\n`;
      }
      await sendText(wa, from, text);
      await sendButtons(wa, from, "¿Algo más?", [
        { id: "go_pmenu", title: "🔙 Menú" },
      ]);
      await upsertSession(db, from, "rich:contacto_prestadores", ctx);
      break;
    }

    // ─────────────────────────────────────────────────────
    default:
      await sendText(
        wa,
        from,
        "Lo siento, esa opción no está disponible aún.\nEscribe *menu* para volver."
      );
      break;
  }
}

// =========================================================
// 🔘 SUB-ACCIONES DE CONTENIDO ENRIQUECIDO
// =========================================================

async function handleRichSubAction(wa, db, from, richId, input, ctx) {
  // ── Acciones comunes ───────────────────────────────────
  if (input === "go_pmenu") {
    await sendProfileMenu(wa, from, ctx.profile);
    await upsertSession(db, from, "pmenu", ctx);
    return true;
  }
  if (input === "sub_vinedos" || input === "sub_cat_3") {
    await handleBusinessList(wa, db, from, 3, ctx);
    return true;
  }
  if (input === "sub_cat_1") {
    await handleBusinessList(wa, db, from, 1, ctx);
    return true;
  }
  if (input === "sub_cat_9") {
    await handleBusinessList(wa, db, from, 9, ctx);
    return true;
  }

  // ── Si el input es una opción de perfil, navegar ───────
  if (OPTION_ACTION[input]) {
    const action = OPTION_ACTION[input];
    if (action.type === "rich") {
      await handleRichContent(wa, db, from, action.id, ctx);
    } else if (action.type === "cat") {
      await handleBusinessList(wa, db, from, action.catId, ctx);
    } else if (action.type === "biz") {
      await handleBusinessFicha(wa, db, from, action.bizId, ctx);
    }
    return true;
  }

  return false;
}

// =========================================================
// 📋 LISTADO DE NEGOCIOS POR CATEGORÍA
// =========================================================

async function handleBusinessList(wa, db, from, catId, ctx) {
  const [businesses] = await db.execute(
    `SELECT id, name, address, rating, featured
     FROM businesses
     WHERE category_id = ? AND status = 'published'
     ORDER BY featured DESC, rating DESC`,
    [catId]
  );

  const [catRow] = await db.execute(
    "SELECT name FROM categories WHERE id = ?",
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
    description:
      `${b.rating > 0 ? `⭐ ${b.rating} · ` : ""}` +
      `${(b.address || "Colón, Qro.").substring(0, 60)}`,
  }));

  await sendList(wa, from, body, "📋 Ver lugares", [
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

  // Construir ficha con datos de BD
  let card = `${CAT_EMOJI[biz.category_id] || "📌"} *${biz.name}*\n`;
  card += `📂 ${biz.category_name}\n\n`;

  if (biz.description) {
    const short =
      biz.description.length > 300
        ? biz.description.substring(0, 300) + "…"
        : biz.description;
    card += `${short}\n\n`;
  }

  if (biz.address) card += `📍 ${biz.address}\n`;
  if (biz.phone) card += `📞 ${biz.phone}\n`;

  if (biz.whatsapp) {
    card += `💬 WhatsApp: wa.me/${biz.whatsapp}\n`;
  }

  if (biz.schedule) {
    try {
      const s = JSON.parse(biz.schedule);
      card +=
        `🕐 ` +
        Object.entries(s)
          .map(([k, v]) => `${k}: ${v}`)
          .join(" | ") +
        "\n";
    } catch {
      /* schedule no es JSON */
    }
  }

  if (parseFloat(biz.rating) > 0) card += `⭐ ${biz.rating} / 5\n`;

  if (amenities.length) {
    card += `\n🏷️ *Amenidades:*\n${amenities.map((a) => `  • ${a.name}`).join("\n")}\n`;
  }

  // Enlace de contacto directo con mensaje pre-rellenado
  if (biz.whatsapp) {
    const preMsg = encodeURIComponent(
      `Hola, vi tu servicio en CristóbalBot y me interesa saber más sobre ${biz.name}`
    );
    card += `\n🔗 *Contactar ahora:*\nhttps://wa.me/${biz.whatsapp}?text=${preMsg}`;
  }

  await sendText(wa, from, card);

  // Botones de acción (máx 3)
  const buttons = [];
  if (biz.lat && biz.lng) {
    buttons.push({ id: `loc_${bizId}`, title: "📍 Ubicación" });
  }
  if (biz.whatsapp) {
    buttons.push({ id: `wa_${bizId}`, title: "📞 Contactar" });
  }
  buttons.push({ id: `more_${bizId}`, title: "➡️ Más opciones" });

  await sendButtons(wa, from, "¿Qué te gustaría hacer?", buttons.slice(0, 3));

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
    "📋 Ver opciones",
    [
      {
        title: "Opciones",
        rows: [
          {
            id: `fotos_${bizId}`,
            title: "📸 Ver fotos",
            description: "Galería de imágenes",
          },
          {
            id: "go_pmenu",
            title: "🏠 Menú principal",
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
    await sendLocation(wa, from, b.lat, b.lng, b.name, b.address);
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
  const [images] = await db.execute(
    "SELECT path, caption FROM business_images WHERE business_id = ? ORDER BY sort_order LIMIT 5",
    [bizId]
  );
  const [br] = await db.execute(
    "SELECT name, cover_image FROM businesses WHERE id = ?",
    [bizId]
  );
  const biz = br[0];
  const total = images.length + (biz?.cover_image ? 1 : 0);

  if (!total) {
    await sendText(
      wa,
      from,
      "📸 Este lugar aún no tiene fotos publicadas."
    );
    return;
  }

  await sendText(
    wa,
    from,
    `📸 *Fotos de ${biz?.name}*\n\n` +
      `🖼️ ${total} foto(s) disponibles.\n\n` +
      `_Las fotos están disponibles en la plataforma\n` +
      `web de ColonBot._`
  );
}



// =========================================================
// 🛠️ AYUDA
// =========================================================

async function handleTools(wa, from) {
  const text =
    `🛠️ *Ayuda — CristóbalBot*\n\n` +
    `📌 *Comandos disponibles:*\n` +
    `   • Escribe *hola* para empezar de nuevo\n` +
    `   • Escribe *menu* para volver al menú\n` +
    `   • Escribe el nombre de una categoría\n` +
    `     (restaurantes, hoteles, viñedos, etc.)\n\n` +
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

  // ── "menu" / "inicio" → volver al menú del perfil ─────
  if (["menu", "inicio", "volver"].includes(lower) || input === "go_pmenu") {
    if (ctx.profile) {
      await sendProfileMenu(wa, from, ctx.profile);
      await upsertSession(db, from, "pmenu", ctx);
    } else {
      await handleWelcome(wa, db, from);
    }
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

  // ── Detección de palabras clave ────────────────────────
  if (KEYWORDS[lower] && state && state !== "welcome") {
    const action = KEYWORDS[lower];
    if (action.startsWith("cat_")) {
      const catId = parseInt(action.replace("cat_", ""), 10);
      await handleBusinessList(wa, db, from, catId, ctx);
      return;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Routing por ESTADO
  // ═══════════════════════════════════════════════════════

  // ── WELCOME (seleccionar perfil) ───────────────────────
  if (state === "welcome" || !session) {
    if (input.startsWith("profile_")) {
      const profile = input.replace("profile_", "");
      if (PROFILE_MENUS[profile]) {
        await handleProfileSelected(wa, db, from, profile);
        return;
      }
    }
    await handleWelcome(wa, db, from);
    return;
  }

  // ── PMENU (menú del perfil) ────────────────────────────
  if (state === "pmenu") {
    if (OPTION_ACTION[input]) {
      const action = OPTION_ACTION[input];
      if (action.type === "rich") {
        await handleRichContent(wa, db, from, action.id, ctx);
      } else if (action.type === "cat") {
        await handleBusinessList(wa, db, from, action.catId, ctx);
      } else if (action.type === "biz") {
        await handleBusinessFicha(wa, db, from, action.bizId, ctx);
      }
      return;
    }
    if (input.startsWith("profile_")) {
      const profile = input.replace("profile_", "");
      if (PROFILE_MENUS[profile]) {
        await handleProfileSelected(wa, db, from, profile);
        return;
      }
    }
    await sendProfileMenu(wa, from, ctx.profile || "viajero");
    await upsertSession(db, from, "pmenu", ctx);
    return;
  }

  // ── RICH CONTENT (sub-botones) ─────────────────────────
  if (state.startsWith("rich:")) {
    const richId = state.replace("rich:", "");
    const handled = await handleRichSubAction(
      wa,
      db,
      from,
      richId,
      input,
      ctx
    );
    if (handled) return;

    if (ctx.profile) {
      await sendProfileMenu(wa, from, ctx.profile);
      await upsertSession(db, from, "pmenu", ctx);
    } else {
      await handleWelcome(wa, db, from);
    }
    return;
  }

  // ── CATEGORY LIST (seleccionar negocio) ────────────────
  if (state.startsWith("cat:")) {
    if (input.startsWith("biz_")) {
      const bizId = parseInt(input.replace("biz_", ""), 10);
      if (bizId) {
        await handleBusinessFicha(wa, db, from, bizId, ctx);
        return;
      }
    }
    if (OPTION_ACTION[input]) {
      const action = OPTION_ACTION[input];
      if (action.type === "rich") {
        await handleRichContent(wa, db, from, action.id, ctx);
      } else if (action.type === "cat") {
        await handleBusinessList(wa, db, from, action.catId, ctx);
      } else if (action.type === "biz") {
        await handleBusinessFicha(wa, db, from, action.bizId, ctx);
      }
      return;
    }
    if (ctx.profile) {
      await sendProfileMenu(wa, from, ctx.profile);
      await upsertSession(db, from, "pmenu", ctx);
    }
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
    if (input === "go_pmenu") {
      await sendProfileMenu(wa, from, ctx.profile);
      await upsertSession(db, from, "pmenu", ctx);
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
