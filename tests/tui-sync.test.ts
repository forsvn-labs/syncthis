import { describe, expect, test } from "bun:test";
import {
  handleControlCenterKey,
  type ControlCenterSnapshot,
} from "../src/cli/control-center-policy.ts";
import { renderPluginSyncReport } from "../src/cli/plugin-outcomes.ts";

// The old src/tui.ts sync-flow contract, re-expressed against the pure screen
// policy: preview first, explicit confirm, one apply, and never a second apply
// offer after the result exists. Rendering uses the real shared report renderer.
function report(dryRun: boolean) {
  return {
    ok: true,
    plugins: {
      dryRun,
      inventory: { artifacts: [], sources: [], errors: [] },
      results: [],
      failures: [],
      hasFailures: false,
      hasChanges: true,
    },
    pluginDegradation: {
      dryRun,
      eligibleOutcomes: [],
      results: [],
      failures: [],
      hasFailures: false,
      hasChanges: false,
    },
  } as const;
}

function snapshot(overrides: Partial<ControlCenterSnapshot> = {}): ControlCenterSnapshot {
  return {
    screen: "sync-preview",
    cursor: 0,
    offset: 0,
    loading: false,
    hasError: false,
    menuLength: 6,
    listLength: 0,
    selectedCount: 0,
    syncPreviewReady: true,
    syncApplyAvailable: true,
    removePreviewReady: false,
    removeApplyAvailable: false,
    updatePlanReady: false,
    updateCompleted: false,
    ...overrides,
  };
}

describe("interactive sync flow policy", () => {
  test("previews the complete set, confirms separately, applies once", () => {
    const preview = report(true);
    // The rendered preview is exactly what the shared renderer produces.
    expect(renderPluginSyncReport(preview as never)).toContain("no installed plugins discovered");

    const tasks: string[] = [];
    let screen = snapshot().screen;
    const step = (input: string) => {
      const command = handleControlCenterKey(snapshot({ screen }), { input });
      if (command?.type === "run") tasks.push(command.task);
      if (command?.type === "navigate") screen = command.screen;
    };
    step("a");
    step("y");
    expect(tasks).toEqual(["apply-sync"]);
    // Apply runs from the confirm state; the component alone moves to the
    // explicit result screen once the action returns.
    expect(screen).toBe("sync-confirm");
  });

  test("declining the confirmation leaves the preview untouched", () => {
    let screen = snapshot().screen;
    const command = handleControlCenterKey(snapshot({ screen }), { input: "n" });
    if (command?.type === "navigate") screen = command.screen;
    expect(screen).toBe("sync-preview");
  });

  test("the applied result cannot trigger a hidden reapply", () => {
    const result = snapshot({ screen: "sync-result", syncApplyAvailable: true });
    expect(handleControlCenterKey(result, { input: "a" })).toBeUndefined();
    expect(handleControlCenterKey(result, { input: "y", return: true })).toBeUndefined();
  });

  test("non-TTY-style empty input never applies anything", () => {
    expect(handleControlCenterKey(snapshot(), { input: "" })).toBeUndefined();
    expect(handleControlCenterKey(snapshot({ screen: "sync-confirm" }), { input: "" })).toBeUndefined();
  });
});
