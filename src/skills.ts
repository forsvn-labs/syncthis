import { spawn } from "node:child_process";
import { mkdtemp, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { adapters } from "./adapters/index.ts";
import { expandHome, readJson } from "./io.ts";
import { isSafeRepoSlug, isSafeSkillName, pluginNamesOverlap, run } from "./plugins/shell.ts";
import type { AgentId } from "./types.ts";

// Agents that ALWAYS consume the open-plugin bundle natively in these flows.
// GitHub Copilot also has a native plugin ABI, but remains in the loose cohorts as
// a conditional fallback: add/mirror removes a plugin/repo only after that exact
// native install succeeds. Kimi has no proven non-interactive native plugin ABI and
// therefore remains an unconditional exact skills/MCP degradation target.
export const PLUGIN_TARGET_AGENTS: readonly AgentId[] = ["claude-code", "codex", "cursor", "grok-build"];

// Agents that support skills (vercel-labs/skills) but have NO native MCP config to
// sync, so they get no MCP adapter — they appear in the SKILL cohort only, never in
// MCP sync or the plugin→MCP decomposition. Pi, Cline, and Prime Agent ship
// without an Agent Plugin ABI here; all consume the universal ~/.agents/skills store.
export const SKILL_ONLY_AGENTS: readonly AgentId[] = ["pi", "cline", "prime-agent"];

// The MCP cohort: every MCP-syncable agent that is NOT plugin-capable. These are the
// targets for the plugin→MCP decomposition (the plugin cohort gets a plugin's MCP
// servers by installing the plugin). Derived from the adapter registry so it tracks
// new MCP adapters automatically.
export function mcpCohort(): AgentId[] {
  return adapters.map((a) => a.id).filter((id) => !PLUGIN_TARGET_AGENTS.includes(id));
}

// The skill cohort: every non-plugin agent that can receive skills via
// `npx skills add -a <agent>`. That's the MCP cohort plus skills-only agents (Pi,
// Cline, Prime Agent), since skills reach more agents than native MCP sync does.
export function skillCohort(): AgentId[] {
  return [...new Set([...mcpCohort(), ...SKILL_ONLY_AGENTS])];
}

const CLAUDE_MARKETPLACES = "~/.claude/plugins/known_marketplaces.json";
const SKILLS_ADD_TIMEOUT_MS = 180_000;
const SKILLS_LIST_TIMEOUT_MS = 60_000;

type KnownMarketplaces = Record<
  string,
  { source?: { source?: string; repo?: string }; installLocation?: string }
>;

export type PluginSkillSource = { marketplace: string; repo: string; installLocation: string };

export type SkillAddStatus = "added" | "skipped" | "failed";
export type SkillAddResult = { repo: string; status: SkillAddStatus; message?: string };

export type PluginSkillsReport = {
  ran: boolean;
  dryRun: boolean;
  agents: AgentId[];
  sources: PluginSkillSource[];
  results: SkillAddResult[];
  message?: string;
};

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

// A cloned marketplace carries skills if its working copy has a root SKILL.md or a
// skills/ dir. Cheap local check (no network) used to skip plugin/MCP-only
// marketplaces so we don't fire `npx skills add` at repos with nothing to add.
async function marketplaceHasSkills(installLocation: string): Promise<boolean> {
  return (await isFile(join(installLocation, "SKILL.md"))) || (await isDir(join(installLocation, "skills")));
}

// Resolve the GitHub source repos behind Claude's installed plugin marketplaces.
// These repos are the source set handed to `npx skills add`. Filtered to github
// sources that actually carry skills, slug-validated (defends the CLI invocation
// against an adversarial marketplace entry being read as a flag), and deduped.
export async function resolvePluginSkillSources(): Promise<PluginSkillSource[]> {
  // A malformed known_marketplaces.json must not crash the whole `sync` — readJson
  // throws on invalid JSON. Treat any read/parse failure as "no skill sources" and
  // continue; the skills pass is best-effort and additive.
  let data: KnownMarketplaces | null;
  try {
    data = await readJson<KnownMarketplaces>(expandHome(CLAUDE_MARKETPLACES));
  } catch {
    return [];
  }
  if (!data || typeof data !== "object") return [];
  const out: PluginSkillSource[] = [];
  const seen = new Set<string>();
  const candidates = await Promise.all(Object.entries(data).map(async ([marketplace, entry]) => {
    const repo = entry?.source?.repo;
    const installLocation = entry?.installLocation;
    if (!repo || entry?.source?.source !== "github" || !installLocation) return null;
    if (!isSafeRepoSlug(repo)) return null;
    if (!(await marketplaceHasSkills(installLocation))) return null;
    return { marketplace, repo, installLocation };
  }));
  for (const source of candidates) {
    if (!source || seen.has(source.repo)) continue;
    seen.add(source.repo);
    out.push(source);
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo));
}

