# Syncthis

**Install a plugin once. Use it everywhere.**

Syncthis is the cross-client sync, adaptation, and verification layer for [Agent Plugins](https://agent-plugins.org/). Agent Plugins defines the plugin model; Syncthis does not compete with it or invent another format or registry. It starts with plugins installed in one coding agent and makes them usable everywhere else.

The only public object is an installed plugin. Syncthis discovers plugin installations from readable native hosts, packages their source independently of any one client cache, reconciles them across supported targets, and reports what each target can honestly claim.

## Quick start

```sh
npm install -g @forsvn/syncthis

syncthis plugins list
syncthis sync --dry-run
syncthis sync
```

Running `syncthis` with no arguments opens the Ink plugin hub. It leads with what you already have: installed plugins across readable agents, with every write behind an explicit preview and confirmation. A non-interactive invocation prints help.

The plugin hub has six focused actions:

- **Installed plugins** shows one selectable list of installed plugins; opening a plugin shows its detail view — name and marketplace, per-readable-agent native state, enabled/disabled, version, config scope, and provenance/path when known. Unreadable agents stay blocked and Cursor stays explicitly write-only.
- **Sync plugins** runs the same dry-run reconciliation as `syncthis sync --dry-run`, shows one canonical outcome per plugin-target, and requires an explicit apply key before writing.
- **Configure plugins** enables or disables installed plugins per agent. It reuses the same guarded activation service as `syncthis plugins enable|disable`: choose plugins, pick all or exact agents, pick a Claude scope when Claude Code is the only target, then confirm from an authoritative preview with exact native commands.
- **Doctor** combines source health, native state, and the synchronization preview in one read-only report.
- **Remove plugins** requires plugin selection, an explicit all-or-agent scope, an exact preview, and a second confirmation key. Modified conflicts and content still owned by another plugin are kept.
- **Update Syncthis** previews the exact package-manager command and target before running the same self-update service as the CLI.

The hub inventories, syncs, adapts, configures, removes, diagnoses, and verifies installed plugins. It is not a registry or marketplace browser, and it never browses the internet for plugins.

## Public commands

```text
syncthis sync [--dry-run]
syncthis plugins list
syncthis plugins enable <name…> --all | --agents <a,b,c> [--scope user|project|local] [--yes] [--dry-run]
syncthis plugins disable <name…> --all | --agents <a,b,c> [--scope user|project|local] [--yes] [--dry-run]
syncthis plugins rm <name…> --all | --agents <a,b,c> [--yes] [--dry-run] [--keep-data]
syncthis doctor
syncthis update [--dry-run]
syncthis version
syncthis help
```

- `sync` discovers installed plugins from every readable native source and reconciles them across every supported target. It is additive and never uninstalls.
- `plugins list` is read-only and shows native state for readable hosts plus Cursor's write-only limitation.
- `plugins enable|disable` turn installed plugins on/off through each target's own CLI, guarded by preview and confirmation, with fresh native read-back verification. Claude Code alone accepts an explicit `--scope user|project|local`; omit it to keep each record's own scope.
- `plugins rm` is the guarded removal path. It requires an explicit scope, shows the exact change set, and requires terminal confirmation or `--yes`.
- `doctor` is a read-only source and target-outcome diagnostic. It exits non-zero when a source or synchronization preview is blocked.
- `update` updates the `syncthis` executable; `version` prints the installed version.

## How sync works

1. **Discover.** The default sync reads installed plugin records from Claude Code, Codex, GitHub Copilot, and Grok Build when their native registries are readable. A failed source read is reported as `blocked`; an empty source is not silently treated as proof that no plugins exist.
2. **Package.** A discovered plugin is materialized into Syncthis's managed, source-independent package store. Target installs therefore do not depend on a source client's mutable cache or on a guessed marketplace name.
3. **Reconcile.** Targets with a proven native plugin ABI receive the plugin through their own installer. Targets without one receive the safest supported adaptation when the package can be represented there. Existing conflicting state is left untouched.
4. **Verify.** Every readable native target is read again after apply. An installer exit code alone is never proof of native activation. Cursor is write-only, so a successful push is reported as an adaptation rather than native activation.
5. **Report.** Each plugin-target has exactly one public outcome. Detailed installer and adaptation diagnostics are secondary evidence, never extra product categories.

## Canonical outcomes

Every plugin-target reports exactly one of these five values:

- **native** — a readable native runtime reports the plugin after apply, or the dry-run has a verified native plan.
- **adapted** — the plugin is usable through a supported target-specific adaptation without readable native activation.
- **partial** — some requested plugin capability reached the target, but another part remains incomplete.
- **blocked** — a required source read, target write, install, or verification step failed.
- **unsupported** — positive evidence says the target or artifact cannot represent the requested plugin form and no usable adaptation completed.

The detailed report never upgrades unresolved work into a success. Conflicts, omitted components, and unverifiable activation remain visible through the appropriate canonical outcome.

## Supported host matrix

| Host | Native state readable | Typical plugin outcome |
| --- | --- | --- |
| Claude Code | Yes | native |
| Codex | Yes | native |
| GitHub Copilot | Yes | native |
| Grok Build | Yes | native |
| Cursor | No | adapted |
| OpenCode | No | adapted |
| Hermes Agent | No | adapted |
| Gemini CLI | No | adapted |
| Kimi CLI | No | adapted |
| Antigravity | No | adapted |
| Windsurf | No | adapted |
| OpenClaw | No | adapted |
| Goose | No | adapted |
| Pi | No | adapted |
| Cline | No | adapted |
| Prime Agent | No | adapted |

The matrix describes the normal capability path, not a guarantee that every plugin artifact is portable. A particular target can honestly report `partial`, `blocked`, or `unsupported` instead.

Syncthis drives Grok Build through its proven `grok plugin` CLI: trusted installation, activation, listing, and removal of exact translated artifacts, each verified by a fresh read-back. That CLI is a Claude Code-lineage command surface, and xAI's official documentation does not claim agent-plugins.org or root `plugin.json` conformance — so Syncthis's verified-native entry for Grok rests on the proven CLI contract alone (readable JSON state, read-back, exact translation), never on an upstream certification claim. Prime Agent, Pi, and Cline receive private capability-preserving adaptations; Cline's separate TypeScript plugin ABI is not treated as Agent Plugins-native, so Syncthis does not generate or claim a native Cline wrapper.

### Compatibility honesty

- **Cursor** accepts the root Agent Plugins manifest natively today, but Syncthis has no integrated, verified native read or read-back for it. Cursor therefore remains a conservative write/adaptation target in Syncthis and is never reported as readable or natively verified — the limitation is Syncthis's integration boundary, not a Cursor capability claim.
- **Claude Code** uses its `.claude-plugin` overlay plus its own scoped plugin CLI; that is how Syncthis reads and drives it.
- **Grok Build** is Claude-lineage and compatible in practice, but xAI's official documentation does not claim agent-plugins.org conformance; Syncthis relies only on the proven `grok plugin` CLI contract.
- **OpenAI** authoring exposes `.codex-plugin` overlays while Agent Plugins lists ChatGPT/Codex as compatible; Syncthis reads what Codex actually reports through its own CLI.
- **OpenCode** plugins are hook modules, so Syncthis adapts their portable content rather than claiming OpenCode hosts Agent Plugins.

Agent Plugins v1.0.0 itself is an open portable directory package spec: a required root `plugin.json`, optional bundled capability folders next to it, and per-client extensions. It is not an install/update/uninstall registry, secrets or OAuth protocol, arbitrary settings schema, or hooks/agents/rules/LSP contract — v1 has none of those, and neither Syncthis nor this documentation claims them.

## Safety

- Sync is additive. It never uninstalls existing plugins.
- Plugin removal requires an explicit `--all` or `--agents` scope, a preview of the exact changes, and confirmation in interactive or `--yes` in non-interactive mode.
- `--dry-run` never writes.
- `--all` and `--agents` are mutually exclusive.
- Readable native installs require fresh read-back verification.
- `--keep-data` is opt-in and only affects native uninstall paths that support it (currently Claude Code and Grok Build).

Private target adaptations may use bundled implementation components behind the boundary, but those components are not public products, installed-plugin records, or public statuses.

## Compatibility note

The executable remains `syncthis`, the npm package remains `@forsvn/syncthis`, repository URLs remain unchanged, and existing config paths, `SYNCTHIS_*` environment variables, and `.syncthis.bak` backup identifiers remain compatible.

## Notes

- The package runs on Node 22+ and Bun 1+.
- The default promise is everywhere: there is no public reach-disabling switch.

## License

MIT
