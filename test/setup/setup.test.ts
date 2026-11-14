// The add-account page, driven over HTTP: every sign-in path, and the page's security rules.
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNet, type Server as NetServer, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountStore, type KeyringLike } from '../../src/accounts/index.js';
import { createMailClient } from '../../src/mail/index.js';
import { MANAGED_MESSAGE } from '../../src/auth/oauth.js';
import { ADD_TIMEOUT_MS, defaultLabel, plainError, startSetupServer } from '../../src/setup/server.js';
import { DOMAIN_CHECK, bounce, page as pageHtml, start as startHtml } from '../../src/setup/page.js';
import { AccountError, type Account, type MailCredentials } from '../../src/types.js';
import { startServers, type Servers } from '../mail/servers.js';
import { startMockProvider, type MockProvider } from '../auth/mockProvider.js';

function fakeKeyring(broken = false): KeyringLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const down = () => { if (broken) throw new Error('no keychain'); };
  return { map, get: async (k) => { down(); return map.get(k) ?? null; }, set: async (k, v) => { down(); map.set(k, v); }, delete: async (k) => { map.delete(k); } };
}

const ENV = { MULTI_ACCOUNT_MCP_GOOGLE_CLIENT_ID: 'gid', MULTI_ACCOUNT_MCP_MICROSOFT_CLIENT_ID: 'mid' };
type Setup = Awaited<ReturnType<typeof startSetupServer>>;
interface Res { status: number; headers: Record<string, any>; text: string; json: any }
interface ReqOpts {
  cookie?: boolean | string; host?: string; origin?: string | null; body?: unknown; raw?: string; type?: string;
  csrf?: string | null; site?: string; headers?: Record<string, string>; onSocket?: (s: Socket) => void;
}

const bodies: string[] = []; // every response body, checked for secrets and developer text
let prefix = '', token = '', cookie = '', csrf = '';
const at = (p: string) => prefix + p;

function req(s: Setup, method: string, path: string, o: ReqOpts = {}): Promise<Res> {
  const payload = o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined);
  const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${s.port}`, ...o.headers };
  if (o.cookie !== false && (cookie || typeof o.cookie === 'string')) headers.cookie = typeof o.cookie === 'string' ? o.cookie : cookie;
  if (method === 'POST' && o.origin !== null) headers.origin = o.origin ?? `http://127.0.0.1:${s.port}`;
  if (method === 'POST' && o.csrf !== null && csrf) headers['x-csrf'] = o.csrf ?? csrf;
  if (o.site) headers['sec-fetch-site'] = o.site;
  if (payload !== undefined) { headers['content-type'] = o.type ?? 'application/json'; headers['content-length'] = String(Buffer.byteLength(payload)); }
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port: s.port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        bodies.push(text);
        let json: unknown;
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode!, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (o.onSocket) r.on('socket', o.onSocket);
    r.end(payload);
  });
}
const get = (u: string): Promise<Res> => new Promise((resolve, reject) => {
  request(u, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: '', json: undefined })); }).on('error', reject).end();
});

/** What the start page's script does: post the fragment token once, keep the cookie, read the CSRF token from the page. */
async function launch(s: Setup) {
  const u = new URL(s.url);
  prefix = u.pathname.replace(/\/start$/, '');
  token = u.hash.slice(1);
  cookie = csrf = '';
  const r = await req(s, 'POST', at('/start'), { body: { token } });
  expect(r.status).toBe(200);
  cookie = String(r.headers['set-cookie'][0]).split(';')[0];
  csrf = /<meta name="csrf" content="([\w-]+)">/.exec((await req(s, 'GET', at('/'))).text)![1];
  return r;
}

let dir: string;
let s: Setup;
let store: Awaited<ReturnType<typeof createAccountStore>>;
let keyring: ReturnType<typeof fakeKeyring>;
let verified: MailCredentials[];
let mock: MockProvider;
type Verify = (a: Account, c: MailCredentials) => Promise<void>;

async function start(o: { broken?: boolean; real?: number; env?: NodeJS.ProcessEnv; idleMs?: number; verify?: Verify; noLaunch?: boolean; cmd?: string } = {}) {
  keyring = fakeKeyring(o.broken);
  store = await createAccountStore({ dir, keyring });
  // Never a real provider: the fake records the login, the real client only ever gets 127.0.0.1 or *.example.test hosts.
  const mail = o.real ? createMailClient({ timeoutMs: o.real }) : { verify: o.verify ?? (async (_a: Account, c: MailCredentials) => { verified.push(c); }) };
  s = await startSetupServer({ store, mail, env: o.env ?? ENV, endpoints: { google: mock.endpoints, microsoft: mock.endpoints }, idleMs: o.idleMs, cmd: o.cmd });
  if (!o.noLaunch) await launch(s);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mam-setup-'));
  verified = [];
  bodies.length = 0;
  prefix = token = cookie = csrf = '';
  mock = await startMockProvider();
});
afterEach(async () => {
  vi.useRealTimers();
  s?.close();
  await mock.close();
  await rm(dir, { recursive: true, force: true });
  // Developer hints belong on the CLI's stderr only.
  expect(bodies.join('\n')).not.toMatch(/MULTI_ACCOUNT_MCP|environment/i);
});

