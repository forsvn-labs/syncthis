import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export type SecureTreeFileInfo = Awaited<ReturnType<typeof lstat>>;

export type SecureTreeVisitor = {
  directory(rel: string, mode: number): Promise<void>;
  file(rel: string, content: Buffer, mode: number): Promise<void>;
};

export type SecureTreeOptions = {
  /** Follow symlinks only when their resolved target remains inside the root. */
  allowContainedSymlinks?: boolean;
  /** Relative paths that are intentionally ignored after their name is observed. */
  ignoredPaths?: ReadonlySet<string>;
  /** Directory names whose contents are intentionally excluded from the snapshot. */
  skipDirectoryNames?: ReadonlySet<string>;
  /** Customize the error used for an in-root check failure. */
  onOutsideSymlink?: (path: string, context: string) => Error;
};

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function sameSecureEntry(
  first: SecureTreeFileInfo,
  second: SecureTreeFileInfo,
): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.mode === second.mode &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs
  );
}

export function secureRaceError(context: string, path: string): Error {
  return new Error(`${context} changed while it was being read: ${path}`);
}

async function assertStableSymlink(
  path: string,
  context: string,
  expected: SecureTreeFileInfo,
  expectedText: string,
  expectedTarget: string,
): Promise<void> {
  let current: SecureTreeFileInfo;
  let currentText: string;
  let currentTarget: string;
  try {
    [current, currentText, currentTarget] = await Promise.all([
      lstat(path),
      readlink(path),
      realpath(path),
    ]);
  } catch {
    throw secureRaceError(context, path);
  }
  if (
    !current.isSymbolicLink() ||
    !sameSecureEntry(expected, current) ||
    currentText !== expectedText ||
    currentTarget !== expectedTarget
  ) {
    throw secureRaceError(context, path);
  }
}

async function assertStableRoot(
  requestedPath: string,
  canonicalPath: string,
  expected: SecureTreeFileInfo,
  context: string,
): Promise<void> {
  let current: SecureTreeFileInfo;
  let canonical: string;
  try {
    [current, canonical] = await Promise.all([
      lstat(requestedPath),
      realpath(requestedPath),
    ]);
  } catch {
    throw secureRaceError(context, requestedPath);
  }
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    canonical !== canonicalPath ||
    !sameSecureEntry(expected, current)
  ) {
    throw secureRaceError(context, requestedPath);
  }
}

/**
 * Read one regular file through a stable descriptor. The path is resolved and
 * confined before opening, and both the descriptor and named entry are checked
 * before and after the read so a replacement cannot turn a package snapshot
 * into an outside or special-file read.
 */
