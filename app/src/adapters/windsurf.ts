import type { McpServer } from "../types.ts";
import { createJsonAdapter } from "./json-mcp.ts";

const TARGET = "~/.codeium/windsurf/mcp_config.json";

// Windsurf is canonical-ish: top-level `mcpServers`, but HTTP entries use `serverUrl` instead of `url`.
type WindsurfStdio = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
type WindsurfHttp = {
  serverUrl: string;
  headers?: Record<string, string>;
};
type WindsurfShape = {
  mcpServers?: Record<string, WindsurfStdio | WindsurfHttp>;
} & Record<string, unknown>;

function fromWindsurf(raw: WindsurfShape["mcpServers"]): Record<string, McpServer> {
  if (!raw) return {};
  const out: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    if ("serverUrl" in entry && typeof entry.serverUrl === "string") {
      const server: Extract<McpServer, { url: string }> = { type: "http", url: entry.serverUrl };
      if (entry.headers) server.headers = entry.headers;
      out[name] = server;
    } else if ("command" in entry && typeof entry.command === "string") {
      const server: Extract<McpServer, { command: string }> = { type: "stdio", command: entry.command };
      if (entry.args) server.args = entry.args;
      if (entry.env) server.env = entry.env;
      out[name] = server;
    }
  }
  return out;
}

function toWindsurf(
  servers: Record<string, McpServer>,
  previous: WindsurfShape["mcpServers"] = {},
): Record<string, WindsurfStdio | WindsurfHttp> {
  const out: Record<string, WindsurfStdio | WindsurfHttp> = {};
  for (const [name, s] of Object.entries(servers)) {
    if ("url" in s) {
      const prior = previous?.[name];
      const entry: WindsurfHttp = {
        ...(prior && "serverUrl" in prior ? prior : {}),
        serverUrl: s.url,
      };
      if (s.headers) entry.headers = s.headers;
      else delete entry.headers;
      out[name] = entry;
    } else {
      const prior = previous?.[name];
      const entry: WindsurfStdio = {
        ...(prior && "command" in prior ? prior : {}),
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

export const windsurfAdapter = createJsonAdapter<WindsurfShape>({
  id: "windsurf",
  path: TARGET,
  readServers: (data) => fromWindsurf(data.mcpServers),
  writeServers: (data, servers) => ({ ...data, mcpServers: toWindsurf(servers, data.mcpServers) }),
});
