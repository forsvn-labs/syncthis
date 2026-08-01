# CLAUDE.md

Guidance for Claude Code working in this repo. Mirrored to `AGENTS.md` for Codex / other agents.

## What this is

`syncthis` is a CLI that mirrors **MCP server configs** across 12 AI coding agents:
**Claude Code, Cursor, Codex, Gemini CLI, Kimi CLI, OpenCode, OpenClaw, Hermes, Windsurf, Antigravity, GitHub Copilot CLI, Goose**. Skills additionally reach **Pi** (badlogic/pi-mono), which ships without native MCP by design, so it has no MCP adapter — it's a skills-only target.

It is a sync layer, not an installer — it reads each agent's existing config, computes the union, writes the union back, and reports conflicts.

It does exactly three things, deliberately kept minimal:
- **MCP servers** — cross-agent union sync (the unique core; no upstream tool does this).
- **Plugins** — `mirror` makes one agent's plugin content reachable on **every** other agent, additively. Native activation is readable on **Claude Code, Codex, and GitHub Copilot CLI**; Cursor is a **write-only** `npx plugins` target. Kimi has no proven non-interactive native ABI and receives exact skills/MCP degradation. The other non-plugin MCP agents receive plugins' bundled *skills* via `npx skills add` and bundled *MCP servers* through their normal config adapters (additive, conflict-safe — `src/plugins/mcp.ts`). Pi is skills-only, so it receives skills but no MCP lift. The mirror is **additive only** — it never uninstalls. Two read/remove companions sit alongside it: `plugin list` and guarded `plugin rm`.
- **Skills** — delegated to [`vercel-labs/skills`](https://github.com/vercel-labs/skills) (`npx skills`, 55 agents). Two parts: `npx skills update -y` (refresh), and `skills from-plugins` — surface the skills *bundled inside* Claude plugins (which live in `~/.claude/plugins/marketplaces/*/skills`, not the skills dir) to the non-plugin skill cohort via `npx skills add <repo>`. Plugin agents are intentionally excluded: they already have those skills as proper namespaced plugins, so re-adding them flat would duplicate and collide.

History: a v0.4 plugin observability layer (`status`) plus a `plugin rm` / `marketplace rm` removal subsystem were removed in 0.5 — the observability premise (Codex silently drops nested-skill plugins) was fictional, and uninstalling was deemed each agent's concern. `plugin rm` was later reinstated by explicit request, but as a **plugin-aware, guarded** uninstall: it removes a plugin's native install from Claude/Codex **and** its surfaced skills from the non-plugin agents (`npx skills remove`), behind the same rails as MCP `rm` (explicit scope, diff, confirm/`--yes`, `--dry-run`). The `status` observability layer and `marketplace rm` stay out — don't reintroduce them without a concrete, verified need.

Distribution: npm package `@hungv47/syncthis`.

## Stack

- **Runtime:** Bun for development (`bun bin/syncthis.ts`); the published artifact runs on **Node ≥18**. Source uses only `node:*` builtins (`node:fs/promises`, `node:child_process`) — no `Bun.*` APIs — so it bundles cleanly for Node. engines: `{ node: ">=18", bun: ">=1.0.0" }`.
- **Language:** TypeScript 5, `module: ESNext`. No bundler in dev; `bun build --target=node` for distribution only.
- **Bundled deps (compiled in, shipped as devDependencies):** `smol-toml` (Codex TOML), `js-yaml` (Hermes YAML), `json5` (OpenClaw JSON5), `@clack/prompts` (TUI), `ink`/`react`/`ink-gradient` (welcome banner). They're inlined into the bundle, so `npx` installs **zero** transitive deps. The banner wordmark is a **static string** in `welcome.tsx` (not `ink-big-text`/`cfonts`): cfonts loads its font via a runtime `require("../fonts/block.json")` that the single-file bundle can't resolve, so it must not be a runtime dependency.
- **Tests:** `bun:test`. Run with `bun test`.
- **Bin entry / build:** `bin/syncthis.ts` is the dev entry (run by Bun). `scripts/build.ts` (`bun run build`) bundles it to `dist/syncthis.mjs` via `bun build --target=node`, rewrites the shebang to `#!/usr/bin/env node`, and that self-contained file is the published `bin`. So `npx @hungv47/syncthis` works for any Node user without Bun. Don't point `bin` at the raw `.ts` (npm rejects it) or reintroduce a Bun-spawning shim (the whole reason to bundle was to drop the Bun runtime requirement).

## Layout

```
src/
  adapters/
    claude.ts         → ~/.claude.json (merges top-level + every projects.*.mcpServers scope)
    cursor.ts         → ~/.cursor/mcp.json (canonical factory)
    codex.ts          → ~/.codex/config.toml (TOML)
    gemini.ts         → ~/.gemini/settings.json (canonical factory)
    kimi.ts           → ~/.kimi/mcp.json (canonical factory)
    antigravity.ts    → ~/.gemini/antigravity/mcp_config.json (canonical factory)
    copilot.ts        → ~/.copilot/mcp-config.json (type-tagged: local | http)
    windsurf.ts       → ~/.codeium/windsurf/mcp_config.json (canonical-ish; serverUrl rename)
    opencode.ts       → ~/.config/opencode/opencode.json (most divergent: `mcp` key, command-as-array, `environment`)
    openclaw.ts       → ~/.openclaw/openclaw.json (JSON5; nested `mcp.servers`; transport field)
    hermes.ts         → ~/.hermes/config.yaml (YAML; mcp_servers snake_case)
    goose.ts          → ~/.config/goose/config.yaml (YAML; `extensions` map keyed by name, type-tagged stdio/streamable_http/sse; cmd/args/envs/uri field names; preserves built-in extensions)
    json-mcp.ts       → shared canonical JSON adapter factory (Cursor, Gemini, Kimi, Antigravity)
    text-mcp.ts       → shared text-format adapter factory
    index.ts          → MCP adapter registry (all 12)
  plugins/            → plugin layer (Claude/Codex/Copilot native; Cursor write-only)
    claude.ts         → read (claude plugin list --json) + installPlugin (additive) + uninstallPlugin (claude plugin uninstall)
    codex.ts          → read (codex plugin list, installed-only) + installPlugin (resolves bare name → name@marketplace; provisions; detects covered/name-mismatch → skills fallback) + uninstallPlugin (codex plugin remove)
    copilot.ts        → read/install/uninstall through `copilot plugin`; supports exact local plugin paths and fresh list verification
    mcp.ts            → plugin → MCP decomposition: read a plugin's bundled .mcp.json / manifest mcpServers, resolve ${CLAUDE_PLUGIN_ROOT} → install dir, skip servers needing a Claude-only var. Pure resolver (no writes).
    mirror.ts         → primary → every other agent: codex native installs (provision on by default) + cursor push (npx plugins) + skills fallback for bundles a target can't load + skills→skill cohort (npx skills) + bundled-MCP→non-plugin MCP cohort (lifted into their MCP config, additive + conflict-safe). Additive only — no removes.
    overview.ts       → unified cross-agent plugin overview: readable native plugins + cursor write-only note + per-agent derived skills. Read-only.
    uninstall.ts      → guarded native uninstall on readable targets + surfaced-skill removal across scoped loose targets.
    add.ts            → scoped plugin add: native install on Codex/Copilot, Cursor push, exact skills + lifted MCP elsewhere.
    shell.ts          → run() subprocess helper, parsePluginId, isSafeIdentifier, isSafeSkillName, isSafeRepoSlug
    types.ts          → PluginAdapter interface (installPlugin + uninstallPlugin) + records
    index.ts          → verified plugin adapter registry ([claude, codex, copilot]) + listPlugins()
  skills.ts           → surface plugin-bundled skills to the non-plugin agents via `npx skills add`. Two cohorts: `mcpCohort()` = MCP adapters − plugin cohort (targets for plugin→MCP decomposition); `skillCohort()` = mcpCohort + SKILL_ONLY_AGENTS (skills-capable agents with no MCP adapter, e.g. Pi). `addSkillRepos` adds specific repos to specific agents (used by mirror's skills fallback + non-plugin cohort push); `removeSkillNames` removes named skills (used by `plugin rm`); `listInstalledSkills`/`resolvePluginDerivedSkills` feed the overview
  sync.ts             → core: read all → compute union → write back, plus runDirectional / runFanOut / runRemove
  doctor.ts           → MCP coverage + conflict report
  tui.ts              → interactive picker (@clack/prompts)
  welcome.tsx         → first-run ink banner
  io.ts               → readJson/writeJson/readText/writeText, atomic temp+rename, 0600 perms, .syncthis.bak
  types.ts            → shared MCP types (AgentId union)
bin/
  syncthis.ts         → CLI entrypoint (dev: run by bun; bundled to dist/ for release)
scripts/
  build.ts            → bun build --target=node → dist/syncthis.mjs (node shebang, self-contained)
tests/                → sync, adapters, mirror, plugin-adapters, plugin-install, plugin-uninstall, plugin-overview, io, skills
.deepsec/             → self-contained deepsec scanner config (its own package.json + lockfile)
```

## Commands

The CLI is **noun-first**: three nouns (`plugins`, `skills`, `mcp`) each with scoped verbs, plus a flagship `sync`. This is the canonical, advertised surface (`syncthis help` and `syncthis <noun> help`). Every pre-0.15 command still works as an **unadvertised alias** routing to the same handler (see "Legacy aliases" below) — the move was additive, non-breaking.

```
syncthis                                 # interactive picker (or help if non-TTY)
syncthis sync   [--dry-run] [--no-skills]    # flagship: MCP union + skills (alias: run)

syncthis plugins list                        # read-only cross-agent plugin overview
syncthis plugins mirror <primary> [--no-provision] [--yes] [--dry-run]  # → every agent (additive)
syncthis plugins add <name…> --all | --agents <a,b,c> [--dry-run]   # source = claude-code
syncthis plugins rm  <name…> --all | --agents <a,b,c> [--yes] [--dry-run] [--keep-data]
                                             # guarded uninstall: native plugin (claude/codex) + surfaced skills

syncthis skills update                       # `npx skills update -y`
syncthis skills add <repo…> --all | --agents <a,b,c> [--dry-run]
syncthis skills from-plugins [--dry-run]     # surface Claude-plugin-bundled skills to non-plugin agents
syncthis skills rm  <name…> --all | --agents <a,b,c> [--yes] [--dry-run]

syncthis mcp sync [--dry-run]                # MCP-only union sync (skips skills)
syncthis mcp <from> <to> [--yes] [--dry-run] # one-way MCP mirror A → B
syncthis mcp from <agent> --all [--yes] [--dry-run]   # fan one agent out to all others
syncthis mcp rm <server…> --all | --agents <a,b,c> [--yes] [--dry-run]
syncthis mcp doctor                          # MCP coverage + conflicts (alias: doctor)
# no `mcp add` — syncthis mirrors MCP servers, it doesn't install them

syncthis doctor                              # MCP coverage + conflicts
syncthis update [--dry-run]                  # update syncthis itself
syncthis help                                # noun-first overview
```

**Bare-noun behavior (KTD-3):** to stay non-breaking, bare `syncthis mcp` and bare `syncthis skills` keep their legacy side effects (union sync / `npx skills update`), while help advertises the explicit `mcp sync` / `skills update`. Bare `syncthis plugins` has no destructive legacy behavior, so it prints the plugins group help.

**Legacy aliases (still work, not advertised):** `run` (=`sync`), `mcp`/`mcp --dry-run` (=`mcp sync`), `doctor` (=`mcp doctor`), `mirror <primary>` (=`plugins mirror`), `from <agent> --all` (=`mcp from`), `<from> <to>` (=`mcp <from> <to>`), `add skill|plugin` (=`skills add` / `plugins add`), `rm mcp|skill|plugin` and bare `rm <server> --all` (=`mcp rm` etc.), `plugin list`/`plugin rm` (=`plugins list`/`plugins rm`; bare `plugin` still lists). Routing + alias equivalence is pinned by `tests/cli-routing.test.ts`. The noun routers (`cmdPlugins`/`cmdMcpGroup`/`cmdSkills`) in `bin/syncthis.ts` delegate to the same handler functions the aliases use — no behavior is duplicated.

`run`/`sync` does, in order: read all 12 agent configs (for Claude, merging top-level + every per-project scope) → compute union (any server present in any agent propagates to every agent) → detect conflicts → write back where safe → (unless `--no-skills`) surface plugin-bundled skills to the non-plugin agents (the skill cohort, which also includes skills-only agents like Pi) via `npx skills add`, then run `npx skills update -y`. The skills passes are additive only. Plugin/cursor propagation is **not** part of `run` — it stays explicit in `mirror`.

`<from> <to>` is a destructive one-way MCP mirror: overwrites `to`'s servers with `from`'s. Shows a diff and prompts for confirmation; `--yes` skips the prompt.

`mirror <primary>` makes the primary's plugin *content* reachable on **every** other agent, by the best mechanism each has, **additively** (it never uninstalls):

- **Codex** (native read+write CLI): installs each plugin by bare name, resolving the target's own `<name>@<marketplace>`. Missing marketplaces are **provisioned by default** — `npx plugins add <owner/repo> --target codex` (repo from the primary's `marketplace list`), which also installs the repo's canonical plugin. A plugin Codex can't load as a *plugin* — a skills-only bundle, or a multi-plugin marketplace **alias** whose `plugin.json` name differs from the entry name (browserbase's `browse`/`functions`/…, expo's `expo`/`expo-app-design`/…) — falls back to `npx skills add <repo> -a codex`, **unless** the same repo already landed as a real plugin on Codex (then it's marked `covered`, no skills add, so a plugin's namespaced skills aren't duplicated flat). `--no-provision` turns off registration + fallback (install only what the target can already resolve).
- **Cursor** (write-only, no list CLI): pushed by source repo via `npx plugins add <repo> --target cursor` — additive, unconditional, only from a **Claude primary** (only Claude exposes the marketplace→repo map).
- **The non-plugin agents** (gemini, kimi, opencode, …): receive the primary's plugin-bundled skills via `npx skills add` (same surface as `run`'s skills pass; already-synced repos skipped), **and** the primary's plugin-bundled MCP servers, decomposed and lifted into each MCP-capable agent's own config via the normal adapters. The plugin cohort already gets those servers by installing the plugin, and Pi has no MCP config. Additive + conflict-safe: a server name already present with a different config is left untouched and reported (same conflict policy as union sync); `${CLAUDE_PLUGIN_ROOT}` is resolved to the plugin's install dir, and a server still needing a Claude-only var (`${CLAUDE_PLUGIN_DATA}`, …) is skipped rather than written broken. Claude primary only. Caveat: a lifted server points at Claude's plugin cache dir, so it breaks if that plugin is later uninstalled from Claude (the cache is pruned ~7 days after).

