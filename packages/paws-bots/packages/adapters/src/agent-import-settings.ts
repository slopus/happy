import type {
  AgentImportNeed,
  AgentImportStatus,
  AgentImportWarning,
  McpServerConfigInput,
} from "@rakazo/contracts";
import {
  AGENT_IMPORT_MAX_FILE_LENGTH,
  isValidTimeZone,
  McpServerConfigInput as McpServerConfigSchema,
} from "@rakazo/contracts";
import type { GrokBot } from "@rakazo/core";
import {
  AGENT_IMPORT_PROVIDER_KEYS,
  grokRoutineCron,
  grokSkillNames,
  looksLikeCredential,
  mcpServerImportable,
  nextCronDateAcrossStrict,
  normalizeImportProvider,
  parseDotEnv,
  readAgentImportConfig,
} from "@rakazo/core";
import { isCatalogProviderBaseUrl, listPiCatalog } from "./pi-models.js";

/**
 * Translates OpenClaw and Hermes settings (model, MCP servers, scheduled jobs, API keys)
 * into Rakazo's inputs. Mirrors what `hermes import-agent openclaw` and `openclaw migrate
 * hermes` carry over, plus scheduled jobs, which those tools only archive.
 */

type Json = Record<string, unknown>;
type Skipped = {
  path: string;
  reason: "builtin" | "unsupported" | "invalid_file" | "reconnect";
};

export type ImportedModel = {
  title: string;
  provider: string;
  /** The provider as model settings name it. */
  providerName: string;
  modelId: string;
  known: boolean;
};
export type ImportedMcpServer = {
  id: string;
  title: string;
  content: string;
  config: McpServerConfigInput;
  warnings: AgentImportWarning[];
  status: AgentImportStatus;
};
export type ImportedRoutine = {
  id: string;
  title: string;
  content: string;
  name: string;
  prompt: string;
  cron: string;
  /** The job's own IANA timezone, when it has one. */
  timezone: string | null;
  warnings: AgentImportWarning[];
};
export type ImportedApiKey = { id: string; provider: string; title: string; source: string };
export type AgentImportSettings = {
  model: ImportedModel | null;
  mcpServers: ImportedMcpServer[];
  routines: ImportedRoutine[];
  apiKeys: ImportedApiKey[];
  skipped: Skipped[];
};

export { normalizeImportProvider, parseDotEnv };

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * Reads the settings of an OpenClaw home or Hermes home. Key values are only read with
 * `includeSecrets`; they are returned separately and never put in a preview.
 */
