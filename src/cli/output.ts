import type { RowStatus } from "../types.ts";

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const color = (code: string, value: string) =>
  COLOR ? `\x1b[${code}m${value}\x1b[0m` : value;

export const green = (value: string) => color("32", value);
export const red = (value: string) => color("31", value);
export const yellow = (value: string) => color("33", value);
export const dim = (value: string) => color("2", value);

const GLYPHS: Record<RowStatus, string> = {
  ok: green("✓"),
  synced: green("✓"),
  unchanged: green("="),
  skipped: dim("·"),
  drift: yellow("~"),
  missing: yellow("?"),
  invalid: red("✗"),
  failed: red("✗"),
  partial: yellow("~"),
  blocked: red("✗"),
};

export function row(status: RowStatus, label: string, path: string, message?: string) {
  const detail = path
    ? dim(path) + (message ? dim(` (${message})`) : "")
    : message
      ? dim(message)
      : "";
  console.log(`  ${GLYPHS[status]} ${label.padEnd(14)} ${detail}`);
}

export function exitIfFailed(writes: { status: RowStatus }[]) {
  const failed = writes.filter((write) => write.status === "failed");
  if (failed.length) {
    console.log(red(`\n${failed.length} adapter(s) failed.`));
    process.exit(1);
  }
}
