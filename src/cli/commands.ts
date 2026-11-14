// The account commands: add, list, remove, test, allow-send. Results go to `out` (stdout), everything else to `err`.
import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { getMailCredentials, type RefreshOAuth } from '../auth/credentials.js';
import { oauthProvider } from '../auth/clients.js';
import { plainError, startSetupServer, type SetupOptions } from '../setup/server.js';
import { AccountError, type Account, type AccountStore, type MailClient } from '../types.js';

export interface Deps {
  store: AccountStore;
  mail: Pick<MailClient, 'verify'>;
  refreshOAuth?: RefreshOAuth;
  out?: (s: string) => void;
  err?: (s: string) => void;
  ask?: (question: string) => Promise<string | undefined>; // undefined: no terminal to answer in
  openUrl?: (url: string) => void;
  setup?: Partial<SetupOptions>;
  /** How the user runs this installation (src/cli/self.ts), used in every command we print. */
  cmd?: string;
}

const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export const HELP = `multi-account-mcp ${VERSION}: let your AI tool use all your email accounts.

Usage: multi-account-mcp <command>

  serve                 Run the MCP server for your AI tool (the default)
  install <client>      Set it up in claude-code, claude-desktop or cursor [--print] [--npx|--local] [--secrets-file] [--uninstall]
  add [--no-open]       Open the sign-in page to add an account
  list                  Show your accounts
  remove <account>      Remove an account and its saved login [--yes]
  test [account]        Check that one or all accounts can sign in
  allow-send <account>  Let your AI tool send from an account [--yes] [--no-confirm] [--force]
  allow-send <account> --off   Turn sending off again
  --help, --version

<account> is an account id, name or email address.
`;

async function askTty(question: string) {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return await rl.question(question); } finally { rl.close(); }
}

/** Opens the launch URL without putting it in a command line, where other users could see it with `ps`. */
export function openBrowser(url: string, platform = process.platform, spawn = nodeSpawn) {
  if (platform === 'darwin') {
    const p = spawn('osascript', ['-'], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => {});
    p.stdin?.end(`open location ${JSON.stringify(url)}`);
    return;
  }
  // shortcut: xdg-open and start only take the URL as an argument, so the one-time token (5 min, dies on first use) is briefly in ps there.
  const [cmd, args] = platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

const pad = (rows: string[][]) => {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join('  ')).join('\n') + '\n';
};

