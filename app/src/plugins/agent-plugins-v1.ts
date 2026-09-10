// Agent Plugins Specification v1.0.0 core compliance.
//
// The canonical package format puts an identity-authoritative manifest at the
// plugin ROOT (`plugin.json` with an exact `$schema` match) ahead of any
// client-native overlay directories (.codex-plugin/.claude-plugin/.plugin/
// .cursor-plugin). MCP configuration lives in a root `mcp.json` with its own
// closed schema. This module owns validation of those two closed documents and
// the narrow ${PLUGIN_ROOT}/${PLUGIN_DATA} expansion rules; Syncthis keeps its
// legacy client-format readers elsewhere untouched.

import { lstat, mkdir, chmod, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const AGENT_PLUGINS_SPEC_VERSION = "1.0.0";
export const AGENT_PLUGINS_SPEC_URL =
  "https://agent-plugins.org/specification";
export const PLUGIN_MANIFEST_SCHEMA_V1 =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const PLUGIN_MCP_SCHEMA_V1 =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

export const CANONICAL_MANIFEST_PATH = "plugin.json";
export const CANONICAL_MCP_PATH = "mcp.json";

const MANIFEST_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const MANIFEST_PERMITTED_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);
const AUTHOR_PERMITTED_FIELDS = new Set(["name", "email", "url"]);

export function isValidPluginNameV1(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 64 &&
    MANIFEST_NAME_PATTERN.test(name) &&
    !name.includes("--") &&
    !name.includes("..")
  );
}

// Detect an Agent Plugins family schema identifier and return its version.
// A different published version than the locally supported one is reported
// as explicitly unsupported instead of being treated as legacy client data.
const AGENT_PLUGINS_SCHEMA_PATTERN =
  /^https:\/\/agent-plugins\.org\/schemas\/([^/]+)\/(plugin|mcp)\.schema\.json$/;

export function agentPluginsSchemaVersion(
  schemaId: unknown,
  kind: "plugin" | "mcp",
): string | null {
  if (typeof schemaId !== "string") return null;
  const match = AGENT_PLUGINS_SCHEMA_PATTERN.exec(schemaId);
  return match && match[2] === kind ? (match[1] ?? null) : null;
}

export function isSupportedAgentPluginsSchema(schemaId: unknown, kind: "plugin" | "mcp"): boolean {
  const version = agentPluginsSchemaVersion(schemaId, kind);
  return version === null || version === AGENT_PLUGINS_SPEC_VERSION;
}

function stringFields(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export type V1DocumentDiagnostics = {
  errors: string[];
  warnings: string[];
};

export type V1ManifestValidation = V1DocumentDiagnostics & {
  // True only for an object whose $schema exactly matches the v1 manifest
  // schema identifier — i.e. a document that claims canonical identity.
  canonical: boolean;
  valid: boolean;
  name: string | null;
};

// Validate one parsed plugin.json against the closed v1 manifest schema.
// Unknown top-level fields are warnings that never fail the document; wrong
// types on permitted fields, a bad name, or bad author metadata are fatal.
export function validatePluginManifestV1(raw: unknown): V1ManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const record = stringFields(raw);
  if (!record) {
    return {
      canonical: false,
      valid: false,
      name: null,
      errors: ["plugin.json must contain a JSON object"],
      warnings,
    };
  }
  const canonical = record.$schema === PLUGIN_MANIFEST_SCHEMA_V1;
  if (!canonical) return { canonical: false, valid: false, name: null, errors, warnings };

  for (const key of Object.keys(record)) {
    if (!MANIFEST_PERMITTED_FIELDS.has(key)) {
      warnings.push(`unknown top-level field "${key}" is ignored`);
    }
  }

  let name: string | null = null;
  if (!isValidPluginNameV1(record.name)) {
    errors.push(
      '"name" must be 1-64 lowercase a-z, 0-9, "." or "-" characters, start and end alphanumeric, without "--" or ".."',
    );
  } else {
    name = record.name;
  }

  for (const key of ["version", "description", "homepage", "repository", "license"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      errors.push(`"${key}" must be a string`);
    }
  }
  if (record.keywords !== undefined) {
    if (!Array.isArray(record.keywords) || record.keywords.some((k) => typeof k !== "string")) {
      errors.push('"keywords" must be an array of strings');
    }
  }
  if (record.author !== undefined) {
    const author = stringFields(record.author);
    if (!author) {
      errors.push('"author" must be an object');
    } else {
      for (const key of Object.keys(author)) {
        if (!AUTHOR_PERMITTED_FIELDS.has(key)) {
          errors.push(`"author" field "${key}" is not permitted; use only name, email, url`);
        } else if (typeof author[key] !== "string") {
          errors.push(`"author"."${key}" must be a string`);
        }
      }
    }
  }
  if (record.extensions !== undefined && !stringFields(record.extensions)) {
    warnings.push('"extensions" must be an object; the value is ignored');
  }
  // Values under known reverse-domain namespaces are client-owned and are
  // deliberately NOT validated here.

  return { canonical: true, valid: errors.length === 0, name, errors, warnings };
}

