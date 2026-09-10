import * as TOML from "smol-toml";
import type { McpServer } from "../types.ts";
import { createTextAdapter } from "./text-mcp.ts";

const TARGET = "~/.codex/config.toml";

function isHttp(s: McpServer): s is Extract<McpServer, { url: string }> {
  return "url" in s;
}

function toCodexShape(servers: Record<string, McpServer>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(servers)) {
    if (isHttp(s)) {
      const entry: Record<string, unknown> = { url: s.url };
      if (s.type) entry.type = s.type;
      if (s.headers) entry.headers = s.headers;
      out[name] = entry;
    } else {
      const entry: Record<string, unknown> = { command: s.command };
      if (s.args) entry.args = s.args;
      if (s.env) entry.env = s.env;
      if (s.cwd) entry.cwd = s.cwd;
      out[name] = entry;
    }
  }
  return out;
}

function fromCodexShape(raw: unknown): Record<string, McpServer> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.url === "string") {
      const t = e.type === "sse" ? "sse" : "http";
      const server: Extract<McpServer, { url: string }> = { type: t, url: e.url };
      if (e.headers && typeof e.headers === "object") server.headers = e.headers as Record<string, string>;
      out[name] = server;
    } else if (typeof e.command === "string") {
      const server: Extract<McpServer, { command: string }> = { type: "stdio", command: e.command };
      if (Array.isArray(e.args)) server.args = e.args.map(String);
      if (e.env && typeof e.env === "object") server.env = e.env as Record<string, string>;
      if (typeof e.cwd === "string") server.cwd = e.cwd;
      out[name] = server;
    }
  }
  return out;
}

function stripMcpServers(parsed: Record<string, unknown>): Record<string, unknown> {
  const { mcp_servers: _, ...rest } = parsed as Record<string, unknown> & { mcp_servers?: unknown };
  return rest;
}

export const codexAdapter = createTextAdapter<Record<string, unknown>>({
  id: "codex",
  path: TARGET,
  parse: (text) => (text.trim() ? (TOML.parse(text) as Record<string, unknown>) : {}),
  stringify: TOML.stringify,
  readServers: (data) => fromCodexShape(data.mcp_servers),
  writeServers: (data, servers) => ({ ...stripMcpServers(data), mcp_servers: toCodexShape(servers) }),
});
