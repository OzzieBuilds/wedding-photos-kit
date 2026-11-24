// Extracts the admin select-all controls from public/admin.html and drives them
// against stubs, to prove a one-tap "select everything" cannot be reached while
// the wedding is running.
//
// Select-all exists for clearing test uploads before the day, and the standing
// decision has been not to have one at all — it is a tap away from deleting the
// whole library. It is allowed only in pre mode, and hiding the button is not
// enough: the inline onclick handler stays reachable, so the mode has to be
// enforced inside toggleSelectAll too.
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
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

function stubEl() {
  const classes = new Set();
  return {
    textContent: '',
    classList: {
      toggle: (c, force) => { if (force) classes.add(c); else classes.delete(c); },
      has: (c) => classes.has(c),
    },
    has: (c) => classes.has(c),
  };
}

// `rendered` is which cards are currently in the DOM. The grid pages in on
// scroll, so only part of a big selection is ever on screen.
function build({ mode, selectMode = true, photos, selected = [], rendered = null }) {
  const els = {
    bulkSelectAllBtn: stubEl(),
    bulkCount: stubEl(),
    bulkDeleteBtn: stubEl(),
    bulkRenameBtn: stubEl(),
    bulkDownloadBtn: stubEl(),
  };
  const cards = new Map();
  (rendered === null ? photos.map(p => p.id) : rendered).forEach(id => {
    cards.set('card-' + id, stubEl());
  });

  // updateBulkBar is the real one rather than a stub: it is what refreshes the
  // delete count and the select-all label, so stubbing it would test the
  // wiring's absence.
  const factory = new Function('deps', `
    let siteMode = deps.mode;
    let selectMode = deps.selectMode;
    let filteredPhotos = deps.photos;
    let selectedIds = deps.selectedIds;
    let downloadInProgress = false;
    const document = deps.document;
    ${grab('updateBulkBar')}
    ${grab('allFilteredSelected')}
    ${grab('updateSelectAllLabel')}
    ${grab('updateSelectAllVisibility')}
    ${grab('toggleSelectAll')}
    return {
      toggleSelectAll,
      updateSelectAllLabel,
      updateSelectAllVisibility,
      selected: () => [...selectedIds].sort((a, b) => a - b),
      setFilter: (list) => { filteredPhotos = list; },
    };
  `);

  const api = factory({
    mode,
    selectMode,
    photos,
    selectedIds: new Set(selected),
    document: { getElementById: (id) => els[id] || cards.get(id) || null },
  });

  return { api, els, cards };
}

const PHOTOS = [{ id: 1 }, { id: 2 }, { id: 3 }];

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
  }
}

console.log('select all — mode gating:');

// The whole reason this is allowed to exist.
{
  const { api } = build({ mode: 'pre', photos: PHOTOS });
  api.toggleSelectAll();
  check('selects everything in pre mode', api.selected().join(',') === '1,2,3', api.selected());
}

// Hidden is not disabled: the onclick attribute is still in the markup and the
// function is still on window, so a stray tap or a console call must no-op.
for (const mode of ['live', 'post']) {
  const { api } = build({ mode, photos: PHOTOS });
  api.toggleSelectAll();
  check(`does nothing in ${mode} mode`, api.selected().length === 0, api.selected());
}

// /site-mode failing leaves the mode unknown. Unknown must not mean allowed.
{
  const { api } = build({ mode: null, photos: PHOTOS });
  api.toggleSelectAll();
  check('does nothing when the mode never loaded', api.selected().length === 0, api.selected());
}

// Nothing is selectable outside select mode, so the bar is not even up.
{
  const { api } = build({ mode: 'pre', selectMode: false, photos: PHOTOS });
  api.toggleSelectAll();
  check('does nothing outside select mode', api.selected().length === 0, api.selected());
}

console.log('\nselect all — visibility:');

{
  const { api, els } = build({ mode: 'pre', photos: PHOTOS });
  api.updateSelectAllVisibility();
  check('button shows in pre mode', els.bulkSelectAllBtn.has('visible'));
  check('and takes the count\'s slot', els.bulkCount.has('hidden'));
}

for (const mode of ['live', 'post', null]) {
  const { api, els } = build({ mode, photos: PHOTOS });
  api.updateSelectAllVisibility();
  check(`button stays hidden in ${mode} mode`, !els.bulkSelectAllBtn.has('visible'));
  check(`and the count keeps its slot in ${mode} mode`, !els.bulkCount.has('hidden'));
}

