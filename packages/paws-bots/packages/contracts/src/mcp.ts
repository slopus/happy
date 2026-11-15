import * as z from "zod";
import { MCP_OAUTH_CLIENT_REQUIRED } from "./connector-errors.js";
import { Id } from "./ids.js";
import { SpaceAvailabilitySchema } from "./space-availability.js";

export const McpTransportSchema = z.enum(["streamable_http", "sse", "stdio"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpRemoteEndpointSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      if (value.endsWith("#")) return false;
      const url = new URL(value);
      if (url.username || url.password || url.hash) return false;
      // Persist HTTP(S). Runtime SSRF still requires HTTPS for public hosts and
      // blocks private LAN targets unless the deployment-owner escape is on.
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "MCP remote endpoint must be an HTTP(S) URL without credentials or a fragment");

export const McpHeadersSchema = z
  // HTTP field names are tokens (RFC 9110 section 5.6.2), including underscores.
  .record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), z.string().max(4096))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 32) {
      ctx.addIssue({ code: "custom", message: "At most 32 headers are allowed" });
    }
  });

/**
 * Credentials a stdio MCP server can receive from its host. The MCP spec leaves
 * stdio servers out of the OAuth flow and has them read credentials from the
 * environment, so an env value may reference the host-held grant as
 * `{{oauth.access_token}}` (alone or inside other text, e.g. `Bearer {{oauth.access_token}}`).
 */
export const MCP_OAUTH_ENV_FIELDS = [
  "access_token",
  "refresh_token",
  "client_id",
  "client_secret",
  /** Access token expiry in epoch milliseconds, the form Google's token files use. */
  "expires_at",
  "scope",
  "token_type",
] as const;
export type McpOAuthEnvField = (typeof MCP_OAUTH_ENV_FIELDS)[number];

const OAUTH_ENV_REFERENCE = /\{\{\s*oauth\.([^{}]*?)\s*\}\}/g;

function isOAuthEnvField(name: string): name is McpOAuthEnvField {
  return (MCP_OAUTH_ENV_FIELDS as readonly string[]).includes(name);
}

/** The OAuth fields an env value references, and any references that are not fields. */
export function mcpOAuthEnvReferences(value: string): {
  fields: McpOAuthEnvField[];
  unknown: string[];
} {
  const fields = new Set<McpOAuthEnvField>();
  const unknown = new Set<string>();
  for (const match of value.matchAll(OAUTH_ENV_REFERENCE)) {
    const name = (match[1] ?? "").trim();
    if (isOAuthEnvField(name)) fields.add(name);
    else unknown.add(name);
  }
  return { fields: [...fields], unknown: [...unknown] };
}

/**
 * Replace OAuth references in env values. Throws when a referenced field has no
 * value (for example a refresh token the provider never issued), so a server is
 * never started with a literal placeholder or an empty credential.
 */
export function resolveMcpOAuthEnv(
  env: Record<string, string>,
  values: Partial<Record<McpOAuthEnvField, string>>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = resolveMcpOAuthTemplate(value, values, key);
  }
  return resolved;
}

/** Replace OAuth references in one value or credential-file template; `label` names it in errors. */
export function resolveMcpOAuthTemplate(
  template: string,
  values: Partial<Record<McpOAuthEnvField, string>>,
  label: string,
): string {
  return template.replace(OAUTH_ENV_REFERENCE, (_reference, rawName: string) => {
    const name = rawName.trim();
    const field = isOAuthEnvField(name) ? values[name] : undefined;
    if (!field) throw new Error(`MCP OAuth value oauth.${name} is not available for ${label}`);
    return field;
  });
}

/**
 * Fill a credential-file template. When the file is JSON, values are escaped for the JSON
 * string they sit in, so a secret holding a quote or backslash keeps the file valid.
 */
