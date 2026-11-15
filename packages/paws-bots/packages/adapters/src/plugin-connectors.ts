/** Portable plugin parsing plus a bounded, public-GitHub acquisition adapter.
 * No repository code is executed and no files are written to the host. */
import { createHash } from "node:crypto";
import type { PluginPreview } from "@rakazo/contracts";
import { McpServerConfigInput } from "@rakazo/contracts";
import { buildSkillMd, findSkillByName, parseSkillMd } from "@rakazo/core";
import { z } from "zod";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";
import { assertNoSensitiveQuery } from "./connector-http.js";
import { fetchSafeWebText } from "./web-ssrf.js";

export type PluginSourceRef = { gitUrl: string; ref?: string; subdir?: string };
export type PluginRepoFile = { path: string; content: string };
export type PluginRepoFetcher = (
  ref: PluginSourceRef,
  signal?: AbortSignal,
) => Promise<{ files: PluginRepoFile[]; resolvedSha: string }>;
export type PluginSkillEntry = {
  name: string;
  description: string;
  content: string;
  /** Text files beside SKILL.md, keyed by their path relative to the skill folder. */
  files?: Record<string, string>;
};
export type PluginMcpServerEntry = {
  name: string;
  transport: "streamable_http" | "sse";
  endpoint: string;
  headers: Record<string, string>;
};
export type PluginSkippedEntry = {
  kind:
    | "mcp_stdio"
    | "mcp_invalid"
    | "skill_invalid"
    | "editor_only"
    | "unsupported_transport"
    | "unsupported_field";
  name: string;
  reason: string;
};
export type ParsedPlugin = {
  format: "agent-plugins" | "cursor" | "grok";
  name: string;
  version: string | null;
  description: string;
  author: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
  keywords: string[];
  resolvedSha: string;
  digest: string;
  skills: PluginSkillEntry[];
  mcpServers: PluginMcpServerEntry[];
  skipped: PluginSkippedEntry[];
  /** Skills left out because a built-in skill has the same name. */
  builtinNames: string[];
};

/** Fetched component files; other paths are only listed. */
const MAX_FILES = 200;
const MAX_TREE_ENTRIES = 5000;
const FETCH_CONCURRENCY = 8;
const MAX_BYTES = 4_000_000;
const MAX_FILE_BYTES = 100_000;
const FULL_SHA = /^[a-f0-9]{40}$/;
const SCHEMAS = new Set([
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
]);
const MANIFESTS = ["plugin.json", ".cursor-plugin/plugin.json", ".grok-plugin/plugin.json"];
/** Parts that only run inside an editor or execute the plugin's own code on the host. */
const UNSUPPORTED_DIRS = new Set(["rules", "hooks", "automations"]);
const UNSUPPORTED_FILES = new Set([".lsp.json"]);
const AGENT_FILE = /^agents\/([^/]+)\.md$/;
const SKILL_COMPANION = /^skills\/[^/]+\/(?!SKILL\.md$).+/;
/** Reference docs a skill points to; scripts and binaries are not installed. */
const SKILL_TEXT_FILE = /\.(md|mdx|txt|json|ya?ml|csv)$/i;
export const MAX_SKILL_FILES = 40;
const OVERSIZED_FILE = "\u0000";
/** A link or submodule is never followed; a skill that contains one does not install. */
const UNREADABLE_FILE = "\u0001";
/** A whole component (skill folder, agent, command, MCP config or manifest) that is a link. */
const UNREADABLE_COMPONENT =
  /^(skills\/[^/]+|agents\/[^/]+|commands\/[^/]+|\.?mcp\.json|plugin\.json|\.[a-z-]+-plugin(\/plugin\.json)?)$/;
export const MAX_SKILL_FILES_BYTES = 400_000;
// Underscore files beside commands are shared notes, not commands of their own.
const COMMAND_FILE = /^commands\/([^/_][^/]*)\.md$/;
const manifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z
    .object({
      name: z.string().optional(),
      email: z.string().optional(),
      url: z.string().optional(),
    })
    .strict()
    .optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

