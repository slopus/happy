import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";
import type { ModelCredentialFailedState, ModelCredentialRetireReason } from "@rakazo/adapter-kit";
import { isModelCredentialRejected } from "@rakazo/adapter-kit";
import { containsSecret, redactSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  kickModelCredentialRefresh,
  refreshExpiredModelCredential,
  refreshStoredModelCredential,
  resolveStoredModelAuth,
} from "./model-credential-refresh.js";
import { parseModelSecret, secretValuesToRedact, serializeModelSecret } from "./model-secret.js";
import { PiRuntimeCredentialStore } from "./pi-credentials.js";
import type { PiOAuthBegin, PiOAuthConnected } from "./pi-oauth.js";
import {
  CHATGPT_OAUTH_PROVIDER,
  COPILOT_OAUTH_PROVIDER,
  isRetiredModelCredentialError,
  loadProviderOAuth,
  ModelSignInError,
  matchesFailedOAuthSecret,
  OAUTH_ACCOUNT_CHANGED_ERROR,
  OAUTH_RECONNECT_REQUIRED_ERROR,
  oauthCredentialAccountId,
  oauthCredentialEmail,
  PiOAuthLogins,
  RetiredModelCredentialError,
  resolveModelApiKey,
  resolveModelAuth,
  SIGN_IN_LEASE_RENEW_MS,
  terminalOAuthRefreshErrorMarker,
  tryRetireModelCredential,
  XAI_OAUTH_PROVIDER,
} from "./pi-oauth.js";

const oauthCred = (overrides: Partial<OAuthCredential> = {}): OAuthCredential => ({
  type: "oauth",
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
  accountId: "acct",
  ...overrides,
});

// Unsigned fake JWT: base64url JSON payload, no real token material.
const fakeJwt = (payload: unknown) =>
  `fake.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fake`;

const chatGptAccountClaim = (accountId: string) => ({
  "https://api.openai.com/auth": { chatgpt_account_id: accountId },
});

async function flushMicrotasks() {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

type TestActor = { userId: string; spaceId: string };

function deviceCodeResult(started: PiOAuthBegin) {
  if (started.mode !== "device-code") throw new Error("Expected a device-code login");
  return started;
}

/** Saves nothing; the "saved" value is the access token, so tests can tell sign-ins apart. */
const keep = async (login: PiOAuthConnected) => login.credential.access;

/** A save that holds until released, recording the signal each save ran under. */
function gatedPersist() {
  let release!: (error?: unknown) => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve, reject) => {
    release = (error) => (error ? reject(error) : resolve());
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const signals: AbortSignal[] = [];
  const saved: string[] = [];
  const persist = async (login: PiOAuthConnected) => {
    signals.push(login.signal);
    markStarted();
    await gate;
    saved.push(login.credential.access);
    return login.credential.access;
  };
  return { persist, started, release, signals, saved };
}

function createControlledOAuthLogins() {
  let startedCount = 0;
  const resolvers = new Map<number, (credential: Credential) => void>();
  const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction) => {
    const index = startedCount++;
    interaction.notify({
      type: "device_code",
      userCode: `CODE-${index}`,
      verificationUri: "https://auth.openai.com/codex/device",
    });
    return new Promise<Credential>((resolve, reject) => {
      resolvers.set(index, resolve);
      interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  });
  return {
    logins,
    get startedCount() {
      return startedCount;
    },
    resolve(index: number, credential: Credential = oauthCred()) {
      const resolve = resolvers.get(index);
      if (!resolve) throw new Error(`No OAuth login ${index} is waiting for a credential.`);
      resolve(credential);
    },
  };
}

type ControlledOAuthLogins = ReturnType<typeof createControlledOAuthLogins>;

async function beginControlledOAuth(
  control: ControlledOAuthLogins,
  actor: TestActor,
  persist: (login: PiOAuthConnected) => Promise<string> = keep,
  index = 0,
) {
  const started = await control.logins.begin({
    ...actor,
    provider: CHATGPT_OAUTH_PROVIDER,
    persist,
  });
  control.resolve(index);
  await flushMicrotasks();
  return started;
}

describe("model secrets", () => {
  it("round-trips generic limits without changing legacy API-key storage or redaction", () => {
    expect(serializeModelSecret({ kind: "api_key", key: "fake-api-key" })).toBe("fake-api-key");
    const secret = {
      kind: "api_key" as const,
      key: "fake-api-key",
      contextWindow: 1000000,
      maxTokens: 4096,
    };
    const decoded = parseModelSecret(serializeModelSecret(secret));
    expect(decoded).toEqual(secret);
    expect(secretValuesToRedact(decoded)).toEqual(["fake-api-key"]);
  });
  it("round-trips compatible model limits", () => {
    const secret = {
      kind: "openai_compatible" as const,
      baseUrl: "http://127.0.0.1:8000/v1",
      contextWindow: 8192,
      maxTokens: 1024,
    };
    expect(parseModelSecret(serializeModelSecret(secret))).toEqual(secret);
  });
  it("treats plaintext as an API key", () => {
    expect(parseModelSecret("sk-or-v1-abc")).toEqual({ kind: "api_key", key: "sk-or-v1-abc" });
  });

  it("round-trips an API key output limit", () => {
    const parsed = parseModelSecret(
      serializeModelSecret({ kind: "api_key", key: "sk-test-key", maxTokens: 8192 }),
    );
    expect(parsed).toEqual({ kind: "api_key", key: "sk-test-key", maxTokens: 8192 });
    expect(secretValuesToRedact(parsed)).toEqual(["sk-test-key"]);
  });

  it("round-trips OAuth credentials", () => {
    const credential = oauthCred({ expires: 42 });
    const parsed = parseModelSecret(serializeModelSecret({ kind: "oauth", credential }));
    expect(parsed).toEqual({ kind: "oauth", credential });
    expect(secretValuesToRedact(parsed)).toEqual(["access-token", "refresh-token"]);
  });

  it("round-trips openai-compatible credentials", () => {
    const parsed = parseModelSecret(
      serializeModelSecret({
        kind: "openai_compatible",
        baseUrl: "http://127.0.0.1:8000/v1",
        enabledModelIds: ["local/default", "local/other"],
      }),
    );
    expect(parsed).toEqual({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      enabledModelIds: ["local/default", "local/other"],
    });
  });

  it("leaves enabledModelIds undefined on an openai-compatible secret saved without it", () => {
    const parsed = parseModelSecret(
      JSON.stringify({ kind: "openai_compatible", baseUrl: "http://127.0.0.1:8000/v1" }),
    );
    expect(parsed).toEqual({ kind: "openai_compatible", baseUrl: "http://127.0.0.1:8000/v1" });
    expect(parsed.kind === "openai_compatible" && parsed.enabledModelIds).toBeUndefined();
  });

  it("rejects credential JSON that declares a kind but misses its fields", () => {
    expect(() => parseModelSecret(JSON.stringify({ kind: "oauth" }))).toThrow(/corrupt/);
    expect(() =>
      parseModelSecret(JSON.stringify({ kind: "oauth", credential: { type: "oauth" } })),
    ).toThrow(/corrupt/);
    expect(() => parseModelSecret(JSON.stringify({ kind: "api_key" }))).toThrow(/corrupt/);
    expect(() => parseModelSecret(JSON.stringify({ kind: "api_key", key: "" }))).toThrow(/corrupt/);
    expect(() => parseModelSecret(JSON.stringify({ kind: "openai_compatible" }))).toThrow(
      /corrupt/,
    );
  });

  it("rejects a broken legacy OAuth credential object", () => {
    expect(() =>
      parseModelSecret(JSON.stringify({ type: "oauth", access: "access-token" })),
    ).toThrow(/corrupt/);
  });

  it("keeps JSON without a recognized credential kind as a literal API key", () => {
    const unknownKind = JSON.stringify({ kind: "bearer", token: "abc" });
    expect(parseModelSecret(unknownKind)).toEqual({ kind: "api_key", key: unknownKind });
    const objectKey = JSON.stringify({ hello: "world" });
    expect(parseModelSecret(objectKey)).toEqual({ kind: "api_key", key: objectKey });
    expect(parseModelSecret("{broken-json")).toEqual({ kind: "api_key", key: "{broken-json" });
  });

  it("fails a corrupt stored credential instead of using it as an API key", async () => {
    const corrupt = JSON.stringify({ kind: "oauth", credential: { type: "oauth" } });
    await expect(resolveModelApiKey(corrupt, CHATGPT_OAUTH_PROVIDER)).rejects.toThrow(/corrupt/);
  });

  it("refreshes expired OAuth tokens and persists them", async () => {
    const credential = oauthCred({ access: "old", expires: 1 });
    let saved = "";
    const apiKey = await resolveModelApiKey(JSON.stringify(credential), CHATGPT_OAUTH_PROVIDER, {
      now: 10_000,
      persist: async (next) => {
        saved = next;
      },
      oauth: {
        refresh: async () => oauthCred({ access: "new", expires: 99_999 }),
        toAuth: async (current) => ({ apiKey: current.access }),
      },
    });
    expect(apiKey).toBe("new");
    expect(JSON.parse(saved).access).toBe("new");
  });

  it("keeps a configured output limit when refreshing OAuth tokens", async () => {
    const stored = serializeModelSecret({
      kind: "oauth",
      credential: oauthCred({ access: "old", expires: 1 }),
      maxTokens: 16384,
    });
    let saved = "";
    const resolved = await resolveModelAuth(stored, CHATGPT_OAUTH_PROVIDER, {
      now: 10_000,
      persist: async (next) => {
        saved = next;
      },
      oauth: {
        refresh: async () => oauthCred({ access: "new", expires: 99_999 }),
        toAuth: async (current) => ({ apiKey: current.access }),
      },
    });
    expect(resolved.apiKey).toBe("new");
    expect(resolved.secret.maxTokens).toBe(16384);
    expect(parseModelSecret(saved)).toMatchObject({
      kind: "oauth",
      maxTokens: 16384,
      credential: expect.objectContaining({ access: "new" }),
    });
  });
});

describe("terminalOAuthRefreshErrorMarker", () => {
  it.each([
    "invalid_grant",
    "refresh_token_expired",
    "refresh_token_reused",
    "refresh_token_invalidated",
  ])("matches the terminal marker %s in a pi-wrapped refresh error", (marker) => {
    const providerError = new Error(
      `OpenAI Codex token refresh failed (400): {"error":"${marker}","error_description":"gone"}`,
    );
    const wrapped = new Error("OAuth refresh failed for openai-codex", { cause: providerError });
    expect(terminalOAuthRefreshErrorMarker(wrapped)).toBe(marker);
  });

  it.each([400, 401, 403])("matches a marker alongside a %i status", (status) => {
    const providerError = new Error(
      `OpenAI Codex token refresh failed (${status}): {"error":"invalid_grant"}`,
    );
    expect(terminalOAuthRefreshErrorMarker(providerError)).toBe("invalid_grant");
  });

  it("matches pi's Kimi Coding unauthorized marker", () => {
    expect(
      terminalOAuthRefreshErrorMarker(
        new Error("Kimi Code token refresh unauthorized (status 401)"),
      ),
    ).toBe("Kimi Code token refresh unauthorized");
    expect(
      terminalOAuthRefreshErrorMarker(
        new Error("Kimi Code token refresh unauthorized (status 403): token revoked"),
      ),
    ).toBe("Kimi Code token refresh unauthorized");
  });

  it("matches a marker embedded in the outer message", () => {
    expect(
      terminalOAuthRefreshErrorMarker(new Error('token refresh failed (400): "invalid_grant"')),
    ).toBe("invalid_grant");
  });

  it("accepts a marker and a terminal status split across the cause chain", () => {
    const wrapped = new Error("OAuth refresh failed for xai", {
      cause: new Error('{"error":"invalid_grant"}', {
        cause: new Error("xAI OAuth token refresh failed (HTTP 403)"),
      }),
    });
    expect(terminalOAuthRefreshErrorMarker(wrapped)).toBe("invalid_grant");
  });

  it.each(['"upstream 503"', '"status 502"', '"(502)"', '"upstream status=502"'])(
    "still retires a real 400 whose body text mentions %s",
    (quoted) => {
      // The quoted status lives inside the embedded response body, so it is not
      // the layer's own status and must not veto the genuine terminal 400.
      const body = JSON.stringify({ error: "invalid_grant", error_description: quoted });
      expect(
        terminalOAuthRefreshErrorMarker(
          new Error(`OpenAI Codex token refresh failed (400): ${body}`),
        ),
      ).toBe("invalid_grant");
    },
  );

  it("retires an Anthropic terminal error whose body field mentions a 5xx", () => {
    // Anthropic flattens nested errors into `details=...; status=400; ...
    // body={...}`; the 503 sits inside the quoted body field, not the layer's
    // own status.
    const anthropic = new Error(
      "Anthropic token refresh request failed. url=https://api.anthropic.com; " +
        "details=Error: HTTP request failed. status=400; url=https://api.anthropic.com; " +
        'body={"error":"invalid_grant","error_description":"upstream status=503"}',
    );
    expect(terminalOAuthRefreshErrorMarker(anthropic)).toBe("invalid_grant");
  });

  it("retires a Copilot-style terminal error whose body text mentions a 5xx", () => {
    expect(
      terminalOAuthRefreshErrorMarker(
        new Error(
          '400 Bad Request: {"error":"invalid_grant","error_description":"upstream (502)"}',
        ),
      ),
    ).toBe("invalid_grant");
  });

  it.each([
    [
      "4xx marker outer, 5xx inner",
      new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}', {
        cause: new Error("gateway upstream failed (502)"),
      }),
    ],
    [
      "5xx outer, 4xx marker inner",
      new Error("OAuth refresh failed for openai-codex (503)", {
        cause: new Error('{"error":"invalid_grant"}', {
          cause: new Error("token endpoint rejected (400)"),
        }),
      }),
    ],
    [
      "kimi unauthorized marker with a 5xx layer",
      new Error("Kimi Code token refresh unauthorized (status 403)", {
        cause: new Error("proxy hop failed with status 504"),
      }),
    ],
  ])("does not classify a %s chain as terminal", (_label, error) => {
    // A 5xx anywhere in the chain vetoes a terminal 4xx + marker elsewhere —
    // the deeper gateway failure means the token endpoint never judged the
    // credential.
    expect(terminalOAuthRefreshErrorMarker(error)).toBeUndefined();
  });

  it.each([
    [
      "5xx body quoting a marker",
      new Error('OpenAI Codex token refresh failed (500): {"error":"invalid_grant"}'),
    ],
    [
      "502 body quoting a marker",
      new Error(
        'OpenAI Codex token refresh failed (502): {"error":"invalid_grant","error_description":"gateway"}',
      ),
    ],
    ["marker without a status", new Error('{"error":"invalid_grant"}')],
    [
      "marker on a 200 body missing fields",
      new Error('OpenAI Codex token refresh response missing fields: {"error":"invalid_grant"}'),
    ],
    [
      "marker with a non-terminal 4xx",
      new Error('OpenAI Codex token refresh failed (404): {"error":"invalid_grant"}'),
    ],
    [
      "marker with an unrelated number",
      new Error("token refresh failed: invalid_grant (retry after 400 ms)"),
    ],
    ["thrown marker string", "refresh_token_reused"],
    ["network failure", new Error("OpenAI Codex token refresh error: fetch failed")],
    ["server error", new Error("OpenAI Codex token refresh failed (503): service unavailable")],
    [
      "kimi retryable status",
      new Error('Kimi Code token refresh failed with status 500: {"error":"invalid_grant"}'),
    ],
    ["timeout", new Error("The operation timed out")],
    ["malformed body", new Error("OpenAI Codex token refresh response missing fields: {}")],
    ["lookalike identifier", new Error('{"error":"not_invalid_grant"} (400)')],
    ["marker prefix only", new Error('{"error":"invalid_granted"} (400)')],
    ["non-error object", { message: "invalid_grant (400)" }],
    ["null", null],
    ["undefined", undefined],
  ])("does not classify a %s as terminal", (_label, error) => {
    expect(terminalOAuthRefreshErrorMarker(error)).toBeUndefined();
  });

  it("stops walking after the chain depth limit", () => {
    let error: Error = new Error('(400) {"error":"invalid_grant"}');
    for (let i = 0; i < 12; i += 1) error = new Error(`layer ${i}`, { cause: error });
    expect(terminalOAuthRefreshErrorMarker(error)).toBeUndefined();

    let shallow: Error = new Error('(400) {"error":"invalid_grant"}');
    for (let i = 0; i < 3; i += 1) shallow = new Error(`layer ${i}`, { cause: shallow });
    expect(terminalOAuthRefreshErrorMarker(shallow)).toBe("invalid_grant");
  });
});

