import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import {
  validateLocalPluginSource,
  type ValidatedPluginRoot,
} from "./local-source.ts";
import { readLocalMarketplace } from "./marketplace.ts";
import { isSafeRepoSlug, pluginNamesOverlap, run } from "./shell.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginInstallOpts,
  PluginInstallResult,
  PluginRecord,
  PluginUninstallOpts,
  PluginUninstallResult,
} from "./types.ts";

const NATIVE_TIMEOUT_MS = 180_000;
const READ_TIMEOUT_MS = 60_000;

type CopilotInstalled = {
  name?: unknown;
  marketplace?: unknown;
  version?: unknown;
  cache_path?: unknown;
  enabled?: unknown;
};

function copilotHome(): string {
  return process.env.COPILOT_HOME || join(homedir(), ".copilot");
}

function configPath(): string {
  return join(copilotHome(), "config.json");
}

export function parseCopilotPluginConfig(text: string): PluginRecord[] {
  let value: unknown;
  try {
    value = JSON5.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON5: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid config shape: expected an object");
  }
  const installedPlugins = (value as { installedPlugins?: unknown }).installedPlugins;
  // Copilot omits this managed field before the first plugin is installed.
  if (installedPlugins === undefined) return [];
  if (!Array.isArray(installedPlugins)) {
    throw new Error("invalid config shape: installedPlugins must be an array");
  }
  const out: PluginRecord[] = [];
  for (const raw of installedPlugins as CopilotInstalled[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.name !== "string" || !raw.name) {
      throw new Error("invalid config shape: every installedPlugins entry must have a non-empty name");
    }
    out.push({
      name: raw.name,
      ...(typeof raw.marketplace === "string" && raw.marketplace ? { marketplace: raw.marketplace } : {}),
      ...(typeof raw.version === "string" && raw.version ? { version: raw.version } : {}),
      ...(typeof raw.cache_path === "string" && raw.cache_path ? { path: raw.cache_path } : {}),
      ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    });
  }
  return out;
}

async function readConfig(): Promise<{ exists: boolean; plugins: PluginRecord[] }> {
  try {
    return { exists: true, plugins: parseCopilotPluginConfig(await readFile(configPath(), "utf8")) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, plugins: [] };
    throw err;
  }
}

export function parseCopilotPluginList(text: string): PluginRecord[] {
  const trimmed = text.trim();
  if (/^No plugins installed\b/i.test(trimmed)) return [];
  const lines = trimmed.split(/\r?\n/);
  const plugins: PluginRecord[] = [];
  for (const line of lines) {
    const bullet = line.match(/^\s*[•*-]\s+(.+?)\s*$/);
    if (!bullet) continue;
    const versioned = bullet[1]!.match(/^(.*?)\s+\(v([^()]+)\)$/);
    const id = (versioned?.[1] ?? bullet[1]!).trim();
    if (!id) continue;
    const at = id.lastIndexOf("@");
    plugins.push({
      name: at > 0 ? id.slice(0, at) : id,
      ...(at > 0 ? { marketplace: id.slice(at + 1) } : {}),
      ...(versioned?.[2]?.trim() ? { version: versioned[2].trim() } : {}),
      enabled: true,
    });
  }
  if (plugins.length === 0) {
    throw new Error("unexpected `copilot plugin list` output");
  }
  return plugins;
}

