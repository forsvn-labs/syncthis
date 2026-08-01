import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expandHome } from "../io.ts";
import {
  ManagedMarketplaceUnsupportedFormatError,
  prepareManagedCodexMarketplace,
} from "./managed-marketplace.ts";
import { parseMarketplaceList, readLocalMarketplace, resolveLocalMarketplace } from "./marketplace.ts";
import { findNativePluginManifests, hasSkillManifest } from "./source.ts";
import {
  assertSafeIdentifier,
  codexPluginIdentityCandidates,
  isSafeRepoSlug,
  isValidCodexPluginName,
  parsePluginId,
  pluginNamesOverlap,
  run,
} from "./shell.ts";
import type {
  PluginAdapter,
  PluginAdapterRead,
  PluginInstallOpts,
  PluginInstallResult,
  PluginRecord,
  PluginUninstallOpts,
  PluginUninstallResult,
} from "./types.ts";

function resolvedCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? resolve(expandHome(configured)) : expandHome("~/.codex");
}

function resolvedConfigPath(): string {
  return join(resolvedCodexHome(), "config.toml");
}

// The vercel-labs `npx plugins` marketplace — the cross-agent ecosystem syncthis
// mirrors. Preferred when a bare plugin name is ambiguous across Codex
// marketplaces (e.g. also present in an OpenAI-bundled/curated one).
const PREFERRED_MARKETPLACE = "plugins-cli";

// `codex plugin list` is usually fast, but the default 15s `run()` timeout is too
// tight for a cold CLI start on a loaded machine — a timed-out read would look like
// "no plugins" and silently skip everything. `codex plugin add` may fetch, so longer.
const LIST_TIMEOUT_MS = 60_000;
const ADD_TIMEOUT_MS = 180_000;
// `codex plugin remove` only edits local config + prunes the cache — no fetch — so
// it doesn't need the install path's long fetch headroom, but keep generous slack
// over the cold-start default.
const REMOVE_TIMEOUT_MS = 60_000;

type CodexCols = { plugin: number; status: number; version: number; path: number };

// `codex plugin list` prints a fixed-width table per registered marketplace:
//
//   Marketplace `plugins-cli`
//   /path/to/marketplace.json
//
//   PLUGIN              STATUS              VERSION  PATH
//   foo@plugins-cli     not installed                /cache/foo
//   bar@plugins-cli     installed, enabled  1.2.3    /cache/bar
//
// Column widths vary per section, so we re-derive column offsets from each
// header row and slice data rows by those offsets — STATUS values contain
// spaces ("not installed", "installed, enabled") so naive whitespace splitting
// is wrong.
function headerCols(line: string): CodexCols | null {
  const plugin = line.indexOf("PLUGIN");
  const status = line.indexOf("STATUS");
  const version = line.indexOf("VERSION");
  const path = line.indexOf("PATH");
  if (plugin !== 0 || status < 0 || version < 0 || path < 0) return null;
  return { plugin, status, version, path };
}

type CodexListRow = PluginRecord & { installed: boolean };

// Parse every row of `codex plugin list` (installed AND not-installed), each
// tagged with its marketplace (from the PLUGIN column id) and whether Codex
// actually has it installed. Not-installed rows still tell us which marketplace
// can provide a plugin — needed to resolve a bare name to <name>@<marketplace>
// for `codex plugin add`.
function parseCodexListRows(text: string): CodexListRow[] {
  const out: CodexListRow[] = [];
  let cols: CodexCols | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (line.startsWith("Marketplace ")) {
      cols = null;
      continue;
    }
    const header = headerCols(line);
    if (header) {
      cols = header;
      continue;
    }
    if (!cols) continue; // marketplace path line / pre-header noise
    const id = line.slice(cols.plugin, cols.status).trim();
    const status = line.slice(cols.status, cols.version).trim();
    const version = line.slice(cols.version, cols.path).trim();
    const path = line.slice(cols.path).trim();
    if (!id) continue;
    const installed = /^installed\b/i.test(status); // "installed, enabled" — not "not installed"
    const enabled = !installed ? undefined : /\benabled\b/i.test(status) ? true : /\bdisabled\b/i.test(status) ? false : undefined;
    const { name, marketplace } = parsePluginId(id);
    out.push({ name, marketplace, version: version || undefined, enabled, path: path || undefined, installed });
  }
  return out;
}

