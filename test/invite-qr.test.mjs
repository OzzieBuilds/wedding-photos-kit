// Runs the admin page's invite QR drawing (drawQr) with the inline
// qrcode-generator library against a recording canvas.
//
// A QR code on a printed invite can't be fixed after the fact, so what's held
// here is everything a scanner depends on: a white background, a 4-module
// quiet zone, square whole-pixel modules, a print-size image, and that every
// link the app can produce fits. That the codes decode to the exact link was
// verified in a browser with BarcodeDetector.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const lib = scripts.find(s => s.includes('QR Code Generator for JavaScript'));
assert.ok(lib, 'qrcode-generator must be inlined in admin.html');
const page = scripts.join('\n;\n');

function grab(name) {
  let start = page.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  let depth = 0;
  for (let j = page.indexOf(') {', start) + 2; j < page.length; j++) {
    if (page[j] === '{') depth++;
    else if (page[j] === '}' && --depth === 0) return page.slice(start, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
const constLine = n => page.match(new RegExp(`const ${n} = [^;]+;`))[0];

const drawQr = new Function(`
  ${lib}
  ${constLine('QR_ERROR_CORRECTION')}
  ${constLine('QR_QUIET_ZONE')}
  ${constLine('QR_PNG_SIZE')}
  ${grab('drawQr')}
  return drawQr;
`)();

function recordingCanvas() {
  const rects = [];
  let fill = null;
  const canvas = {
    width: 0, height: 0, rects,
    getContext: () => ({
      set fillStyle(v) { fill = v; },
      fillRect: (x, y, w, h) => rects.push({ x, y, w, h, fill }),
    }),
  };
  return canvas;
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('invite QR');

const link = 'https://photos.example.com/?p=sunflower';

test('print size: about 1000px, made of whole-pixel square modules', () => {
  const c = drawQr(recordingCanvas(), link, 1000);
  assert.equal(c.width, c.height);
  assert.ok(c.width > 900 && c.width <= 1000, `width ${c.width}`);
  const dark = c.rects.filter(r => r.fill === '#000000');
  const cell = dark[0].w;
  assert.ok(Number.isInteger(cell) && cell >= 10, 'modules are whole pixels, large enough to print');
  assert.ok(dark.every(r => r.w === cell && r.h === cell && r.x % cell === 0 && r.y % cell === 0));
});

test('white background first, then black modules only', () => {
  const c = drawQr(recordingCanvas(), link, 1000);
  assert.deepEqual(c.rects[0], { x: 0, y: 0, w: c.width, h: c.height, fill: '#ffffff' });
  assert.ok(c.rects.slice(1).every(r => r.fill === '#000000'));
});

test('a 4-module white quiet zone on every side', () => {
  const c = drawQr(recordingCanvas(), link, 1000);
  const dark = c.rects.filter(r => r.fill === '#000000');
  const cell = dark[0].w;
  const min = Math.min(...dark.map(r => Math.min(r.x, r.y)));
  const max = Math.max(...dark.map(r => Math.max(r.x, r.y) + cell));
  assert.equal(min, 4 * cell);
  assert.equal(c.width - max, 4 * cell);
});

test('uses error correction Q, so a smudged print still scans', () => {
  assert.match(constLine('QR_ERROR_CORRECTION'), /'Q'/);
});

test('the longest link the app can make still fits', () => {
  // Passphrases top out at 40 characters; allow a long custom domain too.
  const longest = 'https://photos.a-very-long-wedding-domain-for-testing.com/?p=' + 'a'.repeat(40);
  const c = drawQr(recordingCanvas(), longest, 1000);
  assert.ok(c.width > 900);
});

console.log(`\n${passed} passed`);
