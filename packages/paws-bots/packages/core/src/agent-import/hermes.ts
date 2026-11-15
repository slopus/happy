import type { AgentImportFile } from "@rakazo/contracts";
import type { AgentImportParse, SkillFiles } from "./shared.js";
import { byPath, fileMap, instructionItem, memoryItem, skillItems } from "./shared.js";
import { isHermesDefault } from "./stock.js";

export const HERMES_INSTRUCTION_FILES = [
  ["SOUL.md", "persona"],
  ["AGENTS.md", "working"],
  ["HERMES.md", "working"],
  [".hermes.md", "working"],
] as const;
/** Hermes keeps memory under `memories/`; Rakazo keeps the same names at the root. */
export const HERMES_MEMORY_FILES = [
  ["memories/MEMORY.md", "MEMORY.md"],
  ["memories/USER.md", "USER.md"],
] as const;

/** Skills Hermes installed itself, one `name:hash` per line. */
export const BUNDLED_MANIFEST = "skills/.bundled_manifest";

export function bundledSkillNames(manifest: string): Set<string> {
  return new Set(
    manifest
      .split(/\r?\n/)
      .map((line) => line.split(":")[0]!.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function parseHermes(
  files: AgentImportFile[],
  skillFiles: SkillFiles = {},
): AgentImportParse {
  const byName = fileMap(files);
  const bundled = bundledSkillNames(byName.get(BUNDLED_MANIFEST) ?? "");
  // Offering Hermes' own library would flood Rakazo's; only the user's skills are imported.
  const all = skillItems(byName, skillFiles);
  const builtIn = all.skills.filter((skill) => {
    const folder = skill.id.split("/").at(-2) ?? "";
    return bundled.has(skill.title.toLowerCase()) || bundled.has(folder.toLowerCase());
  });
  const skills = {
    skills: all.skills.filter((skill) => !builtIn.includes(skill)),
    skipped: [
      ...all.skipped,
      ...builtIn.map((skill) => ({
        path: skill.id.slice("skills:".length),
        reason: "builtin" as const,
      })),
    ].sort(byPath),
  };
  return {
    suggestedName: "Hermes",
    suggestedDescription: "",
    instructions: HERMES_INSTRUCTION_FILES.flatMap(([path, role]) => {
      const content = byName.get(path);
      if (!content?.trim()) return [];
      const stock = role === "persona" && isHermesDefault(content);
      return [instructionItem(path, content, { role, stock })];
    }),
    memory: HERMES_MEMORY_FILES.flatMap(([source, path]) => {
      const content = hermesEntries(byName.get(source) ?? "");
      return content ? [memoryItem(source, source, path, content)] : [];
    }),
    skills: skills.skills,
    skipped: skills.skipped,
  };
}

/** Hermes separates memory entries with a line holding only `§`; keep one paragraph each. */
function hermesEntries(content: string): string {
  const entries: string[] = [];
  let current: string[] = [];
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim() === "§") {
      entries.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  entries.push(current.join("\n"));
  const kept = entries.map((entry) => entry.trim()).filter(Boolean);
  return kept.length ? `${kept.join("\n\n")}\n` : "";
}
