import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runPluginDegradation,
  type PluginDegradationDependencies,
} from "../src/plugins/degrade.ts";
import { createArtifactKey } from "../src/plugins/artifact-key.ts";
import type {
  PluginInventory,
  PluginInventoryArtifact,
} from "../src/plugins/inventory.ts";
import type {
  PluginDegradationDecision,
  PluginReconcileReport,
  PluginReconcileResult,
} from "../src/plugins/reconcile.ts";
import type { Adapter, AgentId, McpServer } from "../src/types.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-plugin-degrade-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function pluginArtifact(
  options: {
    id?: string;
    name?: string;
    sourceRepo?: string;
    local?: boolean;
    skills?: boolean;
    mcp?: Record<string, unknown>;
  } = {},
): Promise<PluginInventoryArtifact> {
  const name = options.name ?? "foo";
  const id = options.id ?? `${name}@plugins-cli`;
  const requestedRoot = options.local ? join(workDir, name) : undefined;
  if (requestedRoot) {
    await mkdir(join(requestedRoot, "skills", "one"), { recursive: true });
    await writeFile(join(requestedRoot, "skills", "one", "SKILL.md"), "---\nname: one\n---\n");
    if (options.mcp) {
      await writeFile(
        join(requestedRoot, ".mcp.json"),
        JSON.stringify({ mcpServers: options.mcp }),
      );
    }
  }
  const pluginRoot = requestedRoot ? await realpath(requestedRoot) : undefined;
  return {
    artifactKey: createArtifactKey({ id, pluginRoot, sourceRepo: options.sourceRepo }),
    id,
    canonicalName: name,
    aliases: [name],
    identityKeys: [name],
    marketplaces: ["plugins-cli"],
    sourceRepo: options.sourceRepo,
    pluginRoot,
    payload: {
      nativeManifest: true,
      skills: options.skills ?? true,
      mcp: !!options.mcp,
    },
    installedOn: [],
    activeOn: [],
    configuredOn: ["codex"],
    catalogueOnly: false,
    eligible: true,
    evidence: [
      {
        kind: "plugins-cli-catalogue",
        name,
        marketplace: "plugins-cli",
        path: pluginRoot,
      },
    ],
    errors: [],
  };
}

const ELIGIBLE_NONE: PluginDegradationDecision = {
  eligible: true,
  reason: "no-native-abi",
  skills: true,
  mcp: true,
};

function outcome(
  artifact: PluginInventoryArtifact,
  agent: AgentId,
  overrides: Partial<PluginReconcileResult> = {},
): PluginReconcileResult {
  return {
    artifactKey: artifact.artifactKey,
    artifactId: artifact.id,
    plugin: artifact.canonicalName,
    agent,
    nativeMode: "none",
    status: "unsupported",
    intent: "install",
    requestedName: artifact.canonicalName,
    degradation: {
      ...ELIGIBLE_NONE,
      skills: artifact.payload.skills,
      mcp: artifact.payload.mcp,
    },
    ...overrides,
  };
}

function reconcile(
  artifacts: PluginInventoryArtifact[],
  results: PluginReconcileResult[],
  dryRun = false,
): PluginReconcileReport {
  const inventory: PluginInventory = { artifacts, sources: [], errors: [] };
  return {
    dryRun,
    inventory,
    results,
    failures: results.filter((item) => item.status === "failed"),
    hasFailures: results.some((item) => item.status === "failed"),
    hasChanges: results.some((item) => item.degradation.eligible),
  };
}

function adapter(
  agent: AgentId,
  initial: Record<string, McpServer>,
  writes: Array<Record<string, McpServer>>,
  readError?: string,
): Adapter {
  return {
    id: agent,
    targetPath: () => `/tmp/${agent}.json`,
    async read() {
      return {
        agent,
        path: `/tmp/${agent}.json`,
        exists: true,
        servers: { ...initial },
        error: readError,
      };
    },
    async write(servers, opts) {
      if (!opts.dryRun) writes.push(structuredClone(servers));
      return {
        agent,
        path: `/tmp/${agent}.json`,
        status: opts.dryRun ? "unchanged" : "synced",
      };
    },
  };
}

