import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMirror, mirrorHasChanges } from "../src/plugins/mirror.ts";

// Materialize a plugin install dir with a bundled .mcp.json, return the path to use
// as the plugin's `installPath` in the fake `claude plugin list` output.
async function materializePluginMcp(name: string, mcpServers: Record<string, unknown>): Promise<string> {
  const dir = join(workDir, "plugin-cache", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers }));
  return dir;
}

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;
let originalXdg: string | undefined;
let originalCopilotHome: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-mir-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalCopilotHome = process.env.COPILOT_HOME;
  process.env.HOME = workDir;
  process.env.COPILOT_HOME = join(workDir, "copilot");
  // Goose honors XDG_CONFIG_HOME unconditionally; clear it so the mirror's MCP-cohort
  // write to goose lands under the temp HOME, not the real ~/.config.
  delete process.env.XDG_CONFIG_HOME;
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, "grok"),
    "#!/bin/sh\nif [ \"$1 $2 $3\" = \"plugin list --json\" ]; then echo '[]'; exit 0; fi\nexit 1\n",
  );
  await chmod(join(binDir, "grok"), 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = originalCopilotHome;
  await rm(workDir, { recursive: true, force: true });
});

async function installFakeCli(name: "claude" | "codex", listOutput: string) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const listFile = join(workDir, `${name}-list.json`);
  await writeFile(listFile, listOutput);
  if (name === "claude") {
    const nativeNames = listOutput
      ? (JSON.parse(listOutput) as Array<{ id: string }>).map(({ id }) => id.split("@")[0]!)
      : [];
    await mkdir(process.env.COPILOT_HOME!, { recursive: true });
    await writeFile(
      join(process.env.COPILOT_HOME!, "config.json"),
      JSON.stringify({
        installedPlugins: nativeNames.map((pluginName) => ({
          name: pluginName,
          enabled: true,
          cache_path: join(workDir, "native", pluginName),
        })),
      }),
    );
    const copilot = join(binDir, "copilot");
    await writeFile(
      copilot,
      `#!/bin/sh
echo "copilot $@" >> ${join(workDir, "invocations.log")}
if [ "$1 $2" = "plugin list" ]; then
${nativeNames.map((pluginName) => `  echo "  • ${pluginName} (v1.0.0)"`).join("\n")}
  ${nativeNames.length === 0 ? 'echo "No plugins installed."' : ""}
  exit 0
fi
exit 1
`,
    );
    await chmod(copilot, 0o755);
  }
  const log = join(workDir, "invocations.log");
  const listMatch =
    name === "claude"
      ? `if [ "$1 $2 $3" = "plugin list --json" ]; then cat ${listFile}; exit 0; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then echo "[]"; exit 0; fi`
      : `if [ "$1 $2" = "plugin list" ]; then cat ${listFile}; exit 0; fi`;
  const addMatch =
    name === "codex"
      ? `if [ "$1 $2" = "plugin add" ]; then
  awk -v id="$4" 'index($0, id) == 1 { sub(/not installed/, "installed    ") } { print }' ${listFile} > ${listFile}.next
  mv ${listFile}.next ${listFile}
  exit 0
fi`
      : "";
  const script = `#!/bin/sh
echo "${name} $@" >> ${log}
${listMatch}
${addMatch}
exit 0
`;
  const p = join(binDir, name);
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

