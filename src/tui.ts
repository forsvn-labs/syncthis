import { MultiSelectPrompt } from "@clack/core";
import { intro, outro, select, text, isCancel, cancel, log, note, spinner } from "@clack/prompts";
import { findAdapter, listAgentIds } from "./adapters/index.ts";
import {
  runRemove,
  runSelectiveMcpSync,
  runSkillsOnly,
  runSync,
  type SelectiveMcpReport,
} from "./sync.ts";
import { runDoctor } from "./doctor.ts";
import { listPlugins, pluginAdapters } from "./plugins/index.ts";
import { claudeMarketplaceClonePaths } from "./plugins/claude.ts";
import { readLocalMarketplace } from "./plugins/marketplace.ts";
import { buildPluginOverview } from "./plugins/overview.ts";
import { runPluginUninstall, uninstallHasChanges } from "./plugins/uninstall.ts";
import { runPluginAdd, pluginAddHasWork, type PluginAddReport } from "./plugins/add.ts";
import {
  addInstalledSkillsToAgents,
  addSkillRepos,
  addSkillsFromPlugins,
  listInstalledSkills,
  removeSkillNames,
  skillCohort,
} from "./skills.ts";
import {
  buildRows,
  groupPluginsByMarketplace,
  isAllSelected,
  isGroupSelected,
  itemValues,
  nextSelectionForRow,
  type PickerItem,
  type PickerRow,
} from "./picker-logic.ts";
import { S, c, breadcrumb } from "./tui-style.ts";
import type { AgentId } from "./types.ts";
import type { PluginRecord } from "./plugins/types.ts";

const MAX_MENU_ITEMS = 12;

type MainChoice = "plugins" | "skills" | "mcp" | "doctor" | "quit";
type MenuOption<T extends string> = { value: T; label: string; hint?: string };
type MenuResult = "back" | "done";

class FlowCancel extends Error {}

// Orientation header for a multi-step flow: a breadcrumb title + a one-line "what this
// does", rendered once at the top of each operation so the user always knows where they
// are in the source → items → destinations → preview → confirm walk and what it produces.
function flowHeader(path: string[], what: string) {
  note(what, breadcrumb(path));
}

export async function showInteractivePicker(): Promise<void> {
  intro("syncthis");

  note(
    "Pick what to manage. Each flow: source → items (space toggles, type to filter) → destinations → preview → confirm.",
    "what is this?",
  );

  try {
    while (true) {
      const choice = await pickOne<MainChoice>("What do you want to manage?", [
        { value: "plugins", label: "Manage plugins", hint: "sync, list, remove" },
        { value: "skills", label: "Manage skills", hint: "share, add, sync from plugins, remove" },
        { value: "mcp", label: "Manage MCPs", hint: "sync or remove MCP servers" },
        { value: "doctor", label: "Check problems", hint: "MCP coverage + conflicts" },
        { value: "quit", label: "Quit" },
      ]);
      if (!choice || choice === "quit") {
        cancel("aborted - nothing was changed.");
        return;
      }

      let result: MenuResult = "done";
      switch (choice) {
        case "plugins":
          result = await managePlugins();
          break;
        case "skills":
          result = await manageSkills();
          break;
        case "mcp":
          result = await manageMcps();
          break;
        case "doctor":
          await doDoctor();
          result = "done";
          break;
      }
      if (result === "back") continue;
      break;
    }
  } catch (err) {
    if (err instanceof FlowCancel) return;
    cancel(err instanceof Error ? err.message : String(err));
    return;
  }

  outro("Done. Re-run `syncthis` anytime, or `syncthis help` for the full command list.");
}

async function managePlugins(): Promise<MenuResult> {
  const op = await pickOne<"sync" | "list" | "remove" | "back">("Plugins: what do you want to do?", [
    { value: "sync", label: "Sync plugins", hint: "choose source, plugins (grouped by marketplace), then destinations" },
    { value: "list", label: "List installed plugins", hint: "read-only overview" },
    { value: "remove", label: "Remove plugins", hint: "guarded uninstall + surfaced skill removal" },
    { value: "back", label: "Back" },
  ]);
  if (!op || op === "back") return "back";
  if (op === "sync") await syncPlugins();
  else if (op === "list") await doPluginList();
  else await removePlugins();
  return "done";
}

async function manageSkills(): Promise<MenuResult> {
  const op = await pickOne<"share" | "add" | "plugin-derived" | "update" | "remove" | "back">(
    "Skills: what do you want to do?",
    [
      { value: "share", label: "Share installed skills", hint: "copy a source agent's skills to other agents" },
      { value: "add", label: "Add from repo", hint: "npx skills add <repo>" },
      { value: "plugin-derived", label: "Sync from plugins", hint: "surface Claude plugin skills to chosen agents" },
      { value: "update", label: "Update installed skills", hint: "npx skills update -y" },
      { value: "remove", label: "Remove skills", hint: "guarded npx skills remove" },
      { value: "back", label: "Back" },
    ],
  );
  if (!op || op === "back") return "back";
  if (op === "share") await shareSkills();
  else if (op === "add") await addSkillsFromRepo();
  else if (op === "plugin-derived") await syncPluginDerivedSkills();
  else if (op === "update") await doSkills();
  else await removeSkills();
  return "done";
}

