#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ADD_HELP, HELP, MCP_HELP, MCP_NO_ADD, PLUGINS_HELP, SKILLS_HELP } from "../src/cli/help.ts";
import {
  fanOutHasChanges,
  printDirectionalDiff,
  printFanOut,
  printFanOutWrites,
  printRemove,
} from "../src/cli/render-mcp.ts";
import {
  printMirrorApplied,
  printMirrorPreview,
  printPluginAdd,
  printPluginOverview,
  printUninstallApplied,
  printUninstallPreview,
} from "../src/cli/render-plugins.ts";
import { printDoctor, printPluginSkills, printSync } from "../src/cli/render-sync.ts";
import { dim, exitIfFailed, green, red, row, yellow } from "../src/cli/output.ts";
import {
  dispatchRegisteredCommand,
  type CommandRegistry,
} from "../src/cli/registry.ts";
import { deriveGlobalPrefix } from "../src/self-update.ts";
import type { AgentId } from "../src/types.ts";

const SELF_PACKAGE = "@hungv47/syncthis";
const UPDATE_TIMEOUT_MS = 300_000;

const OPTIONS = {
  "no-skills": { type: "boolean" },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  all: { type: "boolean" },
  "no-provision": { type: "boolean" },
  // `plugin rm` scope + behavior.
  agents: { type: "string" },
  "keep-data": { type: "boolean" },
  // `add <source>` explicit type override (skip auto-detection).
  as: { type: "string" },
} as const;

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

function pluginSkillProgress(repo: string, i: number, total: number) {
  process.stderr.write(dim(`  → [${i}/${total}] npx skills add ${repo}\n`));
}

async function cmdSync(argv: string[]) {
  const { runSync } = await import("../src/sync.ts");
  const { values } = parse(argv);
  const dryRun = !!values["dry-run"];
  printSync(await runSync({ dryRun, skipSkills: !!values["no-skills"] }));
}

// MCP-only union sync — the body behind both bare `mcp` (legacy) and `mcp sync`.
async function cmdMcp(argv: string[]) {
  const { runSync } = await import("../src/sync.ts");
  const { values } = parse(argv);
  printSync(await runSync({ dryRun: !!values["dry-run"], skipSkills: true, skipPlugins: true }));
}

// `syncthis mcp <verb>` group router. Bare `mcp` (and `mcp --dry-run`) keep the legacy
// union-sync behavior; the canonical form is `mcp sync`. A first positional that isn't a
// known verb is treated as the source of a directional `mcp <from> <to>` mirror.
async function cmdMcpGroup(argv: string[]) {
  const sub = argv[0];
  if (sub === "help" || sub === "-h" || sub === "--help") return void console.log(MCP_HELP);
  if (!sub || sub.startsWith("-")) return cmdMcp(argv); // bare / `mcp --dry-run` → legacy union sync
  if (sub === "sync") return cmdMcp(argv.slice(1));
  if (sub === "doctor") return cmdDoctor();
  if (sub === "from") return cmdFanOut(argv.slice(1));
  if (sub === "rm" || sub === "remove") return cmdRmMcp(argv.slice(1));
  const second = argv[1];
  if (second && !second.startsWith("-")) return cmdDirectional(sub, second, argv.slice(2));
  console.error(red(`mcp: unknown verb \`${sub}\`. try \`syncthis mcp help\`.`));
  process.exit(2);
}

// `syncthis plugins <verb>` group router. Bare `plugins` prints scoped help (the legacy
// singular `plugin` keeps its read-only list-on-bare behavior as an alias in main()).
async function cmdPlugins(argv: string[]) {
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") return void console.log(PLUGINS_HELP);
  if (sub === "list") return cmdPluginList();
  if (sub === "mirror") return cmdMirror(argv.slice(1));
  if (sub === "add") return cmdAddPlugin(argv.slice(1));
  if (sub === "rm" || sub === "remove" || sub === "uninstall") return cmdPluginRemove(argv.slice(1));
  console.error(red(`plugins: unknown verb \`${sub}\`. try \`syncthis plugins help\`.`));
  process.exit(2);
}

