// Extracts the theme plumbing from src/worker.js and drives it directly, with
// imported themes stored in a real SQLite database standing in for D1.
//
// A theme is extra CSS injected into each page, so the things that matter are:
// Classic pages get nothing injected (they must look exactly as before), an
// unknown or missing theme falls back to Classic rather than breaking pages,
// only real themes can be saved, and imported CSS can't escape its <style>
// element or load anything the site's Content-Security-Policy would block.
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
const between = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));

// The real registry, with the imported stylesheet stood in by a marker.
const registry = between('const DEFAULT_THEME =', '/**\n * A theme id as');
// The import limits, up to the first handler.
const importConsts = between('const CUSTOM_THEME_MAX_BYTES', '/** The id for an imported theme');
// The real security headers, for the one path the admin page may frame.
const headerConsts = between('const SECURITY_HEADERS =', '// Served for MAINTENANCE_MODE');
const schema = between('const THEMES_TABLE =', '/** { version: [statements] }');
const api = new Function(
  `const CORS_HEADERS = {};
   const REDROCK_CSS = '/*redrock*/';
   const HTML = '<html data-theme="{{THEME}}"><head>{{THEME_HEAD}}</head><body data-passphrase="{{PASSPHRASE}}"><h1>{{COUPLE_HEADING}}</h1></body></html>';
   const DEFAULT_LOCATIONS = [];
   const parseLocations = () => [];
   ${schema}
   ${headerConsts}
   ${registry}
   ${importConsts}
   ${['json', 'escapeHtml', 'coupleDisplay', 'coupleHeadingHtml', 'renderPage', 'getPageConfig',
      'resolveTheme', 'themeList', 'getCustomTheme', 'handleThemePreview', 'handleSetTheme',
      'customThemeId', 'customThemeCssProblem', 'handleImportTheme', 'handleDeleteTheme',
      'addSecurityHeaders'].map(grab).join('\n')}
   return { THEMES, DEFAULT_THEME, SCHEMA_STATEMENTS, renderPage, getPageConfig, coupleHeadingHtml,
     handleSetTheme, handleThemePreview, handleImportTheme, handleDeleteTheme, customThemeId,
     customThemeCssProblem, addSecurityHeaders };`
)();

/** A D1 lookalike over SQLite, with the real schema and the couple's names. */
function makeEnv(extra = {}) {
  const db = new DatabaseSync(':memory:');
  for (const sql of api.SCHEMA_STATEMENTS) db.exec(sql);
  db.exec("INSERT INTO config (key, value) VALUES ('couple_name_1', 'Jordan'), ('couple_name_2', 'Riley')");
  function statement(sql, args = []) {
    return {
      bind: (...a) => statement(sql, a),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    };
  }
  const DB = {
    prepare: (sql) => statement(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.all());
        db.exec('COMMIT');
        return out;
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    },
  };
  return { DB, raw: db, ...extra };
}
const savedTheme = (env) => env.raw.prepare("SELECT value FROM config WHERE key = 'theme'").get()?.value;

const request = (body) => ({ json: async () => body });
const page = '<html data-theme="{{THEME}}" data-saved="{{SAVED_THEME}}"><head>{{THEME_HEAD}}</head><body><h1>{{COUPLE_HEADING}}</h1><script type="application/json">{{THEMES_JSON}}</script></body></html>';
const names = { name1: 'Jordan', name2: 'Riley' };
const themesJson = (out) => JSON.parse(out.match(/<script type="application\/json">(.*?)<\/script>/)[1]);
const GARDEN = '/* @theme\nname: Garden\ndescription: Sage and blush\n*/\n' +
  "@import url('https://fonts.googleapis.com/css2?family=Lora:wght@400;700&display=swap');\n" +
  ":root { --bg-primary: #f4f1ea; }\n.theme-scene { background: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E\"); }";
const importTheme = (env, body) => api.handleImportTheme(request({ name: 'Garden', description: 'Sage and blush', css: GARDEN, ...body }), env);

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

await test('the theme list for Settings carries ids, names, descriptions and whether imported', () => {
  const out = api.renderPage(page, { names, locations: [],
    customThemes: [{ id: 'garden', name: 'Garden', description: 'Sage', css: null }] });
  const json = themesJson(out);
  assert.deepEqual(json.map(t => t.id), [...Object.keys(api.THEMES), 'garden']);
  assert.ok(json.every(t => Object.keys(t).join() === 'id,name,description,custom'));
  assert.deepEqual(json.map(t => t.custom), [...Object.keys(api.THEMES).map(() => false), true]);
});

