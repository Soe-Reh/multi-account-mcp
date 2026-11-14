// OAuth 2.0 for Google and Microsoft mail: PKCE, code exchange and token refresh, with plain fetch.
import { createHash, randomBytes } from 'node:crypto';
import { AccountError, type Account, type AccountStore, type MailCredentials } from '../types.js';
import { oauthProvider, type OAuthName, type OAuthProvider } from './clients.js';
import type { OAuthSecret, RefreshOAuth } from './credentials.js';

export const MANAGED_MESSAGE = 'This account is managed by your organization, which has not approved this app. multi-account-mcp is for personal accounts.';
// Admin consent needed / blocked by org policy / user not assigned / conditional access; Google Workspace admin block.
const MANAGED_RE = /AADSTS(65001|90094|90095|50105|53003|530003)\b|admin_policy_enforced|org_internal/;
export const isManagedError = (text: string) => MANAGED_RE.test(text);

const REFRESH_MARGIN_MS = 2 * 60_000;
const TIMEOUT_MS = 20_000;

export const random = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function pkce() {
  const verifier = random(32);
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(p: OAuthProvider, o: { state: string; challenge: string; redirectUri: string }) {
  const u = new URL(p.authorizeUrl);
  const q = { client_id: p.clientId, response_type: 'code', redirect_uri: o.redirectUri, scope: p.scope, state: o.state,
    code_challenge: o.challenge, code_challenge_method: 'S256', ...p.extra };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}

interface TokenResponse { access_token: string; refresh_token?: string; expires_in?: number; id_token?: string }
const title = (p: OAuthProvider) => (p.name === 'google' ? 'Google' : 'Microsoft');

async function tokenRequest(p: OAuthProvider, params: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams({ client_id: p.clientId, ...(p.clientSecret && { client_secret: p.clientSecret }), ...params });
  let res: Response;
  try {
    res = await fetch(p.tokenUrl, { method: 'POST', body, headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new AccountError('unreachable', `Could not reach ${title(p)} sign-in. Check your internet connection and try again.`);
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (res.ok && typeof data.access_token === 'string') return data as unknown as TokenResponse;
  const error = String(data.error ?? `http_${res.status}`);
  const text = `${error} ${String(data.error_description ?? '')}`;
  if (isManagedError(text)) throw new AccountError('managed_account', MANAGED_MESSAGE);
  // Only the short error code is kept: descriptions can quote request details.
  throw new AccountError('auth_failed', error === 'invalid_grant' ? 'invalid_grant' : `${title(p)} sign-in failed (${error.slice(0, 60)}). Try again.`);
}

const toSecret = (t: TokenResponse, refreshToken: string, now: number): OAuthSecret =>
  ({ kind: 'oauth', refreshToken, accessToken: t.access_token, expiresAt: now + (t.expires_in ?? 3600) * 1000 });

/** The address in an id_token. It came straight from the token endpoint over TLS, so the signature is not checked. */
function emailFrom(idToken?: string): string | undefined {
  try {
    const c = JSON.parse(Buffer.from(idToken!.split('.')[1], 'base64url').toString('utf8'));
    const e = c.email ?? c.preferred_username;
    return typeof e === 'string' && e.includes('@') ? e : undefined;
  } catch { return undefined; }
}

export async function exchangeCode(p: OAuthProvider, code: string, verifier: string, redirectUri: string) {
  const t = await tokenRequest(p, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
  if (!t.refresh_token) throw new AccountError('auth_failed', `${title(p)} did not allow offline access. Try again.`);
  const address = emailFrom(t.id_token);
  if (!address) throw new AccountError('auth_failed', `${title(p)} did not share the email address. Try again.`);
  return { address, secret: toSecret(t, t.refresh_token, Date.now()) };
}

export const providerOf = (a: Account): OAuthName | undefined =>
  a.provider === 'gmail' ? 'google' : a.provider === 'outlook' ? 'microsoft' : undefined;

/** The RefreshOAuth hook: a valid access token, refreshed when missing or within 2 minutes of expiry. */
export function createRefreshOAuth(store: AccountStore, o: {
  env?: NodeJS.ProcessEnv; endpoints?: Parameters<typeof oauthProvider>[2]; now?: () => number;
} = {}): RefreshOAuth {
  const now = o.now ?? Date.now;
  const inflight = new Map<string, Promise<MailCredentials>>();
  const fresh = (s: OAuthSecret) => !!s.accessToken && (s.expiresAt ?? 0) - now() > REFRESH_MARGIN_MS;
  const login = (a: Account, s: OAuthSecret): MailCredentials => ({ user: a.address, accessToken: s.accessToken! });
  const again = (a: Account) => new AccountError('auth_failed', `Sign in to ${a.label} again.`, a.id);

  async function refresh(a: Account): Promise<MailCredentials> {
    // Re-read: another caller may have refreshed (and rotated the refresh token) since this caller read the secret.
    const s = await store.getSecret(a.id);
    if (s.kind !== 'oauth') throw again(a);
    if (fresh(s)) return login(a, s);
    const name = providerOf(a);
    const p = name && oauthProvider(name, o.env, o.endpoints);
    if (!p) throw new AccountError('auth_failed', `${a.label} uses ${name === 'microsoft' ? 'Microsoft' : 'Google'} sign-in, which is not set up in this build.`, a.id);
    let t: TokenResponse;
    try {
      t = await tokenRequest(p, { grant_type: 'refresh_token', refresh_token: s.refreshToken, ...(name === 'microsoft' && { scope: p.scope }) });
    } catch (e) {
      if (e instanceof AccountError && e.code === 'auth_failed') throw again(a);
      if (e instanceof AccountError) e.accountId = a.id;
      throw e;
    }
    const next = toSecret(t, t.refresh_token ?? s.refreshToken, now());
    try { await store.setSecret(a.id, next); } catch (e) {
      // The token still works for this hour; the old refresh token is tried next time.
      process.stderr.write(`multi-account-mcp: could not save the new sign-in for ${a.label}: ${(e as Error).message}\n`);
    }
    return login(a, next);
  }

  return async (account, secret) => {
    if (fresh(secret)) return login(account, secret);
    let p = inflight.get(account.id);
    if (!p) {
      p = refresh(account).finally(() => inflight.delete(account.id));
      inflight.set(account.id, p);
    }
    return p;
  };
}
