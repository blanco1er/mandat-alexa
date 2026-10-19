// Photos of real things on the cards, served from Mandat's own origin (the cards' CSP lists only that origin):
//   g:places/…/photos/…   a Google Places photo (fetched with the key on the server, cached, author shown on the card)
//   https://cdn.trychannel3.com/…   a product photo from Channel3
// Only links Mandat signed can be fetched (no open proxy), and only from those two sources.
import { networkSign } from './merchants.mjs';
import { googlePhoto } from './places.mjs';

const CHANNEL3_IMG = /^https:\/\/cdn\.trychannel3\.com\/[\w\-./?=&%]+$/;
export function imgUrl(publicUrl, src) {
  if (!src || !publicUrl) return null;
  if (!(String(src).startsWith('g:places/') || CHANNEL3_IMG.test(src))) return null;
  return `${String(publicUrl).replace(/\/$/, '')}/img?src=${encodeURIComponent(src)}&s=${networkSign(src)}`;
}

let doFetch = (...a) => globalThis.fetch(...a);
export function _setImgFetch(f) { doFetch = f || ((...a) => globalThis.fetch(...a)); }
const mem = new Map(); // product photos, small and public: a warm process keeps the last ones
export async function serveImg(url) {
  const src = url.searchParams.get('src') || '';
  const sig = url.searchParams.get('s') || '';
  if (!src || sig !== networkSign(src)) return new Response('Not found', { status: 404 });
  let out = null;
  try {
    if (src.startsWith('g:places/')) out = await googlePhoto(src);
    else if (CHANNEL3_IMG.test(src)) {
      out = mem.get(src) || null;
      if (!out) {
        const r = await doFetch(src, { signal: AbortSignal.timeout(8000) });
        const type = r.headers.get('content-type') || '';
        if (r.ok && /^image\//.test(type)) {
          const bytes = Buffer.from(await r.arrayBuffer());
          if (bytes.length < 3e6) { out = { type, bytes }; mem.set(src, out); if (mem.size > 60) mem.delete(mem.keys().next().value); }
        }
      }
    }
  } catch (e) { console.warn('[img]', e.message); }
  if (!out) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  return new Response(out.bytes, { headers: { 'content-type': out.type, 'cache-control': 'public, max-age=86400' } });
}
