import JSON5 from "json5";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** Settings files read from the root of an OpenClaw or Hermes home. */
export const AGENT_IMPORT_CONFIG_FILES = new Set([
  "openclaw.json",
  ".env",
  "config.yaml",
  "auth.json",
  "cron/jobs.json",
  "skills/.bundled_manifest",
]);

/** Read only when the user opts in. */
const SECRET_FILES = new Set([".env", "auth.json"]);

export function isAgentImportSecretFile(path: string): boolean {
  return SECRET_FILES.has(path);
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `openclaw.json` and job lists are JSON5, `config.yaml` is YAML (aliases capped, core
 * schema only). Null unless a plain object without prototype keys or deep nesting.
 */
export function readAgentImportConfig(path: string, content: string): Json | null {
  try {
    const value: unknown =
      path === "config.yaml"
        ? parseYaml(content, { maxAliasCount: 20, schema: "core", customTags: [] })
        : (JSON5.parse(content) as unknown);
    return isObject(value) && safeTree(value, 0) ? value : null;
  } catch {
    return null;
  }
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 32;

function safeTree(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => safeTree(item, depth + 1));
  if (!isObject(value)) return true;
  return Object.keys(value).every(
    (key) => !UNSAFE_KEYS.has(key) && safeTree(value[key], depth + 1),
  );
}

/** Provider-key variables an import may read; anything else (channel tokens, ...) is not. */
export const AGENT_IMPORT_PROVIDER_KEYS: Readonly<Record<string, string>> = {
  OPENROUTER_API_KEY: "openrouter",
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  GEMINI_API_KEY: "google",
  GOOGLE_API_KEY: "google",
  DEEPSEEK_API_KEY: "deepseek",
  XAI_API_KEY: "xai",
  MINIMAX_API_KEY: "minimax",
  KIMI_API_KEY: "kimi-coding",
  MOONSHOT_API_KEY: "moonshotai",
  MISTRAL_API_KEY: "mistral",
  GROQ_API_KEY: "groq",
};
const KEY_PROVIDERS = new Set(Object.values(AGENT_IMPORT_PROVIDER_KEYS));

// A key for a proxy or gateway must never be checked against, or sent to, the provider itself.
/** The base URL kept with a key, so the server can tell the provider's own from a proxy's. */
const baseUrlOf = (entry: Json, field: "base_url" | "baseUrl") =>
  typeof entry[field] === "string" && entry[field].trim() ? { [field]: entry[field] } : {};

/** Provider-key variables, each with its `*_BASE_URL` when one is set. */
function providerKeyVars<T>(vars: Record<string, T>): [string, T][] {
  const keys = Object.keys(vars).filter((name) => name in AGENT_IMPORT_PROVIDER_KEYS);
  const urls = keys.map((name) => name.replace(/_API_KEY$/, "_BASE_URL"));
  return Object.entries(vars).filter(([name]) => keys.includes(name) || urls.includes(name));
}

/** Provider names the source tools use for Rakazo's catalog providers. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  gemini: "google",
  "google-gemini": "google",
  claude: "anthropic",
  "x-ai": "xai",
  grok: "xai",
  kimi: "kimi-coding",
  moonshot: "moonshotai",
  "z-ai": "zai",
  zhipu: "zai",
};

export function normalizeImportProvider(provider: string): string {
  const id = provider.trim().toLowerCase();
  return PROVIDER_ALIASES[id] ?? id;
}

export function parseDotEnv(content: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readDotEnv(content)).map(([name, entry]) => [name, entry.value]),
  );
}

function readDotEnv(content: string): Record<string, { value: string; literal: string }> {
  const values: Record<string, { value: string; literal: string }> = {};
  for (const line of content.split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    const quote = value[0];
    const quoted =
      quote === "'"
        ? /^'(.*?)'(?:\s*#.*)?$/.exec(value)
        : /^"((?:\\.|[^\\])*?)"(?:\s*#.*)?$/.exec(value);
    value = quoted ? quoted[1]! : value.replace(/\s+#.*$/, "");
    // Preserve the source quoting so preparation cannot turn a value's contents into a comment.
    const literal = quoted ? `${quote}${value}${quote}` : value;
    values[match[1]!] = { value, literal };
  }
  return values;
}

/**
 * Applied in the browser before anything is sent, and again on the server, so both agree.
 *
 * Settings keep only what an import reads. Without the API key opt-in `.env`/`auth.json`
 * are not sent; with it, only allowlisted model-provider keys (and the `.env` names they
 * refer to) are kept. MCP header/env values, gateway and channel tokens and OAuth grants are
 * never copied. This limits what is sent; it cannot recognise every misplaced secret.
 */
export function prepareAgentImportFiles(
  files: ReadonlyMap<string, string>,
  options: { includeSecrets: boolean },
): Map<string, string> {
  const out = new Map<string, string>();
  const referenced = new Set<string>();
  for (const [path, content] of files) {
    if (SECRET_FILES.has(path)) continue;
    if (path === "openclaw.json" || path === "config.yaml") {
      const config = readAgentImportConfig(path, content);
      out.set(path, config ? projectConfig(path, config, options.includeSecrets, referenced) : "");
    } else {
      out.set(path, content);
    }
  }
  if (!options.includeSecrets) return out;
  const env = files.get(".env");
  if (env !== undefined) {
    const values = readDotEnv(env);
    const keys = new Set(providerKeyVars(values).map(([name]) => name));
    const lines = Object.entries(values)
      .filter(([name]) => keys.has(name) || referenced.has(name))
      .map(([name, entry]) => `${name}=${entry.literal}`);
    out.set(".env", lines.length ? `${lines.join("\n")}\n` : "");
  }
  const auth = files.get("auth.json");
  if (auth !== undefined) out.set("auth.json", JSON.stringify(manualKeys(auth)));
  return out;
}

export function stripAgentImportSecrets(path: string, content: string): string {
  return (
    prepareAgentImportFiles(new Map([[path, content]]), { includeSecrets: false }).get(path) ?? ""
  );
}

function projectConfig(
  path: string,
  config: Json,
  secrets: boolean,
  referenced: Set<string>,
): string {
  const keyed = (name: string) => KEY_PROVIDERS.has(normalizeImportProvider(name));
  // A base URL is kept even without a key here, so a key for that provider from `.env`
  // can be held back when it belongs to a proxy.
  const keyEntry = (entry: Json, key: "api_key" | "apiKey", url: "base_url" | "baseUrl") => {
    const kept = {
      ...(entry[key] !== undefined ? { [key]: noteReferences(entry[key], referenced) } : {}),
      ...baseUrlOf(entry, url),
    };
    return Object.keys(kept).length ? kept : null;
  };
  if (path === "config.yaml") {
    const model = isObject(config.model) ? config.model : {};
    const keepModelKey = secrets && keyed(String(model.provider ?? ""));
    const providers = Object.entries(isObject(config.providers) ? config.providers : {}).flatMap(
      ([name, entry]) => {
        const kept =
          secrets && keyed(name) && isObject(entry) ? keyEntry(entry, "api_key", "base_url") : null;
        return kept ? [[name, kept]] : [];
      },
    );
    const custom = (Array.isArray(config.custom_providers) ? config.custom_providers : []).flatMap(
      (entry) => {
        const kept =
          secrets && isObject(entry) && keyed(String(entry.name ?? ""))
            ? keyEntry(entry, "api_key", "base_url")
            : null;
        return kept ? [{ name: String(entry.name), ...kept }] : [];
      },
    );
    return stringifyYaml({
      model: {
        ...strings(model, ["default", "model", "provider"]),
        ...(keepModelKey ? keyEntry(model, "api_key", "base_url") : {}),
      },
      ...(providers.length ? { providers: Object.fromEntries(providers) } : {}),
      ...(custom.length ? { custom_providers: custom } : {}),
      mcp_servers: mcpServers(config.mcp_servers),
    });
  }
  const agents = isObject(config.agents) ? config.agents : {};
  const defaults = isObject(agents.defaults) ? agents.defaults : {};
  const agent = (value: unknown) => {
    const entry = isObject(value) ? value : {};
    return {
      ...strings(entry, ["id"]),
      ...modelName(entry.model),
      ...(typeof entry.workspace === "string" ? { workspace: folderName(entry.workspace) } : {}),
    };
  };
  const mcp = isObject(config.mcp) ? config.mcp : {};
  const projected: Json = {
    agents: {
      defaults: modelName(defaults.model),
      entries: Object.fromEntries(
        Object.entries(isObject(agents.entries) ? agents.entries : {}).map(([id, entry]) => [
          id,
          agent(entry),
        ]),
      ),
      list: Array.isArray(agents.list) ? agents.list.map(agent) : [],
    },
    mcp: { servers: mcpServers(mcp.servers) },
  };
  if (secrets) {
    const models = isObject(config.models) ? config.models : {};
    const providers = Object.entries(isObject(models.providers) ? models.providers : {}).flatMap(
      ([id, entry]) => {
        const kept = keyed(id) && isObject(entry) ? keyEntry(entry, "apiKey", "baseUrl") : null;
        return kept ? [[id, kept]] : [];
      },
    );
    const env = isObject(config.env) ? config.env : {};
    const vars = {
      ...env,
      ...(isObject(env.vars) ? env.vars : {}),
    };
    const allowed = providerKeyVars(vars).filter(([, value]) => typeof value === "string");
    if (providers.length) projected.models = { providers: Object.fromEntries(providers) };
    if (allowed.length) projected.env = { vars: Object.fromEntries(allowed) };
  }
  return JSON.stringify(projected, null, 2);
}

/**
 * Records the `.env` names a value refers to. Only a plain string or an env SecretRef
 * `{ source: "env", id }` is copied.
 */
function noteReferences(value: unknown, referenced: Set<string>): unknown {
  if (isObject(value)) {
    if (value.source !== "env" || typeof value.id !== "string") return undefined;
    referenced.add(value.id);
    return { source: "env", id: value.id };
  }
  if (typeof value !== "string") return undefined;
  for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) referenced.add(match[1]!);
  return value;
}

