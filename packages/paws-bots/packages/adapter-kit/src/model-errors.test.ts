import { describe, expect, it } from "vitest";
import {
  isModelCredentialRejected,
  isRetryableProviderUnavailable,
  isSignInRetryRequest,
  isTransientModelError,
} from "./model-errors.js";

describe("transient model errors", () => {
  it.each([
    [
      "in-stream overload",
      "Codex error: Our servers are currently overloaded. Please try again later.",
    ],
    ["overloaded status", "529 overloaded_error: Overloaded"],
    [
      "provider concurrency limit",
      "ResourceExhausted: Worker local total request limit reached (16/16)",
    ],
    [
      "rate limit",
      "429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit",
    ],
    [
      "per-minute quota",
      { status: 429, message: "Quota exceeded for quota metric 'requests' per minute" },
    ],
    ...[
      "You have hit your usage limit for requests per minute; retry after 1 second.",
      "You have hit your usage limit for tokens per minute.",
      "You have hit your usage limit per-second.",
      "Rate limit per second.",
      "Usage limit: requests-per-minute.",
      "Usage limit: tokens-per-minute.",
      "Usage limit: RPM.",
      "Usage limit: TPM.",
      "Usage limit; retry-after: 1 second.",
    ].map((message): [string, unknown] => [message, { status: 429, message }]),
    ["service unavailable", { status: 503, message: "service unavailable" }],
    ["bad gateway", new Error("502 Bad Gateway")],
    ["empty truncated stream", new Error("Stream ended without finish_reason")],
    [
      "stream ended without a finish reason",
      new Error("Example stream ended without a finish reason"),
    ],
    ["stream ended before its stop event", new Error("Anthropic stream ended before message_stop")],
    ["error injected into the stream", new Error("JSON error injected into SSE stream")],
    ["dropped fetch body", new TypeError("terminated")],
    [
      "interrupted upstream stream",
      new Error("Provider error (Example Model): stream interrupted"),
    ],
    ["provider network stop", new Error("Provider finish_reason: network_error")],
    ["fetch failure", new TypeError("fetch failed")],
    ["SDK connection failure", new Error("Connection error.")],
    ["SDK connection timeout", new Error("Request timed out.")],
    ["connection reset", new Error("read ECONNRESET")],
    ["socket hang up", new Error("socket hang up")],
    ["closed websocket", "WebSocket closed 1006"],
    ["idle stream", "Codex stream idle timeout"],
    [
      "provider timed out downloading a linked file",
      '400 data: {"error":{"code":"invalid_parameter_error","message":"Download multimodal file timed out","type":"invalid_request_error"}}',
    ],
    ["provider timed out on a file download", '400: {"message":"File download timed out"}'],
    [
      "server-side processing failure",
      "Codex error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 00000000-0000-0000-0000-000000000000 in your message.",
    ],
    [
      "per-minute token limit that links to billing",
      "Rate limit reached for example-model in organization org-example on tokens per min (TPM): Limit 60000, Used 51552, Requested 12568. Please try again in 4.12s. Visit https://platform.openai.com/account/rate-limits to learn more. You can increase your rate limit by adding a payment method to your account at https://platform.openai.com/account/billing.",
    ],
  ])("treats %s as transient", (_label, error) => {
    expect(isTransientModelError(error)).toBe(true);
  });

  it.each([
    ["usage limit", "You have hit your ChatGPT usage limit (plus plan). Try again in ~158 min."],
    [
      "exhausted quota",
      {
        status: 429,
        message: "You exceeded your current quota, please check your plan and billing details.",
        code: "insufficient_quota",
      },
    ],
    ["billing", { status: 402, message: "provider quota exhausted" }],
    ["payment required", '402: {"message":"This request requires more credits.","code":402}'],
    ["credit balance", "Your credit balance is too low to access the API."],
    ...[
      "You have hit your ChatGPT usage limit.",
      "insufficient_quota",
      "You exceeded your current quota.",
      "Quota exhausted.",
      "Billing limit reached.",
      "Payment required.",
      "Out of budget.",
      "You've reached your monthly usage limit; retry after 1 second.",
    ].map((message): [string, unknown] => [message, { status: 429, message }]),
    ["invalid key", { status: 401, message: "invalid_api_key: Incorrect API key provided" }],
    ["forbidden", "403 Forbidden"],
    ["context overflow", "context_length_exceeded: maximum context length is 128000 tokens"],
    ["bad request", { status: 400, message: "Unsupported parameter: temperature" }],
    ["auth failure mentioning a connection error", { status: 401, message: "Connection error." }],
    ["cancellation", new Error("Request was aborted")],
    ["unknown", new Error("Model stream ended without a terminal event")],
    [
      "a key that is not a valid header value",
      new TypeError(
        'Headers.append: "example key\nclient = Client(timeout=30, rate_limit=1)" is an invalid header value.',
      ),
    ],
  ])("treats %s as permanent", (_label, error) => {
    expect(isTransientModelError(error)).toBe(false);
  });

  it.each([
    [
      "CommandCode 400 insufficient credits",
      {
        status: 400,
        type: "invalid_request_error",
        message: "You have insufficient credits to make this request.",
      },
    ],
    ["400 out of credits", { status: 400, message: "Your account is out of credits." }],
    ["403 quota exceeded", { status: 403, message: "Quota exceeded for this account." }],
    ["402 credits exhausted", { status: 402, message: "Your credits have been exhausted." }],
  ])("does not retry the same model on exhaustion: %s", (_label, error) => {
    expect(isRetryableProviderUnavailable(error)).toBe(true);
    expect(isTransientModelError(error)).toBe(false);
  });

  it.each([
    "You've reached your 5-hour usage limit.",
    "You’ve reached your 5-hour usage limit.",
    "You've reached your weekly (7-day) usage limit.",
    "You've reached your monthly usage limit.",
    "You've reached your usage limit for this billing cycle.",
  ])("treats the exhausted usage window as permanent: %s", (message) => {
    expect(isTransientModelError({ status: 403, type: "permission_error", message })).toBe(false);
  });

  it("moves to a backup without retrying a quota that resets hours from now", () => {
    const daily = (reset: number) =>
      `429 ${JSON.stringify({
        error: {
          message: "Rate limit exceeded: free-models-per-day",
          code: 429,
          metadata: {
            headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(reset) },
          },
        },
      })}`;
    const exhausted = { errorMessage: daily(Date.now() + 10 * 60 * 60_000) };
    expect(isTransientModelError(exhausted)).toBe(false);
    expect(isRetryableProviderUnavailable(exhausted)).toBe(true);
    expect(isTransientModelError({ errorMessage: daily(Date.now() + 30_000) })).toBe(true);
  });
});

