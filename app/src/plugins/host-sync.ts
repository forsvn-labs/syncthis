import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AgentId } from "../types.ts";
import { isSafeIdentifier, isSafeSkillName } from "./shell.ts";
import { walkSecureTree } from "./secure-tree.ts";
import { CANONICAL_MANIFEST_PATH } from "./agent-plugins-v1.ts";
import {
  readPluginPackage,
  SYNCTHIS_MARKER,
  type PluginPackage,
} from "./source.ts";
import {
  agentHostMap,
  hasDirectoryDropPlugin,
  hasDirectoryDropSkills,
  resolveAgentHost,
  type AgentHostDirectories,
  type PluginAbi,
} from "./host-map.ts";

const HOST_PLUGIN_KIND = "host-plugin";
const HOST_SKILL_KIND = "host-skill";

export type HostWriteStatus =
  | "created"
  | "present"
  | "would-create"
  | "conflict"
  | "failed";

export type HostWriteResult = {
  agent: AgentId;
  name: string;
  path: string;
  status: HostWriteStatus;
  message?: string;
};

export type HostEntry = {
  name: string;
  path: string;
  managed: boolean;
  fingerprint?: string;
};

type HostMarker = {
  managedBy: "syncthis";
  kind: typeof HOST_PLUGIN_KIND | typeof HOST_SKILL_KIND;
  agent: AgentId;
  name: string;
  fingerprint: string;
};

type HostFile = { relativePath: string; bytes: Buffer; mode: number };

function isNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "ENOENT";
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isSecretBearing(relativePath: string): boolean {
  const base = relativePath.split("/").pop()?.toLowerCase() ?? "";
  return (
    base === "mcp.json" ||
    base === ".mcp.json" ||
    base === "auth.json" ||
    base.endsWith(".env") ||
    base.includes("credential") ||
    base.includes("secret")
  );
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

async function readMarker(root: string): Promise<HostMarker | null> {
  try {
    const info = await lstat(join(root, SYNCTHIS_MARKER));
    if (info.isSymbolicLink() || !info.isFile()) return null;
    const raw = JSON.parse(await readFile(join(root, SYNCTHIS_MARKER), "utf8")) as HostMarker;
    if (raw?.managedBy !== "syncthis") return null;
    if (raw.kind !== HOST_PLUGIN_KIND && raw.kind !== HOST_SKILL_KIND) return null;
    if (typeof raw.name !== "string" || typeof raw.fingerprint !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

function pluginHasRootManifest(pkg: PluginPackage): boolean {
  return pkg.files.some((file) => file.relativePath === CANONICAL_MANIFEST_PATH);
}

function filesForHostPlugin(pkg: PluginPackage): HostFile[] {
  if (pluginHasRootManifest(pkg)) return pkg.files;
  return [
    ...pkg.files,
    {
      relativePath: CANONICAL_MANIFEST_PATH,
      bytes: Buffer.from(`${JSON.stringify({ name: pkg.identity.pluginName }, null, 2)}\n`),
      mode: 0o644,
    },
  ];
}

async function writeTree(destination: string, files: HostFile[]): Promise<void> {
  const directories = new Set<string>([destination]);
  for (const file of files) {
    directories.add(join(destination, dirname(file.relativePath)));
  }
  for (const directory of [...directories].sort((left, right) => left.length - right.length)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  for (const file of files) {
    const path = join(destination, file.relativePath);
    if (!within(destination, path)) {
      throw new Error(`host write escapes destination: ${file.relativePath}`);
    }
    const mode = isSecretBearing(file.relativePath) ? 0o600 : file.mode & 0o777 || 0o644;
    await writeFile(path, file.bytes, { flag: "wx", mode });
    await chmod(path, mode);
  }
}

async function replaceManagedTree(
  dest: string,
  files: HostFile[],
  marker: HostMarker,
): Promise<void> {
  const parent = dirname(dest);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await isSymlink(parent)) || (await isSymlink(dest))) {
    throw new Error(`syncthis: refusing to write host tree through a symlink: ${dest}`);
  }
  const staging = await mkdtemp(join(parent, ".syncthis-host-"));
  try {
    await writeTree(staging, files);
    await writeFile(
      join(staging, SYNCTHIS_MARKER),
      `${JSON.stringify(marker, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (await isDirectory(dest)) {
      const previous = await readMarker(dest);
      if (!previous) {
        throw new Error(`refusing to replace unmanaged host directory: ${dest}`);
      }
      await rm(dest, { recursive: true, force: false });
    }
    await rename(staging, dest);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function skillTreesFromFiles(
  pluginName: string,
  fingerprint: string,
  files: HostFile[],
): { name: string; files: HostFile[]; fingerprint: string }[] {
  const skillMd = files.filter(
    (file) => file.relativePath === "SKILL.md" || file.relativePath.endsWith("/SKILL.md"),
  );
  const trees: { name: string; files: HostFile[]; fingerprint: string }[] = [];
  const seen = new Set<string>();
  for (const md of skillMd) {
    const dir = md.relativePath === "SKILL.md"
      ? ""
      : md.relativePath.slice(0, -"SKILL.md".length).replace(/\/$/, "");
    const name = dir === "" ? pluginName : dir.split("/").pop() ?? "";
    if (!isSafeSkillName(name) || seen.has(name)) continue;
    seen.add(name);
    const prefix = dir === "" ? "" : `${dir}/`;
    const skillFiles = files
      .filter((file) => (prefix ? file.relativePath.startsWith(prefix) : file.relativePath === "SKILL.md"))
      .map((file) => ({
        relativePath: prefix ? file.relativePath.slice(prefix.length) : file.relativePath,
        bytes: file.bytes,
        mode: file.mode,
      }))
      .filter((file) => file.relativePath && !file.relativePath.startsWith("/") && !file.relativePath.includes(".."));
    if (!skillFiles.some((file) => file.relativePath === "SKILL.md")) continue;
    trees.push({
      name,
      files: skillFiles,
      fingerprint: `${fingerprint}:${name}`,
    });
  }
  return trees;
}

async function snapshotFiles(root: string): Promise<HostFile[]> {
  const files: HostFile[] = [];
  await walkSecureTree(
    root,
    "host skill source",
    {
      allowContainedSymlinks: true,
      skipDirectoryNames: new Set([".git", "node_modules"]),
      ignoredPaths: new Set([SYNCTHIS_MARKER]),
    },
    {
      async directory() {},
      async file(relativePath, bytes, mode) {
        files.push({ relativePath, bytes, mode });
      },
    },
  );
  return files;
}

async function skillTreesFromRoot(
  root: string,
): Promise<{ pluginName: string; trees: { name: string; files: HostFile[]; fingerprint: string }[] }> {
  try {
    const pkg = await readPluginPackage(root);
    return {
      pluginName: pkg.identity.pluginName,
      trees: skillTreesFromFiles(pkg.identity.pluginName, pkg.identity.fingerprint, pkg.files),
    };
  } catch {
    const files = await snapshotFiles(root);
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(file.relativePath);
      hash.update("\0");
      hash.update(file.bytes);
    }
    const pluginName = basename(root);
    return {
      pluginName,
      trees: skillTreesFromFiles(pluginName, hash.digest("hex"), files),
    };
  }
}

async function listManagedChildren(dir: string | null): Promise<HostEntry[]> {
  if (!dir) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const out: HostEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    if (!(await isDirectory(path))) continue;
    const marker = await readMarker(path);
    out.push({
      name,
      path,
      managed: !!marker,
      fingerprint: marker?.fingerprint,
    });
  }
  return out.sort((left, right) => left.name.localeCompare(right.name));
}

export async function listHostPlugins(agent: AgentId): Promise<HostEntry[]> {
  const host = resolveAgentHost(agent);
  if (host.plugin.kind !== "directory-drop") return [];
  return listManagedChildren(host.plugin.path);
}

export async function listHostSkills(agent: AgentId): Promise<HostEntry[]> {
  const host = resolveAgentHost(agent);
  if (host.skills.kind !== "directory-drop") return [];
  const entries = await listManagedChildren(host.skills.path);
  const withSkill: HostEntry[] = [];
  for (const entry of entries) {
    try {
      const info = await lstat(join(entry.path, "SKILL.md"));
      if (info.isFile() || info.isSymbolicLink()) withSkill.push(entry);
    } catch {
      /* empty dir or missing SKILL.md is not a loaded skill */
    }
  }
  return withSkill;
}

export async function findHostPlugin(agent: AgentId, name: string): Promise<HostEntry | undefined> {
  const entries = await listHostPlugins(agent);
  return entries.find((entry) => entry.name === name);
}

export async function writeHostPlugin(
  agent: AgentId,
  sourcePluginPath: string,
  opts: { dryRun: boolean },
): Promise<HostWriteResult> {
  const host = resolveAgentHost(agent);
  if (host.plugin.kind !== "directory-drop" || !host.plugin.path) {
    return {
      agent,
      name: "",
      path: "",
      status: "failed",
      message: `${agent} has no directory-drop plugin home`,
    };
  }
  let pkg: PluginPackage;
  try {
    pkg = await readPluginPackage(sourcePluginPath);
  } catch (err) {
    return {
      agent,
      name: "",
      path: host.plugin.path,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  const name = pkg.identity.pluginName;
  if (!isSafeIdentifier(name) || name.startsWith("-")) {
    return {
      agent,
      name,
      path: host.plugin.path,
      status: "failed",
      message: `plugin name is not safe as a host directory: ${JSON.stringify(name)}`,
    };
  }
  const dest = join(host.plugin.path, name);
  if (!within(host.plugin.path, dest)) {
    return { agent, name, path: dest, status: "failed", message: "plugin destination escapes host plugin dir" };
  }
  const marker: HostMarker = {
    managedBy: "syncthis",
    kind: HOST_PLUGIN_KIND,
    agent,
    name,
    fingerprint: pkg.identity.fingerprint,
  };
  try {
    if (await isDirectory(dest)) {
      const previous = await readMarker(dest);
      if (!previous) {
        return {
          agent,
          name,
          path: dest,
          status: "conflict",
          message: "existing plugin directory is not Syncthis-managed; left untouched",
        };
      }
      if (previous.fingerprint === marker.fingerprint && previous.name === name) {
        return { agent, name, path: dest, status: "present", message: "already on disk" };
      }
    }
    if (opts.dryRun) {
      return { agent, name, path: dest, status: "would-create" };
    }
    await replaceManagedTree(dest, filesForHostPlugin(pkg), marker);
    return { agent, name, path: dest, status: "created" };
  } catch (err) {
    return {
      agent,
      name,
      path: dest,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function writeHostSkills(
  agent: AgentId,
  sourcePluginPath: string,
  opts: { dryRun: boolean },
): Promise<HostWriteResult[]> {
  const host = resolveAgentHost(agent);
  if (host.skills.kind !== "directory-drop" || !host.skills.path) {
    return [{
      agent,
      name: "",
      path: "",
      status: "failed",
      message: `${agent} has no skills directory`,
    }];
  }
  let trees: { name: string; files: HostFile[]; fingerprint: string }[];
  let pluginName: string;
  try {
    const loaded = await skillTreesFromRoot(sourcePluginPath);
    pluginName = loaded.pluginName;
    trees = loaded.trees;
  } catch (err) {
    return [{
      agent,
      name: "",
      path: host.skills.path,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    }];
  }
  if (trees.length === 0) {
    return [{
      agent,
      name: pluginName,
      path: host.skills.path,
      status: "failed",
      message: "plugin package has no portable SKILL.md tree",
    }];
  }
  const results: HostWriteResult[] = [];
  for (const tree of trees) {
    const dest = join(host.skills.path, tree.name);
    const marker: HostMarker = {
      managedBy: "syncthis",
      kind: HOST_SKILL_KIND,
      agent,
      name: tree.name,
      fingerprint: tree.fingerprint,
    };
    try {
      if (!within(host.skills.path, dest)) {
        results.push({
          agent,
          name: tree.name,
          path: dest,
          status: "failed",
          message: "skill destination escapes host skills dir",
        });
        continue;
      }
      if (await isDirectory(dest)) {
        const previous = await readMarker(dest);
        if (!previous) {
          results.push({
            agent,
            name: tree.name,
            path: dest,
            status: "conflict",
            message: "existing skill directory is not Syncthis-managed; left untouched",
          });
          continue;
        }
        if (previous.fingerprint === marker.fingerprint) {
          results.push({
            agent,
            name: tree.name,
            path: dest,
            status: "present",
            message: "already on disk",
          });
          continue;
        }
      }
      if (opts.dryRun) {
        results.push({ agent, name: tree.name, path: dest, status: "would-create" });
        continue;
      }
      await replaceManagedTree(dest, tree.files, marker);
      results.push({ agent, name: tree.name, path: dest, status: "created" });
    } catch (err) {
      results.push({
        agent,
        name: tree.name,
        path: dest,
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export async function removeManagedHostPlugin(
  agent: AgentId,
  name: string,
  opts: { dryRun: boolean },
): Promise<HostWriteResult> {
  if (!hasDirectoryDropPlugin(agent) || !isSafeIdentifier(name)) {
    return {
      agent,
      name,
      path: "",
      status: "failed",
      message: `${agent} has no removable directory-drop plugin named ${name}`,
    };
  }
  const host = resolveAgentHost(agent);
  const dest = join(host.plugin.path!, name);
  try {
    if (!(await isDirectory(dest))) {
      return { agent, name, path: dest, status: "present", message: "absent" };
    }
    const marker = await readMarker(dest);
    if (!marker) {
      return {
        agent,
        name,
        path: dest,
        status: "conflict",
        message: "existing plugin directory is not Syncthis-managed; left untouched",
      };
    }
    if (opts.dryRun) return { agent, name, path: dest, status: "would-create", message: "would remove" };
    await rm(dest, { recursive: true, force: false });
    return { agent, name, path: dest, status: "created", message: "removed" };
  } catch (err) {
    return {
      agent,
      name,
      path: dest,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function removeManagedHostSkill(
  agent: AgentId,
  name: string,
  opts: { dryRun: boolean },
): Promise<HostWriteResult> {
  if (!hasDirectoryDropSkills(agent) || !isSafeSkillName(name)) {
    return {
      agent,
      name,
      path: "",
      status: "failed",
      message: `${agent} has no removable skills directory entry named ${name}`,
    };
  }
  const host = resolveAgentHost(agent);
  const dest = join(host.skills.path!, name);
  try {
    if (!(await isDirectory(dest))) {
      return { agent, name, path: dest, status: "present", message: "absent" };
    }
    const marker = await readMarker(dest);
    if (!marker) {
      return {
        agent,
        name,
        path: dest,
        status: "conflict",
        message: "existing skill directory is not Syncthis-managed; left untouched",
      };
    }
    if (opts.dryRun) return { agent, name, path: dest, status: "would-create", message: "would remove" };
    await rm(dest, { recursive: true, force: false });
    return { agent, name, path: dest, status: "created", message: "removed" };
  } catch (err) {
    return {
      agent,
      name,
      path: dest,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export type HostDirectoryScan = {
  agent: AgentId;
  pluginAbi: PluginAbi;
  host: AgentHostDirectories;
  plugins: HostEntry[];
  skills: HostEntry[];
};

/**
 * Inventory of on-disk plugin and skill directories. Directory presence is not
 * native activation — native-cli agents still own their registries, and
 * write-only Cursor local drops remain adapted.
 */
export async function scanAgentHosts(): Promise<HostDirectoryScan[]> {
  const rows: HostDirectoryScan[] = [];
  for (const host of agentHostMap()) {
    rows.push({
      agent: host.agent,
      pluginAbi: host.pluginAbi,
      host,
      plugins: host.plugin.kind === "directory-drop" ? await listHostPlugins(host.agent) : [],
      skills: host.skills.kind === "directory-drop" ? await listHostSkills(host.agent) : [],
    });
  }
  return rows;
}
