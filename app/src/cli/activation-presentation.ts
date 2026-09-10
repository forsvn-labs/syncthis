// Canonical activation presentation.
//
// One pure report-policy module for `plugins enable|disable`, analogous to
// uninstall-presentation.ts: the rows below are the single classification of an
// ActivationReport; each surface renders its own dialect on top of the same
// rows. No renderer imports here, so the CLI and the Ink control center can
// never disagree about what would change, what is unsupported, or what failed.

import type { ActivationReport } from "../plugins/activation.ts";
import type { PluginActivationOp, PluginActivationScope } from "../plugins/types.ts";
import { neutralPluginText } from "./render-plugins.ts";
import type { AgentId } from "../types.ts";

/**
 * Claude-only scope choices for the interactive configure flow. Pure data so
 * the Ink screen renders and tests check the same vocabulary. `auto` means no
 * --scope flag: each requested record keeps its own observed config scope.
 */
export const CLAUDE_SCOPE_OPTIONS: Array<{
  value: PluginActivationScope | "auto";
  label: string;
  hint: string;
}> = [
  { value: "auto", label: "Auto — exact installed record", hint: "recommended; keeps each record's own scope" },
  { value: "user", label: "User scope", hint: "--scope user" },
  { value: "project", label: "Project scope", hint: "--scope project" },
  { value: "local", label: "Local scope", hint: "--scope local" },
];

export function claudeScopeChoice(value: PluginActivationScope | "auto"): PluginActivationScope | undefined {
  return value === "auto" ? undefined : value;
}

export type ActivationPreviewRow =
  | { kind: "scope"; op: PluginActivationOp; plugins: string[]; agentCount: number }
  // Command would run: target state is not already the requested one.
  | { kind: "plan"; agent: AgentId; plugin: string; state: "enabled" | "disabled"; command?: string }
  // Fresh read already shows the requested state; no command needed.
  | { kind: "already"; agent: AgentId; plugin: string; state: "enabled" | "disabled" }
  | { kind: "absent"; agent: AgentId; plugin: string }
  | { kind: "blocked"; agent: AgentId; plugin: string; reason: string }
  | { kind: "ambiguous"; agent: AgentId; plugin: string; records: string[] }
  | { kind: "unsupported"; agent: AgentId; reason: string };

export function activationPreviewRows(report: ActivationReport): ActivationPreviewRow[] {
  const rows: ActivationPreviewRow[] = [
    { kind: "scope", op: report.op, plugins: report.plugins, agentCount: report.requestedAgents.length },
  ];
  const desired = report.op === "enable";
  const desiredState = desired ? "enabled" : "disabled";
  for (const target of report.targets) {
    if (target.invalidSpec) {
      rows.push({ kind: "blocked", agent: target.agent, plugin: target.plugin, reason: target.invalidSpec });
    } else if (target.unreadable) {
      rows.push({ kind: "blocked", agent: target.agent, plugin: target.plugin, reason: target.unreadable });
    } else if (target.ambiguousRecords) {
      rows.push({
        kind: "ambiguous",
        agent: target.agent,
        plugin: target.plugin,
        records: target.ambiguousRecords,
      });
    } else if (!target.present) {
      rows.push({ kind: "absent", agent: target.agent, plugin: target.plugin });
    } else if (target.refusal) {
      rows.push({ kind: "blocked", agent: target.agent, plugin: target.plugin, reason: target.refusal });
    } else if (target.currentlyEnabled === undefined || target.currentlyEnabled !== desired) {
      rows.push({
        kind: "plan",
        agent: target.agent,
        plugin: target.plugin,
        state: desiredState,
        ...(target.plannedCommand ? { command: target.plannedCommand.join(" ") } : {}),
      });
    } else {
      rows.push({ kind: "already", agent: target.agent, plugin: target.plugin, state: desiredState });
    }
  }
  for (const item of report.unsupported) {
    rows.push({ kind: "unsupported", agent: item.agent, reason: item.reason });
  }
  return rows;
}

