import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSON5 from "json5";
import { kimiAdapter } from "../src/adapters/kimi.ts";
import { antigravityAdapter } from "../src/adapters/antigravity.ts";
import { copilotAdapter } from "../src/adapters/copilot.ts";
import { windsurfAdapter } from "../src/adapters/windsurf.ts";
import { opencodeAdapter } from "../src/adapters/opencode.ts";
import { openclawAdapter } from "../src/adapters/openclaw.ts";
import { hermesAdapter } from "../src/adapters/hermes.ts";
import type { Adapter, McpServer } from "../src/types.ts";

const STDIO: McpServer = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_TOKEN: "x" },
};
const HTTP: McpServer = { type: "http", url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer x" } };
const BIGQUERY: McpServer = { type: "http", url: "https://bigquery.googleapis.com/mcp" };

let workDir: string;
let originalHome: string | undefined;
let originalCopilotHome: string | undefined;
let originalOpenclawPath: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-adapters-"));
  originalHome = process.env.HOME;
  originalCopilotHome = process.env.COPILOT_HOME;
  originalOpenclawPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.HOME = workDir;
  delete process.env.COPILOT_HOME;
  delete process.env.OPENCLAW_CONFIG_PATH;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  if (originalCopilotHome !== undefined) process.env.COPILOT_HOME = originalCopilotHome;
  else delete process.env.COPILOT_HOME;
  if (originalOpenclawPath !== undefined) process.env.OPENCLAW_CONFIG_PATH = originalOpenclawPath;
  else delete process.env.OPENCLAW_CONFIG_PATH;
  await rm(workDir, { recursive: true, force: true });
});

async function roundTrip(adapter: Adapter, server: McpServer, name = "gh"): Promise<McpServer | undefined> {
  await adapter.write({ [name]: server }, { dryRun: false });
  const r = await adapter.read();
  return r.servers[name];
}

describe("kimi adapter", () => {
  test("stdio round-trip", async () => {
    expect(await roundTrip(kimiAdapter, STDIO)).toEqual(STDIO);
  });
  test("http round-trip", async () => {
    expect(await roundTrip(kimiAdapter, HTTP)).toEqual(HTTP);
  });
});

describe("antigravity adapter", () => {
  test("stdio round-trip", async () => {
    expect(await roundTrip(antigravityAdapter, STDIO)).toEqual(STDIO);
  });
  test("http round-trip", async () => {
    expect(await roundTrip(antigravityAdapter, HTTP)).toEqual(HTTP);
  });
});

describe("copilot adapter", () => {
  test("stdio round-trip produces type:local on disk", async () => {
    await copilotAdapter.write({ gh: STDIO }, { dryRun: false });
    const text = await Bun.file(copilotAdapter.targetPath()).text();
    const data = JSON.parse(text);
    expect(data.mcpServers.gh.type).toBe("local");
    expect(data.mcpServers.gh.command).toBe("npx");
    expect(await roundTrip(copilotAdapter, STDIO)).toEqual(STDIO);
  });
  test("http round-trip produces type:http on disk", async () => {
    await copilotAdapter.write({ lin: HTTP }, { dryRun: false });
    const text = await Bun.file(copilotAdapter.targetPath()).text();
    const data = JSON.parse(text);
    expect(data.mcpServers.lin.type).toBe("http");
    expect(await roundTrip(copilotAdapter, HTTP, "lin")).toEqual(HTTP);
  });
  test("preserves Copilot-specific fields on existing servers", async () => {
    const path = copilotAdapter.targetPath();
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(
      path,
      JSON.stringify({
        mcpServers: {
          gh: { type: "local", command: "old", tools: ["search"], enabled: false },
          lin: { type: "http", url: "https://old.example", tools: ["issues"], enabled: true },
        },
      }),
    );
    await copilotAdapter.write({ gh: STDIO, lin: HTTP }, { dryRun: false });
    const data = JSON.parse(await Bun.file(path).text());
    expect(data.mcpServers.gh.tools).toEqual(["search"]);
    expect(data.mcpServers.gh.enabled).toBe(false);
    expect(data.mcpServers.gh.command).toBe(STDIO.command);
    expect(data.mcpServers.lin.tools).toEqual(["issues"]);
    expect(data.mcpServers.lin.enabled).toBe(true);
    expect(data.mcpServers.lin.url).toBe(HTTP.url);
  });
  test("$COPILOT_HOME under $HOME is honored", async () => {
    process.env.COPILOT_HOME = `${workDir}/custom-copilot`;
    expect(copilotAdapter.targetPath()).toBe(`${workDir}/custom-copilot/mcp-config.json`);
  });
  test("$COPILOT_HOME outside $HOME is rejected", () => {
    process.env.COPILOT_HOME = "/etc";
    expect(() => copilotAdapter.targetPath()).toThrow(/COPILOT_HOME/);
  });
});

