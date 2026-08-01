import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudePluginAdapter } from "../src/plugins/claude.ts";
import { codexPluginAdapter, planCodexPluginInstall } from "../src/plugins/codex.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;
let originalCodexHome: string | undefined;
let invocationsFile: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-install-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  originalCodexHome = process.env.CODEX_HOME;
  process.env.HOME = workDir;
  delete process.env.CODEX_HOME;
  invocationsFile = join(workDir, "invocations.log");
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  if (originalCodexHome == null) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await rm(workDir, { recursive: true, force: true });
});

async function installFakeCli(
  name: "claude" | "codex",
  listOutput: string,
  opts: { exitOnAdd?: number; addStderr?: string; confirmAdd?: boolean; verifiedListOutput?: string } = {},
) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const listFile = join(workDir, `${name}-list.json`);
  const verifiedListFile = join(workDir, `${name}-list-verified.json`);
  await writeFile(listFile, listOutput);
  await writeFile(verifiedListFile, opts.verifiedListOutput ?? listOutput.replace(/not installed/g, "installed    "));
  const listCase =
    name === "claude"
      ? `if [ "$1 $2 $3" = "plugin list --json" ]; then cat ${listFile}; exit 0; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then echo "[]"; exit 0; fi`
      : `if [ "$1 $2" = "plugin list" ]; then cat ${listFile}; exit 0; fi`;
  // Escape backticks so the shell preserves them literally (the real Codex mismatch
  // error quotes names in backticks, and the adapter parses the canonical name from
  // them). An unescaped backtick in a double-quoted echo triggers command substitution.
  const addStderr = (opts.addStderr ?? "fake failure").replace(/`/g, "\\`");
  const addCase =
    opts.exitOnAdd != null
      ? `case "$1 $2" in
  "plugin install"|"plugin add")
    echo "${addStderr}" >&2
    exit ${opts.exitOnAdd}
    ;;
esac`
      : name === "codex"
        ? opts.confirmAdd === false
          ? `if [ "$1 $2" = "plugin add" ]; then exit 0; fi`
          : `if [ "$1 $2" = "plugin add" ]; then cp ${verifiedListFile} ${listFile}; exit 0; fi`
        : opts.confirmAdd === false
          ? `if [ "$1 $2" = "plugin install" ]; then exit 0; fi`
          : `if [ "$1 $2" = "plugin install" ]; then cp ${verifiedListFile} ${listFile}; exit 0; fi`;
  const script = `#!/bin/sh
echo "${name} $@" >> ${invocationsFile}
${listCase}
${addCase}
exit 0
`;
  const p = join(binDir, name);
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

async function readInvocations(): Promise<string[]> {
  try {
    return (await readFile(invocationsFile, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function installFakeNpx(body: string) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const script = `#!/bin/sh
echo "npx $@" >> ${invocationsFile}
${body}
`;
  const path = join(binDir, "npx");
  await writeFile(path, script);
  await chmod(path, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

// Render a `codex plugin list` table (the real CLI's fixed-width format) so the
// codex adapter, which now reads install truth from that command, sees state.
type CodexRow = [id: string, status: string, version: string, path: string];
function codexListTable(rows: CodexRow[]): string {
  const header: CodexRow = ["PLUGIN", "STATUS", "VERSION", "PATH"];
  const all = [header, ...rows];
  const w0 = Math.max(...all.map((r) => r[0].length));
  const w1 = Math.max(...all.map((r) => r[1].length));
  const w2 = Math.max(...all.map((r) => r[2].length));
  const fmt = (r: CodexRow) =>
    `${r[0].padEnd(w0 + 2)}${r[1].padEnd(w1 + 2)}${r[2].padEnd(w2 + 2)}${r[3]}`.replace(/\s+$/, "");
  return ["Marketplace `mkt`", "/x/marketplace.json", "", fmt(header), ...rows.map(fmt), ""].join("\n");
}

// Render a `codex plugin marketplace list` table (MARKETPLACE / ROOT columns) so the
// local-marketplace path can parse current marketplaces and decide reuse-vs-add.
function mktTable(rows: [name: string, root: string][]): string {
  const all: [string, string][] = [["MARKETPLACE", "ROOT"], ...rows];
  const w = Math.max(...all.map((r) => r[0].length)) + 2;
  return all.map(([n, r]) => n.padEnd(w) + r).join("\n") + "\n";
}

// Fakes for the --provision path: a `codex` whose `plugin list` gains the plugin
// only AFTER fake `npx plugins add` drops a sentinel — exercising the
// provision → re-read → install chain.
async function installProvisionFakes(
  name: string,
  opts: { npxFail?: { exit: number; stderr: string }; neverExposes?: boolean } = {},
) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const sentinel = join(workDir, "provisioned");
  const installedSentinel = join(workDir, "installed");
  const absentFile = join(workDir, "codex-absent.txt");
  const presentFile = join(workDir, "codex-present.txt");
  await writeFile(absentFile, codexListTable([["other@plugins-cli", "not installed", "", "/cache/other"]]));
  await writeFile(
    presentFile,
    codexListTable([
      ["other@plugins-cli", "not installed", "", "/cache/other"],
      [`${name}@plugins-cli`, "not installed", "", `/cache/${name}`],
    ]),
  );
  const installedFile = join(workDir, "codex-installed.txt");
  await writeFile(
    installedFile,
    codexListTable([
      ["other@plugins-cli", "not installed", "", "/cache/other"],
      [`${name}@plugins-cli`, "installed, enabled", "1.0.0", `/cache/${name}`],
    ]),
  );
  // neverExposes: a skills-only bundle — provisioning the repo succeeds (sentinel
  // drops, npx exits 0) but `codex plugin list` NEVER shows a plugin of this name,
  // so candidates stay 0 after the re-read. Exercises the skills-fallback path.
  const listBody = opts.neverExposes
    ? `cat ${absentFile}`
    : `if [ -f ${installedSentinel} ]; then cat ${installedFile}; elif [ -f ${sentinel} ]; then cat ${presentFile}; else cat ${absentFile}; fi`;
  const codex = `#!/bin/sh
echo "codex $@" >> ${invocationsFile}
if [ "$1 $2" = "plugin list" ]; then
  ${listBody}
  exit 0
fi
if [ "$1 $2" = "plugin add" ]; then touch ${installedSentinel}; exit 0; fi
exit 0
`;
  await writeFile(join(binDir, "codex"), codex);
  await chmod(join(binDir, "codex"), 0o755);
  // On `plugins add`: succeed (drop sentinel so the next `plugin list` shows it),
  // or, when npxFail is set, emit stderr and exit non-zero without provisioning.
  const addBranch = opts.npxFail
    ? `echo "${opts.npxFail.stderr}" >&2; exit ${opts.npxFail.exit}`
    : `touch ${sentinel}; exit 0`;
  const npx = `#!/bin/sh
echo "npx $@" >> ${invocationsFile}
if [ "$1 $2" = "plugins add" ]; then ${addBranch}; fi
exit 0
`;
  await writeFile(join(binDir, "npx"), npx);
  await chmod(join(binDir, "npx"), 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

describe("claude installPlugin", () => {
  test("returns 'present' when plugin is already installed, does NOT shell out", async () => {
    await installFakeCli("claude", JSON.stringify([{ id: "alpha@mkt", enabled: true }]));
    const res = await claudePluginAdapter.installPlugin!("alpha", { dryRun: false, marketplace: "mkt" });
    expect(res.status).toBe("present");
    const invocations = await readInvocations();
    expect(invocations.some((line) => /plugin install/.test(line))).toBe(false);
  });

  test("dry-run reports installed without shelling out", async () => {
    await installFakeCli("claude", JSON.stringify([]));
    const res = await claudePluginAdapter.installPlugin!("newone", { dryRun: true, marketplace: "mkt" });
    expect(res.status).toBe("installed");
    expect(res.message).toBe("dry-run");
    const invocations = await readInvocations();
    expect(invocations.some((line) => /plugin install/.test(line))).toBe(false);
  });

  test("returns 'failed' with 'not found' when claude CLI is missing", async () => {
    // No claude binary on PATH at all.
    process.env.PATH = "";
    const res = await claudePluginAdapter.installPlugin!("foo", { dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("not found");
  });

  test("returns 'failed' with stderr message when CLI exits non-zero", async () => {
    await installFakeCli("claude", JSON.stringify([]), { exitOnAdd: 3, addStderr: "could not resolve marketplace" });
    const res = await claudePluginAdapter.installPlugin!("foo", { dryRun: false, marketplace: "badmkt" });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("could not resolve marketplace");
  });

  test("reports installed only after a fresh list confirms the active plugin", async () => {
    await installFakeCli("claude", JSON.stringify([]), {
      verifiedListOutput: JSON.stringify([{ id: "foo@mkt", enabled: true }]),
    });
    const res = await claudePluginAdapter.installPlugin!("foo", { dryRun: false, marketplace: "mkt" });
    expect(res.status).toBe("installed");
    expect((await readInvocations()).filter((line) => line.trim() === "claude plugin list --json")).toHaveLength(2);
  });

  test("fails when install exits zero but a fresh list shows no state change", async () => {
    await installFakeCli("claude", JSON.stringify([]), { confirmAdd: false });
    const res = await claudePluginAdapter.installPlugin!("foo", { dryRun: false, marketplace: "mkt" });
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/fresh|verify|installed/i);
  });

  test("installs a standalone local artifact through the claude-code target and verifies native state", async () => {
    const source = join(workDir, "standalone-foo");
    const installed = join(workDir, ".claude", "plugins", "installed_plugins.json");
    await mkdir(join(source, ".claude-plugin"), { recursive: true });
    await writeFile(join(source, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "foo" }));
    await installFakeCli("claude", JSON.stringify([]));
    await installFakeNpx(`
if [ "$1 $2" = "plugins add" ]; then
  mkdir -p "${join(workDir, ".claude", "plugins")}"
  printf '{"plugins":{"foo@plugins-cli":[{"enabled":true,"installPath":"${source}"}]}}' > "${installed}"
  exit 0
fi
exit 1`);

    const res = await claudePluginAdapter.installPlugin!("foo", {
      dryRun: false,
      sourcePluginPath: source,
      sourceRepo: "owner/whole-marketplace",
    });

    expect(res.status).toBe("installed");
    expect(await readInvocations()).toContain(`npx plugins add ${await realpath(source)} --target claude-code -y`);
  });

  test("rejects a relative standalone artifact before invoking an installer", async () => {
    await installFakeCli("claude", JSON.stringify([]));
    await installFakeNpx("exit 0");

    const res = await claudePluginAdapter.installPlugin!("foo", {
      dryRun: false,
      sourcePluginPath: "../foo",
    });

    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/absolute/i);
    expect((await readInvocations()).some((line) => line.startsWith("npx plugins add"))).toBe(false);
  });

  test("rejects unsafe plugin names before invoking CLI", async () => {
    await installFakeCli("claude", JSON.stringify([]));
    const res = await claudePluginAdapter.installPlugin!("../etc/passwd", { dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("traversal");
    const invocations = await readInvocations();
    expect(invocations.some((line) => /plugin install/.test(line))).toBe(false);
  });
});

describe("codex installPlugin", () => {
  test("plans target-native and provisioning installs as distinct modes", async () => {
    await installFakeCli(
      "codex",
      codexListTable([["foo@plugins-cli", "not installed", "", "/cache/foo"]]),
    );
    const native = await planCodexPluginInstall("foo", { dryRun: true });
    expect(native).toMatchObject({
      mode: "target-marketplace",
      target: "foo@plugins-cli",
    });

    await installFakeCli(
      "codex",
      codexListTable([["other@plugins-cli", "not installed", "", "/cache/other"]]),
    );
    const provision = await planCodexPluginInstall("foo", {
      dryRun: true,
      provision: true,
      sourceRepo: "acme/foo",
    });
    expect(provision).toMatchObject({
      mode: "provision",
      target: "foo@(acme/foo)",
    });
  });

  test("returns 'present' when plugin is already installed, does NOT shell out", async () => {
    await installFakeCli("codex", codexListTable([["alpha@mkt", "installed, enabled", "1.0.0", "/cache/alpha"]]));
    const res = await codexPluginAdapter.installPlugin!("alpha", { dryRun: false, marketplace: "mkt" });
    expect(res.status).toBe("present");
    const invocations = await readInvocations();
    expect(invocations.some((line) => /plugin add/.test(line))).toBe(false);
  });

  test("does NOT treat a 'not installed' registration as present", async () => {
    await installFakeCli("codex", codexListTable([["alpha@mkt", "not installed", "", "/cache/alpha"]]));
    const res = await codexPluginAdapter.installPlugin!("alpha", { dryRun: false, marketplace: "mkt" });
    expect(res.status).toBe("installed");
    const invocations = await readInvocations();
    expect(invocations.some((line) => /plugin add/.test(line))).toBe(true);
  });

  test("dry-run does not shell out", async () => {
    await installFakeCli("codex", "");
    const res = await codexPluginAdapter.installPlugin!("fresh", { dryRun: true, marketplace: "mkt" });
    expect(res.status).toBe("installed");
    expect(res.message).toBe("dry-run");
    const invocations = await readInvocations();
    expect(invocations.some((line) => /plugin add/.test(line))).toBe(false);
  });

  test("missing CLI surfaces a clear failure", async () => {
    process.env.PATH = "";
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("not found");
  });

  test("non-zero exit propagates stderr", async () => {
    await installFakeCli("codex", "", { exitOnAdd: 5, addStderr: "marketplace not registered" });
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false, marketplace: "ghost" });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("marketplace not registered");
  });

  test("does not report success until a fresh Codex list confirms the install", async () => {
    await installFakeCli(
      "codex",
      codexListTable([["foo@plugins-cli", "not installed", "", "/cache/foo"]]),
      { confirmAdd: false },
    );
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("fresh `codex plugin list`");
  });

  test("resolves a bare name to <name>@<marketplace> from the snapshot", async () => {
    // `codex plugin add` rejects a bare name; the adapter must find the
    // marketplace from a (not-installed) plugin-list row and qualify the add.
    await installFakeCli("codex", codexListTable([["foo@plugins-cli", "not installed", "", "/cache/foo"]]));
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false });
    expect(res.status).toBe("installed");
    expect(res.target).toBe("foo@plugins-cli");
    const invocations = await readInvocations();
    expect(invocations.some((l) => l.trim() === "codex plugin add -- foo@plugins-cli")).toBe(true);
  });

  test("repairs a dotted URL-derived identity through Codex's safe native name", async () => {
    await installFakeCli(
      "codex",
      codexListTable([["github-com-owner-tool@plugins-cli", "not installed", "", "/cache/tool"]]),
    );
    const res = await codexPluginAdapter.installPlugin!("github.com-owner-tool", { dryRun: false });
    expect(res).toMatchObject({
      status: "installed",
      target: "github-com-owner-tool@plugins-cli",
    });
    const invocations = await readInvocations();
    expect(invocations.some((l) => l.trim() === "codex plugin add -- github-com-owner-tool@plugins-cli")).toBe(true);
    expect(invocations.some((l) => l.includes("github.com-owner-tool@plugins-cli"))).toBe(false);
  });

  test("skips (not fails) when a bare name is in no Codex marketplace", async () => {
    await installFakeCli("codex", codexListTable([["other@plugins-cli", "not installed", "", "/cache/other"]]));
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false });
    expect(res.status).toBe("skipped");
    expect(res.message).toContain("no registered Codex marketplace");
    const invocations = await readInvocations();
    expect(invocations.some((l) => /plugin add/.test(l))).toBe(false);
  });

  test("prefers plugins-cli when a bare name is in multiple marketplaces", async () => {
    await installFakeCli(
      "codex",
      codexListTable([
        ["foo@openai-curated", "not installed", "", "/cache/foo-openai"],
        ["foo@plugins-cli", "not installed", "", "/cache/foo-plugins"],
      ]),
    );
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false });
    expect(res.status).toBe("installed");
    expect(res.target).toBe("foo@plugins-cli");
    const invocations = await readInvocations();
    expect(invocations.some((l) => l.trim() === "codex plugin add -- foo@plugins-cli")).toBe(true);
  });

  test("skips on ambiguity when plugins-cli is not a candidate", async () => {
    await installFakeCli(
      "codex",
      codexListTable([
        ["foo@openai-curated", "not installed", "", "/cache/foo-a"],
        ["foo@openai-bundled", "not installed", "", "/cache/foo-b"],
      ]),
    );
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false });
    expect(res.status).toBe("skipped");
    expect(res.message).toContain("ambiguous across Codex marketplaces");
    const invocations = await readInvocations();
    expect(invocations.some((l) => /plugin add/.test(l))).toBe(false);
  });

  test("provision: registers the marketplace via npx plugins then installs", async () => {
    await installProvisionFakes("foo");
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false, provision: true, sourceRepo: "acme/foo" });
    expect(res.status).toBe("installed");
    expect(res.target).toBe("foo@plugins-cli");
    const inv = await readInvocations();
    expect(inv.some((l) => l.trim() === "npx plugins add acme/foo --target codex -y")).toBe(true);
    expect(inv.some((l) => l.trim() === "codex plugin add -- foo@plugins-cli")).toBe(true);
  });

  test("provision: a failed `npx plugins add` is reported as failed with the cause", async () => {
    await installProvisionFakes("foo", { npxFail: { exit: 1, stderr: "repo not found" } });
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false, provision: true, sourceRepo: "acme/foo" });
    expect(res.status).toBe("failed");
    expect(res.message).toContain("provision failed");
    expect(res.message).toContain("repo not found");
    const inv = await readInvocations();
    expect(inv.some((l) => l.startsWith("npx plugins add"))).toBe(true);
    // must not attempt the native install after the provision errored
    expect(inv.some((l) => /codex plugin add/.test(l))).toBe(false);
  });

  test("provision: refuses an unsafe sourceRepo, never shells npx", async () => {
    await installProvisionFakes("foo");
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false, provision: true, sourceRepo: "../evil" });
    expect(res.status).toBe("skipped");
    // --provision was set but unusable repo → don't tell them to retry --provision.
    expect(res.message).toContain("no usable source repo");
    expect(res.message).not.toContain("retry with --provision");
    const inv = await readInvocations();
    expect(inv.some((l) => /npx plugins add/.test(l))).toBe(false);
  });

  test("provision set but no source repo for the marketplace: clear skip, no npx", async () => {
    await installProvisionFakes("foo");
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false, provision: true });
    expect(res.status).toBe("skipped");
    expect(res.message).toContain("no usable source repo");
    const inv = await readInvocations();
    expect(inv.some((l) => /npx plugins add/.test(l))).toBe(false);
  });

  test("provision disabled (--no-provision): stays skipped even with a sourceRepo, no npx", async () => {
    await installProvisionFakes("foo");
    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false, provision: false, sourceRepo: "acme/foo" });
    expect(res.status).toBe("skipped");
    expect(res.message).toContain("provisioning disabled");
    const inv = await readInvocations();
    expect(inv.some((l) => /npx plugins add/.test(l))).toBe(false);
    // No provision attempted → no skills-fallback repo handed back.
    expect(res.skillsFallbackRepo).toBeUndefined();
  });

  test("provision: bundle installed under its canonical (different) name → covered, no skills fallback", async () => {
    // Provisioning `acme/foo` installs the repo's canonical plugin `realfoo` (its
    // plugin.json name), not the Claude-side name `foo` we asked for. The exact name
    // stays unresolvable, but the bundle IS on Codex as a plugin → covered, and we
    // must NOT hand back a skills-fallback repo (that would duplicate the plugin).
    const binDir = join(workDir, "bin");
    await mkdir(binDir, { recursive: true });
    const sentinel = join(workDir, "provisioned2");
    const absent = join(workDir, "codex-absent2.txt");
    const present = join(workDir, "codex-present2.txt");
    await writeFile(absent, codexListTable([["other@plugins-cli", "not installed", "", "/cache/other"]]));
    await writeFile(
      present,
      codexListTable([
        ["other@plugins-cli", "not installed", "", "/cache/other"],
        ["realfoo@plugins-cli", "installed, enabled", "1.0.0", "/cache/realfoo"],
      ]),
    );
    const codex = `#!/bin/sh
echo "codex $@" >> ${invocationsFile}
if [ "$1 $2" = "plugin list" ]; then if [ -f ${sentinel} ]; then cat ${present}; else cat ${absent}; fi; exit 0; fi
exit 0
`;
    await writeFile(join(binDir, "codex"), codex);
    await chmod(join(binDir, "codex"), 0o755);
    const npx = `#!/bin/sh
echo "npx $@" >> ${invocationsFile}
if [ "$1 $2" = "plugins add" ]; then touch ${sentinel}; exit 0; fi
exit 0
`;
    await writeFile(join(binDir, "npx"), npx);
    await chmod(join(binDir, "npx"), 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;

    const res = await codexPluginAdapter.installPlugin!("foo", { dryRun: false, provision: true, sourceRepo: "acme/foo" });
    expect(res.status).toBe("skipped");
    expect(res.coveredBy).toContain("realfoo");
    expect(res.skillsFallbackRepo).toBeUndefined();
    const inv = await readInvocations();
    // It provisioned, but never tried `codex plugin add foo@...` (foo never resolved).
    expect(inv.some((l) => l.trim() === "npx plugins add acme/foo --target codex -y")).toBe(true);
    expect(inv.some((l) => /codex plugin add/.test(l))).toBe(false);
  });

  test("name-mismatch is an unloadable native plugin, never a skills-only fallback", async () => {
    // A multi-plugin marketplace alias: the marketplace lists `alias` but the dir's
    // plugin.json is `canonical` (which is NOT installed here). `codex plugin add
    // alias@plugins-cli` errors with the mismatch. That proves a native manifest
    // exists, so it must not be mislabeled as a skills-only bundle.
    await installFakeCli("codex", codexListTable([["alias@plugins-cli", "not installed", "", "/cache/alias"]]), {
      exitOnAdd: 1,
      addStderr: "plugin.json name `canonical` does not match marketplace plugin name `alias`",
    });
    const res = await codexPluginAdapter.installPlugin!("alias", { dryRun: false, provision: true, sourceRepo: "owner/bundle" });
    expect(res.status).toBe("failed");
    expect(res.skillsFallbackRepo).toBeUndefined();
    expect(res.message).toMatch(/unloadable native plugin/i);
    const inv = await readInvocations();
    expect(inv.some((l) => l.trim() === "codex plugin add -- alias@plugins-cli")).toBe(true);
  });

  test("name-mismatch is COVERED (no fallback) when the canonical plugin is already installed", async () => {
    // The mismatch error names the canonical (`canonical`); if it's already installed
    // on Codex, the bundle's skills are here namespaced → covered, no flat skills add.
    await installFakeCli(
      "codex",
      codexListTable([
        ["canonical@plugins-cli", "installed, enabled", "1.0.0", "/cache/canonical"],
        ["alias@plugins-cli", "not installed", "", "/cache/alias"],
      ]),
      { exitOnAdd: 1, addStderr: "plugin.json name `canonical` does not match marketplace plugin name `alias`" },
    );
    const res = await codexPluginAdapter.installPlugin!("alias", { dryRun: false, provision: true, sourceRepo: "owner/bundle" });
    expect(res.status).toBe("skipped");
    expect(res.coveredBy).toContain("canonical");
    expect(res.skillsFallbackRepo).toBeUndefined();
  });

  test("name-mismatch under --no-provision also fails with no skills fallback", async () => {
    await installFakeCli("codex", codexListTable([["alias@plugins-cli", "not installed", "", "/cache/alias"]]), {
      exitOnAdd: 1,
      addStderr: "plugin.json name `canonical` does not match marketplace plugin name `alias`",
    });
    const res = await codexPluginAdapter.installPlugin!("alias", { dryRun: false, provision: false, sourceRepo: "owner/bundle" });
    expect(res.status).toBe("failed");
    expect(res.skillsFallbackRepo).toBeUndefined();
    expect(res.message).toMatch(/unloadable native plugin/i);
  });

  test("provision: configured invalid identity is a failure, never a skills-only fallback", async () => {
    process.env.CODEX_HOME = join(workDir, "custom-codex");
    await mkdir(process.env.CODEX_HOME, { recursive: true });
    await writeFile(
      join(process.env.CODEX_HOME, "config.toml"),
      '[plugins."github.com-owner-tool@plugins-cli"]\nenabled = true\n',
    );
    await installProvisionFakes("github.com-owner-tool", { neverExposes: true });
    const res = await codexPluginAdapter.installPlugin!("github.com-owner-tool", {
      dryRun: false,
      provision: true,
      sourceRepo: "owner/tool",
    });
    expect(res.status).toBe("failed");
    expect(res.skillsFallbackRepo).toBeUndefined();
    expect(res.message).toMatch(/Codex rejects that plugin identity/i);
  });

  test("provision: list absence without source evidence is not a skills-only fallback", async () => {
    await installProvisionFakes("foo", { neverExposes: true });
    const res = await codexPluginAdapter.installPlugin!("foo", {
      dryRun: false,
      provision: true,
      sourceRepo: "acme/foo",
    });
    expect(res.status).toBe("failed");
    expect(res.skillsFallbackRepo).toBeUndefined();
    expect(res.message).toMatch(/refusing to misclassify/i);
  });

  test("provision: a positively identified skills-only source keeps the fallback", async () => {
    // Absence from `codex plugin list` alone is insufficient. The source itself
    // supplies the positive evidence: SKILL.md exists and no plugin manifest does.
    const skillsOnly = join(workDir, "skills-only");
    await mkdir(join(skillsOnly, "skills", "foo"), { recursive: true });
    await writeFile(join(skillsOnly, "skills", "foo", "SKILL.md"), "---\nname: foo\n---\n");
    await installProvisionFakes("foo", { neverExposes: true });
    const res = await codexPluginAdapter.installPlugin!("foo", {
      dryRun: false,
      provision: true,
      sourceRepo: "acme/foo",
      sourceClonePath: skillsOnly,
    });
    expect(res.status).toBe("skipped");
    expect(res.skillsFallbackRepo).toBe("acme/foo");
    expect(res.message).toMatch(/positively contains skills/i);
    const inv = await readInvocations();
    // It DID provision (the source repo was registered)...
    expect(inv.some((l) => l.trim() === "npx plugins add acme/foo --target codex -y")).toBe(true);
    // ...but never ran a native `codex plugin add` (nothing exposes it).
    expect(inv.some((l) => /codex plugin add/.test(l))).toBe(false);
  });

  test("provision: a nested native manifest prevents skills-only fallback", async () => {
    const nativeBundle = join(workDir, "native-bundle");
    await mkdir(join(nativeBundle, "skills", "foo"), { recursive: true });
    await writeFile(join(nativeBundle, "skills", "foo", "SKILL.md"), "---\nname: foo\n---\n");
    await mkdir(join(nativeBundle, "packages", "foo", ".claude-plugin"), { recursive: true });
    await writeFile(
      join(nativeBundle, "packages", "foo", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "foo" }),
    );
    await installProvisionFakes("foo", { neverExposes: true });

    const res = await codexPluginAdapter.installPlugin!("foo", {
      dryRun: false,
      provision: true,
      sourceRepo: "acme/foo",
      sourceClonePath: nativeBundle,
    });

    expect(res.status).toBe("failed");
    expect(res.skillsFallbackRepo).toBeUndefined();
    expect(res.message).toMatch(/refusing to misclassify/i);
  });
});

