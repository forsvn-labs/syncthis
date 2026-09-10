import { createHash } from "node:crypto";

declare const artifactKeyBrand: unique symbol;

/** Machine identity for one concrete plugin artifact. */
export type ArtifactKey = string & {
  readonly [artifactKeyBrand]: true;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/**
 * Hash complete, already-normalized source evidence. Callers must include every
 * source discriminator they possess; mutable target activation state does not
 * belong in this identity.
 */
export function createArtifactKey(sourceEvidence: unknown): ArtifactKey {
  const serialized = JSON.stringify(canonical(sourceEvidence));
  return `artifact:${createHash("sha256").update(serialized).digest("hex")}` as ArtifactKey;
}
