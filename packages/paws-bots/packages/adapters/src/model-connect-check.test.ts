import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyModelServesAgents } from "./model-connect-check.js";

const apiKey = "fixture-api-key";

/** An accepted stream that never finishes: the check must stop at the first response. */
function acceptedStream(): typeof fetch {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              id: "fixture",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            })}\n\n`,
          ),
        );
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
          once: true,
        });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
}

function rejection(status: number, body: unknown): typeof fetch {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

function requestBody(fetchImpl: typeof fetch): Record<string, unknown> {
  const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("connect-time model check", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a model as soon as the provider starts answering a request with a tool", async () => {
    const fetchImpl = acceptedStream();
    await expect(
      verifyModelServesAgents(
        { provider: "groq", id: "openai/gpt-oss-120b", apiKey },
        { fetch: fetchImpl },
      ),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(requestBody(fetchImpl)).toMatchObject({
      model: "openai/gpt-oss-120b",
      // Small output ceiling: providers reserve credit against it.
      max_completion_tokens: 1024,
      tools: [expect.objectContaining({ function: expect.objectContaining({ name: "noop" }) })],
    });
  });

  it.each([
    {
      name: "a request budget that cannot fit even the connection probe",
      config: { provider: "groq", id: "openai/gpt-oss-120b" },
      fetch: rejection(413, {
        code: "rate_limit_exceeded",
        type: "tokens",
        message: "Request too large on tokens per minute (TPM): Limit 100, Requested 200.",
      }),
      error: "This connection's request limit is too small.",
    },
    {
      name: "an unsupported model reported as a bad request",
      config: { provider: "groq", id: "openai/gpt-oss-120b" },
      fetch: rejection(400, { code: "400", message: "Unsupported model fixture-model" }),
      error: "can't run this model",
    },
    {
      name: "a free tier that only works inside its own app",
      config: { provider: "opencode", id: "big-pickle" },
      fetch: rejection(403, {
        type: "FreeTierError",
        message: "The free tier can only be used from within the provider's app.",
      }),
      error: "denied access to this model",
    },
    {
      name: "a retired model",
      config: { provider: "groq", id: "llama-3.1-8b-instant" },
      fetch: rejection(404, {
        error: {
          message:
            "The model `llama-3.1-8b-instant` does not exist or you do not have access to it.",
          type: "invalid_request_error",
          code: "model_not_found",
        },
      }),
      error: "can't run this model",
    },
    {
      name: "a model without tool support",
      config: { provider: "openrouter", id: "anthropic/claude-haiku-5.5" },
      fetch: rejection(404, {
        error: { message: "No endpoints found that support tool use.", code: 404 },
      }),
      error: "can't run this model",
    },
    {
      name: "a key without credit",
      config: { provider: "openrouter", id: "anthropic/claude-haiku-5.5" },
      fetch: rejection(402, {
        error: { message: "Insufficient credits. Add more using the billing page.", code: 402 },
      }),
      error: "credit",
    },
    {
      name: "a rejected key",
      config: { provider: "groq", id: "openai/gpt-oss-120b" },
      fetch: rejection(401, {
        error: {
          message: "Invalid API Key",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      }),
      error: "rejected the API key",
    },
  ])("refuses $name with the reason runs would show", async ({ config, fetch, error }) => {
    await expect(verifyModelServesAgents({ ...config, apiKey }, { fetch })).rejects.toThrow(error);
  });

  it.each([
    ["a rate limit", rejection(429, { error: { message: "Rate limit reached.", code: 429 } })],
    ["an outage", rejection(503, { error: { message: "Service unavailable.", code: 503 } })],
    [
      "an unreachable provider",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("fetch failed");
      }),
    ],
  ])("lets %s through to the run", async (_, fetchImpl) => {
    await expect(
      verifyModelServesAgents(
        { provider: "groq", id: "openai/gpt-oss-120b", apiKey },
        { fetch: fetchImpl },
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses a Google model the provider no longer serves to new keys", async () => {
    vi.stubGlobal(
      "fetch",
      rejection(404, {
        error: {
          code: 404,
          message: "This model models/gemini-2.5-flash is no longer available to new users.",
          status: "NOT_FOUND",
        },
      }),
    );
    await expect(
      verifyModelServesAgents({ provider: "google", id: "gemini-2.5-flash", apiKey }),
    ).rejects.toThrow("can't run this model");
  });

  it("skips a model the catalog cannot resolve", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await verifyModelServesAgents(
      { provider: "anthropic", id: "fixture-unknown-model", apiKey },
      { fetch: fetchImpl },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops when the connect request is cancelled", async () => {
    const caller = new AbortController();
    caller.abort(new Error("cancelled"));
    await expect(
      verifyModelServesAgents(
        { provider: "groq", id: "openai/gpt-oss-120b", apiKey },
        { fetch: acceptedStream(), signal: caller.signal },
      ),
    ).rejects.toThrow("cancelled");
  });
});
