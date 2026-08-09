import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLUGIN_TARGET_AGENTS,
  SKILL_ONLY_AGENTS,
  addArgs,
  addSkillRepos,
  addSkillsFromPlugins,
  installedAddArgs,
  mcpCohort,
  removeArgs,
  resolvePluginSkillSources,
  skillAgentIdToCliId,
  skillAgentLabelToId,
  skillCohort,
} from "../src/skills.ts";

let workDir: string;
let originalHome: string | undefined;
let originalPath: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-skills-"));
  originalHome = process.env.HOME;
  originalPath = process.env.PATH;
  process.env.HOME = workDir;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  await rm(workDir, { recursive: true, force: true });
});

type Entry = { source?: { source?: string; repo?: string }; installLocation?: string };

// Write known_marketplaces.json and materialize each marketplace's installLocation
// (with skills/<name>/SKILL.md when withSkills; defaults to one skill "x") so
// resolvePluginSkillSources can filter and the guard can enumerate skill names.
async function writeMarketplaces(entries: Record<string, Entry & { withSkills?: boolean; skills?: string[] }>) {
  const dir = join(workDir, ".claude", "plugins");
  await mkdir(dir, { recursive: true });
  const json: Record<string, Entry> = {};
  for (const [name, e] of Object.entries(entries)) {
    json[name] = { source: e.source, installLocation: e.installLocation };
    if (e.installLocation && e.withSkills) {
      for (const skill of e.skills ?? ["x"]) {
        await mkdir(join(e.installLocation, "skills", skill), { recursive: true });
        await writeFile(join(e.installLocation, "skills", skill, "SKILL.md"), `---\nname: ${skill}\n---\n`);
      }
    } else if (e.installLocation) {
      await mkdir(e.installLocation, { recursive: true });
    }
  }
  await writeFile(join(dir, "known_marketplaces.json"), JSON.stringify(json, null, 2));
}

