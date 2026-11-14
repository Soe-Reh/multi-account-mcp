import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountStore, type KeyringLike } from '../../src/accounts/index.js';
import { AccountError, type Account, type Secret } from '../../src/types.js';

const PASSWORD = 'hunter2-SECRET-xyz';

function fakeKeyring(opts: { broken?: boolean; failWrites?: boolean; dropWrites?: boolean; deleteThrows?: boolean } = {}) {
  const map = new Map<string, string>();
  const down = () => { if (opts.broken) throw new Error('no dbus'); };
  const kr: KeyringLike & { map: Map<string, string> } = {
    map,
    async get(id) { down(); return map.get(id) ?? null; },
    async set(id, v) { down(); if (opts.failWrites) throw new Error(`denied writing ${v}`); if (!opts.dropWrites) map.set(id, v); },
    async delete(id) { down(); if (opts.deleteThrows || !map.delete(id)) throw new Error('no such entry'); },
  };
  return kr;
}

function input(over: Partial<Account> = {}): Omit<Account, 'addedAt'> {
  return {
    id: 'jobs-gmail', label: 'Jobs Gmail', service: 'email', provider: 'gmail', address: 'Jobs@Gmail.com',
    auth: 'password', imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true }, allowSend: false, ...over,
  };
}
const pw: Secret = { kind: 'password', password: PASSWORD };

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return e instanceof AccountError ? e.code : `other:${(e as Error).message}`; }
  return 'resolved';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const readDb = async (d: string) => JSON.parse(await readFile(join(d, 'accounts.json'), 'utf8'));
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