export function resolveMcpOAuthFileTemplate(
  template: string,
  values: Partial<Record<McpOAuthEnvField, string>>,
  label: string,
): string {
  let json = false;
  try {
    JSON.parse(template.replace(OAUTH_ENV_REFERENCE, "0"));
    json = true;
  } catch {
    // Not JSON (e.g. an INI or plain token file): values go in as they are.
  }
  if (!json) return resolveMcpOAuthTemplate(template, values, label);
  const escaped = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value === undefined ? value : JSON.stringify(value).slice(1, -1),
    ]),
  ) as Partial<Record<McpOAuthEnvField, string>>;
  return resolveMcpOAuthTemplate(template, escaped, label);
}

/**
 * Credential files for stdio servers whose packages read a file path rather than
 * a value. The key is the env variable that receives the file's path; the value
 * is the file content template, which may use the same `{{oauth.*}}` references.
 */
export const McpStdioFilesSchema = z
  .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(65536))
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > 8) {
      ctx.addIssue({ code: "custom", message: "At most 8 credential files are allowed" });
    }
  });

/** Parameters the OAuth flow sets itself; extra authorization parameters may not override them. */
const MCP_OAUTH_FLOW_PARAMS = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
]);

/**
 * Extra parameters for the authorization request, in query-string form. Some
 * providers need them to issue a refresh token, e.g. Google's
 * `access_type=offline&prompt=consent`.
 */
export function parseMcpOAuthAuthorizationParams(value: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, entry] of new URLSearchParams(value.trim().replace(/^\?/, ""))) {
    if (MCP_OAUTH_FLOW_PARAMS.has(key))
      throw new Error(`${key} is set by the OAuth flow and cannot be an extra parameter`);
    params[key] = entry;
  }
  return params;
}

/** A remote MCP service that connects with a bearer token. */
export const McpSourcePresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Fixed endpoint; omitted when the person enters their own. */
  url: z.string().url().optional(),
  urlPlaceholder: z.string().optional(),
});
export type McpSourcePreset = z.infer<typeof McpSourcePresetSchema>;

const McpServerBaseInput = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  enabled: z.boolean().default(true),
  /** Keep this server's tool results whole instead of cutting them to fit context. Omitted keeps the stored value. */
  verbatimResults: z.boolean().optional(),
  /** Update-only: drop the stored static credential (secret/env/headers).
   * OAuth state survives so a connected server stays connected. */
  clearCredential: z.boolean().optional(),
});
const McpOAuthClientFields = {
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().min(1).max(4096).optional(),
  /** Space-separated scopes to request. Empty: the server's advertised scopes. */
  scope: z.string().trim().max(2000).optional(),
  /** Extra authorization request parameters in query-string form, e.g. Google's
   * `access_type=offline&prompt=consent` for a refresh token. */
  authorizationParams: z
    .string()
    .trim()
    .max(1000)
    .refine((value) => {
      try {
        parseMcpOAuthAuthorizationParams(value);
        return true;
      } catch {
        return false;
      }
    }, "Extra authorization parameters cannot set the OAuth flow's own parameters")
    .optional(),
};
/** A client registered with the server's OAuth provider out of band, for
 * providers without dynamic client registration. On update, omit it to keep
 * the stored client and send null to remove it. A remote server discovers its
 * authorization server, so the client is bound to it on first use. */
const McpOAuthClientInput = z.object(McpOAuthClientFields).nullable().optional();
/** A stdio server has no URL to discover from, so its client names the
 * authorization server (its issuer, e.g. https://accounts.google.com). Rakazo
 * runs the OAuth flow and passes the grant through `{{oauth.*}}` env references. */
const McpStdioOAuthClientInput = z
  .object({ ...McpOAuthClientFields, authorizationServer: McpRemoteEndpointSchema })
  .nullable()
  .optional();