function hasControlCharacters(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

function safePath(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("%") ||
    /[#?]/.test(path) ||
    path.split("/").some((p) => !p || p === "." || p === "..") ||
    hasControlCharacters(path)
  ) {
    throw new Error("Plugin paths must stay inside the plugin directory");
  }
  return path;
}

/** URL syntax: https://host/owner/repo[.git][@ref][#subdir].
 * GitHub's /tree/ref/subdir form is accepted for single-segment refs. */
export function parsePluginSource(source: string): PluginSourceRef {
  const input = source.trim();
  if (!input || input.length > 2048) throw new Error("Plugin source must be an HTTPS git URL");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Plugin source must be an HTTPS git URL");
  }
  if (url.protocol !== "https:") throw new Error("Plugin source must use HTTPS");
  if (url.username || url.password) throw new Error("Plugin source must not contain credentials");
  if (url.search || url.port)
    throw new Error("Plugin source must not contain a query or custom port");
  const subdirFromHash = url.hash.slice(1);
  url.hash = "";
  let path = url.pathname.replace(/\/$/, "");
  let ref: string | undefined;
  const at = path.indexOf("@");
  if (at >= 0) {
    ref = path.slice(at + 1);
    path = path.slice(0, at);
  }
  let subdir = subdirFromHash || undefined;
  const tree = /^\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/.exec(path);
  if (url.hostname === "github.com" && tree) {
    path = `/${tree[1]}/${tree[2]}`;
    ref ??= tree[3];
    subdir ??= tree[4];
  }
  path = path.replace(/\.git$/, "");
  if (
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) ||
    path.split("/").some((p) => p === "." || p === "..")
  ) {
    throw new Error("Plugin source must identify an owner and repository");
  }
  if (
    ref !== undefined &&
    (!ref ||
      ref.length > 200 ||
      ref.includes("..") ||
      /[%#?\\\s]/.test(ref) ||
      hasControlCharacters(ref))
  ) {
    throw new Error("Plugin ref is invalid");
  }
  if (subdir) safePath(subdir);
  url.pathname = url.hostname === "github.com" ? path.toLowerCase() : path;
  return { gitUrl: url.toString().replace(/\/$/, ""), ref, subdir };
}

/** Provider seam for deterministic tests. The default always uses the DNS-pinned,
 * redirect-checked web fetch with per-response byte limits. */
export type PluginTextReader = (
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
) => Promise<string>;
const readPublicText: PluginTextReader = async (url, maxBytes, signal) =>
  (await fetchSafeWebText(url, { maxBytes, signal })).body;

