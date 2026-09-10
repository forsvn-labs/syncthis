---
title: "refactor: noun-first command surface + cleaner TUI + terminal demos"
type: refactor
status: active
date: 2026-06-09
---

# refactor: noun-first command surface + cleaner TUI + terminal demos

## Summary

Reshape syncthis's **CLI command list** (the primary target) around three nouns —
`syncthis plugins`, `syncthis skills`, `syncthis mcp` — each with a small set of
high-value verbs. The current surface is ~14 flat top-level commands plus a bare
`<from> <to>` positional fallback; it is hard to scan and teach. The new grammar is
canonical and the only thing shown in help; every existing command keeps working as a
**hidden alias** (non-breaking, minor version bump). `syncthis sync`/`run` stays the
top-level flagship one-shot, and `syncthis doctor` stays top-level.

The **interactive TUI** mirrors the new verb sets and gains lightweight walk-through
affordances (breadcrumb header, one-line "what this does" per flow, consistent
back/cancel, clearer previews) — no new tutorial mode.

Finally, build **reproducible terminal demos** (VHS `.tape` → GIF) under `docs/demos/`,
recorded against a sandboxed fixture `$HOME` so they show real mutations safely, and
embed them in the README.

---

## Problem Frame

`bin/syncthis.ts` dispatches a flat list of commands: `sync`, `run`, `mcp`, `skills`,
`skills from-plugins`, `update`, `doctor`, `mirror`, `from`, `add <skill|plugin>`,
`rm <skill|mcp|plugin>`, `plugin list|rm`, and a positional `<from> <to>` directional
mirror. The `HELP` string is ~90 lines and groups by mechanism, not by the user's mental
model. A new user can't tell that there are really only three things to manage
(plugins, skills, MCP) — the surface area hides the simplicity that the project's own
CLAUDE.md leads with ("It does exactly three things").

There is also no way to *show* the tool working. The README references
`./assets/demo.gif` but there is no reproducible pipeline to regenerate it, and running
syncthis live mutates the recorder's real agent configs.

**Scope:** this is a UX + packaging change. It does **not** alter sync/union/removal
*behavior* — the existing handler functions (`cmdSync`, `cmdMirror`, `cmdFanOut`,
`cmdAdd`, `cmdRm`, `cmdPlugin`, `runSync`, `runRemove`, …) are reused verbatim; only the
routing layer, help text, TUI menu structure, and a new demos pipeline change.

---

## Requirements

- **R1.** CLI exposes a noun-first grammar: `syncthis plugins <verb>`,
  `syncthis skills <verb>`, `syncthis mcp <verb>`, with verbs scoped to each noun.
- **R2.** `syncthis sync` (alias `run`) remains the top-level flagship; `syncthis doctor`,
  `syncthis update`, `syncthis version`, `syncthis help` remain top-level.
- **R3.** Every pre-existing command and the `<from> <to>` directional form continues to
  work unchanged as a **hidden alias** (not shown in help). No behavior change, no removed
  functionality. (Sacred elements — removal rails, conflict policy, 0600, `.syncthis.bak`,
  Claude per-project merge, directional confirmation — are untouched.)
- **R4.** `HELP` is rewritten to lead with the three nouns + the flagship; each noun group
  has scoped help reachable via `syncthis <noun> help` (and bare `syncthis <noun>` with no
  args where that doesn't collide with a legacy bare side effect — see KTD-3).
- **R5.** The interactive TUI's sub-menus match the new verb sets and carry inline
  walk-through affordances: a breadcrumb header per flow, a one-line "what this does" note,
  consistent Back on every menu, and a clearer pre-confirm preview.
- **R6.** A reproducible demo pipeline lives in `docs/demos/`: VHS tapes + a fixture-HOME
  seeder + a build script that regenerates GIFs deterministically, run against a throwaway
  `$HOME` so no real config is touched.
- **R7.** README embeds the generated GIFs; the demo build is documented so anyone can
  regenerate them.
- **R8.** `CLAUDE.md`'s Commands section is updated to the new canonical grammar (aliases
  noted as legacy).

---

## Key Technical Decisions

