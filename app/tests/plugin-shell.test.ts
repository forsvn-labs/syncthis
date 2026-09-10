import { expect, test } from "bun:test";
import { run } from "../src/plugins/shell.ts";

test("run force-kills and settles when a timed-out child ignores SIGTERM", async () => {
  const startedAt = performance.now();
  const result = await run(
    process.execPath,
    [
      "-e",
      [
        'process.on("SIGTERM", () => {});',
        'process.stdout.write("ready\\n");',
        "setInterval(() => {}, 1_000);",
      ].join(""),
    ],
    { timeoutMs: 500 },
  );

  expect(result).toMatchObject({
    ok: false,
    exitCode: -1,
    notFound: false,
    timedOut: true,
  });
  expect(result.stdout).toContain("ready");
  expect(result.stderr).toContain("SIGKILL");
  expect(performance.now() - startedAt).toBeLessThan(2_000);
}, 3_000);
