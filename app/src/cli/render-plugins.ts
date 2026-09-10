import { dim, green, red, row, yellow } from "./output.ts";
import {
  uninstallClaudePolicy,
  uninstallPreviewRows,
  uninstallResultRows,
  uninstallTargetLabel,
} from "./uninstall-presentation.ts";

export { neutralPluginText } from "./neutral-text.ts";
import { neutralPluginText } from "./neutral-text.ts";

export function printMirrorPreview(report: import("../plugins/mirror.ts").MirrorReport) {
  console.log(`Mirror plugins from ${green(report.from)} → every other agent (additive):`);
  for (const target of report.targets) {
    if (!target.diff) {
      if (target.unsupportedReason) {
        console.log(
          `  ${dim("·")} ${target.to.padEnd(14)} ${dim(neutralPluginText(target.unsupportedReason))}`,
        );
      }
      continue;
    }
    const unavailable = target.unavailable ?? [];
    const summaryParts = [
      target.diff.add.length ? `${green("+")}${target.diff.add.length}` : "",
      unavailable.length ? `${unavailable.length} unavailable` : "",
    ].filter(Boolean);
    const summary = summaryParts.length ? summaryParts.join(", ") : dim("unchanged");
    console.log(`  ${green("→")} ${target.to.padEnd(14)} ${summary}`);
    for (const plugin of target.diff.add) {
      console.log(
        `      ${green("+")} ${plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name}`,
      );
    }
    for (const { plugin, reason } of unavailable) {
      console.log(
        `      ${dim("·")} ${plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name} ${dim(`unavailable — ${neutralPluginText(reason)}`)}`,
      );
    }
  }
  printCursorPush(report.cursor);
  printSkillCohortPreview(report.skillCohort);
  printMcpCohortPreview(report.mcpCohort);
}

function printMcpCohortPreview(cohort: import("../plugins/mirror.ts").MirrorMcpCohort) {
  const label = "plugin wrapper→agents";
  if (!cohort.supported) {
    console.log(`  ${dim("·")} ${label.padEnd(20)} ${dim(neutralPluginText(cohort.reason))}`);
    return;
  }
  if (cohort.servers.length === 0) {
    const why = cohort.skipped.length
      ? `no portable wrapper items (${cohort.skipped.length} skipped)`
      : "no bundled wrapper items to surface";
    console.log(`  ${dim("·")} ${label.padEnd(20)} ${dim(why)}`);
    return;
  }
  console.log(
    `  ${green("→")} ${label.padEnd(20)} ${green("+")}${cohort.servers.length} bundled wrapper item(s) → ${cohort.agents.length} agents`,
  );
  for (const server of cohort.servers) {
    console.log(`      ${green("+")} ${server.name} ${dim(`(from ${server.plugin})`)}`);
  }
  for (const skipped of cohort.skipped) {
    console.log(`      ${dim("·")} ${dim(`${skipped.name} skipped — ${neutralPluginText(skipped.reason)}`)}`);
  }
}

function printSkillCohortPreview(cohort: import("../plugins/mirror.ts").MirrorSkillCohort) {
  const label = "plugin reach→agents";
  if (!cohort.supported) {
    console.log(`  ${dim("·")} ${label.padEnd(20)} ${dim(neutralPluginText(cohort.reason))}`);
    return;
  }
  const count = cohort.report?.sources.length ?? 0;
  if (count === 0) {
    console.log(`  ${dim("·")} ${label.padEnd(20)} ${dim("no plugin content to surface")}`);
    return;
  }
  console.log(
    `  ${green("→")} ${label.padEnd(20)} ${green("+")}${count} source(s) → ${cohort.agents.length} agents`,
  );
}

