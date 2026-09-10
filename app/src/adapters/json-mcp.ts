import { compatibilitySummary } from "../compatibility.ts";
import type { Adapter, AdapterCompatibilityIssue, AdapterRead, AdapterWriteResult, AgentId, McpServer } from "../types.ts";
import { expandHome, readJson, writeJson } from "../io.ts";

type SettingsShape = { mcpServers?: Record<string, McpServer> } & Record<string, unknown>;

export function createJsonAdapter<T extends Record<string, unknown>>(opts: {
  id: AgentId;
  path: string | (() => string);
  readServers(data: T): Record<string, McpServer>;
  writeServers(data: T, servers: Record<string, McpServer>): T;
  readCompatibility?(data: T): AdapterCompatibilityIssue[];
  writeCompatibility?(servers: Record<string, McpServer>, next: T, previous: T): AdapterCompatibilityIssue[];
}): Adapter {
  const targetPath = () => (typeof opts.path === "function" ? opts.path() : expandHome(opts.path));

  return {
    id: opts.id,
    targetPath,
    async read(): Promise<AdapterRead> {
      const path = targetPath();
      try {
        const data = await readJson<T>(path);
        if (data === null) return { agent: opts.id, path, servers: {}, exists: false };
        const compatibility = opts.readCompatibility?.(data) ?? [];
        return {
          agent: opts.id,
          path,
          servers: opts.readServers(data),
          exists: true,
          compatibility: compatibility.length ? compatibility : undefined,
        };
      } catch (err) {
        return { agent: opts.id, path, servers: {}, exists: true, error: String(err) };
      }
    },
    async write(servers, { dryRun }): Promise<AdapterWriteResult> {
      const path = targetPath();
      let existing: T;
      try {
        existing = (await readJson<T>(path)) ?? ({} as T);
      } catch (err) {
        return { agent: opts.id, path, status: "failed", message: `cannot parse existing file: ${String(err)}` };
      }
      const next = opts.writeServers(existing, servers);
      const compatibility = opts.writeCompatibility?.(servers, next, existing) ?? [];
      const message = compatibilitySummary(compatibility);
      if (JSON.stringify(existing) === JSON.stringify(next)) return { agent: opts.id, path, status: "unchanged" };
      if (dryRun) {
        return {
          agent: opts.id,
          path,
          status: "synced",
          message: message ? `dry-run; ${message}` : "dry-run",
          compatibility: compatibility.length ? compatibility : undefined,
        };
      }
      try {
        await writeJson(path, next, { backup: true });
        return {
          agent: opts.id,
          path,
          status: "synced",
          message,
          compatibility: compatibility.length ? compatibility : undefined,
        };
      } catch (err) {
        return { agent: opts.id, path, status: "failed", message: String(err) };
      }
    },
  };
}

export function createJsonMcpAdapter(opts: { id: AgentId; path: string }): Adapter {
  return createJsonAdapter<SettingsShape>({
    id: opts.id,
    path: opts.path,
    readServers: (data) => data.mcpServers ?? {},
    writeServers: (data, servers) => ({ ...data, mcpServers: servers }),
  });
}
