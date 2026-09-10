import {
  addSkillSources,
  type SkillAddResult,
} from "../skills.ts";
import { findAdapter } from "../adapters/index.ts";
import { diffServers } from "../mcp-state.ts";
import type { Adapter, AgentId, McpServer } from "../types.ts";
import type { ArtifactKey } from "./artifact-key.ts";
import { resolveSyncthisDataHome } from "./data-home.ts";
import type { PluginInventoryArtifact } from "./inventory.ts";
import {
  artifactKeyOf,
  planArtifactLifecycle,
  type ArtifactPlan,
} from "./lifecycle.ts";
import {
  resolvePluginMcpServers,
  type PluginMcpResolution,
  type PluginMcpSkip,
} from "./mcp.ts";
import type {
  PluginReconcileReport,
  PluginReconcileResult,
} from "./reconcile.ts";

export type PluginDegradationComponent = "skills" | "mcp";

export type PluginDegradationStatus =
  | "would-add"
  | "added"
  | "unchanged"
  | "skipped"
  | "failed";

export type PluginDegradationResult = {
  artifactKey: ArtifactKey;
  artifactId: string;
  plugin: string;
  agent: AgentId;
  reason: "unsupported-format" | "no-native-abi";
  component: PluginDegradationComponent;
  status: PluginDegradationStatus;
  source?: string;
  added?: string[];
  conflicts?: string[];
  skipped?: PluginMcpSkip[];
  message?: string;
  /** True only when the exact projection is known to be reachable. */
  reachProven?: boolean;
  /** Work was unresolved (conflict, skipped item, or incomplete projection). */
  unresolved?: boolean;
};

export type EligiblePluginDegradationOutcome = {
  artifactKey: ArtifactKey;
  artifactId: string;
  plugin: string;
  agent: AgentId;
  reason: "unsupported-format" | "no-native-abi";
};

export type PluginDegradationReport = {
  dryRun: boolean;
  eligibleOutcomes: EligiblePluginDegradationOutcome[];
  results: PluginDegradationResult[];
  failures: PluginDegradationResult[];
  hasFailures: boolean;
  hasChanges: boolean;
};

export type PluginDegradationDependencies = {
  addSkillSources?: (
    sources: string[],
    agents: readonly AgentId[],
    opts: { dryRun?: boolean },
  ) => Promise<SkillAddResult[]>;
  findMcpAdapter?: (agent: AgentId) => Adapter | undefined;
  resolveMcpServers?: (
    plugins: Array<{
      name: string;
      marketplace?: string;
      path?: string;
      enabled?: boolean;
    }>,
  ) => Promise<PluginMcpResolution>;
};

export type RunPluginDegradationOptions = {
  reconcile: PluginReconcileReport;
  /** Suppress loose-skill fallback while preserving native and MCP handling. */
  includeSkills?: boolean;
  /** Available for MCP-only control planes; flagship sync leaves this enabled. */
  includeMcp?: boolean;
  dependencies?: PluginDegradationDependencies;
};

function isEligibleOutcome(
  result: PluginReconcileResult,
): result is PluginReconcileResult & {
  degradation: {
    eligible: true;
    reason: "unsupported-format" | "no-native-abi";
  };
} {
  if (!result.degradation.eligible || result.status !== "unsupported") return false;
  if (
    result.nativeMode === "none" &&
    result.degradation.reason === "no-native-abi"
  ) {
    return true;
  }
  return (
    result.nativeMode !== "none" &&
    result.degradation.reason === "unsupported-format"
  );
}

function baseResult(
  outcome: PluginReconcileResult & {
    degradation: {
      eligible: true;
      reason: "unsupported-format" | "no-native-abi";
    };
  },
  component: PluginDegradationComponent,
): Pick<
  PluginDegradationResult,
  "artifactKey" | "artifactId" | "plugin" | "agent" | "reason" | "component"
