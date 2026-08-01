import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPluginAdd, pluginAddHasWork } from "../src/plugins/add.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;
let originalXdg: string | undefined;
let invocationsFile: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-add-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = workDir;
  delete process.env.XDG_CONFIG_HOME; // keep opencode adapter writes under temp HOME
  invocationsFile = join(workDir, "invocations.log");
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  await rm(workDir, { recursive: true, force: true });
});

async function readInvocations(): Promise<string[]> {
  try {
    return (await readFile(invocationsFile, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

type CodexRow = [id: string, status: string, version: string, path: string];
function codexTable(rows: CodexRow[]): string {
  const header: CodexRow = ["PLUGIN", "STATUS", "VERSION", "PATH"];
  const all = [header, ...rows];
  const w = [0, 1, 2].map((i) => Math.max(...all.map((r) => r[i]!.length)));
  const fmt = (r: CodexRow) =>
    `${r[0].padEnd(w[0]! + 2)}${r[1].padEnd(w[1]! + 2)}${r[2].padEnd(w[2]! + 2)}${r[3]}`.replace(/\s+$/, "");
  return ["Marketplace `plugins-cli`", "/x/marketplace.json", "", fmt(header), ...rows.map(fmt), ""].join("\n");
}

// Fake claude: plugin list --json (+ marketplace list --json). `listExit` fails the list.
async function installFakeClaude(listJson: string, marketplaceJson: string, opts: { listExit?: number } = {}) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const listFile = join(workDir, "claude-list.json");
  const mktFile = join(workDir, "claude-mkt.json");
  await writeFile(listFile, listJson);
  await writeFile(mktFile, marketplaceJson);
  const listBranch = opts.listExit != null ? `echo "boom" >&2; exit ${opts.listExit}` : `cat ${listFile}; exit 0`;
  const script = `#!/bin/sh
echo "claude $@" >> ${invocationsFile}
if [ "$1 $2 $3" = "plugin list --json" ]; then ${listBranch}; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then cat ${mktFile}; exit 0; fi
exit 0
`;
  const p = join(binDir, "claude");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

async function installFakeCodex(listText: string) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const listFile = join(workDir, "codex-list.txt");
  await writeFile(listFile, listText);
  const script = `#!/bin/sh
echo "codex $@" >> ${invocationsFile}
if [ "$1 $2" = "plugin list" ]; then cat ${listFile}; exit 0; fi
if [ "$1 $2" = "plugin add" ]; then
  awk -v id="$4" 'index($0, id) == 1 { sub(/not installed/, "installed    ") } { print }' ${listFile} > ${listFile}.next
  mv ${listFile}.next ${listFile}
  exit 0
fi
exit 0
`;
  const p = join(binDir, "codex");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
}

async function installFakeNpx() {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const script = `#!/bin/sh
echo "npx $@" >> ${invocationsFile}
exit 0
`;
  const p = join(binDir, "npx");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
}

// A plugin install dir bundling one MCP server, for the MCP-lift path.
async function writePluginWithMcp(dir: string, serverName: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { [serverName]: { command: "do-thing" } } }));
}

