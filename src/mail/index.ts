// Part C: one IMAP/SMTP mail engine for every provider (imapflow + nodemailer + mailparser).
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { ImapFlow, type FetchMessageObject, type FetchQueryObject, type ListResponse, type MessageAddressObject, type MessageStructureObject, type SearchObject } from 'imapflow';
import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import addressparser from 'nodemailer/lib/addressparser';
import { simpleParser, type AddressObject } from 'mailparser';
import { convert as htmlToText } from 'html-to-text';
import {
  AccountError,
  type Account,
  type DraftInput,
  type MailClient,
  type MailCredentials,
  type MessageFull,
  type MessageSummary,
  type SearchOptions,
} from '../types.js';

const MAX_BODY_BYTES = 1024 * 1024;
const SNIPPET_BYTES = 2048;
const SOURCE_FALLBACK_BYTES = 256 * 1024;
const SENT_NAMES = ['sent', 'sent items', 'sent messages', 'sent mail'];
const ADDRESS_RE = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\.]+(\.[^\s@<>()[\],;:"\\.]+)+$/;
const MSGID_RE = /^<[^<>\s]+@[^<>\s]+>$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
// Plaintext (no TLS) is allowed only to this machine, so in-process test servers work.
const isLoopback = (host: string) => LOOPBACK.has(host.toLowerCase());

type Side = 'incoming' | 'sending';

interface Session {
  imap(): Promise<ImapFlow>;
  /** onReply sees each SMTP server reply line (never the message or secrets). */
  smtp(onReply?: (line: string) => void): Transporter;
  readonly expired: boolean;
}

// ---------- ids ----------

interface MessageRef { folder: string; uidValidity: string; uid: number }

const encodeId = (folder: string, uidValidity: bigint | string, uid: number) =>
  Buffer.from(JSON.stringify([folder, String(uidValidity), uid])).toString('base64url');

// Only the exact encoding we hand out is accepted, so one message has exactly one id.
function decodeId(account: Account, id: unknown): MessageRef {
  if (typeof id === 'string' && id.length > 0 && id.length < 2000) {
    try {
      const v = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
      if (Array.isArray(v) && v.length === 3) {
        const [folder, uidValidity, uid] = v;
        if (typeof folder === 'string' && folder && typeof uidValidity === 'string' && /^(0|[1-9]\d{0,19})$/.test(uidValidity)
          && Number.isInteger(uid) && uid > 0 && uid < 2 ** 32 && encodeId(folder, uidValidity, uid) === id) {
          return { folder, uidValidity, uid };
        }
      }
    } catch { /* fall through */ }
  }
  throw new AccountError('invalid_input', `${account.label}: that is not a valid message id.`, account.id);
}

const refKey = (account: Account, r: MessageRef) => `${account.id}|${r.folder}|${r.uidValidity}|${r.uid}`;

const notFound = (account: Account, what = 'That message') =>
  new AccountError('not_found', `${account.label}: ${what} no longer exists (it may have been moved or deleted).`, account.id);

// Opens the folder of an id and checks UIDVALIDITY, so a stale id never points at another message.
async function openRef(account: Account, c: ImapFlow, ref: MessageRef, readOnly: boolean) {
  const mb = await c.mailboxOpen(ref.folder, { readOnly });
  if (String(mb.uidValidity) !== ref.uidValidity) throw notFound(account);
}

const findFolder = (list: ListResponse[], use: string, names: string[]) =>
  (list.find((f) => f.specialUse === use) ?? list.find((f) => names.includes(f.path.toLowerCase())))?.path;

// ---------- input checks ----------

function bad(account: Account, msg: string): never {
  throw new AccountError('invalid_input', `${account.label}: ${msg}`, account.id);
}

function cleanText(account: Account, name: string, v: unknown, max = 1000): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') bad(account, `${name} must be text.`);
  if (/[\r\n\0]/.test(v)) bad(account, `${name} must not contain line breaks.`);
  if (v.length > max) bad(account, `${name} is too long.`);
  return v;
}

function cleanDate(account: Account, name: string, v: unknown): Date | undefined {
  const s = cleanText(account, name, v);
  if (s === undefined) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) bad(account, `${name} must be a date like 2026-11-01.`);
  return d;
}

// Each entry is one address, bare or "Name <addr>"; anything that parses to more than one is refused.
function cleanAddresses(account: Account, name: string, list: unknown, required: boolean) {
  if (list === undefined && !required) return [];
  if (!Array.isArray(list) || (required && list.length === 0)) bad(account, `${name} must list at least one email address.`);
  if (list.length > 100) bad(account, `${name} has too many addresses.`);
  return list.map((a) => {
    const parsed = typeof a === 'string' && a.length <= 320 && !/[\r\n\0]/.test(a) ? addressparser(a) : [];
    const one = parsed.length === 1 && 'address' in parsed[0] ? parsed[0] : undefined;
    if (!one || !ADDRESS_RE.test(one.address ?? "")) bad(account, `"${String(a).replace(/[\r\n]/g, ' ').slice(0, 80)}" in ${name} is not a valid email address.`);
    return { name: one.name, address: one.address };
  });
}

// ---------- errors ----------

