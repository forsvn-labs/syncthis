import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  AGENT_PLUGINS_SPEC_VERSION,
  CANONICAL_MCP_PATH,
  CANONICAL_MANIFEST_PATH,
  agentPluginsSchemaVersion,
  validatePluginManifestV1,
  type V1ManifestValidation,
} from "./agent-plugins-v1.ts";
import { walkSecureTree } from "./secure-tree.ts";

const NATIVE_MANIFEST_DIRS = new Set([
  ".codex-plugin",
  ".claude-plugin",
  ".plugin",
  ".cursor-plugin",
]);
const SKIP_DIRS = new Set([".git", "node_modules"]);
export const SYNCTHIS_MARKER = ".syncthis-managed.json";

type PackageFile = {
  relativePath: string;
  bytes: Buffer;
  mode: number;
};

type PluginSourceSnapshot = {
  files: PackageFile[];
  directories: Set<string>;
};

export type PluginPackageIdentity = {
  fingerprint: string;
  pluginJsonPath: string;
  pluginName: string;
};

export type PluginPackage = {
  identity: PluginPackageIdentity;
  files: PackageFile[];
};

export type PluginSourceInspection = {
  canonicalName?: string;
  sourceRepo?: string;
  sourceVersion?: string;
  contentFingerprint?: string;
  manifests: string[];
  // Present only when a root plugin.json claims the Agent Plugins v1 schema.
  v1Canonical?: {
    valid: boolean;
    name?: string;
    errors: string[];
    warnings: string[];
  };
  payload: {
    nativeManifest: boolean;
    skills: boolean;
    mcp: boolean;
  };
};

// Read the root plugin.json (when present) and report whether it is an
// identity-authoritative Agent Plugins v1 manifest. A canonical manifest with
// fatal violations rejects package identity; unknown-field warnings never do.
function rootManifestV1State(
  files: PackageFile[],
): { validation: V1ManifestValidation; name: string | null } | { invalid: true; validation: V1ManifestValidation } | null {
  const file = files.find((candidate) => candidate.relativePath === "plugin.json");
  if (!file) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(file.bytes.toString("utf8"));
  } catch {
    // Unparseable JSON cannot claim the canonical schema, so it stays a
    // legacy-format candidate handled by the existing overlay priority.
    return null;
  }
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
  const validation = validatePluginManifestV1(raw);
  if (!validation.canonical) {
    const version = agentPluginsSchemaVersion(record?.$schema, "plugin");
    if (version === null) return null;
    // An Agent Plugins manifest schema from a different published version is
    // explicitly unsupported, not silently treated as legacy client data.
    return {
      invalid: true,
      validation: {
        canonical: true,
        valid: false,
        name: null,
        errors: [
          `unsupported Agent Plugins manifest schema version ${version}; supported: ${AGENT_PLUGINS_SPEC_VERSION}`,
        ],
        warnings: [],
      },
    };
  }
  return validation.valid ? { validation, name: validation.name } : { invalid: true, validation };
}

function repositoryFromManifest(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const repository = (raw as { repository?: unknown }).repository;
  if (typeof repository === "string" && repository.trim()) return repository;
  if (repository && typeof repository === "object" && !Array.isArray(repository)) {
    const url = (repository as { url?: unknown }).url;
    if (typeof url === "string" && url.trim()) return url;
  }
  return undefined;
}

function manifestDeclaresMcp(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const manifest = raw as Record<string, unknown>;
  for (const key of ["mcpServers", "mcp_servers"]) {
    const value = manifest[key];
    if (typeof value === "string" && value.trim()) return true;
    if (Array.isArray(value) && value.length > 0) return true;
    if (value && typeof value === "object" && Object.keys(value).length > 0) return true;
  }
  return false;
}

function isNativeManifestPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.length === 1) return parts[0] === "plugin.json";
  return parts.at(-1) === "plugin.json" && NATIVE_MANIFEST_DIRS.has(parts.at(-2) ?? "");
}

function nativeManifestPathPriority(path: string): number {
  if (path === ".codex-plugin/plugin.json") return 0;
  if (path === ".claude-plugin/plugin.json") return 1;
  if (path === ".plugin/plugin.json") return 2;
  if (path === ".cursor-plugin/plugin.json") return 3;
  if (path === "plugin.json") return 4;
  return 5;
}

function compareNativeManifestPaths(left: string, right: string): number {
  return nativeManifestPathPriority(left) - nativeManifestPathPriority(right) || left.localeCompare(right);
}

/**
 * Take one stable, no-follow snapshot of a plugin tree. The old source reader
 * used lstat for discovery and ordinary readFile for content, which allowed an
 * entry to be replaced between those operations. All source inspection and
 * content-addressing now share this hardened traversal.
 */