// `syncthis skills <verb>` group router. Bare `skills` (and `skills --flag`) keep the
// legacy `npx skills update` behavior; the canonical form is `skills update`.
async function cmdSkills(argv: string[]) {
  const sub = argv[0];
  if (sub === "from-plugins") return cmdSkillsFromPlugins(argv.slice(1));
  if (sub === "update") return cmdSkillsOnly();
  if (sub === "add") return cmdAddSkill(argv.slice(1));
  if (sub === "rm" || sub === "remove") return cmdRmSkill(argv.slice(1));
  if (sub === "help" || sub === "-h" || sub === "--help") return void console.log(SKILLS_HELP);
  if (sub && !sub.startsWith("-")) {
    console.error(red(`skills: unknown verb \`${sub}\`. try \`syncthis skills help\`.`));
    process.exit(2);
  }
  return cmdSkillsOnly(); // bare / `skills --flag` → legacy update
}

async function cmdSkillsOnly() {
  const { runSkillsOnly } = await import("../src/sync.ts");
  const r = await runSkillsOnly();
  if (r.ok) row("synced", "skills", "", "npx skills update -y");
  else {
    row("drift", "skills", "", r.message ?? "failed");
    process.exit(1);
  }
}

async function cmdSkillsFromPlugins(argv: string[]) {
  const { addSkillsFromPlugins } = await import("../src/skills.ts");
  const { values } = parse(argv);
  const dryRun = !!values["dry-run"];
  const report = await addSkillsFromPlugins({ dryRun, onProgress: pluginSkillProgress });
  printPluginSkills(report, dryRun);
  if (report.results.some((r) => r.status === "failed")) process.exit(1);
}

async function cmdUpdate(argv: string[]) {
  const sub = argv[0];
  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log("syncthis update [--dry-run] — update syncthis itself to the latest npm version");
    return;
  }
  const { values, positionals } = parse(argv);
  if (positionals.length) {
    console.error(red(`update: unexpected argument(s): ${positionals.join(", ")}`));
    process.exit(2);
  }

  const running = await runningInstall();
  const command = await resolveSelfUpdateCommand(running);
  const display = [command.cmd, ...command.args].join(" ");
  if (values["dry-run"]) {
    row("skipped", "update", SELF_PACKAGE, `would run: ${display}`);
    if (running) console.log(dim(`  target: ${running.packageRoot}`));
    return;
  }

  const before = running ? await readVersionAt(running.packageRoot) : undefined;
  console.log(`Updating syncthis with ${green(display)}${running ? dim(`  (target: ${running.packageRoot})`) : ""}`);
  const result = await runInherited(command.cmd, command.args, UPDATE_TIMEOUT_MS);
  if (result.ok) {
    // Verify against the bytes we actually run: re-read the running copy's version
    // after the install. A blind "updated to latest" was the bug — it reported
    // success while the on-PATH copy stayed stale because the install landed in a
    // different prefix. Now we report the version that the next invocation will run.
    const after = running ? await readVersionAt(running.packageRoot) : undefined;
    if (after) {
      const detail = before && before !== after ? `updated ${before} → ${after}` : `now at ${after}`;
      row("synced", "update", SELF_PACKAGE, detail);
    } else {
      row("synced", "update", SELF_PACKAGE, "updated to latest");
    }
    return;
  }
  const message = result.notFound
    ? `${command.cmd} not found on PATH`
    : result.timedOut
      ? `timed out after ${UPDATE_TIMEOUT_MS / 1000}s`
      : result.message ?? `exit ${result.exitCode}`;
  row("failed", "update", SELF_PACKAGE, message);
  process.exit(result.exitCode > 0 ? result.exitCode : 1);
}

async function cmdVersion() {
  console.log(await readSelfVersion());
}

async function readSelfVersion(): Promise<string> {
  try {
    const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
    const raw = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : "unknown";
  } catch {
    return "unknown";
  }
}

// The global install (package root + npm prefix) that is ACTUALLY running, found by
// walking up from the running bundle to the dir whose package.json is ours. Lets
// `update` refresh the copy on your PATH instead of npm's default global prefix —
// the two differ on a machine with more than one Node prefix. null in a dev/source
// run (not inside a node_modules), where `update` falls back to the default.
async function runningInstall(): Promise<{ packageRoot: string; prefix: string } | null> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: unknown };
      if (pkg?.name === SELF_PACKAGE) return { packageRoot: dir, prefix: deriveGlobalPrefix(dir) };
    } catch {
      // no package.json here / unreadable — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function readVersionAt(dir: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : undefined;
  } catch {
    return undefined;
  }
}