export function readAgentImportSettings(
  folder: { source: "openclaw" | "hermes"; root: string; files: Map<string, string> },
  options: {
    includeSecrets: boolean;
    stdioAllowed?: (command: string) => boolean;
  },
): AgentImportSettings & { keyValues: Map<string, string> } {
  const env = options.includeSecrets ? parseDotEnv(folder.files.get(".env") ?? "") : {};
  const configPath = folder.source === "hermes" ? "config.yaml" : "openclaw.json";
  const rawConfig = folder.files.get(configPath);
  const parsedConfig =
    rawConfig === undefined ? null : readAgentImportConfig(configPath, rawConfig);
  const config = parsedConfig ?? {};
  const resolve = (value: unknown) => resolveSecret(value, env);
  const skipped: Skipped[] = [];
  if (rawConfig !== undefined && !parsedConfig)
    skipped.push({ path: configPath, reason: "invalid_file" });

  const model =
    folder.source === "hermes" ? hermesModel(config) : openClawModel(config, folder.root);

  const mcpServers: ImportedMcpServer[] = [];
  const servers =
    folder.source === "hermes" ? config.mcp_servers : (config.mcp as Json | undefined)?.servers;
  for (const [name, entry] of Object.entries(isObject(servers) ? servers : {})) {
    const server = mcpServer(name, entry, options.stdioAllowed ?? (() => true));
    if (server) mcpServers.push({ ...server, id: `mcp:${name}` });
    else skipped.push({ path: `${configPath}: ${name}`, reason: "unsupported" });
  }

  const routines: ImportedRoutine[] = [];
  const jobsFile = folder.files.get("cron/jobs.json");
  const jobs = jobsFile ? readAgentImportConfig("cron/jobs.json", jobsFile)?.jobs : undefined;
  if (jobsFile !== undefined && !Array.isArray(jobs)) {
    skipped.push({ path: "cron/jobs.json", reason: "invalid_file" });
  }
  const agentId = openClawAgentId(folder.root);
  for (const [index, job] of (Array.isArray(jobs) ? jobs : []).entries()) {
    if (!isObject(job)) continue;
    // A job bound to another OpenClaw agent belongs to that agent's import.
    if (text(job.agentId) && text(job.agentId) !== agentId) continue;
    const result = folder.source === "hermes" ? hermesJob(job) : openClawJob(job);
    const label = `cron/jobs.json: ${text(job.name) || text(job.id) || index + 1}`;
    if ("reason" in result) skipped.push({ path: label, reason: result.reason });
    else routines.push({ ...result, id: `routine:${text(job.id) || index}` });
  }

  const keyValues = new Map<string, string>();
  const apiKeys: ImportedApiKey[] = [];
  if (options.includeSecrets) {
    const providers = new Map(listPiCatalog().map((entry) => [entry.provider, entry.providerName]));
    const configured = providerConfigs(folder.source, config);
    // A key for a proxy or gateway must never be checked against, or sent to, the provider,
    // wherever the key itself comes from.
    const proxied = new Set(
      configured.flatMap(([provider, { baseUrl }]) => {
        const id = normalizeImportProvider(provider);
        return text(baseUrl) && !isCatalogProviderBaseUrl(id, text(baseUrl)) ? [id] : [];
      }),
    );
    const offer = (provider: string, value: unknown, source: string, baseUrl?: unknown) => {
      const id = normalizeImportProvider(provider);
      const key = resolve(value);
      if (!key || !providers.has(id) || keyValues.has(id) || proxied.has(id)) return;
      if (text(baseUrl) && !isCatalogProviderBaseUrl(id, text(baseUrl))) return;
      keyValues.set(id, key);
      apiKeys.push({ id: `key:${id}`, provider: id, title: providers.get(id) ?? id, source });
    };
    for (const [provider, entry] of configured) {
      offer(provider, entry.key, configPath, entry.baseUrl);
    }
    if (folder.source === "hermes") {
      const auth = readAgentImportConfig("auth.json", folder.files.get("auth.json") ?? "") ?? {};
      const pool = isObject(auth.credential_pool) ? auth.credential_pool : {};
      for (const [provider, entries] of Object.entries(pool)) {
        for (const entry of Array.isArray(entries) ? entries : []) {
          // OAuth grants are never imported; only keys the user entered by hand.
          if (isObject(entry) && entry.auth_type === "api_key" && entry.source === "manual") {
            offer(provider, entry.access_token, "auth.json");
          }
        }
      }
    }
    const envVars = folder.source === "openclaw" ? openClawEnv(config) : {};
    for (const vars of [envVars, env] as Record<string, unknown>[]) {
      for (const [name, value] of Object.entries(vars)) {
        const provider = AGENT_IMPORT_PROVIDER_KEYS[name];
        if (provider) offer(provider, value, name, vars[name.replace(/_API_KEY$/, "_BASE_URL")]);
      }
    }
  }

  return { model, mcpServers, routines, apiKeys, skipped, keyValues };
}

/** A path segment this long and mixed reads as a key: the address would carry it. */
const KEY_LIKE_SEGMENT = /^(?=.*\d)(?=.*[a-zA-Z])[A-Za-z0-9_-]{24,}$/;

/**
 * A Grok Bot's routines and connected apps, from the export it wrote. It has no model to
 * choose and the export never holds keys. Routines on an event stay in its memory note.
 */