export async function readSecureFile(
  path: string,
  root: string,
  context: string,
  expected: SecureTreeFileInfo,
): Promise<{ content: Buffer; mode: number }> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (err) {
    throw new Error(
      `cannot resolve ${context} file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!within(root, canonical)) {
    throw new Error(`${context} file resolves outside source root: ${path}`);
  }

  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedBefore = await handle.stat();
    const namedBefore = await lstat(canonical);
    if (
      !openedBefore.isFile() ||
      !namedBefore.isFile() ||
      !sameSecureEntry(expected, namedBefore)
    ) {
      throw secureRaceError(context, path);
    }
    const content = await handle.readFile();
    const [openedAfter, namedAfter, canonicalAfter] = await Promise.all([
      handle.stat(),
      lstat(canonical),
      realpath(path),
    ]);
    if (
      !sameSecureEntry(openedBefore, openedAfter) ||
      !sameSecureEntry(namedBefore, namedAfter) ||
      canonicalAfter !== canonical
    ) {
      throw secureRaceError(context, path);
    }
    return { content, mode: openedBefore.mode };
  } finally {
    await handle.close();
  }
}

/**
 * Walk a package tree as a stable snapshot. Every traversed directory is
 * checked for entry-set and metadata changes, regular files are read through a
 * no-follow descriptor, and contained symlinks are only followed when their
 * target and link text remain stable and inside the canonical root.
 */
export async function walkSecureTree(
  root: string,
  context: string,
  options: SecureTreeOptions,
  visitor: SecureTreeVisitor,
): Promise<void> {
  let rootInfo: SecureTreeFileInfo;
  try {
    rootInfo = await lstat(root);
  } catch (err) {
    throw new Error(
      `cannot read ${context} root ${root}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`${context} root is not a regular directory: ${root}`);
  }

  const sourceRoot = await realpath(root);
  await assertStableRoot(root, sourceRoot, rootInfo, context);
  const activeDirectories = new Set<string>();
  const ignoredPaths = options.ignoredPaths ?? new Set<string>();
  const skippedDirectories = options.skipDirectoryNames ?? new Set<string>();
  const allowContainedSymlinks = options.allowContainedSymlinks ?? false;
  const outsideSymlink = options.onOutsideSymlink ?? ((path: string, name: string) =>
    new Error(`${name} symlink resolves outside source root: ${path}`));

  async function walk(current: string, rel: string): Promise<void> {
    if (rel && ignoredPaths.has(rel)) return;

    let before: SecureTreeFileInfo;
    try {
      before = await lstat(current);
    } catch (err) {
      throw new Error(
        `cannot read ${context} entry ${current}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (before.isSymbolicLink()) {
      if (!rel) throw new Error(`${context} root is a symlink: ${current}`);
      if (!allowContainedSymlinks) throw new Error(`${context} contains a symlink: ${current}`);

      let targetText: string;
      try {
        targetText = await readlink(current);
      } catch (err) {
        throw new Error(
          `cannot read ${context} symlink ${current}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      let target: string;
      try {
        target = await realpath(current);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw new Error(`${context} contains a dangling symlink: ${current}`);
        if (code === "ELOOP") throw new Error(`${context} contains a cyclic symlink: ${current}`);
        throw new Error(
          `cannot resolve ${context} symlink ${current}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await assertStableSymlink(current, context, before, targetText, target);
      if (!within(sourceRoot, target)) throw outsideSymlink(current, context);

      await walk(target, rel);
      await assertStableSymlink(current, context, before, targetText, target);
      return;
    }

    if (before.isDirectory()) {
      const canonical = await realpath(current);
      if (!within(sourceRoot, canonical)) {
        throw new Error(`${context} directory resolves outside source root: ${current}`);
      }
      if (activeDirectories.has(canonical)) {
        throw new Error(`${context} contains a cyclic directory reference: ${current}`);
      }
      activeDirectories.add(canonical);
      try {
        let entries: string[];
        try {
          entries = (await readdir(current)).sort((left, right) => left.localeCompare(right));
        } catch (err) {
          throw new Error(
            `cannot read ${context} directory ${current}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await visitor.directory(rel, before.mode);
        for (const name of entries) {
          const child = join(current, name);
          const childRel = rel ? `${rel}/${name}` : name;
          if (skippedDirectories.has(name)) {
            // Ignored dependency/VCS trees are not part of the package, but the
            // entry itself must still be a normal in-root directory. Never let a
            // symlink with an ignored name become an escape hatch.
            let skippedInfo: SecureTreeFileInfo;
            try {
              skippedInfo = await lstat(child);
            } catch (err) {
              throw new Error(
                `cannot read ${context} entry ${child}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            if (skippedInfo.isSymbolicLink() || !skippedInfo.isDirectory()) {
              throw new Error(`${context} contains an unsupported ignored entry: ${child}`);
            }
            continue;
          }
          await walk(child, childRel);
        }
        const [after, afterEntries, canonicalAfter] = await Promise.all([
          lstat(current),
          readdir(current).then((items) => items.sort((left, right) => left.localeCompare(right))),
          realpath(current),
        ]);
        if (
          !after.isDirectory() ||
          !sameSecureEntry(before, after) ||
          canonicalAfter !== canonical ||
          entries.length !== afterEntries.length ||
          entries.some((name, index) => name !== afterEntries[index])
        ) {
          throw secureRaceError(context, current);
        }
      } finally {
        activeDirectories.delete(canonical);
      }
      return;
    }

    if (before.isFile()) {
      const stable = await readSecureFile(current, sourceRoot, context, before);
      await visitor.file(rel, stable.content, stable.mode);
      return;
    }

    throw new Error(`${context} contains an unsupported filesystem entry: ${current}`);
  }

  await walk(sourceRoot, "");
  await assertStableRoot(root, sourceRoot, rootInfo, context);
}