describe("provider availability classification", () => {
  it.each([
    ["dropped fetch body", new TypeError("terminated"), true],
    [
      "Codex overload",
      new Error("Codex error: Our servers are currently overloaded. Please try again later."),
      true,
    ],
    [
      "HTTP 400 before retry text",
      { status: 400, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "HTTP 401 before retry text",
      { statusCode: 401, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "HTTP 403 before retry text",
      { httpStatus: 403, message: "429 rate limit; Retry-After 3301s" },
      false,
    ],
    [
      "unprocessable input before retry text",
      { status: 422, message: "The request cannot be processed; 429 rate limit" },
      false,
    ],
    [
      "cancellation",
      new Error("user cancelled request; retry after 3301 seconds; 429 rate limit"),
      false,
    ],
    [
      "consent refusal",
      new Error("user declined consent; retry after 3301 seconds; 429 rate limit"),
      false,
    ],
    [
      "Kimi 403 5-hour usage limit",
      {
        status: 403,
        type: "permission_error",
        message:
          "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.",
      },
      true,
    ],
    [
      "Kimi 403 5-hour usage limit, curly apostrophe",
      {
        status: 403,
        type: "permission_error",
        message: "You\u2019ve reached your 5-hour usage limit.",
      },
      true,
    ],
    [
      "Kimi 403 weekly usage limit",
      {
        status: 403,
        type: "permission_error",
        message: "You've reached your weekly (7-day) usage limit.",
      },
      true,
    ],
    [
      "Kimi 403 monthly usage limit",
      {
        status: 403,
        type: "permission_error",
        message: "You've reached your monthly usage limit.",
      },
      true,
    ],
    [
      "Kimi 403 billing-cycle usage limit",
      {
        status: 403,
        type: "permission_error",
        message: "You've reached your usage limit for this billing cycle.",
      },
      true,
    ],
    [
      "HTTP 401 with nested Kimi 403 usage limit",
      {
        status: 401,
        cause: { status: 403, message: "You've reached your monthly usage limit." },
      },
      false,
    ],
    [
      "Kimi 403 monthly usage limit not reached",
      {
        status: 403,
        message: "You have not reached your monthly usage limit; access denied",
      },
      false,
    ],
    [
      "Kimi 401",
      {
        status: 401,
        type: "invalid_authentication_error",
        message: "The API Key appears to be invalid or may have expired.",
      },
      false,
    ],
    [
      "Kimi 403 concurrent request limit",
      {
        status: 403,
        message:
          "You've reached your concurrent request limit. Please wait for your ongoing requests to finish and try again.",
      },
      false,
    ],
    [
      "generic 403 permission_error",
      { status: 403, type: "permission_error", message: "permission denied" },
      false,
    ],
    [
      "ChatGPT usage limit",
      new Error("You have hit your ChatGPT usage limit (plus plan). Try again in ~158 min."),
      true,
    ],
    ["ChatGPT usage limit without a plan", "You have hit your ChatGPT usage limit.", true],
    [
      "HTTP 401 with ChatGPT usage limit text",
      { status: 401, message: "You have hit your ChatGPT usage limit." },
      false,
    ],
    ["quota exhaustion", { status: 402, message: "provider quota exhausted" }, true],
    ["insufficient balance", { status: 402, message: "Insufficient Balance" }, true],
    [
      "explicit balance error with generic request code",
      '402: {"message":"Insufficient Balance","type":"insufficient_balance_error","code":"invalid_request_error"}',
      true,
    ],
    [
      "authentication failure with a nested balance error",
      { status: 401, cause: { status: 402, type: "insufficient_balance_error" } },
      false,
    ],
    [
      "balance error with invalid parameters",
      { status: 402, type: "insufficient_balance_error", message: "Unsupported parameter" },
      false,
    ],
    [
      "payment status with an ordinary invalid request",
      { status: 402, code: "invalid_request_error", message: "Invalid tool schema" },
      false,
    ],
    [
      "CommandCode 400 insufficient credits",
      {
        status: 400,
        type: "invalid_request_error",
        message:
          "You have insufficient credits to make this request. Please purchase more credits to continue using the service.",
      },
      true,
    ],
    [
      "400 insufficient credits as text",
      "400 invalid_request_error: You have insufficient credits to make this request.",
      true,
    ],
    ["400 out of credits", { status: 400, message: "Your account is out of credits." }, true],
    [
      "400 exceeded quota",
      { status: 400, message: "You exceeded your current quota, please check your plan." },
      true,
    ],
    [
      "400 usage limit reached",
      { status: 400, message: "You've reached your weekly usage limit." },
      true,
    ],
    ["402 credits exhausted", { status: 402, message: "Your credits have been exhausted." }, true],
    [
      "400 credit balance too low",
      { status: 400, message: "Your credit balance is too low." },
      true,
    ],
    [
      "403 insufficient balance",
      { status: 403, message: "Insufficient balance. Please top up." },
      true,
    ],
    [
      "403 quota exceeded",
      { status: 403, type: "permission_error", message: "Quota exceeded for this account." },
      true,
    ],
    [
      "400 mentioning credits in a validation message",
      { status: 400, message: "Invalid parameter: credits must be a positive integer." },
      false,
    ],
    [
      "400 balance lookup failure",
      { status: 400, message: "Unable to retrieve credit balance." },
      false,
    ],
    [
      "400 validation error mentioning insufficient credits",
      { status: 400, message: "Validation failed: insufficient credits field is malformed." },
      false,
    ],
    [
      "400 unsupported parameter beside a credit balance",
      { status: 400, message: "Unsupported parameter: temperature; credit balance unchanged" },
      false,
    ],
    [
      "400 context length beside a quota phrase",
      { status: 400, message: "context_length_exceeded: quota exceeded for tokens" },
      false,
    ],
    [
      "400 model not found",
      { status: 400, message: "Model not found; you have insufficient credits to list models" },
      false,
    ],
    [
      "400 invalid request without exhaustion",
      { status: 400, type: "invalid_request_error", message: "Messages must not be empty." },
      false,
    ],
    [
      "401 wrapping insufficient credits",
      { status: 401, message: "You have insufficient credits to make this request." },
      false,
    ],
    [
      "401 wrapping a nested 400 exhaustion",
      { status: 401, cause: { status: 400, message: "Insufficient credits." } },
      false,
    ],
    [
      "403 permission denied beside an exhaustion phrase",
      { status: 403, message: "Permission denied; insufficient credits to share this project" },
      false,
    ],
    [
      "403 forbidden without exhaustion",
      { status: 403, message: "Forbidden: account suspended" },
      false,
    ],
    [
      "400 invalid api key beside an exhaustion phrase",
      { status: 400, message: "Invalid API key; out of credits" },
      false,
    ],
    [
      "400 cancellation beside an exhaustion phrase",
      { status: 400, message: "Request was aborted; insufficient credits" },
      false,
    ],
    [
      "400 per-minute window",
      { status: 400, message: "You have hit your usage limit for tokens per minute." },
      false,
    ],
    [
      "exhaustion phrase without a 4xx status",
      new Error("Something about insufficient credits"),
      false,
    ],
    ["plain status", new Error("503 provider unavailable"), true],
    ["HTTP server status", new Error("HTTP 500"), true],
    ["context overflow", new Error("context_length_exceeded; retry after 60s"), false],
    ["transient server failure", { status: 503, message: "service unavailable" }, true],
  ])("classifies %s", (_label, error, expected) => {
    expect(isRetryableProviderUnavailable(error)).toBe(expected);
  });
});

describe("rejected model credentials", () => {
  it.each([
    '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}',
    'Token refresh failed. status=400; body={"error":"invalid_grant","error_description":"Refresh token not found or invalid"}',
    "401 Incorrect API key provided",
    "invalid_api_key",
    "Your authentication token has been invalidated.",
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace."}}',
  ])("rejects %s without a retry", (message) => {
    expect(isModelCredentialRejected(new Error(message))).toBe(true);
    expect(isTransientModelError(new Error(message))).toBe(false);
  });

  it.each([
    "503 overloaded",
    "429 rate limit",
    "context_length_exceeded",
    "400 bad request",
    "403 permission_error: model not allowed",
  ])("does not reject %s", (message) => {
    expect(isModelCredentialRejected(new Error(message))).toBe(false);
  });
});

describe("message-only API status wrappers", () => {
  it("uses a backup for exhausted credits reported inside a parenthesized API status", () => {
    const error = new Error(
      'API error (403): {"error":"You have run out of credits or need a Grok subscription"}',
    );
    expect(isRetryableProviderUnavailable(error)).toBe(true);
    expect(isTransientModelError(error)).toBe(false);
  });

  it.each([
    "API error (403): Permission denied: out of credits",
    "API error (401): You have run out of credits",
    "API error (400): Unsupported parameter: credits",
  ])("does not classify a terminal response as an outage: %s", (error) => {
    expect(isRetryableProviderUnavailable(error)).toBe(false);
    expect(isTransientModelError(error)).toBe(false);
  });
});

describe("postfixed credential failures", () => {
  it.each(["credential expired", "credential revoked", "token expired", "token revoked"])(
    "recognizes %s even beside a retryable transport hint",
    (message) => {
      const error = new Error(`${message}; request timeout`);
      expect(isModelCredentialRejected(error)).toBe(true);
      expect(isRetryableProviderUnavailable(error)).toBe(false);
      expect(isTransientModelError(error)).toBe(false);
    },
  );
  it.each(["token missing", "credential missing"])("does not retry %s", (message) => {
    expect(isRetryableProviderUnavailable(`${message}; timeout`)).toBe(false);
  });
  it("does not treat an expired credential plus exhausted quota as account exhaustion", () => {
    expect(
      isRetryableProviderUnavailable({
        status: 403,
        message: "credential expired; quota exhausted",
      }),
    ).toBe(false);
  });
});

describe("sign-in retry requests", () => {
  it("recognises a sign-in service asking for a retry", () => {
    const error = new Error(
      '400 Bad Request: {"error":"request_failed","error_description":"The request failed to be processed, please try again"}',
    );
    expect(isSignInRetryRequest(error)).toBe(true);
    expect(isTransientModelError(error)).toBe(false);
  });
});
