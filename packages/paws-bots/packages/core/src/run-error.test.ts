import {
  COMPUTER_ALLOWANCE_USED_ERROR,
  COMPUTER_PROVIDER_UNAVAILABLE_ERROR,
  COMPUTER_RATE_LIMIT_ERROR,
  COMPUTER_UNRESPONSIVE_ERROR,
} from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVED_ACTION_NOT_RUN_ERROR,
  HOSTED_MODEL_CREDITS_REQUIRED_ERROR,
  isImageInputConfirmation,
  isModelRequiredSendError,
  MISSING_MODEL_RUN_ERROR,
  MISSING_TOOL_FINAL_RESPONSE_ERROR,
  MODEL_CONTEXT_TOO_SMALL_ERROR,
  MODEL_CREDIT_CAP_REACHED_ERROR,
  MODEL_CREDITS_EXHAUSTED_ERROR,
  MODEL_IMAGE_INPUT_ERROR,
  MODEL_OUTPUT_CUT_ERROR,
  MODEL_OUTPUT_LIMIT_ERROR,
  MODEL_REQUEST_LIMIT_ERROR,
  MODEL_REQUIRED_SEND_ERROR,
  MODEL_UNPRICED_FOR_CREDITS_ERROR,
  modelFallbackFailure,
  normalizeRunError,
  userRunError,
  VERBATIM_TOOL_RESULT_TOO_LARGE_ERROR,
} from "./run-error.js";

/** The classification alone, without the provider's own status and message. */
function classify(details: string) {
  const {
    status: _status,
    providerMessage: _message,
    ...classification
  } = normalizeRunError(details);
  return classification;
}

it("returns the provider's status and the message unwrapped from its envelope", () => {
  expect(normalizeRunError('403: {"error":{"message":"Weekly key limit exceeded"}}')).toMatchObject(
    { status: 403, providerMessage: "Weekly key limit exceeded" },
  );
  const plain = normalizeRunError("Request timed out.");
  expect(plain.status).toBeUndefined();
  expect(plain.providerMessage).toBe("Request timed out.");
});

it("keeps the provider's status and message on unusable-output errors", () => {
  expect(
    normalizeRunError('403: {"error":{"message":"Provider returned an empty response"}}'),
  ).toMatchObject({
    kind: "output",
    status: 403,
    providerMessage: "Provider returned an empty response",
  });
});

it("reads a limit period and reset date from top-level envelope fields", () => {
  const error = normalizeRunError(
    '402: {"error":{"message":"Usage limit exceeded","limit":"weekly","reset_at":"2099-01-01"}}',
  );
  expect(error).toMatchObject({ period: "weekly", resetAt: Date.parse("2099-01-01") });
});

