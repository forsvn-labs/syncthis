import { MultiSelectPrompt } from "@clack/core";
import { intro, outro, select, isCancel, cancel, log, note, spinner } from "@clack/prompts";
import { listPlugins, pluginAdapters } from "./plugins/index.ts";
import { buildPluginOverview } from "./plugins/overview.ts";
import { runPluginUninstall, uninstallHasChanges } from "./plugins/uninstall.ts";
import { skillCohort } from "./skills.ts";
import { renderPluginSyncReport, pluginSyncHasChanges } from "./cli/plugin-outcomes.ts";
import { neutralPluginText } from "./cli/render-plugins.ts";
import { runSync, type SyncReport } from "./sync.ts";
import {
  buildRows,
  isAllSelected,
  isGroupSelected,
  itemValues,
  nextSelectionForRow,
  type PickerItem,
  type PickerRow,
} from "./picker-logic.ts";
import { S, c, breadcrumb } from "./tui-style.ts";
import type { AgentId } from "./types.ts";

const MAX_MENU_ITEMS = 12;

export type MainChoice = "sync" | "list" | "remove" | "quit";
type MenuOption<T extends string> = { value: T; label: string; hint?: string };

export const MAIN_MENU: MenuOption<MainChoice>[] = [
  { value: "sync", label: "Plugins Fleet Sync", hint: "reconcile every installed plugin" },
  { value: "list", label: "Plugins Fleet List", hint: "readable state + Cursor verification note" },
  { value: "remove", label: "Plugins Fleet Remove", hint: "guarded plugin uninstall" },
  { value: "quit", label: "Quit" },
];

class FlowCancel extends Error {}

// Orientation header for a multi-step flow: a breadcrumb title + a one-line "what this
// does", rendered once at the top of each operation so the user knows what the operation
// produces before the preview and confirmation.
function flowHeader(path: string[], what: string) {
  note(what, breadcrumb(path));
}

export async function showInteractivePicker(): Promise<void> {
  intro("Plugins Fleet");

  note(
    "Plugins Fleet discovers installed plugins from every readable native source and reconciles them across supported targets. Sync previews before applying.",
    "what is this?",
  );

  try {
    const choice = await pickOne<MainChoice>("What plugin action do you want to take?", MAIN_MENU);
    if (!choice || choice === "quit") {
      cancel("aborted - nothing was changed.");
      return;
    }

    if (choice === "sync") await syncPlugins();
    else if (choice === "list") await doPluginList();
    else await removePlugins();
  } catch (err) {
    if (err instanceof FlowCancel) return;
    cancel(err instanceof Error ? err.message : String(err));
    return;
  }

  outro("Done. Open `syncthis` anytime, or use `syncthis help` for the command list.");
}

async function doPluginList() {
  flowHeader(["Plugins Fleet", "List"], "Read-only native plugin state. Cursor is write-only and unverified.");
  const o = await buildPluginOverview();
  for (const r of o.native) {
    if (r.error) log.error(`${r.agent}: ${r.error}`);
    else if (!r.exists) log.info(`${r.agent}: no config`);
    else log.success(`${r.agent}: ${r.plugins.length} plugin(s) - ${dedupe(r.plugins.map((p) => p.name)).join(", ") || "none"}`);
  }
  log.info("cursor: write-only plugin target - state unverified");
}

export type PluginSyncFlowDeps = {
  runSync?: (options: { dryRun: boolean }) => Promise<SyncReport>;
  confirm?: (message: string) => Promise<boolean>;
  render?: (report: SyncReport) => readonly string[];
  onLine?: (line: string) => void;
};

/**
 * Shared preview/apply orchestration for the interactive Plugins Fleet Sync action.
 * The injected runner is the same `runSync` contract used by the CLI, so the
 * picker cannot accidentally fall back to the old source/target add flow.
 */
export async function runPluginSyncFlow(deps: PluginSyncFlowDeps = {}) {
  const runner = deps.runSync ?? ((options: { dryRun: boolean }) => runSync(options));
  const render = deps.render ?? renderPluginSyncReport;
  const emit = deps.onLine ?? ((line: string) => log.info(line));

  const preview = await runner({ dryRun: true });
  for (const line of render(preview)) emit(line);
  if (!preview.ok || !pluginSyncHasChanges(preview)) {
    return { preview };
  }

  const confirmed = await (deps.confirm ?? confirmYes)(
    "apply Plugins Fleet sync across all supported targets?",
  );
  if (!confirmed) return { preview, cancelled: true as const };

  const applied = await runner({ dryRun: false });
  for (const line of render(applied)) emit(line);
  return { preview, applied };
}

