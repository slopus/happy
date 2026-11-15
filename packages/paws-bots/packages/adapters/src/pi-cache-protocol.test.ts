import type { Api, Model, ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { describe, expect, it, vi } from "vitest";
import { requestedPiCacheWriteRetention, resolvePiCacheRetention } from "./pi-cache-retention.js";
import { observedPiStream } from "./pi-usage.js";

const model: Model<Api> = {
  provider: "fixture",
  id: "fixture",
  name: "Fixture",
  api: "openai-responses",
  baseUrl: "https://model.example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 256,
};

async function outgoing(
  api: ProviderStreams,
  configured: Model<Api>,
  retention: "none" | "short" | "long" | undefined,
  guarded = false,
) {
  let payload: Record<string, unknown> = {};
  const streamSimple = guarded
    ? (
        m: Parameters<typeof api.streamSimple>[0],
        ctx: Parameters<typeof api.streamSimple>[1],
        opts: Parameters<typeof api.streamSimple>[2],
      ) =>
        observedPiStream(
          { streamSimple: api.streamSimple } as unknown as Parameters<typeof observedPiStream>[0],
          m,
          ctx,
          opts,
          () => {},
        )
    : api.streamSimple;
  const stream = await streamSimple(
    configured,
    {
      systemPrompt: "Stable guidance",
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    } as unknown as Parameters<typeof streamSimple>[1],
    {
      apiKey: "fake-fixture-key",
      sessionId: "fixture-session",
      cacheRetention: retention,
      fetch: async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        if (configured.api === "anthropic-messages") {
          const events = [
            {
              type: "message_start",
              message: {
                id: "fixture",
                type: "message",
                role: "assistant",
                model: "fixture",
                content: [],
                stop_reason: null,
                usage: {
                  input_tokens: 1,
                  output_tokens: 0,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              },
            },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 0 },
            },
            { type: "message_stop" },
          ];
          return new Response(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
            {
              headers: { "content-type": "text/event-stream" },
            },
          );
        }
        const response =
          configured.api === "openai-completions"
            ? {
                id: "fixture",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "Done" },
                    finish_reason: "stop",
                  },
                ],
              }
            : {
                type: "response.completed",
                response: {
                  id: "fixture",
                  status: "completed",
                  output: [],
                  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                },
              };
        return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    },
  );
  for await (const _event of stream) {
  }
  expect((await stream.result()).stopReason).not.toBe("error");
  return payload;
}

