import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const NATIVE_MANIFEST_DIRS = new Set([
  ".codex-plugin",
  ".claude-plugin",
  ".plugin",
  ".cursor-plugin",
]);
const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_DEPTH = 10;

export type PluginSourceInspection = {
  canonicalName?: string;
  sourceRepo?: string;
  sourceVersion?: string;
  contentFingerprint?: string;
  manifests: string[];
  payload: {
    nativeManifest: boolean;
    skills: boolean;
    mcp: boolean;
  };
};

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

async function walkFiles(
  root: string,
  current: string,
  depth: number,
  out: string[],
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walkFiles(root, path, depth + 1, out);
    } else if (entry.isFile()) {
      out.push(relative(root, path));
    }
  }
}

export async function findNativePluginManifests(root: string): Promise<string[]> {
  const files: string[] = [];
  await walkFiles(root, root, 0, files);
  return files
    .filter((rel) => {
      const parts = rel.split(/[\\/]/);
      if (parts.length === 1) return parts[0] === "plugin.json";
      return parts.at(-1) === "plugin.json" && NATIVE_MANIFEST_DIRS.has(parts.at(-2) ?? "");
    })
    .sort((a, b) => {
      const rootPriority = (path: string): number => {
        if (path === ".codex-plugin/plugin.json") return 0;
        if (path === ".claude-plugin/plugin.json") return 1;
        if (path === ".plugin/plugin.json") return 2;
        if (path === ".cursor-plugin/plugin.json") return 3;
        if (path === "plugin.json") return 4;
        return 5;
      };
      return rootPriority(a) - rootPriority(b) || a.localeCompare(b);
    });
}

function isNativeManifestPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.length === 1) return parts[0] === "plugin.json";
  return parts.at(-1) === "plugin.json" && NATIVE_MANIFEST_DIRS.has(parts.at(-2) ?? "");
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

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function skillsFingerprint(root: string): Promise<string | undefined> {
  const files: string[] = [];
  await walkFiles(root, root, 0, files);
  const relevant = files.filter(
    (rel) =>
      rel === "SKILL.md" ||
      rel.startsWith(`skills/`) ||
      rel === ".mcp.json" ||
      isNativeManifestPath(rel),
  );
  if (relevant.length === 0) return undefined;

  const hash = createHash("sha256");
  const seenManifests = new Set<string>();
  for (const rel of relevant.sort()) {
    let content: Buffer;
    try {
      content = await readFile(join(root, rel));
    } catch {
      return undefined;
    }
    if (isNativeManifestPath(rel)) {
      try {
        const canonical = canonicalJson(JSON.parse(content.toString("utf8")));
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
    hash.update(rel);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function versionFromRoot(root: string): string | undefined {
  const value = basename(root);
  return /^[a-f0-9]{7,64}$/i.test(value) ? value.toLowerCase() : undefined;
}

export async function inspectPluginSource(root: string): Promise<PluginSourceInspection> {
  const manifests = await findNativePluginManifests(root);
  let canonicalName: string | undefined;
  let sourceRepo: string | undefined;
  let manifestMcp = false;

  for (const rel of manifests) {
    try {
      const raw = JSON.parse(await readFile(join(root, rel), "utf8")) as {
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

  return {
    canonicalName,
    sourceRepo,
    sourceVersion: versionFromRoot(root),
    contentFingerprint: await skillsFingerprint(root),
    manifests,
    payload: {
      nativeManifest: manifests.length > 0,
      skills:
        (await pathIsFile(join(root, "SKILL.md"))) ||
        (await pathIsDirectory(join(root, "skills"))),
      mcp: manifestMcp || (await pathIsFile(join(root, ".mcp.json"))),
    },
  };
}

export async function hasSkillManifest(root: string): Promise<boolean> {
  const files: string[] = [];
  await walkFiles(root, root, 0, files);
  return files.some((rel) => rel === "SKILL.md" || rel.endsWith("/SKILL.md"));
}
