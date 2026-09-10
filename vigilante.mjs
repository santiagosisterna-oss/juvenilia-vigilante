/**
 * Vigilante de Juvenilia Online.
 *
 * Corre cada 5 minutos en GitHub Actions —a propósito FUERA de Vercel y de
 * Railway, para que una caída de esas plataformas no se lleve puesto también al
 * que tiene que avisar—, revisa los tres sistemas y avisa por WhatsApp.
 *
 * Avisa SOLO cuando algo CAMBIA: cuando se rompe y cuando se arregla. Si algo
 * sigue roto no repite el mensaje cada 5 minutos (salvo un recordatorio por
 * hora), porque una alerta que suena todo el tiempo se termina ignorando.
 *
 * El estado vive en estado.json, versionado en este mismo repo: es la memoria
 * entre corridas y además el historial de caídas.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { correrTodo } from "./chequeos.mjs";

const ARCHIVO = "estado.json";
const RECORDAR_CADA = 60 * 60 * 1000; // repetir aviso de algo roto: 1 vez por hora

const ahora = new Date();
const cuando = ahora.toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function leerEstado() {
  if (!existsSync(ARCHIVO)) return { chequeos: {}, ultimaCorrida: null };
  try { return JSON.parse(readFileSync(ARCHIVO, "utf8")); } catch { return { chequeos: {}, ultimaCorrida: null }; }
}

function haceCuanto(desde) {
  const min = Math.round((ahora - new Date(desde)) / 60000);
  if (min < 60) return `${min} minuto${min === 1 ? "" : "s"}`;
  const h = Math.floor(min / 60);
  return `${h} hora${h === 1 ? "" : "s"} y ${min % 60} minutos`;
}

/** Manda un WhatsApp usando una plantilla aprobada por Meta. */
async function mandarWhatsApp(plantilla, variables) {
  const { WA_ACCESS_TOKEN: token, WA_PHONE_NUMBER_ID: numero, AVISAR_A: destinos } = process.env;
  if (!token || !numero || !destinos) {
    console.log("[aviso] Sin credenciales o sin destinatarios: no se manda WhatsApp.");
    return;
  }
  for (const destino of destinos.split(",").map((s) => s.trim()).filter(Boolean)) {
    const res = await fetch(`https://graph.facebook.com/v21.0/${numero}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: destino,
        type: "template",
        template: {
          name: plantilla,
          language: { code: "es_AR" },
          components: [{ type: "body", parameters: variables.map((t) => ({ type: "text", text: String(t).slice(0, 900) })) }],
        },
      }),
    });
    const cuerpo = await res.json().catch(() => ({}));
    if (!res.ok) console.error(`[aviso] No se pudo avisar a ${destino}:`, JSON.stringify(cuerpo));
    else console.log(`[aviso] Avisado a ${destino}.`);
  }
}

const estado = leerEstado();
const resultados = await correrTodo();

const rotos = [];
const arreglados = [];

for (const c of resultados) {
  const previo = estado.chequeos[c.id] ?? { ok: true, desde: ahora.toISOString(), avisadoEn: null };

  if (!c.ok && previo.ok) {
    // Se acaba de romper.
    estado.chequeos[c.id] = { ok: false, desde: ahora.toISOString(), avisadoEn: ahora.toISOString(), detalle: c.detalle };
    rotos.push(c);
  } else if (!c.ok && !previo.ok) {
    // Sigue roto: recordar como mucho una vez por hora.
    const hayQueRecordar = !previo.avisadoEn || ahora - new Date(previo.avisadoEn) > RECORDAR_CADA;
    estado.chequeos[c.id] = { ...previo, detalle: c.detalle, avisadoEn: hayQueRecordar ? ahora.toISOString() : previo.avisadoEn };
    if (hayQueRecordar) rotos.push({ ...c, detalle: `${c.detalle} (sigue así desde hace ${haceCuanto(previo.desde)})` });
  } else if (c.ok && !previo.ok) {
    // Se arregló.
    arreglados.push({ ...c, duro: haceCuanto(previo.desde) });
    estado.chequeos[c.id] = { ok: true, desde: ahora.toISOString(), avisadoEn: null };
  } else {
    estado.chequeos[c.id] = { ok: true, desde: previo.desde ?? ahora.toISOString(), avisadoEn: null };
  }
}

for (const c of rotos) await mandarWhatsApp("alerta_sistema", [c.titulo, c.detalle, cuando]);
for (const c of arreglados) await mandarWhatsApp("alerta_sistema_normalizado", [c.titulo, c.duro, cuando]);

estado.ultimaCorrida = ahora.toISOString();
estado.resumen = resultados.map((c) => ({ id: c.id, titulo: c.titulo, ok: c.ok, detalle: c.detalle }));
writeFileSync(ARCHIVO, JSON.stringify(estado, null, 2) + "\n");

// Salida legible en el registro de GitHub.
console.log(`\n=== Vigilante · ${cuando} ===`);
for (const c of resultados) console.log(`${c.ok ? "✅" : "❌"} ${c.titulo} — ${c.detalle}`);
const fallando = resultados.filter((c) => !c.ok);
console.log(`\n${fallando.length === 0 ? "Todo en orden." : `${fallando.length} problema(s).`}`);

// Se sale con error si hay algo roto: así GitHub además manda un mail y marca la
// corrida en rojo, que es un segundo canal de aviso por si el WhatsApp falla.
if (fallando.length) process.exit(1);