describe("normalizeRunError", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-01T00:00:00Z"));
  });
  it("summarizes the weekly OpenRouter key limit without exposing diagnostics", () => {
    const details =
      '403: {"message":"Key limit exceeded (weekly limit). Manage it using https://openrouter.ai/workspaces/default/keys/<long hash> $20.05 of $20.00 used; resets 2026-10-12T00:00:00.000Z.","code":403,"metadata":{"limit_source":"openrouter_key_limit"}}';
    expect(normalizeRunError(details)).toMatchObject({
      summary: "Your OpenRouter key hit its weekly limit. Resets Oct 12.",
      details,
    });
  });

  it.each([
    [
      '{"error":{"message":"Insufficient credits","code":402,"metadata":{"provider_name":"OpenAI"}}}',
      "Your OpenAI reached its credit limit.",
    ],
    [
      '403: {"message":"Monthly spending limit exceeded","metadata":{"reset_at":"2026-11-01T00:00:00Z"}}',
      "Your model provider reached its monthly spending limit. Resets Nov 1.",
    ],
    [
      '429: {"message":"Too many requests"}',
      "Your model provider is rate limiting requests. Try again shortly.",
    ],
    [
      '{"error":{"type":"rate_limit_error","message":"Slow down","metadata":{"provider":"Anthropic"}}}',
      "Your Anthropic is rate limiting requests. Try again shortly.",
    ],
    [
      '401: {"message":"Incorrect API key: sk-fake-placeholder; https://api.openai.com"}',
      "Your OpenAI rejected the API key. Check your connection settings.",
    ],
    [
      '403: {"message":"Unauthorized API key"}',
      "Your model provider rejected the API key. Check your connection settings.",
    ],
    [
      '{"error":{"type":"authentication_error","message":"Invalid key"}}',
      "Your model provider rejected the API key. Check your connection settings.",
    ],
    [
      "400 checking third-party user token: Personal Access Tokens are not supported for this endpoint",
      "Your model provider rejected the API key. Check your connection settings.",
    ],
    [
      '404: {"error":{"message":"Model fake-model does not exist"}}',
      "Your model provider can't run this model.",
    ],
    ['{"error":{"code":"model_not_found"}}', "Your model provider can't run this model."],
    [
      '400 {"status":400,"title":"Bad Request","detail":"Function id \'example-function\': DEGRADED function cannot be invoked"}',
      "Your model provider can't run this model.",
    ],
    [
      '400: {"message":"Model example is not a chat model; call /v1/example instead of /v1/chat/completions","type":"invalid_request_error"}',
      "Your model provider can't run this model.",
    ],
    [
      'openai-compatible API error (400): {"message":"example:27b is a decision model and only supports /v1/example (ref: <ref-id>)","type":"invalid_request_error","param":null,"code":null}',
      "Your model provider can't run this model.",
    ],
    [
      "Prompt tokens limit exceeded: 11298 > 992. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account",
      "Your OpenRouter reached its credit limit.",
    ],
    [
      '400: {"type":"server_error","message":"Upstream request failed: This example model requires Global regions. Select Global in your workspace\'s Privacy settings to use it."}',
      "Your model provider can't run this model.",
    ],
    [
      '400: {"type":"invalid_request_error","message":"This example model is hosted outside Europe and the United States. Select Global in your workspace\'s privacy settings to use it."}',
      "Your model provider can't run this model.",
    ],
    ["SAFETY margin exceeded", "The model provider returned an error."],
    ["Request timed out", "Your model provider took too long to respond. Try again."],
    [
      '504: {"message":"Gateway error"}',
      "Your model provider took too long to respond. Try again.",
    ],
    [
      '403: {"message":"This model requires you to upgrade to a paid plan"}',
      "Your model provider denied access to this model.",
    ],
    [
      '403: {"message":"Policy blocked the request"}',
      "Your model provider denied access to this model.",
    ],
    ['404: {"message":"Route not found"}', "Your model provider can't run this model."],
    [
      "500: {malformed https://example.test/keys/fake-key-id",
      "The model provider returned an error.",
    ],
    ["Something unexpected happened", "The model provider returned an error."],
    [
      "Provider diagnostic: manage https://example.test/keys/fake-key-id; trace fake-trace",
      "The model provider returned an error.",
    ],
    [
      "OpenRouter key limit exceeded (weekly). Manage https://example.test/keys/fake-key-id",
      "Your OpenRouter key hit its weekly limit.",
    ],
    ["", "The model provider returned an error."],
    ["Internal server error", "Something went wrong. Try again."],
  ])("normalizes %s", (details, summary) => {
    expect(normalizeRunError(details)).toMatchObject({ summary, details });
  });

  it.each([
    '429: {"message":"API key rate limit exceeded"}',
    '403: {"message":"API key rate limit exceeded"}',
    '429: {"error":{"type":"rate_limit_error","message":"API key rate limit exceeded"}}',
  ])("recognizes per-key rate limits: %s", (details) => {
    expect(normalizeRunError(details).summary).toBe(
      "Your model provider is rate limiting requests. Try again shortly.",
    );
  });

  it.each([
    "The tools finished, but the model did not write a final answer. Rephrase the request and try again.",
    "Stopped. This stayed queued without starting.",
  ])("preserves app-authored recovery advice: %s", (details) => {
    expect(normalizeRunError(details)).toMatchObject({ summary: details, details });
  });

  it("keeps quota exhaustion distinct from 429 rate limits", () => {
    expect(
      normalizeRunError(
        '429: {"error":{"type":"rate_limit_error","code":"insufficient_quota","message":"Insufficient quota"}}',
      ).summary,
    ).toBe("Your model provider reached its credit limit.");
  });

  it("translates templates and formats reset dates in the selected locale", () => {
    const translate = (message: string, values?: Record<string, string | number>) => {
      const template =
        (
          {
            "Your model provider": "Dein Modellanbieter",
            "{provider} key hit its weekly limit.":
              "{provider}: wöchentliches Schlüssellimit erreicht.",
            "{summary} Resets {date}.": "{summary} Zurückgesetzt am {date}.",
          } as Record<string, string>
        )[message] ?? message;
      return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key]));
    };
    const resetDate = new Intl.DateTimeFormat("de", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date("2026-10-12T00:00:00Z"));
    expect(
      normalizeRunError(
        '403: {"message":"Key limit exceeded (weekly); resets 2026-10-12"}',
        translate,
        "de",
      ).summary,
    ).toBe(
      `Dein Modellanbieter: wöchentliches Schlüssellimit erreicht. Zurückgesetzt am ${resetDate}.`,
    );
  });

  it("ignores malformed reset dates", () => {
    expect(
      normalizeRunError('403: {"message":"Key limit exceeded; resets not-a-date"}').summary,
    ).toBe("Your model provider key hit its limit.");
  });

  describe("overloaded, too-long and dropped-connection failures", () => {
    const overloaded = "Your model provider is overloaded right now. Try again in a moment.";
    const tooLong =
      "This conversation is too long for the model. Retrying won't help. Start a new chat or shorten your message.";
    const tookTooLong = "Your model provider took too long to respond. Try again.";

    it.each([
      [
        '529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        overloaded,
      ],
      [
        '{"error":{"type":"overloaded_error","message":"Overloaded","metadata":{"provider":"Anthropic"}}}',
        "Your Anthropic is overloaded right now. Try again in a moment.",
      ],
      ['503: {"message":"Service Unavailable"}', overloaded],
      ["502 Bad Gateway", overloaded],
      ["503 provider unavailable", overloaded],
      [
        '502: {"message":"Gateway error","metadata":{"provider":"OpenAI"}}',
        "Your OpenAI is overloaded right now. Try again in a moment.",
      ],
      ["Codex error: Our servers are currently overloaded. Please try again later.", overloaded],
      [
        '400: {"error":{"message":"This model\'s maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.","code":"context_length_exceeded"}}',
        tooLong,
      ],
      ["prompt is too long: 210344 tokens > 200000 maximum", tooLong],
      [
        '400: {"code":400,"message":"request (19563 tokens) exceeds the available context size (2048 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":19563,"n_ctx":2048}',
        tooLong,
      ],
      ['413: {"message":"Request entity too large"}', tooLong],
      ["Required context exceeds the model context budget", tooLong],
      [
        '400: {"message":"Too many images provided.  This model supports up to 3 images","type":"invalid_request_error"}',
        tooLong,
      ],
      ["terminated", tookTooLong],
      ["read ECONNRESET", tookTooLong],
      ["socket hang up", tookTooLong],
      ["fetch failed", tookTooLong],
      ["Model stream ended without a terminal event", tookTooLong],
      ["Request timed out.", tookTooLong],
    ])("summarizes %s without recovery advice", (details, summary) => {
      expect(classify(details)).toEqual({
        summary,
        details,
        ...(summary === tooLong ? { kind: "context" } : {}),
      });
    });

    it.each([
      // What the OpenAI and Anthropic SDKs report when a local server is down or the host is unknown.
      "Connection error.",
      "fetch failed: connect ECONNREFUSED 127.0.0.1:11434",
      "connect ECONNREFUSED ::1:8000",
      "getaddrinfo ENOTFOUND ollama.local",
      "connect EHOSTUNREACH 192.168.1.20:11434",
      "connect ENETUNREACH 10.0.0.5:8000",
      "getaddrinfo EAI_AGAIN vllm",
      "Connection refused",
    ])("says an unreachable provider %s should be checked", (details) => {
      expect(classify(details)).toEqual({
        summary: "Your model provider couldn't be reached. Check that it's running.",
        details,
      });
    });

    it.each([
      [
        '429: {"message":"Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 50000."}',
        {
          summary: "Your model provider is rate limiting requests. Try again shortly.",
          kind: "rate",
        },
      ],
      ['504: {"message":"Gateway error"}', { summary: tookTooLong }],
      [
        "Rate limit reached for example-model in organization org-example on tokens per min (TPM): Limit 60000, Used 51552, Requested 12568. Please try again in 4.12s. You can increase your rate limit by adding a payment method to your account at https://platform.openai.com/account/billing.",
        {
          summary: "Your OpenAI is rate limiting requests. Try again shortly.",
          kind: "rate",
        },
      ],
    ])("keeps upstream's earlier branch for %s", (details, expected) => {
      expect(normalizeRunError(details)).toMatchObject({ ...expected, details });
    });
  });

  describe("who owns the failure", () => {
    // Gateways in front of Google pass Google's error envelope through as a JSON string.
    const google = (error: Record<string, unknown>) =>
      JSON.stringify({ error: { message: JSON.stringify({ error }, null, 2), code: error.code } });

    it.each([
      [
        'opencode API error (402): {"type":"server_error","message":"Upstream request failed: Insufficient account funds"}',
        "spending",
      ],
      ['xai API error (402): 402 "You have run out of credits or need a subscription."', "credit"],
      [
        '402: {"message":"Insufficient Balance (request_id: fake-request)","type":"unknown_error","param":null,"code":"invalid_request_error"}',
        "spending",
      ],
      [
        '402 {"type":"error","error":{"type":"billing_error","message":"This request requires more credits, or fewer max_tokens."}}',
        "credit",
      ],
      [
        "This request requires more credits, or fewer max_tokens. You requested up to 32768 tokens, but can only afford 1000.",
        "credit",
      ],
      ["You have no credits remaining. Add credits to continue using the API.", "credit"],
      [
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the API."}}',
        "credit",
      ],
      [
        '429: {"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}',
        "spending",
      ],
      [
        google({
          code: 429,
          message: "You exceeded your current quota, please check your plan and billing details.",
          status: "RESOURCE_EXHAUSTED",
        }),
        "spending",
      ],
    ])("offers another model when the account is out of money or quota: %s", (details, kind) => {
      expect(normalizeRunError(details)).toMatchObject({ kind, recovery: "model" });
    });

    it.each([
      '401: {"message":"Missing Authentication header","code":401}',
      '401 {"status":401,"title":"Unauthorized","detail":"Invalid unsecured/JWS/JWE header: Invalid JSON object"}',
      'xai API error (400): 400 "Incorrect API key provided. You can obtain an API key from the console."',
      "Your authentication token has expired. Please try refreshing it.",
      "Provided authentication token is expired.",
      "Encountered invalidated oauth token for user, failing request",
      // A key pasted with code around it; the code's words are not provider signals.
      'Headers.append: "Bearer example-key\nclient = Client(timeout=30, credits=5, rate_limit=1)" is an invalid header value.',
      'Headers.append: "[Redacted]" is an invalid header value.',
      "Cannot convert argument to a ByteString because the character at index 0 has a value of 48120 which is greater than 255.",
      google({
        code: 400,
        message: "API key not valid. Please pass a valid API key.",
        status: "INVALID_ARGUMENT",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" },
        ],
      }),
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace."}}',
    ])("sends a rejected key to the connection: %s", (details) => {
      expect(normalizeRunError(details)).toMatchObject({
        summary: "Your model provider rejected the API key. Check your connection settings.",
        kind: "auth",
        recovery: "connection",
      });
    });

    it.each([
      `403: {"type":"FreeTierError","message":"This free tier can only be used from within its own app."}`,
      '403 {"type":"error","error":{"type":"api_error","message":"Upstream request failed: Model access is disabled"}}',
      '403 {"error":{"message":"The gateway requires a valid credit card on file to service requests."}}',
      "AccessDeniedException: example.model-v1 is not available for this account.",
      google({
        code: 403,
        message: "Permission denied: this project cannot use the requested model.",
        status: "PERMISSION_DENIED",
      }),
      '400: {"message":"The model `example/model` requires terms acceptance.","type":"invalid_request_error","code":"model_terms_required"}',
    ])("explains a provider refusing the model to the account: %s", (details) => {
      expect(normalizeRunError(details)).toMatchObject({
        summary: "Your model provider denied access to this model.",
        kind: "access",
        recovery: "model",
      });
    });

    it.each([
      'opencode API error (410): {"type":"ModelDeprecated","message":"Model example-free has been deprecated."}',
      '404: {"message":"No endpoints found that support tool use.","code":404}',
      '404 {"type":"error","error":{"type":"not_found_error","message":"0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy."}}',
      '404: {"message":"example/model:batch cannot be used with the chat/completions endpoint.","code":404}',
      '400: {"message":"The requested model is not supported.","code":"model_not_supported","param":"model","type":"invalid_request_error"}',
      '400: {"message":"`tool calling` is not supported with this model","type":"invalid_request_error","param":"tool calling"}',
      `400: {"message":"feature 'tool calls' is not currently supported"}`,
      `{"detail":"The 'example-model' model is not supported when using Codex with a ChatGPT account."}`,
      "Validation error: Invocation of model ID example.model-v1 with on-demand throughput isn’t supported. Retry your request with the ID or ARN of an inference profile that contains this model.",
      "Validation error: This model doesn't support the image field for user messages.",
      '400: {"code":"400","message":"Unsupported model example-model"}',
    ])("asks for another model when the provider cannot serve it: %s", (details) => {
      expect(normalizeRunError(details)).toMatchObject({ kind: "model", recovery: "model" });
    });

    it.each([
      MODEL_CONTEXT_TOO_SMALL_ERROR,
      MODEL_REQUEST_LIMIT_ERROR,
      VERBATIM_TOOL_RESULT_TOO_LARGE_ERROR,
    ])("offers another model for an unusable request budget: %s", (details) => {
      expect(normalizeRunError(details)).toEqual({
        summary: details,
        details,
        kind: "context",
        recovery: "model",
      });
    });

    it("says a reply was cut off at the output limit, with the model's fix", () => {
      expect(normalizeRunError(MODEL_OUTPUT_CUT_ERROR)).toEqual({
        summary: MODEL_OUTPUT_CUT_ERROR,
        details: MODEL_OUTPUT_CUT_ERROR,
        kind: "output",
        recovery: "model",
      });
    });

    it("treats a request over the plan's token window as too long", () => {
      expect(
        normalizeRunError(
          '413: {"code":"rate_limit_exceeded","type":"tokens","message":"Request too large for model `fixture-model` on tokens per minute (TPM): Limit 2000, Requested 3000."}',
        ),
      ).toMatchObject({ kind: "context" });
    });

    it.each([
      "Provider finish_reason: error",
      "Provider stopped with: MALFORMED_FUNCTION_CALL",
      "Unhandled stop reason: MALFORMED_RESPONSE",
      "The model refused to complete the request",
      "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see the refusals guide.",
      "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.",
      "Provider returned an empty response",
      'unexpected tokens remaining in message header: Some("to=functions.example")',
      'HarmonyError: unexpected tokens remaining in message header: Some("analysis")',
      '500: {"message":"unexpected tokens remaining in message header: Some(\\"analysis\\")"}',
      'unexpected tokens remaining in message header: Some("credit limit, timeout, model not found")',
      "Failed to parse tool call arguments as JSON",
      '400: {"message":"Failed to parse tool call arguments as JSON","code":"tool_use_failed"}',
      "Tool call validation failed: attempted to call tool 'commentary' which was not in request.tools",
      "tool call validation failed: attempted to call tool 'commentary' which was not in request.tools",
      "Parsing failed. The model generated output that could not be parsed. Please adjust your prompt. See 'failed_generation' for more details.",
      '400 {"type":"error","error":{"type":"api_error","message":"Upstream request failed: [api_error] Upstream response was not valid JSON"}}',
      "Codex error: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.",
      "Cyber safeguards flagged this message. If this is legitimate security work, you can apply for the Cyber Verification Program: https://support.claude.com/en/articles/<article-id>",
      "This request triggered cyber-related safeguards. To learn about the Cyber Verification Program, see https://support.claude.com/en/articles/<article-id>",
      "SAFETY",
      "PROHIBITED_CONTENT",
      '400: {"code":"data_inspection_failed","param":null,"message":"Input text data may contain inappropriate content.","type":"data_inspection_failed"}',
      MODEL_OUTPUT_LIMIT_ERROR,
      "Upstream error from Example: HttpError: HTTP 400: Tool calls cutoff by max_tokens.",
    ])("calls unusable model output what it is: %s", (details) => {
      expect(classify(details)).toEqual({
        summary: "The model returned an unusable response. Try again.",
        details,
        kind: "output",
        recovery: "model",
      });
    });

    it("shows an operator cap without suggesting buying credits or changing connections", () => {
      expect(normalizeRunError(MODEL_CREDIT_CAP_REACHED_ERROR)).toEqual({
        summary: MODEL_CREDIT_CAP_REACHED_ERROR,
        details: MODEL_CREDIT_CAP_REACHED_ERROR,
      });
    });

    it("keeps the advice when Rakazo credits run out", () => {
      expect(normalizeRunError(MODEL_CREDITS_EXHAUSTED_ERROR)).toEqual({
        summary: MODEL_CREDITS_EXHAUSTED_ERROR,
        details: MODEL_CREDITS_EXHAUSTED_ERROR,
        recovery: "connection",
      });
    });

    it("sends a model credits cannot price to the member's own connection", () => {
      expect(normalizeRunError(MODEL_UNPRICED_FOR_CREDITS_ERROR)).toEqual({
        summary: MODEL_UNPRICED_FOR_CREDITS_ERROR,
        details: MODEL_UNPRICED_FOR_CREDITS_ERROR,
        recovery: "connection",
      });
    });

    it.each([MISSING_TOOL_FINAL_RESPONSE_ERROR, APPROVED_ACTION_NOT_RUN_ERROR])(
      "keeps the advice while attributing it to the model: %s",
      (details) => {
        expect(normalizeRunError(details)).toEqual({ summary: details, details, kind: "output" });
      },
    );

    it.each([
      google({
        code: 400,
        message: "Function call is missing a thought_signature in functionCall parts.",
        status: "INVALID_ARGUMENT",
      }),
      '400: {"message":"failed to template request: Unexpected message role.","type":"invalid_request_error"}',
      '400: {"message":"Provider returned error","code":400,"metadata":{"raw":"The `uniqueItems` JSON Schema keyword is not supported."}}',
      "Approved tool requests were not fully replayed",
      "Internal failure while handling unexpected tokens remaining in message header: unknown",
      '500: {"message":"Internal error"}',
      '503: {"message":"The model is unavailable right now."}',
      '503: {"message":"Unsupported model fixture-model"}',
      '400: {"message":"Unsupported model parameter: fixture_option"}',
      '400: {"message":"Unknown model setting: fixture_option"}',
      "TypeError: Cannot read properties of undefined (reading 'content')",
      '400 {"message":"Provider returned error","code":400,"metadata":{"raw":"{}","provider_name":""}}',
    ])("leaves requests we built and unknown shapes unattributed: %s", (details) => {
      expect(normalizeRunError(details).kind).toBeUndefined();
    });

    it.each([
      '400 {"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"error\\":{\\"message\\":\\"example upstream failure\\"}}","provider_name":"ExampleUpstream","is_byok":false}}',
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Invalid effort level: max"},"request_id":"req_example"}',
    ])("suggests another model when the provider refuses this one's request: %s", (details) => {
      expect(normalizeRunError(details)).toMatchObject({
        summary: "The model provider returned an error.",
        recovery: "model",
        status: 400,
      });
    });
  });
});

