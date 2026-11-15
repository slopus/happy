import { expect, it } from "vitest";
import { reportedContextWindow } from "./reported-context-window.js";

const llamaCpp = (contextSize = 2048) =>
  `400: ${JSON.stringify({ code: 400, message: `request (19563 tokens) exceeds the available context size (${contextSize} tokens), try increasing it`, type: "exceed_context_size_error", n_prompt_tokens: 19563, n_ctx: contextSize })}`;
const vllm = (limit = 2048) =>
  `400: This model's maximum context length is ${limit} tokens. However, you requested 19563 tokens in the messages.`;

it.each([
  ["llama.cpp", llamaCpp()],
  ["vLLM", vllm()],
  ["an upper-case vLLM", vllm().toUpperCase()],
  [
    "SGLang",
    "400: The input (19563 tokens) is longer than the model's context length (2048 tokens).",
  ],
  [
    "LiteLLM",
    "400: Requested token count exceeds the model's maximum context length of 2048 tokens. You requested a total of 19563 tokens.",
  ],
  [
    "a compatible proxy",
    "400: Input length (19563) exceeds model's maximum context length (2048).",
  ],
  [
    "LM Studio",
    "400: The number of tokens to keep from the initial prompt is greater than the context length. Try to load the model with a larger context length, or provide a shorter input. Model is loaded with context length of only 2048 tokens.",
  ],
])("derives a smaller window from an overflow reported by %s", (_server, error) => {
  expect(reportedContextWindow("openai-compatible", error, 262_144)).toBe(1740);
});

it("ignores other providers and windows that are not smaller", () => {
  expect(reportedContextWindow("openrouter", llamaCpp(), 262_144)).toBeUndefined();
  expect(reportedContextWindow("openai-compatible", llamaCpp(), 1740)).toBeUndefined();
});

it("reads errors up to 16,384 characters", () => {
  const padded = (length: number) => vllm().padEnd(length, " x");
  expect(reportedContextWindow("openai-compatible", padded(16_384), 262_144)).toBe(1740);
  expect(reportedContextWindow("openai-compatible", padded(16_385), 262_144)).toBeUndefined();
});

it.each([
  undefined,
  "400: request exceeds the available context size, try increasing it",
  llamaCpp(0),
  vllm(1),
])("ignores malformed or unusable limits", (value) => {
  expect(reportedContextWindow("openai-compatible", value, 262_144)).toBeUndefined();
});
