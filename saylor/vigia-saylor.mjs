// Vigía Saylor: mira BTC en vivo (Coinbase) y ejecuta las órdenes que deja Claude.
// Solo SIMULACIÓN: no se conecta a ningún exchange para operar, solo lee precios públicos.
//
// Lee   saylor/niveles.json      (lo escribe Claude en cada revisión horaria)
// Escribe saylor/ejecuciones.json (lo lee Claude en la revisión siguiente)
//
// niveles.json:
// {
//   "actualizado": "2026-11-02T15:35:00Z",
//   "posicion_costo": 1500, "btc": 0.0193,      // posición abierta (USD al costo y BTC)
//   "bala_posicion_usd": 166.67,                 // posición que suma cada bala (margen × 5)
//   "ordenes": [
//     {"id": "tiro-2026-11-02", "tipo": "tiro", "lado": "abajo", "precio": 76800, "balas": 2,
//      "vence": "2026-11-02T23:00:00Z"},
//     {"id": "cierre", "tipo": "cierre", "lado": "arriba", "precio": 80900},
//     {"id": "critica", "tipo": "critica", "lado": "abajo", "precio": 71500},
//     {"id": "terminal", "tipo": "terminal", "lado": "abajo", "precio": 68400}
//   ]
// }

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const DIR = "saylor";
const NIVELES = `${DIR}/niveles.json`;
const EJEC = `${DIR}/ejecuciones.json`;
const DURACION_MS = Number(process.env.DURACION_MIN || 345) * 60_000; // ~5 h 45 min por corrida
const NTFY = process.env.NTFY_TOPIC || "";
const inicio = Date.now();

const leer = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
const usd = (n) => Math.round(n).toLocaleString("es-AR");
const horaART = (ms) =>
  new Date(ms).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour12: false });

let niveles = leer(NIVELES, { ordenes: [] });
let ejecuciones = leer(EJEC, []);
const yaEjecutada = (id) => ejecuciones.some((e) => e.id === id);

function sh(cmd) {
  try { return execSync(cmd, { stdio: "pipe" }).toString(); } catch (e) { console.error(cmd, e.message); return ""; }
}

// Trae los niveles nuevos que haya subido Claude.
function actualizarNiveles() {
  sh("git pull --rebase --autostash -q");
  niveles = leer(NIVELES, niveles);
  ejecuciones = leer(EJEC, ejecuciones);
}

async function avisar(titulo, texto) {
  console.log(`AVISO: ${titulo} | ${texto}`);
  if (!NTFY) return;
  try {
    await fetch(`https://ntfy.sh/${NTFY}`, {
      method: "POST",
      headers: { Title: titulo, Priority: "high", Tags: "rotating_light" },
      body: texto,
    });
  } catch (e) { console.error("ntfy:", e.message); }
}

function guardar(mensaje) {
  writeFileSync(EJEC, JSON.stringify(ejecuciones, null, 2) + "\n");
  writeFileSync(NIVELES, JSON.stringify(niveles, null, 2) + "\n");
  sh(`git add ${EJEC} ${NIVELES}`);
  sh(`git -c user.name="vigia-saylor" -c user.email="vigia@users.noreply.github.com" commit -q -m "${mensaje}"`);
  for (let i = 0; i < 3; i++) {
    sh("git pull --rebase -q");
    if (sh("git push -q 2>&1 && echo ok").includes("ok")) return;
  }
}

// Recalcula promedio y +20% después de un tiro (5x: +20% sobre margen = promedio × 1,04).
function despuesDeTiro(o, precio) {
  const pos = (niveles.posicion_costo || 0) + o.balas * niveles.bala_posicion_usd;
  const btc = (niveles.btc || 0) + (o.balas * niveles.bala_posicion_usd) / precio;
  niveles.posicion_costo = Math.round(pos * 100) / 100;
  niveles.btc = Math.round(btc * 1e8) / 1e8;
  const prom = pos / btc;
  const c = niveles.ordenes.find((x) => x.tipo === "cierre");
  if (c) c.precio = Math.round(prom * 1.04);
  return prom;
}

