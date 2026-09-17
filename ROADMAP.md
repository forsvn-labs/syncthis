# Syncthis roadmap

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
