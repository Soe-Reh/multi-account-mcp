import { describe, expect, it } from 'vitest';
import { parseAutoconfig, lookupPreset, providerPreset, slugify } from '../../src/accounts/index.js';

describe('providerPreset', () => {
  it.each([
    ['a@gmail.com', 'gmail', 'imap.gmail.com', 993, true, 'smtp.gmail.com', 465, true],
    ['a@GoogleMail.com', 'gmail', 'imap.gmail.com', 993, true, 'smtp.gmail.com', 465, true],
    ['a@yahoo.com', 'yahoo', 'imap.mail.yahoo.com', 993, true, 'smtp.mail.yahoo.com', 465, true],
    ['a@ymail.com', 'yahoo', 'imap.mail.yahoo.com', 993, true, 'smtp.mail.yahoo.com', 465, true],
    ['a@rocketmail.com', 'yahoo', 'imap.mail.yahoo.com', 993, true, 'smtp.mail.yahoo.com', 465, true],
    ['a@outlook.com', 'outlook', 'outlook.office365.com', 993, true, 'smtp-mail.outlook.com', 587, false],
    ['a@hotmail.com', 'outlook', 'outlook.office365.com', 993, true, 'smtp-mail.outlook.com', 587, false],
    ['a@live.com', 'outlook', 'outlook.office365.com', 993, true, 'smtp-mail.outlook.com', 587, false],
    ['a@msn.com', 'outlook', 'outlook.office365.com', 993, true, 'smtp-mail.outlook.com', 587, false],
    ['a@icloud.com', 'imap', 'imap.mail.me.com', 993, true, 'smtp.mail.me.com', 587, false],
    ['a@me.com', 'imap', 'imap.mail.me.com', 993, true, 'smtp.mail.me.com', 587, false],
  ])('%s', (addr, provider, ih, ip, is, sh, sp, ss) => {
    expect(providerPreset(addr)).toEqual({ provider, imap: { host: ih, port: ip, secure: is }, smtp: { host: sh, port: sp, secure: ss } });
  });

  it('returns undefined for unknown or odd input', () => {
    for (const a of ['a@utexas.edu', '', 'gmail.com.evil.io', 'a@constructor', 'a@__proto__', 'a@toString']) {
      expect(providerPreset(a)).toBeUndefined();
    }
  });

  it('returns a fresh copy each time', () => {
    providerPreset('a@gmail.com')!.imap.port = 1;
    expect(providerPreset('a@gmail.com')!.imap.port).toBe(993);
  });
});

describe('slugify', () => {
  const ok = /^[a-z0-9-]{1,40}$/;
  it('makes valid, unique ids', () => {
    expect(slugify('Jobs Gmail')).toBe('jobs-gmail');
    expect(slugify('Jobs Gmail', ['jobs-gmail'])).toBe('jobs-gmail-2');
    expect(slugify('Jobs Gmail', ['jobs-gmail', 'jobs-gmail-2'])).toBe('jobs-gmail-3');
    expect(slugify('Café Résumé')).toBe('cafe-resume');
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('')).toBe('account');
    expect(slugify('日本語')).toBe('account');
    expect(slugify('日本語', ['account'])).toBe('account-2');
  });
  it('stays within 40 chars even with a suffix', () => {
    const long = 'x'.repeat(500);
    const first = slugify(long);
    const second = slugify(long, [first]);
    expect(first).toMatch(ok);
    expect(second).toMatch(ok);
    expect(second).not.toBe(first);
    expect(slugify('a'.repeat(39) + ' b')).toMatch(ok);
  });
});

describe('autoconfig lookup', () => {
  const xml = `<clientConfig><emailProvider id="x">
    <incomingServer type="pop3"><hostname>pop.x.org</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
    <incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>143</port><socketType>plain</socketType></incomingServer>
    <incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.x.org</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
  </emailProvider></clientConfig>`;
  it('takes the first TLS IMAP and SMTP servers and fills in the domain', () => {
    expect(parseAutoconfig(xml, 'Me@Shop.org')).toEqual({ provider: 'imap', imap: { host: 'imap.shop.org', port: 993, secure: true }, smtp: { host: 'smtp.x.org', port: 587, secure: false } });
    expect(parseAutoconfig('<clientConfig/>', 'a@b.org')).toBeUndefined();
  });
  it('known domains need no network; reserved names make no request; the database is asked by domain', async () => {
    const calls: string[] = [];
    const f = (async (u: string) => { calls.push(u); return new Response(xml); }) as unknown as typeof fetch;
    expect((await lookupPreset('a@icloud.com', f))!.imap.host).toBe('imap.mail.me.com');
    expect(await lookupPreset('a@b.example', f)).toBeUndefined();
    expect(calls).toEqual([]);
    expect((await lookupPreset('a@shop.org', f))!.imap.host).toBe('imap.shop.org');
    expect(calls).toEqual(['https://autoconfig.thunderbird.net/v1.1/shop.org']);
  });
});
