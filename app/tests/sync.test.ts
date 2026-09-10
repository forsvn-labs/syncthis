import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as TOML from "smol-toml";
import { adapters } from "../src/adapters/index.ts";
import { createJsonMcpAdapter } from "../src/adapters/json-mcp.ts";
import { codexAdapter } from "../src/adapters/codex.ts";
import { computeUnion } from "../src/mcp-state.ts";
import {
  runDirectional,
  runFanOut,
  runRemove,
  runSelectiveMcpSync,
} from "../src/sync.ts";
import { runDoctor } from "../src/doctor.ts";
import type { McpServer } from "../src/types.ts";
import {
  BIGQUERY,
  HTTP,
  STDIO,
  degradationReport,
  pluginReport,
  runSync,
  setupSyncTestEnvironment,
  writeAgentJson,
  writeCodexToml,
  type SyncTestEnvironment,
} from "./sync-fixtures.ts";

let workDir: string;
let testEnvironment: SyncTestEnvironment;

beforeEach(async () => {
  testEnvironment = await setupSyncTestEnvironment();
  workDir = testEnvironment.workDir;
});

afterEach(async () => {
  await testEnvironment.restore();
});

describe("computeUnion", () => {
  test("merges servers from multiple agents", () => {
    const reads = [
      { agent: "claude-code" as const, path: "", exists: true, servers: { gh: STDIO } as Record<string, McpServer> },
      { agent: "cursor" as const, path: "", exists: true, servers: { lin: HTTP } as Record<string, McpServer> },
      { agent: "codex" as const, path: "", exists: true, servers: {} as Record<string, McpServer> },
      { agent: "gemini-cli" as const, path: "", exists: true, servers: {} as Record<string, McpServer> },
    ];
    const { union, conflicts } = computeUnion(reads);
    expect(Object.keys(union).sort()).toEqual(["gh", "lin"]);
    expect(conflicts).toEqual([]);
  });

  test("flags conflicts when same name has different configs", () => {
    const v1: McpServer = { type: "stdio", command: "a" };
    const v2: McpServer = { type: "stdio", command: "b" };
    const reads = [
      { agent: "claude-code" as const, path: "", exists: true, servers: { dup: v1 } as Record<string, McpServer> },
      { agent: "cursor" as const, path: "", exists: true, servers: { dup: v2 } as Record<string, McpServer> },
      { agent: "codex" as const, path: "", exists: true, servers: {} as Record<string, McpServer> },
      { agent: "gemini-cli" as const, path: "", exists: true, servers: {} as Record<string, McpServer> },
    ];
    const { union, conflicts } = computeUnion(reads);
    expect(union).toEqual({});
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.name).toBe("dup");
    expect(conflicts[0]!.versions.map((v) => v.agent).sort()).toEqual(["claude-code", "cursor"]);
  });

  test("treats same-url sse/http as one server (transport not part of identity)", () => {
    const sse: McpServer = { type: "sse", url: "https://x.test/mcp" };
    const http: McpServer = { type: "http", url: "https://x.test/mcp" };
    const reads = [
      { agent: "cursor" as const, path: "", exists: true, servers: { s: sse } as Record<string, McpServer> },
      { agent: "hermes-agent" as const, path: "", exists: true, servers: { s: http } as Record<string, McpServer> },
    ];
    const { union, conflicts } = computeUnion(reads);
    expect(conflicts).toEqual([]);
    expect(Object.keys(union)).toEqual(["s"]);
    // But a genuinely different URL is still a conflict.
    const reads2 = [
      { agent: "cursor" as const, path: "", exists: true, servers: { s: sse } as Record<string, McpServer> },
      { agent: "hermes-agent" as const, path: "", exists: true, servers: { s: { type: "http", url: "https://y.test/mcp" } as McpServer } },
    ];
    expect(computeUnion(reads2).conflicts).toHaveLength(1);
  });

  test("treats key-order differences as same config (canonicalized)", () => {
    const a: McpServer = { type: "stdio", command: "x", args: ["1"] };
    const b: McpServer = { args: ["1"], command: "x", type: "stdio" };
    const reads = [
      { agent: "claude-code" as const, path: "", exists: true, servers: { same: a } as Record<string, McpServer> },
      { agent: "cursor" as const, path: "", exists: true, servers: { same: b } as Record<string, McpServer> },
      { agent: "codex" as const, path: "", exists: true, servers: {} as Record<string, McpServer> },
      { agent: "gemini-cli" as const, path: "", exists: true, servers: {} as Record<string, McpServer> },
    ];
    const { conflicts } = computeUnion(reads);
    expect(conflicts).toEqual([]);
  });
});

