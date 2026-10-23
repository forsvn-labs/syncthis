# Syncthis vision

Install a plugin once. Use it everywhere.

Syncthis helps people using several coding agents carry one canonical
plugin installation across clients. It owns discovery, adaptation,
configuration, reconciliation, verification, and reporting. Success means
each plugin's capabilities are preserved where supported, with drift and
capability loss visible before changes are applied.

## Scope

Discover installed plugins from readable native hosts; plan before
writes; apply explicit, reversible changes through the appropriate
target contract; and verify native activation with a fresh authoritative
read. Keep CLI and interactive hub outcomes consistent. Directory
inventory alone never proves activation. Cursor remains write-only
until a readable, testable lifecycle contract exists.

## Non-goals

Agent Plugins owns the model. Syncthis does not create another manifest,
plugin standard, hosted registry, or marketplace. It does not silently
convert away capabilities or claim native parity from a copied directory.
See the [product contract](app/docs/plugin-product-contract.md) for exact
outcomes and [STATUS.md](STATUS.md) for current work.