async function readNative(): Promise<{ exists: boolean; plugins: PluginRecord[] }> {
  const listed = await run("copilot", ["plugin", "list"], { timeoutMs: READ_TIMEOUT_MS });
  if (listed.notFound) throw new Error("copilot CLI not found on PATH");
  if (listed.timedOut) throw new Error(`copilot plugin list timed out after ${READ_TIMEOUT_MS / 1000}s`);
  if (!listed.ok) {
    throw new Error(listed.stderr.trim() || `copilot plugin list exit ${listed.exitCode}`);
  }
  const plugins = parseCopilotPluginList(listed.stdout);

  // The CLI list is the authoritative active set. Its human-readable output does
  // not expose paths and may omit marketplace metadata, so enrich only matching
  // rows from Copilot's own config; never add config-only rows to native truth.
  const config = await readConfig();
  const enriched = plugins.map((plugin) => {
    const match = config.plugins.find(
      (candidate) =>
        pluginNamesOverlap(candidate.name, plugin.name) &&
        (!plugin.marketplace || !candidate.marketplace || candidate.marketplace === plugin.marketplace),
    );
    return match
      ? {
          ...plugin,
          ...(match.marketplace ? { marketplace: match.marketplace } : {}),
          ...(match.version ? { version: match.version } : {}),
          ...(match.path ? { path: match.path } : {}),
          ...(match.enabled !== undefined ? { enabled: match.enabled } : {}),
        }
      : plugin;
  });
  return { exists: config.exists || plugins.length > 0, plugins: enriched };
}

