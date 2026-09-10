// Unified plugin overview — readable native plugin state from plugin-capable agents.
// Cursor is write-only and is rendered separately by callers; it is never represented
// here as installed state because its native state cannot be verified.

import { listPlugins } from "./index.ts";
import { pluginIdentityKeys } from "./shell.ts";
import type { PluginAdapterRead } from "./types.ts";
import type { AgentId } from "../types.ts";

export type PluginOverview = {
  native: PluginAdapterRead[];
};

export type PluginOverviewCell = {
  state: "native" | "disabled" | "absent" | "blocked";
  version?: string;
  marketplace?: string;
  // Target-local config scope of the installed record when the source reports
  // one (Claude Code). Absent means the source has no scope notion or did not
  // report it — never rendered as a claim.
  scope?: string;
  // Provenance when the target itself reports it: local install path or the
  // owner/repo of the registering marketplace.
  path?: string;
  sourceRepo?: string;
  detail?: string;
};

export type PluginOverviewRow = {
  plugin: string;
  agents: Partial<Record<AgentId, PluginOverviewCell>>;
};

export async function buildPluginOverview(): Promise<PluginOverview> {
  return { native: await listPlugins() };
}

function overviewKey(name: string): string {
  return [...pluginIdentityKeys(name)].sort()[0] ?? name;
}

export function pluginOverviewRows(overview: PluginOverview): PluginOverviewRow[] {
  const rows = new Map<string, PluginOverviewRow>();
  for (const read of overview.native) {
    if (read.error) continue;
    for (const plugin of read.plugins) {
      const key = `${overviewKey(plugin.name)}\0${plugin.marketplace ?? ""}`;
      const display = plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name;
      const row = rows.get(key) ?? { plugin: display, agents: {} };
      row.agents[read.agent] = {
        state: plugin.enabled === false ? "disabled" : "native",
        version: plugin.version,
        marketplace: plugin.marketplace,
        ...(plugin.scope ? { scope: plugin.scope } : {}),
        ...(plugin.path ? { path: plugin.path } : {}),
        ...(plugin.sourceRepo ? { sourceRepo: plugin.sourceRepo } : {}),
      };
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((left, right) => left.plugin.localeCompare(right.plugin));
}

export function overviewAgentState(
  overview: PluginOverview,
  row: PluginOverviewRow,
  agent: AgentId,
): PluginOverviewCell {
  const present = row.agents[agent];
  if (present) return present;
  const read = overview.native.find((item) => item.agent === agent);
  if (read?.error) return { state: "blocked", detail: read.error };
  return { state: "absent" };
}

export function overviewCounts(overview: PluginOverview): {
  plugins: number;
  nativeInstalls: number;
  readableAgents: number;
  blockedAgents: number;
} {
  const rows = pluginOverviewRows(overview);
  return {
    plugins: rows.length,
    nativeInstalls: rows.reduce((count, row) => count + Object.keys(row.agents).length, 0),
    readableAgents: overview.native.filter((read) => !read.error).length,
    blockedAgents: overview.native.filter((read) => !!read.error).length,
  };
}

const AGENT_COLUMNS: Array<{ agent: AgentId; label: string }> = [
  { agent: "claude-code", label: "Claude" },
  { agent: "codex", label: "Codex" },
  { agent: "github-copilot", label: "Copilot" },
  { agent: "grok-build", label: "Grok" },
];

function cellLabel(cell: PluginOverviewCell): string {
  if (cell.state === "native") return "native";
  if (cell.state === "disabled") return "off";
  if (cell.state === "blocked") return "blocked";
  return "—";
}

/** Plain-text matrix shared by the CLI and Ink control center. */
export function renderPluginOverview(overview: PluginOverview): string[] {
  const rows = pluginOverviewRows(overview);
  const lines = [
    `${"Plugin".padEnd(25)}${AGENT_COLUMNS.map((column) => column.label.padEnd(11)).join("")}`.trimEnd(),
    `${"─".repeat(24)} ${AGENT_COLUMNS.map(() => "─".repeat(10)).join(" ")}`,
  ];
  if (rows.length === 0) lines.push("No installed plugins found in readable native agents.");
  for (const row of rows) {
    const label = row.plugin.length > 23 ? `${row.plugin.slice(0, 22)}…` : row.plugin;
    lines.push(
      `${label.padEnd(25)}${AGENT_COLUMNS.map((column) =>
        cellLabel(overviewAgentState(overview, row, column.agent)).padEnd(11)
      ).join("")}`.trimEnd(),
    );
  }
  for (const read of overview.native) {
    if (read.error) lines.push(`blocked  ${read.agent} — ${read.error}`);
  }
  lines.push("Cursor is write-only. Its activation cannot be read or claimed as native.");
  return lines;
}

/** One-line per-agent summary for list rows. Never claims unreadable state. */
export function pluginRowSummary(row: PluginOverviewRow): string {
  return AGENT_COLUMNS.map((column) => {
    const cell = row.agents[column.agent];
    if (!cell) return `${column.label} —`;
    return `${column.label} ${cell.state === "disabled" ? "off" : "native"}`;
  }).join(" · ");
}

/**
 * Detail lines for one installed plugin across every known source. Pure data
 * shared by the Ink detail view; unreadable sources report "state unknown"
 * instead of an invented state.
 */
export function pluginDetailLines(overview: PluginOverview, row: PluginOverviewRow): string[] {
  const lines = [`Installed state for ${row.plugin}`];
  let claimed = false;
  const seen = new Set<AgentId>();
  for (const read of overview.native) {
    if (seen.has(read.agent)) continue;
    seen.add(read.agent);
    if (read.error) {
      lines.push(`  ${read.agent} · blocked — ${read.error}`);
      continue;
    }
    const cell = row.agents[read.agent];
    if (!cell || cell.state === "absent") {
      lines.push(`  ${read.agent} · not installed`);
      continue;
    }
    claimed = true;
    const facts = [cell.state === "disabled" ? "native · disabled" : "native"];
    if (cell.version) facts.push(`version ${cell.version}`);
    if (cell.scope) facts.push(`scope ${cell.scope}`);
    if (cell.path) facts.push(`path ${cell.path}`);
    else if (cell.sourceRepo) facts.push(`source ${cell.sourceRepo}`);
    lines.push(`  ${read.agent} · ${facts.join(" · ")}`);
  }
  if (!claimed) lines.push("No readable agent reports this plugin as installed.");
  lines.push("Cursor is write-only. Its activation cannot be read or claimed as native.");
  return lines;
}
