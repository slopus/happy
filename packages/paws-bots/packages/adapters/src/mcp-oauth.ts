import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  auth,
  discoverOAuthProtectedResourceMetadata,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import {
  isLocalhostOrLoopbackIp,
  MCP_OAUTH_CLIENT_REQUIRED,
  mcpOAuthEnvReferences,
  parseMcpOAuthAuthorizationParams,
} from "@rakazo/contracts";
import { readBoundedResponseBytes } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { availableInSpace, itemSecretIn, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { advisoryLock } from "./advisory-lock.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import { MCP_DYNAMIC_REGISTRATION_UNSUPPORTED, needsMcpOAuthClient } from "./mcp-server-health.js";
import {
  MAX_AUTHORIZATION_URL_LENGTH,
  secureFetch,
  validateUrl,
  withEndpointOriginFallback,
} from "./mcp-transport.js";
import { REFRESH_REQUEST_TIMEOUT_MS, withRefreshLock } from "./refresh-lock.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { persistPreparedSecret } from "./secret-persistence.js";
import { deleteSecretBestEffort, holdSecretNotifications } from "./secret-store-factory.js";

type OAuthState = {
  tokens?: OAuthTokens;
  obtainedAt?: number;
  clientInformation?: OAuthClientInformationMixed;
  discoveryState?: OAuthDiscoveryState;
  redirectUri?: string;
  codeVerifier?: string;
};

export type OAuthMaterial = {
  secret?: string;
  /** Stdio launch arguments. */
  args?: string[];
  env?: Record<string, string>;
  /** Credential files for a stdio server: the env variable that receives the file's
   * path, and the content template, which may use `{{oauth.*}}` references. */
  files?: Record<string, string>;
  headers?: Record<string, string>;
  /** A client registered with the authorization server out of band. It is
   * configuration, not SDK state, so it outlives disconnects and replaces
   * dynamic client registration for servers that do not offer it. */
  oauthClient?: PreRegisteredClient;
  oauth?: OAuthState;
  /** Raised whenever the stored OAuth state is discarded, so a write from a flow that
   * began before the discard cannot bring its tokens back. */
  oauthGeneration?: number;
};

/** Values that must never appear in model-visible tool results or errors. */
export function oauthMaterialSecrets(material: OAuthMaterial): string[] {
  const values: string[] = [];
  const add = (value: string | undefined) => addSecret(values, value);
  add(material.secret);
  add(material.oauth?.tokens?.access_token);
  add(material.oauth?.tokens?.refresh_token);
  add(material.oauthClient?.client_secret);
  const client = material.oauth?.clientInformation;
  if (client && "client_secret" in client && typeof client.client_secret === "string") {
    add(client.client_secret);
  }
  for (const [key, value] of Object.entries(material.headers ?? {})) {
    // Cookie / X-Session / Authorization always carry auth material, including short values.
    if (isAuthHeaderKey(key) || isConfiguredSecret(key, value)) add(value);
  }
  for (const [key, value] of Object.entries(material.env ?? {})) {
    if (isConfiguredSecret(key, value)) add(value);
  }
  // A file without references is a literal credential (for example a service-account key).
  // One that uses references is covered by the grant values it embeds.
  for (const content of Object.values(material.files ?? {})) {
    if (
      mcpOAuthEnvReferences(content).fields.length === 0 &&
      looksLikeSecretValue(content, { allowNumeric: false })
    )
      add(content);
  }
  return [...new Set(values)];
}

/** Registers a credential and, for a Bearer or Basic value, the credential on its own. */
function addSecret(values: string[], value: string | undefined): void {
  if (!value) return;
  values.push(value);
  const bearer = value.match(/^(?:Bearer|Basic)\s+(.+)$/i);
  if (bearer?.[1]) values.push(bearer[1]);
}

/** Credentials in stdio launch arguments, which the process can echo in output and errors. */
export function launchArgSecrets(args: string[]): string[] {
  const values: string[] = [];
  const add = (value: string | undefined) => addSecret(values, value);
  const addAssignment = (assignment: string) => {
    const match = assignment.match(/^([A-Za-z_][\w.-]*)=([\s\S]*)$/);
    if (match?.[1] && match[2] && isLaunchSecret(match[1], match[2])) add(match[2]);
  };
  for (const [index, arg] of args.entries()) {
    for (const url of urlsIn(arg)) values.push(...urlSecrets(url));
    const flag = arg.match(/^--?([A-Za-z][\w.-]*)(?:=([\s\S]*))?$/);
    if (!flag?.[1]) {
      addAssignment(arg);
      continue;
    }
    const name = flag[1];
    const next = args[index + 1];
    const value = flag[2] ?? (next?.startsWith("-") ? undefined : next);
    if (!value) continue;
    const normalized = snakeName(name);
    if (name === "H" || normalized === "header") {
      const header = value.match(/^([^:]+):\s*([\s\S]*)$/);
      if (!header?.[1] || !header[2]) continue;
      const [, headerName, headerValue] = header;
      // `--header Authorization:Bearer <token>` splits the token into the next argument, which
      // may itself start with "-"; only an argument shaped like a flag is not the token.
      if (isAuthHeaderKey(headerName) && /^bearer$/i.test(headerValue)) {
        const token = args[index + 2];
        if (flag[2] === undefined && !/^(--|-.$)/.test(token ?? "")) add(token);
      } else if (
        isAuthHeaderKey(headerName) ||
        // Custom auth headers (an API gateway's subscription key) have no standard name, so any
        // header but the content-negotiation ones follows the configured-header rule.
        (!/^(accept|content|user-agent|cache-control|connection|host)/i.test(headerName.trim()) &&
          isLaunchSecret(headerName, headerValue))
      ) {
        add(headerValue);
      }
    } else if (name === "e" || normalized === "env") {
      addAssignment(value);
    } else if (name.length === 1) {
      // `-y` (as in `npx -y <package>`) takes no value; what follows it is the package.
      if (name !== "y" && looksLikeOpaqueToken(value)) add(value);
    } else if (isCredentialArg(name, value)) {
      add(value);
    }
  }
  return [...new Set(values)];
}

/** An assignment or header value: the configured env/header rule, or a credential name. */
function isLaunchSecret(name: string, value: string): boolean {
  return isConfiguredSecret(snakeName(name), value) || isCredentialArg(name, value);
}

/** A flag, query, or header value under a credential name. Only explicit credential names
 * (`api_key`, `password`, `access_key`) take numeric values, so `?key=0` cannot redact every zero. */
function isCredentialArg(name: string, value: string): boolean {
  const normalized = snakeName(name);
  return (
    isCredentialName(normalized) &&
    looksLikeSecretValue(value, {
      allowNumeric: isExplicitCredentialKey(normalized) || NAMED_KEY.test(normalized),
    })
  );
}

/** Key names that say which credential they hold (`access_key`, not a bare `key`). */
const NAMED_KEY = /(?:^|_)(access_key|private_key|secret_key)$/;

/** Flag and query names that carry a credential (`api_key`, `token`, `client_auth`, `pat`). */
function isCredentialName(normalized: string): boolean {
  return (
    isExplicitCredentialKey(normalized) ||
    isAmbiguousCredentialKey(normalized) ||
    NAMED_KEY.test(normalized) ||
    /^(key|pat|auth)$/.test(normalized) ||
    // `--client-auth <token>`, but not a switch such as `--no-auth`, whose next argument is not its value.
    (/_auth$/.test(normalized) && !/^(no|disable|enable|skip|use|require)_/.test(normalized))
  );
}

/** `apiKey`, `APIKey`, `api.key` and `api-key` → `api_key`, so they match the snake_case rules. */
function snakeName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])|([A-Z])([A-Z][a-z])/g, (_, a, b, c, d) =>
      a ? `${a}_${b}` : `${c}_${d}`,
    )
    .toLowerCase()
    .replace(/[-.]/g, "_");
}

/** A one-letter flag's value is a credential only when it reads like a generated token,
 * not a word, path, or number. */
function looksLikeOpaqueToken(value: string): boolean {
  return /^[\w+=.-]{16,}$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value);
}

/** Each whitespace- or quote-separated word containing `scheme://`, from the scheme on. A scan,
 * not a global regex, so a long argument cannot make matching quadratic. */
