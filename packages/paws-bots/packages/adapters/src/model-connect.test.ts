import { MODEL_KEY_FORMAT_ERROR, ModelConnectInputSchema } from "@rakazo/contracts";
import { canUseCompatibleModelAsDefault } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE,
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
} from "./cloudflare-ai-gateway.js";
import {
  buildModelConnectPlaintext,
  modelCredentialDto,
  storedOpenAiCompatibleProbeKey,
} from "./model-connect.js";
import { parseModelSecret, serializeModelSecret } from "./model-secret.js";
import { COMPATIBLE_ENDPOINT_PRESETS } from "./openai-compatible-url.js";

/** Fixtures connect as the deployment owner, who may use local model servers. */
const connectAsOwner = (
  input: Parameters<typeof buildModelConnectPlaintext>[0],
  previous?: string,
  options?: Parameters<typeof buildModelConnectPlaintext>[2],
) => buildModelConnectPlaintext(input, previous, { allowPrivateEndpoint: true, ...options });

describe("stored OpenAI-compatible probe key", () => {
  const baseUrl = "https://example.invalid/v1";
  const stored = serializeModelSecret({
    kind: "openai_compatible",
    baseUrl,
    apiKey: "fake-saved-key",
  });

  it.each([baseUrl, `${baseUrl}/`, "https://example.invalid", "https://example.invalid/"])(
    "reuses the key for the matching normalized URL %s",
    (url) => {
      expect(storedOpenAiCompatibleProbeKey(url, stored)).toBe("fake-saved-key");
    },
  );

  it("does not transfer a key to a different host", () => {
    expect(storedOpenAiCompatibleProbeKey("https://other.invalid/v1", stored)).toBeUndefined();
  });

  it.each([
    undefined,
    serializeModelSecret({ kind: "openai_compatible", baseUrl }),
    JSON.stringify({ kind: "openai_compatible", baseUrl, apiKey: "   " }),
    serializeModelSecret({ kind: "api_key", key: "fake-other-key" }),
    '{"kind":"openai_compatible",',
  ])("ignores absent, keyless, unrelated or corrupt secrets: %s", (plaintext) => {
    expect(storedOpenAiCompatibleProbeKey(baseUrl, plaintext)).toBeUndefined();
  });
});

