// Plugin mirror — additive primary → other-agent propagation.
//
// Reads the primary agent's installed plugins and makes that content reachable on
// every other agent, by the best mechanism each one has:
//   • Codex (native read+write plugin CLI): install each plugin; provision its
//     marketplace first when missing (on by default). A plugin Codex can't load as
//     a plugin — a skills-only bundle, or a multi-plugin marketplace alias whose
//     plugin.json name Codex rejects — falls back to `npx skills add` UNLESS the
//     same repo already landed as a real plugin (no flat/namespaced duplication).
//   • Cursor (write-only plugin target, no list CLI): pushed by source repo or an
//     exact standalone local artifact — additive, can't be diffed.
//   • The non-plugin agents (gemini, kimi, opencode, …): receive the primary's
//     plugin-bundled skills via `npx skills add` (vercel-labs/skills) AND the
//     primary's plugin-bundled MCP servers, lifted into their own MCP config (the
//     plugin cohort already gets those by installing the plugin).
//
// It is additive only: there is no uninstall path anywhere. A mirror can add a
// plugin/skill/MCP server to an agent, never remove one — so a mistake can't wipe
// plugins, and a name that already exists with a different config is left untouched.

import { claudeMarketplaceClonePaths } from "./claude.ts";
import { resolveSyncthisDataHome } from "./data-home.ts";
import { pluginAdapters } from "./index.ts";
import {
  artifactFromPluginRecord,
  planArtifactLifecycle,
  type ArtifactPlan,
} from "./lifecycle.ts";
import { resolvePluginMcpServers, type PluginMcpServer, type PluginMcpSkip } from "./mcp.ts";
import { openPluginsArgs, run } from "./shell.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginInstallResult,
  PluginRecord,
} from "./types.ts";
import { findAdapter } from "../adapters/index.ts";
import { diffServers } from "../mcp-state.ts";
import {
  addSkillSources,
  mcpCohort,
  resolveInstalledRepoCoverage,
  skillCohort,
  type PluginSkillSource,
  type PluginSkillsReport,
} from "../skills.ts";
import type { AgentId, McpServer, SyncStatus } from "../types.ts";

const CURSOR_PLUGINS_TIMEOUT_MS = 180_000;

export type MirrorDiff = {
  // Plugins present in primary but missing from the target → install (additive).
  add: PluginRecord[];
};

export type MirrorUnavailablePlugin = {
  plugin: PluginRecord;
  reason: string;
};

export type MirrorTarget = {
  to: AgentId;
  toRead: PluginAdapterRead;
  // null when the target's config could not be read (see unsupportedReason).
  diff: MirrorDiff | null;
  unsupportedReason?: string;
  unavailable?: MirrorUnavailablePlugin[];
  installs?: PluginInstallResult[];
  // Skills added to this target as a fallback for plugins it couldn't install
  // natively (skills-only bundles / unloadable aliases). Populated on apply only.
  skillsFallback?: SkillAddResult[];
};

export type CursorPushResult = { repo: string; status: "installed" | "failed"; message?: string };

// Cursor's write-only plugin push. The legacy `repos` field is retained, but its
// values may also be canonical absolute standalone artifact paths.
export type CursorPush = {
  supported: boolean;
  reason?: string;
  repos: string[];
  results: CursorPushResult[];
};

// The non-plugin agents' skill push. Driven from the primary's plugin-bundled
// skills (only a Claude primary can supply them). `report` carries the source
// repos (preview) and per-repo `npx skills add` results (apply).
export type MirrorSkillCohort = {
  supported: boolean;
  reason?: string;
  agents: AgentId[];
  report?: PluginSkillsReport;
};

// The non-plugin agents' bundled-MCP push. Driven from the primary's plugin-bundled
// MCP servers (only a Claude primary can supply them). `servers` is the resolved set
// (preview); `results` carries the per-agent additive write outcome (apply). Additive
// and conflict-safe: a server name already present with a different config is left
// untouched and surfaced as a conflict.
export type McpCohortResult = {
  agent: AgentId;
  added: string[];
  conflicts: string[];
  status: SyncStatus;
  message?: string;
};

