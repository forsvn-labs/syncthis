import { dim, green, red, row, yellow } from "./output.ts";

export function printMirrorPreview(report: import("../plugins/mirror.ts").MirrorReport) {
  console.log(`Mirror plugins from ${green(report.from)} → every other agent (additive):`);
  for (const target of report.targets) {
    if (!target.diff) {
      if (target.unsupportedReason) {
        console.log(`  ${dim("·")} ${target.to.padEnd(14)} ${dim(target.unsupportedReason)}`);
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
        `      ${dim("·")} ${plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name} ${dim(`unavailable — ${reason}`)}`,
      );
    }
  }
  printCursorPush(report.cursor);
  printSkillCohortPreview(report.skillCohort);
  printMcpCohortPreview(report.mcpCohort);
}

function printMcpCohortPreview(cohort: import("../plugins/mirror.ts").MirrorMcpCohort) {
  const label = "mcp→agents";
  if (!cohort.supported) {
    console.log(`  ${dim("·")} ${label.padEnd(14)} ${dim(cohort.reason ?? "unsupported")}`);
    return;
  }
  if (cohort.servers.length === 0) {
    const why = cohort.skipped.length
      ? `no portable MCP servers (${cohort.skipped.length} skipped)`
      : "no plugin-bundled MCP servers to surface";
    console.log(`  ${dim("·")} ${label.padEnd(14)} ${dim(why)}`);
    return;
  }
  console.log(
    `  ${green("→")} ${label.padEnd(14)} ${green("+")}${cohort.servers.length} ${dim(`server(s) → ${cohort.agents.length} non-plugin agents (lifted from plugins; additive, conflicts left untouched)`)}`,
  );
  for (const server of cohort.servers) {
    console.log(`      ${green("+")} ${server.name} ${dim(`(from ${server.plugin})`)}`);
  }
  for (const skipped of cohort.skipped) {
    console.log(`      ${dim("·")} ${dim(`${skipped.name} skipped — ${skipped.reason}`)}`);
  }
}

function printSkillCohortPreview(cohort: import("../plugins/mirror.ts").MirrorSkillCohort) {
  const label = "skills→agents";
  if (!cohort.supported) {
    console.log(`  ${dim("·")} ${label.padEnd(14)} ${dim(cohort.reason ?? "unsupported")}`);
    return;
  }
  const count = cohort.report?.sources.length ?? 0;
  if (count === 0) {
    console.log(`  ${dim("·")} ${label.padEnd(14)} ${dim("no skill-bearing plugins to surface")}`);
    return;
  }
  console.log(
    `  ${green("→")} ${label.padEnd(14)} ${green("+")}${count} ${dim(`repo(s) → ${cohort.agents.length} non-plugin agents (npx skills; additive, already-synced skipped)`)}`,
  );
}

function printCursorPush(cursor: import("../plugins/mirror.ts").CursorPush) {
  if (!cursor.supported) {
    console.log(`  ${dim("·")} ${"cursor".padEnd(14)} ${dim(cursor.reason ?? "unsupported")}`);
    return;
  }
  if (cursor.repos.length === 0) {
    console.log(
      `  ${dim("·")} ${"cursor".padEnd(14)} ${dim("no github-backed plugins to push")}`,
    );
    return;
  }
  console.log(
    `  ${green("→")} ${"cursor".padEnd(14)} ${green("+")}${cursor.repos.length} ${dim("(via npx plugins; additive — cursor state not readable)")}`,
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
        reason,
      );
    }
    for (const install of target.installs ?? []) {
      if (install.status === "failed") {
        failed += 1;
        row("failed", target.to, install.target, install.message);
      } else if (install.status === "skipped") {
        if (install.skillsFallbackRepo) continue;
        if (install.coveredBy) {
          covered += 1;
          row(
            "synced",
            target.to,
            install.target,
            install.message ?? `covered by ${install.coveredBy}`,
          );
        } else {
          skipped += 1;
          sawUnresolvedSkip = true;
          row("skipped", target.to, install.target, install.message);
        }
      } else if (install.status === "installed") {
        installed += 1;
        row("synced", target.to, install.target, "installed");
      }
    }
    for (const fallback of target.skillsFallback ?? []) {
      if (fallback.status === "failed") {
        failed += 1;
        row("failed", target.to, fallback.repo, `skills fallback: ${fallback.message ?? "failed"}`);
      } else if (fallback.status === "added") {
        installed += 1;
        row(
          "synced",
          target.to,
          fallback.repo,
          "added as skills (npx skills — not loadable as a plugin here)",
        );
      } else {
        skipped += 1;
        row("skipped", target.to, fallback.repo, fallback.message ?? "no skills in bundle");
      }
    }
  }
  if (report.cursor.supported) {
    for (const result of report.cursor.results) {
      if (result.status === "failed") {
        failed += 1;
        row("failed", "cursor", result.repo, result.message);
      } else {
        installed += 1;
        row("synced", "cursor", result.repo, "installed (npx plugins)");
      }
    }
  } else if (report.cursor.reason) {
    skipped += 1;
    row("skipped", "cursor", "", report.cursor.reason);
  }
  if (!report.skillCohort.supported) {
    if (report.skillCohort.reason) {
      skipped += 1;
      row("skipped", "skills→agents", "", report.skillCohort.reason);
    }
  } else {
    for (const result of report.skillCohort.report?.results ?? []) {
      if (result.status === "failed") {
        failed += 1;
        row("failed", "skills→agents", result.repo, result.message);
      } else if (result.status === "added") {
        installed += 1;
        row(
          "synced",
          "skills→agents",
          result.repo,
          `added to ${report.skillCohort.agents.length} non-plugin agents`,
        );
      }
    }
  }
  if (!report.mcpCohort.supported) {
    if (report.mcpCohort.reason) {
      skipped += 1;
      row("skipped", "mcp→agents", "", report.mcpCohort.reason);
    }
  } else {
    for (const result of report.mcpCohort.results ?? []) {
      if (result.status === "failed") {
        failed += 1;
        row("failed", result.agent, "", `mcp: ${result.message ?? "failed"}`);
      } else if (result.added.length) {
        installed += result.added.length;
        row("synced", result.agent, "", `+${result.added.length} mcp: ${result.added.join(", ")}`);
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
        "tip: skipped plugins had no marketplace Codex could resolve — re-run without --no-provision to register their marketplaces and add unloadable bundles as skills.",
      ),
    );
  }
  if (failed > 0) process.exit(1);
}

