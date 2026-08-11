export const HELP = `Plugins Fleet (syncthis) — install a plugin once. Use it everywhere.

usage:
  syncthis                          interactive Plugins Fleet (or this help if non-TTY)
  syncthis sync [--dry-run]         discover and reconcile installed plugins everywhere
  syncthis plugins list              read-only native plugin overview
  syncthis plugins rm <name…> --all | --agents <a,b,c> [--yes] [--dry-run] [--keep-data]
                                     guarded plugin removal
  syncthis doctor                    read-only plugin overview
  syncthis update [--dry-run]        update the syncthis executable
  syncthis version                   print the installed version
  syncthis help                      this message

flags:
  --dry-run       report plugin-target outcomes without writing.
  --all           select every supported target for removal.
  --agents <list> select comma-separated targets for removal.
  --keep-data     keep Claude plugin data on uninstall.
  --yes           skip confirmation prompts for destructive removal.

compatibility:
  Plugins Fleet is a user-facing rebrand; the syncthis CLI, npm package,
  configuration, environment, and backup identifiers remain unchanged.

plugin-target outcomes:
  native · adapted · partial · blocked · unsupported
`;

export const PLUGINS_HELP = `Plugins Fleet — manage plugins across agents

  syncthis plugins list              read-only native plugin overview
  syncthis plugins rm <name…> --all | --agents <a,b,c>
                                     guarded plugin removal

Plugins Fleet discovers installed plugins from every readable native source and
reconciles them across supported targets. Each plugin-target reports exactly one
of: native, adapted, partial, blocked, unsupported.

Compatibility: the executable and command surface remain syncthis; the npm
package remains @hungv47/syncthis. Existing config, environment, and backup
identifiers are unchanged.`;

// Retained for the callable top-level add compatibility alias. It is intentionally
// not included in HELP or PLUGINS_HELP.
export const ADD_HELP = `Plugins Fleet add — compatibility alias for plugin add

  syncthis add <name…> --all | --agents <a,b,c> [--from <primary>] [--dry-run]
                                     add selected plugins to selected targets
`;

export const PLUGIN_ONLY_ADD_MESSAGE =
  "Plugins Fleet only adds plugins; use `syncthis plugins add` for a bounded compatibility add.";