describe("built-in provider output limits", () => {
  const row = {
    id: "cred-builtin",
    provider: "anthropic",
    label: "Anthropic",
    isDefault: true,
  };

  it("stores an output-token limit with an API key", () => {
    const plaintext = connectAsOwner({
      provider: "anthropic",
      apiKey: "sk-test-key",
      maxTokens: 16384,
    });
    expect(parseModelSecret(plaintext)).toEqual({
      kind: "api_key",
      key: "sk-test-key",
      maxTokens: 16384,
    });
    expect(modelCredentialDto(row, plaintext)).toMatchObject({
      maxTokens: 16384,
      hasKey: true,
      authKind: "api_key",
    });
    expect(JSON.stringify(modelCredentialDto(row, plaintext))).not.toContain("sk-test-key");
  });

  it.each([
    ["non-Latin text", "sk-fixture-你好-key"],
    ["a pasted sentence", "my key is sk-fixture-key"],
    ["a line break", "sk-fixture\nkey-part"],
  ])("refuses a key with %s before saving it", (_, apiKey) => {
    expect(() => connectAsOwner({ provider: "deepseek", apiKey })).toThrow(MODEL_KEY_FORMAT_ERROR);
    expect(() =>
      connectAsOwner({
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        modelId: "fixture-model",
        apiKey,
      }),
    ).toThrow(MODEL_KEY_FORMAT_ERROR);
  });

  it("trims the whitespace around a pasted key", () => {
    expect(connectAsOwner({ provider: "deepseek", apiKey: "  sk-fixture-key\n" })).toBe(
      "sk-fixture-key",
    );
  });

  it("keeps a raw API key when no limit is configured", () => {
    expect(
      connectAsOwner({
        provider: "anthropic",
        apiKey: "sk-test-key",
      }),
    ).toBe("sk-test-key");
  });

  it("updates the limit without replacing the key", () => {
    const previous = connectAsOwner({
      provider: "anthropic",
      apiKey: "sk-test-key",
      maxTokens: 8192,
    });
    const updated = connectAsOwner({ provider: "anthropic", maxTokens: 16384 }, previous);
    expect(parseModelSecret(updated)).toEqual({
      kind: "api_key",
      key: "sk-test-key",
      maxTokens: 16384,
    });
  });

  it("validates an output-only update against the saved context window", () => {
    const previous = connectAsOwner({
      provider: "openrouter",
      apiKey: "fake-api-key",
      contextWindow: 16_384,
      maxTokens: 4096,
    });
    expect(() => connectAsOwner({ provider: "openrouter", maxTokens: 20_000 }, previous)).toThrow(
      "Maximum output tokens must leave room for input",
    );
    expect(
      parseModelSecret(connectAsOwner({ provider: "openrouter", maxTokens: 12_288 }, previous)),
    ).toMatchObject({ contextWindow: 16_384, maxTokens: 12_288 });
  });

  it("validates a context-only update against the saved output limit", () => {
    const previous = connectAsOwner({
      provider: "openrouter",
      apiKey: "fake-api-key",
      contextWindow: 32_768,
      maxTokens: 8192,
    });
    expect(() => connectAsOwner({ provider: "openrouter", contextWindow: 4096 }, previous)).toThrow(
      "Maximum output tokens must leave room for input",
    );
  });

  it("clears the limit without replacing the key", () => {
    const previous = connectAsOwner({
      provider: "anthropic",
      apiKey: "sk-test-key",
      maxTokens: 8192,
    });
    expect(connectAsOwner({ provider: "anthropic", maxTokens: null }, previous)).toBe(
      "sk-test-key",
    );
  });

  it("preserves the limit when a replacement key omits it", () => {
    const previous = connectAsOwner({
      provider: "anthropic",
      apiKey: "sk-test-key",
      maxTokens: 8192,
    });
    expect(
      parseModelSecret(
        connectAsOwner({ provider: "anthropic", apiKey: "sk-new-key-value" }, previous),
      ),
    ).toEqual({ kind: "api_key", key: "sk-new-key-value", maxTokens: 8192 });
  });

  it("updates an OAuth connection limit without dropping the credential", () => {
    const credential = {
      type: "oauth" as const,
      access: "access",
      refresh: "refresh",
      expires: 10,
    };
    const previous = serializeModelSecret({ kind: "oauth", credential });
    expect(
      parseModelSecret(connectAsOwner({ provider: "openai-codex", maxTokens: 8192 }, previous)),
    ).toEqual({ kind: "oauth", credential, maxTokens: 8192 });
    expect(
      modelCredentialDto(
        {
          id: "cred-oauth",
          provider: "openai-codex",
          label: "ChatGPT",
          isDefault: false,
        },
        previous,
      ).authKind,
    ).toBe("oauth");
  });

  it("keeps an output limit saved while the connection needs sign-in again", () => {
    const previous = serializeModelSecret({
      kind: "oauth",
      reconnectRequired: true,
      maxTokens: 4096,
    });
    expect(
      parseModelSecret(connectAsOwner({ provider: "openai-codex", maxTokens: 8192 }, previous)),
    ).toEqual({ kind: "oauth", reconnectRequired: true, maxTokens: 8192 });
  });

  it("names a compatible connection at a hosted preset and nowhere else", () => {
    const dto = (baseUrl: string) =>
      modelCredentialDto(
        { id: "cred-compat", provider: "openai-compatible", label: "Compatible" },
        serializeModelSecret({ kind: "openai_compatible", baseUrl }),
      );
    expect(dto(COMPATIBLE_ENDPOINT_PRESETS[0]!.baseUrl).endpointName).toBe(
      COMPATIBLE_ENDPOINT_PRESETS[0]!.name,
    );
    expect(dto("http://127.0.0.1:8000/v1").endpointName).toBeUndefined();
  });

  it("rejects a limit update when no credential exists", () => {
    expect(() => connectAsOwner({ provider: "anthropic", maxTokens: 8192 })).toThrow(/API key/);
  });
});