export const McpServerConfigInput = z.discriminatedUnion("transport", [
  McpServerBaseInput.extend({
    transport: z.literal("streamable_http"),
    endpoint: McpRemoteEndpointSchema,
    headers: McpHeadersSchema.default({}),
    secret: z.string().max(16384).optional(),
    oauthClient: McpOAuthClientInput,
  }),
  McpServerBaseInput.extend({
    transport: z.literal("sse"),
    endpoint: McpRemoteEndpointSchema,
    headers: McpHeadersSchema.default({}),
    secret: z.string().max(16384).optional(),
    oauthClient: McpOAuthClientInput,
  }),
  McpServerBaseInput.extend({
    transport: z.literal("stdio"),
    command: z.string().min(1).max(512),
    /** Update: send none to keep the stored arguments while the command is unchanged. */
    args: z.array(z.string().max(2048)).max(64).default([]),
    env: z
      .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4096))
      .superRefine((value, ctx) => {
        if (Object.keys(value).length > 32) {
          ctx.addIssue({ code: "custom", message: "At most 32 environment variables are allowed" });
        }
      })
      .default({}),
    /** Update: omit to keep the stored files, send the complete set to replace them. */
    files: McpStdioFilesSchema.optional(),
    secret: z.string().max(16384).optional(),
    oauthClient: McpStdioOAuthClientInput,
  }),
]);
export type McpServerConfigInput = z.infer<typeof McpServerConfigInput>;

/**
 * Last observed launch/discovery outcome of an MCP server. `installing` covers a stdio
 * package being prepared; `unknown` means nothing has tried to reach the server yet.
 */
export const McpServerHealthSchema = z.object({
  status: z.enum(["unknown", "installing", "ok", "error"]),
  /** Redacted, human-readable failure reason (stderr tail included for stdio). */
  message: z.string().nullable(),
  /** A failure the user fixes in the server's settings, so clients can say how. */
  code: z.enum([MCP_OAUTH_CLIENT_REQUIRED]).nullable().optional(),
  toolCount: z.number().int().nonnegative().nullable(),
  checkedAt: z.string().nullable(),
});
export type McpServerHealth = z.infer<typeof McpServerHealthSchema>;

export const McpServerSchema = z.object({
  id: Id,
  spaceId: Id,
  installId: Id.nullable().optional(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  transport: McpTransportSchema,
  endpoint: z.string().url().nullable(),
  command: z.string().nullable(),
  /** Arguments are stored encrypted and never returned. */
  hasArgs: z.boolean(),
  envKeys: z.array(z.string()),
  /** Env variables that receive a credential file's path instead of a value. */
  fileKeys: z.array(z.string()),
  headerKeys: z.array(z.string()),
  hasSecret: z.boolean(),
  oauthStatus: z.enum(["none", "connected", "reconnect"]),
  /** The pre-registered OAuth client, when one is configured. Its secret is never returned. */
  oauthClientId: z.string().nullable(),
  health: McpServerHealthSchema,
  enabled: z.boolean(),
  /** Keep this server's tool results whole instead of cutting them to fit context. */
  verbatimResults: z.boolean().default(false),
  revision: z.number().int().positive(),
  availability: SpaceAvailabilitySchema.optional(),
  /** Every agent can use it; when false, only the agents assigned to it. */
  allBots: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

export type McpServerConnection =
  | "disabled"
  | "needs_client"
  | "needs_sign_in"
  | "not_working"
  | "connected"
  | "not_connected";

/** The one state every client shows for a saved server. */
export function mcpServerConnection(
  server: Pick<McpServer, "enabled" | "health" | "oauthClientId" | "oauthStatus">,
): McpServerConnection {
  if (!server.enabled) return "disabled";
  if (server.health.code === MCP_OAUTH_CLIENT_REQUIRED && !server.oauthClientId)
    return "needs_client";
  if (server.oauthStatus === "reconnect") return "needs_sign_in";
  if (server.health.status === "error") return "not_working";
  if (server.oauthStatus === "connected" || server.health.status === "ok") return "connected";
  return "not_connected";
}

/** Whether Sign in or Reconnect can help: on, not connected, not signed in (even if failing). */
export function mcpServerNeedsSignIn(server: Parameters<typeof mcpServerConnection>[0]): boolean {
  const state = mcpServerConnection(server);
  return state !== "disabled" && state !== "connected" && server.oauthStatus !== "connected";
}

export const BotMcpServerSchema = z.object({
  id: Id,
  botId: Id,
  serverId: Id,
  allowAllTools: z.boolean(),
  allowedTools: z.array(z.string().min(1).max(200)),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BotMcpServer = z.infer<typeof BotMcpServerSchema>;
