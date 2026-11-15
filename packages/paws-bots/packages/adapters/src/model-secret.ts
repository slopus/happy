import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { ModelApiProtocol, ModelContextLimits, ThinkingLevel } from "@rakazo/contracts";
import {
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  ModelApiProtocolSchema,
  ModelContextLimitsSchema,
  parseModelHeaders,
  ThinkingLevelSchema,
} from "@rakazo/contracts";

const CORRUPT_MODEL_SECRET_MESSAGE =
  "Stored model credential is corrupt. Connect the provider again.";

export type StoredModelLimits = ModelContextLimits;

function modelLimits(value: Record<string, unknown>): StoredModelLimits {
  const cache = ModelContextLimitsSchema.shape.cacheCapabilities.safeParse(value.cacheCapabilities);
  const window = ModelContextLimitsSchema.shape.contextWindow.safeParse(value.contextWindow);
  return {
    ...(cache.success && cache.data !== undefined ? { cacheCapabilities: cache.data } : {}),
    ...(window.success && window.data !== undefined ? { contextWindow: window.data } : {}),
  };
}

export type StoredModelSecret =
  | ({
      kind: "api_key";
      key: string;
      maxTokens?: number;
      accountId?: string;
      gatewayId?: string;
    } & StoredModelLimits)
  | { kind: "oauth"; reconnectRequired: true; maxTokens?: number }
  | { kind: "oauth"; reconnectRequired?: false; credential: OAuthCredential; maxTokens?: number }
  | ({
      kind: "openai_compatible";
      baseUrl: string;
      apiProtocol?: ModelApiProtocol;
      headers?: Record<string, string>;
      apiKey?: string;
      reasoning?: boolean;
      thinkingLevel?: ThinkingLevel | null;
      maxTokens?: number;
      contextWindow?: number;
      visionModelIds?: string[];
      enabledModelIds?: string[];
      maxImagesPerPrompt?: number;
    } & StoredModelLimits);

function readOAuthCredential(value: unknown): OAuthCredential | undefined {
  if (!value || typeof value !== "object") return undefined;
  const parsed = value as Record<string, unknown>;
  if (
    parsed.type === "oauth" &&
    typeof parsed.access === "string" &&
    typeof parsed.refresh === "string" &&
    typeof parsed.expires === "number"
  ) {
    return parsed as OAuthCredential;
  }
  return undefined;
}

function parsedRoutingId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parsedMaxTokens(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_MODEL_MAX_TOKENS
    ? value
    : undefined;
}

function parsedModelIds(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter(
        (modelId): modelId is string => typeof modelId === "string" && modelId.trim().length > 0,
      )
    : undefined;
}