describe("runPluginAdd", () => {
  async function setup(opts: { listExit?: number } = {}) {
    const fooDir = join(workDir, "plugins", "foo");
    await writePluginWithMcp(fooDir, "srv");
    await mkdir(join(fooDir, "skills", "foo"), { recursive: true });
    await writeFile(
      join(fooDir, "skills", "foo", "SKILL.md"),
      "---\nname: foo\n---\n",
    );
    await installFakeClaude(
      JSON.stringify([{ id: "foo@mkt", enabled: true, installPath: fooDir }]),
      JSON.stringify([{ name: "mkt", source: "github", repo: "owner/foo" }]),
      opts,
    );
    await installFakeCodex(codexTable([["foo@plugins-cli", "not installed", "", "/c/foo"]]));
    await installFakeNpx();
    return fooDir;
  }

  test("preview resolves installs / skills / mcp without shelling out", async () => {
    await setup();
    const r = await runPluginAdd({ plugins: ["foo"], agents: ["codex", "cursor", "opencode"], apply: false });
    expect(r.sourceError).toBeUndefined();
    expect(r.installs.some((i) => i.agent === "codex" && i.target === "foo@plugins-cli")).toBe(true);
    expect(r.cursor?.repos).toEqual(["owner/foo"]);
    expect(r.skills.map((s) => s.repo)).toContain("owner/foo");
    expect(r.mcp.find((m) => m.agent === "opencode")?.added).toContain("srv");
    expect(pluginAddHasWork(r)).toBe(true);
    // No install/add commands during preview.
    expect((await readInvocations()).some((l) => /plugin add|skills add|plugins add/.test(l))).toBe(false);
  });

  test("apply installs on codex, pushes cursor, adds skills + lifts MCP to non-plugin agents", async () => {
    await setup();
    const r = await runPluginAdd({ plugins: ["foo"], agents: ["codex", "cursor", "opencode"], apply: true });
    expect(r.installs.find((i) => i.agent === "codex")?.status).toBe("installed");
    expect(r.cursor?.results.find((x) => x.repo === "owner/foo")?.status).toBe("installed");
    expect(r.skills.find((s) => s.repo === "owner/foo")?.status).toBe("added");
    expect(r.mcp.find((m) => m.agent === "opencode")?.added).toContain("srv");
    const inv = await readInvocations();
    expect(inv.some((l) => l.trim() === "codex plugin add -- foo@plugins-cli")).toBe(true);
    expect(inv.some((l) => l.trim() === "npx plugins add owner/foo --target cursor -y")).toBe(true);
    expect(inv.some((l) => /npx -y skills add owner\/foo .* -a opencode -y/.test(l))).toBe(true);
    // The lifted server landed in opencode's own MCP config.
    const oc = JSON.parse(await readFile(join(workDir, ".config", "opencode", "opencode.json"), "utf8"));
    expect(oc.mcp?.srv).toBeDefined();
  });

  test("reports a plugin not installed on the source (claude) as notFound", async () => {
    await setup();
    const r = await runPluginAdd({ plugins: ["ghost"], agents: ["codex"], apply: false });
    expect(r.notFound).toEqual(["ghost"]);
    expect(pluginAddHasWork(r)).toBe(false);
  });

  test("surfaces a source-read error instead of guessing", async () => {
    await setup({ listExit: 1 });
    const r = await runPluginAdd({ plugins: ["foo"], agents: ["codex"], apply: false });
    expect(r.sourceError).toBeTruthy();
    expect(pluginAddHasWork(r)).toBe(false);
  });

  test("preview treats Codex's sanitized github-com name as already present", async () => {
    await writePluginWithMcp(join(workDir, "plugins", "gh"), "srv");
    await installFakeClaude(
      JSON.stringify([{ id: "github.com-owner-tool@mkt", enabled: true, installPath: join(workDir, "plugins", "gh") }]),
      JSON.stringify([{ name: "mkt", source: "github", repo: "owner/tool" }]),
    );
    await installFakeCodex(codexTable([["github-com-owner-tool@plugins-cli", "installed, enabled", "1.0.0", "/c/gh"]]));
    await installFakeNpx();

    const r = await runPluginAdd({ plugins: ["github.com-owner-tool"], agents: ["codex"], apply: false });
    expect(r.installs).toEqual([{ agent: "codex", target: "github-com-owner-tool@plugins-cli", status: "present" }]);
    expect(pluginAddHasWork(r)).toBe(false);
  });

  test("apply uses an exact standalone local source for Cursor and loose skills", async () => {
    const local = join(workDir, "plugins", "standalone");
    await mkdir(join(local, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(local, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "standalone" }),
    );
    await mkdir(join(local, "skills", "standalone"), { recursive: true });
    await writeFile(
      join(local, "skills", "standalone", "SKILL.md"),
      "---\nname: standalone\n---\n",
    );
    const canonical = await realpath(local);
    await installFakeClaude(
      JSON.stringify([{ id: "standalone", enabled: true, installPath: local }]),
      "[]",
    );
    await installFakeNpx();

    const report = await runPluginAdd({
      plugins: ["standalone"],
      agents: ["cursor", "opencode"],
      apply: true,
    });

    expect(report.cursor?.repos).toEqual([canonical]);
    expect(report.cursor?.results).toEqual([
      { repo: canonical, status: "installed" },
    ]);
    expect(report.skills).toContainEqual({
      repo: canonical,
      status: "added",
    });
    const calls = await readInvocations();
    expect(calls).toContain(
      `npx plugins add ${canonical} --target cursor -y`,
    );
    expect(
      calls.some((line) =>
        line.includes(`skills add ${canonical}`) && line.includes("-a opencode")
      ),
    ).toBe(true);
  });
});
