const $ = (selector) => document.querySelector(selector);
const state = { token: null, expiresAt: 0, trackId: null, deviceId: null, lines: [], currentIndex: -1, polling: null, renderTimer: null, toastTimer: null, playback: null, pollInFlight: false, targetLanguage: 'es', translationRun: 0, searchTimer: null, searchRun: 0, searchResults: [] };
const storageKey = 'verso.spotify';
const lyricSizeKey = 'verso.lyrics-font-size';
const lyricHeightKey = 'verso.lyrics-panel-height';
const targetLanguageKey = 'verso.target-language';
const supportedLanguages = new Set(['es', 'en', 'pt', 'fr', 'it', 'de', 'ja', 'ko']);

function notify(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}
function formatTime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; }
}
function saveSettings(settings) {
  localStorage.setItem(storageKey, JSON.stringify(settings));
}
function setLyricsFontSize(value) {
  const size = Math.max(14, Math.min(30, Number(value) || 16));
  document.documentElement.style.setProperty('--lyrics-font-size', `${size}px`);
  $('#fontSizeSlider').value = String(size);
  $('#fontSizeOutput').textContent = `${size} px`;
  localStorage.setItem(lyricSizeKey, String(size));
  if (state.lines.length) renderLyrics(state.currentIndex);
}
function setLyricsPanelHeight(value) {
  const maxHeight = Math.max(220, Math.floor(window.innerHeight * 0.75));
  const height = Math.max(220, Math.min(maxHeight, Number(value) || 266));
  $('#lyricsPanel').style.height = `${height}px`;
  $('#lyricsResizeHandle').setAttribute('aria-valuenow', String(height));
  $('#lyricsResizeHandle').setAttribute('aria-valuemax', String(maxHeight));
  localStorage.setItem(lyricHeightKey, String(height));
  if (state.lines.length) renderLyrics(state.currentIndex);
}
function setTargetLanguage(language) {
  state.targetLanguage = supportedLanguages.has(language) ? language : 'es';
  $('#targetLanguage').value = state.targetLanguage;
  localStorage.setItem(targetLanguageKey, state.targetLanguage);
  if (state.lines.length) translateCurrentLyrics();
}
function currentRedirectUri() {
  return `${location.origin}/callback`;
}
function configuredRedirectUri(settings) {
  const saved = settings.redirectUri || '';
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const savedIsLocal = /^http:\/\/(localhost|127\.0\.0\.1):8888\/callback\/?$/i.test(saved);
  return isLocal && savedIsLocal ? saved : currentRedirectUri();
}
function parseLrc(lrc) {
  const result = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const regex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
    let match;
    const timestamps = [];
    while ((match = regex.exec(raw))) {
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
      timestamps.push(Number(match[1]) * 60 + Number(match[2]) + fraction);
    }
    const lyric = raw.replace(/\[[^\]]+\]/g, '').trim();
    for (const time of timestamps) result.push({ time, original: lyric, translation: '' });
  }
  return result.sort((a, b) => a.time - b.time);
}
async function fetchLyrics(track) {
  const params = new URLSearchParams({ track_name: track.name, artist_name: track.artists?.map(a => a.name).join(', ') || '', album_name: track.album?.name || '', duration: String(Math.round(track.duration_ms / 1000)) });
  try {
    const response = await fetch(`https://lrclib.net/api/get?${params}`);
    if (!response.ok) throw new Error('no sincronizada');
    const data = await response.json();
    if (!data.syncedLyrics) throw new Error('sin tiempos');
    return { lines: parseLrc(data.syncedLyrics), source: 'LRCLIB' };
  } catch {
    // Fallback: search by title and artist in case the album/version metadata differs.
    try {
      const search = new URLSearchParams({ track_name: track.name, artist_name: track.artists?.map(a => a.name).join(', ') || '' });
      const response = await fetch(`https://lrclib.net/api/search?${search}`);
      const results = await response.json();
      const match = results.find(item => item.syncedLyrics);
      if (match) return { lines: parseLrc(match.syncedLyrics), source: 'LRCLIB' };
    } catch { /* A graceful empty state is shown below. */ }
    return { lines: [], source: 'LRCLIB' };
  }
}
async function translateLines(lines, targetLanguage, runId) {
  const nonEmpty = lines.filter(line => line.original);
  if (!nonEmpty.length) return;
  // Google Translate's free web endpoint accepts multiple sentences. Keep batches small and
  // preserve one result per source line so timestamps remain attached to the right phrase.
  for (let start = 0; start < nonEmpty.length; start += 12) {
    const batch = nonEmpty.slice(start, start + 12);
    await Promise.all(batch.map(async line => {
      try {
        const params = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: targetLanguage, dt: 't', q: line.original });
        const response = await fetch(`https://translate.googleapis.com/translate_a/single?${params}`);
        if (!response.ok) throw new Error('translate');
        const data = await response.json();
        if (runId !== state.translationRun) return;
        line.translation = (data[0] || []).map(part => part[0]).join('').trim();
      } catch { if (runId === state.translationRun) line.translation = ''; }
    }));
  }
}
function translateCurrentLyrics() {
  const runId = ++state.translationRun;
  const lines = state.lines;
  for (const line of lines) line.translation = '';
  renderLyrics(state.currentIndex);
  translateLines(lines, state.targetLanguage, runId).then(() => {
    if (runId === state.translationRun) renderLyrics(state.currentIndex);
  });
}
function renderLyrics(index) {
  const panel = $('#lyricsInner');
  if (!state.lines.length) {
    panel.innerHTML = '<div class="lyric-line past">Las letras sincronizadas se buscan gratis</div><div class="lyric-line current"><span class="lyric-original">No encontramos una letra con tiempos</span><span class="lyric-translation">Probá con otra versión de la canción</span></div><div class="lyric-line future">Hay canciones que todavía no tienen letra en LRCLIB</div>';
    return;
  }
  if (index < 0) {
    const next = state.lines.find(line => line.original);
    panel.innerHTML = `<div class="lyric-line past">♪</div><div class="lyric-line current"><span class="lyric-original">La letra aparece cuando empieza a sonar</span><span class="lyric-translation">${next ? 'Esperando el primer verso…' : 'Buscando letra sincronizada…'}</span></div><div class="lyric-line future">♪</div>`;
    return;
  }
  const current = Math.max(0, Math.min(index, state.lines.length - 1));
  const items = [];
  const panelHeight = $('#lyricsPanel').getBoundingClientRect().height || 266;
  const fontSize = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lyrics-font-size')) || 16;
  const visibleRows = Math.max(4, Math.floor((panelHeight - 80) / (fontSize * 1.5 + 17)));
  const before = Math.floor((visibleRows - 1) / 2);
  const after = visibleRows - before - 1;
  for (let i = current - before; i <= current + after; i++) {
    if (i < 0 || i >= state.lines.length) continue;
    const line = state.lines[i];
    const type = i === current ? 'current' : i < current ? 'past' : 'future';
    items.push(`<div class="lyric-line ${type}${i > current + 1 ? ' dim' : ''}" data-line-index="${i}" role="button" tabindex="0" aria-label="Ir a ${formatTime(line.time * 1000)}: ${escapeHtml(line.original || 'instrumental') }" title="Ir a ${formatTime(line.time * 1000)}">${i === current ? `<span class="lyric-original">${escapeHtml(line.original || '♪')}</span><span class="lyric-translation">${escapeHtml(line.translation || (line.original ? 'Traduciendo…' : '♪'))}</span>` : escapeHtml(line.original || '♪')}</div>`);
  }
  panel.innerHTML = items.join('');
}
function updateCurrentLine(progressMs) {
  if (!state.lines.length) return;
  const seconds = progressMs / 1000;
  let low = 0, high = state.lines.length - 1, best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (state.lines[mid].time <= seconds) { best = mid; low = mid + 1; } else high = mid - 1;
  }
  if (best !== state.currentIndex) { state.currentIndex = best; renderLyrics(best); }
}
async function seekToLyric(index) {
  const line = state.lines[index];
  if (!line) return;
  if (!state.token) return notify('Conectá Spotify para saltar a esta línea.');
  const positionMs = Math.max(0, Math.round(line.time * 1000));
  try {
    const params = new URLSearchParams({ position_ms: String(positionMs) });
    if (state.deviceId) params.set('device_id', state.deviceId);
    await spotifyRequest(`/me/player/seek?${params}`, 'PUT');
    if (state.playback) {
      state.playback.progressMs = positionMs;
      state.playback.receivedAt = performance.now();
      updateProgress(positionMs, state.playback.duration);
    }
  } catch (error) {
    if (!error.status) {
      const confirmed = await confirmSeek(positionMs);
      if (confirmed) {
        if (state.playback) {
          state.playback.progressMs = positionMs;
          state.playback.receivedAt = performance.now();
          updateProgress(positionMs, state.playback.duration);
        }
        return;
      }
      return notify('Spotify pudo recibir el salto, pero no confirmó la posición. Revisá el progreso de la canción.');
    }
    if (error.status === 403) notify('Spotify rechazó el salto. Esta función requiere Premium y un dispositivo activo.');
    else if (error.status === 404 && /active device|device not found/i.test(`${error.message} ${error.reason || ''}`)) notify('Spotify no encontró el dispositivo activo. Abrí Spotify y volvé a tocar la línea.');
    else if (error.status === 404) notify('Spotify respondió 404 al saltar, pero no informó que faltara un dispositivo.');
    else if (error.status === 401) notify('La conexión con Spotify venció. Volvé a conectar tu cuenta.');
    else if (error.status === 429) notify('Spotify está recibiendo muchas solicitudes. Esperá unos segundos y probá de nuevo.');
    else notify('No pudimos comunicarnos con Spotify. Revisá tu conexión e intentá otra vez.');
  }
}
async function confirmSeek(positionMs) {
  await new Promise(resolve => setTimeout(resolve, 650));
  try {
    const playback = await spotifyRequest('/me/player/currently-playing');
    if (playback?.device?.id) state.deviceId = playback.device.id;
    return playback?.item?.id === state.trackId && Number.isFinite(playback?.progress_ms)
      && Math.abs(playback.progress_ms - positionMs) <= 5000;
  } catch { return false; }
}
function updateProgress(progress, duration) {
  $('#currentTime').textContent = formatTime(progress);
  $('#duration').textContent = formatTime(duration);
  const percent = duration ? Math.min(100, progress / duration * 100) : 0;
  $('#progressFill').style.width = `${percent}%`;
  $('#progressThumb').style.left = `${percent}%`;
  updateCurrentLine(progress);
}
function estimatedProgress() {
  if (!state.playback) return 0;
  const elapsed = state.playback.isPlaying ? performance.now() - state.playback.receivedAt : 0;
  return Math.min(state.playback.duration, Math.max(0, state.playback.progressMs + elapsed));
}
function setTrack(track, isPlaying, progress) {
  $('#trackName').textContent = track.name;
  $('#trackArtist').textContent = track.artists?.map(a => a.name).join(' · ') || 'Spotify';
  $('#trackState').textContent = isPlaying ? 'REPRODUCIENDO AHORA' : 'EN PAUSA';
  $('#playBtn').textContent = isPlaying ? 'Ⅱ' : '▶';
  $('#playerNote').textContent = isPlaying ? 'Siguiendo el ritmo de tu reproducción' : 'Tu música está en pausa';
  $('#albumArt').style.backgroundImage = track.album?.images?.[0]?.url ? `linear-gradient(90deg,#1115,#1110),url("${track.album.images[0].url}")` : '';
  $('#albumArt').style.backgroundSize = 'cover';
  $('#albumArt').style.backgroundPosition = 'center';
  state.playback = { progressMs: progress, receivedAt: performance.now(), duration: track.duration_ms, isPlaying };
  updateProgress(progress, track.duration_ms);
}
async function loadTrack(track, isPlaying, progress) {
  setTrack(track, isPlaying, progress);
  if (state.trackId === track.id) return;
  state.translationRun++;
  state.trackId = track.id;
  state.currentIndex = -1;
  $('#lyricsSource').textContent = 'LETRAS: BUSCANDO…';
  const result = await fetchLyrics(track);
  if (state.trackId !== track.id) return;
  state.lines = result.lines;
  $('#lyricsSource').textContent = `LETRAS: ${result.source}`;
  if (!state.lines.length) { renderLyrics(0); return; }
  translateCurrentLyrics();
  updateCurrentLine(progress);
}
async function spotifyRequest(path, method = 'GET', body = null) {
  if (!state.token || Date.now() > state.expiresAt) { const error = new Error('La sesión de Spotify venció'); error.status = 401; throw error; }
  const headers = { Authorization: `Bearer ${state.token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`https://api.spotify.com/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (response.status === 204) return null;
  if (response.status === 401) { state.token = null; const error = new Error('La sesión de Spotify venció'); error.status = response.status; throw error; }
  if (!response.ok) {
    let details = {};
    try { details = await response.json(); } catch {}
    const error = new Error(details?.error?.message || `Spotify respondió ${response.status}`);
    error.status = response.status;
    error.reason = details?.error?.reason;
    throw error;
  }
  return response.json();
}
function renderSearchMessage(message, kind = '') {
  const connect = kind === 'search-hint' ? '<button class="search-connect" type="button" data-search-connect>Conectar Spotify</button>' : '';
  $('#songSearchResults').innerHTML = `<div class="search-empty ${kind}">${escapeHtml(message)}${connect}</div>`;
}
function setSearchStatus(message, kind = '', track = null) {
  const status = $('#songSearchStatus');
  status.replaceChildren();
  status.hidden = !message;
  status.dataset.state = kind;
  if (!message) return;
  const text = document.createElement('span');
  text.textContent = message;
  status.append(text);
  if (track?.id) {
    const link = document.createElement('a');
    link.href = `https://open.spotify.com/track/${encodeURIComponent(track.id)}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Abrir en Spotify';
    status.append(link);
  }
}
async function searchSongs(query) {
  const term = query.trim();
  const run = ++state.searchRun;
  setSearchStatus('');
  if (!term) { state.searchResults = []; return renderSearchMessage('Escribí para buscar canciones.'); }
  if (!state.token) return renderSearchMessage('Conectá Spotify para buscar en su catálogo.', 'search-hint');
  renderSearchMessage('Buscando canciones…', 'search-loading');
  const params = new URLSearchParams({ q: term, type: 'track', limit: '10' });
  try {
    const result = await spotifyRequest(`/search?${params}`);
    if (run !== state.searchRun) return;
    state.searchResults = result.tracks?.items || [];
    if (!state.searchResults.length) return renderSearchMessage('No encontramos canciones con esa búsqueda.');
    $('#songSearchResults').innerHTML = state.searchResults.map((track, index) => {
      const image = track.album?.images?.[2]?.url || track.album?.images?.[0]?.url || '';
      const artists = track.artists?.map(artist => artist.name).join(', ') || 'Artista desconocido';
      const disabled = track.is_playable === false;
      return `<button class="search-result" type="button" role="option" aria-selected="false" data-search-index="${index}"${disabled ? ' disabled' : ''}><span class="search-art">${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy"/>` : '<span aria-hidden="true">♪</span>'}</span><span class="search-track-copy"><strong>${escapeHtml(track.name)}</strong><span>${escapeHtml(artists)}</span><small>${escapeHtml(track.album?.name || 'Single')} · ${escapeHtml(track.album?.release_date?.slice(0, 4) || '')}</small></span><span class="search-play" aria-hidden="true">${disabled ? '—' : '▶'}</span></button>`;
    }).join('');
  } catch (error) {
    if (run !== state.searchRun) return;
    if (error.status === 401) renderSearchMessage('La conexión con Spotify venció. Cerrá esta ventana y volvé a conectar tu cuenta.', 'search-error');
    else if (error.status === 429) renderSearchMessage('Spotify recibió muchas búsquedas. Esperá un momento y probá de nuevo.', 'search-error');
    else renderSearchMessage('No pudimos buscar en Spotify. Revisá la conexión e intentá otra vez.', 'search-error');
  }
}
async function playSearchResult(index) {
  const track = state.searchResults[index];
  if (!track) return;
  if (!state.token) return setSearchStatus('Conectá Spotify para reproducir esta canción.', 'error');
  if (track.is_playable === false) return setSearchStatus('Esta canción no está disponible para reproducir en tu región.', 'error', track);
  setSearchStatus(`Conectando con Spotify para reproducir “${track.name}”…`, 'loading');
  $('#songSearchResults').querySelectorAll('.search-result').forEach(result => { result.disabled = true; });
  try {
    const available = await spotifyRequest('/me/player/devices');
    const devices = available?.devices || [];
    const targetDevice = devices.find(device => device.is_active && device.id && !device.is_restricted)
      || devices.find(device => device.type === 'computer' && device.id && !device.is_restricted)
      || devices.find(device => device.id && !device.is_restricted);
    if (!targetDevice) {
      $('#songSearchResults').querySelectorAll('.search-result').forEach(result => { result.disabled = false; });
      const listed = devices.map(device => `${device.name || device.type}${device.is_restricted ? ' (restringido)' : ''}`).join(', ');
      return setSearchStatus(listed ? `Spotify muestra estos dispositivos, pero ninguno acepta controles: ${listed}.` : 'Spotify no está mostrando dispositivos controlables para esta cuenta. Abrí Spotify en esta computadora y dejalo activo.', 'error', track);
    }
    state.deviceId = targetDevice.id;
    setSearchStatus(`Activando ${targetDevice.name || 'tu dispositivo'} para reproducir “${track.name}”…`, 'loading');
    // Selecting a Connect device as `device_id` in /play does not always
    // switch Spotify's active output. Transfer it explicitly first, then
    // start the chosen URI on that device.
    await spotifyRequest('/me/player', 'PUT', { device_ids: [targetDevice.id], play: true });
    await new Promise(resolve => setTimeout(resolve, 700));
    setSearchStatus(`Iniciando “${track.name}” en ${targetDevice.name || 'tu dispositivo'}…`, 'loading');
    await spotifyRequest(`/me/player/play?device_id=${encodeURIComponent(targetDevice.id)}`, 'PUT', { uris: [track.uri] });
    let confirmed = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 600));
      const playback = await spotifyRequest('/me/player/currently-playing');
      if (playback?.device?.id) state.deviceId = playback.device.id;
      const matchesTrack = playback?.item?.id === track.id || playback?.item?.linked_from?.id === track.id;
      if (matchesTrack && playback.is_playing) { confirmed = playback; break; }
    }
    if (!confirmed) {
      const [playerResult, deviceResult] = await Promise.allSettled([
        spotifyRequest('/me/player'),
        spotifyRequest('/me/player/devices')
      ]);
      const actual = playerResult.status === 'fulfilled' ? playerResult.value : null;
      const devices = deviceResult.status === 'fulfilled' ? deviceResult.value?.devices || [] : [];
      const currentName = actual?.item?.name;
      const playerState = actual
        ? `${actual.is_playing ? 'reproduciendo' : 'en pausa'}${currentName ? ` “${currentName}”` : ''}${actual.device?.name ? ` en ${actual.device.name}${actual.device.is_active ? ' (activo)' : ' (inactivo)'}` : ''}`
        : playerResult.status === 'fulfilled' ? 'Spotify no informa una reproducción activa (GET /me/player respondió sin datos)' : 'no se pudo consultar GET /me/player';
      const deviceState = devices.length
        ? devices.map(device => `${device.name || device.type || 'Dispositivo'}${device.is_active ? ' (activo)' : ''}${device.is_restricted ? ' (restringido)' : ''}`).join(', ')
        : deviceResult.status === 'fulfilled' ? 'Spotify no listó dispositivos' : 'no se pudo consultar la lista de dispositivos';
      $('#songSearchResults').querySelectorAll('.search-result').forEach(result => { result.disabled = false; });
      return setSearchStatus(`Spotify aceptó la orden, pero no confirmó “${track.name}”. Estado: ${playerState}. Dispositivos: ${deviceState}.`, 'error', track);
    }
    $('#songSearchDialog').close();
    await loadTrack(confirmed.item, confirmed.is_playing, confirmed.progress_ms || 0);
    notify(`Reproduciendo: ${track.name}`);
  } catch (error) {
    $('#songSearchResults').querySelectorAll('.search-result').forEach(result => { result.disabled = false; });
    if (error.status === 403) setSearchStatus('Spotify rechazó la reproducción (403). Revisá Premium y los permisos de la app.', 'error', track);
    else if (error.status === 404) setSearchStatus('Spotify no encontró ese dispositivo. Cerrá y volvé a abrir Spotify para actualizar la lista.', 'error', track);
    else if (!error.status) setSearchStatus('No pudimos comunicarnos con Spotify. Revisá la conexión y probá otra vez.', 'error', track);
    else setSearchStatus(`Spotify no inició la canción (${error.status}): ${error.message}`, 'error', track);
  }
}
async function pollSpotify() {
  if (!state.token || state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    const data = await spotifyRequest('/me/player/currently-playing');
    if (data?.item) {
      state.deviceId = data.device?.id || null;
      $('.source-chip').classList.add('connected');
      $('#sourceLabel').textContent = 'SPOTIFY CONECTADO';
      await loadTrack(data.item, data.is_playing, data.progress_ms || 0);
    } else {
      $('#trackState').textContent = 'ESPERANDO MÚSICA';
      $('#playerNote').textContent = 'Reproducí algo en Spotify';
    }
  } catch (error) {
    if (/venció/.test(error.message)) {
      state.token = null;
      $('#sourceLabel').textContent = 'SESIÓN VENCIDA';
      $('.source-chip').classList.remove('connected');
      $('#connectBtn').textContent = 'Conectar Spotify';
      clearInterval(state.polling);
      notify('La sesión de Spotify venció. Volvé a conectar.');
    }
  } finally {
    state.pollInFlight = false;
  }
}
function startPolling() {
  clearInterval(state.polling);
  clearInterval(state.renderTimer);
  pollSpotify();
  state.polling = setInterval(pollSpotify, 2500);
  state.renderTimer = setInterval(() => {
    if (state.playback) updateProgress(estimatedProgress(), state.playback.duration);
  }, 100);
}
function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}
async function connectSpotify() {
  const settings = loadSettings();
  const clientId = $('#clientId').value.trim() || settings.clientId;
  const redirectUri = $('#redirectUri').value.trim() || settings.redirectUri || `${location.origin}/callback`;
  $('#settingsError').textContent = '';
  if (!clientId) { $('#settingsError').textContent = 'Ingresá el Client ID de tu app de Spotify.'; return; }
  if (location.protocol === 'file:') { $('#settingsError').textContent = 'Abrí el proyecto con un servidor local para conectar Spotify (ver README).'; return; }
  saveSettings({ clientId, redirectUri });
  const verifier = randomString(64);
  const challenge = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challengeBase64 = btoa(String.fromCharCode(...new Uint8Array(challenge))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const authState = randomString(24);
  sessionStorage.setItem('verso.pkce', JSON.stringify({ verifier, authState, redirectUri }));
  const params = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: 'user-read-currently-playing user-read-playback-state user-modify-playback-state', state: authState, code_challenge_method: 'S256', code_challenge: challengeBase64 });
  location.assign(`https://accounts.spotify.com/authorize?${params}`);
}
async function handleCallback() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return;
  const saved = JSON.parse(sessionStorage.getItem('verso.pkce') || '{}');
  const returnedState = params.get('state');
  if (!saved.verifier || returnedState !== saved.authState) { notify('No se pudo validar el inicio de sesión. Probá de nuevo.'); history.replaceState({}, '', location.pathname); return; }
  const { clientId } = loadSettings();
  const form = new URLSearchParams({ client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: saved.redirectUri, code_verifier: saved.verifier });
  try {
    const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error_description || 'Spotify no pudo iniciar sesión');
    state.token = data.access_token;
    state.expiresAt = Date.now() + data.expires_in * 1000;
    sessionStorage.removeItem('verso.pkce');
    history.replaceState({}, '', location.pathname);
    $('#connectBtn').textContent = 'Spotify conectado';
    $('#sourceLabel').textContent = 'SPOTIFY CONECTADO';
    $('.source-chip').classList.add('connected');
    $('#settingsDialog').close();
    notify('¡Listo! Esperando lo que suena en Spotify.');
    startPolling();
  } catch (error) { history.replaceState({}, '', location.pathname); $('#settingsError').textContent = error.message; $('#settingsDialog').showModal(); }
}
function initAmbientWaves() {
  const canvas = $('#ambientWaves');
  const panel = $('#lyricsPanel');
  const context = canvas?.getContext('2d');
  if (!canvas || !panel || !context) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0;
  let height = 0;
  let frame = 0;
  let phase = 0;
  const waves = [
    { y: 0.48, amplitude: 13, frequency: 0.012, speed: 0.0024, color: 'rgba(206,250,120,.12)' },
    { y: 0.57, amplitude: 18, frequency: 0.009, speed: -0.0018, color: 'rgba(185,165,255,.09)' },
    { y: 0.66, amplitude: 11, frequency: 0.015, speed: 0.0014, color: 'rgba(206,250,120,.07)' },
  ];

  function resize() {
    const bounds = panel.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    width = bounds.width;
    height = bounds.height;
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    draw();
  }

  function draw() {
    context.clearRect(0, 0, width, height);
    for (const wave of waves) {
      context.beginPath();
      for (let x = 0; x <= width; x += 4) {
        const y = height * wave.y + Math.sin(x * wave.frequency + phase * wave.speed) * wave.amplitude
          + Math.sin(x * wave.frequency * 0.47 - phase * wave.speed * 1.4) * wave.amplitude * 0.42;
        if (x === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.strokeStyle = wave.color;
      context.lineWidth = 1.2;
      context.stroke();
    }
  }

  function animate() {
    cancelAnimationFrame(frame);
    draw();
    if (!reducedMotion.matches && !document.hidden) {
      phase += 1;
      frame = requestAnimationFrame(animate);
    }
  }

  new ResizeObserver(resize).observe(panel);
  reducedMotion.addEventListener('change', animate);
  document.addEventListener('visibilitychange', animate);
  resize();
  animate();
}

function setup() {
  initAmbientWaves();
  const settings = loadSettings();
  setLyricsFontSize(localStorage.getItem(lyricSizeKey) || 16);
  setLyricsPanelHeight(localStorage.getItem(lyricHeightKey) || 266);
  const savedLanguage = localStorage.getItem(targetLanguageKey) || 'es';
  state.targetLanguage = supportedLanguages.has(savedLanguage) ? savedLanguage : 'es';
  $('#targetLanguage').value = state.targetLanguage;
  if (settings.clientId) $('#clientId').value = settings.clientId;
  $('#redirectUri').value = configuredRedirectUri(settings);
  $('#openSettings').addEventListener('click', () => $('#settingsDialog').showModal());
  $('#settingsShortcut').addEventListener('click', () => $('#settingsDialog').showModal());
  $('#connectBtn').addEventListener('click', () => { const cfg = loadSettings(); if (cfg.clientId) $('#clientId').value = cfg.clientId; $('#redirectUri').value = configuredRedirectUri(cfg); $('#settingsDialog').showModal(); });
  $('#saveSettings').addEventListener('click', connectSpotify);
  $('#fontSizeSlider').addEventListener('input', event => setLyricsFontSize(event.target.value));
  $('#fontSmaller').addEventListener('click', () => setLyricsFontSize(Number($('#fontSizeSlider').value) - 1));
  $('#fontLarger').addEventListener('click', () => setLyricsFontSize(Number($('#fontSizeSlider').value) + 1));
  $('#targetLanguage').addEventListener('change', event => setTargetLanguage(event.target.value));
  const lyricsPanel = $('#lyricsInner');
  lyricsPanel.addEventListener('click', event => {
    const row = event.target.closest('[data-line-index]');
    if (row) seekToLyric(Number(row.dataset.lineIndex));
  });
  lyricsPanel.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-line-index]')) {
      event.preventDefault();
      seekToLyric(Number(event.target.dataset.lineIndex));
    }
  });
  const resizeHandle = $('#lyricsResizeHandle');
  resizeHandle.addEventListener('pointerdown', event => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = $('#lyricsPanel').getBoundingClientRect().height;
    resizeHandle.setPointerCapture(event.pointerId);
    const move = moveEvent => setLyricsPanelHeight(startHeight + moveEvent.clientY - startY);
    const finish = finishEvent => {
      resizeHandle.removeEventListener('pointermove', move);
      resizeHandle.removeEventListener('pointerup', finish);
      resizeHandle.removeEventListener('pointercancel', finish);
      if (resizeHandle.hasPointerCapture(finishEvent.pointerId)) resizeHandle.releasePointerCapture(finishEvent.pointerId);
    };
    resizeHandle.addEventListener('pointermove', move);
    resizeHandle.addEventListener('pointerup', finish);
    resizeHandle.addEventListener('pointercancel', finish);
  });
  resizeHandle.addEventListener('keydown', event => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setLyricsPanelHeight(Number(resizeHandle.getAttribute('aria-valuenow')) + (event.key === 'ArrowDown' ? 24 : -24));
    }
  });
  $('#navSearch').addEventListener('click', () => {
    $('#songSearchDialog').showModal();
    $('#songSearchInput').focus();
    if (!state.token) renderSearchMessage('Conectá Spotify para buscar en su catálogo.', 'search-hint');
  });
  $('#closeSongSearch').addEventListener('click', () => $('#songSearchDialog').close());
  $('#songSearchInput').addEventListener('input', event => {
    clearTimeout(state.searchTimer);
    const query = event.target.value;
    state.searchTimer = setTimeout(() => searchSongs(query), 300);
  });
  $('#songSearchResults').addEventListener('click', event => {
    if (event.target.closest('[data-search-connect]')) {
      $('#songSearchDialog').close();
      $('#connectBtn').click();
      return;
    }
    const result = event.target.closest('[data-search-index]');
    if (result && !result.disabled) playSearchResult(Number(result.dataset.searchIndex));
  });
  $('#navNow').addEventListener('click', () => notify('Esta es tu vista de reproducción en vivo.'));
  $('#playBtn').addEventListener('click', async () => {
    if (!state.token) return notify('Conectá Spotify primero.');
    const action = state.playback?.isPlaying ? '/me/player/pause' : '/me/player/play';
    try { await spotifyRequest(action, 'PUT'); }
    catch { notify('No hay ningún dispositivo Spotify activo.'); }
    pollSpotify();
  });
  $('#prevBtn').addEventListener('click', () => state.token ? spotifyRequest('/me/player/previous', 'POST').catch(() => notify('No encontramos un dispositivo activo.')) : notify('Conectá Spotify primero.'));
  $('#nextBtn').addEventListener('click', () => state.token ? spotifyRequest('/me/player/next', 'POST').catch(() => notify('No encontramos un dispositivo activo.')) : notify('Conectá Spotify primero.'));
  handleCallback();
}
setup();
