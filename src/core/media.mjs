// Item photos for the cards (offers, plan, receipt), like the thumbnails of real Alexa shopping cards.
// Original, unbranded images generated for this project (see CREDITS.md), served from our own domain under
// /media/items/, so the MCP Apps CSP lists only our origin (resourceDomains) and nothing else.
// Keyed by catalogue product id and by merchant id (services): [file, alt, alt of view 2, alt of view 3]; views 2 and 3
// (<file>-2.webp, <file>-3.webp) feed the photo gallery of the item card. Unknown items (live shop search, other trades) get no
// photo here: real products and real businesses carry their own photos (src/core/imgproxy.mjs); the rest keep their
// category icon.
export const ITEM_MEDIA = {
  // home services
  m_hearth: ['family-style-dinner', 'Family-style dinner served on a wooden table', 'Table set for six with candles', 'Sliced roast with roasted vegetables'],
  m_olive: ['mediterranean-dinner', 'Plated Mediterranean dinner with grilled fish', 'Mezze: hummus, falafel, olives and pita', 'Grilled fish with lemon and herbs'],
  m_basil: ['comfort-food-buffet', 'Comfort-food buffet in steel chafing dishes', 'Golden baked macaroni and cheese', 'Cornbread and green salad on the buffet'],
  // bedding
  p_guestbed: ['guest-sheet-set', 'White percale sheet set with two pillowcases', 'Queen bed made with the white percale sheets', 'Close-up of the percale weave and hem'],
  p_sheets_king: ['king-sateen-sheets', 'White sateen sheet set, folded', 'King bed made with white sateen sheets', 'Close-up of the sateen sheen'],
  p_duvet: ['queen-duvet', 'Thick white all-season duvet, folded', 'The duvet on a bed in a bright room', 'Close-up of the quilted stitching'],
  p_sheets_micro: ['guest-room-refresh', 'Freshly made guest bed with a microfiber sheet set', 'Night table and lamp beside the made bed', 'Folded towels and soap on the bed'],
  p_towels: ['guest-towels', 'Stack of guest towels with eucalyptus', 'Towels folded on a wooden bathroom shelf', 'Close-up of the terry texture'],
  // laundry (test catalogue)
  p_det_7gen: ['cleaning-eco-supplies', 'Plant-based laundry and cleaning bottles on a counter', 'Spotless bathroom with folded towels', 'Tidy room in morning light'],
  p_det_house: ['cleaning-eco-supplies', 'Laundry and cleaning bottles on a counter', 'Spotless bathroom with folded towels', 'Tidy room in morning light'],
  p_det_pods: ['cleaning-eco-supplies', 'Plant-based laundry supplies on a counter', 'Spotless bathroom with folded towels', 'Tidy room in morning light'],
  // dog food
  p_dog_chicken: ['dog-food-chicken-rice', 'Bowl of dry dog food with chicken and brown rice', 'Close-up of the kibble', 'Chicken, brown rice and carrots, seen from above'],
  p_dog_salmon: ['dog-food-salmon-sweet-potato', 'Bowl of dry dog food with salmon and sweet potato', 'Close-up of the kibble', 'Salmon, sweet potato and spinach, seen from above'],
  p_dog_lamb: ['dog-food-lamb-oatmeal', 'Bowl of dry dog food with lamb and oats', 'Close-up of the kibble', 'Lamb, rolled oats and peas, seen from above'],
  p_dog_mix: ['dog-food-turkey-grain-free', 'Bowl of grain-free dry dog food with turkey', 'Close-up of the kibble', 'Turkey, squash and green beans, seen from above'],
};

export const mediaPath = (name) => `/media/items/${name}.webp`;

// { image_url, image_alt } for an offer (service: merchant_id, product: product_id), or {} when there is no photo.
export function mediaFor({ kind, merchant_id, product_id }, publicUrl) {
  const hit = ITEM_MEDIA[kind === 'product' ? product_id : merchant_id];
  if (!hit || !publicUrl) return {};
  return { image_url: `${String(publicUrl).replace(/\/$/, '')}${mediaPath(hit[0])}`, image_alt: hit[1] };
}

// The item card's gallery: the main photo, then the extra views that exist on disk.
import fs from 'node:fs';
const ITEMS_DIR = new URL('../../media/items/', import.meta.url);
const exists = (n) => { try { return fs.statSync(new URL(`${n}.webp`, ITEMS_DIR)).size > 0; } catch { return false; } };
export function galleryFor({ kind, merchant_id, product_id, gallery }, publicUrl) {
  // real products and real businesses carry their own photos (signed links through /img)
  if (Array.isArray(gallery) && gallery.length) return gallery.slice(0, 6);
  const hit = ITEM_MEDIA[kind === 'product' ? product_id : merchant_id];
  if (!hit || !publicUrl) return [];
  const base = String(publicUrl).replace(/\/$/, '');
  const [name, ...alts] = hit;
  return [name, `${name}-2`, `${name}-3`].map((n, i) => ({ n, alt: alts[i] })).filter((x, i) => i === 0 || (x.alt && exists(x.n)))
    .map((x) => ({ url: `${base}${mediaPath(x.n)}`, alt: x.alt }));
}