describe("json-mcp adapter", () => {
  test("read returns empty servers when file missing", async () => {
    const adapter = createJsonMcpAdapter({ id: "claude-code", path: join(workDir, "nope.json") });
    const r = await adapter.read();
    expect(r.exists).toBe(false);
    expect(r.servers).toEqual({});
  });

  test("read returns servers from existing file", async () => {
    const path = join(workDir, "config.json");
    await Bun.write(path, JSON.stringify({ mcpServers: { gh: STDIO } }));
    const adapter = createJsonMcpAdapter({ id: "cursor", path });
    const r = await adapter.read();
    expect(r.exists).toBe(true);
    expect(r.servers).toEqual({ gh: STDIO });
  });

  test("write preserves non-mcpServers keys", async () => {
    const path = join(workDir, "config.json");
    await Bun.write(path, JSON.stringify({ security: { auth: { selectedType: "oauth" } } }));
    const adapter = createJsonMcpAdapter({ id: "gemini-cli", path });
    const result = await adapter.write({ gh: STDIO }, { dryRun: false });
    expect(result.status).toBe("synced");
    const written = JSON.parse(await Bun.file(path).text());
    expect(written.security).toEqual({ auth: { selectedType: "oauth" } });
    expect(written.mcpServers).toEqual({ gh: STDIO });
  });

  test("write returns 'unchanged' when content matches", async () => {
    const path = join(workDir, "config.json");
    const adapter = createJsonMcpAdapter({ id: "cursor", path });
    await adapter.write({ gh: STDIO }, { dryRun: false });
    const r2 = await adapter.write({ gh: STDIO }, { dryRun: false });
    expect(r2.status).toBe("unchanged");
  });

  test("write dry-run does not write", async () => {
    const path = join(workDir, "config.json");
    const adapter = createJsonMcpAdapter({ id: "cursor", path });
    const r = await adapter.write({ gh: STDIO }, { dryRun: true });
    expect(r.status).toBe("synced");
    expect(r.message).toBe("dry-run");
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("write creates .syncthis.bak on first write", async () => {
    const path = join(workDir, "config.json");
    await Bun.write(path, JSON.stringify({ mcpServers: { old: { command: "x" } } }));
    const adapter = createJsonMcpAdapter({ id: "cursor", path });
    await adapter.write({ gh: STDIO }, { dryRun: false });
    const bak = JSON.parse(await Bun.file(`${path}.syncthis.bak`).text());
    expect(bak.mcpServers.old).toBeDefined();
  });
});

describe("codex adapter (TOML)", () => {
  test("read parses mcp_servers", async () => {
    await writeCodexToml(workDir, { gh: STDIO, lin: HTTP });
    const r = await codexAdapter.read();
    expect(r.exists).toBe(true);
    expect(Object.keys(r.servers).sort()).toEqual(["gh", "lin"]);
    expect(r.servers.gh).toMatchObject({ type: "stdio", command: "npx" });
    expect(r.servers.lin).toMatchObject({ type: "http", url: "https://mcp.linear.app/sse" });
  });

  test("write preserves non-mcp_servers sections", async () => {
    await writeCodexToml(workDir, {}, '[tui]\nstatus_line = ["a"]\n\n[projects."/x"]\ntrust_level = "trusted"\n\n');
    await codexAdapter.write({ gh: STDIO }, { dryRun: false });
    const text = await Bun.file(codexAdapter.targetPath()).text();
    const parsed = TOML.parse(text) as Record<string, unknown>;
    expect((parsed.tui as { status_line: string[] }).status_line).toEqual(["a"]);
    expect(parsed.projects).toBeDefined();
    expect((parsed.mcp_servers as Record<string, unknown>).gh).toBeDefined();
  });

  test("write returns 'unchanged' when content matches", async () => {
    await codexAdapter.write({ gh: STDIO }, { dryRun: false });
    const r = await codexAdapter.write({ gh: STDIO }, { dryRun: false });
    expect(r.status).toBe("unchanged");
  });
});

describe("runSync (plugin-only root)", () => {
  test("root sync runs plugin reconciliation and targeted degradation only", async () => {
    await writeAgentJson(workDir, ".claude.json", { gh: STDIO });
    const events: string[] = [];

    const report = await runSync({
      reconcilePlugins: async ({ dryRun }) => {
        events.push("plugins");
        expect(dryRun).toBe(false);
        return pluginReport();
      },
      degradePlugins: async ({ includeSkills, includeMcp }) => {
        events.push("degrade");
        expect(includeSkills).toBe(true);
        expect(includeMcp).toBe(true);
        return degradationReport();
      },
    });

    expect(events).toEqual(["plugins", "degrade"]);
    expect(report.reads).toEqual([]);
    expect(report.union).toEqual({});
    expect(report.conflicts).toEqual([]);
    expect(report.writes).toEqual([]);
    expect(report.pluginSkills).toBeUndefined();
    expect(report.skills).toBeUndefined();
    expect(await Bun.file(join(workDir, ".cursor", "mcp.json")).exists()).toBe(false);
  });

  test("skipBridge suppresses targeted degradation but still reconciles plugins", async () => {
    let reconciled = false;
    let degraded = false;
    const report = await runSync({
      skipBridge: true,
      reconcilePlugins: async () => {
        reconciled = true;
        return pluginReport();
      },
      degradePlugins: async () => {
        degraded = true;
        return degradationReport();
      },
    });

    expect(reconciled).toBe(true);
    expect(degraded).toBe(false);
    expect(report.pluginDegradation.results).toEqual([]);
    expect(report.pluginDegradation.dryRun).toBe(false);
    expect(report.reads).toEqual([]);
    expect(report.union).toEqual({});
    expect(report.writes).toEqual([]);
    expect(report.skills).toBeUndefined();
  });

  test("deprecated --no-skills suppresses all targeted degradation", async () => {
    let degraded = false;
    const report = await runSync({
      dryRun: true,
      skipSkills: true,
      reconcilePlugins: async () => pluginReport(),
      degradePlugins: async () => {
        degraded = true;
        return degradationReport();
      },
    });

    expect(degraded).toBe(false);
    expect(report.pluginDegradation.results).toEqual([]);
    expect(report.pluginDegradation.dryRun).toBe(true);
    expect(report.reads).toEqual([]);
    expect(report.union).toEqual({});
    expect(report.writes).toEqual([]);
    expect(report.skills).toBeUndefined();
  });

  test("dry-run passes through plugin work without legacy MCP writes", async () => {
    let reconcileDryRun = false;
    let degradeDryRun = false;
    const report = await runSync({
      dryRun: true,
      reconcilePlugins: async ({ dryRun }) => {
        reconcileDryRun = dryRun;
        return { ...pluginReport(), dryRun };
      },
      degradePlugins: async ({ reconcile }) => {
        degradeDryRun = reconcile.dryRun;
        return degradationReport([], true);
      },
    });

    expect(reconcileDryRun).toBe(true);
    expect(degradeDryRun).toBe(true);
    expect(report.plugins.dryRun).toBe(true);
    expect(report.pluginDegradation.dryRun).toBe(true);
    expect(report.reads).toEqual([]);
    expect(report.union).toEqual({});
    expect(report.conflicts).toEqual([]);
    expect(report.writes).toEqual([]);
    expect(report.skills).toBeUndefined();
  });

  test("root sync leaves existing MCP configs untouched", async () => {
    await writeAgentJson(workDir, ".claude.json", { gh: STDIO });
    await writeAgentJson(workDir, ".cursor/mcp.json", { lin: HTTP });
    const claudeBefore = await Bun.file(join(workDir, ".claude.json")).text();
    const cursorBefore = await Bun.file(join(workDir, ".cursor", "mcp.json")).text();

    const report = await runSync({
      reconcilePlugins: async () => pluginReport(),
      degradePlugins: async () => degradationReport(),
    });

    expect(report.reads).toEqual([]);
    expect(report.union).toEqual({});
    expect(report.conflicts).toEqual([]);
    expect(report.writes).toEqual([]);
    expect(await Bun.file(join(workDir, ".claude.json")).text()).toBe(claudeBefore);
    expect(await Bun.file(join(workDir, ".cursor", "mcp.json")).text()).toBe(cursorBefore);
  });


  test("directional sync refuses to apply when source cannot be read", async () => {
    await Bun.write(join(workDir, ".claude.json"), "{not valid json");
    await writeAgentJson(workDir, ".cursor/mcp.json", { gh: STDIO });

    await expect(
      runDirectional({ from: "claude-code", to: "cursor", apply: true }),
    ).rejects.toThrow(/cannot read source claude-code/);

    const cursor = JSON.parse(await Bun.file(join(workDir, ".cursor", "mcp.json")).text());
    expect(cursor.mcpServers.gh).toEqual(STDIO);
  });

  test("selective MCP sync adds chosen servers without overwriting conflicts", async () => {
    const sourceDup: McpServer = { type: "stdio", command: "source-version" };
    const targetDup: McpServer = { type: "stdio", command: "target-version" };
    await writeAgentJson(workDir, ".claude.json", { gh: STDIO, dup: sourceDup });
    await writeAgentJson(workDir, ".cursor/mcp.json", { dup: targetDup });

    const preview = await runSelectiveMcpSync({
      from: "claude-code",
      to: ["cursor", "gemini-cli"],
      names: ["gh", "dup", "missing"],
      apply: false,
    });
    expect(preview.notFound).toEqual(["missing"]);
    expect(preview.targets.find((t) => t.to === "cursor")?.add).toEqual(["gh"]);
    expect(preview.targets.find((t) => t.to === "cursor")?.conflicts).toEqual(["dup"]);
    expect(preview.targets.find((t) => t.to === "gemini-cli")?.add).toEqual(["dup", "gh"]);

    const applied = await runSelectiveMcpSync({
      from: "claude-code",
      to: ["cursor", "gemini-cli"],
      names: ["gh", "dup", "missing"],
      apply: true,
    });
    expect(applied.targets.some((t) => t.write?.status === "failed")).toBe(false);

    const cursor = JSON.parse(await Bun.file(join(workDir, ".cursor", "mcp.json")).text());
    expect(cursor.mcpServers.gh).toEqual(STDIO);
    expect(cursor.mcpServers.dup).toEqual(targetDup);

    const gemini = JSON.parse(await Bun.file(join(workDir, ".gemini", "settings.json")).text());
    expect(gemini.mcpServers.gh).toEqual(STDIO);
    expect(gemini.mcpServers.dup).toEqual(sourceDup);
  });

  test("fan-out mirrors one clean source to every other agent", async () => {
    await writeAgentJson(workDir, ".gemini/antigravity/mcp_config.json", { lin: HTTP });
    await writeAgentJson(workDir, ".cursor/mcp.json", { gh: STDIO });

    const preview = await runFanOut({ from: "antigravity", apply: false });
    expect(preview.targets.find((t) => t.to === "cursor")?.diff.remove).toEqual(["gh"]);

    const applied = await runFanOut({ from: "antigravity", apply: true });
    expect(applied.targets.some((t) => t.write?.status === "failed")).toBe(false);

    for (const adapter of adapters.filter((a) => a.id !== "antigravity")) {
      const read = await adapter.read();
      expect(read.servers).toEqual({ lin: HTTP });
    }
  });

  test("remove deletes one server from every agent without union re-propagation", async () => {
    await writeAgentJson(workDir, ".claude.json", { gh: STDIO, lin: HTTP });
    await writeAgentJson(workDir, ".cursor/mcp.json", { gh: STDIO });

    const preview = await runRemove({ name: "gh", apply: false });
    expect(preview.writes.filter((w) => w.status === "synced")).toHaveLength(2);

    const applied = await runRemove({ name: "gh", apply: true });
    expect(applied.writes.some((w) => w.status === "failed")).toBe(false);

    const claude = JSON.parse(await Bun.file(join(workDir, ".claude.json")).text());
    expect(claude.mcpServers).toEqual({ lin: HTTP });
    const cursor = JSON.parse(await Bun.file(join(workDir, ".cursor", "mcp.json")).text());
    expect(cursor.mcpServers).toEqual({});
  });

  test("remove with an agent scope only touches the named agents", async () => {
    await writeAgentJson(workDir, ".claude.json", { gh: STDIO, lin: HTTP });
    await writeAgentJson(workDir, ".cursor/mcp.json", { gh: STDIO });

    // Scope to cursor only — Claude must keep gh.
    const preview = await runRemove({ name: "gh", agents: ["cursor"], apply: false });
    expect(preview.writes.map((w) => w.agent)).toEqual(["cursor"]); // claude not in the write set
    const applied = await runRemove({ name: "gh", agents: ["cursor"], apply: true });
    expect(applied.writes.some((w) => w.status === "failed")).toBe(false);

    const claude = JSON.parse(await Bun.file(join(workDir, ".claude.json")).text());
    expect(claude.mcpServers).toEqual({ gh: STDIO, lin: HTTP }); // untouched
    const cursor = JSON.parse(await Bun.file(join(workDir, ".cursor", "mcp.json")).text());
    expect(cursor.mcpServers).toEqual({}); // gh removed
  });

  test("remove deletes Claude project-scoped servers too", async () => {
    await Bun.write(
      join(workDir, ".claude.json"),
      JSON.stringify({
        mcpServers: { top: STDIO },
        projects: {
          "/repo": { mcpServers: { gh: STDIO, keep: HTTP }, trustLevel: "trusted" },
        },
      }),
    );

    const applied = await runRemove({ name: "gh", apply: true });
    expect(applied.writes.find((w) => w.agent === "claude-code")?.status).toBe("synced");

    const { claudeAdapter } = await import("../src/adapters/claude.ts");
    const read = await claudeAdapter.read();
    expect(read.servers.gh).toBeUndefined();
    expect(read.servers.keep).toEqual(HTTP);

    const claude = JSON.parse(await Bun.file(join(workDir, ".claude.json")).text());
    expect(claude.projects["/repo"].mcpServers).toEqual({ keep: HTTP });
    expect(claude.projects["/repo"].trustLevel).toBe("trusted");
  });
});

describe("runDoctor", () => {
  test("reports coverage per server", async () => {
    await writeAgentJson(workDir, ".claude.json", { gh: STDIO });
    await writeAgentJson(workDir, ".cursor/mcp.json", { gh: STDIO, lin: HTTP });

    const r = await runDoctor();
    expect(r.coverage.find((c) => c.name === "gh")?.present.sort()).toEqual(["claude-code", "cursor"]);
    expect(r.coverage.find((c) => c.name === "gh")?.missing.sort()).toEqual([
      "antigravity",
      "codex",
      "gemini-cli",
      "github-copilot",
      "goose",
      "hermes-agent",
      "kimi-cli",
      "openclaw",
      "opencode",
      "windsurf",
    ]);
    expect(r.coverage.find((c) => c.name === "lin")?.present).toEqual(["cursor"]);
  });

  test("reports conflicts", async () => {
    const v1: McpServer = { type: "stdio", command: "a" };
    const v2: McpServer = { type: "stdio", command: "b" };
    await writeAgentJson(workDir, ".claude.json", { dup: v1 });
    await writeAgentJson(workDir, ".cursor/mcp.json", { dup: v2 });

    const r = await runDoctor();
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.name).toBe("dup");
  });

  test("reports adapter compatibility issues", async () => {
    const path = join(workDir, ".config", "opencode", "opencode.json");
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, JSON.stringify({ mcp: { bigquery: { type: "remote", url: BIGQUERY.url, enabled: true } } }));

    const r = await runDoctor();
    const opencode = r.reads.find((read) => read.agent === "opencode")!;
    expect(opencode.compatibility).toEqual([
      expect.objectContaining({
        agent: "opencode",
        server: "bigquery",
        code: "opencode-bigquery-output-schema-formats",
        action: "disabled",
      }),
    ]);
  });

  test("reports unmanaged MCP files with configured servers", async () => {
    await mkdir(join(workDir, "Library", "Application Support", "Code", "User"), { recursive: true });
    await Bun.write(
      join(workDir, "Library", "Application Support", "Code", "User", "mcp.json"),
      JSON.stringify({ servers: { posthog: HTTP } }),
    );
    await mkdir(join(workDir, ".vscode"), { recursive: true });
    await Bun.write(join(workDir, ".vscode", "mcp.json"), JSON.stringify({ servers: {} }));
    await mkdir(join(workDir, ".config", "mcp"), { recursive: true });
    await Bun.write(join(workDir, ".config", "mcp", "servers.json"), JSON.stringify({ paper: HTTP }));

    const r = await runDoctor();
    expect(r.unmanaged.map((u) => u.label).sort()).toEqual(["VS Code user MCP", "legacy MCP registry"]);
    expect(r.unmanaged.find((u) => u.label === "VS Code user MCP")?.serverNames).toEqual(["posthog"]);
    expect(r.unmanaged.find((u) => u.label === "legacy MCP registry")?.serverNames).toEqual(["paper"]);
  });
});

