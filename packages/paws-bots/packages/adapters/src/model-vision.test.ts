import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  filterImageReturningComputerTools,
  IMAGE_RETURNING_COMPUTER_TOOLS,
  knownModelImageInput,
  modelAcceptsImageInput,
  modelIdSupportsImages,
  resolveModelRefForVisionCheck,
  updateModelImageCapabilities,
} from "./model-vision.js";
import { listAvailablePiCatalog } from "./pi-catalog-availability.js";
import type { CodexCatalogSpaceAuth } from "./pi-codex-catalog.js";
import { applyCodexLiveCatalog, parseCodexCatalog } from "./pi-codex-catalog.js";
import { liveCatalogEntry } from "./pi-live-catalog.js";
import { CHATGPT_OAUTH_PROVIDER } from "./pi-oauth.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";

describe("model vision gating for computer tools", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats catalog text-only models as unable to see", () => {
    expect(modelAcceptsImageInput("openrouter", "deepseek/deepseek-v4-flash-0731")).toBe(false);
    expect(modelAcceptsImageInput("openrouter", "deepseek/deepseek-v4-pro")).toBe(false);
  });

  it("treats catalog vision models as able to see", () => {
    expect(modelAcceptsImageInput("openrouter", "openai/gpt-4o")).toBe(true);
    expect(modelAcceptsImageInput("openrouter", "deepseek/deepseek-v4-flash-vision-exp")).toBe(
      true,
    );
  });

  it("sees models the runtime adds to the bundled catalog", () => {
    expect(modelAcceptsImageInput("anthropic", "claude-sonnet-5-5")).toBe(true);
    expect(modelAcceptsImageInput("openai-codex", "gpt-6.1-sol")).toBe(true);
  });

  it.each([
    ["openai", "gpt-4o-2099-01-01", true],
    ["openai-codex", "gpt-6-luna-latest", true],
    ["openai-codex", "gpt-unknown-future-model", false],
  ])("agrees with listing and execution for live %s/%s", (provider, id, images) => {
    expect(liveCatalogEntry(provider, id)?.images).toBe(images);
    expect(resolveRuntimeModel({ provider, id }).model?.input.includes("image")).toBe(images);
    expect(modelAcceptsImageInput(provider, id)).toBe(images);
    const tools = filterImageReturningComputerTools(
      builtinAgentTools,
      modelAcceptsImageInput(provider, id),
    );
    expect(tools.some((tool) => tool.name === "computer_observe")).toBe(images);
  });

  it("resolves the scripted placeholder like Pi before checking vision", () => {
    vi.stubEnv("PI_DEFAULT_MODEL", "");
    expect(resolveModelRefForVisionCheck("scripted", "scripted")).toEqual({
      provider: "openrouter",
      id: "anthropic/claude-haiku-5.5",
    });
    expect(modelAcceptsImageInput("scripted", "scripted")).toBe(true);

    vi.stubEnv("PI_DEFAULT_MODEL", "openai/gpt-4o");
    expect(resolveModelRefForVisionCheck("scripted", "scripted")).toEqual({
      provider: "openrouter",
      id: "openai/gpt-4o",
    });
    expect(modelAcceptsImageInput("scripted", "scripted")).toBe(true);
  });

  it("follows the account catalog for a live Codex slug outside its sibling family", () => {
    const id = "gpt-6.2-terra";
    const provider = CHATGPT_OAUTH_PROVIDER;
    const auth: CodexCatalogSpaceAuth = {
      byProvider: { [provider]: "oauth" },
      byModel: {},
      secretIdByProvider: { [provider]: "secret-a" },
      secretIdByModel: {},
    };
    const base = listAvailablePiCatalog(auth.byProvider, auth.byModel);
    expect(liveCatalogEntry(provider, id)?.images).toBe(false);
    expect(modelAcceptsImageInput(provider, id)).toBe(false);
    expect(resolveRuntimeModel({ provider, id }).model?.input).toEqual(["text"]);

    for (const supportsImages of [true, false]) {
      const inputModalities = supportsImages ? ["text", "image"] : ["text"];
      const parsed = parseCodexCatalog({
        models: [
          {
            slug: "gpt-6.1-sol",
            visibility: "list",
            supported_in_api: true,
            input_modalities: ["text", "image"],
          },
          {
            slug: id,
            visibility: "list",
            supported_in_api: true,
            input_modalities: inputModalities,
          },
        ],
      });
      const entry = applyCodexLiveCatalog(base, auth, new Map([["secret-a", parsed ?? []]])).find(
        (item) => item.provider === provider && item.id === id,
      );
      expect(entry?.images).toBe(supportsImages);
      expect(modelAcceptsImageInput(provider, id, entry?.images)).toBe(supportsImages);
      expect(
        resolveRuntimeModel({ provider, id, acceptsImages: entry?.images }).model?.input.includes(
          "image",
        ),
      ).toBe(supportsImages);
      const names = filterImageReturningComputerTools(
        builtinAgentTools,
        modelAcceptsImageInput(provider, id, entry?.images),
      ).map((tool) => tool.name);
      for (const name of IMAGE_RETURNING_COMPUTER_TOOLS) {
        expect(names.includes(name)).toBe(supportsImages);
      }
    }
  });

  it("strips screenshot tools when a bundled Codex model is text-only in the account list", () => {
    const provider = CHATGPT_OAUTH_PROVIDER;
    const id = "gpt-6.1-sol";
    expect(modelAcceptsImageInput(provider, id)).toBe(true);
    expect(modelAcceptsImageInput(provider, id, false)).toBe(false);
    expect(resolveRuntimeModel({ provider, id, acceptsImages: false }).model?.input).toEqual([
      "text",
    ]);
    const names = filterImageReturningComputerTools(
      builtinAgentTools,
      modelAcceptsImageInput(provider, id, false),
    ).map((tool) => tool.name);
    for (const name of IMAGE_RETURNING_COMPUTER_TOOLS) {
      expect(names).not.toContain(name);
    }
    expect(names).toContain("shell");
  });

  it("treats unknown models as text-only", () => {
    expect(modelAcceptsImageInput("openrouter", "rakazo-test/unknown-future-model")).toBe(false);
  });

  it("keeps explicit image capability scoped to the selected model", () => {
    const enabled = updateModelImageCapabilities(
      [" vision-model ", "text-model"],
      "text-model",
      false,
    );
    expect(enabled).toEqual(["vision-model"]);
    expect(modelIdSupportsImages(enabled, "vision-model")).toBe(true);
    expect(modelIdSupportsImages(enabled, "text-model")).toBe(false);
  });

  it("omits image-returning computer tools for text-only models", () => {
    const names = filterImageReturningComputerTools(builtinAgentTools, false).map(
      (tool) => tool.name,
    );
    for (const name of IMAGE_RETURNING_COMPUTER_TOOLS) {
      expect(names).not.toContain(name);
    }
    expect(names).toContain("shell");
    expect(names).toContain("list_files");
  });

  it("keeps image-returning computer tools for vision models", () => {
    const names = filterImageReturningComputerTools(builtinAgentTools, true).map(
      (tool) => tool.name,
    );
    expect(names).toEqual(builtinAgentTools.map((tool) => tool.name));
    expect(names).toContain("computer_observe");
    expect(names).toContain("computer_act");
  });
});

describe("known attachment input capability", () => {
  it("keeps catalogue misses distinct from known text-only and image models", () => {
    expect(knownModelImageInput("openrouter", "fixture/future-model")).toBeUndefined();
    expect(knownModelImageInput("openrouter", "deepseek/deepseek-v4-pro")).toBe(false);
    expect(knownModelImageInput("openrouter", "openai/gpt-4o")).toBe(true);
    expect(knownModelImageInput("openai-compatible", "openai/gpt-4o")).toBeUndefined();
  });
});
