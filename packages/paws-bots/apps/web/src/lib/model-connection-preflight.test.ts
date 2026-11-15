import { describe, expect, it, vi } from "vitest";
import {
  classifyModelConnectionFailure,
  loadStoredModelAuth,
  modelPreflightSuccessMessage,
  runModelConnectionPreflight,
  sanitizeModelConnectionError,
  unavailableSelectedModel,
} from "./model-connection-preflight.js";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  plural: (value: number, forms: { one: string; other: string }) =>
    (value === 1 ? forms.one : forms.other).replaceAll("#", String(value)),
}));

describe("sanitizeModelConnectionError", () => {
  it("redacts api key patterns", () => {
    expect(sanitizeModelConnectionError("Invalid sk-secretkey1234567890")).not.toContain(
      "sk-secretkey1234567890",
    );
  });

  it.each([
    ["a JSON error body", 'Invalid {"api_key": "EXAMPLE_PLACEHOLDER"}', "EXAMPLE_PLACEHOLDER"],
    [
      "a camel-case key with spaces around =",
      "apiKey = EXAMPLE_PLACEHOLDER",
      "EXAMPLE_PLACEHOLDER",
    ],
    ["a bearer token with base64 characters", "Bearer EXAMPLE+PLACE/HOLDER==", "PLACE/HOLDER"],
    ["a single-quoted value", "api-key: 'EXAMPLE_PLACEHOLDER'", "EXAMPLE_PLACEHOLDER"],
  ])("redacts the whole secret in %s", (_label, raw, secret) => {
    const cleaned = sanitizeModelConnectionError(raw);
    expect(cleaned).not.toContain(secret);
    expect(cleaned).toContain("•••");
  });

  it("keeps the text around a redacted JSON value", () => {
    expect(sanitizeModelConnectionError('{"api_key": "EXAMPLE_PLACEHOLDER", "code": 401}')).toBe(
      '{"•••", "code": 401}',
    );
  });
});

describe("classifyModelConnectionFailure", () => {
  it("detects rate limits and timeouts", () => {
    expect(classifyModelConnectionFailure(new Error("429 rate limit")).outcome).toBe("rate_limit");
    expect(classifyModelConnectionFailure(new Error("probe timed out")).outcome).toBe("timeout");
    expect(classifyModelConnectionFailure(new Error("The operation was aborted")).outcome).toBe(
      "unknown",
    );
  });

  it.each([
    ["rate_limit", "429 Too Many Requests"],
    ["rate_limit", "HTTP 429"],
    ["unauthorized", "Request failed with status 401"],
    ["unauthorized", "HTTP 403: forbidden"],
  ])("reads %s from the status code in %j", (outcome, message) => {
    expect(classifyModelConnectionFailure(new Error(message)).outcome).toBe(outcome);
  });

  it.each([
    "connect ECONNREFUSED 127.0.0.1:4030",
    "connect ECONNREFUSED 127.0.0.1:14290",
    "connect ECONNREFUSED 10.0.0.1:34010",
  ])("does not read a port or id as a status code in %j", (message) => {
    expect(classifyModelConnectionFailure(new Error(message)).outcome).toBe("unreachable");
  });

  it("keeps manual model entry for custom servers and catalog picks for catalog providers", () => {
    expect(unavailableSelectedModel("gpt-missing", ["gpt-test"])?.nextAction).toMatch(
      /enter a model id/,
    );
    expect(
      unavailableSelectedModel("gpt-missing", ["gpt-test"], { manualEntry: false })?.nextAction,
    ).toBe("Pick a model from the catalog.");
  });
});

describe("unavailableSelectedModel", () => {
  it("fails only when a non-empty list omits the selected id", () => {
    expect(unavailableSelectedModel("gpt-missing", ["gpt-test"])?.outcome).toBe(
      "unavailable_model",
    );
    expect(unavailableSelectedModel("gpt-test", ["gpt-test"])).toBeNull();
    expect(unavailableSelectedModel("", ["gpt-test"])).toBeNull();
    expect(unavailableSelectedModel("gpt-missing", [])).toBeNull();
  });
});

