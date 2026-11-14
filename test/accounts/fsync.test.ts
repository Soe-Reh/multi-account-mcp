import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// Records, in order, every fsync and rename the store makes; onReaddir runs before each readdir.
const calls = vi.hoisted(() => [] as string[]);
const hook = vi.hoisted(() => ({ onReaddir: async () => {} }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readdir: async (...args: never[]) => { await hook.onReaddir(); return fs.readdir(...(args as [string])); },
    open: async (path: string, ...rest: never[]) => {
      const fh = await fs.open(path, ...rest);
      const sync = fh.sync.bind(fh);
      fh.sync = async () => { calls.push(`sync ${path}`); return sync(); };
      return fh;
    },
    rename: async (from: string, to: string) => { calls.push(`rename ${to}`); return fs.rename(from, to); },
  };
});

const ep = { host: 'mail.x.com', port: 993, secure: true };
const acct = (id: string) => ({ id, label: id, service: 'email' as const, provider: 'imap' as const, address: `${id}@x.com`, auth: 'password' as const, imap: ep, smtp: ep, allowSend: false });
const keyring = () => {
  const map = new Map<string, string>();
  return { get: async (k: string) => map.get(k) ?? null, set: async (k: string, v: string) => { map.set(k, v); }, delete: async (k: string) => { map.delete(k); } };
};

it('fsyncs the temp file before the rename and the folder after it', async () => {
  const { createAccountStore } = await import('../../src/accounts/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'mam-fsync-'));
  try {
    const s = await createAccountStore({ dir, keyring: keyring() });
    await s.add(acct('a'), { kind: 'password', password: 'p' });
    const file = join(dir, 'accounts.json');
    // two saves: the journal entry before the keychain write, then the account itself
    expect(calls).toHaveLength(6);
    for (const at of [0, 3]) {
      expect(calls[at]).toMatch(/^sync .*accounts\.json\.\d+\.[0-9a-f]+\.tmp$/);
      expect(calls.slice(at + 1, at + 3)).toEqual([`rename ${file}`, `sync ${dir}`]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('re-checks it still owns the lock right before saving, and throws instead of overwriting', async () => {
  const { createAccountStore } = await import('../../src/accounts/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'mam-own-'));
  try {
    const s = await createAccountStore({ dir, keyring: keyring() });
    await s.add(acct('a'), { kind: 'password', password: 'p' });
    const before = await readFile(join(dir, 'accounts.json'), 'utf8');
    const lock = join(dir, 'accounts.lock');
    // another program takes the lock while this one holds it (the store lists the folder under the lock, after loading)
    hook.onReaddir = async () => { await writeFile(lock, 'other 0 x'); };
    const p = s.update('a', { label: 'B' });
    await expect(p).rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('nothing was saved') });
    expect(await readFile(join(dir, 'accounts.json'), 'utf8')).toBe(before);
    expect(await readFile(lock, 'utf8')).toBe('other 0 x'); // the other program's lock is left alone
  } finally { hook.onReaddir = async () => {}; await rm(dir, { recursive: true, force: true }); }
});