// imapflow's own checks on what it was asked to send
const LIBRARY_INPUT_CODES = new Set(['InvalidStringValue', 'InvalidTokenValue', 'InvalidTextValue', 'InvalidSequenceSet', 'InvalidSearchQuery', 'InvalidMessageContent']);
const TIMEOUT_CODES = new Set(['ETIMEOUT', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT']);

const timeoutError = (account: Account, side: Side = 'incoming') =>
  new AccountError('timeout', `${account.label}: the ${side} server did not answer in time.`, account.id);

function toAccountError(e: unknown, account: Account, side: Side = 'incoming'): AccountError {
  if (e instanceof AccountError) return e;
  const err = (e ?? {}) as {
    code?: string; authenticationFailed?: boolean; mailboxMissing?: boolean; serverResponseCode?: string;
    responseCode?: number; response?: string; responseStatus?: string; tlsFailed?: boolean;
  };
  const code = String(err.code ?? '');
  const server = `${side} server`;
  const id = account.id;
  if (err.authenticationFailed || code === 'EAUTH' || err.serverResponseCode === 'AUTHENTICATIONFAILED') {
    return new AccountError('auth_failed', `${account.label}: the ${server} rejected the login. Check the password or sign in again.`, id);
  }
  if (TIMEOUT_CODES.has(code)) return timeoutError(account, side);
  if (err.tlsFailed || code === 'ETLS') {
    return new AccountError('unreachable', `${account.label}: could not set up an encrypted connection to the ${server}, so the login was not sent.`, id);
  }
  if (err.mailboxMissing || err.serverResponseCode === 'NONEXISTENT') {
    return new AccountError('not_found', `${account.label}: that folder does not exist.`, id);
  }
  if (side === 'sending' && typeof err.responseCode === 'number' && err.responseCode >= 400) {
    const reply = String(err.response ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
    return err.responseCode >= 500
      ? new AccountError('rejected', `${account.label}: the ${server} refused the message: ${reply}`, id)
      : new AccountError('unreachable', `${account.label}: the ${server} turned the message away for now: ${reply}`, id);
  }
  if (side === 'incoming' && (err.responseStatus === 'NO' || err.responseStatus === 'BAD' || LIBRARY_INPUT_CODES.has(code))) {
    return new AccountError('invalid_input', `${account.label}: the ${server} refused that request.`, id);
  }
  // Never echo raw library messages: they can contain the command that was sent (LOGIN with the password).
  return new AccountError('unreachable', `${account.label}: could not talk to the ${server} (${code || 'connection error'}).`, id);
}

// ---------- connections ----------

// Runs one operation with a hard deadline; every connection it opened is closed afterwards.
async function session<T>(account: Account, creds: MailCredentials, timeoutMs: number, fn: (s: Session) => Promise<T>): Promise<T> {
  const closers: (() => void)[] = [];
  let expired = false;
  let side: Side = 'incoming';
  const s: Session = {
    get expired() { return expired; },
    async imap() {
      side = 'incoming';
      const c = new ImapFlow({
        host: account.imap.host,
        port: account.imap.port,
        secure: account.imap.secure,
        doSTARTTLS: account.imap.secure || isLoopback(account.imap.host) ? undefined : true,
        auth: 'pass' in creds ? { user: creds.user, pass: creds.pass } : { user: creds.user, accessToken: creds.accessToken },
        logger: false,
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs,
      });
      c.on('error', () => {}); // errors surface through the awaited calls
      closers.push(() => c.close());
      await c.connect();
      return c;
    },
    smtp(onReply) {
      side = 'sending';
      const quiet = () => {};
      const t = nodemailer.createTransport({
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
        requireTLS: !account.smtp.secure && !isLoopback(account.smtp.host),
        auth: 'pass' in creds ? { user: creds.user, pass: creds.pass } : { type: 'OAuth2', user: creds.user, accessToken: creds.accessToken },
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs,
        // We own the socket so the deadline can destroy it mid-send, and no SMTP starts after the deadline.
        getSocket(_o: unknown, cb: (err: Error | null, socketOptions: unknown) => void) {
          if (expired) return cb(timeoutError(account, 'sending'), undefined);
          const sock = net.connect({ host: account.smtp.host, port: account.smtp.port });
          closers.push(() => sock.destroy());
          let done = false;
          const once = (e: Error | null) => { if (!done) { done = true; cb(e, e ? undefined : { connection: sock }); } };
          sock.once('connect', () => once(null));
          sock.once('error', once);
          sock.once('close', () => once(new Error('connection closed')));
        },
        debug: !!onReply,
        logger: onReply
          ? { debug: (e: { tnx?: string }, msg: unknown) => { if (e?.tnx === 'server' && typeof msg === 'string') onReply(msg); }, trace: quiet, info: quiet, warn: quiet, error: quiet, fatal: quiet }
          : false,
      } as SMTPTransport.Options);
      closers.push(() => t.close());
      return t;
    },
  };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(timeoutError(account, side)); }, timeoutMs);
  });
  const work = fn(s);
  work.catch(() => {}); // it may still reject after the deadline won
  try {
    return await Promise.race([work, deadline]);
  } catch (e) {
    throw toAccountError(e, account);
  } finally {
    clearTimeout(timer);
    for (const close of closers) try { close(); } catch { /* already closed */ }
  }
}

const smtpFails = (account: Account) => (e: unknown): never => { throw toAccountError(e, account, 'sending'); };

// ---------- message helpers ----------

