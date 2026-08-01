import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPluginInventory } from "../src/plugins/inventory.ts";
import type { PluginAdapterRead } from "../src/plugins/types.ts";

let workDir: string;
let originalHome: string | undefined;
let originalCodexHome: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-plugin-inventory-"));
  originalHome = process.env.HOME;
  originalCodexHome = process.env.CODEX_HOME;
  process.env.HOME = workDir;
  delete process.env.CODEX_HOME;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await rm(workDir, { recursive: true, force: true });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function pluginRoot(
  rel: string,
  manifest: { name: string; repository?: string; version?: string },
  extra: { skills?: boolean; mcp?: boolean } = {},
): Promise<string> {
  const root = join(workDir, rel);
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await writeJson(join(root, ".codex-plugin", "plugin.json"), manifest);
  if (extra.skills) {
    await mkdir(join(root, "skills"), { recursive: true });
    await writeFile(join(root, "skills", "SKILL.md"), "# Skill");
  }
  if (extra.mcp) await writeJson(join(root, ".mcp.json"), { mcpServers: {} });
  return root;
}

async function writeSharedMarketplace(plugins: unknown[]): Promise<void> {
  await writeJson(join(workDir, ".agents", "plugins", "marketplace.json"), {
    name: "plugins-cli",
    plugins,
  });
}

async function writeCodexConfig(text: string, root = join(workDir, ".codex")): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "config.toml"), text);
}

function read(
  agent: PluginAdapterRead["agent"],
  plugins: PluginAdapterRead["plugins"],
): PluginAdapterRead {
  return {
    agent,
    configPath: join(workDir, `.${agent}`, "config"),
    exists: true,
    plugins,
  };
}