it.each(["2026-10-19T00:00:00Z", "2026-10-20T00:00:00Z", "not-a-date"])(
  "does not promise a past or invalid reset: %s",
  (reset) => {
    expect(
      normalizeRunError(
        `403: {"message":"OpenRouter weekly key limit exceeded", "metadata":{"reset_at":"${reset}"}}`,
        undefined,
        "en",
        Date.parse("2026-10-20T00:00:00Z"),
      ).summary,
    ).toBe("Your OpenRouter key hit its weekly limit.");
  },
);
it("keeps a future reset and identifies recovery", () => {
  expect(
    normalizeRunError(
      '403: {"message":"OpenRouter weekly key limit exceeded; resets 2026-10-21T00:00:00Z"}',
      undefined,
      "en",
      Date.parse("2026-10-20T00:00:00Z"),
    ),
  ).toMatchObject({
    summary: "Your OpenRouter key hit its weekly limit. Resets Oct 21.",
    recovery: "connection",
  });
  expect(normalizeRunError('401: {"message":"Invalid API key"}').recovery).toBe("connection");
  expect(normalizeRunError('429: {"message":"Too many requests"}').recovery).toBeUndefined();
  expect(normalizeRunError('500: {"message":"Internal error"}').recovery).toBeUndefined();
});