function printCursorPush(cursor: import("../plugins/mirror.ts").CursorPush) {
  if (!cursor.supported) {
    console.log(`  ${dim("·")} ${"cursor".padEnd(14)} ${dim(neutralPluginText(cursor.reason))}`);
    return;
  }
  if (cursor.repos.length === 0) {
    console.log(`  ${dim("·")} ${"cursor".padEnd(14)} ${dim("no plugin sources to push")}`);
    return;
  }
  console.log(
    `  ${green("→")} ${"cursor".padEnd(14)} ${green("+")}${cursor.repos.length} ${dim("via plugin wrapper; additive")}`,
  );
  for (const repo of cursor.repos) console.log(`      ${green("+")} ${repo}`);
}

export function printMirrorApplied(
  report: import("../plugins/mirror.ts").MirrorReport,
  provision: boolean,
) {
  let installed = 0;
  let covered = 0;
  let skipped = 0;
  let failed = 0;
  let sawUnresolvedSkip = false;
  for (const target of report.targets) {
    for (const { plugin, reason } of target.unavailable ?? []) {
      skipped += 1;
      row(
        "skipped",
        target.to,
        plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name,
        neutralPluginText(reason),
      );
    }
    for (const install of target.installs ?? []) {
      if (install.status === "failed") {
        failed += 1;
        row(
          "failed",
          target.to,
          install.target,
          neutralPluginText(install.message, "plugin install failed"),
        );
      } else if (install.status === "skipped") {
        if (install.skillsFallbackRepo) continue;
        if (install.coveredBy) {
          covered += 1;
          row(
            "synced",
            target.to,
            install.target,
            neutralPluginText(install.message ?? `covered by ${install.coveredBy}`),
          );
        } else {
          skipped += 1;
          sawUnresolvedSkip = true;
          row(
            "skipped",
            target.to,
            install.target,
            neutralPluginText(install.message, "not available"),
          );
        }
      } else if (install.status === "installed") {
        installed += 1;
        row("synced", target.to, install.target, "installed");
      }
    }
    for (const fallback of target.skillsFallback ?? []) {
      if (fallback.status === "failed") {
        failed += 1;
        row(
          "failed",
          target.to,
          fallback.repo,
          `plugin reach fallback: ${neutralPluginText(fallback.message, "failed")}`,
        );
      } else if (fallback.status === "added") {
        installed += 1;
        row("synced", target.to, fallback.repo, "extended reach through the plugin wrapper");
      } else {
        skipped += 1;
        row(
          "skipped",
          target.to,
          fallback.repo,
          neutralPluginText(fallback.message, "no plugin content in bundle"),
        );
      }
    }
  }

  if (report.cursor.supported) {
    for (const result of report.cursor.results) {
      if (result.status === "failed") {
        failed += 1;
        row(
          "failed",
          "cursor",
          result.repo,
          neutralPluginText(result.message, "plugin push failed"),
        );
      } else {
        installed += 1;
        row("synced", "cursor", result.repo, "installed through the plugin wrapper");
      }
    }
  } else if (report.cursor.reason) {
    skipped += 1;
    row("skipped", "cursor", "", neutralPluginText(report.cursor.reason));
  }

  if (!report.skillCohort.supported) {
    if (report.skillCohort.reason) {
      skipped += 1;
      row("skipped", "plugin-reach", "", neutralPluginText(report.skillCohort.reason));
    }
  } else {
    for (const result of report.skillCohort.report?.results ?? []) {
      if (result.status === "failed") {
        failed += 1;
        row(
          "failed",
          "plugin-reach",
          result.repo,
          neutralPluginText(result.message, "plugin reach failed"),
        );
      } else if (result.status === "added") {
        installed += 1;
        row(
          "synced",
          "plugin-reach",
          result.repo,
          `added to ${report.skillCohort.agents.length} agents`,
        );
      }
    }
  }

  if (!report.mcpCohort.supported) {
    if (report.mcpCohort.reason) {
      skipped += 1;
      row("skipped", "plugin-wrapper", "", neutralPluginText(report.mcpCohort.reason));
    }
  } else {
    for (const result of report.mcpCohort.results ?? []) {
      if (result.status === "failed") {
        failed += 1;
        row(
          "failed",
          result.agent,
          "",
          `plugin wrapper: ${neutralPluginText(result.message, "failed")}`,
        );
      } else if (result.added.length) {
        installed += result.added.length;
        row(
          "synced",
          result.agent,
          "",
          `+${result.added.length} bundled wrapper item(s): ${result.added.join(", ")}`,
        );
      }
      if (result.conflicts.length) {
        row(
          "drift",
          result.agent,
          "",
          `${result.conflicts.length} conflict(s) left untouched: ${result.conflicts.join(", ")}`,
        );
      }
    }
  }

  const parts = [
    installed ? green(`${installed} added`) : "",
    covered ? dim(`${covered} already covered`) : "",
    skipped ? dim(`${skipped} skipped`) : "",
    failed ? red(`${failed} failed`) : "",
  ].filter(Boolean);
  if (parts.length) console.log(`\n${parts.join(dim(" · "))}`);
  if (!provision && sawUnresolvedSkip) {
    console.log(
      dim(
        "tip: some plugins were not resolvable on a target; re-run without --no-provision to register target marketplaces.",
      ),
    );
  }
  if (failed > 0) process.exit(1);
}

