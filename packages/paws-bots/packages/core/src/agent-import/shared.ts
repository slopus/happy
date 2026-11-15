import type {
  AgentImportFile,
  AgentImportInstruction,
  AgentImportMemory,
  AgentImportNeed,
  AgentImportPlan,
  AgentImportSkill,
} from "@rakazo/contracts";
import { parse as parseYaml } from "yaml";
import { parseSkillMd } from "../agent-skill.js";

/** Names of the other files in each skill's folder, by SKILL.md path. */
export type SkillFiles = Readonly<Record<string, readonly string[]>>;

export type AgentImportParse = Omit<
  AgentImportPlan,
  "source" | "model" | "mcpServers" | "routines" | "apiKeys"
>;

const SKILL_CONTENT_MAX_LENGTH = 100_000;
const SKILL_FILE = /^(?:\.agents\/)?skills\/(?:[^/]+\/){1,4}SKILL\.md$/;

/** Folders that hold sessions, logs, schedules or credentials. Never read. */
const PRIVATE_FOLDERS = new Set(["sessions", "logs", "cron", "credentials"]);

export function isPrivatePath(path: string): boolean {
  return PRIVATE_FOLDERS.has(path.split("/")[0] ?? "");
}

export function isSkillPath(path: string): boolean {
  return SKILL_FILE.test(path);
}

