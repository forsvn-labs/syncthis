# Vision

Owner: Hung · Confirmed: 2026-10-23 (accepted in PR #13; restructured 2026-11-01)

Install a plugin once. Use it everywhere.

## Why it exists

Carry one canonical plugin installation across clients.

## Who it is for

People using several coding agents.

## The outcome that matters most

Each plugin's capabilities are preserved where supported, with drift and
capability loss visible before changes are applied.

## What done looks like

Syncthis owns discovery, adaptation, configuration, reconciliation,
verification, and reporting. Keep CLI and interactive hub outcomes consistent.

## Principles

- Discover installed plugins from readable native hosts.
- Plan before writes. Apply explicit, reversible changes through the
  appropriate target contract.
- Verify native activation with a fresh authoritative read. Directory
  inventory alone never proves activation.
- Cursor remains write-only until a readable, testable lifecycle contract exists.

## Out of scope

Agent Plugins owns the model. Syncthis does not create another manifest,
plugin standard, hosted registry, or marketplace. It does not silently
convert away capabilities or claim native parity from a copied directory.
See the [product contract](app/docs/plugin-product-contract.md) for exact
outcomes.

## Direction changes

- 2026-11-01: PROGRESS replaces STATUS for current work. Product direction is unchanged.
- 2026-10-23: Four root records adopted in [PR #13](https://github.com/forsvn-labs/syncthis/pull/13).
