// Drives guest likes end to end — handleLike, handleListPhotos and handleDelete
// from src/worker.js against a real SQLite database standing in for D1, and the
// like button and Featured ordering from public/index.html against stubs.
//
// The rules it holds the code to: one like per device, never on your own photo,
// never without a name; Featured is the couple's picks then the most liked.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

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

const workerSource = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const worker = grabber(workerSource);
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const page = grabber([...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).join('\n;\n'));

let failures = 0;
function check(label, ok) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}

// ─── A D1 lookalike over SQLite ──────────────────────────────────────────────
// Real SQL is the point: the joins, numbered parameters and the primary key
// that makes a second like a no-op are exactly what a stub would gloss over.

function makeD1() {
  const db = new DatabaseSync(':memory:');
  // The same statements a fresh deployment runs (SCHEMA_STATEMENTS in the Worker).
  const schema = new Function(
    `${workerSource.match(/^const THEMES_TABLE = `[\s\S]*?`;$/m)[0]}
     ${workerSource.match(/^const SCHEMA_STATEMENTS = \[[\s\S]*?^\];$/m)[0]} return SCHEMA_STATEMENTS;`
  )();
  db.exec(schema.join(';\n'));
  function statement(sql, args = []) {
    return {
      bind: (...a) => statement(sql, a),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => {
        const r = db.prepare(sql).run(...args);
        return { meta: { changes: Number(r.changes) } };
      },
    };
  }
  return {
    raw: db,
    prepare: (sql) => statement(sql),
    batch: async (stmts) => Promise.all(stmts.map(s => s.run())),
  };
}

const workerFns = new Function(
  `const CORS_HEADERS = {};
   const VARIANTS = { grid: {}, display: {} };
   ${workerSource.match(/const GUEST_ID_PATTERN = .*;/)[0]}
   ${workerSource.match(/const DEFAULT_FEATURED_MIN_LIKES = .*;/)[0]}
   ${worker('json')}
   ${worker('checkRateLimit')}
   ${worker('validGuestId')}
   ${worker('getFeaturedMinLikes')}
   ${worker('galleryFingerprint')}
   ${worker('derivedKey')}
   ${worker('handleLike')}
   ${worker('handleListPhotos')}
   ${worker('handleDelete')}
   return { handleLike, handleListPhotos, handleDelete, galleryFingerprint };`
)();

function makeEnv() {
  const kv = new Map();
  return {
    DB: makeD1(),
    RATE_LIMIT_KV: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } },
    BUCKET: { delete: async () => {} },
  };
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

function likeRequest(body) {
  return new Request('https://x/like', { method: 'POST', body: JSON.stringify(body) });
}

async function like(env, body) {
  const res = await workerFns.handleLike(likeRequest(body), env);
  return { status: res.status, data: await res.json() };
}

async function listAs(env, guestId) {
  const headers = guestId ? { 'X-Guest-Id': guestId } : {};
  const res = await workerFns.handleListPhotos(new Request('https://x/photos', { headers }), env);
  return res.json();
}

