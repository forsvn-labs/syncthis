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
import { neutralPluginText } from "./cli/render-plugins.ts";
import { runPluginDoctor, renderPluginDoctor, type PluginDoctorReport } from "./plugins/doctor-report.ts";
import {
  buildPluginOverview,
  overviewCounts,
  pluginOverviewRows,
  renderPluginOverview,
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
}) {
  const start = Math.max(0, Math.min(props.cursor - Math.floor(props.height / 2), Math.max(0, props.items.length - props.height)));
  const visible = props.items.slice(start, start + props.height);
  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>↑ {start} more</Text>}
      {visible.map((item, index) => {
        const active = start + index === props.cursor;
        const checked = props.selected?.includes(item.value);
        return (
          <Text key={item.value} color={active ? "cyan" : undefined} bold={active}>
            {active ? "❯" : " "} {props.selected ? (checked ? "◼" : "◻") : " "} {item.label}
            {item.hint ? <Text dimColor> — {item.hint}</Text> : null}
          </Text>
        );
      })}
      {start + visible.length < props.items.length && <Text dimColor>↓ {props.items.length - start - visible.length} more</Text>}
    </Box>
  );
}

function Lines(props: { lines: readonly string[]; offset: number; height: number }) {
  const start = Math.min(props.offset, Math.max(0, props.lines.length - props.height));
  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>↑ {start} lines above</Text>}
      {props.lines.slice(start, start + props.height).map((line, index) => <Text key={`${start + index}:${line}`}>{line || " "}</Text>)}
      {start + props.height < props.lines.length && <Text dimColor>↓ {props.lines.length - start - props.height} lines below</Text>}
    </Box>
  );
}

