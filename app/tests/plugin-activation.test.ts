import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudePluginAdapter } from "../src/plugins/claude.ts";
import { grokPluginAdapter } from "../src/plugins/grok.ts";
import {
  ActivationUsageError,
  activationHasChanges,
  assertConfirmedPreviewMatches,
  resolveActivationRequest,
  runPluginActivation,
} from "../src/plugins/activation.ts";
import type { PluginActivationScope } from "../src/plugins/types.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;
let originalGrokHome: string | undefined;
let invocationsFile: string;

const KNOWN: readonly string[] = ["claude-code", "codex", "github-copilot", "grok-build", "cursor", "opencode"];

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-activation-"));
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

function statePath(): string {
  return join(workDir, ".claude", "plugins", "installed_plugins.json");
}

async function writeClaudeState(records: Array<{ id: string; enabled?: boolean; scope?: string }>) {
  await mkdir(join(workDir, ".claude", "plugins"), { recursive: true });
  const map: Record<string, unknown[]> = {};
  for (const r of records) {
    const entry = { version: "1.0.0", ...(r.enabled === undefined ? {} : { enabled: r.enabled }), ...(r.scope ? { scope: r.scope } : {}) };
    if (!map[r.id]) map[r.id] = [];
    map[r.id]!.push(entry);
  }
  await writeFile(statePath(), JSON.stringify({ version: 2, plugins: map }));
}

// Fake `claude`: on any `plugin <op>` it copies `flipWith` over the state file
// (the fresh read-back source), or exits 0 without changing anything when
// `noOp` is set — modeling "CLI claimed success, nothing actually changed".
async function installFakeClaude(opts: { flipWith?: string; noOp?: boolean; cmdExit?: number } = {}) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const flipWith = opts.flipWith ?? statePath();
  const exit = opts.cmdExit ?? 0;
  const script = `#!/bin/sh
echo "claude $@" >> ${invocationsFile}
if [ "$2" = "enable" ] || [ "$2" = "disable" ]; then
  ${opts.noOp ? "" : `cp '${flipWith}' '${statePath()}'`}
  exit ${exit}
fi
exit 0
`;
  const p = join(binDir, "claude");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

async function writeFlipFile(records: Array<{ id: string; enabled?: boolean; scope?: string }>): Promise<string> {
  const flipped = join(workDir, `.flip-${Math.random().toString(36).slice(2)}.json`);
  await mkdir(join(workDir, ".claude", "plugins"), { recursive: true });
  const map: Record<string, unknown[]> = {};
  for (const r of records) {
    const entry = { version: "1.0.0", ...(r.enabled === undefined ? {} : { enabled: r.enabled }), ...(r.scope ? { scope: r.scope } : {}) };
    if (!map[r.id]) map[r.id] = [];
    map[r.id]!.push(entry);
  }
  await writeFile(flipped, JSON.stringify({ version: 2, plugins: map }));
  return flipped;
}

type GrokEntry = {
  name: string;
  marketplace?: string;
};

function grokListJson(entries: GrokEntry[], dir: string): string {
  return JSON.stringify(
    entries.map((e) => ({
      status: "installed",
      name: e.name,
      repo_key: e.marketplace ? `${e.name}/${e.marketplace}` : `${e.name}/main`,
      version: "1.0.0",
      path: dir,
      source: "owner/repo",
      ...(e.marketplace ? { marketplace: e.marketplace } : {}),
    })),
  );
}

