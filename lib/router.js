import { archive } from './providers/archive.js';
import { streamCache } from './cache.js';

const SEARCH_BUDGET_MS = 8000;

function tierKey(raw) {
    const q = String(raw || 'LOSSLESS').toUpperCase();
    if (q.includes('HIGH')) return 'HIGH';
    if (q.includes('LOW')) return 'LOW';
    return 'LOSSLESS';
}

function within(promise, timeoutMs) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((resolve) => {
            timer = setTimeout(() => resolve({ tracks: [], error: 'timeout' }), timeoutMs);
        }),
    ]);
}

export async function searchAll(query, quality) {
    const q = String(query || '').trim();
    if (!q) return { tracks: [], perSource: {} };
    try {
        const result = await within(archive.search(q, quality), SEARCH_BUDGET_MS);
        const tracks = result?.tracks || [];
        return { tracks, perSource: { [archive.id]: { ok: !result?.error || tracks.length > 0, count: tracks.length } } };
    } catch {
        return { tracks: [], perSource: { [archive.id]: { ok: false, count: 0 } } };
    }
}

export async function resolveStream(id, quality) {
    const raw = String(id || '');
    const cacheKey = `final:${raw}:${tierKey(quality)}`;
    const cached = streamCache.get(cacheKey);
    if (cached !== undefined) return cached;
    try {
        const resolved = await archive.resolve(raw, quality);
        if (resolved) return streamCache.set(cacheKey, resolved);
    } catch {
    }
    return null;
}

export async function health() {
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    let check;
    try {
        const res = await fetch('https://archive.org/advancedsearch.php?q=mediatype%3Aaudio&fl%5B%5D=identifier&rows=1&output=json', {
            headers: { Accept: 'application/json' },
            signal: ac.signal,
        });
        const body = res.ok ? await res.json().catch(() => null) : null;
        const reachable = Array.isArray(body?.response?.docs);
        check = {
            provider: archive.key,
            reachable,
            latencyMs: Date.now() - started,
            ...(reachable ? {} : { reason: res.ok ? 'unexpected payload' : `http ${res.status}` }),
        };
    } catch (err) {
        check = { provider: archive.key, reachable: false, reason: `request failed (${err?.message || err})` };
    } finally {
        clearTimeout(timer);
    }
    return {
        ok: check.reachable,
        node: process.version,
        audioSources: [archive.name],
        providers: [check],
    };
}