/** Plain lines for non-CLI surfaces. */
export function renderActivationPreview(report: ActivationReport): string[] {
  const verb = report.op === "enable" ? "Enable" : "Disable";
  const lines = activationPreviewRows(report).map((row): string | null => {
    switch (row.kind) {
      case "scope":
        return `${verb} ${row.plugins.join(", ")}`;
      case "plan":
        return `plan     ${row.agent} · ${row.plugin} · ${row.command ? `would run: ${row.command}` : `would be ${row.state}`}`;
      case "already":
        return null;
      case "absent":
        return null;
      case "blocked":
        // The reason distinguishes an unreadable client from the target's own
        // dry-run refusal; never collapse both into one hardcoded label.
        return `blocked  ${row.agent} · ${row.plugin} · ${neutralPluginText(row.reason, "cannot read plugins")}`;
      case "ambiguous":
        return `ambiguous  ${row.agent} · ${row.plugin} · several installed records match (${row.records.join(", ")}); qualify with <name>@<marketplace> and/or --scope`;
      case "unsupported":
        return `unsupported  ${row.agent} · ${row.reason}`;
    }
  }).filter((line): line is string => line !== null);
  if (lines.length === 1) lines.push("No installed plugin state matches this request.");
  return lines;
}

// --- Result rows ------------------------------------------------------------

export type ActivationResultRow =
  | { kind: "planned"; agent: AgentId; target: string; status: "enabled" | "disabled" }
  | { kind: "changed"; agent: AgentId; target: string; status: "enabled" | "disabled" }
  | { kind: "unchanged"; agent: AgentId; target: string; status: "enabled" | "disabled" }
  | { kind: "absent"; agent: AgentId; target: string }
  | { kind: "failed"; agent: AgentId; target: string; reason: string };

export function activationResultRows(report: ActivationReport): ActivationResultRow[] {
  const rows: ActivationResultRow[] = [];
  for (const result of report.results ?? []) {
    if (result.planned && (result.status === "enabled" || result.status === "disabled")) {
      rows.push({ kind: "planned", agent: result.agent, target: result.target, status: result.status });
    } else if (result.status === "enabled" || result.status === "disabled") {
      rows.push({
        kind: result.message?.startsWith("already") ? "unchanged" : "changed",
        agent: result.agent,
        target: result.target,
        status: result.status,
      });
    } else if (result.status === "absent") {
      rows.push({ kind: "absent", agent: result.agent, target: result.target });
    } else if (result.status === "unsupported") {
      // A target that positively refuses the operation is a non-completion,
      // never a silent success or an omitted row.
      rows.push({
        kind: "failed",
        agent: result.agent,
        target: result.target,
        reason: result.message ?? "target does not support this activation operation",
      });
    } else if (result.status === "failed") {
      rows.push({ kind: "failed", agent: result.agent, target: result.target, reason: result.message ?? "" });
    }
  }
  return rows;
}

export function activationFailures(rows: ActivationResultRow[]): number {
  return rows.filter((row) => row.kind === "failed").length;
}

/** Plain lines for non-CLI surfaces (Ink configure result). */
export function renderActivationResult(report: ActivationReport): string[] {
  const verb = report.op === "enable" ? "enable" : "disable";
  const lines: string[] = [];
  for (const row of activationResultRows(report)) {
    switch (row.kind) {
      case "planned":
        lines.push(`planned   ${row.agent} · ${row.target} · would be ${row.status} (dry-run, unverified)`);
        break;
      case "changed":
        lines.push(`changed   ${row.agent} · ${row.target} · verified ${row.status}`);
        break;
      case "unchanged":
        lines.push(`unchanged ${row.agent} · ${row.target} · already ${row.status}`);
        break;
      case "absent":
        lines.push(`absent    ${row.agent} · ${row.target} · not installed`);
        break;
      case "failed":
        lines.push(`failed    ${row.agent} · ${row.target} · ${row.reason || `plugin ${verb} failed`}`);
        break;
    }
  }
  for (const item of report.unsupported) {
    lines.push(`unsupported ${item.agent} · ${item.reason}`);
  }
  if (!lines.length) lines.push("No plugin state matched this request.");
  const failures = activationFailures(activationResultRows(report));
  if (failures > 0) lines.push(`${failures} target(s) failed verification; nothing failed silently.`);
  return lines;
}