function ControlCenter() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const bodyHeight = Math.max(7, (stdout.rows ?? 24) - 9);
  const action = useAsyncAction();
  // Explicit screen states. The sync preview and the sync result are different
  // screens with different key policy; nothing infers mode from report shape.
  const [screen, setScreen] = useState<ControlCenterScreen>("home");
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  const [overview, setOverview] = useState<PluginOverview>();
  const [syncPreview, setSyncPreview] = useState<SyncReport>();
  const [syncResult, setSyncResult] = useState<SyncReport>();
  const [doctor, setDoctor] = useState<PluginDoctorReport>();
  const [selectedPlugins, setSelectedPlugins] = useState<string[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<AgentId[]>([]);
  const [removePreview, setRemovePreview] = useState<UninstallReport>();
  const [removeResult, setRemoveResult] = useState<UninstallReport>();
  const [keepData, setKeepData] = useState(false);
  const [updatePlan, setUpdatePlan] = useState<SelfUpdatePlan>();
  const [updateMessage, setUpdateMessage] = useState<string>();

  const pluginItems = useMemo(
    () => pluginOverviewRows(overview ?? { native: [] }).map((row) => ({ value: row.plugin, label: row.plugin })),
    [overview],
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
    if (result.ok) {
      setSyncResult(result.value);
      open("sync-result");
    }
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
    listLength: screen === "remove-agents" ? agentItems.length : pluginItems.length,
    selectedCount: screen === "remove-agents" ? selectedAgents.length : selectedPlugins.length,
    syncPreviewReady: !!syncPreview,
    syncApplyAvailable: !!syncPreview
      && screen === "sync-preview"
      && syncPreview.plugins.dryRun
      && syncPreview.ok
      && pluginSyncHasChanges(syncPreview),
    removePreviewReady: !!removePreview,
    removeApplyAvailable: !!removePreview && uninstallHasChanges(removePreview),
    updatePlanReady: !!updatePlan,
    updateCompleted: !!updateMessage,
  });

  const execute = (command: ControlCenterCommand) => {
    switch (command.type) {
      case "exit":
        exit();
        return;
      case "navigate":
        if (command.screen === "home") open("home");
        else {
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
        } else if (choice === "update") void previewUpdate();
        return;
      }
      case "run":
        if (command.task === "preview-sync") void previewSync();
        else if (command.task === "apply-sync") void applySync();
        else if (command.task === "doctor") void runDoctor();
        else if (command.task === "preview-removal-all") void previewRemoval(allAgents);
        else if (command.task === "preview-removal-agents") void previewRemoval(selectedAgents);
        else if (command.task === "apply-removal") void applyRemoval();
        else if (command.task === "plan-update") void previewUpdate();
        else if (command.task === "apply-update") void applyUpdate();
        return;
    }
  };

  const snapshotListLength = () =>
    screen === "remove-agents" ? agentItems.length : pluginItems.length;

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
  let title = "Control center";
  let content: React.ReactNode;
  let footer = "↑↓ navigate · enter open · q quit";

  if (action.loading) {
    content = <Text color="cyan">◒ {action.loading}…</Text>;
    footer = "Please wait. Safe previews never write.";
  } else if (action.error) {
    content = <Text color="red">Blocked: {neutralPluginText(action.error, "operation failed")}</Text>;
    footer = "b back";
  } else if (screen === "home") {
    content = (
      <Box flexDirection="column">
        <Text>{counts ? `${counts.plugins} plugins · ${counts.nativeInstalls} native installs · ${counts.readableAgents}/4 sources readable` : "Reading installed plugin state…"}</Text>
        <Box marginTop={1}><SelectionList items={MAIN_MENU} cursor={cursor} height={bodyHeight - 2} /></Box>
      </Box>
    );
  } else if (screen === "overview") {
    title = "Plugin map";
    content = <Lines lines={overview ? renderPluginOverview(overview) : ["No overview available."]} offset={offset} height={bodyHeight} />;
    footer = "↑↓ scroll · b back";
  } else if (screen === "sync-preview") {
    title = "Synchronization preview";
    content = <Lines lines={syncPreview ? renderPluginSyncReport(syncPreview) : ["Preparing preview…"]} offset={offset} height={bodyHeight} />;
    footer = live.syncApplyAvailable
      ? "a apply all planned changes · b cancel"
      : "↑↓ scroll · b back";
  } else if (screen === "sync-confirm") {
    title = "Confirm synchronization";
    content = <Text>Apply the complete synchronization preview across every supported target?</Text>;
    footer = "y confirm and apply · n return to preview · b cancel";
  } else if (screen === "sync-result") {
    title = "Synchronization result";
    content = <Lines lines={syncResult ? renderPluginSyncReport(syncResult) : ["No result available."]} offset={offset} height={bodyHeight} />;
    footer = "↑↓ scroll · b back";
  } else if (screen === "doctor") {
    title = "Doctor";
    content = <Lines lines={doctor ? renderPluginDoctor(doctor) : ["Running diagnostics…"]} offset={offset} height={bodyHeight} />;
    footer = "↑↓ scroll · b back";
  } else if (screen === "remove-plugins") {
    title = "Remove · choose plugins";
    content = pluginItems.length
      ? <SelectionList items={pluginItems} cursor={cursor} selected={selectedPlugins} height={bodyHeight} />
      : <Text>No readable installed plugins can be selected.</Text>;
    footer = "space toggle · enter continue · b cancel";
  } else if (screen === "remove-scope") {
    title = "Remove · choose scope";
    content = <SelectionList items={[
      { value: "all", label: "All supported agents", hint: `${allAgents.length} explicit targets` },
      { value: "some", label: "Choose agents", hint: "select an exact target list" },
    ]} cursor={cursor} height={bodyHeight} />;
    footer = "enter choose scope · b cancel";
  } else if (screen === "remove-agents") {
    title = "Remove · choose agents";
    content = <SelectionList items={agentItems} cursor={cursor} selected={selectedAgents} height={bodyHeight} />;
    footer = "space toggle · enter preview · b cancel";
  } else if (screen === "remove-preview") {
    title = "Removal preview";
    content = <Lines lines={removePreview ? renderUninstallPreview(removePreview) : ["Preparing preview…"]} offset={offset} height={bodyHeight} />;
    footer = live.removeApplyAvailable
      ? `r remove exactly this scope · d keep data: ${keepData ? "on" : "off"} · b cancel`
      : "b back · nothing will be removed";
  } else if (screen === "remove-confirm") {
    title = "Confirm removal";
    content = (
      <Box flexDirection="column">
        <Text color="yellow">This removes {selectedPlugins.length} plugin selection(s) from {selectedAgents.length} explicit target(s).</Text>
        <Text>The preview remains authoritative. Conflicts and content still owned elsewhere stay untouched.</Text>
      </Box>
    );
    footer = "y confirm removal · n return to preview · b cancel";
  } else if (screen === "remove-result") {
    title = "Removal result";
    content = <Lines lines={removeResult ? renderUninstallResult(removeResult) : ["No result available."]} offset={offset} height={bodyHeight} />;
    footer = "↑↓ scroll · b back";
  } else if (screen === "update") {
    title = "Update Syncthis";
    const lines = updateMessage
      ? [updateMessage]
      : updatePlan
        ? ["Package: @forsvn/syncthis", `Command: ${updatePlan.display}`, `Current: ${updatePlan.before ?? "unknown"}`, `Target: ${updatePlan.packageRoot ?? "package-manager default"}`]
        : ["Resolving update plan…"];
    content = <Lines lines={lines} offset={offset} height={bodyHeight} />;
    footer = updatePlan && !updateMessage ? "u run this update · b cancel" : "b back";
  } else {
    title = "Confirm Syncthis update";
    content = <Text>Run {updatePlan?.display ?? "the planned package update"}?</Text>;
    footer = "y confirm update · n return to preview · b cancel";
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">SYNCTHIS</Text>
        <Text dimColor>{title}</Text>
      </Box>
      <Text dimColor>Install a plugin once. Use it everywhere.</Text>
      <Box marginTop={1} flexDirection="column">{content}</Box>
      <Box marginTop={1}><Text dimColor>{footer}</Text></Box>
    </Box>
  );
}

export async function renderControlCenter(): Promise<void> {
  const app = render(<ControlCenter />);
  await app.waitUntilExit();
}
