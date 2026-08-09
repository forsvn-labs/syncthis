import { describe, expect, test } from "bun:test";
import { runPluginSyncFlow } from "../src/tui.ts";
import type { PluginReconcileResult } from "../src/plugins/reconcile.ts";
import { createArtifactKey } from "../src/plugins/artifact-key.ts";
import type { SyncReport } from "../src/sync.ts";

function report(dryRun: boolean): SyncReport {
  const result: PluginReconcileResult = {
    artifactKey: createArtifactKey({ id: "flow-plugin", fixture: "tui-flow" }),
    artifactId: "flow-plugin",
    plugin: "flow-plugin",
    agent: "codex",
    nativeMode: "verified",
    status: dryRun ? "would-install" : "installed",
    intent: "install",
    requestedName: "flow-plugin",
    degradation: { eligible: false, skills: false, mcp: false },
    outcome: "native",
  };
  return {
    ok: true,
    plugins: {
      dryRun,
      inventory: { artifacts: [], sources: [], errors: [] },
      results: [result],
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
    reads: [],
    union: {},
    conflicts: [],
    writes: [],
  };
}

describe("interactive Plugin Sync orchestration", () => {
  test("uses the unified runSync preview/apply contract without source or target selection", async () => {
    const calls: boolean[] = [];
    const lines: string[] = [];
    const result = await runPluginSyncFlow({
      runSync: async ({ dryRun }) => {
        calls.push(dryRun);
        return report(dryRun);
      },
      confirm: async () => true,
      render: (syncReport) => [syncReport.plugins.dryRun ? "preview" : "applied"],
      onLine: (line) => lines.push(line),
    });

    expect(calls).toEqual([true, false]);
    expect(lines).toEqual(["preview", "applied"]);
    expect(result.applied?.plugins.results[0]?.outcome).toBe("native");
  });

  test("does not apply when the preview is declined", async () => {
    const calls: boolean[] = [];
    const result = await runPluginSyncFlow({
      runSync: async ({ dryRun }) => {
        calls.push(dryRun);
        return report(dryRun);
      },
      confirm: async () => false,
      render: () => [],
      onLine: () => undefined,
    });

    expect(calls).toEqual([true]);
    expect(result.cancelled).toBe(true);
    expect(result.applied).toBeUndefined();
  });
});
