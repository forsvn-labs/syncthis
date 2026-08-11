import { dim, green, red, row, yellow } from "./output.ts";

export function neutralPluginText(value: unknown, fallback = "plugin reach unavailable"): string {
  return String(value ?? fallback)
    .replace(/\bnpx\b/gi, "plugin wrapper")
    .replace(/\bskills?\b/gi, "plugin content")
    .replace(/\bmcp\b/gi, "plugin wrapper");
}

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

export function printPluginOverview(
  overview: import("../plugins/overview.ts").PluginOverview,
) {
  console.log("Plugins across your agents:\n");
  for (const result of overview.native) {
    if (result.error) {
      row("invalid", result.agent, result.configPath, neutralPluginText(result.error));
      continue;
    }
    if (!result.exists) {
      row("missing", result.agent, result.configPath, "no config");
      continue;
    }
    row("ok", result.agent, result.configPath, `${result.plugins.length} plugin(s)`);
    for (const plugin of result.plugins) {
      const marketplace = plugin.marketplace ? dim(`@${plugin.marketplace}`) : "";
      const version = plugin.version ? dim(` v${plugin.version}`) : "";
      const enabled = plugin.enabled === false ? yellow(" (disabled)") : "";
      console.log(`      ${dim("·")} ${plugin.name}${marketplace}${version}${enabled}`);
    }
  }
  row(
    "missing",
    "cursor",
    "~/.cursor",
    "write-only plugin target — state isn't readable",
  );
}

export function printUninstallPreview(
  report: import("../plugins/uninstall.ts").UninstallReport,
) {
  console.log(`Uninstall ${report.plugins.map((plugin) => green(plugin)).join(", ")}:`);
  for (const target of report.native) {
    const name = target.marketplace
      ? `${target.plugin}@${target.marketplace}`
      : target.plugin;
    if (target.unreadable) {
      row(
        "invalid",
        target.agent,
        "",
        `can't read plugins: ${neutralPluginText(target.unreadable)}`,
      );
    } else if (target.present) {
      console.log(`  ${red("-")} ${target.agent.padEnd(14)} ${name} ${dim("(native plugin)")}`);
    } else {
      console.log(`  ${dim("·")} ${target.agent.padEnd(14)} ${dim(`${name} not installed`)}`);
    }
  }
  if (report.skills.names.length && report.skills.agents.length) {
    console.log(
      `  ${red("-")} ${"plugin-reach".padEnd(14)} ${red(`${report.skills.names.length}`)} bundled item(s) from ${report.skills.agents.length} agent(s)`,
    );
    console.log(`      ${dim(`names:  ${report.skills.names.join(", ")}`)}`);
    console.log(`      ${dim(`agents: ${report.skills.agents.join(", ")}`)}`);
  } else if (report.skills.names.length) {
    console.log(
      `  ${dim("·")} ${"plugin-reach".padEnd(14)} ${dim("bundled content exists, but none of the scoped agents hold it")}`,
    );
  }
  if (report.skills.kept.length) {
    console.log(
      dim(`  kept (still provided by another installed plugin): ${report.skills.kept.join(", ")}`),
    );
  }
  for (const target of report.mcp) {
    if (target.unreadable) {
      row(
        "invalid",
        target.agent,
        "",
        `plugin wrapper: can't read target: ${neutralPluginText(target.unreadable)}`,
      );
    } else if (target.names.length) {
      const count = target.names.length;
      console.log(
        `  ${red("-")} ${target.agent.padEnd(14)} ${red(`${count}`)} bundled wrapper item(s): ${target.names.join(", ")}`,
      );
    }
    if (target.kept.length) {
      console.log(
        dim(`  kept wrapper items (still provided by another installed plugin): ${target.kept.join(", ")}`),
      );
    }
    if (target.conflicts.length) {
      row(
        "drift",
        target.agent,
        "",
        `wrapper conflict(s) left untouched: ${target.conflicts.join(", ")}`,
      );
    }
  }
  for (const agent of report.unsupportedAgents) {
    console.log(
      `  ${dim("·")} ${agent.padEnd(14)} ${dim("can't uninstall here (write-only plugin target)")}`,
    );
  }
  if (report.claudeReadError && report.skillScope.length) {
    console.log(
      yellow(
        `  ! couldn't read Claude's plugins (${neutralPluginText(report.claudeReadError)}) — bundled content on ${report.skillScope.join(", ")} was left in place`,
      ),
    );
  }
}

export function printUninstallApplied(
  report: import("../plugins/uninstall.ts").UninstallReport,
): number {
  let removed = 0;
  let absent = 0;
  let skipped = 0;
  let failed = 0;
  for (const result of report.nativeResults ?? []) {
    if (result.status === "uninstalled") {
      removed += 1;
      row("synced", result.agent, result.target, "uninstalled");
    } else if (result.status === "absent") {
      absent += 1;
    } else if (result.status === "skipped") {
      skipped += 1;
      row(
        "skipped",
        result.agent,
        result.target,
        neutralPluginText(result.message, "skipped"),
      );
    } else {
      failed += 1;
      row(
        "failed",
        result.agent,
        result.target,
        neutralPluginText(result.message, "plugin uninstall failed"),
      );
    }
  }
  if (report.skillResult) {
    const result = report.skillResult;
    const removedItems = result.results.reduce((count, target) => count + target.removed.length, 0);
    const removedAgents = result.results.filter((target) => target.removed.length > 0).length;
    const remainingTargets = result.results
      .filter((target) => target.remaining.length > 0)
      .map((target) => `${target.agent}: ${target.remaining.join(", ")}`);
    if (result.status === "removed") {
      removed += removedItems;
      row(
        "synced",
        "plugin-reach",
        "",
        `removed ${removedItems} bundled item(s) from ${removedAgents} agent(s)`,
      );
    } else if (result.status === "partial") {
      removed += removedItems;
      failed += 1;
      row(
        "partial",
        "plugin-reach",
        "",
        `partial removal: ${removedItems} item(s) removed; remaining — ${remainingTargets.join("; ") || "fresh verification unavailable"}`,
      );
    } else if (result.status === "blocked") {
      failed += 1;
      row(
        "blocked",
        "plugin-reach",
        "",
        neutralPluginText(result.message, "plugin reach removal was blocked by verification"),
      );
    } else if (result.status === "skipped") {
      skipped += 1;
      row("skipped", "plugin-reach", "", neutralPluginText(result.message, "skipped"));
    } else {
      failed += 1;
      row(
        "blocked",
        "plugin-reach",
        "",
        neutralPluginText(result.message, "plugin reach removal failed"),
      );
    }
  }
  for (const result of report.mcpResults ?? []) {
    if (result.status === "failed") {
      failed += 1;
      row(
        "failed",
        result.agent,
        "",
        `plugin wrapper: ${neutralPluginText(result.message, "failed")}`,
      );
    } else if (result.status === "synced") {
      removed += result.removed.length;
      row(
        "synced",
        result.agent,
        "",
        `removed ${result.removed.length} bundled wrapper item(s): ${result.removed.join(", ")}`,
      );
    } else if (result.status === "skipped") {
      skipped += 1;
      row(
        "skipped",
        result.agent,
        "",
        `plugin wrapper: ${neutralPluginText(result.message, "skipped")}`,
      );
    } else if (result.message) {
      row(
        "unchanged",
        result.agent,
        "",
        `plugin wrapper: ${neutralPluginText(result.message)}`,
      );
    }
    if (result.conflicts.length) {
      row(
        "drift",
        result.agent,
        "",
        `wrapper conflict(s) left untouched: ${result.conflicts.join(", ")}`,
      );
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
