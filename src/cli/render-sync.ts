import { dim, green, red, row, yellow } from "./output.ts";

export function printPluginSkills(
  report: import("../skills.ts").PluginSkillsReport,
  dryRun: boolean,
) {
  if (!report.ran) {
    row("skipped", "plugin-skills", "", report.message);
    return;
  }
  let added = 0;
  let skipped = 0;
  let failed = 0;
  for (const result of report.results) {
    if (result.status === "added") added += 1;
    else if (result.status === "skipped") skipped += 1;
    else failed += 1;
  }
  const verb = dryRun ? "would add" : "added";
  const detail = `${verb} ${added}${skipped ? `, ${skipped} skipped` : ""}${failed ? `, ${failed} failed` : ""}`;
  row(
    failed ? "drift" : "synced",
    "plugin-skills",
    `${report.sources.length} repo(s) → ${report.agents.length} agent(s)`,
    detail,
  );
  for (const result of report.results) {
    if (result.status === "failed") {
      console.log(`      ${red("✗")} ${result.repo} ${dim(result.message ?? "")}`);
    }
  }
}

function printCompatibilityIssues(issues: import("../types.ts").AdapterCompatibilityIssue[]) {
  if (issues.length === 0) return;
  console.log(yellow(`\ncompatibility adjustments:`));
  for (const issue of issues) {
    console.log(
      `  ${yellow("~")} ${issue.agent.padEnd(14)} ${issue.server} ${dim(`${issue.action}: ${issue.reason}`)}`,
    );
  }
}

function printPluginReconciliation(
  report: import("../plugins/reconcile.ts").PluginReconcileReport,
) {
  const inventoryErrors = report.inventory.errors.filter(
    (error) => error.source !== "native-runtime",
  );
  if (
    report.inventory.artifacts.length === 0 &&
    report.results.length === 0 &&
    inventoryErrors.length === 0
  ) {
    return;
  }

  const active = report.results.filter((result) => result.status === "present").length;
  const changed = report.results.filter((result) =>
    ["installed", "repaired", "unverified", "would-install", "would-repair"].includes(
      result.status,
    ),
  ).length;
  const degradation = report.results.filter((result) => result.degradation.eligible).length;
  console.log(
    dim(
      `plugins: ${report.inventory.artifacts.length} artifact(s); ${active} active, ${changed} native action(s), ${degradation} targeted degradation plan(s)`,
    ),
  );

  for (const result of report.results) {
    const label = `plugin→${result.agent}`;
    const target = result.marketplace
      ? `${result.requestedName}@${result.marketplace}`
      : result.requestedName;
    if (result.status === "present") {
      row(
        "unchanged",
        label,
        target,
        `active${result.activatedAs?.length ? ` as ${result.activatedAs.join(", ")}` : ""}`,
      );
    } else if (result.status === "failed") {
      row("failed", label, target, result.message);
    } else if (result.status === "unsupported") {
      const channels = [
        result.degradation.skills ? "skills" : "",
        result.degradation.mcp ? "MCP" : "",
      ].filter(Boolean);
      row(
        "drift",
        label,
        target,
        result.degradation.eligible
          ? `${channels.join(" + ") || "content"} fallback eligible (${result.degradation.reason}); targeted action follows`
          : result.message,
      );
    } else if (result.status === "unverified") {
      row("drift", label, target, result.message ?? "installed; activation cannot be verified");
    } else {
      const verb =
        result.status === "would-install" || result.status === "would-repair"
          ? `${result.status} (dry-run)`
          : result.status;
      row("synced", label, target, result.message ?? verb);
    }
  }

  for (const error of inventoryErrors) {
    row("failed", "plugin-index", error.plugin ?? error.source, error.message);
  }
}

