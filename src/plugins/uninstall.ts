// Guarded plugin uninstall — the ONLY removal path for plugins, reached only by the
// explicit `syncthis plugin rm` command (never by sync or mirror). It removes, in
// the agents the user scoped to:
//   • the native plugin from the plugin-capable agents (Claude, Codex), and
//   • the artifact's surfaced skills from the non-plugin agents, and
//   • exact bundled MCP values still owned by that artifact.
//
// It is gated behind the same rails as MCP `rm`: an explicit agent scope, a diff
// printed before any write, TTY-confirm or `--yes`, and `--dry-run` (the preview).
//
// Inventory is the ownership source. Shared skills are kept, and bundled MCP is
// deleted only while the target's canonical value still equals the artifact's
// value; conflicts or user modifications are never overwritten or removed.

import { pluginAdapters } from "./index.ts";
import { parsePluginId } from "./shell.ts";
import type { PluginAdapterRead, PluginUninstallResult } from "./types.ts";
import { readPluginInventory } from "./inventory.ts";
import {
  artifactMatchesRequest,
  planArtifactLifecycle,
  type ArtifactPlan,
} from "./lifecycle.ts";
import { resolvePluginMcpServers } from "./mcp.ts";
import { findAdapter } from "../adapters/index.ts";
import { diffServers } from "../mcp-state.ts";
import {
  listInstalledSkills,
  pluginSkillIdentities,
  removeSkillNames,
  skillCohort,
  type SkillRemoveResult,
} from "../skills.ts";
import type { AgentId, McpServer, SyncStatus } from "../types.ts";

// Plugin-capable agents with a list+uninstall CLI. Cursor is a plugin target but
// write-only (no list CLI), so it can't be read or uninstalled from here.
const PLUGIN_UNINSTALL_AGENTS: readonly AgentId[] = pluginAdapters.map((a) => a.id);

export type NativeUninstallTarget = {
  agent: AgentId;
  plugin: string;
  marketplace?: string;
  // Currently installed on this agent? (computed from the agent's plugin list.)
  present: boolean;
  // Set when the agent's plugin list couldn't be read — we can't tell presence, so
  // an apply reports a failure rather than silently doing nothing.
  unreadable?: string;
};

export type SkillRemovalPlan = {
  // Skill names that will be removed from the skill-cohort agents in scope.
  names: string[];
  // Names NOT removed because another still-installed Claude plugin provides them.
  kept: string[];
  // Skill-cohort agents in scope that currently hold ≥1 of `names`. When the global
  // skill list is unreadable, falls back to every requested skill-cohort agent.
  agents: AgentId[];
};

export type McpRemovalPlan = {
  agent: AgentId;
  names: string[];
  kept: string[];
  conflicts: string[];
  unreadable?: string;
};

export type McpRemovalResult = {
  agent: AgentId;
  removed: string[];
  conflicts: string[];
  status: SyncStatus;
  message?: string;
};

export type UninstallReport = {
  plugins: string[];
  requestedAgents: AgentId[];
  // Requested agents that can't be touched at all (currently just Cursor — a
  // write-only plugin target with no list/uninstall CLI).
  unsupportedAgents: AgentId[];
  native: NativeUninstallTarget[];
  skills: SkillRemovalPlan;
  /** Exact degraded MCP values owned by the selected inventory artifacts. */
  mcp: McpRemovalPlan[];
  // Requested agents eligible for skill removal (skill cohort + Codex), regardless of
  // whether they currently hold a removable skill. Lets the caller tell that skill
  // removal was *intended* even when nothing resolved.
  skillScope: AgentId[];
  // The subset of skillScope whose ONLY removal mechanism is surfaced-skill removal.
  // A native-capable agent is included only when the requested plugin is absent
  // natively (so its content may be a prior loose fallback).
  requiredSkillAgents: AgentId[];
  // Set when Claude's plugin list (the source for mapping plugins → skill names)
  // couldn't be read. With it set, skill names can't be resolved — so a skill-only
  // scope must surface this rather than silently report "nothing to do".
  claudeReadError?: string;
  // Apply outputs (undefined in preview).
  nativeResults?: PluginUninstallResult[];
  skillResult?: SkillRemoveResult;
  mcpResults?: McpRemovalResult[];
  applied: boolean;
};

