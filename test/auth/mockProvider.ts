// An in-process OAuth provider that acts as Google or Microsoft: authorize redirect, code exchange with PKCE, refresh.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

export interface MockProvider {
  url: string;
  endpoints: { authorizeUrl: string; tokenUrl: string };
  /** What the next authorize does: sign in as `email`, or send an error back like a blocked org account. */
  next: { email: string; error?: string; errorDescription?: string };
  rotate: boolean;              // refresh returns a new refresh token
  revoked: Set<string>;         // refresh tokens that get invalid_grant
  tokenError?: { error: string; error_description?: string };
  refreshes: string[];          // refresh tokens used, in order
  authorizeQueries: URLSearchParams[];
  delayMs: number;
  close(): Promise<void>;
}

export async function startMockProvider(): Promise<MockProvider> {
  const codes = new Map<string, { challenge: string; method: string; redirectUri: string; email: string }>();
  let n = 0;
  const m: MockProvider = {
    url: '', endpoints: { authorizeUrl: '', tokenUrl: '' }, next: { email: 'me@gmail.com' }, rotate: false,
    revoked: new Set(), refreshes: [], authorizeQueries: [], delayMs: 0, close: async () => {},
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, m.url);
    const json = (status: number, body: object) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      m.authorizeQueries.push(q);
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('state', q.get('state') ?? '');
      if (!q.get('code_challenge') || q.get('code_challenge_method') !== 'S256') {
        back.searchParams.set('error', 'invalid_request');
      } else if (m.next.error) {
        back.searchParams.set('error', m.next.error);
        if (m.next.errorDescription) back.searchParams.set('error_description', m.next.errorDescription);
      } else {
        const code = `code-${++n}`;
        codes.set(code, { challenge: q.get('code_challenge')!, method: q.get('code_challenge_method')!, redirectUri: q.get('redirect_uri')!, email: m.next.email });
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const b = new URLSearchParams(raw);
      if (m.delayMs) await new Promise((r) => setTimeout(r, m.delayMs));
      if (m.tokenError) return json(400, m.tokenError);
      if (b.get('grant_type') === 'authorization_code') {
        const c = codes.get(b.get('code') ?? '');
        codes.delete(b.get('code') ?? '');
        const verifier = b.get('code_verifier') ?? '';
        const ok = c && c.redirectUri === b.get('redirect_uri') && verifier.length >= 43
          && createHash('sha256').update(verifier).digest('base64url') === c.challenge;
        if (!ok) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return json(200, { access_token: `at-${++n}`, refresh_token: `rt-${n}`, expires_in: 3600, id_token: jwt({ email: c.email }) });
      }
      if (b.get('grant_type') === 'refresh_token') {
        const rt = b.get('refresh_token')!;
        m.refreshes.push(rt);
        if (m.revoked.has(rt)) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        return json(200, { access_token: `at-${++n}`, expires_in: 3600, ...(m.rotate && { refresh_token: `rt-${n}` }) });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  m.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  m.endpoints = { authorizeUrl: `${m.url}/authorize`, tokenUrl: `${m.url}/token` };
  m.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return m;
}