async function resolveSelfUpdateCommand(running: { prefix: string } | null): Promise<{ cmd: string; args: string[] }> {
  const userAgent = process.env.npm_config_user_agent ?? "";
  const entry = process.argv[1] ? await realpath(process.argv[1]).catch(() => process.argv[1] ?? "") : "";
  const prefersBun = userAgent.startsWith("bun/") || entry.includes("/.bun/") || entry.includes("\\.bun\\");
  // bun's global install always targets ~/.bun (or $BUN_INSTALL), which is also where
  // a bun-installed binary runs from, so no prefix override is needed there.
  if (prefersBun) return { cmd: "bun", args: ["install", "-g", `${SELF_PACKAGE}@latest`] };
  const args = ["install", "-g", `${SELF_PACKAGE}@latest`];
  // Pin npm to the prefix that owns the running binary so the copy on your PATH is
  // the one updated — not npm's default global prefix, which may point elsewhere.
  if (running?.prefix) args.push("--prefix", running.prefix);
  return { cmd: "npm", args };
}

function runInherited(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; exitCode: number; notFound: boolean; timedOut: boolean; message?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(cmd, args, { stdio: "inherit", env: process.env });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const finish = (result: { ok: boolean; exitCode: number; notFound: boolean; timedOut: boolean; message?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        exitCode: -1,
        notFound: err.code === "ENOENT",
        timedOut,
        message: err.message,
      });
    });
    child.on("close", (code) => {
      const exitCode = code ?? -1;
      finish({ ok: exitCode === 0 && !timedOut, exitCode, notFound: false, timedOut });
    });
  });
}

async function cmdDoctor() {
  const { runDoctor } = await import("../src/doctor.ts");
  printDoctor(await runDoctor());
}

async function cmdMirror(argv: string[]) {
  const { runMirror, mirrorHasChanges } = await import("../src/plugins/mirror.ts");
  const { pluginAdapters } = await import("../src/plugins/index.ts");
  const { values, positionals } = parse(argv);
  const from = positionals[0];
  // Validate against the plugin cohort (claude-code, codex), not the 11 MCP-sync
  // agents — a non-plugin primary would otherwise throw from runMirror.
  const pluginIds = pluginAdapters.map((a) => a.id);
  if (!from || !pluginIds.includes(from as AgentId)) {
    console.error(red(`mirror: pass a plugin-capable primary agent. known: ${pluginIds.join(", ")}`));
    process.exit(2);
  }
  const dryRun = !!values["dry-run"];
  const provision = !values["no-provision"];

  const preview = await runMirror({ from: from as AgentId, apply: false, provision });
  printMirrorPreview(preview);
  if (!mirrorHasChanges(preview)) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }
  if (provision) {
    console.log(
      dim(
        "provisioning on: Codex installs from local marketplace clones when available, else registers the marketplace via `npx plugins add`; bundles a target can't load as plugins are added as skills via `npx skills add` (network). Pass --no-provision to skip.",
      ),
    );
  }
  await confirmDestructive(!!values.yes);
  // A full mirror is many sequential npx/codex network calls — stream per-item
  // progress to stderr so it doesn't look frozen.
  const onProgress = (label: string, i: number, total: number) =>
    process.stderr.write(dim(`  → [${i}/${total}] ${label}\n`));
  const applied = await runMirror({ from: from as AgentId, apply: true, provision, onProgress });
  printMirrorApplied(applied, provision);
}

async function cmdPlugin(argv: string[]) {
  const sub = argv[0];
  if (!sub || sub === "list") return cmdPluginList();
  if (sub === "rm" || sub === "remove" || sub === "uninstall") return cmdPluginRemove(argv.slice(1));
  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(
      "syncthis plugin list                 — overview of plugins across every agent (read-only)\n" +
        "syncthis plugin rm <plugin…> --all   — uninstall plugin(s) everywhere (native plugin on\n" +
        "                                       claude-code/codex + surfaced skills on the rest)\n" +
        "syncthis plugin rm <plugin…> --agents <a,b,c>\n" +
        "                                     — uninstall only from the named agents\n" +
        "  flags: --dry-run (preview), --yes (skip confirm), --keep-data (claude: keep plugin data dir)",
    );
    return;
  }
  console.error(red(`unknown plugin subcommand: ${sub}. use \`plugin list\` or \`plugin rm\`.`));
  process.exit(2);
}

