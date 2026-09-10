import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Spawns the real CLI so these tests exercise main() dispatch, the activation
// scope rails, non-TTY confirmation, and dry-run planning at the process
// boundary. Claude state is read from installed_plugins.json (no CLI needed to
// preview); a fake `claude` binary is added only for apply tests.
const BIN = join(import.meta.dir, "..", "bin", "syncthis.ts");
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "syncthis-act-cli-"));
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
      PATH: join(home, "bin"),
      NO_COLOR: "1",
    },
  });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function statePath(): string {
  return join(home, ".claude", "plugins", "installed_plugins.json");
}

async function writeClaudeState(enabled: boolean, scope?: string) {
  await mkdir(join(home, ".claude", "plugins"), { recursive: true });
  await writeFile(
    statePath(),
    JSON.stringify({
      version: 2,
      plugins: {
        "foo@mkt": [
          { version: "1.0.0", enabled, ...(scope ? { scope } : {}) },
        ],
      },
    }),
  );
}

async function readClaudeEnabled(): Promise<boolean | undefined> {
  const raw = JSON.parse(await readFile(statePath(), "utf8"));
  const entry = raw.plugins["foo@mkt"][0];
  return typeof entry.enabled === "boolean" ? entry.enabled : undefined;
}

// Fake `claude` that flips the state file on enable/disable and logs args.
// PATH inside CLI runs is exactly home/bin, so every tool must be absolute.
async function installFakeClaude(opts: { scope?: string } = {}) {
  const binDir = join(home, "bin");
  await mkdir(binDir, { recursive: true });
  const scopeField = opts.scope ? `"scope":"${opts.scope}",` : "";
  await writeClaudeState(true, opts.scope);
  const flipped = join(home, "flipped.json");
  await writeFile(
    flipped,
    `{"version":2,"plugins":{"foo@mkt":[{${scopeField}"version":"1.0.0","enabled":false}]}}`,
  );
  const script = `#!/bin/sh
echo "claude $@" >> ${join(home, "invocations.log")}
if [ "$2" = "enable" ]; then /bin/cp ${flipped} ${statePath()}; exit 0; fi
if [ "$2" = "disable" ]; then /bin/cp ${flipped} ${statePath()}; exit 0; fi
exit 0
`;
  const p = join(binDir, "claude");
  await writeFile(p, script);
  await chmod(p, 0o755);
}

