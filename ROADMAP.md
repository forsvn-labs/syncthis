# syncthis roadmap

## Current handoff

Record consolidation: 13 October 2026. Delivery dates below retain the source record's dates. This migration does not verify a new release.

State: Maintained; branch work needs verification.

The 25 September handoff reports release 0.21.0 and host-directory work on feat/plugin-host-directory-sync. It does not prove that branch is integrated today.

Next action: Verify the branch and its PR before recording a release. Keep Cursor off native activation claims until a readable contract exists.

## Now

1. Maintain the 0.21.0 plugin hub, activation safety, client compatibility, and release truth.
2. Keep the host-directory map honest: write into each agent's real load path, report drift from `doctor`, and never promote directory listing to native activation.
3. Keep npm, the bundled release, docs, and `forsvn-labs/syncthis` aligned.

## Next

Turn package use into a lightweight feedback channel and prioritize verified client-contract gaps.
Expand native lifecycle support only when a readable, testable client contract exists — Cursor local Agent Plugins still need that contract before `native`.

## Later

Additional clients and adaptations follow preservation evidence. A proprietary plugin standard,
central hosted registry, and silent lossy conversion are out of scope.

## Earlier implementation evidence

The exact dated handoff and its verification details remain in [Git history](https://github.com/forsvn-labs/syncthis/blob/a7b0098df730c56f482e1ff371013e8109b4e588/PROGRESS.md). Recheck recorded branch work before promoting it to active or shipped.
