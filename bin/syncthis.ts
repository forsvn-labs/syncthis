#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ADD_HELP, HELP, PLUGINS_HELP, PLUGIN_ONLY_ADD_MESSAGE } from "../src/cli/help.ts";
import { printPluginSyncReport } from "../src/cli/plugin-outcomes.ts";
import {
  neutralPluginText,
  printMirrorApplied,
  printMirrorPreview,
  printPluginAdd,
  printPluginOverview,
  printUninstallApplied,
  printUninstallPreview,
} from "../src/cli/render-plugins.ts";
import { dim, green, red, row, yellow } from "../src/cli/output.ts";
import {
  dispatchRegisteredCommand,
  type CommandRegistry,
} from "../src/cli/registry.ts";
import { deriveGlobalPrefix } from "../src/self-update.ts";
import type { AgentId } from "../src/types.ts";

const SELF_PACKAGE = "@hungv47/syncthis";
const UPDATE_TIMEOUT_MS = 300_000;

const OPTIONS = {
  "no-wrapper": { type: "boolean" },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  all: { type: "boolean" },
  "no-provision": { type: "boolean" },
  // `plugin rm` scope + behavior.
  agents: { type: "string" },
  "keep-data": { type: "boolean" },
  // Readable native plugin source for the retained scoped plugin add command.
  from: { type: "string" },
} as const;

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

function pluginProgress(_label: string, i: number, total: number) {
  process.stderr.write(dim(`  → [${i}/${total}] plugin sync\n`));
}

async function cmdSync(argv: string[]) {
  const { runSync } = await import("../src/sync.ts");
  const { values } = parse(argv);
  const dryRun = !!values["dry-run"];
  const report = await runSync({ dryRun, skipBridge: !!values["no-wrapper"] });
  printPluginSyncReport(report);
  if (!report.ok) process.exit(1);
}

// `syncthis plugins <verb>` is the canonical plugin command group. Add and mirror
// remain callable compatibility paths, but are intentionally absent from help.
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
  return cmdPluginList();
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
        "provisioning plugin reach on targets; pass --no-provision to skip target marketplace registration.",
      ),
    );
  }
  await confirmDestructive(!!values.yes);
  // A full mirror is many sequential npx/codex network calls — stream per-item
  // progress to stderr so it doesn't look frozen.
  const applied = await runMirror({ from: from as AgentId, apply: true, provision, onProgress: pluginProgress });
  printMirrorApplied(applied, provision);
}

