// The local "add an account" page: a web server on 127.0.0.1 behind a one-time launch token that signs in, tests and saves accounts.
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { providerPreset, lookupPreset, slugify } from '../accounts/presets.js';
import { oauthProvider, type OAuthName } from '../auth/clients.js';
import type { OAuthSecret } from '../auth/credentials.js';
import { MANAGED_MESSAGE, authorizeUrl, exchangeCode, isManagedError, pkce, random } from '../auth/oauth.js';
import { AccountError, type Account, type AccountStore, type MailClient, type ProviderId, type Secret, type ServerEndpoint } from '../types.js';
import { bounce, page, start as startPage } from './page.js';

const MAX_BODY = 16 * 1024;
const IDLE_MS = 15 * 60_000;
const FLOW_MS = 10 * 60_000;
const LAUNCH_MS = 5 * 60_000;
const MAX_MISSES = 8; // wrong launch tokens per minute
/** The connection test on the add page: shorter than the engine's 20 s so a dead server fails fast. */
export const ADD_TIMEOUT_MS = 8_000;

export interface SetupOptions {
  store: AccountStore;
  mail: Pick<MailClient, 'verify'>;
  env?: NodeJS.ProcessEnv;
  endpoints?: Parameters<typeof oauthProvider>[2];
  idleMs?: number;
  /** How the user runs this installation, for "run ... add again" messages. */
  cmd?: string;
}

interface Flow {
  provider: OAuthName; state: string; verifier: string; redirectUri: string; created: number;
  status: 'pending' | 'ready' | 'error'; address?: string; secret?: OAuthSecret; error?: string;
}

const PRESETS: Record<'google' | 'yahoo' | 'outlook', ReturnType<typeof providerPreset>> = {
  google: providerPreset('x@gmail.com'), yahoo: providerPreset('x@yahoo.com'), outlook: providerPreset('x@outlook.com'),
};
const NAMES: Partial<Record<ProviderId, string>> = { gmail: 'Gmail', yahoo: 'Yahoo', outlook: 'Outlook' };

/** "jobs.search@gmail.com" -> "Jobs Search Gmail". */
export function defaultLabel(address: string, provider: ProviderId) {
  const [local, domain = ''] = address.split('@');
  const words = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1));
  return [...words(local), NAMES[provider] ?? words(domain.split('.')[0])[0] ?? ''].join(' ').slice(0, 100).trim() || 'Mail';
}

/** What a person sees when a connection test fails. Built from the error code and the host they typed, never from library text. */
export function plainError(e: unknown, host: string, o: { sending?: boolean; oauth?: boolean } = {}) {
  const code = e instanceof AccountError ? e.code : undefined;
  if (code === 'auth_failed') {
    if (o.sending) return `${host} did not accept the login for sending.`;
    return o.oauth ? 'The mail server did not accept this sign-in. Try signing in again.' : 'That address or app password was not accepted.';
  }
  if (code === 'timeout') return `${host} did not answer in time. Check the server name and port.`;
  if (code === 'unreachable' && /encrypted connection/.test((e as Error).message)) return `Couldn't make a secure connection to ${host}. Check the port and security setting.`;
  if (code === 'unreachable') return `Couldn't reach ${host}. Check the server name.`;
  if (code === 'rejected') return `${host} refused the connection test.`;
  if (code === 'managed_account') return (e as Error).message;
  return 'Something went wrong. Try again.';
}

const hash = (s: string) => createHash('sha256').update(s).digest();
const same = (a: string | undefined, b: string) => typeof a === 'string' && timingSafeEqual(hash(a), hash(b));
const message = (e: unknown) => e instanceof AccountError ? e.message : 'Something went wrong. Try again.';
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const KEYCHAIN = "Your computer's keychain did not save the login, so nothing was saved. Unlock the keychain (or click Allow if your computer asks), then click Connect again.";