// Fake `npx`: `skills list` returns listJson (default empty); any other call (i.e.
// `skills add`) honors exit/stderr. Lets tests drive the already-synced guard.
async function installFakeNpx(opts: { exit?: number; stderr?: string; stdout?: string; listJson?: string } = {}) {
  const binDir = join(workDir, "bin");
  await mkdir(binDir, { recursive: true });
  const log = join(workDir, "invocations.log");
  const script = `#!/bin/sh
echo "npx $@" >> ${log}
if [ "$2 $3" = "skills list" ]; then echo '${opts.listJson ?? "[]"}'; exit 0; fi
${opts.stdout ? `echo "${opts.stdout}"` : ""}
${opts.stderr ? `echo "${opts.stderr}" >&2` : ""}
exit ${opts.exit ?? 0}
`;
  const p = join(binDir, "npx");
  await writeFile(p, script);
  await chmod(p, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

async function readInvocations(): Promise<string[]> {
  try {
    return (await readFile(join(workDir, "invocations.log"), "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("mcpCohort / skillCohort", () => {
  test("mcpCohort = non-plugin MCP adapters (excludes plugin + skill-only agents)", () => {
    const cohort = mcpCohort();
    for (const a of PLUGIN_TARGET_AGENTS) expect(cohort).not.toContain(a);
    for (const a of SKILL_ONLY_AGENTS) expect(cohort).not.toContain(a);
    expect(cohort).toContain("opencode");
    expect(cohort).toContain("goose");
    expect(cohort.length).toBe(9);
  });

  test("skillCohort = mcpCohort plus skills-only agents (pi, cline)", () => {
    const cohort = skillCohort();
    for (const a of PLUGIN_TARGET_AGENTS) expect(cohort).not.toContain(a);
    expect(cohort).toContain("pi");
    expect(cohort).toContain("cline");
    expect(cohort).toContain("goose");
    expect(cohort).toContain("gemini-cli");
    expect(cohort.length).toBe(11);
  });
});

describe("addArgs", () => {
  test("builds `skills add <repo> -g -s * -a <agent>... -y`", () => {
    expect(addArgs("owner/repo", ["opencode", "gemini-cli"])).toEqual([
      "-y", "skills", "add", "owner/repo", "-g", "-s", "*", "-a", "opencode", "-a", "gemini-cli", "-y",
    ]);
  });

  test("translates syncthis agent ids to upstream skills CLI ids", () => {
    expect(skillAgentIdToCliId("kimi-cli")).toBe("kimi-code-cli");
    expect(skillAgentIdToCliId("pi")).toBe("universal");
    expect(skillAgentIdToCliId("cline")).toBe("universal");
    expect(skillAgentLabelToId("Kimi Code CLI")).toBe("kimi-cli");
    expect(skillAgentLabelToId("Cline")).toBe("cline");
    expect(skillAgentLabelToId("Antigravity")).toBe("antigravity");
    expect(skillAgentLabelToId("Antigravity CLI")).toBeUndefined();
    expect(addArgs("owner/repo", ["kimi-cli", "opencode"])).toEqual([
      "-y", "skills", "add", "owner/repo", "-g", "-s", "*", "-a", "kimi-code-cli", "-a", "opencode", "-y",
    ]);
    expect(installedAddArgs("/store/alpha", "alpha", ["kimi-cli"])).toEqual([
      "-y", "skills", "add", "/store/alpha", "-g", "-s", "alpha", "-a", "kimi-code-cli", "-y",
    ]);
    expect(removeArgs(["alpha"], ["kimi-cli", "opencode"])).toEqual([
      "-y", "skills", "remove", "-g", "-a", "kimi-code-cli", "-a", "opencode", "-s", "alpha", "-y",
    ]);
  });

  test("dedupes Pi and Cline's shared universal target", () => {
    expect(addArgs("owner/repo", ["pi", "cline"])).toEqual([
      "-y", "skills", "add", "owner/repo", "-g", "-s", "*", "-a", "universal", "-y",
    ]);
    expect(installedAddArgs("/store/alpha", "alpha", ["pi", "cline"])).toEqual([
      "-y", "skills", "add", "/store/alpha", "-g", "-s", "alpha", "-a", "universal", "-y",
    ]);
    expect(removeArgs(["alpha"], ["pi", "cline"])).toEqual([
      "-y", "skills", "remove", "-g", "-a", "universal", "-s", "alpha", "-y",
    ]);
  });
});

describe("addSkillRepos", () => {
  test("dedups, sorts, drops unsafe slugs, and dry-runs without shelling out", async () => {
    const r = await addSkillRepos(["b/two", "a/one", "b/two", "../evil"], ["codex"], { dryRun: true });
    expect(r).toEqual([
      { repo: "a/one", status: "added", message: "dry-run" },
      { repo: "b/two", status: "added", message: "dry-run" },
    ]);
    expect(await readInvocations()).toEqual([]);
  });

  test("shells `npx skills add <repo> -a <agent>` for the given agent", async () => {
    await installFakeNpx({ exit: 0 });
    const r = await addSkillRepos(["owner/kit"], ["codex"]);
    expect(r).toEqual([{ repo: "owner/kit", status: "added" }]);
    const inv = await readInvocations();
    expect(inv.some((l) => l.trim() === "npx -y skills add owner/kit -g -s * -a codex -y")).toBe(true);
  });

  test("uses the upstream Kimi target id so one invalid agent does not poison the whole add", async () => {
    await installFakeNpx({ exit: 0 });
    const r = await addSkillRepos(["owner/kit"], ["kimi-cli", "opencode"]);
    expect(r).toEqual([{ repo: "owner/kit", status: "added" }]);
    const inv = await readInvocations();
    expect(inv.some((l) => l.trim() === "npx -y skills add owner/kit -g -s * -a kimi-code-cli -a opencode -y")).toBe(true);
    expect(inv.some((l) => l.includes("-a kimi-cli"))).toBe(false);
  });

  test("a genuine non-zero exit is reported as failed (mirror counts it, exits non-zero)", async () => {
    await installFakeNpx({ exit: 2, stderr: "network unreachable" });
    const r = await addSkillRepos(["owner/kit"], ["codex"]);
    expect(r[0]!.status).toBe("failed");
    expect(r[0]!.message).toContain("network unreachable");
  });

  test("a no-skills bundle exit is a benign skip, not a failure", async () => {
    await installFakeNpx({ exit: 1, stderr: "No skills found in repository" });
    const r = await addSkillRepos(["owner/kit"], ["codex"]);
    expect(r[0]!.status).toBe("skipped");
  });
});

describe("resolvePluginSkillSources", () => {
  test("keeps github + has-skills, drops the rest, dedupes, sorts", async () => {
    await writeMarketplaces({
      a: { source: { source: "github", repo: "owner/a" }, installLocation: join(workDir, "mp", "a"), withSkills: true },
      b: { source: { source: "github", repo: "owner/b" }, installLocation: join(workDir, "mp", "b"), withSkills: true },
      // no skills on disk → excluded
      c: { source: { source: "github", repo: "owner/c" }, installLocation: join(workDir, "mp", "c"), withSkills: false },
      // not a github source → excluded
      d: { source: { source: "local", repo: "owner/d" }, installLocation: join(workDir, "mp", "d"), withSkills: true },
      // unsafe slug (flag/path injection) → excluded
      e: { source: { source: "github", repo: "../evil" }, installLocation: join(workDir, "mp", "e"), withSkills: true },
      // duplicate repo of `a` → deduped
      f: { source: { source: "github", repo: "owner/a" }, installLocation: join(workDir, "mp", "f"), withSkills: true },
    });
    const sources = await resolvePluginSkillSources();
    expect(sources.map((s) => s.repo)).toEqual(["owner/a", "owner/b"]);
  });

  test("returns [] when known_marketplaces.json is absent", async () => {
    expect(await resolvePluginSkillSources()).toEqual([]);
  });

  test("tolerates a malformed known_marketplaces.json instead of crashing sync", async () => {
    const p = join(workDir, ".claude", "plugins", "known_marketplaces.json");
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, "{ this is not: valid json ,,, ");
    // Must not throw — a broken Claude file can't be allowed to crash the whole run.
    expect(await resolvePluginSkillSources()).toEqual([]);
  });
});

describe("addSkillsFromPlugins", () => {
  test("dry-run resolves sources and never invokes `skills add`", async () => {
    await writeMarketplaces({
      a: { source: { source: "github", repo: "owner/a" }, installLocation: join(workDir, "mp", "a"), withSkills: true },
    });
    await installFakeNpx({ listJson: "[]" }); // nothing installed yet
    const r = await addSkillsFromPlugins({ dryRun: true });
    expect(r.ran).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.results).toEqual([{ repo: "owner/a", status: "added", message: "dry-run" }]);
    expect(r.agents.length).toBe(11);
    const inv = await readInvocations();
    expect(inv.some((l) => /skills add/.test(l))).toBe(false);
  });

  test("skips a repo whose every skill is already installed on the requested agents", async () => {
    await writeMarketplaces({
      a: {
        source: { source: "github", repo: "owner/a" },
        installLocation: join(workDir, "mp", "a"),
        withSkills: true,
        skills: ["x", "y"],
      },
    });
    await installFakeNpx({ listJson: '[{"name":"x","agents":["OpenCode"]},{"name":"y","agents":["OpenCode"]}]' });
    const r = await addSkillsFromPlugins({ agents: ["opencode"] });
    expect(r.results).toEqual([{ repo: "owner/a", status: "skipped", message: "already synced" }]);
    const inv = await readInvocations();
    expect(inv.some((l) => /skills add/.test(l))).toBe(false);
  });

  test("adds a repo when its skills exist globally but are missing from the requested agent", async () => {
    await writeMarketplaces({
      a: {
        source: { source: "github", repo: "owner/a" },
        installLocation: join(workDir, "mp", "a"),
        withSkills: true,
        skills: ["x"],
      },
    });
    await installFakeNpx({ listJson: '[{"name":"x","agents":["Windsurf"]}]' });
    const r = await addSkillsFromPlugins({ agents: ["opencode"] });
    expect(r.results).toEqual([{ repo: "owner/a", status: "added" }]);
    const inv = await readInvocations();
    expect(inv.some((l) => /npx -y skills add owner\/a .* -a opencode -y/.test(l))).toBe(true);
  });

  test("force mode adds plugin skills even when the per-agent guard would skip", async () => {
    await writeMarketplaces({
      a: {
        source: { source: "github", repo: "owner/a" },
        installLocation: join(workDir, "mp", "a"),
        withSkills: true,
        skills: ["x"],
      },
    });
    await installFakeNpx({ listJson: '[{"name":"x","agents":["OpenCode"]}]' });
    const r = await addSkillsFromPlugins({ agents: ["opencode"], force: true });
    expect(r.results).toEqual([{ repo: "owner/a", status: "added" }]);
    const inv = await readInvocations();
    expect(inv.some((l) => /npx -y skills add owner\/a .* -a opencode -y/.test(l))).toBe(true);
  });

  test("preserves mixed skip/add results while scanning repo skills in parallel", async () => {
    await writeMarketplaces({
      a: {
        source: { source: "github", repo: "owner/a" },
        installLocation: join(workDir, "mp", "a"),
        withSkills: true,
        skills: ["x"],
      },
      b: {
        source: { source: "github", repo: "owner/b" },
        installLocation: join(workDir, "mp", "b"),
        withSkills: true,
        skills: ["y"],
      },
    });
    await installFakeNpx({ listJson: '[{"name":"x","agents":["OpenCode"]}]' });
    const r = await addSkillsFromPlugins({ agents: ["opencode"] });
    expect(r.results).toEqual([
      { repo: "owner/a", status: "skipped", message: "already synced" },
      { repo: "owner/b", status: "added" },
    ]);
    const inv = await readInvocations();
    expect(inv.some((l) => /skills add owner\/a/.test(l))).toBe(false);
    expect(inv.some((l) => /skills add owner\/b/.test(l))).toBe(true);
  });

  test("guard walks category-nested skills and keys on frontmatter name", async () => {
    // forsvn-com/skills-style layout: skills/<category>/<skill>/SKILL.md, and the
    // frontmatter name differs from the dir name. The guard must enumerate the
    // nested leaf and match `real-name` (what `npx skills list` reports), not `leaf`.
    const loc = join(workDir, "mp", "a");
    await mkdir(join(loc, "skills", "research", "leaf"), { recursive: true });
    await writeFile(join(loc, "skills", "research", "leaf", "SKILL.md"), "---\nname: real-name\ndescription: x\n---\n");
    const dir = join(workDir, ".claude", "plugins");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "known_marketplaces.json"),
      JSON.stringify({ a: { source: { source: "github", repo: "owner/a" }, installLocation: loc } }),
    );
    await installFakeNpx({ listJson: '[{"name":"real-name","agents":["OpenCode"]}]' });
    const r = await addSkillsFromPlugins({ agents: ["opencode"] });
    expect(r.results).toEqual([{ repo: "owner/a", status: "skipped", message: "already synced" }]);
    const inv = await readInvocations();
    expect(inv.some((l) => /skills add/.test(l))).toBe(false);
  });

  test("adds a repo when only some of its skills are present", async () => {
    await writeMarketplaces({
      a: {
        source: { source: "github", repo: "owner/a" },
        installLocation: join(workDir, "mp", "a"),
        withSkills: true,
        skills: ["x", "y"],
      },
    });
    await installFakeNpx({ listJson: '[{"name":"x","agents":["OpenCode"]}]' }); // y still missing
    const r = await addSkillsFromPlugins({ agents: ["opencode"] });
    expect(r.results[0]!.status).toBe("added");
    const inv = await readInvocations();
    expect(inv.some((l) => /skills add owner\/a/.test(l))).toBe(true);
  });

  test("reports ran:false when there are no skill-bearing plugins", async () => {
    await writeMarketplaces({
      c: { source: { source: "github", repo: "owner/c" }, installLocation: join(workDir, "mp", "c"), withSkills: false },
    });
    const r = await addSkillsFromPlugins({});
    expect(r.ran).toBe(false);
    expect(r.message).toContain("no skill-bearing plugins");
  });

  test("invokes `npx skills add` per repo for the skill cohort and marks added", async () => {
    await writeMarketplaces({
      a: { source: { source: "github", repo: "owner/a" }, installLocation: join(workDir, "mp", "a"), withSkills: true },
    });
    await installFakeNpx({ exit: 0 });
    const r = await addSkillsFromPlugins({ agents: ["opencode", "gemini-cli"] });
    expect(r.results).toEqual([{ repo: "owner/a", status: "added" }]);
    const inv = await readInvocations();
    expect(inv.some((l) => l.trim() === "npx -y skills add owner/a -g -s * -a opencode -a gemini-cli -y")).toBe(true);
  });

  test("a no-skills exit is reported as skipped, not failed", async () => {
    await writeMarketplaces({
      a: { source: { source: "github", repo: "owner/a" }, installLocation: join(workDir, "mp", "a"), withSkills: true },
    });
    await installFakeNpx({ exit: 1, stderr: "No skills found in repository" });
    const r = await addSkillsFromPlugins({ agents: ["opencode"] });
    expect(r.results[0]!.status).toBe("skipped");
  });

  test("a genuine non-zero exit is reported as failed with the cause", async () => {
    await writeMarketplaces({
      a: { source: { source: "github", repo: "owner/a" }, installLocation: join(workDir, "mp", "a"), withSkills: true },
    });
    await installFakeNpx({ exit: 2, stderr: "network unreachable" });
    const r = await addSkillsFromPlugins({ agents: ["opencode"] });
    expect(r.results[0]!.status).toBe("failed");
    expect(r.results[0]!.message).toContain("network unreachable");
  });
});
