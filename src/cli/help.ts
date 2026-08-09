export const HELP = `syncthis — install a plugin once. Use it everywhere.

usage:
  syncthis                          interactive Plugin Sync (or this help if non-TTY)
  syncthis sync [--dry-run]         discover and reconcile installed plugins everywhere
  syncthis plugins list              read-only native plugin overview
  syncthis plugins rm <name…> --all | --agents <a,b,c> [--yes] [--dry-run] [--keep-data]
                                     guarded plugin removal
  syncthis doctor                    read-only plugin overview
  syncthis update [--dry-run]        update syncthis itself
  syncthis version                   print the installed version
  syncthis help                      this message

flags:
  --dry-run       report plugin-target outcomes without writing.
  --all           select every supported target for removal.
  --agents <list> select comma-separated targets for removal.
  --keep-data     keep Claude plugin data on uninstall.
  --yes           skip confirmation prompts for destructive removal.

plugin-target outcomes:
  native · adapted · partial · blocked · unsupported
`;

export const PLUGINS_HELP = `syncthis plugins — manage plugins across agents

  syncthis plugins list              read-only native plugin overview
  syncthis plugins rm <name…> --all | --agents <a,b,c>
                                     guarded plugin removal

Plugin Sync discovers installed plugins from every readable native source and
reconciles them across supported targets. Each plugin-target reports exactly one
of: native, adapted, partial, blocked, unsupported.`;

// Retained for the callable top-level add compatibility alias. It is intentionally
// not included in HELP or PLUGINS_HELP.
export const ADD_HELP = `syncthis add — compatibility alias for plugin add

  syncthis add <name…> --all | --agents <a,b,c> [--from <primary>] [--dry-run]
                                     add selected plugins to selected targets
`;

export const PLUGIN_ONLY_ADD_MESSAGE =
  "syncthis only adds plugins; use `syncthis plugins add` for a bounded compatibility add.";