export type UninstallRunOpts = {
  plugins: string[];
  agents: AgentId[]; // already validated against known agent ids by the caller
  apply: boolean;
  keepData?: boolean;
  onProgress?: (label: string, index: number, total: number) => void;
};

// Candidate skill identities a single installed plugin contributes, read from its
// own install dir. Returns BOTH the SKILL.md frontmatter name and the leaf dir name
// (the install slug) per skill, so the caller can match against whichever identity
// `npx skills list`/`remove` uses (they normally agree, but a title-cased frontmatter
// name with a kebab install dir would otherwise be shown but never removed). Empty
// when the plugin has no known path or no skills.
async function pluginSkillIds(path: string | undefined): Promise<string[]> {
  if (!path) return [];
  return await pluginSkillIdentities(path);
}

function mcpEqual(left: McpServer, right: McpServer): boolean {
  const diff = diffServers({ value: left }, { value: right });
  return diff.add.length === 0 && diff.overwrite.length === 0;
}

type OwnedMcp = {
  servers: Map<string, McpServer>;
  conflicts: Set<string>;
};

async function resolveOwnedMcp(plans: ArtifactPlan[]): Promise<OwnedMcp> {
  const servers = new Map<string, McpServer>();
  const conflicts = new Set<string>();
  for (const plan of plans) {
    const root = plan.ownership.pluginRoot;
    if (!root || !plan.ownership.mcp) continue;
    const resolved = await resolvePluginMcpServers([{
      name: plan.artifact.canonicalName,
      marketplace: plan.artifact.marketplaces[0],
      path: root,
      enabled: true,
    }]);
    for (const item of resolved.servers) {
      const prior = servers.get(item.name);
      if (prior && !mcpEqual(prior, item.server)) {
        servers.delete(item.name);
        conflicts.add(item.name);
      } else if (!conflicts.has(item.name)) {
        servers.set(item.name, item.server);
      }
    }
  }
  return { servers, conflicts };
}

