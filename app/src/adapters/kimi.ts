import { createJsonMcpAdapter } from "./json-mcp.ts";

export const kimiAdapter = createJsonMcpAdapter({
  id: "kimi-cli",
  path: "~/.kimi/mcp.json",
});
