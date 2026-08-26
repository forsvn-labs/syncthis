import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import {
  renderPluginSyncReport,
  pluginSyncHasChanges,
} from "./cli/plugin-outcomes.ts";
import {
  handleControlCenterKey,
  type ControlCenterCommand,
  type ControlCenterScreen,
  type ControlCenterSnapshot,
} from "./cli/control-center-policy.ts";
import { renderUninstallPreview, renderUninstallResult } from "./cli/uninstall-presentation.ts";
import {
  budgetLines,
  contentWidth,
  controlCenterBodyHeight,
  fitSelectionItem,
  headerCells,
  introListLayout,
  linesWindow,
  stackedLayout,
  truncateToWidth,
} from "./cli/tui-layout.ts";
import {
  CLAUDE_SCOPE_OPTIONS,
  claudeScopeChoice,
  renderActivationPreview,
  renderActivationResult,
} from "./cli/activation-presentation.ts";
import {
  runPluginActivation,
  activationHasChanges,
  type ActivationReport,
} from "./plugins/activation.ts";
import type { PluginActivationOp, PluginActivationScope } from "./plugins/types.ts";
import { neutralPluginText } from "./cli/render-plugins.ts";
import { TAGLINE } from "./welcome.tsx";
import { runPluginDoctor, renderPluginDoctor, type PluginDoctorReport } from "./plugins/doctor-report.ts";
import {
  buildPluginOverview,
  overviewCounts,
  pluginDetailLines,
  pluginOverviewRows,
  pluginRowSummary,
  type PluginOverview,
} from "./plugins/overview.ts";
import { pluginReconcileTargets } from "./plugins/targets.ts";
import {
  runPluginUninstall,
  uninstallHasChanges,
  type UninstallReport,
} from "./plugins/uninstall.ts";
import { planSelfUpdate, runSelfUpdate, type SelfUpdatePlan } from "./self-update.ts";
import { runSync, type SyncReport } from "./sync.ts";
import type { AgentId } from "./types.ts";

export { renderUninstallPreview, renderUninstallResult } from "./cli/uninstall-presentation.ts";
export { MAIN_MENU } from "./cli/main-menu.ts";
export type { MainChoice, MainMenuItem } from "./cli/main-menu.ts";

import { MAIN_MENU } from "./cli/main-menu.ts";

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

/** Explicit result boundary for async actions. Failures are data, never a silent undefined. */
export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Normalize a thrown cause into the banner/hasError string used by the async gate. */
export function normalizeActionError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Catch-path contract: normalize the thrown cause, persist it for the banner /
 * hasError gate, then return the explicit failure result.
 */
export function persistThrownActionError(
  cause: unknown,
  setError: (error: string) => void,
): ActionResult<never> {
  const error = normalizeActionError(cause);
  setError(error);
  return { ok: false, error };
}

/** Non-home navigate always clears list cursor and scroll before the next screen mounts. */
export function applyNonHomeNavigate(screen: ControlCenterScreen): {
  screen: ControlCenterScreen;
  cursor: 0;
  offset: 0;
} {
  return { screen, cursor: 0, offset: 0 };
}

function useAsyncAction() {
  const busy = useRef(false);
  const [loading, setLoading] = useState<string>();
  const [error, setError] = useState<string>();
  const run = async <T,>(label: string, task: () => Promise<T>): Promise<ActionResult<T>> => {
    if (busy.current) return { ok: false, error: "another operation is still running" };
    busy.current = true;
    setLoading(label);
    setError(undefined);
    try {
      return { ok: true, value: await task() };
    } catch (cause) {
      return persistThrownActionError(cause, setError);
    } finally {
      busy.current = false;
      setLoading(undefined);
    }
  };
  return { loading, error, clearError: () => setError(undefined), run };
}

