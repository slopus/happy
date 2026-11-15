import type {
  AgentImportFile,
  AgentImportInstruction,
  AgentImportPlan,
  AgentImportSource,
} from "@rakazo/contracts";
import {
  AGENT_IMPORT_MAX_FILE_LENGTH,
  AGENT_IMPORT_MAX_FILES,
  AGENT_IMPORT_MAX_TOTAL_LENGTH,
  GROK_BOT_EXPORT_PATH,
} from "@rakazo/contracts";
import { AgentImportArchiveError } from "./archive.js";
import {
  AGENT_IMPORT_CONFIG_FILES,
  isAgentImportSecretFile,
  prepareAgentImportFiles,
} from "./config.js";
import { looksLikeCredential } from "./credentials.js";
import { isAgentDocument, parseAgentDocument } from "./document.js";
import type { GrokBot } from "./grok-bot.js";
import { parseGrokBot, readGrokBotExportJson } from "./grok-bot.js";
import {
  BUNDLED_MANIFEST,
  bundledSkillNames,
  HERMES_INSTRUCTION_FILES,
  HERMES_MEMORY_FILES,
  parseHermes,
} from "./hermes.js";
import {
  isOpenClawDailyMemory,
  OPENCLAW_INSTRUCTION_FILES,
  OPENCLAW_MEMORY_FILES,
  OPENCLAW_RUNTIME_FILES,
  parseOpenClaw,
} from "./openclaw.js";
import type { AgentImportParse, SkillFiles } from "./shared.js";
import { freeName, isPrivatePath, isSkillPath, renameSkillMd } from "./shared.js";

export {
  AGENT_IMPORT_ARCHIVE_LIMITS,
  AgentImportArchiveError,
  type AgentImportArchiveErrorReason,
  type AgentImportArchiveLimits,
  openAgentImportArchive,
  safeArchivePath,
} from "./archive.js";
export {
  AGENT_IMPORT_PROVIDER_KEYS,
  hasAgentImportSecrets,
  isAgentImportSecretFile,
  mcpServerImportable,
  normalizeImportProvider,
  parseDotEnv,
  prepareAgentImportFiles,
  readAgentImportConfig,
  stripAgentImportSecrets,
} from "./config.js";
export { looksLikeCredential } from "./credentials.js";
export { AGENT_IMPORT_PROMPT } from "./document.js";
export type { GrokBot, GrokBotExportErrorCode } from "./grok-bot.js";
export {
  GROK_BOT_EXPORT_PROMPT,
  GROK_BOT_REPLY_MAX_LENGTH,
  GrokBotExportError,
  grokBotExportJson,
  grokRoutineCron,
  grokSkillNames,
  parseGrokBotExport,
  readGrokBotExportJson,
} from "./grok-bot.js";
export { bundledSkillNames } from "./hermes.js";
export type { AgentImportReader, SkillFiles } from "./shared.js";
export { renameSkillMd } from "./shared.js";

export const AGENT_IMPORT_NOT_FOUND = "No OpenClaw, Hermes or agent document found.";

const WORKSPACE_FILES = new Set<string>([
  ...OPENCLAW_INSTRUCTION_FILES.map(([path]) => path),
  "IDENTITY.md",
  ...OPENCLAW_MEMORY_FILES,
  ...OPENCLAW_RUNTIME_FILES,
  ...HERMES_INSTRUCTION_FILES.map(([path]) => path),
  ...HERMES_MEMORY_FILES.map(([source]) => source),
]);
/** A path starting with one of these has no upload root. */
const SOURCE_FOLDERS = new Set(["skills", "memory", "memories", ".agents"]);
const WORKSPACE_FOLDER = /^workspace(?:-[^/]+)?$/;

/** Clients send only these paths, so unrelated files stay on the device. */
export function isAgentImportCandidate(path: string): boolean {
  if (AGENT_IMPORT_CONFIG_FILES.has(path)) return true;
  if (isPrivatePath(path)) return false;
  return WORKSPACE_FILES.has(path) || isOpenClawDailyMemory(path) || isSkillPath(path);
}

/** Files only an OpenClaw or Hermes agent keeps (AGENTS.md alone is common in projects). */
const AGENT_SIGNATURES = new Set([
  "openclaw.json",
  "SOUL.md",
  "IDENTITY.md",
  "HERMES.md",
  ".hermes.md",
]);

