import type * as TimersPromises from "node:timers/promises";
import { FetchError, ResponseError } from "@boatdev/sdk";
import {
  SandboxProviderAccountError,
  SandboxRateLimitError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
} from "@rakazo/adapter-kit";
import { COMPUTER_PROVIDER_UNAVAILABLE_ERROR } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoatApiError, BoatRequestGate, boatResponseError, wrapBoatCall } from "./boat-errors.js";
import { BoatSandboxProvider } from "./boat-sandbox.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

// Waits run on the global timer, so a test on fake timers passes Boat's minute at once. An abort
// rejects the way Node's does, at any point in the wait.
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof TimersPromises>()),
  setTimeout: (ms?: number, value?: unknown, options?: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const signal = options?.signal;
      const abort = () => {
        clearTimeout(timer);
        const error = new Error("The operation was aborted", { cause: signal?.reason });
        reject(Object.assign(error, { name: "AbortError", code: "ABORT_ERR" }));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      }, ms);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    }),
}));

const ipLimit = (retryAfter: number) =>
  new ResponseError(Response.json({ code: "IP_RATE_LIMIT_EXCEEDED", retryAfter }, { status: 429 }));

/** Runs the fake clock until nothing waits, then returns what `pending` resolved or threw. */
async function settle(pending: Promise<unknown>): Promise<unknown> {
  const outcome = pending.catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  return outcome;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Boat API errors", () => {
  it("reports the upstream failure through the real SDK-backed file operation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "sandbox_direct_failed",
            message: "File is too large for read_file. Use artifact download instead.",
            requestId: "req_example",
          },
          { status: 400 },
        ),
      ),
    );
    const provider = new BoatSandboxProvider({ apiKey: "fake-boat-key" });
    await expect(
      provider.readFile(
        { id: "boat-test", providerRef: "boat-test", botId: "bot-test", kind: "boat" },
        "data.bin",
        {
          operationId: "test",
          traceId: "test",
          spaceId: "test",
          userId: "test",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow(
      "Boat API request failed (HTTP 400, sandbox_direct_failed): File is too large for read_file. Use artifact download instead. (request req_example)",
    );
  });

  it("reports a sandbox that no longer exists as gone, but not a missing file", async () => {
    const notFound = () =>
      Response.json({ code: "not_found", message: "not_found" }, { status: 404 });
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: "test",
      userId: "test",
      signal: new AbortController().signal,
    };
    const computer = { id: "gone", providerRef: "gone", botId: "bot-test", kind: "boat" as const };
    const provider = new BoatSandboxProvider({ apiKey: "fake-boat-key" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => notFound()),
    );
    const gone = await provider.keepAlive(computer).catch((error: unknown) => error);
    expect(isSandboxGoneError(gone)).toBe(true);
    expect((gone as Error).name).toBe("SandboxNotFoundError");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        new URL(String(input)).pathname.endsWith("/sandboxes/gone")
          ? Response.json({ ok: true, type: "sandbox.info", sandbox: { id: "gone" } })
          : notFound(),
      ),
    );
    const missingFile = await provider
      .readFile(computer, "missing.txt", context)
      .catch((error: unknown) => error);
    expect(isSandboxGoneError(missingFile)).toBe(false);

    const cancel = new AbortController();
    const lookups: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (!new URL(String(input)).pathname.endsWith("/sandboxes/gone")) return notFound();
        lookups.push(init?.signal);
        cancel.abort(new Error("cancelled"));
        throw init?.signal?.reason;
      }),
    );
    await expect(
      provider.readFile(computer, "missing.txt", { ...context, signal: cancel.signal }),
    ).rejects.toThrow();
    expect(lookups[0]?.aborted).toBe(true);
  });

  it("keeps the HTTP status and Boat's error code and does not retry failed commands", async () => {
    const call = vi.fn(async () => {
      throw new ResponseError(
        Response.json({ code: "not_found", message: "Boat not found" }, { status: 404 }),
      );
    });
    const error = await wrapBoatCall(call, "fake-key")().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(BoatApiError);
    expect(error).toMatchObject({ code: "not_found", response: { status: 404 } });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("reports a stop refused while the sandbox is updating as a passing condition", async () => {
    const call = vi.fn(async () => {
      throw new ResponseError(
        Response.json(
          { code: "stop_failed", message: "Sandbox is updating, so it cannot be stopped." },
          { status: 400 },
        ),
      );
    });
    const error = await wrapBoatCall(call, "fake-key")().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SandboxUnresponsiveError);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("reports a resume refused for lack of capacity as a computer that did not start", async () => {
    const call = vi.fn(async () => {
      throw new ResponseError(
        Response.json(
          {
            code: "resume_failed",
            message: "Server is currently at capacity. Please try again in a few minutes.",
          },
          { status: 409 },
        ),
      );
    });
    const error = await wrapBoatCall(call, "fake-key")().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SandboxUnavailableError);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("reports a rate limit as a provider-neutral error that keeps the upstream detail", async () => {
    const call = wrapBoatCall(async () => {
      throw new ResponseError(
        Response.json(
          { code: "rate_limited", message: "Rate limit hit: 200 sandbox starts per day" },
          { status: 429 },
        ),
      );
    }, "fake-key");
    const error = await call().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SandboxRateLimitError);
    expect((error as Error).cause).toBeInstanceOf(BoatApiError);
    expect(((error as Error).cause as Error).message).toContain("HTTP 429, rate_limited");
  });

  it.each([
    ["the per-IP limit's body", { code: "IP_RATE_LIMIT_EXCEEDED", retryAfter: 12 }, {}, 12_000],
    ["the Retry-After header", { code: "IP_RATE_LIMIT_EXCEEDED" }, { "Retry-After": "7" }, 7_000],
    ["a start limit over the last minute", { code: "rate_limited", window: "minute" }, {}, 60_000],
    ["a start limit over the last day", { code: "rate_limited", window: "day" }, {}, undefined],
  ])("carries the wait named by %s", async (_name, body, headers, retryAfterMs) => {
    const call = wrapBoatCall(async () => {
      throw new ResponseError(Response.json(body, { status: 429, headers }));
    }, "fake-key");
    const error = await call().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SandboxRateLimitError);
    expect((error as SandboxRateLimitError).retryAfterMs).toBe(retryAfterMs);
  });

  it.each([
    ["the per-IP limit", { code: "IP_RATE_LIMIT_EXCEEDED", retryAfter: 12 }, [0, 12_500]],
    ["a start limit over the minute", { code: "rate_limited", window: "minute" }, [0, 60_500]],
    ["a per-IP limit past the minute", { code: "IP_RATE_LIMIT_EXCEEDED", retryAfter: 90 }, [0]],
    ["a start limit over an hour", { code: "rate_limited", window: "hour", retryAfter: 30 }, [0]],
    ["the account's quota", { code: "limit_reached", retryAfter: 30 }, [0]],
  ])(
    "sends a request refused by %s again only when Boat's wait ends within the minute",
    async (_name, body, sent) => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      const start = Date.now();
      const sentAt: number[] = [];
      const call = wrapBoatCall(
        async (_request: unknown, _init: RequestInit) => {
          sentAt.push(Date.now() - start);
          throw new ResponseError(Response.json(body, { status: 429 }));
        },
        "fake-key",
        true,
      );
      const refused = await settle(call({}, { signal: new AbortController().signal }));
      expect(refused).toBeInstanceOf(SandboxRateLimitError);
      expect(sentAt).toEqual(sent);
    },
  );

  const hang = (_request: unknown, init?: RequestInit) =>
    new Promise<never>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason));
    });

  it("reports a call Boat does not answer within its time limit as unresponsive", async () => {
    const call = wrapBoatCall(hang, "fake-key", true, undefined, 20);
    const error = await call({}, { signal: new AbortController().signal }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(SandboxUnresponsiveError);
    expect((error as Error).message).toBe("Boat did not answer in time");
  });

  it("keeps a cancelled call cancelled when it also has a time limit", async () => {
    const controller = new AbortController();
    const call = wrapBoatCall(hang, "fake-key", true, undefined, 60_000);
    const pending = call({}, { signal: controller.signal }).catch((failure: unknown) => failure);
    controller.abort(new Error("cancelled"));
    const error = await pending;
    expect(error).not.toBeInstanceOf(SandboxUnresponsiveError);
    expect((error as Error).message).toBe("cancelled");
  });

  it("does not resend a call whose caller gave no signal to bound the wait", async () => {
    const call = vi.fn(async () => {
      throw ipLimit(12);
    });
    await expect(wrapBoatCall(call, "fake-key", true)()).rejects.toBeInstanceOf(
      SandboxRateLimitError,
    );
    expect(call).toHaveBeenCalledOnce();
  });

  it("holds a second caller at the gate while the first waits to resend, then sends both", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValueOnce(0.25).mockReturnValueOnce(0.75);
    const start = Date.now();
    const sent: string[] = [];
    const call = wrapBoatCall(
      async (request: string, _init: RequestInit) => {
        sent.push(`${request} at ${Date.now() - start}`);
        if (sent.length === 1) throw ipLimit(12);
        return request;
      },
      "fake-key",
      true,
      new BoatRequestGate(),
    );
    const { signal } = new AbortController();
    const first = call("first", { signal });
    await vi.advanceTimersByTimeAsync(1_000);
    const second = call("second", { signal });
    await vi.runAllTimersAsync();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(sent).toEqual(["first at 0", "first at 12250", "second at 12750"]);
  });

  it.each([
    ["waits out Boat's wait", 0, 10_000, 1],
    ["waits at a gate another refusal closed for longer", 50_000, 30_000, 1],
    ["waits for the resent request", 0, 20_000, 2],
  ])(
    "keeps Boat's refusal when the caller cancels while it %s",
    async (_name, closeMs, abortAtMs, sends) => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const refusal = await boatResponseError(ipLimit(12).response, "fake-key");
      const gate = new BoatRequestGate();
      const controller = new AbortController();
      const call = vi.fn(async (_request: unknown, init: RequestInit) => {
        if (call.mock.calls.length === 1) throw refusal;
        // The resent request stays in flight until the caller's signal ends it, as fetch does.
        return new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const aborted = new DOMException("This operation was aborted", "AbortError");
            reject(new FetchError(aborted, "The request failed"));
          });
        });
      });
      const wrapped = wrapBoatCall(call, "fake-key", true, gate);
      const outcome = wrapped({}, { signal: controller.signal }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      gate.close(closeMs);
      await vi.advanceTimersByTimeAsync(abortAtMs);
      controller.abort();
      const error = await outcome;
      expect(error).toBeInstanceOf(SandboxRateLimitError);
      expect((error as SandboxRateLimitError).cause).toBe(refusal);
      expect((error as SandboxRateLimitError).retryAfterMs).toBe(12_000);
      expect(call).toHaveBeenCalledTimes(sends);
    },
  );

  it.each([
    [
      "Boat refuses it again",
      () => ipLimit(20),
      (error: unknown) => (error as SandboxRateLimitError).retryAfterMs === 20_000,
    ],
    [
      "the sandbox is gone",
      () => new ResponseError(Response.json({ code: "not_found" }, { status: 404 })),
      (error: unknown) => error instanceof BoatApiError && error.response.status === 404,
    ],
  ])("reports the resent request's own failure when %s", async (_name, second, matches) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const call = vi.fn(async (_request: unknown, _init: RequestInit) => {
      throw call.mock.calls.length === 1 ? ipLimit(12) : second();
    });
    const wrapped = wrapBoatCall(call, "fake-key", true, new BoatRequestGate());
    const error = await settle(wrapped({}, { signal: new AbortController().signal }));
    expect(matches(error)).toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("stops waiting to retry an unsent request once the caller cancels", async () => {
    const controller = new AbortController();
    const call = vi.fn(async (_request: unknown, _init: RequestInit) => {
      controller.abort();
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
      });
    });
    const wrapped = wrapBoatCall(call, "fake-key", true);
    await expect(wrapped({}, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(call).toHaveBeenCalledOnce();
  });

  it("reports a lost connection as unresponsive without resending the call", async () => {
    const lost = new FetchError(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
      }),
      "The request failed and the interceptors did not return an alternative response",
    );
    const call = vi.fn(async () => {
      throw lost;
    });
    const error = await wrapBoatCall(call, "fake-key")().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SandboxUnresponsiveError);
    expect((error as Error).cause).toBe(lost);
    expect(call).toHaveBeenCalledOnce();
  });

  it("reports a Boat server error or unpaid account as unresponsive", async () => {
    const failing = (status: number, code: string) =>
      wrapBoatCall(async () => {
        throw new ResponseError(Response.json({ code, message: "upstream" }, { status }));
      }, "fake-key");

    const outage = await failing(500, "internal")().catch((failure: unknown) => failure);
    expect(outage).toBeInstanceOf(SandboxUnresponsiveError);
    expect((outage as Error).message).toContain("HTTP 500, internal");
    expect((outage as Error).cause).toMatchObject({ response: { status: 500 } });

    const edge = await failing(525, "ssl_handshake_failed")().catch((failure: unknown) => failure);
    expect(edge).toBeInstanceOf(SandboxUnresponsiveError);
    expect((edge as Error).cause).toMatchObject({ response: { status: 525 } });

    const billing = await failing(402, "billing_required")().catch((failure: unknown) => failure);
    expect(billing).toBeInstanceOf(SandboxProviderAccountError);
    expect(billing).toBeInstanceOf(SandboxUnresponsiveError);
    expect((billing as Error).message).toBe(COMPUTER_PROVIDER_UNAVAILABLE_ERROR);
    expect((billing as Error).cause).toMatchObject({ code: "billing_required" });

    const forbidden = await failing(403, "api_key_action_forbidden")().catch(
      (failure: unknown) => failure,
    );
    expect(forbidden).toBeInstanceOf(BoatApiError);
  });

  it("retries once when the connection drops during the TLS handshake", async () => {
    const call = vi
      .fn(async () => "answered")
      .mockRejectedValueOnce(
        new FetchError(
          new TypeError("fetch failed", {
            cause: Object.assign(
              new Error(
                "Client network socket disconnected before secure TLS connection was established",
              ),
              { code: "ECONNRESET" },
            ),
          }),
          "The request failed and the interceptors did not return an alternative response",
        ),
      );
    await expect(wrapBoatCall(call, "fake-key")()).resolves.toBe("answered");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("keeps a cancelled request's error as it is", async () => {
    const cancelled = new FetchError(
      new DOMException("This operation was aborted", "AbortError"),
      "The request failed and the interceptors did not return an alternative response",
    );
    const call = wrapBoatCall(async () => {
      throw cancelled;
    }, "fake-key");
    await expect(call()).rejects.toBe(cancelled);
  });

  it("redacts credentials and signed URLs while retaining the useful diagnosis", async () => {
    const error = await boatResponseError(
      Response.json(
        {
          code: "unauthorized",
          message:
            "Rejected fake-boat-key; Bearer other-credential; see https://boat.example/desktop?token=private-value",
        },
        { status: 401 },
      ),
      "fake-boat-key",
    );
    expect(error.message).toContain("HTTP 401, unauthorized");
    for (const secret of ["fake-boat-key", "other-credential", "private-value"]) {
      expect(error.message).not.toContain(secret);
    }
  });

  it.each(["upstream HTML", "null", "[]", '{"message":42}'])(
    "uses an HTTP fallback for malformed or unstructured errors: %s",
    async (body) => {
      const error = await boatResponseError(new Response(body, { status: 502 }), "fake-key");
      expect(error.message).toBe("Boat API request failed (HTTP 502)");
    },
  );

  it("caps upstream detail and stops reading oversized error bodies", async () => {
    const error = await boatResponseError(
      Response.json({ message: "x".repeat(1_000) }, { status: 400 }),
      "fake-key",
    );
    expect(error.message.length).toBeLessThan(600);

    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(20_000));
        },
        cancel,
      }),
      { status: 503 },
    );
    expect((await boatResponseError(response, "fake-key")).message).toBe(
      "Boat API request failed (HTTP 503)",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("falls back to the HTTP status when an error body stalls", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream({
        pull: () => new Promise<void>(() => undefined),
        cancel,
      }),
      { status: 504 },
    );

    const pending = boatResponseError(response, "fake-key", controller.signal);
    controller.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(pending).resolves.toMatchObject({
      message: "Boat API request failed (HTTP 504)",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