// ---- mcp.json -------------------------------------------------------------

export type StdioServerV1 = {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type RemoteServerV1 = {
  type: "streamable-http" | "sse";
  url: string;
  headers?: Record<string, string>;
};

export type McpServerV1 = StdioServerV1 | RemoteServerV1;

export type V1McpDocumentValidation = {
  // A non-null document error disables MCP for this plugin entirely while
  // leaving plugin identity and skills intact.
  documentError: string | null;
  servers: Map<string, McpServerV1>;
  serverErrors: Map<string, string>;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackUrl(url: URL): boolean {
  return (
    LOOPBACK_HOSTS.has(url.hostname) ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  );
}

// A stdio command is ONE bare executable token or one "./"-prefixed path kept
// inside the plugin root. Placeholders are never expanded into it.
export function isValidStdioCommandV1(command: string): boolean {
  if (!command || command.includes("\0")) return false;
  if (/[$]/.test(command)) return false;
  if (command.startsWith("./")) {
    const rest = command.slice(2);
    return rest.split("/").every((part) => part !== "" && part !== "." && part !== "..");
  }
  if (command.includes("/") || command.includes("\\")) return false;
  return command !== "." && command !== "..";
}

// Validate one parsed mcp.json against the closed v1 MCP schema. Per-server
// failures are isolated: an invalid entry is skipped and reported while valid
// siblings survive.
export function validateMcpDocumentV1(raw: unknown): V1McpDocumentValidation {
  const servers = new Map<string, McpServerV1>();
  const serverErrors = new Map<string, string>();
  const record = stringFields(raw);
  if (!record) {
    return {
      documentError: "mcp.json must contain a JSON object",
      servers,
      serverErrors,
    };
  }
  if (record.$schema !== PLUGIN_MCP_SCHEMA_V1) {
    const version = agentPluginsSchemaVersion(record.$schema, "mcp");
    return {
      documentError: version
        ? `unsupported Agent Plugins MCP schema version ${version}; supported: ${AGENT_PLUGINS_SPEC_VERSION}`
        : `"${CANONICAL_MCP_PATH}" $schema does not match ${PLUGIN_MCP_SCHEMA_V1}`,
      servers,
      serverErrors,
    };
  }
  const permitted = new Set(["$schema", "mcpServers"]);
  for (const key of Object.keys(record)) {
    if (!permitted.has(key)) {
      return {
        documentError: `unknown top-level field "${key}" in ${CANONICAL_MCP_PATH}`,
        servers,
        serverErrors,
      };
    }
  }
  const map = stringFields(record.mcpServers);
  if (!map) {
    return {
      documentError: '"mcpServers" must be an object of server entries',
      servers,
      serverErrors,
    };
  }
  for (const [name, rawServer] of Object.entries(map)) {
    const error = validateMcpServerEntry(name, rawServer, servers);
    if (error) serverErrors.set(name, error);
  }
  return { documentError: null, servers, serverErrors };
}

function validateMcpServerEntry(
  name: string,
  rawServer: unknown,
  servers: Map<string, McpServerV1>,
): string | null {
  const entry = stringFields(rawServer);
  if (!entry) return "server entry must be an object";
  const type = entry.type;
  if (type === "stdio") return validateStdioEntry(entry, servers, name);
  if (type === "streamable-http" || type === "sse") {
    return validateRemoteEntry(type, entry, servers, name);
  }
  return `"type" must be stdio, streamable-http or sse`;
}

// The schema is closed: a variant accepts only its own declared fields.
const STDIO_FIELDS = new Set(["type", "command", "args", "env", "cwd"]);
const REMOTE_FIELDS = new Set(["type", "url", "headers"]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function validateStdioEntry(
  entry: Record<string, unknown>,
  servers: Map<string, McpServerV1>,
  name: string,
): string | null {
  for (const key of Object.keys(entry)) {
    if (!STDIO_FIELDS.has(key)) return `"${key}" is not a permitted stdio field`;
  }
  const command = entry.command;
  if (typeof command !== "string" || !isValidStdioCommandV1(command)) {
    return '"command" must be one bare executable name or a contained "./"-relative path';
  }
  const server: StdioServerV1 = { type: "stdio", command };
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== "string")) {
      return '"args" must be an array of strings';
    }
    server.args = entry.args as string[];
  }
  if (entry.env !== undefined) {
    const env = stringFields(entry.env);
    if (!env || Object.values(env).some((v) => typeof v !== "string")) {
      return '"env" must be an object of strings';
    }
    for (const key of Object.keys(env)) {
      if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA") {
        return `"env" entry "${key}" uses a reserved variable name`;
      }
    }
    server.env = env as Record<string, string>;
  }
  if (entry.cwd !== undefined) {
    if (typeof entry.cwd !== "string") return '"cwd" must be a string';
    server.cwd = entry.cwd;
  }
  servers.set(name, server);
  return null;
}

