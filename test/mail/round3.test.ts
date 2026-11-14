// Round-3 regressions: claims that stay visibly unsent, lost replies, SMTP stages, racing processes, stale claims,
// refused recipients, group syntax, Bcc variants, PARTIAL NIL, very deep MIME, Bcc shown for drafts.
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ImapFlow } from 'imapflow';
import { SMTPServer } from 'smtp-server';
import { build } from 'rolldown';
import { createMailClient } from '../../src/mail/index.js';
import { AccountError, type Account } from '../../src/types.js';
import { PASS, faultProxy, mail, startServers, type ServerOpts, type Servers } from './servers.js';

let srv: Servers | undefined;
const cleanup: (() => Promise<unknown>)[] = [];
const REAL_NOW = Date.now.bind(Date);
afterEach(async () => { vi.restoreAllMocks(); for (const c of cleanup.splice(0)) await c().catch(() => {}); await srv?.close(); srv = undefined; });

async function err(p: Promise<unknown>): Promise<AccountError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AccountError); return e as AccountError; }
  throw new Error('expected an error');
}
const code = async (p: Promise<unknown>) => (await err(p)).code;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const header = (raw: string) => raw.split(/\r?\n\r?\n/)[0];
const mine = (extra = '', to = 'bob@example.org') => mail({ from: 'me@example.com', to, subject: 'x', extra: `${extra}Content-Type: text/plain` }, 'body text');
const isMcp = (f: string) => /^\$mcp/i.test(f);
// without UIDPLUS a sent draft is only flagged \Deleted, for the mail app to expunge
const live = (s: Servers, folder: string) => s.folder(folder).filter((m) => !m.flags.includes('\\Deleted'));

async function setup(opts: ServerOpts = {}, timeoutMs = 3000) {
  srv = await startServers([{ uid: 1, raw: mail({ subject: 'Inbox note' }) }], opts);
  const s = srv;
  const client = createMailClient({ timeoutMs });
  const a = s.account({ allowSend: true });
  const draft = async () => (await client.createDraft(a, PASS, { to: ['bob@example.org'], subject: 'Go', text: 'Sending this.' })).draftId;
  const plantedId = (uid: number) => enc(['Drafts', String(s.imap.getMailbox('Drafts').uidvalidity), uid]);
  return { s, client, a, draft, plantedId, drafts: () => s.folder('Drafts') };
}

// Folder names on the server, read the way any mail app would.
async function folderNames(a: Account) {
  const c = new ImapFlow({ host: a.imap.host, port: a.imap.port, secure: false, auth: PASS, logger: false });
  c.on('error', () => {});
  await c.connect();
  try { return (await c.list()).map((f) => f.path); } finally { await c.logout().catch(() => {}); }
}

const viaImap = async (s: Servers, a: Account) => { const px = await faultProxy(s.imapPort); cleanup.push(px.close); return { px, a: { ...a, imap: { ...a.imap, port: px.port } } }; };
const viaSmtp = async (s: Servers, a: Account) => { const px = await faultProxy(s.smtpPort); cleanup.push(px.close); return { px, a: { ...a, smtp: { ...a.smtp, port: px.port } } }; };

const KINDS: [string, ServerOpts][] = [['keyword claim, MOVE', {}], ['keyword claim, no MOVE', { noMove: true }], ['keyword claim, no UIDPLUS', { noUidplus: true }], ['holding folder', { noKeywords: true }]];

