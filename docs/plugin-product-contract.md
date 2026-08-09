# Plugin product contract

This document defines the public meaning of syncthis. The product is a plugin-first sync, adaptation, and verification layer; it is not a collection of unrelated host-config managers.

## Upstream relationship

[Agent Plugins](https://agent-plugins.org/) is the canonical plugin model. Syncthis adopts that model and begins at the portability boundary: a plugin is already installed or otherwise available through an authoritative client, and syncthis makes that plugin usable across other supported clients.

Syncthis must not fork the Agent Plugins manifest, publish a competing registry, or redefine upstream installation semantics. Upstream plugin identity and contents remain authoritative; syncthis owns only cross-client discovery, source-independent packaging, target adaptation, reconciliation, verification, and reporting.

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

For every readable native target, an apply is incomplete until syncthis performs a fresh read from the target's authoritative plugin registry. The installer exit code is only an action result; it is not proof of activation. The post-apply read must identify the requested plugin or a verified canonical covering identity. If it does not, the outcome is blocked.

Dry-run uses the target's preview contract where available and must not imply that an apply was verified. A target that cannot be read remains explicitly write-only or unsupported according to its registered ABI, never silently promoted to native.

## Source discovery and provenance

The proven readable native sources are:

- `claude-code`
- `codex`
- `github-copilot`

The default sync reads all three sources that are available, merges their installed evidence by artifact identity, and reconciles the resulting plugin set. An empty or failed source read is reported honestly rather than silently treated as an empty source. Each eligible artifact is materialized into a managed, source-independent package store before apply, so target installation does not depend on a mutable client cache. The retained `--from <primary>` form is only a compatibility path for bounded plugin add; it is not the default architecture.

## Target-specific ABI

Native support is target-specific. A target enters the verified native registry only after its list, install, uninstall, and post-apply read contracts are proven. The target adapter owns its identifiers, marketplace rules, config path, and fresh read-back semantics.

A target without a proven native ABI may receive a target-specific adaptation when the artifact supports it. That translation is scoped to the exact target and never changes the source plugin's identity or upgrades the target's status to native.

## Cursor limitation

Cursor can receive a plugin push, but syncthis cannot read a reliable installed-plugin list from Cursor. Cursor is therefore write-only and unverified. Lists, diffs, and fresh-read guarantees do not claim Cursor activation; later operations must preserve that limitation instead of inventing observed state.

## Private translation boundary

Private translation may use bundled implementation definitions to adapt a plugin for hosts that cannot load the original plugin format. Those are implementation details, not public product categories or statuses. Loose projection fragments never count as installed plugins, never satisfy a native read-back, and never become independent top-level products in the public interface.
