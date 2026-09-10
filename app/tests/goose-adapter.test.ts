import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { gooseAdapter } from "../src/adapters/goose.ts";

let workDir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;
let configPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "syncthis-goose-"));
  originalHome = process.env.HOME;
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = workDir;
  delete process.env.XDG_CONFIG_HOME; // exercise the ~/.config default, keep writes in-temp
  configPath = join(workDir, ".config", "goose", "config.yaml");
});

afterEach(async () => {
  process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  await rm(workDir, { recursive: true, force: true });
});

async function seed(doc: unknown) {
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(configPath, yaml.dump(doc));
}

async function readBack(): Promise<any> {
  return yaml.load(await readFile(configPath, "utf8"));
}

describe("gooseAdapter — read", () => {
  test("extracts only MCP-type extensions (stdio / streamable_http / sse), skips built-ins", async () => {
    await seed({
      extensions: {
        developer: { enabled: true, type: "builtin", name: "developer", display_name: "Developer" },
        tavily: { enabled: true, type: "stdio", name: "tavily", cmd: "npx", args: ["-y", "mcp-tavily"], envs: { K: "v" } },
        remote: { enabled: true, type: "streamable_http", name: "remote", uri: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } },
        legacy: { enabled: true, type: "sse", name: "legacy", uri: "http://localhost:8811/sse" },
      },
    });
    const read = await gooseAdapter.read();
    expect(read.exists).toBe(true);
    expect(Object.keys(read.servers).sort()).toEqual(["legacy", "remote", "tavily"]);
    expect(read.servers.tavily).toEqual({ type: "stdio", command: "npx", args: ["-y", "mcp-tavily"], env: { K: "v" } });
    expect(read.servers.remote).toEqual({ type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } });
    expect(read.servers.legacy).toEqual({ type: "sse", url: "http://localhost:8811/sse" });
  });

  test("missing file reads as empty, not an error", async () => {
    const read = await gooseAdapter.read();
    expect(read.exists).toBe(false);
    expect(read.servers).toEqual({});
  });
});

describe("gooseAdapter — write", () => {
  test("maps canonical MCP → goose fields and preserves built-in extensions", async () => {
    await seed({
      extensions: { developer: { enabled: true, type: "builtin", name: "developer", bundled: true } },
      GOOSE_MODEL: "gpt-5", // unrelated top-level key must survive
    });
    const res = await gooseAdapter.write(
      {
        foo: { type: "stdio", command: "run", args: ["--x"], env: { TOKEN: "t" } },
        bar: { type: "http", url: "https://h/mcp", headers: { H: "1" } },
      },
      { dryRun: false },
    );
    expect(res.status).toBe("synced");

    const doc = await readBack();
    // built-in + unrelated key preserved
    expect(doc.extensions.developer).toEqual({ enabled: true, type: "builtin", name: "developer", bundled: true });
    expect(doc.GOOSE_MODEL).toBe("gpt-5");
    // stdio mapping: command→cmd, env→envs, plus required enabled/name/type/description
    expect(doc.extensions.foo).toEqual({
      name: "foo",
      type: "stdio",
      cmd: "run",
      args: ["--x"],
      envs: { TOKEN: "t" },
      enabled: true,
      description: "",
    });
    // remote mapping: url→uri, type http→streamable_http
    expect(doc.extensions.bar).toEqual({
      name: "bar",
      type: "streamable_http",
      uri: "https://h/mcp",
      headers: { H: "1" },
      enabled: true,
      description: "",
    });
  });

  test("preserves a prior MCP entry's extra fields (timeout, bundled, enabled:false)", async () => {
    await seed({
      extensions: {
        foo: { enabled: false, type: "stdio", name: "foo", cmd: "old", timeout: 300, bundled: false, env_keys: ["SECRET"] },
      },
    });
    await gooseAdapter.write({ foo: { type: "stdio", command: "new", args: ["--y"] } }, { dryRun: false });
    const doc = await readBack();
    expect(doc.extensions.foo.cmd).toBe("new"); // updated
    expect(doc.extensions.foo.args).toEqual(["--y"]);
    expect(doc.extensions.foo.enabled).toBe(false); // prior enabled preserved, not forced true
    expect(doc.extensions.foo.timeout).toBe(300); // extra field preserved
    expect(doc.extensions.foo.env_keys).toEqual(["SECRET"]); // secret-key refs preserved
  });

  test("round-trips: read after write yields the same canonical servers", async () => {
    const servers = {
      a: { type: "stdio" as const, command: "x", args: ["1"], env: { E: "v" } },
      b: { type: "http" as const, url: "https://b/mcp" },
    };
    await gooseAdapter.write(servers, { dryRun: false });
    const read = await gooseAdapter.read();
    expect(read.servers).toEqual(servers);
  });
});
