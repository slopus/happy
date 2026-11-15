import type { McpServerConfigInput } from "@rakazo/contracts";

type McpOAuthClient = {
  client_id: string;
  client_secret?: string;
  /** Space-separated scopes to request. */
  scope?: string;
  /** Extra authorization request parameters, query-string form. */
  authorization_params?: string;
  /** Set on first use by McpOAuthBroker for a remote server, or by the user for
   * stdio; kept while the client is unchanged. */
  authorization_server?: string;
};

/** Shape of the encrypted MCP credential blob. `oauth` holds SDK OAuth state
 * (tokens, client registration, PKCE verifier) managed by McpOAuthBroker.
 * `oauthClient` is a client the user registered with the provider themselves. */
export type McpSecretMaterial = {
  secret?: string;
  /** Stdio launch arguments, which may carry tokens. */
  args?: string[];
  env?: Record<string, string>;
  /** Credential file templates by the env variable that receives the file's path. */
  files?: Record<string, string>;
  headers?: Record<string, string>;
  oauthClient?: McpOAuthClient;
  oauth?: Record<string, unknown>;
};

/** Arguments a row still holds in plaintext from before they moved into its secret. */
export function legacyMcpArgs(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export type McpMaterialUpdate =
  | { action: "keep" }
  | { action: "store"; material: McpSecretMaterial };

/** An empty "store" material means credentials were cleared: the caller deletes the secret
 * row and nulls `secretId` instead of storing an empty object. env/headers are full-replace;
 * files are kept when omitted, and stdio arguments when none are sent for the same command.
 * OAuth state is dropped when the endpoint changed, since tokens issued for one endpoint must
 * never be sent to another server. */
export function buildMcpUpdateMaterial(
  existing: McpSecretMaterial,
  config: McpServerConfigInput,
  options: { clearOAuth?: boolean; endpointChanged?: boolean; commandChanged?: boolean } = {},
): McpMaterialUpdate {
  const client = nextOAuthClient(
    existing.oauthClient,
    "oauthClient" in config ? config.oauthClient : undefined,
  );
  // Tokens are issued to one client, so a different client must authorize again.
  const clearOAuth = options.clearOAuth === true || client.changed;
  const material = clearOAuth ? { ...existing } : existing;
  const clearedOAuth = clearOAuth && (material.oauth !== undefined || client.changed);
  if (clearOAuth) delete material.oauth;
  if (client.changed) {
    if (client.next) material.oauthClient = client.next;
    else delete material.oauthClient;
  }
  const { files: storedFiles, args: storedArgs, ...rest } = material;
  const args =
    config.transport !== "stdio"
      ? []
      : config.args?.length || options.commandChanged
        ? (config.args ?? [])
        : (storedArgs ?? []);
  const withArgs = args.length > 0 ? { args } : {};
  const clearing = config.clearCredential === true;
  if (clearing) {
    return {
      action: "store",
      material: {
        ...withArgs,
        ...(material.oauthClient ? { oauthClient: material.oauthClient } : {}),
        ...(material.oauth ? { oauth: material.oauth } : {}),
      },
    };
  }
  const secret = "secret" in config && config.secret ? config.secret : undefined;
  // Clients never read stored values back, so a blank one keeps what is stored under its
  // name, unless that would send it to a different endpoint.
  const keepBlank = (next: Record<string, string>, stored: Record<string, string> = {}) =>
    options.endpointChanged
      ? next
      : Object.fromEntries(
          Object.entries(next).map(([name, value]) => [name, value || (stored[name] ?? "")]),
        );
  const env = "env" in config ? keepBlank(config.env, material.env) : undefined;
  const headers = "headers" in config ? keepBlank(config.headers, material.headers) : undefined;
  const files =
    config.transport === "stdio"
      ? config.files
        ? keepBlank(config.files, storedFiles)
        : storedFiles
      : undefined;
  const hasFiles = files !== undefined && Object.keys(files).length > 0;
  const existingHasMaterial = Boolean(
    material.secret ||
      storedArgs?.length ||
      (material.env && Object.keys(material.env).length > 0) ||
      (storedFiles && Object.keys(storedFiles).length > 0) ||
      (material.headers && Object.keys(material.headers).length > 0) ||
      material.oauthClient ||
      material.oauth,
  );
  const suppliesMaterial = Boolean(
    secret ||
      args.length > 0 ||
      (env && Object.keys(env).length > 0) ||
      (headers && Object.keys(headers).length > 0) ||
      hasFiles,
  );
  if (!existingHasMaterial && !suppliesMaterial) {
    // A stored blob of only empty containers is not a credential, but its row still
    // reports one and nothing in this update can clear it. Clear it here so the caller
    // deletes the row. A material without container keys belongs to a row without a
    // stored secret, so keep stays keep and the caller writes nothing.
    if ("env" in existing || "headers" in existing || "files" in existing) {
      return { action: "store", material: {} };
    }
    return clearedOAuth ? { action: "store", material } : { action: "keep" };
  }
  const stored: McpSecretMaterial = {
    ...rest,
    ...withArgs,
    ...(secret ? { secret } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(hasFiles ? { files } : {}),
  };
  // env and headers are full-replace and the contract defaults them to {}, so an update
  // without credentials replaces the stored names with nothing. An empty record is not a
  // credential: dropping it lets an emptied material reach {} so the caller deletes the
  // secret row instead of storing `{"env":{}}` or `{"headers":{}}` and reporting a saved
  // credential.
  if (stored.env !== undefined && Object.keys(stored.env).length === 0) delete stored.env;
  if (stored.headers !== undefined && Object.keys(stored.headers).length === 0) {
    delete stored.headers;
  }
  return { action: "store", material: stored };
}

/** Resolve the client an update asks for. A resent client ID without a secret
 * keeps the stored secret; a different client ID never inherits it. Any
 * difference in client, secret, scope, or authorization server is a change, and
 * an unchanged resend keeps the stored object, including a first-use binding. */
function nextOAuthClient(
  existing: McpOAuthClient | undefined,
  input:
    | {
        clientId: string;
        clientSecret?: string;
        scope?: string;
        authorizationServer?: string;
        authorizationParams?: string;
      }
    | null
    | undefined,
): { next?: McpOAuthClient; changed: boolean } {
  if (input === undefined) return { next: existing, changed: false };
  if (input === null) return { changed: existing !== undefined };
  const sameClient = existing?.client_id === input.clientId;
  const secret = input.clientSecret ?? (sameClient ? existing?.client_secret : undefined);
  const scope = input.scope || undefined;
  const authorizationParams = input.authorizationParams || undefined;
  const authorizationServer = input.authorizationServer
    ? new URL(input.authorizationServer).href
    : undefined;
  const unchanged =
    existing !== undefined &&
    sameClient &&
    secret === existing.client_secret &&
    scope === existing.scope &&
    authorizationParams === existing.authorization_params &&
    (authorizationServer === undefined || authorizationServer === existing.authorization_server);
  if (unchanged) return { next: existing, changed: false };
  return {
    next: {
      client_id: input.clientId,
      ...(secret ? { client_secret: secret } : {}),
      ...(scope ? { scope } : {}),
      ...(authorizationParams ? { authorization_params: authorizationParams } : {}),
      ...(authorizationServer ? { authorization_server: authorizationServer } : {}),
    },
    changed: true,
  };
}
