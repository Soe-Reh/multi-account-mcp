// Round-4 regressions on the send path: write-ahead maybe-sent mark, verified own claim, observe-before-expire,
// holding-folder lookup. Real child processes are killed with SIGKILL mid-send.
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SMTPServer } from 'smtp-server';
import { build } from 'rolldown';
import { createMailClient } from '../../src/mail/index.js';
import { AccountError, type Account } from '../../src/types.js';
import { PASS, mail, startServers, type ServerOpts, type Servers } from './servers.js';

const ENGINE = fileURLToPath(new URL('../../node_modules/.cache/mail-engine-round4.mjs', import.meta.url));
const CHILD = fileURLToPath(new URL('./kill-child.mjs', import.meta.url));
const MIN11 = 11 * 60_000;
const REAL_NOW = Date.now.bind(Date);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

beforeAll(async () => {
  await build({ input: fileURLToPath(new URL('../../src/mail/index.ts', import.meta.url)), platform: 'node', logLevel: 'silent',
    external: (id) => !id.startsWith('.') && !id.startsWith('/'), output: { file: ENGINE, format: 'esm' }, write: true });
}, 60_000);
afterAll(() => fs.rmSync(ENGINE, { force: true }));

let srv: Servers | undefined;
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanup.splice(0)) await Promise.resolve(c()).catch(() => {});
  await srv?.close(); srv = undefined;
});

async function err(p: Promise<unknown>): Promise<AccountError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AccountError); return e as AccountError; }
  throw new Error('expected an error');
}
const later = (ms = MIN11) => vi.spyOn(Date, 'now').mockImplementation(() => REAL_NOW() + ms);

// SMTP server with a hook once the message data is in; records what it accepted.
async function smtpX(onEnd: (done: (e?: Error) => void) => void | 'keep' = () => {}, delayMs = 0) {
  const got: string[][] = [];
  const socks = new Set<net.Socket>();
  const s = new SMTPServer({ disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN', 'LOGIN'], logger: false,
    onAuth(_a, _s, done) { done(null, { user: 'x' }); },
    onData(stream, session, done) {
      stream.resume();
      stream.on('end', async () => {
        got.push(session.envelope.rcptTo.map((r) => r.address));
        if (delayMs) await wait(delayMs);
        if (onEnd(done) !== 'keep') done();
      });
    },
  });
  s.server.on('connection', (x: net.Socket) => { socks.add(x); x.on('close', () => socks.delete(x)); });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => { socks.forEach((x) => x.destroy()); s.close(() => r()); }));
  return { port: (s.server.address() as net.AddressInfo).port, got, drop: () => socks.forEach((x) => x.destroy()) };
}

// TCP proxy that can rewrite server answers and go dead for good.
async function px(port: number, s2c?: (t: string) => string) {
  const socks = new Set<net.Socket>();
  let dead = false;
  const s = net.createServer((cl) => {
    if (dead) { cl.destroy(); return; }
    const up = net.connect(port, '127.0.0.1');
    socks.add(cl); socks.add(up);
    cl.on('data', (d) => up.write(d));
    up.on('data', (d) => { if (!cl.destroyed) cl.write(s2c ? Buffer.from(s2c(d.toString('latin1')), 'latin1') : d); });
    const end = () => { cl.destroy(); up.destroy(); };
    cl.on('close', end); up.on('close', end); cl.on('error', () => {}); up.on('error', () => {});
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => { socks.forEach((x) => x.destroy()); s.close(() => r()); }));
  return { port: (s.address() as net.AddressInfo).port, kill() { dead = true; socks.forEach((x) => x.destroy()); } };
}