// Source repos (owner/repo) that already have at least one plugin INSTALLED on a
// target, determined by matching the target's installed plugin names against each
// cloned marketplace's declared plugin entry names. A repo here is "covered": its
// skills are present via the installed plugin, so the mirror must NOT re-add them
// flat (`npx skills add`) — that would duplicate the plugin's namespaced skills.
// Name-based, so it works even when the target's canonical name differs from the
// primary's install id (the `github.com-*` re-run case). Best-effort: an unreadable
// known_marketplaces.json yields an empty set (no coverage claimed → safe default).
export async function resolveInstalledRepoCoverage(installedNames: Set<string>): Promise<Set<string>> {
  const covered = new Set<string>();
  let data: KnownMarketplaces | null;
  try {
    data = await readJson<KnownMarketplaces>(expandHome(CLAUDE_MARKETPLACES));
  } catch {
    return covered;
  }
  if (!data || typeof data !== "object") return covered;
  const candidates = await Promise.all(Object.values(data).map(async (entry) => {
    const repo = entry?.source?.repo;
    const installLocation = entry?.installLocation;
    if (!repo || entry?.source?.source !== "github" || !installLocation) return null;
    if (!isSafeRepoSlug(repo)) return null;
    const names = await marketplacePluginNames(installLocation);
    return names.some((n) => [...installedNames].some((installed) => pluginNamesOverlap(installed, n))) ? repo : null;
  }));
  for (const repo of candidates) {
    if (repo) covered.add(repo);
  }
  return covered;
}

// The plugin entry names a cloned marketplace declares in its marketplace.json.
// These are the names a plugin agent installs under — which, for a multi-plugin
// marketplace, differ from the Claude-side install id (e.g. Claude's URL-named
// `github.com-garrytan-gstack` vs the entry `gstack`). Used to map a target's
// installed plugin back to its source repo even across that name difference.
async function marketplacePluginNames(installLocation: string): Promise<string[]> {
  for (const rel of [".claude-plugin/marketplace.json", "marketplace.json"]) {
    try {
      const data = await readJson<{ plugins?: Array<{ name?: unknown }> }>(join(installLocation, rel));
      const plugins = data?.plugins;
      if (Array.isArray(plugins)) {
        return plugins.map((p) => p?.name).filter((n): n is string => typeof n === "string");
      }
    } catch {
      /* try the next candidate path */
    }
  }
  return [];
}

// The skills CLI reports each skill's agents by human display label ("Hermes
// Agent", "Gemini CLI", "GitHub Copilot"), not by syncthis AgentId. Map the labels
// syncthis knows; an unknown label (e.g. "Warp", which has no MCP adapter) resolves
// to undefined and is dropped. Lowercased keys so casing/spacing variance is moot.
const SKILL_AGENT_LABELS: Record<string, AgentId> = {
  "claude code": "claude-code",
  cursor: "cursor",
  codex: "codex",
  "gemini cli": "gemini-cli",
  gemini: "gemini-cli",
  "kimi cli": "kimi-cli",
  "kimi code cli": "kimi-cli",
  kimi: "kimi-cli",
  antigravity: "antigravity",
  "github copilot": "github-copilot",
  "github copilot cli": "github-copilot",
  windsurf: "windsurf",
  opencode: "opencode",
  openclaw: "openclaw",
  "hermes agent": "hermes-agent",
  hermes: "hermes-agent",
  goose: "goose",
  pi: "pi",
  cline: "cline",
  "cline cli": "cline",
  "prime agent": "prime-agent",
  prime: "prime-agent",
};

export function skillAgentLabelToId(label: string): AgentId | undefined {
  return SKILL_AGENT_LABELS[label.trim().toLowerCase()];
}

const SKILL_AGENT_CLI_IDS: Partial<Record<AgentId, string>> = {
  // Syncthis' MCP adapter id is `kimi-cli`, but vercel-labs/skills names the
  // same target `kimi-code-cli`. Passing `kimi-cli` makes the upstream CLI reject
  // the whole multi-agent add/remove invocation, so translate only at the process
  // boundary and keep syncthis' public agent id stable.
  "kimi-cli": "kimi-code-cli",
  pi: "universal",
  cline: "universal",
  "prime-agent": "universal",
};