Diff + confirm or `--yes`. A failed primary read aborts loudly (an empty primary would otherwise look like "nothing to mirror"). Plugin-list reads use a 60s timeout (cold CLI starts can exceed the 15s default) and installs 180s.

`doctor` prints per-server coverage across agents and any conflicts. Exits non-zero if conflicts present.

`plugin list` is a read-only cross-agent overview: native plugins per plugin-capable agent (Claude, Codex), a Cursor write-only note (its plugin state isn't readable), and — built from one `npx skills list -g --json` ∩ the skill names Claude's installed plugins contribute — the plugin-derived skills present on each non-plugin agent.

`plugin rm <plugin…>` is the **only** plugin-removal path and is reached only here (never by sync or mirror). It uninstalls each named plugin's native install from the scoped plugin-capable agents (`claude plugin uninstall`, `codex plugin remove`) **and** removes that plugin's surfaced skills from the scoped non-plugin agents (`npx skills remove`). Each argument is `name` or `name@marketplace`: a bare name targets **every** installed instance of that name (a name installed from two marketplaces is never collapsed to an arbitrary one), and `name@marketplace` scopes to a single instance. Skill removal also covers **Codex** when the mirror surfaced a plugin's skills there via the `npx skills add` fallback (Codex couldn't load it natively) — a Codex-*native* plugin's skills are namespaced inside the plugin and aren't in the npx store, so they're left to the native uninstall, not double-removed. Scope is explicit (`--all` or `--agents <a,b,c>`); it prints a diff, confirms in TTY or needs `--yes`, and supports `--dry-run`. Over-removal guard: a skill name another still-installed plugin record also provides (including a sibling marketplace not being removed) is **kept** (syncthis can't see hand-added non-plugin skills sharing a name, so the diff lists exact names). `--keep-data` preserves Claude's plugin data dir. Cursor can't be uninstalled (write-only) and is reported as such.

