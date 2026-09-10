import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { lstat, mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudePluginAdapter } from "../src/plugins/claude.ts";
import { codexPluginAdapter } from "../src/plugins/codex.ts";
import { removeArgs, removeSkillNames } from "../src/skills.ts";
import { resolvePluginMcpServers } from "../src/plugins/mcp.ts";
import { runPluginUninstall, uninstallHasChanges } from "../src/plugins/uninstall.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;
let originalGrokHome: string | undefined;
let invocationsFile: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-uninstall-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  originalGrokHome = process.env.GROK_HOME;
  process.env.HOME = workDir;
  invocationsFile = join(workDir, "invocations.log");
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  if (originalGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = originalGrokHome;
  await rm(workDir, { recursive: true, force: true });
});

async function readInvocations(): Promise<string[]> {
  try {
    return (await readFile(invocationsFile, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// `codex plugin list` fixed-width table, as the real CLI prints it.
type CodexRow = [id: string, status: string, version: string, path: string];
function codexTable(rows: CodexRow[]): string {
  const header: CodexRow = ["PLUGIN", "STATUS", "VERSION", "PATH"];
  const all = [header, ...rows];
  const w = [0, 1, 2].map((i) => Math.max(...all.map((r) => r[i]!.length)));
  const fmt = (r: CodexRow) =>
    `${r[0].padEnd(w[0]! + 2)}${r[1].padEnd(w[1]! + 2)}${r[2].padEnd(w[2]! + 2)}${r[3]}`.replace(/\s+$/, "");
  return ["Marketplace `mkt`", "/x/marketplace.json", "", fmt(header), ...rows.map(fmt), ""].join("\n");
}

// Fake `claude`: plugin list (+ marketplace list) + a configurable `plugin uninstall`.
// `listExit` makes `plugin list --json` fail, exercising the unreadable-Claude path.
async function installFakeClaude(
  listJson: string,
  opts: { uninstallExit?: number; uninstallStderr?: string; listExit?: number; confirmUninstall?: boolean } = {},
) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const listFile = join(workDir, "claude-list.json");
  const removedListFile = join(workDir, "claude-list-removed.json");
  await writeFile(listFile, listJson);
  await writeFile(removedListFile, "[]");
  const stderr = (opts.uninstallStderr ?? "fake uninstall failure").replace(/`/g, "\\`");
  const listBranch = opts.listExit != null ? `echo "claude list boom" >&2; exit ${opts.listExit}` : `cat ${listFile}; exit 0`;
  const script = `#!/bin/sh
echo "claude $@" >> ${invocationsFile}
if [ "$1 $2 $3" = "plugin list --json" ]; then ${listBranch}; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then echo "[]"; exit 0; fi
if [ "$1 $2" = "plugin uninstall" ]; then ${
    opts.uninstallExit != null
      ? `echo "${stderr}" >&2; exit ${opts.uninstallExit}`
      : opts.confirmUninstall === false
        ? "exit 0"
        : `cp ${removedListFile} ${listFile}; exit 0`
  }; fi
exit 0
`;
  const p = join(binDir, "claude");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

// Fake `codex`: plugin list + a configurable `plugin remove`. Additive to PATH so a
// fake claude installed first survives.
async function installFakeCodex(listText: string, opts: { removeExit?: number; removeStderr?: string } = {}) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const listFile = join(workDir, "codex-list.txt");
  await writeFile(listFile, listText);
  const stderr = (opts.removeStderr ?? "fake remove failure").replace(/`/g, "\\`");
  const script = `#!/bin/sh
echo "codex $@" >> ${invocationsFile}
if [ "$1 $2" = "plugin list" ]; then cat ${listFile}; exit 0; fi
if [ "$1 $2" = "plugin remove" ]; then ${opts.removeExit != null ? `echo "${stderr}" >&2; exit ${opts.removeExit}` : "exit 0"}; fi
exit 0
`;
  const p = join(binDir, "codex");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
}

async function installFakeGrok(listJson: string, disabled: string[] = []) {
  const binDir = join(workDir, "bin");
  const grokHome = join(workDir, ".grok");
  await mkdir(binDir, { recursive: true });
  await mkdir(grokHome, { recursive: true });
  process.env.GROK_HOME = grokHome;
  await writeFile(
    join(grokHome, "config.toml"),
    `[plugins]\ndisabled = ${JSON.stringify(disabled)}\n`,
  );
  const listFile = join(workDir, "grok-list.json");
  const removedListFile = join(workDir, "grok-list-removed.json");
  await writeFile(listFile, listJson);
  await writeFile(removedListFile, "[]");
  const script = `#!/bin/sh
echo "grok $@" >> ${invocationsFile}
if [ "$1 $2 $3" = "plugin list --json" ]; then cat ${listFile}; exit 0; fi
if [ "$1 $2" = "plugin uninstall" ]; then cp ${removedListFile} ${listFile}; exit 0; fi
exit 0
`;
  const p = join(binDir, "grok");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
}

// Fake `npx`: skills list (returns a mutable listJson) + a configurable skills remove.
// A successful remove updates the list so post-remove verification sees the state
// change; removeListJson can model a partial target result.
async function installFakeNpx(opts: {
  listJson?: string;
  removeListJson?: string;
  listExit?: number;
  removeExit?: number;
  removeStderr?: string;
} = {}) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const listFile = join(workDir, "skills-list.json");
  await writeFile(listFile, opts.listJson ?? "[]");
  const removeExit = opts.removeExit ?? 0;
  const script = `#!/bin/sh
echo "npx $@" >> ${invocationsFile}
if [ "$2 $3" = "skills list" ]; then cat ${listFile}; exit ${opts.listExit ?? 0}; fi
if [ "$2 $3" = "skills remove" ]; then ${opts.removeStderr ? `echo "${opts.removeStderr}" >&2;` : ""} if [ ${removeExit} -eq 0 ]; then printf '%s' '${opts.removeListJson ?? "[]"}' > ${listFile}; fi; exit ${removeExit}; fi
exit 0
`;
  const p = join(binDir, "npx");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
}

// A small upstream-shaped fixture: list derives its agent labels from the actual
// Pi/Cline target paths, and remove mutates only the selected target paths. This
// keeps the regression at the process boundary instead of trusting a fake exit code.
async function installFilesystemSkillNpx(opts: { leavePi?: boolean; blockVerification?: boolean } = {}) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const clineSkill = join(workDir, ".agents", "skills", "alpha");
  const piSkill = join(workDir, ".pi", "agent", "skills", "alpha");
  const blocked = join(workDir, "skills-list-blocked");
  const leavePi = opts.leavePi ? 1 : 0;
  const script = `#!/bin/sh
echo "npx $@" >> ${invocationsFile}
if [ "$2 $3" = "skills list" ]; then
  if [ -f "${blocked}" ]; then echo "skills list unavailable" >&2; exit 1; fi
  agents=""
  if [ -f "${clineSkill}/SKILL.md" ]; then agents='"Cline"'; fi
  if [ -f "${piSkill}/SKILL.md" ]; then
    if [ -n "$agents" ]; then agents="$agents,\"Pi\""; else agents='"Pi"'; fi
  fi
  if [ -n "$agents" ]; then printf '[{"name":"alpha","path":"${clineSkill}","agents":[%s]}]\n' "$agents"; else echo '[]'; fi
  exit 0
fi
if [ "$2 $3" = "skills remove" ]; then
  case " $* " in *" -a cline "*) rm -rf "${clineSkill}" ;; esac
  case " $* " in *" -a pi "*) if [ ${leavePi} -eq 0 ]; then rm -rf "${piSkill}"; fi ;; esac
  ${opts.blockVerification ? `touch "${blocked}"` : ""}
  exit 0
fi
exit 0
`;
  const p = join(binDir, "npx");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// Materialize a plugin install dir with skills/<name>/SKILL.md leaves.
async function writePluginSkills(dir: string, skills: string[]) {
  for (const s of skills) {
    await mkdir(join(dir, "skills", s), { recursive: true });
    await writeFile(join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`);
  }
}

describe("claude uninstallPlugin", () => {
  test("returns 'absent' without shelling uninstall when the plugin isn't installed", async () => {
    await installFakeClaude(JSON.stringify([{ id: "other@mkt", enabled: true }]));
    const res = await claudePluginAdapter.uninstallPlugin("foo", { dryRun: false });
    expect(res.status).toBe("absent");
    expect((await readInvocations()).some((l) => /plugin uninstall/.test(l))).toBe(false);
  });

  test("dry-run reports uninstalled without shelling out", async () => {
    await installFakeClaude(JSON.stringify([{ id: "foo@mkt", enabled: true }]));
    const res = await claudePluginAdapter.uninstallPlugin("foo", { dryRun: true, marketplace: "mkt" });
    expect(res.status).toBe("uninstalled");
    expect(res.message).toBe("dry-run");
    expect((await readInvocations()).some((l) => /plugin uninstall/.test(l))).toBe(false);
  });

  test("uninstalls with `--yes --` and the qualified target", async () => {
    await installFakeClaude(JSON.stringify([{ id: "foo@mkt", enabled: true }]));
    const res = await claudePluginAdapter.uninstallPlugin("foo", { dryRun: false, marketplace: "mkt" });
    expect(res.status).toBe("uninstalled");
    expect((await readInvocations()).some((l) => l.trim() === "claude plugin uninstall --yes -- foo@mkt")).toBe(true);
  });

  test("fails when uninstall exits zero but a fresh list still contains the plugin", async () => {
    await installFakeClaude(JSON.stringify([{ id: "foo@mkt", enabled: true }]), { confirmUninstall: false });
    const res = await claudePluginAdapter.uninstallPlugin("foo", { dryRun: false, marketplace: "mkt" });
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/fresh|verify|installed/i);
  });

  test("passes --keep-data before the separator when requested", async () => {
    await installFakeClaude(JSON.stringify([{ id: "foo@mkt", enabled: true }]));
    await claudePluginAdapter.uninstallPlugin("foo", { dryRun: false, marketplace: "mkt", keepData: true });
    expect((await readInvocations()).some((l) => l.trim() === "claude plugin uninstall --yes --keep-data -- foo@mkt")).toBe(true);
  });

  test("rejects unsafe plugin names before invoking the CLI", async () => {
    await installFakeClaude(JSON.stringify([]));
    const res = await claudePluginAdapter.uninstallPlugin("../etc/passwd", { dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("traversal");
    expect((await readInvocations()).some((l) => /plugin uninstall/.test(l))).toBe(false);
  });

  test("surfaces a non-zero uninstall exit as failed with stderr", async () => {
    await installFakeClaude(JSON.stringify([{ id: "foo@mkt", enabled: true }]), { uninstallExit: 3, uninstallStderr: "still in use" });
    const res = await claudePluginAdapter.uninstallPlugin("foo", { dryRun: false, marketplace: "mkt" });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("still in use");
  });

  test("missing claude CLI is a clear failure", async () => {
    process.env.PATH = "";
    const res = await claudePluginAdapter.uninstallPlugin("foo", { dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("not found");
  });
});

describe("codex uninstallPlugin", () => {
  test("'absent' (no shell out) when not installed", async () => {
    await installFakeCodex(codexTable([["other@mkt", "installed, enabled", "1.0.0", "/c/other"]]));
    const res = await codexPluginAdapter.uninstallPlugin("foo", { dryRun: false });
    expect(res.status).toBe("absent");
    expect((await readInvocations()).some((l) => /plugin remove/.test(l))).toBe(false);
  });

  test("resolves the installed marketplace from the snapshot and removes with `--`", async () => {
    await installFakeCodex(codexTable([["foo@mkt", "installed, enabled", "1.0.0", "/c/foo"]]));
    const res = await codexPluginAdapter.uninstallPlugin("foo", { dryRun: false });
    expect(res.status).toBe("uninstalled");
    expect(res.target).toBe("foo@mkt");
    expect((await readInvocations()).some((l) => l.trim() === "codex plugin remove -- foo@mkt")).toBe(true);
  });

  test("skips (no removal) when installed under multiple marketplaces and none given", async () => {
    await installFakeCodex(
      codexTable([
        ["foo@mkt-a", "installed, enabled", "1.0.0", "/c/a"],
        ["foo@mkt-b", "installed, enabled", "1.0.0", "/c/b"],
      ]),
    );
    const res = await codexPluginAdapter.uninstallPlugin("foo", { dryRun: false });
    expect(res.status).toBe("skipped");
    expect(res.message).toContain("multiple marketplaces");
    expect((await readInvocations()).some((l) => /plugin remove/.test(l))).toBe(false);
  });

  test("dry-run does not shell out", async () => {
    await installFakeCodex(codexTable([["foo@mkt", "installed, enabled", "1.0.0", "/c/foo"]]));
    const res = await codexPluginAdapter.uninstallPlugin("foo", { dryRun: true });
    expect(res.status).toBe("uninstalled");
    expect(res.message).toBe("dry-run");
    expect((await readInvocations()).some((l) => /plugin remove/.test(l))).toBe(false);
  });

  test("missing codex CLI is a clear failure", async () => {
    process.env.PATH = "";
    const res = await codexPluginAdapter.uninstallPlugin("foo", { dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("not found");
  });
});

describe("removeArgs", () => {
  test("builds `skills remove -g -a <agent>… -s <name>… -y` (repeated-flag form)", () => {
    expect(removeArgs(["alpha", "beta"], ["gemini-cli", "opencode"])).toEqual([
      "-y", "skills", "remove", "-g", "-a", "gemini-cli", "-a", "opencode", "-s", "alpha", "-s", "beta", "-y",
    ]);
  });
});

describe("removeSkillNames", () => {
  test("no-op (no names) is a skip, never shells out", async () => {
    await installFakeNpx({});
    const r = await removeSkillNames([], ["opencode"]);
    expect(r.status).toBe("skipped");
    expect((await readInvocations())).toEqual([]);
  });

  test("dry-run reports removed without shelling out, drops unsafe names", async () => {
    const r = await removeSkillNames(["beta", "-rf", "alpha", "alpha"], ["opencode"], { dryRun: true });
    expect(r.status).toBe("removed");
    expect(r.skills).toEqual(["alpha", "beta"]); // deduped, sorted, "-rf" dropped
    expect((await readInvocations())).toEqual([]);
  });

  test("shells `npx skills remove` for the named skills + agents", async () => {
    await installFakeNpx({ removeExit: 0 });
    const r = await removeSkillNames(["alpha"], ["gemini-cli", "opencode"]);
    expect(r.status).toBe("removed");
    expect((await readInvocations()).some((l) => l.trim() === "npx -y skills remove -g -a gemini-cli -a opencode -s alpha -y")).toBe(true);
  });

  test("a 'no matching skills' exit is a benign skip", async () => {
    await installFakeNpx({ removeExit: 1, removeStderr: "No matching skills found" });
    const r = await removeSkillNames(["alpha"], ["opencode"]);
    expect(r.status).toBe("skipped");
  });

  test("a genuine non-zero exit is failed with the cause", async () => {
    await installFakeNpx({ removeExit: 2, removeStderr: "permission denied" });
    const r = await removeSkillNames(["alpha"], ["opencode"]);
    expect(r.status).toBe("failed");
    expect(r.message).toContain("permission denied");
  });
});

describe("runPluginUninstall (orchestrator)", () => {
  // Two plugins sharing a skill: foo→{alpha,shared}, bar→{beta,shared}. Uninstalling
  // foo must remove alpha but KEEP shared (bar still provides it).
  async function setupTwoPlugins() {
    const fooDir = join(workDir, "plugins", "foo");
    const barDir = join(workDir, "plugins", "bar");
    await writePluginSkills(fooDir, ["alpha", "shared"]);
    await writePluginSkills(barDir, ["beta", "shared"]);
    await installFakeClaude(
      JSON.stringify([
        { id: "foo@mkt", enabled: true, installPath: fooDir },
        { id: "bar@mkt", enabled: true, installPath: barDir },
      ]),
    );
    await installFakeCodex(codexTable([["foo@mkt", "installed, enabled", "1.0.0", "/c/foo"]]));
    await installFakeNpx({
      listJson: '[{"name":"alpha","agents":["OpenCode","Gemini CLI"]},{"name":"shared","agents":["OpenCode"]},{"name":"beta","agents":["OpenCode"]}]',
    });
  }

  async function setupPiClinePlugin(opts: { leavePi?: boolean; blockVerification?: boolean } = {}) {
    const fooDir = join(workDir, "plugins", "foo");
    const clineSkill = join(workDir, ".agents", "skills", "alpha");
    const piSkill = join(workDir, ".pi", "agent", "skills", "alpha");
    await writePluginSkills(fooDir, ["alpha"]);
    await installFakeClaude(JSON.stringify([{ id: "foo@mkt", enabled: true, installPath: fooDir }]));
    await mkdir(clineSkill, { recursive: true });
    await mkdir(piSkill, { recursive: true });
    await writeFile(join(clineSkill, "SKILL.md"), "---\nname: alpha\n---\n");
    await writeFile(join(piSkill, "SKILL.md"), "---\nname: alpha\n---\n");
    await installFilesystemSkillNpx(opts);
    return { clineSkill, piSkill };
  }

  test("removes Pi and Cline through their real upstream targets and verifies both paths", async () => {
    const { clineSkill, piSkill } = await setupPiClinePlugin();
    const report = await runPluginUninstall({
      plugins: ["foo"],
      agents: ["pi", "cline"],
      apply: true,
    });

    expect(report.skillResult?.status).toBe("removed");
    expect(report.skillResult?.results).toEqual([
      expect.objectContaining({ agent: "cline", removed: ["alpha"], remaining: [], verified: true, status: "removed" }),
      expect.objectContaining({ agent: "pi", removed: ["alpha"], remaining: [], verified: true, status: "removed" }),
    ]);
    expect((await readInvocations()).some(
      (line) => line.trim() === "npx -y skills remove -g -a cline -a pi -s alpha -y",
    )).toBe(true);
    expect(await fileExists(join(clineSkill, "SKILL.md"))).toBe(false);
    expect(await fileExists(join(piSkill, "SKILL.md"))).toBe(false);
  });

  test("reports partial removal when one selected target remains after a successful command", async () => {
    await setupPiClinePlugin({ leavePi: true });
    const report = await runPluginUninstall({
      plugins: ["foo"],
      agents: ["pi", "cline"],
      apply: true,
    });

    expect(report.skillResult?.status).toBe("partial");
    expect(report.skillResult?.results).toEqual([
      expect.objectContaining({ agent: "cline", removed: ["alpha"], remaining: [], status: "removed" }),
      expect.objectContaining({ agent: "pi", removed: [], remaining: ["alpha"], status: "blocked" }),
    ]);
  });

  test("blocks removal when selected-agent post-remove verification is unreadable", async () => {
    await setupPiClinePlugin({ blockVerification: true });
    const report = await runPluginUninstall({
      plugins: ["foo"],
      agents: ["pi", "cline"],
      apply: true,
    });

    expect(report.skillResult?.status).toBe("blocked");
    expect(report.skillResult?.results.every((result) => result.status === "blocked" && !result.verified)).toBe(true);
    expect(report.skillResult?.message).toMatch(/verification failed/i);
  });

  test("preview: keeps a skill another plugin still provides; narrows skill agents to those holding it", async () => {
    await setupTwoPlugins();
    const r = await runPluginUninstall({
      plugins: ["foo"],
      agents: ["claude-code", "codex", "opencode", "gemini-cli"],
      apply: false,
    });
    // native present on both plugin agents
    expect(r.native.find((t) => t.agent === "claude-code")?.present).toBe(true);
    expect(r.native.find((t) => t.agent === "codex")?.present).toBe(true);
    // alpha removed, shared kept (bar provides it)
    expect(r.skills.names).toEqual(["alpha"]);
    expect(r.skills.kept).toEqual(["shared"]);
    // alpha lives on opencode + gemini-cli (both requested) → both targeted
    expect(r.skills.agents).toEqual(["gemini-cli", "opencode"]);
    expect(uninstallHasChanges(r)).toBe(true);
    // preview must not have shelled any uninstall/remove
    expect((await readInvocations()).some((l) => /plugin uninstall|plugin remove|skills remove/.test(l))).toBe(false);
  });

  test("apply: uninstalls natively on claude+codex and removes the right skill", async () => {
    await setupTwoPlugins();
    const r = await runPluginUninstall({
      plugins: ["foo"],
      agents: ["claude-code", "codex", "opencode", "gemini-cli"],
      apply: true,
    });
    expect(r.nativeResults?.find((x) => x.agent === "claude-code")?.status).toBe("uninstalled");
    expect(r.nativeResults?.find((x) => x.agent === "codex")?.status).toBe("uninstalled");
    expect(r.skillResult?.status).toBe("removed");
    const inv = await readInvocations();
    expect(inv.some((l) => l.trim() === "claude plugin uninstall --yes -- foo@mkt")).toBe(true);
    expect(inv.some((l) => l.trim() === "codex plugin remove -- foo@mkt")).toBe(true);
    expect(inv.some((l) => l.trim() === "npx -y skills remove -g -a gemini-cli -a opencode -s alpha -y")).toBe(true);
  });

  test("scoping to only plugin agents removes no skills", async () => {
    await setupTwoPlugins();
    const r = await runPluginUninstall({ plugins: ["foo"], agents: ["claude-code", "codex"], apply: false });
    expect(r.skills.agents).toEqual([]);
    expect(r.skills.names).toEqual(["alpha"]); // computed, but no agents in scope to remove from
    expect(uninstallHasChanges(r)).toBe(true); // native still has work
  });

  // Regression (review P1): a name installed from multiple marketplaces must not be
  // collapsed to one arbitrary marketplace — every instance is targeted, and an
  // explicit `name@marketplace` scopes to just one.
  test("a duplicate plugin name across marketplaces targets every instance, not an arbitrary one", async () => {
    await installFakeClaude(
      JSON.stringify([
        { id: "foo@mkt-a", enabled: true, installPath: join(workDir, "plugins", "foo-a") },
        { id: "foo@mkt-b", enabled: true, installPath: join(workDir, "plugins", "foo-b") },
      ]),
    );
    await installFakeNpx({ listJson: "[]" });
    const r = await runPluginUninstall({ plugins: ["foo"], agents: ["claude-code"], apply: false });
    const claudeTargets = r.native.filter((t) => t.agent === "claude-code" && t.present);
    expect(claudeTargets.map((t) => t.marketplace).sort()).toEqual(["mkt-a", "mkt-b"]);
  });

  test("an explicit name@marketplace scopes to a single instance", async () => {
    await installFakeClaude(
      JSON.stringify([
        { id: "foo@mkt-a", enabled: true, installPath: join(workDir, "plugins", "foo-a") },
        { id: "foo@mkt-b", enabled: true, installPath: join(workDir, "plugins", "foo-b") },
      ]),
    );
    await installFakeNpx({ listJson: "[]" });
    const r = await runPluginUninstall({ plugins: ["foo@mkt-a"], agents: ["claude-code"], apply: false });
    const claudeTargets = r.native.filter((t) => t.agent === "claude-code" && t.present);
    expect(claudeTargets.map((t) => t.marketplace)).toEqual(["mkt-a"]);
  });

  test("a disabled Grok plugin is planned and sent through native uninstall", async () => {
    const fooDir = join(workDir, "plugins", "foo");
    await mkdir(fooDir, { recursive: true });
    await installFakeClaude("[]");
    await installFakeGrok(JSON.stringify([{
      status: "installed",
      name: "foo",
      repo_key: "owner/repo",
      version: "1.0.0",
      path: fooDir,
      source: "owner/repo",
      marketplace: "grok-mkt",
    }]), ["foo"]);
    await installFakeNpx({ listJson: "[]" });

    const report = await runPluginUninstall({
      plugins: ["foo@grok-mkt"],
      agents: ["grok-build"],
      apply: true,
    });

    expect(report.native).toContainEqual({
      agent: "grok-build",
      plugin: "foo",
      marketplace: "grok-mkt",
      present: true,
    });
    expect(report.nativeResults).toContainEqual({
      agent: "grok-build",
      target: "foo",
      status: "uninstalled",
    });
    expect((await readInvocations()).some(
      (line) => line.trim() === "grok plugin uninstall foo --confirm",
    )).toBe(true);
  });

  // Regression (review P2): when the mirror put a plugin's skills onto Codex via the
  // skills fallback (Codex couldn't load it natively), `plugin rm` must remove those
  // flat skills from Codex too — not just the skill-cohort agents.
  test("removes a plugin's fallback skills from Codex when scoped there", async () => {
    const fooDir = join(workDir, "plugins", "foo");
    await writePluginSkills(fooDir, ["alpha"]);
    await installFakeClaude(JSON.stringify([{ id: "foo@mkt", enabled: true, installPath: fooDir }]));
    // Codex has NO native foo plugin (it was a skills-only/unloadable bundle)...
    await installFakeCodex(codexTable([["other@mkt", "installed, enabled", "1.0.0", "/c/other"]]));
    // ...but `npx skills` registered alpha for Codex (the mirror fallback) + OpenCode.
    await installFakeNpx({ listJson: '[{"name":"alpha","agents":["Codex","OpenCode"]}]', removeExit: 0 });

    const r = await runPluginUninstall({ plugins: ["foo"], agents: ["codex", "opencode"], apply: true });
    expect(r.native.find((t) => t.agent === "codex")?.present).toBe(false); // not native on codex
    expect(r.skills.agents).toEqual(["codex", "opencode"]);
    expect(r.skillResult?.status).toBe("removed");
    expect((await readInvocations()).some((l) => l.trim() === "npx -y skills remove -g -a codex -a opencode -s alpha -y")).toBe(true);
  });

  // Regression (review P2/finding 3): the SKILL.md frontmatter name can differ from
  // the install slug; `npx skills list`/`remove` key on the slug. Removal must resolve
  // to the slug the CLI actually recognizes, not the (shown-but-unmatched) name.
  test("resolves removal to the install slug when it differs from the frontmatter name", async () => {
    const fooDir = join(workDir, "plugins", "foo");
    await mkdir(join(fooDir, "skills", "convex-best-practices"), { recursive: true });
    await writeFile(join(fooDir, "skills", "convex-best-practices", "SKILL.md"), "---\nname: Convex Best Practices\n---\n");
    await installFakeClaude(JSON.stringify([{ id: "foo@mkt", enabled: true, installPath: fooDir }]));
    await installFakeCodex(codexTable([])); // foo not native on codex
    // `skills list` reports the SLUG, not the spaced frontmatter name.
    await installFakeNpx({ listJson: '[{"name":"convex-best-practices","agents":["OpenCode"]}]', removeExit: 0 });

    const r = await runPluginUninstall({ plugins: ["foo"], agents: ["opencode"], apply: true });
    expect(r.skills.names).toEqual(["convex-best-practices"]); // slug, not "Convex Best Practices"
    expect(r.skillResult?.status).toBe("removed");
    expect((await readInvocations()).some((l) => l.trim() === "npx -y skills remove -g -a opencode -s convex-best-practices -y")).toBe(true);
  });

  test("dry-run and apply remove exact degraded MCP while preserving modified conflicts", async () => {
    const fooDir = join(workDir, "plugins", "foo");
    await writePluginSkills(fooDir, ["alpha"]);
    await writeFile(
      join(fooDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          owned: { command: "plugin-command" },
          modified: { command: "plugin-command" },
        },
      }),
    );
    await installFakeClaude(
      JSON.stringify([{ id: "foo@mkt", enabled: true, installPath: fooDir }]),
    );
    await installFakeNpx({
      listJson: '[{"name":"alpha","agents":["OpenCode"]}]',
      removeExit: 0,
    });
    const opencodePath = join(workDir, ".config", "opencode", "opencode.json");
    await mkdir(join(opencodePath, ".."), { recursive: true });
    await writeFile(
      opencodePath,
      JSON.stringify({
        mcp: {
          owned: { type: "local", command: ["plugin-command"] },
          modified: { type: "local", command: ["user-command"] },
          keep: { type: "local", command: ["keep-command"] },
        },
      }),
    );
    const before = await readFile(opencodePath, "utf8");

    const preview = await runPluginUninstall({
      plugins: ["foo"],
      agents: ["opencode"],
      apply: false,
    });

    expect(preview.mcp).toEqual([
      expect.objectContaining({
        agent: "opencode",
        names: ["owned"],
        conflicts: ["modified"],
      }),
    ]);
    expect(await readFile(opencodePath, "utf8")).toBe(before);
    expect(
      (await readInvocations()).some((line) =>
        /skills remove|plugin uninstall|plugin remove/.test(line)
      ),
    ).toBe(false);

    const applied = await runPluginUninstall({
      plugins: ["foo"],
      agents: ["opencode"],
      apply: true,
    });
    expect(applied.mcpResults).toContainEqual(
      expect.objectContaining({
        agent: "opencode",
        removed: ["owned"],
        conflicts: ["modified"],
        status: "synced",
      }),
    );
    const current = JSON.parse(await readFile(opencodePath, "utf8")) as {
      mcp: Record<string, unknown>;
    };
    expect(current.mcp.owned).toBeUndefined();
    expect(current.mcp.modified).toEqual({
      type: "local",
      command: ["user-command"],
    });
    expect(current.mcp.keep).toBeDefined();
  });

  test("canonical stdio ownership resolves through the PLUGIN_DATA preview without creating state", async () => {
    const savedDataHome = process.env.SYNCTHIS_DATA_HOME;
    const savedXdgData = process.env.XDG_DATA_HOME;
    delete process.env.SYNCTHIS_DATA_HOME;
    delete process.env.XDG_DATA_HOME;
    try {
      const fooDir = join(workDir, "plugins", "canon");
      await mkdir(fooDir, { recursive: true });
      await writeFile(
        join(fooDir, "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "canon",
        }),
      );
      await writeFile(
        join(fooDir, "mcp.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: { svc: { type: "stdio", command: "run", args: ["${PLUGIN_DATA}/db"] } },
        }),
      );
      await installFakeClaude(
        JSON.stringify([{ id: "canon@mkt", enabled: true, installPath: fooDir }]),
      );
      await installFakeNpx({ listJson: "[]" });

      // Seed the target with the EXACT value an apply would have lifted
      // (computed with the same preview intent — no filesystem writes).
      const dataRoot = join(workDir, ".local", "share");
      const { servers } = await resolvePluginMcpServers(
        [{ name: "canon", marketplace: "mkt", path: fooDir, enabled: true }],
        { dataHome: { intent: "preview", dataRoot } },
      );
      const owned = servers.find((s) => s.name === "svc")!.server;
      const geminiPath = join(workDir, ".gemini", "settings.json");
      await mkdir(join(geminiPath, ".."), { recursive: true });
      await writeFile(geminiPath, JSON.stringify({ mcpServers: { svc: owned } }));

      const preview = await runPluginUninstall({
        plugins: ["canon"],
        agents: ["gemini-cli"],
        apply: false,
      });
      expect(preview.mcp).toEqual([
        expect.objectContaining({ agent: "gemini-cli", names: ["svc"] }),
      ]);
      // Ownership resolution must not create durable state.
      let created = true;
      try {
        await lstat(dataRoot);
      } catch {
        created = false;
      }
      expect(created).toBe(false);
    } finally {
      if (savedDataHome === undefined) delete process.env.SYNCTHIS_DATA_HOME;
      else process.env.SYNCTHIS_DATA_HOME = savedDataHome;
      if (savedXdgData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdgData;
    }
  });

  test("an unreadable degraded MCP target is a reported failure and is never mutated", async () => {
    const fooDir = join(workDir, "plugins", "foo");
    await mkdir(fooDir, { recursive: true });
    await writeFile(
      join(fooDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { owned: { command: "plugin-command" } } }),
    );
    await installFakeClaude(
      JSON.stringify([{ id: "foo@mkt", enabled: true, installPath: fooDir }]),
    );
    await installFakeNpx({ listJson: "[]" });
    const opencodePath = join(workDir, ".config", "opencode", "opencode.json");
    await mkdir(join(opencodePath, ".."), { recursive: true });
    await writeFile(opencodePath, "{not json");

    const report = await runPluginUninstall({
      plugins: ["foo"],
      agents: ["opencode"],
      apply: true,
    });

    expect(report.mcp).toEqual([
      expect.objectContaining({
        agent: "opencode",
        names: [],
        unreadable: expect.any(String),
      }),
    ]);
    expect(report.mcpResults).toEqual([
      expect.objectContaining({
        agent: "opencode",
        status: "failed",
        removed: [],
      }),
    ]);
    expect(await readFile(opencodePath, "utf8")).toBe("{not json");
  });

  test("matches Codex's sanitized github-com plugin name for native uninstall", async () => {
    await installFakeClaude(JSON.stringify([{ id: "github.com-owner-tool@mkt", enabled: true, installPath: join(workDir, "plugins", "tool") }]));
    await installFakeCodex(codexTable([["github-com-owner-tool@plugins-cli", "installed, enabled", "1.0.0", "/c/tool"]]));
    await installFakeNpx({ listJson: "[]" });

    const r = await runPluginUninstall({ plugins: ["github.com-owner-tool"], agents: ["codex"], apply: true });
    expect(r.native.find((t) => t.agent === "codex")?.present).toBe(true);
    expect(r.nativeResults?.find((x) => x.agent === "codex")?.status).toBe("uninstalled");
    expect((await readInvocations()).some((l) => l.trim() === "codex plugin remove -- github-com-owner-tool@plugins-cli")).toBe(true);
  });

  // Regression (review finding 2): a skill-only scope must NOT silently no-op when
  // Claude's plugin list (the skill-name source) is unreadable.
  test("surfaces a Claude-read error instead of an empty skill plan", async () => {
    await installFakeClaude("[]", { listExit: 1 }); // `claude plugin list` fails
    await installFakeNpx({ listJson: "[]" });
    const r = await runPluginUninstall({ plugins: ["foo"], agents: ["opencode"], apply: false });
    expect(r.claudeReadError).toBeTruthy();
    expect(r.skillScope).toContain("opencode");
    expect(r.skills.names).toEqual([]); // couldn't resolve — surfaced, not silently dropped
  });

  // Regression (Claude re-review P2): on APPLY, an unreadable Claude must still carry
  // claudeReadError + skillScope (and run no skill removal) so the CLI can surface it
  // rather than report a clean apply that silently dropped skill removal.
  test("apply also surfaces a Claude-read error and runs no skill removal", async () => {
    await installFakeClaude("[]", { listExit: 1 });
    await installFakeNpx({ listJson: "[]" });
    const r = await runPluginUninstall({ plugins: ["foo"], agents: ["opencode"], apply: true });
    expect(r.claudeReadError).toBeTruthy();
    expect(r.skillScope).toContain("opencode");
    expect(r.skills.names).toEqual([]);
    expect(r.skillResult).toBeUndefined(); // nothing removed
  });

  // Regression (review P2): a Codex-only scope must NOT be hard-blocked when Claude is
  // unreadable — Codex's content is its native plugin, so the native uninstall is the
  // real work; surfaced-skill resolution is best-effort there. requiredSkillAgents
  // (which the CLI exits on) must exclude Codex.
  test("codex-only scope is not skill-blocked when Claude is unreadable", async () => {
    await installFakeClaude("[]", { listExit: 1 }); // claude plugin list fails
    await installFakeCodex(codexTable([["foo@mkt", "installed, enabled", "1.0.0", "/c/foo"]]));
    await installFakeNpx({ listJson: "[]" });
    const r = await runPluginUninstall({ plugins: ["foo"], agents: ["codex"], apply: true });
    expect(r.claudeReadError).toBeTruthy();
    expect(r.skillScope).toEqual(["codex"]); // codex IS a skill-removal candidate…
    expect(r.requiredSkillAgents).toEqual([]); // …but not a *required* one (native covers it)
    expect(r.nativeResults?.find((x) => x.agent === "codex")?.status).toBe("uninstalled");
  });

  test("codex loose-fallback-only scope is skill-blocked when Claude is unreadable", async () => {
    await installFakeClaude("[]", { listExit: 1 });
    await installFakeCodex(codexTable([["other@mkt", "installed, enabled", "1.0.0", "/c/other"]]));
    await installFakeNpx({ listJson: "[]" });
    const r = await runPluginUninstall({ plugins: ["foo"], agents: ["codex"], apply: false });
    expect(r.claudeReadError).toBeTruthy();
    expect(r.skillScope).toEqual(["codex"]);
    expect(r.native.find((target) => target.agent === "codex")?.present).toBe(false);
    expect(r.requiredSkillAgents).toEqual(["codex"]);
  });

  test("cursor is reported unsupported, nothing to do when the plugin is absent everywhere", async () => {
    await installFakeClaude(JSON.stringify([]));
    await installFakeCodex(codexTable([["other@mkt", "installed, enabled", "1.0.0", "/c/other"]]));
    await installFakeNpx({ listJson: "[]" });
    const r = await runPluginUninstall({ plugins: ["ghost"], agents: ["claude-code", "codex", "cursor"], apply: false });
    expect(r.unsupportedAgents).toContain("cursor");
    expect(uninstallHasChanges(r)).toBe(false);
  });
});