function urlsIn(text: string): string[] {
  const urls: string[] = [];
  for (const word of text.split(/[\s"'<>]+/)) {
    const separator = word.indexOf("://");
    let start = separator;
    while (start > 0 && /[a-z\d+.-]/i.test(word.charAt(start - 1))) start--;
    while (start < separator && !/[a-z]/i.test(word.charAt(start))) start++;
    if (start < separator) urls.push(word.slice(start));
  }
  return urls;
}

/** The userinfo of a URL (`user:password@`, or a bare token as the user) and its
 * credential-named query values. */
function urlSecrets(text: string): string[] {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return [];
  }
  const values: string[] = [];
  const addEncoded = (value: string) => values.push(value, decodeURIComponentSafe(value));
  if (url.password) addEncoded(url.password);
  // An HTTP(S) user name without a password is how a token is passed (`https://<token>@host`);
  // otherwise, as for `ssh://git@host` or `user:password@`, it counts only when it reads like one.
  const username = decodeURIComponentSafe(url.username);
  if (
    !url.password && /^https?:$/.test(url.protocol)
      ? username.length >= MIN_NEUTRAL_SECRET_LENGTH
      : looksLikeOpaqueToken(username)
  )
    addEncoded(url.username);
  for (const pair of url.search.slice(1).split("&")) {
    const [[key, value] = []] = new URLSearchParams(pair);
    if (!key || !value) continue;
    // Both the decoded value and its spelling in the argument, which the server may echo.
    if (isCredentialArg(key, value)) {
      addSecret(values, value);
      values.push(pair.slice(pair.indexOf("=") + 1));
    }
  }
  return values;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Redaction replaces substrings, so a short value under a neutral name would mangle output. */
const MIN_NEUTRAL_SECRET_LENGTH = 8;

/** A user can put a credential under any env or header name, so only short or ordinary
 * config values under names that do not say credential stay visible. */
function isConfiguredSecret(key: string, value: string): boolean {
  if (isExplicitCredentialKey(key)) return looksLikeSecretValue(value, { allowNumeric: true });
  if (!looksLikeSecretValue(value, { allowNumeric: false })) return false;
  return isAmbiguousCredentialKey(key) || value.trim().length >= MIN_NEUTRAL_SECRET_LENGTH;
}

/** Headers whose values are credentials even when short (e.g. Cookie, X-Session). */
function isAuthHeaderKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  return (
    normalized === "authorization" ||
    normalized === "proxy_authorization" ||
    normalized === "cookie" ||
    normalized === "set_cookie" ||
    normalized === "x_session" ||
    normalized === "x_api_key" ||
    normalized === "api_key" ||
    normalized === "x_auth_token"
  );
}

/** Explicit credential keys (access_token, api_key, …); numeric values stay redacted. */
function isExplicitCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  if (isAuthHeaderKey(key)) return true;
  return /(?:^|_)(secret|password|credential|access_token|refresh_token|id_token|auth_token|session_token|session_id|session_key|session_secret|api_key|api_token)$/.test(
    normalized,
  );
}

/** Ambiguous *_token keys where numeric-only values are usually config, not secrets. */
function isAmbiguousCredentialKey(key: string): boolean {
  if (isExplicitCredentialKey(key)) return false;
  const normalized = key.toLowerCase().replace(/-/g, "_");
  if (/(?:^|_)token$/.test(normalized)) {
    return !/(timeout|ttl|max|count|type|mode|name)$/.test(normalized);
  }
  return false;
}

/**
 * Values under credential-shaped keys must look like secrets before entering
 * global substring redaction. Ordinary enums such as "production" or "oauth"
 * would otherwise corrupt unrelated tool output. Numeric-only filtering applies
 * only to ambiguous keys — explicit carriers still register OTP-like tokens.
 */
export function looksLikeSecretValue(
  value: string,
  options: { allowNumeric?: boolean } = {},
): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (COMMON_CONFIG_VALUES.has(trimmed.toLowerCase())) return false;
  if (!options.allowNumeric && /^\d+(\.\d+)?$/.test(trimmed)) return false;
  return true;
}

const COMMON_CONFIG_VALUES = new Set([
  "production",
  "development",
  "staging",
  "test",
  "testing",
  "oauth",
  "openid",
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "none",
  "null",
  "debug",
  "info",
  "warn",
  "error",
  "http",
  "https",
  "local",
  "localhost",
  "enabled",
  "disabled",
  "default",
  "auto",
  "manual",
  "read",
  "write",
  "sync",
  "async",
]);

/** `authorization_server` binds the client to the server it was first used with,
 * so an MCP server cannot later steer the secret to another one via discovery.
 * `scope` is the space-separated scope to request; it is ours, not part of the
 * client information the SDK sends. */
type PreRegisteredClient = OAuthClientInformation & {
  authorization_server?: string;
  scope?: string;
  /** Extra authorization request parameters, query-string form. */
  authorization_params?: string;
};

function boundClient(
  client: PreRegisteredClient,
  authorizationServerUrl: string | undefined,
): OAuthClientInformation {
  if (!authorizationServerUrl) throw new Error("MCP OAuth authorization server is unknown");
  if (
    client.authorization_server &&
    client.authorization_server !== new URL(authorizationServerUrl).href
  )
    throw new McpOAuthServerMismatchError();
  const {
    authorization_server: _bound,
    scope: _scope,
    authorization_params: _params,
    ...information
  } = client;
  return information;
}

type ServerRef = { id: string; endpoint: string | null; secretId: string | null };
type ActorRef = { spaceId: string; userId: string };

class McpCredentialRefusedError extends Error {}

function isCredentialRefusal(error: unknown): boolean {
  return error instanceof McpCredentialRefusedError || error instanceof McpOAuthServerMismatchError;
}

/** Our own text, so callers may show it as is. */
export class McpOAuthServerMismatchError extends Error {
  constructor() {
    super(
      "MCP OAuth authorization server differs from the one this client was first used with; reconfigure the server's OAuth client",
    );
    this.name = "McpOAuthServerMismatchError";
  }
}

/** The authorization server cannot register a client, so the user must enter one. */
export class McpOAuthClientRequiredError extends Error {
  readonly code = MCP_OAUTH_CLIENT_REQUIRED;
  /** @param revision The server revision the attempt used. */
  constructor(readonly revision: number) {
    super(MCP_DYNAMIC_REGISTRATION_UNSUPPORTED);
    this.name = "McpOAuthClientRequiredError";
  }
}

export class McpReauthorizationRequiredError extends Error {
  readonly code = "MCP_REAUTHORIZATION_REQUIRED";
  constructor(readonly serverId: string) {
    super("MCP authorization expired. Reconnect this server in MCP settings.");
    this.name = "McpReauthorizationRequiredError";
  }
}

/** The grant a provider holds: tokens and when they were issued. */
type TokenGrant = Pick<OAuthState, "tokens" | "obtainedAt">;

/**
 * Writes the provider's material. `storedRefreshToken` is the refresh token
 * this provider last saw in storage; when given, the write keeps the stored
 * grant if another process has since changed it, and returns that grant.
 * Writes carrying newly issued tokens omit it and always win.
 */
type PersistMaterial = (
  material: OAuthMaterial,
  storedRefreshToken?: string | null,
) => Promise<TokenGrant | undefined>;

type ProviderOptions = {
  redirectUri?: string;
  state?: string;
  onAuthorization?: (url: URL) => void;
  onPersisted?: (record: { id: string; ref: string; material: OAuthMaterial }) => void;
  /** Renews the grant under the server's credential lock and returns the grant now stored. */
  refresh?: (heldRefreshToken: string) => Promise<TokenGrant>;
  /** The instance opt-in that lets OAuth URLs use plain HTTP on a private network. */
  allowPrivateEndpoint?: boolean;
};

/** Refresh before expiry to cover clock skew and request time. */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

/** The OpenID Connect scope that asks the authorization server for a refresh token. */
const OFFLINE_ACCESS = "offline_access";

/** When the access token lapses, if the grant says. */
export function accessTokenExpiresAt(oauth: OAuthState | undefined): number | undefined {
  const lifetimeSeconds = oauth?.tokens?.expires_in;
  if (oauth?.obtainedAt === undefined || lifetimeSeconds === undefined) return undefined;
  return oauth.obtainedAt + lifetimeSeconds * 1000;
}

function accessTokenExpired(oauth: OAuthState | undefined): boolean {
  const expiresAt = accessTokenExpiresAt(oauth);
  return (
    Boolean(oauth?.tokens?.refresh_token) &&
    expiresAt !== undefined &&
    Date.now() >= expiresAt - TOKEN_REFRESH_SKEW_MS
  );
}

// RFC 8707 resource binding: only accept a self-declared canonical resource
// that is itself a well-formed HTTPS (or localhost) URL. Providers like Brex
// advertise an internal alias for their public origin, so cross-host
// resources are allowed, but malformed or cleartext resources are rejected
// and the SDK falls back to deriving the resource from the server URL.
function canonicalResource(
  resource: string | undefined,
  allowPrivateEndpoint = false,
): URL | undefined {
  if (!resource) return undefined;
  try {
    return validateUrl(resource, { allowPrivateEndpoint });
  } catch {
    return undefined;
  }
}

