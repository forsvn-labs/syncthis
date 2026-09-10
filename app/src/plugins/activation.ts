// Guarded plugin activation — the shared preview/application service behind
// `syncthis plugins enable|disable`. Reached only by that explicit command
// (never by sync or mirror). It turns already-installed plugins on/off in the
// agents the user scoped to, via each target's own proven CLI:
//   • Claude Code: `claude plugin <enable|disable> [--scope user|project|local] -- <name>`
//   • Grok Build:  `grok plugin <enable|disable> <name>`
//
// Every command is followed by a fresh native read-back; exit zero without an
// observed enabled-state change is a failure. Targets without a proven
// enable/disable command (Codex, GitHub Copilot, Cursor, skill projections and
// everything else) report `unsupported` with positive evidence about what the
// target does instead. No config files are written here — activation goes only
// through the target's own official command.

import { isSafeIdentifier, parsePluginId } from "./shell.ts";
import type { PluginAdapter, PluginRecord } from "./types.ts";
import type {
  PluginActivationOp,
  PluginActivationResult,
  PluginActivationScope,
} from "./types.ts";
import { pluginAdapters } from "./index.ts";
import type { AgentId } from "../types.ts";

// Neutral positive evidence for every target without a proven activation
// capability (Codex, GitHub Copilot, Cursor, skill projections, and any other
// agent). It claims nothing about how those targets behave internally — only
// that Syncthis has no proven integrated activation write/readback contract
// for them. Keyed data, not UI branching — the capability itself lives on the
// optional adapter method.
function unsupportedEvidence(agent: AgentId): string {
  return `${agent} has no proven integrated activation write/readback contract in Syncthis`;
}

function observeActivation(adapter: PluginAdapter, record: PluginRecord): boolean | undefined {
  return adapter.activationState ? adapter.activationState(record) : record.enabled;
}

export class ActivationUsageError extends Error {}

export const ACTIVATION_SCOPES: readonly PluginActivationScope[] = ["user", "project", "local"];

// Scope rails shared by the CLI. Pure: no process I/O, so tests can hit every rail.
export function resolveActivationRequest(input: {
  all: boolean;
  agents?: string;
  scope?: string;
  known: readonly AgentId[];
}): { agents: AgentId[]; scope?: PluginActivationScope } {
  const hasAgents =
    typeof input.agents === "string" && input.agents.trim().length > 0;
  if (input.all && hasAgents) {
    throw new ActivationUsageError("pass either --all or --agents <a,b,c>, not both");
  }
  if (!input.all && !hasAgents) {
    throw new ActivationUsageError("requires an explicit target scope: --all or --agents <a,b,c>");
  }

  let agents: AgentId[];
  if (input.all) {
    agents = [...input.known];
  } else {
    const wanted = input.agents!.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = wanted.filter((a) => !input.known.includes(a as AgentId));
    if (bad.length) {
      throw new ActivationUsageError(
        `unknown agent(s): ${bad.join(", ")}. known: ${input.known.join(", ")}`,
      );
    }
    agents = [...new Set(wanted)] as AgentId[];
  }

  if (input.scope !== undefined) {
    if (!(ACTIVATION_SCOPES as readonly string[]).includes(input.scope)) {
      throw new ActivationUsageError(
        `invalid --scope value ${JSON.stringify(input.scope)}; valid values: ${ACTIVATION_SCOPES.join(", ")}`,
      );
    }
    // The scope flag changes what the Claude command means; on any mixed target
    // set it cannot be preserved exactly, so refuse rather than approximate.
    if (agents.length !== 1 || agents[0] !== "claude-code") {
      throw new ActivationUsageError(
        "--scope applies only to Claude Code; pass --agents claude-code alone with it, or omit it to auto-detect",
      );
    }
  }

  return {
    agents,
    ...(input.scope !== undefined ? { scope: input.scope as PluginActivationScope } : {}),
  };
}

export type NativeActivationTarget = {
  agent: AgentId;
  plugin: string;
  marketplace?: string;
  // The target's own config scope of the selected record (Claude Code), shown
  // so the preview states exactly which installed record is meant.
  scope?: PluginActivationScope;
  present: boolean;
  currentlyEnabled?: boolean;
  unreadable?: string;
  // Set when the request resolves to several installed records whose exact
  // meaning cannot be preserved (any remaining dimension may still duplicate).
  // Apply refuses instead of collapsing to the first record.
  ambiguousRecords?: string[];
  // Set during preview when the adapter's own dry-run preflight refuses the
  // command (e.g. Grok cannot select a marketplace). The preview must show the
  // refusal BEFORE confirmation instead of a "would change" row.
  refusal?: string;
  // Exact native argv the adapter would run for this record, captured from its
  // dry-run preflight so previews show the precise command before confirmation.
  plannedCommand?: string[];
  // Set when the requested identity itself is unsafe (path traversal, option
  // injection). The request is refused without ever reaching a target CLI.
  invalidSpec?: string;
  // Set during an apply that received a confirmed preview when the fresh
  // native read no longer matches the confirmed record (moved scope, changed
  // marketplace, disappeared, became ambiguous, or changed observed state).
  // The target becomes a failed result and never reaches a mutating command.
  previewDrift?: string;
};