/** Code-unit order, so plans do not depend on the upload order or locale. */
export function byPath(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function fileMap(files: AgentImportFile[]): Map<string, string> {
  return new Map(files.filter((file) => !isPrivatePath(file.path)).map((f) => [f.path, f.content]));
}

export function instructionItem(
  path: string,
  content: string,
  meaning: Pick<AgentImportInstruction, "role"> &
    Partial<Pick<AgentImportInstruction, "stock" | "mentions">>,
): AgentImportInstruction {
  return {
    id: `instructions:${path}`,
    title: path,
    content,
    stock: false,
    mentions: [],
    ...meaning,
  };
}

export function memoryItem(id: string, title: string, path: string, content: string) {
  return {
    id: `memory:${id}`,
    title,
    path,
    spacePath: path,
    content,
    stock: false,
  } satisfies AgentImportMemory;
}

export function skillItems(
  files: Map<string, string>,
  skillFiles: SkillFiles = {},
): Pick<AgentImportParse, "skills" | "skipped"> {
  const skills: AgentImportSkill[] = [];
  const skipped: AgentImportParse["skipped"] = [];
  for (const path of [...files.keys()].filter(isSkillPath).sort()) {
    const item = skillItem(`skills:${path}`, files.get(path) ?? "", skillFiles[path] ?? []);
    if (item) skills.push(item);
    else skipped.push({ path, reason: "invalid_skill" });
  }
  return { skills, skipped };
}

/**
 * Keeps the SKILL.md bytes exactly as written (BOM, CRLF): the frontmatter parser is minimal
 * and would flatten nested metadata, so it only checks a normalised copy.
 */
export function skillItem(
  id: string,
  markdown: string,
  siblings: readonly string[] = [],
): AgentImportSkill | null {
  const view = normalise(markdown);
  const parsed = parseSkillMd(view);
  if ("error" in parsed || markdown.length > SKILL_CONTENT_MAX_LENGTH) return null;
  return {
    id,
    title: parsed.name,
    name: parsed.name,
    description: parsed.description,
    content: markdown,
    ...skillAssessment(view, parsed.body, siblings),
  };
}

function normalise(markdown: string): string {
  return markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** Rewrites only the value of the frontmatter `name:` entry, keeping every other byte. */
export function renameSkillMd(content: string, name: string): string {
  const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---)(?=\r?\n|$)/.exec(content);
  if (!match) return content;
  const head = match[1]!;
  const body = match[2]!;
  const line = /^name[ \t]*:([^\r\n]*)(\r?)$/m.exec(body);
  if (!line) return content;
  const value = line[1]!.trim();
  const start = line.index + line[0].indexOf(":") + 1;
  let end = line.index + line[0].length - line[2]!.length;
  let replacement = ` ${yamlScalar(name)}`;
  // A block scalar name continues on indented lines; replace those lines too.
  if (/^[|>]/.test(value)) {
    const rest = body.slice(line.index + line[0].length);
    const continuation = /^(?:\r?\n(?:[ \t]+.*|[ \t]*)(?=\r?\n|$))*/.exec(rest)?.[0] ?? "";
    end = line.index + line[0].length + continuation.length;
    replacement = ` ${yamlScalar(name)}${line[2] ?? ""}`;
  }
  const renamed = `${body.slice(0, start)}${replacement}${body.slice(end)}`;
  return `${head}${renamed}${content.slice(head.length + body.length)}`;
}

function yamlScalar(value: string): string {
  const plain =
    /^[A-Za-z0-9][\w .-]*$/.test(value) &&
    !/\s$/.test(value) &&
    !/^(?:true|false|null|yes|no|on|off|~|-?\d+(?:\.\d+)?)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}

/** Fenced blocks in a language a shell or interpreter runs, or a shebang line. */
const RUNNABLE_CODE =
  /^\s*(?:`{3,}|~{3,})\s*(?:bash|sh|shell|zsh|fish|console|powershell|pwsh|ps1|cmd|bat|python3?|py|javascript|js|node|typescript|ts|ruby|rb|perl|php|applescript|osascript|lua|go|rust)\b|^#!/im;
const BUNDLED_REFERENCE = /\{baseDir\}|(?:^|[\s(`'"/])(?:scripts|references|templates|assets)\//m;

function skillWarnings(
  content: string,
  body: string,
  siblings: readonly string[],
): AgentImportSkill["warnings"] {
  const warnings: AgentImportSkill["warnings"] = [];
  const requirements = skillRequirements(frontmatter(content));
  if (requirements.names.length || requirements.otherPlatform) warnings.push("needs_setup");
  // A reference to files next to SKILL.md is a need on its own: a document export or an
  // incomplete backup has no sibling list at all. Listed siblings only add detail below.
  const bundled = BUNDLED_REFERENCE.test(body);
  if (bundled) warnings.push("bundled_files");
  const runsBundledScript = bundled && siblings.some((name) => name.startsWith("scripts/"));
  if (RUNNABLE_CODE.test(body) || runsBundledScript) warnings.push("runs_code");
  return warnings;
}

function frontmatter(content: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  try {
    const value: unknown = match ? parseYaml(match[1]!) : null;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** One status for the UI; the warnings keep the same facts for the server's checks. */
function skillAssessment(
  content: string,
  body: string,
  siblings: readonly string[],
): Pick<AgentImportSkill, "warnings" | "status"> {
  const warnings = skillWarnings(content, body, siblings);
  const requirements = skillRequirements(frontmatter(content));
  const needs: AgentImportNeed[] = [];
  if (requirements.names.length) needs.push({ kind: "requires", names: requirements.names });
  if (warnings.includes("bundled_files")) needs.push({ kind: "bundled_files" });
  const status: AgentImportSkill["status"] = requirements.otherPlatform
    ? { kind: "unsupported", reason: "other_platform" }
    : needs.length
      ? { kind: "needs_setup", needs }
      : warnings.includes("runs_code")
        ? { kind: "needs_review", reason: "runs_code" }
        : { kind: "ready" };
  return { warnings, status };
}

/**
 * OpenClaw `metadata.openclaw.requires`/`os`; Hermes `platforms`, `prerequisites`,
 * `required_environment_variables`, `metadata.hermes.requires_toolsets`. Rakazo runs skills
 * on Linux, so a platform list without it is another platform.
 */
function skillRequirements(front: Record<string, unknown>): {
  names: string[];
  otherPlatform: boolean;
} {
  const field = (value: unknown, key: string): unknown =>
    value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  const names = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap((entry) =>
          typeof entry === "string"
            ? [entry]
            : typeof field(entry, "name") === "string"
              ? [field(entry, "name") as string]
              : [],
        )
      : value && typeof value === "object"
        ? Object.keys(value)
        : typeof value === "string" && value.trim()
          ? [value.trim()]
          : [];
  const otherPlatform = (value: unknown) =>
    Array.isArray(value) &&
    value.length > 0 &&
    !value.some((entry) => String(entry).toLowerCase() === "linux");
  const metadata = field(front, "metadata");
  const openclaw = field(metadata, "openclaw");
  const requires = field(openclaw, "requires");
  const hermes = field(metadata, "hermes");
  const all = [
    ...["bins", "anyBins", "env", "config"].flatMap((key) => names(field(requires, key))),
    ...names(field(field(front, "prerequisites"), "commands")),
    ...names(front.required_environment_variables),
    ...names(field(hermes, "requires_toolsets")),
  ]
    .map((name) => name.trim())
    .filter(Boolean);
  return {
    names: [...new Set(all)],
    otherPlatform:
      otherPlatform(field(openclaw, "os")) ||
      otherPlatform(front.os) ||
      otherPlatform(front.platforms),
  };
}

const NAME_MAX_LENGTH = 80;

/** `value`, or `value-2`, `value-3`… before `extension`; adds the result to `used` (lowercase). */
export function freeName(value: string, used: Set<string>, extension: string): string {
  const hasExtension = extension && value.toLowerCase().endsWith(extension);
  const base = hasExtension ? value.slice(0, -extension.length) : value;
  const suffix = hasExtension ? value.slice(-extension.length) : "";
  let candidate = value;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
    const tail = `-${n}${suffix}`;
    candidate = `${base.slice(0, Math.max(1, NAME_MAX_LENGTH - tail.length))}${tail}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** A chosen folder or opened backup: its paths, and its files read on demand. */
export type AgentImportReader = {
  paths: string[];
  read: (path: string) => Promise<string> | string;
  size: (path: string) => number | undefined;
};