let ocupado = false;
async function revisar(precio, ms) {
  if (ocupado) return;
  const vivas = (niveles.ordenes || []).filter(
    (o) => !yaEjecutada(o.id) && (!o.vence || Date.parse(o.vence) > ms)
  );
  const tocada = vivas.find((o) => (o.lado === "abajo" ? precio <= o.precio : precio >= o.precio));
  if (!tocada) return;
  ocupado = true;
  const o = tocada;
  const fill = o.precio; // se ejecuta al precio de la orden, como una orden límite
  const ej = { id: o.id, tipo: o.tipo, precio: fill, precio_tick: precio, balas: o.balas ?? null,
               hora_utc: new Date(ms).toISOString(), hora_art: horaART(ms), procesada_por_claude: false };
  let titulo, texto;
  if (o.tipo === "tiro" || o.tipo === "inicio") {
    const prom = despuesDeTiro(o, fill);
    ej.promedio_nuevo = Math.round(prom);
    titulo = `Se ejecutó el tiro: ${o.balas} bala(s) a ${usd(fill)}`;
    texto = `${ej.hora_art} ART. Promedio nuevo ≈ ${usd(prom)}. Nuevo +20% en ${usd(prom * 1.04)}. Claude completa el reporte en la próxima revisión.`;
  } else if (o.tipo === "cierre") {
    niveles.ordenes = niveles.ordenes.filter((x) => x.id === o.id); // se cancela todo lo demás
    titulo = `Cerré todo a ${usd(fill)} (+20%)`;
    texto = `${ej.hora_art} ART. Posición cerrada. Claude calcula la ganancia y arma el inicio de la próxima operación.`;
  } else {
    titulo = `Recarga ${o.tipo} a ${usd(fill)}`;
    texto = `${ej.hora_art} ART. El PnL tocó el nivel de recarga ${o.tipo}. Claude aplica la recarga en la próxima revisión.`;
  }
  ejecuciones.push(ej);
  guardar(`vigia: ${o.tipo} a ${fill}`);
  await avisar(titulo, texto);
  ocupado = false;
}

// Al arrancar, revisa las velas de 1 minuto desde el último ejecutado/actualizado
// por si hubo un toque mientras el vigía estaba reiniciando.
async function ponerseAlDia() {
  const desde = Math.max(Date.parse(niveles.actualizado || 0) || 0, Date.now() - 5 * 3600_000);
  const r = await fetch(
    `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${new Date(desde).toISOString()}&end=${new Date().toISOString()}`
  );
  if (!r.ok) return;
  const velas = (await r.json()).reverse(); // [t, low, high, open, close, vol], de vieja a nueva
  for (const [t, low, high] of velas) {
    await revisar(low, t * 1000);
    await revisar(high, t * 1000);
  }
}

function escuchar() {
  return new Promise((resolve) => {
    const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
    let ultimo = Date.now();
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker"] }));
      console.log("Conectado a Coinbase, mirando BTC en vivo…");
    };
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.type !== "ticker") return;
      ultimo = Date.now();
      revisar(Number(d.price), Date.parse(d.time) || Date.now());
    };
    const perro = setInterval(() => {
      if (Date.now() - ultimo > 60_000) { console.log("Sin datos 60 s, reconecto"); ws.close(); }
      if (Date.now() - inicio > DURACION_MS) ws.close();
    }, 10_000);
    ws.onclose = ws.onerror = () => { clearInterval(perro); resolve(); };
  });
}

// Cada 2 minutos baja los niveles nuevos de Claude.
setInterval(actualizarNiveles, 120_000);
actualizarNiveles();
await ponerseAlDia();
while (Date.now() - inicio < DURACION_MS) {
  await escuchar();
  if (Date.now() - inicio < DURACION_MS) await new Promise((r) => setTimeout(r, 3000));
}
console.log("Fin de la corrida; la siguiente sigue mirando.");
process.exit(0);