describe("openai-codex API key guard", () => {
  const codexOauth = serializeModelSecret({
    kind: "oauth",
    credential: { type: "oauth", access: "access", refresh: "refresh", expires: 10 },
  });

  it("rejects an API key because the Codex transport needs the sign-in JWT", () => {
    expect(() => connectAsOwner({ provider: "openai-codex", apiKey: "sk-test-key-123" })).toThrow(
      /ChatGPT subscription sign-in is required/,
    );
  });

  it("rejects replacing a ChatGPT sign-in with an API key", () => {
    expect(() =>
      connectAsOwner({ provider: "openai-codex", apiKey: "sk-test-key-123" }, codexOauth),
    ).toThrow(/ChatGPT subscription sign-in is required/);
  });

  it("points a keyless first connect at subscription sign-in instead of asking for a key", () => {
    expect(() => connectAsOwner({ provider: "openai-codex", maxTokens: 8192 })).toThrow(
      /ChatGPT subscription sign-in is required/,
    );
  });

  it("rejects re-saving a legacy stored API key on a keyless connect", () => {
    const legacyKey = connectAsOwner({
      provider: "anthropic",
      apiKey: "sk-legacy-key",
    });
    expect(() => connectAsOwner({ provider: "openai-codex", maxTokens: 8192 }, legacyKey)).toThrow(
      /ChatGPT subscription sign-in is required/,
    );
  });

  it("carries a previous ChatGPT sign-in forward when only the output limit changes", () => {
    expect(
      parseModelSecret(connectAsOwner({ provider: "openai-codex", maxTokens: 8192 }, codexOauth)),
    ).toEqual({
      kind: "oauth",
      credential: { type: "oauth", access: "access", refresh: "refresh", expires: 10 },
      maxTokens: 8192,
    });
  });

  it("keeps other providers' API keys working", () => {
    expect(connectAsOwner({ provider: "anthropic", apiKey: "sk-test-key-123" })).toBe(
      "sk-test-key-123",
    );
    expect(
      connectAsOwner({
        provider: "openai",
        apiKey: "sk-test-key-123",
        accountId: "acct1234",
        gatewayId: "gateway-1",
      }),
    ).toBe("sk-test-key-123");
  });

  it("stores Workers AI account routing and preserves it without a replacement key", () => {
    const provider = "cloudflare-workers-ai";
    const plaintext = connectAsOwner({
      provider,
      apiKey: "cf-test-key-value",
      accountId: "account-fixture",
    });
    const saved = { kind: "api_key", key: "cf-test-key-value", accountId: "account-fixture" };
    expect(parseModelSecret(plaintext)).toEqual(saved);
    expect(parseModelSecret(connectAsOwner({ provider, maxTokens: 2048 }, plaintext))).toEqual({
      ...saved,
      maxTokens: 2048,
    });
    expect(
      parseModelSecret(connectAsOwner({ provider, accountId: "account-updated" }, plaintext)),
    ).toEqual({ ...saved, accountId: "account-updated" });
    expect(() => connectAsOwner({ provider, apiKey: "cf-test-key-value" })).toThrow(
      "Cloudflare Workers AI needs an account ID.",
    );
    expect(() => connectAsOwner({ provider, accountId: "../account" }, plaintext)).toThrow(
      "Cloudflare Workers AI needs an account ID.",
    );
  });

  it("stores Cloudflare AI Gateway routing with the key and keeps it on a limit update", () => {
    const input = {
      provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
      apiKey: "cf-test-key-value",
      accountId: "acct1234",
      gatewayId: "gateway-1",
    };
    const plaintext = connectAsOwner(input);
    expect(parseModelSecret(plaintext)).toEqual({
      kind: "api_key",
      key: "cf-test-key-value",
      accountId: "acct1234",
      gatewayId: "gateway-1",
    });
    expect(
      parseModelSecret(
        connectAsOwner({ provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID, maxTokens: 4096 }, plaintext),
      ),
    ).toEqual({
      kind: "api_key",
      key: "cf-test-key-value",
      maxTokens: 4096,
      accountId: "acct1234",
      gatewayId: "gateway-1",
    });
    expect(
      modelCredentialDto(
        {
          id: "cred-cf",
          provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
          label: "Cloudflare AI Gateway",
          isDefault: false,
        },
        plaintext,
      ),
    ).toMatchObject({ accountId: "acct1234", gatewayId: "gateway-1" });
    expect(() =>
      connectAsOwner({
        provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
        apiKey: "cf-test-key-value",
      }),
    ).toThrow(CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE);
    expect(
      parseModelSecret(
        connectAsOwner(
          { provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID, accountId: "acct9999" },
          plaintext,
        ),
      ),
    ).toEqual({
      kind: "api_key",
      key: "cf-test-key-value",
      accountId: "acct9999",
      gatewayId: "gateway-1",
    });
    expect(
      parseModelSecret(
        connectAsOwner(
          { provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID, gatewayId: "gateway-2" },
          plaintext,
        ),
      ),
    ).toEqual({
      kind: "api_key",
      key: "cf-test-key-value",
      accountId: "acct1234",
      gatewayId: "gateway-2",
    });
    expect(() =>
      connectAsOwner(
        { provider: CLOUDFLARE_AI_GATEWAY_PROVIDER_ID, accountId: "acct/secret" },
        plaintext,
      ),
    ).toThrow(CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE);
  });
});

