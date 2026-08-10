import { describe, expect, test } from "bun:test";
import {
  findAdapter as findRegisteredAdapter,
  listAgentIds as listRegisteredAgentIds,
} from "../src/adapters/index.ts";
import {
  computeUnion as computeMcpUnion,
  diffServers as diffMcpServers,
} from "../src/mcp-state.ts";
import { runPluginReconcile } from "../src/plugins/reconcile.ts";
import { pluginReconcileTargets } from "../src/plugins/targets.ts";
import * as sync from "../src/sync.ts";
import type { PluginInventoryArtifact } from "../src/plugins/inventory.ts";
import { createArtifactKey } from "../src/plugins/artifact-key.ts";

function artifact(): PluginInventoryArtifact {
  return {
    artifactKey: createArtifactKey({ id: "foo@plugins-cli", root: "fixture" }),
    id: "foo@plugins-cli",
    canonicalName: "foo",
    aliases: ["foo"],
    identityKeys: ["foo"],
    marketplaces: ["plugins-cli"],
    sourceRepo: "owner/foo",
    payload: {
      nativeManifest: true,
      skills: false,
      mcp: false,
    },
    installedOn: [],
    activeOn: [],
    configuredOn: [],
    catalogueOnly: false,
    eligible: true,
    evidence: [],
    errors: [],
  };
}

describe("lower-layer composition boundaries", () => {
  test("sync preserves its public utility exports as lower-layer aliases", () => {
    expect(sync.computeUnion).toBe(computeMcpUnion);
    expect(sync.diffServers).toBe(diffMcpServers);
    expect(sync.findAdapter).toBe(findRegisteredAdapter);
    expect(sync.listAgentIds).toBe(listRegisteredAgentIds);
    expect(sync.syncPluginTargets).toBe(pluginReconcileTargets);
  });

  test("the plugin target registry preserves canonical target IDs and modes", () => {
    expect(
      pluginReconcileTargets().map((target) => [
        target.agent,
        target.mode,
      ]),
    ).toEqual([
      ["claude-code", "verified"],
      ["codex", "verified"],
      ["github-copilot", "verified"],
      ["grok-build", "verified"],
      ["cursor", "write-only"],
      ["gemini-cli", "none"],
      ["kimi-cli", "none"],
      ["antigravity", "none"],
      ["windsurf", "none"],
      ["opencode", "none"],
      ["openclaw", "none"],
      ["hermes-agent", "none"],
      ["goose", "none"],
      ["pi", "none"],
      ["cline", "none"],
      ["prime-agent", "none"],
    ]);
  });

  test("the reconciler resolves Cursor through the write-only registry without mutating on dry-run", async () => {
    const report = await runPluginReconcile({
      dryRun: true,
      inventory: {
        artifacts: [artifact()],
        sources: [],
        errors: [],
      },
      targetAgents: ["cursor"],
    });

    expect(report.results).toEqual([
      expect.objectContaining({
        agent: "cursor",
        nativeMode: "write-only",
        status: "would-install",
      }),
    ]);
  });
});
