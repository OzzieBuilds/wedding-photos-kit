// Runs every test/*.test.mjs file in its own Node process, stopping at the
// first failure. Each test file is a plain script that throws on failure.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort();

for (const file of files) {
  const { status } = spawnSync(process.execPath, [dir + file], { stdio: 'inherit' });
  if (status !== 0) {
    console.error(`\n✗ ${file} failed`);
    process.exit(status ?? 1);
  }
}
console.log(`\nAll ${files.length} test files passed`);