**KTD-1 — Noun-first routing sits on top of existing handlers; aliases route to the same
functions.** `main()` in `bin/syncthis.ts` gains three group routers — `cmdPlugins`,
`cmdSkills`, and a reconciled `cmdMcp` group — that parse the next positional as a verb and
delegate to the *already-existing* handler functions. The legacy top-level `if (cmd === …)`
branches stay in place below the noun routers, so `syncthis mirror foo` and
`syncthis plugins mirror foo` both call `cmdMirror`. No handler logic is duplicated or
rewritten. (Rationale: zero behavior risk, smallest diff, satisfies R3.)

**KTD-2 — Canonical grammar.** The advertised surface:

| Top-level | Meaning |
|---|---|
| `syncthis` | interactive picker |
| `syncthis sync [--dry-run] [--no-skills]` | flagship: MCP union + skills (alias `run`) |
| `syncthis doctor` | MCP coverage + conflicts (alias `mcp doctor`) |
| `syncthis update` / `version` / `help` | self-update / version / help |

| `syncthis plugins …` | Meaning | Legacy alias |
|---|---|---|
| `plugins list` | read-only cross-agent overview | `plugin list` |
| `plugins mirror <primary> [--no-provision] [--yes] [--dry-run]` | mirror one agent's plugins to all | `mirror <primary>` |
| `plugins add <name…> --agents\|--all [--dry-run]` | push chosen plugins to chosen agents | `add plugin …` |
| `plugins rm <name…> [--all\|--agents] [--yes] [--dry-run] [--keep-data]` | guarded uninstall | `plugin rm …` / `rm plugin …` |

| `syncthis skills …` | Meaning | Legacy alias |
|---|---|---|
| `skills update [--dry-run]` | `npx skills update -y` | `skills` (bare) |
| `skills add <repo…> --agents\|--all [--dry-run]` | add repos to agents | `add skill …` |
| `skills from-plugins [--dry-run]` | surface plugin-bundled skills | `skills from-plugins` |
| `skills rm <name…> --agents\|--all [--yes] [--dry-run]` | guarded skill removal | `rm skill …` |

| `syncthis mcp …` | Meaning | Legacy alias |
|---|---|---|
| `mcp sync [--dry-run]` | MCP-only union sync | `mcp` (bare) |
| `mcp doctor` | coverage + conflicts | `doctor` |
| `mcp <from> <to> [--yes] [--dry-run]` | directional one-way mirror | `<from> <to>` |
| `mcp from <agent> --all [--yes] [--dry-run]` | fan one agent out to all | `from <agent> --all` |
| `mcp rm <server…> [--all\|--agents] [--yes] [--dry-run]` | remove server(s) | `rm mcp …` / `rm <server> --all` |

(There is still **no `mcp add`** — syncthis mirrors MCP servers, it does not install them.
`mcp sync` / directional / fan-out are the only spread paths, consistent with the existing
"no add mcp" rule.)

**KTD-3 — Bare-noun behavior preserves legacy side effects.** Two legacy bare commands
*do work*: `syncthis skills` runs an update and `syncthis mcp` runs a union sync. To stay
non-breaking (R3), bare `syncthis skills` and bare `syncthis mcp` keep their legacy action,
while help advertises the explicit `skills update` / `mcp sync`. Bare `syncthis plugins`
has no destructive legacy side effect (legacy `plugin` with no sub prints help/usage), so
bare `syncthis plugins` prints the plugins group help. Document this asymmetry in the help
and CLAUDE.md so it's intentional, not surprising.

**KTD-4 — Verb dispatch must not shadow directional agent IDs.** Inside `cmd mcp`, a first
positional that matches a known verb (`sync`, `doctor`, `from`, `rm`, `help`) is treated as
a verb; otherwise it falls through to the directional `<from> <to>` parse (two agent IDs).
No agent ID collides with those verb names today; `cmdMcp` implements the guard (a first
positional that is a valid agent ID defers to directional parsing) and U6 tests the behavior,
so a future agent named `sync`/`from`/`rm` can't be silently swallowed.