async function manageMcps(): Promise<MenuResult> {
  const op = await pickOne<"sync" | "everything" | "mcp-only" | "remove" | "doctor" | "back">("MCPs: what do you want to do?", [
    { value: "everything", label: "Sync everything", hint: "MCP union + plugin-derived skills + skills update" },
    { value: "sync", label: "Sync selected MCPs", hint: "add selected servers from one agent to others" },
    { value: "mcp-only", label: "Sync all MCPs only", hint: "union sync across every MCP agent, skip skills" },
    { value: "remove", label: "Remove MCPs", hint: "explicit scope + diff + confirm" },
    { value: "doctor", label: "Check problems", hint: "coverage + conflicts" },
    { value: "back", label: "Back" },
  ]);
  if (!op || op === "back") return "back";
  if (op === "sync") await syncSelectedMcps();
  else if (op === "everything") {
    flowHeader(["MCPs", "Sync everything"], "MCP union sync across every agent, then surface plugin-derived skills and run a skills update.");
    await doSync({ skipSkills: false });
  } else if (op === "mcp-only") {
    flowHeader(["MCPs", "Sync all MCPs only"], "Union sync MCP servers across every agent. Skips all skill steps.");
    await doSync({ skipSkills: true });
  } else if (op === "doctor") await doDoctor();
  else await removeMcps();
  return "done";
}

async function doSync(opts: { skipSkills?: boolean }) {
  const s = spinner();
  s.start(opts.skipSkills ? "Syncing MCP servers across agents..." : "Syncing MCP servers + skills across agents...");
  const r = await runSync({
    skipSkills: opts.skipSkills,
    onPluginSkillProgress: (repo, i, total) => s.message(`adding plugin skills to other agents... ${i}/${total} (${repo})`),
  });
  s.stop("Sync complete.");

  const names = new Set<string>();
  for (const read of r.reads) for (const n of Object.keys(read.servers)) names.add(n);
  log.success(`Shared ${names.size} MCP server(s) across ${r.reads.length} agents.`);
  if (r.conflicts.length) log.warn(`${r.conflicts.length} conflict(s) left untouched - run "Check problems" for detail.`);
  const failed = r.writes.filter((w) => w.status === "failed");
  if (failed.length) log.error(`${failed.length} agent(s) couldn't be written.`);

  if (r.pluginSkills?.ran) {
    const added = r.pluginSkills.results.filter((x) => x.status === "added").length;
    const skipped = r.pluginSkills.results.filter((x) => x.status === "skipped").length;
    const psFailed = r.pluginSkills.results.filter((x) => x.status === "failed").length;
    if (added || psFailed) {
      const parts = [`${added} added`, skipped ? `${skipped} already synced` : "", psFailed ? `${psFailed} failed` : ""].filter(Boolean);
      log.info(`Plugin skills -> ${r.pluginSkills.agents.length} non-plugin agents: ${parts.join(", ")}.`);
    }
  }

  if (r.skills) {
    if (!r.skills.ran) log.info(`Skills update: ${r.skills.message ?? "skipped"}.`);
    else if (r.skills.ok) log.success("Skills refreshed (npx skills update).");
    else log.error(`Skills update failed: ${r.skills.message ?? "unknown error"}.`);
  }
}

async function doSkills() {
  flowHeader(["Skills", "Update"], "Refresh every installed skill (npx skills update -y).");
  const r = await runSkillsOnly();
  if (r.ok) log.success("skills: npx skills update -y");
  else log.error(`skills: ${r.message ?? "failed"}`);
}

async function doDoctor() {
  flowHeader(["Check problems"], "MCP coverage and conflicts across every agent. Read-only.");
  const r = await runDoctor();
  const errors = r.reads.filter((rd) => rd.error).length;
  const missing = r.reads.filter((rd) => !rd.exists && !rd.error).length;
  const ok = r.reads.length - errors - missing;
  log.success(`${ok} agent(s) readable, ${missing} missing, ${errors} error(s)`);
  if (r.conflicts.length) log.warn(`${r.conflicts.length} conflict(s) - run \`syncthis doctor\` for detail`);
  if (r.unmanaged.length) log.info(`${r.unmanaged.length} unmanaged MCP config(s) detected`);
}

async function doPluginList() {
  flowHeader(["Plugins", "List"], "Read-only overview of plugins across every agent — native plugins plus plugin-derived skills on the non-plugin agents.");
  const o = await buildPluginOverview();
  for (const r of o.native) {
    if (r.error) log.error(`${r.agent}: ${r.error}`);
    else if (!r.exists) log.info(`${r.agent}: no config`);
    else log.success(`${r.agent}: ${r.plugins.length} plugin(s) - ${dedupe(r.plugins.map((p) => p.name)).join(", ") || "none"}`);
  }
  log.info("cursor: write-only plugin target - not readable");
  if (!o.skillsReadable) {
    log.warn("plugin-derived skills: `npx skills list` unavailable");
    return;
  }
  if (o.derivedRepos.length === 0) {
    log.info("plugin-derived skills: none surfaced yet (run the plugin sync flow)");
    return;
  }
  const lines = o.derived.map((d) => `${d.agent}: ${d.skills.length}`).join("  ");
  log.info(`plugin-derived skills (from ${o.derivedRepos.join(", ")}):\n${lines}`);
}

