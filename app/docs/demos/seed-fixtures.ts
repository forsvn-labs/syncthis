#!/usr/bin/env bun
// Seed a throwaway $HOME with fixture agent configs for the terminal demos.
//
// syncthis reads/writes real agent config files under $HOME (src/io.ts resolves every
// path from `process.env.HOME ?? homedir()`). Recording a live demo against a real
// machine would mutate the recorder's actual configs — so the demos run against a
// disposable HOME this script seeds. Each agent gets a *distinct* MCP server so a union
// sync visibly propagates servers across agents (the demo's whole point).
//
// Usage:
//   bun docs/demos/seed-fixtures.ts [targetHome]
// Prints the seeded HOME path as the final stdout line so build.sh can `export HOME`.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function writeJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function main() {
  const target = process.argv[2];
  const home = target ?? (await mkdtemp(join(tmpdir(), "syncthis-demo-")));
  await mkdir(home, { recursive: true });

  const server = (command: string, args: string[]) => ({ command, args });

  // claude-code → ~/.claude.json (top-level user scope)
  await writeJson(join(home, ".claude.json"), {
    mcpServers: {
      context7: server("npx", ["-y", "@upstash/context7-mcp"]),
    },
  });

  // cursor → ~/.cursor/mcp.json
  await mkdir(join(home, ".cursor"), { recursive: true });
  await writeJson(join(home, ".cursor", "mcp.json"), {
    mcpServers: {
      playwright: server("npx", ["-y", "@playwright/mcp"]),
    },
  });

  // gemini-cli → ~/.gemini/settings.json
  await mkdir(join(home, ".gemini"), { recursive: true });
  await writeJson(join(home, ".gemini", "settings.json"), {
    mcpServers: {
      github: server("npx", ["-y", "@modelcontextprotocol/server-github"]),
    },
  });

  // codex → ~/.codex/config.toml (mcp_servers table; matches src/adapters/codex.ts)
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(
    join(home, ".codex", "config.toml"),
    [
      "[mcp_servers.filesystem]",
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-filesystem", "."]',
      "",
    ].join("\n"),
    "utf8",
  );

  // The harness only seeds these four agents — enough to show a meaningful union across
  // both JSON and TOML shapes. Other agents stay absent (syncthis reports them as missing,
  // which is itself honest demo material). Print the HOME path last for build.sh.
  console.error(`seeded demo HOME with context7, playwright, github, filesystem across 4 agents`);
  console.log(home);
}

main().catch((err) => {
  console.error(`seed-fixtures failed: ${err?.message ?? err}`);
  process.exit(1);
});