async function readInvocations() {
  try {
    return (await readFile(join(workDir, "invocations.log"), "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// Render the `codex plugin list` table the codex adapter now reads for install
// truth. Each row: [id, status, version, path]. Codex install identity carries
// an agent-local marketplace tag (e.g. "@plugins-cli"), distinct from Claude's.
type CodexRow = [id: string, status: string, version: string, path: string];
function codexList(rows: CodexRow[]): string {
  const header: CodexRow = ["PLUGIN", "STATUS", "VERSION", "PATH"];
  const all = [header, ...rows];
  const w0 = Math.max(...all.map((r) => r[0].length));
  const w1 = Math.max(...all.map((r) => r[1].length));
  const w2 = Math.max(...all.map((r) => r[2].length));
  const fmt = (r: CodexRow) =>
    `${r[0].padEnd(w0 + 2)}${r[1].padEnd(w1 + 2)}${r[2].padEnd(w2 + 2)}${r[3]}`.replace(/\s+$/, "");
  return ["Marketplace `plugins-cli`", "/x/marketplace.json", "", fmt(header), ...rows.map(fmt), ""].join("\n");
}

// Shorthand: an installed codex plugin row from a fully-qualified id.
function codexInstalled(...ids: string[]): string {
  return codexList(ids.map((id) => [id, "installed, enabled", "1.0.0", `/cache/${id.split("@")[0]}`]));
}

// Shorthand: plugins present in a Codex marketplace snapshot but NOT installed —
// available for `codex plugin add` (marketplace resolvable, but not yet loaded).
function codexAvailable(...ids: string[]): string {
  return codexList(ids.map((id) => [id, "not installed", "", `/cache/${id.split("@")[0]}`]));
}

describe("runMirror — preview (no apply)", () => {
  test("aborts instead of treating an unreadable primary as an empty plugin set", async () => {
    process.env.PATH = "";
    await expect(runMirror({ from: "claude-code", apply: false })).rejects.toThrow(/cannot read primary claude-code/i);
  });

  test("computes diff of plugins from primary to each target", async () => {
    // Claude has foo, bar. Codex has bar. Mirror claude → all should propose +foo to codex.
    await installFakeCli(
      "claude",
      JSON.stringify([
        { id: "foo@mkt1", enabled: true },
        { id: "bar@mkt1", enabled: true },
      ]),
    );
    await installFakeCli("codex", codexInstalled("bar@plugins-cli"));

    const report = await runMirror({ from: "claude-code", apply: false });
    expect(mirrorHasChanges(report)).toBe(true);
    const codexTarget = report.targets.find((t) => t.to === "codex")!;
    expect(codexTarget.diff).not.toBeNull();
    expect(codexTarget.diff!.add.map((p) => p.name).sort()).toEqual(["foo"]);
  });

  test("preview without apply does not invoke CLI install", async () => {
    await installFakeCli("claude", JSON.stringify([{ id: "alpha@mkt", enabled: true }]));
    await installFakeCli("codex", "");
    await runMirror({ from: "claude-code", apply: false });
    const invocations = await readInvocations();
    // claude plugin list is fine; codex plugin add must NOT appear.
    expect(invocations.some((line) => /codex plugin add/.test(line))).toBe(false);
  });
});

describe("runMirror — additive only (no uninstall path)", () => {
  test("empty primary schedules no installs, and the diff has no `remove`", async () => {
    await installFakeCli("claude", JSON.stringify([]));
    await installFakeCli("codex", codexInstalled("existing@plugins-cli"));
    const report = await runMirror({ from: "claude-code", apply: false });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.diff!.add).toEqual([]);
    // MirrorDiff has no `remove` field — a mirror can only add, never uninstall.
    expect("remove" in codex.diff!).toBe(false);
    expect(mirrorHasChanges(report)).toBe(false);
  });

  test("a plugin only the target has is left untouched (never queued for removal)", async () => {
    await installFakeCli("claude", JSON.stringify([{ id: "keep@mkt", enabled: true }]));
    await installFakeCli("codex", codexInstalled("keep@plugins-cli", "extra@plugins-cli"));
    const report = await runMirror({ from: "claude-code", apply: false });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.diff!.add).toEqual([]); // keep already present; extra left alone
    expect(mirrorHasChanges(report)).toBe(false);
  });
});

describe("runMirror — apply", () => {
  test("apply invokes target's install primitive for each missing plugin", async () => {
    await installFakeCli(
      "claude",
      JSON.stringify([
        { id: "alpha@mkt", enabled: true },
        { id: "beta@mkt", enabled: true },
      ]),
    );
    // Both available in Codex's snapshot (not yet installed) so add can resolve.
    await installFakeCli("codex", codexAvailable("alpha@plugins-cli", "beta@plugins-cli"));
    const report = await runMirror({ from: "claude-code", apply: true });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.installs).toBeDefined();
    expect(codex.installs!.length).toBe(2);
    const invocations = await readInvocations();
    expect(invocations.filter((l) => l.startsWith("codex plugin add")).length).toBe(2);
  });
});

describe("runMirror — cross-agent marketplace tags (regression)", () => {
  // The same upstream plugin carries an agent-local marketplace tag:
  // forsvn-skills@forsvn-skills in Claude, forsvn-skills@plugins-cli in Codex.
  // Identity for the diff must be the BARE name, or every such plugin gets a
  // spurious re-add. (Fixtures elsewhere reuse one tag on both sides, which is
  // why this gap went unnoticed.)
  test("same plugin under different marketplace tags is NOT re-added", async () => {
    await installFakeCli("claude", JSON.stringify([{ id: "forsvn-skills@forsvn-skills", enabled: true }]));
    await installFakeCli("codex", codexInstalled("forsvn-skills@plugins-cli"));
    const report = await runMirror({ from: "claude-code", apply: false });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.diff!.add).toEqual([]);
    expect(mirrorHasChanges(report)).toBe(false);
  });

  test("same URL-derived plugin under Codex's sanitized github-com name is NOT re-added", async () => {
    await installFakeCli("claude", JSON.stringify([{ id: "github.com-owner-tool@gh-mkt", enabled: true }]));
    await installFakeCli("codex", codexInstalled("github-com-owner-tool@plugins-cli"));
    const report = await runMirror({ from: "claude-code", apply: false });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.diff!.add).toEqual([]);
    expect(mirrorHasChanges(report)).toBe(false);
  });

  test("only a genuinely-absent bare name is proposed for add", async () => {
    await installFakeCli(
      "claude",
      JSON.stringify([
        { id: "forsvn-skills@forsvn-skills", enabled: true },
        { id: "vercel@claude-mkt", enabled: true },
      ]),
    );
    await installFakeCli("codex", codexInstalled("forsvn-skills@plugins-cli"));
    const report = await runMirror({ from: "claude-code", apply: false });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.diff!.add.map((p) => p.name)).toEqual(["vercel"]);
  });

  test("apply resolves the TARGET's marketplace, never the source tag", async () => {
    // Claude tags it vercel@claude-mkt; Codex provides it as vercel@plugins-cli.
    // The install must use Codex's resolved tag, not Claude's (which Codex can't
    // resolve), and `codex plugin add` requires a tag — a bare name is rejected.
    await installFakeCli("claude", JSON.stringify([{ id: "vercel@claude-mkt", enabled: true }]));
    await installFakeCli("codex", codexAvailable("vercel@plugins-cli"));
    await runMirror({ from: "claude-code", apply: true });
    const invocations = await readInvocations();
    expect(invocations.some((l) => l.trim() === "codex plugin add -- vercel@plugins-cli")).toBe(true);
    expect(invocations.some((l) => /vercel@claude-mkt/.test(l))).toBe(false);
  });
});

