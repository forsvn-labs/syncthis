# Syncthis

Cross-client sync, adaptation, and verification for installed Agent Plugins.

- [VISION.md](VISION.md): users, intended outcomes, and scope.
- [BRAIN.md](BRAIN.md): external knowledge key and authorized Drive access.
- [STRUCTURE.md](STRUCTURE.md): architecture and repository map.
- [STATUS.md](STATUS.md): dated state, blockers, and next steps.

## Run from source

Use Bun for development and Node 22+ for the installed CLI.

```bash
cd app
bun install
bun bin/syncthis.ts help
bun run test
bun run lint
bun run typecheck
bun run build
```

Published usage: `npm install -g @forsvn/syncthis`, then
`syncthis plugins list` or `syncthis sync --dry-run`.
[app/README.md](app/README.md) covers commands and confirmations;
[CHANGELOG.md](CHANGELOG.md) links versioned releases. This repository
owns source; mirror-export scripts are historical helpers.