export async function fetchGitHubRepo(
  ref: PluginSourceRef,
  signal?: AbortSignal,
  read: PluginTextReader = readPublicText,
): ReturnType<PluginRepoFetcher> {
  const url = new URL(ref.gitUrl);
  if (url.hostname !== "github.com")
    throw new Error("Only public github.com plugin sources are supported right now");
  const repo = url.pathname;
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
  const commit = JSON.parse(
    await read(
      `https://api.github.com/repos${repo}/commits/${encodeURIComponent(ref.ref ?? "HEAD")}`,
      512_000,
      deadline,
    ),
  ) as { sha?: string; commit?: { tree?: { sha?: string } } };
  const sha = commit.sha;
  if (!sha || !FULL_SHA.test(sha)) throw new Error("Could not resolve plugin commit SHA");
  if (ref.ref && FULL_SHA.test(ref.ref) && ref.ref !== sha)
    throw new Error("Plugin commit SHA did not match the requested pin");
  const treeSha = commit.commit?.tree?.sha;
  if (!treeSha || !FULL_SHA.test(treeSha)) throw new Error("Could not resolve plugin tree");
  const tree = JSON.parse(
    await read(
      `https://api.github.com/repos${repo}/git/trees/${treeSha}?recursive=1`,
      MAX_BYTES,
      deadline,
    ),
  ) as {
    truncated?: boolean;
    tree?: Array<{ path: string; type: string; mode: string; size?: number }>;
  };
  if (tree.truncated || !Array.isArray(tree.tree))
    throw new Error("Plugin repository tree is incomplete");
  const prefix = ref.subdir ? `${ref.subdir}/` : "";
  const selected = tree.tree.filter((entry) => entry.path.startsWith(prefix));
  const files: PluginRepoFile[] = [];
  const entries = selected.filter((entry) => {
    safePath(entry.path.slice(prefix.length));
    if (entry.mode === "120000" || entry.type === "commit") {
      files.push({ path: entry.path, content: UNREADABLE_FILE });
      return false;
    }
    return entry.type === "blob";
  });
  if (entries.length > MAX_TREE_ENTRIES) throw new Error("Plugin directory has too many files");
  let total = 0;
  let fetched = 0;
  const wanted: string[] = [];
  for (const entry of entries) {
    const path = entry.path.slice(prefix.length);
    // Fetch only component text. Other paths are retained for skipped-part reporting.
    if (!isFetchedComponent(path)) {
      files.push({ path: entry.path, content: "" });
      continue;
    }
    // An oversized reference refuses only its own skill, not the whole plugin.
    if (SKILL_COMPANION.test(path) && (entry.size ?? 0) > MAX_FILE_BYTES) {
      files.push({ path: entry.path, content: OVERSIZED_FILE });
      continue;
    }
    if ((entry.size ?? 0) > MAX_FILE_BYTES) throw new Error("Plugin file is too large");
    if (++fetched > MAX_FILES) throw new Error("Plugin directory has too many files");
    wanted.push(entry.path);
  }
  const queue = [...wanted];
  await Promise.all(
    Array.from({ length: FETCH_CONCURRENCY }, async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        const body = await read(
          `https://raw.githubusercontent.com${repo}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`,
          MAX_FILE_BYTES,
          deadline,
        );
        total += Buffer.byteLength(body);
        if (total > MAX_BYTES) throw new Error("Plugin content is too large");
        files.push({ path, content: body });
      }
    }),
  );
  // Parallel downloads finish in any order; parsing must not depend on it.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, resolvedSha: sha };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function companionRefusal(companions: Array<[string, string]>): string | null {
  if (companions.some(([path]) => !SKILL_TEXT_FILE.test(path)))
    return "Skills with scripts or other non-text files are not supported";
  if (companions.length > MAX_SKILL_FILES) return "Skill has too many files";
  if (companions.some(([, text]) => text === UNREADABLE_FILE))
    return "Skills with links or submodules are not supported";
  if (companions.some(([, text]) => text === OVERSIZED_FILE)) return "Skill files are too large";
  const bytes = companions.reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0);
  if (bytes > MAX_SKILL_FILES_BYTES) return "Skill files are too large";
  return null;
}

function collectSkills(
  files: Map<string, string>,
  skipped: PluginSkippedEntry[],
  names: Set<string>,
): PluginSkillEntry[] {
  const skills: PluginSkillEntry[] = [];
  for (const [path, content] of files) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (!match) continue;
    const parsed = parseSkillMd(content);
    if ("error" in parsed) {
      skipped.push({ kind: "skill_invalid", name: path, reason: parsed.error });
      continue;
    }
    if (names.has(parsed.name.toLowerCase()))
      throw new Error("Plugin contains duplicate skill names");
    const folder = `skills/${match[1]}/`;
    const companions = [...files].filter(([p]) => p.startsWith(folder) && p !== path);
    const refusal = companionRefusal(companions.map(([p, text]) => [p.slice(folder.length), text]));
    // A recipe whose scripts would be missing must not install half-working.
    if (refusal) {
      skipped.push({ kind: "skill_invalid", name: parsed.name, reason: refusal });
      continue;
    }
    names.add(parsed.name.toLowerCase());
    skills.push({
      name: parsed.name,
      description: parsed.description,
      content,
      ...(companions.length
        ? {
            files: Object.fromEntries(
              companions.map(([p, text]) => [p.slice(folder.length), text]),
            ),
          }
        : {}),
    });
  }
  return skills;
}

