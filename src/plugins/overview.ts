// Unified plugin overview — "what plugin content do I have, across every agent?".
//
// Plugins load natively on Claude, Codex, GitHub Copilot, and Cursor. Kimi has no
// proven non-interactive native plugin ABI and receives exact loose skills/MCP.
// Copilot can retain loose fallback content from an older/failed install, so a
// true cross-agent picture is three layers:
//   • native plugins, read per readable plugin-capable agent;
//   • Cursor, a write-only plugin target with no list CLI (not readable);
//   • the plugin-derived skills present on each non-plugin agent, computed by
//     intersecting the global skill list (`npx skills list`) with the skill names
//     Claude's installed plugins contribute.

import { listPlugins } from "./index.ts";
import type { PluginAdapterRead } from "./types.ts";
import { listInstalledSkills, resolvePluginDerivedSkills, skillCohort } from "../skills.ts";
import type { AgentId } from "../types.ts";

export type DerivedSkillEntry = { name: string; repo?: string };
export type AgentDerivedSkills = { agent: AgentId; skills: DerivedSkillEntry[] };

export type PluginOverview = {
  // Native plugin reads for the plugin-capable agents that have a list CLI
  // (claude-code, codex, github-copilot). Cursor is write-only — see below.
  native: PluginAdapterRead[];
  // Plugin-derived skills present on each non-plugin (skill-cohort) agent.
  derived: AgentDerivedSkills[];
  // Distinct plugin source repos that contribute skills (from Claude's store).
  derivedRepos: string[];
  // false when `npx skills list` couldn't be read — the derived view is then
  // unknown (blank), not "no derived skills". The renderer says so.
  skillsReadable: boolean;
};

export async function buildPluginOverview(): Promise<PluginOverview> {
  const [native, derivedSources, installed] = await Promise.all([
    listPlugins(),
    resolvePluginDerivedSkills(),
    listInstalledSkills(),
  ]);

  // skill name → the source repo that contributes it (first contributor wins; only
  // used as a human-facing label, so a tie doesn't matter).
  const nameToRepo = new Map<string, string>();
  for (const src of derivedSources) {
    for (const n of src.names) if (!nameToRepo.has(n)) nameToRepo.set(n, src.repo);
  }
  const derivedNames = new Set(nameToRepo.keys());
  const derivedRepos = [...new Set(derivedSources.filter((s) => s.names.length > 0).map((s) => s.repo))].sort();

  const derived: AgentDerivedSkills[] = skillCohort().map((agent) => {
    const skills: DerivedSkillEntry[] = [];
    if (installed) {
      for (const s of installed) {
        if (derivedNames.has(s.name) && s.agents.includes(agent)) {
          skills.push({ name: s.name, repo: nameToRepo.get(s.name) });
        }
      }
      skills.sort((a, b) => a.name.localeCompare(b.name));
    }
    return { agent, skills };
  });

  return { native, derived, derivedRepos, skillsReadable: installed !== null };
}