export function readGrokBotImportSettings(
  bot: GrokBot,
): AgentImportSettings & { keyValues: Map<string, string> } {
  const skipped: Skipped[] = [];
  const skillNames = grokSkillNames(bot);
  const routines: ImportedRoutine[] = [];
  for (const [index, source] of bot.routines.entries()) {
    const safeLabel = looksLikeCredential(source.name)
      ? String(index + 1)
      : source.name || String(index + 1);
    // A routine the Bot could not read in full is named, so the user knows it was left behind.
    if (!source.instruction) {
      skipped.push({ path: `routines: ${safeLabel}`, reason: "unsupported" });
      continue;
    }
    const cron = grokRoutineCron(source);
    if (!cron) continue;
    if ([source.name, source.instruction, source.details, source.when].some(looksLikeCredential)) {
      skipped.push({ path: `routines: ${safeLabel}`, reason: "unsupported" });
      continue;
    }
    const uses = source.skills.flatMap((name) => skillNames.get(name.toLowerCase()) ?? []);
    const instruction = [source.instruction, source.details, source.when]
      .filter(Boolean)
      .join("\n\n");
    if (instruction.length > AGENT_IMPORT_MAX_FILE_LENGTH) {
      skipped.push({ path: `routines: ${safeLabel}`, reason: "unsupported" });
      continue;
    }
    const prompt = uses.length
      ? `${instruction}\n\nUse these skills: ${uses.map((name) => `@${name}`).join(", ")}.`
      : instruction;
    const result = routine({ name: source.name }, prompt, cron, source.timeZone, false, false);
    if ("reason" in result) {
      skipped.push({ path: `routines: ${safeLabel}`, reason: result.reason });
    } else {
      routines.push({ ...result, id: `routine:${index}` });
    }
  }

  const mcpServers: ImportedMcpServer[] = [];
  for (const [index, app] of bot.apps.entries()) {
    // A name or header name with a key in it never becomes server settings or preview text.
    if ([app.name, ...app.headerNames].some(looksLikeCredential)) {
      skipped.push({ path: `apps: ${index + 1}`, reason: "unsupported" });
      continue;
    }
    const path = `apps: ${app.name}`;
    if (!app.mcpUrl) {
      skipped.push({ path, reason: "reconnect" });
      continue;
    }
    let url: URL | null = null;
    try {
      url = new URL(app.mcpUrl);
      if (
        [...url.hostname.split("."), ...decodeURIComponent(url.pathname).split("/")].some((part) =>
          KEY_LIKE_SEGMENT.test(part),
        )
      )
        url = null;
    } catch {
      url = null;
    }
    // Only a remote address that carries no key can come over.
    const server =
      url?.protocol === "https:" &&
      ["", "sse", "http", "streamable_http", "streamable-http"].includes(app.transport) &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      !looksLikeCredential(app.mcpUrl)
        ? mcpServer(
            app.name,
            {
              url: app.mcpUrl,
              transport: app.transport,
              headers: Object.fromEntries(app.headerNames.map((name) => [name, ""])),
            },
            () => false,
          )
        : null;
    if (server) mcpServers.push({ ...server, id: `mcp:${index}` });
    else skipped.push({ path, reason: "unsupported" });
  }

  return { model: null, mcpServers, routines, apiKeys: [], skipped, keyValues: new Map() };
}

/**
 * A credential value: a literal, `${VAR}` templates or an env SecretRef, all resolved against
 * the uploaded `.env` only. File, exec and store references cannot be read here.
 */
function resolveSecret(value: unknown, env: Record<string, string>): string | null {
  if (isObject(value)) {
    return value.source === "env" && typeof value.id === "string" ? (env[value.id] ?? null) : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  let missing = false;
  const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const found = env[name];
    if (found === undefined) missing = true;
    return found ?? "";
  });
  return missing || !resolved.trim() ? null : resolved;
}

type ProviderKey = { key: unknown; baseUrl?: unknown };

/** Every provider entry with a key or a base URL, in the order its keys are preferred. */
function providerConfigs(source: "openclaw" | "hermes", config: Json): [string, ProviderKey][] {
  const entry = (provider: unknown, key: unknown, baseUrl: unknown): [string, ProviderKey][] =>
    text(provider) && (key !== undefined || text(baseUrl))
      ? [[text(provider), { key, baseUrl }]]
      : [];
  if (source === "openclaw") {
    const models = isObject(config.models) ? config.models : {};
    const providers = isObject(models.providers) ? models.providers : {};
    return Object.entries(providers).flatMap(([id, value]) =>
      isObject(value) ? entry(id, value.apiKey, value.baseUrl) : [],
    );
  }
  const model = isObject(config.model) ? config.model : {};
  return [
    ...entry(model.provider, model.api_key, model.base_url),
    ...Object.entries(isObject(config.providers) ? config.providers : {}).flatMap(
      ([name, value]) => (isObject(value) ? entry(name, value.api_key, value.base_url) : []),
    ),
    ...(Array.isArray(config.custom_providers) ? config.custom_providers : []).flatMap((value) =>
      isObject(value) ? entry(value.name, value.api_key, value.base_url) : [],
    ),
  ];
}

/** OpenClaw `env.vars` and plain string entries directly under `env`. */
function openClawEnv(config: Json): Record<string, unknown> {
  const env = isObject(config.env) ? config.env : {};
  const vars = isObject(env.vars) ? env.vars : {};
  const direct = Object.entries(env).filter(([, value]) => typeof value === "string");
  return { ...Object.fromEntries(direct), ...vars };
}

