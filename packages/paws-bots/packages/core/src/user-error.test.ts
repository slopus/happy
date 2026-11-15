import { describe, expect, it } from "vitest";
import {
  authErrorMessage,
  credentialIssue,
  errorHelpUrl,
  isAbandonedRequest,
  isConnectionFailure,
  isNetworkFailure,
  isServerUnreachable,
  isTechnicalErrorMessage,
  userErrorMessage,
} from "./user-error.js";

const copy = { fallback: "Could not load bots", offline: "Could not reach the server" };
const authCopy = {
  fallback: "Could not sign up",
  email: "Enter a valid email",
  password: "Enter a password",
};

describe("isServerUnreachable", () => {
  it("counts no connection, timeouts and gateway errors, through causes", () => {
    expect(isServerUnreachable(new TypeError("Network request failed"))).toBe(true);
    const timeout = Object.assign(new Error("Request timed out"), { name: "TimeoutError" });
    expect(isServerUnreachable(timeout)).toBe(true);
    for (const status of [502, 503, 504]) {
      expect(isServerUnreachable(Object.assign(new Error("Bad gateway"), { status }))).toBe(true);
    }
    expect(isServerUnreachable(new Error("Could not reach the server", { cause: timeout }))).toBe(
      true,
    );
  });

  it("leaves answers from the server alone", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 500]) {
      expect(isServerUnreachable(Object.assign(new Error("No"), { status }))).toBe(false);
    }
    expect(isServerUnreachable(new Error("Request canceled"))).toBe(false);
    expect(isServerUnreachable(null)).toBe(false);
  });
});

describe("isNetworkFailure", () => {
  it("recognizes every platform's unreachable-server wording", () => {
    for (const message of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "Network request failed",
      "fetch failed",
      "fetch failed: UnexpectedException: Could not connect to the server. (at ExpoModulesCore/Promise.swift:56)",
      "The Internet connection appears to be offline.",
    ]) {
      expect(isNetworkFailure(new TypeError(message))).toBe(true);
    }
  });

  it("follows causes and socket error codes", () => {
    const refused = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
    expect(isNetworkFailure(new Error("request", { cause: refused }))).toBe(true);
  });

  it("leaves server responses and non-errors alone", () => {
    expect(isNetworkFailure(new Error("Bot not found"))).toBe(false);
    expect(isNetworkFailure("fetch failed")).toBe(false);
    expect(isNetworkFailure(null)).toBe(false);
  });
});

describe("isTechnicalErrorMessage", () => {
  it("flags validation dumps, exceptions, stack frames, JSON, status dumps, and codes", () => {
    for (const message of [
      "[body.email] Invalid email address; [body.password] Too small: expected string to have >=1 characters",
      "UnexpectedException: something",
      "TypeError: undefined is not a function",
      "Could not open (at ExpoModulesCore/Promise.swift:56)",
      '{"error":"boom"}',
      "rpc bots/list failed",
      "rpc threads/subscribe failed (502)",
      "Voice failed (500)",
      "connect ECONNREFUSED 127.0.0.1:3000",
      "VALIDATION_ERROR",
      "Response body exceeds 262144 bytes",
      "JSON Parse error: Unexpected character: <",
    ]) {
      expect(isTechnicalErrorMessage(message), message).toBe(true);
    }
  });

  it("keeps copy written for people", () => {
    for (const message of [
      "Bot not found",
      "Invalid email or password",
      "Request timed out",
      "Update your server to use AI data sharing in this mobile version.",
      "You do not have access to this space",
      "Use a longer password (at least 8 characters)",
    ]) {
      expect(isTechnicalErrorMessage(message), message).toBe(false);
    }
  });
});

describe("userErrorMessage", () => {
  it("says the server is unreachable for transport failures", () => {
    expect(userErrorMessage(new TypeError("Failed to fetch"), copy)).toBe(copy.offline);
    expect(userErrorMessage(Object.assign(new Error("Bad Gateway"), { status: 502 }), copy)).toBe(
      copy.offline,
    );
  });

  it("passes human messages through and replaces technical ones", () => {
    expect(userErrorMessage(new Error("Bot not found"), copy)).toBe("Bot not found");
    expect(userErrorMessage(new Error("rpc bots/list failed"), copy)).toBe(copy.fallback);
    expect(userErrorMessage(new Error("Input validation failed"), copy)).toBe(copy.fallback);
    expect(userErrorMessage(new Error("  "), copy)).toBe(copy.fallback);
    expect(userErrorMessage({ message: "Bot not found" }, copy)).toBe(copy.fallback);
    expect(userErrorMessage("Bot not found", copy)).toBe("Bot not found");
  });
});

