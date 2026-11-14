#!/usr/bin/env bash
# Fresh-machine test: build, pack, install the tarball into a temp prefix with a temp HOME, then run the stranger check
# against the installed binary. macOS and Linux. Downloads dependencies from the npm registry; contacts no mail provider.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build >/dev/null
work="$(mktemp -d "${TMPDIR:-/tmp}/mam-stranger-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/home" "$work/prefix"

tarball="$(npm pack --silent --pack-destination "$work")"
echo "ok   packed $tarball ($(du -k "$work/$tarball" | cut -f1) KB)"

HOME="$work/home" npm_config_update_notifier=false npm_config_cache="$work/home/.npm" npm install --global --prefix "$work/prefix" --no-fund --no-audit --loglevel=error "$work/$tarball" >/dev/null
bin="$work/prefix/bin/multi-account-mcp"
[ -x "$bin" ] || { echo "FAIL installed bin is missing or not executable: $bin"; exit 1; }
head -1 "$work/prefix/lib/node_modules/multi-account-mcp/dist/cli/index.js" | grep -qx '#!/usr/bin/env node' || { echo "FAIL no shebang"; exit 1; }
echo "ok   installed into a temp prefix with a temp HOME; bin is executable with a node shebang"

HOME="$work/home" node scripts/stranger-check.mjs "$bin"
