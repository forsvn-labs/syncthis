import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { MAIN_MENU } from "../src/tui.ts";
import { COMMANDS, TAGLINE } from "../src/welcome.tsx";

const FORBIDDEN_PUBLIC_TERMS = /\bskills?\b|\bmcp\b|model-context-protocol/i;
const HIDDEN_COMMAND_TERMS = /\bsyncthis (?:add|mirror|run)\b|\bplugins (?:add|mirror)\b|--no-wrapper/i;
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  description?: unknown;
  keywords?: unknown;
};
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function publicText(rows: Array<{ cmd?: string; desc?: string; label?: string; hint?: string }>): string {
  return rows
    .flatMap((row) => [row.cmd, row.desc, row.label, row.hint])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

describe("plugin-only public surfaces", () => {
  test("welcome tagline and command rows advertise plugins only", () => {
    const commands = COMMANDS.map((row) => row.cmd);
    expect(commands).toEqual([
      "syncthis sync",
      "syncthis plugins list",
      "syncthis plugins rm <name…> --all",
      "syncthis doctor",
      "syncthis update",
      "syncthis version",
      "syncthis help",
    ]);
    expect(TAGLINE).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(publicText(COMMANDS)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(publicText(COMMANDS)).not.toMatch(HIDDEN_COMMAND_TERMS);
  });

  test("interactive menu exposes only plugin actions and quit", () => {
    expect(MAIN_MENU.map((item) => item.value)).toEqual(["overview", "sync", "doctor", "remove", "update", "quit"]);
    expect(MAIN_MENU.map((item) => item.label)).toEqual([
      "Plugin map",
      "Sync plugins",
      "Doctor",
      "Remove plugins",
      "Update Syncthis",
      "Quit",
    ]);
    expect(publicText(MAIN_MENU)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(publicText(MAIN_MENU)).not.toMatch(HIDDEN_COMMAND_TERMS);
  });

  test("package marketing metadata is plugin-only", () => {
    const description = typeof packageJson.description === "string" ? packageJson.description : "";
    const keywords = Array.isArray(packageJson.keywords) ? packageJson.keywords.join("\n") : "";
    expect(`${description}\n${keywords}`).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(description).toContain("Syncthis");
    expect(packageJson.keywords).toContain("cross-agent-plugins");
  });

  test("README is plugin-only public documentation", () => {
    expect(readme).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(readme).not.toMatch(HIDDEN_COMMAND_TERMS);
    expect(readme).toContain("Syncthis");
    expect(readme).toContain("Compatibility note");
    expect(readme).toContain("syncthis plugins list");
    expect(readme).toContain("syncthis plugins rm");
    expect(readme).toContain("native");
    expect(readme).toContain("adapted");
    expect(readme).toContain("partial");
    expect(readme).toContain("blocked");
    expect(readme).toContain("unsupported");
  });
});
