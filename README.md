# syncthis

[![npm](https://img.shields.io/npm/v/@hungv47/syncthis?color=cb3837&label=npm&logo=npm&logoColor=white)](https://www.npmjs.com/package/@hungv47/syncthis)
[![site](https://img.shields.io/badge/site-syncthis.forsvn.com-2ea44f)](https://syncthis.forsvn.com)
[![license](https://img.shields.io/npm/l/@hungv47/syncthis)](./LICENSE)

![syncthis](./assets/banners/syncthis.png)

![syncthis mcp sync — union MCP servers across every agent](./docs/demos/out/mcp-sync.gif)

**Install a plugin once — syncthis validates native activation wherever possible, then carries only the unsupported parts to the agents that need them. Plus cross-agent MCP and skills sync.**

A plugin can bundle skills, MCP servers, and more. syncthis inventories the external `plugins`/plugins-cli catalogue plus each native runtime, installs or repairs missing native activation on **Claude Code, Codex, and GitHub Copilot CLI**, and pushes **Cursor** through its write-only plugin installer. Kimi CLI and other agents without a proven native plugin ABI receive only the exact bundle components they can use.

It does the same for raw MCP servers. Every coding agent stores them in its own file, its own format, its own path, so a server added to Claude Code is invisible to the other eleven. syncthis reads all of them, computes the union, and writes it back: **one command puts every server in every agent.**

You can still install MCPs, plugins, and skills with the native tools you already use — `mcpm`, `claude mcp add`, `claude plugin install`, `npx plugins add`, `npx skills add`, and so on. syncthis is the sync and reconciliation layer on top:

- **MCP servers** — union sync across all 12 agents: read every agent's config, compute the union, write it back, report conflicts.
- **Plugins** — the flagship sync inventories plugins-cli and native runtime state, installs or repairs native activation on **Claude Code, Codex, and GitHub Copilot CLI**, and pushes **Cursor** by source repo. Loose skills and MCP servers are applied per artifact and per agent only when that agent has no proven native plugin ABI (including Kimi CLI) or the artifact format is positively unsupported.
- **Skills** — delegated entirely to [`vercel-labs/skills`](https://github.com/vercel-labs/skills) (`npx skills update -y`), which handles 55 agents.

Supported agents for MCP sync: **Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Kimi CLI, Windsurf, Antigravity, GitHub Copilot CLI, OpenClaw, Hermes, Goose** — 12 in total.

> Union sync writes the merged set to **every** supported agent — including ones you haven't installed yet — so your servers are already in place the moment you start using a new agent. It's additive and reversible by design (see [Safe by design](#safe-by-design)); `--dry-run` previews any command.

## Quick start

No install required — run it on demand:

```bash
npx @hungv47/syncthis run
```

That reconciles native plugins first, mirrors MCP servers across every detected agent, applies any exact plugin degradation plan, then refreshes skills via `npx skills update -y`. Add `--dry-run` to preview without writing.

> syncthis ships as a single self-contained bundle that runs on **Node ≥18 — no Bun required to use it**. (Bun is only needed to hack on the source.)

If you'd rather have `syncthis` on your `PATH`:

```bash
bun install -g @hungv47/syncthis
# or
npm install -g @hungv47/syncthis
```

After global install, drop the `npx @hungv47/syncthis` prefix — every command below works as `syncthis <cmd>` instead.

## Demos

Reproducible recordings (regenerate with `docs/demos/build.sh` — see [`docs/demos/`](./docs/demos/)).

**Directional mirror — preview, then apply with the backup safety net**

![syncthis mcp directional mirror with dry-run then confirm](./docs/demos/out/mcp-directional.gif)

**Interactive picker — guided, three-noun walk-through**

![syncthis interactive picker walk-through](./docs/demos/out/interactive.gif)

**The command list**

![syncthis help — noun-first command list](./docs/demos/out/help.gif)

## What syncthis is — and isn't

| | |
|---|---|
| ✅ syncs MCP server configs across 12 coding agents | ❌ installs MCP servers (use `mcpm`, `claude mcp add`, etc.) |
| ✅ refreshes skills via `npx skills update -y` | ❌ installs skills from registries (use `npx skills add`) |
| ✅ supports one-way mirror and fan-out from one agent | ❌ starts desktop-owned MCP servers like Paper/Pencil |
| ✅ removes one MCP server across every supported agent | ❌ treats legacy/unmanaged MCP files as source of truth |
| ✅ installs or repairs native plugin activation on Claude/Codex/Copilot and pushes Cursor | ❌ treats an unreadable or unverifiable native install as successful fallback |
| ✅ shows a cross-agent plugin overview (`plugin list`) | ❌ acts as a plugin source-of-truth — each agent's own config is the truth |
| ✅ uninstalls a plugin everywhere — native plugin + surfaced skills (`plugin rm`, guarded) | ❌ deletes anything implicitly — removal only via the guarded `rm` / `plugin rm` commands |

## How it works

```bash
# 1. install MCP servers / skills / plugins with your preferred tool
mcpm install github
npx skills add vercel-labs/agent-skills --skill frontend-design
claude plugin install vercel-plugin@plugins-cli

# 2. reconcile native plugins, apply exact degradation, mirror MCP servers, refresh skills
syncthis run
```

No config file, no source-of-truth to maintain. Each agent's own config is the truth; syncthis just keeps them in agreement.

For removals, do not rely on union sync — it is additive only. Use the explicit `rm` / `plugin rm` commands (see below); otherwise a server or plugin that still exists in one agent will be re-propagated to the others on the next `run`.

## Commands

The CLI is **noun-first** — three nouns (`plugins`, `skills`, `mcp`), each with scoped verbs, plus a flagship `sync`:

```
syncthis                              # interactive picker (or help if non-TTY)
syncthis sync   [--dry-run] [--no-skills]   # flagship: plugin reconcile + MCP union + skills (alias: run)

# Plugins → chosen agents (native on Claude/Codex/Copilot; Cursor write-only; exact degradation elsewhere).
syncthis plugins list                       # cross-agent plugin overview (read-only)
syncthis plugins mirror <primary> [--no-provision] [--yes] [--dry-run]  # every plugin from primary → all
syncthis plugins add <name…> --all | --agents <a,b,c> [--dry-run]   # source = claude-code
syncthis plugins rm  <name…> --all | --agents <a,b,c> [--yes] [--dry-run] [--keep-data]
                                            # guarded uninstall: native plugin + surfaced skills

syncthis skills update                      # `npx skills update -y`
syncthis skills add <repo…> --all | --agents <a,b,c> [--dry-run]
syncthis skills from-plugins [--dry-run]    # surface Claude-plugin-bundled skills to non-plugin agents
syncthis skills rm  <name…> --all | --agents <a,b,c> [--yes] [--dry-run]

syncthis mcp sync [--dry-run]               # MCP-only union sync (skip skills)
syncthis mcp <from> <to> [--yes] [--dry-run]    # one-way mirror MCP from one agent to another
syncthis mcp from <agent> --all [--yes] [--dry-run] # fan one agent out to every other agent
syncthis mcp rm <server…> --all | --agents <a,b,c> [--yes] [--dry-run]
syncthis mcp doctor                         # MCP coverage + conflict report (alias: doctor)
# (no `mcp add` — syncthis mirrors MCP servers, it doesn't install them)

syncthis add <repo|name…> [--as skill|plugin] --all | --agents <a,b,c> [--dry-run]
                                            # auto-detect: owner/repo → skill; installed plugin name → plugin

syncthis doctor                             # MCP coverage + conflict report
syncthis update [--dry-run]                 # update syncthis itself to latest
syncthis version                            # print the installed syncthis version
syncthis help                               # noun-first overview
```

> The earlier flat commands (`run`, `mirror`, `from`, `<from> <to>`, `add skill|plugin`, `rm mcp|skill|plugin`, `plugin list|rm`, bare `mcp`/`skills`) still work as unadvertised aliases — nothing breaks if you've scripted against them.

`--dry-run` prints what would change without writing.
`--no-skills` skips loose-skill degradation and the skills update phase; native plugin reconciliation and targeted MCP degradation still run.
`--no-provision` (mirror) skips registering missing Codex marketplaces and the positively-skills-only Codex fallback — Codex installs only the plugins it can already resolve. (The Cursor push and exact non-plugin-agent degradation still run; those are the mirror's payload, not provisioning.) By default mirror provisions the source marketplace on the target and applies the Codex skills path only when source inspection positively identifies a skills-only bundle.
`--all` is required for fan-out and remove-all commands.
`--yes` skips the confirmation prompt for destructive commands.
`syncthis update` runs the global latest install command (`npm install -g @hungv47/syncthis@latest`, or Bun's global install when the current executable comes from Bun).

## Supported agents

| Agent | Config file |
|---|---|
| `claude-code` | `~/.claude.json` (merges top-level + every `projects.*.mcpServers` scope) |
| `cursor` | `~/.cursor/mcp.json` |
| `codex` | `~/.codex/config.toml` (root override via `$CODEX_HOME`) |
| `gemini-cli` | `~/.gemini/settings.json` |
| `kimi-cli` | `~/.kimi/mcp.json` |
| `antigravity` | `~/.gemini/antigravity/mcp_config.json` |
| `github-copilot` | `~/.copilot/mcp-config.json` (override via `$COPILOT_HOME`) |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` |
| `opencode` | `~/.config/opencode/opencode.json` |
| `openclaw` | `~/.openclaw/openclaw.json` (override via `$OPENCLAW_CONFIG_PATH`) |
| `hermes-agent` | `~/.hermes/config.yaml` |
| `goose` | `~/.config/goose/config.yaml` (YAML `extensions`; built-ins preserved) |

Skills additionally reach **`pi`** (badlogic/pi-mono), which ships without native MCP by design — so it's a skills-only target (no MCP adapter).

## What `syncthis run` does

1. **Inventories plugin artifacts** from external plugins-cli state, Claude/Codex configuration, and the readable native runtimes.
2. **Reconciles native activation.** Missing or configured-but-inactive plugins are installed or repaired on Claude Code, Codex, and GitHub Copilot CLI. Cursor is pushed through `npx plugins` as a write-only target; Kimi is classified as having no proven non-interactive native ABI.
3. **Verifies readable native targets.** A fresh authoritative read must show the activated plugin. Read, install, capability-check, and verification errors remain failures; they never authorize loose fallback.
4. **Reads and unions MCP servers.** For Claude, reads top-level + every per-project scope. Conflicting definitions remain untouched and are reported.
5. **Applies exact degradation.** Bundled skills and MCP servers are surfaced only for the specific artifact/agent pair with no native plugin ABI, or when a readable artifact is positively identified as an unsupported native format. Successful native activation never receives duplicate loose content.
6. **Refreshes skills** by running `npx skills update -y`. Skills sync is delegated to `vercel-labs/skills`, which handles 55 agents.

### Safe by design

syncthis writes to files that hold your whole agent config — often with API keys — so every write is defensive:

- **Additive — never deletes.** `run`/`sync` only ever adds servers. Deletion is opt-in and explicit (`syncthis rm`), always with a diff and confirmation.
- **Never picks a winner.** If the same server name has different configs across agents, syncthis leaves each agent's own copy untouched and reports the conflict for you to resolve. It won't silently overwrite your config with another agent's.
- **Backed up on first write.** Each target file is copied to `<file>.syncthis.bak` the first time syncthis touches it, so the original is always recoverable.
- **Atomic + `0600`.** Writes go to a temp file and are atomically renamed into place (a crash can't truncate your config), clamped to owner-only `0600` since they can carry secrets.
- **Idempotent.** Re-running converges — including SSE/HTTP servers — instead of churning or raising phantom conflicts.
- **Agent compatibility is explicit.** If a target agent can't safely load a synced server,
  syncthis keeps the server in that agent's config but writes the safe agent-specific
  state and reports a compatibility adjustment. Example: opencode remotes that would
  corrupt its TUI with schema warnings are written as `enabled: false`.
- **Preview anything** with `--dry-run`; destructive commands refuse to run unattended without `--yes`.

## Directional sync

```bash
syncthis claude-code codex --dry-run
```

Mirrors MCP servers from `claude-code` to `codex` (one-way, destructive). Shows a diff and asks for confirmation before writing — pass `--yes` to skip the prompt. The conflict policy of the union sync does NOT apply here: this is an explicit overwrite of `to`'s config with `from`'s.

To fan out one clean source to every other supported agent:

```bash
syncthis from antigravity --all --dry-run
syncthis from antigravity --all --yes
```

## Conflict example (union sync)

```
$ syncthis run
read 3 server name(s) across 12 agent(s); 2 synced, 1 conflict(s)
  ✓ claude-code     ~/.claude.json
  ✓ cursor          ~/.cursor/mcp.json
  ...

1 conflict(s) — left each agent's own copy untouched:
  ~ github
      in claude-code
      in cursor
  resolve by deleting the version you don't want, then re-run sync.
```

## Removing a server

Use the explicit remove command:

```bash
syncthis rm executor --all --dry-run
syncthis rm executor --all --yes
```

`syncthis run` is a union sync. If `executor` still exists in one agent, union sync will re-propagate it. `syncthis rm` avoids that by deleting the named server from every supported agent in one pass.

## Plugins

Plugins aren't config records like MCP servers — they're installed artifact bundles with per-agent identity and install mechanics. The flagship `sync` is plugin-first: it inventories the external plugins-cli catalogue and native runtime state, then reconciles each eligible artifact against every target before applying MCP union or loose-skill refresh.

- **Claude Code** installs natively with `claude plugin install`; success requires a fresh authoritative state read showing the plugin active.
- **Codex** installs natively with `codex plugin add`; its config and managed marketplace roots honor `$CODEX_HOME` when set.
- **Kimi CLI** has no proven non-interactive native plugin ABI in the supported toolchain, so each artifact receives only its exact bundled skills and MCP degradation.
- **GitHub Copilot CLI** registers marketplaces and installs repositories or exact local plugin paths with `copilot plugin`; activation and removal require a fresh `copilot plugin list`.
- **Cursor** has no readable plugin state, so it is an explicitly **write-only** target pushed by source repo through `npx plugins add --target cursor`. The result is reported as unverified rather than pretending activation was observed.
- **Agents without a native plugin ABI** receive the artifact's bundled skills and MCP servers only for that exact agent. A native target receives the same degradation only when the inspected artifact is positively unsupported; native read/install/verification failures do not fall back.

The selective `plugins add` flow and the `plugins mirror` batch shortcut remain additive. They use a Claude source for its marketplace/source metadata and never uninstall implicitly.

```bash
# See what's installed where (read-only): native plugins on Claude/Codex/Copilot,
# plus the plugin-derived skills surfaced on every non-plugin agent.
syncthis plugin list

# Add selected Claude plugins to chosen agents
syncthis add plugin forsvn-skills --agents codex,opencode --dry-run
syncthis add plugin forsvn-skills --agents codex,opencode

# Batch every installed plugin from one primary to every other agent
syncthis mirror claude-code --dry-run
syncthis mirror claude-code --yes
syncthis mirror claude-code --no-provision --yes   # skip Codex marketplace registration + Codex skills-fallback

# Uninstall a plugin everywhere — native plugin (Claude/Codex/Copilot) AND surfaced skills
syncthis plugin rm forsvn-skills --all --dry-run   # preview the diff first
syncthis plugin rm forsvn-skills --all --yes
syncthis plugin rm forsvn-skills --agents codex,opencode,gemini-cli --yes
```

`add plugin` lets you choose exact plugins and agents. `mirror` shows a diff and prompts for confirmation unless you pass `--yes`; it only ever **adds** every plugin from the primary — it can never wipe an agent's plugins. Removal is a separate, explicit command (`plugin rm`, below). Installs delegate to each target's native CLI; nothing is written directly to a plugin cache.

### Uninstalling — `plugin rm`

`plugin rm <plugin…>` is the only plugin-removal path (sync and mirror never remove). For each named plugin it uninstalls the native plugin from the scoped readable plugin targets — Claude Code, Codex, and GitHub Copilot CLI — **and** removes that plugin's surfaced skills from the scoped agents (`npx skills remove`), including Kimi and Codex when the mirror surfaced a positively skills-only bundle there. It's guarded like MCP `rm`: an explicit scope (`--all` or `--agents <a,b,c>`), a diff before any write, TTY-confirm or `--yes`, and `--dry-run`. Each argument is `name` (every installed instance) or `name@marketplace` (one instance). A skill another still-installed plugin record also provides is **kept** (no collateral removal); `--keep-data` preserves Claude's plugin data dir. Cursor is write-only and can't be uninstalled. The interactive picker offers the same flow with plugin and agent checkboxes.

`mirror` reads the target's **real** install state (e.g. `codex plugin list`), not just what's registered in config — so it installs exactly what's missing and resolves each plugin to the target's own `<name>@<marketplace>` automatically.

**Provisioning is on by default.** When Codex doesn't yet have a plugin's marketplace, syncthis registers its source repo (`npx plugins add <owner/repo> --target codex`, repo from the primary's marketplace list) and installs it — which also installs the repo's canonical plugin. Pass `--no-provision` to skip that registration and the Codex skills-fallback — Codex then installs only the plugins it can already resolve. (It's not a fully offline switch: the Cursor and non-plugin-agent skills pushes still run.)

**Fallback is evidence-gated, not a catch-all.** The flagship sync degrades an artifact only for a target with no native plugin ABI or a format that inspection positively proves that native target cannot load. A missing CLI, malformed state, failed native install, or failed post-install verification remains a failure and does not unlock loose skills or MCP fallback. The selective mirror has one narrower Codex path: a source that is positively identified as skills-only can be added to Codex through `npx skills`.

- **Multi-plugin marketplaces.** Marketplaces like `browserbase`, `expo`, and `anthropics/skills` can alias one bundle under several plugin names. When the canonical native plugin is already active, aliases are marked **covered** and never duplicated as loose skills.
- **Positively skills-only bundles.** After provisioning, mirror can add the bundle's skills to Codex via `npx skills add <repo> -a codex`, but only when source inspection finds skills and no recognized native manifest, and no plugin from that repo already landed.

Policy skips such as no resolvable marketplace under `--no-provision` are reported with a reason. Native state, install, and verification errors are failures.

You can still install or remove plugins directly with each native tool. syncthis also drives those native install paths during `sync`, `plugins add`, and `plugins mirror`, and drives native removal only through the explicit guarded `plugins rm` command.

## Desktop-owned servers

Paper and Pencil can be desktop-owned: the config may be synced, but the server only responds when the desktop client starts it. syncthis only syncs config; it does not launch those apps.

## Unmanaged MCP files

`syncthis doctor` warns when known side files contain MCP servers that syncthis does not write, such as VS Code user MCP config or the legacy `~/.config/mcp/servers.json`. Treat those as app-owned or legacy files, not the canonical source for coding-agent sync.

## Skills

Skills are handled entirely by [`npx skills`](https://github.com/vercel-labs/skills) (Vercel Labs). syncthis runs `npx skills update -y` as part of `run`/`sync` to refresh registry-installed skills. For installing skills, use `npx skills add <repo>` directly. See [skills.sh](https://skills.sh) for the registry.

## Troubleshooting

Run `syncthis doctor` first — it reports each agent's config status, per-server coverage, conflicts, and any unmanaged side files, and exits non-zero if conflicts exist.

| Symptom | Cause | Fix |
|---|---|---|
| `N conflict(s) — left each agent's own copy untouched` | The same server name has different configs in different agents. syncthis won't choose for you. | `syncthis doctor` shows where each version lives. Delete the one you don't want (in that agent's config), then re-run `syncthis run`. |
| A server you removed keeps coming back | Union sync is additive — if the server still exists in *any* agent, it re-propagates. | Remove it everywhere in one pass: `syncthis rm <server> --all --dry-run`, review, then `--yes`. |
| `refusing destructive write without --yes` (exit 2) | A destructive command (`<from> <to>`, `from --all`, `rm`, `mirror`) was run non-interactively (CI, pipe) with no TTY to confirm at. | Add `--yes` to confirm in non-interactive contexts, or run it in a terminal. |
| `cannot read source <agent>: …` | The source agent's config is missing or malformed, so a directional sync would look like "delete everything." | syncthis bails before writing. Fix or create that agent's config, or sync from a different source. |
| `target is a symlink, refusing to write through it` | The agent config (or its `.syncthis.bak`) is a symlink. | Intentional — syncthis won't clobber a symlink. Replace it with a regular file if you want syncthis to manage it. |
| `mirror` reports plugins as `skipped` | The target can't resolve that plugin's marketplace — normally under `--no-provision` or an ambiguous marketplace. Policy skips are not activation failures. | Drop `--no-provision` (the default) to let mirror register the marketplace. Skills fallback is used only for a positively identified skills-only source. |
| `mirror` reports plugins as `covered` | The bundle is already on the target as a plugin under its canonical name (a multi-plugin marketplace alias, or a URL-named plugin). | Nothing to do — `covered` means the content is present; it isn't re-added as skills (no duplication). |
| `native verification failed` or `fresh native read did not show…` | The installer exited, but authoritative runtime state did not prove activation. | Fix the native runtime/config and re-run. syncthis reports this as a failure and does not substitute loose fallback content. |
| `… CLI not found on PATH` during plugin reconciliation | The required native CLI (`claude`, `codex`, `copilot`, or `npx plugins` for Cursor) isn't installed. | Install that agent's CLI; syncthis drives plugins through it, it doesn't bundle one. |
| Skills step says it failed or timed out | `npx skills` hit the network and was slow/unavailable. | Non-fatal — MCP sync still completed. Re-run `syncthis skills` later, or `syncthis run --no-skills` to skip it. |

syncthis honors `NO_COLOR` (disable ANSI), `$CODEX_HOME` for Codex's config and managed marketplace root, and `$COPILOT_HOME` / `$OPENCLAW_CONFIG_PATH` for those agents' configs.

## License

MIT
