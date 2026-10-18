// Echo Show ambient wallpaper: full-bleed home photos that slowly cross-fade, like a real Echo Show home screen.
// Original images generated for this project (see CREDITS.md). Two sizes: 1920 for Echo Show 15, 1280 for Show 8.
// Loading is lazy: nothing is fetched for the Echo Dot (no screen), only the first photo at boot, and each next
// photo only a moment before its turn. Rotation pauses when the tab is hidden; with Reduce Motion the photo stays still.
const PHOTOS = [
  { name: 'lake-dawn', from: 5 },
  { name: 'kitchen-morning', from: 7 },
  { name: 'snow-window-morning', from: 9 },
  { name: 'garden-afternoon', from: 12 },
  { name: 'living-room-golden-hour', from: 16 },
  { name: 'reading-nook-dusk', from: 19 },
];
const EVERY_MS = 20000;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');

export function createWallpaper(root, { start } = {}) {
  const layers = [...root.querySelectorAll('.wall-img')];
  let size = 0, index = -1, front = 0, timer = 0, running = false, token = 0;
  const url = (i) => `wallpapers/${size}/${PHOTOS[i].name}.webp`;
  // start on the photo that suits the hour (dawn lake, morning kitchen... reading nook at night)
  const startIndex = () => {
    const asked = PHOTOS.findIndex((p) => p.name === start);
    if (asked >= 0) return asked;
    const h = new Date().getHours();
    let i = PHOTOS.length - 1; // before dawn: the reading nook
    PHOTOS.forEach((p, k) => { if (h >= p.from) i = k; });
    return i;
  };
  const load = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => resolve(src));
    img.onerror = reject;
    img.src = src;
  });
  async function show(i) {
    const mine = ++token;
    const src = url(i);
    try { await load(src); } catch { return; }
    if (mine !== token) return;
    const back = layers[1 - front];
    back.style.backgroundImage = `url("${src}")`;
    back.classList.add('on');
    layers[front].classList.remove('on');
    front = 1 - front; index = i;
    root.dataset.photo = PHOTOS[i].name;
  }
  const schedule = () => {
    clearTimeout(timer);
    if (!running || reduce.matches || document.hidden) return;
    timer = setTimeout(async () => { await show((index + 1) % PHOTOS.length); schedule(); }, EVERY_MS);
  };
  document.addEventListener('visibilitychange', schedule);
  reduce.addEventListener?.('change', schedule);
  return {
    // device: 'show15' | 'show8' | 'dot'
    setDevice(device) {
      const want = device === 'show15' ? 1920 : device === 'show8' ? 1280 : 0;
      running = want > 0;
      if (!running) { clearTimeout(timer); return; }
      if (want !== size) { size = want; show(index < 0 ? startIndex() : index); }
      schedule();
    },
  };
}