describe("modelCredentialDto", () => {
  it("returns stored baseUrl and modelId for openai-compatible credentials", () => {
    const plaintext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
    });
    expect(
      modelCredentialDto(
        {
          id: "cred-1",
          provider: "openai-compatible",
          label: "Local MLX",
          isDefault: true,
          defaultModel: "qwen3-4b",
        },
        plaintext,
      ),
    ).toEqual({
      id: "cred-1",
      provider: "openai-compatible",
      label: "Local MLX",
      hasKey: false,
      isDefault: true,
      supportsImages: false,
      authKind: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
      modelId: "qwen3-4b",
      reasoning: false,
      thinkingLevels: ["off"],
      visionModelIds: [],
    });
  });

  it.each([
    { name: "legacy secret", enabledModelIds: undefined, expected: undefined },
    { name: "listed secret with the default", enabledModelIds: ["Y", "X"], expected: ["Y", "X"] },
    { name: "listed secret without the default", enabledModelIds: ["X"], expected: ["Y", "X"] },
  ])("exposes the effective enabled models for a $name", ({ enabledModelIds, expected }) => {
    const plaintext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
      ...(enabledModelIds ? { enabledModelIds } : {}),
    });
    const row = {
      id: "cred-listed",
      provider: "openai-compatible",
      label: "Server",
      isDefault: true,
      defaultModel: "Y",
    };
    const dto = modelCredentialDto(row, plaintext);
    expect(dto.enabledModelIds).toEqual(expected);
    if (enabledModelIds === undefined) {
      expect(dto).not.toHaveProperty("enabledModelIds");
      expect(canUseCompatibleModelAsDefault(dto.enabledModelIds, "new-default")).toBe(true);
    } else {
      expect(canUseCompatibleModelAsDefault(dto.enabledModelIds, "new-default")).toBe(false);
    }
  });

  it("projects image support for the selected model only", () => {
    const plaintext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
      visionModelIds: ["vision-model", "another-vision-model"],
    });
    const row = {
      id: "cred-vision",
      provider: "openai-compatible",
      label: "Vision server",
      isDefault: true,
      supportsImages: false,
    };

    expect(modelCredentialDto({ ...row, defaultModel: "vision-model" }, plaintext)).toMatchObject({
      supportsImages: true,
      modelId: "vision-model",
    });
    expect(modelCredentialDto({ ...row, defaultModel: "text-model" }, plaintext)).toMatchObject({
      supportsImages: false,
      modelId: "text-model",
    });
  });

  it("projects the configured image limit for an OpenAI-compatible connection", () => {
    const plaintext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
      maxImagesPerPrompt: 1,
    });

    expect(
      modelCredentialDto(
        {
          id: "cred-one-image",
          provider: "openai-compatible",
          label: "Single-image server",
          isDefault: true,
          defaultModel: "custom-vision-model",
        },
        plaintext,
      ),
    ).toMatchObject({ maxImagesPerPrompt: 1 });
  });

  it("projects the configured output-token limit for an OpenAI-compatible connection", () => {
    const plaintext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
      maxTokens: 8192,
    });

    expect(
      modelCredentialDto(
        {
          id: "cred-output-tokens",
          provider: "openai-compatible",
          label: "Reasoning server",
          isDefault: true,
          defaultModel: "qwen-model",
        },
        plaintext,
      ),
    ).toMatchObject({ maxTokens: 8192 });
  });

  it("projects the configured context window for an OpenAI-compatible connection", () => {
    const plaintext = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://example.invalid/v1",
      contextWindow: 65536,
    });

    expect(
      modelCredentialDto(
        {
          id: "cred-context-window",
          provider: "openai-compatible",
          label: "Long-context server",
          isDefault: true,
          defaultModel: "qwen-model",
        },
        plaintext,
      ),
    ).toMatchObject({ contextWindow: 65536 });
  });

  it("reports a stored API key without returning the secret", () => {
    const deepseek = connectAsOwner({
      provider: "deepseek",
      apiKey: "sk-deepseek-test",
    });
    const row = {
      id: "cred-deepseek",
      provider: "deepseek",
      label: "DeepSeek",
      isDefault: true,
      defaultModel: "deepseek-chat",
    };
    expect(modelCredentialDto(row, deepseek)).toMatchObject({ hasKey: true });
    expect(JSON.stringify(modelCredentialDto(row, deepseek))).not.toContain("sk-deepseek-test");

    const compatible = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-deepseek-test",
    });
    const compatibleDto = modelCredentialDto({ ...row, provider: "openai-compatible" }, compatible);
    expect(compatibleDto.hasKey).toBe(true);
    expect(JSON.stringify(compatibleDto)).not.toContain("sk-deepseek-test");

    const keyless = connectAsOwner({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      modelId: "local-model",
    });
    expect(
      modelCredentialDto(
        { ...row, provider: "openai-compatible", defaultModel: "local-model" },
        keyless,
      ).hasKey,
    ).toBe(false);

    const oauth = serializeModelSecret({
      kind: "oauth",
      credential: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 10 },
    });
    expect(modelCredentialDto({ ...row, provider: "openai-codex" }, oauth).hasKey).toBe(false);
    expect(modelCredentialDto(row).hasKey).toBe(false);

    const rejected = serializeModelSecret({
      kind: "oauth",
      reconnectRequired: true,
      maxTokens: 4096,
    });
    const rejectedDto = modelCredentialDto({ ...row, provider: "openai-codex" }, rejected);
    expect(rejectedDto).toMatchObject({
      authKind: "oauth",
      reconnectRequired: true,
      maxTokens: 4096,
      hasKey: false,
    });
    expect(JSON.stringify(rejectedDto)).not.toContain("access");
    expect(JSON.stringify(rejectedDto)).not.toContain("refresh");
  });

  it("exposes defaultModel as modelId for provider credentials", () => {
    expect(
      modelCredentialDto({
        id: "cred-2",
        provider: "xai",
        label: "xAI",
        isDefault: false,
        defaultModel: "grok-4.6",
      }),
    ).toEqual({
      id: "cred-2",
      provider: "xai",
      label: "xAI",
      hasKey: false,
      isDefault: false,
      modelId: "grok-4.6",
    });
  });
});

