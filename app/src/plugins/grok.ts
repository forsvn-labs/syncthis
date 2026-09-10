import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as TOML from "smol-toml";
import { validateLocalPluginSource } from "./local-source.ts";
import { fingerprintPluginPackage } from "./source.ts";
import {
  assertSafeIdentifier,
  isSafeRepoSlug,
  pluginNamesOverlap,
  run,
  type ShellResult,
} from "./shell.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginActivationOpts,
  PluginActivationResult,
  PluginInstallOpts,
  PluginInstallResult,
  PluginRecord,
  PluginUninstallOpts,
  PluginUninstallResult,
} from "./types.ts";

const READ_TIMEOUT_MS = 60_000;
const MUTATION_TIMEOUT_MS = 180_000;

type GrokInstalledEntry = {
  status?: unknown;
  name?: unknown;
  repo_key?: unknown;
  version?: unknown;
  path?: unknown;
  source?: unknown;
  marketplace?: unknown;
};

type ParsedGrokPlugin = {
  record: PluginRecord;
  repoKey: string;
};

type ResolvedGrokPlugin = ParsedGrokPlugin & {
  repositoryPluginNames: string[];
};

function grokHome(): string {
  const configured = process.env.GROK_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".grok");
}

function configPath(): string {
  return join(grokHome(), "config.toml");
}

function githubRepoFromSource(value: string): string | undefined {
  const shorthand = value.replace(/\.git$/, "");
  if (isSafeRepoSlug(shorthand)) return shorthand;

  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(value);
  if (ssh) {
    const repo = `${ssh[1]}/${ssh[2]}`;
    return isSafeRepoSlug(repo) ? repo : undefined;
  }

  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    const [owner, rawRepo, ...rest] = url.pathname.split("/").filter(Boolean);
    if (!owner || !rawRepo || rest.length > 0) return undefined;
    const repo = `${owner}/${rawRepo.replace(/\.git$/, "")}`;
    return isSafeRepoSlug(repo) ? repo : undefined;
  } catch {
    return undefined;
  }
}

function parseGrokInstalledEntries(text: string): ParsedGrokPlugin[] {
  let value: unknown;
  try {
    value = JSON.parse(text || "[]");
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(value)) throw new Error("grok plugin list --json must return a JSON array");

  const records: ParsedGrokPlugin[] = [];
  for (const raw of value as GrokInstalledEntry[]) {
    if (!raw || typeof raw !== "object" || raw.status !== "installed") continue;
    if (typeof raw.name !== "string" || !raw.name.trim()) {
      throw new Error("installed Grok plugin record must have a non-empty name");
    }
    if (typeof raw.path !== "string" || !raw.path.trim()) {
      throw new Error(`installed Grok plugin ${raw.name} must have a non-empty path`);
    }
    if (typeof raw.source !== "string" || !raw.source.trim()) {
      throw new Error(`installed Grok plugin ${raw.name} must have a non-empty source`);
    }
    if (typeof raw.repo_key !== "string" || !raw.repo_key.trim()) {
      throw new Error(`installed Grok plugin ${raw.name} must have a non-empty repo_key`);
    }
    if (raw.version !== null && raw.version !== undefined && typeof raw.version !== "string") {
      throw new Error(`installed Grok plugin ${raw.name} has an invalid version`);
    }
    if (raw.marketplace !== null && raw.marketplace !== undefined && typeof raw.marketplace !== "string") {
      throw new Error(`installed Grok plugin ${raw.name} has an invalid marketplace`);
    }
    const sourceRepo = githubRepoFromSource(raw.source);
    records.push({
      repoKey: raw.repo_key,
      record: {
        name: raw.name,
        ...(typeof raw.marketplace === "string" && raw.marketplace
          ? { marketplace: raw.marketplace }
          : {}),
        ...(typeof raw.version === "string" && raw.version
          ? { version: raw.version }
          : {}),
        path: raw.path,
        ...(sourceRepo ? { sourceRepo } : {}),
      },
    });
  }
  return records;
}

