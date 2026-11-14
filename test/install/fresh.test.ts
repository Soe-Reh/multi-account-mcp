// Fresh-machine check against the built CLI (scripts/stranger-test.sh runs the same check on the packed, installed package).
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

it('built CLI: --version, install claude-desktop + cursor, serve 6 tools, add page, empty list', () => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', root], { stdio: 'inherit' });
  const out = execFileSync(process.execPath, [join(root, 'scripts/stranger-check.mjs'), process.execPath, join(root, 'dist/cli/index.js')], { encoding: 'utf8' });
  expect(out).toMatch(/serve: initialize \+ tools\/list = 6 tools/);
  expect(out).toMatch(/stranger check passed/);
}, 120_000);
