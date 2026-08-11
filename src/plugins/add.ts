// Scoped plugin add — make ONE (or a few) chosen plugin reachable on a chosen set
// of agents. It's a narrowed `mirror`: where `mirror` pushes every plugin from a
// primary to every agent, this pushes the named plugins to just the agents you pick.
//
// A readable native plugin source supplies installed records and any validated local
// or marketplace evidence attached to them. For each chosen plugin, by target:
//   • Readable native targets install through their own adapter.
//   • Cursor (write-only) receives a repository or exact local artifact.
//   • Other agents receive the plugin's bundled reach and wrapper items additively.
// Additive only — never removes. A plugin not installed on the selected source is
// reported, not guessed at.

import { claudeMarketplaceClonePaths } from "./claude.ts";
import { pluginAdapters } from "./index.ts";
import {
  artifactFromPluginRecord,
  planArtifactLifecycle,
  type ArtifactPlan,
} from "./lifecycle.ts";
import { resolvePluginMcpServers } from "./mcp.ts";
import type { McpCohortResult } from "./mirror.ts";
import { openPluginsArgs, run } from "./shell.ts";
import type { PluginAdapterRead, PluginInstallResult, PluginRecord } from "./types.ts";
import { findAdapter } from "../adapters/index.ts";
import { diffServers } from "../mcp-state.ts";
import { addSkillSources, mcpCohort, skillCohort, type SkillAddResult } from "../skills.ts";
import type { AgentId, McpServer } from "../types.ts";

const CURSOR_PLUGINS_TIMEOUT_MS = 180_000;

export type PluginAddCursor = { repos: string[]; results: { repo: string; status: "installed" | "failed"; message?: string }[] };

export type PluginAddReport = {
  plugins: string[];
  requestedAgents: AgentId[];
  source: AgentId;
  // Set when the selected source's plugin list couldn't be read — nothing can be resolved.
  sourceError?: string;
  // Requested plugin names not installed on the source (can't be added elsewhere).
  notFound: string[];
  // Native installs on the scoped readable native targets.
  installs: PluginInstallResult[];
  // Plugin reach added to scoped non-native agents, plus native-target fallbacks.
  skills: SkillAddResult[];
  // Cursor push (only when cursor is in scope).
  cursor?: PluginAddCursor;
  // Plugin-bundled wrapper items lifted into scoped non-native agents.
  mcp: McpCohortResult[];
  applied: boolean;
};

export type PluginAddRunOpts = {
  plugins: string[];
  agents: AgentId[]; // validated by the caller
  apply: boolean;
  // Readable native source for the selected installed plugin records.
  // Defaults to Claude for compatibility with the original add command.
  from?: AgentId;
  // Register a missing marketplace on Codex before installing + fall unloadable
  // bundles back to skills. On by default (the point of an add is for it to land).
  provision?: boolean;
  onProgress?: (label: string, index: number, total: number) => void;
};

