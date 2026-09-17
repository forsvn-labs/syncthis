import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findAdapter } from "../adapters/index.ts";
import { expandHome, resolveUnderHome } from "../io.ts";
import type { AgentId } from "../types.ts";

/**
 * Canonical host-directory map: the plugin directory, skills directory, and
 * MCP config file each agent actually loads.
 *
 * Evidence, 2026:
 * - Claude Code / Codex / Copilot / Grok: native CLIs plus their on-disk
 *   plugin homes (`~/.claude/plugins`, `~/.codex/plugins`,
 *   `~/.copilot/installed-plugins`, `~/.grok/installed-plugins`).
 * - Cursor Agent Plugins: user-local drop at `~/.cursor/plugins/local`
 *   (root `plugin.json` or `.cursor-plugin/plugin.json`). `npx plugins@1.3.4`
 *   still copies into `~/.cursor/extensions`, which is not that load path.
 *   Directory listing is inventory for doctor/idempotency, not native
 *   activation — Cursor may ignore local imports under org policy.
 * - Skills: vercel-labs/skills agent map (global dirs) plus local homes.
 * - MCP: existing Syncthis adapters.
 * - OpenCode `~/.config/opencode/plugins` holds hook modules, not Agent
 *   Plugins packages.
 * - Cline's TypeScript plugin ABI is not Agent Plugins.
 * - BB (`~/.bb/plugins`) is BB's own plugin ABI, not Agent Plugins — no
 *   Syncthis target until a documented Agent Plugins contract exists.
 * - Kimi: skills CLI id `kimi-code-cli` writes `~/.agents/skills`; MCP is
 *   `~/.kimi/mcp.json`. No proven non-interactive native plugin ABI.
 */

export type PluginAbi = "verified" | "write-only" | "none";
export type HostSurfaceKind = "native-cli" | "directory-drop" | "config-file" | "none";

export type HostSurface = {
  kind: HostSurfaceKind;
  /** Documented path with `~` or `$XDG_CONFIG_HOME`. */
  template: string | null;
  /** Resolved absolute path, or null when this surface does not exist. */
  path: string | null;
  readable: boolean;
  notes?: string;
};

export type AgentHostDirectories = {
  agent: AgentId;
  pluginAbi: PluginAbi;
  plugin: HostSurface;
  skills: HostSurface;
  mcp: HostSurface;
};

export const HOST_AGENTS: readonly AgentId[] = [
  "claude-code",
  "codex",
  "github-copilot",
  "grok-build",
  "cursor",
  "gemini-cli",
  "kimi-cli",
  "antigravity",
  "windsurf",
  "opencode",
  "openclaw",
  "hermes-agent",
  "goose",
  "pi",
  "cline",
  "prime-agent",
];

const MCP_TEMPLATES: Partial<Record<AgentId, string>> = {
  "claude-code": "~/.claude.json",
  cursor: "~/.cursor/mcp.json",
  codex: "~/.codex/config.toml",
  "gemini-cli": "~/.gemini/settings.json",
  "kimi-cli": "~/.kimi/mcp.json",
  antigravity: "~/.gemini/antigravity/mcp_config.json",
  "github-copilot": "~/.copilot/mcp-config.json",
  windsurf: "~/.codeium/windsurf/mcp_config.json",
  opencode: "~/.config/opencode/opencode.json",
  openclaw: "~/.openclaw/openclaw.json",
  "hermes-agent": "~/.hermes/config.yaml",
  goose: "$XDG_CONFIG_HOME/goose/config.yaml",
};

function xdgConfigHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return (xdg ? expandHome(xdg) : expandHome("~/.config")).replace(/\/+$/, "");
}

function claudeHome(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured
    ? resolveUnderHome(configured, "CLAUDE_CONFIG_DIR")
    : expandHome("~/.claude");
}

function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? resolve(expandHome(configured)) : expandHome("~/.codex");
}

function grokHome(): string {
  const configured = process.env.GROK_HOME?.trim();
  return configured ? resolve(configured) : expandHome("~/.grok");
}

function hermesHome(): string {
  const configured = process.env.HERMES_HOME?.trim();
  return configured
    ? resolveUnderHome(configured, "HERMES_HOME")
    : expandHome("~/.hermes");
}

function copilotHome(): string {
  const override = process.env.COPILOT_HOME;
  if (override) return resolveUnderHome(override, "COPILOT_HOME");
  return expandHome("~/.copilot");
}

function openclawSkillsDir(): string {
  const home = process.env.HOME ?? homedir();
  for (const dir of [".openclaw", ".clawdbot", ".moltbot"]) {
    const candidate = join(home, dir);
    if (existsSync(candidate)) return join(candidate, "skills");
  }
  return expandHome("~/.openclaw/skills");
}

function surface(
  kind: HostSurfaceKind,
  template: string | null,
  path: string | null,
  notes?: string,
): HostSurface {
  return {
    kind,
    template,
    path,
    readable: kind === "directory-drop" || kind === "config-file" || kind === "native-cli",
    ...(notes ? { notes } : {}),
  };
}

function noneSurface(notes?: string): HostSurface {
  return surface("none", null, null, notes);
}

function mcpSurface(agent: AgentId): HostSurface {
  const adapter = findAdapter(agent);
  if (!adapter) return noneSurface("no MCP adapter");
  return surface("config-file", MCP_TEMPLATES[agent] ?? null, adapter.targetPath());
}