/**
 * The SDK requests the scopes the resource publishes (RFC 9728). `offline_access`
 * is an authorization-server scope, so it never appears there, yet servers such as
 * OpenIddict and Entra issue a refresh token only when it is requested. Without it
 * the connection lapses with the first access token and asks for a reconnect.
 * Those servers issue the refresh token without `prompt=consent`, which would
 * force a consent screen on every reconnect; a server that needs it can get it
 * through the client's `authorization_params`.
 */
function requestOfflineAccess(
  authorizationUrl: URL,
  discovery: OAuthDiscoveryState | undefined,
): void {
  // Without a requested scope the server applies its defaults; `offline_access`
  // alone would narrow the grant to no API scope at all.
  const scope = authorizationUrl.searchParams.get("scope");
  if (!scope) return;
  if (!discovery?.authorizationServerMetadata?.scopes_supported?.includes(OFFLINE_ACCESS)) return;
  const scopes = scope.split(/\s+/);
  if (scopes.includes(OFFLINE_ACCESS)) return;
  authorizationUrl.searchParams.set("scope", [...scopes, OFFLINE_ACCESS].join(" "));
}

/**
 * Client-authentication methods this client can perform, most preferred first: a
 * public client proving itself with PKCE, then a secret in the body, then one in
 * a Basic header. Anything else (`private_key_jwt`, mTLS) needs key material
 * this client does not hold.
 */
const REGISTRATION_AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];

/**
 * The client-authentication method to register with (RFC 7591).
 *
 * A public client -- `none`, holding no secret and proving itself with PKCE -- is
 * the right shape here, but asserting it unconditionally breaks registration
 * outright on an authorization server that does not offer it: the server rejects
 * the whole document with `invalid_client_metadata` rather than registering us
 * with a method it prefers. So the choice follows what the server advertises
 * (RFC 8414), narrowed to the methods above.
 *
 * When the server advertises nothing, the field is omitted so the server applies
 * its own default -- `client_secret_basic` per RFC 8414 S2. A registration that
 * comes back with a client secret is stored and used like any other; the SDK
 * picks the matching method for the token request from the same metadata.
 *
 * A server that advertises methods but none this client can perform is a
 * different case, and omitting the field there would quietly register for
 * `client_secret_basic` -- a method it never offered -- leaving a client that
 * cannot authenticate. Only a client registered out of band can sign in to such
 * a server, which is what the pre-registered client exists for.
 */
function registrationAuthMethod(discovery: OAuthDiscoveryState | undefined): string | undefined {
  const advertised = discovery?.authorizationServerMetadata?.token_endpoint_auth_methods_supported;
  if (!Array.isArray(advertised) || advertised.length === 0) return undefined;
  const usable = REGISTRATION_AUTH_METHODS.find((method) => advertised.includes(method));
  if (!usable)
    throw new Error(
      `${MCP_DYNAMIC_REGISTRATION_UNSUPPORTED} with a client-authentication method this client can perform; it accepts only ${advertised.join(", ")}`,
    );
  return usable;
}

function applyGrant(oauth: OAuthState, grant: TokenGrant): void {
  if (grant.tokens) oauth.tokens = grant.tokens;
  else delete oauth.tokens;
  if (grant.obtainedAt) oauth.obtainedAt = grant.obtainedAt;
  else delete oauth.obtainedAt;
}

/** One SDK OAuth provider backed by the same encrypted material used at runtime. */
export class StoredMcpOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private readonly runtimeState = randomUUID();
  private persistQueue = Promise.resolve();
  private refreshing?: Promise<void>;
  /** The stored grant `wrapFetch` last handed the SDK in place of a token response. */
  private served?: OAuthTokens;
  /** The refresh token storage held when this provider last read or wrote it. */
  private storedRefreshToken: string | null;

  constructor(
    readonly serverId: string,
    private readonly material: OAuthMaterial,
    private readonly persistMaterial: PersistMaterial,
    private readonly options: ProviderOptions = {},
  ) {
    this.storedRefreshToken = material.oauth?.tokens?.refresh_token ?? null;
    if (options.redirectUri) {
      this.material.oauth = { ...(this.material.oauth ?? {}), redirectUri: options.redirectUri };
    }
  }

  get redirectUrl(): string | undefined {
    return this.options.redirectUri ?? this.material.oauth?.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    const redirectUri = this.redirectUrl;
    if (!redirectUri) throw new McpReauthorizationRequiredError(this.serverId);
    const hostname = new URL(redirectUri).hostname;
    const applicationType = hostname === "localhost" || hostname === "127.0.0.1" ? "native" : "web";
    // Only a registration this client is about to make has to match the server; a
    // pre-registered client was given its method out of band, and this document is
    // then read for its scope alone.
    const authMethod = this.material.oauthClient
      ? undefined
      : registrationAuthMethod(this.material.oauth?.discoveryState);
    return {
      redirect_uris: [redirectUri],
      client_name: "Rakazo",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(authMethod ? { token_endpoint_auth_method: authMethod } : {}),
      application_type: applicationType,
      ...(this.configuredScope ? { scope: this.configuredScope } : {}),
    } as OAuthClientMetadata;
  }

  /** The scope configured with the pre-registered client, if any. */
  get configuredScope(): string | undefined {
    return this.material.oauthClient?.scope;
  }

  state(): string {
    return this.options.state ?? this.runtimeState;
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    const client = this.material.oauthClient;
    if (!client) return this.material.oauth?.clientInformation;
    // The SDK saves discovery before asking for the client, so this is the server
    // about to receive it. The first one is kept and written with the next persist.
    const server = this.material.oauth?.discoveryState?.authorizationServerUrl;
    const information = boundClient(client, server);
    if (!client.authorization_server && server)
      this.material.oauthClient = { ...client, authorization_server: new URL(server).href };
    return information;
  }
  /**
   * Take the binding another flow saved for this same client, so the code exchange checks
   * against it instead of this flow's own (possibly different) choice.
   */
  adoptClientBinding(stored: PreRegisteredClient | undefined): void {
    const client = this.material.oauthClient;
    const bound = stored?.authorization_server;
    if (!client || !bound || !sameOAuthClient(client, stored)) return;
    this.material.oauthClient = { ...client, authorization_server: bound };
  }
  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    this.oauth().clientInformation = value;
    await this.persist();
  }
  /**
   * Some providers return a JSON-RPC error with HTTP 200 after access-token
   * expiry, so the SDK's 401-driven refresh does not run. Renew from the stored
   * expiry before returning a token that has lapsed.
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.options.refresh && accessTokenExpired(this.material.oauth)) {
      // Transient setup or transport failures must not discard a usable token.
      await this.renew().catch(() => undefined);
    }
    return this.material.oauth?.tokens;
  }

  /**
   * After a 401 or 403 the SDK refreshes on its own through the transport's
   * fetch. Serve that token request from the locked refresh, so processes share
   * one refresh and never send a refresh token storage has already replaced.
   */
  wrapFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
    return async (input, init) => {
      const body = init?.body instanceof URLSearchParams ? init.body : undefined;
      if (!this.options.refresh || body?.get("grant_type") !== "refresh_token")
        return fetch(input, init);
      // Skip it when a concurrent request already renewed the token the SDK read.
      if (body.get("refresh_token") === this.material.oauth?.tokens?.refresh_token) {
        try {
          await this.renew();
        } catch {
          // The SDK starts re-authorization, which drops the grant, on any other failure.
          return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
        }
      }
      const tokens = this.material.oauth?.tokens;
      this.served = tokens;
      return tokens
        ? Response.json(tokens)
        : Response.json({ error: "invalid_grant" }, { status: 400 });
    };
  }

  /**
   * The server refused the held access token before its stated expiry. Renew it, or drop
   * it so the server reads as needing a reconnect when no refresh can replace it.
   */
  async replaceRejectedToken(): Promise<void> {
    const held = this.material.oauth?.tokens;
    await this.renew();
    const tokens = this.material.oauth?.tokens;
    if (tokens && tokens !== held) return;
    if (tokens) await this.invalidateCredentials("tokens");
    throw new McpReauthorizationRequiredError(this.serverId);
  }

  /** Renews under the credential lock; concurrent callers share one refresh. */
  private renew(): Promise<void> {
    this.refreshing ??= this.refreshHeldGrant().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshHeldGrant(): Promise<void> {
    const oauth = this.material.oauth;
    const held = oauth?.tokens;
    if (!oauth || !held?.refresh_token || !this.options.refresh) return;
    let grant: TokenGrant;
    try {
      grant = await this.options.refresh(held.refresh_token);
    } catch (error) {
      if (isCredentialRefusal(error) && this.material.oauth === oauth && oauth.tokens === held)
        applyGrant(oauth, {});
      throw error;
    }
    // A write that landed while the refresh ran is newer than the grant it replaced.
    if (this.material.oauth !== oauth || oauth.tokens !== held) return;
    applyGrant(oauth, grant);
    this.storedRefreshToken = grant.tokens?.refresh_token ?? null;
  }

  async saveTokens(value: OAuthTokens): Promise<void> {
    const oauth = this.oauth();
    // The locked refresh behind `wrapFetch` already stored this grant.
    if (this.served && oauth.tokens === this.served && isDeepStrictEqual(value, this.served))
      return;
    oauth.tokens = value;
    oauth.obtainedAt = Date.now();
    await this.persist(true);
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    let authorizationUrl: URL;
    try {
      authorizationUrl = validateUrl(url, {
        allowHttpLocalhost: true,
        allowPrivateEndpoint: this.options.allowPrivateEndpoint,
        maxUrlLength: MAX_AUTHORIZATION_URL_LENGTH,
      });
    } catch (error) {
      if (!this.options.onAuthorization) {
        await this.invalidateCredentials("tokens");
      }
      throw error;
    }
    const extra = this.material.oauthClient?.authorization_params;
    if (extra) {
      for (const [key, value] of Object.entries(parseMcpOAuthAuthorizationParams(extra)))
        if (!authorizationUrl.searchParams.has(key)) authorizationUrl.searchParams.set(key, value);
    }
    requestOfflineAccess(authorizationUrl, this.material.oauth?.discoveryState);
    // Configured parameters are added after validation; keep the final URL within bounds too.
    if (authorizationUrl.href.length > MAX_AUTHORIZATION_URL_LENGTH) {
      if (!this.options.onAuthorization) await this.invalidateCredentials("tokens");
      throw new Error(`MCP authorization URL exceeds ${MAX_AUTHORIZATION_URL_LENGTH} characters`);
    }
    this.authorizationUrl = authorizationUrl;
    if (this.options.onAuthorization) {
      this.options.onAuthorization(authorizationUrl);
      return;
    }
    // Runtime re-auth needs the user; drop the dead tokens so status reads "reconnect".
    await this.invalidateCredentials("tokens");
    throw new McpReauthorizationRequiredError(this.serverId);
  }
  async saveCodeVerifier(value: string): Promise<void> {
    this.oauth().codeVerifier = value;
    await this.persist();
  }
  codeVerifier(): string {
    const verifier = this.material.oauth?.codeVerifier;
    if (!verifier) throw new Error("OAuth PKCE verifier is missing");
    return verifier;
  }
  async validateResourceURL(_serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    return canonicalResource(resource, this.options.allowPrivateEndpoint);
  }
  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    this.oauth().discoveryState = value;
    await this.persist();
  }
  /** When the held access token lapses, if the grant says. */
  accessTokenExpiresAt(): number | undefined {
    return accessTokenExpiresAt(this.material.oauth);
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.material.oauth?.discoveryState;
  }
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all") {
      const redirectUri = this.redirectUrl;
      this.material.oauth = redirectUri ? { redirectUri } : undefined;
    } else if (this.material.oauth) {
      if (scope === "client") delete this.material.oauth.clientInformation;
      if (scope === "tokens") {
        delete this.material.oauth.tokens;
        delete this.material.oauth.obtainedAt;
      }
      if (scope === "verifier") delete this.material.oauth.codeVerifier;
      if (scope === "discovery") delete this.material.oauth.discoveryState;
    }
    await this.persist();
  }

  private oauth(): OAuthState {
    if (!this.material.oauth) this.material.oauth = {};
    return this.material.oauth;
  }

  /** `issued` marks a write carrying tokens the server just issued, which replace any stored grant. */
  private async persist(issued = false): Promise<void> {
    const snapshot = structuredClone(this.material);
    const held = this.material.oauth?.tokens;
    const storedRefreshToken = issued ? undefined : this.storedRefreshToken;
    const next = this.persistQueue.then(async () => {
      const kept = await this.persistMaterial(snapshot, storedRefreshToken);
      const oauth = this.material.oauth;
      if (kept && oauth && oauth.tokens === held) applyGrant(oauth, kept);
      this.storedRefreshToken = (kept ?? snapshot.oauth)?.tokens?.refresh_token ?? null;
    });
    this.persistQueue = next.catch(() => undefined);
    await next;
  }
}

