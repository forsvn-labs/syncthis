// Unified plugin overview — readable native plugin state from plugin-capable agents.
// Cursor is write-only and is rendered separately by callers; it is never represented
// here as installed state because its native state cannot be verified.

import { listPlugins } from "./index.ts";
import type { PluginAdapterRead } from "./types.ts";

export type PluginOverview = {
  native: PluginAdapterRead[];
};

export async function buildPluginOverview(): Promise<PluginOverview> {
  return { native: await listPlugins() };
}
