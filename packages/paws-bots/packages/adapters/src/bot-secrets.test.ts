import type { BotSecretDestination } from "@rakazo/contracts";
import { BOT_SECRET_ORIGIN_MISSING_MESSAGE, encodeLoginSecret } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { installAuditEventStore } from "@rakazo/db";
import * as Logging from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_ALREADY_TYPED,
  cardRedactionForms,
  credentialArgument,
  encodeRunCode,
  encodeRunLogin,
  forgetBotSecret,
  LOGIN_CODE_REPEAT_WINDOW_MS,
  LOGIN_CODE_TRIES,
  LOGIN_CODES_USED_UP,
  LOGIN_REMOVED,
  LOGIN_VALUE_CHANGED,
  linkHeaderEntries,
  listBotSecrets,
  loadLoginPasswordRedactions,
  loadRunCodeRedactions,
  loadRunLoginRedactions,
  loginCodeClaim,
  normalizeSecretDestination,
  oneTimeCodeArgument,
  oneTimeCodeRedactions,
  prepareBotSecret,
  relabelVaultItem,
  requestWithBotSecret,
  resolveCodeFill,
  resolveLoginFill,
  resolveRequestSecretDestination,
  responsePaging,
  sameSecretDestination,
  storeBotSecret,
} from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import { recordVaultUse } from "./run-context.js";
import { secretTools } from "./run-tools-secrets.js";
import { EncryptedSecretStore } from "./secrets.js";

// RFC 6238's test key, written in pieces so it never reads as a saved secret.
const TEST_KEY = ("GEZDGNBV" + "GY3TQOJQ").repeat(2);
const OTHER_TEST_KEY = "MFRGGZDF" + "MZTWQ2LK" + "NNWG23TP" + "OBYXE43U";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  installAuditEventStore(undefined);
});

const scope = { userId: "user-1", spaceId: "space-1" };
// These rows sit in the Space's own vault, so lookups match their spaceId.
const ownVault = { findUnique: vi.fn(async () => ({ setting: "credentials" })) };
const destination: BotSecretDestination = {
  name: "example_api",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const secret = "fake-key-with+/special=characters";
const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

async function fixture(auth = destination.auth) {
  const encrypted = await secretStore.put(
    secret,
    {
      ...scope,
      operationId: "test",
      traceId: "test",
      signal: new AbortController().signal,
    },
    { recordId: "secret-1" },
  );
  const row = { ...scope, ...destination, auth, ...encrypted };
  const findFirst = vi.fn(async ({ where }) =>
    Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)
      ? row
      : null,
  );
  const prisma = {
    spaceSettingOverride: ownVault,
    vaultCredential: { findFirst },
    secret: { findFirst: vi.fn(async () => null) },
  } as unknown as PrismaClient;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
  const registerRedactions = vi.fn();
  const input = {
    prisma,
    secretStore,
    scope,
    request: { name: destination.name, url: `${destination.origin}/v1/items` },
    signal: new AbortController().signal,
    remote: { fetch, resolveHostname: publicResolver },
    registerRedactions,
  };
  return { input, fetch, findFirst, registerRedactions };
}

