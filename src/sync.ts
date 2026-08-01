import { spawn } from "node:child_process";
import { adapters, findAdapter } from "./adapters/index.ts";
import {
  computeUnion,
  diffServers,
  type Conflict,
  type DirectionalDiff,
} from "./mcp-state.ts";
import {
  runPluginDegradation,
  type PluginDegradationReport,
  type RunPluginDegradationOptions,
} from "./plugins/degrade.ts";
import {
  runPluginReconcile,
  type PluginReconcileReport,
  type PluginReconcileTarget,
  type RunPluginReconcileOptions,
} from "./plugins/reconcile.ts";
import { pluginReconcileTargets } from "./plugins/targets.ts";
import type { PluginSkillsReport } from "./skills.ts";
import type { AdapterRead, AdapterWriteResult, AgentId, McpServer } from "./types.ts";

const SKILLS_UPDATE_TIMEOUT_MS = 120_000;

// Compatibility facade: canonical implementations live below the composition
// root so plugin services never need to import sync.ts.
export { computeUnion, diffServers, findAdapter };
export { listAgentIds } from "./adapters/index.ts";
export { pluginReconcileTargets as syncPluginTargets };
export type { Conflict, DirectionalDiff };

export type SyncOptions = {
  dryRun?: boolean;
  skipSkills?: boolean;
  /** Internal MCP-only mode; unlike --no-skills, this suppresses plugin reconciliation. */
  skipPlugins?: boolean;
  onPluginSkillProgress?: (repo: string, i: number, total: number) => void;
  /** Test/control-plane injection; production defaults to the native reconciler. */
  reconcilePlugins?: (opts: RunPluginReconcileOptions) => Promise<PluginReconcileReport>;
  /** Test/control-plane injection; production defaults to targeted degradation. */
  degradePlugins?: (opts: RunPluginDegradationOptions) => Promise<PluginDegradationReport>;
  pluginTargets?: PluginReconcileTarget[];
};

function skippedPluginReconcileReport(dryRun: boolean): PluginReconcileReport {
  return {
    dryRun,
    inventory: { artifacts: [], sources: [], errors: [] },
    results: [],
    failures: [],
    hasFailures: false,
    hasChanges: false,
  };
}

function skippedPluginDegradationReport(dryRun: boolean): PluginDegradationReport {
  return {
    dryRun,
    eligibleOutcomes: [],
    results: [],
    failures: [],
    hasFailures: false,
    hasChanges: false,
  };
}

export type DirectionalReport = {
  from: AgentId;
  to: AgentId;
  fromRead: AdapterRead;
  toRead: AdapterRead;
  diff: DirectionalDiff;
  applied: boolean;
  write?: AdapterWriteResult;
};

export type FanOutTarget = {
  to: AgentId;
  toRead: AdapterRead;
  diff: DirectionalDiff;
  write?: AdapterWriteResult;
};

export type FanOutReport = {
  from: AgentId;
  fromRead: AdapterRead;
  targets: FanOutTarget[];
  applied: boolean;
};

export type SelectiveMcpTarget = {
  to: AgentId;
  toRead: AdapterRead;
  add: string[];
  conflicts: string[];
  write?: AdapterWriteResult;
};

export type SelectiveMcpReport = {
  from: AgentId;
  to: AgentId[];
  names: string[];
  fromRead: AdapterRead;
  notFound: string[];
  targets: SelectiveMcpTarget[];
  applied: boolean;
};

export type RemoveReport = {
  name: string;
  applied: boolean;
  writes: AdapterWriteResult[];
};

export type SyncReport = {
  ok: boolean;
  plugins: PluginReconcileReport;
  pluginDegradation: PluginDegradationReport;
  reads: AdapterRead[];
  union: Record<string, McpServer>;
  conflicts: Conflict[];
  writes: AdapterWriteResult[];
  pluginSkills?: PluginSkillsReport;
  skills?: { ran: boolean; ok: boolean; message?: string };
};