describe("resolveModelAuth retirement", () => {
  const expired = JSON.stringify(oauthCred({ access: "old", expires: 1 }));

  const failingRefresh = (error: unknown) => ({
    refresh: async (): Promise<OAuthCredential> => {
      throw error;
    },
    toAuth: async (current: OAuthCredential) => ({ apiKey: current.access }),
  });

  it("retires once with the classified marker, then reports reconnect without the provider body", async () => {
    const failure = new Error("OAuth refresh failed for openai-codex", {
      cause: new Error('OpenAI Codex token refresh failed (400): {"error":"invalid_grant"}'),
    });
    const retire = vi.fn(async () => true);
    const persist = vi.fn(async () => {});

    await expect(
      resolveModelAuth(expired, CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        persist,
        retire,
        oauth: failingRefresh(failure),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RetiredModelCredentialError &&
        error.message === OAUTH_RECONNECT_REQUIRED_ERROR &&
        !error.message.includes("invalid_grant"),
    );

    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith(
      "terminal-refresh-failure",
      "invalid_grant",
      // The stored credential state the failed refresh was attempted on.
      expect.objectContaining({ access: "old", refresh: "refresh-token", expires: 1 }),
    );
    expect(persist).not.toHaveBeenCalled();
    expect(isRetiredModelCredentialError(failure)).toBe(false);
    expect(isModelCredentialRejected(new Error(OAUTH_RECONNECT_REQUIRED_ERROR))).toBe(true);
  });

  it("refuses a reconnect marker without calling the provider", async () => {
    const refresh = vi.fn(async () => oauthCred());
    const plaintext = serializeModelSecret({ kind: "oauth", reconnectRequired: true });
    expect(plaintext).not.toContain("access");
    expect(plaintext).not.toContain("refresh");
    await expect(
      resolveModelAuth(plaintext, CHATGPT_OAUTH_PROVIDER, {
        oauth: { refresh, toAuth: async () => ({ apiKey: "sent-to-model" }) },
      }),
    ).rejects.toThrow(OAUTH_RECONNECT_REQUIRED_ERROR);
    expect(refresh).not.toHaveBeenCalled();
    expect(secretValuesToRedact(parseModelSecret(plaintext))).toEqual([]);
  });

  it("does not retire on transient refresh failures", async () => {
    for (const failure of [
      new Error("OpenAI Codex token refresh error: fetch failed"),
      new Error("OpenAI Codex token refresh failed (500): {"),
      new Error('OpenAI Codex token refresh failed (500): {"error":"invalid_grant"}'),
      new Error("request timed out"),
    ]) {
      const retire = vi.fn(async () => undefined);
      await expect(
        resolveModelAuth(expired, CHATGPT_OAUTH_PROVIDER, {
          now: 10_000,
          retire,
          oauth: failingRefresh(failure),
        }),
      ).rejects.toBe(failure);
      expect(retire).not.toHaveBeenCalled();
      expect(isRetiredModelCredentialError(failure)).toBe(false);
    }
  });

  it("rethrows the refresh error when retirement itself fails", async () => {
    const failure = new Error('refresh failed (400): {"error":"refresh_token_expired"}');
    const retireFailure = new Error("database gone");
    const retire = vi.fn(async () => {
      throw retireFailure;
    });

    await expect(
      resolveModelAuth(expired, CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        retire,
        oauth: failingRefresh(failure),
      }),
    ).rejects.toBe(failure);
    expect(retire).toHaveBeenCalledWith(
      "terminal-refresh-failure",
      "refresh_token_expired",
      expect.objectContaining({ access: "old", refresh: "refresh-token", expires: 1 }),
    );
    expect(isRetiredModelCredentialError(failure)).toBe(false);
    expect(isModelCredentialRejected(new Error(OAUTH_RECONNECT_REQUIRED_ERROR))).toBe(true);
  });

  it("does not mark a refresh error retired when the delete was skipped", async () => {
    const failure = new Error('refresh failed (400): {"error":"invalid_grant"}');
    const retire = vi.fn(async () => false);
    await expect(
      resolveModelAuth(expired, CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        retire,
        oauth: failingRefresh(failure),
      }),
    ).rejects.toBe(failure);
    expect(isRetiredModelCredentialError(failure)).toBe(false);
    expect(isModelCredentialRejected(new Error(OAUTH_RECONNECT_REQUIRED_ERROR))).toBe(true);
  });

  it("counts a credential retired only when the retire hook confirms it", async () => {
    const failed = oauthCred({ access: "old", expires: 1 });
    const retired = (result: () => Promise<boolean | undefined>) =>
      tryRetireModelCredential(vi.fn(result), "terminal-refresh-failure", "invalid_grant", failed);
    expect(await retired(async () => true)).toBe(true);
    expect(await retired(async () => false)).toBe(false);
    expect(await retired(async () => undefined)).toBe(false);
    expect(
      await retired(async () => {
        throw new Error("database gone");
      }),
    ).toBe(false);
    expect(await tryRetireModelCredential(undefined, "account-changed", "detail", failed)).toBe(
      false,
    );
  });

  it("rethrows the refresh error when no retire hook is configured", async () => {
    const failure = new Error('refresh failed (400): {"error":"invalid_grant"}');
    await expect(
      resolveModelAuth(expired, CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        oauth: failingRefresh(failure),
      }),
    ).rejects.toBe(failure);
  });

  it("does not refresh or retire while the stored token is still valid", async () => {
    const refresh = vi.fn();
    const retire = vi.fn(async () => undefined);
    const resolved = await resolveModelAuth(
      JSON.stringify(oauthCred({ access: "live", expires: 1_000_000 })),
      CHATGPT_OAUTH_PROVIDER,
      {
        now: 10_000,
        retire,
        oauth: {
          refresh,
          toAuth: async (current: OAuthCredential) => ({ apiKey: current.access }),
        },
      },
    );
    expect(resolved.apiKey).toBe("live");
    expect(refresh).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
  });
});

