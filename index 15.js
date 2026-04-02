const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DZ = 'https://api.deezer.com';

const MONOCHROME_URL = (process.env.MONOCHROME_URL || process.env.CLAUDOCHROME_URL || 'https://monochrome.tf').replace(/\/$/, '');
const APP_BASE_URL = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'change-me-in-production';

app.use(cors());
app.use(express.json());

async function deezerGet(endpoint, params = {}) {
  const res = await axios.get(`${DZ}${endpoint}`, { params, timeout: 10000 });
  if (res.data?.error) throw new Error(`Deezer: ${res.data.error.message}`);
  return res.data;
}

function monochromeBase() {
  if (!MONOCHROME_URL) throw new Error('MONOCHROME_URL env var not set.');
  return MONOCHROME_URL;
}

function baseUrl(req) {
  return APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

const trackMetaCache = new Map();
const tidalIdCache = new Map();
const streamCache = new Map();
const inflightStreamCache = new Map();
const tokenRateCache = new Map();

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
  const titleNorm = normStr(title);
  const artistWords = normStr(artist).split(' ').filter(w => w.length > 1);
  const allInTitle = artistWords.length > 0 && artistWords.every(w => titleNorm.includes(w));
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
  if (best) console.log(`[mono-match] best ${bestScore.toFixed(3)} -> "${best.title}" by "${best.artist}"`);
  return bestScore >= 0.25 ? best : null;
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function makeUserToken(req) {
  return signToken({
    jti: crypto.randomBytes(12).toString('hex'),
    iat: Date.now(),
    ip: crypto.createHash('sha1').update(req.ip || '').digest('hex').slice(0, 12),
  });
}

function tokenLimiter(req, res, next) {
  const token = req.params.token;
  const payload = verifyToken(token);
  if (!payload?.jti) return res.status(401).json({ error: 'Invalid token' });

  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxReq = 90;
  let entry = tokenRateCache.get(payload.jti);

  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
  }

  entry.count += 1;
  tokenRateCache.set(payload.jti, entry);

  if (entry.count > maxReq) {
    res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
    return res.status(429).json({ error: 'Rate limit exceeded for this generated URL' });
  }

  req.userToken = payload;
  next();
}

async function getMonochromeId(dzId, title, artist) {
  const cached = tidalIdCache.get(dzId);
  if (cached && cached.expiresAt > Date.now()) return cached.tidalId;

  const q = buildSearchQuery(title, artist);
  console.log(`[mono-search] query: "${q}"`);
  const res = await axios.get(`${monochromeBase()}/search`, {
    params: { q, limit: 10 },
    timeout: 12000,
  });

  const tracks = res.data?.tracks || [];
  if (!tracks.length) throw new Error(`Monochrome: no results for "${q}"`);

  const match = bestTidalMatch(tracks, title, artist);
  if (!match) throw new Error(`Monochrome: no confident match for "${title}" by "${artist}"`);

  const tidalId = match.id;
  tidalIdCache.set(dzId, { tidalId, expiresAt: Date.now() + 60 * 60 * 1000 });
  console.log(`[mono-match] "${title}" by "${artist}" -> stream id ${tidalId}`);
  return tidalId;
}

async function resolveStream(dzId, title, artist) {
  const cached = streamCache.get(dzId);
  if (cached && cached.expiresAt > Date.now()) return cached;
  if (inflightStreamCache.has(dzId)) return inflightStreamCache.get(dzId);

  const pending = (async () => {
    const streamId = await getMonochromeId(dzId, title, artist);
    const res = await axios.get(`${monochromeBase()}/stream/${streamId}`, { timeout: 12000 });
    const data = res.data;

    if (!data?.url) throw new Error(`Monochrome: no stream URL for id ${streamId}`);

    const result = {
      url: data.url,
      format: data.format || 'flac',
      quality: data.quality || 'lossless',
      expiresAt: data.expiresAt || Date.now() + 5 * 60 * 1000,
    };
    streamCache.set(dzId, result);
    return result;
  })().finally(() => inflightStreamCache.delete(dzId));

  inflightStreamCache.set(dzId, pending);
  return pending;
}

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

