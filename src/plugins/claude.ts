import { expandHome, readJson } from "../io.ts";
import {
  validateLocalPluginSource,
  type ValidatedPluginRoot,
} from "./local-source.ts";
import { assertSafeIdentifier, openPluginsArgs, parsePluginId, run } from "./shell.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginInstallOpts,
  PluginInstallResult,
  PluginRecord,
  PluginUninstallOpts,
  PluginUninstallResult,
} from "./types.ts";

const CONFIG_PATH = "~/.claude.json";
const INSTALLED_PLUGINS_PATH = "~/.claude/plugins/installed_plugins.json";
const KNOWN_MARKETPLACES_PATH = "~/.claude/plugins/known_marketplaces.json";

type ClaudePluginListItem = {
  id: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  installPath?: string;
};

type ClaudeInstalledPluginEntry = {
  version?: unknown;
  scope?: unknown;
  enabled?: unknown;
  installPath?: unknown;
};

type ClaudeInstalledPluginsState = {
  plugins?: unknown;
};

type ClaudeMarketplaceListItem = {
  name?: unknown;
  source?: unknown;
  repo?: unknown;
};

type ClaudeKnownMarketplaceEntry = {
  source?: {
    source?: unknown;
    repo?: unknown;
  };
};

// The `claude` CLI loads every plugin/MCP on startup, so a cold invocation can run
// several seconds (occasionally >15s on a loaded machine with many marketplaces).
// The default 15s `run()` timeout is too tight for it. Give reads generous
// headroom so transient cold-start slowness does not abort a mirror; installs may
// also clone, so they get longer.
const READ_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 180_000;
const PLUGINS_TARGET = "claude-code";

function resolvedConfigPath(): string {
  return expandHome(CONFIG_PATH);
}

function pluginRecord(id: string, fields: ClaudeInstalledPluginEntry): PluginRecord {
  const { name, marketplace } = parsePluginId(id);
  return {
    name,
    marketplace,
    version: typeof fields.version === "string" ? fields.version : undefined,
    enabled: typeof fields.enabled === "boolean" ? fields.enabled : undefined,
    scope: typeof fields.scope === "string" ? fields.scope : undefined,
    path: typeof fields.installPath === "string" ? fields.installPath : undefined,
  };
}

function pluginMatches(
  plugin: PluginRecord,
  name: string,
  marketplace?: string,
): boolean {
  return plugin.name === name && (!marketplace || plugin.marketplace === marketplace);
}

function parseCliPluginList(raw: unknown): PluginRecord[] | null {
  if (!Array.isArray(raw)) return null;
  const plugins: PluginRecord[] = [];
  for (const item of raw as ClaudePluginListItem[]) {
    if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
    plugins.push(pluginRecord(item.id, item));
  }
  return plugins;
}

export function parseClaudeInstalledPlugins(raw: unknown): PluginRecord[] | null {
  if (!raw || typeof raw !== "object") return null;
  const state = raw as ClaudeInstalledPluginsState;
  const map = state.plugins;
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;

  const plugins: PluginRecord[] = [];
  for (const [id, installsRaw] of Object.entries(map as Record<string, unknown>)) {
    if (typeof id !== "string") continue;
    const installs = Array.isArray(installsRaw) ? installsRaw : [installsRaw];
    for (const install of installs) {
      if (!install || typeof install !== "object" || Array.isArray(install)) continue;
      plugins.push(pluginRecord(id, install as ClaudeInstalledPluginEntry));
    }
  }
  return plugins;
}

async function readInstalledPluginState(): Promise<PluginRecord[] | null> {
  try {
    return parseClaudeInstalledPlugins(await readJson(expandHome(INSTALLED_PLUGINS_PATH)));
  } catch {
    return null;
  }
}

function parseMarketplaceCliSources(raw: unknown): Map<string, string> | null {
  if (!Array.isArray(raw)) return null;
  const map = new Map<string, string>();
  for (const m of raw as ClaudeMarketplaceListItem[]) {
    if (typeof m?.name === "string" && m.source === "github" && typeof m.repo === "string") {
      map.set(m.name, m.repo);
    }
  }
  return map;
}

