export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/openrouter-summary' && request.method === 'POST') {
      return handleSummary(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};

async function handleSummary(request, env) {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Falta OPENROUTER_API_KEY' }), { status: 500 });
  }

  let topic, category;
  try {
    ({ topic, category } = await request.json());
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
        model: 'openrouter/free',
        messages: [
          {
            role: 'system',
            content: 'Sos un asistente que profundiza ideas breves e inspiradoras en un párrafo corto (máximo 80 palabras), en español, con tono reflexivo y claro.'
          },
          { role: 'user', content: `Profundizá la idea "${topic}" (tema: ${category}).` }
        ],
        max_tokens: 220
      })
    });

    const data = await r.json();
    const summary = data.choices?.[0]?.message?.content?.trim() || 'Sin respuesta de la IA.';
    return new Response(JSON.stringify({ summary }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Error al conectar con OpenRouter' }), { status: 500 });
  }
}
