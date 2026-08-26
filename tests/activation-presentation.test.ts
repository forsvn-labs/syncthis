import { describe, expect, test } from "bun:test";
import {
  CLAUDE_SCOPE_OPTIONS,
  activationPreviewRows,
  activationResultRows,
  claudeScopeChoice,
  renderActivationPreview,
  renderActivationResult,
} from "../src/cli/activation-presentation.ts";
import type { ActivationReport } from "../src/plugins/activation.ts";

function report(overrides: Partial<ActivationReport> = {}): ActivationReport {
  return {
    op: "enable",
    plugins: ["foo"],
    requestedAgents: ["claude-code", "codex"],
    targets: [],
    unsupported: [],
    applied: true,
    ...overrides,
  };
}

describe("activation presentation rows", () => {
  test("preview rows classify plan/already/absent/unsupported from report data", () => {
    const rows = activationPreviewRows(report({
      targets: [
        {
          agent: "claude-code",
          plugin: "foo",
          present: true,
          currentlyEnabled: false,
          plannedCommand: ["claude", "plugin", "enable", "--", "foo"],
        },
        { agent: "claude-code", plugin: "gone", present: false },
      ],
      unsupported: [{ agent: "codex", reason: "codex has no proven integrated activation contract" }],
    }));

    expect(rows[0]).toEqual({ kind: "scope", op: "enable", plugins: ["foo"], agentCount: 2 });
    expect(rows).toContainEqual({
      kind: "plan",
      agent: "claude-code",
      plugin: "foo",
      state: "enabled",
      command: "claude plugin enable -- foo",
    });
    expect(rows).toContainEqual({ kind: "absent", agent: "claude-code", plugin: "gone" });
    expect(rows).toContainEqual({
      kind: "unsupported",
      agent: "codex",
      reason: "codex has no proven integrated activation contract",
    });
  });

  test("result lines show verified changes, unchanged, absent, failures, unsupported", () => {
    const lines = renderActivationResult(report({
      results: [
        { agent: "claude-code", target: "foo", status: "enabled" },
        { agent: "claude-code", target: "bar", status: "enabled", message: "already enabled" },
        { agent: "claude-code", target: "gone", status: "absent" },
        { agent: "codex", target: "baz", status: "failed", message: "native verification failed" },
      ],
      unsupported: [{ agent: "cursor", reason: "cursor is write-only for activation" }],
    })).join("\n");

    expect(lines).toContain("changed   claude-code · foo · verified enabled");
    expect(lines).toContain("unchanged claude-code · bar · already enabled");
    expect(lines).toContain("absent    claude-code · gone");
    expect(lines).toContain("failed    codex · baz · native verification failed");
    expect(lines).toContain("unsupported cursor · cursor is write-only for activation");
    expect(lines).toContain("1 target(s) failed verification; nothing failed silently.");
  });

  test("planned dry-run rows never read as applied outcomes", () => {
    const lines = renderActivationResult(report({
      applied: false,
      results: [
        {
          agent: "claude-code",
          target: "foo",
          status: "enabled",
          planned: true,
          message: "dry-run; command was not run and nothing was verified",
        },
      ],
    })).join("\n");

    expect(lines).toContain("planned   claude-code · foo · would be enabled (dry-run, unverified)");
    expect(lines).not.toContain("verified enabled");
  });
});

describe("blocked/refused row tolerance", () => {
  test("preview blocked lines carry the actual reason, not a hardcoded label", () => {
    const lines = renderActivationPreview(report({
      targets: [
        // Read failure: unreadable client.
        { agent: "claude-code", plugin: "foo", present: false, unreadable: "registry file missing" },
        // Dry-run preflight refusal: readable client that refuses the command.
        {
          agent: "claude-code",
          plugin: "bar",
          present: true,
          currentlyEnabled: false,
          refusal: "grok cannot select a marketplace",
        },
      ],
    })).join("\n");

    expect(lines).toContain("blocked  claude-code · foo · registry file missing");
    expect(lines).toContain("blocked  claude-code · bar · grok cannot select a marketplace");
    expect(lines).not.toContain("cannot read plugins\n");
    const rows = activationPreviewRows(report({
      targets: [{ agent: "codex", plugin: "baz", present: true, currentlyEnabled: false, refusal: "no" }],
    }));
    expect(rows).toContainEqual({ kind: "blocked", agent: "codex", plugin: "baz", reason: "no" });
  });

  test("an unsupported apply result surfaces as a failure row, never dropped", () => {
    const rows = activationResultRows(report({
      results: [
        { agent: "cursor", target: "foo", status: "unsupported" },
        { agent: "opencode", target: "bar", status: "unsupported", message: "hook modules cannot be toggled" },
      ],
    }));
    expect(rows).toEqual([
      { kind: "failed", agent: "cursor", target: "foo", reason: "target does not support this activation operation" },
      { kind: "failed", agent: "opencode", target: "bar", reason: "hook modules cannot be toggled" },
    ]);
    const lines = renderActivationResult(report({
      results: [{ agent: "cursor", target: "foo", status: "unsupported" }],
    })).join("\n");
    expect(lines).toContain("failed    cursor · foo · target does not support this activation operation");
    expect(lines).toContain("1 target(s) failed verification; nothing failed silently.");
  });
});

describe("Claude scope choice vocabulary", () => {
  test("four options with auto first, mapping auto to no flag", () => {
    expect(CLAUDE_SCOPE_OPTIONS.map((option) => option.value)).toEqual([
      "auto",
      "user",
      "project",
      "local",
    ]);
    expect(claudeScopeChoice("auto")).toBeUndefined();
    expect(claudeScopeChoice("user")).toBe("user");
    expect(claudeScopeChoice("project")).toBe("project");
    expect(claudeScopeChoice("local")).toBe("local");
  });
});

describe("result row classification", () => {
  test("counts only real failures", () => {
    const rows = activationResultRows(report({
      results: [
        { agent: "claude-code", target: "a", status: "disabled" },
        { agent: "claude-code", target: "b", status: "failed", message: "boom" },
      ],
    }));
    expect(rows.filter((row) => row.kind === "failed")).toHaveLength(1);
  });
});
