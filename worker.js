const FREE = 3, PACK = 3, PRICE = 2000, IP_CAP = 12;
const TEMAS = ['el amor', 'el dinero', 'el destino', 'el trabajo', 'la energía y la salud', 'los sueños', 'el universo'];
const SIGNOS = ['Aries', 'Tauro', 'Géminis', 'Cáncer', 'Leo', 'Virgo', 'Libra', 'Escorpio', 'Sagitario', 'Capricornio', 'Acuario', 'Piscis'];

const json = (o, s = 200, h = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...h } });
const today = () => new Date(Date.now() - 3 * 36e5).toISOString().slice(0, 10); // día argentino (UTC-3)
const ipOf = (req) => req.headers.get('CF-Connecting-IP') || 'x';

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
const view = (u) => ({
  free: Math.max(0, FREE - u.used),
  paid: u.paid,
  code: u.code || null,
  last: u.last && u.last.day === today() ? u.last : null
});

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const x of crypto.getRandomValues(new Uint8Array(8))) s += A[x % 32];
  return s.slice(0, 4) + '-' + s.slice(4);
}

export default {
  async fetch(req, env) {
    const { pathname: p } = new URL(req.url);
    const post = req.method === 'POST';
    if (p === '/api/credits' && req.method === 'GET') return credits(req, env);
    if (p === '/api/presagio' && post) return presagio(req, env);
    if (p === '/api/redeem' && post) return redeem(req, env);
    if (p === '/api/recover' && post) return recover(req, env);
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
  let signo;
  try { ({ signo } = await req.json()); } catch {}
  if (!SIGNOS.includes(signo)) return json({ error: 'Elegí tu signo primero ✦' }, 400);

  const uid = uidOf(req), h = ck(uid), u = await load(env, uid);
  const ipKey = `ip:${today()}:${ipOf(req)}`;
  const ipN = parseInt((await env.CREDITS.get(ipKey)) || '0', 10);
  const useFree = u.used < FREE && ipN < IP_CAP;
  if (!useFree && u.paid <= 0) return json({ error: 'no_credits', ...view(u) }, 402, h);

  const tema = TEMAS[Math.floor(Math.random() * TEMAS.length)];
  let text = '', detail = '';
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/free',
        max_tokens: 500,
        temperature: 0.9,
        messages: [
          {
            role: 'system',
            content: 'Sos PresagIA, una vidente mística. Respondé en español rioplatense con el presagio del día para el signo indicado: entre 50 y 70 palabras, en un solo párrafo, tono de horóscopo enigmático y cálido. Incluí una imagen simbólica, una predicción y un consejo final. Sin títulos ni listas. Es entretenimiento: no hagas predicciones médicas, legales ni financieras concretas.'
          },
          { role: 'user', content: `Hoy es ${today()}. Presagio del día para ${signo}, sobre ${tema}.` }
        ]
      })
    });
    const data = await r.json();
    text = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!text) detail = `OpenRouter ${r.status}: ${data.error?.message || 'respuesta vacía'}`;
  } catch (e) { detail = String(e); }

  if (!text) {
    return json({ error: 'Las estrellas están nubladas. Probá de nuevo: no se descontó ningún crédito.', detail }, 502, h);
  }
  if (useFree) {
    u.used++;
    await env.CREDITS.put(ipKey, String(ipN + 1), { expirationTtl: 172800 });
  } else {
    u.paid--;
  }
  u.last = { day: today(), signo, tema, text };
  await save(env, uid, u);
  return json({ presagio: text, tema, signo, credits: view(u) }, 200, h);
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

  // Si vendés otros productos con esta cuenta, filtrá acá por description / external_reference o usá un precio exclusivo.
  const packs = Math.floor((pay.transaction_amount || 0) / PRICE);
  if (pay.status !== 'approved' || pay.currency_id !== 'ARS' || packs < 1) {
    return json({ error: 'El pago no está aprobado o el monto no coincide' }, 400, h);
  }

  const u = await load(env, uid);
  u.paid += packs * PACK;
  if (!u.code) { u.code = newCode(); await env.CREDITS.put(`code:${u.code}`, uid); }
  await env.CREDITS.put(`pay:${op}`, uid);
  await save(env, uid, u);
  return json({ ok: true, ...view(u) }, 200, h);
}

// Recupera la cuenta (y los créditos comprados) en otro dispositivo con el código
async function recover(req, env) {
  if (!env.CREDITS) return json({ error: 'Falta el KV CREDITS' }, 500);
  const k = `rc:${ipOf(req)}`;
  const n = parseInt((await env.CREDITS.get(k)) || '0', 10);
  if (n >= 10) return json({ error: 'Demasiados intentos. Probá en una hora.' }, 429);
  await env.CREDITS.put(k, String(n + 1), { expirationTtl: 3600 });

  let code;
  try { ({ code } = await req.json()); } catch { return json({ error: 'Body inválido' }, 400); }
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  code = code.slice(0, 4) + '-' + code.slice(4);
  const uid = await env.CREDITS.get(`code:${code}`);
  if (!uid) return json({ error: 'Código no encontrado' }, 404);
  return json({ ok: true, ...view(await load(env, uid)) }, 200, ck(uid));
}