export type UnsupportedActivationTarget = {
  agent: AgentId;
  reason: string;
};

export type ActivationReport = {
  op: PluginActivationOp;
  scope?: PluginActivationScope;
  plugins: string[];
  requestedAgents: AgentId[];
  targets: NativeActivationTarget[];
  unsupported: UnsupportedActivationTarget[];
  // Present only after apply.
  results?: PluginActivationResult[];
  applied: boolean;
};

export type ActivationRunOpts = {
  op: PluginActivationOp;
  plugins: string[];
  agents: AgentId[]; // already validated against known agent ids by the caller
  scope?: PluginActivationScope;
  apply: boolean;
  // Dry-run planning: with this set, the service emits `planned` results for
  // every command it WOULD run and shells no mutating command. A planned run
  // never claims verification.
  dryRun?: boolean;
  // Confirmed-preview authority. When provided together with `apply`, this
  // MUST be the exact preview report the user confirmed. The apply validates
  // its own request against it, replays its exact record identity (name,
  // marketplace, observed scope) and desired prior state, and re-checks each
  // record against a fresh native read before any mutation. Confirmation is
  // authority for the WHOLE displayed plan: any drift anywhere in it refuses
  // the entire apply — every would-change row becomes a failed result with
  // zero mutation commands. Never pass a report that the user has not seen.
  confirmedPreview?: ActivationReport;
};

// Pure policy: does this apply request describe the same operation the user
// confirmed in `preview`? Throws ActivationUsageError on any mismatch so a
// caller bug can never silently substitute a different op, plugin set, agent
// set, or scope under an old preview's authority.
export function assertConfirmedPreviewMatches(
  request: {
    op: PluginActivationOp;
    plugins: string[];
    agents: AgentId[];
    scope?: PluginActivationScope;
  },
  preview: ActivationReport,
): void {
  const mismatch = (detail: string) =>
    new ActivationUsageError(
      `confirmed activation preview does not match this apply request (${detail}); build and confirm a fresh preview`,
    );
  if (preview.applied) throw mismatch("the report was already applied");
  if (preview.op !== request.op) throw mismatch(`op ${preview.op} is not ${request.op}`);
  const sameSet = (a: readonly string[], b: readonly string[]) =>
    [...new Set(a)].sort().join("\n") === [...new Set(b)].sort().join("\n");
  if (!sameSet(preview.plugins, request.plugins)) throw mismatch("plugins differ");
  if (!sameSet(preview.requestedAgents, request.agents)) throw mismatch("requested agents differ");
  if ((preview.scope ?? undefined) !== (request.scope ?? undefined)) {
    throw mismatch(`scope ${preview.scope ?? "auto"} is not ${request.scope ?? "auto"}`);
  }
}

function describedTarget(t: { plugin: string; marketplace?: string; scope?: string }): string {
  return `${t.plugin}${t.marketplace ? `@${t.marketplace}` : ""}${t.scope ? ` (${t.scope})` : ""}`;
}

// A row with enough resolved identity to compare against a confirmed plan:
// anything still standing after refusals, unreadable reads, ambiguity, and
// unsafe-spec handling.
function isConcrete(t: NativeActivationTarget): boolean {
  return !!t.present && !t.invalidSpec && !t.unreadable && !t.ambiguousRecords && !t.refusal;
}

const identityKey = (t: { agent: AgentId; plugin: string; marketplace?: string; scope?: string }) =>
  `${t.agent}|${t.plugin}|${t.marketplace ?? ""}|${t.scope ?? ""}`;

