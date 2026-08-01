import { claudePluginAdapter } from "./claude.ts";
import { copilotPluginAdapter } from "./copilot.ts";
import { codexPluginAdapter } from "./codex.ts";
import type { PluginAdapter, PluginAdapterRead } from "./types.ts";

// Readable native plugin targets proven by installed CLI contracts.
// Kimi has no proven non-interactive native plugin ABI in the supported toolchain,
// so it deliberately remains outside this registry and receives exact per-artifact
// skills/MCP degradation. Cursor remains write-only and is handled separately.
export const pluginAdapters: PluginAdapter[] = [
  claudePluginAdapter,
  codexPluginAdapter,
  copilotPluginAdapter,
];

export async function listPlugins(): Promise<PluginAdapterRead[]> {
  return Promise.all(pluginAdapters.map((a) => a.read()));
}
