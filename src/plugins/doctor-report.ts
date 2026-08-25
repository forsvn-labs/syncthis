import { pluginOutcomeRows, renderPluginSyncReport } from "../cli/plugin-outcomes.ts";
import { runSync, type SyncOptions, type SyncReport } from "../sync.ts";
import {
  buildPluginOverview,
  overviewCounts,
  renderPluginOverview,
  type PluginOverview,
} from "./overview.ts";
import { PLUGIN_OUTCOMES, type PluginOutcome } from "./outcome.ts";

export type PluginDoctorReport = {
  overview: PluginOverview;
  preview: SyncReport;
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
} = {}): Promise<PluginDoctorReport> {
  // Sequential by design: the preview consumes the overview's native snapshot.
  const overview = await (deps.buildOverview ?? buildPluginOverview)();
  const preview = await (deps.previewSync ?? doctorPreviewRunner(overview))();
  const outcomes = Object.fromEntries(PLUGIN_OUTCOMES.map((outcome) => [outcome, 0])) as Record<PluginOutcome, number>;
  for (const row of pluginOutcomeRows(preview)) outcomes[row.outcome] += 1;
  return {
    overview,
    preview,
    outcomes,
    ok: preview.ok && overview.native.every((read) => !read.error),
  };
}

export function renderPluginDoctor(report: PluginDoctorReport): string[] {
  const counts = overviewCounts(report.overview);
  const outcomeSummary = PLUGIN_OUTCOMES
    .filter((outcome) => report.outcomes[outcome] > 0)
    .map((outcome) => `${outcome} ${report.outcomes[outcome]}`)
    .join(" · ");
  return [
    `Sources: ${counts.readableAgents} readable · ${counts.blockedAgents} blocked · ${counts.plugins} plugins · ${counts.nativeInstalls} native installs`,
    ...(outcomeSummary ? [`Outcomes: ${outcomeSummary}`] : []),
    "",
    ...renderPluginOverview(report.overview),
    "",
    "Synchronization preview",
    ...renderPluginSyncReport(report.preview),
  ];
}
