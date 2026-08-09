import type { SyncReport } from "../sync.ts";
import { canonicalOutcome, type PluginOutcome } from "../plugins/outcome.ts";
import type { PluginReconcileResult } from "../plugins/reconcile.ts";
import { neutralPluginText } from "./render-plugins.ts";

/** One public row for one discovered plugin artifact and target agent. */
export type PluginOutcomeRow = {
  plugin: string;
  target: string;
  outcome: PluginOutcome;
  detail?: string;
};

const NATIVE_ACTIONS = new Map<string, string>([
  ["present", "already active"],
  ["would-install", "would install"],
  ["would-repair", "would repair"],
  ["installed", "installed and verified"],
  ["repaired", "repaired and verified"],
  ["unverified", "installed; activation cannot be read"],
  ["unsupported", "native activation is not supported"],
  ["failed", "plugin operation was blocked"],
]);

function pluginLabel(result: PluginReconcileResult): string {
  if (result.marketplace) return `${result.requestedName}@${result.marketplace}`;
  return result.plugin || result.requestedName;
}

function detailFor(result: PluginReconcileResult, outcome: PluginOutcome): string | undefined {
  const detail = result.message ? neutralPluginText(result.message) : undefined;
  if (detail) return detail;

  const action = NATIVE_ACTIONS.get(result.status);
  if (action) return action;
  if (outcome === "native") return "native activation verified";
  if (outcome === "adapted") return "plugin adapted for this target";
  if (outcome === "partial") return "some plugin capability is incomplete";
  if (outcome === "blocked") return "plugin operation was blocked";
  return "target cannot represent this plugin";
}

function outcomeFor(result: PluginReconcileResult): PluginOutcome {
  // The reconciler composes projection evidence into `outcome`. The fallback
  // keeps presentation safe for injected/legacy reports: it never infers a
  // success category from a diagnostic message.
  return result.outcome ?? canonicalOutcome(result);
}

export function pluginOutcomeRows(report: SyncReport): PluginOutcomeRow[] {
  return report.plugins.results.map((result) => {
    const outcome = outcomeFor(result);
    return {
      plugin: pluginLabel(result),
      target: result.agent,
      outcome,
      detail: detailFor(result, outcome),
    };
  });
}

/** Format one canonical row. The first word is always one of the five outcomes. */
export function formatPluginOutcome(row: PluginOutcomeRow): string {
  return `${row.outcome.padEnd(11)} ${row.plugin} → ${row.target}${row.detail ? ` — ${row.detail}` : ""}`;
}

/**
 * Render the public sync report without exposing projection records as a second
 * product list. Inventory failures are attached to the same canonical vocabulary
 * as diagnostics; they are not reported as a separate product category.
 */
export function renderPluginSyncReport(report: SyncReport): string[] {
  const lines = pluginOutcomeRows(report).map(formatPluginOutcome);
  for (const error of report.plugins.inventory.errors.filter((item) => item.source !== "native-runtime")) {
    lines.push(
      `blocked     plugin-index — ${neutralPluginText(error.message, "plugin inventory could not be read")}`,
    );
  }
  if (lines.length === 0) {
    lines.push("no installed plugins discovered");
  }
  return lines;
}

export function pluginSyncHasChanges(report: SyncReport): boolean {
  return report.plugins.hasChanges || report.pluginDegradation.hasChanges;
}

export function printPluginSyncReport(report: SyncReport): void {
  for (const line of renderPluginSyncReport(report)) console.log(`  ${line}`);
  if (!report.ok) console.log("  blocked     sync — one or more plugin targets could not be reconciled");
}
