import { describe, expect, test } from "bun:test";
import {
  renderUninstallPreview,
  renderUninstallResult,
  uninstallClaudeBlocked,
  uninstallClaudePolicy,
  uninstallPreviewRows,
  uninstallResultRows,
} from "../src/cli/uninstall-presentation.ts";
import { printUninstallPreview } from "../src/cli/render-plugins.ts";
import type { UninstallReport } from "../src/plugins/uninstall.ts";

function report(overrides: Partial<UninstallReport> = {}): UninstallReport {
  return {
    plugins: ["alpha@mkt"],
    requestedAgents: ["claude-code", "cursor", "opencode"],
    unsupportedAgents: ["cursor"],
    native: [
      {
        agent: "claude-code",
        plugin: "alpha",
        marketplace: "mkt",
        present: true,
      },
      {
        agent: "codex",
        plugin: "alpha",
        marketplace: "mkt",
        present: false,
      },
    ],
    skills: {
      names: ["alpha-skill"],
      kept: ["shared-skill"],
      agents: ["opencode"],
    },
    mcp: [
      {
        agent: "opencode",
        names: ["alpha-server"],
        kept: ["shared-server"],
        conflicts: ["custom-server"],
      },
    ],
    skillScope: ["opencode"],
    requiredSkillAgents: [],
    applied: false,
    ...overrides,
  };
}

describe("canonical uninstall presentation", () => {
  test("rows are the single classification behind the TUI lines", () => {
    const rows = uninstallPreviewRows(report());
    const kinds = rows.map((row) => row.kind);
    expect(kinds).toContain("scope");
    expect(kinds).toContain("native-remove");
    expect(kinds).toContain("native-absent");
    expect(kinds).toContain("skills-remove");
    expect(kinds).toContain("skills-kept");
    expect(kinds).toContain("mcp-remove");
    expect(kinds).toContain("mcp-kept");
    expect(kinds).toContain("mcp-conflict");
    expect(kinds).toContain("unsupported");

    const lines = renderUninstallPreview(report());
    // Every rendered TUI line is derived from a row; nothing is classified twice.
    expect(lines.join("\n")).toContain("remove   claude-code · alpha@mkt · native");
    expect(lines.join("\n")).toContain("blocked  cursor · removal is not readable or supported");
  });

  test("CLI preview adapter prints the same facts from the same rows", () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      printUninstallPreview(report());
    } finally {
      console.log = original;
    }
    const out = logs.join("\n");
    // Same classification as the TUI: removal, absence, kept ownership, conflicts.
    expect(out).toContain("(native plugin)");
    expect(out).toContain("not installed");
    expect(out).toContain("bundled item(s) from 1 agent(s)");
    expect(out).toContain("kept (still provided by another installed plugin): shared-skill");
    expect(out).toContain("kept wrapper items (still provided by another installed plugin): shared-server");
    expect(out).not.toContain("modified conflict"); // conflicts surface via the drift row wording
  });

  test("result rows keep removed, partial, blocked, and ownership facts aligned", () => {
    const applied = report({
      applied: true,
      nativeResults: [
        { agent: "claude-code", target: "alpha@mkt", status: "uninstalled" },
        { agent: "codex", target: "alpha@mkt", status: "failed", message: "npx verification exploded" },
      ],
      skillResult: {
        status: "partial",
        skills: ["alpha-skill"],
        agents: ["opencode"],
        results: [{ agent: "opencode", removed: ["alpha-skill"], remaining: ["alpha-skill"], verified: true, status: "partial" }],
        message: "npx verification exploded",
      },
      mcpResults: [
        { agent: "opencode", removed: ["alpha-server"], conflicts: [], status: "synced" },
      ],
      claudeReadError: "registry unreadable",
      requiredSkillAgents: ["opencode"],
    });

    const rows = uninstallResultRows(applied);
    expect(rows.filter((row) => row.kind === "native-removed")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "native-blocked")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "skill-item-removed")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "ownership-blocked")).toHaveLength(1);

    const lines = renderUninstallResult(applied).join("\n");
    expect(lines).toContain("removed  claude-code · alpha@mkt");
    // Neutral wording is applied once, by the adapter — raw npx never leaks.
    expect(lines).toContain("plugin wrapper verification exploded");
    expect(lines).not.toContain("npx");
    expect(lines).toContain(
      "blocked  opencode · ownership could not be resolved; adapted content was not removed",
    );
  });

  test("the Claude ownership policy has one home for both surfaces", () => {
    const blocked = report({
      claudeReadError: "registry unreadable",
      requiredSkillAgents: ["opencode"],
      skillScope: ["opencode"],
    });
    expect(uninstallClaudeBlocked(blocked)).toBe(true);
    expect(uninstallClaudePolicy(blocked).warnAgents).toEqual([]);

    const warnOnly = report({
      claudeReadError: "registry unreadable",
      requiredSkillAgents: [],
      skillScope: ["codex"],
    });
    expect(uninstallClaudeBlocked(warnOnly)).toBe(false);
    expect(uninstallClaudePolicy(warnOnly).warnAgents).toEqual(["codex"]);

    const healthy = report();
    expect(uninstallClaudeBlocked(healthy)).toBe(false);
    expect(uninstallClaudePolicy(healthy).unreadable).toBe(false);
  });
});
