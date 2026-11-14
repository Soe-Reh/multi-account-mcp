// TLS is required: credentials never go out unencrypted except to this machine (127.0.0.1, ::1, localhost).
import tls from 'node:tls';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMailClient } from '../../src/mail/index.js';
import { AccountError } from '../../src/types.js';
import { CERT, PASS, startServers, type Servers } from './servers.js';

// "localhost." (trailing dot) reaches this machine but is not on the plaintext allow-list, so it behaves like a remote host.
const REMOTE = 'localhost.';
let srv: Servers | undefined;
const client = createMailClient({ timeoutMs: 5000 });
beforeAll(() => { tls.setDefaultCACertificates([...tls.getCACertificates('default'), CERT.cert.toString()]); });
afterEach(async () => { await srv?.close(); srv = undefined; });

async function err(p: Promise<unknown>): Promise<AccountError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AccountError); return e as AccountError; }
  throw new Error('expected an error');
}

describe('SMTP', () => {
  it('refuses to log in to a remote server that does not offer STARTTLS (stripped)', async () => {
    srv = await startServers([]);
    const a = srv.account({ allowSend: true });
    const e = await err(client.verify({ ...a, smtp: { ...a.smtp, host: REMOTE } }, PASS));
    expect(e.code).toBe('unreachable');
    expect(e.message).toContain('sending server');
    expect(e.message).toContain('encrypted');
    expect(srv.smtpAuths).toEqual([]); // the password never reached it
  });

  it('upgrades with STARTTLS on a remote server, then logs in encrypted', async () => {
    srv = await startServers([], { smtpTls: 'starttls' });
    const a = srv.account({ allowSend: true });
    await client.verify({ ...a, smtp: { ...a.smtp, host: REMOTE } }, PASS);
    expect(srv.smtpAuths).toEqual([{ secure: true }]);
  });

  it('sends over implicit TLS', async () => {
    srv = await startServers([], { smtpTls: 'implicit' });
    const a = srv.account({ allowSend: true });
    const { draftId } = await client.createDraft(a, PASS, { to: ['bob@example.org'], subject: 's', text: 't' });
    await client.sendDraft(a, PASS, draftId);
    expect(srv.sent.length).toBe(1);
    expect(srv.smtpAuths).toEqual([{ secure: true }]);
  });
});

describe('IMAP', () => {
  it('refuses to log in to a remote server that does not offer STARTTLS (stripped)', async () => {
    srv = await startServers([]);
    const a = srv.account();
    const e = await err(client.search({ ...a, imap: { ...a.imap, host: REMOTE } }, PASS, {}));
    expect(e.code).toBe('unreachable');
    expect(e.message).toContain('incoming server');
    expect(e.message).toContain('encrypted');
    expect(srv.imapLog.join('')).not.toMatch(/AUTHENTICATE|LOGIN/i);
  });

  it('upgrades with STARTTLS on a remote server before logging in', async () => {
    srv = await startServers([], { plugins: ['STARTTLS'] });
    const a = srv.account();
    expect(await client.search({ ...a, imap: { ...a.imap, host: REMOTE } }, PASS, {})).toEqual([]);
    const log = srv.imapLog.join('');
    expect(log).toMatch(/STARTTLS/);
    expect(log).not.toMatch(/AUTHENTICATE|LOGIN/i); // after STARTTLS everything is ciphertext
  });

  it('works over implicit TLS', async () => {
    srv = await startServers([], { imapTls: 'implicit' });
    expect(await client.search(srv.account(), PASS, {})).toEqual([]);
  });
});