describe("loadStoredModelAuth", () => {
  it("keeps lookup failures distinct from a missing credential", async () => {
    await expect(loadStoredModelAuth("anthropic", async () => [])).resolves.toEqual({
      storedAuthKind: null,
      credentialLookupFailed: false,
      credentialUnreadable: false,
      reconnectRequired: false,
    });
    await expect(
      loadStoredModelAuth("anthropic", async () => {
        throw new Error("offline");
      }),
    ).resolves.toEqual({
      storedAuthKind: null,
      credentialLookupFailed: true,
      credentialUnreadable: false,
      reconnectRequired: false,
    });
  });

  it("reads the stored kind and flags a row whose kind is missing", async () => {
    await expect(
      loadStoredModelAuth("anthropic", async () => [
        { provider: "openai", authKind: "oauth" },
        { provider: "anthropic", authKind: "api_key" },
      ]),
    ).resolves.toMatchObject({ storedAuthKind: "api_key", credentialUnreadable: false });
    await expect(
      loadStoredModelAuth("anthropic", async () => [{ provider: "anthropic" }]),
    ).resolves.toMatchObject({ storedAuthKind: null, credentialUnreadable: true });
  });

  it("uses the selected connection when multiple rows share a model", async () => {
    const api = {
      id: "api",
      provider: "anthropic",
      modelId: "claude",
      authKind: "api_key" as const,
    };
    const oauth = {
      id: "oauth",
      provider: "anthropic",
      modelId: "claude",
      authKind: "oauth" as const,
    };
    for (const rows of [
      [api, oauth],
      [oauth, api],
    ]) {
      const stored = await loadStoredModelAuth("anthropic", async () => rows, "claude", "oauth");
      expect(stored.storedAuthKind).toBe("oauth");
      await expect(
        loadStoredModelAuth("anthropic", async () => rows, "another-model", "api"),
      ).resolves.toMatchObject({ storedAuthKind: "api_key" });
      expect(
        await runModelConnectionPreflight({ authKind: "oauth", provider: "anthropic", ...stored }),
      ).toMatchObject({ ok: true });
    }
  });

  it("does not substitute a different connection for an explicit ID", async () => {
    const rows = [
      { id: "oauth", provider: "anthropic", modelId: "claude", authKind: "oauth" as const },
      { id: "other-provider", provider: "openai", modelId: "claude", authKind: "oauth" as const },
      { id: "unreadable", provider: "anthropic", modelId: "claude" },
    ];
    for (const id of ["missing", "other-provider", "", null]) {
      await expect(
        loadStoredModelAuth("anthropic", async () => rows, "claude", id),
      ).resolves.toEqual({
        storedAuthKind: null,
        credentialLookupFailed: false,
        credentialUnreadable: false,
        reconnectRequired: false,
      });
    }
    await expect(
      loadStoredModelAuth("anthropic", async () => rows, "claude", "unreadable"),
    ).resolves.toEqual({
      storedAuthKind: null,
      credentialLookupFailed: false,
      credentialUnreadable: true,
      reconnectRequired: false,
    });
  });

  it("uses the credential that owns the selected model, not the newest provider row", async () => {
    const credentials = async () => [
      { provider: "anthropic", authKind: "oauth" as const, modelId: "claude-new" },
      {
        provider: "anthropic",
        authKind: "api_key" as const,
        modelId: "claude-saved",
        isDefault: true,
      },
    ];
    await expect(
      loadStoredModelAuth("anthropic", credentials, "claude-saved"),
    ).resolves.toMatchObject({ storedAuthKind: "api_key", credentialUnreadable: false });
    await expect(
      loadStoredModelAuth("anthropic", credentials, "claude-new"),
    ).resolves.toMatchObject({ storedAuthKind: "oauth" });
    await expect(
      loadStoredModelAuth("anthropic", credentials, "claude-other"),
    ).resolves.toMatchObject({ storedAuthKind: "api_key" });
  });

  it("prefers a saved provider credential over a newer unused row", async () => {
    await expect(
      loadStoredModelAuth(
        "anthropic",
        async () => [
          { provider: "anthropic", authKind: "oauth" },
          { provider: "anthropic", authKind: "api_key", modelId: "claude-saved" },
        ],
        "claude-other",
      ),
    ).resolves.toMatchObject({ storedAuthKind: "api_key" });
    await expect(
      loadStoredModelAuth("anthropic", async () => [
        { provider: "anthropic", authKind: "oauth" },
        { provider: "anthropic", authKind: "api_key" },
      ]),
    ).resolves.toMatchObject({ storedAuthKind: "oauth" });
  });

  it("reports the selected row unreadable even when a newer row has a kind", async () => {
    await expect(
      loadStoredModelAuth(
        "anthropic",
        async () => [
          { provider: "anthropic", authKind: "oauth", modelId: "claude-new" },
          { provider: "anthropic", modelId: "claude-saved", isDefault: true },
        ],
        "claude-saved",
      ),
    ).resolves.toEqual({
      storedAuthKind: null,
      credentialLookupFailed: false,
      credentialUnreadable: true,
      reconnectRequired: false,
    });
  });
});

