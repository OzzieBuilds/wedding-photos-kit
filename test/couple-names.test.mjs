// Extracts the couple-name helpers from src/worker.js and drives them directly.
//
// The names are free text typed in the admin page and rendered into every
// guest-facing page, including the pre-login gate, so escaping is the part
// that matters most: a name is shown, never interpreted.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

function grabFunction(name) {
  let start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  // Start at the body, not the first brace: coupleDisplay destructures its
  // parameter, and that `{` would otherwise be taken for the body.
  for (let j = source.indexOf(') {', start) + 2; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) return source.slice(start, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

const { coupleDisplay, renderPage, handleSetCoupleNames } = new Function(
  `const CORS_HEADERS = {};
   const COUPLE_NAME_MAX = 40;
   const DEFAULT_THEME = 'classic';
   const THEMES = { classic: { name: 'Classic', description: '', head: '' } };
   ${grabFunction('coupleHeadingHtml')}
   ${grabFunction('json')}
   ${grabFunction('coupleDisplay')}
   ${grabFunction('escapeHtml')}
   ${grabFunction('renderPage')}
   const renderNames = (html, names) => renderPage(html, { names, locations: [] });
   ${grabFunction('handleSetCoupleNames')}
   return { coupleDisplay, renderPage: renderNames, handleSetCoupleNames };`
)();

function stubDb() {
  const writes = [];
  const batches = [];
  return {
    writes,
    batches,
    DB: {
      prepare(sql) { return { bind(...params) { return { sql, params }; } }; },
      async batch(statements) {
        batches.push(statements.length);
        statements.forEach(s => writes.push(s.params));
        return statements.map(() => ({ success: true }));
      },
    },
  };
}

const request = (body) => ({ json: async () => body });
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('couple names');

await test('display joins both names with an ampersand', () => {
  assert.equal(coupleDisplay({ name1: 'Alex', name2: 'Sam' }), 'Alex & Sam');
});

await test('display falls back to one name, then a generic title', () => {
  assert.equal(coupleDisplay({ name1: 'Alex', name2: '' }), 'Alex');
  assert.equal(coupleDisplay({ name1: '', name2: 'Sam' }), 'Sam');
  assert.equal(coupleDisplay({ name1: '', name2: '' }), 'Our wedding');
});

await test('renderPage fills every placeholder and escapes ampersands', () => {
  const html = '<title>{{COUPLE}}</title><h1>{{COUPLE}}</h1><body data-couple="{{COUPLE}}">';
  const out = renderPage(html, { name1: 'Alex', name2: 'Sam' });
  assert.equal(out,
    '<title>Alex &amp; Sam</title><h1>Alex &amp; Sam</h1><body data-couple="Alex &amp; Sam">');
});

await test('renderPage escapes markup and quotes in names', () => {
  const out = renderPage('<b data-x="{{COUPLE}}">{{COUPLE}}</b>',
    { name1: '<script>alert(1)</script>', name2: `"O'Brien"` });
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(out.includes('&quot;O&#39;Brien&quot;'));
  assert.equal(out.match(/"/g).length, 2, 'only the attribute’s own quotes survive');
});

await test('valid names are trimmed and written together in one batch', async () => {
  const db = stubDb();
  const res = await handleSetCoupleNames(request({ name1: '  Alex ', name2: 'Sam  ' }), db);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, name1: 'Alex', name2: 'Sam' });
  assert.deepEqual(db.batches, [2]);
  assert.deepEqual(db.writes, [['couple_name_1', 'Alex'], ['couple_name_2', 'Sam']]);
});

for (const [label, body] of [
  ['empty name', { name1: '', name2: 'Sam' }],
  ['whitespace-only name', { name1: 'Alex', name2: '   ' }],
  ['missing name', { name1: 'Alex' }],
  ['non-string name', { name1: 'Alex', name2: 42 }],
  ['name over 40 characters', { name1: 'x'.repeat(41), name2: 'Sam' }],
]) {
  await test(`rejects ${label} and writes nothing`, async () => {
    const db = stubDb();
    const res = await handleSetCoupleNames(request(body), db);
    assert.equal(res.status, 400);
    assert.equal(db.writes.length, 0);
  });
}

await test('accepts a name of exactly 40 characters', async () => {
  const db = stubDb();
  const res = await handleSetCoupleNames(request({ name1: 'x'.repeat(40), name2: 'Sam' }), db);
  assert.equal(res.status, 200);
});

console.log(`\n${passed} passed`);
