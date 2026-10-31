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

    const lines = Array.isArray(body.lines)
      ? body.lines.map(line => typeof line === 'string' ? line.trim() : '')
      : [];
    const targetLanguage = typeof body.targetLanguage === 'string' ? body.targetLanguage : '';
    if (!lines.length || lines.length > 3 || lines.some(line => !line || line.length > 500) || !supportedLanguages.has(targetLanguage)) {
      return Response.json({ error: 'Invalid text or target language' }, { status: 400 });
    }

    const requestId = crypto.randomUUID();
    const key = process.env.AZURE_TRANSLATOR_KEY;
    const region = process.env.AZURE_TRANSLATOR_REGION;
    const params = new URLSearchParams({ 'api-version': '3.0', to: targetLanguage });
    const fail = (reason, details = {}, status = 502) => {
      // Do not log the source text: lyric content is user data.
      console.error(JSON.stringify({ event: 'translation_provider_error', requestId, provider: 'azure_translator', reason, targetLanguage, lineCount: lines.length, textLength: lines.reduce((total, line) => total + line.length, 0), ...details }));
      return Response.json({ error: 'Translation provider unavailable', requestId }, { status });
    };
    if (!key) {
      return fail('missing_azure_translator_key', {}, 503);
    }
    try {
      const headers = {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': key
      };
      if (region) headers['Ocp-Apim-Subscription-Region'] = region;
      const upstream = await fetch(`https://api.cognitive.microsofttranslator.com/translate?${params}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(lines.map(line => ({ Text: line }))),
        signal: AbortSignal.timeout(10000)
      });
      if (!upstream.ok) {
        return fail('upstream_http_error', { upstreamStatus: upstream.status, upstreamStatusText: upstream.statusText }, upstream.status);
      }

      let data;
      try {
        data = await upstream.json();
      } catch (error) {
        return fail('invalid_upstream_json', { errorName: error.name, errorMessage: error.message });
      }
      const translations = Array.isArray(data)
        ? data.map(item => typeof item?.translations?.[0]?.text === 'string' ? item.translations[0].text.trim() : '')
        : [];
      if (translations.length !== lines.length || translations.some(line => !line)) {
        return fail('invalid_upstream_translation_response', { expectedLineCount: lines.length, translatedLineCount: translations.length });
      }
      return Response.json({ translations }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return fail(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'upstream_timeout' : 'upstream_fetch_error', {
        errorName: error.name,
        errorMessage: error.message
      });
    }
  }
};
