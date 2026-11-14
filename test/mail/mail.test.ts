import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { createMailClient } from '../../src/mail/index.js';
import { AccountError } from '../../src/types.js';
import { PASS, TOKEN, deadPort, mail, silentServer, startServers, type Planted, type Servers } from './servers.js';

// A fresh client per test: its send-once memory must not carry over between test servers.
let client = createMailClient({ timeoutMs: 5000 });
let srv: Servers | undefined;
beforeEach(() => { client = createMailClient({ timeoutMs: 5000 }); });
afterEach(async () => { await srv?.close(); srv = undefined; });

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AccountError); return (e as AccountError).code; }
  return 'no error';
}
async function err(p: Promise<unknown>): Promise<AccountError> {
  try { await p; } catch (e) { return e as AccountError; }
  throw new Error('expected an error');
}

const BASIC: Planted[] = [
  { uid: 1, raw: mail({ subject: 'Invoice 42', from: 'Billing <billing@shop.example>', date: 'Mon, 02 Nov 2026 09:00:00 +0000' }, 'Your invoice is attached.'), flags: ['\\Seen'], internaldate: '2026-11-02T09:00:00Z' },
  { uid: 2, raw: mail({ subject: 'Lunch?', from: 'Bob <bob@example.org>', date: 'Wed, 04 Nov 2026 12:00:00 +0000' }, 'Want to grab lunch tomorrow?'), internaldate: '2026-11-04T12:00:00Z' },
  { uid: 3, raw: mail({ subject: 'Project update', from: 'Alice <alice@example.org>', date: 'Sat, 07 Nov 2026 08:00:00 +0000' }, 'The pineapple milestone is done.'), flags: ['\\Seen'], internaldate: '2026-11-07T08:00:00Z' },
  { uid: 4, raw: mail({ subject: 'Re: Lunch?', from: 'Bob <bob@example.org>', date: 'Tue, 10 Nov 2026 10:00:00 +0000', messageId: '<lunch-4@example.org>', extra: 'References: <lunch-1@example.org>\r\nContent-Type: text/plain; charset=utf-8' }, 'Noon works.'), internaldate: '2026-11-10T10:00:00Z' },
];