async function cmdPluginList() {
  const { buildPluginOverview } = await import("../src/plugins/overview.ts");
  printPluginOverview(await buildPluginOverview());
}

async function cmdPluginRemove(argv: string[]) {
  const { runPluginUninstall, uninstallHasChanges } = await import("../src/plugins/uninstall.ts");
  const { listAgentIds } = await import("../src/adapters/index.ts");
  const { values, positionals } = parse(argv);
  const plugins = positionals;
  if (plugins.length === 0) {
    console.error(red("plugin rm: name at least one plugin to uninstall"));
    process.exit(2);
  }
  // The full agent universe: MCP-syncable agents + skills-only agents (Pi).
  const known = [...listAgentIds(), "pi"] as AgentId[];
  const hasAgents = typeof values.agents === "string" && values.agents.trim().length > 0;
  // --all and --agents are mutually exclusive scopes — for a destructive command,
  // silently letting one win could uninstall from unintended agents. Reject both.
  if (values.all && hasAgents) {
    console.error(red("plugin rm: pass either --all or --agents <a,b,c>, not both"));
    process.exit(2);
  }
  let agents: AgentId[];
  if (values.all) {
    agents = known;
  } else if (hasAgents) {
    const wanted = (values.agents as string).split(",").map((s) => s.trim()).filter(Boolean);
    const bad = wanted.filter((a) => !known.includes(a as AgentId));
    if (bad.length) {
      console.error(red(`unknown agent(s): ${bad.join(", ")}`));
      console.error(dim(`known agents: ${known.join(", ")}`));
      process.exit(2);
    }
    agents = wanted as AgentId[];
  } else {
    console.error(red("plugin rm requires an explicit scope: --all or --agents <a,b,c>"));
    process.exit(2);
  }
  const keepData = !!values["keep-data"];

  const dryRun = !!values["dry-run"];
  const preview = await runPluginUninstall({ plugins, agents, apply: false, keepData });
  printUninstallPreview(preview);
  // Claude's plugin list (the source for resolving which skills a plugin contributed)
  // couldn't be read. That's a hard block only for agents whose ONLY mechanism is
  // surfaced-skill removal (the pure non-plugin cohort) — a Codex-only scope is covered
  // by its native uninstall, so it's just a best-effort warning there. Don't let a real
  // block masquerade as a clean "nothing to do".
  const skillBlocked = !!preview.claudeReadError && preview.requiredSkillAgents.length > 0;
  if (!uninstallHasChanges(preview) && !skillBlocked) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    if (skillBlocked) process.exit(1);
    return;
  }
  await confirmDestructive(!!values.yes);
  const onProgress = (label: string, i: number, total: number) =>
    process.stderr.write(dim(`  → [${i}/${total}] ${label}\n`));
  const applied = await runPluginUninstall({ plugins, agents, apply: true, keepData, onProgress });
  const failed = printUninstallApplied(applied);
  // The apply phase re-reads Claude; if that read fails now (even though the preview's
  // succeeded), skill names couldn't be resolved and skill removal was dropped. Surface
  // it loudly instead of letting the apply look clean.
  // Base the exit on the APPLY outcome, not the stale preview `skillBlocked` — a
  // preview that couldn't read Claude but an apply that then succeeded is a success.
  const appliedBlocked = !!applied.claudeReadError && applied.requiredSkillAgents.length > 0;
  if (applied.claudeReadError && applied.skillScope.length) {
    if (appliedBlocked) {
      console.error(red(`couldn't read Claude's plugins during apply (${applied.claudeReadError}) — surfaced skills on ${applied.requiredSkillAgents.join(", ")} were NOT removed; re-run once claude is available`));
    } else {
      // Only Codex was skill-scoped — its native uninstall did the work; we just
      // couldn't check for any fallback-surfaced skills. Warn, don't fail.
      console.error(yellow(`note: claude unreadable (${applied.claudeReadError}) — couldn't check for fallback-surfaced skills on ${applied.skillScope.join(", ")}; the native uninstall still applied`));
    }
  }
  if (failed > 0 || appliedBlocked) process.exit(1);
}

