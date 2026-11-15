import * as z from "zod";
import { Id, ThinkingLevelSchema } from "./ids.js";
import { ModelHeadersSchema } from "./model-headers.js";
import { SettingsScopeSchema } from "./settings-scope.js";

/** Default maximum number of completion tokens for an OpenAI-compatible connection. */
export const DEFAULT_MODEL_MAX_TOKENS = 4_096;

/** Fallback context window for OpenAI-compatible connections that do not report a size (e.g. Ollama, LM Studio, vLLM). */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 262_144;

export const MAX_MODEL_CONTEXT_WINDOW = 2_147_483_647;

/**
 * Output limits follow the model; the only fixed bound is the context ceiling, and a connection's
 * limit must still leave room for input (`modelOutputLeavesInputRoom`).
 */
export const MAX_MODEL_MAX_TOKENS = MAX_MODEL_CONTEXT_WINDOW;
export function parseModelMaxImagesPerPrompt(
  value: string,
  supportsImages = true,
): number | undefined {
  if (!supportsImages) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000 ? parsed : undefined;
}

export function parseModelMaxTokens(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_MODEL_MAX_TOKENS
    ? parsed
    : undefined;
}

export function parseModelContextWindow(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_MODEL_CONTEXT_WINDOW
    ? parsed
    : undefined;
}

/**
 * JS null/undefined stringifies to the literals "null" / "undefined". Those
 * are not catalog ids; treat them (and blank values) as unset.
 */
export function usableModelId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return null;
  return trimmed;
}

/** Connection-declared capabilities; omission means unknown, not a provider default. */
export const CacheCapabilitiesSchema = z.object({
  retentionMs: z.number().int().positive().max(2147483647).optional(),
  minimumTokens: z.number().int().nonnegative().max(2147483647).optional(),
  scope: z.enum(["account", "connection"]),
  retentionMode: z.enum(["none", "short", "long"]).optional(),
  inputCostPerMillion: z.number().nonnegative().optional(),
  readCostPerMillion: z.number().nonnegative().optional(),
  writeCostPerMillion: z.number().nonnegative().optional(),
});
export type CacheCapabilities = z.infer<typeof CacheCapabilitiesSchema>;

export const ModelContextLimitsSchema = z.object({
  cacheCapabilities: CacheCapabilitiesSchema.optional(),
  contextWindow: z.number().int().min(1).max(MAX_MODEL_CONTEXT_WINDOW).optional(),
});
export type ModelContextLimits = z.infer<typeof ModelContextLimitsSchema>;

/** A completion limit must leave capacity for at least one input token. */
export function modelOutputLeavesInputRoom(
  maxTokens: number | null | undefined,
  contextWindow: number | undefined,
): boolean {
  return typeof maxTokens !== "number" || contextWindow === undefined || maxTokens < contextWindow;
}

/** Wire protocol selected for one OpenAI-compatible connection. */
export const ModelApiProtocolSchema = z.enum([
  "chat-completions",
  "responses",
  "anthropic-messages",
]);
export type ModelApiProtocol = z.infer<typeof ModelApiProtocolSchema>;

export const ModelCredentialSchema = z.object({
  /** Computed space preference order; credentials themselves remain newest first. */
  preferenceRank: z.number().int().nonnegative().optional(),
  ...ModelContextLimitsSchema.shape,
  id: Id,
  provider: z.string(),
  label: z.string(),
  hasKey: z.boolean(),
  isDefault: z.boolean(),
  headerNames: z.array(z.string()).optional(),
  baseUrl: z.string().optional(),
  /** The hosted service at `baseUrl`, when it is one the catalog offers by name. */
  endpointName: z.string().optional(),
  apiProtocol: ModelApiProtocolSchema.optional(),
  accountId: z.string().optional(),
  gatewayId: z.string().optional(),
  modelId: z.string().optional(),
  reasoning: z.boolean().optional(),
  thinkingLevel: ThinkingLevelSchema.nullable().optional(),
  maxTokens: z.number().int().min(1).max(MAX_MODEL_MAX_TOKENS).optional(),
  supportsImages: z.boolean().optional(),
  maxImagesPerPrompt: z.number().int().min(1).max(1000).optional(),
  thinkingLevels: z.array(ThinkingLevelSchema).optional(),
  /** Openai-compatible only; always contains `modelId` when set. */
  enabledModelIds: z.array(z.string()).optional(),
  /** The connection's enabled models that accept images, where it declares them per model. */
  visionModelIds: z.array(z.string()).optional(),
  /** Stored secret kind. Absent when the secret could not be read. */
  authKind: z.enum(["api_key", "oauth", "openai_compatible"]).optional(),
  /**
   * The subscription sign-in was rejected. The stored tokens are gone and the
   * owner has to sign in again. Model choices on this connection are kept.
   */
  reconnectRequired: z.boolean().optional(),
});
export type ModelCredential = z.infer<typeof ModelCredentialSchema>;