export type MirrorMcpCohort = {
  supported: boolean;
  reason?: string;
  agents: AgentId[];
  servers: PluginMcpServer[];
  skipped: PluginMcpSkip[];
  results?: McpCohortResult[];
};

export type MirrorReport = {
  from: AgentId;
  fromRead: PluginAdapterRead;
  targets: MirrorTarget[];
  cursor: CursorPush;
  skillCohort: MirrorSkillCohort;
  mcpCohort: MirrorMcpCohort;
  applied: boolean;
};

export type MirrorRunOpts = {
  from: AgentId;
  apply: boolean;
  // Register a missing marketplace on a target before installing, and fall unloadable
  // bundles back to skills. ON by default (the point of a mirror is to make content
  // reachable); pass false (`--no-provision`) for an offline / no-network run.
  provision?: boolean;
  // Per-item progress for the apply phase. A full mirror runs many sequential
  // `npx`/`codex` network calls (codex installs + cursor pushes + skill adds) with
  // no other output, so without this the CLI/TUI look frozen. Called once per item.
  onProgress?: (label: string, index: number, total: number) => void;
};

type SkillAddResult = Awaited<ReturnType<typeof addSkillSources>>[number];

type PluginPlanPair = {
  plugin: PluginRecord;
  plan: ArtifactPlan;
};

type NativeInstallAttempt = PluginPlanPair & {
  result: PluginInstallResult;
};

function adapterFor(id: AgentId): PluginAdapter | undefined {
  return pluginAdapters.find((a) => a.id === id);
}

function addCoverage(
  coverage: Map<AgentId, Set<string>>,
  agent: AgentId,
  ownershipKey: string,
): void {
  let owners = coverage.get(agent);
  if (!owners) coverage.set(agent, owners = new Set());
  owners.add(ownershipKey);
}