for (const [kind, kopts] of KINDS) describe(`claim faults (${kind})`, () => {
  const hold = !!kopts.noKeywords;
  const claimCmd = hold ? /UID MOVE/i : /UID STORE \d+ \+FLAGS \(\$mcpclaim/i;

  async function expectClean(s: Servers, a: Account) {
    await wait(400); // the clean-up runs on a fresh connection
    expect(s.sent.length).toBe(0);
    expect(s.folder('Drafts').length).toBe(1);
    expect(s.folder('Drafts')[0].flags.filter(isMcp)).toEqual([]);
    expect(s.folder('Sent').length).toBe(0);
    expect((await folderNames(a)).filter((f) => f.startsWith('MCP'))).toEqual([]);
  }

  for (const mode of ['drop', 'dropAfter'] as const) {
    it(`claim command ${mode === 'drop' ? 'lost on the way' : 'done but its answer lost'}: a definite failure, then the same id sends once`, async () => {
      const { s, client, a, draft } = await setup(kopts);
      const id = await draft();
      const { px, a: via } = await viaImap(s, a);
      Object.assign(px.fault, { after: claimCmd, mode });
      const e = await err(client.sendDraft(via, PASS, id));
      expect(['unreachable', 'timeout']).toContain(e.code);
      expect(e.message).not.toMatch(/may have been sent/);
      await expectClean(s, a);
      // keyword claim keeps the UID, so another process can retry with the same id too
      await (hold ? client : createMailClient({ timeoutMs: 3000 })).sendDraft(a, PASS, id);
      expect(s.sent.length).toBe(1);
      expect(live(s, 'Drafts').length).toBe(0);
      expect(s.folder('Sent').length).toBe(1);
    });
  }

  it('claim answer arrives after the deadline: timeout, then the same id sends once', async () => {
    const { s, draft, a } = await setup(kopts);
    const id = await draft();
    const { px, a: via } = await viaImap(s, a);
    Object.assign(px.fault, { after: claimCmd, mode: 'hold', holdMs: 1200 });
    const client = createMailClient({ timeoutMs: 600 });
    expect(await code(client.sendDraft(via, PASS, id))).toBe('timeout');
    await wait(1200);
    await expectClean(s, a);
    await client.sendDraft(a, PASS, id);
    expect(s.sent.length).toBe(1);
  });

  for (const mode of ['drop', 'hold'] as const) it(`a 5xx refusal is reported as refusal even when the clean-up ${mode === 'drop' ? 'connection drops' : 'answer comes after the deadline'}`, async () => {
    const { s, a, draft } = await setup({ ...kopts, smtpMode: 'reject-after-data' });
    const client = createMailClient({ timeoutMs: 800 });
    const id = await draft();
    const { px, a: via } = await viaImap(s, a);
    // the first clean-up command (also matches the put-back of the round-2 engine)
    Object.assign(px.fault, { after: /SEARCH (KEYWORD|HEADER)|UID MOVE \d+ "?Drafts|-FLAGS \(\$mcpsending/i, mode, holdMs: 1500 });
    const e = await err(client.sendDraft(via, PASS, id));
    expect(e.code).toBe('rejected');
    expect(e.message).toContain('content policy');
    await wait(1500);
    await expectClean(s, a);
    s.state.smtpMode = 'ok';
    await client.sendDraft(a, PASS, id);
    expect(s.sent.length).toBe(1);
  });

  if (hold) it('a MOVE answer without COPYUID is settled by looking in our own folder, and the draft is sent', async () => {
    const { s, client, a, draft } = await setup(kopts);
    const id = await draft();
    const { px, a: via } = await viaImap(s, a);
    px.fault.stripCopyuid = true;
    const r = await client.sendDraft(via, PASS, id);
    expect(r.warning).toBeUndefined();
    expect(s.sent.length).toBe(1);
    expect(s.folder('Drafts').length).toBe(0);
    expect(s.folder('Sent').length).toBe(1);
    expect((await folderNames(a)).filter((f) => f.startsWith('MCP'))).toEqual([]);
  });
});

describe('SMTP stages', () => {
  for (const [stage, re] of [['MAIL FROM', /^MAIL FROM/im], ['RCPT TO (pipelined with DATA)', /^RCPT TO/im]] as const) {
    it(`a drop at ${stage} is a definite failure, and the same id then sends once from another process`, async () => {
      const { s, client, a, draft, drafts } = await setup();
      const id = await draft();
      const { px, a: via } = await viaSmtp(s, a);
      Object.assign(px.fault, { after: re, mode: 'drop' });
      const e = await err(client.sendDraft(via, PASS, id));
      expect(e.code).toBe('unreachable');
      expect(e.message).toContain('sending server');
      expect(drafts()[0].flags.filter(isMcp)).toEqual([]);
      await createMailClient({ timeoutMs: 3000 }).sendDraft(a, PASS, id);
      expect(s.sent.length).toBe(1);
    });
  }

  it('a drop after 354 is send_unconfirmed: named folders, draft kept and marked, never resent blindly', async () => {
    const { s, client, a, draft, drafts } = await setup();
    const id = await draft();
    const { px, a: via } = await viaSmtp(s, a);
    Object.assign(px.fault, { after: /\r\n\.\r\n/, mode: 'drop' }); // the message went out, the final reply never came
    const e = await err(client.sendDraft(via, PASS, id));
    expect(e.code).toBe('send_unconfirmed');
    expect(e.message).toContain('may have been sent');
    expect(e.message).toContain('kept in "Drafts"');
    expect(e.message).toContain('Check "Sent"');
    await wait(300);
    expect(drafts().length).toBe(1);
    expect(drafts()[0].flags).toContain('$mcpunconfirmed');
    expect(drafts()[0].flags).toContain('\\Draft');
    for (const c of [client, createMailClient()]) {
      const again = await err(c.sendDraft(a, PASS, id));
      expect(again.code).toBe('send_unconfirmed');
      expect(again.message).toContain('An earlier or parallel send of this draft got to the point where it may go through');
    }
    expect(s.smtpTotal()).toBe(1);
  });

  it('a failed copy to Sent returns sent with a warning naming where the draft is; it cannot be resent', async () => {
    const { s, client, a, draft, drafts } = await setup();
    const id = await draft();
    const { px, a: via } = await viaImap(s, a);
    Object.assign(px.fault, { after: /APPEND/i, mode: 'drop' });
    const r = await client.sendDraft(via, PASS, id);
    expect(r.warning).toBe('It was sent, but no copy could be saved in "Sent"; the only copy is the draft in "Drafts", marked as sent.');
    expect(drafts()[0].flags).toContain('$mcpsent');
    expect(await code(createMailClient().sendDraft(a, PASS, id))).toBe('not_found');
    expect(s.sent.length).toBe(1);
  });
});

describe('4 processes racing on one draft', () => {
  const engine = fileURLToPath(new URL('../../node_modules/.cache/mail-engine-race.mjs', import.meta.url));
  const child = fileURLToPath(new URL('./race-child.mjs', import.meta.url));
  beforeAll(async () => {
    await build({ input: fileURLToPath(new URL('../../src/mail/index.ts', import.meta.url)), platform: 'node', logLevel: 'silent',
      external: (id) => !id.startsWith('.') && !id.startsWith('/'), output: { file: engine, format: 'esm' }, write: true });
  }, 60_000);
  afterAll(() => fs.rmSync(engine, { force: true }));

  for (const [kind, opts] of [['keyword claim', {}], ['holding folder', { noKeywords: true }]] as const) {
    it(`${kind}: exactly one delivery in each of 15 rounds; losers hear busy or already sent`, async () => {
      const codes: Record<string, number> = {};
      for (let round = 0; round < 15; round++) {
        srv = await startServers([], opts);
        const a = srv.account({ allowSend: true });
        const id = (await createMailClient().createDraft(a, PASS, { to: ['bob@example.org'], subject: `race ${round}`, text: 't' })).draftId;
        const arg = JSON.stringify({ account: a, creds: PASS, id, startAt: Date.now() + 1000 });
        const outs = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, [child, engine, arg]).then((r) => JSON.parse(r.stdout))));
        expect(srv.sent.length).toBe(1);
        expect(outs.filter((o) => o.ok).length).toBe(1);
        for (const o of outs.filter((x) => !x.ok)) {
          codes[o.code] = (codes[o.code] ?? 0) + 1;
          if (o.code === 'timeout') expect(o.message).toContain('still marked as in progress');
          else if (o.code === 'send_unconfirmed') expect(o.message).toContain('may have been sent'); // the winner's write-ahead mark
          else { expect(o.code).toBe('not_found'); expect(o.message).toContain('already sent'); }
        }
        expect(srv.folder('Drafts').length).toBe(0);
        expect(srv.folder('Sent').length).toBe(1);
        expect((await folderNames(a)).filter((f) => f.startsWith('MCP'))).toEqual([]);
        await srv.close(); srv = undefined;
      }
      expect(Object.values(codes).reduce((x, y) => x + y, 0)).toBe(45);
    }, 120_000);
  }
});

