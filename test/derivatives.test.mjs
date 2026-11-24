// Extracts the queue consumer from src/worker.js and drives it against a stubbed
// generateVariant, to prove a failed transform is retried rather than acked.
//
// The original bug: the consumer ignored generateVariant's return value and
// acked unconditionally, so max_retries never engaged and a transient failure
// left the derivative permanently unbuilt.
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

// Pull the queue consumer out of the default export object. It is a method, so
// it starts at `async queue(` rather than a function declaration.
function grabMethod(name) {
  const start = source.indexOf(`async ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  let depth = 0;
  for (let j = source.indexOf('{', start); j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) {
      return source.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced ${name}`);
}

// The real delay schedule, so the backoff assertions track the shipped values
// rather than a copy that can drift.
function grabFunction(name) {
  let start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  // Keep the async modifier, or the copy loses it and every await inside
  // becomes a syntax error.
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let j = source.indexOf('{', start); j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) return source.slice(start, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function grabConst(name) {
  const m = source.match(new RegExp(`^const ${name} = .*?;$`, 'm'));
  if (!m) throw new Error(`missing const ${name}`);
  return m[0];
}

const retryDelaySeconds = new Function(
  `${grabConst('RETRY_BASE_DELAY_SECONDS')}
   ${grabConst('RETRY_MAX_DELAY_SECONDS')}
   ${grabFunction('retryDelaySeconds')}
   return retryDelaySeconds;`
)();

// Build a callable copy of the consumer with its module-scope dependencies
// supplied by the test, so the assertions run against the shipped source.
function buildConsumer(generateVariant, VARIANTS, variantExists = async () => false) {
  const factory = new Function(
    'generateVariant', 'VARIANTS', 'console', 'variantExists', 'retryDelaySeconds',
    `const obj = { ${grabMethod('queue')} }; return obj.queue;`
  );
  return factory(generateVariant, VARIANTS, { error() {} }, variantExists, retryDelaySeconds);
}

const VARIANTS = { grid: {}, display: {} };

function message(fileKey, attempts = 1, variant = undefined) {
  return {
    body: variant ? { fileKey, variant } : { fileKey },
    attempts,
    acked: false,
    retried: false,
    delay: null,
    ack() { this.acked = true; },
    retry(opts) { this.retried = true; this.delay = opts?.delaySeconds ?? null; },
  };
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

console.log('queue consumer:');

// Both variants build cleanly — nothing to retry.
{
  const consumer = buildConsumer(async () => ({ ok: true }), VARIANTS);
  const m = message('photos/1-abc.jpeg');
  await consumer({ messages: [m] }, {});
  check('acks when every variant builds', m.acked && !m.retried);
}

// The reported failure: grid succeeded, display threw. Acking here is what
// stranded 11 of 25 photos without a display derivative.
{
  const consumer = buildConsumer(
    async (env, key, variant) =>
      variant === 'display' ? { ok: false, retryable: true } : { ok: true },
    VARIANTS
  );
  const m = message('photos/2-def.jpeg');
  await consumer({ messages: [m] }, {});
  check('retries when one variant fails transiently', m.retried && !m.acked);
}

// Over the 20MB cap or an undecodable format. Retrying cannot change the
// outcome, and /v/ serves the original instead, so this must not spin.
{
  const consumer = buildConsumer(
    async () => ({ ok: false, retryable: false }),
    VARIANTS
  );
  const m = message('photos/3-ghi.heic');
  await consumer({ messages: [m] }, {});
  check('acks an untransformable source instead of retrying', m.acked && !m.retried);
}

// A mix: unsupported alone acks, but a retryable failure alongside it wins.
{
  const consumer = buildConsumer(
    async (env, key, variant) =>
      variant === 'grid' ? { ok: false, retryable: false } : { ok: false, retryable: true },
    VARIANTS
  );
  const m = message('photos/4-jkl.jpeg');
  await consumer({ messages: [m] }, {});
  check('a retryable failure outweighs an unsupported one', m.retried && !m.acked);
}

// An exception escaping generateVariant entirely still has to retry.
{
  const consumer = buildConsumer(async () => { throw new Error('boom'); }, VARIANTS);
  const m = message('photos/5-mno.jpeg');
  await consumer({ messages: [m] }, {});
  check('retries when the job throws', m.retried && !m.acked);
}

// Each message is settled on its own; one bad photo must not strand the batch.
{
  const consumer = buildConsumer(
    async (env, key) => key.includes('bad') ? { ok: false, retryable: true } : { ok: true },
    VARIANTS
  );
  const good = message('photos/6-good.jpeg');
  const bad = message('photos/7-bad.jpeg');
  await consumer({ messages: [good, bad] }, {});
  check('settles each message independently', good.acked && bad.retried);
}

console.log('\nvariant isolation:');

// Both transforms in one invocation exceeded the CPU limit, killing the second
// every time. A variant-scoped message must do exactly one transform.
{
  const built = [];
  const consumer = buildConsumer(
    async (env, key, variant) => { built.push(variant); return { ok: true }; },
    VARIANTS
  );
  const m = message('photos/13-def.jpeg', 1, 'display');
  await consumer({ messages: [m] }, {});
  check('a variant-scoped message transforms only that variant', built.length === 1 && built[0] === 'display', built);
  check('and acks on success', m.acked && !m.retried);
}

// A failure is scoped to its own message, so the sibling variant is unaffected.
{
  const consumer = buildConsumer(async () => ({ ok: false, retryable: true }), VARIANTS);
  const grid = message('photos/14-ghi.jpeg', 1, 'grid');
  const display = message('photos/14-ghi.jpeg', 1, 'display');
  const ok = buildConsumer(async () => ({ ok: true }), VARIANTS);
  await consumer({ messages: [display] }, {});
  await ok({ messages: [grid] }, {});
  check('one variant failing leaves the other settled', grid.acked && display.retried);
}

// Messages enqueued before the split carry no variant and still mean the set.
{
  const built = [];
  const consumer = buildConsumer(
    async (env, key, variant) => { built.push(variant); return { ok: true }; },
    VARIANTS
  );
  await consumer({ messages: [message('photos/15-jkl.jpeg')] }, {});
  check('a legacy message still covers every variant', built.length === 2, built);
}

console.log('\nretry economy:');

// The reason a naive retry never rescued anything: grid succeeds, display
// fails, and the retry rebuilds grid first — spending the budget that starved
// display — then fails display again in the same order.
{
  const built = [];
  const consumer = buildConsumer(
    async (env, key, variant) => {
      built.push(variant);
      return variant === 'display' ? { ok: false, retryable: true } : { ok: true };
    },
    VARIANTS,
    async (env, key, variant) => variant === 'grid'   // grid landed last time
  );
  const m = message('photos/8-pqr.jpeg', 2);
  await consumer({ messages: [m] }, {});
  check('a retry skips the variant that already landed', !built.includes('grid'), built);
  check('and still attempts the one that failed', built.includes('display'), built);
}

// First attempt must not pay for the existence check — nothing is built yet,
// so it would be two wasted operations per photo.
{
  let checked = 0;
  const consumer = buildConsumer(
    async () => ({ ok: true }),
    VARIANTS,
    async () => { checked++; return false; }
  );
  await consumer({ messages: [message('photos/9-stu.jpeg', 1)] }, {});
  check('the first attempt skips the existence lookup', checked === 0, checked);
}

// A message whose variants all landed on an earlier attempt is simply done.
{
  const consumer = buildConsumer(
    async () => { throw new Error('should not transform'); },
    VARIANTS,
    async () => true
  );
  const m = message('photos/10-vwx.jpeg', 3);
  await consumer({ messages: [m] }, {});
  check('acks when a retry finds everything already built', m.acked && !m.retried);
}

// Retries have to outlast the burst that caused them, so the delay grows.
{
  const consumer = buildConsumer(async () => ({ ok: false, retryable: true }), VARIANTS);
  const delays = [];
  for (const attempt of [1, 2, 3]) {
    const m = message('photos/11-yz.jpeg', attempt);
    await consumer({ messages: [m] }, {});
    delays.push(m.delay);
  }
  check('retry delay grows with each attempt', delays[0] < delays[1] && delays[1] < delays[2], delays);
  check('and the first retry outlasts a burst', delays[0] >= 30, delays[0]);
}

// A throwing job still has to back off, not hammer the same window.
{
  const consumer = buildConsumer(async () => { throw new Error('boom'); }, VARIANTS);
  const m = message('photos/12-abc.jpeg', 2);
  await consumer({ messages: [m] }, {});
  check('a thrown job backs off too', m.retried && m.delay >= 30, m.delay);
}

console.log('\nrebuild batch:');

// rebuildBatch closes over the module-scope generateVariant, so it has to be
// rebuilt with the stub in scope rather than handed one as an argument.
function buildRebuildBatch(generateVariant) {
  return new Function('generateVariant',
    `${grabFunction('rebuildBatch')} return rebuildBatch;`)(generateVariant);
}

function entries(n, prefix = 'p') {
  return Array.from({ length: n }, (_, i) => ({ file_key: `photos/${prefix}${i}.jpeg`, variant: 'display' }));
}

// The transform budget is what the limit protects, so only real attempts count.
{
  const rebuildBatch = buildRebuildBatch(async () => ({ ok: true }));
  const res = await rebuildBatch({}, entries(20), 6, 40);
  check('stops at the transform limit', res.rebuilt.length === 6, res.rebuilt.length);
}

// Unsupported sources cost an R2 get and no transform. If they consumed the
// budget, a few oversized photos at the head would starve every real gap.
{
  const rebuildBatch = buildRebuildBatch(
    async (env, key) => key.includes('big') ? { ok: false, retryable: false } : { ok: true });
  const res = await rebuildBatch({}, [...entries(4, 'big'), ...entries(6, 'ok')], 6, 40);
  check('unsupported sources do not consume the limit', res.rebuilt.length === 6, res.rebuilt.length);
  check('and are reported separately', res.unsupported.length === 4, res.unsupported.length);
}

// But the walk still has to terminate when everything is unsupported.
{
  const rebuildBatch = buildRebuildBatch(async () => ({ ok: false, retryable: false }));
  const res = await rebuildBatch({}, entries(500), 6, 40);
  check('maxExamined bounds a list of nothing but unsupported', res.unsupported.length === 40, res.unsupported.length);
}

// A retryable failure is a real attempt — it reached the binding and cost one.
{
  const rebuildBatch = buildRebuildBatch(async () => ({ ok: false, retryable: true }));
  const res = await rebuildBatch({}, entries(20), 6, 40);
  check('failed transforms count against the limit', res.failed.length === 6, res.failed.length);
}

console.log('\nscheduled sweep:');

const buildScheduled = (deps) => new Function('deps', `
  const getSweepEnabled = deps.getSweepEnabled;
  const findMissingDerivatives = deps.findMissingDerivatives;
  const rebuildBatch = deps.rebuildBatch;
  const SWEEP_LIMIT = 6;
  const SWEEP_MAX_EXAMINED = 40;
  const console = { log() {}, error() {} };
  const obj = { ${grabMethod('scheduled')} };
  return obj.scheduled;
`)(deps);

// The cron fires on Cloudflare's schedule whether or not it is wanted, so the
// flag is the only thing standing between "off" and a sweep every 15 minutes.
{
  let audited = false;
  const scheduled = buildScheduled({
    getSweepEnabled: async () => false,
    findMissingDerivatives: async () => { audited = true; return { missing: [] }; },
    rebuildBatch: async () => ({ rebuilt: [], unsupported: [], failed: [] }),
  });
  await scheduled({}, {}, {});
  check('does nothing at all while disabled', audited === false);
}

{
  let rebuilt = 0;
  const scheduled = buildScheduled({
    getSweepEnabled: async () => true,
    findMissingDerivatives: async () => ({ missing: entries(3) }),
    rebuildBatch: async (env, list) => { rebuilt = list.length; return { rebuilt: list, unsupported: [], failed: [] }; },
  });
  await scheduled({}, {}, {});
  check('rebuilds what is missing while enabled', rebuilt === 3, rebuilt);
}

// Nothing missing is the steady state once uploads stop — it must not transform.
{
  let called = false;
  const scheduled = buildScheduled({
    getSweepEnabled: async () => true,
    findMissingDerivatives: async () => ({ missing: [] }),
    rebuildBatch: async () => { called = true; return { rebuilt: [], unsupported: [], failed: [] }; },
  });
  await scheduled({}, {}, {});
  check('skips the rebuild when nothing is missing', called === false);
}

// A sweep that throws must not become an unhandled rejection in a cron run.
{
  const scheduled = buildScheduled({
    getSweepEnabled: async () => true,
    findMissingDerivatives: async () => { throw new Error('d1 down'); },
    rebuildBatch: async () => ({ rebuilt: [], unsupported: [], failed: [] }),
  });
  let threw = false;
  try { await scheduled({}, {}, {}); } catch { threw = true; }
  check('swallows its own errors', threw === false);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