function parseKnownMarketplaceSources(raw: unknown): Map<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const map = new Map<string, string>();
  for (const [name, entry] of Object.entries(raw as Record<string, ClaudeKnownMarketplaceEntry>)) {
    const source = entry?.source;
    if (source?.source === "github" && typeof source.repo === "string") map.set(name, source.repo);
  }
  return map;
}

async function readKnownMarketplaceSources(): Promise<Map<string, string> | null> {
  try {
    return parseKnownMarketplaceSources(await readJson(expandHome(KNOWN_MARKETPLACES_PATH)));
  } catch {
    return null;
  }
}

// marketplace name → local clone directory (`installLocation`) for Claude's
// registered marketplaces. The clone is what a target's
// `plugin marketplace add <path>` registers to install from, network-free — the
// preferred plugin transfer mechanism (see src/plugins/marketplace.ts). Best-effort:
// an entry without an installLocation is skipped; a read failure yields an empty map.
export async function claudeMarketplaceClonePaths(): Promise<Map<string, string>> {
  try {
    const data = await readJson(expandHome(KNOWN_MARKETPLACES_PATH));
    if (!data || typeof data !== "object" || Array.isArray(data)) return new Map();
    const map = new Map<string, string>();
    for (const [name, entry] of Object.entries(data as Record<string, { installLocation?: unknown }>)) {
      if (entry && typeof entry.installLocation === "string" && entry.installLocation) {
        map.set(name, entry.installLocation);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

async function fallbackRead(error: string, base: PluginAdapterRead): Promise<PluginAdapterRead> {
  const fallback = await readInstalledPluginState();
  if (fallback) return { ...base, exists: true, plugins: fallback };
  return { ...base, error };
}

export const claudePluginAdapter: PluginAdapter = {
  id: "claude-code",
  configPath: resolvedConfigPath,
  async read(): Promise<PluginAdapterRead> {
    const base: PluginAdapterRead = {
      agent: "claude-code",
      configPath: resolvedConfigPath(),
      exists: false,
      plugins: [],
    };

    // Claude currently truncates `claude plugin list --json` at 64 KiB on large
    // installs while still exiting 0. The on-disk state is complete and is what
    // the CLI renders from, so prefer it and keep the CLI as a compatibility
    // fallback for older layouts.
    const state = await readInstalledPluginState();
    if (state) return { ...base, exists: true, plugins: state };

    const pluginsRes = await run("claude", ["plugin", "list", "--json"], { timeoutMs: READ_TIMEOUT_MS });
    if (pluginsRes.notFound) return fallbackRead("claude CLI not found on PATH", base);
    if (!pluginsRes.ok) {
      return fallbackRead(pluginsRes.stderr.trim() || `claude plugin list exit ${pluginsRes.exitCode}`, base);
    }

    let pluginsRaw: unknown;
    try {
      pluginsRaw = JSON.parse(pluginsRes.stdout || "[]");
    } catch (err) {
      const maybeTruncated = pluginsRes.stdout.length === 65_536 ? "; output was exactly 65536 bytes, likely truncated" : "";
      return fallbackRead(`claude plugin list: invalid JSON (${(err as Error).message}${maybeTruncated})`, base);
    }

    const plugins = parseCliPluginList(pluginsRaw);
    if (!plugins) return fallbackRead("claude plugin list: unexpected JSON shape", base);

    return { ...base, exists: true, plugins };
  },

  // marketplace name → "owner/repo" for Claude's registered github marketplaces.
  // Lets the mirror tell a target (Codex) where to provision a plugin whose
  // marketplace it lacks. Local/non-github sources are omitted (no repo to add).
  async marketplaceSources(): Promise<Map<string, string> | null> {
    const res = await run("claude", ["plugin", "marketplace", "list", "--json"], { timeoutMs: READ_TIMEOUT_MS });
    if (!res.ok) return readKnownMarketplaceSources();
    let raw: unknown;
    try {
      raw = JSON.parse(res.stdout || "[]");
    } catch {
      return readKnownMarketplaceSources();
    }
    return parseMarketplaceCliSources(raw) ?? readKnownMarketplaceSources();
  },

  async installPlugin(name: string, opts: PluginInstallOpts): Promise<PluginInstallResult> {
    try {
      assertSafeIdentifier(name, "plugin name");
      if (opts.marketplace) assertSafeIdentifier(opts.marketplace, "marketplace name");
    } catch (err) {
      return { agent: "claude-code", target: name, status: "failed", message: (err as Error).message };
    }
    const target = opts.marketplace ? `${name}@${opts.marketplace}` : name;
    // Skip if already present in the canonical identity.
    const read = await this.read();
    if (!read.error) {
      const found = read.plugins.find((p) => pluginMatches(p, name, opts.marketplace));
      if (found) return { agent: "claude-code", target, status: "present" };
    }
    let standaloneSource: ValidatedPluginRoot | undefined;
    if (opts.sourcePluginPath) {
      try {
        standaloneSource = await validateLocalPluginSource(
          opts.sourcePluginPath,
          { requireNativeManifest: true },
        );
      } catch (err) {
        return {
          agent: "claude-code",
          target,
          status: "failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
    if (opts.dryRun) return { agent: "claude-code", target, status: "installed", message: "dry-run" };
    const res = standaloneSource
      ? await run("npx", openPluginsArgs(["add", standaloneSource, "--target", PLUGINS_TARGET, "-y"]), {
          timeoutMs: INSTALL_TIMEOUT_MS,
        })
      : await run("claude", ["plugin", "install", "--yes", "--", target], { timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.notFound) {
      return {
        agent: "claude-code",
        target,
        status: "failed",
        message: standaloneSource ? "`npx -y plugins@1.3.4` not found on PATH" : "claude CLI not found",
      };
    }
    if (res.timedOut) {
      return {
        agent: "claude-code",
        target,
        status: "failed",
        message: `timed out after ${INSTALL_TIMEOUT_MS / 1000}s`,
      };
    }
    if (!res.ok) return { agent: "claude-code", target, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` };

    const verified = await this.read();
    if (verified.error) {
      return {
        agent: "claude-code",
        target,
        status: "failed",
        message: `install exited successfully, but fresh native state could not be read: ${verified.error}`,
      };
    }
    const installed = verified.plugins.find(
      (plugin) => pluginMatches(plugin, name, opts.marketplace) && plugin.enabled !== false,
    );
    if (!installed) {
      return {
        agent: "claude-code",
        target,
        status: "failed",
        message: "Claude reported success, but a fresh native read did not show the plugin installed and active",
      };
    }
    return { agent: "claude-code", target, status: "installed" };
  },

  // Guarded uninstall — reached only by `syncthis plugin rm`. Checks the installed
  // snapshot first so an absent plugin is a no-op (status "absent"), never an error.
  async uninstallPlugin(name: string, opts: PluginUninstallOpts): Promise<PluginUninstallResult> {
    try {
      assertSafeIdentifier(name, "plugin name");
      if (opts.marketplace) assertSafeIdentifier(opts.marketplace, "marketplace name");
    } catch (err) {
      return { agent: "claude-code", target: name, status: "failed", message: (err as Error).message };
    }
    const target = opts.marketplace ? `${name}@${opts.marketplace}` : name;
    const read = await this.read();
    if (!read.error) {
      const found = read.plugins.find((p) => pluginMatches(p, name, opts.marketplace));
      if (!found) return { agent: "claude-code", target, status: "absent" };
    }
    if (opts.dryRun) return { agent: "claude-code", target, status: "uninstalled", message: "dry-run" };
    // `--yes` is required when stdout/stdin isn't a TTY (skips the --prune confirm).
    const args = ["plugin", "uninstall", "--yes"];
    if (opts.keepData) args.push("--keep-data");
    args.push("--", target);
    const res = await run("claude", args, { timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.notFound) return { agent: "claude-code", target, status: "failed", message: "claude CLI not found" };
    if (!res.ok) return { agent: "claude-code", target, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` };

    const verified = await this.read();
    if (verified.error) {
      return {
        agent: "claude-code",
        target,
        status: "failed",
        message: `uninstall exited successfully, but fresh native state could not be read: ${verified.error}`,
      };
    }
    if (verified.plugins.some((plugin) => pluginMatches(plugin, name, opts.marketplace))) {
      return {
        agent: "claude-code",
        target,
        status: "failed",
        message: "Claude reported success, but a fresh native read still shows the plugin installed",
      };
    }
    return { agent: "claude-code", target, status: "uninstalled" };
  },
};
