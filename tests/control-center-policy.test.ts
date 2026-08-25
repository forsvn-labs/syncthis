import { describe, expect, test } from "bun:test";
import {
  handleControlCenterKey,
  type ControlCenterSnapshot,
} from "../src/cli/control-center-policy.ts";

function snapshot(overrides: Partial<ControlCenterSnapshot> = {}): ControlCenterSnapshot {
  return {
    screen: "home",
    cursor: 0,
    offset: 0,
    loading: false,
    hasError: false,
    menuLength: 6,
    listLength: 3,
    selectedCount: 0,
    syncPreviewReady: true,
    syncApplyAvailable: true,
    removePreviewReady: true,
    removeApplyAvailable: true,
    updatePlanReady: true,
    updateCompleted: false,
    ...overrides,
  };
}

describe("control-center screen/input policy", () => {
  test("loading suppresses every key including destructive ones", () => {
    const state = snapshot({ screen: "sync-preview", loading: true });
    expect(handleControlCenterKey(state, { input: "a" })).toBeUndefined();
    expect(handleControlCenterKey(state, { input: "y", return: true })).toBeUndefined();
    expect(handleControlCenterKey(state, { input: "b" })).toBeUndefined();
  });

  test("an error banner gates every stale action except back/cancel", () => {
    const state = snapshot({ screen: "sync-confirm", hasError: true });
    expect(handleControlCenterKey(state, { input: "y" })).toBeUndefined();
    expect(handleControlCenterKey(state, { input: "a" })).toBeUndefined();
    expect(handleControlCenterKey(state, { input: "r" })).toBeUndefined();
    expect(handleControlCenterKey(state, { input: "u" })).toBeUndefined();
    // Back/cancel stays available so the user can always leave the dead end.
    expect(handleControlCenterKey(state, { input: "b" })).toEqual({
      type: "navigate",
      screen: "home",
    });
    expect(handleControlCenterKey(state, { input: "", escape: true })).toEqual({
      type: "navigate",
      screen: "home",
    });
  });

  test("apply is offered only from the dry-run preview state", () => {
    expect(
      handleControlCenterKey(snapshot({ screen: "sync-preview" }), { input: "a" }),
    ).toEqual({ type: "navigate", screen: "sync-confirm" });

    // No changes / failing preview → no apply binding at all.
    expect(
      handleControlCenterKey(snapshot({ screen: "sync-preview", syncApplyAvailable: false }), {
        input: "a",
      }),
    ).toBeUndefined();

    // The result screen never re-offers apply — no hidden post-apply apply key.
    const result = snapshot({ screen: "sync-result", syncApplyAvailable: true });
    expect(handleControlCenterKey(result, { input: "a" })).toBeUndefined();
    expect(handleControlCenterKey(result, { input: "y" })).toBeUndefined();
  });

  test("the sync flow runs preview → confirm → apply in strict order", () => {
    const state: { screen: ControlCenterSnapshot["screen"] } = { screen: "sync-preview" };
    let tasks: string[] = [];
    const current = () => state.screen;
    const dispatch = (key: Parameters<typeof handleControlCenterKey>[1]) => {
      const command = handleControlCenterKey(snapshot({ screen: state.screen }), key);
      if (!command) return;
      if (command.type === "navigate") state.screen = command.screen;
      if (command.type === "run") tasks.push(command.task);
    };
    dispatch({ input: "a" });
    expect(current()).toBe("sync-confirm");
    dispatch({ input: "n" });
    expect(current()).toBe("sync-preview");
    dispatch({ input: "a" });
    dispatch({ input: "y" });
    expect(tasks).toEqual(["apply-sync"]);
  });

  test("removal apply requires the preview seam and an exact scope", () => {
    expect(
      handleControlCenterKey(snapshot({ screen: "remove-preview" }), { input: "r" }),
    ).toEqual({ type: "navigate", screen: "remove-confirm" });
    expect(
      handleControlCenterKey(snapshot({ screen: "remove-preview", removeApplyAvailable: false }), {
        input: "r",
      }),
    ).toBeUndefined();
    expect(
      handleControlCenterKey(snapshot({ screen: "remove-result" }), { input: "r" }),
    ).toBeUndefined();
    expect(
      handleControlCenterKey(snapshot({ screen: "remove-preview" }), { input: "d" }),
    ).toEqual({ type: "toggle-keep-data" });
  });

  test("list activation requires an explicit selection", () => {
    expect(
      handleControlCenterKey(snapshot({ screen: "remove-plugins", selectedCount: 0 }), {
        input: "",
        return: true,
      }),
    ).toBeUndefined();
    expect(
      handleControlCenterKey(snapshot({ screen: "remove-plugins", selectedCount: 2 }), {
        input: "",
        return: true,
      }),
    ).toEqual({ type: "navigate", screen: "remove-scope" });
    expect(
      handleControlCenterKey(
        snapshot({ screen: "remove-plugins", selectedCount: 0, cursor: 2 }),
        { input: " " },
      ),
    ).toEqual({ type: "toggle-list-item", index: 2 });
  });

  test("update keys require a ready plan and disappear once completed", () => {
    expect(handleControlCenterKey(snapshot({ screen: "update" }), { input: "u" })).toEqual({
      type: "navigate",
      screen: "update-confirm",
    });
    expect(
      handleControlCenterKey(snapshot({ screen: "update", updatePlanReady: false }), {
        input: "u",
      }),
    ).toBeUndefined();
    expect(
      handleControlCenterKey(snapshot({ screen: "update", updateCompleted: true }), {
        input: "u",
      }),
    ).toBeUndefined();
    expect(handleControlCenterKey(snapshot({ screen: "update-confirm" }), { input: "y" })).toEqual(
      { type: "run", task: "apply-update" },
    );
    expect(handleControlCenterKey(snapshot({ screen: "update-confirm" }), { input: "n" })).toEqual(
      { type: "navigate", screen: "update" },
    );
  });

  test("menu navigation wraps on home and clamps inside lists", () => {
    expect(
      handleControlCenterKey(snapshot({ cursor: 0 }), { input: "", upArrow: true }),
    ).toEqual({ type: "move-cursor", delta: -1, wrap: true });
    expect(
      handleControlCenterKey(snapshot({ screen: "remove-plugins", cursor: 0 }), {
        input: "",
        upArrow: true,
      }),
    ).toEqual({ type: "move-cursor", delta: -1, wrap: false });
    expect(handleControlCenterKey(snapshot(), { input: "" })).toBeUndefined();
    expect(handleControlCenterKey(snapshot(), { input: "q" })).toEqual({ type: "exit" });
  });
});
