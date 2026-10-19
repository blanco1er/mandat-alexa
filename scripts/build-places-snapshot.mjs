// Saves the real local businesses around the demo household (Capitol Hill, Seattle) from OpenStreetMap, so the demo
// and the tests work without network and the live demo has a fallback when Overpass is busy.
// Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright): shown on every card.
// Usage: node scripts/build-places-snapshot.mjs   (4 Overpass requests, a few seconds apart, identified User-Agent)
//        node scripts/build-places-snapshot.mjs saved-overpass.json   (from an Overpass answer saved earlier, when the
//        public servers are at capacity: elements are sorted into trades by their tags)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HOME, overpassQuery, osmToPlace } from '../src/core/places.mjs';

const KEEP = ['name', 'addr:housenumber', 'addr:street', 'addr:city', 'addr:postcode', 'opening_hours', 'website', 'contact:website', 'craft', 'shop', 'office'];
const out = { built: new Date().toISOString().slice(0, 10), source: 'OpenStreetMap (Overpass API)', license: 'ODbL 1.0, © OpenStreetMap contributors', home: HOME.label, categories: {} };
const saved = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).elements : null;
const TRADE = { cleaning: (t) => t.craft === 'cleaning' || t.shop === 'cleaning' || (t.office && /clean|maid|housekeep/i.test(t.name || '')), catering: (t) => t.craft === 'caterer' || t.shop === 'caterer', plumbing: (t) => t.craft === 'plumber', handyman: (t) => t.craft === 'handyman' };
for (const category of ['cleaning', 'catering', 'plumbing', 'handyman']) {
  const els = saved ? saved.filter((e) => TRADE[category](e.tags || {})) : await overpassQuery(category, HOME, undefined, 4);
  out.categories[category] = els.filter((e) => osmToPlace(e, category)).map((e) => ({
    type: e.type, id: e.id, ...(e.lat != null ? { lat: e.lat, lon: e.lon } : { center: e.center }),
    tags: Object.fromEntries(Object.entries(e.tags || {}).filter(([k]) => KEEP.includes(k))),
  }));
  console.log(`${category}: ${out.categories[category].length} places`);
  if (!saved) await new Promise((r) => setTimeout(r, 3000));
}
fs.writeFileSync(fileURLToPath(new URL('../src/core/places-snapshot.json', import.meta.url)), JSON.stringify(out, null, 1) + '\n');
