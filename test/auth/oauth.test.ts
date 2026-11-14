import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createAccountStore, type KeyringLike } from '../../src/accounts/index.js';
import { getMailCredentials } from '../../src/auth/credentials.js';
import { authorizeUrl, createRefreshOAuth, pkce } from '../../src/auth/oauth.js';
import { oauthProvider } from '../../src/auth/clients.js';
import { AccountError, type Account } from '../../src/types.js';
import { startMockProvider, type MockProvider } from './mockProvider.js';

export function fakeKeyring(): KeyringLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } };
}

const env = { MULTI_ACCOUNT_MCP_GOOGLE_CLIENT_ID: 'gid', MULTI_ACCOUNT_MCP_MICROSOFT_CLIENT_ID: 'mid' };
let dir: string;
let mock: MockProvider;
let store: Awaited<ReturnType<typeof createAccountStore>>;
let account: Account;
let now = 1_000_000_000_000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mam-oauth-'));
  mock = await startMockProvider();
  store = await createAccountStore({ dir, keyring: fakeKeyring() });
  account = await store.add({
    id: 'jobs', label: 'Jobs Gmail', service: 'email', provider: 'gmail', address: 'jobs@gmail.com', auth: 'oauth',
    imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true }, allowSend: false,
  }, { kind: 'oauth', refreshToken: 'rt-0', accessToken: 'at-0', expiresAt: now + 3600_000 });
});
afterEach(async () => { await mock.close(); await rm(dir, { recursive: true, force: true }); });

const refresher = () => createRefreshOAuth(store, { env, endpoints: { google: mock.endpoints, microsoft: mock.endpoints }, now: () => now });
const creds = (r = refresher()) => getMailCredentials(store, account, r);

it('reuses a token that is still fresh', async () => {
  expect(await creds()).toEqual({ user: 'jobs@gmail.com', accessToken: 'at-0' });
  expect(mock.refreshes).toEqual([]);
});

it('refreshes within 2 minutes of expiry, or when the token is missing, and saves the new one', async () => {
  now += 3600_000 - 119_000;
  const c = await creds();
  expect(c).toMatchObject({ accessToken: expect.stringMatching(/^at-/) });
  expect(c).not.toMatchObject({ accessToken: 'at-0' });
  expect(mock.refreshes).toEqual(['rt-0']);
  expect(await store.getSecret('jobs')).toMatchObject({ kind: 'oauth', refreshToken: 'rt-0', accessToken: (c as any).accessToken, expiresAt: now + 3600_000 });
  await store.setSecret('jobs', { kind: 'oauth', refreshToken: 'rt-0' });
  await creds();
  expect(mock.refreshes).toEqual(['rt-0', 'rt-0']);
});

it('concurrent callers share one refresh', async () => {
  now += 3600_000;
  mock.delayMs = 50;
  const r = refresher();
  const all = await Promise.all(Array.from({ length: 5 }, () => creds(r)));
  expect(mock.refreshes).toHaveLength(1);
  expect(new Set(all.map((c: any) => c.accessToken)).size).toBe(1);
});

it('saves a rotated refresh token and uses it next time', async () => {
  mock.rotate = true;
  now += 3600_000;
  const r = refresher();
  await creds(r);
  const saved = await store.getSecret('jobs') as any;
  expect(saved.refreshToken).not.toBe('rt-0');
  now += 3600_000;
  await creds(r);
  expect(mock.refreshes).toEqual(['rt-0', saved.refreshToken]);
});

it('a revoked refresh token asks the user to sign in again', async () => {
  mock.revoked.add('rt-0');
  now += 3600_000;
  const e = await creds().catch((x) => x);
  expect(e).toBeInstanceOf(AccountError);
  expect(e).toMatchObject({ code: 'auth_failed', accountId: 'jobs', message: 'Sign in to Jobs Gmail again.' });
});

it('a missing client id is a plain error, not a crash', async () => {
  now += 3600_000;
  const r = createRefreshOAuth(store, { env: {}, now: () => now });
  expect(await creds(r).catch((e) => e.message)).toMatch(/Google sign-in, which is not set up/);
});

it('authorize URLs carry PKCE S256, state, offline access and the right scopes', () => {
  const { verifier, challenge } = pkce();
  expect(verifier.length).toBeGreaterThanOrEqual(43);
  const g = new URL(authorizeUrl(oauthProvider('google', env)!, { state: 's', challenge, redirectUri: 'http://127.0.0.1:1/callback' }));
  expect(Object.fromEntries(g.searchParams)).toMatchObject({ code_challenge: challenge, code_challenge_method: 'S256', state: 's', access_type: 'offline', prompt: 'consent', scope: 'https://mail.google.com/ openid email' });
  const m = new URL(authorizeUrl(oauthProvider('microsoft', env)!, { state: 's', challenge, redirectUri: 'http://localhost:1/callback' }));
  expect(m.origin + m.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  expect(m.searchParams.get('scope')).toBe('https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email');
  expect(oauthProvider('google', {})).toBeUndefined();
  expect(oauthProvider('microsoft', {})).toBeUndefined();
});
