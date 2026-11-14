// In-process IMAP (hoodiecrow) + SMTP (smtp-server) test servers with planted mailboxes. No Docker, no real accounts.
import fs from 'node:fs';
import net from 'node:net';
import hoodiecrow from 'hoodiecrow-imap';
import { SMTPServer } from 'smtp-server';
import type { Account } from '../../src/types.js';

export interface Planted { raw: string; flags?: string[]; internaldate?: string; uid?: number }

/** How the SMTP server answers once the message data is in. "accepted" ones are recorded in `sent` either way. */
export type SmtpMode = 'ok' | 'reject-after-data' | 'defer-after-data' | 'hang-after-data' | 'drop-after-data';

export const CERT = { key: fs.readFileSync(new URL('./fixtures/key.pem', import.meta.url)), cert: fs.readFileSync(new URL('./fixtures/cert.pem', import.meta.url)) };

export interface Servers {
  imap: any;
  imapPort: number;
  smtpPort: number;
  sent: { from: string; to: string[]; raw: string }[];
  smtpAuths: { secure: boolean }[];
  smtpOpen(): number;      // SMTP connections open right now
  smtpTotal(): number;     // SMTP connections ever opened
  state: { smtpMode: SmtpMode };
  imapLog: string[]; // raw lines the client sent
  account(patch?: Partial<Account>): Account;
  folder(path: string): { uid: number; flags: string[]; raw: string }[];
  close(): Promise<void>;
}

export const PASS = { user: 'testuser', pass: 'testpass' };
export const TOKEN = { user: 'testuser', accessToken: 'testtoken' };

export interface ServerOpts {
  gmail?: boolean;
  noDrafts?: boolean;
  noMove?: boolean;        // leave out MOVE, so sendDraft uses its keyword claim
  noUidplus?: boolean;
  noKeywords?: boolean;    // Drafts refuses custom keywords (like Outlook.com), so sendDraft uses a holding folder
  plugins?: string[];      // extra hoodiecrow plugins, e.g. ESEARCH, PARTIAL, STARTTLS
  folders?: Record<string, unknown>; // replaces the default folder tree
  drafts?: Planted[];      // planted in the Drafts folder
  smtpMode?: SmtpMode;
  smtpTls?: 'starttls' | 'implicit'; // default: plain, STARTTLS not offered
  imapTls?: 'implicit';
}

export async function startServers(inbox: Planted[], opts: ServerOpts = {}): Promise<Servers> {
  const sep = opts.gmail ? '/' : '.';
  const plant = (l: Planted[]) => l.map((m) => ({ ...m, raw: Buffer.from(m.raw, 'utf8'), ...(m.internaldate && { internaldate: new Date(m.internaldate) }) }));
  const folders: Record<string, unknown> = opts.folders ?? (opts.gmail
    ? { '[Gmail]': { flags: ['\\Noselect'], folders: { Drafts: { 'special-use': '\\Drafts', messages: plant(opts.drafts ?? []) }, 'Sent Mail': { 'special-use': '\\Sent' }, Trash: { 'special-use': '\\Trash' } } } }
    : opts.noDrafts ? {} : { Drafts: { 'special-use': '\\Drafts', messages: plant(opts.drafts ?? []) }, Sent: { 'special-use': '\\Sent' } });
  const imap = hoodiecrow({
    plugins: ['SPECIAL-USE', ...(opts.noUidplus ? [] : ['UIDPLUS']), ...(opts.noMove ? [] : ['MOVE']), 'SASL-IR', 'XOAUTH2', 'AUTH-PLAIN', 'ENABLE', 'ID', 'NAMESPACE', 'UNSELECT', ...(opts.gmail ? ['X-GM-EXT-1'] : []), ...(opts.plugins ?? [])],
    storage: { INBOX: { uidvalidity: 7, messages: plant(inbox) }, '': { separator: sep, folders } },
    ...(opts.imapTls === 'implicit' && { secureConnection: true }),
    credentials: CERT,
  });
  const imapLog: string[] = [];
  imap.server.prependListener('connection', (sock: net.Socket) => sock.on('data', (d) => imapLog.push(d.toString('utf8'))));
  if (opts.noKeywords) for (const p of ['Drafts', '[Gmail]/Drafts']) { const mb = imap.getMailbox(p); if (mb) mb.allowPermanentFlags = false; }
  await new Promise<void>((r) => imap.listen(0, '127.0.0.1', r));

  const sent: Servers['sent'] = [];
  const smtpAuths: Servers['smtpAuths'] = [];
  const state = { smtpMode: opts.smtpMode ?? ('ok' as SmtpMode) };
  const socks = new Set<net.Socket>();
  let total = 0;
  const smtp = new SMTPServer({
    ...(opts.smtpTls ? CERT : { disabledCommands: ['STARTTLS'], allowInsecureAuth: true }),
    secure: opts.smtpTls === 'implicit',
    authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2'],
    logger: false,
    onAuth(auth, session, done) {
      smtpAuths.push({ secure: !!session.secure });
      const ok = auth.method === 'XOAUTH2' ? auth.accessToken === 'testtoken' : auth.password === 'testpass';
      if (!ok) return done(new Error('Invalid username or password'));
      done(null, { user: auth.username });
    },
    onData(stream, session, done) {
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const rec = { from: (session.envelope.mailFrom || { address: '' }).address, to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString('utf8') };
        const mode = state.smtpMode;
        if (mode === 'reject-after-data' || mode === 'defer-after-data') {
          const e = Object.assign(new Error(mode === 'reject-after-data' ? 'Message rejected: content policy' : 'Try again later'), { responseCode: mode === 'reject-after-data' ? 554 : 451 });
          return done(e);
        }
        sent.push(rec); // from here on the server has the message, whatever the client hears
        if (mode === 'hang-after-data') return;
        if (mode === 'drop-after-data') { for (const s of socks) s.destroy(); return; }
        done();
      });
    },
  });
  smtp.server.on('connection', (s: net.Socket) => { total++; socks.add(s); s.on('close', () => socks.delete(s)); });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));

  const imapPort = imap.address().port;
  const smtpPort = (smtp.server.address() as net.AddressInfo).port;
  return {
    imap, imapPort, smtpPort, sent, smtpAuths, imapLog, state,
    smtpOpen: () => socks.size,
    smtpTotal: () => total,
    account: (patch = {}) => ({
      id: 'test', label: 'Test Mail', service: 'email', provider: opts.gmail ? 'gmail' : 'imap',
      address: 'me@example.com', auth: 'password',
      imap: { host: '127.0.0.1', port: imapPort, secure: opts.imapTls === 'implicit' },
      smtp: { host: '127.0.0.1', port: smtpPort, secure: opts.smtpTls === 'implicit' },
      allowSend: false, addedAt: '2026-11-11T00:00:00.000Z', ...patch,
    }),
    folder: (path) => (imap.getMailbox(path)?.messages ?? []),
    close: async () => {
      for (const s of socks) s.destroy();
      await new Promise<void>((r) => imap.close(() => r()));
      await new Promise<void>((r) => smtp.close(() => r()));
    },
  };
}

