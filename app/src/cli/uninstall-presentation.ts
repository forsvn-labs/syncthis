// Canonical uninstall presentation.
//
// One pure report-policy module feeds both the CLI printer and the Ink control
// center. The rows below are the single classification of an UninstallReport;
// each surface renders its own dialect (CLI color, Ink plain lines) on top of
// the same rows, so the two can never disagree about what was removed, kept,
// or blocked. Color lives in the CLI adapter; styling lives in the TUI.

import type { UninstallReport } from "../plugins/uninstall.ts";
import type { AgentId } from "../types.ts";
import { neutralPluginText } from "./neutral-text.ts";

export function uninstallTargetLabel(plugin: string, marketplace?: string): string {
  return marketplace ? `${plugin}@${marketplace}` : plugin;
}

export type UninstallClaudePolicy = {
  /** Claude's plugin list could not be read at all. */
  unreadable: boolean;
  /** Agents whose ONLY removal mechanism is surfaced content — a hard block. */
  blockedAgents: AgentId[];
  /** Agents covered by a native uninstall that merely could not be re-checked — warn only. */
  warnAgents: AgentId[];
};

/**
 * Single source of the Claude-unreadable ownership policy. The preview uses
 * `blockedAgents` to refuse a clean "nothing to do"; the apply phase uses it to
 * decide between a loud failure and a best-effort warning.
 */
export function uninstallClaudePolicy(report: UninstallReport): UninstallClaudePolicy {
  if (!report.claudeReadError) {
    return { unreadable: false, blockedAgents: [], warnAgents: [] };
  }
  return {
    unreadable: true,
    blockedAgents: report.requiredSkillAgents,
    warnAgents: report.requiredSkillAgents.length ? [] : report.skillScope,
  };
}

/** True when removal cannot be completed while Claude is unreadable. */
export function uninstallClaudeBlocked(report: UninstallReport): boolean {
  return uninstallClaudePolicy(report).blockedAgents.length > 0;
}

// --- Preview rows -----------------------------------------------------------

export type UninstallPreviewRow =
  | { kind: "scope"; plugins: string[]; agentCount: number }
  | { kind: "native-remove"; agent: AgentId; plugin: string; marketplace?: string }
  | { kind: "native-absent"; agent: AgentId; plugin: string; marketplace?: string }
  | { kind: "native-blocked"; agent: AgentId; plugin: string; marketplace?: string; reason: string }
  | { kind: "skills-remove"; agents: AgentId[]; names: string[] }
  | { kind: "skills-out-of-scope"; names: string[] }
  | { kind: "skills-kept"; names: string[] }
  | { kind: "mcp-blocked"; agent: AgentId; reason: string }
  | { kind: "mcp-remove"; agent: AgentId; names: string[] }
  | { kind: "mcp-kept"; agent: AgentId; names: string[] }
  | { kind: "mcp-conflict"; agent: AgentId; names: string[] }
  | { kind: "unsupported"; agent: AgentId }
  | { kind: "ownership-blocked"; agents: AgentId[] };

export function uninstallPreviewRows(report: UninstallReport): UninstallPreviewRow[] {
  const rows: UninstallPreviewRow[] = [
    { kind: "scope", plugins: report.plugins, agentCount: report.requestedAgents.length },
  ];
  for (const target of report.native) {
    if (target.unreadable) {
      rows.push({
        kind: "native-blocked",
        agent: target.agent,
        plugin: target.plugin,
        marketplace: target.marketplace,
        reason: target.unreadable,
      });
    } else if (target.present) {
      rows.push({
        kind: "native-remove",
        agent: target.agent,
        plugin: target.plugin,
        marketplace: target.marketplace,
      });
    } else {
      rows.push({
        kind: "native-absent",
        agent: target.agent,
        plugin: target.plugin,
        marketplace: target.marketplace,
      });
    }
  }
  if (report.skills.names.length && report.skills.agents.length) {
    rows.push({ kind: "skills-remove", agents: report.skills.agents, names: report.skills.names });
  } else if (report.skills.names.length) {
    rows.push({ kind: "skills-out-of-scope", names: report.skills.names });
  }
  if (report.skills.kept.length) rows.push({ kind: "skills-kept", names: report.skills.kept });
  for (const target of report.mcp) {
    if (target.unreadable) {
      rows.push({ kind: "mcp-blocked", agent: target.agent, reason: target.unreadable });
    }
    if (target.names.length) rows.push({ kind: "mcp-remove", agent: target.agent, names: target.names });
    if (target.kept.length) rows.push({ kind: "mcp-kept", agent: target.agent, names: target.kept });
    if (target.conflicts.length) {
      rows.push({ kind: "mcp-conflict", agent: target.agent, names: target.conflicts });
    }
  }
  for (const agent of report.unsupportedAgents) rows.push({ kind: "unsupported", agent });
  const ownership = uninstallClaudePolicy(report);
  if (ownership.blockedAgents.length) {
    rows.push({ kind: "ownership-blocked", agents: ownership.blockedAgents });
  }
  return rows;
}

