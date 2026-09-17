import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactKey } from "../src/plugins/artifact-key.ts";
import { runPluginDoctor } from "../src/plugins/doctor-report.ts";
import {
  findHostPlugin,
  removeManagedHostPlugin,
  removeManagedHostSkill,
  scanAgentHosts,
  writeHostPlugin,
  writeHostSkills,
} from "../src/plugins/host-sync.ts";
import { runPluginReconcile } from "../src/plugins/reconcile.ts";
import { SYNCTHIS_MARKER } from "../src/plugins/source.ts";
import { pluginReconcileTargets } from "../src/plugins/targets.ts";
import type { PluginInventoryArtifact } from "../src/plugins/inventory.ts";

let workDir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-host-sync-"));
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = workDir;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  await rm(workDir, { recursive: true, force: true });
});

async function pluginPackage(name = "foo"): Promise<string> {
  const root = join(workDir, "src", name);
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await mkdir(join(root, "skills", "one"), { recursive: true });
  await writeFile(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name }),
  );
  await writeFile(join(root, "skills", "one", "SKILL.md"), "---\nname: one\n---\n");
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({ mcpServers: { bundled: { command: "echo" } } }),
  );
  return root;
}

function artifact(pluginRoot: string): PluginInventoryArtifact {
  return {
    artifactKey: createArtifactKey({ id: "foo@plugins-cli", pluginRoot }),
    id: "foo@plugins-cli",
    canonicalName: "foo",
    aliases: ["foo"],
    identityKeys: ["foo"],
    marketplaces: ["plugins-cli"],
    pluginRoot,
    sourcePluginPath: pluginRoot,
    payload: { nativeManifest: true, skills: true, mcp: true },
    installedOn: [],
    activeOn: [],
    configuredOn: [],
    catalogueOnly: false,
    eligible: true,
    evidence: [{
      kind: "plugins-cli-catalogue",
      name: "foo",
      marketplace: "plugins-cli",
      path: pluginRoot,
    }],
    errors: [],
  };
}

describe("host directory sync", () => {
  test("copies a Cursor plugin into ~/.cursor/plugins/local with a synthesized root manifest", async () => {
    const source = await pluginPackage();
    const written = await writeHostPlugin("cursor", source, { dryRun: false });
    expect(written.status).toBe("created");
    expect(written.path).toBe(join(workDir, ".cursor/plugins/local/foo"));

    const dest = written.path;
    expect(JSON.parse(await readFile(join(dest, "plugin.json"), "utf8"))).toEqual({ name: "foo" });
    expect(await readFile(join(dest, "skills/one/SKILL.md"), "utf8")).toContain("name: one");
    expect((await lstat(join(dest, "mcp.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(dest, SYNCTHIS_MARKER), "utf8")).kind).toBe("host-plugin");

    const again = await writeHostPlugin("cursor", source, { dryRun: true });
    expect(again.status).toBe("present");
    expect(await findHostPlugin("cursor", "foo")).toMatchObject({ managed: true, name: "foo" });
  });

  test("refuses to overwrite an unmanaged host plugin directory", async () => {
    const source = await pluginPackage();
    const dest = join(workDir, ".cursor/plugins/local/foo");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "plugin.json"), JSON.stringify({ name: "foo" }));

    const written = await writeHostPlugin("cursor", source, { dryRun: false });
    expect(written.status).toBe("conflict");
    expect(JSON.parse(await readFile(join(dest, "plugin.json"), "utf8"))).toEqual({ name: "foo" });
    expect(await Bun.file(join(dest, SYNCTHIS_MARKER)).exists()).toBe(false);
  });

  test("writes skill trees into the agent load directory and removes only managed copies", async () => {
    const source = await pluginPackage();
    const skills = await writeHostSkills("gemini-cli", source, { dryRun: false });
    expect(skills).toEqual([
      expect.objectContaining({
        agent: "gemini-cli",
        name: "one",
        status: "created",
      }),
    ]);
    const dest = join(workDir, ".gemini/skills/one");
    expect(await Bun.file(join(dest, "SKILL.md")).exists()).toBe(true);

    const unmanaged = join(workDir, ".gemini/skills/other");
    await mkdir(unmanaged, { recursive: true });
    await writeFile(join(unmanaged, "SKILL.md"), "---\nname: other\n---\n");

    const removed = await removeManagedHostPlugin("cursor", "missing", { dryRun: false });
    expect(removed.message).toBe("absent");

    const skillRm = await removeManagedHostSkill(
      "gemini-cli",
      "one",
      { dryRun: false },
    );
    expect(skillRm.status).toBe("created");
    expect(await Bun.file(join(dest, "SKILL.md")).exists()).toBe(false);
    expect(await Bun.file(join(unmanaged, "SKILL.md")).exists()).toBe(true);
  });

  test("Cursor dry-run reports present once the local package is already on disk", async () => {
    const source = await pluginPackage();
    await writeHostPlugin("cursor", source, { dryRun: false });
    const cursor = pluginReconcileTargets().find((target) => target.agent === "cursor");
    if (!cursor || cursor.mode !== "write-only") throw new Error("missing cursor target");

    const report = await runPluginReconcile({
      dryRun: true,
      inventory: { artifacts: [artifact(source)], sources: [], errors: [] },
      targets: [cursor],
    });
    expect(report.results[0]).toMatchObject({
      agent: "cursor",
      nativeMode: "write-only",
      status: "present",
      outcome: "adapted",
    });
    expect(report.results[0]?.message).not.toMatch(/\bnative\b/i);
  });

  test("doctor lists per-agent host drift without calling Cursor native", async () => {
    const source = await pluginPackage();
    await writeHostPlugin("cursor", source, { dryRun: false });
    await mkdir(join(workDir, ".cursor/plugins/local/stray"), { recursive: true });
    await writeFile(
      join(workDir, ".cursor/plugins/local/stray/plugin.json"),
      JSON.stringify({ name: "stray" }),
    );

    const hosts = await scanAgentHosts();
    const cursor = hosts.find((row) => row.agent === "cursor");
    expect(cursor?.pluginAbi).toBe("write-only");
    expect(cursor?.plugins.map((item) => [item.name, item.managed]).sort()).toEqual([
      ["foo", true],
      ["stray", false],
    ]);

    const report = await runPluginDoctor({
      buildOverview: async () => ({ native: [] }),
      previewSync: async () => ({
        ok: true,
        plugins: {
          dryRun: true,
          inventory: { artifacts: [], sources: [], errors: [] },
          results: [],
          failures: [],
          hasFailures: false,
          hasChanges: false,
        },
        pluginDegradation: {
          dryRun: true,
          eligibleOutcomes: [],
          results: [],
          failures: [],
          hasFailures: false,
          hasChanges: false,
        },
        reads: [],
        union: {},
        conflicts: [],
        writes: [],
      }),
      scanHosts: async () => hosts,
    });
    const text = (await import("../src/plugins/doctor-report.ts")).renderPluginDoctor(report).join("\n");
    expect(text).toContain("Host directories");
    expect(text).toContain("cursor  write-only");
    expect(text).toContain("stray");
    expect(text).toContain("on-disk copy is adapted, not native");
    expect(text).not.toMatch(/^cursor\s+verified/m);
  });
});