/** A sub-agent becomes a skill that hands its task to `run_subagent` with the agent's
 * own instructions, so the plugin's skills can still delegate to it by name. */
function collectAgents(
  files: Map<string, string>,
  skipped: PluginSkippedEntry[],
  names: Set<string>,
): PluginSkillEntry[] {
  const out: PluginSkillEntry[] = [];
  for (const [path, content] of files) {
    if (!AGENT_FILE.test(path)) continue;
    const parsed = parseSkillMd(content);
    if ("error" in parsed) {
      skipped.push({ kind: "skill_invalid", name: path, reason: parsed.error });
      continue;
    }
    if (names.has(parsed.name.toLowerCase())) continue;
    names.add(parsed.name.toLowerCase());
    out.push({
      name: parsed.name,
      description: parsed.description,
      content: buildSkillMd({
        name: parsed.name,
        description: parsed.description,
        body: `Run this as a helper: call run_subagent with name "${parsed.name}", the task to do, and everything below as its instructions.\n\n${parsed.body}`,
      }),
    });
  }
  return out;
}

/** Slash commands are prompt templates, which is what a skill invoked with /name already is. */
function collectCommands(
  files: Map<string, string>,
  names: Set<string>,
  skipped: PluginSkippedEntry[],
): PluginSkillEntry[] {
  const out: PluginSkillEntry[] = [];
  for (const [path, content] of files) {
    const name = COMMAND_FILE.exec(path)?.[1];
    // A command named like one of the plugin's skills repeats it.
    if (!name || names.has(name.toLowerCase())) continue;
    const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
    const parsed = front
      ? parseSkillMd(`---\nname: ${name}\n${front[1]}\n---\n${content.slice(front[0].length)}`)
      : null;
    const body = parsed && !("error" in parsed) ? parsed.body : content;
    const firstLine = body
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean);
    const description =
      (parsed && !("error" in parsed) ? parsed.description : "") || firstLine || name;
    let skill: string;
    try {
      skill = buildSkillMd({
        name,
        description: description.slice(0, 2000),
        body: body.includes("$ARGUMENTS")
          ? `$ARGUMENTS is whatever the user wrote after /${name}.\n\n${body}`
          : body,
      });
    } catch (error) {
      skipped.push({
        kind: "skill_invalid",
        name: path,
        reason: error instanceof Error ? error.message : "Invalid command",
      });
      continue;
    }
    names.add(name.toLowerCase());
    out.push({ name, description: description.slice(0, 2000), content: skill });
  }
  return out;
}

/** Domains of the apps that publish plugin catalogs. Their relays authorize only their own
 * app's accounts and OAuth clients, as do headers named for them. */
const CATALOG_VENDOR_DOMAINS = ["cursor.com", "cursor.sh", "grok.com", "x.ai"];
const CATALOG_VENDOR_HEADER = /^x-(cursor|grok|xai)-/i;

/** A server on a catalog vendor's domain, or one that sends that vendor's headers. An `auth`
 * block (handled by the caller) pins an OAuth client registered to the vendor's app, whose
 * redirect URIs are that app's. */