async function enrichTracksWithStreams(tracks, concurrency = 3) {
  const limit = pLimit(concurrency);
  return Promise.all(tracks.map(track =>
    limit(async () => {
      const dzId = track.id.replace(/^dz_/, '');
      try {
        const cached = streamCache.get(dzId);
        if (cached && cached.expiresAt > Date.now()) {
          return { ...track, streamURL: cached.url };
        }
        const meta = trackMetaCache.get(dzId);
        if (!meta) return track;

        const result = await Promise.race([
          resolveStream(dzId, meta.title, meta.artist),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
        ]);
        return { ...track, streamURL: result.url };
      } catch {
        return track;
      }
    })
  ));
}

function fmtTrack(t, albumName, albumCover) {
  const dzId = String(t.id);
  if (!trackMetaCache.has(dzId)) {
    trackMetaCache.set(dzId, {
      title: t.title,
      artist: t.artist?.name || '',
    });
  }
  return {
    id: `dz_${t.id}`,
    title: t.title,
    artist: t.artist?.name || '',
    album: t.album?.title || albumName || '',
    duration: t.duration,
    artworkURL: t.album?.cover_xl || t.album?.cover_big || albumCover || undefined,
    isrc: t.isrc || undefined,
    format: 'flac',
  };
}

function fmtAlbum(a) {
  return {
    id: `dz_${a.id}`,
    title: a.title,
    artist: a.artist?.name || '',
    artworkURL: a.cover_xl || a.cover_big || undefined,
    trackCount: a.nb_tracks,
    year: a.release_date?.slice(0, 4),
  };
}

function fmtArtist(a) {
  return {
    id: `dz_${a.id}`,
    name: a.name,
    artworkURL: a.picture_xl || a.picture_big || undefined,
    genres: [],
  };
}

