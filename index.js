const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;
const DZ   = 'https://api.deezer.com';

// Your Claudochrome Render URL + a token generated from its website
const CLAUDO_URL   = (process.env.CLAUDOCHROME_URL   || '').replace(/\/$/, '');
const CLAUDO_TOKEN = (process.env.CLAUDOCHROME_TOKEN  || '');

app.use(cors());
app.use(express.json());

// ─── Deezer helper ────────────────────────────────────────────
async function deezerGet(endpoint, params = {}) {
  const res = await axios.get(`${DZ}${endpoint}`, { params, timeout: 10000 });
  if (res.data?.error) throw new Error(`Deezer: ${res.data.error.message}`);
  return res.data;
}

// ─── Claudochrome helpers ─────────────────────────────────────
function claudoBase() {
  if (!CLAUDO_URL)   throw new Error('CLAUDOCHROME_URL env var not set.');
  if (!CLAUDO_TOKEN) throw new Error('CLAUDOCHROME_TOKEN env var not set.');
  return `${CLAUDO_URL}/u/${CLAUDO_TOKEN}`;
}

// Cache: deezerTrackId → { tidalId, expiresAt }
const tidalIdCache  = new Map();
// Cache: deezerTrackId → { url, format, quality, expiresAt }
const streamCache   = new Map();

async function getTidalId(dzId, title, artist) {
  const cached = tidalIdCache.get(dzId);
  if (cached && cached.expiresAt > Date.now()) return cached.tidalId;

  const q   = `${title} ${artist}`.trim();
  const res = await axios.get(`${claudoBase()}/search`, {
    params:  { q },
    timeout: 12000,
  });

  const tracks = res.data?.tracks || [];
  if (!tracks.length) throw new Error(`Claudochrome: no results for "${q}"`);

  // Pick first result — Claudochrome already ranks by relevance
  const tidalId = tracks[0].id;
  tidalIdCache.set(dzId, { tidalId, expiresAt: Date.now() + 60 * 60 * 1000 }); // cache 1 hr
  console.log(`[tidal-match] "${title}" → TIDAL id ${tidalId}`);
  return tidalId;
}