describe('search', () => {
  it('returns most recent first with no query, tagged with the account', async () => {
    srv = await startServers(BASIC);
    const r = await client.search(srv.account(), PASS, {});
    expect(r.map((m) => m.subject)).toEqual(['Re: Lunch?', 'Project update', 'Lunch?', 'Invoice 42']);
    expect(r[0]).toMatchObject({ accountId: 'test', folder: 'INBOX', from: 'Bob <bob@example.org>', to: ['me@example.com'], unread: true, snippet: 'Noon works.', date: '2026-11-10T10:00:00.000Z' });
    expect(r[1].unread).toBe(false);
  });

  it('filters by query in subject, from and body', async () => {
    srv = await startServers(BASIC);
    const a = srv.account();
    expect((await client.search(a, PASS, { query: 'invoice' })).map((m) => m.subject)).toEqual(['Invoice 42']);
    expect((await client.search(a, PASS, { query: 'alice' })).map((m) => m.subject)).toEqual(['Project update']);
    expect((await client.search(a, PASS, { query: 'pineapple' })).map((m) => m.subject)).toEqual(['Project update']);
    expect(await client.search(a, PASS, { query: 'nothing-matches-this' })).toEqual([]);
  });

  it('filters by from, since, before, unreadOnly and limit', async () => {
    srv = await startServers(BASIC);
    const a = srv.account();
    expect((await client.search(a, PASS, { from: 'bob@example.org' })).length).toBe(2);
    expect((await client.search(a, PASS, { since: '2026-11-05' })).map((m) => m.subject)).toEqual(['Re: Lunch?', 'Project update']);
    expect((await client.search(a, PASS, { before: '2026-11-05' })).map((m) => m.subject)).toEqual(['Lunch?', 'Invoice 42']);
    expect((await client.search(a, PASS, { unreadOnly: true })).map((m) => m.subject)).toEqual(['Re: Lunch?', 'Lunch?']);
    expect((await client.search(a, PASS, { limit: 1 })).map((m) => m.subject)).toEqual(['Re: Lunch?']);
    expect(await code(client.search(a, PASS, { since: 'last tuesday-ish' }))).toBe('invalid_input');
  });

  it('caps limit at 50 and searches another folder', async () => {
    srv = await startServers(Array.from({ length: 70 }, (_, i) => ({ raw: mail({ subject: `M${i}` }) })));
    expect((await client.search(srv.account(), PASS, { limit: 500 })).length).toBe(50);
    expect(await client.search(srv.account(), PASS, { folder: 'Sent' })).toEqual([]);
    expect(await code(client.search(srv.account(), PASS, { folder: 'No Such Folder' }))).toBe('not_found');
  });

  it('handles a 5,000 message inbox quickly and only fetches the page', async () => {
    srv = await startServers(Array.from({ length: 5000 }, (_, i) => ({ raw: mail({ subject: `Message ${i + 1}` }, `Body ${i + 1} `.repeat(50)) })));
    const t = Date.now();
    const r = await client.search(srv.account(), PASS, {});
    expect(Date.now() - t).toBeLessThan(3000);
    expect(r.length).toBe(20);
    expect(r[0].subject).toBe('Message 5000');
    expect(r[19].subject).toBe('Message 4981');
    // one metadata FETCH for the page, one FETCH of the first 2 KB of each text part; never the whole source
    const fetches = srv.imapLog.filter((l) => / FETCH /i.test(l));
    expect(fetches.length).toBe(2);
    for (const f of fetches) expect(f.match(/FETCH ([\d,:]+)/i)![1].split(',').length).toBe(20);
    expect(fetches[1]).toMatch(/BODY\.PEEK\[TEXT\]<0\.2048>/i);
    expect(fetches.join('')).not.toMatch(/BODY\.PEEK\[\]/i);
    // the search itself is a UID window at the top of the mailbox, not every message
    const searches = srv.imapLog.filter((l) => / SEARCH /i.test(l));
    expect(searches).toEqual([expect.stringMatching(/UID 4501:5000/)]);
    expect(r[0].snippet).toMatch(/^Body 5000 /);
  });

  it('uses X-GM-RAW for Gmail when advertised', async () => {
    srv = await startServers(BASIC, { gmail: true });
    // "subject:" is Gmail syntax; a plain TEXT search for it would find nothing.
    const r = await client.search(srv.account(), PASS, { query: 'subject:invoice' });
    expect(r.map((m) => m.subject)).toEqual(['Invoice 42']);
    expect(srv.imapLog.some((l) => /X-GM-RAW/i.test(l))).toBe(true);
    // non-Gmail account on the same server does not use it
    await client.search(srv.account({ provider: 'imap' }), PASS, { query: 'invoice' });
    expect(srv.imapLog.filter((l) => /X-GM-RAW/i.test(l)).length).toBe(1);
  });

  it('does not mark anything read', async () => {
    srv = await startServers(BASIC);
    await client.search(srv.account(), PASS, {});
    expect(srv.folder('INBOX').find((m) => m.uid === 2)!.flags).not.toContain('\\Seen');
  });
});

