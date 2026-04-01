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
//  Spotify anonymous token (no account needed)
// ─────────────────────────────────────────────
let _spotToken  = null;
let _spotExpiry = 0;

async function getSpotifyToken() {
  if (_spotToken && Date.now() < _spotExpiry) return _spotToken;
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await axios.get(
        'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/json',
          },
          timeout: 8000,
        }
      );
      _spotToken  = res.data.accessToken;
      // Refresh 2 minutes before expiry
      _spotExpiry = res.data.accessTokenExpirationTimestampMs - 120_000;
      console.log(`[Spotify] token refreshed (attempt ${attempt})`);
      return _spotToken;
    } catch (err) {
      lastErr = err;
      console.warn(`[Spotify] token attempt ${attempt} failed:`, err.message);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error('Failed to obtain Spotify token: ' + lastErr?.message);
}

// ─────────────────────────────────────────────
//  Spotify API helper
// ─────────────────────────────────────────────
async function spotifyGet(endpoint, params = {}) {
  const token = await getSpotifyToken();
  const res   = await axios.get(`https://api.spotify.com/v1${endpoint}`, {
    params,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10_000,
  });
  return res.data;
}

// ─────────────────────────────────────────────
//  Stream resolution via TidalFi (doubleld.top)
//  — same backend SpotiFLAC uses internally
//  Set HIFI_URL env var to use a different instance
// ─────────────────────────────────────────────
const HIFI_BASE = (process.env.HIFI_URL || 'https://doubleld.top').replace(/\/$/, '');

// In-memory stream-URL cache (avoids hammering backend for same track)
const streamCache = new Map();

