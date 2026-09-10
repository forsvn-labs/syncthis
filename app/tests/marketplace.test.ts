import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localMarketplaceName, parseMarketplaceList, readLocalMarketplace, resolveLocalMarketplace } from "../src/plugins/marketplace.ts";

const W = 24;
const pad = (s: string) => s.padEnd(W);

describe("parseMarketplaceList", () => {
  test("parses the marketplace table, preserving spaces in ROOT", () => {
    const text = [
      pad("MARKETPLACE") + "ROOT",
      pad("personal") + "/Users/me",
      pad("impeccable") + "/Users/me/.claude/plugins/marketplaces/impeccable",
      pad("bundled") + "/Users/me/Library/Application Support/x",
    ].join("\n");
    expect(parseMarketplaceList(text)).toEqual([
      { name: "personal", root: "/Users/me" },
      { name: "impeccable", root: "/Users/me/.claude/plugins/marketplaces/impeccable" },
      { name: "bundled", root: "/Users/me/Library/Application Support/x" },
    ]);
  });

  test("returns [] when there is no header or no rows", () => {
    expect(parseMarketplaceList("garbage with no header\n")).toEqual([]);
    expect(parseMarketplaceList("")).toEqual([]);
    expect(parseMarketplaceList(pad("MARKETPLACE") + "ROOT\n")).toEqual([]);
  });
});

describe("resolveLocalMarketplace", () => {
  test("reuses an existing marketplace registered from the same clone path (idempotent)", () => {
    const existing = [{ name: "personal", root: "/Users/me" }, { name: "imp-x", root: "/clone" }];
    expect(resolveLocalMarketplace({ existing, name: "impeccable", clonePath: "/clone" })).toEqual({
      name: "imp-x",
      action: "reuse",
    });
  });

  test("reuses an existing marketplace that already owns the derived name (no second registration)", () => {
    const existing = [{ name: "impeccable", root: "/some/other/path" }];
    expect(resolveLocalMarketplace({ existing, name: "impeccable", clonePath: "/clone" })).toEqual({
      name: "impeccable",
      action: "reuse",
    });
  });

  test("adds when no existing marketplace matches by root or name", () => {
    const existing = [{ name: "personal", root: "/Users/me" }];
    expect(resolveLocalMarketplace({ existing, name: "impeccable", clonePath: "/clone" })).toEqual({
      name: "impeccable",
      action: "add",
    });
  });

  test("prefers root match over name match", () => {
    const existing = [
      { name: "impeccable", root: "/other" }, // same name, different path
      { name: "imp-from-clone", root: "/clone" }, // same path
    ];
    expect(resolveLocalMarketplace({ existing, name: "impeccable", clonePath: "/clone" })).toEqual({
      name: "imp-from-clone",
      action: "reuse",
    });
  });
});

describe("localMarketplaceName", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "syncthis-mkt-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("reads the name from .claude-plugin/marketplace.json", async () => {
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "mymkt", plugins: [] }));
    expect(await localMarketplaceName(dir)).toBe("mymkt");
  });

  test("falls back to a root-level marketplace.json", async () => {
    await writeFile(join(dir, "marketplace.json"), JSON.stringify({ name: "rootmkt" }));
    expect(await localMarketplaceName(dir)).toBe("rootmkt");
  });

  test("falls back to the directory basename when no manifest exists", async () => {
    const sub = join(dir, "withgraphite-agent-skills");
    await mkdir(sub, { recursive: true });
    expect(await localMarketplaceName(sub)).toBe("withgraphite-agent-skills");
  });

  test("ignores an unsafe manifest name and falls back to the basename", async () => {
    const sub = join(dir, "safe-name");
    await mkdir(join(sub, ".claude-plugin"), { recursive: true });
    await writeFile(join(sub, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "../evil" }));
    expect(await localMarketplaceName(sub)).toBe("safe-name");
  });
});

describe("readLocalMarketplace", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "syncthis-mkt2-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns the marketplace name and declared plugin entry names", async () => {
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(dir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "openai-plugins", plugins: [{ name: "vercel" }, { name: "stripe" }, { bad: 1 }] }),
    );
    expect(await readLocalMarketplace(dir)).toEqual({ name: "openai-plugins", pluginNames: ["vercel", "stripe"] });
  });

  test("derives the name from the dir and reports no plugins when there is no manifest", async () => {
    const sub = join(dir, "forsvn-skills");
    await mkdir(sub, { recursive: true });
    expect(await readLocalMarketplace(sub)).toEqual({ name: "forsvn-skills", pluginNames: [] });
  });
});
