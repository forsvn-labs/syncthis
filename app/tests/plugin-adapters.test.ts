import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexPluginAdapter, parseCodexPluginList } from "../src/plugins/codex.ts";
import { claudePluginAdapter, parseClaudeInstalledPlugins } from "../src/plugins/claude.ts";
import {
  codexPluginIdentityCandidates,
  isValidCodexPluginName,
} from "../src/plugins/shell.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;
let originalCodexHome: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-plugins-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  originalCodexHome = process.env.CODEX_HOME;
  process.env.HOME = workDir;
  delete process.env.CODEX_HOME;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  if (originalCodexHome == null) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await rm(workDir, { recursive: true, force: true });
});

// Build a fixed-width `codex plugin list` table the way the real CLI does:
// columns padded to max(header, values) + 2-space gap, last column unpadded.
type CodexRow = [id: string, status: string, version: string, path: string];
function codexTable(rows: CodexRow[]): string {
  const header: CodexRow = ["PLUGIN", "STATUS", "VERSION", "PATH"];
  const all = [header, ...rows];
  const widths: [number, number, number] = [
    Math.max(...all.map((r) => r[0].length)),
    Math.max(...all.map((r) => r[1].length)),
    Math.max(...all.map((r) => r[2].length)),
  ];
  const fmt = (c: CodexRow) =>
    `${c[0].padEnd(widths[0] + 2)}${c[1].padEnd(widths[1] + 2)}${c[2].padEnd(widths[2] + 2)}${c[3]}`.replace(/\s+$/, "");
  return [
    "Marketplace `plugins-cli`",
    "/x/.agents/plugins/marketplace.json",
    "",
    fmt(header),
    ...rows.map(fmt),
    "",
  ].join("\n");
}

