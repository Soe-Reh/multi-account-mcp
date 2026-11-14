// After build: the bin must start with a node shebang and be executable, or `npx multi-account-mcp` fails.
import { chmodSync, readFileSync } from 'node:fs';
const bin = new URL('../dist/cli/index.js', import.meta.url);
if (!readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n')) {
  console.error('dist/cli/index.js has no "#!/usr/bin/env node" first line.');
  process.exit(1);
}
chmodSync(bin, 0o755);
