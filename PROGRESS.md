# Progress

Updated: 2026-10-23 · Stage: live · Health: At risk

The recorded release is 0.21.0. Host-directory work is integrated source,
with no later package release established. Product checks were not rerun.
The historical archive gate has no recorded outcome.

Next action: Run the existing package gates before a new release. Owner: Unknown.

## Current state

| State | Item | Evidence | Date |
| --- | --- | --- | --- |
| Built, not shipped | Host-directory mapping and Cursor manifest guard | `d046ff2`, `5d556c5`, [host-sync tests](app/tests/plugin-host-sync.test.ts); reviewed 2026-10-23 | 2026-09-17 |
| Built, not shipped | Doctor presentation, host-skills adaptation, managed removal, and test pruning | [Package changelog](app/CHANGELOG.md), Unreleased; no separate active implementation branch established | 2026-10-23 |
| Next | Maintain 0.21.0 hub, activation safety, compatibility, and release contracts | Previous STATUS, source baseline `00a5a43`; keep source, bundle, docs, and npm aligned | 2026-10-23 |
| Blocked | Verified native Cursor lifecycle | [Product contract](app/docs/plugin-product-contract.md#cursor-limitation); no readable, testable activation contract | 2026-10-23 |
| Needs decision | Historical validation gate: archive absent traction by 2026-08-01, or earlier if executor.sh adds Claude-plugin support | Hung; [June plan](app/docs/plans/2026-06-20-001-feat-unified-add-verb-positioning-plan.md); gate outcome unknown | 2026-06-20 |

## Gates

- Before a new package, run existing test, lint, typecheck, and build gates from [README](README.md#run-from-source).
- After an authorized publish, verify release/version parity. Tests or a merge do not prove delivery.
- Plan before writes. Verify native activation with a fresh authoritative read; directory inventory alone proves no activation.
- Expand native lifecycle support only with readable, testable evidence. Cursor remains write-only/adapted under the [product contract](app/docs/plugin-product-contract.md).

## Later

- Gather real package-use feedback. Prioritize demonstrated client-contract gaps; additional clients need capability-preservation evidence.

## 2026-11-01

- Migrated records to PROGRESS. Old STATUS and ROADMAP are in commit `d8cedb7`.
  Product state and provider access were not reverified.
- Flagged the historical validation gate. Later releases and the accepted
  October vision exist, but the gate's disposition is not recorded.

## 2026-10-23

- Reviewed source baseline `00a5a43` in [PR #13](https://github.com/forsvn-labs/syncthis/pull/13).
  Host-directory commits were integrated. Package tests, live client
  contracts, and npm availability were not rechecked.

## 2026-08-26

- Recorded release 0.21.0: installed-plugin hub, guarded activation and
  configuration, compatibility, and release-truth work. Evidence:
  [published release](https://github.com/forsvn-labs/syncthis/releases/tag/v0.21.0),
  [package changelog](app/CHANGELOG.md), local tag `v0.21.0`, and
  [package version](app/package.json). No fresh runtime or npm check is implied.