function SelectionList(props: {
  items: Array<{ value: string; label: string; hint?: string }>;
  cursor: number;
  selected?: readonly string[];
  height: number;
  width?: number;
}) {
  // Same viewport contract as Lines: the ↑/↓ indicator rows are budgeted
  // inside `height` (via linesWindow), so a scrolled list never exceeds the
  // body. The cursor stays roughly centered via the pre-window offset.
  const desired = Math.max(0, props.cursor - Math.floor(Math.max(1, props.height - 2) / 2));
  const win = linesWindow(props.items.length, desired, props.height);
  const visible = props.items.slice(win.start, win.start + win.rows);
  return (
    <Box flexDirection="column">
      {win.aboveCount > 0 && <Text dimColor>{truncateToWidth(`↑ ${win.start} more`, props.width)}</Text>}
      {visible.map((item, index) => {
        const active = win.start + index === props.cursor;
        const checked = props.selected?.includes(item.value);
        // Truncate to the terminal width so a long label or summary can never
        // wrap and push the footer off-screen.
        const fitted = fitSelectionItem({ label: item.label, hint: item.hint }, props.width);
        return (
          <Text key={item.value} color={active ? "cyan" : undefined} bold={active}>
            {active ? "❯" : " "} {props.selected ? (checked ? "◼" : "◻") : " "} {fitted.label}
            {fitted.hint ? <Text dimColor> — {fitted.hint}</Text> : null}
          </Text>
        );
      })}
      {win.belowCount > 0 && <Text dimColor>{truncateToWidth(`↓ ${props.items.length - win.start - win.rows} more`, props.width)}</Text>}
    </Box>
  );
}

function Lines(props: { lines: readonly string[]; offset: number; height: number; width?: number }) {
  // The window budgets the ↑/↓ indicator rows inside `height`, so content plus
  // rendered indicators never overflow the body — even mid-scroll.
  const win = linesWindow(props.lines.length, props.offset, props.height);
  const visible = props.lines.slice(win.start, win.start + win.rows);
  return (
    <Box flexDirection="column">
      {win.aboveCount > 0 && <Text dimColor>{truncateToWidth(`↑ ${win.start} lines above`, props.width)}</Text>}
      {visible.map((line, index) => (
        <Text key={`${win.start + index}:${line}`}>{truncateToWidth(line || " ", props.width)}</Text>
      ))}
      {win.belowCount > 0 && <Text dimColor>{truncateToWidth(`↓ ${props.lines.length - win.start - win.rows} lines below`, props.width)}</Text>}
    </Box>
  );
}

// Fixed multi-row confirmation bodies: rows are budgeted to the body height
// (warning first) so even a one-row terminal renders a valid body.
function ConfirmBanner(props: { lines: readonly string[]; height: number; width?: number; warnFirst?: boolean }) {
  return (
    <Box flexDirection="column">
      {budgetLines(props.lines, props.height).map((line, index) => (
        <Text key={`${index}:${line}`} color={props.warnFirst && index === 0 ? "yellow" : undefined}>
          {truncateToWidth(line || " ", props.width)}
        </Text>
      ))}
    </Box>
  );
}

