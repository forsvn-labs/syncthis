import type { AgentId } from "../types.ts";
import { createArtifactKey, type ArtifactKey } from "./artifact-key.ts";
import type { PluginInventoryArtifact } from "./inventory.ts";
import {
  validateLocalPluginSource,
  type ValidatedPluginRoot,
} from "./local-source.ts";
import { inspectPluginSource } from "./source.ts";
import { isSafeRepoSlug, pluginIdentityKeys } from "./shell.ts";
import type {
  PluginAdapterRead,
  PluginInstallOpts,
  PluginRecord,
} from "./types.ts";

export type ArtifactTargetMode = "verified" | "write-only" | "none";

export type ArtifactSource = {
  kind: "local-plugin" | "local-marketplace" | "repository";
  value: string;
};

export type ArtifactPlan = {
  artifact: PluginInventoryArtifact;
  artifactKey: ArtifactKey;
  artifactId: string;
  agent: AgentId;
  mode: ArtifactTargetMode;
  requestedName: string;
  marketplace?: string;
  intent: "install" | "repair" | "none";
  activeRecords: PluginRecord[];
  source: {
    localPlugin?: ValidatedPluginRoot;
    localMarketplace?: ValidatedPluginRoot;
    repository?: string;
    native?: ArtifactSource;
    writeOnly?: ArtifactSource;
    skills?: ArtifactSource;
    errors: string[];
  };
  installOptions: PluginInstallOpts;
  nativeFeasible: boolean;
  /** One source owner across aliases from the same bundle. */
  ownershipKey: string;
  ownership: {
    pluginRoot?: ValidatedPluginRoot;
    skills: boolean;
    mcp: boolean;
  };
};

export type ArtifactRecordContext = {
  agent: AgentId;
  sourceRepo?: string;
  marketplaceRoot?: string;
};

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export function artifactKeyOf(
  artifact: PluginInventoryArtifact,
): ArtifactKey {
  return artifact.artifactKey;
}

export function requestedArtifactIdentity(
  artifact: PluginInventoryArtifact,
  agent: AgentId,
): { name: string; marketplace?: string } {
  const runtime = artifact.evidence.find(
    (item) => item.kind === "runtime" && item.agent === agent,
  );
  if (runtime) return { name: runtime.name, marketplace: runtime.marketplace };

  const configured = artifact.evidence.find(
    (item) => item.kind === "codex-config" && item.agent === agent,
  );
  if (configured) {
    const canonicalKeys = new Set(pluginIdentityKeys(artifact.canonicalName));
    const configuredMatchesCanonical = pluginIdentityKeys(configured.name).some(
      (key) => canonicalKeys.has(key),
    );
    if (configuredMatchesCanonical) {
      return { name: configured.name, marketplace: configured.marketplace };
    }
  }
  return { name: artifact.canonicalName };
}

export function artifactRecordIsActive(
  record: PluginRecord,
  artifact: PluginInventoryArtifact,
  agent: AgentId,
): boolean {
  return record.enabled !== false && artifactRecordMatches(
    record,
    artifact,
    agent,
  );
}

function artifactRecordMatches(
  record: PluginRecord,
  artifact: PluginInventoryArtifact,
  agent: AgentId,
): boolean {
  const targetEvidence = artifact.evidence.find(
    (item) =>
      item.agent === agent &&
      (item.kind === "runtime" || item.kind === "codex-config") &&
      item.marketplace,
  );
  if (
    targetEvidence?.marketplace &&
    record.marketplace &&
    record.marketplace !== targetEvidence.marketplace &&
    pluginIdentityKeys(targetEvidence.name).some((key) =>
      pluginIdentityKeys(record.name).includes(key),
    )
  ) {
    return false;
  }
  const artifactKeys = new Set(artifact.identityKeys);
  return pluginIdentityKeys(record.name).some((key) => artifactKeys.has(key));
}