export async function runSync(opts: SyncOptions = {}): Promise<SyncReport> {
  const dryRun = opts.dryRun ?? false;
  const reconcile = opts.reconcilePlugins ?? runPluginReconcile;
  const degrade = opts.degradePlugins ?? runPluginDegradation;
  // Plugin activation is resolved first. MCP union remains independent and still
  // runs after plugin failures so one broken runtime cannot block healthy MCP
  // propagation to every other agent.
  const plugins = opts.skipPlugins
    ? skippedPluginReconcileReport(dryRun)
    : await reconcile({
        dryRun,
        targets: opts.pluginTargets ?? pluginReconcileTargets(),
      });

  const reads = await Promise.all(adapters.map((a) => a.read()));
  const { union, conflicts } = computeUnion(reads);
  const conflictNames = new Set(conflicts.map((c) => c.name));
  const readsByAgent = new Map(reads.map((r) => [r.agent, r]));

  const writes = await Promise.all(
    adapters.map((a) => {
      const read = readsByAgent.get(a.id)!;
      const own = read.servers;
      const final: Record<string, McpServer> = { ...union };
      for (const name of conflictNames) {
        if (own[name]) final[name] = own[name];
      }
      if (!read.error && Object.keys(final).length === 0 && Object.keys(own).length === 0) {
        return {
          agent: a.id,
          path: read.path,
          status: "skipped",
          message: "nothing to sync",
        } satisfies AdapterWriteResult;
      }
      return a.write(final, { dryRun });
    }),
  );

  // Native activation and the MCP union own their primary paths first. Only then
  // apply explicit per-artifact/per-agent fallback decisions; the degradation
  // executor is additive and cannot fan content back into successful native
  // targets. --no-skills suppresses only its loose-skill component.
  const pluginDegradation = opts.skipPlugins
    ? skippedPluginDegradationReport(dryRun)
    : await degrade({
        reconcile: plugins,
        includeSkills: !opts.skipSkills,
        includeMcp: true,
      });

  const report: SyncReport = {
    ok: true,
    plugins,
    pluginDegradation,
    reads,
    union,
    conflicts,
    writes,
  };

  if (opts.skipSkills) {
    report.skills = { ran: false, ok: true, message: "skipped (--no-skills)" };
    report.ok = !syncHasFailures(report);
    return report;
  }

  report.skills = dryRun ? { ran: false, ok: true, message: "skipped (dry-run)" } : await runSkillsUpdate();
  report.ok = !syncHasFailures(report);

  return report;
}

export function syncFailureCount(report: SyncReport): number {
  const writeFailures = report.writes.filter((write) => write.status === "failed").length;
  const pluginFailures = report.plugins.failures.length;
  // Missing native CLIs are actionable only when an eligible artifact targets
  // them; that case already appears in `pluginFailures`. Do not make an otherwise
  // empty sync fail merely because an optional agent runtime is not installed.
  const inventoryFailures = report.plugins.inventory.errors.filter(
    (error) => error.source !== "native-runtime",
  ).length;
  const degradationFailures = report.pluginDegradation.failures.length;
  const pluginSkillFailures = report.pluginSkills?.results.filter((result) => result.status === "failed").length ?? 0;
  const skillsFailure = report.skills?.ran && !report.skills.ok ? 1 : 0;
  return writeFailures + pluginFailures + inventoryFailures + degradationFailures + pluginSkillFailures + skillsFailure;
}

export function syncHasFailures(report: SyncReport): boolean {
  return syncFailureCount(report) > 0;
}

type DirectionalOptions = {
  from: AgentId;
  to: AgentId;
  dryRun?: boolean;
  apply: boolean;
};

export async function runDirectional(opts: DirectionalOptions): Promise<DirectionalReport> {
  const fromAdapter = findAdapter(opts.from);
  const toAdapter = findAdapter(opts.to);
  if (!fromAdapter) throw new Error(`syncthis: unknown agent: ${opts.from}`);
  if (!toAdapter) throw new Error(`syncthis: unknown agent: ${opts.to}`);
  if (opts.from === opts.to) throw new Error(`syncthis: from and to must differ`);

  const [fromRead, toRead] = await Promise.all([fromAdapter.read(), toAdapter.read()]);
  if (fromRead.error) throw new Error(`syncthis: cannot read source ${opts.from}: ${fromRead.error}`);
  if (toRead.error) throw new Error(`syncthis: cannot read destination ${opts.to}: ${toRead.error}`);
  const diff = diffServers(fromRead.servers, toRead.servers);

  if (!opts.apply || opts.dryRun) {
    return { from: opts.from, to: opts.to, fromRead, toRead, diff, applied: false };
  }

  const write = await toAdapter.write(fromRead.servers, { dryRun: false });
  return { from: opts.from, to: opts.to, fromRead, toRead, diff, applied: true, write };
}

export async function runFanOut(opts: { from: AgentId; dryRun?: boolean; apply: boolean }): Promise<FanOutReport> {
  const fromAdapter = findAdapter(opts.from);
  if (!fromAdapter) throw new Error(`syncthis: unknown agent: ${opts.from}`);

  const fromRead = await fromAdapter.read();
  if (fromRead.error) throw new Error(`syncthis: cannot read source ${opts.from}: ${fromRead.error}`);

  const targets = await Promise.all(
    adapters
      .filter((a) => a.id !== opts.from)
      .map(async (adapter): Promise<FanOutTarget> => {
        const toRead = await adapter.read();
        if (toRead.error) {
          return {
            to: adapter.id,
            toRead,
            diff: { add: [], overwrite: [], remove: [] },
            write: opts.apply && !opts.dryRun
              ? { agent: adapter.id, path: toRead.path, status: "failed", message: toRead.error }
              : undefined,
          };
        }

        const diff = diffServers(fromRead.servers, toRead.servers);
        const hasChange = diff.add.length > 0 || diff.overwrite.length > 0 || diff.remove.length > 0;
        if (!opts.apply || !hasChange) return { to: adapter.id, toRead, diff };
        const write = await adapter.write(fromRead.servers, { dryRun: !!opts.dryRun });
        return { to: adapter.id, toRead, diff, write };
      }),
  );

  return { from: opts.from, fromRead, targets, applied: opts.apply && !opts.dryRun };
}

