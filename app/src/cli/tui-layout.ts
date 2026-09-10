// Pure layout policy for the Ink control center.
//
// Everything here is arithmetic over terminal dimensions — no React, no Ink,
// no process access — so tests can pin the exact geometry the TUI renders.
// The control center derives its body height from the ACTUAL fixed chrome
// (header, tagline, two margins, footer) instead of an arbitrary overflow
// floor, and every variable-width line is truncated to the terminal width so
// long paths can never push the footer off-screen or force a reflow.

// Rows around the body: header(1) + tagline(1) + margin(1) + margin(1) +
// footer(1). paddingX adds columns, never rows.
export const CONTROL_CENTER_CHROME_ROWS = 5;

// Classic terminal size, used only when Ink cannot report real dimensions.
export const FALLBACK_TERMINAL_ROWS = 24;
export const FALLBACK_TERMINAL_COLUMNS = 80;

// The control center's root Box renders with paddingX={1}: every child gets
// two fewer columns than the terminal, so truncation budgets must subtract
// them or an exact-width line still wraps by up to two columns.
export const CONTROL_CENTER_PADDING_COLUMNS = 2;

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/** Usable width for body children inside the padded root Box. */
export function contentWidth(terminalColumns?: number): number {
  return Math.max(
    1,
    positive(terminalColumns, FALLBACK_TERMINAL_COLUMNS) - CONTROL_CENTER_PADDING_COLUMNS,
  );
}

const WORDMARK = "SYNCTHIS";

// Columns the fixed wordmark occupies on the header row, plus one separator
// column before the right-aligned screen title. Derived from the wordmark so
// the documented budget cannot drift from its text.
export const CONTROL_CENTER_WORDMARK_COLUMNS = WORDMARK.length + 1;

export type HeaderCells = {
  /** Always present; truncated on terminals narrower than the wordmark. */
  wordmark: string;
  /** Suppressed whenever the wordmark + separator + one title column would
   * not fit inside the padded content width. */
  title?: string;
};

/**
 * Fixed-header layout for the control center title row. The rendered cells
 * never exceed the padded content width: the wordmark itself truncates on
 * very narrow terminals, and the screen title only renders when at least one
 * column remains for it after the wordmark and separator.
 */
export function headerCells(title: string, terminalColumns?: number): HeaderCells {
  const width = contentWidth(terminalColumns);
  if (width >= CONTROL_CENTER_WORDMARK_COLUMNS + 1 && title.trim().length > 0) {
    return {
      wordmark: WORDMARK,
      title: truncateToWidth(title, width - CONTROL_CENTER_WORDMARK_COLUMNS),
    };
  }
  if (width >= WORDMARK.length) return { wordmark: WORDMARK };
  return { wordmark: truncateToWidth(WORDMARK, width) };
}

/**
 * Fixed multi-row bodies (confirmation screens) keep their leading rows —
 * the warning comes first — within the body height, and always render at
 * least one row so a one-row terminal still shows why it is asking.
 */
export function budgetLines(lines: readonly string[], maxHeight: number): string[] {
  return lines.slice(0, Math.max(1, Math.floor(maxHeight)));
}

export type StackedLayout = {
  /** Whether the optional intro/status line above the list fits. */
  showIntro: boolean;
  /** Row budget for the list below (always ≥ 1). */
  listRows: number;
};

/**
 * Bodies that stack an optional intro/status line plus a list (home's counts
 * line, the Claude-scope intro): the optional line only renders when the body
 * can hold intro + margin + ≥1 list row; otherwise the list takes the body.
 */
export function stackedLayout(bodyHeight: number): StackedLayout {
  const height = Math.max(1, Math.floor(bodyHeight));
  if (height >= 3) return { showIntro: true, listRows: height - 2 };
  return { showIntro: false, listRows: height };
}

/**
 * Two-row variant (intro directly above the list, no margin row).
 */
export function introListLayout(bodyHeight: number): StackedLayout {
  const height = Math.max(1, Math.floor(bodyHeight));
  if (height >= 2) return { showIntro: true, listRows: height - 1 };
  return { showIntro: false, listRows: height };
}

// Rows the ↑/↓ scroll indicators can occupy inside a Lines viewport.
export const LINES_INDICATOR_ROWS = 2;

export type LinesWindow = {
  /** Index of the first visible line. */
  start: number;
  /** Number of content rows to render (always ≥ 1 when the list is non-empty). */
  rows: number;
  /** Hidden lines above (renders as one ↑ indicator row when > 0). */
  aboveCount: number;
  /** Hidden lines below (renders as one ↓ indicator row when > 0). */
  belowCount: number;
};

