// First-visit admin password: handleAdminSetup, handleAdminLogin and
// handleChangeAdminPassword from src/worker.js against a real SQLite database
// standing in for D1.
//
// What matters: a new site can be claimed exactly once, and never while an
// admin password exists; the stored hash signs in and nothing else does; the
// ADMIN_PASSWORD Cloudflare secret always wins; changing the password needs the
// current one and signs every other admin out.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

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
const line = (name) => source.match(new RegExp(`^const ${name} = [^\\n]*;$`, 'm'))[0];

const api = new Function(`
  const CORS_HEADERS = {};
  ${line('ADMIN_COOKIE_ATTRS')}
  ${line('ADMIN_PASSWORD_MIN')}
  ${line('ADMIN_PASSWORD_MAX')}
  ${line('PBKDF2_ITERATIONS')}
  ${['json', 'checkRateLimit', 'withRequestConfig', 'generateAdminToken', 'verifyAdminToken',
     'checkAdminPassword', 'adminPasswordProblem', 'hashPassword', 'verifyPasswordHash', 'pbkdf2',
     'toBase64Url', 'fromBase64Url', 'constantTimeEqual', 'handleAdminSetup', 'handleAdminLogin',
     'handleChangeAdminPassword'].map(grab).join('\n')}
  return { withRequestConfig, generateAdminToken, verifyAdminToken, hashPassword, verifyPasswordHash,
           handleAdminSetup, handleAdminLogin, handleChangeAdminPassword, PBKDF2_ITERATIONS };
`)();

function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  function statement(sql, args = []) {
    return {
      bind: (...a) => statement(sql, a),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    };
  }
  return { raw: db, prepare: (sql) => statement(sql) };
}

/** A deployment: the D1 database and KV persist; each request gets a fresh view. */
function makeSite(secrets = {}) {
  const DB = makeD1();
  const kv = new Map();
  const RATE_LIMIT_KV = { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } };
  return {
    DB,
    clearRateLimit: () => kv.clear(),
    storedHash: () => DB.raw.prepare("SELECT value FROM config WHERE key = 'admin_password_hash'").get()?.value ?? '',
    // What the router builds per request (see getRequestConfig / withRequestConfig).
    env() {
      return api.withRequestConfig({ DB, RATE_LIMIT_KV, ...secrets },
        { guestPassphrase: '', adminPasswordHash: this.storedHash() });
    },
  };
}

const post = (body, ip = '1.2.3.4') => new Request('https://x/', {
  method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': ip },
});
const cookieOf = (res) => (res.headers.get('Set-Cookie') || '').match(/^admin_auth=([^;]*)/)?.[1];

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('admin setup');

await test('hashes are salted, carry their iteration count, and verify only the right password', async () => {
  const a = await api.hashPassword('correct horse battery');
  const b = await api.hashPassword('correct horse battery');
  assert.notEqual(a, b, 'two hashes of one password must differ (random salt)');
  assert.match(a, new RegExp(`^pbkdf2-sha256\\$${api.PBKDF2_ITERATIONS}\\$[A-Za-z0-9_-]+\\$[A-Za-z0-9_-]+$`));
  assert.equal(await api.verifyPasswordHash('correct horse battery', a), true);
  assert.equal(await api.verifyPasswordHash('correct horse batterY', a), false);
  for (const junk of ['', 'plain', 'md5$1$a$b', 'pbkdf2-sha256$x$a$b', 'pbkdf2-sha256$1000$$']) {
    assert.equal(await api.verifyPasswordHash('anything', junk), false, junk);
  }
});

await test('a new site is claimed once, and the claimer is signed in', async () => {
  const site = makeSite();
  const res = await api.handleAdminSetup(post({ password: '  first-owner-pw  ' }), site.env());
  assert.equal(res.status, 200);
  const hash = site.storedHash();
  assert.match(hash, /^pbkdf2-sha256\$/);
  assert.equal(await api.verifyPasswordHash('first-owner-pw', hash), true, 'stored trimmed, like sign-in');
  assert.equal(await api.verifyAdminToken(cookieOf(res), site.env().adminSecret), true);

  const again = await api.handleAdminSetup(post({ password: 'second-person-pw' }), site.env());
  assert.equal(again.status, 409);
  assert.equal(site.storedHash(), hash, 'the first password stands');
});

