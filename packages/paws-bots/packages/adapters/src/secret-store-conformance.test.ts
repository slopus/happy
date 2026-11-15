import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { InfisicalSecretStore, SecretStoreUnavailableError } from "./infisical-secret-store.js";
import { InMemoryRealtimeFanout } from "./realtime.js";
import {
  ComposedSecretStore,
  createSecretStore,
  secretStoreOptionsFromEnv,
} from "./secret-store-factory.js";
import { infisicalFake } from "./secret-store-fake.js";
import { EncryptedSecretStore } from "./secrets.js";

const secretTestContext: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "test",
  userId: "test",
  signal: new AbortController().signal,
};
function conformance(name: string, create: () => SecretStore) {
  describe(`${name} SecretStore conformance`, () => {
    it("has async reads, opaque unique refs, row binding, and idempotent deletion", async () => {
      const store = create();
      await store.start();
      try {
        const first = await store.put("fake-secret", secretTestContext, { recordId: "row" });
        const second = await store.put("replacement", secretTestContext, { recordId: "row" });
        expect(first.ref).not.toContain("fake-secret");
        expect(second.ref).not.toBe(first.ref);
        expect(first.ciphertext).toBe(first.ref);
        await expect(store.load(first.ref, "row")).resolves.toBe("fake-secret");
        await expect(store.load(second.ref, "row")).resolves.toBe("replacement");
        await expect(store.load(first.ref, "other-row")).rejects.toThrow();
        await store.delete(first.ref, "row");
        await store.delete(first.ref, "row");
        expect(store.redact("sk-fake-secret-value")).not.toContain("sk-fake-secret-value");
      } finally {
        await store.close();
      }
    });
    it("notifies by ref and unsubscribes", async () => {
      const store = create();
      await store.start();
      const listener = vi.fn();
      const unsubscribe = store.onChange(listener);
      const record = await store.put("fake", secretTestContext);
      expect(listener).toHaveBeenCalledWith(record.ref);
      await store.delete(record.ref, record.id);
      expect(listener).toHaveBeenCalledTimes(2);
      unsubscribe();
      await store.delete(record.ref, record.id);
      expect(listener).toHaveBeenCalledTimes(2);
      await store.close();
    });
    it("honors caller cancellation", async () => {
      const store = create();
      await store.start();
      const record = await store.put("fake", secretTestContext);
      await expect(
        store.load(record.ref, { recordId: record.id, signal: AbortSignal.abort() }),
      ).rejects.toThrow();
      await store.close();
    });
  });
}
conformance("encrypted", () => new EncryptedSecretStore("test-key"));
conformance("Infisical", () => new InfisicalSecretStore(infisicalFake().options));

