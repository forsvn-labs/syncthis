# Syncthis progress

Updated: 2026-09-17
Owner: Hung
State: shipped and maintained; current release 0.21.0; host-directory sync is on `feat/plugin-host-directory-sync`

## Resume here

Read `VISION.md`, this file, `ROADMAP.md`, `app/AGENTS.md`, and `app/CHANGELOG.md`.

## Current state

- Private source is `app/`; npm and `forsvn-labs/syncthis` are distributions.
- The reviewed 0.21.0 plugin hub and activation hardening are integrated on `main`.
- Host directory mapping writes local packages into each agent's real plugin/skills/MCP paths. Cursor local drops use `~/.cursor/plugins/local` and stay write-only.
- Retired Syncthis worktrees and lane branches are not sources of truth.

## Next action

Open the plugin-host-directory-sync PR after verification on this branch. Keep Cursor off the native registry until a readable activation contract exists. Then verify npm and mirror version parity.