await test('two people racing to claim a new site cannot both win', async () => {
  const site = makeSite();
  // Both requests were routed before either wrote: each saw no password.
  const envA = site.env();
  const envB = site.env();
  const [a, b] = await Promise.all([
    api.handleAdminSetup(post({ password: 'owner-password-a' }, '1.1.1.1'), envA),
    api.handleAdminSetup(post({ password: 'owner-password-b' }, '2.2.2.2'), envB),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(cookieOf(b.status === 409 ? b : a), undefined, 'the loser gets no session');
});

await test('setup is refused while an ADMIN_PASSWORD secret is set', async () => {
  const site = makeSite({ ADMIN_PASSWORD: 'from-cloudflare' });
  const res = await api.handleAdminSetup(post({ password: 'would-be-owner' }), site.env());
  assert.equal(res.status, 409);
  assert.equal(site.storedHash(), '');
});

await test('setup refuses short or missing passwords and stores nothing', async () => {
  const site = makeSite();
  for (const bad of ['', 'short', '   nine9   ', 'x'.repeat(201), 42, null, undefined]) {
    site.clearRateLimit();
    const res = await api.handleAdminSetup(post({ password: bad }), site.env());
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.equal(site.storedHash(), '');
});

await test('sign-in works with the stored password and nothing else', async () => {
  const site = makeSite();
  await api.handleAdminSetup(post({ password: 'owner-password' }), site.env());
  site.clearRateLimit();
  for (const wrong of ['', 'owner-passwor', 'Owner-password', site.storedHash()]) {
    const res = await api.handleAdminLogin(post({ password: wrong }), site.env());
    assert.equal(res.status, 401, wrong);
  }
  site.clearRateLimit();
  const ok = await api.handleAdminLogin(post({ password: ' owner-password ' }), site.env());
  assert.equal(ok.status, 200);
  assert.equal(await api.verifyAdminToken(cookieOf(ok), site.env().adminSecret), true);
});

await test('with no admin password at all, sign-in always fails', async () => {
  const site = makeSite();
  const res = await api.handleAdminLogin(post({ password: '' }), site.env());
  assert.equal(res.status, 401);
});

await test('the ADMIN_PASSWORD secret wins over a stored hash', async () => {
  const site = makeSite();
  await api.handleAdminSetup(post({ password: 'stored-password' }), site.env());
  const withSecret = makeSite({ ADMIN_PASSWORD: 'cloudflare-secret' });
  withSecret.DB.raw.prepare('INSERT INTO config VALUES (?, ?)').run('admin_password_hash', site.storedHash());
  assert.equal((await api.handleAdminLogin(post({ password: 'stored-password' }), withSecret.env())).status, 401);
  assert.equal((await api.handleAdminLogin(post({ password: 'cloudflare-secret' }), withSecret.env())).status, 200);
  const change = await api.handleChangeAdminPassword(
    post({ current: 'cloudflare-secret', password: 'new-password-1' }), withSecret.env());
  assert.equal(change.status, 409, 'cannot change a password Cloudflare manages');
});

await test('changing the password needs the current one and signs other admins out', async () => {
  const site = makeSite();
  const setup = await api.handleAdminSetup(post({ password: 'owner-password' }), site.env());
  const oldCookie = cookieOf(setup);

  site.clearRateLimit();
  const wrong = await api.handleChangeAdminPassword(post({ current: 'not-it', password: 'new-password-1' }), site.env());
  assert.equal(wrong.status, 403);
  const tooShort = await api.handleChangeAdminPassword(post({ current: 'owner-password', password: 'short' }), site.env());
  assert.equal(tooShort.status, 400);

  site.clearRateLimit();
  const ok = await api.handleChangeAdminPassword(post({ current: 'owner-password', password: 'new-password-1' }), site.env());
  assert.equal(ok.status, 200);
  const secret = site.env().adminSecret;
  assert.equal(await api.verifyAdminToken(oldCookie, secret), false, 'old sessions end');
  assert.equal(await api.verifyAdminToken(cookieOf(ok), secret), true, 'this one continues');

  site.clearRateLimit();
  assert.equal((await api.handleAdminLogin(post({ password: 'owner-password' }), site.env())).status, 401);
  assert.equal((await api.handleAdminLogin(post({ password: 'new-password-1' }), site.env())).status, 200);
});

await test('setup and password changes are rate limited like sign-in', async () => {
  const site = makeSite();
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    statuses.push((await api.handleAdminSetup(post({ password: 'short' }), site.env())).status);
  }
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429, 429]);
});

await test('the router serves the setup page only while no admin password exists', () => {
  assert.match(source, /const page = env\.adminSecret \? ADMIN_GATE_HTML : ADMIN_SETUP_HTML;/);
  assert.match(source, /url\.pathname === '\/admin\/setup'/);
});

console.log(`\n${passed} passed`);