async function installFakeCodex(listOutput: string) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const outFile = join(workDir, "codex-list.txt");
  await writeFile(outFile, listOutput);
  const script = `#!/bin/sh
case "$1 $2" in
  "plugin list") cat ${outFile} ;;
  *) echo "unexpected: $@" >&2 ; exit 99 ;;
esac
`;
  const codexPath = join(binDir, "codex");
  await writeFile(codexPath, script);
  await chmod(codexPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

async function installFakeClaude(pluginsJson: string, marketplaceJson = "[]") {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const pluginsFile = join(workDir, "plugins.json");
  const mktFile = join(workDir, "marketplaces.json");
  await writeFile(pluginsFile, pluginsJson);
  await writeFile(mktFile, marketplaceJson);
  const script = `#!/bin/sh
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then cat ${mktFile}; exit 0; fi
if [ "$1 $2 $3" = "plugin list --json" ]; then cat ${pluginsFile}; exit 0; fi
echo "unexpected: $@" >&2; exit 99
`;
  const claudePath = join(binDir, "claude");
  await writeFile(claudePath, script);
  await chmod(claudePath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

async function writeClaudeInstalledPlugins(plugins: Record<string, unknown>) {
  const dir = join(workDir, ".claude", "plugins");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
}

async function writeClaudeKnownMarketplaces(marketplaces: Record<string, unknown>) {
  const dir = join(workDir, ".claude", "plugins");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "known_marketplaces.json"), JSON.stringify(marketplaces));
}

const CODEX_SAMPLE: CodexRow[] = [
  ["vercel-plugin@plugins-cli", "not installed", "", "/cache/vercel"],
  ["forsvn-skills@plugins-cli", "installed, enabled", "3.0.0", "/cache/forsvn"],
  ["brave-search-skills@plugins-cli", "installed, enabled", "1.4.0", "/cache/brave"],
  ["expo@plugins-cli", "installed, disabled", "2.0.0", "/cache/expo"],
];

describe("codex plugin adapter", () => {
  test("honors CODEX_HOME for its authoritative config location", () => {
    process.env.CODEX_HOME = join(workDir, "alternate-codex");
    expect(codexPluginAdapter.configPath()).toBe(join(workDir, "alternate-codex", "config.toml"));
  });

  test("reports only installed plugins from `codex plugin list`", async () => {
    await installFakeCodex(codexTable(CODEX_SAMPLE));
    const r = await codexPluginAdapter.read();
    expect(r.exists).toBe(true);
    expect(r.error).toBeUndefined();
    // "not installed" (vercel-plugin) must be excluded — that was the v0.5 bug.
    expect(r.plugins.map((p) => `${p.name}@${p.marketplace}`).sort()).toEqual([
      "brave-search-skills@plugins-cli",
      "expo@plugins-cli",
      "forsvn-skills@plugins-cli",
    ]);
  });

  test("captures version and enabled/disabled state", async () => {
    await installFakeCodex(codexTable(CODEX_SAMPLE));
    const r = await codexPluginAdapter.read();
    const forsvn = r.plugins.find((p) => p.name === "forsvn-skills");
    expect(forsvn?.version).toBe("3.0.0");
    expect(forsvn?.enabled).toBe(true);
    const expo = r.plugins.find((p) => p.name === "expo");
    expect(expo?.enabled).toBe(false);
  });

  test("returns error when codex CLI not on PATH", async () => {
    process.env.PATH = "/nonexistent-bin-dir-syncthis-test";
    const r = await codexPluginAdapter.read();
    expect(r.error).toBeTruthy();
    expect(r.exists).toBe(false);
    expect(r.plugins).toEqual([]);
  });

  test("parseCodexPluginList handles multiple marketplace sections", () => {
    const text = [
      codexTable([["foo@plugins-cli", "installed, enabled", "1.0.0", "/cache/foo"]]),
      "",
      "Marketplace `openai-primary-runtime`",
      "/runtime/marketplace.json",
      "",
      "PLUGIN                            STATUS              VERSION       PATH",
      "documents@openai-primary-runtime  installed, enabled  26.513.11550  /runtime/documents",
    ].join("\n");
    const plugins = parseCodexPluginList(text);
    expect(plugins.map((p) => `${p.name}@${p.marketplace}`).sort()).toEqual([
      "documents@openai-primary-runtime",
      "foo@plugins-cli",
    ]);
  });
});

describe("Codex plugin identity contract", () => {
  test("accepts only Codex-native ASCII identifier characters", () => {
    expect(isValidCodexPluginName("alpha-1_beta")).toBe(true);
    expect(isValidCodexPluginName("github.com-owner-repo")).toBe(false);
    expect(isValidCodexPluginName("with space")).toBe(false);
    expect(isValidCodexPluginName("café")).toBe(false);
  });

  test("returns ordered, target-safe candidates for URL-derived identities", () => {
    expect(codexPluginIdentityCandidates("plain-plugin")).toEqual(["plain-plugin"]);
    expect(codexPluginIdentityCandidates("github.com-owner-repo")).toEqual([
      "github-com-owner-repo",
    ]);
    expect(codexPluginIdentityCandidates("not representable!")).toEqual([]);
  });
});

describe("claude plugin adapter", () => {
  test("parses --json output from claude CLI", async () => {
    await installFakeClaude(
      JSON.stringify([
        {
          id: "vercel-plugin@plugins-cli",
          version: "1.0.0",
          scope: "user",
          enabled: true,
          installPath: "/x/y",
        },
        {
          id: "noscope-plugin",
          version: "0.1.0",
          enabled: false,
        },
      ]),
    );
    const r = await claudePluginAdapter.read();
    expect(r.error).toBeUndefined();
    expect(r.exists).toBe(true);
    expect(r.plugins).toHaveLength(2);
    const vercel = r.plugins.find((p) => p.name === "vercel-plugin");
    expect(vercel?.marketplace).toBe("plugins-cli");
    expect(vercel?.enabled).toBe(true);
    const noscope = r.plugins.find((p) => p.name === "noscope-plugin");
    expect(noscope?.marketplace).toBeUndefined();
    expect(noscope?.enabled).toBe(false);
  });

  test("falls back to installed_plugins.json when claude --json output is truncated", async () => {
    await installFakeClaude("[".padEnd(65_536, " "));
    await writeClaudeInstalledPlugins({
      "foo@mkt": [
        {
          version: "1.2.3",
          scope: "user",
          installPath: "/x/foo",
        },
      ],
      "bar@mkt": [
        {
          version: "0.0.1",
          scope: "project",
          installPath: "/x/bar",
        },
      ],
    });

    const r = await claudePluginAdapter.read();
    expect(r.error).toBeUndefined();
    expect(r.exists).toBe(true);
    expect(r.plugins.map((p) => `${p.name}@${p.marketplace}:${p.version}:${p.scope}:${p.path}`).sort()).toEqual([
      "bar@mkt:0.0.1:project:/x/bar",
      "foo@mkt:1.2.3:user:/x/foo",
    ]);
  });

  test("parseClaudeInstalledPlugins handles Claude's state-file schema", () => {
    const plugins = parseClaudeInstalledPlugins({
      version: 2,
      plugins: {
        "foo@mkt": [{ version: "1.0.0", scope: "user", installPath: "/x/foo" }],
      },
    });
    expect(plugins).toEqual([
      { name: "foo", marketplace: "mkt", version: "1.0.0", enabled: undefined, scope: "user", path: "/x/foo" },
    ]);
  });

  test("returns error when claude CLI not on PATH", async () => {
    process.env.PATH = "/nonexistent-bin-dir-syncthis-test";
    const r = await claudePluginAdapter.read();
    expect(r.error).toBeTruthy();
    expect(r.exists).toBe(false);
  });

  test("marketplaceSources maps github marketplaces to owner/repo", async () => {
    await installFakeClaude(
      "[]",
      JSON.stringify([
        { name: "claude-code-warp", source: "github", repo: "warpdotdev/claude-code-warp" },
        { name: "local-mkt", source: "local", repo: undefined, installLocation: "/x" },
        { name: "no-repo", source: "github" },
      ]),
    );
    const map = await claudePluginAdapter.marketplaceSources!();
    expect(map).not.toBeNull();
    expect(map!.get("claude-code-warp")).toBe("warpdotdev/claude-code-warp");
    expect(map!.has("local-mkt")).toBe(false); // non-github omitted
    expect(map!.has("no-repo")).toBe(false); // no repo omitted
  });

  test("marketplaceSources falls back to known_marketplaces.json", async () => {
    await installFakeClaude("[]", "{not json");
    await writeClaudeKnownMarketplaces({
      mkt: { source: { source: "github", repo: "owner/repo" } },
      local: { source: { source: "local", repo: "owner/local" } },
    });
    const map = await claudePluginAdapter.marketplaceSources!();
    expect(map?.get("mkt")).toBe("owner/repo");
    expect(map?.has("local")).toBe(false);
  });

  test("marketplaceSources returns null on non-array JSON (read failure)", async () => {
    await installFakeClaude("[]", JSON.stringify({ marketplaces: [] }));
    const map = await claudePluginAdapter.marketplaceSources!();
    expect(map).toBeNull();
  });
});
