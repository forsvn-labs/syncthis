import { describe, expect, test } from "bun:test";
import {
  handleControlCenterKey,
  type ControlCenterSnapshot,
} from "../src/cli/control-center-policy.ts";
import {
  renderUninstallPreview,
  renderUninstallResult,
} from "../src/cli/uninstall-presentation.ts";
import {
  applyNonHomeNavigate,
  persistThrownActionError,
} from "../src/control-center.tsx";
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

describe("thrown-action error persistence/gating", () => {
  test("normalize then setError before returning {ok:false}, so hasError arms", () => {
    let persisted: string | undefined;
    const result = persistThrownActionError(new Error("sync preview blew up"), (error) => {
      persisted = error;
    });

    expect(persisted).toBe("sync preview blew up");
    expect(result).toEqual({ ok: false, error: "sync preview blew up" });

    const gated = handleControlCenterKey(
      {
        screen: "sync-confirm",
        cursor: 0,
        offset: 0,
        loading: false,
        hasError: !!persisted,
        menuLength: 7,
        listLength: 0,
        selectedCount: 0,
        syncPreviewReady: true,
        syncApplyAvailable: true,
        removePreviewReady: false,
        removeApplyAvailable: false,
        configurePreviewReady: false,
        configureApplyAvailable: false,
        updatePlanReady: false,
        updateCompleted: false,
      } satisfies ControlCenterSnapshot,
      { input: "y" },
    );
    expect(gated).toBeUndefined();
  });
});

describe("non-home navigate cursor reset", () => {
  test("remove-plugins → remove-scope resets cursor to 0", () => {
    const command = handleControlCenterKey(
      {
        screen: "remove-plugins",
        cursor: 2,
        offset: 0,
        loading: false,
        hasError: false,
        menuLength: 7,
        listLength: 3,
        selectedCount: 2,
        syncPreviewReady: false,
        syncApplyAvailable: false,
        removePreviewReady: false,
        removeApplyAvailable: false,
        configurePreviewReady: false,
        configureApplyAvailable: false,
        updatePlanReady: false,
        updateCompleted: false,
      },
      { input: "", return: true },
    );
    expect(command).toEqual({ type: "navigate", screen: "remove-scope" });
    expect(applyNonHomeNavigate("remove-scope")).toEqual({
      screen: "remove-scope",
      cursor: 0,
      offset: 0,
    });
  });

  test("remove-scope → remove-agents resets cursor to 0", () => {
    const command = handleControlCenterKey(
      {
        screen: "remove-scope",
        cursor: 1,
        offset: 0,
        loading: false,
        hasError: false,
        menuLength: 7,
        listLength: 2,
        selectedCount: 0,
        syncPreviewReady: false,
        syncApplyAvailable: false,
        removePreviewReady: false,
        removeApplyAvailable: false,
        configurePreviewReady: false,
        configureApplyAvailable: false,
        updatePlanReady: false,
        updateCompleted: false,
      },
      { input: "", return: true },
    );
    expect(command).toEqual({ type: "navigate", screen: "remove-agents" });
    expect(applyNonHomeNavigate("remove-agents")).toEqual({
      screen: "remove-agents",
      cursor: 0,
      offset: 0,
    });
  });
});

describe("Ink control-center removal presentation", () => {
  test("shows exact scope, destructive work, kept ownership, conflicts, and blocks", () => {
    const lines = renderUninstallPreview(report()).join("\n");

    expect(lines).toContain("Remove alpha@mkt from 3 agent(s)");
    expect(lines).toContain("remove   claude-code · alpha@mkt · native");
    expect(lines).toContain("remove   opencode · alpha-skill · adapted content");
    expect(lines).toContain("keep     opencode · custom-server · modified conflict");
    expect(lines).toContain("keep     shared-skill · still provided by another plugin");
    expect(lines).toContain("blocked  cursor · removal is not readable or supported");
  });

  test("does not hide failed or unverifiable work in the result", () => {
    const lines = renderUninstallResult(report({
      applied: true,
      nativeResults: [
        {
          agent: "claude-code",
          target: "alpha@mkt",
          status: "failed",
          message: "native verification failed",
        },
      ],
      claudeReadError: "registry unreadable",
      requiredSkillAgents: ["opencode"],
    })).join("\n");

    expect(lines).toContain("blocked  claude-code · alpha@mkt · native verification failed");
    expect(lines).toContain("blocked  cursor · removal is not readable or supported");
    expect(lines).toContain("blocked  opencode · ownership could not be resolved");
    expect(lines).not.toContain("Nothing changed");
  });
});