// Fake `grok`: mutable list file plus a config.toml whose `disabled` array is
// swapped by `grok plugin enable|disable`. `postListWith` replaces the list
// AFTER a mutating command, modeling an overlap appearing during read-back.
async function installFakeGrok(
  entries: GrokEntry[],
  opts: { postListWith?: GrokEntry[]; startDisabled?: boolean } = {},
) {
  const binDir = join(workDir, "bin");
  const grokHome = join(workDir, ".grok");
  const pluginDir = join(workDir, "grok-plugins", "foo");
  await mkdir(binDir, { recursive: true });
  await mkdir(grokHome, { recursive: true });
  await mkdir(pluginDir, { recursive: true });
  process.env.GROK_HOME = grokHome;
  const listFile = join(workDir, "grok-list.json");
  await writeFile(listFile, grokListJson(entries, pluginDir));
  const cfgOn = join(workDir, "grok-cfg-on.toml");
  const cfgOff = join(workDir, "grok-cfg-off.toml");
  await writeFile(cfgOn, "[plugins]\ndisabled = []\n");
  await writeFile(cfgOff, '[plugins]\ndisabled = ["foo"]\n');
  await writeFile(
    join(grokHome, "config.toml"),
    opts.startDisabled ? '[plugins]\ndisabled = ["foo"]\n' : "[plugins]\ndisabled = []\n",
  );
  let postBranch = "";
  if (opts.postListWith) {
    const postFile = join(workDir, "grok-list-post.json");
    await writeFile(postFile, grokListJson(opts.postListWith, pluginDir));
    postBranch = `cp ${postFile} ${listFile};`;
  }
  const script = `#!/bin/sh
echo "grok $@" >> ${invocationsFile}
if [ "$1 $2 $3" = "plugin list --json" ]; then cat ${listFile}; exit 0; fi
${postBranch}
if [ "$2" = "enable" ]; then cp ${cfgOn} ${join(grokHome, "config.toml")}; exit 0; fi
if [ "$2" = "disable" ]; then cp ${cfgOff} ${join(grokHome, "config.toml")}; exit 0; fi
exit 0
`;
  const p = join(binDir, "grok");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
}

describe("resolveActivationRequest rails", () => {
  const known = [...KNOWN] as Parameters<typeof resolveActivationRequest>[0]["known"];

  test("--all and --agents are mutually exclusive", () => {
    expect(() => resolveActivationRequest({ all: true, agents: "claude-code", known })).toThrow(/not both/);
  });

  test("an explicit scope is required", () => {
    expect(() => resolveActivationRequest({ all: false, known })).toThrow(/explicit target scope/);
  });

  test("unknown agents are rejected", () => {
    expect(() => resolveActivationRequest({ all: false, agents: "emacs", known })).toThrow(/unknown agent/);
  });

  test("invalid --scope values are rejected", () => {
    expect(() => resolveActivationRequest({ all: true, scope: "everything", known })).toThrow(/invalid --scope/);
  });

  test("--scope survives only a pure Claude Code selection", () => {
    expect(() =>
      resolveActivationRequest({ all: false, agents: "claude-code,grok-build", scope: "user", known }),
    ).toThrow(/applies only to Claude Code/);
  });

  test("a Claude-only selection carries the exact scope", () => {
    expect(resolveActivationRequest({ all: false, agents: "claude-code", scope: "local", known })).toEqual({
      agents: ["claude-code"],
      scope: "local",
    });
  });

  test("omitting --scope means auto-detect", () => {
    expect(resolveActivationRequest({ all: false, agents: "claude-code", known }).scope).toBeUndefined();
  });

  test("--all enumerates every known reconcile target", () => {
    expect([...resolveActivationRequest({ all: true, known }).agents]).toEqual([...known]);
  });

  test("the error type is usage-shaped for the CLI", () => {
    expect(() => resolveActivationRequest({ all: false, known })).toThrow(ActivationUsageError);
  });
});

