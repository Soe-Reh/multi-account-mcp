import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests must never read the real data folder (accounts, oauth.json).
process.env.MULTI_ACCOUNT_MCP_HOME ??= mkdtempSync(join(tmpdir(), 'mam-test-home-'));

export default defineConfig({ test: { unstubEnvs: true } });
