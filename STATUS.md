# Syncthis status

Evidence reviewed: 2026-10-23, source baseline `00a5a43`.
Package tests, live client contracts, and npm availability were not
rechecked during this documentation/source review.

## Shipped / recorded release

- [app/CHANGELOG.md](app/CHANGELOG.md) records `0.21.0` on 2026-08-26:
  the installed-plugin hub, guarded activation/configuration, and
  compatibility/release-truth work. Local tag `v0.21.0` exists;
  [app/package.json](app/package.json) still declares `0.21.0`.

## Integrated source / release pending

- Host-directory mapping and managed sync are already in this baseline:
  `d046ff2` and the Cursor manifest guard `5d556c5` are ancestors of HEAD.
  See [host-map.ts](app/src/plugins/host-map.ts),
  [host-sync.ts](app/src/plugins/host-sync.ts), and their
  [tests](app/tests/plugin-host-sync.test.ts). The older handoff's branch
  integration question is resolved; a later package release is not proven.
- The package changelog also records doctor inventory presentation,
  host-skills adaptation, managed removal, and test-prune work as
  unreleased. No separately active implementation branch is established.

## Planned and next steps

1. Maintain the `0.21.0` hub, activation safety, compatibility, and release
   contracts. Keep source, bundled release, documentation, and npm aligned.
2. Run existing test, lint, typecheck, and build gates before a new package;
   verify release/version parity after an authorized publish.
3. Gather real package-use feedback; prioritize demonstrated client-contract
   gaps. Expand native lifecycle support only with readable, testable evidence.

## Blockers and not built

Cursor remains write-only/adapted under the checked-in
[product contract](app/docs/plugin-product-contract.md); directory presence
is not native activation. A verified native lifecycle for Cursor and a
later released host-directory package remain unestablished. Additional
clients follow preservation evidence. A proprietary standard, central
registry, and silent lossy conversion remain outside scope.