it.each([
  "Daily request limit exceeded",
  "Weekly request limit exceeded",
  "Per-minute quota exceeded",
])("keeps request quotas as rate limits: %s", (message) => {
  const error = normalizeRunError(`429: ${JSON.stringify({ message })}`);
  expect(error).toMatchObject({
    summary: "Your model provider is rate limiting requests. Try again shortly.",
    kind: "rate",
  });
  expect(error.recovery).toBeUndefined();
});
it.each(["Insufficient credit balance", "Monthly spending limit exceeded"])(
  "keeps financial 429 failures as quota errors: %s",
  (message) => {
    expect(normalizeRunError(`429: ${JSON.stringify({ message })}`).summary).not.toContain(
      "rate limiting",
    );
  },
);

it.each(["2026-02-29", "2026-02-30", "2026-04-31", "2026-02-30T12:00:00Z"])(
  "does not roll an invalid calendar reset forward: %s",
  (reset) => {
    expect(
      normalizeRunError(
        `403: ${JSON.stringify({ message: "OpenRouter weekly key limit exceeded", metadata: { reset_at: reset } })}`,
        undefined,
        "en",
        Date.parse("2026-01-01T00:00:00Z"),
      ).summary,
    ).toBe("Your OpenRouter key hit its weekly limit.");
  },
);
it("retains a valid future leap-day reset", () => {
  expect(
    normalizeRunError(
      '403: {"message":"OpenRouter weekly key limit exceeded; resets 2028-02-29"}',
      undefined,
      "en",
      Date.parse("2028-02-28T00:00:00Z"),
    ).summary,
  ).toBe("Your OpenRouter key hit its weekly limit. Resets Feb 29.");
});