async function resolveStreamUrl(spotifyId, isrc) {
  const cacheKey = `${spotifyId}:${isrc}`;
  const cached   = streamCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  let lastErr;

  // ── Strategy 1: ISRC lookup (Tidal API pattern — mirrors SpotiFLAC behavior) ──
  if (isrc) {
    try {
      // Find Tidal track ID by ISRC
      const searchRes = await axios.get(`${HIFI_BASE}/v1/tracks`, {
        params: { isrc, countryCode: 'US' },
        timeout: 8000,
      });
      const tidalTrack = searchRes.data?.items?.[0];
      if (tidalTrack?.id) {
        // Get FLAC stream URL from Tidal track ID
        const streamRes = await axios.get(
          `${HIFI_BASE}/v1/tracks/${tidalTrack.id}/streamUrl`,
          {
            params: { soundQuality: 'LOSSLESS' },
            timeout: 8000,
          }
        );
        if (streamRes.data?.url) {
          const result = {
            url:      streamRes.data.url,
            format:   'flac',
            quality:  streamRes.data.soundQuality || 'lossless',
            expiresAt: Date.now() + 5 * 60 * 1000, // Tidal URLs expire ~5 min
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

  // ── Strategy 2: Direct proxy stream (if your HIFI_URL follows Eclipse addon pattern) ──
  try {
    const streamRes = await axios.get(`${HIFI_BASE}/stream/${spotifyId}`, { timeout: 8000 });
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
    console.warn(`[Stream] direct stream lookup failed for ${spotifyId}:`, err.message);
  }

  throw new Error(`Could not resolve stream for ${spotifyId}: ${lastErr?.message}`);
}

// ─────────────────────────────────────────────
//  Format helpers
// ─────────────────────────────────────────────
function fmtTrack(t, albumName) {
  return {
    id:        `spot_${t.id}`,
    title:     t.name,
    artist:    (t.artists || []).map(a => a.name).join(', '),
    album:     t.album?.name || albumName || '',
    duration:  t.duration_ms ? Math.round(t.duration_ms / 1000) : undefined,
    artworkURL: t.album?.images?.[0]?.url || undefined,
    isrc:      t.external_ids?.isrc || undefined,  // ← Eclipse uses this for lyrics/artwork enrichment
    format:    'flac',
  };
}

function fmtAlbum(a) {
  return {
    id:         `spot_${a.id}`,
    title:      a.name,
    artist:     (a.artists || []).map(x => x.name).join(', '),
    artworkURL: a.images?.[0]?.url || undefined,
    trackCount: a.total_tracks,
    year:       a.release_date?.slice(0, 4),
  };
}

function fmtArtist(a) {
  return {
    id:         `spot_${a.id}`,
    name:       a.name,
    artworkURL: a.images?.[0]?.url || undefined,
    genres:     a.genres || [],
  };
}

function fmtPlaylist(p) {
  return {
    id:          `spot_${p.id}`,
    title:       p.name,
    creator:     p.owner?.display_name || '',
    artworkURL:  p.images?.[0]?.url || undefined,
    trackCount:  p.tracks?.total,
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
    version:     '1.0.0',
    description: 'Spotify search + FLAC streams via TidalFi',
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
    const data = await spotifyGet('/search', {
      q,
      type:   'track,album,artist,playlist',
      limit:  20,
      market: 'US',
    });

    res.json({
      tracks:    (data.tracks?.items    || []).filter(t => t?.id).map(t  => fmtTrack(t)),
      albums:    (data.albums?.items    || []).filter(a => a?.id).map(a  => fmtAlbum(a)),
      artists:   (data.artists?.items   || []).filter(a => a?.id).map(a  => fmtArtist(a)),
      playlists: (data.playlists?.items || []).filter(p => p?.id).map(p  => fmtPlaylist(p)),
    });
  } catch (err) {
    console.error('[Search] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  GET /stream/:id
//  id format: spot_{spotifyTrackId}
// ─────────────────────────────────────────────
app.get('/stream/:id', async (req, res) => {
  const rawId = req.params.id.replace(/^spot_/, '');
  try {
    // Fetch fresh Spotify track data so we always have the ISRC
    const track  = await spotifyGet(`/tracks/${rawId}`, { market: 'US' });
    const isrc   = track.external_ids?.isrc;
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
  const rawId = req.params.id.replace(/^spot_/, '');
  try {
    const [album, tracksData] = await Promise.all([
      spotifyGet(`/albums/${rawId}`,        { market: 'US' }),
      spotifyGet(`/albums/${rawId}/tracks`, { market: 'US', limit: 50 }),
    ]);

    const coverUrl = album.images?.[0]?.url;

    res.json({
      id:         `spot_${album.id}`,
      title:      album.name,
      artist:     (album.artists || []).map(a => a.name).join(', '),
      artworkURL: coverUrl,
      year:       album.release_date?.slice(0, 4),
      description: album.label || '',
      trackCount: album.total_tracks,
      tracks: (tracksData.items || []).map(t => ({
        ...fmtTrack(t, album.name),
        artworkURL: coverUrl,  // album tracks don't have individual artwork in Spotify's response
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
  const rawId = req.params.id.replace(/^spot_/, '');
  try {
    const [artist, topData, albumsData] = await Promise.all([
      spotifyGet(`/artists/${rawId}`),
      spotifyGet(`/artists/${rawId}/top-tracks`, { market: 'US' }),
      spotifyGet(`/artists/${rawId}/albums`,     { market: 'US', limit: 20, include_groups: 'album,single' }),
    ]);

    res.json({
      id:         `spot_${artist.id}`,
      name:       artist.name,
      artworkURL: artist.images?.[0]?.url,
      genres:     artist.genres || [],
      bio:        '',
      topTracks:  (topData.tracks  || []).map(t => fmtTrack(t)),
      albums:     (albumsData.items || []).map(a => fmtAlbum(a)),
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
  const rawId = req.params.id.replace(/^spot_/, '');
  try {
    const playlist = await spotifyGet(`/playlists/${rawId}`, { market: 'US' });

    res.json({
      id:          `spot_${playlist.id}`,
      title:       playlist.name,
      description: playlist.description || '',
      artworkURL:  playlist.images?.[0]?.url,
      creator:     playlist.owner?.display_name || '',
      tracks: (playlist.tracks?.items || [])
        .filter(i => i?.track?.id)
        .map(i => fmtTrack(i.track)),
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
  let spotOk = false;
  try { await getSpotifyToken(); spotOk = true; } catch {}
  res.json({
    status:   spotOk ? 'ok' : 'degraded',
    spotify:  spotOk,
    hifiBase: HIFI_BASE,
    version:  '1.0.0',
  });
});

// ─────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`SpotiFLAC addon running → http://localhost:${PORT}`);
  console.log(`Hi-Fi backend: ${HIFI_BASE}`);
  getSpotifyToken()
    .then(() => console.log('[Spotify] token ready'))
    .catch(e  => console.error('[Spotify] token failed on startup:', e.message));
});