export async function runPluginUninstall(opts: UninstallRunOpts): Promise<UninstallReport> {
  const requested = [...new Set(opts.agents)];
  const pluginSet = [...new Set(opts.plugins)];
  const cohort = skillCohort();

  const unsupportedAgents = requested.filter(
    (a) => !PLUGIN_UNINSTALL_AGENTS.includes(a) && !cohort.includes(a),
  );

  // Each requested plugin is `name` or `name@marketplace`. A bare name targets every
  // installed instance of that name; an explicit marketplace narrows to one — so a
  // name installed from multiple marketplaces is never collapsed to an arbitrary pick.
  const specs = pluginSet.map((p) => parsePluginId(p));

  // Read native state once, then feed the same snapshots into inventory and the
  // guarded uninstall plan. Inventory is the ownership source for every degraded
  // component; Claude is no longer a separate policy database.
  const adapterReads: PluginAdapterRead[] = [];
  const inventoryAdapters = pluginAdapters.filter(
    (adapter) => adapter.id === "claude-code" || requested.includes(adapter.id),
  );
  for (const adapter of inventoryAdapters) {
    try {
      adapterReads.push(await adapter.read());
    } catch (err) {
      adapterReads.push({
        agent: adapter.id,
        configPath: adapter.configPath(),
        exists: false,
        plugins: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const readsByAgent = new Map(adapterReads.map((read) => [read.agent, read]));
  const claudeReadError = readsByAgent.get("claude-code")?.error;
  const inventory = await readPluginInventory({ adapterReads });
  const selectedArtifacts = inventory.artifacts.filter((artifact) =>
    specs.some((spec) => artifactMatchesRequest(artifact, spec))
  );
  const survivingArtifacts = inventory.artifacts.filter(
    (artifact) => !selectedArtifacts.includes(artifact),
  );
  const selectedPlans = await Promise.all(selectedArtifacts.map((artifact) =>
    planArtifactLifecycle({
      artifact,
      agent: "claude-code",
      mode: "none",
      sourceRequired: false,
      provision: false,
      dryRun: !opts.apply,
    })
  ));
  const ownershipReadError =
    claudeReadError &&
    (selectedPlans.length === 0 ||
      selectedPlans.every((plan) => !plan.ownership.pluginRoot))
      ? claudeReadError
      : undefined;
  const survivingPlans = await Promise.all(survivingArtifacts.map((artifact) =>
    planArtifactLifecycle({
      artifact,
      agent: "claude-code",
      mode: "none",
      sourceRequired: false,
      provision: false,
      dryRun: !opts.apply,
    })
  ));

  // --- Native plugin uninstall targets (readable plugin runtimes in scope) ---
  const native: NativeUninstallTarget[] = [];
  for (const adapter of pluginAdapters) {
    if (!requested.includes(adapter.id)) continue;
    const read = readsByAgent.get(adapter.id)!;
    const targetPlans = await Promise.all(selectedArtifacts.map((artifact) =>
      planArtifactLifecycle({
        artifact,
        agent: adapter.id,
        mode: "verified",
        targetRead: read,
        sourceRequired: false,
        provision: false,
        dryRun: !opts.apply,
      })
    ));
    for (const spec of specs) {
      if (read.error) {
        native.push({ agent: adapter.id, plugin: spec.name, marketplace: spec.marketplace, present: false, unreadable: read.error });
        continue;
      }
      const matches = new Map<string, PluginAdapterRead["plugins"][number]>();
      for (const plan of targetPlans) {
        if (!artifactMatchesRequest(plan.artifact, spec)) continue;
        for (const record of plan.activeRecords) {
          const id = record.marketplace
            ? `${record.name}@${record.marketplace}`
            : record.name;
          matches.set(id, record);
        }
      }
      if (matches.size === 0) {
        native.push({ agent: adapter.id, plugin: spec.name, marketplace: spec.marketplace, present: false });
      } else {
        for (const rec of matches.values()) {
          native.push({ agent: adapter.id, plugin: rec.name, marketplace: rec.marketplace, present: true });
        }
      }
    }
  }

  // --- Plugin-derived skill removal ---
  // Candidate agents = the skill cohort PLUS Codex. The mirror's fallback adds a
  // plugin's skills to Codex via `npx skills add` when Codex can't load it as a
  // plugin, so those flat skills must be removable here too. (A Codex-native plugin's
  // skills are namespaced inside the plugin, not in the npx store, so the presence
  // filter below won't match them — the native uninstall handles those.)
  const skillRemovalAgents = [...new Set<AgentId>([...cohort, "codex"])];
  const skillAgents = requested.filter((a) => skillRemovalAgents.includes(a));

  // The authoritative skill identities are what `npx skills list` reports — the same
  // ones `npx skills remove -s` matches. Resolve the plugins' contributed skills to
  // those identities (matching by frontmatter name OR install-slug), so the names we
  // remove are exactly what the CLI recognizes. When the list is unreadable, fall back
  // to the raw candidate identities (degraded, best-effort).
  const installed = await listInstalledSkills();
  const installedNames = installed ? new Set(installed.map((s) => s.name)) : null;

  // Resolve degraded skills from every inventory artifact, then subtract names
  // still owned by a surviving artifact.
  const removeNames = new Set<string>();
  const keepNames = new Set<string>();
  await Promise.all([
    ...selectedPlans.map(async (plan) => {
      const ids = await pluginSkillIds(plan.ownership.pluginRoot);
      const resolved = installedNames ? ids.filter((n) => installedNames.has(n)) : ids;
      for (const name of resolved) removeNames.add(name);
    }),
    ...survivingPlans.map(async (plan) => {
      const ids = await pluginSkillIds(plan.ownership.pluginRoot);
      const resolved = installedNames ? ids.filter((n) => installedNames.has(n)) : ids;
      for (const name of resolved) keepNames.add(name);
    }),
  ]);
  const kept = [...removeNames].filter((n) => keepNames.has(n)).sort();
  const namesToRemove = [...removeNames].filter((n) => !keepNames.has(n)).sort();

  // Narrow the candidate agents to those that actually hold a removable skill, so the
  // diff is honest. If the global list is unreadable, keep every requested one.
  let effectiveSkillAgents = skillAgents;
  if (installed && namesToRemove.length > 0) {
    const removeSet = new Set(namesToRemove);
    const present = new Set<AgentId>();
    for (const s of installed) {
      if (removeSet.has(s.name)) for (const a of s.agents) if (skillAgents.includes(a)) present.add(a);
    }
    effectiveSkillAgents = [...present];
  } else if (namesToRemove.length === 0) {
    effectiveSkillAgents = [];
  }

  const skills: SkillRemovalPlan = { names: namesToRemove, kept, agents: effectiveSkillAgents.sort() };

  // --- Plugin-derived MCP removal ---
  // Only non-native/degraded ownership is eligible. A current value must still
  // equal the selected artifact's bundled canonical value; conflicts and values
  // shared by surviving artifacts are retained.
  const mcp: McpRemovalPlan[] = [];
  const mcpOwnedByAgent = new Map<AgentId, Map<string, McpServer>>();
  const survivingMcp = await resolveOwnedMcp(survivingPlans);
  for (const agent of requested) {
    const adapter = findAdapter(agent);
    if (!adapter) continue;
    const nativeRead = readsByAgent.get(agent);
    const degradedPlans = await Promise.all(selectedArtifacts.map(async (artifact) =>
      planArtifactLifecycle({
        artifact,
        agent,
        mode: nativeRead ? "verified" : "none",
        targetRead: nativeRead,
        sourceRequired: false,
        provision: false,
        dryRun: !opts.apply,
      })
    ));
    const owned = await resolveOwnedMcp(
      degradedPlans.filter((plan) => plan.activeRecords.length === 0),
    );
    if (owned.servers.size === 0 && owned.conflicts.size === 0) continue;

    let current: Awaited<ReturnType<typeof adapter.read>>;
    try {
      current = await adapter.read();
    } catch (err) {
      mcp.push({
        agent,
        names: [],
        kept: [],
        conflicts: [...owned.conflicts].sort(),
        unreadable: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (current.error) {
      mcp.push({
        agent,
        names: [],
        kept: [],
        conflicts: [...owned.conflicts].sort(),
        unreadable: current.error,
      });
      continue;
    }

    const names: string[] = [];
    const keptMcp: string[] = [];
    const conflicts = new Set(owned.conflicts);
    const exactOwned = new Map<string, McpServer>();
    for (const [name, bundled] of owned.servers) {
      const currentValue = current.servers[name];
      if (!currentValue) continue;
      if (!mcpEqual(bundled, currentValue)) {
        conflicts.add(name);
        continue;
      }
      const surviving = survivingMcp.servers.get(name);
      if (surviving && mcpEqual(surviving, currentValue)) {
        keptMcp.push(name);
        continue;
      }
      names.push(name);
      exactOwned.set(name, bundled);
    }
    if (exactOwned.size > 0) mcpOwnedByAgent.set(agent, exactOwned);
    mcp.push({
      agent,
      names: names.sort(),
      kept: keptMcp.sort(),
      conflicts: [...conflicts].sort(),
    });
  }
  const base = {
    plugins: pluginSet,
    requestedAgents: requested,
    unsupportedAgents,
    native,
    skills,
    mcp,
    skillScope: skillAgents.slice().sort(),
    requiredSkillAgents: requested
      .filter((a) => skillAgents.includes(a))
      .filter((a) => {
        const nativeTargets = native.filter((target) => target.agent === a);
        return nativeTargets.length === 0 || nativeTargets.every((target) => !target.present && !target.unreadable);
      })
      .sort(),
    ...(ownershipReadError ? { claudeReadError: ownershipReadError } : {}),
  };

  if (!opts.apply) {
    return { ...base, applied: false };
  }

  // --- Apply ---
  const items =
    native.filter((t) => t.present || t.unreadable).length +
    (skills.names.length && skills.agents.length ? 1 : 0) +
    mcp.filter((target) => target.names.length > 0 || target.unreadable).length;
  let step = 0;
  const nativeResults: PluginUninstallResult[] = [];
  for (const t of native) {
    if (t.unreadable) {
      nativeResults.push({ agent: t.agent, target: t.plugin, status: "failed", message: `cannot read plugins: ${t.unreadable}` });
      continue;
    }
    if (!t.present) {
      nativeResults.push({ agent: t.agent, target: t.marketplace ? `${t.plugin}@${t.marketplace}` : t.plugin, status: "absent" });
      continue;
    }
    const adapter = pluginAdapters.find((a) => a.id === t.agent)!;
    step += 1;
    opts.onProgress?.(`${t.agent}: uninstall ${t.plugin}`, step, items);
    nativeResults.push(await adapter.uninstallPlugin(t.plugin, { dryRun: false, marketplace: t.marketplace, keepData: opts.keepData }));
  }

  let skillResult: SkillRemoveResult | undefined;
  if (skills.names.length > 0 && skills.agents.length > 0) {
    step += 1;
    opts.onProgress?.(`skills: remove ${skills.names.length} from ${skills.agents.length} agent(s)`, step, items);
    skillResult = await removeSkillNames(skills.names, skills.agents);
  }

  const mcpResults: McpRemovalResult[] = [];
  for (const target of mcp) {
    if (target.unreadable) {
      mcpResults.push({
        agent: target.agent,
        removed: [],
        conflicts: target.conflicts,
        status: "failed",
        message: `cannot read MCP target: ${target.unreadable}`,
      });
      continue;
    }
    if (target.names.length === 0) {
      mcpResults.push({
        agent: target.agent,
        removed: [],
        conflicts: target.conflicts,
        status: "unchanged",
        message: target.conflicts.length
          ? "conflicting or user-modified MCP server(s) left untouched"
          : "no owned degraded MCP servers present",
      });
      continue;
    }
    const adapter = findAdapter(target.agent)!;
    const owned = mcpOwnedByAgent.get(target.agent) ?? new Map();
    let current: Awaited<ReturnType<typeof adapter.read>>;
    try {
      current = await adapter.read();
    } catch (err) {
      mcpResults.push({
        agent: target.agent,
        removed: [],
        conflicts: target.conflicts,
        status: "failed",
        message: `cannot freshly read MCP target: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (current.error) {
      mcpResults.push({
        agent: target.agent,
        removed: [],
        conflicts: target.conflicts,
        status: "failed",
        message: `cannot freshly read MCP target: ${current.error}`,
      });
      continue;
    }

    const next = { ...current.servers };
    const removed: string[] = [];
    const changed = new Set(target.conflicts);
    for (const name of target.names) {
      const bundled = owned.get(name);
      const currentValue = current.servers[name];
      if (!bundled || !currentValue || !mcpEqual(bundled, currentValue)) {
        if (currentValue) changed.add(name);
        continue;
      }
      delete next[name];
      removed.push(name);
    }
    if (removed.length === 0) {
      mcpResults.push({
        agent: target.agent,
        removed: [],
        conflicts: [...changed].sort(),
        status: "unchanged",
        message: "owned MCP values changed before apply; left untouched",
      });
      continue;
    }

    step += 1;
    opts.onProgress?.(
      `mcp: remove ${removed.length} from ${target.agent}`,
      step,
      items,
    );
    try {
      const write = await adapter.write(next, { dryRun: false });
      if (write.status === "failed") {
        mcpResults.push({
          agent: target.agent,
          removed: [],
          conflicts: [...changed].sort(),
          status: "failed",
          message: write.message,
        });
        continue;
      }
      const verified = await adapter.read();
      if (verified.error || removed.some((name) => name in verified.servers)) {
        mcpResults.push({
          agent: target.agent,
          removed: [],
          conflicts: [...changed].sort(),
          status: "failed",
          message: verified.error
            ? `MCP removal verification failed: ${verified.error}`
            : "MCP writer returned successfully, but a fresh read still contains an owned server",
        });
        continue;
      }
      mcpResults.push({
        agent: target.agent,
        removed: removed.sort(),
        conflicts: [...changed].sort(),
        status: write.status === "skipped" ? "skipped" : "synced",
        message: write.message,
      });
    } catch (err) {
      mcpResults.push({
        agent: target.agent,
        removed: [],
        conflicts: [...changed].sort(),
        status: "failed",
        message: `cannot write MCP target: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { ...base, nativeResults, skillResult, mcpResults, applied: true };
}

// Anything to actually do? (native, degraded skills, or an exact owned MCP value.)
export function uninstallHasChanges(report: UninstallReport): boolean {
  return (
    report.native.some((t) => t.present || t.unreadable) ||
    (report.skills.names.length > 0 && report.skills.agents.length > 0) ||
    report.mcp.some((target) => target.names.length > 0 || !!target.unreadable)
  );
}