function catalogModel(title: string, provider: string, modelId: string): ImportedModel {
  const id = normalizeImportProvider(provider);
  const catalog = listPiCatalog();
  const known = catalog.some((entry) => entry.provider === id && entry.id === modelId);
  const providerName = catalog.find((entry) => entry.provider === id)?.providerName ?? id;
  return { title, provider: id, providerName, modelId, known };
}

/** The chosen agent's model: its own entry overrides `agents.defaults.model`. */
function openClawModel(config: Json, root: string): ImportedModel | null {
  const agents = isObject(config.agents) ? config.agents : {};
  const agentId = openClawAgentId(root);
  const entries = [
    ...Object.entries(isObject(agents.entries) ? agents.entries : {}).map(([id, entry]) => ({
      id,
      ...(isObject(entry) ? entry : {}),
    })),
    ...(Array.isArray(agents.list) ? agents.list.filter(isObject) : []),
  ] as Json[];
  const own = entries.find(
    (entry) =>
      entry.id === agentId ||
      (typeof entry.workspace === "string" && folderName(entry.workspace) === root),
  );
  const defaults = isObject(agents.defaults) ? agents.defaults : {};
  const value = own?.model ?? defaults.model;
  const name = isObject(value) ? text(value.primary) : text(value);
  const slash = name.indexOf("/");
  if (slash <= 0 || slash === name.length - 1) return null;
  return catalogModel(name, name.slice(0, slash), name.slice(slash + 1));
}

function hermesModel(config: Json): ImportedModel | null {
  const model = isObject(config.model) ? config.model : {};
  const modelId = text(model.default) || text(model.model);
  const provider = text(model.provider);
  if (!modelId || !provider) return null;
  return catalogModel(`${provider}/${modelId}`, provider, modelId);
}

function openClawAgentId(root: string): string {
  return /^workspace-(.+)$/.exec(root)?.[1] ?? "main";
}

function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? ""
  );
}

function mcpServer(
  name: string,
  entry: unknown,
  stdioAllowed: (command: string) => boolean,
): Omit<ImportedMcpServer, "id"> | null {
  if (!isObject(entry)) return null;
  if (entry.skipped !== undefined || !mcpServerImportable(entry)) return null;
  // OAuth, client certificates and `$include` have no import equivalent.
  for (const key of ["auth", "oauth", "tls", "cert", "clientCert", "$include"]) {
    if (entry[key] !== undefined && entry[key] !== false) return null;
  }
  const filter = isObject(entry.toolFilter)
    ? entry.toolFilter
    : isObject(entry.tools)
      ? entry.tools
      : {};
  // Rakazo only lists allowed tools; dropping an exclusion would grant more than the source.
  if (Array.isArray(filter.exclude) && filter.exclude.length > 0) return null;
  const warnings: AgentImportWarning[] = [];
  // An approved server gets all its tools in Rakazo, so a source tool limit would widen.
  if (Array.isArray(filter.include) && filter.include.length > 0) warnings.push("dropped_settings");
  // MCP credentials are never imported: headers and env stay blank; only their names show.
  const names = (record: unknown) => (isObject(record) ? Object.keys(record) : []);
  const base = {
    slug: mcpSlug(name),
    name: name.slice(0, 120),
    description: "",
    enabled: entry.enabled !== false,
  };
  let candidate: unknown;
  let content: string;
  if (text(entry.url)) {
    const headers: Record<string, string> = {};
    const kind = `${text(entry.transport)}${text(entry.type)}`.toLowerCase();
    candidate = {
      ...base,
      transport: kind.includes("sse") ? "sse" : "streamable_http",
      endpoint: text(entry.url),
      headers,
    };
    content = [text(entry.url), ...names(entry.headers)].join("\n");
  } else if (text(entry.command)) {
    const env: Record<string, string> = {};
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    if (!stdioAllowed(text(entry.command))) warnings.unshift("unsupported_command");
    // Rakazo runs servers on its computers: a working folder is dropped, local paths are absent.
    if (
      (entry.cwd !== undefined && entry.cwd !== "") ||
      [text(entry.command), ...args].some(isLocalPath)
    ) {
      warnings.push("local_path");
    }
    candidate = { ...base, transport: "stdio", command: text(entry.command), args, env };
    content = [[text(entry.command), ...args].join(" "), ...names(entry.env)].join("\n");
  } else {
    return null;
  }
  const parsed = McpServerConfigSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return {
    title: name,
    content,
    config: parsed.data,
    warnings,
    status: mcpStatus(entry, warnings),
  };
}