export function printPluginAdd(
  report: import("../plugins/add.ts").PluginAddReport,
  preview: boolean,
): number {
  const targets = report.requestedAgents.filter((agent) => agent !== report.source);
  console.log(
    `${preview ? "Add" : "Added"} ${report.plugins.map((plugin) => green(plugin)).join(", ")} → ${targets.join(", ") || dim("(no targets)")} ${dim(`(source: ${report.source})`)}`,
  );
  for (const name of report.notFound) {
    row("missing", report.source, name, "not installed on the source");
  }
  let failed = 0;
  for (const install of report.installs) {
    if (install.status === "failed") {
      failed += 1;
      row(
        "failed",
        install.agent,
        install.target,
        neutralPluginText(install.message, "plugin install failed"),
      );
    } else if (install.status === "present") {
      row("synced", install.agent, install.target, "already present");
    } else if (install.status === "installed") {
      row("synced", install.agent, install.target, preview ? "would install" : "installed");
    } else if (install.status === "skipped" && !install.skillsFallbackRepo) {
      row(
        "skipped",
        install.agent,
        install.target,
        neutralPluginText(install.message, "not available"),
      );
    }
  }
  if (report.cursor) {
    for (const result of report.cursor.results) {
      if (result.status === "failed") {
        failed += 1;
        row(
          "failed",
          "cursor",
          result.repo,
          neutralPluginText(result.message, "plugin push failed"),
        );
      } else {
        row("synced", "cursor", result.repo, "installed through the plugin wrapper");
      }
    }
    if (preview) {
      for (const repo of report.cursor.repos) {
        row("synced", "cursor", repo, "would push through the plugin wrapper");
      }
    }
  }
  for (const content of report.skills) {
    if (content.status === "failed") {
      failed += 1;
      row(
        "failed",
        "plugin-reach",
        content.repo,
        neutralPluginText(content.message, "plugin reach failed"),
      );
    } else {
      row(
        "synced",
        "plugin-reach",
        content.repo,
        preview
          ? "would extend reach"
          : content.status === "skipped"
            ? neutralPluginText(content.message, "no plugin content")
            : "extended reach",
      );
    }
  }
  for (const wrapper of report.mcp) {
    if (wrapper.status === "failed") {
      failed += 1;
      row(
        "failed",
        wrapper.agent,
        "",
        `plugin wrapper: ${neutralPluginText(wrapper.message, "failed")}`,
      );
    } else if (wrapper.added.length) {
      row(
        "synced",
        wrapper.agent,
        "",
        `${preview ? "would add " : "+"}${wrapper.added.length} bundled wrapper item(s): ${wrapper.added.join(", ")}`,
      );
    }
    if (wrapper.conflicts.length) {
      row(
        "drift",
        wrapper.agent,
        "",
        `${wrapper.conflicts.length} conflict(s) left untouched: ${wrapper.conflicts.join(", ")}`,
      );
    }
  }
  return failed;
}

