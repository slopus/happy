import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { declaredVisionModelIds } from "./model-modalities.js";
import type * as ModelVision from "./model-vision.js";
import { LOCAL_VISION_MODELS_ENV, localProvider } from "./pi-local-provider.js";
import {
  OPENAI_COMPATIBLE_CATALOG_MODEL_ID,
  OPENAI_COMPATIBLE_VISION_MODELS_ENV,
  openAiCompatibleCatalogProvider,
  registerOpenAiCompatibleRuntime,
} from "./pi-openai-compatible-provider.js";

const DECLARED = "custom, gpt4o-vision ,another-vision,gpt4o-vision";

/** The vision gate memoizes its catalog on first use, so each env gets its own module instance. */
async function visionGate(declared: string | undefined): Promise<typeof ModelVision> {
  vi.stubEnv(OPENAI_COMPATIBLE_VISION_MODELS_ENV, declared);
  const specifier = `./model-vision.js?${declared ? "declared" : "none"}`;
  const gate: typeof ModelVision = await import(/* @vite-ignore */ specifier);
  gate.modelAcceptsImageInput(OPENAI_COMPATIBLE_PROVIDER_ID, "warm-catalog");
  vi.unstubAllEnvs();
  return gate;
}

let undeclared: typeof ModelVision;
let declared: typeof ModelVision;

beforeAll(async () => {
  undeclared = await visionGate(undefined);
  declared = await visionGate(DECLARED);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("operator-declared vision modalities", () => {
  it("defaults openai-compatible models to text-only", () => {
    expect(undeclared.modelAcceptsImageInput(OPENAI_COMPATIBLE_PROVIDER_ID, "gpt4o-vision")).toBe(
      false,
    );
  });

  it("allows a connected model to declare image input without an environment variable", () => {
    expect(
      undeclared.modelAcceptsImageInput(OPENAI_COMPATIBLE_PROVIDER_ID, "arbitrary-model", true),
    ).toBe(true);
  });

  it("lets the vision gate see declared models and leaves undeclared ones text-only", () => {
    expect(declared.modelAcceptsImageInput(OPENAI_COMPATIBLE_PROVIDER_ID, "gpt4o-vision")).toBe(
      true,
    );
    expect(declared.modelAcceptsImageInput(OPENAI_COMPATIBLE_PROVIDER_ID, "another-vision")).toBe(
      true,
    );
    expect(declared.modelAcceptsImageInput(OPENAI_COMPATIBLE_PROVIDER_ID, "text-only-model")).toBe(
      false,
    );
  });

  it("keeps screenshot-returning computer tools only for a declared model", () => {
    const tools = [{ name: "computer_observe" }, { name: "computer_act" }, { name: "bash" }];
    const names = (gate: typeof ModelVision) =>
      gate
        .filterImageReturningComputerTools(
          tools,
          gate.modelAcceptsImageInput(OPENAI_COMPATIBLE_PROVIDER_ID, "gpt4o-vision"),
        )
        .map((t) => t.name);
    expect(names(declared)).toEqual(["computer_observe", "computer_act", "bash"]);
    expect(names(undeclared)).toEqual(["bash"]);
  });

  it("declares image input on the runtime-registered model", () => {
    vi.stubEnv(OPENAI_COMPATIBLE_VISION_MODELS_ENV, "gpt4o-vision");
    const models = registerOpenAiCompatibleRuntime(builtinModels(), {
      modelId: "gpt4o-vision",
      baseUrl: "http://127.0.0.1:4000/v1",
    });
    expect(models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "gpt4o-vision")?.input).toContain(
      "image",
    );
  });

  it("applies the same declaration to the local provider", () => {
    vi.stubEnv("RAKAZO_LOCAL_MODELS", "qwen3-vl,qwen3-text");
    vi.stubEnv(LOCAL_VISION_MODELS_ENV, "qwen3-vl");
    const models = localProvider()?.getModels() ?? [];
    expect(models.find((m) => m.id === "qwen3-vl")?.input).toContain("image");
    expect(models.find((m) => m.id === "qwen3-text")?.input).not.toContain("image");
  });

  it("dedupes a repeated id in the comma-separated vision env", () => {
    vi.stubEnv(OPENAI_COMPATIBLE_VISION_MODELS_ENV, DECLARED);
    expect([...declaredVisionModelIds(OPENAI_COMPATIBLE_VISION_MODELS_ENV)]).toEqual([
      "custom",
      "gpt4o-vision",
      "another-vision",
    ]);
    const catalogIds = openAiCompatibleCatalogProvider()
      .getModels()
      .map((m) => m.id)
      .filter((id) => id === "gpt4o-vision");
    expect(catalogIds).toEqual(["gpt4o-vision"]);
  });

  it("keeps the custom placeholder text-only when nothing is declared", () => {
    vi.stubEnv(OPENAI_COMPATIBLE_VISION_MODELS_ENV, undefined);
    const custom = openAiCompatibleCatalogProvider()
      .getModels()
      .find((m) => m.id === OPENAI_COMPATIBLE_CATALOG_MODEL_ID);
    expect(custom?.input).not.toContain("image");
    expect(
      undeclared.modelAcceptsImageInput(
        OPENAI_COMPATIBLE_PROVIDER_ID,
        OPENAI_COMPATIBLE_CATALOG_MODEL_ID,
      ),
    ).toBe(false);
  });

  it("upgrades the custom placeholder when it is declared vision-capable", () => {
    vi.stubEnv(OPENAI_COMPATIBLE_VISION_MODELS_ENV, DECLARED);
    const customEntries = openAiCompatibleCatalogProvider()
      .getModels()
      .filter((m) => m.id === OPENAI_COMPATIBLE_CATALOG_MODEL_ID);
    expect(customEntries).toHaveLength(1);
    expect(customEntries[0]?.input).toContain("image");
    expect(
      declared.modelAcceptsImageInput(
        OPENAI_COMPATIBLE_PROVIDER_ID,
        OPENAI_COMPATIBLE_CATALOG_MODEL_ID,
      ),
    ).toBe(true);
  });
});