async function syncPlugins() {
  flowHeader(
    ["Plugins", "Sync"],
    "Share installed plugins from a source agent to others. Plugin agents get the plugin itself; non-plugin agents get its bundled skills + MCP servers. Additive — never uninstalls.",
  );
  // Claude is the only agent that can supply plugins to others (it exposes the
  // marketplace → repo map AND keeps every marketplace cloned on disk for the
  // network-free local-marketplace install). Present that honestly.
  const source = await pickOne<AgentId>("plugin source agent", [
    { value: "claude-code", label: "claude-code", hint: "the only agent that can supply plugins to others" },
  ]);
  if (!source) return;

  const adapter = pluginAdapters.find((a) => a.id === source);
  if (!adapter) throw new Error(`plugin source is not supported: ${source}`);
  const read = await adapter.read();
  if (read.error) {
    log.error(`can't read ${source}: ${read.error}`);
    return;
  }
  if (read.plugins.length === 0) {
    log.info(`no plugins installed on ${source}.`);
    return;
  }

  const scope = await pickOne<"installed" | "available">("which plugins to list?", [
    { value: "installed", label: `installed on ${source}`, hint: `${read.plugins.length} plugin(s) — what can be transferred` },
    { value: "available", label: "all available in marketplaces", hint: "browse the full set; uninstalled ones can't transfer" },
  ]);
  if (!scope) return;

  const items =
    scope === "available"
      ? await allAvailablePluginItems(read.plugins)
      : groupPluginsByMarketplace(read.plugins.map((p) => ({ name: p.name, marketplace: p.marketplace, installed: true })));

  const plugins = await pickPlugins("choose plugin(s) to sync", items);
  if (!plugins) return;

  const targets = pluginTargetAgents(source);
  const agents = await pickAgents(targets, "choose destination agent(s)");
  if (!agents) return;

  const preview = await runPluginAdd({ plugins, agents, apply: false });
  if (preview.sourceError) {
    log.error(`can't read claude-code (the source): ${preview.sourceError}`);
    return;
  }
  if (preview.notFound.length) log.warn(`not installed on ${source} (can't transfer): ${preview.notFound.join(", ")}`);
  printPluginAddPreview(preview);
  if (!pluginAddHasWork(preview)) {
    log.success("nothing to do.");
    return;
  }

  if (!(await confirmYes(`apply plugin sync from ${source}? plugin agents get plugins; non-plugin agents get derived skills/MCPs.`))) return;
  const s = spinner();
  s.start("Syncing plugins...");
  const applied = await runPluginAdd({
    plugins,
    agents,
    apply: true,
    onProgress: (label, i, total) => s.message(`${label}  (${i}/${total})`),
  }).catch((err) => {
    s.stop("Plugin sync failed.");
    throw err;
  });
  s.stop("Plugin sync applied.");
  printPluginAddApplied(applied);
}

// Every plugin available across Claude's cloned marketplaces, installed or not.
// Installed ones come first (no hint); the rest are flagged "not installed" — they
// show for browsing but a sync tool can't transfer them (runPluginAdd reports them
// as notFound). Grouped by marketplace for the picker.
async function allAvailablePluginItems(installed: PluginRecord[]): Promise<PickerItem[]> {
  const installedKeys = new Set(installed.map((p) => `${p.name} ${p.marketplace ?? ""}`));
  const records: { name: string; marketplace?: string; installed?: boolean }[] = installed.map((p) => ({
    name: p.name,
    marketplace: p.marketplace,
    installed: true,
  }));
  const clones = await claudeMarketplaceClonePaths();
  for (const [marketplace, clonePath] of clones) {
    const mp = await readLocalMarketplace(clonePath);
    if (!mp) continue;
    for (const name of mp.pluginNames) {
      if (installedKeys.has(`${name} ${marketplace}`)) continue;
      records.push({ name, marketplace, installed: false });
    }
  }
  return groupPluginsByMarketplace(records);
}

async function removePlugins() {
  flowHeader(["Plugins", "Remove"], "Guarded uninstall: removes the native plugin and its exact surfaced skills/MCP servers. You'll preview the exact changes and confirm before anything is removed.");
  const reads = await listPlugins();
  const names = dedupe(reads.flatMap((r) => (r.error ? [] : r.plugins.map((p) => p.name)))).sort();
  if (names.length === 0) {
    log.info("no plugins installed on claude-code or codex to uninstall.");
    return;
  }

  const plugins = await pickMany("choose plugin(s) to remove", names.map((n) => ({ value: n, label: n })));
  if (!plugins) return;

  const agentChoices = dedupe([...pluginAdapters.map((a) => a.id), ...skillCohort()]);
  const agents = await pickAgents(agentChoices, "remove from which agents?", agentChoices);
  if (!agents) return;

  const preview = await runPluginUninstall({ plugins, agents, apply: false });
  if (!uninstallHasChanges(preview)) {
    log.success("nothing to do - none of those plugins are installed on the chosen agents.");
    return;
  }
  const nativeHits = preview.native.filter((t) => t.present).map((t) => `${t.agent}:${t.plugin}`);
  if (nativeHits.length) log.info(`native plugin uninstall: ${nativeHits.join(", ")}`);
  if (preview.skills.names.length && preview.skills.agents.length) {
    log.info(`remove ${preview.skills.names.length} surfaced skill(s) from ${preview.skills.agents.length} agent(s): ${preview.skills.names.join(", ")}`);
  }
  if (preview.skills.kept.length) log.info(`keeping (still provided by another plugin): ${preview.skills.kept.join(", ")}`);
  for (const target of preview.mcp) {
    if (target.unreadable) {
      log.warn(`${target.agent}: MCP target unreadable (${target.unreadable})`);
    } else if (target.names.length) {
      log.info(`remove ${target.names.length} surfaced MCP server(s) from ${target.agent}: ${target.names.join(", ")}`);
    }
    if (target.kept.length) {
      log.info(`${target.agent}: keeping MCP still provided by another plugin: ${target.kept.join(", ")}`);
    }
    if (target.conflicts.length) {
      log.warn(`${target.agent}: modified MCP left untouched: ${target.conflicts.join(", ")}`);
    }
  }
  if (preview.claudeReadError && preview.skillScope.length) {
    log.warn(`couldn't read Claude's plugins (${preview.claudeReadError}) - surfaced skills on ${preview.skillScope.join(", ")} can't be resolved and will be left in place`);
  }

  if (!(await confirmYes("apply? this uninstalls plugins and removes their exact surfaced skills/MCP servers."))) return;

  const s = spinner();
  s.start("Removing plugins...");
  const applied = await runPluginUninstall({
    plugins,
    agents,
    apply: true,
    onProgress: (label, i, total) => s.message(`${label}  (${i}/${total})`),
  }).catch((err) => {
    s.stop("Remove failed.");
    throw err;
  });
  s.stop("Remove applied.");

  let removed = 0;
  let failed = 0;
  for (const res of applied.nativeResults ?? []) {
    if (res.status === "uninstalled") removed += 1;
    else if (res.status === "failed") failed += 1;
  }
  if (applied.skillResult) {
    if (applied.skillResult.status === "removed") removed += applied.skillResult.skills.length;
    else if (applied.skillResult.status === "failed") failed += 1;
  }
  for (const result of applied.mcpResults ?? []) {
    if (result.status === "synced") {
      removed += result.removed.length;
      log.info(`${result.agent}: removed ${result.removed.length} MCP server(s): ${result.removed.join(", ")}`);
    } else if (result.status === "failed") {
      failed += 1;
      log.error(`${result.agent}: MCP removal failed (${result.message ?? "unknown error"})`);
    }
    if (result.conflicts.length) {
      log.warn(`${result.agent}: modified MCP left untouched: ${result.conflicts.join(", ")}`);
    }
  }
  if (applied.claudeReadError && applied.skillScope.length) {
    const who = applied.requiredSkillAgents.length ? applied.requiredSkillAgents : applied.skillScope;
    log.warn(`claude unreadable (${applied.claudeReadError}) - surfaced skills on ${who.join(", ")} couldn't be resolved${applied.requiredSkillAgents.length ? " and were NOT removed" : " (native uninstall still applied)"}`);
  }
  if (failed > 0) log.error(`${removed} removed, ${failed} failed - run \`syncthis plugin rm\` for detail`);
  else log.success(`remove complete: ${removed} removed.`);
}

