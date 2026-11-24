// The admin stats time zone: a Setting, so the wedding-day hours don't shift
// when the couple look from somewhere else. Saved automatically on the first
// admin visit from that device's zone; changeable in Settings.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');

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

const api = new Function(`
  const CORS_HEADERS = {};
  ${['json', 'isValidTimezone', 'handleSetStatsTimezone', 'escapeHtml'].map(grab).join('\n')}
  return { isValidTimezone, handleSetStatsTimezone, escapeHtml };
`)();

function stubDb() {
  const writes = [];
  return { writes, prepare: () => ({ bind: (...p) => ({ run: async () => { writes.push(p); } }) }) };
}
const request = (body) => ({ json: async () => body });

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('stats time zone');

await test('real IANA zones are accepted', () => {
  for (const tz of ['Europe/Dublin', 'America/Denver', 'Asia/Kolkata', 'Australia/Lord_Howe', 'UTC']) {
    assert.equal(api.isValidTimezone(tz), true, tz);
  }
});

await test('anything else is refused', () => {
  for (const tz of ['', 'Mars/Olympus', 'Europe', 'x'.repeat(65), 42, null, undefined, {}]) {
    assert.equal(api.isValidTimezone(tz), false, String(tz));
  }
});

await test('saving writes the zone once; a bad one writes nothing', async () => {
  const DB = stubDb();
  const ok = await api.handleSetStatsTimezone(request({ timezone: 'America/Denver' }), { DB });
  assert.equal(ok.status, 200);
  assert.deepEqual(DB.writes, [['stats_timezone', 'America/Denver']]);
  const bad = await api.handleSetStatsTimezone(request({ timezone: 'Nowhere/Land' }), { DB });
  assert.equal(bad.status, 400);
  assert.equal(DB.writes.length, 1);
});

await test('the admin page reads the saved zone and no zone is hardcoded', () => {
  assert.match(admin, /<body data-stats-tz="\{\{STATS_TZ\}\}">/);
  assert.match(source, /\.replaceAll\('\{\{STATS_TZ\}\}', \(\) => escapeHtml\(statsTimezone\)\)/);
  assert.doesNotMatch(admin, /const TZ = '[A-Za-z_]+\/[A-Za-z_]+'/);
  assert.doesNotMatch(admin, /Irish time|Europe\/Dublin/);
});

console.log(`\n${passed} passed`);