export function activeArtifactRecords(
  read: PluginAdapterRead | undefined,
  artifact: PluginInventoryArtifact,
  agent: AgentId,
): PluginRecord[] {
  return read?.plugins.filter((record) =>
    artifactRecordIsActive(record, artifact, agent)
  ) ?? [];
}

export function installedArtifactRecords(
  read: PluginAdapterRead | undefined,
  artifact: PluginInventoryArtifact,
  agent: AgentId,
): PluginRecord[] {
  return read?.plugins.filter((record) =>
    artifactRecordMatches(record, artifact, agent)
  ) ?? [];
}

async function validatedSource(
  path: string | undefined,
  errors: string[],
  label: string,
): Promise<ValidatedPluginRoot | undefined> {
  if (!path) return undefined;
  try {
    return await validateLocalPluginSource(path);
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export async function planArtifactLifecycle(options: {
  artifact: PluginInventoryArtifact;
  agent: AgentId;
  mode: ArtifactTargetMode;
  targetRead?: PluginAdapterRead;
  sourceRequired?: boolean;
  provision?: boolean;
  dryRun: boolean;
}): Promise<ArtifactPlan> {
  const { artifact, agent, mode } = options;
  const errors: string[] = [];
  const localPlugin = await validatedSource(
    artifact.sourcePluginPath ?? artifact.pluginRoot,
    errors,
    "plugin source",
  );
  const localMarketplace = await validatedSource(
    artifact.marketplaceRoot,
    errors,
    "marketplace source",
  );
  const repository =
    artifact.sourceRepo && isSafeRepoSlug(artifact.sourceRepo)
      ? artifact.sourceRepo
      : undefined;
  if (artifact.sourceRepo && !repository) {
    errors.push(`repository source is unsafe: ${artifact.sourceRepo}`);
  }
  const nativePlugin = artifact.payload.nativeManifest
    ? localPlugin
    : undefined;

  // Readable native adapters receive all validated evidence and retain their
  // target-specific preference. Write-only Plugins CLI targets preserve repo
  // preference, with an exact standalone path as the offline fallback.
  const native: ArtifactSource | undefined = nativePlugin
    ? { kind: "local-plugin", value: nativePlugin }
    : localMarketplace
      ? { kind: "local-marketplace", value: localMarketplace }
      : repository
        ? { kind: "repository", value: repository }
        : undefined;
  const writeOnly: ArtifactSource | undefined = repository
    ? { kind: "repository", value: repository }
    : nativePlugin
      ? { kind: "local-plugin", value: nativePlugin }
      : undefined;
  const skills: ArtifactSource | undefined = artifact.payload.skills
    ? repository
      ? { kind: "repository", value: repository }
      : localPlugin
        ? { kind: "local-plugin", value: localPlugin }
        : undefined
    : undefined;
  const identity = requestedArtifactIdentity(artifact, agent);
  const activeRecords = activeArtifactRecords(
    options.targetRead,
    artifact,
    agent,
  );
  const present = activeRecords.length > 0 || (
    mode === "write-only" && artifact.activeOn.includes(agent)
  );
  const intent = present
    ? "none"
    : artifact.configuredOn.includes(agent)
      ? "repair"
      : "install";
  const selectedNative = mode === "write-only" ? writeOnly : native;
  const nativeFeasible =
    mode === "none" ||
    !options.sourceRequired ||
    selectedNative !== undefined;
  const artifactKey = artifactKeyOf(artifact);
  const ownershipKey = repository
    ? `repo:${repository}`
    : localPlugin
      ? `path:${localPlugin}`
      : `artifact:${artifactKey}`;

  return {
    artifact,
    artifactKey,
    artifactId: artifact.id,
    agent,
    mode,
    requestedName: identity.name,
    marketplace: identity.marketplace,
    intent,
    activeRecords,
    source: {
      localPlugin,
      localMarketplace,
      repository,
      native,
      writeOnly,
      skills,
      errors,
    },
    installOptions: {
      dryRun: options.dryRun,
      marketplace: identity.marketplace,
      provision: options.provision ?? true,
      sourceRepo: repository,
      sourceMarketplace: artifact.marketplaces[0],
      sourceClonePath: localMarketplace,
      sourcePluginPath: nativePlugin,
    },
    nativeFeasible,
    ownershipKey,
    ownership: {
      pluginRoot: localPlugin,
      skills: skills !== undefined,
      mcp: artifact.payload.mcp,
    },
  };
}

export async function artifactFromPluginRecord(
  record: PluginRecord,
  context: ArtifactRecordContext,
): Promise<PluginInventoryArtifact> {
  const errors: PluginInventoryArtifact["errors"] = [];
  const sourceErrors: string[] = [];
  const pluginRoot = await validatedSource(
    record.path,
    sourceErrors,
    "plugin source",
  );
  const marketplaceRoot = await validatedSource(
    context.marketplaceRoot,
    sourceErrors,
    "marketplace source",
  );
  const [pluginInspection, marketplaceInspection] = await Promise.all([
    pluginRoot ? inspectPluginSource(pluginRoot) : undefined,
    marketplaceRoot ? inspectPluginSource(marketplaceRoot) : undefined,
  ]);
  const inspected = pluginInspection ?? marketplaceInspection;
  const payload = {
    nativeManifest:
      pluginInspection?.payload.nativeManifest ??
      marketplaceInspection?.payload.nativeManifest ??
      false,
    skills:
      !!pluginInspection?.payload.skills ||
      !!marketplaceInspection?.payload.skills,
    mcp:
      !!pluginInspection?.payload.mcp ||
      !!marketplaceInspection?.payload.mcp,
  };
  for (const message of sourceErrors) {
    errors.push({
      source: "native-runtime",
      path: record.path ?? context.marketplaceRoot,
      plugin: record.name,
      message,
    });
  }
  const canonicalName = inspected?.canonicalName ?? record.name;
  const aliases = sorted([record.name, canonicalName]);
  const marketplaces = record.marketplace ? [record.marketplace] : [];
  const evidence: PluginInventoryArtifact["evidence"] = [{
    kind: "runtime",
    name: record.name,
    marketplace: record.marketplace,
    agent: context.agent,
    enabled: record.enabled,
    path: pluginRoot,
  }];
  const artifactKey = createArtifactKey({
    canonicalName,
    aliases,
    marketplaces,
    sourceRepo: context.sourceRepo ?? record.sourceRepo ?? inspected?.sourceRepo,
    sourcePluginPath: pluginRoot,
    sourceVersion: inspected?.sourceVersion ?? record.version,
    contentFingerprint: inspected?.contentFingerprint,
    marketplaceRoot,
    evidence: evidence.map(({ enabled: _enabled, ...item }) => item),
  });

  return {
    artifactKey,
    id: marketplaces[0]
      ? `${canonicalName}@${marketplaces[0]}`
      : canonicalName,
    canonicalName,
    aliases,
    identityKeys: sorted(aliases.flatMap(pluginIdentityKeys)),
    marketplaces,
    sourceRepo: context.sourceRepo ?? record.sourceRepo ?? inspected?.sourceRepo,
    sourcePluginPath: pluginRoot,
    sourceVersion: inspected?.sourceVersion ?? record.version,
    contentFingerprint: inspected?.contentFingerprint,
    pluginRoot,
    marketplaceRoot,
    payload,
    installedOn: [context.agent],
    activeOn: record.enabled === false ? [] : [context.agent],
    configuredOn: [],
    catalogueOnly: false,
    eligible: record.enabled !== false,
    evidence,
    errors,
  };
}

export function artifactMatchesRequest(
  artifact: PluginInventoryArtifact,
  request: { name: string; marketplace?: string },
): boolean {
  if (
    request.marketplace &&
    !artifact.marketplaces.includes(request.marketplace) &&
    !artifact.evidence.some((item) => item.marketplace === request.marketplace)
  ) {
    return false;
  }
  const keys = new Set(artifact.identityKeys);
  return pluginIdentityKeys(request.name).some((key) => keys.has(key));
}
