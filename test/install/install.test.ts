// `install <client>`: entry form, merge, one backup, refusals, idempotent, uninstall, --print, secrets-file, claude CLI, per-OS paths.
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { configFile, install, type InstallDeps } from '../../src/cli/install.js';
import type { Self } from '../../src/cli/self.js';

let dir: string, pkg: string, out: string, err: string, self: Self;
const NPX = { command: 'npx', args: ['-y', 'multi-account-mcp', 'serve'] };
const NODE = '/usr/local/bin/node';
const local = () => ({ command: NODE, args: [self.script, 'serve'] });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mam-install-'));
  pkg = await mkdtemp(join(tmpdir(), 'mam pkg ')); // a space in the path on purpose
  await mkdir(join(pkg, 'dist', 'cli'), { recursive: true });
  await writeFile(join(pkg, 'dist', 'cli', 'index.js'), '');
  self = { script: join(pkg, 'dist', 'cli', 'index.js'), node: NODE, npx: false, onPath: false };
  out = err = '';
});
afterEach(async () => {
  await chmod(dir, 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true });
  await rm(pkg, { recursive: true, force: true });
});

const deps = (extra: Partial<InstallDeps> = {}): InstallDeps => ({
  env: { MULTI_ACCOUNT_MCP_CLIENT_CONFIG_DIR: dir, MULTI_ACCOUNT_MCP_HOME: join(dir, 'no-store') }, home: '/nonexistent-home', self,
  out: (s) => { out += s; }, err: (s) => { err += s; },
  claude: () => { throw new Error('must not call the claude CLI in tests'); }, ...extra,
});
const run = (...argv: string[]) => install(argv, deps());
const json = async (f: string) => JSON.parse(await readFile(join(dir, f), 'utf8'));
const backups = async () => (await readdir(dir)).filter((f) => f.includes('.bak'));

it('not run via npx: writes node + this installation, and next steps use a command that works', async () => {
  expect(await run('claude-desktop')).toBe(0);
  expect(await json('claude_desktop_config.json')).toEqual({ mcpServers: { 'multi-account-mcp': local() } });
  expect(await backups()).toEqual([]);
  expect(out).toMatch(/Installed multi-account-mcp in claude-desktop/);
  expect(out).toContain(`1. Restart Claude Desktop`);
  expect(out).toContain(`2. Add your email accounts: node ${JSON.stringify(self.script)} add`);
});

it('run via npx: writes the npx entry; --npx forces it; --local forces the path form', async () => {
  self.npx = true;
  expect(await run('cursor')).toBe(0);
  expect((await json('mcp.json')).mcpServers['multi-account-mcp']).toEqual({ type: 'stdio', ...NPX });
  expect(out).toContain('Add your email accounts: npx -y multi-account-mcp add');
  expect(await run('cursor', '--local')).toBe(0);
  expect((await json('mcp.json')).mcpServers['multi-account-mcp']).toEqual({ type: 'stdio', ...local() });
  self.npx = false;
  out = '';
  expect(await run('cursor', '--npx')).toBe(0);
  expect((await json('mcp.json')).mcpServers['multi-account-mcp']).toEqual({ type: 'stdio', ...NPX });
  expect(out).toMatch(/Updated/);
  self.onPath = true; out = '';
  await run('cursor', '--uninstall'); await run('cursor');
  expect(out).toContain('Add your email accounts: multi-account-mcp add');
  expect(await run('cursor', '--npx', '--local')).toBe(1);
});

it('a missing build is reported for the path form', async () => {
  await rm(self.script);
  expect(await run('cursor')).toBe(1);
  expect(err).toMatch(/does not exist. Run `npm run build`/);
});

it('existing file: keeps other servers and keys, keeps exactly one backup and says where', async () => {
  const before = { theme: 'dark', mcpServers: { other: { command: 'other-mcp', args: ['x'] } } };
  await writeFile(join(dir, 'mcp.json'), JSON.stringify(before));
  expect(await run('cursor')).toBe(0);
  expect(await json('mcp.json')).toEqual({ theme: 'dark', mcpServers: { other: before.mcpServers.other, 'multi-account-mcp': { type: 'stdio', ...local() } } });
  expect(await backups()).toEqual(['mcp.json.bak']);
  expect(await json('mcp.json.bak')).toEqual(before);
  expect(out).toContain(`Backup of the old file: ${join(dir, 'mcp.json.bak')}`);
  expect(await run('cursor', '--npx')).toBe(0); // a second change replaces the backup
  expect(await backups()).toEqual(['mcp.json.bak']);
  expect((await json('mcp.json.bak')).mcpServers['multi-account-mcp'].command).toBe(NODE);
});

