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

// Keep the Syncthis wordmark as a static string so the published Node bundle
// has no runtime font-file dependency. The gradient supplies the visual treatment.
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
        <Text color="cyan">https://github.com/forsvn-labs/syncthis</Text>
      </Box>
    </Box>
  );
}

export async function renderWelcome(): Promise<void> {
  const app = render(<Welcome />);
  app.unmount();
  await app.waitUntilExit();
}
