// Fresh-machine check of a multi-account-mcp binary: node scripts/stranger-check.mjs <bin> [args before the command...]
// Uses a temp HOME and temp client config dirs only. Never touches the real config, keychain or a mail provider.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const [bin, ...pre] = process.argv.slice(2);
if (!bin) { console.error('usage: stranger-check.mjs <bin> [args...]'); process.exit(2); }
const root = mkdtempSync(join(tmpdir(), 'mam-stranger-'));
const home = join(root, 'home');
mkdirSync(home);
// No real keychain is touched by these steps; the file opt-in is a belt for anything that would.
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData'), MULTI_ACCOUNT_MCP_HOME: join(home, '.multi-account-mcp'), MULTI_ACCOUNT_MCP_SECRETS: 'file' };
const run = (args, extra = {}) => spawnSync(bin, [...pre, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000 });
const fail = (msg) => { console.error(`FAIL ${msg}`); rmSync(root, { recursive: true, force: true }); process.exit(1); };
const ok = (msg) => console.log(`ok   ${msg}`);
const until = async (get, test, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (test(get())) return true; return false; };

// 1. --version
const v = run(['--version']);
if (v.status !== 0 || !/^\d+\.\d+\.\d+\n$/.test(v.stdout)) fail(`--version: ${v.stdout}${v.stderr}`);
ok(`--version ${v.stdout.trim()}`);

// 2. install into temp config dirs that already hold another server. Not run by npx, so the entry is node + this install's path.
const isEntry = (e) => !!e && isAbsolute(e.command) && existsSync(e.command) && e.args?.length === 2 && isAbsolute(e.args[0]) &&
  /[\\/]dist[\\/]cli[\\/]index\.js$/.test(e.args[0]) && existsSync(e.args[0]) && e.args[1] === 'serve';
const written = {};
let printed = '';
for (const [client, file] of [['claude-desktop', 'claude_desktop_config.json'], ['cursor', 'mcp.json']]) {
  const dir = join(root, client);
  mkdirSync(dir);
  const other = { command: 'other-mcp', args: ['--x'] };
  writeFileSync(join(dir, file), JSON.stringify({ keep: true, mcpServers: { other } }));
  const r = run(['install', client], { MULTI_ACCOUNT_MCP_CLIENT_CONFIG_DIR: dir });
  if (r.status !== 0) fail(`install ${client}: ${r.stderr}`);
  const got = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const { 'multi-account-mcp': entry, ...rest } = got.mcpServers ?? {};
  if (got.keep !== true || JSON.stringify(rest) !== JSON.stringify({ other }) || !isEntry(entry) || (client === 'cursor') !== (entry.type === 'stdio')) {
    fail(`install ${client} merged JSON: ${JSON.stringify(got)}`);
  }
  written[client] = entry;
  const baks = readdirSync(dir).filter((f) => f.includes('.bak'));
  if (baks.join() !== `${file}.bak` || !readFileSync(join(dir, baks[0]), 'utf8').includes('other-mcp')) fail(`install ${client} backup: ${baks}`);
  const again = run(['install', client], { MULTI_ACCOUNT_MCP_CLIENT_CONFIG_DIR: dir });
  if (again.status !== 0 || !/already installed/.test(again.stdout)) fail(`install ${client} second run: ${again.stdout}`);
  printed = /Add your email accounts: (.+) add\n/.exec(r.stdout)?.[1] ?? fail(`install ${client}: no next step in ${r.stdout}`);
  ok(`install ${client}: entry "${entry.command} ${entry.args.join(' ')}", other server kept, 1 backup, second run "already installed"`);
}

// 2b. the command printed in the next steps works as typed, from another folder
{
  const r = spawnSync(`${printed} list`, { shell: true, cwd: '/', env, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0 || !/No accounts yet/.test(r.stdout)) fail(`printed command "${printed} list": ${r.stdout}${r.stderr}`);
  ok(`printed command works from /: ${printed} list`);
}

// 3. launch the exact entry install wrote, the way an AI tool does (from /, its own small env), and do an MCP round trip
{
  const e = written['claude-desktop'];
  const p = spawn(e.command, e.args, { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, MULTI_ACCOUNT_MCP_HOME: env.MULTI_ACCOUNT_MCP_HOME, MULTI_ACCOUNT_MCP_SECRETS: 'file', ...e.env } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.resume();
  const send = (m) => p.stdin.write(`${JSON.stringify(m)}\n`);
  const lines = () => out.split('\n').filter(Boolean);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stranger', version: '1' } } });
  await until(lines, (l) => l.length >= 1, 20_000);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } });
  await until(lines, (l) => l.length >= 3, 20_000);
  p.kill();
  let msgs;
  try { msgs = lines().map((l) => JSON.parse(l)); } catch { fail(`serve: stdout is not JSON-RPC only: ${out.slice(0, 300)}`); }
  const tools = msgs[1]?.result?.tools?.map((t) => t.name).sort() ?? [];
  if (msgs[0]?.result?.serverInfo?.name !== 'multi-account-mcp') fail(`serve initialize: ${out.slice(0, 300)}`);
  if (tools.join() !== 'create_draft,list_accounts,read_attachment,read_message,search_mail,send_draft') fail(`serve tools/list: ${tools}`);
  const zero = msgs[2]?.result?.content?.[0]?.text ?? '';
  if (!zero.includes(`Run \`${printed} add\``)) fail(`serve list_accounts: ${zero}`);
  ok(`serve: initialize + tools/list = ${tools.length} tools (${tools.join(', ')})`);
  ok(`serve via the written entry from /: list_accounts says "${zero}"`);
}

// 4. add --no-open: the page answers on 127.0.0.1
{
  const p = spawn(bin, [...pre, 'add', '--no-open'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.resume();
  const found = await until(() => out, (s) => /http:\/\/127\.0\.0\.1:\d+\S*/.test(s), 20_000);
  if (!found) { p.kill(); fail(`add --no-open printed no URL: ${out}`); }
  const url = out.match(/http:\/\/127\.0\.0\.1:\d+\S*/)[0].split('#')[0];
  const res = await fetch(url).catch((e) => ({ status: String(e) }));
  const body = res.text ? await res.text() : '';
  p.kill('SIGINT');
  if (res.status !== 200 || !/<html/i.test(body)) fail(`add page ${url}: status ${res.status}`);
  ok(`add --no-open: page answers 200 on ${new URL(url).host}`);
}

// 5. list with zero accounts
const l = run(['list']);
if (l.status !== 0 || !/No accounts yet/.test(l.stdout)) fail(`list: ${l.stdout}${l.stderr}`);
ok('list: "No accounts yet"');

rmSync(root, { recursive: true, force: true });
console.log('stranger check passed');