// Records for the *installed* plugins only. Codex registers many plugins in
// config/cache that it does not actually load ("not installed"); the only state
// Codex uses is what this table reports as installed, so that is the set we
// treat as present.
export function parseCodexPluginList(text: string): PluginRecord[] {
  return parseCodexListRows(text)
    .filter((r) => r.installed)
    .map((r) => ({ name: r.name, marketplace: r.marketplace, version: r.version, enabled: r.enabled, path: r.path }));
}

// Keys (`name@marketplace`, or bare name) of the *installed* plugins in a snapshot.
// Used to diff before/after a provisioning `npx plugins add`: a multi-plugin repo
// installs its canonical plugin under the repo's own plugin.json name — which may
// differ from the Claude-side name we were asked for (e.g. Claude's
// `github.com-garrytan-gstack` vs the repo's `gstack`). The name we asked for then
// stays unresolvable, but the bundle IS on Codex as a plugin — so the diff, not the
// name lookup, is what tells us the content landed (and that no skills dup is due).
function installedKeys(rows: CodexListRow[]): Set<string> {
  return new Set(rows.filter((r) => r.installed).map((r) => (r.marketplace ? `${r.name}@${r.marketplace}` : r.name)));
}

// Rows matching the target-native spellings of a cross-agent identity, ordered by
// candidate preference and then by the marketplace snapshot's own order.
function identityRows(rows: CodexListRow[], name: string): CodexListRow[] {
  const candidates = codexPluginIdentityCandidates(name);
  return candidates.flatMap((candidate) => rows.filter((r) => r.name === candidate));
}

function chooseIdentityRow(
  rows: CodexListRow[],
  name: string,
  marketplace?: string,
): { row?: CodexListRow; ambiguous?: string[] } {
  const matches = identityRows(rows, name).filter((r) => !marketplace || r.marketplace === marketplace);
  if (matches.length === 0) return {};
  if (marketplace) return { row: matches[0] };

  const byPreferredMarketplace = matches.find((r) => r.marketplace === PREFERRED_MARKETPLACE);
  if (byPreferredMarketplace) return { row: byPreferredMarketplace };

  const marketplaces = [...new Set(matches.map((r) => r.marketplace).filter((m): m is string => !!m))];
  if (marketplaces.length > 1) return { ambiguous: marketplaces };
  return { row: matches[0] };
}

async function verifyInstalled(
  requestedName: string,
  marketplace?: string,
): Promise<{ row?: CodexListRow; error?: string }> {
  const verify = await run("codex", ["plugin", "list"], { timeoutMs: LIST_TIMEOUT_MS });
  if (!verify.ok) {
    return {
      error: `codex plugin list verification failed: ${verify.stderr.trim() || (verify.notFound ? "codex CLI not found" : `exit ${verify.exitCode}`)}`,
    };
  }
  const match = identityRows(parseCodexListRows(verify.stdout || ""), requestedName).find(
    (r) => r.installed && (!marketplace || r.marketplace === marketplace),
  );
  return match ? { row: match } : {};
}

async function configuredPluginIds(): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(resolvedConfigPath(), "utf8");
  } catch {
    return [];
  }
  return [...text.matchAll(/^\s*\[plugins\."([^"]+)"\]\s*$/gm)].map((m) => m[1]!).filter(Boolean);
}

async function configuredInvalidIdentity(name: string): Promise<string | undefined> {
  return (await configuredPluginIds()).find((id) => {
    const parsed = parsePluginId(id);
    return !isValidCodexPluginName(parsed.name) && pluginNamesOverlap(parsed.name, name);
  });
}