describe("resolveModelAuth account-change guard", () => {
  const expiredAccount = (accountId: string | undefined, access = "old") =>
    JSON.stringify(oauthCred({ access, expires: 1, accountId }));

  const succeedingRefresh = (next: OAuthCredential) => ({
    refresh: async (): Promise<OAuthCredential> => next,
    toAuth: async (current: OAuthCredential) => ({ apiKey: current.access }),
  });

  // Wired the way the executor does around retireModelCredential.
  const fencingRetire =
    (row: () => string, deleteCredential: () => void) =>
    async (
      _reason: ModelCredentialRetireReason,
      _detail?: string,
      failed?: ModelCredentialFailedState,
    ) => {
      const matches = failed ? matchesFailedOAuthSecret(() => row(), failed) : undefined;
      if (matches && !(await matches({ id: "secret-codex", ciphertext: "cipher-codex" })))
        return false;
      deleteCredential();
      return true;
    };

  it("persists a refresh that returns the same account", async () => {
    const retire = vi.fn(async () => undefined);
    const persist = vi.fn(async () => {});
    const resolved = await resolveModelAuth(expiredAccount("acct-a"), CHATGPT_OAUTH_PROVIDER, {
      now: 10_000,
      persist,
      retire,
      oauth: succeedingRefresh(oauthCred({ access: "new", expires: 99_999, accountId: "acct-a" })),
    });
    expect(resolved.apiKey).toBe("new");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(retire).not.toHaveBeenCalled();
  });

  it("retires the credential and fails when the refresh returns a different account", async () => {
    const retire = vi.fn(async () => true);
    const persist = vi.fn(async () => {});
    const toAuth = vi.fn(
      async (current: OAuthCredential): Promise<{ apiKey: string }> => ({
        apiKey: current.access,
      }),
    );

    await expect(
      resolveModelAuth(expiredAccount("acct-a"), CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        persist,
        retire,
        oauth: {
          refresh: async () => oauthCred({ access: "new", expires: 99_999, accountId: "acct-b" }),
          toAuth,
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RetiredModelCredentialError &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );

    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith(
      "account-changed",
      "stored account acct-a, refreshed account acct-b",
      // The stored credential state whose refresh produced the foreign account.
      expect.objectContaining({ access: "old", refresh: "refresh-token", expires: 1 }),
    );
    // The account-B token is never persisted or used.
    expect(persist).not.toHaveBeenCalled();
    expect(toAuth).not.toHaveBeenCalled();
  });

  it("detects the account change from the refreshed token's JWT claim", async () => {
    const retire = vi.fn(async () => true);
    // A refresh that does not copy `accountId` onto the credential is still
    // caught when the new access token carries the ChatGPT account claim.
    const refresh = async (): Promise<OAuthCredential> =>
      oauthCred({
        access: fakeJwt(chatGptAccountClaim("acct-b")),
        expires: 99_999,
        accountId: undefined,
      });

    await expect(
      resolveModelAuth(expiredAccount("acct-a"), CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        retire,
        oauth: {
          refresh,
          toAuth: async (current: OAuthCredential) => ({ apiKey: current.access }),
        },
      }),
    ).rejects.toThrow(OAUTH_ACCOUNT_CHANGED_ERROR);
    expect(retire).toHaveBeenCalledWith(
      "account-changed",
      "stored account acct-a, refreshed account acct-b",
      // The stored credential state whose refresh produced the foreign account.
      expect.objectContaining({ refresh: "refresh-token", expires: 1 }),
    );
  });

  it("compares against a stored account id carried only by the stored access JWT", async () => {
    const retire = vi.fn(async () => true);
    await expect(
      resolveModelAuth(
        expiredAccount(undefined, fakeJwt(chatGptAccountClaim("acct-a"))),
        CHATGPT_OAUTH_PROVIDER,
        {
          now: 10_000,
          retire,
          oauth: succeedingRefresh(
            oauthCred({ access: "new", expires: 99_999, accountId: "acct-b" }),
          ),
        },
      ),
    ).rejects.toThrow(OAUTH_ACCOUNT_CHANGED_ERROR);
    expect(retire).toHaveBeenCalledWith(
      "account-changed",
      "stored account acct-a, refreshed account acct-b",
      // The stored credential state whose refresh produced the foreign account.
      expect.objectContaining({ refresh: "refresh-token", expires: 1 }),
    );
  });

  it("still fails with the readable error when account-change retirement fails", async () => {
    const retire = vi.fn(async () => {
      throw new Error("database gone");
    });

    await expect(
      resolveModelAuth(expiredAccount("acct-a"), CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        retire,
        oauth: succeedingRefresh(
          oauthCred({ access: "new", expires: 99_999, accountId: "acct-b" }),
        ),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RetiredModelCredentialError) &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );
    expect(retire).toHaveBeenCalledWith(
      "account-changed",
      "stored account acct-a, refreshed account acct-b",
      // The stored credential state whose refresh produced the foreign account.
      expect.objectContaining({ refresh: "refresh-token", expires: 1 }),
    );
  });

  it("skips the account-change delete when a concurrent refresh rotated the secret row", async () => {
    // A sibling run refreshed the ORIGINAL account and rewrote the same secret
    // row while this refresh was in flight; the stale account-change failure
    // must not delete the newer credential.
    const stored = oauthCred({ access: "old", expires: 1, accountId: "acct-a" });
    let row = serializeModelSecret({ kind: "oauth", credential: stored });
    const deleteCredential = vi.fn();

    await expect(
      resolveModelAuth(JSON.stringify(stored), CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        retire: fencingRetire(() => row, deleteCredential),
        oauth: {
          refresh: async () => {
            row = serializeModelSecret({
              kind: "oauth",
              credential: oauthCred({
                access: "rotated",
                refresh: "rotated-refresh",
                expires: 50_000,
                accountId: "acct-a",
              }),
            });
            return oauthCred({ access: "new", expires: 99_999, accountId: "acct-b" });
          },
          toAuth: async (current: OAuthCredential) => ({ apiKey: current.access }),
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RetiredModelCredentialError) &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );

    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("still deletes while the secret row matches the failed account-change state", async () => {
    // The fence must not block the intended delete: the row still holds the
    // credential that produced the foreign account, so it goes away.
    const stored = oauthCred({ access: "old", expires: 1, accountId: "acct-a" });
    const row = serializeModelSecret({ kind: "oauth", credential: stored });
    const deleteCredential = vi.fn();

    await expect(
      resolveModelAuth(JSON.stringify(stored), CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        retire: fencingRetire(() => row, deleteCredential),
        oauth: succeedingRefresh(
          oauthCred({ access: "new", expires: 99_999, accountId: "acct-b" }),
        ),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RetiredModelCredentialError &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );

    expect(deleteCredential).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stored side", undefined, "acct-b"],
    ["refreshed side", "acct-a", undefined],
    ["both sides", undefined, undefined],
  ])(
    "tolerates a missing account id on the %s",
    async (_case, storedAccountId, refreshedAccountId) => {
      const retire = vi.fn(async () => undefined);
      const persist = vi.fn(async () => {});
      const resolved = await resolveModelAuth(
        expiredAccount(storedAccountId),
        CHATGPT_OAUTH_PROVIDER,
        {
          now: 10_000,
          persist,
          retire,
          oauth: succeedingRefresh(
            oauthCred({ access: "new", expires: 99_999, accountId: refreshedAccountId }),
          ),
        },
      );
      expect(resolved.apiKey).toBe("new");
      expect(persist).toHaveBeenCalledTimes(1);
      expect(retire).not.toHaveBeenCalled();
    },
  );

  it("skips the account-change delete when another worker rotated only the access token", async () => {
    // A successful refresh can keep the same refresh token and expiry and
    // rewrite only the access token. The fence has to notice that too.
    const stored = oauthCred({
      access: "old",
      refresh: "same-refresh",
      expires: 1,
      accountId: "acct-a",
    });
    const row = serializeModelSecret({
      kind: "oauth",
      credential: oauthCred({
        access: "rotated-access",
        refresh: "same-refresh",
        expires: 1,
        accountId: "acct-a",
      }),
    });
    const deleteCredential = vi.fn();

    await expect(
      resolveModelAuth(JSON.stringify(stored), CHATGPT_OAUTH_PROVIDER, {
        now: 10_000,
        retire: fencingRetire(() => row, deleteCredential),
        oauth: succeedingRefresh(
          oauthCred({ access: "foreign", expires: 99_999, accountId: "acct-b" }),
        ),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RetiredModelCredentialError) &&
        error.message === OAUTH_ACCOUNT_CHANGED_ERROR,
    );

    expect(deleteCredential).not.toHaveBeenCalled();
  });
});

describe("oauthCredentialEmail", () => {
  it("reads the signed-in account's email from the access token", () => {
    expect(
      oauthCredentialEmail(
        oauthCred({
          access: fakeJwt({ "https://api.openai.com/profile": { email: "me@example.com" } }),
        }),
      ),
    ).toBe("me@example.com");
    expect(oauthCredentialEmail(oauthCred({ access: fakeJwt({ email: "top@example.com" }) }))).toBe(
      "top@example.com",
    );
    expect(oauthCredentialEmail(oauthCred())).toBeUndefined();
    expect(oauthCredentialEmail(oauthCred({ access: fakeJwt({ email: "not an email" }) }))).toBe(
      undefined,
    );
  });
});

describe("oauthCredentialAccountId", () => {
  it("reads the namespaced chatgpt_account_id claim", () => {
    expect(
      oauthCredentialAccountId(
        oauthCred({
          accountId: undefined,
          access: fakeJwt({
            ...chatGptAccountClaim("acct-ns"),
            chatgpt_account_id: "acct-top",
          }),
        }),
      ),
    ).toBe("acct-ns");
  });

  it("falls back to a top-level chatgpt_account_id claim", () => {
    expect(
      oauthCredentialAccountId(
        oauthCred({
          accountId: "",
          access: fakeJwt({ chatgpt_account_id: "acct-top" }),
        }),
      ),
    ).toBe("acct-top");
  });

  it("falls back to the top-level claim when the namespaced one is blank", () => {
    for (const blank of ["", "   ", "\t"]) {
      expect(
        oauthCredentialAccountId(
          oauthCred({
            accountId: undefined,
            access: fakeJwt({
              "https://api.openai.com/auth": { chatgpt_account_id: blank },
              chatgpt_account_id: "acct-top",
            }),
          }),
        ),
      ).toBe("acct-top");
    }
    expect(
      oauthCredentialAccountId(
        oauthCred({
          accountId: undefined,
          access: fakeJwt({
            "https://api.openai.com/auth": { chatgpt_account_id: "" },
            chatgpt_account_id: "   ",
          }),
        }),
      ),
    ).toBeUndefined();
  });

  it("falls back to the top-level claim when the namespaced one is not a string", () => {
    for (const namespaced of [42, false, { id: "acct-obj" }, null]) {
      expect(
        oauthCredentialAccountId(
          oauthCred({
            accountId: undefined,
            access: fakeJwt({
              "https://api.openai.com/auth": { chatgpt_account_id: namespaced },
              chatgpt_account_id: "acct-top",
            }),
          }),
        ),
      ).toBe("acct-top");
    }
    expect(
      oauthCredentialAccountId(
        oauthCred({
          accountId: undefined,
          access: fakeJwt({
            "https://api.openai.com/auth": { chatgpt_account_id: 42 },
            chatgpt_account_id: 7,
          }),
        }),
      ),
    ).toBeUndefined();
  });

  it("keeps a padded accountId and skips one that is only whitespace", () => {
    const access = fakeJwt(chatGptAccountClaim("acct-jwt"));
    expect(oauthCredentialAccountId(oauthCred({ accountId: "  acct-direct  ", access }))).toBe(
      "  acct-direct  ",
    );
    expect(oauthCredentialAccountId(oauthCred({ accountId: "   ", access }))).toBe("acct-jwt");
  });

  it("returns undefined for an undecodable token", () => {
    expect(
      oauthCredentialAccountId(oauthCred({ accountId: undefined, access: "not-a-jwt" })),
    ).toBeUndefined();
    expect(() =>
      oauthCredentialAccountId(oauthCred({ accountId: " \t ", access: "a.!!!.c" })),
    ).not.toThrow();
    expect(
      oauthCredentialAccountId(oauthCred({ accountId: " \t ", access: "a.!!!.c" })),
    ).toBeUndefined();
  });
});

describe("matchesFailedOAuthSecret", () => {
  const failed = { access: "old-access", refresh: "old-refresh", expires: 1 };
  const load = (ciphertext: string) => ciphertext;
  const predicate = () => matchesFailedOAuthSecret(load, failed);
  const row = (credential: OAuthCredential) => ({
    id: "secret-1",
    ciphertext: serializeModelSecret({ kind: "oauth", credential }),
  });

  it("matches only when the stored credential is still the one that failed", async () => {
    expect(await predicate()(row(oauthCred(failed)))).toBe(true);
  });

  it("skips a secret another worker refreshed in place", async () => {
    // A successful refresh can rotate only the access token and keep the same
    // refresh token and expiry. Any of the three fields changing means the
    // stored row is no longer the failed attempt.
    expect(
      await predicate()(
        row(oauthCred({ access: "new-access", refresh: "old-refresh", expires: 1 })),
      ),
    ).toBe(false);
    expect(
      await predicate()(
        row(oauthCred({ access: "old-access", refresh: "new-refresh", expires: 1 })),
      ),
    ).toBe(false);
    expect(
      await predicate()(
        row(oauthCred({ access: "old-access", refresh: "old-refresh", expires: 2 })),
      ),
    ).toBe(false);
  });

  it("skips material it cannot prove is the failed credential", async () => {
    expect(await predicate()({ id: "secret-1", ciphertext: "not-json" })).toBe(false);
    expect(
      await predicate()({
        id: "secret-1",
        ciphertext: serializeModelSecret({ kind: "api_key", key: "sk-test" }),
      }),
    ).toBe(false);
    const broken = matchesFailedOAuthSecret(() => {
      throw new Error("decrypt failed");
    }, failed);
    expect(await broken({ id: "secret-1", ciphertext: "cipher" })).toBe(false);
  });
});

function lockingSecretRow() {
  const prisma = {
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    secret: {
      findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: "cipher" })),
      findUnique: vi.fn(async () => ({ ciphertext: "cipher" })),
      update: vi.fn(async () => ({})),
    },
  };
  return prisma as unknown as PrismaClient;
}

describe("refreshExpiredModelCredential", () => {
  const scope = { userId: "user-1", spaceId: "ws-1" };

  function secretRow(initial: string) {
    let current = initial;
    const prisma = lockingSecretRow();
    const secretStore = {
      load: vi.fn(async () => current),
      delete: vi.fn(async () => {}),
      put: vi.fn(async (next: string) => {
        current = next;
        return {
          id: "secret-1",
          ref: `cipher:${next.length}`,
          ciphertext: `cipher:${next.length}`,
        };
      }),
    };
    return {
      prisma,
      secretStore,
      update: prisma.secret.update as unknown as ReturnType<typeof vi.fn>,
    };
  }

  const stubOAuth = (refresh: (credential: OAuthCredential) => Promise<OAuthCredential>) => ({
    refresh: vi.fn(refresh),
    toAuth: vi.fn(async (credential: OAuthCredential) => ({ apiKey: credential.access })),
  });

  it("ends a stalled running-run refresh at its backstop and keeps one that answers within pi's 15 s", async () => {
    vi.useFakeTimers();
    // Timer-driven AbortSignal.timeout, so fake time reaches it.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("timed out")), ms);
      return controller.signal;
    });
    try {
      const expired = oauthCred({ access: "old", expires: 1 });
      const { prisma, secretStore } = secretRow(
        serializeModelSecret({ kind: "oauth", credential: expired }),
      );
      const runner = new PiRuntimeCredentialStore(
        CHATGPT_OAUTH_PROVIDER,
        expired,
        undefined,
        undefined,
        refreshStoredModelCredential(
          prisma,
          secretStore,
          scope,
          { id: "cred-1", secretId: "secret-1" },
          CHATGPT_OAUTH_PROVIDER,
          { oauth: stubOAuth(async () => expired) },
        ),
      );
      // A stalled runtime refresh outlives pi's 15 s, then the backstop ends it with no write.
      let settled = false;
      const stalled = runner.modify(CHATGPT_OAUTH_PROVIDER, () => new Promise(() => {}));
      stalled.then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.advanceTimersByTimeAsync(15_001);
      expect(settled).toBe(false);
      const ended = expect(stalled).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(5_000);
      await ended;
      expect(secretStore.put).not.toHaveBeenCalled();

      // The lock is free again. pi-ai's own 15 s starts after ours, so it can answer as ours reaches 15 s.
      const refreshed = runner.modify(CHATGPT_OAUTH_PROVIDER, async () => {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        return oauthCred({ access: "new", expires: Date.now() + 3_600_000 });
      });
      await vi.advanceTimersByTimeAsync(15_001);

      await expect(refreshed).resolves.toMatchObject({ access: "new" });
      expect(secretStore.put).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not refresh a sign-in whose stored row was removed before the lock", async () => {
    const plaintext = serializeModelSecret({
      kind: "oauth",
      credential: oauthCred({ access: "old", expires: 1 }),
    });
    const { prisma, secretStore } = secretRow(plaintext);
    vi.mocked(prisma.secret.findUnique).mockResolvedValue(null);
    const oauth = stubOAuth(async () =>
      oauthCred({ access: "new", expires: Date.now() + 3_600_000 }),
    );

    await expect(
      resolveStoredModelAuth(
        prisma,
        secretStore,
        scope,
        { id: "cred-1", secretId: "secret-1" },
        plaintext,
        CHATGPT_OAUTH_PROVIDER,
        { oauth },
      ),
    ).rejects.toThrow("Connect that model provider again.");
    expect(oauth.refresh).not.toHaveBeenCalled();
    expect(secretStore.put).not.toHaveBeenCalled();
  });

  it("decides whether a refresh is due from one clock reading", async () => {
    const start = 1_000_000;
    // The token turns due 5 ms after the first reading.
    const held = oauthCred({ access: "old", expires: start + 5 * 60_000 + 5 });
    const plaintext = serializeModelSecret({ kind: "oauth", credential: held });
    const { prisma, secretStore } = secretRow(plaintext);
    const oauth = stubOAuth(async () => oauthCred({ access: "new", expires: start + 3_600_000 }));
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(start)
      .mockReturnValue(start + 10);
    try {
      const resolved = await resolveStoredModelAuth(
        prisma,
        secretStore,
        scope,
        { secretId: "secret-1" },
        plaintext,
        CHATGPT_OAUTH_PROVIDER,
        { oauth },
      );
      expect(resolved.apiKey).toBe("old");
      expect(oauth.refresh).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("refreshes and persists an expired OAuth credential", async () => {
    const { prisma, secretStore, update } = secretRow(
      serializeModelSecret({
        kind: "oauth",
        credential: oauthCred({ access: "old", expires: 1 }),
      }),
    );
    const oauth = stubOAuth(async () =>
      oauthCred({ access: "new", expires: Date.now() + 3_600_000 }),
    );

    await refreshExpiredModelCredential(
      prisma,
      secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      { oauth },
    );

    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(secretStore.put).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: "secret-1" },
      data: { ciphertext: expect.any(String) },
    });

    // The stored credential is now fresh, so a queued second run is a no-op.
    await refreshExpiredModelCredential(
      prisma,
      secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      { oauth },
    );
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(secretStore.put).toHaveBeenCalledTimes(1);
  });

  it("leaves a still-valid bearer and non-OAuth secrets untouched", async () => {
    const fresh = secretRow(
      serializeModelSecret({
        kind: "oauth",
        credential: oauthCred({ access: "kept", expires: Date.now() + 3_600_000 }),
      }),
    );
    const oauth = stubOAuth(async () => oauthCred({ access: "new" }));
    await refreshExpiredModelCredential(
      fresh.prisma,
      fresh.secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      { oauth },
    );
    expect(oauth.refresh).not.toHaveBeenCalled();
    expect(fresh.secretStore.put).not.toHaveBeenCalled();

    const apiKey = secretRow("sk-test-plain-key");
    await refreshExpiredModelCredential(
      apiKey.prisma,
      apiKey.secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      { oauth },
    );
    expect(oauth.refresh).not.toHaveBeenCalled();
    expect(apiKey.secretStore.put).not.toHaveBeenCalled();
  });

  it("serializes on the credential lock so concurrent kicks refresh once", async () => {
    const { prisma, secretStore } = secretRow(
      serializeModelSecret({
        kind: "oauth",
        credential: oauthCred({ access: "old", expires: 1 }),
      }),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const oauth = stubOAuth(async () => {
      await gate;
      return oauthCred({ access: "new", expires: Date.now() + 3_600_000 });
    });

    const first = refreshExpiredModelCredential(
      prisma,
      secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      { oauth },
    );
    const second = refreshExpiredModelCredential(
      prisma,
      secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      { oauth },
    );
    await vi.waitFor(() => expect(oauth.refresh).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);

    // The second call waited on the lock, then saw the already-fresh token.
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(secretStore.put).toHaveBeenCalledTimes(1);
  });

  it("refreshes a rotating token once when the kick, a run start and a running run race across processes", async () => {
    // Three API/worker processes: separate module state, one shared secret row and lock.
    const processes = [];
    for (let index = 0; index < 3; index += 1) {
      vi.resetModules();
      processes.push({
        refresh: await import("./model-credential-refresh.js"),
        credentials: await import("./pi-credentials.js"),
      });
    }
    const [a, b, c] = processes as [
      (typeof processes)[0],
      (typeof processes)[0],
      (typeof processes)[0],
    ];
    const held = oauthCred({ access: "acc-0", refresh: "rt-0", expires: 1 });
    let stored = serializeModelSecret({ kind: "oauth", credential: held });
    const secret = {
      findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: stored })),
      findUnique: vi.fn(async () => ({ ciphertext: stored })),
      update: vi.fn(async ({ data }: { data: { ciphertext: string } }) => {
        stored = data.ciphertext;
        return {};
      }),
    };
    let locked = Promise.resolve();
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        let release = () => {};
        const tx = {
          $executeRaw: vi.fn(async (sql: TemplateStringsArray) => {
            if (!sql.join("").includes("pg_advisory_xact_lock")) return 0;
            const previous = locked;
            locked = new Promise<void>((resolve) => (release = resolve));
            await previous;
            return 0;
          }),
          secret,
        };
        try {
          return await fn(tx);
        } finally {
          release();
        }
      }),
      secret,
    } as unknown as PrismaClient;
    const secretStore = {
      load: vi.fn(async (ciphertext: string) => ciphertext),
      put: vi.fn(async (next: string) => ({ id: "secret-1", ref: next, ciphertext: next })),
      delete: vi.fn(async () => {}),
    };
    // The provider rotates refresh tokens and rejects a spent one.
    const sent: string[] = [];
    const oauth = stubOAuth(async (credential) => {
      sent.push(credential.refresh);
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (credential.refresh !== "rt-0") throw new Error("invalid_grant: refresh token reused");
      return oauthCred({ access: "acc-1", refresh: "rt-1", expires: Date.now() + 3_600_000 });
    });
    const credential = { id: "cred-1", secretId: "secret-1" };
    // A running run's store, refreshing the way the runtime does: only a token that expires soon.
    const runner = new c.credentials.PiRuntimeCredentialStore(
      CHATGPT_OAUTH_PROVIDER,
      held,
      undefined,
      undefined,
      c.refresh.refreshStoredModelCredential(
        prisma,
        secretStore,
        scope,
        credential,
        CHATGPT_OAUTH_PROVIDER,
        {
          oauth,
        },
      ),
    );

    const [, started, running] = await Promise.all([
      a.refresh.refreshExpiredModelCredential(
        prisma,
        secretStore,
        scope,
        "secret-1",
        CHATGPT_OAUTH_PROVIDER,
        {
          oauth,
        },
      ),
      b.refresh.resolveStoredModelAuth(
        prisma,
        secretStore,
        scope,
        credential,
        stored,
        CHATGPT_OAUTH_PROVIDER,
        {
          oauth,
        },
      ),
      runner.modify(CHATGPT_OAUTH_PROVIDER, async (current) =>
        current?.type === "oauth" && current.expires - Date.now() < 300_000
          ? oauth.refresh(current)
          : undefined,
      ),
    ]);

    expect(sent).toEqual(["rt-0"]);
    expect(started.apiKey).toBe("acc-1");
    expect(running).toMatchObject({ access: "acc-1", refresh: "rt-1" });
    expect(runner.accessToken).toBe("acc-1");
    expect(parseModelSecret(stored)).toMatchObject({ credential: { refresh: "rt-1" } });
  });
});