it.each([
  ["403: OpenRouter weekly key limit exceeded", "key", "weekly"],
  ["402: Monthly spending limit exceeded", "spending", "monthly"],
  ["429: insufficient_quota", "credit", "none"],
  ["429: Too many requests", "rate", undefined],
  ["401: Invalid API key", "auth", undefined],
  ["404: Model unavailable", "model", undefined],
])("exposes shared cause metadata for %s", (details, kind, period) => {
  const error = normalizeRunError(details);
  expect(error.kind).toBe(kind);
  expect(error.period).toBe(period);
});

describe("isModelRequiredSendError", () => {
  it.each([
    MODEL_REQUIRED_SEND_ERROR,
    `  ${MODEL_REQUIRED_SEND_ERROR}\n`,
    new Error(MODEL_REQUIRED_SEND_ERROR),
    { message: MODEL_REQUIRED_SEND_ERROR },
  ])("recognizes the exact message in %s", (error) => {
    expect(isModelRequiredSendError(error)).toBe(true);
  });
  it.each([
    null,
    undefined,
    4,
    {},
    { message: 4 },
    "",
    "Connect a model",
    `prefix ${MODEL_REQUIRED_SEND_ERROR}`,
    `${MODEL_REQUIRED_SEND_ERROR} suffix`,
  ])("rejects unrelated values: %s", (error) => {
    expect(isModelRequiredSendError(error)).toBe(false);
  });
});