export function skillAgentIdToCliId(agent: AgentId): string {
  return SKILL_AGENT_CLI_IDS[agent] ?? agent;
}

function uniqueSkillAgentCliIds(agents: readonly AgentId[]): string[] {
  return [...new Set(agents.map(skillAgentIdToCliId))];
}

// `path` is the skill's location in the shared store (~/.agents/skills/<name>) — a
// self-contained skill dir usable as a `npx skills add <path>` source to surface the
// same skill onto another agent (the store is shared; per-agent dirs are symlinks).
export type InstalledSkill = { name: string; path: string; agents: AgentId[] };

async function readInstalledSkillsJson(): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "syncthis-skills-list-"));
  const outPath = join(dir, "skills.json");
  const fh = await open(outPath, "w", 0o600);
  try {
    const res = await new Promise<{ ok: boolean }>((resolve) => {
      let timedOut = false;
      let settled = false;
      const child = spawn("npx", ["-y", "skills", "list", "-g", "--json"], {
        stdio: ["ignore", fh.fd, "ignore"],
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, SKILLS_LIST_TIMEOUT_MS);
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok });
      };
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0 && !timedOut));
    });
    await fh.close();
    if (!res.ok) return null;
    return await readFile(outPath, "utf8");
  } finally {
    await fh.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Every globally-installed skill with the agents it's registered on, from
// `npx skills list -g --json`. Returns null when the CLI can't be read (missing
// npx, bad JSON) so callers can distinguish "couldn't read" from "no skills".
export async function listInstalledSkills(): Promise<InstalledSkill[] | null> {
  const json = await readInstalledSkillsJson();
  if (json === null) return null;
  try {
    const arr = JSON.parse(json || "[]");
    if (!Array.isArray(arr)) return null;
    return (arr as Array<{ name?: unknown; path?: unknown; agents?: unknown }>)
      .map((s) => ({
        name: typeof s?.name === "string" ? s.name : "",
        path: typeof s?.path === "string" ? s.path : "",
        agents: Array.isArray(s?.agents)
          ? (s.agents as unknown[])
              .map((a) => (typeof a === "string" ? skillAgentLabelToId(a) : undefined))
              .filter((a): a is AgentId => !!a)
          : [],
      }))
      .filter((s) => s.name)
      .map((s) => ({ ...s, agents: [...new Set(s.agents)] }));
  } catch {
    return null;
  }
}

async function installedSkillAgentsByName(): Promise<Map<string, Set<AgentId>>> {
  const installed = await listInstalledSkills();
  const map = new Map<string, Set<AgentId>>();
  if (!installed) return map;
  for (const skill of installed) {
    const agents = map.get(skill.name) ?? new Set<AgentId>();
    for (const agent of skill.agents) agents.add(agent);
    map.set(skill.name, agents);
  }
  return map;
}

export type PluginDerivedSkills = { repo: string; marketplace: string; names: string[] };

// The skill identities contributed by each of Claude's skill-bearing plugin
// marketplaces. This is the "plugins, expressed as skills" set the overview matches
// against `npx skills list`. `names` carries BOTH the frontmatter name and the leaf
// dir slug per skill (via pluginSkillIdentities) — the same identity resolution the
// removal path uses — so a skill whose frontmatter name differs from its install slug
// is still matched and shown, not under-reported. Local-only (no network).
export async function resolvePluginDerivedSkills(): Promise<PluginDerivedSkills[]> {
  const sources = await resolvePluginSkillSources();
  return Promise.all(
    sources.map(async (s) => ({
      repo: s.repo,
      marketplace: s.marketplace,
      names: await pluginSkillIdentities(s.installLocation),
    })),
  );
}

// The skill names a marketplace clone provides. Walks the `skills/` subtree (and a
// root-level SKILL.md) for every SKILL.md, since real marketplaces nest by category
// (`skills/<category>/<skill>/SKILL.md`) as well as flat (`skills/<skill>/`). Keys
// on each skill's frontmatter `name` — what `npx skills list` reports — falling back
// to the directory name. Returns null when no SKILL.md is found, so the caller never
// skips a repo it can't account for.
export async function repoSkillNames(installLocation: string): Promise<string[] | null> {
  const files: string[] = [];
  await collectSkillMd(join(installLocation, "skills"), files, 3);
  if (await isFile(join(installLocation, "SKILL.md"))) files.push(join(installLocation, "SKILL.md"));
  if (files.length === 0) return null;
  return Promise.all(files.map(skillName));
}

// Candidate install identities for the skills a plugin bundles: for every SKILL.md
// leaf, BOTH its frontmatter `name` and its leaf directory name (the install slug).
// `npx skills list`/`remove` key on one identity; the two normally agree, but a
// title-cased frontmatter name with a kebab install dir would otherwise be shown yet
// never removed. Returning both lets a caller match whichever the CLI uses. Deduped;
// empty when the install dir has no SKILL.md.
export async function pluginSkillIdentities(installLocation: string): Promise<string[]> {
  const files: string[] = [];
  await collectSkillMd(join(installLocation, "skills"), files, 3);
  if (await isFile(join(installLocation, "SKILL.md"))) files.push(join(installLocation, "SKILL.md"));
  const ids = new Set<string>();
  for (const f of files) {
    ids.add(await skillName(f)); // frontmatter name (falls back to dir name)
    ids.add(basename(dirname(f))); // leaf dir name = install slug
  }
  return [...ids];
}

// Collect SKILL.md paths under `dir`. A directory containing SKILL.md is a skill leaf
// — record it and don't descend into its support files. Depth-bounded as a backstop.
async function collectSkillMd(dir: string, out: string[], depth: number): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    out.push(join(dir, "SKILL.md"));
    return;
  }
  if (depth <= 0) return;
  for (const e of entries) {
    if (e.isDirectory()) await collectSkillMd(join(dir, e.name), out, depth - 1);
  }
}