async function syncPlugins() {
  flowHeader(
    ["Plugins Fleet", "Sync"],
    "Plugins Fleet discovers installed plugins from every readable native source and reconciles them across supported targets. Each target gets one canonical outcome.",
  );
  await runPluginSyncFlow();
}

async function removePlugins() {
  flowHeader(["Plugins Fleet", "Remove"], "Guarded uninstall: removes selected plugins from the chosen agents. You'll preview the exact changes and confirm before anything is removed.");
  const reads = await listPlugins();
  const names = dedupe(reads.flatMap((r) => (r.error ? [] : r.plugins.map((p) => p.name)))).sort();
  if (names.length === 0) {
    log.info("no readable plugins found to uninstall.");
    return;
  }

  const plugins = await pickMany("choose plugin(s) to remove", names.map((n) => ({ value: n, label: n })));
  if (!plugins) return;

  const agentChoices = dedupe([...pluginAdapters.map((a) => a.id), ...skillCohort()]);
  const agents = await pickAgents(agentChoices, "remove from which agents?", agentChoices);
  if (!agents) return;

  const preview = await runPluginUninstall({ plugins, agents, apply: false });
  if (!uninstallHasChanges(preview)) {
    log.success("nothing to do - none of those plugins are installed on the chosen agents.");
    return;
  }
  const nativeHits = preview.native.filter((t) => t.present).map((t) => `${t.agent}:${t.plugin}`);
  if (nativeHits.length) log.info(`native plugin uninstall: ${nativeHits.join(", ")}`);
  if (preview.skills.names.length && preview.skills.agents.length) {
    log.info(`remove ${preview.skills.names.length} bundled plugin adaptation item(s) from ${preview.skills.agents.length} agent(s): ${preview.skills.names.join(", ")}`);
  }
  if (preview.skills.kept.length) log.info(`keeping adaptation still provided by another plugin: ${preview.skills.kept.join(", ")}`);
  for (const target of preview.mcp) {
    if (target.unreadable) {
      log.warn(`${target.agent}: plugin adaptation target unreadable (${neutralPluginText(target.unreadable)})`);
    } else if (target.names.length) {
      log.info(`remove ${target.names.length} surfaced plugin adaptation item(s) from ${target.agent}: ${target.names.join(", ")}`);
    }
    if (target.kept.length) {
      log.info(`${target.agent}: keeping adaptation items still provided by another plugin: ${target.kept.join(", ")}`);
    }
    if (target.conflicts.length) {
      log.warn(`${target.agent}: modified adaptation items left untouched: ${target.conflicts.join(", ")}`);
    }
  }
  if (preview.claudeReadError && preview.skillScope.length) {
    log.warn(`couldn't read Claude's plugins (${neutralPluginText(preview.claudeReadError)}) - plugin adaptation on ${preview.skillScope.join(", ")} can't be resolved and will be left in place`);
  }

  if (!(await confirmYes("apply? this uninstalls the selected plugins and their adaptations."))) return;

  const s = spinner();
  s.start("Removing plugins...");
  const applied = await runPluginUninstall({
    plugins,
    agents,
    apply: true,
    onProgress: (label, i, total) => s.message(`${label}  (${i}/${total})`),
  }).catch((err) => {
    s.stop("Remove failed.");
    throw err;
  });
  s.stop("Remove applied.");

  let removed = 0;
  let failed = 0;
  for (const res of applied.nativeResults ?? []) {
    if (res.status === "uninstalled") removed += 1;
    else if (res.status === "failed") failed += 1;
  }
  if (applied.skillResult) {
    const skillRemoved = applied.skillResult.results.reduce(
      (count, target) => count + target.removed.length,
      0,
    );
    removed += skillRemoved;
    if (applied.skillResult.status === "partial") {
      failed += 1;
      const remaining = applied.skillResult.results
        .filter((target) => target.remaining.length > 0)
        .map((target) => `${target.agent}: ${target.remaining.join(", ")}`)
        .join("; ");
      log.error(`plugin adaptation removal partial — remaining: ${remaining || "verification unavailable"}`);
    } else if (applied.skillResult.status === "blocked" || applied.skillResult.status === "failed") {
      failed += 1;
      log.error(`plugin adaptation removal blocked (${neutralPluginText(applied.skillResult.message, "verification failed")})`);
    }
  }
  for (const result of applied.mcpResults ?? []) {
    if (result.status === "synced") {
      removed += result.removed.length;
      log.info(`${result.agent}: removed ${result.removed.length} plugin adaptation item(s): ${result.removed.join(", ")}`);
    } else if (result.status === "failed") {
      failed += 1;
      log.error(`${result.agent}: plugin adaptation removal blocked (${neutralPluginText(result.message, "unknown error")})`);
    }
    if (result.conflicts.length) {
      log.warn(`${result.agent}: modified adaptation items left untouched: ${result.conflicts.join(", ")}`);
    }
  }
  if (applied.claudeReadError && applied.skillScope.length) {
    const who = applied.requiredSkillAgents.length ? applied.requiredSkillAgents : applied.skillScope;
    log.warn(`claude unreadable (${neutralPluginText(applied.claudeReadError)}) - plugin adaptation on ${who.join(", ")} couldn't be resolved${applied.requiredSkillAgents.length ? " and was NOT removed" : " (native uninstall still applied)"}`);
  }
  if (failed > 0) log.error(`${removed} removed, ${failed} blocked - use \`syncthis plugins rm\` for detail`);
  else log.success(`remove complete: ${removed} removed.`);
}