// A missing Codex list row is not evidence that a bundle is skills-only: an
// invalid configured identity produces the same symptom. Only use the skills
// fallback when the local source positively contains skills and no plugin
// manifest that Codex/Claude/open-plugin could load or translate.
async function positivelySkillsOnly(sourceClonePath?: string): Promise<boolean> {
  if (!sourceClonePath) return false;
  if ((await findNativePluginManifests(sourceClonePath)).length > 0) return false;
  return hasSkillManifest(sourceClonePath);
}

// `codex plugin add <alias>@<mkt>` fails when the marketplace entry's name differs
// from the underlying plugin.json `name` — the shape of every multi-plugin
// marketplace that aliases one bundle under several discovery names. Claude may
// tolerate the mismatch while Codex rejects it. The alias is covered only when a
// fresh native read proves the canonical sibling active; otherwise it is a hard
// native-format failure, never evidence for loose skills fallback.
function isNameMismatch(stderr: string): boolean {
  return /does not match marketplace plugin name/i.test(stderr);
}

type CodexMarketplaceRegistration = {
  root: string;
  label: "managed" | "local";
};

type CodexNativeInstallPlanBase = {
  target: string;
  pluginName: string;
  marketplaceName?: string;
  registration?: CodexMarketplaceRegistration;
  dryRunMessage: string;
  verificationLabel: "managed plugin" | "plugin";
  handleNameMismatch: boolean;
  coveredByProvision?: string[];
};

type CodexNativeInstallPlan = CodexNativeInstallPlanBase & (
  | { mode: "managed-marketplace" }
  | { mode: "local-marketplace" }
  | { mode: "target-marketplace" }
);

export type CodexInstallPlan =
  | { mode: "result"; result: PluginInstallResult }
  | CodexNativeInstallPlan
  | {
      mode: "provision";
      target: string;
      requestedName: string;
      sourceRepo: string;
      sourceClonePath?: string;
      beforeInstalled: string[];
    };

function installResult(
  target: string,
  status: PluginInstallResult["status"],
  extra: Omit<PluginInstallResult, "agent" | "target" | "status"> = {},
): PluginInstallResult {
  return { agent: "codex", target, status, ...extra };
}

function resultPlan(result: PluginInstallResult): CodexInstallPlan {
  return { mode: "result", result };
}

function failurePlan(target: string, message: string): CodexInstallPlan {
  return resultPlan(installResult(target, "failed", { message }));
}

function nativeInstallPlan(
  mode: CodexNativeInstallPlan["mode"],
  pluginName: string,
  marketplaceName: string | undefined,
  options: Omit<CodexNativeInstallPlan, "mode" | "target" | "pluginName" | "marketplaceName">,
): CodexNativeInstallPlan {
  return {
    mode,
    target: `${pluginName}@${marketplaceName}`,
    pluginName,
    marketplaceName,
    ...options,
  };
}

async function planManagedMarketplace(
  name: string,
  opts: PluginInstallOpts,
): Promise<CodexInstallPlan | undefined> {
  if (!opts.sourcePluginPath) return undefined;

  const managed = await prepareManagedCodexMarketplace({
    originalName: name,
    sourcePluginPath: opts.sourcePluginPath,
    dryRun: opts.dryRun,
  });
  const target = `${managed.pluginName}@${managed.marketplaceName}`;
  const marketplaceList = await run(
    "codex",
    ["plugin", "marketplace", "list"],
    { timeoutMs: LIST_TIMEOUT_MS },
  );
  if (marketplaceList.notFound) return failurePlan(target, "codex CLI not found");
  if (!marketplaceList.ok) {
    return failurePlan(
      target,
      `cannot inspect Codex marketplaces: ${marketplaceList.stderr.trim() || `exit ${marketplaceList.exitCode}`}`,
    );
  }

  const registered = parseMarketplaceList(marketplaceList.stdout || "");
  const managedRoot = resolve(managed.root);
  const byName = registered.find((entry) => entry.name === managed.marketplaceName);
  const byRoot = registered.find((entry) => resolve(entry.root) === managedRoot);
  if (byName && resolve(byName.root) !== managedRoot) {
    return failurePlan(
      target,
      `managed marketplace name collision: ${managed.marketplaceName} already points to ${byName.root}`,
    );
  }
  if (byRoot && byRoot.name !== managed.marketplaceName) {
    return failurePlan(
      target,
      `managed marketplace root is registered under unexpected identity ${byRoot.name}`,
    );
  }
  const needsRegistration = !byName && !byRoot;
  const actions = [
    managed.status === "would-create" ? "would create managed marketplace" : "managed marketplace ready",
    needsRegistration ? "would register it" : "registration already present",
    "would install and verify native activation",
  ];
  return nativeInstallPlan(
    "managed-marketplace",
    managed.pluginName,
    managed.marketplaceName,
    {
      ...(needsRegistration
        ? { registration: { root: managed.root, label: "managed" as const } }
        : {}),
      dryRunMessage: `dry-run (${actions.join("; ")})`,
      verificationLabel: "managed plugin",
      handleNameMismatch: false,
    },
  );
}

