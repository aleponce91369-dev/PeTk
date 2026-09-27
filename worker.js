export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/openrouter-summary' && request.method === 'POST') {
      return handleSummary(request, env);
    }
    if (url.pathname === '/openrouter-tags' && request.method === 'POST') {
      return handleTags(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

async function handleSummary(request, env) {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Falta OPENROUTER_API_KEY' }), { status: 500 });
  }

  let topic;
  try {
    ({ topic } = await request.json());
  } catch {
    return new Response(JSON.stringify({ error: 'Body inválido' }), { status: 400 });
  }

  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        messages: [
          {
            role: 'system',
            content: 'Sos un asistente que profundiza ideas breves e inspiradoras en un párrafo corto (máximo 80 palabras), en español, con tono reflexivo y claro.'
          },
          { role: 'user', content: `Profundizá la idea "${topic}".` }
        ],
        max_tokens: 220
      })
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = data?.error?.message || 'OpenRouter devolvió un error';
      return new Response(JSON.stringify({ error: msg }), { status: 502 });
    }
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary) {
      return new Response(JSON.stringify({ error: 'El modelo no devolvió texto' }), { status: 502 });
    }
    return new Response(JSON.stringify({ summary }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Error al conectar con OpenRouter' }), { status: 500 });
  }
}
async function handleTags(request, env) {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Falta OPENROUTER_API_KEY' }), { status: 500 });
  }

  let context;
  try {
    ({ context } = await request.json());
  } catch {
    return new Response(JSON.stringify({ error: 'Body inválido' }), { status: 400 });
  }

  const userPrompt = context
    ? `Generá 7 ideas breves e inspiradoras conectadas con "${context}", combinando algunas directamente relacionadas y otras que salten a temas distintos pero con algún hilo conceptual.`
    : 'Generá 7 ideas breves e inspiradoras, mezclando temas variados (filosofía, arte, ciencia, marketing, negocios, deportes, vida sana, tecnología) sin relación directa entre sí.';

  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        messages: [
          {
            role: 'system',
            content: 'Sos un generador de ideas breves e inspiradoras en español. Cada idea es una frase de 2 a 5 palabras, sin punto final. Devolvé ÚNICAMENTE un array JSON de strings, sin texto adicional ni markdown. Ejemplo: ["Idea uno","Idea dos","Idea tres"]'
          },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 250
      })
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = data?.error?.message || 'OpenRouter devolvió un error';
      return new Response(JSON.stringify({ error: msg }), { status: 502 });
    }

    const raw = data.choices?.[0]?.message?.content?.trim() || '';
    const match = raw.match(/\[[\s\S]*\]/);
    let tags = [];
    try {
      tags = JSON.parse(match ? match[0] : raw);
    } catch {
      tags = [];
    }
    tags = Array.isArray(tags)
      ? tags.map(t => String(t).trim()).filter(t => t && t.length <= 60).slice(0, 8)
      : [];

    if (tags.length === 0) {
      return new Response(JSON.stringify({ error: 'No se pudieron generar ideas' }), { status: 502 });
    }

    return new Response(JSON.stringify({ tags }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Error al conectar con OpenRouter' }), { status: 500 });
  }
}