const ODD: Planted[] = [
  { uid: 1, raw: mail({ subject: '=?UTF-8?B?Q2Fmw6kg4piVIOaXpeacrA==?=' }, 'Plain utf-8 body: naïve café') },
  { uid: 2, raw: mail({ subject: 'QP', extra: 'Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable' }, 'Gr=FC=DFe aus K=F6ln, a soft=\r\n break.') },
  { uid: 3, raw: mail({ subject: 'B64', extra: 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64' }, Buffer.from('Base64 body with emoji 🎉').toString('base64')) },
  { uid: 4, raw: mail({ subject: 'HTML only', extra: 'Content-Type: text/html; charset=utf-8' }, '<html><body><h1>Big news</h1><p>Hello <b>world</b> &amp; friends</p><script>x()</script></body></html>') },
  { uid: 5, raw: mail({ subject: null, from: null }, 'No subject, no sender.') },
  {
    uid: 6,
    raw: mail({ subject: 'With attachment', extra: 'Content-Type: multipart/mixed; boundary="b1"' },
      ['--b1', 'Content-Type: text/plain; charset=utf-8', '', 'See the attached report.', '--b1',
        'Content-Type: application/pdf; name="report.pdf"', 'Content-Disposition: attachment; filename="report.pdf"', 'Content-Transfer-Encoding: base64', '',
        Buffer.alloc(3000, 1).toString('base64'), '--b1--', ''].join('\r\n')),
  },
  { uid: 7, raw: mail({ subject: 'Long' }, 'abcdefghij'.repeat(5000)) },
];

describe('read', () => {
  async function readUid(uid: number, maxChars?: number) {
    const list = await client.search(srv!.account(), PASS, { limit: 50 });
    const id = list.find((m) => Buffer.from(m.id, 'base64url').toString().endsWith(`,${uid}]`))!.id;
    return client.read(srv!.account(), PASS, id, maxChars);
  }

  it('decodes UTF-8 subjects, quoted-printable, base64 and HTML-only bodies', async () => {
    srv = await startServers(ODD);
    expect((await readUid(1)).subject).toBe('Café ☕ 日本');
    expect((await readUid(1)).text).toContain('naïve café');
    expect((await readUid(2)).text).toContain('Grüße aus Köln, a soft break.');
    expect((await readUid(3)).text).toBe('Base64 body with emoji 🎉');
    const html = await readUid(4);
    expect(html.text).toMatch(/BIG NEWS|Big news/);
    expect(html.text).toContain('Hello world & friends');
    expect(html.text).not.toContain('<');
    expect(html.snippet).toContain('Hello world');
  });

  it('copes with no subject and no from', async () => {
    srv = await startServers(ODD);
    const m = await readUid(5);
    expect(m).toMatchObject({ subject: '', from: '', text: 'No subject, no sender.' });
  });

  it('lists attachments as metadata only', async () => {
    srv = await startServers(ODD);
    const m = await readUid(6);
    expect(m.hasAttachments).toBe(true);
    expect(m.attachments).toEqual([{ filename: 'report.pdf', contentType: 'application/pdf', size: expect.any(Number) }]);
    expect(Math.abs(m.attachments[0].size - 3000)).toBeLessThan(10);
    expect(m.text).toBe('See the attached report.');
    expect(JSON.stringify(m)).not.toContain('AQEB'); // no attachment bytes
  });

  it('caps the body at maxChars and flags truncated', async () => {
    srv = await startServers(ODD);
    const full = await readUid(7);
    expect(full.text.length).toBe(20000);
    expect(full.truncated).toBe(true);
    const small = await readUid(7, 100);
    expect(small.text.length).toBe(100);
    expect(small.truncated).toBe(true);
    expect((await readUid(1)).truncated).toBe(false);
  });

  it('does not set \\Seen and returns cc and Message-ID', async () => {
    srv = await startServers(BASIC);
    const id = (await client.search(srv.account(), PASS, { unreadOnly: true }))[0].id;
    const m = await client.read(srv.account(), PASS, id);
    expect(m.messageIdHeader).toBe('<lunch-4@example.org>');
    expect(m.unread).toBe(true);
    expect(srv.folder('INBOX').find((x) => x.uid === 4)!.flags).not.toContain('\\Seen');
    expect(srv.imapLog.some((l) => /BODY\[/i.test(l) && !/PEEK/i.test(l))).toBe(false);
  });

  it('rejects malformed ids and reports stale ids as not_found', async () => {
    srv = await startServers(BASIC);
    const a = srv.account();
    for (const bad of ['', 'garbage', '!!!', Buffer.from('[1,2]').toString('base64url'), Buffer.from('["INBOX","7",-1]').toString('base64url'), 'x'.repeat(5000)]) {
      expect(await code(client.read(a, PASS, bad))).toBe('invalid_input');
    }
    expect(await code(client.read(a, PASS, 42 as unknown as string))).toBe('invalid_input');
    const enc = (v: unknown[]) => Buffer.from(JSON.stringify(v)).toString('base64url');
    expect(await code(client.read(a, PASS, enc(['INBOX', '7', 999])))).toBe('not_found'); // missing uid
    expect(await code(client.read(a, PASS, enc(['INBOX', '8', 1])))).toBe('not_found'); // UIDVALIDITY changed
    expect(await code(client.read(a, PASS, enc(['Gone', '7', 1])))).toBe('not_found'); // folder deleted
  });
});

describe('drafts', () => {
  it('creates a MIME draft in the Drafts folder', async () => {
    srv = await startServers(BASIC);
    const { draftId } = await client.createDraft(srv.account(), PASS, { to: ['bob@example.org'], cc: ['carol@example.org'], subject: 'Plans ✈', text: 'See you at noon.' });
    const drafts = srv.folder('Drafts');
    expect(drafts.length).toBe(1);
    expect(drafts[0].flags).toContain('\\Draft');
    const p = await simpleParser(Buffer.from(drafts[0].raw, 'binary'));
    expect(p.from?.text).toBe('me@example.com');
    expect(p.subject).toBe('Plans ✈');
    expect(p.text?.trim()).toBe('See you at noon.');
    expect(p.messageId).toMatch(/^<.+>$/);
    expect(p.inReplyTo).toBeUndefined();
    const read = await client.read(srv.account(), PASS, draftId);
    expect(read).toMatchObject({ folder: 'Drafts', subject: 'Plans ✈', cc: ['carol@example.org'] });
  });

  it('sets reply threading headers and a Re: subject', async () => {
    srv = await startServers(BASIC);
    const orig = (await client.search(srv.account(), PASS, { query: 'Noon works' }))[0];
    await client.createDraft(srv.account(), PASS, { to: ['bob@example.org'], subject: '', text: 'Great.', inReplyToId: orig.id });
    const lunch = (await client.search(srv.account(), PASS, { query: 'grab lunch' }))[0];
    await client.createDraft(srv.account(), PASS, { to: ['bob@example.org'], subject: 'About lunch', text: 'Yes.', inReplyToId: lunch.id });
    const [a, b] = await Promise.all(srv.folder('Drafts').map((d) => simpleParser(Buffer.from(d.raw, 'binary'))));
    expect(a.subject).toBe('Re: Lunch?'); // already "Re:", not doubled
    expect(a.inReplyTo).toBe('<lunch-4@example.org>');
    expect(a.references).toEqual(['<lunch-1@example.org>', '<lunch-4@example.org>']);
    expect(b.subject).toBe('Re: About lunch');
    expect(b.inReplyTo).toMatch(/^<.+>$/);
  });

  it('finds Gmail drafts by special-use and creates Drafts when missing', async () => {
    srv = await startServers(BASIC, { gmail: true });
    await client.createDraft(srv.account(), PASS, { to: ['bob@example.org'], subject: 'x', text: 'y' });
    expect(srv.folder('[Gmail]/Drafts').length).toBe(1);
    await srv.close();
    srv = await startServers(BASIC, { noDrafts: true });
    await client.createDraft(srv.account(), PASS, { to: ['bob@example.org'], subject: 'x', text: 'y' });
    expect(srv.folder('Drafts').length).toBe(1);
  });

  it('rejects header injection, bad addresses and huge bodies', async () => {
    srv = await startServers(BASIC);
    const a = srv.account();
    const base = { to: ['bob@example.org'], subject: 'ok', text: 'ok' };
    const cases = [
      { ...base, subject: 'Hi\r\nBcc: victim@example.org' },
      { ...base, subject: 'Hi\nX-Evil: 1' },
      { ...base, to: ['bob@example.org\r\nBcc: victim@example.org'] },
      { ...base, cc: ['carol@example.org\nX: y'] },
      { ...base, to: ['not an address'] },
      { ...base, to: ['a@b'] },
      { ...base, to: ['Bob <bob@example.org>, eve@example.org'] },
      { ...base, to: [] },
      { ...base, text: 'x'.repeat(1024 * 1024 + 1) },
      { ...base, inReplyToId: 'nope' },
    ];
    for (const c of cases) expect(await code(client.createDraft(a, PASS, c))).toBe('invalid_input');
    expect(srv.folder('Drafts').length).toBe(0);
  });
});

describe('send', () => {
  async function draft(s: Servers, patch = {}) {
    return (await client.createDraft(s.account(patch), PASS, { to: ['bob@example.org'], cc: ['carol@example.org'], subject: 'Go', text: 'Sending this.' })).draftId;
  }

  it('refuses when sending is off, without touching the network', async () => {
    srv = await startServers(BASIC);
    const id = await draft(srv);
    const before = srv.imapLog.length;
    expect(await code(client.sendDraft(srv.account(), PASS, id))).toBe('send_disabled');
    expect(srv.imapLog.length).toBe(before);
    expect(srv.sent.length).toBe(0);
    expect(srv.folder('Drafts').length).toBe(1);
  });

  it('sends once, removes the draft, files it in Sent, and refuses a second send', async () => {
    srv = await startServers(BASIC);
    const a = srv.account({ allowSend: true });
    const id = await draft(srv);
    const r = await client.sendDraft(a, PASS, id);
    expect(r.sent).toBe(true);
    expect(r.messageIdHeader).toMatch(/^<.+>$/);
    expect(srv.sent.length).toBe(1);
    expect(srv.sent[0].from).toBe('me@example.com');
    expect(srv.sent[0].to.sort()).toEqual(['bob@example.org', 'carol@example.org']);
    expect(srv.sent[0].raw).toContain('Sending this.');
    expect(srv.folder('Drafts').length).toBe(0);
    expect(srv.folder('Sent').length).toBe(1);
    expect(await code(client.sendDraft(a, PASS, id))).toBe('not_found');
    // a fresh client (new process) also cannot resend it
    expect(await code(createMailClient().sendDraft(a, PASS, id))).toBe('not_found');
    expect(srv.sent.length).toBe(1);
  });

  it('sends only once when called twice at the same time', async () => {
    srv = await startServers(BASIC);
    const a = srv.account({ allowSend: true });
    const id = await draft(srv);
    const results = await Promise.allSettled([client.sendDraft(a, PASS, id), client.sendDraft(a, PASS, id)]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(srv.sent.length).toBe(1);
  });

  it('does not append to Sent for Gmail', async () => {
    srv = await startServers(BASIC, { gmail: true });
    const a = srv.account({ allowSend: true });
    await client.sendDraft(a, PASS, await draft(srv));
    expect(srv.sent.length).toBe(1);
    expect(srv.folder('[Gmail]/Drafts').length).toBe(0);
    expect(srv.folder('[Gmail]/Sent Mail').length).toBe(0);
  });

  it('keeps the draft and allows a retry when SMTP fails', async () => {
    srv = await startServers(BASIC);
    const id = await draft(srv);
    const down = srv.account({ allowSend: true, smtp: { host: '127.0.0.1', port: await deadPort(), secure: false } });
    expect(await code(client.sendDraft(down, PASS, id))).toBe('unreachable');
    expect(srv.folder('Drafts').length).toBe(1);
    await client.sendDraft(srv.account({ allowSend: true }), PASS, id);
    expect(srv.sent.length).toBe(1);
  });
});

describe('login and errors', () => {
  it('verifies with a password and with XOAUTH2 on IMAP and SMTP', async () => {
    srv = await startServers(BASIC);
    await client.verify(srv.account({ allowSend: true }), PASS);
    await client.verify(srv.account({ allowSend: true, auth: 'oauth' }), TOKEN);
    expect(srv.imapLog.some((l) => /AUTHENTICATE XOAUTH2/i.test(l))).toBe(true);
    // XOAUTH2 also works for real operations, including SMTP send
    const a = srv.account({ allowSend: true, auth: 'oauth' });
    const { draftId } = await client.createDraft(a, TOKEN, { to: ['bob@example.org'], subject: 's', text: 't' });
    await client.sendDraft(a, TOKEN, draftId);
    expect(srv.sent.length).toBe(1);
  });

  it('maps a bad password or token to auth_failed without leaking secrets', async () => {
    srv = await startServers(BASIC);
    const e = await err(client.search(srv.account(), { user: 'testuser', pass: 'hunter2-secret' }, {}));
    expect(e.code).toBe('auth_failed');
    expect(e.message).toContain('Test Mail');
    expect(e.message).not.toContain('hunter2');
    expect(e.accountId).toBe('test');
    expect(await code(client.verify(srv.account(), { user: 'testuser', accessToken: 'expired-token' }))).toBe('auth_failed');
    // IMAP fine, SMTP password wrong
    const smtpBad = await err(client.verify(srv.account({ allowSend: true, smtp: { host: '127.0.0.1', port: srv.smtpPort, secure: false } }), { user: 'testuser', pass: 'testpass ' }));
    expect(smtpBad.code).toBe('auth_failed');
  });

  it('maps a down server, DNS failure and TLS mismatch to unreachable', async () => {
    srv = await startServers(BASIC);
    const port = await deadPort();
    expect(await code(client.verify(srv.account({ imap: { host: '127.0.0.1', port, secure: false } }), PASS))).toBe('unreachable');
    expect(await code(client.verify(srv.account({ imap: { host: 'no-such-host.invalid', port: 993, secure: true } }), PASS))).toBe('unreachable');
    expect(await code(client.verify(srv.account({ imap: { host: '127.0.0.1', port: srv.imapPort, secure: true } }), PASS))).toBe('unreachable');
    expect(await code(client.verify(srv.account({ allowSend: true, smtp: { host: '127.0.0.1', port, secure: false } }), PASS))).toBe('unreachable');
  });

  it('times out on a server that never answers', async () => {
    const silent = await silentServer();
    try {
      const fast = createMailClient({ timeoutMs: 300 });
      srv = await startServers(BASIC);
      const t = Date.now();
      const e = await err(fast.search(srv.account({ imap: { host: '127.0.0.1', port: silent.port, secure: false } }), PASS, {}));
      expect(e.code).toBe('timeout');
      expect(e.message).toContain('Test Mail');
      expect(Date.now() - t).toBeLessThan(2000);
      expect(await code(fast.verify(srv.account({ allowSend: true, smtp: { host: '127.0.0.1', port: silent.port, secure: false } }), PASS))).toBe('timeout');
    } finally {
      await silent.close();
    }
  });
});