/** Hermes `auth.json`: only API keys the user entered by hand, for allowlisted providers. */
function manualKeys(content: string): Json {
  const auth = readAgentImportConfig("auth.json", content) ?? {};
  const pool = isObject(auth.credential_pool) ? auth.credential_pool : {};
  const kept = Object.entries(pool).flatMap(([provider, entries]) => {
    if (!KEY_PROVIDERS.has(normalizeImportProvider(provider))) return [];
    const manual = (Array.isArray(entries) ? entries : []).filter(
      (entry) => isObject(entry) && entry.auth_type === "api_key" && entry.source === "manual",
    );
    return manual.length
      ? [
          [
            provider,
            manual.map((entry) => strings(entry as Json, ["auth_type", "source", "access_token"])),
          ],
        ]
      : [];
  });
  return { credential_pool: Object.fromEntries(kept) };
}

export function hasAgentImportSecrets(path: string, content: string): boolean {
  if (SECRET_FILES.has(path)) return content.trim() !== "";
  if (path !== "openclaw.json" && path !== "config.yaml") return false;
  const config = readAgentImportConfig(path, content);
  if (!config) return false;
  const keyed = (name: unknown) => KEY_PROVIDERS.has(normalizeImportProvider(String(name ?? "")));
  if (path === "config.yaml") {
    const model = isObject(config.model) ? config.model : {};
    return (
      (keyed(model.provider) && Boolean(model.api_key)) ||
      Object.entries(isObject(config.providers) ? config.providers : {}).some(
        ([name, entry]) => keyed(name) && isObject(entry) && Boolean(entry.api_key),
      ) ||
      (Array.isArray(config.custom_providers) ? config.custom_providers : []).some(
        (entry) => isObject(entry) && keyed(entry.name) && Boolean(entry.api_key),
      )
    );
  }
  const models = isObject(config.models) ? config.models : {};
  const env = isObject(config.env) ? config.env : {};
  const vars = { ...env, ...(isObject(env.vars) ? env.vars : {}) };
  return (
    Object.entries(isObject(models.providers) ? models.providers : {}).some(
      ([id, entry]) => keyed(id) && isObject(entry) && entry.apiKey !== undefined,
    ) || Object.keys(vars).some((name) => name in AGENT_IMPORT_PROVIDER_KEYS)
  );
}

