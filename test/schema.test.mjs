// The database sets itself up: getRequestConfig and ensureSchema from
// src/worker.js against a real SQLite database standing in for D1.
//
// What matters: a brand-new, empty database gets every table on the first
// request and nobody runs a migration; a database that is already set up costs
// no extra work; an outage is never mistaken for an empty database.
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
// One-line constants, a template literal, or an array or object literal
// closed by `];` / `};` at the start of a line.
const grabConst = (name) => (source.match(new RegExp(`^const ${name} = [^\\n]*;$`, 'm'))
  ?? source.match(new RegExp(`^const ${name} = \`[\\s\\S]*?\`;$`, 'm'))
  ?? source.match(new RegExp(`^const ${name} = [\\[{][\\s\\S]*?^[\\]}];$`, 'm')))[0];

const api = new Function(`
  ${grabConst('THEMES_TABLE')}
  ${grabConst('SCHEMA_VERSION')}
  ${grabConst('SCHEMA_STATEMENTS')}
  ${grabConst('SCHEMA_UPGRADES')}
  ${grab('ensureSchema')}
  ${grab('getRequestConfig')}
  return { getRequestConfig, ensureSchema, SCHEMA_VERSION, SCHEMA_UPGRADES, SCHEMA_STATEMENTS };
`)();

/** A D1 lookalike over SQLite, counting batches so set-up work is visible. */
function makeD1() {
  const db = new DatabaseSync(':memory:');
  const d1 = { raw: db, batches: 0 };
  function statement(sql, args = []) {
    return {
      sql, args,
      bind: (...a) => statement(sql, a),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    };
  }
  d1.prepare = (sql) => statement(sql);
  // D1 runs a batch as one transaction; so does this.
  d1.batch = async (stmts) => {
    d1.batches++;
    db.exec('BEGIN');
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  return d1;
}

const tables = (d1) => d1.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all().map(r => r.name).filter(n => !n.startsWith('sqlite_'));

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('schema');

await test('an empty database gets every table on the first request', async () => {
  const DB = makeD1();
  assert.deepEqual(tables(DB), []);
  const cfg = await api.getRequestConfig({ DB });
  assert.deepEqual(cfg, { siteMode: 'live', guestPassphrase: '', adminPasswordHash: '' });
  assert.deepEqual(tables(DB), ['config', 'likes', 'photos', 'themes']);
  const row = DB.raw.prepare("SELECT value FROM config WHERE key = 'schema_version'").get();
  assert.equal(row.value, String(api.SCHEMA_VERSION));
});

await test('once set up, later requests do no set-up work', async () => {
  const DB = makeD1();
  await api.getRequestConfig({ DB });
  assert.equal(DB.batches, 1);
  for (let i = 0; i < 3; i++) await api.getRequestConfig({ DB });
  assert.equal(DB.batches, 1, 'a set-up database must cost only the one read');
});

await test('the new tables accept the writes the app makes', async () => {
  const DB = makeD1();
  await api.getRequestConfig({ DB });
  DB.raw.prepare("INSERT INTO photos (file_key, uploader_name, location, guest_id) VALUES ('photos/a.jpg', 'Sam', 'Ceremony', 'g1')").run();
  DB.raw.prepare("INSERT INTO likes (photo_id, guest_id, guest_name) VALUES (1, 'g2', 'Alex')").run();
  assert.throws(() => DB.raw.prepare("INSERT INTO likes (photo_id, guest_id, guest_name) VALUES (1, 'g2', 'Alex')").run(),
    /UNIQUE|PRIMARY KEY/, 'one like per photo per device');
  const photo = DB.raw.prepare('SELECT is_favorite, uploaded_at FROM photos').get();
  assert.equal(photo.is_favorite, 0);
  assert.ok(photo.uploaded_at);
});

await test('settings saved before the version was recorded survive set-up', async () => {
  // A database made by hand from the old schema.sql: tables, no schema_version.
  const DB = makeD1();
  await api.ensureSchema(DB, 0);
  DB.raw.exec("DELETE FROM config WHERE key = 'schema_version'");
  DB.raw.exec("INSERT INTO config (key, value) VALUES ('guest_passphrase', 'aspen'), ('site_mode', 'pre')");
  const cfg = await api.getRequestConfig({ DB });
  assert.deepEqual(cfg, { siteMode: 'pre', guestPassphrase: 'aspen', adminPasswordHash: '' });
});

await test('running set-up twice at once is harmless', async () => {
  const DB = makeD1();
  await Promise.all([api.getRequestConfig({ DB }), api.getRequestConfig({ DB })]);
  assert.deepEqual(tables(DB), ['config', 'likes', 'photos', 'themes']);
});

await test('an outage is not mistaken for an empty database', async () => {
  let batches = 0;
  const DB = {
    prepare: () => ({ bind: () => ({ all: async () => { throw new Error('D1_ERROR: Network connection lost.'); } }) }),
    batch: async () => { batches++; },
  };
  const cfg = await api.getRequestConfig({ DB });
  assert.deepEqual(cfg, { siteMode: 'live', guestPassphrase: '', adminPasswordHash: '' }, 'fails closed');
  assert.equal(batches, 0, 'must not run set-up, which would skip pending upgrades');
});

await test('a version 1 database gains the themes table and keeps its data', async () => {
  const DB = makeD1();
  for (const sql of ['photos', 'likes', 'config'].map(t => api.SCHEMA_STATEMENTS.find(s => s.includes(`EXISTS ${t} `)))) {
    DB.raw.exec(sql);
  }
  DB.raw.exec("INSERT INTO config (key, value) VALUES ('schema_version', '1'), ('guest_passphrase', 'aspen')");
  const cfg = await api.getRequestConfig({ DB });
  assert.equal(cfg.guestPassphrase, 'aspen');
  assert.deepEqual(tables(DB), ['config', 'likes', 'photos', 'themes']);
  assert.equal(DB.raw.prepare("SELECT value FROM config WHERE key = 'schema_version'").get().value, '2');
});

await test('an older database runs only the upgrades it is missing, in order', async () => {
  // Exercise the upgrade path with made-up versions 2 and 3.
  const ran = [];
  const DB = { prepare: (sql) => ({ sql, bind() { return this; } }), batch: async (s) => { ran.push(...s.map(x => x.sql)); } };
  const withUpgrades = new Function(`
    const SCHEMA_VERSION = 3;
    const SCHEMA_STATEMENTS = ['CREATE everything'];
    const SCHEMA_UPGRADES = { 3: ['step 3'], 2: ['step 2'] };
    ${grab('ensureSchema')}
    return ensureSchema;
  `)();
  await withUpgrades(DB, 1);
  assert.deepEqual(ran.slice(0, 2), ['step 2', 'step 3']);
  ran.length = 0;
  await withUpgrades(DB, 2);
  assert.deepEqual(ran.slice(0, 1), ['step 3']);
  ran.length = 0;
  await withUpgrades(DB, 0);
  assert.deepEqual(ran.slice(0, 1), ['CREATE everything'], 'a new database gets the current schema, not the history');
  assert.match(ran.at(-1), /^INSERT INTO config/, 'and records the new version in the same batch');
});

console.log(`\n${passed} passed`);