function validateRemoteEntry(
  type: "streamable-http" | "sse",
  entry: Record<string, unknown>,
  servers: Map<string, McpServerV1>,
  name: string,
): string | null {
  for (const key of Object.keys(entry)) {
    if (!REMOTE_FIELDS.has(key)) return `"${key}" is not a permitted ${type} field`;
  }
  const urlText = entry.url;
  if (typeof urlText !== "string" || !urlText) return '"url" must be a string';
  if (/\$\{PLUGIN_(ROOT|DATA)\}/.test(urlText)) {
    return '"url" must not contain placeholders';
  }
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return '"url" must be a valid absolute URL';
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return '"url" must use http or https';
  }
  if (url.username || url.password) {
    return '"url" must not embed userinfo; use client-managed authentication';
  }
  if (url.hash) {
    return '"url" must not contain a fragment';
  }
  if (url.protocol === "http:" && !isLoopbackUrl(url)) {
    return '"url" may use plain http only for loopback hosts';
  }
  const server: RemoteServerV1 = { type, url: urlText };
  if (entry.headers !== undefined) {
    const headers = stringFields(entry.headers);
    if (!headers || Object.values(headers).some((v) => typeof v !== "string")) {
      return '"headers" must be an object of strings';
    }
    const seen = new Set<string>();
    for (const key of Object.keys(headers)) {
      if (!HEADER_NAME_PATTERN.test(key)) {
        return `"headers" name "${key}" is not a valid HTTP field name`;
      }
      const folded = key.toLowerCase();
      if (seen.has(folded)) return `"headers" contains duplicate names differing only by case ("${key}")`;
      seen.add(folded);
      const value = headers[key] as string;
      // Field values must be printable ASCII without control characters or
      // line breaks (no header injection).
      if (/[\r\n\0]/.test(value) || /[^\x20-\x7E]/.test(value)) {
        return `"headers" value for "${key}" contains forbidden characters`;
      }
      if (/\$\{PLUGIN_(ROOT|DATA)\}/.test(value)) {
        return '"headers" must not contain placeholders';
      }
    }
    server.headers = headers as Record<string, string>;
  }
  servers.set(name, server);
  return null;
}

// ---- placeholder expansion ------------------------------------------------

export type PlaceholderResolution = {
  pluginRoot: string;
  // Absent means this runtime has no managed persistent data directory for
  // the plugin; ${PLUGIN_DATA} references then stay unexpanded.
  pluginData?: string;
};

export type ExpansionResult<in out T> = {
  value: T;
  unresolvedData: boolean;
};

// Expand ONLY ${PLUGIN_ROOT} and ${PLUGIN_DATA}, in one pass, everywhere in a
// string. Unknown placeholder-like text stays literal. A ${PLUGIN_DATA}
// reference with no managed data directory marks the result unresolved so the
// caller can skip the server with an explicit partial reason instead of
// writing a config that would silently fail.
export function expandPlaceholders<T>(input: T, resolution: PlaceholderResolution): ExpansionResult<T> {
  let unresolvedData = false;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_match, which: string) => {
        if (which === "ROOT") return resolution.pluginRoot;
        if (resolution.pluginData === undefined) {
          unresolvedData = true;
          return _match;
        }
        return resolution.pluginData;
      });
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      // Env KEYS are fixed names, never expanded.
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return { value: walk(input) as T, unresolvedData };
}

