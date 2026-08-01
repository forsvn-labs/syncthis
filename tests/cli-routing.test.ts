import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Spawns the real CLI so we exercise the actual main() dispatch + arg parsing. Every case
// runs against a fresh empty $HOME and uses only --dry-run / --help / usage-error paths, so
// nothing is mutated and no external agent CLI (claude/codex/npx) is shelled out to.
const BIN = join(import.meta.dir, "..", "bin", "syncthis.ts");
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "syncthis-cli-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function run(args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PATH: join(home, "empty-bin"),
      NO_COLOR: "1",
    },
  });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

async function installPluginMcpFixture(config: string): Promise<string> {
  const pluginRoot = join(home, "plugins", "foo");
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        owned: { command: "plugin-command" },
      },
    }),
  );

  const binDir = join(home, "empty-bin");
  await mkdir(binDir, { recursive: true });
  const claudeList = join(home, "claude-list.json");
  await writeFile(
    claudeList,
    JSON.stringify([{ id: "foo@mkt", enabled: true, installPath: pluginRoot }]),
  );
  await writeFile(
    join(binDir, "claude"),
    `#!/bin/sh
if [ "$1 $2 $3" = "plugin list --json" ]; then /bin/cat "${claudeList}"; exit 0; fi
if [ "$1 $2 $3 $4" = "plugin marketplace list --json" ]; then echo "[]"; exit 0; fi
exit 0
`,
  );
  await chmod(join(binDir, "claude"), 0o755);
  await writeFile(
    join(binDir, "npx"),
    `#!/bin/sh
if [ "$2 $3" = "skills list" ]; then echo "[]"; exit 0; fi
exit 0
`,
  );
  await chmod(join(binDir, "npx"), 0o755);

  const configPath = join(home, ".config", "opencode", "opencode.json");
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(configPath, config);
  return configPath;
}

describe("noun-first help", () => {
  test("top-level help leads with the three nouns + flagship, hides legacy aliases", () => {
    const { code, out } = run(["help"]);
    expect(code).toBe(0);
    expect(out).toContain("syncthis sync");
    expect(out).toContain("syncthis plugins");
    expect(out).toContain("syncthis skills");
    expect(out).toContain("syncthis mcp");
    // Legacy forms still work but are not advertised in the top-level help.
    expect(out).not.toContain("selective add / remove");
    expect(out).not.toContain("syncthis mirror <primary>");
    expect(out).toContain("MCP fallback still run");
    expect(out).not.toContain("Automatic targeted fallback is not yet applied");
  });

  test("scoped help per noun", () => {
    expect(run(["plugins", "help"]).out).toContain("syncthis plugins list");
    expect(run(["skills", "help"]).out).toContain("syncthis skills update");
    expect(run(["mcp", "help"]).out).toContain("syncthis mcp sync");
  });

  test("unknown verb under a noun exits 2 with scoped guidance", () => {
    const p = run(["plugins", "bogus"]);
    expect(p.code).toBe(2);
    expect(p.err).toContain("plugins help");
    expect(run(["skills", "bogus"]).code).toBe(2);
    expect(run(["mcp", "totallynotanagent"]).code).toBe(2);
  });
});

describe("alias equivalence — new noun-first form === legacy form", () => {
  const pairs: Array<[string, string[], string[]]> = [
    ["mcp sync ≡ bare mcp", ["mcp", "sync", "--dry-run"], ["mcp", "--dry-run"]],
    ["mcp doctor ≡ doctor", ["mcp", "doctor"], ["doctor"]],
    [
      "mcp <from> <to> ≡ <from> <to>",
      ["mcp", "claude-code", "cursor", "--dry-run"],
      ["claude-code", "cursor", "--dry-run"],
    ],
    [
      "mcp from ≡ from (fan-out)",
      ["mcp", "from", "claude-code", "--all", "--dry-run"],
      ["from", "claude-code", "--all", "--dry-run"],
    ],
    [
      "mcp rm ≡ rm mcp",
      ["mcp", "rm", "ghost-server", "--all", "--dry-run"],
      ["rm", "mcp", "ghost-server", "--all", "--dry-run"],
    ],
  ];

  for (const [name, a, b] of pairs) {
    test(name, () => {
      const ra = run(a);
      const rb = run(b);
      expect(ra.code).toBe(rb.code);
      expect(ra.out).toBe(rb.out);
    });
  }

  test("plugins rm ≡ plugin rm (scope guard, no shell-out)", () => {
    const a = run(["plugins", "rm", "ghost", "--agents", "claude-code"]);
    const b = run(["plugin", "rm", "ghost", "--agents", "claude-code"]);
    // Both reach the same guarded uninstall; with no such plugin installed both end the
    // same way (and never mutate). Equivalence of exit code is the routing signal.
    expect(a.code).toBe(b.code);
  });

  test("skills add ≡ add skill (slug validation, no shell-out)", () => {
    const a = run(["skills", "add", "not a slug", "--all"]);
    const b = run(["add", "skill", "not a slug", "--all"]);
    expect(a.code).toBe(2);
    expect(b.code).toBe(2);
    expect(a.err).toBe(b.err);
  });
});

