export const CODEX_ACCOUNT_PROVIDER = 'paws_openai_http';
export const CODEX_ACCOUNT_HTTP_PROVIDER = {
  name: 'Paws OpenAI HTTP',
  base_url: 'https://chatgpt.com/backend-api/codex',
  wire_api: 'responses',
  requires_openai_auth: true,
  supports_websockets: false,
} as const;

/** Applied as native CLI overrides and again at every account thread boundary. */
export const CODEX_ACCOUNT_CONFIG = {
  model_provider: CODEX_ACCOUNT_PROVIDER,
  forced_login_method: 'chatgpt',
  cli_auth_credentials_store: 'file',
  chatgpt_base_url: 'https://chatgpt.com/backend-api',
} as const;

/** Dotted keys work in both native -c flags and app-server thread overrides. */
export const CODEX_ACCOUNT_OVERRIDES = {
  ...CODEX_ACCOUNT_CONFIG,
  ...Object.fromEntries(Object.entries(CODEX_ACCOUNT_HTTP_PROVIDER).map(([key, value]) =>
    [`model_providers.${CODEX_ACCOUNT_PROVIDER}.${key}`, value])),
};

export const CODEX_ACCOUNT_UNSET_ENV = [
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE',
  'CODEX_CHATGPT_BASE_URL', 'CHATGPT_BASE_URL', 'HAPPY_CODEX_APP_SERVER_SOCKET',
] as const;

export const CODEX_ACCOUNT_CONFIG_ERROR = 'Codex account configuration is incompatible. Remove custom OpenAI provider overrides and check the account in Settings → Device Environment.';

export function assertCodexAccountConfig(value: unknown): void {
  if (!value || typeof value !== 'object') throw new Error(CODEX_ACCOUNT_CONFIG_ERROR);
  const config = value as Record<string, unknown>;
  for (const [key, expected] of Object.entries(CODEX_ACCOUNT_CONFIG)) {
    if (config[key] !== expected) throw new Error(CODEX_ACCOUNT_CONFIG_ERROR);
  }
  const providers = config.model_providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) throw new Error(CODEX_ACCOUNT_CONFIG_ERROR);
  const provider = (providers as Record<string, unknown>)[CODEX_ACCOUNT_PROVIDER];
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw new Error(CODEX_ACCOUNT_CONFIG_ERROR);
  const fields = provider as Record<string, unknown>;
  for (const [key, expected] of Object.entries(CODEX_ACCOUNT_HTTP_PROVIDER)) {
    if (fields[key] !== expected) throw new Error(CODEX_ACCOUNT_CONFIG_ERROR);
  }
  // config/read expands omitted optional fields to null/false. Reject inherited
  // endpoint, header, auth and retry overrides on our selected provider.
  for (const [key, field] of Object.entries(fields)) {
    if (Object.hasOwn(CODEX_ACCOUNT_HTTP_PROVIDER, key) || field == null
        || (key === 'supports_standalone_web_search' && field === false)) continue;
    throw new Error(CODEX_ACCOUNT_CONFIG_ERROR);
  }
}
