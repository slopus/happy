import { expect, it } from "vitest";
import { groqRequestContextWindow } from "./groq-request-budget.js";

const error = (limit = 6000, requested = 7000) =>
  `413: ${JSON.stringify({ code: "rate_limit_exceeded", type: "tokens", message: `Request too large on tokens per minute (TPM): Limit ${limit}, Requested ${requested}, please reduce your message size.` })}`;
it("derives a smaller request window only from the token-rate rejection", () => {
  expect(groqRequestContextWindow("groq", error(), 32000)).toBe(5100);
  expect(groqRequestContextWindow("other", error(), 32000)).toBeUndefined();
  expect(groqRequestContextWindow("groq", error(), 4000)).toBeUndefined();
});
it.each([
  undefined,
  "413: invalid JSON",
  error(0),
  error(6000, 5000),
  error(Number.MAX_SAFE_INTEGER + 1),
  '413: {"code":"other","type":"tokens","message":"on tokens per minute (TPM): Limit 6000, Requested 7000,"}',
])("ignores malformed or unrelated limits", (value) => {
  expect(groqRequestContextWindow("groq", value, 32000)).toBeUndefined();
});
