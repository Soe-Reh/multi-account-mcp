// The account commands, run in-process with a temp store and a fake keyring.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createAccountStore, type KeyringLike } from '../../src/accounts/index.js';
import { main, openBrowser } from '../../src/cli/commands.js';
import { AccountError, type Account } from '../../src/types.js';

function fakeKeyring(): KeyringLike {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
}
const acct = (id: string, label: string, address: string): Omit<Account, 'addedAt'> => ({
  id, label, service: 'email', provider: 'imap', address, auth: 'password',
  imap: { host: 'imap.example.com', port: 993, secure: true }, smtp: { host: 'smtp.example.com', port: 465, secure: true }, allowSend: false,
});

let dir: string;
let store: Awaited<ReturnType<typeof createAccountStore>>;
let out: string, err: string, answers: (string | undefined)[], opened: string[], bad: Set<string>, badSmtp: Set<string>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mam-cli-'));
  store = await createAccountStore({ dir, keyring: fakeKeyring() });
  await store.add(acct('jobs', 'Jobs Gmail', 'jobs@example.com'), { kind: 'password', password: 'pw-jobs' });
  await store.add(acct('personal', 'Personal', 'me@example.org'), { kind: 'password', password: 'pw-me' });
  out = err = ''; answers = []; opened = []; bad = new Set(); badSmtp = new Set();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const run = (...argv: string[]) => main(argv, {
  store,
  mail: { verify: async (a) => {
    if (bad.has(a.id)) throw new AccountError('auth_failed', 'The password was not accepted.');
    if (a.allowSend && badSmtp.has(a.id)) throw new AccountError('unreachable', `${a.label}: could not talk to the sending server (ECONNREFUSED).`);
  } },
  out: (s) => { out += s; }, err: (s) => { err += s; },
  ask: async (q) => { err += q; return answers.length ? answers.shift() : ''; },
  openUrl: (u) => { opened.push(u); },
});

it('list prints a table on stdout', async () => {
  expect(await run('list')).toBe(0);
  const lines = out.trim().split('\n');
  expect(lines[0]).toMatch(/^ID\s+LABEL\s+ADDRESS\s+PROVIDER\s+SENDING$/);
  expect(lines[1]).toMatch(/^jobs\s+Jobs Gmail\s+jobs@example.com\s+imap\s+off$/);
  expect(lines).toHaveLength(3);
  expect(err).toBe('');
  await store.remove('jobs'); await store.remove('personal');
  out = '';
  expect(await run('list')).toBe(0);
  expect(out).toMatch(/No accounts yet/);
});

it('remove asks y/N, matches by id, label or address, and --yes skips the question', async () => {
  answers = ['n'];
  expect(await run('remove', 'Jobs Gmail')).toBe(1);
  expect(err).toMatch(/Remove Jobs Gmail \(jobs@example.com\).*\[y\/N\]/);
  expect(await store.list()).toHaveLength(2);
  answers = ['y'];
  expect(await run('remove', 'JOBS@example.com')).toBe(0);
  expect(out).toBe('Removed Jobs Gmail.\n');
  expect(await run('remove', 'personal', '--yes')).toBe(0);
  expect(await store.list()).toEqual([]);
});

it('an unknown account lists the accounts on stderr', async () => {
  expect(await run('remove', 'nope', '--yes')).toBe(1);
  expect(out).toBe('');
  expect(err).toMatch(/No account "nope"\. Your accounts: jobs \(Jobs Gmail, jobs@example.com\); personal \(Personal, me@example.org\)/);
});

it('test checks one or all accounts, one line each, exit 1 if any fail', async () => {
  expect(await run('test')).toBe(0);
  expect(out).toBe('ok    Jobs Gmail (jobs@example.com)\nok    Personal (me@example.org)\n');
  bad.add('personal'); out = '';
  expect(await run('test')).toBe(1);
  expect(out).toMatch(/^fail  Personal \(me@example.org\): The password was not accepted\. Run `multi-account-mcp add`\.$/m);
  out = '';
  expect(await run('test', 'jobs')).toBe(0);
  expect(out.trim().split('\n')).toHaveLength(1);
  expect(await run('test', 'ghost')).toBe(1);
  for (const a of await store.list()) await store.remove(a.id);
  out = '';
  expect(await run('test')).toBe(0);
  expect(out).toMatch(/No accounts yet/);
});

