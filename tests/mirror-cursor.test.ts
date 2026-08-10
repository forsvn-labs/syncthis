import { describe, expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMirror, mirrorHasChanges } from "../src/plugins/mirror.ts";

setDefaultTimeout(15_000);

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;
let originalCopilotHome: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-cursor-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  originalCopilotHome = process.env.COPILOT_HOME;
  process.env.HOME = workDir;
  process.env.COPILOT_HOME = join(workDir, "copilot");
  await mkdir(join(workDir, "bin"), { recursive: true });
  await writeFile(join(workDir, "bin", "copilot"), `#!/bin/sh\necho "copilot $@" >> ${join(workDir, "invocations.log")}\necho "native install unavailable in fixture" >&2\nexit 1\n`);
  await chmod(join(workDir, "bin", "copilot"), 0o755);
  await writeFile(
    join(workDir, "bin", "grok"),
    "#!/bin/sh\nif [ \"$1 $2 $3\" = \"plugin list --json\" ]; then echo '[]'; exit 0; fi\nexit 1\n",
  );
  await chmod(join(workDir, "bin", "grok"), 0o755);
  process.env.PATH = `${join(workDir, "bin")}:${originalPath ?? ""}`;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = originalCopilotHome;
  await rm(workDir, { recursive: true, force: true });
});

const binDir = () => join(workDir, "bin");
const log = () => join(workDir, "invocations.log");

// claude fake with both `plugin list --json` and `plugin marketplace list --json`
// (the latter drives marketplaceSources → cursor repo resolution).
async function fakeClaude(
  plugins: { id: string; installPath?: string }[],
  marketplaces: { name: string; source: string; repo: string }[],
  opts: { marketplaceListExit?: number } = {},
) {
  await mkdir(binDir(), { recursive: true });
  const pl = join(workDir, "claude-plugins.json");
  const mk = join(workDir, "claude-mkts.json");
  await writeFile(pl, JSON.stringify(plugins));
  await writeFile(mk, JSON.stringify(marketplaces));
  const nativeNames = plugins.map(({ id }) => id.split("@")[0]!);
  await mkdir(process.env.COPILOT_HOME!, { recursive: true });
  await writeFile(
    join(process.env.COPILOT_HOME!, "config.json"),
    JSON.stringify({
      installedPlugins: nativeNames.map((name) => ({ name, enabled: true, cache_path: join(workDir, "native", name) })),
    }),
  );
  const mktBranch =
    opts.marketplaceListExit != null ? `exit ${opts.marketplaceListExit}` : `cat ${mk}; exit 0`;
  const script = `#!/bin/sh
echo "claude $@" >> ${log()}
if [ "$1 $2 $3" = "plugin list --json" ]; then cat ${pl}; exit 0; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then ${mktBranch}; fi
exit 0
`;
  await writeFile(join(binDir(), "claude"), script);
  await chmod(join(binDir(), "claude"), 0o755);
  const copilotScript = `#!/bin/sh
echo "copilot $@" >> ${log()}
if [ "$1 $2" = "plugin list" ]; then
${nativeNames.map((name) => `  echo "  • ${name} (v1.0.0)"`).join("\n")}
  ${nativeNames.length === 0 ? 'echo "No plugins installed."' : ""}
  exit 0
fi
echo "native install unavailable in fixture" >&2
exit 1
`;
  await writeFile(join(binDir(), "copilot"), copilotScript);
  await chmod(join(binDir(), "copilot"), 0o755);
  process.env.PATH = `${binDir()}:${originalPath ?? ""}`;
}

type CodexRow = [string, string, string, string];
function codexList(rows: CodexRow[]): string {
  const header: CodexRow = ["PLUGIN", "STATUS", "VERSION", "PATH"];
  const all = [header, ...rows];
  const w = [0, 1, 2].map((i) => Math.max(...all.map((r) => r[i]!.length)));
  const fmt = (r: CodexRow) =>
    `${r[0].padEnd(w[0]! + 2)}${r[1].padEnd(w[1]! + 2)}${r[2].padEnd(w[2]! + 2)}${r[3]}`.replace(/\s+$/, "");
  return ["Marketplace `plugins-cli`", "/x/marketplace.json", "", fmt(header), ...rows.map(fmt), ""].join("\n");
}