describe("authenticated secret requests", () => {
  it("retries failed audit inserts before deduplicating a use", async () => {
    const createMany = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ count: 1 });
    installAuditEventStore({
      auditEvent: { createMany },
      space: { findUnique: async () => ({ organizationId: "org-1", name: "Home" }) },
      member: { findUnique: async () => ({ role: "owner" }) },
    } as never);
    const ctx = {
      bot: { id: "bot-1", name: "Bot" },
      run: { userId: "owner", spaceId: "space-1" },
      runId: "run-1",
      thread: { id: "thread-1" },
      state: { vaultUses: new Set<string>() },
    };
    const item = { id: "item-1", name: "login", spaceId: null, kind: "login" };
    await recordVaultUse(ctx as never, "browser_act", item, "https://example.test");
    expect(ctx.state.vaultUses.size).toBe(0);
    await recordVaultUse(ctx as never, "browser_act", item, "https://example.test");
    await recordVaultUse(ctx as never, "browser_act", item, "https://example.test");
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(ctx.state.vaultUses.size).toBe(1);
    await recordVaultUse(ctx as never, "browser_act", item, "https://other.example.test");
    expect(createMany).toHaveBeenCalledTimes(3);
  });

  it("records when the vault gives the run a saved key, once per attempt", async () => {
    const { input, fetch } = await fixture();
    const rows: Array<Record<string, unknown>> = [];
    installAuditEventStore({
      auditEvent: { createMany: async ({ data }: { data: typeof rows }) => rows.push(...data) },
      space: { findUnique: async () => ({ organizationId: "org-1", name: "Home" }) },
      member: { findUnique: async () => ({ role: "owner" }) },
    } as never);
    const ctx = {
      deps: { prisma: input.prisma, secretStore, secretHttp: input.remote },
      run: { ...scope, id: "run-1" },
      runId: "run-1",
      bot: { id: "bot-1", name: "Research bot" },
      thread: { id: "thread-1" },
      context: { signal: input.signal },
      secrets: [] as string[],
      state: {
        vaultUses: new Set<string>(),
        reply: { pendingProgress: "", redactor: { finish: () => "" } },
      },
    };
    const send = (url = `${destination.origin}/v1/items`) =>
      secretTools.secret_request!(
        ctx as never,
        {
          name: "secret_request",
          args: { name: destination.name, url },
          finish: async (result: unknown) => result,
        } as never,
      );
    // Another site never gets the key.
    expect(await send("https://other.example.test/v1/items")).toHaveProperty("error");
    expect(rows).toEqual([]);
    // Nor does a site whose address is refused before anything is sent: the key never left.
    const { resolveHostname } = input.remote;
    input.remote.resolveHostname = async () => [{ address: "169.254.169.254", family: 4 }];
    expect(await send()).toHaveProperty("error");
    input.remote.resolveHostname = resolveHostname;
    expect(rows).toEqual([]);
    // Once the request went out it is a use, even with no answer back; a second request in the
    // attempt isn't recorded again, and a new attempt is, even a redirect the request refuses.
    fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await send()).toHaveProperty("error");
    expect(rows).toHaveLength(1);
    expect(await send()).toMatchObject({ status: 200 });
    expect(rows).toHaveLength(1);
    ctx.state.vaultUses.clear();
    fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/" } }));
    expect(await send()).toHaveProperty("error");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(rows).toEqual(
      [1, 2].map(() =>
        expect.objectContaining({
          action: "credential.used",
          actorType: "bot",
          actorId: "bot-1",
          targetType: "vault_credential",
          targetId: "secret-1",
          targetLabel: destination.name,
          runId: "run-1",
          threadId: "thread-1",
          metadata: {
            tool: "secret_request",
            scope: "space",
            name: destination.name,
            kind: "bearer",
            site: destination.origin,
          },
        }),
      ),
    );
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it("records a guest's use of a Space vault item only in the Space, unnamed", async () => {
    const { input } = await fixture();
    const rows: Array<Record<string, unknown>> = [];
    // space-1 belongs to org-1 and keeps its own vault, where the run's person keeps the item.
    // They are first its owner, then a guest whose own organization is org-2, which gets nothing
    // of it. The audit-events table covers every actor, vault and event.
    let role = "owner";
    installAuditEventStore({
      auditEvent: { createMany: async ({ data }: { data: typeof rows }) => rows.push(...data) },
      space: { findUnique: async () => ({ organizationId: "org-1", name: "Home" }) },
      member: {
        findUnique: async () => ({ role }),
        findMany: async () => [{ organizationId: "org-2", role: "owner" }],
      },
    } as never);
    for (const as of ["owner", "guest"]) {
      role = as;
      const ctx = {
        deps: { prisma: input.prisma, secretStore, secretHttp: input.remote },
        run: { ...scope, id: "run-1" },
        runId: "run-1",
        bot: { id: "bot-1", name: "Research bot" },
        thread: { id: "thread-1" },
        context: { signal: input.signal },
        secrets: [] as string[],
        state: {
          vaultUses: new Set<string>(),
          reply: { pendingProgress: "", redactor: { finish: () => "" } },
        },
      };
      await secretTools.secret_request!(
        ctx as never,
        {
          name: "secret_request",
          args: { name: destination.name, url: `${destination.origin}/v1/items` },
          finish: async (result: unknown) => result,
        } as never,
      );
    }
    expect(rows.map((row) => [row.organizationId, row.targetLabel])).toEqual([
      ["org-1", destination.name],
      ["org-1", null],
    ]);
    expect(JSON.stringify(rows[1])).not.toContain(destination.name);
  });

  it("starts the request deadline before loading the credential", async () => {
    const { input, fetch } = await fixture();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let credentialSignal: AbortSignal | undefined;
    const load = vi.spyOn(secretStore, "load").mockImplementationOnce(async (_ref, context) => {
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(typeof context).toBe("object");
      if (typeof context === "string") throw new Error("Missing signal");
      expect(context.signal).not.toBe(input.signal);
      credentialSignal = context.signal;
      return secret;
    });
    try {
      await requestWithBotSecret(input);
      expect(fetch.mock.calls[0]?.[1]?.signal).toBe(credentialSignal);
    } finally {
      load.mockRestore();
      timeout.mockRestore();
    }
  });
  it.each([
    [{ type: "bearer" }, "Authorization", `Bearer ${secret}`],
    [{ type: "header", name: "X-Api-Key" }, "X-Api-Key", secret],
    [
      { type: "basic", username: "api-user" },
      "Authorization",
      `Basic ${Buffer.from(`api-user:${secret}`).toString("base64")}`,
    ],
  ] as const)(
    "injects %j only in backend headers and redacts response echoes",
    async (auth, header, value) => {
      const { input, fetch, registerRedactions } = await fixture(auth);
      fetch.mockImplementation(async (_url, init) => {
        expect(new Headers(init?.headers).get(header)).toBe(value);
        expect(init?.redirect).toBe("manual");
        return Response.json({
          [secret]: [
            secret,
            value,
            encodeURIComponent(secret),
            Buffer.from(secret).toString("base64"),
          ],
          items: [1, 2],
        });
      });
      const result = await requestWithBotSecret(input);
      expect(result).toMatchObject({ status: 200, body: { items: [1, 2] }, truncated: false });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(value);
      expect(JSON.stringify(result)).not.toContain(encodeURIComponent(secret));
      expect(registerRedactions).toHaveBeenCalledWith(expect.arrayContaining([secret, value]));
    },
  );

  it.each(["userId", "spaceId"] as const)(
    "denies a different %s before decrypting or sending",
    async (key) => {
      const { input, fetch } = await fixture();
      const load = vi.spyOn(secretStore, "load");
      try {
        expect(
          await requestWithBotSecret({ ...input, scope: { ...scope, [key]: "other" } }),
        ).toMatchObject({ error: expect.any(String) });
        expect(load).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        load.mockRestore();
      }
    },
  );

  it.each([
    "https://other.example.test/v1",
    "http://api.example.test/v1",
    "https://api.example.test:8443/v1",
    "https://api.example.test.evil.test/v1",
    "https://user:password@api.example.test/v1",
    "https://api.example.test/v1#fragment",
  ])("rejects destination %s", async (url) => {
    const { input, fetch } = await fixture();
    expect(
      await requestWithBotSecret({ ...input, request: { ...input.request, url } }),
    ).toMatchObject({ error: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects private DNS answers without issuing a request", async () => {
    const { input, fetch } = await fixture();
    input.remote.resolveHostname = async () => [{ address: "169.254.169.254", family: 4 }];
    expect(await requestWithBotSecret(input)).toMatchObject({ error: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never follows redirects, including same-origin redirects", async () => {
    const { input, fetch } = await fixture();
    fetch.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: `${destination.origin}/redirected` },
      }),
    );
    expect(await requestWithBotSecret(input)).toMatchObject({ error: expect.any(String) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not expose exception text or response headers", async () => {
    const { input, fetch } = await fixture();
    fetch.mockRejectedValueOnce(new Error(secret));
    expect(JSON.stringify(await requestWithBotSecret(input))).not.toContain(secret);
    fetch.mockResolvedValueOnce(new Response("ok", { headers: { "X-Echo": secret } }));
    expect(await requestWithBotSecret(input)).toEqual({
      status: 200,
      body: "ok",
      truncated: false,
    });
  });

  it("returns where the next page is, redacted", async () => {
    const { input, fetch } = await fixture();
    const page = (n: number) => `${destination.origin}/api/v1/courses?page=${n}&per_page=10`;
    fetch.mockResolvedValueOnce(
      new Response("[]", {
        headers: {
          Link: `<${page(1)}>; rel="current",<${page(2)}>; rel="next",<${page(1)}>; rel="first", <${page(5)}&k=${secret}>; rel=last`,
          "X-Total-Count": "42",
          "X-Echo": secret,
        },
      }),
    );
    const result = await requestWithBotSecret(input);
    expect(result).toMatchObject({ status: 200, truncated: false });
    // A link that carries the credential is left out, not returned with it replaced.
    expect(result).toHaveProperty("links", { current: page(1), next: page(2), first: page(1) });
    expect(result).toHaveProperty("headers", { "x-total-count": "42" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("x-echo");
  });

  it("leaves out links and headers echoing the credential in another case or escape", async () => {
    const { input, fetch } = await fixture();
    const page = (n: number) => `${destination.origin}/api/v1/courses?page=${n}`;
    const lowerEscaped = encodeURIComponent(secret).toLowerCase();
    fetch.mockResolvedValueOnce(
      new Response("[]", {
        headers: {
          Link: `<${page(2)}>; rel=next, <${page(5)}&k=${lowerEscaped}>; rel=last, <${page(4)}&k=${encodeURIComponent(lowerEscaped)}>; rel=prev`,
          "X-Next-Page": secret.toUpperCase(),
          "X-Total": "40",
        },
      }),
    );
    const result = await requestWithBotSecret(input);
    expect(result).toHaveProperty("links", { next: page(2) });
    expect(result).toHaveProperty("headers", { "x-total": "40" });
    const text = JSON.stringify(result).toLowerCase();
    expect(text).not.toContain(lowerEscaped);
    expect(text).not.toContain(secret.toLowerCase());
  });

  it("leaves out a relation whose URI carries the credential", async () => {
    const { input, fetch } = await fixture();
    const page = `${destination.origin}/api/v1/courses?page=2`;
    const lowerEscaped = encodeURIComponent(secret).toLowerCase();
    fetch.mockResolvedValueOnce(
      new Response("[]", {
        headers: { Link: `<${page}>; rel="next https://rel.example.test/${lowerEscaped}"` },
      }),
    );
    const result = await requestWithBotSecret(input);
    expect(result).toHaveProperty("links", { next: page });
    expect(JSON.stringify(result).toLowerCase()).not.toContain(lowerEscaped);
  });

  it("redacts before truncating and bounds the response body", async () => {
    const { input, fetch } = await fixture();
    fetch.mockResolvedValueOnce(new Response("x".repeat(19_990) + secret));
    const result = await requestWithBotSecret(input);
    expect(result).toMatchObject({ truncated: true });
    expect(JSON.stringify(result)).not.toContain("fake-key");
    fetch.mockResolvedValueOnce(new Response("x".repeat(1_000_001)));
    expect(await requestWithBotSecret(input)).toMatchObject({ error: expect.any(String) });
  });

  it("cancels a stalled response body", async () => {
    const { input, fetch } = await fixture();
    const controller = new AbortController();
    const cancel = vi.fn();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const pending = requestWithBotSecret({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    expect(await pending).toMatchObject({ error: expect.any(String) });
    expect(cancel).toHaveBeenCalled();
  });

  it("records a key that may have left, once, and none refused before sending", async () => {
    const { input, fetch } = await fixture();
    const recordUse = vi.fn(async () => {});
    // Cancelled while the destination is still being checked: nothing is sent, then or after.
    const early = new AbortController();
    let checked = (_addresses: { address: string; family: 4 }[]) => {};
    const resolveHostname = vi.fn(
      () => new Promise<{ address: string; family: 4 }[]>((resolve) => (checked = resolve)),
    );
    const checking = requestWithBotSecret({
      ...input,
      recordUse,
      signal: early.signal,
      remote: { ...input.remote, resolveHostname },
    });
    await vi.waitFor(() => expect(resolveHostname).toHaveBeenCalled());
    early.abort();
    expect(await checking).toHaveProperty("error");
    checked([{ address: "203.0.113.10", family: 4 }]);
    await new Promise((resolve) => setTimeout(resolve));
    expect(recordUse).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    // Cancelled while the request is out, with no answer yet.
    const controller = new AbortController();
    fetch.mockImplementationOnce(
      (_url, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    );
    const pending = requestWithBotSecret({ ...input, recordUse, signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort();
    expect(await pending).toHaveProperty("error");
    expect(recordUse).toHaveBeenCalledOnce();
    // Answered, then cancelled while its body is read: still one use.
    const stalled = new AbortController();
    fetch.mockResolvedValueOnce(new Response(new ReadableStream()));
    const reading = requestWithBotSecret({ ...input, recordUse, signal: stalled.signal });
    await vi.waitFor(() => expect(recordUse).toHaveBeenCalledTimes(2));
    stalled.abort();
    expect(await reading).toHaveProperty("error");
    expect(recordUse).toHaveBeenCalledTimes(2);
    // An owner's private destination: a redirect is its answer; one resolving publicly is
    // refused before anything is sent.
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const encrypted = await secretStore.put(
      secret,
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      { recordId: "secret-private" },
    );
    const row = {
      ...scope,
      name: "hive_api_token",
      origin: "http://192.168.2.10:8080",
      auth: { type: "bearer" as const },
      ...encrypted,
    };
    const privateFetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 302, headers: { location: "/" } }),
    );
    const privateInput = {
      ...input,
      prisma: {
        spaceSettingOverride: ownVault,
        vaultCredential: { findFirst: vi.fn(async () => row) },
      } as unknown as PrismaClient,
      request: { name: row.name, url: `${row.origin}/v1/items` },
      recordUse,
      remote: {
        fetch: privateFetch,
        resolveHostname: async () => [{ address: "192.168.2.10", family: 4 as const }],
      },
    };
    expect(await requestWithBotSecret(privateInput)).toHaveProperty("error");
    expect(privateFetch).toHaveBeenCalledOnce();
    expect(recordUse).toHaveBeenCalledTimes(3);
    expect(recordUse).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "secret-private" }),
      row.origin,
    );
    const refused = {
      ...privateInput,
      remote: {
        fetch: privateFetch,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      },
    };
    expect(await requestWithBotSecret(refused)).toHaveProperty("error");
    expect(privateFetch).toHaveBeenCalledOnce();
    expect(recordUse).toHaveBeenCalledTimes(3);
  });

  it("records no use for a connection never made, and one for a request cut off", async () => {
    const { input, fetch } = await fixture();
    const recordUse = vi.fn(async () => {});
    const failed = (code: string, syscall?: string) =>
      new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code, syscall }) });
    fetch.mockRejectedValueOnce(failed("ECONNREFUSED", "connect"));
    expect(await requestWithBotSecret({ ...input, recordUse })).toHaveProperty("error");
    fetch.mockRejectedValueOnce(failed("CERT_HAS_EXPIRED"));
    expect(await requestWithBotSecret({ ...input, recordUse })).toHaveProperty("error");
    expect(recordUse).not.toHaveBeenCalled();
    fetch.mockRejectedValueOnce(failed("UND_ERR_HEADERS_TIMEOUT"));
    expect(await requestWithBotSecret({ ...input, recordUse })).toHaveProperty("error");
    expect(recordUse).toHaveBeenCalledOnce();
    // A bad TLS record or an unreachable error may come once the request is out.
    fetch.mockRejectedValueOnce(failed("ERR_SSL_WRONG_VERSION_NUMBER"));
    expect(await requestWithBotSecret({ ...input, recordUse })).toHaveProperty("error");
    fetch.mockRejectedValueOnce(failed("EHOSTUNREACH", "read"));
    expect(await requestWithBotSecret({ ...input, recordUse })).toHaveProperty("error");
    expect(recordUse).toHaveBeenCalledTimes(3);
  });

  it("delivers plain-HTTP private destination requests directly when the owner opts in", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const encrypted = await secretStore.put(
      secret,
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      { recordId: "secret-2" },
    );
    const row = {
      ...scope,
      name: "hive_api_token",
      origin: "http://192.168.2.10:8080",
      auth: { type: "bearer" as const },
      ...encrypted,
    };
    const findFirst = vi.fn(async ({ where }) =>
      Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)
        ? row
        : null,
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    const input = {
      prisma: {
        spaceSettingOverride: ownVault,
        vaultCredential: { findFirst },
      } as unknown as PrismaClient,
      secretStore,
      scope,
      request: { name: "hive_api_token", url: "http://192.168.2.10:8080/v1/items" },
      signal: new AbortController().signal,
      remote: {
        fetch,
        resolveHostname: async () => [{ address: "192.168.2.10", family: 4 as const }],
      },
      registerRedactions: vi.fn(),
    };
    expect(await requestWithBotSecret(input)).toEqual({
      status: 200,
      body: { ok: true },
      truncated: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit | undefined];
    expect(String(url)).toBe("http://192.168.2.10:8080/v1/items");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${secret}`);
  });

  it("refuses an opted-in private destination that resolves publicly", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const encrypted = await secretStore.put(
      secret,
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      { recordId: "secret-3" },
    );
    const row = {
      ...scope,
      name: "hive_api_token",
      origin: "http://nas.local:8080",
      auth: { type: "bearer" as const },
      ...encrypted,
    };
    const findFirst = vi.fn(async () => row);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    const input = {
      prisma: {
        spaceSettingOverride: ownVault,
        vaultCredential: { findFirst },
      } as unknown as PrismaClient,
      secretStore,
      scope,
      request: { name: "hive_api_token", url: "http://nas.local:8080/v1/items" },
      signal: new AbortController().signal,
      remote: {
        fetch,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      },
      registerRedactions: vi.fn(),
    };
    expect(await requestWithBotSecret(input)).toEqual({
      error: expect.stringContaining("Authenticated request failed"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("responsePaging", () => {
  const base = "https://api.example.test/v1/items?page=1";

  it("reads quoted Link parameters that hold commas and semicolons", () => {
    const header =
      '<https://api.example.test/v1/items?page=2>; title="Page, next; really"; rel="next", ' +
      '<https://api.example.test/v1/items?page=9>; rel="last"; title="rel=next"';
    expect(linkHeaderEntries(header).map((entry) => entry.params.get("rel"))).toEqual([
      "next",
      "last",
    ]);
    expect(responsePaging(new Headers({ Link: header }), base).links).toEqual({
      next: "https://api.example.test/v1/items?page=2",
      last: "https://api.example.test/v1/items?page=9",
    });
  });

  it("resolves relative links against the request URL and drops unusable ones", () => {
    const headers = new Headers({
      Link: '</v1/items?page=2>; rel=next, <?page=1>; rel="first prev", <javascript:alert(1)>; rel=last',
    });
    expect(responsePaging(headers, base).links).toEqual({
      next: "https://api.example.test/v1/items?page=2",
      first: "https://api.example.test/v1/items?page=1",
      prev: "https://api.example.test/v1/items?page=1",
    });
  });

  it("keeps the case of extension relations, which are URIs", () => {
    const headers = new Headers({
      Link: '</v1/items?page=2>; rel="NEXT https://api.example.test/Relations/Next"',
    });
    expect(responsePaging(headers, base).links).toEqual({
      next: "https://api.example.test/v1/items?page=2",
      "https://api.example.test/Relations/Next": "https://api.example.test/v1/items?page=2",
    });
  });

  it("keeps relations named like Object properties", () => {
    const headers = new Headers({
      Link: '</v1/items?page=2>; rel="constructor toString", </v1/items?page=3>; rel=__proto__',
    });
    const links = responsePaging(headers, base).links ?? {};
    expect(links.constructor).toBe("https://api.example.test/v1/items?page=2");
    // Registered names are lowercased.
    expect(Object.hasOwn(links, "tostring")).toBe(true);
    expect(Object.hasOwn(links, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(links)).toBe(Object.prototype);
  });

  it("bounds links and headers together, keeping the next page and paging headers", () => {
    const pages = Array.from(
      { length: 12 },
      (_, n) => `</v1/items?p=${n}${"x".repeat(900)}>; rel=r${n}`,
    );
    const headers = new Headers({
      Link: [...pages, "</v1/items?page=2>; rel=next"].join(", "),
      "X-Next-Page": "2",
      "X-Total": "40",
    });
    const result = responsePaging(headers, base);
    expect(result.links?.next).toBe("https://api.example.test/v1/items?page=2");
    expect(result.headers).toEqual({ "x-next-page": "2", "x-total": "40" });
    expect(JSON.stringify(result).length).toBeLessThan(6_500);
    expect(Object.keys(result.links ?? {}).length).toBeGreaterThan(1);
  });

  it("leaves out links and paging headers too long to return", () => {
    const long = "x".repeat(2_001);
    const headers = new Headers({
      Link: `</v1/items?cursor=${long}>; rel=next, </v1/items?page=1>; rel=first`,
      "X-Next-Page": long,
      "X-Total": "40",
    });
    expect(responsePaging(headers, base)).toEqual({
      links: { first: "https://api.example.test/v1/items?page=1" },
      headers: { "x-total": "40" },
    });
  });
});

describe("resolveRequestSecretDestination", () => {
  const documented = {
    label: "API key",
    purpose: "api_key",
    credential: destination,
  };
  const plantedSecret = "not-a-real-secret-value";

  it("keeps command destinations metadata-only with an omitted or empty origin", () => {
    for (const origin of [undefined, ""]) {
      const resolved = resolveRequestSecretDestination({
        credential: {
          name: "cli-token",
          origin,
          auth: { type: "command", value: plantedSecret },
          value: plantedSecret,
        },
      });
      expect(resolved).toEqual({
        destination: { name: "cli-token", origin: "", auth: { type: "command" } },
      });
      expect(JSON.stringify(resolved)).not.toContain(plantedSecret);
    }
  });

  it("accepts the documented credential shape", () => {
    expect(resolveRequestSecretDestination(documented)).toEqual({ destination });
  });

  it("accepts a valid credential object supplied beside connectionId", () => {
    // The flattened tool schema allows both fields.
    const resolved = resolveRequestSecretDestination({
      ...documented,
      connectionId: "conn_1",
      credential: { ...destination, value: plantedSecret },
    });
    expect(resolved).toEqual({ destination });
    expect(resolved.connectionId).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toContain(plantedSecret);
    expect(resolved.error).toBeUndefined();
  });

  it("accepts a credential object supplied as top-level name, origin, and auth", () => {
    expect(
      resolveRequestSecretDestination({
        label: "API key",
        purpose: "api_key",
        name: destination.name,
        origin: destination.origin,
        auth: destination.auth,
        secret: plantedSecret,
      }),
    ).toEqual({ destination });
  });

  it("accepts a credential object supplied as a JSON string", () => {
    expect(
      resolveRequestSecretDestination({
        label: "API key",
        purpose: "api_key",
        credential: JSON.stringify({ ...destination, value: plantedSecret }),
      }),
    ).toEqual({ destination });
  });

  it("accepts the documented website login shape", () => {
    const login = {
      name: "example_login",
      origin: "https://login.example.test",
      auth: { type: "login" as const },
    };
    expect(
      resolveRequestSecretDestination({
        label: "Example sign-in",
        purpose: "password",
        credential: login,
      }),
    ).toEqual({ destination: login });
  });

  it("keeps the connector path when only connectionId is supplied", () => {
    expect(
      resolveRequestSecretDestination({
        label: "Code",
        purpose: "otp",
        connectionId: " conn_1 ",
      }),
    ).toEqual({ connectionId: "conn_1" });
  });

  it("does not treat a blank connectionId as a second destination", () => {
    expect(resolveRequestSecretDestination({ ...documented, connectionId: "  " })).toEqual({
      destination,
    });
    expect(
      resolveRequestSecretDestination({ label: "Code", purpose: "otp", connectionId: "null" }),
    ).toEqual({
      error:
        "Provide either a reusable credential destination, a connectionId, or oneTimeCode for a code the page asked for.",
    });
  });

  it("names the failing credential field instead of asking for a destination again", () => {
    const resolved = resolveRequestSecretDestination({
      label: "API key",
      purpose: "api_key",
      credential: { ...destination, name: "Bad Name" },
      connectionId: "conn_1",
    });
    expect(resolved.destination).toBeUndefined();
    expect(resolved.connectionId).toBeUndefined();
    expect(resolved.error).toMatch(/Invalid credential destination — name:/);
    expect(resolved.error).not.toMatch(/reusable credential destination/);
    expect(resolved.error).not.toBe("Specify a credential name, HTTPS origin, and auth method.");
  });

  it("rejects a partial top-level credential instead of using connectionId", () => {
    const withConnection = resolveRequestSecretDestination({
      label: "API key",
      purpose: "api_key",
      name: destination.name,
      origin: destination.origin,
      connectionId: "conn_1",
    });
    const withoutConnection = resolveRequestSecretDestination({
      label: "API key",
      purpose: "api_key",
      name: destination.name,
      origin: destination.origin,
    });
    expect(withConnection.connectionId).toBeUndefined();
    expect(withConnection.destination).toBeUndefined();
    expect(withConnection.error).toMatch(/Invalid credential destination — auth:/);
    expect(withoutConnection).toEqual({ error: withConnection.error });
  });

  it("keeps a complete top-level credential ahead of connectionId", () => {
    expect(
      resolveRequestSecretDestination({
        name: destination.name,
        origin: destination.origin,
        auth: destination.auth,
        connectionId: "conn_1",
        secret: plantedSecret,
      }),
    ).toEqual({ destination });
  });

  it("prefers a nested credential over connectionId and a partial top-level destination", () => {
    expect(
      resolveRequestSecretDestination({
        credential: destination,
        name: destination.name,
        origin: destination.origin,
        connectionId: "conn_1",
      }),
    ).toEqual({ destination });
    expect(
      resolveRequestSecretDestination({
        credential: JSON.stringify(destination),
        name: "only_name",
        connectionId: "conn_1",
      }),
    ).toEqual({ destination });
  });
});

describe("credentialArgument", () => {
  const plantedSecret = "planted-secret-value";

  it("drops planted secret fields from an object credential", () => {
    const credential = credentialArgument({
      credential: { ...destination, value: plantedSecret, secret: plantedSecret },
    });
    expect(credential).toEqual(destination);
    expect(JSON.stringify(credential)).not.toContain(plantedSecret);
  });

  it("drops planted secret fields from a JSON-string credential", () => {
    const credential = credentialArgument({
      credential: JSON.stringify({
        ...destination,
        value: plantedSecret,
        secret: plantedSecret,
        password: plantedSecret,
        plaintext: plantedSecret,
      }),
    });
    expect(credential).toEqual(destination);
    expect(JSON.stringify(credential)).not.toContain(plantedSecret);
  });

  it("returns a partial top-level destination so the missing field can be named", () => {
    expect(
      credentialArgument({
        name: destination.name,
        origin: destination.origin,
        connectionId: "conn_1",
        secret: plantedSecret,
      }),
    ).toEqual({ name: destination.name, origin: destination.origin });
  });

  it("drops secret fields nested in auth instead of keeping the original object", () => {
    const auth = {
      type: "bearer" as const,
      token: plantedSecret,
      value: plantedSecret,
      headers: { Authorization: plantedSecret },
    };
    const credential = credentialArgument({
      credential: { ...destination, auth, secret: plantedSecret },
    });
    expect(credential).toEqual(destination);
    expect(JSON.stringify(credential)).not.toContain(plantedSecret);
    auth.token = "changed-after-copy";
    expect(credential).toEqual(destination);

    expect(
      credentialArgument({
        name: destination.name,
        origin: destination.origin,
        auth: { type: "header", name: "X-Api-Key", value: plantedSecret },
      }),
    ).toEqual({
      ...destination,
      auth: { type: "header", name: "X-Api-Key" },
    });
    expect(
      credentialArgument({
        credential: {
          name: "example_basic",
          origin: destination.origin,
          auth: { type: "basic", username: "bot", password: plantedSecret },
        },
      }),
    ).toEqual({
      name: "example_basic",
      origin: destination.origin,
      auth: { type: "basic", username: "bot" },
    });
    expect(
      credentialArgument({
        credential: JSON.stringify({
          name: "example_login",
          origin: "https://login.example.test",
          auth: { type: "login", username: plantedSecret, password: plantedSecret },
        }),
      }),
    ).toEqual({
      name: "example_login",
      origin: "https://login.example.test",
      auth: { type: "login" },
    });
  });

  it("omits auth that does not parse, and other values that are not destination metadata", () => {
    expect(
      credentialArgument({
        credential: {
          name: destination.name,
          origin: destination.origin,
          auth: { token: plantedSecret },
        },
      }),
    ).toEqual({
      name: destination.name,
      origin: destination.origin,
      auth: { type: "invalid" },
    });
    const invalidMethod = credentialArgument({
      credential: { ...destination, auth: { type: "cookie", token: plantedSecret } },
    });
    expect(invalidMethod).toEqual({ ...destination, auth: { type: "invalid" } });
    expect(JSON.stringify(invalidMethod)).not.toContain(plantedSecret);
    expect(
      resolveRequestSecretDestination({
        credential: { ...destination, auth: { type: "cookie", token: plantedSecret } },
      }).error,
    ).toMatch(/auth\.type:/);
    expect(
      credentialArgument({
        credential: {
          ...destination,
          auth: { type: "header", name: "Cookie", value: plantedSecret },
        },
      }),
    ).toEqual({ ...destination, auth: { type: "header", name: "Cookie" } });
    expect(
      resolveRequestSecretDestination({
        credential: {
          ...destination,
          auth: { type: "header", name: "Cookie", value: plantedSecret },
        },
      }).error,
    ).toMatch(/Unsupported credential header/);

    expect(
      credentialArgument({
        credential: {
          name: { value: plantedSecret },
          origin: { href: `https://user:${plantedSecret}@api.example.test` },
          auth: destination.auth,
        },
      }),
    ).toEqual({ auth: destination.auth });

    expect(credentialArgument({ credential: plantedSecret })).toEqual({});
    expect(credentialArgument({ credential: `{not-json ${plantedSecret}}` })).toEqual({});
    expect(credentialArgument({ credential: [plantedSecret] })).toEqual({});
    expect(JSON.stringify(credentialArgument({ credential: plantedSecret }))).not.toContain(
      plantedSecret,
    );
  });

  it("removes credentials embedded in an origin before they can be recorded", () => {
    const credential = credentialArgument({
      credential: {
        ...destination,
        origin: `https://user:${plantedSecret}@api.example.test/v1?token=${plantedSecret}#${plantedSecret}`,
      },
    });
    expect(credential).toEqual(destination);
    expect(JSON.stringify(credential)).not.toContain(plantedSecret);

    const secretName = "Planted.Secret";
    const replaced = credentialArgument({
      credential: { ...destination, name: secretName, origin: secretName },
    });
    expect(replaced).toEqual({
      name: "Invalid Name",
      origin: "invalid-origin",
      auth: destination.auth,
    });
    expect(JSON.stringify(replaced)).not.toContain(secretName);
    expect(
      resolveRequestSecretDestination({
        label: "API key",
        purpose: "api_key",
        credential: { ...destination, name: secretName },
      }).error,
    ).toMatch(/Invalid credential destination — name:/);
    // A page URL is saved under its site, and its path is never kept.
    const fromPage = resolveRequestSecretDestination({
      label: "API key",
      purpose: "api_key",
      credential: { ...destination, origin: `https://api.example.test/${secretName}` },
    });
    expect(fromPage).toEqual({ destination });
    expect(JSON.stringify(fromPage)).not.toContain(secretName);

    expect(
      resolveRequestSecretDestination({
        label: "API key",
        purpose: "api_key",
        credential: {
          ...destination,
          origin: `https://user:${plantedSecret}@api.example.test?token=${plantedSecret}`,
          auth: { ...destination.auth, token: plantedSecret },
        },
      }),
    ).toEqual({ destination });

    for (const origin of [
      `https://api.example.test/${plantedSecret}/..`,
      `https://api.example.test/${plantedSecret}/%2e%2e`,
    ]) {
      const collapsed = credentialArgument({ credential: { ...destination, origin } });
      expect(collapsed).toEqual(destination);
      expect(JSON.stringify(collapsed)).not.toContain(plantedSecret);
    }
  });
});

