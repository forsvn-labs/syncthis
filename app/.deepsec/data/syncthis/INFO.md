# syncthis

## What this codebase does

`@forsvn/syncthis` (v0.2.0) is a local-only CLI (Bun/TypeScript) that mirrors MCP server configs across **11 AI coding agents**: Claude Code, Cursor, Codex, Gemini CLI, Kimi CLI, OpenCode, OpenClaw, Hermes, Windsurf, Antigravity, GitHub Copilot CLI. It mutates user-scope dotfiles in `$HOME` — the configs live at:

- `~/.claude.json`, `~/.cursor/mcp.json`, `~/.codex/config.toml` (TOML), `~/.gemini/settings.json`
- `~/.kimi/mcp.json`, `~/.gemini/antigravity/mcp_config.json`, `~/.copilot/mcp-config.json` (overridable via `$COPILOT_HOME`)
- `~/.codeium/windsurf/mcp_config.json`, `~/.config/opencode/opencode.json`
- `~/.openclaw/openclaw.json` (JSON5; overridable via `$OPENCLAW_CONFIG_PATH`)
- `~/.hermes/config.yaml` (YAML)

Skills are NOT mirrored by syncthis any more — that's delegated to `npx skills` (vercel-labs/skills, 55 agents). syncthis only invokes `npx -y skills update -y` after MCP sync.

No server, no network listener, no database, no multi-tenant surface. Run as the human developer on their own machine.

## Auth shape

There is no in-process auth model — the trust boundary is filesystem permissions on the developer's home directory. Relevant primitives:

- `writeRestrictive` (`src/io.ts`) — every write goes through this; new files land at mode `0o600`, existing files keep their existing mode ANDed with `0o600`. MCP configs frequently embed API keys in `env` / `headers`, so this is the secret-protection backstop.
- `backupIfExists` — copies `<file>` to `<file>.syncthis.bak` ON FIRST WRITE ONLY (sacred element §2). Subsequent writes leave the bak untouched so the user's pre-syncthis original is preserved. The bak is `chmod`'d to `0o600`.
- `isSymlink` guard — `writeJson` / `writeText` / `backupIfExists` refuse to follow a symlink at the target path. Any new write helper must keep this guard or the symlink check is bypassed.
- `expandHome` — only expands a leading `~` or `~/`; does not expand `$VAR` or arbitrary env. All hardcoded adapter paths flow through this.
- `resolveUnderHome(p, varName)` (`src/io.ts`) — used by env-var-overridable adapter paths (`$COPILOT_HOME`, `$OPENCLAW_CONFIG_PATH`). Expands `~`, refuses `..` segments, asserts the result is under `$HOME`. Defense against env-var-redirected writes to arbitrary filesystem locations.

## Threat model

Primary: leaking API keys carried inside MCP `env` blocks (or `headers` for HTTP MCP servers) via a world-readable backup, log line, or symlink-redirected write.

Secondary: an env-var-redirected adapter path (`$COPILOT_HOME` or `$OPENCLAW_CONFIG_PATH`) writing into a location outside `$HOME` — defended by `resolveUnderHome`.

Tertiary: a malformed config file (esp. JSON5 / YAML / TOML) causing parse-error messages to bubble up secret-bearing source lines into the user's terminal — partially mitigated, not exhaustive.

Quaternary: the supply chain of `npx -y skills update -y`, which is intentional and out of scope for this scanner.

Not in scope: network attackers, multi-user systems, privilege escalation — this is a single-user dev tool. Skills mirroring is also out of scope (delegated to `npx skills`).

## Project-specific patterns to flag

- **New write paths that bypass `writeJson` / `writeText`.** Anything that writes to a config or backup path without going through `src/io.ts` loses the symlink guard and the `0o600` clamp. Direct `Bun.write` / `node:fs` writes to a user dotfile are a finding.
- **New env-var-overridable paths that bypass `resolveUnderHome`.** If a future adapter accepts a `$FOO_HOME`-style override and joins it raw without the under-`$HOME` containment check, a malicious env var can redirect writes anywhere.
- **Logging or echoing MCP server config.** `McpServer` may carry `env: { OPENAI_API_KEY: "sk-…" }` or `headers: { Authorization: "Bearer …" }`. `console.log` of a server object — including in error messages or doctor/sync output — leaks secrets.
- **Parse-error messages that may include source lines.** `js-yaml` and `JSON5` may include the offending line in `.message`. Any `String(err)` or `err.message` propagation into user-visible output should be reviewed.
- **New `Bun.spawn` / `Bun.$` call sites.** Today the ONLY child process is `spawn(["npx", "-y", "skills", "update", "-y"])` in `runSkillsUpdate` — argv array, all literals. A new spawn that interpolates a string (file path, server name, env value) into a shell or argv is a command-injection finding.
- **Adapter `write()` that doesn't preserve unknown keys.** Each adapter reads the existing config, updates the MCP key, and spreads the rest unchanged. A `write` that emits only the synced shape would clobber unrelated user settings.
- **Directional sync (`runDirectional`) writing without confirmation.** This is destructive. The CLI prompt + `--yes` flag + non-TTY refusal is the safety mechanism. Any code path that writes the destination without going through the prompt is a finding.

## Known false-positives

- All 11 hardcoded adapter paths (`~/.claude.json`, `~/.cursor/mcp.json`, etc.) — reading and writing these is the product, not path traversal.
- `spawn(["npx", "-y", "skills", "update", "-y"])` in `src/sync.ts` — `-y` is intentional; this is the whole point of the skills refresh phase.
- `chmod 0o600` and the `mode & 0o600` mask in `writeRestrictive` — intentionally restrictive on secret-bearing files; not overly tight.
- `tests/*.test.ts` — use `Bun.file` / `mkdtemp` style temp paths and fake home dirs. Fixtures, not real user-dotfile mutation.
- `.syncthis.bak` files — by design; covered by sacred element §2.
- Welcome-marker write at `~/.syncthis/seen.json` (`src/tui.ts`) — also a user dotfile, also goes through `writeText` with `writeRestrictive`.
- The `console.warn` in `src/adapters/claude.ts` `mergeAllScopes` — only logs the server NAME, never the config body.
- `JSON.stringify(existing) === JSON.stringify(next)` in adapter equality checks — order-sensitive, may misfire as "changed" but never silently writes wrong content.