async function fakeCodex(installedIds: string[]) {
  await mkdir(binDir(), { recursive: true });
  const out = codexList(installedIds.map((id) => [id, "installed, enabled", "1.0.0", `/cache/${id.split("@")[0]}`]));
  const f = join(workDir, "codex-list.txt");
  await writeFile(f, out);
  const script = `#!/bin/sh
echo "codex $@" >> ${log()}
if [ "$1 $2" = "plugin list" ]; then cat ${f}; exit 0; fi
exit 0
`;
  await writeFile(join(binDir(), "codex"), script);
  await chmod(join(binDir(), "codex"), 0o755);
  process.env.PATH = `${binDir()}:${originalPath ?? ""}`;
}

// A codex fake whose `plugin list` shows the given ids as registered-but-not-installed
// (so they're resolvable for `plugin add`), and whose `plugin add` succeeds for every
// target EXCEPT `<mismatchName>@…`, which errors with the multi-plugin alias mismatch
// (`<canonical>` ≠ `<mismatchName>`) — exactly how Codex rejects aliased bundles.
async function fakeCodexMismatch(
  availableIds: string[],
  mismatchName: string,
  canonical: string,
  installedIds: string[] = [],
) {
  await mkdir(binDir(), { recursive: true });
  const out = codexList([
    ...installedIds.map((id): CodexRow => [id, "installed, enabled", "1.0.0", `/cache/${id.split("@")[0]}`]),
    ...availableIds.map((id): CodexRow => [id, "not installed", "", `/cache/${id.split("@")[0]}`]),
  ]);
  const f = join(workDir, "codex-list.txt");
  await writeFile(f, out);
  const script = `#!/bin/sh
echo "codex $@" >> ${log()}
if [ "$1 $2" = "plugin list" ]; then cat ${f}; exit 0; fi
if [ "$1 $2 $3" = "plugin add --" ]; then
  case "$4" in
    ${mismatchName}@*) echo "plugin.json name \\\`${canonical}\\\` does not match marketplace plugin name \\\`${mismatchName}\\\`" >&2; exit 1 ;;
  esac
  awk -v id="$4" 'index($0, id) == 1 { sub(/not installed/, "installed    ") } { print }' ${f} > ${f}.next
  mv ${f}.next ${f}
  exit 0
fi
exit 0
`;
  await writeFile(join(binDir(), "codex"), script);
  await chmod(join(binDir(), "codex"), 0o755);
  process.env.PATH = `${binDir()}:${originalPath ?? ""}`;
}

// Write a `~/.claude/plugins/known_marketplaces.json` + a cloned marketplace whose
// marketplace.json declares `pluginNames`. This is what resolveInstalledRepoCoverage
// reads to map a target's installed (canonical) plugin name back to its source repo.
async function fakeKnownMarketplace(mktName: string, repo: string, pluginNames: string[]) {
  const loc = join(workDir, "mkts", mktName);
  await mkdir(join(loc, ".claude-plugin"), { recursive: true });
  await writeFile(join(loc, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: mktName, plugins: pluginNames.map((name) => ({ name })) }));
  const known = join(workDir, ".claude", "plugins");
  await mkdir(known, { recursive: true });
  await writeFile(join(known, "known_marketplaces.json"), JSON.stringify({ [mktName]: { source: { source: "github", repo }, installLocation: loc } }));
  return loc;
}

async function fakeNpx() {
  await mkdir(binDir(), { recursive: true });
  const script = `#!/bin/sh
echo "npx $@" >> ${log()}
exit 0
`;
  await writeFile(join(binDir(), "npx"), script);
  await chmod(join(binDir(), "npx"), 0o755);
  process.env.PATH = `${binDir()}:${originalPath ?? ""}`;
}

