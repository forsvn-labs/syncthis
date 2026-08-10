# Changelog

All notable changes to `@hungv47/syncthis` are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions are [SemVer](https://semver.org/).

## [0.18.0] — 2026-08-10

### Added
- **Grok Build native plugin sync.** Grok joins the readable native registry through its official plugin CLI: exact Agent Plugin installation with explicit trust, activation, JSON read-back verification, and guarded uninstall.
- **Prime Agent adaptation.** Prime Agent receives compatible plugin skills through the universal `~/.agents/skills` store used by its native skill discovery.

### Clarified
- **Cline remains an honest adaptation.** Cline's TypeScript plugin ABI is distinct from Agent Plugins, so syncthis surfaces compatible skills without generating a wrapper or claiming native activation.

### Fixed
- **Grok lifecycle verification fails closed.** Syncthis verifies exact source identity, positive activation, repository containment, and post-operation native state before reporting success.
- **Grok removal preserves unrelated plugins.** Ambiguous marketplace removals and single-plugin removals from multi-plugin repositories are refused instead of allowing Grok's repository-wide uninstall to remove more than requested.
- **Plugin subprocess timeouts terminate reliably.** Commands that ignore `SIGTERM` are force-killed after a bounded grace period so synchronization cannot hang indefinitely.

## [0.17.0] — 2026-08-10

### Added
- **Install once, use everywhere.** The default sync now discovers installed Agent Plugins from every readable native client, materializes a source-independent package, reconciles every supported target, and verifies readable native activation after apply.
- **Honest cross-client outcomes.** Every plugin-target pair reports exactly `native`, `adapted`, `partial`, `blocked`, or `unsupported`, including mixed adaptation failures and write-only targets such as Cursor.
- **Durable, secure plugin packages.** Content-addressed storage, stable source-tree snapshots, atomic materialization, and tamper checks keep synchronized plugins independent of mutable client caches.

### Changed
- **Plugins are the product.** The CLI, TUI, README, package metadata, and default runtime now expose plugins as the only public object. Skills and MCP remain private adaptation mechanisms rather than competing product surfaces.
- **Agent Plugins stays canonical.** Syncthis adopts the upstream Agent Plugins model and acts only as its cross-client sync, adaptation, and verification layer; it does not define a competing plugin format or registry.
- Legacy add, mirror, and lower-layer aliases remain callable for migration but are no longer advertised or run by the default sync workflow.

## [0.16.0] — 2026-08-02

### Added
- **Plugin-first runtime lifecycle reconciliation.** `syncthis run` now inventories plugin sources and native runtime state, installs or repairs verified activation on Claude Code, Codex, and GitHub Copilot CLI, and pushes Cursor through its write-only installer.
- **Exact, fail-closed degradation.** Unsupported artifact/target pairs receive only the bundled skills and MCP servers they can use; unreadable or unverifiable native activation remains a surfaced failure. MCP union sync and the skills refresh run after plugin reconciliation.

## [0.15.1] — 2026-06-09

### Fixed
- **First-run welcome banner now shows the noun-first grammar.** The 0.15.0 refactor moved the canonical surface to noun-first verbs but left `welcome.tsx`'s hardcoded command list on the pre-0.15 spelling (`add plugin`, bare `mcp`/`skills`, `<from> <to>`, `rm <server>`, `plugin list`). The banner now lists `plugins add`, `mcp sync`, `skills update`, `mcp <from> <to>`, `mcp rm`, and `plugins list`, matching `syncthis help`.

## [0.15.0] — 2026-06-09

Includes everything in 0.14.1 (cross-agent plugin/skill identity hardening), which was never published on its own.

### Added
- **Noun-first CLI grammar.** Three nouns — `plugins`, `skills`, `mcp` — each with scoped verbs (`plugins list|mirror|add|rm`, `skills update|add|from-plugins|rm`, `mcp sync|doctor|from|rm`, plus directional `mcp <from> <to>`), alongside the flagship `sync`. This is now the canonical, advertised surface (`syncthis help`, `syncthis <noun> help`). The change is **additive and non-breaking**: every pre-0.15 command still works as an unadvertised alias routing to the same handler (`run`, bare `mcp`, `doctor`, `mirror`, `from`, `<from> <to>`, `add`/`rm <skill|plugin|mcp>`, `plugin list`/`plugin rm`). Bare-noun behavior preserves legacy side effects (`mcp` → union sync, `skills` → update) while help advertises the explicit verbs; bare `plugins` prints group help. A collision guard in `cmdMcp` keeps a future agent id from being shadowed by a verb name. Routing + alias equivalence is pinned by `tests/cli-routing.test.ts`.
- **Reproducible terminal demos.** VHS tapes (`docs/demos/tapes/`) render the GIFs embedded in the README from a sandboxed fixture-`$HOME` harness (`docs/demos/seed-fixtures.ts`, `docs/demos/build.sh`): pure-file MCP flows are recorded live (showing real mutations + the `.syncthis.bak` backup), shell-out plugin/skills flows as dry-run/preview, so no external CLIs are needed and the output is deterministic.

### Changed
- **Inline TUI walk-through guidance.** The interactive picker now renders breadcrumb headers and inline affordances via the existing `note()`/`tui-style` helpers (no new mode, no new runtime deps), so each flow shows where you are in source → items → destinations → preview → confirm.

## [0.14.1] — 2026-06-09

### Fixed
- **Cross-agent plugin identity now survives URL-derived name sanitization.** Claude reports a repo-sourced plugin as `github.com-owner-repo`, while Codex stores the same repo as `github-com-owner-repo`. The mirror diff, Codex install/uninstall matching, plugin-uninstall record matching, and installed-repo coverage all keyed on the raw spelling, so the same plugin looked like two — `mirror` queued spurious re-adds and `plugin rm` could miss an instance. A new `pluginIdentityKeys`/`pluginNamesOverlap` pair (`src/plugins/shell.ts`) treats the two spellings as one identity for diff/coverage while preserving each agent's own stored name for the actual install/uninstall command.
- **Skill sync to Kimi no longer rejects the whole invocation.** Syncthis' agent id is `kimi-cli`, but `vercel-labs/skills` names the same target `kimi-code-cli`; passing the syncthis id made the upstream CLI reject the entire multi-agent add/remove. A new `skillAgentIdToCliId` translates only at the process boundary (`addArgs`/`installedAddArgs`/`removeArgs`), keeping syncthis' public agent id stable. The `kimi code cli` label is also recognized on read.
- **`skills list` JSON read hardened.** Installed-skill enumeration now streams `npx skills list -g --json` into a `0600` temp file (fd-redirected, `NO_COLOR`/`FORCE_COLOR` forced, 60s timeout) instead of capturing stdout, avoiding color/banner output corrupting the JSON, and deduplicates the per-skill agent list.
- **Antigravity skill targets no longer conflated** with another agent during skill surfacing.

### Changed
- **`add plugin` preview is accurate.** Dry-run now runs the real `installPlugin({ dryRun })` resolver per plugin instead of a hardcoded "would install" line, and `pluginAddHasWork` reflects the actual planned installs / cursor pushes / skills / MCP work.

## [0.14.0] — 2026-06-05

### Changed
- **Interactive multiselect picker restyled to match the native prompts.** The grouped/flat checkbox picker (plugins, skills, agents, MCP servers) hand-rolled its render with ASCII pipes, a stray backtick footer, and no color, so long lists looked broken next to the clack `select()` menus. It now renders with the same treatment as those menus — gray `│` bars, a `└` end-cap, a colored `◆`/`◇` state glyph, `◻`/`◼` checkboxes, and a cyan-highlighted active row — via a new dependency-free `src/tui-style.ts` that re-derives clack's Unicode/ASCII fallback and `NO_COLOR`/non-TTY-aware color (zero added runtime deps). Marketplace group rows now carry a `◈` glyph + bold label over dimmed, indented children, the window height adapts to the terminal, and the row-eating `...` truncation is replaced by dim `↑ N more` / `↓ N more` counters.

### Added
- **Type-to-filter in the multiselect picker.** On lists longer than one page (e.g. the 200+ plugin catalog), just start typing to incrementally filter — matches collapse to the typed substring with a synthetic `select all (N matches)` row, backspace narrows back, and clearing the filter restores the full grouped structure. Selections persist across filter changes. The previous hidden `a`-selects-all shortcut is retired (the key is now free for typing); the visible `select all` row remains the discoverable bulk-select mechanism.

## [0.13.1] — 2026-06-03

### Fixed
- **`syncthis update` now updates the copy on your PATH — fixing the stale version after update.** On a machine with more than one Node prefix (e.g. a Homebrew node on PATH while npm's global prefix points at a version-manager prefix), `npm install -g` installed the new version into a prefix you never run from, so the banner stayed frozen at the old version every release. `update` now derives the global prefix from the *running* binary (`import.meta.url`) and pins npm to it with `--prefix`, so the exact copy you execute is the one refreshed. It then re-reads that copy's `package.json` and reports the real result (`updated X → Y` / `now at Y`) instead of a blind "updated to latest" that could mask a stale install. New pure, tested `src/self-update.ts` (`deriveGlobalPrefix`) handles the unix `lib/node_modules` vs Windows `node_modules` layouts and falls back to npm's default in a dev/source run.

### Changed
- **Plugin-install status lines reflect the network-free local-marketplace path.** The `add plugin` apply note now reads "Codex installs from local marketplace clones (offline); Cursor/skills steps use npx (network)", and the `mirror` provisioning note clarifies that Codex installs from local clones when available, with `npx plugins add` as the fallback — matching the 0.13.0 mechanism instead of overstating npx/network use.

## [0.13.0] — 2026-06-03

### Changed
- **Network-free, idempotent plugin install via the source's local marketplace clone.** Transferring a Claude plugin to Codex (`add plugin`, `mirror`, and the interactive plugin sync) now registers the source's on-disk marketplace clone on the target — `codex plugin marketplace add <clonePath>` (reused when already registered by root or name, never re-added) — then `codex plugin add <name>@<marketplace>`. No `npx plugins` fetch, no network round-trip, and no duplicate marketplace rows in `~/.codex/config.toml`. `npx plugins` provisioning remains a guarded fallback only when no local clone exists. New pure resolver `src/plugins/marketplace.ts` (`parseMarketplaceList`, `readLocalMarketplace`, `resolveLocalMarketplace`); new `PluginInstallOpts.sourceClonePath`; Claude clone paths resolved from `known_marketplaces.json` and threaded through `add.ts` / `mirror.ts`. A URL-named install id or multi-plugin alias whose manifest name differs from the entry name still falls through to the existing coverage/skills-fallback path, so behavior there is unchanged.

### Added
- **Discoverable select-all in the interactive picker.** The multi-select now renders a visible `select all (N)` control row, and — for grouped lists like plugins by marketplace — a per-group `<marketplace> (N)` select-all row, alongside the existing `a` shortcut. Plugins default to those installed on the source agent, grouped by marketplace, with a toggle to show all available marketplace clones (installed-and-not). New tested `src/picker-logic.ts` (`buildRows`, `nextSelectionForRow`, `groupPluginsByMarketplace`) holds the pure selection/grouping logic, decoupled from the terminal.
- **Share installed skills agent → agent.** A new interactive skills flow picks a source agent, its installed skills, and destination agents, then adds each skill to the destinations using the skill's own on-disk store path as the `npx skills add` source — no dir-copy that would corrupt the shared `~/.agents/skills/` symlink store.

## [0.12.4] — 2026-06-02

### Fixed
- **Interactive multi-select prompts now use real checkboxes without flooding large lists.** Plugin, skill, agent, and MCP pickers use a windowed checkbox prompt with Space to toggle, `a` to select all, and Enter to confirm. Large installs stay paged instead of rendering hundreds of rows at once, and empty submits warn/retry without crashing.

## [0.12.3] — 2026-06-02

### Added
- **`syncthis update`.** Updates the global `@hungv47/syncthis` install to latest, using `npm install -g @hungv47/syncthis@latest` by default and Bun's global install when the current executable comes from Bun. Supports `--dry-run`.
- **`syncthis version` / `--version` / `-v`.** Prints the installed package version directly.

### Fixed
- **Version reporting now reads installed package metadata at runtime.** The welcome banner and `version` command read the installed `package.json` instead of bundling a JSON snapshot, preventing stale version output from a generated `dist/syncthis.mjs`.

## [0.12.2] — 2026-06-02

### Fixed
- **Claude plugin reads no longer depend on truncated CLI JSON.** Large Claude plugin installs can make `claude plugin list --json` exit 0 with exactly 65 536 bytes of malformed JSON. The Claude plugin adapter now prefers Claude's durable `~/.claude/plugins/installed_plugins.json` state file, keeping `plugin list`, `add plugin`, `plugin rm`, and `mirror` working on large installs.

### Changed
- **Interactive plugin management now uses one selected sync flow.** The TUI no longer presents a separate "Mirror all" option. **Manage plugins → Sync plugins** asks for source, plugin selection, and destination agents; selecting all covers the old interactive mirror use case. The `syncthis mirror` CLI command remains as a batch/back-compat shortcut.

## [0.12.1] — 2026-06-02

### Fixed
- **Tolerate Claude `plugin list --json` truncation.** On a machine with many plugins, `claude plugin list --json` can hit a ~64 KB stdout cap and return malformed JSON, which previously broke every plugin-aware path (`plugin list`, `mirror`, `plugin rm`, `add plugin`). The Claude plugin adapter now reads `~/.claude/plugins/installed_plugins.json` directly when the CLI is missing, exits non-zero, or returns unparseable/unexpected JSON (with a hint when stdout is exactly 65 536 bytes — the telltale of a buffer cap). `marketplaceSources()` gets the same fallback against `~/.claude/plugins/known_marketplaces.json`, so `mirror`'s `<name>@<marketplace>` resolution and provisioning still work when `claude plugin marketplace list --json` is unreadable too. Same shape, same data — just read from Claude's own state files instead of round-tripping the CLI. New exported `parseClaudeInstalledPlugins` for tests.
- **Skill already-synced guard is now per-agent, not global.** `addSkillsFromPlugins` previously skipped a source repo whenever every skill name was globally present in `npx skills list -g --json` — even if those skills were registered only on *some* agents and the current sync was targeting agents that didn't have them. After a TUI "Add from repo" that picked a subset of agents, a later `syncthis run` (cohort) would falsely report "already synced" and leave the missing agents missing. Now a repo is skipped only when every skill it contributes is already registered on **every requested agent**. `force: true` (interactive Add-from-repo / Sync-from-plugins) still bypasses the guard. Default `run`/`sync` behavior unchanged for the common case where the cohort already has everything.

## [0.12.0] — 2026-06-02

### Added
- **Selective MCP sync — share chosen servers from one agent to others.** New core `runSelectiveMcpSync` (`sync.ts`): pick a source agent, pick specific MCP server names, pick destination agents, and add just those servers — **additive and conflict-safe**. A server name already present on a destination with a different config is left untouched and reported (same conflict policy as union sync, sacred element #3); a name missing from the source is reported as `notFound`. This is *not* an `add mcp` — it never installs a new server or overwrites one, it only spreads servers an agent already has, so MCP stays sync + remove only. Exposed interactively via the MCP manager's **Sync selected** flow (source → servers → destinations → preview → confirm).

### Changed
- **Interactive capability management, simplified.** Running `syncthis` with no args now opens a top-level menu of per-capability managers — **Manage plugins** (sync selected / mirror / list / remove), **Manage skills** (add from repo / sync from plugins / update / remove), **Manage MCPs** (sync everything / sync selected / sync all only / remove / doctor), and **Check problems** — each walking the same source → items → destinations → preview/confirm shape. This replaces 0.11.0's single "Add or remove capabilities" entry. No CLI command behavior changed; the picker is just clearer to navigate.
- **Skill add gained a `force` mode.** `addSkillsFromPlugins({ force })` bypasses the global already-present guard so the interactive "Add from repo" / "Sync from plugins" flows can re-add chosen plugin skills to chosen agents on demand, instead of being silently skipped when the skill name is already globally present. The default (non-force) `run`/`sync` path is unchanged — it still skips already-synced repos so a repeat `run` doesn't re-fetch.

## [0.11.0] — 2026-06-01

### Added
- **`plugin rm` — guarded plugin uninstall.** The only plugin-removal path (sync and mirror stay additive). `syncthis plugin rm <plugin…>` uninstalls each named plugin's native install from the scoped plugin-capable agents (`claude plugin uninstall`, `codex plugin remove`) **and** removes that plugin's surfaced skills from the scoped non-plugin agents (`npx skills remove`) — the "everywhere" reach matching how `mirror` spreads a plugin's content. Guarded like MCP `rm`: explicit scope (`--all` or `--agents <a,b,c>`), a diff before any write, TTY-confirm or `--yes`, and `--dry-run`. Each argument is `name` or `name@marketplace` — a bare name removes every installed instance (a name from two marketplaces is never collapsed to an arbitrary one); `@marketplace` scopes to one. Skill removal also reaches **Codex** when the mirror surfaced a plugin's skills there via the fallback. Over-removal guard: a skill another still-installed plugin record (incl. a sibling marketplace) provides is **kept**. `--keep-data` preserves Claude's plugin data dir. The interactive picker gains a matching checkbox flow (pick plugins → pick agents → confirm).
- **`plugin list` is now a cross-agent overview.** Previously it read only Claude and Codex. Now it also reports Cursor as a write-only target (not readable) and, from one `npx skills list -g --json`, the plugin-derived skills present on each non-plugin agent — the true "what plugin content do I have, everywhere" picture.
- **Selective add/remove — pick the exact items and agents.** A verb-noun grammar over the existing primitives: `add skill <repo…>` / `add plugin <name…>` (additive; `--dry-run`) and `rm skill <name…>` / `rm mcp <server…>` / `rm plugin <name…>` (guarded: explicit `--all` xor `--agents <a,b,c>`, diff, confirm/`--yes`, `--dry-run`). `rm <server> --all` still works (back-compat). **No `add mcp`** — syncthis mirrors MCP servers, it doesn't install them, so MCP stays sync + remove only. `add plugin` is a narrowed `mirror`: it pushes the chosen plugin from Claude (the source) to the chosen agents — native install on Codex, Cursor push, and bundled skills + MCP to chosen non-plugin agents. The TUI gains an **"Add or remove capabilities"** flow (capability → operation → item checkbox → agent checkbox → confirm). `rm mcp` can now scope to specific agents (`--agents`), not just every agent.

### Changed
- **`PluginAdapter` gained `uninstallPlugin`** (Claude, Codex). `skills.ts` gained `removeSkillNames`, `listInstalledSkills`, and `resolvePluginDerivedSkills`. Removal is now a documented, rail-guarded capability (sacred element #1 updated) — it was previously forbidden for plugins.

## [0.10.0] — 2026-06-01

### Added
- **`mirror` now decomposes a plugin's bundled MCP servers, not just its skills.** A Claude plugin can bundle MCP servers (a root `.mcp.json` or a manifest `mcpServers` field). Previously `mirror` surfaced only the bundled *skills* to the non-plugin agents and silently dropped those servers. Now it lifts them into each non-plugin agent's own MCP config too — `${CLAUDE_PLUGIN_ROOT}` resolved to the plugin's install dir, servers that still need a Claude-only variable skipped rather than written broken. Additive and conflict-safe: a server name already present with a different config is left untouched and reported (same policy as union sync). Claude primary only. So one `syncthis mirror claude-code` now makes a plugin's full portable content (skills **and** MCP) reachable everywhere, not just on the plugin-capable agents.
- **Goose support — the 12th MCP-sync agent.** New adapter for `~/.config/goose/config.yaml` (YAML `extensions`). Maps canonical MCP to Goose's field names (`cmd`/`args`/`envs`/`uri`), type-tags stdio/streamable_http/sse, and preserves Goose's built-in extensions (`developer`, `memory`, …) untouched. Goose gets union MCP sync, plugin→MCP decomposition, and skills automatically. Honors `XDG_CONFIG_HOME` exactly as Goose does.
- **Pi as a skills-only target.** Pi (badlogic/pi-mono) ships without native MCP by design, so it has no MCP adapter — but it now receives skills via the cohort (`npx skills add -a pi`).

### Changed
- **Skill cohort and MCP cohort are now distinct.** `mcpCohort()` = the non-plugin agents that have a native MCP adapter (targets for plugin→MCP decomposition); `skillCohort()` = that set plus skills-only agents like Pi. Skills reach more agents than native MCP sync does, and the two no longer have to be the same list.

## [0.9.4] — 2026-05-31

### Fixed
- **Plugin mirror now fails fast when the primary can't be read.** Direct `runMirror()` callers now get an error instead of a report that could look like an empty primary with nothing to mirror. CLI and TUI callers use the same core guard, so the behavior is consistent across entrypoints.

### Changed
- **Plugin-bundled skill discovery is faster on large plugin sets.** Local marketplace filesystem probes now run in parallel, and the already-synced guard overlaps its installed-skill probe with repo SKILL.md scans. `npx skills add` still runs sequentially to avoid races in shared skill directories.

## [0.9.3] — 2026-05-30

### Changed
- **Refreshed the welcome banner.** The subtitle now reads "MCP servers, skills & plugins" (plugins were missing). Command descriptions are tightened so every row fits on one line — previously the `mirror` row wrapped and garbled (`$syncthis mirror` / `<primary>`) on narrow terminals because its description overflowed the command column. `mcp` and `skills` are now separate rows (they're distinct commands), and `mirror` is surfaced second as a headline command. No command behavior changed — banner copy only.

## [0.9.2] — 2026-05-30

### Fixed
- **`mirror` apply no longer looks frozen.** A full mirror runs many sequential `npx`/`codex` network calls (codex installs + cursor pushes + skill adds) — for a large plugin set that's 100+ ops over several minutes, and the apply printed nothing until it finished, so it looked hung. `runMirror` now takes an `onProgress` callback: the TUI shows a live spinner (`codex: <plugin> (12/28)`, `cursor: <repo> (5/41)`, `skills: <repo> (3/33)`) and the CLI streams per-item progress lines. Added an up-front "this hits the network, can take a few minutes" note. No behavior change — additive and idempotent as before, so it's always safe to interrupt and re-run.

## [0.9.1] — 2026-05-30

### Fixed
- **Welcome banner no longer errors with "Font file for the font 'block' could not be found."** The banner used `ink-big-text`, whose `cfonts` engine loads its font via a runtime `require("../fonts/block.json")` — a path the single-file `bun build` bundle can't resolve, so every node-bundled install (0.7.0–0.9.0) printed the cfonts error instead of the wordmark. The "syncthis" wordmark is now a static, pre-rendered string in `welcome.tsx` (gradient preserved), with no runtime font dependency. Dropped `ink-big-text`/`cfonts` from the bundle. Also refreshed the banner's stale `mirror` command description.

## [0.9.0] — 2026-05-29

`mirror` now propagates a primary's plugin content to **every** other agent, can't fail on multi-plugin marketplaces, and can never uninstall.

### Added
- **`mirror` reaches the 8 non-plugin agents too.** After installing plugins on Codex and pushing to Cursor, a Claude-primary mirror now adds the primary's plugin-bundled skills to the non-plugin agents (gemini, kimi, opencode, …) via `npx skills add` — the same surface `run` uses, now driven by `mirror`. One command makes a plugin's content reachable everywhere: native plugin where loadable, skills everywhere else. The preview and summary show all three target groups (codex, cursor, skills→agents) — previously the TUI showed only Codex.

### Fixed
- **Multi-plugin marketplaces no longer fail the mirror.** Marketplaces like `browserbase`, `expo`, and `anthropics/skills` alias one bundle under several plugin names whose `plugin.json` name differs from the entry name. Claude tolerates this; Codex hard-rejects it (`plugin.json name X does not match marketplace plugin name Y`). The mirror was reporting these as hard failures. Now the canonical plugin installs, and each alias is recognized as **covered by the same bundle** (no error, no duplicate skills add).
- **`github.com-*` plugins now reach Codex.** A plugin Claude named from a URL install (`github.com-garrytan-gstack`) never matched the repo's real plugin name (`gstack`). Provisioning installs it under the real name; the mirror detects the bundle landed (install-set diff) and marks it covered, falling back to skills only for genuinely skills-only repos — so no flat-vs-namespaced skill duplication on Codex.
- **No skill duplication on re-runs / alias-only primaries.** The alias name-mismatch path now recognizes its canonical plugin being present (already installed from a prior run, or installed by this run's provision) and marks the alias `covered` instead of re-adding the bundle's skills flat. The mirror also seeds its covered-repo set from plugins already on the target. Without this, a second `mirror` (canonical already installed, only the unloadable alias left to sync) re-added the bundle's namespaced skills as flat skills every run.
- **Plugin-list reads no longer time out silently.** `claude`/`codex plugin list` reads were on the 15s default timeout; a cold CLI start could exceed it, yielding an empty primary that looked like "nothing to mirror". Reads now get 60s, installs 180s, and a failed primary read aborts loudly instead of silently no-op'ing.

### Changed
- **Provisioning is on by default** (was `--provision`). Mirror registers missing marketplaces and falls unloadable bundles back to skills automatically — pass `--no-provision` for an offline/local run. The TUI no longer asks about it.
- **`mirror` is additive only — `--remove-stale` is removed.** There is no longer any plugin-uninstall path anywhere in syncthis (the `removePlugin` adapter method and the destructive mirror prompt are gone), so a mirror can never wipe an agent's plugins.
- TUI simplified: clearer one-line brief, shorter labels, and the mirror flow drops the remove-stale and provision questions.

## [0.8.0] — 2026-05-29

Close the Codex coverage gap for skills-only plugin bundles.

### Added
- **`mirror <primary> --provision` now falls back to skills on Codex.** A plugin that's a skills-only bundle (or a multi-plugin-repo snapshot defect) can't load as a Codex *plugin*, so previously it reached Codex through no path at all — `run`'s skills pass deliberately excludes the plugin cohort. Under `--provision`, after the native install is skipped, the mirror now adds the bundle's skills to Codex via `npx skills add <repo> -a codex`, shown as a fallback row. Safe from duplication: it only fires for bundles Codex couldn't load as a plugin, so there's nothing to collide with. No new command or flag — it rides on the existing `--provision`.

### Changed
- The post-mirror skip tip now points at `--provision` (which can bring skills-only bundles to Codex as skills) instead of `syncthis run` (whose skills pass never targets Codex). The provisioned-but-unloadable skip message reflects the skills fallback.

## [0.7.0] — 2026-05-29

Pre-launch hardening: runs on Node without Bun, idempotent for every transport, crash-safe writes.

### Fixed
- **SSE/streamable-http servers now converge.** Agents that can't store a transport subtype (Hermes, Windsurf, Copilot, OpenCode) read a URL server back as `http`, so a second `sync` saw `sse`-vs-`http` for the same name and raised a permanent conflict the user could never resolve. Transport subtype is now excluded from the conflict identity (the URL is the identity), so sync stays at zero conflicts across repeated runs while transport-capable agents keep their original `type`.
- **Config writes are atomic.** Writes go to a sibling temp file clamped to `0600` and are `rename`d over the target, so a crash / `ENOSPC` mid-write can no longer truncate an agent's config into an empty `{}`. This also fixes a permission bug where a pre-existing `0400` file became unwritable and bricked the next sync.
- `readLine()` no longer hangs forever on EOF-without-newline (Ctrl-D / closed pipe) at a destructive confirmation prompt — EOF now aborts safely.
- A malformed `~/.claude/plugins/known_marketplaces.json` no longer crashes the whole `sync`; the skills pass treats it as "no sources" and continues.
- Windsurf adapter preserves unknown per-server fields on rewrite (matching the other adapters' previous-merge), so a re-sync no longer drops Windsurf-specific keys.
- A bad CLI flag now exits `2` (usage error) instead of `1`, matching every other usage-error path.

### Changed
- **Runs on Node ≥18 — no Bun required.** The CLI is bundled with `bun build --target=node` into a single self-contained `dist/syncthis.mjs` (Node shebang). `npx @hungv47/syncthis run` now works for Node-only users; the prior `.mjs` shim that hard-spawned `bun` (exit 127 without it) is gone. Bun is still the dev runtime.
- Subprocess and file I/O moved from `Bun.*` APIs to `node:child_process` / `node:fs` so the bundle is portable.
- Timed-out shell-outs report `timed out after Ns` instead of a confusing negative/`-15` exit; the Codex `--provision` re-read failure is now reported as a failure with its cause, not a benign skip.

### Removed
- Dropped `react-devtools-core` (a 15 MB dependency that was never imported at runtime) and moved all runtime deps to `devDependencies` — they're bundled in. The published tarball is now 4 files (~470 KB) and installs zero transitive deps.

## [0.6.0] — 2026-05-28

Make the Claude → Codex plugin mirror actually install everything it can, and be honest about what it can't.

### Added
- `syncthis mirror <primary> --provision` (opt-in) — when Codex has no registered marketplace for one of the primary's plugins, syncthis registers the plugin's source repo for you (`npx plugins add <owner/repo> --target codex`, repo resolved from the primary's marketplace list) and then installs it natively. Turns "not available in Codex" plugins into installed ones in a single command. Off by default so plain `mirror` stays fast and local; also offered as a prompt in the interactive picker.
- After a mirror with skips, a one-line hint that skipped **skills-only bundles** sync via `syncthis run` (`npx skills`), not the plugin mirror — so nothing looks lost.

### Changed
- Plugins the target genuinely can't install are now reported as **skipped** with a reason, not **failed**. Only a real install error counts as a failure (non-zero exit). Three distinct skip reasons: provisioned-but-unresolvable (a skills-only bundle, or an upstream multi-plugin-repo snapshot defect), no-usable-source-repo, and no-`--provision`. Summary reads `N installed · M skipped · K failed`.

### Security
- `--provision` validates the `owner/repo` slug before shelling out: rejects leading dashes (CLI option injection), `..` traversal, URLs, and shell metacharacters; subprocess args are passed array-style (no shell). `marketplaceSources()` tolerates malformed CLI JSON instead of aborting the run.

## [0.5.2] — 2026-05-28

### Changed
- `syncthis mirror` reports a plugin the target can't resolve as **skipped** (with a reason) instead of **failed** — a run no longer looks broken when a plugin's marketplace simply isn't available on the target. Only genuine install errors exit non-zero.

## [0.5.1] — 2026-05-28

Codex plugin sync now reflects reality.

### Fixed
- The Codex adapter read install state from `~/.codex/config.toml`, which records plugins merely *registered* out-of-band — so syncthis over-reported Codex (≈50 "installed" vs ~4 actually loaded) and `mirror` skipped plugins as already-present that Codex couldn't use. It now reads true install state from `codex plugin list`, so both `plugin list` and `mirror` reflect what Codex actually has.
- `codex plugin add` rejects a bare plugin name. `mirror` now resolves the target's own `<name>@<marketplace>` from Codex's snapshot (preferring `plugins-cli` when a name is ambiguous), so installs land instead of erroring.

## [0.5.0] — 2026-05-28

Minimal-tool refactor. syncthis now does exactly three things: cross-agent **MCP union sync** (its unique value — nothing upstream does it), **plugin mirror** between the two agents with a native install CLI (Claude ↔ Codex), and **skills** delegated to `npx skills update -y`.

### Removed
- `syncthis status` and the plugin lifecycle/observability layer (`discovery.ts`, `status.ts`). It was built to surface "installed-but-not-surfaced" silent failures, but 0.4.0 already established those failure modes were fictional (Codex's loader recurses + follows symlinks). With nothing left to surface, `status` only re-printed `plugin list` — so it's gone.
- `syncthis plugin rm`, `syncthis plugin doctor`, and all `syncthis marketplace` commands, plus `--purge`. Uninstalling is each agent's own concern (`claude plugin uninstall`, `codex plugin remove`); it isn't a sync responsibility.
- Cursor and OpenCode dropped from the plugin cohort. Cursor has no install CLI and OpenCode plugins are npm modules — neither can be a mirror target, so they only produced "cannot be pushed" / "kind mismatch" noise.

### Changed
- `syncthis mirror` now targets only Claude ↔ Codex and reports a clean diff (no unmirrorable-target noise).
- `syncthis plugin list` remains as the single read-only plugin command.
- Net ~1,000 lines deleted across `src/` and `tests/`.

## [0.4.0] — 2026-05-28

Plugin observability and mirror across Claude Code, Codex, Cursor, and OpenCode.

### Added
- `syncthis status [--detailed] [--json]` — plugin × agent × stage matrix (registered / loaded / surfaced) with a reason for each genuine silent failure (missing cache dir, disabled, missing manifest). `--detailed` exposes the per-agent source tag; `--json` is machine-readable. The Codex lifecycle is modeled on Codex's real loader (`codex-rs/core-skills/src/loader.rs`): read `.codex-plugin/plugin.json`, take its `skills` field as a root, recursively scan (depth ≤ 6, following symlinks) for `SKILL.md`.
- `syncthis mirror <primary> [--remove-stale] [--yes] [--dry-run]` — destructive primary→all plugin sync. Refuses `kind` mismatches (bundle ↛ npm), skips agents with no native install path (Cursor) without overpromising in the preview, and guards `--remove-stale` against a primary that read-errored or reports zero plugins.

### Changed
- Welcome screen reads its version from `package.json` (was hard-coded).
- Interactive TUI picker now offers status / mirror / plugin list / plugin doctor / fan-out, each printing a useful summary.

### Note
- An earlier in-development build of this release shipped a plugin "auto-repair" (`syncthis fix`, default-on) targeting Codex "nested skills won't surface" and "missing interface block" failure modes. Reading Codex's actual loader showed both modes are fictional — Codex recurses into the skills root and follows symlinks — so the fixers and default-on repair were removed before release rather than ship false-positive repairs.

## [0.3.0] — 2026

- Plugin + marketplace sync, inspection, and removal across Claude Code, Codex, Cursor, and OpenCode.
- README/package description lead with `npx`.

## [0.2.0] — 2025

- 11-agent MCP sync, MCP-only focus, interactive TUI.
- `0.2.1`: extracted shared canonical-JSON adapter factories.

## [0.1.2] — 2025

- Secret-bearing files clamped to `0600` on write; refreshed `.syncthis.bak` backups.