it.each([true, false])(
  "persists generic reasoning capability %s with the connection",
  (reasoning) => {
    const plaintext = connectAsOwner({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "arbitrary-model",
      reasoning,
    });
    expect(parseModelSecret(plaintext)).toEqual({
      kind: "openai_compatible",
      baseUrl: "http://localhost:8000/v1",
      reasoning,
      enabledModelIds: ["arbitrary-model"],
    });
    expect(
      modelCredentialDto(
        {
          id: "cred",
          provider: "openai-compatible",
          label: "Server",
          isDefault: true,
          defaultModel: "arbitrary-model",
        },
        plaintext,
      ),
    ).toMatchObject({
      reasoning,
      thinkingLevels: reasoning
        ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        : ["off"],
    });
  },
);

it.each([null, "low", "high"] as const)(
  "round-trips the nullable custom reasoning effort %s",
  (thinkingLevel) => {
    const plaintext = connectAsOwner({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "arbitrary-model",
      reasoning: true,
      thinkingLevel,
    });
    expect(parseModelSecret(plaintext)).toMatchObject({
      kind: "openai_compatible",
      thinkingLevel,
    });
    expect(
      modelCredentialDto(
        {
          id: "cred",
          provider: "openai-compatible",
          label: "Server",
          isDefault: true,
          defaultModel: "arbitrary-model",
        },
        plaintext,
      ),
    ).toMatchObject({ thinkingLevel });
  },
);

