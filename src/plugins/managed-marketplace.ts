import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { expandHome } from "../io.ts";
import { codexPluginIdentityCandidates } from "./shell.ts";
import { inspectPluginSource } from "./source.ts";

const MANAGED_VERSION = 3;
const PUBLICATION_LOCK_WAIT_MS = 5_000;
const PUBLICATION_LOCK_POLL_MS = 20;

type ManagedMarker = {
  managedBy: "syncthis";
  version: number;
  canonicalName: string;
  safeName: string;
  sourceFingerprint: string;
  managedFingerprint: string;
};
type ManagedMarkerIdentity = Omit<ManagedMarker, "managedFingerprint">;

export type ManagedCodexMarketplace = {
  marketplaceName: string;
  pluginName: string;
  root: string;
  pluginPath: string;
  status: "present" | "created" | "would-create";
};

export class ManagedMarketplaceUnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedMarketplaceUnsupportedFormatError";
  }
}

export function resolveCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? resolve(expandHome(configured)) : join(process.env.HOME ?? homedir(), ".codex");
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safePluginName(originalName: string): string | undefined {
  return codexPluginIdentityCandidates(originalName)[0];
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

function isPublishConflict(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

async function assertDirectoryComponent(path: string, label: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`${label} is a symlink: ${path}`);
    if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

async function assertManagedConfinement(
  codexHome: string,
  parent: string,
  root?: string,
): Promise<void> {
  if (!isWithin(codexHome, parent) || (root && !isWithin(codexHome, root))) {
    throw new Error(`managed marketplace path escapes CODEX_HOME: ${root ?? parent}`);
  }

  const homeExists = await assertDirectoryComponent(codexHome, "CODEX_HOME");
  const syncthisRoot = join(codexHome, "syncthis");
  await assertDirectoryComponent(syncthisRoot, "managed marketplace parent");
  const parentExists = await assertDirectoryComponent(parent, "managed marketplace parent");
  if (root) await assertDirectoryComponent(root, "managed marketplace root");

  if (!homeExists || !parentExists) return;
  const [realHome, realParent] = await Promise.all([realpath(codexHome), realpath(parent)]);
  if (!isWithin(realHome, realParent)) {
    throw new Error(`managed marketplace parent escapes CODEX_HOME through a symlink: ${parent}`);
  }
  if (root) {
    try {
      const realRoot = await realpath(root);
      if (!isWithin(realHome, realRoot) || !isWithin(realParent, realRoot)) {
        throw new Error(`managed marketplace root escapes CODEX_HOME through a symlink: ${root}`);
      }
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

async function fingerprintTree(
  root: string,
  context: string,
  ignoredPaths: ReadonlySet<string> = new Set(),
  allowContainedSymlinks = false,
): Promise<string> {
  const hash = createHash("sha256");

  await walkTree(root, context, allowContainedSymlinks, ignoredPaths, {
    async directory(rel, mode) {
      if (rel) {
        hash.update(`d\0${rel}\0${mode & 0o777}\0`);
      }
    },
    async file(rel, content, mode) {
      hash.update(`f\0${rel}\0${mode & 0o777}\0`);
      hash.update(content);
      hash.update("\0");
    },
  });

  return hash.digest("hex");
}

type TreeVisitor = {
  directory(rel: string, mode: number): Promise<void>;
  file(rel: string, content: Buffer, mode: number): Promise<void>;
};

type FileInfo = Awaited<ReturnType<typeof lstat>>;

function sameEntry(first: FileInfo, second: FileInfo): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.mode === second.mode &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs
  );
}

function raceError(context: string, path: string): Error {
  return new Error(`${context} changed while it was being read: ${path}`);
}

async function assertStableSymlink(
  path: string,
  context: string,
  expected: FileInfo,
  expectedText: string,
  expectedTarget: string,
): Promise<void> {
  let current: FileInfo;
  let currentText: string;
  let currentTarget: string;
  try {
    [current, currentText, currentTarget] = await Promise.all([
      lstat(path),
      readlink(path),
      realpath(path),
    ]);
  } catch {
    throw raceError(context, path);
  }
  if (
    !current.isSymbolicLink() ||
    !sameEntry(expected, current) ||
    currentText !== expectedText ||
    currentTarget !== expectedTarget
  ) {
    throw raceError(context, path);
  }
}

async function assertStableSourceRoot(
  requestedPath: string,
  canonicalPath: string,
  expected: FileInfo,
): Promise<void> {
  let current: FileInfo;
  let canonical: string;
  try {
    [current, canonical] = await Promise.all([
      lstat(requestedPath),
      realpath(requestedPath),
    ]);
  } catch {
    throw raceError("managed Codex repair source", requestedPath);
  }
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    canonical !== canonicalPath ||
    !sameEntry(expected, current)
  ) {
    throw raceError("managed Codex repair source", requestedPath);
  }
}

async function withStableSourceRoot<T>(
  requestedPath: string,
  canonicalPath: string,
  expected: FileInfo,
  operation: () => Promise<T>,
): Promise<T> {
  await assertStableSourceRoot(requestedPath, canonicalPath, expected);
  try {
    const result = await operation();
    await assertStableSourceRoot(requestedPath, canonicalPath, expected);
    return result;
  } catch (err) {
    // A source-root replacement must remain a hard security/read failure even
    // when the replacement happens to expose an outside-pointing symlink.
    await assertStableSourceRoot(requestedPath, canonicalPath, expected);
    throw err;
  }
}

async function readStableFile(
  path: string,
  root: string,
  context: string,
  expected: FileInfo,
): Promise<{ content: Buffer; mode: number }> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (err) {
    throw new Error(`cannot resolve ${context} file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isWithin(root, canonical)) throw new Error(`${context} file resolves outside source root: ${path}`);

  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedBefore = await handle.stat();
    const namedBefore = await lstat(canonical);
    if (!openedBefore.isFile() || !namedBefore.isFile() || !sameEntry(expected, namedBefore)) {
      throw raceError(context, path);
    }
    const content = await handle.readFile();
    const [openedAfter, namedAfter, canonicalAfter] = await Promise.all([
      handle.stat(),
      lstat(canonical),
      realpath(path),
    ]);
    if (
      !sameEntry(openedBefore, openedAfter) ||
      !sameEntry(namedBefore, namedAfter) ||
      canonicalAfter !== canonical
    ) {
      throw raceError(context, path);
    }
    return { content, mode: openedBefore.mode };
  } finally {
    await handle.close();
  }
}

async function walkTree(
  root: string,
  context: string,
  allowContainedSymlinks: boolean,
  ignoredPaths: ReadonlySet<string>,
  visitor: TreeVisitor,
): Promise<void> {
  const sourceRoot = await realpath(root);
  const activeDirectories = new Set<string>();

  async function walk(current: string, rel: string): Promise<void> {
    if (rel && ignoredPaths.has(rel)) return;

    let before: FileInfo;
    try {
      before = await lstat(current);
    } catch (err) {
      throw new Error(`cannot read ${context} entry ${current}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (before.isSymbolicLink()) {
      if (!rel) throw new Error(`${context} root is a symlink: ${current}`);
      if (!allowContainedSymlinks) throw new Error(`${context} contains a symlink: ${current}`);
      let targetText: string;
      try {
        targetText = await readlink(current);
      } catch (err) {
        throw new Error(`cannot read ${context} symlink ${current}: ${err instanceof Error ? err.message : String(err)}`);
      }
      let target: string;
      try {
        target = await realpath(current);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new Error(`${context} contains a dangling symlink: ${current}`);
        if (code === "ELOOP") throw new Error(`${context} contains a cyclic symlink: ${current}`);
        throw new Error(`cannot resolve ${context} symlink ${current}: ${err instanceof Error ? err.message : String(err)}`);
      }
      // The outside-target error is the one traversal outcome that authorizes
      // last-resort degradation. Prove the link was stable before assigning that
      // meaning; a changed link is a hard source-race failure.
      await assertStableSymlink(current, context, before, targetText, target);
      if (!isWithin(sourceRoot, target)) {
        throw new ManagedMarketplaceUnsupportedFormatError(
          `${context} symlink resolves outside source root: ${current}`,
        );
      }

      await walk(target, rel);
      await assertStableSymlink(current, context, before, targetText, target);
      return;
    }

    if (before.isDirectory()) {
      const canonical = await realpath(current);
      if (!isWithin(sourceRoot, canonical)) {
        throw new Error(`${context} directory resolves outside source root: ${current}`);
      }
      if (activeDirectories.has(canonical)) {
        throw new Error(`${context} contains a cyclic directory reference: ${current}`);
      }
      activeDirectories.add(canonical);
      try {
        let entries: string[];
        try {
          entries = (await readdir(current)).sort((a, b) => a.localeCompare(b));
        } catch (err) {
          throw new Error(`cannot read ${context} directory ${current}: ${err instanceof Error ? err.message : String(err)}`);
        }
        await visitor.directory(rel, before.mode);
        for (const name of entries) {
          const childRel = rel ? `${rel}/${name}` : name;
          await walk(join(current, name), childRel);
        }
        const [after, afterEntries, canonicalAfter] = await Promise.all([
          lstat(current),
          readdir(current).then((items) => items.sort((a, b) => a.localeCompare(b))),
          realpath(current),
        ]);
        if (
          !after.isDirectory() ||
          !sameEntry(before, after) ||
          canonicalAfter !== canonical ||
          entries.length !== afterEntries.length ||
          entries.some((name, index) => name !== afterEntries[index])
        ) {
          throw raceError(context, current);
        }
      } finally {
        activeDirectories.delete(canonical);
      }
      return;
    }

    if (before.isFile()) {
      const stable = await readStableFile(current, sourceRoot, context, before);
      await visitor.file(rel, stable.content, stable.mode);
      return;
    }

    throw new Error(`${context} contains an unsupported filesystem entry: ${current}`);
  }

  await walk(sourceRoot, "");
}

async function copyTreeDereferenced(source: string, destination: string): Promise<void> {
  const directoryModes: Array<{ path: string; mode: number }> = [];
  await walkTree(source, "managed Codex repair source", true, new Set(), {
    async directory(rel, mode) {
      const path = rel ? join(destination, rel) : destination;
      await mkdir(path, { mode: 0o700 });
      directoryModes.push({ path, mode });
    },
    async file(rel, content, mode) {
      await writeFile(join(destination, rel), content, {
        flag: "wx",
        mode: mode & 0o777,
      });
    },
  });
  directoryModes.sort((a, b) => b.path.length - a.path.length);
  for (const entry of directoryModes) await chmod(entry.path, entry.mode & 0o777);
}

async function validateExisting(
  root: string,
  expected: ManagedMarkerIdentity,
  marketplaceName: string,
  codexHome: string,
  parent: string,
): Promise<void> {
  await assertManagedConfinement(codexHome, parent, root);

  let marker: ManagedMarker;
  const markerPath = join(root, ".syncthis-managed.json");
  try {
    const markerInfo = await lstat(markerPath);
    if (markerInfo.isSymbolicLink() || !markerInfo.isFile()) throw new Error("marker is not a regular file");
    const rootReal = await realpath(root);
    const stableMarker = await readStableFile(markerPath, rootReal, "managed marketplace marker", markerInfo);
    marker = JSON.parse(stableMarker.content.toString("utf8")) as ManagedMarker;
  } catch {
    throw new Error(`refusing to reuse unmanaged or incomplete marketplace directory: ${root}`);
  }
  const managedFingerprint = await fingerprintTree(
    root,
    "managed marketplace",
    new Set([".syncthis-managed.json"]),
  );
  if (
    marker.managedBy !== expected.managedBy ||
    marker.version !== expected.version ||
    marker.canonicalName !== expected.canonicalName ||
    marker.safeName !== expected.safeName ||
    marker.sourceFingerprint !== expected.sourceFingerprint ||
    typeof marker.managedFingerprint !== "string" ||
    marker.managedFingerprint !== managedFingerprint
  ) {
    throw new Error(`refusing to overwrite unrelated managed marketplace data: ${root}`);
  }

  try {
    const marketplace = JSON.parse(
      await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"),
    ) as {
      name?: unknown;
      plugins?: Array<{
        name?: unknown;
        source?: { source?: unknown; path?: unknown };
      }>;
    };
    const plugin = JSON.parse(
      await readFile(join(root, "plugins", expected.safeName, ".codex-plugin", "plugin.json"), "utf8"),
    ) as { name?: unknown };
    const entry = marketplace.plugins?.find((candidate) => candidate.name === expected.safeName);
    const valid =
      marketplace.name === marketplaceName &&
      entry?.source?.source === "local" &&
      entry.source.path === `./plugins/${expected.safeName}` &&
      plugin.name === expected.safeName;
    if (!valid) {
      throw new Error(`refusing to reuse incomplete managed marketplace data: ${root}`);
    }
  } catch {
    throw new Error(`refusing to reuse incomplete managed marketplace data: ${root}`);
  }
  if (
    managedFingerprint !==
    (await fingerprintTree(
      root,
      "managed marketplace",
      new Set([".syncthis-managed.json"]),
    ))
  ) {
    throw new Error(`refusing to reuse managed marketplace data that changed during validation: ${root}`);
  }
}

type PublicationContext = {
  root: string;
  expected: ManagedMarkerIdentity;
  marketplaceName: string;
  codexHome: string;
  parent: string;
};

type PublicationLock = {
  path: string;
  info: FileInfo;
};

async function validateExistingIfPresent(context: PublicationContext): Promise<boolean> {
  let rootInfo: FileInfo;
  try {
    rootInfo = await lstat(context.root);
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
  if (rootInfo.isSymbolicLink()) {
    throw new Error(`managed marketplace root is a symlink: ${context.root}`);
  }
  if (!rootInfo.isDirectory()) {
    throw new Error(`managed marketplace target exists and is not a directory: ${context.root}`);
  }
  await validateExisting(
    context.root,
    context.expected,
    context.marketplaceName,
    context.codexHome,
    context.parent,
  );
  return true;
}

function publicationLockPath(parent: string, marketplaceName: string): string {
  const identity = createHash("sha256").update(marketplaceName).digest("hex").slice(0, 32);
  return join(parent, `.syncthis-publish-${identity}.lock`);
}

async function inspectPublicationLock(
  path: string,
  context: PublicationContext,
): Promise<FileInfo | undefined> {
  let before: FileInfo;
  try {
    before = await lstat(path);
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`managed marketplace publication lock is not a regular directory: ${path}`);
  }
  await assertManagedConfinement(context.codexHome, context.parent, path);
  let after: FileInfo;
  try {
    after = await lstat(path);
  } catch {
    throw raceError("managed marketplace publication lock", path);
  }
  if (!after.isDirectory() || after.isSymbolicLink() || !sameEntry(before, after)) {
    throw raceError("managed marketplace publication lock", path);
  }
  return after;
}

async function acquirePublicationLock(
  context: PublicationContext,
): Promise<PublicationLock | undefined> {
  const path = publicationLockPath(context.parent, context.marketplaceName);
  const deadline = Date.now() + PUBLICATION_LOCK_WAIT_MS;

  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      const info = await inspectPublicationLock(path, context);
      if (!info) {
        throw raceError("managed marketplace publication lock", path);
      }
      return { path, info };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    if (await validateExistingIfPresent(context)) return undefined;
    if (!(await inspectPublicationLock(path, context))) continue;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`timed out waiting for managed marketplace publication lock: ${path}`);
    }
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, Math.min(PUBLICATION_LOCK_POLL_MS, remaining));
    });
  }
}