async function resolveStream(dzId, title, artist) {
  const cached = streamCache.get(dzId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const tidalId  = await getTidalId(dzId, title, artist);
  const res      = await axios.get(`${claudoBase()}/stream/${tidalId}`, { timeout: 12000 });
  const data     = res.data;

  if (!data?.url) throw new Error(`Claudochrome: no stream URL for TIDAL id ${tidalId}`);

  const result = {
    url:       data.url,
    format:    data.format   || 'flac',
    quality:   data.quality  || 'lossless',
    expiresAt: data.expiresAt || Date.now() + 5 * 60 * 1000, // stream URLs expire ~5 min
  };
  streamCache.set(dzId, result);
  return result;
}

// ─── Format helpers ───────────────────────────────────────────
function fmtTrack(t, albumName, albumCover) {
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
  return { id:`dz_${a.id}`, title:a.title, artist:a.artist?.name||'', artworkURL:a.cover_xl||a.cover_big||undefined, trackCount:a.nb_tracks, year:a.release_date?.slice(0,4) };
}
function fmtArtist(a) {
  return { id:`dz_${a.id}`, name:a.name, artworkURL:a.picture_xl||a.picture_big||undefined, genres:[] };
}
function fmtPlaylist(p) {
  return { id:`dz_${p.id}`, title:p.title, creator:p.user?.name||p.creator?.name||'', artworkURL:p.picture_xl||p.picture_big||undefined, trackCount:p.nb_tracks, description:p.description||'' };
}

// ─── Website ──────────────────────────────────────────────────
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
    <h1>Deezer search.<br><span>TIDAL FLAC.</span></h1>
    <p class="sub">Deezer catalog for search. Claudochrome for lossless TIDAL streams. No extra accounts needed.</p>
    <div class="status" onclick="checkHealth()">
      <div class="sdot" id="dot"></div>
      <span id="stxt">Checking…</span>
    </div>
  </section>
  <section class="sec">
    <div class="card">
      <div class="ch">Addon URL</div>
      <div class="row">
        <div class="url" id="addonUrl"><em>loading…</em></div>
        <button onclick="copyUrl(this)">Copy</button>
      </div>
    </div>
    <div class="steps">
      <div class="step"><div class="num">1</div><div class="txt">Open <strong>Eclipse Music</strong>.</div></div>
      <div class="step"><div class="num">2</div><div class="txt">Go to <strong>Settings → Connections → Add Connection → Addon</strong>.</div></div>
      <div class="step"><div class="num">3</div><div class="txt">Paste the URL above and tap <strong>Install</strong>.</div></div>
      <div class="step"><div class="num">4</div><div class="txt">Optional: set as <strong>Default Playback</strong> for TIDAL streams across Home, Radio, and DJ.</div></div>
    </div>
  </section>
  <footer>SpotiFLAC · Deezer + Claudochrome · Eclipse Music Addon</footer>
  <script>
    document.getElementById('addonUrl').innerHTML='<em>'+location.origin+'</em>/manifest.json';
    async function copyUrl(btn){
      await navigator.clipboard.writeText(location.origin+'/manifest.json');
      btn.textContent='Copied'; setTimeout(()=>btn.textContent='Copy',1500);
    }
    async function checkHealth(){
      const dot=document.getElementById('dot'),txt=document.getElementById('stxt');
      dot.className='sdot'; txt.textContent='Checking…';
      try{
        const d=await(await fetch('/health')).json();
        if(d.claudochrome){dot.className='sdot ok';txt.textContent='Online — Claudochrome ready';}
        else{dot.className='sdot bad';txt.textContent=d.error||'Claudochrome unreachable';}
      }catch{dot.className='sdot bad';txt.textContent='Addon offline';}
    }
    checkHealth();
  </script>
</body>
</html>`;

// ─── Routes ───────────────────────────────────────────────────
app.get('/', (req, res) => res.type('html').send(HTML));

app.get('/manifest.json', (req, res) => res.json({
  id:          'com.spotiflac.eclipse',
  name:        'SpotiFLAC',
  version:     '4.0.0',
  description: 'Deezer search + TIDAL FLAC via Claudochrome',
  resources:   ['search', 'stream', 'catalog'],
  types:       ['track', 'album', 'artist', 'playlist'],
}));

app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ tracks:[], albums:[], artists:[], playlists:[] });
  try {
    const [tr, al, ar, pl] = await Promise.allSettled([
      deezerGet('/search',          { q, limit:20 }),
      deezerGet('/search/album',    { q, limit:10 }),
      deezerGet('/search/artist',   { q, limit:10 }),
      deezerGet('/search/playlist', { q, limit:10 }),
    ]);
    res.json({
      tracks:    tr.status==='fulfilled' ? (tr.value.data||[]).map(t=>fmtTrack(t)) : [],
      albums:    al.status==='fulfilled' ? (al.value.data||[]).map(fmtAlbum)       : [],
      artists:   ar.status==='fulfilled' ? (ar.value.data||[]).map(fmtArtist)      : [],
      playlists: pl.status==='fulfilled' ? (pl.value.data||[]).map(fmtPlaylist)    : [],
    });
  } catch (err) {
    console.error('[search]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/stream/:id', async (req, res) => {
  const dzId = req.params.id.replace(/^dz_/, '');
  try {
    // Get title + artist from Deezer so we can search Claudochrome
    const track  = await deezerGet(`/track/${dzId}`);
    const result = await resolveStream(dzId, track.title, track.artist?.name || '');
    res.json(result);
  } catch (err) {
    console.error('[stream]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/album/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const album = await deezerGet(`/album/${rawId}`);
    const cover = album.cover_xl || album.cover_big;
    res.json({
      id:`dz_${album.id}`, title:album.title, artist:album.artist?.name||'',
      artworkURL:cover, year:album.release_date?.slice(0,4),
      description:album.label||'', trackCount:album.nb_tracks,
      tracks:(album.tracks?.data||[]).map(t=>fmtTrack(t,album.title,cover)),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/artist/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const [artist, top, albums] = await Promise.all([
      deezerGet(`/artist/${rawId}`),
      deezerGet(`/artist/${rawId}/top`,    { limit:20 }),
      deezerGet(`/artist/${rawId}/albums`, { limit:20 }),
    ]);
    res.json({
      id:`dz_${artist.id}`, name:artist.name,
      artworkURL:artist.picture_xl||artist.picture_big,
      genres:[], bio:'',
      topTracks:(top.data||[]).map(t=>fmtTrack(t)),
      albums:(albums.data||[]).map(fmtAlbum),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/playlist/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const pl = await deezerGet(`/playlist/${rawId}`);
    res.json({
      id:`dz_${pl.id}`, title:pl.title, description:pl.description||'',
      artworkURL:pl.picture_xl||pl.picture_big,
      creator:pl.creator?.name||'',
      tracks:(pl.tracks?.data||[]).map(t=>fmtTrack(t)),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', async (req, res) => {
  let claudoOk = false, error = null;
  try {
    if (!CLAUDO_URL || !CLAUDO_TOKEN) throw new Error('CLAUDOCHROME_URL or CLAUDOCHROME_TOKEN not set');
    await axios.get(`${CLAUDO_URL}/u/${CLAUDO_TOKEN}/search`, { params:{ q:'test', limit:1 }, timeout:6000 });
    claudoOk = true;
  } catch (e) { error = e.message; }
  res.json({ status: claudoOk ? 'ok' : 'degraded', claudochrome: claudoOk, error, version: '4.0.0' });
});

app.listen(PORT, () => {
  console.log(`SpotiFLAC v4 → http://localhost:${PORT}`);
  console.log(`Claudochrome: ${CLAUDO_URL || '⚠ CLAUDOCHROME_URL not set'}`);
});
