# BitChord Internet Archive FLAC Addon

An HTTP addon for [BitChord](https://github.com/kushagrasinghx/BitChord) that finds lossless FLAC files on the [Internet Archive](https://archive.org).

Before it hands BitChord a stream, it downloads the first 64 bytes of the file and reads the FLAC header to confirm the real sample rate and bit depth. Files that turn out to be HTML, MP3 or anything else are refused, so you never get a fake "lossless" stream.

Adapted from [juanjoblol/bitchord-hires-addon](https://github.com/juanjoblol/bitchord-hires-addon). The streaming-service providers were removed; this version uses only the Internet Archive.

## Deploy on Vercel

1. Push this folder to a GitHub repository.
2. On vercel.com: **Add New → Project**, import the repository, keep the default settings, and click **Deploy**.
3. Open `https://YOUR-PROJECT.vercel.app/manifest.json` and check that it shows JSON.

No environment variables are needed. If you add a custom domain, set `ADDON_HOSTS` to that domain (comma-separated for several) and redeploy, because BitChord signs requests per domain.

## Add to BitChord

**Settings → Sources → Add an addon**, paste `https://YOUR-PROJECT.vercel.app`, and tap **Test**.

`/search`, `/stream` and `/health` only answer requests signed by the BitChord app, so opening them in a browser returns `401`. That is expected.

## Endpoints

- `GET /manifest.json`
- `GET /health`: checks that archive.org is reachable
- `GET /search?q=...`: FLAC tracks, best matches first
- `GET /stream/{id}`: verified FLAC URL with sample rate and bit depth

## Develop

```
npm run dev   # http://localhost:8787
npm test      # offline tests with simulated archive.org responses
```

## Files

- `api/index.js`: HTTP handler and manifest
- `lib/router.js`: search, stream resolution, health
- `lib/providers/archive.js`: Internet Archive search and file listing
- `lib/flac.js`: FLAC header parser and URL probe
- `lib/cache.js`: in-memory TTL cache
- `lib/bitchord-addon-auth.mjs`: verifies BitChord's signed requests

Audio comes from the Internet Archive. Respect each item's license.