describe("claude per-project scope merge", () => {
  test("read merges top-level + projects.*.mcpServers", async () => {
    const claudePath = join(workDir, ".claude.json");
    await Bun.write(
      claudePath,
      JSON.stringify({
        mcpServers: { topLevel: STDIO },
        projects: {
          "/Users/me": { mcpServers: { perProject: HTTP } },
          "/tmp/other": { mcpServers: { another: STDIO } },
        },
      }),
    );
    const { claudeAdapter } = await import("../src/adapters/claude.ts");
    const r = await claudeAdapter.read();
    expect(r.exists).toBe(true);
    expect(Object.keys(r.servers).sort()).toEqual(["another", "perProject", "topLevel"]);
    expect(r.servers.topLevel).toEqual(STDIO);
    expect(r.servers.perProject).toEqual(HTTP);
  });

  test("top-level wins on name collision with project scope", async () => {
    const topVersion: McpServer = { type: "stdio", command: "top" };
    const projVersion: McpServer = { type: "stdio", command: "proj" };
    const claudePath = join(workDir, ".claude.json");
    await Bun.write(
      claudePath,
      JSON.stringify({
        mcpServers: { dup: topVersion },
        projects: { "/x": { mcpServers: { dup: projVersion } } },
      }),
    );
    const { claudeAdapter } = await import("../src/adapters/claude.ts");
    const r = await claudeAdapter.read();
    expect(r.servers.dup).toEqual(topVersion);
  });

  test("write goes to top-level, leaves project scopes untouched", async () => {
    const claudePath = join(workDir, ".claude.json");
    await Bun.write(
      claudePath,
      JSON.stringify({
        mcpServers: {},
        projects: { "/x": { mcpServers: { perProject: HTTP }, trustLevel: "trusted" } },
      }),
    );
    const { claudeAdapter } = await import("../src/adapters/claude.ts");
    await claudeAdapter.write({ promoted: STDIO, perProject: HTTP }, { dryRun: false });
    const data = JSON.parse(await Bun.file(claudePath).text());
    expect(data.mcpServers).toEqual({ promoted: STDIO, perProject: HTTP });
    expect(data.projects["/x"].mcpServers).toEqual({ perProject: HTTP });
    expect(data.projects["/x"].trustLevel).toBe("trusted");
  });

  test("root sync leaves per-project Claude MCP servers untouched", async () => {
    await writeAgentJson(workDir, ".claude.json", {}, {
      projects: { "/Users/me": { mcpServers: { stuck: STDIO } } },
    });
    const before = await Bun.file(join(workDir, ".claude.json")).text();
    const r = await runSync({ skipSkills: true });
    expect(r.reads).toEqual([]);
    expect(r.union).toEqual({});
    expect(r.conflicts).toEqual([]);
    expect(r.writes).toEqual([]);
    expect(await Bun.file(join(workDir, ".claude.json")).text()).toBe(before);
    expect(await Bun.file(join(workDir, ".cursor", "mcp.json")).exists()).toBe(false);
  });
});