async function pickOne<T extends string>(
  message: string,
  options: Array<MenuOption<T>>,
  initialValue?: T,
): Promise<T | null> {
  const clean = dedupeOptions(options);
  if (clean.length === 0) {
    log.info("nothing to choose.");
    return null;
  }
  const raw = await select({
    message,
    options: clean as any,
    initialValue,
    maxItems: MAX_MENU_ITEMS,
  });
  if (isCancel(raw)) {
    stopFlow();
  }
  return raw as T;
}

// Flat multiselect with a visible "select all" control row (plus the `a` shortcut).
async function pickMany<T extends string>(
  message: string,
  options: Array<MenuOption<T>>,
  initialValues: T[] = [],
): Promise<T[] | null> {
  const clean = dedupeOptions(options);
  if (clean.length === 0) {
    log.info("nothing to choose.");
    return null;
  }
  const items: PickerItem[] = clean.map((o) => ({ value: o.value, label: o.label, hint: o.hint }));
  const rows = buildRows(items);
  const initial = initialValues.filter((v) => clean.some((o) => o.value === v));
  while (true) {
    const raw = await controlMultiselect({
      message,
      rows,
      initialValues: initial as string[],
      maxItems: MAX_MENU_ITEMS,
    });
    if (isCancel(raw)) {
      stopFlow();
    }
    const picked = raw as T[];
    if (picked.length > 0) return picked;
    log.warn("Select at least one item, or cancel with Ctrl-C.");
  }
}