> {
  return {
    artifactKey: outcome.artifactKey,
    artifactId: outcome.artifactId,
    plugin: outcome.plugin,
    agent: outcome.agent,
    reason: outcome.degradation.reason,
    component,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function degradeSkills(
  outcome: PluginReconcileResult & {
    degradation: {
      eligible: true;
      reason: "unsupported-format" | "no-native-abi";
    };
  },
  plan: ArtifactPlan,
  dryRun: boolean,
  install: NonNullable<PluginDegradationDependencies["addSkillSources"]>,
): Promise<PluginDegradationResult> {
  const base = baseResult(outcome, "skills");
  const source = plan.source.skills?.value;
  if (!source) {
    return {
      ...base,
      status: "failed",
      message:
        plan.source.errors[0] ??
        "artifact has no safe repository or validated local plugin root",
    };
  }

  let installs: SkillAddResult[];
  try {
    installs = await install([source], [outcome.agent], { dryRun });
  } catch (err) {
    return {
      ...base,
      source,
      status: "failed",
      message: errorMessage(err),
    };
  }
  const result = installs.find((item) => item.repo === source) ?? installs[0];
  if (!result) {
    return {
      ...base,
      source,
      status: "failed",
      message: "skill installer returned no result",
    };
  }
  if (result.status === "failed") {
    return {
      ...base,
      source,
      status: "failed",
      message: result.message,
    };
  }
  if (result.status === "skipped") {
    const reachProven = /already\s+(?:synced|present|installed|reachable)/i.test(result.message ?? "");
    return {
      ...base,
      source,
      status: "unchanged",
      message: result.message,
      reachProven,
      unresolved: !reachProven,
    };
  }
  return {
    ...base,
    source,
    status: dryRun ? "would-add" : "added",
    message: result.message,
    reachProven: true,
  };
}

function mcpFailure(
  outcome: PluginReconcileResult & {
    degradation: {
      eligible: true;
      reason: "unsupported-format" | "no-native-abi";
    };
  },
  message: string,
): PluginDegradationResult {
  return {
    ...baseResult(outcome, "mcp"),
    status: "failed",
    message,
  };
}

function missingArtifactFailure(
  outcome: PluginReconcileResult & {
    degradation: {
      eligible: true;
      reason: "unsupported-format" | "no-native-abi";
    };
  },
  component: PluginDegradationComponent,
): PluginDegradationResult {
  return {
    ...baseResult(outcome, component),
    status: "failed",
    message: "reconciled artifact is missing from inventory",
  };
}

async function degradeMcp(
  outcome: PluginReconcileResult & {
    degradation: {
      eligible: true;
      reason: "unsupported-format" | "no-native-abi";
    };
  },
  plan: ArtifactPlan,
  dryRun: boolean,
  adapter: Adapter,
  resolveServers: NonNullable<PluginDegradationDependencies["resolveMcpServers"]>,
): Promise<PluginDegradationResult> {
  const base = baseResult(outcome, "mcp");
  const local = plan.ownership.pluginRoot;
  if (!local) {
    return {
      ...base,
      status: "failed",
      message:
        plan.source.errors[0] ??
        "artifact has no validated local plugin root",
    };
  }

  let resolution: PluginMcpResolution;
  try {
    resolution = await resolveServers([
      {
        name: plan.artifact.canonicalName,
        marketplace: plan.artifact.marketplaces[0],
        path: local,
        enabled: true,
      },
    ]);
  } catch (err) {
    return mcpFailure(outcome, `cannot resolve bundled MCP: ${errorMessage(err)}`);
  }

  let current: Awaited<ReturnType<Adapter["read"]>>;
  try {
    current = await adapter.read();
  } catch (err) {
    return mcpFailure(outcome, `cannot read MCP target: ${errorMessage(err)}`);
  }
  if (current.error) {
    return mcpFailure(outcome, `cannot read MCP target: ${current.error}`);
  }

  const bundled: Record<string, McpServer> = {};
  for (const item of resolution.servers) bundled[item.name] = item.server;
  const diff = diffServers(bundled, current.servers);
  const unresolved = diff.overwrite.length > 0 || resolution.skipped.length > 0;
  const common = {
    ...base,
    source: local,
    added: diff.add,
    conflicts: diff.overwrite,
    skipped: resolution.skipped,
    unresolved,
  };

  if (diff.add.length === 0) {
    return {
      ...common,
      status: "unchanged",
      reachProven: !unresolved,
      message: diff.overwrite.length
        ? "conflicting MCP server(s) left untouched"
        : resolution.skipped.length
          ? "no portable bundled MCP servers"
          : "bundled MCP already present",
    };
  }
  if (dryRun) return { ...common, status: "would-add", reachProven: true };
  const next = { ...current.servers };
  for (const name of diff.add) next[name] = bundled[name]!;

  try {
    const write = await adapter.write(next, { dryRun: false });
    if (write.status === "failed") {
      return { ...common, status: "failed", message: write.message };
    }
    if (write.status === "unchanged") {
      return {
        ...common,
        status: "unchanged",
        message: write.message,
        reachProven: false,
        unresolved: true,
      };
    }
    if (write.status === "skipped") {
      return {
        ...common,
        status: "skipped",
        message: write.message,
        reachProven: false,
        unresolved: true,
      };
    }
    return { ...common, status: "added", message: write.message, reachProven: true };
  } catch (err) {
    return {
      ...common,
      status: "failed",
      message: `cannot write MCP target: ${errorMessage(err)}`,
    };
  }
}

/**
 * Apply only explicit last-resort decisions emitted by runPluginReconcile.
 * Every action stays scoped to the decision's exact target; this function never
 * derives a cohort or fans an artifact back out to native plugin runtimes.
 */
export async function runPluginDegradation(
  options: RunPluginDegradationOptions,
): Promise<PluginDegradationReport> {
  const dryRun = options.reconcile.dryRun;
  const includeSkills = options.includeSkills ?? true;
  const includeMcp = options.includeMcp ?? true;
  const dependencies = options.dependencies ?? {};
  const installSkills = dependencies.addSkillSources ?? addSkillSources;
  const findMcp = dependencies.findMcpAdapter ?? findAdapter;
  // Production lifecycle: a dry-run degradation preview computes+validates the
  // exact per-plugin PLUGIN_DATA path (no writes), and an apply creates it
  // securely before the lifted stdio configs are emitted. Injected resolvers
  // (tests/control planes) keep their full authority.
  const dataRoot = resolveSyncthisDataHome();
  const resolveMcp =
    dependencies.resolveMcpServers ??
    ((plugins: Parameters<typeof resolvePluginMcpServers>[0]) =>
      dryRun
        ? resolvePluginMcpServers(plugins, { dataHome: { intent: "preview", dataRoot } })
        : resolvePluginMcpServers(plugins, { dataHome: { intent: "create", dataRoot } }));
  const artifacts = new Map<ArtifactKey, PluginInventoryArtifact>();
  for (const artifact of options.reconcile.inventory.artifacts) {
    artifacts.set(artifactKeyOf(artifact), artifact);
  }
  const results: PluginDegradationResult[] = [];
  const eligibleOutcomes: EligiblePluginDegradationOutcome[] = [];

  for (const outcome of options.reconcile.results) {
    if (!isEligibleOutcome(outcome)) continue;
    eligibleOutcomes.push({
      artifactKey: outcome.artifactKey,
      artifactId: outcome.artifactId,
      plugin: outcome.plugin,
      agent: outcome.agent,
      reason: outcome.degradation.reason,
    });
    const artifact = outcome.artifactKey
      ? artifacts.get(outcome.artifactKey)
      : undefined;
    if (!artifact) {
      if (outcome.degradation.skills) {
        results.push(
          includeSkills
            ? missingArtifactFailure(outcome, "skills")
            : {
                ...baseResult(outcome, "skills"),
                status: "skipped",
                message: "suppressed (--no-skills)",
              },
        );
      }
      if (outcome.degradation.mcp && outcome.agent !== "pi") {
        results.push(
          includeMcp
            ? missingArtifactFailure(outcome, "mcp")
            : {
                ...baseResult(outcome, "mcp"),
                status: "skipped",
                message: "MCP degradation suppressed",
              },
        );
      }
      continue;
    }
    const plan = await planArtifactLifecycle({
      artifact,
      agent: outcome.agent,
      mode: outcome.nativeMode,
      sourceRequired: false,
      provision: false,
      dryRun,
    });

    if (outcome.degradation.skills && artifact.payload.skills) {
      results.push(
        includeSkills
          ? await degradeSkills(outcome, plan, dryRun, installSkills)
          : {
              ...baseResult(outcome, "skills"),
              status: "skipped",
              message: "suppressed (--no-skills)",
            },
      );
    }

    // Pi intentionally has no MCP support. For every other target, capability is
    // resolved exactly for that target; absence does not trigger another cohort.
    if (
      outcome.agent !== "pi" &&
      includeMcp &&
      outcome.degradation.mcp &&
      artifact.payload.mcp
    ) {
      const adapter = findMcp(outcome.agent);
      if (!adapter) {
        results.push({
          ...baseResult(outcome, "mcp"),
          status: "skipped",
          message: "target has no MCP adapter",
        });
      } else {
        results.push(
          await degradeMcp(
            outcome,
            plan,
            dryRun,
            adapter,
            resolveMcp,
          ),
        );
      }
    }
  }

  const failures = results.filter((result) => result.status === "failed");
  return {
    dryRun,
    eligibleOutcomes,
    results,
    failures,
    hasFailures: failures.length > 0,
    hasChanges: results.some(
      (result) => result.status === "would-add" || result.status === "added",
    ),
  };
}