/**
 * A TCP proxy in front of a server. When a client command matches `fault.after`, it drops both sockets (before or
 * just after passing the command on)
 * or holds the server's answers for `holdMs` (a slow link). `stripCopyuid` removes COPYUID from the answers.
 */
export async function faultProxy(port: number) {
  const fault: { after?: { test(s: string): boolean }; mode?: 'drop' | 'dropAfter' | 'hold'; holdMs?: number; stripCopyuid?: boolean } = {};
  const socks = new Set<net.Socket>();
  const s = net.createServer((cl) => {
    const up = net.connect(port, '127.0.0.1');
    socks.add(cl); socks.add(up);
    let heldUntil = 0;
    let queue: Buffer[] = [];
    let mute = false;
    cl.on('data', (d) => {
      if (fault.after?.test(d.toString('latin1'))) {
        const f = { ...fault };
        fault.after = undefined; // fires once
        if (f.mode === 'drop') { cl.destroy(); up.destroy(); return; }
        if (f.mode === 'dropAfter') { mute = true; up.write(d); setTimeout(() => { cl.destroy(); up.destroy(); }, 50); return; } // the server acts, its answer is lost
        heldUntil = Date.now() + (f.holdMs ?? 0);
        setTimeout(() => { for (const b of queue) if (!cl.destroyed) cl.write(b); queue = []; heldUntil = 0; }, f.holdMs ?? 0);
      }
      up.write(d);
    });
    up.on('data', (d) => {
      if (fault.stripCopyuid) d = Buffer.from(d.toString('latin1').replace(/\[COPYUID [^\]]*\] ?/g, ''), 'latin1');
      if (mute) return;
      if (heldUntil) queue.push(d); else if (!cl.destroyed) cl.write(d);
    });
    const end = () => { cl.destroy(); up.destroy(); };
    cl.on('close', end); up.on('close', end); cl.on('error', () => {}); up.on('error', () => {});
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return {
    port: (s.address() as net.AddressInfo).port,
    fault,
    close: () => new Promise<void>((r) => { socks.forEach((x) => x.destroy()); s.close(() => r()); }),
  };
}

/** A port with nothing listening on it. */
export async function deadPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A server that accepts connections and never says anything. */
export async function silentServer(): Promise<{ port: number; open(): number; close(): Promise<void> }> {
  const socks = new Set<net.Socket>();
  const s = net.createServer((sock) => { socks.add(sock); sock.on('close', () => socks.delete(sock)); sock.on('error', () => {}); });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return {
    port: (s.address() as net.AddressInfo).port,
    open: () => socks.size,
    close: () => new Promise<void>((r) => { socks.forEach((x) => x.destroy()); s.close(() => r()); }),
  };
}

export function mail(h: { from?: string | null; to?: string; subject?: string | null; date?: string; messageId?: string; extra?: string }, body = 'Hello there.'): string {
  const lines = [
    h.from === null ? null : `From: ${h.from ?? 'Alice <alice@example.org>'}`,
    `To: ${h.to ?? 'me@example.com'}`,
    h.subject === null ? null : `Subject: ${h.subject ?? 'Hello'}`,
    `Date: ${h.date ?? 'Tue, 10 Nov 2026 10:00:00 +0000'}`,
    `Message-ID: ${h.messageId ?? `<${Math.random().toString(36).slice(2)}@example.org>`}`,
    'MIME-Version: 1.0',
    h.extra ?? 'Content-Type: text/plain; charset=utf-8',
  ].filter((l) => l !== null);
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}