export async function runMirror(opts: MirrorRunOpts): Promise<MirrorReport> {
  const provision = opts.provision ?? true;
  const primary = adapterFor(opts.from);
  if (!primary) {
    throw new Error(
      `mirror: ${opts.from} has no plugin adapter. plugin-capable agents: ${pluginAdapters.map((a) => a.id).join(", ")}`,
    );
  }
  const fromRead = await primary.read();
  if (fromRead.error) {
    throw new Error(`mirror: cannot read primary ${opts.from}: ${fromRead.error}`);
  }

  // The primary's marketplace name → owner/repo. Used to provision a marketplace a
  // target lacks, by the cursor push, and to map a plugin to its skills-fallback
  // repo. Fetched once; only Claude implements it. Needed for the preview too.
  let sources: Map<string, string> | null | undefined;
  if (primary.marketplaceSources) {
    sources = await primary.marketplaceSources();
  }
  const repoOf = (p: PluginRecord): string | undefined => (p.marketplace ? sources?.get(p.marketplace) : undefined);
  // Local marketplace clone dir per plugin — the network-free install path. Only a
  // Claude primary exposes clone locations (known_marketplaces installLocation); for
  // any other primary the map is empty and installs fall back to the legacy path.
  const clonePaths = opts.from === "claude-code" ? await claudeMarketplaceClonePaths() : new Map<string, string>();
  const cloneOf = (p: PluginRecord): string | undefined => (p.marketplace ? clonePaths.get(p.marketplace) : undefined);
  const sourcePairs: PluginPlanPair[] = await Promise.all(fromRead.plugins.map(async (plugin) => {
    const artifact = await artifactFromPluginRecord(plugin, {
      agent: opts.from,
      sourceRepo: repoOf(plugin) ?? plugin.sourceRepo,
      marketplaceRoot: cloneOf(plugin),
    });
    const plan = await planArtifactLifecycle({
      artifact,
      agent: opts.from,
      mode: "verified",
      sourceRequired: true,
      provision,
      dryRun: !opts.apply,
    });
    return { plugin, plan };
  }));
  const sourcePlans = sourcePairs.map(({ plan }) => plan);
  const sourcePlanByRecord = new Map(sourcePairs.map(({ plugin, plan }) => [plugin, plan]));
  const sourcePlan = (plugin: PluginRecord): ArtifactPlan => sourcePlanByRecord.get(plugin)!;

  const targets: MirrorTarget[] = [];
  const nativeCoverage = new Map<AgentId, Set<string>>();

  for (const a of pluginAdapters) {
    if (a.id === primary.id) continue;
    const toRead = await a.read();

    if (toRead.error) {
      targets.push({ to: a.id, toRead, diff: null, unsupportedReason: `cannot read target: ${toRead.error}` });
      continue;
    }

    const activeTargetPlugins = toRead.plugins.filter((plugin) => plugin.enabled !== false);
    const targetPairs = await Promise.all(sourcePairs.map(async ({ plugin, plan: source }) => ({
      plugin,
      plan: await planArtifactLifecycle({
        artifact: source.artifact,
        agent: a.id,
        mode: "verified",
        targetRead: toRead,
        sourceRequired: a.sourceRequired,
        provision,
        dryRun: !opts.apply,
      }),
    })));
    const targetPlans = targetPairs.map(({ plan }) => plan);
    const targetPlanByRecord = new Map(targetPairs.map(({ plugin, plan }) => [plugin, plan]));
    /* targetPairs keeps each plan attached to its source PluginRecord; no positional join. */
    const targetPlan = (plugin: PluginRecord): ArtifactPlan => targetPlanByRecord.get(plugin)!;
    // Seed fallback suppression from authoritative state that existed before this
    // mirror run. Without this, Copilot plugins already active natively were
    // absent from the per-run install results and received duplicate loose skills
    // and MCP during the cohort phase.
    for (const plan of targetPlans) {
      if (plan.activeRecords.length === 0) continue;
      addCoverage(nativeCoverage, a.id, plan.ownershipKey);
    }
    const add: PluginRecord[] = [];
    const queued = new Set<string>();
    for (const p of fromRead.plugins) {
      const plan = targetPlan(p);
      if (plan.activeRecords.length > 0) continue;
      if (!plan.nativeFeasible) continue;
      if (queued.has(plan.artifactKey)) continue;
      queued.add(plan.artifactKey);
      add.push(p);
    }

    const unavailable: MirrorUnavailablePlugin[] = targetPairs
      .filter(({ plan }) => plan.activeRecords.length === 0 && !plan.nativeFeasible)
      .map(({ plugin, plan }) => ({
        plugin,
        reason: plan.source.errors.join("; ") || "no usable native plugin source",
      }));
    const target: MirrorTarget = {
      to: a.id,
      toRead,
      diff: { add },
      unavailable,
    };

    if (opts.apply) {
      // Install by bare name and let the target resolve its own marketplace — the
      // primary's marketplace tag won't exist on the target.
      const installAttempts: NativeInstallAttempt[] = [];
      for (const [i, p] of add.entries()) {
        opts.onProgress?.(`${a.id}: ${p.name}`, i + 1, add.length);
        const plan = targetPlan(p);
        const result = await a.installPlugin(plan.requestedName, plan.installOptions);
        installAttempts.push({ plugin: p, plan, result });
      }
      target.installs = installAttempts.map(({ result }) => result);

      // Repos that are on this target as a real plugin — so their skills are present
      // namespaced and must NOT be re-added flat via `npx skills add` (duplication).
      const coveredRepos = new Set<string>();
      // (a) Already installed on the target BEFORE this run — a prior mirror's
      // canonical install, or a sibling of the same bundle. Matched by the
      // marketplace's DECLARED plugin names (not the primary's install id), so it
      // covers the case where the target's canonical name differs from the primary's
      // (`github.com-*` URL-named plugins). Without this, every re-run would re-add
      // the bundle's skills flat for the alias still left in `add`. (Claude primary
      // only — the coverage map comes from Claude's marketplace clones.)
      if (opts.from === "claude-code") {
        const installedNames = new Set(activeTargetPlugins.map((p) => p.name));
        for (const r of await resolveInstalledRepoCoverage(installedNames)) coveredRepos.add(r);
      }
      if (coveredRepos.size > 0) {
        // A target may expose the bundle's canonical name while the source uses an
        // alias. Repository coverage is the authoritative bridge for suppressing
        // that alias's decomposed MCP alongside its loose skills.
        for (const plugin of fromRead.plugins) {
          const repo = repoOf(plugin);
          if (!repo || !coveredRepos.has(repo)) continue;
          addCoverage(nativeCoverage, a.id, sourcePlan(plugin).ownershipKey);
        }
      }
      // (b) Landed during this run — directly installed, already present, or covered
      // (provisioning installed the bundle under its canonical name).
      for (const { plugin: p, result: ins } of installAttempts) {
        const r = repoOf(p);
        // A real native attempt (including an explicit failure) owns this plugin on
        // the target. Do not silently paper over failure with loose skills/MCP and
        // make the mirror look successful. Only a preflight skip remains eligible
        // for last-resort decomposition.
        if (ins.status !== "skipped" || ins.coveredBy) {
          addCoverage(nativeCoverage, a.id, sourcePlan(p).ownershipKey);
          if (r) {
            coveredRepos.add(r);
          }
        }
      }
      // An unloadable alias whose canonical sibling DID install is covered too —
      // reclassify it (drop the fallback) so its skills aren't added redundantly.
      for (const { result: ins } of installAttempts) {
        if (ins.status === "skipped" && ins.skillsFallbackRepo && coveredRepos.has(ins.skillsFallbackRepo)) {
          ins.coveredBy = ins.coveredBy ?? "the bundle's canonical plugin";
          ins.message = `covered by the bundle's canonical plugin on ${a.id} — not re-added as skills`;
          ins.skillsFallbackRepo = undefined;
        }
      }

      // Remaining fallback repos: genuinely unloadable on this target AND not
      // already present as a plugin. Add their skills loosely so the content lands.
      const fallbackRepos = [
        ...new Set(
          installAttempts
            .filter(({ result: i }) => i.status === "skipped")
            .map(({ result: i }) => i.skillsFallbackRepo)
            .filter((r): r is string => !!r),
        ),
      ];
      if (fallbackRepos.length) {
        target.skillsFallback = await addSkillSources(fallbackRepos, [a.id]);
      }
    }

    targets.push(target);
  }

  const cursor = await pushToCursor(fromRead, sources, sourcePlans, opts.apply, opts.onProgress);
  const skillCohortPush = await pushToSkillCohort(
    opts.from,
    sourcePlans,
    opts.apply,
    opts.onProgress,
    nativeCoverage,
  );
  const mcpCohortPush = await pushPluginMcpToCohort(
    opts.from,
    sourcePairs,
    opts.apply,
    opts.onProgress,
    nativeCoverage,
  );

  return {
    from: opts.from,
    fromRead,
    targets,
    cursor,
    skillCohort: skillCohortPush,
    mcpCohort: mcpCohortPush,
    applied: opts.apply,
  };
}

