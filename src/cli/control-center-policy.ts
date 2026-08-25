// Pure control-center screen and input policy.
//
// The Ink component renders; this module decides. Every key press is resolved
// against an explicit snapshot of the current screen state, so key policy never
// depends on report shape, a loading spinner cannot race a destructive action,
// and an error banner gates every stale action except back/cancel.

export type ControlCenterScreen =
  | "home"
  | "overview"
  | "sync-preview"
  | "sync-confirm"
  | "sync-result"
  | "doctor"
  | "remove-plugins"
  | "remove-scope"
  | "remove-agents"
  | "remove-preview"
  | "remove-confirm"
  | "remove-result"
  | "update"
  | "update-confirm";

export type ControlCenterKey = {
  input: string;
  escape?: boolean;
  return?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
};

/** Everything the key policy needs to know about the live component state. */
export type ControlCenterSnapshot = {
  screen: ControlCenterScreen;
  cursor: number;
  offset: number;
  loading: boolean;
  hasError: boolean;
  menuLength: number;
  listLength: number;
  selectedCount: number;
  /** A dry-run preview report exists for the sync-preview screen. */
  syncPreviewReady: boolean;
  /** Apply may be offered: only from a ready, successful, changed dry-run preview. */
  syncApplyAvailable: boolean;
  removePreviewReady: boolean;
  removeApplyAvailable: boolean;
  updatePlanReady: boolean;
  updateCompleted: boolean;
};

export type ControlCenterTask =
  | "preview-sync"
  | "apply-sync"
  | "doctor"
  | "preview-removal-all"
  | "preview-removal-agents"
  | "apply-removal"
  | "plan-update"
  | "apply-update";

export type ControlCenterCommand =
  | { type: "exit" }
  | { type: "navigate"; screen: ControlCenterScreen }
  | { type: "set-cursor"; value: number }
  | { type: "move-cursor"; delta: -1 | 1; wrap: boolean }
  | { type: "scroll"; delta: -1 | 1 }
  | { type: "toggle-list-item"; index: number }
  | { type: "toggle-keep-data" }
  | { type: "activate-menu"; index: number }
  | { type: "run"; task: ControlCenterTask };

const SCROLL_SCREENS: ReadonlySet<ControlCenterScreen> = new Set([
  "overview",
  "sync-preview",
  "sync-result",
  "doctor",
  "remove-preview",
  "remove-result",
  "update",
]);

function backCommand(screen: ControlCenterScreen): ControlCenterCommand {
  return screen === "home" ? { type: "exit" } : { type: "navigate", screen: "home" };
}

/**
 * Resolve one key against the snapshot. Returns the command to execute, or
 * undefined when the key is inert (loading, gated by an error banner, or not
 * bound on the active screen).
 */
export function handleControlCenterKey(
  snapshot: ControlCenterSnapshot,
  key: ControlCenterKey,
): ControlCenterCommand | undefined {
  const goBack = () => backCommand(snapshot.screen);
  if (snapshot.loading) return undefined;

  // Back/cancel always works; everything else is gated while an error banner
  // shows so no stale preview or plan can be acted on.
  if (key.escape || key.input === "b") return goBack();
  if (snapshot.hasError) return undefined;

  const up = key.upArrow || key.input === "k";
  const down = key.downArrow || key.input === "j";

  switch (snapshot.screen) {
    case "home": {
      if (up) return { type: "move-cursor", delta: -1, wrap: true };
      if (down) return { type: "move-cursor", delta: 1, wrap: true };
      if (key.return) {
        if (snapshot.cursor >= snapshot.menuLength) return undefined;
        return { type: "activate-menu", index: snapshot.cursor };
      }
      if (key.input === "q") return { type: "exit" };
      return undefined;
    }
    case "overview":
    case "doctor":
    case "sync-result":
      if (up) return { type: "scroll", delta: -1 };
      if (down) return { type: "scroll", delta: 1 };
      return undefined;
    case "sync-preview": {
      if (up) return { type: "scroll", delta: -1 };
      if (down) return { type: "scroll", delta: 1 };
      // Apply is offered only from the dry-run preview state. There is no
      // post-apply apply binding anywhere: the result screen never re-offers it.
      if (key.input === "a") {
        return snapshot.syncApplyAvailable ? { type: "navigate", screen: "sync-confirm" } : undefined;
      }
      return undefined;
    }
    case "sync-confirm":
      if (key.input === "y") return { type: "run", task: "apply-sync" };
      if (key.input === "n") return { type: "navigate", screen: "sync-preview" };
      return undefined;
    case "remove-plugins":
      if (up) return { type: "move-cursor", delta: -1, wrap: false };
      if (down) return { type: "move-cursor", delta: 1, wrap: false };
      if (key.input === " ") return { type: "toggle-list-item", index: snapshot.cursor };
      if (key.return && snapshot.selectedCount > 0) return { type: "navigate", screen: "remove-scope" };
      return undefined;
    case "remove-scope":
      if (up || down || key.input === "j" || key.input === "k") {
        return { type: "set-cursor", value: snapshot.cursor === 0 ? 1 : 0 };
      }
      if (key.return) {
        return snapshot.cursor === 0
          ? { type: "run", task: "preview-removal-all" }
          : { type: "navigate", screen: "remove-agents" };
      }
      return undefined;
    case "remove-agents":
      if (up) return { type: "move-cursor", delta: -1, wrap: false };
      if (down) return { type: "move-cursor", delta: 1, wrap: false };
      if (key.input === " ") return { type: "toggle-list-item", index: snapshot.cursor };
      if (key.return && snapshot.selectedCount > 0) return { type: "run", task: "preview-removal-agents" };
      return undefined;
    case "remove-preview":
      if (key.input === "d" && snapshot.removePreviewReady) return { type: "toggle-keep-data" };
      if (key.input === "r") {
        return snapshot.removeApplyAvailable ? { type: "navigate", screen: "remove-confirm" } : undefined;
      }
      if (up) return { type: "scroll", delta: -1 };
      if (down) return { type: "scroll", delta: 1 };
      return undefined;
    case "remove-confirm":
      if (key.input === "y") return { type: "run", task: "apply-removal" };
      if (key.input === "n") return { type: "navigate", screen: "remove-preview" };
      return undefined;
    case "remove-result":
      if (up) return { type: "scroll", delta: -1 };
      if (down) return { type: "scroll", delta: 1 };
      return undefined;
    case "update": {
      if (up) return { type: "scroll", delta: -1 };
      if (down) return { type: "scroll", delta: 1 };
      if (key.input === "u" && snapshot.updatePlanReady && !snapshot.updateCompleted) {
        return { type: "navigate", screen: "update-confirm" };
      }
      return undefined;
    }
    case "update-confirm":
      if (key.input === "y") return { type: "run", task: "apply-update" };
      if (key.input === "n") return { type: "navigate", screen: "update" };
      return undefined;
  }
}

export function scrollsControlCenterScreen(screen: ControlCenterScreen): boolean {
  return SCROLL_SCREENS.has(screen);
}