describe("runPluginActivation service", () => {
  test("--all accounts for every requested target, including those outside the adapter registry", async () => {
    await writeClaudeState([{ id: "foo@mkt", enabled: false }]);
    const report = await runPluginActivation({
      op: "enable",
      plugins: ["foo"],
      agents: ["claude-code", "codex", "cursor", "opencode"],
      apply: false,
    });
    const unsupportedAgents = report.unsupported.map((u) => u.agent).sort();
    expect(unsupportedAgents).toEqual(["codex", "cursor", "opencode"]);
    for (const item of report.unsupported) {
      expect(item.reason).toMatch(/no proven integrated activation write\/readback contract/);
    }
    expect(report.targets.every((t) => t.agent === "claude-code")).toBe(true);
    // Nothing outside the capable adapters was ever invoked: PATH holds only the fake claude.
    const invocations = await readInvocations();
    expect(invocations.every((line) => !line.startsWith("codex ") && !line.startsWith("cursor "))).toBe(true);
  });

  test(">1 candidate after filtering is ambiguous even when the marketplace was supplied", async () => {
    await writeClaudeState([
      { id: "foo@mkt", enabled: true, scope: "user" },
      { id: "foo@mkt", enabled: false, scope: "project" },
    ]);
    const applied = await runPluginActivation({
      op: "disable",
      plugins: ["foo@mkt"],
      agents: ["claude-code"],
      apply: true,
    });
    const target = applied.targets.find((t) => t.agent === "claude-code")!;
    expect(target.ambiguousRecords?.length).toBe(2);
    expect(applied.results![0]!).toMatchObject({ status: "failed" });
    expect(applied.results![0]!.message).toMatch(/several installed records match/);
    // The ambiguity was refused before any command ran.
    expect((await readInvocations()).some((l) => /plugin (enable|disable)/.test(l))).toBe(false);
  });

  test("an explicit scope narrows to exactly one record", async () => {
    await writeClaudeState([
      { id: "foo@mkt", enabled: true, scope: "user" },
      { id: "foo@mkt", enabled: true, scope: "project" },
    ]);
    const report = await runPluginActivation({
      op: "disable",
      plugins: ["foo@mkt"],
      agents: ["claude-code"],
      scope: "user",
      apply: false,
    });
    const target = report.targets.find((t) => t.agent === "claude-code")!;
    expect(target.ambiguousRecords).toBeUndefined();
    expect(target.scope).toBe("user");
    expect(target.currentlyEnabled).toBe(true);
  });

  test("apply carries the observed scope of a single auto-detected record", async () => {
    await writeClaudeState([{ id: "foo@mkt", enabled: false, scope: "user" }]);
    await installFakeClaude({
      flipWith: await writeFlipFile([{ id: "foo@mkt", enabled: true, scope: "user" }]),
    });
    const applied = await runPluginActivation({
      op: "enable",
      plugins: ["foo"],
      agents: ["claude-code"],
      apply: true,
    });
    expect(applied.results![0]!).toMatchObject({ agent: "claude-code", target: "foo@mkt", status: "enabled" });
    expect((await readInvocations()).some((l) => l.trim() === "claude plugin enable --scope user -- foo@mkt")).toBe(true);
  });

  test("requesting the same plugin twice never duplicates commands", async () => {
    await writeClaudeState([{ id: "foo@m2", enabled: false }]);
    await installFakeClaude({
      flipWith: await writeFlipFile([{ id: "foo@m2", enabled: true }]),
    });
    const applied = await runPluginActivation({
      op: "enable",
      plugins: ["foo", "foo@m2"],
      agents: ["claude-code"],
      apply: true,
    });
    // The bare and qualified spellings resolve to the SAME single record, so
    // exactly one row — and one command — is produced.
    const statuses = applied.results!.map((r) => r.status).sort();
    expect(statuses).toEqual(["enabled"]);
    expect(applied.targets.filter((t) => t.agent === "claude-code")).toHaveLength(1);
    const mutations = (await readInvocations()).filter((l) => /plugin enable/.test(l));
    expect(mutations).toHaveLength(1);
  });

  test("duplicate identical plugin arguments produce exactly one command", async () => {
    await writeClaudeState([{ id: "foo@mkt", enabled: false }]);
    await installFakeClaude({
      flipWith: await writeFlipFile([{ id: "foo@mkt", enabled: true }]),
    });
    const applied = await runPluginActivation({
      op: "enable",
      plugins: ["foo@mkt", "foo@mkt"],
      agents: ["claude-code"],
      apply: true,
    });
    expect(applied.results).toHaveLength(1);
    const mutations = (await readInvocations()).filter((l) => /plugin enable/.test(l));
    expect(mutations).toHaveLength(1);
  });

  test("dry-run plans without running anything and never claims verification", async () => {
    await writeClaudeState([{ id: "foo@mkt", enabled: false, scope: "user" }]);
    await installFakeClaude();
    const planned = await runPluginActivation({
      op: "enable",
      plugins: ["foo"],
      agents: ["claude-code"],
      apply: true,
      dryRun: true,
    });
    expect(planned.results![0]!).toMatchObject({ planned: true, status: "enabled" });
    expect(planned.results![0]!.message).toMatch(/nothing was verified/);
    // The planned command is the exact native argv, previewable pre-confirmation.
    expect(planned.targets[0]!.plannedCommand).toEqual([
      "claude",
      "plugin",
      "enable",
      "--scope",
      "user",
      "--",
      "foo@mkt",
    ]);
    expect(await readInvocations()).toEqual([]);
  });

  test("a Grok preflight refusal shows up before confirmation and fails a planned run", async () => {
    const pluginDir = join(workDir, "grok-plugins", "foo");
    await mkdir(pluginDir, { recursive: true });
    await installFakeGrok(
      [
        { name: "foo", marketplace: "m1" },
        { name: "foo", marketplace: "m2" },
      ],
      { startDisabled: true },
    );
    const preview = await runPluginActivation({
      op: "enable",
      plugins: ["foo@m1"],
      agents: ["grok-build"],
      apply: false,
    });
    const target = preview.targets.find((t) => t.agent === "grok-build")!;
    expect(target.refusal).toMatch(/cannot select exactly one installed Grok record/);
    expect(target.refusal).toMatch(/marketplace/);

    const planned = await runPluginActivation({
      op: "enable",
      plugins: ["foo@m1"],
      agents: ["grok-build"],
      apply: true,
      dryRun: true,
    });
    expect(planned.results![0]!).toMatchObject({ status: "failed" });
    expect((await readInvocations()).some((l) => l.trim() === "grok plugin enable foo")).toBe(false);
  });

  test("a qualified Grok request is still refused while overlap spans marketplaces", async () => {
    const pluginDir = join(workDir, "grok-plugins", "foo");
    await mkdir(pluginDir, { recursive: true });
    await installFakeGrok(
      [
        { name: "foo", marketplace: "m1" },
        { name: "foo", marketplace: "m2" },
      ],
      { startDisabled: true },
    );
    const applied = await runPluginActivation({
      op: "enable",
      plugins: ["foo@m1"],
      agents: ["grok-build"],
      apply: true,
    });
    expect(applied.results![0]!.status).toBe("failed");
    expect((await readInvocations()).some((l) => /plugin enable/.test(l))).toBe(false);
  });

  test("activationHasChanges gates on would-change targets only", async () => {
    await writeClaudeState([{ id: "foo@mkt", enabled: true }]);
    const report = await runPluginActivation({
      op: "enable",
      plugins: ["foo"],
      agents: ["claude-code"],
      apply: false,
    });
    expect(activationHasChanges(report)).toBe(false);
  });
});

  test("a bare name over duplicate marketplaces is ambiguous and runs no command", async () => {
    await writeClaudeState([
      { id: "foo@m1", enabled: false },
      { id: "foo@m2", enabled: false },
    ]);
    await installFakeClaude();
    const applied = await runPluginActivation({
      op: "enable",
      plugins: ["foo"],
      agents: ["claude-code"],
      apply: true,
    });
    const target = applied.targets.find((t) => t.agent === "claude-code")!;
    expect(target.ambiguousRecords?.sort()).toEqual(["foo@m1", "foo@m2"]);
    expect(applied.results![0]!.status).toBe("failed");
    expect((await readInvocations()).filter((l) => /plugin (enable|disable)/.test(l))).toEqual([]);
  });

  test("duplicate scopes of one marketplace are refused before any command", async () => {
    await writeClaudeState([
      { id: "foo@mkt", enabled: false, scope: "user" },
      { id: "foo@mkt", enabled: false, scope: "user" },
    ]);
    await installFakeClaude();
    const applied = await runPluginActivation({
      op: "enable",
      plugins: ["foo@mkt"],
      agents: ["claude-code"],
      apply: true,
    });
    expect(applied.results![0]!.status).toBe("failed");
    expect((await readInvocations()).filter((l) => /plugin (enable|disable)/.test(l))).toEqual([]);
  });

  test("an unsafe qualified ID fails without shelling out", async () => {
    await writeClaudeState([{ id: "foo", enabled: false }]);
    const applied = await runPluginActivation({
      op: "enable",
      plugins: ["foo@../evil"],
      agents: ["claude-code"],
      apply: true,
    });
    expect(applied.results![0]).toMatchObject({ agent: "claude-code", status: "failed" });
    expect(applied.results![0]!.message).toMatch(/unsafe/);
    expect(await readInvocations()).toEqual([]);
  });

