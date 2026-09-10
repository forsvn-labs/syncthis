#!/usr/bin/env bash
set -euo pipefail
IPSE_ROOT="$(git rev-parse --show-toplevel)"
ACTION="${1:-dry-run}"
exec "$IPSE_ROOT/_hq/tools/publish-public-mirror.sh" "$ACTION" syncthis