describe("normalizeSecretDestination", () => {
  const lanDestination = {
    name: "hive_api_token",
    origin: "http://192.168.2.10:8080",
    auth: { type: "bearer" as const },
  };

  it("rejects plain-HTTP private origins by default", () => {
    expect(() => normalizeSecretDestination(lanDestination)).toThrow();
  });

  it("accepts plain-HTTP private origins when the owner opts in", () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(normalizeSecretDestination(lanDestination)).toMatchObject({
      name: "hive_api_token",
      origin: "http://192.168.2.10:8080",
    });
  });

  it("still rejects public HTTP origins when the owner opts in", () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(() =>
      normalizeSecretDestination({ ...lanDestination, origin: "http://api.example.test" }),
    ).toThrow();
  });

  it("says a login's origin is missing when the model leaves it out", () => {
    expect(() =>
      normalizeSecretDestination({ name: "example-login", auth: { type: "login" } }),
    ).toThrow(`origin: ${BOT_SECRET_ORIGIN_MISSING_MESSAGE}`);
  });

  it("names the failing field instead of a generic instruction", () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(() =>
      normalizeSecretDestination({
        name: "Feishu Creds",
        origin: "http://192.168.2.10:8080",
        auth: { type: "bearer" as const },
      }),
    ).toThrow(/name/);
  });

  function requestedOrigin(origin: string, auth: object = { type: "login" }) {
    const resolved = resolveRequestSecretDestination({
      label: "Sign in",
      purpose: "password",
      credential: { name: "site_login", origin, auth },
    });
    return resolved.destination?.origin ?? resolved.error;
  }

  it("saves a credential requested with a page URL under that page's site", () => {
    expect(requestedOrigin("https://www.example.test/some/login/page?x=1")).toBe(
      "https://www.example.test",
    );
    expect(requestedOrigin("https://api.example.test/v1/users#top", { type: "bearer" })).toBe(
      "https://api.example.test",
    );
    expect(requestedOrigin("https://WWW.Example.TEST:443/Login")).toBe("https://www.example.test");
    expect(requestedOrigin("https://api.example.test:8443/v1")).toBe(
      "https://api.example.test:8443",
    );
    // The host is kept as the browser reports it: punycode, and a trailing dot as its own site.
    expect(requestedOrigin("https://bücher.example.test/login")).toBe(
      "https://xn--bcher-kva.example.test",
    );
    expect(requestedOrigin("https://www.example.test./login")).toBe("https://www.example.test.");
    // A long sign-in redirect URL is fine; only the site is kept.
    expect(requestedOrigin(`https://www.example.test/sign-in?state=${"a".repeat(3000)}`)).toBe(
      "https://www.example.test",
    );
  });

  it("reuses a login saved by origin when it is asked for again by page URL", () => {
    const saved: BotSecretDestination = {
      name: "site_login",
      origin: "https://www.example.test",
      auth: { type: "login" },
    };
    const asked = (origin: string) =>
      resolveRequestSecretDestination({
        label: "Sign in",
        purpose: "password",
        credential: { ...saved, origin },
      }).destination!;
    expect(sameSecretDestination(saved, asked("https://www.example.test/account/login?x=1"))).toBe(
      true,
    );
    expect(sameSecretDestination(saved, asked("https://example.test/account/login"))).toBe(false);
  });

  it("still turns down page URLs on sites a credential can't be saved for", () => {
    for (const origin of [
      "http://www.example.test/login",
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal/x",
      "blob:https://www.example.test/abc",
      "data:text/html,https://www.example.test/",
      "javascript:alert(1)",
      "not a url",
      `https://www.example.test/?state=${"a".repeat(8192)}`,
    ]) {
      const error = requestedOrigin(origin);
      expect(error).toMatch(/^Invalid credential destination — origin: /);
      expect(error).not.toContain("example.test/");
    }
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(requestedOrigin("http://192.168.2.10:8080/api/v1", { type: "bearer" })).toBe(
      "http://192.168.2.10:8080",
    );
    expect(requestedOrigin("http://192.168.2.10:8080/api/v1")).toMatch(
      /Website logins require an HTTPS origin/,
    );
  });

  it("reports login-over-plain-HTTP as an origin problem", () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(() =>
      normalizeSecretDestination({
        name: "feishu_app_credentials",
        origin: "http://192.168.2.10:8080",
        auth: { type: "login" as const },
      }),
    ).toThrow(/Website logins require an HTTPS origin/);
  });
});