type Pending = {
  serverId: string;
  spaceId: string;
  userId: string;
  /** The MCP endpoint, or for a stdio server (which has none) its authorization server. */
  endpoint: string;
  stdio: boolean;
  /** The stored authorization generation this flow began at. */
  generation: number;
  provider: StoredMcpOAuthProvider;
  createdAt: number;
  expiry?: ReturnType<typeof setTimeout>;
};

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING_SESSIONS = 100;

/** OAuth traffic runs through the same URL policy as runtime MCP requests
 * (HTTPS enforced, redirects rejected), with the endpoint-origin fallback
 * layered on top for providers like Brex. */
function oauthFetch(
  endpoint: string,
  network: RemoteTransportDependencies,
  material: OAuthMaterial = {},
  allowPrivateEndpoint = false,
): {
  fetch: typeof fetch;
  close: () => Promise<void>;
  headers: Record<string, string>;
  publicError: (error: unknown, message: string) => Error;
} {
  const url = new URL(endpoint);
  const localHttp = url.protocol === "http:" && isLocalhostOrLoopbackIp(url.hostname);
  const headers = {
    ...material.headers,
    ...(material.secret
      ? {
          Authorization: material.secret.startsWith("Bearer ")
            ? material.secret
            : `Bearer ${material.secret}`,
        }
      : {}),
  };
  const safeFetch = secureFetch(
    url,
    {
      allowHttpLocalhost: localHttp,
      allowLocalHttpCredentials: localHttp,
      allowPrivateEndpoint,
    },
    { headers },
    network,
  );
  const fallbackFetch = withEndpointOriginFallback(url.origin, safeFetch);
  // Errors raised by this network layer (URL policy, redirects, unreachable
  // hosts) carry only our own text. Anything else was built by the SDK from an
  // upstream response and may quote its body, so the caller gets `message`.
  // A structured OAuth error is the protocol's own failure: keep its status,
  // error code, and description instead of hiding them behind `message`.
  const networkErrors = new WeakSet<Error>();
  let rejection: OAuthRejection | undefined;
  const recordingFetch: typeof fetch = async (input, init) => {
    try {
      const response = await fallbackFetch(input, init);
      if (!response.ok) {
        const next = await readOAuthRejection(response);
        if (next) rejection = next;
      }
      return response;
    } catch (error) {
      if (error instanceof Error) networkErrors.add(error);
      throw error;
    }
  };
  return {
    headers,
    fetch: recordingFetch,
    close: () => safeFetch.close(),
    publicError: (error, message) => {
      if (error instanceof Error && networkErrors.has(error)) return error;
      const secrets = oauthMaterialSecrets(material);
      const sdk = sanitizeConnectorError(error, secrets);
      const surfaced = rejection ? formatOAuthRejection(rejection, sdk, secrets) : undefined;
      getLogger().warn(`${message}: ${surfaced ?? sdk}`);
      return new Error(surfaced ? `${message}: ${surfaced}` : message);
    },
  };
}

/**
 * Some servers (Google's MCP servers, for one) answer the handshake without a
 * token and only challenge tool calls, so connecting never asks for
 * authorization. When the user asks to connect and the server publishes where to
 * authorize (RFC 9728), start that authorization. Without that metadata the SDK
 * would guess the server's own origin and could try to register a client there.
 */
async function startAdvertisedAuthorization(
  provider: StoredMcpOAuthProvider,
  serverUrl: URL,
  fetchFn: typeof fetch,
): Promise<void> {
  let resourceMetadata: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>>;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl, undefined, fetchFn);
  } catch {
    return;
  }
  const advertised = resourceMetadata.authorization_servers?.[0];
  if (!advertised) return;
  // Hand the SDK the discovery just verified. Left to rediscover, a failed second
  // read would fall back to the MCP server's own origin and bind the client there.
  await provider.saveDiscoveryState({ authorizationServerUrl: advertised, resourceMetadata });
  await auth(provider, withScope({ serverUrl, fetchFn }, provider));
}