async function planLocalMarketplace(
  name: string,
  opts: PluginInstallOpts,
  identityCandidates: string[],
): Promise<CodexInstallPlan | undefined> {
  if (!opts.sourceClonePath) return undefined;

  const marketplace = await readLocalMarketplace(opts.sourceClonePath);
  const pluginName = marketplace?.pluginNames.find((candidate) => identityCandidates.includes(candidate));
  if (!marketplace || !pluginName) return undefined;

  const marketplaceList = await run(
    "codex",
    ["plugin", "marketplace", "list"],
    { timeoutMs: LIST_TIMEOUT_MS },
  );
  const existing = marketplaceList.ok ? parseMarketplaceList(marketplaceList.stdout || "") : [];
  const resolvedMarketplace = resolveLocalMarketplace({
    existing,
    name: marketplace.name,
    clonePath: opts.sourceClonePath,
  });
  const registration =
    resolvedMarketplace.action === "add"
      ? { root: opts.sourceClonePath, label: "local" as const }
      : undefined;
  return nativeInstallPlan(
    "local-marketplace",
    pluginName,
    resolvedMarketplace.name,
    {
      ...(registration ? { registration } : {}),
      dryRunMessage: registration ? "dry-run (would register local marketplace)" : "dry-run",
      verificationLabel: "plugin",
      handleNameMismatch: true,
    },
  );
}

function planTargetMarketplace(
  name: string,
  opts: PluginInstallOpts,
  listOk: boolean,
  listError: string,
  rows: CodexListRow[],
  identityCandidates: string[],
): CodexInstallPlan {
  if (opts.marketplace) {
    return nativeInstallPlan(
      "target-marketplace",
      identityCandidates[0]!,
      opts.marketplace,
      {
        dryRunMessage: "dry-run",
        verificationLabel: "plugin",
        handleNameMismatch: true,
      },
    );
  }
  if (!listOk) {
    return failurePlan(
      name,
      `cannot resolve marketplace — codex plugin list failed: ${listError}`,
    );
  }

  const choice = chooseIdentityRow(rows, name);
  if (choice.row) {
    return nativeInstallPlan(
      "target-marketplace",
      choice.row.name,
      choice.row.marketplace,
      {
        dryRunMessage: "dry-run",
        verificationLabel: "plugin",
        handleNameMismatch: true,
      },
    );
  }
  if (choice.ambiguous) {
    return resultPlan(
      installResult(name, "skipped", {
        message: `ambiguous across Codex marketplaces (${choice.ambiguous.join(", ")}) — pass <name>@<marketplace> to choose`,
      }),
    );
  }
  if (opts.provision && opts.sourceRepo && isSafeRepoSlug(opts.sourceRepo)) {
    return {
      mode: "provision",
      target: `${identityCandidates[0]}@(${opts.sourceRepo})`,
      requestedName: name,
      sourceRepo: opts.sourceRepo,
      sourceClonePath: opts.sourceClonePath,
      beforeInstalled: [...installedKeys(rows)],
    };
  }
  return resultPlan(
    installResult(name, "skipped", {
      message: opts.provision
        ? "no usable source repo to provision from — its marketplace isn't a github owner/repo syncthis can register in Codex"
        : "no registered Codex marketplace provides it (provisioning disabled via --no-provision)",
    }),
  );
}

