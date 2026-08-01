import { dim, green, red, row, yellow } from "./output.ts";

export function printDirectionalDiff(r: import("../sync.ts").DirectionalReport) {
  console.log(`Mirror MCP servers from ${green(r.from)} → ${green(r.to)}:`);
  if (r.diff.add.length) {
    console.log(`  ${green("+")} add ${r.diff.add.length}:        ${r.diff.add.join(", ")}`);
  }
  if (r.diff.overwrite.length) {
    console.log(
      `  ${yellow("~")} overwrite ${r.diff.overwrite.length}:  ${r.diff.overwrite.join(", ")}`,
    );
  }
  if (r.diff.remove.length) {
    console.log(`  ${red("-")} remove ${r.diff.remove.length}:     ${r.diff.remove.join(", ")}`);
  }
}

export function printFanOut(r: import("../sync.ts").FanOutReport) {
  console.log(`Mirror MCP servers from ${green(r.from)} → ${green("all other agents")}:`);
  for (const target of r.targets) {
    if (target.toRead.error) {
      console.log(`  ${red("✗")} ${target.to.padEnd(14)} ${dim(target.toRead.error)}`);
      continue;
    }
    const parts = [
      target.diff.add.length ? `${green("+")}${target.diff.add.length}` : "",
      target.diff.overwrite.length ? `${yellow("~")}${target.diff.overwrite.length}` : "",
      target.diff.remove.length ? `${red("-")}${target.diff.remove.length}` : "",
    ].filter(Boolean);
    console.log(
      `  ${parts.length ? yellow("~") : green("=")} ${target.to.padEnd(14)} ${parts.join(" ") || dim("unchanged")}`,
    );
  }
}

export function printFanOutWrites(r: import("../sync.ts").FanOutReport) {
  for (const target of r.targets) {
    if (target.write) {
      row(target.write.status, target.to, target.write.path, target.write.message);
    }
  }
}

export function fanOutHasChanges(r: import("../sync.ts").FanOutReport): boolean {
  return r.targets.some(
    (target) =>
      target.toRead.error ||
      target.diff.add.length > 0 ||
      target.diff.overwrite.length > 0 ||
      target.diff.remove.length > 0,
  );
}

export function printRemove(r: import("../sync.ts").RemoveReport) {
  console.log(`Remove MCP server ${green(r.name)} from ${r.writes.length} agent(s):`);
  for (const write of r.writes) row(write.status, write.agent, write.path, write.message);
}