/** Prisma's where for these tests: plain fields, a JSON path filter on auth, OR, and take. */
function matchingRows<T extends Record<string, unknown>>(
  rows: T[],
  { where, take }: { where: Record<string, unknown>; take?: number },
) {
  const matchesWhere = (row: T, clause: Record<string, unknown>): boolean =>
    Object.entries(clause).every(([key, value]) => {
      if (key === "OR")
        return (value as Record<string, unknown>[]).some((branch) => matchesWhere(row, branch));
      if (key === "auth" && value && typeof value === "object" && "path" in value) {
        const filter = value as { path: string[]; equals: unknown };
        return (row.auth as Record<string, unknown>)[filter.path[0]!] === filter.equals;
      }
      return row[key] === value;
    });
  const matches = rows.filter((row) => matchesWhere(row, where));
  return take === undefined ? matches : matches.slice(0, take);
}

describe("saved website logins", () => {
  const login = {
    name: "site_login",
    origin: "https://login.example.test",
    auth: { type: "login" },
  };
  // Stored as logins were before fields, so these tests also cover that old logins fill as before.
  async function loginFixture(
    username: string,
    auth: object = login.auth,
    origin = login.origin,
    password = "fake-password-1",
    plaintext = JSON.stringify({ username, password }),
  ) {
    const encrypted = await secretStore.put(
      plaintext,
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      { recordId: "login-1" },
    );
    const row = { ...scope, ...login, origin, auth, ...encrypted };
    const findFirst = vi.fn(async ({ where }) =>
      Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)
        ? row
        : null,
    );
    const findMany = vi.fn(async (query) => matchingRows([row], query));
    return {
      prisma: {
        spaceSettingOverride: ownVault,
        vaultCredential: { findFirst, findMany },
        secret: { findFirst: vi.fn(async () => null) },
      } as unknown as PrismaClient,
    };
  }

  it("hides every saved password when the bot has more than 100 credentials", async () => {
    const context = { operationId: "test", traceId: "test", signal: new AbortController().signal };
    const rows: Record<string, unknown>[] = [];
    // Other credentials are never decrypted for this, so their ciphertext doesn't matter.
    for (let index = 0; index < 120; index += 1)
      rows.push({ ...scope, name: `api_${index}`, auth: { type: "bearer" }, ciphertext: "unused" });
    const password = "fake-late-password-1";
    const encrypted = await secretStore.put(
      JSON.stringify({ username: "fake-user@example.test", password }),
      { ...scope, ...context },
      { recordId: "login-late" },
    );
    rows.push({ ...scope, ...login, ...encrypted });
    const prisma = {
      spaceSettingOverride: ownVault,
      vaultCredential: { findMany: vi.fn(async (query) => matchingRows(rows, query)) },
    } as unknown as PrismaClient;
    expect(await loadLoginPasswordRedactions(prisma, secretStore, scope)).toContain(password);
  });

  it("hides a saved password in its plain, URL, form and base64 forms", async () => {
    const username = "fake-user@example.test";
    const password = "fake pass!word+1";
    const { prisma } = await loginFixture(username, login.auth, login.origin, password);
    const redactions = await loadLoginPasswordRedactions(prisma, secretStore, scope);
    const forms = [
      password,
      encodeURIComponent(password),
      new URLSearchParams({ v: password }).toString().slice(2),
      Buffer.from(password).toString("base64"),
    ];
    expect(forms).toContain("fake+pass%21word%2B1");
    const redacted = redactSecrets([...forms, `Signed in as ${username}`].join("\n"), redactions);
    for (const form of forms) expect(redacted).not.toContain(form);
    // Only the run that fills a login hides its username.
    expect(redacted).toContain(`Signed in as ${username}`);
    expect(
      await loadLoginPasswordRedactions(prisma, secretStore, { ...scope, userId: "user-2" }),
    ).toEqual([]);
  });

  it("leaves a short password to the run that fills it", async () => {
    const { prisma } = await loginFixture(
      "fake-user@example.test",
      login.auth,
      login.origin,
      "abc",
    );
    expect(await loadLoginPasswordRedactions(prisma, secretStore, scope)).toEqual([]);
    const fill = await resolveLoginFill({
      runId: "run-1",
      prisma,
      secretStore,
      scope,
      name: "site_login",
      field: "password",
    });
    expect("redactions" in fill && fill.redactions).toContain("abc");
  });

  it("skips an unreadable login and logs only its id", async () => {
    const row = { ...scope, ...login, id: "login-broken", ciphertext: "not-a-ciphertext" };
    const prisma = {
      spaceSettingOverride: ownVault,
      vaultCredential: { findMany: vi.fn(async () => [row]) },
    } as unknown as PrismaClient;
    const warn = vi.fn();
    const logger = vi.spyOn(Logging, "getLogger").mockReturnValue({ warn } as never);
    try {
      expect(await loadLoginPasswordRedactions(prisma, secretStore, scope)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.any(String), { loginId: "login-broken" });
      // The logger's own scrubbing keeps the id readable.
      expect(Logging.redactBindings(warn.mock.calls[0]![1])).toEqual({ loginId: "login-broken" });
    } finally {
      logger.mockRestore();
    }
  });

  it("decrypts nothing for a bot with only command variables", async () => {
    const { prisma } = await loginFixture("fake-user@example.test", { type: "command" }, "");
    const load = vi.spyOn(secretStore, "load");
    try {
      expect(await loadLoginPasswordRedactions(prisma, secretStore, scope)).toEqual([]);
      expect(load).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  });

  it("resolves one field bound to the saved origin with its redactions", async () => {
    const { prisma } = await loginFixture("fake-user@example.test");
    const input = { prisma, secretStore, scope, name: "site_login" };
    expect(await resolveLoginFill({ runId: "run-1", ...input, field: "password" })).toEqual({
      text: "fake-password-1",
      hidden: true,
      origin: "https://login.example.test",
      sites: ["https://login.example.test"],
      redactions: expect.arrayContaining(["fake-password-1", "fake-user@example.test"]),
      used: expect.objectContaining({ name: "site_login", kind: "login" }),
    });
    expect(await resolveLoginFill({ runId: "run-1", ...input, field: "username" })).toMatchObject({
      text: "fake-user@example.test",
      hidden: false,
    });
    expect(await resolveLoginFill({ runId: "run-1", ...input, field: "Password" })).toMatchObject({
      text: "fake-password-1",
      hidden: true,
    });
  });

  describe("with named fields", () => {
    const fields = [
      { label: "ID number", value: "fake-id-1234", hidden: false },
      { label: "Phone number", value: "+1 555 0100", hidden: true },
      { label: "PIN", value: "4321", hidden: true },
      { label: "Branch", value: "nyc", hidden: false },
    ];
    const fieldsFixture = () =>
      loginFixture("unused", login.auth, login.origin, "unused", encodeLoginSecret({ fields }));

    it("fills a field by its label, whatever its case, with whether it is hidden", async () => {
      const { prisma } = await fieldsFixture();
      const input = { prisma, secretStore, scope, name: "site_login" };
      expect(
        await resolveLoginFill({ runId: "run-1", ...input, field: "phone NUMBER" }),
      ).toMatchObject({
        text: "+1 555 0100",
        hidden: true,
      });
      expect(
        await resolveLoginFill({ runId: "run-1", ...input, field: "ID number" }),
      ).toMatchObject({
        text: "fake-id-1234",
        hidden: false,
      });
      // A bot that still says username and password gets the first visible and hidden fields.
      expect(await resolveLoginFill({ runId: "run-1", ...input, field: "username" })).toMatchObject(
        {
          text: "fake-id-1234",
        },
      );
      expect(await resolveLoginFill({ runId: "run-1", ...input, field: "password" })).toMatchObject(
        {
          text: "+1 555 0100",
        },
      );
    });

    it("names the login's fields, never their values, when the label isn't one of them", async () => {
      const { prisma } = await fieldsFixture();
      const result = await resolveLoginFill({
        runId: "run-1",
        prisma,
        secretStore,
        scope,
        name: "site_login",
        field: "Email",
      });
      expect(result).toEqual({
        error:
          'This login has no field named "Email". Its fields: ID number, Phone number, PIN, Branch.',
      });
    });

    it("hides every hidden field and the visible ones long enough in the filling run", async () => {
      const { prisma } = await fieldsFixture();
      const result = await resolveLoginFill({
        runId: "run-1",
        prisma,
        secretStore,
        scope,
        name: "site_login",
        field: "Branch",
      });
      const redactions = "redactions" in result ? result.redactions : [];
      for (const value of ["fake-id-1234", "+1 555 0100", "%2B1%20555%200100", "4321"]) {
        expect(redactions).toContain(value);
      }
      expect(redactions).not.toContain("nyc");
    });

    it("hides only hidden fields long enough in every run", async () => {
      const { prisma } = await fieldsFixture();
      const redactions = await loadLoginPasswordRedactions(prisma, secretStore, scope);
      expect(redactions).toEqual(expect.arrayContaining(["+1 555 0100", "%2B1%20555%200100"]));
      for (const value of ["fake-id-1234", "4321", "nyc"]) expect(redactions).not.toContain(value);
    });
  });

  it("does not redact a short username that would mangle unrelated text", async () => {
    const { prisma } = await loginFixture("ada");
    const resolved = await resolveLoginFill({
      runId: "run-1",
      prisma,
      secretStore,
      scope,
      name: "site_login",
      field: "username",
    });
    expect(resolved).toMatchObject({ text: "ada" });
    expect("redactions" in resolved && resolved.redactions).not.toContain("ada");
  });

  it("is never sent as an HTTP credential", async () => {
    const { prisma } = await loginFixture("fake-user@example.test");
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(
      await requestWithBotSecret({
        prisma,
        secretStore,
        scope,
        request: { name: "site_login", url: `${login.origin}/api` },
        signal: new AbortController().signal,
        remote: { fetch, resolveHostname: publicResolver },
      }),
    ).toEqual({ error: expect.stringContaining("browser_act") });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to fill a login saved on plain HTTP, including a private LAN origin", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const { prisma } = await loginFixture(
      "fake-user@example.test",
      login.auth,
      "http://192.168.2.10:8080",
    );
    expect(
      await resolveLoginFill({
        runId: "run-1",
        prisma,
        secretStore,
        scope,
        name: "site_login",
        field: "password",
      }),
    ).toEqual({ error: "Website logins can only be filled on an HTTPS origin." });
  });

  it("refuses to fill a credential that is not a login", async () => {
    const { input } = await fixture();
    expect(
      await resolveLoginFill({
        runId: "run-1",
        ...input,
        name: destination.name,
        field: "password",
      }),
    ).toEqual({ error: "This credential is not a website login." });
  });
});

