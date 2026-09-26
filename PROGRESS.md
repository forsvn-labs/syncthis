# Syncthis progress

Updated: 2026-09-25
Owner: Hung
State: shipped and maintained; current release 0.21.0; host-directory sync is on `feat/plugin-host-directory-sync`

## Resume here

Read `VISION.md`, this file, `ROADMAP.md`, `app/AGENTS.md`, and `app/CHANGELOG.md`.

## Current state

- Private source is `app/`; npm and `forsvn-labs/syncthis` are distributions.
- The reviewed 0.21.0 plugin hub and activation hardening are integrated on `main`.
- Host directory mapping writes local packages into each agent's real plugin/skills/MCP paths. Cursor local drops use `~/.cursor/plugins/local`, stay write-only, and copy only an existing root `plugin.json` or `.cursor-plugin/plugin.json`.
- Retired Syncthis worktrees and lane branches are not sources of truth.
- Test prune (2026-09-25, `codex/prune-low-signal-tests-20260925`): removed 3 low-signal unit-test files (14 tests; 40 → 37 files). Review correction restored `tests/tui-layout.test.ts` with constant-pinning assertions pruned to behavioral bounds (26 tests kept). No product change; `package.json` scripts and CI untouched (no CI names removed tests). Verification artifact: `/tmp/syncthis-verify/verify.sh` + `verify.log` (outside the repo).

## Next action

Open the plugin-host-directory-sync PR after verification on this branch. Keep Cursor off the native registry until a readable activation contract exists. Then verify npm and mirror version parity.
