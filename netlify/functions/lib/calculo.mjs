// Lógica del Tablero de Cobranza.
// No llama a ninguna API: recibe los datos ya leídos y devuelve el tablero armado.
// Fuentes:
//   madre     = planilla de Mel (qué cuotas debe cada cliente, cuándo, y si están tildadas)
//   registro  = tu Registro de pagos confirmados (qué entró y en qué fecha real)
//   tarjetas  = pipeline "Cobranza Founders" de GoHighLevel (en qué etapa está cada cliente)

export const normEmail = (e) => String(e ?? '').trim().toLowerCase();
export const normNombre = (n) =>
  String(n ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// El control entre Registro, planilla de Mel y pipeline rige desde que Male tomó el puesto (septiembre).
// Antes de esa fecha la única fuente es la planilla de Mel y no se generan avisos de diferencias.
export const INICIO_CONTROL = '2026-09-01';
const usd = (n) => 'US$ ' + Math.round(n).toLocaleString('es-AR');

// "Cuota 2 Pagada" => la 2 es la última pagada. "Cuota 3 Pendiente" => la 3 es la que está por cobrar (las anteriores, pagadas).
// "Plan completo" => todo pagado. Las demás etapas no se controlan por cuota.
export function etapaEsperada(etapa) {
  const e = String(etapa ?? '').trim();
  const m = /^Cuota (\d+) (pagada|pendiente)$/i.exec(e);
  if (m) {
    const k = Number(m[1]);
    const estado = m[2].toLowerCase();
    return { tipo: 'cuotas', pagadas: estado === 'pagada' ? k : k - 1, k, estado };
  }
  if (/^plan completo$/i.test(e)) return { tipo: 'completo' };
  return null;
}

// Se compara por el NÚMERO de cuota y no por cuántas hay pagadas: en la planilla la numeración a veces salta
// (por ejemplo 1, 3 y 4) y, aun así, "Cuota 4 Pendiente" es correcto si la 4 es la que falta y las anteriores están pagadas.
export function etapaCoincide(exp, cuotas) {
  return cuotas.every((c) => (c.n <= exp.pagadas) === !!c.pagada);
}

// El valor de la tarjeta es lo que faltaba cobrar cuando se cargó o se actualizó, y no siempre se baja al cobrar cada cuota.
// Por eso es normal que sea MAYOR que el saldo si la diferencia son cuotas que ya se pagaron. Se acepta el saldo actual
// o cualquier "suma desde la cuota j" (lo que faltaba antes de cobrar las anteriores). Solo se avisa si el valor es menor
// que lo que falta, o si no coincide con ninguna de esas sumas.
export function saldoCoincide(valor, cuotas) {
  const ord = [...cuotas].sort((a, b) => a.n - b.n);
  const saldo = ord.filter((c) => !c.pagada).reduce((s, c) => s + c.monto, 0);
  if (Math.abs(valor - saldo) <= 0.5) return { ok: true, saldo };
  const desdeCuota = ord.map((_, i) => ord.slice(i).reduce((s, c) => s + c.monto, 0));
  if (valor > saldo + 0.5 && desdeCuota.some((x) => Math.abs(x - valor) <= 0.5)) return { ok: true, saldo, desactualizado: true };
  return { ok: false, saldo, menor: valor < saldo };
}

const ORDEN_TIPOS = [
  'etapa no coincide',
  'saldo no coincide',
  'pago sin tildar en la planilla',
  'tilde sin pago en tu Registro',
  'cuota inexistente en planilla',
  'cuotas no suman el total',
  'cuota sin fecha de vencimiento',
  'tarjeta duplicada',
  'sin tarjeta en el pipeline',
  'tarjeta sin planilla',
  'tarjeta sin email',
  'sin email en planilla',
  'pago sin cliente en planilla',
  'revisar a mano',
];

export function calcular({ madre = [], registro = [], tarjetas = [], hoy }) {
  const diferencias = [];
  const dif = (tipo, cliente, email, detalle) =>
    diferencias.push({ tipo, cliente: cliente || '', email: email || '', detalle });

  // ---- Red de seguridad: si las cuotas que se leen no suman el total del contrato, puede haber una cuota sin leer ----
  for (const r of madre) {
    if (String(r.reembolso ?? '').trim().toUpperCase() === 'SI') continue;
    const total = num(r.montoTotal);
    if (!total || total <= 0) continue;
    const suma = (r.cuotas || []).reduce((s, c) => s + (num(c && c.monto) ?? 0), 0);
    if (Math.abs(total - suma) > Math.max(1, total * 0.02)) {
      dif('cuotas no suman el total', r.nombre, normEmail(r.email), `El Monto total del contrato es ${usd(total)} y las cuotas que lee el tablero suman ${usd(suma)}. Puede haber una cuota que no se está leyendo o un monto mal cargado en la planilla de Mel.`);
    }
  }

  // ---- Planilla de Mel: una "inscripción" por fila, sin las reembolsadas ----
  const inscripciones = madre
    .filter((r) => String(r.reembolso ?? '').trim().toUpperCase() !== 'SI')
    .map((r) => {
      // Una cuota existe si tiene monto o fecha cargados (la columna "Cuotas" no es confiable).
      const cuotas = (r.cuotas || [])
        .filter((c) => c && (num(c.monto) !== null || c.vence))
        .map((c) => ({ n: c.n, monto: num(c.monto) ?? 0, vence: c.vence || null, pagada: !!c.pagada }))
        .sort((a, b) => a.n - b.n);
      const total = Math.max(cuotas.length, ...cuotas.map((c) => c.n), Number(r.declaradas) || 0);
      return { nombre: r.nombre || '', email: normEmail(r.email), cuotas, total };
    })
    .filter((i) => i.cuotas.length > 0);

  const porEmail = new Map();
  for (const i of inscripciones) {
    if (!i.email) continue;
    if (!porEmail.has(i.email)) porEmail.set(i.email, []);
    porEmail.get(i.email).push(i);
  }

  // ---- Pipeline: tarjetas por email ----
  const tarjetasPorEmail = new Map();
  for (const t of tarjetas) {
    const e = normEmail(t.email);
    if (!e) {
      dif('tarjeta sin email', t.nombre, '', `La tarjeta "${t.nombre}" (${t.etapa}) no tiene email en GHL, no se puede cruzar con la planilla.`);
      continue;
    }
    if (!tarjetasPorEmail.has(e)) tarjetasPorEmail.set(e, []);
    tarjetasPorEmail.get(e).push(t);
  }
  // Clientes que Mel cargó SIN email: no se pueden cruzar por email, así que se buscan en el pipeline por nombre.
  // Solo se miran tarjetas que no cruzaron con ningún cliente por email, y solo si el nombre coincide (o si el nombre cargado está
  // contenido en el de UNA sola tarjeta). Si hay dudas, no se une nada.
  const palabras = (n) => normNombre(n).split(' ').filter(Boolean);
  const tarjetasLibres = tarjetas.filter((t) => { const e = normEmail(t.email); return !e || !porEmail.has(e); });
  const tarjetaDeSinEmail = new Map(); // nombre normalizado -> tarjeta
  const tarjetasUsadasPorNombre = new Set();
  for (const i of inscripciones) {
    if (i.email) continue;
    const clave = normNombre(i.nombre);
    if (!clave || tarjetaDeSinEmail.has(clave)) continue;
    let candidatas = tarjetasLibres.filter((t) => normNombre(t.nombre) === clave);
    if (candidatas.length === 0) {
      const mias = palabras(i.nombre);
      if (mias.length >= 2) candidatas = tarjetasLibres.filter((t) => { const suyas = palabras(t.nombre); return mias.every((w) => suyas.includes(w)) || (suyas.length >= 2 && suyas.every((w) => mias.includes(w))); });
    }
    if (candidatas.length === 1) { tarjetaDeSinEmail.set(clave, candidatas[0]); tarjetasUsadasPorNombre.add(candidatas[0]); }
  }
  for (const [e, lista] of tarjetasPorEmail) {
    if (lista.length > 1) {
      dif('tarjeta duplicada', lista[0].nombre, e, `Hay ${lista.length} tarjetas para este cliente: ${lista.map((t) => t.etapa).join(' y ')}.`);
    }
    if (!porEmail.has(e) && !tarjetasUsadasPorNombre.has(lista[0])) {
      dif('tarjeta sin planilla', lista[0].nombre, e, `La tarjeta (${lista[0].etapa}) no tiene un cliente con ese email en la planilla de Mel.`);
    }
  }

  // ---- Cruce planilla vs pipeline, cliente por cliente ----
  const alertaPorEmail = new Set();
  for (const i of inscripciones) {
    if (i.email) continue;
    const pendientes = i.cuotas.filter((c) => !c.pagada && (!c.vence || c.vence >= INICIO_CONTROL));
    if (!pendientes.length) continue;
    const t = tarjetaDeSinEmail.get(normNombre(i.nombre));
    if (t) {
      dif('sin email en planilla', i.nombre, '', `Tiene cuotas pendientes pero no tiene email en la planilla de Mel. Se la encontró en el pipeline por nombre (${t.etapa}); cargale el email para cruzarla bien con GHL y con tu Registro.`);
    } else {
      dif('sin tarjeta en el pipeline', i.nombre, '', `Tiene ${pendientes.length} cuota(s) pendiente(s) desde septiembre en la planilla y no está en el pipeline. No tiene email en la planilla de Mel, por eso se buscó por nombre.`);
    }
  }
  for (const [email, filas] of porEmail) {
    const activas = filas.filter((f) => f.cuotas.some((c) => !c.pagada));
    const tarjs = tarjetasPorEmail.get(email) || [];
    const nombre = filas[0].nombre;

    if (activas.length > 1) {
      dif('revisar a mano', nombre, email, `Tiene ${activas.length} inscripciones con cuotas pendientes en la planilla, no se controla contra el pipeline.`);
      continue;
    }
    if (tarjs.length === 0) {
      const recientes = activas.length === 1 ? activas[0].cuotas.filter((c) => !c.pagada && (!c.vence || c.vence >= INICIO_CONTROL)) : [];
      if (recientes.length) {
        dif('sin tarjeta en el pipeline', nombre, email, `Tiene ${recientes.length} cuota(s) pendiente(s) desde septiembre en la planilla y no está en el pipeline.`);
      }
      continue;
    }
    if (tarjs.length > 1) continue; // ya avisado como duplicada

    const t = tarjs[0];
    const exp = etapaEsperada(t.etapa);
    const ref = activas[0] || (filas.length === 1 ? filas[0] : null);

    if (exp && ref) {
      if (exp.tipo === 'cuotas' && !etapaCoincide(exp, ref.cuotas)) {
        const lista = (a) => (a.length ? a.map((c) => c.n).join(', ') : 'ninguna');
        alertaPorEmail.add(email);
        dif('etapa no coincide', nombre, email, `Planilla de Mel: pagadas ${lista(ref.cuotas.filter((c) => c.pagada))}; sin pagar ${lista(ref.cuotas.filter((c) => !c.pagada))}. Pipeline: "${t.etapa}" (corresponde a ${exp.pagadas > 0 ? 'pagadas hasta la cuota ' + exp.pagadas : 'ninguna cuota pagada'}).`);
      }
      if (exp.tipo === 'completo' && activas.length > 0) {
        alertaPorEmail.add(email);
        dif('etapa no coincide', nombre, email, `Pipeline: "Plan completo", pero en la planilla de Mel faltan ${activas[0].cuotas.filter((c) => !c.pagada).length} cuota(s) por pagar.`);
      }
    }

    // El valor de la tarjeta debería ser lo que faltaba pagar (puede estar sin bajar si ya se cobró parte). Los clientes en
    // Pausado por impago o Incobrable se siguen en Deudores y no se controlan acá.
    if (activas.length === 1 && !['Plan completo', 'Inicio', 'Pausado por impago', 'Incobrable'].includes(String(t.etapa).trim())) {
      const valor = num(t.valor) ?? 0;
      const r = saldoCoincide(valor, activas[0].cuotas);
      if (!r.ok) {
        alertaPorEmail.add(email);
        dif('saldo no coincide', nombre, email, r.menor
          ? `La planilla de Mel dice que faltan ${usd(r.saldo)}. La tarjeta tiene ${usd(valor)}, menos de lo que falta.`
          : `La planilla de Mel dice que faltan ${usd(r.saldo)}. La tarjeta tiene ${usd(valor)}, que no coincide con lo que faltaba en ningún momento del plan (¿se cargó mal?).`);
      }
    }
  }

  // ---- Tu Registro de pagos ----
  const pagos = registro
    .map((p) => {
      const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(p.cuota ?? '').trim());
      return {
        cliente: p.cliente || '',
        email: normEmail(p.email),
        cuota: String(p.cuota ?? ''),
        n: m ? Number(m[1]) : null,
        total: m ? Number(m[2]) : null,
        monto: num(p.monto) ?? 0,
        fecha: p.fecha || null,
        medio: p.medio || '',
      };
    })
    .filter((p) => p.cliente || p.monto);

  for (const p of pagos) {
    if (!p.email || p.n == null) continue;
    const filas = porEmail.get(p.email);
    if (!filas) {
      dif('pago sin cliente en planilla', p.cliente, p.email, `Tu Registro tiene la cuota ${p.cuota}, pero ese email no está en la planilla de Mel.`);
      continue;
    }
    const candidatas = filas.map((f) => f.cuotas.find((c) => c.n === p.n)).filter(Boolean);
    if (!candidatas.length) {
      dif('cuota inexistente en planilla', p.cliente, p.email, `Tu Registro tiene la cuota ${p.cuota}, pero la planilla de Mel no tiene una cuota ${p.n} para este cliente.`);
    } else if (!candidatas.some((c) => c.pagada)) {
      dif('pago sin tildar en la planilla', p.cliente, p.email, `En tu Registro figura pagada la cuota ${p.cuota} (${p.fecha || 's/f'}), pero en la planilla de Mel no está tildada.`);
    }
  }

  // Tildes de la planilla sin pago en tu Registro (solo cuotas 2 en adelante, y desde que empieza tu Registro).
  const registroDesde = pagos.map((p) => p.fecha).filter(Boolean).sort()[0] || null;
  if (registroDesde) {
    const reg = new Set(pagos.filter((p) => p.email && p.n != null).map((p) => `${p.email}|${p.n}`));
    for (const [email, filas] of porEmail) {
      for (const f of filas) {
        for (const c of f.cuotas) {
          if (c.pagada && c.n >= 2 && c.vence && c.vence >= registroDesde && !reg.has(`${email}|${c.n}`)) {
            dif('tilde sin pago en tu Registro', f.nombre, email, `La planilla de Mel tiene tildada la cuota ${c.n} (vence ${c.vence}), pero no está en tu Registro de pagos.`);
          }
        }
      }
    }
  }

  // ---- Salida ----
  const etapaDe = (email) => {
    const l = tarjetasPorEmail.get(email);
    return l && l.length === 1 ? l[0].etapa : null;
  };
  // "cobrada" sale de TU Registro (lo que vos registrás). La cuota 1 se paga al entrar y no va
  // al Registro, así que para ella vale el check de Mel. Antes de que empiece tu Registro,
  // el check de Mel sirve de respaldo.
  const regPorEmail = new Set(pagos.filter((p) => p.email && p.n != null).map((p) => `${p.email}|${p.n}`));
  const regPorNombre = new Set(pagos.filter((p) => p.cliente && p.n != null).map((p) => `${normNombre(p.cliente)}|${p.n}`));
  const telPorEmail = new Map();
  for (const t of tarjetas) { const e = normEmail(t.email); if (e && t.telefono && !telPorEmail.has(e)) telPorEmail.set(e, String(t.telefono)); }
  const cuotas = [];
  for (const i of inscripciones) {
    // Una cuota sin fecha no puede aparecer en el calendario: se avisa para que no quede invisible (solo en clientes con actividad desde septiembre).
    const sinFecha = i.cuotas.filter((c) => !c.pagada && !c.vence && c.n >= 2 && c.monto > 0);
    const etapaI = i.email ? etapaDe(i.email) : null;
    if (sinFecha.length && etapaI !== 'Incobrable' && etapaI !== 'Pausado por impago' && i.cuotas.some((c) => c.vence && c.vence >= INICIO_CONTROL)) {
      dif('cuota sin fecha de vencimiento', i.nombre, i.email, `La cuota ${sinFecha.map((c) => c.n).join(' y ')} (${usd(sinFecha.reduce((t, c) => t + c.monto, 0))}) no tiene fecha de vencimiento en la planilla de Mel, así que no aparece en el calendario.`);
    }
    for (const c of i.cuotas) {
      const etapa = i.email ? etapaDe(i.email) : (tarjetaDeSinEmail.get(normNombre(i.nombre)) || {}).etapa || null;
      const enRegistro = i.email ? regPorEmail.has(`${i.email}|${c.n}`) : regPorNombre.has(`${normNombre(i.nombre)}|${c.n}`);
      const respaldoMel = c.pagada && (!c.vence || !registroDesde || c.vence < registroDesde);
      const cobrada = c.n === 1 ? c.pagada : enRegistro || respaldoMel;
      // El Registro y el check de Mel dicen cosas distintas (solo se mira desde que empieza el Registro).
      const desfasada = c.n >= 2 && !!c.vence && !!registroDesde && c.vence >= registroDesde && cobrada !== c.pagada;
      // Entra en los números y el calendario: cuotas 2 en adelante, y la cuota 1 solo si está sin pagar.
      // Lo que está en Incobrable no se cuenta (se sigue aparte).
      const seguimiento = (c.n >= 2 || !c.pagada) && etapa !== 'Incobrable';
      cuotas.push({
        cliente: i.nombre,
        email: i.email,
        telefono: i.email ? telPorEmail.get(i.email) || '' : '',
        n: c.n,
        total: i.total,
        monto: c.monto,
        vence: c.vence,
        pagada: c.pagada,
        cobrada,
        desfasada,
        seguimiento,
        etapa,
        alerta: i.email ? alertaPorEmail.has(i.email) : false,
      });
    }
  }
  cuotas.sort((a, b) => (a.vence || '9999').localeCompare(b.vence || '9999') || a.cliente.localeCompare(b.cliente));
  diferencias.sort(
    (a, b) =>
      ORDEN_TIPOS.indexOf(a.tipo) - ORDEN_TIPOS.indexOf(b.tipo) || a.cliente.localeCompare(b.cliente),
  );

  const porEtapa = {};
  for (const t of tarjetas) porEtapa[t.etapa] = (porEtapa[t.etapa] || 0) + 1;

  return { hoy, registroDesde, cuotas, pagos, diferencias, pipeline: { total: tarjetas.length, porEtapa } };
}