describe("claude setPluginActivation", () => {
  test("reports absent without shelling out", async () => {
    await writeClaudeState([{ id: "other@mkt", enabled: true }]);
    const res = await claudePluginAdapter.setPluginActivation!("foo", { op: "enable", dryRun: false });
    expect(res.status).toBe("absent");
    expect(await readInvocations()).toEqual([]);
  });

  test("rejects unsafe names without shelling out", async () => {
    await writeClaudeState([{ id: "foo", enabled: false }]);
    const res = await claudePluginAdapter.setPluginActivation!("../../evil", { op: "enable", dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/unsafe/);
    expect(await readInvocations()).toEqual([]);
  });

  test("uses the exact scoped command form", async () => {
    await writeClaudeState([{ id: "foo", enabled: false, scope: "local" }]);
    await installFakeClaude({
      flipWith: await writeFlipFile([{ id: "foo", enabled: true, scope: "local" }]),
    });
    const res = await claudePluginAdapter.setPluginActivation!("foo", {
      op: "enable",
      dryRun: false,
      scope: "local",
    });
    expect(res.status).toBe("enabled");
    expect((await readInvocations()).some((l) => l.trim() === "claude plugin enable --scope local -- foo")).toBe(true);
  });

  test("omitted scope runs the bare command form", async () => {
    await writeClaudeState([{ id: "foo", enabled: true }]);
    await installFakeClaude({ flipWith: await writeFlipFile([{ id: "foo", enabled: false }]) });
    const res = await claudePluginAdapter.setPluginActivation!("foo", { op: "disable", dryRun: false });
    expect(res.status).toBe("disabled");
    expect((await readInvocations()).some((l) => l.trim() === "claude plugin disable -- foo")).toBe(true);
  });

  test("refuses several identical records BEFORE running the command", async () => {
    const dupes = [
      { id: "foo@mkt", enabled: false, scope: "user" },
      { id: "foo@mkt", enabled: false, scope: "user" },
    ];
    await writeClaudeState(dupes);
    const res = await claudePluginAdapter.setPluginActivation!("foo", {
      op: "enable",
      dryRun: false,
      scope: "user",
      marketplace: "mkt",
    });
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/several installed records match/);
    expect(await readInvocations()).toEqual([]);
  });

  test("fails when the command exits zero but the WRONG scope's record changed", async () => {
    const before = [
      { id: "foo@mkt", enabled: true, scope: "user" },
      { id: "foo@mkt", enabled: true, scope: "project" },
    ];
    // The fake CLI flips only the user-scope sibling; the project record (the
    // requested one) is untouched, so the exact-scope read-back must fail it.
    await writeClaudeState(before);
    await installFakeClaude({
      flipWith: await writeFlipFile([
        { id: "foo@mkt", enabled: false, scope: "user" },
        { id: "foo@mkt", enabled: true, scope: "project" },
      ]),
    });
    const res = await claudePluginAdapter.setPluginActivation!("foo", {
      op: "disable",
      dryRun: false,
      scope: "project",
      marketplace: "mkt",
    });
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/exactly one.*disabled/i);
  });

  test("already-in-state reports without running the command", async () => {
    await writeClaudeState([{ id: "foo", enabled: true }]);
    const res = await claudePluginAdapter.setPluginActivation!("foo", { op: "enable", dryRun: false });
    expect(res.status).toBe("enabled");
    expect(res.message).toMatch(/already enabled/);
    expect(await readInvocations()).toEqual([]);
  });

});

