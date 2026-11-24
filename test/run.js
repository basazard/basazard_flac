import { describeAudioUrl, qualityLabel } from '../lib/flac.js';
import { searchAll, resolveStream, health } from '../lib/router.js';

let pass = 0;
let fail = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

console.log('\n== FLAC header parsing ==');
{
  function buildStreamInfo(sampleRate, channels, bitDepth, totalSamples) {
    const bytes = new Uint8Array(42);
    bytes.set([0x66, 0x4c, 0x61, 0x43], 0);
    bytes[4] = 0x00;
    bytes[5] = 0x00;
    bytes[6] = 0x22;
    const si = 8;
    bytes[si + 10] = (sampleRate >> 12) & 0xff;
    bytes[si + 11] = (sampleRate >> 4) & 0xff;
    bytes[si + 12] = ((sampleRate & 0x0f) << 4) | ((channels - 1) << 1) | (((bitDepth - 1) >> 4) & 0x1);
    bytes[si + 13] = (((bitDepth - 1) & 0x0f) << 4) | ((Math.floor(totalSamples / 2 ** 32)) & 0x0f);
    bytes[si + 14] = (totalSamples >>> 24) & 0xff;
    bytes[si + 15] = (totalSamples >>> 16) & 0xff;
    bytes[si + 16] = (totalSamples >>> 8) & 0xff;
    bytes[si + 17] = totalSamples & 0xff;
    return bytes;
  }

  const { parseStreamInfoForTest } = await import('../lib/flac.js').then((m) => ({
    parseStreamInfoForTest: m.__test?.parseStreamInfo,
  }));

  const hiRes = buildStreamInfo(192000, 2, 24, 547 * 192000);
  const parsed = parseStreamInfoForTest(hiRes);
  ok('reads 192 kHz', parsed?.sampleRate === 192000, String(parsed?.sampleRate));
  ok('reads 24-bit', parsed?.bitDepth === 24, String(parsed?.bitDepth));
  ok('reads 2 channels', parsed?.channels === 2, String(parsed?.channels));
  ok('derives duration', Math.abs(parsed.duration - 547) < 1, String(parsed?.duration));

  const cd = buildStreamInfo(44100, 2, 16, 2723 * 44100);
  const parsedCd = parseStreamInfoForTest(cd);
  ok('reads CD quality', parsedCd?.sampleRate === 44100 && parsedCd?.bitDepth === 16);

  const notFlac = new Uint8Array(42).fill(0x3c);
  ok('rejects non-fLaC magic', parseStreamInfoForTest(notFlac) === null);
  ok('rejects truncated header', parseStreamInfoForTest(hiRes.slice(0, 20)) === null);
}


console.log('\n== Internet Archive provider (simulated archive.org) ==');
{
  const { encodeId, decodeId, parseLength } = await import('../lib/providers/archive.js');

  const id = encodeId('miles_kind_of_blue', 'Disc 1/01 So What.flac');
  const back = decodeId(id);
  ok('track id round-trips', back?.identifier === 'miles_kind_of_blue' && back?.file === 'Disc 1/01 So What.flac');
  ok('rejects foreign ids', decodeId('qb:12345') === null && decodeId('nonsense') === null);
  ok('rejects path tricks', decodeId(encodeId('x', '../../etc')) === null);
  ok('parses seconds length', parseLength('545.23') === 545);
  ok('parses mm:ss length', parseLength('09:05') === 545);

  function flacHeader(sampleRate, bitDepth) {
    const b = new Uint8Array(64);
    b.set([0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22]);
    const si = 8;
    b[si + 10] = (sampleRate >> 12) & 0xff;
    b[si + 11] = (sampleRate >> 4) & 0xff;
    b[si + 12] = ((sampleRate & 0x0f) << 4) | (1 << 1) | (((bitDepth - 1) >> 4) & 1);
    b[si + 13] = ((bitDepth - 1) & 0x0f) << 4;
    b[si + 16] = 0x10;
    return b;
  }

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const jsonRes = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (u.includes('/advancedsearch.php')) {
      return jsonRes({ response: { docs: [{ identifier: 'jazz_item' }, { identifier: 'broken_item' }] } });
    }
    if (u.endsWith('/metadata/jazz_item')) {
      return jsonRes({
        metadata: { title: 'Jazz Album', creator: 'Some Band' },
        files: [
          { name: '01 Intro.flac', format: 'Flac', title: 'Intro', length: '62.1' },
          { name: '02 So What.flac', format: '24bit Flac', title: 'So What', length: '9:05' },
          { name: '02 So What.mp3', format: 'VBR MP3', title: 'So What' },
          { name: 'cover.jpg', format: 'JPEG' },
        ],
      });
    }
    if (u.endsWith('/metadata/broken_item')) return new Response('oops', { status: 500 });
    if (u.includes('/download/jazz_item/02%20So%20What.flac')) {
      return new Response(flacHeader(96000, 24), { status: 206, headers: { 'content-range': 'bytes 0-63/52428800' } });
    }
    if (u.includes('/download/jazz_item/01%20Intro.flac')) {
      return new Response('<html>not audio</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('not found', { status: 404 });
  };

  try {
    const res = await searchAll('so what', 'LOSSLESS');
    ok('search returns only FLAC files', res.tracks.length === 2, `got ${res.tracks.length}`);
    ok('best match ranked first', res.tracks[0]?.title === 'So What', res.tracks[0]?.title);
    ok('rows carry artist and album', res.tracks[0]?.artist === 'Some Band' && res.tracks[0]?.album === 'Jazz Album');
    ok('duration parsed', res.tracks[0]?.duration === 545);
    ok('broken item skipped, not fatal', res.perSource.ia?.ok === true);

    const stream = await resolveStream(res.tracks[0].id, 'LOSSLESS');
    ok('stream resolves to https FLAC', stream?.url?.startsWith('https://archive.org/download/') && stream.codec === 'flac');
    ok('real sample rate / bit depth reported', stream?.sampleRate === 96000 && stream?.bitDepth === 24, JSON.stringify(stream));
    ok('quality label', stream?.quality === 'Lossless · 24-bit / 96 kHz', stream?.quality);

    const fake = await resolveStream(res.tracks[1].id, 'LOSSLESS');
    ok('file that is not really FLAC is refused', fake === null);
    ok('garbage id returns null', (await resolveStream('nonsense', 'LOSSLESS')) === null);
    ok('blank search returns nothing', (await searchAll('   ', 'LOSSLESS')).tracks.length === 0);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
