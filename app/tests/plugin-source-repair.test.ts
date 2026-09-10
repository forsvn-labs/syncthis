import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactKey } from "../src/plugins/artifact-key.ts";
import {
  codexPluginAdapter,
  planCodexPluginInstall,
} from "../src/plugins/codex.ts";
import {
  ManagedMarketplaceUnsupportedFormatError,
  prepareManagedCodexMarketplace,
} from "../src/plugins/managed-marketplace.ts";
import {
  readPluginInventory,
  type PluginInventory,
} from "../src/plugins/inventory.ts";
import { runPluginReconcile } from "../src/plugins/reconcile.ts";
import { inspectPluginSource } from "../src/plugins/source.ts";
import type { PluginAdapterRead } from "../src/plugins/types.ts";

let workDir: string;
let originalHome: string | undefined;
let originalCodexHome: string | undefined;
let originalPath: string | undefined;
let invocationsFile: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-source-repair-"));
  originalHome = process.env.HOME;
  originalCodexHome = process.env.CODEX_HOME;
  originalPath = process.env.PATH;
  process.env.HOME = workDir;
  process.env.CODEX_HOME = join(workDir, "codex-home");
  invocationsFile = join(workDir, "codex-invocations.log");
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  process.env.PATH = originalPath;
  await rm(workDir, { recursive: true, force: true });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function findSymlinks(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) found.push(rel);
      else if (info.isDirectory()) await walk(path, rel);
    }
  }
  await walk(root, "");
  return found;
}

async function waitForDirectoryEntry(
  root: string,
  predicate: (name: string) => boolean,
): Promise<string> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const found = (await readdir(root)).find(predicate);
      if (found) return found;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await Bun.sleep(2);
  }
  throw new Error(`timed out waiting for a matching directory entry under ${root}`);
}

function codexListTable(
  rows: Array<[id: string, status: string, version: string, path: string]>,
): string {
  const all = [["PLUGIN", "STATUS", "VERSION", "PATH"], ...rows];
  const widths = [0, 1, 2].map((index) =>
    Math.max(...all.map((row) => row[index]!.length)) + 2,
  );
  return [
    "Marketplace `syncthis-test`",
    "/tmp/syncthis-test-marketplace.json",
    "",
    ...all.map(
      (row) =>
        `${row[0]!.padEnd(widths[0]!)}${row[1]!.padEnd(widths[1]!)}${row[2]!.padEnd(widths[2]!)}${row[3]}`.trimEnd(),
    ),
    "",
  ].join("\n");
}