it('allow-send warns, asks, and turns sending on; --off turns it off', async () => {
  answers = [''];
  expect(await run('allow-send', 'jobs')).toBe(1);
  expect((await store.get('jobs'))!.allowSend).toBe(false);
  expect(err.split('\n').slice(0, 2).join('\n')).toMatch(/send email as jobs@example.com\.\n.*could still send mail in your name/);
  answers = ['y']; out = '';
  expect(await run('allow-send', 'jobs')).toBe(0);
  expect(out).toBe('Sending is on for Jobs Gmail.\n');
  expect(await store.get('jobs')).toMatchObject({ allowSend: true });
  expect((await store.get('jobs'))!.sendWithoutConfirm).toBeUndefined();
  out = '';
  await run('list');
  expect(out).toMatch(/^jobs .* on$/m);
  expect(await run('allow-send', 'jobs', '--off')).toBe(0);
  expect((await store.get('jobs'))!.allowSend).toBe(false);
});

it('allow-send --no-confirm prints a clear warning and sets sendWithoutConfirm; --off clears both', async () => {
  expect(await run('allow-send', 'personal', '--no-confirm', '--yes')).toBe(0);
  expect(err).toMatch(/WARNING: --no-confirm .*WITHOUT asking you/);
  expect(await store.get('personal')).toMatchObject({ allowSend: true, sendWithoutConfirm: true });
  out = '';
  await run('list');
  expect(out).toMatch(/^personal .* on \(no confirm\)$/m);
  await run('allow-send', 'personal', '--off');
  const a = (await store.get('personal'))!;
  expect([a.allowSend, a.sendWithoutConfirm]).toEqual([false, undefined]);
});

