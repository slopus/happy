import { afterEach, describe, expect, it, vi } from "vitest";
import { aiRecipient } from "./ai-consent.js";

afterEach(() => vi.unstubAllGlobals());

describe("mobile AI recipient disclosure", () => {
  it("identifies both gateways without querying or changing their routing", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const provider of ["openrouter", "vercel-ai-gateway"]) {
      const recipient = aiRecipient({ provider, use: "model", modelId: "any/model" });
      expect(recipient?.detail).toBe("any/model, forwarded to its provider");
      expect(aiRecipient({ provider, use: "model" })?.detail).toBe("Forwards to model providers");
      expect(recipient?.privacyUrl).toBeTruthy();
      expect(recipient).not.toHaveProperty("payloadFields");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses only the model ID for direct providers", () => {
    expect(
      aiRecipient({ provider: "openai", use: "model", modelId: "example-model" })?.detail,
    ).toBe("example-model");
    expect(aiRecipient({ provider: "openai", use: "model" })?.detail).toBe("");
  });
  it("supports custom endpoints without exposing secrets or inventing a provider policy", () => {
    const recipient = aiRecipient({
      provider: "openai-compatible",
      use: "model",
      baseUrl: "https://user:password@example.com/private?token=secret",
    })!;
    expect(recipient.name).toContain("https://example.com");
    expect(JSON.stringify(recipient)).not.toMatch(/password|private|token|secret/);
    expect(recipient.privacyUrl).toBeUndefined();
    expect(
      aiRecipient({
        provider: "openai-compatible",
        use: "model",
        baseUrl: "https://example.com/other",
      })?.key,
    ).not.toBe(recipient.key);
  });
  it("supports local models without a hosted dependency", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      aiRecipient({ provider: "local", use: "model", baseUrl: "http://127.0.0.1:11434/v1" })?.name,
    ).toContain("http://127.0.0.1:11434");
    expect(fetch).not.toHaveBeenCalled();
  });
});
