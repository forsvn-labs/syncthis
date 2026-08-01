import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PluginDegradationReport,
} from "../src/plugins/degrade.ts";
import type { PluginInventoryArtifact } from "../src/plugins/inventory.ts";
import type {
  PluginReconcileReport,
  PluginReconcileResult,
} from "../src/plugins/reconcile.ts";
import {
  runSync as runSyncCore,
  type SyncOptions,
} from "../src/sync.ts";
import type { McpServer } from "../src/types.ts";
import { createArtifactKey } from "../src/plugins/artifact-key.ts";

export const STDIO = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_TOKEN: "x" },
} satisfies McpServer;
export const HTTP = {
  type: "http",
  url: "https://mcp.linear.app/sse",
} satisfies McpServer;
export const BIGQUERY = {
  type: "http",
  url: "https://bigquery.googleapis.com/mcp",
} satisfies McpServer;

export type SyncTestEnvironment = {
  workDir: string;
  originalHome: string | undefined;
  originalPath: string | undefined;
  restore(): Promise<void>;
};

export async function setupSyncTestEnvironment(): Promise<SyncTestEnvironment> {
  const workDir = await mkdtemp(join(tmpdir(), "syncthis-"));
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalPath = process.env.PATH;
  process.env.HOME = workDir;
  delete process.env.COPILOT_HOME;
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.XDG_CONFIG_HOME;

  return {
    workDir,
    originalHome,
    originalPath,
    async restore() {
      process.env.HOME = originalHome;
      process.env.PATH = originalPath;
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdg;
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

export function pluginReport(
  results: PluginReconcileResult[] = [],
  artifacts: PluginInventoryArtifact[] = [],
): PluginReconcileReport {
  return {
    dryRun: false,
    inventory: { artifacts, sources: [], errors: [] },
    results,
    failures: results.filter((result) => result.status === "failed"),
    hasFailures: results.some((result) => result.status === "failed"),
    hasChanges: results.some((result) => result.status !== "present"),
  };
}

export function degradationReport(
  results: PluginDegradationReport["results"] = [],
  dryRun = false,
): PluginDegradationReport {
  const failures = results.filter((result) => result.status === "failed");
  return {
    dryRun,
    eligibleOutcomes: [],
    results,
    failures,
    hasFailures: failures.length > 0,
    hasChanges: results.some(
      (result) => result.status === "added" || result.status === "would-add",
    ),
  };
}

export async function degradationArtifact(
  workDir: string,
  options: { skills?: boolean; mcp?: boolean } = {},
): Promise<PluginInventoryArtifact> {
  const root = join(workDir, ".agents", "plugins", "foo");
  await mkdir(join(root, "skills", "foo"), { recursive: true });
  await Bun.write(join(root, "skills", "foo", "SKILL.md"), "---\nname: foo\n---\n");
  if (options.mcp ?? true) {
    await Bun.write(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { bundled: { command: "plugin-mcp" } } }),
    );
  }
  return {
    artifactKey: createArtifactKey({ id: "foo@plugins-cli", root }),
    id: "foo@plugins-cli",
    canonicalName: "foo",
    aliases: ["foo"],
    identityKeys: ["foo"],
    marketplaces: ["plugins-cli"],
    sourceRepo: "owner/foo",
    pluginRoot: root,
    payload: {
      nativeManifest: true,
      skills: options.skills ?? true,
      mcp: options.mcp ?? true,
    },
    installedOn: [],
    activeOn: [],
    configuredOn: ["codex"],
    catalogueOnly: false,
    eligible: true,
    evidence: [
      {
        kind: "plugins-cli-catalogue",
        name: "foo",
        marketplace: "plugins-cli",
        path: root,
      },
    ],
    errors: [],
  };
}

export function eligibleDegradation(
  artifact: PluginInventoryArtifact,
  agent: PluginReconcileResult["agent"] = "gemini-cli",
): PluginReconcileResult {
  return {
    artifactKey: artifact.artifactKey,
    artifactId: artifact.id,
    plugin: artifact.canonicalName,
    agent,
    nativeMode: "none",
    status: "unsupported",
    intent: "install",
    requestedName: artifact.canonicalName,
    degradation: {
      eligible: true,
      reason: "no-native-abi",
      skills: artifact.payload.skills,
      mcp: artifact.payload.mcp,
    },
  };
}

async function noPluginReconciliation(): Promise<PluginReconcileReport> {
  return pluginReport();
}

export function runSync(options: SyncOptions = {}) {
  return runSyncCore({
    ...options,
    reconcilePlugins: options.reconcilePlugins ?? noPluginReconciliation,
  });
}

export async function writeAgentJson(
  workDir: string,
  rel: string,
  mcpServers: Record<string, McpServer>,
  extras: Record<string, unknown> = {},
) {
  const path = join(workDir, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, JSON.stringify({ ...extras, mcpServers }));
}

export async function writeCodexToml(
  workDir: string,
  servers: Record<string, McpServer>,
  extras = "",
) {
  const path = join(workDir, ".codex", "config.toml");
  await mkdir(join(workDir, ".codex"), { recursive: true });
  const blocks: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if ("url" in server) {
      blocks.push(`[mcp_servers.${name}]\nurl = "${server.url}"\n`);
    } else {
      const args = server.args ? `args = ${JSON.stringify(server.args)}\n` : "";
      blocks.push(`[mcp_servers.${name}]\ncommand = "${server.command}"\n${args}`);
    }
  }
  await Bun.write(path, extras + blocks.join("\n"));
}
