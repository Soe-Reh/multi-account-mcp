// sendDraft safety: drafts only, exactly once across retries, restarts and racing processes, Bcc, error mapping.
import { afterEach, describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { createMailClient } from '../../src/mail/index.js';
import { AccountError } from '../../src/types.js';
import { PASS, deadPort, faultProxy, mail, silentServer, startServers, type ServerOpts, type Servers } from './servers.js';

let srv: Servers | undefined;
afterEach(async () => { await srv?.close(); srv = undefined; });

async function err(p: Promise<unknown>): Promise<AccountError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AccountError); return e as AccountError; }
  throw new Error('expected an error');
}
const code = async (p: Promise<unknown>) => (await err(p)).code;
const enc = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const header = (raw: string) => raw.split('\r\n\r\n')[0];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(opts: ServerOpts = {}, timeoutMs = 5000) {
  srv = await startServers([{ uid: 1, raw: mail({ from: 'Alice <alice@example.org>', subject: 'Private note', extra: 'Cc: carol@example.org\r\nContent-Type: text/plain' }, 'confidential') }], opts);
  const client = createMailClient({ timeoutMs });
  const a = srv.account({ allowSend: true });
  const draftsPath = opts.gmail ? '[Gmail]/Drafts' : 'Drafts';
  const draft = async () => (await client.createDraft(a, PASS, { to: ['bob@example.org'], subject: 'Go', text: 'Sending this.' })).draftId;
  return { s: srv, client, a, draft, drafts: () => srv!.folder(draftsPath) };
}

describe('only drafts can be sent', () => {
  it('refuses an inbox message id and leaves the inbox alone', async () => {
    const { s, client, a } = await setup();
    const e = await err(client.sendDraft(a, PASS, enc(['INBOX', '7', 1])));
    expect(e.code).toBe('invalid_input');
    expect(s.sent.length).toBe(0);
    expect(s.folder('INBOX').length).toBe(1);
    expect(s.folder('INBOX')[0].flags).not.toContain('\\Deleted');
    expect(s.folder('Sent').length).toBe(0);
  });

  it('refuses a message in Drafts without the \\Draft flag, or not from the account', async () => {
    const { s, client, a } = await setup({ drafts: [
      { uid: 1, raw: mail({ from: 'me@example.com', to: 'bob@example.org' }), flags: [] },
      { uid: 2, raw: mail({ from: 'Mallory <mallory@example.net>', to: 'bob@example.org' }), flags: ['\\Draft'] },
    ] });
    const v = String(s.imap.getMailbox('Drafts').uidvalidity);
    expect(await code(client.sendDraft(a, PASS, enc(['Drafts', v, 1])))).toBe('invalid_input');
    expect(await code(client.sendDraft(a, PASS, enc(['Drafts', v, 2])))).toBe('invalid_input');
    expect(s.sent.length).toBe(0);
    expect(s.folder('Drafts').length).toBe(2);
  });

  it('rejects a second spelling of the same id', async () => {
    const { s, client, a, draft } = await setup();
    const id = await draft();
    const [f, v, u] = JSON.parse(Buffer.from(id, 'base64url').toString());
    expect(await code(client.sendDraft(a, PASS, enc(JSON.stringify([f, v, u], null, 1))))).toBe('invalid_input');
    expect(await code(client.sendDraft(a, PASS, enc(['Drafts', `0${v}`, u])))).toBe('invalid_input');
    expect(await code(client.sendDraft(a, PASS, id + '='))).toBe('invalid_input');
    expect(s.sent.length).toBe(0);
  });
});