describe("windsurf adapter", () => {
  test("stdio round-trip", async () => {
    expect(await roundTrip(windsurfAdapter, STDIO)).toEqual(STDIO);
  });
  test("http write produces serverUrl, not url", async () => {
    await windsurfAdapter.write({ lin: HTTP }, { dryRun: false });
    const text = await Bun.file(windsurfAdapter.targetPath()).text();
    const data = JSON.parse(text);
    expect(data.mcpServers.lin.serverUrl).toBe(HTTP.url);
    expect(data.mcpServers.lin.url).toBeUndefined();
  });
  test("http round-trip preserves canonical url shape", async () => {
    expect(await roundTrip(windsurfAdapter, HTTP, "lin")).toEqual(HTTP);
  });
  test("preserves Windsurf-specific fields on existing servers", async () => {
    const path = windsurfAdapter.targetPath();
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(
      path,
      JSON.stringify({
        mcpServers: {
          gh: { command: "old", disabled: true },
          lin: { serverUrl: "https://old.example", disabled: false },
        },
      }),
    );
    await windsurfAdapter.write({ gh: STDIO, lin: HTTP }, { dryRun: false });
    const data = JSON.parse(await Bun.file(path).text());
    // unknown per-server fields survive the rewrite (previous-merge), values updated
    expect(data.mcpServers.gh.disabled).toBe(true);
    expect(data.mcpServers.gh.command).toBe(STDIO.command);
    expect(data.mcpServers.lin.disabled).toBe(false);
    expect(data.mcpServers.lin.serverUrl).toBe(HTTP.url);
  });
});