describe("logins kept for one run", () => {
  const fields = [
    { label: "Username", value: "run-user@example.test", hidden: false },
    { label: "Password", value: "run pass!word+1", hidden: true },
  ];

  async function runLoginFixture(origin = "https://login.example.test", otp?: string) {
    const encrypted = await secretStore.put(
      encodeRunLogin(origin, encodeLoginSecret({ fields })),
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      { ephemeral: true },
    );
    const row = { ...scope, kind: "run-login:run-1:site_login", ...encrypted };
    const matching = (where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) =>
        value && typeof value === "object" && "startsWith" in value
          ? String(row[key as keyof typeof row]).startsWith(String(value.startsWith))
          : row[key as keyof typeof row] === value,
      );
    const saved = await secretStore.put(
      encodeLoginSecret({
        fields: [{ label: "Password", value: "saved-password-1", hidden: true }],
        ...(otp ? { otp } : {}),
      }),
      { ...scope, operationId: "test", traceId: "test", signal: new AbortController().signal },
      { recordId: "saved-login" },
    );
    return {
      spaceSettingOverride: { findUnique: vi.fn(async () => null) },
      secret: {
        findFirst: vi.fn(async ({ where }) => (matching(where) ? row : null)),
        findMany: vi.fn(async ({ where }) => (matching(where) ? [row] : [])),
      },
      // A saved login under the same name, which this run's login comes before.
      vaultCredential: {
        findFirst: vi.fn(async () => ({
          ...scope,
          name: "site_login",
          origin: "https://login.example.test",
          auth: { type: "login" },
          ...saved,
        })),
      },
    } as unknown as PrismaClient;
  }

  it("gives no code for this run's own login, even when a saved one of its name has a key", async () => {
    // The person chose a login for this run only; the saved key may be another account's.
    const prisma = await runLoginFixture(undefined, TEST_KEY);
    const input = {
      prisma,
      secretStore,
      scope,
      name: "site_login",
      field: "",
      code: true as const,
    };
    expect(await resolveLoginFill({ ...input, runId: "run-1" })).toEqual({
      error: "This login has no authenticator key. Use request_secret with oneTimeCode.",
    });
    expect(await resolveLoginFill({ ...input, runId: "run-2" })).toMatchObject({
      text: expect.stringMatching(/^\d{6}$/),
    });
  });

  it("fills this run's login before a saved one, only in this run", async () => {
    const prisma = await runLoginFixture();
    const input = { prisma, secretStore, scope, name: "site_login" };
    expect(await resolveLoginFill({ ...input, runId: "run-1", field: "Password" })).toEqual({
      text: "run pass!word+1",
      hidden: true,
      origin: "https://login.example.test",
      sites: ["https://login.example.test"],
      redactions: expect.arrayContaining(["run pass!word+1", "run-user@example.test"]),
    });
    // Another run of the bot gets the saved login.
    expect(await resolveLoginFill({ ...input, runId: "run-2", field: "Password" })).toMatchObject({
      text: "saved-password-1",
    });
  });

  it("refuses to fill it off HTTPS", async () => {
    const prisma = await runLoginFixture("http://192.168.1.20");
    expect(
      await resolveLoginFill({
        prisma,
        secretStore,
        scope,
        runId: "run-1",
        name: "site_login",
        field: "Password",
      }),
    ).toEqual({
      error: "Website logins can only be filled on an HTTPS origin.",
    });
  });

  it("hides it from the start of its run in the forms a saved login is hidden in", async () => {
    const prisma = await runLoginFixture();
    const redactions = await loadRunLoginRedactions(prisma, secretStore, scope, "run-1");
    const password = "run pass!word+1";
    const forms = [
      password,
      encodeURIComponent(password),
      new URLSearchParams({ v: password }).toString().slice(2),
      Buffer.from(password).toString("base64"),
      "run-user@example.test",
    ];
    const redacted = redactSecrets(forms.join("\n"), redactions);
    for (const form of forms) expect(redacted).not.toContain(form);
    expect(await loadRunLoginRedactions(prisma, secretStore, scope, "run-2")).toEqual([]);
  });
});

