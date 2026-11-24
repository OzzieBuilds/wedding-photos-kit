// Extracts the guest-passphrase plumbing from src/worker.js and drives it
// against a stubbed D1.
//
// The guest passphrase lives only in Settings (D1) — there is no Cloudflare
// secret any more. What matters: with none saved, nobody can sign in (and an
// empty value can never verify a token), a saved one is used, a D1 outage
// fails closed, and only passphrases guests can type and scan are saved.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const pages = ['gate.html', 'admin-gate.html', 'index.html', 'admin.html']
  .map(f => [f, readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8')]);

function grab(name) {
  let start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let j = source.indexOf(') {', start) + 2; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) return source.slice(start, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
const patternLine = source.match(/^const PASSPHRASE_PATTERN = .+;$/m)[0];

const api = new Function(
  `const CORS_HEADERS = {};
   ${patternLine}
   const SCHEMA_VERSION = 1;
   async function ensureSchema() { throw new Error('the stub has no schema to create'); }
   ${['json', 'getRequestConfig', 'withRequestConfig', 'handleSetGuestPassphrase', 'handleGetGuestPassphrase',
      'generateSessionToken', 'verifySessionToken', 'generateAdminToken', 'verifyAdminToken'].map(grab).join('\n')}
   return { getRequestConfig, withRequestConfig, handleSetGuestPassphrase, handleGetGuestPassphrase,
            generateSessionToken, verifySessionToken, generateAdminToken, verifyAdminToken };`
)();

// schema_version is always present: these databases are already set up.
// Bootstrapping a new one is covered in test/schema.test.mjs.
function stubDb(rows = {}, { fail = false } = {}) {
  rows = { schema_version: '1', ...rows };
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async all() {
              if (fail) throw new Error('D1 down');
              return { results: params.filter(k => k in rows).map(k => ({ key: k, value: rows[k] })) };
            },
            async first() { if (fail) throw new Error('D1 down'); return rows[params[0]] ? { value: rows[params[0]] } : null; },
            async run() { writes.push(params); },
          };
        },
      };
    },
  };
}
const request = (body) => ({ json: async () => body });

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('guest access');

await test('with nothing saved there is no passphrase — even if an old secret is still set', async () => {
  const cfg = await api.getRequestConfig({ DB: stubDb(), GUEST_PASSPHRASE: 'old-secret' });
  assert.deepEqual(cfg, { siteMode: 'live', guestPassphrase: '', adminPasswordHash: '' });
});

await test('the passphrase saved in Settings is used', async () => {
  const cfg = await api.getRequestConfig({ DB: stubDb({ guest_passphrase: 'aspen', site_mode: 'pre' }) });
  assert.deepEqual(cfg, { siteMode: 'pre', guestPassphrase: 'aspen', adminPasswordHash: '' });
});

await test('a D1 outage fails closed: live mode, no passphrase, no admin password', async () => {
  const cfg = await api.getRequestConfig({ DB: stubDb({}, { fail: true }) });
  assert.deepEqual(cfg, { siteMode: 'live', guestPassphrase: '', adminPasswordHash: '' });
});

await test('the per-request env adds the passphrase and passes bindings through', () => {
  const DB = stubDb();
  const env = { DB, ADMIN_PASSWORD: 'admin' };
  const view = api.withRequestConfig(env, { guestPassphrase: 'aspen', adminPasswordHash: 'stored' });
  assert.equal(view.guestPassphrase, 'aspen');
  assert.equal(view.DB, DB);
  assert.equal(view.ADMIN_PASSWORD, 'admin');
  assert.equal(env.guestPassphrase, undefined, 'the original env is untouched');
});

await test('the ADMIN_PASSWORD secret outranks a stored hash as the admin secret', () => {
  const both = api.withRequestConfig({ ADMIN_PASSWORD: 'secret' }, { guestPassphrase: '', adminPasswordHash: 'stored' });
  assert.equal(both.adminSecret, 'secret');
  const hashOnly = api.withRequestConfig({}, { guestPassphrase: '', adminPasswordHash: 'stored' });
  assert.equal(hashOnly.adminSecret, 'stored');
  const neither = api.withRequestConfig({}, { guestPassphrase: '', adminPasswordHash: '' });
  assert.equal(neither.adminSecret, '');
});

await test('no passphrase means no guest session can verify', async () => {
  for (const missing of ['', undefined, null]) {
    // Whatever token a request carries — including one made from an empty key.
    for (const token of ['', 'x', await api.generateSessionToken('anything')]) {
      assert.equal(await api.verifySessionToken(token, missing), false, `${missing}/${token}`);
    }
  }
  const good = await api.generateSessionToken('aspen');
  assert.equal(await api.verifySessionToken(good, 'aspen'), true, 'a real passphrase still works');
});

await test('a missing admin password means no admin session can verify', async () => {
  for (const missing of ['', undefined]) {
    assert.equal(await api.verifyAdminToken(await api.generateAdminToken('anything'), missing), false);
  }
});

await test('saving lowercases and trims, then writes once', async () => {
  const DB = stubDb();
  const res = await api.handleSetGuestPassphrase(request({ passphrase: '  Red-Rocks27 ' }), { DB });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, passphrase: 'red-rocks27' });
  assert.deepEqual(DB.writes, [['guest_passphrase', 'red-rocks27']]);
});

for (const bad of ['', 'abc', 'x'.repeat(41), 'two words', 'p=q', 'café', 'a/b', 42, null]) {
  await test(`refuses ${JSON.stringify(bad)} and writes nothing`, async () => {
    const DB = stubDb();
    const res = await api.handleSetGuestPassphrase(request({ passphrase: bad }), { DB });
    assert.equal(res.status, 400);
    assert.equal(DB.writes.length, 0);
  });
}

await test('reading returns the passphrase, or empty when none is set', async () => {
  let res = await api.handleGetGuestPassphrase({}, { guestPassphrase: 'aspen' });
  assert.deepEqual(await res.json(), { passphrase: 'aspen' });
  res = await api.handleGetGuestPassphrase({}, { guestPassphrase: '' });
  assert.deepEqual(await res.json(), { passphrase: '' });
});

await test('only the signed-in guest page carries the passphrase placeholder', () => {
  for (const [file, html] of pages) {
    const has = html.includes('{{PASSPHRASE}}');
    assert.equal(has, file === 'index.html', `${file} ${has ? 'must not' : 'should'} contain it`);
  }
});

await test('no page or the Worker hardcodes a domain or passphrase', () => {
  for (const [file, html] of pages) {
    assert.ok(!/https?:\/\/[a-z0-9.-]+\/\?p=/i.test(html), file);
  }
  assert.ok(!/Domain=\./.test(source));
  assert.ok(!/GUEST_PASSPHRASE/.test(source), 'the Worker must not read the old secret');
  assert.ok(!/'Access-Control-Allow-Origin':/.test(source));
});

console.log(`\n${passed} passed`);