export async function planCodexPluginInstall(
  name: string,
  opts: PluginInstallOpts,
): Promise<CodexInstallPlan> {
  try {
    assertSafeIdentifier(name, "plugin name");
    if (opts.marketplace) assertSafeIdentifier(opts.marketplace, "marketplace name");

    const identityCandidates = codexPluginIdentityCandidates(name);
    if (identityCandidates.length === 0) {
      return failurePlan(
        name,
        `plugin name cannot be represented by Codex (allowed: ASCII letters, digits, \`_\`, and \`-\`): ${JSON.stringify(name)}`,
      );
    }

    const list = await run("codex", ["plugin", "list"], { timeoutMs: LIST_TIMEOUT_MS });
    if (list.notFound) return failurePlan(name, "codex CLI not found");
    const rows = list.ok ? parseCodexListRows(list.stdout || "") : [];
    const present = identityRows(rows, name).find(
      (row) => row.installed && (!opts.marketplace || row.marketplace === opts.marketplace),
    );
    if (present) {
      return resultPlan(
        installResult(
          present.marketplace ? `${present.name}@${present.marketplace}` : present.name,
          "present",
        ),
      );
    }

    const managed = await planManagedMarketplace(name, opts);
    if (managed) return managed;
    const local = await planLocalMarketplace(name, opts, identityCandidates);
    if (local) return local;
    return planTargetMarketplace(
      name,
      opts,
      list.ok,
      list.stderr.trim() || `exit ${list.exitCode}`,
      rows,
      identityCandidates,
    );
  } catch (err) {
    if (err instanceof ManagedMarketplaceUnsupportedFormatError) {
      return resultPlan(
        installResult(name, "skipped", {
          message: err.message,
          unsupportedFormat: true,
        }),
      );
    }
    return failurePlan(name, err instanceof Error ? err.message : String(err));
  }
}

async function planAfterProvision(
  plan: Extract<CodexInstallPlan, { mode: "provision" }>,
): Promise<CodexInstallPlan> {
  const provision = await run(
    "npx",
    ["plugins", "add", plan.sourceRepo, "--target", "codex", "-y"],
    { timeoutMs: 180_000 },
  );
  if (provision.notFound) {
    return resultPlan(
      installResult(plan.requestedName, "skipped", {
        message: "cannot provision — `npx plugins` not found",
      }),
    );
  }
  if (!provision.ok) {
    return failurePlan(
      plan.requestedName,
      `provision failed (npx plugins add ${plan.sourceRepo}): ${provision.stderr.trim() || `exit ${provision.exitCode}`}`,
    );
  }

  const freshList = await run("codex", ["plugin", "list"], { timeoutMs: LIST_TIMEOUT_MS });
  if (!freshList.ok) {
    return failurePlan(
      plan.requestedName,
      `provisioned, but verify failed (codex plugin list): ${freshList.stderr.trim() || `exit ${freshList.exitCode}`}`,
    );
  }

  const rows = parseCodexListRows(freshList.stdout || "");
  const newlyInstalled = [...installedKeys(rows)].filter(
    (key) => !plan.beforeInstalled.includes(key),
  );
  const installed = identityRows(rows, plan.requestedName).find((row) => row.installed);
  if (installed) {
    return resultPlan(
      installResult(
        installed.marketplace ? `${installed.name}@${installed.marketplace}` : installed.name,
        "installed",
      ),
    );
  }

  const choice = chooseIdentityRow(rows, plan.requestedName);
  if (choice.row) {
    return nativeInstallPlan(
      "target-marketplace",
      choice.row.name,
      choice.row.marketplace,
      {
        dryRunMessage: "dry-run",
        verificationLabel: "plugin",
        handleNameMismatch: true,
        coveredByProvision: newlyInstalled,
      },
    );
  }
  if (choice.ambiguous) {
    return resultPlan(
      installResult(plan.requestedName, "skipped", {
        message: `ambiguous across Codex marketplaces (${choice.ambiguous.join(", ")}) — pass <name>@<marketplace> to choose`,
      }),
    );
  }
  if (newlyInstalled.length > 0) {
    return resultPlan(
      installResult(plan.requestedName, "skipped", {
        coveredBy: newlyInstalled.join(", "),
        message: `covered — provisioning ${plan.sourceRepo} installed ${newlyInstalled.join(", ")} as a Codex plugin`,
      }),
    );
  }

  const invalidConfigured = await configuredInvalidIdentity(plan.requestedName);
  if (invalidConfigured) {
    return failurePlan(
      plan.requestedName,
      `provisioning wrote \`${invalidConfigured}\`, but Codex rejects that plugin identity ` +
        "(allowed: ASCII letters, digits, `_`, and `-`); the bundle was not installed and is not classified as skills-only",
    );
  }
  if (await positivelySkillsOnly(plan.sourceClonePath)) {
    return resultPlan(
      installResult(plan.requestedName, "skipped", {
        message: "source positively contains skills but no plugin manifest — adding its skills to Codex instead",
        skillsFallbackRepo: plan.sourceRepo,
      }),
    );
  }
  return failurePlan(
    plan.requestedName,
    "provisioning exited successfully, but a fresh `codex plugin list` exposed no loadable plugin; " +
      "refusing to misclassify a configured, invalid, or unloadable plugin as skills-only",
  );
}