it("normalizes the shared image rejection with model recovery", () => {
  const translate = (message: string) => `translated:${message}`;
  expect(normalizeRunError(MODEL_IMAGE_INPUT_ERROR, translate)).toMatchObject({
    summary: `translated:${MODEL_IMAGE_INPUT_ERROR}`,
    recovery: "model",
    kind: "model",
  });
});

it("requires structured server metadata before offering file confirmation", () => {
  expect(
    isImageInputConfirmation({ status: 409, data: { reason: "model_image_input_unsupported" } }),
  ).toBe(true);
  expect(isImageInputConfirmation({ status: 409, message: MODEL_IMAGE_INPUT_ERROR })).toBe(false);
  expect(isImageInputConfirmation(MODEL_IMAGE_INPUT_ERROR)).toBe(false);
});

it("keeps model recovery for an image rejection after backups are exhausted", () => {
  const details = modelFallbackFailure(MODEL_IMAGE_INPUT_ERROR, [
    { provider: "fake-provider", modelId: "fake-model", status: "failed", reason: "fake" },
  ]);
  expect(normalizeRunError(details)).toMatchObject({
    summary: `${MODEL_IMAGE_INPUT_ERROR} Your backup models also failed.`,
    recovery: "model",
    kind: "model",
  });
});

it.each([
  [["failed"], "Your backup models also failed."],
  [["skipped"], "No backup model was usable for this request."],
  [["failed", "skipped"], "Backup models failed or were unavailable for this request."],
] as const)("explains exhausted backups: %s", (statuses, explanation) => {
  const primaryError = '429: {"message":"Too many requests"}';
  const details = modelFallbackFailure(
    primaryError,
    statuses.map((status) => ({
      provider: "fake-provider",
      modelId: "fake-model",
      status,
      reason: "fake-diagnostic",
    })),
  );
  // The listed details replace the primary's own message.
  const { providerMessage: _message, ...primary } = normalizeRunError(primaryError);
  expect(normalizeRunError(details)).toEqual({
    ...primary,
    details: [
      primaryError,
      ...statuses.map(() => "fake-provider fake-model: fake-diagnostic"),
    ].join("\n"),
    summary: `${normalizeRunError(primaryError).summary} ${explanation}`,
  });
});

it.each([
  "ResourceExhausted: Worker local total request limit reached (16/16)",
  "ResourceExhausted: Worker local total request limit reached (4358/16)",
])("reads a provider concurrency limit as rate limiting: %s", (details) => {
  expect(normalizeRunError(details)).toMatchObject({
    summary: "Your model provider is rate limiting requests. Try again shortly.",
    kind: "rate",
  });
});

it.each([
  COMPUTER_RATE_LIMIT_ERROR,
  COMPUTER_PROVIDER_UNAVAILABLE_ERROR,
  COMPUTER_UNRESPONSIVE_ERROR,
])("shows the computer error %j as written", (message) => {
  expect(normalizeRunError(message)).toEqual({ summary: message, details: message });
});

