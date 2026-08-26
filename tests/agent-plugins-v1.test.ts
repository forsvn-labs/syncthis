import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_PLUGINS_SPEC_VERSION,
  PLUGIN_MANIFEST_SCHEMA_V1,
  PLUGIN_MCP_SCHEMA_V1,
  ensurePrivateDirectory,
  expandPlaceholders,
  isContainedPath,
  isSymlinkSafeContained,
  isValidPluginNameV1,
  isValidStdioCommandV1,
  validateMcpDocumentV1,
  validatePluginManifestV1,
  validatePrivateDirectoryPath,
} from "../src/plugins/agent-plugins-v1.ts";
import {
  hasSkillManifest,
  hashPluginPackage,
  inspectPluginSource,
  readPluginPackage,
} from "../src/plugins/source.ts";
import { resolvePluginMcpServers } from "../src/plugins/mcp.ts";
import type { PluginRecord } from "../src/plugins/types.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-apv1-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makePackage(name: string, files: Record<string, unknown>): Promise<string> {
  const root = join(workDir, name);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

function v1Manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: PLUGIN_MANIFEST_SCHEMA_V1,
    name: "sample.plugin",
    ...overrides,
  };
}

describe("agent plugins v1 constants", () => {
  test("pins the published spec and schema identifiers", () => {
    expect(AGENT_PLUGINS_SPEC_VERSION).toBe("1.0.0");
    expect(PLUGIN_MANIFEST_SCHEMA_V1).toBe(
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    );
    expect(PLUGIN_MCP_SCHEMA_V1).toBe(
      "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    );
  });
});

describe("validatePluginManifestV1", () => {
  test("accepts a minimal canonical manifest", () => {
    const result = validatePluginManifestV1(v1Manifest());
    expect(result.canonical).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.name).toBe("sample.plugin");
  });

  test("name rules", () => {
    expect(isValidPluginNameV1("a")).toBe(true);
    expect(isValidPluginNameV1("a-b.c9")).toBe(true);
    expect(isValidPluginNameV1("")).toBe(false);
    expect(isValidPluginNameV1("-lead")).toBe(false);
    expect(isValidPluginNameV1("trail-")).toBe(false);
    expect(isValidPluginNameV1("has--double")).toBe(false);
    expect(isValidPluginNameV1("has..dots")).toBe(false);
    expect(isValidPluginNameV1("Uppercase")).toBe(false);
    expect(isValidPluginNameV1("a".repeat(64))).toBe(true);
    expect(isValidPluginNameV1("a".repeat(65))).toBe(false);
  });

  test("wrong metadata types are fatal", () => {
    const result = validatePluginManifestV1(v1Manifest({ version: 3, keywords: "x" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"version"'))).toBe(true);
    expect(result.errors.some((e) => e.includes('"keywords"'))).toBe(true);
  });

  test("author permits only name/email/url strings", () => {
    const ok = validatePluginManifestV1(
      v1Manifest({ author: { name: "A", email: "a@b.c", url: "https://a" } }),
    );
    expect(ok.valid).toBe(true);
    const badField = validatePluginManifestV1(v1Manifest({ author: { handle: "@a" } }));
    expect(badField.valid).toBe(false);
    const badType = validatePluginManifestV1(v1Manifest({ author: { name: 7 } }));
    expect(badType.valid).toBe(false);
    const badShape = validatePluginManifestV1(v1Manifest({ author: "A" }));
    expect(badShape.valid).toBe(false);
  });

  test("unknown top-level fields warn and stay nonfatal", () => {
    const result = validatePluginManifestV1(v1Manifest({ surprise: { deep: true } }));
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('"surprise"'))).toBe(true);
  });

  test("nonobject extensions warn and are ignored", () => {
    const result = validatePluginManifestV1(v1Manifest({ extensions: "nope" }));
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('"extensions"'))).toBe(true);
  });

  test("unknown namespace values are not validated", () => {
    const result = validatePluginManifestV1(
      v1Manifest({ extensions: { "com.example.client": { hooks: [{ arbitrary: true }] } } }),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("canonical manifest identity priority", () => {
  test("root canonical plugin.json outranks overlay manifests", async () => {
    const root = await makePackage("priority", {
      ".claude-plugin/plugin.json": { name: "overlay-name" },
      "plugin.json": v1Manifest({ name: "canonical-name" }),
    });
    const pkg = await readPluginPackage(root);
    expect(pkg.identity.pluginJsonPath).toBe("plugin.json");
    expect(pkg.identity.pluginName).toBe("canonical-name");
  });

  test("fatal canonical violations reject package identity", async () => {
    const root = await makePackage("badcanon", {
      ".codex-plugin/plugin.json": { name: "overlay-name" },
      "plugin.json": v1Manifest({ name: "Bad--Name" }),
    });
    await expect(readPluginPackage(root)).rejects.toThrow(/canonical Agent Plugins v1 manifest is invalid/);
  });

  test("inspection reports invalid canonical state and rejects components", async () => {
    const root = await makePackage("inspectbad", {
      "plugin.json": v1Manifest({ name: "x--y" }),
      "skills/nested/deep/SKILL.md": "---\nname: x\n---\nbody",
    });
    const inspection = await inspectPluginSource(root);
    expect(inspection.v1Canonical?.valid).toBe(false);
    expect(inspection.payload.skills).toBe(false);
    expect(inspection.payload.mcp).toBe(false);
    expect(inspection.canonicalName).toBeUndefined();
  });

  test("unknown-field warnings do not reject the package", async () => {
    const root = await makePackage("warncanon", {
      "plugin.json": v1Manifest({ futureField: 1 }),
      "SKILL.md": "---\nname: x\n---\nbody",
    });
    const inspection = await inspectPluginSource(root);
    expect(inspection.v1Canonical?.valid).toBe(true);
    expect(inspection.v1Canonical?.warnings.length).toBeGreaterThan(0);
    expect(inspection.canonicalName).toBe("sample.plugin");
  });

  test("schema-less legacy manifests keep working as compatibility inputs", async () => {
    const root = await makePackage("legacy", {
      ".claude-plugin/plugin.json": { name: "legacy-plugin", version: "0.1.0" },
    });
    const pkg = await readPluginPackage(root);
    expect(pkg.identity.pluginJsonPath).toBe(".claude-plugin/plugin.json");
    expect(pkg.identity.pluginName).toBe("legacy-plugin");
    const inspection = await inspectPluginSource(root);
    expect(inspection.v1Canonical).toBeUndefined();
    expect(inspection.canonicalName).toBe("legacy-plugin");
  });

  test("a valid root repository wins over overlays; overlays only fill an omitted root", async () => {
    // Canonical metadata authority: a VALID root v1 plugin.json repository is
    // authoritative even when a higher-priority overlay declares its own.
    const authoritative = await makePackage("repo-authority", {
      ".codex-plugin/plugin.json": { name: "sample.plugin", repository: "owner/overlay-repo" },
      ".claude-plugin/plugin.json": { name: "sample.plugin", repository: "owner/claude-overlay" },
      "plugin.json": v1Manifest({ repository: "owner/canonical-repo" }),
    });
    expect((await inspectPluginSource(authoritative)).sourceRepo).toBe("owner/canonical-repo");

    // Only an OMITTED root repository falls back to the overlay value.
    const fallback = await makePackage("repo-fallback", {
      ".codex-plugin/plugin.json": { name: "sample.plugin", repository: "owner/overlay-repo" },
      "plugin.json": v1Manifest(),
    });
    expect((await inspectPluginSource(fallback)).sourceRepo).toBe("owner/overlay-repo");
  });
});

describe("canonical component discovery locations", () => {
  test("skills come only from immediate skills/<name>/SKILL.md children", async () => {
    const root = await makePackage("skilllocs", {
      "plugin.json": v1Manifest(),
      "SKILL.md": "---\nname: root\n---\nbody",
      "skills/good/SKILL.md": "---\nname: good\n---\nbody",
      "skills/deep/nested/SKILL.md": "---\nname: deep\n---\nbody",
    });
    const inspection = await inspectPluginSource(root);
    expect(inspection.payload.skills).toBe(true);

    const onlyRoot = await makePackage("skillroot", {
      "plugin.json": v1Manifest(),
      "SKILL.md": "---\nname: root\n---\nbody",
    });
    expect((await inspectPluginSource(onlyRoot)).payload.skills).toBe(false);

    const emptyDir = await makePackage("skillempty", {
      "plugin.json": v1Manifest(),
      "skills/.keep": "",
    });
    expect((await inspectPluginSource(emptyDir)).payload.skills).toBe(false);

    const deepOnly = await makePackage("skilldeep", {
      "plugin.json": v1Manifest(),
      "skills/a/b/SKILL.md": "---\nname: a\n---\nbody",
    });
    expect((await inspectPluginSource(deepOnly)).payload.skills).toBe(false);
  });

  test("mcp payload comes only from root mcp.json for canonical packages", async () => {
    const root = await makePackage("mcplocs", {
      "plugin.json": v1Manifest(),
      ".mcp.json": { mcpServers: { legacy: { command: "node" } } },
      ".claude-plugin/plugin.json": { name: "overlay", mcpServers: { inline: { command: "node" } } },
    });
    expect((await inspectPluginSource(root)).payload.mcp).toBe(false);

    const withRootMcp = await makePackage("mcplocsgood", {
      "plugin.json": v1Manifest(),
      "mcp.json": { $schema: PLUGIN_MCP_SCHEMA_V1, mcpServers: {} },
    });
    expect((await inspectPluginSource(withRootMcp)).payload.mcp).toBe(true);
  });

  test("hasSkillManifest is canonical-exact vs legacy-broad", async () => {
    const canonical = await makePackage("hsm-canonical", {
      "plugin.json": v1Manifest(),
      "SKILL.md": "---\nname: root\n---\nbody",
      "skills/only/SKILL.md": "---\nname: only\n---\nbody",
    });
    expect(await hasSkillManifest(canonical)).toBe(true);

    const canonicalDeepOnly = await makePackage("hsm-deep", {
      "plugin.json": v1Manifest(),
      "skills/a/b/SKILL.md": "---\nname: a\n---\nbody",
    });
    expect(await hasSkillManifest(canonicalDeepOnly)).toBe(false);

    const invalidCanonical = await makePackage("hsm-invalid", {
      "plugin.json": v1Manifest({ name: "no--pe" }),
      "skills/only/SKILL.md": "---\nname: only\n---\nbody",
    });
    expect(await hasSkillManifest(invalidCanonical)).toBe(false);

    const legacy = await makePackage("hsm-legacy", {
      ".claude-plugin/plugin.json": { name: "legacy" },
      "somewhere/else/SKILL.md": "---\nname: s\n---\nbody",
    });
    expect(await hasSkillManifest(legacy)).toBe(true);
  });
});

describe("canonical mcp.json validation", () => {
  function mcpDoc(servers: Record<string, unknown>): Record<string, unknown> {
    return { $schema: PLUGIN_MCP_SCHEMA_V1, mcpServers: servers };
  }

  test("document-level failures disable MCP only", () => {
    const wrongSchema = validateMcpDocumentV1({ $schema: "https://example.com/x.json", mcpServers: {} });
    expect(wrongSchema.documentError).toBeTruthy();
    const extraTopLevel = validateMcpDocumentV1({ ...mcpDoc({}), extra: 1 });
    expect(extraTopLevel.documentError).toBeTruthy();
    const badMap = validateMcpDocumentV1({ $schema: PLUGIN_MCP_SCHEMA_V1, mcpServers: [] });
    expect(badMap.documentError).toBeTruthy();
  });

  test("per-server failures isolate invalid entries", () => {
    const validated = validateMcpDocumentV1(
      mcpDoc({
        good: { type: "stdio", command: "./bin/run" },
        badTransport: { type: "websocket", url: "https://x" },
        badCommand: { type: "stdio", command: "../escape" },
        reservedEnv: { type: "stdio", command: "run", env: { PLUGIN_ROOT: "/x" } },
        dupHeaders: {
          type: "streamable-http",
          url: "https://x/mcp",
          headers: { "X-Tenant": "a", "x-tenant": "b" },
        },
        plainHttp: { type: "streamable-http", url: "http://example.com/mcp" },
        loopbackOk: { type: "streamable-http", url: "http://localhost:3000/mcp" },
      }),
    );
    expect(validated.documentError).toBeNull();
    expect([...validated.servers.keys()].sort()).toEqual(["good", "loopbackOk"]);
    expect(validated.serverErrors.get("badCommand")).toContain("command");
    expect(validated.serverErrors.get("reservedEnv")).toContain("reserved");
    expect(validated.serverErrors.get("dupHeaders")).toContain("duplicate");
    expect(validated.serverErrors.get("plainHttp")).toContain("loopback");
  });

  test("stdio command forms", () => {
    expect(isValidStdioCommandV1("npx")).toBe(true);
    expect(isValidStdioCommandV1("./bin/server")).toBe(true);
    expect(isValidStdioCommandV1("./a/../b")).toBe(false);
    expect(isValidStdioCommandV1("../bin/server")).toBe(false);
    expect(isValidStdioCommandV1("/usr/bin/node")).toBe(false);
    expect(isValidStdioCommandV1("${PLUGIN_ROOT}/bin/x")).toBe(false);
  });

  test("placeholder expansion is single-pass and scoped to args/env/cwd", () => {
    const { value, unresolvedData } = expandPlaceholders(
      {
        args: ["${PLUGIN_ROOT}/cfg", "${PLUGIN_ROOT}${PLUGIN_ROOT}"],
        env: { KEY: "${PLUGIN_ROOT}/v", KEEP: "${UNKNOWN_VAR}" },
        cwd: "${PLUGIN_ROOT}/sub",
      },
      { pluginRoot: "/plugins/p", pluginData: "/data/p" },
    );
    expect(unresolvedData).toBe(false);
    expect(value.args).toEqual(["/plugins/p/cfg", "/plugins/p/plugins/p"]);
    expect(value.env).toEqual({ KEY: "/plugins/p/v", KEEP: "${UNKNOWN_VAR}" });
    expect(value.cwd).toBe("/plugins/p/sub");
  });

  test("url userinfo, fragments, header shapes are validated", () => {
    const validated = validateMcpDocumentV1(
      mcpDoc({
        userinfo: { type: "streamable-http", url: "https://user:pass@example.com/mcp" },
        fragment: { type: "sse", url: "https://example.com/sse#events" },
        badHeaderName: {
          type: "streamable-http",
          url: "https://x/mcp",
          headers: { "Bad Header": "v" },
        },
        headerInjection: {
          type: "streamable-http",
          url: "https://x/mcp",
          headers: { "X-A": "value\r\nX-Evil: 1" },
        },
        clean: { type: "streamable-http", url: "https://example.com/mcp" },
      }),
    );
    expect(validated.documentError).toBeNull();
    expect([...validated.servers.keys()]).toEqual(["clean"]);
    expect(validated.serverErrors.get("userinfo")).toContain("userinfo");
    expect(validated.serverErrors.get("fragment")).toContain("fragment");
    expect(validated.serverErrors.get("badHeaderName")).toContain("HTTP field name");
    expect(validated.serverErrors.get("headerInjection")).toContain("forbidden characters");
  });

  test("closed server variants reject unknown fields", () => {
    const validated = validateMcpDocumentV1(
      mcpDoc({
        stdioExtra: { type: "stdio", command: "x", transport: "custom" },
        remoteExtra: { type: "sse", url: "https://x/sse", following: true },
      }),
    );
    expect(validated.servers.size).toBe(0);
    expect(validated.serverErrors.get("stdioExtra")).toContain("not a permitted stdio field");
    expect(validated.serverErrors.get("remoteExtra")).toContain("not a permitted sse field");
  });

  test("closed server variants reject cross-variant fields", () => {
    const validated = validateMcpDocumentV1(
      mcpDoc({
        stdioWithUrl: { type: "stdio", command: "x", url: "https://x/mcp" },
        remoteWithCommand: { type: "sse", url: "https://x/sse", command: "y" },
        remoteWithEnv: { type: "streamable-http", url: "https://x/mcp", env: { A: "b" } },
        stdioWithHeaders: { type: "stdio", command: "x", headers: { "X-A": "b" } },
      }),
    );
    expect(validated.servers.size).toBe(0);
    expect(validated.serverErrors.get("stdioWithUrl")).toContain('"url" is not a permitted stdio field');
    expect(validated.serverErrors.get("remoteWithCommand")).toContain('"command" is not a permitted sse field');
    expect(validated.serverErrors.get("remoteWithEnv")).toContain('"env" is not a permitted streamable-http field');
    expect(validated.serverErrors.get("stdioWithHeaders")).toContain('"headers" is not a permitted stdio field');
  });
});

describe("resolvePluginMcpServers over canonical packages", () => {
  function mcpDoc(servers: Record<string, unknown>): Record<string, unknown> {
    return { $schema: PLUGIN_MCP_SCHEMA_V1, mcpServers: servers };
  }

  test("stdio mapping requires the secure data-home lifecycle; remotes lift regardless", async () => {
    const p = await makePackage("datahome", {
      "plugin.json": v1Manifest(),
      "mcp.json": mcpDoc({
        localData: { type: "stdio", command: "x", args: ["${PLUGIN_DATA}/db"] },
        remote: { type: "streamable-http", url: "https://ok.example/mcp" },
      }),
    });
    const record: PluginRecord = { name: "datahome", path: p };

    const withoutHome = await resolvePluginMcpServers([record]);
    expect(withoutHome.servers.map((s) => s.name)).toEqual(["remote"]);
    expect(withoutHome.skipped.find((s) => s.name === "localData")?.reason).toContain(
      "requires a client-supplied PLUGIN_DATA directory",
    );

    // With an explicit dataRoot, the hashed directory is created securely.
    const dataRoot = join(workDir, "state");
    const withHome = await resolvePluginMcpServers([record], { dataRoot });
    const local = withHome.servers.find((s) => s.name === "localData")!.server as {
      args: string[];
      env: Record<string, string>;
    };
    expect(local.args[0]).toContain(join("syncthis", "plugin-data"));
    const hashDir = join(dataRoot, "syncthis", "plugin-data");
    const entries = await readdir(hashDir);
    expect(entries.length).toBe(1);
    const stat = await lstat(join(hashDir, entries[0]!));
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
    // §9.1: client-supplied reserved variables arrive after configured env.
    expect(local.env.PLUGIN_ROOT).toBe(await realpath(p));
    // PLUGIN_DATA is spelled under the filesystem-resolved data root.
    expect(local.env.PLUGIN_DATA).toBe(join(await realpath(hashDir), entries[0]!));
  });

  test("default calls never create filesystem state", async () => {
    const p = await makePackage("drysafe", {
      "plugin.json": v1Manifest(),
      "mcp.json": mcpDoc({ s: { type: "stdio", command: "x" } }),
    });
    const untouched = join(workDir, "never-created");
    const result = await resolvePluginMcpServers([{ name: "drysafe", path: p }]);
    expect(result.servers).toEqual([]);
    let exists = true;
    try {
      await lstat(untouched);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("cwd containment rules and defaults", async () => {
    const dataRoot = join(workDir, "cwddata");
    const p = await makePackage("cwdrules", {
      "plugin.json": v1Manifest(),
      "mcp.json": mcpDoc({
        defaultCwd: { type: "stdio", command: "x" },
        exactRootCwd: { type: "stdio", command: "x", cwd: "${PLUGIN_ROOT}" },
        exactDataCwd: { type: "stdio", command: "x", cwd: "${PLUGIN_DATA}" },
        contained: { type: "stdio", command: "x", cwd: "${PLUGIN_ROOT}/./sub" },
        dataInside: { type: "stdio", command: "x", cwd: "${PLUGIN_DATA}/run" },
        bareRelative: { type: "stdio", command: "x", cwd: "sub" },
        escape: { type: "stdio", command: "x", cwd: "${PLUGIN_ROOT}/../outside" },
        dataEscape: { type: "stdio", command: "x", cwd: "${PLUGIN_DATA}/../outside" },
      }),
    });
    const { servers, skipped } = await resolvePluginMcpServers([{ name: "cwdrules", path: p }], {
      dataRoot,
    });
    const realP = await realpath(p);
    const byName = Object.fromEntries(servers.map((s) => [s.name, s.server])) as Record<
      string,
      { cwd?: string }
    >;
    expect(byName.defaultCwd!.cwd).toBe(realP);
    expect(byName.exactRootCwd!.cwd).toBe(realP);
    expect(byName.exactDataCwd!.cwd).toContain(join("syncthis", "plugin-data"));
    expect(byName.contained!.cwd).toBe(join(realP, "sub"));
    expect(byName.dataInside!.cwd).toContain(join("syncthis", "plugin-data"));
    expect(skipped.find((s) => s.name === "bareRelative")?.reason).toContain("escapes");
    expect(skipped.find((s) => s.name === "escape")?.reason).toContain("escapes");
    expect(skipped.find((s) => s.name === "dataEscape")?.reason).toContain("escapes");
  });

  test("symlinked ./command escaping the root is rejected at the filesystem boundary", async () => {
    const p = await makePackage("symlinkcmd", {
      "plugin.json": v1Manifest(),
      "mcp.json": mcpDoc({ sneaky: { type: "stdio", command: "./bin/server" } }),
    });
    const evil = join(workDir, "evil");
    await mkdir(evil, { recursive: true });
    await writeFile(join(evil, "server"), "#!/bin/sh\n");
    await symlink(evil, join(p, "bin"));
    const { servers, skipped } = await resolvePluginMcpServers([{ name: "symlinkcmd", path: p }], {
      dataRoot: join(workDir, "symdata"),
    });
    expect(servers).toEqual([]);
    expect(skipped.find((s) => s.name === "sneaky")?.reason).toContain("symlink");
  });

  test("escaping plugin.json symlink rejects the package before parsing", async () => {
    const victim = await makePackage("victim", {
      "plugin.json": v1Manifest({ name: "innocent" }),
    });
    const p = join(workDir, "escape-manifest");
    await mkdir(p, { recursive: true });
    await symlink(join(victim, "plugin.json"), join(p, "plugin.json"));
    const { servers, skipped } = await resolvePluginMcpServers([{ name: "escape-manifest", path: p }]);
    expect(servers).toEqual([]);
    expect(skipped[0]?.reason).toContain("invalid plugin.json");
  });

  test("escaping mcp.json symlink disables MCP instead of being followed", async () => {
    const victim = await makePackage("mcpvictim", {
      "mcp.json": mcpDoc({ evil: { type: "stdio", command: "evil" } }),
    });
    const p = await makePackage("escape-mcp", {
      "plugin.json": v1Manifest(),
    });
    await symlink(join(victim, "mcp.json"), join(p, "mcp.json"));
    const { servers, skipped } = await resolvePluginMcpServers([{ name: "escape-mcp", path: p }]);
    expect(servers).toEqual([]);
    expect(skipped[0]?.reason).toContain("invalid mcp.json");
  });

  test("emitted PLUGIN_ROOT is the filesystem-resolved root even through a symlinked install path", async () => {
    const real = await makePackage("aliased", {
      "plugin.json": v1Manifest(),
      "mcp.json": mcpDoc({ s: { type: "stdio", command: "x", env: { OVERRIDE: "${PLUGIN_ROOT}" } } }),
    });
    const alias = join(workDir, "alias-link");
    await symlink(real, alias);
    const { servers } = await resolvePluginMcpServers(
      [{ name: "aliased", path: alias }],
      { dataRoot: join(workDir, "aliasdata") },
    );
    const server = servers.find((s) => s.name === "s")!.server as {
      env: Record<string, string>;
      cwd: string;
    };
    const realRoot = await realpath(real);
    expect(server.env.PLUGIN_ROOT).toBe(realRoot);
    expect(server.env.OVERRIDE).toBe(realRoot);
    expect(server.cwd).toBe(realRoot);
  });

  test("invalid one server skips it; valid siblings survive end-to-end", async () => {
    const p = await makePackage("mixed", {
      "plugin.json": v1Manifest(),
      "mcp.json": mcpDoc({
        ok: { type: "stdio", command: "./bin/run", env: { CFG: "${PLUGIN_ROOT}/c.json" } },
        broken: { type: "stdio", command: "no/slashes/allowed" },
      }),
    });
    const { servers, skipped } = await resolvePluginMcpServers([{ name: "mixed", path: p }], {
      dataRoot: join(workDir, "mixeddata"),
    });
    expect(skipped.map((s) => s.name)).toEqual(["broken"]);
    const realP = await realpath(p);
    const server = servers.find((s) => s.name === "ok")!.server as {
      command: string;
      env: Record<string, string>;
    };
    expect(server.command).toBe(join(realP, "bin/run"));
    expect(server.env.CFG).toBe(join(realP, "c.json"));
  });

  test("invalid canonical mcp.json disables MCP but keeps skills and identity", async () => {
    const p = await makePackage("badmcp", {
      "plugin.json": v1Manifest(),
      "mcp.json": { $schema: "https://example.com/not-mcp.json", mcpServers: {} },
      "SKILL.md": "---\nname: x\n---\nbody",
    });
    const inspection = await inspectPluginSource(p);
    expect(inspection.payload.mcp).toBe(true);
    expect(inspection.canonicalName).toBe("sample.plugin");

    const record: PluginRecord = { name: "badmcp", path: p };
    const { servers, skipped } = await resolvePluginMcpServers([record]);
    expect(servers).toEqual([]);
    expect(skipped.find((s) => s.name === "*")?.reason).toContain("invalid mcp.json");
  });

  test("malformed root mcp.json disables canonical MCP with an explicit reason", async () => {
    const p = await makePackage("brokencanon", {
      "plugin.json": v1Manifest(),
      "mcp.json": "{ not json at all",
    });
    const { servers, skipped } = await resolvePluginMcpServers([{ name: "brokencanon", path: p }]);
    expect(servers).toEqual([]);
    expect(skipped.find((s) => s.name === "*")?.reason).toContain("not readable JSON");
  });

  test("unsupported Agent Plugins schema versions are detected, not treated as legacy", async () => {
    const manifestRoot = await makePackage("futuremanifest", {
      "plugin.json": {
        $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
        name: "future-plugin",
      },
      "skills/x/SKILL.md": "---\nname: x\n---\nbody",
    });
    await expect(readPluginPackage(manifestRoot)).rejects.toThrow(/unsupported Agent Plugins manifest schema version 1\.1\.0/);
    const inspection = await inspectPluginSource(manifestRoot);
    expect(inspection.v1Canonical?.valid).toBe(false);
    expect(inspection.payload.skills).toBe(false);

    const mcpRoot = await makePackage("futuremcp", {
      "plugin.json": v1Manifest(),
      "mcp.json": {
        $schema: "https://agent-plugins.org/schemas/0.9.0/mcp.schema.json",
        mcpServers: {},
      },
    });
    const { servers, skipped } = await resolvePluginMcpServers([{ name: "futuremcp", path: mcpRoot }]);
    expect(servers).toEqual([]);
    expect(skipped.find((s) => s.name === "*")?.reason).toContain("unsupported Agent Plugins MCP schema version 0.9.0");
  });

  test("root mcp.json is not parsed when the canonical manifest is fatally invalid", async () => {
    const p = await makePackage("gatemcp", {
      "plugin.json": v1Manifest({ name: "not--valid" }),
      "mcp.json": mcpDoc({ s: { type: "stdio", command: "x" } }),
    });
    const record: PluginRecord = { name: "gatemcp", path: p };
    const { servers } = await resolvePluginMcpServers([record]);
    expect(servers).toEqual([]);
  });

  test("canonical packages never merge legacy .mcp.json or inline MCP", async () => {
    const p = await makePackage("blend", {
      ".mcp.json": { mcpServers: { legacyFile: { command: "${CLAUDE_PLUGIN_ROOT}/legacy" } } },
      ".claude-plugin/plugin.json": {
        name: "blend-legacy",
        mcpServers: { legacyInline: { command: "node" } },
      },
      "plugin.json": v1Manifest(),
      "mcp.json": mcpDoc({
        canonical: { type: "stdio", command: "./bin/run" },
      }),
    });
    const { servers } = await resolvePluginMcpServers([{ name: "blend", path: p }], {
      dataRoot: join(workDir, "blenddata"),
    });
    expect(servers.map((s) => s.name)).toEqual(["canonical"]);
    const realP = await realpath(p);
    const canonical = servers.find((s) => s.name === "canonical")!.server as {
      command: string;
      cwd: string;
    };
    expect(canonical.command).toBe(join(realP, "bin/run"));
    expect(canonical.cwd).toBe(realP);
  });

  test("absent or invalid root mcp.json never leaks legacy MCP sources", async () => {
    // Canonical manifest is valid, root mcp.json MISSING, legacy sources present.
    const absentMcp = await makePackage("leak-absent", {
      ".mcp.json": { mcpServers: { legacyFile: { command: "${CLAUDE_PLUGIN_ROOT}/legacy" } } },
      ".claude-plugin/plugin.json": {
        name: "leak-absent-legacy",
        mcpServers: { legacyInline: { command: "node" } },
      },
      "plugin.json": v1Manifest(),
    });
    const absent = await resolvePluginMcpServers([{ name: "leak-absent", path: absentMcp }]);
    expect(absent.servers).toEqual([]);
    expect(absent.skipped).toEqual([]);

    // Same package shape but with an INVALID root mcp.json: still zero leaks,
    // and the failure is reported as a document-level disable.
    const invalidMcp = await makePackage("leak-invalid", {
      ".mcp.json": { mcpServers: { legacyFile: { command: "${CLAUDE_PLUGIN_ROOT}/legacy" } } },
      ".claude-plugin/plugin.json": {
        name: "leak-invalid-legacy",
        mcpServers: { legacyInline: { command: "node" } },
      },
      "plugin.json": v1Manifest(),
      "mcp.json": { $schema: "https://example.com/not-mcp.json", mcpServers: {} },
    });
    const invalid = await resolvePluginMcpServers([{ name: "leak-invalid", path: invalidMcp }]);
    expect(invalid.servers).toEqual([]);
    expect(invalid.skipped.find((s) => s.name === "*")?.reason).toContain("invalid mcp.json");
  });

  test("legacy-only packages keep .mcp.json and manifest-inline behavior", async () => {
    const p = await makePackage("purelegacy", {
      ".mcp.json": { mcpServers: { legacyFile: { command: "${CLAUDE_PLUGIN_ROOT}/legacy" } } },
      ".claude-plugin/plugin.json": {
        name: "pure-legacy",
        mcpServers: { legacyInline: { command: "node" } },
      },
    });
    const { servers } = await resolvePluginMcpServers([{ name: "purelegacy", path: p }]);
    expect(servers.map((s) => s.name).sort()).toEqual(["legacyFile", "legacyInline"]);
    expect(servers.find((s) => s.name === "legacyFile")!.server).toEqual({
      command: join(p, "legacy"),
    });
  });
});

describe("filesystem boundary helpers", () => {
  test("isContainedPath allows the exact base", () => {
    const base = join(workDir, "exact-base");
    expect(isContainedPath(base, base)).toBe(true);
    expect(isContainedPath(base, join(base, "child"))).toBe(true);
    expect(isContainedPath(base, join(base, "..", "elsewhere"))).toBe(false);
  });

  test("isSymlinkSafeContained reconstructs multiple missing segments in order", async () => {
    const base = join(workDir, "contain-base");
    await mkdir(join(base, "real"), { recursive: true });
    expect(await isSymlinkSafeContained(base, join(base, "a", "b", "c"))).toBe(true);
    expect(await isSymlinkSafeContained(base, join(base, "..", "outside", "a", "b"))).toBe(false);
    // A symlinked ancestor escapes even when deeper segments are missing.
    await symlink(join(workDir, "contain-outside"), join(base, "link"));
    await mkdir(join(workDir, "contain-outside"), { recursive: true });
    expect(await isSymlinkSafeContained(base, join(base, "link", "x", "y"))).toBe(false);
    expect(await isSymlinkSafeContained(base, join(base, "real", "x", "y"))).toBe(true);
  });

  test("ensurePrivateDirectory rejects symlinked components and enforces exact 0700", async () => {
    const base = join(workDir, "privbase");
    await mkdir(base, { recursive: true });

    const ok = await ensurePrivateDirectory(base, ["a", "b"]);
    expect(ok).toBeDefined();
    const stat = await lstat(ok!);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);

    // Pre-created wide-mode directory is clamped back to 0700.
    await mkdir(join(base, "wide"), { mode: 0o755 });
    const clamped = await ensurePrivateDirectory(base, ["wide"]);
    expect(clamped).toBeDefined();
    expect((await lstat(clamped!)).mode & 0o777).toBe(0o700);

    // Symlinked final component is rejected outright.
    await symlink(join(workDir, "elsewhere"), join(base, "linked-dir"));
    expect(await ensurePrivateDirectory(base, ["linked-dir"])).toBeUndefined();

    // Symlinked intermediate component is rejected.
    await mkdir(join(workDir, "sym-intermediate"), { recursive: true });
    await symlink(join(workDir, "sym-intermediate"), join(base, "mid-link"));
    expect(await ensurePrivateDirectory(base, ["mid-link", "child"])).toBeUndefined();

    // A non-directory base is rejected.
    const fileBase = join(workDir, "file-base");
    await writeFile(fileBase, "");
    expect(await ensurePrivateDirectory(fileBase, ["x"])).toBeUndefined();
  });

  test("a symlinked existing descendant cannot redirect creation outside the boundary", async () => {
    // The reproduced bypass: base/link is a symlink pointing outside,
    // outside/existing already exists, and only the deepest existing
    // descendant used to be checked — so child landed OUTSIDE the boundary.
    const base = join(workDir, "deep-base");
    const outside = join(workDir, "deep-outside");
    await mkdir(base, { recursive: true });
    await mkdir(join(outside, "existing"), { recursive: true });
    await symlink(outside, join(base, "link"));

    const result = await ensurePrivateDirectory(base, ["link", "existing", "child"]);
    expect(result).toBeUndefined();
    let escaped = true;
    try {
      await lstat(join(outside, "existing", "child"));
    } catch {
      escaped = false;
    }
    expect(escaped).toBe(false);
  });

  test("a MISSING data root is securely created from its deepest existing ancestor", async () => {
    const dataRoot = join(workDir, "fresh-machine", ".local", "share");
    expect(await validatePrivateDirectoryPath(dataRoot, ["syncthis"])).toBeDefined();

    const created = await ensurePrivateDirectory(dataRoot, [
      "syncthis",
      "plugin-data",
      "abc123",
    ]);
    // Compare against the resolved anchor spelling — never strict lexical
    // equality against a possibly aliased ancestor.
    const realWorkDir = await realpath(workDir);
    expect(created).toBe(
      join(realWorkDir, "fresh-machine", ".local", "share", "syncthis", "plugin-data", "abc123"),
    );
    // Every component at/below the boundary is a real directory at 0700 —
    // the race-safe post-condition observable in Node.
    const chain = [
      join(realWorkDir, "fresh-machine"),
      join(realWorkDir, "fresh-machine", ".local"),
      join(realWorkDir, "fresh-machine", ".local", "share"),
      join(realWorkDir, "fresh-machine", ".local", "share", "syncthis"),
      join(realWorkDir, "fresh-machine", ".local", "share", "syncthis", "plugin-data"),
      created!,
    ];
    for (const dir of chain) {
      const info = await lstat(dir);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
    }
  });

  test("preview validation computes exact paths without writing; create twin agrees", async () => {
    // Fresh (missing) root: preview succeeds without creating anything.
    const freshRoot = join(workDir, "never", "existed");
    const previewed = await validatePrivateDirectoryPath(freshRoot, ["plugin-data"]);
    const realWorkDir = await realpath(workDir);
    expect(previewed).toBe(join(realWorkDir, "never", "existed", "plugin-data"));
    let exists = true;
    try {
      await lstat(freshRoot);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    // The same path is then creatable by apply.
    expect(await ensurePrivateDirectory(freshRoot, ["plugin-data"])).toBe(previewed);

    // An unsafe layout is refused identically by preview and apply.
    const unsafeBase = join(workDir, "unsafe-base");
    const outside = join(workDir, "unsafe-outside");
    await mkdir(unsafeBase, { recursive: true });
    await mkdir(join(outside, "existing"), { recursive: true });
    await symlink(outside, join(unsafeBase, "link"));
    const unsafeTarget = ["link", "existing", "child"];
    expect(await validatePrivateDirectoryPath(unsafeBase, unsafeTarget)).toBeUndefined();
    expect(await ensurePrivateDirectory(unsafeBase, unsafeTarget)).toBeUndefined();
    let escaped = true;
    try {
      await lstat(join(outside, "existing", "child"));
    } catch {
      escaped = false;
    }
    expect(escaped).toBe(false);
  });

  test("harmless symlink ancestors ABOVE the boundary stay supported", async () => {
    const realHome = join(workDir, "real-home");
    const declaredShare = join(realHome, "share");
    await mkdir(declaredShare, { recursive: true });
    await symlink(realHome, join(workDir, "linked-home"));
    const base = join(workDir, "linked-home", "share");
    const result = await ensurePrivateDirectory(base, ["syncthis", "plugin-data", "xyz"]);
    expect(result).toBe(
      join(await realpath(declaredShare), "syncthis", "plugin-data", "xyz"),
    );
    const stat = await lstat(result!);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });
});

describe("fingerprint coverage of canonical mcp.json", () => {
  test("adding or changing mcp.json changes fingerprints", async () => {
    const base = {
      "plugin.json": v1Manifest(),
      "SKILL.md": "---\nname: x\n---\nbody",
    };
    const before = await hashPluginPackage(await makePackage("fp-a", base));
    const withMcp = await makePackage("fp-b", {
      ...base,
      "mcp.json": { $schema: PLUGIN_MCP_SCHEMA_V1, mcpServers: {} },
    });
    const afterAdd = await hashPluginPackage(withMcp);
    expect(afterAdd).not.toBe(before);

    const changed = await makePackage("fp-c", {
      ...base,
      "mcp.json": {
        $schema: PLUGIN_MCP_SCHEMA_V1,
        mcpServers: { s: { type: "stdio", command: "x" } },
      },
    });
    expect(await hashPluginPackage(changed)).not.toBe(afterAdd);
  });
});
