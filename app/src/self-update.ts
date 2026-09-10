// Self-update prefix resolution.
//
// `syncthis update` must refresh the copy that is actually on your PATH. A plain
// `npm install -g` installs into npm's *default* global prefix, which on a machine
// with more than one Node prefix (e.g. a Homebrew node on PATH while `npm -g`
// points at a version-manager prefix) is NOT where the running binary lives — so
// the update lands in a copy you never run and the version stays stale every
// release. The fix is to pin npm to the prefix that owns the running bundle via
// `--prefix`, derived here from that bundle's on-disk location.

import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, sep as osSep } from "node:path";
import { fileURLToPath } from "node:url";

export const SELF_PACKAGE = "@forsvn/syncthis";
export const UPDATE_TIMEOUT_MS = 300_000;

/**
 * Captured/pipe runs (TUI, tests) stay bounded by UPDATE_TIMEOUT_MS.
 * Interactive inherited-stdio updates have no default watchdog — npm/bun may
 * wait on auth or a slow network — unless the caller passes timeoutMs.
 */
export function resolveSelfUpdateTimeout(options: {
  stdio?: "inherit" | "pipe";
  timeoutMs?: number;
} = {}): number | undefined {
  if (options.timeoutMs !== undefined) return options.timeoutMs;
  return (options.stdio ?? "pipe") === "inherit" ? undefined : UPDATE_TIMEOUT_MS;
}

// Given the on-disk package root of a global install — `<prefix>/lib/node_modules/
// @scope/pkg` on unix, `<prefix>/node_modules/@scope/pkg` on Windows — return the
// global PREFIX npm associates with it, so `npm install -g --prefix <p>` updates
// exactly this copy. Returns "" when the path isn't inside a node_modules (a dev or
// source run), signalling "fall back to npm's default global".
export function deriveGlobalPrefix(packageRoot: string, sep: string = osSep): string {
  const parts = packageRoot.split(sep);
  const nm = parts.lastIndexOf("node_modules");
  if (nm <= 0) return "";
  // unix nests globals under `<prefix>/lib/node_modules`; Windows uses
  // `<prefix>/node_modules` directly. Drop the `lib` segment only when present.
  const end = parts[nm - 1] === "lib" ? nm - 1 : nm;
  return parts.slice(0, end).join(sep);
}

export type SelfUpdatePlan = {
  command: { cmd: string; args: string[] };
  display: string;
  packageRoot?: string;
  before?: string;
};

export type SelfUpdateResult = {
  ok: boolean;
  exitCode: number;
  plan: SelfUpdatePlan;
  after?: string;
  message: string;
  stdout: string;
  stderr: string;
};

async function readVersionAt(dir: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : undefined;
  } catch {
    return undefined;
  }
}

export async function readPackageVersion(moduleUrl: string = import.meta.url): Promise<string> {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 5; i++) {
    const version = await readVersionAt(dir);
    if (version) return version;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}

async function runningInstall(
  moduleUrl: string,
  entryArg: string | undefined,
): Promise<{ packageRoot: string; prefix: string } | null> {
  let dir = entryArg
    ? dirname(await realpath(entryArg).catch(() => entryArg))
    : dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 7; i++) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: unknown };
      if (pkg.name === SELF_PACKAGE) {
        const prefix = deriveGlobalPrefix(dir);
        return prefix ? { packageRoot: dir, prefix } : null;
      }
    } catch {
      // The published bundle starts below the package root; keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function planSelfUpdate(options: {
  moduleUrl?: string;
  entryArg?: string;
  userAgent?: string;
} = {}): Promise<SelfUpdatePlan> {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const entryArg = options.entryArg ?? process.argv[1];
  const running = await runningInstall(moduleUrl, entryArg);
  const entry = entryArg ? await realpath(entryArg).catch(() => entryArg) : "";
  const userAgent = options.userAgent ?? process.env.npm_config_user_agent ?? "";
  const prefersBun = userAgent.startsWith("bun/") || entry.includes("/.bun/") || entry.includes("\\.bun\\");
  const command = prefersBun
    ? { cmd: "bun", args: ["install", "-g", `${SELF_PACKAGE}@latest`] }
    : {
        cmd: "npm",
        args: [
          "install",
          "-g",
          `${SELF_PACKAGE}@latest`,
          ...(running?.prefix ? ["--prefix", running.prefix] : []),
        ],
      };
  return {
    command,
    display: [command.cmd, ...command.args].join(" "),
    packageRoot: running?.packageRoot,
    before: running ? await readVersionAt(running.packageRoot) : undefined,
  };
}

export function runSelfUpdate(options: {
  plan: SelfUpdatePlan;
  stdio?: "inherit" | "pipe";
  timeoutMs?: number;
}): Promise<SelfUpdateResult> {
  const { plan } = options;
  const stdio = options.stdio ?? "pipe";
  const timeoutMs = resolveSelfUpdateTimeout({ stdio, timeoutMs: options.timeoutMs });
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(plan.command.cmd, plan.command.args, {
      stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    if (stdio === "pipe") {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => (stdout += chunk));
      child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    }
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            forceKillTimer = setTimeout(() => {
              if (settled) return;
              child.kill("SIGKILL");
              void finish(-1);
            }, 1_000);
          }, timeoutMs);
    const finish = async (exitCode: number, notFound = false, error?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const after = plan.packageRoot ? await readVersionAt(plan.packageRoot) : undefined;
      const ok = exitCode === 0 && !timedOut;
      const message = ok
        ? after
          ? plan.before && plan.before !== after
            ? `updated ${plan.before} → ${after}`
            : `now at ${after}`
          : "updated to latest"
        : notFound
          ? `${plan.command.cmd} not found on PATH`
          : timedOut
            ? `timed out after ${(timeoutMs ?? 0) / 1000}s`
            : error || stderr.trim() || `exit ${exitCode}`;
      resolve({ ok, exitCode, plan, after, message, stdout, stderr });
    };
    child.on("error", (err: NodeJS.ErrnoException) => {
      void finish(-1, err.code === "ENOENT", err.message);
    });
    child.on("close", (code) => {
      void finish(code ?? -1);
    });
  });
}
