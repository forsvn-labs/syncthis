import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  identifyPluginPackage,
  SYNCTHIS_MARKER,
} from "../src/plugins/source.ts";
import { materializePluginPackage } from "../src/plugins/store.ts";

async function packageFixture(): Promise<{ root: string; store: string }> {
  const root = await mkdtemp(join(tmpdir(), "syncthis-plugin-package-"));
  const store = await mkdtemp(join(tmpdir(), "syncthis-plugin-store-"));
  await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "fixture" }));
  await writeFile(join(root, "payload.bin"), Buffer.from([0, 1, 255, 3]));
  await mkdir(join(root, "nested", "path"), { recursive: true });
  await writeFile(join(root, "nested", "path", "data.txt"), "nested bytes");
  await writeFile(join(root, "run.sh"), "#!/bin/sh\nprintf fixture\n");
  await chmod(join(root, "run.sh"), 0o755);
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "ignored"), "one");
  await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(join(root, "node_modules", "ignored", "package.js"), "one");
  await writeFile(join(root, SYNCTHIS_MARKER), "one");
  return { root, store };
}

describe("plugin package identity", () => {
  test("hashes the complete package deterministically and tracks executable bits", async () => {
    const { root, store } = await packageFixture();
    try {
      const first = await identifyPluginPackage(root);
      const second = await identifyPluginPackage(root);
      expect(second).toEqual(first);

      await writeFile(join(root, ".git", "ignored"), "two");
      await writeFile(join(root, "node_modules", "ignored", "package.js"), "two");
      await writeFile(join(root, SYNCTHIS_MARKER), "two");
      expect((await identifyPluginPackage(root)).fingerprint).toBe(first.fingerprint);

      await writeFile(join(root, "payload.bin"), Buffer.from([0, 1, 255, 4]));
      expect((await identifyPluginPackage(root)).fingerprint).not.toBe(first.fingerprint);

      const changed = (await identifyPluginPackage(root)).fingerprint;
      await chmod(join(root, "payload.bin"), 0o755);
      expect((await identifyPluginPackage(root)).fingerprint).not.toBe(changed);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
    }
  });

  test("requires anchoring plugin.json metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "syncthis-plugin-no-manifest-"));
    try {
      await expect(identifyPluginPackage(root)).rejects.toThrow(/plugin\.json/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when the source root is replaced during a run", async () => {
    const root = await mkdtemp(join(tmpdir(), "syncthis-plugin-source-root-race-"));
    const displaced = `${root}-displaced`;
    try {
      await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "fixture" }));
      await rename(root, displaced);
      await symlink(displaced, root);
      await expect(identifyPluginPackage(root)).rejects.toThrow(/regular directory|symlink/i);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(displaced, { recursive: true, force: true });
    }
  });

  test("fails closed for escaping, cyclic, and non-regular source entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "syncthis-plugin-source-security-"));
    const outside = join(tmpdir(), `syncthis-plugin-source-outside-${process.pid}-${Date.now()}`);
    try {
      await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "fixture" }));
      await writeFile(outside, "outside");
      await symlink(outside, join(root, "escape.txt"));
      await expect(identifyPluginPackage(root)).rejects.toThrow(/outside source root/i);

      await rm(join(root, "escape.txt"));
      await symlink("second", join(root, "first"));
      await symlink("first", join(root, "second"));
      await expect(identifyPluginPackage(root)).rejects.toThrow(/cyclic/i);

      await rm(join(root, "first"));
      await rm(join(root, "second"));
      const fifo = join(root, "payload.fifo");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      await expect(identifyPluginPackage(root)).rejects.toThrow(/unsupported filesystem entry/i);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });
});

describe("content-addressed plugin store", () => {
  test("dry-run is mutation-free, then creates and verifies an immutable snapshot", async () => {
    const { root, store } = await packageFixture();
    try {
      const preview = await materializePluginPackage({
        sourcePluginPath: root,
        storeRoot: store,
        dryRun: true,
      });
      expect(preview.status).toBe("would-create");
      expect(preview.root).toBe(join(store, preview.identity));
      expect(await stat(store).then(() => true)).toBe(true);
      expect((await Bun.file(join(store, preview.identity)).exists())).toBe(false);

      const first = await materializePluginPackage({
        sourcePluginPath: root,
        storeRoot: store,
        dryRun: false,
      });
      expect(first.status).toBe("created");
      expect(first.root).toBe(join(store, first.identity));
      expect(await readFile(join(first.root!, "payload.bin"))).toEqual(
        Buffer.from([0, 1, 255, 3]),
      );
      expect(await readFile(join(first.root!, "nested", "path", "data.txt"), "utf8")).toBe(
        "nested bytes",
      );
      expect((await stat(join(first.root!, "run.sh"))).mode & 0o111).not.toBe(0);

      const second = await materializePluginPackage({
        sourcePluginPath: root,
        storeRoot: store,
        dryRun: false,
      });
      expect(second).toMatchObject({ status: "present", root: first.root, identity: first.identity });

      await writeFile(join(first.root!, "payload.bin"), "tampered");
      await expect(
        materializePluginPackage({ sourcePluginPath: root, storeRoot: store, dryRun: false }),
      ).rejects.toThrow(/tamper|managed|identity/i);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
    }
  });

  test("concurrent materialization has one creator and verifies the shared collision", async () => {
    const { root, store } = await packageFixture();
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          materializePluginPackage({ sourcePluginPath: root, storeRoot: store, dryRun: false }),
        ),
      );
      expect(results.filter((result) => result.status === "created")).toHaveLength(1);
      expect(results.every((result) => result.root === results[0]?.root)).toBe(true);
      expect(await readFile(join(results[0]!.root, "payload.bin"))).toEqual(
        Buffer.from([0, 1, 255, 3]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
    }
  });

  test("refuses an unmanaged deterministic destination", async () => {
    const { root, store } = await packageFixture();
    try {
      const preview = await materializePluginPackage({
        sourcePluginPath: root,
        storeRoot: store,
        dryRun: true,
      });
      const destination = join(store, preview.identity);
      await mkdir(destination);
      await writeFile(join(destination, "user-owned"), "keep");
      await expect(
        materializePluginPackage({ sourcePluginPath: root, storeRoot: store, dryRun: false }),
      ).rejects.toThrow(/unowned|managed|refus/i);
      expect(await readFile(join(destination, "user-owned"), "utf8")).toBe("keep");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
    }
  });
});
