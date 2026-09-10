import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPluginOverview,
  overviewCounts,
  pluginDetailLines,
  pluginOverviewRows,
  pluginRowSummary,
  renderPluginOverview,
  type PluginOverview,
  type PluginOverviewRow,
} from "../src/plugins/overview.ts";
import { skillAgentLabelToId, listInstalledSkills } from "../src/skills.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-overview-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  process.env.HOME = workDir;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  await rm(workDir, { recursive: true, force: true });
});

type CodexRow = [id: string, status: string, version: string, path: string];
function codexTable(rows: CodexRow[]): string {
  const header: CodexRow = ["PLUGIN", "STATUS", "VERSION", "PATH"];
  const all = [header, ...rows];
  const w = [0, 1, 2].map((i) => Math.max(...all.map((r) => r[i]!.length)));
  const fmt = (r: CodexRow) =>
    `${r[0].padEnd(w[0]! + 2)}${r[1].padEnd(w[1]! + 2)}${r[2].padEnd(w[2]! + 2)}${r[3]}`.replace(/\s+$/, "");
  return ["Marketplace `mkt`", "/x/marketplace.json", "", fmt(header), ...rows.map(fmt), ""].join("\n");
}

// Install fake native CLIs + npx. The npx stub is retained for the
// independent skills bridge tests below.
async function installFakes(opts: { claudeJson: string; codexList: string; skillsListJson?: string; skillsListFail?: boolean }) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });

  const claudeList = join(workDir, "claude.json");
  await writeFile(claudeList, opts.claudeJson);
  const claude = `#!/bin/sh
if [ "$1 $2 $3" = "plugin list --json" ]; then cat ${claudeList}; exit 0; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then echo "[]"; exit 0; fi
exit 0
`;
  await writeFile(join(binDir, "claude"), claude);
  await chmod(join(binDir, "claude"), 0o755);

  const codexList = join(workDir, "codex.txt");
  await writeFile(codexList, opts.codexList);
  const codex = `#!/bin/sh
if [ "$1 $2" = "plugin list" ]; then cat ${codexList}; exit 0; fi
exit 0
`;
  await writeFile(join(binDir, "codex"), codex);
  await chmod(join(binDir, "codex"), 0o755);

  const copilot = `#!/bin/sh
if [ "$1 $2 $3" = "plugin list" ]; then echo "No plugins installed"; exit 0; fi
exit 0
`;
  await writeFile(join(binDir, "copilot"), copilot);
  await chmod(join(binDir, "copilot"), 0o755);

  const grok = `#!/bin/sh
if [ "$1 $2 $3" = "plugin list --json" ]; then echo '[]'; exit 0; fi
exit 1
`;
  await writeFile(join(binDir, "grok"), grok);
  await chmod(join(binDir, "grok"), 0o755);

  const npx = `#!/bin/sh
if [ "$2 $3" = "skills list" ]; then ${opts.skillsListFail ? "exit 1" : `echo '${opts.skillsListJson ?? "[]"}'; exit 0`}; fi
exit 0
`;
  await writeFile(join(binDir, "npx"), npx);
  await chmod(join(binDir, "npx"), 0o755);

  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

describe("skillAgentLabelToId", () => {
  test("maps the skills CLI's display labels to syncthis ids", () => {
    expect(skillAgentLabelToId("Gemini CLI")).toBe("gemini-cli");
    expect(skillAgentLabelToId("Kimi Code CLI")).toBe("kimi-cli");
    expect(skillAgentLabelToId("Antigravity")).toBe("antigravity");
    expect(skillAgentLabelToId("Antigravity CLI")).toBeUndefined();
    expect(skillAgentLabelToId("Hermes Agent")).toBe("hermes-agent");
    expect(skillAgentLabelToId("OpenCode")).toBe("opencode");
    expect(skillAgentLabelToId("Pi")).toBe("pi");
    expect(skillAgentLabelToId("Warp")).toBeUndefined(); // not a syncthis agent
  });
});

describe("listInstalledSkills", () => {
  test("returns null when `npx skills list` can't be read", async () => {
    await installFakes({ claudeJson: "[]", codexList: codexTable([]), skillsListFail: true });
    expect(await listInstalledSkills()).toBeNull();
  });

  test("parses names + maps agent labels to ids", async () => {
    await installFakes({
      claudeJson: "[]",
      codexList: codexTable([]),
      skillsListJson: '[{"name":"alpha","agents":["OpenCode","Kimi Code CLI","Antigravity","Antigravity CLI","Warp"]}]',
    });
    const skills = await listInstalledSkills();
    expect(skills).toEqual([{ name: "alpha", path: "", agents: ["opencode", "kimi-cli", "antigravity"] }]); // "Warp" dropped
  });
});