async function installStatefulCodex(): Promise<void> {
  const binDir = join(workDir, "bin");
  const installedTarget = join(workDir, "installed-target");
  const registeredRoot = join(workDir, "registered-root");
  const emptyList = join(workDir, "empty-codex-list");
  await mkdir(binDir, { recursive: true });
  await writeFile(emptyList, codexListTable([]));
  const script = `#!/bin/sh
echo "codex $@" >> "${invocationsFile}"
if [ "$1 $2 $3" = "plugin marketplace list" ]; then
  printf "%-96s%s\\n" "MARKETPLACE" "ROOT"
  if [ -f "${registeredRoot}" ]; then
    root="$(cat "${registeredRoot}")"
    printf "%-96s%s\\n" "$(basename "$root")" "$root"
  fi
  exit 0
fi
if [ "$1 $2 $3" = "plugin marketplace add" ]; then
  printf "%s" "$4" > "${registeredRoot}"
  exit 0
fi
if [ "$1 $2" = "plugin list" ]; then
  if [ ! -f "${installedTarget}" ]; then
    cat "${emptyList}"
    exit 0
  fi
  target="$(cat "${installedTarget}")"
  root="$(cat "${registeredRoot}")"
  name="$(printf "%s" "$target" | sed 's/@.*$//')"
  printf "%-80s%-32s%-16s%s\\n" "PLUGIN" "STATUS" "VERSION" "PATH"
  printf "%-80s%-32s%-16s%s\\n" "$target" "installed, enabled" "1.0.0" "$root/plugins/$name"
  exit 0
fi
if [ "$1 $2" = "plugin add" ]; then
  printf "%s" "$4" > "${installedTarget}"
  exit 0
fi
exit 0
`;
  const executable = join(binDir, "codex");
  await writeFile(executable, script);
  await chmod(executable, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

async function readInvocations(): Promise<string[]> {
  try {
    return (await readFile(invocationsFile, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function inventoryWithCodex(): Promise<PluginInventory> {
  const codex = await codexPluginAdapter.read();
  return readPluginInventory({ adapterReads: [codex] });
}

async function reconcileCodex(dryRun: boolean) {
  return runPluginReconcile({
    dryRun,
    inventory: await inventoryWithCodex(),
    targets: [{ agent: "codex", mode: "verified", adapter: codexPluginAdapter }],
  });
}

describe("external Plugins CLI source repair", () => {
  test("repairs a dotted Codex config through one deterministic managed marketplace", async () => {
    const sourceRoot = join(
      workDir,
      ".agents",
      "plugins",
      "cache",
      "plugins-cli",
      "github.com-googleworkspace-cli",
      "0123456789abcdef",
    );
    await writeJson(join(sourceRoot, "plugin.json"), {
      name: "gws",
      repository: "googleworkspace/cli",
      mcpServers: {
        workspace: { command: "gws-mcp" },
      },
    });
    await mkdir(join(sourceRoot, "skills", "gws"), { recursive: true });
    await writeFile(join(sourceRoot, "skills", "gws", "SKILL.md"), "---\nname: gws\n---\n");
    await writeJson(join(workDir, ".agents", "plugins", "marketplace.json"), {
      name: "plugins-cli",
      plugins: [
        {
          name: "github.com-googleworkspace-cli",
          source: {
            source: "local",
            path: ".agents/plugins/cache/plugins-cli/github.com-googleworkspace-cli/0123456789abcdef",
          },
        },
      ],
    });
    await mkdir(process.env.CODEX_HOME!, { recursive: true });
    await writeFile(
      join(process.env.CODEX_HOME!, "config.toml"),
      '[plugins."github.com-googleworkspace-cli@plugins-cli"]\nenabled = true\n',
    );
    await installStatefulCodex();

    const before = await inventoryWithCodex();
    expect(before.artifacts).toHaveLength(1);
    expect(before.artifacts[0]).toMatchObject({
      canonicalName: "gws",
      sourcePluginPath: await realpath(sourceRoot),
      configuredOn: ["codex"],
      payload: { nativeManifest: true, skills: true, mcp: true },
    });

    const preview = await reconcileCodex(true);
    expect(preview.results[0]).toMatchObject({
      status: "would-repair",
      requestedName: "gws",
    });
    expect(
      await Bun.file(join(process.env.CODEX_HOME!, "syncthis", "managed-marketplaces")).exists(),
    ).toBe(false);
    expect((await readInvocations()).some((line) => /plugin (marketplace add|add --)/.test(line))).toBe(false);

    const applied = await reconcileCodex(false);
    expect(applied.results[0]).toMatchObject({
      status: "repaired",
      requestedName: "gws",
    });
    const activatedAs = applied.results[0]?.activatedAs?.[0];
    expect(activatedAs).toMatch(/^gws@syncthis-gws-[a-f0-9]{12}$/);

    const parent = join(process.env.CODEX_HOME!, "syncthis", "managed-marketplaces");
    const marketplaceNames = await readdir(parent);
    expect(marketplaceNames).toHaveLength(1);
    const marketplaceName = marketplaceNames[0]!;
    expect(activatedAs).toBe(`gws@${marketplaceName}`);
    const managedRoot = join(parent, marketplaceName);
    const marketplace = JSON.parse(
      await readFile(join(managedRoot, ".agents", "plugins", "marketplace.json"), "utf8"),
    ) as { name: string; plugins: Array<{ name: string }> };
    const managedManifest = JSON.parse(
      await readFile(join(managedRoot, "plugins", "gws", ".codex-plugin", "plugin.json"), "utf8"),
    ) as { name: string };
    expect(marketplace).toMatchObject({
      name: marketplaceName,
      plugins: [{ name: "gws" }],
    });
    expect(managedManifest.name).toBe("gws");

    const afterFirst = await readInvocations();
    expect(afterFirst).toContain(`codex plugin marketplace add ${managedRoot}`);
    expect(afterFirst).toContain(`codex plugin add -- gws@${marketplaceName}`);
    const repeatInventory = await inventoryWithCodex();
    expect(repeatInventory.artifacts).toHaveLength(1);
    const second = await runPluginReconcile({
      dryRun: false,
      inventory: repeatInventory,
      targets: [{ agent: "codex", mode: "verified", adapter: codexPluginAdapter }],
    });
    expect(second.results).toHaveLength(1);
    expect(second.results[0]).toMatchObject({
      status: "present",
      activatedAs: [`gws@${marketplaceName}`],
    });
    expect(await readdir(parent)).toEqual([marketplaceName]);
    expect((await readInvocations()).filter((line) => line.includes("plugin marketplace add"))).toHaveLength(1);
    expect((await readInvocations()).filter((line) => line.includes("plugin add --"))).toHaveLength(1);
  });

  test("a standalone inspected pluginRoot is a usable native repair source", async () => {
    const sourceRoot = join(workDir, "standalone-plugin");
    await writeJson(join(sourceRoot, ".claude-plugin", "plugin.json"), {
      name: "standalone",
      mcpServers: "./mcp.json",
    });
    await installStatefulCodex();
    const claudeRead: PluginAdapterRead = {
      agent: "claude-code",
      configPath: join(workDir, ".claude", "plugins", "installed_plugins.json"),
      exists: true,
      plugins: [{ name: "standalone", enabled: true, path: sourceRoot }],
    };
    const pluginInventory = await readPluginInventory({ adapterReads: [claudeRead] });

    const report = await runPluginReconcile({
      dryRun: false,
      inventory: pluginInventory,
      targets: [{ agent: "codex", mode: "verified", adapter: codexPluginAdapter }],
    });

    expect(pluginInventory.artifacts[0]?.sourcePluginPath).toBeUndefined();
    expect(pluginInventory.artifacts[0]?.pluginRoot).toBe(await realpath(sourceRoot));
    expect(report.results[0]).toMatchObject({
      status: "installed",
      activatedAs: [expect.stringMatching(/^standalone@syncthis-standalone-/)],
    });
  });

  test("dry-run rejects an unusable source without creating managed state", async () => {
    await installStatefulCodex();
    const missingRoot = join(workDir, "missing-plugin");
    const item = {
      artifactKey: createArtifactKey({ id: "missing", root: missingRoot }),
      id: "missing",
      canonicalName: "missing",
      aliases: ["missing"],
      identityKeys: ["missing"],
      marketplaces: [],
      sourcePluginPath: missingRoot,
      pluginRoot: missingRoot,
      payload: { nativeManifest: true, skills: false, mcp: false },
      installedOn: [],
      activeOn: [],
      configuredOn: ["codex" as const],
      catalogueOnly: false,
      eligible: true,
      evidence: [],
      errors: [],
    };

    const report = await runPluginReconcile({
      dryRun: true,
      inventory: { artifacts: [item], sources: [], errors: [] },
      targets: [{ agent: "codex", mode: "verified", adapter: codexPluginAdapter }],
    });

    expect(report.results[0]).toMatchObject({
      status: "failed",
      degradation: { eligible: false },
    });
    expect(report.results[0]?.message).toMatch(/does not exist/i);
    expect(
      await Bun.file(join(process.env.CODEX_HOME!, "syncthis", "managed-marketplaces")).exists(),
    ).toBe(false);
  });

  test("outside source symlink is positively unsupported with exact Codex degradation and no mutation", async () => {
    await installStatefulCodex();
    const sourceRoot = join(workDir, "outside-link-plugin");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), {
      name: "outside-link",
    });
    await mkdir(join(sourceRoot, "skills", "demo"), { recursive: true });
    await writeFile(join(sourceRoot, "skills", "demo", "SKILL.md"), "skill\n");
    const outside = join(workDir, "outside-instructions.md");
    await writeFile(outside, "outside\n");
    await symlink(outside, join(sourceRoot, "CLAUDE.md"));
    const item = {
      artifactKey: createArtifactKey({ id: "outside-link", root: sourceRoot }),
      id: "outside-link",
      canonicalName: "outside-link",
      aliases: ["outside-link"],
      identityKeys: ["outside-link"],
      marketplaces: ["plugins-cli"],
      sourcePluginPath: sourceRoot,
      pluginRoot: sourceRoot,
      payload: { nativeManifest: true, skills: true, mcp: true },
      installedOn: [],
      activeOn: [],
      configuredOn: ["codex" as const],
      catalogueOnly: false,
      eligible: true,
      evidence: [],
      errors: [],
    };

    const report = await runPluginReconcile({
      dryRun: true,
      inventory: { artifacts: [item], sources: [], errors: [] },
      targets: [{ agent: "codex", mode: "verified", adapter: codexPluginAdapter }],
    });

    expect(report.hasFailures).toBe(false);
    expect(report.results[0]).toMatchObject({
      status: "unsupported",
      installResult: {
        status: "skipped",
        unsupportedFormat: true,
      },
      degradation: {
        eligible: true,
        reason: "unsupported-format",
        skills: true,
        mcp: true,
      },
    });
    expect(report.results[0]?.message).toMatch(/outside source root/i);
    expect(
      await Bun.file(join(process.env.CODEX_HOME!, "syncthis", "managed-marketplaces")).exists(),
    ).toBe(false);
    expect(
      (await readInvocations()).some((line) =>
        /plugin (marketplace add|add --)/.test(line),
      ),
    ).toBe(false);
  });

  test("managed marketplace refuses a symlinked CODEX_HOME subtree", async () => {
    const sourceRoot = join(workDir, "symlink-parent-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    await mkdir(process.env.CODEX_HOME!, { recursive: true });
    const outside = join(workDir, "outside-managed");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(process.env.CODEX_HOME!, "syncthis"));

    await expect(
      prepareManagedCodexMarketplace({
        originalName: "safe",
        sourcePluginPath: sourceRoot,
        dryRun: false,
      }),
    ).rejects.toThrow(/symlink|escapes CODEX_HOME/i);
    expect(await readdir(outside)).toEqual([]);
  });

  test("plans an exact source through the managed-marketplace mode without mutation", async () => {
    const sourceRoot = join(workDir, "managed-plan-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    await installStatefulCodex();

    const plan = await planCodexPluginInstall("safe", {
      dryRun: true,
      sourcePluginPath: sourceRoot,
    });

    expect(plan).toMatchObject({
      mode: "managed-marketplace",
      target: expect.stringMatching(/^safe@syncthis-safe-[a-f0-9]{12}$/),
      registration: {
        root: expect.stringContaining("/syncthis/managed-marketplaces/"),
      },
    });
    expect(
      await Bun.file(join(process.env.CODEX_HOME!, "syncthis", "managed-marketplaces")).exists(),
    ).toBe(false);
  });

  test("publishes one complete managed marketplace under concurrent preparation", async () => {
    const sourceRoot = join(workDir, "concurrent-publication-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    await mkdir(join(sourceRoot, "skills", "safe"), { recursive: true });
    await writeFile(join(sourceRoot, "skills", "safe", "SKILL.md"), "concurrent\n".repeat(1024));

    const prepared = await Promise.all(
      Array.from({ length: 8 }, () =>
        prepareManagedCodexMarketplace({
          originalName: "safe",
          sourcePluginPath: sourceRoot,
          dryRun: false,
        }),
      ),
    );

    expect(prepared.filter((result) => result.status === "created")).toHaveLength(1);
    expect(prepared.every((result) => result.root === prepared[0]?.root)).toBe(true);
    expect(await readFile(join(prepared[0]!.pluginPath, "skills", "safe", "SKILL.md"), "utf8"))
      .toBe("concurrent\n".repeat(1024));
    const parent = join(process.env.CODEX_HOME!, "syncthis", "managed-marketplaces");
    expect(
      (await readdir(parent)).filter(
        (name) =>
          name.startsWith(".syncthis-tmp-") ||
          name.startsWith(".syncthis-publish-"),
      ),
    ).toEqual([]);
  });

  test("dereferences a contained file symlink, keeps dry-run mutation-free, and reuses the deterministic cache", async () => {
    const sourceRoot = join(workDir, "contained-file-link-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    await mkdir(join(sourceRoot, "shared"), { recursive: true });
    await writeFile(join(sourceRoot, "shared", "CLAUDE.md"), "contained instructions\n");
    await mkdir(join(sourceRoot, "skills", "autoreview"), { recursive: true });
    await symlink("../../shared/CLAUDE.md", join(sourceRoot, "skills", "autoreview", "CLAUDE.md"));

    const preview = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: true,
    });
    expect(preview.status).toBe("would-create");
    expect(
      await Bun.file(join(process.env.CODEX_HOME!, "syncthis", "managed-marketplaces")).exists(),
    ).toBe(false);

    const first = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: false,
    });
    const copied = join(first.pluginPath, "skills", "autoreview", "CLAUDE.md");
    const copiedInfo = await lstat(copied);
    expect(copiedInfo.isFile()).toBe(true);
    expect(copiedInfo.isSymbolicLink()).toBe(false);
    expect(await readFile(copied, "utf8")).toBe("contained instructions\n");
    expect(await findSymlinks(first.root)).toEqual([]);

    const second = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: false,
    });
    expect(second).toMatchObject({
      status: "present",
      marketplaceName: first.marketplaceName,
      root: first.root,
    });

    await writeFile(join(sourceRoot, "shared", "CLAUDE.md"), "changed contained instructions\n");
    const changed = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: false,
    });
    expect(changed.marketplaceName).not.toBe(first.marketplaceName);
    expect(changed.root).not.toBe(first.root);
  });

  test("dereferences a contained directory symlink without creating destination symlinks", async () => {
    const sourceRoot = join(workDir, "contained-directory-link-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    await mkdir(join(sourceRoot, "shared-autoreview"), { recursive: true });
    await writeFile(join(sourceRoot, "shared-autoreview", "SKILL.md"), "review content\n");
    await mkdir(join(sourceRoot, "skills"), { recursive: true });
    await symlink("../shared-autoreview", join(sourceRoot, "skills", "autoreview"));

    const managed = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: false,
    });

    const copied = join(managed.pluginPath, "skills", "autoreview");
    expect((await lstat(copied)).isDirectory()).toBe(true);
    expect(await readFile(join(copied, "SKILL.md"), "utf8")).toBe("review content\n");
    expect(await findSymlinks(managed.root)).toEqual([]);
  });

  test("managed marketplace rejects relative symlinks that escape the source root", async () => {
    const sourceRoot = join(workDir, "symlink-content-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    const outside = join(workDir, "outside-secret");
    await writeFile(outside, "secret");
    await symlink("../outside-secret", join(sourceRoot, "payload-link"));

    const error = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: false,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ManagedMarketplaceUnsupportedFormatError);
    expect((error as Error).message).toMatch(/outside|escapes/i);
  });

  test("dereferences an absolute symlink target when contained", async () => {
    const sourceRoot = join(workDir, "absolute-link-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    const target = join(sourceRoot, "payload.txt");
    await writeFile(target, "payload");
    await symlink(target, join(sourceRoot, "payload-link"));

    const managed = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: false,
    });
    const copied = join(managed.pluginPath, "payload-link");
    expect((await lstat(copied)).isFile()).toBe(true);
    expect((await lstat(copied)).isSymbolicLink()).toBe(false);
    expect(await readFile(copied, "utf8")).toBe("payload");
    expect(await findSymlinks(managed.root)).toEqual([]);
  });

  test("managed marketplace rejects absolute symlinks outside the source root", async () => {
    const sourceRoot = join(workDir, "absolute-escape-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    const outside = join(workDir, "absolute-outside-secret");
    await writeFile(outside, "secret");
    await symlink(outside, join(sourceRoot, "payload-link"));

    const error = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: false,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ManagedMarketplaceUnsupportedFormatError);
    expect((error as Error).message).toMatch(/outside|escapes/i);
  });

  test("managed marketplace rejects dangling and cyclic contained symlinks", async () => {
    const danglingRoot = join(workDir, "dangling-link-source");
    await writeJson(join(danglingRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    await symlink("missing", join(danglingRoot, "payload-link"));
    const danglingError = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: danglingRoot,
      dryRun: false,
    }).catch((caught: unknown) => caught);
    expect(danglingError).toBeInstanceOf(Error);
    expect(danglingError).not.toBeInstanceOf(ManagedMarketplaceUnsupportedFormatError);
    expect((danglingError as Error).message).toMatch(/dangling/i);

    const cyclicRoot = join(workDir, "cyclic-link-source");
    await writeJson(join(cyclicRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    await symlink("second", join(cyclicRoot, "first"));
    await symlink("first", join(cyclicRoot, "second"));
    const cyclicError = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: cyclicRoot,
      dryRun: false,
    }).catch((caught: unknown) => caught);
    expect(cyclicError).toBeInstanceOf(Error);
    expect(cyclicError).not.toBeInstanceOf(ManagedMarketplaceUnsupportedFormatError);
    expect((cyclicError as Error).message).toMatch(/cyclic/i);
  });

  test("managed marketplace rejects special files in the source tree", async () => {
    const sourceRoot = join(workDir, "special-file-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    const fifoPath = join(sourceRoot, "plugin.fifo");
    const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    expect(created.status).toBe(0);
    await expect(
      prepareManagedCodexMarketplace({
        originalName: "safe",
        sourcePluginPath: sourceRoot,
        dryRun: false,
      }),
    ).rejects.toThrow(/unsupported filesystem entry/i);
  });

  test("managed marketplace identity changes when source content changes", async () => {
    const sourceRoot = join(workDir, "cache", "safe", "0123456789abcdef");
    const manifestPath = join(sourceRoot, ".codex-plugin", "plugin.json");
    await writeJson(manifestPath, { name: "safe", description: "first" });

    const first = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: false,
    });
    await writeJson(manifestPath, { name: "safe", description: "second" });
    const second = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: false,
    });

    expect(second.marketplaceName).not.toBe(first.marketplaceName);
    expect(second.root).not.toBe(first.root);
    expect((await stat(first.root)).isDirectory()).toBe(true);
    expect((await stat(second.root)).isDirectory()).toBe(true);
  });

  test("managed marketplace refuses a symlink substituted for an existing root", async () => {
    const sourceRoot = join(workDir, "root-swap-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    const first = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: false,
    });
    const displaced = join(workDir, "displaced-managed-root");
    await rename(first.root, displaced);
    await symlink(displaced, first.root);

    await expect(
      prepareManagedCodexMarketplace({
        originalName: "safe",
        sourcePluginPath: sourceRoot,
        dryRun: false,
      }),
    ).rejects.toThrow(/symlink/i);
  });

  test("managed marketplace never overwrites an unmanaged deterministic target", async () => {
    const sourceRoot = join(workDir, "unmanaged-collision-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    const preview = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: true,
    });
    await mkdir(preview.root, { recursive: true });
    const sentinel = join(preview.root, "user-owned.txt");
    await writeFile(sentinel, "keep");

    await expect(
      prepareManagedCodexMarketplace({
        originalName: "safe",
        sourcePluginPath: sourceRoot,
        dryRun: false,
      }),
    ).rejects.toThrow(/unmanaged or incomplete/i);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  test("managed marketplace never replaces an existing empty deterministic target", async () => {
    const sourceRoot = join(workDir, "empty-collision-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    const preview = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: true,
    });
    await mkdir(preview.root, { recursive: true });

    await expect(
      prepareManagedCodexMarketplace({
        originalName: "safe",
        sourcePluginPath: sourceRoot,
        dryRun: false,
      }),
    ).rejects.toThrow(/unmanaged or incomplete/i);
    expect(await readdir(preview.root)).toEqual([]);
  });

  test("managed marketplace does not replace an empty root created during publication", async () => {
    const sourceRoot = join(workDir, "publication-collision-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    await mkdir(join(sourceRoot, "payload"), { recursive: true });
    await writeFile(join(sourceRoot, "payload", "large.txt"), "collision\n".repeat(500_000));
    const preview = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: true,
    });
    const parent = join(process.env.CODEX_HOME!, "syncthis", "managed-marketplaces");
    const publication = prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: false,
    }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );

    await waitForDirectoryEntry(
      parent,
      (name) => name.startsWith(".syncthis-publish-"),
    );
    await mkdir(preview.root);

    const outcome = await publication;
    expect(outcome.value).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(Error);
    expect((outcome.error as Error).message).toMatch(/unmanaged or incomplete/i);
    expect(await readdir(preview.root)).toEqual([]);
    expect(
      (await readdir(parent)).filter(
        (name) =>
          name.startsWith(".syncthis-tmp-") ||
          name.startsWith(".syncthis-publish-"),
      ),
    ).toEqual([]);
  });

  test("managed marketplace refuses tampered marketplace identity metadata", async () => {
    const sourceRoot = join(workDir, "identity-tamper-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    const managed = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: false,
    });
    await writeJson(join(managed.root, ".agents", "plugins", "marketplace.json"), {
      name: managed.marketplaceName,
      plugins: [
        {
          name: managed.pluginName,
          source: { source: "local", path: "../outside" },
        },
      ],
    });

    await expect(
      prepareManagedCodexMarketplace({
        originalName: "safe",
        sourcePluginPath: sourceRoot,
        dryRun: false,
      }),
    ).rejects.toThrow(/unrelated|incomplete managed marketplace/i);
  });

  test("managed marketplace refuses modified cached plugin content", async () => {
    const sourceRoot = join(workDir, "content-tamper-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    await writeFile(join(sourceRoot, "payload.txt"), "original");
    const managed = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: false,
    });
    await writeFile(join(managed.pluginPath, "payload.txt"), "modified");

    await expect(
      prepareManagedCodexMarketplace({
        originalName: "safe",
        sourcePluginPath: sourceRoot,
        dryRun: false,
      }),
    ).rejects.toThrow(/unrelated managed marketplace data/i);
  });

  test("managed marketplace refuses a symlink introduced into cached content", async () => {
    const sourceRoot = join(workDir, "cached-symlink-tamper-source");
    await writeJson(join(sourceRoot, ".codex-plugin", "plugin.json"), { name: "safe" });
    await writeFile(join(sourceRoot, "payload.txt"), "original");
    const managed = await prepareManagedCodexMarketplace({
      originalName: "safe",
      sourcePluginPath: sourceRoot,
      dryRun: false,
    });
    const payload = join(managed.pluginPath, "payload.txt");
    await rm(payload);
    await symlink(join(sourceRoot, "payload.txt"), payload);

    await expect(
      prepareManagedCodexMarketplace({
        originalName: "safe",
        sourcePluginPath: sourceRoot,
        dryRun: false,
      }),
    ).rejects.toThrow(/symlink|unrelated managed marketplace data/i);
  });
});