{
  console.log('handleLike:');
  const env = makeEnv();
  env.DB.raw.exec(`
    INSERT INTO photos (id, file_key, uploader_name, location, guest_id) VALUES
      (1, 'photos/a.jpg', 'Alice', 'Wedding day', '${ALICE}'),
      (2, 'photos/b.jpg', 'Old guest', 'Wedding day', NULL);
  `);

  let r = await like(env, { photo_id: 2, liked: true, guest_id: ALICE, name: '' });
  check('rejects a like with no name', r.status === 400);
  r = await like(env, { photo_id: 2, liked: true, guest_id: ALICE, name: '   ' });
  check('rejects a name of only spaces', r.status === 400);
  r = await like(env, { photo_id: 2, liked: true, guest_id: 'not-a-uuid', name: 'Alice' });
  check('rejects a malformed guest id', r.status === 400);
  r = await like(env, { photo_id: 99, liked: true, guest_id: ALICE, name: 'Alice' });
  check('404s on a photo that does not exist', r.status === 404);

  r = await like(env, { photo_id: 1, liked: true, guest_id: ALICE, name: 'Alice' });
  check('refuses a like on your own photo', r.status === 403 && r.data.error === 'own_photo');
  r = await like(env, { photo_id: 1, liked: true, guest_id: ALICE.toUpperCase(), name: 'Alice' });
  check('and is not fooled by an upper-cased id', r.status === 403);

  r = await like(env, { photo_id: 2, liked: true, guest_id: ALICE, name: 'Alice' });
  check('allows a photo uploaded before guest ids', r.status === 200 && r.data.like_count === 1);
  r = await like(env, { photo_id: 2, liked: true, guest_id: ALICE, name: 'Alice' });
  check('a second like from the same device still counts once', r.data.like_count === 1);
  r = await like(env, { photo_id: 1, liked: true, guest_id: BOB, name: 'Bob' });
  r = await like(env, { photo_id: 2, liked: true, guest_id: BOB, name: 'Bob' });
  check('another device adds its own like', r.data.like_count === 2);
  r = await like(env, { photo_id: 2, liked: false, guest_id: ALICE, name: 'Alice' });
  check('unliking removes only that device\'s like', r.data.like_count === 1 && r.data.liked === false);
  r = await like(env, { photo_id: 2, liked: false, guest_id: ALICE, name: 'Alice' });
  check('unliking twice is harmless', r.status === 200 && r.data.like_count === 1);

  console.log('\nhandleListPhotos:');
  let data = await listAs(env, ALICE);
  const a1 = data.photos.find(p => p.id === 1);
  const a2 = data.photos.find(p => p.id === 2);
  check('marks your own upload as mine', a1.mine === 1 && a2.mine === 0);
  check('counts likes per photo', a1.like_count === 1 && a2.like_count === 1);
  check('marks what this device has not liked', a1.liked === 0 && a2.liked === 0);
  check('never sends anyone\'s guest id', data.photos.every(p => !('guest_id' in p)));
  check('sends the Featured threshold, 3 by default', data.featured_min_likes === 3);

  data = await listAs(env, BOB);
  check('marks what this device has liked', data.photos.find(p => p.id === 1).liked === 1);

  data = await listAs(env, null);
  check('a device with no id owns and likes nothing', data.photos.every(p => p.mine === 0 && p.liked === 0));

  const byLocation = await workerFns.handleListPhotos(
    new Request('https://x/photos?location=Nowhere', { headers: { 'X-Guest-Id': ALICE } }), env);
  check('the location filter still applies', (await byLocation.json()).photos.length === 0);

  env.DB.raw.exec(`INSERT INTO config (key, value) VALUES ('featured_min_likes', '5')`);
  check('picks up the admin\'s threshold', (await listAs(env, ALICE)).featured_min_likes === 5);

  console.log('\ngalleryFingerprint:');
  const v1 = (await workerFns.galleryFingerprint(env)).version;
  await like(env, { photo_id: 1, liked: false, guest_id: BOB, name: 'Bob' });
  await like(env, { photo_id: 2, liked: true, guest_id: ALICE, name: 'Alice' });
  const v2 = (await workerFns.galleryFingerprint(env)).version;
  check('moves when one like leaves a photo and another arrives elsewhere', v1 !== v2);

  console.log('\nhandleDelete:');
  await workerFns.handleDelete(new Request('https://x/delete', {
    method: 'POST', body: JSON.stringify({ id: 2, file_key: 'photos/b.jpg' })
  }), env);
  const left = env.DB.raw.prepare('SELECT COUNT(*) AS n FROM likes WHERE photo_id = 2').get().n;
  check('deleting a photo deletes its likes', left === 0);
}

// ─── Featured on the guest page ──────────────────────────────────────────────

const featured = new Function(`
  ${page('isFeatured')}
  ${page('sortFeatured')}
  return { isFeatured, sortFeatured };
`)();

{
  console.log('\nFeatured:');
  check('three likes qualify at the default', featured.isFeatured({ like_count: 3 }, 3));
  check('two do not', !featured.isFeatured({ like_count: 2 }, 3));
  check('a star qualifies with no likes', featured.isFeatured({ is_favorite: 1, like_count: 0 }, 3));

  const order = featured.sortFeatured([
    { id: 'liked-early', like_count: 4, last_liked_at: '2026-11-20 10:00:00' },
    { id: 'starred-quiet', is_favorite: 1, like_count: 0, last_liked_at: null },
    { id: 'most-liked', like_count: 9, last_liked_at: '2026-11-20 09:00:00' },
    { id: 'liked-late', like_count: 4, last_liked_at: '2026-11-20 11:00:00' },
    { id: 'starred-loved', is_favorite: 1, like_count: 5, last_liked_at: '2026-11-20 08:00:00' },
  ]).map(p => p.id);
  check('starred first, then most liked, ties to the latest like — got ' + order.join(','),
    order.join(',') === 'starred-loved,starred-quiet,most-liked,liked-late,liked-early');
}

// ─── The like button ─────────────────────────────────────────────────────────

function buildButton({ photo, name, fetchImpl }) {
  const calls = { toasts: [], fetches: [], prompted: null };
  const el = () => ({ classList: { toggle() {}, add() {}, remove() {} }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, textContent: '', hidden: false, disabled: false });
  const els = {};
  const api = new Function('deps', `
    let storedGuestName = deps.name;
    let visiblePhotos = [deps.photo];
    let currentPhotoIndex = 0;
    const likesInFlight = new Set();
    let pendingLikePhoto = null;
    const OWN_PHOTO_MESSAGE = 'own';
    const WORKER_URL = '';
    const document = deps.document;
    const fetch = deps.fetch;
    const showShareToast = deps.toast;
    const ensureGuestId = () => '${ALICE}';
    const openLikeNamePrompt = deps.prompt;
    ${page('renderLike')}
    ${page('renderLikeIfShowing')}
    ${page('popHeart')}
    ${page('toggleLike')}
    ${page('sendLike')}
    return { toggleLike, renderLike, inFlight: likesInFlight };
  `)({
    name, photo,
    document: { getElementById: id => (els[id] ??= el()) },
    fetch: (url, opts) => { calls.fetches.push(JSON.parse(opts.body)); return fetchImpl(); },
    toast: m => calls.toasts.push(m),
    prompt: p => { calls.prompted = p; },
  });
  return { api, calls, els };
}

