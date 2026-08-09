import { describe, expect, test } from "bun:test";
import {
  canonicalOutcome,
  composePluginOutcomes,
  nativeOutcome,
  projectionOutcome,
} from "../src/plugins/outcome.ts";
import {
  formatPluginOutcome,
  pluginOutcomeRows,
  renderPluginSyncReport,
} from "../src/cli/plugin-outcomes.ts";
import { createArtifactKey } from "../src/plugins/artifact-key.ts";
import type { PluginReconcileResult } from "../src/plugins/reconcile.ts";

function presentationReport(results: PluginReconcileResult[]) {
  return {
    ok: true,
    plugins: {
      dryRun: false,
      inventory: { artifacts: [], sources: [], errors: [] },
      results,
      failures: [],
      hasFailures: false,
      hasChanges: true,
    },
    pluginDegradation: {
      dryRun: false,
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

describe("canonical plugin outcomes", () => {
  test("maps retained native detail without erasing it", () => {
    expect(nativeOutcome({ status: "present", nativeMode: "verified" })).toBe("native");
    expect(nativeOutcome({ status: "installed", nativeMode: "verified" })).toBe("native");
    expect(nativeOutcome({ status: "unverified", nativeMode: "write-only" })).toBe("adapted");
    expect(nativeOutcome({ status: "unsupported", nativeMode: "none" })).toBe("unsupported");
    expect(nativeOutcome({ status: "failed", nativeMode: "verified" })).toBe("blocked");
  });

  test("maps projection detail and combines pure results", () => {
    expect(projectionOutcome([{ status: "added", component: "skills" }])).toBe("adapted");
    expect(projectionOutcome([{ status: "failed", component: "mcp" }])).toBe("blocked");
    expect(projectionOutcome([{ status: "unchanged", component: "mcp" }])).toBe("unsupported");
    expect(
      projectionOutcome([
        { status: "added", component: "skills" },
        { status: "unchanged", component: "mcp", unresolved: true },
      ]),
    ).toBe("partial");
    expect(
      canonicalOutcome(
        { status: "unsupported", nativeMode: "none" },
        [
          { status: "added", component: "skills" },
          { status: "failed", component: "mcp" },
        ],
      ),
    ).toBe("partial");
    expect(
      canonicalOutcome(
        { status: "unsupported", nativeMode: "none" },
        [{ status: "added", component: "skills" }],
      ),
    ).toBe("adapted");
  });

  test("renders exactly one canonical row for every public outcome", () => {
    const outcomes = ["native", "adapted", "partial", "blocked", "unsupported"] as const;
    const results: PluginReconcileResult[] = outcomes.map((outcome, index) => ({
      artifactKey: createArtifactKey({ id: `presentation-${index}`, fixture: "presentation" }),
      artifactId: `presentation-${index}`,
      plugin: `plugin-${index}`,
      agent: "codex",
      nativeMode: outcome === "adapted" ? "write-only" : outcome === "unsupported" ? "none" : "verified",
      status: outcome === "blocked" ? "failed" : outcome === "unsupported" ? "unsupported" : "present",
      intent: outcome === "native" ? "none" : "install",
      requestedName: `plugin-${index}`,
      degradation: { eligible: false, skills: false, mcp: false },
      outcome,
    }));
    const report = presentationReport(results);
    expect(pluginOutcomeRows(report).map((row) => row.outcome)).toEqual([...outcomes]);
    expect(renderPluginSyncReport(report).map((line) => line.trimStart().split(/\s+/)[0])).toEqual([...outcomes]);
  });

  test("does not promote unresolved detail to a success category", () => {
    const result: PluginReconcileResult = {
      artifactKey: createArtifactKey({ id: "unresolved", fixture: "presentation" }),
      artifactId: "unresolved",
      plugin: "unresolved",
      agent: "gemini-cli",
      nativeMode: "none",
      status: "unsupported",
      intent: "install",
      requestedName: "unresolved",
      message: "conflicting projection remains unresolved",
      degradation: { eligible: true, reason: "no-native-abi", skills: true, mcp: true },
    };
    const row = pluginOutcomeRows(presentationReport([result]))[0]!;
    expect(row.outcome).toBe("unsupported");
    expect(formatPluginOutcome(row)).toMatch(/^unsupported\s/);
    expect(formatPluginOutcome(row)).not.toMatch(/^native|^adapted/);
  });

  test("composes final adapted and partial outcomes after degradation", () => {
    const artifactKey = createArtifactKey({ id: "foo", fixture: "outcome" });
    const native: PluginReconcileResult = {
      artifactKey,
      artifactId: "foo",
      plugin: "foo",
      agent: "gemini-cli",
      nativeMode: "none",
      status: "unsupported",
      intent: "install",
      requestedName: "foo",
      degradation: { eligible: true, reason: "no-native-abi", skills: true, mcp: true },
    };
    const adapted = composePluginOutcomes([native], [
      { artifactKey, artifactId: "foo", plugin: "foo", agent: "gemini-cli", reason: "no-native-abi", component: "skills", status: "added", reachProven: true },
      { artifactKey, artifactId: "foo", plugin: "foo", agent: "gemini-cli", reason: "no-native-abi", component: "mcp", status: "unchanged", reachProven: true },
    ]);
    expect(adapted[0]?.outcome).toBe("adapted");

    const partial = composePluginOutcomes([native], [
      { artifactKey, artifactId: "foo", plugin: "foo", agent: "gemini-cli", reason: "no-native-abi", component: "skills", status: "added", reachProven: true },
      { artifactKey, artifactId: "foo", plugin: "foo", agent: "gemini-cli", reason: "no-native-abi", component: "mcp", status: "failed" },
    ]);
    expect(partial[0]?.outcome).toBe("partial");

    const unresolved = composePluginOutcomes([native], [
      { artifactKey, artifactId: "foo", plugin: "foo", agent: "gemini-cli", reason: "no-native-abi", component: "mcp", status: "unchanged", conflicts: ["foo"], unresolved: true },
    ]);
    expect(unresolved[0]?.outcome).toBe("unsupported");
  });
});
