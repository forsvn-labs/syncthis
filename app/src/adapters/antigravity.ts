import { createJsonMcpAdapter } from "./json-mcp.ts";

export const antigravityAdapter = createJsonMcpAdapter({
  id: "antigravity",
  path: "~/.gemini/antigravity/mcp_config.json",
});