/** Decides from names alone, before anything is read or sent. */
export function isAgentHome(paths: readonly string[]): boolean {
  if (paths.some((path) => path.startsWith(".openclaw/") || path.startsWith(".hermes/"))) {
    return true;
  }
  const homes = [...agentImportFolder(paths).files.values()];
  return homes.some(
    (home) =>
      AGENT_SIGNATURES.has(home) ||
      home.startsWith("memories/") ||
      AGENT_SIGNATURES.has(home.split("/").slice(1).join("/")),
  );
}

/**
 * Maps upload paths to their path in the agent's workspace or home. Clients and the server
 * apply the same choice.
 *
 * Choosing the OpenClaw home (`~/.openclaw`) uses its `workspace/` folder (or the only
 * `workspace-<id>` folder when there is no `workspace/`) plus the managed skills in
 * `skills/` and the settings files at the home's root; workspace skills win over managed
 * ones with the same path, as in OpenClaw.
 */
export function agentImportFolder(
  paths: readonly string[],
  options: { bundledSkills?: ReadonlySet<string> } = {},
): {
  root: string;
  files: Map<string, string>;
} {
  // Hermes' own skills (named in skills/.bundled_manifest) are never read or sent.
  const bundled = options.bundledSkills;
  const candidate = (path: string) =>
    isAgentImportCandidate(path) && !(bundled && isBundledSkill(path, bundled));
  const first = paths[0]?.split("/")[0] ?? "";
  const shared =
    first && !SOURCE_FOLDERS.has(first) && paths.every((path) => path.startsWith(`${first}/`));
  const relative = paths.map(
    (path) => [path, shared ? path.slice(first.length + 1) : path] as const,
  );
  const root = shared ? first : "";
  const workspaces = new Set(
    relative.flatMap(([, path]) => {
      const [folder = "", ...rest] = path.split("/");
      return WORKSPACE_FOLDER.test(folder) && isAgentImportCandidate(rest.join("/"))
        ? [folder]
        : [];
    }),
  );
  const ownFiles = relative.some(
    ([, path]) => WORKSPACE_FILES.has(path) || path.startsWith("memories/"),
  );
  if (ownFiles || workspaces.size === 0) {
    return {
      root,
      files: new Map(relative.filter(([, path]) => candidate(path))),
    };
  }
  const workspace = workspaces.has("workspace")
    ? "workspace"
    : workspaces.size === 1
      ? [...workspaces][0]!
      : null;
  const files = new Map<string, string>();
  if (!workspace) return { root, files };
  for (const [path, inHome] of relative) {
    const inWorkspace = inHome.slice(workspace.length + 1);
    if (inHome.startsWith(`${workspace}/`) && candidate(inWorkspace)) {
      files.set(path, inWorkspace);
    }
  }
  const used = new Set(files.values());
  for (const [path, inHome] of relative) {
    const managedSkill = inHome.startsWith("skills/") && isSkillPath(inHome);
    if ((managedSkill || AGENT_IMPORT_CONFIG_FILES.has(inHome)) && !used.has(inHome)) {
      files.set(path, inHome);
    }
  }
  return { root: workspace, files };
}

/** Names only: those files are not imported, but show what a skill would be missing. */
export function agentImportSkillFiles(
  paths: readonly string[],
  used: ReadonlyMap<string, string>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [path, home] of used) {
    if (!home.endsWith("SKILL.md") || !isSkillPath(home)) continue;
    const folder = path.slice(0, -"SKILL.md".length);
    const names = paths
      .filter((other) => other !== path && other.startsWith(folder))
      .map((other) => other.slice(folder.length))
      .slice(0, 200);
    if (names.length) out[home] = names;
  }
  return out;
}

/** Applies the same secret stripping the browser applies before sending. */
export function readAgentImportFolder(
  files: AgentImportFile[],
  options: { includeSecrets: boolean },
): {
  source: Exclude<AgentImportSource, "document" | "template" | "grok_bot">;
  root: string;
  files: Map<string, string>;
} | null {
  const contents = new Map(files.map((file) => [file.path, file.content]));
  const folder = chooseFolder(
    files.map((file) => file.path),
    (path) => contents.get(path) ?? "",
  );
  const home = new Map<string, string>();
  for (const [path, inHome] of folder.files) home.set(inHome, contents.get(path) ?? "");
  const kept = prepareAgentImportFiles(home, options);
  const source = detectSource(new Set(kept.keys()), folder.root);
  return source ? { source, root: folder.root, files: kept } : null;
}

