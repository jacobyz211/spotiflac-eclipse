const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//  Deezer API — zero auth, zero keys, free forever
//  Returns ISRC on every track (Eclipse uses this
//  for lyrics, artwork & metadata enrichment)
// ─────────────────────────────────────────────
const DZ = 'https://api.deezer.com';

async function deezerGet(endpoint, params = {}) {
  const res = await axios.get(`${DZ}${endpoint}`, { params, timeout: 10_000 });
  if (res.data?.error) throw new Error(`Deezer error: ${res.data.error.message}`);
  return res.data;
}

// ─────────────────────────────────────────────
//  Stream resolution via TidalFi (doubleld.top)
//  — same backend SpotiFLAC uses internally
//  Set HIFI_URL env var to use a different instance
// ─────────────────────────────────────────────
const HIFI_BASE = (process.env.HIFI_URL || 'https://doubleld.top').replace(/\/$/, '');

const streamCache = new Map();

async function resolveStreamUrl(trackId, isrc) {
  const cacheKey = `${trackId}:${isrc}`;
  const cached   = streamCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  let lastErr;

  // ── Strategy 1: ISRC lookup (Tidal API pattern) ──
  if (isrc) {
    try {
      const searchRes = await axios.get(`${HIFI_BASE}/v1/tracks`, {
        params: { isrc, countryCode: 'US' },
        timeout: 8000,
      });
      const tidalTrack = searchRes.data?.items?.[0];
      if (tidalTrack?.id) {
        const streamRes = await axios.get(
          `${HIFI_BASE}/v1/tracks/${tidalTrack.id}/streamUrl`,
          { params: { soundQuality: 'LOSSLESS' }, timeout: 8000 }
        );
        if (streamRes.data?.url) {
          const result = {
            url:      streamRes.data.url,
            format:   'flac',
            quality:  streamRes.data.soundQuality || 'lossless',
            expiresAt: Date.now() + 5 * 60 * 1000,
          };
          streamCache.set(cacheKey, result);
          return result;
        }
      }
    } catch (err) {
      lastErr = err;
      console.warn(`[Stream] ISRC lookup failed for ${isrc}:`, err.message);
    }
  }

  // ── Strategy 2: Direct proxy stream ──
  try {
    const streamRes = await axios.get(`${HIFI_BASE}/stream/${trackId}`, { timeout: 8000 });
    if (streamRes.data?.url) {
      const result = {
        url:      streamRes.data.url,
        format:   streamRes.data.format   || 'flac',
        quality:  streamRes.data.quality  || 'lossless',
        expiresAt: streamRes.data.expiresAt || Date.now() + 5 * 60 * 1000,
      };
      streamCache.set(cacheKey, result);
      return result;
    }
  } catch (err) {
    lastErr = err;
    console.warn(`[Stream] direct stream lookup failed for ${trackId}:`, err.message);
  }

  throw new Error(`Could not resolve stream for ${trackId}: ${lastErr?.message}`);
}

// ─────────────────────────────────────────────
//  Format helpers
// ─────────────────────────────────────────────
function fmtTrack(t, albumName, albumCover) {
  return {
    id:         `dz_${t.id}`,
    title:      t.title,
    artist:     t.artist?.name || '',
    album:      t.album?.title || albumName || '',
    duration:   t.duration,
    artworkURL: t.album?.cover_xl || t.album?.cover_big || albumCover || undefined,
    isrc:       t.isrc || undefined,  // ← Eclipse uses this for enrichment
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
    creator:     p.user?.name || '',
    artworkURL:  p.picture_xl || p.picture_big || undefined,
    trackCount:  p.nb_tracks,
    description: p.description || '',
  };
}

// ─────────────────────────────────────────────
//  GET /manifest.json
// ─────────────────────────────────────────────
app.get('/manifest.json', (req, res) => {
  res.json({
    id:          'com.spotiflac.eclipse',
    name:        'SpotiFLAC',
    version:     '2.0.0',
    description: 'Deezer search + FLAC streams via TidalFi. No account needed.',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist', 'playlist'],
  });
});

