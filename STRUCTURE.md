# syncthis structure

This Git root owns the files tracked in [forsvn-labs/syncthis](https://github.com/forsvn-labs/syncthis). The repository is public. Keep private planning and external folder identities in the authorized Drive lookup.

VISION.md records purpose. ROADMAP.md owns priorities, active work, blockers, and the live handoff. CHANGELOG.md records verified delivery. STRUCTURE.md maps ownership and working commands. DRIVE.md locates external materials.

## Architecture and ownership

app/ owns the plugin CLI, discovery, adaptation, reconciliation, and verification. ops/ owns product operations; brand/ owns identity context. npm is a distribution. app/ is a code subtree in this root, not a separate Git repository. Agent Plugins owns the plugin model.

## Source map

| Path | Purpose |
|---|---|
| `app/` | Application source |
| `brand/` | Brand / design-system |
| `CHANGELOG.md` | What has shipped |
| `ops/` | Ops scripts and local runtime |
| `README.md` | Human entry |
| `ROADMAP.md` | What will ship |
| `scripts/` | Tooling |
| `VISION.md` | Why this exists |

## Working commands

- From `app`, run `bun install` before package work. Available commands: `bun run test`, `bun run lint`, `bun run typecheck`, `bun run build`.

Use [README.md](README.md) for setup details and project-specific validation. This record migration does not re-run application release or deployment gates.

## Record history

Useful current work moved to ROADMAP.md where this is a product. Location and repository facts moved here. Earlier exact records remain in Git history:

- [PROGRESS.md at a7b0098](https://github.com/forsvn-labs/syncthis/blob/a7b0098df730c56f482e1ff371013e8109b4e588/PROGRESS.md)
- [INDEX.md at a7b0098](https://github.com/forsvn-labs/syncthis/blob/a7b0098df730c56f482e1ff371013e8109b4e588/INDEX.md)

## External materials and recall

Use DRIVE.md for original media, sendables, and verification evidence. Keep deployable assets needed by a build in Git with their source and license. Mem0 is optional recall through the correct Executor v2 account. Store a scope, project key, source pointer, and truth date; open the current source before using a recalled claim. Do not upload credentials, private identity, medical, finance, or employer-confidential source bodies.
