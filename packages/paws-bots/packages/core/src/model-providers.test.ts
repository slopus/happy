import { describe, expect, it } from "vitest";
import {
  botsWithOwnModel,
  canUseCompatibleModelAsDefault,
  chatModelChoices,
  clampCatalogThinkingLevel,
  compatibleModelRows,
  connectedModelChoices,
  connectionMaxTokensField,
  credentialForModel,
  filterModelChoices,
  groupModelChoices,
  pickCatalogModelId,
  popularModelProvidersFirst,
  resolveSelectableModelId,
  savedCompatibleModelIds,
  toggleEnabledModelId,
} from "./model-providers.js";

it("counts only bots that pick both a provider and a model", () => {
  expect(
    botsWithOwnModel([
      { modelProvider: "anthropic", modelId: "claude-opus-5-5" },
      { modelProvider: null, modelId: null },
      { modelProvider: "openai-codex", modelId: null },
    ]),
  ).toHaveLength(1);
});

describe("popularModelProvidersFirst", () => {
  it("lists the popular providers in curated order first, then the rest by name", () => {
    const providers = [
      { id: "openai-compatible", name: "OpenAI-compatible" },
      { id: "azure", name: "Azure OpenAI" },
      { id: "google", name: "Google" },
      { id: "openai-compatible", name: "Ollama Cloud" },
      { id: "groq", name: "Groq" },
      { id: "openrouter", name: "OpenRouter" },
      { id: "openai-codex", name: "ChatGPT" },
    ];
    expect(
      popularModelProvidersFirst(
        providers,
        (provider) => provider.id,
        (provider) => provider.name,
      ).map((provider) => provider.name),
    ).toEqual([
      "ChatGPT",
      "OpenRouter",
      "Google",
      "Azure OpenAI",
      "Groq",
      "Ollama Cloud",
      "OpenAI-compatible",
    ]);
  });
});