/** Runs a sign-in through the mock provider and returns the flow id the page would read from #flow=. */
async function oauth(provider: 'google' | 'microsoft', tamper?: (u: URL) => void) {
  const startRes = await req(s, 'GET', at(`/oauth/start?provider=${provider}`));
  expect(startRes.status).toBe(302);
  const auth = new URL(startRes.headers.location);
  tamper?.(auth);
  const cb = new URL((await get(auth.toString())).headers.location);
  const back = await req(s, 'GET', cb.pathname + cb.search, { host: cb.host, cookie: false });
  expect(back.status).toBe(302);
  const landing = new URL(back.headers.location);
  expect(landing.origin + landing.pathname).toBe(`http://127.0.0.1:${s.port}${prefix}/`);
  return { id: /^#flow=([\w-]+)$/.exec(landing.hash)![1], callback: cb, landing };
}

const contrast = (a: string, b: string) => {
  const lum = (h: string) => {
    const hex = h.length === 4 ? `#${[...h.slice(1)].map((x) => x + x).join('')}` : h;
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

describe('launch link and session', () => {
  beforeEach(() => start({ noLaunch: true }));

  it('the launch token is in the fragment, works once, and is swapped for a separate session cookie', async () => {
    const u = new URL(s.url);
    expect(u.origin).toBe(`http://127.0.0.1:${s.port}`);
    expect(u.pathname).toMatch(/^\/[\w-]{16}\/start$/);
    expect(u.hash).toMatch(/^#[\w-]{43}$/);
    prefix = u.pathname.replace(/\/start$/, '');
    const startPage = await req(s, 'GET', at('/start'));
    expect(startPage.status).toBe(200);
    expect(startPage.text).not.toContain(u.hash.slice(1));
    expect(startPage.text).toContain("fetch('start'");
    const r = await launch(s);
    const [set] = r.headers['set-cookie'];
    expect(set).toMatch(new RegExp(`^mam_[\\w-]{12}=[\\w-]{43}; HttpOnly; SameSite=Strict; Path=${prefix}$`));
    expect(set).not.toContain(token);
    // Used up: the same token again is refused, the session keeps working.
    expect((await req(s, 'POST', at('/start'), { cookie: false, body: { token } })).status).toBe(403);
    expect((await req(s, 'GET', at('/start'))).headers.location).toBe(`${prefix}/`);
    expect((await req(s, 'GET', at('/'))).text).toContain('Add an email account');
  });

  it('each run gets its own cookie name and path prefix', async () => {
    const other = await startSetupServer({ store, mail: { verify: async () => {} }, env: {} });
    try {
      const [a, b] = [new URL(s.url), new URL(other.url)];
      expect(a.pathname).not.toBe(b.pathname);
      await launch(s);
      const name1 = cookie.split('=')[0];
      await launch(other);
      expect(cookie.split('=')[0]).not.toBe(name1);
    } finally { other.close(); }
  });

  it('an unused token expires after 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    s.close();
    await start({ noLaunch: true });
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1000);
    const u = new URL(s.url);
    prefix = u.pathname.replace(/\/start$/, '');
    const r = await req(s, 'POST', at('/start'), { body: { token: u.hash.slice(1) } });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/expired/);
  });

  it('wrong guesses are limited to 8 a minute, then 429 even for the right token', async () => {
    const u = new URL(s.url);
    prefix = u.pathname.replace(/\/start$/, '');
    for (let i = 0; i < 8; i++) expect((await req(s, 'POST', at('/start'), { body: { token: `guess-${i}` } })).status).toBe(403);
    expect((await req(s, 'POST', at('/start'), { body: { token: u.hash.slice(1) } })).status).toBe(429);
  });

  it('the start POST needs the same origin', async () => {
    const u = new URL(s.url);
    prefix = u.pathname.replace(/\/start$/, '');
    const body = { token: u.hash.slice(1) };
    expect((await req(s, 'POST', at('/start'), { body, origin: 'http://evil.example' })).status).toBe(403);
    expect((await req(s, 'POST', at('/start'), { body, site: 'cross-site' })).status).toBe(403);
    expect((await req(s, 'POST', at('/start'), { body, site: 'same-origin' })).status).toBe(200);
  });
});

describe('commands on the page', () => {
  it('"run ... add again" and the allow-send hint use the invocation the CLI passed in, escaped', async () => {
    s.close();
    await start({ cmd: 'node "/a <b>/index.js"' });
    const html = (await req(s, 'GET', at('/'))).text;
    expect(html).toContain('<code>node &#34;/a &#60;b&#62;/index.js&#34; allow-send</code>');
    expect(html).toContain('"The setup page stopped. Run node \\"/a \\u003cb>/index.js\\" add again."');
    expect((await req(s, 'POST', at('/start'), { body: { token: 'wrong' } })).json.error).toBe('This link has expired or was already used. Run node "/a <b>/index.js" add again.');
  });
});

describe('security', () => {
  beforeEach(() => start());

  it('without the session cookie nothing works; the x-session header is not accepted', async () => {
    const session = cookie.split('=')[1];
    expect((await req(s, 'GET', at('/'), { cookie: false })).text).not.toContain('csrf');
    expect((await req(s, 'GET', at('/?r=1'), { cookie: false })).status).toBe(403);
    expect((await req(s, 'GET', at('/api/preset?address=a@b.example'), { cookie: false })).status).toBe(403);
    expect((await req(s, 'POST', at('/api/password'), { cookie: false, body: {} })).status).toBe(403);
    expect((await req(s, 'POST', at('/api/password'), { cookie: false, headers: { 'x-session': session }, body: {} })).status).toBe(403);
    expect((await req(s, 'GET', at('/api/preset?address=a@b.example'), { cookie: false, headers: { 'x-session': session } })).status).toBe(403);
    expect((await req(s, 'GET', at('/api/preset?address=a@b.example'), { cookie: `mam_session=${session}` })).status).toBe(403);
    expect((await req(s, 'GET', at('/'))).status).toBe(200);
  });

  it('every route lives under the random prefix the cookie is scoped to', async () => {
    for (const p of ['/', '/api/password', '/api/done', `/x${prefix}/`, `${prefix}x/`, '/s/' + token]) {
      expect((await req(s, 'GET', p)).status).toBe(404);
    }
    expect((await req(s, 'POST', '/api/done', { body: {} })).status).toBe(404);
  });

  it('sends a strict CSP with a nonce, no framing, no caching, and a Permissions-Policy', async () => {
    const page = await req(s, 'GET', at('/'));
    const csp = page.headers['content-security-policy'];
    const nonce = /'nonce-([\w-]+)'/.exec(csp)![1];
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).not.toMatch(/unsafe-inline|https?:/);
    expect(page.text).toContain(`<script nonce="${nonce}">`);
    expect(page.text).not.toMatch(/<script(?! nonce)|src="http|href="http[^"]*\.(css|js)/);
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['permissions-policy']).toMatch(/camera=\(\), microphone=\(\), geolocation=\(\)/);
    expect((await req(s, 'GET', at('/'))).headers['content-security-policy']).not.toContain(nonce);
    expect((await req(s, 'GET', at('/api/preset?address=x'))).headers['permissions-policy']).toBeTruthy();
  });

  it('Host: only 127.0.0.1:<port>, except the OAuth callback which also takes localhost:<port>', async () => {
    for (const host of ['evil.example', `evil.example:${s.port}`, `127.0.0.1:${s.port + 1}`, '127.0.0.1', `localhost:${s.port}`, `LOCALHOST:${s.port}`]) {
      expect((await req(s, 'GET', at('/'), { host })).status).toBe(421);
      expect((await req(s, 'POST', at('/api/done'), { host, body: {} })).status).toBe(421);
    }
    expect((await req(s, 'GET', '/callback?state=x', { host: `localhost:${s.port}`, cookie: false })).status).toBe(400);
    expect((await req(s, 'GET', '/callback?state=x', { cookie: false })).status).toBe(400);
    expect((await req(s, 'GET', '/callback?state=x', { host: `evil.example:${s.port}`, cookie: false })).status).toBe(421);
    expect((await req(s, 'GET', at('/'))).status).toBe(200);
  });

  it('POSTs need the CSRF token, same Origin, same-origin Fetch Metadata, JSON, and a small body', async () => {
    const ok = { kind: 'yahoo', address: 'a@yahoo.example.test', password: 'x' };
    expect((await req(s, 'POST', at('/api/password'), { body: ok, csrf: null })).status).toBe(403);
    expect((await req(s, 'POST', at('/api/password'), { body: ok, csrf: 'wrong' })).status).toBe(403);
    expect((await req(s, 'POST', at('/api/password'), { body: ok, site: 'cross-site' })).status).toBe(403);
    expect((await req(s, 'POST', at('/api/password'), { body: ok, site: 'same-site' })).status).toBe(403);
    expect((await req(s, 'POST', at('/api/password'), { body: ok, origin: 'http://evil.example' })).status).toBe(403);
    expect((await req(s, 'POST', at('/api/password'), { body: ok, origin: null })).status).toBe(403);
    expect((await req(s, 'POST', at('/api/password'), { body: ok, origin: `http://localhost:${s.port}` })).status).toBe(403);
    expect((await req(s, 'POST', at('/api/password'), { body: ok, origin: `http://127.0.0.1:${s.port + 1}` })).status).toBe(403);
    expect((await req(s, 'POST', at('/api/done'), { body: {}, csrf: null })).status).toBe(403);
    expect((await req(s, 'POST', at('/api/password'), { raw: 'kind=yahoo', type: 'application/x-www-form-urlencoded' })).status).toBe(400);
    expect((await req(s, 'POST', at('/api/password'), { raw: JSON.stringify({ pad: 'x'.repeat(20_000) }) })).status).toBe(413);
    expect((await req(s, 'POST', at('/api/password'), { raw: '{bad', site: 'same-origin' })).status).toBe(400);
    expect(verified).toEqual([]);
  });

  it('Done shuts the server down', async () => {
    expect((await req(s, 'POST', at('/api/done'), { body: {} })).json).toEqual({ ok: true });
    await s.done;
    await expect(req(s, 'GET', at('/'))).rejects.toThrow();
  });

  it('input and button borders have at least 3:1 contrast in light and dark', async () => {
    const css = (await req(s, 'GET', at('/'))).text;
    const [light, dark] = [...css.matchAll(/:root\{([^}]*)\}/g)].map((m) => Object.fromEntries([...m[1].matchAll(/--([\w-]+):(#[0-9a-f]{3,6})\b/g)].map((x) => [x[1], x[2]])));
    for (const t of [light, dark]) {
      expect(contrast(t.line, t.card)).toBeGreaterThanOrEqual(3);
      expect(contrast(t.line, t.bg)).toBeGreaterThanOrEqual(3);
    }
  });
});

it('every page script parses, in each configuration', () => {
  const pages = [pageHtml('n', { csrf: 'c', google: true, microsoft: true }), pageHtml('n', { csrf: 'c', google: false, microsoft: false }), startHtml('n'), bounce('n')];
  let n = 0;
  for (const html of pages) for (const m of html.matchAll(/<script nonce="n">([\s\S]*?)<\/script>/g)) { new Function(m[1]); n++; }
  expect(n).toBe(4);
});

it('shuts down after the idle time', async () => {
  await start({ idleMs: 50, noLaunch: true });
  await s.done;
});

describe('password sign-in against real test mail servers', () => {
  let servers: Servers;
  beforeEach(async () => {
    servers = await startServers([]);
    servers.imap.users['me@example.com'] = { password: 'testpass' };
    await start({ real: ADD_TIMEOUT_MS });
  });
  afterEach(() => servers.close());

  const body = (over: object = {}) => ({
    kind: 'imap', address: 'me@example.com', password: 'testpass', label: 'Side Project',
    imap: { host: '127.0.0.1', port: servers.imapPort, secure: false }, smtp: { host: '127.0.0.1', port: servers.smtpPort, secure: false }, ...over,
  });

  it('tests reading and sending, then saves with the secret in the keychain only', async () => {
    const r = await req(s, 'POST', at('/api/password'), { body: body() });
    expect(r.json).toEqual({ ok: true, label: 'Side Project' });
    expect(servers.smtpAuths).toHaveLength(1);
    const [a] = await store.list();
    expect(a).toMatchObject({ id: 'side-project', label: 'Side Project', address: 'me@example.com', auth: 'password', allowSend: false, imap: { port: servers.imapPort } });
    expect(await store.getSecret(a.id)).toEqual({ kind: 'password', password: 'testpass' });
    expect(readFileSync(join(dir, 'accounts.json'), 'utf8')).not.toContain('testpass');
  });

  it('reading works but sending does not: saved, with a plain warning', async () => {
    const r = await req(s, 'POST', at('/api/password'), { body: body({ smtp: { host: '127.0.0.1', port: 1, secure: false } }) });
    expect(r.json).toEqual({ ok: true, label: 'Side Project', warning: "Connected for reading. Sending isn't working yet: Couldn't reach 127.0.0.1. Check the server name." });
    expect(await store.list()).toHaveLength(1);
  });

  it('a wrong password says so in plain words, saves nothing, and is never echoed (even a one-letter one)', async () => {
    for (const password of ['WRONG-pass-123', 'e']) {
      const r = await req(s, 'POST', at('/api/password'), { body: body({ password }) });
      expect(r.json).toEqual({ error: 'That address or app password was not accepted.' });
    }
    expect(await store.list()).toEqual([]);
    expect(keyring.map.size).toBe(0);
    expect(bodies.join('\n')).not.toMatch(/WRONG-pass-123|testpass|•/);
  });

  it('server problems name the host, without raw codes or a label the user never typed', async () => {
    const down = await req(s, 'POST', at('/api/password'), { body: body({ imap: { host: '127.0.0.1', port: 1, secure: false } }) });
    expect(down.json).toEqual({ error: "Couldn't reach 127.0.0.1. Check the server name." });
    // DNS failure is a server-name problem, not a password problem. (.test never resolves.)
    const dns = await req(s, 'POST', at('/api/password'), { body: body({ imap: { host: 'imap.nowhere.example.test', port: 993, secure: true } }) });
    expect(dns.json).toEqual({ error: "Couldn't reach imap.nowhere.example.test. Check the server name." });
    expect(bodies.join('\n')).not.toMatch(/E[A-Z]{4,}|Side Project:/);
    expect(await store.list()).toEqual([]);
  });

  it('adding the same address again updates its password and keeps the account (a changed app password)', async () => {
    expect((await req(s, 'POST', at('/api/password'), { body: body() })).json.ok).toBe(true);
    const id = (await store.list())[0].id;
    await store.update(id, { allowSend: true });
    const dup = await req(s, 'POST', at('/api/password'), { body: body({ label: 'Again' }) });
    expect(dup.json).toMatchObject({ ok: true, again: true, label: 'Side Project' });
    expect(await store.list()).toHaveLength(1);
    expect((await store.get(id))!.allowSend).toBe(true);
  });
});

describe('a server that never answers', () => {
  let hung: NetServer;
  const socks: Socket[] = [];
  beforeEach(async () => {
    hung = createNet((c) => { socks.push(c); });
    await new Promise<void>((r) => hung.listen(0, '127.0.0.1', r));
    await start({ real: 300 });
  });
  afterEach(() => { socks.forEach((c) => c.destroy()); hung.close(); });

  it('times out with a plain message', async () => {
    const port = (hung.address() as { port: number }).port;
    const r = await req(s, 'POST', at('/api/password'), { body: { kind: 'imap', address: 'me@example.com', password: 'p', imap: { host: '127.0.0.1', port, secure: false }, smtp: { host: '127.0.0.1', port, secure: false } } });
    expect(r.json).toEqual({ error: '127.0.0.1 did not answer in time. Check the server name and port.' });
  });

  it('the add command uses the short add-time timeout', () => {
    expect(ADD_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(readFileSync(new URL('../../src/cli/index.ts', import.meta.url), 'utf8')).toMatch(/setup: \{ mail: createMailClient\(\{ timeoutMs: ADD_TIMEOUT_MS \}\) \}/);
  });
});

describe('cancel and double submit', () => {
  let release: () => void;
  let calls = 0;
  beforeEach(async () => {
    calls = 0;
    const gate = new Promise<void>((r) => { release = r; });
    await start({ verify: async () => { calls++; await gate; } });
  });
  const body = { kind: 'imap', address: 'me@example.test', password: 'pw', imap: { host: 'imap.example.test', port: 993, secure: true }, smtp: { host: 'smtp.example.test', port: 465, secure: true } };

  it('Cancel (the browser aborting the request) means nothing is saved', async () => {
    let sock!: Socket;
    const pending = req(s, 'POST', at('/api/password'), { body, onSocket: (x) => { sock = x; } }).catch(() => 'aborted');
    while (!calls) await new Promise((r) => setTimeout(r, 5));
    sock.destroy();
    expect(await pending).toBe('aborted');
    await new Promise((r) => setTimeout(r, 20));
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(await store.list()).toEqual([]);
    expect(keyring.map.size).toBe(0);
  });

  it('a second submit while the first is checking gets the same result', async () => {
    const a = req(s, 'POST', at('/api/password'), { body });
    while (!calls) await new Promise((r) => setTimeout(r, 5));
    const b = req(s, 'POST', at('/api/password'), { body });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.json).toEqual({ ok: true, label: 'Me Example' });
    expect(rb.json).toEqual(ra.json);
    expect(await store.list()).toHaveLength(1);
  });

  it('the page has a Cancel button that aborts the check and keeps the form', async () => {
    const page = (await req(s, 'GET', at('/'))).text;
    expect(page).toContain('<button type="button" class="stop" hidden>Cancel</button>');
    expect(page).toMatch(/ctrl\.abort\(\)/);
    expect(page).toContain("say(st, 'Cancelled. Nothing was saved.')");
    expect(page.match(/\.reset\(\)/g)).toHaveLength(1); // the form is cleared only after a save
    expect(/function connected\(r\) \{[^}]*\.reset\(\)/.test(page)).toBe(true);
    release();
  });
});

describe('guided app-password paths', () => {
  beforeEach(() => start());

  it('Gmail and Yahoo use their servers, default labels come from the address, spaces in the app password are dropped', async () => {
    // The fake mail client records the login and never connects anywhere.
    expect((await req(s, 'POST', at('/api/password'), { body: { kind: 'google', address: 'jobs.search@gmail.com', password: 'abcd efgh ijkl mnop' } })).json)
      .toEqual({ ok: true, label: 'Jobs Search Gmail' });
    expect((await req(s, 'POST', at('/api/password'), { body: { kind: 'yahoo', address: 'me@yahoo.com', password: 'p1', label: ' Personal ' } })).json)
      .toEqual({ ok: true, label: 'Personal' });
    const [g, y] = await store.list();
    expect(g).toMatchObject({ provider: 'gmail', imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com' } });
    expect(y).toMatchObject({ provider: 'yahoo', id: 'personal', imap: { host: 'imap.mail.yahoo.com' } });
    expect(verified[0]).toEqual({ user: 'jobs.search@gmail.com', pass: 'abcdefghijklmnop' });
    expect(bodies.join('\n')).not.toMatch(/abcd|p1"/);
  });

  it('asks for what is missing, and auto-fills known servers for Other', async () => {
    expect((await req(s, 'POST', at('/api/password'), { body: { kind: 'yahoo', address: 'nope', password: 'x' } })).json.error).toMatch(/full email address/);
    expect((await req(s, 'POST', at('/api/password'), { body: { kind: 'yahoo', address: 'a@yahoo.com', password: '' } })).json.error).toMatch(/app password/);
    expect((await req(s, 'POST', at('/api/password'), { body: { kind: 'imap', address: 'a@b.example', password: 'x', imap: {}, smtp: {} } })).json.error).toMatch(/server names/);
    expect((await req(s, 'GET', at('/api/preset?address=me@icloud.com'))).json).toEqual({
      imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } });
    expect((await req(s, 'GET', at('/api/preset?address=me@unknown.example'))).json).toEqual({});
    expect(await store.list()).toEqual([]);
  });

  it('labels: e.g. "Jobs Gmail"', () => {
    expect(defaultLabel('jobs@gmail.com', 'gmail')).toBe('Jobs Gmail');
    expect(defaultLabel('hello@side.example', 'imap')).toBe('Hello Side');
  });

  it('Gmail and Yahoo forms warn gently when the address domain does not match', async () => {
    const domainWarning = new Function(`${DOMAIN_CHECK}; return domainWarning;`)() as (k: string, a: string) => string;
    expect(domainWarning('google', 'me@gmial.com')).toBe("This doesn't look like a Gmail address. Check for a typo, or go ahead if it's a Google Workspace address.");
    expect(domainWarning('yahoo', 'me@yaho.com')).toBe("This doesn't look like a Yahoo address. Check for a typo.");
    for (const [k, a] of [['google', 'me@gmail.com'], ['google', 'Me@GoogleMail.com '], ['yahoo', 'me@yahoo.co.uk'], ['yahoo', 'me@ymail.com'], ['google', 'me@gmail'], ['imap', 'me@x.example']]) {
      expect(domainWarning(k, a)).toBe('');
    }
    const page = (await req(s, 'GET', at('/'))).text;
    expect(page).toContain(DOMAIN_CHECK);
    expect(page).toContain('<p class="note" id="addr-note" aria-live="polite"></p>');
  });

  it('error wording comes from the code and host, never from library text', () => {
    const e = (code: ConstructorParameters<typeof AccountError>[0], m = 'Jobs: could not talk to the incoming server (ECONNREFUSED).') => new AccountError(code, m);
    expect(plainError(e('unreachable'), 'mail.example.test')).toBe("Couldn't reach mail.example.test. Check the server name.");
    expect(plainError(e('auth_failed'), 'mail.example.test')).toBe('That address or app password was not accepted.');
    expect(plainError(e('auth_failed'), 'smtp.example.test', { sending: true })).toBe('smtp.example.test did not accept the login for sending.');
    expect(plainError(new Error('pw=secret'), 'x')).toBe('Something went wrong. Try again.');
  });
});

it('keychain unavailable: says what to do next and saves nothing', async () => {
  vi.stubEnv('MULTI_ACCOUNT_MCP_SECRETS', '');
  await start({ broken: true });
  const r = await req(s, 'POST', at('/api/password'), { body: { kind: 'yahoo', address: 'a@yahoo.com', password: 'secret-pw-9' } });
  expect(r.json.error).toBe("Your computer's keychain did not save the login, so nothing was saved. Unlock the keychain (or click Allow if your computer asks), then click Connect again.");
  expect(await store.list()).toEqual([]);
  expect(bodies.join('\n')).not.toContain('secret-pw-9');
});

describe('Continue with Google / Microsoft', () => {
  beforeEach(() => start());

  it('Google: full round trip with the strict cookie: PKCE, back into the session, test, save; no token reaches the page', async () => {
    mock.next = { email: 'jobs@gmail.com' };
    const { id, callback, landing } = await oauth('google');
    expect(callback.host).toBe(`127.0.0.1:${s.port}`);
    expect(callback.pathname).toBe('/callback');
    // A browser holds the SameSite=Strict cookie back after the cross-site redirect: the landing page hops once, same-site.
    const hop = await req(s, 'GET', landing.pathname, { cookie: false });
    expect(hop.status).toBe(200);
    expect(hop.text).toContain("location.replace(location.pathname + '?r=1' + location.hash)");
    expect(hop.text).not.toContain(csrf);
    const app = await req(s, 'GET', `${landing.pathname}?r=1`);
    expect(app.text).toContain(`content="${csrf}"`);
    expect(app.text).toContain('history.replaceState(null, \'\', location.pathname)');
    const q = mock.authorizeQueries[0];
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('access_type')).toBe('offline');
    const flow = await req(s, 'GET', at(`/api/flow/${id}`));
    expect(flow.json).toEqual({ status: 'ready', address: 'jobs@gmail.com', label: 'Jobs Gmail' });
    const r = await req(s, 'POST', at(`/api/flow/${id}`), { body: { label: 'Jobs Gmail' } });
    expect(r.json).toEqual({ ok: true, label: 'Jobs Gmail' });
    expect(verified[0]).toEqual({ user: 'jobs@gmail.com', accessToken: expect.stringMatching(/^at-/) });
    const [a] = await store.list();
    expect(a).toMatchObject({ provider: 'gmail', auth: 'oauth', address: 'jobs@gmail.com', imap: { host: 'imap.gmail.com' } });
    expect(await store.getSecret(a.id)).toMatchObject({ kind: 'oauth', refreshToken: expect.stringMatching(/^rt-/) });
    expect(bodies.join('\n')).not.toMatch(/\b(at|rt)-\d/);
    expect((await req(s, 'POST', at(`/api/flow/${id}`), { body: {} })).json.error).toMatch(/expired/);
    expect((await req(s, 'GET', callback.pathname + callback.search, { cookie: false })).status).toBe(400);
  });

  it('Microsoft: localhost redirect, saved as Outlook; signing in again refreshes the saved login', async () => {
    mock.next = { email: 'me@outlook.com' };
    const { id, callback } = await oauth('microsoft');
    expect(callback.host).toBe(`localhost:${s.port}`);
    expect(mock.authorizeQueries[0].get('scope')).toMatch(/IMAP\.AccessAsUser\.All .*SMTP\.Send offline_access/);
    expect((await req(s, 'POST', at(`/api/flow/${id}`), { body: { label: '' } })).json).toEqual({ ok: true, label: 'Me Outlook' });
    expect((await store.list())[0]).toMatchObject({ provider: 'outlook', imap: { host: 'outlook.office365.com' } });
    const before = await store.getSecret('me-outlook');
    const again = await oauth('microsoft');
    expect((await req(s, 'POST', at(`/api/flow/${again.id}`), { body: {} })).json).toEqual({ ok: true, label: 'Me Outlook', again: true });
    expect(await store.list()).toHaveLength(1);
    expect(await store.getSecret('me-outlook')).not.toEqual(before);
  });

  it('Cancel after sign-in throws the pending sign-in away', async () => {
    mock.next = { email: 'jobs@gmail.com' };
    const { id } = await oauth('google');
    expect((await req(s, 'POST', at(`/api/flow/${id}/cancel`), { body: {} })).json).toEqual({ ok: true });
    expect((await req(s, 'GET', at(`/api/flow/${id}`))).json.error).toMatch(/expired/);
    expect((await req(s, 'POST', at(`/api/flow/${id}`), { body: {} })).json.error).toMatch(/expired/);
    expect(await store.list()).toEqual([]);
    expect((await req(s, 'GET', at('/'))).text).toContain("api('api/flow/' + flowId + '/cancel', {})");
  });

  it('sign-in where sending fails is saved with the warning', async () => {
    s.close();
    await start({ verify: async (a) => { if (a.allowSend) throw new AccountError('unreachable', 'x (ECONNREFUSED)'); } });
    mock.next = { email: 'jobs@gmail.com' };
    const { id } = await oauth('google');
    expect((await req(s, 'POST', at(`/api/flow/${id}`), { body: {} })).json)
      .toEqual({ ok: true, label: 'Jobs Gmail', warning: "Connected for reading. Sending isn't working yet: Couldn't reach smtp.gmail.com. Check the server name." });
  });

  it('a wrong state is refused', async () => {
    await req(s, 'GET', at('/oauth/start?provider=google'));
    const r = await req(s, 'GET', '/callback?code=code-1&state=forged', { cookie: false });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/not valid/);
    expect(await store.list()).toEqual([]);
  });

  it('a missing PKCE challenge, or a wrong one, ends the sign-in and saves nothing', async () => {
    const missing = await oauth('google', (u) => u.searchParams.delete('code_challenge'));
    expect((await req(s, 'GET', at(`/api/flow/${missing.id}`))).json).toMatchObject({ status: 'error', error: 'Sign-in did not finish. Try again.' });
    const wrong = await oauth('google', (u) => u.searchParams.set('code_challenge', 'A'.repeat(43)));
    expect((await req(s, 'GET', at(`/api/flow/${wrong.id}`))).json).toMatchObject({ status: 'error', error: 'Sign-in did not finish. Try again.' });
    expect((await req(s, 'POST', at(`/api/flow/${wrong.id}`), { body: {} })).json.error).toMatch(/expired/);
    expect(await store.list()).toEqual([]);
    expect(verified).toEqual([]);
  });

  it('an organization that has not approved the app gets the managed-account message', async () => {
    mock.next = { email: 'student@utexas.edu', error: 'access_denied', errorDescription: 'AADSTS65001: The user or administrator has not consented to use the application.' };
    const a = await oauth('microsoft');
    expect((await req(s, 'GET', at(`/api/flow/${a.id}`))).json).toEqual({ status: 'error', error: MANAGED_MESSAGE });
    mock.next = { email: 'student@utexas.edu' };
    mock.tokenError = { error: 'invalid_grant', error_description: 'AADSTS50105: Your administrator has configured the application to block users.' };
    const b = await oauth('microsoft');
    expect((await req(s, 'GET', at(`/api/flow/${b.id}`))).json).toMatchObject({ status: 'error', error: MANAGED_MESSAGE });
    mock.tokenError = undefined;
    mock.next = { email: 'x@gmail.com', error: 'access_denied' };
    expect((await req(s, 'GET', at(`/api/flow/${(await oauth('google')).id}`))).json.error).toBe('Sign-in was cancelled.');
    expect(await store.list()).toEqual([]);
  });

  it('a duplicate address from sign-in says where it is', async () => {
    await req(s, 'POST', at('/api/password'), { body: { kind: 'google', address: 'jobs@gmail.com', password: 'pw', label: 'Jobs' } });
    mock.next = { email: 'jobs@gmail.com' };
    const { id } = await oauth('google');
    expect((await req(s, 'POST', at(`/api/flow/${id}`), { body: {} })).json).toEqual({ error: 'Already added as Jobs' });
  });

  it('configured: both sign-in buttons, and Google still offers an app password', async () => {
    const page = (await req(s, 'GET', at('/'))).text;
    expect(page).toContain('Continue with Google</button>');
    expect(page).toContain('Continue with Microsoft</button>');
    expect(page).toContain('<button class="link" data-go="google-password">Sign in to Gmail with an app password instead</button>');
    expect(page).not.toContain("isn't available");
    expect(page.match(/class="provider"/g)).toHaveLength(5);
  });
});

it('unconfigured: no dead-end buttons and no developer text; Gmail goes to the app-password form', async () => {
  await start({ env: {} });
  const page = (await req(s, 'GET', at('/'))).text;
  expect(page).not.toContain('Continue with Google');
  expect(page).not.toContain('Continue with Microsoft');
  expect(page).not.toContain('app password instead');
  expect(page).toContain('<button class="provider" data-go="google-password">');
  expect(page).toContain('<span>Gmail</span></button>');
  expect(page).not.toContain('Microsoft');
  expect(page.match(/class="provider"/g)).toHaveLength(4); // Gmail, Yahoo Mail, iCloud Mail, Other email
  expect(page).toContain('https://myaccount.google.com/apppasswords');
  expect(page).toContain('https://login.yahoo.com/account/security');
  for (const p of ['google', 'microsoft']) {
    const r = await req(s, 'GET', at(`/oauth/start?provider=${p}`));
    expect(r.status).toBe(400);
    expect(r.text).toContain("isn't available in this version yet");
  }
  // afterEach checks every response body for MULTI_ACCOUNT_MCP / "environment".
  expect(bodies.join('\n')).not.toMatch(/MULTI_ACCOUNT_MCP|environment/i);
});