export const MAX_MODEL_BACKUPS = 10;
export const ModelBackupChoiceSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  modelId: z.string().trim().min(1).max(512),
});
export type ModelBackupChoice = z.infer<typeof ModelBackupChoiceSchema>;
/** At most MAX_MODEL_BACKUPS choices, each model once. */
export function modelChoiceListSchema<T extends z.ZodType<ModelBackupChoice>>(choice: T) {
  return z
    .array(choice)
    .max(MAX_MODEL_BACKUPS)
    .superRefine((choices, ctx) => {
      const seen = new Set<string>();
      for (const [index, choice] of choices.entries()) {
        // The same model may run on two connections, so a pinned connection is part of it.
        const credentialId = (choice as { credentialId?: string | null }).credentialId ?? null;
        const key = JSON.stringify([choice.provider, choice.modelId, credentialId]);
        if (seen.has(key)) {
          ctx.addIssue({
            code: "custom",
            message: "Backup models must be unique",
            path: [index],
          });
        }
        seen.add(key);
      }
    });
}
export const ModelBackupListSchema = modelChoiceListSchema(ModelBackupChoiceSchema);

export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";

export const MAX_ENABLED_MODEL_IDS = 500;

/** An existing connection's id, null for a new one, or omitted for the provider's newest. */
export const ModelConnectionTargetSchema = Id.nullable().optional();

export const MAX_MODEL_CONNECTION_LABEL = 80;
export const ModelConnectionLabelSchema = z.string().trim().min(1).max(MAX_MODEL_CONNECTION_LABEL);

/** Ids a provider needs besides its key to route requests, like an account. */
export const ModelRoutingFieldSchema = z.enum(["accountId", "gatewayId"]);
export type ModelRoutingField = z.infer<typeof ModelRoutingFieldSchema>;

/** Routing ids are substituted into a URL path, so only a single path segment is accepted. */
const MODEL_ROUTING_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MODEL_ROUTING_ID_MESSAGE =
  "Use only letters, numbers, dashes, and underscores, up to 64 characters.";

export function modelRoutingId(value: string | null | undefined): string | undefined {
  const id = value?.trim() ?? "";
  return MODEL_ROUTING_ID.test(id) ? id : undefined;
}

/** Every routing id the provider needs is filled in and valid. */
export function modelRoutingReady(
  fields: readonly ModelRoutingField[] | undefined,
  values: Partial<Record<ModelRoutingField, string>>,
): boolean {
  return (fields ?? []).every((field) => modelRoutingId(values[field]) !== undefined);
}

/** What a connection form shows and requires for the routing ids a catalog entry names. */
export function modelRoutingForm(
  fields: readonly ModelRoutingField[] | undefined,
  values: Partial<Record<ModelRoutingField, string>>,
): { needsRouting: boolean; needsGateway: boolean; routingReady: boolean } {
  return {
    needsRouting: Boolean(fields?.length),
    needsGateway: Boolean(fields?.includes("gatewayId")),
    routingReady: modelRoutingReady(fields, values),
  };
}

