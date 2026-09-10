import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../src/types.ts";
import { createArtifactKey } from "../src/plugins/artifact-key.ts";
import type {
  PluginInventory,
  PluginInventoryArtifact,
} from "../src/plugins/inventory.ts";
import {
  runPluginReconcile,
  type PluginReconcileTarget,
} from "../src/plugins/reconcile.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginInstallOpts,
  PluginInstallResult,
  PluginRecord,
} from "../src/plugins/types.ts";

function artifact(
  options: {
    activeOn?: AgentId[];
    configuredOn?: AgentId[];
    pluginRoot?: string;
    nativeManifest?: boolean;
    skills?: boolean;
    mcp?: boolean;
  } = {},
): PluginInventoryArtifact {
  const configuredOn = options.configuredOn ?? [];
  return {
    artifactKey: createArtifactKey({ id: "foo@plugins-cli", root: options.pluginRoot ?? "fixture" }),
    id: "foo@plugins-cli",
    canonicalName: "foo",
    aliases: ["foo"],
    identityKeys: ["foo"],
    marketplaces: ["plugins-cli"],
    sourceRepo: "owner/foo",
    pluginRoot: options.pluginRoot,
    marketplaceRoot: "/home/test/.claude/plugins/marketplaces/plugins-cli",
    payload: {
      nativeManifest: options.nativeManifest ?? true,
      skills: options.skills ?? true,
      mcp: options.mcp ?? true,
    },
    installedOn: options.activeOn ?? [],
    activeOn: options.activeOn ?? [],
    configuredOn,
    catalogueOnly: false,
    eligible: true,
    evidence: [
      {
        kind: "plugins-cli-catalogue",
        name: "foo",
        marketplace: "plugins-cli",
      },
      ...configuredOn.map(
        (agent) =>
          ({
            kind: "codex-config" as const,
            name: "foo",
            marketplace: "plugins-cli",
            agent,
            enabled: true,
          }),
      ),
    ],
    errors: [],
  };
}

function inventory(item = artifact()): PluginInventory {
  return {
    artifacts: [item],
    sources: [],
    errors: [],
  };
}

type AdapterHarness = {
  adapter: PluginAdapter;
  installCalls: number;
  installRequests: Array<{ name: string; opts: PluginInstallOpts }>;
  readCalls: number;
  records: PluginRecord[];
};

function adapterHarness(
  agent: AgentId,
  options: {
    records?: PluginRecord[];
    readError?: string;
    installResult?: PluginInstallResult;
    activateOnInstall?: PluginRecord;
    verifyErrorAfterInstall?: string;
  } = {},
): AdapterHarness {
  const harness: AdapterHarness = {
    installCalls: 0,
    installRequests: [],
    readCalls: 0,
    records: [...(options.records ?? [])],
    adapter: undefined as unknown as PluginAdapter,
  };
  harness.adapter = {
    id: agent,
    configPath: () => `/tmp/${agent}-plugins`,
    async read(): Promise<PluginAdapterRead> {
      harness.readCalls += 1;
      const error =
        harness.installCalls > 0 && options.verifyErrorAfterInstall
          ? options.verifyErrorAfterInstall
          : options.readError;
      return {
        agent,
        configPath: `/tmp/${agent}-plugins`,
        exists: !error,
        plugins: [...harness.records],
        error,
      };
    },
    async installPlugin(name, opts): Promise<PluginInstallResult> {
      harness.installCalls += 1;
      harness.installRequests.push({ name, opts });
      if (options.activateOnInstall) harness.records.push(options.activateOnInstall);
      return (
        options.installResult ?? {
          agent,
          target: name,
          status: "installed",
        }
      );
    },
    async uninstallPlugin(name) {
      return { agent, target: name, status: "absent" };
    },
  };
  return harness;
}

function verifiedTarget(harness: AdapterHarness): PluginReconcileTarget {
  return {
    agent: harness.adapter.id,
    mode: "verified",
    adapter: harness.adapter,
  };
}