/** Does what the start page and app page do in a browser: swap the fragment token for the cookie, then click Done. */
async function clickDone(launchUrl: string) {
  const u = new URL(launchUrl);
  const post = (path: string, body: object, h: Record<string, string> = {}) =>
    fetch(new URL(path, u), { method: 'POST', headers: { origin: u.origin, 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
  const r = await post(u.pathname, { token: u.hash.slice(1) });
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  const app = new URL('./', u);
  const csrf = /name="csrf" content="([\w-]+)"/.exec(await (await fetch(app, { headers: { cookie } })).text())![1];
  expect((await post(new URL('api/done', app).pathname, {}, { cookie, 'x-csrf': csrf })).status).toBe(200);
}

it('add prints the page URL, opens it unless --no-open, and returns when Done is clicked', async () => {
  const p = run('add', '--no-open');
  for (let i = 0; !out.includes('http') && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
  const url = new URL(/http:\/\/\S+/.exec(out)![0]);
  expect(url.hostname).toBe('127.0.0.1');
  expect(url.hash).toMatch(/^#[\w-]{43}$/);
  expect(opened).toEqual([]);
  await clickDone(url.href);
  expect(await p).toBe(0);
  expect(out).toMatch(/Setup closed\. 2 accounts saved\./);

  out = '';
  const q = run('add');
  for (let i = 0; !opened.length && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
  expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/start#[\w-]+$/);
  await clickDone(opened[0]);
  expect(await q).toBe(0);
});

it('add hides the developer notes about client ids unless MULTI_ACCOUNT_MCP_DEBUG is set', async () => {
  const addOnce = async (env: NodeJS.ProcessEnv) => {
    out = err = '';
    const p = main(['add', '--no-open'], { store, mail: { verify: async () => {} }, out: (x) => { out += x; }, err: (x) => { err += x; }, setup: { env } });
    for (let i = 0; !out.includes('http') && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
    await clickDone(/http:\/\/\S+/.exec(out)![0]);
    expect(await p).toBe(0);
  };
  await addOnce({});
  expect(err).not.toMatch(/Developer note|CLIENT_ID/);
  await addOnce({ MULTI_ACCOUNT_MCP_DEBUG: '1' });
  expect(err).toMatch(/Developer note: Google sign-in is off.*MULTI_ACCOUNT_MCP_GOOGLE_CLIENT_ID/);
  expect(err).toMatch(/Developer note: Microsoft sign-in is off.*MULTI_ACCOUNT_MCP_MICROSOFT_CLIENT_ID/);
  expect(out).not.toMatch(/MULTI_ACCOUNT_MCP/);
});

it('the browser is opened without the launch URL in any command line on macOS', () => {
  const url = 'http://127.0.0.1:1234/abc/start#SECRET-token';
  const calls: { cmd: string; args: string[]; stdin: string }[] = [];
  const fake = ((cmd: string, args: string[]) => {
    const p = Object.assign(new EventEmitter(), { stdin: { end: (x: string) => { calls.at(-1)!.stdin = x; } }, unref() {} });
    calls.push({ cmd, args, stdin: '' });
    return p;
  }) as never;
  openBrowser(url, 'darwin', fake);
  expect(calls[0].cmd).toBe('osascript');
  expect(calls[0].args.join(' ')).not.toContain('SECRET');
  expect(calls[0].stdin).toBe(`open location "${url}"`);
  openBrowser(url, 'linux', fake);
  expect(calls[1]).toMatchObject({ cmd: 'xdg-open', args: [url] }); // the token there is one-time and short-lived
});

it('remove without a terminal says to pass --yes', async () => {
  answers = [undefined];
  expect(await run('remove', 'jobs')).toBe(1);
  expect(err).toMatch(/no terminal to answer in\. Run the command again with --yes/);
  expect(await store.list()).toHaveLength(2);
});

it('allow-send tests the outgoing server first and refuses when it fails, unless --force', async () => {
  badSmtp.add('jobs');
  answers = ['y'];
  expect(await run('allow-send', 'jobs')).toBe(1);
  expect(err).toMatch(/Sending was not turned on: Couldn't reach smtp\.example\.com\. Check the server name\.\nFix the outgoing server, or run again with --force/);
  expect(err).not.toMatch(/ECONNREFUSED|\[y\/N\]/);
  expect((await store.get('jobs'))!.allowSend).toBe(false);
  expect(await run('allow-send', 'jobs', '--force', '--yes')).toBe(0);
  expect((await store.get('jobs'))!.allowSend).toBe(true);
});

it('--help, --version and unknown commands', async () => {
  expect(await run('--help')).toBe(0);
  expect(out).toMatch(/allow-send <account>/);
  out = '';
  expect(await run('--version')).toBe(0);
  expect(out).toMatch(/^\d+\.\d+\.\d+\n$/);
  expect(await run('frobnicate')).toBe(1);
  expect(err).toMatch(/not available yet/);
});

it('printed commands use the invocation passed in (npx, or node + path)', async () => {
  const empty = await createAccountStore({ dir: join(dir, 'empty'), keyring: fakeKeyring() });
  const d = { store: empty, mail: { verify: async () => {} }, out: (x: string) => { out += x; }, err: (x: string) => { err += x; } };
  expect(await main(['list'], { ...d, cmd: 'npx -y multi-account-mcp' })).toBe(0);
  expect(out).toBe('No accounts yet. Run `npx -y multi-account-mcp add`.\n');
  expect(await main(['remove', 'x'], { ...d, cmd: 'node "/a b/index.js"' })).toBe(1);
  expect(err).toContain('Run `node "/a b/index.js" add`');
  out = '';
  expect(await main(['--help'], { ...d, cmd: 'npx -y multi-account-mcp' })).toBe(0);
  expect(out).toMatch(/Usage: npx -y multi-account-mcp <command>/);
  err = '';
  expect(await run('allow-send', 'personal', '--no-confirm', '--yes')).toBe(0);
  expect(err).toContain('Turn it off with: multi-account-mcp allow-send personal --off');
});

it('test: a sign-in failure says how to sign in again', async () => {
  const d = { store, mail: { verify: async () => { throw new AccountError('auth_failed', 'Sign in to Jobs Gmail again.'); } }, out: (x: string) => { out += x; }, err: (x: string) => { err += x; }, cmd: 'mam' };
  expect(await main(['test', 'jobs'], d)).toBe(1);
  expect(out).toBe('fail  Jobs Gmail (jobs@example.com): Sign in to Jobs Gmail again. Run `mam add`.\n');
});
