import yaml from "js-yaml";
import type { McpServer } from "../types.ts";
import { createTextAdapter } from "./text-mcp.ts";

const TARGET = "~/.hermes/config.yaml";

// Hermes stores config as YAML at top-level key `mcp_servers` (snake_case).
// js-yaml drops comments on write, matching upstream Hermes (PyYAML safe_dump) behavior.
type HermesStdio = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
  connect_timeout?: number;
};
type HermesHttp = {
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  connect_timeout?: number;
};
type HermesEntry = HermesStdio | HermesHttp;
type HermesShape = { mcp_servers?: Record<string, HermesEntry> } & Record<string, unknown>;

function fromHermes(raw: HermesShape["mcp_servers"]): Record<string, McpServer> {
  if (!raw) return {};
  const out: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    if ("url" in entry && typeof entry.url === "string") {
      const server: Extract<McpServer, { url: string }> = { type: "http", url: entry.url };
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

function toHermes(
  servers: Record<string, McpServer>,
  previous: HermesShape["mcp_servers"] = {},
): Record<string, HermesEntry> {
  const out: Record<string, HermesEntry> = {};
  for (const [name, s] of Object.entries(servers)) {
    if ("url" in s) {
      const prior = previous?.[name];
      const entry: HermesHttp = {
        ...(prior && "url" in prior ? prior : {}),
        url: s.url,
      };
      if (s.headers) entry.headers = s.headers;
      else delete entry.headers;
      out[name] = entry;
    } else {
      const prior = previous?.[name];
      const entry: HermesStdio = {
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

function parseYaml(text: string): HermesShape {
  if (!text.trim()) return {};
  const parsed = yaml.load(text);
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as HermesShape;
}

export const hermesAdapter = createTextAdapter<HermesShape>({
  id: "hermes-agent",
  path: TARGET,
  parse: parseYaml,
  stringify: (data) => yaml.dump(data, { lineWidth: -1, noRefs: true }),
  readServers: (data) => fromHermes(data.mcp_servers),
  writeServers: (data, servers) => ({ ...data, mcp_servers: toHermes(servers, data.mcp_servers) }),
});