describe("Infisical lifecycle and REST", () => {
  it("reads a just-written ref from another process and reads legacy/ephemeral refs locally", async () => {
    const fake = infisicalFake();
    const a = new ComposedSecretStore(
      new EncryptedSecretStore("test-key"),
      new InfisicalSecretStore(fake.options),
    );
    const b = new ComposedSecretStore(
      new EncryptedSecretStore("test-key"),
      new InfisicalSecretStore(fake.options),
    );
    await a.start();
    await b.start();
    const remote = await a.put("remote", secretTestContext);
    await expect(b.load(remote.ref, remote.id)).resolves.toBe("remote");
    const local = await a.put("otp", secretTestContext, { ephemeral: true });
    expect(local.ref).toMatch(/^v2:/);
    await expect(b.load(local.ref, local.id)).resolves.toBe("otp");
    const legacy = await new EncryptedSecretStore("test-key").put("legacy", secretTestContext);
    await expect(b.load(legacy.ref, legacy.id)).resolves.toBe("legacy");
    expect(fake.values.size).toBe(1);
    await a.close();
    await b.close();
  });
  it("deduplicates login, reauthenticates proactively, retries 401 once and honours Retry-After on 429 and backs off 5xx", async () => {
    const fake = infisicalFake();
    let now = 0;
    const store = new InfisicalSecretStore({ ...fake.options, now: () => now });
    await Promise.all([store.start(), store.start()]);
    expect(fake.logins).toBe(1);
    now = 3_580_000;
    await store.put("value", secretTestContext);
    expect(fake.logins).toBe(2);
    fake.statuses.push(401, 429, 503, 200);
    await store.put("next", secretTestContext);
    expect(fake.logins).toBe(3);
    expect(fake.sleep.mock.calls.map((call) => call[0])).toEqual([1000, 200]);
    fake.statuses.push(401, 401);
    await expect(store.put("private value", secretTestContext)).rejects.toMatchObject({
      status: 401,
    });
    expect(fake.logins).toBe(4);
    await store.close();
  });
  it("drops TTL/LRU plaintext silently, bounds digests, and clears both on close", async () => {
    vi.useFakeTimers();
    const fake = infisicalFake();
    let now = Date.now();
    const store = new InfisicalSecretStore({
      ...fake.options,
      cacheMaxEntries: 2,
      cacheTtlMs: 100,
      now: () => now,
    });
    const internals = store as unknown as {
      cache: Map<string, unknown>;
      lastSeen: Map<string, string>;
    };
    try {
      const a = await store.put("a", secretTestContext);
      const b = await store.put("b", secretTestContext);
      const changed = vi.fn();
      store.onChange(changed);
      // Exercise lazy expiry independently of the timer.
      now += 100;
      await expect(store.load(a.ref, a.id)).resolves.toBe("a");
      expect(changed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(internals.cache.size).toBe(0);
      expect([...internals.lastSeen.values()]).toEqual([
        expect.stringMatching(/^[a-f0-9]{64}$/),
        expect.stringMatching(/^[a-f0-9]{64}$/),
      ]);
      fake.values.set(a.ref.split(":").at(-1)!, "rotated");
      await expect(store.load(a.ref, a.id)).resolves.toBe("rotated");
      await store.load(a.ref, a.id);
      expect(changed).toHaveBeenCalledExactlyOnceWith(a.ref);
      await store.load(b.ref, b.id);
      await store.load(a.ref, a.id);
      changed.mockClear();
      const c = await store.put("c", secretTestContext);
      // Only the local write notifies; evicting b from either LRU does not.
      expect(changed).toHaveBeenCalledExactlyOnceWith(c.ref);
      expect(internals.lastSeen.has(a.ref)).toBe(true);
      expect(internals.lastSeen.has(b.ref)).toBe(false);
      changed.mockClear();
      await store.load(b.ref, b.id);
      expect(internals.cache.size).toBe(2);
      expect(internals.lastSeen.size).toBe(2);
      expect(internals.lastSeen.has(c.ref)).toBe(true);
      expect(changed).not.toHaveBeenCalled();
      await store.close();
      expect(internals.cache.size).toBe(0);
      expect(internals.lastSeen.size).toBe(0);
      expect(changed).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await expect(store.load(a.ref, a.id)).rejects.toBeInstanceOf(SecretStoreUnavailableError);
    } finally {
      await store.close();
      vi.useRealTimers();
    }
  });
  it.each([{}, { SECRET_STORE: "encrypted" }])(
    "rejects remote refs without a provider and logs one redacted rollback hint (%j)",
    async (env) => {
      const sink = createTestSink();
      const previousLogger = getLogger();
      installLogger(createLogger({ service: "test", sinks: [sink] }));
      const store = createSecretStore("fake-key", env);
      const ref = "infisical:v1:fake-private-ref";
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(store.load(ref, "fake-private-row")).rejects.toBeInstanceOf(
            SecretStoreUnavailableError,
          );
        }
        await expect(store.load(ref, "fake-private-row")).rejects.toThrow("reverse migration");
        expect(sink.events).toHaveLength(1);
        const log = JSON.stringify(sink.events);
        expect(log).toContain("reverse migration");
        expect(log).not.toContain(ref);
        expect(log).not.toContain("fake-private-row");
        expect(log).not.toContain("fake-key");
      } finally {
        await store.close();
        installLogger(previousLogger);
      }
    },
  );
  it("starts degraded, retains legacy reads, retries later, and never exposes HTTP bodies", async () => {
    const fake = infisicalFake();
    const remote = new InfisicalSecretStore(fake.options);
    const record = await remote.put("private value", secretTestContext);
    await remote.close();
    fake.offline = true;
    const store = new ComposedSecretStore(
      new EncryptedSecretStore("test-key"),
      new InfisicalSecretStore(fake.options),
    );
    await expect(store.start()).resolves.toBeUndefined();
    expect(store.describe().capabilities.degraded).toBe(true);
    await expect(store.load(record.ref, record.id)).rejects.toThrow(
      "Secret storage is unavailable",
    );
    const local = await store.put("local", secretTestContext, { ephemeral: true });
    await expect(store.load(local.ref, local.id)).resolves.toBe("local");
    fake.offline = false;
    await expect(store.load(record.ref, record.id)).resolves.toBe("private value");
    expect(store.describe().capabilities.degraded).toBe(false);
    fake.statuses.push(403);
    await expect(store.put("private value", secretTestContext)).rejects.toThrow(
      /^Secret storage is unavailable; retry later$/,
    );
    await store.close();
  });
  it.each([
    { name: "folder", options: { folder: "/missing" } },
    { name: "environment", options: { environment: "missing" } },
  ])("reports a missing $name as misconfiguration, not a missing secret", async ({ options }) => {
    const fake = infisicalFake();
    const writer = new InfisicalSecretStore(fake.options);
    const record = await writer.put("value", secretTestContext);
    await writer.close();
    const store = new InfisicalSecretStore({ ...fake.options, ...options });
    await store.start();
    expect(store.describe().capabilities.degraded).toBe(true);
    for (const attempt of [
      () => store.load(record.ref, record.id),
      () => store.put("value", secretTestContext),
      () => store.delete(record.ref, record.id),
    ])
      await expect(attempt()).rejects.toMatchObject({
        name: "SecretStoreUnavailableError",
        status: 404,
      });
    expect(store.describe().capabilities.degraded).toBe(true);
    await store.close();
  });
  it("starts healthy and reports a missing secret as not found", async () => {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    await store.start();
    expect(store.describe().capabilities.degraded).toBe(false);
    const record = await store.put("value", secretTestContext);
    fake.values.clear();
    store.invalidate(record.ref);
    await expect(store.load(record.ref, record.id)).rejects.toThrow("does not resolve");
    await expect(store.delete(record.ref, record.id)).resolves.toBeUndefined();
    expect(store.describe().capabilities.degraded).toBe(false);
    await store.close();
  });
  it.each([
    { retryAfter: undefined, sleeps: [100] },
    { retryAfter: "2", sleeps: [2000] },
    { retryAfter: new Date(Date.UTC(2026, 0, 1, 0, 0, 3)).toUTCString(), sleeps: [3000] },
    { retryAfter: "60", sleeps: [] },
  ])("waits for Retry-After $retryAfter within a bound", async ({ retryAfter, sleeps }) => {
    const fake = infisicalFake();
    fake.retryAfter = retryAfter;
    const store = new InfisicalSecretStore({ ...fake.options, now: () => Date.UTC(2026, 0, 1) });
    await store.start();
    fake.statuses.push(429);
    const put = store.put("value", secretTestContext);
    if (sleeps.length) await expect(put).resolves.toMatchObject({ ref: expect.any(String) });
    else await expect(put).rejects.toMatchObject({ status: 429 });
    expect(fake.sleep.mock.calls.map((call) => call[0])).toEqual(sleeps);
    await store.close();
  });
  it("fans out invalidation across stores", async () => {
    const fake = infisicalFake();
    const fanout = new InMemoryRealtimeFanout();
    const remote = new InfisicalSecretStore(fake.options);
    const a = new ComposedSecretStore(new EncryptedSecretStore("key"), remote, fanout);
    const b = new ComposedSecretStore(
      new EncryptedSecretStore("key"),
      new InfisicalSecretStore(fake.options),
      fanout,
    );
    await a.start();
    await b.start();
    const record = await a.put("value", secretTestContext);
    await b.load(record.ref, record.id);
    const listener = vi.fn();
    b.onChange(listener);
    await a.delete(record.ref, record.id);
    expect(listener).toHaveBeenCalledWith(record.ref);
    await expect(b.load(record.ref, record.id)).rejects.toThrow("does not resolve");
    await a.close();
    await b.close();
    await fanout.close();
  });
  it("emits once for realtime invalidation and establishes the new read baseline silently", async () => {
    const fake = infisicalFake();
    const fanout = new InMemoryRealtimeFanout();
    const store = new ComposedSecretStore(
      new EncryptedSecretStore("fake-key"),
      new InfisicalSecretStore(fake.options),
      fanout,
    );
    await store.start();
    try {
      const record = await store.put("initial", secretTestContext);
      const changed = vi.fn();
      store.onChange(changed);
      fake.values.set(record.ref.split(":").at(-1)!, "rotated");
      await fanout.publish(
        "secret-store-change",
        JSON.stringify({ origin: "another-process", ref: record.ref }),
      );
      expect(changed).toHaveBeenCalledExactlyOnceWith(record.ref);
      await expect(store.load(record.ref, record.id)).resolves.toBe("rotated");
      expect(changed).toHaveBeenCalledExactlyOnceWith(record.ref);
    } finally {
      await store.close();
      await fanout.close();
    }
  });
  it("propagates caller aborts to fetch", async () => {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore({ ...fake.options, timeoutMs: 10 });
    await store.start();
    const controller = new AbortController();
    fake.gate = () =>
      new Promise((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    const pending = store.put("value", { ...secretTestContext, signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow();
    await store.close();
  });
  it("does not read oversized secret responses", async () => {
    const fake = infisicalFake();
    const writer = new InfisicalSecretStore(fake.options);
    const missing = await writer.put("value", secretTestContext);
    await writer.close();
    fake.values.clear();
    const cancels: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fake.fetcher(input, init);
      if (String(input).includes("universal-auth/login")) return response;
      const oversized = new Response(response.body, {
        status: response.status,
        headers: { "content-length": String(1024 * 1024 * 1024) },
      });
      cancels.push(vi.spyOn(oversized.body!, "cancel"));
      return oversized;
    };
    const store = new InfisicalSecretStore({ ...fake.options, fetch: fetcher });
    try {
      await expect(store.put("private value", secretTestContext)).rejects.toThrow(
        /^Secret storage is unavailable; retry later$/,
      );
      // An unreadable not-found body is misconfiguration, not a missing secret.
      await expect(store.load(missing.ref, missing.id)).rejects.toMatchObject({
        name: "SecretStoreUnavailableError",
        status: 404,
      });
      expect(cancels).not.toHaveLength(0);
      for (const cancel of cancels) expect(cancel).toHaveBeenCalledOnce();
    } finally {
      await store.close();
    }
  });
  it("times out requests without exposing fetch errors", async () => {
    const fake = infisicalFake();
    const fetcher: typeof fetch = (input, init) => {
      if (String(input).includes("universal-auth/login")) return fake.fetcher(input, init);
      return new Promise((_resolve, reject) => {
        init?.signal?.throwIfAborted();
        init?.signal?.addEventListener("abort", () => reject(new Error("private timeout body")), {
          once: true,
        });
      });
    };
    const store = new InfisicalSecretStore({ ...fake.options, fetch: fetcher, timeoutMs: 5 });
    await store.start();
    try {
      await expect(store.put("private value", secretTestContext)).rejects.toBeInstanceOf(
        SecretStoreUnavailableError,
      );
    } finally {
      await store.close();
    }
  });
  it("backs off rate-limited login while sharing the login across concurrent requests", async () => {
    const fake = infisicalFake();
    fake.loginStatuses.push(429, 503, 200);
    const store = new InfisicalSecretStore(fake.options);
    await Promise.all([store.start(), store.start()]);
    expect(fake.logins).toBe(3);
    expect(fake.sleep.mock.calls.map((call) => call[0])).toEqual([1000, 200]);
    await store.close();
  });
  it("retries an invalidated read instead of installing its stale result", async () => {
    const fake = infisicalFake();
    const writer = new InfisicalSecretStore(fake.options);
    const record = await writer.put("before", secretTestContext);
    await writer.close();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let first = true;
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fake.fetcher(input, init);
      if (init?.method === "GET" && !String(input).includes("rakazo_start_check") && first) {
        first = false;
        started();
        await gate;
      }
      return response;
    };
    const store = new InfisicalSecretStore({ ...fake.options, fetch: fetcher });
    await store.start();
    try {
      const pending = store.load(record.ref, record.id);
      await reading;
      fake.values.set(record.ref.split(":").at(-1)!, "after");
      store.invalidate(record.ref);
      release();
      await expect(pending).resolves.toBe("after");
      await expect(store.load(record.ref, record.id)).resolves.toBe("after");
    } finally {
      release();
      await store.close();
    }
  });
  it("does not let a failed write or concurrent replacement modify a committed ref", async () => {
    const fake = infisicalFake();
    const store = new InfisicalSecretStore(fake.options);
    const reader = new InfisicalSecretStore(fake.options);
    await store.start();
    await reader.start();
    try {
      const old = await store.put("committed", secretTestContext, { recordId: "row" });
      const next = await Promise.all([
        store.put("a", secretTestContext, { recordId: "row" }),
        store.put("b", secretTestContext, { recordId: "row" }),
      ]);
      expect(new Set([old.ref, ...next.map((record) => record.ref)]).size).toBe(3);
      fake.statuses.push(403);
      await expect(store.put("failed", secretTestContext, { recordId: "row" })).rejects.toThrow();
      await expect(reader.load(old.ref, "row")).resolves.toBe("committed");
      await expect(reader.load(next[0]!.ref, "row")).resolves.toBe("a");
      await expect(reader.load(next[1]!.ref, "row")).resolves.toBe("b");
    } finally {
      await store.close();
      await reader.close();
    }
  });
  it("cancels one caller during shared login without cancelling other callers", async () => {
    const fake = infisicalFake();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loginStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    fake.gate = async () => {
      started();
      await gate;
    };
    const store = new InfisicalSecretStore(fake.options);
    const controller = new AbortController();
    const cancelled = store.put("cancelled", { ...secretTestContext, signal: controller.signal });
    const survived = store.put("survived", secretTestContext);
    await loginStarted;
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    fake.gate = undefined;
    release();
    try {
      const record = await survived;
      expect(fake.logins).toBe(1);
      await expect(store.load(record.ref, record.id)).resolves.toBe("survived");
    } finally {
      await store.close();
    }
  });
  it("reports malformed reads with a typed, redacted error and degraded status", async () => {
    const fake = infisicalFake();
    const writer = new InfisicalSecretStore(fake.options);
    const record = await writer.put("fake", secretTestContext);
    await writer.close();
    const fetcher: typeof fetch = async (input, init) => {
      const result = await fake.fetcher(input, init);
      return init?.method === "GET" ? Response.json(null) : result;
    };
    const store = new InfisicalSecretStore({ ...fake.options, fetch: fetcher });
    await store.start();
    try {
      await expect(store.load(record.ref, record.id)).rejects.toBeInstanceOf(
        SecretStoreUnavailableError,
      );
      expect(store.describe().capabilities.degraded).toBe(true);
    } finally {
      await store.close();
    }
  });
  it("cleans a key created before a cancelled POST response with a fresh signal", async () => {
    const fake = infisicalFake();
    const controller = new AbortController();
    let cleanupSignal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fake.fetcher(input, init);
      if (init?.method === "POST" && String(input).includes("/secrets/")) {
        controller.abort();
        throw controller.signal.reason;
      }
      if (init?.method === "DELETE") cleanupSignal = init.signal as AbortSignal;
      return response;
    };
    const store = new InfisicalSecretStore({ ...fake.options, fetch: fetcher });
    try {
      await expect(
        store.put("fake", { ...secretTestContext, signal: controller.signal }),
      ).rejects.toThrow();
      expect(fake.values.size).toBe(0);
      expect(cleanupSignal).toBeDefined();
      expect(cleanupSignal?.aborted).toBe(false);
    } finally {
      await store.close();
    }
  });
  it("shares overlapping reads so an older response cannot overwrite a newer read", async () => {
    const fake = infisicalFake();
    const writer = new InfisicalSecretStore(fake.options);
    const record = await writer.put("before", secretTestContext);
    await writer.close();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let gets = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fake.fetcher(input, init);
      if (init?.method === "GET" && !String(input).includes("rakazo_start_check") && ++gets === 1) {
        started();
        await gate;
      }
      return response;
    };
    const store = new InfisicalSecretStore({ ...fake.options, fetch: fetcher });
    await store.start();
    const changed = vi.fn();
    store.onChange(changed);
    try {
      const older = store.load(record.ref, record.id);
      await reading;
      fake.values.set(record.ref.split(":").at(-1)!, "after");
      store.invalidate(record.ref);
      changed.mockClear();
      const newer = store.load(record.ref, record.id);
      expect(gets).toBe(1);
      release();
      await expect(Promise.all([older, newer])).resolves.toEqual(["after", "after"]);
      await expect(store.load(record.ref, record.id)).resolves.toBe("after");
      expect(gets).toBe(2);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      release();
      await store.close();
    }
  });
  it.each(["http://localhost", "http://127.2.3.4", "http://[::1]", "https://secrets.example.test"])(
    "allows secure or loopback URL %s",
    (baseUrl) => {
      expect(
        secretStoreOptionsFromEnv({
          SECRET_STORE: "infisical",
          INFISICAL_URL: baseUrl,
          INFISICAL_CLIENT_ID: "fake",
          INFISICAL_CLIENT_SECRET: "fake",
          INFISICAL_PROJECT_ID: "fake",
          INFISICAL_ENVIRONMENT: "test",
          INFISICAL_FOLDER: "/",
        })?.baseUrl,
      ).toBe(baseUrl);
    },
  );
  it.each([
    "http://secrets.example.test",
    "http://infisical",
    "http://192.168.1.2",
    "http://localhost.example.test",
  ])("requires explicit insecure HTTP opt-in for %s", (baseUrl) => {
    const env = {
      SECRET_STORE: "infisical",
      INFISICAL_URL: baseUrl,
      INFISICAL_CLIENT_ID: "fake",
      INFISICAL_CLIENT_SECRET: "fake",
      INFISICAL_PROJECT_ID: "fake",
      INFISICAL_ENVIRONMENT: "test",
      INFISICAL_FOLDER: "/",
    };
    expect(() => secretStoreOptionsFromEnv(env)).toThrow("requires HTTPS");
    expect(
      secretStoreOptionsFromEnv({ ...env, INFISICAL_ALLOW_INSECURE_HTTP: "true" })?.baseUrl,
    ).toBe(baseUrl);
  });
  it("validates remote env only when selected", () => {
    expect(createSecretStore("key", { INFISICAL_URL: "bad" }).describe().id).toBe("app-encrypted");
    expect(() => secretStoreOptionsFromEnv({ SECRET_STORE: "infisical" })).toThrow(
      "Missing INFISICAL_URL",
    );
    expect(() => secretStoreOptionsFromEnv({ SECRET_STORE: "invalid" })).toThrow(
      "Unsupported SECRET_STORE",
    );
  });
});