describe("a one-time code request", () => {
  it("takes only the HTTPS origin of the page that asked, without its path or query", () => {
    const asked = oneTimeCodeArgument({ origin: "https://login.example.test/verify?code=123456" });
    expect(asked).toEqual({ origin: "https://login.example.test" });
    expect(resolveRequestSecretDestination({ oneTimeCode: asked })).toEqual({
      oneTimeCodeOrigin: "https://login.example.test",
    });
    // Userinfo never reaches the card or the stored request.
    expect(oneTimeCodeArgument({ origin: "https://user:fake-pass@example.test" })).toEqual({
      origin: "https://example.test",
    });
  });

  it("tells the bot why an HTTP page is refused, so it can tell the user", () => {
    for (const origin of ["http://login.example.test", "http://192.168.1.20"]) {
      expect(
        resolveRequestSecretDestination({ oneTimeCode: oneTimeCodeArgument({ origin }) }),
      ).toEqual({
        error:
          "Codes can only be typed on HTTPS pages, and this page isn't HTTPS. Ask the user to take over and tell them that is why.",
      });
    }
  });

  it.each([{ origin: "" }, {}, "https://login.example.test", { origin: "ftp://example.test" }])(
    "refuses %j, which cannot be a page a code is typed into",
    (value) => {
      expect(resolveRequestSecretDestination({ oneTimeCode: oneTimeCodeArgument(value) })).toEqual({
        error: "oneTimeCode needs the HTTPS origin of the page that asked for the code.",
      });
    },
  );

  it("refuses a private-LAN HTTP origin even when the owner allows it for credentials", () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    expect(
      resolveRequestSecretDestination({
        oneTimeCode: oneTimeCodeArgument({ origin: "http://192.168.1.20" }),
      }),
    ).toMatchObject({ error: expect.any(String) });
  });
});

describe("a code's redactions", () => {
  const hidden = (text: string, code = "123456") =>
    redactSecrets(text, oneTimeCodeRedactions(code));

  it("hide a code a page draws one character at a time, with spaces or dashes, or in groups", () => {
    // An innerText-style read of an input-otp widget: one slot per line.
    for (const shown of [
      "123456",
      "1\n2\n3\n4\n5\n6",
      "1\r\n2\r\n3\r\n4\r\n5\r\n6",
      "1 2 3 4 5 6",
      "1\t2\t3\t4\t5\t6",
      "1-2-3-4-5-6",
      "1 - 2 - 3 - 4 - 5 - 6",
      "123 456",
      "123-456",
      "123 - 456",
    ]) {
      expect(hidden(`Enter code:\n${shown}\nResend`)).toBe("Enter code:\n[redacted]\nResend");
    }
  });

  it("hide a code written with dashes both as sent and without them", () => {
    expect(hidden("12-34-56", "12-34-56")).toBe("[redacted]");
    expect(hidden("123456", "12-34-56")).toBe("[redacted]");
    expect(hidden("1 2 3 4 5 6", "12-34-56")).toBe("[redacted]");
  });

  it("never include a form too short to be told from ordinary text", () => {
    for (const code of ["1234", "123-456", "ab12-cd34"]) {
      expect(oneTimeCodeRedactions(code).filter((form) => form.length < 4)).toEqual([]);
    }
  });

  it("hide a code with letters that the page shows in another case", () => {
    expect(hidden("Code AB12CD", "ab12cd")).toBe("Code [redacted]");
    expect(hidden("a b 1 2 c d", "AB12CD")).toBe("[redacted]");
  });

  it("leave a short number alone when it stands bare, but hide it drawn per digit", () => {
    expect(hidden("Paid 1000 in 2026", "2026")).toBe("Paid 1000 in 2026");
    expect(hidden("2\n0\n2\n6", "2026")).toBe("[redacted]");
    expect(hidden("Code ab12", "ab12")).toBe("Code [redacted]");
  });

  it("leave unrelated digits alone", () => {
    expect(hidden("Order 98765 shipped on 12/34")).toBe("Order 98765 shipped on 12/34");
  });
});

