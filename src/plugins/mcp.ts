// Plugin → MCP decomposition.
//
// A Claude plugin can bundle MCP servers (a root `.mcp.json`, or an `mcpServers`
// field in its manifest). Those servers are standard MCP config, so they're
// portable to ANY MCP-capable agent — but the plugin-native cohort (Claude, Codex,
// Cursor) already gets them by installing the plugin. The non-plugin MCP cohort
// can't load plugins at all, so the mirror lifts a plugin's bundled MCP servers
// out and writes them into those agents' own MCP configs (via the normal adapters).
//
// The one transform that matters: a bundled server's paths use
// `${CLAUDE_PLUGIN_ROOT}`, which only Claude Code substitutes at load time. Outside
// Claude there's no such variable, so we resolve it to the plugin's absolute install
// dir. A server that still references a Claude-only variable we can't resolve
// (`${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, …) can't run elsewhere, so it's
// skipped with a reason rather than written as a config that would silently fail.

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { readJson } from "../io.ts";
import type { HttpServer, McpServer, StdioServer } from "../types.ts";
import {
  AGENT_PLUGINS_SPEC_VERSION,
  CANONICAL_MCP_PATH,
  agentPluginsSchemaVersion,
  ensurePrivateDirectory,
  expandPlaceholders,
  isSymlinkSafeContained,
  isValidResolvedCwd,
  validateMcpDocumentV1,
  validatePluginManifestV1,
  validatePrivateDirectoryPath,
  type PlaceholderResolution,
} from "./agent-plugins-v1.ts";
import type { PluginRecord } from "./types.ts";

// Claude substitutes ${CLAUDE_PLUGIN_ROOT} (and the bare `$CLAUDE_PLUGIN_ROOT`
// form) with the plugin's install dir. We do the same so the lifted server resolves.
const ROOT_TOKENS = ["${CLAUDE_PLUGIN_ROOT}", "$CLAUDE_PLUGIN_ROOT"];

export type PluginMcpServer = {
  plugin: string;
  marketplace?: string;
  name: string;
  server: McpServer;
};

export type PluginMcpSkip = { plugin: string; name: string; reason: string };

export type PluginMcpResolution = {
  servers: PluginMcpServer[];
  skipped: PluginMcpSkip[];
};

function substituteRoot(value: unknown, root: string): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const tok of ROOT_TOKENS) out = out.split(tok).join(root);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => substituteRoot(v, root));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteRoot(v, root);
    return out;
  }
  return value;
}

// A Claude-injected variable other than CLAUDE_PLUGIN_ROOT (already resolved):
// CLAUDE_PLUGIN_DATA, CLAUDE_PROJECT_DIR, CLAUDE_CONFIG_DIR. These have no value
// outside Claude, so a server still referencing one can't run elsewhere — skip it.
// Plain `${ENV_VAR}` refs (the user's own environment) are portable and left alone;
// matching is scoped to the known CLAUDE_ prefixes so a user var that merely starts
// with CLAUDE_ isn't caught.
function hasUnresolvedClaudeVar(server: McpServer): boolean {
  return /\$\{?CLAUDE_(PLUGIN|PROJECT|CONFIG)[A-Z_]*\}?/.test(JSON.stringify(server));
}

// Narrow a raw bundled definition to a syncable McpServer. URL servers map to http
// (sse preserved); command servers keep args/env/cwd. Anything else (no url, no
// command) is unrecognized and gets skipped by the caller.
function coerceServer(raw: unknown): McpServer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url === "string") {
    const s: HttpServer = { type: r.type === "sse" ? "sse" : "http", url: r.url };
    if (r.headers && typeof r.headers === "object") s.headers = r.headers as Record<string, string>;
    return s;
  }
  if (typeof r.command === "string") {
    const s: StdioServer = { command: r.command };
    if (Array.isArray(r.args)) s.args = r.args.filter((a): a is string => typeof a === "string");
    if (r.env && typeof r.env === "object") s.env = r.env as Record<string, string>;
    if (typeof r.cwd === "string") s.cwd = r.cwd;
    return s;
  }
  return null;
}

// Stable JSON for cross-plugin dedup (key order independent).
function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

// A safe per-plugin segment for the Syncthis-managed PLUGIN_DATA tree. The
// plugin name is attacker-controlled in legacy manifests, so it never lands in
// a path verbatim.
function pluginDataSegment(plugin: PluginRecord): string {
  return createHash("sha256").update(`${plugin.marketplace ?? ""}#${plugin.name}`).digest("hex");
}

