#!/usr/bin/env node
// Sets up the photo site in your own Cloudflare account, or redeploys it.
//
//   npm install
//   npm run setup
//
// What it does, in order:
//   1. Signs you in to Cloudflare (opens your browser the first time).
//   2. Asks for the admin password you'll use to manage the site.
//   3. Deploys. On the first run Cloudflare creates the photo storage (R2),
//      database (D1), rate-limit store (KV) and queue, and writes their IDs
//      into wrangler.toml. Keep that file: later runs reuse what it names.
//   4. Sets your admin password on the new site, and prints its address.
//
// Safe to run again: it redeploys the same site, keeps every photo and
// setting, and never changes an admin password that's already set.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wranglerBin = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const ADMIN_PASSWORD_MIN = 10;

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const step = (n, s) => console.log(`\n${bold(`[${n}/4]`)} ${s}`);

function fail(message, hints = []) {
  console.error(`\n${red('✗')} ${message}`);
  for (const hint of hints) console.error(`  • ${hint}`);
  process.exit(1);
}

/**
 * Runs Wrangler. With `capture`, its output is shown live and also returned,
 * so the site's address can be read from it.
 */
function wrangler(args, { capture = false, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [wranglerBin, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    });
    let output = '';
    if (capture) {
      child.stdout.on('data', (d) => { output += d; process.stdout.write(d); });
      child.stderr.on('data', (d) => { output += d; process.stderr.write(d); });
    }
    child.on('close', (code) => resolve({ code, output }));
  });
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Print the question, then echo nothing while the password is typed.
      rl._writeToOutput = (s) => { if (!rl.muted) rl.output.write(s); };
    }
    rl.question(question, (answer) => {
      if (hidden) process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    rl.muted = hidden;
  });
}

async function askAdminPassword() {
  for (;;) {
    const first = (await ask(`  Admin password (at least ${ADMIN_PASSWORD_MIN} characters): `, { hidden: true })).trim();
    if (first.length < ADMIN_PASSWORD_MIN) {
      console.log(red(`  Too short: use at least ${ADMIN_PASSWORD_MIN} characters.`));
      continue;
    }
    const second = (await ask('  Type it again: ', { hidden: true })).trim();
    if (first !== second) {
      console.log(red("  They don't match. Try again."));
      continue;
    }
    return first;
  }
}

/** Claims the new site's admin password. Retries while a new workers.dev address comes online. */
async function setAdminPassword(siteUrl, password) {
  const deadline = Date.now() + 90_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${siteUrl}/admin/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) return 'set';
      if (res.status === 409) return 'already-set';
      const data = await res.json().catch(() => ({}));
      if (res.status === 400 || res.status === 429) return `error: ${data.error || res.status}`;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.cause?.code || err.message;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return `error: the site didn't answer (${lastError})`;
}

// ─── 0. Prerequisites ─────────────────────────────────────────────────────────

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) fail(`Node.js 20 or newer is needed (you have ${process.versions.node}).`, ['Get it from https://nodejs.org']);
if (!existsSync(wranglerBin)) fail('Wrangler is not installed yet.', ['Run `npm install` in this folder first, then `npm run setup` again.']);
if (!process.stdin.isTTY) fail('Run this in a terminal window, so it can ask you questions.');

console.log(bold('\nWedding photos: setup\n'));

// ─── 1. Sign in ───────────────────────────────────────────────────────────────

step(1, 'Signing in to Cloudflare');
const whoami = async () => {
  const { code, output } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [wranglerBin, 'whoami', '--json'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (c) => resolve({ code: c, output: out }));
  });
  if (code !== 0) return null;
  try { return JSON.parse(output); } catch { return null; }
};
let who = await whoami();
if (!who) {
  console.log('  A browser window will open. Sign in (or create a free account) and click Allow.');
  const { code } = await wrangler(['login']);
  if (code !== 0) fail('Signing in to Cloudflare did not finish.', ['Run `npm run setup` again to retry.']);
  who = await whoami();
  if (!who) fail('Still not signed in to Cloudflare.', ['Run `npx wrangler login` and then `npm run setup` again.']);
}
console.log(green(`  Signed in${who.email ? ` as ${who.email}` : ''}.`));

