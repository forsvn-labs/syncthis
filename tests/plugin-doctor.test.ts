import { describe, expect, test } from "bun:test";
import { createArtifactKey } from "../src/plugins/artifact-key.ts";
import { doctorPreviewRunner, renderPluginDoctor, runPluginDoctor } from "../src/plugins/doctor-report.ts";
import type { PluginOverview } from "../src/plugins/overview.ts";
import { runSync, type SyncOptions, type SyncReport } from "../src/sync.ts";

function preview(): SyncReport {
  return {
    ok: false,
    plugins: {
      dryRun: true,
      inventory: { artifacts: [], sources: [], errors: [] },
      results: [
        {
          artifactKey: createArtifactKey({ fixture: "doctor", id: "alpha" }),
          artifactId: "alpha",
          plugin: "alpha",
          agent: "codex",
          nativeMode: "verified",
          status: "present",
          intent: "none",
          requestedName: "alpha",
          degradation: { eligible: false, skills: false, mcp: false },
          outcome: "native",
        },
        {
          artifactKey: createArtifactKey({ fixture: "doctor", id: "alpha" }),
          artifactId: "alpha",
          plugin: "alpha",
          agent: "cursor",
          nativeMode: "write-only",
          status: "failed",
          intent: "install",
          requestedName: "alpha",
          degradation: { eligible: false, skills: false, mcp: false },
          outcome: "blocked",
        },
      ],
      failures: [],
      hasFailures: true,
      hasChanges: true,
    },
    pluginDegradation: {
      dryRun: true,
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

describe("plugin doctor", () => {
  test("combines native inventory with canonical dry-run outcomes", async () => {
    const report = await runPluginDoctor({
      buildOverview: async () => ({
        native: [
          {
            agent: "codex",
            configPath: "/tmp/config.toml",
            exists: true,
            plugins: [{ name: "alpha", enabled: true }],
          },
        ],
      }),
      previewSync: async () => preview(),
    });

    expect(report.outcomes.native).toBe(1);
    expect(report.outcomes.blocked).toBe(1);
    expect(report.ok).toBe(false);
    const lines = renderPluginDoctor(report).join("\n");
    expect(lines).toContain("Sources: 1 readable");
    expect(lines).toContain("Outcomes: native 1 · blocked 1");
    expect(lines).toContain("Synchronization preview");
    expect(lines).toContain("native");
    expect(lines).toContain("blocked");
  });

  test("fails health when a native source is blocked even if sync preview is otherwise clean", async () => {
    const cleanPreview = preview();
    cleanPreview.ok = true;
    cleanPreview.plugins.hasFailures = false;

    const report = await runPluginDoctor({
      buildOverview: async () => ({
        native: [
          {
            agent: "codex",
            configPath: "/tmp/config.toml",
            exists: false,
            plugins: [],
            error: "registry unreadable",
          },
        ],
      }),
      previewSync: async () => cleanPreview,
    });

    expect(report.ok).toBe(false);
    expect(renderPluginDoctor(report).join("\n")).toContain("1 blocked");
  });
});

describe("doctor single-snapshot behavior", () => {
  test("runSync threads inventoryOptions into the reconciler", async () => {
    const sentinel = {
      agent: "codex" as const,
      configPath: "/tmp/sentinel.toml",
      exists: true,
      plugins: [],
    };
    let seen: unknown;
    await runSync({
      dryRun: true,
      inventoryOptions: { adapterReads: [sentinel] },
      reconcilePlugins: async (opts) => {
        seen = opts.inventoryOptions?.adapterReads;
        return {
          dryRun: true,
          inventory: { artifacts: [], sources: [], errors: [] },
          results: [],
          failures: [],
          hasFailures: false,
          hasChanges: false,
        };
      },
    });
    expect(seen).toEqual([sentinel]);
  });

  test("the doctor preview reuses the overview snapshot instead of rediscovering", async () => {
    const overview: PluginOverview = {
      native: [
        {
          agent: "codex",
          configPath: "/tmp/config.toml",
          exists: true,
          plugins: [{ name: "alpha", enabled: true }],
        },
      ],
    };
    // Default wiring: doctorPreviewRunner hands the overview's exact reads to
    // the sync runner, so one discovery pass drives overview + preview.
    const runs: SyncOptions[] = [];
    const run: typeof runSync = async (options = {}) => {
      runs.push(options);
      return preview();
    };
    await doctorPreviewRunner(overview, run)();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.inventoryOptions?.adapterReads).toBe(overview.native);
  });

  test("doctor performs exactly one overview build per report", async () => {
    let buildCalls = 0;
    let previewCalls = 0;
    await runPluginDoctor({
      buildOverview: async () => {
        buildCalls += 1;
        return {
          native: [
            {
              agent: "codex",
              configPath: "/tmp/config.toml",
              exists: true,
              plugins: [{ name: "alpha", enabled: true }],
            },
          ],
        } satisfies PluginOverview;
      },
      previewSync: async () => {
        previewCalls += 1;
        return preview();
      },
    });
    expect(buildCalls).toBe(1);
    expect(previewCalls).toBe(1);
  });
});