// A windowed multiselect built on @clack/core's MultiSelectPrompt, extended to render
// "control" rows (a global select-all, and per-group toggles) alongside item rows, plus
// type-to-filter on long lists. Styling matches the native clack prompts (see tui-style).
// `this.value` only ever holds item values — control rows are never selected, they drive
// bulk selection. Toggle behavior is delegated to the pure picker-logic helpers, run
// against the CURRENT view (so "select all" while filtered toggles only the matches).
async function controlMultiselect(opts: {
  message: string;
  rows: PickerRow[];
  initialValues?: string[];
  maxItems: number;
}): Promise<string[] | symbol> {
  const fullRows = opts.rows;
  const grouped = fullRows.some((r) => r.kind === "group");
  const totalItems = itemValues(fullRows).length;
  // Only advertise/enable filtering once a list is long enough to be a scrolling chore.
  const filterable = totalItems > opts.maxItems;
  // Window height tracks the terminal (≈8 chrome lines), floored at 5 and capped at 24,
  // never exceeding the row count — so it grows on tall terminals and shrinks on short ones.
  const termRows = typeof process.stdout.rows === "number" ? process.stdout.rows : 24;
  const pageSize = Math.max(5, Math.min(termRows - 8, 24, fullRows.length));

  let filter = "";
  let view: PickerRow[] = fullRows;
  let windowStart = 0;

  // Rows to display for the current filter. Empty filter → the full structure (select-all
  // + group toggles + items). Non-empty → only matching item rows, with a synthetic
  // "select all (N matches)" so bulk-selecting a search result stays one keypress.
  const computeView = (): PickerRow[] => {
    const f = filter.trim().toLowerCase();
    if (!f) return fullRows;
    const matches = fullRows.filter(
      (r): r is Extract<PickerRow, { kind: "item" }> =>
        r.kind === "item" && (r.label.toLowerCase().includes(f) || r.value.toLowerCase().includes(f)),
    );
    if (matches.length > 1) {
      return [{ kind: "all", label: `select all (${matches.length} matches)` }, ...matches];
    }
    return matches;
  };

  const firstItemIdx = fullRows.findIndex((r) => r.kind === "item");
  const cursorAt = firstItemIdx >= 0 ? rowKey(fullRows[firstItemIdx]!, firstItemIdx) : undefined;

  const prompt = new MultiSelectPrompt<{ value: string; label: string }>({
    options: fullRows.map((r, i) => ({ value: rowKey(r, i), label: r.label })) as any,
    initialValues: opts.initialValues,
    cursorAt,
    render() {
      const head = `${c.gray(S.bar)}\n${stepSymbol(this.state)}  ${opts.message}`;
      const selected = new Set(this.value as string[]);
      if (this.state === "submit" || this.state === "cancel") {
        return `${head}\n${c.gray(S.bar)}  ${c.dim(`${selected.size} selected`)}`;
      }

      if (view.length > pageSize) {
        if (this.cursor >= windowStart + pageSize - 3) {
          windowStart = Math.max(Math.min(this.cursor - pageSize + 3, view.length - pageSize), 0);
        } else if (this.cursor < windowStart + 2) {
          windowStart = Math.max(this.cursor - 2, 0);
        }
      } else {
        windowStart = 0;
      }

      const above = windowStart;
      const below = Math.max(view.length - windowStart - pageSize, 0);
      const slice = view.slice(windowStart, windowStart + pageSize);

      const lines: string[] = [];
      const controls = filterable ? "type to filter · space toggles · enter confirms" : "space toggles · enter confirms";
      lines.push(c.dim(`${selected.size}/${totalItems} selected · ${controls}`));
      if (filter) lines.push(`${c.cyan("filter")} ${filter}${c.inverse(" ")}`);
      if (view.length === 0) lines.push(c.dim("no matches"));
      if (above > 0) lines.push(c.dim(`${S.up} ${above} more`));
      for (let i = 0; i < slice.length; i++) {
        const absolute = windowStart + i;
        // While filtering, matches are flat (no group headers) — drop the group indent.
        lines.push(formatRow(slice[i]!, { active: absolute === this.cursor, selected, rows: view, grouped: filter ? false : grouped }));
      }
      if (below > 0) lines.push(c.dim(`${S.down} ${below} more`));

      const bar = this.state === "error" ? c.yellow(S.bar) : c.gray(S.bar);
      const body = lines.map((l) => `${bar}  ${l}`).join("\n");
      const end = this.state === "error" ? `${c.yellow(S.barEnd)}  ${c.yellow(this.error)}` : c.gray(S.barEnd);
      return `${head}\n${body}\n${end}`;
    },
  });

  const p = prompt as unknown as {
    options: Array<{ value: string; label: string }>;
    cursor: number;
    value: string[];
    state: string;
    input: {
      on: (event: string, listener: (...args: any[]) => void) => void;
      removeListener: (event: string, listener: (...args: any[]) => void) => void;
    };
    render: () => void;
    toggleValue: () => void;
    toggleAll: () => void;
  };

  // Recompute the view after a filter change and keep clack's cursor nav in range: its
  // built-in handlers wrap on `this.options.length`, so options must mirror the view.
  const refreshView = () => {
    view = computeView();
    p.options = view.map((r, i) => ({ value: rowKey(r, i), label: r.label }));
    const firstItem = view.findIndex((r) => r.kind === "item");
    p.cursor = firstItem >= 0 ? firstItem : 0;
    windowStart = 0;
  };

  // Space toggles whichever row the cursor is on, against the current view. `a` is no
  // longer a select-all shortcut (freed for typing) — the visible select-all row is the
  // discoverable mechanism, so toggleAll is neutralized.
  p.toggleValue = function () {
    this.value = [...nextSelectionForRow(new Set(this.value), view, this.cursor)];
  };
  p.toggleAll = function () {};

  // Type-to-filter. Handled off the raw keypress object (not clack's lowercased `key`
  // event) so backspace/delete are reliable. Nav/space/enter keep their meaning.
  const onFilterKey = (ch: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
    if (p.state !== "active" && p.state !== "initial") return;
    if (key?.ctrl || key?.meta) return;
    const name = key?.name;
    if (name === "backspace" || name === "delete") {
      if (filter) {
        filter = filter.slice(0, -1);
        refreshView();
        p.render();
      }
      return;
    }
    if (name && ["space", "return", "enter", "up", "down", "left", "right", "tab", "escape"].includes(name)) return;
    if (typeof ch === "string" && ch.length === 1 && ch >= " " && ch <= "~") {
      filter += ch.toLowerCase();
      refreshView();
      p.render();
    }
  };

  // p.input is the shared process.stdin and clack's close() only removes its own
  // listener — so we must remove ours, or it leaks across every prompt in the session.
  if (filterable) p.input.on("keypress", onFilterKey);
  try {
    return (await prompt.prompt()) as string[] | symbol;
  } finally {
    if (filterable) p.input.removeListener("keypress", onFilterKey);
  }
}

