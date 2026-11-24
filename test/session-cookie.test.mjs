// Guards how sign-in cookies are scoped and how their tokens are derived.
//
//   1. Cookies are host-only (no Domain attribute), so they belong to whatever
//      domain the app is deployed on and a domain move needs no code change.
//   2. Token derivation must stay byte-identical. There is no session store:
//      the Worker recomputes HMAC(secret, message) and compares, so changing
//      the message string, the hash or the base64 alphabet silently signs out
//      every guest and admin at the next deploy. The golden values pin it.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

function grabFunction(name) {
  let start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let j = source.indexOf('{', start); j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) return source.slice(start, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function grabConst(name) {
  const m = source.match(new RegExp(`^const ${name} = (.+);$`, 'm'));
  if (!m) throw new Error(`missing ${name}`);
  return JSON.parse(m[1].replace(/^'|'$/g, '"'));
}

// ─── Cookie scope ─────────────────────────────────────────────────────────────

for (const name of ['SESSION_COOKIE_ATTRS', 'ADMIN_COOKIE_ATTRS']) {
  const attrs = grabConst(name);
  assert.doesNotMatch(attrs, /Domain=/i,
    `${name} must be host-only, or the app is tied to one domain`);
  assert.match(attrs, /;\s*Secure/, `${name} must be Secure`);
  assert.match(attrs, /;\s*HttpOnly/, `${name} must be HttpOnly`);
  assert.match(attrs, /SameSite=Lax/, `${name} must be SameSite=Lax`);
  assert.match(attrs, /^Path=\//, `${name} must apply to the whole site`);
}

// Every Set-Cookie in the Worker goes through one of the two constants. A
// fourth literal creeping in is how one route ends up host-only.
// Seven: the ?p= QR redirect, /auth, /admin/login, /admin/setup, the admin
// password change, and the two that re-issue a cookie to an already-signed-in
// guest or admin. The exact count is pinned so a new one has to be looked at
// rather than added quietly.
const literalSetCookies = source.match(/'Set-Cookie': `[^`]*`/g) ?? [];
assert.equal(literalSetCookies.length, 7, 'expected exactly 7 Set-Cookie sites');
for (const line of literalSetCookies) {
  assert.match(line, /\$\{(SESSION|ADMIN)_COOKIE_ATTRS\}/,
    `Set-Cookie built by hand instead of from the shared constants: ${line}`);
}

// ─── Duplicate cookie names ───────────────────────────────────────────────────

const getCookieValues = new Function(`${grabFunction('getCookieValues')}; return getCookieValues;`)();

assert.deepEqual(getCookieValues('auth=one', 'auth'), ['one']);
assert.deepEqual(getCookieValues('', 'auth'), []);
assert.deepEqual(getCookieValues('other=x', 'auth'), []);

// The case this exists for: a browser holding a host-only cookie *and* one
// scoped to a parent domain. Both must be offered up.
assert.deepEqual(
  getCookieValues('auth=stale; other=x; auth=fresh', 'auth'),
  ['stale', 'fresh'],
  'both cookies of the same name must be returned, not just the first'
);

// `auth` is a suffix of `admin_auth`; matching the wrong one would hand a guest
// token to the admin verifier and vice versa.
assert.deepEqual(getCookieValues('admin_auth=a', 'auth'), []);
assert.deepEqual(getCookieValues('admin_auth=a; auth=b', 'auth'), ['b']);
assert.deepEqual(getCookieValues('admin_auth=a; auth=b', 'admin_auth'), ['a']);

// ─── anyVerifies ──────────────────────────────────────────────────────────────

const anyVerifies = new Function(`${grabFunction('anyVerifies')}; return anyVerifies;`)();
const isGood = async (v, secret) => v === secret;

assert.equal(await anyVerifies([], isGood, 'good'), false);
assert.equal(await anyVerifies(['bad'], isGood, 'good'), false);
assert.equal(await anyVerifies(['bad', 'good'], isGood, 'good'), true,
  'a stale cookie ahead of a valid one must not shadow it');
assert.equal(await anyVerifies(['good', 'bad'], isGood, 'good'), true);

// ─── Token derivation ─────────────────────────────────────────────────────────

const generateSessionToken = new Function(
  `${grabFunction('generateSessionToken')}; return generateSessionToken;`
)();
const generateAdminToken = new Function(
  `${grabFunction('generateAdminToken')}; return generateAdminToken;`
)();

assert.equal(
  await generateSessionToken('test-passphrase'),
  'QAdyyMJ-1Gz5qxIsaJsFdJVUXamZxQacpGjIVFqMBrk',
  'guest token derivation changed — every signed-in guest would be signed out'
);
assert.equal(
  await generateAdminToken('test-password'),
  '9DuhYpIqrcBCYNX3f_G_g-s55mg2uKRfAJquV7L_Ubo',
  'admin token derivation changed — every signed-in admin would be signed out'
);

// Deterministic: the same passphrase always yields the same token, which is
// what lets sign-in work without a session store.
assert.equal(
  await generateSessionToken('test-passphrase'),
  await generateSessionToken('test-passphrase')
);

// URL-safe base64, no padding — a raw `+` or `/` in a cookie value is legal but
// a `=` terminates parsing in some stacks.
assert.match(await generateSessionToken('a/b+c'), /^[A-Za-z0-9_-]+$/);

// ─── Existing sessions get refreshed ──────────────────────────────────────────
//
// Both authenticated routes re-issue the cookie, so every signed-in guest and
// admin ends up holding one scoped to this host with a fresh expiry.

const authedRoutes = source.match(
  /if \(hasAuth\) \{[\s\S]*?\n    \}/
);
assert.ok(authedRoutes, 'could not find the authenticated guest branch');
assert.match(authedRoutes[0], /'Set-Cookie': `auth=\$\{refreshed\}; \$\{SESSION_COOKIE_ATTRS\}`/,
  'an already-signed-in guest must be re-issued the cookie');

const adminServe = source.slice(source.indexOf('return new Response(renderPage(ADMIN_HTML'));
assert.match(adminServe.slice(0, 400), /'Set-Cookie': `admin_auth=\$\{refreshedAdmin\}; \$\{ADMIN_COOKIE_ATTRS\}`/,
  'an already-signed-in admin must be re-issued the cookie too');

console.log('session-cookie: all assertions passed');
