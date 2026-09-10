import { claudePluginAdapter } from "./claude.ts";
import { copilotPluginAdapter } from "./copilot.ts";
import { codexPluginAdapter } from "./codex.ts";
import { grokPluginAdapter } from "./grok.ts";
import type { PluginAdapter, PluginAdapterRead } from "./types.ts";

// Readable native plugin targets proven by installed CLI contracts.
// Grok Build enters this registry on proven `grok plugin` CLI evidence —
// readable JSON state, fresh read-back, exact translation — because xAI's
// official documentation describes it as a Claude Code-lineage CLI and does
// NOT claim agent-plugins.org or root plugin.json conformance. Kimi has no
// proven non-interactive native plugin ABI in the supported toolchain,
// so it deliberately remains outside this registry and receives exact per-artifact
// skills/MCP degradation. Cursor accepts the root Agent Plugins manifest natively
// today, but Syncthis has no integrated verified native read/read-back for it,
// so Cursor stays write-only and is handled separately.
export const pluginAdapters: PluginAdapter[] = [
  claudePluginAdapter,
  codexPluginAdapter,
  copilotPluginAdapter,
  grokPluginAdapter,
];

export async function listPlugins(): Promise<PluginAdapterRead[]> {
  return Promise.all(pluginAdapters.map((a) => a.read()));
}
