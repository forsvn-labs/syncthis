import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copilotPluginAdapter,
  parseCopilotPluginConfig,
  parseCopilotPluginList,
} from "../src/plugins/copilot.ts";
import {
  grokPluginAdapter,
  parseGrokPluginList,
} from "../src/plugins/grok.ts";
import { pluginAdapters } from "../src/plugins/index.ts";
import { runPluginAdd } from "../src/plugins/add.ts";
import { runPluginUninstall } from "../src/plugins/uninstall.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;
let originalCopilotHome: string | undefined;
let originalGrokHome: string | undefined;
let invocationsFile: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-native-plugin-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  originalCopilotHome = process.env.COPILOT_HOME;
  originalGrokHome = process.env.GROK_HOME;
  process.env.HOME = workDir;
  process.env.COPILOT_HOME = join(workDir, "copilot");
  process.env.GROK_HOME = join(workDir, "grok");
  invocationsFile = join(workDir, "invocations.log");
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = originalCopilotHome;
  if (originalGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = originalGrokHome;
  await rm(workDir, { recursive: true, force: true });
});

async function installFake(name: "npx" | "copilot" | "claude" | "grok", body: string) {
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
    "grok-build",
  ]);
});

describe("Grok Build native plugin adapter", () => {
  test("parses Grok's installed JSON records and ignores available catalogue rows", () => {
    expect(parseGrokPluginList(JSON.stringify([
      {
        status: "installed",
        name: "foo",
        repo_key: "foo-deadbeef",
        version: "1.2.3",
        path: "/plugins/foo",
        source: "https://github.com/owner/repo.git",
        marketplace: "team-tools",
      },
      {
        status: "available",
        name: "not-installed",
        marketplace: "team-tools",
        skill_count: 1,
        has_hooks: false,
        has_agents: false,
        has_mcp: false,
      },
    ]))).toEqual([
      {
        name: "foo",
        marketplace: "team-tools",
        version: "1.2.3",
        path: "/plugins/foo",
        sourceRepo: "owner/repo",
      },
    ]);
  });

  test("rejects malformed installed records instead of treating them as empty state", () => {
    expect(() => parseGrokPluginList('[{"status":"installed","path":"/plugins/foo"}]'))
      .toThrow(/non-empty name/i);
    expect(() => parseGrokPluginList('{"plugins":[]}')).toThrow(/JSON array/i);
  });

  test("resolves a multi-plugin install to the exact Grok registry subdirectory", async () => {
    const installDir = join(process.env.GROK_HOME!, "installed-plugins");
    const repoRoot = join(installDir, "bundle-deadbeef");
    const pluginRoot = join(repoRoot, "plugins", "foo");
    await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
    await writeFile(join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "foo" }));
    await writeFile(join(installDir, "registry.json"), JSON.stringify({
      version: 1,
      repos: {
        "bundle-deadbeef": {
          path: repoRoot,
          plugins: { foo: { subdir: "plugins/foo", version: "1.0.0" } },
        },
      },
    }));
    await installFake("grok", `
if [ "$1 $2 $3" = "plugin list --json" ]; then
  echo '[{"status":"installed","name":"foo","repo_key":"bundle-deadbeef","version":"1.0.0","path":"${repoRoot}","source":"owner/bundle","marketplace":null}]'
  exit 0
fi
exit 1`);

    const read = await grokPluginAdapter.read();

    expect(read.error).toBeUndefined();
    expect(read.plugins[0]?.path).toBe(await realpath(pluginRoot));
  });

  test("rejects a Grok registry subdirectory that escapes through an intermediate symlink", async () => {
    const installDir = join(process.env.GROK_HOME!, "installed-plugins");
    const repoRoot = join(installDir, "bundle-deadbeef");
    const outsidePlugins = join(workDir, "outside-plugins");
    const outsidePluginRoot = join(outsidePlugins, "foo");
    await mkdir(join(outsidePluginRoot, ".claude-plugin"), { recursive: true });
    await mkdir(repoRoot, { recursive: true });
    await symlink(outsidePlugins, join(repoRoot, "plugins"), "dir");
    await writeFile(join(outsidePluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "foo" }));
    await writeFile(join(installDir, "registry.json"), JSON.stringify({
      version: 1,
      repos: {
        "bundle-deadbeef": {
          path: repoRoot,
          plugins: { foo: { subdir: "plugins/foo", version: "1.0.0" } },
        },
      },
    }));
    await installFake("grok", `
if [ "$1 $2 $3" = "plugin list --json" ]; then
  echo '[{"status":"installed","name":"foo","repo_key":"bundle-deadbeef","version":"1.0.0","path":"${repoRoot}","source":"owner/bundle","marketplace":null}]'
  exit 0
fi
exit 1`);

    const read = await grokPluginAdapter.read();

    expect(read.plugins).toEqual([]);
    expect(read.error).toMatch(/subdir escapes its installed repository/i);
  });

  test("installs an exact Agent Plugin artifact, grants trust, enables it, and verifies readback", async () => {
    const source = join(workDir, "source-plugin");
    const installed = join(workDir, "grok-installed");
    const config = join(process.env.GROK_HOME!, "config.toml");
    await mkdir(join(source, ".claude-plugin"), { recursive: true });
    await mkdir(process.env.GROK_HOME!, { recursive: true });
    await writeFile(join(source, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "foo" }));
    await installFake("grok", `
if [ "$1 $2 $3" = "plugin list --json" ]; then
  if [ -f "${installed}" ]; then
    echo '[{"status":"installed","name":"foo","repo_key":"foo-deadbeef","version":"1.0.0","path":"/grok/foo","source":"${source}","marketplace":null}]'
  else
    echo '[]'
  fi
  exit 0
fi
if [ "$1 $2" = "plugin install" ]; then touch "${installed}"; exit 0; fi
if [ "$1 $2 $3" = "plugin enable foo" ]; then
  printf '[plugins]\\nenabled = ["foo"]\\ndisabled = []\\n' > "${config}"
  exit 0
fi
exit 1`);

    const result = await grokPluginAdapter.installPlugin("foo", {
      dryRun: false,
      sourcePluginPath: source,
    });

    expect(result.status).toBe("installed");
    expect(await invocations()).toContain(`grok plugin install ${await realpath(source)} --trust`);
    expect(await invocations()).toContain("grok plugin enable foo");
  });

  test("does not report a new plugin enabled when Grok exits zero without explicit enabled state", async () => {
    const source = join(workDir, "source-plugin");
    const installed = join(workDir, "grok-installed");
    await mkdir(join(source, ".claude-plugin"), { recursive: true });
    await writeFile(join(source, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "foo" }));
    await installFake("grok", `
if [ "$1 $2 $3" = "plugin list --json" ]; then
  if [ -f "${installed}" ]; then
    echo '[{"status":"installed","name":"foo","repo_key":"foo-deadbeef","version":"1.0.0","path":"/grok/foo","source":"${source}","marketplace":null}]'
  else
    echo '[]'
  fi
  exit 0
fi
if [ "$1 $2" = "plugin install" ]; then touch "${installed}"; exit 0; fi
if [ "$1 $2 $3" = "plugin enable foo" ]; then exit 0; fi
exit 1`);

    const result = await grokPluginAdapter.installPlugin("foo", {
      dryRun: false,
      sourcePluginPath: source,
    });

    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/fresh native read.*enabled/i);
    expect(await invocations()).toContain("grok plugin enable foo");
  });

  test("does not report success when Grok exits zero without fresh native state", async () => {
    const source = join(workDir, "source-plugin");
    await mkdir(join(source, ".claude-plugin"), { recursive: true });
    await writeFile(join(source, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "foo" }));
    await installFake("grok", `
if [ "$1 $2 $3" = "plugin list --json" ]; then echo '[]'; exit 0; fi
if [ "$1 $2" = "plugin install" ]; then exit 0; fi
exit 1`);

    const result = await grokPluginAdapter.installPlugin("foo", {
      dryRun: false,
      sourcePluginPath: source,
    });

    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/fresh `grok plugin list --json`/i);
  });

  test("keeps an exact installed Grok plugin idempotently present", async () => {
    const source = join(workDir, "source-plugin");
    const config = join(process.env.GROK_HOME!, "config.toml");
    await mkdir(join(source, ".claude-plugin"), { recursive: true });
    await mkdir(process.env.GROK_HOME!, { recursive: true });
    await writeFile(join(source, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "foo" }));
    await writeFile(config, '[plugins]\nenabled = ["foo"]\ndisabled = []\n');
    await installFake("grok", `
if [ "$1 $2 $3" = "plugin list --json" ]; then
  echo '[{"status":"installed","name":"foo","repo_key":"foo-deadbeef","version":"1.0.0","path":"${source}","source":"owner/repo","marketplace":null}]'
  exit 0
fi
exit 1`);

    const result = await grokPluginAdapter.installPlugin("foo", {
      dryRun: false,
      sourcePluginPath: source,
    });

    expect(result).toMatchObject({ target: "foo", status: "present" });
    expect((await invocations()).some((call) => call.startsWith("grok plugin enable "))).toBe(false);
    expect((await invocations()).some((call) => call.startsWith("grok plugin install "))).toBe(false);
  });

  test("does not enable a disabled same-name Grok plugin from a different source", async () => {
    const config = join(process.env.GROK_HOME!, "config.toml");
    await mkdir(process.env.GROK_HOME!, { recursive: true });
    await writeFile(config, '[plugins]\ndisabled = ["foo"]\n');
    await installFake("grok", `
if [ "$1 $2 $3" = "plugin list --json" ]; then
  echo '[{"status":"installed","name":"foo","repo_key":"foo-deadbeef","version":"1.0.0","path":"/grok/foo","source":"owner/other","marketplace":null}]'
  exit 0
fi
if [ "$1 $2 $3" = "plugin enable foo" ]; then exit 0; fi
exit 1`);

    const result = await grokPluginAdapter.installPlugin("foo", {
      dryRun: false,
      sourceRepo: "owner/repo",
    });

    expect(result.status).toBe("skipped");
    expect(result.message).toMatch(/conflict.*different|conflict.*not requested source/i);
    expect(await invocations()).not.toContain("grok plugin enable foo");
  });

  test("re-enables an installed disabled Grok plugin and verifies the state change", async () => {
    const config = join(process.env.GROK_HOME!, "config.toml");
    await mkdir(process.env.GROK_HOME!, { recursive: true });
    await writeFile(config, '[plugins]\ndisabled = ["foo"]\n');
    await installFake("grok", `
if [ "$1 $2 $3" = "plugin list --json" ]; then
  echo '[{"status":"installed","name":"foo","repo_key":"foo-deadbeef","version":"1.0.0","path":"/grok/foo","source":"owner/repo","marketplace":null}]'
  exit 0
fi
if [ "$1 $2 $3" = "plugin enable foo" ]; then
  printf '[plugins]\\nenabled = ["foo"]\\ndisabled = []\\n' > "${config}"
  exit 0
fi
exit 1`);

    const result = await grokPluginAdapter.installPlugin("foo", {
      dryRun: false,
      sourceRepo: "OWNER/REPO",
    });

    expect(result.status).toBe("installed");
    expect(result.message).toBe("enabled existing Grok plugin");
    expect(await invocations()).toContain("grok plugin enable foo");
    expect((await invocations()).some((call) => call.startsWith("grok plugin install "))).toBe(false);
  });

  test("does not report success when Grok exits zero but leaves a disabled plugin disabled", async () => {
    const config = join(process.env.GROK_HOME!, "config.toml");
    await mkdir(process.env.GROK_HOME!, { recursive: true });
    await writeFile(config, '[plugins]\ndisabled = ["foo"]\n');
    await installFake("grok", `
if [ "$1 $2 $3" = "plugin list --json" ]; then
  echo '[{"status":"installed","name":"foo","repo_key":"foo-deadbeef","version":"1.0.0","path":"/grok/foo","source":"owner/repo","marketplace":null}]'
  exit 0
fi
if [ "$1 $2 $3" = "plugin enable foo" ]; then exit 0; fi
exit 1`);

    const result = await grokPluginAdapter.installPlugin("foo", {
      dryRun: false,
      sourceRepo: "owner/repo",
    });

    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/fresh native read.*enabled/i);
    expect(await invocations()).toContain("grok plugin enable foo");
  });

  test("uninstalls through Grok's native command and verifies removal", async () => {
    const installed = join(workDir, "grok-installed");
    await writeFile(installed, "yes");
    await installFake("grok", `
if [ "$1 $2 $3" = "plugin list --json" ]; then
  if [ -f "${installed}" ]; then
    echo '[{"status":"installed","name":"foo","repo_key":"foo-deadbeef","version":"1.0.0","path":"/grok/foo","source":"owner/repo","marketplace":null}]'
  else
    echo '[]'
  fi
  exit 0
fi
if [ "$1 $2 $3 $4" = "plugin uninstall foo --confirm" ]; then rm "${installed}"; exit 0; fi
exit 1`);

    const result = await grokPluginAdapter.uninstallPlugin("foo", { dryRun: false });

    expect(result.status).toBe("uninstalled");
    expect(await invocations()).toContain("grok plugin uninstall foo --confirm");
  });

  test("refuses to confirm removal of one plugin from a multi-plugin Grok repository", async () => {
    const installDir = join(process.env.GROK_HOME!, "installed-plugins");
    const repoRoot = join(installDir, "bundle-deadbeef");
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(installDir, "registry.json"), JSON.stringify({
      version: 1,
      repos: {
        "bundle-deadbeef": {
          path: repoRoot,
          plugins: {
            foo: { subdir: null, version: "1.0.0" },
            bar: { subdir: null, version: "1.0.0" },
            baz: { subdir: null, version: "1.0.0" },
          },
        },
      },
    }));
    await installFake("grok", `
if [ "$1 $2 $3" = "plugin list --json" ]; then
  echo '[{"status":"installed","name":"foo","repo_key":"bundle-deadbeef","version":"1.0.0","path":"${repoRoot}","source":"owner/bundle","marketplace":null},{"status":"installed","name":"bar","repo_key":"bundle-deadbeef","version":"1.0.0","path":"${repoRoot}","source":"owner/bundle","marketplace":null}]'
  exit 0
fi
exit 1`);

    const result = await grokPluginAdapter.uninstallPlugin("foo", { dryRun: false });

    expect(result.status).toBe("skipped");
    expect(result.message).toMatch(/bar/);
    expect(result.message).toMatch(/baz/);
    expect((await invocations()).some((call) => call.startsWith("grok plugin uninstall "))).toBe(false);
  });

  test("refuses an ambiguous Grok uninstall even with a marketplace selector", async () => {
    await installFake("grok", `
if [ "$1 $2 $3" = "plugin list --json" ]; then
  echo '[{"status":"installed","name":"foo","repo_key":"foo-one","version":"1.0.0","path":"/grok/foo-one","source":"owner/one","marketplace":"one"},{"status":"installed","name":"foo","repo_key":"foo-two","version":"2.0.0","path":"/grok/foo-two","source":"owner/two","marketplace":"two"}]'
  exit 0
fi
exit 1`);

    const ambiguous = await grokPluginAdapter.uninstallPlugin("foo", {
      dryRun: false,
      marketplace: "one",
    });
    const exactMarketplaceAbsent = await grokPluginAdapter.uninstallPlugin("foo", {
      dryRun: false,
      marketplace: "missing",
    });

    expect(ambiguous.status).toBe("skipped");
    expect(ambiguous.message).toMatch(/cannot select a repository or marketplace/i);
    expect(exactMarketplaceAbsent).toMatchObject({ target: "foo@missing", status: "absent" });
    expect((await invocations()).some((call) => call.startsWith("grok plugin uninstall "))).toBe(false);
  });

  test("does not report uninstall success when Grok exits zero but leaves the plugin installed", async () => {
    await installFake("grok", `
if [ "$1 $2 $3" = "plugin list --json" ]; then
  echo '[{"status":"installed","name":"foo","repo_key":"foo-deadbeef","version":"1.0.0","path":"/grok/foo","source":"owner/repo","marketplace":null}]'
  exit 0
fi
if [ "$1 $2 $3 $4" = "plugin uninstall foo --confirm" ]; then exit 0; fi
exit 1`);

    const result = await grokPluginAdapter.uninstallPlugin("foo", { dryRun: false });

    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/fresh `grok plugin list --json` still shows the plugin/i);
    expect(await invocations()).toContain("grok plugin uninstall foo --confirm");
  });
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