describe('claims left behind', () => {
  const ts = (msAgo: number) => (Date.now() - msAgo).toString(36);

  it('a stale claim from a dead process is cleared once this process has seen it past the window, and the draft sends', async () => {
    const { s, client, a, plantedId } = await setup({ drafts: [{ uid: 1, raw: mine(), flags: ['\\Draft', `$mcpclaim.${ts(3_600_000)}.deadbeef`] }] });
    expect(await code(client.sendDraft(a, PASS, plantedId(1)))).toBe('timeout');
    vi.spyOn(Date, 'now').mockImplementation(() => REAL_NOW() + 11 * 60_000);
    await client.sendDraft(a, PASS, plantedId(1));
    expect(s.sent.length).toBe(1);
  });

  it('a fresh claim from another process is "busy", not "sent", and leaves the draft as it was', async () => {
    const flag = `$mcpclaim.${ts(1000)}.deadbeef`;
    const { s, client, a, plantedId, drafts } = await setup({ drafts: [{ uid: 1, raw: mine(), flags: ['\\Draft', flag] }] });
    const e = await err(client.sendDraft(a, PASS, plantedId(1)));
    expect(e.code).toBe('timeout');
    expect(e.message).toBe('Test Mail: an earlier attempt to send that draft is still marked as in progress (the draft is in "Drafts"). Check "Sent" first; if it is not there, try again in about 10 minutes.');
    expect(s.sent.length).toBe(0);
    expect(drafts()[0].flags.filter(isMcp)).toEqual([flag]);
  });

  it('a stale holding folder (server without keywords) is emptied back into Drafts', async () => {
    const old = `MCP Sending ${ts(3_600_000)} deadbeef`;
    srv = await startServers([], { noKeywords: true, folders: {
      Drafts: { 'special-use': '\\Drafts' }, Sent: { 'special-use': '\\Sent' },
      [old]: { messages: [{ raw: Buffer.from(mine('', 'stranded@example.org')), flags: ['\\Draft'] }] },
    } });
    const client = createMailClient({ timeoutMs: 3000 });
    const a = srv.account({ allowSend: true });
    const send = async () => client.sendDraft(a, PASS, (await client.createDraft(a, PASS, { to: ['bob@example.org'], subject: 's', text: 't' })).draftId);
    await send(); // first sight of the folder: left alone
    expect(srv.folder('Drafts').length).toBe(0);
    vi.spyOn(Date, 'now').mockImplementation(() => REAL_NOW() + 11 * 60_000);
    await send();
    expect(srv.sent.map((m) => m.to)).toEqual([['bob@example.org'], ['bob@example.org']]);
    expect(srv.folder('Drafts').map((m) => /stranded@/.test(m.raw))).toEqual([true]);
    expect((await folderNames(a)).filter((f) => f.startsWith('MCP'))).toEqual([]);
  });
});