describe("opencode adapter", () => {
  test("stdio write splits command into array under `mcp` key", async () => {
    await opencodeAdapter.write({ gh: STDIO }, { dryRun: false });
    const text = await Bun.file(opencodeAdapter.targetPath()).text();
    const data = JSON.parse(text);
    expect(data.mcp.gh.type).toBe("local");
    expect(data.mcp.gh.command).toEqual(["npx", "-y", "@modelcontextprotocol/server-github"]);
    expect(data.mcp.gh.environment).toEqual({ GITHUB_TOKEN: "x" });
    expect(data.mcpServers).toBeUndefined();
  });
  test("stdio round-trip", async () => {
    expect(await roundTrip(opencodeAdapter, STDIO)).toEqual(STDIO);
  });
  test("http remote round-trip", async () => {
    expect(await roundTrip(opencodeAdapter, HTTP, "lin")).toEqual(HTTP);
  });
  test("preserves $schema and other top-level keys", async () => {
    const path = opencodeAdapter.targetPath();
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, JSON.stringify({ $schema: "https://opencode.ai/config.json", theme: "dark" }));
    await opencodeAdapter.write({ gh: STDIO }, { dryRun: false });
    const data = JSON.parse(await Bun.file(path).text());
    expect(data.$schema).toBe("https://opencode.ai/config.json");
    expect(data.theme).toBe("dark");
    expect(data.mcp.gh).toBeDefined();
  });
  test("preserves OpenCode-specific fields on existing servers", async () => {
    const path = opencodeAdapter.targetPath();
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(
      path,
      JSON.stringify({
        mcp: {
          gh: { type: "local", command: ["old"], enabled: false },
          lin: { type: "remote", url: "https://old.example", oauth: true, enabled: true },
        },
      }),
    );
    await opencodeAdapter.write({ gh: STDIO, lin: HTTP }, { dryRun: false });
    const data = JSON.parse(await Bun.file(path).text());
    expect(data.mcp.gh.enabled).toBe(false);
    expect(data.mcp.gh.command).toEqual(["npx", "-y", "@modelcontextprotocol/server-github"]);
    expect(data.mcp.lin.oauth).toBe(true);
    expect(data.mcp.lin.enabled).toBe(true);
    expect(data.mcp.lin.url).toBe(HTTP.url);
  });

  test("disables BigQuery remote because OpenCode cannot load its output schemas quietly", async () => {
    const result = await opencodeAdapter.write({ bigquery: BIGQUERY }, { dryRun: false });
    expect(result.compatibility).toEqual([
      expect.objectContaining({
        agent: "opencode",
        server: "bigquery",
        code: "opencode-bigquery-output-schema-formats",
        action: "disabled",
      }),
    ]);
    expect(result.message).toContain("BigQuery output schemas");
    const data = JSON.parse(await Bun.file(opencodeAdapter.targetPath()).text());
    expect(data.mcp.bigquery).toMatchObject({
      type: "remote",
      url: BIGQUERY.url,
      enabled: false,
    });
    expect(await roundTrip(opencodeAdapter, BIGQUERY, "bigquery")).toEqual(BIGQUERY);
  });

  test("reports enabled incompatible OpenCode remotes on read", async () => {
    const path = opencodeAdapter.targetPath();
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, JSON.stringify({ mcp: { bigquery: { type: "remote", url: BIGQUERY.url, enabled: true } } }));
    const read = await opencodeAdapter.read();
    expect(read.compatibility).toEqual([
      expect.objectContaining({
        agent: "opencode",
        server: "bigquery",
        code: "opencode-bigquery-output-schema-formats",
      }),
    ]);
  });

  test("disables invalid remote URLs instead of letting OpenCode warn on startup", async () => {
    const invalid: McpServer = { type: "http", url: "" };
    const result = await opencodeAdapter.write({ databricks: invalid }, { dryRun: false });
    expect(result.compatibility?.[0]).toMatchObject({
      agent: "opencode",
      server: "databricks",
      code: "opencode-invalid-remote-url",
      action: "disabled",
    });
    const data = JSON.parse(await Bun.file(opencodeAdapter.targetPath()).text());
    expect(data.mcp.databricks).toMatchObject({
      type: "remote",
      url: "",
      enabled: false,
    });
  });
});

