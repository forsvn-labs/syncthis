import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir, stat, lstat, symlink, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJson, writeJson, readText, writeText, backupIfExists } from "../src/io.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "syncthis-io-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function mode(p: string): Promise<number> {
  return (await stat(p)).mode & 0o777;
}

describe("io write safety", () => {
  test("clamps a new secret-bearing file to 0600 (sacred §4)", async () => {
    const p = join(dir, "cfg.json");
    await writeJson(p, { token: "secret" }, { backup: true });
    expect(await mode(p)).toBe(0o600);
    expect(await readJson<Record<string, unknown>>(p)).toEqual({ token: "secret" });
  });

  test("clamps an existing 0644 file down to 0600 on write", async () => {
    const p = join(dir, "loose.json");
    await writeFile(p, "{}", { mode: 0o644 });
    await chmod(p, 0o644);
    await writeJson(p, { a: 1 }, { backup: true });
    expect(await mode(p)).toBe(0o600);
  });

  test("a pre-existing 0400 file can still be written twice (no EACCES self-lockout)", async () => {
    // Regression for the old `chmod(preserved & 0o600)` path: a 0o400 target became
    // unwritable, so the next sync failed with EACCES. Atomic rename replaces the
    // inode via the (writable) directory, so this must succeed and end at 0600.
    const p = join(dir, "ro.json");
    await writeFile(p, JSON.stringify({ v: 0 }));
    await chmod(p, 0o400);
    await writeJson(p, { v: 1 }, { backup: true });
    expect(await mode(p)).toBe(0o600);
    await writeJson(p, { v: 2 }, { backup: true });
    expect(await readJson<Record<string, unknown>>(p)).toEqual({ v: 2 });
    expect(await mode(p)).toBe(0o600);
  });

  test("leaves no temp files behind after a write", async () => {
    const p = join(dir, "clean.json");
    // fresh file → no backup (sacred §2: backup only when the original existed)
    await writeJson(p, { ok: true }, { backup: true });
    expect((await readdir(dir)).sort()).toEqual(["clean.json"]);
    // rewrite an existing file → backup appears, still no temp left over
    await writeJson(p, { ok: false }, { backup: true });
    const entries = await readdir(dir);
    expect(entries.some((e) => e.includes(".tmp"))).toBe(false);
    expect(entries.sort()).toEqual(["clean.json", "clean.json.syncthis.bak"]);
  });

  test("backup is written once, on first write only (sacred §2)", async () => {
    const p = join(dir, "b.json");
    const bak = `${p}.syncthis.bak`;
    await writeFile(p, JSON.stringify({ original: true }));
    await writeJson(p, { gen: 1 }, { backup: true });
    expect(await readJson<Record<string, unknown>>(bak)).toEqual({ original: true });
    expect(await mode(bak)).toBe(0o600);
    // second write must NOT rotate the original out of the backup
    await writeJson(p, { gen: 2 }, { backup: true });
    expect(await readJson<Record<string, unknown>>(bak)).toEqual({ original: true });
  });

  test("refuses to write through a symlinked target", async () => {
    const real = join(dir, "real.json");
    const link = join(dir, "link.json");
    await writeFile(real, "{}");
    await symlink(real, link);
    await expect(writeJson(link, { x: 1 }, { backup: true })).rejects.toThrow(/symlink/);
    // the symlink target was not modified
    expect(await readJson<Record<string, unknown>>(real)).toEqual({});
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  test("refuses to write a backup through a symlinked .bak", async () => {
    const p = join(dir, "c.json");
    const bak = `${p}.syncthis.bak`;
    const elsewhere = join(dir, "elsewhere.json");
    await writeFile(p, JSON.stringify({ keep: true }));
    await writeFile(elsewhere, "{}");
    await symlink(elsewhere, bak);
    await expect(backupIfExists(p)).rejects.toThrow(/symlink/);
  });

  test("text writes are clamped and round-trip", async () => {
    const p = join(dir, "c.yaml");
    await writeText(p, "k: v\n", { backup: true });
    expect(await mode(p)).toBe(0o600);
    expect(await readText(p)).toBe("k: v\n");
  });

  test("readJson returns null for missing, {} for empty", async () => {
    expect(await readJson<Record<string, unknown>>(join(dir, "nope.json"))).toBeNull();
    const empty = join(dir, "empty.json");
    await writeFile(empty, "   ");
    expect(await readJson<Record<string, unknown>>(empty)).toEqual({});
  });
});