export function parseModelSecret(plaintext: string): StoredModelSecret {
  const trimmed = plaintext.trim();
  if (!trimmed.startsWith("{")) return { kind: "api_key", key: plaintext };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Treat malformed JSON as a literal API key.
    return { kind: "api_key", key: plaintext };
  }
  if (parsed.kind === "openai_compatible") {
    if (typeof parsed.baseUrl !== "string" || !parsed.baseUrl.trim()) {
      throw new Error(CORRUPT_MODEL_SECRET_MESSAGE);
    }
    const apiProtocol =
      parsed.apiProtocol === undefined
        ? undefined
        : ModelApiProtocolSchema.parse(parsed.apiProtocol);
    const headers = parsed.headers === undefined ? undefined : parseModelHeaders(parsed.headers);
    const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey : undefined;
    const parsedThinkingLevel = ThinkingLevelSchema.nullable().safeParse(parsed.thinkingLevel);
    const thinkingLevel = parsedThinkingLevel.success ? parsedThinkingLevel.data : undefined;
    const maxTokens = parsedMaxTokens(parsed.maxTokens);
    const contextWindow =
      typeof parsed.contextWindow === "number" &&
      Number.isInteger(parsed.contextWindow) &&
      parsed.contextWindow >= 1 &&
      parsed.contextWindow <= MAX_MODEL_CONTEXT_WINDOW
        ? parsed.contextWindow
        : undefined;
    const visionModelIds = parsedModelIds(parsed.visionModelIds);
    const enabledModelIds = parsedModelIds(parsed.enabledModelIds);
    const maxImagesPerPrompt =
      typeof parsed.maxImagesPerPrompt === "number" &&
      Number.isInteger(parsed.maxImagesPerPrompt) &&
      parsed.maxImagesPerPrompt >= 1 &&
      parsed.maxImagesPerPrompt <= 1000
        ? parsed.maxImagesPerPrompt
        : undefined;
    return {
      kind: "openai_compatible",
      baseUrl: parsed.baseUrl.trim(),
      ...(apiProtocol !== undefined ? { apiProtocol } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(typeof parsed.reasoning === "boolean" ? { reasoning: parsed.reasoning } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(visionModelIds ? { visionModelIds } : {}),
      ...(enabledModelIds ? { enabledModelIds } : {}),
      ...(maxImagesPerPrompt !== undefined ? { maxImagesPerPrompt } : {}),
      ...modelLimits(parsed),
    };
  }
  if (parsed.kind === "api_key") {
    if (typeof parsed.key !== "string" || !parsed.key) {
      throw new Error(CORRUPT_MODEL_SECRET_MESSAGE);
    }
    const maxTokens = parsedMaxTokens(parsed.maxTokens);
    const accountId = parsedRoutingId(parsed.accountId);
    const gatewayId = parsedRoutingId(parsed.gatewayId);
    return {
      kind: "api_key",
      key: parsed.key,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(accountId ? { accountId } : {}),
      ...(gatewayId ? { gatewayId } : {}),
      ...modelLimits(parsed),
    };
  }
  if (parsed.kind === "oauth") {
    const maxTokens = parsedMaxTokens(parsed.maxTokens);
    if (parsed.reconnectRequired === true) {
      return {
        kind: "oauth",
        reconnectRequired: true,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      };
    }
    const credential = readOAuthCredential(parsed.credential);
    if (!credential) throw new Error(CORRUPT_MODEL_SECRET_MESSAGE);
    return {
      kind: "oauth",
      credential,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    };
  }
  // Legacy secrets serialize the bare OAuth credential without a kind wrapper.
  if (parsed.type === "oauth") {
    const credential = readOAuthCredential(parsed);
    if (!credential) throw new Error(CORRUPT_MODEL_SECRET_MESSAGE);
    return { kind: "oauth", credential };
  }
  return { kind: "api_key", key: plaintext };
}

export function serializeModelSecret(secret: StoredModelSecret): string {
  if (secret.kind === "oauth") {
    if (secret.reconnectRequired) return JSON.stringify(secret);
    if (secret.maxTokens === undefined) return JSON.stringify(secret.credential);
    return JSON.stringify({
      kind: "oauth",
      credential: secret.credential,
      maxTokens: secret.maxTokens,
    });
  }
  if (secret.kind === "openai_compatible") {
    return JSON.stringify({
      kind: "openai_compatible",
      ...modelLimits(secret as unknown as Record<string, unknown>),
      baseUrl: secret.baseUrl,
      ...(secret.apiProtocol !== undefined
        ? { apiProtocol: ModelApiProtocolSchema.parse(secret.apiProtocol) }
        : {}),
      ...(secret.headers !== undefined ? { headers: parseModelHeaders(secret.headers) } : {}),
      ...(secret.apiKey ? { apiKey: secret.apiKey } : {}),
      ...(secret.reasoning !== undefined ? { reasoning: secret.reasoning } : {}),
      ...(secret.thinkingLevel !== undefined ? { thinkingLevel: secret.thinkingLevel } : {}),
      ...(secret.maxTokens !== undefined ? { maxTokens: secret.maxTokens } : {}),
      ...(secret.contextWindow !== undefined ? { contextWindow: secret.contextWindow } : {}),
      ...(secret.visionModelIds !== undefined ? { visionModelIds: secret.visionModelIds } : {}),
      ...(secret.enabledModelIds !== undefined ? { enabledModelIds: secret.enabledModelIds } : {}),
      ...(secret.maxImagesPerPrompt !== undefined
        ? { maxImagesPerPrompt: secret.maxImagesPerPrompt }
        : {}),
    });
  }
  if (
    secret.maxTokens === undefined &&
    secret.accountId === undefined &&
    secret.gatewayId === undefined &&
    secret.contextWindow === undefined &&
    secret.cacheCapabilities === undefined
  ) {
    return secret.key;
  }
  return JSON.stringify({
    kind: "api_key",
    key: secret.key,
    ...(secret.maxTokens !== undefined ? { maxTokens: secret.maxTokens } : {}),
    ...(secret.accountId ? { accountId: secret.accountId } : {}),
    ...(secret.gatewayId ? { gatewayId: secret.gatewayId } : {}),
    ...modelLimits(secret as unknown as Record<string, unknown>),
  });
}

const MIN_REDACTED_HEADER_VALUE_LENGTH = 8;

export function secretValuesToRedact(secret: StoredModelSecret): string[] {
  if (secret.kind === "api_key") return secret.key ? [secret.key] : [];
  if (secret.kind === "openai_compatible")
    return [
      secret.apiKey,
      ...Object.values(secret.headers ?? {}).filter(
        (value) => value.length >= MIN_REDACTED_HEADER_VALUE_LENGTH,
      ),
    ].filter((value): value is string => Boolean(value));
  if (secret.reconnectRequired) return [];
  return [secret.credential.access, secret.credential.refresh].filter(Boolean);
}