it('invalid JSON, a non-object and a wrong-shaped mcpServers are refused and the file is left alone', async () => {
  await writeFile(join(dir, 'mcp.json'), '{ "mcpServers": { oops');
  expect(await run('cursor')).toBe(1);
  expect(err).toMatch(/not valid JSON, so it was not changed/);
  expect(await readFile(join(dir, 'mcp.json'), 'utf8')).toBe('{ "mcpServers": { oops');
  err = '';
  await writeFile(join(dir, 'mcp.json'), '{"mcpServers": []}');
  expect(await run('cursor')).toBe(1);
  expect(err).toMatch(/"mcpServers" is not an object/);
  expect(err).not.toMatch(/not valid JSON/);
  err = '';
  await writeFile(join(dir, 'mcp.json'), '[1]');
  expect(await run('cursor')).toBe(1);
  expect(err).toMatch(/does not hold a JSON object/);
  expect(await backups()).toEqual([]);
});

it('a UTF-8 byte order mark is accepted', async () => {
  await writeFile(join(dir, 'mcp.json'), '﻿{"mcpServers":{"other":{"command":"o"}}}');
  expect(await run('cursor')).toBe(0);
  expect(Object.keys((await json('mcp.json')).mcpServers)).toEqual(['other', 'multi-account-mcp']);
});

it('a symlinked config is written through to the real file; the link stays', async () => {
  const real = join(dir, 'real.json');
  await writeFile(real, '{"mcpServers":{}}');
  await symlink(real, join(dir, 'mcp.json'));
  expect(await run('cursor')).toBe(0);
  expect(await readlink(join(dir, 'mcp.json'))).toBe(real);
  expect(JSON.parse(await readFile(real, 'utf8')).mcpServers['multi-account-mcp'].command).toBe(NODE);
  expect(out).toContain(`(${await realpath(real)})`);
});

it('a read-only config file is refused with a plain message and nothing changes', async () => {
  const f = join(dir, 'mcp.json');
  await writeFile(f, '{"mcpServers":{}}');
  await chmod(f, 0o444);
  expect(await run('cursor')).toBe(1);
  expect(err).toMatch(/is read-only, so it was not changed/);
  expect(await readFile(f, 'utf8')).toBe('{"mcpServers":{}}');
  expect(await backups()).toEqual([]);
});

it('a read-only folder gives a plain message, no stack trace, nothing left behind', async () => {
  await chmod(dir, 0o555);
  let code: number | undefined, thrown: unknown;
  try { code = await run('cursor'); } catch (e) { thrown = e; }
  expect(thrown).toBeUndefined();
  expect(code).toBe(1);
  expect(err).toMatch(/Could not write .*mcp\.json \(permission denied\)\. .*The config was not changed\.\n$/);
  expect(err).not.toMatch(/\n\s+at /);
  await chmod(dir, 0o755);
  expect(await readdir(dir)).toEqual([]);
});

it('second run says already installed and changes nothing', async () => {
  expect(await run('claude-code')).toBe(0);
  const first = await readFile(join(dir, '.claude.json'), 'utf8');
  out = '';
  expect(await run('claude-code')).toBe(0);
  expect(out).toMatch(/already installed/);
  expect(await readFile(join(dir, '.claude.json'), 'utf8')).toBe(first);
  expect(await backups()).toEqual([]);
});

it('--uninstall removes only our entry; again says not installed', async () => {
  await writeFile(join(dir, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'o' } } }));
  expect(await run('claude-code')).toBe(0);
  expect(await run('claude-code', '--uninstall')).toBe(0);
  expect(await json('.claude.json')).toEqual({ numStartups: 3, mcpServers: { other: { command: 'o' } } });
  expect(await backups()).toEqual(['.claude.json.bak']);
  out = '';
  expect(await run('claude-code', '--uninstall')).toBe(0);
  expect(out).toMatch(/not installed.*Nothing changed/);
});

