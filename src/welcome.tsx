import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { Box, Text, render } from "ink";
import Gradient from "ink-gradient";

function readPackageVersion(): string {
  try {
    const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
    const raw = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : "unknown";
  } catch {
    return "unknown";
  }
}

const VERSION = readPackageVersion();

// The "syncthis" wordmark, pre-rendered in cfonts' `block` font. Embedded as a
// static string on purpose: cfonts (via ink-big-text) loads its font JSON with a
// runtime `require("../fonts/block.json")`, which `bun build` can't resolve, so the
// single-file bundle threw "Font file for the font 'block' could not be found" for
// every published (node-bundled) install. A static banner has no runtime font
// dependency — the gradient still colors it. Regenerate via cfonts if the name changes.
const WORDMARK = [
  " ███████╗ ██╗   ██╗ ███╗   ██╗  ██████╗ ████████╗ ██╗  ██╗ ██╗ ███████╗",
  " ██╔════╝ ╚██╗ ██╔╝ ████╗  ██║ ██╔════╝ ╚══██╔══╝ ██║  ██║ ██║ ██╔════╝",
  " ███████╗  ╚████╔╝  ██╔██╗ ██║ ██║         ██║    ███████║ ██║ ███████╗",
  " ╚════██║   ╚██╔╝   ██║╚██╗██║ ██║         ██║    ██╔══██║ ██║ ╚════██║",
  " ███████║    ██║    ██║ ╚████║ ╚██████╗    ██║    ██║  ██║ ██║ ███████║",
  " ╚══════╝    ╚═╝    ╚═╝  ╚═══╝  ╚═════╝    ╚═╝    ╚═╝  ╚═╝ ╚═╝ ╚══════╝",
].join("\n");

interface CommandRow {
  cmd: string;
  desc: string;
}

// Descriptions are kept short on purpose: the row is `$ ` + a fixed-width command
// column + the description, all in one Ink flex row, so a long description wraps
// (and garbles) on an 80-col terminal. Keep each desc within ~43 chars.
export const TAGLINE = "Install a plugin once. Use it everywhere.";

export const COMMANDS: CommandRow[] = [
  { cmd: "syncthis sync", desc: "reconcile installed plugins everywhere" },
  { cmd: "syncthis plugins list", desc: "show readable plugin state" },
  { cmd: "syncthis plugins rm <name…> --all", desc: "guarded plugin removal" },
  { cmd: "syncthis doctor", desc: "read-only plugin overview" },
  { cmd: "syncthis update", desc: "update syncthis to latest" },
  { cmd: "syncthis version", desc: "print the installed version" },
  { cmd: "syncthis help", desc: "plugin commands and outcomes" },
];

function Welcome() {
  const cmdWidth = Math.max(...COMMANDS.map((c) => c.cmd.length)) + 2;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Gradient colors={["#7afb95", "#00d4ff"]}>
        <Text>{WORDMARK}</Text>
      </Gradient>

      <Box marginBottom={1} marginLeft={2}>
        <Text dimColor>{TAGLINE}</Text>
      </Box>

      {COMMANDS.map((c) => (
        <Box key={c.cmd}>
          <Text dimColor>  $ </Text>
          <Box width={cmdWidth}>
            <Text>{c.cmd}</Text>
          </Box>
          <Text dimColor>{c.desc}</Text>
        </Box>
      ))}

      <Box marginTop={1} marginLeft={2}>
        <Text>try: </Text>
        <Text color="green">syncthis sync</Text>
        <Text dimColor>  — install once, use everywhere</Text>
      </Box>

      <Box marginTop={1} marginLeft={2}>
        <Text dimColor>v{VERSION} · </Text>
        <Text color="cyan">https://github.com/hungv47/syncthis</Text>
      </Box>
    </Box>
  );
}

export async function renderWelcome(): Promise<void> {
  const app = render(<Welcome />);
  app.unmount();
  await app.waitUntilExit();
}