// Share already-installed skills from a chosen source agent onto other agents. The
// skills store is shared (~/.agents/skills), so this just adds the destination agents'
// symlinks via `npx skills add <storePath> -a <dest>` — but the source-agent framing
// matches the plugin/MCP flow ("bring this agent's skills to those agents").
async function shareSkills() {
  flowHeader(["Skills", "Share"], "Copy a source agent's installed skills onto other agents.");
  const installed = await listInstalledSkills();
  if (!installed || installed.length === 0) {
    log.info("no installed skills found (or `npx skills list` unavailable).");
    return;
  }
  const sourceAgents = dedupe(installed.flatMap((s) => s.agents)).sort();
  if (sourceAgents.length === 0) {
    log.info("no skills are registered on any agent syncthis knows.");
    return;
  }

  const source = await pickOne<AgentId>(
    "skills: source agent (whose skills to share)",
    sourceAgents.map((a) => ({ value: a, label: a })),
  );
  if (!source) return;

  const onSource = installed.filter((s) => s.agents.includes(source));
  if (onSource.length === 0) {
    log.info(`no skills on ${source}.`);
    return;
  }

  const names = await pickMany(
    "choose skill(s) to share",
    onSource.map((s) => ({ value: s.name, label: s.name })),
  );
  if (!names) return;

  const dests = await pickAgents(skillTargetAgents().filter((a) => a !== source), "share to which agent(s)?");
  if (!dests) return;

  const pathByName = new Map(installed.map((s) => [s.name, s.path]));
  const refs = names.map((n) => ({ name: n, path: pathByName.get(n) ?? "" }));
  log.info(`will add ${refs.length} skill(s) to ${dests.join(", ")}`);
  if (!(await confirmYes("apply skill share?"))) return;

  const s = spinner();
  s.start("Sharing skills...");
  const results = await addInstalledSkillsToAgents(refs, dests).catch((err) => {
    s.stop("Share failed.");
    throw err;
  });
  s.stop("Done.");
  const added = results.filter((r) => r.status === "added").length;
  const failed = results.filter((r) => r.status === "failed");
  for (const f of failed) log.error(`${f.repo}: ${f.message ?? "failed"}`);
  if (failed.length) log.error(`${added} added, ${failed.length} failed`);
  else log.success(`shared ${added} skill(s) to ${dests.length} agent(s).`);
}

async function addSkillsFromRepo() {
  flowHeader(["Skills", "Add from repo"], "Add skill repo(s) by owner/repo slug to chosen agents (via npx skills add).");
  const repoRaw = await text({
    message: "skill repo(s) to add (comma-separated)",
    placeholder: "owner/repo, owner/other",
  });
  if (isCancel(repoRaw)) stopFlow();
  const repos = dedupe(String(repoRaw).split(",").map((s) => s.trim()).filter(Boolean)).sort();
  if (repos.length === 0) stopFlow("no repos given.");

  const agents = await pickAgents(skillTargetAgents(), "add these skills to which agents?");
  if (!agents) return;

  log.info(`will run ${repos.length} repo add(s): ${formatSkillAddTargets(agents)}`);
  if (!(await confirmYes("apply skill add?"))) return;

  const s = spinner();
  s.start("Adding skills...");
  const results = await addSkillRepos(repos, agents).catch((err) => {
    s.stop("Add failed.");
    throw err;
  });
  s.stop("Done.");
  const failed = results.filter((r) => r.status === "failed");
  const added = results.filter((r) => r.status === "added").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  for (const f of failed) log.error(`${f.repo}: ${f.message ?? "failed"}`);
  if (failed.length) log.error(`${added} added, ${skipped} skipped, ${failed.length} failed`);
  else log.success(`skills add complete: ${added} added${skipped ? `, ${skipped} skipped` : ""}.`);
}