export async function printPluginOverview(
  overview: import("../plugins/overview.ts").PluginOverview,
) {
  const { renderPluginOverview } = await import("../plugins/overview.ts");
  console.log("Plugins across your agents:\n");
  for (const line of renderPluginOverview(overview)) console.log(`  ${line}`);
}

// CLI adapter for the canonical uninstall preview rows. The row policy lives in
// uninstall-presentation.ts; only color and layout dialect live here.
export function printUninstallPreview(
  report: import("../plugins/uninstall.ts").UninstallReport,
) {
  console.log(`Uninstall ${report.plugins.map((plugin) => green(plugin)).join(", ")}:`);
  const rowOf = row;
  for (const row of uninstallPreviewRows(report)) {
    switch (row.kind) {
      case "scope":
        break;
      case "native-remove": {
        const name = uninstallTargetLabel(row.plugin, row.marketplace);
        console.log(`  ${red("-")} ${row.agent.padEnd(14)} ${name} ${dim("(native plugin)")}`);
        break;
      }
      case "native-absent": {
        const name = uninstallTargetLabel(row.plugin, row.marketplace);
        console.log(`  ${dim("·")} ${row.agent.padEnd(14)} ${dim(`${name} not installed`)}`);
        break;
      }
      case "native-blocked":
        rowOf("invalid", row.agent, "", neutralPluginText(row.reason, "cannot read plugins"));
        break;
      case "skills-remove":
        console.log(
          `  ${red("-")} ${"plugin-reach".padEnd(14)} ${red(`${row.names.length}`)} bundled item(s) from ${row.agents.length} agent(s)`,
        );
        console.log(`      ${dim(`names:  ${row.names.join(", ")}`)}`);
        console.log(`      ${dim(`agents: ${row.agents.join(", ")}`)}`);
        break;
      case "skills-out-of-scope":
        console.log(
          `  ${dim("·")} ${"plugin-reach".padEnd(14)} ${dim("bundled content exists, but none of the scoped agents hold it")}`,
        );
        break;
      case "skills-kept":
        console.log(
          dim(`  kept (still provided by another installed plugin): ${row.names.join(", ")}`),
        );
        break;
      case "mcp-blocked":
        rowOf("invalid", row.agent, "", `plugin wrapper: can't read target: ${neutralPluginText(row.reason)}`);
        break;
      case "mcp-remove": {
        const count = row.names.length;
        console.log(
          `  ${red("-")} ${row.agent.padEnd(14)} ${red(`${count}`)} bundled wrapper item(s): ${row.names.join(", ")}`,
        );
        break;
      }
      case "mcp-kept":
        console.log(
          dim(`  kept wrapper items (still provided by another installed plugin): ${row.names.join(", ")}`),
        );
        break;
      case "mcp-conflict":
        rowOf("drift", row.agent, "", `wrapper conflict(s) left untouched: ${row.names.join(", ")}`);
        break;
      case "unsupported":
        console.log(
          `  ${dim("·")} ${row.agent.padEnd(14)} ${dim("can't uninstall here (write-only plugin target)")}`,
        );
        break;
      case "ownership-blocked":
        // The hard ownership block is rendered by the caller as a loud failure;
        // the preview keeps the softer yellow note below.
        break;
    }
  }
  const ownership = uninstallClaudePolicy(report);
  if (ownership.unreadable && report.skillScope.length) {
    console.log(
      yellow(
        `  ! couldn't read Claude's plugins (${neutralPluginText(report.claudeReadError)}) — bundled content on ${report.skillScope.join(", ")} was left in place`,
      ),
    );
  }
}