it("sends spent computer hours to billing", () => {
  expect(normalizeRunError(COMPUTER_ALLOWANCE_USED_ERROR)).toEqual({
    summary: COMPUTER_ALLOWANCE_USED_ERROR,
    details: COMPUTER_ALLOWANCE_USED_ERROR,
    recovery: "plan",
  });
});

it("does not expose malformed fallback metadata as user-facing copy", () => {
  expect(
    normalizeRunError(
      JSON.stringify({
        modelFallbackVersion: 1,
        primaryError: "private diagnostic",
        backups: [{ status: "unknown" }],
      }),
    ).summary,
  ).toBe("The model provider returned an error.");
});

describe("userRunError", () => {
  it("shows nothing of a database error's query, file or source", () => {
    const database = Object.assign(
      new Error(
        "\nInvalid `tx.run.findUnique()` invocation in\n/app/packages/db/src/events.ts:1604:40\n\n  1603 const run = await tx.run.findUnique({\nTransaction API error: Transaction already closed.",
      ),
      { name: "PrismaClientKnownRequestError" },
    );
    expect(userRunError(database)).toBe("Internal server error");
    expect(userRunError(database.message)).toBe("Internal server error");
  });

  it.each([
    new Error("timeout exceeded when trying to connect"),
    new Error("Connection terminated unexpectedly"),
    new Error("Connection terminated due to connection timeout"),
    new Error("Can't reach database server at `postgres:5432`"),
    Object.assign(new Error("DatabaseNotReachable"), { name: "DriverAdapterError" }),
  ])("treats a lost database connection as a server fault: $message", (error) => {
    expect(userRunError(error)).toBe("Internal server error");
  });

  it("drops stack frames and server file paths from a server fault", () => {
    const error = new Error(
      "ENOENT: no such file or directory, open '/app/data/bots/x.json'\n    at open (node:fs:573:3)\n    at async Promise.all (index 0)\n    at file:///app/dist/worker.js:12:7",
    );
    expect(userRunError(error)).toBe("ENOENT: no such file or directory, open '[path]'");
  });

  it.each([
    "terminated",
    '429: {"error":{"message":"Rate limit reached","type":"rate_limit_error"}}',
    "404 page not found: https://api.example.test/v1/chat/completions.json",
    "400 invalid_request_error:\n  at least one message is required",
    // A model on the user's own machine that is not running is theirs to fix.
    "connect ECONNREFUSED 127.0.0.1:1234",
    "Connection error.",
    MODEL_OUTPUT_LIMIT_ERROR,
  ])("passes a provider message through: %s", (message) => {
    expect(userRunError(new Error(message))).toBe(message);
  });
});

