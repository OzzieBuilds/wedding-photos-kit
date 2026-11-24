// Extracts the lightbox stage machine from public/index.html and drives it
// against a stub DOM, to prove the save tip is never shown over anything but
// full-resolution pixels.
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).join('\n;\n');

// Pull just the functions under test.
function grab(name) {
  let start = script.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  // 'function X(' also matches inside 'async function X(' — keep the modifier or
  // the extracted copy loses its async-ness and every await is a syntax error.
  if (script.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0, i = script.indexOf('{', start);
  for (let j = i; j < script.length; j++) {
    if (script[j] === '{') depth++;
    else if (script[j] === '}' && --depth === 0) return script.slice(start, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

// Take the real constant declarations too, so the labels and the dwell window
// are asserted against what the page actually ships rather than copies.
function grabConst(name) {
  const m = script.match(new RegExp(`^\\s*const ${name} = .*?;$`, 'm'));
  if (!m) throw new Error(`missing const ${name}`);
  return m[0].trim();
}

const els = {};
function el(id) {
  return els[id] ??= {
    id, src: '', style: {}, textContent: '', onclick: null,
    _c: new Set(),
    classList: {
      add: c => els[id]._c.add(c),
      remove: c => els[id]._c.delete(c),
      contains: c => els[id]._c.has(c),
      toggle: (c, force) => force ? els[id]._c.add(c) : els[id]._c.delete(c),
    },
    getBoundingClientRect: () => ({}),
  };
}

// Controllable image loading: tests resolve each URL when they choose.
const pending = [];
class FakeImage {
  set src(v) { this._src = v; pending.push(this); }
  get src() { return this._src; }
}
function settle(match) {
  const hit = pending.filter(p => p._src.includes(match));
  for (const p of hit) { pending.splice(pending.indexOf(p), 1); p.onload?.(); }
  return hit.length;
}

const ctx = {
  Image: FakeImage,
  document: { getElementById: el },
  navigator: {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: globalThis.clearTimeout,
  WORKER_URL: 'https://x.test',
  navigating: false,
  currentPhotoIndex: 0,
  visiblePhotos: [],
  lightboxStage: 0,
  fullSizeTimer: null,
};

const body = `
  const fullyLoadedPhotos = new Set();
  let countdownTimer = null;
  let originalRequestedFor = null;
  function requestFullQuality() {}
  ${grabConst('FULL_QUALITY_DWELL_MS')}
  ${grabConst('COUNTDOWN_AT_MS')}
  ${grabConst('LABEL_COUNTDOWN')}
  ${grabConst('LABEL_LOADING')}
  ${grabConst('LABEL_TAPPABLE')}
  ${grab('setStatus')} ${grab('clearStatus')} ${grab('clearFullQualityTimers')}
  ${grab('gridUrl')} ${grab('displayUrl')} ${grab('originalUrl')}
  ${grab('swapWhenLoaded')} ${grab('upgradeToDisplay')} ${grab('upgradeToOriginal')}
  ${grab('upgradeForZoom')}
  return {
    upgradeToDisplay, upgradeToOriginal, clearStatus, clearFullQualityTimers, upgradeForZoom,
    gridUrl, displayUrl, originalUrl,
    state: () => ({
      stage: lightboxStage,
      dwellMs: FULL_QUALITY_DWELL_MS,
      countdownAt: COUNTDOWN_AT_MS,
      countdown: LABEL_COUNTDOWN,
      loading: LABEL_LOADING,
      tappable: LABEL_TAPPABLE,
    }),
    isRemembered: k => fullyLoadedPhotos.has(k),
    setPhotos: p => { visiblePhotos = p; },
    setIndex: i => { currentPhotoIndex = i; },
    resetStage: () => { lightboxStage = 1; originalRequestedFor = null; },
  };
`;
const api = new Function(
  'Image', 'document', 'navigator', 'WORKER_URL',
  'navigating', 'currentPhotoIndex', 'visiblePhotos', 'lightboxStage', 'fullSizeTimer',
  body
)(ctx.Image, ctx.document, ctx.navigator, ctx.WORKER_URL,
  false, 0, [], 0, null);

const img = el('lightboxImg');
const tip = el('saveTip');
const status = el('lightboxStatus');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); failures++; }
}

const photo = { file_key: 'photos/1-abc.jpg' };

// ── The race the guard exists for ──────────────────────────────────────────
console.log('\nslow display + dwell-fired original (the regression case):');
api.setPhotos([photo]);
api.setIndex(0);
api.resetStage();
img.src = api.gridUrl(photo);
tip.classList.add('hidden');

api.upgradeToDisplay(photo, img);          // display load starts, stays pending
api.upgradeToOriginal(photo, img, true);         // dwell fires while display in flight
settle('/image/');                         // original lands first
check('original is displayed', img.src === api.originalUrl(photo), img.src);
check('save tip is visible', !tip.classList.contains('hidden'));

settle('/v/display/');                     // late display load arrives
check('late display does NOT clobber original', img.src === api.originalUrl(photo), img.src);
check('save tip still visible over original', !tip.classList.contains('hidden'));
check('stage stayed at 3', api.state().stage === 3, String(api.state().stage));

// ── Normal ordering ────────────────────────────────────────────────────────
console.log('\nnormal ordering (display then original):');
const p2 = { file_key: 'photos/2-def.jpg' };
api.setPhotos([p2]); api.setIndex(0); api.resetStage();
img.src = api.gridUrl(p2); tip.classList.add('hidden'); status.classList.add('hidden');

api.upgradeToDisplay(p2, img);
settle('/v/display/');
check('display shown', img.src === api.displayUrl(p2), img.src);
check('tip hidden over display', tip.classList.contains('hidden'));
check('no prompt after the display size lands', status.classList.contains('hidden'));

api.upgradeToOriginal(p2, img, true);
settle('/image/');
check('original shown', img.src === api.originalUrl(p2), img.src);
check('tip revealed', !tip.classList.contains('hidden'));
check('status cleared once full quality lands', status.classList.contains('hidden'));

// ── Gesture routing ────────────────────────────────────────────────────────
// The swipe handler calls preventDefault() once a finger moves 6px, and
// preventDefault on touchmove suppresses the click that follows. A real tap on a
// 48px button drifts well past 6px, so without an exemption the close and arrow
// buttons never fire — which is exactly what happened in production.
console.log('\ngesture routing:');
const exempt = new Function(grab('isSwipeExempt') + '; return isSwipeExempt;')();
const asTarget = sel => ({ closest: q => q.split(', ').includes(sel) ? {} : null });

check('close button is exempt from swipe', exempt(asTarget('button')));
check('links are exempt', exempt(asTarget('a')));
check('text inputs are exempt', exempt(asTarget('input')));
check('the photo itself is NOT exempt', !exempt(asTarget('img')));
check('the backdrop is NOT exempt', !exempt(asTarget('div')));
check('a missing target is safe', !exempt(null));

// ── Zooming fetches full quality at once ───────────────────────────────────
// A guest who zooms wants detail now, not after the dwell timer.
console.log('\nzooming in fetches the original immediately:');
const z = { file_key: 'photos/9-zzz.jpg' };
const lb = el('lightbox');
api.setPhotos([z]); api.setIndex(0); api.resetStage();
api.clearStatus(); tip.classList.add('hidden');
img.src = api.gridUrl(z);
api.upgradeToDisplay(z, img);
settle('/v/display/');
lb.classList.add('zoomed');
api.upgradeForZoom();
check('original requested without waiting', pending.some(p => p._src.includes('/image/photos/9-zzz')));
check('loading is announced', status.textContent === api.state().loading, status.textContent);
const before = pending.filter(p => p._src.includes('/image/')).length;
api.upgradeForZoom();
check('a second pinch does not refetch', pending.filter(p => p._src.includes('/image/')).length === before);
img.style.opacity = '';
// The real loader's decode() resolves on a later tick.
await new Promise(r => { for (const p of pending) if (p._src.includes('/image/photos/9-zzz')) p.decode = () => Promise.resolve(); r(); });
settle('/image/photos/9-zzz');
await new Promise(r => setTimeout(r, 0));
check('original swapped in while zoomed', img.src === api.originalUrl(z), img.src);
check('no fade-to-blank while zoomed', img.style.opacity === '', String(img.style.opacity));
check('save tip revealed', !tip.classList.contains('hidden'));
api.upgradeForZoom();
check('nothing more fetched once at full quality', pending.every(p => !p._src.includes('/image/photos/9-zzz')));
lb.classList.remove('zoomed');

// ── Pinch-to-zoom geometry ─────────────────────────────────────────────────
// The photo zooms inside the lightbox instead of the browser zooming the page.
console.log('\npinch-to-zoom geometry:');
const clampAxis = new Function(grab('clampAxis') + '; return clampAxis;')();
const pinchOffset = new Function(grab('pinchOffset') + '; return pinchOffset;')();

// A 400px-wide photo centred on a 400px screen, zoomed 2x (800px wide): it can
// pan 200px either way, until an edge meets the screen edge.
check('pan stops at the left edge', clampAxis(500, 800, 200, 400) === 200, String(clampAxis(500, 800, 200, 400)));
check('pan stops at the right edge', clampAxis(-500, 800, 200, 400) === -200, String(clampAxis(-500, 800, 200, 400)));
check('pan within range is untouched', clampAxis(50, 800, 200, 400) === 50);
// Smaller than the screen: it can move, but never off it.
check('small photo stays on screen', clampAxis(300, 200, 200, 400) === 100, String(clampAxis(300, 200, 200, 400)));
// The point under the fingers stays under the fingers: zooming 2x at x=300 on a
// photo centred at 200 shifts the photo left by the 100px that point moves.
check('pinch keeps the midpoint fixed', pinchOffset(300, 200, 100, 2) === -100, String(pinchOffset(300, 200, 100, 2)));
check('pinch on the centre does not pan', pinchOffset(200, 200, 0, 3) === 0);

// ── URL shapes ─────────────────────────────────────────────────────────────
console.log('\nURL shapes:');
const p3 = { file_key: 'photos/3-ghi.jpg' };
check('grid uses the grid variant', api.gridUrl(p3) === 'https://x.test/v/grid/photos/3-ghi.jpg', api.gridUrl(p3));
check('display uses the display variant', api.displayUrl(p3) === 'https://x.test/v/display/photos/3-ghi.jpg', api.displayUrl(p3));
check('original bypasses /v/', api.originalUrl(p3) === 'https://x.test/image/photos/3-ghi.jpg', api.originalUrl(p3));

// ── Navigating away mid-load ───────────────────────────────────────────────
console.log('\nguest swipes away while original is loading:');
const p4 = { file_key: 'photos/4-jkl.jpg' };
const p5 = { file_key: 'photos/5-mno.jpg' };
api.setPhotos([p4, p5]); api.setIndex(0); api.resetStage();
img.src = api.gridUrl(p4); tip.classList.add('hidden');

api.upgradeToOriginal(p4, img, true);
api.setIndex(1);                            // swiped to p5
api.resetStage();
img.src = api.gridUrl(p5);
settle('/image/');
check('stale original not applied to new photo', img.src === api.gridUrl(p5), img.src);
check('tip not shown for new photo', tip.classList.contains('hidden'));

// ── Reopening a photo already fetched at full quality ──────────────────────
console.log('\nreopening a photo already loaded this session:');
const p6 = { file_key: 'photos/6-pqr.jpg' };
api.setPhotos([p6]); api.setIndex(0); api.resetStage();
img.src = api.gridUrl(p6);
api.upgradeToDisplay(p6, img);
settle('/v/display/');
api.upgradeToOriginal(p6, img, true);
settle('/image/');
check('remembered after first full load', api.isRemembered(p6.file_key));

// Close and reopen.
api.clearStatus();
tip.classList.add('hidden');
api.resetStage();
img.src = api.gridUrl(p6);
api.upgradeToDisplay(p6, img);

// Navigation always slides in the grid tile: decoding a 12MP original inside the
// 180ms transition budget is what made the spinner appear.
check('transition starts from the grid tile', img.src === api.gridUrl(p6), img.src);
check('no display derivative refetched', pending.every(p => !p._src.includes('/v/')));
check('no status during the silent upgrade', status.classList.contains('hidden'));
check('loading text never shown', status.textContent !== api.state().loading, status.textContent);
settle('/image/');
check('lands on the original', img.src === api.originalUrl(p6), img.src);
check('save tip revealed', !tip.classList.contains('hidden'));
check('stage is 3', api.state().stage === 3, String(api.state().stage));

// ── Status line ────────────────────────────────────────────────────────────
// The full-quality fetch happens on its own after a short pause, so there is
// nothing to decide — only something to report. No button, just text.
console.log('\nstatus line:');
check('dwell window is 2s', api.state().dwellMs === 2000, String(api.state().dwellMs));
check('countdown only covers the last second',
  api.state().dwellMs - api.state().countdownAt === 1000,
  api.state().dwellMs + '/' + api.state().countdownAt);

const p7 = { file_key: 'photos/7-stu.jpg' };
api.setPhotos([p7]); api.setIndex(0); api.resetStage();
api.clearStatus(); tip.classList.add('hidden');
img.src = api.gridUrl(p7);

api.upgradeToDisplay(p7, img);
settle('/v/display/');
check('silent while swiping past', status.classList.contains('hidden'));

api.upgradeToOriginal(p7, img, true);
check('announces the download', status.textContent === api.state().loading, status.textContent);
check('status is not tappable by default', !status.classList.contains('tappable'));
settle('/image/');
check('status clears when it lands', status.classList.contains('hidden'));
check('save tip takes over', !tip.classList.contains('hidden'));

// Data-saver mode is the one case that still needs an action, because the
// automatic fetch is deliberately suppressed there.
console.log('\ndata-saver mode:');
const saver = { file_key: 'photos/8-vwx.jpg' };
ctx.navigator.connection = { saveData: true };
api.setPhotos([saver]); api.setIndex(0); api.resetStage();
api.clearStatus(); tip.classList.add('hidden');
img.src = api.gridUrl(saver);

api.upgradeToDisplay(saver, img);
check('does not fetch the original unasked', pending.every(p => !p._src.includes('/image/')));
check('offers it instead', status.textContent === api.state().tappable, status.textContent);
check('and that offer is tappable', status.classList.contains('tappable'));
check('offer is wired to an action', typeof status.onclick === 'function');
delete ctx.navigator.connection;

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
