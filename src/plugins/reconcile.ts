import type { AgentId } from "../types.ts";
import {
  readPluginInventory,
  type PluginInventory,
  type PluginInventoryArtifact,
  type ReadPluginInventoryOptions,
} from "./inventory.ts";
import {
  activeArtifactRecords,
  artifactKeyOf,
  planArtifactLifecycle,
  requestedArtifactIdentity,
} from "./lifecycle.ts";
import { pluginIdentityKeys } from "./shell.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginInstallResult,
  PluginRecord,
} from "./types.ts";
import type { ArtifactKey } from "./artifact-key.ts";

export type PluginSupport =
  | { status: "supported" }
  | { status: "unsupported-format"; message?: string }
  | { status: "failed"; message: string };

type PluginTargetBase = {
  agent: AgentId;
  supportsArtifact?: (artifact: PluginInventoryArtifact) => PluginSupport | Promise<PluginSupport>;
};

export type VerifiedPluginTarget = PluginTargetBase & {
  mode: "verified";
  adapter: PluginAdapter;
};

export type WriteOnlyPluginInstallResult = {
  ok: boolean;
  message?: string;
};

export type WriteOnlyPluginTarget = PluginTargetBase & {
  mode: "write-only";
  install(
    artifact: PluginInventoryArtifact,
    opts: { dryRun: false },
  ): Promise<WriteOnlyPluginInstallResult>;
};

export type NoNativePluginTarget = PluginTargetBase & {
  mode: "none";
};

export type PluginReconcileTarget =
  | VerifiedPluginTarget
  | WriteOnlyPluginTarget
  | NoNativePluginTarget;

export type PluginNativeReconcileStatus =
  | "present"
  | "would-install"
  | "would-repair"
  | "installed"
  | "repaired"
  | "unverified"
  | "unsupported"
  | "failed";

export type PluginDegradationDecision = {
  eligible: boolean;
  reason?: "unsupported-format" | "no-native-abi";
  skills: boolean;
  mcp: boolean;
};

export type PluginReconcileResult = {
  artifactKey: ArtifactKey;
  artifactId: string;
  plugin: string;
  agent: AgentId;
  nativeMode: PluginReconcileTarget["mode"];
  status: PluginNativeReconcileStatus;
  intent: "install" | "repair" | "none";
  requestedName: string;
  marketplace?: string;
  activatedAs?: string[];
  message?: string;
  installResult?: PluginInstallResult | WriteOnlyPluginInstallResult;
  degradation: PluginDegradationDecision;
};

export type PluginReconcileReport = {
  dryRun: boolean;
  inventory: PluginInventory;
  results: PluginReconcileResult[];
  failures: PluginReconcileResult[];
  hasFailures: boolean;
  hasChanges: boolean;
};

export type RunPluginReconcileOptions = {
  dryRun: boolean;
  inventory?: PluginInventory;
  inventoryOptions?: ReadPluginInventoryOptions;
  readInventory?: () => Promise<PluginInventory>;
  /**
   * Exact target descriptions. Use mode "none" for agents without a native
   * plugin ABI and mode "write-only" for runtimes such as Cursor.
   */
  targets?: PluginReconcileTarget[];
  /**
   * Convenience target filter when using the live adapter registry. IDs absent
   * from that registry become explicit mode "none" targets.
   */
  targetAgents?: AgentId[];
};

const NO_DEGRADATION: PluginDegradationDecision = {
  eligible: false,
  skills: false,
  mcp: false,
};

function degradation(
  artifact: PluginInventoryArtifact,
  reason: PluginDegradationDecision["reason"],
): PluginDegradationDecision {
  return {
    eligible: true,
    reason,
    skills: artifact.payload.skills,
    mcp: artifact.payload.mcp,
  };
}

function recordId(record: PluginRecord): string {
  return record.marketplace ? `${record.name}@${record.marketplace}` : record.name;
}

function defaultSupport(artifact: PluginInventoryArtifact): PluginSupport {
  // When a concrete, inspected artifact has no native manifest, this is positive
  // format evidence. An artifact without a readable local root is unknown, so
  // let the native adapter attempt resolution from its marketplace/repository.
  if (artifact.pluginRoot && !artifact.payload.nativeManifest) {
    return {
      status: "unsupported-format",
      message: "local artifact contains no recognized native plugin manifest",
    };
  }
  return { status: "supported" };
}