/** Plain lines for the Ink control center's removal preview. */
export function renderUninstallPreview(report: UninstallReport): string[] {
  const lines = uninstallPreviewRows(report).map((row): string | null => {
    switch (row.kind) {
      case "scope":
        return `Remove ${row.plugins.join(", ")} from ${row.agentCount} agent(s)`;
      case "native-remove":
        return `remove   ${row.agent} · ${uninstallTargetLabel(row.plugin, row.marketplace)} · native`;
      case "native-absent":
        return null;
      case "native-blocked":
        return `blocked  ${row.agent} · ${uninstallTargetLabel(row.plugin, row.marketplace)} · ${neutralPluginText(row.reason)}`;
      case "skills-remove":
        return `remove   ${row.agents.join(", ")} · ${row.names.join(", ")} · adapted content`;
      case "skills-out-of-scope":
        return null;
      case "skills-kept":
        return `keep     ${row.names.join(", ")} · still provided by another plugin`;
      case "mcp-blocked":
        return `blocked  ${row.agent} · ${neutralPluginText(row.reason)}`;
      case "mcp-remove":
        return `remove   ${row.agent} · ${row.names.join(", ")} · adapted content`;
      case "mcp-kept":
        return `keep     ${row.agent} · ${row.names.join(", ")} · still owned elsewhere`;
      case "mcp-conflict":
        return `keep     ${row.agent} · ${row.names.join(", ")} · modified conflict`;
      case "unsupported":
        return `blocked  ${row.agent} · removal is not readable or supported`;
      case "ownership-blocked":
        return `blocked  ${row.agents.join(", ")} · ownership cannot be resolved while Claude is unreadable`;
    }
  }).filter((line): line is string => line !== null);
  if (lines.length === 1) lines.push("No matching plugin state would be removed.");
  return lines;
}

// --- Result rows ------------------------------------------------------------

export type UninstallResultRow =
  | { kind: "native-removed"; agent: AgentId; target: string }
  | { kind: "native-absent"; agent: AgentId; target: string }
  | { kind: "native-partial"; agent: AgentId; target: string; reason: string }
  | { kind: "native-blocked"; agent: AgentId; target: string; reason: string }
  | { kind: "skill-item-removed"; agent: AgentId; names: string[] }
  | { kind: "skill-item-remaining"; agent: AgentId; names: string[] }
  | {
      kind: "skill-status";
      status: "partial" | "blocked" | "skipped" | "failed" | "removed";
      message?: string;
    }
  | { kind: "mcp-removed"; agent: AgentId; names: string[] }
  | { kind: "mcp-blocked"; agent: AgentId; reason: string }
  | { kind: "mcp-skipped"; agent: AgentId; reason: string }
  | { kind: "mcp-note"; agent: AgentId; message: string }
  | { kind: "mcp-conflict"; agent: AgentId; names: string[] }
  | { kind: "unsupported"; agent: AgentId }
  | { kind: "ownership-blocked"; agents: AgentId[] };