describe("plugin inventory", () => {
  test("discovers a dotted Plugins CLI install configured in Codex but absent from native runtime", async () => {
    const root = await pluginRoot(
      ".codex/plugins/cache/plugins-cli/github.com-googleworkspace-cli/rev",
      { name: "gws", repository: "googleworkspace/cli" },
      { skills: true, mcp: true },
    );
    await writeSharedMarketplace([
      {
        name: "github.com-googleworkspace-cli",
        source: {
          source: "local",
          path: "./.codex/plugins/cache/plugins-cli/github.com-googleworkspace-cli/rev",
        },
      },
    ]);
    await writeCodexConfig(`
[plugins."github.com-googleworkspace-cli@plugins-cli"]
enabled = true
`);

    const inventory = await readPluginInventory({ adapterReads: [] });

    expect(inventory.errors).toEqual([]);
    expect(inventory.artifacts).toHaveLength(1);
    expect(inventory.artifacts[0]).toMatchObject({
      canonicalName: "gws",
      aliases: ["github.com-googleworkspace-cli", "gws"],
      pluginRoot: await realpath(root),
      configuredOn: ["codex"],
      activeOn: [],
      installedOn: [],
      catalogueOnly: false,
      eligible: true,
      sourceRepo: "googleworkspace/cli",
      payload: { nativeManifest: true, skills: true, mcp: true },
    });
  });

  test("treats an unconfigured shared entry as catalogue-only", async () => {
    const root = await pluginRoot(".codex/plugins/cache/plugins-cli/available/rev", { name: "available" });
    await writeSharedMarketplace([
      { name: "available", source: { source: "local", path: ".codex/plugins/cache/plugins-cli/available/rev" } },
    ]);

    const inventory = await readPluginInventory({ adapterReads: [] });
    const artifact = inventory.artifacts[0]!;

    expect(artifact.pluginRoot).toBe(await realpath(root));
    expect(artifact.catalogueOnly).toBe(true);
    expect(artifact.eligible).toBe(false);
    expect(artifact.configuredOn).toEqual([]);
    expect(artifact.activeOn).toEqual([]);
  });

  test("merges runtime truth with Claude installed and marketplace metadata", async () => {
    const root = await pluginRoot(".claude/plugins/cache/mkt/foo/1.0", { name: "foo" });
    const marketplaceRoot = join(workDir, ".claude", "plugins", "marketplaces", "mkt");
    await mkdir(marketplaceRoot, { recursive: true });
    await writeJson(join(workDir, ".claude", "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: {
        "foo@mkt": [{ version: "1.0.0", installPath: root, enabled: true }],
      },
    });
    await writeJson(join(workDir, ".claude", "plugins", "known_marketplaces.json"), {
      mkt: {
        source: { source: "github", repo: "owner/shared-marketplace" },
        installLocation: marketplaceRoot,
      },
    });

    const inventory = await readPluginInventory({
      adapterReads: [read("claude-code", [{ name: "foo", marketplace: "mkt", path: root, enabled: true }])],
    });
    const artifact = inventory.artifacts[0]!;

    expect(inventory.artifacts).toHaveLength(1);
    expect(artifact.activeOn).toEqual(["claude-code"]);
    expect(artifact.installedOn).toEqual(["claude-code"]);
    expect(artifact.sourceRepo).toBe("owner/shared-marketplace");
    expect(artifact.marketplaceRoot).toBe(await realpath(marketplaceRoot));
    expect(artifact.evidence.map((item) => item.kind).sort()).toEqual(["claude-installed", "runtime"]);
  });

  test("keeps a disabled runtime install distinct from active/configured state", async () => {
    const inventory = await readPluginInventory({
      adapterReads: [
        read("codex", [{ name: "disabled", marketplace: "plugins-cli", enabled: false, path: "/missing/runtime/path" }]),
      ],
    });
    const artifact = inventory.artifacts[0]!;

    expect(artifact.installedOn).toEqual(["codex"]);
    expect(artifact.activeOn).toEqual([]);
    expect(artifact.configuredOn).toEqual([]);
    expect(artifact.eligible).toBe(false);
    expect(artifact.catalogueOnly).toBe(false);
  });

  test("isolates malformed sources and unsafe or missing entries while retaining healthy artifacts", async () => {
    const goodRoot = await pluginRoot(".codex/plugins/cache/plugins-cli/good/rev", { name: "good" });
    await writeSharedMarketplace([
      { name: "good", source: { source: "local", path: ".codex/plugins/cache/plugins-cli/good/rev" } },
      { name: "escape", source: { source: "local", path: "../outside" } },
      { name: "missing", source: { source: "local", path: ".codex/plugins/cache/plugins-cli/missing/rev" } },
      { source: { source: "local", path: ".codex/plugins/cache/plugins-cli/no-name/rev" } },
      "not-an-entry",
    ]);
    await mkdir(join(workDir, ".claude", "plugins"), { recursive: true });
    await writeFile(join(workDir, ".claude", "plugins", "installed_plugins.json"), "{not json");
    await writeCodexConfig(`
[plugins."good@plugins-cli"]
enabled = true
`);

    const inventory = await readPluginInventory({ adapterReads: [] });
    const good = inventory.artifacts.find((artifact) => artifact.canonicalName === "good");

    expect(good?.pluginRoot).toBe(await realpath(goodRoot));
    expect(good?.configuredOn).toEqual(["codex"]);
    expect(inventory.artifacts.some((artifact) => artifact.aliases.includes("escape"))).toBe(true);
    expect(inventory.artifacts.some((artifact) => artifact.aliases.includes("missing"))).toBe(true);
    expect(inventory.errors.some((error) => error.source === "claude-installed" && /invalid JSON/.test(error.message))).toBe(true);
    expect(inventory.errors.some((error) => error.plugin === "escape" && /contains '\.\.'/.test(error.message))).toBe(true);
    expect(inventory.errors.some((error) => error.plugin === "missing" && /does not exist/.test(error.message))).toBe(true);
    expect(inventory.sources.find((source) => source.kind === "codex-config")?.status).toBe("ok");
  });

  test("does not merge distinct plugins merely because they share a repository", async () => {
    await pluginRoot(".codex/plugins/cache/plugins-cli/alpha/rev", {
      name: "alpha",
      repository: "owner/multi-plugin-repo",
    });
    await pluginRoot(".codex/plugins/cache/plugins-cli/beta/rev", {
      name: "beta",
      repository: "owner/multi-plugin-repo",
    });
    await writeSharedMarketplace([
      { name: "alpha", source: { source: "local", path: ".codex/plugins/cache/plugins-cli/alpha/rev" } },
      { name: "beta", source: { source: "local", path: ".codex/plugins/cache/plugins-cli/beta/rev" } },
    ]);
    await writeCodexConfig(`
[plugins."alpha@plugins-cli"]
enabled = true
[plugins."beta@plugins-cli"]
enabled = true
`);

    const inventory = await readPluginInventory({ adapterReads: [] });

    expect(inventory.artifacts.map((artifact) => artifact.canonicalName)).toEqual(["alpha", "beta"]);
    expect(inventory.artifacts.map((artifact) => artifact.sourceRepo)).toEqual([
      "owner/multi-plugin-repo",
      "owner/multi-plugin-repo",
    ]);
    expect(inventory.artifacts.every((artifact) => artifact.configuredOn.includes("codex"))).toBe(true);
  });

  test("same display IDs receive distinct deterministic artifact keys from full source evidence", async () => {
    await pluginRoot(
      ".codex/plugins/cache/plugins-cli/duplicate/a",
      { name: "duplicate", repository: "owner/a", version: "revision-a" },
    );
    await pluginRoot(
      ".codex/plugins/cache/plugins-cli/duplicate/b",
      { name: "duplicate", repository: "owner/b", version: "revision-b" },
    );
    await writeSharedMarketplace([
      { name: "duplicate", source: { source: "local", path: ".codex/plugins/cache/plugins-cli/duplicate/a" } },
      { name: "duplicate", source: { source: "local", path: ".codex/plugins/cache/plugins-cli/duplicate/b" } },
    ]);

    const first = await readPluginInventory({ adapterReads: [] });
    const second = await readPluginInventory({ adapterReads: [] });

    expect(first.artifacts.map((artifact) => artifact.id)).toEqual([
      "duplicate@plugins-cli",
      "duplicate@plugins-cli",
    ]);
    expect(new Set(first.artifacts.map((artifact) => artifact.artifactKey)).size).toBe(2);
    expect(first.artifacts.map((artifact) => artifact.artifactKey)).toEqual(
      second.artifacts.map((artifact) => artifact.artifactKey),
    );
  });

  test("honors CODEX_HOME when reading configured plugin intent", async () => {
    const customCodexHome = join(workDir, "custom-codex");
    process.env.CODEX_HOME = customCodexHome;
    await writeCodexConfig(
      `
[plugins."custom@plugins-cli"]
enabled = true
`,
      customCodexHome,
    );

    const inventory = await readPluginInventory({ adapterReads: [] });
    const artifact = inventory.artifacts.find((item) => item.canonicalName === "custom");

    expect(artifact?.configuredOn).toEqual(["codex"]);
    expect(inventory.sources.find((source) => source.kind === "codex-config")?.path).toBe(
      join(customCodexHome, "config.toml"),
    );
  });
});
