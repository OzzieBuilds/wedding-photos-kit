// Drives the admin rename — handleRename from src/worker.js against a stubbed
// D1, and bulkRename from public/admin.html against stubbed DOM and fetch — to
// prove a rename touches exactly the selected photos and nothing on bad input.
//
// The case it exists for: a guest types their name one way on their phone and
// another on a tablet, and the leaderboard shows them twice.
import { readFileSync } from 'node:fs';

function grabber(source) {
  return function grab(name) {
    let start = source.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`missing ${name}`);
    if (source.slice(start - 6, start) === 'async ') start -= 6;
    let depth = 0;
    for (let j = source.indexOf('{', start); j < source.length; j++) {
      if (source[j] === '{') depth++;
      else if (source[j] === '}' && --depth === 0) return source.slice(start, j + 1);
    }
    throw new Error(`unbalanced ${name}`);
  };
}

const worker = grabber(readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8'));
const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const page = grabber([...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).join('\n;\n'));

let failures = 0;
function check(label, ok) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}

// ─── Worker ──────────────────────────────────────────────────────────────────

const handleRename = new Function(
  `const CORS_HEADERS = {};
   ${worker('json')}
   ${worker('handleRename')}
   return handleRename;`
)();

function stubDb() {
  const statements = [];
  return {
    statements,
    DB: {
      prepare(sql) { return { bind: (...params) => ({ sql, params }) }; },
      async batch(list) {
        statements.push(...list);
        return list.map(s => ({ meta: { changes: s.params.length - 1 } }));
      },
    },
  };
}

const req = (body) => ({ json: async () => body });

{
  const db = stubDb();
  const res = await handleRename(req({ ids: [3, 7], name: '  Siobhán  ' }), db);
  const data = await res.json();
  check('renames the given ids', res.status === 200 && data.renamed === 2);
  check('trims the name', db.statements[0].params[0] === 'Siobhán');
  check('binds only those ids', JSON.stringify(db.statements[0].params.slice(1)) === '[3,7]');
}

{
  const db = stubDb();
  const ids = Array.from({ length: 200 }, (_, i) => i + 1);
  const data = await (await handleRename(req({ ids, name: 'Pat' }), db)).json();
  check('splits a big selection under the D1 parameter cap',
    db.statements.length === 3 && db.statements.every(s => s.params.length <= 100));
  check('and still renames all of it', data.renamed === 200);
}

for (const [label, body] of [
  ['empty name', { ids: [1], name: '   ' }],
  ['missing name', { ids: [1] }],
  ['overlong name', { ids: [1], name: 'x'.repeat(101) }],
  ['no ids', { ids: [], name: 'Pat' }],
  ['non-integer id', { ids: ['1 OR 1=1'], name: 'Pat' }],
]) {
  const db = stubDb();
  const res = await handleRename(req(body), db);
  check(`rejects ${label}`, res.status === 400 && db.statements.length === 0);
}

// ─── Admin page ──────────────────────────────────────────────────────────────

function el() {
  const classes = new Set();
  const node = {
    value: '', textContent: '', innerHTML: '', style: {}, children: [], onclick: null,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    appendChild(child) { node.children.push(child); },
    focus() {}, select() {},
  };
  return node;
}

