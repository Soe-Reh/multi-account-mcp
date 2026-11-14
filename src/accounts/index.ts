/// <reference types="node" />  // TypeScript 7 no longer auto-loads @types; drop once tsconfig lists "types": ["node"].
import { chmod, copyFile, link, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { homedir, uptime } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { AccountError, type Account, type AccountStore, type ServerEndpoint, type Secret } from '../types.js';

export { providerPreset, slugify, parseAutoconfig, lookupPreset } from './presets.js';

export const SERVICE = 'multi-account-mcp';

/** The slice of a keychain the store needs. Values are JSON strings; get resolves null when missing. */
export interface KeyringLike {
  get(id: string): Promise<string | null | undefined>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export type SecretBackend = 'keychain' | 'file';

async function systemKeyring(): Promise<KeyringLike> {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  const entry = (id: string) => new AsyncEntry(SERVICE, id);
  return {
    get: (id) => entry(id).getPassword(),
    set: (id, v) => entry(id).setPassword(v),
    delete: async (id) => { await entry(id).deleteCredential(); },
  };
}

// ---------- validation ----------

const bad = (msg: string): never => { throw new AccountError('invalid_input', msg); };
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const REF_RE = /^[0-9a-f-]{36}$/;
// Control characters, line separators and bidi controls can fake what a label shows; emoji joiners (ZWJ) are fine.
const BAD_LABEL_RE = /[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
// Unicode local parts and domains are allowed; whitespace, control chars and header-breaking punctuation are not.
const ADDRESS_RE = /^[^\s\p{C}@<>,;:"()[\]\\]+@[^\s\p{C}@<>,;:"()[\]\\]+\.[^\s\p{C}@<>,;:"()[\]\\.]+$/u;

function checkId(id: unknown): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) bad('id must be 1-40 characters of a-z, 0-9 and "-", and must start and end with a letter or digit');
  return id as string;
}

function checkLabel(label: unknown): string {
  if (typeof label !== 'string') return bad('label must be a string');
  const s = label.trim();
  if (!s || s.length > 100 || BAD_LABEL_RE.test(s)) bad('label must be 1-100 printable characters');
  return s;
}

function checkEndpoint(e: unknown, name: string): ServerEndpoint {
  const { host, port, secure } = (e ?? {}) as ServerEndpoint;
  if (typeof host !== 'string' || !(HOST_RE.test(host) || isIP(host))) bad(`${name}.host is not a valid host name or IP address`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) bad(`${name}.port must be an integer 1-65535`);
  if (typeof secure !== 'boolean') bad(`${name}.secure must be true or false`);
  return { host: host.toLowerCase(), port, secure };
}

function checkAccount(a: Omit<Account, 'addedAt'>): Omit<Account, 'addedAt'> {
  if (!a || typeof a !== 'object') bad('account must be an object');
  const address = typeof a.address === 'string' ? a.address.trim() : '';
  if (address.length > 254 || !ADDRESS_RE.test(address)) bad('address is not a valid email address');
  if (a.service !== 'email') bad('service must be "email"');
  if (!['gmail', 'outlook', 'yahoo', 'imap'].includes(a.provider)) bad('provider must be gmail, outlook, yahoo or imap');
  if (a.auth !== 'password' && a.auth !== 'oauth') bad('auth must be "password" or "oauth"');
  if (a.allowSend !== undefined && typeof a.allowSend !== 'boolean') bad('allowSend must be true or false');
  if (a.sendWithoutConfirm !== undefined && typeof a.sendWithoutConfirm !== 'boolean') bad('sendWithoutConfirm must be true or false');
  // Copy known fields only, so a stray secret on the input never reaches accounts.json.
  return {
    id: checkId(a.id), label: checkLabel(a.label), service: 'email', provider: a.provider, address, auth: a.auth,
    imap: checkEndpoint(a.imap, 'imap'), smtp: checkEndpoint(a.smtp, 'smtp'), allowSend: a.allowSend === true,
    ...(a.sendWithoutConfirm === true && { sendWithoutConfirm: true }),
  };
}

function checkSecret(s: Secret): Secret {
  const str = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 16384;
  if (s?.kind === 'password' && str(s.password)) return { kind: 'password', password: s.password };
  if (s?.kind === 'oauth' && str(s.refreshToken)
    && (s.accessToken === undefined || str(s.accessToken))
    && (s.expiresAt === undefined || Number.isFinite(s.expiresAt))) {
    return { kind: 'oauth', refreshToken: s.refreshToken, accessToken: s.accessToken, expiresAt: s.expiresAt };
  }
  return bad('secret must be a non-empty password or OAuth refresh token');
}

/** The form used to spot the same mailbox typed differently. The address itself is stored as typed. */
function canon(address: string): string {
  const s = address.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC'); // upper then lower folds case (ß = SS)
  const at = s.lastIndexOf('@');
  if (at < 0) return s;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replaceAll('.', ''); // Gmail ignores dots and +tags
  return `${local}@${domain}`;
}

// ---------- errors and logging ----------

// stdout belongs to the MCP protocol, so everything the store says goes to stderr.
const warn = (msg: string) => { process.stderr.write(`multi-account-mcp: ${msg}\n`); };
const warned = new Set<string>();
const warnOnce = (key: string, msg: string) => { if (!warned.has(key)) { warned.add(key); warn(msg); } };

/** Absolute paths go on `.path`, never in the message: messages end up in AI tool output. */
const storeError = (message: string, path?: string, accountId?: string) =>
  Object.assign(new AccountError('store_corrupt', message, accountId), { path });

const REASONS: Record<string, string> = {
  EACCES: 'permission denied', EPERM: 'permission denied', ENOENT: 'the file or folder is missing',
};

/** Turns a raw file-system error into a coded one. */
function coded(e: unknown): never {
  const x = e as NodeJS.ErrnoException;
  if (e instanceof AccountError || !x?.syscall) throw e;
  const what = x.path ? basename(x.path) : 'the account store';
  throw storeError(`Could not ${x.syscall} ${what}: ${REASONS[x.code ?? ''] ?? x.code}. Check the account store folder, then try again.`, x.path);
}

// ---------- files ----------

async function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(data, null, 2) + '\n');
      await fh.sync(); // the data must be on disk before the rename points at it
    } finally { await fh.close(); }
    await rename(tmp, file);
  } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
  // Syncing the directory makes the rename itself survive a power cut. Windows cannot open a directory; skip there.
  const dh = await open(dirname(file), 'r').catch(() => undefined);
  if (dh) try { await dh.sync(); } catch { /* best-effort */ } finally { await dh.close(); }
}

