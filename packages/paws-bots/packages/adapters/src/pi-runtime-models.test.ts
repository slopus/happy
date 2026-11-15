import type { Api, Model } from "@earendil-works/pi-ai";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  normalizeContext,
} from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { buildModelConnectPlaintext, modelCredentialDto } from "./model-connect.js";
import { defaultCatalogModelId, isCatalogModelChoice } from "./model-selection.js";
import { modelAcceptsImageInput } from "./model-vision.js";
import { listPiCatalog } from "./pi-models.js";
import { resolveModelAuth } from "./pi-oauth.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";
import {
  acceptedReasoningEfforts,
  modelsForRequest,
  resolveRuntimeModel,
} from "./pi-runtime-models.js";

function requestModel(id: string, baseUrl: string): Pick<AgentRunRequest, "model"> {
  return {
    model: { provider: OPENAI_COMPATIBLE_PROVIDER_ID, id, baseUrl, allowPrivateEndpoint: true },
  };
}

describe("request model catalogs", () => {
  it.each([
    ["openrouter", "openai/gpt-5.6-luna"],
    ["openai-codex", "gpt-6-astra"],
    ["openai-codex", "gpt-6-luna"],
    ["openai-codex", "gpt-6-sol"],
    ["anthropic", "claude-fable-5-1"],
    ["anthropic", "claude-opus-5-5"],
  ])("offers and resolves %s/%s with vision", (provider, id) => {
    const entry = listPiCatalog().find((model) => model.provider === provider && model.id === id);
    expect(entry).toBeDefined();
    const model = modelsForRequest({ model: { provider, id } }, provider).getModel(provider, id);
    expect(model).toBeDefined();
    expect(model?.input).toContain("image");
    expect(modelAcceptsImageInput(provider, id)).toBe(true);
    expect(entry?.thinkingLevels).toEqual(getSupportedThinkingLevels(model!));
    if (provider === "openai-codex") {
      expect(entry?.signIn).toBe("device-code");
      expect(entry?.thinkingLevels).toContain("max");
    }
    if (provider === "anthropic") {
      expect(entry?.signIn).toBe("auth-url");
      expect(entry?.thinkingLevels).toContain("max");
    }
  });

  it.each([undefined, false, true])(
    "sends a run to a private endpoint only when the request allows it (%s)",
    async (allowPrivateEndpoint) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
      );
      const models = modelsForRequest(
        {
          model: {
            provider: OPENAI_COMPATIBLE_PROVIDER_ID,
            id: "local-model",
            baseUrl: "http://127.0.0.1:11434/v1",
            allowPrivateEndpoint,
          },
        },
        OPENAI_COMPATIBLE_PROVIDER_ID,
      );
      const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "local-model")!;
      await models
        .getProvider(OPENAI_COMPATIBLE_PROVIDER_ID)!
        .streamSimple(model, normalizeContext({ messages: [] }), {
          apiKey: "fake-api-key",
          fetch: fetchImpl,
        })
        .result();
      expect(fetchImpl).toHaveBeenCalledTimes(allowPrivateEndpoint ? 1 : 0);
    },
  );

  it("isolates concurrent OpenAI-compatible endpoint registrations", () => {
    const first = modelsForRequest(
      requestModel("first-model", "http://127.0.0.1:8001/v1"),
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    const second = modelsForRequest(
      requestModel("second-model", "http://127.0.0.1:8002/v1"),
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );

    expect(first).not.toBe(second);
    expect(first.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "first-model")?.baseUrl).toBe(
      "http://127.0.0.1:8001/v1",
    );
    expect(first.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "second-model")).toBeUndefined();
    expect(second.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "second-model")?.baseUrl).toBe(
      "http://127.0.0.1:8002/v1",
    );
  });

  it("applies a connected model's image capability to the runtime model", () => {
    const models = modelsForRequest(
      {
        model: {
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          id: "vision-model",
          baseUrl: "http://127.0.0.1:8000/v1",
          allowPrivateEndpoint: true,
          acceptsImages: true,
        },
      },
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );

    expect(models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "vision-model")?.input).toContain(
      "image",
    );
  });
});

it.each([true, false, undefined])(
  "keeps saved capability %s consistent between metadata and runtime",
  async (reasoning) => {
    const plaintext = buildModelConnectPlaintext(
      {
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelId: "same-model",
        baseUrl: "http://localhost:8000/v1",
        reasoning,
      },
      undefined,
      { allowPrivateEndpoint: true },
    );
    const auth = await resolveModelAuth(plaintext, OPENAI_COMPATIBLE_PROVIDER_ID);
    expect(auth.secret.kind).toBe("openai_compatible");
    if (auth.secret.kind !== "openai_compatible") throw new Error("Wrong credential type");
    const models = modelsForRequest(
      {
        model: {
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          id: "same-model",
          baseUrl: auth.secret.baseUrl,
          allowPrivateEndpoint: true,
          reasoning: auth.secret.reasoning,
        },
      },
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "same-model")!;
    const credential = modelCredentialDto(
      {
        id: "cred",
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        label: "Server",
        isDefault: true,
        defaultModel: "same-model",
      },
      plaintext,
    );
    expect(model.reasoning).toBe(reasoning ?? false);
    expect(credential.thinkingLevels).toEqual(getSupportedThinkingLevels(model));
  },
);