export async function runSelectiveMcpSync(opts: {
  from: AgentId;
  to: AgentId[];
  names: string[];
  dryRun?: boolean;
  apply: boolean;
}): Promise<SelectiveMcpReport> {
  const fromAdapter = findAdapter(opts.from);
  if (!fromAdapter) throw new Error(`syncthis: unknown MCP source agent: ${opts.from}`);

  const targetIds = [...new Set(opts.to)].filter((id) => id !== opts.from);
  const names = [...new Set(opts.names.map((n) => n.trim()).filter(Boolean))].sort();
  if (names.length === 0) throw new Error("syncthis: choose at least one MCP server");

  const fromRead = await fromAdapter.read();
  if (fromRead.error) throw new Error(`syncthis: cannot read source ${opts.from}: ${fromRead.error}`);

  const selected: Record<string, McpServer> = {};
  const notFound: string[] = [];
  for (const name of names) {
    const server = fromRead.servers[name];
    if (server) selected[name] = server;
    else notFound.push(name);
  }

  const targets = await Promise.all(
    targetIds.map(async (id): Promise<SelectiveMcpTarget> => {
      const adapter = findAdapter(id);
      if (!adapter) throw new Error(`syncthis: unknown MCP destination agent: ${id}`);

      const toRead = await adapter.read();
      if (toRead.error) {
        return {
          to: id,
          toRead,
          add: [],
          conflicts: [],
          write: opts.apply ? { agent: id, path: toRead.path, status: "failed", message: toRead.error } : undefined,
        };
      }

      const diff = diffServers(selected, toRead.servers);
      const add = diff.add;
      const conflicts = diff.overwrite;
      if (!opts.apply || opts.dryRun || add.length === 0) {
        return { to: id, toRead, add, conflicts };
      }

      const next: Record<string, McpServer> = { ...toRead.servers };
      for (const name of add) next[name] = selected[name]!;
      const write = await adapter.write(next, { dryRun: false });
      return { to: id, toRead, add, conflicts, write };
    }),
  );

  return { from: opts.from, to: targetIds, names, fromRead, notFound, targets, applied: opts.apply && !opts.dryRun };
}

export async function runRemove(opts: {
  name: string;
  // When set, remove only from these agents (still an explicit scope — the caller's
  // `--agents <list>`). Unset = every MCP agent (the `--all` scope). Either way the
  // command is gated by a diff + confirm/--yes upstream.
  agents?: AgentId[];
  dryRun?: boolean;
  apply: boolean;
}): Promise<RemoveReport> {
  const name = opts.name.trim();
  if (!name) throw new Error("syncthis: server name is required");

  const scoped = opts.agents ? adapters.filter((a) => opts.agents!.includes(a.id)) : adapters;
  const reads = await Promise.all(scoped.map((a) => a.read()));
  const readsByAgent = new Map(reads.map((r) => [r.agent, r]));
  const writes = await Promise.all(
    scoped.map(async (adapter): Promise<AdapterWriteResult> => {
      const read = readsByAgent.get(adapter.id)!;
      if (read.error) {
        return { agent: adapter.id, path: read.path, status: "failed", message: read.error };
      }
      if (!read.servers[name]) {
        return { agent: adapter.id, path: read.path, status: "skipped", message: "not present" };
      }
      if (adapter.removeServer) {
        if (!opts.apply) return adapter.removeServer(name, { dryRun: true });
        return adapter.removeServer(name, { dryRun: !!opts.dryRun });
      }
      const next = { ...read.servers };
      delete next[name];
      if (!opts.apply) {
        return { agent: adapter.id, path: read.path, status: "synced", message: "dry-run" };
      }
      return adapter.write(next, { dryRun: !!opts.dryRun });
    }),
  );

  return { name, applied: opts.apply && !opts.dryRun, writes };
}

export async function runSkillsOnly(): Promise<NonNullable<SyncReport["skills"]>> {
  return runSkillsUpdate();
}

function runSkillsUpdate(): Promise<NonNullable<SyncReport["skills"]>> {
  return new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    let settled = false;
    // stdout is inherited so the user sees skills' own progress; stderr is captured
    // so a failure tail can be surfaced.
    const child = spawn("npx", ["-y", "skills", "update", "-y"], { stdio: ["ignore", "inherit", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SKILLS_UPDATE_TIMEOUT_MS);
    // 'error' (spawn failure) and 'close' can both fire — settle exactly once.
    const finish = (r: NonNullable<SyncReport["skills"]>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (err: Error) => finish({ ran: true, ok: false, message: `npx skills failed: ${err.message}` }));
    child.on("close", (code) => {
      if (timedOut) return finish({ ran: true, ok: false, message: `npx skills timed out after ${SKILLS_UPDATE_TIMEOUT_MS / 1000}s` });
      if (code === 0) return finish({ ran: true, ok: true });
      finish({ ran: true, ok: false, message: `npx skills exited ${code}: ${stderr.trim().split("\n").pop() ?? ""}` });
    });
  });
}