async function syncPluginDerivedSkills() {
  flowHeader(["Skills", "Sync from plugins"], "Surface the skills bundled inside your Claude plugins to the non-plugin agents that can't read plugins directly.");
  const source = await pickOne<AgentId>("plugin skill source agent", [
    { value: "claude-code", label: "claude-code", hint: "installed Claude plugins" },
  ]);
  if (!source) return;

  const agents = await pickAgents(skillCohort(), "sync plugin-derived skills to which agents?", skillCohort());
  if (!agents) return;

  const preview = await addSkillsFromPlugins({ dryRun: true, agents, force: true });
  if (!preview.ran) {
    log.info(preview.message ?? "no plugin-derived skills found.");
    return;
  }
  const wouldAdd = preview.results.filter((r) => r.status === "added").length;
  const skipped = preview.results.filter((r) => r.status === "skipped").length;
  log.info(`plugin-derived skills: ${preview.sources.length} source repo(s), ${wouldAdd} would add, ${skipped} already synced.`);
  if (!(await confirmYes(`sync plugin-derived skills from ${source} to ${agents.length} agent(s)?`))) return;

  const s = spinner();
  s.start("Syncing plugin-derived skills...");
  const applied = await addSkillsFromPlugins({
    agents,
    force: true,
    onProgress: (repo, i, total) => s.message(`${repo}  (${i}/${total})`),
  }).catch((err) => {
    s.stop("Skill sync failed.");
    throw err;
  });
  s.stop("Done.");
  const added = applied.results.filter((r) => r.status === "added").length;
  const failed = applied.results.filter((r) => r.status === "failed").length;
  const already = applied.results.filter((r) => r.status === "skipped").length;
  if (failed) log.error(`${added} added, ${already} skipped, ${failed} failed`);
  else log.success(`plugin-derived skills synced: ${added} added, ${already} skipped.`);
}

async function removeSkills() {
  flowHeader(["Skills", "Remove"], "Remove named skills from chosen agents. You'll confirm before anything is removed.");
  const installed = await listInstalledSkills();
  if (!installed || installed.length === 0) {
    log.info("no installed skills found (or `npx skills list` unavailable).");
    return;
  }
  const skills = await pickMany(
    "choose skill(s) to remove",
    installed.map((s) => ({ value: s.name, label: s.name, hint: s.agents.join(", ") })),
  );
  if (!skills) return;

  const agents = await pickAgents(skillTargetAgents(), "remove from which agents?");
  if (!agents) return;
  if (!(await confirmYes(`remove ${skills.length} skill(s) from ${agents.length} agent(s)?`))) return;

  const s = spinner();
  s.start("Removing skills...");
  const r = await removeSkillNames(skills, agents).catch((err) => {
    s.stop("Remove failed.");
    throw err;
  });
  s.stop("Done.");
  if (r.status === "failed") log.error(r.message ?? "failed");
  else log.success(`removed ${r.skills.length} skill(s) from ${r.agents.length} agent(s)`);
}

async function syncSelectedMcps() {
  flowHeader(["MCPs", "Sync selected"], "Additively share chosen MCP servers from one agent to others. A name that already exists with a different config is left untouched and reported — never overwritten.");
  const source = await pickOne<AgentId>("MCP source agent", listAgentIds().map((id) => ({ value: id, label: id })));
  if (!source) return;

  const adapter = findAdapter(source);
  if (!adapter) throw new Error(`unknown MCP source agent: ${source}`);
  const read = await adapter.read();
  if (read.error) {
    log.error(`can't read ${source}: ${read.error}`);
    return;
  }
  const names = Object.keys(read.servers).sort();
  if (names.length === 0) {
    log.info(`${source} has no MCP servers configured.`);
    return;
  }

  const servers = await pickMany("choose MCP server(s) to sync", names.map((n) => ({ value: n, label: n })));
  if (!servers) return;

  const destinations = await pickAgents(listAgentIds().filter((id) => id !== source), "choose destination agent(s)");
  if (!destinations) return;

  const preview = await runSelectiveMcpSync({ from: source, to: destinations, names: servers, apply: false });
  printMcpSyncPreview(preview);
  if (!hasMcpSyncChanges(preview)) {
    log.success("nothing to do - selected MCPs are already present or only conflict.");
    return;
  }
  if (!(await confirmYes("apply MCP sync? existing conflicting servers stay untouched."))) return;

  const s = spinner();
  s.start("Syncing selected MCPs...");
  const applied = await runSelectiveMcpSync({ from: source, to: destinations, names: servers, apply: true }).catch((err) => {
    s.stop("MCP sync failed.");
    throw err;
  });
  s.stop("Done.");
  printMcpSyncApplied(applied);
}