The **selective add/remove grammar** (`add`/`rm <skill|plugin|mcp>`) is a thin selection layer over existing primitives: `add skill`→`addSkillRepos`, `add plugin`→`runPluginAdd`, `rm skill`→`removeSkillNames`, `rm mcp`→`runRemove` (with an agent subset), `rm plugin`→`runPluginUninstall`. `add` is additive (no confirm; `--dry-run`); every `rm` keeps the removal rails (explicit scope, diff, confirm/`--yes`, `--dry-run`). There is **no `add mcp`** — syncthis mirrors MCP servers, it does not install them, so MCP is sync + remove only. A bare `add <source>` with no explicit noun **auto-detects** the type (`src/plugins/detect.ts`): `owner/repo` → skill, a bare name claude-code has installed → plugin (propagated by name), any other bare name → mcp (refused, same as `add mcp`). `--as skill|plugin|mcp` overrides detection; mixed-type sources in one `add` are refused. The same flows are exposed interactively: running `syncthis` with no args opens per-capability managers — **Manage plugins** (sync selected / mirror / list / remove), **Manage skills** (add from repo / sync from plugins / update / remove), **Manage MCPs** (sync everything / sync selected / sync all only / remove / doctor), and **Check problems** — each walking source → items → destinations → preview → confirm. The MCP manager's **Sync selected** is an interactive, additive, conflict-safe share of chosen servers from one agent to others (`runSelectiveMcpSync` in `sync.ts`): it spreads existing servers and leaves a conflicting name untouched, never installing or overwriting — so it stays consistent with "no `add mcp`". The skills "Add from repo" / "Sync from plugins" flows can force a re-add past the global already-present guard (`addSkillsFromPlugins({ force })`).

