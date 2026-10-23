# Syncthis structure

This public repository owns the `@forsvn/syncthis` source. `app/` is a
code subtree, not a separate Git repository. npm is a distribution.

## Code architecture

[app/bin/syncthis.ts](app/bin/syncthis.ts) routes commands to shared
services. Native inventories identify installed plugins and source
provenance. Reconciliation produces target outcomes and guarded plans;
adapters apply supported capabilities, native lifecycle services verify
read-back, and doctor reports drift. The Ink hub uses the same services.

```text
app/bin/                         CLI entrypoint
app/src/control-center.tsx       Interactive plugin hub
app/src/sync.ts                  Cross-target coordination
app/src/plugins/inventory.ts     Native source discovery
app/src/plugins/reconcile.ts     Plans and target reconciliation
app/src/plugins/activation.ts    Guarded native lifecycle actions
app/src/plugins/host-map.ts      Per-agent load paths and ABI
app/src/plugins/host-sync.ts     Managed directory drops
app/src/plugins/outcome.ts       Canonical outcome vocabulary
app/src/plugins/secure-tree.ts   Source tree safety
app/src/doctor.ts                Diagnostics entry
app/tests/                      CLI, target, safety, and drift regressions
app/docs/                       Product/capability contracts
app/scripts/build.ts            Distribution build
docs/                           Repository-level project context
ops/                            Product metadata and operations
brand/                          Identity context
scripts/publish-mirror.sh        Historical export helper
```

The [product contract](app/docs/plugin-product-contract.md) defines native,
adapted, and blocked outcomes; [app/README.md](app/README.md) documents
commands. [README.md](README.md) has source setup and checks.

## External knowledge architecture

[BRAIN.md](BRAIN.md) resolves `forsvn/syncthis` to Google Drive and its
`OPEN THIS.md` source/resource/evidence map. Client-contract research,
private planning, and captures live there. Code, tests, bundled contracts,
and required build assets stay in Git; current work is summarized once
in [STATUS.md](STATUS.md). Client state remains in each client's existing
store and is not made authoritative by a Drive note.