export function resolveAgentHost(agent: AgentId): AgentHostDirectories {
  const mcp = mcpSurface(agent);
  switch (agent) {
    case "claude-code":
      return {
        agent,
        pluginAbi: "verified",
        plugin: surface(
          "native-cli",
          "~/.claude/plugins",
          join(claudeHome(), "plugins"),
          "installed_plugins.json plus cache/; claude plugin CLI owns activation",
        ),
        skills: surface("directory-drop", "~/.claude/skills", join(claudeHome(), "skills")),
        mcp,
      };
    case "codex":
      return {
        agent,
        pluginAbi: "verified",
        plugin: surface(
          "native-cli",
          "~/.codex/plugins",
          join(codexHome(), "plugins"),
          "codex plugin CLI owns activation",
        ),
        skills: surface("directory-drop", "~/.codex/skills", join(codexHome(), "skills")),
        mcp,
      };
    case "github-copilot":
      return {
        agent,
        pluginAbi: "verified",
        plugin: surface(
          "native-cli",
          "~/.copilot/installed-plugins",
          join(copilotHome(), "installed-plugins"),
          "copilot plugin CLI owns activation",
        ),
        skills: surface("directory-drop", "~/.copilot/skills", join(copilotHome(), "skills")),
        mcp,
      };
    case "grok-build":
      return {
        agent,
        pluginAbi: "verified",
        plugin: surface(
          "native-cli",
          "~/.grok/installed-plugins",
          join(grokHome(), "installed-plugins"),
          "grok plugin CLI owns activation; xAI does not claim agent-plugins.org conformance",
        ),
        skills: surface("directory-drop", "~/.grok/skills", join(grokHome(), "skills")),
        mcp,
      };
    case "cursor":
      return {
        agent,
        pluginAbi: "write-only",
        plugin: surface(
          "directory-drop",
          "~/.cursor/plugins/local",
          expandHome("~/.cursor/plugins/local"),
          "Cursor loads local Agent Plugins from this folder; directory presence is not native activation",
        ),
        skills: surface("directory-drop", "~/.cursor/skills", expandHome("~/.cursor/skills")),
        mcp,
      };
    case "gemini-cli":
      return {
        agent,
        pluginAbi: "none",
        plugin: noneSurface("no Agent Plugins ABI"),
        skills: surface("directory-drop", "~/.gemini/skills", expandHome("~/.gemini/skills")),
        mcp,
      };
    case "kimi-cli":
      return {
        agent,
        pluginAbi: "none",
        plugin: noneSurface(
          "plugins CLI detects ~/.kimi-code; no proven non-interactive Agent Plugins ABI",
        ),
        skills: surface(
          "directory-drop",
          "~/.agents/skills",
          expandHome("~/.agents/skills"),
          "vercel-labs/skills target kimi-code-cli",
        ),
        mcp,
      };
    case "antigravity":
      return {
        agent,
        pluginAbi: "none",
        plugin: noneSurface("no Agent Plugins ABI"),
        skills: surface(
          "directory-drop",
          "~/.gemini/antigravity/skills",
          expandHome("~/.gemini/antigravity/skills"),
        ),
        mcp,
      };
    case "windsurf":
      return {
        agent,
        pluginAbi: "none",
        plugin: noneSurface("no Agent Plugins ABI"),
        skills: surface(
          "directory-drop",
          "~/.codeium/windsurf/skills",
          expandHome("~/.codeium/windsurf/skills"),
        ),
        mcp,
      };
    case "opencode":
      return {
        agent,
        pluginAbi: "none",
        plugin: noneSurface(
          "OpenCode plugins are hook modules at ~/.config/opencode/plugins, not Agent Plugins packages",
        ),
        skills: surface(
          "directory-drop",
          "~/.config/opencode/skills",
          join(xdgConfigHome(), "opencode/skills"),
        ),
        mcp,
      };
    case "openclaw":
      return {
        agent,
        pluginAbi: "none",
        plugin: noneSurface("no Agent Plugins ABI"),
        skills: surface("directory-drop", "~/.openclaw/skills", openclawSkillsDir()),
        mcp,
      };
    case "hermes-agent":
      return {
        agent,
        pluginAbi: "none",
        plugin: noneSurface("no Agent Plugins ABI"),
        skills: surface("directory-drop", "~/.hermes/skills", join(hermesHome(), "skills")),
        mcp,
      };
    case "goose":
      return {
        agent,
        pluginAbi: "none",
        plugin: noneSurface("no Agent Plugins ABI"),
        skills: surface(
          "directory-drop",
          "$XDG_CONFIG_HOME/goose/skills",
          join(xdgConfigHome(), "goose/skills"),
        ),
        mcp,
      };
    case "pi":
      return {
        agent,
        pluginAbi: "none",
        plugin: noneSurface("skill-only; no MCP or Agent Plugins ABI"),
        skills: surface("directory-drop", "~/.pi/agent/skills", expandHome("~/.pi/agent/skills")),
        mcp,
      };
    case "cline":
      return {
        agent,
        pluginAbi: "none",
        plugin: noneSurface("Cline TypeScript plugin ABI is not Agent Plugins"),
        skills: surface("directory-drop", "~/.agents/skills", expandHome("~/.agents/skills")),
        mcp,
      };
    case "prime-agent":
      return {
        agent,
        pluginAbi: "none",
        plugin: noneSurface("Prime Agent discovers Agent Skills from the universal store"),
        skills: surface("directory-drop", "~/.agents/skills", expandHome("~/.agents/skills")),
        mcp,
      };
  }
}

export function agentHostMap(): AgentHostDirectories[] {
  return HOST_AGENTS.map(resolveAgentHost);
}

export function hasDirectoryDropPlugin(agent: AgentId): boolean {
  return resolveAgentHost(agent).plugin.kind === "directory-drop";
}

export function hasDirectoryDropSkills(agent: AgentId): boolean {
  return resolveAgentHost(agent).skills.kind === "directory-drop";
}
