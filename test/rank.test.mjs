// Extracts the success-screen rank message from public/index.html and drives it
// against stubbed leaderboard responses.
//
// The distinction under test: total_uploaders counts distinct names, not
// uploads, so being the only uploader is not the same as this being your first
// upload. Conflating them told the first guest of the day "you're the first to
// upload" on every batch they sent, which reads as though the previous one was
// lost.
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).join('\n;\n');

function grab(name) {
  let start = script.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  if (script.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let j = script.indexOf('{', start); j < script.length; j++) {
    if (script[j] === '{') depth++;
    else if (script[j] === '}' && --depth === 0) return script.slice(start, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

// Returns the message the success screen would show for a given leaderboard
// response, built from the shipped source rather than a copy of its rules.
async function messageFor(leaderboard, uploadCount) {
  const el = { textContent: '' };
  const factory = new Function('deps', `
    const storedGuestName = 'Aunt Beru';
    const WORKER_URL = '';
    const fetch = deps.fetch;
    const document = deps.document;
    const triggerConfetti = deps.triggerConfetti;
    ${grab('ordinal')}
    ${grab('showSuccessRank')}
    return showSuccessRank;
  `);
  const showSuccessRank = factory({
    fetch: async () => ({ json: async () => leaderboard }),
    document: { getElementById: () => el },
    triggerConfetti: () => {},
  });
  await showSuccessRank(uploadCount);
  return el.textContent;
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
  }
}

const solo = (guest_total) => ({
  name: 'Aunt Beru', guest_total, rank: 1, tied: false, total_uploaders: 1,
  first_place_name: 'Aunt Beru', first_place_total: guest_total,
  second_place_name: null, second_place_total: 0,
});

console.log('the only uploader:');

// guest_total includes the batch just sent, so it matching uploadCount is what
// makes this the first one.
{
  const msg = await messageFor(solo(12), 12);
  check('first ever upload is welcomed as the first', /first to upload/.test(msg), msg);
}

// The reported case: same guest, second batch, still nobody else.
{
  const msg = await messageFor(solo(32), 20);
  check('a later batch is not called the first', !/first to upload/.test(msg), msg);
  check('and acknowledges the running total', msg.includes('32'), msg);
  check('while noting they are still alone', /only one here/.test(msg), msg);
}

// A one-photo first upload is still a first upload.
{
  const msg = await messageFor(solo(1), 1);
  check('a single-photo first upload still counts as first', /first to upload/.test(msg), msg);
}

console.log('\nonce others join:');

// The solo branches must not swallow the real rankings.
{
  const msg = await messageFor({
    name: 'Aunt Beru', guest_total: 30, rank: 1, tied: false, total_uploaders: 4,
    first_place_name: 'Aunt Beru', first_place_total: 30,
    second_place_name: 'Uncle Owen', second_place_total: 22,
  }, 10);
  check('leading the pack wins gold', msg.includes('🥇') && /leading the pack/.test(msg), msg);
}

{
  const msg = await messageFor({
    name: 'Aunt Beru', guest_total: 18, rank: 2, tied: false, total_uploaders: 4,
    first_place_name: 'Uncle Owen', first_place_total: 25,
    second_place_name: 'Aunt Beru', second_place_total: 18,
  }, 5);
  check('second place names the gap and the leader', msg.includes('🥈') && msg.includes('7') && msg.includes('Uncle Owen'), msg);
}

{
  const msg = await messageFor({
    name: 'Aunt Beru', guest_total: 9, rank: 2, tied: true, total_uploaders: 5,
    first_place_name: 'Uncle Owen', first_place_total: 20,
    second_place_name: 'Aunt Beru', second_place_total: 9,
  }, 4);
  check('a tie is reported as a tie', /tied for 2nd/.test(msg), msg);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
