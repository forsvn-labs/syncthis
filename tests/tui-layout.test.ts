import { describe, expect, test } from "bun:test";
import {
  CONTROL_CENTER_CHROME_ROWS,
  CONTROL_CENTER_PADDING_COLUMNS,
  budgetLines,
  contentWidth,
  controlCenterBodyHeight,
  fitSelectionItem,
  headerCells,
  introListLayout,
  linesWindow,
  stackedLayout,
  truncateToWidth,
  visibleRows,
} from "../src/cli/tui-layout.ts";

describe("control-center body height", () => {
  test("derives height from the actual fixed chrome rows", () => {
    expect(CONTROL_CENTER_CHROME_ROWS).toBe(5);
    expect(controlCenterBodyHeight(24)).toBe(19);
    expect(controlCenterBodyHeight(40)).toBe(35);
  });

  test("has no 7-row overflow floor: short terminals shrink the body", () => {
    // The old Math.max(7, …) floor would return 7 here and overflow a 10-row
    // terminal past its footer; the body must instead shrink.
    expect(controlCenterBodyHeight(10)).toBeLessThan(7);
    expect(controlCenterBodyHeight(10)).toBe(5);
    expect(controlCenterBodyHeight(6)).toBe(1);
    expect(controlCenterBodyHeight(1)).toBe(1);
  });

  test("falls back to the classic terminal size when dimensions are unknown", () => {
    expect(controlCenterBodyHeight(undefined)).toBe(controlCenterBodyHeight(24));
    expect(controlCenterBodyHeight(undefined)).toBeGreaterThan(0);
  });
});

describe("viewport clamping", () => {
  test("screens reserving fixed rows never request zero or negative viewports", () => {
    expect(visibleRows(0)).toBe(1);
    expect(visibleRows(-3)).toBe(1);
    expect(visibleRows(4)).toBe(4);
  });
});

describe("padded content width", () => {
  test("subtracts the root Box's horizontal padding from the terminal width", () => {
    expect(CONTROL_CENTER_PADDING_COLUMNS).toBe(2);
    expect(contentWidth(80)).toBe(78);
    expect(contentWidth(3)).toBe(1);
    expect(contentWidth(2)).toBe(1);
    expect(contentWidth(undefined)).toBe(contentWidth(80));
  });

  test("a line truncated to the padded width fits inside the terminal", () => {
    const line = truncateToWidth("/long/path/that/exactly/fills/the/padded/body".repeat(3), contentWidth(40));
    expect(line.length).toBeLessThanOrEqual(38);
  });
});

describe("width truncation", () => {
  test("leaves text untouched when it fits or the width is unknown", () => {
    expect(truncateToWidth("short", 80)).toBe("short");
    expect(truncateToWidth("exact-fit", 9)).toBe("exact-fit");
    expect(truncateToWidth("/very/long/plugin/path", undefined)).toBe("/very/long/plugin/path");
    expect(truncateToWidth("text", 0)).toBe("text");
  });

  test("truncates long detail lines within the terminal width", () => {
    const line = "/Users/someone/.claude/plugins/cache/marketplaces/a-very-long-marketplace-name";
    const out = truncateToWidth(line, 40);
    expect(out.length).toBe(40);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("/Users/someone/.claude/plugins/")).toBe(true);
  });

  test("a one-column terminal still renders one character per line", () => {
    expect(truncateToWidth("abc", 1)).toBe("a");
    expect(truncateToWidth("", 5)).toBe("");
  });
});

describe("selection item fitting", () => {
  test("roomy rows keep label and hint unchanged", () => {
    expect(fitSelectionItem({ label: "alpha@mkt", hint: "native · enabled" }, 80))
      .toEqual({ label: "alpha@mkt", hint: "native · enabled" });
  });

  test("long hints truncate so the whole row fits on one line", () => {
    const fitted = fitSelectionItem(
      { label: "alpha@mkt", hint: "native · user scope · /very/long/install/path/goes/here" },
      30,
    );
    const rendered = `❯ ◼ ${fitted.label}${fitted.hint ? ` — ${fitted.hint}` : ""}`;
    expect(rendered.length).toBeLessThanOrEqual(30);
    expect(fitted.hint!.endsWith("…")).toBe(true);
  });

  test("labels that alone overflow drop the hint and stay on one line", () => {
    const fitted = fitSelectionItem(
      { label: "a-plugin-with-an-extremely-long-descriptive-name@mkt", hint: "hint" },
      20,
    );
    expect(fitted.hint).toBeUndefined();
    expect(fitted.label.length).toBeLessThanOrEqual(16);
  });

  test("narrow widths may drop a hint that cannot fit after the label", () => {
    const fitted = fitSelectionItem({ label: "alpha", hint: "summary" }, 11);
    // usable = 11 - 4 = 7; label(5) + separator(3) leaves nothing for the hint.
    expect(fitted.hint).toBeUndefined();
    expect(fitted.label).toBe("alpha");
  });

  test("unknown width falls back instead of corrupting content", () => {
    expect(fitSelectionItem({ label: "alpha", hint: "kept" }, undefined))
      .toEqual({ label: "alpha", hint: "kept" });
  });
});