// Option value for a row. Items use their real value (the selection token); control
// rows use a NUL-prefixed sentinel so they never collide with a real value and never
// enter the returned selection.
function rowKey(row: PickerRow, index: number): string {
  if (row.kind === "item") return row.value;
  if (row.kind === "all") return "\x00all";
  return `\x00grp:${index}`;
}

// One row, styled to match clack: cyan pointer + cyan box on the active row, green box
// when selected, dim otherwise. Group rows carry a glyph + bold label so the marketplace
// hierarchy reads at a glance against its indented, dimmed children.
function formatRow(
  row: PickerRow,
  ctx: { active: boolean; selected: Set<string>; rows: PickerRow[]; grouped: boolean },
): string {
  const pointer = ctx.active ? c.cyan(S.pointer) : " ";
  const checkbox = (on: boolean) => (on ? c.green(S.checkboxOn) : ctx.active ? c.cyan(S.checkboxOff) : c.dim(S.checkboxOff));

  if (row.kind === "all") {
    const label = ctx.active ? c.cyan(row.label) : c.bold(row.label);
    return `${pointer} ${checkbox(isAllSelected(ctx.selected, ctx.rows))} ${label}`;
  }
  if (row.kind === "group") {
    const label = ctx.active ? c.cyan(c.bold(row.label)) : c.bold(row.label);
    return `${pointer} ${c.yellow(S.group)} ${checkbox(isGroupSelected(ctx.selected, ctx.rows, row.group))} ${label}`;
  }
  const on = ctx.selected.has(row.value);
  const indent = ctx.grouped ? "  " : "";
  const text = `${row.label}${row.hint ? ` (${row.hint})` : ""}`;
  const label = ctx.active ? c.cyan(text) : on ? text : c.dim(text);
  return `${pointer} ${indent}${checkbox(on)} ${label}`;
}

function stepSymbol(state: string): string {
  if (state === "submit") return c.green(S.submit);
  if (state === "cancel") return c.red(S.cancel);
  if (state === "error") return c.yellow(S.error);
  return c.cyan(S.active);
}

async function pickAgents(known: AgentId[], message: string, initial?: AgentId[]): Promise<AgentId[] | null> {
  return pickMany(message, known.map((a) => ({ value: a, label: a })), initial);
}

async function confirmYes(message: string): Promise<boolean> {
  const c = await pickOne<"no" | "yes">(message, [
    { value: "no", label: "No" },
    { value: "yes", label: "Yes" },
  ]);
  if (c !== "yes") {
    stopFlow();
  }
  return true;
}

function stopFlow(message = "aborted."): never {
  cancel(message);
  throw new FlowCancel(message);
}

function dedupe<T extends string>(items: T[]): T[] {
  return [...new Set(items)];
}

function dedupeOptions<T extends string>(options: Array<MenuOption<T>>): Array<MenuOption<T>> {
  const out: Array<MenuOption<T>> = [];
  const seen = new Set<T>();
  for (const option of options) {
    if (seen.has(option.value)) continue;
    seen.add(option.value);
    out.push(option);
  }
  return out;
}