describe("codex installPlugin — local marketplace (sourceClonePath)", () => {
  // A source clone dir with a marketplace manifest, as Claude keeps under
  // ~/.claude/plugins/marketplaces/<mkt>/. The local-marketplace path derives the
  // marketplace name from this manifest.
  async function makeClone(name: string, pluginNames: string[] = [name]): Promise<string> {
    const clone = join(workDir, "marketplaces", name);
    await mkdir(join(clone, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(clone, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name, plugins: pluginNames.map((n) => ({ name: n, source: "./plugin" })) }),
    );
    return clone;
  }

  async function installLocalFakes(opts: {
    listRows: CodexRow[];
    mktRows?: [string, string][];
    addExit?: number;
    addStderr?: string;
    verifiedId?: string;
  }) {
    const binDir = join(workDir, "bin");
    await mkdir(binDir, { recursive: true });
    const listFile = join(workDir, "codex-list.txt");
    const verifiedListFile = join(workDir, "codex-list-verified.txt");
    const mktFile = join(workDir, "codex-mkt.txt");
    await writeFile(listFile, codexListTable(opts.listRows));
    const verifiedId = opts.verifiedId ?? "impeccable@impeccable";
    await writeFile(
      verifiedListFile,
      codexListTable([
        ...opts.listRows,
        [verifiedId, "installed, enabled", "1.0.0", `/cache/${verifiedId.split("@")[0]}`],
      ]),
    );
    await writeFile(mktFile, mktTable(opts.mktRows ?? []));
    const addStderr = (opts.addStderr ?? "fake add failure").replace(/`/g, "\\`");
    const addBranch =
      opts.addExit != null
        ? `echo "${addStderr}" >&2; exit ${opts.addExit}`
        : `cp ${verifiedListFile} ${listFile}; exit 0`;
    // Order matters: the `plugin marketplace …` subcommands ($2=marketplace) are
    // matched before the bare `plugin list` / `plugin add` ($2=list/add).
    const codex = `#!/bin/sh
echo "codex $@" >> ${invocationsFile}
if [ "$1 $2 $3" = "plugin marketplace list" ]; then cat ${mktFile}; exit 0; fi
if [ "$1 $2 $3" = "plugin marketplace add" ]; then echo "Added marketplace"; exit 0; fi
if [ "$1 $2" = "plugin list" ]; then cat ${listFile}; exit 0; fi
if [ "$1 $2" = "plugin add" ]; then ${addBranch}; fi
exit 0
`;
    await writeFile(join(binDir, "codex"), codex);
    await chmod(join(binDir, "codex"), 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  }

  test("plans a declared clone through the local-marketplace mode", async () => {
    const clone = await makeClone("impeccable");
    await installLocalFakes({
      listRows: [["other@plugins-cli", "not installed", "", "/cache/other"]],
    });

    const plan = await planCodexPluginInstall("impeccable", {
      dryRun: true,
      sourceClonePath: clone,
    });

    expect(plan).toMatchObject({
      mode: "local-marketplace",
      target: "impeccable@impeccable",
      registration: { root: clone },
    });
  });

  test("registers the local marketplace then installs name@<derived>, no npx", async () => {
    const clone = await makeClone("impeccable");
    await installLocalFakes({
      listRows: [["other@plugins-cli", "not installed", "", "/cache/other"]],
      mktRows: [["personal", "/Users/me"]],
    });
    const res = await codexPluginAdapter.installPlugin!("impeccable", {
      dryRun: false,
      provision: true,
      sourceClonePath: clone,
    });
    expect(res.status).toBe("installed");
    expect(res.target).toBe("impeccable@impeccable");
    const inv = await readInvocations();
    expect(inv.some((l) => l.trim() === `codex plugin marketplace add ${clone}`)).toBe(true);
    expect(inv.some((l) => l.trim() === "codex plugin add -- impeccable@impeccable")).toBe(true);
    expect(inv.some((l) => /npx plugins add/.test(l))).toBe(false);
  });

  test("uses a declared Codex-safe local identity for a dotted source identity", async () => {
    const clone = await makeClone("url-tools", ["github-com-owner-tool"]);
    await installLocalFakes({
      listRows: [["other@plugins-cli", "not installed", "", "/cache/other"]],
      verifiedId: "github-com-owner-tool@url-tools",
    });
    const res = await codexPluginAdapter.installPlugin!("github.com-owner-tool", {
      dryRun: false,
      provision: true,
      sourceClonePath: clone,
    });
    expect(res).toMatchObject({
      status: "installed",
      target: "github-com-owner-tool@url-tools",
    });
    const inv = await readInvocations();
    expect(inv.some((l) => l.trim() === `codex plugin marketplace add ${clone}`)).toBe(true);
    expect(inv.some((l) => l.trim() === "codex plugin add -- github-com-owner-tool@url-tools")).toBe(true);
    expect(inv.some((l) => /npx plugins add/.test(l))).toBe(false);
  });

  test("reuses an already-registered marketplace (by root), does not re-add", async () => {
    const clone = await makeClone("impeccable");
    await installLocalFakes({
      listRows: [["other@plugins-cli", "not installed", "", "/cache/other"]],
      mktRows: [["impeccable", clone]],
    });
    const res = await codexPluginAdapter.installPlugin!("impeccable", {
      dryRun: false,
      provision: true,
      sourceClonePath: clone,
    });
    expect(res.status).toBe("installed");
    const inv = await readInvocations();
    expect(inv.some((l) => /plugin marketplace add/.test(l))).toBe(false);
    expect(inv.some((l) => l.trim() === "codex plugin add -- impeccable@impeccable")).toBe(true);
  });

  test("dry-run with a clone path does not shell out", async () => {
    const clone = await makeClone("impeccable");
    await installLocalFakes({ listRows: [["other@plugins-cli", "not installed", "", "/cache/other"]] });
    const res = await codexPluginAdapter.installPlugin!("impeccable", { dryRun: true, sourceClonePath: clone });
    expect(res.status).toBe("installed");
    expect(res.message).toMatch(/dry-run/);
    const inv = await readInvocations();
    expect(inv.some((l) => /plugin marketplace add/.test(l))).toBe(false);
    expect(inv.some((l) => /plugin add --/.test(l))).toBe(false);
  });

  test("already-present plugin short-circuits before touching marketplaces", async () => {
    const clone = await makeClone("impeccable");
    await installLocalFakes({ listRows: [["impeccable@personal", "installed, enabled", "3.5.0", "/cache/imp"]] });
    const res = await codexPluginAdapter.installPlugin!("impeccable", { dryRun: false, sourceClonePath: clone });
    expect(res.status).toBe("present");
    const inv = await readInvocations();
    expect(inv.some((l) => /plugin marketplace/.test(l))).toBe(false);
    expect(inv.some((l) => l.trim().startsWith("codex plugin add"))).toBe(false);
  });

  test("name-mismatch on the local add is not mislabeled as skills-only", async () => {
    // The manifest declares the alias entry `alias`, so the local path is taken; the
    // `codex plugin add` then hits the plugin.json-name-mismatch (canonical ≠ alias).
    const clone = await makeClone("bundle", ["alias"]);
    await installLocalFakes({
      listRows: [["other@plugins-cli", "not installed", "", "/cache/other"]],
      addExit: 1,
      addStderr: "plugin.json name `canonical` does not match marketplace plugin name `alias`",
    });
    const res = await codexPluginAdapter.installPlugin!("alias", {
      dryRun: false,
      provision: true,
      sourceRepo: "owner/bundle",
      sourceClonePath: clone,
    });
    expect(res.status).toBe("failed");
    expect(res.skillsFallbackRepo).toBeUndefined();
    expect(res.message).toMatch(/unloadable native plugin/i);
  });
});