describe("pickCatalogModelId", () => {
  const catalog = [
    { provider: "openrouter", id: "openai/gpt-6-luna" },
    { provider: "openrouter", id: "anthropic/claude-fable-5" },
    { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
    { provider: "openai-codex", id: "gpt-6-luna" },
  ];

  it("returns the provider's first entry without a preferred id", () => {
    expect(pickCatalogModelId(catalog, "openai-codex", null)).toBe("gpt-5.3-codex-spark");
    expect(pickCatalogModelId(catalog, "openai-codex")).toBe("gpt-5.3-codex-spark");
  });

  it("uses a recommendation before catalog order, but preserves a saved choice", () => {
    const recommendedCatalog = [
      { provider: "provider-a", id: "first" },
      { provider: "provider-a", id: "recommended", recommended: true },
      { provider: "provider-b", id: "other", recommended: true },
    ];
    expect(pickCatalogModelId(recommendedCatalog, "provider-a")).toBe("recommended");
    expect(pickCatalogModelId(recommendedCatalog, "provider-a", "first")).toBe("first");
    expect(pickCatalogModelId(recommendedCatalog, "provider-a", "vendor/first")).toBe("first");
    expect(pickCatalogModelId(recommendedCatalog, "provider-a", "unavailable")).toBe("recommended");
    expect(pickCatalogModelId(recommendedCatalog, "provider-c")).toBe("");
    expect(
      pickCatalogModelId(
        recommendedCatalog.filter((entry) => !entry.recommended),
        "provider-a",
      ),
    ).toBe("first");
  });

  it("prefers an exact preferred id within the provider", () => {
    expect(pickCatalogModelId(catalog, "openai-codex", "gpt-6-luna")).toBe("gpt-6-luna");
    expect(pickCatalogModelId(catalog, "openrouter", "openai/gpt-6-luna")).toBe(
      "openai/gpt-6-luna",
    );
  });

  it("matches the preferred id's basename across vendor prefixes", () => {
    expect(pickCatalogModelId(catalog, "openai-codex", "openai/gpt-6-luna")).toBe("gpt-6-luna");
  });

  it("ignores a preferred id that belongs to another provider only", () => {
    expect(pickCatalogModelId(catalog, "openai-codex", "openai/gpt-6-astra")).toBe(
      "gpt-5.3-codex-spark",
    );
    expect(pickCatalogModelId(catalog, "openai-codex", "anthropic/claude-fable-5")).toBe(
      "gpt-5.3-codex-spark",
    );
  });

  it("returns an empty string for an unknown provider", () => {
    expect(pickCatalogModelId(catalog, "nope", "openai/gpt-6-luna")).toBe("");
  });
});

describe("clampCatalogThinkingLevel", () => {
  it("keeps a level the model supports and drops the default", () => {
    expect(clampCatalogThinkingLevel("high", ["low", "medium", "high"])).toBe("high");
    expect(clampCatalogThinkingLevel(null, ["high"])).toBeNull();
    expect(clampCatalogThinkingLevel("off", ["off", "high"])).toBeNull();
  });

  it("clamps an unsupported level to the nearest supported effort", () => {
    expect(clampCatalogThinkingLevel("xhigh", ["minimal", "low", "medium", "high"])).toBe("high");
    expect(clampCatalogThinkingLevel("minimal", ["high", "xhigh"])).toBe("high");
  });

  it("resets when the model cannot think", () => {
    expect(clampCatalogThinkingLevel("high", ["off"])).toBeNull();
    expect(clampCatalogThinkingLevel("high", [])).toBeNull();
  });

  it("keeps a concrete level when the model is outside the catalog", () => {
    expect(clampCatalogThinkingLevel("high", undefined)).toBe("high");
  });
});

describe("connected model choices", () => {
  const deepseek = [
    {
      provider: "deepseek",
      providerName: "DeepSeek",
      id: "deepseek-flash",
      label: "DeepSeek V4.1 Flash",
    },
    {
      provider: "deepseek",
      providerName: "DeepSeek",
      id: "deepseek-v4-pro",
      label: "DeepSeek V4 Pro",
    },
  ];

  it("submits API model ids and keeps display labels out of the value", () => {
    const choices = connectedModelChoices(
      [{ provider: "deepseek", label: "DeepSeek", modelId: "DeepSeek-V4.1-Flash" }],
      deepseek,
    );
    expect(choices.map((choice) => choice.modelId)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(choices.map((choice) => choice.key)).toEqual([
      "deepseek::deepseek-flash",
      "deepseek::deepseek-v4-pro",
    ]);
    for (const choice of choices) {
      expect(choice.modelId).not.toBe(choice.label);
      expect(choice.modelId).not.toMatch(/DeepSeek/);
    }
    expect(choices.map((choice) => choice.label)).toEqual([
      "DeepSeek V4.1 Flash (DeepSeek)",
      "DeepSeek V4 Pro (DeepSeek)",
    ]);
  });

  it("carries whether a catalog model reads images, and leaves custom ids unknown", () => {
    const catalog = [
      { provider: "openrouter", id: "text-only", label: "Text Only", images: false },
      { provider: "openrouter", id: "sees", label: "Sees", images: true },
      { provider: "openrouter", id: "unknown", label: "Unknown" },
      { provider: "other", id: "custom", label: "Other provider", images: false },
      {
        provider: "openrouter",
        id: "placeholder",
        label: "Placeholder",
        placeholder: true,
        images: false,
      },
    ];
    const choices = connectedModelChoices(
      [{ provider: "openrouter", label: "OpenRouter" }],
      catalog,
    );
    expect(choices.map((choice) => choice.images)).toEqual([false, true, undefined]);
    const enabled = connectedModelChoices(
      [
        {
          provider: "openrouter",
          label: "OpenRouter",
          enabledModelIds: ["text-only", "sees", "unknown", "custom", "placeholder"],
        },
      ],
      catalog,
    );
    expect(enabled.map((choice) => choice.images)).toEqual([
      false,
      true,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("rewrites a catalog id that is only a display label", () => {
    const choices = connectedModelChoices(
      [{ provider: "deepseek", label: "DeepSeek", modelId: "deepseek-flash" }],
      [
        {
          provider: "deepseek",
          providerName: "DeepSeek",
          id: "DeepSeek-V4.1-Flash",
          label: "DeepSeek V4.1 Flash",
        },
        ...deepseek.slice(1),
      ],
    );
    expect(choices.map((choice) => choice.modelId)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  });

  it("keeps a custom model id that is not a catalog label", () => {
    expect(
      connectedModelChoices(
        [{ provider: "deepseek", label: "DeepSeek", modelId: "my-finetune" }],
        deepseek,
      ),
    ).toEqual([
      {
        key: "deepseek::my-finetune",
        provider: "deepseek",
        modelId: "my-finetune",
        label: "my-finetune (DeepSeek)",
        providerLabel: "DeepSeek",
        modelLabel: "my-finetune",
      },
    ]);
  });

  it("offers one choice per enabled model id on a compatible connection", () => {
    const choices = connectedModelChoices(
      [
        {
          provider: "openai-compatible",
          label: "Local server",
          modelId: "alpha",
          enabledModelIds: ["alpha", "beta", "gamma", "beta"],
        },
      ],
      deepseek,
    );
    expect(choices).toEqual(
      ["alpha", "beta", "gamma"].map((id) => ({
        key: `openai-compatible::${id}`,
        provider: "openai-compatible",
        modelId: id,
        label: `${id} (Local server)`,
        providerLabel: "Local server",
        modelLabel: id,
      })),
    );
  });

  it("finds a credential by enabled model id or by its default model", () => {
    const compatible = {
      provider: "openai-compatible",
      label: "Local server",
      modelId: "alpha",
      enabledModelIds: ["alpha", "beta"],
    };
    const legacy = { provider: "deepseek", label: "DeepSeek", modelId: "my-finetune" };
    const credentials = [legacy, compatible];
    expect(credentialForModel(credentials, "openai-compatible", "beta")).toBe(compatible);
    expect(credentialForModel(credentials, "openai-compatible", "alpha")).toBe(compatible);
    expect(credentialForModel(credentials, "deepseek", "my-finetune")).toBe(legacy);
    expect(credentialForModel(credentials, "openai-compatible", "delta")).toBeUndefined();
    expect(credentialForModel(credentials, "deepseek", "beta")).toBeUndefined();
    expect(credentialForModel(credentials, null, "alpha")).toBeUndefined();
  });

  it("prefers a matching space model over a newer enabled match", () => {
    const newer = {
      provider: "openai-compatible",
      label: "Newer",
      modelId: null,
      enabledModelIds: ["Y"],
      thinkingLevels: ["off"],
    };
    const owner = {
      provider: "openai-compatible",
      label: "Owner",
      modelId: "Y",
      enabledModelIds: ["Y"],
      thinkingLevels: ["off", "high"],
    };
    expect(credentialForModel([newer, owner], "openai-compatible", "Y")).toBe(owner);
    const preferred = { ...owner, modelId: "X", isDefault: true };
    expect(credentialForModel([newer, preferred], "openai-compatible", "Y")).toBe(preferred);
  });

  it("uses server preference order without changing stable enabled-connection order", () => {
    const newest = {
      provider: "openai-compatible",
      label: "Newest",
      modelId: "Y",
      preferenceRank: 2,
      enabledModelIds: ["Y", "Z"],
    };
    const preferred = { ...newest, label: "Preferred", preferenceRank: 1 };
    const legacy = {
      provider: "openai-compatible",
      label: "Legacy",
      modelId: "X",
      isDefault: true,
      preferenceRank: 0,
    };
    const credentials = [newest, preferred, legacy];
    expect(credentialForModel(credentials, "openai-compatible", "Y")).toBe(preferred);
    expect(credentialForModel(credentials, "openai-compatible", "Z")).toBe(newest);
    expect(credentialForModel(credentials, "openai-compatible", "X")).toBe(legacy);
  });

  it("uses enabled connections before a legacy fallback for every choice", () => {
    const legacy = {
      provider: "openai-compatible",
      label: "Legacy",
      modelId: "X",
      isDefault: true,
    };
    const listed = { provider: "openai-compatible", label: "Listed", enabledModelIds: ["Y"] };
    expect(credentialForModel([listed, legacy], "openai-compatible", "Y")).toBe(listed);
    expect(credentialForModel([legacy], "openai-compatible", "Y")).toBe(legacy);
  });

  it("resolves a saved display label to the API id used on save", () => {
    expect(resolveSelectableModelId(deepseek, "deepseek", "DeepSeek-V4.1-Flash")).toBe(
      "deepseek-flash",
    );
    expect(resolveSelectableModelId(deepseek, "deepseek", "DeepSeek-V4-Pro")).toBe(
      "deepseek-v4-pro",
    );
    expect(resolveSelectableModelId(deepseek, "deepseek", "deepseek-v4-pro")).toBe(
      "deepseek-v4-pro",
    );
    expect(resolveSelectableModelId(deepseek, "deepseek", "my-finetune")).toBe("my-finetune");
  });
});

describe("chat model choices", () => {
  const connected = [
    {
      key: "openrouter::anthropic/claude-sonnet",
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet",
      label: "Claude Sonnet (OpenRouter)",
    },
    {
      key: "openrouter::openai/gpt-mini",
      provider: "openrouter",
      modelId: "openai/gpt-mini",
      label: "GPT Mini (OpenRouter)",
    },
  ];

  it("puts the space default first, then a saved model no connection offers, then the rest", () => {
    expect(chatModelChoices(connected, "openai::retired-model", "Space default")).toEqual([
      { key: "", label: "Space default" },
      {
        key: "openai::retired-model",
        label: "retired-model",
        provider: "openai",
        modelId: "retired-model",
      },
      ...connected,
    ]);
    expect(chatModelChoices(connected, connected[1]!.key, "Space default")).toEqual([
      { key: "", label: "Space default" },
      ...connected,
    ]);
  });

  it("marks the space default with its model's image support", () => {
    expect(chatModelChoices(connected, "", "Space default", false)[0]).toEqual({
      key: "",
      label: "Space default",
      images: false,
    });
    expect(chatModelChoices(connected, "", "Space default")[0]?.images).toBeUndefined();
  });

  it("matches the label, model id, or provider, ignoring case", () => {
    const choices = chatModelChoices(connected, "", "Space default (Claude Sonnet)");
    expect(filterModelChoices(choices, "  SONNET ").map((choice) => choice.key)).toEqual([
      "",
      "openrouter::anthropic/claude-sonnet",
    ]);
    expect(filterModelChoices(choices, "openai/").map((choice) => choice.key)).toEqual([
      "openrouter::openai/gpt-mini",
    ]);
    expect(
      filterModelChoices([{ key: "openrouter::x", label: "X", provider: "openrouter" }], "router"),
    ).toHaveLength(1);
    expect(
      filterModelChoices(
        [
          {
            key: "cloudflare-ai-gateway::x",
            label: "X",
            provider: "cloudflare-ai-gateway",
            providerLabel: "Cloudflare AI Gateway",
          },
        ],
        "AI Gateway",
      ),
    ).toHaveLength(1);
    expect(
      filterModelChoices(
        [{ key: "google", label: "Google", providerLabel: "All providers" }],
        "all",
      ),
    ).toEqual([]);
    expect(filterModelChoices(choices, "gemini")).toEqual([]);
    expect(filterModelChoices(choices, " ")).toBe(choices);
  });
});

describe("openai-compatible model rows", () => {
  const saved = { baseUrl: "http://127.0.0.1:8000/v1", enabledModelIds: ["a", "b"] };

  it("keeps the saved list only for the saved endpoint", () => {
    expect(savedCompatibleModelIds(saved, " http://127.0.0.1:8000/v1 ")).toEqual(["a", "b"]);
    expect(savedCompatibleModelIds(saved, "http://other.test/v1")).toEqual([]);
    expect(savedCompatibleModelIds({ baseUrl: saved.baseUrl }, saved.baseUrl)).toEqual([]);
    expect(savedCompatibleModelIds(undefined, saved.baseUrl)).toEqual([]);
  });

  it("compares endpoints the way the server stores them", () => {
    expect(savedCompatibleModelIds(saved, "http://127.0.0.1:8000/v1/")).toEqual(["a", "b"]);
    expect(savedCompatibleModelIds(saved, "http://127.0.0.1:8000")).toEqual(["a", "b"]);
    expect(savedCompatibleModelIds(saved, "http://127.0.0.2:8000/v1")).toEqual([]);
  });

  it("treats half-typed text as a different endpoint without throwing", () => {
    expect(savedCompatibleModelIds(saved, "http://")).toEqual([]);
    expect(savedCompatibleModelIds(saved, "127.0.0.1:80")).toEqual([]);
    expect(savedCompatibleModelIds({ ...saved, baseUrl: "not a url" }, " not a url ")).toEqual([
      "a",
      "b",
    ]);
  });

  it("lists saved, ticked and probed ids once each, in that order", () => {
    expect(compatibleModelRows(["a", "b"], ["b", "c"], ["d", "a"])).toEqual(["a", "b", "c", "d"]);
  });

  it("ticks and unticks an id without duplicates", () => {
    expect(toggleEnabledModelId(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleEnabledModelId(["a", "b"], "b", true)).toEqual(["a", "b"]);
    expect(toggleEnabledModelId(["a", "b"], "a", false)).toEqual(["b"]);
  });

  it("allows a default only from a saved list, and any default when the list is unread", () => {
    expect(canUseCompatibleModelAsDefault(["a", "b"], "b")).toBe(true);
    expect(canUseCompatibleModelAsDefault(["a"], "b")).toBe(false);
    expect(canUseCompatibleModelAsDefault(undefined, "b")).toBe(true);
  });
});

it("offers Azure catalog models for a credential saved with the old provider id", () => {
  const catalog = [{ provider: "azure", id: "gpt-4o", label: "GPT-4o" }];
  const choices = connectedModelChoices(
    [{ provider: "azure-openai-responses", label: "Azure", modelId: "gpt-4o" }],
    catalog,
  );
  expect(choices).toMatchObject([{ key: "azure::gpt-4o", provider: "azure", modelId: "gpt-4o" }]);
  expect(pickCatalogModelId(catalog, "azure-openai-responses", "gpt-4o")).toBe("gpt-4o");
});

describe("groupModelChoices", () => {
  const connected = connectedModelChoices(
    [{ provider: "openrouter", label: "OpenRouter" }],
    [
      {
        provider: "openrouter",
        providerName: "OpenRouter",
        id: "anthropic/opus",
        label: "Anthropic: Claude Opus",
      },
      {
        provider: "openrouter",
        providerName: "OpenRouter",
        id: "anthropic/sonnet",
        label: "Anthropic: Claude Sonnet",
      },
      {
        provider: "openrouter",
        providerName: "OpenRouter",
        id: "google/gemini",
        label: "Google: Gemini",
      },
    ],
  );
  const choices = chatModelChoices(connected, "retired::saved", "Space default");

  it("keeps default and disconnected choices first and groups catalog vendor names", () => {
    const sections = groupModelChoices(choices, "");
    expect(sections.map((section) => section.heading)).toEqual([
      undefined,
      "Anthropic (OpenRouter)",
      "Google (OpenRouter)",
    ]);
    expect(sections[0]?.data.map((choice) => choice.key)).toEqual(["", "retired::saved"]);
    expect(sections[1]?.data.map((choice) => choice.title)).toEqual([
      "Claude Opus",
      "Claude Sonnet",
    ]);
    expect(sections[1]?.data[0]?.label).toBe("Anthropic: Claude Opus (OpenRouter)");
  });

  it("matches the original full labels and ids and removes empty sections", () => {
    for (const query of ["OpenRouter", "Anthropic", "anthropic/opus", "Sonnet", "missing"]) {
      expect(
        groupModelChoices(choices, query).flatMap((section) =>
          section.data.map((choice) => choice.key),
        ),
      ).toEqual(filterModelChoices(choices, query).map((choice) => choice.key));
    }
    expect(groupModelChoices(choices, "Sonnet").map((section) => section.heading)).toEqual([
      "Anthropic (OpenRouter)",
    ]);
  });
});

it("offers managed models without a personal key and hides unconnected providers", () => {
  const catalog = [
    { provider: "hosted", id: "small", label: "Small", managed: true },
    { provider: "hosted", id: "large", label: "Large", managed: true },
    { provider: "other", id: "unconnected", label: "Unconnected" },
  ];
  expect(connectedModelChoices([], catalog).map((choice) => choice.key)).toEqual([
    "hosted::small",
    "hosted::large",
  ]);
  expect(connectedModelChoices([{ provider: "hosted", label: "Hosted" }], catalog)).toHaveLength(2);
});

describe("connectionMaxTokensField", () => {
  it("shows the saved limit, or the default an OpenAI-compatible endpoint would send", () => {
    expect(connectionMaxTokensField("openai-compatible", undefined)).toBe("4096");
    expect(connectionMaxTokensField("openai-compatible", 8_000)).toBe("8000");
    expect(connectionMaxTokensField("anthropic", undefined)).toBe("");
    expect(connectionMaxTokensField("anthropic", 2_000)).toBe("2000");
  });
});
