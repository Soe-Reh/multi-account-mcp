// How this installation was launched, so the commands we print and the config entries we write actually run.
import { realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME = 'multi-account-mcp';
/** This installation's entry point (works from src/ in tests and from dist/ when installed). */
export const SCRIPT = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

export interface Self { script: string; node: string; npx: boolean; onPath: boolean }

const real = (p: string) => { try { return realpathSync(p); } catch { return undefined; } };
/** The first `name` on PATH that is really `target`. node_modules/.bin dirs only exist inside npm runs, not in the user's shell. */
function findOnPath(name: string, target: string | undefined, env: NodeJS.ProcessEnv) {
  if (!target) return undefined;
  for (const d of (env.PATH ?? '').split(delimiter)) {
    if (d && !/[\\/]node_modules[\\/]/.test(`${d}/`) && real(join(d, name)) === target) return join(d, name);
  }
  return undefined;
}

export function detectSelf(env: NodeJS.ProcessEnv = process.env, script = SCRIPT, execPath = process.execPath): Self {
  const realScript = real(script) ?? script;
  return {
    script,
    npx: realScript.split(/[\\/]/).includes('_npx'), // npx unpacks registry packages under ~/.npm/_npx/<hash>/
    node: findOnPath('node', real(execPath), env) ?? execPath, // e.g. /opt/homebrew/bin/node, not a versioned Cellar path
    onPath: !!findOnPath(NAME, realScript, env),
  };
}

const quote = (s: string) => (/^[\w./:@=+-]+$/.test(s) ? s : JSON.stringify(s));

/** The command a person types to run this installation. */
export function invocation(s: Self): string {
  return s.npx ? `npx -y ${NAME}` : s.onPath ? NAME : `node ${quote(s.script)}`;
}