export const ModelConnectInputSchema = z
  .object({
    ...ModelContextLimitsSchema.shape,
    provider: z.string(),
    apiKey: z.string().optional(),
    accountId: z.string().optional(),
    gatewayId: z.string().optional(),
    headers: ModelHeadersSchema.optional(),
    baseUrl: z.string().optional(),
    apiProtocol: ModelApiProtocolSchema.optional(),
    label: z.string().optional(),
    /**
     * The connection this save updates; null adds another connection for the provider.
     * Older apps omit it and update the provider's newest connection.
     */
    credentialId: ModelConnectionTargetSchema,
    modelId: z.string().optional(),
    reasoning: z.boolean().optional(),
    thinkingLevel: ThinkingLevelSchema.nullable().optional(),
    /** False keeps the current main model; omitted means true. */
    makeDefault: z.boolean().optional(),
    /** Where makeDefault sets the main model; omitted means whichever applies in the Space. */
    scope: SettingsScopeSchema.optional(),
    maxTokens: z.number().int().min(1).max(MAX_MODEL_MAX_TOKENS).nullable().optional(),
    supportsImages: z.boolean().optional(),
    maxImagesPerPrompt: z.number().int().min(1).max(1000).nullable().optional(),
    enabledModelIds: z
      .array(z.string().trim().min(1).max(512))
      .max(MAX_ENABLED_MODEL_IDS)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (!modelOutputLeavesInputRoom(value.maxTokens, value.contextWindow)) {
      ctx.addIssue({
        code: "custom",
        message: "Maximum output tokens must leave room for input",
        path: ["maxTokens"],
      });
    }
    // Whether the provider needs an id is the provider's call; a blank one is left to it.
    for (const field of ModelRoutingFieldSchema.options) {
      const id = value[field];
      if (id?.trim() && !modelRoutingId(id)) {
        ctx.addIssue({ code: "custom", message: MODEL_ROUTING_ID_MESSAGE, path: [field] });
      }
    }
    if (value.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
      if (!value.baseUrl?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "Base URL is required for OpenAI-compatible models",
          path: ["baseUrl"],
        });
      }
      if (!value.modelId?.trim()) {
        ctx.addIssue({
          code: "custom",
          message: "Model id is required for OpenAI-compatible models",
          path: ["modelId"],
        });
      }
      return;
    }
    const apiKey = value.apiKey?.trim() ?? "";
    if (apiKey.length > 0 && apiKey.length < 8) {
      ctx.addIssue({
        code: "custom",
        message: "API key must contain at least 8 characters",
        path: ["apiKey"],
      });
    }
    // An existing connection can update its output limit without a new key.
    if (!apiKey && value.maxTokens === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "API key must contain at least 8 characters",
        path: ["apiKey"],
      });
    }
  });
export type ModelConnectInput = z.infer<typeof ModelConnectInputSchema>;

export const ModelOAuthSignInModeSchema = z.enum(["device-code", "auth-url"]);
export type ModelOAuthSignInMode = z.infer<typeof ModelOAuthSignInModeSchema>;

const ModelOAuthBeginBaseSchema = z.object({
  loginId: z.string(),
  provider: z.string(),
  verificationUri: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://"), "Expected an HTTPS authorization URL"),
  expiresInSeconds: z.number().int().positive(),
});

export const ModelOAuthBeginSchema = z.discriminatedUnion("mode", [
  ModelOAuthBeginBaseSchema.extend({
    mode: z.literal("device-code"),
    userCode: z.string().min(1),
  }),
  ModelOAuthBeginBaseSchema.extend({ mode: z.literal("auth-url") }),
]);
export type ModelOAuthBegin = z.infer<typeof ModelOAuthBeginSchema>;

/** A hosted OpenAI-compatible service offered by name. It always needs a key. */
export const CompatibleEndpointPresetSchema = z.object({ name: z.string(), baseUrl: z.string() });
export type CompatibleEndpointPreset = z.infer<typeof CompatibleEndpointPresetSchema>;

export const ModelCatalogEntrySchema = z.object({
  /** Omitted by older servers and ordinary chat connections. */
  protocol: z.enum(["chat", "decisions"]).optional(),
  /** Preselected for a new connection when there is no saved model choice. */
  recommended: z.boolean().optional(),
  /** The provider's connections that can run it, when not all of them can. */
  credentialIds: z.array(z.string()).optional(),
  /** Available through the deployment without a personal credential. */
  managed: z.boolean().optional(),
  provider: z.string(),
  providerName: z.string().optional(),
  id: z.string(),
  label: z.string(),
  billing: z.string(),
  auth: z.enum(["api-key", "oauth", "both"]).optional(),
  oauthLabel: z.string().optional(),
  authHint: z.string().optional(),
  subscription: z.boolean().optional(),
  signIn: ModelOAuthSignInModeSchema.optional(),
  reasoning: z.boolean().optional(),
  thinkingLevels: z.array(ThinkingLevelSchema).optional(),
  /** The model reads images. Left out where a connection setting decides it. */
  images: z.boolean().optional(),
  /** Catalog stand-in so a provider appears before the user enters a real model id. */
  placeholder: z.boolean().optional(),
  /** Models share one pinned HTTPS models-list URL that can be probed. */
  catalogProbe: z.boolean().optional(),
  /** Ids the provider needs besides a key; a connection cannot save without them. */
  routingFields: z.array(ModelRoutingFieldSchema).optional(),
  /** Hosted services this connection type offers by name. */
  endpointPresets: z.array(CompatibleEndpointPresetSchema).optional(),
  /** Listed by the provider's live models list but not in the bundled catalog. */
  live: z.literal(true).optional(),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;