/** Reads a store file (undefined when missing) and closes it to other users if it was left open to them. */
async function readStoreFile(file: string): Promise<string | undefined> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  if (process.platform !== 'win32' && ((await stat(file)).mode & 0o077)) {
    await chmod(file, 0o600);
    warnOnce(`mode:${file}`, `${basename(file)} could be read by other users on this computer. Access is now limited to you.`);
  }
  return raw;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Minutes since the epoch at which this computer booted; tells a pid from before a restart from a reused one. */
const boot = () => Math.round((Date.now() / 1000 - uptime()) / 60);
/** "<pid> <boot>": who holds the lock. Journal entries hold the pid only: a clock step must never make a live writer look dead. */
const me = () => `${process.pid} ${boot()}`;

/** True while the process named by an owner string runs. Garbage (never written by this code) counts as dead. */
function ownerAlive(owner: string): boolean {
  const [p, b] = owner.split(' ');
  if (!/^\d+$/.test(p ?? '')) return false;
  if (/^\d+$/.test(b ?? '') && Math.abs(Number(b) - boot()) > 2) return false; // written before a restart
  return alive(Number(p));
}

// shortcut: a lock file holding the owner's pid; fine for one CLI + one server, move to an OS file lock for heavy contention.
// A lock is never taken from a live process, however old. It is written whole (temp file + link) so it is never empty.
async function withLock<T>(dir: string, fn: (stillMine: () => Promise<void>) => Promise<T>): Promise<T> {
  const lock = join(dir, 'accounts.lock');
  const mine = `${me()} ${randomBytes(4).toString('hex')}`;
  const tmp = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, mine, { flag: 'wx', mode: 0o600 });
  try {
    for (const start = Date.now(); ;) {
      if (await link(tmp, lock).then(() => true, (e) => { if (e.code !== 'EEXIST') throw e; return false; })) break;
      if (await steal(lock, tmp)) break;
      if (Date.now() - start > 15_000) {
        throw new AccountError('timeout', 'The account store is in use by another program. Try again in a moment.');
      }
      await sleep(10 + Math.random() * 20);
    }
  } finally { await unlink(tmp).catch(() => {}); }
  const stillMine = async () => {
    if (await readFile(lock, 'utf8').catch(() => '') !== mine) {
      throw new AccountError('timeout', 'Another program took over the account store, so nothing was saved. Try again.');
    }
  };
  try { return await fn(stillMine); } finally {
    if (await readFile(lock, 'utf8').catch(() => '') === mine) await unlink(lock).catch(() => {});
  }
}