describe("runModelConnectionPreflight", () => {
  it("probes catalog providers through the pinned catalog endpoint", async () => {
    const probeCatalog = vi.fn().mockResolvedValue({ models: ["gpt-test"] });
    const result = await runModelConnectionPreflight({
      authKind: "api-key",
      provider: "openrouter",
      apiKey: "sk-test-key-12345678",
      modelId: "gpt-test",
      catalogProbe: true,
      probeCatalog,
    });
    expect(result.ok).toBe(true);
    expect(probeCatalog).toHaveBeenCalledWith({
      provider: "openrouter",
      apiKey: "sk-test-key-12345678",
    });
  });

  it("rejects a selected model the catalog probe did not list", async () => {
    const result = await runModelConnectionPreflight({
      authKind: "api-key",
      provider: "openrouter",
      apiKey: "sk-test-key-12345678",
      modelId: "missing-model",
      catalogProbe: true,
      probeCatalog: async () => ({ models: ["gpt-test"] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.outcome).toBe("unavailable_model");
    }
  });

  it("rejects providers without a pinned catalog endpoint", async () => {
    const result = await runModelConnectionPreflight({
      authKind: "api-key",
      provider: "anthropic",
      apiKey: "sk-test-key-12345678",
      catalogProbe: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.outcome).toBe("unknown");
  });

  it("reports oauth when not connected", async () => {
    const result = await runModelConnectionPreflight({
      authKind: "oauth",
      provider: "openai-codex",
      storedAuthKind: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.outcome).toBe("needs_sign_in");
  });

  it("does not treat a stored api key as subscription sign-in", async () => {
    const result = await runModelConnectionPreflight({
      authKind: "oauth",
      provider: "anthropic",
      storedAuthKind: "api_key",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.outcome).toBe("needs_sign_in");
      expect(result.failure.message).toMatch(/API key is stored/);
    }
  });

  it("does not treat a rejected subscription sign-in as stored and usable", async () => {
    const result = await runModelConnectionPreflight({
      authKind: "oauth",
      provider: "openai-codex",
      storedAuthKind: "oauth",
      reconnectRequired: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.outcome).toBe("needs_sign_in");
    }
  });

  it("accepts a stored subscription credential", async () => {
    const result = await runModelConnectionPreflight({
      authKind: "oauth",
      provider: "openai-codex",
      storedAuthKind: "oauth",
    });
    expect(result.ok).toBe(true);
  });

  it.each([{ credentialUnreadable: true }, { credentialLookupFailed: true }])(
    "keeps credential lookup problems distinct from a missing sign-in: %j",
    async (lookup) => {
      const result = await runModelConnectionPreflight({
        authKind: "oauth",
        provider: "anthropic",
        storedAuthKind: "oauth",
        ...lookup,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.outcome).toBe("unknown");
    },
  );
});

describe("modelPreflightSuccessMessage", () => {
  it("reports a models-list check and does not ask catalog users to type an id", () => {
    expect(modelPreflightSuccessMessage(1)).toBe(
      "Models list OK. 1 model available. Chat was not tested.",
    );
    expect(modelPreflightSuccessMessage(466)).toBe(
      "Models list OK. 466 models available. Chat was not tested.",
    );
    expect(modelPreflightSuccessMessage(0)).toBe("No models listed.");
    expect(modelPreflightSuccessMessage(0)).not.toMatch(/model id/i);
  });
});