// The confirmed-preview boundary. `targets` is the freshly planned row set for
// an apply; `confirmed` is the user-approved preview. Every confirmed concrete
// row must map onto the fresh row with the SAME identity, the SAME observed
// enabled-state, and — for records a command would change — the SAME planned
// native argv. Anything else (moved scope or marketplace, disappeared, became
// unreadable/ambiguous/refused, flipped prior state, drifted argv, brand-new
// actionable records) is annotated as drift. Returns true when ANY row
// drifted: the caller then refuses mutation for the whole apply, because the
// user's confirmation was authority for the entire displayed plan.
function enforceConfirmedPreview(targets: NativeActivationTarget[], confirmed: ActivationReport): boolean {
  const confirmedRows = confirmed.targets.filter(isConcrete);
  const confirmedKeys = new Set(confirmedRows.map(identityKey));
  const freshByKey = new Map<string, NativeActivationTarget>();
  for (const t of targets) {
    if (!freshByKey.has(identityKey(t))) freshByKey.set(identityKey(t), t);
  }

  const drift = (t: NativeActivationTarget, message: string) => {
    if (!t.previewDrift) t.previewDrift = message;
  };
  const argvOf = (cmd?: string[]) => cmd ? cmd.join(" ") : "none";
  const argvEqual = (a?: string[], b?: string[]) =>
    !!a && !!b && a.length === b.length && a.every((arg, i) => arg === b[i]);

  // Pass 1: every confirmed record must survive the fresh plan unchanged.
  for (const p of confirmedRows) {
    const fresh = freshByKey.get(identityKey(p));
    if (fresh) {
      if (isConcrete(fresh)) {
        if (fresh.currentlyEnabled !== p.currentlyEnabled) {
          drift(
            fresh,
            `native state changed since the preview was confirmed: the preview observed ${describedTarget(p)} ${p.currentlyEnabled === undefined ? "in an unknown state" : p.currentlyEnabled ? "enabled" : "disabled"}, but a fresh read now shows ${describedTarget(fresh)} ${fresh.currentlyEnabled === undefined ? "in an unknown state" : fresh.currentlyEnabled ? "enabled" : "disabled"}; nothing was mutated`,
          );
        } else if (
          (p.plannedCommand || fresh.plannedCommand) &&
          !argvEqual(p.plannedCommand, fresh.plannedCommand)
        ) {
          drift(
            fresh,
            `the planned command changed since the preview was confirmed (preview: ${argvOf(p.plannedCommand)}; fresh read: ${argvOf(fresh.plannedCommand)}); nothing was mutated`,
          );
        }
      } else {
        drift(
          fresh,
          `native state changed since the preview was confirmed: the confirmed record ${describedTarget(p)} no longer resolves to the same installable record in a fresh read (${fresh.unreadable ? "state is unreadable" : fresh.ambiguousRecords ? `now ambiguous: ${fresh.ambiguousRecords.join(", ")}` : fresh.refusal ? "the target now refuses it" : "it is gone"}); nothing was mutated`,
        );
      }
      continue;
    }
    // The confirmed identity has no fresh row at all: the record moved or
    // vanished. Annotate whatever fresh row still carries the plugin name —
    // concrete or not, including a plain absent row — so the apply can never
    // look clean when the confirmed record is gone; synthesize only when
    // nothing with that name remains in the plan.
    const survivor = targets.find((t) => t.agent === p.agent && t.plugin === p.plugin && !t.previewDrift);
    if (survivor) {
      drift(
        survivor,
        `native state changed since the preview was confirmed: the confirmed record ${describedTarget(p)} no longer matches any installed record in a fresh read${isConcrete(survivor) ? ` (${describedTarget(survivor)} is what remains)` : ""}; nothing was mutated`,
      );
    } else {
      targets.push({
        agent: p.agent,
        plugin: p.plugin,
        ...(p.marketplace ? { marketplace: p.marketplace } : {}),
        present: false,
        previewDrift: `native state changed since the preview was confirmed: the confirmed record ${describedTarget(p)} disappeared from a fresh native read; nothing was mutated`,
      });
    }
  }

  // Pass 2: every concrete fresh row must trace back to a confirmed record —
  // anything unclaimed appeared (or changed identity) after confirmation.
  for (const t of targets) {
    if (!isConcrete(t) || confirmedKeys.has(identityKey(t))) continue;
    drift(
      t,
      `native state changed since the preview was confirmed: ${describedTarget(t)} does not match any confirmed record; nothing was mutated`,
    );
  }
  return targets.some((t) => !!t.previewDrift);
}