function withScope<T extends object>(options: T, provider: StoredMcpOAuthProvider): T {
  return provider.configuredScope ? { ...options, scope: provider.configuredScope } : options;
}

/**
 * A stdio server has no MCP endpoint to challenge or advertise anything, so
 * authorization starts at the issuer the client was registered with. The SDK
 * gets that issuer as both the cached discovery and the server URL; with no
 * resource metadata, no `resource` parameter is requested.
 */
async function authorizeAtIssuer(
  provider: StoredMcpOAuthProvider,
  authorizationServer: string,
  fetchFn: typeof fetch,
  authorizationCode?: string,
): Promise<void> {
  if (authorizationCode === undefined)
    await provider.saveDiscoveryState({ authorizationServerUrl: authorizationServer });
  await auth(
    provider,
    withScope(
      {
        serverUrl: new URL(authorizationServer),
        fetchFn,
        ...(authorizationCode === undefined ? {} : { authorizationCode }),
      },
      provider,
    ),
  );
}

/** The MCP endpoint probe of a remote server: connect, and if it does not ask for
 * authorization, start the one it advertises. */
async function startRemoteAuthorization(
  provider: StoredMcpOAuthProvider,
  endpoint: URL,
  network: ReturnType<typeof oauthFetch>,
  authorizationStarted: () => boolean,
): Promise<void> {
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: network.headers },
    authProvider: provider,
    fetch: provider.wrapFetch(network.fetch),
  });
  const client = new Client({ name: "rakazo-oauth", version: "0.1.0" });
  const signal = AbortSignal.timeout(15_000);
  try {
    await client.connect(transport, { signal, timeout: 15_000 });
    if (!authorizationStarted() && !(await provider.tokens()))
      await startAdvertisedAuthorization(provider, endpoint, provider.wrapFetch(network.fetch));
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** A stdio server's static env is never sent anywhere; only its secrets matter for redaction. */
function withoutRequestCredentials(material: OAuthMaterial): OAuthMaterial {
  const { secret: _secret, headers: _headers, ...rest } = material;
  return rest;
}

type OAuthRejection = { status: number; code: string; description: string };

const OAUTH_ERROR_BODY_MAX_CHARS = 8_000;
// A JavaScript character is at most 3 UTF-8 bytes, so a longer body cannot pass the character cap.
const OAUTH_ERROR_BODY_MAX_BYTES = OAUTH_ERROR_BODY_MAX_CHARS * 3;

/** Read an RFC 6749 error object without consuming the body the SDK still needs. */
async function readOAuthRejection(response: Response): Promise<OAuthRejection | undefined> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > OAUTH_ERROR_BODY_MAX_BYTES) {
    return undefined;
  }
  let text: string;
  try {
    const bytes = await readBoundedResponseBytes(response.clone(), {
      maxBytes: OAUTH_ERROR_BODY_MAX_BYTES,
      tooLargeMessage: "OAuth error response is too large",
      read: (operation) => operation(),
    });
    text = new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
  if (text.length > OAUTH_ERROR_BODY_MAX_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const code = record.error;
  if (typeof code !== "string" || !/^[\w.-]{1,64}$/.test(code)) return undefined;
  const description = typeof record.error_description === "string" ? record.error_description : "";
  return { status: response.status, code, description };
}

/** Surface a rejection only when it is the error the SDK just threw.
 *
 * Earlier challenges (a 401 while discovery continues) must not replace a
 * later, different failure. The SDK message is already redacted and
 * length-limited, so the description is cleaned the same way before comparing.
 * Unstructured bodies stay out of the caller-facing message; the log still
 * receives the SDK text. */
function formatOAuthRejection(
  rejection: OAuthRejection,
  sdk: string,
  secrets: string[],
): string | undefined {
  if (sdk.includes("Raw body:")) return undefined;
  // Redact the whole description first. A later cut can land inside a secret, and
  // the redactor only matches the complete value.
  const cleaned = sanitizeConnectorError(rejection.description, secrets);
  if (cleaned.trim() !== sdk.trim()) return undefined;
  const description = cleaned.replace(/\s+/g, " ").trim().slice(0, 300);
  const detail = description ? `${rejection.code}: ${description}` : rejection.code;
  return sanitizeConnectorError(`HTTP ${rejection.status} ${detail}`, secrets);
}

type MaterialSnapshot = {
  server: { endpoint: string | null; secretId: string | null };
  secret: { id: string; ciphertext: string } | null;
};

/** Serializes changes to one MCP server's stored credential across the API and worker. */
export function lockMcpOAuthMaterial(
  tx: Prisma.TransactionClient,
  serverId: string,
): Promise<unknown> {
  return advisoryLock(tx, "mcp-oauth-material", serverId);
}

/** One refresh-token grant against the stored authorization server. */
async function requestRefresh(
  material: OAuthMaterial,
  refreshToken: string,
  fetchFn: typeof fetch,
  allowPrivateEndpoint: boolean,
): Promise<OAuthTokens> {
  const discovery = material.oauth?.discoveryState;
  const clientInformation = material.oauthClient
    ? boundClient(material.oauthClient, discovery?.authorizationServerUrl)
    : material.oauth?.clientInformation;
  if (!discovery?.authorizationServerUrl || !clientInformation)
    throw new Error("MCP OAuth state cannot refresh");
  return refreshAuthorization(discovery.authorizationServerUrl, {
    metadata: discovery.authorizationServerMetadata,
    clientInformation,
    refreshToken,
    resource: canonicalResource(discovery.resourceMetadata?.resource, allowPrivateEndpoint),
    fetchFn: (input, init) =>
      fetchFn(input, { ...init, signal: AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS) }),
  });
}

/** A first-use binding may be missing on one side; two different bindings are not the same client. */
function sameOAuthClient(
  left: PreRegisteredClient | undefined,
  right: PreRegisteredClient | undefined,
): boolean {
  const bound = left?.authorization_server && right?.authorization_server;
  return (
    left?.client_id === right?.client_id &&
    left?.client_secret === right?.client_secret &&
    left?.scope === right?.scope &&
    left?.authorization_params === right?.authorization_params &&
    (!bound || left?.authorization_server === right?.authorization_server)
  );
}

/**
 * The authorization server a flow will send its client to: the binding it carries, else
 * the server its discovery found (a flow that began with an unbound client).
 */
function flowAuthorizationServer(material: OAuthMaterial): string | undefined {
  const bound = material.oauthClient?.authorization_server;
  if (bound) return bound;
  const discovered = material.oauth?.discoveryState?.authorizationServerUrl;
  return discovered ? new URL(discovered).href : undefined;
}

/** Whether a flow targets a server other than the one the stored client is bound to. */
function conflictsWithBinding(stored: PreRegisteredClient | undefined, flow: OAuthMaterial) {
  const bound = stored?.authorization_server;
  const target = flowAuthorizationServer(flow);
  return Boolean(bound && target && bound !== target);
}

/** What the settings UI may know about a server's OAuth setup; never a credential. */
export type McpOAuthSummary = {
  status: "none" | "connected" | "reconnect";
  clientId: string | null;
  /** Whether the stored material holds a credential; a lone generation marker holds none. */
  credential: boolean;
};

/** Whether the material holds anything beyond OAuth bookkeeping. */
function hasCredential(material: OAuthMaterial): boolean {
  return Boolean(
    material.secret ||
      material.args?.length ||
      Object.keys(material.env ?? {}).length ||
      Object.keys(material.files ?? {}).length ||
      Object.keys(material.headers ?? {}).length ||
      material.oauthClient ||
      material.oauth,
  );
}

function summarize(material: OAuthMaterial): McpOAuthSummary {
  const status = material.oauth?.tokens ? "connected" : material.oauth ? "reconnect" : "none";
  return {
    status,
    clientId: material.oauthClient?.client_id ?? null,
    credential: hasCredential(material),
  };
}