/**
 * Takes over a lock whose owner died. Each dead owner X has one successor slot, accounts.lock.next-X, created with
 * link() so exactly one waiter gets it. If that waiter dies too, the next one takes the slot after it, and so on.
 * Only the holder of the last slot may replace the lock, so two waiters never both win and a kill -9 at any step
 * leaves something the next waiter can take at once.
 */
async function steal(lock: string, tmp: string): Promise<boolean> {
  const walked: string[] = [];
  let owner = await readFile(lock, 'utf8').catch(() => undefined);
  while (owner !== undefined && !walked.includes(owner)) {
    if (ownerAlive(owner)) return false;
    walked.push(owner);
    const slot = `${lock}.next-${owner.replace(/\W/g, '_').slice(0, 80)}`;
    if (await link(tmp, slot).then(() => true, () => false)) {
      // Nobody else can change a dead lock now, so if it is still one we walked through it is ours to replace.
      if (!walked.includes(await readFile(lock, 'utf8').catch(() => ''))) return false;
      await rename(tmp, lock);
      return true;
    }
    owner = await readFile(slot, 'utf8').catch(() => undefined); // slot taken: follow whoever took it
  }
  return false;
}

// ---------- store ----------

/** What accounts.json holds per account: the public record plus the key its secret is saved under. */
type Stored = Account & { secretRef: string };
const toPublic = ({ secretRef: _ref, ...account }: Stored): Account => account;

/**
 * A keychain entry that may have to be deleted: one left by remove, or one an add or setSecret is writing right now
 * (owner set). It is deleted once no live owner is left and no account uses it.
 */
interface Pending { secretRef: string; owner?: string }
interface Db { backend?: SecretBackend; accounts: Stored[]; pendingDeletes: Pending[] }

const VERSION = 2;
// Version 1 (no version field) had no secretRef: each secret was saved under the account id.
const isRef = (r: unknown) => typeof r === 'string' && (REF_RE.test(r) || ID_RE.test(r));

