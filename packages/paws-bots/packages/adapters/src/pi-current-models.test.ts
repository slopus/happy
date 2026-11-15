import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { listPiCatalog } from "./pi-models.js";
import { modelsForRequest } from "./pi-runtime-models.js";

describe("current model compatibility", () => {
  it("disables strict tools for Bedrock Haiku in India", () => {
    const provider = "amazon-bedrock";
    const id = "in.anthropic.claude-haiku-4-5-20251001-v1:0";
    const model = modelsForRequest({ model: { provider, id } }, provider).getModel(provider, id);
    expect(model?.compat).toMatchObject({ supportsStrictMode: false });
  });

  it.each([
    ["anthropic", "claude-sonnet-5-5"],
    ["opencode", "claude-haiku-5-5"],
    ["opencode", "claude-sonnet-5-5"],
    ["opencode-go", "claude-haiku-5-5"],
    ["openai-codex", "gpt-6.1-sol"],
    ["openrouter", "deepseek/deepseek-v4.1-flash-1017"],
    ["amazon-bedrock", "anthropic.claude-sonnet-5-5"],
    ["amazon-bedrock", "eu.anthropic.claude-sonnet-5-5"],
    ["amazon-bedrock", "global.anthropic.claude-sonnet-5-5"],
    ["amazon-bedrock", "global.moonshotai.kimi-k3"],
    ["amazon-bedrock", "global.openai.gpt-6-luna"],
    ["amazon-bedrock", "global.openai.gpt-6-sol"],
    ["amazon-bedrock", "global.openai.gpt-6.1-sol"],
    ["amazon-bedrock", "global.xai.grok-4.7"],
    ["amazon-bedrock", "global.zai.glm-5.3"],
    ["amazon-bedrock", "in.anthropic.claude-haiku-4-5-20251001-v1:0"],
    ["amazon-bedrock", "in.anthropic.claude-opus-5"],
    ["amazon-bedrock", "in.anthropic.claude-sonnet-5"],
    ["amazon-bedrock", "openai.gpt-6-luna"],
    ["amazon-bedrock", "openai.gpt-6-sol"],
    ["amazon-bedrock", "openai.gpt-6.1-sol"],
    ["amazon-bedrock", "us.anthropic.claude-sonnet-5-5"],
    ["amazon-bedrock", "us.moonshotai.kimi-k3"],
    ["amazon-bedrock", "us.openai.gpt-6-luna"],
    ["amazon-bedrock", "us.openai.gpt-6-sol"],
    ["amazon-bedrock", "us.openai.gpt-6.1-sol"],
    ["amazon-bedrock", "us.xai.grok-4.7"],
    ["amazon-bedrock", "us.zai.glm-5.3"],
  ])("ships %s/%s natively", (provider, id) => {
    expect(builtinModels().getModel(provider, id)).toBeDefined();
    expect(listPiCatalog().some((entry) => entry.provider === provider && entry.id === id)).toBe(
      true,
    );
    expect(
      modelsForRequest(
        { model: { provider, id } } as Parameters<typeof modelsForRequest>[0],
        provider,
      ).getModel(provider, id),
    ).toBeDefined();
  });
  it.each([
    ["anthropic", "claude-sonnet-5-5"],
    ["openai-codex", "gpt-6.1-sol"],
  ])("exposes %s/%s in the picker and runtime with valid efforts", (provider, id) => {
    const model = modelsForRequest(
      { model: { provider, id } } as Parameters<typeof modelsForRequest>[0],
      provider,
    ).getModel(provider, id);
    expect(model).toBeDefined();
    const levels = [
      ...(provider === "openai-codex" ? ["minimal"] : []),
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ];
    expect(getSupportedThinkingLevels(model!)).toEqual(levels);
    expect(model?.input).toContain("image");
    expect(
      listPiCatalog().find((entry) => entry.provider === provider && entry.id === id)
        ?.thinkingLevels,
    ).toEqual(levels);
  });
  it.each([
    ["us.anthropic.claude-sonnet-5-5", "us.anthropic.claude-sonnet-5"],
    ["global.anthropic.claude-sonnet-5-5", "global.anthropic.claude-sonnet-5"],
    ["us.openai.gpt-6.1-sol", "us.openai.gpt-6-astra"],
  ])("lists Bedrock %s with the endpoint and efforts of %s", (id, baseId) => {
    const catalog = listPiCatalog();
    const levels = (modelId: string) =>
      catalog.find((entry) => entry.provider === "amazon-bedrock" && entry.id === modelId)
        ?.thinkingLevels;
    expect(levels(id)).toBeDefined();
    expect(levels(id)).toEqual(levels(baseId));
    const models = builtinModels();
    const model = models.getModel("amazon-bedrock", id);
    expect(model?.baseUrl).toBe(models.getModel("amazon-bedrock", baseId)?.baseUrl);
    expect(model?.input).toContain("image");
  });
  it.each([
    [
      "us.openai.gpt-6.1-sol",
      {
        input: 2.2,
        output: 11,
        cacheRead: 0.11,
        cacheWrite: 2.75,
        tiers: [
          { inputTokensAbove: 272000, input: 4.4, output: 16.5, cacheRead: 0.22, cacheWrite: 5.5 },
        ],
      },
    ],
    [
      "eu.anthropic.claude-sonnet-5-5",
      { input: 2.2, output: 11, cacheRead: 0.11, cacheWrite: 2.75 },
    ],
  ] as const)("uses catalog prices for Bedrock %s", (id, cost) => {
    const models = builtinModels();
    expect(models.getModel("amazon-bedrock", id)?.cost).toEqual(cost);
  });
  it.each([
    ["opencode", "claude-haiku-5-5", "claude-haiku-4-5"],
    ["opencode", "claude-sonnet-5-5", "claude-sonnet-5"],
    ["opencode-go", "claude-haiku-5-5", "minimax-m3"],
  ])(
    "exposes %s/%s in the picker and runtime on the same endpoint as %s",
    (provider, id, baseId) => {
      const models = modelsForRequest(
        { model: { provider, id } } as Parameters<typeof modelsForRequest>[0],
        provider,
      );
      const model = models.getModel(provider, id);
      const base = models.getModel(provider, baseId);
      expect(model).toBeDefined();
      expect(model?.baseUrl).toBe(base?.baseUrl);
      expect(model?.api).toBe(base?.api);
      expect(model?.input).toContain("image");
      expect(model?.contextWindow).toBe(1000000);
      const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      expect(getSupportedThinkingLevels(model!)).toEqual(levels);
      expect(
        listPiCatalog().find((entry) => entry.provider === provider && entry.id === id)
          ?.thinkingLevels,
      ).toEqual(levels);
    },
  );
});