const CREDENTIAL_FLAG = /(?:key|token|secret|pass|auth|header|credential|bearer|cookie|sig)/i;
const BARE_FLAG = /^--?[A-Za-z][A-Za-z0-9-]*$/;
const PACKAGE_SPEC = /^(?:@[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*(?:@[\w.^~*-]+)?$/;
const PLAIN_PATH = /^(?:~|\.{1,2})?\/?[\w.-]+(?:\/[\w.-]+)*\/?$/;
const BARE_PROGRAM = /^[A-Za-z0-9][\w.-]*$/;
const VARIABLE_NAME = /^[A-Za-z_][\w-]*$/;

/**
 * Rakazo stores URLs and arguments in plain text, so this is deliberately conservative
 * rather than a search for secrets: a URL without user info, query or fragment, or a bare
 * program with plain arguments. Anything else keeps only its name.
 */
export function mcpServerImportable(entry: Record<string, unknown>): boolean {
  const names = (record: unknown) =>
    record === undefined ||
    (isObject(record) && Object.keys(record).every((name) => VARIABLE_NAME.test(name)));
  if (!names(entry.headers) || !names(entry.env)) return false;
  if (typeof entry.url === "string" && entry.url) {
    if (/[?#@]/.test(entry.url)) return false;
    try {
      const url = new URL(entry.url);
      return (url.protocol === "https:" || url.protocol === "http:") && !url.username;
    } catch {
      return false;
    }
  }
  if (typeof entry.command !== "string" || !BARE_PROGRAM.test(entry.command)) return false;
  if (entry.args !== undefined && !Array.isArray(entry.args)) return false;
  return ((entry.args ?? []) as unknown[]).every(
    (arg) =>
      typeof arg === "string" &&
      (BARE_FLAG.test(arg)
        ? !CREDENTIAL_FLAG.test(arg)
        : PACKAGE_SPEC.test(arg) || PLAIN_PATH.test(arg)),
  );
}

/** Named fields only; header and env by name only. */
function mcpServers(value: unknown): Json {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([name, server]) => {
      const entry = isObject(server) ? server : {};
      if (!mcpServerImportable(entry)) return [name, { skipped: true }];
      const names = (record: unknown) =>
        isObject(record) ? Object.fromEntries(Object.keys(record).map((key) => [key, ""])) : {};
      const filter = (record: unknown) => {
        if (!isObject(record)) return undefined;
        const list = (items: unknown) =>
          Array.isArray(items) ? items.filter((item) => typeof item === "string") : [];
        return { include: list(record.include), exclude: list(record.exclude) };
      };
      return [
        name,
        {
          ...strings(entry, ["url", "transport", "type", "command"]),
          ...(Array.isArray(entry.args) ? { args: entry.args } : {}),
          ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
          ...(filter(entry.toolFilter) ? { toolFilter: filter(entry.toolFilter) } : {}),
          ...(filter(entry.tools) ? { tools: filter(entry.tools) } : {}),
          // Only that these exist: an import cannot express them, and they may hold secrets.
          ...(entry.oauth !== undefined || entry.auth !== undefined ? { auth: true } : {}),
          ...(entry.tls !== undefined || entry.cert !== undefined || entry.clientCert !== undefined
            ? { tls: true }
            : {}),
          ...(entry.$include !== undefined ? { $include: true } : {}),
          // A working folder on the source machine is dropped; only that it was set is kept.
          ...(entry.cwd !== undefined && entry.cwd !== "" ? { cwd: true } : {}),
          headers: names(entry.headers),
          env: names(entry.env),
        },
      ];
    }),
  );
}

/** Nested objects are never copied. */
function strings(source: Json, keys: readonly string[]): Json {
  return Object.fromEntries(
    keys.filter((key) => typeof source[key] === "string").map((key) => [key, source[key]]),
  );
}

/** A model name as OpenClaw writes it: a string, or `{ primary }`. */
function modelName(value: unknown): Json {
  if (typeof value === "string") return { model: value };
  if (isObject(value) && typeof value.primary === "string")
    return { model: { primary: value.primary } };
  return {};
}

function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? ""
  );
}
