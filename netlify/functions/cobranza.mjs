// Función de Netlify: /api/cobranza
// La página nunca llama a Google ni a GHL directo: siempre pasa por acá.
// Es de SOLO LECTURA: no modifica nada en GHL ni en las planillas.
// Las llaves viven en variables de entorno de Netlify, nunca en este código.
import { createHash, timingSafeEqual } from 'node:crypto';
import { calcular } from './lib/calculo.mjs';

// Estos IDs no son secretos (identifican, no dan acceso por sí solos).
const LOCATION_ID = 'x7nYndpXUc1dmpunATsZ';
const PIPELINE_ID = 'rvcnWTrJN2GmgaDnlaUp'; // pipeline "Cobranza Founders"
const GHL = 'https://services.leadconnectorhq.com';
const CACHE_MS = 2 * 60 * 1000; // caché corta de 2 minutos
let cache = null;

export const config = { path: '/api/cobranza' };

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function claveOk(dada) {
  const esperada = process.env.DASHBOARD_PASSWORD || '';
  if (!esperada) return false;
  const a = createHash('sha256').update(String(dada)).digest();
  const b = createHash('sha256').update(esperada).digest();
  return timingSafeEqual(a, b);
}

const hoyArgentina = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());

async function leerPlanillas() {
  const url = new URL(process.env.APPS_SCRIPT_URL);
  url.searchParams.set('clave', process.env.APPS_SCRIPT_KEY);
  const r = await fetch(url, { redirect: 'follow' });
  const txt = await r.text();
  let datos;
  try {
    datos = JSON.parse(txt);
  } catch {
    throw new Error('El script de Google no devolvió datos válidos. Revisá que esté publicado para "Cualquier usuario".');
  }
  if (datos.error) throw new Error('Script de Google: ' + datos.error);
  return datos;
}

const ghlHeaders = () => ({
  Authorization: `Bearer ${process.env.GHL_TOKEN}`,
  Version: '2021-07-28',
  Accept: 'application/json',
});

async function ghl(path) {
  const r = await fetch(GHL + path, { headers: ghlHeaders() });
  if (!r.ok) throw new Error(`GoHighLevel respondió ${r.status}. Revisá el token y sus permisos de lectura.`);
  return r.json();
}

async function leerEtapas() {
  const d = await ghl(`/opportunities/pipelines?locationId=${LOCATION_ID}`);
  const p = (d.pipelines || []).find((x) => x.id === PIPELINE_ID);
  if (!p) throw new Error('No encuentro el pipeline "Cobranza Founders" con el ID configurado.');
  return new Map((p.stages || []).map((s) => [s.id, s.name]));
}

async function leerOportunidades() {
  const todas = [];
  let after = null;
  let afterId = null;
  for (let pagina = 0; pagina < 20; pagina++) {
    let ruta = `/opportunities/search?location_id=${LOCATION_ID}&pipeline_id=${PIPELINE_ID}&limit=100`;
    if (after && afterId) ruta += `&startAfter=${after}&startAfterId=${afterId}`;
    const d = await ghl(ruta);
    const lote = d.opportunities || [];
    todas.push(...lote);
    after = d.meta?.startAfter;
    afterId = d.meta?.startAfterId;
    if (lote.length < 100 || !after || !afterId) break;
  }
  return todas;
}

export default async (req) => {
  if (!process.env.DASHBOARD_PASSWORD) {
    return json({ error: 'Falta configurar la variable DASHBOARD_PASSWORD en Netlify.' }, 500);
  }
  if (!claveOk(req.headers.get('x-password') || '')) {
    return json({ error: 'Contraseña incorrecta' }, 401);
  }
  const faltan = ['GHL_TOKEN', 'APPS_SCRIPT_URL', 'APPS_SCRIPT_KEY'].filter((n) => !process.env[n]);
  if (faltan.length) {
    return json({ error: 'Faltan variables de entorno en Netlify: ' + faltan.join(', ') }, 500);
  }

  const fresco = new URL(req.url).searchParams.get('fresh') === '1';
  if (!fresco && cache && Date.now() - cache.t < CACHE_MS) return json(cache.datos);

  try {
    const [planillas, etapas, oportunidades] = await Promise.all([
      leerPlanillas(),
      leerEtapas(),
      leerOportunidades(),
    ]);
    const tarjetas = oportunidades.map((o) => ({
      nombre: o.contact?.name || o.name || '',
      email: o.contact?.email || '',
      etapa: etapas.get(o.pipelineStageId) || '(etapa desconocida)',
      estado: o.status,
      valor: o.monetaryValue ?? 0,
    }));
    const datos = {
      ...calcular({ madre: planillas.madre || [], registro: planillas.registro || [], tarjetas, hoy: hoyArgentina() }),
      generado: new Date().toISOString(),
    };
    cache = { t: Date.now(), datos };
    return json(datos);
  } catch (err) {
    return json({ error: err.message || 'Error al consultar los datos' }, 502);
  }
};
