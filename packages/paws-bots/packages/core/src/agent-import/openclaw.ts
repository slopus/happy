import type { AgentImportFile } from "@rakazo/contracts";
import type { AgentImportParse, SkillFiles } from "./shared.js";
import { byPath, fileMap, instructionItem, memoryItem, skillItems } from "./shared.js";
import { isOpenClawDefault } from "./stock.js";

/** IDENTITY.md is read for the bot's name and description only, not as instructions. */
export const OPENCLAW_INSTRUCTION_FILES = [
  ["SOUL.md", "persona"],
  ["AGENTS.md", "working"],
] as const;
export const OPENCLAW_MEMORY_FILES = ["MEMORY.md", "USER.md"] as const;
/** Runtime rituals with no Rakazo equivalent. */
export const OPENCLAW_RUNTIME_FILES = ["TOOLS.md", "HEARTBEAT.md", "BOOTSTRAP.md", "BOOT.md"];
const DAILY_MEMORY = /^memory\/[^/]+\.md$/;

export function isOpenClawDailyMemory(path: string): boolean {
  return DAILY_MEMORY.test(path);
}

export function parseOpenClaw(
  files: AgentImportFile[],
  root: string,
  skillFiles: SkillFiles = {},
): AgentImportParse {
  const byName = fileMap(files);
  const memoryPaths = [
    ...OPENCLAW_MEMORY_FILES.filter((path) => byName.has(path)),
    ...[...byName.keys()].filter(isOpenClawDailyMemory).sort(),
  ];
  const skills = skillItems(byName, skillFiles);
  const identity = byName.has("IDENTITY.md")
    ? parseOpenClawIdentity(byName.get("IDENTITY.md") ?? "")
    : null;
  const instructions = OPENCLAW_INSTRUCTION_FILES.flatMap(([path, role]) => {
    const content = byName.get(path);
    if (!content?.trim()) return [];
    const stock = isOpenClawDefault(path, content);
    const mentions = role === "working" && !stock ? openClawRuntimeMentions(content) : [];
    return [instructionItem(path, content, { role, stock, mentions })];
  });
  return {
    suggestedName: identity?.name ?? workspaceAgentId(root) ?? "OpenClaw",
    suggestedDescription: identity?.description ?? "",
    instructions,
    memory: memoryPaths.flatMap((path) => {
      const content = byName.get(path) ?? "";
      return content.trim()
        ? [{ ...memoryItem(path, path, path, content), stock: isOpenClawDefault(path, content) }]
        : [];
    }),
    skills: skills.skills,
    skipped: [
      ...OPENCLAW_RUNTIME_FILES.filter((path) => byName.has(path)).map((path) => ({
        path,
        reason: "runtime" as const,
      })),
      // An avatar and an emoji have no place on a Rakazo bot; a blank template has nothing.
      ...(isOpenClawDefault("IDENTITY.md", byName.get("IDENTITY.md") ?? "")
        ? [{ path: "IDENTITY.md", reason: "default" as const }]
        : []),
      ...(identity?.unused ?? []).map((label) => ({
        path: `IDENTITY.md: ${label}`,
        reason: "runtime" as const,
      })),
      ...skills.skipped,
    ].sort(byPath),
  };
}

/** In OpenClaw's order of preference. */
const DESCRIPTION_LABELS = ["theme", "creature", "vibe"] as const;
const UNUSED_LABELS = { emoji: "Emoji", avatar: "Avatar" } as const;
/** The hints OpenClaw's template leaves in place of a value. */
const PLACEHOLDERS = new Set([
  "not set yet",
  "pick something you like",
  "ai? robot? familiar? ghost in the machine? something weirder?",
  "how do you come across? sharp? warm? chaotic? calm?",
  "your signature - pick one that feels right",
  "workspace-relative path, http(s) url, or data uri",
]);

/** `- Label: value` lines; labels case-insensitive and possibly bold, placeholders ignored. */
export function parseOpenClawIdentity(content: string): {
  name?: string;
  description?: string;
  unused: string[];
} {
  const fields = new Map<string, string>();
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const cleaned = line
      .trim()
      .replace(/^-\s*/, "")
      .replace(/^([*_`]+)([A-Za-z]+):\1/, "$2:");
    const colon = cleaned.indexOf(":");
    if (colon <= 0) continue;
    const label = cleaned.slice(0, colon).replace(/[*_`]/g, "").trim().toLowerCase();
    const value = identityValue(cleaned.slice(colon + 1));
    if (value && !fields.has(label)) fields.set(label, value);
  }
  const description = DESCRIPTION_LABELS.map((label) => fields.get(label)).find(Boolean);
  return {
    ...(fields.get("name") ? { name: fields.get("name") } : {}),
    ...(description ? { description } : {}),
    unused: Object.entries(UNUSED_LABELS).flatMap(([label, title]) =>
      fields.has(label) ? [title] : [],
    ),
  };
}

function identityValue(raw: string): string {
  let value = raw.trim();
  for (;;) {
    const paired = /^(\*{1,2}|_{1,2}|`+)([\s\S]+)\1$/.exec(value);
    if (!paired) break;
    value = paired[2]!.trim();
  }
  let hint = value;
  if (hint.startsWith("(") && hint.endsWith(")")) hint = hint.slice(1, -1).trim();
  hint = hint
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!value || PLACEHOLDERS.has(hint) || /^\(.*\)$/.test(value)) return "";
  return value.replace(/\s+/g, " ");
}

/** Section headings and files that only mean something to OpenClaw's own runtime. */
const RUNTIME_HEADING = /^#{1,6}\s+(?:\W+\s*)?(first run|session startup|heartbeats?\b.*)$/i;
const RUNTIME_FILE = /\b(BOOTSTRAP\.md|HEARTBEAT\.md|BOOT\.md|memory\/YYYY-MM-DD\.md)\b/g;

/** Only flagged, never rewritten: whether the text still makes sense is the user's call. */
export function openClawRuntimeMentions(content: string): string[] {
  const found = new Set<string>();
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = RUNTIME_HEADING.exec(line.trim());
    if (heading) found.add(line.trim().replace(/^#+\s+/, ""));
    for (const match of line.matchAll(RUNTIME_FILE)) found.add(match[1]!);
  }
  return [...found];
}

function workspaceAgentId(root: string): string | undefined {
  return /^workspace-(.+)$/.exec(root)?.[1];
}
