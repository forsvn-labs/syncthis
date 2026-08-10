# CLAUDE.md

Guidance for agents working in the `syncthis` product repo. `AGENTS.md` and `GEMINI.md` mirror this file.

## Product contract

`syncthis` is the cross-client sync, adaptation, and verification layer for Agent Plugins.

Agent Plugins is the upstream canonical model. Syncthis must not define a competing manifest, registry, or plugin ecosystem; it owns only cross-client portability after a plugin exists in an authoritative source.

> **Install a plugin once. Use it everywhere.**

The only public object is an installed plugin. The public command surface is intentionally small:

```text
syncthis sync [--dry-run]
syncthis plugins list
syncthis plugins rm <name…> --all | --agents <a,b,c> [--yes] [--dry-run] [--keep-data]
syncthis doctor
syncthis update [--dry-run]
syncthis version
syncthis help
```

Every plugin-target has exactly one public outcome:

- `native` — readable native post-apply activation is verified.
- `adapted` — supported target-specific adaptation is usable without readable native activation.
- `partial` — some requested capability reached the target and another part is incomplete.
- `blocked` — a required read, write, install, or verification step failed.
- `unsupported` — positive evidence says the target or artifact cannot represent the requested form and no usable adaptation completed.

Do not introduce `original/native`, `wrapper`, `reach-only`, or `failed` as product outcomes. Native/projection detail is diagnostic evidence only. The default sync discovers installed plugins from every readable native source, uses a managed source-independent package store, applies target-specific installation/adaptation, and performs fresh native read-back.

## Runtime and distribution

- Development runtime: Bun (`bun bin/syncthis.ts`); published artifact: Node 18+.
- Source uses `node:*` builtins only. `bun build --target=node` creates `dist/syncthis.mjs` with a Node shebang.
- Runtime dependencies are bundled; do not add them back to `dependencies` or point `bin` at raw TypeScript.
- Tests use `bun:test`: `bun test`.
- Typecheck: `bun run typecheck`.
- Build: `bun run build`.

## Layout

```text
bin/syncthis.ts              CLI dispatch; public core plus hidden compatibility aliases
src/cli/help.ts              advertised help text
src/cli/plugin-outcomes.ts   shared canonical plugin-target presentation for CLI and TUI
src/tui.ts                   interactive Plugin Sync/List/Remove flows
src/welcome.tsx              first-run public command rows
src/sync.ts                  plugin-first reconciliation facade and internal lower-layer helpers
src/plugins/inventory.ts     discovery from readable native registries and staged artifacts
src/plugins/reconcile.ts     native target reconciliation and fresh read-back
src/plugins/store.ts         managed source-independent package materialization
src/plugins/degrade.ts       private target-specific projection decisions
src/plugins/outcome.ts       canonical five-outcome composition
src/plugins/targets.ts       verified native, write-only, and no-native target registry
src/plugins/add.ts           retained bounded plugin-add compatibility path
src/plugins/mirror.ts        retained legacy mirror compatibility path
src/plugins/uninstall.ts     guarded plugin removal and private projection cleanup
src/skills.ts                internal projection mechanism; not a public product or CLI noun
src/adapters/                internal lower-layer config adapters, including private projections
```

Readable native plugin sources are Claude Code, Codex, GitHub Copilot, and Grok Build. Cursor is a write-only target and must never be reported as native. Prime Agent, Pi, and Cline are skill-backed adaptation targets; Cline's separate TypeScript plugin ABI is not Agent Plugins-native. Targets without a proven native ABI may receive private adaptations when the exact artifact supports them.

`plugins add`, `plugins mirror`, and top-level `add`, `mirror`, and `run` remain callable compatibility paths, but are not advertised or used by the default workflow. Do not expand them as part of the plugin-first core. The default interactive Plugin Sync must call the same `runSync({ dryRun })` preview/apply contract as the CLI and must not add source/plugin/target selection or call `runPluginAdd`.

Bundled implementation components remain allowed behind the projection boundary because plugins still need them internally. They must not appear as top-level products, public command groups, public statuses, or a second list of projected fragments. Use `src/cli/plugin-outcomes.ts` for user-facing sync output and sanitize secondary diagnostics with the existing neutral plugin wording.

## CLI and TUI rules

- Keep HELP, PLUGINS_HELP, README, welcome rows, and TUI guidance limited to the reliable core.
- `--no-wrapper` is accepted only as a hidden legacy compatibility flag. Do not advertise it or add a replacement reach-disabling flag; the public promise is everywhere.
- Keep `plugins add` and `plugins mirror` callable without making them part of the default flow or public help.
- The default sync is additive and never uninstalls. `plugins rm` is the only public removal path.
- Present one canonical outcome per plugin-target. Never print a second public list of private projection records.

## Sacred safety invariants

1. **Removal has explicit rails.** Plugin removal requires an explicit `--all` or `--agents` scope, prints a diff before writes, confirms interactively or requires `--yes` in non-interactive mode, and supports `--dry-run`. `--all` and `--agents` are mutually exclusive. A projection still provided by another installed plugin must be kept. There is no implicit deletion in sync.
2. **`.syncthis.bak` backup on first write.** Every target file gets the existing backup suffix on its first syncthis write. Do not change this contract.
3. **Conflict preservation.** Additive projection and lower-layer sync leave an agent's conflicting existing copy untouched and report the conflict. Never pick a winner silently.
4. **Secret-bearing files are `0600`.** All adapter writes that may contain credentials clamp permissions to `0600`.
5. **Destructive directional internals require confirmation.** Any retained lower-layer directional operation must show a diff and prompt, or require `--yes` outside a TTY. Do not make it silently overwrite.
6. **Claude project scope preservation.** The Claude lower-layer adapter reads top-level and every `projects.*.mcpServers` scope, but writes only top-level and leaves project scopes intact.

## Verification

Before declaring a code change complete, run the focused tests relevant to the change, then:

```sh
bun run typecheck
bun test
bun run build
git diff --check
```

Inspect `git diff` and keep the change local. Do not push, publish, open a PR, or edit public mirrors from this repo task.
