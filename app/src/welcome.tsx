import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { Box, Text, render } from "ink";
import { FOREST } from "./cli/palette.ts";

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

// Static wordmark: the published Node bundle has no runtime font-file dependency.
const WORDMARK = "SYNCTHIS";

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
  { cmd: "syncthis plugins enable|disable", desc: "turn installed plugins on/off" },
  { cmd: "syncthis plugins rm <name…> --all", desc: "guarded plugin removal" },
  { cmd: "syncthis doctor", desc: "source and outcome diagnostics" },
  { cmd: "syncthis update", desc: "update Syncthis to latest" },
  { cmd: "syncthis version", desc: "print the installed version" },
  { cmd: "syncthis help", desc: "plugin commands and outcomes" },
];

export const NEXT_STEP = "syncthis sync";

function Welcome() {
  const cmdWidth = Math.max(...COMMANDS.map((c) => c.cmd.length)) + 2;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={FOREST}>{WORDMARK}</Text>
      <Text dimColor>{TAGLINE}</Text>

      <Box flexDirection="column" marginTop={1}>
        {COMMANDS.map((c) => (
          <Box key={c.cmd}>
            <Text dimColor>  $ </Text>
            <Box width={cmdWidth}>
              <Text>{c.cmd}</Text>
            </Box>
            <Text dimColor>{c.desc}</Text>
          </Box>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>  next  </Text>
        <Text color={FOREST}>{NEXT_STEP}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>  v{VERSION}</Text>
      </Box>
    </Box>
  );
}

export async function renderWelcome(): Promise<void> {
  const app = render(<Welcome />);
  app.unmount();
  await app.waitUntilExit();
}