**KTD-5 — Demos run against a fixture `$HOME`; pure-file flows are recorded live, shell-out
flows are recorded as preview/dry-run.** `src/io.ts` resolves every path from
`process.env.HOME ?? homedir()` (and a few `$XDG_CONFIG_HOME`/`$COPILOT_HOME`/
`$OPENCLAW_CONFIG_PATH` overrides), so a tape that exports `HOME` (+ `XDG_CONFIG_HOME`) to a
seeded throwaway dir redirects all reads/writes safely. MCP flows (`sync`, `doctor`,
directional, `rm`) are **pure file I/O** — recorded live so the GIF shows real mutations and
the `.syncthis.bak` backup. Plugin/skills flows shell out to `npx skills`/`npx plugins`/
`claude`/`codex`, which won't exist in the sandbox — record those as `--dry-run`/preview or
picker-navigation so they're deterministic and need no external CLIs.

**KTD-6 — TUI guidance is inline, not a new mode.** Affordances are rendered with the
existing `note()`/`log` + `tui-style` helpers (breadcrumb string built from the flow path),
keeping zero new runtime deps and matching current clack styling. No first-run tour, no new
screens.

---

## High-Level Technical Design

Routing layers in `bin/syncthis.ts` after the change (canonical on top, aliases beneath,
all converging on the same handlers):

```
main(cmd, rest)
├─ ""                → welcome + interactive picker (tui.ts)
├─ sync | run        → cmdSync
├─ doctor            → cmdDoctor ─────────────┐
├─ update|version|help                        │
├─ plugins  → cmdPlugins(rest)                │   group routers parse rest[0] as verb
│      ├─ list      → cmdPluginList           │   and delegate to existing handlers
│      ├─ mirror    → cmdMirror               │
│      ├─ add       → cmdAddPlugin            │
│      └─ rm        → cmdPluginRemove         │
├─ skills   → cmdSkills(rest)                 │
│      ├─ update    → cmdSkillsOnly           │
│      ├─ add       → cmdAddSkill             │
│      ├─ from-plugins → cmdSkillsFromPlugins │
│      └─ rm        → cmdRmSkill              │
├─ mcp      → cmdMcp(rest)                    │
│      ├─ sync      → cmdMcp(union)           │
│      ├─ doctor    → cmdDoctor ──────────────┘
│      ├─ from      → cmdFanOut
│      ├─ rm        → cmdRmMcp
│      ├─ <a> <b>   → cmdDirectional
│      └─ (bare)    → legacy union sync (KTD-3)
└─ LEGACY ALIASES (hidden): mcp(bare)|mirror|from|add|rm|remove|plugin|<from> <to>
                            → same handlers as above
```

TUI flow shape (each manager → verb → guided steps), unchanged structurally but with a
breadcrumb + intent note injected at each level:

```
Main menu ─ Plugins / Skills / MCPs / Check problems / Quit
   └─ <noun> verb menu  [breadcrumb: "Plugins ›"]    [note: what this manager does]
        └─ source → items → destinations → preview → confirm
           [breadcrumb updates each step; note: what this step does; Back always present]
```

---

## Output Structure

New / changed files:

```
bin/syncthis.ts          # noun group routers + rewritten HELP (modified)
src/tui.ts               # sub-menu verbs + inline guidance (modified)
src/tui-style.ts         # optional breadcrumb helper (modified)
docs/demos/
  README.md              # how to regenerate demos
  build.sh               # seed fixtures → run vhs → emit GIFs
  seed-fixtures.ts       # write fixture agent configs into a throwaway HOME
  tapes/
    mcp-sync.tape        # live MCP union sync against fixture HOME
    mcp-directional.tape # live directional mirror + .syncthis.bak
    plugins-mirror.tape  # dry-run plugin mirror preview
    skills.tape          # skills update / from-plugins preview
    interactive.tape     # picker walk-through (new guidance affordances)
  out/                   # generated GIFs (committed; referenced by README)
README.md                # embed generated GIFs (modified)
CLAUDE.md                # Commands section → new grammar (modified)
tests/
  cli-routing.test.ts    # noun dispatch + alias equivalence (new)
```

---

## Implementation Units

### U1. Noun-first CLI dispatch + alias layer

