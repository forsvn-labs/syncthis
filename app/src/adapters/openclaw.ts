import JSON5 from "json5";
import type { McpServer } from "../types.ts";
import { expandHome, resolveUnderHome } from "../io.ts";
import { createTextAdapter } from "./text-mcp.ts";

const DEFAULT_TARGET = "~/.openclaw/openclaw.json";

// OpenClaw stores config as JSON5 (comments + trailing commas allowed) at a nested key `mcp.servers`.
// HTTP entries use a `transport` field whose values are "sse" or "streamable-http" (canonical "http").
// Comments are dropped on write — JSON5.stringify doesn't preserve them.
type OpenClawStdio = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
type OpenClawHttp = {
  url: string;
  transport: "sse" | "streamable-http";
  headers?: Record<string, string>;
};
type OpenClawEntry = OpenClawStdio | OpenClawHttp;
type OpenClawShape = {
  mcp?: { servers?: Record<string, OpenClawEntry> } & Record<string, unknown>;
} & Record<string, unknown>;

function targetPath(): string {
  const override = process.env.OPENCLAW_CONFIG_PATH;
  if (override) return resolveUnderHome(override, "OPENCLAW_CONFIG_PATH");
  return expandHome(DEFAULT_TARGET);
}

function fromOpenClaw(raw: Record<string, OpenClawEntry> | undefined): Record<string, McpServer> {
  if (!raw) return {};
  const out: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    if ("url" in entry && typeof entry.url === "string") {
      const t = entry.transport === "sse" ? "sse" : "http";
      const server: Extract<McpServer, { url: string }> = { type: t, url: entry.url };
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

function toOpenClaw(
  servers: Record<string, McpServer>,
  previous: Record<string, OpenClawEntry> | undefined = {},
): Record<string, OpenClawEntry> {
  const out: Record<string, OpenClawEntry> = {};
  for (const [name, s] of Object.entries(servers)) {
    if ("url" in s) {
      const transport: "sse" | "streamable-http" = s.type === "sse" ? "sse" : "streamable-http";
      const prior = previous?.[name];
      const entry: OpenClawHttp = {
        ...(prior && "url" in prior ? prior : {}),
        url: s.url,
        transport,
      };
      if (s.headers) entry.headers = s.headers;
      else delete entry.headers;
      out[name] = entry;
    } else {
      const prior = previous?.[name];
      const entry: OpenClawStdio = {
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

function readOpenClawFile(text: string): OpenClawShape {
  if (!text.trim()) return {};
  return JSON5.parse(text) as OpenClawShape;
}

export const openclawAdapter = createTextAdapter<OpenClawShape>({
  id: "openclaw",
  path: targetPath,
  parse: readOpenClawFile,
  stringify: (data) => JSON5.stringify(data, null, 2) + "\n",
  readServers: (data) => fromOpenClaw(data.mcp?.servers),
  writeServers: (data, servers) => ({
    ...data,
    mcp: { ...(data.mcp ?? {}), servers: toOpenClaw(servers, data.mcp?.servers) },
  }),
});