/** Parse the stable array emitted by `grok plugin list --json`. */
export function parseGrokPluginList(text: string): PluginRecord[] {
  return parseGrokInstalledEntries(text).map(({ record }) => record);
}

type GrokRegistry = {
  repos?: Record<string, { plugins?: Record<string, { subdir?: unknown }> }>;
};

async function resolveInstalledPlugins(entries: ParsedGrokPlugin[]): Promise<ResolvedGrokPlugin[]> {
  const registryReads = new Map<string, Promise<GrokRegistry | undefined>>();
  const repoRootReads = new Map<string, ReturnType<typeof validateLocalPluginSource>>();
  const nativeNamesByRepo = new Map<string, Set<string>>();
  for (const { record, repoKey } of entries) {
    const names = nativeNamesByRepo.get(repoKey) ?? new Set<string>();
    names.add(record.name);
    nativeNamesByRepo.set(repoKey, names);
  }
  const registryFor = (repoRoot: string): Promise<GrokRegistry | undefined> => {
    const path = join(dirname(repoRoot), "registry.json");
    let pending = registryReads.get(path);
    if (!pending) {
      pending = readFile(path, "utf8")
        .then((text) => JSON.parse(text) as GrokRegistry)
        .catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return undefined;
          throw err;
        });
      registryReads.set(path, pending);
    }
    return pending;
  };
  const canonicalRepoRootFor = (repoRoot: string) => {
    let pending = repoRootReads.get(repoRoot);
    if (!pending) {
      pending = validateLocalPluginSource(repoRoot);
      repoRootReads.set(repoRoot, pending);
    }
    return pending;
  };

  return Promise.all(entries.map(async ({ record, repoKey }) => {
    const repoRoot = record.path!;
    const registry = await registryFor(repoRoot);
    const registryPlugins = registry?.repos?.[repoKey]?.plugins;
    const repositoryPluginNames = [...new Set([
      ...(nativeNamesByRepo.get(repoKey) ?? []),
      ...Object.keys(registryPlugins ?? {}),
    ])].sort();
    const subdir = registryPlugins?.[record.name]?.subdir;
    if (subdir === undefined || subdir === null) {
      return { record, repoKey, repositoryPluginNames };
    }
    if (typeof subdir !== "string" || !subdir.trim()) {
      throw new Error(`Grok registry has an invalid subdir for ${record.name}`);
    }
    if (isAbsolute(subdir) || subdir.split(/[\\/]/).includes("..")) {
      throw new Error(`Grok registry subdir escapes its installed repository for ${record.name}`);
    }
    const canonicalRepoRoot = await canonicalRepoRootFor(repoRoot);
    const pluginRoot = await validateLocalPluginSource(join(canonicalRepoRoot, subdir));
    const relativePluginRoot = relative(canonicalRepoRoot, pluginRoot);
    if (
      relativePluginRoot === ".."
      || relativePluginRoot.startsWith(`..${sep}`)
      || isAbsolute(relativePluginRoot)
    ) {
      throw new Error(`Grok registry subdir escapes its installed repository for ${record.name}`);
    }
    return {
      record: { ...record, path: pluginRoot },
      repoKey,
      repositoryPluginNames,
    };
  }));
}

function pluginConfigEntries(value: unknown, key: "enabled" | "disabled"): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const plugins = (value as Record<string, unknown>).plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return [];
  const entries = (plugins as Record<string, unknown>)[key];
  if (entries === undefined) return [];
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
    throw new Error(`[plugins].${key} must be an array of strings`);
  }
  return entries as string[];
}

function configEntryMatches(entry: string, name: string): boolean {
  return entry === name || entry.endsWith(`/${name}`);
}