// A skill's name = its SKILL.md frontmatter `name` (matches `npx skills list`);
// fall back to the containing directory name if the frontmatter can't be read.
async function skillName(skillMdPath: string): Promise<string> {
  try {
    const text = await readFile(skillMdPath, "utf8");
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    // Capture the whole value then strip matching surrounding quotes, so names
    // containing spaces or punctuation (e.g. `name: "My Skill"`) aren't truncated
    // — a truncated name would never match `npx skills list`, defeating the skip.
    const raw = fm?.[1]?.match(/^name:[ \t]*(.+?)[ \t]*$/m)?.[1];
    const nm = raw?.replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
    if (nm) return nm;
  } catch {
    /* fall through to dir name */
  }
  return basename(dirname(skillMdPath));
}

// `npx skills add <repo> -g -s '*' -a <agent>... -y` — install every skill the
// repo provides, globally, into each named agent, non-interactively.
export function addArgs(repo: string, agents: readonly AgentId[]): string[] {
  const args = ["-y", "skills", "add", repo, "-g", "-s", "*"];
  for (const target of uniqueSkillAgentCliIds(agents)) args.push("-a", target);
  args.push("-y");
  return args;
}

// Run one `npx skills add …` invocation. `key` is the value reported back as
// `repo` (a source repo for repo-adds, or a skill name for installed-skill shares).
function runSkillAdd(args: string[], key: string): Promise<SkillAddResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn("npx", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SKILLS_ADD_TIMEOUT_MS);
    // 'error' (spawn failure) and 'close' can both fire — settle exactly once.
    const finish = (r: SkillAddResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (err: Error) => finish({ repo: key, status: "failed", message: err.message }));
    child.on("close", (code) => {
      if (timedOut) return finish({ repo: key, status: "failed", message: `timed out after ${SKILLS_ADD_TIMEOUT_MS / 1000}s` });
      if (code === 0) return finish({ repo: key, status: "added" });
      const blob = `${stdout}\n${stderr}`;
      const tail = stderr.trim().split("\n").pop() || stdout.trim().split("\n").pop() || "";
      // The skills CLI exits non-zero when a source has no installable skills. That's
      // not a failure for us — the pre-filter should avoid it, but tolerate it.
      if (/no skills?\b|no SKILL\.md|nothing to (install|add)/i.test(blob)) {
        return finish({ repo: key, status: "skipped", message: "no skills found" });
      }
      finish({ repo: key, status: "failed", message: `exit ${code}: ${tail}` });
    });
  });
}

function addOne(repo: string, agents: readonly AgentId[]): Promise<SkillAddResult> {
  return runSkillAdd(addArgs(repo, agents), repo);
}

