// Item photos for the cards (offers, plan, receipt), like the thumbnails of real Alexa shopping cards.
// Original, unbranded images generated for this project (see CREDITS.md), served from our own domain under
// /media/items/, so the MCP Apps CSP lists only our origin (resourceDomains) and nothing else.
// Keyed by catalogue product id and by merchant id (services). Unknown items (live shop search, other trades) get no
// photo: the cards then keep their category icon.
export const ITEM_MEDIA = {
  // home services
  m_brightnest: ['cleaning-eco-supplies', 'Eco cleaning supplies tidied on a kitchen counter'],
  m_tidyhive: ['guest-room-refresh', 'Freshly made guest bed with folded towels'],
  m_sparkle: ['hotel-style-room', 'Hotel-style guest bed with flowers on the night table'],
  m_hearth: ['family-style-dinner', 'Family-style dinner served on a wooden table'],
  m_olive: ['mediterranean-dinner', 'Plated Mediterranean dinner with grilled fish'],
  m_basil: ['comfort-food-buffet', 'Comfort-food buffet in steel chafing dishes'],
  // bedding
  p_guestbed: ['guest-sheet-set', 'White percale sheet set with two pillowcases'],
  p_sheets_king: ['king-sateen-sheets', 'White sateen sheet set, folded'],
  p_duvet: ['queen-duvet', 'Thick white all-season duvet, folded'],
  p_towels: ['guest-towels', 'Stack of guest towels with eucalyptus'],
  // dog food
  p_dog_chicken: ['dog-food-chicken-rice', 'Bowl of dry dog food with chicken and brown rice'],
  p_dog_salmon: ['dog-food-salmon-sweet-potato', 'Bowl of dry dog food with salmon and sweet potato'],
  p_dog_lamb: ['dog-food-lamb-oatmeal', 'Bowl of dry dog food with lamb and oats'],
  p_dog_mix: ['dog-food-turkey-grain-free', 'Bowl of grain-free dry dog food with turkey'],
  // coffee
  p_coffee_northbeam: ['coffee-medium-roast-beans', 'Two plain bags of medium-roast coffee beans'],
  p_coffee_house: ['coffee-dark-roast-ground', 'Open bag of dark-roast ground coffee'],
  p_coffee_decaf: ['coffee-decaf-beans', 'Decaf coffee beans in a glass jar'],
};

export const mediaPath = (name) => `/media/items/${name}.webp`;

// { image_url, image_alt } for an offer (service: merchant_id, product: product_id), or {} when there is no photo.
export function mediaFor({ kind, merchant_id, product_id }, publicUrl) {
  const hit = ITEM_MEDIA[kind === 'product' ? product_id : merchant_id];
  if (!hit || !publicUrl) return {};
  return { image_url: `${String(publicUrl).replace(/\/$/, '')}${mediaPath(hit[0])}`, image_alt: hit[1] };
}
