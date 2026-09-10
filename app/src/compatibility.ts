import type { AdapterCompatibilityIssue } from "./types.ts";

export function compatibilitySummary(issues: AdapterCompatibilityIssue[]): string | undefined {
  if (issues.length === 0) return undefined;
  const details = issues.map((i) => `${i.server} (${i.reason})`).join(", ");
  return `disabled ${issues.length} incompatible MCP server(s): ${details}`;
}