export function uninstallResultRows(report: UninstallReport): UninstallResultRow[] {
  const rows: UninstallResultRow[] = [];
  for (const result of report.nativeResults ?? []) {
    if (result.status === "uninstalled") {
      rows.push({ kind: "native-removed", agent: result.agent, target: result.target });
    } else if (result.status === "absent") {
      rows.push({ kind: "native-absent", agent: result.agent, target: result.target });
    } else if (result.status === "skipped") {
      rows.push({
        kind: "native-partial",
        agent: result.agent,
        target: result.target,
        reason: result.message ?? "",
      });
    } else {
      rows.push({
        kind: "native-blocked",
        agent: result.agent,
        target: result.target,
        reason: result.message ?? "",
      });
    }
  }
  const skillResult = report.skillResult;
  if (skillResult) {
    for (const result of skillResult.results) {
      if (result.removed.length) {
        rows.push({ kind: "skill-item-removed", agent: result.agent, names: result.removed });
      }
      if (result.remaining.length) {
        rows.push({ kind: "skill-item-remaining", agent: result.agent, names: result.remaining });
      }
    }
    if (skillResult.status === "partial" || skillResult.status === "blocked" || skillResult.status === "failed") {
      rows.push({
        kind: "skill-status",
        status: skillResult.status === "partial" ? "partial" : "blocked",
        message: skillResult.message,
      });
    } else if (skillResult.status === "skipped") {
      rows.push({ kind: "skill-status", status: "skipped", message: skillResult.message });
    } else if (skillResult.status === "removed") {
      rows.push({ kind: "skill-status", status: "removed" });
    }
  }
  for (const result of report.mcpResults ?? []) {
    if (result.removed.length) {
      rows.push({ kind: "mcp-removed", agent: result.agent, names: result.removed });
    }
    if (result.status === "failed") {
      rows.push({ kind: "mcp-blocked", agent: result.agent, reason: result.message ?? "" });
    } else if (result.status === "skipped") {
      rows.push({ kind: "mcp-skipped", agent: result.agent, reason: result.message ?? "" });
    } else if (result.status !== "synced" && result.message && !result.removed.length) {
      rows.push({ kind: "mcp-note", agent: result.agent, message: result.message });
    }
    if (result.conflicts.length) {
      rows.push({ kind: "mcp-conflict", agent: result.agent, names: result.conflicts });
    }
  }
  for (const agent of report.unsupportedAgents) rows.push({ kind: "unsupported", agent });
  const ownership = uninstallClaudePolicy(report);
  if (ownership.blockedAgents.length) {
    rows.push({ kind: "ownership-blocked", agents: ownership.blockedAgents });
  }
  return rows;
}

/** Plain lines for the Ink control center's removal result. */
export function renderUninstallResult(report: UninstallReport): string[] {
  const lines = uninstallResultRows(report).map((row): string | null => {
    switch (row.kind) {
      case "native-removed":
        return `removed  ${row.agent} · ${row.target}`;
      case "native-absent":
        return null;
      case "native-partial":
        return `partial  ${row.agent} · ${row.target} · ${neutralPluginText(row.reason)}`;
      case "native-blocked":
        return `blocked  ${row.agent} · ${row.target} · ${neutralPluginText(row.reason)}`;
      case "skill-item-removed":
        return `removed  ${row.agent} · ${row.names.join(", ")} · adapted content`;
      case "skill-item-remaining":
        return `partial  ${row.agent} · still present: ${row.names.join(", ")}`;
      case "skill-status": {
        if (row.status !== "partial" && row.status !== "blocked") return null;
        const word = row.status === "partial" ? "partial" : "blocked";
        return `${word}  plugin adaptation · ${neutralPluginText(row.message, "fresh removal verification did not complete")}`;
      }
      case "mcp-removed":
        return `removed  ${row.agent} · ${row.names.join(", ")} · adapted content`;
      case "mcp-blocked":
        return `blocked  ${row.agent} · ${neutralPluginText(row.reason)}`;
      case "mcp-skipped":
        return null;
      case "mcp-note":
        return null;
      case "mcp-conflict":
        return null;
      case "unsupported":
        return `blocked  ${row.agent} · removal is not readable or supported`;
      case "ownership-blocked":
        return `blocked  ${row.agents.join(", ")} · ownership could not be resolved; adapted content was not removed`;
    }
  }).filter((line): line is string => line !== null);
  return lines.length ? lines : ["Nothing changed."];
}
