import type {
  PluginDegradationResult,
  PluginDegradationStatus,
} from "./degrade.ts";
import type {
  PluginNativeReconcileStatus,
  PluginReconcileResult,
} from "./reconcile.ts";

export const PLUGIN_OUTCOMES = [
  "native",
  "adapted",
  "partial",
  "blocked",
  "unsupported",
] as const;

export type PluginOutcome = (typeof PLUGIN_OUTCOMES)[number];

export type NativeOutcomeDetail = Pick<
  PluginReconcileResult,
  "status" | "nativeMode"
>;

/** The small projection shape accepted by the pure outcome mapper. */
export type ProjectionOutcomeDetail = Pick<
  PluginDegradationResult,
  "status" | "component" | "reachProven" | "unresolved"
>;

const NATIVE_SUCCESS: ReadonlySet<PluginNativeReconcileStatus> = new Set([
  "present",
  "would-install",
  "would-repair",
  "installed",
  "repaired",
]);

const PROJECTION_SUCCESS: ReadonlySet<PluginDegradationStatus> = new Set([
  "would-add",
  "added",
]);

function projectionIsUsable(detail: ProjectionOutcomeDetail): boolean {
  if (PROJECTION_SUCCESS.has(detail.status)) return true;
  // `unchanged` is only a success when the adapter/installer proved that the
  // exact projection is already reachable. A conflict, skipped portable item,
  // or an ambiguous/no-op result must not masquerade as adapted.
  return detail.status === "unchanged" && detail.reachProven === true;
}

export function nativeOutcome(detail: NativeOutcomeDetail): PluginOutcome {
  if (detail.status === "failed") return "blocked";
  if (detail.status === "unsupported") return "unsupported";
  if (detail.status === "unverified") return "adapted";
  if (NATIVE_SUCCESS.has(detail.status)) {
    return detail.nativeMode === "write-only" ? "adapted" : "native";
  }
  return "blocked";
}

export function projectionOutcome(
  details: readonly ProjectionOutcomeDetail[],
): PluginOutcome {
  if (details.length === 0) return "unsupported";
  const usable = details.filter(projectionIsUsable);
  const failures = details.filter((detail) => detail.status === "failed");
  const unresolved = details.some(
    (detail) => detail.unresolved === true || (!projectionIsUsable(detail) && detail.status !== "failed"),
  );
  if (usable.length > 0) {
    return failures.length > 0 || unresolved ? "partial" : "adapted";
  }
  if (failures.length > 0) return "blocked";
  // No projection completed usefully. This includes conflicts, skipped work,
  // and bundles for which no portable component existed.
  return "unsupported";
}

export function canonicalOutcome(
  native: NativeOutcomeDetail,
  projections: readonly ProjectionOutcomeDetail[] = [],
): PluginOutcome {
  const base = nativeOutcome(native);
  if (projections.length === 0) return base;
  const projected = projectionOutcome(projections);
  if (base === "blocked") return "blocked";
  if (base === "unsupported") return projected;
  if (projected === "blocked" || projected === "partial") return "partial";
  return base;
}

/**
 * Compose the public outcome only after the degradation phase has produced its
 * per-component evidence. Matching is deliberately by concrete artifact and
 * target, never by display name or result order.
 */
export function composePluginOutcomes(
  results: readonly PluginReconcileResult[],
  projections: readonly PluginDegradationResult[],
): PluginReconcileResult[] {
  return results.map((result) => {
    const matching = projections.filter(
      (projection) =>
        projection.artifactKey === result.artifactKey &&
        projection.agent === result.agent,
    );
    // Reports supplied by older control-plane integrations may omit the new
    // field. Preserve that structural shape when there is no projection to
    // compose; the production reconciler always supplies its native outcome.
    if (matching.length === 0 && result.outcome === undefined) return result;
    return {
      ...result,
      outcome: canonicalOutcome(result, matching),
    };
  });
}

export const mapNativeReconcileOutcome = nativeOutcome;
export const mapProjectionOutcome = projectionOutcome;
