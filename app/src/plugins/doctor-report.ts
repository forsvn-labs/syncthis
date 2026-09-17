import { pluginOutcomeRows, pluginSyncHasChanges, renderPluginSyncReport } from "../cli/plugin-outcomes.ts";
import { runSync, type SyncOptions, type SyncReport } from "../sync.ts";
import {
  buildPluginOverview,
  overviewCounts,
  renderPluginOverview,
  type PluginOverview,
} from "./overview.ts";
import { PLUGIN_OUTCOMES, type PluginOutcome } from "./outcome.ts";
import {
  scanAgentHosts,
  type HostDirectoryScan,
} from "./host-sync.ts";
import type { HostSurface } from "./host-map.ts";

export type PluginDoctorReport = {
  overview: PluginOverview;
  preview: SyncReport;
  hosts: HostDirectoryScan[];
  outcomes: Record<PluginOutcome, number>;
  ok: boolean;
};

/**
 * One shared native snapshot feeds both the overview and the sync preview.
 * Doctor captures the native adapter reads once and hands them to runSync via
 * inventoryOptions, so a single discovery pass drives both halves of the
 * report — no concurrent double-read and no serialization theater.
 */
export function doctorPreviewRunner(
  overview: PluginOverview,
  run: typeof runSync = runSync,
): () => Promise<SyncReport> {
  const options: SyncOptions = {
    dryRun: true,
    inventoryOptions: { adapterReads: overview.native },
  };
  return () => run(options);
}

export async function runPluginDoctor(deps: {
  buildOverview?: () => Promise<PluginOverview>;
  previewSync?: () => Promise<SyncReport>;
  scanHosts?: () => Promise<HostDirectoryScan[]>;
} = {}): Promise<PluginDoctorReport> {
  // Sequential by design: the preview consumes the overview's native snapshot.
  const overview = await (deps.buildOverview ?? buildPluginOverview)();
  const preview = await (deps.previewSync ?? doctorPreviewRunner(overview))();
  const hosts = await (deps.scanHosts ?? (
    deps.buildOverview || deps.previewSync ? async () => [] : scanAgentHosts
  ))();
  const outcomes = Object.fromEntries(PLUGIN_OUTCOMES.map((outcome) => [outcome, 0])) as Record<PluginOutcome, number>;
  for (const row of pluginOutcomeRows(preview)) outcomes[row.outcome] += 1;
  return {
    overview,
    preview,
    hosts,
    outcomes,
    ok: preview.ok && overview.native.every((read) => !read.error),
  };
}

function hostHomeRel(path: string | null): string {
  if (!path) return "—";
  const home = process.env.HOME;
  if (home && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function hostDisplay(surface: HostSurface): string {
  if (surface.kind === "none") return "—";
  if (surface.template) return surface.template;
  return hostHomeRel(surface.path);
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function columnWidths(headers: readonly string[], rows: readonly string[][]): number[] {
  return headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
}

function alignedRow(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((cell, index) => pad(cell, widths[index] ?? cell.length)).join("  ");
}

/** Designed host map: agent · plugin dir · skills · MCP · abi */
export const HOST_MAP_HEADERS = ["AGENT", "PLUGIN DIR", "SKILLS", "MCP", "ABI"] as const;

export function renderHostDoctor(hosts: HostDirectoryScan[]): string[] {
  if (hosts.length === 0) return [];
  const rows = hosts.map((row) => [
    row.agent,
    hostDisplay(row.host.plugin),
    hostDisplay(row.host.skills),
    hostDisplay(row.host.mcp),
    row.pluginAbi,
  ]);
  const widths = columnWidths(HOST_MAP_HEADERS, rows);
  const lines = [
    "Host map",
    "agent · plugin dir · skills · MCP · abi",
    "inventory only — directory presence is not native activation",
    "",
    alignedRow(HOST_MAP_HEADERS, widths),
    widths.map((width) => "─".repeat(width)).join("  "),
    ...rows.map((row) => alignedRow(row, widths)),
  ];
  const notes: string[] = [];
  for (const row of hosts) {
    const unmanagedPlugins = row.plugins.filter((item) => !item.managed);
    const unmanagedAdapted = row.skills.filter((item) => !item.managed);
    if (unmanagedPlugins.length > 0 || unmanagedAdapted.length > 0) {
      const bits = [
        ...unmanagedPlugins.map((item) => `plugin ${item.name}`),
        ...unmanagedAdapted.map((item) => `adapted ${item.name}`),
      ];
      notes.push(`  drift  ${row.agent}  unmanaged: ${bits.join(", ")} (left untouched)`);
    }
    if (row.pluginAbi === "write-only") {
      notes.push(`  note   ${row.agent}  write-only: on-disk copy is adapted, not native`);
    }
  }
  if (notes.length > 0) lines.push("", ...notes);
  return lines;
}

export function renderPluginDoctor(report: PluginDoctorReport): string[] {
  const counts = overviewCounts(report.overview);
  const outcomeSummary = PLUGIN_OUTCOMES
    .filter((outcome) => report.outcomes[outcome] > 0)
    .map((outcome) => `${outcome} ${report.outcomes[outcome]}`)
    .join(" · ");
  const hostLines = renderHostDoctor(report.hosts);
  const status = report.ok ? "clean" : "issues found";
  const next = report.ok && !pluginSyncHasChanges(report.preview)
    ? []
    : ["", `next  syncthis sync`];
  return [
    `Doctor  ·  ${status}`,
    `  sources   ${counts.readableAgents} readable · ${counts.blockedAgents} blocked · ${counts.plugins} plugins · ${counts.nativeInstalls} native installs`,
    ...(outcomeSummary ? [`  outcomes  ${outcomeSummary}`] : []),
    "",
    ...(hostLines.length ? [...hostLines, ""] : []),
    "Installed plugins",
    ...renderPluginOverview(report.overview),
    "",
    "Synchronization preview",
    ...renderPluginSyncReport(report.preview),
    ...next,
  ];
}
