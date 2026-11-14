// How this installation was launched: the printed command and the node binary written into configs.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { detectSelf, invocation, SCRIPT } from '../../src/cli/self.js';

let dir: string, script: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mam-self-'));
  script = join(dir, 'pkg', 'dist', 'cli', 'index.js');
  await mkdir(join(dir, 'pkg', 'dist', 'cli'), { recursive: true });
  await writeFile(script, '');
  await mkdir(join(dir, 'bin'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

it('SCRIPT is this checkout dist/cli/index.js', () => {
  expect(SCRIPT).toMatch(/[\\/]dist[\\/]cli[\\/]index\.js$/);
});

it('not on PATH and not npx: node <absolute path>', () => {
  const s = detectSelf({ PATH: join(dir, 'bin') }, script, process.execPath);
  expect(s).toMatchObject({ npx: false, onPath: false, node: process.execPath });
  expect(invocation(s)).toBe(`node ${script}`);
  expect(invocation({ ...s, script: '/a b/index.js' })).toBe('node "/a b/index.js"');
});

it('on PATH as this install: the bare name; another install of the same name does not count', async () => {
  await symlink(script, join(dir, 'bin', 'multi-account-mcp'));
  expect(invocation(detectSelf({ PATH: join(dir, 'bin') }, script))).toBe('multi-account-mcp');
  const other = join(dir, 'other.js');
  await writeFile(other, '');
  expect(invocation(detectSelf({ PATH: join(dir, 'bin') }, other))).toBe(`node ${other}`);
});

it('under npx (~/.npm/_npx/...): npx -y multi-account-mcp, even though npx puts the bin on PATH', async () => {
  const npxScript = join(dir, '_npx', 'abc', 'node_modules', 'multi-account-mcp', 'dist', 'cli', 'index.js');
  await mkdir(join(npxScript, '..'), { recursive: true });
  await writeFile(npxScript, '');
  const bin = join(dir, '_npx', 'abc', 'node_modules', '.bin');
  await mkdir(bin);
  await symlink(npxScript, join(bin, 'multi-account-mcp'));
  const s = detectSelf({ PATH: bin }, npxScript);
  expect(s).toMatchObject({ npx: true, onPath: false });
  expect(invocation(s)).toBe('npx -y multi-account-mcp');
});

it('node: prefers the PATH entry when it is the same binary as process.execPath (stable, not a versioned path)', async () => {
  await symlink(process.execPath, join(dir, 'bin', 'node'));
  expect(detectSelf({ PATH: [join(dir, 'empty'), join(dir, 'bin')].join(delimiter) }, script, process.execPath).node).toBe(join(dir, 'bin', 'node'));
  const fake = join(dir, 'fake-node');
  await writeFile(fake, '');
  expect(detectSelf({ PATH: join(dir, 'bin') }, script, fake).node).toBe(fake); // a different node on PATH is not used
});
