import type { ProviderId, ServerEndpoint } from '../types.js';

// `secure: true` = implicit TLS (993/465); `false` on 587 = STARTTLS (nodemailer semantics).
const tls = (host: string, port: number): ServerEndpoint => ({ host, port, secure: port !== 587 });

const PRESETS: Record<string, { provider: ProviderId; imap: ServerEndpoint; smtp: ServerEndpoint }> = {
  gmail: { provider: 'gmail', imap: tls('imap.gmail.com', 993), smtp: tls('smtp.gmail.com', 465) },
  yahoo: { provider: 'yahoo', imap: tls('imap.mail.yahoo.com', 993), smtp: tls('smtp.mail.yahoo.com', 465) },
  outlook: { provider: 'outlook', imap: tls('outlook.office365.com', 993), smtp: tls('smtp-mail.outlook.com', 587) },
  // ProviderId has no 'icloud'; it is plain IMAP with an app password.
  icloud: { provider: 'imap', imap: tls('imap.mail.me.com', 993), smtp: tls('smtp.mail.me.com', 587) },
};

const DOMAINS: Record<string, keyof typeof PRESETS> = {
  'gmail.com': 'gmail', 'googlemail.com': 'gmail',
  'yahoo.com': 'yahoo', 'ymail.com': 'yahoo', 'rocketmail.com': 'yahoo',
  'outlook.com': 'outlook', 'hotmail.com': 'outlook', 'live.com': 'outlook', 'msn.com': 'outlook',
  'icloud.com': 'icloud', 'me.com': 'icloud',
};

export function providerPreset(address: string) {
  const domain = String(address).trim().toLowerCase().split('@').pop() ?? '';
  const key = Object.hasOwn(DOMAINS, domain) ? DOMAINS[domain] : undefined;
  return key ? structuredClone(PRESETS[key]) : undefined;
}

/** Turns a label into a unique `[a-z0-9-]{1,40}` id, given the ids already taken. */
export function slugify(label: string, existing: Iterable<string> = []): string {
  const taken = new Set(existing);
  const base = String(label).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'account';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = base.slice(0, 40 - suffix.length).replace(/-+$/, '') + suffix;
    if (!taken.has(id)) return id;
  }
}

type Preset = NonNullable<ReturnType<typeof providerPreset>>;
const HOST = /^[a-z0-9.-]{1,253}$/i;

/** Reads a Thunderbird autoconfig document: the first IMAP and SMTP server that use TLS. */
export function parseAutoconfig(xml: string, address: string): Preset | undefined {
  const [local = '', domain = ''] = address.trim().toLowerCase().split('@');
  const fill = (s: string) => s.replace(/%EMAILDOMAIN%/g, domain).replace(/%EMAILLOCALPART%/g, local).replace(/%EMAILADDRESS%/g, `${local}@${domain}`);
  const pick = (tag: string, type: string): ServerEndpoint | undefined => {
    for (const m of xml.matchAll(new RegExp(`<${tag}\\s+type="${type}"[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))) {
      const get = (k: string) => (new RegExp(`<${k}>\\s*([^<]*?)\\s*</${k}>`).exec(m[1]) ?? [])[1] ?? '';
      const host = fill(get('hostname')), port = Number(get('port')), sock = get('socketType').toUpperCase();
      if (HOST.test(host) && port > 0 && port < 65536 && (sock === 'SSL' || sock === 'STARTTLS')) return { host, port, secure: sock === 'SSL' };
    }
    return undefined;
  };
  const imap = pick('incomingServer', 'imap'), smtp = pick('outgoingServer', 'smtp');
  return imap && smtp ? { provider: 'imap', imap, smtp } : undefined;
}

/** Known settings, else Thunderbird's public settings database (by domain, then by the domain's mail host), like Thunderbird does. */
export async function lookupPreset(address: string, fetchImpl: typeof fetch = fetch): Promise<Preset | undefined> {
  const local = providerPreset(address);
  if (local) return local;
  const domain = String(address).trim().toLowerCase().split('@').pop() ?? '';
  // Reserved names never resolve, so tests and typos make no network request.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) || /\.(example|test|invalid|localhost|local)$/.test(domain)) return undefined;
  const ispdb = async (d: string) => {
    try {
      const r = await fetchImpl(`https://autoconfig.thunderbird.net/v1.1/${d}`, { signal: AbortSignal.timeout(4000) });
      return r.ok ? parseAutoconfig(await r.text(), address) : undefined;
    } catch { return undefined; }
  };
  const found = await ispdb(domain);
  if (found) return found;
  try {
    const { resolveMx } = await import('node:dns/promises');
    const mx = (await resolveMx(domain)).sort((a, b) => a.priority - b.priority)[0]?.exchange.toLowerCase() ?? '';
    if (/(^|\.)(google|googlemail)\.com$/.test(mx)) return { ...structuredClone(PRESETS.gmail), provider: 'imap' };
    const base = mx.split('.').slice(-2).join('.');
    return base && base !== domain ? await ispdb(base) : undefined;
  } catch { return undefined; }
}