export async function startSetupServer(o: SetupOptions) {
  const cmd = o.cmd ?? 'multi-account-mcp';
  const EXPIRED = `This page has expired. Run <code>${escHtml(cmd)} add</code> again.`;
  let launch: string | undefined = random(32); // one use: swapped for the session below
  const launchAt = Date.now();
  const session = random(32);
  const csrf = random(32);
  let signedIn = false;
  const prefix = `/${random(12)}`;
  const cookieName = `mam_${random(9)}`;
  const misses: number[] = [];
  const flows = new Map<string, Flow>(); // keyed by flow id
  const saving = new Map<string, { result: Promise<object>; waiting: ServerResponse[] }>(); // by address
  let port = 0;
  let idle: NodeJS.Timeout;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const appHost = () => `127.0.0.1:${port}`;
  const configured = () => ({ google: !!oauthProvider('google', o.env), microsoft: !!oauthProvider('microsoft', o.env) });

  const server = createHttp((req, res) => {
    clearTimeout(idle);
    idle = setTimeout(close, o.idleMs ?? IDLE_MS);
    handle(req, res).catch(() => send(res, 500, { error: 'Something went wrong. Try again.' }));
  });
  server.requestTimeout = 60_000;

  function headers(res: ServerResponse, nonce = '') {
    const n = nonce && ` 'nonce-${nonce}'`;
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src${n || " 'none'"}; style-src${n || " 'none'"}; img-src data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), clipboard-read=()');
  }
  function send(res: ServerResponse, status: number, body: object | string, nonce?: string, cookie?: string) {
    if (res.headersSent) return void res.end();
    headers(res, nonce);
    const json = typeof body !== 'string';
    res.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/html; charset=utf-8', ...(cookie && { 'Set-Cookie': cookie }) });
    res.end(json ? JSON.stringify(body) : body);
  }
  function redirect(res: ServerResponse, to: string) {
    headers(res);
    res.writeHead(302, { Location: to });
    res.end();
  }
  const plain = (text: string) => `<!doctype html><meta charset="utf-8"><title>multi-account-mcp</title><p>${text}</p>`;
  const cookieOf = (req: IncomingMessage) => (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new AccountError('invalid_input', 'bad content type');
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new AccountError('invalid_input', 'too large');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new AccountError('invalid_input', 'too large');
      chunks.push(c as Buffer);
    }
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AccountError('invalid_input', 'bad body');
    return v;
  }

  /** Same-origin checks for any POST: Origin, and Fetch Metadata when the browser sends it. */
  function crossSite(req: IncomingMessage) {
    const site = req.headers['sec-fetch-site'];
    return req.headers.origin !== `http://${appHost()}` || (site !== undefined && site !== 'same-origin');
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', `http://${appHost()}`);
    const host = req.headers.host ?? '';
    // The provider sends the browser back here (Microsoft to localhost); the one-time state is what proves the request is ours.
    if (req.method === 'GET' && url.pathname === '/callback') {
      if (host !== appHost() && host !== `localhost:${port}`) return send(res, 421, { error: 'Wrong host' });
      return callback(url, res);
    }
    // DNS rebinding: only our own host name.
    if (host !== appHost()) return send(res, 421, { error: 'Wrong host' });
    if (!url.pathname.startsWith(`${prefix}/`)) return send(res, 404, { error: 'Not found' });
    const path = url.pathname.slice(prefix.length);
    const authed = signedIn && same(cookieOf(req), session);

    if (path === '/start') return launchRoute(req, res, authed);
    if (req.method === 'POST') {
      if (!authed) return send(res, 403, { error: `This page has expired. Run ${cmd} add again.` });
      if (crossSite(req) || !same(req.headers['x-csrf'] as string | undefined, csrf)) return send(res, 403, { error: 'Cross-origin request refused' });
      let body: Record<string, unknown>;
      try { body = await readJson(req); } catch (e) {
        return send(res, (e as Error).message === 'too large' ? 413 : 400, { error: 'That request could not be read.' });
      }
      if (path === '/api/password') return send(res, 200, await addPassword(body, res));
      const m = /^\/api\/flow\/([\w-]+)(\/cancel)?$/.exec(path);
      if (m?.[2]) { flows.delete(m[1]); return send(res, 200, { ok: true }); }
      if (m) return send(res, 200, await finishFlow(m[1], body, res));
      if (path === '/api/done') { send(res, 200, { ok: true }); setImmediate(close); return; }
      return send(res, 404, { error: 'Not found' });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });

    if (path === '/' && !authed) {
      // Back from Google/Microsoft the SameSite=Strict cookie is held back (cross-site redirect chain); one same-site hop brings it.
      if (url.searchParams.has('r')) return send(res, 403, plain(EXPIRED));
      const nonce = random(16);
      return send(res, 200, bounce(nonce), nonce);
    }
    if (!authed) return send(res, 403, plain(EXPIRED));
    if (path === '/') {
      const nonce = random(16);
      return send(res, 200, page(nonce, { csrf, cmd, ...configured() }), nonce);
    }
    if (path === '/api/preset') {
      const p = await lookupPreset(url.searchParams.get('address') ?? '');
      return send(res, 200, p ? { imap: p.imap, smtp: p.smtp } : {});
    }
    if (path === '/oauth/start') return startFlow(url.searchParams.get('provider'), res);
    const m = /^\/api\/flow\/([\w-]+)$/.exec(path);
    if (m) {
      const f = flow(m[1]);
      if (!f) return send(res, 200, { status: 'error', error: 'This sign-in has expired. Start again.' });
      if (f.status === 'error') flows.delete(m[1]);
      const provider = f.provider === 'google' ? 'gmail' : 'outlook';
      return send(res, 200, { status: f.status, error: f.error, address: f.address, label: f.address && defaultLabel(f.address, provider) });
    }
    return send(res, 404, { error: 'Not found' });
  }

  /** GET shows a page that reads the token from the URL fragment (kept out of logs); its POST swaps the token for the session cookie. */
  async function launchRoute(req: IncomingMessage, res: ServerResponse, authed: boolean) {
    if (req.method === 'GET') {
      if (authed) return redirect(res, `${prefix}/`);
      const nonce = random(16);
      return send(res, 200, startPage(nonce, cmd), nonce);
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    if (crossSite(req)) return send(res, 403, { error: 'Cross-origin request refused' });
    const now = Date.now();
    while (misses.length && now - misses[0] > 60_000) misses.shift();
    if (misses.length >= MAX_MISSES) return send(res, 429, { error: `Too many tries. Wait a minute, then run ${cmd} add again.` });
    let token: unknown;
    try { token = (await readJson(req)).token; } catch { return send(res, 400, { error: 'That request could not be read.' }); }
    if (launch && now - launchAt > LAUNCH_MS) launch = undefined;
    if (!launch || !same(token as string, launch)) {
      misses.push(now);
      return send(res, 403, { error: `This link has expired or was already used. Run ${cmd} add again.` });
    }
    launch = undefined;
    signedIn = true;
    send(res, 200, { ok: true }, undefined, `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=${prefix}`);
  }

  function flow(id: string) {
    const f = flows.get(id);
    if (f && Date.now() - f.created > FLOW_MS) flows.delete(id);
    return flows.get(id);
  }

  function startFlow(name: string | null, res: ServerResponse) {
    if (name !== 'google' && name !== 'microsoft') return send(res, 400, plain('Unknown sign-in.'));
    const p = oauthProvider(name, o.env, o.endpoints);
    if (!p) return send(res, 400, plain("This sign-in isn't available in this version yet."));
    const { verifier, challenge } = pkce();
    // Microsoft registers http://localhost (any port); Google desktop clients take the 127.0.0.1 loopback.
    const redirectUri = `http://${name === 'microsoft' ? 'localhost' : '127.0.0.1'}:${port}/callback`;
    const state = random(24);
    flows.set(random(16), { provider: name, state, verifier, redirectUri, created: Date.now(), status: 'pending' });
    redirect(res, authorizeUrl(p, { state, challenge, redirectUri }));
  }

  async function callback(url: URL, res: ServerResponse) {
    const state = url.searchParams.get('state') ?? '';
    const entry = [...flows].find(([id, f]) => f.status === 'pending' && same(state, f.state) && flow(id));
    if (!entry) return send(res, 400, plain('This sign-in link is not valid or has expired. Go back to the setup page and try again.'));
    const [id, f] = entry;
    f.state = random(24); // one use only
    const back = () => redirect(res, `http://${appHost()}${prefix}/#flow=${id}`);
    const error = url.searchParams.get('error');
    if (error) {
      const managed = isManagedError(`${error} ${url.searchParams.get('error_description') ?? ''}`);
      Object.assign(f, { status: 'error', error: managed ? MANAGED_MESSAGE : error === 'access_denied' ? 'Sign-in was cancelled.' : 'Sign-in did not finish. Try again.' });
      return back();
    }
    try {
      const p = oauthProvider(f.provider, o.env, o.endpoints)!;
      const { address, secret } = await exchangeCode(p, url.searchParams.get('code') ?? '', f.verifier, f.redirectUri);
      Object.assign(f, { status: 'ready', address, secret });
    } catch (e) {
      Object.assign(f, { status: 'error', error: e instanceof AccountError && e.message === 'invalid_grant' ? 'Sign-in did not finish. Try again.' : message(e) });
    }
    back();
  }

  /** A second submit of the same address while the first is still checking gets the first one's result. */
  function once(address: string, res: ServerResponse, run: (cancelled: () => boolean) => Promise<object>) {
    const key = address.toLowerCase();
    let s = saving.get(key);
    if (s) { s.waiting.push(res); return s.result; }
    const waiting = [res];
    // Cancelled = every browser request waiting on this check has gone away (the page's Cancel aborts its fetch).
    const cancelled = () => waiting.every((r) => r.closed && !r.writableEnded);
    s = { waiting, result: run(cancelled).finally(() => saving.delete(key)) };
    saving.set(key, s);
    return s.result;
  }

  /** Tests the login (reading, then sending), then saves it. Nothing is saved when reading fails or the page cancelled. */
  async function save(account: Omit<Account, 'addedAt' | 'id'>, secret: Secret, label: unknown, cancelled: () => boolean) {
    const lbl = typeof label === 'string' && label.trim() ? label.trim() : defaultLabel(account.address, account.provider);
    const existing = await o.store.get(account.address);
    const reSignIn = existing && existing.auth === secret.kind && existing.provider === account.provider;
    if (existing && !reSignIn) return { error: `Already added as ${existing.label}` };
    const creds = secret.kind === 'password' ? { user: account.address, pass: secret.password } : { user: account.address, accessToken: secret.accessToken! };
    const full = { ...account, id: existing?.id ?? 'new', label: lbl, addedAt: '' };
    const oauth = secret.kind === 'oauth';
    try { await o.mail.verify({ ...full, allowSend: false }, creds); } catch (e) { return { error: plainError(e, account.imap.host, { oauth }) }; }
    // verify() checks the outgoing server only when sending is on. shortcut: this logs in to IMAP a second time; add an SMTP-only check to the mail engine if that ever matters.
    let warning: string | undefined;
    try { await o.mail.verify({ ...full, allowSend: true }, creds); } catch (e) {
      warning = `Connected for reading. Sending isn't working yet: ${plainError(e, account.smtp.host, { sending: true, oauth }).replace(/\.$/, '')}.`;
    }
    if (cancelled()) return { error: 'Cancelled. Nothing was saved.' };
    try {
      if (reSignIn) {
        await o.store.setSecret(existing.id, secret);
        if (secret.kind === 'password') await o.store.update(existing.id, { imap: account.imap, smtp: account.smtp });
        return { ok: true, label: existing.label, again: true, ...(warning && { warning }) };
      }
      const ids = (await o.store.list()).map((a) => a.id);
      const saved = await o.store.add({ ...account, id: slugify(lbl, ids), label: lbl }, secret);
      return { ok: true, label: saved.label, ...(warning && { warning }) };
    } catch (e) {
      if (e instanceof AccountError && e.code === 'keychain_unavailable') return { error: KEYCHAIN };
      if (e instanceof AccountError && e.code === 'duplicate') return { error: `Already added as ${(await o.store.get(account.address))?.label ?? lbl}` };
      throw e;
    }
  }

  async function addPassword(b: Record<string, unknown>, res: ServerResponse) {
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const address = str(b.address);
    const password = typeof b.password === 'string' ? b.password.replace(/\s+/g, '') : ''; // app passwords are shown with spaces
    if (!address.includes('@')) return { error: 'Enter your full email address.' };
    if (!password) return { error: 'Enter the app password.' };
    const kind = b.kind;
    let preset = kind === 'google' ? PRESETS.google : kind === 'yahoo' ? PRESETS.yahoo : undefined;
    const provider: ProviderId = kind === 'google' ? 'gmail' : kind === 'yahoo' ? 'yahoo' : providerPreset(address)?.provider ?? 'imap';
    if (kind === 'imap') {
      const ep = (v: unknown): ServerEndpoint => {
        const e = (v ?? {}) as Record<string, unknown>;
        return { host: str(e.host), port: Number(e.port), secure: e.secure === true || e.secure === 'true' };
      };
      preset = { provider, imap: ep(b.imap), smtp: ep(b.smtp) };
      if (!preset.imap.host || !preset.smtp.host) return { error: 'Open Server settings and enter the incoming and outgoing server names from your provider.' };
    }
    if (!preset) return { error: 'Choose a provider first.' };
    const p = preset;
    // Messages are built from codes and host names only, so the password can never appear in them.
    return once(address, res, (cancelled) => save({ label: '', service: 'email', provider, address, auth: 'password', imap: p.imap, smtp: p.smtp, allowSend: false },
      { kind: 'password', password }, b.label, cancelled)).catch(() => ({ error: 'Something went wrong. Try again.' }));
  }

  async function finishFlow(id: string, b: Record<string, unknown>, res: ServerResponse) {
    const f = flow(id);
    if (!f || f.status !== 'ready' || !f.secret || !f.address) return { error: 'This sign-in has expired. Start again.' };
    const provider: ProviderId = f.provider === 'google' ? 'gmail' : 'outlook';
    const preset = f.provider === 'google' ? PRESETS.google! : PRESETS.outlook!;
    try {
      const r = await once(f.address, res, (cancelled) => save({ label: '', service: 'email', provider, address: f.address!, auth: 'oauth', imap: preset.imap, smtp: preset.smtp, allowSend: false },
        f.secret!, b.label, cancelled)) as { ok?: boolean };
      if (r.ok) flows.delete(id);
      return r;
    } catch (e) {
      return { error: message(e) };
    }
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(idle);
    server.close(() => resolveDone());
    server.closeAllConnections();
  }

  await new Promise<void>((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); });
  port = (server.address() as AddressInfo).port;
  idle = setTimeout(close, o.idleMs ?? IDLE_MS);
  return { port, url: `http://${appHost()}${prefix}/start#${launch}`, configured: configured(), done, close };
}
