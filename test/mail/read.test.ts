// search/read hardening: bounded newest-first search, snippets, odd MIME, truncation, HTML, reply headers, errors.
import { afterEach, describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { createMailClient } from '../../src/mail/index.js';
import { AccountError } from '../../src/types.js';
import { PASS, mail, startServers, type Planted, type Servers } from './servers.js';

let srv: Servers | undefined;
const client = createMailClient({ timeoutMs: 5000 });
afterEach(async () => { await srv?.close(); srv = undefined; });

async function err(p: Promise<unknown>): Promise<AccountError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AccountError); return e as AccountError; }
  throw new Error('expected an error');
}
const id = (uid: number, folder = 'INBOX', v = '7') => Buffer.from(JSON.stringify([folder, v, uid])).toString('base64url');
const big = (n: number, extra?: (i: number) => Partial<Planted>) =>
  Array.from({ length: n }, (_, i) => ({ raw: mail({ subject: `Message ${i + 1}` }, `Body ${i + 1}`), ...extra?.(i) }));

describe('bounded newest-first search', () => {
  it('uses ESEARCH PARTIAL when the server has it', async () => {
    srv = await startServers(big(3000), { plugins: ['ESEARCH', 'PARTIAL'] });
    const r = await client.search(srv.account(), PASS, { limit: 5 });
    expect(r.map((m) => m.subject)).toEqual(['Message 3000', 'Message 2999', 'Message 2998', 'Message 2997', 'Message 2996']);
    expect(srv.imapLog.filter((l) => / SEARCH /i.test(l))).toEqual([expect.stringMatching(/RETURN \(PARTIAL -1:-5\)/)]);
  });

  it('finds a rare old match by walking UID windows down from the top', async () => {
    srv = await startServers(big(5000, (i) => (i === 17 ? { raw: mail({ subject: 'Needle' }, 'the needle') } : {})));
    const r = await client.search(srv.account(), PASS, { query: 'needle' });
    expect(r.map((m) => m.subject)).toEqual(['Needle']);
    const searches = srv.imapLog.filter((l) => / SEARCH /i.test(l));
    expect(searches[0]).toMatch(/UID 4501:5000/);
    expect(searches[1]).toMatch(/UID 3501:4500/);
    expect(searches.at(-1)).toMatch(/UID 1:/);
  });

  it('rejects a limit of zero or less', async () => {
    srv = await startServers(big(3));
    for (const limit of [0, -5, Number.NaN, 'abc' as unknown as number]) {
      expect((await err(client.search(srv.account(), PASS, { limit }))).code).toBe('invalid_input');
    }
  });
});

describe('snippets and bodies', () => {
  it('builds the snippet from the text part, even after 9 KB of headers', async () => {
    srv = await startServers([{ raw: mail({ subject: 'Long headers', extra: `X-Pad: ${'a'.repeat(9000)}\r\nContent-Type: text/plain` }, 'Short body here.') }]);
    expect((await client.search(srv.account(), PASS, {}))[0].snippet).toBe('Short body here.');
  });

  it('reads text nested ~150 MIME levels deep instead of returning an empty body', async () => {
    let s = 'Content-Type: text/plain\r\n\r\nDeep text.';
    for (let i = 150; i > 0; i--) s = `Content-Type: multipart/mixed; boundary="n${i}"\r\n\r\n--n${i}\r\n${s}\r\n--n${i}--`;
    srv = await startServers([{ uid: 1, raw: `From: a@example.org\r\nSubject: Deep\r\nMIME-Version: 1.0\r\n${s}` }]);
    const m = await client.read(srv.account(), PASS, id(1));
    expect(m.text).toContain('Deep text.');
  });

  it('does not split a surrogate pair when cutting at maxChars', async () => {
    srv = await startServers([{ uid: 1, raw: mail({ subject: 'Emoji' }, `abcd${'😀'.repeat(50)}`) }]);
    const m = await client.read(srv.account(), PASS, id(1), 7); // "abcd" + 1.5 emoji
    expect(m.text).toBe('abcd😀');
    expect(m.truncated).toBe(true);
  });

  it('drops image URLs and non-http(s) links from HTML', async () => {
    srv = await startServers([{ uid: 1, raw: mail({ subject: 'HTML', extra: 'Content-Type: text/html' }, '<p>Hi <img src="http://track.example/p.gif"> <a href="javascript:alert(1)">click</a> <a href="data:text/html,x">d</a> <a href="https://ok.example/x">ok</a></p>') }]);
    const m = await client.read(srv.account(), PASS, id(1));
    expect(m.text).not.toMatch(/track\.example|javascript:|data:/);
    expect(m.text).toContain('https://ok.example/x');
    expect(m.text).toContain('click');
  });
});

describe('reply headers', () => {
  it('keeps only well-formed <id@host> tokens from a hostile original', async () => {
    srv = await startServers([
      { uid: 1, raw: 'From: Bob <bob@example.org>\r\nTo: me@example.com\r\nSubject: hi\r\nMessage-ID: <orig2@example.org>\r\n\tBcc: evil@attacker.example\r\nReferences: <r0@example.org>\r\n\tX-Evil: 1 <bad id@x> junk\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nhello' },
    ]);
    const a = srv.account();
    await client.createDraft(a, PASS, { to: ['bob@example.org'], subject: '', text: 'ok', inReplyToId: id(1) });
    const raw = srv.folder('Drafts')[0].raw;
    const p = await simpleParser(Buffer.from(raw, 'binary'));
    expect(p.inReplyTo).toBe('<orig2@example.org>');
    expect(p.references).toEqual(['<r0@example.org>', '<orig2@example.org>']);
    expect(raw).not.toMatch(/evil|X-Evil|bad id/i);
  });
});

describe('error mapping', () => {
  it('an IMAP BAD reply is invalid_input from the incoming server', async () => {
    srv = await startServers(big(3));
    srv.imap.setCommandHandler('UID SEARCH', (conn: any, parsed: any, data: any, cb: () => void) => {
      conn.send({ tag: parsed.tag, command: 'BAD', attributes: [{ type: 'TEXT', value: 'Unsupported search' }] }, 'SEARCH BAD', parsed, data);
      cb();
    });
    const e = await err(client.search(srv.account(), PASS, { query: 'x' }));
    expect(e.code).toBe('invalid_input');
    expect(e.message).toContain('incoming server');
  });
});
