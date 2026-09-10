import type { Adapter, AdapterRead, AdapterWriteResult, AgentId, McpServer } from "../types.ts";
import { expandHome, readText, writeText } from "../io.ts";

export function createTextAdapter<T extends Record<string, unknown>>(opts: {
  id: AgentId;
  path: string | (() => string);
  parse(text: string): T;
  stringify(data: T): string;
  readServers(data: T): Record<string, McpServer>;
  writeServers(data: T, servers: Record<string, McpServer>): T;
}): Adapter {
  const targetPath = () => (typeof opts.path === "function" ? opts.path() : expandHome(opts.path));

  return {
    id: opts.id,
    targetPath,
    async read(): Promise<AdapterRead> {
      const path = targetPath();
      const text = await readText(path);
      if (text === null) return { agent: opts.id, path, servers: {}, exists: false };
      try {
        const data = opts.parse(text);
        return { agent: opts.id, path, servers: opts.readServers(data), exists: true };
      } catch (err) {
        return { agent: opts.id, path, servers: {}, exists: true, error: String(err) };
      }
    },
    async write(servers, { dryRun }): Promise<AdapterWriteResult> {
      const path = targetPath();
      let currentText = "";
      let existing: T;
      try {
        currentText = (await readText(path)) ?? "";
        existing = opts.parse(currentText);
      } catch (err) {
        return { agent: opts.id, path, status: "failed", message: `cannot parse existing file: ${String(err)}` };
      }
      const next = opts.stringify(opts.writeServers(existing, servers));
      if (currentText === next) return { agent: opts.id, path, status: "unchanged" };
      if (dryRun) return { agent: opts.id, path, status: "synced", message: "dry-run" };
      try {
        await writeText(path, next, { backup: true });
        return { agent: opts.id, path, status: "synced" };
      } catch (err) {
        return { agent: opts.id, path, status: "failed", message: String(err) };
      }
    },
  };
}
