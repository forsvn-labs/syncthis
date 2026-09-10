import { createJsonMcpAdapter } from "./json-mcp.ts";

export const cursorAdapter = createJsonMcpAdapter({
  id: "cursor",
  path: "~/.cursor/mcp.json",
});
