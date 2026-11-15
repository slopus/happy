import { describe, expect, it } from "vitest";
import { affordableOpenRouterOutput } from "./openrouter-output-budget.js";

const message = (affordable = 1024) =>
  `This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford ${affordable}.`;
const failure = (inner = false, affordable = 1024) =>
  `402: ${JSON.stringify(
    inner
      ? {
          error: { message: message(affordable) },
          metadata: { limit_source: "openrouter_credits" },
        }
      : { message: message(affordable), metadata: { limit_source: "openrouter_credits" } },
  )}`;

describe("OpenRouter output reservation recovery", () => {
  it.each([false, true])(
    "accepts only a smaller positive provider-reported allowance (%s)",
    (inner) => {
      expect(affordableOpenRouterOutput("openrouter", failure(inner), 4096)).toBe(1024);
    },
  );
  it.each([0, -1, 4096, 8192, Number.MAX_SAFE_INTEGER + 1])(
    "ignores unsafe or non-decreasing allowances (%s)",
    (affordable) => {
      expect(
        affordableOpenRouterOutput("openrouter", failure(false, affordable), 4096),
      ).toBeUndefined();
    },
  );
  it("does not increase an explicit output cap or change other providers", () => {
    expect(affordableOpenRouterOutput("openrouter", failure(), 512)).toBeUndefined();
    expect(affordableOpenRouterOutput("other-provider", failure(), 4096)).toBeUndefined();
  });
  it.each([
    undefined,
    "402: invalid JSON",
    `402: ${JSON.stringify({ message: message(), metadata: { limit_source: "openrouter_key_limit" } })}`,
    `402: ${JSON.stringify({ message: "Insufficient credits.", metadata: { limit_source: "openrouter_credits" } })}`,
    `401: ${JSON.stringify({ message: message(), metadata: { limit_source: "openrouter_credits" } })}`,
    `402: ${JSON.stringify({ message: message() })}`,
  ])("leaves unrelated, empty-balance, and unstructured errors unchanged", (error) => {
    expect(affordableOpenRouterOutput("openrouter", error, 4096)).toBeUndefined();
  });
});