async function invocations(): Promise<string[]> {
  try {
    return (await readFile(log(), "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("mirror cursor push", () => {
  test("resolves deduped source repos from the Claude primary's plugins", async () => {
    await fakeClaude(
      [{ id: "foo@mkt1" }, { id: "bar@mkt1" }, { id: "baz@mkt2" }],
      [
        { name: "mkt1", source: "github", repo: "owner/one" },
        { name: "mkt2", source: "github", repo: "owner/two" },
      ],
    );
    await fakeCodex(["foo@plugins-cli", "bar@plugins-cli", "baz@plugins-cli"]);
    const report = await runMirror({ from: "claude-code", apply: false });
    expect(report.cursor.supported).toBe(true);
    // foo+bar share mkt1 → owner/one once; baz → owner/two.
    expect(report.cursor.repos).toEqual(["owner/one", "owner/two"]);
    expect(mirrorHasChanges(report)).toBe(true);
  });

  test("apply installs each repo to cursor via `npx plugins add --target cursor`", async () => {
    await fakeClaude(
      [{ id: "foo@mkt1" }, { id: "bar@mkt1" }],
      [{ name: "mkt1", source: "github", repo: "owner/one" }],
    );
    await fakeCodex(["foo@plugins-cli", "bar@plugins-cli"]);
    await fakeNpx();
    const report = await runMirror({ from: "claude-code", apply: true });
    expect(report.cursor.results).toEqual([{ repo: "owner/one", status: "installed" }]);
    const inv = await invocations();
    const cursorCalls = inv.filter((l) => /^npx plugins add .* --target cursor -y$/.test(l.trim()));
    expect(cursorCalls).toEqual(["npx plugins add owner/one --target cursor -y"]);
  });

  test("apply mirrors a standalone local artifact to Cursor and loose-skill targets", async () => {
    const local = join(workDir, "standalone");
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
    await fakeClaude([{ id: "standalone", installPath: local }], []);
    await fakeCodex(["standalone@plugins-cli"]);
    await fakeNpx();

    const report = await runMirror({ from: "claude-code", apply: true });

    expect(report.cursor.repos).toEqual([canonical]);
    expect(report.cursor.results).toEqual([
      { repo: canonical, status: "installed" },
    ]);
    const calls = await invocations();
    expect(calls).toContain(
      `npx plugins add ${canonical} --target cursor -y`,
    );
    expect(
      calls.some((line) =>
        line.includes(`skills add ${canonical}`) &&
        line.includes("-a kimi-code-cli")
      ),
    ).toBe(true);
  });

  test("tracks partial source unavailability per readable target", async () => {
    await fakeClaude(
      [{ id: "foo@mkt1" }, { id: "local@localmkt" }],
      [{ name: "mkt1", source: "github", repo: "owner/one" }], // localmkt absent → no repo
    );
    await fakeCodex([]);
    await writeFile(join(binDir(), "copilot"), `#!/bin/sh
echo "copilot $@" >> ${log()}
if [ "$1 $2" = "plugin list" ]; then echo "No plugins installed."; exit 0; fi
exit 0
`);
    await chmod(join(binDir(), "copilot"), 0o755);
    const report = await runMirror({ from: "claude-code", apply: false });
    expect(report.cursor.repos).toEqual(["owner/one"]);
    const codex = report.targets.find((item) => item.to === "codex")!;
    expect(codex.diff!.add.map((plugin) => plugin.name)).toEqual(["foo", "local"]);
    expect(codex.unavailable).toEqual([]);
    expect(codex.unsupportedReason).toBeUndefined();

    const copilot = report.targets.find((item) => item.to === "github-copilot")!;
    expect(copilot.diff!.add.map((plugin) => plugin.name)).toEqual(["foo"]);
    expect(copilot.unavailable?.map((item) => item.plugin.name)).toEqual(["local"]);
    expect(copilot.unavailable?.[0]?.reason).toBeTruthy();
    expect(copilot.unsupportedReason).toBeUndefined();
  });

  test("unsupported from a Codex primary (no marketplace→repo map)", async () => {
    await fakeClaude([{ id: "foo@mkt1" }], [{ name: "mkt1", source: "github", repo: "owner/one" }]);
    await fakeCodex(["foo@plugins-cli"]);
    const report = await runMirror({ from: "codex", apply: false });
    expect(report.cursor.supported).toBe(false);
    expect(report.cursor.repos).toEqual([]);
  });

  test("unsupported with a distinct reason when Claude marketplace list fails", async () => {
    await fakeClaude([{ id: "foo@mkt1" }], [{ name: "mkt1", source: "github", repo: "owner/one" }], { marketplaceListExit: 1 });
    await fakeCodex(["foo@plugins-cli"]);
    const report = await runMirror({ from: "claude-code", apply: false });
    expect(report.cursor.supported).toBe(false);
    expect(report.cursor.reason).toMatch(/couldn't read/i);
  });
});

describe("mirror native coverage suppression", () => {
  test("sanitized native identity overlap is not misreported as source-unavailable", async () => {
    await fakeClaude(
      [{ id: "github.com-owner-tool@mkt1" }],
      [{ name: "mkt1", source: "github", repo: "owner/tool" }],
    );
    await writeFile(
      join(process.env.COPILOT_HOME!, "config.json"),
      JSON.stringify({
        installedPlugins: [{ name: "github-com-owner-tool", enabled: true, cache_path: join(workDir, "native", "tool") }],
      }),
    );
    await fakeCodex(["github-com-owner-tool@plugins-cli"]);

    const report = await runMirror({ from: "claude-code", apply: false });
    const target = report.targets.find((item) => item.to === "github-copilot")!;
    expect(target.diff!.add).toEqual([]);
    expect(target.unsupportedReason).toBeUndefined();
  });

  test("pre-existing Copilot stays native while Kimi receives exact loose skills and MCP", async () => {
    const pluginRoot = join(workDir, "plugin-cache", "foo");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(
      join(pluginRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { foo: { command: "foo-mcp" } } }),
    );
    await fakeClaude(
      [{ id: "foo@mkt1", installPath: pluginRoot }],
      [{ name: "mkt1", source: "github", repo: "owner/foo" }],
    );
    const clone = await fakeKnownMarketplace("mkt1", "owner/foo", ["foo"]);
    await mkdir(join(clone, "skills", "foo"), { recursive: true });
    await writeFile(join(clone, "skills", "foo", "SKILL.md"), "---\nname: foo\n---\n");
    await fakeCodex(["foo@plugins-cli"]);
    await fakeNpx();

    const report = await runMirror({ from: "claude-code", apply: true });
    const calls = await invocations();
    expect(calls.some((line) => /skills add owner\/foo/.test(line) && /-a kimi-code-cli(?: |$)/.test(line))).toBe(true);
    expect(calls.some((line) => /skills add owner\/foo/.test(line) && /-a github-copilot(?: |$)/.test(line))).toBe(false);
    expect(report.mcpCohort.results?.find((item) => item.agent === "kimi-cli")?.added).toEqual(["foo"]);
    expect(report.mcpCohort.results?.find((item) => item.agent === "github-copilot")?.added).toEqual([]);
  }, 15_000);
});

describe("mirror codex skills-fallback (provisioning on by default)", () => {
  test("a skills-only bundle Codex can't load is added to Codex as skills", async () => {
    // Claude has `kit` under a github marketplace; Codex's plugin-list never shows
    // it, even after provisioning → skills-only bundle. It must fall back to
    // `npx skills add <repo> -a codex` rather than silently vanishing.
    await fakeClaude([{ id: "kit@mkt1" }], [{ name: "mkt1", source: "github", repo: "owner/kit" }]);
    const clone = await fakeKnownMarketplace("mkt1", "owner/kit", []);
    await mkdir(join(clone, "skills", "kit"), { recursive: true });
    await writeFile(join(clone, "skills", "kit", "SKILL.md"), "---\nname: kit\n---\n");
    await fakeCodex([]); // Codex has nothing, and its list never exposes `kit`
    await fakeNpx(); // `plugins add` (provision + cursor) and `skills add` all exit 0

    const report = await runMirror({ from: "claude-code", apply: true }); // provision defaults on
    const codex = report.targets.find((t) => t.to === "codex")!;

    // The native install skipped (skills-only) but carried the fallback repo…
    const attempt = codex.installs!.find((i) => i.target === "kit");
    expect(attempt?.status).toBe("skipped");
    expect(attempt?.skillsFallbackRepo).toBe("owner/kit");
    // …and the fallback added it as skills on Codex.
    expect(codex.skillsFallback).toEqual([{ repo: "owner/kit", status: "added" }]);

    const inv = await invocations();
    expect(inv.some((l) => l.trim() === "npx -y skills add owner/kit -g -s * -a codex -y")).toBe(true);
  });

  test("--no-provision (provision:false) skips the bundle with no skills-fallback", async () => {
    await fakeClaude([{ id: "kit@mkt1" }], [{ name: "mkt1", source: "github", repo: "owner/kit" }]);
    await fakeCodex([]);
    await fakeNpx();

    const report = await runMirror({ from: "claude-code", apply: true, provision: false });
    const codex = report.targets.find((t) => t.to === "codex")!;
    const attempt = codex.installs!.find((i) => i.target === "kit");
    expect(attempt?.status).toBe("skipped");
    expect(attempt?.skillsFallbackRepo).toBeUndefined();
    expect(codex.skillsFallback).toBeUndefined();

    const inv = await invocations();
    expect(inv.some((l) => /skills add/.test(l))).toBe(false);
  });

  test("an unloadable alias is NOT re-added as skills when its repo already landed as a plugin", async () => {
    // browse + browser-trace are two aliases of one bundle (repo owner/bundle).
    // `browse` installs on Codex (canonical); `browser-trace` hits the name-mismatch
    // and would carry a skills-fallback — but since owner/bundle is already a plugin
    // on Codex, the mirror must drop the fallback (no flat/namespaced duplication).
    await fakeClaude(
      [{ id: "browse@bb" }, { id: "browser-trace@bb" }],
      [{ name: "bb", source: "github", repo: "owner/bundle" }],
    );
    // Codex snapshot: both aliases registered (not installed). `browse` add succeeds;
    // `browser-trace` add fails with the mismatch (handled by the codex fake below).
    await fakeCodexMismatch(["browse@plugins-cli", "browser-trace@plugins-cli"], "browser-trace", "browse");
    await fakeNpx();

    const report = await runMirror({ from: "claude-code", apply: true });
    const codex = report.targets.find((t) => t.to === "codex")!;
    expect(codex.diff!.add.map((plugin) => plugin.name)).toEqual(["browse", "browser-trace"]);
    const browse = codex.installs!.find((i) => i.target.startsWith("browse@"));
    const trace = codex.installs!.find((i) => i.target.startsWith("browser-trace@"));
    expect(codex.installs!.map((install) => install.target.split("@")[0])).toEqual(["browse", "browser-trace"]);
    expect(browse?.status).toBe("installed");
    expect(trace?.status).toBe("skipped");
    // Covered by the canonical sibling → fallback dropped, no skills add for the repo.
    expect(trace?.coveredBy).toBeDefined();
    expect(trace?.skillsFallbackRepo).toBeUndefined();
    expect(codex.skillsFallback).toBeUndefined();

    const inv = await invocations();
    expect(inv.some((l) => /skills add/.test(l))).toBe(false);
  });

  test("re-run: a URL-named alias fails explicitly without duplicating canonical plugin skills", async () => {
    // The `github.com-*` re-run case: Claude installed `github.com-owner-tool`; the
    // repo's canonical plugin is `tool`, already installed on Codex from run 1. The
    // asked name never resolves (candidates 0) and provisioning installs nothing new,
    // so codex.ts hands back a skills-fallback repo — but the mirror recognizes the
    // repo is already covered by matching Codex's installed `tool` against the
    // marketplace's declared plugin names, and drops the fallback (no flat-skill dup).
    await fakeClaude([{ id: "github.com-owner-tool@gh-mkt" }], [{ name: "gh-mkt", source: "github", repo: "owner/tool" }]);
    await fakeKnownMarketplace("gh-mkt", "owner/tool", ["tool"]);
    await fakeCodex(["tool@plugins-cli"]); // canonical `tool` already installed
    await fakeNpx();

    const report = await runMirror({ from: "claude-code", apply: true });
    const codex = report.targets.find((t) => t.to === "codex")!;
    const attempt = codex.installs!.find((i) => i.target === "github.com-owner-tool");
    expect(attempt?.status).toBe("failed");
    expect(attempt?.skillsFallbackRepo).toBeUndefined();
    expect(attempt?.message).toMatch(/no loadable plugin|misclassify/i);
    expect(codex.skillsFallback).toBeUndefined();

    const inv = await invocations();
    expect(inv.some((l) => /skills add/.test(l))).toBe(false);
  });

  test("re-run: an unloadable alias is covered (not re-added as skills) when its canonical sibling is ALREADY installed", async () => {
    // Steady state after a prior mirror: canonical `browse` is already installed on
    // Codex, so it's NOT in this run's add-set; only the unloadable alias
    // `browser-trace` remains. The mismatch must be recognized as covered by the
    // already-present canonical — never `npx skills add` (which would duplicate
    // browse's namespaced skills flat). Regression for the re-run dedup gap.
    await fakeClaude(
      [{ id: "browse@bb" }, { id: "browser-trace@bb" }],
      [{ name: "bb", source: "github", repo: "owner/bundle" }],
    );
    await fakeCodexMismatch(["browser-trace@plugins-cli"], "browser-trace", "browse", ["browse@plugins-cli"]);
    await fakeNpx();

    const report = await runMirror({ from: "claude-code", apply: true });
    const codex = report.targets.find((t) => t.to === "codex")!;
    // browse already installed → not in add; only browser-trace is attempted.
    expect(codex.installs!.some((i) => i.target.startsWith("browse@"))).toBe(false);
    const trace = codex.installs!.find((i) => i.target.startsWith("browser-trace@"));
    expect(trace?.status).toBe("skipped");
    expect(trace?.coveredBy).toBeDefined();
    expect(trace?.skillsFallbackRepo).toBeUndefined();
    expect(codex.skillsFallback).toBeUndefined();

    const inv = await invocations();
    expect(inv.some((l) => /skills add/.test(l))).toBe(false);
  });

  test("generic Copilot install failure does not degrade the plugin to skills or MCP", async () => {
    const alpha = join(workDir, "alpha");
    const beta = join(workDir, "beta");
    for (const [name, root] of [["alpha", alpha], ["beta", beta]] as const) {
      await mkdir(join(root, "skills", name), { recursive: true });
      await writeFile(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
      await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { [name]: { command: `${name}-mcp` } } }));
    }
    await fakeClaude(
      [{ id: "alpha@mkt1", installPath: alpha }, { id: "beta@mkt1", installPath: beta }],
      [{ name: "mkt1", source: "github", repo: "owner/bundle" }],
    );
    await fakeCodex([]);
    await fakeNpx();
    await writeFile(join(binDir(), "copilot"), `#!/bin/sh
echo "copilot $@" >> ${log()}
if [ "$1 $2" = "plugin list" ]; then echo "No plugins installed."; exit 0; fi
echo "native install unavailable" >&2
exit 1
`);
    await chmod(join(binDir(), "copilot"), 0o755);

    const report = await runMirror({ from: "claude-code", apply: true });
    const copilot = report.targets.find((target) => target.to === "github-copilot")!;
    expect(copilot.diff!.add.map((plugin) => plugin.name)).toEqual(["alpha", "beta"]);
    expect(copilot.installs!.map((install) => install.target.split("@")[0])).toEqual(
      copilot.diff!.add.map((plugin) => plugin.name),
    );
    expect(copilot.installs!.every((install) => install.status === "failed")).toBe(true);
    expect(copilot.skillsFallback).toBeUndefined();
    expect(report.mcpCohort.results?.find((result) => result.agent === "github-copilot")?.added).toEqual([]);
    const calls = await invocations();
    expect(calls.some((line) => /skills add/.test(line) && /-a github-copilot(?: |$)/.test(line))).toBe(false);
  });
});
