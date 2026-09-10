# Syncthis ops

Per-product business operations and marketing home for **Syncthis**: the cross-client sync, adaptation, and verification layer for [Agent Plugins](https://agent-plugins.org/).

> **Install a plugin once. Use it everywhere.**

Agent Plugins owns the plugin model. Syncthis owns portability across coding agents; skills and MCP are private adaptation mechanisms, not separate product priorities.

Native Agent Plugins coverage currently includes Claude Code, Codex, GitHub Copilot, and Grok Build. Cursor is write-only. Prime Agent, Cline, Pi, and other non-native hosts receive capability-preserving adaptations with explicit partial or unsupported outcomes when the full plugin cannot travel.

| Path | What |
|---|---|
| [`../app/`](../app/) | Private source of truth for the CLI published as `@forsvn/syncthis`. |
| [`../scripts/publish-mirror.sh`](../scripts/publish-mirror.sh) | Push-only publisher from tracked `app/` files to the public mirror. |
| [`../brand/`](../brand/) | Brand vault — **stub** (`BRAND.md` only). No identity defined yet; defaults to FORSVN house tokens until built out. |

## Wiring

Business ops here are paired with the product code/surfaces below. Machine-readable: [`product.json`](product.json).

| Surface | Dir | Repository | Distribution |
|---|---|---|---|
| Private monorepo source | `../` | `hungv47/ipse` | Source, ops, brand, and release tooling |
| Public CLI mirror | `../app/` | `forsvn-labs/syncthis` | npm [`@forsvn/syncthis`](https://www.npmjs.com/package/@forsvn/syncthis) |

The old standalone landing page is offline. Until a replacement is intentionally launched, the public mirror README and npm page are the live product surfaces. Marketing artifacts for Syncthis live here as they are created.

Shared portfolio metadata lives in `~/ipse/forsvn/achievements/`; this product directory owns only Syncthis source, brand, and operations.
