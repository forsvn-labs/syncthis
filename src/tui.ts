export {
  renderUninstallPreview,
  renderUninstallResult,
  uninstallClaudePolicy,
  uninstallClaudeBlocked,
} from "./cli/uninstall-presentation.ts";

export { MAIN_MENU } from "./cli/main-menu.ts";
export type { MainChoice, MainMenuItem } from "./cli/main-menu.ts";

/**
 * Thin interactive entrypoint. All key policy lives in
 * src/cli/control-center-policy.ts and all screen rendering lives in
 * control-center.tsx; nothing here forks lifecycle logic.
 */
export async function showInteractivePicker(): Promise<void> {
  const { renderControlCenter } = await import("./control-center.tsx");
  await renderControlCenter();
}