export async function runPluginAdd(opts: PluginAddRunOpts): Promise<PluginAddReport> {
  const provision = opts.provision ?? true;
  const requested = [...new Set(opts.agents)];
  const wantNames = [...new Set(opts.plugins)];
  const source = opts.from ?? "claude-code";

  const base: PluginAddReport = {
    plugins: wantNames,
    requestedAgents: requested,
    source,
    notFound: [],
    installs: [],
    skills: [],
    mcp: [],
    applied: opts.apply,
  };

  const sourceAdapter = pluginAdapters.find((adapter) => adapter.id === source);
  if (!sourceAdapter) {
    return {
      ...base,
      sourceError:
        `no readable plugin adapter for ${source}; readable sources: ` +
        pluginAdapters.map((adapter) => adapter.id).join(", "),
    };
  }
  let read: PluginAdapterRead;
  try {
    read = await sourceAdapter.read();
  } catch (err) {
    return {
      ...base,
      sourceError: `cannot read ${source} plugin state: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (read.error) {
    return {
      ...base,
      sourceError: `cannot read ${source} plugin state: ${read.error}`,
    };
  }

  const byName = new Map(read.plugins.map((p) => [p.name, p]));
  const chosen: PluginRecord[] = [];
  for (const name of wantNames) {
    const rec = byName.get(name);
    if (rec) chosen.push(rec);
    else base.notFound.push(name);
  }
  if (chosen.length === 0) return base;

  // Marketplace source maps are supplied by the selected readable adapter. Claude's
  // clone locations are special local evidence and must never be consulted for other
  // source agents.
  const sources = sourceAdapter.marketplaceSources
    ? await sourceAdapter.marketplaceSources()
    : undefined;
  const clonePaths = source === "claude-code"
    ? await claudeMarketplaceClonePaths()
    : undefined;
  const planned = await Promise.all(chosen.map(async (plugin) => {
    const artifact = await artifactFromPluginRecord(plugin, {
      agent: source,
      sourceRepo: plugin.sourceRepo ?? (plugin.marketplace ? sources?.get(plugin.marketplace) : undefined),
      marketplaceRoot: plugin.marketplace ? clonePaths?.get(plugin.marketplace) : undefined,
    });
    const plan = await planArtifactLifecycle({
      artifact,
      agent: source,
      mode: "verified",
      sourceRequired: true,
      provision,
      dryRun: !opts.apply,
    });
    return { plugin, plan };
  }));
  const sourcePlans = planned.map(({ plan }) => plan);
  const planByRecord = new Map(planned.map(({ plugin, plan }) => [plugin, plan]));
  const planOf = (plugin: PluginRecord): ArtifactPlan => planByRecord.get(plugin)!;
  const cursorSources = [...new Set(
    sourcePlans
      .map((plan) => plan.source.writeOnly?.value)
      .filter((source): source is string => !!source),
  )].sort();

  const targetRequested = requested.filter((agent) => agent !== source);
  const scopedSkillCohort = targetRequested.filter((a) => skillCohort().includes(a));
  const scopedMcpCohort = targetRequested.filter((a) => mcpCohort().includes(a));
  const wantCursor = targetRequested.includes("cursor");
  const nativeTargets = pluginAdapters.filter((a) => a.id !== source && targetRequested.includes(a.id));
  // Per target, plugins that landed natively in this run/preview. Loose skills and
  // decomposed MCP are filtered at plugin/repo granularity so one successful native
  // plugin never gets duplicated merely because a sibling plugin failed.
  const nativeCoverage = new Map<AgentId, Set<string>>();
  const recordNativeOutcome = (agent: AgentId, plan: ArtifactPlan, result: PluginInstallResult) => {
    // A real native attempt owns this plugin's runtime state even when it fails:
    // keep that failure explicit instead of silently installing a different loose
    // capability and making the overall result look successful. A preflight skip
    // (usually no usable source) did not attempt native installation, so it remains
    // eligible for the loose last-resort path.
    if (result.status === "skipped" && !result.coveredBy) return;
    let covered = nativeCoverage.get(agent);
    if (!covered) nativeCoverage.set(agent, covered = new Set());
    covered.add(plan.ownershipKey);
  };
  const loosePluginsFor = (agent: AgentId): PluginRecord[] => {
    const covered = nativeCoverage.get(agent);
    return covered
      ? chosen.filter((plugin) => !covered.has(planOf(plugin).ownershipKey))
      : chosen;
  };
  const looseSourcesFor = (agent: AgentId): string[] => {
    const covered = nativeCoverage.get(agent);
    return [...new Set(sourcePlans
      .filter((plan) => plan.ownership.skills && !covered?.has(plan.ownershipKey))
      .map((plan) => plan.source.skills?.value)
      .filter((source): source is string => !!source))];
  };

  if (!opts.apply) {
    // Preview: resolve what WOULD happen without shelling out.
    for (const adapter of nativeTargets) {
      for (const p of chosen) {
        const plan = await planArtifactLifecycle({
          artifact: planOf(p).artifact,
          agent: adapter.id,
          mode: "verified",
          sourceRequired: adapter.sourceRequired,
          provision,
          dryRun: true,
        });
        const result = await adapter.installPlugin(p.name, {
          ...plan.installOptions,
          dryRun: true,
        });
        base.installs.push(result);
        recordNativeOutcome(adapter.id, plan, result);
      }
    }
    if (wantCursor) base.cursor = { repos: cursorSources, results: [] };
    if (scopedSkillCohort.length) {
      const looseSources = new Set<string>();
      for (const agent of scopedSkillCohort) {
        for (const source of looseSourcesFor(agent)) looseSources.add(source);
      }
      base.skills.push(...await addSkillSources(
        [...looseSources],
        scopedSkillCohort,
        { dryRun: true },
      ));
    }
    if (scopedMcpCohort.length) {
      // Read+diff each agent so the dry-run reports only what would actually be added
      // (additive, conflict-safe) — not every bundled server regardless of what's present.
      for (const agent of scopedMcpCohort) {
        const { servers } = await resolvePluginMcpServers(loosePluginsFor(agent));
        const serverMap: Record<string, McpServer> = {};
        for (const s of servers) serverMap[s.name] = s.server;
        const adapter = findAdapter(agent);
        if (!adapter) {
          base.mcp.push({ agent, added: [], conflicts: [], status: "skipped", message: "no MCP adapter" });
          continue;
        }
        const aRead = await adapter.read();
        if (aRead.error) {
          base.mcp.push({ agent, added: [], conflicts: [], status: "failed", message: aRead.error });
          continue;
        }
        const diff = diffServers(serverMap, aRead.servers);
        base.mcp.push({ agent, added: diff.add, conflicts: diff.overwrite, status: "synced" });
      }
    }
    return base;
  }

  // --- Apply ---
  let step = 0;
  const total =
    (nativeTargets.length * chosen.length) +
    (wantCursor ? cursorSources.length : 0) +
    (scopedSkillCohort.length && sourcePlans.length ? scopedSkillCohort.length : 0) +
    (scopedMcpCohort.length ? scopedMcpCohort.length : 0);
  const tick = (label: string) => opts.onProgress?.(label, ++step, total);

  // Readable native targets (Codex and Copilot). Each adapter uses its runtime's
  // authoritative native contract and verifies the resulting install state.
  for (const adapter of nativeTargets) {
    for (const p of chosen) {
      tick(`${adapter.id}: ${p.name}`);
      const plan = await planArtifactLifecycle({
        artifact: planOf(p).artifact,
        agent: adapter.id,
        mode: "verified",
        sourceRequired: adapter.sourceRequired,
        provision,
        dryRun: false,
      });
      const res = await adapter.installPlugin(p.name, {
        ...plan.installOptions,
        dryRun: false,
      });
      base.installs.push(res);
      recordNativeOutcome(adapter.id, plan, res);
      // A bundle this native target couldn't load can still use the explicit
      // adapter-provided skills fallback. The failed/skipped native result remains
      // in the report, so this never masquerades as a full plugin success.
      if (res.skillsFallbackRepo && !skillCohort().includes(adapter.id)) {
        base.skills.push(...(await addSkillSources([res.skillsFallbackRepo], [adapter.id])));
      }
    }
  }

  // Cursor push by source repo (write-only target).
  if (wantCursor) {
    const results: PluginAddCursor["results"] = [];
    for (const source of cursorSources) {
      tick(`cursor: ${source}`);
      const r = await run("npx", openPluginsArgs(["add", source, "--target", "cursor", "-y"]), { timeoutMs: CURSOR_PLUGINS_TIMEOUT_MS });
      if (r.notFound) results.push({ repo: source, status: "failed", message: "`npx -y plugins@1.3.4` not found on PATH" });
      else if (r.timedOut) results.push({ repo: source, status: "failed", message: `timed out after ${CURSOR_PLUGINS_TIMEOUT_MS / 1000}s` });
      else if (!r.ok) results.push({ repo: source, status: "failed", message: r.stderr.trim() || `exit ${r.exitCode}` });
      else results.push({ repo: source, status: "installed" });
    }
    base.cursor = { repos: cursorSources, results };
  }

  // Skills → scoped non-plugin agents.
  if (scopedSkillCohort.length) {
    for (const agent of scopedSkillCohort) {
      tick(`skills → ${agent}`);
      const sources = looseSourcesFor(agent);
      if (sources.length) base.skills.push(...(await addSkillSources(sources, [agent])));
    }
  }

  // Plugin-bundled MCP servers → scoped non-plugin agents (additive, conflict-safe).
  if (scopedMcpCohort.length) {
    for (const agentId of scopedMcpCohort) {
      tick(`mcp → ${agentId}`);
      const { servers } = await resolvePluginMcpServers(loosePluginsFor(agentId));
      const serverMap: Record<string, McpServer> = {};
      for (const s of servers) serverMap[s.name] = s.server;
      const adapter = findAdapter(agentId);
      if (!adapter) {
        base.mcp.push({ agent: agentId, added: [], conflicts: [], status: "skipped", message: "no MCP adapter" });
        continue;
      }
      const aRead = await adapter.read();
      if (aRead.error) {
        base.mcp.push({ agent: agentId, added: [], conflicts: [], status: "failed", message: aRead.error });
        continue;
      }
      const diff = diffServers(serverMap, aRead.servers);
      if (diff.add.length === 0) {
        base.mcp.push({
          agent: agentId,
          added: [],
          conflicts: diff.overwrite,
          status: "skipped",
          message: diff.overwrite.length ? "conflict(s) left untouched" : "already present",
        });
        continue;
      }
      const next: Record<string, McpServer> = { ...aRead.servers };
      for (const name of diff.add) next[name] = serverMap[name]!;
      const write = await adapter.write(next, { dryRun: false });
      base.mcp.push({ agent: agentId, added: diff.add, conflicts: diff.overwrite, status: write.status, message: write.message });
    }
  }

  return base;
}

// Anything to do? (a chosen plugin resolvable on the source + at least one target.)
export function pluginAddHasWork(report: PluginAddReport): boolean {
  if (report.sourceError) return false;
  const resolvable = report.plugins.length - report.notFound.length;
  if (resolvable <= 0) return false;
  return (
    report.installs.some((i) => i.status === "installed" || i.status === "failed" || !!i.skillsFallbackRepo) ||
    (report.cursor?.repos.length ?? 0) > 0 ||
    report.skills.some((s) => s.status === "added" || s.status === "failed") ||
    report.mcp.some((m) => m.added.length > 0 || m.status === "failed")
  );
}