// Switching to live with the bar open has to take it away there and then.
{
  const { api, els } = build({ mode: 'pre', photos: PHOTOS });
  api.updateSelectAllVisibility();
  check('visible while still in pre mode', els.bulkSelectAllBtn.has('visible'));
}

{
  const { api, els } = build({ mode: 'pre', selectMode: false, photos: PHOTOS });
  api.updateSelectAllVisibility();
  check('hidden when not selecting, even in pre mode', !els.bulkSelectAllBtn.has('visible'));
}

console.log('\nselect all — scope and toggle:');

// Filters narrow what is on screen, and select-all has to mean "what I can
// see". Selecting hidden photos would make the delete count a lie.
{
  const { api } = build({ mode: 'pre', photos: [{ id: 2 }] });
  api.toggleSelectAll();
  check('only selects what the filters show', api.selected().join(',') === '2', api.selected());
}

// A second tap has to undo it, or the button is dead once everything is picked.
{
  const { api } = build({ mode: 'pre', photos: PHOTOS });
  api.toggleSelectAll();
  api.toggleSelectAll();
  check('a second tap deselects', api.selected().length === 0, api.selected());
}

// A partial selection means "finish the job", not "throw away what I picked".
{
  const { api } = build({ mode: 'pre', photos: PHOTOS, selected: [2] });
  api.toggleSelectAll();
  check('extends a partial selection to all', api.selected().join(',') === '1,2,3', api.selected());
}

{
  const { api, els } = build({ mode: 'pre', photos: PHOTOS, selected: [2] });
  api.updateSelectAllLabel();
  check('reads "Select all" while partly selected', els.bulkSelectAllBtn.textContent === 'Select all', els.bulkSelectAllBtn.textContent);
  api.toggleSelectAll();
  check('flips to "Deselect all" once everything is picked', els.bulkSelectAllBtn.textContent === 'Deselect all', els.bulkSelectAllBtn.textContent);
}

// An empty filter has nothing to select, so "Deselect all" would be nonsense.
{
  const { api, els } = build({ mode: 'pre', photos: [] });
  api.updateSelectAllLabel();
  check('stays "Select all" when the filter is empty', els.bulkSelectAllBtn.textContent === 'Select all', els.bulkSelectAllBtn.textContent);
}

// Changing filter changes what "all" covers, so the label has to be recomputed
// rather than left saying "Deselect all" over a fresh set.
{
  const { api, els } = build({ mode: 'pre', photos: PHOTOS });
  api.toggleSelectAll();
  api.setFilter([{ id: 4 }, { id: 5 }]);
  api.updateSelectAllLabel();
  check('goes back to "Select all" when the filter widens', els.bulkSelectAllBtn.textContent === 'Select all', els.bulkSelectAllBtn.textContent);
}

console.log('\nselect all — painting the grid:');

// The grid pages in on scroll, so most of a big selection has no card yet.
// appendAdminPhotos reads selectedIds for cards it builds later; repainting the
// ones on screen is what keeps the scroll position, so it must not fall over on
// the ids that are not rendered.
{
  const { api, cards } = build({ mode: 'pre', photos: PHOTOS, rendered: [1] });
  api.toggleSelectAll();
  check('selects photos with no card on screen', api.selected().join(',') === '1,2,3', api.selected());
  check('marks the card that is rendered', cards.get('card-1').has('selected'));
}

{
  const { api, cards } = build({ mode: 'pre', photos: PHOTOS });
  api.toggleSelectAll();
  check('marks every rendered card', [1, 2, 3].every(id => cards.get('card-' + id).has('selected')));
  api.toggleSelectAll();
  check('unmarks them all on deselect', [1, 2, 3].every(id => !cards.get('card-' + id).has('selected')));
}

// Selecting without refreshing the bar would leave a disabled "Delete 0 photos"
// sitting over a full selection.
{
  const { api, els } = build({ mode: 'pre', photos: PHOTOS });
  api.toggleSelectAll();
  check('delete button picks up the count', els.bulkDeleteBtn.textContent === 'Delete 3 photos', els.bulkDeleteBtn.textContent);
  check('and is enabled', els.bulkDeleteBtn.disabled === false, els.bulkDeleteBtn.disabled);
  api.toggleSelectAll();
  check('and goes back to disabled on deselect', els.bulkDeleteBtn.disabled === true, els.bulkDeleteBtn.disabled);
}

{
  const { api, els } = build({ mode: 'live', photos: PHOTOS });
  api.toggleSelectAll();
  check('leaves the delete button alone when blocked', els.bulkDeleteBtn.textContent === '', els.bulkDeleteBtn.textContent);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
