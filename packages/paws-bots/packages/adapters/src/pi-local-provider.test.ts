import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_PROVIDER_ID,
  localBaseUrl,
  localProvider,
  registerLocalProvider,
} from "./pi-local-provider.js";

const ENV_KEYS = [
  "RAKAZO_LOCAL_MODELS",
  "RAKAZO_LOCAL_MODELS_URL",
  "RAKAZO_LOCAL_CONTEXT_WINDOW",
  "RAKAZO_LOCAL_MAX_TOKENS",
  "RAKAZO_LOCAL_TOKENS_PER_MINUTE",
  "RAKAZO_LOCAL_REASONING_MODELS",
] as const;

const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setModels(value: string | undefined) {
  if (value === undefined) delete process.env.RAKAZO_LOCAL_MODELS;
  else process.env.RAKAZO_LOCAL_MODELS = value;
}

describe("local model provider", () => {
  it("stays absent when no local models are configured", () => {
    setModels(undefined);
    expect(localProvider()).toBeUndefined();

    // Blank and whitespace-only values are configuration noise, not a model id.
    setModels("");
    expect(localProvider()).toBeUndefined();
    setModels("  ,  ,");
    expect(localProvider()).toBeUndefined();
  });

  it("exposes each configured model id verbatim", () => {
    setModels("qwen3:4b, llama3.1:8b");
    const provider = localProvider();
    expect(provider?.id).toBe(LOCAL_PROVIDER_ID);
    expect(provider?.getModels().map((model) => model.id)).toEqual(["qwen3:4b", "llama3.1:8b"]);
  });

  it("bills nothing, because the model runs on the operator's own hardware", () => {
    setModels("qwen3:4b");
    const model = localProvider()?.getModels()[0];
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("defaults to the Ollama endpoint and honours an override", () => {
    delete process.env.RAKAZO_LOCAL_MODELS_URL;
    expect(localBaseUrl()).toBe("http://127.0.0.1:11434/v1");

    process.env.RAKAZO_LOCAL_MODELS_URL = "http://127.0.0.1:1234/v1";
    setModels("some-local-model");
    expect(localBaseUrl()).toBe("http://127.0.0.1:1234/v1");
    expect(localProvider()?.getModels()[0]?.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("rejects an invalid or non-HTTP endpoint", () => {
    for (const bad of ["not-a-url", "file:///tmp/model.sock", "ftp://127.0.0.1/models"]) {
      process.env.RAKAZO_LOCAL_MODELS_URL = bad;
      expect(() => localBaseUrl(), `endpoint "${bad}"`).toThrow(
        /RAKAZO_LOCAL_MODELS_URL must be an absolute HTTP\(S\) URL/,
      );
    }
  });

  it("defaults token limits when unset, and honours valid overrides", () => {
    setModels("qwen3:4b");
    delete process.env.RAKAZO_LOCAL_CONTEXT_WINDOW;
    delete process.env.RAKAZO_LOCAL_MAX_TOKENS;
    let model = localProvider()?.getModels()[0];
    expect(model?.contextWindow).toBe(32_768);
    expect(model?.maxTokens).toBe(4_096);

    process.env.RAKAZO_LOCAL_CONTEXT_WINDOW = "8192";
    process.env.RAKAZO_LOCAL_MAX_TOKENS = "512";
    model = localProvider()?.getModels()[0];
    expect(model?.contextWindow).toBe(8192);
    expect(model?.maxTokens).toBe(512);
  });

  it("rejects token limits that are not positive integers", () => {
    setModels("qwen3:4b");
    // A typo must not masquerade as the default, and a negative or fractional
    // window must not reach the model definition.
    for (const bad of ["abc", "-5", "0", "3.7", "Infinity", "1e400"]) {
      process.env.RAKAZO_LOCAL_CONTEXT_WINDOW = bad;
      expect(() => localProvider(), `context window "${bad}"`).toThrow(
        /RAKAZO_LOCAL_CONTEXT_WINDOW must be a positive integer/,
      );
    }
    delete process.env.RAKAZO_LOCAL_CONTEXT_WINDOW;

    process.env.RAKAZO_LOCAL_MAX_TOKENS = "-1";
    expect(() => localProvider()).toThrow(/RAKAZO_LOCAL_MAX_TOKENS must be a positive integer/);
    delete process.env.RAKAZO_LOCAL_MAX_TOKENS;

    for (const bad of ["abc", "-5", "0", "3.7"]) {
      process.env.RAKAZO_LOCAL_TOKENS_PER_MINUTE = bad;
      expect(() => localProvider(), `tokens per minute "${bad}"`).toThrow(
        /RAKAZO_LOCAL_TOKENS_PER_MINUTE must be a positive integer/,
      );
    }
  });

  it("marks only the exact model ids the operator declares as reasoning", () => {
    setModels("qwen3:4b, llama3.1:8b, qwen3");
    process.env.RAKAZO_LOCAL_REASONING_MODELS = " qwen3:4b , ,unknown-model";
    const [listed, plain, prefix] = localProvider()?.getModels() ?? [];
    expect(listed).toMatchObject({
      reasoning: true,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: "openai",
      },
      thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
    });
    // Unlisted models keep the exact non-reasoning shape, so no effort field reaches their server.
    for (const model of [plain, prefix]) {
      expect(model?.reasoning).toBe(false);
      expect(model?.compat).toEqual({
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      });
      expect(model?.thinkingLevelMap).toBeUndefined();
    }
  });

  it("registers onto a Models collection only when configured", () => {
    setModels(undefined);
    const bare = registerLocalProvider(builtinModels());
    expect(bare.getProviders().some((p) => p.id === LOCAL_PROVIDER_ID)).toBe(false);

    setModels("qwen3:4b");
    const withLocal = registerLocalProvider(builtinModels());
    expect(withLocal.getModel(LOCAL_PROVIDER_ID, "qwen3:4b")).toBeDefined();
  });
});
