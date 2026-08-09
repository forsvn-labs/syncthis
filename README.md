# syncthis

**Install a plugin once. Use it everywhere.**

`syncthis` is the cross-client sync, adaptation, and verification layer for [Agent Plugins](https://agent-plugins.org/). Agent Plugins defines the plugin model; syncthis does not compete with it or invent another format or registry. It starts with plugins installed in one coding agent and makes them usable everywhere else.

The only public object is an installed plugin. Syncthis discovers plugin installations from readable native hosts, packages their source independently of any one client cache, reconciles them across supported targets, and reports what each target can honestly claim.

## Quick start

```sh
npm install -g @hungv47/syncthis

syncthis plugins list
syncthis sync --dry-run
syncthis sync
```

Running `syncthis` with no arguments opens the Plugin Sync flow in a terminal. It discovers installed plugins automatically; there is no source, plugin, or destination picker in the default workflow. A non-interactive invocation prints help.

## Public commands

```text
syncthis sync [--dry-run]
syncthis plugins list
syncthis plugins rm <name…> --all | --agents <a,b,c> [--yes] [--dry-run] [--keep-data]
syncthis doctor
syncthis update [--dry-run]
syncthis version
syncthis help
```

- `sync` discovers installed plugins from every readable native source and reconciles them across every supported target. It is additive and never uninstalls.
- `plugins list` is read-only and shows native state for readable hosts plus Cursor's write-only limitation.
- `plugins rm` is the guarded removal path. It requires an explicit scope, shows the exact change set, and requires terminal confirmation or `--yes`.
- `doctor` is a read-only plugin overview.
- `update` updates syncthis itself; `version` prints the installed version.

## How sync works

1. **Discover.** The default sync reads installed plugin records from Claude Code, Codex, and GitHub Copilot when their native registries are readable. A failed source read is reported as `blocked`; an empty source is not silently treated as proof that no plugins exist.
2. **Package.** A discovered plugin is materialized into syncthis's managed, source-independent package store. Target installs therefore do not depend on a source client's mutable cache or on a guessed marketplace name.
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

The matrix describes the normal capability path, not a guarantee that every plugin artifact is portable. A particular target can honestly report `partial`, `blocked`, or `unsupported` instead.

## Safety

- Sync is additive. It never uninstalls existing plugins.
- Plugin removal requires an explicit `--all` or `--agents` scope, a preview of the exact changes, and confirmation in interactive or `--yes` in non-interactive mode.
- `--dry-run` never writes.
- `--all` and `--agents` are mutually exclusive.
- Readable native installs require fresh read-back verification.
- `--keep-data` is opt-in and only affects supported Claude uninstall paths.

Private target adaptations may use bundled implementation components behind the boundary, but those components are not public products, installed-plugin records, or public statuses.

## Notes

- The package runs on Node 18+ and Bun 1+.
- The default promise is everywhere: there is no public reach-disabling switch.

## License

MIT
