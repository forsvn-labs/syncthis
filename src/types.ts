export type StdioServer = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type HttpServer = {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
};

export type McpServer = StdioServer | HttpServer;

export type AgentId =
  | "claude-code"
  | "cursor"
  | "codex"
  | "gemini-cli"
  | "kimi-cli"
  | "antigravity"
  | "github-copilot"
  | "windsurf"
  | "opencode"
  | "openclaw"
  | "hermes-agent"
  | "goose"
  | "grok-build"
  // Skill-only agents ship WITHOUT native MCP by design, so they have no MCP
  // adapter — they appear only in the skill cohort, never in MCP sync.
  | "pi"
  | "cline"
  | "prime-agent";

export type SyncStatus = "synced" | "unchanged" | "skipped" | "failed";
export type DoctorStatus = "ok" | "drift" | "missing" | "invalid";
export type RowStatus = SyncStatus | DoctorStatus;

export type AdapterCompatibilityIssue = {
  agent: AgentId;
  server: string;
  code: string;
  action: "disabled";
  reason: string;
};

export type AdapterRead = {
  agent: AgentId;
  path: string;
  servers: Record<string, McpServer>;
  exists: boolean;
  error?: string;
  compatibility?: AdapterCompatibilityIssue[];
};

export type AdapterWriteResult = {
  agent: AgentId;
  path: string;
  status: SyncStatus;
  message?: string;
  compatibility?: AdapterCompatibilityIssue[];
};

export interface Adapter {
  id: AgentId;
  targetPath(): string;
  read(): Promise<AdapterRead>;
  write(servers: Record<string, McpServer>, opts: { dryRun: boolean }): Promise<AdapterWriteResult>;
  removeServer?(name: string, opts: { dryRun: boolean }): Promise<AdapterWriteResult>;
}
