// Main menu vocabulary for the interactive control center. Pure data so copy
// and policy tests never need React or Ink.

export type MainChoice = "overview" | "sync" | "doctor" | "remove" | "update" | "quit";
export type MainMenuItem = { value: MainChoice; label: string; hint: string };

export const MAIN_MENU: MainMenuItem[] = [
  { value: "overview", label: "Plugin map", hint: "see native installs across readable agents" },
  { value: "sync", label: "Sync plugins", hint: "preview, confirm, then reconcile everywhere" },
  { value: "doctor", label: "Doctor", hint: "inspect sources and canonical target outcomes" },
  { value: "remove", label: "Remove plugins", hint: "choose plugins, scope, and confirm" },
  { value: "update", label: "Update Syncthis", hint: "preview the exact package update first" },
  { value: "quit", label: "Quit", hint: "leave without changes" },
];
