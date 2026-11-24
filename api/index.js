import { searchAll, resolveStream, health } from '../lib/router.js';
import { createBitChordAuth } from '../lib/bitchord-addon-auth.mjs';
// BitChord signs each request for the addon's hostname, so the auth check must
// know every domain this deployment answers on. Vercel provides its own domains
// automatically; add custom domains as a comma-separated ADDON_HOSTS variable.
const hosts = [
    ...String(process.env.ADDON_HOSTS || '').split(','),
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_URL,
    'localhost',
].map((h) => String(h || '').trim()).filter(Boolean);
const bitchord = createBitChordAuth({ hosts });
const MANIFEST = {
    id: 'dev.basazard.bitchord-archive-flac',
    name: 'Internet Archive FLAC',
    version: '2.0.0',
    description: 'Lossless FLAC from the Internet Archive. Every stream is checked to be real FLAC before playback.',
    resources: ['search', 'stream'],
    bitchordAuth: true,
    checkValidLossless: 1,
    allowDownloads: 1,
};
function json(res, status, body, extraHeaders = {}) {
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-BitChord-Token, X-BitChord-Proof',
        'Access-Control-Expose-Headers': 'WWW-Authenticate',
    };
    for (const [key, value] of Object.entries(extraHeaders)) {
        const existing = Object.keys(headers).find((name) => name.toLowerCase() === key.toLowerCase());
        if (existing)
            delete headers[existing];
        headers[key] = value;
    }
    res.writeHead(status, headers);
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
export default async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/api/index.js' || path === '/api/index') {
        const original = url.searchParams.get('path');
        if (original !== null) {
            path = ('/' + original).replace(/\/+$/, '') || '/';
        }
    }
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-BitChord-Token, X-BitChord-Proof',
            'Access-Control-Max-Age': '86400',
        });
        return res.end();
    }
    if (req.method !== 'GET') {
        return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET, OPTIONS' });
    }
    if (path === '/' || path === '/manifest.json') {
        return json(res, 200, MANIFEST);
    }
    const auth = await bitchord.verifyRequest(req);
    if (!auth.ok) {
        const rejection = bitchord.rejection(auth);
        return json(res, rejection.status, rejection.body, rejection.headers);
    }
    if (path === '/health') {
        try {
            const report = await health();
            return json(res, 200, report);
        }
        catch (err) {
            return json(res, 500, { ok: false, error: String(err?.message || err) });
        }
    }
    if (path === '/search') {
        const query = url.searchParams.get('q') || '';
        if (!query.trim())
            return json(res, 200, { tracks: [] });
        try {
            const { tracks, perSource } = await searchAll(query, url.searchParams.get('quality'));
            return json(res, 200, { tracks }, { 'X-Addon-Sources': encodeURIComponent(JSON.stringify(perSource)) });
        }
        catch (err) {
            return json(res, 200, { tracks: [], error: String(err?.message || err) });
        }
    }
    if (path.startsWith('/stream/')) {
        const id = decodeURIComponent(path.slice('/stream/'.length));
        if (!id)
            return json(res, 404, { error: 'missing id' });
        const stream = await resolveStream(id, url.searchParams.get('quality'));
        if (!stream)
            return json(res, 404, { error: 'not available in this addon' });
        return json(res, 200, stream);
    }
    return json(res, 404, { error: 'not found' });
}
