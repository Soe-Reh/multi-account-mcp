// Shared contract between parts. Change only with a note in PROGRESS.md.

export type ProviderId = 'gmail' | 'outlook' | 'yahoo' | 'imap';

export interface ServerEndpoint { host: string; port: number; secure: boolean }

/** Public account record. Never contains secrets. */
export interface Account {
  id: string;            // stable slug, unique, e.g. "jobs-gmail"
  label: string;         // user's name for it, e.g. "Jobs Gmail"
  service: 'email';      // later: 'linkedin' | 'canvas' ...
  provider: ProviderId;
  address: string;       // unique per service, compared case-insensitively
  auth: 'password' | 'oauth';
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
  allowSend: boolean;    // default false
  sendWithoutConfirm?: boolean; // default false: send even when the AI tool cannot show a confirm prompt (set only from the terminal)
  addedAt: string;       // ISO date
}

/** Stored only in the OS keychain (or the 0600 fallback file). */
export type Secret =
  | { kind: 'password'; password: string }
  | { kind: 'oauth'; refreshToken: string; accessToken?: string; expiresAt?: number };

export interface AccountStore {
  list(): Promise<Account[]>;
  get(idOrAddress: string): Promise<Account | undefined>;
  /** Rejects a duplicate id or address with AccountError code 'duplicate'. */
  add(account: Omit<Account, 'addedAt'>, secret: Secret): Promise<Account>;
  update(id: string, patch: Partial<Pick<Account, 'label' | 'allowSend' | 'sendWithoutConfirm' | 'imap' | 'smtp'>>): Promise<Account>;
  remove(id: string): Promise<void>; // also deletes the secret
  getSecret(id: string): Promise<Secret>;
  setSecret(id: string, secret: Secret): Promise<void>;
}

/** What the mail engine needs to log in. Part B's auth code turns a Secret into this (refreshing tokens). */
export type MailCredentials =
  | { user: string; pass: string }
  | { user: string; accessToken: string };

export interface MessageSummary {
  accountId: string;
  id: string;            // opaque, unique within the account: encodes folder + UID
  folder: string;
  from: string;
  to: string[];
  subject: string;
  date: string;          // ISO
  snippet: string;       // <= 200 chars plain text
  unread: boolean;
  hasAttachments: boolean;
}

export interface MessageFull extends MessageSummary {
  cc: string[];
  bcc?: string[];        // only for messages in the account's Drafts folder
  messageIdHeader?: string;
  text: string;          // plain text body, capped (see maxChars)
  truncated: boolean;
  attachments: { filename: string; contentType: string; size: number }[];
}

export interface SearchOptions {
  query?: string;        // free text; empty = most recent
  from?: string;
  since?: string;        // ISO date
  before?: string;
  unreadOnly?: boolean;
  folder?: string;       // default INBOX
  limit?: number;        // default 20, max 50
}

export interface DraftInput {
  to: string[];
  cc?: string[];
  bcc?: string[];        // envelope only: never in the bytes sent
  subject: string;
  text: string;
  inReplyToId?: string;  // a MessageSummary.id in the same account
}

/** One mail engine for every provider. Stateless per call or pooled; must time out (default 20s). */
export interface MailClient {
  search(account: Account, creds: MailCredentials, opts: SearchOptions): Promise<MessageSummary[]>;
  read(account: Account, creds: MailCredentials, id: string, maxChars?: number): Promise<MessageFull>;
  createDraft(account: Account, creds: MailCredentials, draft: DraftInput): Promise<{ draftId: string }>;
  /** Caller checks account.allowSend first; the client checks it again and throws 'send_disabled'. */
  sendDraft(account: Account, creds: MailCredentials, draftId: string): Promise<{ sent: true; messageIdHeader: string; warning?: string }>;
  verify(account: Account, creds: MailCredentials): Promise<void>;
  /** The n-th attachment (1-based, in MessageFull.attachments order), decoded; at most maxBytes are read. */
  readAttachment(account: Account, creds: MailCredentials, id: string, n: number, maxBytes: number): Promise<{ filename: string; contentType: string; data: Buffer; truncated: boolean }>;
}

export type ErrorCode =
  | 'duplicate' | 'not_found' | 'auth_failed' | 'timeout' | 'unreachable'
  | 'send_disabled' | 'send_unconfirmed' | 'rejected' | 'invalid_input' | 'managed_account' | 'keychain_unavailable' | 'store_corrupt';

export class AccountError extends Error {
  constructor(public code: ErrorCode, message: string, public accountId?: string) { super(message); }
}