await test('the couple heading is two escaped spans that read as "A & B"', () => {
  assert.equal(api.coupleHeadingHtml(names),
    '<span class="couple-first">Jordan</span> <span class="couple-rest">&amp; Riley</span>');
  assert.equal(api.coupleHeadingHtml({ name1: '<b>', name2: 'x' }),
    '<span class="couple-first">&lt;b&gt;</span> <span class="couple-rest">&amp; x</span>');
  assert.equal(api.coupleHeadingHtml({ name1: 'Solo', name2: '' }), 'Solo');
});

await test('only registered or imported themes can be saved', async () => {
  const env = makeEnv();
  for (const theme of ['neon', '', 42, null, 'constructor', '__proto__']) {
    const res = await api.handleSetTheme(request({ theme }), env);
    assert.equal(res.status, 400, `"${theme}" should be refused`);
    assert.equal(savedTheme(env), undefined);
  }
  assert.equal((await api.handleSetTheme(request({ theme: 'redrock' }), env)).status, 200);
  assert.equal(savedTheme(env), 'redrock');
  await importTheme(env);
  assert.equal((await api.handleSetTheme(request({ theme: 'garden' }), env)).status, 200);
  assert.equal(savedTheme(env), 'garden');
});

const previewUrl = (theme) => new URL('https://example.com/admin/theme-preview?theme=' + theme);

await test('a theme preview renders the guest page in that theme, not the live one', async () => {
  const res = await api.handleThemePreview(previewUrl('redrock'), makeEnv({ guestPassphrase: 'sunflower' }), true);
  assert.equal(res.status, 200);
  const out = await res.text();
  assert.ok(out.includes('data-theme="redrock"'));
  assert.ok(out.includes('<style>/*redrock*/</style>'));
  assert.ok(out.includes('Jordan'));
});

await test('an imported theme has a preview too', async () => {
  const env = makeEnv();
  await importTheme(env);
  const out = await (await api.handleThemePreview(previewUrl('garden'), env, true)).text();
  assert.ok(out.includes('data-theme="garden"'));
  assert.ok(out.includes('--bg-primary: #f4f1ea'));
});

await test('a theme preview never carries the passphrase', async () => {
  const res = await api.handleThemePreview(previewUrl('classic'), makeEnv({ guestPassphrase: 'sunflower' }), true);
  const out = await res.text();
  assert.ok(!out.includes('sunflower'));
  assert.ok(out.includes('data-passphrase=""'));
});

