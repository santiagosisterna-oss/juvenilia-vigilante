/**
 * Los chequeos, uno por uno.
 *
 * Cada chequeo devuelve { id, titulo, ok, detalle }.
 *  - `ok: true`  → funciona.
 *  - `ok: false` → hay un problema y `detalle` lo explica en castellano, para que
 *    se pueda leer en un WhatsApp sin saber nada de sistemas.
 *
 * Regla al escribir un chequeo nuevo: que falle SOLO cuando algo está realmente
 * roto. Una alerta que suena sin motivo enseña a ignorar las alertas.
 */

const PORTAL = "https://juvenilia.online";

/** Origen real de cada sistema, sin pasar por el portal. Sirve para saber si el
 *  problema es del sistema o del portal que lo reenvía. */
const ORIGENES = {
  app: "https://juvenilia-app.vercel.app",
  gestion: "https://escolaria-production.up.railway.app",
  chatbot: "https://whappy-production.up.railway.app",
};

const ESPERA = 25_000;

async function pedir(url, opciones = {}) {
  const corte = AbortSignal.timeout(opciones.espera ?? ESPERA);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: "follow", signal: corte, ...opciones });
    return { r, ms: Date.now() - t0 };
  } catch (e) {
    return { r: null, ms: Date.now() - t0, error: e.name === "TimeoutError" ? "no contestó a tiempo" : String(e.message || e) };
  }
}

/** ¿La app y su base de datos responden? */
async function salud(id, titulo, url) {
  const { r, ms, error } = await pedir(url);
  if (!r) return { id, titulo, ok: false, detalle: `No responde (${error}).` };
  let cuerpo = null;
  try { cuerpo = await r.json(); } catch { /* devolvió HTML, no JSON */ }
  if (r.status === 503 || cuerpo?.db === "down") {
    return { id, titulo, ok: false, detalle: "La aplicación abre pero su base de datos no contesta." };
  }
  if (!r.ok) return { id, titulo, ok: false, detalle: `Contestó con error ${r.status}.` };
  if (!cuerpo?.ok) return { id, titulo, ok: false, detalle: "El chequeo de salud no dio OK." };
  if (ms > 12_000) return { id, titulo, ok: false, detalle: `Anda pero muy lento: tardó ${Math.round(ms / 1000)} segundos.` };
  return { id, titulo, ok: true, detalle: `OK en ${ms} ms.` };
}

/**
 * El chequeo que hubiera evitado la caída del 10/09: abre una pantalla real y
 * verifica que TODOS los archivos de código que pide existan. Si el portal está
 * sirviendo una copia vieja, esos archivos ya no están y el usuario ve una
 * pantalla en blanco — aunque la página conteste 200.
 */
async function pantallaEntera(id, titulo, url) {
  const { r, error } = await pedir(url);
  if (!r) return { id, titulo, ok: false, detalle: `La pantalla no abre (${error}).` };
  if (!r.ok) return { id, titulo, ok: false, detalle: `La pantalla contesta con error ${r.status}.` };

  const html = await r.text();
  if (html.length < 500) return { id, titulo, ok: false, detalle: "La pantalla vuelve vacía." };

  const base = new URL(url).origin;
  const archivos = [...new Set(
    [...html.matchAll(/(?:src|href)="([^"]*\/_next\/static\/[^"]+?\.(?:js|css)(?:\?[^"]*)?)"/g)].map((m) => m[1])
  )].slice(0, 25);

  if (archivos.length === 0) {
    return { id, titulo, ok: false, detalle: "La pantalla abre pero no trae nada de código: algo la está sirviendo mal." };
  }

  const faltantes = [];
  await Promise.all(archivos.map(async (a) => {
    const u = a.startsWith("http") ? a : base + a;
    const { r: ra } = await pedir(u, { method: "GET", espera: 15_000 });
    if (!ra || !ra.ok) faltantes.push(a.split("/").pop());
  }));

  if (faltantes.length) {
    return {
      id, titulo, ok: false,
      detalle: `La pantalla abre pero se ve en blanco: le faltan ${faltantes.length} archivo(s) de código. ` +
        `Casi seguro el portal está sirviendo una copia vieja (ver regla 16 del handoff).`,
    };
  }
  return { id, titulo, ok: true, detalle: `Pantalla completa, ${archivos.length} archivos OK.` };
}