async function applyExplicitEnablement(records: PluginRecord[]): Promise<PluginRecord[]> {
  let text: string;
  try {
    text = await readFile(configPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return records;
    throw err;
  }
  const config = TOML.parse(text);
  const enabled = pluginConfigEntries(config, "enabled");
  const disabled = pluginConfigEntries(config, "disabled");
  return records.map((record) => {
    if (disabled.some((entry) => configEntryMatches(entry, record.name))) {
      return { ...record, enabled: false };
    }
    if (enabled.some((entry) => configEntryMatches(entry, record.name))) {
      return { ...record, enabled: true };
    }
    return record;
  });
}

async function readNative(): Promise<PluginRecord[]> {
  return (await readNativeState()).map(({ record }) => record);
}

async function readNativeState(): Promise<ResolvedGrokPlugin[]> {
  const listed = await run("grok", ["plugin", "list", "--json"], {
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (listed.notFound) throw new Error("grok CLI not found on PATH");
  if (listed.timedOut) throw new Error(`grok plugin list timed out after ${READ_TIMEOUT_MS / 1000}s`);
  if (!listed.ok) {
    throw new Error(listed.stderr.trim() || `grok plugin list exit ${listed.exitCode}`);
  }
  const plugins = await resolveInstalledPlugins(parseGrokInstalledEntries(listed.stdout));
  const records = await applyExplicitEnablement(plugins.map(({ record }) => record));
  return plugins.map((plugin, index) => ({ ...plugin, record: records[index]! }));
}

function commandFailure(
  command: string,
  result: ShellResult,
  timeoutMs: number,
): string {
  if (result.notFound) return "grok CLI not found on PATH";
  if (result.timedOut) return `${command} timed out after ${timeoutMs / 1000}s`;
  return result.stderr.trim() || `${command} exit ${result.exitCode}`;
}

function result(
  target: string,
  status: PluginInstallResult["status"],
  extra: Omit<PluginInstallResult, "agent" | "target" | "status"> = {},
): PluginInstallResult {
  return { agent: "grok-build", target, status, ...extra };
}

async function installSource(opts: PluginInstallOpts): Promise<string | PluginInstallResult> {
  if (opts.sourcePluginPath) {
    try {
      return await validateLocalPluginSource(opts.sourcePluginPath, {
        requireNativeManifest: true,
      });
    } catch (err) {
      return result(opts.sourcePluginPath, "failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (opts.sourceRepo && isSafeRepoSlug(opts.sourceRepo)) return opts.sourceRepo;
  return result(opts.sourceRepo ?? "unknown", "skipped", {
    message: "no exact local Agent Plugin artifact or safe github owner/repo is available for Grok",
  });
}

async function existingSourceConflict(
  record: PluginRecord,
  opts: PluginInstallOpts,
  source: string,
): Promise<string | undefined> {
  if (opts.sourcePluginPath) {
    if (!record.path) {
      return `conflict: cannot verify that installed Grok plugin ${record.name} represents the requested exact local source`;
    }
    try {
      const installedPath = await validateLocalPluginSource(record.path, {
        requireNativeManifest: true,
      });
      const [requestedFingerprint, installedFingerprint] = await Promise.all([
        fingerprintPluginPackage(source),
        fingerprintPluginPackage(installedPath),
      ]);
      if (requestedFingerprint === installedFingerprint) return undefined;
      return `conflict: installed Grok plugin ${record.name} has the same name but different content from the requested exact local source`;
    } catch (err) {
      return `conflict: cannot verify that installed Grok plugin ${record.name} represents the requested exact local source: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const requestedRepo = githubRepoFromSource(opts.sourceRepo ?? "")?.toLowerCase();
  const installedRepo = githubRepoFromSource(record.sourceRepo ?? "")?.toLowerCase();
  if (requestedRepo && installedRepo && requestedRepo === installedRepo) return undefined;
  if (requestedRepo && installedRepo) {
    return `conflict: installed Grok plugin ${record.name} is from ${record.sourceRepo}, not requested source ${opts.sourceRepo}`;
  }
  return `conflict: cannot verify that installed Grok plugin ${record.name} represents the requested repository source`;
}

async function enablePlugins(names: string[]): Promise<string | undefined> {
  for (const name of names) {
    try {
      assertSafeIdentifier(name, "Grok plugin name");
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const enabled = await run("grok", ["plugin", "enable", name], {
      timeoutMs: MUTATION_TIMEOUT_MS,
    });
    if (!enabled.ok) {
      return commandFailure("grok plugin enable", enabled, MUTATION_TIMEOUT_MS);
    }
  }
  return undefined;
}

export const grokPluginAdapter: PluginAdapter = {
  id: "grok-build",
  sourceRequired: true,
  configPath,

  async read(): Promise<PluginAdapterRead> {
    const base: PluginAdapterRead = {
      agent: "grok-build",
      configPath: configPath(),
      exists: false,
      plugins: [],
    };
    try {
      const plugins = await readNative();
      return { ...base, exists: plugins.length > 0, plugins };
    } catch (err) {
      return {
        ...base,
        error: `cannot read Grok native plugin state: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },

  async previewInstallPlugin(name: string, opts: PluginInstallOpts): Promise<PluginInstallResult> {
    const source = await installSource(opts);
    if (typeof source !== "string") return { ...source, target: name };
    return result(name, "installed", { message: `dry-run; would install ${source} with explicit trust and enable ${name}` });
  },

  async installPlugin(name: string, opts: PluginInstallOpts): Promise<PluginInstallResult> {
    let before: PluginRecord[];
    try {
      before = await readNative();
    } catch (err) {
      return result(name, "failed", { message: err instanceof Error ? err.message : String(err) });
    }

    const present = before.find((record) => pluginNamesOverlap(record.name, name));
    const source = await installSource(opts);
    if (typeof source !== "string") {
      return present
        ? result(present.name, "skipped", {
          message: `conflict: cannot verify that installed Grok plugin ${present.name} represents the requested source${source.message ? `: ${source.message}` : ""}`,
        })
        : { ...source, target: name };
    }
    if (present) {
      const conflict = await existingSourceConflict(present, opts, source);
      if (conflict) return result(present.name, "skipped", { message: conflict });
    }
    if (present && present.enabled !== false) return result(present.name, "present");
    if (present?.enabled === false) {
      if (opts.dryRun) return result(present.name, "installed", { message: "dry-run; would enable installed plugin" });
      const enableError = await enablePlugins([present.name]);
      if (enableError) return result(present.name, "failed", { message: enableError });
      let after: PluginRecord[];
      try {
        after = await readNative();
      } catch (err) {
        return result(present.name, "failed", {
          message: `enable succeeded, but verification failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      const active = after.find((record) => pluginNamesOverlap(record.name, present.name) && record.enabled === true);
      return active
        ? result(active.name, "installed", { message: "enabled existing Grok plugin" })
        : result(present.name, "failed", { message: "Grok reported success, but a fresh native read did not show the plugin enabled" });
    }

    if (opts.dryRun) {
      return result(name, "installed", {
        message: `dry-run; would install ${source} with explicit trust and enable ${name}`,
      });
    }

    const installed = await run("grok", ["plugin", "install", source, "--trust"], {
      timeoutMs: MUTATION_TIMEOUT_MS,
    });
    if (!installed.ok) {
      return result(name, "failed", {
        message: commandFailure("grok plugin install", installed, MUTATION_TIMEOUT_MS),
      });
    }

    let afterInstall: PluginRecord[];
    try {
      afterInstall = await readNative();
    } catch (err) {
      return result(name, "failed", {
        message: `install succeeded, but verification failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const beforeKeys = new Set(before.map((record) => `${record.name}@${record.marketplace ?? ""}`));
    const added = afterInstall.filter((record) => !beforeKeys.has(`${record.name}@${record.marketplace ?? ""}`));
    const matching = afterInstall.filter((record) => pluginNamesOverlap(record.name, name));
    const activated = matching.length > 0 ? matching : added;
    if (activated.length === 0) {
      return result(name, "failed", {
        message: "Grok reported success, but a fresh `grok plugin list --json` did not show the plugin",
      });
    }

    const enableError = await enablePlugins(activated.map((record) => record.name));
    if (enableError) return result(name, "failed", { message: enableError });

    let afterEnable: PluginRecord[];
    try {
      afterEnable = await readNative();
    } catch (err) {
      return result(name, "failed", {
        message: `enable succeeded, but verification failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const activeNames = new Set(activated.map((record) => record.name));
    const active = afterEnable.filter((record) => activeNames.has(record.name) && record.enabled === true);
    if (active.length === 0) {
      return result(name, "failed", {
        message: "Grok reported success, but a fresh native read did not show an enabled plugin",
      });
    }
    const coveredBy = active.some((record) => pluginNamesOverlap(record.name, name))
      ? undefined
      : active.map((record) => record.name).join(", ");
    return result(active[0]!.name, "installed", {
      ...(coveredBy ? { coveredBy } : {}),
    });
  },

  async uninstallPlugin(name: string, opts: PluginUninstallOpts): Promise<PluginUninstallResult> {
    let plugins: ResolvedGrokPlugin[];
    try {
      plugins = await readNativeState();
    } catch (err) {
      return { agent: "grok-build", target: name, status: "failed", message: err instanceof Error ? err.message : String(err) };
    }
    const overlapping = plugins.filter(({ record }) => pluginNamesOverlap(record.name, name));
    const matches = opts.marketplace
      ? overlapping.filter(({ record }) => record.marketplace === opts.marketplace)
      : overlapping;
    const target = opts.marketplace ? `${name}@${opts.marketplace}` : name;
    if (matches.length === 0) return { agent: "grok-build", target, status: "absent" };
    if (new Set(overlapping.map(({ repoKey }) => repoKey)).size > 1) {
      return {
        agent: "grok-build",
        target,
        status: "skipped",
        message: "multiple installed Grok records overlap this name, but Grok uninstall cannot select a repository or marketplace",
      };
    }
    const match = matches[0]!;
    const selectedNames = new Set(matches.map(({ record }) => record.name));
    const siblingNames = match.repositoryPluginNames.filter((pluginName) => !selectedNames.has(pluginName));
    if (siblingNames.length > 0) {
      return {
        agent: "grok-build",
        target,
        status: "skipped",
        message: `cannot confirm removal of only ${match.record.name}; the same Grok repository also contains: ${siblingNames.join(", ")}`,
      };
    }
    try {
      assertSafeIdentifier(match.record.name, "Grok plugin name");
    } catch (err) {
      return { agent: "grok-build", target, status: "failed", message: err instanceof Error ? err.message : String(err) };
    }
    if (opts.dryRun) return { agent: "grok-build", target: match.record.name, status: "uninstalled", message: "dry-run" };

    const args = ["plugin", "uninstall", match.record.name, "--confirm"];
    if (opts.keepData) args.push("--keep-data");
    const removed = await run("grok", args, { timeoutMs: MUTATION_TIMEOUT_MS });
    if (!removed.ok) {
      return {
        agent: "grok-build",
        target: match.record.name,
        status: "failed",
        message: commandFailure("grok plugin uninstall", removed, MUTATION_TIMEOUT_MS),
      };
    }
    try {
      const after = await readNativeState();
      if (after.some(({ repoKey }) => repoKey === match.repoKey)) {
        return {
          agent: "grok-build",
          target: match.record.name,
          status: "failed",
          message: "Grok reported success, but a fresh `grok plugin list --json` still shows the plugin",
        };
      }
    } catch (err) {
      return {
        agent: "grok-build",
        target: match.record.name,
        status: "failed",
        message: `uninstall succeeded, but verification failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { agent: "grok-build", target: match.record.name, status: "uninstalled" };
  },

  // Grok has no per-plugin flag by default: absent from `[plugins].disabled`
  // means enabled, so the only provable state is explicit-disabled.
  activationState(record: PluginRecord): boolean | undefined {
    return record.enabled === false ? false : true;
  },

  // Guarded activation — reached only by `syncthis plugins enable|disable`.
  // Runs the proven `grok plugin <enable|disable> <name>` command, then verifies
  // with a fresh native read; exit zero without an observed state change is a
  // failure. Grok's command has no scope option, so an explicit scope is
  // rejected rather than silently dropped. The bare command also cannot express
  // a marketplace or repository, so ANY overlap across several installed
  // records is refused — even a qualified request must not risk mutating the
  // wrong record.
  async setPluginActivation(name: string, opts: PluginActivationOpts): Promise<PluginActivationResult> {
    if (opts.scope) {
      return {
        agent: "grok-build",
        target: name,
        status: "failed",
        message: `Grok's plugin ${opts.op} command has no --scope option; pass --scope only for Claude Code`,
      };
    }
    try {
      assertSafeIdentifier(name, "Grok plugin name");
      if (opts.marketplace) assertSafeIdentifier(opts.marketplace, "marketplace name");
    } catch (err) {
      return { agent: "grok-build", target: name, status: "failed", message: err instanceof Error ? err.message : String(err) };
    }
    const target = opts.marketplace ? `${name}@${opts.marketplace}` : name;
    const desired = opts.op === "enable";
    let before: ResolvedGrokPlugin[];
    try {
      before = await readNativeState();
    } catch (err) {
      return { agent: "grok-build", target, status: "failed", message: err instanceof Error ? err.message : String(err) };
    }
    const overlapping = before.filter(({ record }) => pluginNamesOverlap(record.name, name));
    if (overlapping.length === 0) return { agent: "grok-build", target, status: "absent" };
    if (overlapping.length > 1 || new Set(overlapping.map(({ record }) => record.marketplace ?? "")).size > 1) {
      return {
        agent: "grok-build",
        target,
        status: "failed",
        message: `cannot select exactly one installed Grok record for ${target}: the name overlaps ${overlapping.length} records (${[...new Set(overlapping.map(({ record }) => record.marketplace ? `${record.name}@${record.marketplace}` : record.name))].join(", ")}), and Grok's CLI cannot express marketplace selection`,
      };
    }
    const match = overlapping[0]!;
    if (this.activationState!(match.record) === desired) {
      return {
        agent: "grok-build",
        target: match.record.name,
        status: desired ? "enabled" : "disabled",
        message: `already ${desired ? "enabled" : "disabled"}`,
      };
    }
    const args = ["plugin", opts.op, match.record.name];
    if (opts.dryRun) {
      return {
        agent: "grok-build",
        target: match.record.name,
        status: desired ? "enabled" : "disabled",
        planned: true,
        plannedCommand: ["grok", ...args],
        message: "dry-run; command was not run and nothing was verified",
      };
    }
    const activated = await run("grok", args, {
      timeoutMs: MUTATION_TIMEOUT_MS,
    });
    if (!activated.ok) {
      return {
        agent: "grok-build",
        target: match.record.name,
        status: "failed",
        message: commandFailure(`grok plugin ${opts.op}`, activated, MUTATION_TIMEOUT_MS),
      };
    }
    let after: ResolvedGrokPlugin[];
    try {
      after = await readNativeState();
    } catch (err) {
      return {
        agent: "grok-build",
        target: match.record.name,
        status: "failed",
        message: `${opts.op} succeeded, but verification failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    // The fresh read-back must still resolve to exactly one record: a command
    // that leaves (or creates) an ambiguous overlap cannot be claimed.
    const afterOverlapping = after.filter(({ record }) => pluginNamesOverlap(record.name, match.record.name));
    if (
      afterOverlapping.length !== 1 ||
      new Set(afterOverlapping.map(({ record }) => record.marketplace ?? "")).size > 1
    ) {
      return {
        agent: "grok-build",
        target: match.record.name,
        status: "failed",
        message: `Grok reported success, but a fresh native read does not resolve to exactly one installed record for ${match.record.name}`,
      };
    }
    const observed = afterOverlapping[0]!;
    if (this.activationState!(observed.record) !== desired) {
      return {
        agent: "grok-build",
        target: match.record.name,
        status: "failed",
        message: `Grok reported success, but a fresh native read did not show the plugin ${desired ? "enabled" : "disabled"}`,
      };
    }
    return { agent: "grok-build", target: match.record.name, status: desired ? "enabled" : "disabled" };
  },
};
