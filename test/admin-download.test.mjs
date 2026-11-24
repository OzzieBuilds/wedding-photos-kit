// Extracts the download helpers from public/admin.html and drives them against
// stubs.
//
// The case this protects: the admin downloads everything, a few photos arrive
// late, and they download just those. Those files must land in the same folder
// without overwriting anything, so a photo's file name has to be the same
// whether it is downloaded alone or as part of the whole gallery.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).join('\n;\n');

function grab(name) {
  let start = script.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  if (script.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let j = script.indexOf(') {', start) + 2; j < script.length; j++) {
    if (script[j] === '{') depth++;
    else if (script[j] === '}' && --depth === 0) return script.slice(start, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

const photo = (id, uploader_name, location, extra = {}) =>
  ({ id, file_key: `photos/${id}.jpg`, uploader_name, location, size: 1000, is_favorite: 0, ...extra });

// Oldest first, as /presign returns them.
const gallery = () => [
  photo(1, 'Tom & Jo', 'Wedding day'),
  photo(2, 'Maya R.', 'Wedding day'),
  photo(3, 'Tom & Jo', 'Wedding day', { is_favorite: 1 }),
  photo(4, 'Tom & Jo', 'Welcome party'),
  photo(5, 'Tom & Jo', 'Wedding day', { file_key: 'photos/5.png' }),
];

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('admin download');

const { assignFileNames, zipBaseName, setNames } = new Function(`
  let coupleNames = { name1: '', name2: '' };
  ${grab('assignFileNames')}
  ${grab('zipBaseName')}
  return { assignFileNames, zipBaseName, setNames: n => { coupleNames = n; } };
`)();

await test('names follow Location-Uploader-NNN, per location and uploader', () => {
  const photos = gallery();
  assignFileNames(photos);
  assert.deepEqual(photos.map(p => p.fileName), [
    'Wedding-day-Tom---Jo-001.jpg',
    'Wedding-day-Maya-R--001.jpg',
    'Wedding-day-Tom---Jo-002-favorite.jpg',
    'Welcome-party-Tom---Jo-001.jpg',
    'Wedding-day-Tom---Jo-003.png',
  ]);
});

await test('a late photo keeps the name a full download would give it', () => {
  const full = gallery();
  assignFileNames(full);
  const byId = Object.fromEntries(full.map(p => [p.id, p.fileName]));
  // Naming always runs over the whole list; only the selection is fetched.
  const again = gallery();
  assignFileNames(again);
  const late = again.filter(p => p.id === 5);
  assert.equal(late[0].fileName, byId[5]);
  assert.equal(late[0].fileName, 'Wedding-day-Tom---Jo-003.png', 'not restarted at 001');
});

await test('ZIPs are named after the couple', () => {
  setNames({ name1: 'Jordan', name2: 'Riley' });
  assert.equal(zipBaseName(), 'jordan-and-riley');
  setNames({ name1: 'Mary Kate', name2: "O'Neil" });
  assert.equal(zipBaseName(), 'mary-kate-and-o-neil');
  setNames({ name1: '', name2: '' });
  assert.equal(zipBaseName(), 'wedding');
});

// ─── The selected-photos download ───────────────────────────────────────────

function buildSelected({ selected, list = gallery(), presignStatus = 200 }) {
  const calls = { zips: [], toasts: [], dialog: [] };
  const els = {};
  const el = () => ({ textContent: '', style: {}, disabled: false, innerHTML: '', classList: { add() {}, remove() {}, toggle() {} } });
  const api = new Function('deps', `
    let selectedIds = new Set(deps.selected);
    let downloadInProgress = false;
    let coupleNames = { name1: 'Jordan', name2: 'Riley' };
    const WORKER_URL = '';
    const document = { getElementById: id => (deps.els[id] ??= deps.el()) };
    const fetch = deps.fetch;
    const showToast = deps.toast;
    const updateBulkBar = () => {};
    const dlUpdate = () => {};
    const openDownloadDialog = t => deps.calls.dialog.push(t);
    const showDownloadFailed = e => { throw e; };
    const downloadPhotosAsZips = async (photos, stem) => deps.calls.zips.push({ photos, stem });
    ${grab('assignFileNames')}
    ${grab('zipBaseName')}
    ${grab('fetchDownloadList')}
    ${grab('downloadSelectedPhotos')}
    return { downloadSelectedPhotos, inProgress: () => downloadInProgress };
  `)({
    selected, els, el, calls,
    fetch: async () => ({ ok: presignStatus < 400, status: presignStatus, json: async () => ({ photos: list }) }),
    toast: m => calls.toasts.push(m),
  });
  return { api, calls, els };
}

await test('downloads only the selected photos, with whole-gallery names', async () => {
  const t = buildSelected({ selected: [3, 5] });
  await t.api.downloadSelectedPhotos();
  assert.equal(t.calls.zips.length, 1);
  const { photos, stem } = t.calls.zips[0];
  assert.deepEqual(photos.map(p => p.id), [3, 5]);
  assert.deepEqual(photos.map(p => p.fileName), ['Wedding-day-Tom---Jo-002-favorite.jpg', 'Wedding-day-Tom---Jo-003.png']);
  assert.equal(stem, 'jordan-and-riley-selected-photos');
  assert.equal(t.api.inProgress(), false, 'the lock is released');
});

await test('selected photos deleted meanwhile are reported, not silently dropped', async () => {
  const t = buildSelected({ selected: [1, 99] });
  await t.api.downloadSelectedPhotos();
  assert.deepEqual(t.calls.zips[0].photos.map(p => p.id), [1]);
  assert.match(t.els.dlCounts.textContent, /1 no longer available/);
});

await test('if none of the selection still exists, nothing downloads', async () => {
  const t = buildSelected({ selected: [98, 99] });
  await t.api.downloadSelectedPhotos();
  assert.equal(t.calls.zips.length, 0);
  assert.equal(t.calls.toasts.length, 1);
});

await test('an empty selection does nothing', async () => {
  const t = buildSelected({ selected: [] });
  await t.api.downloadSelectedPhotos();
  assert.equal(t.calls.dialog.length, 0);
  assert.equal(t.calls.zips.length, 0);
});

console.log(`\n${passed} passed`);
