import { pluginOutcomeRows, renderPluginSyncReport } from "../cli/plugin-outcomes.ts";
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

export function renderHostDoctor(hosts: HostDirectoryScan[]): string[] {
  if (hosts.length === 0) return [];
  const lines = [
    "Host directories (inventory; directory presence is not native activation)",
  ];
  for (const row of hosts) {
    const pluginHome = hostHomeRel(row.host.plugin.path);
    const pluginBit = row.host.plugin.kind === "none"
      ? "no plugin ABI"
      : row.plugins.length > 0
        ? `${pluginHome} (${row.plugins.filter((item) => item.managed).length} managed · ${row.plugins.filter((item) => !item.managed).length} unmanaged)`
        : `${pluginHome} (${row.host.plugin.kind})`;
    lines.push(`${row.agent}  ${row.pluginAbi}  ${pluginBit}`);
    const unmanagedPlugins = row.plugins.filter((item) => !item.managed);
    const unmanagedAdapted = row.skills.filter((item) => !item.managed);
    if (unmanagedPlugins.length > 0 || unmanagedAdapted.length > 0) {
      const bits = [
        ...unmanagedPlugins.map((item) => `plugin ${item.name}`),
        ...unmanagedAdapted.map((item) => `adapted ${item.name}`),
      ];
      lines.push(`  drift  unmanaged: ${bits.join(", ")} (left untouched)`);
    }
    if (row.pluginAbi === "write-only") {
      lines.push("  note  write-only: on-disk copy is adapted, not native");
    }
  }
  return lines;
}

export function renderPluginDoctor(report: PluginDoctorReport): string[] {
  const counts = overviewCounts(report.overview);
  const outcomeSummary = PLUGIN_OUTCOMES
    .filter((outcome) => report.outcomes[outcome] > 0)
    .map((outcome) => `${outcome} ${report.outcomes[outcome]}`)
    .join(" · ");
  const hostLines = renderHostDoctor(report.hosts);
  return [
    `Sources: ${counts.readableAgents} readable · ${counts.blockedAgents} blocked · ${counts.plugins} plugins · ${counts.nativeInstalls} native installs`,
    ...(outcomeSummary ? [`Outcomes: ${outcomeSummary}`] : []),
    "",
    ...renderPluginOverview(report.overview),
    ...(hostLines.length ? ["", ...hostLines] : []),
    "",
    "Synchronization preview",
    ...renderPluginSyncReport(report.preview),
  ];
}