async function supportFor(
  target: PluginReconcileTarget,
  artifact: PluginInventoryArtifact,
): Promise<PluginSupport> {
  try {
    return target.supportsArtifact
      ? await target.supportsArtifact(artifact)
      : defaultSupport(artifact);
  } catch (err) {
    return {
      status: "failed",
      message: `plugin capability check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function baseResult(
  artifact: PluginInventoryArtifact,
  target: PluginReconcileTarget,
): Pick<
  PluginReconcileResult,
  "artifactKey" | "artifactId" | "plugin" | "agent" | "nativeMode" | "intent" | "requestedName" | "marketplace"
> {
  const identity = requestedArtifactIdentity(artifact, target.agent);
  return {
    artifactKey: artifactKeyOf(artifact),
    artifactId: artifact.id,
    plugin: artifact.canonicalName,
    agent: target.agent,
    nativeMode: target.mode,
    intent: artifact.configuredOn.includes(target.agent) ? "repair" : "install",
    requestedName: identity.name,
    marketplace: identity.marketplace,
  };
}

async function liveTargets(targetAgents?: AgentId[]): Promise<PluginReconcileTarget[]> {
  const { pluginReconcileTargets } = await import("./targets.ts");
  const registered = pluginReconcileTargets();
  if (!targetAgents) {
    // Preserve the core reconciler's original default scope. The flagship sync
    // explicitly supplies the full registry, including Cursor and no-ABI agents.
    return registered.filter(
      (target): target is VerifiedPluginTarget => target.mode === "verified",
    );
  }
  const byAgent = new Map(registered.map((target) => [target.agent, target]));
  return targetAgents.map((agent): PluginReconcileTarget => {
    return byAgent.get(agent) ?? { agent, mode: "none" };
  });
}

async function initialTargetReads(
  targets: PluginReconcileTarget[],
): Promise<Map<AgentId, PluginAdapterRead>> {
  const reads = await Promise.all(
    targets
      .filter((target): target is VerifiedPluginTarget => target.mode === "verified")
      .map(async (target) => {
        try {
          return [target.agent, await target.adapter.read()] as const;
        } catch (err) {
          const failed: PluginAdapterRead = {
            agent: target.agent,
            configPath: target.adapter.configPath(),
            exists: false,
            plugins: [],
            error: err instanceof Error ? err.message : String(err),
          };
          return [
            target.agent,
            failed,
          ] as const;
        }
      }),
  );
  return new Map(reads);
}

function readFailure(
  artifact: PluginInventoryArtifact,
  target: VerifiedPluginTarget,
  read: PluginAdapterRead,
): PluginReconcileResult {
  return {
    ...baseResult(artifact, target),
    status: "failed",
    message: `cannot read native plugin state: ${read.error ?? "unknown read error"}`,
    degradation: NO_DEGRADATION,
  };
}

async function reconcileVerified(
  artifact: PluginInventoryArtifact,
  target: VerifiedPluginTarget,
  before: PluginAdapterRead,
  dryRun: boolean,
): Promise<PluginReconcileResult> {
  const base = baseResult(artifact, target);
  if (before.error) return readFailure(artifact, target, before);
  const plan = await planArtifactLifecycle({
    artifact,
    agent: target.agent,
    mode: target.mode,
    targetRead: before,
    sourceRequired: true,
    provision: true,
    dryRun,
  });

  const present = plan.activeRecords;
  if (present.length > 0) {
    return {
      ...base,
      status: "present",
      intent: "none",
      activatedAs: present.map(recordId),
      degradation: NO_DEGRADATION,
    };
  }
  const beforeIds = new Set(before.plugins.filter((record) => record.enabled !== false).map(recordId));

  const support = await supportFor(target, artifact);
  if (support.status === "unsupported-format") {
    return {
      ...base,
      status: "unsupported",
      message: support.message,
      degradation: degradation(artifact, "unsupported-format"),
    };
  }
  if (support.status === "failed") {
    return {
      ...base,
      status: "failed",
      message: support.message,
      degradation: NO_DEGRADATION,
    };
  }

  if (!plan.nativeFeasible) {
    return {
      ...base,
      status: "failed",
      message:
        plan.source.errors[0] ??
        "no usable plugin source path, marketplace clone, or repository",
      degradation: NO_DEGRADATION,
    };
  }

  if (dryRun) {
    let preview: PluginInstallResult | undefined;
    if (target.adapter.previewInstallPlugin) {
      try {
        preview = await target.adapter.previewInstallPlugin(
          plan.requestedName,
          plan.installOptions,
        );
      } catch (err) {
        return {
          ...base,
          status: "failed",
          message: `native install preview threw: ${err instanceof Error ? err.message : String(err)}`,
          degradation: NO_DEGRADATION,
        };
      }
      if (preview.status === "skipped" && preview.unsupportedFormat) {
        return {
          ...base,
          status: "unsupported",
          message: preview.message,
          installResult: preview,
          degradation: degradation(artifact, "unsupported-format"),
        };
      }
      if (preview.status === "failed" || preview.status === "skipped") {
        return {
          ...base,
          status: "failed",
          message: preview.message ?? "native install preview found no feasible activation path",
          installResult: preview,
          degradation: NO_DEGRADATION,
        };
      }
    }
    return {
      ...base,
      status: base.intent === "repair" ? "would-repair" : "would-install",
      message: preview?.message,
      installResult: preview,
      degradation: NO_DEGRADATION,
    };
  }

  let installResult: PluginInstallResult;
  try {
    installResult = await target.adapter.installPlugin(
      plan.requestedName,
      plan.installOptions,
    );
  } catch (err) {
    return {
      ...base,
      status: "failed",
      message: `native install threw: ${err instanceof Error ? err.message : String(err)}`,
      degradation: NO_DEGRADATION,
    };
  }

  if (installResult.status === "skipped" && installResult.unsupportedFormat) {
    return {
      ...base,
      status: "unsupported",
      message: installResult.message,
      installResult,
      degradation: degradation(artifact, "unsupported-format"),
    };
  }

  if (installResult.status === "failed") {
    return {
      ...base,
      status: "failed",
      message: installResult.message ?? "native install failed",
      installResult,
      degradation: NO_DEGRADATION,
    };
  }

  let after: PluginAdapterRead;
  try {
    after = await target.adapter.read();
  } catch (err) {
    return {
      ...base,
      status: "failed",
      message: `native verification threw: ${err instanceof Error ? err.message : String(err)}`,
      installResult,
      degradation: NO_DEGRADATION,
    };
  }
  if (after.error) {
    return {
      ...base,
      status: "failed",
      message: `native verification failed: ${after.error}`,
      installResult,
      degradation: NO_DEGRADATION,
    };
  }
  // Carry the authoritative post-install snapshot forward so multiple artifacts
  // for one target reconcile against the state produced by prior installs.
  Object.assign(before, after);

  const matching = activeArtifactRecords(after, artifact, target.agent);
  const added = after.plugins.filter(
    (record) => record.enabled !== false && !beforeIds.has(recordId(record)),
  );
  const coveredNames = installResult.coveredBy
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const covered = coveredNames?.length
    ? after.plugins.filter(
        (record) =>
          record.enabled !== false &&
          coveredNames.some((name) =>
            pluginIdentityKeys(name).some((key) => pluginIdentityKeys(record.name).includes(key)),
          ),
      )
    : [];
  const verified = matching.length > 0 ? matching : covered.length > 0 ? covered : added.length === 1 ? added : [];

  if (verified.length === 0) {
    return {
      ...base,
      status: "failed",
      message:
        installResult.status === "skipped"
          ? installResult.message ?? "native installer skipped the plugin without verifiable activation"
          : "native installer returned successfully, but a fresh read did not report an activated plugin",
      installResult,
      degradation: NO_DEGRADATION,
    };
  }

  return {
    ...base,
    status: base.intent === "repair" ? "repaired" : "installed",
    activatedAs: verified.map(recordId),
    message: installResult.message,
    installResult,
    degradation: NO_DEGRADATION,
  };
}

async function reconcileWriteOnly(
  artifact: PluginInventoryArtifact,
  target: WriteOnlyPluginTarget,
  dryRun: boolean,
): Promise<PluginReconcileResult> {
  const base = baseResult(artifact, target);
  const plan = await planArtifactLifecycle({
    artifact,
    agent: target.agent,
    mode: target.mode,
    sourceRequired: true,
    provision: true,
    dryRun,
  });
  if (plan.intent === "none") {
    return {
      ...base,
      status: "present",
      intent: "none",
      degradation: NO_DEGRADATION,
    };
  }

  const support = await supportFor(target, artifact);
  if (support.status === "unsupported-format") {
    return {
      ...base,
      status: "unsupported",
      message: support.message,
      degradation: degradation(artifact, "unsupported-format"),
    };
  }
  if (support.status === "failed") {
    return {
      ...base,
      status: "failed",
      message: support.message,
      degradation: NO_DEGRADATION,
    };
  }

  if (!plan.nativeFeasible) {
    return {
      ...base,
      status: "failed",
      message:
        plan.source.errors[0] ??
        "no usable plugin source path or repository for write-only target",
      degradation: NO_DEGRADATION,
    };
  }

  if (dryRun) {
    return {
      ...base,
      status: base.intent === "repair" ? "would-repair" : "would-install",
      message: "write-only native target cannot be activation-verified",
      degradation: NO_DEGRADATION,
    };
  }

  let installResult: WriteOnlyPluginInstallResult;
  try {
    installResult = await target.install(
      {
        ...artifact,
        sourceRepo: plan.source.repository,
        sourcePluginPath: plan.source.localPlugin,
        marketplaceRoot: plan.source.localMarketplace,
      },
      { dryRun: false },
    );
  } catch (err) {
    return {
      ...base,
      status: "failed",
      message: `write-only native install threw: ${err instanceof Error ? err.message : String(err)}`,
      degradation: NO_DEGRADATION,
    };
  }
  if (!installResult.ok) {
    return {
      ...base,
      status: "failed",
      message: installResult.message ?? "write-only native install failed",
      installResult,
      degradation: NO_DEGRADATION,
    };
  }
  return {
    ...base,
    status: "unverified",
    message: installResult.message ?? "native installer succeeded; target has no readable activation state",
    installResult,
    degradation: NO_DEGRADATION,
  };
}

async function reconcileOne(
  artifact: PluginInventoryArtifact,
  target: PluginReconcileTarget,
  reads: Map<AgentId, PluginAdapterRead>,
  dryRun: boolean,
): Promise<PluginReconcileResult> {
  if (target.mode === "none") {
    return {
      ...baseResult(artifact, target),
      status: "unsupported",
      degradation: degradation(artifact, "no-native-abi"),
    };
  }
  if (target.mode === "write-only") return reconcileWriteOnly(artifact, target, dryRun);
  const read = reads.get(target.agent);
  if (!read) {
    return {
      ...baseResult(artifact, target),
      status: "failed",
      message: "native plugin state was not read",
      degradation: NO_DEGRADATION,
    };
  }
  return reconcileVerified(artifact, target, read, dryRun);
}

/**
 * Reconcile plugin activation without performing loose-skill or MCP fallback.
 * Instead it emits explicit, per-target degradation eligibility that a caller
 * can apply after native activation succeeds or is positively unsupported.
 */
export async function runPluginReconcile(
  options: RunPluginReconcileOptions,
): Promise<PluginReconcileReport> {
  const targets = options.targets ?? (await liveTargets(options.targetAgents));
  const inventory =
    options.inventory ??
    (options.readInventory
      ? await options.readInventory()
      : await readPluginInventory(options.inventoryOptions));
  const reads = await initialTargetReads(targets);
  const artifacts = inventory.artifacts.filter((artifact) => artifact.eligible);

  // Serialize per target. Several native installers share marketplace/config
  // state, and each verification snapshot becomes the next artifact's baseline.
  const results: PluginReconcileResult[] = [];
  for (const target of targets) {
    for (const artifact of artifacts) {
      const result = await reconcileOne(artifact, target, reads, options.dryRun);
      results.push(result);
    }
  }

  const failures = results.filter((result) => result.status === "failed");
  return {
    dryRun: options.dryRun,
    inventory,
    results,
    failures,
    hasFailures: inventory.errors.length > 0 || failures.length > 0,
    hasChanges: results.some(
      (result) =>
        result.degradation.eligible ||
        result.status === "would-install" ||
        result.status === "would-repair" ||
        result.status === "installed" ||
        result.status === "repaired" ||
        result.status === "unverified",
    ),
  };
}