export function printPluginAdd(
  report: import("../plugins/add.ts").PluginAddReport,
  preview: boolean,
): number {
  const targets = report.requestedAgents.filter((agent) => agent !== "claude-code");
  console.log(
    `${preview ? "Add" : "Added"} ${report.plugins.map((plugin) => green(plugin)).join(", ")} → ${targets.join(", ") || dim("(no targets)")} ${dim("(source: claude-code)")}`,
  );
  for (const name of report.notFound) {
    row("missing", "claude-code", name, "not installed on the source");
  }
  let failed = 0;
  for (const install of report.installs) {
    if (install.status === "failed") {
      failed += 1;
      row("failed", install.agent, install.target, install.message);
    } else if (install.status === "present") {
      row("synced", install.agent, install.target, "already present");
    } else if (install.status === "installed") {
      row("synced", install.agent, install.target, preview ? "would install" : "installed");
    } else if (install.status === "skipped" && !install.skillsFallbackRepo) {
      row("skipped", install.agent, install.target, install.message);
    }
  }
  if (report.cursor) {
    for (const result of report.cursor.results) {
      if (result.status === "failed") {
        failed += 1;
        row("failed", "cursor", result.repo, result.message);
      } else {
        row("synced", "cursor", result.repo, "installed (npx plugins)");
      }
    }
    if (preview) {
      for (const repo of report.cursor.repos) row("synced", "cursor", repo, "would push");
    }
  }
  for (const skill of report.skills) {
    if (skill.status === "failed") {
      failed += 1;
      row("failed", "skills", skill.repo, skill.message);
    } else {
      row(
        "synced",
        "skills",
        skill.repo,
        preview ? "would add" : skill.status === "skipped" ? (skill.message ?? "no skills") : "added",
      );
    }
  }
  for (const mcp of report.mcp) {
    if (mcp.status === "failed") {
      failed += 1;
      row("failed", mcp.agent, "", `mcp: ${mcp.message ?? "failed"}`);
    } else if (mcp.added.length) {
      row(
        "synced",
        mcp.agent,
        "",
        `${preview ? "would add " : "+"}${mcp.added.length} mcp: ${mcp.added.join(", ")}`,
      );
    }
    if (mcp.conflicts.length) {
      row(
        "drift",
        mcp.agent,
        "",
        `${mcp.conflicts.length} mcp conflict(s) left untouched: ${mcp.conflicts.join(", ")}`,
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
      row("invalid", result.agent, result.configPath, result.error);
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
    "write-only plugin target — Cursor's plugin state isn't readable",
  );

  console.log(dim("\nplugin-derived skills (on agents that can't load plugins natively):"));
  if (!overview.skillsReadable) {
    console.log(dim("  couldn't read `npx skills list` — derived-skill view unavailable"));
    return;
  }
  if (overview.derivedRepos.length === 0) {
    console.log(
      dim(
        "  none surfaced yet — use `syncthis` → Manage plugins → Sync plugins, or `syncthis mirror claude-code` for batch all",
      ),
    );
    return;
  }
  console.log(dim(`  source repos: ${overview.derivedRepos.join(", ")}`));
  const union = new Set<string>();
  for (const derived of overview.derived) {
    for (const skill of derived.skills) union.add(skill.name);
  }
  if (union.size) console.log(dim(`  skills: ${[...union].sort().join(", ")}`));
  for (const derived of overview.derived) {
    const glyph = derived.skills.length ? green("✓") : dim("·");
    console.log(`  ${glyph} ${derived.agent.padEnd(14)} ${derived.skills.length} skill(s)`);
  }
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
      row("invalid", target.agent, "", `can't read plugins: ${target.unreadable}`);
    } else if (target.present) {
      console.log(`  ${red("-")} ${target.agent.padEnd(14)} ${name} ${dim("(native plugin)")}`);
    } else {
      console.log(`  ${dim("·")} ${target.agent.padEnd(14)} ${dim(`${name} not installed`)}`);
    }
  }
  if (report.skills.names.length && report.skills.agents.length) {
    console.log(
      `  ${red("-")} ${"skills".padEnd(14)} ${red(`${report.skills.names.length}`)} skill(s) from ${report.skills.agents.length} non-plugin agent(s)`,
    );
    console.log(`      ${dim(`names:  ${report.skills.names.join(", ")}`)}`);
    console.log(`      ${dim(`agents: ${report.skills.agents.join(", ")}`)}`);
  } else if (report.skills.names.length) {
    console.log(
      `  ${dim("·")} ${"skills".padEnd(14)} ${dim("derived skills exist, but none of the scoped agents hold them")}`,
    );
  }
  if (report.skills.kept.length) {
    console.log(
      dim(`  kept (still provided by another installed plugin): ${report.skills.kept.join(", ")}`),
    );
  }
  for (const target of report.mcp) {
    if (target.unreadable) {
      row("invalid", target.agent, "", `mcp: can't read target: ${target.unreadable}`);
    } else if (target.names.length) {
      const count = target.names.length;
      console.log(
        `  ${red("-")} ${target.agent.padEnd(14)} ${red(`${count}`)} MCP server${count === 1 ? "" : "s"}: ${target.names.join(", ")}`,
      );
    }
    if (target.kept.length) {
      console.log(
        dim(`  kept MCP (still provided by another installed plugin): ${target.kept.join(", ")}`),
      );
    }
    if (target.conflicts.length) {
      row(
        "drift",
        target.agent,
        "",
        `MCP conflict(s) left untouched: ${target.conflicts.join(", ")}`,
      );
    }
  }
  for (const agent of report.unsupportedAgents) {
    console.log(
      `  ${dim("·")} ${agent.padEnd(14)} ${dim("can't uninstall here (write-only plugin target, no list/uninstall CLI)")}`,
    );
  }
  if (report.claudeReadError && report.skillScope.length) {
    console.log(
      yellow(
        `  ! couldn't read Claude's plugins (${report.claudeReadError}) — can't resolve which surfaced skills to remove from ${report.skillScope.join(", ")}; those skills will be left in place`,
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
      row("skipped", result.agent, result.target, result.message);
    } else {
      failed += 1;
      row("failed", result.agent, result.target, result.message);
    }
  }
  if (report.skillResult) {
    const result = report.skillResult;
    if (result.status === "removed") {
      removed += result.skills.length;
      row(
        "synced",
        "skills",
        "",
        `removed ${result.skills.length} skill(s) from ${result.agents.length} agent(s)`,
      );
    } else if (result.status === "skipped") {
      skipped += 1;
      row("skipped", "skills", "", result.message);
    } else {
      failed += 1;
      row("failed", "skills", "", result.message);
    }
  }
  for (const result of report.mcpResults ?? []) {
    if (result.status === "failed") {
      failed += 1;
      row("failed", result.agent, "", `mcp: ${result.message ?? "failed"}`);
    } else if (result.status === "synced") {
      removed += result.removed.length;
      const count = result.removed.length;
      row(
        "synced",
        result.agent,
        "",
        `removed ${count} MCP server${count === 1 ? "" : "s"}: ${result.removed.join(", ")}`,
      );
    } else if (result.status === "skipped") {
      skipped += 1;
      row("skipped", result.agent, "", `mcp: ${result.message ?? "skipped"}`);
    } else if (result.message) {
      row("unchanged", result.agent, "", `mcp: ${result.message}`);
    }
    if (result.conflicts.length) {
      row(
        "drift",
        result.agent,
        "",
        `MCP conflict(s) left untouched: ${result.conflicts.join(", ")}`,
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
