import { spawn } from "node:child_process";

export type ShellResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  cmd: string;
  notFound: boolean;
  // true when the command was killed by the timeout — lets callers report
  // "timed out after Ns" instead of a confusing generic non-zero/-1 exit.
  timedOut: boolean;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const TIMEOUT_KILL_GRACE_MS = 250;

// Run a subprocess with no shell (args are passed array-style, so a value can
// never be re-interpreted as a flag or shell metacharacter) on plain Node's
// child_process, so the bundled CLI runs under Node without Bun.
export function run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<ShellResult> {
  const display = [cmd, ...args].join(" ");
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });

    const finish = (r: ShellResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(r);
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");

      // A subprocess can trap SIGTERM and keep both its process and stdio open.
      // Bound that grace period, then force termination and settle even if the
      // runtime never emits `close` after the kill request.
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({
          ok: false,
          exitCode: -1,
          stdout,
          stderr: stderr || "killed after timeout (SIGKILL)",
          cmd: display,
          notFound: false,
          timedOut: true,
        });
      }, TIMEOUT_KILL_GRACE_MS);
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.on("data", (d: string) => (stderr += d));

    child.on("error", (err: NodeJS.ErrnoException) => {
      const message = err?.message ?? String(err);
      finish({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: stderr || message,
        cmd: display,
        notFound: err?.code === "ENOENT" || /ENOENT|not found|No such file/i.test(message),
        timedOut,
      });
    });

    child.on("close", (code, signal) => {
      const exitCode = code ?? -1;
      finish({
        ok: exitCode === 0 && !timedOut,
        exitCode,
        stdout,
        stderr: timedOut && !stderr ? `killed after timeout (${signal ?? "SIGTERM"})` : stderr,
        cmd: display,
        notFound: false,
        timedOut,
      });
    });
  });
}

// Split a plugin id of the form "<name>@<marketplace>" into its parts. A leading
// `@` (e.g. npm scope "@scope/pkg") is preserved as part of the name.
export function parsePluginId(id: string): { name: string; marketplace?: string } {
  const at = id.lastIndexOf("@");
  if (at <= 0) return { name: id };
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) };
}

// Some plugin installers sanitize URL-derived Claude ids before storing them on a
// target. Example: Claude can report `github.com-openclaw-agent-skills`, while
// Codex stores the same repo as `github-com-openclaw-agent-skills`. Treat those as
// the same plugin for cross-agent diff/coverage decisions, but keep each agent's
// own stored name for the actual install/uninstall command.
export function pluginIdentityKeys(name: string): string[] {
  const keys = new Set([name]);
  if (name.startsWith("github.com-")) keys.add(name.replace(/\./g, "-"));
  if (name.startsWith("github-com-")) keys.add(name.replace(/^github-com-/, "github.com-"));
  return [...keys];
}

export function pluginNamesOverlap(a: string, b: string): boolean {
  const bKeys = new Set(pluginIdentityKeys(b));
  return pluginIdentityKeys(a).some((k) => bKeys.has(k));
}

// Codex validates the plugin-name portion of `<name>@<marketplace>` more strictly
// than Claude and the open-plugin installer. Keep this target contract separate
// from the broader shell-safety check below: a dot is safe to pass as an argv
// value, but Codex will refuse to discover or load a plugin whose name contains it.
export function isValidCodexPluginName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

// Ordered target-native spellings for a cross-agent plugin identity. Preserve a
// valid source spelling first. URL-derived installer ids are the one intentional
// adaptation: Claude/open-plugin may store `github.com-owner-repo`, while Codex
// requires and historically stores `github-com-owner-repo`.
//
// Every returned candidate is guaranteed to satisfy Codex's identifier grammar.
export function codexPluginIdentityCandidates(name: string): string[] {
  const candidates = new Set<string>();
  if (isValidCodexPluginName(name)) candidates.add(name);
  for (const identity of pluginIdentityKeys(name)) {
    if (isValidCodexPluginName(identity)) candidates.add(identity);
  }
  if (name.startsWith("github.com-")) {
    const adapted = name.replace(/\./g, "-");
    if (isValidCodexPluginName(adapted)) candidates.add(adapted);
  }
  return [...candidates];
}

// Plugin / marketplace names that flow into a CLI invocation must be flat
// identifiers — no path separators, no traversal, no NUL.
export function isSafeIdentifier(name: string): boolean {
  if (!name) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("..")) return false;
  return true;
}

export function assertSafeIdentifier(name: string, label = "name"): void {
  if (!isSafeIdentifier(name)) {
    throw new Error(`${label} contains unsafe characters or path traversal: ${JSON.stringify(name)}`);
  }
}

// A skill name that's safe to pass as a positional/`-s` value to `npx skills
// remove`. Same flat-identifier rules as isSafeIdentifier, plus no leading "-"
// (which the skills CLI would parse as a flag — option injection). Spaces are fine
// (args are passed array-style, no shell), so multi-word skill names are allowed.
export function isSafeSkillName(s: string): boolean {
  return isSafeIdentifier(s) && !s.startsWith("-");
}

// A GitHub-style "owner/repo" slug, the only marketplace source we provision
// from. Strict on purpose: rejects leading "-" (option injection into a CLI),
// URLs, path traversal, and shell metacharacters. Args are passed array-style
// (no shell), but this keeps an adversarial marketplace entry from being treated
// as a flag or anything other than a plain repo.
export function isSafeRepoSlug(s: string): boolean {
  if (s.includes("..")) return false; // no relative/parent paths
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s);
}