**Goal:** Add `cmdPlugins`, `cmdSkills`, and a reconciled `cmdMcp` group router to
`bin/syncthis.ts` and wire them into `main()` above the preserved legacy branches.

**Requirements:** R1, R2, R3, KTD-1, KTD-3, KTD-4.

**Dependencies:** none.

**Files:** `bin/syncthis.ts`, `tests/cli-routing.test.ts` (assertions added in U6).

**Approach:**
- Add three group routers that read `rest[0]` as a verb and `rest.slice(1)` as the verb's
  args, delegating to existing `cmdPluginList` / `cmdMirror` / `cmdAddPlugin` /
  `cmdPluginRemove` / `cmdSkillsOnly` / `cmdAddSkill` / `cmdSkillsFromPlugins` / `cmdRmSkill`
  / union-sync / `cmdDoctor` / `cmdFanOut` / `cmdRmMcp` / `cmdDirectional`.
- In `cmdMcp`: dispatch known verbs (`sync`, `doctor`, `from`, `rm`, `help`); otherwise fall
  through to the directional two-positional parse; bare (no args) → legacy union sync (KTD-3).
  The collision-guard for KTD-4 lives here: before treating a first positional as a verb,
  `cmdMcp` checks it against the known verb set, and if the token is a valid agent ID it
  defers to the directional parse rather than swallowing it as a verb.
- In `main()`: insert `if (cmd === "plugins") return cmdPlugins(rest)` etc. **above** the
  existing branches, but keep all legacy branches (`mirror`, `from`, `add`, `rm`, `remove`,
  `plugin`, bare `mcp`, `<from> <to>`) intact as hidden aliases.
- Note: existing `cmd === "plugin" || cmd === "plugins"` currently both route to `cmdPlugin`.
  Split so `plugins` → new `cmdPlugins` group router and `plugin` stays the legacy alias, OR
  have `cmdPlugins` recognize both old (`plugin list`) and new (`plugins list`) sub-verbs.
  Prefer the latter to avoid two near-identical routers.

**Patterns to follow:** existing verb-dispatch in `cmdAdd`/`cmdRm` (`bin/syncthis.ts`),
which already branch on `argv[0]` and call `resolveAgentScope`.

**Test scenarios** (implemented in U6, listed here for traceability):
- `plugins list` and legacy `plugin list` both invoke the overview path.
- `mcp sync` and bare `mcp` both run union-only sync; `mcp doctor` and `doctor` match.
- `mcp claude-code cursor` routes to directional (two agent IDs, not verbs).
- `mcp from claude-code --all` routes to fan-out, not directional.
- `plugins rm foo --all` and `rm plugin foo --all` and `plugin rm foo --all` reach the same
  guarded uninstall with identical parsed scope.
- Unknown verb under a noun (`skills bogus`) prints scoped help and exits non-zero.

**Verification:** every legacy command produces byte-identical behavior to before; new
noun-first forms reach the same handlers; `bun tsc --noEmit` clean.

---

### U2. Rewritten grouped HELP + per-noun scoped help

**Goal:** Replace the flat `HELP` string with a noun-led overview and add
`syncthis <noun> help` scoped help text.

**Requirements:** R4, KTD-2, KTD-3.

**Dependencies:** U1 (routers exist to dispatch `help`).

**Files:** `bin/syncthis.ts`.

**Approach:**
- Top of `HELP`: the three-things framing → flagship `sync` → the three nouns with their
  verbs (mirror the KTD-2 tables). Drop the per-mechanism prose into the scoped help.
- Add `PLUGINS_HELP`, `SKILLS_HELP`, `MCP_HELP` constants; each group router prints its
  scoped help on `help`/`-h`/`--help`/unknown-verb.
- Keep the "agents supported" and "flags" reference blocks in the top-level `HELP`.
- Do **not** advertise legacy aliases in `HELP` (R3) — mention once, briefly, that old
  commands still work, in CLAUDE.md rather than help.

**Patterns to follow:** existing `cmdSkills`/`cmdUpdate`/`cmdPlugin` sub-help blocks already
print scoped usage on `help|-h|--help`.