// The plugin root must be a real directory; returns its absolute
// filesystem-resolved spelling so every later decision happens on the real
// tree, never an arbitrary or symlinked record.path spelling (§4.1).
async function resolveRealRoot(
  root: string,
): Promise<{ state: "unsafe" } | { state: "ok"; realRoot: string }> {
  try {
    // The install-path spelling may itself be a symlink; resolve it ONCE to
    // the real directory and verify the target really is a directory. All
    // later reads use only this real root, so swapping the link afterward
    // cannot redirect them.
    const realRoot = await realpath(root);
    const realInfo = await lstat(realRoot);
    if (!realInfo.isDirectory()) return { state: "unsafe" };
    return { state: "ok", realRoot };
  } catch {
    return { state: "unsafe" };
  }
}

// Read one fixed package file from the ALREADY-resolved real root. A present
// entry must be a regular file whose path stays inside the root: a symlink,
// directory, or escaping target is reported as invalid instead of followed.
type FixedFileRead =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; text: string };

async function readFixedPackageFile(realRoot: string, rel: string): Promise<FixedFileRead> {
  const candidate = join(realRoot, rel);
  let info;
  try {
    info = await lstat(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", reason: `${rel} is not readable` };
  }
  if (!info.isFile()) return { kind: "invalid", reason: `${rel} must be a regular file` };
  if (!(await isSymlinkSafeContained(realRoot, candidate))) {
    return { kind: "invalid", reason: `${rel} resolves outside the plugin root` };
  }
  try {
    return { kind: "ok", text: await readFile(candidate, "utf8") };
  } catch {
    return { kind: "invalid", reason: `${rel} is not readable` };
  }
}

// Parse validated plugin.json text and classify the canonical state. The root
// plugin.json only claims canonical identity when it carries an Agent Plugins
// manifest schema identifier; a different published version is explicitly
// unsupported and equally gates MCP off.
function classifyCanonicalManifest(text: string): "valid" | "invalid" | "absent" {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "absent"; // unparseable JSON cannot claim the canonical schema
  }
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
  const version = agentPluginsSchemaVersion(record?.$schema, "plugin");
  const validation = validatePluginManifestV1(raw);
  if (!validation.canonical && version === null) return "absent";
  if (version !== null && version !== AGENT_PLUGINS_SPEC_VERSION) return "invalid";
  return validation.valid ? "valid" : "invalid";
}

// Create (or verify) the Syncthis-managed persistent data directory for one
// installed plugin: a hashed, plugin-name-independent path under the explicit
// dataRoot, built segment-by-segment without following symlinks and forced to
// an exact 0700 mode. Callers only pass durable-state intent when they opt
// into filesystem state; the resolver default stays read-only, so dry-run-style
// callers cause no writes.
async function ensurePluginDataDir(
  dataRoot: string,
  plugin: PluginRecord,
): Promise<string | undefined> {
  return ensurePrivateDirectory(dataRoot, [
    "syncthis",
    "plugin-data",
    pluginDataSegment(plugin),
  ]);
}

// Preview twin of ensurePluginDataDir: compute and validate the EXACT
// per-plugin PLUGIN_DATA path an apply would create, without touching the
// filesystem. An unsafe path stays undefined so the preview shows stdio work
// as partial for exactly the servers apply would refuse.
async function previewPluginDataDir(
  dataRoot: string,
  plugin: PluginRecord,
): Promise<string | undefined> {
  return validatePrivateDirectoryPath(dataRoot, [
    "syncthis",
    "plugin-data",
    pluginDataSegment(plugin),
  ]);
}

// How a caller wants the per-plugin PLUGIN_DATA home handled.
//   none    — no managed data home; canonical stdio servers stay partial.
//   preview — compute+validate the exact path; never create anything.
//   create  — securely create/verify the path at 0700 before emitting configs.
export type PluginMcpDataHome =
  | { intent: "none" }
  | { intent: "preview"; dataRoot: string }
  | { intent: "create"; dataRoot: string };