let dir: string;
let stderr: string[];
let stdout: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mam-'));
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
  stdout = vi.spyOn(process.stdout, 'write');
});
afterEach(async () => {
  expect(stdout, 'stdout is reserved for the MCP protocol').not.toHaveBeenCalled();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('account store', () => {
  it('adds, lists, gets by id or address, and keeps secrets out of accounts.json', async () => {
    const kr = fakeKeyring();
    const s = await createAccountStore({ dir, keyring: kr });
    expect(s.secretBackend()).toBe('keychain');
    const a = await s.add({ ...input(), password: PASSWORD } as never, pw);
    expect(a.addedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await s.list()).toEqual([a]);
    expect(await s.get('jobs-gmail')).toEqual(a);
    expect(await s.get('JOBS@gmail.COM')).toEqual(a);
    expect(await s.get('nope')).toBeUndefined();
    expect(await s.getSecret('jobs-gmail')).toEqual(pw);
    expect(a).not.toHaveProperty('secretRef');
    const [[ref, saved]] = [...kr.map];
    expect(ref).toMatch(UUID);
    expect(JSON.parse(saved)).toEqual(pw);
    expect(await readDb(dir)).toMatchObject({ backend: 'keychain', accounts: [{ id: 'jobs-gmail', secretRef: ref }] });
    const raw = await readFile(join(dir, 'accounts.json'), 'utf8');
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toMatch(/"password"\s*:/);
  });

  it('sets file mode 0600 and dir mode 0700', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    await s.add(input(), pw);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'accounts.json'))).mode & 0o777).toBe(0o600);
  });

  it('uses MULTI_ACCOUNT_MCP_HOME when no dir is given', async () => {
    process.env.MULTI_ACCOUNT_MCP_HOME = join(dir, 'home');
    try {
      const s = await createAccountStore({ keyring: fakeKeyring() });
      expect(s.dir).toBe(join(dir, 'home'));
      await s.add(input(), pw);
      expect(JSON.parse(await readFile(join(dir, 'home', 'accounts.json'), 'utf8')).accounts).toHaveLength(1);
    } finally { delete process.env.MULTI_ACCOUNT_MCP_HOME; }
  });

  it('defaults allowSend to false', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    const { allowSend, ...rest } = input();
    expect((await s.add(rest as never, pw)).allowSend).toBe(false);
  });

  it('rejects duplicate id and duplicate address (case-insensitive), naming the existing label', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    await s.add(input(), pw);
    await expect(s.add(input({ address: 'other@gmail.com' }), pw)).rejects.toMatchObject({ code: 'duplicate', message: expect.stringContaining('Jobs Gmail') });
    await expect(s.add(input({ id: 'other', address: 'jobs@GMAIL.com' }), pw)).rejects.toMatchObject({ code: 'duplicate', message: expect.stringContaining('Jobs Gmail') });
    expect(await s.list()).toHaveLength(1);
  });

  it('returns not_found for unknown ids', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    expect(await code(s.update('ghost', { label: 'x' }))).toBe('not_found');
    expect(await code(s.remove('ghost'))).toBe('not_found');
    expect(await code(s.getSecret('ghost'))).toBe('not_found');
    expect(await code(s.setSecret('ghost', pw))).toBe('not_found');
  });

  it('updates only allowed fields and validates them', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    await s.add(input(), pw);
    const u = await s.update('jobs-gmail', { label: 'Work', allowSend: true, address: 'x@y.com' } as never);
    expect(u).toMatchObject({ label: 'Work', allowSend: true, address: 'Jobs@Gmail.com' });
    expect(await s.get('jobs-gmail')).toEqual(u);
    expect(await code(s.update('jobs-gmail', { imap: { host: 'a b', port: 993, secure: true } }))).toBe('invalid_input');
    expect(await code(s.update('jobs-gmail', { smtp: { host: 'h.com', port: 0, secure: true } }))).toBe('invalid_input');
    expect(await code(s.update('jobs-gmail', { label: '' }))).toBe('invalid_input');
    expect(await code(s.update('jobs-gmail', { allowSend: 'yes' as never }))).toBe('invalid_input');
  });

  it('sendWithoutConfirm defaults off, can be turned on and off, and survives a reload', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    expect((await s.add(input(), pw)).sendWithoutConfirm).toBeUndefined();
    expect(await s.update('jobs-gmail', { allowSend: true, sendWithoutConfirm: true })).toMatchObject({ sendWithoutConfirm: true });
    expect((await s.update('jobs-gmail', { label: 'Work' })).sendWithoutConfirm).toBe(true);
    expect((await (await createAccountStore({ dir, keyring: fakeKeyring() })).get('jobs-gmail'))?.sendWithoutConfirm).toBe(true);
    expect((await s.update('jobs-gmail', { sendWithoutConfirm: false })).sendWithoutConfirm).toBeUndefined();
    expect(await code(s.update('jobs-gmail', { sendWithoutConfirm: 1 as never }))).toBe('invalid_input');
  });

  it('remove deletes the secret too', async () => {
    const kr = fakeKeyring();
    const s = await createAccountStore({ dir, keyring: kr });
    await s.add(input(), pw);
    await s.remove('jobs-gmail');
    expect(kr.map.size).toBe(0);
    expect(await s.list()).toEqual([]);
  });

  it('setSecret replaces the secret and validates it, and the secret kind must match account.auth', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    await s.add(input(), pw);
    const oauth: Secret = { kind: 'oauth', refreshToken: 'r1', accessToken: 'a1', expiresAt: 123 };
    expect(await code(s.setSecret('jobs-gmail', oauth))).toBe('invalid_input');
    expect(await code(s.add(input({ id: 'o', address: 'o@x.com' }), oauth))).toBe('invalid_input');
    expect(await code(s.add(input({ id: 'o', address: 'o@x.com', auth: 'oauth' }), pw))).toBe('invalid_input');
    await s.setSecret('jobs-gmail', { kind: 'password', password: 'new' });
    expect(await s.getSecret('jobs-gmail')).toEqual({ kind: 'password', password: 'new' });
    await s.add(input({ id: 'o', address: 'o@x.com', auth: 'oauth' }), { kind: 'oauth', refreshToken: 'r0' });
    await s.setSecret('o', oauth);
    expect(await s.getSecret('o')).toEqual(oauth);
    expect((await readDb(dir)).pendingDeletes).toEqual([]);
    expect(await code(s.setSecret('jobs-gmail', { kind: 'password', password: '' }))).toBe('invalid_input');
    expect(await code(s.setSecret('jobs-gmail', { kind: 'oauth' } as never))).toBe('invalid_input');
  });

  it('getSecret is not_found when the keychain entry is gone', async () => {
    const kr = fakeKeyring();
    const s = await createAccountStore({ dir, keyring: kr });
    await s.add(input(), pw);
    kr.map.clear();
    expect(await code(s.getSecret('jobs-gmail'))).toBe('not_found');
  });

  it('uses a 0600 secrets.json only with the explicit file opt-in, and warns once on stderr', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring({ broken: true }), secretFallback: 'file' });
    expect(s.secretBackend()).toBe('file');
    await s.add(input(), pw);
    await s.add(input({ id: 'b', address: 'b@yahoo.com' }), { kind: 'password', password: 'p2' });
    expect(await s.getSecret('jobs-gmail')).toEqual(pw);
    expect((await stat(join(dir, 'secrets.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, 'accounts.json'), 'utf8')).not.toContain(PASSWORD);
    await s.remove('jobs-gmail');
    const left = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'));
    expect(Object.values(left)).toEqual([{ kind: 'password', password: 'p2' }]);
    expect((await readDb(dir)).backend).toBe('file');
    expect(stderr.filter((l) => /unencrypted/.test(l))).toHaveLength(1);
  });

  it('the file opt-in also works through MULTI_ACCOUNT_MCP_SECRETS=file', async () => {
    process.env.MULTI_ACCOUNT_MCP_SECRETS = 'file';
    try {
      const s = await createAccountStore({ dir, keyring: fakeKeyring({ broken: true }) });
      await s.add(input(), pw);
      expect(s.secretBackend()).toBe('file');
      expect(await s.getSecret('jobs-gmail')).toEqual(pw);
    } finally { delete process.env.MULTI_ACCOUNT_MCP_SECRETS; }
  });

  it('never falls back to a file by default: a missing keychain is a coded error that says how to opt in', async () => {
    const kr = fakeKeyring();
    const ok = await createAccountStore({ dir, keyring: kr });
    await ok.add(input(), pw);

    const s = await createAccountStore({ dir: join(dir, 'new'), keyring: fakeKeyring({ broken: true }) });
    expect(s.secretBackend()).toBe('unavailable');
    const err = await s.add(input(), pw).catch((e) => e);
    expect(err).toMatchObject({ code: 'keychain_unavailable', message: expect.stringContaining('MULTI_ACCOUNT_MCP_SECRETS=file') });
    expect(await s.list()).toEqual([]);
    await expect(stat(join(dir, 'new', 'secrets.json'))).rejects.toThrow();

    const down = await createAccountStore({ dir, keyring: fakeKeyring({ broken: true }) });
    expect(await code(down.getSecret('jobs-gmail'))).toBe('keychain_unavailable');
    expect(await code(down.setSecret('jobs-gmail', pw))).toBe('keychain_unavailable');
    expect(await down.list()).toHaveLength(1); // reading the list needs no keychain
  });

  it('re-probes the keychain on the next call instead of locking in a failed probe', async () => {
    const opts = { broken: true };
    const s = await createAccountStore({ dir, keyring: fakeKeyring(opts) });
    expect(await code(s.add(input(), pw))).toBe('keychain_unavailable');
    opts.broken = false;
    await s.add(input(), pw);
    expect(s.secretBackend()).toBe('keychain');
    expect(await s.getSecret('jobs-gmail')).toEqual(pw);
  });

  it('refuses to switch secret backend while accounts exist', async () => {
    // saved in the keychain, keychain later down, file opt-in set: must not start a second secret store
    const kr = fakeKeyring();
    await (await createAccountStore({ dir, keyring: kr })).add(input(), pw);
    const s = await createAccountStore({ dir, keyring: fakeKeyring({ broken: true }), secretFallback: 'file' });
    const other = input({ id: 'b', address: 'b@yahoo.com' });
    await expect(s.add(other, pw)).rejects.toMatchObject({ code: 'keychain_unavailable', message: expect.stringContaining('Nothing was moved') });
    expect(await code(s.getSecret('jobs-gmail'))).toBe('keychain_unavailable');
    await expect(stat(join(dir, 'secrets.json'))).rejects.toThrow();
    expect((await readDb(dir)).backend).toBe('keychain');

    // saved in the file, later run without the opt-in: must not quietly move to the keychain
    const d2 = join(dir, 'file-home');
    await (await createAccountStore({ dir: d2, keyring: fakeKeyring({ broken: true }), secretFallback: 'file' })).add(input(), pw);
    const kr2 = fakeKeyring();
    const s2 = await createAccountStore({ dir: d2, keyring: kr2 });
    await expect(s2.add(other, pw)).rejects.toMatchObject({ code: 'keychain_unavailable', message: expect.stringContaining('MULTI_ACCOUNT_MCP_SECRETS=file') });
    expect(await code(s2.getSecret('jobs-gmail'))).toBe('keychain_unavailable');
    expect(kr2.map.size).toBe(0);
    // with the opt-in the same store keeps working, even though a keychain is now there
    const s3 = await createAccountStore({ dir: d2, keyring: kr2, secretFallback: 'file' });
    expect(await s3.getSecret('jobs-gmail')).toEqual(pw);
  });

  it('gives every account a random keychain key, so two data dirs sharing a keychain do not collide', async () => {
    const kr = fakeKeyring();
    const one = await createAccountStore({ dir: join(dir, 'one'), keyring: kr });
    const two = await createAccountStore({ dir: join(dir, 'two'), keyring: kr });
    await one.add(input(), pw);
    await two.add(input(), { kind: 'password', password: 'second' });
    expect(kr.map.size).toBe(2);
    expect(await one.getSecret('jobs-gmail')).toEqual(pw);
    await two.remove('jobs-gmail');
    expect(await one.getSecret('jobs-gmail')).toEqual(pw);
  });

  it('treats a malformed record or duplicate in accounts.json as corrupt and never writes it back', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    await s.add(input(), pw);
    const file = join(dir, 'accounts.json');
    const good = (await readDb(dir)).accounts[0];
    const cases: unknown[][] = [
      [null], ['x'], [{ ...good, id: '../x' }], [{ ...good, imap: null }], [{ ...good, secretRef: '__proto__' }],
      [{ ...good, secretRef: undefined }], [{ ...good, addedAt: 5 }],
      [good, { ...good, address: 'other@x.com' }],                            // duplicate id
      [good, { ...good, id: 'b', address: 'j.obs+x@googlemail.com' }],        // duplicate address
      [good, { ...good, id: 'b', address: 'b@x.com' }],                       // two records, one secretRef
    ];
    for (const accounts of cases) {
      const text = JSON.stringify({ version: 2, accounts });
      await writeFile(file, text);
      const calls = [() => s.list(), () => s.get('jobs-gmail'), () => s.add(input({ id: 'n', address: 'n@x.com' }), pw),
        () => s.update('jobs-gmail', { label: 'x' }), () => s.remove('jobs-gmail'), () => s.getSecret('jobs-gmail')];
      for (const call of calls) expect(await code(call()), text.slice(0, 80)).toBe('store_corrupt');
      expect(await readFile(file, 'utf8')).toBe(text);
      expect(await readFile(file + '.bak', 'utf8')).toBe(text);
    }
    for (const bad of [{ backend: 'cloud' }, { version: 3 }, { pendingDeletes: [{ secretRef: '__proto__' }] }]) {
      await writeFile(file, JSON.stringify({ version: 2, accounts: [good], ...bad }));
      expect(await code(s.list()), JSON.stringify(bad)).toBe('store_corrupt');
    }
  });

  it('shape-checks secrets on read', async () => {
    const kr = fakeKeyring();
    const s = await createAccountStore({ dir, keyring: kr });
    await s.add(input(), pw);
    const [ref] = [...kr.map.keys()];
    for (const v of ['{"kind":"password"}', '"just a string"', 'null', `{"kind":"oauth","refreshToken":5}`, `not json ${PASSWORD}`]) {
      kr.map.set(ref, v);
      const e = await s.getSecret('jobs-gmail').catch((x) => x);
      expect(e).toMatchObject({ code: 'store_corrupt', accountId: 'jobs-gmail' });
      expect(e.message).not.toContain(PASSWORD);
    }
    const f = await createAccountStore({ dir: join(dir, 'f'), keyring: fakeKeyring({ broken: true }), secretFallback: 'file' });
    await f.add(input(), pw);
    const fref = (await readDb(join(dir, 'f'))).accounts[0].secretRef;
    await writeFile(join(dir, 'f', 'secrets.json'), JSON.stringify({ [fref]: { kind: 'password', password: 7 } }), { mode: 0o600 });
    expect(await code(f.getSecret('jobs-gmail'))).toBe('store_corrupt');
  });

  it('a lock left by a dead process (kill -9) does not stall the next write', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    await writeFile(join(dir, 'accounts.lock'), `${deadPid()} dead`);
    const t = Date.now();
    await s.add(input(), pw);
    expect(Date.now() - t).toBeLessThan(2000);
    await expect(stat(join(dir, 'accounts.lock'))).rejects.toThrow();
  });

  it('an empty lock (never written by this version) is taken at once', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    await writeFile(join(dir, 'accounts.lock'), '');
    const t = Date.now();
    await s.add(input(), pw);
    expect(Date.now() - t).toBeLessThan(2000);
    expect((await readdir(dir)).sort()).toEqual(['accounts.json']);
  });

  it('waits for a lock held by a live process and times out with a coded error', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const s = await createAccountStore({ dir, keyring: fakeKeyring() });
      // a live owner keeps the lock however old it is
      await writeFile(join(dir, 'accounts.lock'), `${process.ppid} live`);
      const old = new Date(Date.now() - 3_600_000);
      await utimes(join(dir, 'accounts.lock'), old, old);
      const p = code(s.add(input(), pw));
      await new Promise((r) => setTimeout(r, 100));
      vi.setSystemTime(Date.now() + 16_000);
      expect(await p).toBe('timeout');
      expect(await readFile(join(dir, 'accounts.lock'), 'utf8')).toBe(`${process.ppid} live`);
    } finally { vi.useRealTimers(); }
  });

  it('remove saves the list first and is not blocked by a keychain delete that throws', async () => {
    // delete throws because the entry is already gone
    const kr = fakeKeyring();
    const s = await createAccountStore({ dir, keyring: kr });
    await s.add(input(), pw);
    kr.map.clear();
    await s.remove('jobs-gmail');
    expect(await s.list()).toEqual([]);
    expect(stderr.join('')).toBe('');

    // delete fails for real: the account still goes, with a note on stderr
    const kr2 = fakeKeyring({ deleteThrows: true });
    const s2 = await createAccountStore({ dir: join(dir, 'two'), keyring: kr2 });
    await s2.add(input(), pw);
    await s2.remove('jobs-gmail');
    expect(await s2.list()).toEqual([]);
    expect(stderr.join('')).toMatch(/could not be deleted/);
    expect(stderr.join('')).not.toContain(PASSWORD);
  });

  it('spots the same mailbox typed differently, and stores the address as typed', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    const a = await s.add(input({ address: 'Jo.Bs+news@Gmail.com' }), pw);
    expect(a.address).toBe('Jo.Bs+news@Gmail.com');
    for (const address of ['jobs@gmail.com', 'j.o.b.s@googlemail.com', 'JOBS+x@GMAIL.COM', 'ｊｏｂｓ@gmail.com']) {
      expect(await code(s.add(input({ id: 'other', address }), pw)), address).toBe('duplicate');
    }
    expect((await s.get('jobs@googlemail.com'))?.id).toBe('jobs-gmail');
    // NFC vs NFD, and dots/+tags only matter on Gmail
    await s.add(input({ id: 'nfc', address: 'jos\u00e9@x.com', provider: 'imap' }), pw);
    expect(await code(s.add(input({ id: 'nfd', address: 'jose\u0301@x.com' }), pw))).toBe('duplicate');
    expect(await code(s.add(input({ id: 'sharp', address: 'STRASSE@x.com' }), pw))).toBe('resolved');
    expect(await code(s.add(input({ id: 'sharp2', address: 'stra\u00dfe@x.com' }), pw))).toBe('duplicate');
    expect(await code(s.add(input({ id: 'dot', address: 'jo.se@x.com' }), pw))).toBe('resolved');
  });

  it('reports unreadable or corrupt store files as store_corrupt, with the path on the error and not in the text', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    await s.add(input(), pw);
    await chmod(dir, 0o500); // cannot create the lock or temp file
    try {
      const e = await s.add(input({ id: 'b', address: 'b@x.com' }), pw).catch((x) => x);
      expect(e).toBeInstanceOf(AccountError);
      expect(e).toMatchObject({ code: 'store_corrupt', path: expect.stringContaining(dir), message: expect.stringContaining('permission denied') });
      expect(e.message).not.toContain(dir);
    } finally { await chmod(dir, 0o700); }

    await rm(dir, { recursive: true });
    const gone = await s.add(input(), pw).catch((x) => x);
    expect(gone).toMatchObject({ code: 'store_corrupt', message: expect.stringContaining('missing') });
    expect(gone.message).not.toContain(dir);
    await mkdir(dir);

    await writeFile(join(dir, 'accounts.json'), '{', { mode: 0o600 });
    const c = await s.list().catch((x) => x);
    expect(c).toMatchObject({ code: 'store_corrupt', path: join(dir, 'accounts.json') });
    expect(c.message).not.toContain(dir);
  });

  it('tightens a group/world-readable store file to 0600 and warns once', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring({ broken: true }), secretFallback: 'file' });
    await s.add(input(), pw);
    stderr.length = 0;
    for (const name of ['accounts.json', 'secrets.json']) await chmod(join(dir, name), 0o644);
    expect(await s.getSecret('jobs-gmail')).toEqual(pw);
    expect(await s.getSecret('jobs-gmail')).toEqual(pw);
    for (const name of ['accounts.json', 'secrets.json']) {
      expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
      expect(stderr.filter((l) => l.includes(name) && /other users/.test(l))).toHaveLength(1);
    }
  });

  it('creates its folder as 0700 but leaves the permissions of an existing folder alone', async () => {
    await chmod(dir, 0o755);
    await createAccountStore({ dir, keyring: fakeKeyring() });
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    await createAccountStore({ dir: join(dir, 'a', 'b'), keyring: fakeKeyring() });
    expect((await stat(join(dir, 'a', 'b'))).mode & 0o777).toBe(0o700);
  });

  it('validation edges: ids, emoji labels, IP hosts', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    for (const id of ['-', '--', '-a', 'a-', 'a'.repeat(41)]) expect(await code(s.add(input({ id }), pw)), id).toBe('invalid_input');
    for (const label of ['evil\u202Elabel', 'a\u2066b', 'a\u200Fb', 'a\u0000b', 'a\u2028b']) expect(await code(s.add(input({ label }), pw)), JSON.stringify(label)).toBe('invalid_input');
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Family';
    const a = await s.add(input({ id: 'a', label: family, imap: { host: '::1', port: 993, secure: true }, smtp: { host: '192.168.1.10', port: 587, secure: false } }), pw);
    expect(a).toMatchObject({ label: family, imap: { host: '::1' }, smtp: { host: '192.168.1.10' } });
    await s.add(input({ id: 'a'.repeat(40), address: 'b@x.com', imap: { host: '2001:DB8::1', port: 993, secure: true } }), pw);
    await s.add(input({ id: 'a-b', address: 'c@x.com' }), pw);
    expect(await code(s.add(input({ id: 'z', address: 'z@x.com', imap: { host: '[::1]', port: 993, secure: true } }), pw))).toBe('invalid_input');
  });

  it('keeps secrets out of error messages', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring({ failWrites: true }) });
    const err = await s.add(input(), pw).catch((e) => e);
    expect(err).toBeInstanceOf(AccountError);
    expect(err.code).toBe('keychain_unavailable');
    expect(String(err.message) + String(err.stack)).not.toContain(PASSWORD);
    expect(await s.list()).toEqual([]);

    // corrupt fallback file: JSON.parse errors quote content, ours must not
    const f = await createAccountStore({ dir: join(dir, 'f'), keyring: fakeKeyring({ broken: true }), secretFallback: 'file' });
    await f.add(input(), pw);
    await writeFile(join(dir, 'f', 'secrets.json'), `{"jobs-gmail": "${PASSWORD}`);
    const e2 = await f.getSecret('jobs-gmail').catch((e) => e);
    expect(e2).toMatchObject({ code: 'store_corrupt', path: join(dir, 'f', 'secrets.json') });
    expect(e2.message).not.toContain(PASSWORD);
    expect(e2.message).not.toContain(dir);
    expect(stderr.join('')).not.toContain(PASSWORD);
  });

  it('does not overwrite a corrupt accounts.json, keeps a .bak and throws clearly', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    const file = join(dir, 'accounts.json');
    await writeFile(file, '{"accounts": [ oops');
    await expect(s.list()).rejects.toThrow(/corrupt.*\.bak/s);
    await expect(s.add(input(), pw)).rejects.toMatchObject({ code: 'store_corrupt', path: file });
    expect(await readFile(file, 'utf8')).toBe('{"accounts": [ oops');
    expect(await readFile(file + '.bak', 'utf8')).toBe('{"accounts": [ oops');
  });

  it('rejects bad input', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    const huge = 'a'.repeat(100_000);
    const cases: Partial<Account>[] = [
      { id: '' }, { id: '../x' }, { id: '..' }, { id: 'a/b' }, { id: 'UPPER' }, { id: 'a'.repeat(41) }, { id: huge },
      { label: '' }, { label: '   ' }, { label: huge }, { label: 'bad\nlabel' },
      { address: '' }, { address: 'no-at' }, { address: 'a@b' }, { address: 'a b@c.com' }, { address: `${huge}@x.com` },
      { address: 'a@b.com\r\nBcc: evil@x.com' }, { address: '<a@b.com>' }, { address: 'a@@b.com' },
      { provider: 'aol' as never }, { service: 'sms' as never }, { auth: 'magic' as never }, { allowSend: 'true' as never },
      { imap: { host: '', port: 993, secure: true } }, { imap: { host: '../etc', port: 993, secure: true } },
      { imap: { host: 'h.com', port: 70000, secure: true } }, { imap: { host: 'h.com', port: 1.5, secure: true } },
      { smtp: { host: 'h.com', port: '465' as never, secure: true } }, { smtp: { host: 'h.com', port: 465, secure: 'yes' as never } },
      { smtp: undefined as never }, { imap: { host: huge, port: 1, secure: true } },
    ];
    for (const c of cases) expect(await code(s.add(input(c), pw)), JSON.stringify(c).slice(0, 80)).toBe('invalid_input');
    expect(await code(s.add(input(), { kind: 'password', password: huge }))).toBe('invalid_input');
    expect(await code(s.add(null as never, pw))).toBe('invalid_input');
    expect(await code(s.getSecret('../x'))).toBe('invalid_input');
    expect(await code(s.remove('../x'))).toBe('invalid_input');
    expect(await s.list()).toEqual([]);
  });

  it('accepts unicode addresses and compares them case-insensitively', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring() });
    await s.add(input({ id: 'u', address: 'Jürgen@Bücher.de', provider: 'imap' }), pw);
    expect((await s.get('jürgen@bücher.de'))?.id).toBe('u');
    expect(await code(s.add(input({ id: 'u2', address: 'JÜRGEN@bücher.de' }), pw))).toBe('duplicate');
  });

  it('is safe with concurrent adds from two store instances', async () => {
    const a = await createAccountStore({ dir, keyring: fakeKeyring() });
    const b = await createAccountStore({ dir, keyring: fakeKeyring() });
    const ids = Array.from({ length: 20 }, (_, i) => `acct-${i}`);
    await Promise.all(ids.map((id, i) => (i % 2 ? a : b).add(input({ id, address: `${id}@x.com` }), pw)));
    expect((await a.list()).map((x) => x.id).sort()).toEqual([...ids].sort());

    // same address raced: exactly one wins
    const results = await Promise.allSettled([
      a.add(input({ id: 'r1', address: 'race@x.com' }), pw), b.add(input({ id: 'r2', address: 'race@x.com' }), pw),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('sees changes made by another process (re-reads before write)', async () => {
    const cli = await createAccountStore({ dir, keyring: fakeKeyring() });
    const server = await createAccountStore({ dir, keyring: fakeKeyring() });
    await cli.add(input(), pw);
    await server.add(input({ id: 'two', address: 'two@x.com' }), pw);
    expect(await cli.list()).toHaveLength(2);
  });

  it('does not hold the lock across a slow keychain write (36 s, fake clock): a second writer gets in and no add is lost', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const kr = fakeKeyring();
      let started!: () => void;
      const inSet = new Promise<void>((r) => { started = r; });
      const slow: KeyringLike = { ...kr, set: async (k, v) => { started(); await new Promise((r) => setTimeout(r, 36_000)); await kr.set(k, v); } };
      const a = await createAccountStore({ dir, keyring: slow });
      const b = await createAccountStore({ dir, keyring: kr });
      const pa = a.add(input({ id: 'slow', address: 'slow@x.com' }), pw);
      await inSet;
      await expect(stat(join(dir, 'accounts.lock'))).rejects.toThrow(); // the lock is free during the keychain call
      await b.add(input({ id: 'fast', address: 'fast@x.com' }), { kind: 'password', password: 'fast' });
      await vi.advanceTimersByTimeAsync(36_000);
      await pa;
      expect((await b.list()).map((x) => x.id).sort()).toEqual(['fast', 'slow']);
      expect(await b.getSecret('slow')).toEqual(pw);
      expect(await b.getSecret('fast')).toEqual({ kind: 'password', password: 'fast' });
      expect((await readDb(dir)).pendingDeletes).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('a keychain write that does not stick is caught by reading it back', async () => {
    const opts = { dropWrites: true };
    const kr = fakeKeyring(opts);
    const s = await createAccountStore({ dir, keyring: kr });
    await expect(s.add(input(), pw)).rejects.toMatchObject({ code: 'keychain_unavailable', message: expect.stringContaining('did not keep') });
    expect(await s.list()).toEqual([]);
    expect((await readDb(dir)).pendingDeletes).toEqual([]);
    opts.dropWrites = false;
    await s.add(input(), pw);
    opts.dropWrites = true;
    expect(await code(s.setSecret('jobs-gmail', { kind: 'password', password: 'new' }))).toBe('keychain_unavailable');
    expect(await s.getSecret('jobs-gmail')).toEqual(pw);
  });

  it('remove with the keychain down still removes, journals the secret in pendingDeletes, and deletes it on a later write', async () => {
    const opts = { broken: false };
    const kr = fakeKeyring(opts);
    const s = await createAccountStore({ dir, keyring: kr });
    await s.add(input(), pw);
    const [ref] = [...kr.map.keys()];
    opts.broken = true;
    await s.remove('jobs-gmail');
    expect(await s.list()).toEqual([]);
    expect(kr.map.has(ref)).toBe(true);
    expect((await readDb(dir)).pendingDeletes).toEqual([{ secretRef: ref }]);
    expect(stderr.join('')).toMatch(/could not be deleted.*tried again/);
    expect(stderr.join('')).not.toContain(PASSWORD);
    opts.broken = false;
    const other = await createAccountStore({ dir, keyring: kr }); // e.g. the CLI, a different process
    await other.add(input({ id: 'b', address: 'b@x.com' }), pw);
    expect(kr.map.has(ref)).toBe(false);
    expect(kr.map.size).toBe(1);
    expect((await readDb(dir)).pendingDeletes).toEqual([]);
  });

  it('remove deletes a file-saved secret even when this run has no file opt-in', async () => {
    const f = await createAccountStore({ dir, keyring: fakeKeyring({ broken: true }), secretFallback: 'file' });
    await f.add(input(), pw);
    const plain = await createAccountStore({ dir, keyring: fakeKeyring() });
    expect(await code(plain.getSecret('jobs-gmail'))).toBe('keychain_unavailable');
    await plain.remove('jobs-gmail');
    expect(await plain.list()).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'))).toEqual({});
  });

  it('sweeps what a killed writer left: dead-pid temp files, lock slots and unused secrets.json keys', async () => {
    const s = await createAccountStore({ dir, keyring: fakeKeyring({ broken: true }), secretFallback: 'file' });
    await s.add(input(), pw);
    const dead = deadPid();
    const secrets = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'));
    await writeFile(join(dir, 'secrets.json'), JSON.stringify({ ...secrets, [randomUUID()]: { kind: 'password', password: 'orphan' } }), { mode: 0o600 });
    const junk = [`accounts.json.${dead}.ab12.tmp`, `secrets.json.${dead}.cd34.tmp`, `accounts.lock.${dead}.ef56.tmp`, `accounts.lock.next-${dead}_1_x`];
    for (const f of junk) await writeFile(join(dir, f), `{"x":{"kind":"password","password":"${PASSWORD}"}}`);
    const live = `accounts.json.${process.pid}.abcd.tmp`; // a running writer's temp file is not touched
    await writeFile(join(dir, live), '{}');
    await s.update('jobs-gmail', { label: 'Renamed' });
    expect((await readdir(dir)).sort()).toEqual(['accounts.json', live, 'secrets.json']);
    expect(Object.values(JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8')))).toEqual([pw]);
  });

  it('deletes a keychain secret journaled by a writer that died; leaves one a live writer is still saving', async () => {
    const kr = fakeKeyring();
    const s = await createAccountStore({ dir, keyring: kr });
    await s.add(input(), pw);
    const db = await readDb(dir);
    const used = db.accounts[0].secretRef;
    const [deadRef, liveRef] = [randomUUID(), randomUUID()];
    kr.map.set(deadRef, JSON.stringify(pw));
    kr.map.set(liveRef, JSON.stringify(pw));
    db.pendingDeletes = [
      { secretRef: deadRef, owner: `${deadPid()}` },      // add killed during the keychain write
      { secretRef: liveRef, owner: `${process.ppid}` },   // add still running in another process
      { secretRef: used, owner: `${deadPid()}` },         // setSecret killed midway: the account still uses it
    ];
    await writeFile(join(dir, 'accounts.json'), JSON.stringify(db), { mode: 0o600 });
    await s.update('jobs-gmail', { label: 'x' });
    expect([...kr.map.keys()].sort()).toEqual([liveRef, used].sort());
    expect(await s.getSecret('jobs-gmail')).toEqual(pw);
    expect((await readDb(dir)).pendingDeletes).toEqual([{ secretRef: liveRef, owner: `${process.ppid}` }]);
  });

  it('migrates the version-1 layout (no secretRef, secret saved under the account id) on the first write', async () => {
    const kr = fakeKeyring();
    const s = await createAccountStore({ dir, keyring: kr });
    const rec = (id: string, address: string) => ({ ...input({ id, address }), addedAt: new Date().toISOString() });
    kr.map.set('jobs-gmail', JSON.stringify(pw));
    await writeFile(join(dir, 'accounts.json'), JSON.stringify({ backend: 'keychain', accounts: [rec('jobs-gmail', 'Jobs@Gmail.com'), rec('lost', 'lost@x.com')] }), { mode: 0o600 });
    expect((await s.list()).map((a) => a.id)).toEqual(['jobs-gmail', 'lost']);
    expect(await s.getSecret('jobs-gmail')).toEqual(pw);
    // no secret under the old key: the account is kept and says what to do
    await expect(s.getSecret('lost')).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('Save the login for this account again') });
    await s.update('lost', { label: 'Lost' });
    expect(await readDb(dir)).toMatchObject({ version: 2, accounts: [{ id: 'jobs-gmail', secretRef: 'jobs-gmail' }, { id: 'lost', secretRef: 'lost' }] });
    await s.setSecret('lost', { kind: 'password', password: 'again' });
    expect(await s.getSecret('lost')).toEqual({ kind: 'password', password: 'again' });
    expect(await s.getSecret('jobs-gmail')).toEqual(pw);

    // the file layout, keyed by id in secrets.json, too
    const d = join(dir, 'f');
    await mkdir(d);
    await writeFile(join(d, 'accounts.json'), JSON.stringify({ backend: 'file', accounts: [rec('jobs-gmail', 'Jobs@Gmail.com')] }), { mode: 0o600 });
    await writeFile(join(d, 'secrets.json'), JSON.stringify({ 'jobs-gmail': pw }), { mode: 0o600 });
    const f = await createAccountStore({ dir: d, keyring: fakeKeyring({ broken: true }), secretFallback: 'file' });
    await f.add(input({ id: 'b', address: 'b@x.com' }), pw);
    expect(await f.getSecret('jobs-gmail')).toEqual(pw);
    expect(Object.keys(JSON.parse(await readFile(join(d, 'secrets.json'), 'utf8')))).toHaveLength(2);
  });
});