**Test scenarios:**
- `syncthis help` output contains the three noun headers and the flagship `sync`, and does
  **not** contain legacy-only tokens like `add skill` / `from <agent>` as advertised forms.
- `syncthis plugins help` lists `list`, `mirror`, `add`, `rm` and exits 0.
- `syncthis mcp bogus` prints MCP scoped help and exits 2.

**Verification:** help reads top-down as "three nouns + one flagship"; scoped help reachable
per noun; non-zero exit on unknown verb preserved.

---

### U3. TUI sub-menu restructure + inline guidance affordances

**Goal:** Align the interactive sub-menus to the new verb sets and add breadcrumb +
"what this does" notes + consistent Back + clearer previews.

**Requirements:** R5, KTD-6.

**Dependencies:** none (can land in parallel with U1/U2; share the verb vocabulary).

**Files:** `src/tui.ts`, `src/tui-style.ts`.

**Approach:**
- Keep the top menu as Plugins / Skills / MCPs / Check problems / Quit (doctor stays top-level
  per decision).
- Re-label sub-menu options to the canonical verbs (e.g. Plugins → List / Mirror / Add / Remove;
  Skills → Update / Add from repo / Sync from plugins / Share / Remove; MCPs → Sync everything /
  Sync MCP only / Share selected / Directional / Remove / Check problems). Keep all existing
  flow functions; only labels/ordering/grouping change.
- Add a `breadcrumb(path: string[])` helper in `tui-style.ts` and render it (via `note()` or a
  dim header line) at the top of each sub-flow, updated per step
  (`Plugins › Mirror › choose source`).