export class McpOAuthBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly network: RemoteTransportDependencies = {},
    private readonly allowPrivateEndpoint = false,
  ) {}

  async statusFor(server: ServerRef, context: ActorRef): Promise<McpOAuthSummary["status"]> {
    return (await this.summaryFor(server, context)).status;
  }

  async summaryFor(server: ServerRef, context: ActorRef): Promise<McpOAuthSummary> {
    const { material } = await this.loadMaterial(server, context);
    return summarize(material);
  }

  async summaryForCiphertext(
    ciphertext: string | undefined,
    recordId: string | undefined,
  ): Promise<McpOAuthSummary> {
    return summarize(ciphertext && recordId ? await this.read(ciphertext, recordId) : {});
  }

  async providerFor(
    server: ServerRef,
    context: ActorRef,
    loaded?: { material: OAuthMaterial; secretId?: string },
    onPersisted?: ProviderOptions["onPersisted"],
  ): Promise<StoredMcpOAuthProvider | undefined> {
    const material = loaded ?? (await this.loadMaterial(server, context));
    if (!material.material.oauth) return undefined;
    return this.createProvider(server, context, material, { onPersisted });
  }

  async begin(input: {
    serverId: string;
    spaceId: string;
    userId: string;
    redirectUri: string;
  }): Promise<
    | { status: "authorization_required"; sessionId: string; authorizationUrl: string }
    | { status: "already_connected" | "authorization_not_requested" }
  > {
    const server = await this.prisma.mcpServer.findFirst({
      where: {
        id: input.serverId,
        ...availableInSpace(input),
        enabled: true,
      },
    });
    if (!server) throw new Error("MCP server endpoint is required for OAuth");
    const context = { spaceId: input.spaceId, userId: input.userId };
    const loaded = await this.loadMaterial(server, context);
    // A stdio server has no MCP endpoint; OAuth runs against its authorization server.
    const target = server.endpoint ?? loaded.material.oauthClient?.authorization_server;
    if (!target) throw new Error("MCP server endpoint is required for OAuth");
    await this.sweepExpiredPending();
    let actorPending = 0;
    for (const pending of this.pending.values()) {
      if (pending.spaceId === input.spaceId && pending.userId === input.userId) {
        actorPending += 1;
      }
    }
    if (actorPending >= MAX_PENDING_SESSIONS) {
      throw new Error("Too many pending MCP authorization attempts; wait and try again");
    }
    const activeCount = await this.prisma.mcpOAuthSession.count({
      where: { spaceId: input.spaceId, userId: input.userId },
    });
    if (activeCount >= MAX_PENDING_SESSIONS) {
      throw new Error("Too many pending MCP authorization attempts; wait and try again");
    }
    const sessionId = randomUUID();
    let authorizationUrl: URL | undefined;
    const provider = this.createProvider(server, context, loaded, {
      redirectUri: input.redirectUri,
      state: sessionId,
      onAuthorization: (url) => {
        authorizationUrl = url;
      },
    });
    // Never destroy working tokens here: if this attempt fails (network error,
    // cancelled popup), the server keeps its valid connection. The SDK itself
    // invalidates dead tokens when a refresh is rejected with invalid_grant.
    const networkFetch = oauthFetch(
      target,
      this.network,
      server.endpoint ? loaded.material : withoutRequestCredentials(loaded.material),
      this.allowPrivateEndpoint,
    );
    try {
      if (server.endpoint)
        await startRemoteAuthorization(
          provider,
          new URL(server.endpoint),
          networkFetch,
          () => authorizationUrl !== undefined,
        );
      else {
        // tokens() renews an expiring grant first; a grant still expired afterwards (no
        // refresh token, or the refresh keeps failing) cannot start the process, so the
        // user re-authorizes instead of being told it is connected.
        const tokens = await provider.tokens();
        const expiresAt = accessTokenExpiresAt(loaded.material.oauth);
        if (!tokens || (expiresAt !== undefined && Date.now() >= expiresAt))
          await authorizeAtIssuer(provider, target, provider.wrapFetch(networkFetch.fetch));
      }
    } catch (error) {
      if (error instanceof McpOAuthServerMismatchError) throw error;
      if (needsMcpOAuthClient(error)) throw new McpOAuthClientRequiredError(server.revision);
      if (!authorizationUrl) throw networkFetch.publicError(error, "Could not start MCP OAuth");
    } finally {
      await networkFetch.close().catch(() => undefined);
    }
    if (!authorizationUrl) {
      if (await provider.tokens()) {
        return { status: "already_connected" };
      }
      return { status: "authorization_not_requested" };
    }
    const sessionMaterial = await this.secrets.put(
      JSON.stringify(loaded.material),
      {
        operationId: "mcp.oauth.session",
        traceId: "mcp.oauth.session",
        spaceId: input.spaceId,
        userId: input.userId,
        botId: "mcp",
        signal: new AbortController().signal,
      },
      { recordId: sessionId, ephemeral: true },
    );
    await this.prisma.mcpOAuthSession.create({
      data: {
        id: sessionId,
        serverId: server.id,
        spaceId: input.spaceId,
        userId: input.userId,
        endpoint: target,
        redirectUri: input.redirectUri,
        oauthCiphertext: sessionMaterial.ciphertext,
      },
    });
    const expiry = setTimeout(() => {
      this.pending.delete(sessionId);
      void this.prisma.mcpOAuthSession
        .deleteMany({ where: { id: sessionId } })
        .catch(() => undefined);
    }, PENDING_TTL_MS);
    expiry.unref?.();
    this.pending.set(sessionId, {
      serverId: server.id,
      spaceId: input.spaceId,
      userId: input.userId,
      endpoint: target,
      stdio: !server.endpoint,
      generation: loaded.material.oauthGeneration ?? 0,
      provider,
      createdAt: Date.now(),
      expiry,
    });
    return {
      status: "authorization_required",
      sessionId,
      authorizationUrl: authorizationUrl.toString(),
    };
  }

  async complete(input: {
    sessionId: string;
    code: string;
    state: string;
    spaceId: string;
    userId: string;
  }): Promise<{ serverId: string; revision: number }> {
    await this.sweepExpiredPending();
    if (input.state !== input.sessionId) {
      throw new Error("MCP OAuth session is invalid or expired");
    }
    let pending = this.pending.get(input.sessionId);
    if (pending && (pending.spaceId !== input.spaceId || pending.userId !== input.userId)) {
      pending = undefined;
    }
    if (!pending) {
      const session = await this.prisma.mcpOAuthSession.findFirst({
        where: {
          id: input.sessionId,
          spaceId: input.spaceId,
          userId: input.userId,
          createdAt: { gte: new Date(Date.now() - PENDING_TTL_MS) },
        },
      });
      if (!session) throw new Error("MCP OAuth session is invalid or expired");
      const server = await this.prisma.mcpServer.findFirst({
        where: {
          id: session.serverId,
          ...availableInSpace(input),
          enabled: true,
        },
      });
      if (!server) throw new Error("MCP OAuth session is invalid or expired");
      const context = { spaceId: input.spaceId, userId: input.userId };
      const loaded = {
        material: await this.read(session.oauthCiphertext, session.id),
        ...(server.secretId ? { secretId: server.secretId } : {}),
      };
      pending = {
        serverId: server.id,
        spaceId: input.spaceId,
        userId: input.userId,
        endpoint: session.endpoint,
        stdio: !server.endpoint,
        generation: loaded.material.oauthGeneration ?? 0,
        provider: this.createProvider(server, context, loaded, {
          redirectUri: session.redirectUri,
          state: session.id,
        }),
        createdAt: session.createdAt.getTime(),
        expiry: undefined,
      };
    }
    // Consume the session up front so a failed token exchange cannot be
    // retried with a replayed code; the user starts a fresh flow instead.
    this.pending.delete(input.sessionId);
    if (pending.expiry) clearTimeout(pending.expiry);
    const consumed = await this.prisma.mcpOAuthSession.deleteMany({
      where: {
        id: input.sessionId,
        spaceId: input.spaceId,
        userId: input.userId,
      },
    });
    if (consumed.count !== 1) throw new Error("MCP OAuth session is invalid or expired");
    // The exchange sends the client secret: check it against the binding stored now, not
    // the one this flow started with, in case an overlapping flow bound the client first.
    const current = await this.prisma.mcpServer.findFirst({
      where: { id: pending.serverId, ...availableInSpace(input) },
      select: { id: true, endpoint: true, secretId: true },
    });
    if (current) {
      const stored = await this.loadMaterial(current, input);
      pending.provider.adoptClientBinding(stored.material.oauthClient);
    }
    const networkFetch = oauthFetch(
      pending.endpoint,
      this.network,
      // Only for redacting errors: the exchange sends the client secret, but none of
      // the server's static headers.
      { oauth: { clientInformation: pending.provider.clientInformation() } },
      this.allowPrivateEndpoint,
    );
    try {
      if (pending.stdio)
        await authorizeAtIssuer(pending.provider, pending.endpoint, networkFetch.fetch, input.code);
      else {
        const transport = new StreamableHTTPClientTransport(new URL(pending.endpoint), {
          authProvider: pending.provider,
          fetch: networkFetch.fetch,
        });
        try {
          await transport.finishAuth(input.code);
        } finally {
          await transport.close().catch(() => undefined);
        }
      }
    } catch (error) {
      throw networkFetch.publicError(error, "Could not complete MCP OAuth");
    } finally {
      await networkFetch.close().catch(() => undefined);
    }
    const tokens = await pending.provider.tokens();
    // A disconnect raised the stored generation after this sign-in began, so its tokens
    // cannot connect the server; reject the completion instead of reporting it, however
    // the exchange itself went. So is an endpoint edit since. The revision is bumped under
    // the same lock, so runtime sessions rebuild and a later edit keeps its newer revision.
    // The secret read can be a remote call, so the lock gets refresh's limits, not the
    // default transaction timeout.
    const { revision } = await withRefreshLock(
      this.prisma,
      (tx) => lockMcpOAuthMaterial(tx, pending.serverId),
      async (tx) => {
        const endpoint = pending.stdio ? null : pending.endpoint;
        const snapshot = await this.snapshot(tx, pending.serverId, input, endpoint);
        const material = snapshot.secret
          ? await this.read(snapshot.secret.ciphertext, snapshot.secret.id)
          : {};
        if ((material.oauthGeneration ?? 0) !== pending.generation)
          throw new Error("MCP OAuth session is invalid or expired");
        if (!tokens) throw new Error("MCP OAuth authorization failed");
        return tx.mcpServer.update({
          where: { id: pending.serverId },
          data: { revision: { increment: 1 } },
        });
      },
    );
    return { serverId: pending.serverId, revision };
  }

  private async sweepExpiredPending(): Promise<void> {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [sessionId, pending] of this.pending) {
      if (pending.createdAt < cutoff) {
        this.discardPending(sessionId, pending);
      }
    }
    await runAsSystem("expire abandoned MCP sign-ins in every Space", () =>
      this.prisma.mcpOAuthSession.deleteMany({ where: { createdAt: { lt: new Date(cutoff) } } }),
    );
  }

  private discardPending(sessionId: string, pending: Pending): void {
    if (pending.expiry) clearTimeout(pending.expiry);
    this.pending.delete(sessionId);
  }

  /** Returns the revision the disconnect committed, or undefined when the server is not found. */
  async disconnect(input: {
    serverId: string;
    spaceId: string;
    userId: string;
  }): Promise<number | undefined> {
    // End this actor's pending sign-ins for the server too, so a callback that lands after
    // the disconnect cannot finish an authorization the user called off.
    for (const [sessionId, pending] of this.pending) {
      if (
        pending.serverId === input.serverId &&
        pending.spaceId === input.spaceId &&
        pending.userId === input.userId
      )
        this.discardPending(sessionId, pending);
    }
    await this.prisma.mcpOAuthSession.deleteMany({
      where: { serverId: input.serverId, spaceId: input.spaceId, userId: input.userId },
    });
    const server = await this.prisma.mcpServer.findFirst({
      where: { id: input.serverId, ...availableInSpace(input) },
    });
    if (!server) return undefined;
    // With no stored credential the generation is still raised, so a first authorization
    // still in flight cannot connect the server after the disconnect.
    const row = server.secretId
      ? await this.prisma.secret.findFirst({
          where: { id: server.secretId, ...itemSecretIn(input) },
        })
      : null;
    const material = row ? await this.read(row.ciphertext, row.id) : {};
    delete material.oauth;
    // The generation is raised from the stored value inside each retry of the write, so
    // this disconnect ends every flow still in flight, including one that began after an
    // earlier disconnect committed.
    let revision: number | undefined;
    await this.replaceMaterial(server.id, material, input, {
      incrementRevision: true,
      raiseGeneration: true,
      onCommitted: (committed) => {
        revision = committed;
      },
    });
    return revision;
  }

  private async loadMaterial(
    server: ServerRef,
    context: ActorRef,
  ): Promise<{ material: OAuthMaterial; secretId?: string }> {
    if (!server.secretId) return { material: {} };
    const row = await this.prisma.secret.findFirst({
      where: { id: server.secretId, ...itemSecretIn(context) },
    });
    return row
      ? { material: await this.read(row.ciphertext, row.id), secretId: row.id }
      : { material: {} };
  }

  private createProvider(
    server: ServerRef,
    context: ActorRef,
    loaded: { material: OAuthMaterial; secretId?: string },
    options: ProviderOptions = {},
  ): StoredMcpOAuthProvider {
    const endpoint = server.endpoint;
    // A stdio server has no endpoint; its refresh goes to the client's authorization server.
    const target = endpoint ?? loaded.material.oauthClient?.authorization_server;
    return new StoredMcpOAuthProvider(
      server.id,
      loaded.material,
      (material, storedRefreshToken) =>
        this.replaceMaterial(server.id, material, context, {
          expectedEndpoint: endpoint,
          onPersisted: options.onPersisted,
          storedRefreshToken,
        }),
      {
        ...(target
          ? {
              // The refresh writes its secret inside the lock transaction, so the change
              // notification waits for that pooled connection to come back.
              refresh: (held: string) =>
                holdSecretNotifications(() =>
                  this.refreshGrant(
                    server.id,
                    endpoint,
                    target,
                    context,
                    held,
                    options.onPersisted,
                  ),
                ),
            }
          : {}),
        allowPrivateEndpoint: this.allowPrivateEndpoint,
        ...options,
      },
    );
  }

  /**
   * Authorization servers rotate refresh tokens for public clients, so a
   * refresh token works once. The API and worker each hold their own copy of
   * the grant: the refresh runs under the server's credential lock against the
   * stored grant, and a process whose copy is stale adopts the stored one
   * instead of spending a token another process already rotated.
   */
  private async refreshGrant(
    serverId: string,
    endpoint: string | null,
    target: string,
    context: ActorRef,
    held: string,
    onPersisted?: ProviderOptions["onPersisted"],
  ): Promise<TokenGrant> {
    // Resolve the network before taking a connection for the lock.
    const network = oauthFetch(target, this.network, {}, this.allowPrivateEndpoint);
    let stored: { id: string; ciphertext: string } | undefined;
    let rotated: { material: OAuthMaterial; grant: TokenGrant; spent: string } | undefined;
    try {
      const result = await persistPreparedSecret(
        this.prisma,
        this.secrets,
        undefined,
        () =>
          withRefreshLock(
            this.prisma,
            (tx) => lockMcpOAuthMaterial(tx, serverId),
            async (tx) => {
              const snapshot = await this.snapshot(tx, serverId, context, endpoint);
              const material = snapshot.secret
                ? await this.read(snapshot.secret.ciphertext, snapshot.secret.id)
                : {};
              const oauth = material.oauth;
              const current = oauth?.tokens?.refresh_token;
              if (!oauth || !current || (current !== held && !accessTokenExpired(oauth)))
                return { grant: { tokens: oauth?.tokens, obtainedAt: oauth?.obtainedAt } };
              let grant: TokenGrant;
              try {
                grant = {
                  tokens: await requestRefresh(
                    material,
                    current,
                    network.fetch,
                    this.allowPrivateEndpoint,
                  ),
                };
                grant.obtainedAt = Date.now();
              } catch (error) {
                // Under the lock `current` is the stored token, so a rejection
                // means the grant is revoked, not rotated by another process.
                if (!(error instanceof InvalidGrantError)) throw error;
                grant = {};
              }
              applyGrant(oauth, grant);
              if (grant.tokens) rotated = { material, grant, spent: current };
              stored = await this.putMaterial(material, context);
              if (!(await this.commitMaterial(tx, serverId, context, snapshot, stored)))
                throw new Error("MCP credentials changed during refresh; retry");
              return { grant, record: { id: stored.id, ref: stored.ciphertext, material } };
            },
          ),
        (result) => {
          if (result.record) onPersisted?.(result.record);
        },
      );
      return result.grant;
    } catch (error) {
      if (stored) await deleteSecretBestEffort(this.secrets, stored.ciphertext, stored.id);
      if (isCredentialRefusal(error) || !rotated) throw error;
      // The authorization server already rotated the grant, so the stored one is spent.
      // Store the new one over the grant it replaced; a login or disconnect that landed
      // meanwhile wins. On a transient failure, keep observed state or the issued grant.
      getLogger().warn("MCP OAuth refresh commit failed; storing the rotated grant again");
      let observed: TokenGrant | undefined;
      try {
        const kept = await this.replaceMaterial(serverId, rotated.material, context, {
          expectedEndpoint: endpoint,
          onPersisted,
          storedRefreshToken: rotated.spent,
          replaceCleared: true,
          onKept: (grant) => {
            observed = grant;
          },
        });
        return kept ?? rotated.grant;
      } catch (fallbackError) {
        if (isCredentialRefusal(fallbackError)) throw fallbackError;
        return observed ?? rotated.grant;
      }
    } finally {
      await network.close().catch(() => undefined);
    }
  }

  private async replaceMaterial(
    serverId: string,
    material: OAuthMaterial,
    context: ActorRef,
    options: {
      incrementRevision?: boolean;
      expectedEndpoint?: string | null;
      onPersisted?: ProviderOptions["onPersisted"];
      storedRefreshToken?: string | null;
      replaceCleared?: boolean;
      /** Raise the stored authorization generation from the value each retry re-reads. */
      raiseGeneration?: boolean;
      onKept?: (grant: TokenGrant) => void;
      onCommitted?: (revision: number) => void;
    } = {},
  ): Promise<TokenGrant | undefined> {
    // Take a DB-only snapshot, then do provider I/O with no transaction open.
    // Recheck both the pointer and ciphertext under the existing advisory lock.
    for (let attempt = 0; attempt < 5; attempt++) {
      const snapshot = await this.prisma.$transaction((tx) =>
        this.snapshot(tx, serverId, context, options.expectedEndpoint),
      );
      const nextMaterial = snapshot.secret
        ? await this.read(snapshot.secret.ciphertext, snapshot.secret.id)
        : {};
      const storedOAuth = nextMaterial.oauth;
      let kept: TokenGrant | undefined;
      if (material.oauth) {
        // OAuth state belongs to the client that obtained it; a client changed in
        // settings meanwhile has already dropped the grant this write carries.
        if (!sameOAuthClient(material.oauthClient, nextMaterial.oauthClient))
          throw new McpCredentialRefusedError(
            "MCP OAuth client changed during authorization; reconnect this server",
          );
        // Overlapping flows may have bound the same unbound client to different servers;
        // the first binding saved wins and any other flow's state is refused.
        if (conflictsWithBinding(nextMaterial.oauthClient, material))
          throw new McpOAuthServerMismatchError();
        // A disconnect discarded the stored state and raised its generation; a write from
        // that earlier flow, issued tokens included, must not bring the grant back.
        const superseded = (material.oauthGeneration ?? 0) !== (nextMaterial.oauthGeneration ?? 0);
        const bound = material.oauthClient?.authorization_server;
        // A superseded write keeps the stored client exactly as stored: a first-use
        // binding belongs to an authorization the user ended.
        if (
          !superseded &&
          nextMaterial.oauthClient &&
          bound &&
          !nextMaterial.oauthClient.authorization_server
        )
          nextMaterial.oauthClient = { ...nextMaterial.oauthClient, authorization_server: bound };
        nextMaterial.oauth = structuredClone(material.oauth);
        // A process that spent the rotated-away token meanwhile cleared the grant this write renews.
        const staleClear = options.replaceCleared && storedOAuth && !storedOAuth.tokens;
        if (
          superseded ||
          (options.storedRefreshToken !== undefined &&
            (storedOAuth?.tokens?.refresh_token ?? null) !== options.storedRefreshToken &&
            !staleClear)
        ) {
          // Another process rotated or replaced the grant; never overwrite it with an older one.
          // A disconnect removed the state altogether, and this write must not bring it back.
          kept = { tokens: storedOAuth?.tokens, obtainedAt: storedOAuth?.obtainedAt };
          options.onKept?.(kept);
          if (superseded && storedOAuth) {
            // The stored state belongs to a newer authorization, so keep it whole: its client
            // and discovery too, not just its grant, or a later refresh pairs one flow's
            // tokens with another's client.
            nextMaterial.oauth = structuredClone(storedOAuth);
          } else if (storedOAuth) applyGrant(nextMaterial.oauth, kept);
          else delete nextMaterial.oauth;
        }
      } else delete nextMaterial.oauth;
      if (options.raiseGeneration) {
        // Raised from what this attempt re-read, so a disconnect that commits after another
        // one still ends flows that began after the earlier disconnect.
        nextMaterial.oauthGeneration = (nextMaterial.oauthGeneration ?? 0) + 1;
      } else {
        // Never lower the stored generation, so a superseded flow cannot undo a disconnect.
        nextMaterial.oauthGeneration =
          Math.max(material.oauthGeneration ?? 0, nextMaterial.oauthGeneration ?? 0) || undefined;
      }
      const hasMaterial = hasCredential(nextMaterial) || Boolean(nextMaterial.oauthGeneration);
      const stored = hasMaterial ? await this.putMaterial(nextMaterial, context) : undefined;
      const committed = await persistPreparedSecret(
        this.prisma,
        this.secrets,
        stored,
        () =>
          this.prisma.$transaction(async (tx) => {
            await lockMcpOAuthMaterial(tx, serverId);
            return this.commitMaterial(
              tx,
              serverId,
              context,
              snapshot,
              stored,
              options.incrementRevision,
            );
          }),
        (committed) => {
          if (committed && stored)
            options.onPersisted?.({
              id: stored.id,
              ref: stored.ciphertext,
              material: nextMaterial,
            });
        },
      );
      if (committed) {
        options.onCommitted?.(committed.revision);
        return kept;
      }
    }
    throw new McpCredentialRefusedError("MCP credentials changed during authorization; retry");
  }

  private async snapshot(
    tx: Prisma.TransactionClient,
    serverId: string,
    context: ActorRef,
    expectedEndpoint?: string | null,
  ): Promise<MaterialSnapshot> {
    const server = await tx.mcpServer.findFirst({
      where: { id: serverId, ...availableInSpace(context) },
      select: { endpoint: true, secretId: true },
    });
    if (!server) throw new McpCredentialRefusedError("MCP server is unavailable");
    if (expectedEndpoint !== undefined && server.endpoint !== expectedEndpoint)
      throw new McpCredentialRefusedError(
        "MCP server endpoint changed during authorization; reconnect this server",
      );
    const secret = server.secretId
      ? await tx.secret.findFirst({
          where: { id: server.secretId, ...itemSecretIn(context) },
        })
      : null;
    return { server, secret };
  }

  private putMaterial(
    material: OAuthMaterial,
    context: ActorRef,
  ): Promise<{ id: string; ciphertext: string }> {
    return this.secrets.put(JSON.stringify(material), {
      operationId: "mcp.oauth.persist",
      traceId: "mcp.oauth.persist",
      spaceId: context.spaceId,
      userId: context.userId,
      botId: "mcp",
      signal: new AbortController().signal,
    });
  }

  /** Swap in `stored` if the snapshot is still current. The caller holds the credential lock. */
  private async commitMaterial(
    tx: Prisma.TransactionClient,
    serverId: string,
    context: ActorRef,
    snapshot: MaterialSnapshot,
    stored: { id: string; ciphertext: string } | undefined,
    incrementRevision = false,
  ): Promise<false | { revision: number }> {
    const server = await tx.mcpServer.findFirst({
      where: { id: serverId, ...availableInSpace(context) },
      select: { endpoint: true, secretId: true, spaceId: true, allSpaces: true },
    });
    if (!server) throw new McpCredentialRefusedError("MCP server is unavailable");
    if (
      server.endpoint !== snapshot.server.endpoint ||
      server.secretId !== snapshot.server.secretId
    )
      return false;
    if (server.secretId)
      await tx.$queryRaw`SELECT id FROM secrets WHERE id = ${server.secretId} FOR UPDATE`;
    const current = server.secretId
      ? await tx.secret.findFirst({
          where: { id: server.secretId, ...itemSecretIn(context) },
        })
      : null;
    if (current?.ciphertext !== snapshot.secret?.ciphertext) return false;
    // A server available beyond this space keeps its credential on the account, for every space.
    const shared =
      server.allSpaces ||
      server.spaceId !== context.spaceId ||
      (await tx.mcpServerSpace.count({ where: { serverId } })) > 0;
    if (stored)
      await tx.secret.create({
        data: {
          id: stored.id,
          spaceId: shared ? null : context.spaceId,
          userId: context.userId,
          kind: "mcp",
          ciphertext: stored.ciphertext,
        },
      });
    const { revision } = await tx.mcpServer.update({
      where: { id: serverId },
      data: {
        secretId: stored?.id ?? null,
        ...(incrementRevision ? { revision: { increment: 1 } } : {}),
      },
    });
    if (server.secretId && server.secretId !== stored?.id)
      await tx.secret.deleteMany({ where: { id: server.secretId } });
    return { revision };
  }

  private async read(ciphertext: string, recordId: string): Promise<OAuthMaterial> {
    try {
      const value = JSON.parse(await this.secrets.load(ciphertext, recordId));
      return value && typeof value === "object" ? (value as OAuthMaterial) : {};
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) throw error;
      return {};
    }
  }
}