describe("compatible connection updates", () => {
  const input = {
    provider: "openai-compatible",
    modelId: "arbitrary-model",
    baseUrl: "http://localhost:8000/v1",
    reasoning: true,
  };
  const previous = serializeModelSecret({
    kind: "openai_compatible",
    baseUrl: input.baseUrl,
    apiKey: "fake-saved-key",
  });
  afterEach(() => vi.unstubAllEnvs());

  it("preserves a saved key on a capability-only update to the same normalized URL", () => {
    expect(
      parseModelSecret(connectAsOwner({ ...input, baseUrl: "http://localhost:8000" }, previous)),
    ).toMatchObject({ apiKey: "fake-saved-key", reasoning: true });
  });
  it("does not transfer a saved key to a different endpoint", () => {
    expect(
      parseModelSecret(connectAsOwner({ ...input, baseUrl: "http://localhost:8001/v1" }, previous)),
    ).not.toHaveProperty("apiKey");
  });

  it("keeps image capability scoped to each explicitly enabled model", () => {
    const vision = connectAsOwner({ ...input, supportsImages: true });
    const text = connectAsOwner({ ...input, modelId: "text-model", supportsImages: false }, vision);
    const nextVision = connectAsOwner(
      { ...input, modelId: "another-vision-model", supportsImages: true },
      text,
    );

    expect(parseModelSecret(text)).toMatchObject({
      visionModelIds: ["arbitrary-model"],
    });
    expect(parseModelSecret(nextVision)).toMatchObject({
      visionModelIds: ["arbitrary-model", "another-vision-model"],
    });
  });
  it("stores the enabled models de-duplicated with the default first", () => {
    const saved = parseModelSecret(
      connectAsOwner({
        ...input,
        enabledModelIds: [" other-model ", "arbitrary-model", "other-model", "third-model"],
      }),
    );
    expect(saved).toMatchObject({
      enabledModelIds: ["arbitrary-model", "other-model", "third-model"],
    });
  });
  it("inherits the enabled models on the same endpoint when the input omits them", () => {
    const configured = connectAsOwner({ ...input, enabledModelIds: ["other-model"] });
    const updated = connectAsOwner(
      { ...input, modelId: "third-model", reasoning: false },
      configured,
    );
    expect(parseModelSecret(updated)).toMatchObject({
      enabledModelIds: ["third-model", "arbitrary-model", "other-model"],
    });
  });
  it("drops the enabled models when the endpoint changes", () => {
    const configured = connectAsOwner({ ...input, enabledModelIds: ["other-model"] });
    const moved = connectAsOwner({ ...input, baseUrl: "http://localhost:8001/v1" }, configured);
    expect(parseModelSecret(moved)).toMatchObject({ enabledModelIds: ["arbitrary-model"] });
  });
  it("keeps the client list plus the default when the previous secret is unreadable", () => {
    const saved = parseModelSecret(
      connectAsOwner(
        { ...input, apiKey: "fake-replacement-key", enabledModelIds: ["other-model"] },
        undefined,
        { omitVisionModelIds: true },
      ),
    );
    expect(saved).toMatchObject({ enabledModelIds: ["arbitrary-model", "other-model"] });
  });
  it("lets an explicit list replace the inherited one", () => {
    const configured = connectAsOwner({ ...input, enabledModelIds: ["other-model"] });
    const updated = connectAsOwner({ ...input, enabledModelIds: [] }, configured);
    expect(parseModelSecret(updated)).toMatchObject({ enabledModelIds: ["arbitrary-model"] });
  });
  it("persists the image limit while preserving it on connection updates", () => {
    const configured = connectAsOwner({
      ...input,
      maxImagesPerPrompt: 1,
    });
    const updated = connectAsOwner({ ...input, reasoning: false }, configured);

    expect(parseModelSecret(configured)).toMatchObject({ maxImagesPerPrompt: 1 });
    expect(parseModelSecret(updated)).toMatchObject({ maxImagesPerPrompt: 1 });
  });
  it("clears a saved image limit when explicitly requested", () => {
    const configured = connectAsOwner({
      ...input,
      maxImagesPerPrompt: 1,
    });
    const cleared = connectAsOwner(
      {
        ...input,
        maxImagesPerPrompt: null,
      },
      configured,
    );

    expect(parseModelSecret(cleared)).not.toHaveProperty("maxImagesPerPrompt");
  });

  it("persists the output-token limit while preserving it on connection updates", () => {
    const configured = connectAsOwner({
      ...input,
      maxTokens: 8192,
    });
    const updated = connectAsOwner({ ...input, reasoning: false }, configured);

    expect(parseModelSecret(configured)).toMatchObject({ maxTokens: 8192 });
    expect(parseModelSecret(updated)).toMatchObject({ maxTokens: 8192 });
  });
  it("persists the context window while preserving it on connection updates", () => {
    const configured = connectAsOwner({
      ...input,
      contextWindow: 65536,
    });
    const updated = connectAsOwner({ ...input, reasoning: false }, configured);

    expect(parseModelSecret(configured)).toMatchObject({ contextWindow: 65536 });
    expect(parseModelSecret(updated)).toMatchObject({ contextWindow: 65536 });
  });
  it.each(["", "fake-replacement-key"])(
    "honors an explicit key replacement or removal",
    (apiKey) => {
      const saved = parseModelSecret(connectAsOwner({ ...input, apiKey }, previous));
      if (apiKey) expect(saved).toHaveProperty("apiKey", apiKey);
      else expect(saved).not.toHaveProperty("apiKey");
    },
  );
  it("omits visionModelIds when prior plaintext is unavailable during key replacement", () => {
    const saved = parseModelSecret(
      connectAsOwner(
        { ...input, apiKey: "fake-replacement-key", supportsImages: true },
        undefined,
        { omitVisionModelIds: true },
      ),
    );
    expect(saved).toMatchObject({
      kind: "openai_compatible",
      apiKey: "fake-replacement-key",
    });
    expect(saved).not.toHaveProperty("visionModelIds");
  });
  it("preserves multi-model visionModelIds when prior plaintext loads during key replacement", () => {
    const prior = serializeModelSecret({
      kind: "openai_compatible",
      baseUrl: input.baseUrl,
      apiKey: "fake-saved-key",
      visionModelIds: ["bot-vision-model", "another-vision-model"],
    });
    const saved = parseModelSecret(
      connectAsOwner({ ...input, apiKey: "fake-replacement-key", supportsImages: true }, prior),
    );
    expect(saved).toMatchObject({
      apiKey: "fake-replacement-key",
      visionModelIds: ["bot-vision-model", "another-vision-model", "arbitrary-model"],
    });
  });
  it("revalidates inherited keys against the public-HTTPS policy", () => {
    vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "1");
    const baseUrl = "http://example.invalid/v1";
    const legacy = serializeModelSecret({ kind: "openai_compatible", baseUrl, apiKey: "fake-key" });
    expect(() => connectAsOwner({ ...input, baseUrl }, legacy)).toThrow(/HTTPS/);
  });
});