describe("targeted plugin degradation", () => {
  test("degrades an unsupported native format only onto that exact target", async () => {
    const item = await pluginArtifact({
      local: true,
      sourceRepo: "owner/foo",
      mcp: {
        newServer: { command: "new" },
        conflict: { command: "plugin" },
      },
    });
    const writes: Array<Record<string, McpServer>> = [];
    const skillCalls: Array<{ sources: string[]; agents: AgentId[]; dryRun: boolean }> = [];
    const deps: PluginDegradationDependencies = {
      async addSkillSources(sources, agents, opts) {
        skillCalls.push({ sources, agents: [...agents], dryRun: !!opts.dryRun });
        return sources.map((source) => ({ repo: source, status: "added" }));
      },
      findMcpAdapter(agent) {
        return agent === "codex"
          ? adapter("codex", { conflict: { command: "existing" }, keep: { command: "keep" } }, writes)
          : undefined;
      },
    };
    const report = await runPluginDegradation({
      reconcile: reconcile([
        item,
      ], [
        outcome(item, "codex", {
          nativeMode: "verified",
          degradation: {
            eligible: true,
            reason: "unsupported-format",
            skills: true,
            mcp: true,
          },
        }),
      ]),
      dependencies: deps,
    });

    expect(skillCalls).toEqual([
      { sources: ["owner/foo"], agents: ["codex"], dryRun: false },
    ]);
    expect(writes).toEqual([
      {
        conflict: { command: "existing" },
        keep: { command: "keep" },
        newServer: { command: "new" },
      },
    ]);
    expect(report.results).toEqual([
      expect.objectContaining({
        component: "skills",
        agent: "codex",
        artifactId: item.id,
        status: "added",
      }),
      expect.objectContaining({
        component: "mcp",
        agent: "codex",
        artifactId: item.id,
        status: "added",
        added: ["newServer"],
        conflicts: ["conflict"],
      }),
    ]);
    expect(report.hasFailures).toBe(false);
    expect(report.hasChanges).toBe(true);
  });

  test("never degrades present, planned, unverified write-only, or hard-failed native outcomes", async () => {
    const item = await pluginArtifact({ sourceRepo: "owner/foo" });
    const calls: string[] = [];
    const forged = {
      eligible: true,
      reason: "unsupported-format" as const,
      skills: true,
      mcp: false,
    };
    const results: PluginReconcileResult[] = [
      outcome(item, "codex", { nativeMode: "verified", status: "present", degradation: forged }),
      outcome(item, "kimi-cli", { nativeMode: "verified", status: "would-install", degradation: forged }),
      outcome(item, "cursor", { nativeMode: "write-only", status: "unverified", degradation: forged }),
      outcome(item, "github-copilot", { nativeMode: "verified", status: "failed", degradation: forged }),
    ];

    const report = await runPluginDegradation({
      reconcile: reconcile([item], results),
      dependencies: {
        async addSkillSources() {
          calls.push("skills");
          return [];
        },
        findMcpAdapter() {
          calls.push("mcp");
          return undefined;
        },
      },
    });

    expect(calls).toEqual([]);
    expect(report.eligibleOutcomes).toEqual([]);
    expect(report.results).toEqual([]);
    expect(report.hasChanges).toBe(false);
    expect(report.hasFailures).toBe(false);
  });

  test("Pi receives bundled skills only and is never fanned out to MCP runtimes", async () => {
    const item = await pluginArtifact({
      sourceRepo: "owner/foo",
      mcp: { bundled: { command: "bun" } },
    });
    const skillTargets: AgentId[][] = [];
    let adapterLookups = 0;

    const report = await runPluginDegradation({
      reconcile: reconcile([item], [outcome(item, "pi")]),
      dependencies: {
        async addSkillSources(sources, agents) {
          expect(sources).toEqual(["owner/foo"]);
          skillTargets.push([...agents]);
          return [{ repo: "owner/foo", status: "added" }];
        },
        findMcpAdapter() {
          adapterLookups += 1;
          return undefined;
        },
      },
    });

    expect(skillTargets).toEqual([["pi"]]);
    expect(adapterLookups).toBe(0);
    expect(report.results.map((item) => item.component)).toEqual(["skills"]);
  });

  test("can suppress loose skills while retaining exact MCP degradation", async () => {
    const item = await pluginArtifact({
      local: true,
      mcp: { bundled: { command: "bun" } },
    });
    const writes: Array<Record<string, McpServer>> = [];
    let skillCalls = 0;

    const report = await runPluginDegradation({
      reconcile: reconcile([item], [outcome(item, "gemini-cli")], true),
      includeSkills: false,
      dependencies: {
        async addSkillSources() {
          skillCalls += 1;
          return [];
        },
        findMcpAdapter(agent) {
          return adapter(agent, {}, writes);
        },
      },
    });

    expect(skillCalls).toBe(0);
    expect(report.results).toEqual([
      expect.objectContaining({
        component: "skills",
        status: "skipped",
        message: "suppressed (--no-skills)",
      }),
      expect.objectContaining({
        component: "mcp",
        status: "would-add",
        added: ["bundled"],
      }),
    ]);
  });

  test("production skill routing accepts safe repos and validated Plugins CLI roots", async () => {
    const local = await pluginArtifact({
      id: "local@plugins-cli",
      name: "local",
      local: true,
    });
    const remote = await pluginArtifact({
      id: "remote@plugins-cli",
      name: "remote",
      sourceRepo: "owner/remote",
    });

    const report = await runPluginDegradation({
      reconcile: reconcile(
        [local, remote],
        [outcome(local, "pi"), outcome(remote, "pi")],
        true,
      ),
    });

    expect(report.results).toEqual([
      expect.objectContaining({
        artifactId: local.id,
        component: "skills",
        source: local.pluginRoot,
        status: "would-add",
      }),
      expect.objectContaining({
        artifactId: remote.id,
        component: "skills",
        source: "owner/remote",
        status: "would-add",
      }),
    ]);
  });

  test("same display IDs resolve by artifactKey without target/order coupling", async () => {
    const first = await pluginArtifact({
      id: "duplicate@plugins-cli",
      name: "duplicate",
      local: true,
    });
    const secondRoot = join(workDir, "duplicate-second");
    await mkdir(join(secondRoot, "skills", "two"), { recursive: true });
    await writeFile(
      join(secondRoot, "skills", "two", "SKILL.md"),
      "---\nname: two\n---\n",
    );
    const secondCanonicalRoot = await realpath(secondRoot);
    const second: PluginInventoryArtifact = {
      ...first,
      artifactKey: createArtifactKey({
        id: first.id,
        pluginRoot: secondCanonicalRoot,
      }),
      pluginRoot: secondCanonicalRoot,
      sourcePluginPath: secondCanonicalRoot,
      evidence: [{
        kind: "plugins-cli-catalogue",
        name: "duplicate",
        marketplace: "plugins-cli",
        path: secondCanonicalRoot,
      }],
    };
    const calls: Array<{ source: string; agent: AgentId }> = [];

    const report = await runPluginDegradation({
      reconcile: reconcile(
        [first, second],
        [outcome(second, "opencode"), outcome(first, "gemini-cli")],
        true,
      ),
      dependencies: {
        async addSkillSources(sources, agents) {
          calls.push({ source: sources[0]!, agent: agents[0]! });
          return [{ repo: sources[0]!, status: "added", message: "dry-run" }];
        },
      },
    });

    expect(calls).toEqual([
      { source: secondCanonicalRoot, agent: "opencode" },
      { source: first.pluginRoot!, agent: "gemini-cli" },
    ]);
    expect(report.results.map((result) => result.artifactKey)).toEqual([
      second.artifactKey,
      first.artifactKey,
    ]);
  });

  test("dry-run reports exact planned writes without mutating MCP state", async () => {
    const item = await pluginArtifact({
      local: true,
      mcp: { bundled: { command: "bun" } },
    });
    const writes: Array<Record<string, McpServer>> = [];
    const dryRuns: boolean[] = [];

    const report = await runPluginDegradation({
      reconcile: reconcile([item], [outcome(item, "gemini-cli")], true),
      dependencies: {
        async addSkillSources(sources, _agents, opts) {
          dryRuns.push(!!opts.dryRun);
          return sources.map((source) => ({ repo: source, status: "added", message: "dry-run" }));
        },
        findMcpAdapter(agent) {
          return adapter(agent, {}, writes);
        },
      },
    });

    expect(dryRuns).toEqual([true]);
    expect(writes).toEqual([]);
    expect(report.results).toEqual([
      expect.objectContaining({ component: "skills", status: "would-add" }),
      expect.objectContaining({ component: "mcp", status: "would-add", added: ["bundled"] }),
    ]);
    expect(report.hasChanges).toBe(true);
  });

  test("is additive and idempotent when skills and MCP are already present", async () => {
    const item = await pluginArtifact({
      local: true,
      mcp: { bundled: { command: "bun" } },
    });
    const writes: Array<Record<string, McpServer>> = [];

    const report = await runPluginDegradation({
      reconcile: reconcile([item], [outcome(item, "gemini-cli")]),
      dependencies: {
        async addSkillSources(sources) {
          return sources.map((source) => ({
            repo: source,
            status: "skipped",
            message: "already synced",
          }));
        },
        findMcpAdapter(agent) {
          return adapter(agent, { bundled: { command: "bun" } }, writes);
        },
      },
    });

    expect(writes).toEqual([]);
    expect(report.results).toEqual([
      expect.objectContaining({ component: "skills", status: "unchanged" }),
      expect.objectContaining({ component: "mcp", status: "unchanged", added: [] }),
    ]);
    expect(report.hasChanges).toBe(false);
  });

  test("isolates per-target errors and rejects unvalidated local roots", async () => {
    const localOnly = await pluginArtifact({ local: true, skills: true });
    localOnly.pluginRoot = join(workDir, "missing-local-root");
    const remote = await pluginArtifact({
      id: "remote@plugins-cli",
      name: "remote",
      sourceRepo: "owner/remote",
      mcp: { remote: { command: "bun" } },
    });
    const calls: string[] = [];

    const report = await runPluginDegradation({
      reconcile: reconcile(
        [localOnly, remote],
        [outcome(localOnly, "gemini-cli"), outcome(remote, "opencode")],
      ),
      dependencies: {
        async addSkillSources(sources, agents) {
          calls.push(`${agents[0]}:${sources[0]}`);
          if (agents[0] === "opencode") throw new Error("skills exploded");
          return sources.map((source) => ({ repo: source, status: "added" }));
        },
        findMcpAdapter(agent) {
          return adapter(agent, {}, [], "broken MCP config");
        },
      },
    });

    expect(calls).toEqual(["opencode:owner/remote"]);
    expect(report.results).toEqual([
      expect.objectContaining({
        artifactId: localOnly.id,
        component: "skills",
        status: "failed",
        message: expect.stringContaining("local plugin source"),
      }),
      expect.objectContaining({
        artifactId: remote.id,
        component: "skills",
        status: "failed",
        message: "skills exploded",
      }),
      expect.objectContaining({
        artifactId: remote.id,
        component: "mcp",
        status: "failed",
        message: expect.stringContaining("validated local plugin root"),
      }),
    ]);
    expect(report.failures).toHaveLength(3);
    expect(report.hasFailures).toBe(true);
  });
});