function ControlCenter() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // Body height derives from the actual fixed chrome (header, tagline, two
  // margins, footer) — no overflow floor. On a short terminal the body shrinks
  // instead of pushing the footer off-screen.
  const bodyHeight = controlCenterBodyHeight(stdout.rows);
  // Body children render inside paddingX={1}: budget columns - 2, never raw
  // terminal width, or an exact-fit line wraps and moves the footer.
  const bodyColumns = contentWidth(stdout.columns);
  const action = useAsyncAction();
  // Explicit screen states. The sync preview and the sync result are different
  // screens with different key policy; nothing infers mode from report shape.
  const [screen, setScreen] = useState<ControlCenterScreen>("home");
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  const [overview, setOverview] = useState<PluginOverview>();
  const [detailKey, setDetailKey] = useState<string>();
  const [syncPreview, setSyncPreview] = useState<SyncReport>();
  const [syncResult, setSyncResult] = useState<SyncReport>();
  const [doctor, setDoctor] = useState<PluginDoctorReport>();
  const [activationVerb, setActivationVerb] = useState<PluginActivationOp>("enable");
  const [selectedConfigurePlugins, setSelectedConfigurePlugins] = useState<string[]>([]);
  const [selectedConfigureAgents, setSelectedConfigureAgents] = useState<AgentId[]>([]);
  const [pendingActivationAgents, setPendingActivationAgents] = useState<AgentId[]>([]);
  const [activationPreview, setActivationPreview] = useState<ActivationReport>();
  const [activationResult, setActivationResult] = useState<ActivationReport>();
  const [selectedPlugins, setSelectedPlugins] = useState<string[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<AgentId[]>([]);
  const [removePreview, setRemovePreview] = useState<UninstallReport>();
  const [removeResult, setRemoveResult] = useState<UninstallReport>();
  const [keepData, setKeepData] = useState(false);
  const [updatePlan, setUpdatePlan] = useState<SelfUpdatePlan>();
  const [updateMessage, setUpdateMessage] = useState<string>();

  const pluginRows = useMemo(() => pluginOverviewRows(overview ?? { native: [] }), [overview]);
  const detailRow = useMemo(
    () => pluginRows.find((row) => row.plugin === detailKey),
    [pluginRows, detailKey],
  );
  const pluginItems = useMemo(
    () => pluginRows.map((row) => ({ value: row.plugin, label: row.plugin, hint: pluginRowSummary(row) })),
    [pluginRows],
  );
  const allAgents = useMemo(() => unique(pluginReconcileTargets().map((target) => target.agent)), []);
  const agentItems = useMemo(() => allAgents.map((agent) => ({ value: agent, label: agent })), [allAgents]);

  useEffect(() => {
    void action.run("Reading installed plugins", buildPluginOverview).then((result) => {
      if (result.ok) setOverview(result.value);
    });
  }, []);

  const open = (next: ControlCenterScreen) => {
    action.clearError();
    setCursor(0);
    setOffset(0);
    setScreen(next);
  };

  const previewSync = async () => {
    open("sync-preview");
    setSyncPreview(undefined);
    const result = await action.run("Building a safe synchronization preview", () => runSync({ dryRun: true }));
    if (result.ok) setSyncPreview(result.value);
  };

  const applySync = async () => {
    const result = await action.run("Synchronizing and verifying plugin activation", () => runSync({ dryRun: false }));
    if (!result.ok) return;
    setSyncResult(result.value);
    open("sync-result");
    // Keep the installed list truthful after any write, same as removal/configure.
    const refreshed = await action.run("Refreshing the installed list", buildPluginOverview);
    if (refreshed.ok) setOverview(refreshed.value);
  };

  const openDetail = (plugin: string) => {
    setDetailKey(plugin);
    open("plugin-detail");
  };

  const previewActivation = async (agents: AgentId[], scope?: PluginActivationScope) => {
    setSelectedConfigureAgents(agents);
    setPendingActivationAgents([]);
    open("configure-preview");
    setActivationPreview(undefined);
    const result = await action.run("Building an exact activation preview", () => runPluginActivation({
      op: activationVerb,
      plugins: selectedConfigurePlugins,
      agents,
      ...(scope ? { scope } : {}),
      apply: false,
    }));
    if (result.ok) setActivationPreview(result.value);
  };

  const beginActivation = async (agents: AgentId[]) => {
    // Claude Code alone may choose an explicit --scope; mixed or all target
    // sets omit the flag and let the preview surface any record ambiguity.
    if (agents.length === 1 && agents[0] === "claude-code") {
      setSelectedConfigureAgents(agents);
      setPendingActivationAgents(agents);
      open("configure-claude-scope");
      return;
    }
    await previewActivation(agents, undefined);
  };

  const applyActivation = async () => {
    if (!activationPreview) return;
    // The confirmed preview is authoritative: apply replays its exact op,
    // scope, and record plan. The service re-checks each record against a
    // fresh native read before mutating; drift fails without any command.
    const scope = activationPreview.scope;
    const result = await action.run("Applying activation and verifying with a fresh read", () => runPluginActivation({
      op: activationVerb,
      plugins: selectedConfigurePlugins,
      agents: selectedConfigureAgents,
      ...(scope ? { scope } : {}),
      apply: true,
      confirmedPreview: activationPreview,
    }));
    if (!result.ok) return;
    setActivationResult(result.value);
    open("configure-result");
    const refreshed = await action.run("Refreshing the installed list", buildPluginOverview);
    if (refreshed.ok) setOverview(refreshed.value);
  };

  const runDoctor = async () => {
    open("doctor");
    setDoctor(undefined);
    const result = await action.run("Checking sources, targets, and outcomes", runPluginDoctor);
    if (result.ok) setDoctor(result.value);
  };

  const previewRemoval = async (agents: AgentId[], preserveData = keepData) => {
    setSelectedAgents(agents);
    open("remove-preview");
    setRemovePreview(undefined);
    const result = await action.run("Building an exact removal preview", () => runPluginUninstall({
      plugins: selectedPlugins,
      agents,
      apply: false,
      keepData: preserveData,
    }));
    if (result.ok) setRemovePreview(result.value);
  };

  const applyRemoval = async () => {
    if (!removePreview) return;
    const result = await action.run("Removing selected plugin state and verifying the result", () => runPluginUninstall({
      plugins: selectedPlugins,
      agents: selectedAgents,
      apply: true,
      keepData,
    }));
    if (!result.ok) return;
    setRemoveResult(result.value);
    open("remove-result");
    // The plugin map refresh goes through the same async boundary as every
    // other action; failures surface on the banner instead of being swallowed.
    const refreshed = await action.run("Refreshing the plugin map", buildPluginOverview);
    if (refreshed.ok) setOverview(refreshed.value);
  };

  const previewUpdate = async () => {
    open("update");
    setUpdatePlan(undefined);
    setUpdateMessage(undefined);
    const result = await action.run("Resolving the installed Syncthis package", planSelfUpdate);
    if (result.ok) setUpdatePlan(result.value);
  };

  const applyUpdate = async () => {
    if (!updatePlan) return;
    const result = await action.run("Updating the installed Syncthis package", () => runSelfUpdate({ plan: updatePlan }));
    if (result.ok) {
      setUpdateMessage(result.value.message);
      open("update");
    }
  };

  const snapshot = (): ControlCenterSnapshot => ({
    screen,
    cursor,
    offset,
    loading: !!action.loading,
    hasError: !!action.error,
    menuLength: MAIN_MENU.length,
    listLength: snapshotListLength(),
    selectedCount: snapshotSelectedCount(),
    syncPreviewReady: !!syncPreview,
    syncApplyAvailable: !!syncPreview
      && screen === "sync-preview"
      && syncPreview.plugins.dryRun
      && syncPreview.ok
      && pluginSyncHasChanges(syncPreview),
    removePreviewReady: !!removePreview,
    removeApplyAvailable: !!removePreview && uninstallHasChanges(removePreview),
    configurePreviewReady: !!activationPreview,
    configureApplyAvailable: !!activationPreview
      && screen === "configure-preview"
      && activationHasChanges(activationPreview),
    updatePlanReady: !!updatePlan,
    updateCompleted: !!updateMessage,
  });

  const snapshotListLength = () => {
    if (screen === "remove-agents" || screen === "configure-agents") return agentItems.length;
    if (screen === "configure-verb") return 2;
    if (screen === "configure-claude-scope") return CLAUDE_SCOPE_OPTIONS.length;
    return pluginItems.length;
  };

  const snapshotSelectedCount = () => {
    if (screen === "remove-agents") return selectedAgents.length;
    if (screen === "configure-plugins") return selectedConfigurePlugins.length;
    if (screen === "configure-agents") return selectedConfigureAgents.length;
    return selectedPlugins.length;
  };

  const execute = (command: ControlCenterCommand) => {
    switch (command.type) {
      case "exit":
        exit();
        return;
      case "navigate":
        if (command.screen === "home") open("home");
        else if (command.screen === "plugin-detail") {
          const item = pluginItems[cursor];
          if (item) openDetail(item.value);
        } else {
          const next = applyNonHomeNavigate(command.screen);
          setCursor(next.cursor);
          setOffset(next.offset);
          setScreen(next.screen);
        }
        return;
      case "set-cursor":
        setCursor(command.value);
        return;
      case "move-cursor": {
        const last = (command.wrap ? MAIN_MENU.length : snapshotListLength()) - 1;
        setCursor((value) => {
          const next = value + command.delta;
          if (command.wrap) return (next + MAIN_MENU.length) % MAIN_MENU.length;
          return Math.max(0, Math.min(last, next));
        });
        return;
      }
      case "scroll":
        setOffset((value) => Math.max(0, value + command.delta));
        return;
      case "toggle-list-item": {
        if (screen === "remove-agents") {
          const item = agentItems[command.index];
          if (item) setSelectedAgents((values) => toggle(values, item.value as AgentId));
        } else if (screen === "configure-plugins") {
          const item = pluginItems[command.index];
          if (item) setSelectedConfigurePlugins((values) => toggle(values, item.value));
        } else if (screen === "configure-agents") {
          const item = agentItems[command.index];
          if (item) setSelectedConfigureAgents((values) => toggle(values, item.value as AgentId));
        } else {
          const item = pluginItems[command.index];
          if (item) setSelectedPlugins((values) => toggle(values, item.value));
        }
        return;
      }
      case "toggle-keep-data": {
        const next = !keepData;
        setKeepData(next);
        void previewRemoval(selectedAgents, next);
        return;
      }
      case "choose-option": {
        if (screen === "configure-verb") {
          setActivationVerb(command.index === 0 ? "enable" : "disable");
          setSelectedConfigurePlugins([]);
          open("configure-plugins");
        } else if (screen === "configure-claude-scope") {
          const choice = CLAUDE_SCOPE_OPTIONS[command.index]?.value;
          if (choice) void previewActivation(pendingActivationAgents, claudeScopeChoice(choice));
        }
        return;
      }
      case "activate-menu": {
        const choice = MAIN_MENU[command.index]?.value;
        if (choice === "quit") exit();
        else if (choice === "overview") open("overview");
        else if (choice === "sync") void previewSync();
        else if (choice === "doctor") void runDoctor();
        else if (choice === "remove") {
          setSelectedPlugins([]);
          setKeepData(false);
          open("remove-plugins");
        } else if (choice === "configure") {
          setActivationVerb("enable");
          setSelectedConfigurePlugins([]);
          open("configure-verb");
        } else if (choice === "update") void previewUpdate();
        return;
      }
      case "run":
        if (command.task === "preview-sync") void previewSync();
        else if (command.task === "apply-sync") void applySync();
        else if (command.task === "doctor") void runDoctor();
        else if (command.task === "preview-activation-all") void beginActivation(allAgents);
        else if (command.task === "preview-activation-agents") void beginActivation(selectedConfigureAgents);
        else if (command.task === "apply-activation") void applyActivation();
        else if (command.task === "preview-removal-all") void previewRemoval(allAgents);
        else if (command.task === "preview-removal-agents") void previewRemoval(selectedAgents);
        else if (command.task === "apply-removal") void applyRemoval();
        else if (command.task === "plan-update") void previewUpdate();
        else if (command.task === "apply-update") void applyUpdate();
        return;
    }
  };

  useInput((input, key) => {
    const command = handleControlCenterKey(snapshot(), {
      input,
      escape: key.escape,
      return: key.return,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
    });
    if (command) execute(command);
  });

  const live = snapshot();
  const counts = overview ? overviewCounts(overview) : undefined;
  let title = "Plugin hub";
  let content: React.ReactNode;
  let footer = "↑↓ navigate · enter open · q quit";

  if (action.loading) {
    content = <Text color="cyan">{truncateToWidth(`◒ ${action.loading}…`, bodyColumns)}</Text>;
    footer = "Please wait. Safe previews never write.";
  } else if (action.error) {
    content = <Text color="red">{truncateToWidth(`Blocked: ${neutralPluginText(action.error, "operation failed")}`, bodyColumns)}</Text>;
    footer = "b back";
  } else if (screen === "home") {
    // counts(1) + margin(1) + menu only when the body can hold all three;
    // tiny terminals drop the optional status line instead of overflowing.
    const home = stackedLayout(bodyHeight);
    content = (
      <Box flexDirection="column">
        {home.showIntro && <Text>{truncateToWidth(counts ? `${counts.plugins} plugins · ${counts.nativeInstalls} native installs · ${counts.readableAgents}/4 sources readable` : "Reading installed plugin state…", bodyColumns)}</Text>}
        <Box {...(home.showIntro ? { marginTop: 1 as const } : {})}><SelectionList items={MAIN_MENU} cursor={cursor} height={home.listRows} width={bodyColumns} /></Box>
      </Box>
    );
  } else if (screen === "overview") {
    title = "Installed plugins";
    content = pluginItems.length
      ? <SelectionList items={pluginItems} cursor={cursor} height={bodyHeight} width={bodyColumns} />
      : <Text>{truncateToWidth("No readable agent reports an installed plugin.", bodyColumns)}</Text>;
    footer = "enter inspect this plugin · b back";
  } else if (screen === "plugin-detail") {
    title = detailRow?.plugin ?? "Installed plugin";
    content = <Lines lines={detailRow ? pluginDetailLines(overview ?? { native: [] }, detailRow) : ["No plugin selected."]} offset={offset} height={bodyHeight} width={bodyColumns} />;
    footer = "↑↓ scroll · b back";
  } else if (screen === "sync-preview") {
    title = "Synchronization preview";
    content = <Lines lines={syncPreview ? renderPluginSyncReport(syncPreview) : ["Preparing preview…"]} offset={offset} height={bodyHeight} width={bodyColumns} />;
    footer = live.syncApplyAvailable
      ? "a apply all planned changes · b cancel"
      : "↑↓ scroll · b back";
  } else if (screen === "sync-confirm") {
    title = "Confirm synchronization";
    content = <ConfirmBanner lines={["Apply the complete synchronization preview across every supported target?"]} height={bodyHeight} width={bodyColumns} />;
    footer = "y confirm and apply · n return to preview · b cancel";
  } else if (screen === "sync-result") {
    title = "Synchronization result";
    content = <Lines lines={syncResult ? renderPluginSyncReport(syncResult) : ["No result available."]} offset={offset} height={bodyHeight} width={bodyColumns} />;
    footer = "↑↓ scroll · b back";
  } else if (screen === "doctor") {
    title = "Doctor";
    content = <Lines lines={doctor ? renderPluginDoctor(doctor) : ["Running diagnostics…"]} offset={offset} height={bodyHeight} width={bodyColumns} />;
    footer = "↑↓ scroll · b back";
  } else if (screen === "configure-verb") {
    title = "Configure · choose action";
    content = <SelectionList items={[
      { value: "enable", label: "Enable", hint: "turn installed plugins on" },
      { value: "disable", label: "Disable", hint: "turn them off without uninstalling" },
    ]} cursor={cursor} height={bodyHeight} width={bodyColumns} />;
    footer = "enter choose action · b cancel";
  } else if (screen === "configure-plugins") {
    title = `Configure ${activationVerb} · choose plugins`;
    content = pluginItems.length
      ? <SelectionList items={pluginItems} cursor={cursor} selected={selectedConfigurePlugins} height={bodyHeight} width={bodyColumns} />
      : <Text>{truncateToWidth("No readable installed plugins can be selected.", bodyColumns)}</Text>;
    footer = "space toggle · enter continue · b cancel";
  } else if (screen === "configure-scope") {
    title = `Configure ${activationVerb} · choose targets`;
    content = <SelectionList items={[
      { value: "all", label: "All supported agents", hint: `${allAgents.length} explicit targets` },
      { value: "some", label: "Choose agents", hint: "select an exact target list" },
    ]} cursor={cursor} height={bodyHeight} width={bodyColumns} />;
    footer = "enter choose targets · b cancel";
  } else if (screen === "configure-agents") {
    title = `Configure ${activationVerb} · choose agents`;
    content = <SelectionList items={agentItems} cursor={cursor} selected={selectedConfigureAgents} height={bodyHeight} width={bodyColumns} />;
    footer = "space toggle · enter preview · b cancel";
  } else if (screen === "configure-claude-scope") {
    title = "Configure · Claude Code scope";
    // intro(1) + list only when the body holds both; otherwise list only.
    const scopeLayout = introListLayout(bodyHeight);
    content = (
      <Box flexDirection="column">
        {scopeLayout.showIntro && <Text>{truncateToWidth("The exact target set is Claude Code only, so the config scope is yours to pick.", bodyColumns)}</Text>}
        <SelectionList items={CLAUDE_SCOPE_OPTIONS.map((option) => ({ value: option.value, label: option.label, hint: option.hint }))} cursor={cursor} height={scopeLayout.listRows} width={bodyColumns} />
      </Box>
    );
    footer = "enter pick scope · b cancel";
  } else if (screen === "configure-preview") {
    title = `${activationVerb === "enable" ? "Enable" : "Disable"} preview`;
    content = <Lines lines={activationPreview ? renderActivationPreview(activationPreview) : ["Preparing preview…"]} offset={offset} height={bodyHeight} width={bodyColumns} />;
    footer = live.configureApplyAvailable
      ? "a apply exactly this scope · b cancel"
      : "↑↓ scroll · b back · nothing will change";
  } else if (screen === "configure-confirm") {
    title = `Confirm ${activationVerb}`;
    content = <ConfirmBanner warnFirst height={bodyHeight} width={bodyColumns} lines={[
      `This will ${activationVerb} ${selectedConfigurePlugins.length} plugin selection(s)${selectedConfigureAgents.length ? ` on ${selectedConfigureAgents.length} explicit target(s)` : ""}.`,
      "Every change runs through each target's own command and is verified by a fresh native read.",
      "Unsupported targets are reported as unsupported — never guessed or claimed.",
    ]} />;
    footer = `y confirm ${activationVerb} · n return to preview · b cancel`;
  } else if (screen === "configure-result") {
    title = `Configure result`;
    content = <Lines lines={activationResult ? renderActivationResult(activationResult) : ["No result available."]} offset={offset} height={bodyHeight} width={bodyColumns} />;
    footer = "↑↓ scroll · b back";
  } else if (screen === "remove-plugins") {
    title = "Remove · choose plugins";
    content = pluginItems.length
      ? <SelectionList items={pluginItems} cursor={cursor} selected={selectedPlugins} height={bodyHeight} width={bodyColumns} />
      : <Text>{truncateToWidth("No readable installed plugins can be selected.", bodyColumns)}</Text>;
    footer = "space toggle · enter continue · b cancel";
  } else if (screen === "remove-scope") {
    title = "Remove · choose scope";
    content = <SelectionList items={[
      { value: "all", label: "All supported agents", hint: `${allAgents.length} explicit targets` },
      { value: "some", label: "Choose agents", hint: "select an exact target list" },
    ]} cursor={cursor} height={bodyHeight} width={bodyColumns} />;
    footer = "enter choose scope · b cancel";
  } else if (screen === "remove-agents") {
    title = "Remove · choose agents";
    content = <SelectionList items={agentItems} cursor={cursor} selected={selectedAgents} height={bodyHeight} width={bodyColumns} />;
    footer = "space toggle · enter preview · b cancel";
  } else if (screen === "remove-preview") {
    title = "Removal preview";
    content = <Lines lines={removePreview ? renderUninstallPreview(removePreview) : ["Preparing preview…"]} offset={offset} height={bodyHeight} width={bodyColumns} />;
    footer = live.removeApplyAvailable
      ? `r remove exactly this scope · d keep data: ${keepData ? "on" : "off"} · b cancel`
      : "b back · nothing will be removed";
  } else if (screen === "remove-confirm") {
    title = "Confirm removal";
    content = <ConfirmBanner warnFirst height={bodyHeight} width={bodyColumns} lines={[
      `This removes ${selectedPlugins.length} plugin selection(s) from ${selectedAgents.length} explicit target(s).`,
      "The preview remains authoritative. Conflicts and content still owned elsewhere stay untouched.",
    ]} />;
    footer = "y confirm removal · n return to preview · b cancel";
  } else if (screen === "remove-result") {
    title = "Removal result";
    content = <Lines lines={removeResult ? renderUninstallResult(removeResult) : ["No result available."]} offset={offset} height={bodyHeight} width={bodyColumns} />;
    footer = "↑↓ scroll · b back";
  } else if (screen === "update") {
    title = "Update Syncthis";
    const lines = updateMessage
      ? [updateMessage]
      : updatePlan
        ? ["Package: @forsvn/syncthis", `Command: ${updatePlan.display}`, `Current: ${updatePlan.before ?? "unknown"}`, `Target: ${updatePlan.packageRoot ?? "package-manager default"}`]
        : ["Resolving update plan…"];
    content = <Lines lines={lines} offset={offset} height={bodyHeight} width={bodyColumns} />;
    footer = updatePlan && !updateMessage ? "u run this update · b cancel" : "b back";
  } else {
    title = "Confirm Syncthis update";
    content = <ConfirmBanner lines={[`Run ${updatePlan?.display ?? "the planned package update"}?`]} height={bodyHeight} width={bodyColumns} />;
    footer = "y confirm update · n return to preview · b cancel";
  }

  // Fixed-chrome cells are width-budgeted so narrow terminals can't wrap them.
  // Derived after the screen branch above finalizes `title`.
  const header = headerCells(title, stdout.columns);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">{header.wordmark}</Text>
        {header.title ? <Text dimColor>{header.title}</Text> : null}
      </Box>
      <Text dimColor>{truncateToWidth(TAGLINE, bodyColumns)}</Text>
      <Box marginTop={1} flexDirection="column">{content}</Box>
      <Box marginTop={1}><Text dimColor>{truncateToWidth(footer, bodyColumns)}</Text></Box>
    </Box>
  );
}

export async function renderControlCenter(): Promise<void> {
  const app = render(<ControlCenter />);
  await app.waitUntilExit();
}