const KINDS: [string, ServerOpts][] = [['with MOVE', {}], ['without MOVE', { noMove: true }], ['without keywords: holding folder', { noKeywords: true }]];
for (const [kind, kopts] of KINDS) describe(`send exactly once (${kind})`, () => {
  const noKeywords = !!kopts.noKeywords;
  it('two clients (two processes) racing on one draft never send it twice', async () => {
    const { s, a, draft } = await setup({ ...kopts });
    const id = await draft();
    const [p1, p2] = [createMailClient({ timeoutMs: 5000 }), createMailClient({ timeoutMs: 5000 })];
    const rs = await Promise.allSettled([p1.sendDraft(a, PASS, id), p2.sendDraft(a, PASS, id), p1.sendDraft(a, PASS, id)]);
    // losers hear "busy" (timeout) while the winner claims, "may have been sent" once it is marked, or "already sent" after
    for (const r of rs) if (r.status === 'rejected') expect(['timeout', 'send_unconfirmed', 'not_found']).toContain((r.reason as AccountError).code);
    expect(rs.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(s.sent.length).toBe(1);
  });

  it('a 5xx refusal after DATA puts the draft back and reports the reply; the same id can be retried', async () => {
    const { s, client, a, draft, drafts } = await setup({ ...kopts, smtpMode: 'reject-after-data' });
    const id = await draft();
    const e = await err(client.sendDraft(a, PASS, id));
    expect(e.code).toBe('rejected');
    expect(e.message).toContain('sending server');
    expect(e.message).toContain('content policy');
    expect(e.message).not.toMatch(/[\r\n]/);
    expect(drafts().length).toBe(1);
    expect(drafts()[0].flags.some((f) => /^\$mcp/i.test(f))).toBe(false);
    expect(s.folder('Sent').length).toBe(0);
    s.state.smtpMode = 'ok';
    await client.sendDraft(a, PASS, id);
    expect(s.sent.length).toBe(1);
    expect(drafts().length).toBe(0);
    expect(s.folder('Sent').length).toBe(1);
  });

  it('a 4xx deferral puts the draft back too', async () => {
    const { s, client, a, draft, drafts } = await setup({ ...kopts, smtpMode: 'defer-after-data' });
    const id = await draft();
    const e = await err(client.sendDraft(a, PASS, id));
    expect(e.code).toBe('unreachable');
    expect(e.message).toContain('Try again later');
    expect(drafts().length).toBe(1);
    s.state.smtpMode = 'ok';
    await client.sendDraft(a, PASS, id);
    expect(s.sent.length).toBe(1);
  });

  for (const mode of ['drop-after-data', 'hang-after-data'] as const) {
    it(`${mode}: reports send_unconfirmed, and no retry or restart sends it again`, async () => {
      const { s, client, a, draft } = await setup({ ...kopts, smtpMode: mode }, 1500);
      const id = await draft();
      const t = Date.now();
      const e = await err(client.sendDraft(a, PASS, id));
      expect(e.code).toBe('send_unconfirmed');
      expect(e.message).toContain('may have been sent');
      expect(e.message).toMatch(noKeywords ? /kept in "MCP Sending [0-9a-z]+ [0-9a-f]+ \d+"/ : /kept in "Drafts"/);
      expect(e.message).toContain('Check "Sent"');
      expect(Date.now() - t).toBeLessThan(3000);
      expect(s.sent.length).toBe(1); // the server did get it
      await wait(100);
      expect(s.smtpOpen()).toBe(0); // the deadline destroyed the socket
      s.state.smtpMode = 'ok';
      await wait(300); // the marking finishes on a fresh connection
      // keyword claim: the draft stays in Drafts, marked; holding folder: found in its folder, no longer a draft
      expect(await code(client.sendDraft(a, PASS, id))).toBe('send_unconfirmed');
      expect(await code(createMailClient().sendDraft(a, PASS, id))).toBe('send_unconfirmed');
      expect(s.sent.length).toBe(1);
    });
  }

  it('SMTP down before DATA: the same id can be retried (no false "no longer exists")', async () => {
    const { s, client, a, draft, drafts } = await setup({ ...kopts });
    const id = await draft();
    const down = { ...a, smtp: { host: '127.0.0.1', port: await deadPort(), secure: false } };
    const e = await err(client.sendDraft(down, PASS, id));
    expect(e.code).toBe('unreachable');
    expect(e.message).toContain('sending server');
    expect(drafts().length).toBe(1);
    await client.sendDraft(a, PASS, id);
    expect(s.sent.length).toBe(1);
  });

  it('deadline while SMTP is silent at the greeting: timeout, then the same id sends once', async () => {
    const { s, client, a, draft, drafts } = await setup({ ...kopts }, 800);
    const id = await draft();
    const silent = await silentServer();
    try {
      const e = await err(client.sendDraft({ ...a, smtp: { host: '127.0.0.1', port: silent.port, secure: false } }, PASS, id));
      expect(e.code).toBe('timeout');
      expect(e.message).toContain('sending server');
      await wait(100);
      expect(silent.open()).toBe(0);
      await client.sendDraft(a, PASS, id); // waits for the put-back, then sends
      expect(s.sent.length).toBe(1);
      expect(drafts().length).toBe(0);
    } finally { await silent.close(); }
  });

  it('IMAP drops after SMTP accepted: returns sent with a warning; a restart cannot resend', async () => {
    const { s, a, draft } = await setup({ ...kopts });
    const id = await draft();
    const px = await faultProxy(s.imapPort);
    try {
      const via = { ...a, imap: { ...a.imap, port: px.port } };
      // the first command after SMTP: finding the draft in its holding folder, or by our claim keyword
      px.fault.after = noKeywords ? /SEARCH HEADER/i : /KEYWORD/i;
      px.fault.mode = 'drop';
      const r = await createMailClient({ timeoutMs: 5000 }).sendDraft(via, PASS, id);
      expect(r.sent).toBe(true);
      expect(r.warning).toMatch(noKeywords ? /draft in "MCP Sending / : /draft in "Drafts"/);
      expect(s.sent.length).toBe(1);
      await wait(300);
      expect(['not_found', 'send_unconfirmed']).toContain(await code(createMailClient().sendDraft(a, PASS, id)));
      expect(s.sent.length).toBe(1);
    } finally { await px.close(); }
  });
});

describe('deadline and SMTP', () => {
  it('never starts SMTP after the deadline (slow draft fetch)', async () => {
    const { s, a, draft, drafts } = await setup({}, 600);
    const id = await draft();
    const px = await faultProxy(s.imapPort);
    try {
      px.fault.after = /UID FETCH/i;
      px.fault.mode = 'hold';
      px.fault.holdMs = 900;
      const client = createMailClient({ timeoutMs: 600 });
      expect(await code(client.sendDraft({ ...a, imap: { ...a.imap, port: px.port } }, PASS, id))).toBe('timeout');
      await wait(800);
      expect(s.smtpTotal()).toBe(0);
      expect(s.sent.length).toBe(0);
      expect(drafts().length).toBe(1);
      await client.sendDraft(a, PASS, id);
      expect(s.sent.length).toBe(1);
    } finally { await px.close(); }
  });
});

describe('Bcc', () => {
  it('a Bcc on a new draft goes in the envelope, never in the bytes sent', async () => {
    const { s, client, a } = await setup();
    const { draftId } = await client.createDraft(a, PASS, { to: ['bob@example.org'], bcc: ['Boss <boss@example.net>'], subject: 'b', text: 't' });
    expect(header(s.folder('Drafts')[0].raw)).toMatch(/^Bcc: .*boss@example\.net/im); // kept in the stored draft
    await client.sendDraft(a, PASS, draftId);
    expect(s.sent[0].to.sort()).toEqual(['bob@example.org', 'boss@example.net']);
    expect(s.sent[0].raw).not.toMatch(/boss@example\.net/);
    expect(header(s.sent[0].raw)).not.toMatch(/^Bcc:/im);
  });

  it('strips a folded Bcc header from a draft written by another mail app', async () => {
    const raw = mail({ from: 'me@example.com', to: 'bob@example.org', subject: 'Draft with Bcc', extra: 'Bcc: one@example.net,\r\n two@example.net\r\nContent-Type: text/plain' }, 'hi');
    const { s, client, a } = await setup({ drafts: [{ uid: 1, raw, flags: ['\\Draft'] }] });
    await client.sendDraft(a, PASS, enc(['Drafts', String(s.imap.getMailbox('Drafts').uidvalidity), 1]));
    expect(s.sent[0].to.sort()).toEqual(['bob@example.org', 'one@example.net', 'two@example.net']);
    expect(s.sent[0].raw).not.toMatch(/one@|two@/);
    expect((await simpleParser(s.sent[0].raw)).text?.trim()).toBe('hi');
  });
});

describe('folders', () => {
  it('Gmail: the claim does not leave a copy in Sent Mail (Gmail files it itself)', async () => {
    const { s, client, a, draft } = await setup({ gmail: true });
    await client.sendDraft(a, PASS, await draft());
    expect(s.sent.length).toBe(1);
    expect(s.folder('[Gmail]/Drafts').length).toBe(0);
    expect(s.folder('[Gmail]/Sent Mail').length).toBe(0);
    expect(s.folder('[Gmail]/Trash').length).toBe(0);
  });

  it('uses a localized Sent folder found by special-use instead of creating "Sent"', async () => {
    srv = await startServers([], { folders: { Brouillons: { 'special-use': '\\Drafts' }, 'Gesendete Elemente': { 'special-use': '\\Sent' } } });
    const client = createMailClient({ timeoutMs: 5000 });
    const a = srv.account({ allowSend: true });
    const { draftId } = await client.createDraft(a, PASS, { to: ['bob@example.org'], subject: 's', text: 't' });
    await client.sendDraft(a, PASS, draftId);
    expect(srv.folder('Gesendete Elemente').length).toBe(1);
    expect(srv.imap.getMailbox('Sent')).toBeFalsy();
  });

  it('without UIDPLUS never runs a plain EXPUNGE that would remove other deleted drafts', async () => {
    const { s, client, a, draft, drafts } = await setup({ noUidplus: true, drafts: [{ uid: 1, raw: mail({ subject: 'older draft' }), flags: ['\\Draft', '\\Deleted'] }] });
    const id = await draft();
    await client.sendDraft(a, PASS, id);
    expect(s.sent.length).toBe(1);
    expect(s.imapLog.some((l) => /^\S+ EXPUNGE/im.test(l))).toBe(false);
    expect(drafts().some((m) => /older draft/.test(m.raw))).toBe(true);
    expect(await code(client.sendDraft(a, PASS, id))).toBe('not_found');
    expect(s.sent.length).toBe(1);
  });
});

describe('recipients', () => {
  it('accepts "Name <addr>" and still refuses more than one address per entry', async () => {
    const { s, client, a } = await setup();
    const { draftId } = await client.createDraft(a, PASS, { to: ['Bob Smith <bob@example.org>'], cc: ['"Smith, Carol" <carol@example.org>'], subject: 's', text: 't' });
    await client.sendDraft(a, PASS, draftId);
    expect(s.sent[0].to.sort()).toEqual(['bob@example.org', 'carol@example.org']);
    for (const to of [['Bob <bob@example.org>, eve@example.org'], ['bob@example.org; eve@example.org'], ['Bob <bob@example.org>\r\nBcc: eve@example.org'], ['Team: a@example.org, b@example.org;']]) {
      expect(await code(client.createDraft(a, PASS, { to, subject: 's', text: 't' }))).toBe('invalid_input');
    }
  });
});