function mcpStatus(entry: Json, warnings: AgentImportWarning[]): AgentImportStatus {
  if (warnings.includes("unsupported_command")) {
    return { kind: "unsupported", reason: "unsupported_command" };
  }
  const names = (record: unknown) => (isObject(record) ? Object.keys(record) : []);
  const needs: AgentImportNeed[] = [];
  if (text(entry.url)) {
    const headers = names(entry.headers);
    if (headers.length) needs.push({ kind: "credentials", names: headers });
  } else {
    needs.push({ kind: "program", name: text(entry.command) });
    const env = names(entry.env);
    if (env.length) needs.push({ kind: "env", names: env });
  }
  if (warnings.includes("local_path")) needs.push({ kind: "local_paths" });
  return needs.length ? { kind: "needs_setup", needs } : { kind: "ready" };
}

function isLocalPath(value: string): boolean {
  return /^(?:\/|~\/|[A-Za-z]:[\\/])/.test(value);
}

export function mcpSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 64)
    .replace(/[-_]+$/, "");
  return slug || "mcp";
}

type JobResult = Omit<ImportedRoutine, "id"> | { reason: Skipped["reason"] };

function openClawJob(job: Json): JobResult {
  const payload = isObject(job.payload) ? job.payload : {};
  const message = text(payload.message);
  // OpenClaw keeps its own heartbeat and memory jobs in the same list.
  if (job.declarationKey || payload.kind !== "agentTurn" || message.startsWith("__openclaw")) {
    return { reason: "builtin" };
  }
  // Tool limits and a per-job model have no routine equivalent: dropping them widens the job.
  const tools = Array.isArray(payload.toolsAllow) ? payload.toolsAllow : [];
  const limited = tools.length > 0 && !tools.includes("*");
  const dropped = limited || Boolean(text(payload.model));
  const schedule = isObject(job.schedule) ? job.schedule : {};
  const cron =
    schedule.kind === "cron"
      ? text(schedule.expr)
      : schedule.kind === "every" && typeof schedule.everyMs === "number"
        ? intervalCron(schedule.everyMs / 60_000)
        : null;
  return routine(job, message, cron, text(schedule.tz), dropped, schedule.kind === "every");
}

function hermesJob(job: Json): JobResult {
  if (text(job.script) || job.no_agent === true) return { reason: "unsupported" };
  const schedule = isObject(job.schedule) ? job.schedule : {};
  const cron =
    schedule.kind === "cron"
      ? text(schedule.expr)
      : schedule.kind === "interval" && typeof schedule.minutes === "number"
        ? intervalCron(schedule.minutes)
        : null;
  const list = (value: unknown) => Array.isArray(value) && value.length > 0;
  const dropped =
    list(job.skills) ||
    Boolean(text(job.skill)) ||
    Boolean(text(job.model) || text(job.provider) || text(job.base_url)) ||
    list(job.enabled_toolsets) ||
    Boolean(text(job.workdir));
  return routine(job, text(job.prompt), cron, "", dropped, schedule.kind === "interval");
}

function routine(
  job: Json,
  prompt: string,
  cron: string | null,
  tz: string,
  droppedSettings: boolean,
  interval: boolean,
): JobResult {
  const name = (text(job.name) || text(job.displayName) || "Routine").slice(0, 80);
  if (!prompt || !cron || !validCron(cron)) return { reason: "unsupported" };
  const timezone = tz && isValidTimeZone(tz) ? tz : null;
  // An interval becomes clock-aligned cron (its start time is lost), and an unknown time
  // zone falls back to the space's.
  const changed = interval || (tz !== "" && timezone === null);
  return {
    title: name,
    name,
    prompt,
    cron,
    timezone,
    warnings: [
      ...(droppedSettings ? (["dropped_settings"] as const) : []),
      ...(changed ? (["changed_schedule"] as const) : []),
    ],
    content: `${cron}${timezone ? ` (${timezone})` : ""}\n\n${prompt}`,
  };
}

/** Null unless a cron fires at exactly that interval. */
export function intervalCron(minutes: number): string | null {
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  if (minutes < 60) return 60 % minutes === 0 ? `*/${minutes} * * * *` : null;
  if (minutes % 60 !== 0) return null;
  const hours = minutes / 60;
  if (hours === 24) return "0 0 * * *";
  return hours < 24 && 24 % hours === 0 ? `0 */${hours} * * *` : null;
}

function validCron(cron: string): boolean {
  try {
    return nextCronDateAcrossStrict([cron], new Date(), "UTC") !== null;
  } catch {
    return false;
  }
}