export const copilotPluginAdapter: PluginAdapter = {
  id: "github-copilot",
  sourceRequired: true,
  configPath,

  async read(): Promise<PluginAdapterRead> {
    const base: PluginAdapterRead = {
      agent: "github-copilot",
      configPath: configPath(),
      exists: false,
      plugins: [],
    };
    try {
      const read = await readNative();
      return { ...base, exists: read.exists, plugins: read.plugins };
    } catch (err) {
      return { ...base, error: `cannot read Copilot native plugin state: ${(err as Error).message}` };
    }
  },

  async installPlugin(name: string, opts: PluginInstallOpts): Promise<PluginInstallResult> {
    let before: PluginRecord[];
    try {
      before = (await readNative()).plugins;
    } catch (err) {
      return { agent: "github-copilot", target: name, status: "failed", message: (err as Error).message };
    }
    const present = before.find((p) => pluginNamesOverlap(p.name, name));
    if (present) {
      return {
        agent: "github-copilot",
        target: present.marketplace ? `${present.name}@${present.marketplace}` : present.name,
        status: "present",
      };
    }

    let marketplace = opts.sourceMarketplace;
    let marketplaceSource: string | undefined;
    let standaloneSource: ValidatedPluginRoot | undefined;
    if (opts.sourcePluginPath) {
      try {
        standaloneSource = await validateLocalPluginSource(
          opts.sourcePluginPath,
          { requireNativeManifest: true },
        );
      } catch (err) {
        return {
          agent: "github-copilot",
          target: name,
          status: "failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    } else if (opts.sourceClonePath) {
      try {
        marketplaceSource = await validateLocalPluginSource(
          opts.sourceClonePath,
        );
      } catch (err) {
        return {
          agent: "github-copilot",
          target: name,
          status: "failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
      const local = await readLocalMarketplace(marketplaceSource);
      if (local?.pluginNames.includes(name)) marketplace = local.name;
    }
    if (!marketplaceSource && opts.sourceRepo && isSafeRepoSlug(opts.sourceRepo)) marketplaceSource = opts.sourceRepo;
    if (!marketplaceSource && !standaloneSource) {
      return {
        agent: "github-copilot",
        target: name,
        status: "skipped",
        message: "no usable source repo, local marketplace clone, or standalone plugin artifact for Copilot's native plugin installer",
      };
    }

    const target = standaloneSource ?? (marketplace ? `${name}@${marketplace}` : marketplaceSource!);
    if (opts.dryRun) return { agent: "github-copilot", target, status: "installed", message: "dry-run" };

    if (marketplace && marketplaceSource) {
      const register = await run("copilot", ["plugin", "marketplace", "add", marketplaceSource], {
        timeoutMs: NATIVE_TIMEOUT_MS,
      });
      if (register.notFound) {
        return { agent: "github-copilot", target, status: "failed", message: "copilot CLI not found on PATH" };
      }
      // Registration is idempotent in current Copilot, but older builds return a
      // non-zero "already exists". Let the authoritative install decide whether the
      // marketplace is usable instead of treating that benign registration result
      // as a plugin failure.
    }

    const install = await run("copilot", ["plugin", "install", target], { timeoutMs: NATIVE_TIMEOUT_MS });
    if (install.notFound) {
      return {
        agent: "github-copilot",
        target,
        status: "failed",
        message: "copilot CLI not found on PATH",
      };
    }
    if (install.timedOut) {
      return { agent: "github-copilot", target, status: "failed", message: `timed out after ${NATIVE_TIMEOUT_MS / 1000}s` };
    }
    if (!install.ok) {
      return {
        agent: "github-copilot",
        target,
        status: "failed",
        message:
          install.stderr.trim() ||
          `copilot plugin install exit ${install.exitCode}`,
      };
    }

    let after: PluginRecord[];
    try {
      after = (await readNative()).plugins;
    } catch (err) {
      return {
        agent: "github-copilot",
        target,
        status: "failed",
        message: `install succeeded, but verification failed: ${(err as Error).message}`,
      };
    }
    const installed = after.find((p) => pluginNamesOverlap(p.name, name));
    if (installed) {
      return {
        agent: "github-copilot",
        target: installed.marketplace ? `${installed.name}@${installed.marketplace}` : installed.name,
        status: "installed",
      };
    }
    const beforeKeys = new Set(before.map((p) => `${p.name}@${p.marketplace ?? ""}`));
    const added = after.filter((p) => !beforeKeys.has(`${p.name}@${p.marketplace ?? ""}`));
    if (added.length > 0) {
      return {
        agent: "github-copilot",
        target,
        status: "installed",
        coveredBy: added.map((p) => p.name).join(", "),
        message: `installed natively as ${added.map((p) => p.name).join(", ")}`,
      };
    }
    return {
      agent: "github-copilot",
      target,
      status: "failed",
      message: "Copilot reported success, but a fresh `copilot plugin list` did not show the plugin active",
    };
  },

  async uninstallPlugin(name: string, opts: PluginUninstallOpts): Promise<PluginUninstallResult> {
    let plugins: PluginRecord[];
    try {
      plugins = (await readNative()).plugins;
    } catch (err) {
      return { agent: "github-copilot", target: name, status: "failed", message: (err as Error).message };
    }
    const matches = plugins.filter(
      (p) => pluginNamesOverlap(p.name, name) && (!opts.marketplace || p.marketplace === opts.marketplace),
    );
    if (matches.length === 0) {
      return { agent: "github-copilot", target: opts.marketplace ? `${name}@${opts.marketplace}` : name, status: "absent" };
    }
    if (matches.length > 1 && !opts.marketplace) {
      return { agent: "github-copilot", target: name, status: "skipped", message: "installed under multiple marketplaces" };
    }
    const match = matches[0]!;
    const target = match.marketplace ? `${match.name}@${match.marketplace}` : match.name;
    if (opts.dryRun) return { agent: "github-copilot", target, status: "uninstalled", message: "dry-run" };
    const res = await run("copilot", ["plugin", "uninstall", target], { timeoutMs: NATIVE_TIMEOUT_MS });
    if (res.notFound) return { agent: "github-copilot", target, status: "failed", message: "copilot CLI not found on PATH" };
    if (!res.ok) {
      return {
        agent: "github-copilot",
        target,
        status: "failed",
        message: res.stderr.trim() || `copilot plugin uninstall exit ${res.exitCode}`,
      };
    }
    try {
      const after = (await readNative()).plugins;
      if (after.some((p) => pluginNamesOverlap(p.name, match.name) && p.marketplace === match.marketplace)) {
        return {
          agent: "github-copilot",
          target,
          status: "failed",
          message: "Copilot reported success, but a fresh `copilot plugin list` still shows the plugin active",
        };
      }
    } catch (err) {
      return {
        agent: "github-copilot",
        target,
        status: "failed",
        message: `uninstall succeeded, but verification failed: ${(err as Error).message}`,
      };
    }
    return { agent: "github-copilot", target, status: "uninstalled" };
  },
};
