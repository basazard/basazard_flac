import { describeAudioUrl, qualityLabel } from '../flac.js';
import { searchCache, streamCache, probeCache, createCache } from '../cache.js';

const PREFIX = 'ia';
const BASE = 'https://archive.org';
const HEADERS = { Accept: 'application/json', 'User-Agent': 'bitchord-archive-addon/1.0' };
const ITEMS_PER_SEARCH = 8;
const MAX_TRACKS = 40;
const metadataCache = createCache(60 * 60 * 1000, 300);

async function getJson(url, timeoutMs = 6000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, { headers: HEADERS, signal: ac.signal });
        if (!res.ok) return { error: `archive ${res.status}` };
        return await res.json();
    } catch (err) {
        return { error: String(err?.message || err) };
    } finally {
        clearTimeout(timer);
    }
}

function b64url(text) {
    return Buffer.from(text, 'utf8').toString('base64url');
}

function fromB64url(text) {
    try {
        return Buffer.from(text, 'base64url').toString('utf8');
    } catch {
        return '';
    }
}

export function encodeId(identifier, file) {
    return `${PREFIX}:${b64url(`${identifier}/${file}`)}`;
}

export function decodeId(id) {
    const raw = String(id || '');
    if (!raw.startsWith(`${PREFIX}:`)) return null;
    const decoded = fromB64url(raw.slice(PREFIX.length + 1));
    const slash = decoded.indexOf('/');
    if (slash <= 0 || slash === decoded.length - 1) return null;
    const identifier = decoded.slice(0, slash);
    const file = decoded.slice(slash + 1);
    if (!/^[A-Za-z0-9._-]+$/.test(identifier) || file.includes('..')) return null;
    return { identifier, file };
}

function first(value) {
    return Array.isArray(value) ? value[0] : value;
}

export function parseLength(value) {
    const v = String(first(value) ?? '').trim();
    if (!v) return undefined;
    if (v.includes(':')) {
        const seconds = v.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
        return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : undefined;
    }
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function isFlac(file) {
    const format = String(file?.format || '').toLowerCase();
    return format.includes('flac') || /\.flac$/i.test(String(file?.name || ''));
}

function fileUrl(identifier, file) {
    return `${BASE}/download/${encodeURIComponent(identifier)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

function titleFromFilename(name) {
    return name.split('/').pop().replace(/\.flac$/i, '').replace(/[_]+/g, ' ').trim();
}

async function getMetadata(identifier) {
    return metadataCache.wrap(identifier, () => getJson(`${BASE}/metadata/${encodeURIComponent(identifier)}`));
}

function words(text) {
    return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9]+/).filter((w) => w.length > 1);
}

export function tracksFromMetadata(identifier, meta, query) {
    const files = Array.isArray(meta?.files) ? meta.files : [];
    const itemTitle = first(meta?.metadata?.title) || identifier;
    const itemArtist = first(meta?.metadata?.creator) || '';
    const terms = words(query);
    const rows = [];
    for (const file of files) {
        if (!file?.name || !isFlac(file)) continue;
        const title = first(file.title) || titleFromFilename(file.name);
        const artist = first(file.artist) || first(file.creator) || itemArtist;
        const haystack = new Set(words(`${title} ${artist} ${itemTitle}`));
        const score = terms.filter((t) => haystack.has(t)).length;
        rows.push({
            score,
            row: {
                id: encodeId(identifier, file.name),
                title,
                artist,
                album: first(file.album) || itemTitle,
                duration: parseLength(file.length),
                artworkURL: `${BASE}/services/img/${encodeURIComponent(identifier)}`,
                format: 'flac',
                audioQuality: 'LOSSLESS',
                source: 'Internet Archive',
            },
        });
    }
    return rows;
}

export async function search(query) {
    const q = String(query || '').trim();
    if (!q) return { tracks: [], error: null };

    return searchCache.wrap(`ia:${q.toLowerCase()}`, async () => {
        const params = new URLSearchParams({
            q: `(${q}) AND mediatype:audio AND format:(FLAC OR "24bit Flac")`,
            rows: String(ITEMS_PER_SEARCH),
            output: 'json',
        });
        for (const field of ['identifier', 'title', 'creator']) params.append('fl[]', field);
        const payload = await getJson(`${BASE}/advancedsearch.php?${params}`);
        if (payload?.error) return { tracks: [], error: payload.error };

        const docs = Array.isArray(payload?.response?.docs) ? payload.response.docs : [];
        const metas = await Promise.all(docs.map((d) => getMetadata(d.identifier).catch(() => null)));

        const scored = [];
        docs.forEach((doc, i) => {
            if (metas[i] && !metas[i].error) scored.push(...tracksFromMetadata(doc.identifier, metas[i], q));
        });
        scored.sort((a, b) => b.score - a.score);
        const tracks = scored.slice(0, MAX_TRACKS).map((s) => s.row);
        return { tracks, error: tracks.length ? null : 'no FLAC files found' };
    });
}

export async function resolve(id) {
    const parsed = decodeId(id);
    if (!parsed) return null;
    const { identifier, file } = parsed;

    return streamCache.wrap(`ia:${identifier}/${file}`, async () => {
        const url = fileUrl(identifier, file);
        const described = await probeCache.wrap(url, () => describeAudioUrl(url));
        // Only hand BitChord a stream when the file really is FLAC.
        if (described?.error || described.codec !== 'flac' || !described.sampleRate) return null;

        return {
            url: described.url,
            codec: 'flac',
            container: 'flac',
            manifest: 'none',
            mimeType: 'audio/flac',
            encrypted: false,
            sampleRate: described.sampleRate,
            ...(described.bitDepth ? { bitDepth: described.bitDepth } : {}),
            ...(described.channels ? { channels: described.channels } : {}),
            ...(described.bitrate ? { bitrate: described.bitrate } : {}),
            format: 'flac',
            quality: qualityLabel(described),
            provider: 'Internet Archive',
        };
    });
}

export const archive = { id: PREFIX, key: 'archive', name: 'Internet Archive', search, resolve };
