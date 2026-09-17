import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentHostMap,
  HOST_AGENTS,
  resolveAgentHost,
} from "../src/plugins/host-map.ts";
import { pluginReconcileTargets } from "../src/plugins/targets.ts";

let workDir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;
let originalClaude: string | undefined;
let originalCodex: string | undefined;
let originalGrok: string | undefined;
let originalHermes: string | undefined;
let originalCopilot: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-host-map-"));
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalClaude = process.env.CLAUDE_CONFIG_DIR;
  originalCodex = process.env.CODEX_HOME;
  originalGrok = process.env.GROK_HOME;
  originalHermes = process.env.HERMES_HOME;
  originalCopilot = process.env.COPILOT_HOME;
  process.env.HOME = workDir;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.GROK_HOME;
  delete process.env.HERMES_HOME;
  delete process.env.COPILOT_HOME;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaude;
  if (originalCodex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodex;
  if (originalGrok === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = originalGrok;
  if (originalHermes === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = originalHermes;
  if (originalCopilot === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = originalCopilot;
  await rm(workDir, { recursive: true, force: true });
});

describe("agent host directory map", () => {
  test("covers every reconcile target and keeps Cursor write-only", () => {
    const hosts = agentHostMap();
    expect(hosts.map((row) => row.agent)).toEqual([...HOST_AGENTS]);
    expect(pluginReconcileTargets().map((target) => target.agent)).toEqual([...HOST_AGENTS]);

    const cursor = resolveAgentHost("cursor");
    expect(cursor.pluginAbi).toBe("write-only");
    expect(cursor.plugin.kind).toBe("directory-drop");
    expect(cursor.plugin.path).toBe(join(workDir, ".cursor/plugins/local"));
    expect(cursor.plugin.readable).toBe(true);
    expect(cursor.plugin.notes).toMatch(/not native activation/i);

    expect(resolveAgentHost("claude-code").pluginAbi).toBe("verified");
    expect(resolveAgentHost("claude-code").plugin.kind).toBe("native-cli");
    expect(resolveAgentHost("gemini-cli").pluginAbi).toBe("none");
    expect(resolveAgentHost("pi").plugin.kind).toBe("none");
    expect(resolveAgentHost("opencode").plugin.notes).toMatch(/hook modules/i);
  });

  test("resolves documented homes, env overrides, and OpenClaw legacy dirs", async () => {
    expect(resolveAgentHost("claude-code").plugin.path).toBe(join(workDir, ".claude/plugins"));
    expect(resolveAgentHost("codex").skills.path).toBe(join(workDir, ".codex/skills"));
    expect(resolveAgentHost("github-copilot").plugin.path).toBe(
      join(workDir, ".copilot/installed-plugins"),
    );
    expect(resolveAgentHost("grok-build").plugin.path).toBe(
      join(workDir, ".grok/installed-plugins"),
    );
    expect(resolveAgentHost("kimi-cli").skills.path).toBe(join(workDir, ".agents/skills"));
    expect(resolveAgentHost("cline").skills.path).toBe(join(workDir, ".agents/skills"));
    expect(resolveAgentHost("prime-agent").skills.path).toBe(join(workDir, ".agents/skills"));
    expect(resolveAgentHost("pi").skills.path).toBe(join(workDir, ".pi/agent/skills"));
    expect(resolveAgentHost("opencode").skills.path).toBe(
      join(workDir, ".config/opencode/skills"),
    );
    expect(resolveAgentHost("goose").skills.path).toBe(join(workDir, ".config/goose/skills"));
    expect(resolveAgentHost("cursor").mcp.path).toBe(join(workDir, ".cursor/mcp.json"));

    process.env.CLAUDE_CONFIG_DIR = join(workDir, "alt-claude");
    process.env.CODEX_HOME = join(workDir, "alt-codex");
    process.env.GROK_HOME = join(workDir, "alt-grok");
    process.env.HERMES_HOME = join(workDir, "alt-hermes");
    process.env.COPILOT_HOME = join(workDir, "alt-copilot");
    process.env.XDG_CONFIG_HOME = join(workDir, "xdg");
    expect(resolveAgentHost("claude-code").skills.path).toBe(join(workDir, "alt-claude/skills"));
    expect(resolveAgentHost("codex").plugin.path).toBe(join(workDir, "alt-codex/plugins"));
    expect(resolveAgentHost("grok-build").skills.path).toBe(join(workDir, "alt-grok/skills"));
    expect(resolveAgentHost("hermes-agent").skills.path).toBe(join(workDir, "alt-hermes/skills"));
    expect(resolveAgentHost("github-copilot").plugin.path).toBe(
      join(workDir, "alt-copilot/installed-plugins"),
    );
    expect(resolveAgentHost("goose").skills.path).toBe(join(workDir, "xdg/goose/skills"));
    expect(resolveAgentHost("opencode").skills.path).toBe(join(workDir, "xdg/opencode/skills"));

    await mkdir(join(workDir, ".moltbot"), { recursive: true });
    expect(resolveAgentHost("openclaw").skills.path).toBe(join(workDir, ".moltbot/skills"));
  });
});
