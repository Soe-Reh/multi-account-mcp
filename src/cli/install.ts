// `install <client>`: adds this server to an AI tool's MCP config. Merges, never clobbers, backs up what it changes.
import { spawnSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, copyFile, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { detectSelf, invocation, NAME, type Self } from './self.js';

export { NAME };
const WRITABLE = ['claude-code', 'claude-desktop', 'cursor'] as const;
const PRINT_ONLY = ['vscode', 'gemini-cli', 'codex'] as const;
type Client = (typeof WRITABLE)[number] | (typeof PRINT_ONLY)[number];
export interface Entry { command: string; args: string[]; env?: Record<string, string> }
type Run = { status: number | null; stdout: string; stderr: string };

export interface InstallDeps {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Runs the `claude` CLI. Returns undefined when it is not installed. */
  claude?: (args: string[]) => Run | undefined;
  /** How this installation runs (detected when omitted). */
  self?: Self;
}

export const USAGE = `Usage: multi-account-mcp install <client> [--print] [--npx] [--local] [--secrets-file] [--uninstall]

  Clients it can set up:   claude-code, claude-desktop, cursor
  Print the config only:   vscode, gemini-cli, codex (with --print)

  --print         Print the config instead of writing it
  --npx           Run the published npm package with npx (the default when you ran this with npx)
  --local         Run this installation with node (the default otherwise)
  --secrets-file  Tell the server to keep logins in a file (MULTI_ACCOUNT_MCP_SECRETS=file)
  --uninstall     Remove only this server's entry
`;

export function serverEntry(self: Self, npx: boolean, secretsFile = false): Entry {
  const e: Entry = npx ? { command: 'npx', args: ['-y', NAME, 'serve'] } : { command: self.node, args: [self.script, 'serve'] };
  return secretsFile ? { ...e, env: { MULTI_ACCOUNT_MCP_SECRETS: 'file' } } : e;
}

/** The config file each writable client reads. MULTI_ACCOUNT_MCP_CLIENT_CONFIG_DIR replaces the folder (for tests). */
export function configFile(client: (typeof WRITABLE)[number], platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
  const file = { 'claude-code': join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'), cursor: join(home, '.cursor', 'mcp.json'),
    'claude-desktop': join(
      platform === 'darwin' ? join(home, 'Library', 'Application Support')
        : platform === 'win32' ? env.APPDATA || join(home, 'AppData', 'Roaming')
        : join(home, '.config'), 'Claude', 'claude_desktop_config.json') }[client];
  const dir = env.MULTI_ACCOUNT_MCP_CLIENT_CONFIG_DIR;
  return dir ? join(dir, basename(file)) : file;
}

function systemClaude(platform: NodeJS.Platform) {
  return (args: string[]): Run | undefined => {
    // shortcut: on Windows the shell joins args unquoted, so a path with spaces breaks; use --print there if it does.
    const r = spawnSync('claude', args, { encoding: 'utf8', shell: platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    if (r.error || (platform === 'win32' && r.status !== 0 && /not recognized/.test(r.stderr ?? ''))) return undefined;
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

const quote = (a: string) => (/^[\w./:@=-]+$/.test(a) ? a : JSON.stringify(a));
const envFlags = (e: Entry) => Object.entries(e.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

function snippet(client: Client, entry: Entry): string {
  const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;
  if (client === 'claude-code') return `claude mcp add --scope user ${[NAME, ...envFlags(entry), '--', entry.command, ...entry.args].map(quote).join(' ')}\n`;
  if (client === 'vscode') return json({ servers: { [NAME]: { type: 'stdio', ...entry } } });
  if (client === 'codex') {
    const env = entry.env ? `env = { ${Object.entries(entry.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')} }\n` : '';
    return `[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n${env}`;
  }
  return json({ mcpServers: { [NAME]: client === 'cursor' ? { type: 'stdio', ...entry } : entry } });
}

const WHERE: Record<Client, string> = {
  'claude-code': 'Run this in a terminal:',
  'claude-desktop': 'Merge this into claude_desktop_config.json (Claude Desktop: Settings > Developer > Edit Config):',
  cursor: 'Merge this into ~/.cursor/mcp.json:',
  vscode: 'Merge this into your mcp.json (VS Code: run "MCP: Open User Configuration"), or pass the server to `code --add-mcp`:',
  'gemini-cli': 'Merge this into ~/.gemini/settings.json:',
  codex: 'Add this to ~/.codex/config.toml, or run `codex mcp add multi-account-mcp -- <command>`:',
};

const same = (a: any, b: Entry) => !!a && a.command === b.command && JSON.stringify(a.args ?? []) === JSON.stringify(b.args) &&
  JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {});

const plainFsError = (file: string, e: any) => {
  const why = e?.code === 'EACCES' || e?.code === 'EPERM' ? 'permission denied' : e?.code === 'ENOENT' ? 'a folder in the path is missing'
    : e?.code === 'EROFS' ? 'the disk is read-only' : (e?.code ?? 'error');
  return `Could not write ${file} (${why}). Check that you own that file and its folder, then run this again. The config was not changed.`;
};

/** Reads a JSON config. undefined data = file missing. A string = refuse with this message. */
async function readConfig(file: string): Promise<{ data?: Record<string, any> } | string> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); } catch (e: any) {
    if (e?.code === 'ENOENT') return {};
    return `Could not read ${file} (${e?.code === 'EACCES' || e?.code === 'EPERM' ? 'permission denied' : e?.code ?? 'error'}). Nothing was changed.`;
  }
  raw = raw.replace(/^﻿/, ''); // some editors save a UTF-8 byte order mark
  if (!raw.trim()) return { data: {} };
  let data: any;
  try { data = JSON.parse(raw); } catch { return `${file} is not valid JSON, so it was not changed. Fix or remove that file, then run this again.`; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return `${file} does not hold a JSON object, so it was not changed. Fix or remove that file, then run this again.`;
  const s = data.mcpServers;
  if (s !== undefined && (!s || typeof s !== 'object' || Array.isArray(s))) {
    return `In ${file}, "mcpServers" is not an object (it should look like "mcpServers": { ... }), so the file was not changed. Fix that part, then run this again.`;
  }
  return { data };
}

async function writeJson(file: string, data: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const mode = await stat(file).then((s) => s.mode & 0o777, () => 0o600);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
    await rename(tmp, file);
  } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
}

/** Whether accounts.json says logins live in the file store (set when they were saved with MULTI_ACCOUNT_MCP_SECRETS=file). */
async function storeUsesFile(home: string, env: NodeJS.ProcessEnv) {
  const f = join(env.MULTI_ACCOUNT_MCP_HOME || join(home, '.multi-account-mcp'), 'accounts.json');
  try { return JSON.parse((await readFile(f, 'utf8')).replace(/^﻿/, '')).backend === 'file'; } catch { return false; }
}

export async function install(argv: string[], d: InstallDeps = {}): Promise<number> {
  const out = d.out ?? ((s) => process.stdout.write(s));
  const err = d.err ?? ((s) => process.stderr.write(s));
  const platform = d.platform ?? process.platform;
  const env = d.env ?? process.env;
  const home = d.home ?? homedir();
  const self = d.self ?? detectSelf(env);
  const cmd = invocation(self);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const client = argv.find((a) => !a.startsWith('--')) as Client | undefined;
  const unknown = [...flags].filter((f) => !['--print', '--local', '--npx', '--secrets-file', '--uninstall', '--help'].includes(f));

  if (flags.has('--help')) { out(USAGE); return 0; }
  if (!client || unknown.length || ![...WRITABLE, ...PRINT_ONLY].includes(client)) {
    if (client || unknown.length) err(unknown.length ? `Unknown option ${unknown[0]}.\n` : `Unknown client "${client}".\n`);
    err(USAGE);
    return client || unknown.length ? 1 : 0;
  }
  if (flags.has('--npx') && flags.has('--local')) { err('Choose one of --npx and --local.\n'); return 1; }
  const npx = flags.has('--npx') || (!flags.has('--local') && self.npx);
  const uninstall = flags.has('--uninstall');
  let secretsFile = flags.has('--secrets-file');
  if (!secretsFile && !uninstall && await storeUsesFile(home, env)) {
    secretsFile = true;
    err('Your logins are saved in a file, not the system keychain, so the entry also sets MULTI_ACCOUNT_MCP_SECRETS=file.\n');
  }
  const entry = serverEntry(self, npx, secretsFile);
  if (!npx && !uninstall && !existsSync(entry.args[0])) {
    err(`${entry.args[0]} does not exist. Run \`npm run build\` in this checkout first.\n`);
    return 1;
  }
  if (flags.has('--print')) {
    err(`${WHERE[client]}\n`);
    out(snippet(client, entry));
    return 0;
  }
  if (!(WRITABLE as readonly string[]).includes(client)) {
    err(`multi-account-mcp cannot write the ${client} config itself. Run: ${cmd} install ${client} --print\n`);
    return 1;
  }

  let file = configFile(client as (typeof WRITABLE)[number], platform, home, env);
  const done = (what: string, saved?: string) => {
    out(`${what}\n`);
    if (saved) out(`Backup of the old file: ${saved} (only the latest backup is kept)\n`);
    if (!uninstall) {
      out(`\nNext steps:\n  1. Restart ${client === 'claude-code' ? 'Claude Code' : client === 'cursor' ? 'Cursor' : 'Claude Desktop'} so it loads the server.\n`);
      out(`  2. Add your email accounts: ${cmd} add\n`);
    }
    return 0;
  };

  // The `claude` CLI owns its config (and knows CLAUDE_CONFIG_DIR), so use it when it is there. Tests (config dir override) use the file.
  const cli = client === 'claude-code' && !env.MULTI_ACCOUNT_MCP_CLIENT_CONFIG_DIR ? (d.claude ?? systemClaude(platform)) : undefined;
  if (cli?.(['--version'])) {
    const got = cli(['mcp', 'get', NAME]);
    const text = got?.status === 0 ? got.stdout : '';
    const current = /Scope:\s*User/i.test(text);
    const isSame = current && text.includes(`Command: ${entry.command}\n`) && text.includes(`Args: ${entry.args.join(' ')}\n`) &&
      /^\s*MULTI_ACCOUNT_MCP_SECRETS=file\s*$/m.test(text) === !!entry.env;
    if (uninstall ? !current : isSame) {
      out(uninstall ? `${NAME} is not installed in ${client}. Nothing changed.\n` : `${NAME} is already installed in ${client} (${file}).\n`);
      return 0;
    }
    const steps = [current ? ['mcp', 'remove', '--scope', 'user', NAME] : undefined,
      uninstall ? undefined : ['mcp', 'add', '--scope', 'user', NAME, ...envFlags(entry), '--', entry.command, ...entry.args]].filter(Boolean) as string[][];
    for (const args of steps) {
      const r = cli(args);
      if (r?.status !== 0) { err(`\`claude ${args.slice(0, 2).join(' ')}\` failed: ${(r?.stderr || r?.stdout || '').trim() || 'no output'}\n`); return 1; }
    }
    return done(uninstall ? `Removed ${NAME} from ${client} (${file}) with the claude CLI.` : `${current ? 'Updated' : 'Installed'} ${NAME} in ${client} (${file}) with the claude CLI.`);
  }

  // A symlinked config (dotfiles repo) is written through to the real file, so the link stays.
  if (await lstat(file).then((st) => st.isSymbolicLink(), () => false)) file = await realpath(file).catch(() => file);
  const read = await readConfig(file);
  if (typeof read === 'string') { err(`${read}\n`); return 1; }
  const data = read.data ?? {};
  const current = data.mcpServers?.[NAME];
  if (uninstall ? !current : same(current, entry)) {
    out(uninstall ? `${NAME} is not installed in ${client}. Nothing changed.\n` : `${NAME} is already installed in ${client} (${file}).\n`);
    return 0;
  }
  if (read.data && await access(file, constants.W_OK).then(() => false, () => true)) {
    err(`${file} is read-only, so it was not changed. Make it writable (or add the entry by hand: ${cmd} install ${client} --print), then run this again.\n`);
    return 1;
  }
  const servers = { ...(data.mcpServers ?? {}) };
  if (uninstall) delete servers[NAME];
  else servers[NAME] = client === 'claude-desktop' ? entry : { type: 'stdio', ...entry };
  // One backup per config file: it can hold other servers' secrets, so they must not pile up.
  const saved = read.data ? `${file}.bak` : undefined;
  try {
    if (saved) await copyFile(file, saved);
    await writeJson(file, { ...data, mcpServers: servers });
  } catch (e) { err(`${plainFsError(file, e)}\n`); return 1; }
  return done(uninstall ? `Removed ${NAME} from ${client} (${file}).` : `${current ? 'Updated' : 'Installed'} ${NAME} in ${client} (${file}).`, saved);
}