export async function runPluginActivation(opts: ActivationRunOpts): Promise<ActivationReport> {
  // The confirmed-preview boundary is checked before anything else: a request
  // that does not describe the confirmed operation never reaches planning.
  if (opts.confirmedPreview) {
    assertConfirmedPreviewMatches(
      { op: opts.op, plugins: opts.plugins, agents: opts.agents, ...(opts.scope ? { scope: opts.scope } : {}) },
      opts.confirmedPreview,
    );
  }
  const requested = [...new Set(opts.agents)];
  const specs = [...new Set(opts.plugins)].map((p) => parsePluginId(p));

  const targets: NativeActivationTarget[] = [];
  const unsupported: UnsupportedActivationTarget[] = [];

  // Enumerate EVERY requested agent. Agents outside the plugin adapter registry
  // (Cursor, skill-cohort agents) are unsupported here just like incapable
  // adapters — a --all scope must account for each of them explicitly.
  for (const agent of requested) {
    const adapter = pluginAdapters.find((a) => a.id === agent);
    if (!adapter?.setPluginActivation) {
      unsupported.push({ agent, reason: unsupportedEvidence(agent) });
      continue;
    }
    const read = await adapter.read();
    // One plan row per installed record per agent, however many name spellings
    // were requested — a record must never be activated twice.
    const planned = new Set<string>();
    const keyOf = (name: string, marketplace?: string, scope?: string) =>
      `${agent}|${name}|${marketplace ?? ""}|${scope ?? ""}`;
    for (const spec of specs) {
      if (!isSafeIdentifier(spec.name) || (spec.marketplace !== undefined && !isSafeIdentifier(spec.marketplace))) {
        targets.push({
          agent,
          plugin: spec.name,
          marketplace: spec.marketplace,
          present: false,
          invalidSpec: `unsafe plugin identifier ${JSON.stringify(spec.name)}${spec.marketplace !== undefined ? ` or marketplace ${JSON.stringify(spec.marketplace)}` : ""}; refused without running any command`,
        });
        continue;
      }
      if (read.error) {
        if (!planned.has(keyOf(spec.name, spec.marketplace))) {
          planned.add(keyOf(spec.name, spec.marketplace));
          targets.push({
            agent,
            plugin: spec.name,
            marketplace: spec.marketplace,
            present: false,
            unreadable: read.error,
          });
        }
        continue;
      }
      // Candidates honor the request exactly: name, marketplace when qualified,
      // and — for the Claude scope flag — ONLY the requested config scope.
      const candidates = read.plugins.filter(
        (p) =>
          p.name === spec.name &&
          (!spec.marketplace || p.marketplace === spec.marketplace) &&
          (!opts.scope || p.scope === opts.scope),
      );
      if (candidates.length === 0) {
        if (!planned.has(keyOf(spec.name, spec.marketplace))) {
          planned.add(keyOf(spec.name, spec.marketplace));
          targets.push({ agent, plugin: spec.name, marketplace: spec.marketplace, present: false });
        }
        continue;
      }
      // After every filter there must be EXACTLY one record. Any remainder —
      // a second marketplace under an explicit scope, a second scope under an
      // explicit marketplace — is ambiguous; refuse rather than collapse to the
      // first record.
      if (candidates.length > 1 && !planned.has(keyOf(spec.name, spec.marketplace))) {
        planned.add(keyOf(spec.name, spec.marketplace));
        targets.push({
          agent,
          plugin: spec.name,
          marketplace: spec.marketplace,
          present: true,
          ambiguousRecords: candidates
            .map((p) => `${p.name}${p.marketplace ? `@${p.marketplace}` : ""}${p.scope ? ` (${p.scope})` : ""}`)
            .sort(),
        });
        continue;
      }
      for (const record of candidates) {
        if (planned.has(keyOf(record.name, record.marketplace, record.scope))) continue;
        planned.add(keyOf(record.name, record.marketplace, record.scope));
        const row: NativeActivationTarget = {
          agent,
          plugin: record.name,
          marketplace: record.marketplace,
          ...(record.scope ? { scope: record.scope as PluginActivationScope } : {}),
          present: true,
          currentlyEnabled: observeActivation(adapter, record),
        };
        const desired = opts.op === "enable";
        if (row.present && row.currentlyEnabled !== desired) {
          // Dry-run preflight through the adapter itself: a target that will
          // refuse during apply (Grok cannot select a marketplace) must surface
          // that in the preview, before confirmation. It receives exactly the
          // scope/marketplace apply would pass, so the previewed argv is the
          // real argv.
          const probe = await adapter.setPluginActivation!(record.name, {
            op: opts.op,
            dryRun: true,
            scope: opts.scope ?? (row.scope as PluginActivationScope | undefined),
            ...(record.marketplace ? { marketplace: record.marketplace } : {}),
          });
          if (probe.status === "failed") row.refusal = probe.message;
          else if (probe.plannedCommand) row.plannedCommand = probe.plannedCommand;
        }
        targets.push(row);
      }
    }
  }

  // Confirmed-preview enforcement happens on the FRESH plan, before the base
  // report (and any result) exists, so drift annotations and synthetic
  // gone-record rows are part of what the results loop walks. A true return
  // compromises the whole plan: no row may mutate on a stale preview.
  let confirmedPlanCompromised = false;
  if (opts.apply && opts.confirmedPreview && !opts.dryRun) {
    confirmedPlanCompromised = enforceConfirmedPreview(targets, opts.confirmedPreview);
  }

  const base = {
    op: opts.op,
    ...(opts.scope ? { scope: opts.scope } : {}),
    plugins: [...new Set(opts.plugins)],
    requestedAgents: requested,
    targets,
    unsupported,
  };

  if (!opts.apply) return { ...base, applied: false };

  const results: PluginActivationResult[] = [];
  for (const target of targets) {
    const adapter = pluginAdapters.find((a) => a.id === target.agent)!;
    const desired = opts.op === "enable";
    const label = target.marketplace ? `${target.plugin}@${target.marketplace}` : target.plugin;
    if (target.invalidSpec) {
      results.push({ agent: target.agent, target: label, status: "failed", message: target.invalidSpec });
      continue;
    }
    // Confirmed-preview drift is a hard refusal: the fresh native read no
    // longer matches the record the user approved, so no command runs.
    if (target.previewDrift) {
      results.push({ agent: target.agent, target: label, status: "failed", message: target.previewDrift });
      continue;
    }
    // Confirmation is authority for the WHOLE displayed plan: when any row
    // drifted, even an untouched would-change row refuses to run.
    if (
      confirmedPlanCompromised &&
      target.present &&
      !target.unreadable &&
      !target.ambiguousRecords &&
      target.currentlyEnabled !== desired
    ) {
      results.push({
        agent: target.agent,
        target: label,
        status: "failed",
        message:
          "the confirmed preview no longer matches native state elsewhere in this request; re-run to build and confirm a fresh preview — nothing was mutated",
      });
      continue;
    }
    if (target.unreadable) {
      results.push({
        agent: target.agent,
        target: label,
        status: "failed",
        message: `cannot read plugins: ${target.unreadable}`,
      });
      continue;
    }
    if (target.ambiguousRecords) {
      results.push({
        agent: target.agent,
        target: label,
        status: "failed",
        message: `several installed records match ${label} (${target.ambiguousRecords.join(", ")}); qualify with <name>@<marketplace> and/or --scope so the request keeps its exact meaning`,
      });
      continue;
    }
    if (!target.present) {
      results.push({ agent: target.agent, target: label, status: "absent" });
      continue;
    }
    if (target.currentlyEnabled === desired) {
      results.push({
        agent: target.agent,
        target: label,
        status: desired ? "enabled" : "disabled",
        message: `already ${desired ? "enabled" : "disabled"}`,
      });
      continue;
    }
    // Dry-run planning stops here: report the command without running it and
    // without claiming any verification. A preflight refusal is a failure even
    // in a planned run — it would fail during apply too.
    if (opts.dryRun) {
      if (target.refusal) {
        results.push({ agent: target.agent, target: label, status: "failed", message: target.refusal });
      } else {
        results.push({
          agent: target.agent,
          target: label,
          status: desired ? "enabled" : "disabled",
          planned: true,
          message: "dry-run; command was not run and nothing was verified",
        });
      }
      continue;
    }
    // A previewed preflight refusal is final: the target's own contract
    // refuses this record, so apply fails without shelling out rather than
    // re-asking and hoping for a different answer.
    if (target.refusal) {
      results.push({ agent: target.agent, target: label, status: "failed", message: target.refusal });
      continue;
    }
    results.push(
      await adapter.setPluginActivation!(target.plugin, {
        op: opts.op,
        dryRun: false,
        // Carry the exact scope: the explicitly requested one, or the observed
        // scope of the single auto-detected record.
        scope: opts.scope ?? target.scope,
        ...(target.marketplace ? { marketplace: target.marketplace } : {}),
      }),
    );
  }
  return { ...base, results, applied: true };
}

// Anything to actually do? A target counts when the command would run (present,
// state not already observed), when presence can't be determined at all, or
// when the request itself must be refused.
export function activationHasChanges(report: ActivationReport): boolean {
  return report.targets.some(
    (t) =>
      t.unreadable ||
      t.invalidSpec ||
      (t.present && (!!t.ambiguousRecords || t.currentlyEnabled !== (report.op === "enable"))),
  );
}