describe("kickModelCredentialRefresh", () => {
  const scope = { userId: "user-1", spaceId: "ws-1" };

  it("collapses concurrent kicks into one refresh and frees the slot after", async () => {
    let current = serializeModelSecret({
      kind: "oauth",
      credential: oauthCred({ access: "old", expires: 1 }),
    });
    const prisma = lockingSecretRow();
    const secretStore = {
      load: vi.fn(async () => current),
      delete: vi.fn(async () => {}),
      put: vi.fn(async (next: string) => {
        current = next;
        return { id: "secret-1", ref: "next", ciphertext: "next" };
      }),
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const oauth = {
      refresh: vi.fn(async () => {
        await gate;
        return oauthCred({ access: "new", expires: Date.now() + 3_600_000 });
      }),
      toAuth: vi.fn(async (credential: OAuthCredential) => ({ apiKey: credential.access })),
    };
    const opts = { oauth };

    kickModelCredentialRefresh(
      prisma,
      secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      opts,
    );
    kickModelCredentialRefresh(
      prisma,
      secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      opts,
    );
    await vi.waitFor(() => expect(oauth.refresh).toHaveBeenCalledTimes(1));
    release();
    await vi.waitFor(() => expect(secretStore.put).toHaveBeenCalledTimes(1));
    expect(oauth.refresh).toHaveBeenCalledTimes(1);

    // Let the kick's finally settle so the in-flight slot frees before re-kicking.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Once the kick settles a later expired read may kick again — this one
    // finds the fresh token and refreshes nothing.
    kickModelCredentialRefresh(
      prisma,
      secretStore,
      scope,
      "secret-1",
      CHATGPT_OAUTH_PROVIDER,
      opts,
    );
    await vi.waitFor(() => expect(oauth.toAuth).toHaveBeenCalledTimes(2));
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("PiOAuthLogins", () => {
  it("keeps ChatGPT OAuth on Codex rather than plain OpenAI", () => {
    expect(loadProviderOAuth("openai")).toBeUndefined();
    expect(loadProviderOAuth(CHATGPT_OAUTH_PROVIDER)?.isSubscription).toBe(true);
  });

  it.each(["openrouter", "openai"])("rejects subscription sign-in for %s", async (provider) => {
    const logins = new PiOAuthLogins();
    await expect(
      logins.begin({ userId: "u", spaceId: "w", provider, persist: keep }),
    ).rejects.toThrow(/ChatGPT Plus\/Pro, Claude Pro\/Max, GitHub Copilot, and SuperGrok/);
  });

  it("runs the anthropic auth-url flow via submitted code", async () => {
    const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://claude.ai/oauth/authorize?code=true",
        instructions: "open",
      });
      const pasted = await interaction.prompt({
        type: "manual_code",
        message: "paste",
      });
      expect(pasted).toBe("pasted-code#state");
      return oauthCred({ access: "claude-access" });
    });
    const started = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: "anthropic",
      persist: keep,
    });
    expect(started.mode).toBe("auth-url");
    expect(started.verificationUri).toContain("claude.ai/oauth/authorize");
    expect("userCode" in started).toBe(false);

    await expect(
      logins.submit(started.loginId, { userId: "other", spaceId: "w" }, "pasted-code#state", keep),
    ).rejects.toThrow(/not found/);
    await expect(
      logins.submit(started.loginId, { userId: "u", spaceId: "w" }, "   ", keep),
    ).rejects.toThrow(/Paste an authorization code/);

    await expect(
      logins.submit(started.loginId, { userId: "u", spaceId: "w" }, "pasted-code#state", keep),
    ).resolves.toEqual({ ok: true });
    await expect(
      logins.submit(started.loginId, { userId: "u", spaceId: "w" }, "pasted-code#state", keep),
    ).resolves.toEqual({ ok: true });

    await flushMicrotasks();
    const done = await logins.complete(started.loginId, { userId: "u", spaceId: "w" });
    expect(done).toEqual({ status: "connected", provider: "anthropic" });
    await expect(logins.finish(started.loginId, { userId: "u", spaceId: "w" })).resolves.toEqual({
      status: "connected",
      value: "claude-access",
      provider: "anthropic",
    });
  });

  it("passes the client's code-page choice to the provider login", async () => {
    const seen: Array<boolean | undefined> = [];
    const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction, options) => {
      seen.push(options?.codePage);
      interaction.notify({
        type: "auth_url",
        url: "https://claude.ai/oauth/authorize?code=true",
        instructions: "open",
      });
      await interaction.prompt({ type: "manual_code", message: "paste" });
      return oauthCred();
    });
    const desktop = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: "anthropic",
      persist: keep,
    });
    await logins.cancel(desktop.loginId, { userId: "u", spaceId: "w" });
    await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: "anthropic",
      codePage: true,
      persist: keep,
    });
    expect(seen).toEqual([undefined, true]);
  });

  it("rejects submit for a login that is not waiting for a code", async () => {
    const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction) => {
      await interaction.prompt({
        type: "select",
        message: "method",
        options: [{ id: "device_code", label: "Device" }],
      });
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://example.com/device",
        expiresInSeconds: 900,
      });
      return new Promise<Credential>(() => undefined);
    });
    const started = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: keep,
    });
    await expect(
      logins.submit(started.loginId, { userId: "u", spaceId: "w" }, "x", keep),
    ).rejects.toThrow(/not waiting for a pasted code/);
    await logins.cancel(started.loginId, { userId: "u", spaceId: "w" });
  });

  it("releases a pending manual-code prompt when the login is cancelled", async () => {
    let promptSettled = false;
    const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://claude.ai/oauth/authorize?code=true",
        instructions: "open",
      });
      try {
        await interaction.prompt({ type: "manual_code", message: "paste" });
      } finally {
        promptSettled = true;
      }
      return oauthCred();
    });
    const started = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: "anthropic",
      persist: keep,
    });

    await logins.cancel(started.loginId, { userId: "u", spaceId: "w" });
    await flushMicrotasks();

    expect(promptSettled).toBe(true);
  });

  it("honors provider cancellation of a manual-code prompt", async () => {
    const promptAbort = new AbortController();
    let promptSettled = false;
    const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://claude.ai/oauth/authorize?code=true",
      });
      try {
        await interaction.prompt({
          type: "manual_code",
          message: "paste",
          signal: promptAbort.signal,
        });
      } finally {
        promptSettled = true;
      }
      return oauthCred();
    });
    const actor = { userId: "u", spaceId: "w" };
    const started = await logins.begin({ ...actor, provider: "anthropic", persist: keep });

    promptAbort.abort(new Error("Callback completed elsewhere"));
    await flushMicrotasks();

    expect(promptSettled).toBe(true);
    await expect(logins.complete(started.loginId, actor)).resolves.toEqual({
      status: "error",
      error: "Callback completed elsewhere",
      provider: "anthropic",
    });
  });

  it("rejects non-HTTPS authorization URLs", async () => {
    const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction) => {
      interaction.notify({ type: "auth_url", url: "javascript:alert(1)" });
      return oauthCred();
    });

    await expect(
      logins.begin({ userId: "u", spaceId: "w", provider: "anthropic", persist: keep }),
    ).rejects.toThrow(/must use HTTPS/);
  });

  it("does not start a login for an already-aborted request", async () => {
    let started = false;
    const logins = new PiOAuthLogins<string>(async () => {
      started = true;
      return oauthCred();
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      logins.begin({
        userId: "u",
        spaceId: "w",
        provider: CHATGPT_OAUTH_PROVIDER,
        signal: controller.signal,
        persist: keep,
      }),
    ).rejects.toBeDefined();
    expect(started).toBe(false);
  });

  it("returns a device code after selecting device_code login", async () => {
    const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction) => {
      const method = await interaction.prompt({
        type: "select",
        message: "method",
        options: [
          { id: "browser", label: "Browser" },
          { id: "device_code", label: "Device" },
        ],
      });
      expect(method).toBe("device_code");
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://auth.openai.com/codex/device",
        expiresInSeconds: 900,
      });
      await new Promise<never>((_, reject) => {
        interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      throw new Error("unreachable");
    });
    const started = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: keep,
    });
    expect(deviceCodeResult(started).userCode).toBe("ABCD-1234");
    expect(started.verificationUri).toContain("auth.openai.com");
    const pending = await logins.complete(started.loginId, { userId: "u", spaceId: "w" });
    expect(pending.status).toBe("pending");
    await logins.abortAll();
  });

  it("saves the credential when the provider sign-in finishes", async () => {
    let finish!: (credential: OAuthCredential) => void;
    const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction) => {
      await interaction.prompt({
        type: "select",
        message: "method",
        options: [{ id: "device_code", label: "Device" }],
      });
      interaction.notify({
        type: "device_code",
        userCode: "ZZZZ",
        verificationUri: "https://auth.openai.com/codex/device",
        expiresInSeconds: 60,
      });
      return new Promise<Credential>((resolve) => {
        finish = (credential) => resolve(credential);
      });
    });
    const saved: PiOAuthConnected[] = [];
    const actor = { userId: "u", spaceId: "w" };
    const started = await logins.begin({
      ...actor,
      provider: CHATGPT_OAUTH_PROVIDER,
      modelId: "gpt-5.4",
      persist: async (login) => {
        saved.push(login);
        return login.credential.access;
      },
    });
    expect(await logins.finish(started.loginId, actor)).toEqual({ status: "pending" });
    finish(oauthCred({ access: "live-access" }));
    await flushMicrotasks();
    expect(saved).toEqual([
      expect.objectContaining({
        provider: CHATGPT_OAUTH_PROVIDER,
        modelId: "gpt-5.4",
        credential: expect.objectContaining({ access: "live-access" }),
      }),
    ]);
    await expect(logins.complete(started.loginId, actor)).resolves.toEqual({
      status: "connected",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    await expect(logins.finish(started.loginId, actor)).resolves.toEqual({
      status: "connected",
      value: "live-access",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    expect((await logins.complete(started.loginId, actor)).status).toBe("error");
  });

  it("only lets the owning user and workspace cancel a login", async () => {
    let aborted = false;
    const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "CANCEL",
        verificationUri: "https://auth.openai.com/codex/device",
      });
      return new Promise<never>((_, reject) => {
        interaction.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    });
    const started = await logins.begin({
      userId: "owner",
      spaceId: "workspace",
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: keep,
    });

    await logins.cancel(started.loginId, { userId: "other", spaceId: "workspace" });
    expect(
      (await logins.complete(started.loginId, { userId: "owner", spaceId: "workspace" })).status,
    ).toBe("pending");

    await logins.cancel(started.loginId, { userId: "owner", spaceId: "workspace" });
    expect(aborted).toBe(true);
    expect(
      (await logins.complete(started.loginId, { userId: "owner", spaceId: "workspace" })).status,
    ).toBe("error");
  });

  it("orders cancellation behind a save under way", async () => {
    const actor = { userId: "owner", spaceId: "workspace" };
    const control = createControlledOAuthLogins();
    const save = gatedPersist();
    const started = await beginControlledOAuth(control, actor, save.persist);
    await save.started;
    expect(save.signals[0]?.aborted).toBe(false);
    await expect(control.logins.finish(started.loginId, actor)).resolves.toEqual({
      status: "pending",
    });

    let cancellationFinished = false;
    const cancelling = control.logins.cancel(started.loginId, actor).then(() => {
      cancellationFinished = true;
    });
    await flushMicrotasks();
    expect(cancellationFinished).toBe(false);
    expect(save.signals[0]?.aborted).toBe(false);

    save.release();
    await cancelling;
    expect(save.saved).toEqual(["access-token"]);
    // Cancel never aborted the save under way; teardown aborts its signal only after.
    expect(save.signals[0]?.aborted).toBe(true);
  });

  it("does not save after cancellation wins", async () => {
    let finishLogin!: (credential: OAuthCredential) => void;
    const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "device_code",
        userCode: "CANCEL-FIRST",
        verificationUri: "https://auth.openai.com/codex/device",
      });
      return new Promise<Credential>((resolve) => {
        finishLogin = resolve;
      });
    });
    const actor = { userId: "owner", spaceId: "workspace" };
    let persisted = false;
    const started = await logins.begin({
      ...actor,
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: async () => {
        persisted = true;
        return "saved";
      },
    });

    await logins.cancel(started.loginId, actor);
    finishLogin(oauthCred());
    await flushMicrotasks();
    expect(persisted).toBe(false);
    await expect(logins.finish(started.loginId, actor)).resolves.toMatchObject({
      status: "error",
    });
  });

  it("reports a failed save as a failed sign-in", async () => {
    const actor = { userId: "owner", spaceId: "workspace" };
    const control = createControlledOAuthLogins();
    const refused = await beginControlledOAuth(control, actor, async () => {
      throw new ModelSignInError("Choose a model this account can use.");
    });
    await flushMicrotasks();
    await expect(control.logins.complete(refused.loginId, actor)).resolves.toEqual({
      status: "error",
      error: "Choose a model this account can use.",
      provider: CHATGPT_OAUTH_PROVIDER,
    });

    const broken = await beginControlledOAuth(
      control,
      actor,
      async () => {
        throw new Error("connection reset with internal details");
      },
      1,
    );
    await flushMicrotasks();
    await expect(control.logins.finish(broken.loginId, actor)).resolves.toEqual({
      status: "error",
      error: "Could not save the sign-in. Try again.",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
  });

  it("does not let another actor read or finish a login", async () => {
    const actor = { userId: "owner", spaceId: "workspace" };
    const control = createControlledOAuthLogins();
    const started = await beginControlledOAuth(control, actor);
    await flushMicrotasks();

    await expect(
      control.logins.finish(started.loginId, { userId: "other", spaceId: "workspace" }),
    ).resolves.toMatchObject({ status: "error" });
    await expect(
      control.logins.finish(started.loginId, { userId: "owner", spaceId: "other-workspace" }),
    ).resolves.toMatchObject({ status: "error" });
    expect((await control.logins.complete(started.loginId, actor)).status).toBe("connected");
  });

  it("keeps a sign-in renewing one connection while another account signs in", async () => {
    const actor = { userId: "owner", spaceId: "workspace" };
    const control = createControlledOAuthLogins();
    const renewing = await control.logins.begin({
      ...actor,
      provider: CHATGPT_OAUTH_PROVIDER,
      credentialId: "personal",
      persist: keep,
    });
    const adding = await control.logins.begin({
      ...actor,
      provider: CHATGPT_OAUTH_PROVIDER,
      credentialId: null,
      persist: keep,
    });

    // Disconnecting the renewed connection leaves the new account's sign-in running.
    await control.logins.cancelProvider({
      userId: actor.userId,
      provider: CHATGPT_OAUTH_PROVIDER,
      credentialId: "personal",
    });
    expect((await control.logins.complete(renewing.loginId, actor)).status).toBe("error");
    expect((await control.logins.complete(adding.loginId, actor)).status).toBe("pending");
    await control.logins.abortAll();
  });

  it("retires a sign-in that named no connection when one connection is disconnected", async () => {
    const actor = { userId: "owner", spaceId: "workspace" };
    const control = createControlledOAuthLogins();
    const legacy = await control.logins.begin({
      ...actor,
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: keep,
    });
    await control.logins.cancelProvider({
      userId: actor.userId,
      provider: CHATGPT_OAUTH_PROVIDER,
      credentialId: "personal",
    });
    expect((await control.logins.complete(legacy.loginId, actor)).status).toBe("error");
    await control.logins.abortAll();
  });

  it("waits for a save under way before starting a replacement", async () => {
    const actor = { userId: "owner", spaceId: "workspace" };
    const control = createControlledOAuthLogins();
    const save = gatedPersist();
    const original = await beginControlledOAuth(control, actor, save.persist);
    await save.started;

    const replacement = control.logins.begin({
      ...actor,
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: keep,
    });
    await flushMicrotasks();
    expect(control.startedCount).toBe(1);

    save.release();
    await expect(replacement).resolves.toMatchObject({ userCode: "CODE-1" });
    expect(save.saved).toEqual(["access-token"]);
    expect(control.startedCount).toBe(2);
    expect((await control.logins.complete(original.loginId, actor)).status).toBe("error");
    await control.logins.abortAll();
  });

  it("starts a replacement after a failed save", async () => {
    const actor = { userId: "owner", spaceId: "workspace" };
    const control = createControlledOAuthLogins();
    const save = gatedPersist();
    const original = await beginControlledOAuth(control, actor, save.persist);
    await save.started;

    const replacement = control.logins.begin({
      ...actor,
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: keep,
    });
    await flushMicrotasks();
    expect(control.startedCount).toBe(1);

    save.release(new Error("persistence failed"));
    await expect(replacement).resolves.toMatchObject({ userCode: "CODE-1" });
    expect(control.startedCount).toBe(2);
    expect((await control.logins.complete(original.loginId, actor)).status).toBe("error");
    await control.logins.abortAll();
  });

  it("serializes concurrent replacements for one workspace scope", async () => {
    const actor = { userId: "owner", spaceId: "workspace" };
    const control = createControlledOAuthLogins();
    const save = gatedPersist();
    await beginControlledOAuth(control, actor, save.persist);
    await save.started;

    const replacementA = control.logins.begin({
      ...actor,
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: keep,
    });
    const replacementB = control.logins.begin({
      ...actor,
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: keep,
    });
    await flushMicrotasks();
    expect(control.startedCount).toBe(1);

    save.release();
    const replacements = await Promise.allSettled([replacementA, replacementB]);
    expect(control.startedCount).toBe(3);
    const fulfilled = replacements.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const active: typeof fulfilled = [];
    for (const replacement of fulfilled) {
      if ((await control.logins.complete(replacement.loginId, actor)).status === "pending") {
        active.push(replacement);
      }
    }
    expect(active).toHaveLength(1);
    await control.logins.abortAll();
  });

  it("does not start an aborted replacement after waiting for a save", async () => {
    const actor = { userId: "owner", spaceId: "workspace" };
    const control = createControlledOAuthLogins();
    const save = gatedPersist();
    await beginControlledOAuth(control, actor, save.persist);
    await save.started;

    const request = new AbortController();
    const replacement = control.logins.begin({
      ...actor,
      provider: CHATGPT_OAUTH_PROVIDER,
      signal: request.signal,
      persist: keep,
    });
    await flushMicrotasks();
    request.abort(new Error("replacement cancelled"));
    save.release();

    await expect(replacement).rejects.toBeDefined();
    expect(control.startedCount).toBe(1);
    await control.logins.abortAll();
  });

  it("keeps replacement scopes isolated by workspace", async () => {
    const ownerWorkspace = { userId: "owner", spaceId: "workspace-a" };
    const otherWorkspace = { userId: "owner", spaceId: "workspace-b" };
    const control = createControlledOAuthLogins();
    const save = gatedPersist();
    const original = await beginControlledOAuth(control, ownerWorkspace, save.persist);
    await save.started;

    const otherWorkspaceLogin = await control.logins.begin({
      ...otherWorkspace,
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: keep,
    });
    expect(deviceCodeResult(otherWorkspaceLogin).userCode).toBe("CODE-1");
    expect(control.startedCount).toBe(2);
    expect((await control.logins.complete(original.loginId, ownerWorkspace)).status).toBe(
      "pending",
    );

    save.release();
    await flushMicrotasks();
    expect((await control.logins.complete(original.loginId, ownerWorkspace)).status).toBe(
      "connected",
    );
    expect(
      (await control.logins.complete(otherWorkspaceLogin.loginId, otherWorkspace)).status,
    ).toBe("pending");
    await control.logins.abortAll();
  });

  it("answers Copilot's enterprise prompt with github.com and returns a device code", async () => {
    const logins = new PiOAuthLogins<string>(async (provider, _type, interaction) => {
      expect(provider).toBe(COPILOT_OAUTH_PROVIDER);
      const host = await interaction.prompt({
        type: "text",
        message: "GitHub Enterprise URL/domain (blank for github.com)",
      });
      expect(host).toBe("");
      interaction.notify({
        type: "device_code",
        userCode: "GH-CODE",
        verificationUri: "https://github.com/login/device",
        expiresInSeconds: 900,
      });
      await new Promise<never>((_, reject) => {
        interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      throw new Error("unreachable");
    });
    const started = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: COPILOT_OAUTH_PROVIDER,
      persist: keep,
    });
    expect(deviceCodeResult(started).userCode).toBe("GH-CODE");
    expect(started.verificationUri).toContain("github.com");
    await logins.abortAll();
  });

  it("returns an xAI device code with no login prompts", async () => {
    const logins = new PiOAuthLogins<string>(async (provider, _type, interaction) => {
      expect(provider).toBe(XAI_OAUTH_PROVIDER);
      interaction.notify({
        type: "device_code",
        userCode: "XAI-CODE",
        verificationUri: "https://auth.x.ai/device",
        expiresInSeconds: 600,
      });
      await new Promise<never>((_, reject) => {
        interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      throw new Error("unreachable");
    });
    const started = await logins.begin({
      userId: "u",
      spaceId: "w",
      provider: XAI_OAUTH_PROVIDER,
      persist: keep,
    });
    expect(deviceCodeResult(started).userCode).toBe("XAI-CODE");
    await logins.abortAll();
  });

  describe("session timers", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function expiringLogins() {
      let startedCount = 0;
      const resolvers: Array<(credential: Credential) => void> = [];
      const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction) => {
        startedCount += 1;
        interaction.notify({
          type: "device_code",
          userCode: `CODE-${startedCount}`,
          verificationUri: "https://auth.openai.com/codex/device",
          expiresInSeconds: 60,
        });
        return new Promise<Credential>((resolve) => resolvers.push(resolve));
      });
      return {
        logins,
        get startedCount() {
          return startedCount;
        },
        resolve: (index: number) => resolvers[index]?.(oauthCred({ access: `access-${index}` })),
      };
    }

    it("expires a sign-in still waiting on the provider", async () => {
      vi.useFakeTimers();
      const { logins } = expiringLogins();
      const actor = { userId: "u", spaceId: "w" };
      const started = await logins.begin({
        ...actor,
        provider: CHATGPT_OAUTH_PROVIDER,
        persist: keep,
      });

      vi.advanceTimersByTime(61_000);
      expect((await logins.complete(started.loginId, actor)).status).toBe("error");
    });

    it("keeps a saving sign-in when expiry elapses so a replacement cannot overwrite it", async () => {
      vi.useFakeTimers();
      const actor = { userId: "u", spaceId: "w" };
      const control = expiringLogins();
      const save = gatedPersist();
      const started = await control.logins.begin({
        ...actor,
        provider: CHATGPT_OAUTH_PROVIDER,
        persist: save.persist,
      });
      control.resolve(0);
      await save.started;

      vi.advanceTimersByTime(61_000);
      expect((await control.logins.complete(started.loginId, actor)).status).toBe("pending");

      const replacement = control.logins.begin({
        ...actor,
        provider: CHATGPT_OAUTH_PROVIDER,
        persist: keep,
      });
      await flushMicrotasks();
      expect(control.startedCount).toBe(1);

      save.release();
      await expect(replacement).resolves.toMatchObject({ userCode: "CODE-2" });
      // The expiry did not abort the save, and the replacement started after it.
      expect(save.saved).toEqual(["access-0"]);
      expect(control.startedCount).toBe(2);
      await control.logins.abortAll();
    });

    it("clears armed expiry timers when abortAll runs", async () => {
      vi.useFakeTimers();
      const control = createControlledOAuthLogins();
      await control.logins.begin({
        userId: "u",
        spaceId: "w",
        provider: CHATGPT_OAUTH_PROVIDER,
        persist: keep,
      });
      const armed = vi.getTimerCount();
      expect(armed).toBeGreaterThan(0);

      await control.logins.abortAll();
      expect(vi.getTimerCount()).toBe(armed - 1);
    });
  });
});