// `npx skills add <storePath> -g -s <name> -a <agent>… -y` — surface a single
// already-installed skill (sourced from its shared-store dir) onto more agents.
export function installedAddArgs(storePath: string, name: string, agents: readonly AgentId[]): string[] {
  const args = ["-y", "skills", "add", storePath, "-g", "-s", name];
  for (const target of uniqueSkillAgentCliIds(agents)) args.push("-a", target);
  args.push("-y");
  return args;
}

export type InstalledSkillRef = { name: string; path: string };

// Share already-installed skills (from the shared store) onto a set of agents — the
// interactive "bring this agent's skills to those agents" flow. The store is global,
// so this just adds the agent symlinks; the source agent is irrelevant to the
// mechanism. One `npx skills add <path>` per skill, sequentially (concurrent invocations
// race on the shared agent skill directories). Skips a skill with an unsafe name or no
// resolvable store path rather than shelling out blindly.
export async function addInstalledSkillsToAgents(
  skills: InstalledSkillRef[],
  agents: readonly AgentId[],
  opts: { dryRun?: boolean } = {},
): Promise<SkillAddResult[]> {
  const out: SkillAddResult[] = [];
  if (agents.length === 0) return out;
  for (const sk of skills) {
    if (!isSafeSkillName(sk.name) || !sk.path) {
      out.push({ repo: sk.name, status: "failed", message: sk.path ? "unsafe skill name" : "no store path" });
      continue;
    }
    if (opts.dryRun) {
      out.push({ repo: sk.name, status: "added", message: "dry-run" });
      continue;
    }
    out.push(await runSkillAdd(installedAddArgs(sk.path, sk.name, agents), sk.name));
  }
  return out;
}

// Install specific source repos as loose skills into specific agents. Used by the
// plugin mirror's Codex skills-fallback: when Codex can't load a skills-only bundle
// as a plugin, its skills are still added here. Repos are deduped, sorted, and
// slug-validated (an unsafe slug could be read as a flag by the skills CLI). One
// `npx skills add` per repo, sequentially — concurrent invocations race on the
// shared agent skill directories.
export async function addSkillRepos(
  repos: string[],
  agents: readonly AgentId[],
  opts: { dryRun?: boolean } = {},
): Promise<SkillAddResult[]> {
  const unique = [...new Set(repos)].filter((r) => isSafeRepoSlug(r)).sort();
  const out: SkillAddResult[] = [];
  for (const repo of unique) {
    if (opts.dryRun) {
      out.push({ repo, status: "added", message: "dry-run" });
      continue;
    }
    out.push(await addOne(repo, agents));
  }
  return out;
}

// Install skills from exact, caller-validated sources. Repository slugs keep the
// existing network path; absolute paths support inspected local plugin artifacts
// without broadening addSkillRepos' public repo-only safety contract.
export async function addSkillSources(
  sources: string[],
  agents: readonly AgentId[],
  opts: { dryRun?: boolean } = {},
): Promise<SkillAddResult[]> {
  const unique = [
    ...new Set(sources.filter((source) => isSafeRepoSlug(source) || isAbsolute(source))),
  ].sort();
  const out: SkillAddResult[] = [];
  for (const source of unique) {
    if (opts.dryRun) {
      out.push({ repo: source, status: "added", message: "dry-run" });
      continue;
    }
    out.push(await addOne(source, agents));
  }
  return out;
}

export type SkillRemoveResult = {
  skills: string[];
  agents: AgentId[];
  status: "removed" | "skipped" | "failed";
  message?: string;
};

// `npx skills remove -g -a <agent> … -s <name> … -y` — remove the named skills from
// each named agent, globally, non-interactively. Uses the repeated-flag form (one
// `-a`/`-s` per value), matching `addArgs` — the convention already exercised in
// production by the mirror — rather than packing values into a single variadic flag.
export function removeArgs(names: string[], agents: readonly AgentId[]): string[] {
  const args = ["-y", "skills", "remove", "-g"];
  for (const target of uniqueSkillAgentCliIds(agents)) args.push("-a", target);
  for (const n of names) args.push("-s", n);
  args.push("-y");
  return args;
}

