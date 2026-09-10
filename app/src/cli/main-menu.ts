// Main menu vocabulary for the interactive plugin hub. Pure data so copy and
// policy tests never need React or Ink.

export type MainChoice =
  | "overview"
  | "sync"
  | "configure"
  | "doctor"
  | "remove"
  | "update"
  | "quit";
export type MainMenuItem = { value: MainChoice; label: string; hint: string };

export const MAIN_MENU: MainMenuItem[] = [
  { value: "overview", label: "Installed plugins", hint: "see what is installed on every readable agent" },
  { value: "sync", label: "Sync plugins", hint: "preview, confirm, then reconcile everywhere" },
  { value: "configure", label: "Configure plugins", hint: "enable or disable installed plugins per agent" },
  { value: "doctor", label: "Doctor", hint: "inspect sources and canonical target outcomes" },
  { value: "remove", label: "Remove plugins", hint: "choose plugins, scope, and confirm" },
  { value: "update", label: "Update Syncthis", hint: "preview the exact package update first" },
  { value: "quit", label: "Quit", hint: "leave without changes" },
];
