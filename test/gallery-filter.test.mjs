// Extracts filterGallery from public/index.html and drives it against stubs, to
// prove tapping a filter checks for photos that arrived since the page loaded
// without making the filter itself wait on the network.
//
// Guests can sit on the gallery for a long time while photos keep arriving, so
// a filter tap is a natural moment to look again. It has to stay instant, and
// it must not become a way to hammer the server.
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).join('\n;\n');

function grab(name) {
  let start = script.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  if (script.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let j = script.indexOf('{', start); j < script.length; j++) {
    if (script[j] === '{') depth++;
    else if (script[j] === '}' && --depth === 0) return script.slice(start, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function build() {
  const calls = { rendered: 0, syncs: [], order: [] };
  const pills = [
    { active: true, classList: { add() { this.o.active = true; }, remove() { this.o.active = false; } } },
    { active: false, classList: { add() { this.o.active = true; }, remove() { this.o.active = false; } } },
  ];
  pills.forEach(p => { p.classList.o = p; });
  const sortToggle = { textContent: 'Newest first' };

  const factory = new Function('deps', `
    let currentFilter = 'all';
    let sortOrder = 'newest';
    const document = deps.document;
    const renderGallery = deps.renderGallery;
    const syncGallery = deps.syncGallery;
    ${grab('filterGallery')}
    ${grab('toggleSort')}
    return { filterGallery, toggleSort, filter: () => currentFilter, sort: () => sortOrder };
  `);

  const api = factory({
    document: { querySelectorAll: () => pills, getElementById: () => sortToggle },
    renderGallery: () => { calls.rendered++; calls.order.push('render'); },
    syncGallery: (opts) => { calls.syncs.push(opts); calls.order.push('sync'); },
  });

  return { api, calls, pills, sortToggle };
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
  }
}

console.log('gallery filter:');

{
  const { api, calls, pills } = build();
  api.filterGallery('Wedding day', pills[1]);
  check('applies the filter', api.filter() === 'Wedding day', api.filter());
  check('marks the tapped pill active', pills[1].active && !pills[0].active);
  check('renders once', calls.rendered === 1, calls.rendered);
}

// The tap must feel instant, so the redraw cannot sit behind a network call.
{
  const { api, calls, pills } = build();
  api.filterGallery('Featured', pills[1]);
  check('checks for new photos', calls.syncs.length === 1, calls.syncs.length);
  check('renders before syncing, not after', calls.order.join(',') === 'render,sync', calls.order);
}

// Changing filter resets context, so preserving scroll position is meaningless
// — and reloadPreservingPosition would fight the fresh render.
{
  const { api, pills, calls } = build();
  api.filterGallery('Welcome party', pills[1]);
  check('does not try to preserve scroll position', calls.syncs[0].keepPosition === false, calls.syncs[0]);
}

// syncGallery throttles itself, but only when it is not told to bypass it.
// Passing immediate here would turn a flurry of taps into a flurry of requests.
{
  const { api, pills, calls } = build();
  api.filterGallery('Exploring town', pills[1]);
  check('leaves the throttle in place', !calls.syncs[0].immediate, calls.syncs[0]);
}

console.log('\ngallery sort:');

// Flipping to "Newest first" is the tap most likely to be hunting for something
// that just arrived, so it has to look rather than reorder what it already has.
{
  const { api, calls, sortToggle } = build();
  api.toggleSort();
  check('flips the order', api.sort() === 'oldest', api.sort());
  check('updates the toggle label', sortToggle.textContent === 'Oldest first', sortToggle.textContent);
  check('checks for new photos', calls.syncs.length === 1, calls.syncs.length);
  check('renders before syncing', calls.order.join(',') === 'render,sync', calls.order);
}

// Reordering invalidates scroll position outright — the photo you were looking
// at moves to the other end of the grid.
{
  const { api, calls } = build();
  api.toggleSort();
  check('does not try to preserve scroll position', calls.syncs[0].keepPosition === false, calls.syncs[0]);
  check('leaves the throttle in place', !calls.syncs[0].immediate, calls.syncs[0]);
}

// Toggling back is still a deliberate look, not a no-op.
{
  const { api, calls } = build();
  api.toggleSort();
  api.toggleSort();
  check('sorts back to newest', api.sort() === 'newest', api.sort());
  check('and checks again on the way back', calls.syncs.length === 2, calls.syncs.length);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
