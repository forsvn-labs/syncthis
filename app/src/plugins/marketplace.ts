// Local-marketplace resolution — the network-free plugin install mechanism.
//
// Both `claude` and `codex` accept a LOCAL PATH as a marketplace source
// (`<agent> plugin marketplace add <path>`). Claude already keeps every
// marketplace cloned on disk (~/.claude/plugins/marketplaces/<mkt>/), so a plugin
// can be installed onto another agent by registering that clone on the target and
// running the target's own `plugin add/install <name>@<marketplace>` — no `npx`, no
// GitHub re-fetch, no duplicate/orphaned marketplace registrations.
//
// This module is the pure, testable core of that mechanism: derive the marketplace
// name a target will assign to a clone, parse the target's current marketplace
// list, and decide reuse-vs-add. The actual `run()` orchestration lives in the
// adapter (codex.ts), exercised by the fake-CLI integration tests.

import { join } from "node:path";
import { readJson } from "../io.ts";
import { isSafeIdentifier } from "./shell.ts";

export type MarketplaceEntry = { name: string; root: string };

// A local marketplace clone's identity: the marketplace `name` a target will assign
// it, plus the plugin entry names its manifest declares.
export type LocalMarketplace = { name: string; pluginNames: string[] };

// What a target should do with a clone before installing from it:
//   "reuse" — a marketplace already provides this source (same name OR same root);
//             install from it, do NOT re-register (this is what prevents duplicates).
//   "add"   — no existing marketplace matches; register the clone path.
export type MarketplaceResolution = { name: string; action: "reuse" | "add" };

async function readManifest(clonePath: string): Promise<{ name?: unknown; plugins?: unknown } | null> {
  for (const rel of [".claude-plugin/marketplace.json", "marketplace.json"]) {
    try {
      const data = await readJson<{ name?: unknown; plugins?: unknown }>(join(clonePath, rel));
      if (data && typeof data === "object") return data;
    } catch {
      /* try the next candidate path */
    }
  }
  return null;
}

// Read a local marketplace clone's identity. The marketplace name a target derives
// == the manifest's `name` field (verified: Claude's clone dir name and the manifest
// `name` agree for single-source clones, but the manifest is the truth — e.g. a
// `Nutlope-hallmark` clone dir can declare name `hallmark`). Falls back to the
// directory basename when no manifest name is readable/safe. `pluginNames` are the
// entry names the manifest declares — used to confirm a plugin can actually be
// installed by name from this clone (the agent-local install id, e.g. a URL-named
// `github.com-*` id, can differ from the marketplace entry name). Returns null when
// no safe marketplace name can be derived (can't form `name@marketplace`).
export async function readLocalMarketplace(clonePath: string): Promise<LocalMarketplace | null> {
  const manifest = await readManifest(clonePath);
  const manifestName =
    manifest && typeof manifest.name === "string" && isSafeIdentifier(manifest.name) ? manifest.name : null;
  const base = clonePath.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
  const name = manifestName ?? (isSafeIdentifier(base) ? base : null);
  if (!name) return null;
  const pluginNames = Array.isArray(manifest?.plugins)
    ? (manifest!.plugins as Array<{ name?: unknown }>)
        .map((p) => p?.name)
        .filter((n): n is string => typeof n === "string")
    : [];
  return { name, pluginNames };
}

// The marketplace name a target will derive from a clone (convenience wrapper).
export async function localMarketplaceName(clonePath: string): Promise<string | null> {
  return (await readLocalMarketplace(clonePath))?.name ?? null;
}

// Parse `codex plugin marketplace list` (and the same-shaped `claude plugin
// marketplace list` table):
//
//   MARKETPLACE             ROOT
//   personal                /Users/hungvio
//   impeccable              /Users/hungvio/.claude/plugins/marketplaces/impeccable
//
// Two fixed-width columns. The ROOT value can contain spaces, so slice by the
// header-derived column offset rather than splitting on whitespace.
export function parseMarketplaceList(text: string): MarketplaceEntry[] {
  const out: MarketplaceEntry[] = [];
  let rootCol = -1;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (rootCol < 0) {
      // Locate the header row and the ROOT column start.
      const m = line.indexOf("MARKETPLACE");
      const r = line.indexOf("ROOT");
      if (m === 0 && r > 0) rootCol = r;
      continue;
    }
    const name = line.slice(0, rootCol).trim();
    const root = line.slice(rootCol).trim();
    if (name) out.push({ name, root });
  }
  return out;
}

// Decide whether to reuse an already-registered marketplace or add the clone.
// Reuse wins when a registered marketplace already points at this exact clone path
// (idempotent — Codex's own `marketplace add` is a no-op on a known path) OR already
// owns the derived name (a same-name/different-path collision: reuse it rather than
// fight over the name, so we never spawn a second registration). Otherwise add.
export function resolveLocalMarketplace(opts: {
  existing: MarketplaceEntry[];
  name: string;
  clonePath: string;
}): MarketplaceResolution {
  const byRoot = opts.existing.find((e) => e.root === opts.clonePath);
  if (byRoot) return { name: byRoot.name, action: "reuse" };
  const byName = opts.existing.find((e) => e.name === opts.name);
  if (byName) return { name: byName.name, action: "reuse" };
  return { name: opts.name, action: "add" };
}
