// Turns an account's stored secret into the login the mail engine needs.
import { AccountError, type Account, type AccountStore, type MailCredentials, type Secret } from '../types.js';

export type OAuthSecret = Extract<Secret, { kind: 'oauth' }>;
/** Supplied by the sign-in part: returns a fresh access token login (and may save the new token). */
export type RefreshOAuth = (account: Account, secret: OAuthSecret) => Promise<MailCredentials>;

export async function getMailCredentials(store: AccountStore, account: Account, refreshOAuth?: RefreshOAuth): Promise<MailCredentials> {
  const secret = await store.getSecret(account.id);
  if (account.auth === 'password' && secret.kind === 'password') return { user: account.address, pass: secret.password };
  if (account.auth === 'oauth' && secret.kind === 'oauth' && refreshOAuth) return refreshOAuth(account, secret);
  throw new AccountError('auth_failed', `Sign in to ${account.label} again.`, account.id);
}