async function removeMcps() {
  flowHeader(["MCPs", "Remove"], "Remove MCP server(s) from chosen agents. You'll preview the exact writes and confirm first.");
  const doc = await runDoctor();
  const names = doc.coverage.map((c) => c.name).sort();
  if (names.length === 0) {
    log.info("no MCP servers configured in any agent.");
    return;
  }
  const servers = await pickMany("choose MCP server(s) to remove", names.map((n) => ({ value: n, label: n })));
  if (!servers) return;

  const agents = await pickAgents(listAgentIds(), "remove from which agents?");
  if (!agents) return;

  let willChange = false;
  for (const name of servers) {
    const preview = await runRemove({ name, agents, apply: false });
    const hits = preview.writes.filter((w) => w.status === "synced").map((w) => w.agent);
    if (hits.length) {
      willChange = true;
      log.info(`- ${name}: remove from ${hits.join(", ")}`);
    } else {
      log.info(`- ${name}: not present on the chosen agents`);
    }
  }
  if (!willChange) {
    log.success("nothing to do - none of those servers are on the chosen agents.");
    return;
  }
  if (!(await confirmYes(`remove ${servers.length} server(s) from ${agents.length} agent(s)?`))) return;

  const s = spinner();
  s.start("Removing MCPs...");
  let changed = 0;
  let failed = 0;
  try {
    for (const name of servers) {
      const r = await runRemove({ name, agents, apply: true });
      for (const w of r.writes) {
        if (w.status === "failed") failed += 1;
        else if (w.status === "synced") changed += 1;
      }
    }
  } catch (err) {
    s.stop("Remove failed.");
    throw err;
  }
  s.stop("Done.");
  if (failed) log.error(`${changed} write(s), ${failed} failed`);
  else log.success(`removed (${changed} write(s)) across ${agents.length} agent(s)`);
}

function printPluginAddPreview(report: PluginAddReport) {
  if (report.installs.length) log.info(`native plugin installs: ${report.installs.length}`);
  if (report.cursor?.repos.length) log.info(`cursor: ${report.cursor.repos.length} repo push(es) via npx plugins`);
  if (report.skills.length) log.info(`skills fallback: ${report.skills.length} repo add(s) via npx skills`);
  const mcpAdds = report.mcp.reduce((sum, r) => sum + r.added.length, 0);
  const mcpConflicts = report.mcp.reduce((sum, r) => sum + r.conflicts.length, 0);
  if (mcpAdds || mcpConflicts) log.info(`plugin MCP lift: ${mcpAdds} add(s), ${mcpConflicts} conflict(s) left untouched`);
}

function printPluginAddApplied(report: PluginAddReport) {
  let ok = 0;
  let failed = 0;
  for (const ins of report.installs) ins.status === "failed" ? (failed += 1) : (ok += 1);
  for (const sk of report.skills) sk.status === "failed" ? (failed += 1) : (ok += 1);
  for (const c of report.cursor?.results ?? []) c.status === "failed" ? (failed += 1) : (ok += 1);
  for (const m of report.mcp) {
    if (m.status === "failed") failed += 1;
    else if (m.added.length) ok += 1;
  }
  if (failed) log.error(`${ok} action(s) ok, ${failed} failed - run \`syncthis add plugin\` for detail`);
  else log.success(`plugin sync complete: ${ok} action(s).`);
}

function printMcpSyncPreview(report: SelectiveMcpReport) {
  if (report.notFound.length) log.warn(`not found on ${report.from}: ${report.notFound.join(", ")}`);
  for (const t of report.targets) {
    if (t.toRead.error) {
      log.error(`${t.to}: ${t.toRead.error}`);
      continue;
    }
    if (t.add.length) log.info(`${t.to}: +${t.add.join(", ")}`);
    if (t.conflicts.length) log.warn(`${t.to}: conflict(s) left untouched: ${t.conflicts.join(", ")}`);
  }
}

function printMcpSyncApplied(report: SelectiveMcpReport) {
  const added = report.targets.reduce((sum, t) => sum + t.add.length, 0);
  const failed = report.targets.filter((t) => t.write?.status === "failed").length;
  const conflicts = report.targets.reduce((sum, t) => sum + t.conflicts.length, 0);
  if (failed) log.error(`${added} MCP add(s), ${conflicts} conflict(s), ${failed} failed write(s)`);
  else log.success(`MCP sync complete: ${added} add(s), ${conflicts} conflict(s) left untouched.`);
}

function hasMcpSyncChanges(report: SelectiveMcpReport): boolean {
  return report.targets.some((t) => t.add.length > 0);
}

async function pickOne<T extends string>(
  message: string,
  options: Array<MenuOption<T>>,
  initialValue?: T,
): Promise<T | null> {
  const clean = dedupeOptions(options);
  if (clean.length === 0) {
    log.info("nothing to choose.");
    return null;
  }
  const raw = await select({
    message,
    options: clean as any,
    initialValue,
    maxItems: MAX_MENU_ITEMS,
  });
  if (isCancel(raw)) {
    stopFlow();
  }
  return raw as T;
}

// Flat multiselect with a visible "select all" control row (plus the `a` shortcut).
async function pickMany<T extends string>(
  message: string,
  options: Array<MenuOption<T>>,
  initialValues: T[] = [],
): Promise<T[] | null> {
  const clean = dedupeOptions(options);
  if (clean.length === 0) {
    log.info("nothing to choose.");
    return null;
  }
  const items: PickerItem[] = clean.map((o) => ({ value: o.value, label: o.label, hint: o.hint }));
  const rows = buildRows(items);
  const initial = initialValues.filter((v) => clean.some((o) => o.value === v));
  while (true) {
    const raw = await controlMultiselect({
      message,
      rows,
      initialValues: initial as string[],
      maxItems: MAX_MENU_ITEMS,
    });
    if (isCancel(raw)) {
      stopFlow();
    }
    const picked = raw as T[];
    if (picked.length > 0) return picked;
    log.warn("Select at least one item, or cancel with Ctrl-C.");
  }
}

