import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { inspectPluginSource } from "./source.ts";

declare const validatedPluginRootBrand: unique symbol;

/**
 * A canonical, symlink-resolved local plugin directory that is safe to pass as
 * one argv value to a native plugin installer.
 */
export type ValidatedPluginRoot = string & {
  readonly [validatedPluginRootBrand]: true;
};

export type ValidateLocalPluginSourceOptions = {
  requireNativeManifest?: boolean;
};

export async function validateLocalPluginSource(
  path: string,
  options: ValidateLocalPluginSourceOptions = {},
): Promise<ValidatedPluginRoot> {
  if (path.startsWith("-")) {
    throw new Error(`local plugin source must not be option-like: ${path}`);
  }
  if (!isAbsolute(path)) {
    throw new Error(`local plugin source must be an absolute path: ${path}`);
  }
  if (path.includes("\0")) {
    throw new Error("local plugin source must not contain NUL");
  }
  if (path.split(/[\\/]/).includes("..")) {
    throw new Error(`local plugin source must not contain '..': ${path}`);
  }

  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    throw new Error(`local plugin source does not exist: ${path}`);
  }
  if (info.isSymbolicLink()) {
    throw new Error(`local plugin source must not be a symlink: ${path}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`local plugin source is not a directory: ${path}`);
  }

  const source = (await realpath(path)) as ValidatedPluginRoot;
  if (options.requireNativeManifest) {
    const inspected = await inspectPluginSource(source);
    if (!inspected.canonicalName || !inspected.payload.nativeManifest) {
      throw new Error(
        `local plugin source has no readable native plugin manifest: ${path}`,
      );
    }
  }
  return source;
}