// An SMTP server that refuses some recipients at RCPT.
async function rcptRefusing(refuse: string[]) {
  const got: string[][] = [];
  const s = new SMTPServer({ disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authMethods: ['PLAIN', 'LOGIN'], logger: false,
    onAuth(_a, _s, done) { done(null, { user: 'x' }); },
    onRcptTo(addr, _s, done) { done(refuse.includes(addr.address) ? Object.assign(new Error('No such user'), { responseCode: 550 }) : undefined); },
    onData(stream, session, done) { stream.resume(); stream.on('end', () => { got.push(session.envelope.rcptTo.map((r) => r.address)); done(); }); },
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>((r) => s.close(() => r())));
  return { port: (s.server.address() as net.AddressInfo).port, got };
}

describe('recipients', () => {
  it('a recipient refused at RCPT: sent, with a warning listing who did not get it', async () => {
    const { s, client, a } = await setup();
    const rs = await rcptRefusing(['nobody@example.org']);
    const via = { ...a, smtp: { ...a.smtp, port: rs.port } };
    const { draftId } = await client.createDraft(a, PASS, { to: ['bob@example.org', 'nobody@example.org'], subject: 's', text: 't' });
    const r = await client.sendDraft(via, PASS, draftId);
    expect(r.warning).toBe('The sending server refused these recipients, so they did not get it: nobody@example.org.');
    expect(rs.got).toEqual([['bob@example.org']]);
    expect(s.folder('Drafts').length).toBe(0);
  });

  it('all recipients refused: rejected, and the draft is back to normal', async () => {
    const { s, client, a } = await setup();
    const rs = await rcptRefusing(['nobody@example.org']);
    const { draftId } = await client.createDraft(a, PASS, { to: ['nobody@example.org'], subject: 's', text: 't' });
    expect(await code(client.sendDraft({ ...a, smtp: { ...a.smtp, port: rs.port } }, PASS, draftId))).toBe('rejected');
    expect(s.folder('Drafts').length).toBe(1);
    expect(s.folder('Drafts')[0].flags.filter(isMcp)).toEqual([]);
  });

  it('group syntax in a draft from another app delivers to every member and keeps Bcc members hidden', async () => {
    const { s, client, a, plantedId } = await setup({ drafts: [
      { uid: 1, raw: mine('Bcc: hidden: three@example.net, four@example.net;\r\n', 'friends: one@example.net, two@example.net;'), flags: ['\\Draft'] },
      { uid: 2, raw: mine('Bcc: five@example.net\r\n', 'undisclosed-recipients:;'), flags: ['\\Draft'] },
    ] });
    await client.sendDraft(a, PASS, plantedId(1));
    await client.sendDraft(a, PASS, plantedId(2));
    expect(s.sent[0].to.sort()).toEqual(['four@example.net', 'one@example.net', 'three@example.net', 'two@example.net']);
    expect(s.sent[0].raw).not.toMatch(/three@|four@/);
    expect(s.sent[1].to).toEqual(['five@example.net']);
  });

  it('createDraft refuses group syntax rather than dropping members', async () => {
    const { client, a } = await setup();
    for (const field of ['to', 'cc', 'bcc']) {
      expect(await code(client.createDraft(a, PASS, { to: ['bob@example.org'], [field]: ['team: a@example.org, b@example.org;'], subject: 's', text: 't' }))).toBe('invalid_input');
    }
  });
});

describe('Bcc variants are stripped and delivered', () => {
  const cases: [string, string, string[]][] = [
    ['space before the colon', 'Bcc : one@example.net\r\n', ['one@example.net']],
    ['tab before the colon, lower case, folded with a tab', 'bcc\t: one@example.net,\r\n\ttwo@example.net\r\n', ['one@example.net', 'two@example.net']],
    ['Resent-Bcc', 'Resent-Bcc: one@example.net\r\n', []],
    ['RESENT-BCC folded', 'RESENT-BCC : one@example.net,\r\n two@example.net\r\n', []],
  ];
  for (const [name, extra, bcc] of cases) {
    it(name, async () => {
      const { s, client, a, plantedId } = await setup({ drafts: [{ uid: 1, raw: mine(extra), flags: ['\\Draft'] }] });
      await client.sendDraft(a, PASS, plantedId(1));
      expect(s.sent[0].to.sort()).toEqual(['bob@example.org', ...bcc].sort());
      expect(header(s.sent[0].raw)).not.toMatch(/bcc/i);
      expect(s.sent[0].raw).not.toMatch(/one@|two@/);
      expect(s.sent[0].raw).toMatch(/body text/);
    });
  }
});

describe('search and read edge cases', () => {
  const deep = (d: number) => {
    let s = 'Content-Type: text/plain\r\n\r\nDeep.';
    for (let i = d; i > 0; i--) s = `Content-Type: multipart/mixed; boundary="n${i}"\r\n\r\n--n${i}\r\n${s}\r\n--n${i}--`;
    return `From: a@example.org\r\nTo: me@example.com\r\nSubject: Deep ${d}\r\nMIME-Version: 1.0\r\n${s}`;
  };

  it('ESEARCH PARTIAL with no matches returns an empty list', async () => {
    srv = await startServers([{ raw: mail({ subject: 'one' }), flags: ['\\Seen'] }], { plugins: ['ESEARCH', 'PARTIAL'] });
    const client = createMailClient({ timeoutMs: 3000 });
    expect(await client.search(srv.account(), PASS, { query: 'nomatchxyz' })).toEqual([]);
    expect(await client.search(srv.account(), PASS, { unreadOnly: true })).toEqual([]);
    expect(srv.imapLog.some((l) => /RETURN \(PARTIAL/.test(l))).toBe(true);
  });

  it('a 5,000-level MIME message does not break the folder listing, and reads as empty and truncated', async () => {
    srv = await startServers([{ raw: mail({ subject: 'normal 1' }, 'first') }, { raw: deep(5000) }, { raw: deep(1000) }, { raw: mail({ subject: 'normal 4' }, 'fourth') }]);
    const client = createMailClient({ timeoutMs: 5000 });
    const list = await client.search(srv.account(), PASS, {});
    expect(list.map((m) => m.subject)).toEqual(['normal 4', 'Deep 1000', 'Deep 5000', 'normal 1']);
    expect(list[0].snippet).toBe('fourth');
    expect(list[3].snippet).toBe('first');
    for (const uid of [2, 3]) {
      const m = await client.read(srv.account(), PASS, enc(['INBOX', '7', uid]));
      expect(m.truncated).toBe(true);
      expect(m.text).toBe('');
    }
    expect((await client.read(srv.account(), PASS, enc(['INBOX', '7', 4]))).text).toBe('fourth');
  }, 20_000);

  it('read shows Bcc for drafts only', async () => {
    const { client, a } = await setup();
    const { draftId } = await client.createDraft(a, PASS, { to: ['bob@example.org'], bcc: ['Boss <boss@example.net>'], subject: 'b', text: 't' });
    expect((await client.read(a, PASS, draftId)).bcc).toEqual(['Boss <boss@example.net>']);
    expect((await client.read(a, PASS, enc(['INBOX', '7', 1]))).bcc).toBeUndefined();
  });
});
