import { ModelAccountError, ModelOutputError, TransientModelError } from "@rakazo/adapter-kit";
import {
  MODEL_CONTEXT_TOO_SMALL_ERROR,
  MODEL_CREDITS_EXHAUSTED_ERROR,
  MODEL_OUTPUT_LIMIT_ERROR,
  MODEL_UNPRICED_FOR_CREDITS_ERROR,
  modelFallbackFailure,
} from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ errorMessage: "", rejectRequest: false }));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { errorMessage: provider.errorMessage, messages: [] };
    constructor(
      private readonly options: {
        streamFn: (model: unknown, context: unknown, options: unknown) => AsyncIterable<unknown>;
      },
    ) {}

    subscribe() {}
    async prompt() {
      if (!provider.rejectRequest) return;
      const stream = this.options.streamFn(
        undefined,
        { systemPrompt: "SYSTEM-PROMPT-secret", messages: [] },
        {},
      );
      for await (const _event of stream) {
        // Drain the request so its response hooks run.
      }
    }
    async waitForIdle() {}
    abort() {}
  },
}));

vi.mock("@earendil-works/pi-ai/providers/all", async () => {
  const { AssistantMessageEventStream } = await import("@earendil-works/pi-ai/utils/event-stream");
  return {
    builtinModels: () => ({
      getModel: () => ({
        provider: "openai-codex",
        id: "gpt-test",
        api: "openai-codex-responses",
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 32_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      streamSimple: (
        model: { provider: string; id: string },
        _context: unknown,
        options: {
          onPayload?: (body: unknown, model: unknown) => unknown;
          onResponse?: (response: unknown, model: unknown) => unknown;
        },
      ) => {
        const stream = new AssistantMessageEventStream();
        void (async () => {
          await options.onPayload?.(
            {
              model: model.id,
              instructions: "SYSTEM-PROMPT-secret",
              input: [{ role: "user", content: [{ type: "input_text", text: "PROMPT-secret" }] }],
              reasoning: { effort: "high" },
            },
            model,
          );
          await options.onResponse?.({ status: 400, headers: {} }, model);
          const error = {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: '{"detail":"Bad Request"}',
            api: "openai-codex-responses",
            provider: model.provider,
            model: model.id,
            usage: {},
            timestamp: 0,
          };
          stream.push({ type: "error", reason: "error", error } as never);
          stream.end(error as never);
        })();
        return stream;
      },
    }),
  };
});

vi.mock("./pi-local-provider.js", () => ({
  registerLocalProvider: (models: unknown) => models,
}));

vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";
import { rejectedRequestsOf } from "./provider-request-shape.js";

function consume(model = { provider: "openai-codex", id: "gpt-test" }) {
  const runtime = new PiAgentRuntime();
  return (async () => {
    for await (const _event of runtime.run(
      {
        botId: "bot",
        threadId: "thread",
        runId: "run",
        prompt: "continue",
        instructions: "test",
        history: [],
        tools: [],
        model,
      },
      {
        operationId: "operation",
        traceId: "trace",
        spaceId: "workspace",
        userId: "user",
        signal: new AbortController().signal,
      },
    )) {
      // Consume the stream so terminal failures surface to the executor.
    }
  })();
}

describe("Pi runtime errors", () => {
  beforeEach(() => {
    provider.errorMessage = "Request was aborted by policy";
    provider.rejectRequest = false;
  });

  it("attaches the shape of a request a provider rejected for no known reason", async () => {
    provider.errorMessage = '{"detail":"Bad Request"}';
    provider.rejectRequest = true;
    const error = await consume().catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(ModelAccountError);
    const rejection = rejectedRequestsOf(error);
    expect(rejection).toHaveLength(1);
    expect(rejection?.[0]).toMatchObject({
      provider: "openai-codex",
      model: "gpt-test",
      status: 400,
      body: {
        params: { model: "gpt-test", "reasoning.effort": "high" },
        messages: { count: 1, items: ["user:input_text"] },
      },
    });
    expect(JSON.stringify(rejection)).not.toMatch(/secret/);
  });

  it("propagates provider failures instead of completing with error text", async () => {
    const failure = consume();
    await expect(failure).rejects.toThrow("Request was aborted by policy");
    await expect(failure).rejects.not.toBeInstanceOf(TransientModelError);
  });

  it("marks a provider overload that outlasted its retries as transient", async () => {
    provider.errorMessage =
      "Codex error: Our servers are currently overloaded. Please try again later.";
    const failure = consume();
    await expect(failure).rejects.toBeInstanceOf(TransientModelError);
    await expect(failure).rejects.toThrow("overloaded");
  });

  it.each([
    '401: {"message":"Invalid API-key provided.","type":"invalid_request_error"}',
    '402: {"message":"This request requires more credits.","code":402}',
    "You have no credits remaining. Add credits to continue using the API.",
    'xai API error (400): 400 "Incorrect API key provided."',
    "Your authentication token has expired. Please try refreshing it.",
    "Provided authentication token is expired.",
    "Encountered invalidated oauth token for user, failing request",
    'Headers.append: "example key\nclient = Client(timeout=30, rate_limit=1)" is an invalid header value.',
    "Cannot convert argument to a ByteString because the character at index 0 has a value of 48120 which is greater than 255.",
    '403: {"type":"FreeTierError","message":"This free tier can only be used from within its own app."}',
    'opencode API error (410): {"type":"ModelDeprecated","message":"Model example-free has been deprecated."}',
    '404: {"message":"No endpoints found that support tool use.","code":404}',
    '400: {"message":"`tool calling` is not supported with this model","type":"invalid_request_error"}',
    `400: {"message":"feature 'tool calls' is not currently supported"}`,
    '400: {"message":"Too many images provided.  This model supports up to 3 images","type":"invalid_request_error"}',
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use."}}',
    '413: {"message":"Request too large for model `example/model` on tokens per minute (TPM)."}',
    MODEL_CONTEXT_TOO_SMALL_ERROR,
    '400: {"code":"400","message":"Unsupported model example-model"}',
    '400: {"message":"The model `example/model` requires terms acceptance.","type":"invalid_request_error","code":"model_terms_required"}',
    '400: {"message":"Model example is not a chat model; call /v1/example instead of /v1/chat/completions","type":"invalid_request_error","param":null,"code":null}',
    'openai-compatible API error (400): {"message":"example:27b is a decision model and only supports /v1/example (ref: <ref-id>)","type":"invalid_request_error","param":null,"code":null}',
    "Prompt tokens limit exceeded: 11298 > 992. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account",
    MODEL_CREDITS_EXHAUSTED_ERROR,
    MODEL_UNPRICED_FOR_CREDITS_ERROR,
    `400: {"type":"server_error","message":"Upstream request failed: This example model requires Global regions. Select Global in your workspace's Privacy settings to use it."}`,
    "400 checking third-party user token: Personal Access Tokens are not supported for this endpoint",
    `400 {"status":400,"title":"Bad Request","detail":"Function id 'example-function': DEGRADED function cannot be invoked"}`,
    'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://example.invalid/v1/oauth/token; details=Error: HTTP request failed. status=400; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
    '400 {"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"error\\":{\\"message\\":\\"example upstream failure\\"}}","provider_name":"ExampleUpstream","is_byok":false}}',
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Invalid effort level: max"},"request_id":"req_example"}',
    '400: {"type":"invalid_request_error","message":"This example model is hosted outside Europe and the United States. Select Global in your workspace\'s privacy settings to use it."}',
  ])("marks a provider account failure the user can fix: %s", async (message) => {
    provider.errorMessage = message;
    const failure = consume();
    await expect(failure).rejects.toBeInstanceOf(ModelAccountError);
    await expect(failure).rejects.toThrow(message);
  });

  it.each([
    "Provider finish_reason: error",
    "Provider stopped with: MALFORMED_FUNCTION_CALL",
    "Unhandled stop reason: MALFORMED_RESPONSE",
    "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.",
    "Provider returned an empty response",
    "Cyber safeguards flagged this message. If this is legitimate security work, you can apply for the Cyber Verification Program: https://support.claude.com/en/articles/<article-id>",
    "This request triggered cyber-related safeguards. To learn about the Cyber Verification Program, see https://support.claude.com/en/articles/<article-id>",
    "SAFETY",
    '400: {"code":"data_inspection_failed","param":null,"message":"Input text data may contain inappropriate content.","type":"data_inspection_failed"}',
    'unexpected tokens remaining in message header: Some("to=functions.example")',
    'HarmonyError: unexpected tokens remaining in message header: Some("analysis")',
    '500: {"message":"unexpected tokens remaining in message header: Some(\\"analysis\\")"}',
    'unexpected tokens remaining in message header: Some("credit limit, timeout, model not found")',
    "Failed to parse tool call arguments as JSON",
    "Tool call validation failed: attempted to call tool 'commentary' which was not in request.tools",
    "Parsing failed. The model generated output that could not be parsed. Please adjust your prompt. See 'failed_generation' for more details.",
    '400 {"type":"error","error":{"type":"api_error","message":"Upstream request failed: [api_error] Upstream response was not valid JSON"}}',
    MODEL_OUTPUT_LIMIT_ERROR,
    "Upstream error from Example: HttpError: HTTP 400: Tool calls cutoff by max_tokens.",
  ])("marks unusable model output as the model's failure: %s", async (message) => {
    provider.errorMessage = message;
    const failure = consume();
    await expect(failure).rejects.toBeInstanceOf(ModelOutputError);
    await expect(failure).rejects.toThrow(message);
  });

  it.each([
    '400: {"message":"Unexpected message role.","type":"invalid_request_error"}',
    '{"error":{"message":"Function call is missing a thought_signature in functionCall parts.","code":400}}',
    '400: {"message":"Provider returned error","code":400,"metadata":{"raw":"The `uniqueItems` JSON Schema keyword is not supported."}}',
    '400: {"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"code\\":400,\\"msg\\":\\"bad request\\"}"}}',
    "Cannot read properties of undefined (reading 'content')",
    "Internal failure while handling unexpected tokens remaining in message header: unknown",
  ])("keeps a request we built or an unknown failure ordinary: %s", async (message) => {
    provider.errorMessage = message;
    const failure = consume();
    await expect(failure).rejects.not.toBeInstanceOf(ModelAccountError);
    await expect(failure).rejects.not.toBeInstanceOf(ModelOutputError);
    await expect(failure).rejects.not.toBeInstanceOf(TransientModelError);
  });

  it.each([
    ["openai-compatible", "example-model"],
    ["local", "example-local"],
  ])(
    "marks a request the user's own %s endpoint rejects as theirs to fix",
    async (endpoint, id) => {
      provider.errorMessage = '400 "Invalid request parameters"';
      const failure = consume({ provider: endpoint, id });
      await expect(failure).rejects.toBeInstanceOf(ModelAccountError);
      await expect(failure).rejects.toThrow("Invalid request parameters");
    },
  );

  it("keeps a named provider's bare 400 a server error, since Rakazo may have built it wrong", async () => {
    provider.errorMessage = '400 "Invalid request parameters"';
    const failure = consume();
    await expect(failure).rejects.not.toBeInstanceOf(ModelAccountError);
    await expect(failure).rejects.not.toBeInstanceOf(ModelOutputError);
    await expect(failure).rejects.not.toBeInstanceOf(TransientModelError);
  });

  it.each([
    "WebSocket closed 1006",
    // The Google SDK reports a stream that closed partway through an event this way.
    "Incomplete JSON segment at the end",
    "OpenCode rejected this chat session. Send the message again.",
    "The upstream model provider could not complete this request. Please retry shortly.",
    "JSON error injected into SSE stream",
    "Anthropic stream ended before message_stop",
    "Example stream ended without a finish reason",
    "server_error: The model failed to generate a response.",
    '400 data: {"error":{"code":"invalid_parameter_error","param":null,"message":"Download multimodal file timed out","type":"invalid_request_error"},"id":"chatcmpl-example"}\n\n',
  ])("keeps a dropped connection transient: %s", async (message) => {
    provider.errorMessage = message;
    await expect(consume()).rejects.toBeInstanceOf(TransientModelError);
  });

  it.each([
    "ResourceExhausted: Worker local total request limit reached (16/16)",
    "ResourceExhausted: Worker local total request limit reached (4358/16)",
  ])("treats a provider concurrency limit as transient: %s", async (message) => {
    provider.errorMessage = message;
    await expect(consume()).rejects.toBeInstanceOf(TransientModelError);
  });
});

describe("Pi runtime errors after every backup failed", () => {
  const timedOut = "Request timed out.";
  const freeTier =
    '403: {"type":"FreeTierError","message":"This free tier can only be used from within its own app."}';
  const unknown = "Cannot read properties of undefined (reading 'content')";
  const emptyReply = "Provider returned an empty response";
  const dailyQuota = `429 ${JSON.stringify({
    error: {
      message: "Rate limit exceeded: free-models-per-day",
      code: 429,
      metadata: { headers: { "X-RateLimit-Reset": String(Date.now() + 10 * 60 * 60_000) } },
    },
  })}`;
  const rateLimited =
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}';

  function exhausted(primaryError: string, reasons: string[], skipped: string[] = []) {
    return modelFallbackFailure(primaryError, [
      ...reasons.map((reason, index) => ({
        provider: "fake-provider",
        modelId: `fake-model-${index}`,
        status: "failed" as const,
        reason,
      })),
      ...skipped.map((reason, index) => ({
        provider: "fake-provider",
        modelId: `fake-skipped-${index}`,
        status: "skipped" as const,
        reason,
      })),
    ]);
  }

  it.each([
    ["every model timed out", exhausted(timedOut, [timedOut, timedOut]), TransientModelError],
    [
      "skipped backups do not count",
      exhausted(timedOut, [timedOut], [unknown]),
      TransientModelError,
    ],
    ["every model refused the account", exhausted(freeTier, [freeTier]), ModelAccountError],
    [
      "an account failure outranks timeouts",
      exhausted(timedOut, [timedOut, freeTier]),
      ModelAccountError,
    ],
    [
      "a quota that resets hours away outranks a rate-limited backup",
      exhausted(dailyQuota, [rateLimited]),
      ModelAccountError,
    ],
    ["bad output outranks timeouts", exhausted(timedOut, [emptyReply]), ModelOutputError],
    [
      "a provider out of credits backed by a key the provider rejects",
      exhausted('402: {"message":"Add usage credits to use cloud models."}', [
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use."}}',
      ]),
      ModelAccountError,
    ],
    [
      "an account failure outranks bad output",
      exhausted(emptyReply, [freeTier]),
      ModelAccountError,
    ],
  ])("classifies the chain when %s", async (_label, message, kind) => {
    provider.errorMessage = message;
    const failure = consume();
    await expect(failure).rejects.toBeInstanceOf(kind);
    await expect(failure).rejects.toThrow(message);
  });

  it("credits a backup's bare 400 to its own endpoint, not to the primary's provider", async () => {
    const rejected = '400 "Invalid request parameters"';
    const chain = (backupProvider: string) =>
      modelFallbackFailure(timedOut, [
        { provider: backupProvider, modelId: "example", status: "failed", reason: rejected },
      ]);
    provider.errorMessage = chain("openai-compatible");
    await expect(consume()).rejects.toBeInstanceOf(ModelAccountError);
    provider.errorMessage = chain("fake-provider");
    await expect(consume()).rejects.not.toBeInstanceOf(ModelAccountError);
  });

  it("keeps the chain a server error when any failure is unexplained", async () => {
    provider.errorMessage = exhausted(timedOut, [freeTier, unknown]);
    const failure = consume();
    await expect(failure).rejects.not.toBeInstanceOf(TransientModelError);
    await expect(failure).rejects.not.toBeInstanceOf(ModelAccountError);
    await expect(failure).rejects.not.toBeInstanceOf(ModelOutputError);
  });
});