function removeOne(names: string[], agents: readonly AgentId[]): Promise<SkillRemoveResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn("npx", removeArgs(names, agents), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SKILLS_ADD_TIMEOUT_MS);
    const finish = (r: SkillRemoveResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (err: Error) => finish({ skills: names, agents: [...agents], status: "failed", message: err.message }));
    child.on("close", (code) => {
      if (timedOut) return finish({ skills: names, agents: [...agents], status: "failed", message: `timed out after ${SKILLS_ADD_TIMEOUT_MS / 1000}s` });
      if (code === 0) return finish({ skills: names, agents: [...agents], status: "removed" });
      const blob = `${stdout}\n${stderr}`;
      const tail = stderr.trim().split("\n").pop() || stdout.trim().split("\n").pop() || "";
      // The skills CLI exits non-zero when nothing matched — not a failure for us
      // (the skill was already gone), so report it as a benign skip.
      if (/no (matching )?skills?\b|not found|nothing to remove/i.test(blob)) {
        return finish({ skills: names, agents: [...agents], status: "skipped", message: "no matching skills" });
      }
      finish({ skills: names, agents: [...agents], status: "failed", message: `exit ${code}: ${tail}` });
    });
  });
}

// Remove specific skills (by name) from specific agents — the skill-cohort side of
// `syncthis plugin rm`. Names are slug-validated (a leading "-" would be read as a
// flag by the skills CLI) and deduped. One `npx skills remove` call covers every
// (name, agent) pair. A no-op input (no names or no agents) returns "skipped"
// without shelling out.
export async function removeSkillNames(
  names: string[],
  agents: readonly AgentId[],
  opts: { dryRun?: boolean } = {},
): Promise<SkillRemoveResult> {
  const safe = [...new Set(names)].filter((n) => isSafeSkillName(n)).sort();
  if (safe.length === 0 || agents.length === 0) {
    return { skills: [], agents: [...agents], status: "skipped", message: "nothing to remove" };
  }
  if (opts.dryRun) return { skills: safe, agents: [...agents], status: "removed", message: "dry-run" };
  return removeOne(safe, agents);
}

// Surface skills bundled inside Claude's installed plugins to the skill-cohort
// agents (everything that can't consume plugins natively). One `npx skills add`
// per source repo, sequentially — concurrent invocations would race on the shared
// agent skill directories.
export async function addSkillsFromPlugins(
  opts: {
    dryRun?: boolean;
    agents?: AgentId[];
    force?: boolean;
    onProgress?: (repo: string, i: number, total: number) => void;
  } = {},
): Promise<PluginSkillsReport> {
  const dryRun = !!opts.dryRun;
  const agents = opts.agents ?? skillCohort();
  const sources = await resolvePluginSkillSources();
  if (sources.length === 0) {
    return { ran: false, dryRun, agents, sources, results: [], message: "no skill-bearing plugins found in ~/.claude/plugins" };
  }

  if (opts.force) {
    const results: SkillAddResult[] = [];
    if (dryRun) {
      for (const s of sources) results.push({ repo: s.repo, status: "added", message: "dry-run" });
      return { ran: true, dryRun, agents, sources, results };
    }

    let i = 0;
    for (const s of sources) {
      i += 1;
      opts.onProgress?.(s.repo, i, sources.length);
      results.push(await addOne(s.repo, agents));
    }
    return { ran: true, dryRun, agents, sources, results };
  }

  // Skip a repo only when every skill it contributes is already registered on every
  // requested target agent. A global name-only guard is not enough: if a skill was
  // previously added to only some agents, later syncs must fill the missing agents
  // instead of reporting the repo as "already synced".
  const [installedAgents, sourceSkills] = await Promise.all([
    installedSkillAgentsByName(),
    Promise.all(sources.map(async (source) => ({ source, names: await repoSkillNames(source.installLocation) }))),
  ]);
  const results: SkillAddResult[] = [];
  const toAdd: PluginSkillSource[] = [];
  for (const { source: s, names } of sourceSkills) {
    if (names && names.every((n) => agents.every((agent) => installedAgents.get(n)?.has(agent)))) {
      results.push({ repo: s.repo, status: "skipped", message: "already synced" });
    } else {
      toAdd.push(s);
    }
  }

  if (dryRun) {
    for (const s of toAdd) results.push({ repo: s.repo, status: "added", message: "dry-run" });
    return { ran: true, dryRun, agents, sources, results };
  }

  let i = 0;
  for (const s of toAdd) {
    i += 1;
    opts.onProgress?.(s.repo, i, toAdd.length);
    results.push(await addOne(s.repo, agents));
  }
  return { ran: true, dryRun, agents, sources, results };
}
