import { listAgentIds } from "../adapters/index.ts";
import { skillCohort } from "../skills.ts";
import type { AgentId } from "../types.ts";
import { pluginAdapters } from "./index.ts";
import { isCursorLoadableManifestPath, MISSING_CURSOR_MANIFEST, writeHostPlugin } from "./host-sync.ts";
import type { PluginInventoryArtifact } from "./inventory.ts";
import {
  validateLocalPluginSource,
  type ValidatedPluginRoot,
} from "./local-source.ts";
import type { PluginReconcileTarget, PluginSupport } from "./reconcile.ts";
import { inspectPluginSource } from "./source.ts";
import { isSafeRepoSlug, openPluginsArgs, run } from "./shell.ts";

const CURSOR_PLUGIN_INSTALL_TIMEOUT_MS = 180_000;

async function cursorSupportsArtifact(
  artifact: PluginInventoryArtifact,
): Promise<PluginSupport> {
  const root = artifact.sourcePluginPath ?? artifact.pluginRoot;
  if (!root) return { status: "supported" };
  try {
    const inspected = await inspectPluginSource(root);
    if (!inspected.manifests.some((path) => isCursorLoadableManifestPath(path))) {
      return { status: "unsupported-format", message: MISSING_CURSOR_MANIFEST };
    }
    return { status: "supported" };
  } catch (err) {
    return {
      status: "failed",
      message: `plugin capability check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Cursor accepts the root Agent Plugins manifest natively today, but Syncthis
// has no integrated, verified native lifecycle read-back for it. The 2026 load
// path is ~/.cursor/plugins/local (directory drop). Presence on disk is not
// native activation — Cursor may ignore local imports — so outcomes stay adapted.
// Syncthis copies an existing root plugin.json or .cursor-plugin/plugin.json; it
// does not invent a competing Agent Plugins manifest from another client's overlay.
function cursorPluginTarget(): PluginReconcileTarget {
  return {
    agent: "cursor",
    mode: "write-only",
    supportsArtifact: cursorSupportsArtifact,
    async install(artifact) {
      let localSource: ValidatedPluginRoot | undefined;
      if (artifact.sourcePluginPath) {
        try {
          localSource = await validateLocalPluginSource(
            artifact.sourcePluginPath,
            { requireNativeManifest: true },
          );
        } catch (err) {
          return {
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }
      if (localSource) {
        const written = await writeHostPlugin("cursor", localSource, { dryRun: false });
        if (written.status === "conflict" || written.status === "failed") {
          return { ok: false, message: written.message };
        }
        return {
          ok: true,
          alreadyPresent: written.status === "present",
          message: `${written.status === "present" ? "already at" : "copied to"} ${written.path} (activation cannot be read)`,
        };
      }

      const repo = artifact.sourceRepo;
      const repoSource = repo && isSafeRepoSlug(repo) ? repo : undefined;
      if (!repoSource) {
        return {
          ok: false,
          message:
            "no safe github owner/repo or standalone plugin artifact is available for Cursor's write-only plugin installer",
        };
      }

      const result = await run(
        "npx",
        openPluginsArgs(["add", repoSource, "--target", "cursor", "-y"]),
        { timeoutMs: CURSOR_PLUGIN_INSTALL_TIMEOUT_MS },
      );
      if (result.notFound) {
        return { ok: false, message: "`npx -y plugins@1.3.4` not found on PATH" };
      }
      if (result.timedOut) {
        return {
          ok: false,
          message: `timed out after ${CURSOR_PLUGIN_INSTALL_TIMEOUT_MS / 1000}s`,
        };
      }
      return {
        ok: result.ok,
        message: result.ok
          ? "installed via npx -y plugins@1.3.4 (activation cannot be read; prefers ~/.cursor/plugins/local when a local package exists)"
          : result.stderr.trim() || `exit ${result.exitCode}`,
      };
    },
  };
}

/**
 * Canonical target registry for plugin-first reconciliation.
 *
 * Readable native adapters remain verified, Cursor owns its write-only install
 * service here, and every remaining known agent is represented explicitly as
 * having no native plugin ABI.
 */
export function pluginReconcileTargets(): PluginReconcileTarget[] {
  const targets: PluginReconcileTarget[] = pluginAdapters.map((adapter) => ({
    agent: adapter.id,
    mode: "verified",
    adapter,
  }));
  const native = new Set(targets.map((target) => target.agent));

  if (!native.has("cursor")) {
    targets.push(cursorPluginTarget());
    native.add("cursor");
  }

  for (const agent of new Set<AgentId>([
    ...listAgentIds(),
    ...skillCohort(),
  ])) {
    if (!native.has(agent)) targets.push({ agent, mode: "none" });
  }
  return targets;
}