describe("Lines scroll window", () => {
  const renderedRows = (total: number, offset: number, height: number) => {
    const win = linesWindow(total, offset, height);
    return win.rows + (win.aboveCount > 0 ? 1 : 0) + (win.belowCount > 0 ? 1 : 0);
  };

  test("hard invariant: content + rendered indicators never exceed the viewport height", () => {
    for (const height of [1, 2, 3, 5, 10, 24]) {
      for (let total = 0; total <= 30; total += 1) {
        for (let offset = 0; offset <= Math.max(1, total); offset += 1) {
          expect(renderedRows(total, offset, height)).toBeLessThanOrEqual(height);
          if (total > 0) expect(linesWindow(total, offset, height).rows).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  test("a one-row viewport renders one content row and suppresses indicators", () => {
    const win = linesWindow(100, 50, 1);
    expect(win.rows).toBe(1);
    expect(win.aboveCount === 0 && win.belowCount === 0).toBe(true);
    expect(renderedRows(100, 50, 1)).toBe(1);
  });

  test("a two-row middle-scroll viewport drops an indicator instead of overflowing", () => {
    const win = linesWindow(100, 50, 2);
    // ↑ (position cue survives) + one content row = exactly 2 rows.
    expect(renderedRows(100, 50, 2)).toBe(2);
    expect(win.rows).toBe(1);
    expect(win.aboveCount).toBeGreaterThan(0);
  });

  test("mid-scroll budgets both indicators inside the height", () => {
    const win = linesWindow(100, 50, 10);
    expect(win.start).toBe(50);
    expect(win.rows).toBe(8);
    expect(win.aboveCount).toBeGreaterThan(0);
    expect(win.belowCount).toBeGreaterThan(0);
    expect(renderedRows(100, 50, 10)).toBe(10);
  });

  test("top-of-list hands unused above-indicator budget back to content", () => {
    const win = linesWindow(100, 0, 10);
    expect(win.start).toBe(0);
    expect(win.aboveCount).toBe(0);
    expect(win.rows).toBe(9);
    expect(win.belowCount).toBeGreaterThan(0);
    expect(renderedRows(100, 0, 10)).toBe(10);
  });

  test("end-scroll shifts the window back so the spare indicator row becomes content", () => {
    const win = linesWindow(10, 10, 5);
    expect(win.belowCount).toBe(0);
    expect(win.rows).toBe(4);
    expect(win.start + win.rows).toBe(10);
    expect(win.aboveCount).toBe(6);
    expect(renderedRows(10, 10, 5)).toBe(5);
  });

  test("short lists render fully without indicators", () => {
    const win = linesWindow(3, 0, 10);
    expect(win).toEqual({ start: 0, rows: 3, aboveCount: 0, belowCount: 0 });
  });
});

describe("narrow fixed chrome", () => {
  test("header cells never exceed the padded content width", () => {
    for (const columns of [3, 8, 9, 10, 12, 80]) {
      const width = contentWidth(columns);
      const { wordmark, title } = headerCells("Configure · choose plugins", columns);
      const cellCount = wordmark.length + (title ? title.length + 1 : 0);
      expect(cellCount).toBeLessThanOrEqual(width);
    }
  });

  test("title is suppressed until wordmark + separator + one column fit", () => {
    // Terminal 11 → padded width 9: SYNCTHIS(8)+sep+title would be 10 > 9.
    expect(headerCells("Overview", 11).title).toBeUndefined();
    // Terminal 12 → padded width 10: exactly one title column fits.
    const narrow = headerCells("Overview", 12);
    expect(narrow.title).toEqual("O");
  });

  test("the wordmark itself truncates below its own width", () => {
    expect(headerCells("Overview", 3).wordmark).toBe("S");
    expect(headerCells("Overview", 10).wordmark).toBe("SYNCTHIS");
    expect(headerCells("", 80).title).toBeUndefined();
  });

  test("tagline and footer truncate to the padded width", () => {
    const footer = "r remove exactly this scope · d keep data: off · b cancel";
    expect(truncateToWidth(footer, contentWidth(20)).length).toBeLessThanOrEqual(contentWidth(20));
    expect(truncateToWidth("Install a plugin once. Use it everywhere.", contentWidth(16)))
      .toBe("Install a plu…");
  });
});

describe("multi-row body budgets on a six-row terminal", () => {
  // A 6-row terminal yields a one-row body after fixed chrome.
  const bodyHeight = controlCenterBodyHeight(6);
  expect(bodyHeight).toBe(1);

  test("confirmation banners keep the warning row and drop the rest", () => {
    expect(budgetLines(["warn first", "detail two", "detail three"], bodyHeight)).toEqual(["warn first"]);
    expect(budgetLines(["warn first", "detail two"], 2)).toEqual(["warn first", "detail two"]);
    expect(budgetLines(["only row"], bodyHeight)).toEqual(["only row"]);
  });

  test("home hides the counts line + margin instead of overflowing", () => {
    expect(stackedLayout(bodyHeight)).toEqual({ showIntro: false, listRows: 1 });
    expect(stackedLayout(bodyHeight + 2)).toEqual({ showIntro: true, listRows: bodyHeight });
    // Rendered home rows: intro? + margin? + menu ≤ bodyHeight in both cases.
    const tall = stackedLayout(10);
    expect((tall.showIntro ? 2 : 0) + tall.listRows).toBeLessThanOrEqual(10);
  });

  test("claude-scope hides the intro line instead of overflowing", () => {
    expect(introListLayout(bodyHeight)).toEqual({ showIntro: false, listRows: 1 });
    expect(introListLayout(4)).toEqual({ showIntro: true, listRows: 3 });
  });
});
