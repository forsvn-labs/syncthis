# Structure

This public repository owns the `@forsvn/syncthis` source. `app/` is a code
subtree, not a separate Git repository. npm is a distribution.

## At a glance

```text
app/bin/                         CLI entrypoint
app/src/                         Shared services and interactive hub
app/tests/                       CLI, target, safety, and drift regressions
app/docs/                        Product and capability contracts
app/scripts/build.ts             Distribution build
docs/                            Repository-level project context
ops/                             Product metadata and operations
brand/                           Identity context
scripts/publish-mirror.sh        Historical export helper
```

## Code

| Path | Responsibility |
| --- | --- |
| `app/bin/syncthis.ts` | Route CLI commands to shared services |
| `app/src/control-center.tsx` | Interactive plugin hub using the same services |
| `app/src/sync.ts` | Cross-target coordination |
| `app/src/plugins/inventory.ts` | Native source discovery and provenance |
| `app/src/plugins/reconcile.ts` | Plans and target reconciliation |
| `app/src/plugins/activation.ts` | Guarded native lifecycle actions and verification |
| `app/src/plugins/host-map.ts` | Per-agent load paths and ABI |
| `app/src/plugins/host-sync.ts` | Managed directory drops |
| `app/src/plugins/outcome.ts` | Canonical outcome vocabulary |
| `app/src/plugins/secure-tree.ts` | Source tree safety |
| `app/src/doctor.ts` | Drift diagnostics |

From `app/`: `bun install`, `bun bin/syncthis.ts help`, `bun run test`,
`bun run lint`, `bun run typecheck`, and `bun run build`.
Development uses Bun. The installed CLI requires Node 22+.

## Read before changing

- [Product contract](app/docs/plugin-product-contract.md) before changes to
  plugin discovery, adaptation, outcomes, or native lifecycle behavior.
- [Package README](app/README.md) before changes to commands, confirmation,
  or compatibility behavior.

Where new work goes:

| To add | Put it in |
| --- | --- |
| A plugin target or lifecycle change | `app/src/plugins/` |
| A hub interaction | `app/src/control-center.tsx`, using shared services |
| A behavior regression check | `app/tests/` |
| A code-dependent product contract | `app/docs/` |
| Research or verification captures | Existing Drive routes in [BRAIN.md](BRAIN.md) |

Conventions: inventory identifies installed plugins and provenance.
Reconciliation plans target outcomes. Adapters apply supported capabilities,
and native lifecycle services verify with a fresh authoritative read.

## Knowledge

| Location | Contents |
| --- | --- |
| drive:forsvn/syncthis | Private client-contract research, planning, and captures; resolve in the owner's private registry, then open `OPEN THIS.md` |
| `app/docs/` | Bundled contracts and code-dependent documentation |
| `docs/pr/host-map.html` | Host-directory mapping reference |
| Each client's existing store | Client state; a Drive note does not make it authoritative |

New knowledge follows the save rules in [BRAIN.md](BRAIN.md).

## Other documents

- [README.md](README.md): source setup and checks.
- [app/README.md](app/README.md): public commands and confirmations.
- [CHANGELOG.md](CHANGELOG.md): recorded deliveries. [app/CHANGELOG.md](app/CHANGELOG.md): detailed version history and legacy Unreleased section.
- [PROGRESS.md](PROGRESS.md): current state, release gates, and deferred work.
- `AGENTS.md` and `CLAUDE.md`: agent entrypoints.