function child(arg: object) {
  const p = spawn(process.execPath, [CHILD, ENGINE, JSON.stringify(arg)], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  const done = new Promise<any>((r) => p.on('exit', (_c, sig) => { try { r(JSON.parse(out)); } catch { r({ killed: sig }); } }));
  return { kill: () => p.kill('SIGKILL'), done };
}

async function setup(opts: ServerOpts, smtpPort?: number) {
  srv = await startServers([], opts);
  const base = srv.account({ allowSend: true });
  const a: Account = smtpPort ? { ...base, smtp: { ...base.smtp, port: smtpPort } } : base;
  const draft = async (to = 'bob@example.org') => (await createMailClient().createDraft(a, PASS, { to: [to], subject: 'Go', text: 'Sending this.' })).draftId;
  return { s: srv, a, draft };
}

const KINDS = [['keyword claim', {}], ['holding folder', { noKeywords: true }]] as const;

describe('write-ahead maybe-sent mark: a possibly delivered draft is never sent again', () => {
  for (const [kind, opts] of KINDS) {
    for (const stage of ['after DATA, before the final reply', 'just after the final 250'] as const) {
      it(`${kind}: kill -9 ${stage}, then retries now and at +11 minutes`, async () => {
        let kill = () => {};
        let first = true;
        const sm = await smtpX((done) => {
          if (!first) return;
          first = false;
          if (stage === 'just after the final 250') { done(); kill(); return 'keep'; }
          kill(); setTimeout(() => sm.drop(), 100); return 'keep';
        });
        const { s, a, draft } = await setup(opts, sm.port);
        const id = await draft();
        const c = child({ account: a, creds: PASS, id });
        kill = c.kill;
        expect(await c.done).toEqual({ killed: 'SIGKILL' });
        expect(sm.got.length).toBe(1);
        const client = createMailClient({ timeoutMs: 5000 });
        const now = await err(client.sendDraft(a, PASS, id));
        expect(now.code).toBe('send_unconfirmed');
        expect(now.message).toContain('may have been sent');
        if (kind === 'holding folder') expect(now.message).toMatch(/kept in "MCP Sending /);
        later();
        for (const cl of [client, createMailClient({ timeoutMs: 5000 })]) expect((await err(cl.sendDraft(a, PASS, id))).code).toBe('send_unconfirmed');
        if (kind === 'holding folder') { // another send runs the stale-folder clean-up: the maybe-sent draft must not come back
          // (its own SMTP may fail under the mocked clock; the clean-up runs before SMTP)
          await client.sendDraft(a, PASS, await draft('other@example.org')).catch(() => {});
          expect(s.folder('Drafts').filter((m) => /bob@example\.org/.test(m.raw))).toEqual([]);
          expect((await err(client.sendDraft(a, PASS, id))).code).toBe('send_unconfirmed');
        }
        expect(sm.got.filter((t) => t[0] === 'bob@example.org').length).toBe(1);
      }, 30_000);
    }

    it(`${kind}: incoming server lost when the outcome must be recorded, retry at +11 minutes`, async () => {
      let lose = () => {};
      const sm = await smtpX(() => lose());
      const { a, draft } = await setup(opts, sm.port);
      const id = await draft();
      const p = await px(srv!.imapPort);
      lose = p.kill;
      const r = await createMailClient({ timeoutMs: 3000 }).sendDraft({ ...a, imap: { ...a.imap, port: p.port } }, PASS, id);
      expect(r.sent).toBe(true);
      expect(r.warning).toContain('no copy could be saved');
      expect(r.warning).not.toContain('marked as sent'); // nothing was read back
      await wait(300);
      later();
      const e = await err(createMailClient({ timeoutMs: 5000 }).sendDraft(a, PASS, id));
      expect(e.code).toBe('send_unconfirmed');
      expect(sm.got.length).toBe(1);
    }, 30_000);
  }
});

describe('verify own claim: a server that silently drops keywords', () => {
  // the server ignores new keywords but claims \* in PERMANENTFLAGS
  const s2c = (t: string) => t.replace(/\[PERMANENTFLAGS \(/g, '[PERMANENTFLAGS (\\* ');
  for (const n of [2, 4]) it(`${n} racing processes deliver exactly once`, async () => {
    for (let round = 0; round < 3; round++) {
      const sm = await smtpX(() => {}, 300);
      const { s, a, draft } = await setup({ noKeywords: true }, sm.port);
      const id = await draft();
      const p = await px(s.imapPort, s2c);
      const via = { ...a, imap: { ...a.imap, port: p.port } };
      const startAt = Date.now() + 1000;
      const outs = await Promise.all(Array.from({ length: n }, () => child({ account: via, creds: PASS, id, startAt }).done));
      expect(sm.got.length).toBe(1);
      expect(outs.filter((o) => o.ok).length).toBe(1);
      expect(s.folder('Sent').length).toBe(1);
      await srv!.close(); srv = undefined;
    }
  }, 60_000);

  it('falls back to the holding folder; without MOVE it refuses with a plain error and sends nothing', async () => {
    const sm = await smtpX();
    const { s, a, draft } = await setup({ noKeywords: true, noMove: true }, sm.port);
    const id = await draft();
    const p = await px(s.imapPort, s2c);
    const e = await err(createMailClient().sendDraft({ ...a, imap: { ...a.imap, port: p.port } }, PASS, id));
    expect(e.message).toContain('cannot be sent safely');
    expect(sm.got.length).toBe(0);
    expect(s.folder('Drafts').length).toBe(1);
  });
});

describe('clock and expiry', () => {
  for (const [kind, opts] of KINDS) it(`${kind}: a second process 11 minutes ahead while the first is mid-send: one delivery`, async () => {
    const sm = await smtpX(() => {}, 2500);
    const { a, draft } = await setup(opts, sm.port);
    const id = await draft();
    const A = child({ account: a, creds: PASS, id });
    await wait(1200);
    const B = child({ account: a, creds: PASS, id, skewMs: MIN11 });
    const outs = await Promise.all([A.done, B.done]);
    expect(sm.got.length).toBe(1);
    expect(outs.filter((o) => o.ok).length).toBe(1);
  }, 30_000);

  it('a claim dated a year ahead is busy at first, with a retry time, and sendable once observed past the window', async () => {
    const future = (Date.now() + 365 * 86400_000).toString(36);
    const sm = await smtpX();
    const { s } = await setup({ drafts: [{ uid: 1, raw: mail({ from: 'me@example.com', to: 'bob@example.org' }), flags: ['\\Draft', `$mcpclaim.${future}.ab`] }] }, sm.port);
    const a = { ...s.account({ allowSend: true }), smtp: { host: '127.0.0.1', port: sm.port, secure: false } };
    const id = enc(['Drafts', String(s.imap.getMailbox('Drafts').uidvalidity), 1]);
    const client = createMailClient({ timeoutMs: 3000 });
    const e = await err(client.sendDraft(a, PASS, id));
    expect(e.code).toBe('timeout');
    expect(e.message).toContain('an earlier attempt to send that draft is still marked as in progress');
    expect(e.message).toContain('try again in about 10 minutes');
    later(5 * 60_000);
    expect((await err(client.sendDraft(a, PASS, id))).message).toContain('about 5 minutes');
    later();
    await client.sendDraft(a, PASS, id);
    expect(sm.got.length).toBe(1);
  });

  it('an old claim from a dead process is not trusted by its date alone: cleared only after being observed', async () => {
    const sm = await smtpX();
    const { s } = await setup({ drafts: [{ uid: 1, raw: mail({ from: 'me@example.com', to: 'bob@example.org' }), flags: ['\\Draft', '$mcpclaim.1.ab'] }] }, sm.port);
    const a = { ...s.account({ allowSend: true }), smtp: { host: '127.0.0.1', port: sm.port, secure: false } };
    const id = enc(['Drafts', String(s.imap.getMailbox('Drafts').uidvalidity), 1]);
    const client = createMailClient({ timeoutMs: 3000 });
    expect((await err(client.sendDraft(a, PASS, id))).code).toBe('timeout');
    expect(sm.got.length).toBe(0);
    later();
    await client.sendDraft(a, PASS, id);
    expect(sm.got.length).toBe(1);
  });
});

describe('holding-folder lookup', () => {
  it('a draft set aside by a killed sender before SMTP is reported as set aside, then comes back once observed past the window', async () => {
    const { s, a, draft } = await setup({ noKeywords: true }); // the planted folder stands for a sender killed after its MOVE
    const id = await draft();
    const uid = JSON.parse(Buffer.from(id, 'base64url').toString())[2];
    const raw = s.folder('Drafts')[0].raw;
    s.imap.getMailbox('Drafts').messages.length = 0;
    const name = `MCP Sending ${Date.now().toString(36)} deadbeef ${uid}`;
    const c = createMailClient({ timeoutMs: 3000 });
    // plant through IMAP like any client would
    const { ImapFlow } = await import('imapflow');
    const im = new ImapFlow({ host: '127.0.0.1', port: s.imapPort, secure: false, auth: PASS, logger: false });
    im.on('error', () => {});
    await im.connect();
    await im.mailboxCreate(name).catch(() => {});
    await im.append(name, raw, ['\\Draft', '\\Seen']);
    await im.logout();
    const e = await err(c.sendDraft(a, PASS, id));
    expect(e.code).toBe('timeout');
    expect(e.message).toContain(`"${name}"`);
    expect(e.message).toContain('still marked as in progress');
    later();
    const back = await err(c.sendDraft(a, PASS, id));
    expect(back.code).toBe('not_found');
    expect(back.message).toContain('back in "Drafts"');
    expect(s.folder('Drafts').length).toBe(1);
    expect(s.sent.length).toBe(0);
  });
});