describe("resolveCodeFill", () => {
  const codeScope = { userId: "user-1", spaceId: "space-1" };

  async function codeFixture(origin = "https://login.example.test", runId = "run-1") {
    const stored = await secretStore.put(
      encodeRunCode(origin, "123456"),
      { ...codeScope, operationId: runId, traceId: runId, signal: new AbortController().signal },
      { ephemeral: true },
    );
    const rows: Array<Record<string, unknown>> = [
      { ...codeScope, ...stored, kind: `run-code:${runId}` },
    ];
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) =>
        value && typeof value === "object" && "in" in value
          ? (value.in as unknown[]).includes(row[key])
          : row[key] === value,
      );
    const prisma = {
      secret: {
        findFirst: vi.fn(async ({ where }) => rows.find((row) => matches(row, where)) ?? null),
        findMany: vi.fn(async ({ where }) => rows.filter((row) => matches(row, where))),
        updateMany: vi.fn(async ({ where, data }) => {
          const found = rows.filter((row) => matches(row, where));
          for (const row of found) Object.assign(row, data);
          return { count: found.length };
        }),
      },
    } as unknown as PrismaClient;
    return { prisma, rows };
  }

  it("gives the code with its site and every form to hide, without taking it", async () => {
    const { prisma, rows } = await codeFixture();
    const fill = await resolveCodeFill({ prisma, secretStore, scope: codeScope, runId: "run-1" });
    if ("error" in fill) throw new Error(fill.error);
    expect(fill).toMatchObject({ text: "123456", origin: "https://login.example.test" });
    expect(fill.redactions).toEqual(expect.arrayContaining(["123456", "1\n2\n3\n4\n5\n6"]));
    expect(rows[0]).toMatchObject({ kind: "run-code:run-1" });
  });

  it("lets one of two fills take the code, and keeps it as a spent row", async () => {
    const { prisma, rows } = await codeFixture();
    const input = { prisma, secretStore, scope: codeScope, runId: "run-1" };
    const [first, second] = await Promise.all([resolveCodeFill(input), resolveCodeFill(input)]);
    if ("error" in first || "error" in second) throw new Error("both fills should resolve");
    const claims = await Promise.all([first.claim(), second.claim()]);
    expect(claims.filter((refused) => refused === undefined)).toHaveLength(1);
    expect(claims.filter((refused) => refused?.includes("No code is waiting"))).toHaveLength(1);
    expect(rows).toMatchObject([{ kind: "run-code-spent:run-1" }]);
    expect(await resolveCodeFill(input)).toEqual({
      error:
        "No code is waiting. Use request_secret with oneTimeCode to ask the user for it first.",
    });
  });

  it("gives a refused code back for another try", async () => {
    const { prisma, rows } = await codeFixture();
    const input = { prisma, secretStore, scope: codeScope, runId: "run-1" };
    const fill = await resolveCodeFill(input);
    if ("error" in fill) throw new Error(fill.error);
    expect(await fill.claim()).toBeUndefined();
    await fill.restore();
    expect(rows).toMatchObject([{ kind: "run-code:run-1" }]);
    expect(await resolveCodeFill(input)).toMatchObject({ text: "123456" });
  });

  it("keeps hiding a spent code, and a waiting one, from the start of a later attempt", async () => {
    const { prisma } = await codeFixture();
    const input = { prisma, secretStore, scope: codeScope, runId: "run-1" };
    expect(await loadRunCodeRedactions(prisma, secretStore, codeScope, "run-1")).toEqual(
      expect.arrayContaining(["123456", "1\n2\n3\n4\n5\n6"]),
    );
    const fill = await resolveCodeFill(input);
    if ("error" in fill) throw new Error(fill.error);
    await fill.claim();
    expect(await loadRunCodeRedactions(prisma, secretStore, codeScope, "run-1")).toContain(
      "123456",
    );
    expect(await loadRunCodeRedactions(prisma, secretStore, codeScope, "run-2")).toEqual([]);
  });

  it("never gives another run's code", async () => {
    const { prisma } = await codeFixture(undefined, "run-0");
    expect(
      await resolveCodeFill({ prisma, secretStore, scope: codeScope, runId: "run-1" }),
    ).toMatchObject({ error: expect.stringContaining("No code is waiting") });
  });

  it("refuses a code kept for a plain-HTTP site, with the reason", async () => {
    const { prisma, rows } = await codeFixture("http://login.example.test");
    expect(
      await resolveCodeFill({ prisma, secretStore, scope: codeScope, runId: "run-1" }),
    ).toEqual({ error: expect.stringContaining("Ask the user to take over and tell them") });
    expect(rows).toMatchObject([{ kind: "run-code:run-1" }]);
  });

  it("refuses a code it cannot read, logging only the error name", async () => {
    const { prisma, rows } = await codeFixture();
    rows[0]!.ciphertext = "not-a-ciphertext";
    const warn = vi.fn();
    const logger = vi.spyOn(Logging, "getLogger").mockReturnValue({ warn } as never);
    try {
      expect(
        await resolveCodeFill({ prisma, secretStore, scope: codeScope, runId: "run-1" }),
      ).toEqual({ error: "This code could not be loaded." });
      expect(warn).toHaveBeenCalledWith(expect.any(String), { errorName: expect.any(String) });
    } finally {
      logger.mockRestore();
    }
  });
});

describe("loginCodeClaim", () => {
  // What a site asking again looks like: the next code requested soon after one was typed.
  const window = LOGIN_CODE_REPEAT_WINDOW_MS;
  const login = {
    name: "site_login",
    origin: "https://login.example.test",
    auth: { type: "login" as const },
  };
  const value = (otp: string) =>
    encodeLoginSecret({
      fields: [{ label: "Password", value: "saved-password-1", hidden: true }],
      otp,
    });
  type Step =
    // Claim a code at this time; `stopped` is the login's stop after it; `stale` claims with
    // the value read before the owner's last save, as a fill that raced the save does.
    | {
        at: number;
        run?: string;
        stale?: true;
        refused?:
          | typeof LOGIN_CODES_USED_UP
          | typeof CODE_ALREADY_TYPED
          | typeof LOGIN_VALUE_CHANGED;
        stopped?: boolean;
        uncertain?: true;
      }
    // Give an earlier claim back (the page clearly never typed it), by its index in `steps`.
    | { restore: number; stopped: boolean }
    // The owner saves the login's value again, or only relabels it.
    | { save: "value" | "label"; stopped: boolean };
  const cases: { name: string; steps: Step[]; parallel?: number[] }[] = [
    {
      name: "three sign-ins far apart, as a working key gives, stop nothing",
      steps: [
        { at: 0, stopped: false },
        { at: window + 1, stopped: false },
        { at: 2 * (window + 1), stopped: false },
        { at: 3 * (window + 1), stopped: false },
      ],
    },
    {
      name: "three quick repeats in one run stop the login with the third, and refuse another run with no fourth request",
      steps: [
        { at: 0, stopped: false },
        { at: 30_000, stopped: false },
        { at: 60_000, stopped: true },
        { at: 90_000, run: "run-2", refused: LOGIN_CODES_USED_UP, stopped: true },
        { at: 90_000, refused: LOGIN_CODES_USED_UP, stopped: true },
      ],
    },
    {
      name: "a repeat a moment inside the window counts, one a moment outside starts over",
      steps: [
        { at: 0, stopped: false },
        { at: window, stopped: false },
        { at: 2 * window + 1, stopped: false },
        { at: 3 * window, stopped: false },
        { at: 4 * window, stopped: true },
      ],
    },
    {
      name: "quick repeats split across two runs count for each run on its own",
      steps: [
        { at: 0, stopped: false },
        { at: 30_000, run: "run-2", stopped: false },
        { at: 60_000, stopped: false },
        { at: 90_000, run: "run-2", stopped: false },
        { at: 120_000, stopped: true },
      ],
    },
    {
      name: "the same code is typed once per run, and a repeat refusal is no repeat",
      steps: [
        { at: 0, stopped: false },
        { at: 10_000, refused: CODE_ALREADY_TYPED, stopped: false },
        { at: 30_000, stopped: false },
        { at: 60_000, stopped: true },
      ],
    },
    {
      name: "a new key the owner saves starts the count again, and its codes are not stopped by the old key's",
      steps: [
        { at: 0, stopped: false },
        { at: 30_000, stopped: false },
        { save: "value", stopped: false },
        { at: 60_000, stopped: false },
        { at: 90_000, stopped: false },
        { at: 120_000, stopped: true },
      ],
    },
    {
      name: "codes from a replaced key are refused without spending an attempt or stopping the new key",
      steps: [
        { at: 0, stopped: false },
        { at: 30_000, stopped: false },
        { save: "value", stopped: false },
        { at: 60_000, stale: true, refused: LOGIN_VALUE_CHANGED, stopped: false },
        { at: 90_000, stale: true, refused: LOGIN_VALUE_CHANGED, stopped: false },
        { at: 90_000, stopped: false },
      ],
    },
    {
      name: "the owner's save clears a stop, a relabel alone does not",
      steps: [
        { at: 0, stopped: false },
        { at: 30_000, stopped: false },
        { at: 60_000, stopped: true },
        { save: "label", stopped: true },
        { at: 90_000, refused: LOGIN_CODES_USED_UP, stopped: true },
        { save: "value", stopped: false },
        { at: 120_000, stopped: false },
      ],
    },
    {
      name: "an uncertain third fill keeps the stop: two codes were asked for again",
      steps: [
        { at: 0, stopped: false },
        { at: 30_000, stopped: false },
        { at: 60_000, stopped: true, uncertain: true },
        { at: 90_000, refused: LOGIN_CODES_USED_UP, stopped: true },
      ],
    },
    {
      name: "a third code the page never typed gives its place back, and with it the stop",
      steps: [
        { at: 0, stopped: false },
        { at: 30_000, stopped: false },
        { at: 60_000, stopped: true },
        { restore: 2, stopped: false },
        { at: 61_000, stopped: true },
      ],
    },
    {
      name: "a refused claim given back changes nothing: three others still stand",
      steps: [
        { at: 0, stopped: false },
        { at: 30_000, stopped: false },
        { at: 60_000, stopped: true },
        { at: 90_000, refused: LOGIN_CODES_USED_UP, stopped: true },
        { restore: 3, stopped: true },
      ],
    },
    ...[0, 1, 2].map((index): (typeof cases)[number] => ({
      name: `parallel claims count three at most, one writes the stop, and giving back the ${["first", "second", "third"][index]} of them lifts it`,
      parallel: [0, 1, 2, 3, 4],
      steps: [
        { at: 0, stopped: true },
        { at: 0, stopped: true },
        { at: 0, stopped: true },
        { at: 0, refused: LOGIN_CODES_USED_UP, stopped: true },
        { at: 0, refused: LOGIN_CODES_USED_UP, stopped: true },
        { restore: index, stopped: false },
        { at: 1_000, stopped: true },
      ],
    })),
  ];
  it.each(cases)("$name", async ({ steps, parallel }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = fakeDatabase();
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      destination: login,
      plaintext: value(TEST_KEY),
    });
    const row = db.rows()[0]!;
    const start = Date.now();
    // What a fill reads before claiming: the login as saved then.
    let read = { id: row.id, ciphertext: row.ciphertext };
    let before = read;
    const claims = new Map<number, ReturnType<typeof loginCodeClaim>>();
    const claim = (index: number, step: Extract<Step, { at: number }>) => {
      vi.setSystemTime(start + step.at);
      const code = loginCodeClaim({
        prisma: db.prisma,
        secretStore,
        scope,
        runId: step.run ?? "run-1",
        login: step.stale ? before : read,
        origin: row.origin,
        // Two codes of a step are the same code; three others of other steps.
        code: index === 1 && step.refused === CODE_ALREADY_TYPED ? "000000" : `00000${index}`,
      });
      claims.set(index, code);
      return code.claim();
    };
    const stopped = (index: number, step: Step) =>
      expect
        .soft(row.codesStoppedAt instanceof Date, `stop after step ${index}`)
        .toBe(step.stopped ?? false);
    const parallelResults = parallel
      ? await Promise.all(
          parallel.map((index) => claim(index, steps[index] as Extract<Step, { at: number }>)),
        )
      : [];
    if (parallel) {
      expect(parallelResults.filter((refused) => refused === undefined)).toHaveLength(
        LOGIN_CODE_TRIES,
      );
      expect(parallelResults.filter((refused) => refused === LOGIN_CODES_USED_UP)).toHaveLength(
        parallel.length - LOGIN_CODE_TRIES,
      );
      // Which of them the lock refused is not fixed, so the table's refusals are not matched.
    }
    for (const [index, step] of steps.entries()) {
      if (parallel?.includes(index)) continue;
      if ("restore" in step) {
        await claims.get(step.restore)!.restore();
      } else if ("save" in step) {
        if (step.save === "value") {
          before = read;
          await storeBotSecret({
            prisma: db.prisma,
            secretStore,
            scope,
            destination: login,
            plaintext: value(OTHER_TEST_KEY),
          });
          read = { id: row.id, ciphertext: row.ciphertext };
        } else {
          await relabelVaultItem(db.prisma, scope, login.name, { title: "Renamed" });
        }
      } else {
        expect.soft(await claim(index, step), `claim ${index}`).toBe(step.refused);
      }
      stopped(index, step);
    }
    expect(db.secrets().filter((secret) => String(secret.id).startsWith("run-totp-"))).toHaveLength(
      steps.filter((step, index) => {
        if (!("at" in step) || step.refused) return false;
        return !steps.some((later) => "restore" in later && later.restore === index);
      }).length,
    );
  });

  it("claims no code of a login the owner removed since the fill read it", async () => {
    const db = fakeDatabase();
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      destination: login,
      plaintext: value(TEST_KEY),
    });
    const row = db.rows()[0]!;
    const code = loginCodeClaim({
      prisma: db.prisma,
      secretStore,
      scope,
      runId: "run-1",
      login: { id: row.id, ciphertext: row.ciphertext },
      origin: row.origin,
      code: "000000",
    });
    db.rows().splice(0);
    expect(await code.claim()).toBe(LOGIN_REMOVED);
    expect(db.secrets().filter((secret) => String(secret.id).startsWith("run-totp-"))).toEqual([]);
  });
});

