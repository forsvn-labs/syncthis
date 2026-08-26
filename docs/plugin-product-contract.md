# Syncthis product contract

This document defines the public meaning of Syncthis. Syncthis is a plugin-first sync, adaptation, and verification layer; it is not a collection of unrelated host-config managers.

## Upstream relationship

[Agent Plugins](https://agent-plugins.org/) is the canonical plugin model. Syncthis adopts that model and begins at the portability boundary: a plugin is already installed or otherwise available through an authoritative client, and Syncthis makes that plugin usable across other supported clients.

Agent Plugins v1.0.0 is an open portable **directory package spec**, precisely:

- a required root `plugin.json` manifest;
- optional immediate `skills/*/SKILL.md` directories and an optional root `mcp.json`;
- per-client extension files layered by individual clients.

That is all v1 defines. It has **no** portable install/update/uninstall registry, no secrets or OAuth protocol, no arbitrary settings schema, and no hooks/agents/rules/LSP contract. Describing it as anything more overclaims.

Syncthis must not fork the Agent Plugins manifest, publish a competing registry, or redefine upstream installation semantics. Upstream plugin identity and contents remain authoritative; Syncthis owns only cross-client discovery, source-independent packaging, target adaptation, reconciliation, verification, configuration (enable/disable), removal, diagnostics, and reporting.

## Compatibility note

The executable remains `syncthis`, the npm package remains `@forsvn/syncthis`, repository URLs remain unchanged, and existing config paths, `SYNCTHIS_*` environment variables, and `.syncthis.bak` backup identifiers remain compatible.

## Public model

The only public object is an **installed plugin**. A plugin has a source identity, provenance, an optional local artifact, and a target-specific outcome. Public commands, menus, README copy, and package metadata must describe plugins, native activation, or target-specific adaptation.

A host record is authoritative only when it comes from a readable native plugin source. A generic directory, a copied file, or an individual bundled component is not an installed plugin record. The default sync discovers records from every readable native source; it does not ask the user to choose one source or one plugin before reconciling.

## Canonical target outcomes

Every target reports exactly one product-level outcome for a requested plugin:

- **native** — the target's readable native runtime reports the requested plugin after apply (or a dry-run plans that native path).
- **adapted** — the plugin is usable through a supported target-specific adaptation, without claiming readable native activation.
- **partial** — some requested plugin capability reached the target, but another native or adapted component was incomplete.
- **blocked** — an attempted source read, target write, install, or required verification step did not complete.
- **unsupported** — positive evidence says the target ABI or plugin artifact cannot represent the requested form and no usable projection completed.

The detailed native and projection statuses remain available for diagnostics; this five-value outcome is the canonical product vocabulary. Cursor is write-only, so a successful push is **adapted** with an explicit unverified-activation annotation, never **native**.

## Fresh read-back requirement

For every readable native target, an apply is incomplete until Syncthis performs a fresh read from the target's authoritative plugin registry. The installer exit code is only an action result; it is not proof of activation. The post-apply read must identify the requested plugin or a verified canonical covering identity. If it does not, the outcome is blocked.

Dry-run uses the target's preview contract where available and must not imply that an apply was verified. A target that cannot be read remains explicitly write-only or unsupported according to its registered ABI, never silently promoted to native.

## Source discovery and provenance

The proven readable native sources are:

- `claude-code`
- `codex`
- `github-copilot`
- `grok-build`

The default sync reads all four sources that are available, merges their installed evidence by artifact identity, and reconciles the resulting plugin set. An empty or failed source read is reported honestly rather than silently treated as an empty source. Each eligible artifact is materialized into a managed, source-independent package store before apply, so target installation does not depend on a mutable client cache. The retained `--from <primary>` form is only a compatibility path for bounded plugin add; it is not the default architecture.

## Target-specific ABI

Native support is target-specific. A target enters the verified native registry only after its list, install, uninstall, and post-apply read contracts are proven. The target adapter owns its identifiers, marketplace rules, config path, and fresh read-back semantics.

A target without a proven native ABI may receive a target-specific adaptation when the artifact supports it. That translation is scoped to the exact target and never changes the source plugin's identity or upgrades the target's status to native.

Grok Build belongs in the verified registry on the strength of Syncthis's own proven evidence: its `grok plugin` CLI exposes list (readable JSON state), install, enable, uninstall, and update operations, each verifiable with a fresh read-back, and Syncthis installs an exact local artifact when available, grants trust explicitly as part of the user-requested sync, enables the installed identity, and requires a fresh `grok plugin list --json` read before reporting `native`. xAI's official documentation describes Grok Build as a Claude Code-lineage CLI and does not claim agent-plugins.org or root `plugin.json` conformance; the registry entry therefore rests on that proven CLI/read-back/translation evidence, never on an upstream certification claim.

Prime Agent and Pi consume Agent Skills from the shared `~/.agents/skills` store but do not expose an Agent Plugin ABI. Cline exposes a separate TypeScript plugin ABI; that ABI is not interchangeable with Agent Plugins. These targets may therefore report `adapted` only when a plugin's skill payload is successfully surfaced, `partial` when only part of the payload lands, or `unsupported` when no compatible payload exists.

## Cursor limitation

Cursor accepts the root Agent Plugins manifest natively today. However, Syncthis has not integrated a verified, readable native lifecycle or activation contract for Cursor: there is no proven installed-plugin read or post-apply activation read-back. Cursor is therefore treated as a conservative write/adaptation target — never reported as readable or natively verified, and never promoted to `native`. That limitation describes Syncthis's integration boundary, not a Cursor capability gap; later operations must preserve it instead of inventing observed state.

## Per-client compatibility truth

- **Claude Code** consumes plugins through its `.claude-plugin` overlay and its own scoped plugin CLI (`claude plugin …` with `--scope user|project|local`). That overlay-plus-scoped-CLI contract is what Syncthis reads and drives; it is not a generic directory drop.
- **Grok Build** is Claude-lineage and compatible with the package format in practice, but xAI's official documentation does not claim agent-plugins.org conformance. Syncthis relies only on the proven `grok plugin` CLI contract and claims nothing about upstream certification.
- **OpenAI** authoring exposes `.codex-plugin` overlay files even while Agent Plugins lists ChatGPT/Codex as compatible. Syncthis reads only what the Codex CLI itself reports.
- **OpenCode** plugins are hook modules, not Agent Plugins packages. Syncthis adapts a plugin's portable content for OpenCode and never claims OpenCode hosts Agent Plugins natively.

## Private translation boundary

Private translation may use bundled implementation definitions to adapt a plugin for hosts that cannot load the original plugin format. Those are implementation details, not public product categories or statuses. Loose projection fragments never count as installed plugins, never satisfy a native read-back, and never become independent top-level products in the public interface.
