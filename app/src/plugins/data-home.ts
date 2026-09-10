// The one canonical Syncthis data-root resolver.
//
// Precedence: SYNCTHIS_DATA_HOME, then XDG_DATA_HOME, then the platform
// default (~/.local/share). `~` and `~/…` spellings expand against HOME, and
// relative configured values resolve against HOME too. Every PLUGIN_DATA /
// package-store location derives from this single root so previews compute
// exactly what applies create.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function resolveSyncthisDataHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = resolve(env.HOME ?? homedir());
  const configured = env.SYNCTHIS_DATA_HOME?.trim() || env.XDG_DATA_HOME?.trim();
  const expanded =
    configured === "~"
      ? home
      : configured?.startsWith("~/")
        ? join(home, configured.slice(2))
        : configured;
  return expanded
    ? isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(home, expanded)
    : join(home, ".local", "share");
}
