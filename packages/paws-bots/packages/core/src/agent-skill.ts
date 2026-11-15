/**
 * Claude Agent Skills: reusable SKILL.md recipes shared across assistants.
 * The Pi runtime already understands this format; we persist and inject them.
 * Distinct from taught skills (demo/record playbooks on a single bot).
 */

const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export type SkillSource = "user" | "builtin" | "plugin";

export type ParsedSkillMd = {
  name: string;
  description: string;
  body: string;
  /**
   * All frontmatter keys as parsed scalars/structures. Unknown keys are preserved
   * so Claude Agent Skills with extra fields round-trip safely.
   */
  frontmatter: Record<string, unknown>;
};

export type SkillCatalogEntry = {
  name: string;
  description: string;
  source: SkillSource;
  readOnly: boolean;
};

export type SkillRecord = SkillCatalogEntry & {
  id?: string;
  content: string;
};

const FORCE_SKILL_PREFIX = /^(?:\/|use\s+skill:\s*)(.+?)(?:\n|$)/i;
const ROUTINE_SKILL_STOP = new Set([
  "then",
  "and",
  "or",
  "to",
  "for",
  "with",
  "from",
  "via",
  "before",
  "after",
  "please",
  "the",
  "a",
  "an",
]);
// Detection, expansion, and import renames must agree on mention boundaries.
const ROUTINE_SKILL_LEAD = "[\\s(,，。、；：！？（【「『《]";
const ROUTINE_SKILL_END = "(?=[\\s,.)，。、；：！？）】」』》]|$)";
/** Fallback when no catalog is available: @Token with optional Title-case words. */
const ROUTINE_SKILL_MENTION = new RegExp(
  `(?:^|${ROUTINE_SKILL_LEAD})@([A-Za-z][\\w-]*(?:[ ]+[A-Za-z][\\w-]*){0,5})${ROUTINE_SKILL_END}`,
  "g",
);

export function isSkillReadOnly(source: SkillSource): boolean {
  return source === "builtin" || source === "plugin";
}

/** Requires YAML frontmatter with `name` and `description`; extra keys are kept in `frontmatter`. */
export function parseSkillMd(content: string): ParsedSkillMd | { error: string } {
  const trimmed = content.replace(/^\uFEFF/, "");
  const match = FRONTMATTER_FENCE.exec(trimmed);
  if (!match) {
    return { error: "SKILL.md must start with YAML frontmatter (--- ... ---)." };
  }
  const frontmatterText = match[1] ?? "";
  const body = trimmed.slice(match[0].length).replace(/^\r?\n/, "");
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseSimpleYamlObject(frontmatterText);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid SKILL.md frontmatter.",
    };
  }
  const name = stringifyScalar(frontmatter.name).trim();
  const description = stringifyScalar(frontmatter.description).trim();
  if (!name) return { error: "SKILL.md frontmatter requires name." };
  if (!description) return { error: "SKILL.md frontmatter requires description." };
  if (name.length > 80) return { error: "Skill name must be at most 80 characters." };
  if (description.length > 2000) {
    return { error: "Skill description must be at most 2000 characters." };
  }
  return { name, description, body, frontmatter };
}

