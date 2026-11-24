// Extracts the theme plumbing from src/worker.js and drives it directly.
//
// A theme is extra CSS injected into each page, so the things that matter are:
// Classic pages get nothing injected (they must look exactly as before), an
// unknown or missing theme falls back to Classic rather than breaking pages,
// and only registered themes can be saved.
import { readFileSync } from 'node:fs';
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

// The real registry, with the imported stylesheet stood in by a marker.
const registry = source.slice(source.indexOf('const DEFAULT_THEME ='), source.indexOf('/** Saves the site\'s theme.'));
// The real security headers, for the one path the admin page may frame.
const headerConsts = source.slice(source.indexOf('const SECURITY_HEADERS ='), source.indexOf('// Served for MAINTENANCE_MODE'));
const api = new Function(
  `const CORS_HEADERS = {};
   const REDROCK_CSS = '/*redrock*/';
   const HTML = '<html data-theme="{{THEME}}"><head>{{THEME_HEAD}}</head><body data-passphrase="{{PASSPHRASE}}"><h1>{{COUPLE_HEADING}}</h1></body></html>';
   async function getPageConfig(env) {
     return { names: { name1: 'Jordan', name2: 'Riley' }, locations: [], theme: 'classic', guestPassphrase: env.guestPassphrase };
   }
   ${headerConsts}
   ${registry}
   ${['json', 'escapeHtml', 'coupleDisplay', 'coupleHeadingHtml', 'renderPage', 'handleSetTheme', 'addSecurityHeaders'].map(grab).join('\n')}
   return { THEMES, DEFAULT_THEME, renderPage, coupleHeadingHtml, handleSetTheme, handleThemePreview, addSecurityHeaders };`
)();

function stubDb() {
  const writes = [];
  return {
    writes,
    DB: { prepare(sql) { return { bind(...params) { return { async run() { writes.push(params); } }; } }; } },
  };
}
const request = (body) => ({ json: async () => body });
const page = '<html data-theme="{{THEME}}"><head>{{THEME_HEAD}}</head><body><h1>{{COUPLE_HEADING}}</h1><script type="application/json">{{THEMES_JSON}}</script></body></html>';
const names = { name1: 'Jordan', name2: 'Riley' };

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('themes');

await test('Classic is the default and injects nothing', () => {
  assert.equal(api.DEFAULT_THEME, 'classic');
  const out = api.renderPage(page, { names, locations: [] });
  assert.ok(out.includes('data-theme="classic"'));
  assert.ok(out.includes('<head></head>'));
});

await test('an unknown theme falls back to Classic', () => {
  const out = api.renderPage(page, { names, locations: [], theme: 'neon' });
  assert.ok(out.includes('data-theme="classic"'));
  assert.ok(out.includes('<head></head>'));
});

await test('inherited object keys are not themes', () => {
  for (const theme of ['constructor', 'toString', '__proto__']) {
    const out = api.renderPage(page, { names, locations: [], theme });
    assert.ok(out.includes('data-theme="classic"'), theme);
    assert.ok(!out.includes('undefined'), theme);
  }
});

await test('Red Rock injects its fonts and stylesheet', () => {
  const out = api.renderPage(page, { names, locations: [], theme: 'redrock' });
  assert.ok(out.includes('data-theme="redrock"'));
  assert.ok(out.includes('<style>/*redrock*/</style>'));
  assert.ok(out.includes('fonts.googleapis.com'));
});

await test('the theme list for Settings carries ids, names and descriptions only', () => {
  const out = api.renderPage(page, { names, locations: [] });
  const json = JSON.parse(out.match(/<script type="application\/json">(.*?)<\/script>/)[1]);
  assert.deepEqual(json.map(t => t.id), Object.keys(api.THEMES));
  assert.ok(json.every(t => Object.keys(t).join() === 'id,name,description'));
});

await test('the couple heading is two escaped spans that read as "A & B"', () => {
  assert.equal(api.coupleHeadingHtml(names),
    '<span class="couple-first">Jordan</span> <span class="couple-rest">&amp; Riley</span>');
  assert.equal(api.coupleHeadingHtml({ name1: '<b>', name2: 'x' }),
    '<span class="couple-first">&lt;b&gt;</span> <span class="couple-rest">&amp; x</span>');
  assert.equal(api.coupleHeadingHtml({ name1: 'Solo', name2: '' }), 'Solo');
});

await test('only registered themes can be saved', async () => {
  for (const theme of ['neon', '', 42, null, 'constructor', '__proto__']) {
    const db = stubDb();
    const res = await api.handleSetTheme(request({ theme }), db);
    assert.equal(res.status, 400, `"${theme}" should be refused`);
    assert.equal(db.writes.length, 0);
  }
  const db = stubDb();
  const res = await api.handleSetTheme(request({ theme: 'redrock' }), db);
  assert.equal(res.status, 200);
  assert.deepEqual(db.writes, [['theme', 'redrock']]);
});

const previewUrl = (theme) => new URL('https://example.com/admin/theme-preview?theme=' + theme);

await test('a theme preview renders the guest page in that theme, not the live one', async () => {
  const res = await api.handleThemePreview(previewUrl('redrock'), { guestPassphrase: 'sunflower' }, true);
  assert.equal(res.status, 200);
  const out = await res.text();
  assert.ok(out.includes('data-theme="redrock"'));
  assert.ok(out.includes('<style>/*redrock*/</style>'));
  assert.ok(out.includes('Jordan'));
});

await test('a theme preview never carries the passphrase', async () => {
  const res = await api.handleThemePreview(previewUrl('classic'), { guestPassphrase: 'sunflower' }, true);
  const out = await res.text();
  assert.ok(!out.includes('sunflower'));
  assert.ok(out.includes('data-passphrase=""'));
});

await test('theme previews are admin-only and registered themes only', async () => {
  assert.equal((await api.handleThemePreview(previewUrl('redrock'), {}, false)).status, 401);
  for (const theme of ['neon', '', 'constructor', '__proto__']) {
    assert.equal((await api.handleThemePreview(previewUrl(theme), {}, true)).status, 404, theme);
  }
});

await test('only the preview may be framed, and only by this site', () => {
  const csp = (res) => res.headers.get('Content-Security-Policy');
  const normal = api.addSecurityHeaders(new Response('x'));
  assert.equal(normal.headers.get('X-Frame-Options'), 'DENY');
  assert.ok(csp(normal).includes("frame-ancestors 'none'"));
  const framed = api.addSecurityHeaders(new Response('x'), { sameOriginFrame: true });
  assert.equal(framed.headers.get('X-Frame-Options'), 'SAMEORIGIN');
  assert.ok(csp(framed).includes("frame-ancestors 'self'"));
  assert.equal(csp(framed).replace("frame-ancestors 'self'", "frame-ancestors 'none'"), csp(normal));
});

await test('the worker relaxes framing for the preview path alone', () => {
  assert.ok(source.includes("const THEME_PREVIEW_PATH = '/admin/theme-preview';"));
  assert.ok(/sameOriginFrame: new URL\(request\.url\)\.pathname === THEME_PREVIEW_PATH/.test(source));
});

console.log(`\n${passed} passed`);