// CLI adapter for the canonical uninstall result rows. Counting and color live
// here; classification lives in uninstall-presentation.ts.
export function printUninstallApplied(
  report: import("../plugins/uninstall.ts").UninstallReport,
): number {
  const rowOf = row;
  let removed = 0;
  let absent = 0;
  let skipped = 0;
  let failed = 0;
  const skillRemovedRows: Array<{ agent: string; names: string[] }> = [];
  const skillRemainingRows: Array<{ agent: string; names: string[] }> = [];
  for (const row of uninstallResultRows(report)) {
    switch (row.kind) {
      case "native-removed":
        removed += 1;
        rowOf("synced", row.agent, row.target, "uninstalled");
        break;
      case "native-absent":
        absent += 1;
        break;
      case "native-partial":
        skipped += 1;
        rowOf("skipped", row.agent, row.target, neutralPluginText(row.reason, "skipped"));
        break;
      case "native-blocked":
        failed += 1;
        rowOf("failed", row.agent, row.target, neutralPluginText(row.reason, "plugin uninstall failed"));
        break;
      case "skill-item-removed":
        skillRemovedRows.push(row);
        break;
      case "skill-item-remaining":
        skillRemainingRows.push(row);
        break;
      case "skill-status": {
        const removedItems = skillRemovedRows.reduce((count, target) => count + target.names.length, 0);
        const removedAgents = skillRemovedRows.length;
        const remainingTargets = skillRemainingRows.map(
          (target) => `${target.agent}: ${target.names.join(", ")}`,
        );
        if (row.status === "removed") {
          removed += removedItems;
          rowOf("synced", "plugin-reach", "", `removed ${removedItems} bundled item(s) from ${removedAgents} agent(s)`);
        } else if (row.status === "partial") {
          removed += removedItems;
          failed += 1;
          rowOf("partial", "plugin-reach", "", `partial removal: ${removedItems} item(s) removed; remaining — ${remainingTargets.join("; ") || "fresh verification unavailable"}`);
        } else if (row.status === "blocked") {
          failed += 1;
          rowOf("blocked", "plugin-reach", "", neutralPluginText(row.message, "plugin reach removal was blocked by verification"));
        } else if (row.status === "skipped") {
          skipped += 1;
          rowOf("skipped", "plugin-reach", "", neutralPluginText(row.message, "skipped"));
        } else {
          failed += 1;
          rowOf("blocked", "plugin-reach", "", neutralPluginText(row.message, "plugin reach removal failed"));
        }
        break;
      }
      case "mcp-removed":
        removed += row.names.length;
        rowOf("synced", row.agent, "", `removed ${row.names.length} bundled wrapper item(s): ${row.names.join(", ")}`);
        break;
      case "mcp-blocked":
        failed += 1;
        rowOf("failed", row.agent, "", `plugin wrapper: ${neutralPluginText(row.reason, "failed")}`);
        break;
      case "mcp-skipped":
        skipped += 1;
        rowOf("skipped", row.agent, "", `plugin wrapper: ${neutralPluginText(row.reason, "skipped")}`);
        break;
      case "mcp-note":
        rowOf("unchanged", row.agent, "", `plugin wrapper: ${neutralPluginText(row.message)}`);
        break;
      case "mcp-conflict":
        rowOf("drift", row.agent, "", `wrapper conflict(s) left untouched: ${row.names.join(", ")}`);
        break;
      case "unsupported":
        break;
      case "ownership-blocked":
        // Surfaced loudly by the bin caller via the shared Claude policy.
        break;
    }
  }
  const parts = [
    removed ? green(`${removed} removed`) : "",
    absent ? dim(`${absent} absent`) : "",
    skipped ? dim(`${skipped} skipped`) : "",
    failed ? red(`${failed} failed`) : "",
  ].filter(Boolean);
  if (parts.length) console.log(`\n${parts.join(dim(" · "))}`);
  return failed;
}