// Install the primary's plugins onto Cursor by source repo. Cursor has no
// plugin-list CLI, so this is additive and unconditional — we can't diff against
// cursor's current state. Repos are deduped (a multi-plugin marketplace installs
// once) and slug-validated (an adversarial marketplace entry can't smuggle a flag
// into the pinned Open Plugins invocation).
async function pushToCursor(
  fromRead: PluginAdapterRead,
  sources: Map<string, string> | null | undefined,
  plans: ArtifactPlan[],
  apply: boolean,
  onProgress?: (label: string, index: number, total: number) => void,
): Promise<CursorPush> {
  if (fromRead.error) {
    return { supported: false, reason: `primary unreadable: ${fromRead.error}`, repos: [], results: [] };
  }
  const repos = [
    ...new Set(
      plans
        .map((plan) => plan.source.writeOnly?.value)
        .filter((source): source is string => !!source),
    ),
  ].sort();
  if (repos.length === 0 && sources === undefined) {
    return {
      supported: false,
      reason: "primary can't supply github source repos for pinned Open Plugins — run `syncthis mirror claude-code` to populate cursor",
      repos: [],
      results: [],
    };
  }
  if (repos.length === 0 && sources === null) {
    return {
      supported: false,
      reason: "couldn't read the primary's marketplaces (`claude plugin marketplace list` failed) — cursor not updated",
      repos: [],
      results: [],
    };
  }
  if (!apply) return { supported: true, repos, results: [] };

  const results: CursorPushResult[] = [];
  for (const [i, repo] of repos.entries()) {
    onProgress?.(`cursor: ${repo}`, i + 1, repos.length);
    const res = await run("npx", openPluginsArgs(["add", repo, "--target", "cursor", "-y"]), {
      timeoutMs: CURSOR_PLUGINS_TIMEOUT_MS,
    });
    if (res.notFound) {
      results.push({ repo, status: "failed", message: "`npx -y plugins@1.3.4` not found on PATH" });
      continue;
    }
    if (res.timedOut) {
      results.push({ repo, status: "failed", message: `timed out after ${CURSOR_PLUGINS_TIMEOUT_MS / 1000}s` });
      continue;
    }
    if (!res.ok) {
      results.push({ repo, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` });
      continue;
    }
    results.push({ repo, status: "installed" });
  }
  return { supported: true, repos, results };
}

// Surface the primary's plugin-bundled skills to the non-plugin agents (gemini,
// kimi, opencode, …) via `npx skills add`. The source repos come from the Claude
// plugin store, so only a Claude primary can supply them — a Codex primary is
// reported unsupported with a clear reason (matching the cursor push).
async function pushToSkillCohort(
  from: AgentId,
  plans: ArtifactPlan[],
  apply: boolean,
  onProgress?: (label: string, index: number, total: number) => void,
  nativeCoverage: ReadonlyMap<AgentId, ReadonlySet<string>> = new Map(),
): Promise<MirrorSkillCohort> {
  const agents = skillCohort();
  const sources: PluginSkillSource[] = [];
  const seen = new Set<string>();
  for (const plan of plans) {
    const source = plan.ownership.skills ? plan.source.skills?.value : undefined;
    if (!source || seen.has(source)) continue;
    seen.add(source);
    sources.push({
      marketplace: plan.artifact.marketplaces[0] ?? plan.artifact.canonicalName,
      repo: source,
      installLocation:
        plan.source.localPlugin ??
        plan.source.localMarketplace ??
        source,
    });
  }
  sources.sort((left, right) => left.repo.localeCompare(right.repo));
  if (from !== "claude-code" && sources.length === 0) {
    return {
      supported: false,
      reason: "skill propagation reads Claude's installed plugins — run `syncthis mirror claude-code`",
      agents,
    };
  }
  if (!apply) {
    return { supported: true, agents, report: { ran: sources.length > 0, dryRun: true, agents, sources, results: [] } };
  }
  const results: SkillAddResult[] = [];
  const ownerForSource = (source: string): string | undefined =>
    plans.find((plan) => plan.source.skills?.value === source)?.ownershipKey;
  let step = 0;
  const total = agents.reduce(
    (sum, agent) => sum + sources.filter((source) => {
      const owner = ownerForSource(source.repo);
      return !owner || !nativeCoverage.get(agent)?.has(owner);
    }).length,
    0,
  );
  for (const agent of agents) {
    const repos = sources
      .map((source) => source.repo)
      .filter((repo) => {
        const owner = ownerForSource(repo);
        return !owner || !nativeCoverage.get(agent)?.has(owner);
      });
    for (const repo of repos) {
      step += 1;
      onProgress?.(`skills: ${repo} → ${agent}`, step, total);
      results.push(...await addSkillSources([repo], [agent]));
    }
  }
  return {
    supported: true,
    agents,
    report: {
      ran: results.length > 0,
      dryRun: false,
      agents,
      sources,
      results,
      ...(sources.length === 0 ? { message: "no skill-bearing plugins found in ~/.claude/plugins" } : {}),
    },
  };
}

// Lift the primary's plugin-bundled MCP servers into the non-plugin agents' own MCP
// config. The plugin cohort (Claude/Codex/Cursor) already gets these by installing
// the plugin, so the target set is the MCP cohort (the non-plugin MCP-syncable
// agents — skills-only agents like Pi are excluded; they have no MCP config). Source
// Paths normally come from Claude's plugin store; another primary can supply an
// exact validated local PluginRecord.path.
// Additive and conflict-safe: each agent keeps every server it already has; a name
// present with a DIFFERENT config is left untouched and reported as a conflict
// (sacred conflict policy), never overwritten.
async function pushPluginMcpToCohort(
  from: AgentId,
  pluginPlans: readonly PluginPlanPair[],
  apply: boolean,
  onProgress?: (label: string, index: number, total: number) => void,
  nativeCoverage: ReadonlyMap<AgentId, ReadonlySet<string>> = new Map(),
): Promise<MirrorMcpCohort> {
  const agents = mcpCohort();
  const plugins = pluginPlans.map(({ plugin }) => plugin);
  if (
    from !== "claude-code" &&
    !pluginPlans.some(({ plan }) => !!plan.ownership.pluginRoot)
  ) {
    return {
      supported: false,
      reason: "plugin MCP decomposition reads Claude's installed plugins — run `syncthis mirror claude-code`",
      agents,
      servers: [],
      skipped: [],
    };
  }
  // Preview authority: the reported server set always shows canonical stdio
  // work with its exact PLUGIN_DATA path resolved (validated, never created).
  const dataRoot = resolveSyncthisDataHome();
  const { servers, skipped } = await resolvePluginMcpServers(plugins, {
    dataHome: { intent: "preview", dataRoot },
  });
  if (!apply || servers.length === 0) {
    return { supported: true, agents, servers, skipped };
  }

  const results: McpCohortResult[] = [];
  let i = 0;
  for (const agentId of agents) {
    i += 1;
    onProgress?.(`mcp→${agentId}`, i, agents.length);
    const covered = nativeCoverage.get(agentId);
    const loosePlugins = covered
      ? pluginPlans
        .filter(({ plan }) => !covered.has(plan.ownershipKey))
        .map(({ plugin }) => plugin)
      : plugins;
    // Apply creates the per-plugin PLUGIN_DATA homes securely (0700) BEFORE
    // the stdio configs are emitted, so a lifted server never launches
    // without its data home.
    const resolved = await resolvePluginMcpServers(loosePlugins, {
      dataHome: { intent: "create", dataRoot },
    });
    const serverMap: Record<string, McpServer> = {};
    for (const s of resolved.servers) serverMap[s.name] = s.server;
    const adapter = findAdapter(agentId);
    if (!adapter) {
      results.push({ agent: agentId, added: [], conflicts: [], status: "skipped", message: "no MCP adapter" });
      continue;
    }
    const read = await adapter.read();
    if (read.error) {
      results.push({ agent: agentId, added: [], conflicts: [], status: "failed", message: read.error });
      continue;
    }
    // diff(plugin servers → agent's current): `add` = not yet present; `overwrite` =
    // present with a different config = a conflict we must NOT touch.
    const diff = diffServers(serverMap, read.servers);
    if (diff.add.length === 0) {
      results.push({
        agent: agentId,
        added: [],
        conflicts: diff.overwrite,
        status: "skipped",
        message: diff.overwrite.length ? "conflict(s) left untouched" : "already present",
      });
      continue;
    }
    // Merge additively: keep every existing server (conflicting names retain the
    // agent's own value), add only the new ones.
    const next: Record<string, McpServer> = { ...read.servers };
    for (const name of diff.add) next[name] = serverMap[name]!;
    const write = await adapter.write(next, { dryRun: false });
    results.push({
      agent: agentId,
      added: diff.add,
      conflicts: diff.overwrite,
      status: write.status,
      message: write.message,
    });
  }
  return { supported: true, agents, servers, skipped, results };
}

export function mirrorHasChanges(report: MirrorReport): boolean {
  const skillSources = report.skillCohort.supported ? report.skillCohort.report?.sources.length ?? 0 : 0;
  const mcpServers = report.mcpCohort.supported ? report.mcpCohort.servers.length : 0;
  return (
    report.targets.some((t) => t.diff && t.diff.add.length > 0) ||
    report.cursor.repos.length > 0 ||
    skillSources > 0 ||
    mcpServers > 0
  );
}