it("redacts long custom header secrets without corrupting short routing values", () => {
  const secrets = secretValuesToRedact({
    kind: "openai_compatible",
    baseUrl: "https://example.invalid/v1",
    headers: { "x-region": "us", "x-session": "long-session-secret" },
  });
  expect(redactSecrets("Tell us: long-session-secret", secrets)).toBe("Tell us: [redacted]");
  expect(containsSecret("Tell us", secrets)).toBe(false);
  expect(secrets).toEqual(["long-session-secret"]);
});

describe("PiOAuthLogins across API processes", () => {
  type Row = {
    id: string;
    spaceId: string;
    userId: string;
    provider: string;
    scope: string;
    ciphertext: string | null;
    status: string;
    error: string | null;
    result: unknown;
    leaseExpiresAt: Date | null;
    createdAt: Date;
  };
  type HandoffStore = ConstructorParameters<typeof PiOAuthLogins>[1];

  /** Prisma's filter shapes the sign-in store uses, over rows in memory. */
  function satisfies(value: unknown, condition: unknown): boolean {
    if (condition === undefined) return true;
    if (condition === null) return value === null || value === undefined;
    if (typeof condition !== "object" || condition instanceof Date) return value === condition;
    const filter = condition as {
      not?: unknown;
      in?: unknown[];
      endsWith?: string;
      gt?: Date;
      gte?: Date;
      lt?: Date;
    };
    if ("not" in filter && value === filter.not) return false;
    if (filter.in && !filter.in.includes(value)) return false;
    if (filter.endsWith !== undefined && !String(value).endsWith(filter.endsWith)) return false;
    if (filter.gt && !(value instanceof Date && value > filter.gt)) return false;
    if (filter.gte && !(value instanceof Date && value >= filter.gte)) return false;
    if (filter.lt && !(value instanceof Date && value < filter.lt)) return false;
    return true;
  }

  function handoffStore() {
    const rows = new Map<string, Row>();
    let clock = Date.now();
    const matching = (where: Record<string, unknown>) =>
      [...rows.values()].filter((row) =>
        Object.entries(where).every(([key, condition]) =>
          satisfies(row[key as keyof Row], condition),
        ),
      );
    const prisma = {
      modelOAuthSession: {
        create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
          clock += 1;
          const row = {
            ciphertext: null,
            status: "pending",
            error: null,
            result: null,
            leaseExpiresAt: null,
            ...data,
            createdAt: new Date(clock),
          } as Row;
          rows.set(row.id, row);
          return row;
        }),
        findFirst: vi.fn(
          async ({ where }: { where: Record<string, unknown> }) => matching(where)[0] ?? null,
        ),
        updateMany: vi.fn(
          async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
            const found = matching(where);
            for (const row of found) Object.assign(row, data);
            return { count: found.length };
          },
        ),
        deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          const found = matching(where);
          for (const row of found) rows.delete(row.id);
          return { count: found.length };
        }),
      },
    };
    // Reversible stand-in for the secret store's encryption.
    const secrets = {
      put: vi.fn(async (plaintext: string) => ({
        id: "s",
        ref: "s",
        ciphertext: `sealed:${Buffer.from(plaintext).toString("base64")}`,
      })),
      load: vi.fn(async (ciphertext: string) =>
        Buffer.from(ciphertext.slice("sealed:".length), "base64").toString(),
      ),
    };
    return { rows, store: { prisma, secrets } as unknown as HandoffStore, secrets };
  }

  /** One API process with a pasted-code provider: its own memory, the shared store. */
  function apiProcess(store: HandoffStore) {
    const seen: Array<{ verifier?: string; code: string }> = [];
    const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction, options) => {
      interaction.notify({
        type: "auth_url",
        url: "https://claude.ai/oauth/authorize?code=true",
        instructions: "open",
      });
      const code = await interaction.prompt({ type: "manual_code", message: "paste" });
      seen.push({ verifier: options?.verifier, code });
      return oauthCred({ access: `exchanged-${code}` });
    }, store);
    return { logins, seen };
  }

  /** One API process with a device-code provider the test answers. */
  function deviceCodeProcess(store: HandoffStore) {
    let answerWith!: (credential: Credential) => void;
    const answered = new Promise<Credential>((resolve) => {
      answerWith = resolve;
    });
    let signal: AbortSignal | undefined;
    const logins = new PiOAuthLogins<string>(async (_provider, _type, interaction) => {
      signal = interaction.signal;
      interaction.notify({
        type: "device_code",
        userCode: "CODE",
        verificationUri: "https://auth.openai.com/codex/device",
      });
      return new Promise<Credential>((resolve, reject) => {
        void answered.then(resolve);
        interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    }, store);
    return {
      logins,
      answer: (credential: Credential = oauthCred()) => answerWith(credential),
      get stopped() {
        return signal?.aborted === true;
      },
    };
  }

  const member = { userId: "u", spaceId: "w" };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finishes a sign-in on the API process that receives the code", async () => {
    const { rows, store, secrets } = handoffStore();
    const before = apiProcess(store);
    const started = await before.logins.begin({
      ...member,
      provider: "anthropic",
      modelId: "claude-model",
      label: "Claude",
      codePage: true,
      persist: keep,
    });
    const row = rows.get(started.loginId);
    expect(row).toMatchObject({ ...member, provider: "anthropic", leaseExpiresAt: null });
    expect(secrets.put).toHaveBeenCalledWith(expect.any(String), expect.anything(), {
      recordId: started.loginId,
      ephemeral: true,
    });
    // A deploy replaces the process that started the sign-in.
    await before.logins.abortAll();
    expect(rows.get(started.loginId)?.status).toBe("pending");

    const after = apiProcess(store);
    const saved: PiOAuthConnected[] = [];
    await expect(
      after.logins.submit(started.loginId, member, "the-code", async (login) => {
        saved.push(login);
        return login.credential.access;
      }),
    ).resolves.toEqual({ ok: true });
    await flushMicrotasks();
    const stored = JSON.parse(await secrets.load(row?.ciphertext ?? "")) as { verifier: string };
    expect(stored.verifier).toEqual(expect.any(String));
    expect(after.seen).toEqual([{ verifier: stored.verifier, code: "the-code" }]);
    expect(saved).toEqual([
      expect.objectContaining({ provider: "anthropic", modelId: "claude-model", label: "Claude" }),
    ]);

    // Any process reports and finishes it.
    const elsewhere = apiProcess(store);
    await expect(elsewhere.logins.complete(started.loginId, member)).resolves.toEqual({
      status: "connected",
      provider: "anthropic",
    });
    await expect(elsewhere.logins.finish(started.loginId, member)).resolves.toEqual({
      status: "connected",
      value: "exchanged-the-code",
      provider: "anthropic",
    });
    expect(rows.size).toBe(0);
    await expect(
      apiProcess(store).logins.submit(started.loginId, member, "the-code", keep),
    ).rejects.toThrow(/not found/);
  });

  it("only hands a sign-in to the member who started it", async () => {
    const { rows, store } = handoffStore();
    const started = await apiProcess(store).logins.begin({
      ...member,
      provider: "anthropic",
      persist: keep,
    });
    const other = apiProcess(store);
    await expect(
      other.logins.submit(started.loginId, { userId: "other", spaceId: "w" }, "the-code", keep),
    ).rejects.toThrow(/not found/);
    await expect(
      other.logins.submit(started.loginId, { userId: "u", spaceId: "other" }, "the-code", keep),
    ).rejects.toThrow(/not found/);
    await expect(
      other.logins.complete(started.loginId, { userId: "other", spaceId: "w" }),
    ).resolves.toMatchObject({ status: "error" });
    expect(rows.get(started.loginId)?.leaseExpiresAt).toBeNull();
    expect(other.seen).toEqual([]);
  });

  it("queries the hand-off by owner columns when the caller passes its whole actor", async () => {
    const { store } = handoffStore();
    const started = await apiProcess(store).logins.begin({
      ...member,
      provider: "anthropic",
      persist: keep,
    });
    const actor = { ...member, email: "member@example.test", isDeploymentOwner: false };
    await expect(
      apiProcess(store).logins.submit(started.loginId, actor, "the-code", keep),
    ).resolves.toEqual({ ok: true });
    expect(store?.prisma.modelOAuthSession.findFirst).toHaveBeenCalledWith({
      where: {
        id: started.loginId,
        ...member,
        status: "pending",
        leaseExpiresAt: null,
        createdAt: { gte: expect.any(Date) },
      },
      select: { ciphertext: true },
    });
  });

  it("does not resume an expired sign-in", async () => {
    const { rows, store } = handoffStore();
    const started = await apiProcess(store).logins.begin({
      ...member,
      provider: "anthropic",
      persist: keep,
    });
    const row = rows.get(started.loginId);
    if (row) row.createdAt = new Date(Date.now() - 16 * 60_000);
    const after = apiProcess(store);
    await expect(after.logins.submit(started.loginId, member, "the-code", keep)).rejects.toThrow(
      /not found/,
    );
    expect(after.seen).toEqual([]);
  });

  it("lets one process take the code, and drops the sign-in when cancelled or disconnected", async () => {
    const { rows, store } = handoffStore();
    const local = apiProcess(store);
    const submitted = await local.logins.begin({ ...member, provider: "anthropic", persist: keep });
    await local.logins.submit(submitted.loginId, member, "the-code", keep);
    // Taken: no other process may resume it with the stored verifier.
    const other = apiProcess(store);
    await expect(other.logins.submit(submitted.loginId, member, "the-code", keep)).rejects.toThrow(
      /not found/,
    );
    await flushMicrotasks();
    expect(rows.get(submitted.loginId)?.status).toBe("connected");
    expect(other.seen).toEqual([]);

    const cancelled = await local.logins.begin({ ...member, provider: "anthropic", persist: keep });
    await local.logins.cancel(cancelled.loginId, member);
    await flushMicrotasks();
    expect(rows.has(cancelled.loginId)).toBe(false);

    const elsewhere = await apiProcess(store).logins.begin({
      ...member,
      provider: "anthropic",
      persist: keep,
    });
    await local.logins.cancelProvider({ userId: "u", provider: "anthropic" });
    expect(rows.has(elsewhere.loginId)).toBe(false);
  });

  it("cancels a sign-in another process started", async () => {
    const { rows, store } = handoffStore();
    const started = await apiProcess(store).logins.begin({
      ...member,
      provider: "anthropic",
      persist: keep,
    });
    const after = apiProcess(store);
    await after.logins.cancel(started.loginId, member);
    expect(rows.has(started.loginId)).toBe(false);
    await expect(after.logins.submit(started.loginId, member, "the-code", keep)).rejects.toThrow(
      /not found/,
    );
  });

  it("does not let an older sign-in's code replace a newer one", async () => {
    const { rows, store } = handoffStore();
    const older = await apiProcess(store).logins.begin({
      ...member,
      provider: "anthropic",
      persist: keep,
    });
    const after = apiProcess(store);
    const newer = await after.logins.begin({ ...member, provider: "anthropic", persist: keep });
    expect(rows.has(older.loginId)).toBe(false);
    await expect(after.logins.submit(older.loginId, member, "old-code", keep)).rejects.toThrow(
      /not found/,
    );
    await expect(after.logins.submit(newer.loginId, member, "new-code", keep)).resolves.toEqual({
      ok: true,
    });
  });

  it("keeps a sign-in for another connection when a new one starts", async () => {
    const { rows, store } = handoffStore();
    const renewing = await apiProcess(store).logins.begin({
      ...member,
      provider: "anthropic",
      credentialId: "connection-a",
      persist: keep,
    });
    const adding = await apiProcess(store).logins.begin({
      ...member,
      provider: "anthropic",
      credentialId: null,
      persist: keep,
    });
    expect(rows.has(renewing.loginId)).toBe(true);
    expect(rows.has(adding.loginId)).toBe(true);
  });

  it("reports a device-code sign-in that finished on another process", async () => {
    const { rows, store } = handoffStore();
    const a = deviceCodeProcess(store);
    const b = deviceCodeProcess(store);
    const started = await a.logins.begin({
      ...member,
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: keep,
    });
    expect(rows.get(started.loginId)?.leaseExpiresAt).toEqual(expect.any(Date));
    await expect(b.logins.complete(started.loginId, member)).resolves.toEqual({
      status: "pending",
    });

    a.answer(oauthCred({ access: "device-access" }));
    await flushMicrotasks();
    await expect(b.logins.complete(started.loginId, member)).resolves.toEqual({
      status: "connected",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    await expect(b.logins.finish(started.loginId, member)).resolves.toEqual({
      status: "connected",
      value: "device-access",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    expect(rows.size).toBe(0);
    await a.logins.abortAll();
  });

  it("stops a device-code sign-in cancelled on another process", async () => {
    vi.useFakeTimers();
    const { rows, store } = handoffStore();
    const a = deviceCodeProcess(store);
    const started = await a.logins.begin({
      ...member,
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: keep,
    });

    await deviceCodeProcess(store).logins.cancel(started.loginId, member);
    expect(rows.has(started.loginId)).toBe(false);
    expect(a.stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(SIGN_IN_LEASE_RENEW_MS);
    expect(a.stopped).toBe(true);
  });

  it("does not save a sign-in cancelled elsewhere before its owner noticed", async () => {
    const { store } = handoffStore();
    const a = deviceCodeProcess(store);
    let saved = false;
    const started = await a.logins.begin({
      ...member,
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: async () => {
        saved = true;
        return "saved";
      },
    });
    await deviceCodeProcess(store).logins.cancel(started.loginId, member);
    a.answer();
    await flushMicrotasks();
    expect(saved).toBe(false);
    expect(a.stopped).toBe(true);
  });

  it("reports a sign-in whose process went away as interrupted", async () => {
    const { rows, store } = handoffStore();
    const b = deviceCodeProcess(store);

    // Shut down: it says so at once.
    const drained = deviceCodeProcess(store);
    const first = await drained.logins.begin({
      ...member,
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: keep,
    });
    await drained.logins.abortAll();
    await expect(b.logins.complete(first.loginId, member)).resolves.toEqual({
      status: "error",
      error: "Sign-in was interrupted. Start sign-in again.",
      provider: CHATGPT_OAUTH_PROVIDER,
    });

    // Crashed: its lease lapses.
    const crashed = deviceCodeProcess(store);
    const second = await crashed.logins.begin({
      ...member,
      provider: COPILOT_OAUTH_PROVIDER,
      persist: keep,
    });
    await expect(b.logins.complete(second.loginId, member)).resolves.toEqual({
      status: "pending",
    });
    const row = rows.get(second.loginId);
    if (row) row.leaseExpiresAt = new Date(Date.now() - 1);
    await expect(b.logins.complete(second.loginId, member)).resolves.toEqual({
      status: "error",
      error: "Sign-in was interrupted. Start sign-in again.",
      provider: COPILOT_OAUTH_PROVIDER,
    });
    await crashed.logins.abortAll();
  });

  it("lets a save under way on another process land before a disconnect", async () => {
    const { rows, store } = handoffStore();
    const a = deviceCodeProcess(store);
    const save = gatedPersist();
    const started = await a.logins.begin({
      ...member,
      provider: CHATGPT_OAUTH_PROVIDER,
      credentialId: "personal",
      persist: save.persist,
    });
    a.answer();
    await save.started;
    expect(rows.get(started.loginId)?.status).toBe("saving");

    let disconnected = false;
    const disconnecting = deviceCodeProcess(store)
      .logins.cancelProvider({
        userId: "u",
        provider: CHATGPT_OAUTH_PROVIDER,
        credentialId: "personal",
      })
      .then(() => {
        disconnected = true;
      });
    await flushMicrotasks();
    expect(disconnected).toBe(false);
    save.release();
    await disconnecting;
    expect(save.saved).toEqual(["access-token"]);
  });

  it("drops an expired device-code sign-in at once on every process", async () => {
    vi.useFakeTimers();
    const { rows, store } = handoffStore();
    const a = deviceCodeProcess(store);
    const started = await a.logins.begin({
      ...member,
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: keep,
    });
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
    expect(a.stopped).toBe(true);
    expect(rows.has(started.loginId)).toBe(false);
    await expect(
      deviceCodeProcess(store).logins.complete(started.loginId, member),
    ).resolves.toMatchObject({ status: "error", error: expect.stringMatching(/not found/) });
  });

  it("lets a save under way finish before shutdown completes", async () => {
    const { rows, store } = handoffStore();
    const a = deviceCodeProcess(store);
    const save = gatedPersist();
    const started = await a.logins.begin({
      ...member,
      provider: CHATGPT_OAUTH_PROVIDER,
      persist: save.persist,
    });
    a.answer();
    await save.started;

    let shutDown = false;
    const shuttingDown = a.logins.abortAll().then(() => {
      shutDown = true;
    });
    await flushMicrotasks();
    expect(shutDown).toBe(false);
    expect(save.signals[0]?.aborted).toBe(false);
    save.release();
    await shuttingDown;
    expect(rows.get(started.loginId)?.status).toBe("connected");
  });

  it("leaves another connection's sign-in running when one connection is disconnected", async () => {
    const { rows, store } = handoffStore();
    const a = deviceCodeProcess(store);
    const adding = await a.logins.begin({
      ...member,
      provider: CHATGPT_OAUTH_PROVIDER,
      credentialId: null,
      persist: keep,
    });
    await deviceCodeProcess(store).logins.cancelProvider({
      userId: "u",
      provider: CHATGPT_OAUTH_PROVIDER,
      credentialId: "personal",
    });
    expect(rows.has(adding.loginId)).toBe(true);
    await a.logins.abortAll();
  });
});