describe("replacing a saved login's site", () => {
  const WWW = "https://www.example.test";
  const LOGIN = "https://login.example.test";
  const REFUSED = "Remove the existing credential before changing its destination";
  const login = (origin: string): BotSecretDestination => ({
    name: "site_login",
    origin,
    auth: { type: "login" },
  });
  const typed = (password: string) =>
    encodeLoginSecret({
      fields: [
        { label: "Username", value: "fake-user", hidden: false },
        { label: "Password", value: password, hidden: true },
      ],
    });

  async function save(db: ReturnType<typeof fakeDatabase>, destination = login(WWW)) {
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      destination,
      plaintext: destination.auth.type === "login" ? typed("fake-password-www") : "fake-token-1",
    });
    return { ...db.rows().find((row) => row.name === destination.name)! };
  }

  function prepare(
    db: ReturnType<typeof fakeDatabase>,
    destination: BotSecretDestination,
    password: string,
    options: { replaces?: string; createOnly?: boolean } = {},
  ) {
    return prepareBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      destination,
      plaintext: destination.auth.type === "login" ? typed(password) : password,
      ...options,
    });
  }

  const commit = (
    db: ReturnType<typeof fakeDatabase>,
    prepared: Awaited<ReturnType<typeof prepareBotSecret>>,
  ) => db.prisma.$transaction((tx) => prepared.store(tx));

  it("moves the one saved row to the new site with the value typed for it", async () => {
    const db = fakeDatabase();
    const before = await save(db);
    await commit(
      db,
      await prepare(db, login(LOGIN), "fake-password-login", { replaces: before.id }),
    );
    expect(db.rows()).toHaveLength(1);
    const [row] = db.rows();
    expect(row).toMatchObject({ id: before.id, name: "site_login", origin: LOGIN });
    expect(row!.ciphertext).not.toBe(before.ciphertext);
    expect(await secretStore.load(row!.ciphertext, row!.id)).toBe(typed("fake-password-login"));
    expect(JSON.stringify(db.rows())).not.toContain(WWW);
    // Origin and value are one write, so no state has one without the other.
    expect(db.prisma.vaultCredential.update).toHaveBeenLastCalledWith({
      where: { id: before.id },
      data: { origin: LOGIN, ciphertext: row!.ciphertext },
    });
    // Every bot of the member lists it for the new site, and fills take their site from the row.
    const otherBot = { ...scope, botId: "bot-2" };
    expect(await listBotSecrets(db.prisma, secretStore, otherBot)).toEqual([
      expect.objectContaining(login(LOGIN)),
    ]);
    expect(
      await resolveLoginFill({
        prisma: db.prisma,
        secretStore,
        scope: otherBot,
        runId: "run-1",
        name: "site_login",
        field: "Password",
      }),
    ).toMatchObject({ text: "fake-password-login", origin: LOGIN });
  });

  it("keeps refusing another site to every save that isn't a card replacing that login", async () => {
    const db = fakeDatabase();
    const before = await save(db);
    await expect(
      storeBotSecret({
        prisma: db.prisma,
        secretStore,
        scope,
        destination: login(LOGIN),
        plaintext: typed("fake-password-login"),
      }),
    ).rejects.toThrow(REFUSED);
    await expect(
      prepare(db, login(LOGIN), "fake-password-login", { replaces: before.id, createOnly: true }),
    ).rejects.toThrow("A credential with this name is already saved");
    // A card that replaces another login, or none, including one given the old site.
    for (const replaces of ["other-login", WWW, undefined]) {
      await expect(prepare(db, login(LOGIN), "fake-password-login", { replaces })).rejects.toThrow(
        REFUSED,
      );
    }
    expect(db.rows()).toEqual([before]);
  });

  it("moves only a login, only to another HTTPS login", async () => {
    vi.stubEnv("RAKAZO_SECRETS_ALLOW_PRIVATE_HTTP", "1");
    const db = fakeDatabase();
    const token = await save(db, { name: "api", origin: WWW, auth: { type: "bearer" } });
    const saved = await save(db);
    const attempts: Array<[BotSecretDestination, string]> = [
      [{ name: "api", origin: LOGIN, auth: { type: "bearer" } }, token.id],
      [{ name: "api", origin: LOGIN, auth: { type: "login" } }, token.id],
      [{ name: "api", origin: "http://192.168.1.20", auth: { type: "bearer" } }, token.id],
      [{ name: "site_login", origin: LOGIN, auth: { type: "bearer" } }, saved.id],
    ];
    for (const [destination, replaces] of attempts) {
      await expect(prepare(db, destination, "fake-value-2", { replaces })).rejects.toThrow(REFUSED);
    }
    expect(db.rows()).toEqual([token, saved]);
  });

  it("won't let a card replace a login saved after it was opened", async () => {
    // Opened when nothing was saved under the name; a login for www is saved meanwhile.
    const db = fakeDatabase();
    const opened = await prepare(db, login(LOGIN), "fake-password-login");
    const before = await save(db);
    await expect(commit(db, opened)).rejects.toThrow(REFUSED);
    // Opened to replace a login that was then removed and saved again, as another row.
    const replacing = await prepare(db, login(LOGIN), "fake-password-login", {
      replaces: before.id,
    });
    await forgetBotSecret(db.prisma, scope, "site_login");
    const again = await save(db);
    expect(again.id).not.toBe(before.id);
    await expect(commit(db, replacing)).rejects.toThrow(REFUSED);
    expect(db.rows()).toEqual([again]);
  });

  it("keeps the site and value of the last of two cards replacing the same login", async () => {
    const db = fakeDatabase();
    const before = await save(db);
    const other = login("https://other.example.test");
    const toLogin = await prepare(db, login(LOGIN), "fake-password-login", {
      replaces: before.id,
    });
    const toOther = await prepare(db, other, "fake-password-other", { replaces: before.id });
    await commit(db, toLogin);
    // It keeps whatever key is saved, so a value saved since sends it back to be prepared again.
    await expect(commit(db, toOther)).rejects.toMatchObject({ code: "P2034" });
    await commit(db, await prepare(db, other, "fake-password-other", { replaces: before.id }));
    expect(db.rows()).toHaveLength(1);
    const [row] = db.rows();
    expect(row).toMatchObject({ id: before.id, origin: "https://other.example.test" });
    expect(await secretStore.load(row!.ciphertext, row!.id)).toBe(typed("fake-password-other"));
  });
});

describe("cardRedactionForms", () => {
  it("covers the groups of four that most cards are printed in", () => {
    expect(cardRedactionForms("4242424242424242")).toEqual([
      "4242424242424242",
      "4242 4242 4242 4242",
      "4242-4242-4242-4242",
    ]);
  });

  it.each([
    ["a 15-digit American Express", "378282246310005", "3782 822463 10005", "3782-822463-10005"],
    ["a 14-digit Diners Club", "30569309025904", "3056 930902 5904", "3056-930902-5904"],
  ])("also covers the groups %s is printed in", (_label, digits, spaced, hyphenated) => {
    const forms = cardRedactionForms(digits);
    expect(forms).toContain(digits);
    expect(forms).toContain(spaced);
    expect(forms).toContain(hyphenated);
    expect(redactSecrets(`Card ${spaced} and ${hyphenated}`, forms)).not.toMatch(/\d{4}/);
  });
});