// Several accounts: Wrangler needs to be told which one.
const accounts = Array.isArray(who.accounts) ? who.accounts : [];
let accountEnv = {};
if (!process.env.CLOUDFLARE_ACCOUNT_ID && accounts.length > 1) {
  console.log('\n  You have more than one Cloudflare account. Which one should the site live in?');
  accounts.forEach((a, i) => console.log(`    ${i + 1}. ${a.name} (${a.id})`));
  for (;;) {
    const n = Number(await ask(`  Enter 1–${accounts.length}: `));
    if (Number.isInteger(n) && n >= 1 && n <= accounts.length) {
      accountEnv = { CLOUDFLARE_ACCOUNT_ID: accounts[n - 1].id };
      break;
    }
  }
}

// ─── 2. Admin password ────────────────────────────────────────────────────────

step(2, 'Choose your admin password');
console.log('  You\'ll use it to manage photos and settings at /admin. Guests never need it.');
console.log('  (If the site already has one, it stays as it is and this is ignored.)');
const adminPassword = await askAdminPassword();

// ─── 3. Deploy ────────────────────────────────────────────────────────────────

step(3, 'Deploying (the first time, this also creates your storage and database)');
// CI=true makes Wrangler create anything missing with its default names rather
// than stopping to ask about each one.
const deploy = await wrangler(['deploy'], { capture: true, env: { CI: 'true', ...accountEnv } });
if (deploy.code !== 0) {
  const out = deploy.output;
  const hints = [];
  if (/R2/i.test(out) && /enable|10042|purchase|subscri/i.test(out)) {
    hints.push('R2 (photo storage) is not switched on for your account yet. In the Cloudflare dashboard open R2 Object Storage, follow the steps to enable it (it asks for a card, but the free allowance is 10 GB), then run `npm run setup` again.');
  }
  if (/workers\.dev/i.test(out) && /subdomain/i.test(out)) {
    hints.push('Your account has no workers.dev address yet. In the Cloudflare dashboard open Workers & Pages once and pick a subdomain, then run `npm run setup` again.');
  }
  if (/more than one account/i.test(out)) {
    hints.push('Set CLOUDFLARE_ACCOUNT_ID to the account you want, then run `npm run setup` again.');
  }
  if (hints.length === 0) hints.push('Read the error above. Fix what it says, then run `npm run setup` again; nothing is lost by retrying.');
  fail('The deploy did not finish.', hints);
}

const siteUrl = (deploy.output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) || [])[0];

// ─── 4. Admin password on the site ────────────────────────────────────────────

step(4, 'Finishing setup');
if (!siteUrl) {
  console.log('  Deployed, but no workers.dev address was printed (perhaps workers_dev is off).');
  console.log('  Open your site\'s /admin page in a browser straight away to create the admin password.');
  process.exit(0);
}
const result = await setAdminPassword(siteUrl, adminPassword);
if (result === 'set') console.log(green('  Admin password set.'));
else if (result === 'already-set') console.log('  This site already had an admin password, so it was left as it is.');
else {
  console.log(red(`  Couldn't set the admin password (${result.replace(/^error: /, '')}).`));
  console.log(`  Open ${siteUrl}/admin in a browser straight away and create it there.`);
}

console.log(`
${green('✓ Your site is live.')}

  Guests:  ${bold(siteUrl)}
  Admin:   ${bold(`${siteUrl}/admin`)}

Next, in admin → ⋯ → Settings:
  1. Wedding setup: enter both your names, then pick a theme and up to four locations.
  2. Guest access: set the passphrase guests will use, then download the QR code for your invites.
  3. Site mode: Live lets guests in; Pre-wedding shows a "coming soon" page.

Keep wrangler.toml: it now names your storage and database, and future runs
of \`npm run setup\` reuse them.
`);
