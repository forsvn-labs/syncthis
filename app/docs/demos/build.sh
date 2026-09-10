#!/usr/bin/env bash
# Regenerate the terminal demo GIFs. Deterministic and safe: every tape runs against a
# freshly-seeded throwaway $HOME under /tmp (see seed-fixtures.ts), so the recordings show
# real syncthis mutations without ever touching your actual agent configs.
#
# Requirements: vhs (https://github.com/charmbracelet/vhs) and bun.
# Usage: docs/demos/build.sh [tape-name]   # omit name to rebuild every tape
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

command -v vhs >/dev/null 2>&1 || { echo "error: vhs not found — install from https://github.com/charmbracelet/vhs" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "error: bun not found" >&2; exit 1; }

DEMO_HOME="${SYNCTHIS_DEMO_HOME:-/tmp/syncthis-demo-home}"

# A `syncthis` shim on PATH so tapes can type the real command name (not `bun bin/…`).
# Pinned to this repo's source via an absolute path, so it works regardless of $HOME.
SHIM_DIR="$(mktemp -d)"
cat > "$SHIM_DIR/syncthis" <<EOF
#!/usr/bin/env bash
exec bun "$ROOT/bin/syncthis.ts" "\$@"
EOF
chmod +x "$SHIM_DIR/syncthis"
cleanup() { rm -rf "$SHIM_DIR" "$DEMO_HOME"; }
trap cleanup EXIT

mkdir -p docs/demos/out

shopt -s nullglob
tapes=(docs/demos/tapes/*.tape)
if [ "${1:-}" != "" ]; then tapes=("docs/demos/tapes/$1.tape"); fi
[ ${#tapes[@]} -gt 0 ] || { echo "no tapes in docs/demos/tapes/ — nothing to build"; exit 0; }

for tape in "${tapes[@]}"; do
  name="$(basename "$tape" .tape)"
  rm -rf "$DEMO_HOME"
  bun docs/demos/seed-fixtures.ts "$DEMO_HOME" >/dev/null
  echo "recording $name …"
  # Fresh, sandboxed HOME + the shim on PATH for the recorded shell.
  PATH="$SHIM_DIR:$PATH" HOME="$DEMO_HOME" XDG_CONFIG_HOME="$DEMO_HOME/.config" vhs "$tape"
done

echo "done → docs/demos/out/"
