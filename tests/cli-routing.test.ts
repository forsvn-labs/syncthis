import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Spawns the real CLI so these tests exercise main() dispatch and argument parsing.
// Every case uses a fresh HOME and an empty PATH; plugin commands are limited to
// dry-run/usage/read-only paths, so no external runtime is required.
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

function expectUnknown(args: string[], command = args[0]!) {
  const result = run(args);
  expect(result.code).toBe(2);
  expect(result.err).toContain(`unknown command: ${command}`);
  return result;
}

async function installPluginOverviewFixture() {
  const pluginRoot = join(home, "plugins", "foo");
  await mkdir(pluginRoot, { recursive: true });
  await mkdir(join(home, ".claude", "plugins"), { recursive: true });
  await writeFile(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "foo@mkt": [{ version: "1.2.3", enabled: true, installPath: pluginRoot }],
      },
    }),
  );
}

const FORBIDDEN_PUBLIC_TERMS = /\b(?:skills?|mcp|npx)\b/i;

describe("plugin-only public help", () => {
  test("top-level help exposes only the reliable plugin core", () => {
    const result = run(["help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Syncthis");
    expect(result.out).toContain("The npm package remains @forsvn/syncthis.");
    for (const command of [
      "syncthis sync",
      "syncthis plugins list",
      "syncthis plugins rm",
      "syncthis doctor",
      "syncthis update",
      "syncthis version",
      "syncthis help",
    ]) {
      expect(result.out).toContain(command);
    }
    expect(result.out).toContain("native · adapted · partial · blocked · unsupported");
    expect(result.out).not.toContain("--no-wrapper");
    expect(result.out).not.toContain("--from <primary>");
    expect(result.out).not.toContain("--no-skills");
    expect(result.out).not.toContain("syncthis skills");
    expect(result.out).not.toContain("syncthis mcp");
    expect(result.out).not.toContain("syncthis from");
    expect(result.out).not.toContain("syncthis add");
    expect(result.out).not.toContain("syncthis rm");
    expect(result.out).not.toContain("syncthis run");
    expect(result.out).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  test("plugin help stays within the public plugin surface", () => {
    const result = run(["plugins", "help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Syncthis");
    expect(result.out).toContain("syncthis plugins list");
    expect(result.out).toContain("syncthis plugins rm");
    expect(result.out).not.toContain("plugins mirror");
    expect(result.out).not.toContain("plugins add");
    expect(result.out).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });
});

describe("public command routing", () => {
  test("skills, mcp, from, and arbitrary two-agent forms are unknown", () => {
    for (const args of [
      ["skills"],
      ["skills", "update"],
      ["mcp"],
      ["mcp", "from", "claude-code", "--all"],
      ["from", "claude-code", "--all"],
      ["claude-code", "cursor", "--dry-run"],
      ["codex", "gemini-cli", "--dry-run"],
    ]) {
      expectUnknown(args);
    }
  });

  test("sync accepts --no-wrapper", () => {
    const result = run(["sync", "--dry-run", "--no-wrapper"]);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain("Unknown option");
  });

  test("sync rejects the removed --no-skills flag", () => {
    const result = run(["sync", "--dry-run", "--no-skills"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/unknown option|Unknown option|unrecognized option/i);
  });

  test("plugin add accepts readable --from and rejects write-only cursor", () => {
    const accepted = run([
      "plugins",
      "add",
      "ghost",
      "--from",
      "codex",
      "--agents",
      "opencode",
      "--dry-run",
    ]);
    // Codex is a valid source; the empty test PATH makes its source read fail at runtime,
    // which is distinct from rejecting the option as a usage error.
    expect(accepted.code).toBe(1);
    expect(accepted.out).toContain("(source: codex)");
    expect(accepted.err).toContain("codex");

    const rejected = run([
      "plugins",
      "add",
      "ghost",
      "--from",
      "cursor",
      "--agents",
      "opencode",
      "--dry-run",
    ]);
    expect(rejected.code).toBe(2);
    expect(rejected.err).toContain("--from");
    expect(rejected.err).toContain("cursor");
    expect(rejected.err).toMatch(/readable plugin source/);
  });

  test("inherited object property names remain unknown commands", () => {
    for (const command of ["constructor", "__proto__"]) expectUnknown([command]);
  });
});

describe("plugin-only aliases", () => {
  test("top-level add aliases plugin add, not legacy content add", () => {
    const publicForm = run(["plugins", "add", "ghost"]);
    const alias = run(["add", "plugin", "ghost"]);
    expect(publicForm.code).toBe(2);
    expect(alias.code).toBe(2);
    expect(alias.err).toBe(publicForm.err);
    expect(alias.err).not.toMatch(FORBIDDEN_PUBLIC_TERMS);

    const legacy = run(["add", "skill", "ghost", "--all"]);
    expect(legacy.code).toBe(2);
    expect(legacy.err).toContain("only adds plugins");
    expect(legacy.err).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  test("top-level rm/remove aliases plugin rm, not legacy content removal", () => {
    const publicForm = run(["plugins", "rm", "ghost"]);
    const rmAlias = run(["rm", "plugin", "ghost"]);
    const removeAlias = run(["remove", "ghost"]);
    expect(publicForm.code).toBe(2);
    expect(rmAlias.code).toBe(2);
    expect(removeAlias.code).toBe(2);
    expect(rmAlias.err).toBe(publicForm.err);
    expect(removeAlias.err).toBe(publicForm.err);
    expect(rmAlias.err).not.toMatch(FORBIDDEN_PUBLIC_TERMS);

    const legacy = run(["rm", "mcp", "ghost", "--all"]);
    expect(legacy.code).toBe(2);
    expect(legacy.err).toContain("only removes plugins");
    expect(legacy.err).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });
});

describe("doctor routing", () => {
  test("doctor renders read-only source and outcome diagnostics", async () => {
    await installPluginOverviewFixture();
    const result = run(["doctor"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Sources:");
    expect(result.out).toContain("Synchronization preview");
    expect(result.out).toContain("foo");
    expect(result.out).toContain("blocked");
    expect(result.out).not.toContain("coverage:");
    expect(result.out).not.toContain("server");
    expect(result.out).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  test("plugin overview remains read-only", async () => {
    await installPluginOverviewFixture();
    const before = await readFile(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8");
    const result = run(["plugins", "list"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("foo");
    expect(await readFile(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8")).toBe(before);
  });
});