function catalogVendorOnly(endpoint: string, headers: Record<string, string>): boolean {
  const host = new URL(endpoint).hostname.replace(/\.$/, "");
  return (
    CATALOG_VENDOR_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`)) ||
    Object.keys(headers).some((key) => CATALOG_VENDOR_HEADER.test(key))
  );
}

function collectMcpServers(
  files: Map<string, string>,
  schema: string | undefined,
  skipped: PluginSkippedEntry[],
): PluginMcpServerEntry[] {
  const path = schema ? "mcp.json" : files.has("mcp.json") ? "mcp.json" : ".mcp.json";
  const raw = files.get(path);
  if (raw === undefined) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    doc = null;
  }
  if (
    !object(doc) ||
    !object(doc.mcpServers) ||
    (schema &&
      (doc.$schema !== schema.replace("plugin.schema.json", "mcp.schema.json") ||
        Object.keys(doc).some((key) => !["$schema", "mcpServers"].includes(key))))
  ) {
    skipped.push({
      kind: "mcp_invalid",
      name: path,
      reason: "Invalid or mismatched MCP configuration",
    });
    return [];
  }
  const out: PluginMcpServerEntry[] = [];
  for (const [name, entry] of Object.entries(doc.mcpServers)) {
    if (!object(entry)) {
      skipped.push({ kind: "mcp_invalid", name, reason: "Server must be an object" });
      continue;
    }
    const type = entry.type ?? (!schema && entry.command ? "stdio" : undefined);
    if (type === "stdio") {
      skipped.push({ kind: "mcp_stdio", name, reason: "Local MCP execution is disabled" });
      continue;
    }
    if (!["streamable-http", "sse", ...(!schema ? ["http"] : [])].includes(String(type))) {
      skipped.push({ kind: "unsupported_transport", name, reason: "Unsupported MCP transport" });
      continue;
    }
    if (schema && Object.keys(entry).some((key) => !["type", "url", "headers"].includes(key))) {
      skipped.push({ kind: "mcp_invalid", name, reason: "Unknown MCP server field" });
      continue;
    }
    const transport = type === "sse" ? "sse" : "streamable_http";
    const config = McpServerConfigInput.safeParse({
      slug: "plugin-server",
      name: "Plugin server",
      transport,
      endpoint: entry.url,
      headers: entry.headers ?? {},
    });
    // Variables in remote config are not part of Agent Plugins core. Legacy
    // prompting is a later slice; never install unresolved credential templates.
    if (
      !config.success ||
      !("endpoint" in config.data) ||
      /\$\{/.test(JSON.stringify(entry)) ||
      typeof entry.url !== "string" ||
      !entry.url.startsWith("https://")
    ) {
      skipped.push({
        kind: "mcp_invalid",
        name,
        reason: "Invalid endpoint/headers or unresolved credential placeholders",
      });
      continue;
    }
    try {
      assertNoSensitiveQuery(config.data.endpoint);
      const names = Object.keys(config.data.headers).map((key) => key.toLowerCase());
      if (new Set(names).size !== names.length) throw new Error("Duplicate headers");
      new Headers(config.data.headers);
    } catch {
      skipped.push({
        kind: "mcp_invalid",
        name,
        reason: "Unsafe endpoint query or invalid headers",
      });
      continue;
    }
    if ("auth" in entry || catalogVendorOnly(config.data.endpoint, config.data.headers)) {
      skipped.push({ kind: "mcp_invalid", name, reason: "Works only in the catalog's own app" });
      continue;
    }
    out.push({ name, transport, endpoint: config.data.endpoint, headers: config.data.headers });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Pure parser; inputs are regular-file content already constrained by acquisition. */
export function parsePluginDirectory(input: {
  files: PluginRepoFile[];
  resolvedSha: string;
}): ParsedPlugin {
  if (!FULL_SHA.test(input.resolvedSha))
    throw new Error("Plugin requires a full resolved commit SHA");
  if (input.files.length > MAX_TREE_ENTRIES) throw new Error("Plugin directory has too many files");
  const files = new Map<string, string>();
  let bytes = 0;
  for (const file of input.files) {
    const path = safePath(file.path);
    bytes += Buffer.byteLength(file.content);
    if (Buffer.byteLength(file.content) > MAX_FILE_BYTES || bytes > MAX_BYTES)
      throw new Error("Plugin content is too large");
    if (files.has(path)) throw new Error("Plugin contains duplicate file paths");
    files.set(path, file.content);
  }
  const manifestPath = MANIFESTS.find((path) => files.has(path));
  if (!manifestPath) throw new Error("No plugin manifest found");
  const raw: unknown = JSON.parse(files.get(manifestPath) ?? "");
  if (!object(raw)) throw new Error("Plugin manifest must be an object");
  const format =
    manifestPath === "plugin.json"
      ? "agent-plugins"
      : manifestPath.startsWith(".cursor")
        ? "cursor"
        : "grok";
  const schema = format === "agent-plugins" ? raw.$schema : undefined;
  if (format === "agent-plugins" && (typeof schema !== "string" || !SCHEMAS.has(schema)))
    throw new Error("Unsupported Agent Plugins schema");
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Plugin manifest has invalid metadata or name");
  const manifest = parsed.data;
  const skipped: PluginSkippedEntry[] = [];
  if (schema) {
    for (const key of Object.keys(raw)) {
      if (!["$schema", "extensions", ...Object.keys(manifestSchema.shape)].includes(key)) {
        skipped.push({
          kind: "unsupported_field",
          name: key,
          reason: "Unknown manifest field ignored",
        });
      }
    }
  }
  for (const name of unsupportedParts([...files.keys()]))
    skipped.push({ kind: "editor_only", name, reason: "Runs only inside an editor" });
  for (const [path, content] of files)
    if (content === UNREADABLE_FILE && UNREADABLE_COMPONENT.test(path))
      skipped.push({
        kind: "skill_invalid",
        name: path,
        reason: "Links and submodules are not supported",
      });
  const names = new Set<string>();
  const skills: PluginSkillEntry[] = [];
  const builtinNames: string[] = [];
  for (const skill of [
    ...collectSkills(files, skipped, names),
    ...collectAgents(files, skipped, names),
    ...collectCommands(files, names, skipped),
  ]) {
    // A skill named like a built-in one repeats it; every user already has the built-in.
    if (findSkillByName(BUILTIN_AGENT_SKILLS, skill.name)) builtinNames.push(skill.name);
    else skills.push(skill);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  const canonical = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    format,
    name: manifest.name,
    version: manifest.version ?? null,
    description: manifest.description ?? "",
    author: manifest.author?.name ?? null,
    homepage: manifest.homepage ?? null,
    repository: manifest.repository ?? null,
    license: manifest.license ?? null,
    keywords: manifest.keywords ?? [],
    resolvedSha: input.resolvedSha,
    digest: `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`,
    skills,
    mcpServers: collectMcpServers(files, typeof schema === "string" ? schema : undefined, skipped),
    skipped,
    builtinNames,
  };
}

function unsupportedParts(paths: string[]): string[] {
  const parts = new Set<string>();
  for (const path of paths) {
    const first = path.split("/")[0] ?? "";
    if (UNSUPPORTED_DIRS.has(first)) parts.add(`${first}/`);
    if (UNSUPPORTED_FILES.has(path)) parts.add(path);
  }
  return [...parts].sort();
}

export type PluginCompleteness = { hasConnector: boolean; skillCount: number };

/** Decide from a plugin directory's file list (and its MCP config, when it has one)
 * whether every part installs. Null means it cannot be told without the file. */
/** `sizes` (bytes by path, when known) applies the same reference-file limits an install does. */
/** The files a preview downloads; everything else is only listed. */
function isFetchedComponent(path: string): boolean {
  return (
    MANIFESTS.includes(path) ||
    ["mcp.json", ".mcp.json"].includes(path) ||
    /^skills\/[^/]+\/SKILL\.md$/.test(path) ||
    (SKILL_COMPANION.test(path) && SKILL_TEXT_FILE.test(path)) ||
    AGENT_FILE.test(path) ||
    COMMAND_FILE.test(path)
  );
}

export function classifyPluginFiles(
  paths: string[],
  mcpConfig?: string,
  sizes?: ReadonlyMap<string, number>,
): PluginCompleteness | "incomplete" | null {
  if (unsupportedParts(paths).length) return "incomplete";
  // The same totals a preview enforces, so browse never offers a plugin it would refuse.
  const fetched = paths.filter(isFetchedComponent);
  if (
    paths.length > MAX_TREE_ENTRIES ||
    fetched.length > MAX_FILES ||
    fetched.reduce((sum, path) => sum + (sizes?.get(path) ?? 0), 0) > MAX_BYTES
  )
    return "incomplete";
  const skillDirs = new Map<string, string[]>();
  let skillCount = 0;
  for (const path of paths) {
    const skill = /^skills\/([^/]+)\/(.+)$/.exec(path);
    if (skill) skillDirs.set(skill[1]!, [...(skillDirs.get(skill[1]!) ?? []), skill[2]!]);
    if (AGENT_FILE.test(path) || COMMAND_FILE.test(path)) skillCount++;
  }
  for (const [dir, files] of skillDirs) {
    if (!files.includes("SKILL.md")) return "incomplete";
    const companions = files.filter((file) => file !== "SKILL.md");
    if (companions.length > MAX_SKILL_FILES || companions.some((f) => !SKILL_TEXT_FILE.test(f)))
      return "incomplete";
    const bytes = companions.map((file) => sizes?.get(`skills/${dir}/${file}`) ?? 0);
    if (
      bytes.some((size) => size > MAX_FILE_BYTES) ||
      bytes.reduce((sum, size) => sum + size, 0) > MAX_SKILL_FILES_BYTES
    )
      return "incomplete";
    skillCount++;
  }
  const mcpPath = paths.find((path) => path === "mcp.json" || path === ".mcp.json");
  let servers = 0;
  if (mcpPath) {
    if (mcpConfig === undefined) return null;
    const skipped: PluginSkippedEntry[] = [];
    servers = collectMcpServers(new Map([[mcpPath, mcpConfig]]), undefined, skipped).length;
    if (skipped.length) return "incomplete";
  }
  if (!servers && !skillCount) return "incomplete";
  return { hasConnector: servers > 0, skillCount };
}

export async function previewPluginInstall(options: {
  source: string;
  signal?: AbortSignal;
  fetcher?: PluginRepoFetcher;
}): Promise<ParsedPlugin & { source: PluginSourceRef }> {
  const source = parsePluginSource(options.source);
  const repo = await (options.fetcher ?? fetchGitHubRepo)(source, options.signal);
  if (source.ref && FULL_SHA.test(source.ref) && source.ref !== repo.resolvedSha) {
    throw new Error("Plugin commit SHA did not match the requested pin");
  }
  const prefix = source.subdir ? `${source.subdir}/` : "";
  const files = repo.files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({
      path: file.path.slice(prefix.length),
      content: file.content,
    }));
  if (source.subdir && !files.length)
    throw new Error(`Plugin subdirectory "${source.subdir}" not found`);
  return { ...parsePluginDirectory({ files, resolvedSha: repo.resolvedSha }), source };
}

/** Public preview deliberately excludes skill bodies and all header values. */
export function pluginPreviewDto(plugin: ParsedPlugin): PluginPreview {
  return {
    format: plugin.format,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    author: plugin.author,
    homepage: plugin.homepage,
    repository: plugin.repository,
    license: plugin.license,
    keywords: plugin.keywords,
    resolvedSha: plugin.resolvedSha,
    digest: plugin.digest,
    skipped: plugin.skipped,
    builtinNames: plugin.builtinNames,
    skills: plugin.skills.map(({ name, description, files }) => ({
      name,
      description,
      ...(files ? { files: Object.keys(files).sort() } : {}),
    })),
    mcpServers: plugin.mcpServers.map(({ name, transport, endpoint, headers }) => ({
      name,
      transport,
      endpoint,
      staticHeaderKeys: Object.keys(headers),
    })),
  };
}

/** Timeouts, aborts, rate limits and server errors say nothing about the plugin itself. */
export function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  return /HTTP (408|429|5\d\d)|fetch failed|timed? ?out|aborted|ECONN|ENOTFOUND|EAI_AGAIN/i.test(
    error.message,
  );
}