const respond = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

{
  console.log('\nlike button:');
  let photo = { id: 1, mine: 1, liked: 0, like_count: 0 };
  let t = buildButton({ photo, name: 'Alice', fetchImpl: respond(200, {}) });
  t.api.toggleLike();
  check('your own photo gets the playful message', t.calls.toasts[0] === 'own');
  check('and sends nothing', t.calls.fetches.length === 0);
  check('and the heart stays empty', photo.liked === 0);

  photo = { id: 2, mine: 0, liked: 0, like_count: 0 };
  t = buildButton({ photo, name: null, fetchImpl: respond(200, {}) });
  t.api.toggleLike();
  check('no name yet asks for one', t.calls.prompted === photo);
  check('and sends nothing until it is given', t.calls.fetches.length === 0);

  photo = { id: 3, mine: 0, liked: 0, like_count: 2 };
  let release;
  t = buildButton({ photo, name: 'Alice', fetchImpl: () => new Promise(r => { release = r; }) });
  t.api.toggleLike();
  t.api.toggleLike();
  check('a double tap sends one request', t.calls.fetches.length === 1);
  check('the heart fills straight away', photo.liked === 1 && photo.like_count === 3);
  check('the button says Liked', t.els.likeLabel.textContent === 'Liked');
  check('and the count leads the pill', t.els.likeCount.textContent === 3 && !t.els.likeCount.hidden);
  release({ ok: true, status: 200, json: async () => ({ liked: true, like_count: 7 }) });
  await new Promise(r => setTimeout(r, 0));
  check('then takes the server\'s count', photo.like_count === 7);
  check('and is free for the next tap', !t.api.inFlight.has(3));

  photo = { id: 4, mine: 0, liked: 0, like_count: 2 };
  t = buildButton({ photo, name: 'Alice', fetchImpl: respond(500, { error: 'boom' }) });
  t.api.toggleLike();
  await new Promise(r => setTimeout(r, 0));
  check('a failed like is rolled back', photo.liked === 0 && photo.like_count === 2);
  check('and says so', t.calls.toasts.length === 1);

  photo = { id: 5, mine: 0, liked: 0, like_count: 2 };
  t = buildButton({ photo, name: 'Alice', fetchImpl: respond(403, { error: 'own_photo' }) });
  t.api.toggleLike();
  await new Promise(r => setTimeout(r, 0));
  check('the server spotting your own photo gets the same message', t.calls.toasts[0] === 'own');
  check('and remembers it is yours', photo.mine === 1 && photo.liked === 0 && photo.like_count === 2);
}

{
  console.log('\nlike button labels:');
  const render = (photo) => {
    const t = buildButton({ photo, name: 'Alice', fetchImpl: respond(200, {}) });
    t.api.renderLike(photo);
    return t.els;
  };
  let els = render({ id: 1, mine: 0, liked: 0, like_count: 0 });
  check('unliked reads Like', els.likeLabel.textContent === 'Like' && els.likeIcon.textContent === '♡');
  check('no likes yet shows no count', els.likeCount.hidden === true);
  check('and is announced as just Like', els.likeBtn.attrs['aria-label'] === 'Like');
  check('the button shows on someone else’s photo', els.likeBtn.hidden === false && els.ownPhotoNote.hidden === true);

  els = render({ id: 1, mine: 0, liked: 1, like_count: 1 });
  check('the count shows in the pill', els.likeCount.textContent === 1 && !els.likeCount.hidden);
  check('liked reads Liked with a filled heart', els.likeLabel.textContent === 'Liked' && els.likeIcon.textContent === '♥');
  check('and is announced with its count', els.likeBtn.attrs['aria-label'] === 'Liked, 1 like');

  els = render({ id: 1, mine: 1, liked: 0, like_count: 4 });
  check('your own photo hides the button', els.likeBtn.hidden === true);
  check('and says Your photo instead', els.ownPhotoNote.hidden === false);
  check('and carries its likes in the same label', els.ownPhotoNote.textContent === 'Your photo · 4 likes');
  els = render({ id: 1, mine: 1, liked: 0, like_count: 1 });
  check('one like on your own photo is singular', els.ownPhotoNote.textContent === 'Your photo · 1 like');
  els = render({ id: 1, mine: 1, liked: 0, like_count: 0 });
  check('and with none it just says Your photo', els.ownPhotoNote.textContent === 'Your photo');
}

if (failures) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nlikes: all assertions passed');

