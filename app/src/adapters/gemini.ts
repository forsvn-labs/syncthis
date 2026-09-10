import { createJsonMcpAdapter } from "./json-mcp.ts";

export const geminiAdapter = createJsonMcpAdapter({
  id: "gemini-cli",
  path: "~/.gemini/settings.json",
});