describe("plugin reconciliation core", () => {
  test("native-active is a no-op", async () => {
    const harness = adapterHarness("codex", {
      records: [{ name: "foo", marketplace: "plugins-cli", enabled: true }],
    });

    const report = await runPluginReconcile({
      dryRun: false,
      inventory: inventory(artifact({ activeOn: ["codex"] })),
      targets: [verifiedTarget(harness)],
    });

    expect(report.results[0]).toMatchObject({
      status: "present",
      intent: "none",
      activatedAs: ["foo@plugins-cli"],
      degradation: { eligible: false },
    });
    expect(harness.installCalls).toBe(0);
    expect(report.hasChanges).toBe(false);
    expect(report.hasFailures).toBe(false);
  });

  test("configured-inactive performs a repair and requires a verified reread", async () => {
    const harness = adapterHarness("codex", {
      activateOnInstall: { name: "foo", marketplace: "plugins-cli", enabled: true },
    });

    const report = await runPluginReconcile({
      dryRun: false,
      inventory: inventory(artifact({ configuredOn: ["codex"] })),
      targets: [verifiedTarget(harness)],
    });

    expect(harness.installCalls).toBe(1);
    expect(harness.readCalls).toBeGreaterThanOrEqual(2);
    expect(report.results[0]).toMatchObject({
      status: "repaired",
      intent: "repair",
      activatedAs: ["foo@plugins-cli"],
      degradation: { eligible: false },
    });
    expect(harness.installRequests[0]?.opts.marketplace).toBe("plugins-cli");
  });

  test("repairs an unloadable configured alias through the manifest's canonical identity", async () => {
    const harness = adapterHarness("codex", {
      activateOnInstall: { name: "gws", marketplace: "plugins-cli", enabled: true },
    });
    const item = artifact({ configuredOn: ["codex"] });
    item.id = "gws@plugins-cli";
    item.canonicalName = "gws";
    item.aliases = ["github.com-googleworkspace-cli", "gws"];
    item.identityKeys = ["github.com-googleworkspace-cli", "github-com-googleworkspace-cli", "gws"];
    item.evidence = [
      {
        kind: "codex-config",
        name: "github.com-googleworkspace-cli",
        marketplace: "plugins-cli",
        agent: "codex",
        enabled: true,
      },
    ];

    const report = await runPluginReconcile({
      dryRun: false,
      inventory: inventory(item),
      targets: [verifiedTarget(harness)],
    });

    expect(report.results[0]?.status).toBe("repaired");
    expect(harness.installRequests[0]?.name).toBe("gws");
    expect(harness.installRequests[0]?.opts.marketplace).toBeUndefined();
    expect(harness.installRequests[0]?.opts.sourceRepo).toBe("owner/foo");
  });

  test("source marketplace metadata is never forwarded as a target marketplace", async () => {
    const harness = adapterHarness("codex");
    const item = artifact();
    item.marketplaceRoot = undefined;
    let preview: PluginInstallOpts | undefined;
    harness.adapter.previewInstallPlugin = async (name, opts) => {
      preview = opts;
      return { agent: "codex", target: name, status: "installed", message: "dry-run" };
    };

    const report = await runPluginReconcile({
      dryRun: true,
      inventory: inventory(item),
      targets: [verifiedTarget(harness)],
    });

    expect(report.results[0]?.status).toBe("would-install");
    expect(preview?.marketplace).toBeUndefined();
    expect(preview?.sourceMarketplace).toBe("plugins-cli");
    expect(preview?.sourceRepo).toBe("owner/foo");
    expect(harness.installCalls).toBe(0);
  });

  test("a source marketplace label alone cannot make dry-run installation feasible", async () => {
    const harness = adapterHarness("codex");
    const item = artifact();
    item.sourceRepo = undefined;
    item.marketplaceRoot = undefined;
    item.pluginRoot = undefined;
    item.sourcePluginPath = undefined;

    const report = await runPluginReconcile({
      dryRun: true,
      inventory: inventory(item),
      targets: [verifiedTarget(harness)],
    });

    expect(report.results[0]).toMatchObject({
      status: "failed",
      degradation: { eligible: false },
    });
    expect(report.results[0]?.message).toMatch(/no usable plugin source/i);
    expect(harness.installCalls).toBe(0);
  });

  test("a standalone sourcePluginPath alone makes dry-run natively feasible without mutation", async () => {
    const harness = adapterHarness("claude-code");
    const source = await mkdtemp(join(tmpdir(), "syncthis-reconcile-source-"));
    await mkdir(join(source, "skills"), { recursive: true });
    const item = artifact();
    item.sourceRepo = undefined;
    item.marketplaceRoot = undefined;
    item.pluginRoot = undefined;
    item.sourcePluginPath = source;
    let preview: PluginInstallOpts | undefined;
    harness.adapter.previewInstallPlugin = async (name, opts) => {
      preview = opts;
      return { agent: "claude-code", target: name, status: "installed", message: "dry-run" };
    };

    try {
      const report = await runPluginReconcile({
        dryRun: true,
        inventory: inventory(item),
        targets: [verifiedTarget(harness)],
      });

      expect(report.results[0]?.status).toBe("would-install");
      expect(preview?.sourcePluginPath).toBe(await realpath(source));
      expect(harness.installCalls).toBe(0);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  test("materializes an apply-time local package and installs from the managed root", async () => {
    const harness = adapterHarness("codex", {
      activateOnInstall: { name: "foo", marketplace: "plugins-cli", enabled: true },
    });
    const source = await mkdtemp(join(tmpdir(), "syncthis-reconcile-package-"));
    const store = await mkdtemp(join(tmpdir(), "syncthis-reconcile-store-"));
    await writeFile(join(source, "plugin.json"), JSON.stringify({ name: "foo" }));

    try {
      const report = await runPluginReconcile({
        dryRun: false,
        inventory: inventory(artifact({ pluginRoot: source, configuredOn: ["codex"] })),
        targets: [verifiedTarget(harness)],
        storeRoot: store,
      });

      expect(report.results[0]?.status).toBe("repaired");
      const managed = harness.installRequests[0]?.opts.sourcePluginPath;
      expect(managed).toBeDefined();
      expect(managed).not.toBe(source);
      expect(managed?.startsWith(`${store}/`)).toBe(true);
      expect(await Bun.file(join(managed!, "plugin.json")).exists()).toBe(true);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
    }
  });

  test("dry-run validates the same invalid store destination as apply without writing", async () => {
    const harness = adapterHarness("codex");
    const source = await mkdtemp(join(tmpdir(), "syncthis-reconcile-dry-store-source-"));
    const storeFile = join(tmpdir(), `syncthis-reconcile-invalid-store-${process.pid}-${Date.now()}`);
    await writeFile(join(source, "plugin.json"), JSON.stringify({ name: "foo" }));
    await writeFile(storeFile, "not a directory");

    try {
      const options = {
        inventory: inventory(artifact({ pluginRoot: source, configuredOn: ["codex"] })),
        targets: [verifiedTarget(harness)],
        storeRoot: storeFile,
      };
      const preview = await runPluginReconcile({ dryRun: true, ...options });
      const applied = await runPluginReconcile({ dryRun: false, ...options });
      expect(preview.results[0]).toMatchObject({ status: "failed" });
      expect(preview.results[0]?.message).toMatch(/store root|directory/i);
      expect(applied.results[0]).toMatchObject({ status: "failed" });
      expect(applied.results[0]?.message).toMatch(/store root|directory/i);
      expect(await Bun.file(storeFile).text()).toBe("not a directory");
      expect(harness.installCalls).toBe(0);
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(storeFile, { force: true });
    }
  });

  test("one package is materialized once and reused across targets", async () => {
    const first = adapterHarness("codex", {
      activateOnInstall: { name: "foo", enabled: true },
    });
    const second = adapterHarness("claude-code", {
      activateOnInstall: { name: "foo", enabled: true },
    });
    const source = await mkdtemp(join(tmpdir(), "syncthis-reconcile-cache-source-"));
    const store = await mkdtemp(join(tmpdir(), "syncthis-reconcile-cache-store-"));
    const outside = join(tmpdir(), `syncthis-reconcile-cache-outside-${process.pid}-${Date.now()}`);
    const payload = join(source, "payload.txt");
    await writeFile(join(source, "plugin.json"), JSON.stringify({ name: "foo" }));
    await writeFile(payload, "source bytes");
    await writeFile(outside, "outside bytes");

    const install = first.adapter.installPlugin.bind(first.adapter);
    first.adapter.installPlugin = async (name, opts) => {
      const result = await install(name, opts);
      await rm(payload);
      await symlink(outside, payload);
      return result;
    };

    try {
      const report = await runPluginReconcile({
        dryRun: false,
        inventory: inventory(artifact({ pluginRoot: source })),
        targets: [verifiedTarget(first), verifiedTarget(second)],
        storeRoot: store,
      });

      expect(report.results.map((result) => result.status)).toEqual(["installed", "installed"]);
      expect(first.installRequests[0]?.opts.sourcePluginPath).toBe(second.installRequests[0]?.opts.sourcePluginPath);
      expect(first.installRequests[0]?.opts.sourcePluginPath).toMatch(new RegExp(`^${store}/`));
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  test("a native install failure is hard and never authorizes degradation", async () => {
    const harness = adapterHarness("codex", {
      installResult: {
        agent: "codex",
        target: "foo@plugins-cli",
        status: "failed",
        message: "installer exploded",
        skillsFallbackRepo: "owner/foo",
      },
    });

    const report = await runPluginReconcile({
      dryRun: false,
      inventory: inventory(),
      targets: [verifiedTarget(harness)],
    });

    expect(report.results[0]).toMatchObject({
      status: "failed",
      message: "installer exploded",
      degradation: { eligible: false, skills: false, mcp: false },
    });
    expect(report.failures).toHaveLength(1);
    expect(report.hasFailures).toBe(true);
  });

  test("a skipped adapter result with a legacy skills fallback is still hard without activation", async () => {
    const harness = adapterHarness("codex", {
      installResult: {
        agent: "codex",
        target: "foo",
        status: "skipped",
        message: "add it as skills",
        skillsFallbackRepo: "owner/foo",
      },
    });

    const report = await runPluginReconcile({
      dryRun: false,
      inventory: inventory(),
      targets: [verifiedTarget(harness)],
    });

    expect(report.results[0]?.status).toBe("failed");
    expect(report.results[0]?.degradation.eligible).toBe(false);
  });

  test("verification failure after installer success is hard with no degradation", async () => {
    const harness = adapterHarness("codex");

    const report = await runPluginReconcile({
      dryRun: false,
      inventory: inventory(),
      targets: [verifiedTarget(harness)],
    });

    expect(harness.installCalls).toBe(1);
    expect(report.results[0]).toMatchObject({
      status: "failed",
      degradation: { eligible: false },
    });
    expect(report.results[0]?.message).toMatch(/fresh read did not report/i);
  });

  test("runtime read failure is hard and does not attempt install or degradation", async () => {
    const harness = adapterHarness("codex", { readError: "CLI unavailable" });

    const report = await runPluginReconcile({
      dryRun: false,
      inventory: inventory(),
      targets: [verifiedTarget(harness)],
    });

    expect(harness.installCalls).toBe(0);
    expect(report.results[0]).toMatchObject({
      status: "failed",
      degradation: { eligible: false },
    });
    expect(report.results[0]?.message).toContain("CLI unavailable");
  });

  test("positively unsupported format emits targeted degradation eligibility", async () => {
    const harness = adapterHarness("codex");
    const item = artifact({
      pluginRoot: "/home/test/plugin",
      nativeManifest: false,
      skills: true,
      mcp: true,
    });

    const report = await runPluginReconcile({
      dryRun: false,
      inventory: inventory(item),
      targets: [verifiedTarget(harness)],
    });

    expect(harness.installCalls).toBe(0);
    expect(report.results[0]).toMatchObject({
      status: "unsupported",
      degradation: {
        eligible: true,
        reason: "unsupported-format",
        skills: true,
        mcp: true,
      },
    });
  });

  test("a runtime without a native ABI emits explicit degradation eligibility", async () => {
    const report = await runPluginReconcile({
      dryRun: false,
      inventory: inventory(),
      targets: [{ agent: "gemini-cli", mode: "none" }],
    });

    expect(report.results[0]).toMatchObject({
      agent: "gemini-cli",
      nativeMode: "none",
      status: "unsupported",
      degradation: {
        eligible: true,
        reason: "no-native-abi",
        skills: true,
        mcp: true,
      },
    });
  });

  test("write-only native success remains unverified and never duplicates through degradation", async () => {
    let installs = 0;
    const report = await runPluginReconcile({
      dryRun: false,
      inventory: inventory(),
      targets: [
        {
          agent: "cursor",
          mode: "write-only",
          async install() {
            installs += 1;
            return { ok: true, message: "installer exited 0" };
          },
        },
      ],
    });

    expect(installs).toBe(1);
    expect(report.results[0]).toMatchObject({
      status: "unverified",
      degradation: { eligible: false, skills: false, mcp: false },
    });
  });

  test("dry-run reports install and repair actions without invoking installers", async () => {
    const native = adapterHarness("claude-code");
    let writeOnlyInstalls = 0;
    const report = await runPluginReconcile({
      dryRun: true,
      inventory: inventory(artifact({ configuredOn: ["claude-code"] })),
      targets: [
        verifiedTarget(native),
        {
          agent: "cursor",
          mode: "write-only",
          async install() {
            writeOnlyInstalls += 1;
            return { ok: true };
          },
        },
      ],
    });

    expect(native.installCalls).toBe(0);
    expect(writeOnlyInstalls).toBe(0);
    expect(report.results.map((result) => result.status)).toEqual(["would-repair", "would-install"]);
    expect(report.results.every((result) => !result.degradation.eligible)).toBe(true);
  });

  test("a second run is idempotent after verified activation", async () => {
    const harness = adapterHarness("codex", {
      activateOnInstall: { name: "foo", marketplace: "plugins-cli", enabled: true },
    });
    const options: Parameters<typeof runPluginReconcile>[0] = {
      dryRun: false,
      inventory: inventory(artifact({ configuredOn: ["codex"] })),
      targets: [verifiedTarget(harness)],
    };

    const first = await runPluginReconcile(options);
    const second = await runPluginReconcile(options);

    expect(first.results[0]?.status).toBe("repaired");
    expect(second.results[0]?.status).toBe("present");
    expect(harness.installCalls).toBe(1);
    expect(second.hasChanges).toBe(false);
  });
});
