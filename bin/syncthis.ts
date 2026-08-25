#!/usr/bin/env bun
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
import { planSelfUpdate, readPackageVersion, runSelfUpdate } from "../src/self-update.ts";
import type { AgentId } from "../src/types.ts";

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

  const plan = await planSelfUpdate();
  if (values["dry-run"]) {
    row("skipped", "update", "@forsvn/syncthis", `would run: ${plan.display}`);
    if (plan.packageRoot) console.log(dim(`  target: ${plan.packageRoot}`));
    return;
  }

  console.log(`Updating Syncthis with ${green(plan.display)}${plan.packageRoot ? dim(`  (target: ${plan.packageRoot})`) : ""}`);
  const result = await runSelfUpdate({ plan, stdio: "inherit" });
  if (result.ok) {
    row("synced", "update", "@forsvn/syncthis", result.message);
    return;
  }
  row("failed", "update", "@forsvn/syncthis", result.message);
  process.exit(result.exitCode > 0 ? result.exitCode : 1);
}

async function cmdVersion() {
  console.log(await readPackageVersion(import.meta.url));
}

async function cmdDoctor() {
  const { renderPluginDoctor, runPluginDoctor } = await import("../src/plugins/doctor-report.ts");
  const report = await runPluginDoctor();
  for (const line of renderPluginDoctor(report)) console.log(line);
  if (!report.ok) process.exit(1);
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
  await printPluginOverview(await buildPluginOverview());
}

async function cmdPluginRemove(argv: string[]) {
  const { runPluginUninstall, uninstallHasChanges } = await import("../src/plugins/uninstall.ts");
  const { pluginReconcileTargets } = await import("../src/plugins/targets.ts");
  const { uninstallClaudePolicy, uninstallClaudeBlocked } = await import("../src/cli/uninstall-presentation.ts");
  const { values, positionals } = parse(argv);
  const plugins = positionals;
  if (plugins.length === 0) {
    console.error(red("plugin rm: name at least one plugin to uninstall"));
    process.exit(2);
  }
  const known = pluginReconcileTargets().map((target) => target.agent);
  const agents = resolveAgentScope(values, known, "plugin rm");
  const keepData = !!values["keep-data"];

  const dryRun = !!values["dry-run"];
  // Claude's plugin list (the source for resolving which skills a plugin contributed)
  // couldn't be read. That's a hard block only for agents whose ONLY mechanism is
  // surfaced-skill removal (the pure non-plugin cohort) — a Codex-only scope is covered
  // by its native uninstall, so it's just a best-effort warning there. Don't let a real
  // block masquerade as a clean "nothing to do".
  const preview = await runPluginUninstall({ plugins, agents, apply: false, keepData });
  printUninstallPreview(preview);
  if (!uninstallHasChanges(preview) && !uninstallClaudeBlocked(preview)) {
    console.log(dim("nothing to do."));
    return;
  }
  if (dryRun) {
    console.log(dim("dry-run — no changes applied."));
    if (uninstallClaudeBlocked(preview)) process.exit(1);
    return;
  }
  await confirmDestructive(!!values.yes);
  const applied = await runPluginUninstall({ plugins, agents, apply: true, keepData, onProgress: pluginProgress });
  const failed = printUninstallApplied(applied);
  // The apply phase re-reads Claude; if that read fails now (even though the preview's
  // succeeded), skill names couldn't be resolved and skill removal was dropped. Surface
  // it loudly instead of letting the apply look clean.
  // Base the exit on the APPLY outcome, not the stale preview block — a
  // preview that couldn't read Claude but an apply that then succeeded is a success.
  const ownership = uninstallClaudePolicy(applied);
  if (ownership.unreadable && applied.skillScope.length) {
    if (ownership.blockedAgents.length) {
      console.error(red(`couldn't read Claude's plugins during apply (${neutralPluginText(applied.claudeReadError)}) — bundled plugin content on ${ownership.blockedAgents.join(", ")} was NOT removed; re-run once Claude is available`));
    } else {
      // Only native-capable agents were skill-scoped — their native uninstall did the
      // work; we just couldn't check for any fallback-surfaced skills. Warn, don't fail.
      console.error(yellow(`note: Claude unreadable (${neutralPluginText(applied.claudeReadError)}) — couldn't check fallback plugin reach on ${ownership.warnAgents.join(", ")}; the native uninstall still applied`));
    }
  }
  if (failed > 0 || ownership.blockedAgents.length) process.exit(1);
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
  const { pluginReconcileTargets } = await import("../src/plugins/targets.ts");
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
  const agents = resolveAgentScope(
    values,
    pluginReconcileTargets().map((target) => target.agent),
    "add plugin",
  );
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

  // No command: open the Ink control center in a terminal. Non-interactive
  // invocations keep the static welcome + help contract.
  if (!cmd) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const { showInteractivePicker } = await import("../src/tui.ts");
      return showInteractivePicker();
    }
    const { renderWelcome } = await import("../src/welcome.tsx");
    await renderWelcome();
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
