// Extracts the location helpers from src/worker.js and drives them against a
// stubbed D1.
//
// Each photo stores its location label as plain text and the filters match on
// it exactly, so the list must not change once photos exist — renaming a
// location would hide every photo tagged with the old name. The admin page
// greys the editor out, but the Worker is what actually enforces it.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

function grab(name) {
  let start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  // From the body, not the first brace: renderPage destructures its parameter.
  for (let j = source.indexOf(') {', start) + 2; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) return source.slice(start, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function grabConst(name) {
  const start = source.indexOf(`const ${name} =`);
  if (start === -1) throw new Error(`missing ${name}`);
  return source.slice(start, source.indexOf(';', start) + 1);
}

const api = new Function(
  `const CORS_HEADERS = {};
   ${['LOCATIONS_MAX', 'LOCATION_LABEL_MAX', 'LOCATION_EMOJI_MAX', 'RESERVED_FILTERS', 'DEFAULT_LOCATIONS']
      .map(grabConst).join('\n')}
   const DEFAULT_THEME = 'classic';
   const THEMES = { classic: { name: 'Classic', description: '', head: '' } };
   ${['json', 'escapeHtml', 'coupleDisplay', 'coupleHeadingHtml', 'renderPage', 'resolveTheme', 'themeList', 'parseLocations',
      'validateLocations', 'handleSetLocations'].map(grab).join('\n')}
   return { DEFAULT_LOCATIONS, renderPage, parseLocations, validateLocations, handleSetLocations };`
)();

function stubDb(photoCount) {
  const writes = [];
  return {
    writes,
    DB: {
      prepare(sql) {
        return {
          async first() { return { n: photoCount }; },
          bind(...params) {
            return { async run() { writes.push({ sql, params }); return { success: true }; } };
          },
        };
      },
    },
  };
}

const request = (body) => ({ json: async () => body });
const loc = (label, emoji = '📍') => ({ emoji, label });

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('locations');

await test('saving is refused with 409 while any photos exist', async () => {
  const db = stubDb(1);
  const res = await api.handleSetLocations(request({ locations: [loc('Ceremony')] }), db);
  assert.equal(res.status, 409);
  assert.equal(db.writes.length, 0);
});

await test('saving with no photos writes the cleaned list once', async () => {
  const db = stubDb(0);
  const res = await api.handleSetLocations(
    request({ locations: [loc('  Ceremony  ', ' 💍 '), loc('Reception', '')] }), db);
  assert.equal(res.status, 200);
  const expected = [{ emoji: '💍', label: 'Ceremony' }, { emoji: '', label: 'Reception' }];
  assert.deepEqual((await res.json()).locations, expected);
  assert.equal(db.writes.length, 1);
  assert.deepEqual(db.writes[0].params, ['locations', JSON.stringify(expected)]);
});

await test('accepts 1 to 4 locations', () => {
  for (let n = 1; n <= 4; n++) {
    const list = Array.from({ length: n }, (_, i) => loc('Place ' + i));
    assert.ok(api.validateLocations(list).locations, `${n} should be allowed`);
  }
});

for (const [label, list] of [
  ['an empty list', []],
  ['five locations', ['a', 'b', 'c', 'd', 'e'].map(l => loc(l))],
  ['a non-array', 'Ceremony'],
  ['a blank label', [loc('   ')]],
  ['a missing label', [{ emoji: '💍' }]],
  ['a label over 24 characters', [loc('x'.repeat(25))]],
  ['a duplicate ignoring case', [loc('Ceremony'), loc('ceremony ')]],
  ['the reserved "all" filter', [loc('All')]],
  ['the reserved "featured" filter', [loc('Featured')]],
  ['an over-long emoji', [loc('Ceremony', '🥂'.repeat(9))]],
]) {
  await test(`rejects ${label} and writes nothing`, async () => {
    assert.ok(api.validateLocations(list).error);
    const db = stubDb(0);
    const res = await api.handleSetLocations(request({ locations: list }), db);
    assert.equal(res.status, 400);
    assert.equal(db.writes.length, 0);
  });
}

await test('accepts a label of exactly 24 characters', () => {
  assert.ok(api.validateLocations([loc('x'.repeat(24))]).locations);
});

await test('stored list parses; missing or broken storage falls back to defaults', () => {
  const stored = JSON.stringify([loc('Garden party')]);
  assert.deepEqual(api.parseLocations(stored), [loc('Garden party')]);
  assert.equal(api.parseLocations(undefined), api.DEFAULT_LOCATIONS);
  assert.equal(api.parseLocations('{not json'), api.DEFAULT_LOCATIONS);
  assert.equal(api.parseLocations('[]'), api.DEFAULT_LOCATIONS);
});

await test('renderPage cannot be broken out of by a label', () => {
  const html = '<script type="application/json">{{LOCATIONS_JSON}}</script>';
  const out = api.renderPage(html, {
    names: { name1: '', name2: '' },
    locations: [loc('</script><script>alert(1)</script>')],
  });
  assert.equal(out.match(/<\/script>/g).length, 1, 'only the real closing tag remains');
  const json = out.slice(out.indexOf('>') + 1, out.lastIndexOf('</script>'));
  assert.equal(JSON.parse(json)[0].label, '</script><script>alert(1)</script>');
});

await test('renderPage keeps a "$" in names and labels intact', () => {
  const out = api.renderPage('{{COUPLE}}|{{LOCATIONS_JSON}}', {
    names: { name1: "A$&B", name2: "C$'D" },
    locations: [loc("Bar $& grill")],
  });
  assert.ok(out.startsWith("A$&amp;B &amp; C$&#39;D|"), out);
  assert.ok(out.includes('Bar $& grill'), out);
});

console.log(`\n${passed} passed`);