async function invocations(): Promise<string[]> {
  try {
    return (await readFile(join(home, "invocations.log"), "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("activation help", () => {
  test("top-level help advertises enable/disable with the scope rail", () => {
    const result = run(["help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("syncthis plugins enable <name…>");
    expect(result.out).toContain("syncthis plugins disable");
    expect(result.out).toContain("--scope <s>");
    expect(result.out).not.toMatch(/\b(?:skills?|mcp|npx)\b/i);
  });

  test("plugins help advertises enable/disable", () => {
    const result = run(["plugins", "help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("syncthis plugins enable");
    expect(result.out).toContain("--scope user|project|local");
    expect(result.out).not.toMatch(/\b(?:skills?|mcp|npx)\b/i);
  });
});

describe("activation routing and scope rails", () => {
  test("unknown verbs are rejected", () => {
    const result = run(["plugins", "frobnicate", "foo", "--all"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/unknown verb/);
  });

  test("a missing explicit scope is a usage error", () => {
    const result = run(["plugins", "enable", "foo"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/explicit target scope/);
  });

  test("--all with --agents is a usage error", () => {
    const result = run(["plugins", "enable", "foo", "--all", "--agents", "claude-code"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/not both/);
  });

  test("an invalid --scope value is a usage error", () => {
    const result = run(["plugins", "enable", "foo", "--agents", "claude-code", "--scope", "everything"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/invalid --scope/);
  });

  test("--scope on a mixed target set is a usage error", () => {
    const result = run([
      "plugins",
      "enable",
      "foo",
      "--agents",
      "claude-code,grok-build",
      "--scope",
      "user",
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/applies only to Claude Code/);
  });
});

describe("activation confirmation and writes", () => {
  test("non-TTY refuses without --yes and writes nothing", async () => {
    await writeClaudeState(true);
    const result = run(["plugins", "disable", "foo", "--agents", "claude-code"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/refusing destructive write without --yes/);
    expect(await readClaudeEnabled()).toBe(true);
  });

  test("dry-run plans without running anything or claiming verification", async () => {
    await writeClaudeState(true);
    const result = run(["plugins", "disable", "foo", "--agents", "claude-code", "--dry-run"]);
    expect(result.code).toBe(0);
    // The preview must show the exact per-target native command.
    expect(result.out).toContain("would run: claude plugin disable -- foo@mkt");
    expect(result.out).toMatch(/nothing was verified/);
    expect(await invocations()).toEqual([]);
    expect(await readClaudeEnabled()).toBe(true);
  });

  test("--yes applies through the native CLI", async () => {
    await installFakeClaude();
    const result = run(["plugins", "disable", "foo@mkt", "--agents", "claude-code", "--yes"]);
    expect(result.code).toBe(0);
    expect(await readClaudeEnabled()).toBe(false);
    expect((await invocations()).some((l) => l.trim() === "claude plugin disable -- foo@mkt")).toBe(true);
  });

  test("an explicit scope rides the command unchanged", async () => {
    // The installed record carries the local scope; without it, an exact
    // scope-scoped request would correctly resolve to absent.
    await installFakeClaude({ scope: "local" });
    const result = run(["plugins", "disable", "foo@mkt", "--agents", "claude-code", "--scope", "local", "--yes"]);
    expect(result.code).toBe(0);
    expect((await invocations()).some((l) => l.trim() === "claude plugin disable --scope local -- foo@mkt")).toBe(true);
    expect(await readClaudeEnabled()).toBe(false);
  });

  test("nothing-to-do exits clean when every record already matches", async () => {
    await writeClaudeState(false);
    const result = run(["plugins", "disable", "foo", "--agents", "claude-code"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/nothing to do/);
    expect(await invocations()).toEqual([]);
  });

  test("blocked preview rows show the actual reason, not a can't-read label", async () => {
    // No readable state (corrupt installed_plugins.json) and no claude binary
    // on PATH: the preview's blocked row must carry the real cause verbatim.
    await mkdir(join(home, ".claude", "plugins"), { recursive: true });
    await writeFile(statePath(), "not json at all");
    const result = run(["plugins", "enable", "foo", "--agents", "claude-code", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("claude CLI not found on PATH");
    expect(result.out).not.toContain("can't read plugins");
    expect(await invocations()).toEqual([]);
  });
});

// Confirmed-preview authority at the process boundary. Grok reads shell out,
// so a counting fake can serve DIFFERENT native state during the preview than
// during the apply — a deterministic model of native drift between confirm
// and apply. Before the confirmed-preview boundary this drifted into silently
// mutating whatever record the fresh replan found; now it must fail with zero
// mutation commands.
describe("activation confirmed-preview authority", () => {
  test("a marketplace that moves between preview and apply fails without mutating", async () => {
    const binDir = join(home, "bin");
    const grokHome = join(home, ".grok");
    const pluginDir = join(home, "grok-plugins", "foo");
    const configPath = join(grokHome, "config.toml");
    const countFile = join(home, "list-count");
    await mkdir(binDir, { recursive: true });
    await mkdir(grokHome, { recursive: true });
    await mkdir(pluginDir, { recursive: true });
    await writeFile(configPath, '[plugins]\ndisabled = ["foo"]\n');
    const entry = (mkt: string) =>
      JSON.stringify({
        status: "installed",
        name: "foo",
        repo_key: `foo/${mkt}`,
        version: "1.0.0",
        path: pluginDir,
        source: "owner/repo",
        marketplace: mkt,
      });
    const listA = join(home, "list-a.json");
    const listB = join(home, "list-b.json");
    await writeFile(listA, `[${entry("m1")}]`);
    await writeFile(listB, `[${entry("m2")}]`);
    const log = join(home, "invocations.log");
    const script = `#!/bin/sh
echo "grok $@" >> ${log}
if [ "$1 $2 $3" = "plugin list --json" ]; then
  n=$(/bin/cat ${countFile} 2>/dev/null || echo 0)
  n=$((n+1))
  echo $n > ${countFile}
  if [ "$n" -le 2 ]; then /bin/cat ${listA}; else /bin/cat ${listB}; fi
  exit 0
fi
if [ "$2" = "enable" ]; then printf '[plugins]\\ndisabled = []\\n' > ${configPath}; exit 0; fi
exit 0
`;
    const p = join(binDir, "grok");
    await writeFile(p, script);
    await chmod(p, 0o755);

    // Preview sees foo@m1 twice (fresh read + dry-run preflight); apply's
    // fresh planning then sees foo@m2 — the confirmed record moved.
    const result = run(["plugins", "enable", "foo", "--agents", "grok-build", "--yes"]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/failed/);
    const lines = (await readFile(log, "utf8")).split("\n").filter(Boolean);
    expect(lines.some((l) => l.trim() === "grok plugin enable foo")).toBe(false);
    // Zero mutation means Grok's config was never touched either.
    expect(await readFile(configPath, "utf8")).toMatch(/disabled = \["foo"\]/);
  });

  test("an undrifted confirm still applies through the native command", async () => {
    const binDir = join(home, "bin");
    const grokHome = join(home, ".grok");
    const pluginDir = join(home, "grok-plugins", "foo");
    const configPath = join(grokHome, "config.toml");
    await mkdir(binDir, { recursive: true });
    await mkdir(grokHome, { recursive: true });
    await mkdir(pluginDir, { recursive: true });
    await writeFile(configPath, '[plugins]\ndisabled = ["foo"]\n');
    const entry = JSON.stringify({
      status: "installed",
      name: "foo",
      repo_key: "foo/main",
      version: "1.0.0",
      path: pluginDir,
      source: "owner/repo",
    });
    const listFile = join(home, "list.json");
    await writeFile(listFile, `[${entry}]`);
    const log = join(home, "invocations.log");
    const script = `#!/bin/sh
echo "grok $@" >> ${log}
if [ "$1 $2 $3" = "plugin list --json" ]; then /bin/cat ${listFile}; exit 0; fi
if [ "$2" = "enable" ]; then printf '[plugins]\\ndisabled = []\\n' > ${configPath}; exit 0; fi
exit 0
`;
    const p = join(binDir, "grok");
    await writeFile(p, script);
    await chmod(p, 0o755);

    const result = run(["plugins", "enable", "foo", "--agents", "grok-build", "--yes"]);
    expect(result.code).toBe(0);
    expect((await readFile(log, "utf8")).split("\n").filter(Boolean).some((l) => l.trim() === "grok plugin enable foo")).toBe(true);
    expect(await readFile(configPath, "utf8")).toMatch(/disabled = \[\]/);
  });
});