describe("grok setPluginActivation", () => {
  test("runs the bare native command form", async () => {
    await installFakeGrok([{ name: "foo" }]);
    const res = await grokPluginAdapter.setPluginActivation!("foo", { op: "disable", dryRun: false });
    expect(res.status).toBe("disabled");
    expect((await readInvocations()).some((l) => l.trim() === "grok plugin disable foo")).toBe(true);
  });

  test("rejects an explicit scope without shelling out", async () => {
    await installFakeGrok([{ name: "foo" }]);
    const res = await grokPluginAdapter.setPluginActivation!("foo", { op: "enable", dryRun: false, scope: "user" });
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/--scope/);
    expect(await readInvocations()).toEqual([]);
  });

  test("readback rejects an overlap that appears during the command", async () => {
    await installFakeGrok([{ name: "foo" }], {
      startDisabled: true,
      postListWith: [{ name: "foo", marketplace: "m1" }, { name: "foo", marketplace: "m2" }],
    });
    const res = await grokPluginAdapter.setPluginActivation!("foo", { op: "enable", dryRun: false });
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/does not resolve to exactly one/);
  });

  test("already-in-state reports without running the command", async () => {
    await installFakeGrok([{ name: "foo" }]);
    // Fresh fixture: config has no disabled entries, so foo is enabled.
    const res = await grokPluginAdapter.setPluginActivation!("foo", { op: "enable", dryRun: false });
    expect(res.status).toBe("enabled");
    expect(res.message).toMatch(/already enabled/);
    expect((await readInvocations()).some((l) => /plugin enable/.test(l))).toBe(false);
  });
});