function isBundledSkill(path: string, bundled: ReadonlySet<string>): boolean {
  if (!isSkillPath(path)) return false;
  const folder = path.split("/").at(-2)?.toLowerCase() ?? "";
  return bundled.has(folder);
}

function chooseFolder(paths: readonly string[], read: (path: string) => string) {
  const first = agentImportFolder(paths);
  const manifest = [...first.files].find(([, home]) => home === BUNDLED_MANIFEST)?.[0];
  if (!manifest) return first;
  return agentImportFolder(paths, { bundledSkills: bundledSkillNames(read(manifest)) });
}

/**
 * The client's read of a folder or backup, matching the server's choice. Sizes are checked
 * before anything is read, and bundled skills and secret files are never read without need.
 */
export async function chooseAgentImportFiles(
  paths: readonly string[],
  read: (path: string) => Promise<string> | string,
  options: { includeSecrets: boolean; size?: (path: string) => number | undefined },
): Promise<{
  entries: { path: string; home: string; content: string }[];
  hasSecretFiles: boolean;
}> {
  const first = agentImportFolder(paths);
  const manifestPath = [...first.files].find(([, home]) => home === BUNDLED_MANIFEST)?.[0];
  if (manifestPath) checkSizes([manifestPath], options.size);
  const folder = manifestPath
    ? agentImportFolder(paths, { bundledSkills: bundledSkillNames(await read(manifestPath)) })
    : first;
  const all = [...folder.files];
  const hasSecretFiles = all.some(([, home]) => isAgentImportSecretFile(home));
  const wanted = all.filter(([, home]) => options.includeSecrets || !isAgentImportSecretFile(home));
  checkSizes(
    wanted.map(([path]) => path),
    options.size,
  );
  const entries = await Promise.all(
    wanted.map(async ([path, home]) => ({ path, home, content: await read(path) })),
  );
  return { entries, hasSecretFiles };
}

function checkSizes(paths: readonly string[], size?: (path: string) => number | undefined) {
  if (paths.length > AGENT_IMPORT_MAX_FILES) throw new AgentImportArchiveError("too_large");
  let total = 0;
  for (const path of paths) {
    // A character takes at least one byte, so a byte size bounds the text the server checks.
    const bytes = size?.(path) ?? 0;
    if (bytes > AGENT_IMPORT_MAX_FILE_LENGTH * 4) throw new AgentImportArchiveError("too_large");
    total += bytes;
  }
  if (total > AGENT_IMPORT_MAX_TOTAL_LENGTH * 4) throw new AgentImportArchiveError("too_large");
}

export function agentImportUpload(
  entries: readonly { path: string; home: string; content: string }[],
  options: { includeSecrets: boolean },
): AgentImportFile[] {
  const prepared = prepareAgentImportFiles(
    new Map(entries.map((entry) => [entry.home, entry.content])),
    options,
  );
  return entries.flatMap(({ path, home }) => {
    const content = prepared.get(home);
    return content === undefined ? [] : [{ path, content }];
  });
}

/**
 * Imported text is data: nothing here follows it. Settings (model, MCP servers, scheduled
 * jobs, API keys) are added by the server.
 */
export function parseAgentImport(
  files: AgentImportFile[],
  skillFiles: SkillFiles = {},
): AgentImportPlan | { error: string } {
  const only = files.length === 1 ? files[0] : undefined;
  if (only?.path === GROK_BOT_EXPORT_PATH) {
    let bots: GrokBot[];
    try {
      bots = readGrokBotExportJson(only.content);
    } catch {
      return { error: AGENT_IMPORT_NOT_FOUND };
    }
    // The client sends only the Bot the user picked.
    const [bot] = bots;
    if (!bot || bots.length !== 1) return { error: AGENT_IMPORT_NOT_FOUND };
    const parsed = parseGrokBot(bot);
    if (
      !parsed.instructions.length &&
      !parsed.memory.length &&
      !parsed.skills.length &&
      !bot.routines.length &&
      !bot.apps.length
    )
      return { error: AGENT_IMPORT_NOT_FOUND };
    return plan("grok_bot", parsed);
  }
  // A known agent file (SOUL.md, MEMORY.md, memories/…) is read as one even when its text
  // has the document's headings; only another file or the pasted reply is a document.
  if (only && !isKnownAgentFile(only.path) && isAgentDocument(only.content)) {
    return plan("document", parseAgentDocument(only.content));
  }
  const folder = readAgentImportFolder(files, { includeSecrets: false });
  if (!folder) return { error: AGENT_IMPORT_NOT_FOUND };
  const kept = [...folder.files].map(([path, content]) => ({ path, content }));
  const parsed =
    folder.source === "hermes"
      ? parseHermes(kept, skillFiles)
      : parseOpenClaw(kept, folder.root, skillFiles);
  if (!parsed.instructions.length && !parsed.memory.length && !parsed.skills.length) {
    return { error: AGENT_IMPORT_NOT_FOUND };
  }
  return plan(folder.source, parsed);
}