it("exposes saved Azure credentials under the catalog provider id", () => {
  expect(
    modelCredentialDto({
      id: "credential-azure",
      provider: "azure-openai-responses",
      label: "Azure",
      isDefault: true,
      defaultModel: "gpt-4o",
    }),
  ).toMatchObject({ provider: "azure", modelId: "gpt-4o" });
});

describe("compatible model selection limit", () => {
  it("round-trips a full list across spaces without growing it or dropping selected models", () => {
    const ids = Array.from({ length: 500 }, (_, index) => `model-${index}`);
    let plaintext: string | undefined;
    for (const modelId of ["space-a", "space-b", "space-c", "space-a"]) {
      const input = ModelConnectInputSchema.parse({
        provider: "openai-compatible",
        baseUrl: "http://localhost:8000/v1",
        modelId,
        enabledModelIds: ids,
      });
      plaintext = connectAsOwner(input, plaintext);
      const parsed = parseModelSecret(plaintext);
      expect(parsed.kind).toBe("openai_compatible");
      if (parsed.kind !== "openai_compatible") throw new Error("Wrong secret kind");
      expect(parsed.enabledModelIds).toEqual(ids);
      const dto = modelCredentialDto(
        {
          id: "credential",
          provider: input.provider,
          label: "Local",
          isDefault: true,
          defaultModel: modelId,
        },
        plaintext,
      );
      expect(dto.enabledModelIds).toEqual([modelId, ...ids]);
      expect(
        ModelConnectInputSchema.safeParse({
          ...input,
          enabledModelIds: dto.enabledModelIds?.filter((id) => id !== modelId),
        }).success,
      ).toBe(true);
    }
  });
});