async function registerInstallVerify(
  plan: CodexNativeInstallPlan,
  dryRun: boolean,
): Promise<PluginInstallResult> {
  if (dryRun) return installResult(plan.target, "installed", { message: plan.dryRunMessage });

  if (plan.registration) {
    const registration = await run(
      "codex",
      ["plugin", "marketplace", "add", plan.registration.root],
      { timeoutMs: ADD_TIMEOUT_MS },
    );
    if (registration.notFound) return installResult(plan.target, "failed", { message: "codex CLI not found" });
    if (!registration.ok) {
      return installResult(plan.target, "failed", {
        message:
          `register ${plan.registration.label} marketplace failed: ` +
          (registration.stderr.trim() || `exit ${registration.exitCode}`),
      });
    }
  }

  const add = await run("codex", ["plugin", "add", "--", plan.target], {
    timeoutMs: ADD_TIMEOUT_MS,
  });
  if (add.notFound) return installResult(plan.target, "failed", { message: "codex CLI not found" });
  if (!add.ok) {
    if (plan.handleNameMismatch && isNameMismatch(add.stderr)) {
      const canonical = add.stderr.match(/plugin\.json name [`'"]([^`'"]+)[`'"]/i)?.[1];
      const verifiedCanonical = canonical ? await verifyInstalled(canonical) : {};
      const coveredBy = canonical && verifiedCanonical.row
        ? canonical
        : plan.coveredByProvision?.length
          ? plan.coveredByProvision.join(", ")
          : undefined;
      if (coveredBy) {
        return installResult(plan.target, "skipped", {
          coveredBy,
          message:
            `covered by the bundle's canonical plugin${canonical ? ` \`${canonical}\`` : ""} ` +
            "on Codex — not re-added as skills",
        });
      }
      return installResult(plan.target, "failed", {
        message:
          `Codex rejected \`${plan.pluginName}\` because its plugin.json declares a different name` +
          (canonical ? ` (\`${canonical}\`)` : "") +
          "; this is an unloadable native plugin, not a skills-only bundle",
      });
    }
    return installResult(plan.target, "failed", {
      message: add.stderr.trim() || `exit ${add.exitCode}`,
    });
  }

  const verified = await verifyInstalled(plan.pluginName, plan.marketplaceName);
  if (verified.error) return installResult(plan.target, "failed", { message: verified.error });
  if (!verified.row) {
    return installResult(plan.target, "failed", {
      message:
        "codex plugin add exited successfully, but a fresh `codex plugin list` did not report " +
        `the ${plan.verificationLabel} installed`,
    });
  }
  return installResult(
    `${verified.row.name}@${verified.row.marketplace ?? plan.marketplaceName}`,
    "installed",
  );
}

async function executeCodexInstallPlan(
  plan: CodexInstallPlan,
  dryRun: boolean,
): Promise<PluginInstallResult> {
  if (plan.mode === "result") return plan.result;
  if (plan.mode === "provision") {
    if (dryRun) {
      return installResult(plan.target, "installed", {
        message: "dry-run (would provision)",
      });
    }
    return executeCodexInstallPlan(await planAfterProvision(plan), false);
  }
  return registerInstallVerify(plan, dryRun);
}

export const codexPluginAdapter: PluginAdapter = {
  id: "codex",
  configPath: resolvedConfigPath,
  async read(): Promise<PluginAdapterRead> {
    const base: PluginAdapterRead = {
      agent: "codex",
      configPath: resolvedConfigPath(),
      exists: false,
      plugins: [],
    };

    const res = await run("codex", ["plugin", "list"], { timeoutMs: LIST_TIMEOUT_MS });
    if (res.notFound) return { ...base, error: "codex CLI not found on PATH" };
    if (!res.ok) return { ...base, error: res.stderr.trim() || `codex plugin list exit ${res.exitCode}` };

    return { ...base, exists: true, plugins: parseCodexPluginList(res.stdout || "") };
  },

  async installPlugin(name: string, opts: PluginInstallOpts): Promise<PluginInstallResult> {
    return executeCodexInstallPlan(await planCodexPluginInstall(name, opts), opts.dryRun);
  },

  async previewInstallPlugin(
    name: string,
    opts: PluginInstallOpts,
  ): Promise<PluginInstallResult> {
    return codexPluginAdapter.installPlugin(name, { ...opts, dryRun: true });
  },

  // Guarded uninstall — reached only by `syncthis plugin rm`. Reads install truth
  // from `codex plugin list` first: an absent plugin is a no-op, and the installed
  // marketplace is resolved from the snapshot (`codex plugin remove` needs
  // <name>@<marketplace>, and the agent-local marketplace tag isn't known up front).
  async uninstallPlugin(name: string, opts: PluginUninstallOpts): Promise<PluginUninstallResult> {
    try {
      assertSafeIdentifier(name, "plugin name");
      if (opts.marketplace) assertSafeIdentifier(opts.marketplace, "marketplace name");
    } catch (err) {
      return { agent: "codex", target: name, status: "failed", message: (err as Error).message };
    }

    const listRes = await run("codex", ["plugin", "list"], { timeoutMs: LIST_TIMEOUT_MS });
    if (listRes.notFound) return { agent: "codex", target: name, status: "failed", message: "codex CLI not found" };
    const rows = listRes.ok ? parseCodexListRows(listRes.stdout || "") : [];

    const installed = rows.filter(
      (r) => r.installed && pluginNamesOverlap(r.name, name) && (!opts.marketplace || r.marketplace === opts.marketplace),
    );
    if (installed.length === 0) {
      return { agent: "codex", target: opts.marketplace ? `${name}@${opts.marketplace}` : name, status: "absent" };
    }

    let marketplace = opts.marketplace;
    if (!marketplace) {
      const mkts = [...new Set(installed.map((r) => r.marketplace).filter((m): m is string => !!m))];
      if (mkts.length === 1) marketplace = mkts[0];
      else if (mkts.length > 1) {
        return {
          agent: "codex",
          target: name,
          status: "skipped",
          message: `installed under multiple marketplaces (${mkts.join(", ")}) — pass <name>@<marketplace> to choose`,
        };
      }
    }

    const installedName = installed[0]?.name ?? name;
    const target = marketplace ? `${installedName}@${marketplace}` : installedName;
    if (opts.dryRun) return { agent: "codex", target, status: "uninstalled", message: "dry-run" };
    const res = await run("codex", ["plugin", "remove", "--", target], { timeoutMs: REMOVE_TIMEOUT_MS });
    if (res.notFound) return { agent: "codex", target, status: "failed", message: "codex CLI not found" };
    if (!res.ok) return { agent: "codex", target, status: "failed", message: res.stderr.trim() || `exit ${res.exitCode}` };
    return { agent: "codex", target, status: "uninstalled" };
  },
};
