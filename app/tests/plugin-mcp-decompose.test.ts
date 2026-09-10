import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { lstat, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePluginMcpServers } from "../src/plugins/mcp.ts";
import type { PluginRecord } from "../src/plugins/types.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-pmcp-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// Materialize a plugin install dir with the given files, return a PluginRecord whose
// `path` points at it (matching Claude's `installPath`).
async function plugin(name: string, files: Record<string, unknown>, marketplace?: string): Promise<PluginRecord> {
  const root = join(workDir, name);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return { name, marketplace, path: root };
}

describe("resolvePluginMcpServers", () => {
  test("lifts .mcp.json servers and resolves ${CLAUDE_PLUGIN_ROOT}", async () => {
    const p = await plugin("db", {
      ".mcp.json": {
        mcpServers: {
          db: { command: "${CLAUDE_PLUGIN_ROOT}/bin/db", args: ["--root", "${CLAUDE_PLUGIN_ROOT}"] },
        },
      },
    });
    const { servers, skipped } = await resolvePluginMcpServers([p]);
    expect(skipped).toEqual([]);
    expect(servers.map((s) => s.name)).toEqual(["db"]);
    expect(servers[0]!.plugin).toBe("db");
    const s = servers[0]!.server as { command: string; args: string[] };
    expect(s.command).toBe(join(p.path!, "bin/db"));
    expect(s.args).toEqual(["--root", p.path!]);
  });

  test("lifts an inline mcpServers map from the plugin manifest", async () => {
    const p = await plugin("x", {
      ".claude-plugin/plugin.json": { name: "x", mcpServers: { api: { command: "node", args: ["server.js"] } } },
    });
    const { servers } = await resolvePluginMcpServers([p]);
    expect(servers.map((s) => s.name)).toEqual(["api"]);
    expect(servers[0]!.server).toEqual({ command: "node", args: ["server.js"] });
  });

  test("lifts a manifest mcpServers string path to a .mcp.json file", async () => {
    const p = await plugin("y", {
      ".claude-plugin/plugin.json": { name: "y", mcpServers: "./servers.json" },
      "servers.json": { mcpServers: { sub: { command: "run" } } },
    });
    const { servers } = await resolvePluginMcpServers([p]);
    expect(servers.map((s) => s.name)).toEqual(["sub"]);
  });

  test("lifts a url server as http and preserves sse", async () => {
    const p = await plugin("h", {
      ".mcp.json": { mcpServers: { remote: { url: "https://x/mcp" }, streamed: { type: "sse", url: "https://y/sse" } } },
    });
    const { servers } = await resolvePluginMcpServers([p]);
    const byName = Object.fromEntries(servers.map((s) => [s.name, s.server]));
    expect(byName.remote).toEqual({ type: "http", url: "https://x/mcp" });
    expect(byName.streamed).toEqual({ type: "sse", url: "https://y/sse" });
  });

  test("skips a server that still references a Claude-only variable", async () => {
    const p = await plugin("d", {
      ".mcp.json": { mcpServers: { data: { command: "x", args: ["${CLAUDE_PLUGIN_DATA}/db"] } } },
    });
    const { servers, skipped } = await resolvePluginMcpServers([p]);
    expect(servers).toEqual([]);
    expect(skipped[0]!.name).toBe("data");
    expect(skipped[0]!.reason).toMatch(/Claude-only/);
  });

  test("leaves a portable ${ENV_VAR} reference untouched (not a Claude var)", async () => {
    const p = await plugin("e", {
      ".mcp.json": { mcpServers: { svc: { command: "run", env: { TOKEN: "${MY_TOKEN}" } } } },
    });
    const { servers, skipped } = await resolvePluginMcpServers([p]);
    expect(skipped).toEqual([]);
    expect((servers[0]!.server as { env: Record<string, string> }).env).toEqual({ TOKEN: "${MY_TOKEN}" });
  });

  test("skips an unrecognized server shape (no command, no url)", async () => {
    const p = await plugin("u", { ".mcp.json": { mcpServers: { weird: { foo: "bar" } } } });
    const { servers, skipped } = await resolvePluginMcpServers([p]);
    expect(servers).toEqual([]);
    expect(skipped[0]!.reason).toMatch(/unrecognized/);
  });

  test("ignores a plugin with no install path and tolerates malformed json", async () => {
    const noPath: PluginRecord = { name: "np" };
    const bad = await plugin("bad", { ".mcp.json": "{ not valid json ,,," });
    const { servers, skipped } = await resolvePluginMcpServers([noPath, bad]);
    expect(servers).toEqual([]);
    expect(skipped).toEqual([]);
  });

  test("first plugin wins a duplicate name; a conflicting duplicate is skipped", async () => {
    const a = await plugin("a", { ".mcp.json": { mcpServers: { dup: { command: "a" } } } });
    const b = await plugin("b", { ".mcp.json": { mcpServers: { dup: { command: "b" } } } });
    const { servers, skipped } = await resolvePluginMcpServers([a, b]);
    expect(servers.length).toBe(1);
    expect((servers[0]!.server as { command: string }).command).toBe("a");
    expect(skipped[0]).toMatchObject({ plugin: "b", name: "dup" });
    expect(skipped[0]!.reason).toMatch(/duplicate/);
  });

  test("an identical duplicate across plugins is deduped silently", async () => {
    const a = await plugin("a", { ".mcp.json": { mcpServers: { same: { command: "x", args: ["--y"] } } } });
    const b = await plugin("b", { ".mcp.json": { mcpServers: { same: { args: ["--y"], command: "x" } } } });
    const { servers, skipped } = await resolvePluginMcpServers([a, b]);
    expect(servers.length).toBe(1);
    expect(skipped).toEqual([]);
  });

  // Canonical packages must pass through the SAME first-wins/conflicting-skip
  // gate as legacy ones — in every pairing and both orderings — so a name
  // collision can never silently last-write-win downstream.
  async function canonicalPlugin(
    name: string,
    serverName: string,
    url: string,
  ): Promise<PluginRecord> {
    const root = join(workDir, name);
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name,
      }),
    );
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { [serverName]: { type: "streamable-http", url } },
      }),
    );
    return { name, path: root };
  }

  test("canonical/canonical duplicate name keeps the first and skips the conflict", async () => {
    const first = await canonicalPlugin("canon-a", "dup", "https://a.example/mcp");
    const second = await canonicalPlugin("canon-b", "dup", "https://b.example/mcp");
    const forward = await resolvePluginMcpServers([first, second]);
    expect(forward.servers.map((s) => s.plugin)).toEqual(["canon-a"]);
    expect((forward.servers[0]!.server as { url: string }).url).toBe("https://a.example/mcp");
    expect(forward.skipped).toMatchObject([{ plugin: "canon-b", name: "dup" }]);
    expect(forward.skipped[0]!.reason).toMatch(/duplicate/);

    const reverse = await resolvePluginMcpServers([second, first]);
    expect(reverse.servers.map((s) => s.plugin)).toEqual(["canon-b"]);
    expect((reverse.servers[0]!.server as { url: string }).url).toBe("https://b.example/mcp");
    expect(reverse.skipped).toMatchObject([{ plugin: "canon-a", name: "dup" }]);
  });

  test("canonical-first over a conflicting legacy duplicate is skipped, not last-write-wins", async () => {
    const canon = await canonicalPlugin("canon-legacy-a", "shared", "https://canonical.example/mcp");
    const legacy = await plugin("legacy-b", {
      ".mcp.json": { mcpServers: { shared: { command: "legacy-runner" } } },
    });
    const { servers, skipped } = await resolvePluginMcpServers([canon, legacy]);
    expect(servers.map((s) => s.plugin)).toEqual(["canon-legacy-a"]);
    expect(skipped).toMatchObject([{ plugin: "legacy-b", name: "shared" }]);
    expect(skipped[0]!.reason).toMatch(/duplicate/);
  });

  test("legacy-first over a conflicting canonical duplicate is skipped too", async () => {
    const canon = await canonicalPlugin("canon-legacy-b", "shared", "https://canonical.example/mcp");
    const legacy = await plugin("legacy-a", {
      ".mcp.json": { mcpServers: { shared: { command: "legacy-runner" } } },
    });
    const { servers, skipped } = await resolvePluginMcpServers([legacy, canon]);
    expect(servers.map((s) => s.plugin)).toEqual(["legacy-a"]);
    expect((servers[0]!.server as { command: string }).command).toBe("legacy-runner");
    expect(skipped).toMatchObject([{ plugin: "canon-legacy-b", name: "shared" }]);
    expect(skipped[0]!.reason).toMatch(/duplicate/);
  });

  test("preview intent resolves the exact PLUGIN_DATA path without creating it", async () => {
    const root = join(workDir, "preview-plugin");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "preview-plugin",
      }),
    );
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { svc: { type: "stdio", command: "run", args: ["${PLUGIN_DATA}/db"] } },
      }),
    );
    const dataRoot = join(workDir, "preview-data");
    const { servers, skipped } = await resolvePluginMcpServers(
      [{ name: "preview-plugin", path: root }],
      { dataHome: { intent: "preview", dataRoot } },
    );
    expect(skipped).toEqual([]);
    const server = servers[0]!.server as { args: string[]; env: Record<string, string> };
    expect(server.args[0]).toContain(join(dataRoot, "syncthis", "plugin-data"));
    // Nothing was created anywhere under the preview data root.
    let created = true;
    try {
      await lstat(dataRoot);
    } catch {
      created = false;
    }
    expect(created).toBe(false);
  });
});