// Grouped multiselect for plugins: a "select all" row plus a per-marketplace toggle
// row before each group's plugins. Space toggles whichever row the cursor is on.
async function pickPlugins(message: string, items: PickerItem[]): Promise<string[] | null> {
  if (items.length === 0) {
    log.info("nothing to choose.");
    return null;
  }
  const rows = buildRows(items, { grouped: true });
  while (true) {
    const raw = await controlMultiselect({
      message,
      rows,
      maxItems: MAX_MENU_ITEMS,
    });
    if (isCancel(raw)) {
      stopFlow();
    }
    const picked = raw as string[];
    if (picked.length > 0) return picked;
    log.warn("Select at least one item, or cancel with Ctrl-C.");
  }
}

// A windowed multiselect built on @clack/core's MultiSelectPrompt, extended to render
// "control" rows (a global select-all, and per-group toggles) alongside item rows, plus
// type-to-filter on long lists. Styling matches the native clack prompts (see tui-style).
// `this.value` only ever holds item values — control rows are never selected, they drive
// bulk selection. Toggle behavior is delegated to the pure picker-logic helpers, run
// against the CURRENT view (so "select all" while filtered toggles only the matches).
async function controlMultiselect(opts: {
  message: string;
  rows: PickerRow[];
  initialValues?: string[];
  maxItems: number;
}): Promise<string[] | symbol> {
  const fullRows = opts.rows;
  const grouped = fullRows.some((r) => r.kind === "group");
  const totalItems = itemValues(fullRows).length;
  // Only advertise/enable filtering once a list is long enough to be a scrolling chore.
  const filterable = totalItems > opts.maxItems;
  // Window height tracks the terminal (≈8 chrome lines), floored at 5 and capped at 24,
  // never exceeding the row count — so it grows on tall terminals and shrinks on short ones.
  const termRows = typeof process.stdout.rows === "number" ? process.stdout.rows : 24;
  const pageSize = Math.max(5, Math.min(termRows - 8, 24, fullRows.length));

  let filter = "";
  let view: PickerRow[] = fullRows;
  let windowStart = 0;

  // Rows to display for the current filter. Empty filter → the full structure (select-all
  // + group toggles + items). Non-empty → only matching item rows, with a synthetic
  // "select all (N matches)" so bulk-selecting a search result stays one keypress.
  const computeView = (): PickerRow[] => {
    const f = filter.trim().toLowerCase();
    if (!f) return fullRows;
    const matches = fullRows.filter(
      (r): r is Extract<PickerRow, { kind: "item" }> =>
        r.kind === "item" && (r.label.toLowerCase().includes(f) || r.value.toLowerCase().includes(f)),
    );
    if (matches.length > 1) {
      return [{ kind: "all", label: `select all (${matches.length} matches)` }, ...matches];
    }
    return matches;
  };

  const firstItemIdx = fullRows.findIndex((r) => r.kind === "item");
  const cursorAt = firstItemIdx >= 0 ? rowKey(fullRows[firstItemIdx]!, firstItemIdx) : undefined;

  const prompt = new MultiSelectPrompt<{ value: string; label: string }>({
    options: fullRows.map((r, i) => ({ value: rowKey(r, i), label: r.label })) as any,
    initialValues: opts.initialValues,
    cursorAt,
    render() {
      const head = `${c.gray(S.bar)}\n${stepSymbol(this.state)}  ${opts.message}`;
      const selected = new Set(this.value as string[]);
      if (this.state === "submit" || this.state === "cancel") {
        return `${head}\n${c.gray(S.bar)}  ${c.dim(`${selected.size} selected`)}`;
      }

      if (view.length > pageSize) {
        if (this.cursor >= windowStart + pageSize - 3) {
          windowStart = Math.max(Math.min(this.cursor - pageSize + 3, view.length - pageSize), 0);
        } else if (this.cursor < windowStart + 2) {
          windowStart = Math.max(this.cursor - 2, 0);
        }
      } else {
        windowStart = 0;
      }

      const above = windowStart;
      const below = Math.max(view.length - windowStart - pageSize, 0);
      const slice = view.slice(windowStart, windowStart + pageSize);

      const lines: string[] = [];
      const controls = filterable ? "type to filter · space toggles · enter confirms" : "space toggles · enter confirms";
      lines.push(c.dim(`${selected.size}/${totalItems} selected · ${controls}`));
      if (filter) lines.push(`${c.cyan("filter")} ${filter}${c.inverse(" ")}`);
      if (view.length === 0) lines.push(c.dim("no matches"));
      if (above > 0) lines.push(c.dim(`${S.up} ${above} more`));
      for (let i = 0; i < slice.length; i++) {
        const absolute = windowStart + i;
        // While filtering, matches are flat (no group headers) — drop the group indent.
        lines.push(formatRow(slice[i]!, { active: absolute === this.cursor, selected, rows: view, grouped: filter ? false : grouped }));
      }
      if (below > 0) lines.push(c.dim(`${S.down} ${below} more`));

      const bar = this.state === "error" ? c.yellow(S.bar) : c.gray(S.bar);
      const body = lines.map((l) => `${bar}  ${l}`).join("\n");
      const end = this.state === "error" ? `${c.yellow(S.barEnd)}  ${c.yellow(this.error)}` : c.gray(S.barEnd);
      return `${head}\n${body}\n${end}`;
    },
  });

  const p = prompt as unknown as {
    options: Array<{ value: string; label: string }>;
    cursor: number;
    value: string[];
    state: string;
    input: {
      on: (event: string, listener: (...args: any[]) => void) => void;
      removeListener: (event: string, listener: (...args: any[]) => void) => void;
    };
    render: () => void;
    toggleValue: () => void;
    toggleAll: () => void;
  };

  // Recompute the view after a filter change and keep clack's cursor nav in range: its
  // built-in handlers wrap on `this.options.length`, so options must mirror the view.
  const refreshView = () => {
    view = computeView();
    p.options = view.map((r, i) => ({ value: rowKey(r, i), label: r.label }));
    const firstItem = view.findIndex((r) => r.kind === "item");
    p.cursor = firstItem >= 0 ? firstItem : 0;
    windowStart = 0;
  };

  // Space toggles whichever row the cursor is on, against the current view. `a` is no
  // longer a select-all shortcut (freed for typing) — the visible select-all row is the
  // discoverable mechanism, so toggleAll is neutralized.
  p.toggleValue = function () {
    this.value = [...nextSelectionForRow(new Set(this.value), view, this.cursor)];
  };
  p.toggleAll = function () {};

  // Type-to-filter. Handled off the raw keypress object (not clack's lowercased `key`
  // event) so backspace/delete are reliable. Nav/space/enter keep their meaning.
  const onFilterKey = (ch: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
    if (p.state !== "active" && p.state !== "initial") return;
    if (key?.ctrl || key?.meta) return;
    const name = key?.name;
    if (name === "backspace" || name === "delete") {
      if (filter) {
        filter = filter.slice(0, -1);
        refreshView();
        p.render();
      }
      return;
    }
    if (name && ["space", "return", "enter", "up", "down", "left", "right", "tab", "escape"].includes(name)) return;
    if (typeof ch === "string" && ch.length === 1 && ch >= " " && ch <= "~") {
      filter += ch.toLowerCase();
      refreshView();
      p.render();
    }
  };

  // p.input is the shared process.stdin and clack's close() only removes its own
  // listener — so we must remove ours, or it leaks across every prompt in the session.
  if (filterable) p.input.on("keypress", onFilterKey);
  try {
    return (await prompt.prompt()) as string[] | symbol;
  } finally {
    if (filterable) p.input.removeListener("keypress", onFilterKey);
  }
}