it('--print writes nothing and prints each client format', async () => {
  for (const c of ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'gemini-cli', 'codex']) {
    out = '';
    expect(await run(c, '--print')).toBe(0);
    expect(out).toMatch(/multi-account-mcp|index\.js/);
  }
  expect(await readdir(dir)).toEqual([]);
  out = ''; await run('vscode', '--print', '--npx');
  expect(JSON.parse(out)).toEqual({ servers: { 'multi-account-mcp': { type: 'stdio', ...NPX } } });
  out = ''; await run('codex', '--print', '--npx');
  expect(out).toBe('[mcp_servers.multi-account-mcp]\ncommand = "npx"\nargs = ["-y","multi-account-mcp","serve"]\n');
  out = ''; await run('claude-code', '--print', '--npx');
  expect(out).toBe('claude mcp add --scope user multi-account-mcp -- npx -y multi-account-mcp serve\n');
  out = ''; await run('claude-code', '--print');
  expect(out).toBe(`claude mcp add --scope user multi-account-mcp -- ${NODE} ${JSON.stringify(self.script)} serve\n`);
  out = ''; await run('gemini-cli', '--print', '--npx');
  expect(JSON.parse(out)).toEqual({ mcpServers: { 'multi-account-mcp': NPX } });
  expect(await run('codex')).toBe(1); // print-only clients refuse to write
  expect(err).toContain(`Run: node ${JSON.stringify(self.script)} install codex --print`);
});

it('--secrets-file puts MULTI_ACCOUNT_MCP_SECRETS=file in the entry (and in --print)', async () => {
  expect(await run('claude-desktop', '--secrets-file')).toBe(0);
  expect((await json('claude_desktop_config.json')).mcpServers['multi-account-mcp']).toEqual({ ...local(), env: { MULTI_ACCOUNT_MCP_SECRETS: 'file' } });
  out = '';
  expect(await run('claude-desktop')).toBe(0); // without the flag the entry changes back
  expect(out).toMatch(/Updated/);
  out = ''; await run('codex', '--print', '--npx', '--secrets-file');
  expect(out).toContain('env = { MULTI_ACCOUNT_MCP_SECRETS = "file" }');
  out = ''; await run('claude-code', '--print', '--npx', '--secrets-file');
  expect(out).toBe('claude mcp add --scope user multi-account-mcp -e MULTI_ACCOUNT_MCP_SECRETS=file -- npx -y multi-account-mcp serve\n');
});

it('an account store recorded as file-backed turns --secrets-file on by itself and says so', async () => {
  const store = join(dir, 'store');
  await mkdir(store);
  await writeFile(join(store, 'accounts.json'), JSON.stringify({ version: 2, backend: 'file', accounts: [], pendingDeletes: [] }));
  const code = await install(['cursor'], deps({ env: { MULTI_ACCOUNT_MCP_CLIENT_CONFIG_DIR: dir, MULTI_ACCOUNT_MCP_HOME: store } }));
  expect(code).toBe(0);
  expect((await json('mcp.json')).mcpServers['multi-account-mcp'].env).toEqual({ MULTI_ACCOUNT_MCP_SECRETS: 'file' });
  expect(err).toMatch(/saved in a file.*MULTI_ACCOUNT_MCP_SECRETS=file/);
});

it('unknown client or option prints usage and fails', async () => {
  expect(await run('chatgpt')).toBe(1);
  expect(err).toMatch(/Unknown client "chatgpt"[\s\S]*Usage/);
  expect(await run('cursor', '--frob')).toBe(1);
  expect(await readdir(dir)).toEqual([]);
});