describe("runMirror — plugin MCP decomposition", () => {
  test("preview surfaces a plugin's bundled MCP servers to the non-plugin cohort", async () => {
    const cacheDir = await materializePluginMcp("db", {
      db: { command: "${CLAUDE_PLUGIN_ROOT}/bin/db", args: ["--port", "5432"] },
    });
    await installFakeCli("claude", JSON.stringify([{ id: "db@mkt", enabled: true, installPath: cacheDir }]));
    await installFakeCli("codex", "");

    const report = await runMirror({ from: "claude-code", apply: false });
    expect(report.mcpCohort.supported).toBe(true);
    expect(report.mcpCohort.agents.length).toBe(9); // the 9 non-plugin MCP agents (incl. goose)
    expect(report.mcpCohort.servers.map((s) => s.name)).toEqual(["db"]);
    expect((report.mcpCohort.servers[0]!.server as { command: string }).command).toBe(join(cacheDir, "bin/db"));
    expect(mirrorHasChanges(report)).toBe(true);
  });

  test("a Codex primary can't supply plugin MCP (Claude-store only)", async () => {
    await installFakeCli("claude", "");
    await installFakeCli("codex", codexInstalled("some@plugins-cli"));
    const report = await runMirror({ from: "codex", apply: false });
    expect(report.mcpCohort.supported).toBe(false);
    expect(report.mcpCohort.reason).toMatch(/Claude/);
  });

  test("apply is additive and conflict-safe per agent", async () => {
    // Pre-seed gemini with its own `db` (a CONFLICT — different config) and a `keep`
    // server. The plugin provides `db` (must be left untouched) and `extra` (added).
    const geminiPath = join(workDir, ".gemini", "settings.json");
    await mkdir(join(geminiPath, ".."), { recursive: true });
    await writeFile(
      geminiPath,
      JSON.stringify({ mcpServers: { db: { command: "agent-db" }, keep: { command: "keep-cmd" } } }),
    );

    const cacheDir = await materializePluginMcp("p", {
      db: { command: "${CLAUDE_PLUGIN_ROOT}/bin/db" },
      extra: { command: "extra-cmd" },
    });
    await installFakeCli("claude", JSON.stringify([{ id: "p@mkt", enabled: true, installPath: cacheDir }]));
    await installFakeCli("codex", "");

    // provision:false keeps the run offline (no `npx plugins` / network).
    const report = await runMirror({ from: "claude-code", apply: true, provision: false });

    const gemini = report.mcpCohort.results!.find((r) => r.agent === "gemini-cli")!;
    expect(gemini.added).toEqual(["extra"]);
    expect(gemini.conflicts).toEqual(["db"]);

    const written = JSON.parse(await readFile(geminiPath, "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(written.mcpServers.keep!.command).toBe("keep-cmd"); // existing untouched
    expect(written.mcpServers.db!.command).toBe("agent-db"); // conflict left untouched
    expect(written.mcpServers.extra!.command).toBe("extra-cmd"); // new server added
  });
});