describe("resolveRuntimeModel", () => {
  it("does not route an unavailable provider model through OpenRouter", () => {
    const resolved = resolveRuntimeModel({
      provider: "anthropic",
      id: "openai/gpt-6-luna",
    });
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBeUndefined();
  });

  it("does not treat a stringified null as a catalog model", () => {
    const resolved = resolveRuntimeModel({ provider: "anthropic", id: "null" });
    expect(resolved.modelId).toBe("");
    expect(resolved.model).toBeUndefined();
    expect(resolved.provider).toBe("anthropic");
  });
});

it("resolves a saved Azure provider reference without changing its model id", () => {
  const provider = "azure-openai-responses";
  const id = "gpt-4o";
  const resolved = resolveRuntimeModel({ provider, id, apiKey: "test-azure-key" });
  expect(resolved.provider).toBe("azure");
  expect(resolved.model).toMatchObject({ provider: "azure", id });
  expect(resolved.apiKey).toBe("test-azure-key");
  expect(modelsForRequest({ model: { provider, id } }, provider).getModel(provider, id)).toEqual(
    resolved.model,
  );
  expect(modelAcceptsImageInput(provider, id)).toBe(true);
  expect(isCatalogModelChoice(provider, id)).toBe(true);
  expect(defaultCatalogModelId(provider)).toBeTruthy();
});

describe("reasoning efforts an endpoint refuses", () => {
  const model = (thinkingLevelMap: Model<Api>["thinkingLevelMap"]) =>
    ({ id: "example", reasoning: true, thinkingLevelMap }) as Model<Api>;

  it("keeps only the levels a generic endpoint lists and sends no effort for off", () => {
    const levels = acceptedReasoningEfforts(
      model({ off: "none", xhigh: "xhigh", max: "max" }),
      '400: {"message":"reasoning_effort must be one of: low, medium, high, max","type":"invalid_request_error","param":"","code":null}',
    );
    const narrowed = model(levels);
    expect(getSupportedThinkingLevels(narrowed)).toEqual(["off", "low", "medium", "high", "max"]);
    expect(levels?.off).toBeUndefined();
    expect(clampThinkingLevel(narrowed, "minimal")).toBe("low");
    expect(clampThinkingLevel(narrowed, "xhigh")).toBe("max");
  });

  it("reads OpenAI's wording and keeps an accepted off value", () => {
    const levels = acceptedReasoningEfforts(
      model({ off: "none" }),
      "400 Unsupported value: 'reasoning_effort' does not support 'minimal' with this model. Supported values are: 'none', 'low', 'medium', and 'high'.",
    );
    expect(levels).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  it("reads a list that follows a colon instead of the word are", () => {
    const levels = acceptedReasoningEfforts(
      model({ off: "none" }),
      `400: {"object":"error","message":"reasoning_effort 'medium' is not supported for this model; supported values: ['none', 'low', 'high', 'xhigh', 'max']","type":"invalid_request_invalid_args","code":"3051"}`,
    );
    expect(levels).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  it("sends no effort for off when a gateway refuses an effort without listing any", () => {
    const levels = acceptedReasoningEfforts(
      model({ off: "none", xhigh: "xhigh", max: "max" }),
      'openai-compatible API error (400): {"message":"Unsupported reasoning effort","type":"invalid_request_error","param":"","code":null}',
    );
    expect(levels).toEqual({ off: null, xhigh: "xhigh", max: "max" });
    expect(
      acceptedReasoningEfforts(model({}), "400: Unsupported reasoning effort"),
    ).toBeUndefined();
    for (const message of [
      "400: Invalid reasoning effort",
      "400: reasoning_effort is not supported for this model",
    ])
      expect(acceptedReasoningEfforts(model({ off: "none" }), message)).toEqual({ off: null });
    expect(
      acceptedReasoningEfforts(
        model({ off: "none" }),
        "400: reasoning_effort is supported; tool schema is invalid",
      ),
    ).toBeUndefined();
  });

  it.each([
    '400: {"message":"Unexpected message role.","type":"invalid_request_error"}',
    '400: {"message":"reasoning_effort must be one of: turbo","type":"invalid_request_error"}',
  ])("ignores a rejection that names no usable effort: %s", (error) => {
    expect(acceptedReasoningEfforts(model({ off: "none" }), error)).toBeUndefined();
  });
});

it("keeps protocol selection scoped to the request connection", () => {
  const request = requestModel("fixture-model", "http://127.0.0.1:8000/v1");
  const responses = modelsForRequest(
    { model: { ...request.model, apiProtocol: "responses" } },
    OPENAI_COMPATIBLE_PROVIDER_ID,
  );
  expect(responses.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "fixture-model")?.api).toBe(
    "openai-responses",
  );
  const anthropic = modelsForRequest(
    { model: { ...request.model, apiProtocol: "anthropic-messages" } },
    OPENAI_COMPATIBLE_PROVIDER_ID,
  );
  expect(anthropic.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "fixture-model")?.api).toBe(
    "anthropic-messages",
  );
  const legacy = modelsForRequest(request, OPENAI_COMPATIBLE_PROVIDER_ID);
  expect(legacy.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "fixture-model")?.api).toBe(
    "openai-completions",
  );
});