async function releasePublicationLock(lock: PublicationLock): Promise<void> {
  let current: FileInfo;
  try {
    current = await lstat(lock.path);
  } catch {
    throw raceError("managed marketplace publication lock", lock.path);
  }
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameEntry(lock.info, current)
  ) {
    throw raceError("managed marketplace publication lock", lock.path);
  }
  await rmdir(lock.path);
}

export async function prepareManagedCodexMarketplace(options: {
  originalName: string;
  sourcePluginPath: string;
  dryRun: boolean;
}): Promise<ManagedCodexMarketplace> {
  if (!safePluginName(options.originalName)) {
    throw new Error(`plugin name cannot be represented safely in Codex: ${JSON.stringify(options.originalName)}`);
  }
  if (!isAbsolute(options.sourcePluginPath)) {
    throw new Error(`managed Codex repair requires an absolute source plugin path: ${options.sourcePluginPath}`);
  }
  let sourceInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    sourceInfo = await lstat(options.sourcePluginPath);
  } catch {
    throw new Error(`managed Codex repair source does not exist: ${options.sourcePluginPath}`);
  }
  if (sourceInfo.isSymbolicLink()) {
    throw new Error(`managed Codex repair source is a symlink: ${options.sourcePluginPath}`);
  }
  if (!sourceInfo.isDirectory()) {
    throw new Error(`managed Codex repair source is not a directory: ${options.sourcePluginPath}`);
  }

  const sourceRoot = await realpath(options.sourcePluginPath);
  const sourceFingerprint = await withStableSourceRoot(
    options.sourcePluginPath,
    sourceRoot,
    sourceInfo,
    () =>
      fingerprintTree(
        sourceRoot,
        "managed Codex repair source",
        new Set(),
        true,
      ),
  );
  const inspected = await withStableSourceRoot(
    options.sourcePluginPath,
    sourceRoot,
    sourceInfo,
    () => inspectPluginSource(sourceRoot),
  );
  const confirmedSourceFingerprint = await withStableSourceRoot(
    options.sourcePluginPath,
    sourceRoot,
    sourceInfo,
    () =>
      fingerprintTree(
        sourceRoot,
        "managed Codex repair source",
        new Set(),
        true,
      ),
  );
  if (confirmedSourceFingerprint !== sourceFingerprint) {
    throw new Error("managed Codex repair source changed while it was being inspected");
  }
  if (!inspected.canonicalName || inspected.manifests.length === 0) {
    throw new Error(`managed Codex repair source has no readable native plugin manifest: ${options.sourcePluginPath}`);
  }
  const pluginName = safePluginName(inspected.canonicalName);
  if (!pluginName) {
    throw new Error(
      `native plugin manifest name cannot be represented safely in Codex: ${JSON.stringify(inspected.canonicalName)}`,
    );
  }

  const suffix = createHash("sha256")
    .update(pluginName)
    .update("\0")
    .update(sourceFingerprint)
    .digest("hex")
    .slice(0, 12);
  const marketplaceName = `syncthis-${pluginName}-${suffix}`;
  const codexHome = resolveCodexHome();
  const parent = join(codexHome, "syncthis", "managed-marketplaces");
  const root = join(parent, marketplaceName);
  await assertManagedConfinement(codexHome, parent, root);
  const pluginPath = join(root, "plugins", pluginName);
  const markerIdentity: ManagedMarkerIdentity = {
    managedBy: "syncthis",
    version: MANAGED_VERSION,
    canonicalName: inspected.canonicalName,
    safeName: pluginName,
    sourceFingerprint,
  };
  const publicationContext: PublicationContext = {
    root,
    expected: markerIdentity,
    marketplaceName,
    codexHome,
    parent,
  };

  if (await validateExistingIfPresent(publicationContext)) {
    return { marketplaceName, pluginName, root, pluginPath, status: "present" };
  }

  if (options.dryRun) {
    return { marketplaceName, pluginName, root, pluginPath, status: "would-create" };
  }

  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertManagedConfinement(codexHome, parent);
  const publicationLock = await acquirePublicationLock(publicationContext);
  if (!publicationLock) {
    return { marketplaceName, pluginName, root, pluginPath, status: "present" };
  }
  try {
    if (await validateExistingIfPresent(publicationContext)) {
      return { marketplaceName, pluginName, root, pluginPath, status: "present" };
    }

    const temp = await mkdtemp(join(parent, ".syncthis-tmp-"));
    try {
      await assertManagedConfinement(codexHome, parent, temp);
      const tempPlugin = join(temp, "plugins", pluginName);
      await mkdir(join(temp, "plugins"), { recursive: true });
      await withStableSourceRoot(
        options.sourcePluginPath,
        sourceRoot,
        sourceInfo,
        () => copyTreeDereferenced(sourceRoot, tempPlugin),
      );
      const copiedFingerprint = await fingerprintTree(tempPlugin, "staged managed plugin");
      if (copiedFingerprint !== sourceFingerprint) {
        throw new Error("managed Codex repair source changed while it was being staged");
      }

      const stagedInspection = await inspectPluginSource(tempPlugin);
      if (
        stagedInspection.canonicalName !== inspected.canonicalName ||
        stagedInspection.manifests.length === 0
      ) {
        throw new Error("managed Codex repair source changed while its native manifest was being staged");
      }
      const stagedManifestPath = join(tempPlugin, stagedInspection.manifests[0]!);
      let sourceManifest: Record<string, unknown>;
      try {
        const parsed = JSON.parse(await readFile(stagedManifestPath, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("manifest is not an object");
        }
        sourceManifest = parsed as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `cannot read staged native plugin manifest ${stagedManifestPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const codexManifestDir = join(tempPlugin, ".codex-plugin");
      const codexManifestPath = join(codexManifestDir, "plugin.json");
      await mkdir(codexManifestDir, { recursive: true });
      await chmod(codexManifestDir, 0o700);
      await chmod(codexManifestPath, 0o600).catch((err) => {
        if (!isNotFound(err)) throw err;
      });
      await writeFile(
        codexManifestPath,
        json({ ...sourceManifest, name: pluginName }),
        { mode: 0o600 },
      );
      await mkdir(join(temp, ".agents", "plugins"), { recursive: true });
      await writeFile(
        join(temp, ".agents", "plugins", "marketplace.json"),
        json({
          name: marketplaceName,
          plugins: [
            {
              name: pluginName,
              source: { source: "local", path: `./plugins/${pluginName}` },
              policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
              category: "Coding",
            },
          ],
        }),
        { mode: 0o600 },
      );
      const marker: ManagedMarker = {
        ...markerIdentity,
        managedFingerprint: await fingerprintTree(temp, "staged managed marketplace"),
      };
      await writeFile(join(temp, ".syncthis-managed.json"), json(marker), { mode: 0o600 });

      // Node does not expose a portable no-replace directory rename. Every
      // Syncthis publisher for this deterministic root therefore holds the
      // sibling ownership lock and rechecks the destination immediately before
      // this single-step publication. A preexisting root must validate; a
      // non-cooperating writer racing after this check is outside that portable
      // cooperative invariant.
      if (await validateExistingIfPresent(publicationContext)) {
        return { marketplaceName, pluginName, root, pluginPath, status: "present" };
      }
      await assertManagedConfinement(codexHome, parent, root);
      try {
        await rename(temp, root);
      } catch (err) {
        if (!isPublishConflict(err)) throw err;
        await validateExisting(root, markerIdentity, marketplaceName, codexHome, parent);
        return { marketplaceName, pluginName, root, pluginPath, status: "present" };
      }

      await validateExisting(root, markerIdentity, marketplaceName, codexHome, parent);
      return { marketplaceName, pluginName, root, pluginPath, status: "created" };
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await releasePublicationLock(publicationLock);
  }
}
