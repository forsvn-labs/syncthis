# Terminal demos

Reproducible GIFs of syncthis in action, recorded with [VHS](https://github.com/charmbracelet/vhs).

## Regenerate

```bash
docs/demos/build.sh            # rebuild every tape → docs/demos/out/*.gif
docs/demos/build.sh mcp-sync   # rebuild a single tape
```

Requires `vhs` and `bun` on PATH.

## How it stays safe

syncthis reads and writes real agent config files under `$HOME`. To record live mutations
without touching your machine, `build.sh` seeds a throwaway `$HOME` under `/tmp` with fixture
agent configs (`seed-fixtures.ts`) and points each recording at it via `HOME` +
`XDG_CONFIG_HOME`. A `syncthis` shim on `PATH` runs this repo's source, so tapes type the
real command name. The sandbox HOME is wiped before each tape and on exit.

## Recording policy

- **MCP flows** (`mcp sync`, `mcp <from> <to>`, `doctor`) are pure file I/O — recorded **live**
  so the GIF shows real writes and the `.syncthis.bak` safety net.
- **Plugin / skills flows** shell out to `npx skills` / pinned Open Plugins (`npx -y plugins@1.3.4`) / `claude` / `codex`, which
  aren't present in the sandbox — record those with `--dry-run` / preview so they stay
  deterministic and need no external CLIs.

## Files

| Path | What |
|---|---|
| `seed-fixtures.ts` | Writes fixture agent configs into a throwaway `$HOME`; prints its path. |
| `build.sh` | Seeds a fresh HOME per tape, runs `vhs`, emits GIFs to `out/`. |
| `tapes/*.tape` | One VHS script per demo story. |
| `out/*.gif` | Generated GIFs (committed; referenced from the top-level README). |
