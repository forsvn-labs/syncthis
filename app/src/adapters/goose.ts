import yaml from "js-yaml";
import { expandHome } from "../io.ts";
import type { McpServer } from "../types.ts";
import { createTextAdapter } from "./text-mcp.ts";

// Goose (block/goose) stores config as YAML at $XDG_CONFIG_HOME/goose/config.yaml,
// defaulting to ~/.config/goose/config.yaml on BOTH macOS and Linux (Block's
// `etcetera::choose_app_strategy` uses the XDG strategy on both; the
// `~/Library/Application Support` comment in their source is stale). We honor
// XDG_CONFIG_HOME UNCONDITIONALLY, exactly as Goose does — so syncthis always writes
// the file Goose actually reads, never a divergent path. (Tests pin XDG_CONFIG_HOME
// under a temp HOME to stay hermetic; see the adapter/sync/mirror test setups.)
//
// MCP servers live under `extensions:`, a map keyed by name. Each entry flattens
// `enabled` + a `type` discriminator + the variant's fields. Goose's field names
// differ from canonical MCP: `cmd` (not command), `args`, `envs` (not env), and
// `uri` (not url) for remotes. Only the stdio / streamable_http / sse types are MCP
// servers — builtin / platform / frontend / inline_python are in-process Goose
// extensions and MUST be preserved untouched.

function goosePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = (xdg ? expandHome(xdg) : expandHome("~/.config")).replace(/\/+$/, "");
  return `${base}/goose/config.yaml`;
}

const MCP_TYPES = new Set(["stdio", "streamable_http", "sse"]);

type GooseEntry = { enabled?: boolean; type?: string } & Record<string, unknown>;
type GooseShape = { extensions?: Record<string, GooseEntry> } & Record<string, unknown>;

function isManagedType(type: unknown): boolean {
  return typeof type === "string" && MCP_TYPES.has(type);
}

function fromGoose(raw: GooseShape["extensions"]): Record<string, McpServer> {
  if (!raw) return {};
  const out: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const type = entry.type;
    if (type === "stdio" && typeof entry.cmd === "string") {
      const server: Extract<McpServer, { command: string }> = { type: "stdio", command: entry.cmd };
      if (Array.isArray(entry.args)) server.args = entry.args.filter((a): a is string => typeof a === "string");
      if (entry.envs && typeof entry.envs === "object") server.env = entry.envs as Record<string, string>;
      out[name] = server;
    } else if ((type === "streamable_http" || type === "sse") && typeof entry.uri === "string") {
      const server: Extract<McpServer, { url: string }> = { type: type === "sse" ? "sse" : "http", url: entry.uri };
      if (entry.headers && typeof entry.headers === "object") server.headers = entry.headers as Record<string, string>;
      out[name] = server;
    }
    // builtin / platform / frontend / inline_python / unknown → not an MCP server, skip.
  }
  return out;
}

function toGoose(
  servers: Record<string, McpServer>,
  previous: GooseShape["extensions"] = {},
): Record<string, GooseEntry> {
  const out: Record<string, GooseEntry> = {};
  // 1. Preserve every non-MCP (built-in / unmanaged-type) extension verbatim.
  for (const [name, entry] of Object.entries(previous ?? {})) {
    if (!entry || typeof entry !== "object" || !isManagedType(entry.type)) out[name] = entry as GooseEntry;
  }
  // 2. Write the managed MCP servers, preserving extra fields (timeout, bundled,
  //    env_keys, available_tools, description) of a same-named prior MCP entry.
  for (const [name, s] of Object.entries(servers)) {
    const prior = previous?.[name];
    const base: GooseEntry = prior && typeof prior === "object" && isManagedType(prior.type) ? { ...prior } : {};
    base.name = name;
    if ("url" in s) {
      base.type = s.type === "sse" ? "sse" : "streamable_http";
      base.uri = s.url;
      if (s.headers) base.headers = s.headers;
      else delete base.headers;
      delete base.cmd;
      delete base.args;
      delete base.envs;
    } else {
      base.type = "stdio";
      base.cmd = s.command;
      if (s.args) base.args = s.args;
      else delete base.args;
      if (s.env) base.envs = s.env;
      else delete base.envs;
      delete base.uri;
      delete base.headers;
    }
    if (typeof base.enabled !== "boolean") base.enabled = true;
    if (typeof base.description !== "string") base.description = "";
    out[name] = base;
  }
  return out;
}

function parseYaml(text: string): GooseShape {
  if (!text.trim()) return {};
  const parsed = yaml.load(text);
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as GooseShape;
}

export const gooseAdapter = createTextAdapter<GooseShape>({
  id: "goose",
  path: goosePath,
  parse: parseYaml,
  stringify: (data) => yaml.dump(data, { lineWidth: -1, noRefs: true }),
  readServers: (data) => fromGoose(data.extensions),
  writeServers: (data, servers) => ({ ...data, extensions: toGoose(servers, data.extensions) }),
});