async function snapshotPluginSource(root: string): Promise<PluginSourceSnapshot> {
  const files: PackageFile[] = [];
  const directories = new Set<string>();
  await walkSecureTree(
    root,
    "plugin package",
    {
      allowContainedSymlinks: true,
      skipDirectoryNames: SKIP_DIRS,
      ignoredPaths: new Set([SYNCTHIS_MARKER]),
    },
    {
      async directory(rel) {
        if (rel) directories.add(rel);
      },
      async file(relativePath, bytes, mode) {
        files.push({ relativePath, bytes, mode });
      },
    },
  );
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { files, directories };
}

export async function findNativePluginManifests(root: string): Promise<string[]> {
  const snapshot = await snapshotPluginSource(root);
  return snapshot.files
    .map((file) => file.relativePath)
    .filter(isNativeManifestPath)
    .sort(compareNativeManifestPaths);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function packageManifestPaths(files: PackageFile[]): string[] {
  return files
    .map((file) => file.relativePath)
    .filter(isNativeManifestPath)
    .sort(compareNativeManifestPaths);
}

async function collectPackageFiles(root: string): Promise<PackageFile[]> {
  return (await snapshotPluginSource(root)).files;
}

function packageFingerprint(files: PackageFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update((file.mode & 0o111) !== 0 ? "1" : "0");
    hash.update("\0");
    hash.update(String(file.bytes.byteLength));
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function readPluginPackage(root: string): Promise<PluginPackage> {
  const files = await collectPackageFiles(root);
  const manifests = packageManifestPaths(files);

  // A root plugin.json carrying the exact Agent Plugins v1 schema identifier
  // is identity-authoritative: it wins over every overlay manifest, and fatal
  // violations in it reject the whole package identity.
  const v1 = rootManifestV1State(files);
  if (v1 && "invalid" in v1) {
    throw new Error(
      `plugin package canonical Agent Plugins v1 manifest is invalid (${v1.validation.errors.join("; ")}): ${root}`,
    );
  }

  const pluginJsonPath = manifests[0];
  if (!pluginJsonPath) {
    throw new Error(`plugin package requires plugin.json metadata: ${root}`);
  }

  let pluginName: unknown;
  try {
    if (v1 && "validation" in v1) {
      pluginName = v1.name ?? "";
    } else {
      const manifest = JSON.parse(
        (files.find((file) => file.relativePath === pluginJsonPath)?.bytes ?? Buffer.from(""))
          .toString("utf8"),
      ) as { name?: unknown };
      pluginName = manifest.name;
    }
  } catch (err) {
    throw new Error(
      `plugin package plugin.json is not readable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof pluginName !== "string" || !pluginName.trim()) {
    throw new Error(`plugin package plugin.json requires a non-empty name: ${pluginJsonPath}`);
  }

  return {
    files,
    identity: {
      fingerprint: packageFingerprint(files),
      pluginJsonPath: v1 && "validation" in v1 ? "plugin.json" : pluginJsonPath,
      pluginName,
    },
  };
}

export async function identifyPluginPackage(root: string): Promise<PluginPackageIdentity> {
  return (await readPluginPackage(root)).identity;
}

export async function hashPluginPackage(root: string): Promise<string> {
  return (await identifyPluginPackage(root)).fingerprint;
}

// Descriptive aliases for callers that only need the content-address identity.
export const fingerprintPluginPackage = hashPluginPackage;
export const pluginPackageIdentity = identifyPluginPackage;

function skillsFingerprint(files: PackageFile[]): string | undefined {
  const relevant = files.filter(
    (file) =>
      file.relativePath === "SKILL.md" ||
      file.relativePath.startsWith("skills/") ||
      file.relativePath === ".mcp.json" ||
      // The canonical Agent Plugins v1 MCP document is part of the portable
      // payload and must move the inventory fingerprint when it changes.
      file.relativePath === CANONICAL_MCP_PATH ||
      isNativeManifestPath(file.relativePath),
  );
  if (relevant.length === 0) return undefined;

  const hash = createHash("sha256");
  const seenManifests = new Set<string>();
  for (const file of [...relevant].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    if (isNativeManifestPath(file.relativePath)) {
      try {
        const canonical = canonicalJson(JSON.parse(file.bytes.toString("utf8")));
        // A managed marketplace adds a target-native manifest alongside the
        // source manifest. Identical semantic manifests describe one artifact,
        // regardless of wrapper path or formatting, and must not split inventory
        // on the next idempotent reconciliation pass.
        if (seenManifests.has(canonical)) continue;
        seenManifests.add(canonical);
        hash.update("native-manifest");
        hash.update("\0");
        hash.update(canonical);
        hash.update("\0");
        continue;
      } catch {
        // Keep malformed candidates path-sensitive; inspection will not treat
        // them as authoritative native manifests.
      }
    }
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function versionFromRoot(root: string): string | undefined {
  const value = basename(root);
  return /^[a-f0-9]{7,64}$/i.test(value) ? value.toLowerCase() : undefined;
}

export async function inspectPluginSource(root: string): Promise<PluginSourceInspection> {
  const snapshot = await snapshotPluginSource(root);
  const manifests = snapshot.files
    .map((file) => file.relativePath)
    .filter(isNativeManifestPath)
    .sort(compareNativeManifestPaths);

  const v1 = rootManifestV1State(snapshot.files);
  const v1Canonical = v1
    ? {
        valid: !("invalid" in v1),
        name: ("name" in v1 ? v1.name : undefined) ?? undefined,
        errors: [...v1.validation.errors],
        warnings: [...v1.validation.warnings],
      }
    : undefined;

  let canonicalName: string | undefined;
  let rootRepository: string | undefined;
  if (v1 && "validation" in v1) {
    // A canonical Agent Plugins v1 manifest owns identity; overlay names are
    // ignored entirely, and an invalid one rejects identity components below.
    canonicalName = ("name" in v1 ? v1.name : undefined) ?? undefined;
    // Canonical metadata authority: a VALID root manifest's repository wins
    // over every overlay repository. Only when the root omits it do overlays
    // fall through below. An invalid root contributes nothing.
    if (!("invalid" in v1)) {
      const rootFile = snapshot.files.find((file) => file.relativePath === CANONICAL_MANIFEST_PATH);
      if (rootFile) {
        try {
          rootRepository = repositoryFromManifest(JSON.parse(rootFile.bytes.toString("utf8")));
        } catch {
          // An unparseable root manifest cannot contribute metadata here;
          // identity was already rejected by validation above when fatal.
        }
      }
    }
  }
  let sourceRepo: string | undefined = rootRepository;
  let manifestMcp = false;
  for (const rel of manifests) {
    try {
      const raw = JSON.parse(
        snapshot.files.find((file) => file.relativePath === rel)!.bytes.toString("utf8"),
      ) as {
        name?: unknown;
        repository?: unknown;
      };
      if (!canonicalName && typeof raw.name === "string" && raw.name.trim()) canonicalName = raw.name;
      sourceRepo ??= repositoryFromManifest(raw);
      manifestMcp ||= manifestDeclaresMcp(raw);
    } catch {
      // A malformed candidate does not hide other recognized manifests.
    }
  }

  const filePaths = new Set(snapshot.files.map((file) => file.relativePath));
  // Fatal violations in a canonical manifest reject package identity and
  // component discovery; only warnings survive as nonfatal diagnostics.
  const identityRejected = v1 !== null && "invalid" in v1;
  const canonicalDiscovery = v1 !== null && !identityRejected;
  return {
    canonicalName: identityRejected ? undefined : canonicalName,
    sourceRepo,
    sourceVersion: versionFromRoot(root),
    // Keep the narrower inventory fingerprint stable for wrapper paths that
    // rewrite the native manifest location. Full package identity is exposed
    // separately by identifyPluginPackage/hashPluginPackage and owns the store.
    contentFingerprint: skillsFingerprint(snapshot.files),
    manifests,
    ...(v1Canonical ? { v1Canonical } : {}),
    payload: {
      nativeManifest: manifests.length > 0 && !identityRejected,
      skills: !identityRejected &&
        (canonicalDiscovery
          ? // Canonical packages discover skills ONLY as immediate
            // skills/<name>/SKILL.md children (§6.1): no root SKILL.md, no
            // empty skills dir, no recursive descendants.
            [...filePaths].some((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path))
          : filePaths.has("SKILL.md") ||
            snapshot.directories.has("skills") ||
            [...filePaths].some((path) => path.startsWith("skills/"))),
      mcp: !identityRejected &&
        (canonicalDiscovery
          ? // Canonical MCP comes ONLY from the root mcp.json (§7.2.2);
            // .mcp.json and inline manifest fields are legacy-only sources.
            filePaths.has(CANONICAL_MCP_PATH)
          : manifestMcp || filePaths.has(".mcp.json")),
    },
  };
}
export async function hasSkillManifest(root: string): Promise<boolean> {
  const snapshot = await snapshotPluginSource(root);
  const v1 = rootManifestV1State(snapshot.files);
  if (v1 !== null) {
    // Canonical packages: an invalid or unsupported root manifest rejects
    // component discovery; a valid one discovers ONLY immediate
    // skills/<name>/SKILL.md children.
    if ("invalid" in v1 || !v1.validation.valid) return false;
    return snapshot.files.some((file) => /^skills\/[^/]+\/SKILL\.md$/.test(file.relativePath));
  }
  // Legacy client formats keep the broad discovery behavior.
  return snapshot.files.some(
    (file) => file.relativePath === "SKILL.md" || file.relativePath.endsWith("/SKILL.md"),
  );
}
