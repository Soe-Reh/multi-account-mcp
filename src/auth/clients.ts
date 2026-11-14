// OAuth client ids for "Continue with Google / Microsoft". Desktop clients are public: Google and Microsoft say
// a desktop client secret is not a secret, so it may ship in the package. Empty = that sign-in is not set up yet.
export const GOOGLE_CLIENT_ID = '';
export const GOOGLE_CLIENT_SECRET = '';
export const MICROSOFT_CLIENT_ID = '';

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Local client ids in <data folder>/oauth.json: { "google": { "clientId", "clientSecret" }, "microsoft": { "clientId" } }.
// Lets an owner use their own sign-in app without putting it in the source.
function localClients(env: NodeJS.ProcessEnv): { google?: { clientId?: string; clientSecret?: string }; microsoft?: { clientId?: string } } {
  const dir = env.MULTI_ACCOUNT_MCP_HOME || process.env.MULTI_ACCOUNT_MCP_HOME || join(homedir(), '.multi-account-mcp');
  try {
    const v = JSON.parse(readFileSync(join(dir, 'oauth.json'), 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

export type OAuthName = 'google' | 'microsoft';

export interface OAuthProvider {
  name: OAuthName;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope: string;
  extra: Record<string, string>; // added to the authorize URL
}

export const ENDPOINTS: Record<OAuthName, { authorizeUrl: string; tokenUrl: string }> = {
  google: { authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token' },
  microsoft: {
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  },
};

/** The configured client for a provider, or undefined when no client id is set. `endpoints` is for tests. */
export function oauthProvider(name: OAuthName, env: NodeJS.ProcessEnv = process.env,
  endpoints: Partial<Record<OAuthName, { authorizeUrl: string; tokenUrl: string }>> = {}): OAuthProvider | undefined {
  const ep = endpoints[name] ?? ENDPOINTS[name];
  const local = localClients(env);
  if (name === 'google') {
    const clientId = env.MULTI_ACCOUNT_MCP_GOOGLE_CLIENT_ID || local.google?.clientId || GOOGLE_CLIENT_ID;
    if (!clientId) return undefined;
    return {
      name, ...ep, clientId, clientSecret: env.MULTI_ACCOUNT_MCP_GOOGLE_CLIENT_SECRET || local.google?.clientSecret || GOOGLE_CLIENT_SECRET || undefined,
      scope: 'https://mail.google.com/ openid email', extra: { access_type: 'offline', prompt: 'consent' },
    };
  }
  const clientId = env.MULTI_ACCOUNT_MCP_MICROSOFT_CLIENT_ID || local.microsoft?.clientId || MICROSOFT_CLIENT_ID;
  if (!clientId) return undefined;
  return {
    name, ...ep, clientId,
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email',
    extra: { prompt: 'select_account' },
  };
}
