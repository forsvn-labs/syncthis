# Syncthis

Private source directory for **Syncthis** inside the `hungv47/ipse` monorepo: the cross-client sync,
adaptation, and verification layer for [Agent Plugins](https://agent-plugins.org/).

> **Install a plugin once. Use it everywhere.**

| Path | Owns |
|---|---|
| [`app/`](app/) | CLI source published to npm as `@forsvn/syncthis` and mirrored publicly to [`forsvn-labs/syncthis`](https://github.com/forsvn-labs/syncthis). |
| [`ops/`](ops/) | Product data, positioning, and marketing operations. |
| [`brand/`](brand/) | Product identity; currently inherits FORSVN house tokens. |
| [`scripts/publish-mirror.sh`](scripts/publish-mirror.sh) | Push-only export of tracked `app/` files to the public mirror. |

Agent Plugins owns the plugin model. Syncthis does not define a competing manifest or registry; it owns cross-client discovery, packaging, adaptation, configuration, reconciliation, verification, and reporting.

Syncthis reads installed plugin state from Claude Code (`.claude-plugin` overlay plus its scoped CLI), Codex, GitHub Copilot, and Grok Build. Cursor natively accepts the root Agent Plugins manifest today, but Syncthis has no verified readable native lifecycle contract for it, so Cursor stays a conservative write-only target; Prime Agent, Cline, Pi, and other non-hosting clients receive only the plugin capabilities their supported adaptation can preserve.

The public mirror is a generated distribution surface. Make product changes here, then publish the tracked `app/` tree with the mirror script.