function fmtPlaylist(p) {
  return {
    id: `dz_${p.id}`,
    title: p.title,
    creator: p.user?.name || p.creator?.name || '',
    artworkURL: p.picture_xl || p.picture_big || undefined,
    trackCount: p.nb_tracks,
    description: p.description || '',
  };
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>SpotiFLAC — Eclipse Addon</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300..700&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0a0a0b;--surface:#111113;--border:rgba(255,255,255,0.08);--text:#e8e8ea;--muted:#8a8a92;--green:#1ed760;--gd:rgba(30,215,96,0.12);--r:14px}
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.6;-webkit-font-smoothing:antialiased}
    nav{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:64px;border-bottom:1px solid var(--border);background:rgba(10,10,11,0.85);backdrop-filter:blur(12px)}
    .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px}
    .dot{width:10px;height:10px;border-radius:999px;background:var(--green);box-shadow:0 0 10px var(--green)}
    .badge{font-size:11px;font-weight:700;color:var(--green);border:1px solid rgba(30,215,96,0.25);background:var(--gd);border-radius:999px;padding:4px 10px;text-transform:uppercase;letter-spacing:.08em}
    .hero{max-width:920px;margin:0 auto;padding:72px 24px 40px;text-align:center}
    .ey{color:var(--green);font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin-bottom:14px}
    h1{font-size:clamp(2.4rem,6vw,4.8rem);line-height:1.05;letter-spacing:-0.04em;margin-bottom:16px}
    h1 span{color:var(--green)}
    .sub{color:var(--muted);max-width:620px;margin:0 auto 20px;font-size:17px}
    .status{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border);background:var(--surface);border-radius:999px;padding:8px 14px;font-size:13px;color:var(--muted);cursor:pointer}
    .sdot{width:8px;height:8px;border-radius:999px;background:#666}
    .sdot.ok{background:var(--green);box-shadow:0 0 8px var(--green)}
    .sdot.bad{background:#ff5a6a;box-shadow:0 0 8px #ff5a6a}
    .sec{max-width:680px;margin:0 auto;padding:0 24px 48px}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
    .ch{padding:16px 18px;border-bottom:1px solid var(--border);font-size:14px;font-weight:700}
    .row{display:flex;gap:12px;align-items:center;padding:16px 18px;flex-wrap:wrap}
    .url{flex:1;min-width:0;font-family:ui-monospace,monospace;font-size:13px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .url em{color:var(--green);font-style:normal}
    button{border:0;cursor:pointer;border-radius:10px;background:var(--green);color:#000;font-weight:800;padding:10px 16px}
    .steps{display:grid;gap:10px;margin-top:16px}
    .step{display:flex;gap:12px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
    .num{width:28px;height:28px;border-radius:999px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--gd);color:var(--green);border:1px solid rgba(30,215,96,0.24);font-size:12px;font-weight:800}
    .txt{color:var(--muted);font-size:14px}.txt strong{color:var(--text)}
    .note{padding:14px 16px;border-top:1px solid var(--border);font-size:13px;color:var(--muted);background:rgba(255,255,255,0.02)}
    footer{border-top:1px solid var(--border);color:var(--muted);text-align:center;font-size:13px;padding:22px}
  </style>
</head>
<body>
  <nav>
    <div class="brand"><div class="dot"></div>SpotiFLAC</div>
    <div class="badge">Eclipse Addon</div>
  </nav>
  <section class="hero">
    <div class="ey">Eclipse Music · Community Addon</div>
    <h1>Deezer search.<br><span>Monochrome FLAC.</span></h1>
    <p class="sub">Deezer catalog for search. Monochrome for lossless streams. No extra accounts needed.</p>
    <div class="status" onclick="checkHealth()">
      <div class="sdot" id="dot"></div>
      <span id="stxt">Checking…</span>
    </div>
  </section>
  <section class="sec">
    <div class="card">
      <div class="ch">Addon URL</div>
      <div class="row">
        <div class="url" id="addonUrl"><em>tap generate to create your personal manifest url</em></div>
        <button onclick="generateUrl(this)">Generate</button>
      </div>
      <div class="note">Each generated URL is separate per user, so one person hitting limits does not force everyone onto the same shared manifest path.</div>
    </div>
    <div class="steps">
      <div class="step"><div class="num">1</div><div class="txt">Open <strong>Eclipse Music</strong>.</div></div>
      <div class="step"><div class="num">2</div><div class="txt">Go to <strong>Settings → Connections → Add Connection → Addon</strong>.</div></div>
      <div class="step"><div class="num">3</div><div class="txt">Tap <strong>Generate</strong> to copy your unique manifest URL, then paste it and tap <strong>Install</strong>.</div></div>
      <div class="step"><div class="num">4</div><div class="txt">Optional: set as <strong>Default Playback</strong> for Monochrome streams across Home, Radio, and DJ.</div></div>
    </div>
  </section>
  <footer>SpotiFLAC · Deezer + Monochrome · Eclipse Music Addon</footer>
  <script>
    async function generateUrl(btn){
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Generating…';
      try{
        const res = await fetch('/generate-url');
        const data = await res.json();
        document.getElementById('addonUrl').textContent = data.manifestUrl;
        await navigator.clipboard.writeText(data.manifestUrl);
        btn.textContent = 'Copied';
        setTimeout(() => {
          btn.textContent = 'Generate';
          btn.disabled = false;
        }, 1400);
      }catch{
        document.getElementById('addonUrl').innerHTML = '<em>failed to generate url</em>';
        btn.textContent = label;
        btn.disabled = false;
      }
    }

    async function checkHealth(){
      const dot=document.getElementById('dot'),txt=document.getElementById('stxt');
      dot.className='sdot'; txt.textContent='Checking…';
      try{
        const d=await(await fetch('/health')).json();
        if(d.monochrome){dot.className='sdot ok';txt.textContent='Online — Monochrome ready';}
        else{dot.className='sdot bad';txt.textContent=d.error||'Monochrome unreachable';}
      }catch{dot.className='sdot bad';txt.textContent='Addon offline';}
    }
    checkHealth();
  <\/script>
</body>
</html>`;

app.get('/', (req, res) => res.type('html').send(HTML));

app.get('/generate-url', (req, res) => {
  const token = makeUserToken(req);
  res.json({ manifestUrl: `${baseUrl(req)}/u/${token}/manifest.json` });
});

app.get('/manifest.json', (req, res) => {
  res.redirect('/');
});

const addon = express.Router({ mergeParams: true });
addon.use(tokenLimiter);

addon.get('/manifest.json', (req, res) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const isiOS = /cfnetwork|darwin|iphone|ipad|ipod/.test(ua);

  const resources = isiOS
    ? ['search', 'stream', 'catalog']
    : [{ name: 'search' }, { name: 'stream' }, { name: 'catalog' }];

  const types = isiOS
    ? ['track', 'album', 'artist', 'playlist']
    : [{ name: 'track' }, { name: 'album' }, { name: 'artist' }, { name: 'playlist' }];

  res.json({
    id: 'com.spotiflac.eclipse',
    name: 'SpotiFLAC',
    version: '5.6.1',
    description: 'Deezer search + Monochrome FLAC streams',
    resources,
    types,
  });
});

addon.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  try {
    const [tr, al, ar, pl] = await Promise.allSettled([
      deezerGet('/search', { q, limit: 20 }),
      deezerGet('/search/album', { q, limit: 10 }),
      deezerGet('/search/artist', { q, limit: 10 }),
      deezerGet('/search/playlist', { q, limit: 10 }),
    ]);
    res.json({
      tracks: tr.status === 'fulfilled' ? (tr.value.data || []).map(t => fmtTrack(t)) : [],
      albums: al.status === 'fulfilled' ? (al.value.data || []).map(fmtAlbum) : [],
      artists: ar.status === 'fulfilled' ? (ar.value.data || []).map(fmtArtist) : [],
      playlists: pl.status === 'fulfilled' ? (pl.value.data || []).map(fmtPlaylist) : [],
    });
  } catch (err) {
    console.error('[search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

addon.get('/stream/:id', async (req, res) => {
  const dzId = req.params.id.replace(/^dz_/, '');
  try {
    let title, artist;

    const metaCached = trackMetaCache.get(dzId);
    if (metaCached) {
      ({ title, artist } = metaCached);
    } else {
      const track = await deezerGet(`/track/${dzId}`);
      title = track.title;
      artist = track.artist?.name || '';
      trackMetaCache.set(dzId, { title, artist });
    }

    const result = await resolveStream(dzId, title, artist);
    res.json(result);
  } catch (err) {
    console.error('[stream]', err.message);
    res.status(500).json({ error: err.message });
  }
});

addon.get('/album/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const album = await deezerGet(`/album/${rawId}`);
    const cover = album.cover_xl || album.cover_big;
    const rawTracks = (album.tracks?.data || []).map(t => fmtTrack(t, album.title, cover));
    const tracks = await enrichTracksWithStreams(rawTracks);
    res.json({
      id: `dz_${album.id}`,
      title: album.title,
      artist: album.artist?.name || '',
      artworkURL: cover,
      year: album.release_date?.slice(0, 4),
      description: album.label || '',
      trackCount: album.nb_tracks,
      tracks,
    });
  } catch (err) {
    console.error('[album]', err.message);
    res.status(500).json({ error: err.message });
  }
});

addon.get('/artist/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const [artist, top, albums] = await Promise.all([
      deezerGet(`/artist/${rawId}`),
      deezerGet(`/artist/${rawId}/top`, { limit: 20 }),
      deezerGet(`/artist/${rawId}/albums`, { limit: 20 }),
    ]);
    const rawTopTracks = (top.data || []).map(t => fmtTrack(t));
    const topTracks = await enrichTracksWithStreams(rawTopTracks);
    res.json({
      id: `dz_${artist.id}`,
      name: artist.name,
      artworkURL: artist.picture_xl || artist.picture_big,
      genres: [],
      bio: '',
      topTracks,
      albums: (albums.data || []).map(fmtAlbum),
    });
  } catch (err) {
    console.error('[artist]', err.message);
    res.status(500).json({ error: err.message });
  }
});

addon.get('/playlist/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const pl = await deezerGet(`/playlist/${rawId}`);
    const rawTracks = (pl.tracks?.data || []).map(t => fmtTrack(t));
    const tracks = await enrichTracksWithStreams(rawTracks);
    res.json({
      id: `dz_${pl.id}`,
      title: pl.title,
      description: pl.description || '',
      artworkURL: pl.picture_xl || pl.picture_big,
      creator: pl.creator?.name || '',
      tracks,
    });
  } catch (err) {
    console.error('[playlist]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use('/u/:token', addon);

app.get('/health', async (req, res) => {
  let monoOk = false, error = null;
  try {
    await axios.get(`${monochromeBase()}/search`, { params: { q: 'test', limit: 1 }, timeout: 6000 });
    monoOk = true;
  } catch (e) { error = e.message; }
  res.json({ status: monoOk ? 'ok' : 'degraded', monochrome: monoOk, error, version: '5.6.1' });
});

app.listen(PORT, () => {
  console.log(`SpotiFLAC v5.6.1 -> http://localhost:${PORT}`);
  console.log(`Monochrome: ${MONOCHROME_URL}`);

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