async function cmdFanOut(argv: string[]) {
  const { listAgentIds } = await import("../src/adapters/index.ts");
  const { runFanOut } = await import("../src/sync.ts");
  const { values, positionals } = parse(argv);
  const from = positionals[0];
  const ids = listAgentIds();
  if (!from || !ids.includes(from as AgentId)) {
    console.error(red(`unknown agent: ${from ?? ""}`));
    console.error(dim(`known agents: ${ids.join(", ")}`));
    process.exit(2);
  }
  if (!values.all) {
    console.error(red("fan-out requires --all"));
    process.exit(2);
  }

  const dryRun = !!values["dry-run"];
  const preview = await runFanOut({ from: from as AgentId, apply: false });
  printFanOut(preview);
  if (!fanOutHasChanges(preview)) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }
  await confirmDestructive(!!values.yes);
  const applied = await runFanOut({ from: from as AgentId, apply: true });
  printFanOutWrites(applied);
  exitIfFailed(applied.targets.map((t) => t.write).filter((w): w is NonNullable<typeof w> => !!w));
}

// Shared scope resolver for the add/rm grammar. `--all` and `--agents` are mutually
// exclusive; one is required (the user must say exactly where). Validates against the
// command's known agent set.
type ParsedValues = ReturnType<typeof parse>["values"];
function resolveAgentScope(values: ParsedValues, known: AgentId[], label: string): AgentId[] {
  const hasAgents = typeof values.agents === "string" && (values.agents as string).trim().length > 0;
  if (values.all && hasAgents) {
    console.error(red(`${label}: pass either --all or --agents <a,b,c>, not both`));
    process.exit(2);
  }
  if (values.all) return known;
  if (hasAgents) {
    const wanted = (values.agents as string).split(",").map((s) => s.trim()).filter(Boolean);
    const bad = wanted.filter((a) => !known.includes(a as AgentId));
    if (bad.length) {
      console.error(red(`unknown agent(s): ${bad.join(", ")}`));
      console.error(dim(`known agents: ${known.join(", ")}`));
      process.exit(2);
    }
    return wanted as AgentId[];
  }
  console.error(red(`${label} requires a scope: --all or --agents <a,b,c>`));
  process.exit(2);
}

// `syncthis add <items…> --agents <list>|--all` — additive (no confirm; supports
// --dry-run). The type is named explicitly (`add skill|plugin <items…>`) or auto-detected
// from the source. MCP has no add (syncthis is a sync layer, not an installer).
async function cmdAdd(argv: string[]) {
  const noun = argv[0];
  if (noun === "help" || noun === "-h" || noun === "--help") return void console.log(ADD_HELP);
  if (noun === "skill" || noun === "skills") return cmdAddSkill(argv.slice(1));
  if (noun === "plugin" || noun === "plugins") return cmdAddPlugin(argv.slice(1));
  if (noun === "mcp") {
    console.error(red(`there's no \`add mcp\` — ${MCP_NO_ADD}`));
    process.exit(2);
  }
  if (!noun || noun.startsWith("-")) {
    console.error(red("add: name what to add — `add <owner/repo>` (auto-detected) or `add skill|plugin <items…>` (with --all | --agents <a,b,c>)"));
    process.exit(2);
  }
  // First positional isn't a known noun → treat the positionals as sources and infer
  // each one's type. `--as skill|plugin|mcp` forces the type.
  return cmdAddAuto(argv);
}

