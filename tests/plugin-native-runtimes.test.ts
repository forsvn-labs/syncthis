import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copilotPluginAdapter,
  parseCopilotPluginConfig,
  parseCopilotPluginList,
} from "../src/plugins/copilot.ts";
import { pluginAdapters } from "../src/plugins/index.ts";
import { runPluginAdd } from "../src/plugins/add.ts";
import { runPluginUninstall } from "../src/plugins/uninstall.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;
let originalCopilotHome: string | undefined;
let invocationsFile: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-native-plugin-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  originalCopilotHome = process.env.COPILOT_HOME;
  process.env.HOME = workDir;
  process.env.COPILOT_HOME = join(workDir, "copilot");
  invocationsFile = join(workDir, "invocations.log");
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = originalCopilotHome;
  await rm(workDir, { recursive: true, force: true });
});

async function installFake(name: "npx" | "copilot" | "claude", body: string) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, name);
  await writeFile(path, `#!/bin/sh\necho "${name} $@" >> ${invocationsFile}\n${body}\n`);
  await chmod(path, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

async function invocations(): Promise<string[]> {
  try {
    return (await readFile(invocationsFile, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test("verified native registry excludes Kimi's unproven ABI", () => {
  expect(pluginAdapters.map((adapter) => adapter.id)).toEqual([
    "claude-code",
    "codex",
    "github-copilot",
  ]);
});

describe("GitHub Copilot native plugin adapter", () => {
  test("parses Copilot's comment-bearing native config", () => {
    expect(parseCopilotPluginConfig(`// managed\n{"installedPlugins":[{"name":"foo","marketplace":"mkt","version":"1.2.3","cache_path":"/p/foo","enabled":true}]}`))
      .toEqual([{ name: "foo", marketplace: "mkt", version: "1.2.3", path: "/p/foo", enabled: true }]);
  });

  test("parses the real human-readable native list contract", () => {
    expect(parseCopilotPluginList("Installed plugins:\n\n  • foo@mkt (v1.2.3)\n  • local-tool (v0.4.0)\n"))
      .toEqual([
        { name: "foo", marketplace: "mkt", version: "1.2.3", enabled: true },
        { name: "local-tool", version: "0.4.0", enabled: true },
      ]);
    expect(parseCopilotPluginList("No plugins installed. Use `copilot plugin install` to add one.\n")).toEqual([]);
  });

  test("surfaces malformed native config instead of treating it as empty state", async () => {
    await mkdir(process.env.COPILOT_HOME!, { recursive: true });
    await writeFile(join(process.env.COPILOT_HOME!, "config.json"), "{not valid");
    await installFake("copilot", `echo "No plugins installed. Use copilot plugin install to add one."; exit 0`);

    const read = await copilotPluginAdapter.read();
    expect(read.error).toMatch(/invalid JSON5/i);
    expect(read.plugins).toEqual([]);
  });

  test("malformed native config blocks install before invoking Copilot", async () => {
    await mkdir(process.env.COPILOT_HOME!, { recursive: true });
    await writeFile(
      join(process.env.COPILOT_HOME!, "config.json"),
      JSON.stringify({ installedPlugins: "not-an-array" }),
    );
    await installFake("copilot", `echo "No plugins installed. Use copilot plugin install to add one."; exit 0`);

    const result = await copilotPluginAdapter.installPlugin("foo", {
      dryRun: false,
      sourceRepo: "owner/repo",
    });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/installedPlugins must be an array/i);
    expect(await invocations()).toEqual(["copilot plugin list"]);
  });

  test("malformed native config blocks uninstall before invoking Copilot", async () => {
    await mkdir(process.env.COPILOT_HOME!, { recursive: true });
    await writeFile(
      join(process.env.COPILOT_HOME!, "config.json"),
      JSON.stringify({ installedPlugins: [{ marketplace: "mkt" }] }),
    );
    await installFake("copilot", `echo "  • foo@mkt (v1.0.0)"; exit 0`);

    const result = await copilotPluginAdapter.uninstallPlugin("foo", { dryRun: false });
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/non-empty name/i);
    expect(await invocations()).toEqual(["copilot plugin list"]);
  });

  test("registers the source marketplace and installs with Copilot's native commands", async () => {
    const clone = join(workDir, "marketplace");
    await mkdir(join(clone, ".claude-plugin"), { recursive: true });
    await writeFile(join(clone, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "mkt",
      plugins: [{ name: "foo", source: "./foo" }],
    }));
    const config = join(process.env.COPILOT_HOME!, "config.json");
    await installFake("copilot", `
if [ "$1 $2" = "plugin list" ]; then
  if [ -f "${config}" ]; then echo "  • foo@mkt (v1.0.0)"; else echo "No plugins installed."; fi
  exit 0
fi
if [ "$1 $2 $3" = "plugin marketplace add" ]; then exit 0; fi
if [ "$1 $2" = "plugin install" ]; then
  mkdir -p "${process.env.COPILOT_HOME!}"
  printf '{"installedPlugins":[{"name":"foo","marketplace":"mkt","version":"1.0.0","cache_path":"/p/foo","enabled":true}]}' > "${config}"
  exit 0
fi
exit 1`);

    const result = await copilotPluginAdapter.installPlugin("foo", {
      dryRun: false,
      sourceRepo: "owner/repo",
      sourceClonePath: clone,
    });

    expect(result.status).toBe("installed");
    const calls = await invocations();
    expect(calls).toContain(`copilot plugin marketplace add ${await realpath(clone)}`);
    expect(calls).toContain("copilot plugin install foo@mkt");
  });

  test("native install errors remain explicit", async () => {
    await installFake("copilot", `
if [ "$1 $2" = "plugin list" ]; then echo "No plugins installed."; exit 0; fi
if [ "$1 $2" = "plugin install" ]; then echo "invalid plugin" >&2; exit 2; fi
exit 0`);
    const result = await copilotPluginAdapter.installPlugin("foo", {
      dryRun: false,
      sourceRepo: "owner/repo",
      sourceMarketplace: "mkt",
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("invalid plugin");
  });

  test("installs a standalone local artifact through Copilot's native local-path contract", async () => {
    const source = join(workDir, "standalone-copilot");
    const config = join(process.env.COPILOT_HOME!, "config.json");
    await mkdir(join(source, ".claude-plugin"), { recursive: true });
    await writeFile(join(source, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "foo" }));
    await installFake("copilot", `
if [ "$1 $2" = "plugin list" ]; then
  if [ -f "${config}" ]; then echo "  • foo (v1.0.0)"; else echo "No plugins installed."; fi
  exit 0
fi
if [ "$1 $2" = "plugin install" ]; then
  mkdir -p "${process.env.COPILOT_HOME!}"
  printf '{"installedPlugins":[{"name":"foo","cache_path":"${source}","enabled":true}]}' > "${config}"
  exit 0
fi
exit 1`);

    const result = await copilotPluginAdapter.installPlugin("foo", {
      dryRun: false,
      sourcePluginPath: source,
    });

    expect(result.status).toBe("installed");
    expect(await invocations()).toContain(`copilot plugin install ${await realpath(source)}`);
  });

  test("a standalone Copilot exit-zero without fresh native activation is a hard failure", async () => {
    const source = join(workDir, "standalone-copilot");
    await mkdir(join(source, ".claude-plugin"), { recursive: true });
    await writeFile(join(source, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "foo" }));
    await installFake("copilot", `
if [ "$1 $2" = "plugin list" ]; then echo "No plugins installed."; exit 0; fi
if [ "$1 $2" = "plugin install" ]; then exit 0; fi
exit 1`);

    const result = await copilotPluginAdapter.installPlugin("foo", {
      dryRun: false,
      sourcePluginPath: source,
    });

    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/fresh `copilot plugin list` did not show/i);
  });

  test("uninstalls through Copilot's native command and verifies removal", async () => {
    const config = join(process.env.COPILOT_HOME!, "config.json");
    await mkdir(process.env.COPILOT_HOME!, { recursive: true });
    await writeFile(config, JSON.stringify({
      installedPlugins: [{ name: "foo", marketplace: "mkt", version: "1.0.0", cache_path: "/p/foo", enabled: true }],
    }));
    await installFake("copilot", `
if [ "$1 $2" = "plugin list" ]; then
  if grep -q '"name":"foo"' "${config}"; then echo "  • foo@mkt (v1.0.0)"; else echo "No plugins installed."; fi
  exit 0
fi
if [ "$1 $2" = "plugin uninstall" ]; then
  printf '{"installedPlugins":[]}' > "${config}"
  exit 0
fi
exit 1`);

    const result = await copilotPluginAdapter.uninstallPlugin("foo", { dryRun: false });
    expect(result.status).toBe("uninstalled");
    expect((await invocations())).toContain("copilot plugin uninstall foo@mkt");
  });
});

describe("plugin add native-first routing", () => {
  test("Copilot stays native while Kimi receives exact skills and MCP degradation", async () => {
    const pluginDir = join(workDir, "plugin");
    const clone = join(workDir, "clone");
    await mkdir(join(pluginDir, "skills", "alpha"), { recursive: true });
    await writeFile(join(pluginDir, "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
    await writeFile(join(pluginDir, ".mcp.json"), JSON.stringify({ mcpServers: { foo: { command: "foo-mcp" } } }));
    await mkdir(join(clone, ".claude-plugin"), { recursive: true });
    await writeFile(join(clone, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "mkt",
      plugins: [{ name: "foo", source: "./foo" }],
    }));
    await mkdir(join(workDir, ".claude", "plugins"), { recursive: true });
    await writeFile(join(workDir, ".claude", "plugins", "known_marketplaces.json"), JSON.stringify({
      mkt: { source: { source: "github", repo: "owner/repo" }, installLocation: clone },
    }));

    const claudeList = join(workDir, "claude-list.json");
    const claudeMarketplaces = join(workDir, "claude-marketplaces.json");
    await writeFile(claudeList, JSON.stringify([{ id: "foo@mkt", enabled: true, installPath: pluginDir }]));
    await writeFile(claudeMarketplaces, JSON.stringify([{ name: "mkt", source: "github", repo: "owner/repo" }]));
    await installFake("npx", `
if [ "$2 $3" = "skills add" ]; then exit 0; fi
exit 1`);
    const copilotConfig = join(process.env.COPILOT_HOME!, "config.json");
    await installFake("copilot", `
if [ "$1 $2" = "plugin list" ]; then
  if [ -f "${copilotConfig}" ]; then echo "  • foo@mkt (v1.0.0)"; else echo "No plugins installed."; fi
  exit 0
fi
if [ "$1 $2 $3" = "plugin marketplace add" ]; then exit 0; fi
if [ "$1 $2" = "plugin install" ]; then
  mkdir -p "${process.env.COPILOT_HOME!}"
  printf '{"installedPlugins":[{"name":"foo","marketplace":"mkt","version":"1.0.0","cache_path":"/p/foo","enabled":true}]}' > "${copilotConfig}"
  exit 0
fi
exit 1`);
    await installFake("claude", `
if [ "$1 $2 $3" = "plugin list --json" ]; then cat "${claudeList}"; exit 0; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then cat "${claudeMarketplaces}"; exit 0; fi
exit 1`);

    const result = await runPluginAdd({
      plugins: ["foo"],
      agents: ["kimi-cli", "github-copilot"],
      apply: true,
    });

    expect(result.installs.find((item) => item.agent === "kimi-cli")).toBeUndefined();
    expect(result.installs.find((item) => item.agent === "github-copilot")?.status).toBe("installed");
    expect((await invocations()).some((line) => /skills add owner\/repo .* -a kimi-code-cli/.test(line))).toBe(true);
    expect(result.mcp.find((item) => item.agent === "kimi-cli")?.added).toEqual(["foo"]);
    expect(result.mcp.find((item) => item.agent === "github-copilot")?.added).toEqual([]);
  });
});

describe("guarded native uninstall routing", () => {
  test("uses Copilot native uninstall while Kimi remains in the loose-skill scope", async () => {
    const copilotConfig = join(process.env.COPILOT_HOME!, "config.json");
    await mkdir(process.env.COPILOT_HOME!, { recursive: true });
    await writeFile(copilotConfig, JSON.stringify({
      installedPlugins: [{ name: "foo", marketplace: "mkt", version: "1.0.0", cache_path: "/p/foo", enabled: true }],
    }));
    await installFake("copilot", `
if [ "$1 $2" = "plugin list" ]; then
  if grep -q '"name":"foo"' "${copilotConfig}"; then echo "  • foo@mkt (v1.0.0)"; else echo "No plugins installed."; fi
  exit 0
fi
if [ "$1 $2" = "plugin uninstall" ]; then printf '{"installedPlugins":[]}' > "${copilotConfig}"; exit 0; fi
exit 1`);
    await installFake("claude", `
if [ "$1 $2 $3" = "plugin list --json" ]; then echo '[]'; exit 0; fi
exit 1`);
    await installFake("npx", `
if [ "$2 $3" = "skills list" ]; then echo '[]'; exit 0; fi
exit 1`);

    const result = await runPluginUninstall({
      plugins: ["foo"],
      agents: ["kimi-cli", "github-copilot"],
      apply: true,
    });

    expect(result.nativeResults?.find((item) => item.agent === "kimi-cli")).toBeUndefined();
    expect(result.nativeResults?.find((item) => item.agent === "github-copilot")?.status).toBe("uninstalled");
    expect(result.unsupportedAgents).toEqual([]);
    expect(result.skillScope).toContain("kimi-cli");
  });
});
