/**
 * Vigilante de Juvenilia Online.
 *
 * Corre en GitHub Actions —a propósito FUERA de Vercel y de Railway, para que
 * una caída de esas plataformas no se lleve puesto también al que tiene que
 * avisar—, revisa los tres sistemas y avisa por WhatsApp.
 *
 * Anda en MODO CONTINUO: una sola corrida se queda despierta casi 6 horas
 * chequeando cada 3 minutos. Es así porque el reloj de GitHub es "mejor
 * esfuerzo": con horarios muy seguidos (cada 5 minutos) puede directamente no
 * dispararse — el 10/09/2026 no arrancó en una hora. Los horarios espaciados sí
 * son confiables, así que se dispara una vez por hora y esa corrida cubre el
 * hueco hasta la siguiente. El candado de concurrencia hace que la nueva
 * reemplace a la vieja: nunca hay dos a la vez ni queda un hueco entre una y otra.
 *
 * Avisa SOLO cuando algo CAMBIA: cuando se rompe y cuando se arregla. Si algo
 * sigue roto no repite el mensaje cada 3 minutos (salvo un recordatorio por
 * hora), porque una alerta que suena todo el tiempo se termina ignorando.
 *
 * El estado vive en estado.json, versionado en este mismo repo: es la memoria
 * entre corridas y además el historial de caídas.
 *
 * Sin argumentos hace un solo barrido y sale (para probarlo a mano).
 * Con `--continuo` entra en el ciclo largo.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { correrTodo } from "./chequeos.mjs";

const ARCHIVO = "estado.json";
const RECORDAR_CADA = 60 * 60 * 1000;      // repetir aviso de algo roto: 1 vez por hora
const CADA = 3 * 60 * 1000;                // un barrido cada 3 minutos
const DURACION = 5.5 * 60 * 60 * 1000;     // la corrida vive 5 h 30 (el tope de GitHub son 6)

const CONTINUO = process.argv.includes("--continuo");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function leerEstado() {
  if (!existsSync(ARCHIVO)) return { chequeos: {}, ultimaCorrida: null };
  try { return JSON.parse(readFileSync(ARCHIVO, "utf8")); } catch { return { chequeos: {}, ultimaCorrida: null }; }
}

function reloj(d) {
  return d.toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function haceCuanto(desde, ahora) {
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
    try {
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
        signal: AbortSignal.timeout(20_000),
      });
      const cuerpo = await res.json().catch(() => ({}));
      if (!res.ok) console.error(`[aviso] No se pudo avisar a ${destino}:`, JSON.stringify(cuerpo));
      else console.log(`[aviso] Avisado a ${destino}.`);
    } catch (e) {
      console.error(`[aviso] Falló el envío a ${destino}:`, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * Guarda estado.json en el repo. Se hace dentro del ciclo (y no al final) porque
 * la corrida puede ser cancelada por la siguiente: si se guardara recién al
 * terminar, se perdería la memoria y se volverían a mandar avisos repetidos.
 */
function guardar() {
  const git = (...args) => execFileSync("git", args, { stdio: "pipe" }).toString();
  try {
    if (!git("status", "--porcelain", "--", ARCHIVO).trim()) return;
    git("add", ARCHIVO);
    git("commit", "-m", `Estado ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`);
    try { git("pull", "--rebase", "--quiet"); } catch { /* nadie más escribe acá */ }
    git("push", "--quiet");
    console.log("[estado] guardado.");
  } catch (e) {
    // Que no se pueda guardar no puede tumbar el monitoreo.
    console.error("[estado] no se pudo guardar:", (e.stderr?.toString() || e.message || "").slice(0, 200));
  }
}

/** Un barrido: chequea todo, avisa lo que cambió, guarda. Devuelve cuántos fallan. */
async function barrer() {
  const ahora = new Date();
  const cuando = reloj(ahora);
  const estado = leerEstado();
  const resultados = await correrTodo();

  const rotos = [];
  const arreglados = [];

  for (const c of resultados) {
    const previo = estado.chequeos[c.id] ?? { ok: true, desde: ahora.toISOString(), avisadoEn: null };

    if (!c.ok && previo.ok) {
      estado.chequeos[c.id] = { ok: false, desde: ahora.toISOString(), avisadoEn: ahora.toISOString(), detalle: c.detalle };
      rotos.push(c);
    } else if (!c.ok && !previo.ok) {
      const hayQueRecordar = !previo.avisadoEn || ahora - new Date(previo.avisadoEn) > RECORDAR_CADA;
      estado.chequeos[c.id] = { ...previo, detalle: c.detalle, avisadoEn: hayQueRecordar ? ahora.toISOString() : previo.avisadoEn };
      if (hayQueRecordar) rotos.push({ ...c, detalle: `${c.detalle} (sigue así desde hace ${haceCuanto(previo.desde, ahora)})` });
    } else if (c.ok && !previo.ok) {
      arreglados.push({ ...c, duro: haceCuanto(previo.desde, ahora) });
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

  const fallando = resultados.filter((c) => !c.ok);
  console.log(`\n=== ${cuando} ===`);
  for (const c of resultados) console.log(`${c.ok ? "✅" : "❌"} ${c.titulo} — ${c.detalle}`);
  console.log(fallando.length === 0 ? "Todo en orden." : `${fallando.length} problema(s).`);

  // Se guarda si cambió algo o cada tanto, para que el historial quede en el repo.
  if (rotos.length || arreglados.length) guardar();

  return fallando.length;
}

if (!CONTINUO) {
  const fallan = await barrer();
  guardar();
  // Salir con error hace que GitHub mande un mail: segundo canal por si el
  // WhatsApp es justamente lo que está roto.
  if (fallan) process.exit(1);
} else {
  const hasta = Date.now() + DURACION;
  let vuelta = 0;
  console.log(`Vigilante continuo: un barrido cada ${CADA / 60000} minutos hasta ${reloj(new Date(hasta))}.`);
  while (Date.now() < hasta) {
    vuelta++;
    try {
      await barrer();
    } catch (e) {
      // Un error del propio vigilante no lo puede dejar mudo: se registra y sigue.
      console.error(`[vigilante] error en el barrido ${vuelta}:`, e instanceof Error ? e.message : e);
    }
    // Una vez por hora se guarda igual, aunque no haya cambiado nada: deja
    // señal de vida en el repo y mantiene vivo el reloj de GitHub Actions.
    if (vuelta % 20 === 0) guardar();
    if (Date.now() + CADA >= hasta) break;
    await dormir(CADA);
  }
  console.log(`Fin de la corrida: ${vuelta} barridos.`);
  guardar();
}
