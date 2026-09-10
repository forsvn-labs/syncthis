import type { AdapterRead, AgentId, McpServer } from "./types.ts";

export type DirectionalDiff = {
  add: string[];
  overwrite: string[];
  remove: string[];
};

export type Conflict = {
  name: string;
  versions: { agent: AgentId; server: McpServer }[];
};

function canonical(server: McpServer): string {
  return JSON.stringify(sortKeys(canonicalShape(server)));
}

/**
 * Canonical identity used for MCP conflict and equality detection.
 *
 * Empty containers are omitted because adapters differ on round-tripping them.
 * URL transport subtypes are omitted because several runtimes can only read a
 * URL server back as HTTP. The union retains the source value's original type.
 */
function canonicalShape(server: McpServer): Record<string, unknown> {
  if ("url" in server) {
    const out: Record<string, unknown> = { kind: "url", url: server.url };
    if (server.headers && Object.keys(server.headers).length > 0) {
      out.headers = server.headers;
    }
    return out;
  }
  const out: Record<string, unknown> = {
    kind: "stdio",
    command: server.command,
  };
  if (server.args && server.args.length > 0) out.args = server.args;
  if (server.env && Object.keys(server.env).length > 0) out.env = server.env;
  if (server.cwd) out.cwd = server.cwd;
  return out;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function computeUnion(reads: AdapterRead[]): {
  union: Record<string, McpServer>;
  conflicts: Conflict[];
} {
  const versions = new Map<
    string,
    { agent: AgentId; server: McpServer }[]
  >();
  for (const read of reads) {
    for (const [name, server] of Object.entries(read.servers)) {
      const list = versions.get(name) ?? [];
      list.push({ agent: read.agent, server });
      versions.set(name, list);
    }
  }

  const union: Record<string, McpServer> = {};
  const conflicts: Conflict[] = [];
  for (const [name, candidates] of versions) {
    const distinct = new Set(
      candidates.map((candidate) => canonical(candidate.server)),
    );
    if (distinct.size === 1) {
      union[name] = candidates[0]!.server;
    } else {
      conflicts.push({ name, versions: candidates });
    }
  }
  return { union, conflicts };
}

export function diffServers(
  from: Record<string, McpServer>,
  to: Record<string, McpServer>,
): DirectionalDiff {
  const add: string[] = [];
  const overwrite: string[] = [];
  const remove: string[] = [];
  for (const [name, server] of Object.entries(from)) {
    if (!(name in to)) add.push(name);
    else if (canonical(server) !== canonical(to[name]!)) overwrite.push(name);
  }
  for (const name of Object.keys(to)) {
    if (!(name in from)) remove.push(name);
  }
  return {
    add: add.sort(),
    overwrite: overwrite.sort(),
    remove: remove.sort(),
  };
}
