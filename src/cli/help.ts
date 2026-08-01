export const HELP = `syncthis — keep your AI tools in sync

  syncthis is a sync layer, not an installer. install MCP servers, plugins, and
  skills with whatever tool you prefer (mcpm, claude mcp add, claude plugin
  install, npx plugins add, npx skills add, …), then let syncthis share them
  across every coding agent.

  it manages three things — plus one flagship that does the everyday case in one shot:

usage:
  syncthis                          interactive picker (or this help if non-TTY)
  syncthis sync  [--dry-run] [--no-skills]   flagship — MCP union + skills, everywhere
                                             (alias: run)

  syncthis plugins <list|mirror|add|rm>      manage plugins      (syncthis plugins help)
  syncthis skills  <update|add|from-plugins|rm>
                                             manage skills       (syncthis skills help)
  syncthis mcp     <sync|doctor|from|rm>     manage MCP servers  (syncthis mcp help)
  syncthis mcp <from> <to>                   one-way MCP mirror between two agents

  syncthis add <repo|name…> [--as skill|plugin] --all | --agents <a,b,c>
                                             add a skill repo or an installed plugin,
                                             type auto-detected   (syncthis add help)

  syncthis doctor                            MCP coverage + conflict report
  syncthis update  [--dry-run]               update syncthis itself to the latest npm version
  syncthis version                           print the installed syncthis version
  syncthis help                              this message

what sync does:
  1. inventories installed/configured plugins and reconciles native activation
     across Claude Code, Codex, GitHub Copilot, and Cursor (write-only).
  2. reads MCP servers from all 12 supported agents.
     for Claude, merges top-level + every per-project mcpServers scope.
  3. computes the union (servers in any agent → propagated to every agent).
  4. for any name with conflicting configs across agents, leaves each agent's
     own version untouched and reports the conflict — you resolve manually.
  5. applies exact per-agent skills/MCP fallback only where native plugins are
     positively unsupported, then runs \`npx skills update -y\` to refresh loose skills.

agents supported for MCP sync (use these IDs with the directional command):
  claude-code, cursor, codex, gemini-cli, kimi-cli, antigravity,
  github-copilot, windsurf, opencode, openclaw, hermes-agent, goose
  native plugin targets: claude-code, codex, github-copilot,
  cursor (write-only via npx plugins). Kimi receives exact skills/MCP degradation.
  skills also reach \`pi\` (no native MCP, so skills-only — not an MCP-sync target).

flags:
  --dry-run       report what would change without writing.
  --no-skills     skip loose-skill fallback + update; native plugins and targeted
                  MCP fallback still run.
  --all           required for fan-out, remove-all, and plugin-rm scope.
  --agents <list> (plugin rm) comma-separated agents to uninstall from.
  --keep-data     (plugin rm) keep claude's plugin data dir on uninstall.
  --yes           skip confirmation prompt for destructive commands.
  --no-provision  (mirror) don't register missing Codex marketplaces or fall
                  unloadable bundles back to skills — Codex installs only what it
                  can already resolve. (The Cursor + non-plugin-agent skills pushes
                  still run.) By default mirror provisions (shells out, hits the
                  network) so a plugin's content actually reaches Codex.

removing a server: use \`syncthis mcp rm <server> --all --dry-run\`, review the diff,
then rerun with \`--yes\`. plain union sync will re-propagate a server if it
still exists in any agent.
`;

export const PLUGINS_HELP = `syncthis plugins — manage plugins across agents (source: claude-code)

  syncthis plugins list                      read-only overview across every agent
  syncthis plugins mirror <primary> [--no-provision] [--yes] [--dry-run]
                                             make every <primary> plugin reachable everywhere
                                             (Codex native; Cursor via npx plugins; non-plugin
                                             agents get the bundled skills + lifted MCP servers).
                                             Additive — never uninstalls.
  syncthis plugins add <name…> --all | --agents <a,b,c> [--dry-run]
                                             push chosen plugins to chosen agents
  syncthis plugins rm <name…> --all | --agents <a,b,c> [--yes] [--dry-run] [--keep-data]
                                             guarded uninstall: native plugin (claude/codex) +
                                             surfaced skills (rest). diff, confirm/--yes, --dry-run.`;

export const SKILLS_HELP = `syncthis skills — manage skills (delegated to vercel-labs/skills)

  syncthis skills update                     npx skills update -y (refresh every installed skill)
  syncthis skills add <repo…> --all | --agents <a,b,c> [--dry-run]
                                             add skill repo(s) to chosen agents
  syncthis skills from-plugins [--dry-run]   surface Claude-plugin-bundled skills to the
                                             non-plugin agents (gemini-cli, kimi-cli, opencode, …, pi)
  syncthis skills rm <name…> --all | --agents <a,b,c> [--yes] [--dry-run]
                                             guarded skill removal`;

export const MCP_HELP = `syncthis mcp — manage MCP servers (syncthis mirrors servers; it never installs them)

  syncthis mcp sync [--dry-run]              union sync across every MCP agent (skips skills)
  syncthis mcp <from> <to> [--yes] [--dry-run]
                                             one-way mirror from one agent to another
  syncthis mcp from <agent> --all [--yes] [--dry-run]
                                             fan one agent out to every other agent
  syncthis mcp rm <server…> --all | --agents <a,b,c> [--yes] [--dry-run]
                                             remove server(s) from the scoped agents
  syncthis mcp doctor                        coverage + conflict report

  (no \`mcp add\` — add a server with \`claude mcp add\`/mcpm, then \`syncthis sync\`.)`;

export const MCP_NO_ADD =
  "syncthis mirrors MCP servers, it doesn't install them. Add a server with `claude mcp add`/mcpm, then `syncthis sync`.";

export const ADD_HELP = `syncthis add — add a skill or plugin to chosen agents (type auto-detected)

  syncthis add <owner/repo…> --all | --agents <a,b,c> [--dry-run]
                                             a repo slug → treated as a SKILL repo
  syncthis add <plugin-name…> --all | --agents <a,b,c> [--dry-run]
                                             a bare name claude-code has installed →
                                             treated as a PLUGIN and propagated
  syncthis add <items…> --as skill|plugin    force the type, skip detection
  syncthis add skill|plugin <items…>         name the type explicitly (same handlers)

  detection: \`owner/repo\` → skill; a bare name claude-code has installed → plugin; any
  other bare name looks like an MCP server name — ${MCP_NO_ADD} (there is no \`add mcp\`).`;
