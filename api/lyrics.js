export default {
  async fetch(request) {
    const requestId = crypto.randomUUID();
    const incomingUrl = new URL(request.url);

    if (request.method !== 'GET') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    const type = incomingUrl.searchParams.get('type');
    if (type !== 'get' && type !== 'search') {
      return Response.json({ error: 'Invalid lyrics query type' }, { status: 400 });
    }

    const params = new URLSearchParams();
    const allowedParams = type === 'get'
      ? ['track_name', 'artist_name', 'album_name', 'duration']
      : ['track_name', 'artist_name'];
    for (const name of allowedParams) {
      const value = incomingUrl.searchParams.get(name);
      if (value) params.set(name, value);
    }
    if (!params.has('track_name') || !params.has('artist_name')) {
      return Response.json({ error: 'Track and artist are required' }, { status: 400 });
    }

    try {
      const upstream = await fetch(`https://lrclib.net/api/${type}?${params}`, {
        headers: { 'User-Agent': 'VersoSpotifyLyrics/1.0' },
        signal: AbortSignal.timeout(10000)
      });
      const body = await upstream.text();
      console.info(JSON.stringify({
        event: 'lyrics_provider_response',
        requestId,
        provider: 'lrclib',
        queryType: type,
        upstreamStatus: upstream.status
      }));
      return new Response(body, {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: 'lyrics_provider_error',
        requestId,
        provider: 'lrclib',
        queryType: type,
        errorName: error.name,
        errorMessage: error.message
      }));
      return Response.json({ error: 'Lyrics provider unavailable', requestId }, { status: 502 });
    }
  }
};
