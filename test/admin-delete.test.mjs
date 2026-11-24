// Extracts the admin bulk delete and its refresh from public/admin.html and
// drives them against stubs, to prove a destructive pass cannot act on a stale
// photo list.
//
// The original bug: the page loads allPhotos once and bulkDelete iterates that
// copy, so "delete everything" silently skipped 60 photos that had been
// uploaded while the page sat open. Guests upload while the admin page is open,
// so a stale list is the normal case at a wedding, not an edge.
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).join('\n;\n');

function grab(name) {
  let start = script.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  // Keep the async modifier, or the extracted copy loses it and every await
  // inside becomes a syntax error.
  if (script.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let j = script.indexOf('{', start); j < script.length; j++) {
    if (script[j] === '{') depth++;
    else if (script[j] === '}' && --depth === 0) return script.slice(start, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

// Both functions share the module-scope allPhotos — refreshPhotos reassigns it
// and bulkDelete reads it — so they have to be built into one scope together.
function build({ photos, server, confirms, deleteOk = true }) {
  const calls = { deleted: [], renderGrid: 0, renderStats: 0, toast: null, confirms: [] };
  const btn = { disabled: false, textContent: '' };
  const cancelBtn = { disabled: false };

  const deps = {
    initialPhotos: photos,
    selectedIds: new Set(photos.map(p => p.id)),
    document: {
      getElementById: () => btn,
      querySelector: () => cancelBtn,
    },
    confirm: (msg) => { calls.confirms.push(msg); return confirms.shift(); },
    fetch: async (url, opts) => {
      if (url.endsWith('/photos')) {
        if (server === null) throw new Error('offline');
        return { ok: true, json: async () => ({ photos: server }) };
      }
      calls.deleted.push(JSON.parse(opts.body).id);
      return { ok: deleteOk };
    },
    renderGrid: () => { calls.renderGrid++; },
    renderStats: () => { calls.renderStats++; },
    cancelSelectMode: () => {},
    showToast: (m) => { calls.toast = m; },
    applyFeaturedMin: () => {},
  };

  const factory = new Function('deps', `
    let allPhotos = deps.initialPhotos;
    const selectedIds = deps.selectedIds;
    const WORKER_URL = '';
    const document = deps.document;
    const confirm = deps.confirm;
    const fetch = deps.fetch;
    const renderGrid = deps.renderGrid;
    const renderStats = deps.renderStats;
    const cancelSelectMode = deps.cancelSelectMode;
    const showToast = deps.showToast;
    const applyFeaturedMin = deps.applyFeaturedMin;
    ${grab('refreshPhotos')}
    ${grab('bulkDelete')}
    return { refreshPhotos, bulkDelete, photos: () => allPhotos };
  `);

  return { api: factory(deps), calls, btn, cancelBtn, selectedIds: deps.selectedIds };
}

const photo = (id) => ({ id, file_key: `photos/${id}.jpeg` });

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
  }
}

console.log('refreshPhotos:');

{
  const { api } = build({ photos: [photo(1)], server: [photo(1), photo(2)], confirms: [] });
  const changed = await api.refreshPhotos();
  check('reports a change when the server has more', changed === true);
  check('and adopts the server list', api.photos().length === 2, api.photos().length);
}

{
  const { api } = build({ photos: [photo(1)], server: [photo(1)], confirms: [] });
  check('reports no change when the list matches', (await api.refreshPhotos()) === false);
}

// A failed refresh must not blank the grid — stale photos beat none.
{
  const { api } = build({ photos: [photo(1), photo(2)], server: null, confirms: [] });
  const changed = await api.refreshPhotos();
  check('survives a failed fetch', changed === false);
  check('and keeps the photos already on screen', api.photos().length === 2, api.photos().length);
}

console.log('\nbulk delete:');

// The reported bug: 60 photos arrived after page load and were silently skipped.
{
  const { api, calls } = build({
    photos: [photo(1), photo(2)],
    server: [photo(1), photo(2), photo(3), photo(4)],
    confirms: [true, false],   // confirm the delete, then decline once warned
  });
  await api.bulkDelete();
  check('warns that photos arrived since selecting', calls.confirms.length === 2, calls.confirms);
  check('names how many are excluded', /2 more photos/.test(calls.confirms[1]), calls.confirms[1]);
  check('deletes nothing when the warning is declined', calls.deleted.length === 0, calls.deleted);
}

// Declining has to leave the screen usable, not stuck mid-delete.
{
  const { api, btn, cancelBtn } = build({
    photos: [photo(1)],
    server: [photo(1), photo(2)],
    confirms: [true, false],
  });
  await api.bulkDelete();
  check('re-enables the buttons after declining', btn.disabled === false && cancelBtn.disabled === false);
}

// Warned and accepted: delete exactly the selection, never the new arrivals.
{
  const { api, calls } = build({
    photos: [photo(1), photo(2)],
    server: [photo(1), photo(2), photo(3)],
    confirms: [true, true],
  });
  await api.bulkDelete();
  check('deletes only what was selected', calls.deleted.join(',') === '1,2', calls.deleted);
  check('leaves the arrival alone', !calls.deleted.includes(3), calls.deleted);
}

// Nothing arrived — the extra confirm would be noise, so it must not appear.
{
  const { api, calls } = build({
    photos: [photo(1), photo(2)],
    server: [photo(1), photo(2)],
    confirms: [true],
  });
  await api.bulkDelete();
  check('does not warn when nothing arrived', calls.confirms.length === 1, calls.confirms);
  check('and deletes the selection', calls.deleted.join(',') === '1,2', calls.deleted);
}

// The refresh is a safety net, not a dependency: offline must still delete.
{
  const { api, calls } = build({
    photos: [photo(1), photo(2)],
    server: null,
    confirms: [true],
  });
  await api.bulkDelete();
  check('still deletes when the refresh fails', calls.deleted.join(',') === '1,2', calls.deleted);
}

// Declining at the first confirm is an outright cancel, before anything is touched.
{
  const { api, calls } = build({
    photos: [photo(1)],
    server: [photo(1), photo(2)],
    confirms: [false],
  });
  await api.bulkDelete();
  check('declining the first confirm skips the refresh entirely', calls.confirms.length === 1);
  check('and deletes nothing', calls.deleted.length === 0, calls.deleted);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