describe("assertConfirmedPreviewMatches policy", () => {
  const base = {
    op: "enable" as const,
    plugins: ["foo"],
    agents: ["claude-code"] as Parameters<typeof assertConfirmedPreviewMatches>[0]["agents"],
    scope: undefined as PluginActivationScope | undefined,
  };
  const preview = {
    op: "enable" as const,
    plugins: ["foo"],
    requestedAgents: ["claude-code"] as typeof base.agents,
    targets: [],
    unsupported: [],
    applied: false,
  } as import("../src/plugins/activation.ts").ActivationReport;

  test("an identical request passes", () => {
    expect(() => assertConfirmedPreviewMatches(base, preview)).not.toThrow();
  });

  test("a different op is refused", () => {
    expect(() => assertConfirmedPreviewMatches({ ...base, op: "disable" }, preview)).toThrow(ActivationUsageError);
  });

  test("different plugins are refused", () => {
    expect(() => assertConfirmedPreviewMatches({ ...base, plugins: ["foo", "bar"] }, preview)).toThrow(/plugins differ/);
  });

  test("different requested agents are refused", () => {
    expect(() =>
      assertConfirmedPreviewMatches({ ...base, agents: ["claude-code", "grok-build"] }, preview),
    ).toThrow(/agents differ/);
  });

  test("a different scope is refused", () => {
    expect(() => assertConfirmedPreviewMatches({ ...base, scope: "user" }, preview)).toThrow(/scope auto is not user/);
  });

  test("an already-applied report is refused as a preview", () => {
    expect(() => assertConfirmedPreviewMatches(base, { ...preview, applied: true })).toThrow(/already applied/);
  });
});