describe("plugin uninstall MCP reporting", () => {
  test("dry-run previews the exact degraded MCP removal without writing", async () => {
    const configPath = await installPluginMcpFixture(
      JSON.stringify({
        mcp: {
          owned: { type: "local", command: ["plugin-command"] },
          keep: { type: "local", command: ["keep-command"] },
        },
      }),
    );
    const before = await readFile(configPath, "utf8");

    const result = run([
      "plugins",
      "rm",
      "foo",
      "--agents",
      "opencode",
      "--dry-run",
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("1 MCP server: owned");
    expect(result.out).toContain("dry-run");
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  test("apply renders a successful degraded MCP removal", async () => {
    const configPath = await installPluginMcpFixture(
      JSON.stringify({
        mcp: {
          owned: { type: "local", command: ["plugin-command"] },
          keep: { type: "local", command: ["keep-command"] },
        },
      }),
    );

    const result = run([
      "plugins",
      "rm",
      "foo",
      "--agents",
      "opencode",
      "--yes",
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("removed 1 MCP server: owned");
    const current = JSON.parse(await readFile(configPath, "utf8")) as {
      mcp: Record<string, unknown>;
    };
    expect(current.mcp.owned).toBeUndefined();
    expect(current.mcp.keep).toBeDefined();
  });

  test("apply renders an MCP failure and exits nonzero", async () => {
    await installPluginMcpFixture("{not json");

    const result = run([
      "plugins",
      "rm",
      "foo",
      "--agents",
      "opencode",
      "--yes",
    ]);

    expect(result.code).toBe(1);
    expect(result.out).toContain("mcp:");
    expect(result.out).toContain("failed");
  });
});

describe("verb / directional disambiguation (KTD-4)", () => {
  test("`mcp from` is fan-out, not a directional mirror from an agent named 'from'", () => {
    // Fan-out requires --all; without it, fan-out errors. A directional parse would instead
    // treat 'from'/'claude-code' as two agents and complain 'from' is unknown. Assert the
    // fan-out error wording, proving the verb won.
    const r = run(["mcp", "from", "claude-code"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--all");
  });

  test("bare `mcp --dry-run` keeps the legacy union-sync behavior", () => {
    const r = run(["mcp", "--dry-run"]);
    expect(r.code).toBe(0);
    // union sync header (not a directional 'Mirror … →' header)
    expect(r.out).toContain("server name(s) across");
    expect(r.out).not.toContain("plugins:");
    expect(r.out).not.toContain("plugin fallback:");
  });
});

describe("top-level command registry", () => {
  test("inherited object property names remain unknown commands", () => {
    for (const command of ["constructor", "__proto__"]) {
      const result = run([command]);
      expect(result.code).toBe(2);
      expect(result.err).toContain(`unknown command: ${command}`);
    }
  });
});

describe("add — auto-detect type (U3)", () => {
  test("top-level help advertises `syncthis add`", () => {
    expect(run(["help"]).out).toContain("syncthis add");
  });

  test("`add help` documents auto-detection", () => {
    const r = run(["add", "help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("type auto-detected");
  });

  test("bare `add` (no source) errors with guidance", () => {
    const r = run(["add"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("name what to add");
  });

  test("invalid --as is rejected", () => {
    const r = run(["add", "foo", "--as", "bogus", "--all"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--as must be one of");
  });

  test("--as mcp (a bare name) is refused — syncthis doesn't install MCP servers", () => {
    const r = run(["add", "some-server", "--as", "mcp", "--all"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("doesn't install them");
  });

  test("explicit `add mcp` still refused", () => {
    const r = run(["add", "mcp", "some-server", "--all"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("add mcp");
  });

  test("owner/repo auto-detects to skill (then enforces scope, no shell-out)", () => {
    // A slash → skill needs no Claude lookup; cmdAddSkill validates the slug, then the
    // missing --all/--agents scope errors before anything is shelled out.
    const r = run(["add", "vercel-labs/agent-skills"]);
    expect(r.out).toContain("detected skill");
    expect(r.code).toBe(2);
    expect(r.err).toContain("scope");
  });
});