// A name with address punctuation (e.g. "Acme: Support") is quoted, or a reply to it would parse as a group.
const fmtName = (n: string) => (/[:;<>@,()[\]"\\]/.test(n) ? `"${n.replace(/["\\]/g, '')}"` : n);
const fmtAddr = (a?: MessageAddressObject) => (a ? (a.name ? `${fmtName(a.name)} <${a.address ?? ''}>` : a.address ?? '') : '');
const fmtList = (l?: MessageAddressObject[]) => (l ?? []).map(fmtAddr).filter(Boolean);

// Cuts to n UTF-16 units without leaving half of a surrogate pair.
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, /[\uD800-\uDBFF]/.test(s[n - 1]) ? n - 1 : n));
const snippetText = (s: string) => cut(s.replace(/\uFFFD+$/, '').replace(/\s+/g, ' ').trim(), 200);

// Only http(s) links keep their URL; images and javascript:/data: links are dropped.
const htmlText = (html: string) => htmlToText(html, {
  wordwrap: false,
  selectors: [
    { selector: 'img', format: 'skip' },
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'a[href^="http://" i]', format: 'anchor', options: { ignoreHref: false } },
    { selector: 'a[href^="https://" i]', format: 'anchor', options: { ignoreHref: false } },
  ],
});

// Keeps only well-formed <id@host> tokens, so junk in a hostile header never reaches our headers.
const msgIds = (v: string | string[] | undefined) =>
  [v ?? []].flat().flatMap((s) => s.match(/<[^<>]*>/g) ?? []).filter((t) => MSGID_RE.test(t));

// Parts below 1,000 levels of nesting are ignored: no real mail nests that deep, and hostile mail must not blow the stack.
function walk(node: MessageStructureObject | undefined, out: MessageStructureObject[] = [], depth = 0) {
  if (!node || depth > 1000) return out;
  out.push(node);
  for (const child of node.childNodes ?? []) walk(child, out, depth + 1);
  return out;
}

const filenameOf = (n: MessageStructureObject) => n.dispositionParameters?.filename ?? n.parameters?.name;
const isAttachment = (n: MessageStructureObject) =>
  !n.childNodes && (n.disposition === 'attachment' || (!!filenameOf(n) && !n.type.startsWith('text/')));

function textPart(root?: MessageStructureObject) {
  const nodes = walk(root).filter((n) => !n.childNodes && !isAttachment(n));
  return nodes.find((n) => n.type === 'text/plain') ?? nodes.find((n) => n.type === 'text/html');
}

function attachmentsOf(root?: MessageStructureObject) {
  return walk(root).filter(isAttachment).map((n) => ({
    filename: filenameOf(n) ?? 'unnamed',
    contentType: n.type,
    size: n.encoding === 'base64' ? Math.floor(((n.size ?? 0) * 3) / 4) : n.size ?? 0,
  }));
}

// Decodes the first bytes of a text part (transfer encoding, then charset) into plain text.
function decodePart(raw: Buffer, n: MessageStructureObject): string {
  let bytes = raw;
  if (n.encoding === 'base64') bytes = Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/]/g, ''), 'base64');
  else if (n.encoding === 'quoted-printable') {
    bytes = Buffer.from(raw.toString('latin1').replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  }
  let text: string;
  try { text = new TextDecoder(n.parameters?.charset || 'utf-8').decode(bytes); } catch { text = bytes.toString('utf8'); }
  return n.type === 'text/html' ? htmlText(text) : text;
}

function summary(account: Account, folder: string, uidValidity: bigint, m: FetchMessageObject, snippet: string): MessageSummary {
  const env = m.envelope;
  const date = env?.date ? new Date(env.date) : m.internalDate ? new Date(m.internalDate) : undefined;
  return {
    accountId: account.id,
    id: encodeId(folder, uidValidity, m.uid),
    folder,
    from: fmtAddr(env?.from?.[0]),
    to: fmtList(env?.to),
    subject: env?.subject ?? '',
    date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : '',
    snippet,
    unread: !m.flags?.has('\\Seen'),
    hasAttachments: attachmentsOf(m.bodyStructure).length > 0,
  };
}

// Group syntax ("team: a@x, b@y;") counts as its member addresses.
const addrsOf = (a?: AddressObject | AddressObject[]) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value.flatMap((v) => (v.group ? v.group.map((g) => g.address) : [v.address])))
    .filter((v): v is string => !!v);

// Removes Bcc and Resent-Bcc headers (any spacing before the colon, folded lines too) so Bcc recipients stay hidden.
function stripBcc(src: Buffer): Buffer {
  const s = src.toString('latin1'); // byte-preserving
  const end = /\r?\n\r?\n/.exec(s);
  const split = end ? end.index + end[0].length : s.length;
  const head = s.slice(0, split).replace(/^(?:Resent-)?Bcc[ \t]*:.*(?:\r?\n[ \t].*)*(?:\r?\n|$)/gim, '');
  return Buffer.from(head + s.slice(split), 'latin1');
}

// Newest matching UIDs, without asking for every match in a big mailbox.
async function newestUids(account: Account, c: ImapFlow, criteria: SearchObject, limit: number, uidNext?: number): Promise<number[]> {
  const desc = (l: number[]) => l.sort((a, b) => b - a);
  // imapflow answers a refused SEARCH (NO/BAD) with false; that must not look like "no matches".
  const refused = (): never => { throw new AccountError('invalid_input', `${account.label}: the incoming server refused that search.`, account.id); };
  if (c.capabilities.has('ESEARCH') && c.capabilities.has('PARTIAL')) {
    const r = (await c.search(criteria, { uid: true, returnOptions: [{ partial: `-1:-${limit}` }] })) || refused();
    if (!Array.isArray(r)) {
      if (!r.partial?.messages) return []; // PARTIAL NIL: no matches
      const out: number[] = [];
      for (const range of (r.partial?.messages ?? '').split(',').reverse()) {
        const [a, b = a] = range.split(':').map(Number);
        for (let u = Math.max(a, b); u >= Math.min(a, b) && out.length < limit; u--) out.push(u);
      }
      return desc(out).slice(0, limit);
    }
  }
  if (!uidNext) return desc((await c.search(criteria, { uid: true })) || refused()).slice(0, limit);
  // UID windows from the top down, doubling in size, until enough matches are found.
  const out: number[] = [];
  for (let hi = uidNext - 1, size = 500; hi >= 1 && out.length < limit; size *= 2) {
    const lo = Math.max(1, hi - size + 1);
    out.push(...desc((await c.search({ ...criteria, uid: `${lo}:${hi}` }, { uid: true })) || refused()));
    hi = lo - 1;
  }
  return out.slice(0, limit);
}

// ---------- sending ----------

// While a draft is being sent it stays an ordinary draft in Drafts, carrying a claim keyword "$mcpclaim.<time>.<random>".
const CLAIM_RE = /^\$mcpclaim\.[0-9a-z]+\.[0-9a-f]+$/i;
// Written (and read back) before SMTP opens, removed only on a definite failure: such a draft is never sent again by itself.
const MAYBE_SENT = '$mcpunconfirmed';
const WAS_SENT = '$mcpsent';          // sent, but the draft could not be removed yet
// Servers without custom keywords (e.g. Outlook.com) hold the draft in a folder of its own while sending instead,
// named after the draft's UID so a later call can find it. Matched on the last name part (after any namespace prefix).
const HOLD_RE = /^MCP Sending [0-9a-z]+ [0-9a-f]+(?: (\d+))?$/;
const stamp = () => `${Date.now().toString(36)}.${randomBytes(4).toString('hex')}`;
const hasFlag = (flags: Set<string>, f: string) => [...flags].some((x) => x.toLowerCase() === f.toLowerCase());

interface SendState {
  drafts?: string;
  sent?: string;
  msgId?: string;
  flag?: string;       // our claim keyword; set before the STORE, so a lost answer is still cleaned up
  hold?: string;       // or our own holding folder; set before the MOVE for the same reason
  holdUid?: number;    // the draft's UID in it
  marking?: boolean;   // we sent the write-ahead mark (set before the STORE, so a lost answer is still cleaned up)
  dataBegan?: boolean; // the SMTP server answered 354 to DATA
  outcome?: 'none' | 'unconfirmed' | 'sent';
  error?: AccountError;
  settled?: boolean;   // the claim is released or marked on the server
  filed?: boolean;     // a copy is in Sent
  removed?: boolean;   // the draft is out of Drafts
  result?: { sent: true; messageIdHeader: string; warning?: string };
}

const filed = (v: unknown) => { if (!v) throw new Error('not filed'); };
const q = (folder: string | undefined, fallback: string) => `"${folder ?? fallback}"`;

// retryMs: a claim seen on the server, not a send running in this process.
const busy = (a: Account, st: SendState, retryMs?: number, where = st.drafts) => new AccountError('timeout', retryMs === undefined
  ? `${a.label}: another request is sending that draft right now (it is still in ${q(st.drafts, 'Drafts')}). Wait a minute, then check ${q(st.sent, 'Sent')} before trying again.`
  : `${a.label}: an earlier attempt to send that draft is still marked as in progress (the draft is in ${q(where, 'Drafts')}). Check ${q(st.sent, 'Sent')} first; if it is not there, try again in about ${Math.max(1, Math.ceil(retryMs / 60_000))} minutes.`, a.id);
const alreadySent = (a: Account, st: SendState) => new AccountError('not_found',
  `${a.label}: that draft is no longer waiting in ${q(st.drafts, 'Drafts')}: it was already sent, moved or deleted. Check ${q(st.sent, 'Sent')}.`, a.id);
const unconfirmed = (a: Account, st: SendState, earlier = false) => new AccountError('send_unconfirmed',
  `${a.label}: this may have been sent. ${earlier ? 'An earlier or parallel send of this draft got to the point where it may go through, and whether it did was never recorded.' : 'The sending server took the message but never confirmed it.'} `
  + `The draft is kept in ${q(st.hold ?? st.drafts, 'Drafts')}, marked so it is not sent again by itself. Check ${q(st.sent, 'Sent')} (or ask a recipient) before sending again; to send it anyway, create a new draft.`, a.id);

// Throws if the draft was sent, or may have been sent, by an earlier or a parallel call.
function checkFlags(a: Account, st: SendState, flags: Set<string> | undefined): Set<string> {
  if (!flags || hasFlag(flags, '\\Deleted') || hasFlag(flags, WAS_SENT)) throw alreadySent(a, st);
  if (hasFlag(flags, MAYBE_SENT)) throw unconfirmed(a, st, true);
  return flags;
}

async function uidsOf(c: ImapFlow, folder: string, query: SearchObject): Promise<number[]> {
  await c.mailboxOpen(folder);
  return (await c.search(query, { uid: true })) || Promise.reject(new Error('search refused'));
}

// Moves the drafts matching `which` out of a holding folder back to Drafts (as drafts again); removes the folder once empty.
async function putBack(c: ImapFlow, hold: string, drafts: string, which: SearchObject) {
  const uids = await uidsOf(c, hold, which);
  if (uids.length) filed(await c.messageFlagsAdd(uids, ['\\Draft'], { uid: true }));
  if (uids.length) filed(await c.messageMove(uids, drafts, { uid: true }));
  if ((await c.mailboxOpen(hold)).exists === 0) { await c.mailboxOpen(drafts); await c.mailboxDelete(hold); }
  return uids.length;
}

const tidyWarning = (st: SendState) => {
  if (st.removed) return undefined;
  const where = q(st.hold ?? st.drafts, 'Drafts');
  return st.filed
    ? `It was sent and filed in ${q(st.sent, 'Sent')}, but the draft could not be removed from ${where}; delete it there.`
    : `It was sent, but no copy could be saved in ${q(st.sent, 'Sent')}; the only copy is the draft in ${where}${st.settled ? (st.flag ? ', marked as sent' : ', marked so it is not sent again') : ''}.`;
};

// ---------- client ----------

export function createMailClient(opts: { timeoutMs?: number } = {}): MailClient {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const staleMs = Math.max(10 * 60_000, 3 * timeoutMs); // a claim this old belongs to a process that died
  const sending = new Set<string>(); // drafts this process is sending right now
  // Without keywords a draft put back in Drafts gets a new UID; its old id keeps working in this process.
  // shortcut: other processes holding the old id get not_found there; the keyword claim (most servers) keeps the UID.
  const movedBack = new Map<string, MessageRef>();
  const settling = new Map<string, Promise<void>>(); // clean-ups still running after a failure or the deadline

  // A claim without the maybe-sent mark expires only once THIS process has itself seen it for longer than staleMs;
  // the time written in the claim comes from another clock and is never trusted.
  const seen = new Map<string, number>();
  const leftMs = (account: Account, name: string) => {
    const k = `${account.id}|${name}`;
    if (!seen.has(k)) seen.set(k, Date.now());
    return seen.get(k)! + staleMs - Date.now(); // <= 0: expired
  };

  // Wins only if our own keyword reads back and no other live claim is on the draft. Two at once both back off and retry.
  // Returns false if the server silently dropped our keyword.
  async function claimKeyword(account: Account, c: ImapFlow, ref: MessageRef, st: SendState, flags: Set<string>) {
    const uid = String(ref.uid);
    const mine = (st.flag = `$mcpclaim.${stamp()}`);
    const others = (f: Set<string>) => [...f].filter((x) => CLAIM_RE.test(x) && x.toLowerCase() !== mine);
    const live = (f: Set<string>) => others(f).filter((x) => leftMs(account, x) > 0);
    const reread = async () => checkFlags(account, st, (await c.fetchOne(uid, { uid: true, flags: true }, { uid: true }) || undefined)?.flags);
    for (let attempt = 1; ; attempt++) {
      const stale = others(flags).filter((x) => leftMs(account, x) <= 0);
      if (stale.length) filed(await c.messageFlagsRemove(uid, stale, { uid: true }));
      if (!live(flags).length) {
        filed(await c.messageFlagsAdd(uid, [mine], { uid: true }));
        flags = await reread();
        if (!hasFlag(flags, mine)) { st.flag = undefined; return false; }
        if (!live(flags).length) return true;
        filed(await c.messageFlagsRemove(uid, [mine], { uid: true }));
      }
      if (attempt === 5) throw busy(account, st, Math.max(0, ...live(flags).map((x) => leftMs(account, x))));
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 400));
      flags = await reread();
    }
  }

  // Holding folders this process has seen for longer than staleMs: their drafts (never maybe-sent ones) go back to Drafts.
  async function sweep(account: Account, c: ImapFlow, folders: ListResponse[], drafts: string) {
    const back = new Set<string>();
    for (const f of folders) {
      if (HOLD_RE.test(f.name) && leftMs(account, f.path) <= 0) {
        if (await putBack(c, f.path, drafts, { draft: true }).catch(() => 0)) back.add(f.path);
      }
    }
    return back;
  }

  // The draft is not in Drafts: an earlier attempt may hold it in its own folder. Says where it is and what that means.
  async function whereIs(account: Account, c: ImapFlow, ref: MessageRef, st: SendState): Promise<AccountError> {
    if (!c.capabilities.has('MOVE')) return alreadySent(account, st);
    const folders = (await c.list()).filter((f) => HOLD_RE.exec(f.name)?.[1] === String(ref.uid));
    const back = await sweep(account, c, folders, ref.folder);
    for (const f of folders) {
      if (back.has(f.path)) {
        return new AccountError('not_found', `${account.label}: an earlier attempt to send that draft stopped before handing it to the sending server. It is back in ${q(st.drafts, 'Drafts')} with a new id: find it there and send it again.`, account.id);
      }
      const box = await c.mailboxOpen(f.path).catch(() => undefined);
      if (!box?.exists) continue;
      const m = await c.fetchOne('*', { uid: true, flags: true });
      if (!m || !m.flags) continue;
      if (!m.flags.has('\\Draft')) return unconfirmed(account, { ...st, hold: f.path }, true);
      return busy(account, st, Math.max(0, leftMs(account, f.path)), f.path);
    }
    return alreadySent(account, st);
  }

  async function claimHold(account: Account, c: ImapFlow, folders: ListResponse[], ref: MessageRef, st: SendState) {
    if (!c.capabilities.has('MOVE')) bad(account, 'the incoming server can neither mark nor move the draft while it is sent, so it cannot be sent safely.');
    if (!st.msgId) bad(account, 'the draft has no Message-ID header, so it cannot be sent safely from this server.');
    await sweep(account, c, folders, ref.folder); // left by a process that died
    st.hold = `MCP Sending ${stamp().replace('.', ' ')} ${ref.uid}`;
    await c.mailboxCreate(st.hold);
    await c.mailboxOpen(ref.folder);
    const r = await c.messageMove(String(ref.uid), st.hold, { uid: true });
    // The answer may lack COPYUID: our own folder, which nothing else uses, tells whether the draft is ours.
    st.holdUid = (r && r.uidMap?.get(ref.uid)) || (await uidsOf(c, st.hold, { header: { 'message-id': st.msgId } }))[0];
    if (st.holdUid) return;
    if (!(await uidsOf(c, ref.folder, { header: { 'message-id': st.msgId } })).length) throw await whereIs(account, c, ref, st);
    throw new AccountError('unreachable', `${account.label}: the draft could not be set aside for sending, so nothing was sent. It is still in ${q(st.drafts, 'Drafts')}; try again.`, account.id);
  }

  // Write-ahead: before SMTP opens, the server must hold (and show us) the mark that this draft may be delivered.
  async function markMaybeSent(account: Account, c: ImapFlow, ref: MessageRef, st: SendState) {
    const [box, uid] = st.flag ? [ref.folder, ref.uid] : [st.hold!, st.holdUid!];
    await c.mailboxOpen(box);
    st.marking = true;
    if (st.flag) filed(await c.messageFlagsAdd(String(uid), [MAYBE_SENT], { uid: true }));
    else filed(await c.messageFlagsRemove(String(uid), ['\\Draft'], { uid: true })); // no longer a draft: never put back
    const f = (await c.fetchOne(String(uid), { uid: true, flags: true }, { uid: true }) || undefined)?.flags;
    if (!f || (st.flag ? !hasFlag(f, MAYBE_SENT) || !hasFlag(f, st.flag) : f.has('\\Draft'))) {
      throw new AccountError('unreachable', `${account.label}: the incoming server did not keep the mark that the draft is being sent, so nothing was sent. It is still in ${q(st.drafts, 'Drafts')}; try again.`, account.id);
    }
  }

  // Makes the claim final on the server: released (nothing was sent), or marked as sent or maybe sent.
  async function settle(account: Account, c: ImapFlow, ref: MessageRef, st: SendState) {
    const mark = st.outcome === 'sent' ? WAS_SENT : st.outcome === 'unconfirmed' ? MAYBE_SENT : undefined;
    if (st.flag) {
      const uids = await uidsOf(c, ref.folder, { keyword: st.flag }); // our own keyword finds the draft wherever its UID is
      if (uids.length && mark) filed(await c.messageFlagsAdd(uids, [mark], { uid: true }));
      // a definite failure also clears our write-ahead mark (never one a winning process set)
      if (uids.length) filed(await c.messageFlagsRemove(uids, mark || !st.marking ? [st.flag] : [st.flag, MAYBE_SENT], { uid: true }));
    } else if (st.hold && !mark) { // marked: the write-ahead already made it no longer a draft
      const byId = { header: { 'message-id': st.msgId! } };
      await putBack(c, st.hold, ref.folder, byId);
      const uid = Math.max(0, ...(await uidsOf(c, ref.folder, byId)));
      if (uid && uid !== ref.uid) movedBack.set(refKey(account, ref), { ...ref, uid });
    }
    st.settled = true;
  }

  // After SMTP accepted it: mark the draft as sent, keep a copy in Sent, then remove the draft.
  async function finish(account: Account, c: ImapFlow, ref: MessageRef, st: SendState, source: Buffer) {
    await settle(account, c, ref, st);
    if (st.hold) {
      const uids = await uidsOf(c, st.hold, { header: { 'message-id': st.msgId! } });
      filed(uids.length && await c.messageFlagsAdd(uids, ['\\Seen'], { uid: true }));
      st.sent ??= (await c.mailboxCreate('Sent')).path;
      filed(await c.messageMove(uids, st.sent, { uid: true }));
      st.filed = st.removed = true;
      await c.mailboxOpen(ref.folder);
      await c.mailboxDelete(st.hold).catch(() => {}); // an empty folder left behind is harmless
      return;
    }
    if (account.provider !== 'gmail') { // Gmail files SMTP mail in Sent by itself
      st.sent ??= (await c.mailboxCreate('Sent')).path;
      filed(await c.append(st.sent, source, ['\\Seen']));
    }
    st.filed = true;
    await c.mailboxOpen(ref.folder);
    // Never a plain EXPUNGE: it would also remove other messages marked deleted.
    if (c.capabilities.has('UIDPLUS')) filed(await c.messageDelete(String(ref.uid), { uid: true }));
    else filed(await c.messageFlagsAdd(String(ref.uid), ['\\Deleted'], { uid: true })); // shortcut: left for the mail app to expunge
    st.removed = true;
  }

  async function sendOnce(account: Account, s: Session, ref: MessageRef, st: SendState) {
    const c = await s.imap();
    const folders = await c.list();
    st.drafts = findFolder(folders, '\\Drafts', ['drafts']);
    st.sent = findFolder(folders, '\\Sent', SENT_NAMES);
    if (ref.folder !== st.drafts) bad(account, 'only drafts can be sent, and that id is not in the Drafts folder.');
    await openRef(account, c, ref, false);
    const keywords = !c.mailbox || !c.mailbox.permanentFlags || c.mailbox.permanentFlags.has('\\*');
    const m = await c.fetchOne(String(ref.uid), { uid: true, flags: true, source: true }, { uid: true });
    if (!m || !m.source) throw await whereIs(account, c, ref, st);
    const flags = checkFlags(account, st, m.flags);
    if (!flags.has('\\Draft')) bad(account, 'that message is not a draft.');
    const parsed = await simpleParser(m.source);
    const from = addrsOf(parsed.from);
    if (from.length !== 1 || from[0].toLowerCase() !== account.address.toLowerCase()) bad(account, `that draft is not from ${account.address}.`);
    const rcpts = [...addrsOf(parsed.to), ...addrsOf(parsed.cc), ...addrsOf(parsed.bcc)];
    if (!rcpts.length) bad(account, 'the draft has no recipients.');
    st.msgId = parsed.messageId;

    if (s.expired) throw timeoutError(account);
    try {
      // a server that silently drops our keyword gets the holding-folder claim instead (or a refusal without MOVE)
      if (!(keywords && await claimKeyword(account, c, ref, st, flags))) await claimHold(account, c, folders, ref, st);
      await markMaybeSent(account, c, ref, st);
      if (s.expired) throw timeoutError(account); // never start SMTP after the deadline
      let info: { rejected?: unknown[] };
      try {
        info = await s.smtp((line) => { if (/^354/.test(line)) st.dataBegan = true; })
          .sendMail({ envelope: { from: account.address, to: rcpts }, raw: stripBcc(m.source) });
      } catch (e) {
        // The reply code decides: any refusal is definite; only a drop or silence after 354 may still have delivered it.
        const reply = (e as { responseCode?: number }).responseCode;
        const definite = !st.dataBegan || (reply !== undefined && reply >= 400);
        st.outcome = definite ? 'none' : 'unconfirmed';
        throw (st.error = definite ? toAccountError(e, account, 'sending') : unconfirmed(account, st));
      }
      const refused = (info.rejected ?? []).map((r) => (typeof r === 'string' ? r : (r as { address?: string }).address));
      st.outcome = 'sent';
      st.result = { sent: true, messageIdHeader: parsed.messageId ?? '' };
      if (refused.length) st.result.warning = `The sending server refused these recipients, so they did not get it: ${refused.join(', ')}.`;
    } catch (e) {
      st.outcome ??= 'none';
      await settle(account, c, ref, st).catch(() => {}); // if this fails, sendDraft retries on a fresh connection
      throw e;
    }
    await finish(account, c, ref, st, m.source);
  }

  return {
    async search(account, creds, o: SearchOptions = {}) {
      const folder = cleanText(account, 'folder', o.folder) ?? 'INBOX';
      const query = cleanText(account, 'query', o.query?.trim());
      const from = cleanText(account, 'from', o.from);
      const since = cleanDate(account, 'since', o.since);
      const before = cleanDate(account, 'before', o.before);
      const n = o.limit === undefined ? 20 : Number(o.limit);
      if (!Number.isFinite(n) || n < 1) bad(account, 'limit must be a number of at least 1 (at most 50 are returned).');
      const limit = Math.min(50, Math.floor(n));

      return session(account, creds, timeoutMs, async (s) => {
        const c = await s.imap();
        const mb = await c.mailboxOpen(folder, { readOnly: true }); // EXAMINE: nothing gets marked read
        const criteria: SearchObject = {};
        if (query) {
          if (account.provider === 'gmail' && c.capabilities.has('X-GM-EXT-1')) criteria.gmraw = query;
          else criteria.or = [{ subject: query }, { from: query }, { body: query }];
        }
        if (from) criteria.from = from;
        if (since) criteria.since = since;
        if (before) criteria.before = before;
        if (o.unreadOnly) criteria.seen = false;
        if (Object.keys(criteria).length === 0) criteria.all = true;

        const page = await newestUids(account, c, criteria, limit, mb.uidNext);
        if (page.length === 0) return [];
        const msgs = new Map<number, FetchMessageObject>();
        const meta = { uid: true, envelope: true, flags: true, internalDate: true } as const;
        const fetchInto = async (uids: number[], query: FetchQueryObject) => {
          for await (const m of c.fetch(uids.join(','), query, { uid: true })) msgs.set(m.uid, { ...msgs.get(m.uid), ...m });
        };
        // A message whose MIME structure the server or parser cannot handle is listed without it.
        await fetchInto(page, { ...meta, bodyStructure: true }).catch(async () => {
          await fetchInto(page, meta);
          for (const u of page) await fetchInto([u], { uid: true, bodyStructure: true }).catch(() => {});
        });
        // Snippets: the first 2 KB of each text part, one FETCH per distinct part number.
        const byPart = new Map<string, number[]>();
        for (const m of msgs.values()) {
          const p = textPart(m.bodyStructure);
          if (p) byPart.set(p.part ?? 'TEXT', [...(byPart.get(p.part ?? 'TEXT') ?? []), m.uid]);
        }
        const snippets = new Map<number, string>();
        for (const [key, uids] of byPart) {
          for await (const m of c.fetch(uids.join(','), { uid: true, bodyParts: [{ key, start: 0, maxLength: SNIPPET_BYTES }] }, { uid: true })) {
            const raw = m.bodyParts?.get(key) ?? m.bodyParts?.get(key.toLowerCase());
            const node = textPart(msgs.get(m.uid)?.bodyStructure);
            if (raw && node) snippets.set(m.uid, snippetText(decodePart(raw, node)));
          }
        }
        return page.flatMap((u) => {
          const m = msgs.get(u);
          return m ? [summary(account, folder, mb.uidValidity, m, snippets.get(u) ?? '')] : [];
        });
      });
    },

    async read(account, creds, id, maxChars = 20_000) {
      const ref = decodeId(account, id);
      const cap = Math.min(1_000_000, Math.max(1, Math.floor(Number(maxChars) || 20_000)));
      return session(account, creds, timeoutMs, async (s) => {
        const c = await s.imap();
        await openRef(account, c, ref, true);
        const m = await c.fetchOne(String(ref.uid), { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true });
        if (!m) throw notFound(account);
        // A structure the server refuses to give makes the message read as empty and truncated.
        let refused = false;
        m.bodyStructure = await c.fetchOne(String(ref.uid), { uid: true, bodyStructure: true }, { uid: true })
          .then((x) => (x ? x.bodyStructure : undefined), (e) => { if (!c.usable) throw e; refused = true; return undefined; });
        const inDrafts = ref.folder === findFolder(await c.list(), '\\Drafts', ['drafts']);

        const download = async (part: string | undefined, maxBytes: number) => {
          const dl = await c.download(String(ref.uid), part, { uid: true, maxBytes });
          const chunks: Buffer[] = [];
          for await (const chunk of dl.content ?? []) chunks.push(chunk as Buffer);
          const raw = Buffer.concat(chunks);
          return { raw, hitLimit: raw.length >= maxBytes };
        };
        const part = textPart(m.bodyStructure);
        let text: string;
        let truncated: boolean;
        if (refused) {
          text = '';
          truncated = true;
        } else if (part) {
          const { raw, hitLimit } = await download(part.part ?? '1', cap * 4 + 1024);
          truncated = hitLimit;
          text = raw.toString('utf8');
          if (truncated) text = text.replace(/\uFFFD$/, '');
          if (part.type === 'text/html') text = htmlText(text);
        } else {
          // No text part in the structure (odd or very deep MIME): parse a bounded piece of the source instead.
          const got = await download(undefined, Math.max(SOURCE_FALLBACK_BYTES, cap * 4)).catch((e) => { if (c.usable) return undefined; throw e; }); // the server refused it; a lost connection is still an error
          truncated = !got || got.hitLimit;
          const p = got && await simpleParser(got.raw).catch(() => undefined);
          if (!p) truncated = true;
          text = p?.text || (p?.html ? htmlText(p.html) : '');
        }
        if (text.length > cap) { text = cut(text, cap); truncated = true; }

        const base = summary(account, ref.folder, BigInt(ref.uidValidity), m, snippetText(text));
        return {
          ...base,
          cc: fmtList(m.envelope?.cc),
          ...(inDrafts && { bcc: fmtList(m.envelope?.bcc) }),
          messageIdHeader: m.envelope?.messageId || undefined,
          text,
          truncated,
          attachments: attachmentsOf(m.bodyStructure),
        } satisfies MessageFull;
      });
    },

    async readAttachment(account, creds, id, n, maxBytes) {
      const ref = decodeId(account, id);
      return session(account, creds, timeoutMs, async (s) => {
        const c = await s.imap();
        await openRef(account, c, ref, true);
        const m = await c.fetchOne(String(ref.uid), { uid: true, bodyStructure: true }, { uid: true });
        if (!m) throw notFound(account);
        const node = walk(m.bodyStructure).filter(isAttachment)[n - 1];
        if (!node) throw new AccountError('not_found', `${account.label}: that message has no attachment ${n}.`, account.id);
        const dl = await c.download(String(ref.uid), node.part ?? '1', { uid: true, maxBytes: maxBytes + 1 });
        const chunks: Buffer[] = [];
        let got = 0;
        for await (const chunk of dl.content ?? []) { chunks.push(chunk as Buffer); got += (chunk as Buffer).length; if (got > maxBytes) break; }
        const data = Buffer.concat(chunks);
        return { filename: filenameOf(node) ?? 'unnamed', contentType: node.type, data: data.subarray(0, maxBytes), truncated: data.length > maxBytes };
      });
    },

    async createDraft(account, creds, draft: DraftInput) {
      const to = cleanAddresses(account, 'to', draft?.to, true);
      const cc = cleanAddresses(account, 'cc', draft?.cc, false);
      const bcc = cleanAddresses(account, 'bcc', draft?.bcc, false);
      let subject = cleanText(account, 'subject', draft.subject) ?? '';
      if (typeof draft.text !== 'string') bad(account, 'text must be text.');
      if (Buffer.byteLength(draft.text) > MAX_BODY_BYTES) bad(account, 'the message body is larger than 1 MB.');
      const replyRef = draft.inReplyToId === undefined ? undefined : decodeId(account, draft.inReplyToId);

      return session(account, creds, timeoutMs, async (s) => {
        const c = await s.imap();
        let inReplyTo: string | undefined;
        let references: string[] | undefined;
        if (replyRef) {
          await openRef(account, c, replyRef, true);
          const m = await c.fetchOne(String(replyRef.uid), { uid: true, envelope: true, headers: ['references'] }, { uid: true });
          if (!m) throw notFound(account, 'The message you are replying to');
          inReplyTo = msgIds(m.envelope?.messageId)[0];
          const prior = msgIds(m.headers?.toString('utf8'));
          references = [...prior, ...(inReplyTo ? [inReplyTo] : [])];
          subject = subject || m.envelope?.subject || '';
          if (!/^re:/i.test(subject)) subject = `Re: ${subject}`;
        }

        // The stream transport keeps Bcc in the stored draft; sendDraft strips it before SMTP.
        const built = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
          from: account.address, to, cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined,
          subject, text: draft.text, inReplyTo, references: references?.length ? references : undefined,
        });
        const raw = built.message as Buffer;

        const drafts = findFolder(await c.list(), '\\Drafts', ['drafts']) ?? (await c.mailboxCreate('Drafts')).path;
        const res = await c.append(drafts, raw, ['\\Draft', '\\Seen']);
        if (res && res.uid && res.uidValidity !== undefined) return { draftId: encodeId(drafts, res.uidValidity, res.uid) };
        // No UIDPLUS: find the draft we just saved by its Message-ID.
        const mb = await c.mailboxOpen(drafts, { readOnly: true });
        const found = (await c.search({ header: { 'message-id': built.messageId } }, { uid: true })) || [];
        if (!found.length) throw new AccountError('unreachable', `${account.label}: the draft was saved but could not be located.`, account.id);
        return { draftId: encodeId(drafts, mb.uidValidity, Math.max(...found)) };
      });
    },

    async sendDraft(account, creds, draftId) {
      if (!account.allowSend) {
        throw new AccountError('send_disabled', `${account.label}: sending is turned off for this account. The user can turn it on in settings.`, account.id);
      }
      let ref = decodeId(account, draftId);
      for (;;) { // wait for clean-ups still running, and follow put-backs to where the draft is now
        const pending = settling.get(refKey(account, ref));
        if (pending) { await pending; continue; }
        const next = movedBack.get(refKey(account, ref));
        if (!next) break;
        ref = next;
      }
      const key = refKey(account, ref);
      const st: SendState = {};
      if (sending.has(key)) throw busy(account, st);
      sending.add(key);
      try {
        await session(account, creds, timeoutMs, (s) => sendOnce(account, s, ref, st));
      } catch (e) {
        if (!st.result) {
          st.outcome ??= st.dataBegan ? 'unconfirmed' : 'none';
          st.error ??= st.outcome === 'unconfirmed' ? unconfirmed(account, st) : toAccountError(e, account);
        }
        if ((st.flag || st.hold) && !st.settled) {
          // A dropped connection or the deadline cut in: finish the clean-up on a fresh connection.
          const p = session(account, creds, timeoutMs, async (s) => settle(account, await s.imap(), ref, st))
            .catch(() => {}).finally(() => settling.delete(key));
          settling.set(key, p);
        }
        if (!st.result) throw st.error;
      } finally {
        sending.delete(key);
      }
      const warning = [st.result!.warning, tidyWarning(st)].filter(Boolean).join(' ');
      return warning ? { ...st.result!, warning } : st.result!;
    },

    async verify(account, creds) {
      await session(account, creds, timeoutMs, async (s) => {
        await s.imap();
        if (account.allowSend) await s.smtp().verify().catch(smtpFails(account));
      });
    },
  };
}
