import { URL } from "node:url";
import type { AdapterCompatibilityIssue, McpServer } from "../types.ts";
import { createJsonAdapter } from "./json-mcp.ts";

const TARGET = "~/.config/opencode/opencode.json";
const BIGQUERY_MCP_URL = "https://bigquery.googleapis.com/mcp";

// OpenCode is the most divergent adapter:
//   - top-level key is `mcp` (not mcpServers)
//   - type-tagged: "local" for stdio, "remote" for HTTP
//   - stdio's `command` is a SINGLE ARRAY (not separate command + args)
//   - env field is `environment` (not env)
type OpenCodeLocal = {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
};
type OpenCodeRemote = {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  oauth?: boolean;
  enabled?: boolean;
};
type OpenCodeEntry = OpenCodeLocal | OpenCodeRemote;
type OpenCodeShape = { mcp?: Record<string, OpenCodeEntry> } & Record<string, unknown>;
type OpenCodeRemoteRule = {
  code: string;
  reason: string;
  matches(url: string): boolean;
};

const REMOTE_COMPATIBILITY_RULES: OpenCodeRemoteRule[] = [
  {
    code: "opencode-bigquery-output-schema-formats",
    reason: "BigQuery output schemas make OpenCode/Ajv spam unknown uint64 format warnings",
    matches: (url) => url === BIGQUERY_MCP_URL,
  },
];

function isValidRemoteUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function remoteCompatibilityIssue(name: string, url: string): AdapterCompatibilityIssue | undefined {
  const trimmed = url.trim();
  if (url !== trimmed || !trimmed || !isValidRemoteUrl(trimmed)) {
    return {
      agent: "opencode",
      server: name,
      code: "opencode-invalid-remote-url",
      action: "disabled",
      reason: "invalid remote URL",
    };
  }

  const rule = REMOTE_COMPATIBILITY_RULES.find((r) => r.matches(trimmed));
  if (!rule) return undefined;
  return {
    agent: "opencode",
    server: name,
    code: rule.code,
    action: "disabled",
    reason: rule.reason,
  };
}

function compatibilityFromServers(servers: Record<string, McpServer>): AdapterCompatibilityIssue[] {
  const issues: AdapterCompatibilityIssue[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if ("url" in server) {
      const issue = remoteCompatibilityIssue(name, server.url);
      if (issue) issues.push(issue);
    }
  }
  return issues;
}

function compatibilityFromOpenCode(raw: OpenCodeShape["mcp"]): AdapterCompatibilityIssue[] {
  if (!raw) return [];
  const issues: AdapterCompatibilityIssue[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object" || entry.type !== "remote" || typeof entry.url !== "string") continue;
    if (entry.enabled === false) continue;
    const issue = remoteCompatibilityIssue(name, entry.url);
    if (issue) issues.push(issue);
  }
  return issues;
}

function fromOpenCode(raw: OpenCodeShape["mcp"]): Record<string, McpServer> {
  if (!raw) return {};
  const out: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "local" && Array.isArray((entry as OpenCodeLocal).command)) {
      const e = entry as OpenCodeLocal;
      const [cmd, ...rest] = e.command;
      if (typeof cmd !== "string") continue;
      const server: Extract<McpServer, { command: string }> = { type: "stdio", command: cmd };
      if (rest.length > 0) server.args = rest;
      if (e.environment) server.env = e.environment;
      out[name] = server;
    } else if (entry.type === "remote" && typeof (entry as OpenCodeRemote).url === "string") {
      const e = entry as OpenCodeRemote;
      const server: Extract<McpServer, { url: string }> = { type: "http", url: e.url };
      if (e.headers) server.headers = e.headers;
      out[name] = server;
    }
  }
  return out;
}

function toOpenCode(
  servers: Record<string, McpServer>,
  previous: OpenCodeShape["mcp"] = {},
): Record<string, OpenCodeEntry> {
  const out: Record<string, OpenCodeEntry> = {};
  for (const [name, s] of Object.entries(servers)) {
    if ("url" in s) {
      const prior = previous?.[name];
      const entry: OpenCodeRemote = {
        ...(prior?.type === "remote" ? prior : {}),
        type: "remote",
        url: s.url,
      };
      if (remoteCompatibilityIssue(name, s.url)) entry.enabled = false;
      if (s.headers) entry.headers = s.headers;
      else delete entry.headers;
      out[name] = entry;
    } else {
      const prior = previous?.[name];
      const entry: OpenCodeLocal = {
        ...(prior?.type === "local" ? prior : {}),
        type: "local",
        command: [s.command, ...(s.args ?? [])],
      };
      if (s.env) entry.environment = s.env;
      else delete entry.environment;
      out[name] = entry;
    }
  }
  return out;
}

export const opencodeAdapter = createJsonAdapter<OpenCodeShape>({
  id: "opencode",
  path: TARGET,
  readServers: (data) => fromOpenCode(data.mcp),
  writeServers: (data, servers) => ({ ...data, mcp: toOpenCode(servers, data.mcp) }),
  readCompatibility: (data) => compatibilityFromOpenCode(data.mcp),
  writeCompatibility: (servers) => compatibilityFromServers(servers),
});