export async function createAccountStore(opts: { dir?: string; keyring?: KeyringLike; secretFallback?: 'file' } = {}):
  Promise<AccountStore & { secretBackend(): SecretBackend | 'unavailable'; dir: string }> {
  const dir = opts.dir ?? process.env.MULTI_ACCOUNT_MCP_HOME ?? join(homedir(), '.multi-account-mcp');
  const accountsFile = join(dir, 'accounts.json');
  const secretsFile = join(dir, 'secrets.json');
  // mkdir applies the mode only to folders it creates; a folder that already existed keeps its permissions.
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(coded);

  const fileOptIn = opts.secretFallback === 'file' || process.env.MULTI_ACCOUNT_MCP_SECRETS === 'file';
  let keyring: KeyringLike | undefined; // kept only after a probe worked; a failed probe is tried again on the next call
  let lastBackend: SecretBackend | 'unavailable' = 'unavailable';

  async function probe(): Promise<KeyringLike | undefined> {
    if (keyring) return keyring;
    try {
      const k = opts.keyring ?? await systemKeyring();
      await k.get('__probe__');
      return keyring = k;
    } catch { return undefined; }
  }

  const unavailable = (message: string) => {
    lastBackend = 'unavailable';
    return new AccountError('keychain_unavailable', message);
  };

  /** Picks where secrets live for this call. Never moves away from the place existing accounts were saved in. */
  async function resolveBackend(db: Db): Promise<KeyringLike | undefined /* undefined = secrets.json */> {
    const recorded = db.accounts.length ? db.backend : undefined;
    if (recorded === 'file') {
      if (!fileOptIn) throw unavailable('The logins for these accounts are saved in a local file, and file storage is not turned on for this run. Set MULTI_ACCOUNT_MCP_SECRETS=file to keep using it.');
    } else {
      const kr = await probe();
      if (kr) { lastBackend = 'keychain'; return kr; }
      if (recorded === 'keychain') throw unavailable('The logins for these accounts are saved in the system keychain, which is not available right now. Unlock or turn on the keychain and try again. Nothing was moved to a file.');
      if (!fileOptIn) throw unavailable('The system keychain is not available, so logins cannot be saved safely. To save them in a local file that only your user can read instead, set MULTI_ACCOUNT_MCP_SECRETS=file and try again.');
    }
    warnOnce(`file:${dir}`, 'WARNING: the system keychain is not in use. Logins are saved unencrypted in secrets.json, readable only by your user.');
    lastBackend = 'file';
    return undefined;
  }

  async function load(): Promise<Db> {
    const raw = await readStoreFile(accountsFile);
    if (raw === undefined) return { accounts: [], pendingDeletes: [] };
    try {
      const data = JSON.parse(raw);
      const v1 = data?.version === undefined;
      if ((!v1 && data.version !== VERSION) || !Array.isArray(data.accounts) || ![undefined, 'keychain', 'file'].includes(data.backend)) throw 0;
      const pending = (data.pendingDeletes ?? []) as Pending[];
      if (!Array.isArray(pending) || !pending.every((p) => isRef(p?.secretRef) && ['undefined', 'string'].includes(typeof p.owner))) throw 0;
      const seen = new Set<string>();
      const accounts = (data.accounts as Stored[]).map((r) => {
        const a = checkAccount(r);
        if (typeof r.addedAt !== 'string' || Number.isNaN(Date.parse(r.addedAt))) throw 0;
        const secretRef = v1 && r?.secretRef === undefined ? a.id : r.secretRef; // migrated: the next save writes it down
        if (!isRef(secretRef)) throw 0;
        for (const key of [`id:${a.id}`, `address:${canon(a.address)}`, `ref:${secretRef}`]) {
          if (seen.has(key)) throw 0;
          seen.add(key);
        }
        return { ...a, addedAt: r.addedAt, secretRef };
      });
      return { backend: data.backend, accounts, pendingDeletes: pending.map(({ secretRef, owner }) => ({ secretRef, owner })) };
    } catch { /* fall through: a bad file is left exactly as it is and never written back */ }
    const copied = await copyFile(accountsFile, accountsFile + '.bak').then(() => true, () => false);
    throw storeError(`accounts.json is corrupt and was not changed.${copied ? ' A copy is at accounts.json.bak.' : ''} Fix or delete the file, then try again.`, accountsFile);
  }

  async function loadSecrets(): Promise<Record<string, unknown>> {
    const raw = await readStoreFile(secretsFile);
    if (raw === undefined) return {};
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch { /* fall through; never echo the parse error, it quotes file content */ }
    throw storeError('secrets.json is corrupt and was not changed. Fix or delete it, then add the logins again.', secretsFile);
  }

  /** Removes what a process killed mid-write left behind. Runs under the lock. */
  async function sweepFiles() {
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const tmp = /\.(\d+)\.[0-9a-f]+\.tmp$/.exec(f);
      if ((tmp && !alive(Number(tmp[1]))) || f.startsWith('accounts.lock.next-')) await unlink(join(dir, f)).catch(() => {});
    }
  }

  /** Drops secrets.json entries no account uses (a removed account, or an add killed before it saved). */
  async function sweepSecrets(db: Db) {
    const all = await loadSecrets().catch(() => undefined); // a damaged file is reported by the call that needs it
    if (!all) return;
    const used = new Set(db.accounts.map((a) => a.secretRef));
    const orphans = Object.keys(all).filter((k) => !used.has(k));
    if (!orphans.length) return;
    for (const k of orphans) delete all[k];
    await writeAtomic(secretsFile, all);
  }

  /** Runs fn on a fresh read of accounts.json under the lock and saves what it leaves in db. */
  const transact = <T>(fn: (db: Db) => Promise<T>) => withLock(dir, async (stillMine) => {
    const db = await load();
    await sweepFiles();
    const result = await fn(db);
    await stillMine();
    await writeAtomic(accountsFile, { version: VERSION, backend: db.backend, accounts: db.accounts, pendingDeletes: db.pendingDeletes });
    // After the save: a crash between the two leaves an unused secret, never an account without one.
    await sweepSecrets(db);
    return result;
  });

  /** Deletes keychain entries listed in pendingDeletes, outside the lock. Best-effort; what fails is tried on the next write. */
  async function flush() {
    const db = await load();
    const busy = new Set(db.pendingDeletes.filter((p) => p.owner && ownerAlive(p.owner)).map((p) => p.secretRef));
    const used = new Set(db.accounts.map((a) => a.secretRef));
    const todo = [...new Set(db.pendingDeletes.map((p) => p.secretRef))].filter((r) => !busy.has(r));
    if (!todo.length) return;
    const kr = todo.some((r) => !used.has(r)) ? await probe() : undefined;
    const done = new Set<string>();
    for (const r of todo) {
      if (!used.has(r)) {
        if (!kr) continue;
        // Some keychains throw when the entry is already gone; ask before calling that a failure.
        try { await kr.delete(r); } catch { if (await kr.get(r).catch(() => 'unknown') != null) continue; }
      }
      done.add(r);
    }
    if (done.size) {
      await transact(async (d) => {
        d.pendingDeletes = d.pendingDeletes.filter((p) => !done.has(p.secretRef) || (p.owner && ownerAlive(p.owner)));
      });
    }
  }
  const settle = () => flush().catch(() => {});

  const keychainError = (id: string) =>
    new AccountError('keychain_unavailable', `Could not use the system keychain for account "${id}"`, id);

  async function writeSecret(kr: KeyringLike | undefined, a: Stored, secret: Secret) {
    if (!kr) {
      const all = await loadSecrets();
      all[a.secretRef] = secret;
      return writeAtomic(secretsFile, all);
    }
    const value = JSON.stringify(secret);
    await kr.set(a.secretRef, value).catch(() => { throw keychainError(a.id); });
    if (await kr.get(a.secretRef).catch(() => undefined) !== value) {
      throw new AccountError('keychain_unavailable', `The system keychain did not keep the login for account "${a.id}". Unlock the keychain and try again.`, a.id);
    }
  }

  async function readSecret(kr: KeyringLike | undefined, a: Stored): Promise<Secret | undefined> {
    let value: unknown;
    if (kr) {
      const raw = await kr.get(a.secretRef).catch(() => { throw keychainError(a.id); });
      if (raw == null) return undefined;
      try { value = JSON.parse(raw); } catch { /* damaged: reported below without quoting it */ }
    } else {
      const all = await loadSecrets();
      if (!Object.hasOwn(all, a.secretRef)) return undefined;
      value = all[a.secretRef];
    }
    try { return checkSecret(value as Secret); } catch {
      throw storeError(`The saved login for account "${a.id}" is damaged. Save the login for this account again.`, undefined, a.id);
    }
  }

  const matchesAuth = (auth: Account['auth'], s: Secret) => {
    if (s.kind !== auth) bad(`this account signs in with ${auth === 'oauth' ? 'OAuth' : 'a password'}, so the login must be of that kind`);
  };

  /** The backend chosen before taking the lock must still be the one accounts.json records. */
  const sameBackend = (db: Db, kr: KeyringLike | undefined) => {
    if (db.accounts.length && db.backend && db.backend !== (kr ? 'keychain' : 'file')) {
      throw new AccountError('timeout', 'The account store changed while saving. Try again.');
    }
  };

  const find = (accounts: Stored[], key: string) => {
    const k = String(key ?? '').trim();
    return accounts.find((a) => a.id === k.toLowerCase() || canon(a.address) === canon(k));
  };
  const mustFind = (accounts: Stored[], id: string) => {
    const a = accounts.find((x) => x.id === id);
    if (!a) throw new AccountError('not_found', `No account with id "${id}"`, id);
    return a;
  };
  const dropPending = (db: Db, ref: string, owner: string) => {
    const i = db.pendingDeletes.findIndex((p) => p.secretRef === ref && p.owner === owner);
    if (i >= 0) db.pendingDeletes.splice(i, 1);
  };

  /** Runs a keychain write outside the lock, journaled so a kill -9 midway is cleaned up by a later write. */
  async function journaled(ref: string, check: (db: Db) => void, write: () => Promise<void>, finish: (db: Db) => void) {
    const owner = String(process.pid);
    await transact(async (db) => { check(db); db.pendingDeletes.push({ secretRef: ref, owner }); });
    try {
      await write();
      await transact(async (db) => { check(db); finish(db); dropPending(db, ref, owner); });
    } catch (e) {
      // Leave the entry without a live owner, so this or a later write deletes what the failed call may have saved.
      await transact(async (db) => { dropPending(db, ref, owner); db.pendingDeletes.push({ secretRef: ref }); }).catch(() => {});
      throw e;
    } finally { await settle(); }
  }

  // Shows the backend (and the file warning, if that applies) at startup; a failure here is reported by the first real call.
  await load().then(resolveBackend).catch(() => {});

  return {
    dir,
    secretBackend: () => lastBackend,

    list: () => load().then((db) => db.accounts.map(toPublic)).catch(coded),

    get: (idOrAddress) => load().then((db) => {
      const a = find(db.accounts, idOrAddress);
      return a && toPublic(a);
    }).catch(coded),

    add: async (input, secret) => {
      const clean = checkAccount(input);
      const sec = checkSecret(secret);
      matchesAuth(clean.auth, sec);
      const account: Stored = { ...clean, addedAt: new Date().toISOString(), secretRef: randomUUID() };
      const unique = (db: Db) => {
        const byId = db.accounts.find((a) => a.id === clean.id);
        if (byId) throw new AccountError('duplicate', `The id "${clean.id}" is already used by "${byId.label}"`, byId.id);
        const byAddr = db.accounts.find((a) => a.service === clean.service && canon(a.address) === canon(clean.address));
        if (byAddr) throw new AccountError('duplicate', `${clean.address} is already added as "${byAddr.label}"`, byAddr.id);
      };
      const append = (db: Db, backend: SecretBackend) => { db.accounts.push(account); db.backend = backend; };
      try {
        const pre = await load();
        unique(pre);
        const kr = await resolveBackend(pre); // any keychain probe happens here, before the lock
        if (!kr) {
          await transact(async (db) => { unique(db); sameBackend(db, kr); await writeSecret(kr, account, sec); append(db, 'file'); });
        } else {
          const check = (db: Db) => { unique(db); sameBackend(db, kr); };
          await journaled(account.secretRef, check, () => writeSecret(kr, account, sec), (db) => append(db, 'keychain'));
        }
        return toPublic(account);
      } catch (e) { return coded(e); }
    },

    update: (id, patch) => transact(async (db) => {
      checkId(id);
      const i = db.accounts.indexOf(mustFind(db.accounts, id));
      const a = db.accounts[i];
      const p = patch ?? {};
      if (p.allowSend !== undefined && typeof p.allowSend !== 'boolean') bad('allowSend must be true or false');
      if (p.sendWithoutConfirm !== undefined && typeof p.sendWithoutConfirm !== 'boolean') bad('sendWithoutConfirm must be true or false');
      const { sendWithoutConfirm: _old, ...rest } = a;
      const swc = p.sendWithoutConfirm ?? a.sendWithoutConfirm === true;
      db.accounts[i] = {
        ...rest,
        ...(swc && { sendWithoutConfirm: true }),
        label: p.label !== undefined ? checkLabel(p.label) : a.label,
        allowSend: p.allowSend ?? a.allowSend,
        imap: p.imap !== undefined ? checkEndpoint(p.imap, 'imap') : a.imap,
        smtp: p.smtp !== undefined ? checkEndpoint(p.smtp, 'smtp') : a.smtp,
      };
      return toPublic(db.accounts[i]);
    }).finally(settle).catch(coded),

    remove: async (id) => {
      try {
        checkId(id);
        // A file secret goes with the save (no opt-in needed); a keychain one is listed and deleted right after.
        const a = await transact(async (db) => {
          const a = mustFind(db.accounts, id);
          db.accounts = db.accounts.filter((x) => x !== a);
          if (db.backend !== 'file') db.pendingDeletes.push({ secretRef: a.secretRef });
          return a;
        });
        await settle();
        if ((await load()).pendingDeletes.some((p) => p.secretRef === a.secretRef)) {
          warn(`Account "${id}" was removed, but its saved login could not be deleted from the system keychain yet. It is no longer used, and deleting it is tried again on the next change.`);
        }
      } catch (e) { coded(e); }
    },

    getSecret: (id) => load().then(async (db) => {
      const a = mustFind(db.accounts, checkId(id));
      const s = await readSecret(await resolveBackend(db), a);
      if (!s) throw new AccountError('not_found', `No saved login for account "${id}". Save the login for this account again.`, id);
      return s;
    }).catch(coded),

    setSecret: async (id, secret) => {
      try {
        const sec = checkSecret(secret);
        checkId(id);
        const pre = await load();
        matchesAuth(mustFind(pre.accounts, id).auth, sec);
        const kr = await resolveBackend(pre);
        // Re-found under each lock: the account must still exist, with the same secret key.
        const current = (db: Db) => { sameBackend(db, kr); return mustFind(db.accounts, id); };
        if (!kr) return void await transact(async (db) => { await writeSecret(kr, current(db), sec); });
        const a = mustFind(pre.accounts, id);
        const check = (db: Db) => {
          if (current(db).secretRef !== a.secretRef) throw new AccountError('not_found', `No account with id "${id}"`, id);
        };
        await journaled(a.secretRef, check, () => writeSecret(kr, a, sec), () => {});
      } catch (e) { coded(e); }
    },
  };
}