function isKnownAgentFile(path: string): boolean {
  const parts = path.split("/");
  return parts.some((_, index) => {
    const tail = parts.slice(index).join("/");
    return isAgentImportCandidate(tail) && !AGENT_IMPORT_CONFIG_FILES.has(tail);
  });
}

function plan(source: AgentImportSource, parsed: AgentImportParse): AgentImportPlan {
  // Key-looking text is flagged, never changed.
  const flag = <T extends { content: string; title: string; description?: string }>(item: T) =>
    [item.content, item.title, item.description ?? ""].some(looksLikeCredential)
      ? { ...item, containsKey: true }
      : item;
  return resolveAgentImportNames(
    {
      source,
      ...parsed,
      instructions: parsed.instructions.map(flag),
      memory: parsed.memory.map(flag),
      skills: parsed.skills.map(flag),
      model: null,
      mcpServers: [],
      routines: [],
      apiKeys: [],
    },
    { spaceMemoryPaths: [], skillNames: [] },
  );
}

function detectSource(
  paths: Set<string>,
  root: string,
): Exclude<AgentImportSource, "document" | "template" | "grok_bot"> | null {
  const has = (path: string) => paths.has(path);
  if (
    root === ".hermes" ||
    HERMES_MEMORY_FILES.some(([source]) => has(source)) ||
    has("HERMES.md") ||
    has(".hermes.md") ||
    has("config.yaml")
  ) {
    return "hermes";
  }
  return [...paths].some((path) => path.endsWith(".md")) ? "openclaw" : null;
}

export const IMPORTED_INSTRUCTION_HEADINGS = {
  persona: "Persona",
  working: "Working instructions",
} as const;

/**
 * Persona first, then working instructions, each under a heading only when both exist. A
 * title naming the file (`# SOUL.md - Who You Are`) is dropped: the bot has no such file.
 */
export function combineImportedInstructions(
  items: readonly Pick<AgentImportInstruction, "title" | "content" | "role">[],
): string {
  const text = (role: AgentImportInstruction["role"]) =>
    items
      .filter((item) => item.role === role)
      .map((item) => withoutFileTitle(item.title, item.content))
      .filter(Boolean)
      .join("\n\n");
  const persona = text("persona");
  const working = text("working");
  if (!persona || !working) return persona || working;
  return [
    `# ${IMPORTED_INSTRUCTION_HEADINGS.persona}`,
    persona,
    `# ${IMPORTED_INSTRUCTION_HEADINGS.working}`,
    working,
  ].join("\n\n");
}

function withoutFileTitle(file: string, content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === "\n") start += 1;
  while (end > start && normalized[end - 1] === "\n") end -= 1;
  const text = normalized.slice(start, end).trimEnd();
  if (!text.trim()) return "";
  const name = file.split("/").at(-1) ?? file;
  const first = text.split("\n", 1)[0] ?? "";
  if (name.endsWith(".md") && /^#\s/.test(first) && first.replace(/^#\s+/, "").startsWith(name)) {
    return text.slice(first.length).trim();
  }
  return text;
}

/**
 * Never overwrite: taken space memory paths and skill names (case-insensitive) get the first
 * free `-2`, `-3`, ... suffix. Bot memory keeps its paths.
 */
export function resolveAgentImportNames(
  plan: AgentImportPlan,
  taken: { spaceMemoryPaths: readonly string[]; skillNames: readonly string[] },
): AgentImportPlan {
  const paths = new Set(taken.spaceMemoryPaths.map((path) => path.toLowerCase()));
  const names = new Set(taken.skillNames.map((name) => name.trim().toLowerCase()));
  return {
    ...plan,
    memory: plan.memory.map((item) => ({ ...item, spacePath: freeName(item.path, paths, ".md") })),
    skills: plan.skills.map((item) => {
      const name = freeName(item.title, names, "");
      return name === item.name
        ? item
        : { ...item, name, content: renameSkillMd(item.content, name) };
    }),
  };
}