describe("compatible connection header secrets", () => {
  const input = {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
    modelId: "test",
  };
  it("stores headers without returning their values and preserves only at the same endpoint", () => {
    const plaintext = connectAsOwner({ ...input, headers: { "x-session": "private-value" } });
    expect(parseModelSecret(plaintext)).toHaveProperty("headers", { "x-session": "private-value" });
    const dto = modelCredentialDto(
      { id: "credential", provider: input.provider, label: "Test", isDefault: false },
      plaintext,
    );
    expect(dto).toHaveProperty("headerNames", ["x-session"]);
    expect(JSON.stringify(dto)).not.toContain("private-value");
    expect(parseModelSecret(connectAsOwner(input, plaintext))).toHaveProperty("headers", {
      "x-session": "private-value",
    });
    expect(parseModelSecret(connectAsOwner({ ...input, headers: {} }, plaintext))).toHaveProperty(
      "headers",
      {},
    );
    expect(
      parseModelSecret(
        connectAsOwner({ ...input, baseUrl: "http://127.0.0.2:8000/v1" }, plaintext),
      ),
    ).not.toHaveProperty("headers");
  });
});

it("returns only header names in a compatible credential DTO", () => {
  const plaintext = JSON.stringify({
    kind: "openai_compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
    headers: { "x-session": "fake-session-secret" },
  });
  const dto = modelCredentialDto(
    { id: "credential", provider: "openai-compatible", label: "Test", isDefault: false },
    plaintext,
  );
  expect(dto).toHaveProperty("headerNames", ["x-session"]);
  expect(JSON.stringify(dto)).not.toContain("fake-session-secret");
});

it("requires HTTPS when saving new or inherited headers on public HTTP", () => {
  vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "1");
  try {
    const input = {
      provider: "openai-compatible",
      baseUrl: "http://models.example/v1",
      modelId: "test",
    };
    const headers = { "x-session": "long-session-secret" };
    expect(() => buildModelConnectPlaintext({ ...input, headers })).toThrow(
      /API key or custom headers must use HTTPS/,
    );
    const previous = JSON.stringify({ kind: "openai_compatible", baseUrl: input.baseUrl, headers });
    expect(() => buildModelConnectPlaintext(input, previous)).toThrow(
      /API key or custom headers must use HTTPS/,
    );
    expect(() => buildModelConnectPlaintext({ ...input, headers: {} }, previous)).not.toThrow();
  } finally {
    vi.unstubAllEnvs();
  }
});
