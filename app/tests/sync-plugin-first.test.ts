import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createArtifactKey } from "../src/plugins/artifact-key.ts";
import { adapters } from "../src/adapters/index.ts";
import type { PluginReconcileResult } from "../src/plugins/reconcile.ts";
import { pluginReconcileTargets } from "../src/plugins/targets.ts";
import type { PluginAdapter, PluginRecord } from "../src/plugins/types.ts";
import {
  runSync as runSyncCore,
  syncHasFailures,
} from "../src/sync.ts";
import {
  STDIO,
  degradationArtifact,
  degradationReport,
  eligibleDegradation,
  pluginReport,
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

describe("Cursor plugin reconciliation target", () => {
  test("installs a standalone local artifact through the cursor target as write-only", async () => {
    const source = join(workDir, "standalone-cursor");
    const log = join(workDir, "npx.log");
    const binDir = join(workDir, "bin");
    await mkdir(join(source, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(source, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "foo" }),
    );
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "npx"),
      `#!/bin/sh\necho "npx $@" >> "${log}"\nexit 0\n`,
    );
    await chmod(join(binDir, "npx"), 0o755);
    process.env.PATH = `${binDir}:${testEnvironment.originalPath ?? ""}`;

    const cursor = pluginReconcileTargets().find((target) => target.agent === "cursor");
    expect(cursor?.mode).toBe("write-only");
    if (!cursor || cursor.mode !== "write-only") {
      throw new Error("Cursor write-only target missing");
    }
    const result = await cursor.install(
      {
        ...(await degradationArtifact(workDir)),
        sourceRepo: undefined,
        pluginRoot: undefined,
        sourcePluginPath: source,
      },
      { dryRun: false },
    );

    expect(result).toMatchObject({ ok: true });
    expect(result.message).toMatch(/cannot be read/i);
    expect((await readFile(log, "utf8")).trim()).toBe(
      `npx -y plugins@1.3.4 add ${await realpath(source)} --target cursor -y`,
    );
  });

  test("rejects a malformed standalone path before invoking Cursor's installer", async () => {
    const cursor = pluginReconcileTargets().find((target) => target.agent === "cursor");
    if (!cursor || cursor.mode !== "write-only") {
      throw new Error("Cursor write-only target missing");
    }

    const result = await cursor.install(
      {
        ...(await degradationArtifact(workDir)),
        sourceRepo: undefined,
        pluginRoot: undefined,
        sourcePluginPath: "../foo",
      },
      { dryRun: false },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/absolute/i);
  });
});