// Option value for a row. Items use their real value (the selection token); control
// rows use a NUL-prefixed sentinel so they never collide with a real value and never
// enter the returned selection.
function rowKey(row: PickerRow, index: number): string {
  if (row.kind === "item") return row.value;
  if (row.kind === "all") return "\x00all";
  return `\x00grp:${index}`;
}

// One row, styled to match clack: cyan pointer + cyan box on the active row, green box
// when selected, dim otherwise. Group rows carry a glyph + bold label so the marketplace
// hierarchy reads at a glance against its indented, dimmed children.
function formatRow(
  row: PickerRow,
  ctx: { active: boolean; selected: Set<string>; rows: PickerRow[]; grouped: boolean },
): string {
  const pointer = ctx.active ? c.cyan(S.pointer) : " ";
  const checkbox = (on: boolean) => (on ? c.green(S.checkboxOn) : ctx.active ? c.cyan(S.checkboxOff) : c.dim(S.checkboxOff));

  if (row.kind === "all") {
    const label = ctx.active ? c.cyan(row.label) : c.bold(row.label);
    return `${pointer} ${checkbox(isAllSelected(ctx.selected, ctx.rows))} ${label}`;
  }
  if (row.kind === "group") {
    const label = ctx.active ? c.cyan(c.bold(row.label)) : c.bold(row.label);
    return `${pointer} ${c.yellow(S.group)} ${checkbox(isGroupSelected(ctx.selected, ctx.rows, row.group))} ${label}`;
  }
  const on = ctx.selected.has(row.value);
  const indent = ctx.grouped ? "  " : "";
  const text = `${row.label}${row.hint ? ` (${row.hint})` : ""}`;
  const label = ctx.active ? c.cyan(text) : on ? text : c.dim(text);
  return `${pointer} ${indent}${checkbox(on)} ${label}`;
}

function stepSymbol(state: string): string {
  if (state === "submit") return c.green(S.submit);
  if (state === "cancel") return c.red(S.cancel);
  if (state === "error") return c.yellow(S.error);
  return c.cyan(S.active);
}

async function pickAgents(known: AgentId[], message: string, initial?: AgentId[]): Promise<AgentId[] | null> {
  return pickMany(message, known.map((a) => ({ value: a, label: a })), initial);
}

async function confirmYes(message: string): Promise<boolean> {
  const c = await pickOne<"no" | "yes">(message, [
    { value: "no", label: "No" },
    { value: "yes", label: "Yes" },
  ]);
  if (c !== "yes") {
    stopFlow();
  }
  return true;
}

function stopFlow(message = "aborted."): never {
  cancel(message);
  throw new FlowCancel(message);
}

function pluginTargetAgents(source: AgentId): AgentId[] {
  return dedupe<AgentId>([...pluginAdapters.map((a) => a.id), "cursor", ...skillCohort()]).filter((a) => a !== source);
}

function skillTargetAgents(): AgentId[] {
  return dedupe<AgentId>([...listAgentIds(), "pi"]);
}

function formatSkillAddTargets(agents: AgentId[]): string {
  return agents.map((a) => `-a ${a}`).join(" ");
}

function dedupe<T extends string>(items: T[]): T[] {
  return [...new Set(items)];
}

function dedupeOptions<T extends string>(options: Array<MenuOption<T>>): Array<MenuOption<T>> {
  const out: Array<MenuOption<T>> = [];
  const seen = new Set<T>();
  for (const option of options) {
    if (seen.has(option.value)) continue;
    seen.add(option.value);
    out.push(option);
  }
  return out;
}