describe("buildPluginOverview", () => {
  test("returns native plugin reads only", async () => {
    await installFakes({
      claudeJson: JSON.stringify([{ id: "foo@mkt", enabled: true, installPath: "/x/foo" }]),
      codexList: codexTable([["bar@mkt", "installed, enabled", "1.0.0", "/c/bar"]]),
      // A loose copy must not become installed plugin state, even when it shares a name.
      skillsListJson: '[{"name":"foo","agents":["OpenCode"]},{"name":"loose-copy","agents":["Gemini CLI"]}]',
    });

    const o = await buildPluginOverview();
    expect(Object.keys(o)).toEqual(["native"]);
    expect(o.native.find((r) => r.agent === "claude-code")?.plugins.map((p) => p.name)).toEqual(["foo"]);
    expect(o.native.find((r) => r.agent === "codex")?.plugins.map((p) => p.name)).toEqual(["bar"]);
    expect(JSON.stringify(o)).not.toContain("loose-copy");
    expect(overviewCounts(o)).toEqual({
      plugins: 2,
      nativeInstalls: 2,
      readableAgents: 3,
      blockedAgents: 1,
    });
    const rendered = renderPluginOverview(o).join("\n");
    expect(rendered).toContain("Plugin");
    expect(rendered).toContain("Claude");
    expect(rendered).toContain("foo@mkt");
    expect(rendered).toContain("bar@mkt");
    expect(rendered).toContain("Cursor is write-only");
  });

  test("does not depend on loose-resource inventory availability", async () => {
    await installFakes({
      claudeJson: JSON.stringify([{ id: "foo@mkt", enabled: true, installPath: "/x/foo" }]),
      codexList: codexTable([]),
      skillsListFail: true,
    });

    const o = await buildPluginOverview();
    expect(Object.keys(o)).toEqual(["native"]);
    expect(o.native.find((r) => r.agent === "claude-code")?.plugins.map((p) => p.name)).toEqual(["foo"]);
  });
});

describe("installed-plugin detail helpers (pure)", () => {
  const overview: PluginOverview = {
    native: [
      {
        agent: "claude-code",
        configPath: "/h/.claude/plugins/installed_plugins.json",
        exists: true,
        plugins: [],
      },
      { agent: "codex", configPath: "/h/.codex", exists: true, plugins: [] },
      { agent: "github-copilot", configPath: "/h/copilot", exists: true, plugins: [] },
      { agent: "grok-build", configPath: "/h/grok", exists: false, plugins: [], error: "grok unavailable" },
    ],
  };

  function row(overrides: Partial<PluginOverviewRow["agents"]> = {}): PluginOverviewRow {
    return {
      plugin: "foo@mkt",
      agents: {
        "claude-code": {
          state: "native",
          version: "1.2.3",
          marketplace: "mkt",
          scope: "user",
          path: "/h/.claude/plugins/foo",
        },
        codex: { state: "disabled", version: "1.0.0" },
        ...overrides,
      },
    };
  }

  test("detail lines report per-agent state, version, scope, and provenance", () => {
    const lines = pluginDetailLines(overview, row()).join("\n");

    expect(lines).toContain("Installed state for foo@mkt");
    expect(lines).toContain("claude-code · native · version 1.2.3 · scope user · path /h/.claude/plugins/foo");
    expect(lines).toContain("codex · native · disabled");
    expect(lines).toContain("github-copilot · not installed");
    // Unreadable sources get "blocked — reason", never an invented state.
    expect(lines).toContain("grok-build · blocked — grok unavailable");
    expect(lines).toContain("Cursor is write-only");
  });

  test("falls back to source repo provenance when no local path is known", () => {
    const lines = pluginDetailLines(overview, row({
      "claude-code": { state: "native", version: "1.2.3", sourceRepo: "owner/repo" },
    })).join("\n");

    expect(lines).toContain("claude-code · native · version 1.2.3 · source owner/repo");
    expect(lines).not.toContain("path ");
  });

  test("an all-absent plugin claims nothing as installed", () => {
    const emptyRow: PluginOverviewRow = { plugin: "ghost", agents: {} };
    const lines = pluginDetailLines(overview, emptyRow).join("\n");

    expect(lines).toContain("No readable agent reports this plugin as installed.");
    expect(lines).not.toContain("· native");
  });

  test("row summaries cover the four readable sources without unreadable claims", () => {
    expect(pluginRowSummary(row())).toBe(
      "Claude native · Codex off · Copilot — · Grok —",
    );
    expect(pluginRowSummary(row({ codex: undefined }))).toBe(
      "Claude native · Codex — · Copilot — · Grok —",
    );
  });
});
