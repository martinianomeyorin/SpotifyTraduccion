const supportedLanguages = new Set(['es', 'en', 'pt', 'fr', 'it', 'de', 'ja', 'ko']);

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const targetLanguage = typeof body.targetLanguage === 'string' ? body.targetLanguage : '';
    if (!text || text.length > 500 || !supportedLanguages.has(targetLanguage)) {
      return Response.json({ error: 'Invalid text or target language' }, { status: 400 });
    }

    const params = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: targetLanguage, dt: 't', q: text });
    try {
      const upstream = await fetch(`https://translate.googleapis.com/translate_a/single?${params}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 Verso/1.0' },
        signal: AbortSignal.timeout(10000)
      });
      if (!upstream.ok) {
        return Response.json({ error: 'Translation provider unavailable' }, { status: 502 });
      }

      const data = await upstream.json();
      const translation = (data[0] || []).map(part => part[0]).join('').trim();
      if (!translation) {
        return Response.json({ error: 'Empty translation' }, { status: 502 });
      }
      return Response.json({ translation }, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return Response.json({ error: 'Translation provider unavailable' }, { status: 502 });
    }
  }
};
