import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import * as TOML from "smol-toml";
import type { AgentId } from "../types.ts";
import { createArtifactKey, type ArtifactKey } from "./artifact-key.ts";
import { parseClaudeInstalledPlugins } from "./claude.ts";
import { validateLocalPluginSource } from "./local-source.ts";
import { parsePluginId, pluginIdentityKeys } from "./shell.ts";
import { inspectPluginSource, type PluginSourceInspection } from "./source.ts";
import type { PluginAdapterRead, PluginRecord } from "./types.ts";

export type PluginInventorySourceKind =
  | "native-runtime"
  | "claude-installed"
  | "claude-marketplaces"
  | "codex-config"
  | "plugins-cli-marketplace";

export type PluginInventorySource = {
  kind: PluginInventorySourceKind;
  path?: string;
  status: "ok" | "missing" | "error";
  error?: string;
};

export type PluginInventoryError = {
  source: PluginInventorySourceKind;
  path?: string;
  plugin?: string;
  message: string;
};

export type PluginInventoryEvidence = {
  kind: "runtime" | "claude-installed" | "codex-config" | "plugins-cli-catalogue";
  name: string;
  marketplace?: string;
  agent?: AgentId;
  enabled?: boolean;
  path?: string;
  sourcePath?: string;
};

export type PluginInventoryArtifact = {
  /** Canonical machine identity. Inventory-produced artifacts always carry it. */
  artifactKey: ArtifactKey;
  /** Stable-enough human-readable identity. Consumers should match with identityKeys, not this display id. */
  id: string;
  canonicalName: string;
  aliases: string[];
  identityKeys: string[];
  marketplaces: string[];
  sourceRepo?: string;
  /** Exact validated plugin directory staged by the external Plugins CLI. */
  sourcePluginPath?: string;
  sourceVersion?: string;
  contentFingerprint?: string;
  pluginRoot?: string;
  marketplaceRoot?: string;
  payload: {
    nativeManifest: boolean;
    skills: boolean;
    mcp: boolean;
  };
  installedOn: AgentId[];
  activeOn: AgentId[];
  configuredOn: AgentId[];
  catalogueOnly: boolean;
  eligible: boolean;
  evidence: PluginInventoryEvidence[];
  errors: PluginInventoryError[];
};

export type PluginInventory = {
  artifacts: PluginInventoryArtifact[];
  sources: PluginInventorySource[];
  errors: PluginInventoryError[];
};

export type ReadPluginInventoryOptions = {
  /**
   * Native adapter snapshots to merge. When omitted, the registered adapter
   * registry is read lazily. Supplying snapshots keeps callers/tests in control
   * of when external CLIs run.
   */
  adapterReads?: PluginAdapterRead[];
  home?: string;
};

type Candidate = {
  name: string;
  marketplace?: string;
  canonicalName?: string;
  pluginRoot?: string;
  sourcePluginPath?: string;
  sourceVersion?: string;
  contentFingerprint?: string;
  marketplaceRoot?: string;
  sourceRepo?: string;
  sourceRepoPriority?: number;
  payload?: PluginInventoryArtifact["payload"];
  evidence: PluginInventoryEvidence;
  installedOn?: AgentId;
  activeOn?: AgentId;
  configuredOn?: AgentId;
  errors?: PluginInventoryError[];
};

type MutableArtifact = {
  names: Set<string>;
  marketplaces: Set<string>;
  canonicalNames: string[];
  pluginRoots: Set<string>;
  sourcePluginPaths: Set<string>;
  sourceVersions: Set<string>;
  contentFingerprints: Set<string>;
  marketplaceRoots: Set<string>;
  sourceRepos: Array<{ value: string; priority: number }>;
  payload: PluginInventoryArtifact["payload"];
  installedOn: Set<AgentId>;
  activeOn: Set<AgentId>;
  configuredOn: Set<AgentId>;
  evidence: PluginInventoryEvidence[];
  errors: PluginInventoryError[];
};

type ClaudeMarketplaceMetadata = {
  sourceRepo?: string;
  installLocation?: string;
};

const CLAUDE_INSTALLED_REL = join(".claude", "plugins", "installed_plugins.json");
const CLAUDE_MARKETPLACES_REL = join(".claude", "plugins", "known_marketplaces.json");
const PLUGINS_CLI_MARKETPLACE_REL = join(".agents", "plugins", "marketplace.json");

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "ENOENT";
}

