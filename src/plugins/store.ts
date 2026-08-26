import { homedir } from "node:os";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile, chmod, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveSyncthisDataHome } from "./data-home.ts";
import {
  readPluginPackage,
  SYNCTHIS_MARKER,
  type PluginPackage,
} from "./source.ts";

const STORE_VERSION = 1;

/**
 * Syncthis-owned content store used at the composition boundary. Derived from
 * the one canonical data root (SYNCTHIS_DATA_HOME → XDG_DATA_HOME → the user's
 * data home) so previews and applies agree on the exact location.
 */
export function resolvePluginStoreRoot(): string {
  return join(resolveSyncthisDataHome(), "syncthis", "plugins");
}

type StoreMarker = {
  managedBy: "syncthis";
  kind: "plugin-package";
  version: number;
  identity: string;
  pluginJsonPath: string;
  pluginName: string;
};

export type MaterializePluginPackageStatus = "created" | "present" | "would-create";

export type MaterializePluginPackageResult = {
  identity: string;
  root: string;
  status: MaterializePluginPackageStatus;
  pluginJsonPath: string;
  pluginName: string;
};

function isNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "ENOENT";
}

function isConflict(err: unknown): boolean {
  return !!err && typeof err === "object" && ["EEXIST", "ENOTEMPTY"].includes((err as { code?: string }).code ?? "");
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function assertStoreRoot(storeRoot: string): Promise<void> {
  if (!isAbsolute(storeRoot)) {
    throw new Error(`plugin store root must be absolute: ${storeRoot}`);
  }

  // Validate every existing component, not only the leaf. This makes dry-run
  // reject the same file/symlink destination that apply would otherwise reach
  // through recursive mkdir, without creating anything during preview.
  let current = storeRoot;
  let checkingLeaf = true;
  while (true) {
    let info;
    try {
      info = await lstat(current);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      checkingLeaf = false;
      continue;
    }

    if (info.isSymbolicLink()) {
      // The store root itself must not be redirected. Standard macOS/Linux
      // paths may have a system-level symlink ancestor (for example /var),
      // so validate those by resolving them to a directory rather than
      // rejecting every otherwise-safe XDG path.
      if (checkingLeaf) {
        throw new Error(`plugin store root is a symlink: ${current}`);
      }
      const resolved = await realpath(current);
      const target = await lstat(resolved);
      if (!target.isDirectory()) {
        throw new Error(`plugin store path component is not a directory: ${current}`);
      }
    } else if (!info.isDirectory()) {
      throw new Error(`plugin store root is not a directory: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    checkingLeaf = false;
  }
}

async function readMarker(root: string): Promise<StoreMarker> {
  const markerPath = join(root, SYNCTHIS_MARKER);
  const info = await lstat(markerPath);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error(`refusing to reuse unowned plugin store destination: ${root}`);
  }
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (err) {
    throw new Error(
      `refusing to reuse invalid Syncthis plugin store marker: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    throw new Error(`refusing to reuse invalid Syncthis plugin store marker: ${root}`);
  }
  return marker as StoreMarker;
}

async function verifyDestination(
  root: string,
  expected: PluginPackage,
): Promise<void> {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || (rootInfo.mode & 0o777) !== 0o700) {
    throw new Error(`refusing to reuse non-directory or unsafe-mode plugin store destination: ${root}`);
  }
  const marker = await readMarker(root);
  if (
    marker.managedBy !== "syncthis" ||
    marker.kind !== "plugin-package" ||
    marker.version !== STORE_VERSION ||
    marker.identity !== expected.identity.fingerprint ||
    marker.pluginJsonPath !== expected.identity.pluginJsonPath ||
    marker.pluginName !== expected.identity.pluginName
  ) {
    throw new Error(`refusing to reuse mismatched plugin store destination: ${root}`);
  }
  const actual = await readPluginPackage(root);
  if (
    actual.identity.fingerprint !== expected.identity.fingerprint ||
    actual.identity.pluginJsonPath !== expected.identity.pluginJsonPath ||
    actual.identity.pluginName !== expected.identity.pluginName
  ) {
    throw new Error(`refusing to reuse tampered plugin store destination: ${root}`);
  }
}

async function writePackage(packageData: PluginPackage, destination: string): Promise<void> {
  const directories = new Set<string>();
  for (const file of packageData.files) {
    const path = join(destination, file.relativePath);
    directories.add(dirname(path));
  }
  for (const directory of [...directories].sort((left, right) => left.length - right.length)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  for (const file of packageData.files) {
    const path = join(destination, file.relativePath);
    await writeFile(path, file.bytes, { flag: "wx", mode: file.mode & 0o777 });
    await chmod(path, file.mode & 0o777);
  }
}

function markerFor(packageData: PluginPackage): StoreMarker {
  return {
    managedBy: "syncthis",
    kind: "plugin-package",
    version: STORE_VERSION,
    identity: packageData.identity.fingerprint,
    pluginJsonPath: packageData.identity.pluginJsonPath,
    pluginName: packageData.identity.pluginName,
  };
}

export async function materializePluginPackage(options: {
  sourcePluginPath: string;
  storeRoot: string;
  dryRun: boolean;
}): Promise<MaterializePluginPackageResult> {
  if (!isAbsolute(options.sourcePluginPath)) {
    throw new Error(`plugin package source must be absolute: ${options.sourcePluginPath}`);
  }
  if (!isAbsolute(options.storeRoot)) {
    throw new Error(`plugin store root must be absolute: ${options.storeRoot}`);
  }

  const packageData = await readPluginPackage(options.sourcePluginPath);
  await assertStoreRoot(options.storeRoot);
  const root = join(options.storeRoot, packageData.identity.fingerprint);
  if (!within(options.storeRoot, root)) {
    throw new Error(`plugin store destination escapes store root: ${root}`);
  }

  let destinationExists = true;
  try {
    await lstat(root);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    destinationExists = false;
  }
  if (destinationExists) {
    await verifyDestination(root, packageData);
    return {
      identity: packageData.identity.fingerprint,
      root,
      status: "present",
      pluginJsonPath: packageData.identity.pluginJsonPath,
      pluginName: packageData.identity.pluginName,
    };
  }

  const result = {
    identity: packageData.identity.fingerprint,
    root,
    status: "would-create" as const,
    pluginJsonPath: packageData.identity.pluginJsonPath,
    pluginName: packageData.identity.pluginName,
  };
  if (options.dryRun) return result;

  await mkdir(options.storeRoot, { recursive: true, mode: 0o700 });
  await assertStoreRoot(options.storeRoot);
  await chmod(options.storeRoot, 0o700);
  const temporary = await mkdtemp(join(options.storeRoot, ".syncthis-tmp-"));
  try {
    await writePackage(packageData, temporary);
    const staged = await readPluginPackage(temporary);
    if (
      staged.identity.fingerprint !== packageData.identity.fingerprint ||
      staged.identity.pluginJsonPath !== packageData.identity.pluginJsonPath ||
      staged.identity.pluginName !== packageData.identity.pluginName
    ) {
      throw new Error("plugin package changed while it was being staged");
    }
    await writeFile(
      join(temporary, SYNCTHIS_MARKER),
      `${JSON.stringify(markerFor(packageData), null, 2)}\n`,
      { mode: 0o600 },
    );
    try {
      await rename(temporary, root);
    } catch (err) {
      if (!isConflict(err)) throw err;
      await verifyDestination(root, packageData);
      return { ...result, status: "present" };
    }
    await verifyDestination(root, packageData);
    return { ...result, status: "created" };
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

export const materializePluginSource = materializePluginPackage;
