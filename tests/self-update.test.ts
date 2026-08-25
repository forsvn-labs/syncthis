import { describe, expect, test } from "bun:test";
import {
  UPDATE_TIMEOUT_MS,
  deriveGlobalPrefix,
  planSelfUpdate,
  resolveSelfUpdateTimeout,
  runSelfUpdate,
} from "../src/self-update.ts";

describe("deriveGlobalPrefix", () => {
  test("unix: Homebrew node prefix (the shadow-install bug)", () => {
    // The exact case that froze the banner at a stale version: PATH ran the Homebrew
    // copy while `npm -g` pointed elsewhere. update must target THIS prefix.
    expect(deriveGlobalPrefix("/opt/homebrew/lib/node_modules/@forsvn/syncthis", "/")).toBe("/opt/homebrew");
  });

  test("unix: version-manager prefix", () => {
    expect(deriveGlobalPrefix("/Users/x/.hermes/node/lib/node_modules/@forsvn/syncthis", "/")).toBe(
      "/Users/x/.hermes/node",
    );
  });

  test("unix: non-scoped package", () => {
    expect(deriveGlobalPrefix("/usr/local/lib/node_modules/syncthis", "/")).toBe("/usr/local");
  });

  test("windows: no lib segment", () => {
    expect(deriveGlobalPrefix("C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@hungv47\\syncthis", "\\")).toBe(
      "C:\\Users\\x\\AppData\\Roaming\\npm",
    );
  });

  test("dev / source run (not inside node_modules) → empty, use npm default", () => {
    expect(deriveGlobalPrefix("/Users/x/dev/syncthis", "/")).toBe("");
  });

  test("the last node_modules wins (nested installs)", () => {
    expect(deriveGlobalPrefix("/a/lib/node_modules/x/node_modules/@forsvn/syncthis", "/")).toBe(
      "/a/lib/node_modules/x",
    );
  });
});

describe("self-update service", () => {
  test("plans deterministic npm and Bun commands without writing", async () => {
    const npm = await planSelfUpdate({
      entryArg: "/missing/source/bin/syncthis.ts",
      userAgent: "npm/11 node/v22",
    });
    expect(npm.command).toEqual({
      cmd: "npm",
      args: ["install", "-g", "@forsvn/syncthis@latest"],
    });

    const bun = await planSelfUpdate({
      entryArg: "/missing/.bun/bin/syncthis",
      userAgent: "bun/1.3.14",
    });
    expect(bun.command).toEqual({
      cmd: "bun",
      args: ["install", "-g", "@forsvn/syncthis@latest"],
    });
  });

  test("executes an injected plan and reports its result", async () => {
    const plan = {
      command: { cmd: process.execPath, args: ["-e", "process.stdout.write('updated')"] },
      display: `${process.execPath} -e update-fixture`,
    };
    const result = await runSelfUpdate({ plan, timeoutMs: 5_000 });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("updated");
    expect(result.message).toBe("updated to latest");
  });

  test("inherited stdio has no default kill timer; pipe stays bounded", () => {
    expect(resolveSelfUpdateTimeout({ stdio: "inherit" })).toBeUndefined();
    expect(resolveSelfUpdateTimeout({ stdio: "pipe" })).toBe(UPDATE_TIMEOUT_MS);
    expect(resolveSelfUpdateTimeout({})).toBe(UPDATE_TIMEOUT_MS);
    expect(resolveSelfUpdateTimeout({ stdio: "inherit", timeoutMs: 1_000 })).toBe(1_000);
    expect(resolveSelfUpdateTimeout({ stdio: "pipe", timeoutMs: 2_000 })).toBe(2_000);
  });

  test("captured/pipe runs still time out when bounded", async () => {
    const plan = {
      command: {
        cmd: process.execPath,
        args: ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)"],
      },
      display: `${process.execPath} -e sleep-fixture`,
    };
    const result = await runSelfUpdate({ plan, stdio: "pipe", timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("timed out after 0.2s");
  });

  test("interactive inherited-stdio still honors an explicit timeout", async () => {
    const plan = {
      command: {
        cmd: process.execPath,
        args: ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)"],
      },
      display: `${process.execPath} -e sleep-fixture`,
    };
    const result = await runSelfUpdate({ plan, stdio: "inherit", timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("timed out after 0.2s");
  });
});