export function referencesPluginData(value: unknown): boolean {
  return /\$\{PLUGIN_DATA\}/.test(JSON.stringify(value) ?? "");
}

// True when target stays inside base after resolution. The exact base itself
// is contained: an exact ${PLUGIN_ROOT} or ${PLUGIN_DATA} cwd names a valid
// contained root.
export function isContainedPath(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target));
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

// Filesystem-boundary containment: resolves symlinks (of the target or, when
// the final component is missing, of its deepest existing ancestor) so a
// link cannot smuggle a path outside base even though it looks contained
// lexically.
export async function isSymlinkSafeContained(base: string, target: string): Promise<boolean> {
  const realBase = await realpath(resolve(base)).catch(() => null);
  if (!realBase) return false;
  let probe = resolve(target);
  // Segments below the deepest existing ancestor, outermost-first, rebuilt
  // under the ancestor's real path once it resolves.
  const tail: string[] = [];
  for (;;) {
    try {
      const realProbe = await realpath(probe);
      return isContainedPath(realBase, join(realProbe, ...tail));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
      tail.unshift(basename(probe));
      const parent = dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

// Validate an explicit cwd form AFTER placeholder expansion: it must be either
// a "${PLUGIN_ROOT}"/"${PLUGIN_DATA}"-rooted location or an explicit "./"
// plugin-relative path (a bare name like "data" is not a plugin-relative
// path). A ${PLUGIN_ROOT}-rooted cwd must resolve inside the plugin root and a
// ${PLUGIN_DATA}-rooted cwd must resolve inside the managed data directory.
export function isValidResolvedCwd(cwd: string, resolution: PlaceholderResolution): boolean {
  const usesData = /\$\{PLUGIN_DATA\}/.test(cwd);
  const usesRoot = /\$\{PLUGIN_ROOT\}/.test(cwd);
  const expanded = expandPlaceholders(cwd, resolution).value;
  const placeholderRooted = expanded !== cwd;
  if (!placeholderRooted && !cwd.startsWith("./")) return false;
  if (!placeholderRooted) {
    return isContainedPath(resolution.pluginRoot, resolve(resolution.pluginRoot, expanded));
  }
  if (!isAbsolute(expanded)) return false;
  if (usesData && resolution.pluginData !== undefined) {
    if (usesRoot) {
      // Mixed roots cannot be contained in both bases; reject.
      return false;
    }
    return isContainedPath(resolution.pluginData, expanded);
  }
  return isContainedPath(resolution.pluginRoot, expanded);
}

export function defaultPluginDataDir(dataRoot: string, fingerprint: string): string {
  return join(dataRoot, "syncthis", "plugin-data", fingerprint);
}

// Shared safety walk for the private-directory helpers below.
//
// Trust boundary = the DECLARED base once it exists as a real directory.
// Harmless system symlink ANCESTORS above the boundary (e.g. /var on macOS,
// or a configured XDG home under a symlinked path) are resolved exactly once
// via realpath. When the base itself is missing — a legitimate first run
// where SYNCTHIS_DATA_HOME/XDG/default has never been created — the deepest
// EXISTING ancestor is resolved instead and the missing base components
// become part of the planned creation chain.
//
// EVERY component at/below the boundary must be a REAL directory: a symlink
// anywhere at/below the boundary is rejected outright. Probing parent chains
// with plain lstat would follow intermediate symlinks (lstat only skips the
// FINAL component), letting base/link/existing redirect creation outside;
// walking component-by-component closes that bypass.
//
// Returns the verified real boundary, the target spelled under it, the
// deepest verified existing directory, and every missing segment (boundary
// base components included) so callers choose preview vs create.
async function surveyPrivateDirectory(
  base: string,
  segments: string[],
): Promise<
  | { state: "unsafe" }
  | {
      state: "ok";
      anchorReal: string;
      declaredBase: string;
      target: string;
      missing: string[];
      deepest: string;
    }
> {
  const baseAbs = resolve(base);
  let anchorLexical: string;
  let baseRelParts: string[];
  try {
    const baseInfo = await lstat(baseAbs);
    if (baseInfo.isSymbolicLink() || !baseInfo.isDirectory()) return { state: "unsafe" };
    // Existing base: the boundary is the base itself; nothing above it is
    // touched beyond resolving its own harmless ancestors via realpath.
    anchorLexical = baseAbs;
    baseRelParts = [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { state: "unsafe" };
    // Missing base (legitimate first run): anchor on the deepest EXISTING
    // ancestor; every component from there down to the base becomes part of
    // the validated/created chain.
    let probe = dirname(baseAbs);
    for (;;) {
      try {
        await lstat(probe);
        break;
      } catch (walkErr) {
        if ((walkErr as NodeJS.ErrnoException).code !== "ENOENT") return { state: "unsafe" };
        const parent = dirname(probe);
        if (parent === probe) return { state: "unsafe" };
        probe = parent;
      }
    }
    const rel = relative(probe, baseAbs);
    if (rel.startsWith("..") || isAbsolute(rel)) return { state: "unsafe" };
    anchorLexical = probe;
    baseRelParts = rel.split(sep).filter(Boolean);
  }
  let anchorReal: string;
  try {
    anchorReal = await realpath(anchorLexical);
    const anchorInfo = await lstat(anchorReal);
    if (!anchorInfo.isDirectory()) return { state: "unsafe" };
  } catch {
    return { state: "unsafe" };
  }
  const declaredBase = join(anchorReal, ...baseRelParts);
  const target = resolve(declaredBase, ...segments);
  if (!isContainedByBoundary(declaredBase, target)) return { state: "unsafe" };
  // Full component chain under the trusted anchor: base components (when the
  // declared base is missing) plus every plugin segment.
  const chainParts = [
    ...baseRelParts,
    ...relative(declaredBase, target).split(sep).filter(Boolean),
  ];
  let current = anchorReal;
  let missingStart = chainParts.length;
  for (let i = 0; i < chainParts.length; i += 1) {
    const next = join(current, chainParts[i]!);
    let info;
    try {
      info = await lstat(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { state: "unsafe" };
      missingStart = i;
      break;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return { state: "unsafe" };
    current = next;
  }
  return {
    state: "ok",
    anchorReal,
    declaredBase,
    target,
    missing: chainParts.slice(missingStart),
    deepest: current,
  };
}

function isContainedByBoundary(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Preview-side check: resolve and validate the exact private directory path
 * WITHOUT creating anything. Mirrors ensurePrivateDirectory's acceptance
 * exactly (same boundary, same per-component symlink rejection) so a preview
 * shows the precise PLUGIN_DATA path an apply would produce — and stays
 * undefined when apply would refuse. Pure read: no mkdir, no chmod.
 */
export async function validatePrivateDirectoryPath(
  base: string,
  segments: string[],
): Promise<string | undefined> {
  const surveyed = await surveyPrivateDirectory(base, segments);
  return surveyed.state === "ok" ? surveyed.target : undefined;
}

// Create or validate a private directory path under an opt-in root. Every
// component at/below the filesystem-resolved data-root boundary is checked
// individually (see surveyPrivateDirectory): an existing component must be a
// REAL directory — never a symlink — and each missing segment is created at
// 0700. After creation the whole chain is re-verified (race-safe post-check)
// and the final directory is chmod'd back to 0700. Returns undefined on any
// unsafe or impossible condition instead of following an attacker-controlled
// link or creating through one.
export async function ensurePrivateDirectory(
  base: string,
  segments: string[],
): Promise<string | undefined> {
  const surveyed = await surveyPrivateDirectory(base, segments);
  if (surveyed.state !== "ok") return undefined;
  const { anchorReal, declaredBase, target, missing, deepest } = surveyed;
  let current = deepest;
  for (const segment of missing) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
    }
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return undefined;
  }
  // Race-safe re-check: rebuild the whole chain from the trusted anchor and
  // confirm no component became (or was swapped to) a symlink. Then verify on
  // the real filesystem that the target still resolves inside BOTH the
  // resolved anchor and the declared boundary — containment, never strict
  // lexical equality (platforms may alias ancestors, e.g. /var → /private/var).
  let walker = anchorReal;
  for (const part of relative(anchorReal, target).split(sep).filter(Boolean)) {
    walker = join(walker, part);
    const info = await lstat(walker).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return undefined;
  }
  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch {
    return undefined;
  }
  if (
    !isContainedByBoundary(anchorReal, realTarget) ||
    !isContainedByBoundary(declaredBase, realTarget)
  ) {
    return undefined;
  }
  return finalizePrivateDirectory(realTarget);
}

async function finalizePrivateDirectory(dir: string): Promise<string | undefined> {
  try {
    await chmod(dir, 0o700);
    const final = await lstat(dir);
    if (final.isSymbolicLink() || !final.isDirectory() || (final.mode & 0o777) !== 0o700) {
      return undefined;
    }
    return dir;
  } catch {
    return undefined;
  }
}