// The plugin root must be a real directory, and a fixed package file (root
// plugin.json / mcp.json) must be a regular file that resolves inside it —
// never a symlink escaping the root or a non-file entry. Returns the absolute
// filesystem-resolved root on success (§4.1 narrow failure boundary).
async function resolveRealPluginRoot(
  root: string,
): Promise<string | null> {
  let realRoot: string;
  try {
    const info = await lstat(root);
    if (!info.isDirectory()) return null;
    realRoot = await realpath(root);
    const realInfo = await lstat(realRoot);
    if (!realInfo.isDirectory()) return null;
  } catch {
    return null;
  }
  for (const rel of ["plugin.json", CANONICAL_MCP_PATH]) {
    const candidate = join(realRoot, rel);
    try {
      const info = await lstat(candidate);
      if (!info.isFile()) continue; // absent-or-not-a-file is fine per file
      if (!(await isSymlinkSafeContained(realRoot, candidate))) return null;
    } catch {
      // Missing fixed files are not an error here.
    }
  }
  return realRoot;
}


// Lift validated Agent Plugins v1 servers into the portable McpServer shape
// used by the adapters, expanding ${PLUGIN_ROOT}/${PLUGIN_DATA} exactly once
// in args/env/cwd (never command/url/headers/env keys). A conformant stdio
// mapping needs client-supplied PLUGIN_ROOT and PLUGIN_DATA (§9.1): when the
// secure data-directory lifecycle is unavailable, stdio servers are skipped
// with an explicit partial reason instead of emitting configs that would
// launch without their data home; remote servers still lift.
async function liftV1Servers(
  plugin: PluginRecord,
  validated: ReturnType<typeof validateMcpDocumentV1>,
  resolution: PlaceholderResolution,
): Promise<{ servers: { name: string; server: McpServer }[]; skips: { name: string; reason: string }[] }> {
  const servers: { name: string; server: McpServer }[] = [];
  const skips: { name: string; reason: string }[] = [];
  const noDataHome =
    "requires a client-supplied PLUGIN_DATA directory but no Syncthis-managed persistent data directory is enabled for this plugin";
  for (const [name, entry] of validated.servers) {
    if (entry.type === "stdio") {
      if (resolution.pluginData === undefined) {
        skips.push({ name, reason: noDataHome });
        continue;
      }
      const expandedArgs = expandPlaceholders(entry.args ?? [], resolution);
      const expandedEnv = expandPlaceholders(entry.env ?? {}, resolution);
      if (expandedArgs.unresolvedData || expandedEnv.unresolvedData) {
        skips.push({ name, reason: noDataHome });
        continue;
      }
      // The command token is never placeholder-expanded. A "./"-contained
      // path resolves against the plugin root so the lifted server works on
      // any target; bare executable names stay as-is for PATH resolution.
      let command = entry.command;
      if (command.startsWith("./")) {
        command = join(resolution.pluginRoot, command.slice(2));
        if (!(await isSymlinkSafeContained(resolution.pluginRoot, command))) {
          skips.push({
            name,
            reason: `"command" escapes the plugin root through a symlink`,
          });
          continue;
        }
      }
      let cwd: string | undefined;
      if (entry.cwd !== undefined) {
        if (!isValidResolvedCwd(entry.cwd, resolution)) {
          skips.push({ name, reason: `"cwd" escapes the plugin root or is not a contained relative path` });
          continue;
        }
        cwd = resolve(expandPlaceholders(entry.cwd, resolution).value);
        if (
          isAbsolute(cwd) &&
          !(await isSymlinkSafeContained(
            /\$\{PLUGIN_DATA\}/.test(entry.cwd) ? resolution.pluginData! : resolution.pluginRoot,
            cwd,
          ))
        ) {
          skips.push({ name, reason: `"cwd" escapes through a symlink` });
          continue;
        }
      }
      // Spec default: the plugin root is the working directory when no
      // explicit contained cwd is configured (§7.2.1).
      const server: StdioServer = { command };
      if (entry.args !== undefined) server.args = expandedArgs.value;
      // Client-supplied reserved variables override configured env values and
      // are applied AFTER them (§9.1); env KEYS are never expanded.
      server.env = {
        ...(entry.env !== undefined ? expandedEnv.value : {}),
        PLUGIN_ROOT: resolution.pluginRoot,
        PLUGIN_DATA: resolution.pluginData,
      };
      server.cwd = cwd ?? resolution.pluginRoot;
      servers.push({ name, server });
    } else {
      // url/headers never receive placeholder expansion and were already
      // validated by the closed-schema check above.
      const server: HttpServer = {
        type: entry.type === "sse" ? "sse" : "http",
        url: entry.url,
      };
      if (entry.headers !== undefined) server.headers = entry.headers;
      servers.push({ name, server });
    }
  }
  return { servers, skips };
}