/** Build SKILL.md, preserving unknown frontmatter keys from a prior parse. */
export function buildSkillMd(input: {
  name: string;
  description: string;
  body: string;
  frontmatter?: Record<string, unknown>;
}): string {
  const name = input.name.trim();
  const description = input.description.trim();
  if (!name) throw new Error("Skill name is required.");
  if (!description) throw new Error("Skill description is required.");
  if (name.length > 80) throw new Error("Skill name must be at most 80 characters.");
  if (description.length > 2000) {
    throw new Error("Skill description must be at most 2000 characters.");
  }
  const merged: Record<string, unknown> = { ...(input.frontmatter ?? {}) };
  merged.name = name;
  merged.description = description;
  // Stable order: name, description, then remaining keys alphabetically.
  const rank = (key: string) => (key === "name" ? 0 : key === "description" ? 1 : 2);
  const keys = Object.keys(merged).sort((a, b) => {
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
  const lines = keys.map((key) => formatYamlLine(key, merged[key]));
  const body = input.body.replace(/^\r?\n/, "");
  return `---\n${lines.join("\n")}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

export function skillCatalogLine(entry: Pick<SkillCatalogEntry, "name" | "description">): string {
  return `- ${entry.name}: ${entry.description}`;
}

export function formatSkillsCatalogInstruction(entries: SkillCatalogEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const lines = entries.slice(0, 50).map(skillCatalogLine).join("\n");
  return [
    "Available Claude Agent Skills (SKILL.md recipes shared across assistants; generic how-tos, not account-specific routines). The Pi runtime already understands this format; we persist and inject them:",
    lines,
    "When a skill matches the user's request, call skill_read for that name and follow it immediately. Prefer matching skills over improvising multi-step recipes.",
    "Users can force a skill with /Name in the composer. Routines may mention a skill as @Name — that loads the skill at fire time.",
    "Create a skill with skill_create when a multi-step task is worth repeating (or when asked). After creating one, mention /Name so the user can open it.",
    "Only skill_update / skill_delete user-created skills (not builtin or plugin).",
  ].join("\n");
}

export function formatForcedSkillPrompt(name: string, content: string, rest?: string): string {
  const parts = [`Use skill: ${name}`, "", content.trim()];
  const trailing = rest?.trim();
  if (trailing) parts.push("", trailing);
  return parts.join("\n");
}

/** Detect a composer-forced skill (`/Name` or `Use skill: Name`) at the start of a prompt. */
export function extractForcedSkillName(prompt: string): { name: string; rest: string } | null {
  const text = prompt.trimStart();
  const match = FORCE_SKILL_PREFIX.exec(text);
  if (!match) return null;
  const name = (match[1] ?? "").trim().replace(/^\/+/, "").trim();
  if (!name || name.length > 80) return null;
  // Avoid treating `/` settings actions as skills.
  if (/^(chat\s+settings|settings:)/i.test(name)) return null;
  const rest = text.slice(match[0].length).trimStart();
  return { name, rest };
}

/**
 * Mentions like `@Daily standup` inside a routine prompt. Returns unique names in order.
 * When `knownNames` is provided, matches those names (longest first). Otherwise uses a
 * heuristic that stops before common connector words and skips `@everyone`.
 */
export function extractRoutineSkillMentions(prompt: string, knownNames?: string[]): string[] {
  if (knownNames && knownNames.length > 0) {
    const sorted = knownNames
      .map((name) => name.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (sorted.length === 0) return [];
    // Match each mention once so a longer name does not also select its prefix.
    // Each capture identifies its catalog name without changing regex case matching.
    const alternatives = sorted.map((name) => `(${escapeRegExp(name)})`).join("|");
    const re = new RegExp(
      `(?:^|${ROUTINE_SKILL_LEAD})@(?:${alternatives})${ROUTINE_SKILL_END}`,
      "gi",
    );
    const mentionedIndices = new Set(
      [...prompt.matchAll(re)].map((match) =>
        match.slice(1).findIndex((capture) => capture !== undefined),
      ),
    );
    const found: string[] = [];
    const seen = new Set<string>();
    for (const [index, name] of sorted.entries()) {
      const key = name.toLowerCase();
      if (!mentionedIndices.has(index) || seen.has(key)) continue;
      seen.add(key);
      found.push(name);
    }
    return found;
  }

  const names: string[] = [];
  const seen = new Set<string>();
  ROUTINE_SKILL_MENTION.lastIndex = 0;
  let match = ROUTINE_SKILL_MENTION.exec(prompt);
  while (match !== null) {
    const raw = (match[1] ?? "").trim();
    if (!raw) {
      match = ROUTINE_SKILL_MENTION.exec(prompt);
      continue;
    }
    const parts = raw.split(/\s+/);
    while (parts.length > 1 && ROUTINE_SKILL_STOP.has(parts[parts.length - 1]!.toLowerCase())) {
      parts.pop();
    }
    const name = parts.join(" ").trim();
    if (!name || name.toLowerCase() === "everyone") {
      match = ROUTINE_SKILL_MENTION.exec(prompt);
      continue;
    }
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
    match = ROUTINE_SKILL_MENTION.exec(prompt);
  }
  return names;
}

/** Keep user-owned skills reachable when a later builtin claims the same name. */
export function mergeBuiltinSkills<T extends { name: string }>(
  builtins: readonly T[],
  userSkills: readonly T[],
): T[] {
  return [...builtins.filter((skill) => !findSkillByName(userSkills, skill.name)), ...userSkills];
}

export function findSkillByName<T extends { name: string }>(
  skills: readonly T[],
  name: string,
): T | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return skills.find((skill) => skill.name.trim().toLowerCase() === needle);
}

/** True when `rest` already begins with the skill body (prior expand pass). */
function restAlreadyIncludesSkillContent(rest: string, content: string): boolean {
  const trimmedRest = rest.trim();
  const trimmedContent = content.trim();
  if (!trimmedContent) return false;
  return (
    trimmedRest === trimmedContent ||
    trimmedRest.startsWith(`${trimmedContent}\n`) ||
    trimmedRest.startsWith(`${trimmedContent}\r\n`)
  );
}

/** Expand forced `/Name` or routine `@Name` mentions into full skill bodies for the task prompt. */
export function expandSkillReferencesInPrompt(
  prompt: string,
  skills: readonly SkillRecord[],
): string {
  const forced = extractForcedSkillName(prompt);
  if (forced) {
    const skill = findSkillByName(skills, forced.name);
    if (skill) {
      // Routines expand at fire time into `Use skill: …`; run time expands again — stay idempotent.
      if (restAlreadyIncludesSkillContent(forced.rest, skill.content)) {
        return prompt.trimStart();
      }
      return formatForcedSkillPrompt(skill.name, skill.content, forced.rest);
    }
  }

  const mentions = extractRoutineSkillMentions(
    prompt,
    skills.map((skill) => skill.name),
  );
  if (mentions.length === 0) return prompt;

  const blocks: string[] = [];
  let remaining = prompt;
  for (const mention of mentions) {
    const skill = findSkillByName(skills, mention);
    if (!skill) continue;
    blocks.push(formatForcedSkillPrompt(skill.name, skill.content));
    // Strip the @mention token so the agent is not confused by a dangling pointer.
    remaining = remaining.replace(
      new RegExp(`(^|${ROUTINE_SKILL_LEAD})@${escapeRegExp(mention)}${ROUTINE_SKILL_END}`, "gi"),
      "$1",
    );
  }
  if (blocks.length === 0) return prompt;
  const rest = remaining.replace(/[ \t]{2,}/g, " ").trim();
  return [...blocks, rest].filter(Boolean).join("\n\n");
}

/**
 * Points `@old` skill mentions in a routine prompt at their new names, in one pass. Names
 * mapped to themselves are still matched, so a longer name wins over a renamed prefix.
 */
export function renameRoutineSkillMentions(
  prompt: string,
  renames: ReadonlyMap<string, string>,
): string {
  const names = [...renames.keys()].sort((a, b) => b.length - a.length);
  if (names.length === 0) return prompt;
  const next = new Map([...renames].map(([from, to]) => [from.toLowerCase(), to]));
  return prompt.replace(
    new RegExp(
      `(^|${ROUTINE_SKILL_LEAD})@(${names.map(escapeRegExp).join("|")})${ROUTINE_SKILL_END}`,
      "gi",
    ),
    (match, lead: string, name: string) => {
      const to = next.get(name.toLowerCase());
      return to ? `${lead}@${to}` : match;
    },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

type YamlBlockScalarHeader = {
  style: "|" | ">";
  chomp: "clip" | "strip" | "keep";
  indent: number | null;
};

function parseYamlBlockScalarHeader(raw: string): YamlBlockScalarHeader | null {
  const match = /^([>|])(?:([1-9]\d*)([+-]?)|([+-])([1-9]\d*)?)?(?:[ \t]+(?:#.*)?)?$/.exec(raw);
  if (!match) return null;
  const style = match[1] as "|" | ">";
  const indentToken = match[2] ?? match[5] ?? "";
  const chompToken = match[3] || match[4] || "";
  const chomp = chompToken === "+" ? "keep" : chompToken === "-" ? "strip" : "clip";
  const indent = indentToken ? Number(indentToken) : null;
  return { style, chomp, indent };
}

function leadingSpaces(line: string): number {
  const match = /^( *)/.exec(line);
  return match?.[1]?.length ?? 0;
}

function decodeYamlBlockScalar(rawLines: string[], header: YamlBlockScalarHeader): string {
  let indent = header.indent;
  if (indent == null) {
    indent = 0;
    for (const line of rawLines) {
      if (line.trim() === "") continue;
      const spaces = leadingSpaces(line);
      if (indent === 0 || spaces < indent) indent = spaces;
    }
  }

  const contentLines = rawLines.map((line) => {
    if (line.trim() === "") return "";
    if (leadingSpaces(line) < indent!) return line.trimStart();
    return line.slice(indent!);
  });

  // Count trailing blank lines before they are folded away for chomp=keep.
  let trailingBlanks = 0;
  for (let i = contentLines.length - 1; i >= 0; i -= 1) {
    if (contentLines[i] !== "") break;
    trailingBlanks += 1;
  }

  let text: string;
  if (header.style === "|") {
    text = contentLines.join("\n");
  } else {
    // Folded (YAML 1.2 §8.1.3): same-indent lines join with spaces; empty source
    // lines become paragraph breaks; more-indented lines stay literal. Parts are
    // always joined with "\n" so folded paragraphs and indented fragments keep
    // line-break separation (never concatenated into one folded run).
    const parts: string[] = [];
    let paragraph: string[] = [];
    const flush = () => {
      if (paragraph.length === 0) return;
      parts.push(paragraph.join(" "));
      paragraph = [];
    };
    for (const line of contentLines) {
      if (line === "") {
        flush();
        parts.push("");
        continue;
      }
      if (/^ /.test(line)) {
        flush();
        parts.push(line);
        continue;
      }
      paragraph.push(line);
    }
    flush();
    text = parts.join("\n");
  }

  if (header.chomp === "strip") {
    return text.replace(/\n+$/, "");
  }
  if (header.chomp === "keep") {
    if (trailingBlanks === 0) return text.endsWith("\n") ? text : `${text}\n`;
    const stripped = text.replace(/\n+$/, "");
    return `${stripped}\n${"\n".repeat(trailingBlanks)}`;
  }
  // clip: exactly one trailing newline when the block had content.
  const stripped = text.replace(/\n+$/, "");
  return stripped === "" ? "" : `${stripped}\n`;
}

/**
 * Minimal YAML object parser for SKILL.md frontmatter.
 * Supports scalars, folded/literal block scalars (`>`, `|`, `>-`, `|+`, `|2`, …),
 * inline arrays, and nested maps one level deep.
 * Unrecognized lines are kept as string values under their key when possible.
 */
function parseSimpleYamlObject(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) {
      i += 1;
      continue;
    }
    if (/^\s/.test(line)) {
      throw new Error("Unexpected indented frontmatter line without a key.");
    }
    const keyed = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!keyed) {
      throw new Error(`Invalid frontmatter line: ${line}`);
    }
    const key = keyed[1]!;
    const raw = keyed[2] ?? "";
    const blockHeader = parseYamlBlockScalarHeader(raw);
    if (blockHeader) {
      const blockLines: string[] = [];
      i += 1;
      while (i < lines.length && (/^\s+/.test(lines[i] ?? "") || (lines[i] ?? "").trim() === "")) {
        blockLines.push(lines[i] ?? "");
        i += 1;
      }
      result[key] = decodeYamlBlockScalar(blockLines, blockHeader);
      continue;
    }
    if (raw === "") {
      // Nested map or list on following indented lines.
      const nested: Record<string, unknown> = {};
      const list: unknown[] = [];
      let mode: "empty" | "map" | "list" = "empty";
      i += 1;
      while (i < lines.length && /^\s+/.test(lines[i] ?? "")) {
        const nestedLine = (lines[i] ?? "").replace(/^\s+/, "");
        const listItem = /^-\s+(.*)$/.exec(nestedLine);
        if (listItem) {
          mode = "list";
          list.push(parseYamlScalar(listItem[1] ?? ""));
          i += 1;
          continue;
        }
        const nestedKey = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(nestedLine);
        if (nestedKey) {
          mode = "map";
          nested[nestedKey[1]!] = parseYamlScalar(nestedKey[2] ?? "");
          i += 1;
          continue;
        }
        break;
      }
      result[key] = mode === "list" ? list : mode === "map" ? nested : "";
      continue;
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
      result[key] = splitYamlInlineArray(raw.slice(1, -1))
        .map((part) => parseYamlScalar(part.trim()))
        .filter((part) => part !== "");
      i += 1;
      continue;
    }
    result[key] = parseYamlScalar(raw);
    i += 1;
  }
  return result;
}

function splitYamlInlineArray(raw: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (quote === '"' && char === "\\") {
      i += 1;
    } else if (quote === "'" && char === "'" && raw[i + 1] === "'") {
      i += 1;
    } else if (quote && char === quote) {
      quote = null;
    } else if (!quote && (char === '"' || char === "'") && raw.slice(start, i).trim() === "") {
      quote = char;
    } else if (!quote && char === ",") {
      parts.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  // Keep the prior behavior for malformed, unclosed quoted entries.
  if (quote) return raw.split(",");
  parts.push(raw.slice(start));
  return parts;
}

function parseYamlScalar(raw: string): string | number | boolean {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    // Saves write double-quoted values with JSON.stringify. Decode them so the next save
    // does not add another escape layer. Non-JSON escapes such as "C:\path" keep the slice.
    try {
      const decoded: unknown = JSON.parse(value);
      if (typeof decoded === "string") return decoded;
    } catch {
      // Fall through to the slice below.
    }
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function formatYamlBlockScalar(key: string, value: string): string {
  // Choose chomp so decodeYamlBlockScalar round-trips trailing newlines:
  // strip (0), clip (1), keep (2+). Folded (`>`) style is not preserved — only the string value.
  const trailing = /\n*$/.exec(value)?.[0].length ?? 0;
  let indicator = "|";
  let lines: string[];
  if (trailing === 0) {
    indicator = "|-";
    lines = value.split("\n");
  } else if (trailing === 1) {
    indicator = "|";
    lines = value.slice(0, -1).split("\n");
  } else {
    indicator = "|+";
    const core = value.slice(0, -trailing);
    // keep decoder yields 1 + trailingBlanks newlines; emit trailingBlanks blank lines.
    lines = [...core.split("\n"), ...Array.from({ length: trailing - 1 }, () => "")];
  }
  const indented = lines.map((line) => `  ${line}`).join("\n");
  return `${key}: ${indicator}\n${indented}`;
}

function formatYamlLine(key: string, value: unknown): string {
  if (value === null || value === undefined) return `${key}:`;
  if (typeof value === "string") {
    if (value.includes("\n") || value.includes(": ")) {
      return formatYamlBlockScalar(key, value);
    }
    if (
      value === "" ||
      /[#{}[\],&*?|>!%@`]/.test(value) ||
      value !== value.trim() ||
      value.startsWith('"') ||
      value.startsWith("'") ||
      typeof parseYamlScalar(value) !== "string"
    ) {
      return `${key}: ${JSON.stringify(value)}`;
    }
    return `${key}: ${value}`;
  }
  if (typeof value === "number" || typeof value === "boolean") return `${key}: ${value}`;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string" || typeof item === "number")) {
      return `${key}: [${value.map((item) => JSON.stringify(String(item))).join(", ")}]`;
    }
    const items = value
      .map((item) => `  - ${typeof item === "string" ? item : JSON.stringify(item)}`)
      .join("\n");
    return `${key}:\n${items}`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${key}:`;
    const nested = entries
      .map(([nestedKey, nestedValue]) => `  ${formatYamlLine(nestedKey, nestedValue)}`)
      .join("\n");
    return `${key}:\n${nested}`;
  }
  return `${key}: ${JSON.stringify(String(value))}`;
}
