import { listAgentIds } from "../adapters/index.ts";
import { skillCohort } from "../skills.ts";
import type { AgentId } from "../types.ts";
import { pluginAdapters } from "./index.ts";
import {
  validateLocalPluginSource,
  type ValidatedPluginRoot,
} from "./local-source.ts";
import type { PluginReconcileTarget } from "./reconcile.ts";
import { isSafeRepoSlug, openPluginsArgs, run } from "./shell.ts";

const CURSOR_PLUGIN_INSTALL_TIMEOUT_MS = 180_000;

// Cursor accepts the root Agent Plugins manifest natively today, but Syncthis
// has no integrated, verified native read or post-apply read-back for it. The
// target is therefore write/adaptation-only here: installs are pushed through
// its installer and reported as adapted with an explicit unverified-activation
// annotation, never as readable or natively verified state.
function cursorPluginTarget(): PluginReconcileTarget {
  return {
    agent: "cursor",
    mode: "write-only",
    async install(artifact) {
      const repo = artifact.sourceRepo;
      const repoSource = repo && isSafeRepoSlug(repo) ? repo : undefined;
      let localSource: ValidatedPluginRoot | undefined;
      if (!repoSource && artifact.sourcePluginPath) {
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
      const source = repoSource ?? localSource;
      if (!source) {
        return {
          ok: false,
          message:
            "no safe github owner/repo or standalone plugin artifact is available for Cursor's write-only plugin installer",
        };
      }

      const result = await run(
        "npx",
        openPluginsArgs(["add", source, "--target", "cursor", "-y"]),
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
          ? "installed via npx -y plugins@1.3.4 (activation cannot be read)"
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
