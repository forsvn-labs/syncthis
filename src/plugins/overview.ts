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
