# Syncthis vision

Install a plugin once. Use it everywhere.

Syncthis is the cross-client discovery, adaptation, configuration, reconciliation, verification,
and reporting layer for Agent Plugins. It helps one canonical plugin installation travel across
the clients that can preserve each capability safely.

## How we play

- Agent Plugins owns the model; Syncthis does not invent a competing manifest or registry.
- Adapt conservatively and report capability loss instead of pretending parity.
- Plan before writes, detect drift, and refuse unsafe confirmed plans as a whole.
- Keep client behavior explicit, tested, and reversible.
- Treat Cursor and other incomplete contracts honestly rather than guessing lifecycle support.