export async function main(argv: string[], d: Deps): Promise<number> {
  const out = d.out ?? ((s) => process.stdout.write(s));
  const err = d.err ?? ((s) => process.stderr.write(s));
  const ask = d.ask ?? askTty;
  const cmdName = d.cmd ?? 'multi-account-mcp';
  const none = `No accounts yet. Run \`${cmdName} add\`.\n`;
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const [cmd, target] = argv.filter((a) => !a.startsWith('--'));
  const yes = async (q: string) => {
    if (flags.has('--yes')) return true;
    const a = await ask(`${q} [y/N] `);
    if (a === undefined) err('There is no terminal to answer in. Run the command again with --yes.\n');
    return /^y(es)?$/i.test((a ?? '').trim());
  };

  async function find(q: string | undefined): Promise<Account | undefined> {
    const all = await d.store.list();
    const s = (q ?? '').trim().toLowerCase();
    const a = all.find((x) => x.id === s) ?? all.find((x) => x.address.toLowerCase() === s) ?? all.find((x) => x.label.toLowerCase() === s);
    if (a) return a;
    err(!q ? `Name an account.` : `No account "${q}".`);
    err(all.length ? ` Your accounts: ${all.map((x) => `${x.id} (${x.label}, ${x.address})`).join('; ')}\n` : ` ${none}`);
    return undefined;
  }

  try {
    if (flags.has('--version')) { out(`${VERSION}\n`); return 0; }
    if (flags.has('--help') || cmd === 'help') { out(HELP.replace('Usage: multi-account-mcp', `Usage: ${cmdName}`)); return 0; }

    if (cmd === 'add') {
      const s = await startSetupServer({ store: d.store, mail: d.mail, cmd: cmdName, ...d.setup });
      const stop = () => s.close();
      process.once('SIGINT', stop);
      out(`Open this page to add an account:\n  ${s.url}\n`);
      if (!flags.has('--no-open')) (d.openUrl ?? openBrowser)(s.url);
      // Developer notes stay here, never on the page, and only with MULTI_ACCOUNT_MCP_DEBUG set.
      const env = d.setup?.env ?? process.env;
      if (env.MULTI_ACCOUNT_MCP_DEBUG && !oauthProvider('google', env)) err('Developer note: Google sign-in is off in this build (no client id; set MULTI_ACCOUNT_MCP_GOOGLE_CLIENT_ID to try it).\n');
      if (env.MULTI_ACCOUNT_MCP_DEBUG && !oauthProvider('microsoft', env)) err('Developer note: Microsoft sign-in is off in this build (no client id; set MULTI_ACCOUNT_MCP_MICROSOFT_CLIENT_ID to try it).\n');
      err('The page closes when you click Done, after 15 minutes without use, or with Ctrl-C.\n');
      await s.done;
      process.off('SIGINT', stop);
      const n = (await d.store.list()).length;
      out(`Setup closed. ${n} account${n === 1 ? '' : 's'} saved.\n`);
      return 0;
    }

    if (cmd === 'list') {
      const all = await d.store.list();
      if (!all.length) { out(none); return 0; }
      out(pad([['ID', 'LABEL', 'ADDRESS', 'PROVIDER', 'SENDING'],
        ...all.map((a) => [a.id, a.label, a.address, a.provider, a.allowSend ? (a.sendWithoutConfirm ? 'on (no confirm)' : 'on') : 'off'])]));
      return 0;
    }

    if (cmd === 'remove') {
      const a = await find(target);
      if (!a) return 1;
      if (!(await yes(`Remove ${a.label} (${a.address}) and its saved login?`))) { err('Nothing removed.\n'); return 1; }
      await d.store.remove(a.id);
      out(`Removed ${a.label}.\n`);
      return 0;
    }

    if (cmd === 'test') {
      const list = target ? [await find(target)] : await d.store.list();
      if (target && list[0] === undefined) return 1;
      if (!list.length) { out(none); return 0; }
      let failed = 0;
      for (const a of list as Account[]) {
        try {
          await d.mail.verify(a, await getMailCredentials(d.store, a, d.refreshOAuth));
          out(`ok    ${a.label} (${a.address})\n`);
        } catch (e) {
          failed++;
          out(`fail  ${a.label} (${a.address}): ${e instanceof AccountError ? e.message : 'could not connect'}${e instanceof AccountError && e.code === 'auth_failed' ? ` Run \`${cmdName} add\`.` : ''}\n`);
        }
      }
      return failed ? 1 : 0;
    }

    if (cmd === 'allow-send') {
      const a = await find(target);
      if (!a) return 1;
      if (flags.has('--off')) {
        await d.store.update(a.id, { allowSend: false, sendWithoutConfirm: false });
        out(`Sending is off for ${a.label}.\n`);
        return 0;
      }
      if (!flags.has('--force')) {
        try {
          await d.mail.verify({ ...a, allowSend: true }, await getMailCredentials(d.store, a, d.refreshOAuth));
        } catch (e) {
          err(`Sending was not turned on: ${plainError(e, a.smtp.host, { sending: true, oauth: a.auth === 'oauth' })}\n`);
          err(`Fix the outgoing server, or run again with --force to turn sending on anyway.\n`);
          return 1;
        }
      }
      const noConfirm = flags.has('--no-confirm');
      err(`Sending lets your AI tool send email as ${a.address}.\n`);
      err(`Your AI tool asks you before each send, but a wrong or tricked request could still send mail in your name.\n`);
      if (noConfirm) {
        err(`WARNING: --no-confirm also lets sends go through WITHOUT asking you in AI tools that cannot show a confirmation prompt.\n`);
        err(`Anything your AI tool decides to send from ${a.label} will be sent. Turn it off with: ${cmdName} allow-send ${a.id} --off\n`);
      }
      if (!(await yes(`Turn on sending${noConfirm ? ' without confirmation' : ''} for ${a.label}?`))) { err('Nothing changed.\n'); return 1; }
      await d.store.update(a.id, { allowSend: true, sendWithoutConfirm: noConfirm });
      out(`Sending is on for ${a.label}${noConfirm ? ' (no confirmation prompt)' : ''}.\n`);
      return 0;
    }

    err(`multi-account-mcp: "${cmd}" is not available yet. Run ${cmdName} --help to see the commands.\n`);
    return 1;
  } catch (e) {
    err(`${e instanceof AccountError ? e.message : (e as Error).message}\n`);
    return 1;
  }
}