// Auto-detect path: classify each source (skill / plugin / mcp) and route to the typed
// handler. Reuses the explicit handlers wholesale (scope parsing, dry-run, printing).
async function cmdAddAuto(argv: string[]) {
  const { detectAddType, isAddType, needsInstalledPlugins } = await import("../src/plugins/detect.ts");
  const { values, positionals } = parse(argv);
  const as = typeof values.as === "string" ? values.as : undefined;
  if (as !== undefined && !isAddType(as)) {
    console.error(red(`add: --as must be one of skill, plugin, mcp (got \`${as}\`)`));
    process.exit(2);
  }
  if (positionals.some((p) => p.trim() === "")) {
    console.error(red(`add: empty source — pass a repo (owner/repo), an installed plugin name, or use \`--as skill|plugin\`.`));
    process.exit(2);
  }
  // Read claude-code's installed plugins only if a bare-name source actually needs it.
  let installed: ReadonlySet<string> | undefined;
  if (positionals.some((p) => needsInstalledPlugins(p, as))) {
    const { claudePluginAdapter } = await import("../src/plugins/claude.ts");
    const read = await claudePluginAdapter.read();
    installed = new Set(read.error ? [] : read.plugins.map((p) => p.name));
  }
  const typed = positionals.map((source) => ({ source, type: detectAddType(source, { as, installedPluginNames: installed }) }));

  // MCP-typed sources can't be added — surface them rather than silently dropping.
  const mcp = typed.filter((t) => t.type === "mcp").map((t) => t.source);
  if (mcp.length) {
    const looks = mcp.length > 1 ? "look like MCP server names" : "looks like an MCP server name";
    console.error(red(`add: ${mcp.join(", ")} ${looks} — ${MCP_NO_ADD} (pass \`--as skill|plugin\` if it's a repo or installed plugin).`));
    process.exit(2);
  }

  const kinds = new Set(typed.map((t) => t.type));
  if (kinds.size > 1) {
    const summary = typed.map((t) => `${t.source}=${t.type}`).join(", ");
    console.error(red(`add: mixed source types (${summary}). Run them in separate \`add\` commands, or pass \`--as skill|plugin\` to force one type.`));
    process.exit(2);
  }
  const type = [...kinds][0] as "skill" | "plugin"; // mcp already handled above
  console.log(dim(`add: detected ${type}${as ? " (--as)" : ""} → ${positionals.join(", ")}`));
  // Forward the original argv (sources as positionals, flags intact) to the typed handler.
  return type === "skill" ? cmdAddSkill(argv) : cmdAddPlugin(argv);
}

async function cmdAddSkill(argv: string[]) {
  const { addSkillRepos } = await import("../src/skills.ts");
  const { isSafeRepoSlug } = await import("../src/plugins/shell.ts");
  const { listAgentIds } = await import("../src/adapters/index.ts");
  const { values, positionals } = parse(argv);
  if (positionals.length === 0) {
    console.error(red("add skill: name at least one repo (e.g. vercel-labs/agent-skills)"));
    process.exit(2);
  }
  // Reject bad slugs up front — addSkillRepos silently drops them, which would
  // otherwise look like a clean no-op (exit 0) when nothing was added.
  const badSlugs = positionals.filter((p) => !isSafeRepoSlug(p));
  if (badSlugs.length) {
    console.error(red(`add skill: not a valid owner/repo slug: ${badSlugs.join(", ")}`));
    process.exit(2);
  }
  const agents = resolveAgentScope(values, [...listAgentIds(), "pi"] as AgentId[], "add skill");
  const dryRun = !!values["dry-run"];
  console.log(`Add skills ${positionals.map((p) => green(p)).join(", ")} → ${agents.join(", ")}${dryRun ? dim(" (dry-run)") : ""}`);
  const results = await addSkillRepos(positionals, agents, { dryRun });
  let added = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "failed") { failed += 1; row("failed", "skills", r.repo, r.message); }
    else { added += 1; row("synced", "skills", r.repo, dryRun ? "dry-run" : r.status === "skipped" ? (r.message ?? "no skills") : "added"); }
  }
  if (failed > 0) process.exit(1);
}

async function cmdAddPlugin(argv: string[]) {
  const { runPluginAdd, pluginAddHasWork } = await import("../src/plugins/add.ts");
  const { listAgentIds } = await import("../src/adapters/index.ts");
  const { values, positionals } = parse(argv);
  if (positionals.length === 0) {
    console.error(red("add plugin: name at least one plugin (must be installed on claude-code, the source)"));
    process.exit(2);
  }
  const agents = resolveAgentScope(values, [...listAgentIds(), "pi"] as AgentId[], "add plugin");
  const dryRun = !!values["dry-run"];
  const preview = await runPluginAdd({ plugins: positionals, agents, apply: false });
  printPluginAdd(preview, true);
  if (preview.sourceError) {
    console.error(red(`cannot read claude-code (the source): ${preview.sourceError}`));
    process.exit(1);
  }
  if (!pluginAddHasWork(preview)) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }
  console.log(dim("installing — Codex installs from local marketplace clones (offline); Cursor/skills steps use npx (network)…"));
  const onProgress = (label: string, i: number, total: number) =>
    process.stderr.write(dim(`  → [${i}/${total}] ${label}\n`));
  const applied = await runPluginAdd({ plugins: positionals, agents, apply: true, onProgress });
  const failed = printPluginAdd(applied, false);
  // Claude (the source) failing at apply time means nothing could be resolved — surface
  // it rather than reporting an empty, clean-looking add.
  if (applied.sourceError) {
    console.error(red(`couldn't read claude-code (the source) during apply: ${applied.sourceError}`));
    process.exit(1);
  }
  if (failed > 0) process.exit(1);
}

