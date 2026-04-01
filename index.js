const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const HIFI_BASE = (process.env.HIFI_URL || 'https://doubleld.top').replace(/\/$/, '');
const DZ = 'https://api.deezer.com';

app.use(cors());
app.use(express.json());

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SpotiFLAC — Eclipse Addon</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300..700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0a0b;
      --surface: #111113;
      --surface2: #1a1a1d;
      --border: rgba(255,255,255,0.08);
      --text: #e8e8ea;
      --muted: #8a8a92;
      --green: #1ed760;
      --greenDim: rgba(30,215,96,0.12);
      --radius: 14px;
    }
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    nav {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      height: 64px;
      border-bottom: 1px solid var(--border);
      background: rgba(10,10,11,0.85);
      backdrop-filter: blur(12px);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 15px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--green);
      box-shadow: 0 0 10px var(--green);
    }
    .badge {
      font-size: 11px;
      font-weight: 700;
      color: var(--green);
      border: 1px solid rgba(30,215,96,0.25);
      background: var(--greenDim);
      border-radius: 999px;
      padding: 4px 10px;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .hero {
      max-width: 920px;
      margin: 0 auto;
      padding: 72px 24px 40px;
      text-align: center;
    }
    .eyebrow {
      color: var(--green);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
      margin-bottom: 14px;
    }
    h1 {
      font-size: clamp(2.4rem, 6vw, 4.8rem);
      line-height: 1.05;
      letter-spacing: -0.04em;
      margin-bottom: 16px;
    }
    h1 span { color: var(--green); }
    .sub {
      color: var(--muted);
      max-width: 620px;
      margin: 0 auto 20px;
      font-size: 17px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--border);
      background: var(--surface);
      border-radius: 999px;
      padding: 8px 14px;
      font-size: 13px;
      color: var(--muted);
      cursor: pointer;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #666;
    }
    .status-dot.ok {
      background: var(--green);
      box-shadow: 0 0 8px var(--green);
    }
    .status-dot.bad {
      background: #ff5a6a;
      box-shadow: 0 0 8px #ff5a6a;
    }
    .section {
      max-width: 760px;
      margin: 0 auto;
      padding: 0 24px 48px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .card-head {
      padding: 16px 18px;
      border-bottom: 1px solid var(--border);
      font-size: 14px;
      font-weight: 700;
    }
    .row {
      display: flex;
      gap: 12px;
      align-items: center;
      padding: 16px 18px;
      flex-wrap: wrap;
    }
    .url {
      flex: 1;
      min-width: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .url em {
      color: var(--green);
      font-style: normal;
    }
    button {
      border: 0;
      cursor: pointer;
      border-radius: 10px;
      background: var(--green);
      color: #000;
      font-weight: 800;
      padding: 10px 16px;
    }
    .steps {
      display: grid;
      gap: 12px;
      margin-top: 18px;
    }
    .step {
      display: flex;
      gap: 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 16px;
    }
    .num {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--greenDim);
      color: var(--green);
      border: 1px solid rgba(30,215,96,0.24);
      font-size: 12px;
      font-weight: 800;
    }
    .text {
      color: var(--muted);
      font-size: 14px;
    }
    .text strong { color: var(--text); }
    .features {
      max-width: 1040px;
      margin: 0 auto;
      padding: 0 24px 56px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 14px;
    }
    .feature {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px;
    }
    .feature h3 {
      font-size: 15px;
      margin-bottom: 6px;
    }
    .feature p {
      color: var(--muted);
      font-size: 14px;
    }
    footer {
      border-top: 1px solid var(--border);
      color: var(--muted);
      text-align: center;
      font-size: 13px;
      padding: 22px;
    }
  </style>
</head>
<body>
  <nav>
    <div class="brand"><div class="dot"></div>SpotiFLAC</div>
    <div class="badge">Eclipse Addon</div>
  </nav>

  <section class="hero">
    <div class="eyebrow">Eclipse Music · Community Addon</div>
    <h1>Deezer search.<br><span>FLAC quality.</span></h1>
    <p class="sub">Search tracks, albums, artists, and playlists through Deezer, then resolve playback to FLAC streams through your Hi-Fi backend.</p>
    <div class="status" onclick="checkHealth()">
      <div class="status-dot" id="dot"></div>
      <span id="statusText">Checking status…</span>
    </div>
  </section>

  <section class="section">
    <div class="card">
      <div class="card-head">Addon URL</div>
      <div class="row">
        <div class="url" id="addonUrl"><em>loading…</em></div>
        <button id="copyBtn" onclick="copyUrl()">Copy</button>
      </div>
    </div>

    <div class="steps">
      <div class="step"><div class="num">1</div><div class="text">Open <strong>Eclipse Music</strong>.</div></div>
      <div class="step"><div class="num">2</div><div class="text">Go to <strong>Settings → Connections → Add Connection → Addon</strong>.</div></div>
      <div class="step"><div class="num">3</div><div class="text">Paste your <strong>manifest URL</strong> and install it.</div></div>
      <div class="step"><div class="num">4</div><div class="text">Optional: set it as <strong>Default Playback</strong> in addon management.</div></div>
    </div>
  </section>

  <section class="features">
    <div class="feature">
      <h3>No Spotify app needed</h3>
      <p>This build avoids Spotify developer access entirely and uses Deezer for metadata search.</p>
    </div>
    <div class="feature">
      <h3>ISRC-friendly</h3>
      <p>Track ISRC values are passed through when available so Eclipse can enrich metadata.</p>
    </div>
    <div class="feature">
      <h3>Catalog browsing</h3>
      <p>Albums, artists, and playlists all have native endpoints for Eclipse browsing.</p>
    </div>
    <div class="feature">
      <h3>One file deploy</h3>
      <p>No public folder, no missing index.html, and nothing extra for Render to stat.</p>
    </div>
  </section>

  <footer>SpotiFLAC Eclipse Addon · single-file build</footer>

  <script>
    const manifestUrl = window.location.origin + '/manifest.json';
    document.getElementById('addonUrl').innerHTML = '<em>' + window.location.origin + '</em>/manifest.json';

    async function copyUrl() {
      await navigator.clipboard.writeText(manifestUrl);
      const btn = document.getElementById('copyBtn');
      btn.textContent = 'Copied';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    }

    async function checkHealth() {
      const dot = document.getElementById('dot');
      const text = document.getElementById('statusText');
      dot.className = 'status-dot';
      text.textContent = 'Checking status…';
      try {
        const res = await fetch('/health');
        const data = await res.json();
        if (data.deezer) {
          dot.className = 'status-dot ok';
          text.textContent = 'Online — Deezer API ready';
        } else {
          dot.className = 'status-dot bad';
          text.textContent = 'Deezer API unavailable';
        }
      } catch {
        dot.className = 'status-dot bad';
        text.textContent = 'Addon offline';
      }
    }

    checkHealth();
  </script>
</body>
</html>`;

async function deezerGet(endpoint, params = {}) {
  const res = await axios.get(`${DZ}${endpoint}`, { params, timeout: 10000 });
  if (res.data?.error) throw new Error(`Deezer error: ${res.data.error.message}`);
  return res.data;
}

const streamCache = new Map();

async function resolveStreamUrl(trackId, isrc) {
  const cacheKey = `${trackId}:${isrc || ''}`;
  const cached = streamCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  let lastErr;

  if (isrc) {
    try {
      const searchRes = await axios.get(`${HIFI_BASE}/v1/tracks`, {
        params: { isrc, countryCode: 'US' },
        timeout: 8000,
      });
      const tidalTrack = searchRes.data?.items?.[0];
      if (tidalTrack?.id) {
        const streamRes = await axios.get(`${HIFI_BASE}/v1/tracks/${tidalTrack.id}/streamUrl`, {
          params: { soundQuality: 'LOSSLESS' },
          timeout: 8000,
        });
        if (streamRes.data?.url) {
          const result = {
            url: streamRes.data.url,
            format: 'flac',
            quality: streamRes.data.soundQuality || 'lossless',
            expiresAt: Date.now() + 5 * 60 * 1000,
          };
          streamCache.set(cacheKey, result);
          return result;
        }
      }
    } catch (err) {
      lastErr = err;
      console.warn('[stream] isrc lookup failed:', err.message);
    }
  }

  try {
    const streamRes = await axios.get(`${HIFI_BASE}/stream/${trackId}`, { timeout: 8000 });
    if (streamRes.data?.url) {
      const result = {
        url: streamRes.data.url,
        format: streamRes.data.format || 'flac',
        quality: streamRes.data.quality || 'lossless',
        expiresAt: streamRes.data.expiresAt || Date.now() + 5 * 60 * 1000,
      };
      streamCache.set(cacheKey, result);
      return result;
    }
  } catch (err) {
    lastErr = err;
    console.warn('[stream] direct lookup failed:', err.message);
  }

  throw new Error(`Could not resolve stream: ${lastErr?.message || 'unknown error'}`);
}

function fmtTrack(t, albumName, albumCover) {
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

app.get('/', (req, res) => {
  res.type('html').send(LANDING_HTML);
});

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'com.spotiflac.eclipse',
    name: 'SpotiFLAC',
    version: '2.1.0',
    description: 'Deezer search + FLAC streams via TidalFi. Single-file build.',
    resources: ['search', 'stream', 'catalog'],
    types: ['track', 'album', 'artist', 'playlist'],
  });
});

app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });

  try {
    const [tracksData, albumsData, artistsData, playlistsData] = await Promise.allSettled([
      deezerGet('/search', { q, limit: 20 }),
      deezerGet('/search/album', { q, limit: 10 }),
      deezerGet('/search/artist', { q, limit: 10 }),
      deezerGet('/search/playlist', { q, limit: 10 }),
    ]);

    res.json({
      tracks: tracksData.status === 'fulfilled' ? (tracksData.value.data || []).map(fmtTrack) : [],
      albums: albumsData.status === 'fulfilled' ? (albumsData.value.data || []).map(fmtAlbum) : [],
      artists: artistsData.status === 'fulfilled' ? (artistsData.value.data || []).map(fmtArtist) : [],
      playlists: playlistsData.status === 'fulfilled' ? (playlistsData.value.data || []).map(fmtPlaylist) : [],
    });
  } catch (err) {
    console.error('[search] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/stream/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const track = await deezerGet(`/track/${rawId}`);
    const result = await resolveStreamUrl(rawId, track.isrc);
    res.json(result);
  } catch (err) {
    console.error('[stream] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/album/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const album = await deezerGet(`/album/${rawId}`);
    const cover = album.cover_xl || album.cover_big;
    res.json({
      id: `dz_${album.id}`,
      title: album.title,
      artist: album.artist?.name || '',
      artworkURL: cover,
      year: album.release_date?.slice(0, 4),
      description: album.label || '',
      trackCount: album.nb_tracks,
      tracks: (album.tracks?.data || []).map(t => fmtTrack(t, album.title, cover)),
    });
  } catch (err) {
    console.error('[album] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/artist/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const [artist, topData, albumsData] = await Promise.all([
      deezerGet(`/artist/${rawId}`),
      deezerGet(`/artist/${rawId}/top`, { limit: 20 }),
      deezerGet(`/artist/${rawId}/albums`, { limit: 20 }),
    ]);

    res.json({
      id: `dz_${artist.id}`,
      name: artist.name,
      artworkURL: artist.picture_xl || artist.picture_big,
      genres: [],
      bio: '',
      topTracks: (topData.data || []).map(fmtTrack),
      albums: (albumsData.data || []).map(fmtAlbum),
    });
  } catch (err) {
    console.error('[artist] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/playlist/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const playlist = await deezerGet(`/playlist/${rawId}`);
    res.json({
      id: `dz_${playlist.id}`,
      title: playlist.title,
      description: playlist.description || '',
      artworkURL: playlist.picture_xl || playlist.picture_big,
      creator: playlist.creator?.name || '',
      tracks: (playlist.tracks?.data || []).map(fmtTrack),
    });
  } catch (err) {
    console.error('[playlist] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', async (req, res) => {
  let deezerOk = false;
  try {
    await deezerGet('/search', { q: 'test', limit: 1 });
    deezerOk = true;
  } catch {}
  res.json({
    status: deezerOk ? 'ok' : 'degraded',
    deezer: deezerOk,
    hifiBase: HIFI_BASE,
    version: '2.1.0',
  });
});

app.listen(PORT, () => {
  console.log(`SpotiFLAC single-file addon → http://localhost:${PORT}`);
  console.log(`Hi-Fi stream backend: ${HIFI_BASE}`);
});