/**
 * Scroll window for the Lines viewport with the hard invariant
 * `rows + (aboveCount > 0) + (belowCount > 0) <= height`: content plus
 * rendered indicator rows never overflow the viewport, whatever the scroll
 * position. Indicators are suppressed when the viewport is too small for
 * them; content always keeps at least one row. When indicators fit, unused
 * indicator budget is handed back to content while lines remain hidden.
 */
export function linesWindow(total: number, offset: number, height: number): LinesWindow {
  const avail = Math.max(1, Math.floor(height));
  const safeTotal = Math.max(0, Math.floor(total));
  let rows = Math.min(safeTotal, Math.max(1, avail - LINES_INDICATOR_ROWS));
  let start = Math.min(Math.max(0, offset), Math.max(0, safeTotal - rows));
  let aboveCount = start;
  let belowCount = Math.max(0, safeTotal - (start + rows));

  const fits = () =>
    rows + (aboveCount > 0 ? 1 : 0) + (belowCount > 0 ? 1 : 0) <= avail;
  // Tiny viewports: drop indicators (below first) before touching content.
  if (!fits() && rows + (aboveCount > 0 ? 1 : 0) > avail) aboveCount = 0;
  if (!fits()) belowCount = 0;

  // Grow downward through hidden lines while the budget allows.
  for (;;) {
    const indicatorRows = (aboveCount > 0 ? 1 : 0) + (belowCount > 0 ? 1 : 0);
    if (belowCount === 0 || rows + indicatorRows >= avail) break;
    rows += 1;
    belowCount -= 1;
  }
  // At the end of the list there is nothing below to grow into: shift the
  // window back instead so the spare indicator row becomes content.
  if (belowCount === 0 && aboveCount > 0 && rows < avail) {
    const shift = Math.min(avail - rows - 1, aboveCount);
    if (shift > 0) {
      start -= shift;
      aboveCount -= shift;
      rows += shift;
    }
  }
  return { start, rows, aboveCount, belowCount };
}

/**
 * Body height for the given terminal height. Never reserves a fixed minimum
 * beyond one row: on a very short terminal the body shrinks (down to a single
 * visible row) instead of overflowing past the footer.
 */
export function controlCenterBodyHeight(terminalRows?: number): number {
  const rows = positive(terminalRows, FALLBACK_TERMINAL_ROWS);
  return Math.max(1, rows - CONTROL_CENTER_CHROME_ROWS);
}

/** Clamp a derived viewport height (body minus a screen's own fixed rows). */
export function visibleRows(requested: number): number {
  return Math.max(1, Math.floor(requested));
}

/**
 * Truncate plain text to an exact display width with an end ellipsis. Widths
 * ≤ 0 or unknown dimensions return the text untouched (callers without a real
 * column count must not corrupt content they cannot measure).
 */
export function truncateToWidth(text: string, columns?: number): string {
  if (typeof columns !== "number" || !Number.isFinite(columns) || columns < 1) return text;
  if (text.length <= columns) return text;
  if (columns === 1) return text.slice(0, 1);
  return `${text.slice(0, columns - 1)}…`;
}

// Columns consumed by a selection row before its label: "❯ " + "◼ ".
const SELECTION_PREFIX = 4;
// Columns consumed between a label and its dim hint.
const SELECTION_SEPARATOR = 3; // " — "

/**
 * Fit one selection row (cursor + marker + label + optional " — hint") inside
 * the terminal width. The label wins: a hint only survives when at least one
 * column of it fits after the label, and a label that alone overflows drops
 * the hint entirely so the row always renders on exactly one line.
 */
export function fitSelectionItem(
  item: { label: string; hint?: string },
  maxWidth?: number,
): { label: string; hint?: string } {
  const usable = Math.max(
    1,
    positive(maxWidth, FALLBACK_TERMINAL_COLUMNS) - SELECTION_PREFIX,
  );
  if (item.hint === undefined) {
    return { label: truncateToWidth(item.label, usable) };
  }
  if (item.label.length > usable) {
    return { label: truncateToWidth(item.label, usable) };
  }
  const hintBudget = usable - item.label.length - SELECTION_SEPARATOR;
  if (hintBudget < 1) return { label: item.label };
  return {
    label: item.label,
    hint: truncateToWidth(item.hint, hintBudget),
  };
}