- Add a one-line intent `note()` at the entry of each manager and each multi-step flow ("what
  this does"), reusing the hint strings already present on menu options.
- Ensure every `pickOne` menu includes a `Back` option (audit existing flows; most already do).
- Tighten the pre-confirm preview formatting so the user sees exactly what will change before
  `confirmYes` (group adds/removes/conflicts under clear headers).

**Patterns to follow:** existing `intro()`/`note()` usage at the top of
`showInteractivePicker`, and the `S`/`c` style helpers in `src/tui-style.ts`.

**Test scenarios:**
- `tests/picker-logic.test.ts` (existing) still passes — pure selection logic is unchanged.
- Add a focused test (if a pure breadcrumb helper is extracted) that `breadcrumb(["Plugins",
  "Mirror"])` renders the expected `›`-joined string with the unicode/ASCII fallback honored.
- Manual: each sub-flow shows a breadcrumb, an intent note, and a reachable Back; non-TTY path
  still falls back to HELP (unchanged).

**Verification:** every flow shows where the user is and what the step does; no flow can strand
the user without Back/Cancel; styling matches existing clack prompts; zero new runtime deps.

---

### U4. Demo sandbox harness (fixture HOME seeder + build script)

**Goal:** Deterministic, safe demo substrate: seed a throwaway `$HOME` with fixture agent
configs and a one-command build that regenerates GIFs.

**Requirements:** R6, KTD-5.

**Dependencies:** U1/U2 (so tapes can use the new grammar), but the harness itself can be
scaffolded first.

**Files:** `docs/demos/seed-fixtures.ts`, `docs/demos/build.sh`, `docs/demos/README.md`,
`docs/demos/fixtures/` (sample config templates).

**Approach:**
- `seed-fixtures.ts`: create a temp dir, write minimal realistic configs for the demo agents
  (`~/.cursor/mcp.json`, `~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`),
  each with a couple of distinct MCP servers so a union sync visibly does something. Print the
  temp dir path for the build script to export as `HOME`.
- `build.sh`: for each tape — seed a fresh fixture HOME, export `HOME` + `XDG_CONFIG_HOME` to
  it, run `vhs docs/demos/tapes/<name>.tape` with the local CLI (`bun bin/syncthis.ts`, or a
  freshly built `dist/syncthis.mjs`), emit the GIF to `docs/demos/out/`. Re-seed between tapes
  so each is independent.
- `docs/demos/README.md`: prerequisites (`vhs`), how to run `build.sh`, and the live-vs-preview
  recording policy (KTD-5).

**Patterns to follow:** the test setups already pin `HOME`/`XDG_CONFIG_HOME` under a temp dir
for hermetic adapter tests (see `goose-adapter` note in `src/adapters/goose.ts`) — mirror that
env-override approach.

**Test scenarios:**
- `seed-fixtures.ts` smoke test: running it produces a dir containing the expected config files
  with valid JSON/TOML and at least two distinct MCP servers across agents.
- Running `syncthis mcp sync` against the seeded HOME exits 0 and propagates servers (asserts the
  fixtures are sync-able, so the live tape won't be empty).

**Verification:** `build.sh` runs end-to-end on a clean machine with only `vhs` + `bun`
installed; no file outside the temp HOME is touched (confirm by diffing real `~` before/after).

---

### U5. VHS tapes + generated GIFs + README embed

**Goal:** The actual demo content: tapes for the core stories, generated GIFs, README links.

**Requirements:** R6, R7, KTD-5.

**Dependencies:** U4 (harness), U1–U3 (grammar + TUI to record).

**Files:** `docs/demos/tapes/*.tape`, `docs/demos/out/*.gif`, `README.md`.

**Approach:**
- `mcp-sync.tape`: `syncthis mcp sync` against fixtures → shows union propagation + completion
  summary (live).
- `mcp-directional.tape`: `syncthis mcp claude-code cursor --dry-run` then `--yes` → shows the
  diff, confirm, and `.syncthis.bak` (live; a flagship "sacred" behavior worth demoing).
- `plugins-mirror.tape`: `syncthis plugins mirror claude-code --dry-run` → preview only (no
  external CLIs needed; KTD-5).
- `skills.tape`: `syncthis skills from-plugins --dry-run` → preview.
- `interactive.tape`: launch `syncthis`, walk Plugins → Mirror showing the new breadcrumb +
  intent notes + Back, then quit (read-only navigation; no apply).
- Keep tapes short (≤ ~20s), set a consistent theme/size, type at a readable speed.
- README: replace/augment `./assets/demo.gif` with the generated GIFs under clear headings
  ("Sync MCP servers", "Mirror plugins", "Interactive").

**Patterns to follow:** VHS `.tape` DSL (`Output`, `Set`, `Type`, `Enter`, `Sleep`); existing
README badge/image block (`README.md` lines 7–9).

**Test scenarios:** Test expectation: none — these are generated assets, not code. The
correctness gate is U4's smoke tests (fixtures are sync-able) + manual review of each GIF for
legibility and that no real config path appears on screen.

**Verification:** each GIF regenerates deterministically via `build.sh`; README renders the
GIFs; no secrets or real home paths visible in any frame.

---

### U6. Routing/alias tests + CLAUDE.md doc update

**Goal:** Lock the alias-equivalence contract with tests and update the canonical docs.

**Requirements:** R3, R8, KTD-1, KTD-4.

**Dependencies:** U1, U2.

**Files:** `tests/cli-routing.test.ts`, `CLAUDE.md`.

**Approach:**
- `cli-routing.test.ts`: drive the CLI by spawning `bun bin/syncthis.ts <args>` with
  `--dry-run`/`--help` (no mutations) against a temp HOME, asserting that each new noun-first
  form and its legacy alias produce equivalent output/exit codes. Cover the KTD-4 directional
  vs verb disambiguation and the KTD-3 bare-noun behaviors.
- Prefer a thin extraction if needed: if spawning is too coarse, extract a pure
  `resolveRoute(cmd, rest) → { handler, args }` from `main()` and unit-test that mapping
  directly (handlers mocked). Decide during implementation based on how observable the spawn
  output is.
- `CLAUDE.md`: update the **## Commands** block to the new grammar (KTD-2 tables), add a short
  "Legacy aliases (still work, not advertised)" note, and reflect the bare-noun asymmetry
  (KTD-3). Update the **Layout**/feature prose only where the command names appear.

**Test scenarios:**
- Each `(new form, legacy form)` pair from the KTD-2 tables yields the same handler/exit code.
- `mcp <agentA> <agentB>` and legacy `<agentA> <agentB>` both hit directional.
- `mcp from x --all` hits fan-out for both forms.
- Bare `mcp` and `mcp sync` both run union-only; bare `skills` and `skills update` both update.
- Unknown verb under each noun exits 2 with scoped help.

**Verification:** `bun test` green including the new file; `bun tsc --noEmit` clean; CLAUDE.md
Commands section matches the shipped help.

---

## Scope Boundaries

**In scope:** CLI routing/help restructure, alias preservation, TUI menu labels + inline
guidance, demo pipeline + GIFs, README + CLAUDE.md doc updates.

**Out of scope (non-goals):**
- Any change to sync/union/removal/mirror **behavior** or the sacred elements.
- New commands or new capabilities (no `mcp add`; no new sync mechanics).
- A first-run tutorial / tour mode (explicitly deferred — inline affordances only).
- `syncthis-landing` repo integration (separate repo; demos land in-repo here).

### Deferred to Follow-Up Work
- Reuse the generated GIFs on the landing site (`syncthis-landing`) — separate repo, separate PR.
- Optional deprecation **warnings** on legacy aliases (decision was silent aliases; warnings
  could come later if telemetry shows confusion).
- A `skills share` CLI verb (share is currently TUI-only) — add later if there's demand; not
  required for this refactor.

---

## Risks & Mitigations

- **Directional/verb collision (KTD-4):** an agent ID equal to a verb name (`sync`/`from`/`rm`)
  would be swallowed by verb dispatch. *Mitigation:* verb set is closed and tested; no current
  agent collides; the routing test guards it.
- **Alias regression:** a refactor of `main()` could subtly change a legacy command. *Mitigation:*
  legacy branches are kept verbatim and asserted equivalent in U6; handlers are not rewritten.
- **Demo leaks real config:** a misconfigured tape could record against the real `$HOME`.
  *Mitigation:* `build.sh` always exports a fresh temp `HOME`+`XDG_CONFIG_HOME`; U4 verification
  diffs real `~` before/after; live tapes restricted to pure-file MCP flows.
- **Demo non-determinism:** spinners/timing make GIFs flaky. *Mitigation:* fixed VHS `Set`
  timing, short scripted flows, dry-run for shell-out paths so no network variance.
- **Bare-noun asymmetry confusion (KTD-3):** `plugins` (bare) shows help but `mcp`/`skills`
  (bare) act. *Mitigation:* documented intentionally in help + CLAUDE.md; the explicit verbs are
  what's taught.

---

## Alternatives Considered

- **Hard-cut to noun-first (drop legacy commands).** Cleaner surface, but breaks existing users'
  scripts/muscle memory and forces a major bump. Rejected in favor of hidden aliases (user
  decision) — same clean *advertised* surface, zero breakage.
- **Move the flagship under nouns (`mcp sync` + `skills update`, no top-level `sync`).** Purest
  grammar but loses the one-command "sync everything." Rejected — `sync`/`run` stays top-level.
- **Preview-only demos (no fixture HOME).** Simpler (no seeder), but can never show an applied
  mutation or the `.syncthis.bak` safety net. Rejected — sandboxed fixture HOME chosen so MCP
  flows record live.
- **asciinema instead of VHS.** Live-recorded, not scripted → non-reproducible. VHS chosen
  (already installed; tapes are deterministic and re-runnable in CI).

---

## Sources & Research

Grounded in direct reads of the current code rather than external research (small codebase,
no load-bearing external dependency):
- `bin/syncthis.ts` — current flat dispatch (`main()` lines ~1294–1333), `HELP` string, and
  the verb-dispatch precedent in `cmdAdd`/`cmdRm`.
- `src/tui.ts` — existing manager/sub-menu structure and clack-based flow helpers.
- `src/tui-style.ts` — symbol/color helpers (zero-dep styling) for the breadcrumb affordance.
- `src/io.ts` — `process.env.HOME ?? homedir()` path resolution (lines ~96–114) confirming the
  fixture-HOME sandbox approach; `$XDG_CONFIG_HOME`/`$COPILOT_HOME`/`$OPENCLAW_CONFIG_PATH`
  overrides in the relevant adapters.
- `CLAUDE.md` — the canonical "three things" framing and current Commands block to update.
- VHS confirmed installed at `/opt/homebrew/bin/vhs`.
