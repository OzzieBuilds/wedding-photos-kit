// Extracts settleTile from public/index.html and drives it against a stubbed
// tile, to prove the "still working" shimmer clears on every path a thumbnail
// can finish on.
//
// A photo uploaded seconds ago usually has no stored derivative yet, so its
// grid tile sits empty while the queue (or an on-demand /v/ transform) builds
// one. The tile carries a shimmer until the image paints — which means anything
// that leaves the shimmer stuck leaves the photo invisible, since the image
// itself is held at opacity 0 while the class is on.
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

const settleTile = new Function(`${grab('settleTile')}; return settleTile;`)();

// A tile as appendPhotos builds it: a div carrying the loading class, with the
// thumbnail img inside it.
function makeTile(imgState) {
  const classes = new Set(['photo-item', 'loading']);
  const handlers = {};
  const img = imgState === null ? null : {
    complete: imgState.complete,
    naturalWidth: imgState.naturalWidth,
    addEventListener(type, fn, opts) {
      handlers[type] = { fn, opts };
    },
  };
  return {
    div: {
      classList: {
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
      querySelector: () => img,
    },
    loading: () => classes.has('loading'),
    fire: (type) => handlers[type] && handlers[type].fn(),
    handlers,
  };
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

console.log('tile loading state:');

// The whole point: a tile waiting on a thumbnail keeps saying "working".
{
  const tile = makeTile({ complete: false, naturalWidth: 0 });
  settleTile(tile.div);
  check('keeps shimmering while the thumbnail is still building', tile.loading());
  tile.fire('load');
  check('clears once the thumbnail paints', !tile.loading());
}

// The gallery re-renders constantly — every filter tap, sort flip and sync
// wipes the grid and rebuilds it. Second time around the thumbnails are in the
// browser cache and can already be decoded before the listeners attach, and the
// load event that fired is never replayed, so a listener-only implementation
// would leave every tile shimmering over a hidden image.
{
  const tile = makeTile({ complete: true, naturalWidth: 640 });
  settleTile(tile.div);
  check('clears immediately for an already-decoded thumbnail', !tile.loading());
  check('does not bother listening for a load that already happened', !tile.handlers.load);
}

// complete is also true for an img that failed, with naturalWidth left at 0 —
// treating that as decoded would be right by accident here, but it is the error
// path below that has to clear it, not the fast path.
{
  const tile = makeTile({ complete: true, naturalWidth: 0 });
  settleTile(tile.div);
  check('does not mistake a failed image for a decoded one', tile.loading());
  tile.fire('error');
  check('clears when the image gives up', !tile.loading());
}

// A tile that will never load must still reveal itself rather than shimmer
// forever — /v/ falls back to the original on an untransformable photo, but a
// genuinely broken key has to stop pretending work is in progress.
{
  const tile = makeTile({ complete: false, naturalWidth: 0 });
  settleTile(tile.div);
  tile.fire('error');
  check('clears on a thumbnail that errors out', !tile.loading());
}

// Both listeners are one-shot, so a load following a retried error cannot
// double-fire into stale state.
{
  const tile = makeTile({ complete: false, naturalWidth: 0 });
  settleTile(tile.div);
  check('registers load once only', tile.handlers.load.opts && tile.handlers.load.opts.once === true, tile.handlers.load.opts);
  check('registers error once only', tile.handlers.error.opts && tile.handlers.error.opts.once === true, tile.handlers.error.opts);
}

// Defensive: markup without an img should not strand the tile in a state that
// hides content.
{
  const tile = makeTile(null);
  settleTile(tile.div);
  check('clears a tile that has no image at all', !tile.loading());
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