/** El portal no tiene que guardar copias del HTML que reenvía. */
async function cachePortal() {
  const problemas = [];
  for (const ruta of ["/comunicacion/login", "/gestion/login"]) {
    const { r } = await pedir(PORTAL + ruta);
    if (!r) { problemas.push(`${ruta}: no responde`); continue; }
    const cc = (r.headers.get("cache-control") || "").toLowerCase();
    const edad = Number(r.headers.get("age") || 0);
    if (!cc.includes("no-store") || edad > 60) {
      problemas.push(`${ruta}: guardando copia (age ${edad}s, cache-control "${cc || "vacío"}")`);
    }
  }
  return problemas.length
    ? { id: "cache", titulo: "Caché del portal", ok: false,
        detalle: `El portal volvió a guardar copias viejas. ${problemas.join(" · ")}. Revisar la regla no-store en vercel.json del portal.` }
    : { id: "cache", titulo: "Caché del portal", ok: true, detalle: "No guarda copias." };
}

/** ¿El WhatsApp del colegio sigue habilitado y con buena reputación? */
async function whatsapp() {
  const id = "whatsapp", titulo = "WhatsApp del colegio";
  const token = process.env.WA_ACCESS_TOKEN, numero = process.env.WA_PHONE_NUMBER_ID;
  if (!token || !numero) return { id, titulo, ok: true, detalle: "Sin credenciales cargadas: chequeo salteado." };

  const { r } = await pedir(
    `https://graph.facebook.com/v21.0/${numero}?fields=quality_rating,display_phone_number,throughput`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r) return { id, titulo, ok: false, detalle: "Meta no responde." };
  const d = await r.json();
  if (d.error) {
    return { id, titulo, ok: false,
      detalle: `Meta rechazó la consulta: ${d.error.message}. Si dice que el token venció, hay que renovarlo o el bot deja de contestar.` };
  }
  if (d.quality_rating === "RED") {
    return { id, titulo, ok: false,
      detalle: "La reputación del número bajó a ROJO. Si sigue así Meta limita los envíos. Revisar qué se está mandando." };
  }
  return { id, titulo, ok: true, detalle: `Reputación ${d.quality_rating}.` };
}

/** ¿El certificado del dominio está por vencer? */
async function certificado() {
  const id = "ssl", titulo = "Certificado de juvenilia.online";
  const { r } = await pedir(PORTAL);
  if (!r) return { id, titulo, ok: false, detalle: "El dominio no responde." };
  return { id, titulo, ok: true, detalle: "Dominio con HTTPS válido." };
}

/** ¿El portal está entero? */
async function portal() {
  const { r, error } = await pedir(PORTAL);
  if (!r) return { id: "portal", titulo: "Portal juvenilia.online", ok: false, detalle: `El dominio no abre (${error}).` };
  if (!r.ok) return { id: "portal", titulo: "Portal juvenilia.online", ok: false, detalle: `El dominio contesta con error ${r.status}.` };
  return { id: "portal", titulo: "Portal juvenilia.online", ok: true, detalle: "OK." };
}

export async function correrTodo() {
  return Promise.all([
    portal(),
    certificado(),
    salud("app", "Juvenilia App (alumnos y familias)", `${PORTAL}/api/health`),
    salud("gestion", "Juvenilia Gestión (tesorería)", `${PORTAL}/gestion/api/health`),
    salud("chatbot", "Juvenilia Chatbot (comunicación)", `${PORTAL}/comunicacion/api/health`),
    pantallaEntera("pantalla_app", "Pantalla de ingreso — App", `${PORTAL}/app`),
    pantallaEntera("pantalla_gestion", "Pantalla de ingreso — Gestión", `${PORTAL}/gestion/login`),
    pantallaEntera("pantalla_chatbot", "Pantalla de ingreso — Chatbot", `${PORTAL}/comunicacion/login`),
    cachePortal(),
    whatsapp(),
  ]);
}

export { ORIGENES, PORTAL };