describe("source inspection and inventory identity", () => {
  test("detects root and nested native manifests plus manifest-declared MCP recursively", async () => {
    const root = join(workDir, "recursive-source");
    await writeJson(join(root, "plugin.json"), { name: "root-plugin" });
    await writeJson(
      join(root, "packages", "nested", ".claude-plugin", "plugin.json"),
      { name: "nested-plugin", mcpServers: ["./one.json"] },
    );

    const inspection = await inspectPluginSource(root);

    expect(inspection.manifests).toEqual([
      "plugin.json",
      "packages/nested/.claude-plugin/plugin.json",
    ]);
    expect(inspection.canonicalName).toBe("root-plugin");
    expect(inspection.payload).toMatchObject({
      nativeManifest: true,
      mcp: true,
    });
  });

  test("coalesces repeated strong evidence but preserves distinct same-name versions", async () => {
    const first = join(workDir, ".agents", "plugins", "cache", "same", "aaaaaaaa");
    const second = join(workDir, ".agents", "plugins", "cache", "same", "bbbbbbbb");
    await writeJson(join(first, "plugin.json"), { name: "same" });
    await writeJson(join(second, "plugin.json"), { name: "same" });
    await writeJson(join(workDir, ".agents", "plugins", "marketplace.json"), {
      plugins: [
        { name: "same", source: { source: "local", path: ".agents/plugins/cache/same/aaaaaaaa" } },
        { name: "same", source: { source: "local", path: ".agents/plugins/cache/same/aaaaaaaa" } },
        { name: "same", source: { source: "local", path: ".agents/plugins/cache/same/bbbbbbbb" } },
      ],
    });

    const pluginInventory = await readPluginInventory({ adapterReads: [] });

    expect(pluginInventory.artifacts).toHaveLength(2);
    expect(pluginInventory.artifacts.map((artifact) => artifact.sourceVersion)).toEqual([
      "aaaaaaaa",
      "bbbbbbbb",
    ]);
  });

  test("accepts only validated Claude marketplace install locations", async () => {
    const sourceRoot = join(workDir, "claude-plugin");
    const invalidSourceRoot = join(workDir, "claude-invalid-plugin");
    const validMarketplace = join(workDir, ".claude", "plugins", "marketplaces", "valid");
    await writeJson(join(sourceRoot, "plugin.json"), { name: "valid" });
    await writeJson(join(invalidSourceRoot, "plugin.json"), { name: "invalid" });
    await mkdir(validMarketplace, { recursive: true });
    await writeJson(join(workDir, ".claude", "plugins", "known_marketplaces.json"), {
      valid: {
        source: { source: "github", repo: "owner/valid" },
        installLocation: validMarketplace,
      },
      invalid: {
        source: { source: "github", repo: "owner/invalid" },
        installLocation: "../outside-home",
      },
    });
    const reads: PluginAdapterRead[] = [
      {
        agent: "claude-code",
        configPath: join(workDir, ".claude", "plugins", "installed_plugins.json"),
        exists: true,
        plugins: [
          { name: "valid", marketplace: "valid", path: sourceRoot, enabled: true },
          { name: "invalid", marketplace: "invalid", path: invalidSourceRoot, enabled: true },
        ],
      },
    ];

    const pluginInventory = await readPluginInventory({ adapterReads: reads });
    const valid = pluginInventory.artifacts.find((artifact) => artifact.marketplaces.includes("valid"));
    const invalid = pluginInventory.artifacts.find((artifact) => artifact.marketplaces.includes("invalid"));

    expect(valid?.marketplaceRoot).toBe(await realpath(validMarketplace));
    expect(invalid?.marketplaceRoot).toBeUndefined();
    expect(
      pluginInventory.errors.some(
        (error) => error.source === "claude-marketplaces" && /contains '\.\.'/.test(error.message),
      ),
    ).toBe(true);
  });
});