// Read a standard `.mcp.json`-shaped file → its `mcpServers` map. A malformed or
// missing file yields null (best-effort; a broken bundle never aborts a mirror).
async function readServerMap(file: string): Promise<Record<string, unknown> | null> {
  let data: unknown;
  try {
    data = await readJson(file);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const field = (data as Record<string, unknown>).mcpServers;
  return field && typeof field === "object" && !Array.isArray(field) ? (field as Record<string, unknown>) : null;
}

// The `mcpServers` declared by a plugin's manifest. Per the plugin spec the field
// is `object | string | array`: an inline server map, a relative path to a
// `.mcp.json` file, or a list of such paths.
async function manifestServers(root: string): Promise<Record<string, unknown>> {
  let manifest: Record<string, unknown> | null = null;
  for (const rel of [".claude-plugin/plugin.json", "plugin.json"]) {
    try {
      const data = await readJson<Record<string, unknown>>(join(root, rel));
      if (data && typeof data === "object") {
        manifest = data;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  const field = manifest?.mcpServers;
  if (!field) return {};
  if (typeof field === "object" && !Array.isArray(field)) return field as Record<string, unknown>;
  const paths = typeof field === "string"
    ? [field]
    : Array.isArray(field)
      ? field.filter((p): p is string => typeof p === "string")
      : [];
  const out: Record<string, unknown> = {};
  for (const rel of paths) {
    if (rel.includes("..")) continue; // never read outside the plugin dir
    const map = await readServerMap(join(root, rel));
    if (map) Object.assign(out, map);
  }
  return out;
}

// Resolve the MCP servers bundled inside the given installed plugins. Each plugin's
// `path` is its install dir (Claude's `installPath`), used both to locate `.mcp.json`
// / the manifest / the canonical root `mcp.json` and to resolve placeholders. A
// plugin with no known path is skipped silently (nothing to read). The canonical
// Agent Plugins v1 root manifest gates the root `mcp.json`: it is parsed only when
// that manifest is present and valid, while legacy `.mcp.json` and manifest-inline
// sources keep their existing behavior. First plugin wins a duplicate server
// name; a conflicting duplicate from a later plugin is reported as skipped.
// Canonical lifted servers pass through the SAME stable-stringify first-wins
// gate as legacy servers, so canonical/canonical and canonical/legacy name
// collisions can never silently last-write-win downstream.
export async function resolvePluginMcpServers(
  plugins: PluginRecord[],
  opts: { dataRoot?: string; dataHome?: PluginMcpDataHome } = {},
): Promise<PluginMcpResolution> {
  const servers: PluginMcpServer[] = [];
  const skipped: PluginMcpSkip[] = [];
  const seen = new Map<string, string>();
  // `dataRoot` remains the opt-in create form; `dataHome` carries the explicit
  // preview/create intent used by the production lifecycle. Default read-only.
  const dataHomeMode: PluginMcpDataHome =
    opts.dataHome ??
    (opts.dataRoot !== undefined
      ? { intent: "create", dataRoot: opts.dataRoot }
      : { intent: "none" });

  for (const plugin of plugins) {
    const root = plugin.path;
    if (!root) continue;

    // Validate/resolve the real root and the root manifest BEFORE any parse.
    // An unsafe root cannot be classified as canonical, so legacy readers (the
    // hardened walk elsewhere) keep their existing behavior; a present but
    // unsafe or non-regular plugin.json rejects the package components.
    let v1State: "absent" | "valid" | "invalid" = "absent";
    let realRoot: string | undefined;
    const resolved = await resolveRealRoot(root);
    if (resolved.state === "ok") {
      realRoot = resolved.realRoot;
      const manifestFile = await readFixedPackageFile(realRoot, "plugin.json");
      if (manifestFile.kind === "invalid") {
        v1State = "invalid";
        skipped.push({
          plugin: plugin.name,
          name: "*",
          reason: `invalid plugin.json: ${manifestFile.reason}; package components rejected`,
        });
      } else if (manifestFile.kind === "ok") {
        v1State = classifyCanonicalManifest(manifestFile.text);
      }
    }

    if (v1State === "invalid") {
      if (!skipped.some((s) => s.plugin === plugin.name && s.name === "*")) {
        skipped.push({
          plugin: plugin.name,
          name: "*",
          reason: "canonical Agent Plugins v1 manifest is invalid; package components rejected",
        });
      }
      continue;
    }
    if (v1State === "valid" && realRoot !== undefined) {
      // A canonical package takes its MCP configuration ONLY from the root
      // mcp.json; legacy .mcp.json and manifest-inline sources are ignored.
      const mcpFile = await readFixedPackageFile(realRoot, CANONICAL_MCP_PATH);
      if (mcpFile.kind === "invalid") {
        skipped.push({
          plugin: plugin.name,
          name: "*",
          reason: `invalid ${CANONICAL_MCP_PATH}: ${mcpFile.reason}; MCP disabled`,
        });
      } else if (mcpFile.kind === "ok") {
        let document: unknown;
        try {
          document = JSON.parse(mcpFile.text);
        } catch {
          skipped.push({
            plugin: plugin.name,
            name: "*",
            reason: `invalid ${CANONICAL_MCP_PATH}: not readable JSON; MCP disabled`,
          });
          continue;
        }
        const validated = validateMcpDocumentV1(document);
        if (validated.documentError) {
          // An invalid mcp.json disables MCP for this file only — valid
          // skills and plugin identity remain untouched.
          skipped.push({ plugin: plugin.name, name: "*", reason: `invalid ${CANONICAL_MCP_PATH}: ${validated.documentError}` });
        } else {
          for (const [name, reason] of validated.serverErrors) {
            skipped.push({ plugin: plugin.name, name, reason });
          }
          // The secure PLUGIN_DATA directory is resolved per intent: preview
          // computes+validates the exact path without creating anything,
          // create securely materializes it at 0700, and the read-only
          // default makes no writes at all.
          const needsDataHome = [...validated.servers.values()].some((s) => s.type === "stdio");
          let pluginData: string | undefined;
          if (needsDataHome && dataHomeMode.intent === "preview") {
            pluginData = await previewPluginDataDir(dataHomeMode.dataRoot, plugin);
          } else if (needsDataHome && dataHomeMode.intent === "create") {
            pluginData = await ensurePluginDataDir(dataHomeMode.dataRoot, plugin);
          }
          const resolution: PlaceholderResolution = {
            // §9.1: the emitted PLUGIN_ROOT is the filesystem-resolved root.
            pluginRoot: realRoot,
            ...(pluginData !== undefined ? { pluginData } : {}),
          };
          const lifted = await liftV1Servers(plugin, validated, resolution);
          // Canonical servers go through the SAME first-wins /
          // conflicting-skip gate as legacy servers so a name collision
          // between canonical packages — or across a canonical and a legacy
          // package, in either order — is preserved, never last-write-wins.
          for (const liftedItem of lifted.servers) {
            const canonicalForm = stableStringify(liftedItem.server);
            const prior = seen.get(liftedItem.name);
            if (prior !== undefined) {
              if (prior !== canonicalForm) {
                skipped.push({
                  plugin: plugin.name,
                  name: liftedItem.name,
                  reason: "duplicate server name with a different config in another plugin",
                });
              }
              continue;
            }
            seen.set(liftedItem.name, canonicalForm);
            servers.push({ plugin: plugin.name, marketplace: plugin.marketplace, ...liftedItem });
          }
          skipped.push(...lifted.skips.map((s) => ({ plugin: plugin.name, ...s })));
        }
      }
      continue;
    }

    const fromMcpJson = (await readServerMap(join(root, ".mcp.json"))) ?? {};
    const fromManifest = await manifestServers(root);
    const merged: Record<string, unknown> = { ...fromMcpJson, ...fromManifest };

    for (const [name, rawDef] of Object.entries(merged)) {
      if (!name) continue;
      const server = coerceServer(substituteRoot(rawDef, root));
      if (!server) {
        skipped.push({ plugin: plugin.name, name, reason: "unrecognized MCP server shape" });
        continue;
      }
      if (hasUnresolvedClaudeVar(server)) {
        skipped.push({ plugin: plugin.name, name, reason: "references a Claude-only variable with no value outside Claude" });
        continue;
      }
      const canonical = stableStringify(server);
      const prior = seen.get(name);
      if (prior !== undefined) {
        if (prior !== canonical) {
          skipped.push({ plugin: plugin.name, name, reason: "duplicate server name with a different config in another plugin" });
        }
        continue;
      }
      seen.set(name, canonical);
      servers.push({ plugin: plugin.name, marketplace: plugin.marketplace, name, server });
    }
  }

  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { servers, skipped };
}