it('config paths per OS, and CLAUDE_CONFIG_DIR for claude-code', () => {
  const env = {};
  expect(configFile('claude-desktop', 'darwin', '/Users/a', env)).toBe('/Users/a/Library/Application Support/Claude/claude_desktop_config.json');
  expect(configFile('claude-desktop', 'linux', '/home/a', env)).toBe('/home/a/.config/Claude/claude_desktop_config.json');
  expect(configFile('claude-desktop', 'win32', '/h', { APPDATA: '/h/AppData/Roaming' })).toBe(join('/h/AppData/Roaming', 'Claude', 'claude_desktop_config.json'));
  expect(configFile('claude-desktop', 'win32', '/h', env)).toBe(join('/h', 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  for (const p of ['darwin', 'linux', 'win32'] as const) {
    expect(configFile('cursor', p, '/h', env)).toBe(join('/h', '.cursor', 'mcp.json'));
    expect(configFile('claude-code', p, '/h', env)).toBe(join('/h', '.claude.json'));
  }
  expect(configFile('claude-code', 'darwin', '/h', { CLAUDE_CONFIG_DIR: '/c' })).toBe(join('/c', '.claude.json'));
  expect(configFile('cursor', 'darwin', '/h', { MULTI_ACCOUNT_MCP_CLIENT_CONFIG_DIR: '/t' })).toBe(join('/t', 'mcp.json'));
});

/** A stand-in for `claude mcp get/add/remove` with the output format of Claude Code 2.1. */
function fakeClaude() {
  let server: { command: string; args: string[]; env: string[] } | undefined;
  const calls: string[][] = [];
  const claude = (a: string[]) => {
    calls.push(a);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (a[0] === '--version') return ok('2.1.0 (Claude Code)\n');
    if (a[1] === 'get') {
      if (!server) return { status: 1, stdout: '', stderr: 'No MCP server named "multi-account-mcp".\n' };
      const env = server.env.length ? `  Environment:\n${server.env.map((e) => `    ${e}\n`).join('')}` : '';
      return ok(`multi-account-mcp:\n  Scope: User config (available in all your projects)\n  Status: ✘ Failed to connect\n  Type: stdio\n  Command: ${server.command}\n  Args: ${server.args.join(' ')}\n${env}\n`);
    }
    if (a[1] === 'remove') { if (!server) return { status: 1, stdout: '', stderr: 'not found' }; server = undefined; return ok(); }
    if (a[1] === 'add') {
      if (server) return { status: 1, stdout: '', stderr: 'MCP server multi-account-mcp already exists in user config\n' };
      const rest = a.slice(a.indexOf('--') + 1);
      const env = a.slice(0, a.indexOf('--')).flatMap((x, i, all) => (all[i - 1] === '-e' ? [x] : []));
      server = { command: rest[0], args: rest.slice(1), env };
      return ok();
    }
    throw new Error(`unexpected ${a}`);
  };
  return { claude, calls, get: () => server };
}

it('claude-code with the claude CLI: state from `claude mcp get`, idempotent, CLAUDE_CONFIG_DIR location, uninstall', async () => {
  const f = fakeClaude();
  const d = deps({ env: { CLAUDE_CONFIG_DIR: '/cc', MULTI_ACCOUNT_MCP_HOME: join(dir, 'no-store') }, home: dir, claude: f.claude });
  expect(await install(['claude-code'], d)).toBe(0);
  expect(f.get()).toEqual({ command: NODE, args: [self.script, 'serve'], env: [] });
  expect(out).toContain(`Installed multi-account-mcp in claude-code (${join('/cc', '.claude.json')}) with the claude CLI.`);
  out = '';
  expect(await install(['claude-code'], d)).toBe(0); // second run: no "already exists" failure
  expect(out).toMatch(/already installed/);
  out = '';
  expect(await install(['claude-code', '--secrets-file'], d)).toBe(0); // a changed entry is replaced
  expect(out).toMatch(/Updated/);
  expect(f.get()?.env).toEqual(['MULTI_ACCOUNT_MCP_SECRETS=file']);
  out = '';
  expect(await install(['claude-code', '--secrets-file'], d)).toBe(0);
  expect(out).toMatch(/already installed/);
  out = '';
  expect(await install(['claude-code', '--uninstall'], d)).toBe(0);
  expect(f.get()).toBeUndefined();
  expect(out).toMatch(/Removed multi-account-mcp from claude-code/);
  out = '';
  expect(await install(['claude-code', '--uninstall'], d)).toBe(0);
  expect(out).toBe('multi-account-mcp is not installed in claude-code. Nothing changed.\n');
  expect(await readdir(dir)).toEqual([]); // never wrote a file itself
  // No claude binary: falls back to writing the config file
  expect(await install(['claude-code'], deps({ env: { MULTI_ACCOUNT_MCP_HOME: join(dir, 'no-store') }, home: dir, claude: () => undefined }))).toBe(0);
  expect(JSON.parse(await readFile(join(dir, '.claude.json'), 'utf8')).mcpServers['multi-account-mcp']).toEqual({ type: 'stdio', ...local() });
});
