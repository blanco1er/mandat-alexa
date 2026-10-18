// Simulated household catalogue: generic products from fictional online shops, used whenever live Channel3 search
// is off (the default, and always in tests). No real brand, no real product photo: safe to film.
// Each product lists its main ingredients/materials, so household preferences (allergies, brands) can filter it, a
// settings category (home, pets, pantry: what the household lets Mandat buy), a type (only products of the same type
// are compared on price) and the facts Mandat gives when it says why it picked one.
export const SHOPS = {
  shop_hearthlinen: { name: 'Hearth & Linen', delivery: 6 },
  shop_pawpantry: { name: 'Paw Pantry', delivery: 0 },
  shop_beanpost: { name: 'Bean Post', delivery: 0 },
  shop_homebasics: { name: 'Home Basics Co.', delivery: 4 },
};

export const PRODUCTS = [
  // bedding
  { id: 'p_guestbed', shop: 'shop_hearthlinen', title: 'Guest bed bundle: queen percale sheet set + 2 pillowcases', price: 86, tags: ['bedding', 'sheets', 'queen', 'guest room', 'pillowcase', 'linen'], contains: ['cotton'], category: 'home', type: 'sheets', features: ['queen size, with 2 pillowcases', 'cotton percale'] },
  { id: 'p_sheets_king', shop: 'shop_hearthlinen', title: 'King sateen sheet set, white', price: 98, tags: ['bedding', 'sheets', 'king'], contains: ['cotton'], category: 'home', type: 'sheets', features: ['cotton sateen, silky finish'] },
  { id: 'p_duvet', shop: 'shop_homebasics', title: 'All-season queen duvet, hypoallergenic', price: 72, tags: ['bedding', 'duvet', 'comforter', 'queen'], contains: ['polyester'], category: 'home', type: 'duvet', features: ['hypoallergenic fill'] },
  { id: 'p_towels', shop: 'shop_homebasics', title: 'Guest towel set (2 bath, 2 hand)', price: 34, tags: ['towels', 'bath', 'guest room'], contains: ['cotton'], category: 'home', type: 'towels', features: ['2 bath and 2 hand towels'] },
  // dog food
  { id: 'p_dog_chicken', shop: 'shop_pawpantry', title: 'Chicken & brown rice dry dog food, 24 lb', price: 29, tags: ['dog food', 'dog', 'kibble'], contains: ['chicken', 'rice'], category: 'pets', type: 'dog food', features: ['24 lb bag'] },
  { id: 'p_dog_salmon', shop: 'shop_pawpantry', title: 'Salmon & sweet potato dry dog food, 24 lb', price: 34, tags: ['dog food', 'dog', 'kibble'], contains: ['salmon', 'sweet potato'], category: 'pets', type: 'dog food', features: ['no chicken', '24 lb bag'] },
  { id: 'p_dog_lamb', shop: 'shop_pawpantry', title: 'Lamb & oatmeal dry dog food, 24 lb', price: 38, tags: ['dog food', 'dog', 'kibble'], contains: ['lamb', 'oats'], category: 'pets', type: 'dog food', features: ['no chicken', '24 lb bag'] },
  { id: 'p_dog_mix', shop: 'shop_pawpantry', title: 'Turkey & chicken meal grain-free dog food, 22 lb', price: 41, tags: ['dog food', 'dog', 'kibble'], contains: ['turkey', 'chicken'], category: 'pets', type: 'dog food', features: ['grain-free'] },
  // coffee
  { id: 'p_coffee_northbeam', shop: 'shop_beanpost', title: 'Northbeam medium roast, whole bean, 2 × 2 lb', price: 52, tags: ['coffee', 'beans', 'medium roast', 'northbeam'], contains: ['coffee'], brand: 'Northbeam', category: 'pantry', type: 'coffee', features: ['whole bean, 2 × 2 lb'] },
  { id: 'p_coffee_house', shop: 'shop_beanpost', title: 'House blend dark roast, ground, 2 lb', price: 24, tags: ['coffee', 'ground', 'dark roast'], contains: ['coffee'], brand: 'Bean Post', category: 'pantry', type: 'coffee', features: ['ground, 2 lb'] },
  { id: 'p_coffee_decaf', shop: 'shop_beanpost', title: 'Swiss-water decaf, whole bean, 2 lb', price: 27, tags: ['coffee', 'decaf', 'beans'], contains: ['coffee'], brand: 'Bean Post', category: 'pantry', type: 'coffee', features: ['decaf, whole bean'] },
];

// Accent-insensitive, so "café", "sábanas" or "linge de lit" (an assistant may search in the user's language) match.
const words = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2);
// A few words people say that should match a tag (English, French, Spanish).
const ALIAS = {
  sheets: 'bedding', bedding: 'bedding', linen: 'bedding', linens: 'bedding', pillow: 'bedding', pillows: 'bedding', kibble: 'dog', dog: 'dog', puppy: 'dog', coffee: 'coffee', espresso: 'coffee', beans: 'coffee', towels: 'towels', duvet: 'duvet',
  draps: ['sheets', 'bedding'], linge: ['linen', 'bedding'], literie: 'bedding', parure: ['sheets', 'bedding'], taies: 'bedding', oreiller: 'bedding', croquettes: 'dog', chien: 'dog', cafe: 'coffee', grains: 'coffee', serviettes: 'towels', couette: 'duvet',
  sabanas: ['sheets', 'bedding'], ropa: ['linen', 'bedding'], cama: 'bedding', fundas: 'bedding', almohada: 'bedding', pienso: 'dog', perro: 'dog', grano: 'coffee', toallas: 'towels', edredon: 'duvet', nordico: 'duvet',
};

export function searchCatalog({ query, maxPrice }) {
  const q = words(query);
  const keys = new Set(q.flatMap((w) => [].concat(ALIAS[w] || w)));
  const scored = PRODUCTS.map((p) => {
    const hay = new Set([...words(p.title), ...p.tags.flatMap(words), ...(p.brand ? words(p.brand) : [])]);
    let score = 0;
    for (const k of keys) if (hay.has(k)) score += 2;
    for (const w of q) if (hay.has(w)) score += 1;
    return { p, score };
  }).filter((x) => x.score > 0 && (!maxPrice || x.p.price <= maxPrice));
  scored.sort((a, b) => b.score - a.score || a.p.price - b.p.price);
  return scored.map(({ p }) => ({ ...p, shopName: SHOPS[p.shop].name, delivery: SHOPS[p.shop].delivery }));
}