function printPluginDegradation(
  report: import("../plugins/degrade.ts").PluginDegradationReport,
) {
  if (report.results.length === 0) return;
  console.log(
    dim(
      `plugin fallback: ${report.results.length} exact action(s), ${report.failures.length} failure(s)`,
    ),
  );
  for (const result of report.results) {
    const label = `plugin-${result.component}→${result.agent}`;
    const target = result.source ?? result.artifactId;
    const conflicts = result.conflicts?.length
      ? `${result.conflicts.length} conflict(s) left untouched: ${result.conflicts.join(", ")}`
      : "";
    const omitted = result.skipped?.length
      ? `${result.skipped.length} bundled MCP definition(s) skipped`
      : "";
    const action =
      result.component === "skills"
        ? result.status === "would-add"
          ? "would add bundled skills"
          : result.status === "added"
            ? "added bundled skills"
            : result.message
        : result.status === "would-add"
          ? `would add ${result.added?.length ?? 0} MCP server(s)`
          : result.status === "added"
            ? `added ${result.added?.length ?? 0} MCP server(s)`
            : result.message;
    const detail = [action, conflicts, omitted].filter(Boolean).join("; ");

    if (result.status === "would-add" || result.status === "added") {
      row("synced", label, target, detail);
    } else if (result.status === "unchanged") {
      row("unchanged", label, target, detail || "already present");
    } else if (result.status === "skipped") {
      row("skipped", label, target, detail || "skipped");
    } else {
      row("failed", label, target, detail || "fallback failed");
    }
  }
}

export function printSync(report: import("../sync.ts").SyncReport) {
  printPluginReconciliation(report.plugins);

  const totalNames = new Set<string>();
  for (const read of report.reads) {
    for (const name of Object.keys(read.servers)) totalNames.add(name);
  }
  const safeCount = Object.keys(report.union).length;
  console.log(
    dim(
      `read ${totalNames.size} server name(s) across ${report.reads.length} agent(s); ${safeCount} synced, ${report.conflicts.length} conflict(s)`,
    ),
  );

  for (const write of report.writes) {
    row(write.status, write.agent, write.path, write.message);
  }
  printCompatibilityIssues(report.writes.flatMap((write) => write.compatibility ?? []));

  if (report.conflicts.length) {
    console.log(
      yellow(`\n${report.conflicts.length} conflict(s) — left each agent's own copy untouched:`),
    );
    for (const conflict of report.conflicts) {
      console.log(`  ${yellow("~")} ${conflict.name}`);
      for (const version of conflict.versions) {
        console.log(`      ${dim(`in ${version.agent}`)}`);
      }
    }
    console.log(dim(`  resolve by deleting the version you don't want, then re-run sync.`));
  }

  printPluginDegradation(report.pluginDegradation);

  if (report.pluginSkills) {
    printPluginSkills(report.pluginSkills, report.pluginSkills.dryRun);
  }

  if (report.skills) {
    if (!report.skills.ran) row("skipped", "skills", "", report.skills.message);
    else if (report.skills.ok) row("synced", "skills", "", "npx skills update -y");
    else row("drift", "skills", "", report.skills.message ?? "failed");
  }

  if (!report.ok) {
    console.log(red(`\nsync completed with one or more failures.`));
    process.exit(1);
  }
}

export function printDoctor(report: import("../doctor.ts").DoctorReport) {
  for (const read of report.reads) {
    if (read.error) row("invalid", read.agent, read.path, read.error);
    else if (!read.exists) row("missing", read.agent, read.path, "file does not exist");
    else row("ok", read.agent, read.path, `${Object.keys(read.servers).length} server(s)`);
  }

  if (report.coverage.length === 0) {
    console.log(dim("\nno servers configured in any agent."));
  } else {
    console.log(dim(`\ncoverage:`));
    for (const coverage of report.coverage) {
      const tag =
        coverage.missing.length === 0
          ? green("[full]")
          : yellow(`[${coverage.present.length}/${report.reads.length}]`);
      const detail =
        coverage.missing.length === 0
          ? ""
          : dim(` — missing in ${coverage.missing.join(", ")}`);
      console.log(`  ${tag} ${coverage.name}${detail}`);
    }
  }

  printCompatibilityIssues(report.reads.flatMap((read) => read.compatibility ?? []));

  if (report.conflicts.length) {
    console.log(yellow(`\n${report.conflicts.length} conflict(s):`));
    for (const conflict of report.conflicts) {
      console.log(
        `  ${yellow("~")} ${conflict.name} — different config in ${conflict.versions.map((version) => version.agent).join(", ")}`,
      );
    }
    process.exit(1);
  }

  if (report.unmanaged.length) {
    console.log(yellow(`\nunmanaged MCP config(s) with servers:`));
    for (const unmanaged of report.unmanaged) {
      console.log(
        `  ${yellow("~")} ${unmanaged.label.padEnd(18)} ${dim(unmanaged.path)} ${dim(`(${unmanaged.serverNames.join(", ")})`)}`,
      );
    }
    console.log(
      dim("  these files are not written by syncthis; clear or manage them separately."),
    );
  }
}