describe("confirmed preview authority", () => {
  function activation(op: "enable" | "disable", extra: Partial<Parameters<typeof runPluginActivation>[0]> = {}) {
    return runPluginActivation({
      op,
      plugins: ["foo"],
      agents: ["claude-code"],
      apply: true,
      ...extra,
    });
  }

  async function noMutationCommands(): Promise<boolean> {
    const lines = await readInvocations();
    return lines.filter((l) => /plugin (enable|disable)/.test(l)).length === 0;
  }

  test("apply replays the confirmed plan exactly when native state still matches", async () => {
    await writeClaudeState([{ id: "foo@mkt", enabled: false, scope: "user" }]);
    await installFakeClaude({
      flipWith: await writeFlipFile([{ id: "foo@mkt", enabled: true, scope: "user" }]),
    });
    const preview = await runPluginActivation({
      op: "enable",
      plugins: ["foo"],
      agents: ["claude-code"],
      apply: false,
    });
    expect(preview.targets[0]!.plannedCommand).toBeDefined();
    const applied = await activation("enable", { confirmedPreview: preview });
    expect(applied.results![0]).toMatchObject({ agent: "claude-code", target: "foo@mkt", status: "enabled" });
    expect(applied.results![0]!.planned).toBeUndefined();
    // The executed command is exactly the argv the confirmed preview displayed.
    const expected = preview.targets[0]!.plannedCommand!.join(" ");
    expect((await readInvocations()).some((l) => l.trim() === expected)).toBe(true);
  });

  test("Claude scope drift (user→project) after confirmation fails with zero mutation commands", async () => {
    await writeClaudeState([{ id: "foo@mkt", enabled: false, scope: "user" }]);
    await installFakeClaude();
    const preview = await runPluginActivation({
      op: "enable",
      plugins: ["foo"],
      agents: ["claude-code"],
      apply: false,
    });
    await writeClaudeState([{ id: "foo@mkt", enabled: false, scope: "project" }]);
    const applied = await activation("enable", { confirmedPreview: preview });
    expect(applied.results).toHaveLength(1);
    expect(applied.results![0]).toMatchObject({ agent: "claude-code", status: "failed" });
    expect(applied.results![0]!.message).toMatch(/preview was confirmed/);
    expect(await noMutationCommands()).toBe(true);
  });

  test("qualified marketplace drift (mktA→mktB) after confirmation fails with zero mutation commands", async () => {
    await writeClaudeState([{ id: "foo@mktA", enabled: false }]);
    await installFakeClaude();
    const preview = await runPluginActivation({
      op: "enable",
      plugins: ["foo@mktA"],
      agents: ["claude-code"],
      apply: false,
    });
    // The record moved to another marketplace before apply.
    await writeClaudeState([{ id: "foo@mktB", enabled: false }]);
    const applied = await activation("enable", { plugins: ["foo@mktA"], confirmedPreview: preview });
    expect(applied.results![0]).toMatchObject({ agent: "claude-code", status: "failed" });
    expect(applied.results![0]!.message).toMatch(/preview was confirmed/);
    expect(await noMutationCommands()).toBe(true);
  });

  test("a bare record disappearing after confirmation fails instead of reporting clean absence", async () => {
    await writeClaudeState([{ id: "foo@mkt", enabled: false }]);
    await installFakeClaude();
    const preview = await runPluginActivation({
      op: "enable",
      plugins: ["foo"],
      agents: ["claude-code"],
      apply: false,
    });
    await writeClaudeState([{ id: "other@elsewhere", enabled: true }]);
    const applied = await activation("enable", { confirmedPreview: preview });
    expect(applied.results!.some((r) => r.status === "failed")).toBe(true);
    expect(applied.results!.some((r) => r.status === "failed" && /preview was confirmed/.test(r.message ?? ""))).toBe(
      true,
    );
    // Never a clean "absent": the disappearance must be surfaced as drift.
    expect(applied.results!.some((r) => r.status === "absent")).toBe(false);
    expect(await noMutationCommands()).toBe(true);
  });

  test("a record that became ambiguous after confirmation fails without mutating", async () => {
    await writeClaudeState([{ id: "foo@mkt", enabled: false, scope: "user" }]);
    await installFakeClaude();
    const preview = await runPluginActivation({
      op: "enable",
      plugins: ["foo"],
      agents: ["claude-code"],
      apply: false,
    });
    await writeClaudeState([
      { id: "foo@mkt", enabled: false, scope: "user" },
      { id: "foo@mkt", enabled: false, scope: "project" },
    ]);
    const applied = await activation("enable", { confirmedPreview: preview });
    expect(applied.results![0]).toMatchObject({ agent: "claude-code", status: "failed" });
    expect(await noMutationCommands()).toBe(true);
  });

  test("prior observed state flipped after confirmation refuses to run the command", async () => {
    await writeClaudeState([{ id: "foo@mkt", enabled: false }]);
    await installFakeClaude();
    const preview = await runPluginActivation({
      op: "enable",
      plugins: ["foo"],
      agents: ["claude-code"],
      apply: false,
    });
    // Something else enabled the plugin between confirm and apply.
    await writeClaudeState([{ id: "foo@mkt", enabled: true }]);
    const applied = await activation("enable", { confirmedPreview: preview });
    expect(applied.results![0]).toMatchObject({ agent: "claude-code", status: "failed" });
    expect(applied.results![0]!.message).toMatch(/state changed since the preview was confirmed/);
    expect(await noMutationCommands()).toBe(true);
  });

  test("confirmation integrity: a tampered planned argv fails before mutation even when identity and state match", async () => {
    await writeClaudeState([{ id: "foo@mkt", enabled: false, scope: "user" }]);
    await installFakeClaude({
      flipWith: await writeFlipFile([{ id: "foo@mkt", enabled: true, scope: "user" }]),
    });
    const preview = await runPluginActivation({
      op: "enable",
      plugins: ["foo"],
      agents: ["claude-code"],
      apply: false,
    });
    const tampered = {
      ...preview,
      targets: preview.targets.map((t) => ({
        ...t,
        plannedCommand: ["claude", "plugin", "enable", "--scope", "project", "--", "foo@mkt"],
      })),
    };
    const applied = await activation("enable", { confirmedPreview: tampered });
    expect(applied.results![0]).toMatchObject({ agent: "claude-code", status: "failed" });
    expect(applied.results![0]!.message).toMatch(/planned command changed since the preview was confirmed/);
    expect(await noMutationCommands()).toBe(true);
  });

  test("one drifted target refuses mutation for the WHOLE confirmed multi-target plan", async () => {
    await writeClaudeState([
      { id: "foo@mkt", enabled: false, scope: "user" },
      { id: "bar@mkt", enabled: false, scope: "user" },
    ]);
    await installFakeClaude({
      flipWith: await writeFlipFile([
        { id: "foo@mkt", enabled: true, scope: "user" },
        { id: "bar@mkt", enabled: true, scope: "user" },
      ]),
    });
    const preview = await runPluginActivation({
      op: "enable",
      plugins: ["foo", "bar"],
      agents: ["claude-code"],
      apply: false,
    });
    expect(preview.targets).toHaveLength(2);
    // foo moves scope after confirmation; bar's record is untouched and
    // would otherwise mutate cleanly.
    await writeClaudeState([
      { id: "foo@mkt", enabled: false, scope: "project" },
      { id: "bar@mkt", enabled: false, scope: "user" },
    ]);
    const applied = await activation("enable", {
      plugins: ["foo", "bar"],
      confirmedPreview: preview,
    });
    expect(applied.results!.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(applied.results!.some((r) => /preview was confirmed/.test(r.message ?? ""))).toBe(true);
    expect(applied.results!.some((r) => /nothing was mutated/.test(r.message ?? ""))).toBe(true);
    // Globally zero mutation commands — bar pays for foo's drift.
    expect(await noMutationCommands()).toBe(true);
  });

  test("Grok marketplace overlap appearing after confirmation must not mutate", async () => {
    const pluginDir = join(workDir, "grok-plugins", "foo");
    await mkdir(pluginDir, { recursive: true });
    await installFakeGrok([{ name: "foo" }], { startDisabled: true });
    const preview = await runPluginActivation({
      op: "enable",
      plugins: ["foo"],
      agents: ["grok-build"],
      apply: false,
    });
    expect(preview.targets[0]!.refusal).toBeUndefined();
    // An m2 copy of foo appears between confirm and apply.
    await writeFile(
      join(workDir, "grok-list.json"),
      grokListJson([
        { name: "foo", marketplace: "m1" },
        { name: "foo", marketplace: "m2" },
      ], pluginDir),
    );
    const applied = await runPluginActivation({
      op: "enable",
      plugins: ["foo"],
      agents: ["grok-build"],
      apply: true,
      confirmedPreview: preview,
    });
    expect(applied.results![0]).toMatchObject({ agent: "grok-build", status: "failed" });
    expect((await readInvocations()).some((l) => l.trim() === "grok plugin enable foo")).toBe(false);
  });
});
