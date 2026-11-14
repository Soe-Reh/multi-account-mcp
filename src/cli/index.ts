#!/usr/bin/env node
// Command line entry. `serve` (or no command) runs the stdio MCP server; the account commands live in commands.ts.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAccountStore } from '../accounts/index.js';
import { createRefreshOAuth } from '../auth/oauth.js';
import { createMailClient } from '../mail/index.js';
import { ADD_TIMEOUT_MS } from '../setup/server.js';
import { createServer } from '../tools/server.js';
import { main } from './commands.js';
import { install } from './install.js';
import { detectSelf, invocation } from './self.js';

// stdout carries the MCP protocol (serve) or command results only: logs go to stderr.
const stdout = process.stdout.write.bind(process.stdout);
console.log = console.info = console.debug = console.error;

const argv = process.argv.slice(2);
const self = detectSelf();
const cmd = invocation(self);
if (argv[0] === 'install') {
  // Before the account store: installing touches only the AI tool's config.
  process.exitCode = await install(argv.slice(1), { out: (s) => void stdout(s), self });
} else {
  const store = await createAccountStore();
  const refreshOAuth = createRefreshOAuth(store);
  if ((argv[0] ?? 'serve') === 'serve') {
    await createServer({ store, mail: createMailClient(), refreshOAuth, cmd }).connect(new StdioServerTransport());
  } else {
    process.exitCode = await main(argv, { store, mail: createMailClient(), refreshOAuth, cmd, out: (s) => void stdout(s),
      setup: { mail: createMailClient({ timeoutMs: ADD_TIMEOUT_MS }) } });
  }
}