async function cmdPlugin(argv: string[]) {
  const sub = argv[0];
  if (!sub || sub === "list") return cmdPluginList();
  if (sub === "rm" || sub === "remove" || sub === "uninstall") return cmdPluginRemove(argv.slice(1));
  if (sub === "help" || sub === "-h" || sub === "--help") {
    console.log(
      "syncthis plugin list                 — read-only plugin overview\n" +
        "syncthis plugin rm <plugin…> --all   — uninstall plugin(s) everywhere\n" +
        "syncthis plugin rm <plugin…> --agents <a,b,c>\n" +
        "                                     — uninstall only from the named agents\n" +
        "  flags: --dry-run (preview), --yes (skip confirm), --keep-data (Claude: keep plugin data)",
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
  const applied = await runPluginUninstall({ plugins, agents, apply: true, keepData, onProgress: pluginProgress });
  const failed = printUninstallApplied(applied);
  // The apply phase re-reads Claude; if that read fails now (even though the preview's
  // succeeded), skill names couldn't be resolved and skill removal was dropped. Surface
  // it loudly instead of letting the apply look clean.
  // Base the exit on the APPLY outcome, not the stale preview `skillBlocked` — a
  // preview that couldn't read Claude but an apply that then succeeded is a success.
  const appliedBlocked = !!applied.claudeReadError && applied.requiredSkillAgents.length > 0;
  if (applied.claudeReadError && applied.skillScope.length) {
    if (appliedBlocked) {
      console.error(red(`couldn't read Claude's plugins during apply (${neutralPluginText(applied.claudeReadError)}) — bundled plugin content on ${applied.requiredSkillAgents.join(", ")} was NOT removed; re-run once Claude is available`));
    } else {
      // Only Codex was skill-scoped — its native uninstall did the work; we just
      // couldn't check for any fallback-surfaced skills. Warn, don't fail.
      console.error(yellow(`note: Claude unreadable (${neutralPluginText(applied.claudeReadError)}) — couldn't check fallback plugin reach on ${applied.skillScope.join(", ")}; the native uninstall still applied`));
    }
  }
  if (failed > 0 || appliedBlocked) process.exit(1);
}

// Scope resolver for the retained bounded plugin-add compatibility path. `--all` and
// `--agents` are mutually exclusive; one is required and is validated against the target set.
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

// Compatibility alias: top-level `add` is plugin-only. The public command is
// `plugins add`; the alias deliberately never auto-detects other content types.
async function cmdAdd(argv: string[]) {
  const noun = argv[0];
  if (noun === "help" || noun === "-h" || noun === "--help") return void console.log(ADD_HELP);
  if (noun === "plugin" || noun === "plugins") return cmdAddPlugin(argv.slice(1));
  if (noun === "skill" || noun === "skills" || noun === "mcp") {
    console.error(red(PLUGIN_ONLY_ADD_MESSAGE));
    process.exit(2);
  }
  return cmdAddPlugin(argv);
}

async function cmdAddPlugin(argv: string[]) {
  const { runPluginAdd, pluginAddHasWork } = await import("../src/plugins/add.ts");
  const { pluginAdapters } = await import("../src/plugins/index.ts");
  const { listAgentIds } = await import("../src/adapters/index.ts");
  const { values, positionals } = parse(argv);
  const requestedSource = typeof values.from === "string" ? values.from : "claude-code";
  const readableSources = pluginAdapters.map((adapter) => adapter.id);
  if (!readableSources.includes(requestedSource as AgentId)) {
    console.error(
      red(
        `add plugin: --from must name a readable plugin source; got ${requestedSource}. ` +
          `known: ${readableSources.join(", ")}`,
      ),
    );
    process.exit(2);
  }
  const source = requestedSource as AgentId;
  if (positionals.length === 0) {
    console.error(red("add plugin: name at least one plugin installed on the selected source"));
    process.exit(2);
  }
  const agents = resolveAgentScope(values, [...listAgentIds(), "pi"] as AgentId[], "add plugin");
  const dryRun = !!values["dry-run"];
  const preview = await runPluginAdd({ from: source, plugins: positionals, agents, apply: false });
  printPluginAdd(preview, true);
  if (preview.sourceError) {
    console.error(red(`cannot read ${preview.source} (the source): ${neutralPluginText(preview.sourceError)}`));
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
  console.log(dim("installing the plugin on the selected targets…"));
  const applied = await runPluginAdd({ from: source, plugins: positionals, agents, apply: true, onProgress: pluginProgress });
  const failed = printPluginAdd(applied, false);
  // The selected source failing at apply time means nothing could be resolved — surface
  // it rather than reporting an empty, clean-looking add.
  if (applied.sourceError) {
    console.error(red(`couldn't read ${applied.source} (the source) during apply: ${neutralPluginText(applied.sourceError)}`));
    process.exit(1);
  }
  if (failed > 0) process.exit(1);
}

// Compatibility alias: top-level `rm`/`remove` is plugin-only. The public
// command is `plugins rm`; legacy non-plugin removal forms are not routed.
async function cmdRm(argv: string[]) {
  const noun = argv[0];
  if (noun === "help" || noun === "-h" || noun === "--help") return void console.log(PLUGINS_HELP);
  if (noun === "plugin" || noun === "plugins") return cmdPluginRemove(argv.slice(1));
  if (noun === "skill" || noun === "skills" || noun === "mcp") {
    console.error(red("syncthis only removes plugins; use `syncthis plugins rm`."));
    process.exit(2);
  }
  return cmdPluginRemove(argv);
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
  doctor: () => cmdDoctor(),
  update: cmdUpdate,
  mirror: cmdMirror,
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

  console.error(red(`unknown command: ${cmd}`));
  console.error(HELP);
  process.exit(2);
}

main().catch((err) => {
  console.error(red(`syncthis: ${neutralPluginText(err?.message ?? err, "command failed")}`));
  // A bad flag / arg is a usage error → exit 2, matching every other usage-error
  // path (unknown command, missing --all, etc.). Everything else is a runtime
  // failure → exit 1.
  const code = typeof err?.code === "string" && err.code.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
  process.exit(code);
});