describe("openclaw adapter", () => {
  test("stdio round-trip via JSON5 with comments", async () => {
    const path = openclawAdapter.targetPath();
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, "// header comment\n{ /* trailing */ \"gateway\": { \"port\": 8080 } }\n");
    await openclawAdapter.write({ gh: STDIO }, { dryRun: false });
    const r = await openclawAdapter.read();
    expect(r.servers.gh).toEqual(STDIO);
  });
  test("sse encodes as transport:sse", async () => {
    const sse: McpServer = { type: "sse", url: "https://example.com/sse" };
    await openclawAdapter.write({ s: sse }, { dryRun: false });
    const data = JSON5.parse(await Bun.file(openclawAdapter.targetPath()).text());
    expect(data.mcp.servers.s.transport).toBe("sse");
  });
  test("http encodes as transport:streamable-http", async () => {
    await openclawAdapter.write({ h: HTTP }, { dryRun: false });
    const data = JSON5.parse(await Bun.file(openclawAdapter.targetPath()).text());
    expect(data.mcp.servers.h.transport).toBe("streamable-http");
  });
  test("$OPENCLAW_CONFIG_PATH outside $HOME is rejected", () => {
    process.env.OPENCLAW_CONFIG_PATH = "/etc/openclaw.json";
    expect(() => openclawAdapter.targetPath()).toThrow(/OPENCLAW_CONFIG_PATH/);
  });
  test("preserves other top-level keys", async () => {
    const path = openclawAdapter.targetPath();
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, JSON.stringify({ skills: { extraDirs: ["~/skills"] } }));
    await openclawAdapter.write({ gh: STDIO }, { dryRun: false });
    const r = await openclawAdapter.read();
    const data = JSON5.parse(await Bun.file(path).text());
    expect(data.skills.extraDirs).toEqual(["~/skills"]);
    expect(r.servers.gh).toEqual(STDIO);
  });
  test("preserves OpenClaw server-specific fields", async () => {
    const path = openclawAdapter.targetPath();
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(
      path,
      JSON.stringify({
        mcp: {
          servers: {
            gh: { command: "old", timeout: 30 },
            s: { url: "https://old.example", transport: "sse", timeout: 45 },
          },
        },
      }),
    );
    await openclawAdapter.write({ gh: STDIO, s: { type: "sse", url: "https://example.com/sse" } }, { dryRun: false });
    const data = JSON5.parse(await Bun.file(path).text());
    expect(data.mcp.servers.gh.timeout).toBe(30);
    expect(data.mcp.servers.gh.command).toBe(STDIO.command);
    expect(data.mcp.servers.s.timeout).toBe(45);
    expect(data.mcp.servers.s.transport).toBe("sse");
  });
});

describe("hermes adapter", () => {
  test("stdio round-trip via YAML", async () => {
    expect(await roundTrip(hermesAdapter, STDIO)).toEqual(STDIO);
  });
  test("http round-trip via YAML", async () => {
    expect(await roundTrip(hermesAdapter, HTTP, "lin")).toEqual(HTTP);
  });
  test("uses snake_case mcp_servers key on disk", async () => {
    await hermesAdapter.write({ gh: STDIO }, { dryRun: false });
    const text = await Bun.file(hermesAdapter.targetPath()).text();
    expect(text).toContain("mcp_servers:");
    expect(text).not.toContain("mcpServers:");
  });
  test("preserves other top-level YAML keys", async () => {
    const path = hermesAdapter.targetPath();
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, "gateway:\n  port: 8080\nmcp_servers: {}\n");
    await hermesAdapter.write({ gh: STDIO }, { dryRun: false });
    const text = await Bun.file(path).text();
    expect(text).toContain("gateway:");
    expect(text).toContain("port: 8080");
  });
  test("preserves Hermes timeout fields on existing servers", async () => {
    const path = hermesAdapter.targetPath();
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(
      path,
      "mcp_servers:\n  gh:\n    command: old\n    timeout: 30\n    connect_timeout: 5\n  lin:\n    url: https://old.example\n    timeout: 45\n",
    );
    await hermesAdapter.write({ gh: STDIO, lin: HTTP }, { dryRun: false });
    const text = await Bun.file(path).text();
    expect(text).toContain("timeout: 30");
    expect(text).toContain("connect_timeout: 5");
    expect(text).toContain("timeout: 45");
    expect(await roundTrip(hermesAdapter, STDIO)).toEqual(STDIO);
  });
});

describe("backup is taken on first write only (sacred element §2)", () => {
  test("subsequent writes do not rotate the bak", async () => {
    // First write — bak should contain the (empty) original or be created from current state
    const path = kimiAdapter.targetPath();
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, JSON.stringify({ mcpServers: { original: STDIO } }));
    await kimiAdapter.write({ first: STDIO }, { dryRun: false });
    const bakAfterFirst = await Bun.file(`${path}.syncthis.bak`).text();
    expect(bakAfterFirst).toContain("original");

    // Second write — bak must NOT change to reflect the post-first-write state
    await kimiAdapter.write({ second: STDIO }, { dryRun: false });
    const bakAfterSecond = await Bun.file(`${path}.syncthis.bak`).text();
    expect(bakAfterSecond).toBe(bakAfterFirst);
    expect(bakAfterSecond).toContain("original");
    expect(bakAfterSecond).not.toContain("first");
  });
});