## Sacred elements — do not change without explicit approval

1. **Removal is allowed only with explicit rails.** Union `sync` and the plugin `mirror` never delete — they are purely additive (a mirror has no `removePlugin`/`--remove-stale`, so it can never wipe an agent's plugins). The explicit removal commands — MCP (`syncthis rm <server>` / `rm mcp <server…>`), plugin (`syncthis plugin rm` / `rm plugin`), and skill (`rm skill`) — must each require (a) an explicit scope (`--all` or `--agents <list>`), (b) a diff printed before any write, (c) interactive confirmation in TTY or `--yes` in non-interactive mode, and (d) `--dry-run` to preview. `--all` and `--agents` are mutually exclusive (both → error, never a silent winner). `plugin rm` additionally keeps a skill another installed plugin still provides (no collateral skill removal). There is no *implicit* deletion anywhere in the tool — removal only ever happens through these guarded commands.
2. **`.syncthis.bak` backup on first write.** Every target file gets a backup the first time syncthis writes to it. Tests assert this. Don't change the contract or the suffix.
3. **Conflict policy (union sync): leave each agent's own copy untouched.** If the same server name has different configs in different agents (different env, command, args), `run`/`sync` does NOT pick a winner — it leaves each agent's existing version alone and reports the conflict. The user resolves by deleting the version they don't want and re-running sync.
4. **Secret-bearing files clamped to `0600`.** Any agent file written by syncthis that may contain API keys/tokens has its permissions clamped on write. Don't relax this. Applies to all 12 adapters.
5. **Directional sync requires explicit confirmation.** `<from> <to>` is destructive (overwrites `to`). It must show a diff and prompt OR require `--yes` in non-interactive contexts. Never silently overwrite.
6. **Claude per-project scope merge on read, top-level on write.** Claude stores MCP servers in two places: top-level `mcpServers` (user scope) and `projects.<path>.mcpServers` (per-project scope, the default for `claude mcp add`). The adapter reads both and merges; writes go to top-level only, leaving project scopes untouched so Claude's per-project behavior is preserved.

## Distribution

- **npm:** `@hungv47/syncthis` (see `package.json` for the current version). **Auto-published** by `.github/workflows/publish.yml`: bump `"version"` in `package.json`, commit, push to `main` — the workflow publishes to npm via **OIDC Trusted Publishing** (no token; needs the one-time npmjs.com trusted-publisher config in the workflow header) and creates the matching git tag + GitHub Release from the CHANGELOG section. A registry guard makes it a safe no-op when the version is unchanged. `prepublishOnly` (`bun test && bunx tsc --noEmit && bun scripts/build.ts`) runs inside `npm publish`, so the published `dist/` is always freshly built and tested. To release: bump the version **and** add a `## [x.y.z]` CHANGELOG section (used as the release notes).
- **Install:** `npm install -g @hungv47/syncthis`, `bun install -g @hungv47/syncthis`, or just `npx @hungv47/syncthis run`. Runs on Node ≥18 — no Bun needed.
- **Published artifact = one self-contained file.** `files` ships only `dist/syncthis.mjs` (+ README, LICENSE). All runtime deps are bundled in, so `bun publish`/`npm publish` produces a ~470 KB tarball that installs zero transitive deps. Don't add runtime `dependencies` back to `package.json` (they'd be installed redundantly) or point `bin` at the raw `.ts`.

## Deepsec integration

`.deepsec/` is a self-contained sub-package (its own `package.json`, `pnpm-workspace.yaml`, `bun.lock`) configuring [deepsec](https://npmjs.com/package/deepsec) — an AI-powered vulnerability scanner — to scan the parent syncthis repo. It is dev tooling, not part of the published CLI. Do not bundle it.

## Testing

```bash
bun test                  # full suite
bun tsc --noEmit          # typecheck
```

Always run tests AND typecheck before bumping the version. Sacred elements (removal rails incl. `plugin rm`, conflict policy, 0600 perms, .syncthis.bak, Claude per-project merge, directional confirmation) are non-negotiable.

## What this repo is NOT

- Not an MCP server installer. Use `mcpm`, `claude mcp add`, etc. — syncthis only mirrors what's already installed.
- Not a skills tool. Skills are entirely delegated to `vercel-labs/skills` (`npx skills`). syncthis used to have a handcrafted Claude↔Cursor skill propagator; it was retired in 0.2 because the upstream is better and covers 55 agents.
- Not a config source-of-truth. There is no `syncthis.json`. The agents themselves are the source of truth; syncthis just keeps them in agreement.