await test('theme previews are admin-only and real themes only', async () => {
  assert.equal((await api.handleThemePreview(previewUrl('redrock'), makeEnv(), false)).status, 401);
  for (const theme of ['neon', '', 'constructor', '__proto__']) {
    assert.equal((await api.handleThemePreview(previewUrl(theme), makeEnv(), true)).status, 404, theme);
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

console.log('\nimported themes');

await test('an imported theme is stored, listed, and injected only once it is chosen', async () => {
  const env = makeEnv();
  const res = await importTheme(env);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).theme, { id: 'garden', name: 'Garden', description: 'Sage and blush', custom: true });
  let out = api.renderPage(page, await api.getPageConfig(env));
  assert.ok(out.includes('data-theme="classic"'), 'importing does not switch to it');
  assert.ok(out.includes('<head></head>'));
  assert.ok(themesJson(out).some(t => t.id === 'garden' && t.custom));
  await api.handleSetTheme(request({ theme: 'garden' }), env);
  out = api.renderPage(page, await api.getPageConfig(env));
  assert.ok(out.includes('data-theme="garden"'));
  assert.ok(out.includes(`<style>${GARDEN}</style>`));
});

await test('pages carry only the live theme\'s stylesheet, not every imported one', async () => {
  const env = makeEnv();
  await importTheme(env);
  await importTheme(env, { name: 'Coast', css: ':root { --bg-primary: #e8f1f4; }' });
  await api.handleSetTheme(request({ theme: 'coast' }), env);
  const config = await api.getPageConfig(env);
  assert.deepEqual(config.customThemes.map(t => [t.id, t.css !== null]), [['garden', false], ['coast', true]]);
  const out = api.renderPage(page, config);
  assert.ok(out.includes('#e8f1f4'));
  assert.ok(!out.includes('#f4f1ea'));
});

await test('importing the same name again replaces it', async () => {
  const env = makeEnv();
  await importTheme(env);
  const res = await importTheme(env, { name: 'garden ', css: ':root { --bg-primary: #000; }', description: 'v2' });
  assert.equal((await res.json()).replaced, true);
  const rows = env.raw.prepare('SELECT id, name, description, css FROM themes').all();
  assert.deepEqual(rows.map(r => ({ ...r })), [{ id: 'garden', name: 'garden', description: 'v2', css: ':root { --bg-primary: #000; }' }]);
});

await test('names become ids, and built-in names are refused', async () => {
  assert.equal(api.customThemeId('Garden Party!'), 'garden-party');
  assert.equal(api.customThemeId('  Café Noir  '), 'cafe-noir');
  assert.equal(api.customThemeId('🌸🌸'), '');
  for (const name of ['Red Rock', 'classic', '🌸', '', 'x'.repeat(41)]) {
    const env = makeEnv();
    assert.equal((await importTheme(env, { name })).status, 400, name);
    assert.equal(env.raw.prepare('SELECT COUNT(*) AS n FROM themes').get().n, 0, name);
  }
});

await test('CSS that could escape its style element or break the CSP is refused', async () => {
  const refused = [
    '', '   ',
    'a{}</style><script>alert(1)</script>',
    'a{}</STYLE >',
    "@import url('https://evil.example/x.css');",
    '@import "https://evil.example/x.css";',
    '@import url(//fonts.googleapis.com.evil.example/x);',
    'body { background: url(https://example.com/bg.jpg); }',
    "body { background: url('//example.com/bg.jpg'); }",
    '@font-face { src: url(https://example.com/f.woff2); }',
    'a{}' + ' '.repeat(200 * 1024),
  ];
  for (const css of refused) assert.ok(api.customThemeCssProblem(css), JSON.stringify(css.slice(0, 60)));
  const allowed = [
    GARDEN,
    '@import url("https://fonts.googleapis.com/css2?family=Archivo&display=swap");',
    '@font-face { src: url(https://fonts.gstatic.com/s/x.woff2); }',
    '/* see https://example.com/bg.jpg and url(https://example.com) */ a { color: red; }',
    "a { background: url(data:image/png;base64,AAAA); }",
  ];
  for (const css of allowed) assert.equal(api.customThemeCssProblem(css), '', css.slice(0, 60));
  const env = makeEnv();
  const res = await importTheme(env, { css: 'a{}</style>' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /<\/style/);
});

await test('a stored stylesheet that was edited by hand still cannot end its style element', () => {
  const out = api.renderPage(page, { names, locations: [], theme: 'bad',
    customThemes: [{ id: 'bad', name: 'Bad', description: '', css: 'a{}</style><script>x()</script>' }] });
  // The only </style is the real one, so the markup stays inert style text.
  assert.equal(out.match(/<\/style/gi).length, 1);
  assert.ok(out.indexOf('<script>x()') < out.search(/<\/style/i));
});

await test('there is a limit on how many themes can be imported', async () => {
  const env = makeEnv();
  for (let i = 0; i < 20; i++) assert.equal((await importTheme(env, { name: `T${i}` })).status, 200);
  assert.equal((await importTheme(env, { name: 'One more' })).status, 400);
  assert.equal((await importTheme(env, { name: 'T3' })).status, 200, 'replacing one is still fine');
});

await test('removing the live theme puts the site back on Classic', async () => {
  const env = makeEnv();
  await importTheme(env);
  await api.handleSetTheme(request({ theme: 'garden' }), env);
  assert.equal((await api.handleDeleteTheme(request({ theme: 'garden' }), env)).status, 200);
  assert.equal(env.raw.prepare('SELECT COUNT(*) AS n FROM themes').get().n, 0);
  assert.equal(savedTheme(env), 'classic');
});

await test('removing another theme leaves the live one alone; built-ins cannot be removed', async () => {
  const env = makeEnv();
  await importTheme(env);
  await api.handleSetTheme(request({ theme: 'redrock' }), env);
  await api.handleDeleteTheme(request({ theme: 'garden' }), env);
  assert.equal(savedTheme(env), 'redrock');
  for (const theme of ['classic', 'redrock', '', null]) {
    assert.equal((await api.handleDeleteTheme(request({ theme }), env)).status, 400, String(theme));
  }
});

await test('?theme=classic draws the page in Classic but keeps the saved theme for Settings', async () => {
  const out = api.renderPage(page, { names, locations: [], theme: 'redrock', forceClassic: true });
  assert.ok(out.includes('data-theme="classic"'));
  assert.ok(out.includes('data-saved="redrock"'));
  assert.ok(out.includes('<head></head>'));
  assert.ok(/searchParams\.get\('theme'\) === DEFAULT_THEME/.test(source));
});

console.log(`\n${passed} passed`);