// `syncthis rm <mcp|skill|plugin> <items…>`. A bare `rm <server> --all` (no noun)
// stays MCP, for back-compat with the original single-server remove.
async function cmdRm(argv: string[]) {
  const noun = argv[0];
  if (noun === "skill" || noun === "skills") return cmdRmSkill(argv.slice(1));
  if (noun === "plugin" || noun === "plugins") return cmdPluginRemove(argv.slice(1));
  if (noun === "mcp") return cmdRmMcp(argv.slice(1));
  return cmdRmMcp(argv); // legacy: `rm <server> --all`
}

async function cmdRmMcp(argv: string[]) {
  const { listAgentIds } = await import("../src/adapters/index.ts");
  const { runRemove } = await import("../src/sync.ts");
  const { values, positionals } = parse(argv);
  if (positionals.length === 0) {
    console.error(red("rm mcp: name at least one server"));
    process.exit(2);
  }
  const agents = resolveAgentScope(values, listAgentIds(), "rm mcp");
  const dryRun = !!values["dry-run"];
  const previews = [];
  for (const name of positionals) previews.push(await runRemove({ name, agents, apply: false }));
  for (const p of previews) printRemove(p);
  const willChange = previews.some((p) => p.writes.some((w) => w.status === "synced"));
  if (!willChange) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }
  await confirmDestructive(!!values.yes);
  const writes = [];
  for (const name of positionals) {
    const applied = await runRemove({ name, agents, apply: true });
    printRemove(applied);
    writes.push(...applied.writes);
  }
  exitIfFailed(writes);
}

async function cmdRmSkill(argv: string[]) {
  const { removeSkillNames, listInstalledSkills } = await import("../src/skills.ts");
  const { listAgentIds } = await import("../src/adapters/index.ts");
  const { values, positionals } = parse(argv);
  if (positionals.length === 0) {
    console.error(red("rm skill: name at least one skill"));
    process.exit(2);
  }
  const agents = resolveAgentScope(values, [...listAgentIds(), "pi"] as AgentId[], "rm skill");
  const dryRun = !!values["dry-run"];

  // Preview: which requested skills actually live on which scoped agents.
  const installed = await listInstalledSkills();
  console.log(`Remove skills ${positionals.map((p) => green(p)).join(", ")} from ${agents.join(", ")}:`);
  let present = false;
  if (installed) {
    for (const name of positionals) {
      const hit = installed.find((s) => s.name === name);
      const on = hit ? hit.agents.filter((a) => agents.includes(a)) : [];
      if (on.length) { present = true; console.log(`  ${red("-")} ${name} ${dim(`(on ${on.join(", ")})`)}`); }
      else console.log(`  ${dim("·")} ${name} ${dim("not installed on the scoped agents")}`);
    }
  } else {
    present = true; // can't read the list — proceed and let the CLI report per agent
    console.log(dim("  (couldn't read `npx skills list` — proceeding by name)"));
  }
  if (!present) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }
  await confirmDestructive(!!values.yes);
  const r = await removeSkillNames(positionals, agents);
  if (r.status === "failed") { row("failed", "skills", "", r.message); process.exit(1); }
  else if (r.status === "skipped") row("skipped", "skills", "", r.message);
  else row("synced", "skills", "", `removed ${r.skills.length} skill(s) from ${r.agents.length} agent(s)`);
}

