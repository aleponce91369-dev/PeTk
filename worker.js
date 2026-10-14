const FREE = 3;          // presagios gratis por día
const PACK = 3;          // créditos por cada pack comprado
const PRICE = 2000;      // precio del pack en ARS
const IP_CAP = 12;       // tope de gratis por IP y por día
const TEMAS = ['el amor', 'el dinero', 'el destino', 'el trabajo', 'la energía y la salud', 'los sueños', 'el universo'];

const json = (o, s = 200, h = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...h } });

// Día en Argentina (UTC-3): los gratis se renuevan a medianoche local
const today = () => new Date(Date.now() - 3 * 36e5).toISOString().slice(0, 10);

function uidOf(req) {
  const m = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)pid=([a-f0-9-]{36})/);
  return m ? m[1] : crypto.randomUUID();
}
const ck = (uid) => ({ 'Set-Cookie': `pid=${uid}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` });

async function load(env, uid) {
  const u = (await env.CREDITS.get(`u:${uid}`, 'json')) || { paid: 0, day: today(), used: 0 };
  if (u.day !== today()) { u.day = today(); u.used = 0; }
  return u;
}
const save = (env, uid, u) => env.CREDITS.put(`u:${uid}`, JSON.stringify(u));
const view = (u) => ({ free: Math.max(0, FREE - u.used), paid: u.paid });

export default {
  async fetch(req, env) {
    const { pathname: p } = new URL(req.url);
    if (p === '/api/credits' && req.method === 'GET') return credits(req, env);
    if (p === '/api/presagio' && req.method === 'POST') return presagio(req, env);
    if (p === '/api/redeem' && req.method === 'POST') return redeem(req, env);
    return env.ASSETS.fetch(req);
  }
};

async function credits(req, env) {
  if (!env.CREDITS) return json({ error: 'Falta el KV CREDITS' }, 500);
  const uid = uidOf(req);
  return json(view(await load(env, uid)), 200, ck(uid));
}

async function presagio(req, env) {
  if (!env.OPENROUTER_API_KEY || !env.CREDITS) {
    return json({ error: 'Falta configurar OPENROUTER_API_KEY o el KV CREDITS' }, 500);
  }
  const uid = uidOf(req), h = ck(uid), u = await load(env, uid);
  const ipKey = `ip:${today()}:${req.headers.get('CF-Connecting-IP') || 'x'}`;
  const ipN = parseInt((await env.CREDITS.get(ipKey)) || '0', 10);

  const useFree = u.used < FREE && ipN < IP_CAP;
  if (!useFree && u.paid <= 0) return json({ error: 'no_credits', ...view(u) }, 402, h);

  const tema = TEMAS[Math.floor(Math.random() * TEMAS.length)];
  let text = '';
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/free',
        max_tokens: 700,
        temperature: 0.9,
        messages: [
          {
            role: 'system',
            content: 'Sos PresagIA, una vidente mística. Respondé en español rioplatense con el presagio del día: entre 50 y 70 palabras, en un solo párrafo, con tono de horóscopo enigmático y cálido. Incluí una imagen simbólica, una predicción y un consejo final. No uses títulos ni listas. Es entretenimiento: no hagas predicciones médicas, legales ni financieras concretas.'
          },
          { role: 'user', content: `Hoy es ${today()}. Dame mi presagio del día sobre ${tema}.` }
        ]
      })
    });
    const data = await r.json();
    text = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  } catch {}

  if (!text) return json({ error: 'Las estrellas están nubladas. Probá de nuevo: no se descontó ningún crédito.' }, 502, h);

  if (useFree) {
    u.used++;
    await env.CREDITS.put(ipKey, String(ipN + 1), { expirationTtl: 172800 });
  } else {
    u.paid--;
  }
  await save(env, uid, u);
  return json({ presagio: text, tema, credits: view(u) }, 200, h);
}

async function redeem(req, env) {
  if (!env.MP_ACCESS_TOKEN || !env.CREDITS) return json({ error: 'Falta MP_ACCESS_TOKEN o el KV CREDITS' }, 500);

  let op;
  try { ({ operation: op } = await req.json()); } catch { return json({ error: 'Body inválido' }, 400); }
  op = String(op || '').replace(/\D/g, '');
  if (op.length < 6 || op.length > 20) return json({ error: 'Número de operación inválido' }, 400);

  const uid = uidOf(req), h = ck(uid);
  if (await env.CREDITS.get(`pay:${op}`)) return json({ error: 'Esa operación ya fue canjeada' }, 409, h);

  const r = await fetch(`https://api.mercadopago.com/v1/payments/${op}`, {
    headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` }
  });
  if (!r.ok) return json({ error: 'No encontramos ese pago' }, 404, h);
  const pay = await r.json();

  // Si vendés otros productos con la misma cuenta, filtrá acá por el campo que identifique
  // tu link (description / external_reference) o usá un precio exclusivo.
  const packs = Math.floor((pay.transaction_amount || 0) / PRICE);
  if (pay.status !== 'approved' || pay.currency_id !== 'ARS' || packs < 1) {
    return json({ error: 'El pago no está aprobado o el monto no coincide' }, 400, h);
  }

  const u = await load(env, uid);
  u.paid += packs * PACK;
  await env.CREDITS.put(`pay:${op}`, uid);
  await save(env, uid, u);
  return json({ ok: true, ...view(u) }, 200, h);
}
