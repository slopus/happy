import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  captureReactException: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("@sentry/react", () => sentry);
const recovery = vi.hoisted(() => ({ reloading: false }));
vi.mock("./preload-recovery", async (load) => ({
  ...(await load<Record<string, unknown>>()),
  recoveringByReload: () => recovery.reloading,
}));

import { reportCaughtReactError, startMonitoring } from "./monitoring";

function respond(body: unknown, status = 200) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("browser monitoring", () => {
  it("reports errors caught before startup finishes once the SDK starts", async () => {
    vi.resetModules();
    const fresh = await import("./monitoring");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const early = new Error("first render");
    fresh.reportCaughtReactError(early, { componentStack: "\n    at App" });
    expect(sentry.captureReactException).not.toHaveBeenCalled();

    expect(await fresh.startMonitoring(respond({ dsn: "https://key@errors.example.com/8" }))).toBe(
      true,
    );
    expect(sentry.captureReactException).toHaveBeenCalledWith(early, {
      componentStack: "\n    at App",
    });
    consoleError.mockRestore();
  });

  it("reports early errors that carry an error, not bare error events", async () => {
    vi.resetModules();
    const fresh = await import("./monitoring");
    sentry.captureException.mockClear();
    const target = new EventTarget();
    fresh.installEarlyErrorReporting(target as unknown as Window);
    const thrown = new Error("module evaluation failed");
    target.dispatchEvent(Object.assign(new Event("error"), { error: null }));
    target.dispatchEvent(Object.assign(new Event("error"), { error: thrown }));

    await fresh.startMonitoring(respond({ dsn: "https://key@errors.example.com/8" }));
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(thrown, expect.any(Object));
  });

  it("does not report failures the recovery reload is about to replace", async () => {
    vi.resetModules();
    const fresh = await import("./monitoring");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    sentry.init.mockClear();
    sentry.captureReactException.mockClear();
    expect(await fresh.startMonitoring(respond({ dsn: "https://key@errors.example.com/8" }))).toBe(
      true,
    );
    const { beforeSend } = sentry.init.mock.calls[0]![0];
    recovery.reloading = true;
    fresh.reportCaughtReactError(new TypeError("Failed to fetch dynamically imported module"), {
      componentStack: "",
    });
    expect(sentry.captureReactException).not.toHaveBeenCalled();
    expect(beforeSend({ message: "stale chunk" })).toBeNull();
    recovery.reloading = false;
    expect(beforeSend({})).toEqual({ user: { ip_address: null } });
    consoleError.mockRestore();
  });

  it("drops queued errors when monitoring is off", async () => {
    vi.resetModules();
    const fresh = await import("./monitoring");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fresh.reportCaughtReactError(new Error("early"), { componentStack: "" });
    expect(await fresh.startMonitoring(respond({ dsn: null }))).toBe(false);
    expect(await fresh.startMonitoring(respond({ dsn: "https://key@errors.example.com/8" }))).toBe(
      true,
    );
    expect(sentry.captureReactException).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("tags reports with the server-minted pseudonym and clears it on sign-out", async () => {
    vi.resetModules();
    sentry.init.mockReset();
    const fresh = await import("./monitoring");
    const PSEUDONYM = "a".repeat(64);
    expect(await fresh.startMonitoring(respond({ dsn: "https://key@errors.example.com/8" }))).toBe(
      true,
    );
    const beforeSend = sentry.init.mock.calls[0]![0].beforeSend;
    const signedInConfig = respond({ dsn: "https://key@errors.example.com/8", userId: PSEUDONYM });

    await fresh.identifyMonitoringUser(true, signedInConfig);
    expect(signedInConfig).toHaveBeenCalledWith("/api/monitoring/config");
    expect(beforeSend({ user: { id: "raw-user", email: "ada@example.com" } })).toEqual({
      user: { id: PSEUDONYM, ip_address: null },
    });

    await fresh.identifyMonitoringUser(false);
    expect(beforeSend({})).toEqual({ user: { ip_address: null } });

    // A malformed id is never sent, and a sign-out that lands first wins over a slow sign-in.
    await fresh.identifyMonitoringUser(true, respond({ dsn: "x", userId: "raw-user" }));
    expect(beforeSend({})).toEqual({ user: { ip_address: null } });
    let release!: () => void;
    const slow = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response(JSON.stringify({ userId: PSEUDONYM }));
    }) as unknown as typeof fetch;
    const signingIn = fresh.identifyMonitoringUser(true, slow);
    await fresh.identifyMonitoringUser(false);
    release();
    await signingIn;
    expect(beforeSend({})).toEqual({ user: { ip_address: null } });
  });

  it("uses the startup pseudonym for errors queued before the session resolves", async () => {
    vi.resetModules();
    sentry.init.mockReset();
    const fresh = await import("./monitoring");
    const PSEUDONYM = "b".repeat(64);
    await fresh.startMonitoring(
      respond({ dsn: "https://key@errors.example.com/8", userId: PSEUDONYM }),
    );
    const beforeSend = sentry.init.mock.calls[0]![0].beforeSend;
    expect(beforeSend({})).toEqual({ user: { id: PSEUDONYM, ip_address: null } });

    // A sign-out that resolved before startup finished is not overridden.
    vi.resetModules();
    sentry.init.mockReset();
    const signedOut = await import("./monitoring");
    await signedOut.identifyMonitoringUser(false);
    await signedOut.startMonitoring(
      respond({ dsn: "https://key@errors.example.com/8", userId: PSEUDONYM }),
    );
    expect(sentry.init.mock.calls[0]![0].beforeSend({})).toEqual({ user: { ip_address: null } });
  });

  it("does not ask for a pseudonym when monitoring is off", async () => {
    vi.resetModules();
    const fresh = await import("./monitoring");
    await fresh.startMonitoring(respond({ dsn: null }));
    const fetchImpl = respond({ dsn: null });
    await fresh.identifyMonitoringUser(true, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    sentry.init.mockReset();
    sentry.captureReactException.mockReset();
  });

  it("stays off when the API has no browser DSN or cannot be reached", async () => {
    expect(await startMonitoring(respond({ dsn: null }))).toBe(false);
    expect(await startMonitoring(respond({}, 404))).toBe(false);
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await startMonitoring(offline)).toBe(false);
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("stays off in a desktop build that does not report errors", async () => {
    vi.resetModules();
    const fresh = await import("./monitoring");
    vi.stubGlobal("window", { rakazoDesktop: { monitoring: { enabled: async () => false } } });
    try {
      expect(
        await fresh.startMonitoring(respond({ dsn: "https://key@errors.example.com/8" })),
      ).toBe(false);
      expect(sentry.init).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stays off when the SDK fails to start", async () => {
    sentry.init.mockImplementation(() => {
      throw new Error("init failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await startMonitoring(respond({ dsn: "https://key@errors.example.com/8" }))).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("starts the SDK through the API tunnel with data collection off", async () => {
    const fetchImpl = respond({
      dsn: "https://key@errors.example.com/8",
      environment: "prod-acme",
      release: "abc",
      tunnel: "/api/monitoring/tunnel",
    });
    expect(await startMonitoring(fetchImpl)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("/api/monitoring/config");
    const options = sentry.init.mock.calls[0]![0];
    expect(options).toMatchObject({
      dsn: "https://key@errors.example.com/8",
      environment: "prod-acme",
      release: "abc",
      tunnel: "/api/monitoring/tunnel",
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false },
    });
    expect(options.integrations([{ name: "BrowserSession" }, { name: "GlobalHandlers" }])).toEqual([
      { name: "GlobalHandlers" },
    ]);
    expect(options.maxBreadcrumbs).toBe(0);
    expect(options.integrations([{ name: "Breadcrumbs" }])).toEqual([]);
    expect(
      options.beforeSend({
        request: {
          url: "https://example.com/path?token=secret#private",
          headers: { authorization: "secret" },
          cookies: "secret",
          data: "private body",
        },
        user: { email: "private@example.com" },
      }),
    ).toEqual({ request: { url: "https://example.com/path" }, user: { ip_address: null } });
    expect(options.beforeSend({})).toEqual({ user: { ip_address: null } });
    expect(
      options.beforeSend({
        message: "Failed for someone@example.com",
        exception: { values: [{ value: "401 Bearer abc.def from someone@example.com" }] },
      }),
    ).toEqual({
      message: "Failed for [Redacted]",
      exception: { values: [{ value: "401 Bearer [Redacted] from [Redacted]" }] },
      user: { ip_address: null },
    });
    expect(
      options.beforeSend({
        exception: {
          values: [
            { stacktrace: { frames: [{ filename: "https://app.example.com/a.js?token=x#y" }] } },
          ],
        },
      }),
    ).toEqual({
      exception: {
        values: [{ stacktrace: { frames: [{ filename: "https://app.example.com/a.js" }] } }],
      },
      user: { ip_address: null },
    });
    expect(options.tracesSampleRate).toBeUndefined();
    expect(options.profilesSampleRate).toBeUndefined();
    expect(options.replaysSessionSampleRate).toBeUndefined();
    expect(options.replaysOnErrorSampleRate).toBeUndefined();

    const error = new Error("boom");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    reportCaughtReactError(error, { componentStack: "\n    at Thread" });
    expect(sentry.captureReactException).toHaveBeenCalledWith(error, {
      componentStack: "\n    at Thread",
    });
    expect(consoleError).toHaveBeenCalledWith(error);
    consoleError.mockRestore();
  });

  it("keeps connection failures out of error reports but reports real failures", async () => {
    vi.resetModules();
    sentry.captureException.mockReset();
    const fresh = await import("./monitoring");
    await fresh.startMonitoring(respond({ dsn: "https://key@errors.example.com/8" }));
    for (const message of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
    ])
      fresh.reportClientError(new TypeError(message), "rpc.transport");
    fresh.reportClientError(new DOMException("signal timed out", "TimeoutError"), "rpc.transport");
    expect(sentry.captureException).not.toHaveBeenCalled();

    // A request the browser refused to build is a bug, and other operations keep their reports.
    const invalid = new TypeError("Failed to execute 'fetch' on 'Window': Invalid name");
    fresh.reportClientError(invalid, "rpc.transport");
    const chunk = new TypeError("Failed to fetch dynamically imported module: /assets/a.js");
    fresh.reportClientError(chunk, "react.render");
    expect(sentry.captureException.mock.calls.map(([error]) => error)).toEqual([invalid, chunk]);

    const { beforeSend } = sentry.init.mock.calls.at(-1)![0];
    const timeout = new DOMException("signal timed out", "TimeoutError");
    expect(beforeSend({}, { originalException: timeout })).toBeNull();
    expect(
      beforeSend({}, { originalException: new DOMException("aborted", "AbortError") }),
    ).toBeNull();
    expect(beforeSend({}, { originalException: new Error("boom") })).toEqual({
      user: { ip_address: null },
    });
  });

  it("drops gateway answers during a deploy, chunks that did not load, and failures from code that is not the app's", async () => {
    vi.resetModules();
    const fresh = await import("./monitoring");
    await fresh.startMonitoring(respond({ dsn: "https://key@errors.example.com/8" }));
    const { beforeSend } = sentry.init.mock.calls.at(-1)![0];
    for (const originalException of [
      Object.assign(new Error("Bad Gateway"), { status: 502 }),
      { code: 4001, message: "User rejected the request." },
      new TypeError("undefined is not an object (evaluating 'window.__firefox__.reader')"),
      new TypeError("undefined is not an object (evaluating 'window.ethereum.selectedAddress')"),
      new DOMException(
        "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
        "NotFoundError",
      ),
      "Object Not Found Matching Id:1, MethodName:update, ParamCount:4",
      new TypeError("Importing a module script failed."),
      new TypeError(
        "Failed to fetch dynamically imported module: https://app.example.com/assets/Settings-abc123.js",
      ),
      new TypeError("error loading dynamically imported module: https://app.example.com/a.js"),
    ])
      expect(beforeSend({}, { originalException }), String(originalException)).toBeNull();
    expect(
      beforeSend({}, { originalException: Object.assign(new Error("Conflict"), { status: 409 }) }),
    ).toEqual({ user: { ip_address: null } });
    expect(beforeSend({ message: "plain" }, { originalException: "plain" })).toEqual({
      message: "plain",
      user: { ip_address: null },
    });
  });
});
