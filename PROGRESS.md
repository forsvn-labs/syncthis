# Syncthis progress

Updated: 2026-08-28
Owner: Hung
State: shipped and maintained; current release 0.21.0

## Resume here

Read `VISION.md`, this file, `ROADMAP.md`, `app/AGENTS.md`, and `app/CHANGELOG.md`.

## Current state

- Private source is `app/`; npm and `forsvn-labs/syncthis` are distributions.
- The reviewed 0.21.0 plugin hub and activation hardening are integrated on `main`.
- Retired Syncthis worktrees and lane branches are not sources of truth.
- All 591 tests, TypeScript verification, and the self-contained build passed on 2026-08-28.
- The 2026-08-28 mirror dry-run differs only in the generated instruction surface
  (`AGENTS.md` replaces `CLAUDE.md`). Nothing was pushed.

## Next action

Decide whether the instruction-surface change belongs in the next release, then verify npm and
mirror version parity. Choose further client work only from a reproducible compatibility gap.
