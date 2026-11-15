import type { AutoReviewProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { LlmAutoReviewProvider } from "./auto-review.js";
import { createAutoReviewProvider } from "./auto-review-factory.js";
import { JevAutoReviewProvider } from "./jev-auto-review.js";
import { ScriptedAutoReviewProvider } from "./scripted-auto-review.js";

const context = {
  operationId: "auto-review",
  traceId: "auto-review",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const request = {
  toolName: "gmail_send_email",
  connectorKind: "gmail",
  args: { to: "a@b.test" },
  userTask: "Draft a reply",
  botDescription: "Mail bot",
  matchingRules: [],
};

describe("createAutoReviewProvider", () => {
  it("constructs Jev, LLM, and scripted adapters", () => {
    expect(createAutoReviewProvider("jev", { apiKey: "ts-key" })).toBeInstanceOf(
      JevAutoReviewProvider,
    );
    expect(
      createAutoReviewProvider("llm", {
        llm: {
          runtime: {
            describe: () => ({ capabilities: { scripted: false } }),
            run: async function* () {},
            abort: async () => {},
          } as never,
          checker: { provider: "openrouter", model: "x" },
          runId: "run",
          spaceId: "space",
          userId: "user",
          botId: "bot",
          threadId: "thread",
        },
      }),
    ).toBeInstanceOf(LlmAutoReviewProvider);
    expect(createAutoReviewProvider("scripted")).toBeInstanceOf(ScriptedAutoReviewProvider);
    expect(() => createAutoReviewProvider("unknown")).toThrow(/unknown auto-review provider/i);
    expect(() => createAutoReviewProvider("jev", { env: {} })).toThrow(/TYPESAFE_API_KEY/);
    expect(() => createAutoReviewProvider("llm")).toThrow(/runtime checker/i);
  });

  it("resolves the default kind from options.env instead of process.env", () => {
    expect(
      createAutoReviewProvider(undefined, {
        env: { RAKAZO_AUTO_REVIEW_PROVIDER: "scripted", AGENT_RUNTIME: "scripted" },
      }),
    ).toBeInstanceOf(ScriptedAutoReviewProvider);
    expect(
      createAutoReviewProvider(undefined, {
        env: { RAKAZO_AUTO_REVIEW_PROVIDER: "jev", TYPESAFE_API_KEY: "ts-key" },
      }),
    ).toBeInstanceOf(JevAutoReviewProvider);
    expect(
      createAutoReviewProvider("scripted", {
        env: { RAKAZO_AUTO_REVIEW_PROVIDER: "jev", TYPESAFE_API_KEY: "ts-key" },
      }),
    ).toBeInstanceOf(ScriptedAutoReviewProvider);
  });

  it("uses the scripted emulator for deterministic offline answers", async () => {
    const pass = createAutoReviewProvider("scripted") as AutoReviewProvider;
    await expect(pass.review(request, context)).resolves.toEqual({
      decision: "pass",
      model: "scripted",
    });
    const ask = createAutoReviewProvider("scripted", {
      scripted: { decision: "ask", reason: "Flagged", model: "scripted" },
    });
    await expect(ask.review(request, context)).resolves.toEqual({
      decision: "ask",
      reason: "Flagged",
      model: "scripted",
    });
  });
});