async function cmdDirectional(from: string, to: string, argv: string[]) {
  const { listAgentIds } = await import("../src/adapters/index.ts");
  const { runDirectional } = await import("../src/sync.ts");
  const { values } = parse(argv);
  const ids = listAgentIds();
  if (!ids.includes(from as AgentId)) {
    console.error(red(`unknown agent: ${from}`));
    console.error(dim(`known agents: ${ids.join(", ")}`));
    process.exit(2);
  }
  if (!ids.includes(to as AgentId)) {
    console.error(red(`unknown agent: ${to}`));
    console.error(dim(`known agents: ${ids.join(", ")}`));
    process.exit(2);
  }
  if (from === to) {
    console.error(red(`from and to must differ`));
    process.exit(2);
  }

  const dryRun = !!values["dry-run"];
  const yes = !!values.yes;

  // First read + diff without applying.
  const preview = await runDirectional({ from: from as AgentId, to: to as AgentId, apply: false });

  // Bail before showing a diff if either side failed to parse — otherwise an unreadable
  // source would render as "remove all servers from destination" and the user could approve
  // wiping the destination without realizing the source was broken.
  if (preview.fromRead.error) {
    console.error(red(`cannot read source ${preview.from}: ${preview.fromRead.error}`));
    process.exit(2);
  }
  if (preview.toRead.error) {
    console.error(red(`cannot read destination ${preview.to}: ${preview.toRead.error}`));
    process.exit(2);
  }

  printDirectionalDiff(preview);

  if (preview.diff.add.length === 0 && preview.diff.overwrite.length === 0 && preview.diff.remove.length === 0) {
    console.log(dim("nothing to do."));
    return;
  }

  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    return;
  }

  await confirmDestructive(yes);

  const applied = await runDirectional({ from: from as AgentId, to: to as AgentId, apply: true });
  if (applied.write) {
    if (applied.write.status === "failed") {
      row("failed", to, applied.write.path, applied.write.message);
      process.exit(1);
    }
    row(applied.write.status, to, applied.write.path, applied.write.message);
  }
}

async function confirmDestructive(yes: boolean) {
  if (yes) return;
  if (process.stdin.isTTY) {
    process.stdout.write("\nContinue? [y/N] ");
    const answer = await readLine();
    if (answer.trim().toLowerCase() !== "y") {
      console.log(dim("aborted."));
      process.exit(0);
    }
    return;
  }
  console.error(red("refusing destructive write without --yes in non-interactive mode."));
  process.exit(2);
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const finish = (line: string) => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.pause();
      resolve(line);
    };
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) finish(buf.slice(0, nl));
    };
    // EOF without a trailing newline (Ctrl-D, or a closed/empty pipe) must resolve —
    // otherwise the destructive-confirm prompt hangs forever. Resolve with whatever
    // was typed; confirmDestructive treats anything but "y" as abort, so EOF = abort.
    const onEnd = () => finish(buf);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}

const COMMANDS = {
  help: () => console.log(HELP),
  "-h": () => console.log(HELP),
  "--help": () => console.log(HELP),
  version: () => cmdVersion(),
  "--version": () => cmdVersion(),
  "-v": () => cmdVersion(),
  sync: cmdSync,
  run: cmdSync,
  plugins: cmdPlugins,
  skills: cmdSkills,
  mcp: cmdMcpGroup,
  doctor: () => cmdDoctor(),
  update: cmdUpdate,
  mirror: cmdMirror,
  from: cmdFanOut,
  add: cmdAdd,
  rm: cmdRm,
  remove: cmdRm,
  plugin: cmdPlugin,
} satisfies CommandRegistry;

async function main() {
  const [, , cmd, ...rest] = process.argv;

  // No command: render the ink welcome, then open the picker (or HELP if non-TTY).
  if (!cmd) {
    const { renderWelcome } = await import("../src/welcome.tsx");
    await renderWelcome();
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const { showInteractivePicker } = await import("../src/tui.ts");
      return showInteractivePicker();
    }
    return console.log(HELP);
  }

  if (await dispatchRegisteredCommand(cmd, rest, COMMANDS)) return;

  // Directional: two positional agent IDs.
  if (rest.length >= 1 && !cmd.startsWith("-")) {
    const second = rest[0];
    if (second && !second.startsWith("-")) {
      return cmdDirectional(cmd, second, rest.slice(1));
    }
  }

  console.error(red(`unknown command: ${cmd}`));
  console.error(HELP);
  process.exit(2);
}

main().catch((err) => {
  console.error(red(`syncthis: ${err?.message ?? err}`));
  // A bad flag / arg is a usage error → exit 2, matching every other usage-error
  // path (unknown command, missing --all, etc.). Everything else is a runtime
  // failure → exit 1.
  const code = typeof err?.code === "string" && err.code.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
  process.exit(code);
});