function buildPage({ photos, selected, uploader = 'all', confirms = [], ok = true }) {
  const calls = { posted: [], toast: null, cancelled: 0, confirms: [] };
  const els = {};
  const document = {
    getElementById: (id) => (els[id] ??= el()),
    createElement: () => el(),
    addEventListener: () => {},
  };
  els.uploaderSelect = el();
  els.uploaderSelect.value = uploader;

  const factory = new Function('deps', `
    let allPhotos = deps.photos;
    let currentUploader = deps.uploader;
    const selectedIds = deps.selectedIds;
    const WORKER_URL = '';
    const { document, confirm, fetch, showToast, cancelSelectMode, renderStats } = deps;
    ${page('selectedUploaderNames')}
    ${page('selectedLabel')}
    let renameBusy = false;
    ${page('openRenameDialog')}
    ${page('closeRenameDialog')}
    ${page('submitRename')}
    ${page('mergeIntoName')}
    ${page('applyRename')}
    return { openRenameDialog, submitRename, photos: () => allPhotos, uploader: () => currentUploader };
  `);
  const api = factory({
    photos, uploader,
    selectedIds: new Set(selected),
    document,
    confirm: (msg) => { calls.confirms.push(msg); return confirms.shift(); },
    fetch: async (url, opts) => { calls.posted.push(JSON.parse(opts.body)); return { ok }; },
    showToast: (m) => { calls.toast = m; },
    cancelSelectMode: () => { calls.cancelled++; },
    renderStats: () => {},
  });
  const open = () => els.renameBackdrop.classList.contains('open');
  const nameButtons = () => els.renameNames.children;
  return { api, calls, els, open, nameButtons };
}

const photos = () => [
  { id: 1, uploader_name: 'Jon' },
  { id: 2, uploader_name: 'Jon' },
  { id: 3, uploader_name: 'John' },
  { id: 4, uploader_name: 'Mary' },
];

{
  const t = buildPage({ photos: photos(), selected: [1, 2], uploader: 'Jon' });
  t.api.openRenameDialog();
  check('opens the dialog', t.open());
  check('prefills the current name when the selection shares one', t.els.renameInput.value === 'Jon');
  check('lists every other name as a button',
    JSON.stringify(t.nameButtons().map(b => b.textContent)) === '["John","Mary"]');
  check('and none of the selection\'s own names', !t.nameButtons().some(b => b.textContent === 'Jon'));
}

{
  const t = buildPage({ photos: photos(), selected: [1, 2], uploader: 'Jon', confirms: [false] });
  t.api.openRenameDialog();
  await t.nameButtons()[0].onclick();
  check('tapping a name asks first', t.calls.confirms.length === 1
    && t.calls.confirms[0].includes('"Jon"') && t.calls.confirms[0].includes('"John"'));
  check('and saying no changes nothing', t.calls.posted.length === 0
    && t.api.photos()[0].uploader_name === 'Jon' && t.open());
}

{
  const t = buildPage({ photos: photos(), selected: [1, 2], uploader: 'Jon', confirms: [true] });
  t.api.openRenameDialog();
  await t.nameButtons()[0].onclick();
  check('saying yes merges the selected ids into that name',
    JSON.stringify(t.calls.posted) === JSON.stringify([{ ids: [1, 2], name: 'John' }]));
  check('updates the local list', t.api.photos().slice(0, 2).every(p => p.uploader_name === 'John'));
  check('moves an emptied filter to the new name',
    t.api.uploader() === 'John' && t.els.uploaderSelect.value === 'John');
  check('closes the dialog and leaves select mode', !t.open() && t.calls.cancelled === 1);
}

{
  const t = buildPage({ photos: photos(), selected: [1] });
  t.api.openRenameDialog();
  t.els.renameInput.value = '  Jonathan ';
  await t.api.submitRename();
  check('a typed name saves without a second check',
    t.calls.confirms.length === 0 && t.calls.posted[0].name === 'Jonathan');
}

{
  const t = buildPage({ photos: photos(), selected: [1] });
  t.api.openRenameDialog();
  t.els.renameInput.value = '   ';
  await t.api.submitRename();
  check('a blank name sends nothing', t.calls.posted.length === 0 && t.open());
}

{
  const t = buildPage({ photos: photos(), selected: [1], confirms: [true], ok: false });
  t.api.openRenameDialog();
  await t.nameButtons()[0].onclick();
  check('a failed rename keeps the old names', t.api.photos()[0].uploader_name === 'Jon');
  check('and keeps the dialog and selection to retry', t.open() && t.calls.cancelled === 0);
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('admin-rename: all assertions passed');