describe("the one action that fixes a failed run", () => {
  // Gateways in front of Google pass Google's error envelope through as a JSON string.
  const google = (error: Record<string, unknown>) =>
    JSON.stringify({ error: { message: JSON.stringify({ error }, null, 2), code: error.code } });
  const now = Date.parse("2026-10-01T00:00:00Z");
  const action = (details: string) => {
    const { summary, kind, period, recovery } = normalizeRunError(details, undefined, "en", now);
    return { summary, kind, period, recovery };
  };

  it.each([
    [
      '429: {"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429,"metadata":{"limit_source":"openrouter_free_tier_daily","remedy_hint":"Wait for the daily reset, or purchase credits to raise your free-model daily limit."}}',
      { kind: "credit", period: "daily" },
    ],
    [
      '402: {"message":"Insufficient credits. This account never purchased credits. Make sure your key is on the correct account or org, and if so, purchase more at https://example.test/credits","code":402,"metadata":{"limit_source":"openrouter_credits"}}',
      { kind: "credit", period: "none" },
    ],
    [
      '402: {"message":"This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 1000.","code":402}',
      { kind: "credit" },
    ],
    [
      "You have no credits remaining. Add credits to continue using the API at https://example.test/billing.",
      { kind: "credit" },
    ],
    [
      'xai API error (402): 402 "You have run out of credits or need a subscription. Add credits at https://example.test/usage."',
      { kind: "credit" },
    ],
    [
      '402 "You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get monthly included credits."',
      { kind: "credit", period: "none" },
    ],
    [
      google({
        code: 429,
        message:
          "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://example.test/rate-limits.",
        status: "RESOURCE_EXHAUSTED",
      }),
      { kind: "spending" },
    ],
    [
      google({
        code: 402,
        message:
          "Your prepayment credits are depleted. Please go to https://example.test to manage your project and billing.",
        status: "FAILED_PRECONDITION",
      }),
      { kind: "credit" },
    ],
    [
      'opencode API error (402): {"type":"server_error","message":"Upstream request failed: Insufficient account funds"}',
      { kind: "spending" },
    ],
  ])("offers another model when the provider account is out of quota: %s", (details, expected) => {
    expect(action(details)).toMatchObject({ ...expected, recovery: "model" });
  });

  it("sends a capped key back to the connection", () => {
    expect(
      action(
        '403: {"message":"Key limit exceeded (weekly limit). Manage it using https://example.test/keys/fake-key-id $5.01 of $5.00 used; resets 2026-10-12T00:00:00.000Z.","code":403,"metadata":{"limit_source":"openrouter_key_limit"}}',
      ),
    ).toEqual({
      summary: "Your OpenRouter key hit its weekly limit. Resets Oct 12.",
      kind: "key",
      period: "weekly",
      recovery: "connection",
    });
  });

  it("waits out a 429 that resets hours from now instead of calling it a rate limit", () => {
    const daily = (reset: number) =>
      `429 ${JSON.stringify({
        error: {
          message: "Rate limit exceeded: free-models-per-day",
          code: 429,
          metadata: {
            headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(reset) },
            limit_source: "openrouter_free_tier_daily",
          },
        },
      })}`;
    const tomorrow = Date.parse("2026-10-02T00:00:00Z");
    expect(normalizeRunError(daily(tomorrow), undefined, "en", now)).toMatchObject({
      summary: "Your OpenRouter reached its daily credit limit. Resets Oct 2.",
      kind: "credit",
      period: "daily",
      recovery: "model",
      resetAt: tomorrow,
    });
    expect(action(daily(now + 30_000))).toMatchObject({ kind: "rate" });
  });

  it.each([
    '401: {"message":"Missing Authentication header","code":401}',
    '401: {"message":"User not found.","code":401}',
    '401 {"status":401,"title":"Unauthorized","detail":"Invalid JWT serialization: Missing dot delimiter(s)"}',
    '403 {"status":403,"title":"Forbidden","detail":"Authorization failed"}',
    '401: {"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}',
    '401: {"type":"server_error","message":"Upstream request failed: Invalid credential"}',
    '401 "Invalid username or password."',
    "AccessDeniedException: Invalid API Key format: Must start with pre-defined prefix",
  ])("asks for a new key when the provider rejects it: %s", (details) => {
    expect(action(details)).toMatchObject({ kind: "auth", recovery: "connection" });
  });

  it.each([
    `403: {"type":"FreeTierError","message":"This free tier can only be used from within its own app."}`,
    '403: {"message":"example/model:free is only available on agentic harnesses. Try plugging it into a coding agent listed on https://example.test/apps","code":403}',
    '403: {"type":"server_error","message":"Upstream request failed: An active subscription is required to use these models."}',
    google({
      code: 403,
      message: "Your project has been denied access. Please contact support.",
      status: "PERMISSION_DENIED",
    }),
  ])("offers another model when the provider refuses this one to the account: %s", (details) => {
    expect(action(details)).toMatchObject({ kind: "access", recovery: "model" });
  });

  it.each([
    google({
      code: 404,
      message:
        "This model models/example-flash is no longer available to new users. Please update your code to use models/example-flash-2.",
      status: "NOT_FOUND",
    }),
    '404: {"message":"The model `example-model` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}',
    'github-copilot API error (400): {"message":"The requested model is not supported.","code":"model_not_supported","param":"model","type":"invalid_request_error"}',
    'opencode API error (410): {"type":"ModelDeprecated","message":"Model example-free has been deprecated."}',
    '400: {"message":"example/model:batch cannot be used with the chat/completions endpoint.","code":400,"param":"model"}',
    "The 'example-model' model is not supported when using Codex with a ChatGPT account.",
    "Validation error: This model doesn't support the image field for user messages. Remove image and try again.",
    '400: {"code":"400","message":"Unsupported model fixture-model"}',
    '400: {"error":{"message":"Unknown model: fixture-model"}}',
    '400: {"message":"Unrecognized model fixture-model"}',
    google({
      code: 400,
      message: "This model requires the use of the Computer Use tool.",
      status: "INVALID_ARGUMENT",
    }),
    "Invalid inference request. Check the model's supported parameters and input limits.",
  ])("offers another model when the provider cannot run it: %s", (details) => {
    expect(action(details)).toMatchObject({
      summary: "Your model provider can't run this model.",
      kind: "model",
      recovery: "model",
    });
  });

  it("offers another model when its output cap is below every request", () => {
    expect(
      action(
        '400: {"message":"`max_completion_tokens` must be less than or equal to `512`, the maximum value for `max_completion_tokens` is less than the `context_window` for this model","type":"invalid_request_error","param":"max_completion_tokens"}',
      ),
    ).toMatchObject({
      summary: MODEL_CONTEXT_TOO_SMALL_ERROR,
      kind: "context",
      recovery: "model",
    });
  });

  it.each([
    "Request timed out.",
    "Model stream idle timeout",
    "Upstream idle timeout exceeded",
    "Stream ended without finish_reason",
    google({
      code: 503,
      message: "This model is currently experiencing high demand. Please try again later.",
      status: "UNAVAILABLE",
    }),
    '429: {"message":"Provider returned error","code":429,"metadata":{"raw":"example/model:free is temporarily rate-limited upstream. Please retry shortly."}}',
    '429 {"status":429,"title":"Too Many Requests"}',
  ])("leaves a transient failure to its retry advice: %s", (details) => {
    const error = action(details);
    expect(error.summary).toMatch(/Try again/);
    expect(error.recovery).toBeUndefined();
  });

  it.each([MISSING_MODEL_RUN_ERROR, HOSTED_MODEL_CREDITS_REQUIRED_ERROR])(
    "keeps the app's own advice and opens the connections: %s",
    (details) => {
      expect(normalizeRunError(details)).toEqual({
        summary: details,
        details,
        recovery: "connection",
      });
    },
  );
});
