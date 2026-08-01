import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLocalPluginSource } from "../src/plugins/local-source.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-local-plugin-source-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("local plugin source validation", () => {
  test("returns the canonical root when a readable native manifest is required", async () => {
    const source = join(workDir, "plugin");
    await mkdir(join(source, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(source, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "foo" }),
    );

    expect(
      String(
        await validateLocalPluginSource(source, {
          requireNativeManifest: true,
        }),
      ),
    ).toBe(await realpath(source));
  });

  test("accepts a local marketplace directory when no native manifest is required", async () => {
    const source = join(workDir, "marketplace");
    await mkdir(source);

    expect(String(await validateLocalPluginSource(source))).toBe(
      await realpath(source),
    );
  });

  test("rejects option-like, relative, parent-segment, and manifestless sources", async () => {
    const source = join(workDir, "plugin");
    await mkdir(source);

    await expect(validateLocalPluginSource("--target")).rejects.toThrow(/option/i);
    await expect(validateLocalPluginSource("plugin")).rejects.toThrow(/absolute/i);
    await expect(
      validateLocalPluginSource(`${source}/../plugin`),
    ).rejects.toThrow(/must not contain '\.\.'/i);
    await expect(
      validateLocalPluginSource(source, { requireNativeManifest: true }),
    ).rejects.toThrow(/readable native plugin manifest/i);
  });

  test("rejects a top-level symlink before resolving its target", async () => {
    const source = join(workDir, "plugin");
    const link = join(workDir, "plugin-link");
    await mkdir(source);
    await symlink(source, link, "dir");

    await expect(validateLocalPluginSource(link)).rejects.toThrow(/symlink/i);
  });
});
