const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;
const DZ   = 'https://api.deezer.com';

const CLAUDO_URL           = (process.env.CLAUDOCHROME_URL   || '').replace(/\/$/, '');
const DEFAULT_CLAUDO_TOKEN = (process.env.CLAUDOCHROME_TOKEN || '');

app.use(cors());
app.use(express.json());

// ─── Per-user state ───────────────────────────────────────────
// Each Claudochrome token gets its own isolated caches — zero shared rate limits
const userStates = new Map();

function getState(token) {
  if (!userStates.has(token)) {
    userStates.set(token, {
      trackMeta: new Map(),  // dzId → { title, artist }
      tidalIds:  new Map(),  // dzId → { tidalId, expiresAt }
      streams:   new Map(),  // dzId → { url, format, quality, expiresAt }
    });
  }
  return userStates.get(token);
}

// ─── Deezer helper ────────────────────────────────────────────
async function deezerGet(endpoint, params = {}) {
  const res = await axios.get(`${DZ}${endpoint}`, { params, timeout: 10000 });
  if (res.data?.error) throw new Error(`Deezer: ${res.data.error.message}`);
  return res.data;
}

// ─── Match scoring ────────────────────────────────────────────
function normStr(s) {
  return String(s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function strScore(a, b) {
  a = normStr(a); b = normStr(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const sa = new Set(a.split(' ')), sb = new Set(b.split(' '));
  const inter = [...sa].filter(w => w.length > 1 && sb.has(w)).length;
  return inter / Math.max(new Set([...sa, ...sb]).size, 1);
}

function buildSearchQuery(title, artist) {
  const titleNorm   = normStr(title);
  const artistWords = normStr(artist).split(' ').filter(w => w.length > 1);
  const allInTitle  = artistWords.length > 0 && artistWords.every(w => titleNorm.includes(w));
  return allInTitle ? title : `${title} ${artist}`.trim();
}

function bestTidalMatch(tracks, title, artist) {
  if (!tracks.length) return null;
  let best = null, bestScore = -1;
  for (const t of tracks) {
    const titleScore = strScore(t.title, title);
    if (titleScore < 0.15) continue;
    const score = titleScore * 0.4 + strScore(t.artist, artist) * 0.6;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  if (best) console.log(`[tidal-match] best ${bestScore.toFixed(3)} → "${best.title}" by "${best.artist}"`);
  return bestScore >= 0.25 ? best : null;
}

// ─── Per-user Claudochrome calls ──────────────────────────────
async function getTidalId(token, dzId, title, artist) {
  const state  = getState(token);
  const cached = state.tidalIds.get(dzId);
  if (cached && cached.expiresAt > Date.now()) return cached.tidalId;

  if (!CLAUDO_URL) throw new Error('CLAUDOCHROME_URL env var not set.');
  const q = buildSearchQuery(title, artist);
  console.log(`[tidal-search][${token.slice(0, 8)}...] "${q}"`);

  const res = await axios.get(`${CLAUDO_URL}/u/${token}/search`, {
    params: { q, limit: 10 },
    timeout: 12000,
  });

  const tracks = res.data?.tracks || [];
  if (!tracks.length) throw new Error(`Claudochrome: no results for "${q}"`);

  const match = bestTidalMatch(tracks, title, artist);
  if (!match) throw new Error(`Claudochrome: no confident match for "${title}" by "${artist}"`);

  const tidalId = match.id;
  state.tidalIds.set(dzId, { tidalId, expiresAt: Date.now() + 60 * 60 * 1000 });
  console.log(`[tidal-match] "${title}" by "${artist}" => TIDAL id ${tidalId}`);
  return tidalId;
}

async function resolveStream(token, dzId, title, artist) {
  const state  = getState(token);
  const cached = state.streams.get(dzId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  if (!CLAUDO_URL) throw new Error('CLAUDOCHROME_URL env var not set.');
  const tidalId = await getTidalId(token, dzId, title, artist);
  const res     = await axios.get(`${CLAUDO_URL}/u/${token}/stream/${tidalId}`, { timeout: 12000 });
  const data    = res.data;

  if (!data?.url) throw new Error(`Claudochrome: no stream URL for TIDAL id ${tidalId}`);

  const result = {
    url:       data.url,
    format:    data.format   || 'flac',
    quality:   data.quality  || 'lossless',
    expiresAt: data.expiresAt || Date.now() + 5 * 60 * 1000,
  };
  state.streams.set(dzId, result);
  return result;
}

// ─── Concurrency limiter ──────────────────────────────────────
function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

async function enrichTracksWithStreams(token, tracks, concurrency = 3) {
  const state = getState(token);
  const limit = pLimit(concurrency);
  return Promise.all(tracks.map(track =>
    limit(async () => {
      const dzId = track.id.replace(/^dz_/, '');
      try {
        const cached = state.streams.get(dzId);
        if (cached && cached.expiresAt > Date.now()) return { ...track, streamURL: cached.url };
        const meta = state.trackMeta.get(dzId);
        if (!meta) return track;
        const result = await Promise.race([
          resolveStream(token, dzId, meta.title, meta.artist),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
        ]);
        return { ...track, streamURL: result.url };
      } catch { return track; }
    })
  ));
}

// ─── Format helpers ───────────────────────────────────────────
function fmtTrack(t, albumName, albumCover, trackMeta) {
  const dzId = String(t.id);
  if (trackMeta && !trackMeta.has(dzId)) {
    trackMeta.set(dzId, { title: t.title, artist: t.artist?.name || '' });
  }
  return {
    id:         `dz_${t.id}`,
    title:      t.title,
    artist:     t.artist?.name || '',
    album:      t.album?.title || albumName || '',
    duration:   t.duration,
    artworkURL: t.album?.cover_xl || t.album?.cover_big || albumCover || undefined,
    isrc:       t.isrc || undefined,
    format:     'flac',
  };
}

function fmtAlbum(a) {
  return {
    id:         `dz_${a.id}`,
    title:      a.title,
    artist:     a.artist?.name || '',
    artworkURL: a.cover_xl || a.cover_big || undefined,
    trackCount: a.nb_tracks,
    year:       a.release_date?.slice(0, 4),
  };
}

function fmtArtist(a) {
  return {
    id:         `dz_${a.id}`,
    name:       a.name,
    artworkURL: a.picture_xl || a.picture_big || undefined,
    genres:     [],
  };
}

function fmtPlaylist(p) {
  return {
    id:          `dz_${p.id}`,
    title:       p.title,
    creator:     p.user?.name || p.creator?.name || '',
    artworkURL:  p.picture_xl || p.picture_big || undefined,
    trackCount:  p.nb_tracks,
    description: p.description || '',
  };
}

// ─── User-scoped router ───────────────────────────────────────
const userRouter = express.Router({ mergeParams: true });

userRouter.get('/manifest.json', (req, res) => {
  const { token } = req.params;
  const ua    = (req.headers['user-agent'] || '').toLowerCase();
  const isiOS = /cfnetwork|darwin|iphone|ipad|ipod/.test(ua);

  const resources = isiOS
    ? ['search', 'stream', 'catalog']
    : [{ name: 'search' }, { name: 'stream' }, { name: 'catalog' }];

  const types = isiOS
    ? ['track', 'album', 'artist', 'playlist']
    : [{ name: 'track' }, { name: 'album' }, { name: 'artist' }, { name: 'playlist' }];

  res.json({
    id:          `com.spotiflac.eclipse.${token.replace(/[^a-z0-9]/gi, '').slice(0, 16)}`,
    name:        'SpotiFLAC',
    version:     '6.0.0',
    description: 'Deezer search + TIDAL FLAC via Claudochrome',
    resources,
    types,
  });
});

userRouter.get('/search', async (req, res) => {
  const { token } = req.params;
  const state = getState(token);
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  try {
    const [tr, al, ar, pl] = await Promise.allSettled([
      deezerGet('/search',          { q, limit: 20 }),
      deezerGet('/search/album',    { q, limit: 10 }),
      deezerGet('/search/artist',   { q, limit: 10 }),
      deezerGet('/search/playlist', { q, limit: 10 }),
    ]);
    res.json({
      tracks:    tr.status === 'fulfilled' ? (tr.value.data || []).map(t => fmtTrack(t, null, null, state.trackMeta)) : [],
      albums:    al.status === 'fulfilled' ? (al.value.data || []).map(fmtAlbum)    : [],
      artists:   ar.status === 'fulfilled' ? (ar.value.data || []).map(fmtArtist)   : [],
      playlists: pl.status === 'fulfilled' ? (pl.value.data || []).map(fmtPlaylist) : [],
    });
  } catch (err) {
    console.error('[search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

userRouter.get('/stream/:id', async (req, res) => {
  const { token } = req.params;
  const state = getState(token);
  const dzId = req.params.id.replace(/^dz_/, '');
  try {
    let title, artist;
    const metaCached = state.trackMeta.get(dzId);
    if (metaCached) {
      ({ title, artist } = metaCached);
    } else {
      const track = await deezerGet(`/track/${dzId}`);
      title  = track.title;
      artist = track.artist?.name || '';
      state.trackMeta.set(dzId, { title, artist });
    }
    const result = await resolveStream(token, dzId, title, artist);
    res.json(result);
  } catch (err) {
    console.error('[stream]', err.message);
    res.status(500).json({ error: err.message });
  }
});

userRouter.get('/album/:id', async (req, res) => {
  const { token } = req.params;
  const state = getState(token);
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const album     = await deezerGet(`/album/${rawId}`);
    const cover     = album.cover_xl || album.cover_big;
    const rawTracks = (album.tracks?.data || []).map(t => fmtTrack(t, album.title, cover, state.trackMeta));
    const tracks    = await enrichTracksWithStreams(token, rawTracks);
    res.json({
      id:          `dz_${album.id}`,
      title:       album.title,
      artist:      album.artist?.name || '',
      artworkURL:  cover,
      year:        album.release_date?.slice(0, 4),
      description: album.label || '',
      trackCount:  album.nb_tracks,
      tracks,
    });
  } catch (err) {
    console.error('[album]', err.message);
    res.status(500).json({ error: err.message });
  }
});

userRouter.get('/artist/:id', async (req, res) => {
  const { token } = req.params;
  const state = getState(token);
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const [artist, top, albums] = await Promise.all([
      deezerGet(`/artist/${rawId}`),
      deezerGet(`/artist/${rawId}/top`, { limit: 20 }),
      deezerGet(`/artist/${rawId}/albums`, { limit: 20 }),
    ]);
    const rawTopTracks = (top.data || []).map(t => fmtTrack(t, null, null, state.trackMeta));
    const topTracks    = await enrichTracksWithStreams(token, rawTopTracks);
    res.json({
      id:         `dz_${artist.id}`,
      name:       artist.name,
      artworkURL: artist.picture_xl || artist.picture_big,
      genres:     [],
      bio:        '',
      topTracks,
      albums:     (albums.data || []).map(fmtAlbum),
    });
  } catch (err) {
    console.error('[artist]', err.message);
    res.status(500).json({ error: err.message });
  }
});

userRouter.get('/playlist/:id', async (req, res) => {
  const { token } = req.params;
  const state = getState(token);
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const pl        = await deezerGet(`/playlist/${rawId}`);
    const rawTracks = (pl.tracks?.data || []).map(t => fmtTrack(t, null, null, state.trackMeta));
    const tracks    = await enrichTracksWithStreams(token, rawTracks);
    res.json({
      id:          `dz_${pl.id}`,
      title:       pl.title,
      description: pl.description || '',
      artworkURL:  pl.picture_xl || pl.picture_big,
      creator:     pl.creator?.name || '',
      tracks,
    });
  } catch (err) {
    console.error('[playlist]', err.message);
    res.status(500).json({ error: err.message });
  }
});

userRouter.get('/health', async (req, res) => {
  const { token } = req.params;
  let claudoOk = false, error = null;
  try {
    if (!CLAUDO_URL) throw new Error('CLAUDOCHROME_URL env var not set');
    if (!token)      throw new Error('No Claudochrome token in URL');
    await axios.get(`${CLAUDO_URL}/u/${token}/search`, { params: { q: 'test', limit: 1 }, timeout: 6000 });
    claudoOk = true;
  } catch (e) { error = e.message; }
  res.json({ status: claudoOk ? 'ok' : 'degraded', claudochrome: claudoOk, error, version: '6.0.0' });
});

// ─── Mount user router ────────────────────────────────────────
app.use('/u/:token', userRouter);

// ─── Landing page HTML ────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>SpotiFLAC - Eclipse Addon</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300..700&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0c0c0e;--surface:#131315;--surface2:#18181b;
      --border:rgba(255,255,255,0.07);--border-focus:rgba(30,215,96,0.45);
      --text:#eaeaec;--muted:#808088;--faint:#2e2e34;
      --green:#1ed760;--green-dim:rgba(30,215,96,0.14);
      --red:#ff5a6a;--r:12px;
      --ease:160ms cubic-bezier(0.16,1,0.3,1);
    }
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:hidden}

    nav{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:0 28px;height:60px;border-bottom:1px solid var(--border);background:rgba(12,12,14,0.85);backdrop-filter:blur(16px)}
    .brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:14px;letter-spacing:-0.01em}
    .brand-dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 10px var(--green)}
    .badge{font-size:10px;font-weight:700;color:var(--green);border:1px solid rgba(30,215,96,0.2);background:var(--green-dim);border-radius:999px;padding:3px 9px;text-transform:uppercase;letter-spacing:.1em}

    .hero{max-width:860px;margin:0 auto;padding:80px 28px 52px;text-align:center}
    .eyebrow{display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--green);margin-bottom:20px}
    .eyebrow-dot{width:5px;height:5px;border-radius:50%;background:var(--green)}
    h1{font-size:clamp(2rem,5vw,3.8rem);font-weight:700;line-height:1.07;letter-spacing:-0.04em;margin-bottom:16px}
    h1 span{color:var(--green)}
    .hero-sub{color:var(--muted);font-size:clamp(14px,2vw,16px);max-width:500px;margin:0 auto 44px}

    .wrap{max-width:560px;margin:0 auto;padding:0 28px 64px}

    .card{background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden}
    .card-head{padding:15px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px}
    .card-icon{width:30px;height:30px;border-radius:8px;background:var(--green-dim);border:1px solid rgba(30,215,96,0.18);display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .card-icon svg{width:14px;height:14px;stroke:var(--green)}
    .card-title{font-size:13px;font-weight:600}
    .card-sub{font-size:11px;color:var(--muted);margin-left:auto}
    .card-body{padding:20px}

    .field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
    .field label{font-size:12px;font-weight:500;color:var(--muted)}
    .field input{width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:11px 14px;font-family:ui-monospace,monospace;font-size:13px;color:var(--text);outline:none;transition:border-color var(--ease),box-shadow var(--ease)}
    .field input::placeholder{color:var(--faint)}
    .field input:focus{border-color:var(--border-focus);box-shadow:0 0 0 3px rgba(30,215,96,0.07)}
    .field-hint{font-size:11px;color:var(--muted);line-height:1.55}

    .btn-gen{width:100%;background:var(--green);color:#000;font-weight:700;font-size:14px;border:none;border-radius:var(--r);padding:13px;cursor:pointer;transition:opacity var(--ease),transform var(--ease);margin-top:4px}
    .btn-gen:hover{opacity:.87}
    .btn-gen:active{transform:scale(0.98)}

    .url-card{margin-top:14px;border:1px solid rgba(30,215,96,0.18);background:rgba(30,215,96,0.04);border-radius:14px;overflow:hidden;display:none}
    .url-card.show{display:block;animation:rise .28s ease}
    @keyframes rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
    .url-row{display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid rgba(30,215,96,0.1)}
    .url-txt{flex:1;min-width:0;font-family:ui-monospace,monospace;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .url-txt em{color:var(--green);font-style:normal}
    .btn-copy{flex-shrink:0;background:rgba(30,215,96,0.1);border:1px solid rgba(30,215,96,0.18);color:var(--green);font-size:12px;font-weight:600;border-radius:8px;padding:6px 12px;cursor:pointer;white-space:nowrap;transition:background var(--ease)}
    .btn-copy:hover{background:rgba(30,215,96,0.18)}
    .stat-row{display:flex;align-items:center;gap:8px;padding:11px 16px;font-size:12px;color:var(--muted)}
    .sdot{width:7px;height:7px;border-radius:50%;background:#333;flex-shrink:0}
    .sdot.chk{background:#f5a623;box-shadow:0 0 6px #f5a62380;animation:blink 1.1s ease-in-out infinite}
    .sdot.ok{background:var(--green);box-shadow:0 0 7px var(--green)}
    .sdot.bad{background:var(--red);box-shadow:0 0 7px var(--red)}
    @keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}

    .steps{display:flex;flex-direction:column;gap:8px;margin-top:22px;display:none}
    .step{display:flex;gap:11px;align-items:flex-start;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
    .step-n{width:23px;height:23px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--green-dim);color:var(--green);border:1px solid rgba(30,215,96,0.18);font-size:11px;font-weight:700;margin-top:1px}
    .step-t{font-size:13px;color:var(--muted);line-height:1.55}
    .step-t strong{color:var(--text);font-weight:500}

    .features{max-width:560px;margin:0 auto;padding:0 28px 64px;display:grid;grid-template-columns:1fr 1fr;gap:9px}
    .feat{background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:15px}
    .feat-icon{width:30px;height:30px;border-radius:8px;background:var(--green-dim);border:1px solid rgba(30,215,96,0.14);display:flex;align-items:center;justify-content:center;margin-bottom:10px}
    .feat-icon svg{width:14px;height:14px;stroke:var(--green)}
    .feat-title{font-size:13px;font-weight:600;margin-bottom:4px}
    .feat-desc{font-size:12px;color:var(--muted);line-height:1.55}

    footer{border-top:1px solid var(--border);padding:20px 28px;text-align:center;font-size:12px;color:var(--muted)}

    @media(max-width:520px){
      nav{padding:0 16px}
      .hero{padding:52px 16px 36px}
      .wrap,.features{padding-left:16px;padding-right:16px}
      .features{grid-template-columns:1fr}
      h1{font-size:1.9rem}
    }
  </style>
</head>
<body>
<nav>
  <div class="brand"><div class="brand-dot"></div>SpotiFLAC</div>
  <div class="badge">Eclipse Addon</div>
</nav>

<section class="hero">
  <div class="eyebrow"><div class="eyebrow-dot"></div>Eclipse Music &middot; Community Addon</div>
  <h1>Deezer search.<br><span>TIDAL FLAC.</span></h1>
  <p class="hero-sub">Enter your Claudochrome token to get a personal addon URL &mdash; completely isolated, zero shared rate limits.</p>
</section>

<section class="wrap">
  <div class="card">
    <div class="card-head">
      <div class="card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <div class="card-title">Your Claudochrome Token</div>
      <div class="card-sub">personal &middot; isolated</div>
    </div>
    <div class="card-body">
      <div class="field">
        <label for="tok">Claudochrome Token</label>
        <input id="tok" type="password" placeholder="paste your token here..." autocomplete="off" spellcheck="false"/>
        <span class="field-hint">Your token is embedded directly in your addon URL. The server never stores it separately &mdash; it lives only in the path.</span>
      </div>
      <button class="btn-gen" onclick="generate()">Generate My Addon URL</button>

      <div class="url-card" id="urlCard">
        <div class="url-row">
          <div class="url-txt" id="urlDisp"><em>loading...</em></div>
          <button class="btn-copy" id="copyBtn" onclick="copyURL()">Copy</button>
        </div>
        <div class="stat-row">
          <div class="sdot chk" id="sdot"></div>
          <span id="stxt">Verifying token...</span>
        </div>
      </div>
    </div>
  </div>

  <div class="steps" id="steps">
    <div class="step"><div class="step-n">1</div><div class="step-t">Open <strong>Eclipse Music</strong> on your device.</div></div>
    <div class="step"><div class="step-n">2</div><div class="step-t">Go to <strong>Settings &rarr; Connections &rarr; Add Connection &rarr; Addon</strong>.</div></div>
    <div class="step"><div class="step-n">3</div><div class="step-t">Paste your URL above and tap <strong>Install</strong>.</div></div>
    <div class="step"><div class="step-n">4</div><div class="step-t">Optional: set as <strong>Default Playback</strong> for FLAC streams across Home, Radio, and DJ.</div></div>
  </div>
</section>

<section class="features">
  <div class="feat">
    <div class="feat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>
    <div class="feat-title">Zero Shared Rate Limits</div>
    <div class="feat-desc">Your token lives only in your URL. Every user has a completely independent Claudochrome pipeline.</div>
  </div>
  <div class="feat">
    <div class="feat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg></div>
    <div class="feat-title">Isolated Cache</div>
    <div class="feat-desc">Track metadata, TIDAL IDs, and stream URLs are cached per-token. Your lookups never mix with others.</div>
  </div>
  <div class="feat">
    <div class="feat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg></div>
    <div class="feat-title">Lossless FLAC</div>
    <div class="feat-desc">Streams resolve to TIDAL FLAC via Claudochrome. Deezer powers search, TIDAL powers audio quality.</div>
  </div>
  <div class="feat">
    <div class="feat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>
    <div class="feat-title">Full Deezer Catalog</div>
    <div class="feat-desc">Search tracks, albums, artists, and playlists from all of Deezer. No account or login needed.</div>
  </div>
</section>

<footer>SpotiFLAC v6.0.0 &middot; Each URL is fully independent &middot; Deezer + Claudochrome &middot; Eclipse Music</footer>

<script>
  let curToken = '', curURL = '';

  document.getElementById('tok').addEventListener('keydown', e => { if (e.key === 'Enter') generate(); });
  document.getElementById('tok').addEventListener('focus',   function(){ this.type = 'text'; });
  document.getElementById('tok').addEventListener('blur',    function(){ this.type = 'password'; });

  function generate() {
    const token = document.getElementById('tok').value.trim();
    if (!token) {
      const el = document.getElementById('tok');
      el.focus();
      el.style.borderColor = '#ff5a6a';
      setTimeout(() => el.style.borderColor = '', 1400);
      return;
    }
    curToken = token;
    curURL   = location.origin + '/u/' + encodeURIComponent(token) + '/manifest.json';

    document.getElementById('urlDisp').innerHTML =
      location.origin + '/u/<em>' + escHtml(token.slice(0, 8)) + (token.length > 8 ? '...' : '') + '</em>/manifest.json';

    document.getElementById('urlCard').classList.add('show');

    const steps = document.getElementById('steps');
    steps.style.display = 'flex';

    document.getElementById('copyBtn').textContent = 'Copy';
    verify(token);
  }

  async function verify(token) {
    const dot = document.getElementById('sdot');
    const txt = document.getElementById('stxt');
    dot.className = 'sdot chk';
    txt.textContent = 'Verifying token...';
    try {
      const r = await fetch('/u/' + encodeURIComponent(token) + '/health');
      const d = await r.json();
      if (d.claudochrome) {
        dot.className = 'sdot ok';
        txt.textContent = 'Token verified - ready to install';
      } else {
        dot.className = 'sdot bad';
        txt.textContent = d.error || 'Token invalid or Claudochrome unreachable';
      }
    } catch {
      dot.className = 'sdot bad';
      txt.textContent = 'Could not reach server';
    }
  }

  async function copyURL() {
    if (!curURL) return;
    try {
      await navigator.clipboard.writeText(curURL);
      const b = document.getElementById('copyBtn');
      b.textContent = 'Copied!';
      setTimeout(() => b.textContent = 'Copy', 1800);
    } catch { prompt('Your addon URL:', curURL); }
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
<\/script>
</body>
</html>`;

// ─── Root ─────────────────────────────────────────────────────
app.get('/', (req, res) => res.type('html').send(HTML));

// ─── Global health (uses env default token for status checks) ─
app.get('/health', async (req, res) => {
  let claudoOk = false, error = null;
  try {
    if (!CLAUDO_URL || !DEFAULT_CLAUDO_TOKEN) throw new Error('CLAUDOCHROME_URL or CLAUDOCHROME_TOKEN not set');
    await axios.get(`${CLAUDO_URL}/u/${DEFAULT_CLAUDO_TOKEN}/search`, { params: { q: 'test', limit: 1 }, timeout: 6000 });
    claudoOk = true;
  } catch (e) { error = e.message; }
  res.json({ status: claudoOk ? 'ok' : 'degraded', claudochrome: claudoOk, error, version: '6.0.0' });
});

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`SpotiFLAC v6.0.0 running on http://localhost:${PORT}`);
  console.log(`Claudochrome base URL: ${CLAUDO_URL || '(CLAUDOCHROME_URL not set)'}`);
  console.log('User routes: /u/:claudoToken/{manifest.json,search,stream/:id,album/:id,artist/:id,playlist/:id,health}');

  if (process.env.RENDER_EXTERNAL_URL) {
    const selfUrl = process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
    setInterval(async () => {
      try {
        await axios.get(`${selfUrl}/health`, { timeout: 5000 });
        console.log('[keepalive] ping ok');
      } catch (e) {
        console.warn('[keepalive] ping failed:', e.message);
      }
    }, 4 * 60 * 1000);
  }
});