describe("credentialIssue", () => {
  it("asks for a well-formed email before a password", () => {
    expect(credentialIssue({ email: "", password: "" })).toBe("email");
    expect(credentialIssue({ email: "ada@", password: "secret" })).toBe("email");
    expect(credentialIssue({ email: "ada@example", password: "secret" })).toBe("email");
    expect(credentialIssue({ email: " ada@example.com ", password: "" })).toBe("password");
    expect(credentialIssue({ email: "ada@example.com", password: "secret" })).toBeNull();
  });

  it("skips the password when the form has none", () => {
    expect(credentialIssue({ email: "ada@example.com" })).toBeNull();
  });
});

describe("authErrorMessage", () => {
  it("maps validation issue paths to field copy", () => {
    expect(
      authErrorMessage(
        {
          code: "VALIDATION_ERROR",
          message:
            "[body.email] Invalid email address; [body.password] Too small: expected string to have >=1 characters",
        },
        authCopy,
      ),
    ).toBe(authCopy.email);
    expect(
      authErrorMessage(
        { code: "VALIDATION_ERROR", message: "[body.password] Too small" },
        authCopy,
      ),
    ).toBe(authCopy.password);
    expect(
      authErrorMessage({ code: "VALIDATION_ERROR", message: "[body.name] Too big" }, authCopy),
    ).toBe(authCopy.fallback);
  });

  it("keeps the server's own auth copy and hides anything technical", () => {
    expect(
      authErrorMessage(
        { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
        authCopy,
      ),
    ).toBe("Invalid email or password");
    expect(authErrorMessage({ message: '{"detail":"x"}' }, authCopy)).toBe(authCopy.fallback);
    expect(authErrorMessage(undefined, authCopy)).toBe(authCopy.fallback);
  });
});

describe("isConnectionFailure", () => {
  it("counts lost connections, DNS failures, client timeouts and cancellations", () => {
    for (const message of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "fetch failed: UnexpectedException: The network connection was lost. (at ExpoModulesCore/Promise.swift:56)",
      "fetch failed: UnexpectedException: The Internet connection appears to be offline. (at ExpoModulesCore/Promise.swift:56)",
      "fetch failed: UnexpectedException: cancelled (at ExpoModulesCore/Promise.swift:56)",
      'fetch failed: java.net.UnknownHostException: Unable to resolve host "app.example.com": No address associated with hostname',
    ]) {
      expect(isConnectionFailure(new Error(message))).toBe(true);
    }
    const timeout = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    expect(isConnectionFailure(timeout)).toBe(true);
    expect(isAbandonedRequest(new Error("Request failed", { cause: timeout }))).toBe(true);
    expect(isAbandonedRequest({ name: "AbortError", message: "The user aborted a request." })).toBe(
      true,
    );
  });

  it("leaves code errors and server answers alone", () => {
    expect(isConnectionFailure(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(
      isConnectionFailure(new TypeError("Failed to execute 'fetch' on 'Window': Invalid name")),
    ).toBe(false);
    expect(isConnectionFailure(Object.assign(new Error("Unavailable"), { status: 503 }))).toBe(
      false,
    );
    expect(isAbandonedRequest(new Error("boom"))).toBe(false);
    expect(isAbandonedRequest(null)).toBe(false);
  });
});

describe("errorHelpUrl", () => {
  it("looks up a documented code independently of its message", () => {
    expect(errorHelpUrl({ code: "MCP_OAUTH_REDIRECT_MISMATCH", message: "Localized copy" })).toBe(
      "https://rakazo.com/docs/troubleshooting/#mcp-oauth-redirect-mismatch",
    );
  });

  it.each([
    null,
    "MCP_OAUTH_REDIRECT_MISMATCH",
    { code: "BAD_REQUEST" },
    { code: "toString" },
    { code: "UNKNOWN", helpUrl: "https://untrusted.example.test" },
  ])("does not invent a guide or accept an external link: %j", (error) => {
    expect(errorHelpUrl(error)).toBeUndefined();
  });
});