async function readJsonSource(
  kind: PluginInventorySourceKind,
  path: string,
  sources: PluginInventorySource[],
  errors: PluginInventoryError[],
): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) {
      sources.push({ kind, path, status: "missing" });
      return undefined;
    }
    const message = errorMessage(err);
    sources.push({ kind, path, status: "error", error: message });
    errors.push({ source: kind, path, message });
    return undefined;
  }

  try {
    const value = JSON.parse(text);
    sources.push({ kind, path, status: "ok" });
    return value;
  } catch (err) {
    const message = `invalid JSON: ${errorMessage(err)}`;
    sources.push({ kind, path, status: "error", error: message });
    errors.push({ source: kind, path, message });
    return undefined;
  }
}

function codexHome(home: string): string {
  const configured = process.env.CODEX_HOME?.trim();
  if (!configured) return join(home, ".codex");
  if (configured === "~" || configured.startsWith("~/")) {
    return resolve(configured.replace(/^~/, home));
  }
  return resolve(configured);
}

function containsParentSegment(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function validateExternalArtifactPath(
  rawPath: string,
  home: string,
): Promise<{ path?: string; error?: string }> {
  if (!rawPath.trim()) return { error: "local artifact path is empty" };
  if (containsParentSegment(rawPath)) return { error: `local artifact path contains '..': ${rawPath}` };

  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(home, rawPath);
  if (!isWithin(home, absolute)) {
    return { error: `local artifact path resolves outside HOME: ${absolute}` };
  }

  try {
    const [realHome, realArtifact] = await Promise.all([
      realpath(home),
      validateLocalPluginSource(absolute),
    ]);
    if (!isWithin(realHome, realArtifact)) {
      return { error: `local artifact path escapes HOME through a symlink: ${absolute}` };
    }
    return { path: realArtifact };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

function parseClaudeMarketplaceMetadata(raw: unknown): Map<string, ClaudeMarketplaceMetadata> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const result = new Map<string, ClaudeMarketplaceMetadata>();
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as {
      source?: { source?: unknown; repo?: unknown };
      installLocation?: unknown;
    };
    result.set(name, {
      sourceRepo:
        entry.source?.source === "github" && typeof entry.source.repo === "string"
          ? entry.source.repo
          : undefined,
      installLocation: typeof entry.installLocation === "string" ? entry.installLocation : undefined,
    });
  }
  return result;
}

function marketplacesCompatible(artifact: MutableArtifact, candidate: Candidate): boolean {
  if (!candidate.marketplace || artifact.marketplaces.size === 0) return true;
  return artifact.marketplaces.has(candidate.marketplace);
}

function candidateNames(candidate: Candidate): string[] {
  return candidate.canonicalName && candidate.canonicalName !== candidate.name
    ? [candidate.name, candidate.canonicalName]
    : [candidate.name];
}

function namesOverlap(artifact: MutableArtifact, candidate: Candidate): boolean {
  const artifactKeys = new Set([...artifact.names].flatMap(pluginIdentityKeys));
  return candidateNames(candidate).some((name) => pluginIdentityKeys(name).some((key) => artifactKeys.has(key)));
}

function findArtifact(artifacts: MutableArtifact[], candidate: Candidate): MutableArtifact | undefined {
  if (candidate.pluginRoot) {
    const byRoot = artifacts.find((artifact) => artifact.pluginRoots.has(candidate.pluginRoot!));
    if (byRoot) return byRoot;
  }
  const nameMatches = artifacts.filter((artifact) => namesOverlap(artifact, candidate));
  const strongMatch = nameMatches.find((artifact) => {
    const hasVersionEvidence =
      !!candidate.sourceVersion && artifact.sourceVersions.size > 0;
    const versionMatch =
      !!candidate.sourceVersion &&
      [...artifact.sourceVersions].some(
        (version) =>
          Math.min(version.length, candidate.sourceVersion!.length) >= 7 &&
          (version.startsWith(candidate.sourceVersion!) || candidate.sourceVersion!.startsWith(version)),
      );
    const versionConflict = hasVersionEvidence && !versionMatch;
    const contentMatch =
      !!candidate.contentFingerprint &&
      artifact.contentFingerprints.has(candidate.contentFingerprint) &&
      !versionConflict;
    return versionMatch || contentMatch;
  });
  if (strongMatch) return strongMatch;

  // Two concrete roots with the same display name are not enough evidence: a
  // marketplace may publish distinct same-name plugins or versions. Only merge
  // them through the strong version/content checks above.
  if (candidate.pluginRoot) {
    const concrete = nameMatches.filter((artifact) => artifact.pluginRoots.size > 0);
    if (concrete.length > 0) return undefined;
  }
  return nameMatches.find((artifact) => marketplacesCompatible(artifact, candidate));
}

function addCandidate(artifacts: MutableArtifact[], candidate: Candidate): void {
  let artifact = findArtifact(artifacts, candidate);
  if (!artifact) {
    artifact = {
      names: new Set(),
      marketplaces: new Set(),
      canonicalNames: [],
      pluginRoots: new Set(),
      sourcePluginPaths: new Set(),
      sourceVersions: new Set(),
      contentFingerprints: new Set(),
      marketplaceRoots: new Set(),
      sourceRepos: [],
      payload: { nativeManifest: false, skills: false, mcp: false },
      installedOn: new Set(),
      activeOn: new Set(),
      configuredOn: new Set(),
      evidence: [],
      errors: [],
    };
    artifacts.push(artifact);
  }

  artifact.names.add(candidate.name);
  if (candidate.canonicalName) {
    artifact.names.add(candidate.canonicalName);
    artifact.canonicalNames.push(candidate.canonicalName);
  }
  if (candidate.marketplace) artifact.marketplaces.add(candidate.marketplace);
  if (candidate.pluginRoot) artifact.pluginRoots.add(candidate.pluginRoot);
  if (candidate.sourcePluginPath) artifact.sourcePluginPaths.add(candidate.sourcePluginPath);
  if (candidate.sourceVersion) artifact.sourceVersions.add(candidate.sourceVersion);
  if (candidate.contentFingerprint) artifact.contentFingerprints.add(candidate.contentFingerprint);
  if (candidate.marketplaceRoot) artifact.marketplaceRoots.add(candidate.marketplaceRoot);
  if (candidate.sourceRepo) {
    artifact.sourceRepos.push({ value: candidate.sourceRepo, priority: candidate.sourceRepoPriority ?? 0 });
  }
  if (candidate.payload) {
    artifact.payload.nativeManifest ||= candidate.payload.nativeManifest;
    artifact.payload.skills ||= candidate.payload.skills;
    artifact.payload.mcp ||= candidate.payload.mcp;
  }
  if (candidate.installedOn) artifact.installedOn.add(candidate.installedOn);
  if (candidate.activeOn) artifact.activeOn.add(candidate.activeOn);
  if (candidate.configuredOn) artifact.configuredOn.add(candidate.configuredOn);
  artifact.evidence.push(candidate.evidence);
  if (candidate.errors) artifact.errors.push(...candidate.errors);
}

async function candidateFromRecord(
  record: PluginRecord,
  evidence: PluginInventoryEvidence,
  state: { installedOn?: AgentId; activeOn?: AgentId },
  metadata?: ClaudeMarketplaceMetadata,
): Promise<Candidate> {
  let root: string | undefined;
  const recordErrors: PluginInventoryError[] = [];
  if (typeof record.path === "string") {
    if (!isAbsolute(record.path)) {
      recordErrors.push({
        source: evidence.kind === "claude-installed" ? "claude-installed" : "native-runtime",
        path: record.path,
        plugin: record.name,
        message: `local plugin source must be an absolute path: ${record.path}`,
      });
    } else {
      try {
        root = await validateLocalPluginSource(record.path);
      } catch (err) {
        recordErrors.push({
          source: evidence.kind === "claude-installed" ? "claude-installed" : "native-runtime",
          path: record.path,
          plugin: record.name,
          message: errorMessage(err),
        });
      }
    }
  }
  const inspected = root ? await inspectPluginSource(root) : undefined;
  return {
    name: record.name,
    marketplace: record.marketplace,
    canonicalName: inspected?.canonicalName,
    pluginRoot: root,
    sourceVersion: inspected?.sourceVersion,
    contentFingerprint: inspected?.contentFingerprint,
    marketplaceRoot: metadata?.installLocation,
    sourceRepo: record.sourceRepo ?? metadata?.sourceRepo ?? inspected?.sourceRepo,
    sourceRepoPriority: metadata?.sourceRepo ? 30 : record.sourceRepo ? 20 : inspected?.sourceRepo ? 10 : 0,
    payload: inspected?.payload,
    evidence,
    errors: recordErrors,
    ...state,
  };
}

function markSourceError(
  sources: PluginInventorySource[],
  kind: PluginInventorySourceKind,
  path: string,
  message: string,
): void {
  const source = sources.find((item) => item.kind === kind && item.path === path);
  if (!source) {
    sources.push({ kind, path, status: "error", error: message });
    return;
  }
  source.status = "error";
  source.error = source.error ? `${source.error}; ${message}` : message;
}

/**
 * Read-only inventory of native plugins and externally staged plugin artifacts.
 * This function never installs, repairs, or writes configuration.
 */
export async function readPluginInventory(options: ReadPluginInventoryOptions = {}): Promise<PluginInventory> {
  const home = resolve(options.home ?? process.env.HOME ?? homedir());
  const sources: PluginInventorySource[] = [];
  const errors: PluginInventoryError[] = [];
  const artifacts: MutableArtifact[] = [];

  const claudeMarketplacesPath = join(home, CLAUDE_MARKETPLACES_REL);
  const claudeMarketplacesRaw = await readJsonSource(
    "claude-marketplaces",
    claudeMarketplacesPath,
    sources,
    errors,
  );
  const claudeMarketplaces = parseClaudeMarketplaceMetadata(claudeMarketplacesRaw);
  if (claudeMarketplacesRaw !== undefined && !claudeMarketplaces) {
    const message = "unexpected known_marketplaces.json shape";
    markSourceError(sources, "claude-marketplaces", claudeMarketplacesPath, message);
    errors.push({ source: "claude-marketplaces", path: claudeMarketplacesPath, message });
  }
  if (claudeMarketplaces) {
    for (const [marketplace, metadata] of claudeMarketplaces) {
      if (!metadata.installLocation) continue;
      const validated = await validateExternalArtifactPath(metadata.installLocation, home);
      if (validated.path) {
        metadata.installLocation = validated.path;
        continue;
      }
      const message = `${marketplace}: invalid installLocation: ${validated.error}`;
      metadata.installLocation = undefined;
      markSourceError(sources, "claude-marketplaces", claudeMarketplacesPath, message);
      errors.push({
        source: "claude-marketplaces",
        path: claudeMarketplacesPath,
        plugin: marketplace,
        message,
      });
    }
  }

  const sharedPath = join(home, PLUGINS_CLI_MARKETPLACE_REL);
  const sharedRaw = await readJsonSource("plugins-cli-marketplace", sharedPath, sources, errors);
  if (sharedRaw !== undefined) {
    const entries =
      sharedRaw && typeof sharedRaw === "object" && !Array.isArray(sharedRaw)
        ? (sharedRaw as { plugins?: unknown }).plugins
        : undefined;
    if (!Array.isArray(entries)) {
      const message = "unexpected marketplace.json shape: expected a plugins array";
      markSourceError(sources, "plugins-cli-marketplace", sharedPath, message);
      errors.push({ source: "plugins-cli-marketplace", path: sharedPath, message });
    } else {
      for (const entryRaw of entries) {
        if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
          const error: PluginInventoryError = {
            source: "plugins-cli-marketplace",
            path: sharedPath,
            message: "ignoring malformed plugin entry",
          };
          errors.push(error);
          markSourceError(sources, "plugins-cli-marketplace", sharedPath, error.message);
          continue;
        }
        const entry = entryRaw as {
          name?: unknown;
          source?: { source?: unknown; path?: unknown };
        };
        if (typeof entry.name !== "string" || !entry.name.trim()) {
          const error: PluginInventoryError = {
            source: "plugins-cli-marketplace",
            path: sharedPath,
            message: "ignoring plugin entry without a valid name",
          };
          errors.push(error);
          markSourceError(sources, "plugins-cli-marketplace", sharedPath, error.message);
          continue;
        }

        const entryErrors: PluginInventoryError[] = [];
        let pluginRoot: string | undefined;
        let inspected: PluginSourceInspection | undefined;
        if (entry.source?.source !== "local" || typeof entry.source.path !== "string") {
          entryErrors.push({
            source: "plugins-cli-marketplace",
            path: sharedPath,
            plugin: entry.name,
            message: "plugin entry does not provide a local artifact path",
          });
        } else {
          const validated = await validateExternalArtifactPath(entry.source.path, home);
          if (validated.error) {
            entryErrors.push({
              source: "plugins-cli-marketplace",
              path: sharedPath,
              plugin: entry.name,
              message: validated.error,
            });
          } else {
            pluginRoot = validated.path;
            inspected = pluginRoot ? await inspectPluginSource(pluginRoot) : undefined;
          }
        }
        if (entryErrors.length) {
          errors.push(...entryErrors);
          markSourceError(
            sources,
            "plugins-cli-marketplace",
            sharedPath,
            entryErrors.map((item) => `${item.plugin}: ${item.message}`).join("; "),
          );
        }
        addCandidate(artifacts, {
          name: entry.name,
          marketplace: "plugins-cli",
          canonicalName: inspected?.canonicalName,
          pluginRoot,
          sourcePluginPath: pluginRoot,
          sourceVersion: inspected?.sourceVersion,
          contentFingerprint: inspected?.contentFingerprint,
          sourceRepo: inspected?.sourceRepo,
          sourceRepoPriority: 10,
          payload: inspected?.payload,
          evidence: {
            kind: "plugins-cli-catalogue",
            name: entry.name,
            marketplace: "plugins-cli",
            path: pluginRoot,
            sourcePath: sharedPath,
          },
          errors: entryErrors,
        });
      }
    }
  }

  const adapterReads =
    options.adapterReads ??
    (await (async () => {
      const { listPlugins } = await import("./index.ts");
      return listPlugins();
    })());
  for (const read of adapterReads) {
    sources.push({
      kind: "native-runtime",
      path: read.configPath,
      status: read.error ? "error" : read.exists ? "ok" : "missing",
      error: read.error,
    });
    if (read.error) {
      errors.push({ source: "native-runtime", path: read.configPath, message: `${read.agent}: ${read.error}` });
    }
    for (const record of read.plugins) {
      const metadata = read.agent === "claude-code" && record.marketplace
        ? claudeMarketplaces?.get(record.marketplace)
        : undefined;
      const candidate = await candidateFromRecord(
        record,
        {
          kind: "runtime",
          name: record.name,
          marketplace: record.marketplace,
          agent: read.agent,
          enabled: record.enabled,
          path: record.path,
          sourcePath: read.configPath,
        },
        {
          installedOn: read.agent,
          activeOn: record.enabled === false ? undefined : read.agent,
        },
        metadata,
      );
      if (candidate.errors) errors.push(...candidate.errors);
      addCandidate(artifacts, candidate);
    }
  }

  const claudeInstalledPath = join(home, CLAUDE_INSTALLED_REL);
  const claudeInstalledRaw = await readJsonSource(
    "claude-installed",
    claudeInstalledPath,
    sources,
    errors,
  );
  if (claudeInstalledRaw !== undefined) {
    const records = parseClaudeInstalledPlugins(claudeInstalledRaw);
    if (!records) {
      const message = "unexpected installed_plugins.json shape";
      markSourceError(sources, "claude-installed", claudeInstalledPath, message);
      errors.push({ source: "claude-installed", path: claudeInstalledPath, message });
    } else {
      for (const record of records) {
        const metadata = record.marketplace ? claudeMarketplaces?.get(record.marketplace) : undefined;
        const candidate = await candidateFromRecord(
          record,
          {
            kind: "claude-installed",
            name: record.name,
            marketplace: record.marketplace,
            agent: "claude-code",
            enabled: record.enabled,
            path: record.path,
            sourcePath: claudeInstalledPath,
          },
          {
            installedOn: "claude-code",
            activeOn: record.enabled === false ? undefined : "claude-code",
          },
          metadata,
        );
        if (candidate.errors) errors.push(...candidate.errors);
        addCandidate(artifacts, candidate);
      }
    }
  }

  const codexConfigPath = join(codexHome(home), "config.toml");
  let codexText: string | undefined;
  try {
    codexText = await readFile(codexConfigPath, "utf8");
    sources.push({ kind: "codex-config", path: codexConfigPath, status: "ok" });
  } catch (err) {
    if (isNotFound(err)) {
      sources.push({ kind: "codex-config", path: codexConfigPath, status: "missing" });
    } else {
      const message = errorMessage(err);
      sources.push({ kind: "codex-config", path: codexConfigPath, status: "error", error: message });
      errors.push({ source: "codex-config", path: codexConfigPath, message });
    }
  }
  if (codexText !== undefined) {
    try {
      const config = codexText.trim() ? (TOML.parse(codexText) as Record<string, unknown>) : {};
      const plugins = config.plugins;
      if (plugins && typeof plugins === "object" && !Array.isArray(plugins)) {
        for (const [id, value] of Object.entries(plugins as Record<string, unknown>)) {
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          if ((value as { enabled?: unknown }).enabled === false) continue;
          const { name, marketplace } = parsePluginId(id);
          addCandidate(artifacts, {
            name,
            marketplace,
            configuredOn: "codex",
            evidence: {
              kind: "codex-config",
              name,
              marketplace,
              agent: "codex",
              enabled: true,
              sourcePath: codexConfigPath,
            },
          });
        }
      }
    } catch (err) {
      const message = `invalid TOML: ${errorMessage(err)}`;
      markSourceError(sources, "codex-config", codexConfigPath, message);
      errors.push({ source: "codex-config", path: codexConfigPath, message });
    }
  }

  const finalized = artifacts.map((artifact): PluginInventoryArtifact => {
    const aliases = [...artifact.names].sort();
    const canonicalName = artifact.canonicalNames[0] ?? aliases[0] ?? "unknown";
    const marketplaces = [...artifact.marketplaces].sort();
    const sourceRepo = artifact.sourceRepos.sort((a, b) => b.priority - a.priority)[0]?.value;
    const pluginRoot = [...artifact.pluginRoots][0];
    const sourcePluginPath = [...artifact.sourcePluginPaths][0];
    const sourceVersion = [...artifact.sourceVersions].sort((a, b) => b.length - a.length)[0];
    const contentFingerprint = [...artifact.contentFingerprints][0];
    const marketplaceRoot = [...artifact.marketplaceRoots][0];
    const installedOn = [...artifact.installedOn].sort();
    const activeOn = [...artifact.activeOn].sort();
    const configuredOn = [...artifact.configuredOn].sort();
    const eligible = activeOn.length > 0 || configuredOn.length > 0;
    const artifactKey = createArtifactKey({
      names: [...artifact.names].sort(),
      canonicalNames: [...artifact.canonicalNames].sort(),
      marketplaces,
      pluginRoots: [...artifact.pluginRoots].sort(),
      sourcePluginPaths: [...artifact.sourcePluginPaths].sort(),
      sourceVersions: [...artifact.sourceVersions].sort(),
      contentFingerprints: [...artifact.contentFingerprints].sort(),
      marketplaceRoots: [...artifact.marketplaceRoots].sort(),
      sourceRepos: artifact.sourceRepos.map((item) => item.value).sort(),
      evidence: artifact.evidence
        .map(({ enabled: _enabled, ...item }) => item)
        .sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        ),
    });
    return {
      artifactKey,
      id: marketplaces[0] ? `${canonicalName}@${marketplaces[0]}` : canonicalName,
      canonicalName,
      aliases,
      identityKeys: [...new Set(aliases.flatMap(pluginIdentityKeys))].sort(),
      marketplaces,
      sourceRepo,
      sourcePluginPath,
      sourceVersion,
      contentFingerprint,
      pluginRoot,
      marketplaceRoot,
      payload: artifact.payload,
      installedOn,
      activeOn,
      configuredOn,
      catalogueOnly: !eligible && installedOn.length === 0,
      eligible,
      evidence: artifact.evidence,
      errors: artifact.errors,
    };
  });

  finalized.sort((a, b) => a.id.localeCompare(b.id) || (a.pluginRoot ?? "").localeCompare(b.pluginRoot ?? ""));
  return { artifacts: finalized, sources, errors };
}
