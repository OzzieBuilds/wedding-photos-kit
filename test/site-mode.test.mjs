// Extracts handleSetSiteMode from src/worker.js and drives it against a stubbed
// D1, to prove going live cannot leave the derivative sweep switched off.
//
// The sweep is what repairs display sizes that fail during busy uploads, and
// the cron fires whether or not it is enabled — the flag is the only thing
// making it run. Going live is both the moment it starts mattering and the
// moment nobody is going to remember a second toggle in another menu, so the
// two are written together.
import { readFileSync } from 'node:fs';

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

// json() is the shipped response helper; the handler's contract is its output,
// so the real one is used rather than a stand-in. It spreads CORS_HEADERS,
// which only has to exist here.
const handleSetSiteMode = new Function(
  `const CORS_HEADERS = {};
   ${grabFunction('json')}
   ${grabFunction('handleSetSiteMode')}
   return handleSetSiteMode;`
)();

// Records what was written. A D1 statement is prepare().bind(), and batch()
// applies them as one transaction — so a batch that throws must write nothing.
function stubDb({ failBatch = false } = {}) {
  const writes = [];
  const batches = [];
  return {
    writes,
    batches,
    DB: {
      prepare(sql) {
        return {
          bind(...params) { return { sql, params }; },
        };
      },
      async batch(statements) {
        batches.push(statements.length);
        if (failBatch) throw new Error('D1 unavailable');
        statements.forEach(s => writes.push(s.params));
        return statements.map(() => ({ success: true }));
      },
    },
  };
}

const request = (body) => ({ json: async () => body });
const wrote = (db, key) => db.writes.find(w => w[0] === key);

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
  }
}

console.log('going live:');

{
  const db = stubDb();
  const res = await handleSetSiteMode(request({ mode: 'live' }), db);
  const body = await res.json();
  check('stores the mode', wrote(db, 'site_mode')?.[1] === 'live', db.writes);
  check('turns the sweep on with it', wrote(db, 'derivative_sweep')?.[1] === 'on', db.writes);
  check('reports what it did', body.sweepTurnedOn === true, body);
  check('succeeds', body.success === true, body);
}

// Both writes in one batch, or the site can end up live with repair still off —
// the exact state this exists to prevent.
{
  const db = stubDb();
  await handleSetSiteMode(request({ mode: 'live' }), db);
  check('writes both in a single batch', db.batches.length === 1 && db.batches[0] === 2, db.batches);
}

{
  const db = stubDb({ failBatch: true });
  const res = await handleSetSiteMode(request({ mode: 'live' }), db);
  check('a failed write is an error, not a silent success', res.status === 500, res.status);
  check('and nothing is left half-written', db.writes.length === 0, db.writes);
}

console.log('\nthe other modes:');

// Pre and post are not "photos are arriving", so they have no business
// switching the sweep on.
for (const mode of ['pre', 'post']) {
  const db = stubDb();
  const res = await handleSetSiteMode(request({ mode }), db);
  const body = await res.json();
  check(`${mode} stores the mode`, wrote(db, 'site_mode')?.[1] === mode, db.writes);
  check(`${mode} does not touch the sweep`, wrote(db, 'derivative_sweep') === undefined, db.writes);
  check(`${mode} reports it changed nothing`, body.sweepTurnedOn === false, body);
}

// Leaving live deliberately does not switch the sweep back off: the gaps it
// repairs outlive the uploads, and post-wedding is when guests are looking.
{
  const db = stubDb();
  await handleSetSiteMode(request({ mode: 'post' }), db);
  check('post never writes an off flag', db.writes.every(w => w[0] !== 'derivative_sweep'), db.writes);
  check('and writes nothing but the mode', db.batches[0] === 1, db.batches);
}

console.log('\nrejected input:');

// An unknown mode must not reach D1 at all — least of all by way of the live
// branch enabling the sweep on the way past.
for (const mode of ['LIVE', 'archived', '', null, undefined, 42]) {
  const db = stubDb();
  const res = await handleSetSiteMode(request({ mode }), db);
  check(`rejects ${JSON.stringify(mode)}`, res.status === 400, res.status);
  check(`and writes nothing for ${JSON.stringify(mode)}`, db.batches.length === 0, db.batches);
}

{
  const db = stubDb();
  const res = await handleSetSiteMode({ json: async () => { throw new Error('bad json'); } }, db);
  check('a malformed body is an error, not a write', res.status === 500, res.status);
  check('and reaches D1 not at all', db.batches.length === 0, db.batches);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