// ─────────────────────────────────────────────
//  GET /search?q=
// ─────────────────────────────────────────────
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });

  try {
    // Run all four searches in parallel
    const [tracksData, albumsData, artistsData, playlistsData] = await Promise.allSettled([
      deezerGet('/search',          { q, limit: 20 }),
      deezerGet('/search/album',    { q, limit: 10 }),
      deezerGet('/search/artist',   { q, limit: 10 }),
      deezerGet('/search/playlist', { q, limit: 10 }),
    ]);

    res.json({
      tracks:    tracksData.status    === 'fulfilled' ? (tracksData.value.data    || []).map(t => fmtTrack(t))    : [],
      albums:    albumsData.status    === 'fulfilled' ? (albumsData.value.data    || []).map(a => fmtAlbum(a))    : [],
      artists:   artistsData.status   === 'fulfilled' ? (artistsData.value.data   || []).map(a => fmtArtist(a))  : [],
      playlists: playlistsData.status === 'fulfilled' ? (playlistsData.value.data || []).map(p => fmtPlaylist(p)) : [],
    });
  } catch (err) {
    console.error('[Search] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  GET /stream/:id
//  id format: dz_{deezerTrackId}
// ─────────────────────────────────────────────
app.get('/stream/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    // Fetch fresh track data to get ISRC
    const track  = await deezerGet(`/track/${rawId}`);
    const isrc   = track.isrc;
    const result = await resolveStreamUrl(rawId, isrc);
    res.json(result);
  } catch (err) {
    console.error('[Stream] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  GET /album/:id
// ─────────────────────────────────────────────
app.get('/album/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const album = await deezerGet(`/album/${rawId}`);
    const cover = album.cover_xl || album.cover_big;

    res.json({
      id:         `dz_${album.id}`,
      title:      album.title,
      artist:     album.artist?.name || '',
      artworkURL: cover,
      year:       album.release_date?.slice(0, 4),
      description: album.label || '',
      trackCount: album.nb_tracks,
      tracks: (album.tracks?.data || []).map(t => ({
        ...fmtTrack(t, album.title, cover),
      })),
    });
  } catch (err) {
    console.error('[Album] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  GET /artist/:id
// ─────────────────────────────────────────────
app.get('/artist/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const [artist, topData, albumsData] = await Promise.all([
      deezerGet(`/artist/${rawId}`),
      deezerGet(`/artist/${rawId}/top`, { limit: 20 }),
      deezerGet(`/artist/${rawId}/albums`, { limit: 20 }),
    ]);

    res.json({
      id:         `dz_${artist.id}`,
      name:       artist.name,
      artworkURL: artist.picture_xl || artist.picture_big,
      genres:     [],
      bio:        '',
      topTracks:  (topData.data    || []).map(t => fmtTrack(t)),
      albums:     (albumsData.data || []).map(a => fmtAlbum(a)),
    });
  } catch (err) {
    console.error('[Artist] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  GET /playlist/:id
// ─────────────────────────────────────────────
app.get('/playlist/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^dz_/, '');
  try {
    const playlist = await deezerGet(`/playlist/${rawId}`);

    res.json({
      id:          `dz_${playlist.id}`,
      title:       playlist.title,
      description: playlist.description || '',
      artworkURL:  playlist.picture_xl || playlist.picture_big,
      creator:     playlist.creator?.name || '',
      tracks: (playlist.tracks?.data || []).map(t => fmtTrack(t)),
    });
  } catch (err) {
    console.error('[Playlist] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  GET /health
// ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  let deezerOk = false;
  try {
    await deezerGet('/search', { q: 'test', limit: 1 });
    deezerOk = true;
  } catch {}
  res.json({
    status:   deezerOk ? 'ok' : 'degraded',
    deezer:   deezerOk,
    hifiBase: HIFI_BASE,
    version:  '2.0.0',
  });
});

// ─────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`SpotiFLAC addon (v2 — Deezer backend) → http://localhost:${PORT}`);
  console.log(`Hi-Fi stream backend: ${HIFI_BASE}`);
});
