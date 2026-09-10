import { adapters } from "./adapters/index.ts";
import { expandHome, readJson } from "./io.ts";
import { computeUnion, type Conflict } from "./mcp-state.ts";
import type { AdapterRead, AgentId } from "./types.ts";

export type UnmanagedMcpConfig = {
  path: string;
  label: string;
  serverNames: string[];
};

export type DoctorReport = {
  reads: AdapterRead[];
  unionNames: string[];
  conflicts: Conflict[];
  coverage: { name: string; present: AgentId[]; missing: AgentId[] }[];
  unmanaged: UnmanagedMcpConfig[];
};

const UNMANAGED_MCP_FILES = [
  { label: "VS Code user MCP", path: "~/Library/Application Support/Code/User/mcp.json" },
  { label: "VS Code global MCP", path: "~/.vscode/mcp.json" },
  { label: "legacy MCP registry", path: "~/.config/mcp/servers.json" },
];

export async function runDoctor(): Promise<DoctorReport> {
  const reads = await Promise.all(adapters.map((a) => a.read()));
  const { union, conflicts } = computeUnion(reads);
  const allAgents = adapters.map((a) => a.id);

  const allNames = new Set<string>();
  for (const r of reads) for (const n of Object.keys(r.servers)) allNames.add(n);

  const coverage = [...allNames].sort().map((name) => {
    const present: AgentId[] = [];
    const missing: AgentId[] = [];
    for (const r of reads) {
      if (r.servers[name]) present.push(r.agent);
      else missing.push(r.agent);
    }
    return { name, present, missing };
  });

  return {
    reads,
    unionNames: Object.keys(union).sort(),
    conflicts,
    coverage,
    unmanaged: await readUnmanagedMcpConfigs(),
  };
}

export type { Conflict };

async function readUnmanagedMcpConfigs(): Promise<UnmanagedMcpConfig[]> {
  const out: UnmanagedMcpConfig[] = [];
  for (const entry of UNMANAGED_MCP_FILES) {
    const path = expandHome(entry.path);
    const data = await readJson<Record<string, unknown>>(path).catch(() => null);
    if (!data) continue;
    const serverNames = extractServerNames(data);
    if (serverNames.length === 0) continue;
    out.push({ path, label: entry.label, serverNames });
  }
  return out;
}

function extractServerNames(data: Record<string, unknown>): string[] {
  for (const key of ["mcpServers", "servers", "mcp"]) {
    const value = data[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value as Record<string, unknown>).sort();
    }
  }
  return Object.keys(data).filter((key) => {
    const value = data[key];
    return value && typeof value === "object" && !Array.isArray(value);
  }).sort();
}
export const _agents = adapters.map((a) => a.id);
