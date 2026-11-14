// The built CLI: `serve` speaks MCP on stdout and nothing else.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

it('node dist/cli/index.js serve: initialize + tools/list, stdout is protocol only', async () => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', root], { stdio: 'inherit' });
  const home = await mkdtemp(join(tmpdir(), 'mam-cli-'));
  const child = spawn(process.execPath, [join(root, 'dist/cli/index.js'), 'serve'], { env: { ...process.env, MULTI_ACCOUNT_MCP_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.resume();
  const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const lines = () => out.split('\n').filter(Boolean);
  const waitFor = async (n: number) => { for (let t = 0; lines().length < n && t < 100; t++) await new Promise((r) => setTimeout(r, 100)); };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_accounts', arguments: {} } });
    await waitFor(3);
    const msgs = lines().map((l) => JSON.parse(l));
    expect(msgs.every((m) => m.jsonrpc === '2.0')).toBe(true);
    expect(msgs[0].result.serverInfo.name).toBe('multi-account-mcp');
    expect(msgs[1].result.tools.map((t: any) => t.name).sort()).toEqual(['create_draft', 'list_accounts', 'read_attachment', 'read_message', 'search_mail', 'send_draft']);
    expect(msgs[2].result.content[0].text).toMatch(/No accounts yet/);
    // Not on PATH and not run by npx: the command shown is node + this build's absolute path.
    expect(msgs[2].result.content[0].text).toContain(`node ${join(root, 'dist/cli/index.js')} add`);
  } finally {
    child.kill();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

it('an unknown command says it is not available yet', () => {
  let err = '';
  try { execFileSync(process.execPath, [join(root, 'dist/cli/index.js'), 'frobnicate'], { stdio: 'pipe' }); } catch (e: any) { err = String(e.stderr); }
  expect(err).toMatch(/not available yet/);
});
