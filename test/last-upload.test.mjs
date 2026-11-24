// Drives formatLastUpload from public/index.html: the leaderboard's "latest
// photo" card shows elapsed time within five hours, then a relative day plus
// local time, parsed from SQLite's zone-less UTC timestamp.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

process.env.TZ = 'America/New_York';
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('function formatLastUpload(');
let depth = 0, end = -1;
for (let j = html.indexOf('{', start); j < html.length; j++) {
  if (html[j] === '{') depth++;
  else if (html[j] === '}' && --depth === 0) { end = j + 1; break; }
}
const formatLastUpload = new Function(html.slice(start, end) + '\nreturn formatLastUpload;')();
const time = s => new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const now = new Date('2026-10-18T22:00:00-04:00');
// Up to five hours: elapsed time, not a clock time.
assert.equal(formatLastUpload('2026-10-19 01:59:40', now), 'Just now');
assert.equal(formatLastUpload('2026-10-19 01:48:00', now), '12 min ago');
assert.equal(formatLastUpload('2026-10-19 00:45:00', now), '1 hr 15 min ago');
assert.equal(formatLastUpload('2026-10-18 23:00:00', now), '3 hr ago');
assert.equal(formatLastUpload('2026-10-18 21:00:00', now), '5 hr ago');
// Just past five hours falls back to the day and clock time.
assert.equal(formatLastUpload('2026-10-18 20:59:00', now), 'Today, ' + time('2026-10-18T20:59:00Z'));
// Late the previous local evening counts as one day, even under 24 hours ago.
assert.equal(formatLastUpload('2026-10-18 03:00:00', now), '1 day ago, ' + time('2026-10-18T03:00:00Z'));
assert.equal(formatLastUpload('2026-10-15 16:00:00', now), '3 days ago, ' + time('2026-10-15T16:00:00Z'));
assert.equal(formatLastUpload(null, now), '—');
console.log('last-upload: ok');