describe("installed Pi cache protocol controls", () => {
  it.each(["none", "long"] as const)(
    "rejects unsupported generic Chat %s before reservation or HTTP",
    async (cacheRetention) => {
      const fetcher = vi.fn();
      const beforeCall = vi.fn(() => "reservation");
      const events = vi.fn();
      const models = {
        streamSimple: openAICompletionsApi().streamSimple,
      } as unknown as Parameters<typeof observedPiStream>[0];
      const stream = await observedPiStream(
        models,
        { ...model, api: "openai-completions" },
        { messages: [] },
        { apiKey: "fake-fixture-key", cacheRetention, fetch: fetcher },
        events,
        { beforeCall, afterCall: vi.fn() },
      );
      for await (const _event of stream) {
      }
      expect((await stream.result()).errorMessage).toContain("Omit retentionMode");
      expect(fetcher).not.toHaveBeenCalled();
      expect(beforeCall).not.toHaveBeenCalled();
      expect(events).not.toHaveBeenCalled();
    },
  );
  it("keeps generic connection defaults authoritative when the SDK environment requests long retention", async () => {
    vi.stubEnv("PI_CACHE_RETENTION", "long");
    try {
      const anthropic = { ...model, api: "anthropic-messages" as const };
      // Installed SDK behavior proves the hidden default would request an unpriced one-hour bucket.
      expect(
        JSON.stringify(await outgoing(anthropicMessagesApi(), anthropic, undefined)),
      ).toContain('"ttl":"1h"');
      const safe = JSON.stringify(
        await outgoing(anthropicMessagesApi(), anthropic, undefined, true),
      );
      expect(safe).toContain('"cache_control":{"type":"ephemeral"}');
      expect(safe).not.toContain('"ttl":"1h"');
      const chat = {
        ...model,
        api: "openai-completions" as const,
        compat: { cacheControlFormat: "anthropic" as const },
      };
      expect(JSON.stringify(await outgoing(openAICompletionsApi(), chat, undefined))).toContain(
        '"ttl":"1h"',
      );
      expect(
        JSON.stringify(await outgoing(openAICompletionsApi(), chat, undefined, true)),
      ).not.toContain('"ttl":"1h"');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("requires a one-hour bucket only for explicit Anthropic marker controls", () => {
    expect(requestedPiCacheWriteRetention({ ...model, api: "anthropic-messages" }, "long")).toBe(
      "1h",
    );
    expect(
      requestedPiCacheWriteRetention(
        {
          ...model,
          api: "openai-completions",
          compat: { cacheControlFormat: "anthropic" },
        },
        "long",
      ),
    ).toBe("1h");
    expect(requestedPiCacheWriteRetention(model, "long")).toBeUndefined();
    expect(
      requestedPiCacheWriteRetention({ ...model, api: "anthropic-messages" }, undefined),
    ).toBeUndefined();
    expect(
      requestedPiCacheWriteRetention({ ...model, api: "anthropic-messages" }, "short"),
    ).toBeUndefined();
  });
  it("accepts audited controls and leaves omitted capabilities on the adapter default", () => {
    expect(resolvePiCacheRetention(model, undefined)).toBe("short");
    expect(resolvePiCacheRetention({ ...model, api: "openai-completions" }, "short")).toBe("short");
    expect(
      resolvePiCacheRetention(
        { ...model, compat: { supportsExplicitPromptCacheMode: true } },
        "none",
      ),
    ).toBe("none");
    expect(
      resolvePiCacheRetention({ ...model, compat: { supportsLongCacheRetention: true } }, "long"),
    ).toBe("long");
    expect(resolvePiCacheRetention({ ...model, api: "anthropic-messages" }, "long")).toBe("long");
    expect(() =>
      resolvePiCacheRetention(
        {
          ...model,
          api: "openai-completions",
          compat: {
            supportsLongCacheRetention: true,
            supportsExplicitPromptCacheMode: true,
          },
        },
        "long",
      ),
    ).toThrow("Unsupported");
    expect(() =>
      resolvePiCacheRetention(
        {
          ...model,
          api: "anthropic-messages",
          compat: { supportsLongCacheRetention: false },
        },
        "long",
      ),
    ).toThrow("Unsupported");
  });
  it("omits Anthropic cache markers for none and requests one hour for long", async () => {
    const anthropic = { ...model, api: "anthropic-messages" as const };
    expect(JSON.stringify(await outgoing(anthropicMessagesApi(), anthropic, "none"))).not.toContain(
      "cache_control",
    );
    expect(JSON.stringify(await outgoing(anthropicMessagesApi(), anthropic, "long"))).toContain(
      '"cache_control":{"type":"ephemeral","ttl":"1h"}',
    );
  });
  it("uses the explicit-mode and 30-minute fields only with the Responses capability", async () => {
    const modern = {
      ...model,
      compat: {
        supportsExplicitPromptCacheMode: true,
        supportsLongCacheRetention: true,
      },
    };
    expect(await outgoing(openAIResponsesApi(), modern, "none")).toMatchObject({
      prompt_cache_options: { mode: "explicit" },
    });
    const long = await outgoing(openAIResponsesApi(), modern, "long");
    expect(long).toMatchObject({ prompt_cache_options: { ttl: "30m" } });
    expect(long).not.toHaveProperty("prompt_cache_retention");
  });
  it("shows that legacy Responses none has no disabling field and long means 24 hours", async () => {
    const legacy = { ...model, compat: { supportsLongCacheRetention: true } };
    const none = await outgoing(openAIResponsesApi(), legacy, "none");
    expect(none).not.toHaveProperty("prompt_cache_options");
    expect(none).not.toHaveProperty("prompt_cache_key");
    expect(await outgoing(openAIResponsesApi(), legacy, "long")).toMatchObject({
      prompt_cache_retention: "24h",
    });
  });
  it("shows that Chat Completions cannot translate the newer explicit-mode capability", async () => {
    const chat = {
      ...model,
      api: "openai-completions" as const,
      compat: {
        supportsExplicitPromptCacheMode: true,
        supportsLongCacheRetention: true,
      },
    };
    const none = await outgoing(openAICompletionsApi(), chat, "none");
    expect(none).not.toHaveProperty("prompt_cache_options");
    const long = await outgoing(openAICompletionsApi(), chat, "long");
    expect(long).toMatchObject({ prompt_cache_retention: "24h" });
    expect(long).not.toHaveProperty("prompt_cache_options");
  });
});
