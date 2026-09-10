import type { McpServer } from "../types.ts";
import { expandHome, resolveUnderHome } from "../io.ts";
import { createJsonAdapter } from "./json-mcp.ts";

const DEFAULT_TARGET = "~/.copilot/mcp-config.json";

// Copilot CLI uses type-tagged JSON: {type: "local"|"http", ...}.
type CopilotStdio = {
  type: "local";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  tools?: string[];
  enabled?: boolean;
};
type CopilotHttp = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  tools?: string[];
  enabled?: boolean;
};
type CopilotEntry = CopilotStdio | CopilotHttp;
type CopilotShape = { mcpServers?: Record<string, CopilotEntry> } & Record<string, unknown>;

function targetPath(): string {
  const override = process.env.COPILOT_HOME;
  if (override) return resolveUnderHome(`${override}/mcp-config.json`, "COPILOT_HOME");
  return expandHome(DEFAULT_TARGET);
}

function fromCopilot(raw: CopilotShape["mcpServers"]): Record<string, McpServer> {
  if (!raw) return {};
  const out: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "local" && typeof (entry as CopilotStdio).command === "string") {
      const e = entry as CopilotStdio;
      const server: Extract<McpServer, { command: string }> = { type: "stdio", command: e.command };
      if (e.args) server.args = e.args;
      if (e.env) server.env = e.env;
      out[name] = server;
    } else if (entry.type === "http" && typeof (entry as CopilotHttp).url === "string") {
      const e = entry as CopilotHttp;
      const server: Extract<McpServer, { url: string }> = { type: "http", url: e.url };
      if (e.headers) server.headers = e.headers;
      out[name] = server;
    }
  }
  return out;
}

function toCopilot(
  servers: Record<string, McpServer>,
  previous: CopilotShape["mcpServers"] = {},
): Record<string, CopilotEntry> {
  const out: Record<string, CopilotEntry> = {};
  for (const [name, s] of Object.entries(servers)) {
    if ("url" in s) {
      const prior = previous?.[name];
      const entry: CopilotHttp = {
        ...(prior?.type === "http" ? prior : {}),
        type: "http",
        url: s.url,
      };
      if (s.headers) entry.headers = s.headers;
      else delete entry.headers;
      out[name] = entry;
    } else {
      const prior = previous?.[name];
      const entry: CopilotStdio = {
        ...(prior?.type === "local" ? prior : {}),
        type: "local",
        command: s.command,
      };
      if (s.args) entry.args = s.args;
      else delete entry.args;
      if (s.env) entry.env = s.env;
      else delete entry.env;
      out[name] = entry;
    }
  }
  return out;
}

export const copilotAdapter = createJsonAdapter<CopilotShape>({
  id: "github-copilot",
  path: targetPath,
  readServers: (data) => fromCopilot(data.mcpServers),
  writeServers: (data, servers) => ({ ...data, mcpServers: toCopilot(servers, data.mcpServers) }),
});