describe("runSync (plugin-only root)", () => {
  test("reconciles plugins before targeted degradation without reading legacy MCP state", async () => {
    const events: string[] = [];
    const firstAdapter = adapters[0]!;
    const originalRead = firstAdapter.read;
    firstAdapter.read = async function () {
      events.push("mcp-read");
      return originalRead.call(this);
    };
    try {
      const report = await runSyncCore({
        reconcilePlugins: async ({ dryRun }) => {
          events.push("plugins");
          expect(dryRun).toBe(false);
          return pluginReport();
        },
        degradePlugins: async () => {
          events.push("degrade");
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
    } finally {
      firstAdapter.read = originalRead;
    }
  });

  test("internal MCP-only mode skips plugins and targeted degradation", async () => {
    let reconciled = false;
    let degraded = false;
    const report = await runSyncCore({
      skipPlugins: true,
      reconcilePlugins: async () => {
        reconciled = true;
        return pluginReport();
      },
      degradePlugins: async () => {
        degraded = true;
        return degradationReport();
      },
    });

    expect(reconciled).toBe(false);
    expect(degraded).toBe(false);
    expect(report.plugins.results).toEqual([]);
    expect(report.pluginDegradation.results).toEqual([]);
    expect(report.reads).toEqual([]);
    expect(report.union).toEqual({});
    expect(report.writes).toEqual([]);
    expect(report.skills).toBeUndefined();
  });

  test("dry-run reports exact targeted degradation without writing", async () => {
    let receivedDryRun: boolean | undefined;
    const artifact = await degradationArtifact(workDir);
    const eligible = eligibleDegradation(artifact);
    const report = await runSyncCore({
      dryRun: true,
      reconcilePlugins: async ({ dryRun }) => {
        receivedDryRun = dryRun;
        return { ...pluginReport([eligible], [artifact]), dryRun };
      },
    });

    expect(receivedDryRun).toBe(true);
    expect(report.plugins.results[0]?.degradation.eligible).toBe(true);
    expect(report.pluginDegradation.results).toEqual([
      expect.objectContaining({
        component: "skills",
        agent: "gemini-cli",
        status: "would-add",
      }),
      expect.objectContaining({
        component: "mcp",
        agent: "gemini-cli",
        status: "would-add",
        added: ["bundled"],
      }),
    ]);
    expect(await Bun.file(join(workDir, ".gemini", "settings.json")).exists()).toBe(false);
    expect(report.reads).toEqual([]);
    expect(report.union).toEqual({});
    expect(report.writes).toEqual([]);
    expect(report.skills).toBeUndefined();
  });

  test("skipBridge suppresses targeted degradation while still reconciling plugins", async () => {
    let reconciled = false;
    let degraded = false;
    const report = await runSyncCore({
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
    expect(report.skills).toBeUndefined();
  });

  test("deprecated --no-skills suppresses all targeted degradation", async () => {
    let degraded = false;
    const report = await runSyncCore({
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

  test("flagship builds external inventory, dry-runs safely, then repairs native activation", async () => {
    const root = join(workDir, ".codex", "plugins", "cache", "plugins-cli", "foo", "rev");
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await Bun.write(
      join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "foo", repository: "owner/foo" }),
    );
    const marketplace = join(workDir, ".agents", "plugins", "marketplace.json");
    await mkdir(join(marketplace, ".."), { recursive: true });
    await Bun.write(
      marketplace,
      JSON.stringify({
        plugins: [
          {
            name: "foo",
            source: { source: "local", path: ".codex/plugins/cache/plugins-cli/foo/rev" },
          },
        ],
      }),
    );
    await writeCodexToml(
      workDir,
      {},
      `
[plugins."foo@plugins-cli"]
enabled = true
`,
    );

    const records: PluginRecord[] = [];
    let installs = 0;
    let managedSourcePath: string | undefined;
    const target: PluginAdapter = {
      id: "codex",
      configPath: () => join(workDir, ".codex", "config.toml"),
      async read() {
        return {
          agent: "codex",
          configPath: this.configPath(),
          exists: true,
          plugins: [...records],
        };
      },
      async installPlugin(name, opts) {
        installs += 1;
        managedSourcePath = opts.sourcePluginPath;
        records.push({ name, marketplace: "plugins-cli", enabled: true });
        return { agent: "codex", target: `${name}@plugins-cli`, status: "installed" };
      },
      async uninstallPlugin(name) {
        return { agent: "codex", target: name, status: "absent" };
      },
    };
    const originalPath = process.env.PATH;
    const originalDataHome = process.env.SYNCTHIS_DATA_HOME;
    process.env.PATH = "/nonexistent-syncthis-plugin-test";
    process.env.SYNCTHIS_DATA_HOME = join(workDir, "syncthis-data");
    try {
      const preview = await runSyncCore({
        dryRun: true,
        skipSkills: true,
        pluginTargets: [{ agent: "codex", mode: "verified", adapter: target }],
      });
      expect(installs).toBe(0);
      expect(preview.plugins.results[0]).toMatchObject({
        status: "would-repair",
        intent: "repair",
      });

      const applied = await runSyncCore({
        skipSkills: true,
        pluginTargets: [{ agent: "codex", mode: "verified", adapter: target }],
      });
      expect(installs).toBe(1);
      expect(applied.plugins.results[0]).toMatchObject({
        status: "repaired",
        activatedAs: ["foo@plugins-cli"],
      });
      expect(managedSourcePath).toMatch(/^.*\/syncthis-data\/syncthis\/plugins\//);
      expect(managedSourcePath).not.toBe(root);
      expect(applied.ok).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      if (originalDataHome === undefined) delete process.env.SYNCTHIS_DATA_HOME;
      else process.env.SYNCTHIS_DATA_HOME = originalDataHome;
    }
  });

  test("plugin reconciliation failure makes the plugin-only sync unsuccessful", async () => {
    await writeAgentJson(workDir, ".claude.json", { gh: STDIO });
    const failed: PluginReconcileResult = {
      artifactKey: createArtifactKey({ id: "foo@plugins-cli", fixture: "failed" }),
      artifactId: "foo@plugins-cli",
      plugin: "foo",
      agent: "codex",
      nativeMode: "verified",
      status: "failed",
      intent: "repair",
      requestedName: "foo",
      message: "activation verification failed",
      degradation: { eligible: false, skills: false, mcp: false },
    };

    const report = await runSyncCore({
      reconcilePlugins: async () => pluginReport([failed]),
      degradePlugins: async () => degradationReport(),
    });

    expect(report.ok).toBe(false);
    expect(syncHasFailures(report)).toBe(true);
    expect(report.plugins.failures).toEqual([failed]);
    expect(report.reads).toEqual([]);
    expect(report.union).toEqual({});
    expect(report.writes).toEqual([]);
    expect(await Bun.file(join(workDir, ".cursor", "mcp.json")).exists()).toBe(false);
  });

  test("targeted degradation failures make flagship sync unsuccessful", async () => {
    const artifact = await degradationArtifact(workDir);
    const eligible = eligibleDegradation(artifact);
    const failed = {
      artifactKey: artifact.artifactKey,
      artifactId: artifact.id,
      plugin: artifact.canonicalName,
      agent: "gemini-cli" as const,
      reason: "no-native-abi" as const,
      component: "mcp" as const,
      status: "failed" as const,
      message: "cannot write exact MCP target",
    };

    const report = await runSyncCore({
      reconcilePlugins: async () => pluginReport([eligible], [artifact]),
      degradePlugins: async () => degradationReport([failed]),
    });

    expect(report.pluginDegradation.failures).toEqual([failed]);
    expect(syncHasFailures(report)).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.reads).toEqual([]);
    expect(report.union).toEqual({});
    expect(report.conflicts).toEqual([]);
    expect(report.writes).toEqual([]);
  });

  test("flagship CLI prints plugin inventory failures and exits non-zero", async () => {
    const marketplace = join(workDir, ".agents", "plugins", "marketplace.json");
    await mkdir(join(marketplace, ".."), { recursive: true });
    await Bun.write(marketplace, "{not json");
    const bin = join(import.meta.dir, "..", "bin", "syncthis.ts");

    const result = spawnSync(process.execPath, [bin, "sync", "--dry-run", "--no-wrapper"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: workDir,
        XDG_CONFIG_HOME: join(workDir, ".config"),
        PATH: "/nonexistent-syncthis-test",
        NO_COLOR: "1",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("plugin-index");
    expect(result.stdout).toContain("invalid JSON");
    expect(result.stdout).toContain("blocked     sync");
  });

  test("flagship CLI renders targeted would, skipped, and conflict states", async () => {
    const root = join(workDir, ".agents", "plugins", "foo");
    await mkdir(join(root, "skills", "foo"), { recursive: true });
    await Bun.write(join(root, "skills", "foo", "SKILL.md"), "---\nname: foo\n---\n");
    await Bun.write(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          newBundled: { command: "new" },
          conflict: { command: "plugin-version" },
        },
      }),
    );
    await Bun.write(
      join(root, "plugin.json"),
      JSON.stringify({ name: "foo", repository: "owner/foo" }),
    );
    await Bun.write(
      join(workDir, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        plugins: [
          {
            name: "foo",
            source: { source: "local", path: ".agents/plugins/foo" },
          },
        ],
      }),
    );
    await writeCodexToml(
      workDir,
      {},
      `
[plugins."foo@plugins-cli"]
enabled = true
`,
    );
    const claudeInstalled = join(workDir, ".claude", "plugins", "installed_plugins.json");
    await mkdir(join(claudeInstalled, ".."), { recursive: true });
    await Bun.write(claudeInstalled, JSON.stringify({ version: 2, plugins: {} }));
    await writeAgentJson(workDir, ".gemini/settings.json", {
      conflict: { command: "existing-version" },
    });

    const fakeBin = join(workDir, "bin");
    await mkdir(fakeBin, { recursive: true });
    const codex = join(fakeBin, "codex");
    await Bun.write(codex, "#!/bin/sh\nexit 0\n");
    await chmod(codex, 0o755);
    const copilot = join(fakeBin, "copilot");
    await Bun.write(
      copilot,
      "#!/bin/sh\nif [ \"$1 $2\" = \"plugin list\" ]; then echo 'No plugins installed.'; exit 0; fi\nexit 1\n",
    );
    await chmod(copilot, 0o755);
    const grok = join(fakeBin, "grok");
    await Bun.write(
      grok,
      "#!/bin/sh\nif [ \"$1 $2 $3\" = \"plugin list --json\" ]; then echo '[]'; exit 0; fi\nexit 1\n",
    );
    await chmod(grok, 0o755);

    const bin = join(import.meta.dir, "..", "bin", "syncthis.ts");
    const result = spawnSync(process.execPath, [bin, "sync", "--dry-run"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: workDir,
        XDG_CONFIG_HOME: join(workDir, ".config"),
        PATH: fakeBin,
        NO_COLOR: "1",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\b(?:native|adapted|partial|blocked|unsupported)\b/);
    expect(result.stdout).toContain("partial");
    expect(result.stdout).not.toContain("plugin reach:");
    expect(result.stdout).not.toContain("would extend reach");
    expect(result.stdout).not.toContain("not applied");
    expect(result.stdout).not.toMatch(/\b(?:skills?|mcp|npx)\b/i);
  });

  test("active native plugins produce no global skill fallback or degradation", async () => {
    const active: PluginReconcileResult = {
      artifactKey: createArtifactKey({ id: "foo@plugins-cli", fixture: "active" }),
      artifactId: "foo@plugins-cli",
      plugin: "foo",
      agent: "codex",
      nativeMode: "verified",
      status: "present",
      intent: "none",
      requestedName: "foo",
      activatedAs: ["foo@plugins-cli"],
      degradation: { eligible: false, skills: false, mcp: false },
    };

    const report = await runSyncCore({
      dryRun: true,
      reconcilePlugins: async () => pluginReport([active]),
    });

    expect(report.plugins.results[0]).toEqual(active);
    expect(report.pluginDegradation.results).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
